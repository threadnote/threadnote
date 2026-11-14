import {Array as EffectArray, Option as EffectOption, Effect, FileSystem, Schema, String as EffectString} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  appendNativeCycleInvalidTailRequalification,
  nativeCycleInvalidTailBasis,
} from '@threadnote/workflow-automations/cycle-runtime';
import {
  nativeCycleInvalidTailMergeReceiptDigest,
  type NativeCycleSnapshot,
} from '@threadnote/workflow-automations/cycle-review';
import {
  decodeNativeTaskActionRef,
  encodeNativeTaskActionRef,
  nativeTaskCardRef,
} from '@threadnote/workflow-automations/task';
import {stableJson} from '../workflow_memory/protocol.js';
import {captureNativeCycleSource} from './cycle_git.js';
import {readNativeTaskView} from './task.js';
import {
  persistNativeCycleOrdinaryMerge,
  prepareNativeCycleInvalidTailMerge,
  verifyNativeCycleInvalidTailMergeSource,
} from './cycle_merge.js';
import {readNativeWorkflowState, prepareNativeWorkflowStateWrite, withNativeWorkflowLock} from './store.js';

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const requestSchema = Schema.Struct({
  runId: text,
  callerCwd: text,
  taskRef: text,
  predecessorRef: text,
  reason: text,
  userAuthority: text,
  phaseOwnedPaths: Schema.Array(
    Schema.Struct({phaseId: text, paths: Schema.Array(text).check(Schema.isBetweenLength(1, 256))}),
  ).check(Schema.isBetweenLength(1, 128)),
});
const fail = (message: string) => WorkflowAutomationError.make({code: 'invalid-tail-requalification', message});
const git = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {timeoutMs: 30_000, maxOutputBytes: 4096}).pipe(
    Effect.map(result => EffectString.trim(result.stdout)),
  );

