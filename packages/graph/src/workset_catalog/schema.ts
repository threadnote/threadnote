import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION} from './layout.js';
import {migrateWorksetScopeReceipts} from './scope_receipt.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
} from './types.js';

export const CODE_GRAPH_WORKSET_CATALOG_PAGE_SIZE_BYTES = 4_096;
const CATALOG_PAGE_COUNT_MAXIMUM =
  CODE_GRAPH_WORKSET_CATALOG_LIMITS.catalogPhysicalBytesMaximum / CODE_GRAPH_WORKSET_CATALOG_PAGE_SIZE_BYTES;

export const configureCodeGraphWorksetCatalogReadConnection = Effect.fn(
  'codeGraphWorksetCatalog.configureReadConnection',
)(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe('PRAGMA query_only = ON');
});

export const configureCodeGraphWorksetCatalogWriteConnection = Effect.fn(
  'codeGraphWorksetCatalog.configureWriteConnection',
)(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe(`PRAGMA page_size = ${CODE_GRAPH_WORKSET_CATALOG_PAGE_SIZE_BYTES}`);
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
  yield* sql.unsafe('PRAGMA synchronous = FULL');
  yield* sql.unsafe('PRAGMA wal_autocheckpoint = 1000');
  yield* sql.unsafe('PRAGMA journal_size_limit = 67108864');
  yield* sql.unsafe(`PRAGMA max_page_count = ${CATALOG_PAGE_COUNT_MAXIMUM}`);
});

