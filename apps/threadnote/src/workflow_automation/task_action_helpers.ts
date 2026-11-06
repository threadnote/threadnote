import {SystemInfo} from '@threadnote/platform/system';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {Array as EffectArray, Effect, Predicate} from 'effect';
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
    const ontoHead = yield* gitValue(
      ['rev-parse', '--verify', '--end-of-options', `refs/heads/${baseBranch}^{commit}`],
      checkout,
    );
    if (!head || !branchValue || !ontoHead)
      return yield* fail(
        'invalid-base-requalification',
        'The reviewed source, phase branch and new base must resolve to exact commits.',
      );
    const branch = EffectString.trim(branchValue);
    if (branch !== branchName || head === priorHead || ontoHead === priorBaseHead)
      return yield* fail(
        'invalid-base-requalification',
        'The exact current phase branch, rewritten HEAD and changed declared base are required.',
      );
    const witness = {
      preRebaseHead: priorHead,
      ontoHead: EffectString.trim(ontoHead),
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
