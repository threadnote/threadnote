import {Array as EffectArray, Effect, String as EffectString} from 'effect';
import {nativeCycleWaiverFor} from '@threadnote/workflow-automations/cycle-runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  nativeControlNext,
  nativeRefusal,
  nativeTaskViewNext,
  nativeWorkflowPolicyOf,
} from '@threadnote/workflow-automations/gates';
import {readNativeWorkflowState, withNativeWorkflowLock, writeNativeWorkflowState} from './store.js';
import {readNativeTaskView} from './task.js';
import {runWorkflowAutomation} from './index.js';
import type {NativeTaskActionRequest} from './task_actions.js';
import {
  cycleRequest,
  fail,
  inCheckout,
  type NativeTaskCycleRuntime,
  type NativeTaskStoredState,
} from './task_action_helpers.js';

/** Record an audited waiver of one gate for the latest snapshot of the phase on the current task card. */
export const runNativeTaskWaiver = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'waive'}>,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const view = yield* readNativeTaskView(config, {runId: request.runId, callerCwd: checkout});
    const phaseId = view.next.phaseId;
    const latest = phaseId
      ? EffectArray.filter(runtime.snapshots, entry => entry.snapshot.phaseId === phaseId).at(-1)
      : undefined;
    if (!phaseId || !latest)
      return yield* nativeRefusal(
        'waiver-target-missing',
        'A waiver covers the recorded snapshot of the current phase.',
        {
          next: nativeTaskViewNext(request.runId, checkout),
        },
      );
    yield* inCheckout(
      runWorkflowAutomation(
        config,
        cycleRequest(stored, {
          command: 'waive',
          phaseId,
          snapshotId: latest.snapshot.snapshotId,
          gate: request.gate,
          reason: request.reason,
          userAuthority: request.userAuthority,
          expectedRevision: stored.revision,
        }),
      ),
      checkout,
    );
    const current = yield* readNativeWorkflowState(config, request.runId);
    const waiver = current?.state.cycle
      ? nativeCycleWaiverFor(current.state.cycle, request.gate, latest.snapshot)
      : undefined;
    if (!waiver || !current) return yield* fail('waiver-not-recorded', 'The canonical waiver was not persisted.');
    return {
      status: 'waived',
      replayed: current.revision === stored.revision,
      revision: current.revision,
      waiver,
    };
  });

/** Delivery and closeout results list every audited waiver of the run. */
export const withNativeTaskWaivers = <A extends object>(result: A, runtime: NativeTaskCycleRuntime) =>
  runtime.waivers?.length ? {...result, waivers: runtime.waivers} : result;

/**
 * Switch a run between the standard and strict profiles. Loosening to standard needs explicit caller authority;
 * tightening to strict needs only a reason. The same profile replays without a write.
 */
export const runNativeTaskSetProfile = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'set-profile'}>,
  stored: NativeTaskStoredState,
  checkout: string,
) =>
  Effect.gen(function* () {
    const current = nativeWorkflowPolicyOf(stored.state);
    if (current === request.profile)
      return {status: 'unchanged', profile: current, revision: stored.revision, policy: stored.state.policy};
    if (request.profile === 'standard' && !EffectString.trim(request.userAuthority ?? ''))
      return yield* nativeRefusal(
        'profile-authority-required',
        'Loosening a run to the standard profile needs the user’s explicit authority statement.',
        {
          next: nativeControlNext(
            {runId: request.runId, callerCwd: checkout},
            'set-profile',
            {profile: request.profile, reason: request.reason, userAuthority: '<userAuthority>'},
            false,
          ),
        },
      );
    const policy = {
      mode: request.profile,
      reason: request.reason,
      ...(request.userAuthority === undefined ? {} : {userAuthority: request.userAuthority}),
    };
    const written = yield* withNativeWorkflowLock(
      config,
      request.runId,
      false,
      Effect.gen(function* () {
        const latest = yield* readNativeWorkflowState(config, request.runId);
        if (!latest || latest.revision !== stored.revision)
          return yield* nativeRefusal('state-conflict', 'The run changed while switching its profile; retry.', {
            next: nativeTaskViewNext(request.runId, checkout),
          });
        return yield* writeNativeWorkflowState(config, {...latest.state, policy}, latest.revision);
      }),
    );
    return {status: 'changed', profile: request.profile, from: current, revision: written.revision, policy};
  });
