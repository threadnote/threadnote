import {it as effectIt} from '@effect/vitest';
import {Effect, Result, Schema, String as EffectString} from 'effect';
import {describe, expect} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {NativeCycleSnapshotSchema, type NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
import {nativeCyclePhaseReviewUsage, nativeCycleReviewBasis} from '@threadnote/workflow-automations/cycle-runtime';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {requalifyInvalidNativeTaskTail} from '../../src/workflow_automation/task_review_requalification.js';
import {fixture, object, run, windowsCycleFixtureTimeout} from './native-cycle-lifecycle-fixture.js';

const timeout = windowsCycleFixtureTimeout ?? {timeout: 60_000};
const report = (snapshot: NativeCycleSnapshot, mode: 'full' | 'incremental', findings: readonly unknown[] = []) => ({
  snapshotId: snapshot.snapshotId,
  phaseHash: snapshot.phaseHash,
  snapshotTree: snapshot.tree,
  status: 'complete',
  mode,
  selected: ['correctness', 'simplicity'],
  lanes: [
    {name: 'correctness', status: 'complete'},
    {name: 'simplicity', status: 'complete'},
  ],
  findings,
});
const finding = {
  id: 'incremental-finding',
  file: 'source.ts',
  line: 1,
  body: 'Concrete input issue',
  trigger: 'Run input',
  impact: 'Wrong result',
  evidence: 'Source forwards input',
  severity: 'important',
  category: 'correctness',
  confidence: 99,
  state: 'new',
};
const prepare = () =>
  Effect.gen(function* () {
    const f = yield* fixture(['one'], 'local', false, false, false);
    const snapshot = (id: string, previous?: string) =>
      Effect.gen(function* () {
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), `export const feature = "${id}";\n`);
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', id]);
        const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        return yield* Schema.decodeUnknownEffect(NativeCycleSnapshotSchema)(
          object(
            (yield* f.mutate('snapshot', {
              phaseId: 'one',
              snapshotId: id,
              ...(previous ? {previous} : {}),
              acceptedHead: head,
              reason: 'Committed source iteration',
            })).snapshot,
          ).snapshot,
        );
      });
    const full = yield* snapshot('full');
    yield* f.mutate('validate-review', {
      snapshotId: full.snapshotId,
      attemptId: 'full-review',
      report: report(full, 'full'),
    });
    const incremental = yield* snapshot('incremental', full.snapshotId);
    yield* f.mutate('validate-review', {
      snapshotId: incremental.snapshotId,
      attemptId: 'incremental-review',
      report: report(incremental, 'incremental', [finding]),
    });
    const leaf = yield* snapshot('invalid-leaf', incremental.snapshotId);
    for (const attemptId of ['invalid-one', 'invalid-two'])
      expect((yield* f.mutate('validate-review', {snapshotId: leaf.snapshotId, attemptId, report: {}})).status).toBe(
        'error',
      );
    yield* f.git(['checkout', 'main']);
    yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const upstream = true;\n');
    yield* f.git(['add', 'upstream.ts']);
    yield* f.git(['commit', '-m', 'Advance same-label base']);
    yield* f.git(['checkout', 'feature/one']);
    yield* f.git(['merge', '--no-ff', 'main', '-m', 'Prepared normal merge']);
    const view = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
    const route = view.invalidTailRequalification;
    if (!route) throw new Error('Expected current invalid-tail route');
    const request = {
      runId: 'native-run',
      callerCwd: f.repo,
      taskRef: route.taskRef,
      predecessorRef: route.predecessorRef,
      reason: 'Requalify the prepared normal merge',
      userAuthority: 'User authorizes this exact invalid-tail qualification',
      phaseOwnedPaths: [{phaseId: 'one', paths: ['source.ts']}],
    };
    return {...f, leaf, incremental, request};
  });

