import {Cause, Clock, Console, DateTime, Effect, Exit, FileSystem, Option, Path} from 'effect';
import type {AgentAdapter} from '../agent_integration/adapters/contract.js';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {resolveRepoRoot} from '../seeding.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {errorMessage} from '@threadnote/platform/errors';
import {readFileIfExists} from '../utils.js';
import {recordSetupCompletionValueEvent, recordSetupLifecycleValueEvent} from '../value_report/events.js';
import {
  SETUP_MAX_DURATION_MILLISECONDS,
  SETUP_RECEIPT_VERSION,
  SetupOperationError,
  parseSetupReceiptV1,
  setupRecovery,
  type SetupPlanOperationV1,
  type SetupPlanV1,
  type SetupReceiptOperationV1,
  type SetupReceiptV1,
  type SetupReceiptVerificationV1,
} from './contract.js';
import {createSetupPlan, renderSetupPlan} from './planner.js';
import {withSetupMutationLock} from './lock.js';
import {productionSetupDependencies, resolveSetupRuntimeConfig, setupRepositorySourceHash} from './runtime.js';
import {isPersonalThreadnoteHome} from '../mcp/install.js';

export {SetupOperationError} from './contract.js';

const SETUP_VERIFICATION_TASK =
  'Orient this agent to the current repository architecture, durable decisions, active handoffs, and next safe step.';

export interface RunSetupOptions {
  readonly apply?: boolean;
  readonly cwd?: string;
  readonly scope?: 'user' | 'project' | 'local';
  readonly undo?: boolean;
}

export type SetupScopeResolution = {readonly scope: RunSetupOptions['scope']} | {readonly error: SetupOperationError};

/** @internal Pure scope normalization shared by setup and its contract tests. */
export function resolveSetupScope(
  adapter: AgentAdapter,
  requestedScope: RunSetupOptions['scope'],
): SetupScopeResolution {
  if (adapter.kind === 'json') {
    return {scope: requestedScope ?? adapter.json?.defaultScope ?? 'user'};
  }
  if (requestedScope === undefined || (requestedScope === 'user' && adapter.catalog.scopes.includes('user'))) {
    return {scope: undefined};
  }
  return {
    error: SetupOperationError.make({
      message: 'Compatibility surfaces support only the user-scope setup lifecycle; omit --scope or pass --scope user.',
    }),
  };
}

export interface SetupOperationOutcome {
  readonly afterHash?: string;
  readonly beforeHash?: string;
  readonly finalOutput?: string;
  readonly ownership?: 'setup-created' | 'preexisting';
  readonly status: 'applied' | 'already-current' | 'verified';
  readonly subsystemReceiptRef?: string;
  readonly supportedAgentReuse?: boolean;
  readonly verification?: SetupReceiptVerificationV1;
}

export interface SetupOrchestratorDependencies<R> {
  readonly contextBrief: (
    config: RuntimeConfig,
    projectRoot: string,
    task: string,
  ) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly doctor: (config: RuntimeConfig) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly ensureCore: (config: RuntimeConfig, apply: boolean) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly ensureHooks: (
    config: RuntimeConfig,
    adapter: AgentAdapter,
    apply: boolean,
  ) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly ensureManifest: (
    config: RuntimeConfig,
    projectRoot: string,
    apply: boolean,
  ) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly ensureSurface: (
    config: RuntimeConfig,
    adapter: AgentAdapter,
    projectRoot: string,
    apply: boolean,
    scope?: 'user' | 'project' | 'local',
  ) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly indexGraph: (
    config: RuntimeConfig,
    projectRoot: string,
    apply: boolean,
  ) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly inspectReversible: (
    config: RuntimeConfig,
    adapter: AgentAdapter,
    projectRoot: string,
    kind: SetupPlanOperationV1['kind'],
    scope?: 'user' | 'project' | 'local',
  ) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly removeSurface: (
    config: RuntimeConfig,
    adapter: AgentAdapter,
    projectRoot: string,
    scope?: 'user' | 'project' | 'local',
  ) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly removeHooks: (
    config: RuntimeConfig,
    adapter: AgentAdapter,
    operation: SetupReceiptOperationV1,
  ) => Effect.Effect<SetupOperationOutcome, unknown, R>;
  readonly seedProject: (
    config: RuntimeConfig,
    projectRoot: string,
    apply: boolean,
  ) => Effect.Effect<SetupOperationOutcome, unknown, R>;
}

