import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, FileSystem, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {makeCodeGraphBuildReporter, parseCodeGraphBuildStatus} from '@threadnote/graph/build_status';
import {codeGraphLayout, codeGraphSnapshotBuildLockPath} from '@threadnote/graph/layout';
import {
  COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS,
  completedPersistentBuildDrainPageStatement,
} from '@threadnote/graph/store/activation/core';
import {
  CodeGraphMaintenanceCoordinator,
  makeCodeGraphMaintenanceCoordinator,
  type CodeGraphRoutineMaintenanceTick,
} from '@threadnote/graph/maintenance/coordinator';
import {
  CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE,
  codeGraphRoutineFileBlobCleanupPageStatement,
  codeGraphRoutineMaterializedShardCleanupPageStatement,
  CodeGraphStore,
  type CodeGraphRoutineMaintenanceResult,
} from '@threadnote/graph/store';
import {withCodeGraphMaintenanceIntent} from '@threadnote/graph/maintenance/gate';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  CODE_GRAPH_EXTRACTOR_GENERATION,
  CodeGraphStoreError,
  type CodeGraphSnapshot,
  type CodeGraphStoreFailure,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {legacyCodeGraphAuthorityStatements} from '@threadnote/graph/test/helpers/code-graph-legacy-authority';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const temporaryHomes: string[] = [];
const ROUTINE_CACHE_ALL_ELIGIBLE = '9999-12-31T23:59:59.999Z';

afterEach(async () => {
  await Promise.all(EffectArray.map(temporaryHomes.splice(0), home => rm(home, {force: true, recursive: true})));
});

