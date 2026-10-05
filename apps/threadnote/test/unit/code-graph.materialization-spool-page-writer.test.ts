import {BunFileSystem, BunPath} from '@effect/platform-bun';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Database} from 'bun:sqlite';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES} from '@threadnote/graph/materialization/spool/apply_surfaces';
import {
  finalizeCodeGraphMaterializationSpoolReceipts,
  writeCodeGraphMaterializationSpoolSurfacePage,
} from '@threadnote/graph/store/materialization/spool_apply';
import {
  attachPersistentMaterializationSpool,
  materializationSpoolReadOnlyUri,
} from '@threadnote/graph/store/materialization/spool_lifecycle';

const layer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  SqliteClient.layer({disableWAL: true, filename: ':memory:'}),
);

effectIt.effect('falls back to the verified path when SQLite URI attach is unavailable', () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const spoolPath = '/tmp/threadnote spool.sqlite';
    const sql = {
      unsafe: (_statement: string, parameters: readonly unknown[]) => {
        calls.push(String(parameters[0]));
        return calls.length === 1 ? Effect.fail({code: 'SQLITE_CANTOPEN'}) : Effect.succeed([]);
      },
    } as unknown as SqlClient.SqlClient;

    expect(yield* attachPersistentMaterializationSpool(sql, spoolPath)).toBe('verified-path-fallback');
    expect(calls).toEqual([materializationSpoolReadOnlyUri(spoolPath), spoolPath]);
  }),
);

effectIt.effect('does not weaken the attach mode for non-transient URI failures', () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const sql = {
      unsafe: (_statement: string, parameters: readonly unknown[]) => {
        calls.push(String(parameters[0]));
        return Effect.fail({code: 'SQLITE_READONLY'});
      },
    } as unknown as SqlClient.SqlClient;

    const result = yield* attachPersistentMaterializationSpool(sql, '/tmp/threadnote-spool.sqlite').pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toHaveLength(1);
  }),
);

effectIt.effect('applies compact lexical dictionaries before exact joined postings', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-materialization-spool-page-'});
    const sidecarPath = path.join(root, 'spool.sqlite');
    yield* Effect.sync(() => {
      const sidecar = new Database(sidecarPath, {create: true, strict: true});
      try {
        sidecar.exec(`
          CREATE TABLE materialization_ordered_symbols (id TEXT NOT NULL);
          CREATE TABLE materialization_ordered_terms (term TEXT NOT NULL);
          CREATE TABLE materialization_ordered_symbol_terms (term TEXT NOT NULL, symbol_id TEXT NOT NULL, weight INTEGER NOT NULL);
          INSERT INTO materialization_ordered_symbols (id) VALUES ('symbol-a'), ('symbol-b');
          INSERT INTO materialization_ordered_terms (term) VALUES ('alpha'), ('beta');
          INSERT INTO materialization_ordered_symbol_terms (term, symbol_id, weight) VALUES
            ('alpha', 'symbol-a', 5), ('alpha', 'symbol-b', 3), ('beta', 'symbol-b', 4);
        `);
      } finally {
        sidecar.close();
      }
    });

    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`CREATE TABLE lexical_compact_snapshots (
      snapshot_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_id TEXT UNIQUE NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE lexical_compact_symbols (
      symbol_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_key INTEGER NOT NULL,
      symbol_id TEXT NOT NULL,
      UNIQUE (snapshot_key, symbol_id)
    )`);
    yield* sql.unsafe(`CREATE TABLE lexical_compact_terms (
      term_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_key INTEGER NOT NULL,
      term TEXT NOT NULL,
      UNIQUE (snapshot_key, term)
    )`);
    yield* sql.unsafe(`CREATE TABLE lexical_compact_postings (
      snapshot_key INTEGER NOT NULL,
      term_key INTEGER NOT NULL,
      symbol_key INTEGER NOT NULL,
      weight INTEGER NOT NULL,
      PRIMARY KEY (snapshot_key, term_key, symbol_key)
    ) WITHOUT ROWID`);
    const attachMode = yield* attachPersistentMaterializationSpool(sql, sidecarPath);
    if (attachMode === 'readonly-uri') {
      const sidecarWrite = yield* sql
        .unsafe('DELETE FROM materialization_spool.materialization_ordered_symbols')
        .pipe(Effect.result);
      expect(Result.isFailure(sidecarWrite)).toBe(true);
    }
    const surfaceIndex = (name: string) =>
      CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.findIndex(surface => surface.name === name);
    yield* writeCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', surfaceIndex('lexical_snapshot'), {
      afterRowid: 0,
      rowCount: 1,
    });
    yield* writeCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', surfaceIndex('lexical_symbols'), {
      afterRowid: 0,
      rowCount: 2,
    });
    yield* writeCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', surfaceIndex('lexical_terms'), {
      afterRowid: 0,
      rowCount: 2,
    });
    yield* writeCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', surfaceIndex('symbol_terms'), {
      afterRowid: 0,
      rowCount: 3,
    });
    expect(yield* sql.unsafe('SELECT symbol_key, symbol_id FROM lexical_compact_symbols ORDER BY symbol_key')).toEqual([
      {symbol_id: 'symbol-a', symbol_key: 1},
      {symbol_id: 'symbol-b', symbol_key: 2},
    ]);
    expect(yield* sql.unsafe('SELECT term_key, term FROM lexical_compact_terms ORDER BY term_key')).toEqual([
      {term: 'alpha', term_key: 1},
      {term: 'beta', term_key: 2},
    ]);
    expect(
      yield* sql.unsafe(
        `SELECT term.term, symbol.symbol_id, posting.weight
         FROM lexical_compact_postings AS posting
         JOIN lexical_compact_terms AS term ON term.term_key = posting.term_key
         JOIN lexical_compact_symbols AS symbol ON symbol.symbol_key = posting.symbol_key
         ORDER BY posting.term_key, posting.symbol_key`,
      ),
    ).toEqual([
      {symbol_id: 'symbol-a', term: 'alpha', weight: 5},
      {symbol_id: 'symbol-b', term: 'alpha', weight: 3},
      {symbol_id: 'symbol-b', term: 'beta', weight: 4},
    ]);
    yield* sql.unsafe('DETACH DATABASE materialization_spool');
  }).pipe(provideTestLayer(layer)),
);