export const runSetup = Effect.fn('setup.run')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: RunSetupOptions,
) {
  return yield* runSetupWith(yield* resolveSetupRuntimeConfig(config), adapter, options, productionSetupDependencies);
});

export const runSetupWith = Effect.fn('setup.runWith')(function* <R>(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: RunSetupOptions,
  dependencies: SetupOrchestratorDependencies<R>,
) {
  if (adapter.kind === 'catalog') {
    return yield* SetupOperationError.make({
      message: `${adapter.catalog.displayName} is catalog-only; run threadnote agents list for its manual setup guidance.`,
    });
  }
  const scopeResolution = resolveSetupScope(adapter, options.scope);
  if ('error' in scopeResolution) return yield* scopeResolution.error;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (
    adapter.legacyClient === 'omp' &&
    options.undo !== true &&
    !isPersonalThreadnoteHome(config.agentContextHome, system.homeDirectory, (...parts) => path.resolve(...parts))
  ) {
    return yield* SetupOperationError.make({
      message:
        'OMP user-scope setup cannot target an isolated THREADNOTE_HOME. ' +
        'Use threadnote mcp-install omp --project <path> --home <home> --apply for project configuration, ' +
        'or run setup with the personal ~/.threadnote home.',
    });
  }
  const projectRoot = yield* resolveRepoRoot(options.cwd ?? system.currentDirectory());
  const scope = scopeResolution.scope;
  if (options.undo === true)
    return yield* runSetupUndo(config, adapter, projectRoot, scope, options.apply === true, dependencies);
  const threadnoteVersion = yield* getThreadnoteVersion();
  const plan = yield* createSetupPlan({
    adapter,
    manifestPath: config.manifestPath,
    projectRoot,
    scope,
    task: SETUP_VERIFICATION_TASK,
    threadnoteVersion,
  });
  yield* Console.log(renderSetupPlan(plan, adapter.catalog.displayName));
  if (options.apply !== true) {
    yield* previewSetup(config, adapter, plan, dependencies);
    yield* Console.log('\nPreview complete. Re-run with --apply to execute this plan.');
    return undefined;
  }

  const receiptId = yield* setupReceiptIdFor(plan.projectRoot, plan.scope, plan.surfaceId);
  const receiptPath = setupReceiptPath(path, config.agentContextHome, plan.surfaceId, receiptId);
  return yield* withSetupMutationLock(
    config.agentContextHome,
    applySetupPlan(config, adapter, plan, receiptId, receiptPath, dependencies),
  );
});

const runSetupUndo = Effect.fn('setup.undo')(function* <R>(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  projectRoot: string,
  scope: RunSetupOptions['scope'],
  apply: boolean,
  dependencies: SetupOrchestratorDependencies<R>,
) {
  const path = yield* Path.Path;
  const receiptId = yield* setupReceiptIdFor(projectRoot, scope, adapter.catalog.id);
  const receiptPath = setupReceiptPath(path, config.agentContextHome, adapter.catalog.id, receiptId);
  const read = yield* readSetupReceipt(receiptPath);
  if (read === undefined)
    return yield* SetupOperationError.make({message: `No setup receipt exists for ${adapter.catalog.displayName}.`});
  const targetError = validateUndoTarget(read.receipt, adapter, scope, receiptId);
  if (targetError !== undefined) return yield* targetError;
  const undoIds = read.receipt.recovery.undoOperationIds;
  const needsFinalization = read.receipt.status === 'rolling-back';
  yield* Console.log(`Threadnote setup undo plan for ${adapter.catalog.displayName}`);
  yield* Console.log(`Receipt: ${receiptPath}`);
  for (const [index, id] of undoIds.entries()) yield* Console.log(`${index + 1}. undo ${id}`);
  if (undoIds.length === 0 && !needsFinalization) {
    yield* Console.log('Nothing setup-created remains eligible for rollback.');
    return read.receipt;
  }
  if (undoIds.length === 0) yield* Console.log('1. finalize rollback receipt');
  if (!apply) {
    yield* Console.log('\nUndo preview complete. Re-run with --undo --apply to execute this rollback.');
    return read.receipt;
  }
  return yield* withSetupMutationLock(
    config.agentContextHome,
    applySetupUndo(config, adapter, projectRoot, scope, receiptId, receiptPath, dependencies),
  );
});

