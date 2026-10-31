import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Result, Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as EffectArray from 'effect/Array';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {NativeCycleSnapshotSchema} from '@threadnote/workflow-automations/cycle-review';
import {completeLocalPhase, fixture, object, run} from './native-cycle-lifecycle-fixture.js';

const git = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args]);

const rebased = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const f = yield* fixture(
    ['one', 'two'],
    'local',
    false,
    false,
    true,
    {one: {branch: 'feature/one', baseBranch: 'rebased-base'}, two: {branch: 'feature/two', baseBranch: 'feature/one'}},
    repo =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(repo, 'source.ts'), 'export const feature = true;\n');
        yield* git(repo, ['add', '.']);
        yield* git(repo, ['commit', '-m', 'Feature baseline']);
      }),
  );
  const before = yield* fs.readFileString(f.statePath());
  const baseline = decodeNativeCycleRuntime(JSON.parse(before).cycle).baselines.one;
  yield* f.git(['checkout', 'main']);
  yield* fs.writeFileString(path.join(f.repo, 'incoming.ts'), 'export const incoming = true;\n');
  yield* f.git(['add', '.']);
  yield* f.git(['commit', '-m', 'Upstream']);
  const ontoHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
  yield* f.git(['checkout', 'feature/one']);
  yield* f.git(['rebase', 'main']);
  const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
  expect(
    (yield* runCommandEffect('git', ['-C', f.repo, 'merge-base', '--is-ancestor', baseline.head, head], {
      allowFailure: true,
    })).exitCode,
  ).toBe(1);
  yield* f.git(['branch', 'rebased-base', head]);
  yield* fs.writeFileString(path.join(f.repo, 'source.ts'), 'export const implemented = true;\n');
  const fields = {
    phaseId: 'one',
    snapshotId: 'after-rebase',
    acceptedHead: head,
    reason: 'Exact initial rebase and declared incoming source were inspected.',
    userAuthority: 'Resume working according to the plan. Rebase on the latest main first',
    rebase: {preRebaseHead: baseline.head, ontoHead, rebasedHead: head},
  };
  return {...f, before, baseline, head, fields};
});

const capture = (f: Effect.Success<typeof rebased>) =>
  Effect.gen(function* () {
    const result = yield* f.mutate('snapshot', f.fields);
    return yield* Schema.decodeUnknownEffect(NativeCycleSnapshotSchema)(object(result.snapshot).snapshot);
  });

const refused = <A, E>(result: Result.Result<A, E>, code?: string) => {
  expect(Result.isFailure(result)).toBe(true);
  if (code && Result.isFailure(result)) expect(result.failure).toMatchObject({code});
};

