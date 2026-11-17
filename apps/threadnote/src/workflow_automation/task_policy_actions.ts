import {Array as EffectArray, Effect, Option as EffectOption} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {nativeRefusal, nativeTaskViewNext} from '@threadnote/workflow-automations/gates';
import {readNativeWorkflowState} from './store.js';
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
    const waiver = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        current?.state.cycle?.waivers ?? [],
        item =>
          item.gate === request.gate &&
          item.snapshotId === latest.snapshot.snapshotId &&
          item.reason === request.reason &&
          item.userAuthority === request.userAuthority,
      ),
    );
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
