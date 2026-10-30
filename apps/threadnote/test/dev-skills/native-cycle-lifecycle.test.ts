import {Effect, Array as EffectArray, String as EffectString} from 'effect';

import {it as effectIt} from '@effect/vitest';

import {describe, expect} from 'vitest';

import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';

import {sha256HexSync} from '@threadnote/platform/sha256';

import * as Effect2 from 'effect';
import {fixture, object, reviewed, run} from './native-cycle-lifecycle-fixture.js';

describe('native cycle lifecycle', () => {
  effectIt.effect('preserves immutable legacy evidence and readiness while refusing current self-review', () =>
    Effect.gen(function* () {
      const f = yield* reviewed();
      const legacy = {
        ...f.report,
        selected: ['orchestrator'],
        lanes: [{name: 'orchestrator', status: 'complete'}],
      };
      const bytes = JSON.stringify(legacy);
      const runtime = JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle;
      const stored = {...runtime, reviews: [{snapshotId: f.snapshot.snapshotId, report: legacy}]};
      expect(decodeNativeCycleRuntime(stored).reviews[0].report).toEqual(legacy);
      expect(JSON.stringify(legacy)).toBe(bytes);
      expect(() =>
        decodeNativeCycleRuntime({
          ...stored,
          reviews: [{snapshotId: f.snapshot.snapshotId, report: {...legacy, lanes: []}}],
        }),
      ).toThrow();
      expect(
        yield* f.mutate('validate-review', {
          snapshotId: f.snapshot.snapshotId,
          attemptId: 'legacy-current-rejected',
          report: legacy,
        }),
      ).toMatchObject({status: 'error', code: 'invalid-cycle-review'});
      expect(
        yield* f.mutate('ready', {phaseId: 'one', snapshotId: f.snapshot.snapshotId}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'review-pending'}});
      yield* f.mutate('validate-review', {
        snapshotId: f.snapshot.snapshotId,
        attemptId: 'independent-current-review',
        report: f.report,
      });
      yield* f.mutate('ready', {
        phaseId: 'one',
        snapshotId: f.snapshot.snapshotId,
        validation: {
          snapshotTree: f.snapshot.tree,
          reviewTree: f.snapshot.tree,
          status: 'passed',
          productState: 'working',
          checks: [{command: 'private flow', result: 'passed', evidence: 'Real source fixture.'}],
          acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Private source readback.'}],
        },
      });
      const envelope = JSON.parse(yield* f.fs.readFileString(f.statePath()));
      const accepted = decodeNativeCycleRuntime(envelope.cycle);
      const legacyReady = {
        ...accepted,
        reviews: [{snapshotId: f.snapshot.snapshotId, report: legacy}],
        attempts: EffectArray.map(accepted.attempts, attempt =>
          attempt.status === 'accepted' ? {...attempt, report: bytes, digest: sha256HexSync(bytes)} : attempt,
        ),
      };
      expect(decodeNativeCycleRuntime(JSON.parse(JSON.stringify(legacyReady)))).toEqual(legacyReady);
      expect(legacyReady.state.phases.one.status).toBe('validated');
      expect(legacyReady.state).toEqual(accepted.state);
      yield* f.fs.writeFileString(f.statePath(), JSON.stringify({...envelope, cycle: legacyReady}));
      const unchanged = yield* f.fs.readFileString(f.statePath());
      yield* f.inspect();
      expect(
        yield* f.mutate('ready', {phaseId: 'one', snapshotId: f.snapshot.snapshotId}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'invalid-cycle-review'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(unchanged);
    }).pipe(run),
  );

  effectIt.effect('keeps stable-base incremental patch detail limited to the new source delta', () =>
    Effect.gen(function* () {
      const f = yield* reviewed();
      yield* f.mutate('validate-review', {
        snapshotId: f.snapshot.snapshotId,
        attemptId: 'initial-review',
        report: f.report,
      });
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "phase two";\n');
      yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'incremental-patch', previous: f.snapshot.snapshotId});
      const detail = object(
        yield* f.call({
          ...f.base('cycle'),
          command: 'detail',
          snapshotId: 'incremental-patch',
          detailKind: 'patch',
          maxBytes: 8192,
        }),
      );
      expect(object(detail.page).text).toContain('-export const fixture = "phase one";');
      expect(object(detail.page).text).toContain('+export const fixture = "phase two";');
      expect(object(detail.page).text).not.toContain('Declared-base scope delta');
    }).pipe(run),
  );

  effectIt.effect('checks declared-base deletions even when they cancel out of the original baseline diff', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.git(['checkout', 'main']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const upstream = true;\n');
      yield* f.git(['add', 'upstream.ts']);
      yield* f.git(['commit', '-m', 'Upstream addition']);
      yield* f.git(['checkout', 'feature/one']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "owned";\n');
      // A disjoint base advance does not force an unrelated rebase.
      const first = object(
        object((yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'before-upstream-merge'})).snapshot).snapshot,
      );
      expect(first.files).toEqual(['source.ts']);
      yield* f.mutate('validate-review', {
        snapshotId: first.snapshotId,
        attemptId: 'before-upstream-review',
        report: {
          snapshotId: first.snapshotId,
          phaseHash: first.phaseHash,
          snapshotTree: first.tree,
          status: 'complete',
          mode: 'full',
          selected: ['correctness', 'simplicity'],
          lanes: [
            {name: 'correctness', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      });
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Owned phase source']);
      yield* f.git(['merge', '--no-edit', 'main']);
      yield* f.fs.remove(f.path.join(f.repo, 'upstream.ts'));
      const head = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      const before = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* f
          .mutate('snapshot', {
            phaseId: 'one',
            snapshotId: 'canceled-unowned',
            previous: first.snapshotId,
            acceptedHead: head,
            reason: 'Actual upstream merge followed by unowned deletion.',
          })
          .pipe(Effect.result),
      ).toMatchObject({failure: {code: 'phase-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    }).pipe(run),
  );

  effectIt.effect('retains exact shared upstream entries when the declared base advances disjointly', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.git(['checkout', 'main']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const upstream = true;\n');
      yield* f.git(['add', 'upstream.ts']);
      yield* f.git(['commit', '-m', 'Shared upstream']);
      const common = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      yield* f.git(['checkout', 'feature/one']);
      yield* f.git(['merge', '--no-edit', 'main']);
      yield* f.git(['checkout', 'main']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'later.ts'), 'export const later = true;\n');
      yield* f.git(['add', 'later.ts']);
      yield* f.git(['commit', '-m', 'Disjoint later upstream']);
      const declared = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      yield* f.git(['checkout', 'feature/one']);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "owned";\n');
      const result = object(
        (yield* f.mutate('snapshot', {
          phaseId: 'one',
          snapshotId: 'disjoint-upstream',
          acceptedHead: common,
          reason: 'Actual shared upstream; later base changes are disjoint.',
        })).snapshot,
      );
      expect(result.incoming).toMatchObject([{path: 'upstream.ts', source: 'upstream', commit: common}]);
      expect(object(result.snapshot).declaredBaseHead).toBe(declared);
      expect(object(result.snapshot).scopeFiles).toEqual(['source.ts']);
      expect(object(result.snapshot).files).toEqual(['source.ts', 'upstream.ts']);
    }).pipe(run),
  );

  effectIt.effect(
    'includes the declared-base patch when an owned upstream change cancels from the fixed baseline',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = yield* f.fs.readFileString(f.path.join(f.repo, 'source.ts'));
        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const upstreamContract = true;\n');
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Upstream owned-path change']);
        yield* f.git(['checkout', 'feature/one']);
        yield* f.git(['merge', '--no-edit', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), original);
        const head = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
        const captured = object(
          object(
            (yield* f.mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'owned-cancellation',
              acceptedHead: head,
              reason: 'Actual merged upstream followed by an owned source edit.',
            })).snapshot,
          ).snapshot,
        );
        expect(captured.files).toEqual(['source.ts']);
        expect(captured.scopeFiles).toEqual(['source.ts']);
        expect(captured.baseTree).toBe(captured.tree);
        const patch = object(
          yield* f.call({
            ...f.base('cycle'),
            command: 'detail',
            snapshotId: captured.snapshotId,
            detailKind: 'patch',
            maxBytes: 8192,
          }),
        );
        expect(object(patch.page).text).toContain('Declared-base scope delta');
        expect(object(patch.page).text).toContain('-export const upstreamContract = true;');
      }).pipe(run),
  );

  effectIt.effect('retains exact pre-existing unowned staging as separate source evidence', () =>
    Effect.gen(function* () {
      const f = yield* fixture(['one', 'two'], 'pr', true);
      const indexPath = f.path.join(f.repo, '.git', 'index');
      const index = yield* f.fs.readFile(indexPath);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "owned";\n');
      const captured = object(
        (yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'preserved-user-work'})).snapshot,
      );
      expect(captured.incoming).toMatchObject([{path: 'user-note.txt', source: 'preserved', mode: '100644'}]);
      expect(yield* f.fs.readFile(indexPath)).toEqual(index);
      const snapshot = object(captured.snapshot);
      yield* f.mutate('validate-review', {
        snapshotId: snapshot.snapshotId,
        attemptId: 'preserved-review',
        report: {
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
          findings: [],
        },
      });
      expect(
        yield* f
          .mutate('ready', {
            phaseId: 'one',
            snapshotId: snapshot.snapshotId,
            validation: {
              snapshotTree: snapshot.tree,
              reviewTree: snapshot.tree,
              status: 'passed',
              productState: 'working',
              checks: [{command: 'private flow', result: 'passed', evidence: 'Exact fixture.'}],
              acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Owned source works.'}],
            },
          })
          .pipe(Effect.result),
      ).toMatchObject({failure: {code: 'preserved-work-publication'}});
      yield* f.fs.remove(f.path.join(f.repo, 'user-note.txt'));
      expect(
        yield* f
          .mutate('snapshot', {phaseId: 'one', snapshotId: 'removed-user-work', previous: snapshot.snapshotId})
          .pipe(Effect.result),
      ).toMatchObject({failure: {code: 'phase-scope'}});
      expect(yield* f.fs.readFile(indexPath)).toEqual(index);
    }).pipe(run),
  );

  effectIt.effect('keeps baseline pins distinct from every valid snapshot identifier', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "changed";\n');
      const result = yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'baseline-one'});
      const snapshot = object(object(result.snapshot).snapshot);
      const runtime = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle);
      expect(runtime.baselines.one?.pinnedRef).toContain('/baseline/');
      expect(snapshot.pinnedRef).toContain('/snapshot/');
      expect(snapshot.pinnedRef).not.toBe(runtime.baselines.one?.pinnedRef);
    }).pipe(run),
  );

  effectIt.effect('pins the original baseline before implementation and rejects committed unowned source', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const initial = decodeNativeCycleRuntime(JSON.parse(yield* f.fs.readFileString(f.statePath())).cycle).baselines
        .one;
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "committed";\n');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'config.ts'), 'export const unauthorized = true;\n');
      yield* f.git(['add', 'source.ts', 'config.ts']);
      yield* f.git(['commit', '-m', 'Before first review']);
      const head = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      const before = yield* f.fs.readFileString(f.statePath());
      expect(
        yield* f
          .mutate('snapshot', {
            phaseId: 'one',
            snapshotId: 'committed',
            acceptedHead: head,
            reason: 'Actual pre-review commit.',
          })
          .pipe(Effect.result),
      ).toMatchObject({failure: {code: 'phase-scope'}});
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      yield* f.git(['rm', 'config.ts']);
      yield* f.git(['commit', '-m', 'Remove unowned source']);
      const ownedHead = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      const captured = object(
        object(
          (yield* f.mutate('snapshot', {
            phaseId: 'one',
            snapshotId: 'owned',
            acceptedHead: ownedHead,
            reason: 'Owned committed source only.',
          })).snapshot,
        ).snapshot,
      );
      expect(captured.baseTree).toBe(initial?.tree);
      expect(captured.files).toEqual(['source.ts']);
      expect(captured.tree).not.toBe(captured.baseTree);
      expect(
        yield* f.mutate('snapshot', {phaseId: 'one', snapshotId: 'changed-base', base: 'HEAD'}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'review-history'}});
    }).pipe(run),
  );
});
