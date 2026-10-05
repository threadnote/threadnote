import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Deferred, Effect, Fiber, FileSystem, Option, Ref} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {afterEach, describe, expect, it} from 'vitest';
import {TestClock} from 'effect/testing';
import {codeGraphBlobReuseCacheKey} from '@threadnote/graph/blob_reuse';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CODE_GRAPH_CACHE_TRANSACTION_LIMITS} from '@threadnote/graph/cache_capacity';
import {
  cachedCodeGraphFactBytes,
  CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
  CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM,
  finalCodeGraphFactBatches,
} from '@threadnote/graph/fact/budget';
import {CODE_GRAPH_STORED_FACT_CODEC, decodeStoredCodeGraphFact} from '@threadnote/graph/fact/storage';
import {createCachedCodeGraphFactsAttributor, factMaterializationBatches} from '@threadnote/graph/indexer';
import {
  CodeGraphDiskCapacityPressureError,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '@threadnote/graph/disk/capacity';
import type {CodeGraphWorkspace} from '@threadnote/graph/languages/types';
import {extractStructuredSchemaFacts} from '@threadnote/graph/languages/schemas/extractor';
import {augmentRationaleFacts} from '@threadnote/graph/rationale';
import {
  CodeGraphStore,
  codeGraphCompleteMaterializedShardDonorStatement,
  codeGraphMaterializedShardAssociationPageStatement,
  codeGraphCompactLexicalDeepAuditStatement,
  codeGraphEffectiveSymbolTermsQueryStatement,
  codeGraphPersistedEndpointValidationPageStatement,
  codeGraphTermCandidateQueryStatement,
  materializedFileShardIdentity,
  nextPersistentActivationBatchRows,
  sanitizeCodeGraphStoreDiagnostic,
  type CodeGraphActivationProgress,
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphSqliteWriterSettings,
  type CodeGraphSqliteWriterTuning,
  type CodeGraphStagingProgress,
} from '@threadnote/graph/store';
import {prepareActivationTables} from '@threadnote/graph/store/staging_core';
import {type CodeGraphWriterGate} from '@threadnote/graph/store/build/core';
import {pruneRetiredSnapshotRows} from '@threadnote/graph/store/retirement';
import {
  CodeGraphStoreError,
  isCodeGraphStoreError,
  isCodeGraphStoreNoSpaceError,
  type CodeGraphEdge,
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphReference,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  type RepositoryIdentity,
  type CodeGraphStoreFailure,
} from '@threadnote/graph/types';
import {discoverManifestWorkspace} from '@threadnote/graph/workspace';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {claimPersistentBuildForTest} from '@threadnote/graph/test/helpers/code-graph-build';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryRoots: string[] = [];
const unprotectedCacheWrite: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) => transaction;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
});

function observedStoreFailure(cause: unknown) {
  if (!isCodeGraphStoreError(cause)) throw cause;
  return {
    code: cause.code,
    message: cause.message,
    operation: cause.operation,
    recovery: cause.recovery,
    retryable: cause.retryable,
  };
}