export const initializeCodeGraphWorksetCatalogSchema = Effect.fn('codeGraphWorksetCatalog.initializeSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* configureCodeGraphWorksetCatalogWriteConnection(sql);
  const pageSize = yield* readSqlitePragmaInteger(sql, 'page_size');
  const maximumPages = yield* readSqlitePragmaInteger(sql, 'max_page_count');
  if (pageSize !== CODE_GRAPH_WORKSET_CATALOG_PAGE_SIZE_BYTES || maximumPages !== CATALOG_PAGE_COUNT_MAXIMUM) {
    return yield* CodeGraphWorksetCatalogError.of(
      'incompatible',
      'Workset catalog physical capacity settings are incompatible with this release.',
    );
  }
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS catalog_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql`
    INSERT INTO catalog_metadata (key, value)
    VALUES ('schema_version', ${String(CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  yield* sql`
    INSERT INTO catalog_metadata (key, value)
    VALUES ('projector_version', ${String(CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  const schemaVersion = yield* readCodeGraphWorksetCatalogMetadataInteger(sql, 'schema_version');
  if (schemaVersion !== CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION) {
    return yield* CodeGraphWorksetCatalogError.of(
      'incompatible',
      `Workset catalog schema ${String(schemaVersion ?? 'unknown')} is incompatible with ${CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION}.`,
    );
  }
  const projectorVersion = yield* readCodeGraphWorksetCatalogMetadataInteger(sql, 'projector_version');
  if (projectorVersion !== CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION) {
    return yield* CodeGraphWorksetCatalogError.of(
      'incompatible',
      `Workset catalog projector ${String(projectorVersion ?? 'unknown')} is incompatible with ${CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION}.`,
    );
  }
  yield* createCodeGraphWorksetCatalogTables(sql);
  yield* migrateWorksetScopeReceipts(sql);
  yield* sql.unsafe(`PRAGMA user_version = ${CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION}`);
});

function readSqlitePragmaInteger(sql: SqlClient.SqlClient, pragma: 'max_page_count' | 'page_size') {
  return sql.unsafe<Record<string, unknown>>(`PRAGMA ${pragma}`).pipe(
    Effect.flatMap(rows => {
      const value = rows[0]?.[pragma];
      const parsed = typeof value === 'bigint' ? Number(value) : value;
      return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0
        ? Effect.succeed(parsed)
        : Effect.fail(CodeGraphWorksetCatalogError.of('corrupt', 'Workset catalog capacity metadata is invalid.'));
    }),
  );
}

export const inspectCodeGraphWorksetCatalogSchemaVersion = Effect.fn('codeGraphWorksetCatalog.inspectSchemaVersion')(
  function* (sql: SqlClient.SqlClient) {
    return yield* readCodeGraphWorksetCatalogMetadataInteger(sql, 'schema_version');
  },
);

export const inspectCodeGraphWorksetCatalogPageSize = Effect.fn('codeGraphWorksetCatalog.inspectPageSize')(function* (
  sql: SqlClient.SqlClient,
) {
  return yield* readSqlitePragmaInteger(sql, 'page_size');
});

function createCodeGraphWorksetCatalogTables(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS repository_snapshots (
        projection_digest TEXT PRIMARY KEY NOT NULL CHECK(length(projection_digest) = 64),
        repository_id TEXT NOT NULL CHECK(length(repository_id) = 64),
        checkout_id TEXT NOT NULL CHECK(length(checkout_id) = 64),
        worktree_id TEXT NOT NULL CHECK(length(worktree_id) = 64),
        snapshot_id TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
        commit_id TEXT NOT NULL CHECK(length(commit_id) IN (40, 64)),
        extractor_generation INTEGER NOT NULL CHECK(extractor_generation > 0),
        projector_version INTEGER NOT NULL CHECK(projector_version > 0),
        component_count INTEGER NOT NULL CHECK(component_count >= 0),
        symbol_count INTEGER NOT NULL CHECK(symbol_count >= 0),
        state TEXT NOT NULL CHECK(state IN ('staging', 'ready', 'reclaiming')),
        created_at TEXT NOT NULL,
        UNIQUE(checkout_id, worktree_id, snapshot_id, projector_version)
      )
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS catalog_capacity (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        bridge_logical_bytes INTEGER NOT NULL CHECK(bridge_logical_bytes >= 0),
        projection_logical_bytes INTEGER NOT NULL
          CHECK(projection_logical_bytes >= 0),
        CHECK(bridge_logical_bytes + projection_logical_bytes <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.catalogPhysicalBytesMaximum})
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(
      `INSERT OR IGNORE INTO catalog_capacity (singleton, bridge_logical_bytes, projection_logical_bytes)
       VALUES (1, 0, 0)`,
    );
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS routing_symbols (
        projection_digest TEXT NOT NULL REFERENCES repository_snapshots(projection_digest) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT NOT NULL,
        exported INTEGER NOT NULL CHECK(exported IN (0, 1)),
        package_name TEXT,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        span_line INTEGER NOT NULL CHECK(span_line >= 0),
        span_column INTEGER NOT NULL CHECK(span_column >= 0),
        span_end_line INTEGER NOT NULL CHECK(span_end_line >= span_line),
        span_end_column INTEGER NOT NULL CHECK(span_end_column >= 0),
        PRIMARY KEY (projection_digest, node_id)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS routing_projection_storage (
        projection_digest TEXT PRIMARY KEY NOT NULL
          REFERENCES repository_snapshots(projection_digest) ON DELETE CASCADE,
        logical_bytes INTEGER NOT NULL
          CHECK(logical_bytes >= 0 AND logical_bytes <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionBytesMaximum}),
        reserved_bytes INTEGER NOT NULL
          CHECK(reserved_bytes >= logical_bytes AND reserved_bytes <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionBytesMaximum}),
        staging_token TEXT CHECK(staging_token IS NULL OR length(staging_token) = 64)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS routing_projection_retirements (
        projection_digest TEXT PRIMARY KEY NOT NULL
          REFERENCES repository_snapshots(projection_digest) ON DELETE CASCADE,
        requested_at TEXT NOT NULL
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS routing_lookup_keys (
        projection_digest TEXT NOT NULL,
        node_id TEXT NOT NULL,
        lookup_key TEXT NOT NULL,
        PRIMARY KEY (projection_digest, node_id, lookup_key),
        FOREIGN KEY (projection_digest, node_id)
          REFERENCES routing_symbols(projection_digest, node_id) ON DELETE CASCADE
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS routing_terms (
        projection_digest TEXT NOT NULL,
        node_id TEXT NOT NULL,
        term TEXT NOT NULL,
        weight REAL NOT NULL CHECK(weight > 0 AND weight <= 1000),
        PRIMARY KEY (projection_digest, node_id, term),
        FOREIGN KEY (projection_digest, node_id)
          REFERENCES routing_symbols(projection_digest, node_id) ON DELETE CASCADE
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS routing_exact_keys (
        projection_digest TEXT NOT NULL,
        node_id TEXT NOT NULL,
        key_kind TEXT NOT NULL CHECK(key_kind IN ('lookup-key', 'qualified-name', 'name', 'path', 'path-suffix', 'package')),
        exact_key TEXT NOT NULL,
        PRIMARY KEY (projection_digest, node_id, key_kind, exact_key),
        FOREIGN KEY (projection_digest, node_id)
          REFERENCES routing_symbols(projection_digest, node_id) ON DELETE CASCADE
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS workset_generations (
        id TEXT PRIMARY KEY NOT NULL,
        workset_name TEXT NOT NULL,
        manifest_digest TEXT NOT NULL CHECK(length(manifest_digest) = 64),
        generation_digest TEXT NOT NULL UNIQUE CHECK(length(generation_digest) = 64),
        state TEXT NOT NULL CHECK(state IN ('staging', 'ready', 'retired')),
        member_count INTEGER NOT NULL CHECK(member_count >= 0),
        created_at TEXT NOT NULL,
        published_at TEXT
      )
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS workset_generation_members (
        generation_id TEXT NOT NULL REFERENCES workset_generations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        repository_key TEXT NOT NULL,
        repository_id TEXT NOT NULL CHECK(length(repository_id) = 64),
        snapshot_id TEXT NOT NULL,
        projection_digest TEXT NOT NULL REFERENCES repository_snapshots(projection_digest),
        PRIMARY KEY (generation_id, ordinal),
        UNIQUE (generation_id, repository_key)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS published_worksets (
        workset_name TEXT PRIMARY KEY NOT NULL,
        generation_id TEXT NOT NULL UNIQUE REFERENCES workset_generations(id),
        published_at TEXT NOT NULL
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS qualified_refs (
        ref TEXT PRIMARY KEY NOT NULL CHECK(length(ref) = 44 AND substr(ref, 1, 4) = 'cgr_'),
        repository_id TEXT NOT NULL CHECK(length(repository_id) = 64),
        node_id TEXT NOT NULL CHECK(length(node_id) IN (36, 44, 68)),
        created_at TEXT NOT NULL,
        UNIQUE(repository_id, node_id)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS result_sets (
        id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 46 AND substr(id, 1, 6) = 'cgwrs_'),
        workset_name TEXT NOT NULL,
        generation_id TEXT NOT NULL REFERENCES workset_generations(id) ON DELETE RESTRICT,
        generation_digest TEXT NOT NULL CHECK(length(generation_digest) = 64),
        projector_version INTEGER NOT NULL CHECK(projector_version > 0),
        result_set_token TEXT NOT NULL UNIQUE CHECK(length(result_set_token) = 64),
        sequence_digest TEXT NOT NULL CHECK(length(sequence_digest) = 64),
        envelope_json TEXT NOT NULL,
        envelope_bytes INTEGER NOT NULL CHECK(envelope_bytes > 0 AND envelope_bytes <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum}),
        envelope_digest TEXT NOT NULL CHECK(length(envelope_digest) = 64),
        card_count INTEGER NOT NULL CHECK(card_count >= 0 AND card_count <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardsMaximum}),
        total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0 AND total_bytes <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum}),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS result_cards (
        result_set_id TEXT NOT NULL REFERENCES result_sets(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardsMaximum}),
        card_id TEXT NOT NULL CHECK(length(card_id) = 45 AND substr(card_id, 1, 5) = 'cgec_'),
        qualified_ref TEXT NOT NULL REFERENCES qualified_refs(ref),
        repository_key TEXT NOT NULL,
        card_json TEXT NOT NULL,
        card_bytes INTEGER NOT NULL CHECK(card_bytes > 0 AND card_bytes <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardBytesMaximum}),
        card_digest TEXT NOT NULL CHECK(length(card_digest) = 64),
        PRIMARY KEY (result_set_id, ordinal),
        UNIQUE (result_set_id, card_id)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS result_set_cursors (
        cursor TEXT PRIMARY KEY NOT NULL CHECK(length(cursor) = 45 AND substr(cursor, 1, 5) = 'cgwc_'),
        result_set_id TEXT NOT NULL REFERENCES result_sets(id) ON DELETE CASCADE,
        offset INTEGER NOT NULL CHECK(offset >= 0 AND offset <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetCardsMaximum}),
        UNIQUE (result_set_id, offset)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS cross_repository_bridge_sets (
        generation_id TEXT PRIMARY KEY NOT NULL
          REFERENCES workset_generations(id) ON DELETE CASCADE,
        resolver_version INTEGER NOT NULL CHECK(resolver_version > 0),
        bridge_count INTEGER NOT NULL
          CHECK(bridge_count >= 0 AND bridge_count <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration}),
        bridge_bytes INTEGER NOT NULL
          CHECK(bridge_bytes >= 0 AND bridge_bytes <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgeSetBytesMaximum}),
        bridge_set_digest TEXT NOT NULL CHECK(length(bridge_set_digest) = 64),
        coverage_state TEXT NOT NULL CHECK(coverage_state IN ('complete', 'partial', 'failed')),
        repository_count INTEGER NOT NULL
          CHECK(repository_count >= 0 AND repository_count <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration}),
        repositories_read INTEGER NOT NULL
          CHECK(repositories_read >= 0 AND repositories_read <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration}),
        failed_repository_count INTEGER NOT NULL
          CHECK(failed_repository_count >= 0 AND failed_repository_count <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration}),
        rejection_count INTEGER NOT NULL CHECK(rejection_count >= 0),
        diagnostic_codes_json TEXT NOT NULL CHECK(length(diagnostic_codes_json) <= 4096),
        replaced_at TEXT NOT NULL
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS cross_repository_bridges (
        generation_id TEXT NOT NULL
          REFERENCES cross_repository_bridge_sets(generation_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL
          CHECK(ordinal >= 0 AND ordinal < ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration}),
        bridge_id TEXT NOT NULL CHECK(length(bridge_id) = 68 AND substr(bridge_id, 1, 4) = 'cgb_'),
        identity TEXT NOT NULL,
        moniker_kind TEXT NOT NULL CHECK(moniker_kind IN ('package', 'file', 'message', 'service', 'rpc')),
        relation TEXT NOT NULL CHECK(relation IN ('depends_on', 'imports')),
        scheme TEXT NOT NULL CHECK(scheme IN ('package', 'protobuf')),
        resolution_domain TEXT NOT NULL CHECK(resolution_domain IN ('package:npm', 'protobuf')),
        provenance TEXT NOT NULL CHECK(provenance = 'declared'),
        resolver_reason TEXT NOT NULL
          CHECK(resolver_reason IN ('declared-npm-package-compatible', 'exact-protobuf-identity')),
        resolver_version INTEGER NOT NULL CHECK(resolver_version > 0),
        source_repository_id TEXT NOT NULL CHECK(length(source_repository_id) = 64),
        source_repository_key TEXT NOT NULL,
        source_snapshot_id TEXT NOT NULL,
        source_moniker_id TEXT NOT NULL CHECK(length(source_moniker_id) = 68 AND substr(source_moniker_id, 1, 4) = 'cgm_'),
        source_reference_kind TEXT NOT NULL CHECK(source_reference_kind IN ('component', 'qualified-ref')),
        source_reference TEXT NOT NULL,
        source_evidence_path TEXT NOT NULL,
        target_repository_id TEXT NOT NULL CHECK(length(target_repository_id) = 64),
        target_repository_key TEXT NOT NULL,
        target_snapshot_id TEXT NOT NULL,
        target_moniker_id TEXT NOT NULL CHECK(length(target_moniker_id) = 68 AND substr(target_moniker_id, 1, 4) = 'cgm_'),
        target_reference_kind TEXT NOT NULL CHECK(target_reference_kind IN ('component', 'qualified-ref')),
        target_reference TEXT NOT NULL,
        target_evidence_path TEXT NOT NULL,
        bridge_json TEXT NOT NULL,
        bridge_bytes INTEGER NOT NULL
          CHECK(bridge_bytes > 0 AND bridge_bytes <= ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgeRecordBytesMaximum}),
        bridge_digest TEXT NOT NULL CHECK(length(bridge_digest) = 64),
        PRIMARY KEY (generation_id, ordinal),
        UNIQUE (generation_id, bridge_id)
      ) WITHOUT ROWID
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_symbols_qualified_name
      ON routing_symbols(qualified_name, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_symbols_name
      ON routing_symbols(name, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_symbols_package_path
      ON routing_symbols(package_name, path, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_symbols_path
      ON routing_symbols(path, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_lookup_keys_exact
      ON routing_lookup_keys(lookup_key, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_terms_term
      ON routing_terms(term, weight DESC, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_exact_keys_exact
      ON routing_exact_keys(exact_key, key_kind, projection_digest, node_id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS workset_generations_retirement
      ON workset_generations(state, created_at, id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS workset_generation_members_projection
      ON workset_generation_members(projection_digest, generation_id)
    `);
    yield* sql.unsafe('DROP INDEX IF EXISTS workset_generations_state_created');
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS routing_projection_retirements_requested
      ON routing_projection_retirements(requested_at, projection_digest)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS qualified_refs_repository_node
      ON qualified_refs(repository_id, node_id, ref)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS result_sets_expiry
      ON result_sets(expires_at, created_at, id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS result_sets_generation
      ON result_sets(generation_id, id)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS result_cards_qualified_ref
      ON result_cards(qualified_ref, result_set_id, ordinal)
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS cross_repository_bridges_source_endpoint
      ON cross_repository_bridges(
        generation_id, source_repository_id, source_snapshot_id,
        source_reference_kind, source_reference, ordinal, bridge_id
      )
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS cross_repository_bridges_target_endpoint
      ON cross_repository_bridges(
        generation_id, target_repository_id, target_snapshot_id,
        target_reference_kind, target_reference, ordinal, bridge_id
      )
    `);
  });
}

function readCodeGraphWorksetCatalogMetadataInteger(sql: SqlClient.SqlClient, key: string) {
  return sql.unsafe<{readonly value: unknown}>('SELECT value FROM catalog_metadata WHERE key = ? LIMIT 1', [key]).pipe(
    Effect.map(rows => {
      const value = rows[0]?.value;
      if (typeof value !== 'string' || !/^\d{1,9}$/u.test(value)) return undefined;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }),
  );
}
