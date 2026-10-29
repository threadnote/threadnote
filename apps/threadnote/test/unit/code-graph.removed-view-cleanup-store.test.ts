import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {legacyCodeGraphAuthorityStatements} from '@threadnote/graph/test/helpers/code-graph-legacy-authority';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CodeGraphStore,
  codeGraphRemovedViewCleanupAdmissionPageStatement,
  codeGraphRemovedViewCleanupDuePageStatement,
} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CodeGraphStoreError, type RepositoryIdentity} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const REPOSITORY_ID = Effect2.pipe('b', EffectString.repeat(64));
const WORKTREE_ID = Effect2.pipe('c', EffectString.repeat(64));
const OTHER_WORKTREE_ID = Effect2.pipe('d', EffectString.repeat(64));
const RECORD_DIGEST = Effect2.pipe('e', EffectString.repeat(64));
const RECORD_IDENTITY = Effect2.pipe('f', EffectString.repeat(64));
const SNAPSHOT_ID = 'cgsn_1111111111111111111111111111111111111111';
const NEW_SNAPSHOT_ID = 'cgsn_2222222222222222222222222222222222222222';

describe('removed code graph view cleanup queue', () => {
  effectIt.effect(
    'upgrades an exact revision 8 cleanup authority to the current revision without retiring ready views',
    () =>
      withFixture('threadnote-removed-cleanup-r8-current-', ({databasePath}) =>
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          yield* Effect.sync(() => {
            const database = new Database(databasePath, {strict: true});
            try {
              seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
              database
                .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
                .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
              database.exec('DROP TABLE snapshot_component_edge_aggregate_receipts');
              database.exec('DROP TABLE snapshot_component_edge_aggregates');
              database
                .query("UPDATE schema_metadata SET value = '8' WHERE key = 'persistent_extension_schema_revision'")
                .run();
            } finally {
              database.close(false);
            }
          });

          yield* store.initialize(databasePath);

          const observed = yield* Effect.sync(() => {
            const database = new Database(databasePath, {readonly: true, strict: true});
            try {
              return {
                active: database.query('SELECT worktree_id, snapshot_id FROM active_snapshots').all(),
                aggregates: database
                  .query(
                    `SELECT name FROM sqlite_schema
                   WHERE name IN ('snapshot_component_edge_aggregates', 'snapshot_component_edge_aggregate_receipts')
                   ORDER BY name`,
                  )
                  .all(),
                ready: database.query('SELECT state FROM snapshots WHERE id = ?').get(SNAPSHOT_ID),
                revision: database
                  .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
                  .get(),
              };
            } finally {
              database.close(false);
            }
          });

          expect(observed).toEqual({
            active: [{snapshot_id: SNAPSHOT_ID, worktree_id: WORKTREE_ID}],
            aggregates: [
              {name: 'snapshot_component_edge_aggregate_receipts'},
              {name: 'snapshot_component_edge_aggregates'},
            ],
            ready: {state: 'ready'},
            revision: {value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)},
          });
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('carries the revision 8 cleanup authority into the current extension schema', () =>
    withFixture('threadnote-removed-cleanup-migration-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            seedSnapshot(database, NEW_SNAPSHOT_ID, OTHER_WORKTREE_ID, 'building');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
            for (const statement of legacyCodeGraphAuthorityStatements) database.exec(statement);
            database.exec('DROP TABLE IF EXISTS removed_view_cleanup');
            database.exec('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete');
            database.exec('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert');
            database.exec('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update');
            database.query("DELETE FROM schema_metadata WHERE key = 'removed_view_cleanup_epoch_sequence'").run();
            database
              .query("UPDATE schema_metadata SET value = '7' WHERE key = 'persistent_extension_schema_revision'")
              .run();
          } finally {
            database.close(false);
          }
        });

        yield* store.initialize(databasePath);

        const observed = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return {
              active: database.query('SELECT worktree_id, snapshot_id FROM active_snapshots').all(),
              building: database.query('SELECT state FROM snapshots WHERE id = ?').get(NEW_SNAPSHOT_ID),
              cleanupDefinition: database
                .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'removed_view_cleanup'")
                .get(),
              ready: database.query('SELECT state FROM snapshots WHERE id = ?').get(SNAPSHOT_ID),
              revision: database
                .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
                .get(),
            };
          } finally {
            database.close(false);
          }
        });

        expect(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION).toBe(19);
        expect(observed.revision).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
        expect(observed.ready).toEqual({state: 'ready'});
        expect(observed.building).toEqual({state: 'building'});
        expect(observed.active).toEqual([{snapshot_id: SNAPSHOT_ID, worktree_id: WORKTREE_ID}]);
        expect(observed.cleanupDefinition).toEqual({sql: expect.stringMatching(/WITHOUT\s+ROWID/iu)});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('adds inventory reuse evidence when upgrading a revision 12 database', () =>
    withFixture('threadnote-inventory-receipt-migration-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.exec('DROP TRIGGER IF EXISTS snapshot_reuse_component_surfaces');
            database.exec('ALTER TABLE snapshot_reuse_receipts DROP COLUMN component_surfaces_json');
            database.exec('ALTER TABLE snapshot_reuse_receipts DROP COLUMN inventory_receipt_json');
            database
              .query("UPDATE schema_metadata SET value = '12' WHERE key = 'persistent_extension_schema_revision'")
              .run();
          } finally {
            database.close(false);
          }
        });

        yield* store.initialize(databasePath);

        const observed = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return {
              columns: EffectArray.map(
                database.query<{readonly name: string}, []>('PRAGMA table_info(snapshot_reuse_receipts)').all(),
                row => row.name,
              ),
              revision: database
                .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
                .get(),
            };
          } finally {
            database.close(false);
          }
        });

        expect(observed.columns).toContain('inventory_receipt_json');
        expect(observed.revision).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses an incompatible revision-8 queue without mutating graph authority', () =>
    withFixture('threadnote-removed-cleanup-incompatible-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
            database.exec('DROP TABLE IF EXISTS removed_view_cleanup');
            database.exec('CREATE TABLE removed_view_cleanup (worktree_id TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID');
            database
              .query("UPDATE schema_metadata SET value = '7' WHERE key = 'persistent_extension_schema_revision'")
              .run();
          } finally {
            database.close(false);
          }
        });

        const failure = yield* store.initialize(databasePath).pipe(Effect.flip);
        expect(failure.message).toContain('removed view cleanup schema is incompatible');

        const observed = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return {
              active: database.query('SELECT worktree_id, snapshot_id FROM active_snapshots').all(),
              cleanupColumns: database.query("PRAGMA table_info('removed_view_cleanup')").all(),
              ready: database.query('SELECT state FROM snapshots WHERE id = ?').get(SNAPSHOT_ID),
              revision: database
                .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
                .get(),
            };
          } finally {
            database.close(false);
          }
        });
        expect(observed.revision).toEqual({value: '7'});
        expect(observed.ready).toEqual({state: 'ready'});
        expect(observed.active).toEqual([{snapshot_id: SNAPSHOT_ID, worktree_id: WORKTREE_ID}]);
        expect(observed.cleanupColumns).toEqual([expect.objectContaining({name: 'worktree_id', pk: 1, type: 'TEXT'})]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails before WAL or mutation when a current database loses a required authority index', () =>
    withFixture('threadnote-removed-cleanup-index-loss-', ({databasePath}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const deleteJournalDatabasePath = `${databasePath}.delete-journal`;
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.query('VACUUM INTO ?').run(deleteJournalDatabasePath);
          } finally {
            database.close(false);
          }
          const copy = new Database(deleteJournalDatabasePath, {strict: true});
          try {
            copy.run('DROP INDEX snapshots_base_state_id');
            copy.run("INSERT INTO schema_metadata (key, value) VALUES ('index_loss_sentinel', 'preserve')");
          } finally {
            copy.close(false);
          }
        });

        const failure = yield* store.initialize(deleteJournalDatabasePath).pipe(Effect.flip);
        expect(failure.message).toContain('cleanup schema is incompatible');
        const observed = yield* Effect.sync(() => {
          const database = new Database(deleteJournalDatabasePath, {readonly: true, strict: true});
          try {
            return {
              index: database.query("SELECT name FROM sqlite_master WHERE name = 'snapshots_base_state_id'").get(),
              journal: database.query('PRAGMA journal_mode').get(),
              sentinel: database.query("SELECT value FROM schema_metadata WHERE key = 'index_loss_sentinel'").get(),
            };
          } finally {
            database.close(false);
          }
        });
        expect(observed).toEqual({index: null, journal: {journal_mode: 'delete'}, sentinel: {value: 'preserve'}});
        expect(yield* fs.exists(`${deleteJournalDatabasePath}-wal`)).toBe(false);
        expect(yield* fs.exists(`${deleteJournalDatabasePath}-shm`)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects near-canonical cleanup table DDL before WAL without mutating authority', () =>
    withFixture('threadnote-removed-cleanup-table-drift-', ({databasePath}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            seedSnapshot(database, NEW_SNAPSHOT_ID, OTHER_WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(OTHER_WORKTREE_ID, NEW_SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
          } finally {
            database.close(false);
          }
        });
        expect(
          yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID, {
            cleanupEvidence: {
              recordDigest: RECORD_DIGEST,
              recordIdentity: RECORD_IDENTITY,
              repositoryId: REPOSITORY_ID,
            },
          }),
        ).toMatchObject({state: 'removed'});
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database
              .query("INSERT INTO schema_metadata (key, value) VALUES ('cleanup_ddl_sentinel', 'preserve')")
              .run();
          } finally {
            database.close(false);
          }
        });

        const cases = [
          {
            mutate: (definition: string) =>
              Effect2.pipe(definition, EffectString.replace("'vector-pointers'", "'VECTOR-POINTERS'")),
            name: 'uppercase-phase-literal',
          },
          {
            mutate: (definition: string) =>
              Effect2.pipe(
                definition,
                EffectString.replace(
                  'worktree_id TEXT NOT NULL CHECK',
                  'worktree_id TEXT NOT NULL COLLATE NOCASE CHECK',
                ),
              ),
            name: 'nocase-primary-key',
          },
          {
            mutate: (definition: string) =>
              Effect2.pipe(
                definition,
                EffectString.replace('revision INTEGER NOT NULL CHECK', 'revision INTEGER NOT NULL DEFAULT 0 CHECK'),
              ),
            name: 'revision-default',
          },
          {
            mutate: (definition: string) =>
              Effect2.pipe(
                definition,
                EffectString.replace(/\n\) WITHOUT ROWID$/u, ',\n  CHECK (length(worktree_id) = 64)\n) WITHOUT ROWID'),
              ),
            name: 'redundant-table-check',
          },
        ] as const;

        for (const testCase of cases) {
          const copyPath = `${databasePath}.${testCase.name}.sqlite`;
          const changedSql = yield* Effect.sync(() => {
            const source = new Database(databasePath, {strict: true});
            try {
              source.query('VACUUM INTO ?').run(copyPath);
            } finally {
              source.close(false);
            }
            return rewriteRemovedViewCleanupStoredSql(copyPath, testCase.mutate);
          });
          const before = yield* Effect.sync(() => readCleanupDdlAuthoritySurface(copyPath));
          expect(before.cleanupSql).toBe(changedSql);
          expect(before.journal).toEqual({journal_mode: 'delete'});
          expect(yield* fs.exists(`${copyPath}-wal`)).toBe(false);
          expect(yield* fs.exists(`${copyPath}-shm`)).toBe(false);

          const failure = yield* store.initialize(copyPath).pipe(Effect.flip);
          expect(failure).toBeInstanceOf(CodeGraphStoreError);
          expect(failure.message).toMatch(/removed view cleanup schema is incompatible/iu);
          expect(failure.message).not.toContain(copyPath);
          expect(yield* Effect.sync(() => readCleanupDdlAuthoritySurface(copyPath))).toEqual(before);
          expect(yield* fs.exists(`${copyPath}-wal`)).toBe(false);
          expect(yield* fs.exists(`${copyPath}-shm`)).toBe(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not self-heal a populated unversioned lease table that lost its expiry index', () =>
    withFixture('threadnote-removed-cleanup-legacy-expiry-loss-', ({databasePath}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(databasePath), {recursive: true});
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {create: true, strict: true});
          try {
            database.exec(`
              PRAGMA journal_mode = DELETE;
              CREATE TABLE snapshot_leases (
                token TEXT PRIMARY KEY NOT NULL,
                snapshot_id TEXT NOT NULL,
                expires_at INTEGER NOT NULL
              );
              INSERT INTO snapshot_leases (token, snapshot_id, expires_at)
              VALUES ('preserve', 'legacy-snapshot', 0);
            `);
          } finally {
            database.close(false);
          }
        });

        const store = yield* CodeGraphStore;
        const failure = yield* store.initialize(databasePath).pipe(Effect.flip);
        expect(failure.message).toContain('snapshot lease expiry index is unavailable');

        const observed = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return {
              columns: database.query("SELECT name FROM pragma_table_info('snapshot_leases') ORDER BY cid").all(),
              index: database.query("SELECT name FROM sqlite_master WHERE name = 'snapshot_leases_expiry'").get(),
              journal: database.query('PRAGMA journal_mode').get(),
              rows: database.query('SELECT token, snapshot_id, expires_at FROM snapshot_leases').all(),
            };
          } finally {
            database.close(false);
          }
        });
        expect(observed).toEqual({
          columns: [{name: 'token'}, {name: 'snapshot_id'}, {name: 'expires_at'}],
          index: null,
          journal: {journal_mode: 'delete'},
          rows: [{expires_at: 0, snapshot_id: 'legacy-snapshot', token: 'preserve'}],
        });
        expect(yield* fs.exists(`${databasePath}-wal`)).toBe(false);
        expect(yield* fs.exists(`${databasePath}-shm`)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('atomically binds cleanup evidence to removal and clears it only on current promotion', () =>
    withFixture('threadnote-removed-cleanup-authority-', ({databasePath, identity}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            seedSnapshot(database, NEW_SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
          } finally {
            database.close(false);
          }
        });

        const removed = yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID, {
          cleanupEvidence: {
            recordDigest: RECORD_DIGEST,
            recordIdentity: RECORD_IDENTITY,
            repositoryId: REPOSITORY_ID,
          },
          requireReconciliationSchema: true,
        });
        expect(removed).toMatchObject({state: 'removed'});
        const queued = readCleanupRows(databasePath);
        expect(queued).toEqual([
          expect.objectContaining({
            attempts: 0,
            blocked_code: null,
            cursor_token: null,
            expected_snapshot_id: SNAPSHOT_ID,
            phase: 'vector-pointers',
            provenance_record_digest: RECORD_DIGEST,
            provenance_record_identity: RECORD_IDENTITY,
            repository_id: REPOSITORY_ID,
            revision: 0,
            worktree_id: WORKTREE_ID,
          }),
        ]);

        yield* store.promote(databasePath, identity, NEW_SNAPSHOT_ID);
        expect(readCleanupRows(databasePath)).toEqual([]);
        expect(readAuthority(databasePath)).toEqual({
          active: [{snapshot_id: NEW_SNAPSHOT_ID, worktree_id: WORKTREE_ID}],
          removed: [],
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps view generations monotonic through a same-clock promote/remove ABA sequence', () =>
    withFixture('threadnote-removed-cleanup-generation-aba-', ({databasePath, identity}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const initialGeneration = '2099-01-01T00:00:00.000Z';
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            seedSnapshot(database, NEW_SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, NEW_SNAPSHOT_ID, initialGeneration);
          } finally {
            database.close(false);
          }
        });
        yield* Effect.acquireRelease(store.acquireSnapshotLease(databasePath, SNAPSHOT_ID, 60_000), token =>
          store.releaseSnapshotLease(databasePath, token).pipe(Effect.orDie),
        );
        yield* Effect.acquireRelease(store.acquireSnapshotLease(databasePath, NEW_SNAPSHOT_ID, 60_000), token =>
          store.releaseSnapshotLease(databasePath, token).pipe(Effect.orDie),
        );

        const firstB = yield* store.loadActiveViewFence(databasePath, WORKTREE_ID);
        expect(firstB).toMatchObject({activatedAt: initialGeneration, snapshotId: NEW_SNAPSHOT_ID});
        yield* store.removeView(databasePath, WORKTREE_ID, NEW_SNAPSHOT_ID);
        const removedB = readRemovedViewGeneration(databasePath);
        yield* store.promote(databasePath, identity, SNAPSHOT_ID);
        const activeA = yield* store.loadActiveViewFence(databasePath, WORKTREE_ID);
        yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID);
        const removedA = readRemovedViewGeneration(databasePath);
        yield* store.promote(databasePath, identity, NEW_SNAPSHOT_ID);
        const finalB = yield* store.loadActiveViewFence(databasePath, WORKTREE_ID);

        expect(
          EffectArray.map(
            [firstB!.activatedAt, removedB, activeA!.activatedAt, removedA, finalB!.activatedAt],
            Date.parse,
          ),
        ).toEqual(EffectArray.map([0, 1, 2, 3, 4], offset => Date.parse(initialGeneration) + offset));
        expect(finalB).toMatchObject({snapshotId: NEW_SNAPSHOT_ID});
        expect(finalB!.activatedAt).not.toBe(firstB!.activatedAt);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('binds one shared snapshot removal without disturbing the other worktree authority', () =>
    withFixture('threadnote-removed-cleanup-shared-snapshot-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            const active = database.prepare(
              'INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)',
            );
            active.run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
            active.run(OTHER_WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(1)));
          } finally {
            database.close(false);
          }
        });

        expect(
          yield* store.removeView(databasePath, OTHER_WORKTREE_ID, SNAPSHOT_ID, {
            cleanupEvidence: {
              recordDigest: RECORD_DIGEST,
              recordIdentity: RECORD_IDENTITY,
              repositoryId: REPOSITORY_ID,
            },
            requireReconciliationSchema: true,
          }),
        ).toMatchObject({state: 'removed'});
        expect(readAuthority(databasePath)).toEqual({
          active: [{snapshot_id: SNAPSHOT_ID, worktree_id: WORKTREE_ID}],
          removed: [{expected_snapshot_id: SNAPSHOT_ID, worktree_id: OTHER_WORKTREE_ID}],
        });
        expect(readCleanupRows(databasePath)).toEqual([
          expect.objectContaining({
            expected_snapshot_id: SNAPSHOT_ID,
            provenance_record_digest: RECORD_DIGEST,
            provenance_record_identity: RECORD_IDENTITY,
            repository_id: REPOSITORY_ID,
            worktree_id: OTHER_WORKTREE_ID,
          }),
        ]);
        expect((yield* store.readySnapshot(databasePath, WORKTREE_ID))?.id).toBe(SNAPSHOT_ID);
        expect(yield* store.readySnapshot(databasePath, OTHER_WORKTREE_ID)).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fences an old promote and same-id old removal even when removed_at repeats', () =>
    withFixture('threadnote-removed-cleanup-same-id-republish-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
          } finally {
            database.close(false);
          }
        });
        yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID);
        const [first] = yield* store.claimRemovedViewCleanupCandidates(databasePath, yield* Clock.currentTimeMillis, 1);
        expect(first).toBeDefined();

        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.transaction(() => {
              database
                .query(
                  `INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(worktree_id, scope_id) DO UPDATE SET
                     snapshot_id = excluded.snapshot_id, activated_at = excluded.activated_at`,
                )
                .run(WORKTREE_ID, SNAPSHOT_ID, new Date(0).toISOString());
              database.query('DELETE FROM removed_views WHERE worktree_id = ?').run(WORKTREE_ID);
            })();
            database.transaction(() => {
              database.query('DELETE FROM active_snapshots WHERE worktree_id = ?').run(WORKTREE_ID);
              database
                .query('INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)')
                .run(WORKTREE_ID, SNAPSHOT_ID, first.removedAt);
            })();
          } finally {
            database.close(false);
          }
        });

        expect(yield* store.authorizeRemovedViewCleanup(databasePath, first)).toEqual({state: 'stale'});
        const [replacement] = yield* store.claimRemovedViewCleanupCandidates(
          databasePath,
          (yield* Clock.currentTimeMillis) + 1,
          1,
        );
        expect(replacement).toBeDefined();
        expect(replacement.expectedSnapshotId).toBe(SNAPSHOT_ID);
        expect(replacement.removedAt).toBe(first.removedAt);
        expect(replacement.epoch).toBeGreaterThan(first.epoch);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('re-deletes matching legacy pointers and rejects stale phase CAS or a different active pointer', () =>
    withFixture('threadnote-removed-cleanup-cas-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            seedSnapshot(database, NEW_SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
          } finally {
            database.close(false);
          }
        });
        yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID);
        const now = yield* Clock.currentTimeMillis;
        const [candidate] = yield* store.claimRemovedViewCleanupCandidates(databasePath, now, 32);
        expect(candidate).toBeDefined();
        const noOpFailure = yield* store
          .updateRemovedViewCleanup(databasePath, candidate, {
            attempts: candidate.attempts,
            cursorToken: candidate.cursorToken,
            nextAttemptAt: candidate.nextAttemptAt,
            phase: candidate.phase,
            updatedAt: candidate.updatedAt,
          })
          .pipe(Effect.flip);
        expect(noOpFailure.message).toContain('update is invalid');

        yield* Effect.sync(() => legacyPromote(databasePath, WORKTREE_ID, SNAPSHOT_ID));
        const authorized = yield* store.authorizeRemovedViewCleanup(databasePath, candidate);
        expect(authorized).toEqual({entry: candidate, state: 'authorized'});
        expect(readAuthority(databasePath).active).toEqual([]);

        const advanced = yield* store.updateRemovedViewCleanup(databasePath, candidate, {
          attempts: 0,
          cursorToken: 'model:' + Effect2.pipe('1', EffectString.repeat(64)),
          nextAttemptAt: 2,
          phase: 'vector-pointers',
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1)),
        });
        expect(advanced).toMatchObject({entry: {revision: 2}, state: 'updated'});
        expect(
          yield* store.updateRemovedViewCleanup(databasePath, candidate, {
            attempts: 0,
            nextAttemptAt: 3,
            phase: 'build-status',
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 2)),
          }),
        ).toEqual({state: 'stale'});

        if (advanced.state !== 'updated') throw new Error('Expected the cleanup receipt to advance.');
        const current = advanced.entry;
        yield* Effect.sync(() => legacyPromote(databasePath, WORKTREE_ID, NEW_SNAPSHOT_ID));
        expect(yield* store.authorizeRemovedViewCleanup(databasePath, current)).toEqual({
          observedSnapshotId: NEW_SNAPSHOT_ID,
          state: 'active-pointer-changed',
        });
        expect(readAuthority(databasePath).active).toEqual([{snapshot_id: NEW_SNAPSHOT_ID, worktree_id: WORKTREE_ID}]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('linearizes identical concurrent full-entry updates to one update and one stale result', () =>
    withFixture('threadnote-removed-cleanup-concurrent-cas-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ? )')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
          } finally {
            database.close(false);
          }
        });
        yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID);
        const [candidate] = yield* store.claimRemovedViewCleanupCandidates(
          databasePath,
          yield* Clock.currentTimeMillis,
          1,
        );
        expect(candidate).toBeDefined();
        const update = {
          attempts: candidate.attempts,
          cursorToken: `concurrent:${Effect2.pipe('1', EffectString.repeat(64))}`,
          nextAttemptAt: candidate.nextAttemptAt,
          phase: candidate.phase,
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(candidate.updatedAt) + 1)),
        } as const;
        const results = yield* Effect.all(
          [
            store.updateRemovedViewCleanup(databasePath, candidate, update, {waitTimeoutMilliseconds: 5_000}),
            store.updateRemovedViewCleanup(databasePath, candidate, update, {waitTimeoutMilliseconds: 5_000}),
          ],
          {concurrency: 'unbounded'},
        );
        expect(EffectArray.map(results, result => result.state).sort()).toEqual(['stale', 'updated']);
        expect(readCleanupRows(databasePath)).toEqual([
          expect.objectContaining({cursor_token: update.cursorToken, revision: candidate.revision + 1}),
        ]);
      }).pipe(TestClock.withLive),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rolls back sequence, revision, and attempt overflow boundaries', () =>
    withFixture('threadnote-removed-cleanup-overflow-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
            database
              .query("UPDATE schema_metadata SET value = ? WHERE key = 'removed_view_cleanup_epoch_sequence'")
              .run(String(Number.MAX_SAFE_INTEGER));
          } finally {
            database.close(false);
          }
        });

        expect((yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID).pipe(Effect.exit))._tag).toBe(
          'Failure',
        );
        expect(readAuthority(databasePath)).toEqual({
          active: [{snapshot_id: SNAPSHOT_ID, worktree_id: WORKTREE_ID}],
          removed: [],
        });
        expect(readCleanupRows(databasePath)).toEqual([]);
        expect(readCleanupMetadata(databasePath)).toEqual([
          {key: 'removed_view_cleanup_epoch_sequence', value: String(Number.MAX_SAFE_INTEGER)},
        ]);

        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.run("UPDATE schema_metadata SET value = '0' WHERE key = 'removed_view_cleanup_epoch_sequence'");
          } finally {
            database.close(false);
          }
        });
        yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database
              .query(
                `UPDATE removed_view_cleanup
                 SET revision = ?, next_attempt_at = 0
                 WHERE worktree_id = ? AND expected_snapshot_id = ?`,
              )
              .run(Number.MAX_SAFE_INTEGER, WORKTREE_ID, SNAPSHOT_ID);
          } finally {
            database.close(false);
          }
        });
        const metadataBeforeRevisionOverflow = readCleanupMetadata(databasePath);
        expect(
          (yield* store
            .claimRemovedViewCleanupCandidates(databasePath, yield* Clock.currentTimeMillis, 1)
            .pipe(Effect.exit))._tag,
        ).toBe('Failure');
        expect(readCleanupRows(databasePath)).toEqual([
          expect.objectContaining({attempts: 0, next_attempt_at: 0, revision: Number.MAX_SAFE_INTEGER}),
        ]);
        expect(readCleanupMetadata(databasePath)).toEqual(metadataBeforeRevisionOverflow);

        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database
              .query(
                `UPDATE removed_view_cleanup
                 SET revision = 0, attempts = ?, next_attempt_at = 0
                 WHERE worktree_id = ? AND expected_snapshot_id = ?`,
              )
              .run(Number.MAX_SAFE_INTEGER, WORKTREE_ID, SNAPSHOT_ID);
          } finally {
            database.close(false);
          }
        });
        const [claimed] = yield* store.claimRemovedViewCleanupCandidates(
          databasePath,
          yield* Clock.currentTimeMillis,
          1,
        );
        expect(claimed).toBeDefined();
        const before = readCleanupRows(databasePath);
        expect(
          (yield* store
            .updateRemovedViewCleanup(databasePath, claimed, {
              attempts: Number.MAX_SAFE_INTEGER + 1,
              blockedCode: 'busy',
              cursorToken: claimed.cursorToken,
              nextAttemptAt: claimed.nextAttemptAt + 1,
              phase: claimed.phase,
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(claimed.updatedAt) + 1)),
            })
            .pipe(Effect.exit))._tag,
        ).toBe('Failure');
        expect(readCleanupRows(databasePath)).toEqual(before);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('marks one lease baton without fanout and retires the tombstone target on final release', () =>
    withFixture('threadnote-removed-cleanup-lease-fanout-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const expiresAt = (yield* TestClock.withLive(Clock.currentTimeMillis)) + 60_000;
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
            const insert = database.prepare(
              `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
               VALUES (?, ?, ?, 0)`,
            );
            database.transaction(() => {
              for (let index = 0; index < 10_000; index += 1) {
                insert.run(
                  `lease-${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}`,
                  SNAPSHOT_ID,
                  expiresAt,
                );
              }
            })();
          } finally {
            database.close(false);
          }
        });

        expect(yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID)).toMatchObject({state: 'removed'});
        const leaseState = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            const observed = database
              .query<{readonly flags: number; readonly leases: number}, []>(
                `SELECT COUNT(*) AS leases, SUM(retire_when_inactive) AS flags
                 FROM snapshot_leases WHERE snapshot_id = '${SNAPSHOT_ID}'`,
              )
              .get()!;
            const carrier = database
              .query<{readonly token: string}, [string]>(
                'SELECT token FROM snapshot_leases WHERE snapshot_id = ? AND retire_when_inactive = 1 LIMIT 2',
              )
              .all(SNAPSHOT_ID);
            expect(carrier).toHaveLength(1);
            database
              .query('DELETE FROM snapshot_leases WHERE snapshot_id = ? AND token <> ?')
              .run(SNAPSHOT_ID, carrier[0].token);
            return {...observed, carrierToken: carrier[0].token};
          } finally {
            database.close(false);
          }
        });
        expect(leaseState).toMatchObject({flags: 1, leases: 10_000});

        yield* store.releaseSnapshotLease(databasePath, leaseState.carrierToken);
        expect(yield* store.readySnapshotById(databasePath, SNAPSHOT_ID)).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps admission and due pages on their source-order indexes without temporary sorting', () =>
    withFixture('threadnote-removed-cleanup-page-plan-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
          } finally {
            database.close(false);
          }
        });
        yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID);

        const now = yield* Clock.currentTimeMillis;
        const plans = yield* Effect.sync(() => ({
          admission: queryPlan(
            databasePath,
            codeGraphRemovedViewCleanupAdmissionPageStatement(Effect2.pipe('0', EffectString.repeat(64)), 'after', 32),
          ),
          due: queryPlan(databasePath, codeGraphRemovedViewCleanupDuePageStatement(now, 32)),
        }));
        expect(EffectArray.some(plans.admission, row => /PRIMARY KEY/u.test(row.detail))).toBe(true);
        expect(
          EffectArray.some(plans.due, row =>
            Effect2.pipe(row.detail, EffectString.includes('removed_view_cleanup_due')),
          ),
        ).toBe(true);
        expect(
          EffectArray.some([...plans.admission, ...plans.due], row => /TEMP B-TREE|SCAN cleanup/u.test(row.detail)),
        ).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('transfers one retirement baton through first, new, middle, and final lease releases', () =>
    withFixture('threadnote-removed-cleanup-baton-transfer-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis));
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
            const insert = database.prepare(
              `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
               VALUES (?, ?, ?, 0)`,
            );
            insert.run('first', SNAPSHOT_ID, now + 10_000);
            insert.run('middle', SNAPSHOT_ID, now + 120_000);
            insert.run('last', SNAPSHOT_ID, now + 180_000);
          } finally {
            database.close(false);
          }
        });

        yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID);
        expect(readLeaseCarriers(databasePath)).toEqual(['first']);
        const newLease = yield* store.acquireSnapshotLease(databasePath, SNAPSHOT_ID, 60_000);
        expect(readLeaseCarriers(databasePath)).toEqual(['first']);

        yield* store.releaseSnapshotLease(databasePath, 'first');
        expect(readLeaseCarriers(databasePath)).toEqual([newLease]);
        yield* store.releaseSnapshotLease(databasePath, newLease);
        expect(readLeaseCarriers(databasePath)).toEqual(['middle']);
        yield* store.releaseSnapshotLease(databasePath, 'middle');
        expect(readLeaseCarriers(databasePath)).toEqual(['last']);
        yield* store.releaseSnapshotLease(databasePath, 'last');

        expect(readLeaseCarriers(databasePath)).toEqual([]);
        expect(yield* store.readySnapshotById(databasePath, SNAPSHOT_ID)).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rolls back old-writer tombstone mutations when the baton index is unavailable', () =>
    withFixture('threadnote-removed-cleanup-trigger-index-loss-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const expiresAt = (yield* TestClock.withLive(Clock.currentTimeMillis)) + 120_000;
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            const removedAt = DateTime.formatIso(DateTime.makeUnsafe(0));
            const updatedAt = DateTime.formatIso(DateTime.makeUnsafe(1));
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            seedSnapshot(database, NEW_SNAPSHOT_ID, OTHER_WORKTREE_ID, 'ready');
            database
              .query(
                `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
                 VALUES ('legacy-reader', ?, ?, 0)`,
              )
              .run(SNAPSHOT_ID, expiresAt);
            database
              .query('INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, removedAt);
            database.run("UPDATE snapshot_leases SET retire_when_inactive = 0 WHERE token = 'legacy-reader'");
            database
              .query(
                `INSERT INTO removed_view_cleanup (
                   worktree_id, expected_snapshot_id, removed_at, epoch,
                   repository_id, provenance_record_digest, provenance_record_identity,
                   phase, cursor_token, revision, attempts, next_attempt_at, blocked_code, updated_at
                 ) VALUES (?, ?, ?, 1, NULL, NULL, NULL, 'complete', NULL, 0, 0, 0, NULL, ?)`,
              )
              .run(OTHER_WORKTREE_ID, NEW_SNAPSHOT_ID, removedAt, removedAt);
            const planStatement = database.prepare<{readonly detail: string}, [string, number]>(
              `EXPLAIN QUERY PLAN
               SELECT token
               FROM snapshot_leases INDEXED BY snapshot_leases_snapshot_expiry
               WHERE snapshot_id = ? AND expires_at > ?
               ORDER BY expires_at
               LIMIT 1`,
            );
            const canonicalPlan = planStatement.all(SNAPSHOT_ID, 0);
            planStatement.finalize();
            expect(
              EffectArray.some(canonicalPlan, row =>
                Effect2.pipe(row.detail, EffectString.includes('snapshot_leases_snapshot_expiry')),
              ),
            ).toBe(true);
            expect(EffectArray.some(canonicalPlan, row => /SCAN|TEMP B-TREE/iu.test(row.detail))).toBe(false);
            database.run('DROP INDEX snapshot_leases_snapshot_expiry');

            const mutations = [
              () =>
                database
                  .query('INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)')
                  .run(OTHER_WORKTREE_ID, NEW_SNAPSHOT_ID, updatedAt),
              () =>
                database
                  .query(
                    `UPDATE removed_views
                     SET worktree_id = ?, expected_snapshot_id = ?, removed_at = ?
                     WHERE worktree_id = ?`,
                  )
                  .run(OTHER_WORKTREE_ID, NEW_SNAPSHOT_ID, updatedAt, WORKTREE_ID),
              () =>
                database
                  .query(
                    `INSERT OR REPLACE INTO removed_views (worktree_id, expected_snapshot_id, removed_at)
                     VALUES (?, ?, ?)`,
                  )
                  .run(WORKTREE_ID, SNAPSHOT_ID, removedAt),
            ];
            for (const mutate of mutations) {
              expect(mutate).toThrow(/no such index: snapshot_leases_snapshot_expiry|baton index is incompatible/iu);
            }
            database.run('CREATE INDEX snapshot_leases_snapshot_expiry ON snapshot_leases(token)');
            for (const mutate of mutations) expect(mutate).toThrow(/snapshot lease baton index is incompatible/iu);
            database.run('DROP INDEX snapshot_leases_snapshot_expiry');
            database.run('CREATE INDEX snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)');
            database.run('DROP TABLE removed_view_cleanup');
            for (const mutate of mutations) expect(mutate).toThrow(/no such table.*removed_view_cleanup/iu);
            database.exec(`CREATE TABLE removed_view_cleanup (
              worktree_id TEXT NOT NULL,
              scope_id TEXT NOT NULL DEFAULT 'full-repository',
              expected_snapshot_id TEXT NOT NULL,
              removed_at TEXT NOT NULL,
              epoch INTEGER PRIMARY KEY NOT NULL,
              repository_id TEXT,
              provenance_record_digest TEXT,
              provenance_record_identity TEXT,
              phase TEXT NOT NULL,
              cursor_token TEXT,
              revision INTEGER NOT NULL,
              attempts INTEGER NOT NULL,
              next_attempt_at INTEGER NOT NULL,
              blocked_code TEXT,
              updated_at TEXT NOT NULL
            )`);
            database
              .query(
                `INSERT INTO removed_view_cleanup (
                   worktree_id, expected_snapshot_id, removed_at, epoch,
                   repository_id, provenance_record_digest, provenance_record_identity,
                   phase, cursor_token, revision, attempts, next_attempt_at, blocked_code, updated_at
                 ) VALUES (?, ?, ?, 1, NULL, NULL, NULL, 'complete', NULL, 0, 0, 0, NULL, ?)`,
              )
              .run(OTHER_WORKTREE_ID, NEW_SNAPSHOT_ID, removedAt, removedAt);
            for (const mutate of mutations) {
              expect(mutate).toThrow(/removed view cleanup authority is incompatible/iu);
            }

            expect(database.query('SELECT * FROM removed_views').all()).toEqual([
              {
                expected_snapshot_id: SNAPSHOT_ID,
                removed_at: removedAt,
                worktree_id: WORKTREE_ID,
                scope_id: 'full-repository',
              },
            ]);
            expect(
              database
                .query(
                  `SELECT worktree_id, expected_snapshot_id, removed_at, epoch, phase, revision
                   FROM removed_view_cleanup`,
                )
                .all(),
            ).toEqual([
              {
                epoch: 1,
                expected_snapshot_id: NEW_SNAPSHOT_ID,
                phase: 'complete',
                removed_at: removedAt,
                revision: 0,
                worktree_id: OTHER_WORKTREE_ID,
              },
            ]);
            expect(
              database
                .query("SELECT token, retire_when_inactive FROM snapshot_leases WHERE token = 'legacy-reader'")
                .get(),
            ).toEqual({retire_when_inactive: 0, token: 'legacy-reader'});
          } finally {
            database.close(false);
          }
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails a corrupt bounded lease page without mutating leases or snapshot authority', () =>
    withFixture('threadnote-removed-cleanup-corrupt-lease-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database.run('PRAGMA foreign_keys = OFF');
            database
              .query(
                `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
                 VALUES ('corrupt', ?, 0, 1)`,
              )
              .run(SNAPSHOT_ID);
            database.run('PRAGMA ignore_check_constraints = ON');
            database.run("UPDATE snapshot_leases SET token = CAST(zeroblob(1048576) AS BLOB) WHERE token = 'corrupt'");
          } finally {
            database.close(false);
          }
        });

        const failure = yield* store.runRoutineMaintenance(databasePath).pipe(Effect.flip);
        expect(failure.message).toContain('snapshot lease manifest is invalid');
        const observed = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return {
              leases: database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get(),
              snapshot: database.query('SELECT state FROM snapshots WHERE id = ?').get(SNAPSHOT_ID),
            };
          } finally {
            database.close(false);
          }
        });
        expect(observed).toEqual({leases: {count: 1}, snapshot: {state: 'ready'}});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a giant corrupt first baton carrier before store or old-writer authority mutation', () =>
    withFixture('threadnote-removed-cleanup-corrupt-baton-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const expiresAt = (yield* TestClock.withLive(Clock.currentTimeMillis)) + 120_000;
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
            database
              .query(
                `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
                 VALUES ('corrupt-carrier', ?, ?, 0)`,
              )
              .run(SNAPSHOT_ID, expiresAt);
            database.run(
              "UPDATE snapshot_leases SET token = CAST(zeroblob(1048576) AS BLOB) WHERE token = 'corrupt-carrier'",
            );
          } finally {
            database.close(false);
          }
        });

        expect((yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_ID).pipe(Effect.exit))._tag).toBe(
          'Failure',
        );
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            expect(() =>
              database
                .query('INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)')
                .run(WORKTREE_ID, SNAPSHOT_ID, new Date(0).toISOString()),
            ).toThrow(/snapshot lease baton index is incompatible/iu);
            expect({
              active: database.query('SELECT worktree_id, snapshot_id FROM active_snapshots').all(),
              cleanup: database.query('SELECT COUNT(*) AS count FROM removed_view_cleanup').get(),
              lease: database
                .query(
                  `SELECT typeof(token) AS token_type, length(CAST(token AS BLOB)) AS token_bytes,
                          retire_when_inactive
                   FROM snapshot_leases`,
                )
                .get(),
              removed: database.query('SELECT COUNT(*) AS count FROM removed_views').get(),
              snapshot: database.query('SELECT state FROM snapshots WHERE id = ?').get(SNAPSHOT_ID),
            }).toEqual({
              active: [{snapshot_id: SNAPSHOT_ID, worktree_id: WORKTREE_ID}],
              cleanup: {count: 0},
              lease: {retire_when_inactive: 0, token_bytes: 1_048_576, token_type: 'blob'},
              removed: {count: 0},
              snapshot: {state: 'ready'},
            });
          } finally {
            database.close(false);
          }
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a case-folded lease capability before validate, renew, or release can alias it', () =>
    withFixture('threadnote-removed-cleanup-lease-collation-', ({databasePath}) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const expiresAt = (yield* TestClock.withLive(Clock.currentTimeMillis)) + 120_000;
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            seedSnapshot(database, SNAPSHOT_ID, WORKTREE_ID, 'ready');
            database
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(WORKTREE_ID, SNAPSHOT_ID, DateTime.formatIso(DateTime.makeUnsafe(0)));
          } finally {
            database.close(false);
          }
        });
        const warmToken = yield* store.acquireSnapshotLease(databasePath, SNAPSHOT_ID, 60_000);
        yield* store.releaseSnapshotLease(databasePath, warmToken);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database
              .query(
                `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
                 VALUES ('capability-lower', ?, ?, 1)`,
              )
              .run(SNAPSHOT_ID, expiresAt);
          } finally {
            database.close(false);
          }
          rebuildLeaseCapabilityNoCase(databasePath);
        });

        expect(
          yield* store.validateViewSnapshotLease(databasePath, WORKTREE_ID, SNAPSHOT_ID, 'CAPABILITY-LOWER', 0),
        ).toEqual({state: 'invalid'});
        expect((yield* store.acquireSnapshotLease(databasePath, SNAPSHOT_ID, 60_000).pipe(Effect.exit))._tag).toBe(
          'Failure',
        );
        expect((yield* store.renewSnapshotLease(databasePath, 'CAPABILITY-LOWER', 60_000).pipe(Effect.exit))._tag).toBe(
          'Failure',
        );
        expect((yield* store.releaseSnapshotLease(databasePath, 'CAPABILITY-LOWER').pipe(Effect.exit))._tag).toBe(
          'Failure',
        );
        expect(
          (yield* store
            .retainViewSnapshotLease(databasePath, WORKTREE_ID, SNAPSHOT_ID, 60_000, {
              existingToken: 'CAPABILITY-LOWER',
            })
            .pipe(Effect.exit))._tag,
        ).toBe('Failure');
        const row = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return database
              .query('SELECT token, snapshot_id, expires_at, retire_when_inactive FROM snapshot_leases')
              .get();
          } finally {
            database.close(false);
          }
        });
        expect(row).toEqual({
          expires_at: expiresAt,
          retire_when_inactive: 1,
          snapshot_id: SNAPSHOT_ID,
          token: 'capability-lower',
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function rebuildLeaseCapabilityNoCase(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('PRAGMA foreign_keys = OFF');
    database.run('BEGIN IMMEDIATE');
    try {
      database.run(`CREATE TABLE snapshot_leases_drift_fixture (
        token TEXT COLLATE NOCASE PRIMARY KEY NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        retire_when_inactive INTEGER NOT NULL DEFAULT 0 CHECK (retire_when_inactive IN (0, 1))
      )`);
      database.run('INSERT INTO snapshot_leases_drift_fixture SELECT * FROM snapshot_leases');
      database.run('DROP TABLE snapshot_leases');
      database.run(`CREATE TABLE snapshot_leases (
        token TEXT COLLATE NOCASE PRIMARY KEY NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        retire_when_inactive INTEGER NOT NULL DEFAULT 0 CHECK (retire_when_inactive IN (0, 1))
      )`);
      database.run('INSERT INTO snapshot_leases SELECT * FROM snapshot_leases_drift_fixture');
      database.run('DROP TABLE snapshot_leases_drift_fixture');
      database.run('CREATE INDEX snapshot_leases_expiry ON snapshot_leases(expires_at)');
      database.run('CREATE INDEX snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)');
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    } finally {
      database.run('PRAGMA foreign_keys = ON');
    }
  } finally {
    database.close(false);
  }
}

function rewriteRemovedViewCleanupStoredSql(databasePath: string, mutate: (definition: string) => string): string {
  const database = new Database(databasePath, {strict: true});
  try {
    const row = database
      .query<{readonly sql: string}, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'removed_view_cleanup'",
      )
      .get();
    if (row === null) throw TestError.make({message: 'missing canonical removed view cleanup table'});
    const changed = mutate(row.sql);
    if (changed === row.sql)
      throw TestError.make({message: 'removed view cleanup table mutation did not change its definition'});
    const dueIndex = database
      .query<{readonly sql: string}, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'removed_view_cleanup_due'",
      )
      .get();
    if (dueIndex === null) throw TestError.make({message: 'missing canonical removed view cleanup due index'});
    database.run('PRAGMA foreign_keys = OFF');
    database.run('PRAGMA ignore_check_constraints = ON');
    database.run('BEGIN IMMEDIATE');
    try {
      database.run('CREATE TEMP TABLE preserved_removed_view_cleanup AS SELECT * FROM removed_view_cleanup');
      database.run('DROP TABLE removed_view_cleanup');
      database.run(changed);
      database.run('INSERT INTO removed_view_cleanup SELECT * FROM preserved_removed_view_cleanup');
      database.run(dueIndex.sql);
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    } finally {
      database.run('PRAGMA ignore_check_constraints = OFF');
      database.run('PRAGMA foreign_keys = ON');
    }
    return changed;
  } finally {
    database.close(false);
  }
}