describe('code graph full-build materialization store', () => {
  it('proves complete shard donors through requested-first primary-key lookups', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      database.exec(`
        CREATE TABLE snapshots (
          id TEXT PRIMARY KEY NOT NULL,
          extractor_set TEXT NOT NULL,
          graph_content_id TEXT
        ) WITHOUT ROWID;
        CREATE TABLE materialized_file_shards (
          id TEXT PRIMARY KEY NOT NULL,
          content_hash TEXT NOT NULL,
          extractor_set TEXT NOT NULL,
          derivation_identity TEXT NOT NULL,
          path_hint TEXT NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE snapshot_file_shards (
          snapshot_id TEXT NOT NULL,
          path TEXT NOT NULL,
          shard_id TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, path)
        ) WITHOUT ROWID;
      `);
      const statement = codeGraphCompleteMaterializedShardDonorStatement(
        'cgs_donor',
        [
          {contentHash: 'hash-a', path: 'src/a.ts'},
          {contentHash: 'hash-b', path: 'src/b.ts'},
        ],
        'extractor-v4',
        'derivation-v4',
      );
      const plan = (
        database.query(`EXPLAIN QUERY PLAN ${statement.text}`).all(...statement.parameters) as readonly {
          readonly detail: string;
        }[]
      ).map(row => row.detail);
      const requestedScan = plan.findIndex(detail => detail.includes('SCAN requested VIRTUAL TABLE'));
      const associationLookup = plan.findIndex(detail =>
        detail.includes('SEARCH association USING PRIMARY KEY (snapshot_id=? AND path=?)'),
      );

      expect(requestedScan).toBeGreaterThanOrEqual(0);
      expect(associationLookup).toBeGreaterThan(requestedScan);
      expect(plan.join('\n')).not.toMatch(/SEARCH association USING PRIMARY KEY \(snapshot_id=\?\)(?! AND path)/u);
    } finally {
      database.close(false);
    }
  });

  it('uses bounded in-memory pager surfaces for a persistent full-build writer', async () => {
    const fixture = await materializationFixture();
    const pager = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* prepareActivationTables(sql);
            const temporaryCache = yield* sql.unsafe<{readonly cache_size: number}>('PRAGMA temp.cache_size');
            const temporarySpill = yield* sql.unsafe<{readonly cache_spill: number}>('PRAGMA temp.cache_spill');
            const snapshot = {...readySnapshot(fixture.identity, 0, 0), id: 'pager-configuration'};
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [], snapshot.id, 0, ownerToken);
            const cache = yield* sql.unsafe<{readonly cache_size: number}>('PRAGMA main.cache_size');
            const spill = yield* sql.unsafe<{readonly cache_spill: number}>('PRAGMA cache_spill');
            const temporary = yield* sql.unsafe<{readonly temp_store: number}>('PRAGMA temp_store');
            return {
              cacheSize: Number(cache[0]?.cache_size),
              spillPages: Number(spill[0]?.cache_spill),
              temporaryCacheSize: Number(temporaryCache[0]?.cache_size),
              temporarySpillPages: Number(temporarySpill[0]?.cache_spill),
              temporaryStore: Number(temporary[0]?.temp_store),
            };
          }),
          {writerLockPath: join(fixture.root, 'writer.lock')},
        );
      }),
    );

    expect(pager).toEqual({
      cacheSize: -(32 * 1_024),
      spillPages: 8_192,
      temporaryCacheSize: -64,
      temporarySpillPages: 16,
      temporaryStore: 2,
    });
  });

  it('restores FULL durability before publication and leaves a failed publication resumable', async () => {
    const fixture = await materializationFixture();
    const observed: CodeGraphSqliteWriterSettings[] = [];
    const staging: CodeGraphStagingProgress[] = [];
    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.initialize(fixture.databasePath);
            const stored = symbol('sqlite-tuning-symbol', 'sqliteTuningSymbol', ['typescript:name:sqliteTuningSymbol']);
            const snapshot = {...readySnapshot(fixture.identity, 1, 0), id: 'sqlite-tuning-publication'};
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [stored],
              [],
              [],
              progress => Effect.sync(() => staging.push(progress)),
              0,
            );
            yield* store.resolveStagedReferences(fixture.databasePath);
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe(`
              CREATE TRIGGER reject_ready_publication
              BEFORE UPDATE OF state ON snapshots
              WHEN NEW.state = 'ready'
              BEGIN
                SELECT RAISE(ABORT, 'injected publication failure');
              END
            `);
            const failed = yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot).pipe(
              Effect.as(false),
              Effect.orElseSucceed(() => true),
            );
            const afterFailure = yield* sql<{readonly state: string}>`
              SELECT state FROM snapshots WHERE id = ${snapshot.id}
            `;
            const synchronousAfterFailure = yield* sql.unsafe<{readonly synchronous: number}>(
              'PRAGMA main.synchronous',
            );
            yield* sql.unsafe('DROP TRIGGER reject_ready_publication');
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            const afterRetry = yield* sql<{readonly state: string}>`
              SELECT state FROM snapshots WHERE id = ${snapshot.id}
            `;
            return {
              failed,
              stateAfterFailure: afterFailure[0]?.state,
              stateAfterRetry: afterRetry[0]?.state,
              synchronousAfterFailure: Number(synchronousAfterFailure[0]?.synchronous),
            };
          }),
          {
            onSqliteWriterConfigured: settings => Effect.sync(() => observed.push(settings)),
            sqliteWriterTuning: {
              mainCacheKiB: 64 * 1_024,
              reconstructibleBuildSynchronous: 'normal',
              walAutoCheckpointPages: 1_000,
            },
            writerLockPath: join(fixture.root, 'writer.lock'),
          },
        );
      }),
    );

    expect(result).toEqual({
      failed: true,
      stateAfterFailure: 'building',
      stateAfterRetry: 'ready',
      synchronousAfterFailure: 2,
    });
    const durability = observed.filter(settings => settings.phase !== 'connection');
    expect(durability.map(settings => [settings.phase, settings.synchronous])).toEqual([
      ['building', 1],
      ['publication', 2],
      ['publication', 2],
    ]);
    expect(durability.every(settings => settings.journalMode === 'wal')).toBe(true);
    expect(staging.map(progress => progress.stage)).toEqual(
      expect.arrayContaining(['analysis', 'committed', 'committing', 'receipt', 'validating']),
    );
    expect(
      staging.every(
        progress =>
          (progress.stageElapsedMilliseconds ?? -1) >= 0 &&
          (progress.stageElapsedMilliseconds ?? Number.POSITIVE_INFINITY) <= progress.elapsedMilliseconds,
      ),
    ).toBe(true);
  });

  it('keeps persistent graph evidence identical under benchmark-only writer tuning', async () => {
    const build = async (tuning?: CodeGraphSqliteWriterTuning) => {
      const fixture = await materializationFixture();
      const stored = symbol('sqlite-parity-symbol', 'sqliteParitySymbol', ['typescript:name:sqliteParitySymbol']);
      const linked = {...edge('sqlite-parity-edge', stored, stored.name), targetId: stored.id};
      const snapshot = {...readySnapshot(fixture.identity, 1, 1), id: 'sqlite-tuning-parity'};
      const graph = await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              yield* store.initialize(fixture.databasePath);
              const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
                ...snapshot,
                state: 'building',
              });
              yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
              yield* store.stageActivationFacts(fixture.databasePath, [stored], [linked], [], undefined, 0);
              yield* store.resolveStagedReferences(fixture.databasePath);
              yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
              return yield* store.loadGraph(fixture.databasePath, snapshot.id);
            }),
            {
              ...(tuning ? {sqliteWriterTuning: tuning} : {}),
              writerLockPath: join(fixture.root, 'writer.lock'),
            },
          );
        }),
      );
      return {evidence: persistentGraphEvidence(fixture.databasePath, snapshot.id), graph};
    };

    const control = await build();
    const tuned = await build({
      mainCacheKiB: 256 * 1_024,
      mmapSizeBytes: 256 * 1_024 * 1_024,
      reconstructibleBuildSynchronous: 'normal',
      walAutoCheckpointPages: 8_192,
    });
    expect(tuned.evidence).toEqual(control.evidence);
    expect(tuned.graph.symbols).toEqual(control.graph.symbols);
    expect(tuned.graph.edges).toEqual(control.graph.edges);
  });

  it('validates persistent endpoints in bounded endpoint-index order', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      database.exec(`
        CREATE TABLE symbols (
          snapshot_id TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, id)
        ) WITHOUT ROWID;
        CREATE TABLE edges (
          snapshot_id TEXT NOT NULL,
          id TEXT NOT NULL,
          source_id TEXT,
          target_id TEXT,
          relation TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, id)
        ) WITHOUT ROWID;
        CREATE INDEX edges_source ON edges(snapshot_id, source_id, relation);
        CREATE INDEX edges_target_resolved ON edges(snapshot_id, target_id, relation) WHERE target_id IS NOT NULL;
      `);

      for (const endpoint of ['source', 'target'] as const) {
        const statement = codeGraphPersistedEndpointValidationPageStatement(
          'snapshot',
          endpoint,
          Option.some('cgs_cursor'),
          100_000,
        );
        const plan = (
          database.query(`EXPLAIN QUERY PLAN ${statement.text}`).all(...statement.parameters) as readonly {
            readonly detail: string;
          }[]
        ).map(row => row.detail);
        const output = plan.join('\n');
        const index = endpoint === 'source' ? 'edges_source' : 'edges_target_resolved';
        const column = endpoint === 'source' ? 'source_id' : 'target_id';

        expect(output).toContain('MATERIALIZE raw_page');
        expect(output).toContain(`SEARCH edge USING COVERING INDEX ${index} (snapshot_id=? AND ${column}>?)`);
        expect(output).toContain('SEARCH symbol USING PRIMARY KEY (snapshot_id=? AND id=?) LEFT-JOIN');
        expect(output).not.toMatch(/SCAN edge\b/u);
      }

      database.exec(`
        INSERT INTO symbols (snapshot_id, id) VALUES ('snapshot', 'endpoint-a-present');
        INSERT INTO edges (snapshot_id, id, source_id, target_id, relation) VALUES
          ('snapshot', 'edge-1', 'endpoint-a-present', NULL, 'calls'),
          ('snapshot', 'edge-2', 'endpoint-a-present', NULL, 'calls'),
          ('snapshot', 'edge-3', 'endpoint-a-present', NULL, 'calls'),
          ('snapshot', 'edge-4', 'endpoint-b-missing', NULL, 'calls');
      `);
      const first = codeGraphPersistedEndpointValidationPageStatement('snapshot', 'source', Option.none(), 2);
      const firstPage = database.query(first.text).get(...first.parameters) as {
        readonly cursor: string;
        readonly invalid_symbol_id: string;
        readonly raw_rows: number;
        readonly rows_examined: number;
      };
      expect(firstPage).toEqual({
        cursor: 'endpoint-a-present',
        invalid_symbol_id: '',
        raw_rows: 2,
        rows_examined: 1,
      });
      const second = codeGraphPersistedEndpointValidationPageStatement(
        'snapshot',
        'source',
        Option.some(firstPage.cursor),
        2,
      );
      expect(database.query(second.text).get(...second.parameters)).toEqual({
        cursor: 'endpoint-b-missing',
        invalid_symbol_id: 'endpoint-b-missing',
        raw_rows: 1,
        rows_examined: 1,
      });
    } finally {
      database.close(false);
    }
  });

  it.each(['source', 'target'] as const)(
    'reports the exact edge and %s endpoint when persistent validation finds a missing symbol',
    async endpoint => {
      const fixture = await materializationFixture();
      const stored = symbol(`persistent-${endpoint}`, `persistent${endpoint}`, [
        `typescript:name:persistent${endpoint}`,
      ]);
      const missingId = `missing-${endpoint}-symbol`;
      const invalid = {
        ...edge(`missing-${endpoint}-edge`, stored, stored.name),
        sourceId: endpoint === 'source' ? missingId : stored.id,
        targetId: endpoint === 'target' ? missingId : stored.id,
      } satisfies CodeGraphEdge;
      const snapshot = {
        ...readySnapshot(fixture.identity, 1, 1),
        id: `persistent-missing-${endpoint}`,
      };

      const failure = await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
                ...snapshot,
                state: 'building',
              });
              yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
              yield* store.stageActivationFacts(fixture.databasePath, [stored], [invalid], [], undefined, 0);
              yield* store.resolveStagedReferences(fixture.databasePath);
              return yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot).pipe(
                Effect.as('unexpected success'),
                Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
              );
            }),
          );
        }),
      );

      const database = new Database(fixture.databasePath, {readonly: true, strict: true});
      const persisted = database.query('SELECT state FROM snapshots WHERE id = ?').get(snapshot.id) as {
        readonly state: string;
      };
      database.close(false);

      expect(failure).toContain(invalid.id);
      expect(failure).toContain(`${endpoint} endpoint ${missingId}`);
      expect(failure).toContain('references a missing symbol');
      expect(persisted.state).toBe('building');
    },
  );

  effectIt.effect('bounds raw alternate cache callers before SQLite persistence', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const root = {
        ...symbol('cache-budget-module', 'cacheBudgetModule', ['typescript:name:cacheBudgetModule']),
        documentation: `private-cache-sentinel ${'漢'.repeat(2_850_000)}`,
        kind: 'module',
      } satisfies CodeGraphSymbol;
      const declaration = symbol('cache-budget-declaration', 'cacheBudgetDeclaration', [
        'typescript:name:cacheBudgetDeclaration',
      ]);
      const declares = {
        ...edge('cache-budget-declares', root, declaration.name),
        relation: 'declares',
        targetId: declaration.id,
      } satisfies CodeGraphEdge;
      const raw: CodeGraphFileFacts = {
        diagnostics: [],
        edges: [declares],
        path: fixture.file.path,
        symbols: [root, declaration],
      };

      expect(new TextEncoder().encode(JSON.stringify(raw)).byteLength).toBeGreaterThan(
        CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
      );
      {
        const store = yield* CodeGraphStore;
        // Deliberately bypass the indexer's branded fast path: the public store
        // boundary must budget an ordinary raw fact object on its own.
        yield* store.cacheFacts(
          fixture.databasePath,
          [fixture.file],
          [raw],
          'alternate-caller-cache',
          unprotectedCacheWrite,
        );
      }

      const row = yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          return database
            .query(
              `SELECT facts_json, length(CAST(facts_json AS BLOB)) AS facts_bytes
               FROM file_blobs WHERE extractor_set = ? AND path_hint = ?`,
            )
            .get('alternate-caller-cache', fixture.file.path) as {
            readonly facts_bytes: number;
            readonly facts_json: string;
          };
        } finally {
          database.close(false);
        }
      });
      const persisted = decodeStoredCodeGraphFact(row.facts_json, fixture.file.path).facts;

      expect(row.facts_bytes).toBeLessThanOrEqual(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
      expect(row.facts_bytes).toBe(new TextEncoder().encode(row.facts_json).byteLength);
      expect(persisted.symbols.map(value => value.id)).toEqual([root.id, declaration.id]);
      expect(persisted.symbols.every(value => value.documentation === undefined)).toBe(true);
      expect(persisted.edges).toEqual([declares]);
      expect(persisted.diagnostics[0]).toMatch(/^Cached code graph facts exceeded the per-file persistence budget/);
      expect(persisted.diagnostics[0]).not.toMatch(/private-cache-sentinel|materialization\.ts/);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('persists same-path cache batches with distinct physical identities', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const replacement = {...fixture.file, contentHash: 'j'.repeat(64)};
      const facts: CodeGraphFileFacts = {
        diagnostics: [],
        edges: [],
        path: fixture.file.path,
        symbols: [],
      };
      const store = yield* CodeGraphStore;

      yield* store.cacheFactBatches(
        fixture.databasePath,
        [
          {extractorSet: 'durable-cache', facts: [facts], files: [fixture.file]},
          {extractorSet: 'degraded-cache', facts: [facts], files: [replacement]},
        ],
        unprotectedCacheWrite,
      );

      const rows = yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          return database
            .query(
              `SELECT content_hash, extractor_set, path_hint
               FROM file_blobs
               WHERE path_hint = ?
               ORDER BY extractor_set`,
            )
            .all(fixture.file.path);
        } finally {
          database.close(false);
        }
      });

      expect(rows).toEqual([
        {
          content_hash: replacement.contentHash,
          extractor_set: 'degraded-cache',
          path_hint: fixture.file.path,
        },
        {
          content_hash: fixture.file.contentHash,
          extractor_set: 'durable-cache',
          path_hint: fixture.file.path,
        },
      ]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'rejects mismatched and oversized cache plans before a receipt or writer starts',
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(materializationFixture);
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
        let receipts = 0;
        let writers = 0;
        const protector: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) => {
          receipts += 1;
          return transaction;
        };
        const mismatch = yield* store
          .withSession(
            fixture.databasePath,
            store.cacheFacts(
              fixture.databasePath,
              [fixture.file],
              [{diagnostics: [], edges: [], path: 'src/mismatch.ts', symbols: []}],
              'mismatched-cache-plan',
              protector,
            ),
            {
              onWriterAcquired: () =>
                Effect.sync(() => {
                  writers += 1;
                }),
              writerLockPath: join(fixture.root, 'cache-plan-writer.lock'),
            },
          )
          .pipe(Effect.flip);
        expect(mismatch).toBeInstanceOf(CodeGraphStoreError);
        expect(mismatch.message).toMatch(/inputs are inconsistent/u);

        const oversizedExtractor = 'x'.repeat(32 * 1_048_576 + 1);
        const oversized = yield* store
          .withSession(
            fixture.databasePath,
            store.cacheFacts(
              fixture.databasePath,
              [fixture.file],
              [{diagnostics: [], edges: [], path: fixture.file.path, symbols: []}],
              oversizedExtractor,
              protector,
            ),
            {
              onWriterAcquired: () =>
                Effect.sync(() => {
                  writers += 1;
                }),
              writerLockPath: join(fixture.root, 'cache-plan-writer.lock'),
            },
          )
          .pipe(Effect.flip);
        expect(oversized).toBeInstanceOf(CodeGraphStoreError);
        expect(oversized.message).toMatch(/payload ceiling/u);
        expect(oversized.message).not.toContain(fixture.file.path);
        expect(oversized.message.length).toBeLessThan(512);
        expect(receipts).toBe(0);
        expect(writers).toBe(0);
      }).pipe(provideTestLayer(ApplicationLayer)),
    30_000,
  );

  effectIt.effect('fails closed on non-text shard repair metadata before a receipt or writer starts', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const store = yield* CodeGraphStore;
      const extractorSet = 'materialized-shard-corrupt-metadata';
      const derivationIdentity = 'materialized-shard-corrupt-metadata-v1';
      const canonicalId = materializedFileShardIdentity(
        fixture.file.contentHash,
        extractorSet,
        derivationIdentity,
        fixture.file.path,
      );
      const requested = {
        diagnostics: ['requested after corrupt metadata'],
        edges: [],
        path: fixture.file.path,
        symbols: [],
      } satisfies CodeGraphFileFacts;
      const snapshotId = 'corrupt-shard-association-snapshot';
      yield* store.initialize(fixture.databasePath);
      let receipts = 0;
      let writers = 0;
      const protector: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) => {
        receipts += 1;
        return transaction;
      };
      const cache = () =>
        store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.initialize(fixture.databasePath);
            writers = 0;
            return yield* store.cacheMaterializedFileShards(
              fixture.databasePath,
              [fixture.file],
              [requested],
              extractorSet,
              derivationIdentity,
              protector,
            );
          }),
          {
            onWriterAcquired: () =>
              Effect.sync(() => {
                writers += 1;
              }),
            writerLockPath: join(fixture.root, 'corrupt-shard-writer.lock'),
          },
        );

      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database
            .query(
              `INSERT INTO materialized_file_shards (
                 id, content_hash, extractor_set, derivation_identity, path_hint,
                 facts_json, created_at, last_used_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              canonicalId,
              'x'.repeat(64),
              `${extractorSet}-wrong`,
              `${derivationIdentity}-wrong`,
              'corrupt/canonical-id.ts',
              JSON.stringify(requested),
              new Uint8Array([1, 2, 3]),
              '2026-08-09T00:00:00.000Z',
            );
        } finally {
          database.close(false);
        }
      });
      const corruptMetadata = yield* cache().pipe(Effect.flip);
      expect(corruptMetadata).toBeInstanceOf(CodeGraphStoreError);
      expect(corruptMetadata.message).toBe('Materialized file shard metadata is invalid.');
      expect(corruptMetadata.message).not.toContain(fixture.file.path);
      expect(receipts).toBe(0);
      expect(writers).toBe(0);

      yield* store.markBuilding(fixture.databasePath, fixture.identity, {
        ...readySnapshot(fixture.identity, 0, 0),
        id: snapshotId,
        state: 'building',
      });
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database.query('DELETE FROM materialized_file_shards WHERE id = ?').run(canonicalId);
          const conflictId = 'cgfs_corrupt-association-conflict';
          database
            .query(
              `INSERT INTO materialized_file_shards (
                 id, content_hash, extractor_set, derivation_identity, path_hint,
                 facts_json, created_at, last_used_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              conflictId,
              fixture.file.contentHash,
              extractorSet,
              derivationIdentity,
              fixture.file.path,
              JSON.stringify(requested),
              '2026-08-09T00:00:00.000Z',
              '2026-08-09T00:00:00.000Z',
            );
          database
            .query('INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id) VALUES (?, ?, ?)')
            .run(snapshotId, new Uint8Array([4, 5, 6]), conflictId);
        } finally {
          database.close(false);
        }
      });
      const corruptAssociation = yield* cache().pipe(Effect.flip);
      expect(corruptAssociation).toBeInstanceOf(CodeGraphStoreError);
      expect(corruptAssociation.message).toBe('Materialized file shard association metadata is invalid.');
      expect(corruptAssociation.message).not.toContain(fixture.file.path);
      expect(receipts).toBe(0);
      expect(writers).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects and repairs materialized shard rows with inconsistent identities', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const secondFile: CodeGraphInventoryFile = {
        ...fixture.file,
        blobId: 'd'.repeat(40),
        contentHash: 'i'.repeat(64),
        path: 'src/other.ts',
      };
      const files = [fixture.file, secondFile];
      const facts = files.map(
        file => ({diagnostics: [], edges: [], path: file.path, symbols: []}) satisfies CodeGraphFileFacts,
      );
      const expectedPaths = files.map(file => file.path).sort();
      const extractorSet = 'materialized-shard-identity';
      const derivationIdentity = 'materialized-shard-derivation';
      const store = yield* CodeGraphStore;
      const load = () =>
        store.loadMaterializedFileShards(fixture.databasePath, files, extractorSet, derivationIdentity);
      const cache = () =>
        store.cacheMaterializedFileShards(
          fixture.databasePath,
          files,
          facts,
          extractorSet,
          derivationIdentity,
          unprotectedCacheWrite,
        );
      const expectOnlySecondFile = (loaded: Effect.Success<ReturnType<typeof load>>) => {
        expect([...loaded.facts.entries()].map(([path, value]) => [path, value.path])).toEqual([
          [secondFile.path, secondFile.path],
        ]);
        expect(loaded.keys ? [...loaded.keys] : undefined).toEqual([secondFile.path]);
        expect(loaded.bytesByPath ? [...loaded.bytesByPath.keys()] : undefined).toEqual([secondFile.path]);
        expect(loaded.bytes).toBe(loaded.bytesByPath?.get(secondFile.path));
        expect(loaded.bytes).toBeGreaterThan(0);
      };

      yield* cache();
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database
            .query(
              `UPDATE materialized_file_shards
               SET facts_json = (
                 SELECT facts_json FROM materialized_file_shards WHERE path_hint = ?
               )
               WHERE path_hint = ?`,
            )
            .run(secondFile.path, fixture.file.path);
        } finally {
          database.close(false);
        }
      });

      expectOnlySecondFile(yield* load());
      yield* cache();
      expect([...(yield* load()).facts.keys()].sort()).toEqual(expectedPaths);

      const corruptedId = 'cgfs_corrupted-materialized-shard-identity';
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database
            .query('UPDATE materialized_file_shards SET id = ? WHERE path_hint = ?')
            .run(corruptedId, fixture.file.path);
        } finally {
          database.close(false);
        }
      });

      expectOnlySecondFile(yield* load());
      yield* cache();
      const repaired = yield* load();
      expect([...repaired.facts.keys()].sort()).toEqual(expectedPaths);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(
            database
              .query<{readonly id: string}, [string]>('SELECT id FROM materialized_file_shards WHERE path_hint = ?')
              .get(fixture.file.path),
          ).toEqual({
            id: materializedFileShardIdentity(
              fixture.file.contentHash,
              extractorSet,
              derivationIdentity,
              fixture.file.path,
            ),
          });
        } finally {
          database.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('replans a normal shard upsert when a tuple collision arrives before the writer', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const store = yield* CodeGraphStore;
      const extractorSet = 'materialized-shard-normal-race';
      const derivationIdentity = 'materialized-shard-normal-race-v1';
      const requested = {
        diagnostics: ['requested canonical payload'],
        edges: [],
        path: fixture.file.path,
        symbols: [],
      } satisfies CodeGraphFileFacts;
      const wrongId = 'cgfs_normal-race-wrong-id';
      let reservations = 0;
      const protector: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) =>
        Effect.gen(function* () {
          reservations += 1;
          if (reservations === 1) {
            yield* Effect.sync(() => {
              const database = new Database(fixture.databasePath, {strict: true});
              try {
                database
                  .query(
                    `INSERT INTO materialized_file_shards (
                       id, content_hash, extractor_set, derivation_identity, path_hint,
                       facts_json, created_at, last_used_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    wrongId,
                    fixture.file.contentHash,
                    extractorSet,
                    derivationIdentity,
                    fixture.file.path,
                    JSON.stringify({...requested, diagnostics: ['racing collision']}),
                    '2026-08-09T00:00:00.000Z',
                    '2026-08-09T00:00:00.000Z',
                  );
              } finally {
                database.close(false);
              }
            });
          }
          return yield* transaction;
        });

      yield* store.cacheMaterializedFileShards(
        fixture.databasePath,
        [fixture.file],
        [requested],
        extractorSet,
        derivationIdentity,
        protector,
      );

      const loaded = yield* store.loadMaterializedFileShards(
        fixture.databasePath,
        [fixture.file],
        extractorSet,
        derivationIdentity,
      );
      expect(reservations).toBe(2);
      expect(loaded.facts.get(fixture.file.path)?.diagnostics).toEqual(['requested canonical payload']);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(
            database.query('SELECT COUNT(*) AS count FROM materialized_file_shards WHERE id = ?').get(wrongId),
          ).toEqual({count: 0});
        } finally {
          database.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rolls back a multi-row shard UPSERT when one row races with a tuple collision', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const store = yield* CodeGraphStore;
      const extractorSet = 'materialized-shard-multi-row-race';
      const derivationIdentity = 'materialized-shard-multi-row-race-v1';
      const files = Array.from({length: CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows}, (_, index) => ({
        ...fixture.file,
        contentHash: index.toString(16).padStart(64, '0'),
        path: `src/batched-${index.toString().padStart(3, '0')}.ts`,
      }));
      const facts = files.map(file => ({
        diagnostics: [`canonical ${file.path}`],
        edges: [],
        path: file.path,
        symbols: [],
      })) satisfies readonly CodeGraphFileFacts[];
      const raced = files.at(-1)!;
      const wrongId = 'cgfs_multi-row-race-wrong-id';
      yield* store.initialize(fixture.databasePath);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database.exec(`
            CREATE TABLE materialized_shard_multi_row_audit (operation TEXT NOT NULL);
            CREATE TRIGGER materialized_shard_multi_row_insert
            AFTER INSERT ON materialized_file_shards
            BEGIN INSERT INTO materialized_shard_multi_row_audit VALUES ('insert'); END;
            CREATE TRIGGER materialized_shard_multi_row_update
            AFTER UPDATE ON materialized_file_shards
            BEGIN INSERT INTO materialized_shard_multi_row_audit VALUES ('update'); END;
            CREATE TRIGGER materialized_shard_multi_row_delete
            AFTER DELETE ON materialized_file_shards
            BEGIN INSERT INTO materialized_shard_multi_row_audit VALUES ('delete'); END;
          `);
        } finally {
          database.close(false);
        }
      });
      let reservations = 0;
      const protector: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) =>
        Effect.gen(function* () {
          reservations += 1;
          if (reservations === 1) {
            yield* Effect.sync(() => {
              const database = new Database(fixture.databasePath, {strict: true});
              try {
                database
                  .query(
                    `INSERT INTO materialized_file_shards (
                       id, content_hash, extractor_set, derivation_identity, path_hint,
                       facts_json, created_at, last_used_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    wrongId,
                    raced.contentHash,
                    extractorSet,
                    derivationIdentity,
                    raced.path,
                    JSON.stringify({...facts.at(-1)!, diagnostics: ['racing collision']}),
                    '2026-08-23T00:00:00.000Z',
                    '2026-08-23T00:00:00.000Z',
                  );
              } finally {
                database.close(false);
              }
            });
          }
          return yield* transaction;
        });

      yield* store.cacheMaterializedFileShards(
        fixture.databasePath,
        files,
        facts,
        extractorSet,
        derivationIdentity,
        protector,
      );

      expect(reservations).toBe(3);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(
            database
              .query('SELECT COUNT(*) AS count FROM materialized_file_shards WHERE derivation_identity = ?')
              .get(derivationIdentity),
          ).toEqual({count: files.length});
          expect(
            database.query('SELECT COUNT(*) AS count FROM materialized_file_shards WHERE id = ?').get(wrongId),
          ).toEqual({count: 0});
          expect(
            database
              .query<{readonly count: number; readonly operation: string}, []>(
                `SELECT operation, COUNT(*) AS count
                 FROM materialized_shard_multi_row_audit
                 GROUP BY operation ORDER BY operation`,
              )
              .all(),
          ).toEqual([
            {count: 1, operation: 'delete'},
            {count: files.length + 1, operation: 'insert'},
          ]);
        } finally {
          database.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('coalesces bounded attribution batches into one materialized-shard reservation', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const store = yield* CodeGraphStore;
      const batches = Array.from({length: 4}, (_, index) => {
        const file = {
          ...fixture.file,
          contentHash: (index + 1).toString(16).padStart(64, '0'),
          path: `src/coalesced-${index}.ts`,
        };
        return {
          derivationIdentity: `coalesced-shard-v${index}`,
          extractorSet: 'coalesced-shard-cache',
          facts: [
            {
              diagnostics: [],
              edges: [],
              path: file.path,
              symbols: [],
            } satisfies CodeGraphFileFacts,
          ],
          files: [file],
        };
      });
      let reservations = 0;
      const protector: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) => {
        reservations += 1;
        return transaction;
      };

      yield* store.cacheMaterializedFileShardBatches(fixture.databasePath, batches, protector);

      expect(reservations).toBe(1);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(database.query('SELECT COUNT(*) AS count FROM materialized_file_shards').get()).toEqual({count: 4});
        } finally {
          database.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('still writes requested facts when a competing repair makes the frozen collision normal', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const store = yield* CodeGraphStore;
      const extractorSet = 'materialized-shard-repair-race';
      const derivationIdentity = 'materialized-shard-repair-race-v1';
      const canonicalId = materializedFileShardIdentity(
        fixture.file.contentHash,
        extractorSet,
        derivationIdentity,
        fixture.file.path,
      );
      const wrongId = 'cgfs_repair-race-wrong-id';
      const requested = {
        diagnostics: ['requested after competing repair'],
        edges: [],
        path: fixture.file.path,
        symbols: [],
      } satisfies CodeGraphFileFacts;
      yield* store.initialize(fixture.databasePath);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database
            .query(
              `INSERT INTO materialized_file_shards (
                 id, content_hash, extractor_set, derivation_identity, path_hint,
                 facts_json, created_at, last_used_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              wrongId,
              fixture.file.contentHash,
              extractorSet,
              derivationIdentity,
              fixture.file.path,
              JSON.stringify({...requested, diagnostics: ['initial collision']}),
              '2026-08-09T00:00:00.000Z',
              '2026-08-09T00:00:00.000Z',
            );
        } finally {
          database.close(false);
        }
      });
      let reservations = 0;
      const protector: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) =>
        Effect.gen(function* () {
          reservations += 1;
          if (reservations === 1) {
            yield* Effect.sync(() => {
              const database = new Database(fixture.databasePath, {strict: true});
              try {
                database.query('DELETE FROM materialized_file_shards WHERE id = ?').run(wrongId);
                database
                  .query(
                    `INSERT INTO materialized_file_shards (
                       id, content_hash, extractor_set, derivation_identity, path_hint,
                       facts_json, created_at, last_used_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    canonicalId,
                    fixture.file.contentHash,
                    extractorSet,
                    derivationIdentity,
                    fixture.file.path,
                    JSON.stringify({...requested, diagnostics: ['competing stale payload']}),
                    '2026-08-09T00:00:00.000Z',
                    '2026-08-09T00:00:00.000Z',
                  );
              } finally {
                database.close(false);
              }
            });
          }
          return yield* transaction;
        });

      yield* store.cacheMaterializedFileShards(
        fixture.databasePath,
        [fixture.file],
        [requested],
        extractorSet,
        derivationIdentity,
        protector,
      );

      const loaded = yield* store.loadMaterializedFileShards(
        fixture.databasePath,
        [fixture.file],
        extractorSet,
        derivationIdentity,
      );
      expect(reservations).toBe(2);
      expect(loaded.facts.get(fixture.file.path)?.diagnostics).toEqual(['requested after competing repair']);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'drains high-cardinality two-row shard collisions in exact bounded transactions',
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(materializationFixture);
        const store = yield* CodeGraphStore;
        const extractorSet = 'materialized-shard-high-cardinality';
        const derivationIdentity = 'materialized-shard-high-cardinality-v1';
        const canonicalId = materializedFileShardIdentity(
          fixture.file.contentHash,
          extractorSet,
          derivationIdentity,
          fixture.file.path,
        );
        const tupleConflictId = 'cgfs_high-cardinality-tuple-conflict';
        const unrelatedShardId = 'cgfs_high-cardinality-unrelated';
        const targetSnapshotId = 'high-cardinality-target-snapshot';
        const unrelatedSnapshotId = 'high-cardinality-unrelated-snapshot';
        const requested = {
          diagnostics: ['canonical after bounded drain'],
          edges: [],
          path: fixture.file.path,
          symbols: [],
        } satisfies CodeGraphFileFacts;
        yield* store.initialize(fixture.databasePath);
        yield* store.markBuilding(fixture.databasePath, fixture.identity, {
          ...readySnapshot(fixture.identity, 0, 0),
          id: targetSnapshotId,
          state: 'building',
        });
        yield* store.markBuilding(fixture.databasePath, fixture.identity, {
          ...readySnapshot(fixture.identity, 0, 0),
          id: unrelatedSnapshotId,
          state: 'building',
        });
        yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath, {strict: true});
          const insertShard = database.prepare(
            `INSERT INTO materialized_file_shards (
             id, content_hash, extractor_set, derivation_identity, path_hint,
             facts_json, created_at, last_used_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const insertAssociation = database.prepare(
            'INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id) VALUES (?, ?, ?)',
          );
          try {
            database.transaction(() => {
              insertShard.run(
                canonicalId,
                'x'.repeat(64),
                `${extractorSet}-wrong`,
                `${derivationIdentity}-wrong`,
                'corrupt/canonical-id.ts',
                JSON.stringify({...requested, path: 'corrupt/canonical-id.ts'}),
                '2026-08-09T00:00:00.000Z',
                '2026-08-09T00:00:00.000Z',
              );
              insertShard.run(
                tupleConflictId,
                fixture.file.contentHash,
                extractorSet,
                derivationIdentity,
                fixture.file.path,
                JSON.stringify({...requested, diagnostics: ['tuple conflict']}),
                '2026-08-09T00:00:00.000Z',
                '2026-08-09T00:00:00.000Z',
              );
              insertShard.run(
                unrelatedShardId,
                'u'.repeat(64),
                extractorSet,
                derivationIdentity,
                'src/unrelated.ts',
                JSON.stringify({...requested, path: 'src/unrelated.ts'}),
                '2026-08-09T00:00:00.000Z',
                '2026-08-09T00:00:00.000Z',
              );
              for (let index = 0; index < 1_025; index += 1) {
                insertAssociation.run(
                  targetSnapshotId,
                  `target/${index.toString().padStart(4, '0')}.ts`,
                  index % 2 === 0 ? canonicalId : tupleConflictId,
                );
                insertAssociation.run(
                  unrelatedSnapshotId,
                  `unrelated/${index.toString().padStart(4, '0')}.ts`,
                  unrelatedShardId,
                );
              }
            })();
            database.exec('CREATE TABLE cache_capacity_mutations (kind TEXT NOT NULL)');
            database.exec(
              `CREATE TRIGGER cache_capacity_association_delete
             AFTER DELETE ON snapshot_file_shards
             BEGIN INSERT INTO cache_capacity_mutations(kind) VALUES ('association-delete'); END`,
            );
            database.exec(
              `CREATE TRIGGER cache_capacity_shard_delete
             AFTER DELETE ON materialized_file_shards
             BEGIN INSERT INTO cache_capacity_mutations(kind) VALUES ('shard-delete'); END`,
            );
            database.exec(
              `CREATE TRIGGER cache_capacity_shard_insert
             AFTER INSERT ON materialized_file_shards
             BEGIN INSERT INTO cache_capacity_mutations(kind) VALUES ('shard-insert'); END`,
            );
          } finally {
            database.close(false);
          }
        });
        const boundaries: CodeGraphDirectPersistentCapacityBoundary[] = [];
        const protector: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) =>
          Effect.gen(function* () {
            const before = yield* Effect.sync(() => mutationCount(fixture.databasePath));
            const result = yield* transaction;
            const after = yield* Effect.sync(() => mutationCount(fixture.databasePath));
            boundaries.push(boundary);
            expect(after - before).toBe(boundary.rowCount);
            return result;
          });

        yield* store.cacheMaterializedFileShards(
          fixture.databasePath,
          [fixture.file],
          [requested],
          extractorSet,
          derivationIdentity,
          protector,
        );

        expect(boundaries.map(boundary => boundary.rowCount)).toEqual([512, 512, 1, 3]);
        expect(
          boundaries.every(
            boundary =>
              boundary.operation === 'cache materialized code graph file shards' &&
              boundary.rowCount <= 512 &&
              boundary.finalFactBytes <= 32 * 1_048_576,
          ),
        ).toBe(true);
        const loaded = yield* store.loadMaterializedFileShards(
          fixture.databasePath,
          [fixture.file],
          extractorSet,
          derivationIdentity,
        );
        expect(loaded.facts.get(fixture.file.path)?.diagnostics).toEqual(['canonical after bounded drain']);
        yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath, {readonly: true, strict: true});
          try {
            expect(
              database
                .query('SELECT COUNT(*) AS count FROM snapshot_file_shards WHERE snapshot_id = ?')
                .get(targetSnapshotId),
            ).toEqual({count: 0});
            expect(
              database
                .query('SELECT COUNT(*) AS count FROM snapshot_file_shards WHERE snapshot_id = ?')
                .get(unrelatedSnapshotId),
            ).toEqual({count: 1_025});
            expect(
              database
                .query('SELECT COUNT(*) AS count FROM materialized_file_shards WHERE id = ?')
                .get(unrelatedShardId),
            ).toEqual({count: 1});
          } finally {
            database.close(false);
          }
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    30_000,
  );

  effectIt.effect('replans a frozen shard association drain when its targeted set grows', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const store = yield* CodeGraphStore;
      const extractorSet = 'materialized-shard-association-race';
      const derivationIdentity = 'materialized-shard-association-race-v1';
      const conflictId = 'cgfs_association-race-conflict';
      const snapshotId = 'association-race-snapshot';
      const requested = {
        diagnostics: ['canonical after association replan'],
        edges: [],
        path: fixture.file.path,
        symbols: [],
      } satisfies CodeGraphFileFacts;
      yield* store.initialize(fixture.databasePath);
      yield* store.markBuilding(fixture.databasePath, fixture.identity, {
        ...readySnapshot(fixture.identity, 0, 0),
        id: snapshotId,
        state: 'building',
      });
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        try {
          database
            .query(
              `INSERT INTO materialized_file_shards (
                 id, content_hash, extractor_set, derivation_identity, path_hint,
                 facts_json, created_at, last_used_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              conflictId,
              fixture.file.contentHash,
              extractorSet,
              derivationIdentity,
              fixture.file.path,
              JSON.stringify({...requested, diagnostics: ['collision']}),
              '2026-08-09T00:00:00.000Z',
              '2026-08-09T00:00:00.000Z',
            );
          database
            .query('INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id) VALUES (?, ?, ?)')
            .run(snapshotId, 'target/a.ts', conflictId);
          database.exec('CREATE TABLE association_race_deletes (path TEXT NOT NULL)');
          database.exec(
            `CREATE TRIGGER association_race_delete
             AFTER DELETE ON snapshot_file_shards
             BEGIN INSERT INTO association_race_deletes(path) VALUES (old.path); END`,
          );
        } finally {
          database.close(false);
        }
      });
      const boundaries: CodeGraphDirectPersistentCapacityBoundary[] = [];
      const protector: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) =>
        Effect.gen(function* () {
          boundaries.push(boundary);
          if (boundaries.length === 1) {
            yield* Effect.sync(() => {
              const database = new Database(fixture.databasePath, {strict: true});
              try {
                database
                  .query('INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id) VALUES (?, ?, ?)')
                  .run(snapshotId, 'target/b.ts', conflictId);
              } finally {
                database.close(false);
              }
            });
          }
          return yield* transaction;
        });

      yield* store.cacheMaterializedFileShards(
        fixture.databasePath,
        [fixture.file],
        [requested],
        extractorSet,
        derivationIdentity,
        protector,
      );

      expect(boundaries.map(boundary => boundary.rowCount)).toEqual([1, 2, 2]);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {readonly: true, strict: true});
        try {
          expect(database.query('SELECT COUNT(*) AS count FROM association_race_deletes').get()).toEqual({count: 2});
          expect(
            database.query('SELECT COUNT(*) AS count FROM snapshot_file_shards WHERE snapshot_id = ?').get(snapshotId),
          ).toEqual({count: 0});
        } finally {
          database.close(false);
        }
      });
      const loaded = yield* store.loadMaterializedFileShards(
        fixture.databasePath,
        [fixture.file],
        extractorSet,
        derivationIdentity,
      );
      expect(loaded.facts.get(fixture.file.path)?.diagnostics).toEqual(['canonical after association replan']);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reads a repair association count and page from one frozen SQLite snapshot', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const store = yield* CodeGraphStore;
      const snapshotId = 'association-page-snapshot';
      const shardId = 'cgfs_association-page-conflict';
      yield* store.initialize(fixture.databasePath);
      yield* store.markBuilding(fixture.databasePath, fixture.identity, {
        ...readySnapshot(fixture.identity, 0, 0),
        id: snapshotId,
        state: 'building',
      });
      yield* Effect.sync(() => {
        const seeded = new Database(fixture.databasePath, {strict: true});
        try {
          seeded
            .query(
              `INSERT INTO materialized_file_shards (
                 id, content_hash, extractor_set, derivation_identity, path_hint,
                 facts_json, created_at, last_used_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              shardId,
              fixture.file.contentHash,
              'association-page-extractor',
              'association-page-derivation',
              fixture.file.path,
              JSON.stringify({diagnostics: [], edges: [], path: fixture.file.path, symbols: []}),
              '2026-08-09T00:00:00.000Z',
              '2026-08-09T00:00:00.000Z',
            );
          const insert = seeded.prepare(
            'INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id) VALUES (?, ?, ?)',
          );
          insert.run(snapshotId, 'target/a.ts', shardId);
          insert.run(snapshotId, 'target/b.ts', shardId);
        } finally {
          seeded.close(false);
        }
      });

      yield* Effect.sync(() => {
        const reader = new Database(fixture.databasePath, {readonly: true, strict: true});
        const competingWriter = new Database(fixture.databasePath, {strict: true});
        try {
          const statement = codeGraphMaterializedShardAssociationPageStatement([shardId], 512);
          const iterator = reader
            .query<
              {
                readonly association_count: number;
                readonly path: string;
                readonly shard_id: string;
                readonly snapshot_id: string;
              },
              [string, number]
            >(statement.text)
            .iterate(...statement.parameters);
          const first = iterator.next();
          expect(first.done).toBe(false);

          competingWriter.query('DELETE FROM snapshot_file_shards WHERE shard_id = ?').run(shardId);
          const frozenPage = [first.value!, ...iterator];
          expect(frozenPage.map(row => row.association_count)).toEqual([2, 2]);
          expect(frozenPage.map(row => row.path)).toEqual(['target/a.ts', 'target/b.ts']);
          expect(
            competingWriter.query('SELECT COUNT(*) AS count FROM snapshot_file_shards WHERE shard_id = ?').get(shardId),
          ).toEqual({count: 0});
        } finally {
          reader.close(false);
          competingWriter.close(false);
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('adapts persistent copy pages toward a bounded three-second transaction', () => {
    expect(nextPersistentActivationBatchRows(10_000, 850, 50_000)).toBe(20_000);
    expect(nextPersistentActivationBatchRows(20_000, 1_700, 50_000)).toBe(35_200);
    expect(nextPersistentActivationBatchRows(35_200, 3_000, 50_000)).toBe(35_200);
    expect(nextPersistentActivationBatchRows(5_000, 2_750, 10_000)).toBe(5_000);
    expect(nextPersistentActivationBatchRows(10_000, 12_000, 50_000)).toBe(2_500);
    expect(nextPersistentActivationBatchRows(250, Number.POSITIVE_INFINITY, 50_000)).toBe(250);
  });

  it('promotes an empty repository only after registering its zero-batch plan', async () => {
    const fixture = await materializationFixture();
    const snapshot: CodeGraphSnapshot = {
      ...readySnapshot(fixture.identity, 0, 0),
      fileCount: 0,
      id: 'empty-zero-batch-plan',
    };

    const graph = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [], snapshot.id, 0, ownerToken);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return yield* store.loadGraph(fixture.databasePath, snapshot.id);
          }),
        );
      }),
    );

    const evidence = persistentGraphEvidence(fixture.databasePath, snapshot.id);
    expect(graph.snapshot.state).toBe('ready');
    expect(evidence.files).toBe(0);
    expect(evidence.distinctFiles).toBe(0);
    expect(graph.symbols).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('resumes an open materialization plan and finalizes only exact contiguous receipts', async () => {
    const fixture = await materializationFixture();
    const first = symbol('open-plan-first', 'openPlanFirst', ['typescript:name:openPlanFirst']);
    const second = symbol('open-plan-second', 'openPlanSecond', ['typescript:name:openPlanSecond']);
    const snapshot = readySnapshot(fixture.identity, 2, 0);

    const interrupted = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, undefined, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [first], [], [], undefined, 0);
            const prematureResolution = yield* store.resolveStagedReferences(fixture.databasePath).pipe(
              Effect.as('unexpected success'),
              Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
            );
            const skippedBatch = yield* store
              .stageActivationFacts(fixture.databasePath, [second], [], [], undefined, 2)
              .pipe(
                Effect.as('unexpected success'),
                Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
              );
            return {prematureResolution, skippedBatch};
          }),
        );
      }),
    );

    const resumed = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, undefined, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [first], [], [], undefined, 0);
            yield* store.stageActivationFacts(fixture.databasePath, [second], [], [], undefined, 1);
            const wrongFinalCount = yield* store.finalizePersistentMaterializationPlan(fixture.databasePath, 1).pipe(
              Effect.as('unexpected success'),
              Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
            );
            yield* store.finalizePersistentMaterializationPlan(fixture.databasePath, 2);
            const afterFinalization = yield* store
              .stageActivationFacts(fixture.databasePath, [], [], [], undefined, 2)
              .pipe(
                Effect.as('unexpected success'),
                Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
              );
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              afterFinalization,
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              wrongFinalCount,
            };
          }),
        );
      }),
    );

    expect(interrupted.prematureResolution).toContain('incomplete batch receipts');
    expect(interrupted.skippedBatch).toContain('contiguous order');
    expect(resumed.wrongFinalCount).toContain('incomplete or non-contiguous receipts');
    expect(resumed.afterFinalization).toContain('outside the registered plan');
    expect(resumed.graph.symbols.map(value => value.id)).toEqual([first.id, second.id]);
  });

  it('expands deep scoped barrel chains across batches in bounded passes and terminates cycles', async () => {
    const fixture = await materializationFixture();
    const scope = 'cgp_barrel_fixture';
    const scopedNameKey = (path: string, name: string) =>
      `typescript:${scope}:path:${encodeURIComponent(path)}:name:${encodeURIComponent(name)}`;
    const moduleSymbol = (path: string, suffix: string): CodeGraphSymbol => ({
      ...symbol(`barrel-module-${suffix}`, `barrelModule${suffix}`, [`typescript:${scope}:module:${path}`]),
      kind: 'module',
      path,
      qualifiedName: path,
      resolutionScopeId: scope,
    });
    const reference = (
      source: CodeGraphSymbol,
      targetPath: string,
      name: string,
    ): {readonly edge: CodeGraphEdge; readonly reference: CodeGraphReference} => {
      const unresolved = {
        ...edge(`barrel-edge-${source.id}`, source, name),
        relation: 'reexports',
      } satisfies CodeGraphEdge;
      const targetKey = scopedNameKey(targetPath, name);
      const aliasKey = scopedNameKey(source.path, name);
      return {
        edge: unresolved,
        reference: {
          aliasLookupKeys: [`${aliasKey}:implementation`, aliasKey],
          edgeId: unresolved.id,
          evidencePath: source.path,
          evidenceSpan: unresolved.evidenceSpan,
          exportedOnly: true,
          lookupTiers: [[`${targetKey}:implementation`], [targetKey]],
          provenance: unresolved.provenance,
          relation: 'reexports',
          resolutionDomain: 'typescript',
          sourceId: source.id,
          sourceName: source.name,
          targetName: name,
        },
      };
    };
    const chainPaths = Array.from({length: 6}, (_, index) => `src/barrel-${index}.ts`);
    const terminalPath = 'src/barrel-target.ts';
    const terminal = {
      ...symbol('barrel-terminal', 'feature', [
        `${scopedNameKey(terminalPath, 'feature')}:implementation`,
        scopedNameKey(terminalPath, 'feature'),
      ]),
      path: terminalPath,
      qualifiedName: 'feature',
      resolutionScopeId: scope,
    } satisfies CodeGraphSymbol;
    const chain = chainPaths.map((path, index) => {
      const source = moduleSymbol(path, String(index));
      const targetPath = chainPaths[index + 1] ?? terminalPath;
      return {source, ...reference(source, targetPath, 'feature')};
    });
    const consumer = moduleSymbol('src/barrel-consumer.ts', 'consumer');
    const consumerEdge = edge('barrel-consumer-edge', consumer, 'feature');
    const consumerReference: CodeGraphReference = {
      edgeId: consumerEdge.id,
      evidencePath: consumer.path,
      evidenceSpan: consumerEdge.evidenceSpan,
      lookupTiers: [
        [`${scopedNameKey(chainPaths[0], 'feature')}:implementation`],
        [scopedNameKey(chainPaths[0], 'feature')],
      ],
      provenance: consumerEdge.provenance,
      relation: consumerEdge.relation,
      resolutionDomain: 'typescript',
      sourceId: consumer.id,
      sourceName: consumer.name,
      targetName: 'feature',
    };
    const cycleA = moduleSymbol('src/barrel-cycle-a.ts', 'cycle-a');
    const cycleB = moduleSymbol('src/barrel-cycle-b.ts', 'cycle-b');
    const cycleAReference = reference(cycleA, cycleB.path, 'cycle');
    const cycleBReference = reference(cycleB, cycleA.path, 'cycle');
    const batches = [
      ...chain.map((entry, index) => ({
        edges: [entry.edge],
        references: [entry.reference],
        symbols: index === chain.length - 1 ? [entry.source, terminal] : [entry.source],
      })),
      {edges: [consumerEdge], references: [consumerReference], symbols: [consumer]},
      {edges: [cycleAReference.edge], references: [cycleAReference.reference], symbols: [cycleA]},
      {edges: [cycleBReference.edge], references: [cycleBReference.reference], symbols: [cycleB]},
    ] as const;
    const allSymbols = batches.flatMap(batch => batch.symbols);
    const allEdges = batches.flatMap(batch => batch.edges);
    const paths = [...new Set(allSymbols.map(value => value.path))];
    const files = paths.map((path, index): CodeGraphInventoryFile => ({
      ...fixture.file,
      blobId: String(index + 1).padStart(40, '0'),
      contentHash: String(index + 1).padStart(64, '0'),
      path,
    }));
    const snapshot: CodeGraphSnapshot = {
      ...readySnapshot(fixture.identity, allSymbols.length, allEdges.length),
      fileCount: files.length,
      id: 'scoped-transitive-barrel-chain',
    };

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, files, snapshot.id, undefined, ownerToken);
            for (const [batchIndex, batch] of batches.entries()) {
              yield* store.stageActivationFacts(
                fixture.databasePath,
                batch.symbols,
                batch.edges,
                batch.references,
                undefined,
                batchIndex,
              );
            }
            yield* store.finalizePersistentMaterializationPlan(fixture.databasePath, batches.length);
            const resolution = yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {graph: yield* store.loadGraph(fixture.databasePath, snapshot.id), resolution};
          }),
        );
      }),
    );

    const resolvedPaths = new Set([...chainPaths, consumer.path]);
    const expectedResolved = result.graph.edges.filter(value => resolvedPaths.has(value.evidencePath));
    const cycleEdges = result.graph.edges.filter(value => value.evidencePath.includes('barrel-cycle-'));
    expect(expectedResolved).toHaveLength(chain.length + 1);
    expect(expectedResolved.every(value => value.targetId === terminal.id)).toBe(true);
    expect(cycleEdges).toHaveLength(2);
    expect(cycleEdges.every(value => value.targetId === undefined)).toBe(true);
    expect(result.resolution.resolved).toBe(chain.length + 1);
    expect(result.resolution.passesCompleted).toBeLessThanOrEqual(2);
    expect(result.resolution.referencesExamined).toBeLessThanOrEqual(allEdges.length * 2);
  });

  it('redacts complete POSIX and Windows paths containing literal spaces from diagnostics', () => {
    const posix = sanitizeCodeGraphStoreDiagnostic(
      'open "/Users/example/Secret Project/private graph.sqlite": permission denied',
    );
    const windows = sanitizeCodeGraphStoreDiagnostic(
      String.raw`open C:\Users\example\Secret Project\private graph.sqlite`,
    );
    const windowsUnc = sanitizeCodeGraphStoreDiagnostic(
      String.raw`open \\server\private share\Secret Project\private graph.sqlite`,
    );

    expect(posix).toBe('open "<local-path>": permission denied');
    expect(windows).toBe('open <local-path>');
    expect(windowsUnc).toBe('open <local-path>');
    expect(`${posix}\n${windows}\n${windowsUnc}`).not.toMatch(
      /Secret Project|private graph|Users[\\/]example|private share/,
    );
  });

  it('keeps directly materialized facts invisible until atomic readiness and skips activation copies', async () => {
    const fixture = await materializationFixture();
    const activation: CodeGraphActivationProgress[] = [];
    const materialization: CodeGraphStagingProgress[] = [];
    const caller = symbol('direct-caller', 'directCaller', ['typescript:name:directCaller']);
    const target = symbol('direct-target', 'directTarget', ['typescript:name:directTarget']);
    const unresolved = edge('direct-unresolved', caller, target.name);
    const reference: CodeGraphReference = {
      edgeId: unresolved.id,
      evidencePath: fixture.file.path,
      evidenceSpan: unresolved.evidenceSpan,
      lookupTiers: [['typescript:name:directTarget']],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: target.name,
    };
    const snapshot = readySnapshot(fixture.identity, 2, 1);

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [caller, target],
              [unresolved],
              [reference],
              progress => Effect.sync(() => materialization.push(progress)),
              0,
            );
            const invisible = yield* store.readySnapshotById(fixture.databasePath, snapshot.id);
            const unreadable = yield* store.loadGraph(fixture.databasePath, snapshot.id).pipe(
              Effect.as(false),
              Effect.orElseSucceed(() => true),
            );
            const resolution = yield* store.resolveStagedReferences(fixture.databasePath);
            const counts = yield* store.stagedFactCounts(fixture.databasePath);
            yield* store.activateStaged(
              fixture.databasePath,
              fixture.identity,
              snapshot,
              {fileSetFingerprint: 'files', packProvenance: [], workspaceFingerprint: 'workspace'},
              undefined,
              progress => Effect.sync(() => activation.push(progress)),
            );
            return {
              counts,
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              invisible,
              receipt: yield* store.reusableBaseReceipt(fixture.databasePath, snapshot.id),
              resolution,
              unreadable,
            };
          }),
        );
      }),
    );

    expect(result.invisible).toBeUndefined();
    expect(result.unreadable).toBe(true);
    expect(result.counts).toEqual({edges: 1, symbols: 2});
    expect(result.resolution.resolved).toBe(1);
    expect(result.graph.edges[0]).toMatchObject({sourceId: caller.id, targetId: target.id});
    expect(result.receipt).toMatchObject({fileSetFingerprint: 'files', workspaceFingerprint: 'workspace'});
    expect(materialization.some(progress => (progress.durableDatabaseBytes ?? 0) > 0)).toBe(true);
    expect(materialization.every(progress => progress.temporaryDatabaseBytes === undefined)).toBe(true);
    expect(activation.map(progress => progress.stage)).not.toContain('copying-files');
    expect(activation.map(progress => progress.stage)).not.toContain('copying-symbols');
    expect(activation.map(progress => progress.stage)).not.toContain('copying-terms');
    expect(activation.map(progress => progress.stage)).not.toContain('copying-edges');
    expect(activation.filter(progress => progress.state === 'completed').map(progress => progress.stage)).toEqual([
      'validating-input',
      'recording-completion',
      'committing-snapshot',
    ]);
  });

  it('atomically activates a self-contained dirty full build without publishing a reusable base', async () => {
    const fixture = await materializationFixture();
    const materialization: CodeGraphStagingProgress[] = [];
    const stored = symbol('dirty-direct-symbol', 'dirtyDirectSymbol', ['typescript:name:dirtyDirectSymbol']);
    const snapshot = {
      ...readySnapshot(fixture.identity, 1, 0),
      dirty: true,
      id: 'dirty-direct-full',
    } satisfies CodeGraphSnapshot;

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [stored],
              [],
              [],
              progress => Effect.sync(() => materialization.push(progress)),
              0,
            );
            yield* store.resolveStagedReferences(fixture.databasePath);
            const invisible = yield* store.readySnapshotById(fixture.databasePath, snapshot.id);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              invisible,
              ready: yield* store.readySnapshotById(fixture.databasePath, snapshot.id),
              receipt: yield* store.reusableBaseReceipt(fixture.databasePath, snapshot.id),
            };
          }),
        );
      }),
    );

    expect(result.invisible).toBeUndefined();
    expect(result.ready).toMatchObject({baseSnapshotId: undefined, dirty: true, state: 'ready'});
    expect(result.graph.symbols).toEqual([stored]);
    expect(result.receipt).toBeUndefined();
    expect(materialization.some(progress => (progress.durableDatabaseBytes ?? 0) > 0)).toBe(true);
    expect(materialization.every(progress => progress.temporaryDatabaseBytes === undefined)).toBe(true);
  });

  it('drains production-shaped unresolved staging rows in bounded restart-safe transactions', async () => {
    const fixture = await materializationFixture();
    const activation: CodeGraphActivationProgress[] = [];
    const targetName = 'missingDrainTarget';
    const referenceCount = 5_100;
    const callers = Array.from({length: referenceCount}, (_, index) => {
      const suffix = String(index).padStart(5, '0');
      return symbol(`drain-caller-${suffix}`, `drainCaller${suffix}`, [`typescript:name:drainCaller${suffix}`]);
    });
    const edges = callers.map((caller, index) => ({
      ...edge(`drain-edge-${String(index).padStart(5, '0')}`, caller, targetName),
      evidenceSpan: {column: 1, endColumn: 2, endLine: index + 1, line: index + 1},
    }));
    const references = edges.map((relationship, index): CodeGraphReference => ({
      edgeId: relationship.id,
      evidencePath: fixture.file.path,
      evidenceSpan: relationship.evidenceSpan,
      lookupTiers: [['typescript:name:missingDrainTarget']],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: callers[index].id,
      sourceName: callers[index].name,
      targetName,
    }));
    const snapshot = readySnapshot(fixture.identity, callers.length, referenceCount);

    const staging = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, callers, edges, references, undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            const staged = yield* store.stagedFactCounts(fixture.databasePath);
            if (staged.edges !== referenceCount) {
              return yield* TestError.make({message: `Expected ${referenceCount} staged edges, got ${staged.edges}.`});
            }
            yield* store.activateStaged(
              fixture.databasePath,
              fixture.identity,
              snapshot,
              undefined,
              undefined,
              progress => Effect.sync(() => activation.push(progress)),
            );
          }),
        );
        return yield* Effect.promise(() => awaitCompletedBuildCleanup(fixture.databasePath, snapshot.id));
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    const ready = database.query('SELECT state FROM snapshots WHERE id = ?').get(snapshot.id) as {
      readonly state: string;
    };
    database.close(false);

    expect(ready.state).toBe('ready');
    expect(staging).toEqual({batches: 0, candidates: 0, refs: 0});
    expect(
      activation.filter(
        progress =>
          progress.stage === 'validating-input' &&
          progress.state === 'progress' &&
          progress.transactionMilliseconds !== undefined,
      ),
    ).toEqual([]);
  });

  it('reclaims a ready snapshot receipt left by a crash after the atomic ready flip', async () => {
    const fixture = await materializationFixture();
    const snapshot = readySnapshot(fixture.identity, 1, 0);
    const stored = symbol('ready-receipt', 'readyReceipt', ['typescript:name:readyReceipt']);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [stored], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
          }),
        );
      }),
    );
    const interrupted = new Database(fixture.databasePath, {strict: true});
    interrupted
      .query(
        `INSERT INTO building_materialization_batches (
           snapshot_id, batch_index, batch_fingerprint, symbol_count, edge_count, term_count,
           lookup_count, reference_count, candidate_count, reexport_count, completed_at
         ) VALUES (?, 0, 'post-ready-crash', 1, 0, 0, 0, 0, 0, 0, ?)`,
      )
      .run(snapshot.id, new Date().toISOString());
    interrupted.close(false);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.pruneRetiredSnapshots(fixture.databasePath);
      }),
    );

    const repaired = new Database(fixture.databasePath, {readonly: true, strict: true});
    const ready = repaired.query('SELECT state FROM snapshots WHERE id = ?').get(snapshot.id) as {
      readonly state: string;
    };
    const receipts = repaired
      .query('SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?')
      .get(snapshot.id) as {readonly count: number};
    repaired.close(false);
    expect(ready.state).toBe('ready');
    expect(receipts.count).toBe(0);
  });

  effectIt.effect('keeps readiness successful across cleanup faults and self-heals on the next writer session', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(materializationFixture);
        const writerLockPath = join(fixture.root, 'checkout-writer.lock');
        const snapshot = readySnapshot(fixture.identity, 1, 0);
        const stored = symbol('cleanup-fault', 'cleanupFault', ['typescript:name:cleanupFault']);
        const nextIndexFacts: CodeGraphFileFacts = {
          diagnostics: [],
          edges: [],
          path: fixture.file.path,
          symbols: [],
        };
        const ready = yield* Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
                ...snapshot,
                state: 'building',
              });
              yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
              yield* store.stageActivationFacts(fixture.databasePath, [stored], [], [], undefined, 0);
              yield* store.resolveStagedReferences(fixture.databasePath);
              yield* Effect.sync(() => {
                const database = new Database(fixture.databasePath, {strict: true});
                database.exec(`
              CREATE TRIGGER reject_completed_receipt_cleanup
              BEFORE DELETE ON building_materialization_batches
              WHEN OLD.snapshot_id = '${snapshot.id}'
              BEGIN
                SELECT RAISE(FAIL, 'injected post-ready cleanup failure');
              END
            `);
                database.close(false);
              });
              yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
              return yield* store.readySnapshotById(fixture.databasePath, snapshot.id);
            }),
          );
        }).pipe(provideTestLayer(ApplicationLayer));

        expect(ready?.state).toBe('ready');
        expect(readCompletedBuildRows(fixture.databasePath, snapshot.id).batches).toBe(1);
        const cleanupFailure = yield* Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* Effect.match(store.pruneRetiredSnapshots(fixture.databasePath), {
            onFailure: observedStoreFailure,
            onSuccess: () => undefined,
          });
        }).pipe(provideTestLayer(ApplicationLayer));
        expect(cleanupFailure).toMatchObject({
          code: 'unknown',
          message: 'prune retired code graph snapshots failed with an unclassified storage error.',
          recovery: 'diagnose',
          retryable: false,
        });
        expect(cleanupFailure?.message).not.toContain(fixture.databasePath);

        yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath, {strict: true});
          database.exec('DROP TRIGGER reject_completed_receipt_cleanup');
          database.close(false);
        });
        const rowsDuringForegroundWork = yield* Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              const rows = yield* Effect.sync(() => readCompletedBuildRows(fixture.databasePath, snapshot.id));
              yield* store.cacheFacts(
                fixture.databasePath,
                [fixture.file],
                [nextIndexFacts],
                'next-index-cache',
                unprotectedCacheWrite,
              );
              return rows;
            }),
            {cleanupCompletedBuildRows: true, writerLockPath},
          );
        }).pipe(provideTestLayer(ApplicationLayer));
        expect(rowsDuringForegroundWork).toEqual({
          batches: 1,
          candidates: 0,
          refs: 0,
        });
        expect(readCompletedBuildRows(fixture.databasePath, snapshot.id)).toEqual({
          batches: 0,
          candidates: 0,
          refs: 0,
        });
      }),
    ),
  );

  effectIt.effect('opens detached completed-build cleanup only while holding the checkout writer gate', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(materializationFixture);
        const writerLockPath = join(fixture.root, 'checkout-writer.lock');
        const snapshot = readySnapshot(fixture.identity, 1, 0);
        const stored = symbol('gated-cleanup', 'gatedCleanup', ['typescript:name:gatedCleanup']);
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        const cleanupConnectionOpened = yield* Deferred.make<boolean>();
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [stored], [], [], undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
          }),
          {
            onCompletedBuildCleanupConnection: () =>
              fs.exists(writerLockPath).pipe(
                Effect.orElseSucceed(() => false),
                Effect.flatMap(writerGateHeld => Deferred.succeed(cleanupConnectionOpened, writerGateHeld)),
                Effect.asVoid,
              ),
            writerLockPath,
          },
        );
        expect(yield* Deferred.await(cleanupConnectionOpened).pipe(Effect.timeout('5 seconds'))).toBe(true);
        expect(yield* Effect.promise(() => awaitCompletedBuildCleanup(fixture.databasePath, snapshot.id))).toEqual({
          batches: 0,
          candidates: 0,
          refs: 0,
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('gives a waiting foreground writer priority between detached cleanup sweeps', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(materializationFixture);
        const writerLockPath = join(fixture.root, 'checkout-writer.lock');
        const snapshot = readySnapshot(fixture.identity, 1, 0);
        const stored = symbol('cleanup-priority', 'cleanupPriority', ['typescript:name:cleanupPriority']);
        const foregroundFacts: CodeGraphFileFacts = {
          diagnostics: [],
          edges: [],
          path: fixture.file.path,
          symbols: [],
        };
        yield* Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
              yield* store.stageActivationFacts(fixture.databasePath, [stored], []);
              yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            }),
          );
        }).pipe(provideTestLayer(ApplicationLayer));

        yield* Effect.sync(() => {
          const seeded = new Database(fixture.databasePath, {strict: true});
          try {
            const insertReceipt = seeded.prepare(
              `INSERT INTO building_materialization_batches (
               snapshot_id, batch_index, batch_fingerprint, symbol_count, edge_count, term_count,
               lookup_count, reference_count, candidate_count, reexport_count, completed_at
             ) VALUES (?, ?, ?, 1, 0, 0, 0, 0, 0, 0, ?)`,
            );
            seeded.transaction(() => {
              for (let index = 0; index < 3_100; index += 1) {
                insertReceipt.run(snapshot.id, index, `cleanup-priority-${index}`, new Date().toISOString());
              }
            })();
          } finally {
            seeded.close(false);
          }
        });

        const result = yield* Effect.gen(function* () {
          const cleanupConnections = yield* Ref.make(0);
          const firstCleanupEntered = yield* Deferred.make<void>();
          const releaseFirstCleanup = yield* Deferred.make<void>();
          const secondCleanupEntered = yield* Deferred.make<void>();
          const foregroundContended = yield* Deferred.make<void>();
          const foregroundAcquired = yield* Deferred.make<void>();
          const releaseForeground = yield* Deferred.make<void>();
          const store = yield* CodeGraphStore;

          yield* store.withSession(fixture.databasePath, Effect.void, {
            cleanupCompletedBuildRows: true,
            onCompletedBuildCleanupConnection: () =>
              Ref.updateAndGet(cleanupConnections, count => count + 1).pipe(
                Effect.flatMap(sweep =>
                  sweep === 1
                    ? Deferred.succeed(firstCleanupEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseFirstCleanup)),
                      )
                    : sweep === 2
                      ? Deferred.succeed(secondCleanupEntered, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                ),
              ),
            writerLockPath,
          });
          yield* Deferred.await(firstCleanupEntered);

          const foreground = yield* store
            .withSession(
              fixture.databasePath,
              store.cacheFacts(
                fixture.databasePath,
                [fixture.file],
                [foregroundFacts],
                'foreground-priority',
                unprotectedCacheWrite,
              ),
              {
                onWriterAcquired: () =>
                  Deferred.succeed(foregroundAcquired, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseForeground)),
                  ),
                onWriterContention: () => Deferred.succeed(foregroundContended, undefined).pipe(Effect.asVoid),
                writerLockPath,
              },
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(foregroundContended);
          yield* Deferred.succeed(releaseFirstCleanup, undefined);
          yield* Deferred.await(foregroundAcquired);
          yield* Effect.sleep('100 millis');

          const cleanupConnectionsBeforeForeground = yield* Ref.get(cleanupConnections);
          const secondSweepStartedBeforeForeground = yield* Deferred.isDone(secondCleanupEntered);
          yield* Deferred.succeed(releaseForeground, undefined);
          yield* Fiber.join(foreground);
          const remainingAfterForeground = readCompletedBuildRows(fixture.databasePath, snapshot.id).batches;
          yield* store.withSession(fixture.databasePath, Effect.void, {
            cleanupCompletedBuildRows: true,
            writerLockPath,
          });
          const cleaned = yield* Effect.promise(() => awaitCompletedBuildCleanup(fixture.databasePath, snapshot.id));
          return {
            cleaned,
            cleanupConnectionsBeforeForeground,
            remainingAfterForeground,
            secondSweepStartedBeforeForeground,
          };
        }).pipe(provideTestLayer(ApplicationLayer));

        expect(result.cleanupConnectionsBeforeForeground).toBe(1);
        expect(result.secondSweepStartedBeforeForeground).toBe(false);
        expect(result.remainingAfterForeground).toBeGreaterThan(1_000);
        expect(result.cleaned).toEqual({batches: 0, candidates: 0, refs: 0});
      }),
    ),
  );

  effectIt.effect('resumes compacted reference payloads without durable candidate rows', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => materializationFixture());
      const caller = symbol('compacted-caller', 'compactedCaller', ['typescript:name:compactedCaller']);
      const unresolved = edge('compacted-edge', caller, 'missingCompactedTarget');
      const reference: CodeGraphReference = {
        edgeId: unresolved.id,
        evidencePath: fixture.file.path,
        evidenceSpan: unresolved.evidenceSpan,
        lookupTiers: [
          ['typescript:name:żółw🙂zeta', 'typescript:name:alpha', 'typescript:name:alpha'],
          ['typescript:name:alpha'],
        ],
        provenance: 'syntactic',
        relation: 'calls',
        resolutionDomain: 'typescript',
        sourceId: caller.id,
        sourceName: caller.name,
        targetName: unresolved.targetName,
      };
      const snapshot = {...readySnapshot(fixture.identity, 1, 1), id: 'compacted-reference-resume'};
      const store = yield* CodeGraphStore;

      yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
            ...snapshot,
            state: 'building',
          });
          yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
          yield* store.stageActivationFacts(fixture.databasePath, [caller], [unresolved], [reference], undefined, 0);
        }),
      );

      const expectedLookupTiers = [['typescript:name:alpha', 'typescript:name:żółw🙂zeta'], ['typescript:name:alpha']];
      const expectedPayload = JSON.stringify(expectedLookupTiers);
      const interruptedEvidence = yield* Effect.acquireUseRelease(
        Effect.sync(() => new Database(fixture.databasePath, {readonly: true, strict: true})),
        interrupted =>
          Effect.sync(() => ({
            durableCandidates: interrupted
              .query('SELECT COUNT(*) AS count FROM building_reference_candidates WHERE snapshot_id = ?')
              .get(snapshot.id) as {readonly count: number},
            receipt: interrupted
              .query('SELECT candidate_count FROM building_materialization_batches WHERE snapshot_id = ?')
              .get(snapshot.id) as {readonly candidate_count: number},
            stagedEdge: interrupted
              .query('SELECT id FROM edges WHERE snapshot_id = ? AND id = ?')
              .get(snapshot.id, unresolved.id),
            stored: interrupted
              .query(
                `SELECT lookup_tiers_json, candidate_count, candidate_payload_bytes,
                   source_id, source_name, relation, target_name, provenance, confidence,
                   evidence_path, evidence_span_json
                 FROM building_references
                 WHERE snapshot_id = ? AND edge_id = ?`,
              )
              .get(snapshot.id, unresolved.id) as {
              readonly candidate_count: number;
              readonly candidate_payload_bytes: number;
              readonly confidence: number;
              readonly evidence_path: string;
              readonly evidence_span_json: string;
              readonly lookup_tiers_json: string;
              readonly provenance: string;
              readonly relation: string;
              readonly source_id: string | null;
              readonly source_name: string;
              readonly target_name: string;
            },
          })),
        interrupted => Effect.sync(() => interrupted.close(false)),
      );

      expect(interruptedEvidence.stored).toEqual({
        candidate_count: 3,
        candidate_payload_bytes: new TextEncoder().encode(expectedPayload).byteLength,
        confidence: unresolved.confidence,
        evidence_path: unresolved.evidencePath,
        evidence_span_json: JSON.stringify(unresolved.evidenceSpan),
        lookup_tiers_json: expectedPayload,
        provenance: unresolved.provenance,
        relation: unresolved.relation,
        source_id: unresolved.sourceId,
        source_name: unresolved.sourceName,
        target_name: unresolved.targetName,
      });
      expect(interruptedEvidence.stagedEdge).toBeNull();
      expect(interruptedEvidence.durableCandidates.count).toBe(0);
      expect(interruptedEvidence.receipt.candidate_count).toBe(3);

      const resumed = yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
            ...snapshot,
            state: 'building',
          });
          yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
          yield* store.stageActivationFacts(fixture.databasePath, [caller], [unresolved], [reference], undefined, 0);
          const resolution = yield* store.resolveStagedReferences(fixture.databasePath);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
          return {graph: yield* store.loadGraph(fixture.databasePath, snapshot.id), resolution};
        }),
      );

      expect(resumed.resolution.resolved).toBe(0);
      expect(resumed.graph.edges).toEqual([unresolved]);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('aggregates an overflowing lookup pair without truncating an exported-only match', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => materializationFixture());
      const lookupKey = 'typescript:name:highFanoutTarget';
      const caller = symbol('high-fanout-caller', 'highFanoutCaller', ['typescript:name:highFanoutCaller']);
      const candidates = Array.from({length: 10_002}, (_, index) => ({
        ...symbol(`high-fanout-${String(index).padStart(5, '0')}`, `highFanout${index}`, [lookupKey]),
        exported: index === 10_001,
      }));
      const target = candidates.at(-1)!;
      const unresolved = edge('high-fanout-edge', caller, target.name);
      const reference: CodeGraphReference = {
        edgeId: unresolved.id,
        evidencePath: fixture.file.path,
        evidenceSpan: unresolved.evidenceSpan,
        exportedOnly: true,
        lookupTiers: [[lookupKey]],
        provenance: 'syntactic',
        relation: 'calls',
        resolutionDomain: 'typescript',
        sourceId: caller.id,
        sourceName: caller.name,
        targetName: unresolved.targetName,
      };
      const snapshot = {
        ...readySnapshot(fixture.identity, candidates.length + 1, 1),
        id: 'high-fanout-lookup-fallback',
      };
      const store = yield* CodeGraphStore;
      const result = yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
            ...snapshot,
            state: 'building',
          });
          yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
          yield* store.stageActivationFacts(
            fixture.databasePath,
            [caller, ...candidates],
            [unresolved],
            [reference],
            undefined,
            0,
          );
          const resolution = yield* store.resolveStagedReferences(fixture.databasePath);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
          return {graph: yield* store.loadGraph(fixture.databasePath, snapshot.id), resolution};
        }),
      );

      expect(result.resolution.resolved).toBe(1);
      expect(result.graph.edges).toEqual([
        expect.objectContaining({provenance: 'resolved', targetId: target.id, targetName: target.name}),
      ]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('keeps an oversized direct reference edge unresolved without persisting its candidates', async () => {
    const fixture = await materializationFixture();
    const caller = symbol('oversized-reference-caller', 'oversizedReferenceCaller', [
      'typescript:name:oversizedReferenceCaller',
    ]);
    const unresolved = edge('oversized-reference-edge', caller, 'oversizedReferenceTarget');
    const reference: CodeGraphReference = {
      edgeId: unresolved.id,
      evidencePath: fixture.file.path,
      evidenceSpan: unresolved.evidenceSpan,
      lookupTiers: Array.from({length: CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM + 1}, () => [
        'typescript:name:repeatedAcrossTiers',
      ]),
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: unresolved.targetName,
    };
    const snapshot = {...readySnapshot(fixture.identity, 1, 1), id: 'oversized-reference-budget'};

    const graph = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [caller], [unresolved], [reference], undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return yield* store.loadGraph(fixture.databasePath, snapshot.id);
          }),
        );
      }),
    );

    expect(graph.edges).toEqual([unresolved]);
    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT COUNT(*) AS count FROM building_references').get()).toEqual({count: 0});
      expect(database.query('SELECT COUNT(*) AS count FROM building_reference_candidates').get()).toEqual({count: 0});
    } finally {
      database.close(false);
    }
  });

  it('checks actual compact payload bytes before parsing corrupted JSON', async () => {
    const fixture = await materializationFixture();
    const caller = symbol('corrupt-payload-caller', 'corruptPayloadCaller', ['typescript:name:corruptPayloadCaller']);
    const unresolved = edge('corrupt-payload-edge', caller, 'corruptPayloadTarget');
    const reference: CodeGraphReference = {
      edgeId: unresolved.id,
      evidencePath: fixture.file.path,
      evidenceSpan: unresolved.evidenceSpan,
      lookupTiers: [['typescript:name:corruptPayloadTarget🙂']],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: unresolved.targetName,
    };
    const snapshot = {...readySnapshot(fixture.identity, 1, 1), id: 'corrupt-reference-payload'};

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [caller], [unresolved], [reference], undefined, 0);
          }),
        );
      }),
    );
    const corrupted = new Database(fixture.databasePath, {strict: true});
    corrupted
      .query('UPDATE building_references SET lookup_tiers_json = ? WHERE snapshot_id = ?')
      .run('🙂{not-json', snapshot.id);
    corrupted.close(false);

    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
                ...snapshot,
                state: 'building',
              });
              yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
              yield* store.resolveStagedReferences(fixture.databasePath);
            }),
          );
        }),
      ),
    ).rejects.toThrow('metadata does not match its payload');
  });

  it('keeps compacted candidates isolated across interleaved worktree builds', async () => {
    const fixture = await materializationFixture();
    const secondIdentity: RepositoryIdentity = {
      ...fixture.identity,
      checkoutId: 'd'.repeat(64),
      worktreeId: 'x'.repeat(64),
    };
    const buildFacts = (suffix: string) => {
      const caller = symbol(`interleaved-caller-${suffix}`, `interleavedCaller${suffix}`, [
        `typescript:name:interleavedCaller${suffix}`,
      ]);
      const target = symbol(`interleaved-target-${suffix}`, `interleavedTarget${suffix}`, [
        `typescript:name:interleavedTarget${suffix}`,
      ]);
      const unresolved = edge('interleaved-shared-edge', caller, target.name);
      const reference: CodeGraphReference = {
        edgeId: unresolved.id,
        evidencePath: fixture.file.path,
        evidenceSpan: unresolved.evidenceSpan,
        lookupTiers: [[`typescript:name:interleavedTarget${suffix}`]],
        provenance: 'syntactic',
        relation: 'calls',
        resolutionDomain: 'typescript',
        sourceId: caller.id,
        sourceName: caller.name,
        targetName: target.name,
      };
      return {caller, reference, target, unresolved};
    };
    const first = buildFacts('A');
    const second = buildFacts('B');
    const firstSnapshot = {...readySnapshot(fixture.identity, 2, 1), id: 'interleaved-worktree-a'};
    const secondSnapshot = {...readySnapshot(secondIdentity, 2, 1), id: 'interleaved-worktree-b'};

    const stage = (identity: RepositoryIdentity, snapshot: CodeGraphSnapshot, facts: ReturnType<typeof buildFacts>) =>
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, identity, {
                ...snapshot,
                state: 'building',
              });
              yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
              yield* store.stageActivationFacts(
                fixture.databasePath,
                [facts.caller, facts.target],
                [facts.unresolved],
                [facts.reference],
                undefined,
                0,
              );
            }),
          );
        }),
      );
    await stage(fixture.identity, firstSnapshot, first);
    await stage(secondIdentity, secondSnapshot, second);

    const staged = new Database(fixture.databasePath, {readonly: true, strict: true});
    const payloads = staged
      .query(
        `SELECT snapshot_id, lookup_tiers_json
         FROM building_references
         WHERE edge_id = 'interleaved-shared-edge'
         ORDER BY snapshot_id`,
      )
      .all() as readonly {readonly lookup_tiers_json: string; readonly snapshot_id: string}[];
    const durableCandidateRows = staged.query('SELECT COUNT(*) AS count FROM building_reference_candidates').get() as {
      readonly count: number;
    };
    staged.close(false);
    expect(payloads).toEqual([
      {
        lookup_tiers_json: '[["typescript:name:interleavedTargetA"]]',
        snapshot_id: firstSnapshot.id,
      },
      {
        lookup_tiers_json: '[["typescript:name:interleavedTargetB"]]',
        snapshot_id: secondSnapshot.id,
      },
    ]);
    expect(durableCandidateRows.count).toBe(0);

    const finish = (identity: RepositoryIdentity, snapshot: CodeGraphSnapshot, facts: ReturnType<typeof buildFacts>) =>
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, identity, {
                ...snapshot,
                state: 'building',
              });
              yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
              yield* store.stageActivationFacts(
                fixture.databasePath,
                [facts.caller, facts.target],
                [facts.unresolved],
                [facts.reference],
                undefined,
                0,
              );
              yield* store.resolveStagedReferences(fixture.databasePath);
              yield* store.activateStaged(fixture.databasePath, identity, snapshot);
              return yield* store.loadGraph(fixture.databasePath, snapshot.id);
            }),
          );
        }),
      );
    const firstGraph = await finish(fixture.identity, firstSnapshot, first);
    const secondGraph = await finish(secondIdentity, secondSnapshot, second);

    const lexical = new Database(fixture.databasePath, {readonly: true, strict: true});
    const formats = lexical
      .query(
        `SELECT snapshot_id, posting_count
         FROM lexical_storage_formats
         WHERE snapshot_id IN (?, ?)
         ORDER BY snapshot_id`,
      )
      .all(firstSnapshot.id, secondSnapshot.id) as readonly {
      readonly posting_count: number;
      readonly snapshot_id: string;
    }[];
    const firstTerms = readLexicalTerms(lexical, firstSnapshot.id);
    const secondTerms = readLexicalTerms(lexical, secondSnapshot.id);
    const legacyPostings = lexical
      .query('SELECT COUNT(*) AS count FROM symbol_terms WHERE snapshot_id IN (?, ?)')
      .get(firstSnapshot.id, secondSnapshot.id) as {readonly count: number};
    lexical.close(false);

    expect(firstGraph.edges).toHaveLength(1);
    expect(firstGraph.edges[0]?.targetId).toBe(first.target.id);
    expect(secondGraph.edges).toHaveLength(1);
    expect(secondGraph.edges[0]?.targetId).toBe(second.target.id);
    expect(formats).toHaveLength(2);
    expect(formats.every(format => format.posting_count > 0)).toBe(true);
    expect(firstTerms.some(row => row.symbol_id === first.target.id)).toBe(true);
    expect(firstTerms.some(row => row.symbol_id === second.target.id)).toBe(false);
    expect(secondTerms.some(row => row.symbol_id === second.target.id)).toBe(true);
    expect(secondTerms.some(row => row.symbol_id === first.target.id)).toBe(false);
    expect(legacyPostings.count).toBe(0);
  });

  it('resumes committed direct batches across sessions and discards a caught failed build', async () => {
    const fixture = await materializationFixture();
    const original = symbol('resume-original', 'resumeOriginal', ['typescript:name:resumeOriginal']);
    const replacement = symbol('resume-replacement', 'resumeReplacement', ['typescript:name:resumeReplacement']);
    const snapshot = readySnapshot(fixture.identity, 1, 0);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [original], [], [], undefined, 0);
          }),
        );
      }),
    );

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const resumedOwnerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              {
                ...snapshot,
                state: 'building',
              },
            );
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, resumedOwnerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [original], [], [], undefined, 0);
            const resumedCounts = yield* store.stagedFactCounts(fixture.databasePath);
            const sql = yield* SqlClient.SqlClient;
            const resumedLexicalCounters = yield* sql<{
              readonly completed_batch_count: number;
              readonly posting_count: number;
              readonly symbol_count: number;
              readonly term_count: number;
            }>`
              SELECT completed_batch_count, posting_count, symbol_count, term_count
              FROM building_lexical_counters WHERE snapshot_id = ${snapshot.id}
            `;
            const mismatch = yield* store
              .stageActivationFacts(fixture.databasePath, [replacement], [], [], undefined, 0)
              .pipe(
                Effect.as(undefined),
                Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
              );
            yield* store.markFailed(
              fixture.databasePath,
              snapshot.id,
              mismatch ?? 'expected mismatch',
              resumedOwnerToken,
            );
            const replacementOwnerToken = yield* claimPersistentBuildForTest(
              store,
              fixture.databasePath,
              fixture.identity,
              {
                ...snapshot,
                state: 'building',
              },
            );
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, replacementOwnerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [replacement], [], [], undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              mismatch,
              resumedCounts,
              resumedLexicalCounters,
            };
          }),
        );
      }),
    );

    expect(result.resumedCounts).toEqual({edges: 0, symbols: 1});
    expect(result.resumedLexicalCounters).toEqual([
      expect.objectContaining({completed_batch_count: 1, symbol_count: 1}),
    ]);
    expect(result.mismatch).toContain('batch contents changed');
    expect(result.graph.symbols.map(entry => entry.id)).toEqual([replacement.id]);
    const lexical = new Database(fixture.databasePath, {readonly: true, strict: true});
    const receipt = lexical
      .query('SELECT posting_count, symbol_count FROM lexical_storage_formats WHERE snapshot_id = ?')
      .get(snapshot.id) as {readonly posting_count: number; readonly symbol_count: number};
    const terms = readLexicalTerms(lexical, snapshot.id);
    const legacyRows = lexical
      .query('SELECT COUNT(*) AS count FROM symbol_terms WHERE snapshot_id = ?')
      .get(snapshot.id) as {readonly count: number};
    const auditStatement = codeGraphCompactLexicalDeepAuditStatement(snapshot.id);
    const deepAudit = lexical.query(auditStatement.text).get(...auditStatement.parameters) as {
      readonly expected_posting_count: number;
      readonly expected_symbol_count: number;
      readonly expected_term_count: number;
      readonly posting_count: number;
      readonly symbol_count: number;
      readonly term_count: number;
    };
    lexical.close(false);
    expect(receipt).toMatchObject({posting_count: terms.length, symbol_count: 1});
    expect(new Set(terms.map(row => row.symbol_id))).toEqual(new Set([replacement.id]));
    expect(legacyRows.count).toBe(0);
    expect(deepAudit).toMatchObject({
      posting_count: deepAudit.expected_posting_count,
      symbol_count: deepAudit.expected_symbol_count,
      term_count: deepAudit.expected_term_count,
    });
  });

  effectIt.effect('retires and rebuilds a same-identity ready snapshot whose compact receipt is missing', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(materializationFixture);
        const writerLockPath = join(fixture.root, 'same-identity-writer.lock');
        const original = symbol('same-id-original', 'sameIdOriginal', ['typescript:name:sameIdOriginal']);
        const replacement = symbol('same-id-replacement', 'sameIdReplacement', ['typescript:name:sameIdReplacement']);
        const snapshot = {...readySnapshot(fixture.identity, 1, 0), id: testSnapshotId(101)};

        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [original], [], [], undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            yield* store.promote(fixture.databasePath, fixture.identity, snapshot.id);
          }),
          {writerLockPath},
        );

        const damaged = new Database(fixture.databasePath, {strict: true});
        damaged.query('DELETE FROM lexical_storage_formats WHERE snapshot_id = ?').run(snapshot.id);
        damaged.close(false);

        const literalReady = yield* store.readySnapshotById(fixture.databasePath, snapshot.id);
        const reusableReady = yield* store.currentLexicalReadySnapshotById(fixture.databasePath, snapshot.id);
        const rebuilt = yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [replacement], [], [], undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            yield* store.promote(fixture.databasePath, fixture.identity, snapshot.id);
            return {
              active: yield* store.readySnapshot(fixture.databasePath, fixture.identity.worktreeId),
              current: yield* store.currentLexicalReadySnapshotById(fixture.databasePath, snapshot.id),
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              literalReady,
              reusableReady,
            };
          }),
          {writerLockPath},
        );

        expect(rebuilt.literalReady?.id).toBe(snapshot.id);
        expect(rebuilt.reusableReady).toBeUndefined();
        expect(rebuilt.current?.id).toBe(snapshot.id);
        expect(rebuilt.active?.id).toBe(snapshot.id);
        expect(rebuilt.graph.symbols.map(entry => entry.id)).toEqual([replacement.id]);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('reclaims a deterministic snapshot retired at the failure-cleanup crash boundary', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const stale = symbol('crash-boundary-stale', 'crashBoundaryStale', ['typescript:name:crashBoundaryStale']);
      const replacement = symbol('crash-boundary-replacement', 'crashBoundaryReplacement', [
        'typescript:name:crashBoundaryReplacement',
      ]);
      const snapshot = {...readySnapshot(fixture.identity, 1, 0), id: testSnapshotId(102)};

      const store = yield* CodeGraphStore;
      yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
            ...snapshot,
            state: 'building',
          });
          yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
          yield* store.stageActivationFacts(fixture.databasePath, [stale], [], [], undefined, 0);
        }),
      );

      const interrupted = new Database(fixture.databasePath, {strict: true});
      interrupted.transaction(() => {
        const compact = interrupted
          .query('SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ?')
          .get(snapshot.id) as {readonly snapshot_key: number};
        const compactSymbol = interrupted
          .query('SELECT symbol_key FROM lexical_compact_symbols WHERE snapshot_key = ? LIMIT 1')
          .get(compact.snapshot_key) as {readonly symbol_key: number};
        interrupted
          .query(
            `WITH RECURSIVE sequence(value) AS (
             SELECT 0
             UNION ALL
             SELECT value + 1 FROM sequence WHERE value < 6000
           )
           INSERT INTO lexical_compact_terms (snapshot_key, term)
           SELECT ?, 'cleanup-extra-' || printf('%05d', value) FROM sequence`,
          )
          .run(compact.snapshot_key);
        interrupted
          .query(
            `INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
           SELECT ?, term_key, ?, 1
           FROM lexical_compact_terms
           WHERE snapshot_key = ? AND term LIKE 'cleanup-extra-%'`,
          )
          .run(compact.snapshot_key, compactSymbol.symbol_key, compact.snapshot_key);
        interrupted
          .query("UPDATE snapshots SET state = 'retired' WHERE id = ? AND state = 'building'")
          .run(snapshot.id);
        interrupted.query('DELETE FROM snapshot_build_owners WHERE snapshot_id = ?').run(snapshot.id);
        interrupted.exec(`
        CREATE TRIGGER reject_compact_snapshot_cascade
        BEFORE DELETE ON lexical_compact_snapshots
        WHEN OLD.snapshot_id = '${snapshot.id}' AND EXISTS (
          SELECT 1 FROM lexical_compact_postings AS posting
          WHERE posting.snapshot_key = OLD.snapshot_key
        )
        BEGIN
          SELECT RAISE(ABORT, 'compact children must be paged before snapshot deletion');
        END
      `);
      })();
      const retiredState = interrupted.query('SELECT state FROM snapshots WHERE id = ?').get(snapshot.id) as {
        readonly state: string;
      };
      const staleRows = interrupted
        .query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
        .get(snapshot.id) as {readonly count: number};
      const stalePostings = interrupted
        .query(
          `SELECT COUNT(*) AS count
         FROM lexical_compact_postings AS posting
         JOIN lexical_compact_snapshots AS compact ON compact.snapshot_key = posting.snapshot_key
         WHERE compact.snapshot_id = ?`,
        )
        .get(snapshot.id) as {readonly count: number};
      interrupted.close(false);
      expect(retiredState.state).toBe('retired');
      expect(staleRows.count).toBe(1);
      expect(stalePostings.count).toBeGreaterThan(5_000);

      const graph = yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
            ...snapshot,
            state: 'building',
          });
          yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
          yield* store.stageActivationFacts(fixture.databasePath, [replacement], [], [], undefined, 0);
          yield* store.resolveStagedReferences(fixture.databasePath);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
          return yield* store.loadGraph(fixture.databasePath, snapshot.id);
        }),
      );

      expect(graph.snapshot.state).toBe('ready');
      expect(graph.symbols.map(entry => entry.id)).toEqual([replacement.id]);
      expect(graph.symbols.some(entry => entry.id === stale.id)).toBe(false);
      const storage = new Database(fixture.databasePath, {readonly: true, strict: true});
      const freelist = storage.query('PRAGMA freelist_count').get() as {readonly freelist_count: number};
      const pages = storage.query('PRAGMA page_count').get() as {readonly page_count: number};
      storage.close(false);
      // Logical reclamation stays bounded; physical file compaction remains an
      // explicit, disk-preflighted `graph compact` operation.
      expect(freelist.freelist_count).toBeGreaterThan(0);
      expect(pages.page_count).toBeGreaterThan(freelist.freelist_count);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('keeps interrupted logical plans compatible across grouped transactions and resumes deterministically', async () => {
    const interruptedFixture = await materializationFixture();
    const referenceFixture = await materializationFixture();
    const secondFile: CodeGraphInventoryFile = {
      ...interruptedFixture.file,
      blobId: 'd'.repeat(40),
      contentHash: 'i'.repeat(64),
      path: 'src/materialization-second.ts',
    };
    const files = [interruptedFixture.file, secondFile] as const;
    const rawFacts = files.map((file, index): CodeGraphFileFacts => {
      const owner = {
        ...symbol(`attributed-owner-${index}`, `attributedOwner${index}`, [`typescript:name:attributedOwner${index}`]),
        contentHash: file.contentHash,
        path: file.path,
        qualifiedName: `${file.path}#attributedOwner${index}`,
        span: {column: 1, endColumn: 1, endLine: 3, line: 1},
      } satisfies CodeGraphSymbol;
      return {
        derivationInputs: {
          rationale: [
            {
              documentation: `attributed-rationale-${index}-${'x'.repeat(2_150_000)}`,
              line: 2,
              marker: 'WHY',
              name: `WHY-${index}`,
            },
          ],
        },
        diagnostics: [],
        edges: [],
        path: file.path,
        symbols: [owner],
      };
    });
    const rawBytesByPath = new Map(rawFacts.map(fact => [fact.path, cachedCodeGraphFactBytes(fact)]));
    const attributed = createCachedCodeGraphFactsAttributor(
      files,
      discoverManifestWorkspace(files),
    )(rawFacts.map((fact, index) => augmentRationaleFacts(files[index], fact)));
    const finalBatches = finalCodeGraphFactBatches(attributed);
    const stagedBatches = finalBatches.map(batch => ({
      edges: batch.flatMap(value => value.facts.edges),
      references: batch.flatMap(value => value.facts.references ?? []),
      symbols: batch.flatMap(value => value.facts.symbols),
    }));
    const symbolCount = stagedBatches.reduce((total, batch) => total + batch.symbols.length, 0);
    const edgeCount = stagedBatches.reduce((total, batch) => total + batch.edges.length, 0);
    const snapshot: CodeGraphSnapshot = {
      ...readySnapshot(interruptedFixture.identity, symbolCount, edgeCount),
      fileCount: files.length,
      id: 'attributed-sub-batch-resume',
    };

    expect(factMaterializationBatches(files, rawBytesByPath)).toHaveLength(1);
    expect(finalBatches).toHaveLength(2);
    expect(finalBatches.flat().map(value => value.facts.path)).toEqual(files.map(file => file.path));
    expect(
      finalBatches.every(
        batch => batch.reduce((total, value) => total + value.bytes, 0) <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
      ),
    ).toBe(true);

    const interrupted = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          interruptedFixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(
              store,
              interruptedFixture.databasePath,
              interruptedFixture.identity,
              {
                ...snapshot,
                state: 'building',
              },
            );
            yield* store.prepareActivation(
              interruptedFixture.databasePath,
              files,
              snapshot.id,
              stagedBatches.length,
              ownerToken,
            );
            const first = stagedBatches[0];
            yield* store.stageActivationFacts(
              interruptedFixture.databasePath,
              first.symbols,
              first.edges,
              first.references,
              undefined,
              0,
            );
            const partialSnapshot: CodeGraphSnapshot = {
              ...snapshot,
              edgeCount: first.edges.length,
              symbolCount: first.symbols.length,
            };
            return yield* store
              .activateStaged(interruptedFixture.databasePath, interruptedFixture.identity, partialSnapshot)
              .pipe(
                Effect.as('unexpected success'),
                Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
              );
          }),
        );
      }),
    );

    const interruptedDatabase = new Database(interruptedFixture.databasePath, {readonly: true, strict: true});
    const interruptedState = interruptedDatabase
      .query(
        `SELECT snapshot.state, owner.expected_batch_count,
           (SELECT COUNT(*) FROM building_materialization_batches WHERE snapshot_id = snapshot.id) AS receipts
         FROM snapshots AS snapshot
         JOIN snapshot_build_owners AS owner ON owner.snapshot_id = snapshot.id
         WHERE snapshot.id = ?`,
      )
      .get(snapshot.id) as {readonly expected_batch_count: number; readonly receipts: number; readonly state: string};
    interruptedDatabase.close(false);

    expect(interrupted).toContain('incomplete batch receipts');
    expect(interruptedState).toEqual({expected_batch_count: 2, receipts: 1, state: 'building'});

    const mismatchedTakeover = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          interruptedFixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(
              store,
              interruptedFixture.databasePath,
              interruptedFixture.identity,
              {
                ...snapshot,
                state: 'building',
              },
            );
            return yield* store
              .prepareActivation(
                interruptedFixture.databasePath,
                files,
                snapshot.id,
                stagedBatches.length + 1,
                ownerToken,
              )
              .pipe(
                Effect.as('unexpected success'),
                Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
              );
          }),
        );
      }),
    );
    expect(mismatchedTakeover).toContain('materialization plan changed');

    const progressByDatabase = new Map<
      string,
      {readonly batchIndex: number; readonly rows: number; readonly stage: string}[]
    >();
    const build = (fixture: Awaited<ReturnType<typeof materializationFixture>>) =>
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
                ...snapshot,
                state: 'building',
              });
              yield* store.prepareActivation(
                fixture.databasePath,
                files,
                snapshot.id,
                stagedBatches.length,
                ownerToken,
              );
              yield* store.stageActivationFactBatches(
                fixture.databasePath,
                stagedBatches.map((batch, batchIndex) => ({batchIndex, ...batch})),
                (batchIndex, progress) =>
                  Effect.sync(() => {
                    const events = progressByDatabase.get(fixture.databasePath) ?? [];
                    events.push({batchIndex, rows: progress.rowsCompleted, stage: progress.stage});
                    progressByDatabase.set(fixture.databasePath, events);
                  }),
              );
              yield* store.resolveStagedReferences(fixture.databasePath);
              yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
              return yield* store.loadGraph(fixture.databasePath, snapshot.id);
            }),
          );
        }),
      );

    const [resumed, reference] = await Promise.all([build(interruptedFixture), build(referenceFixture)]);
    const resumedEvidence = persistentGraphEvidence(interruptedFixture.databasePath, snapshot.id);
    const referenceEvidence = persistentGraphEvidence(referenceFixture.databasePath, snapshot.id);

    expect(resumed.symbols).toEqual(reference.symbols);
    expect(resumed.edges).toEqual(reference.edges);
    expect(resumedEvidence).toEqual(referenceEvidence);
    expect(resumedEvidence.files).toBe(files.length);
    expect(resumedEvidence.distinctFiles).toBe(files.length);
    expect(new Set(resumed.symbols.map(value => value.id)).size).toBe(symbolCount);
    expect(new Set(resumed.edges.map(value => value.id)).size).toBe(edgeCount);
    const resumeProgress = progressByDatabase.get(interruptedFixture.databasePath) ?? [];
    expect(resumeProgress.filter(event => event.stage === 'committing').map(event => event.batchIndex)).toEqual([1]);
    expect(resumeProgress.filter(event => event.stage === 'committed').map(event => event.batchIndex)).toEqual([1]);
    expect(
      resumeProgress.some(
        event =>
          event.batchIndex === 1 && event.stage !== 'committed' && event.stage !== 'committing' && event.rows > 0,
      ),
    ).toBe(true);
  }, 30_000);

  it('prevents a replaced persistent owner from staging, activating, or failing the new owner build', async () => {
    const fixture = await materializationFixture();
    const writerLockPath = join(fixture.root, 'checkout-writer.lock');
    const staleSymbol = symbol('stale-owner', 'staleOwner', ['typescript:name:staleOwner']);
    const replacementSymbol = symbol('replacement-owner', 'replacementOwner', ['typescript:name:replacementOwner']);
    const snapshot = readySnapshot(fixture.identity, 1, 0);
    let announceStalePrepared!: () => void;
    const stalePrepared = new Promise<void>(resolve => {
      announceStalePrepared = resolve;
    });
    let announceReplacementClaimed!: () => void;
    const replacementClaimed = new Promise<void>(resolve => {
      announceReplacementClaimed = resolve;
    });
    let announceStaleAttemptsComplete!: () => void;
    const staleAttemptsComplete = new Promise<void>(resolve => {
      announceStaleAttemptsComplete = resolve;
    });
    let replacementOwnerToken = '';

    const staleOwner = runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const staleOwnerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, staleOwnerToken);
            announceStalePrepared();
            yield* Effect.promise(() => replacementClaimed);
            const stageFailure = yield* store
              .stageActivationFacts(fixture.databasePath, [staleSymbol], [], [], undefined, 0)
              .pipe(
                Effect.as('unexpected success'),
                Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
              );
            const activationFailure = yield* store
              .activateStaged(fixture.databasePath, fixture.identity, snapshot)
              .pipe(
                Effect.as('unexpected success'),
                Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
              );
            yield* store.markFailed(fixture.databasePath, snapshot.id, 'stale owner must not win', staleOwnerToken);
            const ownership = yield* Effect.sync(() => {
              const database = new Database(fixture.databasePath, {readonly: true, strict: true});
              const row = database
                .query(
                  `SELECT snapshot.state, snapshot.failure_summary, owner.owner_token
                   FROM snapshots AS snapshot
                   JOIN snapshot_build_owners AS owner ON owner.snapshot_id = snapshot.id
                   WHERE snapshot.id = ?`,
                )
                .get(snapshot.id) as {
                readonly failure_summary: unknown;
                readonly owner_token: string;
                readonly state: string;
              };
              database.close(false);
              return row;
            });
            announceStaleAttemptsComplete();
            return {activationFailure, ownership, stageFailure};
          }),
          {writerLockPath},
        );
      }),
    );

    await stalePrepared;
    const replacementOwner = runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            replacementOwnerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, replacementOwnerToken);
            announceReplacementClaimed();
            yield* Effect.promise(() => staleAttemptsComplete);
            yield* store.stageActivationFacts(fixture.databasePath, [replacementSymbol], [], [], undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return yield* store.loadGraph(fixture.databasePath, snapshot.id);
          }),
          {writerLockPath},
        );
      }),
    );

    const [staleResult, graph] = await Promise.all([staleOwner, replacementOwner]);
    expect(staleResult.stageFailure).toContain('ownership changed');
    expect(staleResult.activationFailure).toContain('ownership changed');
    expect(staleResult.ownership).toEqual({
      failure_summary: null,
      owner_token: replacementOwnerToken,
      state: 'building',
    });
    expect(graph.snapshot.state).toBe('ready');
    expect(graph.symbols.map(entry => entry.id)).toEqual([replacementSymbol.id]);
  });

  it('fences a replaced persistent owner between resolution pages before any durable mutation', async () => {
    const fixture = await materializationFixture();
    const writerLockPath = join(fixture.root, 'checkout-writer.lock');
    const target = symbol('resolution-owner-target', 'resolutionOwnerTarget', [
      'typescript:name:resolutionOwnerTarget',
    ]);
    // Persistent full builds deliberately use a 5,000-reference page to
    // amortize durable SQLite transaction overhead. Keep this owner-fencing
    // fixture one row beyond that boundary so replacement is still exercised
    // between two production-shaped bulk pages.
    const callers = Array.from({length: 5_001}, (_, index) => {
      const suffix = String(index).padStart(4, '0');
      return symbol(`resolution-owner-caller-${suffix}`, `resolutionOwnerCaller${suffix}`, [
        `typescript:name:resolutionOwnerCaller${suffix}`,
      ]);
    });
    const unresolved = callers.map((caller, index) =>
      edge(`resolution-owner-edge-${String(index).padStart(4, '0')}`, caller, target.name),
    );
    const references = unresolved.map<CodeGraphReference>((candidate, index) => ({
      aliasLookupKeys: [`typescript:name:resolutionOwnerAlias${String(index).padStart(4, '0')}`],
      edgeId: candidate.id,
      evidencePath: fixture.file.path,
      evidenceSpan: candidate.evidenceSpan,
      lookupTiers: [['typescript:name:resolutionOwnerTarget']],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: callers[index].id,
      sourceName: callers[index].name,
      targetName: target.name,
    }));
    const snapshot = readySnapshot(fixture.identity, callers.length + 1, unresolved.length);
    let announceFirstPage!: () => void;
    const firstPage = new Promise<void>(resolve => {
      announceFirstPage = resolve;
    });
    let announceReplacementPrepared!: () => void;
    const replacementPrepared = new Promise<void>(resolve => {
      announceReplacementPrepared = resolve;
    });
    let announceStaleAttemptComplete!: () => void;
    const staleAttemptComplete = new Promise<void>(resolve => {
      announceStaleAttemptComplete = resolve;
    });
    let paused = false;

    const staleOwner = runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [target, ...callers],
              unresolved,
              references,
              undefined,
              0,
            );
            const resolutionFailure = yield* store
              .resolveStagedReferences(fixture.databasePath, progress =>
                Effect.gen(function* () {
                  if (!paused && progress.pagesCompleted === 1) {
                    paused = true;
                    announceFirstPage();
                    yield* Effect.promise(() => replacementPrepared);
                  }
                }),
              )
              .pipe(
                Effect.as('unexpected success'),
                Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
              );
            announceStaleAttemptComplete();
            return resolutionFailure;
          }),
          {writerLockPath},
        );
      }),
    );

    await firstPage;
    const replacementOwner = runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            const beforeStalePage = yield* Effect.sync(() =>
              readPersistentResolutionState(fixture.databasePath, snapshot.id),
            );
            announceReplacementPrepared();
            yield* Effect.promise(() => staleAttemptComplete);
            const afterStalePage = yield* Effect.sync(() =>
              readPersistentResolutionState(fixture.databasePath, snapshot.id),
            );
            const resolution = yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              afterStalePage,
              beforeStalePage,
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              resolution,
            };
          }),
          {writerLockPath},
        );
      }),
    );

    const [staleFailure, replacementResult] = await Promise.all([staleOwner, replacementOwner]);
    expect(staleFailure).toContain('ownership changed');
    expect(replacementResult.afterStalePage).toBe(replacementResult.beforeStalePage);
    expect(replacementResult.resolution.resolved).toBe(1);
    expect(replacementResult.graph.snapshot.state).toBe('ready');
    expect(replacementResult.graph.edges).toHaveLength(unresolved.length);
    expect(replacementResult.graph.edges.every(candidate => candidate.targetId === target.id)).toBe(true);
  });

  it('purges durable terms before replacing a failed snapshot without a symbol-first index', async () => {
    const fixture = await materializationFixture();
    const stale = symbol('stale', 'obsolete', ['typescript:name:obsolete']);
    const replacement = symbol('replacement', 'replacement', ['typescript:name:replacement']);
    const snapshot = readySnapshot(fixture.identity, 1, 0);

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [stale], [], [], undefined, 0);
            yield* store.markFailed(fixture.databasePath, snapshot.id, 'replace this committed build', ownerToken);

            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [replacement], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              replacementSearch: yield* store.searchSymbols(fixture.databasePath, snapshot.id, replacement.name, 10),
              staleSearch: yield* store.searchSymbols(fixture.databasePath, snapshot.id, stale.name, 10),
            };
          }),
        );
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    const termOwners = [...new Set(readLexicalTerms(database, snapshot.id).map(row => row.symbol_id))].sort();
    const foreignKeyViolations = database.query('PRAGMA foreign_key_check').all();
    const indexes = database.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as readonly {
      readonly name: string;
    }[];
    database.close(false);

    expect(result.graph.symbols).toEqual([replacement]);
    expect(result.replacementSearch.map(node => node.id)).toEqual([replacement.id]);
    expect(result.staleSearch).toEqual([]);
    expect(termOwners).toEqual([replacement.id]);
    expect(foreignKeyViolations).toEqual([]);
    expect(indexes.map(index => index.name)).not.toContain('terms_symbol');
  });

  it('produces the same resolved graph through direct and legacy full materialization', async () => {
    const directFixture = await materializationFixture();
    const legacyFixture = await materializationFixture();
    const caller = symbol('parity-caller', 'parityCaller', ['typescript:name:parityCaller']);
    const target = symbol('parity-target', 'parityTarget', ['typescript:name:parityTarget']);
    const unresolved = edge('parity-edge', caller, target.name);
    const reference: CodeGraphReference = {
      edgeId: unresolved.id,
      evidencePath: directFixture.file.path,
      evidenceSpan: unresolved.evidenceSpan,
      lookupTiers: [['typescript:name:parityTarget']],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: target.name,
    };

    const build = (fixture: Awaited<ReturnType<typeof materializationFixture>>, direct: boolean) =>
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              const snapshot = readySnapshot(fixture.identity, 2, 1);
              let ownerToken: string | undefined;
              if (direct) {
                ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
                  ...snapshot,
                  state: 'building',
                });
              }
              yield* store.prepareActivation(
                fixture.databasePath,
                [fixture.file],
                direct ? snapshot.id : undefined,
                direct ? 1 : undefined,
                ownerToken,
              );
              yield* store.stageActivationFacts(
                fixture.databasePath,
                [caller, target],
                [unresolved],
                [reference],
                undefined,
                0,
              );
              yield* store.resolveStagedReferences(fixture.databasePath);
              yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
              yield* store.ensureAnalysisSummary(fixture.databasePath, snapshot.id);
              return {
                graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
                search: yield* store.searchSymbols(fixture.databasePath, snapshot.id, 'parity caller target', 10),
                summary: Option.getOrThrow(yield* store.loadAnalysisSummary(fixture.databasePath, snapshot.id)),
              };
            }),
          );
        }),
      );

    const [direct, legacy] = await Promise.all([build(directFixture, true), build(legacyFixture, false)]);
    expect(direct.graph.symbols).toEqual(legacy.graph.symbols);
    expect(direct.graph.edges).toEqual(legacy.graph.edges);
    expect(direct.search).toEqual(legacy.search);
    expect(direct.summary.digest).toBe(legacy.summary.digest);
  });

  it('reports actual changed and deleted rows while activating a base-backed full overlay', async () => {
    const fixture = await materializationFixture();
    const baseSymbol = symbol('overlay-base-symbol', 'overlayBaseSymbol', ['typescript:name:overlayBaseSymbol']);
    const replacementSymbol = symbol('overlay-current-symbol', 'overlayCurrentSymbol', [
      'typescript:name:overlayCurrentSymbol',
    ]);
    const baseEdge = {
      ...edge('overlay-base-edge', baseSymbol, baseSymbol.name),
      targetId: baseSymbol.id,
    } satisfies CodeGraphEdge;
    const replacementEdge = {
      ...edge('overlay-current-edge', replacementSymbol, replacementSymbol.name),
      targetId: replacementSymbol.id,
    } satisfies CodeGraphEdge;
    const baseSnapshot: CodeGraphSnapshot = {
      ...readySnapshot(fixture.identity, 1, 1),
      id: 'overlay-telemetry-base',
    };
    const overlaySnapshot: CodeGraphSnapshot = {
      ...readySnapshot(fixture.identity, 1, 1),
      baseSnapshotId: baseSnapshot.id,
      dirty: true,
      id: 'overlay-telemetry-current',
      overlayFingerprint: 'overlay-telemetry-fingerprint',
    };
    const overlayFile: CodeGraphInventoryFile = {
      ...fixture.file,
      contentHash: 'o'.repeat(64),
      source: 'worktree',
    };
    const activation: CodeGraphActivationProgress[] = [];

    const graph = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [baseSymbol], [baseEdge]);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, baseSnapshot);

            yield* store.prepareActivation(fixture.databasePath, [overlayFile]);
            yield* store.stageActivationFacts(fixture.databasePath, [replacementSymbol], [replacementEdge]);
            yield* store.activateStaged(
              fixture.databasePath,
              fixture.identity,
              overlaySnapshot,
              undefined,
              undefined,
              progress => Effect.sync(() => activation.push(progress)),
            );
            return yield* store.loadGraph(fixture.databasePath, overlaySnapshot.id);
          }),
        );
      }),
    );

    const completedRows = new Map(
      activation
        .filter(progress => progress.state === 'completed')
        .map(progress => [progress.stage, progress.rows] as const),
    );
    expect(completedRows.get('copying-files')).toBe(1);
    expect(completedRows.get('copying-symbols')).toBe(2);
    expect(completedRows.get('copying-terms')).toBeGreaterThan(0);
    expect(completedRows.get('copying-edges')).toBe(2);
    expect(graph.symbols.map(value => value.id)).toEqual([replacementSymbol.id]);
    expect(graph.edges.map(value => value.id)).toEqual([replacementEdge.id]);
  });

  it('reports bounded staging progress and resolves references without a lookup-key-first candidate index', async () => {
    const fixture = await materializationFixture();
    const activation: CodeGraphActivationProgress[] = [];
    const observations: CodeGraphStagingProgress[] = [];
    const caller = symbol('caller', 'caller', ['typescript:name:caller']);
    const target = symbol('target', 'target', ['typescript:name:target']);
    const unresolved = edge('unresolved-call', caller, 'target');
    const reference: CodeGraphReference = {
      edgeId: unresolved.id,
      evidencePath: fixture.file.path,
      evidenceSpan: unresolved.evidenceSpan,
      lookupTiers: [['typescript:name:target']],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: target.name,
    };

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [target, caller],
              [unresolved],
              [reference],
              progress => Effect.sync(() => observations.push(progress)),
            );
            const resolution = yield* store.resolveStagedReferences(fixture.databasePath);
            const counts = yield* store.stagedFactCounts(fixture.databasePath);
            const snapshot = readySnapshot(fixture.identity, counts.symbols, counts.edges);
            yield* store.activateStaged(
              fixture.databasePath,
              fixture.identity,
              snapshot,
              undefined,
              undefined,
              progress => Effect.sync(() => activation.push(progress)),
            );
            return {
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              resolution,
              search: yield* store.searchSymbols(fixture.databasePath, snapshot.id, 'target caller', 10),
            };
          }),
        );
      }),
    );

    expect(result.resolution.resolved).toBe(1);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.edges[0]).toMatchObject({sourceId: caller.id, targetId: target.id});
    expect(result.search.map(node => ({id: node.id, score: node.score}))).toEqual([
      {id: caller.id, score: 0.05},
      {id: target.id, score: 0.05},
    ]);
    expect(observations.at(-1)?.stage).toBe('committed');
    expect(
      observations.some(progress => progress.stage === 'reference-candidates' && progress.rowsCompleted === 1),
    ).toBe(true);
    expect(observations.some(progress => (progress.temporaryDatabaseBytes ?? 0) > 0)).toBe(true);
    expect(observations.every(progress => progress.elapsedMilliseconds >= 0)).toBe(true);
    expect(activation.filter(progress => progress.state === 'completed').map(progress => progress.stage)).toEqual([
      'validating-input',
      'copying-workspace',
      'copying-files',
      'copying-symbols',
      'copying-terms',
      'copying-edges',
      'recording-completion',
      'committing-snapshot',
      'checkpointing-snapshot',
    ]);
    expect(activation.every(progress => progress.elapsedMilliseconds >= progress.stageElapsedMilliseconds)).toBe(true);
    expect(
      activation.some(
        progress => progress.stage === 'validating-input' && progress.state === 'progress' && progress.rows === 1,
      ),
    ).toBe(true);
    expect(
      activation.find(progress => progress.stage === 'copying-symbols' && progress.state === 'completed')?.rows,
    ).toBe(2);
    expect(
      activation.some(
        progress =>
          progress.stage === 'copying-symbols' &&
          progress.state === 'progress' &&
          progress.rows === 2 &&
          (progress.transactionMilliseconds ?? 0) > 0,
      ),
    ).toBe(true);

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    const indexes = database.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as readonly {
      readonly name: string;
    }[];
    const lookupPlan = database
      .query(
        `EXPLAIN QUERY PLAN
         SELECT symbol_id FROM snapshot_symbol_lookup
         WHERE snapshot_id = ? AND lookup_key = ? AND resolution_domain = ? AND exported = 1`,
      )
      .all(result.graph.snapshot.id, 'typescript:name:target', 'typescript') as readonly {readonly detail: string}[];
    const rankedTerms = codeGraphTermCandidateQueryStatement(
      result.graph.snapshot.id,
      undefined,
      ['target', 'direct', 'caller'],
      100,
    );
    const rankedTermPlan = database
      .query(`EXPLAIN QUERY PLAN ${rankedTerms.text}`)
      .all(...rankedTerms.parameters) as readonly {readonly detail: string}[];
    database.close(false);
    expect(indexes.map(index => index.name)).not.toContain('snapshot_symbol_lookup_key');
    expect(indexes.map(index => index.name)).not.toContain('terms_lookup');
    expect(indexes.map(index => index.name)).not.toContain('terms_symbol');
    expect(lookupPlan.some(row => /PRIMARY KEY.*snapshot_id=.*lookup_key=/i.test(row.detail))).toBe(true);
    expect(
      rankedTermPlan.some(row =>
        /SEARCH current_compact_terms USING COVERING INDEX .*snapshot_key=.*term=/i.test(row.detail),
      ),
    ).toBe(true);
    expect(
      rankedTermPlan.some(
        row => row.detail.includes('current_compact_postings') && row.detail.includes('USING PRIMARY KEY'),
      ),
    ).toBe(true);
    expect(
      rankedTermPlan
        .filter(row => /SEARCH (?:current|base)_legacy_terms/i.test(row.detail))
        .every(row => /PRIMARY KEY.*snapshot_id=.*term=/i.test(row.detail)),
    ).toBe(true);
    expect(rankedTermPlan.every(row => !/terms_symbol/i.test(row.detail))).toBe(true);
  });

  effectIt.effect('prefers an implementation symbol over test and documentation copies of the same product name', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const registration = {
        ...symbol('registration', 'recall_context', ['typescript:name:recall_context']),
        path: 'apps/threadnote/src/mcp/server/index.ts',
      };
      const testLocal = {
        ...symbol('test-local', 'recall_context', ['typescript:name:recall_context']),
        path: 'apps/threadnote/test/integration/mcp.native-tools.test.ts',
      };
      const heading = {
        ...symbol('agent-heading', 'recall_context', ['typescript:name:recall_context']),
        path: 'AGENTS.md',
      };

      const store = yield* CodeGraphStore;
      const search = yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [heading, testLocal, registration], []);
          const snapshot = readySnapshot(fixture.identity, 3, 0);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
          return yield* store.searchSymbols(fixture.databasePath, snapshot.id, 'recall_context', 10);
        }),
      );

      expect(search.map(node => node.path)).toEqual([
        'apps/threadnote/src/mcp/server/index.ts',
        'apps/threadnote/test/integration/mcp.native-tools.test.ts',
        'AGENTS.md',
      ]);
      expect(search[0]?.score).toBe(1);
      expect(search[0]?.score).toBeGreaterThan(search[1].score);
      expect(search[1]?.score).toBeGreaterThan(search[2].score);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('keeps test symbols undemoted when the query asks for a test path', async () => {
    const fixture = await materializationFixture();
    const registration = {
      ...symbol('registration', 'recall_context', ['typescript:name:recall_context']),
      path: 'apps/threadnote/src/mcp/server/index.ts',
    };
    const testLocal = {
      ...symbol('test-local', 'recall_context', ['typescript:name:recall_context']),
      path: 'apps/threadnote/test/integration/mcp.native-tools.test.ts',
    };

    const search = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [testLocal, registration], []);
            const snapshot = readySnapshot(fixture.identity, 2, 0);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return yield* store.searchSymbols(fixture.databasePath, snapshot.id, 'recall_context test', 10);
          }),
        );
      }),
    );

    expect(search.map(node => node.path)).toEqual([
      'apps/threadnote/test/integration/mcp.native-tools.test.ts',
      'apps/threadnote/src/mcp/server/index.ts',
    ]);
  });

  it('ranks a production side-effect owner ahead of lexical state and test matches', async () => {
    const fixture = await materializationFixture();
    const owner = {...symbol('owner', 'clearAllTabs', []), path: 'src/TabsStore.ts'};
    const state = {...symbol('state', 'tabs', []), kind: 'property', path: 'src/TabsState.ts'};
    const testCopy = {...symbol('test-copy', 'clearAllTabs', []), path: 'test/TabsStore.test.ts'};

    const search = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [state, testCopy, owner], []);
            const snapshot = readySnapshot(fixture.identity, 3, 0);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return yield* store.searchSymbols(fixture.databasePath, snapshot.id, 'tabs', 10);
          }),
        );
      }),
    );

    expect(search.map(node => node.id)).toEqual(['owner', 'state', 'test-copy']);
  });

  it('fails fast on duplicate full-build IDs without replacing already staged facts', async () => {
    const fixture = await materializationFixture();
    const original = symbol('stable-id', 'original', ['typescript:name:original']);
    const duplicate = {...original, name: 'replacement', qualifiedName: 'replacement'};

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [original], []);
            const duplicateFailure = yield* store.stageActivationFacts(fixture.databasePath, [duplicate], []).pipe(
              Effect.as(undefined),
              Effect.catch(cause => Effect.succeed(observedStoreFailure(cause))),
            );
            const snapshot = readySnapshot(fixture.identity, 1, 0);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              duplicateFailure,
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
            };
          }),
        );
      }),
    );

    expect(result.duplicateFailure).toMatchObject({
      code: 'unknown',
      message: 'stage code graph facts failed with an unclassified storage error.',
      recovery: 'diagnose',
      retryable: false,
    });
    expect(result.duplicateFailure?.message).not.toContain(fixture.databasePath);
    expect(result.graph.symbols).toEqual([original]);
  });

  it('records reusable lookup and alias counts from bounded activation pages', async () => {
    const fixture = await materializationFixture();
    const caller = symbol('receipt-caller', 'receiptCaller', ['typescript:name:receiptCaller']);
    const target = symbol('receipt-target', 'receiptTarget', ['typescript:name:receiptTarget']);
    const unresolved = edge('receipt-edge', caller, target.name);
    const reference: CodeGraphReference = {
      aliasLookupKeys: ['typescript:name:receiptAlias'],
      edgeId: unresolved.id,
      evidencePath: fixture.file.path,
      evidenceSpan: unresolved.evidenceSpan,
      lookupTiers: [['typescript:name:receiptTarget']],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: target.name,
    };
    const receiptInput = {
      fileSetFingerprint: 'files-fingerprint',
      packProvenance: [
        {
          cacheIdentity: 'typescript-extractor-v1',
          derivationIdentity: 'typescript-derivation-v1',
          id: 'typescript',
          resolutionDomain: 'typescript',
          resolutionVersion: 'typescript-resolver-v1',
        },
      ],
      workspaceFingerprint: 'workspace-fingerprint',
    };

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [caller, target], [unresolved], [reference]);
            yield* store.resolveStagedReferences(fixture.databasePath);
            const counts = yield* store.stagedFactCounts(fixture.databasePath);
            const snapshot = readySnapshot(fixture.identity, counts.symbols, counts.edges);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot, receiptInput);
            return {
              receipt: yield* store.reusableBaseReceipt(fixture.databasePath, snapshot.id),
              snapshot,
            };
          }),
        );
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    const counts = database
      .query(
        `SELECT
           COUNT(*) AS lookups,
           COALESCE(SUM(CASE WHEN provenance = 'alias' THEN 1 ELSE 0 END), 0) AS aliases
         FROM snapshot_symbol_lookup
         WHERE snapshot_id = ?`,
      )
      .get(result.snapshot.id) as {readonly aliases: number; readonly lookups: number};
    database.close(false);

    expect(counts.aliases).toBe(1);
    expect(result.receipt).toMatchObject({
      aliasCount: counts.aliases,
      fileSetFingerprint: receiptInput.fileSetFingerprint,
      lookupCount: counts.lookups,
      packProvenance: receiptInput.packProvenance,
      reexportCount: 0,
      workspaceFingerprint: receiptInput.workspaceFingerprint,
    });
  });

  it('rejects a staged edge whose resolved endpoint is missing', async () => {
    const fixture = await materializationFixture();
    const caller = symbol('caller', 'caller', ['typescript:name:caller']);
    const invalid = {...edge('missing-target-edge', caller, 'missingTarget'), targetId: 'missing-target-id'};

    const failure = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [caller], [invalid]);
            const snapshot = readySnapshot(fixture.identity, 1, 1);
            return yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot).pipe(
              Effect.as(undefined),
              Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
            );
          }),
        );
      }),
    );

    expect(failure).toContain('missing-target-edge');
    expect(failure).toContain('references a missing symbol');
  });

  it('keeps a snapshot building when a bounded copy exposes a declared count mismatch', async () => {
    const fixture = await materializationFixture();
    const onlySymbol = symbol('only-symbol', 'onlySymbol', ['typescript:name:onlySymbol']);
    const mismatched = readySnapshot(fixture.identity, 2, 0);

    const failure = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [onlySymbol], []);
            return yield* store.activateStaged(fixture.databasePath, fixture.identity, mismatched).pipe(
              Effect.as(undefined),
              Effect.catch(cause => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
            );
          }),
        );
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    const state = database.query('SELECT state FROM snapshots WHERE id = ?').get(mismatched.id) as {
      readonly state: string;
    };
    database.close(false);

    expect(failure).toContain('Staged symbol count does not match');
    expect(state.state).toBe('building');
  });

  it('rejects duplicate relationship IDs across staging batches without replacing the first relationship', async () => {
    const fixture = await materializationFixture();
    const caller = symbol('caller', 'caller', ['typescript:name:caller']);
    const target = symbol('target', 'target', ['typescript:name:target']);
    const other = symbol('other', 'other', ['typescript:name:other']);
    const original = edge('stable-edge-id', caller, target.name);
    const originalReference: CodeGraphReference = {
      edgeId: original.id,
      evidencePath: fixture.file.path,
      evidenceSpan: original.evidenceSpan,
      lookupTiers: [['typescript:name:target']],
      provenance: original.provenance,
      relation: original.relation,
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: target.name,
    };
    const conflictingEdge = {...original, targetName: other.name};
    const conflictingReference = {
      ...originalReference,
      lookupTiers: [['typescript:name:other']],
      targetName: other.name,
    };

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(
              fixture.databasePath,
              [caller, target, other],
              [original],
              [originalReference],
            );
            const edgeFailure = yield* store.stageActivationFacts(fixture.databasePath, [], [conflictingEdge]).pipe(
              Effect.as(undefined),
              Effect.catch(cause => Effect.succeed(observedStoreFailure(cause))),
            );
            const referenceFailure = yield* store
              .stageActivationFacts(fixture.databasePath, [], [], [conflictingReference])
              .pipe(
                Effect.as(undefined),
                Effect.catch(cause => Effect.succeed(observedStoreFailure(cause))),
              );
            const resolution = yield* store.resolveStagedReferences(fixture.databasePath);
            const counts = yield* store.stagedFactCounts(fixture.databasePath);
            const snapshot = readySnapshot(fixture.identity, counts.symbols, counts.edges);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
            return {
              edgeFailure,
              graph: yield* store.loadGraph(fixture.databasePath, snapshot.id),
              referenceFailure,
              resolution,
            };
          }),
        );
      }),
    );

    expect(result.edgeFailure).toMatchObject({
      code: 'unknown',
      message: 'stage code graph facts failed with an unclassified storage error.',
    });
    expect(result.referenceFailure).toMatchObject({
      code: 'unknown',
      message: 'stage code graph facts failed with an unclassified storage error.',
    });
    expect(result.edgeFailure?.message).not.toContain(fixture.databasePath);
    expect(result.referenceFailure?.message).not.toContain(fixture.databasePath);
    expect(result.resolution.resolved).toBe(1);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.graph.edges[0]).toMatchObject({sourceId: caller.id, targetId: target.id, targetName: target.name});
  });

  it('rolls back a defect at an activation copy boundary and preserves the prior active snapshot', async () => {
    const fixture = await materializationFixture();
    const original = symbol('original', 'original', ['typescript:name:original']);
    const replacement = symbol('replacement', 'replacement', ['typescript:name:replacement']);
    const companion = symbol('companion', 'companion', ['typescript:name:companion']);
    const originalSnapshot = readySnapshot(fixture.identity, 1, 0);
    const interruptedSnapshot = readySnapshot(fixture.identity, 2, 0);
    const interruptedProgress: CodeGraphActivationProgress[] = [];

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [original], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, originalSnapshot);
            yield* store.promote(fixture.databasePath, fixture.identity, originalSnapshot.id);
            yield* store.markBuilding(fixture.databasePath, fixture.identity, {
              ...interruptedSnapshot,
              state: 'building',
            });
          }),
        );
      }),
    );

    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
              yield* store.stageActivationFacts(fixture.databasePath, [replacement, companion], []);
              yield* store.activateStaged(
                fixture.databasePath,
                fixture.identity,
                interruptedSnapshot,
                undefined,
                undefined,
                progress =>
                  Effect.sync(() => interruptedProgress.push(progress)).pipe(
                    Effect.andThen(
                      progress.stage === 'copying-symbols' && progress.state === 'started'
                        ? Effect.die(TestError.make({message: 'injected activation boundary defect'}))
                        : Effect.void,
                    ),
                  ),
              );
            }),
          );
        }),
      ),
    ).rejects.toThrow('injected activation boundary defect');
    expect(interruptedProgress.at(-1)).toMatchObject({stage: 'copying-symbols', state: 'started'});

    const recovered = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const active = yield* store.readySnapshot(fixture.databasePath, fixture.identity.worktreeId);
        const graph = active ? yield* store.loadGraph(fixture.databasePath, active.id) : undefined;
        const healthBeforeRepair = yield* store.diagnose(fixture.databasePath);
        const repaired = yield* store.repair(fixture.databasePath);
        const healthAfterRepair = yield* store.diagnose(fixture.databasePath);
        return {active, graph, healthAfterRepair, healthBeforeRepair, repaired};
      }),
    );
    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    const interruptedRows = database
      .query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
      .get(interruptedSnapshot.id) as {readonly count: number};
    const interruptedTerms = readLexicalTerms(database, interruptedSnapshot.id);
    const foreignKeyViolations = database.query('PRAGMA foreign_key_check').all();
    database.close(false);

    expect(recovered.active?.id).toBe(originalSnapshot.id);
    expect(recovered.graph?.symbols).toEqual([original]);
    expect(interruptedRows.count).toBe(0);
    expect(interruptedTerms).toEqual([]);
    expect(foreignKeyViolations).toEqual([]);
    expect(recovered.healthBeforeRepair?.buildingSnapshots).toBe(1);
    expect(recovered.repaired?.removedSnapshots).toBe(1);
    expect(recovered.healthAfterRepair?.buildingSnapshots).toBe(0);
  });

  effectIt.effect('releases the SQLite writer between persistent chunks so a cache writer can interleave', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const symbols = Array.from({length: 5_100}, (_, index) => {
        const id = `batch-${String(index).padStart(5, '0')}`;
        return symbol(id, id, [`typescript:name:${id}`]);
      });
      const snapshot = readySnapshot(fixture.identity, symbols.length, 0);
      const cachedFacts: CodeGraphFileFacts = {
        diagnostics: [],
        edges: [],
        path: fixture.file.path,
        symbols: [],
      };
      const chunkMayContinue = yield* Deferred.make<void>();
      const chunkCommitted = yield* Deferred.make<void>();
      let paused = false;
      const store = yield* CodeGraphStore;
      const activation = yield* store
        .withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, symbols, []);
            yield* store.activateStaged(
              fixture.databasePath,
              fixture.identity,
              snapshot,
              undefined,
              undefined,
              progress => {
                if (paused || progress.stage !== 'copying-symbols' || progress.state !== 'progress') {
                  return Effect.void;
                }
                paused = true;
                return Deferred.succeed(chunkCommitted, undefined).pipe(
                  Effect.andThen(Deferred.await(chunkMayContinue)),
                );
              },
            );
          }),
          // This regression isolates SQLite transaction yielding; checkout-gate
          // serialization is covered separately by the writer-lock tests.
          {writerGateHeld: true},
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(chunkCommitted);
      yield* store.cacheFacts(
        fixture.databasePath,
        [fixture.file],
        [cachedFacts],
        'concurrent-cache',
        unprotectedCacheWrite,
      );
      yield* Deferred.succeed(chunkMayContinue, undefined);
      yield* Fiber.join(activation);

      const key = [{contentHash: fixture.file.contentHash, path: fixture.file.path}];
      const decoded = yield* store.loadCachedFacts(fixture.databasePath, key, 'concurrent-cache');
      const metadata = yield* store.loadCachedFacts(fixture.databasePath, key, 'concurrent-cache', {decode: false});
      expect(decoded.facts.get(fixture.file.path)).toEqual(cachedFacts);
      expect(metadata.facts.size).toBe(0);
      expect(metadata.keys).toEqual(new Set([fixture.file.path]));
      expect(metadata.bytes).toBe(decoded.bytes);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reuses one committed structured blob with target-path-local identities', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const content = JSON.stringify({
        'flat.key': {leaf: true},
        flat: {key: {leaf: false}},
        ...Object.fromEntries(Array.from({length: 100}, (_, index) => [`entry-${index}`, {leaf: index}])),
      });
      const donor = structuredCacheFile('config/donor.json', content);
      const target = structuredCacheFile('config/copies/target.json', content);
      const context = {packageName: Option.none(), project: Option.none()};
      const donorFacts = extractStructuredSchemaFacts(donor, context);
      const expected = extractStructuredSchemaFacts(target, context);
      const store = yield* CodeGraphStore;

      yield* store.cacheFacts(
        fixture.databasePath,
        [donor],
        [donorFacts],
        'structured-blob-cache',
        unprotectedCacheWrite,
      );
      const decoded = yield* store.loadCachedFacts(fixture.databasePath, [target], 'structured-blob-cache');
      const metadata = yield* store.loadCachedFacts(fixture.databasePath, [target], 'structured-blob-cache', {
        decode: false,
      });
      const cachedKeys = yield* store.cachedCommittedFileKeys(fixture.databasePath, 'structured-blob-cache');

      expect(decoded.facts.get(target.path)).toEqual(expected);
      expect(decoded.keys).toEqual(new Set([target.path]));
      expect(metadata.keys).toEqual(new Set([target.path]));
      expect(metadata.bytes).toBeGreaterThanOrEqual(decoded.bytes);
      expect(cachedKeys.has(codeGraphBlobReuseCacheKey(target, 'structured-blob-cache')!)).toBe(true);
      const compact = new Database(fixture.databasePath, {readonly: true, strict: true});
      try {
        expect(
          compact
            .query("SELECT json_extract(facts_json, '$.codec') AS codec FROM file_blobs WHERE path_hint = ?")
            .get(donor.path),
        ).toEqual({codec: CODE_GRAPH_STORED_FACT_CODEC});
      } finally {
        compact.close(false);
      }

      const referenced = new Database(fixture.databasePath, {strict: true});
      const now = DateTime.formatIso(yield* DateTime.now);
      referenced
        .query(
          `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
           VALUES (?, 'blob reuse fixture', 'sha1', ?, ?)`,
        )
        .run(fixture.identity.repositoryId, now, now);
      referenced
        .query(
          `INSERT INTO snapshots (
             id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
             extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
             edge_count, started_at, completed_at, failure_summary
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, NULL, 'ready', 1, 0, 0, ?, ?, NULL)`,
        )
        .run(
          'blob-reuse-snapshot',
          fixture.identity.repositoryId,
          fixture.identity.worktreeId,
          fixture.identity.headCommit,
          'blob-reuse-content',
          'structured-blob-cache',
          now,
          now,
        );
      referenced
        .query(
          `INSERT INTO snapshot_files (snapshot_id, path, content_hash, language, mode, size, source)
           VALUES ('blob-reuse-snapshot', ?, ?, 'json', '100644', ?, 'commit')`,
        )
        .run(target.path, target.contentHash, target.size);
      referenced.close(false);
      yield* store.pruneCachedFacts(fixture.databasePath, ['structured-blob-cache']);

      const database = new Database(fixture.databasePath, {readonly: true, strict: true});
      const rows = database
        .query('SELECT path_hint, blob_id, reuse_class FROM file_blobs WHERE extractor_set = ?')
        .all('structured-blob-cache');
      database.close(false);
      expect(rows).toEqual([
        {
          blob_id: donor.blobId,
          path_hint: donor.path,
          reuse_class: 'structured-object-v1:json:full',
        },
      ]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not hold the checkout writer lock while a direct build validates repository-scale input', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const writerLockPath = join(fixture.root, 'checkout-writer.lock');
      const stored = symbol('direct-validation', 'directValidation', ['typescript:name:directValidation']);
      const snapshot = readySnapshot(fixture.identity, 1, 0);
      const cachedFacts: CodeGraphFileFacts = {
        diagnostics: [],
        edges: [],
        path: fixture.file.path,
        symbols: [],
      };
      const validationMayContinue = yield* Deferred.make<void>();
      const validationStarted = yield* Deferred.make<void>();
      let paused = false;
      const store = yield* CodeGraphStore;
      const activation = yield* store
        .withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], snapshot.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [stored], [], [], undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(
              fixture.databasePath,
              fixture.identity,
              snapshot,
              undefined,
              undefined,
              progress => {
                if (paused || progress.stage !== 'validating-input' || progress.state !== 'started') return Effect.void;
                paused = true;
                return Deferred.succeed(validationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(validationMayContinue)),
                );
              },
            );
          }),
          {writerLockPath},
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(validationStarted);
      yield* Effect.race(
        store.withSession(
          fixture.databasePath,
          store.cacheFacts(
            fixture.databasePath,
            [fixture.file],
            [cachedFacts],
            'linked-worktree-cache',
            unprotectedCacheWrite,
          ),
          {writerLockPath},
        ),
        Effect.sleep('2 seconds').pipe(
          Effect.andThen(
            Effect.fail(
              TestError.make({message: 'Linked-worktree writer remained blocked by direct-build validation.'}),
            ),
          ),
        ),
      ).pipe(Effect.ensuring(Deferred.succeed(validationMayContinue, undefined)));
      yield* Fiber.join(activation);

      const cached = yield* store.loadCachedFacts(
        fixture.databasePath,
        [{contentHash: fixture.file.contentHash, path: fixture.file.path}],
        'linked-worktree-cache',
      );
      expect(cached.facts.get(fixture.file.path)).toEqual(cachedFacts);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('defers retired snapshot deletion until bounded maintenance cleanup', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const firstSymbol = symbol('retired-symbol', 'retiredSymbol', ['typescript:name:retiredSymbol']);
      const currentSymbol = symbol('current-symbol', 'currentSymbol', ['typescript:name:currentSymbol']);
      const firstSnapshot = {...readySnapshot(fixture.identity, 1, 0), dirty: true, id: testSnapshotId(103)};
      const currentSnapshot = {...readySnapshot(fixture.identity, 1, 0), id: testSnapshotId(104)};

      const store = yield* CodeGraphStore;
      yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [firstSymbol], []);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, firstSnapshot);
          yield* store.promote(fixture.databasePath, fixture.identity, firstSnapshot.id);
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [currentSymbol], []);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, currentSnapshot);
          yield* store.promote(fixture.databasePath, fixture.identity, currentSnapshot.id);
        }),
      );

      const before = new Database(fixture.databasePath, {readonly: true, strict: true});
      const retiredBefore = before.query('SELECT state FROM snapshots WHERE id = ?').get(firstSnapshot.id) as {
        readonly state: string;
      };
      const retiredSymbolsBefore = before
        .query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
        .get(firstSnapshot.id) as {readonly count: number};
      const retiredTermsBefore = readLexicalTerms(before, firstSnapshot.id);
      before.close(false);
      expect(retiredBefore.state).toBe('retired');
      expect(retiredSymbolsBefore.count).toBe(1);
      expect(retiredTermsBefore.length).toBeGreaterThan(0);

      yield* store.pruneRetiredSnapshots(fixture.databasePath);

      const after = new Database(fixture.databasePath, {readonly: true, strict: true});
      const retiredAfter = after.query('SELECT state FROM snapshots WHERE id = ?').get(firstSnapshot.id);
      const currentAfter = after.query('SELECT state FROM snapshots WHERE id = ?').get(currentSnapshot.id) as {
        readonly state: string;
      };
      const activeAfter = after
        .query('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?')
        .get(fixture.identity.worktreeId) as {readonly snapshot_id: string};
      const retiredTermsAfter = readLexicalTerms(after, firstSnapshot.id);
      const currentTermsAfter = readLexicalTerms(after, currentSnapshot.id);
      const foreignKeyViolations = after.query('PRAGMA foreign_key_check').all();
      after.close(false);
      expect(retiredAfter).toBeNull();
      expect(currentAfter.state).toBe('ready');
      expect(activeAfter.snapshot_id).toBe(currentSnapshot.id);
      expect(retiredTermsAfter).toEqual([]);
      expect(currentTermsAfter.length).toBeGreaterThan(0);
      expect(foreignKeyViolations).toEqual([]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('pages a large fold-forward proof before deleting its retired snapshot', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const retiredSymbol = symbol('fold-retired-symbol', 'foldRetiredSymbol', ['typescript:name:foldRetiredSymbol']);
      const currentSymbol = symbol('fold-current-symbol', 'foldCurrentSymbol', ['typescript:name:foldCurrentSymbol']);
      const retiredSnapshot = {...readySnapshot(fixture.identity, 1, 0), dirty: true, id: testSnapshotId(105)};
      const currentSnapshot = {...readySnapshot(fixture.identity, 1, 0), id: testSnapshotId(106)};
      const lookupRowCount = 20_001;
      const store = yield* CodeGraphStore;

      yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [retiredSymbol], []);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, retiredSnapshot);
          yield* store.promote(fixture.databasePath, fixture.identity, retiredSnapshot.id);
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [currentSymbol], []);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, currentSnapshot);
          yield* store.promote(fixture.databasePath, fixture.identity, currentSnapshot.id);
        }),
      );

      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.sync(() => {
        const database = new Database(fixture.databasePath, {strict: true});
        database.exec('BEGIN IMMEDIATE');
        try {
          database
            .query(
              `INSERT INTO snapshot_fold_forward_receipts (
                 snapshot_id, root_snapshot_id, format_version, delta_path_count,
                 staged_row_count, staged_payload_bytes, lookup_count, reexport_count, created_at
               ) VALUES (?, ?, 1, 1, ?, 1, ?, 0, ?)`,
            )
            .run(retiredSnapshot.id, currentSnapshot.id, lookupRowCount + 1, lookupRowCount, createdAt);
          database
            .query('INSERT INTO snapshot_fold_forward_paths (snapshot_id, path) VALUES (?, ?)')
            .run(retiredSnapshot.id, fixture.file.path);
          database.exec(`
            WITH digits(value) AS (
              VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
            ), sequence(value) AS (
              SELECT ones.value
                + 10 * tens.value
                + 100 * hundreds.value
                + 1000 * thousands.value
                + 10000 * ten_thousands.value
              FROM digits AS ones
              CROSS JOIN digits AS tens
              CROSS JOIN digits AS hundreds
              CROSS JOIN digits AS thousands
              CROSS JOIN digits AS ten_thousands
            )
            INSERT INTO snapshot_fold_forward_symbol_lookup (
              snapshot_id, lookup_key, symbol_id, resolution_domain,
              exported, provenance, evidence_edge_id, evidence_path
            )
            SELECT
              '${retiredSnapshot.id}',
              'typescript:name:fold-' || printf('%05d', value),
              'fold-symbol-' || printf('%05d', value),
              'typescript', 1, 'symbol', NULL, '${fixture.file.path}'
            FROM sequence
            WHERE value < ${lookupRowCount}
          `);
          database.exec('COMMIT');
        } catch (cause) {
          database.exec('ROLLBACK');
          throw cause;
        } finally {
          database.close(false);
        }
      });

      const lookupDeletesPerTransaction: number[] = [];
      yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const lookupCount = () =>
            sql.unsafe<{readonly count: number}>(
              'SELECT COUNT(*) AS count FROM snapshot_fold_forward_symbol_lookup WHERE snapshot_id = ?',
              [retiredSnapshot.id],
            );
          const writerGate: CodeGraphWriterGate = effect =>
            Effect.gen(function* () {
              const before = Number((yield* lookupCount())[0]?.count ?? -1);
              const result = yield* effect;
              const after = Number((yield* lookupCount())[0]?.count ?? -1);
              const deleted = before - after;
              if (deleted > 0) lookupDeletesPerTransaction.push(deleted);
              return result;
            });
          yield* pruneRetiredSnapshotRows(writerGate, retiredSnapshot.id);
        }),
        {writerGateHeld: true},
      );

      expect(lookupDeletesPerTransaction.length).toBeGreaterThan(1);
      expect(lookupDeletesPerTransaction.reduce((total, deleted) => total + deleted, 0)).toBe(lookupRowCount);
      expect(lookupDeletesPerTransaction.every(deleted => deleted <= 20_000)).toBe(true);
      const after = new Database(fixture.databasePath, {readonly: true, strict: true});
      try {
        expect(after.query('SELECT state FROM snapshots WHERE id = ?').get(retiredSnapshot.id)).toBeNull();
        expect(
          after
            .query('SELECT COUNT(*) AS count FROM snapshot_fold_forward_receipts WHERE snapshot_id = ?')
            .get(retiredSnapshot.id),
        ).toEqual({count: 0});
        expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        after.close(false);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('guards each persistent inventory transaction and resumes an exact 2,500-row prefix', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const files = Array.from({length: 2_501}, (_, index): CodeGraphInventoryFile => ({
        ...fixture.file,
        blobId: index.toString(16).padStart(40, '0'),
        contentHash: index.toString(16).padStart(64, '0'),
        path: `src/capacity-${String(index).padStart(4, '0')}-🙂.ts`,
      }));
      const snapshot = {
        ...readySnapshot(fixture.identity, 0, 0),
        fileCount: files.length,
        id: 'inventory-capacity-🙂',
      };
      const store = yield* CodeGraphStore;
      const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
        ...snapshot,
        state: 'building',
      });
      const prepare = (protector: CodeGraphDirectPersistentCapacityProtector) =>
        store.prepareActivation(fixture.databasePath, files, snapshot.id, 1, ownerToken, protector);

      const planPause = capacityGuardProbe('register persistent code graph materialization plan');
      const planFailure = yield* Effect.flip(prepare(planPause.guard));
      expect(isCodeGraphStoreNoSpaceError(planFailure)).toBe(true);
      expect(planPause.boundaries).toEqual([
        {
          finalFactBytes: 0,
          operation: 'register persistent code graph materialization plan',
          rowCount: 2,
        },
      ]);
      expect(persistentPreparationEvidence(fixture.databasePath, snapshot.id)).toEqual({
        distinctFiles: 0,
        expectedBatchCount: null,
        files: 0,
        lexicalCounters: 0,
      });

      const secondInventoryPause = capacityGuardProbe('stage persistent code graph inventory', 2);
      const inventoryFailure = yield* Effect.flip(prepare(secondInventoryPause.guard));
      expect(isCodeGraphStoreNoSpaceError(inventoryFailure)).toBe(true);
      expect(secondInventoryPause.boundaries).toEqual([
        {
          finalFactBytes: 0,
          operation: 'register persistent code graph materialization plan',
          rowCount: 2,
        },
        expectedPersistentInventoryBoundary(snapshot.id, files.slice(0, 2_500)),
        expectedPersistentInventoryBoundary(snapshot.id, files.slice(2_500)),
      ]);
      expect(persistentPreparationEvidence(fixture.databasePath, snapshot.id)).toEqual({
        distinctFiles: 2_500,
        expectedBatchCount: 1,
        files: 2_500,
        lexicalCounters: 1,
      });

      const resumed = capacityGuardProbe();
      yield* prepare(resumed.guard);
      expect(resumed.boundaries).toEqual([
        {
          finalFactBytes: 0,
          operation: 'register persistent code graph materialization plan',
          rowCount: 2,
        },
        expectedPersistentInventoryBoundary(snapshot.id, files.slice(0, 2_500)),
        expectedPersistentInventoryBoundary(snapshot.id, files.slice(2_500)),
      ]);
      expect(persistentPreparationEvidence(fixture.databasePath, snapshot.id)).toEqual({
        distinctFiles: 2_501,
        expectedBatchCount: 1,
        files: 2_501,
        lexicalCounters: 1,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('stops temporary staging and publication before mutation while preserving the prior ready view', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const store = yield* CodeGraphStore;
      const result = yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          yield* store.initialize(fixture.databasePath);
          const original = symbol('temporary-capacity-original', 'temporaryCapacityOriginal', []);
          const base = {...readySnapshot(fixture.identity, 1, 0), id: 'temporary-capacity-base'};
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [original], []);
          yield* store.resolveStagedReferences(fixture.databasePath);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, base);
          yield* store.promote(fixture.databasePath, fixture.identity, base.id, {
            persistentCapacityProtector: unprotectedCacheWrite,
          });

          const replacement = symbol('temporary-capacity-replacement', 'temporaryCapacityReplacement', []);
          const overlay: CodeGraphSnapshot = {
            ...readySnapshot(fixture.identity, 1, 0),
            baseSnapshotId: base.id,
            dirty: true,
            id: 'temporary-capacity-overlay',
          };
          const inventoryPause = capacityGuardProbe('stage temporary code graph inventory');
          const inventoryFailure = yield* store
            .prepareActivation(
              fixture.databasePath,
              [fixture.file],
              undefined,
              undefined,
              undefined,
              inventoryPause.guard,
            )
            .pipe(Effect.flip);
          const sql = yield* SqlClient.SqlClient;
          const afterInventoryPause = yield* sql<{
            readonly active: string;
            readonly base_state: string;
            readonly staged_files: number;
          }>`
            SELECT
              (SELECT snapshot_id FROM active_snapshots
               WHERE worktree_id = ${fixture.identity.worktreeId}) AS active,
              (SELECT state FROM snapshots WHERE id = ${base.id}) AS base_state,
              (SELECT COUNT(*) FROM activation_files) AS staged_files
          `;

          const inventoryResume = capacityGuardProbe();
          yield* store.prepareActivation(
            fixture.databasePath,
            [fixture.file],
            undefined,
            undefined,
            undefined,
            inventoryResume.guard,
          );
          const factsPause = capacityGuardProbe('stage temporary code graph facts');
          const factsFailure = yield* store
            .stageActivationFacts(fixture.databasePath, [replacement], [], [], undefined, 0, factsPause.guard)
            .pipe(Effect.flip);
          const afterFactsPause = yield* sql<{readonly symbols: number}>`
            SELECT COUNT(*) AS symbols FROM activation_symbols
          `;
          const factsResume = capacityGuardProbe();
          yield* store.stageActivationFacts(
            fixture.databasePath,
            [replacement],
            [],
            [],
            undefined,
            0,
            factsResume.guard,
          );
          yield* store.resolveStagedReferences(fixture.databasePath, undefined, factsResume.guard);

          const publicationPause = capacityGuardProbe('publish temporary code graph snapshot');
          const publicationFailure = yield* store
            .activateStaged(
              fixture.databasePath,
              fixture.identity,
              overlay,
              undefined,
              undefined,
              undefined,
              publicationPause.guard,
            )
            .pipe(Effect.flip);
          const afterPublicationPause = yield* sql<{
            readonly active: string;
            readonly base_state: string;
            readonly overlay_rows: number;
          }>`
            SELECT
              (SELECT snapshot_id FROM active_snapshots
               WHERE worktree_id = ${fixture.identity.worktreeId}) AS active,
              (SELECT state FROM snapshots WHERE id = ${base.id}) AS base_state,
              (SELECT COUNT(*) FROM snapshots WHERE id = ${overlay.id}) AS overlay_rows
          `;
          const publicationResume = capacityGuardProbe();
          yield* store.activateStaged(
            fixture.databasePath,
            fixture.identity,
            overlay,
            undefined,
            undefined,
            undefined,
            publicationResume.guard,
          );
          const resumed = yield* sql<{readonly state: string}>`
            SELECT state FROM snapshots WHERE id = ${overlay.id}
          `;
          return {
            afterFactsPause: afterFactsPause[0],
            afterInventoryPause: afterInventoryPause[0],
            afterPublicationPause: afterPublicationPause[0],
            factsFailure,
            factsPause: factsPause.boundaries,
            factsResume: factsResume.boundaries,
            inventoryFailure,
            inventoryPause: inventoryPause.boundaries,
            inventoryResume: inventoryResume.boundaries,
            publicationFailure,
            publicationPause: publicationPause.boundaries,
            publicationResume: publicationResume.boundaries,
            resumed: resumed[0],
          };
        }),
      );

      expect(isCodeGraphStoreNoSpaceError(result.inventoryFailure)).toBe(true);
      expect(result.inventoryPause).toEqual([
        expect.objectContaining({
          mainFilesystem: 'temporary',
          operation: 'stage temporary code graph inventory',
          transientFilesystem: 'temporary',
        }),
      ]);
      expect(result.inventoryResume).toEqual(result.inventoryPause);
      // Admission happens before clearing the prior connection-private stage,
      // so a pause is non-mutating as well as preserving the durable view.
      expect(result.afterInventoryPause).toEqual({
        active: 'temporary-capacity-base',
        base_state: 'ready',
        staged_files: 1,
      });

      expect(isCodeGraphStoreNoSpaceError(result.factsFailure)).toBe(true);
      expect(result.factsPause).toEqual([
        expect.objectContaining({
          mainFilesystem: 'temporary',
          operation: 'stage temporary code graph facts',
          transientFilesystem: 'temporary',
        }),
      ]);
      expect(result.factsResume).toEqual(result.factsPause);
      expect(result.afterFactsPause).toEqual({symbols: 0});

      expect(isCodeGraphStoreNoSpaceError(result.publicationFailure)).toBe(true);
      expect(result.publicationPause).toEqual([
        expect.objectContaining({operation: 'publish temporary code graph snapshot', transientFilesystem: 'durable'}),
      ]);
      expect(result.publicationResume).toEqual(result.publicationPause);
      expect(result.afterPublicationPause).toEqual({
        active: 'temporary-capacity-base',
        base_state: 'ready',
        overlay_rows: 0,
      });
      expect(result.resumed).toEqual({state: 'ready'});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reserves every temporary reference page before mutating its resumable stage', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const store = yield* CodeGraphStore;
      const result = yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          yield* store.initialize(fixture.databasePath);
          const lookupKey = 'typescript:name:temporaryCapacityTarget';
          const source = symbol('temporary-capacity-source', 'temporaryCapacitySource', []);
          const target = symbol('temporary-capacity-target', 'temporaryCapacityTarget', [lookupKey]);
          const unresolved = edge('temporary-capacity-edge', source, target.name);
          const reference: CodeGraphReference = {
            edgeId: unresolved.id,
            evidencePath: unresolved.evidencePath,
            evidenceSpan: unresolved.evidenceSpan,
            exportedOnly: false,
            lookupTiers: [[lookupKey]],
            provenance: unresolved.provenance,
            relation: unresolved.relation,
            resolutionDomain: 'typescript',
            sourceId: source.id,
            sourceName: source.name,
            targetName: target.name,
          };
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [source, target], [unresolved], [reference]);

          const pause = capacityGuardProbe('resolve temporary code graph references');
          const failure = yield* store
            .resolveStagedReferences(fixture.databasePath, undefined, pause.guard)
            .pipe(Effect.flip);
          const sql = yield* SqlClient.SqlClient;
          const afterPause = yield* sql<{readonly remaining: number; readonly resolved: number}>`
            SELECT
              (SELECT COUNT(*) FROM activation_references) AS remaining,
              (SELECT COUNT(*) FROM activation_edges WHERE target_id IS NOT NULL) AS resolved
          `;
          const resume = capacityGuardProbe();
          const resolution = yield* store.resolveStagedReferences(fixture.databasePath, undefined, resume.guard);
          const afterResume = yield* sql<{readonly remaining: number; readonly resolved: number}>`
            SELECT
              (SELECT COUNT(*) FROM activation_references) AS remaining,
              (SELECT COUNT(*) FROM activation_edges WHERE target_id IS NOT NULL) AS resolved
          `;
          return {
            afterPause: afterPause[0],
            afterResume: afterResume[0],
            failure,
            pause: pause.boundaries,
            resolution,
            resume: resume.boundaries,
          };
        }),
      );

      expect(isCodeGraphStoreNoSpaceError(result.failure)).toBe(true);
      expect(result.pause).toEqual([
        expect.objectContaining({
          mainFilesystem: 'temporary',
          operation: 'resolve temporary code graph references',
          transientFilesystem: 'temporary',
        }),
      ]);
      expect(result.afterPause).toEqual({remaining: 1, resolved: 0});
      expect(result.resume).toEqual(result.pause);
      expect(result.resolution.resolved).toBe(1);
      expect(result.afterResume).toEqual({remaining: 0, resolved: 1});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('guards both persistent resolution transaction families and resumes their committed prefix', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const scope = 'cgp_capacity_resolution';
      const sourcePath = 'src/capacity-barrel.ts';
      const targetPath = 'src/capacity-target.ts';
      const scopedNameKey = (path: string, name: string) =>
        `typescript:${scope}:path:${encodeURIComponent(path)}:name:${encodeURIComponent(name)}`;
      const source = {
        ...symbol('capacity-resolution-source', 'capacityBarrel', [`typescript:${scope}:module:${sourcePath}`]),
        kind: 'module' as const,
        path: sourcePath,
        qualifiedName: sourcePath,
        resolutionScopeId: scope,
      };
      const target = {
        ...symbol('capacity-resolution-target', 'capacityTarget', [
          `${scopedNameKey(targetPath, 'capacityTarget')}:implementation`,
          scopedNameKey(targetPath, 'capacityTarget'),
        ]),
        path: targetPath,
        resolutionScopeId: scope,
      };
      const unresolved = {
        ...edge('capacity-resolution-edge', source, target.name),
        relation: 'reexports' as const,
      };
      const sourceKey = scopedNameKey(sourcePath, target.name);
      const targetKey = scopedNameKey(targetPath, target.name);
      const reference: CodeGraphReference = {
        aliasLookupKeys: [`${sourceKey}:implementation`, sourceKey],
        edgeId: unresolved.id,
        evidencePath: source.path,
        evidenceSpan: unresolved.evidenceSpan,
        exportedOnly: true,
        lookupTiers: [[`${targetKey}:implementation`], [targetKey]],
        provenance: unresolved.provenance,
        relation: unresolved.relation,
        resolutionDomain: 'typescript',
        sourceId: source.id,
        sourceName: source.name,
        targetName: target.name,
      };
      const files = [sourcePath, targetPath].map((path, index): CodeGraphInventoryFile => ({
        ...fixture.file,
        blobId: String(index + 1).padStart(40, '0'),
        contentHash: String(index + 1).padStart(64, '0'),
        path,
      }));
      const snapshot = {
        ...readySnapshot(fixture.identity, 2, 1),
        fileCount: files.length,
        id: 'persistent-capacity-resolution',
      };
      const store = yield* CodeGraphStore;
      const result = yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
            ...snapshot,
            state: 'building',
          });
          yield* store.prepareActivation(fixture.databasePath, files, snapshot.id, 1, ownerToken);
          yield* store.stageActivationFacts(
            fixture.databasePath,
            [source, target],
            [unresolved],
            [reference],
            undefined,
            0,
          );
          yield* store.finalizePersistentMaterializationPlan(fixture.databasePath, 1);
          const sql = yield* SqlClient.SqlClient;

          const aliasPause = capacityGuardProbe('resolve persistent code graph reexport aliases');
          const aliasFailure = yield* store
            .resolveStagedReferences(fixture.databasePath, undefined, aliasPause.guard)
            .pipe(
              Effect.as(undefined as CodeGraphStoreError | undefined),
              Effect.catch(error => Effect.succeed(error)),
            );
          const afterAliasPause = yield* sql<{
            readonly aliases: number;
            readonly remainingReferences: number;
            readonly resolvedEdges: number;
          }>`
            SELECT
              (SELECT COUNT(*) FROM snapshot_symbol_lookup
               WHERE snapshot_id = ${snapshot.id} AND provenance = 'alias') AS aliases,
              (SELECT COUNT(*) FROM building_references
               WHERE snapshot_id = ${snapshot.id}) AS remainingReferences,
              (SELECT COUNT(*) FROM edges WHERE snapshot_id = ${snapshot.id} AND target_id IS NOT NULL) AS resolvedEdges
          `;

          const pagePause = capacityGuardProbe('resolve persistent code graph references');
          const pageFailure = yield* store
            .resolveStagedReferences(fixture.databasePath, undefined, pagePause.guard)
            .pipe(
              Effect.as(undefined as CodeGraphStoreError | undefined),
              Effect.catch(error => Effect.succeed(error)),
            );
          const afterPagePause = yield* sql<{
            readonly aliases: number;
            readonly remainingReferences: number;
            readonly resolvedEdges: number;
          }>`
            SELECT
              (SELECT COUNT(*) FROM snapshot_symbol_lookup
               WHERE snapshot_id = ${snapshot.id} AND provenance = 'alias') AS aliases,
              (SELECT COUNT(*) FROM building_references
               WHERE snapshot_id = ${snapshot.id}) AS remainingReferences,
              (SELECT COUNT(*) FROM edges WHERE snapshot_id = ${snapshot.id} AND target_id IS NOT NULL) AS resolvedEdges
          `;

          const resumed = capacityGuardProbe();
          const resolution = yield* store.resolveStagedReferences(fixture.databasePath, undefined, resumed.guard);
          const afterResume = yield* sql<{
            readonly remainingReferences: number;
            readonly resolvedEdges: number;
          }>`
            SELECT
              (SELECT COUNT(*) FROM building_references
               WHERE snapshot_id = ${snapshot.id}) AS remainingReferences,
              (SELECT COUNT(*) FROM edges WHERE snapshot_id = ${snapshot.id} AND target_id IS NOT NULL) AS resolvedEdges
          `;
          return {
            afterAliasPause: afterAliasPause[0],
            afterPagePause: afterPagePause[0],
            afterResume: afterResume[0],
            aliasFailure,
            aliasPause: aliasPause.boundaries,
            pageFailure,
            pagePause: pagePause.boundaries,
            resolution,
            resumed: resumed.boundaries,
          };
        }),
      );

      expect(isCodeGraphStoreNoSpaceError(result.aliasFailure)).toBe(true);
      expect(result.aliasPause).toHaveLength(1);
      expect(result.aliasPause[0]).toMatchObject({operation: 'resolve persistent code graph reexport aliases'});
      expect(result.aliasPause[0].rowCount).toBeGreaterThan(0);
      expect(result.aliasPause[0].finalFactBytes).toBeGreaterThan(0);
      expect(result.afterAliasPause).toEqual({aliases: 0, remainingReferences: 1, resolvedEdges: 0});

      expect(isCodeGraphStoreNoSpaceError(result.pageFailure)).toBe(true);
      expect(result.pagePause.some(value => value.operation === 'resolve persistent code graph reexport aliases')).toBe(
        true,
      );
      const pageBoundary = result.pagePause.find(
        value => value.operation === 'resolve persistent code graph references',
      );
      expect(pageBoundary?.rowCount).toBeGreaterThan(0);
      expect(pageBoundary?.finalFactBytes).toBeGreaterThan(0);
      expect(result.afterPagePause.aliases).toBeGreaterThan(0);
      expect(result.afterPagePause).toMatchObject({remainingReferences: 1, resolvedEdges: 0});

      expect(result.resolution.resolved).toBe(1);
      expect(result.afterResume).toEqual({remainingReferences: 0, resolvedEdges: 1});
      expect(result.resumed.some(value => value.operation === 'resolve persistent code graph references')).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('guards high-cardinality ready promotion and resumes the exact ready snapshot', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(materializationFixture);
      const snapshot: CodeGraphSnapshot = {
        ...readySnapshot(fixture.identity, 0, 0),
        fileCount: 0,
        id: testSnapshotId(105),
      };
      const leaseCount = 512;
      const store = yield* CodeGraphStore;
      const result = yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
            ...snapshot,
            state: 'building',
          });
          yield* store.prepareActivation(fixture.databasePath, [], snapshot.id, 0, ownerToken);
          yield* store.resolveStagedReferences(fixture.databasePath);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, snapshot);
          const sql = yield* SqlClient.SqlClient;
          const unrelatedSnapshotId = testSnapshotId(106);
          yield* sql`
            INSERT INTO snapshots (
              id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
              dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at
            )
            SELECT
              ${unrelatedSnapshotId}, repository_id, worktree_id, commit_id, ${unrelatedSnapshotId},
              base_snapshot_id, extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
              edge_count, started_at, completed_at
            FROM snapshots
            WHERE id = ${snapshot.id}
          `;
          for (const offset of [0, 128, 256, 384]) {
            const tokens = Array.from({length: 128}, (_, index) => `promotion-lease-${offset + index}`);
            yield* sql.unsafe(
              `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
               VALUES ${tokens.map(() => '(?, ?, ?, 0)').join(', ')}`,
              tokens.flatMap(token => [token, snapshot.id, Date.now() + 60_000]),
            );
            const unrelatedTokens = Array.from(
              {length: 128},
              (_, index) => `unrelated-expired-lease-${offset + index}`,
            );
            yield* sql.unsafe(
              `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
               VALUES ${unrelatedTokens.map(() => '(?, ?, ?, 0)').join(', ')}`,
              unrelatedTokens.flatMap(token => [token, unrelatedSnapshotId, Date.now() + 60_000]),
            );
          }

          const pause = capacityGuardProbe('promote ready code graph snapshot');
          const pauseFailure = yield* store
            .promote(fixture.databasePath, fixture.identity, snapshot.id, {
              persistentCapacityProtector: pause.guard,
            })
            .pipe(
              Effect.as(undefined as CodeGraphStoreError | undefined),
              Effect.catch(error => Effect.succeed(error)),
            );
          const afterPause = yield* sql<{readonly active: number; readonly flags: number; readonly state: string}>`
            SELECT snapshot.state,
              (SELECT COUNT(*) FROM active_snapshots WHERE worktree_id = ${fixture.identity.worktreeId}) AS active,
              (SELECT COUNT(*) FROM snapshot_leases
               WHERE snapshot_id = snapshot.id AND retire_when_inactive = 1) AS flags
            FROM snapshots AS snapshot WHERE snapshot.id = ${snapshot.id}
          `;

          const resumedBoundaries: CodeGraphDirectPersistentCapacityBoundary[] = [];
          let injectedLease = false;
          const resumed: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) =>
            Effect.gen(function* () {
              resumedBoundaries.push(boundary);
              if (!injectedLease) {
                injectedLease = true;
                yield* store.acquireSnapshotLease(fixture.databasePath, snapshot.id, 60_000);
                yield* sql`
                  UPDATE snapshot_leases SET expires_at = 0 WHERE snapshot_id = ${unrelatedSnapshotId}
                `.pipe(Effect.mapError(() => CodeGraphStoreError.of('Promotion fixture lease expiration failed.')));
              }
              return yield* transaction;
            });
          yield* store.promote(fixture.databasePath, fixture.identity, snapshot.id, {
            persistentCapacityProtector: resumed,
          });
          const afterResume = yield* sql<{
            readonly active: number;
            readonly flags: number;
            readonly state: string;
            readonly unrelatedLeases: number;
            readonly unrelatedState: string;
          }>`
            SELECT snapshot.state,
              (SELECT COUNT(*) FROM active_snapshots WHERE worktree_id = ${fixture.identity.worktreeId}) AS active,
              (SELECT COUNT(*) FROM snapshot_leases
               WHERE snapshot_id = snapshot.id AND retire_when_inactive = 1) AS flags,
              (SELECT COUNT(*) FROM snapshot_leases
               WHERE snapshot_id = ${unrelatedSnapshotId}) AS unrelatedLeases,
              (SELECT state FROM snapshots WHERE id = ${unrelatedSnapshotId}) AS unrelatedState
            FROM snapshots AS snapshot WHERE snapshot.id = ${snapshot.id}
          `;
          return {
            afterPause: afterPause[0],
            afterResume: afterResume[0],
            pause: pause.boundaries,
            pauseFailure,
            resumed: resumedBoundaries,
          };
        }),
      );

      expect(isCodeGraphStoreNoSpaceError(result.pauseFailure)).toBe(true);
      expect(result.pause).toHaveLength(1);
      expect(result.pause[0]).toMatchObject({
        operation: 'promote ready code graph snapshot',
        rowCount: 6,
      });
      expect(result.pause[0].finalFactBytes).toBeLessThan(leaseCount * snapshot.id.length);
      expect(result.afterPause).toEqual({active: 0, flags: 0, state: 'ready'});
      expect(result.resumed).toHaveLength(2);
      expect(result.resumed[0]).toMatchObject({
        operation: 'promote ready code graph snapshot',
        rowCount: 6,
      });
      expect(result.resumed[1]).toMatchObject({
        operation: 'promote ready code graph snapshot',
        rowCount: 6,
      });
      expect(result.resumed[1].finalFactBytes).toBeGreaterThan(result.resumed[0].finalFactBytes);
      expect(result.afterResume).toEqual({
        active: 1,
        // Ordinary promotion keeps a clean snapshot warm; only dirty views
        // receive the automatic retire-on-inactive baton.
        flags: 0,
        state: 'ready',
        unrelatedLeases: leaseCount,
        unrelatedState: 'ready',
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'guards exact workspace, conservative facts, plan finalization, and publication without partial mutation',
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(materializationFixture);
        const graphSymbol = symbol('capacity-symbol', 'capacitySymbol🙂', ['typescript:name:capacitySymbol🙂']);
        const snapshot = {...readySnapshot(fixture.identity, 1, 0), id: 'persistent-boundaries'};
        const workspace: CodeGraphWorkspace = {
          diagnostics: ['top-level diagnostics are not persisted'],
          fingerprint: 'workspace-capacity-fingerprint',
          projects: [
            {
              buildSystem: 'node',
              dependencies: ['cgp_dependency'],
              dependencyDetails: [{evidence: 'package🙂.json', provenance: 'declared', targetId: 'cgp_dependency'}],
              diagnostics: ['project🙂diagnostic'],
              id: 'cgp_capacity',
              kind: 'package',
              languages: ['typescript', 'javascript🙂'],
              name: 'capacity🙂project',
              provenance: 'declared',
              resolutionDomain: 'typescript',
              root: 'packages/capacity🙂',
              sourceRoots: ['packages/capacity🙂/src'],
              workspaceId: 'cgw_capacity',
              workspaceRoots: ['.'],
            },
          ],
          workspaces: [
            {
              buildSystem: 'node',
              diagnostics: ['workspace🙂diagnostic'],
              id: 'cgw_capacity',
              name: 'capacity🙂workspace',
              provenance: 'declared',
              root: '.',
            },
          ],
        };
        const finalFactBytes = 173;
        const store = yield* CodeGraphStore;
        const result = yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* claimPersistentBuildForTest(store, fixture.databasePath, fixture.identity, {
              ...snapshot,
              state: 'building',
            });
            const preparation = capacityGuardProbe();
            yield* store.prepareActivation(
              fixture.databasePath,
              [fixture.file],
              snapshot.id,
              1,
              ownerToken,
              preparation.guard,
            );
            const sql = yield* SqlClient.SqlClient;

            const workspacePause = capacityGuardProbe('stage persistent code graph workspace');
            const workspaceFailure = yield* store
              .stageWorkspaceCatalog(fixture.databasePath, workspace, workspacePause.guard)
              .pipe(
                Effect.as(undefined as CodeGraphStoreError | undefined),
                Effect.catch(error => Effect.succeed(error)),
              );
            const workspaceRowsAfterPause = yield* sql<{
              readonly dependencies: number;
              readonly projects: number;
              readonly workspaces: number;
            }>`
              SELECT
                (SELECT COUNT(*) FROM workspace_scopes WHERE snapshot_id = ${snapshot.id}) AS workspaces,
                (SELECT COUNT(*) FROM workspace_components WHERE snapshot_id = ${snapshot.id}) AS projects,
                (SELECT COUNT(*) FROM workspace_component_dependencies WHERE snapshot_id = ${snapshot.id}) AS dependencies
            `;
            const workspaceResume = capacityGuardProbe();
            yield* store.stageWorkspaceCatalog(fixture.databasePath, workspace, workspaceResume.guard);

            const invalidFactPause = capacityGuardProbe('stage persistent code graph facts');
            const invalidFactFailure = yield* store
              .stageActivationFactBatches(
                fixture.databasePath,
                [{batchIndex: 0, edges: [], references: [], symbols: [graphSymbol]}],
                undefined,
                invalidFactPause.guard,
              )
              .pipe(
                Effect.as(undefined as CodeGraphStoreError | undefined),
                Effect.catch(error => Effect.succeed(error)),
              );
            const factRowsAfterPause = yield* sql<{
              readonly analysisReceipts: number;
              readonly materializationReceipts: number;
              readonly symbols: number;
            }>`
              SELECT
                (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ${snapshot.id}) AS symbols,
                (SELECT COUNT(*) FROM building_analysis_batches WHERE snapshot_id = ${snapshot.id}) AS analysisReceipts,
                (SELECT COUNT(*) FROM building_materialization_batches WHERE snapshot_id = ${snapshot.id}) AS materializationReceipts
            `;

            const factResume = capacityGuardProbe();
            yield* store.stageActivationFactBatches(
              fixture.databasePath,
              [
                {
                  batchIndex: 0,
                  edges: [],
                  finalFactBytes,
                  references: [],
                  symbols: [graphSymbol],
                },
              ],
              undefined,
              factResume.guard,
            );
            const physicalFactRows = yield* sql<{
              readonly analysisReceipts: number;
              readonly analysisSymbols: number;
              readonly compactPostings: number;
              readonly compactSnapshots: number;
              readonly compactSymbols: number;
              readonly compactTerms: number;
              readonly lexicalCounters: number;
              readonly lookups: number;
              readonly materializationReceipts: number;
              readonly symbols: number;
            }>`
              SELECT
                (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ${snapshot.id}) AS symbols,
                (SELECT COUNT(*) FROM snapshot_symbol_lookup WHERE snapshot_id = ${snapshot.id}) AS lookups,
                (SELECT COUNT(*) FROM lexical_compact_snapshots WHERE snapshot_id = ${snapshot.id}) AS compactSnapshots,
                (SELECT COUNT(*) FROM lexical_compact_symbols AS symbol
                  JOIN lexical_compact_snapshots AS snapshot ON snapshot.snapshot_key = symbol.snapshot_key
                  WHERE snapshot.snapshot_id = ${snapshot.id}) AS compactSymbols,
                (SELECT COUNT(*) FROM lexical_compact_terms AS term
                  JOIN lexical_compact_snapshots AS snapshot ON snapshot.snapshot_key = term.snapshot_key
                  WHERE snapshot.snapshot_id = ${snapshot.id}) AS compactTerms,
                (SELECT COUNT(*) FROM lexical_compact_postings AS posting
                  JOIN lexical_compact_snapshots AS snapshot ON snapshot.snapshot_key = posting.snapshot_key
                  WHERE snapshot.snapshot_id = ${snapshot.id}) AS compactPostings,
                (SELECT COUNT(*) FROM snapshot_analysis_symbol_counts WHERE snapshot_id = ${snapshot.id}) AS analysisSymbols,
                (SELECT COUNT(*) FROM building_analysis_batches WHERE snapshot_id = ${snapshot.id}) AS analysisReceipts,
                (SELECT COUNT(*) FROM building_materialization_batches WHERE snapshot_id = ${snapshot.id}) AS materializationReceipts,
                (SELECT COUNT(*) FROM building_lexical_counters WHERE snapshot_id = ${snapshot.id}) AS lexicalCounters
            `;

            const finalizePause = capacityGuardProbe('register persistent code graph materialization plan');
            const finalizeFailure = yield* store
              .finalizePersistentMaterializationPlan(fixture.databasePath, 1, finalizePause.guard)
              .pipe(
                Effect.as(undefined as CodeGraphStoreError | undefined),
                Effect.catch(error => Effect.succeed(error)),
              );
            const finalizeResume = capacityGuardProbe();
            yield* store.finalizePersistentMaterializationPlan(fixture.databasePath, 1, finalizeResume.guard);
            yield* store.resolveStagedReferences(fixture.databasePath);

            const publicationPause = capacityGuardProbe('publish persistent code graph snapshot');
            const publicationFailure = yield* store
              .activateStaged(
                fixture.databasePath,
                fixture.identity,
                snapshot,
                undefined,
                undefined,
                undefined,
                publicationPause.guard,
              )
              .pipe(
                Effect.as(undefined as CodeGraphStoreError | undefined),
                Effect.catch(error => Effect.succeed(error)),
              );
            const publicationRowsAfterPause = yield* sql<{
              readonly extractorGenerations: number;
              readonly fileShards: number;
              readonly lexicalFormats: number;
              readonly owners: number;
              readonly state: string;
            }>`
              SELECT snapshot.state,
                (SELECT COUNT(*) FROM snapshot_build_owners WHERE snapshot_id = snapshot.id) AS owners,
                (SELECT COUNT(*) FROM lexical_storage_formats WHERE snapshot_id = snapshot.id) AS lexicalFormats,
                (SELECT COUNT(*) FROM snapshot_extractor_generations WHERE snapshot_id = snapshot.id) AS extractorGenerations,
                (SELECT COUNT(*) FROM snapshot_file_shards WHERE snapshot_id = snapshot.id) AS fileShards
              FROM snapshots AS snapshot WHERE snapshot.id = ${snapshot.id}
            `;
            const publicationResume = capacityGuardProbe();
            yield* store.activateStaged(
              fixture.databasePath,
              fixture.identity,
              snapshot,
              undefined,
              undefined,
              undefined,
              publicationResume.guard,
            );
            const published = yield* sql<{readonly owners: number; readonly state: string}>`
              SELECT snapshot.state,
                (SELECT COUNT(*) FROM snapshot_build_owners WHERE snapshot_id = snapshot.id) AS owners
              FROM snapshots AS snapshot WHERE snapshot.id = ${snapshot.id}
            `;
            return {
              factResume: factResume.boundaries,
              factRowsAfterPause: factRowsAfterPause[0],
              finalizeFailure,
              finalizePause: finalizePause.boundaries,
              finalizeResume: finalizeResume.boundaries,
              invalidFactFailure,
              invalidFactPause: invalidFactPause.boundaries,
              physicalFactRows: physicalFactRows[0],
              preparation: preparation.boundaries,
              publicationFailure,
              publicationPause: publicationPause.boundaries,
              publicationResume: publicationResume.boundaries,
              publicationRowsAfterPause: publicationRowsAfterPause[0],
              published: published[0],
              workspaceFailure,
              workspacePause: workspacePause.boundaries,
              workspaceResume: workspaceResume.boundaries,
              workspaceRowsAfterPause: workspaceRowsAfterPause[0],
            };
          }),
        );

        expect(result.preparation).toEqual([
          {finalFactBytes: 0, operation: 'register persistent code graph materialization plan', rowCount: 2},
          expectedPersistentInventoryBoundary(snapshot.id, [fixture.file]),
        ]);
        expect(isCodeGraphStoreNoSpaceError(result.workspaceFailure)).toBe(true);
        expect(result.workspaceRowsAfterPause).toEqual({dependencies: 0, projects: 0, workspaces: 0});
        const expectedWorkspaceBoundary = expectedPersistentWorkspaceBoundary(snapshot.id, workspace);
        expect(result.workspacePause).toEqual([expectedWorkspaceBoundary]);
        expect(result.workspaceResume).toEqual([expectedWorkspaceBoundary]);

        expect(isCodeGraphStoreNoSpaceError(result.invalidFactFailure)).toBe(true);
        expect(result.invalidFactPause).toHaveLength(1);
        expect(result.invalidFactPause[0]).toMatchObject({
          operation: 'stage persistent code graph facts',
        });
        expect(Number.isNaN(result.invalidFactPause[0].finalFactBytes)).toBe(true);
        expect(result.factRowsAfterPause).toEqual({analysisReceipts: 0, materializationReceipts: 0, symbols: 0});
        expect(result.factResume).toHaveLength(1);
        expect(result.factResume[0]).toMatchObject({
          finalFactBytes,
          operation: 'stage persistent code graph facts',
        });
        expect(result.factResume[0].rowCount).toBeGreaterThanOrEqual(
          Object.values(result.physicalFactRows).reduce((total, value) => total + Number(value), 0),
        );

        const expectedPlanBoundary: CodeGraphDirectPersistentCapacityBoundary = {
          finalFactBytes: 0,
          operation: 'register persistent code graph materialization plan',
          rowCount: 2,
        };
        expect(isCodeGraphStoreNoSpaceError(result.finalizeFailure)).toBe(true);
        expect(result.finalizePause).toEqual([expectedPlanBoundary]);
        expect(result.finalizeResume).toEqual([expectedPlanBoundary]);

        expect(isCodeGraphStoreNoSpaceError(result.publicationFailure)).toBe(true);
        expect(result.publicationRowsAfterPause).toEqual({
          extractorGenerations: 0,
          fileShards: 0,
          lexicalFormats: 0,
          owners: 1,
          state: 'building',
        });
        const expectedPublicationBoundary: CodeGraphDirectPersistentCapacityBoundary = {
          finalFactBytes: 0,
          operation: 'publish persistent code graph snapshot',
          rowCount: snapshot.fileCount + 6,
        };
        expect(result.publicationPause).toEqual([expectedPublicationBoundary]);
        expect(result.publicationResume).toEqual([expectedPublicationBoundary]);
        expect(result.published).toEqual({owners: 0, state: 'ready'});
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.skipIf(process.platform === 'win32')(
    'survives SIGKILL after a committed activation chunk, repairs the abandoned build, and retries',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(materializationFixture);
          const child = Bun.spawn({
            cmd: [
              process.execPath,
              'run',
              join(process.cwd(), 'apps/threadnote/test/helpers/code-graph-activation-kill-child.ts'),
              fixture.databasePath,
            ],
            stderr: 'pipe',
            stdout: 'pipe',
          });

          const marker = yield* Effect.promise(async () => {
            try {
              return await readJsonLine(child.stdout, 30_000);
            } catch (error) {
              child.kill('SIGKILL');
              const stderr = await new Response(child.stderr).text();
              throw TestError.make({
                message: `Activation kill child failed before its committed-chunk marker: ${stderr}`,
                cause: error,
              });
            }
          });
          expect(marker).toEqual({event: 'activation-chunk-committed', rows: 5_000});

          child.kill('SIGKILL');
          yield* Effect.promise(() => child.exited);

          const interruptedDatabase = new Database(fixture.databasePath, {readonly: true, strict: true});
          const interruptedRows = interruptedDatabase
            .query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
            .get(testSnapshotId(5_100)) as {readonly count: number};
          const interruptedState = interruptedDatabase
            .query('SELECT state FROM snapshots WHERE id = ?')
            .get(testSnapshotId(5_100)) as {readonly state: string};
          interruptedDatabase.close(false);
          expect(interruptedRows.count).toBe(5_000);
          expect(interruptedState.state).toBe('building');

          const replacementSymbols = Array.from({length: 5_100}, (_, index) => {
            const id = `replacement-${String(index).padStart(5, '0')}`;
            return symbol(id, id, [`typescript:name:${id}`]);
          });
          const originalSnapshot = {...readySnapshot(fixture.identity, 1, 0), id: testSnapshotId(1)};
          const interruptedSnapshot = {
            ...readySnapshot(fixture.identity, replacementSymbols.length, 0),
            id: testSnapshotId(replacementSymbols.length),
          };
          const store = yield* CodeGraphStore;
          const activeBeforeRepair = yield* store.readySnapshot(fixture.databasePath, fixture.identity.worktreeId);
          const graphBeforeRepair = activeBeforeRepair
            ? yield* store.loadGraph(fixture.databasePath, activeBeforeRepair.id)
            : undefined;
          const healthBeforeRepair = yield* store.diagnose(fixture.databasePath);
          const repaired = yield* store.repair(fixture.databasePath);

          yield* store.withSession(
            fixture.databasePath,
            Effect.gen(function* () {
              yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
              yield* store.stageActivationFacts(fixture.databasePath, replacementSymbols, []);
              yield* store.activateStaged(fixture.databasePath, fixture.identity, interruptedSnapshot);
              yield* store.promote(fixture.databasePath, fixture.identity, interruptedSnapshot.id);
            }),
          );
          const activeAfterRetry = yield* store.readySnapshot(fixture.databasePath, fixture.identity.worktreeId);
          const graphAfterRetry = activeAfterRetry
            ? yield* store.loadGraph(fixture.databasePath, activeAfterRetry.id)
            : undefined;
          const recovered = {
            activeAfterRetry,
            activeBeforeRepair,
            graphAfterRetry,
            graphBeforeRepair,
            healthBeforeRepair,
            repaired,
          };

          expect(recovered.activeBeforeRepair?.id).toBe(originalSnapshot.id);
          expect(recovered.graphBeforeRepair?.symbols.map(entry => entry.id)).toEqual(['original']);
          expect(recovered.healthBeforeRepair?.buildingSnapshots).toBe(1);
          expect(recovered.repaired?.removedSnapshots).toBe(1);
          expect(recovered.activeAfterRetry?.id).toBe(interruptedSnapshot.id);
          expect(recovered.graphAfterRetry?.symbols).toHaveLength(replacementSymbols.length);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    60_000,
  );
});

