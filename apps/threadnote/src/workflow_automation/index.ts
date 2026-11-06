import {Array as EffectArray, Option as EffectOption} from 'effect';
import {loadRecallMemoryIdentities, withRecallIdentityPreparation} from '@threadnote/recall/index';
import {nativeRequestSchema} from './request_schema.js';
import {nativeWorkflowFeatureVersions} from './features.js';
import {Effect} from 'effect';
import {withNativeFileLockWaitBudget} from '@threadnote/platform/file/lock';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {WorkflowAutomationError, type WorkflowWriteIntent} from '@threadnote/workflow-automations/contracts';
import {
  decodeNativeWorkflowRequest,
  decodeNativeWorkflowState,
  nativeWorkflowIntentDigest,
  nativeWorkflowOperationLimit,
  type NativeWorkflowRequest,
  type NativeWorkflowState,
} from '@threadnote/workflow-automations/native';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withNativeWorkflowMemorySession} from '../workflow_memory/index.js';
import {resolveWorkflowBinding} from '../workflow_memory/profile.js';
import {bindWorkflow, inspectWorkflowJournal, withWorkflowLock} from '../workflow_memory/journal.js';
import {stableJson, type WorkflowBinding} from '../workflow_memory/protocol.js';
import {makeWorkflowMemoryAdapter, nativeWorkflowError, workflowWriteRequest} from './memory.js';
import {makeWorkflowGraphAdapter} from './graph.js';
import {
  CurrentNativeAuthoringSave,
  CurrentNativeCloseoutSave,
  CurrentNativeOperationLimit,
  readNativeWorkflowState,
  writeNativeWorkflowState,
  withNativeWorkflowLock,
} from './store.js';
import {reserveWorkflowNameFamily} from './naming.js';
import {runNativeAuthoring} from './authoring.js';
import {runNativeCycle} from './cycle.js';
import {runNativeWatch} from './watch.js';
import {runNativeCloseout} from './closeout.js';
import {decodeJournal} from './closeout_request_schema.js';
import {readNativeCloseoutJournal} from './closeout_store.js';
import {CurrentNativeJobBoundary, CurrentNativeJobProgress, runNativeJob} from './native_jobs.js';
import {boundNativeCycleOutput} from '@threadnote/workflow-automations/cycle-output';
import {
  CurrentWorkflowReadCache,
  immutableWorkflowImage,
  withWorkflowReadCache,
} from '../workflow_memory/read_cache.js';
import * as EffectRecord from 'effect/Record';

const version = {protocolVersion: 1 as const, executorVersion: 1 as const};
const issue = (code: string, message: string) => WorkflowAutomationError.make({code, message});
type WriteRequest = Extract<NativeWorkflowRequest, {readonly action: 'preflight' | 'write'}>;
type Stored = NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>;
type Memory = Effect.Success<ReturnType<typeof makeWorkflowMemoryAdapter>>;

const summary = (state: NativeWorkflowState) => ({
  ...version,
  status: 'ok' as const,
  format: state.format,
  stateVersion: state.stateVersion,
  runId: state.runId,
  generation: state.generation,
  bindingId: state.bindingId,
  project: state.project,
  featureId: state.featureId,
  ...(state.naming ? {naming: state.naming, title: state.title} : {}),
  profile: state.profile,
  ...(state.team ? {team: state.team} : {}),
  operations: EffectArray.map(state.operations, operation => ({
    operationId: operation.intent.operationId,
    status: operation.status,
    intentDigest: operation.intentDigest,
    ...(operation.artifact
      ? {
          uri: operation.artifact.uri,
          memoryId: operation.artifact.memoryId,
          revision: operation.artifact.revision,
        }
      : {}),
  })),
});

const bindingRequest = (
  state: Pick<NativeWorkflowState, 'runId' | 'project' | 'featureId' | 'generation'> & {
    readonly naming?: NativeWorkflowState['naming'];
  },
) => ({
  protocolVersion: 1 as const,
  action: 'bind' as const,
  // Native fresh runs cannot reinterpret an ordinary helper's run ID.
  workflowRunId: 'native-v1-' + state.runId,
  project: state.project,
  featureId: state.featureId,
  generation: state.generation,
  ...(state.naming ? {naming: state.naming} : {}),
});

