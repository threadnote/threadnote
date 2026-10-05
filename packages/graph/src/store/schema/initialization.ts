import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {REMOVED_VIEWS_TABLE_SQL} from '../removed/view_schema_contracts.js';
import {inspectBoundedSchemaMetadataValue} from './metadata.js';
import {configureConnection} from '../session.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CODE_GRAPH_SCHEMA_VERSION, CodeGraphStoreError} from '../../types.js';
import {
  ensureCurrentCodeGraphQueryIndexes,
  migratePersistentExtensionTables,
  preflightRemovedViewCleanupSchema,
} from './migration.js';
import {CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL, ensureColumn, ensureSnapshotLeaseSchema} from './core.js';
import {ensureInitialReconciliationIndexes} from '../reconciliation/core.js';
import {ensureCodeGraphFileBlobAuthority} from '../cache/authority.js';
import {assertCodeGraphSnapshotFileCitationSchemaMigratable} from '../file_alias_schema.js';
import {codeGraphSchemaInitializationReceiptCurrent, recordCodeGraphSchemaInitializationReceipt} from './receipt.js';
import {ensureCodeGraphQueryIndexes} from '../query/indexes.js';

/** Exact read-only admission shared by cleanup writers and both health paths. */

export const CODE_GRAPH_DATABASE_PAGE_SIZE_BYTES = 8 * 1_024;
const CODE_GRAPH_WAL_AUTOCHECKPOINT_BYTES = 4_096 * 1_000;

const initializeSchema = Effect.fn('codeGraph.initializeSchema')(function* (sql: SqlClient.SqlClient) {
  yield* configureConnection(sql);
  // Page size is immutable once the database owns schema pages. New stores
  // use a denser B-tree fanout for the wide, hash-keyed graph tables while
  // existing stores retain their on-disk contract. Keep the WAL checkpoint
  // byte window constant rather than silently doubling it with the page size.
  const pageCountRows = yield* sql.unsafe<{readonly page_count: number}>('PRAGMA main.page_count');
  const pageCount = Number(pageCountRows[0]?.page_count ?? -1);
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
    return yield* CodeGraphStoreError.of('Code graph SQLite page count is invalid.');
  }
  if (pageCount === 0) yield* sql.unsafe(`PRAGMA main.page_size = ${CODE_GRAPH_DATABASE_PAGE_SIZE_BYTES}`);
  const pageSizeRows = yield* sql.unsafe<{readonly page_size: number}>('PRAGMA main.page_size');
  const pageSize = Number(pageSizeRows[0]?.page_size ?? 0);
  if (!Number.isSafeInteger(pageSize) || pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
    return yield* CodeGraphStoreError.of('Code graph SQLite page size is invalid.');
  }
  // A matching receipt binds the last complete validation to SQLite's
  // persistent main-schema cookie and separately revalidates mutable authority
  // metadata. Any ordinary DDL or contract revision change falls through to
  // the existing fail-closed initializer before graph rows can be mutated.
  const receiptCurrent = yield* codeGraphSchemaInitializationReceiptCurrent(sql);
  if (!receiptCurrent) {
    // Refuse a drifted cleanup authority surface before any initialization DDL
    // or graph-row mutation. Unlike reconstructible build extensions, this
    // queue is coupled to immutable removal tombstones and is never dropped.
    yield* preflightRemovedViewCleanupSchema(sql);
  }
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
  // Explicit whole-WAL checkpoints can monopolize the synchronous SQLite
  // connection for longer than the build heartbeat. Committed WAL records are
  // already durable; keep routine checkpoint work bounded to SQLite's default
  // 1,000-page auto-checkpoint cadence instead.
  yield* sql.unsafe(
    `PRAGMA wal_autocheckpoint = ${Math.max(1, Math.floor(CODE_GRAPH_WAL_AUTOCHECKPOINT_BYTES / pageSize))}`,
  );
  if (receiptCurrent) return;
  yield* initializeSchemaFully(sql);
  yield* recordCodeGraphSchemaInitializationReceipt(sql);
});