describe('routine code graph maintenance', () => {
  it('seeks completed build rows by snapshot before taking a bounded cleanup page', () => {
    const spec = COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS[0];
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), {maxLength: 6}),
        fc.option(fc.integer({max: 11, min: 0}), {nil: undefined}),
        (additionalBuilding, targetIndex) => {
          const building = [false, true, false, false, true, false, ...additionalBuilding];
          const database = new Database(':memory:', {strict: true});
          try {
            database.exec(`
              CREATE TABLE snapshots (id TEXT PRIMARY KEY, state TEXT NOT NULL);
              CREATE TABLE building_reference_candidates (
                snapshot_id TEXT NOT NULL, edge_id TEXT NOT NULL, tier INTEGER NOT NULL,
                lookup_key TEXT NOT NULL, PRIMARY KEY (snapshot_id, edge_id, tier, lookup_key)
              ) WITHOUT ROWID;
            `);
            for (const [index, active] of building.entries()) {
              const id = `snapshot-${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}`;
              database.query('INSERT INTO snapshots VALUES (?, ?)').run(id, active ? 'building' : 'ready');
              database.query('INSERT INTO building_reference_candidates VALUES (?, ?, 0, ?)').run(id, 'edge', 'key');
            }
            const target =
              targetIndex === undefined
                ? undefined
                : `snapshot-${Effect2.pipe((targetIndex % building.length).toString(), EffectString.padStart(2, '0'))}`;
            const statement = completedPersistentBuildDrainPageStatement(spec, 3, target);
            const plan = database
              .query<
                {
                  readonly detail: string;
                },
                SQLQueryBindings[]
              >(`EXPLAIN QUERY PLAN ${statement.text}`)
              .all(...statement.parameters);
            expect(
              EffectArray.some(plan, row =>
                Effect2.pipe(row.detail, EffectString.includes('SEARCH candidate USING PRIMARY KEY (snapshot_id=?)')),
              ),
            ).toBe(true);
            expect(EffectArray.some(plan, row => /SCAN candidate|USE TEMP B-TREE/u.test(row.detail))).toBe(false);
            const ids = EffectArray.map(
              building,
              (_, index) => `snapshot-${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}`,
            );
            const eligible = EffectArray.filter(
              ids,
              (id, index) => !building[index] && (target === undefined || target === id),
            );
            const remainingIds = () =>
              EffectArray.map(
                database
                  .query<{readonly snapshot_id: string}, SQLQueryBindings[]>(
                    'SELECT snapshot_id FROM building_reference_candidates ORDER BY snapshot_id',
                  )
                  .all(),
                row => row.snapshot_id,
              );
            database.query(statement.text).run(...statement.parameters);
            expect(remainingIds()).toEqual(EffectArray.filter(ids, id => !eligible.slice(0, 3).includes(id)));
            for (let page = 0; page < 4; page += 1) {
              database.query(statement.text).run(...statement.parameters);
            }
            expect(remainingIds()).toEqual(EffectArray.filter(ids, id => !eligible.includes(id)));
          } finally {
            database.close(false);
          }
        },
      ),
      {numRuns: 30},
    );
  });

  it('defers immediately on checkout writer contention without opening SQLite', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-contention-', false);
    await writeFile(fixture.databasePath, 'must not be opened while the writer gate is held');

    const observed = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            fixture.writerLockPath,
            {
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const startedAt = performance.now();
        const result = yield* store.runRoutineMaintenance(fixture.databasePath, {
          writerLockPath: fixture.writerLockPath,
        });
        const elapsedMilliseconds = performance.now() - startedAt;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        return {elapsedMilliseconds, result};
      }),
    );

    expect(observed.result).toEqual({reason: 'writer-busy', state: 'deferred'});
    expect(observed.elapsedMilliseconds).toBeLessThan(500);
    await expect(Bun.file(fixture.databasePath).text()).resolves.toContain('must not be opened');
  });

  it('defers an explicit global maintenance intent before opening SQLite', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-intent-', false);
    await writeFile(fixture.databasePath, 'must not be opened during explicit maintenance');

    const result = await runEffect(
      Effect.gen(function* () {
        const coordinator = yield* CodeGraphMaintenanceCoordinator;
        return yield* withCodeGraphMaintenanceIntent(
          fixture.home,
          coordinator.tick({
            checkoutId: fixture.checkoutId,
            databasePath: fixture.databasePath,
            threadnoteHome: fixture.home,
            writerLockPath: fixture.writerLockPath,
          }),
        );
      }),
    );

    expect(result).toEqual({reason: 'external-maintenance', state: 'deferred'});
    await expect(Bun.file(fixture.databasePath).text()).resolves.toContain('must not be opened');
  });

  effectIt.effect('automatically prunes an abandoned waiter sidecar without a successor build', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryHome = yield* fs.makeTempDirectory({prefix: 'threadnote-routine-abandoned-status-'});
      const home = yield* fs.realPath(temporaryHome);
      temporaryHomes.push(home);
      const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
      const identity = {...routineMaintenanceAnchor(), checkoutId, repoRoot: home};
      const layout = codeGraphLayout(path, home, checkoutId, identity.worktreeId);
      yield* fs.makeDirectory(path.dirname(layout.databasePath), {recursive: true});
      const store = yield* CodeGraphStore;
      yield* store.initialize(layout.databasePath);
      const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
      const statusPath = path.join(
        layout.repositoryRoot,
        'build-status',
        identity.worktreeId,
        `${reporter.ownerIdentity.buildId}.json`,
      );
      const status = parseCodeGraphBuildStatus(JSON.parse(yield* fs.readFileString(statusPath)));
      if (status === undefined) throw new Error('Persisted code graph build status was invalid.');
      yield* fs.writeFileString(
        statusPath,
        `${JSON.stringify({
          ...status,
          owner: {...status.owner, processId: 2_147_483_647, processStartIdentity: 'dead-process-instance'},
        })}\n`,
        {flag: 'w', mode: 0o600},
      );

      const coordinator = yield* CodeGraphMaintenanceCoordinator;
      for (let attempt = 0; attempt < 3 && (yield* fs.exists(statusPath)); attempt += 1) {
        yield* coordinator.tick({
          anchorIdentity: identity,
          automaticTail: false,
          checkoutId,
          databasePath: layout.databasePath,
          threadnoteHome: home,
          writerLockPath: layout.databaseWriteLockPath,
        });
      }

      expect(yield* fs.exists(statusPath)).toBe(false);
      expect(
        yield* fs.exists(
          path.join(
            layout.repositoryRoot,
            'build-status',
            identity.worktreeId,
            `${reporter.ownerIdentity.buildId}.manager-context`,
          ),
        ),
      ).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('reclaims exactly one physical table page per tick and becomes idempotent', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-page-');
    seedCleanupPages(fixture.databasePath);

    const results = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const run = () => store.runRoutineMaintenance(fixture.databasePath, {writerLockPath: fixture.writerLockPath});
        return [yield* run(), yield* run(), yield* run(), yield* run(), yield* run()] as const;
      }),
    );

    expect(results[0]).toMatchObject({cleanup: 'completed-build', rowsDeleted: 1, state: 'completed'});
    expect(results[1]).toMatchObject({cleanup: 'retired-snapshot', rowsDeleted: 1, state: 'completed'});
    expect(results[2]).toMatchObject({cleanup: 'retired-snapshot', rowsDeleted: 1, state: 'completed'});
    expect(results[3]).toEqual({
      cleanup: 'none',
      expiredLeases: 0,
      remaining: false,
      retiredSnapshots: 0,
      rowsDeleted: 0,
      state: 'completed',
    });
    expect(results[4]).toEqual(results[3]);

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT COUNT(*) AS count FROM building_lexical_counters').get()).toEqual({count: 0});
      expect(database.query("SELECT COUNT(*) AS count FROM snapshots WHERE state = 'retired'").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close(false);
    }
  });

  it('reclaims parser blobs before materialized shards in bounded pages and preserves live cache rows', async () => {
    const fixture = await routineFixture('threadnote-routine-cache-page-');
    seedRoutineCacheRows(
      fixture.databasePath,
      CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE + 1,
      CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE + 1,
    );

    const results = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const run = () => store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
        return [yield* run(), yield* run(), yield* run(), yield* run(), yield* run(), yield* run()] as const;
      }),
    );

    expect(results[0]).toMatchObject({
      cleanup: 'file-blob-cache',
      remaining: true,
      rowsDeleted: CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE,
    });
    expect(results[1]).toMatchObject({cleanup: 'file-blob-cache', remaining: true, rowsDeleted: 1});
    expect(results[2]).toMatchObject({
      cleanup: 'materialized-shard-cache',
      remaining: true,
      rowsDeleted: CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE,
    });
    expect(results[3]).toMatchObject({cleanup: 'materialized-shard-cache', remaining: false, rowsDeleted: 1});
    expect(results[4]).toMatchObject({cleanup: 'none', remaining: true, rowsDeleted: 0});
    expect(results[5]).toEqual(noWorkResult);
    expect(readRoutineCacheCounts(fixture.databasePath)).toEqual({fileBlobs: 1, materializedShards: 1});
  });

  it('does not reclaim fresh cache rows while any persistent snapshot is still building', async () => {
    const fixture = await routineFixture('threadnote-routine-cache-active-build-');
    const identity = routineIdentity(fixture, Effect2.pipe('d', EffectString.repeat(64)));
    const snapshot = routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('8', EffectString.repeat(40))}`);
    seedRoutineCacheRows(fixture.databasePath, 1, 1);

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.claimPersistentBuild(fixture.databasePath, identity, snapshot, {
          logicalSnapshotId: snapshot.id,
          owner: {buildId: '89abcdef-0123-4567', processId: process.pid},
        });
        return yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
      }),
    );

    expect(result).toEqual(noWorkResult);
    expect(readRoutineCacheCounts(fixture.databasePath)).toEqual({fileBlobs: 2, materializedShards: 2});
  });

  it('admits unreferenced cache rows only after the fresh-build grace boundary', () => {
    const database = routineCachePropertyDatabase(1, 1, false);
    try {
      const recent = '2026-08-09T12:00:00.000Z';
      database.query('UPDATE file_blobs SET created_at = ?').run(recent);
      database.query('UPDATE materialized_file_shards SET last_used_at = ?').run(recent);
      const fileCandidates = readRoutineFileBlobCacheCandidates(database, undefined);
      const shardCandidates = readRoutineMaterializedShardCacheCandidates(database, undefined);

      const earlyFile = codeGraphRoutineFileBlobCleanupPageStatement(fileCandidates, '2026-08-09T11:59:59.999Z');
      const earlyShard = codeGraphRoutineMaterializedShardCleanupPageStatement(
        shardCandidates,
        '2026-08-09T11:59:59.999Z',
      );
      expect(database.query(earlyFile.text).run(...earlyFile.parameters).changes).toBe(0);
      expect(database.query(earlyShard.text).run(...earlyShard.parameters).changes).toBe(0);

      const eligibleFile = codeGraphRoutineFileBlobCleanupPageStatement(fileCandidates, recent);
      const eligibleShard = codeGraphRoutineMaterializedShardCleanupPageStatement(shardCandidates, recent);
      expect(database.query(eligibleFile.text).run(...eligibleFile.parameters).changes).toBe(1);
      expect(database.query(eligibleShard.text).run(...eligibleShard.parameters).changes).toBe(1);
      expect(readRoutineCacheDatabaseCounts(database)).toEqual({fileBlobs: 1, materializedShards: 1});
    } finally {
      database.close(false);
    }
  });

  it('routine cache page statements converge monotonically without deleting referenced rows', () => {
    fc.assert(
      fc.property(
        fc.record({
          fileBlobs: fc.integer({max: CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE + 50, min: 0}),
          materializedShards: fc.integer({max: CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE + 50, min: 0}),
          reverseInsertion: fc.boolean(),
        }),
        ({fileBlobs, materializedShards, reverseInsertion}) => {
          const database = routineCachePropertyDatabase(fileBlobs, materializedShards, reverseInsertion);
          try {
            const pages: {readonly cleanup: 'file-blob-cache' | 'materialized-shard-cache'; readonly rows: number}[] =
              [];
            const examinedPages: number[] = [];
            let fileCursor: RoutineTestFileBlobCacheKey | undefined;
            for (;;) {
              const candidates = readRoutineFileBlobCacheCandidates(database, fileCursor);
              if (candidates.length === 0) break;
              examinedPages.push(candidates.length);
              const statement = codeGraphRoutineFileBlobCleanupPageStatement(candidates, ROUTINE_CACHE_ALL_ELIGIBLE);
              const rows = Number(database.query(statement.text).run(...statement.parameters).changes);
              if (rows > 0) pages.push({cleanup: 'file-blob-cache', rows});
              fileCursor = candidates.at(-1)!;
            }
            let materializedCursor: string | undefined;
            for (;;) {
              const candidates = readRoutineMaterializedShardCacheCandidates(database, materializedCursor);
              if (candidates.length === 0) break;
              examinedPages.push(candidates.length);
              const statement = codeGraphRoutineMaterializedShardCleanupPageStatement(
                candidates,
                ROUTINE_CACHE_ALL_ELIGIBLE,
              );
              const rows = Number(database.query(statement.text).run(...statement.parameters).changes);
              if (rows > 0) pages.push({cleanup: 'materialized-shard-cache', rows});
              materializedCursor = candidates.at(-1)!;
            }

            expect(
              EffectArray.every(examinedPages, rows => rows > 0 && rows <= CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE),
            ).toBe(true);
            expect(
              EffectArray.every(pages, page => page.rows > 0 && page.rows <= CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE),
            ).toBe(true);
            expect(EffectArray.reduce(pages, 0, (total, page) => total + page.rows)).toBe(
              fileBlobs + materializedShards,
            );
            expect(EffectArray.map(pages, page => page.cleanup)).toEqual([
              ...Array.from(
                {length: Math.ceil(fileBlobs / CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE)},
                () => 'file-blob-cache' as const,
              ),
              ...Array.from(
                {length: Math.ceil(materializedShards / CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE)},
                () => 'materialized-shard-cache' as const,
              ),
            ]);
            expect(readRoutineCacheDatabaseCounts(database)).toEqual({fileBlobs: 1, materializedShards: 1});
          } finally {
            database.close(false);
          }
        },
      ),
      {numRuns: 40},
    );
  });

  it('retains a reusable donor while the same content is live at another path', () => {
    const database = routineCachePropertyDatabase(0, 0, false);
    try {
      const now = new Date().toISOString();
      database
        .query(
          `INSERT INTO file_blobs (
             content_hash, extractor_set, path_hint, blob_id, reuse_class, facts_json, created_at
           ) VALUES (?, 'cache-test', ?, ?, ?, ?, ?)`,
        )
        .run(
          'zz-live-content',
          'config/donor.json',
          Effect2.pipe('a', EffectString.repeat(40)),
          'structured-object-v1:json:full',
          '{"diagnostics":[],"edges":[],"path":"config/donor.json","symbols":[]}',
          now,
        );
      database
        .query(
          `INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at)
           VALUES (?, 'cache-test', ?, '{}', ?)`,
        )
        .run('zz-live-content', 'config/non-reusable.json', now);

      const candidates = readRoutineFileBlobCacheCandidates(database, undefined);
      const statement = codeGraphRoutineFileBlobCleanupPageStatement(candidates, ROUTINE_CACHE_ALL_ELIGIBLE);
      database.query(statement.text).run(...statement.parameters);

      expect(
        database.query<{readonly path_hint: string}, []>('SELECT path_hint FROM file_blobs ORDER BY path_hint').all(),
      ).toEqual([{path_hint: 'config/donor.json'}, {path_hint: 'src/live.ts'}]);
    } finally {
      database.close(false);
    }
  });

  it('starts the zero-wait cache collector after a successful promotion without a displaced pointer', async () => {
    const fixture = await routineFixture('threadnote-routine-cache-promotion-');
    const identity = routineIdentity(fixture, Effect2.pipe('b', EffectString.repeat(64)));
    const snapshot = {
      ...routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('9', EffectString.repeat(40))}`),
      state: 'ready' as const,
    };
    seedRoutineCacheRows(fixture.databasePath, 1, 1);
    seedPromotableRoutineSnapshot(fixture.databasePath, snapshot);

    const counts = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.promote(fixture.databasePath, identity, snapshot.id);
        return yield* Effect.promise(() => awaitRoutineCacheCounts(fixture.databasePath, 1, 1));
      }),
    );

    expect(counts).toEqual({fileBlobs: 1, materializedShards: 1});
  });

  it('logically retires an exact dead owner and leaves physical rows for the next bounded tick', async () => {
    const fixture = await routineFixture('threadnote-routine-abandoned-owner-');
    const identity = routineIdentity(fixture, Effect2.pipe('b', EffectString.repeat(64)));
    const snapshot = routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`);
    const buildId = '01234567-89ab-cdef';

    const results = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.claimPersistentBuild(fixture.databasePath, identity, snapshot, {
          logicalSnapshotId: snapshot.id,
          owner: {buildId, processId: 2_147_483_647, processStartIdentity: 'dead-process'},
        });
        yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath, {strict: true});
          try {
            database
              .query(
                `INSERT INTO building_lexical_counters
                   (snapshot_id, completed_batch_count, posting_count, symbol_count, term_count)
                 VALUES (?, 1, 1, 1, 1)`,
              )
              .run(snapshot.id);
          } finally {
            database.close(false);
          }
        });
        const first = yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
        const afterFirst = yield* Effect.sync(() => readAbandonedBuildState(fixture.databasePath, snapshot.id));
        const second = yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
        return {afterFirst, first, second};
      }),
    );

    expect(results.first).toEqual({
      cleanup: 'abandoned-build',
      expiredLeases: 0,
      remaining: true,
      retiredSnapshots: 1,
      rowsDeleted: 0,
      state: 'completed',
    });
    expect(results.afterFirst).toMatchObject({buildRows: 1, ownerInstances: 0, owners: 0, state: 'retired'});
    expect(results.second).toMatchObject({state: 'completed'});
    expect(results.second.state === 'completed' ? results.second.rowsDeleted : 0).toBeGreaterThan(0);
  });

  effectIt.effect('reclaims owner-aware failed builds before routine maintenance', () =>
    Effect.acquireUseRelease(
      Effect.promise(() => routineFixture('threadnote-routine-mark-failed-')),
      fixture =>
        Effect.gen(function* () {
          const identity = routineIdentity(fixture, Effect2.pipe('4', EffectString.repeat(64)));
          const snapshot = routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('7', EffectString.repeat(40))}`);
          const store = yield* CodeGraphStore;
          const ownerToken = yield* store.claimPersistentBuild(fixture.databasePath, identity, snapshot, {
            logicalSnapshotId: snapshot.id,
            owner: {buildId: '56789abc-def0-1234', processId: process.pid},
          });
          yield* Effect.sync(() => {
            const database = new Database(fixture.databasePath, {strict: true});
            try {
              database
                .query(
                  `INSERT INTO building_lexical_counters
                   (snapshot_id, completed_batch_count, posting_count, symbol_count, term_count)
                 VALUES (?, 1, 1, 1, 1)`,
                )
                .run(snapshot.id);
              database.query('UPDATE snapshots SET failure_summary = ? WHERE id = ?').run('first failure', snapshot.id);
            } finally {
              database.close(false);
            }
          });
          yield* store.markFailed(fixture.databasePath, snapshot.id, 'later failure', ownerToken);
          const afterFailure = yield* Effect.sync(() => readAbandonedBuildState(fixture.databasePath, snapshot.id));
          const maintenance = yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
          expect(afterFailure).toEqual({buildRows: 0, ownerInstances: 0, owners: 0});
          expect(maintenance.state).toBe('completed');
        }),
      fixture => Effect.promise(() => rm(fixture.home, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.each(['active', 'leased', 'required-base'] as const)(
    'refuses to retire an exact dead owner protected by %s state',
    async protection => {
      const fixture = await routineFixture(`threadnote-routine-abandoned-${protection}-`);
      const identity = routineIdentity(fixture, Effect2.pipe('c', EffectString.repeat(64)));
      const snapshot = routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`);
      const result = await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.claimPersistentBuild(fixture.databasePath, identity, snapshot, {
            logicalSnapshotId: snapshot.id,
            owner: {
              buildId: '12345678-9abc-def0',
              processId: 2_147_483_647,
              processStartIdentity: 'dead-process',
            },
          });
          yield* Effect.sync(() => protectRoutineSnapshot(fixture.databasePath, snapshot, protection));
          return yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
        }),
      );

      expect(result).toEqual({reason: 'owner-protected', state: 'deferred'});
      expect(readAbandonedBuildState(fixture.databasePath, snapshot.id)).toMatchObject({owners: 1, state: 'building'});
    },
  );

  it('lets an unrelated physical page progress behind a persistently protected owner', async () => {
    const fixture = await routineFixture('threadnote-routine-owner-protected-fairness-');
    const identity = routineIdentity(fixture, Effect2.pipe('5', EffectString.repeat(64)));
    const snapshot = routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('8', EffectString.repeat(40))}`);
    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.claimPersistentBuild(fixture.databasePath, identity, snapshot, {
          logicalSnapshotId: snapshot.id,
          owner: {
            buildId: '6789abcd-ef01-2345',
            processId: 2_147_483_647,
            processStartIdentity: 'dead-process',
          },
        });
        yield* Effect.sync(() => {
          protectRoutineSnapshot(fixture.databasePath, snapshot, 'leased');
          seedCleanupPages(fixture.databasePath);
        });
        return yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
      }),
    );

    expect(result).toMatchObject({cleanup: 'completed-build', rowsDeleted: 1, state: 'completed'});
    expect(readAbandonedBuildState(fixture.databasePath, snapshot.id)).toMatchObject({owners: 1, state: 'building'});
  });

  it.each([
    ['live', 'same', false],
    ['unknown', undefined, false],
    ['pid-reused', 'different', true],
  ] as const)('uses exact tri-state liveness for a running %s owner', async (_, storedStart, retires) => {
    const fixture = await routineFixture(`threadnote-routine-owner-${storedStart ?? 'unknown'}-`);
    const identity = routineIdentity(fixture, Effect2.pipe('f', EffectString.repeat(64)));
    const snapshot = routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('3', EffectString.repeat(40))}`);

    const result = await runEffect(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        const currentStart = yield* system.processStartIdentity(system.processId);
        expect(currentStart).toBeDefined();
        const processStartIdentity =
          storedStart === 'same' ? currentStart : storedStart === 'different' ? `${currentStart}-reused` : undefined;
        const store = yield* CodeGraphStore;
        yield* store.claimPersistentBuild(fixture.databasePath, identity, snapshot, {
          logicalSnapshotId: snapshot.id,
          owner: {
            buildId: '23456789-abcd-ef01',
            processId: system.processId,
            ...(processStartIdentity === undefined ? {} : {processStartIdentity}),
          },
        });
        return yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
      }),
    );

    expect(readAbandonedBuildState(fixture.databasePath, snapshot.id).state).toBe(retires ? 'retired' : 'building');
    expect(result).toMatchObject(retires ? {cleanup: 'abandoned-build', state: 'completed'} : {state: 'completed'});
  });

  it.each(['worktree', 'snapshot'] as const)('defers without waiting when the target %s lock is held', async lock => {
    const fixture = await routineFixture(`threadnote-routine-owner-${lock}-lock-`);
    const identity = routineIdentity(fixture, Effect2.pipe('1', EffectString.repeat(64)));
    const snapshot = routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('4', EffectString.repeat(40))}`);
    const observed = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        yield* store.claimPersistentBuild(fixture.databasePath, identity, snapshot, {
          logicalSnapshotId: snapshot.id,
          owner: {
            buildId: '3456789a-bcde-f012',
            processId: 2_147_483_647,
            processStartIdentity: 'dead-process',
          },
        });
        const path = yield* Path.Path;
        const layout = codeGraphLayout(path, fixture.home, fixture.checkoutId, identity.worktreeId);
        const lockPath =
          lock === 'worktree'
            ? layout.lockPath
            : codeGraphSnapshotBuildLockPath(path, fixture.home, fixture.checkoutId, snapshot.id);
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            lockPath,
            {
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const startedAt = performance.now();
        const result = yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
        const elapsedMilliseconds = performance.now() - startedAt;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        return {elapsedMilliseconds, result};
      }),
    );

    expect(observed.result).toEqual({
      reason: lock === 'worktree' ? 'worktree-busy' : 'snapshot-busy',
      state: 'deferred',
    });
    expect(observed.elapsedMilliseconds).toBeLessThan(500);
    expect(readAbandonedBuildState(fixture.databasePath, snapshot.id).state).toBe('building');
  });

  it('fails closed when an old writer changes only the legacy owner token', async () => {
    const fixture = await routineFixture('threadnote-routine-owner-mixed-writer-');
    const identity = routineIdentity(fixture, Effect2.pipe('2', EffectString.repeat(64)));
    const snapshot = routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('5', EffectString.repeat(40))}`);
    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.claimPersistentBuild(fixture.databasePath, identity, snapshot, {
          logicalSnapshotId: snapshot.id,
          owner: {
            buildId: '456789ab-cdef-0123',
            processId: 2_147_483_647,
            processStartIdentity: 'dead-process',
          },
        });
        yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath, {strict: true});
          try {
            database
              .query('UPDATE snapshot_build_owners SET owner_token = ? WHERE snapshot_id = ?')
              .run('legacy-writer-replacement', snapshot.id);
          } finally {
            database.close(false);
          }
        });
        return yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
      }),
    );

    expect(result).toMatchObject({cleanup: 'none', state: 'completed'});
    expect(readAbandonedBuildState(fixture.databasePath, snapshot.id)).toMatchObject({owners: 1, state: 'building'});
  });

  it('refuses a present build-status document whose process tuple does not match durable state', async () => {
    const fixture = await routineFixture('threadnote-routine-owner-sidecar-mismatch-');
    const identity = routineIdentity(fixture, Effect2.pipe('3', EffectString.repeat(64)));
    const snapshot = routineBuildingSnapshot(identity, `cgsn_${Effect2.pipe('6', EffectString.repeat(40))}`);
    const result = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const layout = codeGraphLayout(path, fixture.home, fixture.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* store.claimPersistentBuild(fixture.databasePath, identity, snapshot, {
          logicalSnapshotId: snapshot.id,
          owner: reporter.ownerIdentity,
        });
        yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath, {strict: true});
          try {
            database
              .query(
                `UPDATE snapshot_build_owner_instances
                 SET process_id = ?, process_start_identity = ?
                 WHERE snapshot_id = ?`,
              )
              .run(2_147_483_647, 'dead-process', snapshot.id);
          } finally {
            database.close(false);
          }
        });
        return yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
      }),
    );

    expect(result).toEqual({reason: 'owner-changed', state: 'deferred'});
    expect(readAbandonedBuildState(fixture.databasePath, snapshot.id).state).toBe('building');
  });

  it('advances a durable bounded cursor so a full live page cannot starve the next dead owner', async () => {
    const fixture = await routineFixture('threadnote-routine-owner-cursor-load-');
    const deadSnapshotId = `cgsn_${Effect2.pipe((64).toString(16), EffectString.padStart(40, '0'))}`;
    const observed = await runEffect(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        yield* Effect.sync(() => seedRoutineOwnerPage(fixture.databasePath, system.processId, 65));
        const store = yield* CodeGraphStore;
        const startedAt = performance.now();
        const first = yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
        const second = yield* store.runRoutineMaintenance(fixture.databasePath, routineOptions(fixture));
        return {elapsedMilliseconds: performance.now() - startedAt, first, second};
      }),
    );

    expect(observed.first).toMatchObject({cleanup: 'none', state: 'completed'});
    expect(observed.second).toMatchObject({cleanup: 'abandoned-build', state: 'completed'});
    expect(observed.elapsedMilliseconds).toBeLessThan(1_500);
    expect(readAbandonedBuildState(fixture.databasePath, deadSnapshotId).state).toBe('retired');
  });

  it('bounds an expired-lease page and does not combine it with physical cleanup', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-leases-');
    seedLeaseAndCleanupPages(fixture.databasePath, 101);

    const results = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const run = () => store.runRoutineMaintenance(fixture.databasePath, {writerLockPath: fixture.writerLockPath});
        return [yield* run(), yield* run(), yield* run()] as const;
      }),
    );

    expect(results[0]).toMatchObject({cleanup: 'none', expiredLeases: 100, rowsDeleted: 0});
    expect(results[1]).toMatchObject({cleanup: 'none', expiredLeases: 1, rowsDeleted: 0});
    expect(results[2]).toMatchObject({cleanup: 'completed-build', expiredLeases: 0, rowsDeleted: 1});
  });

  effectIt.effect('adds only the lease column and immutable expiry index on an empty partial schema', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => routineFixture('threadnote-routine-maintenance-partial-', false));
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {create: true, strict: true});
        try {
          database.exec(`
            CREATE TABLE snapshots (
              id TEXT PRIMARY KEY NOT NULL,
              worktree_id TEXT NOT NULL,
              state TEXT NOT NULL,
              base_snapshot_id TEXT
            );
            CREATE TABLE active_snapshots (
              worktree_id TEXT PRIMARY KEY NOT NULL,
              snapshot_id TEXT NOT NULL
            );
            CREATE TABLE snapshot_leases (
              token TEXT PRIMARY KEY NOT NULL,
              snapshot_id TEXT NOT NULL,
              expires_at INTEGER NOT NULL
            );
          `);
        } finally {
          database.close(false);
        }
      });

      const store = yield* CodeGraphStore;
      const result = yield* store.runRoutineMaintenance(fixture.databasePath, {
        writerLockPath: fixture.writerLockPath,
      });

      expect(result).toMatchObject({cleanup: 'none', state: 'completed'});
      yield* Effect.sync(() => {
        const reopened = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(
            reopened
              .query("SELECT COUNT(*) AS count FROM pragma_table_info('snapshot_leases') WHERE name = ?")
              .get('retire_when_inactive'),
          ).toEqual({count: 1});
          expect(
            reopened
              .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'snapshot_leases_expiry'")
              .get(),
          ).toEqual({sql: 'CREATE INDEX snapshot_leases_expiry ON snapshot_leases(expires_at)'});
          expect(reopened.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).not.toContainEqual({
            name: 'symbols',
          });
        } finally {
          reopened.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not mutate a populated unversioned lease table that lost its expiry index', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        routineFixture('threadnote-routine-maintenance-missing-expiry-', false),
      );
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {create: true, strict: true});
        try {
          database.exec(`
            CREATE TABLE snapshots (
              id TEXT PRIMARY KEY NOT NULL,
              worktree_id TEXT NOT NULL,
              state TEXT NOT NULL,
              base_snapshot_id TEXT
            );
            CREATE TABLE active_snapshots (
              worktree_id TEXT PRIMARY KEY NOT NULL,
              snapshot_id TEXT NOT NULL
            );
            CREATE TABLE snapshot_leases (
              token TEXT PRIMARY KEY NOT NULL,
              snapshot_id TEXT NOT NULL,
              expires_at INTEGER NOT NULL
            );
            INSERT INTO snapshot_leases (token, snapshot_id, expires_at)
            VALUES ('preserved', 'legacy-snapshot', 0);
          `);
        } finally {
          database.close(false);
        }
      });

      const store = yield* CodeGraphStore;
      expect(
        yield* store.runRoutineMaintenance(fixture.databasePath, {
          writerLockPath: fixture.writerLockPath,
        }),
      ).toEqual({reason: 'schema-unavailable', state: 'skipped'});

      yield* Effect.sync(() => {
        const reopened = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(
            reopened
              .query("SELECT COUNT(*) AS count FROM pragma_table_info('snapshot_leases') WHERE name = ?")
              .get('retire_when_inactive'),
          ).toEqual({count: 0});
          expect(
            reopened.query("SELECT name FROM sqlite_master WHERE name = 'snapshot_leases_expiry'").get(),
          ).toBeNull();
          expect(reopened.query('SELECT token, snapshot_id, expires_at FROM snapshot_leases').all()).toEqual([
            {expires_at: 0, snapshot_id: 'legacy-snapshot', token: 'preserved'},
          ]);
        } finally {
          reopened.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves a flagged expiry baton when the bounded successor index is unavailable', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        routineFixture('threadnote-routine-maintenance-missing-successor-index-'),
      );
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          seedRepository(database);
          insertSnapshot(database, 'legacy-baton-target', 'ready');
          database.run('DROP TRIGGER removed_views_cleanup_revoke_delete');
          database.run('DROP TRIGGER removed_views_cleanup_revoke_insert');
          database.run('DROP TRIGGER removed_views_cleanup_revoke_update');
          database.run('DROP TABLE removed_view_cleanup');
          database.run(
            `DELETE FROM schema_metadata
             WHERE key IN ('removed_view_cleanup_epoch_sequence', 'removed_view_cleanup_admission_cursor')`,
          );
          database.run("UPDATE schema_metadata SET value = '7' WHERE key = 'persistent_extension_schema_revision'");
          database.run('DROP INDEX snapshot_leases_snapshot_expiry');
          const insert = database.query(
            `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
             VALUES (?, 'legacy-baton-target', ?, ?)`,
          );
          insert.run('flagged-baton', 0, 1);
          database.transaction(() => {
            for (let index = 0; index < 100; index += 1) {
              insert.run(`unflagged-${Effect2.pipe(index.toString(), EffectString.padStart(3, '0'))}`, 1, 0);
            }
          })();
        } finally {
          database.close(false);
        }
      });

      yield* TestClock.adjust(2);
      const store = yield* CodeGraphStore;
      expect(
        yield* store.runRoutineMaintenance(fixture.databasePath, {
          writerLockPath: fixture.writerLockPath,
        }),
      ).toMatchObject({cleanup: 'none', expiredLeases: 99, remaining: true, retiredSnapshots: 0});

      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sync(() => {
        const reopened = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(
            reopened.query('SELECT token, retire_when_inactive FROM snapshot_leases ORDER BY token').all(),
          ).toEqual([
            {retire_when_inactive: 1, token: 'flagged-baton'},
            {retire_when_inactive: 0, token: 'unflagged-099'},
          ]);
          expect(
            reopened.query("SELECT name FROM sqlite_master WHERE name = 'snapshot_leases_snapshot_expiry'").get(),
          ).toBeNull();
          const plan = reopened
            .query<{readonly detail: string}, SQLQueryBindings[]>(
              `EXPLAIN QUERY PLAN
               SELECT token
               FROM snapshot_leases
               WHERE expires_at <= ?
               ORDER BY expires_at
               LIMIT 100`,
            )
            .all(now);
          expect(
            EffectArray.some(plan, row => Effect2.pipe(row.detail, EffectString.includes('snapshot_leases_expiry'))),
          ).toBe(true);
          expect(EffectArray.some(plan, row => /SCAN|TEMP B-TREE/iu.test(row.detail))).toBe(false);
        } finally {
          reopened.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('skips an incomplete base schema before applying the additive lease migration', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-incomplete-', false);
    const database = new Database(fixture.databasePath, {create: true, strict: true});
    try {
      database.exec(`
        CREATE TABLE snapshots (
          id TEXT PRIMARY KEY NOT NULL,
          state TEXT NOT NULL,
          base_snapshot_id TEXT
        );
        CREATE TABLE active_snapshots (
          worktree_id TEXT PRIMARY KEY NOT NULL,
          snapshot_id TEXT NOT NULL
        );
        CREATE TABLE snapshot_leases (
          token TEXT PRIMARY KEY NOT NULL,
          snapshot_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
    } finally {
      database.close(false);
    }

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.runRoutineMaintenance(fixture.databasePath, {
          writerLockPath: fixture.writerLockPath,
        });
      }),
    );

    expect(result).toEqual({reason: 'schema-unavailable', state: 'skipped'});
    const reopened = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(
        reopened
          .query("SELECT COUNT(*) AS count FROM pragma_table_info('snapshot_leases') WHERE name = ?")
          .get('retire_when_inactive'),
      ).toEqual({count: 0});
    } finally {
      reopened.close(false);
    }
  });

  it('preserves the full base closure of an active snapshot while reaping an expired lease', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-base-');
    seedProtectedBaseClosure(fixture.databasePath);

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.runRoutineMaintenance(fixture.databasePath, {
          writerLockPath: fixture.writerLockPath,
        });
      }),
    );

    expect(result).toMatchObject({
      cleanup: 'none',
      expiredLeases: 1,
      retiredSnapshots: 0,
      rowsDeleted: 0,
      state: 'completed',
    });
    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get('base-root')).toEqual({state: 'ready'});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
    } finally {
      database.close(false);
    }
  });

  effectIt.effect('queues and fairly drains 64 distinct databases after an interrupted active owner', () =>
    Effect.gen(function* () {
      const first = tick('/home', '/database/000');
      const calls = yield* Ref.make<string[]>([]);
      const started = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(input =>
        Ref.updateAndGet(calls, current => [...current, input.databasePath]).pipe(
          Effect.tap(current =>
            current.length === 1
              ? Deferred.succeed(started, undefined)
              : current.length === 65
                ? Deferred.succeed(drained, undefined)
                : Effect.void,
          ),
          Effect.andThen(input.databasePath === first.databasePath ? Effect.never : Effect.void),
          Effect.as(noWorkResult),
        ),
      );
      const owner = yield* Effect.forkChild(coordinator.tick(first));
      yield* Deferred.await(started);
      const queued = Array.from({length: 64}, (_, index) =>
        tick('/home', `/database/${Effect2.pipe(String(index + 1), EffectString.padStart(3, '0'))}`),
      );
      const admissions: CodeGraphRoutineMaintenanceResult[] = [];
      for (const input of queued) admissions.push(yield* coordinator.tick(input));
      const duplicate = yield* coordinator.tick(queued[0]);
      yield* Fiber.interrupt(owner);
      yield* Deferred.await(drained);

      expect(admissions).toEqual(EffectArray.map(queued, () => ({reason: 'home-tick-active', state: 'deferred'})));
      expect(duplicate).toEqual({reason: 'home-tick-active', state: 'deferred'});
      expect(yield* Ref.get(calls)).toEqual([
        first.databasePath,
        ...EffectArray.map(queued, input => input.databasePath),
      ]);
    }),
  );

  effectIt.effect('preserves the initiating and joined callers exact store failure', () =>
    Effect.gen(function* () {
      const expected = CodeGraphStoreError.of('Exact permission failure.', {
        code: 'permission',
        operation: 'routine maintenance test',
        recovery: 'fix-permissions',
      });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.fail(expected)),
        ),
      );
      const input = tick('/home', '/database/error');
      const owner = yield* Effect.forkChild(coordinator.tick(input).pipe(Effect.exit));
      yield* Deferred.await(started);
      const joined = yield* Effect.forkChild(coordinator.tick(input).pipe(Effect.exit));
      yield* Deferred.succeed(release, undefined);
      const exits = yield* Effect.all([Fiber.join(owner), Fiber.join(joined)]);

      for (const exit of exits) {
        expect(exit._tag).toBe('Failure');
        if (exit._tag === 'Failure') {
          expect(String(exit.cause)).toContain('Exact permission failure.');
          expect(String(exit.cause)).not.toContain('writer-busy');
        }
      }
    }),
  );

  effectIt.effect('merges authoritative and index-preparation capabilities monotonically in pending work', () =>
    Effect.gen(function* () {
      const first = tick('/home', '/database/active');
      const anchor = routineMaintenanceAnchor();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const calls = yield* Ref.make<CodeGraphRoutineMaintenanceTick[]>([]);
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(input =>
        Ref.updateAndGet(calls, current => [...current, input]).pipe(
          Effect.tap(current =>
            current.length === 1
              ? Deferred.succeed(started, undefined)
              : current.length === 2
                ? Deferred.succeed(drained, undefined)
                : Effect.void,
          ),
          Effect.andThen(input.databasePath === first.databasePath ? Deferred.await(release) : Effect.void),
          Effect.as(noWorkResult),
        ),
      );
      const owner = yield* coordinator.tick(first).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const pending = {
        ...tick('/home', '/database/pending'),
        allowIndexPreparation: true as const,
        anchorIdentity: anchor,
      };
      expect(yield* coordinator.tick(pending)).toEqual({reason: 'home-tick-active', state: 'deferred'});
      expect(yield* coordinator.tick(tick('/home', '/database/pending'))).toEqual({
        reason: 'home-tick-active',
        state: 'deferred',
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      yield* Deferred.await(drained);

      expect((yield* Ref.get(calls))[1]).toMatchObject({
        allowIndexPreparation: true,
        anchorIdentity: anchor,
        databasePath: '/database/pending',
      });
    }),
  );

  effectIt.effect('reports a detached queued failure without changing the active maintenance result', () =>
    Effect.gen(function* () {
      const active = tick('/home', '/database/active');
      const pending = tick('/home', '/database/pending');
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reported = yield* Deferred.make<CodeGraphStoreFailure>();
      const expected = CodeGraphStoreError.of('private queued failure at /Users/private/graph.sqlite', {
        code: 'permission',
        operation: 'routine maintenance test',
        recovery: 'fix-permissions',
      });
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(
        input =>
          input.databasePath === active.databasePath
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(noWorkResult),
              )
            : Effect.fail(expected),
        undefined,
        {
          onDeferredFailure: error =>
            Deferred.succeed(reported, error).pipe(
              Effect.andThen(Effect.die(new Error('private telemetry defect'))),
              Effect.asVoid,
            ),
        },
      );

      const owner = yield* coordinator.tick(active).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(yield* coordinator.tick(pending)).toEqual({reason: 'home-tick-active', state: 'deferred'});
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(owner)).toEqual(noWorkResult);
      expect(yield* Deferred.await(reported)).toBe(expected);
    }),
  );

  effectIt.effect('reserves one trailing slot for same-database capability upgrades at full capacity', () =>
    Effect.gen(function* () {
      const first = tick('/home', '/database/active');
      const anchor = routineMaintenanceAnchor();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const calls = yield* Ref.make<CodeGraphRoutineMaintenanceTick[]>([]);
      const expectedOrdinary = Array.from({length: 127}, (_, index) =>
        tick('/home', `/database/${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}`),
      );
      const expectedRunCount = 1 + expectedOrdinary.length + 1;
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(input =>
        Ref.updateAndGet(calls, current => [...current, input]).pipe(
          Effect.tap(current =>
            current.length === 1
              ? Deferred.succeed(started, undefined)
              : current.length === expectedRunCount
                ? Deferred.succeed(drained, undefined)
                : Effect.void,
          ),
          Effect.andThen(
            input.databasePath === first.databasePath && input.anchorIdentity === undefined
              ? Deferred.await(release)
              : Effect.void,
          ),
          Effect.as(noWorkResult),
        ),
      );
      const owner = yield* coordinator.tick(first).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      for (const input of expectedOrdinary) {
        expect(yield* coordinator.tick(input)).toEqual({reason: 'home-tick-active', state: 'deferred'});
      }
      const upgraded = {...first, allowIndexPreparation: true as const, anchorIdentity: anchor};
      const joining = yield* coordinator.tick(upgraded).pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      yield* Fiber.join(joining);
      yield* Deferred.await(drained);

      const observed = yield* Ref.get(calls);
      expect(EffectArray.map(observed, input => input.databasePath)).toEqual([
        first.databasePath,
        ...EffectArray.map(expectedOrdinary, input => input.databasePath),
        first.databasePath,
      ]);
      expect(observed.at(-1)).toMatchObject({allowIndexPreparation: true, anchorIdentity: anchor});
    }),
  );

  effectIt.effect('request returns immediately, coalesces a flood to one trailing run, and cancels with scope', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const trailing = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      const stops = yield* Ref.make(0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* makeCodeGraphMaintenanceCoordinator(() =>
            Ref.updateAndGet(calls, count => count + 1).pipe(
              Effect.flatMap(count =>
                (count === 1
                  ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
                  : Deferred.succeed(trailing, undefined).pipe(Effect.andThen(Effect.never))
                ).pipe(Effect.as(noWorkResult)),
              ),
              Effect.ensuring(
                Ref.updateAndGet(stops, count => count + 1).pipe(
                  Effect.flatMap(count => (count === 2 ? Deferred.succeed(stopped, undefined) : Effect.void)),
                ),
              ),
            ),
          );
          const input = tick('/home', '/database/request');
          yield* coordinator.request(input);
          yield* Deferred.await(started);
          for (let index = 0; index < 10_000; index += 1) yield* coordinator.request(input);
          expect(yield* Ref.get(calls)).toBe(1);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(trailing);
          expect(yield* Ref.get(calls)).toBe(2);
        }),
      );
      yield* Deferred.await(stopped);
      expect(yield* Ref.get(calls)).toBe(2);
    }),
  );

  effectIt.effect('hands an admitted request to the scoped child even when its caller is cancelled', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const admitted = yield* Deferred.make<void>();
        const releaseAdmission = yield* Deferred.make<void>();
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const trailingStarted = yield* Deferred.make<void>();
        const admissions = yield* Ref.make(0);
        const calls = yield* Ref.make(0);
        const coordinator = yield* makeCodeGraphMaintenanceCoordinator(
          () =>
            Ref.updateAndGet(calls, count => count + 1).pipe(
              Effect.flatMap(count =>
                count === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
                  : Deferred.succeed(trailingStarted, undefined),
              ),
              Effect.as(noWorkResult),
            ),
          undefined,
          {
            afterRequestAdmission: () =>
              Ref.updateAndGet(admissions, count => count + 1).pipe(
                Effect.flatMap(count =>
                  count === 1
                    ? Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Deferred.await(releaseAdmission)))
                    : Effect.void,
                ),
              ),
          },
        );
        const input = tick('/home', '/database/cancelled-request');
        const requester = yield* coordinator.request(input).pipe(Effect.forkChild);
        yield* Deferred.await(admitted);
        const interruption = yield* Fiber.interrupt(requester).pipe(Effect.forkChild);
        yield* Deferred.succeed(releaseAdmission, undefined);
        yield* Fiber.join(interruption);
        yield* Deferred.await(firstStarted);

        yield* coordinator.request(input);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(trailingStarted);

        expect(yield* Ref.get(calls)).toBe(2);
      }),
    ),
  );

  effectIt.effect('prepares one legacy reverse index per authoritative background tick before reconciling', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporaryHome = yield* fs.makeTempDirectory({prefix: 'threadnote-reconciliation-index-bootstrap-'});
      const home = yield* fs.realPath(temporaryHome);
      temporaryHomes.push(home);
      const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
      const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const databasePath = join(repositoryRoot, 'graph-v3.sqlite');
      const writerLockPath = join(home, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`);
      yield* fs.makeDirectory(repositoryRoot, {recursive: true});
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => {
        const database = new Database(databasePath, {strict: true});
        try {
          // Start from the released unscoped authority contract before
          // reconstructing the pre-cleanup r7 fixture below. Merely lowering
          // the revision marker leaves r18 scope tables behind, which is an
          // intentionally incompatible hybrid rather than a migratable r7 DB.
          for (const statement of legacyCodeGraphAuthorityStatements) database.exec(statement);
          database.run('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete');
          database.run('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert');
          database.run('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update');
          database.run('DROP TABLE removed_view_cleanup');
          database.run(
            `DELETE FROM schema_metadata
             WHERE key IN ('removed_view_cleanup_epoch_sequence', 'removed_view_cleanup_admission_cursor')`,
          );
          database.run("UPDATE schema_metadata SET value = '7' WHERE key = 'persistent_extension_schema_revision'");
          database.run('DROP INDEX active_snapshots_snapshot_worktree');
          database.run('DROP INDEX snapshots_base_state_id');
          database.run('DROP INDEX snapshot_leases_snapshot_expiry');
        } finally {
          database.close(false);
        }
      });
      const coordinator = yield* CodeGraphMaintenanceCoordinator;
      const input = {
        allowIndexPreparation: true as const,
        anchorIdentity: {...routineMaintenanceAnchor(), checkoutId},
        checkoutId,
        databasePath,
        threadnoteHome: home,
        writerLockPath,
      };
      const results = yield* Effect.forEach(
        Array.from({length: 16}),
        () => coordinator.tick(input).pipe(Effect.tap(() => Effect.yieldNow)),
        {concurrency: 1},
      );

      expect(
        EffectArray.filter(results, result => result.state === 'completed' && result.cleanup === 'reconciliation-index')
          .length,
      ).toBe(3);
      expect(
        EffectArray.filter(results, result => result.state === 'completed' && result.cleanup === 'schema-migration'),
      ).toHaveLength(1);
      expect(
        EffectArray.every(
          EffectArray.filter(
            results,
            result =>
              result.state !== 'completed' ||
              (result.cleanup !== 'reconciliation-index' && result.cleanup !== 'schema-migration'),
          ),
          result =>
            (result.state === 'deferred' && result.reason === 'writer-busy') ||
            (result.state === 'completed' && result.cleanup === 'none'),
        ),
      ).toBe(true);
      expect(readReconciliationIndexes(databasePath)).toEqual([
        'active_snapshots_snapshot_worktree',
        'snapshot_leases_snapshot_expiry',
        'snapshots_base_state_id',
      ]);
      expect(yield* store.prepareWorktreeReconciliationIndexes(databasePath)).toEqual({state: 'ready'});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'single-flights every bounded number of concurrent callers for one database',
    {callers: fc.integer({max: 16, min: 2})},
    ({callers}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls = yield* Ref.make(0);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const coordinator = yield* makeCodeGraphMaintenanceCoordinator(() =>
            Ref.updateAndGet(calls, count => count + 1).pipe(
              Effect.tap(() => Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(noWorkResult),
            ),
          );
          const first = yield* Effect.forkChild(coordinator.tick(tick('/home', '/database')));
          yield* Deferred.await(started);
          const joined = yield* Effect.forkChild(
            Effect.all(
              Array.from({length: callers - 1}, () => coordinator.tick(tick('/home', '/database'))),
              {
                concurrency: 'unbounded',
              },
            ),
          );
          yield* Effect.forEach(Array.from({length: callers}), () => Effect.yieldNow, {discard: true});
          yield* Deferred.succeed(release, undefined);
          const observed = {
            calls: yield* Ref.get(calls),
            results: [yield* Fiber.join(first), ...(yield* Fiber.join(joined))],
          };
          expect(observed.calls).toBe(1);
          expect(observed.results).toEqual(Array.from({length: callers}, () => noWorkResult));
        }),
      ),
  );
});

const noWorkResult = {
  cleanup: 'none',
  expiredLeases: 0,
  remaining: false,
  retiredSnapshots: 0,
  rowsDeleted: 0,
  state: 'completed',
} as const satisfies CodeGraphRoutineMaintenanceResult;

function tick(threadnoteHome: string, databasePath: string): CodeGraphRoutineMaintenanceTick {
  return {
    checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
    databasePath,
    threadnoteHome,
    writerLockPath: `${databasePath}.lock`,
  };
}

function routineMaintenanceAnchor(): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
    displayName: 'routine-maintenance-anchor',
    gitCommonDirectory: '/anchor/common',
    headCommit: Effect2.pipe('1', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
    repoRoot: '/anchor/root',
    worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
  };
}

function readReconciliationIndexes(databasePath: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return EffectArray.map(
      database
        .query<{readonly name: string}, SQLQueryBindings[]>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name IN (
               'active_snapshots_snapshot_worktree',
               'snapshots_base_state_id',
               'snapshot_leases_snapshot_expiry'
             )
           ORDER BY name`,
        )
        .all(),
      row => row.name,
    );
  } finally {
    database.close(false);
  }
}

