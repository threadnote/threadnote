import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {legacyCodeGraphAuthorityStatements} from '@threadnote/graph/test/helpers/code-graph-legacy-authority';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, Fiber, Option} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE,
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CodeGraphStore,
  codeGraphRuntimeSchemaRequiresReconnect,
  type CodeGraphPersistentSchemaMigrationPhase,
} from '@threadnote/graph/store';
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeGraphRuntimeReconnectRequiredError,
  type CodeGraphEdge,
  type CodeGraphInventoryFile,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {claimPersistentBuildForTest} from '@threadnote/graph/test/helpers/code-graph-build';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(EffectArray.map(temporaryRoots.splice(0), root => rm(root, {force: true, recursive: true})));
});

describe('code graph persistent schema migration', () => {
  it('rejects a newer persistent extension revision without downgrading it', async () => {
    const fixture = await migrationFixture();
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
      }),
    );
    const futureRevision = CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION + 1;
    const prepared = new Database(fixture.databasePath, {strict: true});
    prepared
      .query("UPDATE schema_metadata SET value = ? WHERE key = 'persistent_extension_schema_revision'")
      .run(String(futureRevision));
    prepared.close(false);

    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.assertRuntimeSchemaCompatible(fixture.databasePath);
        }),
      ),
    ).rejects.toMatchObject({
      code: 'incompatible-schema',
      name: 'CodeGraphRuntimeReconnectRequiredError',
      recovery: 'reconnect-runtime',
      retryable: false,
    });

    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.initialize(fixture.databasePath);
        }),
      ),
    ).rejects.toThrow(`persistent extension schema ${futureRevision} is newer`);

    const preserved = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(
        preserved.query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'").get(),
      ).toEqual({value: String(futureRevision)});
    } finally {
      preserved.close(false);
    }
  });

  it('accepts current and older schema observations and monotonically rejects newer ones', () => {
    fc.assert(
      fc.property(
        fc.integer({max: CODE_GRAPH_SCHEMA_VERSION, min: 0}),
        fc.integer({max: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION, min: 0}),
        fc.integer({max: 100, min: 1}),
        (coreVersion, extensionRevision, increment) => {
          expect(codeGraphRuntimeSchemaRequiresReconnect(coreVersion, extensionRevision)).toBe(false);
          expect(
            codeGraphRuntimeSchemaRequiresReconnect(CODE_GRAPH_SCHEMA_VERSION + increment, extensionRevision),
          ).toBe(true);
          expect(
            codeGraphRuntimeSchemaRequiresReconnect(
              coreVersion,
              CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION + increment,
            ),
          ).toBe(true);
        },
      ),
      {numRuns: 100},
    );
    expect(CodeGraphRuntimeReconnectRequiredError.of()).toMatchObject({recovery: 'reconnect-runtime'});
  });

  it('keeps repeated current-schema initialization idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({max: 4, min: 1}), async reopenCount => {
        const fixture = await migrationFixture();
        await runEffect(
          Effect.gen(function* () {
            const store = yield* CodeGraphStore;
            yield* store.initialize(fixture.databasePath);
            for (let index = 0; index < reopenCount; index += 1) {
              const phases: CodeGraphPersistentSchemaMigrationPhase[] = [];
              yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
                onPersistentSchemaMigrationPhase: phase => Effect.sync(() => phases.push(phase)),
              });
              expect(phases).toEqual([]);
            }
          }),
        );
      }),
      {numRuns: 10},
    );
  });

  effectIt.effect('upgrades revision 15 file aliases without losing persisted snapshot rows', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(migrationFixture);
      const store = yield* CodeGraphStore;
      const ready = snapshot(fixture.identity, 'revision-15-file-alias');
      const symbol = graphSymbol('revision-15-file-alias');
      yield* store.initialize(fixture.databasePath);
      yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [symbol], []);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
          yield* store.promote(fixture.databasePath, fixture.identity, ready.id);
        }),
      );
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database.exec(`
            DROP INDEX snapshot_files_raw_content_hash;
            ALTER TABLE snapshot_files DROP COLUMN raw_content_hash;
            UPDATE schema_metadata
            SET value = '15'
            WHERE key = 'persistent_extension_schema_revision';
          `);
          expect(database.query('SELECT path, content_hash FROM snapshot_files').all()).toEqual([
            {content_hash: fixture.file.contentHash, path: fixture.file.path},
          ]);
          expect(
            EffectArray.map(
              database.query<{readonly name: string}, []>('PRAGMA table_info(snapshot_files)').all(),
              column => column.name,
            ),
          ).not.toContain('raw_content_hash');
        } finally {
          database.close(false);
        }
      });

      yield* store.initialize(fixture.databasePath);
      const observed = yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          return {
            columns: EffectArray.map(
              database.query<{readonly name: string}, []>('PRAGMA table_info(snapshot_files)').all(),
              column => column.name,
            ),
            index: database
              .query<{readonly sql: string}, [string]>(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
              )
              .get('snapshot_files_raw_content_hash'),
            revision: database
              .query<{readonly value: string}, []>(
                "SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'",
              )
              .get(),
            rows: database
              .query<
                {readonly content_hash: string; readonly path: string; readonly raw_content_hash: string | null},
                []
              >('SELECT path, content_hash, raw_content_hash FROM snapshot_files')
              .all(),
          };
        } finally {
          database.close(false);
        }
      });

      expect(observed.columns).toContain('raw_content_hash');
      expect(observed.index?.sql).toMatch(/WHERE\s+raw_content_hash\s+IS\s+NOT\s+NULL/iu);
      expect(observed.revision?.value).toBe(String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION));
      expect(observed.rows).toEqual([
        {content_hash: fixture.file.contentHash, path: fixture.file.path, raw_content_hash: null},
      ]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('atomically upgrades revision 11 with the cache-authority admission table', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(migrationFixture);
      const store = yield* CodeGraphStore;
      yield* store.initialize(fixture.databasePath);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database.exec(`
            DROP TRIGGER file_blobs_authority_insert;
            DROP TRIGGER file_blobs_authority_delete;
            DROP TRIGGER file_blobs_authority_update;
            DROP TABLE ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE};
            UPDATE schema_metadata
            SET value = '11'
            WHERE key = 'persistent_extension_schema_revision';
          `);
          database
            .query(
              `INSERT INTO file_blobs (
                 content_hash, extractor_set, path_hint, blob_id, reuse_class, facts_json, created_at
               ) VALUES (?, 'revision-11-cache', ?, NULL, NULL, ?, '2026-08-22T00:00:00.000Z')`,
            )
            .run(Effect2.pipe('a', EffectString.repeat(40)), 'src/valid.ts', JSON.stringify({path: 'src/valid.ts'}));
          database
            .query(
              `INSERT INTO file_blobs (
                 content_hash, extractor_set, path_hint, blob_id, reuse_class, facts_json, created_at
               ) VALUES (?, 'revision-11-cache', ?, NULL, NULL, ?, '2026-08-22T00:00:00.000Z')`,
            )
            .run(Effect2.pipe('b', EffectString.repeat(40)), 'src/invalid.ts', '{');
        } finally {
          database.close(false);
        }
      });

      const phases: CodeGraphPersistentSchemaMigrationPhase[] = [];
      yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
        onPersistentSchemaMigrationPhase: phase => Effect.sync(() => phases.push(phase)),
      });
      const observed = yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          return {
            authority: database
              .query<{readonly sql: string}, [string]>(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
              )
              .get(CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE),
            authorityRows: database
              .query<{readonly path_hint: string}, []>(
                `SELECT path_hint FROM ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} ORDER BY path_hint`,
              )
              .all(),
            revision: database
              .query<{readonly value: string}, []>(
                "SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'",
              )
              .get(),
          };
        } finally {
          database.close(false);
        }
      });

      expect(phases).toContain('migrated-query-indexes');
      expect(observed.authority?.sql).toMatch(/PRIMARY\s+KEY\s*\(extractor_set,\s*path_hint,\s*content_hash\)/iu);
      expect(observed.authorityRows).toEqual([{path_hint: 'src/valid.ts'}]);
      expect(observed.revision?.value).toBe(String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rebuilds a drifted cache-authority trigger before serving admission', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(migrationFixture);
      const store = yield* CodeGraphStore;
      yield* store.initialize(fixture.databasePath);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database
            .query(
              `INSERT INTO file_blobs (
                 content_hash, extractor_set, path_hint, blob_id, reuse_class, facts_json, created_at
               ) VALUES (?, 'drifted-cache', ?, NULL, NULL, ?, '2026-08-22T00:00:00.000Z')`,
            )
            .run(
              Effect2.pipe('c', EffectString.repeat(40)),
              'src/drifted.ts',
              JSON.stringify({path: 'src/drifted.ts'}),
            );
          database.exec(`
            DROP TRIGGER file_blobs_authority_update;
            CREATE TRIGGER file_blobs_authority_update
            AFTER UPDATE OF facts_json ON file_blobs
            BEGIN SELECT 1; END;
            UPDATE file_blobs SET facts_json = '{' WHERE extractor_set = 'drifted-cache';
          `);
        } finally {
          database.close(false);
        }
      });

      yield* store.initialize(fixture.databasePath);
      expect(yield* store.cachedCommittedFileKeys(fixture.databasePath, 'drifted-cache')).toEqual(new Set());
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('atomically upgrades revision 9 query indexes before serving adjacency', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(migrationFixture);
      const store = yield* CodeGraphStore;
      const source = graphSymbol('revision-9-source');
      const target = graphSymbol('revision-9-target');
      const edge: CodeGraphEdge = {
        confidence: 1,
        evidencePath: fixture.file.path,
        evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
        id: 'revision-9-edge',
        provenance: 'resolved',
        relation: 'calls',
        sourceId: source.id,
        sourceName: source.name,
        targetId: target.id,
        targetName: target.name,
      };
      const ready = {
        ...snapshot(fixture.identity, 'ready-before-revision-10-index-upgrade'),
        edgeCount: 1,
        symbolCount: 2,
      };

      yield* store.initialize(fixture.databasePath);
      yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [source, target], [edge]);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
          yield* store.promote(fixture.databasePath, fixture.identity, ready.id);
        }),
      );
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database.exec(`
            DROP INDEX edges_target_resolved;
            DROP INDEX edges_evidence_path;
            CREATE INDEX edges_target ON edges(snapshot_id, target_id, relation);
            CREATE INDEX symbols_name ON symbols(snapshot_id, name);
            CREATE INDEX symbols_resolution_scope ON symbols(snapshot_id, resolution_scope_id);
            UPDATE schema_metadata
            SET value = '9'
            WHERE key = 'persistent_extension_schema_revision';
          `);
        } finally {
          database.close(false);
        }
      });

      const interrupted = yield* Effect.exit(
        store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
          onPersistentSchemaMigrationPhase: phase =>
            phase === 'migrated-query-indexes'
              ? Effect.die(TestError.make({message: 'fault after revision 9 query-index migration'}))
              : Effect.void,
        }),
      );
      expect(Exit.isFailure(interrupted)).toBe(true);
      const rolledBack = yield* Effect.sync(() => readRevision9IndexState(fixture.databasePath));
      expect(rolledBack).toMatchObject({
        currentDefinition: undefined,
        evidenceDefinition: undefined,
        legacyNames: ['edges_target', 'symbols_name', 'symbols_resolution_scope'],
        revision: '9',
      });

      const phases: CodeGraphPersistentSchemaMigrationPhase[] = [];
      yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
        onPersistentSchemaMigrationPhase: phase => Effect.sync(() => phases.push(phase)),
      });
      const incoming = yield* store.edgesForNodes(fixture.databasePath, ready.id, [target.id], 'incoming', 10, [
        'resolved',
      ]);
      const migrated = yield* Effect.sync(() => readRevision9IndexState(fixture.databasePath));

      expect(phases).toContain('migrated-query-indexes');
      expect(migrated.legacyNames).toEqual([]);
      expect(migrated.currentDefinition).toMatch(/WHERE\s+target_id\s+IS\s+NOT\s+NULL/iu);
      expect(migrated.evidenceDefinition).toMatch(/edges\s*\(snapshot_id,\s*evidence_path\)/iu);
      expect(migrated.revision).toBe(String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION));
      expect(EffectArray.map(incoming, candidate => candidate.id)).toEqual([edge.id]);

      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database
            .query("UPDATE schema_metadata SET value = '9' WHERE key = 'persistent_extension_schema_revision'")
            .run();
        } finally {
          database.close(false);
        }
      });
      yield* store.initialize(fixture.databasePath);
      const preparedRetry = yield* Effect.sync(() => readRevision9IndexState(fixture.databasePath));
      expect(preparedRetry.currentRootPage).toBe(migrated.currentRootPage);
      expect(preparedRetry.revision).toBe(String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('keeps revision 4 ready lexical rows readable while enabling compact writes for later snapshots', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-legacy-lexical-before-upgrade');
    const preserved = graphSymbol('preserved-legacy-lexical');
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [preserved], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
            yield* store.promote(fixture.databasePath, fixture.identity, ready.id);
          }),
        );
      }),
    );
    downgradeLexicalExtensionToRevision4(fixture.databasePath, ready.id);

    const replacement = snapshot(fixture.identity, 'ready-compact-lexical-after-upgrade');
    const compact = graphSymbol('new-compact-lexical');
    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
        const legacySearch = yield* store.searchSymbols(fixture.databasePath, ready.id, preserved.name, 10);
        const legacyGraph = yield* store.loadGraph(fixture.databasePath, ready.id);
        const legacyReusableReceipt = yield* store.reusableBaseReceipt(fixture.databasePath, ready.id);
        const legacyReadyById = yield* store.readySnapshotById(fixture.databasePath, ready.id);
        const legacyCurrentReadyById = yield* store.currentLexicalReadySnapshotById(fixture.databasePath, ready.id);
        const legacyActiveReady = yield* store.readySnapshot(fixture.databasePath, fixture.identity.worktreeId);
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [compact], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, replacement);
          }),
        );
        const compactSearch = yield* store.searchSymbols(fixture.databasePath, replacement.id, compact.name, 10);
        return {
          compactSearch,
          legacyActiveReady,
          legacyCurrentReadyById,
          legacyGraph,
          legacyReadyById,
          legacyReusableReceipt,
          legacySearch,
        };
      }),
    );

    expect(EffectArray.map(result.legacySearch, symbol => symbol.id)).toEqual([preserved.id]);
    expect(EffectArray.map(result.legacyGraph.symbols, symbol => symbol.id)).toEqual([preserved.id]);
    expect(result.legacyActiveReady?.id).toBe(ready.id);
    expect(result.legacyReadyById?.id).toBe(ready.id);
    expect(result.legacyCurrentReadyById).toBeUndefined();
    expect(result.legacyReusableReceipt).toBeUndefined();
    expect(EffectArray.map(result.compactSearch, symbol => symbol.id)).toEqual([compact.id]);
    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      const formats = database
        .query<{readonly snapshot_id: string}, SQLQueryBindings[]>(
          'SELECT snapshot_id FROM lexical_storage_formats ORDER BY snapshot_id',
        )
        .all();
      const legacyRows = requiredRow(
        database
          .query<{readonly count: number}, SQLQueryBindings[]>(
            'SELECT COUNT(*) AS count FROM symbol_terms WHERE snapshot_id = ?',
          )
          .get(ready.id),
      );
      const revision = requiredRow(
        database
          .query<{readonly value: string}, SQLQueryBindings[]>(
            "SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'",
          )
          .get(),
      );
      expect(EffectArray.map(formats, format => format.snapshot_id)).toEqual([replacement.id]);
      expect(legacyRows.count).toBeGreaterThan(0);
      expect(revision.value).toBe(String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION));
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  it('retires ready snapshots instead of silently emptying them when revision 5 lexical tables drift', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-revision-5-lexical-drift');
    const preserved = graphSymbol('ready-before-revision-5-lexical-drift');
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [preserved], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
            yield* store.promote(fixture.databasePath, fixture.identity, ready.id);
          }),
        );
      }),
    );

    const drifted = new Database(fixture.databasePath, {strict: true});
    try {
      drifted.exec('PRAGMA foreign_keys = OFF');
      drifted.exec('DROP TABLE lexical_compact_postings');
    } finally {
      drifted.close(false);
    }
    const phases: CodeGraphPersistentSchemaMigrationPhase[] = [];
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
          onPersistentSchemaMigrationPhase: phase => Effect.sync(() => phases.push(phase)),
        });
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(phases).toContain('retired-incompatible-ready');
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toEqual({state: 'retired'});
      expect(database.query('SELECT COUNT(*) AS count FROM active_snapshots').get()).toEqual({count: 0});
      expect(
        database
          .query(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'lexical_compact_postings'",
          )
          .get(),
      ).toEqual({count: 1});
      // Missing additive read tables retire the snapshot without synchronously
      // cascading its repository-sized compact rows. Bounded retired-snapshot
      // maintenance removes this receipt and the remaining dictionaries.
      expect(database.query('SELECT COUNT(*) AS count FROM lexical_storage_formats').get()).toEqual({count: 1});
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  it('adds a missing build-only lexical counter without invalidating a ready compact graph', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-additive-lexical-counter');
    const preserved = graphSymbol('ready-before-additive-lexical-counter');
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [preserved], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
            yield* store.promote(fixture.databasePath, fixture.identity, ready.id);
          }),
        );
      }),
    );

    const drifted = new Database(fixture.databasePath, {strict: true});
    drifted.exec('DROP TABLE building_lexical_counters');
    drifted.close(false);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toEqual({state: 'ready'});
      expect(database.query('SELECT snapshot_id FROM active_snapshots').get()).toEqual({snapshot_id: ready.id});
      expect(database.query('SELECT COUNT(*) AS count FROM lexical_storage_formats').get()).toEqual({count: 1});
      expect(
        database
          .query(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'building_lexical_counters'",
          )
          .get(),
      ).toEqual({count: 1});
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  it('retires revision 5 ready snapshots when compact dictionary uniqueness drifts', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-compact-unique-drift');
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [graphSymbol('compact-unique-drift')], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
            yield* store.promote(fixture.databasePath, fixture.identity, ready.id);
          }),
        );
      }),
    );
    recreateCompactTermsWithoutUniqueConstraint(fixture.databasePath);

    const phases: CodeGraphPersistentSchemaMigrationPhase[] = [];
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
          onPersistentSchemaMigrationPhase: phase => Effect.sync(() => phases.push(phase)),
        });
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(phases).toContain('retired-incompatible-ready');
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toEqual({state: 'retired'});
      expect(database.query('SELECT COUNT(*) AS count FROM active_snapshots').get()).toEqual({count: 0});
      const indexes = database
        .query<
          {
            readonly name: string;
            readonly unique: number;
          },
          SQLQueryBindings[]
        >("PRAGMA index_list('lexical_compact_terms')")
        .all();
      const uniqueColumns = EffectArray.map(
        EffectArray.filter(indexes, index => index.unique === 1),
        index =>
          EffectArray.map(
            database.query<{readonly name: string}, SQLQueryBindings[]>(`PRAGMA index_info('${index.name}')`).all(),
            column => column.name,
          ),
      );
      expect(uniqueColumns).toContainEqual(['snapshot_key', 'term']);
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  it('repairs a compact postings table whose weight check constraint drifted', async () => {
    const fixture = await migrationFixture();
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
      }),
    );
    const drifted = new Database(fixture.databasePath, {strict: true});
    drifted.exec('PRAGMA foreign_keys = OFF');
    drifted.exec(`
      DROP TABLE lexical_compact_postings;
      CREATE TABLE lexical_compact_postings (
        snapshot_key INTEGER NOT NULL REFERENCES lexical_compact_snapshots(snapshot_key) ON DELETE CASCADE,
        term_key INTEGER NOT NULL,
        symbol_key INTEGER NOT NULL,
        weight INTEGER NOT NULL,
        PRIMARY KEY (snapshot_key, term_key, symbol_key)
      ) WITHOUT ROWID;
    `);
    drifted.close(false);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      const definition = requiredRow(
        database
          .query<{readonly sql: string}, SQLQueryBindings[]>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lexical_compact_postings'",
          )
          .get(),
      );
      expect(definition.sql).toMatch(/CHECK\s*\(\s*weight\s+BETWEEN\s+1\s+AND\s+5\s*\)/i);
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  it('rolls back an interrupted revision 5 lexical retirement and heals on the next open', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-interrupted-revision-5-lexical-retirement');
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [graphSymbol('interrupted-lexical-retirement')],
              [],
            );
            yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
            yield* store.promote(fixture.databasePath, fixture.identity, ready.id);
          }),
        );
      }),
    );
    const drifted = new Database(fixture.databasePath, {strict: true});
    drifted.exec('PRAGMA foreign_keys = OFF');
    drifted.exec('DROP TABLE lexical_compact_postings');
    drifted.close(false);

    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
            onPersistentSchemaMigrationPhase: phase =>
              phase === 'retired-incompatible-ready'
                ? Effect.die(TestError.make({message: 'fault after ready lexical retirement'}))
                : Effect.void,
          });
        }),
      ),
    ).rejects.toThrow('fault after ready lexical retirement');

    const interrupted = new Database(fixture.databasePath, {readonly: true, strict: true});
    expect(interrupted.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toEqual({state: 'ready'});
    expect(interrupted.query('SELECT snapshot_id FROM active_snapshots').get()).toEqual({snapshot_id: ready.id});
    expect(
      interrupted
        .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'lexical_compact_postings'")
        .get(),
    ).toEqual({count: 0});
    interrupted.close(false);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
      }),
    );
    const healed = new Database(fixture.databasePath, {readonly: true, strict: true});
    expect(healed.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toEqual({state: 'retired'});
    expect(healed.query('SELECT COUNT(*) AS count FROM active_snapshots').get()).toEqual({count: 0});
    expect(
      healed
        .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'lexical_compact_postings'")
        .get(),
    ).toEqual({count: 1});
    healed.close(false);
  });

  it('preserves ready beta data and restarts an incomplete pre-fingerprint build before materializing', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-upgrade');
    const interrupted = snapshot(fixture.identity, 'interrupted-before-upgrade');
    const preserved = graphSymbol('preserved-before-upgrade');
    const partial = graphSymbol('partial-before-upgrade');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [preserved], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
            yield* store.promote(fixture.databasePath, fixture.identity, ready.id);
          }),
        );
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...interrupted,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], interrupted.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [partial], [], [], undefined, 0);
          }),
        );
      }),
    );

    downgradePersistentExtensionSchema(fixture.databasePath, interrupted.id, ready.id);

    const replacement = snapshot(fixture.identity, 'replacement-after-upgrade');
    const rebuilt = graphSymbol('rebuilt-after-upgrade');
    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const preservedSnapshot = yield* store.readySnapshotById(fixture.databasePath, ready.id);
            const preservedGraph = yield* store.loadGraph(fixture.databasePath, ready.id);
            yield* store.ensureAnalysisSummary(fixture.databasePath, ready.id);
            const preservedSummary = yield* store.loadAnalysisSummary(fixture.databasePath, ready.id);

            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...replacement,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], replacement.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [rebuilt], [], [], undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, replacement);
            return {
              preservedGraph,
              preservedSnapshot,
              preservedSummary,
              replacementGraph: yield* store.loadGraph(fixture.databasePath, replacement.id),
            };
          }),
        );
      }),
    );

    expect(result.preservedSnapshot?.state).toBe('ready');
    expect(EffectArray.map(result.preservedGraph.symbols, symbol => symbol.id)).toEqual([preserved.id]);
    expect(Option.getOrThrow(result.preservedSummary)).toMatchObject({edgeCount: 0, symbolCount: 1, version: 1});
    expect(EffectArray.map(result.replacementGraph.symbols, symbol => symbol.id)).toEqual([rebuilt.id]);

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      const interruptedState = requiredRow(
        database
          .query<
            {
              readonly state: string;
            },
            SQLQueryBindings[]
          >('SELECT state FROM snapshots WHERE id = ?')
          .get(interrupted.id),
      );
      const columns = database
        .query<
          {
            readonly name: string;
          },
          SQLQueryBindings[]
        >('PRAGMA table_info(building_materialization_batches)')
        .all();
      const extensionTableCount = requiredRow(
        database
          .query<{readonly count: number}, SQLQueryBindings[]>(
            `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'snapshot_build_owners',
             'snapshot_analysis_symbol_counts',
             'snapshot_analysis_edge_histogram',
             'snapshot_analysis_edge_counts',
             'snapshot_analysis_summary_receipts',
             'building_analysis_batches',
             'building_references',
             'building_reference_candidates',
             'building_materialization_batches',
             'building_materialization_spool_surfaces'
           )`,
          )
          .get(),
      );
      const removedIndexCount = requiredRow(
        database
          .query<{readonly count: number}, SQLQueryBindings[]>(
            `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'index' AND name IN ('terms_lookup', 'terms_symbol', 'snapshot_symbol_lookup_key')`,
          )
          .get(),
      );
      const revision = requiredRow(
        database
          .query<{readonly value: string}, SQLQueryBindings[]>(
            "SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'",
          )
          .get(),
      );

      expect(interruptedState.state).toBe('retired');
      expect(EffectArray.map(columns, column => column.name)).toContain('batch_fingerprint');
      expect(extensionTableCount.count).toBe(10);
      expect(removedIndexCount.count).toBe(0);
      expect(revision.value).toBe(String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION));
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(database.query('PRAGMA quick_check').get()).toEqual({quick_check: 'ok'});
    } finally {
      database.close(false);
    }
  });

  it('adds the materialization plan column without dropping large interrupted-build staging tables', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-plan-column');
    const interrupted = snapshot(fixture.identity, 'interrupted-before-plan-column');
    await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
    downgradeBuildOwnerPlanColumnOnly(fixture.databasePath, interrupted.id);

    const preserved = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
        return yield* store.loadGraph(fixture.databasePath, ready.id);
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      const ownerColumns = database
        .query<
          {
            readonly name: string;
          },
          SQLQueryBindings[]
        >('PRAGMA table_info(snapshot_build_owners)')
        .all();
      expect(EffectArray.map(ownerColumns, column => column.name)).toEqual([
        'snapshot_id',
        'owner_token',
        'claimed_at',
        'expected_batch_count',
      ]);
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({
        state: 'retired',
      });
      expect(
        database
          .query('SELECT COUNT(*) AS count FROM building_reference_candidates WHERE snapshot_id = ?')
          .get(interrupted.id),
      ).toEqual({count: 1});
      expect(
        database.query('SELECT COUNT(*) AS count FROM building_references WHERE snapshot_id = ?').get(interrupted.id),
      ).toEqual({count: 1});
      expect(
        database
          .query('SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?')
          .get(interrupted.id),
      ).toEqual({count: 1});
      expect(
        database.query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'").get(),
      ).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
      expect(preserved.symbols).toHaveLength(1);
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  it('retires revision 3 row-per-candidate builds before enabling compact reference payloads', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-candidate-compaction');
    const interrupted = snapshot(fixture.identity, 'interrupted-before-candidate-compaction');
    await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
    downgradeReferenceCandidatesToRevision3(fixture.databasePath, interrupted.id);

    const preserved = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
        return yield* store.loadGraph(fixture.databasePath, ready.id);
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      const referenceColumns = database
        .query<
          {
            readonly name: string;
          },
          SQLQueryBindings[]
        >('PRAGMA table_info(building_references)')
        .all();
      expect(preserved.symbols).toHaveLength(1);
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({
        state: 'retired',
      });
      expect(EffectArray.map(referenceColumns, column => column.name)).toEqual([
        'snapshot_id',
        'edge_id',
        'resolution_domain',
        'exported_only',
        'alias_lookup_keys_json',
        'lookup_tiers_json',
        'candidate_count',
        'candidate_payload_bytes',
        'source_id',
        'source_name',
        'relation',
        'target_name',
        'provenance',
        'confidence',
        'evidence_path',
        'evidence_span_json',
      ]);
      expect(database.query('SELECT COUNT(*) AS count FROM building_reference_candidates').get()).toEqual({count: 1});
      expect(database.query('SELECT COUNT(*) AS count FROM legacy_building_references_v3').get()).toEqual({count: 1});
      expect(
        database.query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'").get(),
      ).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.pruneRetiredSnapshots(fixture.databasePath);
      }),
    );
    const cleaned = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(cleaned.query('SELECT COUNT(*) AS count FROM building_reference_candidates').get()).toEqual({count: 0});
      expect(cleaned.query('SELECT COUNT(*) AS count FROM legacy_building_references_v3').get()).toEqual({count: 0});
      expect(cleaned.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toBeNull();
    } finally {
      cleaned.close(false);
    }
  });

  effectIt.effect('retires revision 13 incomplete builds before deferring reference edge payloads', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => migrationFixture());
      const ready = snapshot(fixture.identity, 'ready-before-deferred-reference-edges');
      const interrupted = snapshot(fixture.identity, 'interrupted-before-deferred-reference-edges');
      yield* Effect.promise(() => seedReadyAndInterruptedMigration(fixture, ready, interrupted));
      yield* Effect.sync(() => downgradeReferencePayloadToRevision13(fixture.databasePath, interrupted.id));

      const store = yield* CodeGraphStore;
      yield* store.initialize(fixture.databasePath);
      const preserved = yield* store.loadGraph(fixture.databasePath, ready.id);
      const evidence = yield* Effect.acquireUseRelease(
        Effect.sync(() => new Database(fixture.databasePath, {readonly: true, strict: true})),
        database =>
          Effect.sync(() => ({
            columns: EffectArray.map(
              database
                .query<
                  {
                    readonly name: string;
                  },
                  SQLQueryBindings[]
                >('PRAGMA table_info(building_references)')
                .all(),
              column => column.name,
            ),
            interrupted: database.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id),
            references: database.query('SELECT COUNT(*) AS count FROM building_references').get(),
            revision: database
              .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
              .get(),
          })),
        database => Effect.sync(() => database.close(false)),
      );

      expect(preserved.symbols).toHaveLength(1);
      expect(evidence.interrupted).toEqual({state: 'retired'});
      expect(evidence.references).toEqual({count: 0});
      expect(evidence.columns).toEqual([
        'snapshot_id',
        'edge_id',
        'resolution_domain',
        'exported_only',
        'alias_lookup_keys_json',
        'lookup_tiers_json',
        'candidate_count',
        'candidate_payload_bytes',
        'source_id',
        'source_name',
        'relation',
        'target_name',
        'provenance',
        'confidence',
        'evidence_path',
        'evidence_span_json',
      ]);
      expect(evidence.revision).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('rolls back the revision 3 candidate-table rename when schema publication faults', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-candidate-compaction-fault');
    const interrupted = snapshot(fixture.identity, 'interrupted-before-candidate-compaction-fault');
    await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
    downgradeReferenceCandidatesToRevision3(fixture.databasePath, interrupted.id);
    const beforeFailure = readMigrationState(fixture.databasePath);

    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
            onPersistentSchemaMigrationPhase: phase =>
              phase === 'created-extensions'
                ? Effect.die(TestError.make({message: 'fault after compact reference schema creation'}))
                : Effect.void,
          });
        }),
      ),
    ).rejects.toThrow('fault after compact reference schema creation');

    const interruptedDatabase = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(readMigrationState(fixture.databasePath)).toEqual(beforeFailure);
      expect(interruptedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({
        state: 'building',
      });
      expect(
        interruptedDatabase
          .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
          .get(),
      ).toEqual({value: '3'});
      expect(
        interruptedDatabase
          .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'legacy_building_references_v3'")
          .get(),
      ).toEqual({count: 0});
      expect(interruptedDatabase.query('SELECT COUNT(*) AS count FROM building_reference_candidates').get()).toEqual({
        count: 1,
      });
    } finally {
      interruptedDatabase.close(false);
    }

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
      }),
    );
    const healed = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(healed.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({state: 'retired'});
      expect(
        healed.query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'").get(),
      ).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
    } finally {
      healed.close(false);
    }
  });

  effectIt.effect('adds revision 7 owner instances without retiring revision 6 builds or staging rows', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => migrationFixture());
      const ready = snapshot(fixture.identity, 'ready-before-owner-instance-upgrade');
      const interrupted = snapshot(fixture.identity, 'interrupted-before-owner-instance-upgrade');
      yield* seedReadyAndInterruptedMigrationEffect(fixture, ready, interrupted);
      yield* Effect.sync(() => {
        const prepared = new Database(fixture.databasePath, {strict: true});
        try {
          prepared.exec('DROP TABLE snapshot_build_owner_instances');
          removeRemovedViewCleanupRevision8(prepared);
          prepared
            .query("UPDATE schema_metadata SET value = '6' WHERE key = 'persistent_extension_schema_revision'")
            .run();
        } finally {
          prepared.close(false);
        }
      });
      const phases: CodeGraphPersistentSchemaMigrationPhase[] = [];
      const store = yield* CodeGraphStore;
      yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
        onPersistentSchemaMigrationPhase: phase => Effect.sync(() => phases.push(phase)),
      });

      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(phases).toContain('added-build-owner-instance');
          expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({
            state: 'building',
          });
          expect(
            database
              .query('SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?')
              .get(interrupted.id),
          ).toEqual({count: 1});
          expect(
            database
              .query('SELECT COUNT(*) AS count FROM snapshot_build_owners WHERE snapshot_id = ?')
              .get(interrupted.id),
          ).toEqual({count: 1});
          expect(database.query('SELECT COUNT(*) AS count FROM snapshot_build_owner_instances').get()).toEqual({
            count: 0,
          });
          expect(
            database
              .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
              .get(),
          ).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
        } finally {
          database.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('atomically rolls back revision 8 cleanup publication and converges on retry', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => migrationFixture());
      const ready = snapshot(fixture.identity, 'ready-before-cleanup-publication-fault');
      const interrupted = snapshot(fixture.identity, 'interrupted-before-cleanup-publication-fault');
      yield* seedReadyAndInterruptedMigrationEffect(fixture, ready, interrupted);
      yield* Effect.sync(() => {
        const prepared = new Database(fixture.databasePath, {strict: true});
        try {
          removeRemovedViewCleanupRevision8(prepared);
          prepared
            .query("UPDATE schema_metadata SET value = '7' WHERE key = 'persistent_extension_schema_revision'")
            .run();
        } finally {
          prepared.close(false);
        }
      });
      const before = yield* Effect.sync(() => readRemovedViewCleanupMigrationSurface(fixture.databasePath));
      expect(before.revision).toEqual({value: '7'});
      expect(before.objects).toEqual([]);
      expect(before.sequence).toBeNull();

      const store = yield* CodeGraphStore;
      const failed = yield* store
        .withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
          onPersistentSchemaMigrationPhase: phase =>
            phase === 'added-removed-view-cleanup'
              ? Effect.die(TestError.make({message: 'fault after cleanup publication'}))
              : Effect.void,
        })
        .pipe(Effect.exit);
      expect(failed._tag).toBe('Failure');
      expect(yield* Effect.sync(() => readRemovedViewCleanupMigrationSurface(fixture.databasePath))).toEqual(before);

      const phases: CodeGraphPersistentSchemaMigrationPhase[] = [];
      yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
        onPersistentSchemaMigrationPhase: phase => Effect.sync(() => phases.push(phase)),
      });
      const healed = yield* Effect.sync(() => readRemovedViewCleanupMigrationSurface(fixture.databasePath));
      expect(phases).toEqual([
        'added-removed-view-cleanup',
        'migrated-query-indexes',
        'added-graph-scope-authority',
        'recorded-revision',
      ]);
      expect(healed.revision).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
      expect(healed.sequence).toEqual({value: '0'});
      expect(healed.queueRows).toEqual({count: 0});
      expect(EffectArray.map(healed.objects, object => object.name)).toEqual([
        'removed_view_cleanup_due',
        'removed_view_cleanup',
        'removed_views_cleanup_revoke_delete',
        'removed_views_cleanup_revoke_insert',
        'removed_views_cleanup_revoke_update',
      ]);
      expect(healed.snapshots).toEqual(before.snapshots);
      expect(healed.active).toEqual(before.active);
      expect(healed.tombstones).toEqual(before.tombstones);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rolls back revision 8 cleanup publication when the migration Effect is interrupted', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => migrationFixture());
      const ready = snapshot(fixture.identity, 'ready-before-cleanup-publication-interrupt');
      const interrupted = snapshot(fixture.identity, 'interrupted-before-cleanup-publication-interrupt');
      yield* seedReadyAndInterruptedMigrationEffect(fixture, ready, interrupted);
      yield* Effect.sync(() => {
        const prepared = new Database(fixture.databasePath, {strict: true});
        try {
          removeRemovedViewCleanupRevision8(prepared);
          prepared
            .query("UPDATE schema_metadata SET value = '7' WHERE key = 'persistent_extension_schema_revision'")
            .run();
        } finally {
          prepared.close(false);
        }
      });
      const before = yield* Effect.sync(() => readRemovedViewCleanupMigrationSurface(fixture.databasePath));
      const reachedCleanupPublication = yield* Deferred.make<void>();
      const keepTransactionOpen = yield* Deferred.make<void>();
      const store = yield* CodeGraphStore;
      const migration = yield* store
        .withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
          onPersistentSchemaMigrationPhase: phase =>
            phase === 'added-removed-view-cleanup'
              ? Deferred.succeed(reachedCleanupPublication, undefined).pipe(
                  Effect.andThen(Deferred.await(keepTransactionOpen)),
                )
              : Effect.void,
        })
        .pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(reachedCleanupPublication);
      yield* Fiber.interrupt(migration);

      expect(yield* Effect.sync(() => readRemovedViewCleanupMigrationSurface(fixture.databasePath))).toEqual(before);

      const phases: CodeGraphPersistentSchemaMigrationPhase[] = [];
      yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
        onPersistentSchemaMigrationPhase: phase => Effect.sync(() => phases.push(phase)),
      });
      const healed = yield* Effect.sync(() => readRemovedViewCleanupMigrationSurface(fixture.databasePath));
      expect(phases).toEqual([
        'added-removed-view-cleanup',
        'migrated-query-indexes',
        'added-graph-scope-authority',
        'recorded-revision',
      ]);
      expect(healed.revision).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
      expect(healed.sequence).toEqual({value: '0'});
      expect(healed.queueRows).toEqual({count: 0});
      expect(healed.snapshots).toEqual(before.snapshots);
      expect(healed.active).toEqual(before.active);
      expect(healed.tombstones).toEqual(before.tombstones);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('atomically rolls back a fault after adding revision 7 owner instances', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => migrationFixture());
      const ready = snapshot(fixture.identity, 'ready-before-owner-instance-fault');
      const interrupted = snapshot(fixture.identity, 'interrupted-before-owner-instance-fault');
      yield* seedReadyAndInterruptedMigrationEffect(fixture, ready, interrupted);
      yield* Effect.sync(() => {
        const prepared = new Database(fixture.databasePath, {strict: true});
        try {
          prepared.exec('DROP TABLE snapshot_build_owner_instances');
          removeRemovedViewCleanupRevision8(prepared);
          prepared
            .query("UPDATE schema_metadata SET value = '6' WHERE key = 'persistent_extension_schema_revision'")
            .run();
        } finally {
          prepared.close(false);
        }
      });

      const store = yield* CodeGraphStore;
      const failed = yield* store
        .withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
          onPersistentSchemaMigrationPhase: phase =>
            phase === 'added-build-owner-instance'
              ? Effect.die(TestError.make({message: 'fault after owner instance creation'}))
              : Effect.void,
        })
        .pipe(Effect.exit);
      expect(failed._tag).toBe('Failure');
      if (failed._tag === 'Failure') expect(String(failed.cause)).toContain('fault after owner instance creation');

      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(
            database
              .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'snapshot_build_owner_instances'")
              .get(),
          ).toEqual({count: 0});
          expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({
            state: 'building',
          });
          expect(
            database
              .query('SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?')
              .get(interrupted.id),
          ).toEqual({count: 1});
          expect(
            database
              .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
              .get(),
          ).toEqual({value: '6'});
        } finally {
          database.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('atomically rolls back an interrupted additive materialization-plan migration', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-plan-fault');
    const interrupted = snapshot(fixture.identity, 'interrupted-before-plan-fault');
    await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
    downgradeBuildOwnerPlanColumnOnly(fixture.databasePath, interrupted.id);

    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
            onPersistentSchemaMigrationPhase: phase =>
              phase === 'added-materialization-plan'
                ? Effect.die(TestError.make({message: 'fault after additive materialization plan'}))
                : Effect.void,
          });
        }),
      ),
    ).rejects.toThrow('fault after additive materialization plan');

    const interruptedDatabase = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      const ownerColumns = interruptedDatabase
        .query<
          {
            readonly name: string;
          },
          SQLQueryBindings[]
        >('PRAGMA table_info(snapshot_build_owners)')
        .all();
      expect(EffectArray.map(ownerColumns, column => column.name)).toEqual([
        'snapshot_id',
        'owner_token',
        'claimed_at',
      ]);
      expect(interruptedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({
        state: 'building',
      });
      expect(
        interruptedDatabase
          .query('SELECT COUNT(*) AS count FROM building_reference_candidates WHERE snapshot_id = ?')
          .get(interrupted.id),
      ).toEqual({count: 1});
      expect(
        interruptedDatabase
          .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
          .get(),
      ).toEqual({value: '2'});
    } finally {
      interruptedDatabase.close(false);
    }

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
      }),
    );
    const healed = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(healed.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({state: 'retired'});
      expect(healed.query('PRAGMA table_info(snapshot_build_owners)').all()).toEqual(
        expect.arrayContaining([expect.objectContaining({name: 'expected_batch_count'})]),
      );
      expect(
        healed
          .query('SELECT COUNT(*) AS count FROM building_reference_candidates WHERE snapshot_id = ?')
          .get(interrupted.id),
      ).toEqual({count: 1});
    } finally {
      healed.close(false);
    }
  });

  it.each([
    {
      expectedPrimaryKey: ['snapshot_id', 'edge_id', 'tier', 'lookup_key'],
      name: 'primary-key order',
      sql: `
        DROP TABLE building_reference_candidates;
        CREATE TABLE building_reference_candidates (
          snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
          edge_id TEXT NOT NULL,
          tier INTEGER NOT NULL,
          lookup_key TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, tier, edge_id, lookup_key)
        ) WITHOUT ROWID;
      `,
      table: 'building_reference_candidates',
    },
    {
      expectedPrimaryKey: ['snapshot_id', 'edge_id'],
      name: 'foreign-key action',
      sql: `
        DROP TABLE building_references;
        CREATE TABLE building_references (
          snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
          edge_id TEXT NOT NULL,
          resolution_domain TEXT NOT NULL,
          exported_only INTEGER NOT NULL,
          alias_lookup_keys_json TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, edge_id)
        ) WITHOUT ROWID;
      `,
      table: 'building_references',
    },
    {
      expectedPrimaryKey: ['snapshot_id'],
      name: 'rowid storage',
      sql: `
        DROP TABLE snapshot_build_owners;
        CREATE TABLE snapshot_build_owners (
          snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
          owner_token TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          expected_batch_count INTEGER
        );
      `,
      table: 'snapshot_build_owners',
    },
    {
      expectedPrimaryKey: ['snapshot_id', 'edge_id'],
      name: 'missing table',
      sql: 'DROP TABLE building_references;',
      table: 'building_references',
    },
  ])('repairs $name drift even when the current revision receipt is present', async drift => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, `ready-before-${drift.name}`);
    const interrupted = snapshot(fixture.identity, `interrupted-before-${drift.name}`);
    await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
    corruptPersistentExtensionContract(fixture.databasePath, drift.sql);

    const preserved = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
        return yield* store.loadGraph(fixture.databasePath, ready.id);
      }),
    );

    expect(EffectArray.map(preserved.symbols, symbol => symbol.id)).toEqual([`preserved-${drift.name}`]);
    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toMatchObject({state: 'ready'});
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toMatchObject({
        state: 'retired',
      });
      expectPersistentExtensionTableContract(database, drift.table, drift.expectedPrimaryKey);
      expect(
        database.query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'").get(),
      ).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
    } finally {
      database.close(false);
    }
  });

  it('rolls back every persistent DDL phase and self-heals on the next ordinary open', async () => {
    const faultPhases: readonly CodeGraphPersistentSchemaMigrationPhase[] = [
      'retired-incomplete',
      'dropped-incompatible',
      'created-extensions',
      'dropped-obsolete-indexes',
      'validated',
      'recorded-revision',
    ];

    for (const faultPhase of faultPhases) {
      const fixture = await migrationFixture();
      const ready = snapshot(fixture.identity, `ready-before-${faultPhase}`);
      const interrupted = snapshot(fixture.identity, `interrupted-before-${faultPhase}`);
      await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
      downgradePersistentExtensionSchema(fixture.databasePath, interrupted.id, ready.id);
      const beforeFailure = readMigrationState(fixture.databasePath);

      await expect(
        runEffect(
          Effect.gen(function* () {
            const store = yield* CodeGraphStore;
            yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
              onPersistentSchemaMigrationPhase: phase =>
                phase === faultPhase ? Effect.die(TestError.make({message: `fault after ${phase}`})) : Effect.void,
            });
          }),
        ),
      ).rejects.toThrow(`fault after ${faultPhase}`);

      const interruptedDatabase = new Database(fixture.databasePath, {readonly: true, strict: true});
      try {
        expect(readMigrationState(fixture.databasePath)).toEqual(beforeFailure);
        expect(interruptedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toMatchObject({
          state: 'ready',
        });
        expect(
          interruptedDatabase.query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?').get(ready.id),
        ).toEqual({count: 1});
        expect(interruptedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toMatchObject(
          {state: 'building'},
        );
        const oldColumns = interruptedDatabase
          .query<{readonly name: string}, SQLQueryBindings[]>('PRAGMA table_info(building_materialization_batches)')
          .all();
        expect(EffectArray.map(oldColumns, column => column.name)).not.toContain('batch_fingerprint');
        expect(
          interruptedDatabase
            .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
            .get(),
        ).toBeNull();
      } finally {
        interruptedDatabase.close(false);
      }

      const healed = await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.initialize(fixture.databasePath);
          return yield* store.loadGraph(fixture.databasePath, ready.id);
        }),
      );
      expect(EffectArray.map(healed.symbols, symbol => symbol.id)).toEqual([`preserved-${faultPhase}`]);

      const healedDatabase = new Database(fixture.databasePath, {readonly: true, strict: true});
      try {
        expect(healedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toMatchObject({
          state: 'retired',
        });
        expect(
          healedDatabase
            .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
            .get(),
        ).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
      } finally {
        healedDatabase.close(false);
      }
    }
  });
});

