import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {Clock, DateTime, Deferred, Effect, Fiber, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CodeGraphStore} from '@threadnote/graph/store';
import {codeGraphMaterializationSpoolPath} from '@threadnote/graph/materialization/spool';
import type {CodeGraphSnapshot, RepositoryIdentity} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {claimPersistentBuildForTest} from '@threadnote/graph/test/helpers/code-graph-build';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {join, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(EffectArray.map(temporaryRoots.splice(0), root => rm(root, {force: true, recursive: true})));
});

describe('code graph incomplete snapshot retirement', () => {
  it('revives an exact failed registration and rejects an incompatible identity collision', async () => {
    const root = await mkdtemp('threadnote-incomplete-retry-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root, 'repository-a', 'worktree-a');
    const snapshot = buildingSnapshot(identity, 'retry');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* store.markBuilding(databasePath, identity, snapshot);
        yield* store.markFailed(databasePath, snapshot.id, 'expected test failure');
        yield* store.markBuilding(databasePath, identity, snapshot);
      }),
    );

    const database = new Database(databasePath, {readonly: true});
    try {
      expect(
        database
          .query<{readonly failure_summary: string | null; readonly state: string}, [string]>(
            'SELECT state, failure_summary FROM snapshots WHERE id = ?',
          )
          .get(snapshot.id),
      ).toEqual({failure_summary: null, state: 'building'});
    } finally {
      database.close();
    }

    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.markBuilding(databasePath, identity, {
            ...snapshot,
            overlayFingerprint: 'different-overlay',
          });
        }),
      ),
    ).rejects.toThrow('already belongs to incompatible or ready content');
  });

  it('reclaims only superseded snapshots from the exact worktree and preserves retained, ready, active, and leased rows', async () => {
    const root = await mkdtemp('threadnote-incomplete-retirement-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root, 'repository-a', 'worktree-a');
    const otherWorktree = repositoryIdentity(root, 'repository-a', 'worktree-b');
    const snapshots = {
      active: buildingSnapshot(identity, 'active'),
      cleanOld: cleanBuildingSnapshot(identity, 'clean-old'),
      failed: buildingSnapshot(identity, 'failed'),
      leased: buildingSnapshot(identity, 'leased'),
      old: buildingSnapshot(identity, 'old'),
      other: buildingSnapshot(otherWorktree, 'other-worktree'),
      ready: buildingSnapshot(identity, 'ready'),
      retained: buildingSnapshot(identity, 'retained'),
    };

    const retired = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* claimPersistentBuildForTest(store, databasePath, identity, snapshots.old);
        yield* claimPersistentBuildForTest(store, databasePath, identity, snapshots.cleanOld);
        yield* store.markBuilding(databasePath, identity, snapshots.failed);
        yield* store.markFailed(databasePath, snapshots.failed.id, 'expected test failure');
        yield* store.markBuilding(databasePath, identity, snapshots.retained);
        yield* store.markBuilding(databasePath, identity, snapshots.ready);
        yield* store.markBuilding(databasePath, identity, snapshots.active);
        yield* store.markBuilding(databasePath, identity, snapshots.leased);
        yield* store.markBuilding(databasePath, otherWorktree, snapshots.other);
        const activatedAt = DateTime.formatIso(yield* DateTime.now);
        const expiresAt = (yield* Clock.currentTimeMillis) + 60_000;
        yield* Effect.sync(() => {
          const database = new Database(databasePath);
          try {
            database.query("UPDATE snapshots SET state = 'ready' WHERE id = ?").run(snapshots.ready.id);
            database
              .query(
                "INSERT INTO snapshot_extractor_generations (snapshot_id, generation) SELECT ?, CAST(value AS INTEGER) FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
              )
              .run(snapshots.active.id);
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(identity.worktreeId, snapshots.active.id, activatedAt);
            database
              .query('INSERT INTO snapshot_leases (token, snapshot_id, expires_at) VALUES (?, ?, ?)')
              .run('leased-test-snapshot', snapshots.leased.id, expiresAt);
          } finally {
            database.close();
          }
        });
        return yield* store.retireIncompleteWorktreeSnapshots(
          databasePath,
          identity.repositoryId,
          identity.worktreeId,
          new Set([snapshots.retained.id]),
        );
      }),
    );

    expect(retired).toBe(3);
    const database = new Database(databasePath, {readonly: true});
    try {
      const states = new Map(
        EffectArray.map(
          database
            .query<{readonly id: string; readonly state: string}, []>('SELECT id, state FROM snapshots ORDER BY id')
            .all(),
          row => [row.id, row.state],
        ),
      );
      expect(states.has(snapshots.old.id)).toBe(false);
      expect(states.has(snapshots.cleanOld.id)).toBe(false);
      expect(states.has(snapshots.failed.id)).toBe(false);
      expect(states.get(snapshots.retained.id)).toBe('building');
      expect(states.get(snapshots.ready.id)).toBe('ready');
      expect(states.get(snapshots.active.id)).toBe('building');
      expect(states.get(snapshots.leased.id)).toBe('building');
      expect(states.get(snapshots.other.id)).toBe('building');
      expect(
        database
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM snapshot_build_owners WHERE snapshot_id = ?',
          )
          .get(snapshots.old.id)?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  effectIt.effect(
    'drains required direct-build cleanup in bounded pages while yielding the writer gate',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp('threadnote-incomplete-reclaim-')),
        root =>
          Effect.gen(function* () {
            const databasePath = join(root, 'graph-v3.sqlite');
            const writerLockPath = join(root, 'checkout-writer.lock');
            const identity = repositoryIdentity(root, 'repository-a', 'worktree-a');
            const otherWorktree = repositoryIdentity(root, 'repository-a', 'worktree-b');
            const stale = buildingSnapshot(identity, 'stale-direct');
            const siblingRetired = buildingSnapshot(otherWorktree, 'stale-sibling');
            const foreground = buildingSnapshot(otherWorktree, 'foreground');
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* claimPersistentBuildForTest(store, databasePath, identity, stale);
            yield* store.markBuilding(databasePath, otherWorktree, siblingRetired);
            yield* Effect.sync(() => seedLargeInterruptedBuild(databasePath, stale.id));
            yield* Effect.sync(() => seedLargeInterruptedBuild(databasePath, siblingRetired.id));
            const cleanupAcquisitions = yield* Ref.make(0);
            const cleanupPageAcquired = yield* Deferred.make<void>();
            const releaseCleanupPage = yield* Deferred.make<void>();
            const foregroundContended = yield* Deferred.make<void>();
            const foregroundAcquired = yield* Deferred.make<void>();
            const releaseForeground = yield* Deferred.make<void>();
            const progress = yield* Ref.make<
              readonly {
                readonly pagesCompleted: number;
                readonly rowsDeleted: number;
                readonly snapshotsCompleted: number;
                readonly snapshotsTotal: number;
              }[]
            >([]);

            const retirement = yield* store
              .withSession(
                databasePath,
                store.retireIncompleteWorktreeSnapshots(
                  databasePath,
                  identity.repositoryId,
                  identity.worktreeId,
                  new Set(),
                  update => Ref.update(progress, updates => [...updates, update]),
                ),
                {
                  onWriterAcquired: () =>
                    Ref.updateAndGet(cleanupAcquisitions, count => count + 1).pipe(
                      Effect.flatMap(acquisition =>
                        acquisition === 2
                          ? Deferred.succeed(cleanupPageAcquired, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseCleanupPage)),
                            )
                          : Effect.void,
                      ),
                    ),
                  writerLockPath,
                },
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(cleanupPageAcquired);

            const foregroundWrite = yield* store
              .withSession(databasePath, store.markBuilding(databasePath, otherWorktree, foreground), {
                onWriterAcquired: () =>
                  Deferred.succeed(foregroundAcquired, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseForeground)),
                  ),
                onWriterContention: () => Deferred.succeed(foregroundContended, undefined).pipe(Effect.asVoid),
                writerLockPath,
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(foregroundContended);
            yield* Deferred.succeed(releaseCleanupPage, undefined);
            yield* Deferred.await(foregroundAcquired);
            yield* Deferred.succeed(releaseForeground, undefined);
            yield* Fiber.join(foregroundWrite);
            const retired = yield* Fiber.join(retirement);
            const acquisitions = yield* Ref.get(cleanupAcquisitions);
            const updates = yield* Ref.get(progress);
            expect(retired).toBe(0);
            expect(acquisitions).toBeGreaterThan(2);
            expect(updates.length).toBeGreaterThan(2);
            expect(updates[0]).toEqual({
              pagesCompleted: 0,
              rowsDeleted: 0,
              snapshotsCompleted: 0,
              snapshotsTotal: 2,
            });
            expect(updates[1]?.pagesCompleted).toBe(1);
            expect(EffectArray.every(updates, update => update.snapshotsTotal === 2)).toBe(true);
            expect(updates[1]?.rowsDeleted).toBeGreaterThan(0);
            expect(updates[1]?.rowsDeleted).toBeLessThan(13_501);
            expect(updates[1]?.snapshotsCompleted).toBe(0);
            expect(updates.at(-1)?.snapshotsCompleted).toBe(2);
            yield* Effect.sync(() => {
              const database = new Database(databasePath, {readonly: true});
              try {
                expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(stale.id)).toBeNull();
                expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(siblingRetired.id)).toBeNull();
                expect(
                  database
                    .query<{readonly state: string}, [string]>('SELECT state FROM snapshots WHERE id = ?')
                    .get(foreground.id),
                ).toEqual({state: 'building'});
                expect(interruptedRowCount(databasePath, stale.id)).toBe(0);
                expect(interruptedRowCount(databasePath, siblingRetired.id)).toBe(0);
                expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
              } finally {
                database.close();
              }
            });
          }),
        root => Effect.promise(() => rm(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    15_000,
  );

  effectIt.effect(
    'defers repository-sized physical cleanup after one bounded retirement transaction',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp('threadnote-incomplete-deferred-reclaim-')),
        root =>
          Effect.gen(function* () {
            const databasePath = join(root, 'graph-v3.sqlite');
            const writerLockPath = join(root, 'checkout-writer.lock');
            const identity = repositoryIdentity(root, 'repository-a', 'worktree-a');
            const stale = buildingSnapshot(identity, 'stale-deferred');
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* claimPersistentBuildForTest(store, databasePath, identity, stale);
            yield* Effect.sync(() => seedLargeInterruptedBuild(databasePath, stale.id, false));

            const retirementAcquisitions = yield* Ref.make(0);
            const retired = yield* store.withSession(
              databasePath,
              store.retireIncompleteWorktreeSnapshots(
                databasePath,
                identity.repositoryId,
                identity.worktreeId,
                new Set(),
                undefined,
                {cleanupMode: 'deferred'},
              ),
              {
                onWriterAcquired: () => Ref.update(retirementAcquisitions, count => count + 1),
                writerLockPath,
              },
            );
            const retainedRows = yield* Effect.sync(() => interruptedRowCount(databasePath, stale.id));
            yield* store.withSession(databasePath, store.pruneRetiredSnapshots(databasePath), {writerLockPath});
            const result = {
              acquisitions: yield* Ref.get(retirementAcquisitions),
              retainedRows,
              retired,
            };

            expect(result.acquisitions).toBe(2);
            expect(result.retainedRows).toBeGreaterThan(0);
            expect(result.retainedRows).toBeLessThan(13_500);
            expect(result.retired).toBe(1);
            const database = new Database(databasePath, {readonly: true});
            try {
              expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(stale.id)).toBeNull();
              expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
            } finally {
              database.close();
            }
          }),
        root => Effect.promise(() => rm(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    15_000,
  );

  effectIt.effect(
    'reclaims a failed persistent build before returning to the indexer',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp('threadnote-failed-persistent-reclaim-')),
        root =>
          Effect.gen(function* () {
            const databasePath = join(root, 'graph-v3.sqlite');
            const identity = repositoryIdentity(root, 'repository-a', 'worktree-a');
            const stale = buildingSnapshot(identity, 'failed-direct');
            const store = yield* CodeGraphStore;
            const path = yield* Path.Path;
            yield* store.initialize(databasePath);
            const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, identity, stale);
            yield* Effect.sync(() => seedLargeInterruptedBuild(databasePath, stale.id, false));
            const spoolPath = codeGraphMaterializationSpoolPath(path, {repositoryRoot: root}, stale.id);
            for (const candidate of [spoolPath, `${spoolPath}-shm`, `${spoolPath}-wal`]) {
              yield* Effect.promise(() => writeFile(candidate, 'stale spool'));
            }
            yield* store.markFailed(databasePath, stale.id, 'expected activation failure', ownerToken);
            for (const candidate of [spoolPath, `${spoolPath}-shm`, `${spoolPath}-wal`]) {
              expect(yield* Effect.promise(() => Bun.file(candidate).exists())).toBe(false);
            }
            yield* Effect.sync(() => {
              const database = new Database(databasePath, {readonly: true});
              try {
                expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(stale.id)).toBeNull();
                expect(interruptedRowCount(databasePath, stale.id)).toBe(0);
                expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
              } finally {
                database.close();
              }
            });
          }),
        root => Effect.promise(() => rm(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    15_000,
  );

  fcEffectProp(
    effectIt,
    'required cleanup drains any bounded set of stale snapshots and is idempotent',
    [fc.integer({min: 0, max: 4})],
    ([count]) =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp('threadnote-required-reclaim-property-')),
        root =>
          Effect.gen(function* () {
            const databasePath = join(root, 'graph-v3.sqlite');
            const identity = repositoryIdentity(root, 'repository-a', 'worktree-a');
            const snapshots = Array.from({length: count}, (_, index) => buildingSnapshot(identity, `stale-${index}`));
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            for (const snapshot of snapshots) yield* store.markBuilding(databasePath, identity, snapshot);
            yield* Effect.sync(() => {
              const database = new Database(databasePath);
              try {
                for (const snapshot of snapshots) seedInterruptedSymbol(database, snapshot.id, snapshot.id);
              } finally {
                database.close();
              }
            });
            const first = yield* store.retireIncompleteWorktreeSnapshots(
              databasePath,
              identity.repositoryId,
              identity.worktreeId,
              new Set(),
            );
            const second = yield* store.retireIncompleteWorktreeSnapshots(
              databasePath,
              identity.repositoryId,
              identity.worktreeId,
              new Set(),
            );
            expect(first).toBe(count);
            expect(second).toBe(0);
            yield* Effect.sync(() => {
              const database = new Database(databasePath, {readonly: true});
              try {
                expect(database.query('SELECT id FROM snapshots').all()).toEqual([]);
                expect(database.query('SELECT snapshot_id FROM symbols').all()).toEqual([]);
                expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
              } finally {
                database.close();
              }
            });
          }),
        root => Effect.promise(() => rm(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {fastCheck: {numRuns: 8}, timeout: 15_000},
  );

  it('never reclaims another worktree from PID, age, or failed-state hints alone', async () => {
    const root = await mkdtemp('threadnote-incomplete-orphan-reclaim-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const survivor = repositoryIdentity(root, 'repository-a', 'worktree-survivor');
    const removedDead = repositoryIdentity(root, 'repository-a', 'worktree-removed-dead');
    const removedLive = repositoryIdentity(root, 'repository-a', 'worktree-removed-live');
    const removedFailed = repositoryIdentity(root, 'repository-a', 'worktree-removed-failed');
    const survivorSnapshot = buildingSnapshot(survivor, 'survivor');
    const deadSnapshot = buildingSnapshot(removedDead, 'removed-dead');
    const liveSnapshot = buildingSnapshot(removedLive, 'removed-live');
    const failedSnapshot = buildingSnapshot(removedFailed, 'removed-failed');
    const progress: {
      readonly pagesCompleted: number;
      readonly rowsDeleted: number;
      readonly snapshotsCompleted: number;
      readonly snapshotsTotal: number;
    }[] = [];

    const retired = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* store.markBuilding(databasePath, survivor, survivorSnapshot);
        yield* claimPersistentBuildForTest(store, databasePath, removedDead, deadSnapshot);
        yield* claimPersistentBuildForTest(store, databasePath, removedLive, liveSnapshot);
        yield* store.markBuilding(databasePath, removedFailed, failedSnapshot);
        yield* store.markFailed(databasePath, failedSnapshot.id, 'expected removed-worktree failure');
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database
              .query('UPDATE snapshot_build_owners SET owner_token = ? WHERE snapshot_id = ?')
              .run('999999:stale-owner', deadSnapshot.id);
            seedInterruptedSymbol(database, deadSnapshot.id, 'dead-symbol');
            seedInterruptedSymbol(database, failedSnapshot.id, 'failed-symbol');
          } finally {
            database.close();
          }
        });
        return yield* store.retireIncompleteWorktreeSnapshots(
          databasePath,
          survivor.repositoryId,
          survivor.worktreeId,
          new Set([survivorSnapshot.id]),
          update => Effect.sync(() => progress.push(update)),
        );
      }),
    );

    expect(retired).toBe(0);
    expect(progress).toEqual([]);
    const database = new Database(databasePath, {readonly: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(deadSnapshot.id)).toEqual({
        state: 'building',
      });
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(failedSnapshot.id)).toEqual({
        state: 'failed',
      });
      expect(
        database
          .query<{readonly state: string}, [string]>('SELECT state FROM snapshots WHERE id = ?')
          .get(liveSnapshot.id),
      ).toEqual({state: 'building'});
      expect(
        database
          .query<{readonly state: string}, [string]>('SELECT state FROM snapshots WHERE id = ?')
          .get(survivorSnapshot.id),
      ).toEqual({state: 'building'});
      expect(
        database
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM snapshot_build_owners WHERE snapshot_id = ?',
          )
          .get(liveSnapshot.id)?.count,
      ).toBe(1);
      expect(
        database
          .query<{readonly count: number}, [string, string]>(
            'SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id IN (?, ?)',
          )
          .get(deadSnapshot.id, failedSnapshot.id)?.count,
      ).toBe(2);
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each([
    ['retired direct candidate before default-mode selection', 'retired-direct'],
    ['retired logical candidate before explicit full-mode selection', 'retired-logical'],
  ])('reclaims a retained %s', async (_, suffix) => {
    const root = await mkdtemp('threadnote-incomplete-retained-reclaim-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root, 'repository-a', 'worktree-a');
    const stale = buildingSnapshot(identity, suffix);

    const retired = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* store.markBuilding(databasePath, identity, stale);
        yield* Effect.sync(() => {
          const database = new Database(databasePath);
          try {
            database.query("UPDATE snapshots SET state = 'retired' WHERE id = ?").run(stale.id);
          } finally {
            database.close();
          }
        });
        return yield* store.retireIncompleteWorktreeSnapshots(
          databasePath,
          identity.repositoryId,
          identity.worktreeId,
          new Set([stale.id]),
        );
      }),
    );

    expect(retired).toBe(0);
    const database = new Database(databasePath, {readonly: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(stale.id)).toBeNull();
    } finally {
      database.close();
    }
  });
});