async function routineFixture(prefix: string, initialize = true) {
  const home = await mkdtemp(prefix);
  temporaryHomes.push(home);
  const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
  const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
  const databasePath = join(repositoryRoot, 'graph-v3.sqlite');
  const writerLockPath = join(home, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`);
  await mkdir(repositoryRoot, {recursive: true});
  if (initialize) {
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
  }
  return {checkoutId, databasePath, home, repositoryRoot, writerLockPath};
}

function routineOptions(fixture: Awaited<ReturnType<typeof routineFixture>>) {
  return {
    checkoutId: fixture.checkoutId,
    threadnoteHome: fixture.home,
    writerLockPath: fixture.writerLockPath,
  } as const;
}

function routineIdentity(fixture: Awaited<ReturnType<typeof routineFixture>>, worktreeId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: fixture.checkoutId,
    displayName: 'routine-maintenance-fixture',
    gitCommonDirectory: fixture.home,
    headCommit: Effect2.pipe('1', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: fixture.repositoryRoot,
    repositoryId: Effect2.pipe('e', EffectString.repeat(64)),
    worktreeId,
  };
}

function routineBuildingSnapshot(identity: RepositoryIdentity, id: string): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'routine-maintenance',
    fileCount: 0,
    graphContentId: id,
    id,
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}

function readAbandonedBuildState(databasePath: string, snapshotId: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      buildRows: (
        database
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM building_lexical_counters WHERE snapshot_id = ?',
          )
          .get(snapshotId) ?? {count: 0}
      ).count,
      ownerInstances: (
        database
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM snapshot_build_owner_instances WHERE snapshot_id = ?',
          )
          .get(snapshotId) ?? {count: 0}
      ).count,
      owners: (
        database
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM snapshot_build_owners WHERE snapshot_id = ?',
          )
          .get(snapshotId) ?? {count: 0}
      ).count,
      ...(database
        .query<{readonly failure_summary: string | null; readonly state: string}, [string]>(
          'SELECT failure_summary, state FROM snapshots WHERE id = ?',
        )
        .get(snapshotId) ?? {}),
    };
  } finally {
    database.close(false);
  }
}

function protectRoutineSnapshot(
  databasePath: string,
  snapshot: CodeGraphSnapshot,
  protection: 'active' | 'leased' | 'required-base',
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    if (protection === 'active') {
      database
        .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
        .run(snapshot.id, CODE_GRAPH_EXTRACTOR_GENERATION);
      database
        .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
        .run(snapshot.worktreeId, snapshot.id, new Date().toISOString());
    } else if (protection === 'leased') {
      database
        .query(
          `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
           VALUES ('active-reader', ?, ?, 0)`,
        )
        .run(snapshot.id, Date.now() + 60_000);
    } else {
      const now = new Date().toISOString();
      database
        .query(
          `INSERT INTO snapshots (
             id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
             extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
             edge_count, started_at, completed_at, failure_summary
           ) VALUES (?, ?, ?, ?, ?, ?, 'routine-maintenance', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
        )
        .run(
          `${snapshot.id}-dependent`,
          snapshot.repositoryId,
          Effect2.pipe('d', EffectString.repeat(64)),
          snapshot.commit,
          `${snapshot.id}-dependent`,
          snapshot.id,
          now,
          now,
        );
    }
  } finally {
    database.close(false);
  }
}