const currentBinding = Effect.fn('workflowAutomation.currentBinding')(function* (
  config: RuntimeConfig,
  state: NativeWorkflowState,
) {
  const binding = yield* resolveWorkflowBinding(config, {
    ...bindingRequest(state),
    profile: state.profile,
    ...(state.team ? {team: state.team} : {}),
  });
  if (binding.bindingId !== state.bindingId)
    return yield* issue(
      'binding-drift',
      'Native run identity, checkout, home or profile changed. Resume its original context.',
    );
  return binding;
});

const inspectNative = Effect.fn('workflowAutomation.inspectNative')(function* (
  config: RuntimeConfig,
  state: NativeWorkflowState,
  binding: WorkflowBinding,
  admitted?: Effect.Success<ReturnType<typeof inspectWorkflowJournal>>,
) {
  const native =
    admitted ?? (yield* withWorkflowLock(config, binding.bindingId, inspectWorkflowJournal(config, binding.bindingId)));
  const ids = new Set(EffectArray.map(state.operations, operation => operation.intent.operationId));
  const cache = yield* CurrentWorkflowReadCache;
  if (
    EffectArray.some(
      EffectRecord.toEntries(native.state.operations),
      ([id, operation]) =>
        !ids.has(id) &&
        !(
          operation.request.action === 'archive' &&
          operation.request.sourceRunId === state.runId &&
          EffectArray.some(
            state.operations,
            local =>
              local.status === 'verified' &&
              local.artifact?.uri === operation.sourceUri &&
              local.intent.artifactKey === operation.request.artifactKey &&
              local.intent.role === operation.request.role,
          )
        ),
    )
  )
    return yield* issue(
      'invalid-state',
      'Native intent is missing from this run’s receipts. Restore its original state; no import was applied.',
    );
  for (const local of state.operations) {
    const observed = native.state.operations[local.intent.operationId];
    let digests = cache?.executor.get(local);
    if (!digests) {
      digests = {
        intentDigest: sha256HexSync(stableJson(workflowWriteRequest(local.intent))),
        ...(local.artifact ? {bodyDigest: sha256HexSync(local.artifact.body)} : {}),
      };
      if (cache) cache.executor.set(immutableWorkflowImage(local), digests);
    }
    if (
      (observed && observed.intentDigest !== digests.intentDigest) ||
      (local.status === 'verified' &&
        (!observed ||
          observed.status !== 'verified' ||
          local.artifact?.uri !== observed.artifact.canonicalUri ||
          local.artifact.memoryId !== observed.artifact.memoryId ||
          local.artifact.revision !== observed.artifact.revision ||
          digests.bodyDigest !== observed.artifact.bodySha256))
    )
      return yield* issue('invalid-state', 'Native operation receipts disagree with the authoritative memory intent.');
  }
  return {
    ...summary(state),
    needsRecovery: native.needsRecovery,
    artifactReadback: 'not-performed' as const,
    operations: EffectArray.map(summary(state).operations, operation => ({
      ...operation,
      nativeOperationState: native.state.operations[operation.operationId]?.status ?? 'absent',
    })),
  };
});

const load = Effect.fn('workflowAutomation.load')(function* (
  config: RuntimeConfig,
  request: {readonly runId: string; readonly generation: string},
) {
  const stored = yield* readNativeWorkflowState(config, request.runId);
  if (!stored) return yield* issue('run-not-found', 'Start a fresh native run explicitly; no legacy state was loaded.');
  if (stored.state.generation !== request.generation)
    return yield* issue('generation-conflict', 'Resume with this run’s pinned immutable skill generation.');
  return stored;
});

