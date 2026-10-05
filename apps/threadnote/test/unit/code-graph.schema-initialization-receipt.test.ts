import {provideTestLayer} from '../helpers/effect-layer.js';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path, Schema} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION, CodeGraphStore} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CODE_GRAPH_SCHEMA_VERSION} from '@threadnote/graph/types';
import {
  CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION,
  CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE,
  CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM,
  CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM,
  currentCodeGraphSchemaInitializationReceipt,
} from '@threadnote/graph/store/schema/receipt';
import {REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS} from '@threadnote/graph/store/schema/metadata';
import {
  REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY,
  REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY,
} from '@threadnote/graph/store/removed/view_schema_contracts';
import {codeGraphScopeCursor} from '@threadnote/graph/store/scope/cursor';
import {CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION} from '@threadnote/graph/store/schema/revision';
import {CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES, configureConnection} from '@threadnote/graph/store/session';
import {compactCodeGraphStorage, inspectCodeGraphStorage} from '@threadnote/graph/storage';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as SqlClient from 'effect/sql/SqlClient';

describe('code graph schema initialization receipt', () => {
  effectIt.effect('sets the WAL retention limit on each writable connection', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* configureConnection(sql);
      const rows = yield* sql.unsafe<{readonly journal_size_limit: number}>('PRAGMA journal_size_limit');
      expect(rows[0]?.journal_size_limit).toBe(CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES);
    }).pipe(provideTestLayer(SqliteClient.layer({filename: ':memory:', disableWAL: true}))),
  );

  effectIt.effect('reclaims an oversized dormant WAL through the locked production storage path', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-dormant-wal-'});
        const checkoutId = 'f'.repeat(64);
        const databasePath = path.join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          checkoutId,
          `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
        );
        yield* fs.makeDirectory(path.dirname(databasePath), {recursive: true});
        // Keep a connection open but idle: closing SQLite's final connection is
        // allowed to clean up the WAL before the production path can inspect it.
        const _idleReader = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const writer = new Database(databasePath, {create: true, strict: true});
            const reader = new Database(databasePath, {readonly: true, strict: true});
            try {
              writer.exec(`
              PRAGMA journal_mode = WAL;
              PRAGMA wal_autocheckpoint = 0;
              CREATE TABLE schema_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
              INSERT INTO schema_metadata (key, value) VALUES ('schema_version', '${CODE_GRAPH_SCHEMA_VERSION}');
              CREATE TABLE snapshots (state TEXT NOT NULL);
              INSERT INTO snapshots (state) VALUES ('ready');
              CREATE TABLE active_snapshots (snapshot_id TEXT NOT NULL);
              INSERT INTO active_snapshots (snapshot_id) VALUES ('ready-snapshot');
              CREATE TABLE payload (id INTEGER PRIMARY KEY, value BLOB NOT NULL);
            `);
              reader.exec('BEGIN');
              // Establish the reader snapshot before the writer grows the WAL;
              // closing the writer must therefore leave a dormant sidecar.
              reader.query('SELECT COUNT(*) AS count FROM payload').get();
              const insert = writer.prepare('INSERT INTO payload (id, value) VALUES (?, ?)');
              const payload = new Uint8Array(256 * 1024).fill(37);
              writer.transaction(() => {
                for (let index = 0; index < 320; index += 1) insert.run(index, payload);
              })();
              writer.close(false);
              reader.exec('COMMIT');
              return reader;
            } catch (cause) {
              try {
                writer.close(false);
              } catch {
                // A failed fixture setup may have already closed the writer.
              }
              reader.close(false);
              throw cause;
            }
          }),
          reader => Effect.sync(() => reader.close(false)),
        );
        const before = yield* inspectCodeGraphStorage(home, checkoutId);
        expect(before).toMatchObject({pageStorage: {freelistPages: 0, state: 'available'}, state: 'available'});
        if (before.state !== 'available') throw new Error('expected dormant code graph storage');
        expect(before.walBytes).toBeGreaterThan(CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES);

        const compacted = yield* compactCodeGraphStorage(home, checkoutId, {dryRun: false});
        expect(compacted).toMatchObject({action: 'compacted', reclaimedBytes: expect.any(Number)});
        const after = yield* inspectCodeGraphStorage(home, checkoutId);
        if (after.state !== 'available') throw new Error('expected reclaimed code graph storage');
        expect(after.walBytes).toBeLessThanOrEqual(CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES);
        expect(after.journalBytes).toBeLessThanOrEqual(CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES);
        expect(compacted.reclaimedBytes).toBeGreaterThan(0);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            expect(database.query('SELECT COUNT(*) AS count FROM payload').get()).toEqual({count: 320});
            expect(database.query('PRAGMA quick_check').get()).toEqual({quick_check: 'ok'});
          } finally {
            database.close(false);
          }
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  it('admits only an exact receipt across arbitrary schema-cookie observations', () => {
    fc.assert(
      fc.property(
        fc.integer({max: CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM, min: CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM}),
        fc.integer({max: 1_000, min: 1}),
        fc.integer({max: 1_000, min: 0}),
        fc.boolean(),
        (sqliteSchemaVersion, increment, extractorIncrement, cleanupCursorRecorded) => {
          const current = {
            metadataCoreSchemaVersion: CODE_GRAPH_SCHEMA_VERSION,
            metadataMinimumExtractorGeneration: CODE_GRAPH_EXTRACTOR_GENERATION + extractorIncrement,
            metadataPersistentExtensionRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
            metadataRemovedViewCleanupCursorCurrent: true,
            metadataRemovedViewCleanupCursorRecorded: cleanupCursorRecorded,
            metadataRemovedViewCleanupEpochCurrent: true,
            metadataRowCount: REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - (cleanupCursorRecorded ? 0 : 1),
            observedSqliteSchemaVersion: sqliteSchemaVersion,
            receiptContractRevision: CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION,
            receiptCoreSchemaVersion: CODE_GRAPH_SCHEMA_VERSION,
            receiptPersistentExtensionRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
            receiptSqliteSchemaVersion: sqliteSchemaVersion,
          };
          expect(currentCodeGraphSchemaInitializationReceipt(current)).toBe(true);
          for (const drifted of [
            {...current, metadataCoreSchemaVersion: current.metadataCoreSchemaVersion + increment},
            {
              ...current,
              metadataPersistentExtensionRevision: current.metadataPersistentExtensionRevision + increment,
            },
            {...current, metadataMinimumExtractorGeneration: CODE_GRAPH_EXTRACTOR_GENERATION - 1},
            {...current, metadataRemovedViewCleanupCursorCurrent: false},
            {...current, metadataRemovedViewCleanupEpochCurrent: false},
            {...current, metadataRowCount: current.metadataRowCount + 1},
            {...current, observedSqliteSchemaVersion: current.observedSqliteSchemaVersion + increment},
            {...current, receiptContractRevision: current.receiptContractRevision + increment},
            {...current, receiptCoreSchemaVersion: current.receiptCoreSchemaVersion + increment},
            {
              ...current,
              receiptPersistentExtensionRevision: current.receiptPersistentExtensionRevision + increment,
            },
            {...current, receiptSqliteSchemaVersion: current.receiptSqliteSchemaVersion + increment},
          ]) {
            expect(currentCodeGraphSchemaInitializationReceipt(drifted)).toBe(false);
          }
        },
      ),
      {numRuns: 150},
    );
  });

  effectIt.effect('skips validated no-op DDL and falls back after a persistent schema-cookie change', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-schema-receipt-'});
        const databasePath = path.join(root, 'graph.sqlite');
        const writerLockPath = path.join(root, 'writer.lock');

        yield* store.initialize(databasePath);
        yield* useWritableDatabase(databasePath, database => {
          database.exec('CREATE TABLE schema_initialization_test_marker (value INTEGER NOT NULL)');
        });

        // The marker changes main.schema_version, so this pass must replay full
        // validation once and bind a fresh receipt to the new cookie.
        yield* store.withSession(databasePath, store.initialize(databasePath), {
          cleanupCompletedBuildRows: true,
          writerLockPath,
        });

        const observer = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(databasePath, {readonly: true, strict: true})),
          database => Effect.sync(() => database.close(false)),
        );
        const beforeFastPath = dataVersion(observer);

        yield* store.withSession(databasePath, store.initialize(databasePath), {
          cleanupCompletedBuildRows: true,
          writerLockPath,
        });
        expect(dataVersion(observer)).toBe(beforeFastPath);

        yield* useWritableDatabase(databasePath, database => {
          database.exec('DROP INDEX edges_source');
        });
        const beforeRepair = dataVersion(observer);

        // Required-index DDL drift advances the cookie. The next process/session
        // must use the full path, repair it, and publish a new exact receipt.
        yield* store.withSession(databasePath, store.initialize(databasePath), {
          cleanupCompletedBuildRows: true,
          writerLockPath,
        });
        expect(dataVersion(observer)).not.toBe(beforeRepair);
        yield* useReadonlyDatabase(databasePath, database => {
          const schemaVersion = database
            .query<{readonly schema_version: number}, []>('PRAGMA main.schema_version')
            .get()?.schema_version;
          expect(database.query("SELECT type FROM sqlite_master WHERE name = 'edges_source'").get()).toEqual({
            type: 'index',
          });
          expect(
            database.query(`SELECT sqlite_schema_version FROM ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE}`).get(),
          ).toEqual({sqlite_schema_version: schemaVersion});
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('admits a scoped cleanup cursor without replaying schema initialization', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-scoped-cursor-receipt-'});
        const databasePath = path.join(root, 'graph.sqlite');
        const writerLockPath = path.join(root, 'writer.lock');
        const cursor = codeGraphScopeCursor('a'.repeat(64), `code-graph-scope:${'b'.repeat(64)}`);

        yield* store.initialize(databasePath);
        yield* useWritableDatabase(databasePath, database => {
          database
            .query('INSERT INTO schema_metadata (key, value) VALUES (?, ?)')
            .run(REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY, cursor);
        });

        const observer = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(databasePath, {readonly: true, strict: true})),
          database => Effect.sync(() => database.close(false)),
        );
        const beforeFastPath = dataVersion(observer);

        yield* store.withSession(databasePath, store.initialize(databasePath), {writerLockPath});

        expect(dataVersion(observer)).toBe(beforeFastPath);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect.prop(
    'admits scoped cleanup cursors across the SQL receipt path',
    {
      scopeSeed: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 65_535})),
      worktreeSeed: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 65_535})),
    },
    ({scopeSeed, worktreeSeed}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-scoped-cursor-property-'});
          const databasePath = path.join(root, 'graph.sqlite');
          const writerLockPath = path.join(root, 'writer.lock');
          const cursor = codeGraphScopeCursor(
            worktreeSeed.toString(16).padStart(64, '0'),
            `code-graph-scope:${scopeSeed.toString(16).padStart(64, '0')}`,
          );

          yield* store.initialize(databasePath);
          yield* useWritableDatabase(databasePath, database => {
            database
              .query('INSERT INTO schema_metadata (key, value) VALUES (?, ?)')
              .run(REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY, cursor);
          });

          const observer = yield* Effect.acquireRelease(
            Effect.sync(() => new Database(databasePath, {readonly: true, strict: true})),
            database => Effect.sync(() => database.close(false)),
          );
          const beforeFastPath = dataVersion(observer);

          yield* store.withSession(databasePath, store.initialize(databasePath), {writerLockPath});

          expect(dataVersion(observer)).toBe(beforeFastPath);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    {arbitrary: {runs: 16, seed: 'schema-receipt-scoped-cleanup-cursor'}},
  );

  effectIt.effect('restores the endpoint index when opening a valid pre-index receipt', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-endpoint-index-upgrade-'});
        const databasePath = path.join(root, 'graph.sqlite');
        const writerLockPath = path.join(root, 'writer.lock');

        yield* store.initialize(databasePath);
        yield* useWritableDatabase(databasePath, database => {
          database.exec('DROP INDEX edges_endpoints');
          const schemaVersion = database
            .query<{readonly schema_version: number}, []>('PRAGMA main.schema_version')
            .get()?.schema_version;
          if (schemaVersion === undefined) throw new Error('SQLite schema version is unavailable.');
          database
            .query(
              `UPDATE ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE}
               SET contract_revision = ?, sqlite_schema_version = ? WHERE singleton = 1`,
            )
            .run(CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION.endpointIndexPredecessor, schemaVersion);
        });

        yield* store.withSession(databasePath, store.initialize(databasePath), {writerLockPath});

        yield* useReadonlyDatabase(databasePath, database => {
          expect(database.query("SELECT type FROM sqlite_master WHERE name = 'edges_endpoints'").get()).toEqual({
            type: 'index',
          });
          expect(
            database.query(`SELECT contract_revision FROM ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE}`).get(),
          ).toEqual({contract_revision: CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION});
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('upgrades a valid predecessor receipt before fold-forward tables are used', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-fold-forward-upgrade-'});
        const databasePath = path.join(root, 'graph.sqlite');
        const writerLockPath = path.join(root, 'writer.lock');

        yield* store.initialize(databasePath);
        yield* useWritableDatabase(databasePath, database => {
          database.exec(`
            DROP TABLE snapshot_fold_forward_symbol_lookup;
            DROP TABLE snapshot_fold_forward_paths;
            DROP TABLE snapshot_fold_forward_receipts;
          `);
          const schemaVersion = database
            .query<{readonly schema_version: number}, []>('PRAGMA main.schema_version')
            .get()?.schema_version;
          if (schemaVersion === undefined) throw new Error('SQLite schema version is unavailable.');
          database
            .query(
              `UPDATE ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE}
               SET contract_revision = ?, sqlite_schema_version = ?
               WHERE singleton = 1`,
            )
            .run(CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION.foldForwardPredecessor, schemaVersion);
        });

        yield* store.withSession(databasePath, store.initialize(databasePath), {
          cleanupCompletedBuildRows: true,
          writerLockPath,
        });

        yield* useReadonlyDatabase(databasePath, database => {
          const tables = database
            .query<{readonly name: string}, []>(
              `SELECT name FROM sqlite_master
               WHERE type = 'table' AND name LIKE 'snapshot_fold_forward_%'
               ORDER BY name`,
            )
            .all()
            .map(row => row.name);
          const receipt = database
            .query<{readonly contract_revision: number}, []>(
              `SELECT contract_revision FROM ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE}`,
            )
            .get();
          expect(tables).toEqual([
            'snapshot_fold_forward_paths',
            'snapshot_fold_forward_receipts',
            'snapshot_fold_forward_symbol_lookup',
          ]);
          expect(receipt).toEqual({contract_revision: CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION});
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('never lets a receipt bypass mutable cleanup-authority corruption', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-schema-receipt-corrupt-'});
        const databasePath = path.join(root, 'graph.sqlite');
        const writerLockPath = path.join(root, 'writer.lock');

        yield* store.initialize(databasePath);
        yield* useWritableDatabase(databasePath, database => {
          database
            .query('UPDATE schema_metadata SET value = ? WHERE key = ?')
            .run('malformed', REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY);
        });

        const exit = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            cleanupCompletedBuildRows: true,
            writerLockPath,
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        yield* useReadonlyDatabase(databasePath, database => {
          expect(
            database
              .query('SELECT value FROM schema_metadata WHERE key = ?')
              .get(REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY),
          ).toEqual({value: 'malformed'});
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('fails closed on a drifted receipt definition before schema repair', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-schema-receipt-drift-'});
        const databasePath = path.join(root, 'graph.sqlite');

        yield* store.initialize(databasePath);
        yield* useWritableDatabase(databasePath, database => {
          database.exec(`
            DROP TABLE ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE};
            CREATE TABLE ${CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE} (
              singleton INTEGER PRIMARY KEY,
              incompatible TEXT NOT NULL
            );
          `);
        });

        const exit = yield* store.initialize(databasePath).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        yield* useReadonlyDatabase(databasePath, database => {
          expect(
            database
              .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_TABLE),
          ).toMatchObject({sql: expect.stringContaining('incompatible TEXT NOT NULL')});
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});

function dataVersion(database: Database): number {
  return Number(database.query<{readonly data_version: number}, []>('PRAGMA data_version').get()?.data_version ?? -1);
}

function useWritableDatabase<A>(databasePath: string, use: (database: Database) => A) {
  return Effect.acquireUseRelease(
    Effect.sync(() => new Database(databasePath, {strict: true})),
    database => Effect.sync(() => use(database)),
    database => Effect.sync(() => database.close(false)),
  );
}

function useReadonlyDatabase<A>(databasePath: string, use: (database: Database) => A) {
  return Effect.acquireUseRelease(
    Effect.sync(() => new Database(databasePath, {readonly: true, strict: true})),
    database => Effect.sync(() => use(database)),
    database => Effect.sync(() => database.close(false)),
  );
}