const applySetupUndo = Effect.fn('setup.applyUndo')(function* <R>(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  projectRoot: string,
  scope: RunSetupOptions['scope'],
  receiptId: string,
  receiptPath: string,
  dependencies: SetupOrchestratorDependencies<R>,
) {
  const read = yield* readSetupReceipt(receiptPath);
  if (read === undefined)
    return yield* SetupOperationError.make({message: 'The setup receipt disappeared before undo.'});
  const targetError = validateUndoTarget(read.receipt, adapter, scope, receiptId);
  if (targetError !== undefined) return yield* targetError;
  if (read.receipt.recovery.undoOperationIds.length === 0 && read.receipt.status !== 'rolling-back') {
    yield* Console.log('Nothing setup-created remains eligible for rollback.');
    return read.receipt;
  }
  let receipt =
    read.receipt.status === 'rolling-back'
      ? read.receipt
      : parseSetupReceiptV1({
          ...read.receipt,
          status: 'rolling-back',
          updatedAt: yield* nowIso(),
        });
  if (read.receipt.status !== 'rolling-back') yield* writeSetupReceipt(receiptPath, receipt);
  for (const operationId of [...receipt.recovery.undoOperationIds]) {
    const operation = receipt.operations.find(candidate => candidate.id === operationId);
    if (operation === undefined)
      return yield* SetupOperationError.make({message: `Undo operation ${operationId} is absent from its receipt.`});
    yield* executeSetupUndoOperation(config, adapter, projectRoot, scope, operation, dependencies);
    const updatedAt = yield* nowIso();
    const operations = receipt.operations.map(candidate =>
      candidate.id === operation.id ? {...candidate, status: 'rolled-back' as const} : candidate,
    );
    receipt = parseSetupReceiptV1({
      ...receipt,
      operations,
      recovery: setupRecovery(operations),
      status: 'rolling-back',
      updatedAt,
    });
    yield* writeSetupReceipt(receiptPath, receipt);
  }
  const rolledBackAt = yield* nowIso();
  const finalReceipt = parseSetupReceiptV1({
    ...receipt,
    recovery: setupRecovery(receipt.operations),
    rolledBackAt,
    status: 'rolled-back',
    updatedAt: rolledBackAt,
  });
  yield* writeSetupReceipt(receiptPath, finalReceipt);
  yield* Console.log(`Setup-created artifacts rolled back. Receipt: ${receiptPath}`);
  return finalReceipt;
});

function executeSetupUndoOperation<R>(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  projectRoot: string,
  scope: RunSetupOptions['scope'],
  operation: SetupReceiptOperationV1,
  dependencies: SetupOrchestratorDependencies<R>,
) {
  if (operation.kind === 'surface.ensure') return dependencies.removeSurface(config, adapter, projectRoot, scope);
  if (operation.kind === 'surface.hooks') return dependencies.removeHooks(config, adapter, operation);
  if (operation.kind === 'manifest.ensure') return removeSetupCreatedManifest(config, operation);
  return SetupOperationError.make({message: `Setup operation ${operation.id} has no supported rollback action.`});
}

const removeSetupCreatedManifest = Effect.fn('setup.removeCreatedManifest')(function* (
  config: RuntimeConfig,
  operation: SetupReceiptOperationV1,
) {
  const fs = yield* FileSystem.FileSystem;
  if (
    operation.ownership !== 'setup-created' ||
    operation.ownershipEvidence !== 'successful-mutation' ||
    operation.subsystemReceiptRef !== config.manifestPath ||
    operation.afterHash === undefined
  ) {
    return yield* SetupOperationError.make({message: 'Manifest rollback lacks exact setup ownership evidence.'});
  }
  if (!(yield* fs.exists(config.manifestPath)))
    return {ownership: 'setup-created', status: 'already-current'} satisfies SetupOperationOutcome;
  if (Option.isSome(yield* fs.readLink(config.manifestPath).pipe(Effect.option)))
    return yield* SetupOperationError.make({message: 'Refusing to roll back a symbolic-link manifest.'});
  const content = yield* fs.readFileString(config.manifestPath);
  if ((yield* sha256Hex(content)) !== operation.afterHash)
    return yield* SetupOperationError.make({message: 'Refusing to roll back a manifest changed after setup.'});
  yield* fs.remove(config.manifestPath);
  return {ownership: 'setup-created', status: 'applied'} satisfies SetupOperationOutcome;
});