const initialize = Effect.fn('workflowAutomation.initialize')(function* (
  config: RuntimeConfig,
  request: Extract<NativeWorkflowRequest, {readonly action: 'init'}>,
) {
  const existing = yield* readNativeWorkflowState(config, request.runId);
  if (existing) {
    const state = existing.state;
    if (
      state.project !== request.project ||
      state.featureId !== request.featureId ||
      state.generation !== request.generation ||
      (request.title !== undefined && state.title !== request.title) ||
      (request.profile !== undefined && state.profile !== request.profile) ||
      (request.team !== undefined && state.team !== request.team)
    )
      return yield* issue('binding-drift', 'This run ID already belongs to different native intent.');
    const binding = yield* currentBinding(config, state);
    return yield* inspectNative(config, state, binding);
  }
  const baseBinding = yield* resolveWorkflowBinding(config, {
    ...bindingRequest(request),
    ...(request.profile ? {profile: request.profile} : {}),
    ...(request.team ? {team: request.team} : {}),
  });
  const title = request.title ?? request.featureId;
  const naming = yield* reserveWorkflowNameFamily(config, baseBinding, title);
  const binding = yield* resolveWorkflowBinding(config, {
    ...bindingRequest(request),
    naming,
    ...(request.profile ? {profile: request.profile} : {}),
    ...(request.team ? {team: request.team} : {}),
  });
  const state: NativeWorkflowState = {
    format: 'threadnote-native-workflow',
    stateVersion: 1,
    executorVersion: 1,
    runId: request.runId,
    project: binding.project,
    featureId: binding.featureId,
    title,
    naming,
    generation: binding.generation,
    profile: binding.profile,
    ...(binding.team ? {team: binding.team} : {}),
    bindingId: binding.bindingId,
    operations: [],
  };
  // Admission must finish before a canonical binding journal or manifest is created.
  yield* Effect.try({try: () => decodeNativeWorkflowState(state), catch: nativeWorkflowError});
  yield* withWorkflowLock(config, binding.bindingId, bindWorkflow(config, binding, {requireEmpty: true}));
  yield* writeNativeWorkflowState(config, state, null);
  return summary(state);
});

const intentFrom = (state: NativeWorkflowState, request: WriteRequest) => {
  const {
    protocolVersion: _protocol,
    executorVersion: _executor,
    action: _action,
    runId: _run,
    generation: _generation,
    ...fields
  } = request;
  return {...fields, bindingId: state.bindingId, sourceRunId: state.runId};
};

/** Only the same pinned intent can resume. An absent native operation replays, never rebinds. */
const resumeWrite = (memory: Memory, intent: WorkflowWriteIntent) =>
  memory
    .inspectOperation(intent)
    .pipe(
      Effect.flatMap(observed =>
        observed.state === 'absent' ? memory.write(intent) : memory.recover(intent.bindingId, intent.operationId),
      ),
    );
