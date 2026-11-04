import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Path, Result, Schema} from 'effect';
import * as EffectString from 'effect/String';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {NativeCycleSnapshotSchema, type NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
import {fixture, object, run} from './native-cycle-lifecycle-fixture.js';

const finding = {
  id: 'F001',
  file: 'source.ts',
  line: 1,
  body: 'The private implementation still has an unresolved defect.',
  trigger: 'Use the private fixture.',
  impact: 'The result is incomplete.',
  evidence: 'The implementation has not resolved the original behavior.',
  severity: 'important',
  category: 'correctness',
  confidence: 99,
  state: 'new',
};
const report = (snapshot: NativeCycleSnapshot, mode: 'full' | 'incremental', state = 'new') => ({
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
  findings: [{...finding, state}],
});
const refused = <A, E>(result: Result.Result<A, E>, code?: string) => {
  expect(Result.isFailure(result)).toBe(true);
  if (code && Result.isFailure(result)) expect(result.failure).toMatchObject({code});
};
const qualifyFixture = (oldBaseAhead = false, intermediateMetadata = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const f = yield* fixture(
      ['one', 'two'],
      'local',
      false,
      false,
      true,
      {one: {branch: 'feature/one', baseBranch: 'prerelease'}, two: {branch: 'feature/two', baseBranch: 'feature/one'}},
      repo =>
        Effect.gen(function* () {
          const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
          yield* fs.writeFileString(path.join(repo, 'legacy.ts'), 'export const prerelease = true;\n');
          yield* git(['add', '.']);
          yield* git(['commit', '-m', 'Prerelease baseline']);
          yield* git(['branch', 'prerelease']);
          if (oldBaseAhead) {
            yield* git(['checkout', 'prerelease']);
            yield* fs.writeFileString(path.join(repo, 'ahead.ts'), 'export const ahead = true;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '-m', 'Declared base ahead of reviewed source']);
            yield* git(['checkout', 'feature/one']);
          }
        }),
    );
    yield* fs.writeFileString(path.join(f.repo, 'source.ts'), 'export const feature = true;\n');
    yield* f.git(['add', 'source.ts']);
    yield* f.git(['commit', '-m', 'Feature']);
    const featureHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
    const prior = yield* Schema.decodeUnknownEffect(NativeCycleSnapshotSchema)(
      object(
        (yield* f.mutate('snapshot', {
          phaseId: 'one',
          snapshotId: 'prerelease-review',
          acceptedHead: featureHead,
          reason: 'Reviewed feature commit.',
        })).snapshot,
      ).snapshot,
    );
    yield* f.mutate('validate-review', {
      snapshotId: prior.snapshotId,
      attemptId: 'old-review',
      report: report(prior, 'full'),
    });
    const old = decodeNativeCycleRuntime(JSON.parse(yield* fs.readFileString(f.statePath())).cycle);
    yield* f.git(['checkout', 'main']);
    yield* fs.writeFileString(path.join(f.repo, 'incoming.ts'), 'export const incoming = true;\n');
    yield* f.git(['add', '.']);
    yield* f.git(['commit', '-m', 'Divergent stable upstream']);
    const ontoHead = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
    yield* f.git(['checkout', '-b', 'feature/main']);
    yield* f.git(['cherry-pick', featureHead]);
    const head = EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout);
    if (intermediateMetadata) {
      yield* f.git(['branch', 'intermediate-base', prior.declaredBaseHead]);
      const intermediate = yield* f.revise(
        {},
        {
          one: {branch: 'feature/main', baseBranch: 'intermediate-base'},
          two: {branch: 'feature/two', baseBranch: 'feature/main'},
        },
      );
      yield* f.mutate('reconcile', {
        plan: intermediate,
        reason: 'Approved metadata amendment without another source snapshot.',
      });
    }
    const plan = yield* f.revise(
      {},
      {one: {branch: 'feature/main', baseBranch: 'main'}, two: {branch: 'feature/two', baseBranch: 'feature/main'}},
    );
    yield* f.mutate('reconcile', {plan, reason: 'Human approved a combined PR on main.'});
    const fields = {
      phaseId: 'one',
      snapshotId: 'stable-review',
      previous: prior.snapshotId,
      acceptedHead: head,
      reason: 'Requalify the source-only cherry-pick on the approved stable base.',
      userAuthority: 'Use one combined PR on main instead of the prerelease base.',
      baseRequalification: {fromBaseBranch: 'prerelease', preRebaseHead: prior.head, ontoHead, rebasedHead: head},
    };
    const capture = () =>
      f
        .mutate('snapshot', fields)
        .pipe(
          Effect.flatMap(result =>
            Schema.decodeUnknownEffect(NativeCycleSnapshotSchema)(object(result.snapshot).snapshot),
          ),
        );
    return {...f, prior, old, fields, head, capture};
  });