function corruptPersistentExtensionContract(databasePath: string, sql: string) {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    database.exec(sql);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function expectPersistentExtensionTableContract(
  database: Database,
  table: string,
  expectedPrimaryKey: readonly string[],
) {
  const definition = requiredRow(
    database
      .query<
        {
          readonly sql: string;
        },
        SQLQueryBindings[]
      >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
  const columns = database
    .query<
      {
        readonly name: string;
        readonly pk: number;
      },
      SQLQueryBindings[]
    >(`PRAGMA table_info("${table}")`)
    .all();
  const foreignKeys = database
    .query<
      {
        readonly from: string;
        readonly on_delete: string;
        readonly table: string;
        readonly to: string;
      },
      SQLQueryBindings[]
    >(`PRAGMA foreign_key_list("${table}")`)
    .all();

  expect(definition.sql).toMatch(/\bWITHOUT\s+ROWID\b/i);
  expect(
    EffectArray.map(
      EffectArray.filter(columns, column => column.pk > 0).sort((left, right) => left.pk - right.pk),
      column => column.name,
    ),
  ).toEqual(expectedPrimaryKey);
  expect(foreignKeys).toEqual([
    expect.objectContaining({from: 'snapshot_id', on_delete: 'CASCADE', table: 'snapshots', to: 'id'}),
  ]);
}

function readMigrationState(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      buildReceipts: database
        .query('SELECT * FROM building_materialization_batches ORDER BY snapshot_id, batch_index')
        .all(),
      extensionSchema: database
        .query(
          `SELECT type, name, sql
           FROM sqlite_master
           WHERE name IN (
             'snapshot_build_owners',
             'snapshot_analysis_symbol_counts',
             'snapshot_analysis_edge_histogram',
             'snapshot_analysis_edge_counts',
             'snapshot_analysis_summary_receipts',
             'building_analysis_batches',
             'building_references',
             'building_reference_candidates',
             'building_materialization_batches',
             'building_materialization_spool_surfaces',
             'terms_lookup',
             'terms_symbol',
             'snapshot_symbol_lookup_key'
           )
           ORDER BY type, name`,
        )
        .all(),
      revision: database
        .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
        .get(),
      snapshots: database.query('SELECT id, state, completed_at, failure_summary FROM snapshots ORDER BY id').all(),
      summaryReceipts: database.query('SELECT * FROM snapshot_analysis_summary_receipts ORDER BY snapshot_id').all(),
      symbols: database.query('SELECT snapshot_id, id FROM symbols ORDER BY snapshot_id, id').all(),
    };
  } finally {
    database.close(false);
  }
}