function seedRoutineOwnerPage(databasePath: string, liveProcessId: number, count: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const now = new Date().toISOString();
    database
      .query(
        `INSERT OR IGNORE INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'cursor fixture', 'sha1', ?, ?)`,
      )
      .run(Effect2.pipe('e', EffectString.repeat(64)), now, now);
    const snapshot = database.query(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
         extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
         edge_count, started_at, completed_at, failure_summary
       ) VALUES (?, ?, ?, ?, ?, NULL, 'routine-maintenance', 0, NULL, 'building', 0, 0, 0, ?, NULL, NULL)`,
    );
    const owner = database.query(
      `INSERT INTO snapshot_build_owners (snapshot_id, owner_token, claimed_at)
       VALUES (?, ?, ?)`,
    );
    const instance = database.query(
      `INSERT INTO snapshot_build_owner_instances (
         snapshot_id, owner_token, build_id, process_id, process_start_identity, logical_snapshot_id
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const logicalSnapshotId = `cgsn_${Effect2.pipe(index.toString(16), EffectString.padStart(40, '0'))}`;
        const worktreeId = Effect2.pipe(index.toString(16), EffectString.padStart(64, '0'));
        const ownerToken = `owner-${index}`;
        const dead = index === count - 1;
        snapshot.run(
          logicalSnapshotId,
          Effect2.pipe('e', EffectString.repeat(64)),
          worktreeId,
          Effect2.pipe('1', EffectString.repeat(40)),
          logicalSnapshotId,
          now,
        );
        owner.run(logicalSnapshotId, ownerToken, now);
        instance.run(
          logicalSnapshotId,
          ownerToken,
          Effect2.pipe(index.toString(16), EffectString.padStart(16, '0')),
          dead ? 2_147_483_647 : liveProcessId,
          dead ? 'dead-process' : null,
          logicalSnapshotId,
        );
      }
    })();
  } finally {
    database.close(false);
  }
}

