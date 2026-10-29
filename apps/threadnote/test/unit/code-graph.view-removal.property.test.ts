import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdtempSync, rmSync} from '@threadnote/testing/node-fs';
import {createHash} from '@threadnote/testing/node-crypto';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {CodeGraphStore, type CodeGraphViewRemovalResult} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '@threadnote/graph/types';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const WORKTREE_IDS = EffectArray.map(['1', '2', '3'], digit => Effect2.pipe(digit, EffectString.repeat(64)));
const snapshotId = (label: string) => `cgsn_${createHash('sha1').update(label).digest('hex')}`;
const SNAPSHOT_IDS = EffectArray.map(['model-0', 'model-1', 'model-2'], snapshotId);
const MISSING_SNAPSHOT_ID = snapshotId('model-missing');

const eventArbitrary = fc.record({
  kind: fc.constantFrom<'legacy-promote' | 'promote' | 'remove'>('legacy-promote', 'promote', 'remove'),
  snapshot: fc.integer({max: SNAPSHOT_IDS.length, min: 0}),
  worktree: fc.integer({max: WORKTREE_IDS.length - 1, min: 0}),
});

describe('code graph view removal state-machine properties', () => {
  fcEffectProp(
    effectIt,
    'matches the pointer/tombstone model and never mutates unrelated shared views',
    {events: fc.array(eventArbitrary, {maxLength: 20})},
    ({events}) =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* Effect.acquireRelease(
              Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-view-removal-property-'))),
              path => Effect.sync(() => rmSync(path, {force: true, recursive: true})),
            );
            const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
            const repositoryId = Effect2.pipe('b', EffectString.repeat(64));
            const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
            const pointers = new Map(
              EffectArray.map(WORKTREE_IDS, (worktreeId, index) => [worktreeId, SNAPSHOT_IDS[index]]),
            );
            const tombstones = new Map<string, string>();
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => seedModel(databasePath, repositoryId));
            yield* Effect.forEach(
              SNAPSHOT_IDS,
              snapshotId => store.acquireSnapshotLease(databasePath, snapshotId, 60 * 60_000),
              {concurrency: 1},
            );

            for (const event of events) {
              const worktreeId = WORKTREE_IDS[event.worktree];
              const snapshotId = SNAPSHOT_IDS[event.snapshot] ?? MISSING_SNAPSHOT_ID;
              if (event.kind === 'promote' && snapshotId !== MISSING_SNAPSHOT_ID) {
                yield* store.promote(databasePath, identity(root, checkoutId, repositoryId, worktreeId), snapshotId);
                pointers.set(worktreeId, snapshotId);
                tombstones.delete(worktreeId);
              } else if (event.kind === 'legacy-promote' && snapshotId !== MISSING_SNAPSHOT_ID) {
                yield* Effect.sync(() => legacyPromote(databasePath, worktreeId, snapshotId));
                pointers.set(worktreeId, snapshotId);
              } else {
                const expected = modelRemove(pointers, tombstones, worktreeId, snapshotId);
                const actual = yield* store.removeView(databasePath, worktreeId, snapshotId);
                expect(actual).toEqual(expected);
              }

              const databaseState = yield* Effect.sync(() => readModel(databasePath));
              expect(databaseState.pointers).toEqual(sortedEntries(pointers));
              expect(databaseState.tombstones).toEqual(sortedEntries(tombstones));
              expect(databaseState.readySnapshots).toEqual([...SNAPSHOT_IDS].sort());

              const expectedVisible = EffectArray.filter(
                [...pointers],
                ([worktreeId, snapshotId]) => tombstones.get(worktreeId) !== snapshotId,
              ).sort(([left], [right]) => Effect2.pipe(left, EffectString.localeCompare(right)));
              const catalogs = yield* store.loadVisualizationCatalogs(databasePath, 'deferred', {viewLimit: 64});
              expect(
                EffectArray.map(catalogs, catalog => [catalog.viewWorktreeId, catalog.snapshot.id] as const).sort(
                  ([left], [right]) => Effect2.pipe(left, EffectString.localeCompare(right)),
                ),
              ).toEqual(expectedVisible);
              for (const worktree of WORKTREE_IDS) {
                const pointer = pointers.get(worktree);
                const expectedReady =
                  pointer !== undefined && tombstones.get(worktree) !== pointer ? pointer : undefined;
                expect((yield* store.readySnapshot(databasePath, worktree))?.id).toBe(expectedReady);
              }
            }
          }),
        ),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 40}},
  );
});