describe('invalid-only task tail qualification', () => {
  effectIt.effect(
    'uses current refs and actual authority, retains the latest incremental ledger, replays exactly and requires fresh FULL review',
    () =>
      Effect.gen(function* () {
        const f = yield* prepare();
        const commands = yield* CommandExecutor;
        const gitRootAlias = CommandExecutor.of({
          ...commands,
          execute: (executable, args, options) =>
            commands
              .execute(executable, args, options)
              .pipe(
                Effect.map(result =>
                  executable === 'git' && args.includes('--show-toplevel')
                    ? {...result, stdout: `${EffectString.trim(result.stdout)}/.\n`}
                    : result,
                ),
              ),
        });
        const invoke = (request: Parameters<typeof requalifyInvalidNativeTaskTail>[1]) =>
          requalifyInvalidNativeTaskTail(f.config, request).pipe(Effect.provideService(CommandExecutor, gitRootAlias));
        const before = (yield* readNativeWorkflowState(f.config, 'native-run'))!;
        const oldBytes = yield* f.fs.readFileString(f.statePath());
        const indexPath = EffectString.trim((yield* f.git(['rev-parse', '--git-path', 'index'])).stdout);
        const head = (yield* f.git(['rev-parse', 'HEAD'])).stdout;
        const base = (yield* f.git(['rev-parse', 'main'])).stdout;
        const branches = (yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])).stdout;
        for (const changes of [
          {userAuthority: ' '},
          {reason: ' '},
          {phaseOwnedPaths: [{phaseId: 'one', paths: ['upstream.ts']}]},
          {phaseOwnedPaths: [{phaseId: 'foreign', paths: ['source.ts']}]},
          {taskRef: f.request.predecessorRef},
        ]) {
          expect(Result.isFailure(yield* invoke({...f.request, ...changes}).pipe(Effect.result))).toBe(true);
          expect(yield* f.fs.readFileString(f.statePath())).toBe(oldBytes);
        }
        const parsed = decodeNativeTaskActionRef(f.request.predecessorRef)!;
        const foreign = encodeNativeTaskActionRef({...parsed, stateRevision: EffectString.repeat(64)('0')});
        expect(Result.isFailure(yield* invoke({...f.request, predecessorRef: foreign}).pipe(Effect.result))).toBe(true);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'dirty.txt'), 'Dirty source');
        expect(Result.isFailure(yield* invoke(f.request).pipe(Effect.result))).toBe(true);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(oldBytes);
        yield* f.fs.remove(f.path.join(f.repo, 'dirty.txt'));
        yield* f.git(['checkout', 'main']);
        expect(Result.isFailure(yield* invoke(f.request).pipe(Effect.result))).toBe(true);
        yield* f.git(['checkout', 'feature/one']);
        const originalBase = EffectString.trim(base);
        yield* f.git(['update-ref', 'refs/heads/main', f.leaf.declaredBaseHead]);
        expect(Result.isFailure(yield* invoke(f.request).pipe(Effect.result))).toBe(true);
        yield* f.git(['update-ref', 'refs/heads/main', originalBase]);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'extra.ts'), 'export const extra = true;\n');
        yield* f.git(['add', 'extra.ts']);
        yield* f.git(['commit', '-m', 'Linear commit is not the prepared normal merge']);
        expect(Result.isFailure(yield* invoke(f.request).pipe(Effect.result))).toBe(true);
        yield* f.git(['reset', '--hard', EffectString.trim(head)]);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(oldBytes);
        const index = yield* f.fs.readFile(f.path.resolve(f.repo, indexPath));
        const admitted = yield* invoke(f.request);
        expect(admitted.replayed).toBe(false);
        const proof = admitted.snapshot.snapshot.invalidTailMergeQualificationV1!;
        expect(proof.basisSnapshotId).toBe(f.incremental.snapshotId);
        expect(proof.authority).toBe(f.request.userAuthority);
        expect(admitted.snapshot.snapshot.previous).toBe(f.leaf.snapshotId);
        const after = (yield* readNativeWorkflowState(f.config, 'native-run'))!;
        expect(after.state.cycle!.snapshots.slice(0, -1)).toEqual(before.state.cycle!.snapshots);
        expect(after.state.cycle!.reviews).toEqual(before.state.cycle!.reviews);
        expect(after.state.cycle!.attempts).toEqual(before.state.cycle!.attempts);
        expect(after.state.cycle!.reviewExpansions).toEqual(before.state.cycle!.reviewExpansions);
        expect(nativeCyclePhaseReviewUsage(after.state.cycle!, 'one')).toEqual(
          nativeCyclePhaseReviewUsage(before.state.cycle!, 'one'),
        );
        const fresh = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
        expect(fresh.phase?.snapshot?.recordingMode).toBe('full');
        expect(fresh.next.action).toBe('review');
        expect(fresh.invalidTailRequalification).toBeUndefined();
        const replay = yield* invoke(f.request);
        expect(replay.replayed).toBe(true);
        expect(replay.snapshotRef).toBe(admitted.snapshotRef);
        expect(
          Result.isFailure(yield* invoke({...f.request, userAuthority: 'Changed authority'}).pipe(Effect.result)),
        ).toBe(true);
        expect((yield* f.git(['rev-parse', 'HEAD'])).stdout).toBe(head);
        expect((yield* f.git(['rev-parse', 'main'])).stdout).toBe(base);
        expect((yield* f.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])).stdout).toBe(
          branches,
        );
        expect(yield* f.fs.readFile(f.path.resolve(f.repo, indexPath))).toEqual(index);
        const basis = nativeCycleReviewBasis(after.state.cycle!, admitted.snapshot.snapshot);
        expect(basis?.snapshot.snapshotId).toBe(f.incremental.snapshotId);
        const resolved = {...finding, state: 'resolved', reason: 'The prepared source validates inputs.'};
        expect(
          (yield* f.mutate('validate-review', {
            snapshotId: admitted.snapshot.snapshot.snapshotId,
            attemptId: 'fresh-full',
            report: report(admitted.snapshot.snapshot, 'full', [resolved]),
          })).status,
        ).toBe('ok');
        expect(
          (yield* f.mutate('ready', {
            phaseId: 'one',
            snapshotId: admitted.snapshot.snapshot.snapshotId,
            validation: {
              snapshotTree: admitted.snapshot.snapshot.tree,
              status: 'passed',
              productState: 'working',
              checks: [{command: 'focused', result: 'passed', evidence: 'Private fixture'}],
              acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Private fixture'}],
            },
          })).status,
        ).toBe('ok');
      }).pipe(run),
    timeout,
  );
});
