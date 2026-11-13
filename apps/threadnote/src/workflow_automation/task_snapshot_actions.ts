import {Array as EffectArray, Option as EffectOption, Effect, String as EffectString} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {decodeNativeTaskActionRef, nativeTaskSnapshotId} from '@threadnote/workflow-automations/task';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {gitValue} from '../utils.js';
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
        state.phases[ref.phaseId]?.phaseHash !== ref.phaseHash ||
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
      if (
        currentTask.revision !== stored.revision ||
        currentTask.status !== 'ready' ||
        currentTask.next.action !== 'review' ||
        currentTask.next.phaseId !== ref.phaseId ||
        (currentTask.next.snapshotId !== ref.snapshotId &&
          !(exactReplay && currentTask.next.snapshotId === snapshotId)) ||
        currentTask.phase?.snapshot?.snapshotId !== currentTask.next.snapshotId
      )
        return yield* fail(
          'stale-snapshot-ref',
          'Recovery requires the exact unreviewed snapshot on the current phase review card.',
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
    yield* inCheckout(
      runWorkflowAutomation(
        config,
        cycleRequest(stored, {
          command: 'snapshot',
          phaseId: ref.phaseId,
          snapshotId,
          acceptedHead: head,
          ...(previous ? {previous: previous.snapshotId} : {}),
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