function validateUndoTarget(
  receipt: SetupReceiptV1,
  adapter: AgentAdapter,
  scope: RunSetupOptions['scope'],
  receiptId: string,
): SetupOperationError | undefined {
  if (receipt.receiptId !== receiptId || receipt.surfaceId !== adapter.catalog.id || receipt.scope !== scope)
    return SetupOperationError.make({
      message: 'Setup receipt does not match the requested surface, scope, and repository.',
    });
}

const previewSetup = Effect.fn('setup.preview')(function* <R>(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  plan: SetupPlanV1,
  dependencies: SetupOrchestratorDependencies<R>,
) {
  for (const operation of plan.operations) {
    if (operation.kind === 'core.ensure') yield* dependencies.ensureCore(config, false);
    else if (operation.kind === 'manifest.ensure') yield* dependencies.ensureManifest(config, plan.projectRoot, false);
    else if (operation.kind === 'project.seed') yield* dependencies.seedProject(config, plan.projectRoot, false);
    else if (operation.kind === 'surface.ensure')
      yield* dependencies.ensureSurface(config, adapter, plan.projectRoot, false, plan.scope);
    else if (operation.kind === 'surface.hooks') yield* dependencies.ensureHooks(config, adapter, false);
    else if (operation.kind === 'graph.index') yield* dependencies.indexGraph(config, plan.projectRoot, false);
    else if (operation.kind === 'doctor.verify') yield* Console.log('Would require Threadnote doctor checks to pass.');
    else yield* Console.log('Would compile and source-verify a final Context Brief.');
  }
});