function seedLargeInterruptedBuild(databasePath: string, snapshotId: string, retired = true): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insertSymbol = database.prepare(
      `INSERT INTO symbols (
         snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
         arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
         exported, signature, documentation, span_json
       ) VALUES (?, ?, ?, 'function', ?, ?, 'src/stale.ts', 'typescript', NULL, '[]',
         'typescript', NULL, NULL, 0, NULL, NULL, '{"startLine":1,"endLine":1}')`,
    );
    const insertTerm = database.prepare(
      'INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight) VALUES (?, ?, ?, 1)',
    );
    const insertEdge = database.prepare(
      `INSERT INTO edges (
         snapshot_id, id, source_id, source_name, relation, target_id, target_name,
         provenance, confidence, evidence_path, evidence_span_json
       ) VALUES (?, ?, NULL, ?, 'calls', NULL, ?, 'ast', 1, 'src/stale.ts',
         '{"startLine":1,"endLine":1}')`,
    );
    database.transaction(() => {
      for (let index = 0; index < 2_100; index += 1) {
        const id = `stale-symbol-${Effect2.pipe(index.toString(), EffectString.padStart(4, '0'))}`;
        insertSymbol.run(snapshotId, id, `hash-${index}`, `stale${index}`, `stale${index}`);
        for (let term = 0; term < 3; term += 1) insertTerm.run(snapshotId, `term-${term}`, id);
      }
      for (let index = 0; index < 5_100; index += 1) {
        insertEdge.run(
          snapshotId,
          `stale-edge-${Effect2.pipe(index.toString(), EffectString.padStart(4, '0'))}`,
          `source${index}`,
          `target${index}`,
        );
      }
      if (retired) database.query("UPDATE snapshots SET state = 'retired' WHERE id = ?").run(snapshotId);
    })();
  } finally {
    database.close();
  }
}