describe('initial native cycle rebase admission', () => {
  effectIt.effect('admits a real rebase before the first snapshot without replacing its baseline', () =>
    Effect.gen(function* () {
      const f = yield* rebased;
      const snapshot = yield* capture(f);
      expect(snapshot.rebase).toMatchObject(f.fields.rebase);
      expect(snapshot.baseTree).toBe(f.baseline.tree);
      const after = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
      expect(after.baselines.one).toEqual(f.baseline);
      const before = decodeNativeCycleRuntime(JSON.parse(f.before).cycle);
      expect(after.reviewLimits).toEqual(before.reviewLimits);
      expect(after.reviewExpansions).toEqual(before.reviewExpansions);
      expect(after.reviewLimits.one ?? 5).toBe(5);
      expect(after.reviews).toEqual([]);
      expect(after.attempts).toEqual([]);
    }).pipe(run),
  );

  effectIt.effect('requires the exact current head, witness, reason and explicit human authority', () =>
    Effect.gen(function* () {
      const f = yield* rebased;
      const before = yield* f.fs.readFileString(f.statePath());
      for (const key of ['rebase', 'acceptedHead', 'reason', 'userAuthority']) {
        const fields: Record<string, unknown> = {...f.fields};
        delete fields[key];
        refused(yield* f.mutate('snapshot', fields).pipe(Effect.result));
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }
      for (const extra of [
        {acceptedHead: f.fields.rebase.ontoHead},
        {reason: '  '},
        {userAuthority: '  '},
        {rebase: {...f.fields.rebase, receiptDigest: EffectString.repeat(64)('a')}},
      ]) {
        refused(yield* f.mutate('snapshot', {...f.fields, ...extra}).pipe(Effect.result));
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }
    }).pipe(run),
  );

  effectIt.effect('rejects unavailable and unrelated witnessed commits without mutating the run', () =>
    Effect.gen(function* () {
      const f = yield* rebased;
      const before = yield* f.fs.readFileString(f.statePath());
      for (const rebase of [
        {...f.fields.rebase, preRebaseHead: f.fields.rebase.ontoHead},
        {...f.fields.rebase, ontoHead: f.baseline.head},
        {...f.fields.rebase, rebasedHead: f.baseline.head},
        {...f.fields.rebase, rebasedHead: EffectString.repeat(40)('a')},
      ]) {
        refused(yield* f.mutate('snapshot', {...f.fields, rebase}).pipe(Effect.result), 'invalid-rebase');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }
    }).pipe(run),
  );

  effectIt.effect('keeps exact incoming-source checks for changed, deleted and added unowned files', () =>
    Effect.gen(function* () {
      const f = yield* rebased;
      const file = f.path.join(f.repo, 'incoming.ts');
      const text = yield* f.fs.readFileString(file);
      const before = yield* f.fs.readFileString(f.statePath());
      yield* f.fs.writeFileString(file, 'unowned edit\n');
      refused(yield* f.mutate('snapshot', f.fields).pipe(Effect.result), 'phase-scope');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      yield* f.fs.remove(file);
      refused(yield* f.mutate('snapshot', f.fields).pipe(Effect.result), 'phase-scope');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      yield* f.fs.writeFileString(file, text);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'unowned.ts'), 'unowned addition\n');
      refused(yield* f.mutate('snapshot', f.fields).pipe(Effect.result), 'phase-scope');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('rejects an executable-mode change outside the phase scope', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') return;
      const f = yield* rebased;
      const before = yield* f.fs.readFileString(f.statePath());
      yield* f.fs.chmod(f.path.join(f.repo, 'incoming.ts'), 0o755);
      refused(yield* f.mutate('snapshot', f.fields).pipe(Effect.result), 'phase-scope');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('replays the same witness idempotently and rejects changed immutable provenance', () =>
    Effect.gen(function* () {
      const f = yield* rebased;
      const snapshot = yield* capture(f);
      const before = yield* f.fs.readFileString(f.statePath());
      expect(yield* capture(f)).toEqual(snapshot);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      for (const extra of [
        {reason: 'Different reason'},
        {userAuthority: 'Different authority'},
        {
          rebase: {...f.fields.rebase, ontoHead: f.baseline.head},
        },
      ]) {
        refused(yield* f.mutate('snapshot', {...f.fields, ...extra}).pipe(Effect.result), 'snapshot-conflict');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }
      const stored = JSON.parse(before);
      fc.assert(
        fc.property(fc.string({minLength: 1, maxLength: 24}), suffix => {
          const tampered = structuredClone(stored.cycle);
          tampered.snapshots[0].snapshot.rebase.authority += suffix;
          expect(() => decodeNativeCycleRuntime(tampered)).toThrow();
        }),
        {numRuns: 20},
      );
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('retains both commit graphs through Git garbage collection', () =>
    Effect.gen(function* () {
      const f = yield* rebased;
      const snapshot = yield* capture(f);
      if (!snapshot.rebase) return yield* Effect.die('Missing admitted rebase receipt');
      expect(EffectString.trim((yield* f.git(['rev-parse', snapshot.rebase.beforeRef + '^{commit}'])).stdout)).toBe(
        f.baseline.head,
      );
      expect(EffectString.trim((yield* f.git(['rev-parse', snapshot.rebase.afterRef + '^{commit}'])).stdout)).toBe(
        f.head,
      );
      yield* f.git(['update-ref', '-d', 'ORIG_HEAD']);
      yield* f.git(['reflog', 'expire', '--expire=now', '--all']);
      yield* f.git(['gc', '--prune=now']);
      expect((yield* f.git(['cat-file', '-t', f.baseline.head])).stdout).toBe('commit\n');
      expect((yield* f.git(['cat-file', '-t', f.head])).stdout).toBe('commit\n');
    }).pipe(run),
  );

  effectIt.effect('rejects conflicting commit retention without replacing the immutable reference', () =>
    Effect.gen(function* () {
      const f = yield* rebased;
      const before = yield* f.fs.readFileString(f.statePath());
      const bindingId = yield* Schema.decodeUnknownEffect(Schema.String)(JSON.parse(before).bindingId);
      const ref =
        'refs/threadnote/cycles/rebase-before/' +
        sha256HexSync(JSON.stringify([bindingId, 'rebase-before', f.fields.snapshotId]));
      yield* f.git(['update-ref', ref, f.fields.rebase.ontoHead]);
      refused(yield* f.mutate('snapshot', f.fields).pipe(Effect.result), 'snapshot-conflict');
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      expect(EffectString.trim((yield* f.git(['rev-parse', ref])).stdout)).toBe(f.fields.rebase.ontoHead);
    }).pipe(run),
  );

  effectIt.effect('reobserves bytes, HEAD, branch and declared base after retaining the commit graphs', () =>
    Effect.gen(function* () {
      const f = yield* rebased;
      const command = yield* CommandExecutor;
      const executeBytes = command.executeBytes;
      if (!executeBytes) return yield* Effect.die('Expected binary Git command boundary');
      const before = yield* f.fs.readFileString(f.statePath());
      for (const pin of ['rebase-after', 'snapshot']) {
        for (const drift of ['bytes', 'head', 'branch', 'base']) {
          let injected = false;
          const outcome = yield* f.mutate('snapshot', {...f.fields, snapshotId: 'drift-' + pin + '-' + drift}).pipe(
            Effect.provideService(
              CommandExecutor,
              CommandExecutor.of({
                ...command,
                executeBytes: (executable, args, options) =>
                  executeBytes(executable, args, options).pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        if (
                          injected ||
                          !EffectArray.some(args, arg =>
                            EffectString.startsWith('refs/threadnote/cycles/' + pin + '/')(arg),
                          ) ||
                          !args.includes('update-ref')
                        )
                          return;
                        injected = true;
                        if (drift === 'bytes')
                          yield* f.fs.writeFileString(
                            f.path.join(f.repo, 'source.ts'),
                            'export const drifted = true;\n',
                          );
                        else if (drift === 'head') yield* f.git(['commit', '--allow-empty', '-m', 'Concurrent HEAD']);
                        else if (drift === 'branch') yield* f.git(['checkout', '-B', 'concurrent-branch']);
                        else yield* f.git(['update-ref', 'refs/heads/rebased-base', f.fields.rebase.ontoHead]);
                      }).pipe(Effect.provideService(CommandExecutor, command), Effect.orDie),
                    ),
                  ),
              }),
            ),
            Effect.result,
          );
          expect(injected).toBe(true);
          refused(outcome, 'source-drift');
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
          yield* f.git(['checkout', 'feature/one']);
          yield* f.git(['reset', '--mixed', f.head]);
          yield* f.git(['update-ref', 'refs/heads/rebased-base', f.head]);
          yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const implemented = true;\n');
        }
      }
    }).pipe(run),
  );

  effectIt.effect('keeps the continuous finding ledger and attempt budget after initial rebase admission', () =>
    Effect.gen(function* () {
      const f = yield* rebased;
      const snapshot = yield* capture(f);
      const finding = {
        id: 'F001',
        file: 'source.ts',
        line: 1,
        body: 'The implementation has an unresolved defect.',
        trigger: 'Use the private fixture.',
        impact: 'The current result is incomplete.',
        evidence: 'The source still contains the original behavior.',
        severity: 'important',
        category: 'correctness',
        confidence: 99,
        state: 'new',
      };
      const report = {
        snapshotId: snapshot.snapshotId,
        phaseHash: snapshot.phaseHash,
        snapshotTree: snapshot.tree,
        status: 'complete',
        mode: 'full',
        selected: ['correctness', 'simplicity'],
        lanes: [
          {name: 'correctness', status: 'complete'},
          {name: 'simplicity', status: 'complete'},
        ],
        findings: [finding],
      };
      yield* f.mutate('validate-review', {snapshotId: snapshot.snapshotId, attemptId: 'first', report});
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Inspected descendant']);
      const acceptedHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const second = true;\n');
      const second = yield* Schema.decodeUnknownEffect(NativeCycleSnapshotSchema)(
        object(
          (yield* f.mutate('snapshot', {
            phaseId: 'one',
            snapshotId: 'second',
            previous: snapshot.snapshotId,
            acceptedHead,
            reason: 'Inspected ordinary descendant after the initial rebase.',
          })).snapshot,
        ).snapshot,
      );
      expect(second.rebase).toBeUndefined();
      expect(second.previous).toBe(snapshot.snapshotId);
      const nextReport = {...report, snapshotId: second.snapshotId, snapshotTree: second.tree, mode: 'incremental'};
      expect(
        yield* f.mutate('validate-review', {
          snapshotId: second.snapshotId,
          attemptId: 'dropped',
          report: {...nextReport, findings: []},
        }),
      ).toMatchObject({status: 'error'});
      yield* f.mutate('validate-review', {
        snapshotId: second.snapshotId,
        attemptId: 'carried',
        report: {...nextReport, findings: [{...finding, state: 'carried'}]},
      });
      const before = yield* f.fs.readFileString(f.statePath());
      refused(
        yield* f.mutate('snapshot', {...f.fields, snapshotId: 'rewritten-again'}).pipe(Effect.result),
        'rebase-review-history',
      );
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      const runtime = decodeNativeCycleRuntime(JSON.parse(before).cycle);
      expect(runtime.attempts).toHaveLength(3);
      expect(runtime.attempts[1].status).toBe('invalid');
      expect(runtime.reviews[1].report.findings[0]).toMatchObject({id: 'F001', state: 'carried'});
      expect(runtime.reviewLimits.one ?? 5).toBe(5);
      expect(runtime.baselines.one).toEqual(f.baseline);
    }).pipe(run),
  );

  effectIt.effect(
    'preserves four delivered phases when the next phase is rebased before its first snapshot',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(['one', 'two', 'three', 'four', 'work'], 'local', false, false, true, {
          one: {branch: 'feature/one', baseBranch: 'main'},
          two: {branch: 'feature/two', baseBranch: 'feature/one'},
          three: {branch: 'feature/three', baseBranch: 'feature/two'},
          four: {branch: 'feature/four', baseBranch: 'feature/three'},
          work: {branch: 'feature/work', baseBranch: 'rebased-base'},
        });
        for (const id of ['one', 'two', 'three', 'four']) {
          if (id !== 'one') yield* f.git(['checkout', '-b', 'feature/' + id]);
          yield* completeLocalPhase(f, id);
        }
        yield* f.git(['checkout', '-b', 'feature/work']);
        yield* f.mutate('begin-phase', {phaseId: 'work'});
        const before = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'incoming.ts'), 'export const incoming = true;\n');
        yield* f.git(['add', '.']);
        yield* f.git(['commit', '-m', 'Upstream']);
        const ontoHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        yield* f.git(['checkout', 'feature/work']);
        yield* f.git(['rebase', 'main']);
        const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
        yield* f.git(['branch', 'rebased-base', head]);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const work = true;\n');
        yield* f.mutate('snapshot', {
          phaseId: 'work',
          snapshotId: 'work-first',
          acceptedHead: head,
          reason: 'Reviewed incoming main and rebased baseline.',
          userAuthority: 'Rebase on latest main first.',
          rebase: {preRebaseHead: before.baselines.work.head, ontoHead, rebasedHead: head},
        });
        const after = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        expect(after.state).toEqual(before.state);
        expect(after.plans).toEqual(before.plans);
        expect(after.baselines).toEqual(before.baselines);
        expect(after.reviews).toEqual(before.reviews);
        expect(after.attempts).toEqual(before.attempts);
        expect(after.reviewLimits).toEqual(before.reviewLimits);
        expect(after.reviewExpansions).toEqual(before.reviewExpansions);
        expect(after.snapshots.slice(0, 4)).toEqual(before.snapshots);
        expect(after.snapshots).toHaveLength(5);
      }).pipe(run),
    {timeout: 60_000},
  );
});