const applySetupPlan = Effect.fn('setup.applyPlan')(function* <R>(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  plan: SetupPlanV1,
  receiptId: string,
  receiptPath: string,
  dependencies: SetupOrchestratorDependencies<R>,
) {
  const replanned = yield* createSetupPlan({
    adapter,
    manifestPath: plan.manifestPath,
    projectRoot: plan.projectRoot,
    scope: plan.scope,
    task: SETUP_VERIFICATION_TASK,
    threadnoteVersion: plan.threadnoteVersion,
  });
  if (replanned.planHash !== plan.planHash)
    return yield* SetupOperationError.make({message: 'Setup inputs changed before the plan lock was acquired.'});

  const previous = yield* readSetupReceipt(receiptPath);
  if (previous?.receipt.status === 'rolling-back')
    return yield* SetupOperationError.make({
      message: 'Setup rollback is incomplete; re-run setup with --undo --apply.',
    });
  if (previous?.receipt.status === 'completed' && previous.receipt.planHash === plan.planHash) {
    const currentEvidence = yield* completedReceiptEvidenceIsCurrent(
      config,
      adapter,
      plan,
      previous.receipt,
      dependencies,
    );
    if (currentEvidence !== undefined) {
      yield* Console.log(`Setup is already complete. Receipt: ${receiptPath}`);
      if (currentEvidence.finalOutput !== undefined) yield* Console.log(`\n${currentEvidence.finalOutput.trimEnd()}`);
      return previous.receipt;
    }
  }
  const attemptStarted = yield* Clock.currentTimeNanos;
  let timeToFirstEvidenceMilliseconds: number | undefined;
  yield* recordSetupLifecycleValueEvent(config.agentContextHome, {
    durationMilliseconds: 0,
    phase: 'started',
    timestamp: yield* nowIso(),
  }).pipe(Effect.ignore);
  return yield* Effect.gen(function* () {
    const preservedOwnershipIds = yield* revalidatedSetupOwnershipIds(
      config,
      adapter,
      plan,
      receiptId,
      previous,
      dependencies,
    );
    let receipt = yield* beginSetupReceipt(plan, receiptId, previous, preservedOwnershipIds);
    yield* writeSetupReceipt(receiptPath, receipt);
    let finalOutput: string | undefined;
    let finalVerification = receipt.verification;
    if (
      finalVerification !== undefined &&
      receipt.operations.some(operation => operation.kind === 'context-brief.verify' && operation.status === 'verified')
    )
      timeToFirstEvidenceMilliseconds = 0;
    for (const operation of plan.operations) {
      let existing = receipt.operations.find(candidate => candidate.id === operation.id)!;
      const replayVerifiedBrief = operation.kind === 'context-brief.verify' && existing.status === 'verified';
      if (['applied', 'already-current', 'verified'].includes(existing.status) && !replayVerifiedBrief) continue;
      if (operation.reversible) {
        const inspection = yield* dependencies.inspectReversible(
          config,
          adapter,
          plan.projectRoot,
          operation.kind,
          plan.scope,
        );
        receipt = yield* updatePreparedReceipt(receiptPath, receipt, operation, inspection);
        existing = receipt.operations.find(candidate => candidate.id === operation.id)!;
      }
      const attempt = existing.status === 'pending' ? existing.attempt : existing.attempt + 1;
      const outcome = yield* executeSetupOperation(config, adapter, plan, operation, dependencies).pipe(
        Effect.filterOrFail(
          outcome =>
            (!operation.reversible || outcome.ownership !== undefined) &&
            (operation.kind !== 'context-brief.verify' || outcome.verification !== undefined),
          () =>
            SetupOperationError.make({
              message: operation.reversible
                ? `Reversible setup operation ${operation.id} returned no ownership evidence.`
                : 'Context Brief verification returned no receipt evidence.',
            }),
        ),
        Effect.onExit(exit =>
          Exit.isFailure(exit)
            ? updateFailedReceipt(receiptPath, receipt, operation, attempt, Cause.squash(exit.cause)).pipe(
                Effect.tap(next => Effect.sync(() => void (receipt = next))),
                Effect.ignore,
              )
            : Effect.void,
        ),
      );
      finalOutput = outcome.finalOutput ?? finalOutput;
      finalVerification = outcome.verification ?? finalVerification;
      if (operation.kind === 'context-brief.verify')
        timeToFirstEvidenceMilliseconds = yield* elapsedMilliseconds(attemptStarted);
      receipt = yield* updateSuccessfulReceipt(
        receiptPath,
        receipt,
        operation,
        attempt,
        outcome,
        preservedOwnershipIds.has(operation.id),
      );
    }
    const verification = receipt.operations.find(operation => operation.kind === 'context-brief.verify');
    if (verification?.status !== 'verified' || finalVerification === undefined)
      return yield* SetupOperationError.make({message: 'Setup completed without final Context Brief verification.'});
    const completedAt = yield* nowIso();
    const finalReceipt = parseSetupReceiptV1({
      ...receipt,
      completedAt,
      recovery: setupRecovery(receipt.operations),
      status: 'completed',
      updatedAt: completedAt,
      verification: finalVerification,
    });
    yield* writeSetupReceipt(receiptPath, finalReceipt);
    yield* recordSetupCompletionValueEvent(config.agentContextHome, {
      supportedAgentReuse: receipt.supportedAgentReuse === 1,
      timestamp: completedAt,
    }).pipe(Effect.ignore);
    yield* Console.log(`Setup complete. Receipt: ${receiptPath}`);
    if (finalOutput !== undefined) yield* Console.log(`\n${finalOutput.trimEnd()}`);
    return finalReceipt;
  }).pipe(
    Effect.onExit(exit =>
      Effect.gen(function* () {
        const durationMilliseconds = yield* elapsedMilliseconds(attemptStarted);
        yield* recordSetupLifecycleValueEvent(config.agentContextHome, {
          durationMilliseconds,
          phase: Exit.isSuccess(exit) ? 'completed' : 'failed',
          ...(Exit.isSuccess(exit)
            ? {timeToFirstEvidenceMilliseconds: timeToFirstEvidenceMilliseconds ?? durationMilliseconds}
            : {}),
          timestamp: yield* nowIso(),
        });
      }).pipe(Effect.ignore),
    ),
  );
});

function executeSetupOperation<R>(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  plan: SetupPlanV1,
  operation: SetupPlanOperationV1,
  dependencies: SetupOrchestratorDependencies<R>,
) {
  if (operation.kind === 'core.ensure') return dependencies.ensureCore(config, true);
  if (operation.kind === 'manifest.ensure') return dependencies.ensureManifest(config, plan.projectRoot, true);
  if (operation.kind === 'project.seed') return dependencies.seedProject(config, plan.projectRoot, true);
  if (operation.kind === 'surface.ensure')
    return dependencies.ensureSurface(config, adapter, plan.projectRoot, true, plan.scope);
  if (operation.kind === 'surface.hooks') return dependencies.ensureHooks(config, adapter, true);
  if (operation.kind === 'graph.index') return dependencies.indexGraph(config, plan.projectRoot, true);
  if (operation.kind === 'doctor.verify') return dependencies.doctor(config);
  return dependencies.contextBrief(config, plan.projectRoot, SETUP_VERIFICATION_TASK);
}

