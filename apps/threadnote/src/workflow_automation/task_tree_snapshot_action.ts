import {Array as EffectArray, Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {nativeRefusal, nativeTaskViewNext} from '@threadnote/workflow-automations/gates';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {readNativeWorkflowState} from './store.js';
import {readNativeTaskView} from './task.js';
import {runWorkflowAutomation} from './index.js';
import type {NativeTaskActionRequest} from './task_actions.js';
import {
  cycleRequest,
  fail,
  inCheckout,
  taskActionSnapshotRef,
  type NativeTaskCycleRuntime,
  type NativeTaskStoredState,
} from './task_action_helpers.js';

const recordableActions = new Set([
  'implement',
  'review',
  'validate',
  'resolve-review-failure',
  'expand-review-budget',
]);

/** Standard profile: record the current tree for the phase on the task card, with no packet precondition. */
export const recordNativeTaskTreeSnapshot = (
  config: RuntimeConfig,
  request: Extract<NativeTaskActionRequest, {command: 'record-snapshot'}>,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const view = yield* readNativeTaskView(config, {runId: request.runId, callerCwd: checkout, role: 'implementation'});
    const phaseId = view.next.phaseId;
    if (view.status !== 'ready' || !phaseId || !recordableActions.has(view.next.action))
      return yield* nativeRefusal(
        'task-not-ready',
        EffectArray.join(view.missingInputs, ' ') || 'Follow the current native task action before recording source.',
        {next: nativeTaskViewNext(request.runId, checkout)},
      );
    const before = EffectArray.filter(runtime.snapshots, entry => entry.snapshot.phaseId === phaseId).at(-1);
    yield* inCheckout(
      runWorkflowAutomation(
        config,
        cycleRequest(stored, {
          command: 'snapshot',
          phaseId,
          treeBound: true,
          ...(request.reason === undefined ? {} : {reason: request.reason}),
          expectedRevision: stored.revision,
        }),
      ),
      checkout,
    );
    const latest = (yield* readNativeWorkflowState(config, request.runId))?.state.cycle;
    const recorded = EffectArray.filter(latest?.snapshots ?? [], entry => entry.snapshot.phaseId === phaseId).at(-1);
    const baseline = latest?.baselines[phaseId];
    if (!recorded || !baseline)
      return yield* fail('snapshot-not-recorded', 'The canonical snapshot was not persisted.');
    return {
      status: 'recorded',
      replayed: recorded.snapshot.snapshotId === before?.snapshot.snapshotId,
      snapshot: recorded,
      snapshotRef: taskActionSnapshotRef(
        {
          version: 1,
          kind: 'work',
          runId: request.runId,
          generationHash: sha256HexSync(stored.state.generation),
          phaseId,
          phaseHash: recorded.snapshot.phaseHash,
          baselineHead: baseline.head,
          baselineTree: baseline.tree,
          baselineRef: baseline.pinnedRef,
        },
        recorded,
      ),
    };
  });