async function readJsonLine(
  stream: ReadableStream<Uint8Array>,
  timeoutMilliseconds: number,
): Promise<{readonly event?: string; readonly rows?: number}> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const read = async () => {
    let buffered = '';
    while (true) {
      const next = await reader.read();
      if (next.done) throw TestError.make({message: 'Activation kill child exited before reporting progress.'});
      buffered += decoder.decode(next.value, {stream: true});
      const newline = buffered.indexOf('\n');
      if (newline >= 0)
        return JSON.parse(buffered.slice(0, newline)) as {readonly event?: string; readonly rows?: number};
    }
  };
  return Promise.race([
    read(),
    Bun.sleep(timeoutMilliseconds).then(() => {
      throw TestError.make({message: `Timed out after ${timeoutMilliseconds}ms waiting for activation progress.`});
    }),
  ]);
}

async function materializationFixture() {
  const root = await mkdtemp('threadnote-materialization-store-');
  temporaryRoots.push(root);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'materialization-fixture',
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'r'.repeat(64),
    worktreeId: 'w'.repeat(64),
  };
  const file: CodeGraphInventoryFile = {
    blobId: 'b'.repeat(40),
    contentHash: 'h'.repeat(64),
    language: 'typescript',
    mode: '100644',
    path: 'src/materialization.ts',
    size: 128,
    source: 'commit',
  };
  return {databasePath: join(root, 'graph-v3.sqlite'), file, identity, root};
}