const revalidatedSetupOwnershipIds = Effect.fn('setup.revalidatedOwnership')(function* <R>(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  plan: SetupPlanV1,
  receiptId: string,
  previous: ReadSetupReceipt | undefined,
  dependencies: SetupOrchestratorDependencies<R>,
) {
  const preserved = new Set<string>();
  if (
    previous === undefined ||
    previous.receipt.status === 'rolling-back' ||
    previous.receipt.status === 'rolled-back' ||
    previous.receipt.receiptId !== receiptId ||
    previous.receipt.surfaceId !== plan.surfaceId ||
    previous.receipt.scope !== plan.scope
  )
    return preserved;
  for (const operation of plan.operations) {
    const prior = previous.receipt.operations.find(candidate => candidate.id === operation.id);
    if (
      prior?.kind !== operation.kind ||
      prior.ownership !== 'setup-created' ||
      prior.ownershipEvidence !== 'successful-mutation' ||
      !operation.reversible
    )
      continue;
    const inspection = yield* dependencies.inspectReversible(
      config,
      adapter,
      plan.projectRoot,
      operation.kind,
      plan.scope,
    );
    const exact =
      operation.kind === 'manifest.ensure' || operation.kind === 'surface.hooks'
        ? prior.afterHash !== undefined &&
          prior.subsystemReceiptRef === inspection.subsystemReceiptRef &&
          inspection.beforeHash === prior.afterHash
        : inspection.status === 'already-current';
    if (exact) preserved.add(operation.id);
  }
  return preserved;
});

const beginSetupReceipt = Effect.fn('setup.beginReceipt')(function* (
  plan: SetupPlanV1,
  receiptId: string,
  previous: ReadSetupReceipt | undefined,
  preservedOwnershipIds: ReadonlySet<string>,
) {
  const timestamp = yield* nowIso();
  const reuse =
    previous?.receipt.planHash === plan.planHash &&
    (previous.receipt.status === 'pending' || previous.receipt.status === 'failed');
  const operations = plan.operations.map(operation => {
    const prior = reuse ? previous?.receipt.operations.find(candidate => candidate.id === operation.id) : undefined;
    const previousOperation = previous?.receipt.operations.find(candidate => candidate.id === operation.id);
    const pending = {
      attempt: 1,
      id: operation.id,
      inputHash: operation.inputHash,
      kind: operation.kind,
      ownership: 'preexisting' as const,
      reversible: operation.reversible,
      status: 'pending' as const,
    } satisfies SetupReceiptOperationV1;
    if (prior?.inputHash === operation.inputHash) {
      if (prior.ownershipEvidence === 'successful-mutation' && !preservedOwnershipIds.has(operation.id)) return pending;
      return prior;
    }
    if (
      previous !== undefined &&
      previous.receipt.status !== 'rolled-back' &&
      previous.receipt.status !== 'rolling-back' &&
      previousOperation?.kind === operation.kind &&
      previousOperation.ownershipEvidence === 'successful-mutation' &&
      preservedOwnershipIds.has(operation.id)
    ) {
      return {
        ...pending,
        ...(previousOperation.afterHash === undefined ? {} : {afterHash: previousOperation.afterHash}),
        ...(previousOperation.beforeHash === undefined ? {} : {beforeHash: previousOperation.beforeHash}),
        attempt: previousOperation.attempt,
        ownership: 'setup-created' as const,
        ownershipEvidence: 'successful-mutation' as const,
        ...(previousOperation.subsystemReceiptRef === undefined
          ? {}
          : {subsystemReceiptRef: previousOperation.subsystemReceiptRef}),
      } satisfies SetupReceiptOperationV1;
    }
    return pending;
  });
  return parseSetupReceiptV1({
    operations,
    planHash: plan.planHash,
    ...(previous === undefined ? {} : {previousReceiptHash: yield* sha256Hex(previous.raw)}),
    receiptId,
    recovery: setupRecovery(operations),
    ...(plan.scope === undefined ? {} : {scope: plan.scope}),
    startedAt: reuse ? (previous?.receipt.startedAt ?? timestamp) : timestamp,
    status: 'pending',
    supportedAgentReuse: reuse ? (previous?.receipt.supportedAgentReuse ?? 0) : 0,
    surfaceId: plan.surfaceId,
    threadnoteVersion: plan.threadnoteVersion,
    type: 'threadnote-setup-receipt',
    updatedAt: timestamp,
    ...(reuse && previous?.receipt.verification !== undefined ? {verification: previous.receipt.verification} : {}),
    version: SETUP_RECEIPT_VERSION,
  });
});

