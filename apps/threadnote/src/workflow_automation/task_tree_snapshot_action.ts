import {Array as EffectArray, Effect} from 'effect';
import * as EffectString from 'effect/String';
import {runCommandEffect} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {nativeNext, nativeNextForTaskAction, nativeRefusal} from '@threadnote/workflow-automations/gates';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {readNativeWorkflowState} from './store.js';
import {readNativeTaskView} from './task.js';
import {runWorkflowAutomation} from './index.js';
import type {NativeTaskActionRequest} from './task_actions.js';
import {
  cycleRequest,
  fail,
  inCheckout,
  nativeTaskSnapshotSummary,
  taskActionSnapshotRef,
  type NativeTaskCycleRuntime,
  type NativeTaskStoredState,
} from './task_action_helpers.js';

const outOfPlanPreviewLimit = 20;
const recordableActions = new Set(['implement', 'review', 'validate']);
// A new tree replaces the blocked review target. The per-phase review budget still counts every accepted review.
const reviewRecoveryActions = new Set(['resolve-review-failure', 'expand-review-budget']);

const cleanHeadTree = (checkout: string) =>
  Effect.gen(function* () {
    const git = (args: readonly string[]) =>
      runCommandEffect('git', ['--no-optional-locks', '-C', checkout, ...args], {
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
      });
    const status = yield* git(['status', '--porcelain', '--untracked-files=all']);
    if (status.exitCode !== 0 || EffectString.trim(status.stdout)) return undefined;
    const tree = yield* git(['rev-parse', '--verify', 'HEAD^{tree}']);
    return tree.exitCode === 0 ? EffectString.trim(tree.stdout) : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));

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
    const scope = {runId: request.runId, callerCwd: checkout};
    if (view.next.action === 'deliver' && phaseId) {
      // Committing a tree that was validated dirty changes HEAD only, so the validated snapshot still applies.
      const validatedTree = runtime.state.phases[phaseId]?.tree;
      if (validatedTree && (yield* cleanHeadTree(checkout)) === validatedTree)
        return {
          status: 'unchanged',
          replayed: true,
          phaseId,
          tree: validatedTree,
          note: `Phase ${phaseId} is validated for this exact tree. Deliver it; no new snapshot is needed.`,
          next: nativeNext.deliver(scope, view.delivery),
        };
      return yield* nativeRefusal(
        'task-not-ready',
        `Phase ${phaseId} is validated and waits for delivery; reopen it to record a changed tree.`,
        {next: nativeNext.reopen(scope, phaseId)},
      );
    }
    const recordable =
      reviewRecoveryActions.has(view.next.action) ||
      (view.status === 'ready' && recordableActions.has(view.next.action));
    if (!phaseId || !recordable)
      return yield* nativeRefusal(
        'task-not-ready',
        `The current task card asks for ${view.next.action}, not a new source snapshot.`,
        {next: nativeNextForTaskAction(view.next.action, request.runId, checkout, view.delivery)},
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
    const outOfPlan = recorded.snapshot.outOfPlan ?? [];
    const more = outOfPlan.length - outOfPlanPreviewLimit;
    // The canonical snapshot keeps every path; the response names the first paths and counts the rest.
    const detail = {files: outOfPlan.slice(0, outOfPlanPreviewLimit), ...(more > 0 ? {more} : {})};
    // A diverged local base keeps its own commit, so the snapshot can include upstream-only changes.
    const comparison = recorded.snapshot.comparisonEvidence;
    return {
      status: 'recorded',
      replayed: recorded.snapshot.snapshotId === before?.snapshot.snapshotId,
      ...(outOfPlan.length > 0
        ? {warnings: [{_tag: 'warn' as const, gate: 'scope.out-of-plan' as const, detail}]}
        : {}),
      ...(comparison?.divergedUpstream
        ? {
            note: `The local branch ${comparison.baseBranch} has diverged from ${comparison.divergedUpstream}. The snapshot compares against the local branch.`,
          }
        : {}),
      snapshot: nativeTaskSnapshotSummary(recorded),
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