function capacityGuardProbe(
  pauseOperation?: CodeGraphDirectPersistentCapacityBoundary['operation'],
  pauseOccurrence = 1,
): {
  readonly boundaries: CodeGraphDirectPersistentCapacityBoundary[];
  readonly guard: CodeGraphDirectPersistentCapacityProtector;
} {
  const boundaries: CodeGraphDirectPersistentCapacityBoundary[] = [];
  let operationOccurrences = 0;
  const guard: CodeGraphDirectPersistentCapacityProtector = <A, E, R>(
    boundary: CodeGraphDirectPersistentCapacityBoundary,
    transaction: Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend((): Effect.Effect<A, E | CodeGraphStoreFailure, R> => {
      boundaries.push({...boundary});
      if (boundary.operation !== pauseOperation) return transaction;
      operationOccurrences += 1;
      return operationOccurrences === pauseOccurrence
        ? Effect.fail(CodeGraphDiskCapacityPressureError.of(boundary.operation))
        : transaction;
    });
  return {boundaries, guard};
}

function mutationCount(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (
      database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM cache_capacity_mutations').get()
        ?.count ?? 0
    );
  } finally {
    database.close(false);
  }
}

function expectedPersistentInventoryBoundary(
  snapshotId: string,
  files: readonly CodeGraphInventoryFile[],
): CodeGraphDirectPersistentCapacityBoundary {
  return {
    finalFactBytes: utf8PayloadBytes(
      files.flatMap(file => [snapshotId, file.path, file.contentHash, file.language, file.mode, file.source]),
    ),
    operation: 'stage persistent code graph inventory',
    rowCount: files.length,
  };
}