function readCleanupDdlAuthoritySurface(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      active: database
        .query('SELECT worktree_id, snapshot_id, activated_at FROM active_snapshots ORDER BY worktree_id')
        .all(),
      cleanup: database.query('SELECT * FROM removed_view_cleanup ORDER BY worktree_id, expected_snapshot_id').all(),
      cleanupSql: requiredRow(
        database
          .query<{readonly sql: string}, SQLQueryBindings[]>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'removed_view_cleanup'",
          )
          .get(),
      ).sql,
      journal: database.query('PRAGMA journal_mode').get(),
      metadata: database.query('SELECT key, value FROM schema_metadata ORDER BY key').all(),
      removed: database
        .query('SELECT worktree_id, expected_snapshot_id, removed_at FROM removed_views ORDER BY worktree_id')
        .all(),
      snapshots: database.query('SELECT id, repository_id, worktree_id, state FROM snapshots ORDER BY id').all(),
    };
  } finally {
    database.close(false);
  }
}

function readLeaseCarriers(databasePath: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return EffectArray.map(
      database
        .query<{readonly token: string}, []>(
          'SELECT token FROM snapshot_leases WHERE retire_when_inactive = 1 ORDER BY token',
        )
        .all(),
      row => row.token,
    );
  } finally {
    database.close(false);
  }
}