const updateSuccessfulReceipt = Effect.fn('setup.updateSuccessfulReceipt')(function* (
  receiptPath: string,
  receipt: SetupReceiptV1,
  operation: SetupPlanOperationV1,
  attempt: number,
  outcome: SetupOperationOutcome,
  preserveSetupOwnership: boolean,
) {
  const updatedAt = yield* nowIso();
  const operations = receipt.operations.map(candidate => {
    if (candidate.id !== operation.id) return candidate;
    const preservesEstablishedOwnership =
      preserveSetupOwnership &&
      candidate.ownership === 'setup-created' &&
      candidate.ownershipEvidence === 'successful-mutation';
    const ownership = preservesEstablishedOwnership ? 'setup-created' : (outcome.ownership ?? candidate.ownership);
    return {
      ...(outcome.afterHash === undefined ? {} : {afterHash: outcome.afterHash}),
      attempt,
      ...(outcome.beforeHash === undefined ? {} : {beforeHash: outcome.beforeHash}),
      id: candidate.id,
      inputHash: candidate.inputHash,
      kind: candidate.kind,
      ownership,
      ...(candidate.reversible &&
      ownership === 'setup-created' &&
      (outcome.ownership === 'setup-created' || preservesEstablishedOwnership)
        ? {ownershipEvidence: 'successful-mutation' as const}
        : {}),
      reversible: candidate.reversible,
      status: outcome.status,
      ...(outcome.subsystemReceiptRef === undefined ? {} : {subsystemReceiptRef: outcome.subsystemReceiptRef}),
    };
  });
  const next = parseSetupReceiptV1({
    ...receipt,
    operations,
    recovery: setupRecovery(operations),
    status: 'pending',
    supportedAgentReuse: receipt.supportedAgentReuse === 1 || outcome.supportedAgentReuse === true ? 1 : 0,
    updatedAt,
    ...(outcome.verification === undefined ? {} : {verification: outcome.verification}),
  });
  yield* writeSetupReceipt(receiptPath, next);
  return next;
});

const updatePreparedReceipt = Effect.fn('setup.updatePreparedReceipt')(function* (
  receiptPath: string,
  receipt: SetupReceiptV1,
  operation: SetupPlanOperationV1,
  inspection: SetupOperationOutcome,
) {
  const updatedAt = yield* nowIso();
  const operations = receipt.operations.map(candidate =>
    candidate.id === operation.id
      ? {
          ...candidate,
          ...(inspection.beforeHash === undefined ? {} : {beforeHash: inspection.beforeHash}),
          ownership:
            candidate.ownership === 'setup-created'
              ? candidate.ownership
              : (inspection.ownership ?? candidate.ownership),
          ...(inspection.subsystemReceiptRef === undefined
            ? {}
            : {subsystemReceiptRef: inspection.subsystemReceiptRef}),
        }
      : candidate,
  );
  const next = parseSetupReceiptV1({...receipt, operations, updatedAt});
  yield* writeSetupReceipt(receiptPath, next);
  return next;
});

const updateFailedReceipt = Effect.fn('setup.updateFailedReceipt')(function* (
  receiptPath: string,
  receipt: SetupReceiptV1,
  operation: SetupPlanOperationV1,
  attempt: number,
  cause: unknown,
) {
  const updatedAt = yield* nowIso();
  const operations = receipt.operations.map(candidate =>
    candidate.id === operation.id
      ? {
          attempt,
          error: {
            code: operation.kind.endsWith('.verify') ? ('verification-failed' as const) : ('operation-failed' as const),
            message: boundedFailureMessage(cause),
          },
          id: candidate.id,
          inputHash: candidate.inputHash,
          kind: candidate.kind,
          ownership: candidate.ownership,
          ...(candidate.ownershipEvidence === undefined ? {} : {ownershipEvidence: candidate.ownershipEvidence}),
          reversible: candidate.reversible,
          status: 'failed' as const,
          ...(candidate.beforeHash === undefined ? {} : {beforeHash: candidate.beforeHash}),
          ...(candidate.afterHash === undefined ? {} : {afterHash: candidate.afterHash}),
          ...(candidate.subsystemReceiptRef === undefined ? {} : {subsystemReceiptRef: candidate.subsystemReceiptRef}),
        }
      : candidate,
  );
  const {verification: _discardedVerification, ...receiptWithoutVerification} = receipt;
  const next = parseSetupReceiptV1({
    ...(operation.kind === 'context-brief.verify' ? receiptWithoutVerification : receipt),
    operations,
    recovery: setupRecovery(operations),
    status: 'failed',
    updatedAt,
  });
  yield* writeSetupReceipt(receiptPath, next);
  return next;
});