function expectedPersistentWorkspaceBoundary(
  snapshotId: string,
  workspace: CodeGraphWorkspace,
): CodeGraphDirectPersistentCapacityBoundary {
  const values: string[] = [];
  for (const scope of workspace.workspaces) {
    values.push(
      snapshotId,
      scope.id,
      scope.buildSystem,
      scope.name,
      scope.root,
      scope.provenance,
      JSON.stringify(scope.diagnostics),
    );
  }
  let rowCount = workspace.workspaces.length;
  for (const project of workspace.projects) {
    values.push(
      snapshotId,
      project.id,
      project.workspaceId,
      project.buildSystem,
      project.kind,
      project.name,
      project.root,
      project.resolutionDomain,
      JSON.stringify(project.languages),
      JSON.stringify(project.sourceRoots),
      JSON.stringify(project.workspaceRoots),
      project.provenance,
      JSON.stringify(project.diagnostics),
    );
    rowCount += 1;
    for (const dependency of project.dependencyDetails) {
      values.push(snapshotId, project.id, dependency.targetId, dependency.provenance);
      if (dependency.evidence !== undefined) values.push(dependency.evidence);
      rowCount += 1;
    }
  }
  return {
    finalFactBytes: utf8PayloadBytes(values),
    operation: 'stage persistent code graph workspace',
    rowCount,
  };
}