const initializeSchemaFully = Effect.fn('codeGraph.initializeSchemaFully')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `);
  yield* sql`
    INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', ${String(CODE_GRAPH_SCHEMA_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  const admittedSchemaVersion = yield* inspectBoundedSchemaMetadataValue(sql, 'schema_version', 16);
  if (admittedSchemaVersion.state !== 'recorded' || admittedSchemaVersion.value !== String(CODE_GRAPH_SCHEMA_VERSION)) {
    return yield* CodeGraphStoreError.of(
      `Code graph schema ${admittedSchemaVersion.state === 'recorded' ? admittedSchemaVersion.value : 'unknown'} is incompatible with ${CODE_GRAPH_SCHEMA_VERSION}.`,
    );
  }
  const snapshotFileCitationAuthorization = yield* assertCodeGraphSnapshotFileCitationSchemaMigratable(sql);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      object_format TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      worktree_id TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      graph_content_id TEXT,
      base_snapshot_id TEXT,
      extractor_set TEXT NOT NULL,
      dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
      overlay_fingerprint TEXT,
      state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed', 'retired')),
      file_count INTEGER NOT NULL CHECK (file_count >= 0),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failure_summary TEXT
    )
  `);
  yield* ensureColumn(sql, 'snapshots', 'graph_content_id', 'TEXT');
  // Older graph-v3 databases predate explicit content identity. Their snapshot
  // ID is a collision-safe migration sentinel; freshly observed snapshots use
  // the commit-independent cgc_ identity generated by the indexer.
  yield* sql.unsafe('UPDATE snapshots SET graph_content_id = id WHERE graph_content_id IS NULL');
  // The cleanup extension installs bounded revocation triggers on this durable
  // tombstone authority, so the core table must exist before the atomic r8
  // table/index/trigger/sequence publication transaction begins.
  yield* sql.unsafe(REMOVED_VIEWS_TABLE_SQL);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_extractor_generations (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS active_snapshots (
      worktree_id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      activated_at TEXT NOT NULL
    )
  `);
  // This intentionally has no snapshot foreign key. The removal evidence must
  // survive bounded physical reclamation so an older runtime cannot resurrect
  // a removed view by republishing its legacy active pointer.
  yield* sql.unsafe(REMOVED_VIEWS_TABLE_SQL);
  yield* sql.unsafe(
    CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL.replace('CREATE TRIGGER', 'CREATE TRIGGER IF NOT EXISTS'),
  );
  yield* ensureSnapshotLeaseSchema(sql);
  yield* ensureInitialReconciliationIndexes(sql);
  yield* migratePersistentExtensionTables(sql, snapshotFileCitationAuthorization);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_file_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS file_blobs (
      content_hash TEXT NOT NULL,
      extractor_set TEXT NOT NULL,
      path_hint TEXT NOT NULL,
      blob_id TEXT,
      reuse_class TEXT,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash, extractor_set, path_hint)
    ) WITHOUT ROWID
  `);
  yield* ensureColumn(sql, 'file_blobs', 'blob_id', 'TEXT');
  yield* ensureColumn(sql, 'file_blobs', 'reuse_class', 'TEXT');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS symbols (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      arity INTEGER,
      lookup_keys_json TEXT NOT NULL,
      resolution_domain TEXT,
      resolution_scope_id TEXT,
      package_name TEXT,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* ensureColumn(sql, 'symbols', 'resolution_scope_id', 'TEXT');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_scopes (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      build_system TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_components (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      build_system TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      languages_json TEXT NOT NULL,
      source_roots_json TEXT NOT NULL,
      workspace_roots_json TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_component_dependencies (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      source_component_id TEXT NOT NULL,
      target_component_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      evidence TEXT,
      PRIMARY KEY (snapshot_id, source_component_id, target_component_id, provenance)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_symbol_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      symbol_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS edges (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_edge_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id)
    ) WITHOUT ROWID
  `);
  // Compact, snapshot-owned analysis facts. Building snapshots may contain
  // partial rows, but readers require a matching ready-summary receipt.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_analysis_symbol_counts (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, language, kind)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_analysis_edge_histogram (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence REAL NOT NULL,
      endpoint_state INTEGER NOT NULL CHECK (endpoint_state IN (0, 1, 2)),
      count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, provenance, relation, confidence, endpoint_state)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_analysis_edge_counts (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      count INTEGER NOT NULL CHECK (count >= 0),
      confidence_invalid INTEGER NOT NULL CHECK (confidence_invalid >= 0),
      confidence_total REAL NOT NULL,
      lowest_confidence REAL NOT NULL,
      confidence_high INTEGER NOT NULL CHECK (confidence_high >= 0),
      confidence_medium INTEGER NOT NULL CHECK (confidence_medium >= 0),
      confidence_low INTEGER NOT NULL CHECK (confidence_low >= 0),
      unresolved_endpoint_count INTEGER NOT NULL CHECK (unresolved_endpoint_count >= 0),
      self_loop_count INTEGER NOT NULL CHECK (self_loop_count >= 0),
      review_finding_count INTEGER NOT NULL CHECK (review_finding_count >= 0),
      PRIMARY KEY (snapshot_id, provenance, relation)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_component_edge_aggregates (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      source_component_id TEXT NOT NULL,
      target_component_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      count INTEGER NOT NULL CHECK (count > 0),
      confidence REAL NOT NULL,
      PRIMARY KEY (snapshot_id, source_component_id, target_component_id, provenance, relation)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_component_edge_aggregate_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version = 1),
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_analysis_summary_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version = 1),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS building_analysis_batches (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      batch_fingerprint TEXT NOT NULL,
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS symbol_terms (
      snapshot_id TEXT NOT NULL,
      term TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (snapshot_id, term, symbol_id),
      FOREIGN KEY (snapshot_id, symbol_id) REFERENCES symbols(snapshot_id, id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_symbol_lookup (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      provenance TEXT NOT NULL CHECK (provenance IN ('alias', 'symbol')),
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (snapshot_id, lookup_key, symbol_id),
      FOREIGN KEY (snapshot_id, symbol_id) REFERENCES symbols(snapshot_id, id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_reuse_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL,
      resolution_surface_version INTEGER NOT NULL,
      extractor_set TEXT NOT NULL,
      workspace_fingerprint TEXT NOT NULL,
      file_set_fingerprint TEXT NOT NULL,
      lookup_count INTEGER NOT NULL CHECK (lookup_count >= 0),
      alias_count INTEGER NOT NULL CHECK (alias_count >= 0),
      reexport_count INTEGER NOT NULL CHECK (reexport_count >= 0),
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* ensureColumn(sql, 'snapshot_reuse_receipts', 'reexport_count', 'INTEGER NOT NULL DEFAULT 0');
  yield* ensureColumn(sql, 'snapshot_reuse_receipts', 'inventory_receipt_json', 'TEXT');
  // Candidate ranking uses per-project surfaces. The complete receipt remains
  // authoritative and is validated before a base can be reused.
  yield* ensureColumn(sql, 'snapshot_reuse_receipts', 'component_surfaces_json', 'TEXT');
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS snapshot_reuse_component_surfaces
    AFTER INSERT ON snapshot_reuse_receipts
    WHEN NEW.inventory_receipt_json IS NOT NULL
    BEGIN
      UPDATE snapshot_reuse_receipts
      SET component_surfaces_json = (
        SELECT json_group_object(json_extract(project.value, '$.id'), json(project.value))
        FROM json_each(NEW.inventory_receipt_json, '$.workspace.projects') AS project
      )
      WHERE snapshot_id = NEW.snapshot_id;
    END
  `);
  yield* sql.unsafe(`
    UPDATE snapshot_reuse_receipts
    SET component_surfaces_json = (
      SELECT json_group_object(json_extract(project.value, '$.id'), json(project.value))
      FROM json_each(snapshot_reuse_receipts.inventory_receipt_json, '$.workspace.projects') AS project
    )
    WHERE component_surfaces_json IS NULL
      AND inventory_receipt_json IS NOT NULL
      AND json_valid(inventory_receipt_json)
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_pack_provenance (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      pack_id TEXT NOT NULL,
      cache_identity TEXT NOT NULL,
      derivation_identity TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      resolution_version TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, pack_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_reexport_provenance (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      imported_name TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, source_path, local_name, target_path, imported_name)
    ) WITHOUT ROWID
  `);
  // A layered clean snapshot remains a one-level physical delta over its root.
  // These receipts prove that the delta can be folded into a later sibling
  // without ever making the layered snapshot a physical base. The dedicated
  // lookup table intentionally has no symbol foreign key: a resolved alias
  // owned by the delta may target an unchanged symbol physically owned by the
  // root snapshot.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_fold_forward_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      root_snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL CHECK (format_version = 1),
      delta_path_count INTEGER NOT NULL CHECK (delta_path_count > 0),
      staged_row_count INTEGER NOT NULL CHECK (staged_row_count > 0),
      staged_payload_bytes INTEGER NOT NULL CHECK (staged_payload_bytes >= 0),
      lookup_count INTEGER NOT NULL CHECK (lookup_count >= 0),
      reexport_count INTEGER NOT NULL CHECK (reexport_count >= 0),
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_fold_forward_paths (
      snapshot_id TEXT NOT NULL REFERENCES snapshot_fold_forward_receipts(snapshot_id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_fold_forward_symbol_lookup (
      snapshot_id TEXT NOT NULL REFERENCES snapshot_fold_forward_receipts(snapshot_id) ON DELETE CASCADE,
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      provenance TEXT NOT NULL CHECK (provenance IN ('alias', 'symbol')),
      evidence_edge_id TEXT,
      evidence_path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, lookup_key, symbol_id)
    ) WITHOUT ROWID
  `);
  // Clean full builds write symbols and already-final edges directly while the
  // snapshot remains `building`. Each unresolved edge and its compact lookup
  // tiers share one build-only primary-key row until resolution publishes the
  // retained final edge exactly once. The legacy candidate table remains only
  // for bounded cleanup of pre-compaction databases; batch receipts make
  // interrupted builds resumable without replaying committed fact batches.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS building_references (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported_only INTEGER NOT NULL CHECK (exported_only IN (0, 1)),
      alias_lookup_keys_json TEXT NOT NULL,
      lookup_tiers_json TEXT NOT NULL,
      candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
      candidate_payload_bytes INTEGER NOT NULL CHECK (candidate_payload_bytes >= 0),
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS building_reference_candidates (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      lookup_key TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id, tier, lookup_key)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS building_materialization_batches (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      batch_fingerprint TEXT NOT NULL,
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      term_count INTEGER NOT NULL CHECK (term_count >= 0),
      lookup_count INTEGER NOT NULL CHECK (lookup_count >= 0),
      reference_count INTEGER NOT NULL CHECK (reference_count >= 0),
      candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
      reexport_count INTEGER NOT NULL CHECK (reexport_count >= 0),
      completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS building_materialization_spool_surfaces (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      surface_index INTEGER NOT NULL CHECK (surface_index >= 0 AND surface_index < 32),
      spool_identity TEXT NOT NULL CHECK (length(spool_identity) = 64),
      surface_name TEXT NOT NULL,
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      next_page_index INTEGER NOT NULL CHECK (next_page_index >= 0),
      applied_row_count INTEGER NOT NULL CHECK (applied_row_count >= 0 AND applied_row_count <= row_count),
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      PRIMARY KEY (snapshot_id, surface_index),
      UNIQUE (snapshot_id, surface_name),
      CHECK (complete = 0 OR applied_row_count = row_count)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_worktree_state ON snapshots(worktree_id, state)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_commit ON snapshots(repository_id, commit_id)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_base_state_id ON snapshots(base_snapshot_id, state, id)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS snapshots_graph_content ON snapshots(repository_id, graph_content_id, state)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_leases_expiry ON snapshot_leases(expires_at)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)',
  );
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS file_blobs_blob_reuse
    ON file_blobs(blob_id, content_hash, extractor_set, reuse_class, path_hint)
    WHERE blob_id IS NOT NULL AND reuse_class IS NOT NULL
  `);
  yield* ensureCodeGraphFileBlobAuthority(sql);
  // Routine cache reclamation resolves references from a disposable shard
  // back to snapshot-owned associations. Keep that reverse lookup indexed so
  // a bounded deletion page cannot hide a full association-table scan.
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_file_shards_shard ON snapshot_file_shards(shard_id)');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS routine_cache_cleanup_state (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      phase TEXT NOT NULL CHECK (phase IN ('file-blobs', 'materialized-shards')),
      file_content_hash TEXT,
      file_extractor_set TEXT,
      file_path_hint TEXT,
      materialized_shard_id TEXT,
      CHECK (
        (file_content_hash IS NULL AND file_extractor_set IS NULL AND file_path_hint IS NULL)
        OR
        (file_content_hash IS NOT NULL AND file_extractor_set IS NOT NULL AND file_path_hint IS NOT NULL)
      ),
      CHECK (
        (phase = 'file-blobs' AND materialized_shard_id IS NULL)
        OR
        (phase = 'materialized-shards'
          AND file_content_hash IS NULL
          AND file_extractor_set IS NULL
          AND file_path_hint IS NULL)
      )
    ) WITHOUT ROWID
  `);
  yield* sql`
    INSERT INTO routine_cache_cleanup_state (
      singleton, phase, file_content_hash, file_extractor_set, file_path_hint, materialized_shard_id
    ) VALUES (1, 'file-blobs', NULL, NULL, NULL, NULL)
    ON CONFLICT(singleton) DO NOTHING
  `;
  // Exact lookup uses the NOCASE index and computes case-sensitive rank from
  // the same rows. Query-required index changes are shared with the atomic
  // persistent-extension upgrade path.
  yield* ensureCurrentCodeGraphQueryIndexes(sql);
  yield* sql.unsafe('DROP INDEX IF EXISTS symbols_visualization_scope');
  yield* sql.unsafe('DROP INDEX IF EXISTS symbols_visualization_package');
  yield* sql.unsafe('DROP INDEX IF EXISTS symbols_visualization_path');
  yield* ensureCodeGraphQueryIndexes(sql);
  // The WITHOUT ROWID primary key already serves `(snapshot_id, term)` lexical
  // lookups. Snapshot-owned postings are purged before snapshot/symbol rows, so
  // a second `(snapshot_id, symbol_id)` ordering is unnecessary for cascades.
  // Reference reuse first narrows by the leading `(snapshot_id, lookup_key)`
  // primary-key columns, then filters the normally tiny candidate set by
  // domain/export visibility. The former secondary index duplicated every
  // lookup row and dominated full-snapshot activation.
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS snapshot_reexport_source ON snapshot_reexport_provenance(snapshot_id, source_path, local_name)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS code_graph_monikers_identity ON code_graph_monikers(snapshot_id, scheme, resolution_domain, identity, role, id)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS workspace_external_dependencies_package ON workspace_external_dependencies(snapshot_id, ecosystem, package_name, source_component_id)',
  );
  yield* sql`
    INSERT INTO schema_metadata (key, value)
    VALUES ('minimum_extractor_generation', ${String(CODE_GRAPH_EXTRACTOR_GENERATION)})
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(MAX(CAST(schema_metadata.value AS INTEGER), ${CODE_GRAPH_EXTRACTOR_GENERATION}) AS TEXT)
  `;
  yield* sql`
    INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', ${String(CODE_GRAPH_SCHEMA_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  const rows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'schema_version'
  `;
  if (rows[0]?.value !== String(CODE_GRAPH_SCHEMA_VERSION)) {
    return yield* CodeGraphStoreError.of(
      `Code graph schema ${rows[0]?.value ?? 'unknown'} is incompatible with ${CODE_GRAPH_SCHEMA_VERSION}.`,
    );
  }
});

export {initializeSchema};
