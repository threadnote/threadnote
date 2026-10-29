import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {repairCodeGraphIndexes} from '@threadnote/graph/maintenance';
import {
  CODE_GRAPH_SNAPSHOT_FILES_CURRENT_TABLE_SQL,
  CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX,
  CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX,
  CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX,
} from '@threadnote/graph/store/file_alias_schema';
import {
  CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION,
  CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM,
  CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM,
  nextCodeGraphSqliteSchemaVersion,
} from '@threadnote/graph/store/schema/receipt';
import {PERSISTENT_EXTENSION_TABLES} from '@threadnote/graph/store/schema/contracts';
import {CodeGraphStore} from '@threadnote/graph/store';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphInventoryFile,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {join} from '../helpers/effect-filesystem.js';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const LIVE_LEASE_EXPIRY_MILLISECONDS = Number.MAX_SAFE_INTEGER;

describe('code graph snapshot-file citation schema repair', () => {
  effectIt.effect('migrates revision 15 with dry-run parity while preserving live lease authority', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-migration-lease-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const snapshot = repairBuildingSnapshot(identity, '1');
      const citationIdentity = {...identity, worktreeId: Effect2.pipe('b', EffectString.repeat(64))};
      const citationSnapshot = {...legacyReadySnapshot(citationIdentity, '2'), fileCount: 1};
      const citationFile = {
        blobId: Effect2.pipe('3', EffectString.repeat(40)),
        contentHash: Effect2.pipe('f', EffectString.repeat(64)),
        language: 'typescript',
        mode: '100644',
        path: 'src/citation.ts',
        size: 16,
        source: 'commit',
      } as const satisfies CodeGraphInventoryFile;
      const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId);
      const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const spool = path.join(repositoryRoot, `materialization-spool-v2-${snapshot.id}.sqlite`);
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* store.activate(databasePath, citationIdentity, citationSnapshot, [citationFile], [], []);
      yield* store.promote(databasePath, citationIdentity, citationSnapshot.id);
      yield* store.claimPersistentBuild(databasePath, identity, snapshot, {
        logicalSnapshotId: `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`,
        owner: {buildId: '11111111-1111-1111', processId: process.pid},
      });
      yield* Effect.sync(() => {
        downgradeToRevision15FileAliases(databasePath);
        const database = new Database(databasePath, {strict: true});
        try {
          database.exec('CREATE TABLE citation_schema_cookie_bump (id INTEGER)');
          database.exec('DROP TABLE citation_schema_cookie_bump');
          database
            .query('INSERT INTO snapshot_leases (token, snapshot_id, expires_at) VALUES (?, ?, ?)')
            .run('migration-preview-live-lease', snapshot.id, LIVE_LEASE_EXPIRY_MILLISECONDS);
        } finally {
          database.close(false);
        }
      });
      yield* fs.writeFile(spool, new Uint8Array([1]));

      // Promotion's opportunistic cleanup stays parked on the test clock;
      // only the repair's real filesystem-lock boundary needs live time.
      const preview = yield* TestClock.withLive(
        repairCodeGraphIndexes(home, true, undefined, undefined, {
          migrateSchema: true,
          mode: 'deep',
          targetCheckoutId: identity.checkoutId,
        }),
      );
      expect(preview).toMatchObject({
        deferredDatabases: 0,
        migratedDatabases: 1,
        removedIncompleteSnapshots: 0,
        removedTemporaryFiles: 0,
      });
      expect(yield* fs.exists(spool)).toBe(true);
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        buildingSnapshots: 1,
        integrity: 'migration-pending',
        persistentExtensionSchemaRevision: 15,
      });

      const applied = yield* TestClock.withLive(
        repairCodeGraphIndexes(home, false, undefined, undefined, {
          migrateSchema: true,
          mode: 'deep',
          targetCheckoutId: identity.checkoutId,
        }),
      );
      expect(applied).toEqual(preview);
      expect(yield* fs.exists(spool)).toBe(true);
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        buildingSnapshots: 1,
        integrity: 'ok',
        persistentExtensionSchemaRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
      });
      const citationMatches = yield* store.effectiveSnapshotFilesByContentHashes(
        databasePath,
        citationSnapshot.id,
        [citationFile.contentHash],
        1,
      );
      expect(EffectArray.map(citationMatches, match => EffectArray.map(match.files, file => file.path))).toEqual([
        [citationFile.path],
      ]);
      const migratedIdentity = {...identity, worktreeId: Effect2.pipe('c', EffectString.repeat(64))};
      const migratedSnapshot = {...legacyReadySnapshot(migratedIdentity, '3'), fileCount: 1};
      const migratedFile = {
        ...citationFile,
        blobId: Effect2.pipe('4', EffectString.repeat(40)),
        contentHash: Effect2.pipe('d', EffectString.repeat(64)),
        path: 'src/migrated-citation.ts',
        rawContentHash: Effect2.pipe('e', EffectString.repeat(64)),
      } as const satisfies CodeGraphInventoryFile;
      yield* store.activate(databasePath, migratedIdentity, migratedSnapshot, [migratedFile], [], []);
      yield* store.promote(databasePath, migratedIdentity, migratedSnapshot.id);
      const migratedMatches = yield* store.effectiveSnapshotFilesByContentHashes(
        databasePath,
        migratedSnapshot.id,
        [migratedFile.contentHash, migratedFile.rawContentHash],
        1,
      );
      expect(EffectArray.map(migratedMatches, match => EffectArray.map(match.files, file => file.path))).toEqual([
        [migratedFile.path],
        [migratedFile.path],
      ]);
      expect(
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return Number(
              database
                .query<{readonly count: number}, [string]>(
                  'SELECT COUNT(*) AS count FROM snapshot_leases WHERE token = ?',
                )
                .get('migration-preview-live-lease')?.count ?? 0,
            );
          } finally {
            database.close(false);
          }
        }),
      ).toBe(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('post-update quick repair migrates an exact revision-15 alias schema', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-revision-15-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const databasePath = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => downgradeToRevision15FileAliases(databasePath));

      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(preview).toMatchObject({
        deferredDatabases: 0,
        migratedDatabases: 1,
        removedIncompleteSnapshots: 0,
        removedTemporaryFiles: 0,
      });
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        integrity: 'migration-pending',
        persistentExtensionSchemaRevision: 15,
      });

      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(applied).toEqual(preview);
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        integrity: 'ok',
        persistentExtensionSchemaRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rolls back a released revision-6 alias migration before publishing the current revision', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-revision-6-alias-fault-'});
      const identity = legacyRepositoryIdentity(home, 'd');
      const ready = {...legacyReadySnapshot(identity, '4'), fileCount: 1};
      const file = {
        blobId: Effect2.pipe('5', EffectString.repeat(40)),
        contentHash: Effect2.pipe('6', EffectString.repeat(64)),
        language: 'typescript',
        mode: '100644',
        path: 'src/revision-6-citation.ts',
        size: 32,
        source: 'commit',
      } as const satisfies CodeGraphInventoryFile;
      const databasePath = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* store.activate(databasePath, identity, ready, [file], [], []);
      yield* store.promote(databasePath, identity, ready.id);
      yield* Effect.sync(() => downgradeToReleasedRevision6(databasePath));

      const failed = yield* store
        .withSession(databasePath, store.initialize(databasePath), {
          onPersistentSchemaMigrationPhase: phase =>
            phase === 'recorded-revision'
              ? Effect.die(TestError.make({message: 'fault after citation schema revision publication'}))
              : Effect.void,
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* Effect.sync(() => readAliasPublicationState(databasePath, ready.id))).toEqual({
        activeSnapshotId: ready.id,
        rawColumnPresent: false,
        rawIndexPresent: false,
        revision: 6,
        snapshotState: 'ready',
      });

      yield* store.initialize(databasePath);
      expect(yield* Effect.sync(() => readAliasPublicationState(databasePath, ready.id))).toEqual({
        activeSnapshotId: ready.id,
        rawColumnPresent: true,
        rawIndexPresent: true,
        revision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
        snapshotState: 'ready',
      });
      const citationMatches = yield* store.effectiveSnapshotFilesByContentHashes(
        databasePath,
        ready.id,
        [file.contentHash],
        1,
      );
      expect(
        EffectArray.map(citationMatches, match => EffectArray.map(match.files, candidate => candidate.path)),
      ).toEqual([[file.path]]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves leased build spools across safe revision-16 alias interruptions', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      for (const [index, aliasState] of (['released-absent', 'column-only'] as const).entries()) {
        const home = yield* fs.makeTempDirectoryScoped({
          prefix: `threadnote-graph-repair-revision-16-${aliasState}-`,
        });
        const identity = legacyRepositoryIdentity(home, index === 0 ? 'a' : 'b');
        const snapshot = repairBuildingSnapshot(identity, index === 0 ? '1' : '2');
        const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId);
        const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
        const spool = path.join(repositoryRoot, `materialization-spool-v2-${snapshot.id}.sqlite`);
        yield* store.initialize(databasePath);
        yield* store.claimPersistentBuild(databasePath, identity, snapshot, {
          logicalSnapshotId: `cgsn_${index === 0 ? Effect2.pipe('1', EffectString.repeat(40)) : Effect2.pipe('2', EffectString.repeat(40))}`,
          owner: {
            buildId: index === 0 ? '11111111-1111-1111' : '22222222-2222-2222',
            processId: process.pid,
          },
        });
        yield* Effect.sync(() => {
          downgradeToRevision15FileAliases(databasePath);
          const database = new Database(databasePath, {strict: true});
          try {
            database.exec(
              `UPDATE schema_metadata
               SET value = '16'
               WHERE key = 'persistent_extension_schema_revision'`,
            );
            if (aliasState === 'column-only') {
              database.exec('ALTER TABLE snapshot_files ADD COLUMN raw_content_hash TEXT');
            }
            database
              .query('INSERT INTO snapshot_leases (token, snapshot_id, expires_at) VALUES (?, ?, ?)')
              .run(`revision-16-${aliasState}-lease`, snapshot.id, LIVE_LEASE_EXPIRY_MILLISECONDS);
          } finally {
            database.close(false);
          }
        });
        yield* fs.writeFile(spool, new Uint8Array([1]));
        expect(yield* store.diagnose(databasePath)).toMatchObject({
          buildingSnapshots: 1,
          integrity: 'migration-pending',
          persistentExtensionSchemaRevision: 16,
          snapshotFileCitationSchema:
            aliasState === 'released-absent'
              ? 'released-absent-with-predecessor-authority'
              : 'column-only-with-predecessor-authority',
        });
        const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
          migrateSchema: true,
          mode: 'deep',
          targetCheckoutId: identity.checkoutId,
        });
        expect(preview).toMatchObject({
          deferredDatabases: 0,
          migratedDatabases: 1,
          removedIncompleteSnapshots: 0,
          removedTemporaryFiles: 0,
        });
        expect(yield* fs.exists(spool)).toBe(true);
        const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
          migrateSchema: true,
          mode: 'deep',
          targetCheckoutId: identity.checkoutId,
        });
        expect(applied).toEqual(preview);
        expect(yield* fs.exists(spool)).toBe(true);
        expect(yield* store.diagnose(databasePath)).toMatchObject({
          buildingSnapshots: 1,
          integrity: 'ok',
          snapshotFileCitationSchema: 'current',
        });
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('explicitly extends a genuine revision-16 checkpoint predecessor without retiring its view', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-revision-16-checkpoint-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const snapshot = legacyReadySnapshot(identity, '1');
      const databasePath = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.activate(databasePath, identity, snapshot, [], [], []);
      yield* store.promote(databasePath, identity, snapshot.id);
      yield* Effect.sync(() => downgradeToRevision16CheckpointPredecessor(databasePath));

      expect(yield* store.diagnose(databasePath)).toMatchObject({
        activeSnapshots: 1,
        integrity: 'migration-pending',
        persistentExtensionSchemaRevision: 16,
        readySnapshots: 1,
        snapshotFileCitationBaseIndexes: 'current',
        snapshotFileCitationSchema: 'current',
      });
      expect(checkpointTableNames(databasePath)).toEqual([]);

      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(preview).toMatchObject({deferredDatabases: 0, discarded: 0, migratedDatabases: 1});
      expect(checkpointTableNames(databasePath)).toEqual([]);
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        activeSnapshots: 1,
        integrity: 'migration-pending',
        readySnapshots: 1,
      });

      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(applied).toEqual(preview);
      expect(checkpointTableNames(databasePath)).toEqual(
        EffectArray.map(
          EffectArray.filter(PERSISTENT_EXTENSION_TABLES, table => table.group === 'checkpoint'),
          table => table.name,
        ).sort(),
      );
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        activeSnapshots: 1,
        integrity: 'ok',
        persistentExtensionSchemaRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
        readySnapshots: 1,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('defers a revision-16 predecessor with an incompatible checkpoint table without mutation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({
        prefix: 'threadnote-graph-repair-revision-16-checkpoint-drift-',
      });
      const identity = legacyRepositoryIdentity(home, 'a');
      const snapshot = legacyReadySnapshot(identity, '1');
      const databasePath = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.activate(databasePath, identity, snapshot, [], [], []);
      yield* store.promote(databasePath, identity, snapshot.id);
      yield* Effect.sync(() => {
        downgradeToRevision16CheckpointPredecessor(databasePath);
        const database = new Database(databasePath, {strict: true});
        try {
          database.exec('CREATE TABLE checkpoint_import_builds (unexpected TEXT)');
        } finally {
          database.close(false);
        }
      });
      const fingerprint = checkpointTableSchemaFingerprint(databasePath);

      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(preview).toMatchObject({deferredDatabases: 1, discarded: 0, migratedDatabases: 0});
      expect(checkpointTableSchemaFingerprint(databasePath)).toBe(fingerprint);

      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(applied).toEqual(preview);
      expect(checkpointTableSchemaFingerprint(databasePath)).toBe(fingerprint);
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        activeSnapshots: 1,
        persistentExtensionSchemaRevision: 16,
        readySnapshots: 1,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('defers a drifted revision-15 schema without claiming lease or spool authority', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-revision-15-drift-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const snapshot = repairBuildingSnapshot(identity, '1');
      const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId);
      const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const spool = path.join(repositoryRoot, `materialization-spool-v2-${snapshot.id}.sqlite`);
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* store.claimPersistentBuild(databasePath, identity, snapshot, {
        logicalSnapshotId: `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`,
        owner: {buildId: '11111111-1111-1111', processId: process.pid},
      });
      yield* Effect.sync(() => {
        downgradeToRevision15FileAliases(databasePath);
        const database = new Database(databasePath, {strict: true});
        try {
          database.exec('CREATE INDEX snapshot_files_raw_content_hash ON file_blobs(content_hash)');
          database
            .query('INSERT INTO snapshot_leases (token, snapshot_id, expires_at) VALUES (?, ?, ?)')
            .run('migration-drift-live-lease', snapshot.id, LIVE_LEASE_EXPIRY_MILLISECONDS);
        } finally {
          database.close(false);
        }
      });
      yield* fs.writeFile(spool, new Uint8Array([1]));
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        buildingSnapshots: 1,
        integrity: 'migration-pending',
        persistentExtensionSchemaRevision: 15,
      });

      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(preview).toMatchObject({
        deferredDatabases: 1,
        migratedDatabases: 0,
        removedIncompleteSnapshots: 0,
        removedTemporaryFiles: 0,
      });
      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(applied).toEqual(preview);
      expect(yield* fs.exists(spool)).toBe(true);
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        buildingSnapshots: 1,
        integrity: 'migration-pending',
        persistentExtensionSchemaRevision: 15,
      });
      const initialization = yield* store.initialize(databasePath).pipe(Effect.exit);
      expect(Exit.isFailure(initialization)).toBe(true);
      if (Exit.isFailure(initialization)) {
        expect(String(initialization.cause)).toContain('snapshot file citation schema is incompatible');
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('rejects a legacy current receipt that blessed a wrong raw-content alias index', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-alias-receipt-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const databasePath = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => {
        const database = new Database(databasePath, {strict: true});
        try {
          database.exec(`
            DROP INDEX snapshot_files_raw_content_hash;
            CREATE INDEX snapshot_files_raw_content_hash ON file_blobs(content_hash);
          `);
          const schemaVersion = database.query<{readonly schema_version: number}, []>('PRAGMA schema_version').get();
          database
            .query(
              `UPDATE schema_initialization_receipt
               SET contract_revision = ?, sqlite_schema_version = ?
               WHERE singleton = 1`,
            )
            .run(CODE_GRAPH_SCHEMA_INITIALIZATION_CONTRACT_REVISION - 1, schemaVersion?.schema_version ?? -1);
        } finally {
          database.close(false);
        }
      });

      expect(yield* store.diagnose(databasePath)).toMatchObject({
        integrity: 'incompatible',
        persistentExtensionSchemaRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
        snapshotFileCitationSchema: 'incompatible',
      });
      const quickPreview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(quickPreview).toMatchObject({
        deferredDatabases: 1,
        discarded: 0,
        migratedDatabases: 0,
        removedTemporaryFiles: 0,
      });
      const quickApplied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(quickApplied).toEqual(quickPreview);
      const initialization = yield* store.initialize(databasePath).pipe(Effect.exit);
      expect(Exit.isFailure(initialization)).toBe(true);
      if (Exit.isFailure(initialization)) {
        expect(String(initialization.cause)).toContain('snapshot file citation schema is incompatible');
      }
      expect(
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return database
              .query("SELECT tbl_name FROM sqlite_master WHERE name = 'snapshot_files_raw_content_hash'")
              .get();
          } finally {
            database.close(false);
          }
        }),
      ).toEqual({tbl_name: 'file_blobs'});
      const deepPreview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(deepPreview).toMatchObject({
        deferredDatabases: 0,
        discarded: 1,
        migratedDatabases: 0,
        removedTemporaryFiles: 0,
      });
      const deepApplied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(deepApplied).toEqual(deepPreview);
      expect(yield* fs.exists(databasePath)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses to recreate missing snapshot-file authority beneath an active ready snapshot', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-missing-files-authority-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const snapshot = legacyReadySnapshot(identity, '1');
      const databasePath = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.activate(databasePath, identity, snapshot, [], [], []);
      yield* store.promote(databasePath, identity, snapshot.id);
      yield* Effect.sync(() => {
        const database = new Database(databasePath, {strict: true});
        try {
          database.exec('DROP TABLE snapshot_files');
        } finally {
          database.close(false);
        }
      });

      expect(yield* store.diagnose(databasePath)).toMatchObject({
        activeSnapshots: 1,
        integrity: 'incompatible',
        snapshotFileCitationSchema: 'incompatible',
        readySnapshots: 1,
      });
      const quickPreview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(quickPreview).toMatchObject({deferredDatabases: 1, discarded: 0, migratedDatabases: 0});
      const quickApplied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(quickApplied).toEqual(quickPreview);
      const initialization = yield* store.initialize(databasePath).pipe(Effect.exit);
      expect(Exit.isFailure(initialization)).toBe(true);
      if (Exit.isFailure(initialization)) {
        expect(String(initialization.cause)).toContain('snapshot file citation schema is incompatible');
      }
      const deepPreview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(deepPreview).toMatchObject({deferredDatabases: 0, discarded: 1, migratedDatabases: 0});
      const deepApplied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(deepApplied).toEqual(deepPreview);
      expect(yield* fs.exists(databasePath)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recreates an interrupted empty snapshot-files table with dry-run parity', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-empty-files-table-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const databasePath = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => {
        const database = new Database(databasePath, {strict: true});
        try {
          database.exec('DROP TABLE snapshot_files');
        } finally {
          database.close(false);
        }
      });

      expect(yield* store.diagnose(databasePath)).toMatchObject({
        activeSnapshots: 0,
        integrity: 'incompatible',
        snapshotFileCitationSchema: 'table-absent',
        readySnapshots: 0,
      });
      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(preview).toMatchObject({deferredDatabases: 0, discarded: 0, migratedDatabases: 1});
      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(applied).toEqual(preview);
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        integrity: 'ok',
        snapshotFileCitationSchema: 'current',
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('advances the SQLite schema cookie across its signed wrap boundary', () => {
    expect(nextCodeGraphSqliteSchemaVersion(0)).toBe(1);
    expect(nextCodeGraphSqliteSchemaVersion(CODE_GRAPH_SQLITE_SCHEMA_VERSION_MAXIMUM)).toBe(
      CODE_GRAPH_SQLITE_SCHEMA_VERSION_MINIMUM,
    );
  });

  effectIt.effect('rejects post-v16 alias loss beneath ready citation authority', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      for (const [index, aliasState] of (['column-only', 'released-absent'] as const).entries()) {
        const home = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-graph-alias-loss-${aliasState}-`});
        const identity = legacyRepositoryIdentity(home, index === 0 ? 'c' : 'd');
        const snapshot = {...legacyReadySnapshot(identity, index === 0 ? '4' : '5'), fileCount: 1};
        const file = {
          blobId: index === 0 ? Effect2.pipe('6', EffectString.repeat(40)) : Effect2.pipe('7', EffectString.repeat(40)),
          contentHash:
            index === 0 ? Effect2.pipe('8', EffectString.repeat(64)) : Effect2.pipe('9', EffectString.repeat(64)),
          language: 'typescript',
          mode: '100644',
          path: `src/${aliasState}.ts`,
          rawContentHash:
            index === 0 ? Effect2.pipe('a', EffectString.repeat(64)) : Effect2.pipe('b', EffectString.repeat(64)),
          size: 32,
          source: 'commit',
        } as const satisfies CodeGraphInventoryFile;
        const databasePath = path.join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          identity.checkoutId,
          `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
        );
        yield* store.activate(databasePath, identity, snapshot, [file], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        expect(
          (yield* store.effectiveSnapshotFilesByContentHashes(databasePath, snapshot.id, [file.rawContentHash], 1))[0]
            ?.files,
        ).toMatchObject([{path: file.path}]);

        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.exec('DROP INDEX snapshot_files_raw_content_hash');
            if (aliasState === 'released-absent') {
              database.exec('ALTER TABLE snapshot_files DROP COLUMN raw_content_hash');
              database.exec(
                `UPDATE schema_initialization_receipt
                 SET contract_revision = 2, persistent_extension_revision = 15
                 WHERE singleton = 1`,
              );
            }
          } finally {
            database.close(false);
          }
        });
        const before = snapshotFileSchemaFingerprint(databasePath);
        expect(yield* store.diagnose(databasePath)).toMatchObject({
          activeSnapshots: 1,
          integrity: 'incompatible',
          readySnapshots: 1,
          snapshotFileCitationSchema: `${aliasState}-with-authority`,
        });

        const quickPreview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
          migrateSchema: true,
          mode: 'quick',
          targetCheckoutId: identity.checkoutId,
        });
        expect(quickPreview).toMatchObject({deferredDatabases: 1, discarded: 0, migratedDatabases: 0});
        const quickApplied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
          migrateSchema: true,
          mode: 'quick',
          targetCheckoutId: identity.checkoutId,
        });
        expect(quickApplied).toEqual(quickPreview);
        expect(snapshotFileSchemaFingerprint(databasePath)).toBe(before);
        expect(Exit.isFailure(yield* store.initialize(databasePath).pipe(Effect.exit))).toBe(true);

        const deepPreview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
          migrateSchema: true,
          mode: 'deep',
          targetCheckoutId: identity.checkoutId,
        });
        expect(deepPreview).toMatchObject({deferredDatabases: 0, discarded: 1, migratedDatabases: 0});
        const deepApplied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
          migrateSchema: true,
          mode: 'deep',
          targetCheckoutId: identity.checkoutId,
        });
        expect(deepApplied).toEqual(deepPreview);
        expect(yield* fs.exists(databasePath)).toBe(false);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects exact citation-schema drift without mutating it during quick repair', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const mutations: readonly {
        readonly mutate: (database: Database) => void;
        readonly name: string;
      }[] = [
        {
          name: 'raw-nocase-column',
          mutate: database =>
            rebuildSnapshotFiles(
              database,
              Effect2.pipe(
                CODE_GRAPH_SNAPSHOT_FILES_CURRENT_TABLE_SQL,
                EffectString.replace('raw_content_hash TEXT,', 'raw_content_hash TEXT COLLATE NOCASE,'),
              ),
            ),
        },
        {
          name: 'raw-check-constraint',
          mutate: database =>
            rebuildSnapshotFiles(
              database,
              Effect2.pipe(
                CODE_GRAPH_SNAPSHOT_FILES_CURRENT_TABLE_SQL,
                EffectString.replace(
                  'raw_content_hash TEXT,',
                  'raw_content_hash TEXT CHECK(raw_content_hash IS NULL),',
                ),
              ),
            ),
        },
        {
          name: 'wrong-content-index-table',
          mutate: database =>
            database.exec(
              `DROP INDEX snapshot_files_content_hash;
               CREATE INDEX snapshot_files_content_hash ON file_blobs(content_hash)`,
            ),
        },
        {
          name: 'extra-unique-index',
          mutate: database =>
            database.exec('CREATE UNIQUE INDEX snapshot_files_raw_unique ON snapshot_files(raw_content_hash)'),
        },
        {
          name: 'extra-expression-index',
          mutate: database => database.exec('CREATE INDEX snapshot_files_path_folded ON snapshot_files(lower(path))'),
        },
        {
          name: 'aborting-trigger',
          mutate: database =>
            database.exec(
              `CREATE TRIGGER snapshot_files_abort_insert
               BEFORE INSERT ON snapshot_files
               BEGIN
                 SELECT RAISE(ABORT, 'blocked');
               END`,
            ),
        },
      ];
      for (const [index, mutation] of mutations.entries()) {
        const home = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-graph-citation-drift-${mutation.name}-`});
        const identity = legacyRepositoryIdentity(home, String(index + 1));
        const databasePath = path.join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          identity.checkoutId,
          `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
        );
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            mutation.mutate(database);
          } finally {
            database.close(false);
          }
        });
        const before = snapshotFileSchemaFingerprint(databasePath);
        expect(yield* store.diagnose(databasePath)).toMatchObject({integrity: 'incompatible'});
        const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
          migrateSchema: true,
          mode: 'quick',
          targetCheckoutId: identity.checkoutId,
        });
        expect(preview).toMatchObject({deferredDatabases: 1, migratedDatabases: 0});
        const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
          migrateSchema: true,
          mode: 'quick',
          targetCheckoutId: identity.checkoutId,
        });
        expect(applied).toEqual(preview);
        expect(snapshotFileSchemaFingerprint(databasePath)).toBe(before);
        expect(Exit.isFailure(yield* store.initialize(databasePath).pipe(Effect.exit))).toBe(true);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recreates missing base citation indexes only without snapshot authority', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      for (const [index, missingIndex] of [
        CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX.name,
        CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX.name,
      ].entries()) {
        const home = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-graph-missing-${missingIndex}-`});
        const identity = legacyRepositoryIdentity(home, index === 0 ? 'e' : 'f');
        const databasePath = path.join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          identity.checkoutId,
          `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
        );
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => dropIndex(databasePath, missingIndex));
        expect(yield* store.diagnose(databasePath)).toMatchObject({
          activeSnapshots: 0,
          integrity: 'incompatible',
          readySnapshots: 0,
          snapshotFileCitationBaseIndexes: 'missing',
        });
        const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
          migrateSchema: true,
          mode: 'quick',
          targetCheckoutId: identity.checkoutId,
        });
        expect(preview).toMatchObject({deferredDatabases: 0, migratedDatabases: 1});
        const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
          migrateSchema: true,
          mode: 'quick',
          targetCheckoutId: identity.checkoutId,
        });
        expect(applied).toEqual(preview);
        expect(yield* store.diagnose(databasePath)).toMatchObject({
          integrity: 'ok',
          snapshotFileCitationBaseIndexes: 'current',
        });
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('defers missing base citation indexes beneath ready authority', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-missing-base-authority-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const snapshot = legacyReadySnapshot(identity, '6');
      const databasePath = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.activate(databasePath, identity, snapshot, [], [], []);
      yield* store.promote(databasePath, identity, snapshot.id);
      yield* Effect.sync(() => dropIndex(databasePath, CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX.name));
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        activeSnapshots: 1,
        integrity: 'incompatible',
        readySnapshots: 1,
        snapshotFileCitationBaseIndexes: 'incompatible',
      });

      const quickPreview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(quickPreview).toMatchObject({deferredDatabases: 1, discarded: 0, migratedDatabases: 0});
      const quickApplied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(quickApplied).toEqual(quickPreview);
      expect(Exit.isFailure(yield* store.initialize(databasePath).pipe(Effect.exit))).toBe(true);
      const deepPreview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(deepPreview).toMatchObject({deferredDatabases: 0, discarded: 1, migratedDatabases: 0});
      const deepApplied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(deepApplied).toEqual(deepPreview);
      expect(yield* fs.exists(databasePath)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('treats orphan snapshot-file rows as citation authority', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-orphan-file-authority-'});
      const identity = legacyRepositoryIdentity(home, 'b');
      const databasePath = path.join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => {
        const database = new Database(databasePath, {strict: true});
        try {
          database.exec('PRAGMA foreign_keys = OFF');
          database
            .query(
              `INSERT INTO snapshot_files (
                 snapshot_id, path, content_hash, raw_content_hash, language, mode, size, source
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              'cgsn_orphan',
              'src/orphan.ts',
              Effect2.pipe('1', EffectString.repeat(64)),
              null,
              'typescript',
              '100644',
              1,
              'commit',
            );
          database.exec('DROP INDEX snapshot_files_content_hash');
        } finally {
          database.close(false);
        }
      });
      expect(yield* store.diagnose(databasePath)).toMatchObject({
        activeSnapshots: 0,
        integrity: 'incompatible',
        readySnapshots: 0,
        snapshotFileCitationBaseIndexes: 'incompatible',
      });
      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(preview).toMatchObject({deferredDatabases: 1, migratedDatabases: 0});
      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      expect(applied).toEqual(preview);
      expect(Exit.isFailure(yield* store.initialize(databasePath).pipe(Effect.exit))).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function legacyRepositoryIdentity(home: string, seed: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe(seed, EffectString.repeat(64)),
    displayName: 'acme/legacy-graph',
    gitCommonDirectory: join(home, '.git'),
    headCommit: Effect2.pipe(seed, EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: home,
    repositoryId: Effect2.pipe(seed, EffectString.repeat(64)),
    worktreeId: Effect2.pipe(seed, EffectString.repeat(64)),
  };
}

function legacyReadySnapshot(identity: RepositoryIdentity, seed: string): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: '2026-08-10T00:00:00.000Z',
    dirty: false,
    edgeCount: 0,
    extractorSet: 'citation-schema-regression',
    fileCount: 0,
    id: `cgsn_${Effect2.pipe(seed, EffectString.repeat(40))}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}

function repairBuildingSnapshot(identity: RepositoryIdentity, seed: string): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'citation-schema-regression',
    fileCount: 0,
    id: `cgsn_${Effect2.pipe(seed, EffectString.repeat(40))}-direct`,
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}

function dropIndex(databasePath: string, index: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec(`DROP INDEX ${index}`);
  } finally {
    database.close(false);
  }
}

function rebuildSnapshotFiles(database: Database, tableDefinition: string): void {
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('DROP TABLE snapshot_files');
  database.exec(tableDefinition);
  database.exec(CODE_GRAPH_SNAPSHOT_FILE_BLOB_REFERENCE_INDEX.definition);
  database.exec(CODE_GRAPH_SNAPSHOT_FILE_CONTENT_REFERENCE_INDEX.definition);
  database.exec(CODE_GRAPH_SNAPSHOT_FILE_RAW_CONTENT_REFERENCE_INDEX.definition);
  database.exec('PRAGMA foreign_keys = ON');
}

function snapshotFileSchemaFingerprint(databasePath: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return JSON.stringify(
      database
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE tbl_name = 'snapshot_files' COLLATE NOCASE
              OR name LIKE 'snapshot_files_%' ESCAPE '\\'
           ORDER BY type, name`,
        )
        .all(),
    );
  } finally {
    database.close(false);
  }
}

function downgradeToRevision15FileAliases(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec(`
      DROP INDEX snapshot_files_raw_content_hash;
      ALTER TABLE snapshot_files DROP COLUMN raw_content_hash;
      UPDATE schema_metadata
      SET value = '15'
      WHERE key = 'persistent_extension_schema_revision';
    `);
    const schemaVersion = database.query<{readonly schema_version: number}, []>('PRAGMA schema_version').get();
    database
      .query(
        `UPDATE schema_initialization_receipt
         SET contract_revision = 2, persistent_extension_revision = 15, sqlite_schema_version = ?
         WHERE singleton = 1`,
      )
      .run(schemaVersion?.schema_version ?? -1);
  } finally {
    database.close(false);
  }
}

function downgradeToRevision16CheckpointPredecessor(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('PRAGMA foreign_keys = OFF');
    database.run('BEGIN IMMEDIATE');
    try {
      for (const table of [...PERSISTENT_EXTENSION_TABLES].reverse()) {
        if (table.group === 'checkpoint') database.exec(`DROP TABLE IF EXISTS "${table.name}"`);
      }
      database.exec(`
        UPDATE schema_metadata
        SET value = '16'
        WHERE key = 'persistent_extension_schema_revision'
      `);
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

function checkpointTableNames(databasePath: string): string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return EffectArray.map(
      database
        .query<{readonly name: string}, []>(
          `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'checkpoint_import_%'
         ORDER BY name`,
        )
        .all(),
      row => row.name,
    );
  } finally {
    database.close(false);
  }
}

function checkpointTableSchemaFingerprint(databasePath: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return JSON.stringify(
      database
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name LIKE 'checkpoint_import_%'
           ORDER BY type, name`,
        )
        .all(),
    );
  } finally {
    database.close(false);
  }
}

