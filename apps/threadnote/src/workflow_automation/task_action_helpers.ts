import {SystemInfo} from '@threadnote/platform/system';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  decodeNativeTaskActionRef,
  encodeNativeTaskActionRef,
  type NativeTaskActionRef,
  type NativeTaskView,
} from '@threadnote/workflow-automations/task';
import {Array as EffectArray, Effect, FileSystem, Path, Option, Predicate, Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {nativeCycleHasBasePlanTransition} from '@threadnote/workflow-automations/cycle-runtime';
import {nativeCycleParentsReady, nextNativeCycle} from '@threadnote/workflow-automations/cycle';
import {hasNativeCycleMergePlanBinding, withNativeCycleSameLabelQualificationBudget} from './cycle_merge.js';
import {boundNativeCycleOutput} from '@threadnote/workflow-automations/cycle-output';
import {nativeCycleQualificationEvidenceDigest} from '@threadnote/workflow-automations/cycle-review';
import {runNativeCycleServerSameLabel} from './cycle.js';
import {runWorkflowAutomation} from './index.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {gitValue} from '../utils.js';
import {verifyNativeCycleBaseRequalification} from './cycle_git.js';
import {readNativeWorkflowState} from './store.js';

export type NativeTaskStoredState = NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>;
export type NativeTaskCycleRuntime = NonNullable<NativeTaskStoredState['state']['cycle']>;
export const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});

export const currentNativeTaskRef = (
  encoded: string | undefined,
  state: NativeTaskStoredState['state'],
  revision: string,
  runId: string,
  action: string,
  view: NativeTaskView,
): NativeTaskActionRef | undefined => {
  const phaseId = view.next.phaseId;
  const snapshotId = view.next.snapshotId;
  const ref = encoded ? decodeNativeTaskActionRef(encoded) : undefined;
  return ref &&
    ref.kind === 'task' &&
    ref.runId === runId &&
    ref.generationHash === sha256HexSync(state.generation) &&
    ref.stateRevision === revision &&
    ref.taskAction === action &&
    view.next.action === action &&
    (phaseId === undefined ||
      (ref.phaseId === phaseId && ref.phaseHash === state.cycle?.state.phases[phaseId]?.phaseHash)) &&
    (snapshotId === undefined || ref.snapshotId === snapshotId)
    ? ref
    : undefined;
};

export const reviewRecoveryDecision = (
  view: NativeTaskView,
  taskRef: string | undefined,
  userAuthority: string | undefined,
  currentRef: (view: NativeTaskView, action: string) => NativeTaskActionRef | undefined,
): 'normal' | 'missing-authority' | 'stale-task-ref' | 'authorized' => {
  if (taskRef === undefined && userAuthority === undefined) return 'normal';
  if (!taskRef || !userAuthority || !EffectString.trim(userAuthority)) return 'missing-authority';
  return currentRef(view, 'resolve-review-failure') ? 'authorized' : 'stale-task-ref';
};

export const reviewReplayAuthorityMatches = (
  priorAuthority: string | undefined,
  taskRef: string | undefined,
  userAuthority: string | undefined,
): boolean => {
  const supplied = taskRef !== undefined || userAuthority !== undefined;
  return (
    !supplied ||
    Boolean(taskRef && userAuthority && EffectString.trim(userAuthority) && priorAuthority === userAuthority)
  );
};

export const snapshotRefMatchesBaseline = (
  ref: NativeTaskActionRef,
  baseline: {readonly head: string; readonly tree: string; readonly pinnedRef: string} | undefined,
): boolean =>
  Boolean(
    baseline &&
    ref.baselineHead === baseline.head &&
    ref.baselineTree === baseline.tree &&
    ref.baselineRef === baseline.pinnedRef,
  );

export const taskActionSnapshotRef = (work: NativeTaskActionRef, entry: unknown): string => {
  if (!Predicate.isObject(entry) || !Predicate.isObject(entry.snapshot))
    throw fail('invalid-state', 'Canonical snapshot evidence is unavailable.');
  const snapshot = entry.snapshot;
  if (typeof snapshot.snapshotId !== 'string' || typeof snapshot.head !== 'string' || typeof snapshot.tree !== 'string')
    throw fail('invalid-state', 'Canonical snapshot identity is incomplete.');
  return encodeNativeTaskActionRef({
    version: 1,
    kind: 'snapshot',
    runId: work.runId,
    generationHash: work.generationHash,
    phaseId: work.phaseId,
    phaseHash: work.phaseHash,
    baselineHead: work.baselineHead,
    baselineTree: work.baselineTree,
    baselineRef: work.baselineRef,
    snapshotId: snapshot.snapshotId,
    sourceHead: snapshot.head,
    sourceTree: snapshot.tree,
  });
};