function readRemovedViewCleanupMigrationSurface(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const queueExists = database
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'removed_view_cleanup'")
      .get();
    return {
      active: database
        .query('SELECT worktree_id, snapshot_id, activated_at FROM active_snapshots ORDER BY worktree_id')
        .all(),
      objects: database
        .query<{readonly name: string; readonly type: string}, []>(
          `SELECT type, name FROM sqlite_master
           WHERE name IN (
             'removed_view_cleanup', 'removed_view_cleanup_due',
             'removed_views_cleanup_revoke_delete', 'removed_views_cleanup_revoke_insert',
             'removed_views_cleanup_revoke_update'
           )
           ORDER BY type, name`,
        )
        .all(),
      queueRows: queueExists ? database.query('SELECT COUNT(*) AS count FROM removed_view_cleanup').get() : null,
      revision: database
        .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
        .get(),
      sequence: database
        .query("SELECT value FROM schema_metadata WHERE key = 'removed_view_cleanup_epoch_sequence'")
        .get(),
      snapshots: database.query('SELECT id, state, completed_at, failure_summary FROM snapshots ORDER BY id').all(),
      tombstones: database
        .query('SELECT worktree_id, expected_snapshot_id, removed_at FROM removed_views ORDER BY worktree_id')
        .all(),
    };
  } finally {
    database.close(false);
  }
}