function utf8PayloadBytes(values: readonly string[]): number {
  const encoder = new TextEncoder();
  return values.reduce((total, value) => total + encoder.encode(value).byteLength, 0);
}

function persistentPreparationEvidence(
  databasePath: string,
  snapshotId: string,
): {
  readonly distinctFiles: number;
  readonly expectedBatchCount: number | null;
  readonly files: number;
  readonly lexicalCounters: number;
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query(
        `SELECT owner.expected_batch_count AS expectedBatchCount,
           (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = owner.snapshot_id) AS files,
           (SELECT COUNT(DISTINCT path) FROM snapshot_files WHERE snapshot_id = owner.snapshot_id) AS distinctFiles,
           (SELECT COUNT(*) FROM building_lexical_counters WHERE snapshot_id = owner.snapshot_id) AS lexicalCounters
         FROM snapshot_build_owners AS owner
         WHERE owner.snapshot_id = ?`,
      )
      .get(snapshotId) as {
      readonly distinctFiles: number;
      readonly expectedBatchCount: number | null;
      readonly files: number;
      readonly lexicalCounters: number;
    };
  } finally {
    database.close(false);
  }
}

interface CompletedBuildRows {
  readonly batches: number;
  readonly candidates: number;
  readonly refs: number;
}

interface PersistentGraphEvidence {
  readonly distinctFiles: number;
  readonly edges: number;
  readonly files: number;
  readonly symbols: number;
}