export const reviewAttemptRef = (ref: NativeTaskActionRef, attemptId: string, payloadDigest: string): string =>
  encodeNativeTaskActionRef({...ref, kind: 'snapshot', attemptId, payloadDigest});

const gitObjectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Resolve only canonical local or remote-tracking branch refs, as cycle merge qualification does. */
export const resolveNativeTaskBaseRef = Effect.fn('workflowAutomation.task.resolveBaseRef')(function* (
  checkout: string,
  baseBranch: string,
) {
  if (
    !baseBranch ||
    baseBranch.length > 256 ||
    EffectArray.some([...baseBranch], character =>
      Option.exists(EffectString.codePointAt(character, 0), code => code < 32 || (code >= 127 && code <= 159)),
    )
  )
    return undefined;
  const ref = yield* gitValue(
    [
      '-c',
      'core.warnAmbiguousRefs=true',
      'rev-parse',
      '--symbolic-full-name',
      '--verify',
      '--end-of-options',
      baseBranch,
    ],
    checkout,
  );
  if (!ref || !/^refs\/(?:heads|remotes)\/[^\s]+$/u.test(ref)) return undefined;
  const commit = yield* gitValue(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], checkout);
  if (!commit || !gitObjectId.test(commit)) return undefined;
  return {ref, commit};
});

export const nativeTaskBindingsCanReconcile = Effect.fn('workflowAutomation.task.validateReconcileBindings')(function* (
  checkout: string,
  phases: readonly {readonly id: string; readonly branch: string; readonly baseBranch: string}[],
  suppliedBindings: Readonly<Record<string, {readonly branch: string; readonly baseBranch: string}>>,
  replay: boolean,
) {
  for (const [phaseId, supplied] of EffectRecord.toEntries(suppliedBindings)) {
    const current = Option.getOrUndefined(EffectArray.findFirst(phases, phase => phase.id === phaseId));
    if (current && (supplied.branch !== current.branch || (replay && supplied.baseBranch !== current.baseBranch)))
      return false;
    if (!current || supplied.baseBranch === current.baseBranch) continue;
    if (!(yield* resolveNativeTaskBaseRef(checkout, supplied.baseBranch))) return false;
  }
  return true;
});

export const inCheckout = <A, E, R>(program: Effect.Effect<A, E, R>, checkout: string) =>
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    return yield* program.pipe(Effect.provideService(SystemInfo, {...system, currentDirectory: () => checkout}));
  });

export const cycleRequest = (
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  request: object,
) => ({
  protocolVersion: 1,
  executorVersion: 1,
  action: 'cycle',
  runId: stored.state.runId,
  generation: stored.state.generation,
  ...request,
});

export const unwrapCycle = (result: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(result) || result.status !== 'ok' || !Predicate.isObject(result.cycle))
    throw fail(
      Predicate.isObject(result) && typeof result.code === 'string' ? result.code : 'task-action-failed',
      Predicate.isObject(result) && Predicate.isObject(result.cycle) && typeof result.cycle.message === 'string'
        ? result.cycle.message
        : 'The native cycle action did not return an admitted result.',
    );
  return result.cycle;
};

export const isCurrentTaskTargetForRequalification = (
  view: {
    readonly status: string;
    readonly next: {readonly action: string; readonly phaseId?: string};
    readonly phase?: {readonly status: string};
  },
  phaseId: string,
) =>
  (view.status === 'ready' && view.next.action === 'implement' && view.next.phaseId === phaseId) ||
  (view.status === 'blocked' &&
    view.next.action === 'blocked' &&
    view.next.phaseId === phaseId &&
    view.phase?.status === 'stale');

export const hasExactAcceptedFullReview = (runtime: NativeTaskCycleRuntime, phaseId: string, snapshotId: string) => {
  const latest = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === phaseId).at(-1);
  const reviews = EffectArray.filter(runtime.reviews, item => item.snapshotId === snapshotId);
  const attempts = EffectArray.filter(
    runtime.attempts,
    attempt =>
      attempt.snapshotId === snapshotId &&
      attempt.status === 'accepted' &&
      attempt.digest === sha256HexSync(stableJson(reviews[0]?.report)),
  );
  return (
    latest?.snapshot.snapshotId === snapshotId &&
    reviews.length === 1 &&
    reviews[0]?.report.mode === 'full' &&
    attempts.length === 1
  );
};