function seedCleanupPages(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    seedRepository(database);
    insertSnapshot(database, 'completed-build', 'ready');
    insertSnapshot(database, 'retired-data', 'retired');
    database
      .query(
        `INSERT INTO building_lexical_counters
          (snapshot_id, completed_batch_count, posting_count, symbol_count, term_count)
         VALUES (?, 1, 1, 1, 1)`,
      )
      .run('completed-build');
    database
      .query(
        `INSERT INTO symbols (
           snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
           arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
           exported, signature, documentation, span_json
         ) VALUES (?, 'symbol', 'hash', 'function', 'symbol', 'symbol', 'src/symbol.ts', 'typescript',
           NULL, '[]', 'typescript', NULL, NULL, 0, NULL, NULL,
           '{"line":1,"column":1,"endLine":1,"endColumn":2}')`,
      )
      .run('retired-data');
  } finally {
    database.close(false);
  }
}

function seedRoutineCacheRows(databasePath: string, fileBlobCount: number, materializedShardCount: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    seedRepository(database);
    insertSnapshot(database, 'cache-live', 'ready');
    const now = new Date(0).toISOString();
    const insertFile = database.query(
      `INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at)
       VALUES (?, 'cache-test', ?, '{}', ?)`,
    );
    const insertShard = database.query(
      `INSERT INTO materialized_file_shards (
         id, content_hash, extractor_set, derivation_identity, path_hint,
         facts_json, created_at, last_used_at
       ) VALUES (?, ?, 'cache-test', 'cache-derivation', ?, '{}', ?, ?)`,
    );
    database.transaction(() => {
      database
        .query(
          `INSERT INTO snapshot_files (snapshot_id, path, content_hash, language, mode, size, source)
           VALUES ('cache-live', 'src/live.ts', 'zz-live-content', 'typescript', '100644', 1, 'commit')`,
        )
        .run();
      insertFile.run('zz-live-content', 'src/live.ts', now);
      insertShard.run('zz-live-shard', 'zz-live-content', 'src/live.ts', now, now);
      database
        .query(
          `INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id)
           VALUES ('cache-live', 'src/live.ts', 'zz-live-shard')`,
        )
        .run();
      for (let index = 0; index < fileBlobCount; index += 1) {
        const suffix = Effect2.pipe(index.toString(), EffectString.padStart(4, '0'));
        insertFile.run(`orphan-file-${suffix}`, `fixtures/legacy-${suffix}.svg`, now);
      }
      for (let index = 0; index < materializedShardCount; index += 1) {
        const suffix = Effect2.pipe(index.toString(), EffectString.padStart(4, '0'));
        insertShard.run(
          `orphan-shard-${suffix}`,
          `orphan-shard-content-${suffix}`,
          `fixtures/legacy-${suffix}.json`,
          now,
          now,
        );
      }
    })();
  } finally {
    database.close(false);
  }
}