function seedReadyAndInterruptedMigrationEffect(
  fixture: Awaited<ReturnType<typeof migrationFixture>>,
  ready: CodeGraphSnapshot,
  interrupted: CodeGraphSnapshot,
) {
  const preserved = graphSymbol(`preserved-${Effect2.pipe(ready.id, EffectString.slice('ready-before-'.length))}`);
  const partial = graphSymbol(
    `partial-${Effect2.pipe(interrupted.id, EffectString.slice('interrupted-before-'.length))}`,
  );
  return Effect.gen(function* () {
    const store = yield* CodeGraphStore;
    yield* store.withSession(
      fixture.databasePath,
      Effect.gen(function* () {
        yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
        yield* store.stageActivationFacts(fixture.databasePath, [preserved], []);
        yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
      }),
    );
    yield* store.withSession(
      fixture.databasePath,
      Effect.gen(function* () {
        const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
          ...interrupted,
          state: 'building',
        });
        yield* store.prepareActivation(fixture.databasePath, [fixture.file], interrupted.id, 1, ownerToken);
        yield* store.stageActivationFacts(fixture.databasePath, [partial], [], [], undefined, 0);
      }),
    );
  });
}

async function seedReadyAndInterruptedMigration(
  fixture: Awaited<ReturnType<typeof migrationFixture>>,
  ready: CodeGraphSnapshot,
  interrupted: CodeGraphSnapshot,
) {
  await runEffect(seedReadyAndInterruptedMigrationEffect(fixture, ready, interrupted));
}