describe('native cycle approved base requalification', () => {
  effectIt.effect(
    'preserves the run and ledger while requiring a full new-base review and subsequent incremental deltas',
    () =>
      Effect.gen(function* () {
        const f = yield* qualifyFixture();
        const before = yield* f.fs.readFileString(f.statePath());
        const {baseRequalification: _witness, ...ordinary} = f.fields;
        refused(yield* f.mutate('snapshot', ordinary).pipe(Effect.result), 'head-drift');
        for (const command of ['ready', 'check-phase', 'validate-review']) {
          refused(
            yield* f.mutate(command, {phaseId: 'one', snapshotId: f.prior.snapshotId}).pipe(Effect.result),
            'review-stale',
          );
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        }
        for (const key of ['previous', 'acceptedHead', 'reason', 'userAuthority']) {
          const fields: Record<string, unknown> = {...f.fields};
          delete fields[key];
          refused(yield* f.mutate('snapshot', fields).pipe(Effect.result));
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        }
        for (const witness of [
          {...f.fields.baseRequalification, preRebaseHead: f.fields.baseRequalification.ontoHead},
          {...f.fields.baseRequalification, ontoHead: f.prior.declaredBaseHead},
          {...f.fields.baseRequalification, rebasedHead: f.prior.head},
          {...f.fields.baseRequalification, fromBaseBranch: 'main'},
        ]) {
          refused(
            yield* f.mutate('snapshot', {...f.fields, baseRequalification: witness}).pipe(Effect.result),
            'invalid-base-requalification',
          );
          expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        }
        const snapshot = yield* f.capture();
        expect(snapshot.previous).toBe(f.prior.snapshotId);
        expect(snapshot.phaseHash).toBe(f.prior.phaseHash);
        expect(snapshot.baseTree).toBe(f.old.baselines.one.tree);
        const expectedBaseHead = f.fields.baseRequalification.ontoHead;
        const expectedScopeBase = EffectString.trim((yield* f.git(['rev-parse', `${expectedBaseHead}^{tree}`])).stdout);
        expect(snapshot.declaredBaseHead).toBe(expectedBaseHead);
        expect(snapshot.scopeBase).toBe(expectedScopeBase);
        const saved = yield* f.fs.readFileString(f.statePath());
        expect(yield* f.capture()).toEqual(snapshot);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(saved);
        refused(
          yield* f.mutate('snapshot', {...f.fields, reason: 'Changed immutable reason'}).pipe(Effect.result),
          'snapshot-conflict',
        );
        const runtime = decodeNativeCycleRuntime(JSON.parse(saved).cycle);
        expect(runtime.baselines).toEqual(f.old.baselines);
        expect(runtime.snapshots.slice(0, f.old.snapshots.length)).toEqual(f.old.snapshots);
        expect(runtime.reviews).toEqual(f.old.reviews);
        expect(runtime.attempts).toEqual(f.old.attempts);
        expect(runtime.reviewLimits).toEqual(f.old.reviewLimits);
        expect(runtime.reviewExpansions).toEqual(f.old.reviewExpansions);
        expect(runtime.state.phases.one.status).toBe('stale');
        const detail = yield* f.call({
          ...f.base('cycle'),
          command: 'detail',
          snapshotId: snapshot.snapshotId,
          detailKind: 'patch',
        });
        const text = object(object(detail).page).text;
        expect(text).toEqual(
          (yield* f.git(['diff', '--no-ext-diff', '--no-textconv', '--binary', expectedScopeBase, snapshot.tree, '--']))
            .stdout,
        );
        expect(text).toContain('+export const feature = true;');
        expect(text).not.toContain('legacy.ts');
        expect(text).not.toContain('incoming.ts');
        const commandExecutor = yield* CommandExecutor;
        const executeBytes = commandExecutor.executeBytes;
        if (!executeBytes) return yield* Effect.die('Expected binary Git boundary');
        for (const command of ['ready', 'validate-review']) {
          let moved = false;
          const result = yield* f.mutate(command, {phaseId: 'one', snapshotId: snapshot.snapshotId}).pipe(
            Effect.provideService(
              CommandExecutor,
              CommandExecutor.of({
                ...commandExecutor,
                executeBytes: (executable, args, options) =>
                  executeBytes(executable, args, options).pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        if (moved || !args.includes('write-tree')) return;
                        moved = true;
                        yield* f.git(['update-ref', 'refs/heads/main', f.prior.declaredBaseHead]);
                      }).pipe(Effect.provideService(CommandExecutor, commandExecutor), Effect.orDie),
                    ),
                  ),
              }),
            ),
            Effect.result,
          );
          expect(moved).toBe(true);
          refused(result, 'review-stale');
          expect(yield* f.fs.readFileString(f.statePath())).toBe(saved);
          yield* f.git(['update-ref', 'refs/heads/main', f.fields.baseRequalification.ontoHead]);
        }
        expect(
          yield* f.mutate('validate-review', {
            snapshotId: snapshot.snapshotId,
            attemptId: 'wrong-mode',
            report: report(snapshot, 'incremental', 'carried'),
          }),
        ).toMatchObject({status: 'error'});
        expect(
          yield* f.mutate('validate-review', {
            snapshotId: snapshot.snapshotId,
            attemptId: 'dropped-finding',
            report: {...report(snapshot, 'full'), findings: []},
          }),
        ).toMatchObject({status: 'error'});
        expect(
          yield* f.mutate('validate-review', {
            snapshotId: snapshot.snapshotId,
            attemptId: 'full-review',
            userAuthority: 'The fixture authorizes a corrected report after the two retained malformed attempts.',
            report: report(snapshot, 'full', 'carried'),
          }),
        ).toMatchObject({status: 'ok'});
        yield* f.fs.writeFileString(
          f.path.join(f.repo, 'source.ts'),
          'export const feature = true;\nexport const followup = true;\n',
        );
        const next = yield* Schema.decodeUnknownEffect(NativeCycleSnapshotSchema)(
          object(
            (yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'next', previous: snapshot.snapshotId})).snapshot,
          ).snapshot,
        );
        expect(next.baseRequalification).toBeUndefined();
        const nextDetail = yield* f.call({
          ...f.base('cycle'),
          command: 'detail',
          snapshotId: next.snapshotId,
          detailKind: 'patch',
        });
        const nextText = object(object(nextDetail).page).text;
        expect(nextText).toContain('+export const followup = true;');
        expect(nextText).not.toContain('+export const feature = true;');
        expect(
          yield* f.mutate('validate-review', {
            snapshotId: next.snapshotId,
            attemptId: 'incremental-review',
            report: report(next, 'incremental', 'carried'),
          }),
        ).toMatchObject({status: 'ok'});
        const final = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
        expect(final.attempts).toHaveLength(5);
        expect(final.reviews.at(-1)?.report.findings[0]).toMatchObject({id: finding.id, state: 'carried'});
        fc.assert(
          fc.property(fc.string({minLength: 1, maxLength: 24}), suffix => {
            const snapshot = runtime.snapshots[1].snapshot;
            const receipt = snapshot.baseRequalification;
            if (!receipt) throw new Error('Expected base-requalification receipt.');
            const tampered = {
              ...runtime,
              snapshots: EffectArray.map(runtime.snapshots, (entry, index) =>
                index === 1
                  ? {
                      ...entry,
                      snapshot: {
                        ...snapshot,
                        baseRequalification: {...receipt, authority: receipt.authority + suffix},
                      },
                    }
                  : entry,
              ),
            };
            expect(() => decodeNativeCycleRuntime(tampered)).toThrow();
          }),
          {numRuns: 20},
        );
      }).pipe(run),
    {timeout: 60_000},
  );

  effectIt.effect(
    'refuses initial base requalification when the prior base ref is missing without mutating the run',
    () =>
      Effect.gen(function* () {
        const f = yield* qualifyFixture();
        const before = yield* f.fs.readFileString(f.statePath());
        yield* f.git(['branch', '-D', 'prerelease']);
        refused(yield* f.capture().pipe(Effect.result), 'invalid-base-requalification');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      }).pipe(run),
    {timeout: 60_000},
  );

  effectIt.effect(
    'keeps exact unowned scope and legacy-base proof, and retains all witnessed commit graphs',
    () =>
      Effect.gen(function* () {
        const f = yield* qualifyFixture(true, true);
        const before = yield* f.fs.readFileString(f.statePath());
        yield* f.git(['update-ref', 'refs/heads/prerelease', f.prior.head]);
        refused(yield* f.capture().pipe(Effect.result), 'invalid-base-requalification');
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        yield* f.git(['update-ref', 'refs/heads/prerelease', f.prior.declaredBaseHead]);
        const incoming = f.path.join(f.repo, 'incoming.ts');
        const original = yield* f.fs.readFileString(incoming);
        yield* f.fs.writeFileString(incoming, 'unowned edit\n');
        refused(yield* f.capture().pipe(Effect.result), 'phase-scope');
        yield* f.fs.remove(incoming);
        refused(yield* f.capture().pipe(Effect.result), 'phase-scope');
        yield* f.fs.writeFileString(incoming, original);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'unowned.ts'), 'unowned addition\n');
        refused(yield* f.capture().pipe(Effect.result), 'phase-scope');
        yield* f.fs.remove(f.path.join(f.repo, 'unowned.ts'));
        expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
        const snapshot = yield* f.capture();
        const receipt = snapshot.baseRequalification;
        if (!receipt) return yield* Effect.die('Missing base-requalification receipt');
        yield* f.git(['branch', '-D', 'prerelease', 'feature/one']);
        yield* f.git(['update-ref', '-d', 'ORIG_HEAD']);
        yield* f.git(['reflog', 'expire', '--expire=now', '--all']);
        yield* f.git(['gc', '--prune=now']);
        for (const [ref, commit] of [
          [receipt.beforeRef, f.prior.head],
          [receipt.afterRef, f.head],
          [receipt.priorBaseRef, f.prior.declaredBaseHead],
        ]) {
          expect(EffectString.trim((yield* f.git(['rev-parse', ref + '^{commit}'])).stdout)).toBe(commit);
          expect((yield* f.git(['cat-file', '-t', commit])).stdout).toBe('commit\n');
        }
        expect(yield* f.capture()).toEqual(snapshot);
      }).pipe(run),
    {timeout: 60_000},
  );
});