function routineCachePropertyDatabase(
  fileBlobCount: number,
  materializedShardCount: number,
  reverseInsertion: boolean,
): Database {
  const database = new Database(':memory:', {strict: true});
  database.exec(`
    CREATE TABLE snapshot_files (
      snapshot_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID;
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX snapshot_files_blob ON snapshot_files(path, content_hash);
    CREATE INDEX snapshot_files_content_hash ON snapshot_files(content_hash);
    CREATE TABLE file_blobs (
      content_hash TEXT NOT NULL,
      extractor_set TEXT NOT NULL,
      path_hint TEXT NOT NULL,
      blob_id TEXT,
      reuse_class TEXT,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash, extractor_set, path_hint)
    ) WITHOUT ROWID;
    CREATE TABLE materialized_file_shards (
      id TEXT PRIMARY KEY NOT NULL,
      content_hash TEXT NOT NULL,
      extractor_set TEXT NOT NULL,
      derivation_identity TEXT NOT NULL,
      path_hint TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE snapshot_file_shards (
      snapshot_id TEXT NOT NULL,
      path TEXT NOT NULL,
      shard_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID;
    CREATE INDEX snapshot_file_shards_shard ON snapshot_file_shards(shard_id);
  `);
  const now = new Date(0).toISOString();
  const insertFile = database.query(
    `INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at)
     VALUES (?, 'cache-test', ?, '{}', ?)`,
  );
  const insertShard = database.query(
    `INSERT INTO materialized_file_shards (
       id, content_hash, extractor_set, derivation_identity, path_hint,
       facts_json, created_at, last_used_at
     ) VALUES (?, ?, 'cache-test', 'cache-derivation', ?, '{}', ?, ?)`,
  );
  const fileIndexes = Array.from({length: fileBlobCount}, (_, index) => index);
  const shardIndexes = Array.from({length: materializedShardCount}, (_, index) => index);
  if (reverseInsertion) {
    fileIndexes.reverse();
    shardIndexes.reverse();
  }
  database.transaction(() => {
    database.query("INSERT INTO snapshots VALUES ('live-snapshot', 'ready')").run();
    database.query("INSERT INTO snapshot_files VALUES ('live-snapshot', 'src/live.ts', 'zz-live-content')").run();
    insertFile.run('zz-live-content', 'src/live.ts', now);
    insertShard.run('zz-live-shard', 'zz-live-content', 'src/live.ts', now, now);
    database.query("INSERT INTO snapshot_file_shards VALUES ('live-snapshot', 'src/live.ts', 'zz-live-shard')").run();
    for (const index of fileIndexes) {
      const suffix = Effect2.pipe(index.toString(), EffectString.padStart(4, '0'));
      insertFile.run(`orphan-file-${suffix}`, `fixtures/legacy-${suffix}.svg`, now);
    }
    for (const index of shardIndexes) {
      const suffix = Effect2.pipe(index.toString(), EffectString.padStart(4, '0'));
      insertShard.run(
        `orphan-shard-${suffix}`,
        `orphan-shard-content-${suffix}`,
        `fixtures/legacy-${suffix}.json`,
        now,
        now,
      );
    }
  })();
  return database;
}

