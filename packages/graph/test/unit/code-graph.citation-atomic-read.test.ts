import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as EffectString from 'effect/String';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphStore} from '@threadnote/graph/store';
import {isCodeGraphStoreError, type CodeGraphSnapshot, type RepositoryIdentity} from '@threadnote/graph/types';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const dependencies = CodeGraphStore.layer.pipe(Layer.provideMerge(citationPlatformLayer));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'citation-atomic-read-'});
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: EffectString.repeat(64)('d'),
    displayName: 'fixture',
    gitCommonDirectory: path.join(home, '.git'),
    headCommit: EffectString.repeat(40)('b'),
    objectFormat: 'sha1',
    repoRoot: home,
    repositoryId: EffectString.repeat(64)('a'),
    worktreeId: EffectString.repeat(64)('c'),
  };
  const snapshot: CodeGraphSnapshot = {
    id: 'cgsn_' + EffectString.repeat(40)('e'),
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    commit: identity.headCommit,
    extractorSet: 'fixture',
    dirty: false,
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
    state: 'ready',
    completedAt: '2026-11-01T00:00:00.000Z',
  };
  const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
  yield* store.activate(layout.databasePath, identity, snapshot, [], [], [], []);
  yield* store.promote(layout.databasePath, identity, snapshot.id);
  const ready = yield* store.readySnapshotById(layout.databasePath, snapshot.id);
  if (!ready) throw new Error('Expected a published ready snapshot');
  expect(ready).toMatchObject({id: snapshot.id, commit: identity.headCommit, state: 'ready'});
  const read = store.readReadySnapshotCitationEvidence;
  if (!read) throw new Error('Expected the atomic ready evidence capability');
  return {
    fs,
    home,
    path,
    snapshot: ready,
    read: (expected: CodeGraphSnapshot, databasePath = layout.databasePath) =>
      read(databasePath, expected, {paths: ['missing.ts']}),
  };
});

describe('atomic ready citation evidence', () => {
  effectIt.layer(dependencies)(it => {
    it.effect('returns typed failures for a missing database or an unopenable reader path', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const directory = f.path.join(f.home, 'directory.sqlite');
        yield* f.fs.makeDirectory(directory);
        for (const databasePath of [f.path.join(f.home, 'missing.sqlite'), directory]) {
          const result = yield* f.read(f.snapshot, databasePath).pipe(Effect.result);
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') expect(isCodeGraphStoreError(result.failure)).toBe(true);
        }
      }).pipe(TestClock.withLive),
    );
    it.effect('copies missing-path observations and accepts the caller worktree normalization for a shared alias', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const expected = yield* f.read(f.snapshot);
        expect(expected?.filesByPaths).toEqual([{path: 'missing.ts'}]);
        expect(yield* f.read({...f.snapshot, worktreeId: EffectString.repeat(64)('f')})).toEqual(expected);
        expect(yield* f.read({...f.snapshot, state: 'retired'})).toBeUndefined();
        expect(yield* f.read({...f.snapshot, dirty: true})).toBeUndefined();
        expect(yield* f.read({...f.snapshot, fileCount: 1})).toBeUndefined();
        expect(yield* f.read({...f.snapshot, symbolCount: 1})).toBeUndefined();
        expect(yield* f.read({...f.snapshot, edgeCount: 1})).toBeUndefined();
      }).pipe(TestClock.withLive),
    );
    fcEffectProp(
      it,
      'rejects a changed immutable snapshot identity without returning any evidence',
      {
        field: fc.constantFrom(
          'repositoryId',
          'commit',
          'extractorSet',
          'graphContentId',
          'overlayFingerprint',
          'scopeId',
          'baseSnapshotId',
          'completedAt',
          'id',
        ),
        suffix: fc.integer({min: 1, max: 100_000}),
      },
      ({field, suffix}) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          expect(yield* f.read({...f.snapshot, [field]: `changed-${suffix}`})).toBeUndefined();
          expect((yield* f.read(f.snapshot))?.filesByPaths).toEqual([{path: 'missing.ts'}]);
        }).pipe(TestClock.withLive),
      {fastCheck: {numRuns: 18}},
    );
  });
});