function modelRemove(
  pointers: Map<string, string>,
  tombstones: Map<string, string>,
  worktreeId: string,
  expectedSnapshotId: string,
): CodeGraphViewRemovalResult {
  const activeSnapshotId = pointers.get(worktreeId);
  const removedSnapshotId = tombstones.get(worktreeId);
  if (activeSnapshotId !== undefined && activeSnapshotId !== expectedSnapshotId) {
    return {
      expectedSnapshotId,
      observedSnapshotId: activeSnapshotId,
      observedState: 'active',
      state: 'stale-target',
    };
  }
  if (activeSnapshotId === undefined) {
    if (removedSnapshotId === expectedSnapshotId) {
      return {expectedSnapshotId, retiredSnapshots: 0, state: 'already-removed'};
    }
    if (removedSnapshotId !== undefined) {
      return {
        expectedSnapshotId,
        observedSnapshotId: removedSnapshotId,
        observedState: 'removed',
        state: 'stale-target',
      };
    }
    return {expectedSnapshotId, state: 'not-found'};
  }
  pointers.delete(worktreeId);
  tombstones.set(worktreeId, expectedSnapshotId);
  return {
    expectedSnapshotId,
    retiredSnapshots: 0,
    state: removedSnapshotId === expectedSnapshotId ? 'already-removed' : 'removed',
  };
}

function seedModel(databasePath: string, repositoryId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run(
      `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES (?, 'threadnote/view-removal-property', 'sha1', ?, ?)`,
      [repositoryId, new Date(0).toISOString(), new Date(0).toISOString()],
    );
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, NULL, 'view-removal-property', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    const insertPointer = database.prepare(
      'INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)',
    );
    database.transaction(() => {
      for (const [index, snapshotId] of SNAPSHOT_IDS.entries()) {
        insertSnapshot.run(
          snapshotId,
          repositoryId,
          WORKTREE_IDS[index],
          Effect2.pipe(`${index}`, EffectString.padStart(40, '0')),
          `content-${index}`,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        insertGeneration.run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
        insertPointer.run(WORKTREE_IDS[index], snapshotId, new Date(index + 10).toISOString());
      }
    })();
  } finally {
    database.close(false);
  }
}

function legacyPromote(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
         VALUES (?, 'full-repository', ?, ?)
         ON CONFLICT(worktree_id, scope_id) DO UPDATE SET
           snapshot_id = excluded.snapshot_id,
           activated_at = excluded.activated_at`,
      )
      .run(worktreeId, snapshotId, new Date().toISOString());
  } finally {
    database.close(false);
  }
}

function readModel(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      pointers: EffectArray.map(
        database
          .query<{readonly snapshot_id: string; readonly worktree_id: string}, []>(
            'SELECT worktree_id, snapshot_id FROM active_snapshots ORDER BY worktree_id',
          )
          .all(),
        row => [row.worktree_id, row.snapshot_id] as const,
      ),
      readySnapshots: EffectArray.map(
        database.query<{readonly id: string}, []>("SELECT id FROM snapshots WHERE state = 'ready' ORDER BY id").all(),
        row => row.id,
      ),
      tombstones: EffectArray.map(
        database
          .query<{readonly expected_snapshot_id: string; readonly worktree_id: string}, []>(
            'SELECT worktree_id, expected_snapshot_id FROM removed_views ORDER BY worktree_id',
          )
          .all(),
        row => [row.worktree_id, row.expected_snapshot_id] as const,
      ),
    };
  } finally {
    database.close(false);
  }
}

function sortedEntries(entries: ReadonlyMap<string, string>): readonly (readonly [string, string])[] {
  return [...entries].sort(([left], [right]) => Effect2.pipe(left, EffectString.localeCompare(right)));
}

function identity(root: string, checkoutId: string, repositoryId: string, worktreeId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId,
    displayName: 'threadnote/view-removal-property',
    gitCommonDirectory: root,
    headCommit: Effect2.pipe('f', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repositoryId,
    repoRoot: root,
    worktreeId,
  };
}