const save = Effect.fn('workflowAutomation.save')(function* (
  config: RuntimeConfig,
  stored: Stored,
  memory: Memory,
  request: WriteRequest,
) {
  const closeout = stored.state.closeoutSave;
  if (
    closeout &&
    ((yield* CurrentNativeCloseoutSave) !== closeout.transactionId ||
      !closeout.operationIds.includes(request.operationId))
  )
    return yield* issue('pending-operation', 'Finish this run’s admitted closeout before starting another write.');
  const intent = intentFrom(stored.state, request);
  const digest = nativeWorkflowIntentDigest(intent, sha256HexSync);
  const existing = EffectOption.getOrUndefined(
    EffectArray.findFirst(stored.state.operations, operation => operation.intent.operationId === request.operationId),
  );
  if (existing && existing.intentDigest !== digest)
    return yield* issue('operation-intent-conflict', 'This operationId already belongs to different native intent.');
  if ((intent.relations?.length ?? 0) > 0 || (intent.evidenceRefs?.length ?? 0) > 0)
    yield* loadRecallMemoryIdentities(config, {allowedUriScopes: [], memoryIds: []}).pipe(
      withRecallIdentityPreparation,
    );
  if (request.action === 'preflight' && existing) {
    if (existing.status !== 'verified' || !existing.artifact)
      return yield* issue(
        'pending-operation',
        'Recover this exact pending operation before treating its preflight as complete.',
      );
    const current = yield* memory.read(intent.bindingId, existing.artifact.uri, intent.evidenceRefs);
    if (current.memoryId !== existing.artifact.memoryId || current.revision !== existing.artifact.revision)
      return yield* issue(
        'revision-conflict',
        'The previously verified artifact changed. Refresh it before preparing new intent.',
      );
    return {
      ...version,
      status: 'ok' as const,
      operationId: request.operationId,
      uri: current.uri,
      bodySha256: sha256HexSync(current.body),
      verification: 'existing-operation-readback' as const,
    };
  }
  if (request.action === 'preflight')
    return {
      ...version,
      status: 'ok' as const,
      operationId: request.operationId,
      ...(yield* memory.preflight(intent)),
    };
  const reservation = stored.state.authoringSave;
  if (reservation && (yield* CurrentNativeAuthoringSave) !== reservation.intentDigest)
    return yield* issue(
      'pending-operation',
      'Finish this run’s admitted authoring save before starting another write.',
    );
  const operationLimit = Math.min(
    nativeWorkflowOperationLimit,
    yield* CurrentNativeOperationLimit,
    reservation?.operationLimit ?? closeout?.operationLimit ?? nativeWorkflowOperationLimit,
  );
  if (!existing && EffectArray.some(stored.state.operations, operation => operation.status === 'prepared'))
    return yield* issue(
      'pending-operation',
      'Recover this run’s existing pending operation before preparing another write.',
    );
  if (!existing && stored.state.operations.length >= operationLimit)
    return yield* issue(
      'state-capacity',
      'This native run reached its bounded operation capacity. Existing receipts remain unchanged.',
    );
  let pending = stored;
  if (!existing) {
    yield* memory.preflight(intent);
    pending = yield* writeNativeWorkflowState(
      config,
      {
        ...stored.state,
        operations: [...stored.state.operations, {status: 'prepared' as const, intent, intentDigest: digest}],
      },
      stored.revision,
    );
  }
  const first = existing ? resumeWrite(memory, intent) : memory.write(intent);
  const artifact = yield* first;
  if (existing?.status !== 'verified')
    yield* writeNativeWorkflowState(
      config,
      {
        ...pending.state,
        operations: EffectArray.map(pending.state.operations, operation =>
          operation.intent.operationId === request.operationId
            ? {...operation, status: 'verified' as const, artifact}
            : operation,
        ),
      },
      pending.revision,
    );
  const progress = yield* CurrentNativeJobProgress;
  if (progress)
    yield* progress({
      runId: stored.state.runId,
      generation: stored.state.generation,
      bindingId: stored.state.bindingId,
      operationId: request.operationId,
      rootVerified: intent.role === 'authoring-root',
    });
  return {...version, status: 'ok' as const, runId: stored.state.runId, operationId: request.operationId, artifact};
});

const recover = Effect.fn('workflowAutomation.recover')(function* (
  config: RuntimeConfig,
  stored: Stored,
  memory: Memory,
  operationId: string,
) {
  if (stored.state.authoringSave && (yield* CurrentNativeAuthoringSave) !== stored.state.authoringSave.intentDigest)
    return yield* issue('pending-operation', 'Resume the original authoring save before recovering its child writes.');
  if (
    stored.state.closeoutSave &&
    ((yield* CurrentNativeCloseoutSave) !== stored.state.closeoutSave.transactionId ||
      !stored.state.closeoutSave.operationIds.includes(operationId))
  )
    return yield* issue('pending-operation', 'Resume the original closeout before recovering its child writes.');
  const operation = EffectOption.getOrUndefined(
    EffectArray.findFirst(stored.state.operations, item => item.intent.operationId === operationId),
  );
  if (!operation)
    return yield* issue(
      'operation-not-found',
      'This native run has no such pending intent. No state was imported or reconstructed.',
    );
  const artifact = yield* resumeWrite(memory, operation.intent);
  if (operation.status !== 'verified')
    yield* writeNativeWorkflowState(
      config,
      {
        ...stored.state,
        operations: EffectArray.map(stored.state.operations, item =>
          item.intent.operationId === operationId ? {...item, status: 'verified' as const, artifact} : item,
        ),
      },
      stored.revision,
    );
  const progress = yield* CurrentNativeJobProgress;
  if (progress)
    yield* progress({
      runId: stored.state.runId,
      generation: stored.state.generation,
      bindingId: stored.state.bindingId,
      operationId,
      rootVerified: operation.intent.role === 'authoring-root',
    });
  return {...version, status: 'ok' as const, runId: stored.state.runId, operationId, artifact};
});

