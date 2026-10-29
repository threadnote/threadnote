import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'fast-check';
import {CodeGraphStore, type CodeGraphViewObservationResult} from '@threadnote/graph/store';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const WORKTREE_ID = Effect2.pipe('1', EffectString.repeat(64));
const EXPECTED = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
const OTHER = `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`;

const observationCase = FC.record({
  active: FC.constantFrom<string | undefined>(undefined, EXPECTED, OTHER),
  activeTable: FC.boolean(),
  removed: FC.constantFrom<string | undefined>(undefined, EXPECTED, OTHER),
  removedTable: FC.boolean(),
});

const ObservationTestLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

describe('code graph view-removal observation properties', () => {
  effectIt.layer(ObservationTestLayer)(layerIt => {
    fcEffectProp(
      layerIt,
      'matches the independent pointer/tombstone model without changing or completing a partial database',
      {fixture: observationCase},
      ({fixture}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const store = yield* CodeGraphStore;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-view-observation-property-'});
            const databasePath = path.join(home, 'graph-v3.sqlite');
            yield* Effect.sync(() => seedObservationDatabase(databasePath, fixture));
            const before = yield* fs.readFile(databasePath);

            const observed = yield* store.observeView(databasePath, WORKTREE_ID, EXPECTED);

            expect(observed).toEqual(modelObservation(fixture));
            expect(yield* fs.readFile(databasePath)).toEqual(before);
            expect(readTableNames(databasePath)).toEqual(
              EffectArray.filter(
                [
                  fixture.activeTable ? 'active_snapshots' : undefined,
                  fixture.removedTable ? 'removed_views' : undefined,
                ],
                (name): name is string => name !== undefined,
              ).sort(),
            );
            expect(yield* fs.exists(`${databasePath}-wal`)).toBe(false);
            expect(yield* fs.exists(`${databasePath}-shm`)).toBe(false);
          }),
        ),
      {fastCheck: {numRuns: 40}},
    );

    layerIt.effect('returns not-found without creating a checkout database or parent directories', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-view-observation-missing-'});
          const databasePath = path.join(home, 'absent', 'graph-v3.sqlite');

          expect(yield* store.observeView(databasePath, WORKTREE_ID, EXPECTED)).toEqual({
            expectedSnapshotId: EXPECTED,
            state: 'not-found',
          });
          expect(yield* fs.exists(databasePath)).toBe(false);
          expect(yield* fs.exists(path.dirname(databasePath))).toBe(false);
        }),
      ),
    );
  });
});

interface ObservationFixture {
  readonly active?: string;
  readonly activeTable: boolean;
  readonly removed?: string;
  readonly removedTable: boolean;
}

function seedObservationDatabase(databasePath: string, fixture: ObservationFixture): void {
  const database = new Database(databasePath, {create: true, strict: true});
  try {
    if (fixture.activeTable) {
      database.run('CREATE TABLE active_snapshots (worktree_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL)');
      if (fixture.active !== undefined) {
        database
          .query('INSERT INTO active_snapshots (worktree_id, snapshot_id) VALUES (?, ?)')
          .run(WORKTREE_ID, fixture.active);
      }
    }
    if (fixture.removedTable) {
      database.run('CREATE TABLE removed_views (worktree_id TEXT PRIMARY KEY, expected_snapshot_id TEXT NOT NULL)');
      if (fixture.removed !== undefined) {
        database
          .query('INSERT INTO removed_views (worktree_id, expected_snapshot_id) VALUES (?, ?)')
          .run(WORKTREE_ID, fixture.removed);
      }
    }
  } finally {
    database.close(false);
  }
}

function modelObservation(fixture: ObservationFixture): CodeGraphViewObservationResult {
  const active = fixture.activeTable ? fixture.active : undefined;
  const removed = fixture.removedTable ? fixture.removed : undefined;
  if (active !== undefined && active !== EXPECTED) {
    return {
      expectedSnapshotId: EXPECTED,
      observedSnapshotId: active,
      observedState: 'active',
      state: 'stale-target',
    };
  }
  if (active === EXPECTED) {
    return {expectedSnapshotId: EXPECTED, state: removed === EXPECTED ? 'already-removed' : 'ready'};
  }
  if (removed === EXPECTED) return {expectedSnapshotId: EXPECTED, state: 'already-removed'};
  if (removed !== undefined) {
    return {
      expectedSnapshotId: EXPECTED,
      observedSnapshotId: removed,
      observedState: 'removed',
      state: 'stale-target',
    };
  }
  return {expectedSnapshotId: EXPECTED, state: 'not-found'};
}

function readTableNames(databasePath: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return EffectArray.map(
      database
        .query<{readonly name: string}, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all(),
      row => row.name,
    );
  } finally {
    database.close(false);
  }
}