export const hasApprovedBasePlanTransition = (
  runtime: NativeTaskCycleRuntime,
  snapshot: NativeTaskCycleRuntime['snapshots'][number]['snapshot'],
  fromBaseBranch: string,
  toBaseBranch: string,
) => {
  const phaseHash = runtime.state.phases[snapshot.phaseId]?.phaseHash ?? '';
  return nativeCycleHasBasePlanTransition(runtime.plans, snapshot, phaseHash, fromBaseBranch, toBaseBranch);
};

export const verifyRequalificationWitness = (
  checkout: string,
  branchName: string,
  baseBranch: string,
  priorHead: string,
  priorBaseHead: string,
  fromBaseBranch: string,
) =>
  Effect.gen(function* () {
    const head = yield* gitValue(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], checkout);
    const branchValue = yield* gitValue(['branch', '--show-current'], checkout);
    const onto = yield* resolveNativeTaskBaseRef(checkout, baseBranch);
    if (!head || !branchValue || !onto)
      return yield* fail(
        'invalid-base-requalification',
        'The reviewed source, phase branch and new base must resolve to exact commits.',
      );
    const branch = EffectString.trim(branchValue);
    if (branch !== branchName || head === priorHead || onto.commit === priorBaseHead)
      return yield* fail(
        'invalid-base-requalification',
        'The exact current phase branch, rewritten HEAD and changed declared base are required.',
      );
    const witness = {
      preRebaseHead: priorHead,
      ontoHead: onto.commit,
      rebasedHead: EffectString.trim(head),
      fromBaseBranch,
    };
    yield* verifyNativeCycleBaseRequalification(checkout, priorHead, witness.rebasedHead, witness.ontoHead, witness);
    return witness;
  });

export const requalificationSnapshotId = (
  runId: string,
  generationHash: string,
  phaseId: string,
  snapshotId: string,
  reason: string,
  userAuthority: string,
) =>
  `base-requalified-${EffectString.slice(
    0,
    48,
  )(sha256HexSync(stableJson([runId, generationHash, phaseId, snapshotId, reason, userAuthority])))}`;

export const snapshotRef = (work: NonNullable<ReturnType<typeof decodeNativeTaskActionRef>>, entry: unknown) => {
  if (!Predicate.isObject(entry) || !Predicate.isObject(entry.snapshot))
    throw fail('invalid-state', 'Canonical snapshot evidence is unavailable.');
  const snapshot = entry.snapshot;
  if (typeof snapshot.snapshotId !== 'string' || typeof snapshot.head !== 'string' || typeof snapshot.tree !== 'string')
    throw fail('invalid-state', 'Canonical snapshot identity is incomplete.');
  return encodeNativeTaskActionRef({
    version: 1,
    kind: 'snapshot',
    runId: work.runId,
    generationHash: work.generationHash,
    phaseId: work.phaseId,
    phaseHash: work.phaseHash,
    baselineHead: work.baselineHead,
    baselineTree: work.baselineTree,
    baselineRef: work.baselineRef,
    snapshotId: snapshot.snapshotId,
    sourceHead: snapshot.head,
    sourceTree: snapshot.tree,
  });
};

/** The same retained eligibility is used by discovery and locked qualification admission. */
export function selectNativeTaskSameLabelIntegration(runtime: NativeTaskCycleRuntime, phaseId: string) {
  const phases = EffectArray.filter(runtime.state.plan.phases, phase => phase.id === phaseId);
  const phase = phases[0];
  const next = nextNativeCycle(runtime.state);
  if (
    phases.length !== 1 ||
    !phase ||
    !['pending', 'stale'].includes(runtime.state.phases[phaseId]?.status) ||
    !nativeCycleParentsReady(runtime.state, phaseId) ||
    next.phaseId !== phaseId ||
    !['implement', 'blocked'].includes(next.action)
  )
    return undefined;
  const priorEntry = EffectArray.filter(runtime.snapshots, entry => entry.snapshot.phaseId === phaseId).at(-1);
  const baseline = runtime.baselines[phaseId];
  if (!priorEntry || !baseline || !hasNativeCycleMergePlanBinding(runtime.plans, priorEntry.snapshot, phase.baseBranch))
    return undefined;
  const prior = priorEntry.snapshot;
  const reviews = EffectArray.filter(
    runtime.reviews,
    review =>
      review.snapshotId === prior.snapshotId &&
      review.report.snapshotId === prior.snapshotId &&
      review.report.phaseHash === prior.phaseHash &&
      review.report.snapshotTree === prior.tree &&
      review.report.status === 'complete',
  );
  const priorReview = reviews[0];
  if (
    reviews.length !== 1 ||
    !priorReview ||
    EffectArray.filter(
      runtime.attempts,
      attempt =>
        attempt.snapshotId === prior.snapshotId &&
        attempt.status === 'accepted' &&
        attempt.digest === sha256HexSync(stableJson(priorReview.report)),
    ).length !== 1
  )
    return undefined;
  return {phase, priorEntry, priorReview, baseline};
}

