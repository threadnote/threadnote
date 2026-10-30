import {Effect, Array as EffectArray, String as EffectString, FileSystem, PlatformError, Result} from 'effect';

import {it as effectIt} from '@effect/vitest';

import {describe, expect} from 'vitest';

import {decodeNativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';

import {sha256HexSync} from '@threadnote/platform/sha256';

import * as Effect2 from 'effect';
import {
  captureNativeCycleSource,
  fixture,
  object,
  reviewed,
  run,
  windowsCycleFixtureTimeout,
} from './native-cycle-lifecycle-fixture.js';

describe('native cycle lifecycle', () => {
  // prettier-ignore
  effectIt.effect('verifies ready graph, actual anchors, ownership and packet budgets before routine dispatch', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const graph = object(object(yield* f.call(f.base('graph-ready'))).graph);
      const captured = yield* captureNativeCycleSource(f.repo, 'HEAD');
      const options = {
        capacity: {
          model: 'advertised-cheap-model',
          effort: 'low',
          selection: 'least-sufficient',
          risk: 'settled',
          reason: 'Bounded established implementation with verified anchors.',
          catalogEvidence: 'Test host advertises low effort.',
        },
        graphProof: {...graph, tree: captured.tree},
        anchors: [
          {
            path: 'source.ts',
            sha256: sha256HexSync(yield* f.fs.readFile(f.path.join(f.repo, 'source.ts'))),
            pattern: 'fixture',
          },
        ],
        ownership: ['source.ts'],
        checks: ['private check'],
        detailRefs: ['native-plan:one'],
      };
      const packet = yield* f.call({...f.base('cycle'), command: 'packet', phaseId: 'one', packet: options});
      expect(packet).toMatchObject({available: true, capacity: {effort: 'low'}, acceptanceCriteria: ['one works']});
      expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThan(12_288);
      const tiny = yield* f.call({
        ...f.base('cycle'),
        command: 'packet',
        phaseId: 'one',
        packet: {...options, budgetBytes: 1024},
      });
      expect(tiny).toMatchObject({available: false, reason: 'packet-budget-exceeded', detailRefs: ['native-plan:one']});
      const wrong = yield* f
        .call({
          ...f.base('cycle'),
          command: 'packet',
          phaseId: 'one',
          packet: {...options, anchors: [{...options.anchors[0], pattern: 'absent literal'}]},
        })
        .pipe(Effect.result);
      expect(wrong).toMatchObject({failure: {code: 'anchor-drift'}});
      const scope = yield* f
        .call({...f.base('cycle'), command: 'packet', phaseId: 'one', packet: {...options, ownership: ['outside.ts']}})
        .pipe(Effect.result);
      expect(scope).toMatchObject({failure: {code: 'phase-scope'}});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const changed = true;\n');
      const drift = yield* f
        .call({...f.base('cycle'), command: 'packet', phaseId: 'one', packet: options})
        .pipe(Effect.result);
      expect(drift).toMatchObject({failure: {code: 'source-drift'}});
    }).pipe(run),
    windowsCycleFixtureTimeout,
  );

  effectIt.effect(
    'admits exact read-only upstream blobs while preserving the original review baseline and rejecting unowned edits',
    () =>
      Effect.gen(function* () {
        const f = yield* reviewed();
        yield* f.mutate('validate-review', {
          snapshotId: f.snapshot.snapshotId,
          attemptId: 'before-incoming',
          report: f.report,
        });
        yield* f.git(['add', 'source.ts']);
        yield* f.git(['commit', '-m', 'Phase source']);
        yield* f.git(['checkout', 'main']);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const upstream = true;\n');
        yield* f.git(['add', 'upstream.ts']);
        yield* f.git(['commit', '-m', 'Independent upstream']);
        const upstream = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
        yield* f.git(['checkout', 'feature/one']);
        yield* f.git(['merge', '--no-edit', 'main']);
        const acceptedHead = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
        const result = yield* f.mutate('snapshot', {
          phaseId: 'one',
          snapshotId: 'after-incoming',
          previous: f.snapshot.snapshotId,
          acceptedHead,
          reason: 'Actual normal upstream merge; retain fixed baseline and exact upstream content.',
        });
        const entry = object(result.snapshot);
        const snapshot = object(entry.snapshot);
        expect(snapshot.baseTree).toBe(f.snapshot.baseTree);
        expect(entry.incoming).toEqual([
          {
            path: 'upstream.ts',
            mode: '100644',
            source: 'upstream',
            tree: Effect2.pipe((yield* f.git(['rev-parse', upstream + '^{tree}'])).stdout, EffectString.trim),
            blob: Effect2.pipe((yield* f.git(['rev-parse', upstream + ':upstream.ts'])).stdout, EffectString.trim),
            commit: upstream,
          },
        ]);
        yield* f.mutate('validate-review', {
          snapshotId: snapshot.snapshotId,
          attemptId: 'incoming-review',
          report: {...f.report, snapshotId: snapshot.snapshotId, snapshotTree: snapshot.tree, mode: 'incremental'},
        });
        // Git index modes are portable even when the host filesystem has no executable bit.
        yield* f.git(['config', 'core.filemode', 'false']);
        yield* f.git(['update-index', '--chmod=+x', 'upstream.ts']);
        yield* f.git(['commit', '-m', 'Unowned mode edit']);
        const modeHead = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
        expect(
          yield* f
            .mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'unowned-mode',
              previous: snapshot.snapshotId,
              acceptedHead: modeHead,
              reason: 'Actual unowned mode change.',
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'phase-scope'}});
        yield* f.git(['update-index', '--chmod=-x', 'upstream.ts']);
        yield* f.git(['commit', '-m', 'Restore upstream mode']);
        const restoredHead = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'upstream.ts'), 'export const tampered = true;\n');
        expect(
          yield* f
            .mutate('snapshot', {
              phaseId: 'one',
              snapshotId: 'unowned-edit',
              previous: snapshot.snapshotId,
              acceptedHead: restoredHead,
              reason: 'Actual unowned bytes changed.',
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'phase-scope'}});
      }).pipe(run),
  );

  effectIt.effect('delivers one phase and immediately permits the next with an open draft PR and pending CI', () =>
    Effect.gen(function* () {
      const f = yield* reviewed();
      yield* f.mutate('validate-review', {snapshotId: f.snapshot.snapshotId, attemptId: 'review-1', report: f.report});
      const ready = yield* f.mutate('ready', {
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
      expect(ready.next).toEqual({action: 'deliver', phaseId: 'one'});
      expect(
        yield* f.mutate('snapshot', {phaseId: 'two', snapshotId: 'two-too-early'}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'delivery-pending'}});
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Phase one']);
      const head = Effect2.pipe((yield* f.git(['rev-parse', 'HEAD'])).stdout, EffectString.trim);
      const delivered = yield* f.mutate('record-delivery', {
        phaseId: 'one',
        publication: {exemption: 'maintenance', reason: 'Private test, no feature publication.'},
        delivery: {
          phaseId: 'one',
          phaseHash: f.snapshot.phaseHash,
          delivery: 'pr',
          headSha: head,
          validatedTree: f.snapshot.tree,
          commitEvidence: 'Actual clean Git commit.',
          pr: {
            url: 'https://github.com/example/private-fixture/pull/1',
            headSha: head,
            branch: 'feature/one',
            baseBranch: 'main',
            state: 'open',
          },
          watch: {
            prUrl: 'https://github.com/example/private-fixture/pull/1',
            headSha: head,
            state: 'active',
            stateDir: f.path.join(f.root, 'watch'),
            consumerKind: 'orchestrator',
            consumerId: 'test',
            evidence: 'Private owned consumer fixture; no external poller.',
          },
        },
      });
      expect(delivered.next).toEqual({action: 'implement', phaseId: 'two'});
      expect((yield* f.inspect()).next).toEqual({action: 'implement', phaseId: 'two'});
      const before = yield* f.fs.readFileString(f.statePath());
      expect(yield* f.mutate('init', {plan: {schemaVersion: 1, phases: []}}).pipe(Effect.result)).toMatchObject({
        failure: {code: 'invalid-cycle'},
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      const invalidated = yield* f.mutate('invalidate', {phaseId: 'one', reason: 'Actual current-head CI failure.'});
      expect(invalidated.next).toMatchObject({action: 'blocked', phaseId: 'one'});
      const state = JSON.parse(yield* f.fs.readFileString(f.statePath()));
      const runtime = decodeNativeCycleRuntime(state.cycle);
      expect(runtime.state.phases.one?.delivery).toBeUndefined();
      expect(runtime.state.phases.one?.history?.[0]?.delivery?.headSha).toBe(head);
      expect(runtime.state.phases.two?.status).toBe('stale');
    }).pipe(run),
  );

  effectIt.effect(
    'preserves malformed review evidence, rejects stale source and stale CAS, and recovers failed receipt writes',
    () =>
      Effect.gen(function* () {
        const f = yield* reviewed();
        const stale = yield* f.inspect();
        const invalid = yield* f.mutate('validate-review', {
          snapshotId: f.snapshot.snapshotId,
          attemptId: 'malformed-1',
          report: {...f.report, lanes: []},
        });
        expect(invalid).toMatchObject({status: 'error', code: 'invalid-cycle-review'});
        const afterInvalid = yield* f.fs.readFileString(f.statePath());
        expect(
          yield* f
            .call({
              ...f.base('cycle'),
              command: 'invalidate',
              phaseId: 'one',
              reason: 'stale caller',
              expectedRevision: stale.revision,
            })
            .pipe(Effect.result),
        ).toMatchObject({failure: {code: 'state-conflict'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(afterInvalid);
        const original = yield* FileSystem.FileSystem;
        const failRename = FileSystem.FileSystem.of({
          ...original,
          rename: (from, to) =>
            Effect2.pipe(to, EffectString.endsWith('native-run.json'))
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: 'Unknown',
                    module: 'FileSystem',
                    method: 'rename',
                    description: 'Synthetic state receipt interruption',
                    pathOrDescriptor: to,
                  }),
                )
              : original.rename(from, to),
        });
        const interrupted = yield* f
          .mutate('validate-review', {snapshotId: f.snapshot.snapshotId, attemptId: 'recovered-1', report: f.report})
          .pipe(Effect.provideService(FileSystem.FileSystem, failRename), Effect.result);
        expect(Result.isFailure(interrupted)).toBe(true);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(afterInvalid);
        yield* f.mutate('validate-review', {
          snapshotId: f.snapshot.snapshotId,
          attemptId: 'recovered-1',
          report: f.report,
        });
        const state = JSON.parse(yield* f.fs.readFileString(f.statePath()));
        expect(EffectArray.map(decodeNativeCycleRuntime(state.cycle).attempts, item => item.status)).toEqual([
          'invalid',
          'accepted',
        ]);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const changed = true;\n');
        expect(
          yield* f.call({...f.base('cycle'), command: 'check', snapshotId: f.snapshot.snapshotId}).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'source-drift'}});
      }).pipe(run),
  );
});