function interruptedRowCount(databasePath: string, snapshotId: string): number {
  const database = new Database(databasePath, {readonly: true});
  try {
    return EffectArray.reduce(
      ['symbols', 'symbol_terms', 'edges'],
      0,
      (total, table) =>
        total +
        Number(
          database
            .query<{readonly count: number}, [string]>(`SELECT COUNT(*) AS count FROM ${table} WHERE snapshot_id = ?`)
            .get(snapshotId)?.count ?? 0,
        ),
    );
  } finally {
    database.close();
  }
}

function seedInterruptedSymbol(database: Database, snapshotId: string, symbolId: string): void {
  database
    .query(
      `INSERT INTO symbols (
         snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
         arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
         exported, signature, documentation, span_json
       ) VALUES (?, ?, ?, 'function', ?, ?, 'src/stale.ts', 'typescript', NULL, '[]',
         'typescript', NULL, NULL, 0, NULL, NULL, '{"startLine":1,"endLine":1}')`,
    )
    .run(snapshotId, symbolId, `hash-${symbolId}`, symbolId, symbolId);
}

function repositoryIdentity(root: string, repositoryId: string, worktreeId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
    displayName: 'retirement-fixture',
    gitCommonDirectory: root,
    headCommit: Effect2.pipe('1', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId,
    worktreeId,
  };
}

function buildingSnapshot(identity: RepositoryIdentity, suffix: string): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: true,
    edgeCount: 0,
    extractorSet: 'extractor-set',
    fileCount: 0,
    id: `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}-full-${Effect2.pipe(sha256HexSync(suffix), EffectString.slice(0, 16))}`,
    overlayFingerprint: `overlay-${suffix}`,
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}

function cleanBuildingSnapshot(identity: RepositoryIdentity, suffix: string): CodeGraphSnapshot {
  const snapshot = buildingSnapshot(identity, suffix);
  return {...snapshot, dirty: false, overlayFingerprint: undefined};
}