const runBound = Effect.fn('workflowAutomation.bound')(function* (
  config: RuntimeConfig,
  request: Exclude<NativeWorkflowRequest, {readonly action: 'init' | 'capabilities' | 'graph-ready'}>,
  taskDetail?: 'summary' | 'packet',
) {
  const stored = yield* load(config, request);
  return yield* withNativeWorkflowMemorySession(config, stored.state.bindingId, (admission, call) =>
    Effect.gen(function* () {
      const binding = admission.state.binding;
      const expected = {...bindingRequest(stored.state), profile: stored.state.profile, team: stored.state.team};
      if (
        binding.bindingId !== stored.state.bindingId ||
        binding.workflowRunId !== expected.workflowRunId ||
        binding.project !== expected.project ||
        binding.featureId !== expected.featureId ||
        binding.generation !== expected.generation ||
        binding.profile !== expected.profile ||
        binding.team !== expected.team ||
        stableJson(binding.naming) !== stableJson(stored.state.naming)
      )
        return yield* issue('binding-drift', 'Native run identity differs from its current journal admission.');
      const inspection = yield* inspectNative(config, stored.state, binding, admission);
      if (taskDetail !== undefined) {
        const memory = yield* makeWorkflowMemoryAdapter(config, binding, call);
        // This closure is created only after actual admission and expires with the existing journal session.
        // It admits reads only; caller JSON cannot supply or reuse an inspection capability.
        const read = (input: unknown) =>
          Effect.gen(function* () {
            const child = yield* Effect.try({
              try: () => decodeNativeWorkflowRequest(input),
              catch: nativeWorkflowError,
            });
            if (
              !('runId' in child) ||
              child.runId !== stored.state.runId ||
              child.generation !== stored.state.generation
            )
              return yield* issue('binding-drift', 'The task read belongs to another native run.');
            if (child.action === 'inspect') return inspection;
            if (child.action !== 'read')
              return yield* issue('invalid-request', 'Task inspection only admits current artifact reads.');
            return {
              ...version,
              status: 'ok' as const,
              artifact: yield* memory.read(binding.bindingId, child.uri, child.evidenceRefs),
            };
          });
        const completedCloseout = yield* readNativeCloseoutJournal(config, stored.state.runId, decodeJournal);
        const completedJournal =
          completedCloseout?.state.status === 'complete' &&
          completedCloseout.state.runId === stored.state.runId &&
          completedCloseout.state.generation === stored.state.generation &&
          completedCloseout.state.bindingId === stored.state.bindingId
            ? completedCloseout.state
            : undefined;
        // Documents can repeat a key when closeout replaces an earlier draft; the last value is the final output.
        const finalDocuments = completedJournal
          ? new Map(EffectArray.map(completedJournal.documents, document => [document.key, document] as const))
          : undefined;
        const expectedOutputKeys = finalDocuments ? [...finalDocuments.keys()] : [];
        const actualOutputKeys = completedJournal ? new Set(EffectRecord.keys(completedJournal.outputs)) : undefined;
        if (
          completedJournal &&
          (expectedOutputKeys.length === 0 ||
            expectedOutputKeys.length !== actualOutputKeys?.size ||
            EffectArray.some(expectedOutputKeys, key => !actualOutputKeys?.has(key)))
        )
          return yield* issue(
            'invalid-closeout-state',
            'Completed closeout output receipts do not cover every admitted final document.',
          );
        const terminalCloseout = completedJournal;
        const source = stored.state.cycle?.state.plan.source;
        const pinned = source && !terminalCloseout ? yield* memory.read(binding.bindingId, source.root.uri) : undefined;
        const planDrift =
          source &&
          !terminalCloseout &&
          (pinned?.memoryId !== source.root.memoryId || pinned.revision !== source.root.revision)
            ? 'The approved plan root changed. Reconcile its current verified export before further delivery.'
            : undefined;
        const verifiedCloseoutOutputs = terminalCloseout
          ? yield* Effect.forEach(EffectRecord.toEntries(terminalCloseout.outputs), ([key, reference]) =>
              Effect.gen(function* () {
                const artifact = yield* memory.read(binding.bindingId, reference.uri);
                const document = finalDocuments?.get(key);
                if (
                  !document ||
                  reference.uri !== document.uri ||
                  artifact.uri !== reference.uri ||
                  artifact.memoryId !== reference.memoryId ||
                  artifact.revision !== reference.revision ||
                  artifact.body !== document.body ||
                  artifact.storageKind !== (terminalCloseout.profile === 'desktop' ? 'durable' : 'handoff') ||
                  artifact.state !== 'active'
                )
                  return yield* issue(
                    'invalid-readback',
                    'A completed closeout output no longer matches its verified durable receipt.',
                  );
                return {key, uri: artifact.uri, memoryId: artifact.memoryId, revision: artifact.revision};
              }),
            )
          : undefined;
        if (terminalCloseout) {
          const afterCloseoutRead = yield* readNativeCloseoutJournal(config, stored.state.runId, decodeJournal);
          if (afterCloseoutRead?.revision !== completedCloseout?.revision)
            return yield* issue(
              'inspection-failed',
              'The completed closeout changed while reading its durable outputs.',
            );
        }
        const hasPlan =
          !terminalCloseout &&
          EffectArray.some(
            stored.state.operations,
            entry =>
              entry.status === 'verified' &&
              entry.intent.role === 'authoring-root' &&
              entry.intent.artifactKey === 'author-root-plan',
          );
        const authoring = hasPlan
          ? yield* runNativeAuthoring(
              config,
              {
                ...version,
                action: 'authoring',
                command: 'current-plan',
                runId: stored.state.runId,
                generation: stored.state.generation,
                detail: taskDetail === 'packet' ? 'document' : 'summary',
              },
              read,
            )
          : undefined;
        return {
          ...inspection,
          revision: stored.revision,
          taskAuthoring: authoring?.authoring,
          ...(terminalCloseout && verifiedCloseoutOutputs
            ? {
                taskCloseout: {
                  status: 'complete' as const,
                  transactionId: terminalCloseout.transactionId,
                  outputs: verifiedCloseoutOutputs,
                },
              }
            : {}),
          ...(planDrift ? {planDrift} : {}),
        };
      }
      if (request.action === 'inspect') return inspection;
      const memory = yield* makeWorkflowMemoryAdapter(config, binding, call);
      if (request.action === 'read')
        return {
          ...version,
          status: 'ok' as const,
          artifact: yield* memory.read(binding.bindingId, request.uri, request.evidenceRefs),
        };
      if (request.action === 'recover') return yield* recover(config, stored, memory, request.operationId);
      return yield* save(config, stored, memory, request);
    }),
  );
});