interface RoutineTestFileBlobCacheKey {
  readonly contentHash: string;
  readonly extractorSet: string;
  readonly path: string;
}

function readRoutineFileBlobCacheCandidates(
  database: Database,
  cursor: RoutineTestFileBlobCacheKey | undefined,
): readonly RoutineTestFileBlobCacheKey[] {
  const rows = database
    .query<
      {readonly content_hash: string; readonly extractor_set: string; readonly path_hint: string},
      [string | null, string | null, string | null, string | null, number]
    >(
      `SELECT content_hash, extractor_set, path_hint
       FROM file_blobs
       WHERE (? IS NULL OR (content_hash, extractor_set, path_hint) > (?, ?, ?))
       ORDER BY content_hash, extractor_set, path_hint
       LIMIT ?`,
    )
    .all(
      cursor?.contentHash ?? null,
      cursor?.contentHash ?? null,
      cursor?.extractorSet ?? null,
      cursor?.path ?? null,
      CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE,
    );
  return EffectArray.map(rows, row => ({
    contentHash: row.content_hash,
    extractorSet: row.extractor_set,
    path: row.path_hint,
  }));
}

function readRoutineMaterializedShardCacheCandidates(database: Database, cursor: string | undefined): string[] {
  return EffectArray.map(
    database
      .query<{readonly id: string}, [string | null, string | null, number]>(
        `SELECT id
       FROM materialized_file_shards
       WHERE (? IS NULL OR id > ?)
       ORDER BY id
       LIMIT ?`,
      )
      .all(cursor ?? null, cursor ?? null, CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE),
    row => row.id,
  );
}