function recreateCompactTermsWithoutUniqueConstraint(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    database.exec(`
      CREATE TABLE lexical_compact_terms_drifted (
        term_key INTEGER PRIMARY KEY NOT NULL,
        snapshot_key INTEGER NOT NULL REFERENCES lexical_compact_snapshots(snapshot_key) ON DELETE CASCADE,
        term TEXT NOT NULL
      );
      INSERT INTO lexical_compact_terms_drifted (term_key, snapshot_key, term)
      SELECT term_key, snapshot_key, term FROM lexical_compact_terms;
      DROP TABLE lexical_compact_terms;
      ALTER TABLE lexical_compact_terms_drifted RENAME TO lexical_compact_terms;
    `);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function downgradePersistentExtensionSchema(
  databasePath: string,
  interruptedSnapshotId: string,
  readySnapshotId: string,
) {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    removeRemovedViewCleanupRevision8(database);
    database.exec("DELETE FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'");
    for (const table of [
      'building_materialization_batches',
      'building_materialization_spool_surfaces',
      'building_reference_candidates',
      'building_references',
      'building_analysis_batches',
      'snapshot_analysis_summary_receipts',
      'snapshot_analysis_edge_counts',
      'snapshot_analysis_edge_histogram',
      'snapshot_analysis_symbol_counts',
      'snapshot_build_owner_instances',
      'snapshot_build_owners',
    ]) {
      database.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
    database.exec(`
      CREATE TABLE building_materialization_batches (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        batch_index INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL,
        term_count INTEGER NOT NULL,
        lookup_count INTEGER NOT NULL,
        reference_count INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL,
        reexport_count INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, batch_index)
      ) WITHOUT ROWID;
      CREATE TABLE snapshot_analysis_summary_receipts (
        snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX terms_lookup ON symbol_terms(snapshot_id, term, weight DESC);
      CREATE INDEX terms_symbol ON symbol_terms(snapshot_id, symbol_id);
      CREATE INDEX snapshot_symbol_lookup_key
        ON snapshot_symbol_lookup(snapshot_id, lookup_key, resolution_domain, exported);
    `);
    database
      .query(
        `INSERT INTO building_materialization_batches (
           snapshot_id, batch_index, symbol_count, edge_count, term_count, lookup_count,
           reference_count, candidate_count, reexport_count, completed_at
         ) VALUES (?, 0, 1, 0, 1, 1, 0, 0, 0, ?)`,
      )
      .run(interruptedSnapshotId, new Date().toISOString());
    database
      .query(
        `INSERT INTO snapshot_analysis_summary_receipts (
           snapshot_id, version, symbol_count, edge_count, created_at
         ) VALUES (?, 1, 1, 0, ?)`,
      )
      .run(readySnapshotId, new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function downgradeLexicalExtensionToRevision4(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    removeRemovedViewCleanupRevision8(database);
    database
      .query(
        `INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight)
         SELECT compact.snapshot_id, term.term, symbol.symbol_id, posting.weight
         FROM lexical_compact_snapshots AS compact
         JOIN lexical_compact_terms AS term ON term.snapshot_key = compact.snapshot_key
         JOIN lexical_compact_postings AS posting
           ON posting.snapshot_key = compact.snapshot_key AND posting.term_key = term.term_key
         JOIN lexical_compact_symbols AS symbol
           ON symbol.snapshot_key = compact.snapshot_key AND symbol.symbol_key = posting.symbol_key
         WHERE compact.snapshot_id = ?`,
      )
      .run(snapshotId);
    database.exec(`
      DROP TABLE lexical_storage_formats;
      DROP TABLE lexical_compact_postings;
      DROP TABLE lexical_compact_symbols;
      DROP TABLE lexical_compact_terms;
      DROP TABLE lexical_compact_snapshots;
    `);
    database.query("UPDATE schema_metadata SET value = '4' WHERE key = 'persistent_extension_schema_revision'").run();
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function downgradeBuildOwnerPlanColumnOnly(databasePath: string, interruptedSnapshotId: string) {
  const database = new Database(databasePath, {strict: true});
  try {
    const owner = requiredRow(
      database
        .query<{readonly claimed_at: string; readonly owner_token: string}, SQLQueryBindings[]>(
          'SELECT owner_token, claimed_at FROM snapshot_build_owners WHERE snapshot_id = ?',
        )
        .get(interruptedSnapshotId),
    );
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    removeRemovedViewCleanupRevision8(database);
    database.exec(`
      DROP TABLE snapshot_build_owners;
      CREATE TABLE snapshot_build_owners (
        snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        owner_token TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    database
      .query('INSERT INTO snapshot_build_owners (snapshot_id, owner_token, claimed_at) VALUES (?, ?, ?)')
      .run(interruptedSnapshotId, owner.owner_token, owner.claimed_at);
    database.query("UPDATE schema_metadata SET value = '2' WHERE key = 'persistent_extension_schema_revision'").run();
    database
      .query(
        `INSERT INTO building_references (
           snapshot_id, edge_id, resolution_domain, exported_only, alias_lookup_keys_json,
           lookup_tiers_json, candidate_count, candidate_payload_bytes,
           source_id, source_name, relation, target_name, provenance, confidence,
           evidence_path, evidence_span_json
         ) VALUES (
           ?, 'retained-edge', 'typescript', 0, '[]', '[["typescript:name:retained"]]', 1, 30,
           NULL, 'retainedSource', 'calls', 'retainedTarget', 'syntactic', 0.5,
           'src/retained.ts', '{"line":1,"column":1,"endLine":1,"endColumn":2}'
         )`,
      )
      .run(interruptedSnapshotId);
    database
      .query(
        `INSERT INTO building_reference_candidates (snapshot_id, edge_id, tier, lookup_key)
         VALUES (?, 'retained-edge', 0, 'typescript:name:retained')`,
      )
      .run(interruptedSnapshotId);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function downgradeReferenceCandidatesToRevision3(databasePath: string, interruptedSnapshotId: string) {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    removeRemovedViewCleanupRevision8(database);
    database.exec(`
      DROP TABLE building_references;
      CREATE TABLE building_references (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        edge_id TEXT NOT NULL,
        resolution_domain TEXT NOT NULL,
        exported_only INTEGER NOT NULL CHECK (exported_only IN (0, 1)),
        alias_lookup_keys_json TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, edge_id)
      ) WITHOUT ROWID;
    `);
    database
      .query(
        `INSERT INTO building_references (
           snapshot_id, edge_id, resolution_domain, exported_only, alias_lookup_keys_json
         ) VALUES (?, 'revision-3-edge', 'typescript', 0, '[]')`,
      )
      .run(interruptedSnapshotId);
    database
      .query(
        `INSERT INTO building_reference_candidates (snapshot_id, edge_id, tier, lookup_key)
         VALUES (?, 'revision-3-edge', 0, 'typescript:name:revision3')`,
      )
      .run(interruptedSnapshotId);
    database.query("UPDATE schema_metadata SET value = '3' WHERE key = 'persistent_extension_schema_revision'").run();
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function downgradeReferencePayloadToRevision13(databasePath: string, interruptedSnapshotId: string) {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    database.exec(`
      DROP TABLE building_references;
      CREATE TABLE building_references (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        edge_id TEXT NOT NULL,
        resolution_domain TEXT NOT NULL,
        exported_only INTEGER NOT NULL CHECK (exported_only IN (0, 1)),
        alias_lookup_keys_json TEXT NOT NULL,
        lookup_tiers_json TEXT NOT NULL,
        candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
        candidate_payload_bytes INTEGER NOT NULL CHECK (candidate_payload_bytes >= 0),
        PRIMARY KEY (snapshot_id, edge_id)
      ) WITHOUT ROWID;
    `);
    database
      .query(
        `INSERT INTO building_references (
           snapshot_id, edge_id, resolution_domain, exported_only, alias_lookup_keys_json,
           lookup_tiers_json, candidate_count, candidate_payload_bytes
         ) VALUES (?, 'revision-13-edge', 'typescript', 0, '[]', '[]', 0, 2)`,
      )
      .run(interruptedSnapshotId);
    database.query("UPDATE schema_metadata SET value = '13' WHERE key = 'persistent_extension_schema_revision'").run();
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function removeRemovedViewCleanupRevision8(database: Database): void {
  if (database.query("SELECT 1 FROM pragma_table_xinfo('snapshots') WHERE name = 'scope_id'").get() !== null) {
    for (const statement of legacyCodeGraphAuthorityStatements) database.exec(statement);
  }
  database.exec(`
    DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete;
    DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert;
    DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update;
    DROP TABLE IF EXISTS removed_view_cleanup;
  `);
  database
    .query(
      `DELETE FROM schema_metadata
       WHERE key IN ('removed_view_cleanup_epoch_sequence', 'removed_view_cleanup_admission_cursor')`,
    )
    .run();
}

function readRevision9IndexState(databasePath: string): {
  readonly currentDefinition: string | undefined;
  readonly currentRootPage: number | undefined;
  readonly evidenceDefinition: string | undefined;
  readonly legacyNames: readonly string[];
  readonly revision: string | undefined;
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const legacy = database
      .query<{readonly name: string}, SQLQueryBindings[]>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name IN ('edges_target', 'symbols_name', 'symbols_resolution_scope')
         ORDER BY name`,
      )
      .all();
    const current = database
      .query<{readonly rootpage: number; readonly sql: string} | null, SQLQueryBindings[]>(
        "SELECT rootpage, sql FROM sqlite_master WHERE type = 'index' AND name = 'edges_target_resolved'",
      )
      .get();
    const evidence = database
      .query<{readonly sql: string} | null, SQLQueryBindings[]>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'edges_evidence_path'",
      )
      .get();
    const revision = database
      .query<{readonly value: string} | null, SQLQueryBindings[]>(
        "SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'",
      )
      .get();
    return {
      currentDefinition: current?.sql,
      currentRootPage: current?.rootpage,
      evidenceDefinition: evidence?.sql,
      legacyNames: EffectArray.map(legacy, index => index.name),
      revision: revision?.value,
    };
  } finally {
    database.close(false);
  }
}

async function migrationFixture() {
  const root = await mkdtemp('threadnote-code-graph-schema-migration-');
  temporaryRoots.push(root);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
    displayName: 'schema-migration-fixture',
    gitCommonDirectory: root,
    headCommit: Effect2.pipe('1', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: Effect2.pipe('r', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('w', EffectString.repeat(64)),
  };
  const file: CodeGraphInventoryFile = {
    blobId: Effect2.pipe('b', EffectString.repeat(40)),
    contentHash: Effect2.pipe('h', EffectString.repeat(64)),
    language: 'typescript',
    mode: '100644',
    path: 'src/schema-migration.ts',
    size: 128,
    source: 'commit',
  };
  return {databasePath: join(root, 'graph-v3.sqlite'), file, identity};
}

function graphSymbol(id: string): CodeGraphSymbol {
  return {
    contentHash: `hash-${id}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:name:${id}`],
    name: id,
    path: 'src/schema-migration.ts',
    qualifiedName: id,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function snapshot(identity: RepositoryIdentity, id: string): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'schema-migration-test',
    fileCount: 1,
    id,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 1,
    worktreeId: identity.worktreeId,
  };
}