const runCoreNative = Effect.fn('workflowAutomation.run')(function* (config: RuntimeConfig, input: unknown) {
  const request = yield* Effect.try({try: () => decodeNativeWorkflowRequest(input), catch: nativeWorkflowError});
  const boundary = yield* CurrentNativeJobBoundary;
  if (boundary && (request.action === 'write' || request.action === 'recover')) yield* boundary;
  if (request.action === 'capabilities')
    return {
      ...version,
      stateVersion: 1,
      namingPolicyVersion: 1,
      ...nativeWorkflowFeatureVersions,
      status: 'ok' as const,
      operations: [
        'request-schema',
        'init',
        'inspect',
        'read',
        'preflight',
        'write',
        'recover',
        'graph-ready',
        'authoring',
        'cycle',
        'watch',
        'closeout',
        'job',
      ],
      profiles: ['desktop', 'codex-cloud-personal', 'cursor-cloud-personal'],
    };
  if (request.action === 'init')
    return yield* withNativeWorkflowLock(config, request.runId, true, initialize(config, request));
  if (request.action === 'graph-ready') {
    const stored = yield* load(config, request);
    const binding = yield* currentBinding(config, stored.state);
    yield* inspectNative(config, stored.state, binding);
    const graph = yield* makeWorkflowGraphAdapter(config, binding);
    return {...version, status: 'ok' as const, graph: yield* graph.ready(binding.repo)};
  }
  return yield* withNativeWorkflowLock(config, request.runId, false, runBound(config, request));
});