function persistentGraphEvidence(databasePath: string, snapshotId: string): PersistentGraphEvidence {
  const database = new Database(databasePath, {readonly: true, strict: true});
  const evidence = database
    .query(
      `SELECT
         (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = snapshot.id) AS files,
         (SELECT COUNT(DISTINCT path) FROM snapshot_files WHERE snapshot_id = snapshot.id) AS distinctFiles,
         (SELECT COUNT(*) FROM symbols WHERE snapshot_id = snapshot.id) AS symbols,
         (SELECT COUNT(*) FROM edges WHERE snapshot_id = snapshot.id) AS edges
       FROM snapshots AS snapshot
       WHERE snapshot.id = ?`,
    )
    .get(snapshotId) as PersistentGraphEvidence;
  database.close(false);
  return evidence;
}

function readCompletedBuildRows(databasePath: string, snapshotId: string): CompletedBuildRows {
  const database = new Database(databasePath, {readonly: true, strict: true});
  const rows = database
    .query(
      `SELECT
         (SELECT COUNT(*) FROM building_references WHERE snapshot_id = ?) AS refs,
         (SELECT COUNT(*) FROM building_reference_candidates WHERE snapshot_id = ?) AS candidates,
         (SELECT COUNT(*) FROM building_materialization_batches WHERE snapshot_id = ?) AS batches`,
    )
    .get(snapshotId, snapshotId, snapshotId) as CompletedBuildRows;
  database.close(false);
  return rows;
}