function readRemovedViewGeneration(databasePath: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query<{readonly removed_at: string}, [string]>('SELECT removed_at FROM removed_views WHERE worktree_id = ?')
      .get(WORKTREE_ID);
    if (row === null) throw TestError.make({message: 'missing removed view generation'});
    return row.removed_at;
  } finally {
    database.close(false);
  }
}

function queryPlan(
  databasePath: string,
  statement: {readonly parameters: readonly (number | string)[]; readonly text: string},
): readonly {readonly detail: string}[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<
        {
          readonly detail: string;
        },
        SQLQueryBindings[]
      >(`EXPLAIN QUERY PLAN ${statement.text}`)
      .all(...statement.parameters);
  } finally {
    database.close(false);
  }
}

function withFixture<A, E, R>(
  prefix: string,
  use: (fixture: {readonly databasePath: string; readonly identity: RepositoryIdentity}) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix});
      const databasePath = path.join(root, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'graph-v3.sqlite');
      const identity: RepositoryIdentity = {
        caseMode: 'sensitive',
        checkoutId: CHECKOUT_ID,
        displayName: 'fixture',
        gitCommonDirectory: path.join(root, '.git'),
        headCommit: Effect2.pipe('1', EffectString.repeat(40)),
        objectFormat: 'sha1',
        repoRoot: root,
        repositoryId: REPOSITORY_ID,
        worktreeId: WORKTREE_ID,
      };
      return yield* use({databasePath, identity});
    }),
  );
}