interface ReadSetupReceipt {
  readonly raw: string;
  readonly receipt: SetupReceiptV1;
}

const readSetupReceipt = Effect.fn('setup.readReceipt')(function* (receiptPath: string) {
  const raw = yield* readFileIfExists(receiptPath);
  if (raw === undefined) return undefined;
  return yield* Effect.try({
    try: () => ({raw, receipt: parseSetupReceiptV1(JSON.parse(raw))}) satisfies ReadSetupReceipt,
    catch: cause =>
      SetupOperationError.make({message: `Setup receipt is invalid and was not replaced: ${errorMessage(cause)}`}),
  });
});

const completedReceiptEvidenceIsCurrent = Effect.fn('setup.completedReceiptEvidenceIsCurrent')(function* <R>(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  plan: SetupPlanV1,
  receipt: SetupReceiptV1,
  dependencies: SetupOrchestratorDependencies<R>,
) {
  for (const operation of receipt.operations) {
    if (operation.afterHash === undefined || operation.subsystemReceiptRef === undefined) continue;
    const content = yield* readFileIfExists(operation.subsystemReceiptRef);
    if (content === undefined || (yield* sha256Hex(content)) !== operation.afterHash) return undefined;
  }
  if ((yield* setupRepositorySourceHash(plan.projectRoot)) !== receipt.verification?.repositorySourceHash)
    return undefined;
  const surface = yield* dependencies.ensureSurface(config, adapter, plan.projectRoot, false, plan.scope);
  if (surface.status !== 'already-current') return undefined;
  if (plan.operations.some(operation => operation.kind === 'surface.hooks')) {
    const hooks = yield* dependencies.ensureHooks(config, adapter, false);
    if (hooks.status !== 'already-current') return undefined;
  }
  const healthy = yield* dependencies.doctor(config).pipe(
    Effect.map(outcome => outcome.status === 'verified'),
    Effect.orElseSucceed(() => false),
  );
  if (!healthy) return undefined;
  return yield* dependencies.contextBrief(config, plan.projectRoot, SETUP_VERIFICATION_TASK).pipe(
    Effect.map(outcome =>
      outcome.status === 'verified' &&
      outcome.verification?.repositorySourceHash === receipt.verification?.repositorySourceHash
        ? outcome
        : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );
});

const writeSetupReceipt = Effect.fn('setup.writeReceipt')(function* (receiptPath: string, receipt: SetupReceiptV1) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const parsed = parseSetupReceiptV1(receipt);
  const temporary = `${receiptPath}.${system.processId}.tmp`;
  yield* fs.makeDirectory(path.dirname(receiptPath), {recursive: true, mode: 0o700});
  yield* fs
    .writeFileString(temporary, `${JSON.stringify(parsed, undefined, 2)}\n`, {mode: 0o600})
    .pipe(
      Effect.andThen(fs.rename(temporary, receiptPath)),
      Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
    );
});

const setupReceiptIdFor = Effect.fn('setup.receiptId')(function* (
  projectRoot: string,
  scope: SetupPlanV1['scope'],
  surfaceId: string,
) {
  return yield* sha256Hex(JSON.stringify({projectRoot, scope, surfaceId}));
});

function setupReceiptPath(path: Path.Path, home: string, surfaceId: string, receiptId: string): string {
  return path.join(home, 'setup', `${surfaceId}-${receiptId.slice(0, 16)}.json`);
}

function boundedFailureMessage(cause: unknown): string {
  const tag =
    typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string'
      ? cause._tag
      : 'operation';
  return `${tag} failed; inspect the command output, then re-run the same setup plan.`.slice(0, 512);
}

const nowIso = Effect.fn('setup.nowIso')(function* () {
  return DateTime.formatIso(yield* DateTime.now);
});

const elapsedMilliseconds = Effect.fn('setup.elapsedMilliseconds')(function* (started: bigint) {
  const elapsed = Math.round(Number((yield* Clock.currentTimeNanos) - started) / 1_000_000);
  return Math.min(SETUP_MAX_DURATION_MILLISECONDS, Math.max(0, elapsed));
});