function readRoutineCacheCounts(databasePath: string): {
  readonly fileBlobs: number;
  readonly materializedShards: number;
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return readRoutineCacheDatabaseCounts(database);
  } finally {
    database.close(false);
  }
}

function readRoutineCacheDatabaseCounts(database: Database): {
  readonly fileBlobs: number;
  readonly materializedShards: number;
} {
  return {
    fileBlobs: (
      database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM file_blobs').get() ?? {count: 0}
    ).count,
    materializedShards: (
      database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM materialized_file_shards').get() ?? {
        count: 0,
      }
    ).count,
  };
}

function seedPromotableRoutineSnapshot(databasePath: string, snapshot: CodeGraphSnapshot): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const now = new Date().toISOString();
    database.transaction(() => {
      database
        .query(
          `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
           VALUES (?, 'promotion cache fixture', 'sha1', ?, ?)`,
        )
        .run(snapshot.repositoryId, now, now);
      database
        .query(
          `INSERT INTO snapshots (
             id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
             extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
             edge_count, started_at, completed_at, failure_summary
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
        )
        .run(
          snapshot.id,
          snapshot.repositoryId,
          snapshot.worktreeId,
          snapshot.commit,
          snapshot.graphContentId ?? null,
          snapshot.extractorSet,
          now,
          now,
        );
      database
        .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
        .run(snapshot.id, CODE_GRAPH_EXTRACTOR_GENERATION);
    })();
  } finally {
    database.close(false);
  }
}

async function awaitRoutineCacheCounts(
  databasePath: string,
  fileBlobs: number,
  materializedShards: number,
): Promise<{readonly fileBlobs: number; readonly materializedShards: number}> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const counts = readRoutineCacheCounts(databasePath);
    if (counts.fileBlobs === fileBlobs && counts.materializedShards === materializedShards) return counts;
    if (Date.now() >= deadline) return counts;
    await Bun.sleep(10);
  }
}

function seedLeaseAndCleanupPages(databasePath: string, leases: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    seedRepository(database);
    insertSnapshot(database, 'lease-target', 'ready');
    database
      .query(
        `INSERT INTO building_lexical_counters
          (snapshot_id, completed_batch_count, posting_count, symbol_count, term_count)
         VALUES (?, 1, 1, 1, 1)`,
      )
      .run('lease-target');
    const insert = database.query(
      `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
       VALUES (?, 'lease-target', 0, 0)`,
    );
    database.transaction(() => {
      for (let index = 0; index < leases; index += 1)
        insert.run(`expired-${Effect2.pipe(index.toString(), EffectString.padStart(3, '0'))}`);
    })();
  } finally {
    database.close(false);
  }
}

function seedProtectedBaseClosure(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    seedRepository(database);
    insertSnapshot(database, 'base-root', 'ready');
    insertSnapshot(database, 'base-alias', 'ready', 'base-root');
    insertSnapshot(database, 'active-overlay', 'ready', 'base-alias');
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run('active-overlay', CODE_GRAPH_EXTRACTOR_GENERATION);
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run('active-worktree', 'active-overlay', new Date().toISOString());
    database
      .query(
        `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
         VALUES ('expired-base-reader', 'base-root', 0, 1)`,
      )
      .run();
  } finally {
    database.close(false);
  }
}

function seedRepository(database: Database): void {
  const now = new Date().toISOString();
  database
    .query(
      `INSERT OR IGNORE INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES ('repository', 'fixture', 'sha1', ?, ?)`,
    )
    .run(now, now);
}

function insertSnapshot(database: Database, id: string, state: 'ready' | 'retired', baseSnapshotId?: string): void {
  const now = new Date().toISOString();
  database
    .query(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
         extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
         edge_count, started_at, completed_at, failure_summary
       ) VALUES (?, 'repository', 'fixture-worktree', 'commit', ?, ?, 'extractor', 0, NULL, ?, 0, 0, 0, ?, ?, NULL)`,
    )
    .run(id, id, baseSnapshotId ?? null, state, now, now);
}