function seedSnapshot(database: Database, snapshotId: string, worktreeId: string, state: 'building' | 'ready'): void {
  database
    .query(
      `INSERT OR IGNORE INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES (?, 'fixture', 'sha1', ?, ?)`,
    )
    .run(REPOSITORY_ID, new Date(0).toISOString(), new Date(0).toISOString());
  database
    .query(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
         extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
         edge_count, started_at, completed_at, failure_summary
       ) VALUES (?, ?, ?, ?, ?, NULL, 'fixture', 0, NULL, ?, 0, 0, 0, ?, ?, NULL)`,
    )
    .run(
      snapshotId,
      REPOSITORY_ID,
      worktreeId,
      Effect2.pipe('1', EffectString.repeat(40)),
      `cgc_${Effect2.pipe(snapshotId, EffectString.slice(-40))}`,
      state,
      new Date(0).toISOString(),
      state === 'ready' ? new Date(0).toISOString() : null,
    );
  database
    .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
    .run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
}

function legacyPromote(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(worktree_id, scope_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, activated_at = excluded.activated_at`,
      )
      .run(worktreeId, snapshotId, new Date(0).toISOString());
  } finally {
    database.close(false);
  }
}

function readCleanupRows(databasePath: string): readonly Record<string, unknown>[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<Record<string, unknown>, SQLQueryBindings[]>(
        `SELECT worktree_id, expected_snapshot_id, repository_id,
                provenance_record_digest, provenance_record_identity,
                phase, cursor_token, revision, attempts, next_attempt_at,
                blocked_code, updated_at
         FROM removed_view_cleanup
         ORDER BY worktree_id, expected_snapshot_id`,
      )
      .all();
  } finally {
    database.close(false);
  }
}

function readCleanupMetadata(databasePath: string): readonly {readonly key: string; readonly value: string}[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly key: string; readonly value: string}, []>(
        `SELECT key, value
         FROM schema_metadata
         WHERE key IN ('removed_view_cleanup_admission_cursor', 'removed_view_cleanup_epoch_sequence')
         ORDER BY key`,
      )
      .all();
  } finally {
    database.close(false);
  }
}

function readAuthority(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      active: database.query('SELECT worktree_id, snapshot_id FROM active_snapshots ORDER BY worktree_id').all(),
      removed: database.query('SELECT worktree_id, expected_snapshot_id FROM removed_views ORDER BY worktree_id').all(),
    };
  } finally {
    database.close(false);
  }
}