function readPersistentResolutionState(databasePath: string, snapshotId: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  const state = {
    analysisBatches: database
      .query(
        `SELECT batch_index, batch_fingerprint, symbol_count, edge_count, completed_at
         FROM building_analysis_batches
         WHERE snapshot_id = ?
         ORDER BY batch_index`,
      )
      .all(snapshotId),
    analysisEdgeCounts: database
      .query(
        `SELECT provenance, relation, count, confidence_invalid, confidence_total, lowest_confidence,
           confidence_high, confidence_medium, confidence_low, unresolved_endpoint_count,
           self_loop_count, review_finding_count
         FROM snapshot_analysis_edge_counts
         WHERE snapshot_id = ?
         ORDER BY provenance, relation`,
      )
      .all(snapshotId),
    analysisEdgeHistogram: database
      .query(
        `SELECT provenance, relation, confidence, endpoint_state, count
         FROM snapshot_analysis_edge_histogram
         WHERE snapshot_id = ?
         ORDER BY provenance, relation, confidence, endpoint_state`,
      )
      .all(snapshotId),
    analysisReceipt: database
      .query(
        `SELECT version, symbol_count, edge_count, digest, created_at
         FROM snapshot_analysis_summary_receipts
         WHERE snapshot_id = ?`,
      )
      .all(snapshotId),
    analysisSymbolCounts: database
      .query(
        `SELECT language, kind, count
         FROM snapshot_analysis_symbol_counts
         WHERE snapshot_id = ?
         ORDER BY language, kind`,
      )
      .all(snapshotId),
    candidates: database
      .query(
        `SELECT edge_id, tier, lookup_key
         FROM building_reference_candidates
         WHERE snapshot_id = ?
         ORDER BY edge_id, tier, lookup_key`,
      )
      .all(snapshotId),
    edges: database
      .query(
        `SELECT id, source_id, source_name, relation, target_id, target_name, provenance,
           confidence, evidence_path, evidence_span_json
         FROM edges
         WHERE snapshot_id = ?
         ORDER BY id`,
      )
      .all(snapshotId),
    lookups: database
      .query(
        `SELECT lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
         FROM snapshot_symbol_lookup
         WHERE snapshot_id = ?
         ORDER BY lookup_key, symbol_id`,
      )
      .all(snapshotId),
    references: database
      .query(
        `SELECT edge_id, resolution_domain, exported_only, alias_lookup_keys_json,
           lookup_tiers_json, candidate_count, candidate_payload_bytes,
           source_id, source_name, relation, target_name, provenance, confidence,
           evidence_path, evidence_span_json
         FROM building_references
         WHERE snapshot_id = ?
         ORDER BY edge_id`,
      )
      .all(snapshotId),
  };
  database.close(false);
  return JSON.stringify(state);
}

async function awaitCompletedBuildCleanup(databasePath: string, snapshotId: string): Promise<CompletedBuildRows> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = readCompletedBuildRows(databasePath, snapshotId);
    if (rows.batches === 0 && rows.candidates === 0 && rows.refs === 0) return rows;
    if (Date.now() >= deadline) return rows;
    await Bun.sleep(10);
  }
}

function readLexicalTerms(
  database: Database,
  snapshotId: string,
): readonly {readonly symbol_id: string; readonly term: string; readonly weight: number}[] {
  const statement = codeGraphEffectiveSymbolTermsQueryStatement(snapshotId, undefined);
  return database.query(statement.text).all(...statement.parameters) as readonly {
    readonly symbol_id: string;
    readonly term: string;
    readonly weight: number;
  }[];
}

function structuredCacheFile(path: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: 'a'.repeat(40),
    content,
    contentHash: 'b'.repeat(64),
    language: 'json',
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}

function symbol(id: string, name: string, lookupKeys: readonly string[]): CodeGraphSymbol {
  return {
    contentHash: sha256HexSync(id),
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys,
    name,
    path: 'src/materialization.ts',
    qualifiedName: name,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function edge(id: string, source: CodeGraphSymbol, targetName: string): CodeGraphEdge {
  return {
    confidence: 0.7,
    evidencePath: source.path,
    evidenceSpan: source.span,
    id,
    provenance: 'syntactic',
    relation: 'calls',
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  };
}

function readySnapshot(identity: RepositoryIdentity, symbolCount: number, edgeCount: number): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount,
    extractorSet: 'materialization-test',
    fileCount: 1,
    id: `snapshot-${symbolCount}-${edgeCount}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount,
    worktreeId: identity.worktreeId,
  };
}

function testSnapshotId(value: number): string {
  return `cgsn_${'0'.repeat(40)}-full-${value.toString(16).padStart(16, '0')}`;
}