const dispatchNative = Effect.fn('workflowAutomation.dispatch')(function* (
  config: RuntimeConfig,
  input: unknown,
  allowCompactOriginCreation = false,
) {
  if (typeof input === 'object' && input !== null && 'action' in input && input.action === 'request-schema')
    return yield* Effect.try({try: () => nativeRequestSchema(input), catch: nativeWorkflowError});
  if (typeof input === 'object' && input !== null && 'action' in input && input.action === 'job')
    return yield* runNativeJob(config, input, request =>
      runCoreNative(config, request).pipe(Effect.mapError(nativeWorkflowError)),
    );
  if (typeof input === 'object' && input !== null && 'action' in input && input.action === 'closeout')
    return yield* withWorkflowReadCache(
      runNativeCloseout(config, input, request =>
        typeof request === 'object' && request !== null && 'action' in request && request.action === 'authoring'
          ? runNativeAuthoring(config, request, core =>
              runCoreNative(config, core).pipe(Effect.mapError(nativeWorkflowError)),
            )
          : runCoreNative(config, request).pipe(Effect.mapError(nativeWorkflowError)),
      ),
      {compactJournal: true},
    );
  if (typeof input === 'object' && input !== null && 'action' in input && input.action === 'cycle') {
    const request = input as Record<string, unknown>;
    const detail: Record<string, string> =
      request.command === 'validate-review' && typeof request.attemptId === 'string'
        ? {attemptId: request.attemptId, detailKind: 'attempt'}
        : typeof request.snapshotId === 'string'
          ? {snapshotId: request.snapshotId, detailKind: 'manifest'}
          : typeof request.phaseId === 'string'
            ? {phaseId: request.phaseId, detailKind: 'phase'}
            : {detailKind: 'overview'};
    const maximumBytes = typeof request.maxBytes === 'number' ? request.maxBytes : 16_384;
    const payload = yield* runNativeCycle(
      config,
      input,
      request => runCoreNative(config, request).pipe(Effect.mapError(nativeWorkflowError)),
      request =>
        runNativeAuthoring(config, request, core =>
          runCoreNative(config, core).pipe(Effect.mapError(nativeWorkflowError)),
        ),
    ).pipe(
      program => withWorkflowReadCache(program, {compactJournal: true}),
      Effect.map(value => boundNativeCycleOutput(value, maximumBytes - 512, detail)),
    );
    return 'status' in payload && payload.status === 'error'
      ? {
          ...version,
          status: 'error' as const,
          code: typeof payload.code === 'string' ? payload.code : 'cycle-operation-failed',
          cycle: payload,
        }
      : {...version, status: 'ok' as const, cycle: payload};
  }
  if (typeof input === 'object' && input !== null && 'action' in input && input.action === 'watch')
    return yield* runNativeWatch(config, input);
  if (typeof input === 'object' && input !== null && 'action' in input && input.action === 'authoring')
    return yield* runNativeAuthoring(
      config,
      input,
      request => runCoreNative(config, request).pipe(Effect.mapError(nativeWorkflowError)),
      {allowCompactOriginCreation: allowCompactOriginCreation && 'command' in input && input.command === 'save'},
    );
  return yield* runCoreNative(config, input);
});

const runWorkflowAutomationWithCompactCapability = (
  config: RuntimeConfig,
  input: unknown,
  allowCompactOriginCreation: boolean,
) =>
  dispatchNative(config, input, allowCompactOriginCreation).pipe(
    withNativeFileLockWaitBudget,
    Effect.catchDefect(error => Effect.fail(nativeWorkflowError(error))),
    Effect.mapError(nativeWorkflowError),
  );

export const runWorkflowAutomation = (config: RuntimeConfig, input: unknown) =>
  runWorkflowAutomationWithCompactCapability(config, input, false);

export const runCompactOriginAuthoringSave = (config: RuntimeConfig, input: unknown) => {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('action' in input) ||
    input.action !== 'authoring' ||
    !('command' in input) ||
    input.command !== 'save' ||
    !('document' in input) ||
    typeof input.document !== 'object' ||
    input.document === null ||
    !('compactOrigin' in input.document)
  )
    return Effect.fail(
      issue('invalid-request', 'The internal compact-origin capability only admits compact plan saves.'),
    );
  return runWorkflowAutomationWithCompactCapability(config, input, true);
};

/** Internal task read: admission and canonical authoring reads share one live journal session. */
export const readNativeTaskInspection = (
  config: RuntimeConfig,
  runId: string,
  generation: string,
  detail: 'summary' | 'packet',
) =>
  withNativeWorkflowLock(
    config,
    runId,
    false,
    runBound(config, {...version, action: 'inspect', runId, generation}, detail),
  ).pipe(
    withNativeFileLockWaitBudget,
    Effect.catchDefect(error => Effect.fail(nativeWorkflowError(error))),
    Effect.mapError(nativeWorkflowError),
  );
