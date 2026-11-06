import {Effect, String as EffectString} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {nativeAuthoringDigest} from '@threadnote/workflow-automations/authoring';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {fixture, object, run} from './native-cycle-lifecycle-fixture.js';

describe('standard task plan reconciliation', () => {
  effectIt.effect('binds a ready standard root and preserves PR delivery, base transitions and exact replay', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one'], 'pr');
      yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
      yield* f.git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
      const head = EffectString.trim((yield* f.git(['rev-parse', 'main'])).stdout);
      yield* f.git(['update-ref', 'refs/remotes/origin/main', head]);
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      const initial = yield* readNativeWorkflowState(f.config, 'native-run');
      if (!initial?.state.cycle) throw new Error('Expected initial cycle.');
      const prior = initial.state.cycle;
      const document = {
        ...f.document,
        objective: 'Deliver each phase with the reviewed persistence contract.',
        review: {required: true, reason: 'Independently review the revised contract.'},
      };
      const sourceRoot = object(object(f.exported.source).root);
      const save = (ready: boolean, revision: unknown, review?: unknown) =>
        f
          .call({
            ...f.base('authoring'),
            command: 'save',
            document,
            ready,
            uri: sourceRoot.uri,
            expectedRevision: revision,
            ...(review ? {review} : {}),
          })
          .pipe(Effect.map(value => object(object(value).authoring)));
      // A standard plan has no compact confirmation, but required exact review
      // and ready promotion still gate its reconciliation authority.
      const draft = yield* save(true, sourceRoot.revision);
      expect(draft.readiness).toBe('draft');
      const unready = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(unready.next.action).toBe('workflow_task_author');
      const unreadyBytes = yield* f.fs.readFileString(f.statePath());
      const refusedDraft = yield* runNativeTaskAction(f.config, {
        command: 'reconcile',
        runId: 'native-run',
        callerCwd: f.repo,
        taskRef: String(unready.taskRef),
        reason: 'An unreviewed plan has no readiness authority.',
      }).pipe(Effect.result);
      expect(refusedDraft).toMatchObject({failure: {code: 'stale-task-ref'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(unreadyBytes);
      const ready = yield* save(true, object(draft.root).revision, {
        documentHash: nativeAuthoringDigest(document),
        outcome: 'accepted',
        blockingIssueCount: 0,
      });
      const priorRootView = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      const savedState = yield* readNativeWorkflowState(f.config, 'native-run');
      const rootReceipt = savedState?.state.operations.at(-1);
      if (!rootReceipt?.artifact) throw new Error('Expected verified ready root receipt.');
      const custom = object(
        yield* f.call({
          ...f.base('write'),
          operationId: 'custom-standard-root',
          artifactKey: 'author-root-plan',
          role: 'authoring-root',
          nameHint: 'reviewed-standard-plan',
          body: rootReceipt.artifact.body,
          expectedRevision: null,
          storageKind: 'durable',
        }),
      );
      const customArtifact = object(custom.artifact);
      const saved: Record<string, unknown> = {
        ...ready,
        root: {uri: customArtifact.uri, memoryId: customArtifact.memoryId, revision: customArtifact.revision},
      };
      expect(object(saved.root).uri).not.toBe(sourceRoot.uri);
      expect(object(saved.root).uri).toContain('reviewed-standard-plan');
      expect(saved).toMatchObject({readiness: 'ready'});
      expect(saved.confirmation).toBeUndefined();
      expect(saved.documentHash).not.toBe(saved.intentHash);
      const view = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
      expect(view).toMatchObject({next: {action: 'reconcile-plan'}, authoring: {status: 'awaiting-admission'}});
      const taskRef = String(view.taskRef);
      const ref = decodeNativeTaskActionRef(taskRef);
      if (!ref) throw new Error('Expected a typed reconciliation reference.');
      expect(ref.payloadDigest).toBe(
        sha256HexSync(
          stableJson({
            uri: object(saved.root).uri,
            revision: object(saved.root).revision,
            documentHash: saved.documentHash,
            intentHash: saved.intentHash,
          }),
        ),
      );
      const bindings = {one: {branch: 'feature/one', baseBranch: 'refs/remotes/origin/main'}};
      const reconcile = (reference = taskRef, selectedBindings = bindings) =>
        runNativeTaskAction(f.config, {
          command: 'reconcile',
          runId: 'native-run',
          callerCwd: f.repo,
          taskRef: reference,
          reason: 'Use the reviewed standard plan and its physical upstream base.',
          bindings: selectedBindings,
        });
      const before = yield* f.fs.readFileString(f.statePath());
      expect(yield* reconcile(String(priorRootView.taskRef)).pipe(Effect.result)).toMatchObject({
        failure: {code: 'stale-task-ref'},
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      const {payloadDigest: _digest, ...missingDigest} = ref;
      for (const altered of [
        missingDigest,
        {...ref, payloadDigest: EffectString.repeat(64)('0')},
        {...ref, stateRevision: EffectString.repeat(64)('0')},
        {...ref, generationHash: EffectString.repeat(64)('0')},
        {...ref, phaseId: 'one'},
      ]) {
        expect(yield* reconcile(encodeNativeTaskActionRef(altered)).pipe(Effect.result)).toMatchObject({
          failure: {code: 'stale-task-ref'},
        });
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }
      expect(
        yield* reconcile(taskRef, {one: {branch: 'feature/other', baseBranch: 'main'}}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'invalid-request'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      expect(yield* reconcile()).toMatchObject({status: 'reconciled', replayed: false});
      const after = yield* readNativeWorkflowState(f.config, 'native-run');
      const runtime = after?.state.cycle;
      if (!runtime) throw new Error('Expected reconciled cycle.');
      expect(runtime.state.plan.delivery).toBe('pr');
      expect(runtime.state.plan.source.root).toEqual(saved.root);
      expect(runtime.state.plan.phases[0]).toMatchObject(bindings.one);
      expect(runtime.plans).toEqual([...prior.plans, runtime.state.plan]);
      expect(runtime.baselines).toEqual(prior.baselines);
      expect(runtime.snapshots).toEqual(prior.snapshots);
      expect(runtime.reviews).toEqual(prior.reviews);
      expect(runtime.attempts).toEqual(prior.attempts);
      expect(runtime.reviewLimits).toEqual(prior.reviewLimits);
      expect(runtime.reviewExpansions).toEqual(prior.reviewExpansions);
      const acceptedBytes = yield* f.fs.readFileString(f.statePath());
      expect(yield* reconcile()).toMatchObject({status: 'reconciled', replayed: true});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(acceptedBytes);
      expect(
        yield* reconcile(taskRef, {one: {branch: 'feature/one', baseBranch: 'main'}}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'invalid-request'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(acceptedBytes);
    }).pipe(run),
  );
});