export const sameLabelIntegrationSnapshotId = (
  runId: string,
  generationHash: string,
  phaseId: string,
  snapshotId: string,
  reason: string,
  userAuthority: string,
) =>
  `same-label-${EffectString.slice(0, 48)(sha256HexSync(stableJson([runId, generationHash, phaseId, snapshotId, reason, userAuthority])))}`;

export const NativeTaskSameLabelIntegrationSchema = Schema.Struct({
  command: Schema.Literal('integrate-same-label-base-snapshot'),
  runId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)),
  callerCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  snapshotRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  userAuthority: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});

export const runNativeTaskSameLabelIntegration = (
  config: import('@threadnote/workspace/config').RuntimeConfig,
  request: typeof NativeTaskSameLabelIntegrationSchema.Type,
) =>
  withNativeCycleSameLabelQualificationBudget(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (!path.isAbsolute(request.callerCwd))
        return yield* fail('invalid-request', 'callerCwd must be an absolute checkout path.');
      const checkout = yield* fs.realPath(request.callerCwd);
      const stored = yield* readNativeWorkflowState(config, request.runId);
      if (!stored?.state.cycle) return yield* fail('cycle-not-found', 'This run has no admitted native cycle.');
      const ref = decodeNativeTaskActionRef(request.snapshotRef);
      const generationHash = sha256HexSync(stored.state.generation);
      const matches = (runtime: NativeTaskCycleRuntime) => {
        if (
          !ref ||
          ref.kind !== 'snapshot' ||
          ref.runId !== request.runId ||
          ref.generationHash !== generationHash ||
          !ref.phaseId ||
          !ref.phaseHash ||
          !ref.snapshotId ||
          !ref.sourceHead ||
          !ref.sourceTree ||
          !ref.baselineHead ||
          !ref.baselineTree ||
          !ref.baselineRef
        )
          return undefined;
        const entries = EffectArray.filter(runtime.snapshots, item => item.snapshot.snapshotId === ref.snapshotId);
        const entry = entries[0],
          baseline = runtime.baselines[ref.phaseId];
        if (
          entries.length !== 1 ||
          !entry ||
          !baseline ||
          entry.snapshot.phaseId !== ref.phaseId ||
          entry.snapshot.phaseHash !== ref.phaseHash ||
          entry.snapshot.head !== ref.sourceHead ||
          entry.snapshot.tree !== ref.sourceTree ||
          baseline.head !== ref.baselineHead ||
          baseline.tree !== ref.baselineTree ||
          baseline.pinnedRef !== ref.baselineRef
        )
          return undefined;
        return {ref, entry, baseline};
      };
      const retained = matches(stored.state.cycle);
      if (!retained || !EffectString.trim(request.reason) || !EffectString.trim(request.userAuthority))
        return yield* fail(
          'stale-snapshot-ref',
          'Select the retained reviewed predecessor and explicit same-label integration authority.',
        );
      const {entry, baseline} = retained;
      const phaseId = entry.snapshot.phaseId;
      const id = sameLabelIntegrationSnapshotId(
        request.runId,
        generationHash,
        phaseId,
        entry.snapshot.snapshotId,
        request.reason,
        request.userAuthority,
      );
      const existing = Option.getOrUndefined(
        EffectArray.findFirst(stored.state.cycle.snapshots, item => item.snapshot.snapshotId === id),
      );
      if (existing) {
        const receipt = existing.snapshot.sameLabelRebasedBaseIntegrationV1;
        if (
          !receipt ||
          receipt.priorSnapshotId !== entry.snapshot.snapshotId ||
          receipt.reason !== request.reason ||
          receipt.authority !== request.userAuthority
        )
          return yield* fail(
            'snapshot-conflict',
            'The integration identity already belongs to different immutable evidence.',
          );
        unwrapCycle(
          yield* inCheckout(
            runWorkflowAutomation(
              config,
              cycleRequest(stored, {
                protocolVersion: 3,
                command: 'snapshot',
                phaseId,
                snapshotId: id,
                previous: entry.snapshot.snapshotId,
                acceptedHead: existing.snapshot.head,
                reason: request.reason,
                userAuthority: request.userAuthority,
                expectedRevision: stored.revision,
                sameLabelRebasedBaseIntegrationV1: {
                  priorSnapshotId: receipt.priorSnapshotId,
                  expectedPriorEntryDigest: receipt.expectedPriorEntryDigest,
                  expectedPriorReviewDigest: receipt.expectedPriorReviewDigest,
                  currentBaseHead: receipt.currentBaseHead,
                  currentHead: receipt.currentHead,
                  sameBaseBranch: receipt.sameBaseBranch,
                  authorityKind: receipt.authorityKind,
                  planDocumentHash: receipt.planDocumentHash,
                  phaseOwnedPaths: receipt.phaseOwnedPaths,
                },
              }),
            ),
            checkout,
          ),
        );
      } else {
        yield* inCheckout(
          runNativeCycleServerSameLabel(
            config,
            {
              runId: request.runId,
              generation: stored.state.generation,
              expectedRevision: stored.revision,
              phaseId,
              snapshotId: id,
              previous: entry.snapshot.snapshotId,
              reason: request.reason,
              userAuthority: request.userAuthority,
            },
            source => {
              const selected = selectNativeTaskSameLabelIntegration(source.runtime, phaseId);
              if (
                !matches(source.runtime) ||
                !selected ||
                selected.priorEntry.snapshot.snapshotId !== entry.snapshot.snapshotId
              )
                throw fail(
                  'review-history',
                  'Retain the latest eligible completed predecessor review without an unreviewed tail.',
                );
              return {
                priorSnapshotId: selected.priorEntry.snapshot.snapshotId,
                expectedPriorEntryDigest: nativeCycleQualificationEvidenceDigest(
                  'predecessor-entry',
                  selected.priorEntry,
                ),
                expectedPriorReviewDigest: nativeCycleQualificationEvidenceDigest(
                  'predecessor-review',
                  selected.priorReview,
                ),
                currentBaseHead: source.currentBaseHead,
                currentHead: source.currentHead,
                sameBaseBranch: selected.phase.baseBranch,
                authorityKind: 'same-label-upstream-rebase-integration',
                planDocumentHash: source.plan.source.documentHash,
                phaseOwnedPaths: EffectArray.filter(
                  EffectArray.map(source.plan.phases, phase => ({
                    phaseId: phase.id,
                    paths: EffectArray.filter(source.changedPaths, path => phase.allowedPaths.includes(path)),
                  })),
                  owner => owner.paths.length > 0,
                ).sort((a, b) => (a.phaseId < b.phaseId ? -1 : a.phaseId > b.phaseId ? 1 : 0)),
              };
            },
            input => runWorkflowAutomation(config, input),
            input => runWorkflowAutomation(config, input),
          ),
          checkout,
        );
      }
      const latest = yield* readNativeWorkflowState(config, request.runId);
      const admitted = Option.getOrUndefined(
        EffectArray.findFirst(latest?.state.cycle?.snapshots ?? [], item => item.snapshot.snapshotId === id),
      );
      if (!admitted) return yield* fail('snapshot-not-recorded', 'The canonical qualified snapshot was not persisted.');
      return boundNativeCycleOutput({
        status: 'recorded',
        replayed: !!existing,
        snapshot: {
          version: admitted.snapshot.version,
          snapshotId: id,
          phaseId,
          phaseHash: admitted.snapshot.phaseHash,
          head: admitted.snapshot.head,
          tree: admitted.snapshot.tree,
          counts: {
            files: admitted.snapshot.files.length,
            scopeFiles: admitted.snapshot.scopeFiles.length,
            reconciliationPaths: admitted.snapshot.sameLabelRebasedBaseIntegrationV1!.reconciliationPaths.length,
          },
        },
        next: {action: 'review', phaseId, snapshotId: id, reviewMode: 'full'},
        detail: {command: 'detail', snapshotId: id, detailKind: 'manifest'},
        requiredReviewMode: 'full',
        snapshotRef: snapshotRef(
          {
            version: 1,
            kind: 'snapshot',
            runId: request.runId,
            generationHash,
            phaseId,
            phaseHash: admitted.snapshot.phaseHash,
            baselineHead: baseline.head,
            baselineTree: baseline.tree,
            baselineRef: baseline.pinnedRef,
          },
          admitted,
        ),
      });
    }),
  );
