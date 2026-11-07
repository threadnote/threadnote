import {SystemInfo} from '@threadnote/platform/system';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  decodeNativeTaskActionRef,
  encodeNativeTaskActionRef,
  type NativeTaskActionRef,
  type NativeTaskView,
} from '@threadnote/workflow-automations/task';
import {Array as EffectArray, Effect, Option, Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {nativeCycleHasBasePlanTransition} from '@threadnote/workflow-automations/cycle-runtime';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {gitValue} from '../utils.js';
import {verifyNativeCycleBaseRequalification} from './cycle_git.js';
import type {readNativeWorkflowState} from './store.js';

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