effectIt.effect('publishes exact deferred receipts and aggregate analysis atomically', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-materialization-spool-receipt-'});
    const sidecarPath = path.join(root, 'spool.sqlite');
    yield* Effect.sync(() => {
      const sidecar = new Database(sidecarPath, {create: true, strict: true});
      try {
        sidecar.exec(`
          CREATE TABLE materialization_spool_batches (
            batch_index INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, fact_bytes INTEGER NOT NULL,
            source_bytes INTEGER NOT NULL, row_count INTEGER NOT NULL, symbol_count INTEGER NOT NULL,
            edge_count INTEGER NOT NULL, term_count INTEGER NOT NULL, lookup_count INTEGER NOT NULL,
            reference_count INTEGER NOT NULL, candidate_count INTEGER NOT NULL, reexport_count INTEGER NOT NULL
          );
          INSERT INTO materialization_spool_batches VALUES
            (0, '${'b'.repeat(64)}', 100, 200, 7, 1, 2, 2, 2, 1, 3, 1);
          CREATE TABLE materialization_ordered_symbols (id TEXT NOT NULL);
          CREATE TABLE materialization_ordered_terms (term TEXT NOT NULL);
          CREATE TABLE materialization_ordered_symbol_terms (term TEXT NOT NULL, symbol_id TEXT NOT NULL, weight INTEGER NOT NULL);
          INSERT INTO materialization_ordered_symbols VALUES ('symbol-a');
          INSERT INTO materialization_ordered_terms VALUES ('alpha'), ('beta');
          INSERT INTO materialization_ordered_symbol_terms VALUES ('alpha', 'symbol-a', 5), ('beta', 'symbol-a', 4);
        `);
      } finally {
        sidecar.close();
      }
    });

    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe('CREATE TABLE snapshots (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL)');
    yield* sql.unsafe(`CREATE TABLE snapshot_build_owners (
      snapshot_id TEXT PRIMARY KEY NOT NULL,
      owner_token TEXT NOT NULL,
      expected_batch_count INTEGER
    ) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TABLE building_materialization_spool_surfaces (
      snapshot_id TEXT NOT NULL, surface_index INTEGER NOT NULL, spool_identity TEXT NOT NULL,
      surface_name TEXT NOT NULL, row_count INTEGER NOT NULL, next_page_index INTEGER NOT NULL,
      applied_row_count INTEGER NOT NULL, complete INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, surface_index)
    ) WITHOUT ROWID`);
    yield* sql.unsafe('CREATE TABLE symbols (snapshot_id TEXT NOT NULL, language TEXT NOT NULL, kind TEXT NOT NULL)');
    yield* sql.unsafe(`CREATE TABLE edges (
      snapshot_id TEXT NOT NULL, source_id TEXT, target_id TEXT, provenance TEXT NOT NULL,
      relation TEXT NOT NULL, confidence REAL NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE building_references (
      snapshot_id TEXT NOT NULL, provenance TEXT NOT NULL, relation TEXT NOT NULL, confidence REAL NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE snapshot_analysis_symbol_counts (
      snapshot_id TEXT NOT NULL, language TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, language, kind)
    ) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TABLE snapshot_analysis_edge_histogram (
      snapshot_id TEXT NOT NULL, provenance TEXT NOT NULL, relation TEXT NOT NULL,
      confidence REAL NOT NULL, endpoint_state INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, provenance, relation, confidence, endpoint_state)
    ) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TABLE building_analysis_batches (
      snapshot_id TEXT NOT NULL, batch_index INTEGER NOT NULL, batch_fingerprint TEXT NOT NULL,
      symbol_count INTEGER NOT NULL, edge_count INTEGER NOT NULL, completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TABLE building_materialization_batches (
      snapshot_id TEXT NOT NULL, batch_index INTEGER NOT NULL, batch_fingerprint TEXT NOT NULL,
      symbol_count INTEGER NOT NULL, edge_count INTEGER NOT NULL, term_count INTEGER NOT NULL,
      lookup_count INTEGER NOT NULL, reference_count INTEGER NOT NULL, candidate_count INTEGER NOT NULL,
      reexport_count INTEGER NOT NULL, completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TABLE building_lexical_counters (
      snapshot_id TEXT PRIMARY KEY NOT NULL, completed_batch_count INTEGER NOT NULL,
      posting_count INTEGER NOT NULL, symbol_count INTEGER NOT NULL, term_count INTEGER NOT NULL
    ) WITHOUT ROWID`);
    yield* sql.unsafe("INSERT INTO snapshots VALUES ('snapshot', 'building')");
    yield* sql.unsafe("INSERT INTO snapshot_build_owners VALUES ('snapshot', 'owner', 1)");
    yield* sql.unsafe("INSERT INTO building_lexical_counters VALUES ('snapshot', 0, 0, 0, 0)");
    yield* sql.unsafe("INSERT INTO symbols VALUES ('snapshot', 'typescript', 'function')");
    yield* sql.unsafe("INSERT INTO edges VALUES ('snapshot', 'source', 'target', 'syntactic', 'calls', 0.75)");
    yield* sql.unsafe("INSERT INTO building_references VALUES ('snapshot', 'declared', 'references', 0.5)");
    const identity = 'a'.repeat(64);
    yield* sql.unsafe(
      `INSERT INTO building_materialization_spool_surfaces (
         snapshot_id, surface_index, spool_identity, surface_name, row_count,
         next_page_index, applied_row_count, complete
       ) VALUES ${CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.map(() => "('snapshot', ?, ?, ?, 0, 0, 0, 1)").join(', ')}`,
      CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.flatMap((surface, index) => [index, identity, surface.name]),
    );
    yield* attachPersistentMaterializationSpool(sql, sidecarPath);
    expect(yield* finalizeCodeGraphMaterializationSpoolReceipts(sql, 'snapshot', 'owner', identity)).toBe('finalized');
    expect(yield* finalizeCodeGraphMaterializationSpoolReceipts(sql, 'snapshot', 'owner', identity)).toBe('resumed');
    expect(
      yield* sql.unsafe(
        'SELECT completed_batch_count, posting_count, symbol_count, term_count FROM building_lexical_counters',
      ),
    ).toEqual([{completed_batch_count: 1, posting_count: 2, symbol_count: 1, term_count: 2}]);
    expect(
      yield* sql.unsafe(
        'SELECT provenance, endpoint_state, count FROM snapshot_analysis_edge_histogram ORDER BY provenance',
      ),
    ).toEqual([
      {count: 1, endpoint_state: 1, provenance: 'declared'},
      {count: 1, endpoint_state: 0, provenance: 'syntactic'},
    ]);
    expect(
      yield* sql.unsafe('SELECT batch_fingerprint, symbol_count, edge_count FROM building_materialization_batches'),
    ).toEqual([{batch_fingerprint: 'b'.repeat(64), edge_count: 2, symbol_count: 1}]);
    yield* sql.unsafe('DETACH DATABASE materialization_spool');
  }).pipe(provideTestLayer(layer)),
);
