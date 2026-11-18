import {Array as EffectArray, Option as EffectOption, Effect, String as EffectString} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {decodeNativeTaskActionRef, nativeTaskSnapshotId} from '@threadnote/workflow-automations/task';
import {
  nativeNext,
  nativeNextCommand,
  nativeRefusal,
  nativeWorkflowPolicyOf,
} from '@threadnote/workflow-automations/gates';
import {recordNativeTaskTreeSnapshot} from './task_tree_snapshot_action.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {gitValue} from '../utils.js';
import {captureNativeCycleSource} from './cycle_git.js';
import {readNativeWorkflowState} from './store.js';
import {readNativeTaskView} from './task.js';
import {runWorkflowAutomation} from './index.js';
import type {NativeTaskActionRequest} from './task_actions.js';
import {
  cycleRequest,
  fail,
  inCheckout,
  taskActionSnapshotRef,
  type NativeTaskStoredState,
  type NativeTaskCycleRuntime,
} from './task_action_helpers.js';

export const runNativeTaskSnapshotAction = (
  config: RuntimeConfig,
  request: Extract<
    NativeTaskActionRequest,
    {command: 'record-snapshot' | 'supersede-unreviewed-snapshot' | 'recover-unreviewed-rebase-snapshot'}
  >,
  stored: NativeTaskStoredState,
  checkout: string,
  runtime: NativeTaskCycleRuntime,
) =>
  Effect.gen(function* () {
    const state = runtime.state;
    const readCanonicalSnapshot = (snapshotId: string) =>
      Effect.gen(function* () {
        const latest = yield* readNativeWorkflowState(config, request.runId);
        const entry = EffectArray.findFirst(
          latest?.state.cycle?.snapshots ?? [],
          item => item.snapshot.snapshotId === snapshotId,
        );
        if (entry._tag === 'None')
          return yield* fail('snapshot-not-recorded', 'The canonical snapshot was not persisted.');
        return entry.value;
      });
    if (
      request.command === 'supersede-unreviewed-snapshot' ||
      request.command === 'recover-unreviewed-rebase-snapshot'
    ) {
      const recovery = request.command === 'recover-unreviewed-rebase-snapshot';
      const ref = decodeNativeTaskActionRef(request.snapshotRef);
      if (
        !ref ||
        ref.kind !== 'snapshot' ||
        ref.runId !== request.runId ||
        ref.generationHash !== sha256HexSync(stored.state.generation) ||
        !ref.phaseId ||
        !ref.phaseHash ||
        !ref.snapshotId ||
        !ref.sourceHead ||
        !ref.sourceTree ||
        !ref.baselineHead ||
        !ref.baselineTree ||
        !ref.baselineRef
      )
        return yield* fail('invalid-snapshot-ref', 'Use the exact reference for the unreviewed snapshot to supersede.');
      const entry = EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === ref.snapshotId),
      );
      if (state.plan.delivery !== 'local' && state.plan.delivery !== 'commit' && state.plan.delivery !== 'pr')
        return yield* fail('task-scope', 'Snapshot recovery supports approved local, commit, or PR delivery plans.');
      const authority = recovery ? request.userAuthority : undefined;
      if (recovery && !EffectString.trim(authority ?? ''))
        return yield* fail('invalid-rebase-recovery', 'Provide explicit caller-provided userAuthority.');
      const snapshotId = recovery
        ? `recovered-${sha256HexSync(stableJson([request.runId, ref.generationHash, ref.snapshotId, request.reason, authority]))}`
        : `superseded-${sha256HexSync(stableJson([ref.snapshotId, request.reason]))}`;
      const alreadyAdmitted = EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === snapshotId);
      const exactReplay =
        alreadyAdmitted._tag === 'Some' &&
        alreadyAdmitted.value.snapshot.supersedes === ref.snapshotId &&
        alreadyAdmitted.value.snapshot.unreviewedSupersession?.reason === request.reason &&
        !!alreadyAdmitted.value.snapshot.unreviewedSupersession?.rebaseRecovery === recovery &&
        (!recovery || alreadyAdmitted.value.snapshot.unreviewedSupersession?.rebaseRecovery?.authority === authority);
      const baseline = runtime.baselines[ref.phaseId];
      const latest = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === ref.phaseId).at(-1);
      if (
        !entry ||
        entry.snapshot.phaseId !== ref.phaseId ||
        entry.snapshot.phaseHash !== ref.phaseHash ||
        entry.snapshot.head !== ref.sourceHead ||
        entry.snapshot.tree !== ref.sourceTree ||
        !baseline ||
        baseline.head !== ref.baselineHead ||
        baseline.tree !== ref.baselineTree ||
        baseline.pinnedRef !== ref.baselineRef ||
        state.phases[ref.phaseId]?.status !== 'pending' ||
        (latest?.snapshot.snapshotId !== ref.snapshotId && !exactReplay)
      )
        return yield* fail('stale-snapshot-ref', 'The exact snapshot is no longer the current phase predecessor.');
      if (EffectArray.some(runtime.reviews, item => item.snapshotId === ref.snapshotId))
        return yield* fail('review-history', 'Only an unreviewed snapshot can use supersession recovery.');
      const currentTask = yield* readNativeTaskView(config, {
        runId: request.runId,
        callerCwd: checkout,
        role: 'review',
      });
      const next = currentTask.next;
      const staleContract = state.phases[ref.phaseId]?.phaseHash !== ref.phaseHash && !exactReplay;
      if (
        currentTask.revision !== stored.revision ||
        currentTask.status !== 'ready' ||
        next.phaseId !== ref.phaseId ||
        (staleContract
          ? next.action !== 'implement'
          : next.action !== 'review' ||
            (next.snapshotId !== ref.snapshotId && !(exactReplay && next.snapshotId === snapshotId)) ||
            currentTask.phase?.snapshot?.snapshotId !== next.snapshotId)
      )
        return yield* fail(
          'stale-snapshot-ref',
          'Recovery requires the exact unreviewed snapshot on the current phase card.',
        );
      const head = yield* gitValue(['rev-parse', 'HEAD'], checkout);
      if (!head) return yield* fail('source-unavailable', 'Could not read the current source head.');
      yield* inCheckout(
        runWorkflowAutomation(
          config,
          cycleRequest(stored, {
            command: 'snapshot',
            phaseId: ref.phaseId,
            snapshotId,
            previous: ref.snapshotId,
            supersedeUnreviewed: true,
            ...(recovery ? {recoverUnreviewedRebase: true, userAuthority: authority} : {}),
            acceptedHead: head,
            reason: request.reason,
            expectedRevision: stored.revision,
          }),
        ),
        checkout,
      );
      const canonical = yield* readCanonicalSnapshot(snapshotId);
      return {
        status: 'recorded',
        replayed: alreadyAdmitted._tag === 'Some',
        snapshot: canonical,
        snapshotRef: taskActionSnapshotRef(ref, canonical),
      };
    }

    if (nativeWorkflowPolicyOf(stored.state) === 'standard')
      return yield* recordNativeTaskTreeSnapshot(config, request, stored, checkout, runtime);
    if (request.workRef === undefined)
      return yield* nativeRefusal(
        'invalid-work-ref',
        'A strict-profile snapshot records the source of an admitted work packet; prepare one first.',
        {
          next: nativeNext.work({runId: request.runId, callerCwd: checkout}),
        },
      );
    const ref = decodeNativeTaskActionRef(request.workRef);
    if (
      !ref ||
      ref.kind !== 'work' ||
      ref.runId !== request.runId ||
      ref.generationHash !== sha256HexSync(stored.state.generation) ||
      !ref.phaseId ||
      !ref.phaseHash ||
      !ref.baselineHead ||
      !ref.baselineTree ||
      !ref.baselineRef
    )
      return yield* fail('invalid-work-ref', 'Restart with the current implementation packet for this run.');
    const snapshotId = nativeTaskSnapshotId(request.workRef);
    const admitted = EffectOption.getOrUndefined(
      EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === snapshotId),
    );
    if (admitted) {
      if (admitted.snapshot.phaseId !== ref.phaseId || admitted.snapshot.phaseHash !== ref.phaseHash)
        return yield* fail(
          'snapshot-conflict',
          'This task reference is already bound to different canonical snapshot evidence.',
        );
      // One work packet records one snapshot, so a replay is only truthful for that snapshot's exact source.
      const current = yield* captureNativeCycleSource(checkout, admitted.snapshot.baseTree);
      if (current.tree !== admitted.snapshot.tree) {
        const latest = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === ref.phaseId).at(-1);
        const supersedable =
          latest?.snapshot.snapshotId === snapshotId &&
          !EffectArray.some(runtime.reviews, item => item.snapshotId === snapshotId);
        const scope = {runId: request.runId, callerCwd: checkout};
        return yield* nativeRefusal(
          'source-drift',
          `Source changed after this work packet recorded snapshot ${snapshotId}: snapshot tree ${admitted.snapshot.tree}, current tree ${current.tree}. ` +
            (supersedable
              ? 'Supersede it with supersede-unreviewed-snapshot, using its snapshotRef from the task view and a concrete reason.'
              : 'Prepare a new work packet with task-action work, then record it with a concrete reason.'),
          {
            next: supersedable
              ? nativeNextCommand(
                  'workflow_task_snapshot',
                  'supersede-unreviewed',
                  {
                    command: 'task-action supersede-unreviewed-snapshot',
                    flags: {...scope, snapshotRef: '<snapshotRef>', reason: '<reason>'},
                  },
                  {
                    ...scope,
                    snapshot: {command: 'supersede-unreviewed', snapshotRef: '<snapshotRef>', reason: '<reason>'},
                  },
                )
              : nativeNext.work(scope),
          },
        );
      }
      return {
        status: 'recorded',
        replayed: true,
        snapshot: admitted,
        snapshotRef: taskActionSnapshotRef(ref, admitted),
      };
    }
    const baseline = runtime.baselines[ref.phaseId];
    if (
      !baseline ||
      baseline.head !== ref.baselineHead ||
      baseline.tree !== ref.baselineTree ||
      baseline.pinnedRef !== ref.baselineRef ||
      state.phases[ref.phaseId]?.phaseHash !== ref.phaseHash ||
      stored.revision !== ref.stateRevision
    )
      return yield* fail('stale-work-ref', 'This packet is no longer admitted. Restart with the current task view.');
    const view = yield* readNativeTaskView(config, {
      runId: request.runId,
      callerCwd: checkout,
      role: 'implementation',
    });
    if (
      view.status !== 'ready' ||
      !['implement', 'validate'].includes(view.next.action) ||
      view.next.phaseId !== ref.phaseId
    )
      return yield* fail(
        'task-not-ready',
        EffectArray.join(view.missingInputs, ' ') || 'Follow the current native task action.',
      );
    const head = yield* gitValue(['rev-parse', 'HEAD'], checkout);
    if (!head) return yield* fail('source-unavailable', 'Could not read the current source head.');
    const previous = EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === ref.phaseId).at(
      -1,
    )?.snapshot;
    if (previous && !request.reason)
      return yield* fail('review-history', 'Give a concrete reason before recording another source iteration.');
    const supersedeStale =
      previous !== undefined &&
      previous.phaseHash !== ref.phaseHash &&
      !EffectArray.some(runtime.reviews, item => item.snapshotId === previous.snapshotId);
    yield* inCheckout(
      runWorkflowAutomation(
        config,
        cycleRequest(stored, {
          command: 'snapshot',
          phaseId: ref.phaseId,
          snapshotId,
          acceptedHead: head,
          ...(previous ? {previous: previous.snapshotId} : {}),
          ...(supersedeStale ? {supersedeUnreviewed: true} : {}),
          reason: request.reason ?? 'Record the exact worker source result for this implementation packet.',
          expectedRevision: stored.revision,
        }),
      ),
      checkout,
    );
    const canonical = yield* readCanonicalSnapshot(snapshotId);
    return {
      status: 'recorded',
      replayed: false,
      snapshot: canonical,
      snapshotRef: taskActionSnapshotRef(ref, canonical),
    };
  });