function downgradeToReleasedRevision6(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('PRAGMA foreign_keys = OFF');
    database.run('BEGIN IMMEDIATE');
    try {
      database.exec(`
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update;
        DROP TABLE IF EXISTS removed_view_cleanup;
        DROP TABLE IF EXISTS snapshot_build_owner_instances;
        DROP TABLE IF EXISTS snapshot_component_edge_aggregate_receipts;
        DROP TABLE IF EXISTS snapshot_component_edge_aggregates;
        DROP TABLE IF EXISTS scope_applicability;
        DROP TABLE IF EXISTS snapshot_scope_receipts;
        DROP INDEX IF EXISTS snapshots_scope_recent_ready;
        DROP INDEX IF EXISTS snapshots_scope_commit_ready;
        DROP INDEX IF EXISTS snapshots_scope_reusable;
        DROP INDEX IF EXISTS snapshots_scope_reusable_content;
        DROP INDEX IF EXISTS snapshots_scope_reusable_commit;
        CREATE TEMP TABLE legacy_active_snapshots AS
          SELECT worktree_id, snapshot_id, activated_at FROM active_snapshots
          WHERE scope_id = 'full-repository';
        DROP TABLE active_snapshots;
        CREATE TABLE active_snapshots (
          worktree_id TEXT PRIMARY KEY NOT NULL,
          snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
          activated_at TEXT NOT NULL
        );
        INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
          SELECT worktree_id, snapshot_id, activated_at FROM legacy_active_snapshots;
        DROP TABLE temp.legacy_active_snapshots;
        DROP TABLE IF EXISTS removed_views;
        ALTER TABLE snapshots DROP COLUMN scope_id;
        CREATE INDEX IF NOT EXISTS active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id);
        CREATE INDEX IF NOT EXISTS snapshots_base_state_id ON snapshots(base_snapshot_id, state, id);
        CREATE INDEX IF NOT EXISTS snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at);
        CREATE INDEX IF NOT EXISTS snapshot_leases_expiry ON snapshot_leases(expires_at);
        DROP INDEX IF EXISTS snapshot_files_raw_content_hash;
        ALTER TABLE snapshot_files DROP COLUMN raw_content_hash;
        DELETE FROM schema_metadata
        WHERE key IN ('removed_view_cleanup_admission_cursor', 'removed_view_cleanup_epoch_sequence');
        UPDATE schema_metadata
        SET value = '6'
        WHERE key = 'persistent_extension_schema_revision';
      `);
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

function readAliasPublicationState(databasePath: string, snapshotId: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const columns = database.query<{readonly name: string}, []>('PRAGMA table_info(snapshot_files)').all();
    const rawIndex = database
      .query<{readonly present: number}, []>(
        `SELECT 1 AS present
         FROM sqlite_master
         WHERE type = 'index' AND name = 'snapshot_files_raw_content_hash'`,
      )
      .get();
    const revision = database
      .query<{readonly value: string}, []>(
        "SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'",
      )
      .get();
    const snapshot = database
      .query<{readonly state: string}, [string]>('SELECT state FROM snapshots WHERE id = ?')
      .get(snapshotId);
    const active = database
      .query<{readonly snapshot_id: string}, [string]>('SELECT snapshot_id FROM active_snapshots WHERE snapshot_id = ?')
      .get(snapshotId);
    return {
      activeSnapshotId: active?.snapshot_id,
      rawColumnPresent: EffectArray.some(columns, column => column.name === 'raw_content_hash'),
      rawIndexPresent: rawIndex?.present === 1,
      revision: Number(revision?.value),
      snapshotState: snapshot?.state,
    };
  } finally {
    database.close(false);
  }
}