/** Records caller-prepared normal-merge source under current opaque authority and state CAS. */
export const requalifyInvalidNativeTaskTail = (config: RuntimeConfig, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(requestSchema, {onExcessProperty: 'error'})(input).pipe(
      Effect.mapError(() =>
        fail('Supply current task/predecessor refs, complete path owners, reason and actual user authority.'),
      ),
    );
    if (!EffectString.trim(request.reason) || !EffectString.trim(request.userAuthority))
      return yield* fail('Reason and supplied user authority must be nonempty.');
    const ref = decodeNativeTaskActionRef(request.predecessorRef);
    const taskRef = decodeNativeTaskActionRef(request.taskRef);
    if (
      !ref ||
      ref.kind !== 'snapshot' ||
      ref.runId !== request.runId ||
      !ref.phaseId ||
      !ref.snapshotId ||
      !ref.stateRevision ||
      !taskRef ||
      taskRef.kind !== 'task' ||
      taskRef.taskAction !== 'requalify-invalid-tail' ||
      taskRef.stateRevision !== ref.stateRevision
    )
      return yield* fail('Use the current invalid-tail task and snapshot references.');
    const view = yield* readNativeTaskView(config, {runId: request.runId, callerCwd: request.callerCwd});
    return yield* withNativeWorkflowLock(
      config,
      request.runId,
      false,
      Effect.gen(function* () {
        const stored = yield* readNativeWorkflowState(config, request.runId);
        const runtime = stored?.state.cycle;
        if (!stored || !runtime) return yield* fail('The referenced cycle is missing.');
        const phaseId = ref.phaseId!;
        const phase = EffectOption.getOrUndefined(
          EffectArray.findFirst(runtime.state.plan.phases, item => item.id === phaseId),
        );
        const baseline = runtime.baselines[phaseId];
        const leaf = EffectOption.getOrUndefined(
          EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === ref.snapshotId),
        )?.snapshot;
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.realPath(request.callerCwd);
        const reportedCheckout = yield* fs.realPath(yield* git(checkout, ['rev-parse', '--show-toplevel']));
        if (
          !phase ||
          !baseline ||
          !leaf ||
          checkout !== baseline.repo ||
          leaf.repo !== checkout ||
          reportedCheckout !== checkout ||
          ref.generationHash !== sha256HexSync(stored.state.generation) ||
          ref.phaseHash !== leaf.phaseHash ||
          leaf.phaseId !== phaseId ||
          leaf.head !== ref.sourceHead ||
          leaf.tree !== ref.sourceTree ||
          baseline.head !== ref.baselineHead ||
          baseline.tree !== ref.baselineTree ||
          baseline.pinnedRef !== ref.baselineRef
        )
          return yield* fail(
            'References must bind this exact run, generation, checkout, phase, baseline and invalid source.',
          );
        const liveBaseHead = yield* git(checkout, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          phase.baseBranch + '^{commit}',
        ]);
        const captured = yield* captureNativeCycleSource(checkout, baseline.tree);
        const operationDigest = sha256HexSync(
          stableJson([
            request.taskRef,
            request.predecessorRef,
            request.reason,
            request.userAuthority,
            request.phaseOwnedPaths,
            captured.head,
            captured.tree,
            liveBaseHead,
          ]),
        );
        const snapshotId = `invalid-tail-${operationDigest}`;
        const existing = EffectOption.getOrUndefined(
          EffectArray.findFirst(runtime.snapshots, entry => entry.snapshot.snapshotId === snapshotId),
        );
        const result = (entry: NonNullable<typeof existing>, revision: string, replayed: boolean) => ({
          status: 'recorded' as const,
          replayed,
          revision,
          snapshot: entry,
          snapshotRef: encodeNativeTaskActionRef({
            ...ref,
            stateRevision: revision,
            snapshotId: entry.snapshot.snapshotId,
            sourceHead: entry.snapshot.head,
            sourceTree: entry.snapshot.tree,
          }),
        });
        if (existing) {
          const proof = existing.snapshot.invalidTailMergeQualificationV1;
          if (
            !proof ||
            proof.operationDigest !== operationDigest ||
            proof.taskRefDigest !== sha256HexSync(request.taskRef) ||
            proof.predecessorRefDigest !== sha256HexSync(request.predecessorRef)
          )
            return yield* fail('Replay evidence conflicts.');
          yield* verifyNativeCycleInvalidTailMergeSource(checkout, existing.snapshot, baseline, phase);
          return result(existing, stored.revision, true);
        }
        if (
          view.revision !== stored.revision ||
          view.invalidTailRequalification?.taskRef !== request.taskRef ||
          view.invalidTailRequalification.predecessorRef !== request.predecessorRef
        )
          return yield* fail(
            'Use the currently eligible invalid-tail task route after resolving plan or authoring drift.',
          );
        const selected = nativeCycleInvalidTailBasis(runtime, phaseId);
        if (
          !selected ||
          selected.leaf.snapshotId !== leaf.snapshotId ||
          stored.revision !== ref.stateRevision ||
          liveBaseHead === leaf.declaredBaseHead ||
          request.taskRef !==
            nativeTaskCardRef(
              stored.state,
              stored.revision,
              'requalify-invalid-tail',
              phaseId,
              leaf.snapshotId,
              sha256HexSync(stableJson([leaf.snapshotId, selected.basis.snapshot.snapshotId, liveBaseHead])),
            )
        )
          return yield* fail(
            'Refresh the task card for the current invalid-only leaf, accepted ledger and advanced live base.',
          );
        const merge = yield* prepareNativeCycleInvalidTailMerge(
          checkout,
          runtime.state.plan,
          phase,
          baseline,
          leaf,
          captured,
          {
            priorHead: leaf.head,
            currentBaseHead: liveBaseHead,
            currentHead: captured.head,
            fromBaseBranch: phase.baseBranch,
            planDocumentHash: runtime.state.plan.source.documentHash,
            phaseOwnedPaths: request.phaseOwnedPaths,
          },
          {
            bindingId: stored.state.bindingId,
            snapshotId,
            expectedRevision: stored.revision,
            reason: request.reason,
            authority: request.userAuthority,
          },
        );
        const source: NativeCycleSnapshot = {
          format: 'threadnote-native-cycle-snapshot',
          version: 3,
          snapshotId,
          phaseId,
          phaseHash: leaf.phaseHash,
          repo: checkout,
          head: captured.head,
          tree: captured.tree,
          baseTree: baseline.tree,
          scopeBase: merge.scopeBase,
          declaredBaseHead: liveBaseHead,
          scopeFiles: merge.scopeFiles,
          files: merge.files,
          previous: leaf.snapshotId,
          previousTree: leaf.tree,
          acceptedHead: captured.head,
          pinnedRef: merge.pinnedRef,
        };
        const proof = {
          ...merge.proof,
          format: 'threadnote-native-invalid-tail-merge-qualification' as const,
          basisSnapshotId: selected.basis.snapshot.snapshotId,
          basisReviewDigest: selected.basis.digest,
          basisAttemptId: selected.basis.attempt.id,
          taskRefDigest: sha256HexSync(request.taskRef),
          predecessorRefDigest: sha256HexSync(request.predecessorRef),
          operationDigest,
        };
        const snapshot: NativeCycleSnapshot = {
          ...source,
          invalidTailMergeQualificationV1: {
            ...proof,
            receiptDigest: nativeCycleInvalidTailMergeReceiptDigest(source, proof),
          },
        };
        const entry = {snapshot, incoming: merge.incoming};
        const updated = yield* Effect.try({
          try: () => appendNativeCycleInvalidTailRequalification(runtime, entry),
          catch: () => fail('Invalid-tail witness failed immutable lineage or permission verification.'),
        });
        const prepared = yield* prepareNativeWorkflowStateWrite({...stored.state, cycle: updated});
        yield* verifyNativeCycleInvalidTailMergeSource(checkout, snapshot, baseline, phase);
        const saved = yield* persistNativeCycleOrdinaryMerge(
          config,
          checkout,
          snapshot,
          leaf,
          baseline,
          phase,
          prepared,
          stored.revision,
        );
        return result(entry, saved.revision, false);
      }),
    );
  });
