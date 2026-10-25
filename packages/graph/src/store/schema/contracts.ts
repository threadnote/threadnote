import {CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION} from './revision.js';

export const CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL = `CREATE TABLE IF NOT EXISTS embedding_demand (
  worktree_id TEXT NOT NULL CHECK(length(worktree_id) = 64 AND worktree_id NOT GLOB '*[^0-9a-f]*'),
  scope_id TEXT NOT NULL CHECK(length(CAST(scope_id AS BLOB)) BETWEEN 1 AND 256),
  snapshot_id TEXT NOT NULL CHECK(length(CAST(snapshot_id AS BLOB)) BETWEEN 1 AND 128),
  activated_at TEXT NOT NULL CHECK(length(activated_at) = 24),
  state TEXT NOT NULL CHECK(state IN ('queued', 'building', 'deferred', 'blocked', 'ready', 'cancelled')),
  attempt INTEGER NOT NULL CHECK(typeof(attempt) = 'integer' AND attempt BETWEEN 0 AND 3),
  not_before INTEGER NOT NULL CHECK(typeof(not_before) = 'integer' AND not_before BETWEEN 0 AND 9007199254740991),
  reason TEXT CHECK(reason IS NULL OR length(CAST(reason AS BLOB)) <= 2048),
  model_json TEXT CHECK(model_json IS NULL OR (length(CAST(model_json AS BLOB)) <= 1024 AND json_valid(model_json))),
  active_json TEXT CHECK(active_json IS NULL OR (length(CAST(active_json AS BLOB)) <= 4096 AND json_valid(active_json))),
  PRIMARY KEY (worktree_id, scope_id)
) WITHOUT ROWID`;
const column = (name: string, type: string, primaryKeyPosition = 0, notNull = true) => ({
  name,
  type,
  primaryKeyPosition,
  notNull,
});
export const CODE_GRAPH_EMBEDDING_DEMAND_TABLE_CONTRACT = {
  name: 'embedding_demand',
  foreignKeys: [],
  group: 'vector-demand',
  createSql: CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL,
  withoutRowid: true,
  columns: [
    column('worktree_id', 'TEXT', 1),
    column('scope_id', 'TEXT', 2),
    column('snapshot_id', 'TEXT'),
    column('activated_at', 'TEXT'),
    column('state', 'TEXT'),
    column('attempt', 'INTEGER'),
    column('not_before', 'INTEGER'),
    column('reason', 'TEXT', 0, false),
    column('model_json', 'TEXT', 0, false),
    column('active_json', 'TEXT', 0, false),
  ],
} as const satisfies PersistentExtensionTableContract;

export type PersistentExtensionGroup =
  'analysis' | 'build' | 'checkpoint' | 'cross-repository' | 'lexical' | 'shards' | 'vector-demand';

export type CodeGraphPersistentSchemaMigrationPhase =
  | 'added-build-owner-instance'
  | 'added-checkpoint-import'
  | 'added-graph-scope-authority'
  | 'added-materialization-plan'
  | 'added-removed-view-cleanup'
  | 'created-extensions'
  | 'dropped-incompatible'
  | 'dropped-obsolete-indexes'
  | 'migrated-query-indexes'
  | 'recorded-revision'
  | 'retired-incompatible-ready'
  | 'retired-incomplete'
  | 'validated';

export interface PersistentExtensionColumnContract {
  readonly name: string;
  readonly notNull: boolean;
  readonly primaryKeyPosition: number;
  readonly type: string;
}

export interface PersistentExtensionTableContract {
  readonly columns: readonly PersistentExtensionColumnContract[];
  readonly createSql: string;
  readonly foreignKeys?: readonly PersistentExtensionForeignKeyContract[];
  readonly group: PersistentExtensionGroup;
  readonly name: string;
  readonly requiredDefinitionPatterns?: readonly RegExp[];
  readonly uniqueKeys?: readonly (readonly string[])[];
  readonly withoutRowid?: boolean;
}

export interface PersistentExtensionForeignKeyContract {
  readonly from: string;
  readonly onDelete: string;
  readonly table: string;
  readonly to: string;
}

export interface PersistentExtensionTableInspection {
  readonly compatible: boolean;
  readonly exists: boolean;
  readonly group: PersistentExtensionGroup;
  readonly name: string;
}

export interface SqliteTableColumnRow {
  readonly cid: number;
  readonly dflt_value: unknown;
  readonly name: string;
  readonly notnull: number;
  readonly pk: number;
  readonly type: string;
}

export interface SqliteForeignKeyRow {
  readonly from: string;
  readonly on_delete: string;
  readonly table: string;
  readonly to: string;
}

export interface SqliteIndexListRow {
  readonly name: string;
  readonly partial: number;
  readonly unique: number;
}

export interface SqliteIndexInfoRow {
  readonly name: string;
  readonly seqno: number;
}

const requiredColumn = (name: string, type: string, primaryKeyPosition = 0): PersistentExtensionColumnContract => ({
  name,
  notNull: true,
  primaryKeyPosition,
  type,
});

const optionalColumn = (name: string, type: string): PersistentExtensionColumnContract => ({
  name,
  notNull: false,
  primaryKeyPosition: 0,
  type,
});

/**
 * Complete persistent schema delta from beta.30. These tables deliberately do
 * not change the public graph schema version: beta databases can retain ready
 * snapshots while derived summaries are created and interrupted full builds
 * are restarted against the current resumable-build contract.
 */
export const PERSISTENT_EXTENSION_TABLES = [
  CODE_GRAPH_EMBEDDING_DEMAND_TABLE_CONTRACT,
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('source_component_id', 'TEXT', 2),
      requiredColumn('ecosystem', 'TEXT', 3),
      requiredColumn('package_name', 'TEXT', 4),
      requiredColumn('import_alias', 'TEXT', 5),
      requiredColumn('dependency_kind', 'TEXT', 6),
      requiredColumn('version_constraint', 'TEXT', 7),
      requiredColumn('evidence_path', 'TEXT', 8),
      optionalColumn('evidence_span_json', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS workspace_external_dependencies (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      source_component_id TEXT NOT NULL,
      ecosystem TEXT NOT NULL CHECK (ecosystem = 'npm'),
      package_name TEXT NOT NULL,
      import_alias TEXT NOT NULL,
      dependency_kind TEXT NOT NULL CHECK (dependency_kind IN ('runtime', 'development', 'optional', 'peer')),
      version_constraint TEXT NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT,
      PRIMARY KEY (
        snapshot_id, source_component_id, ecosystem, package_name, import_alias, dependency_kind,
        version_constraint, evidence_path
      )
    ) WITHOUT ROWID`,
    group: 'cross-repository',
    name: 'workspace_external_dependencies',
    requiredDefinitionPatterns: [
      /CHECK\s*\(\s*ecosystem\s*=\s*'npm'\s*\)/i,
      /CHECK\s*\(\s*dependency_kind\s+IN\s*\(\s*'runtime'\s*,\s*'development'\s*,\s*'optional'\s*,\s*'peer'\s*\)\s*\)/i,
    ],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('id', 'TEXT', 2),
      requiredColumn('version', 'INTEGER'),
      requiredColumn('scheme', 'TEXT'),
      requiredColumn('role', 'TEXT'),
      requiredColumn('kind', 'TEXT'),
      requiredColumn('resolution_domain', 'TEXT'),
      requiredColumn('identity', 'TEXT'),
      optionalColumn('package_name', 'TEXT'),
      optionalColumn('package_version', 'TEXT'),
      optionalColumn('import_path', 'TEXT'),
      optionalColumn('qualified_name', 'TEXT'),
      optionalColumn('component_id', 'TEXT'),
      optionalColumn('symbol_id', 'TEXT'),
      optionalColumn('dependency_kind', 'TEXT'),
      requiredColumn('evidence_path', 'TEXT'),
      requiredColumn('evidence_span_json', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS code_graph_monikers (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version = 1),
      scheme TEXT NOT NULL CHECK (scheme IN ('package', 'protobuf')),
      role TEXT NOT NULL CHECK (role IN ('import', 'export')),
      kind TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      identity TEXT NOT NULL,
      package_name TEXT,
      package_version TEXT,
      import_path TEXT,
      qualified_name TEXT,
      component_id TEXT,
      symbol_id TEXT,
      dependency_kind TEXT,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID`,
    group: 'cross-repository',
    name: 'code_graph_monikers',
    requiredDefinitionPatterns: [
      /CHECK\s*\(\s*version\s*=\s*1\s*\)/i,
      /CHECK\s*\(\s*scheme\s+IN\s*\(\s*'package'\s*,\s*'protobuf'\s*\)\s*\)/i,
      /CHECK\s*\(\s*role\s+IN\s*\(\s*'import'\s*,\s*'export'\s*\)\s*\)/i,
    ],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('owner_token', 'TEXT'),
      requiredColumn('claimed_at', 'TEXT'),
      optionalColumn('expected_batch_count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_build_owners (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      expected_batch_count INTEGER CHECK (expected_batch_count IS NULL OR expected_batch_count >= 0)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'snapshot_build_owners',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('owner_token', 'TEXT'),
      requiredColumn('build_id', 'TEXT'),
      requiredColumn('process_id', 'INTEGER'),
      optionalColumn('process_start_identity', 'TEXT'),
      requiredColumn('logical_snapshot_id', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_build_owner_instances (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshot_build_owners(snapshot_id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      build_id TEXT NOT NULL,
      process_id INTEGER NOT NULL CHECK (process_id > 0),
      process_start_identity TEXT,
      logical_snapshot_id TEXT NOT NULL
    ) WITHOUT ROWID`,
    foreignKeys: [{from: 'snapshot_id', onDelete: 'CASCADE', table: 'snapshot_build_owners', to: 'snapshot_id'}],
    group: 'build',
    name: 'snapshot_build_owner_instances',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('language', 'TEXT', 2),
      requiredColumn('kind', 'TEXT', 3),
      requiredColumn('count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_analysis_symbol_counts (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, language, kind)
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_analysis_symbol_counts',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('provenance', 'TEXT', 2),
      requiredColumn('relation', 'TEXT', 3),
      requiredColumn('confidence', 'REAL', 4),
      requiredColumn('endpoint_state', 'INTEGER', 5),
      requiredColumn('count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_analysis_edge_histogram (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence REAL NOT NULL,
      endpoint_state INTEGER NOT NULL CHECK (endpoint_state IN (0, 1, 2)),
      count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, provenance, relation, confidence, endpoint_state)
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_analysis_edge_histogram',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('provenance', 'TEXT', 2),
      requiredColumn('relation', 'TEXT', 3),
      requiredColumn('count', 'INTEGER'),
      requiredColumn('confidence_invalid', 'INTEGER'),
      requiredColumn('confidence_total', 'REAL'),
      requiredColumn('lowest_confidence', 'REAL'),
      requiredColumn('confidence_high', 'INTEGER'),
      requiredColumn('confidence_medium', 'INTEGER'),
      requiredColumn('confidence_low', 'INTEGER'),
      requiredColumn('unresolved_endpoint_count', 'INTEGER'),
      requiredColumn('self_loop_count', 'INTEGER'),
      requiredColumn('review_finding_count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_analysis_edge_counts (
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
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_analysis_edge_counts',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('source_component_id', 'TEXT', 2),
      requiredColumn('target_component_id', 'TEXT', 3),
      requiredColumn('provenance', 'TEXT', 4),
      requiredColumn('relation', 'TEXT', 5),
      requiredColumn('count', 'INTEGER'),
      requiredColumn('confidence', 'REAL'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_component_edge_aggregates (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      source_component_id TEXT NOT NULL,
      target_component_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      count INTEGER NOT NULL CHECK (count > 0),
      confidence REAL NOT NULL,
      PRIMARY KEY (snapshot_id, source_component_id, target_component_id, provenance, relation)
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_component_edge_aggregates',
    requiredDefinitionPatterns: [/CHECK\s*\(\s*count\s*>\s*0\s*\)/i],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('version', 'INTEGER'),
      requiredColumn('row_count', 'INTEGER'),
      requiredColumn('edge_count', 'INTEGER'),
      requiredColumn('digest', 'TEXT'),
      requiredColumn('created_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_component_edge_aggregate_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version = 1),
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_component_edge_aggregate_receipts',
    requiredDefinitionPatterns: [
      /CHECK\s*\(\s*version\s*=\s*1\s*\)/i,
      /CHECK\s*\(\s*row_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*edge_count\s*>=\s*0\s*\)/i,
    ],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('version', 'INTEGER'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('edge_count', 'INTEGER'),
      requiredColumn('digest', 'TEXT'),
      requiredColumn('created_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_analysis_summary_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version = 1),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_analysis_summary_receipts',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('batch_index', 'INTEGER', 2),
      requiredColumn('batch_fingerprint', 'TEXT'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('edge_count', 'INTEGER'),
      requiredColumn('completed_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_analysis_batches (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      batch_fingerprint TEXT NOT NULL,
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_analysis_batches',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('edge_id', 'TEXT', 2),
      requiredColumn('resolution_domain', 'TEXT'),
      requiredColumn('exported_only', 'INTEGER'),
      requiredColumn('alias_lookup_keys_json', 'TEXT'),
      requiredColumn('lookup_tiers_json', 'TEXT'),
      requiredColumn('candidate_count', 'INTEGER'),
      requiredColumn('candidate_payload_bytes', 'INTEGER'),
      optionalColumn('source_id', 'TEXT'),
      requiredColumn('source_name', 'TEXT'),
      requiredColumn('relation', 'TEXT'),
      requiredColumn('target_name', 'TEXT'),
      requiredColumn('provenance', 'TEXT'),
      requiredColumn('confidence', 'REAL'),
      requiredColumn('evidence_path', 'TEXT'),
      requiredColumn('evidence_span_json', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_references (
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
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_references',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('edge_id', 'TEXT', 2),
      requiredColumn('tier', 'INTEGER', 3),
      requiredColumn('lookup_key', 'TEXT', 4),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_reference_candidates (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      lookup_key TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id, tier, lookup_key)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_reference_candidates',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('batch_index', 'INTEGER', 2),
      requiredColumn('batch_fingerprint', 'TEXT'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('edge_count', 'INTEGER'),
      requiredColumn('term_count', 'INTEGER'),
      requiredColumn('lookup_count', 'INTEGER'),
      requiredColumn('reference_count', 'INTEGER'),
      requiredColumn('candidate_count', 'INTEGER'),
      requiredColumn('reexport_count', 'INTEGER'),
      requiredColumn('completed_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_materialization_batches (
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
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_materialization_batches',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('surface_index', 'INTEGER', 2),
      requiredColumn('spool_identity', 'TEXT'),
      requiredColumn('surface_name', 'TEXT'),
      requiredColumn('row_count', 'INTEGER'),
      requiredColumn('next_page_index', 'INTEGER'),
      requiredColumn('applied_row_count', 'INTEGER'),
      requiredColumn('complete', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_materialization_spool_surfaces (
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
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_materialization_spool_surfaces',
    requiredDefinitionPatterns: [
      /CHECK\s*\(\s*surface_index\s*>=\s*0\s+AND\s+surface_index\s*<\s*32\s*\)/i,
      /CHECK\s*\(\s*complete\s*=\s*0\s+OR\s+applied_row_count\s*=\s*row_count\s*\)/i,
    ],
    uniqueKeys: [['snapshot_id', 'surface_name']],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('completed_batch_count', 'INTEGER'),
      requiredColumn('posting_count', 'INTEGER'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('term_count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_lexical_counters (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      completed_batch_count INTEGER NOT NULL CHECK (completed_batch_count >= 0),
      posting_count INTEGER NOT NULL CHECK (posting_count >= 0),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      term_count INTEGER NOT NULL CHECK (term_count >= 0)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_lexical_counters',
    requiredDefinitionPatterns: [
      /CHECK\s*\(\s*completed_batch_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*posting_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*symbol_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*term_count\s*>=\s*0\s*\)/i,
    ],
  },
  {
    columns: [requiredColumn('snapshot_key', 'INTEGER', 1), requiredColumn('snapshot_id', 'TEXT')],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_compact_snapshots (
      snapshot_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_id TEXT UNIQUE NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE
    )`,
    foreignKeys: [{from: 'snapshot_id', onDelete: 'CASCADE', table: 'snapshots', to: 'id'}],
    group: 'lexical',
    name: 'lexical_compact_snapshots',
    uniqueKeys: [['snapshot_id']],
    withoutRowid: false,
  },
  {
    columns: [
      requiredColumn('term_key', 'INTEGER', 1),
      requiredColumn('snapshot_key', 'INTEGER'),
      requiredColumn('term', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_compact_terms (
      term_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_key INTEGER NOT NULL REFERENCES lexical_compact_snapshots(snapshot_key) ON DELETE CASCADE,
      term TEXT NOT NULL,
      UNIQUE (snapshot_key, term)
    )`,
    foreignKeys: [{from: 'snapshot_key', onDelete: 'CASCADE', table: 'lexical_compact_snapshots', to: 'snapshot_key'}],
    group: 'lexical',
    name: 'lexical_compact_terms',
    uniqueKeys: [['snapshot_key', 'term']],
    withoutRowid: false,
  },
  {
    columns: [
      requiredColumn('symbol_key', 'INTEGER', 1),
      requiredColumn('snapshot_key', 'INTEGER'),
      requiredColumn('symbol_id', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_compact_symbols (
      symbol_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_key INTEGER NOT NULL REFERENCES lexical_compact_snapshots(snapshot_key) ON DELETE CASCADE,
      symbol_id TEXT NOT NULL,
      UNIQUE (snapshot_key, symbol_id)
    )`,
    foreignKeys: [{from: 'snapshot_key', onDelete: 'CASCADE', table: 'lexical_compact_snapshots', to: 'snapshot_key'}],
    group: 'lexical',
    name: 'lexical_compact_symbols',
    uniqueKeys: [['snapshot_key', 'symbol_id']],
    withoutRowid: false,
  },
  {
    columns: [
      requiredColumn('snapshot_key', 'INTEGER', 1),
      requiredColumn('term_key', 'INTEGER', 2),
      requiredColumn('symbol_key', 'INTEGER', 3),
      requiredColumn('weight', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_compact_postings (
      snapshot_key INTEGER NOT NULL REFERENCES lexical_compact_snapshots(snapshot_key) ON DELETE CASCADE,
      term_key INTEGER NOT NULL,
      symbol_key INTEGER NOT NULL,
      weight INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 5),
      PRIMARY KEY (snapshot_key, term_key, symbol_key)
    ) WITHOUT ROWID`,
    foreignKeys: [{from: 'snapshot_key', onDelete: 'CASCADE', table: 'lexical_compact_snapshots', to: 'snapshot_key'}],
    group: 'lexical',
    name: 'lexical_compact_postings',
    requiredDefinitionPatterns: [/CHECK\s*\(\s*weight\s+BETWEEN\s+1\s+AND\s+5\s*\)/i],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('format_version', 'INTEGER'),
      requiredColumn('posting_count', 'INTEGER'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('term_count', 'INTEGER'),
      requiredColumn('created_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_storage_formats (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL CHECK (format_version = 1),
      posting_count INTEGER NOT NULL CHECK (posting_count >= 0),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      term_count INTEGER NOT NULL CHECK (term_count >= 0),
      created_at TEXT NOT NULL
    ) WITHOUT ROWID`,
    group: 'lexical',
    name: 'lexical_storage_formats',
    requiredDefinitionPatterns: [
      /CHECK\s*\(\s*format_version\s*=\s*1\s*\)/i,
      /CHECK\s*\(\s*posting_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*symbol_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*term_count\s*>=\s*0\s*\)/i,
    ],
  },
  {
    columns: [
      requiredColumn('id', 'TEXT', 1),
      requiredColumn('content_hash', 'TEXT'),
      requiredColumn('extractor_set', 'TEXT'),
      requiredColumn('derivation_identity', 'TEXT'),
      requiredColumn('path_hint', 'TEXT'),
      requiredColumn('facts_json', 'TEXT'),
      requiredColumn('created_at', 'TEXT'),
      requiredColumn('last_used_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS materialized_file_shards (
      id TEXT PRIMARY KEY NOT NULL,
      content_hash TEXT NOT NULL,
      extractor_set TEXT NOT NULL,
      derivation_identity TEXT NOT NULL,
      path_hint TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      UNIQUE (content_hash, extractor_set, derivation_identity, path_hint)
    ) WITHOUT ROWID`,
    foreignKeys: [],
    group: 'shards',
    name: 'materialized_file_shards',
    uniqueKeys: [['content_hash', 'extractor_set', 'derivation_identity', 'path_hint']],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('path', 'TEXT', 2),
      requiredColumn('shard_id', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_file_shards (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      shard_id TEXT NOT NULL REFERENCES materialized_file_shards(id) ON DELETE CASCADE,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID`,
    foreignKeys: [
      {from: 'snapshot_id', onDelete: 'CASCADE', table: 'snapshots', to: 'id'},
      {from: 'shard_id', onDelete: 'CASCADE', table: 'materialized_file_shards', to: 'id'},
    ],
    group: 'shards',
    name: 'snapshot_file_shards',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('format_version', 'INTEGER'),
      requiredColumn('source_repository_id', 'TEXT'),
      requiredColumn('source_commit_id', 'TEXT'),
      requiredColumn('source_graph_content_id', 'TEXT'),
      requiredColumn('abi_algorithm', 'TEXT'),
      requiredColumn('abi_digest', 'TEXT'),
      requiredColumn('logical_algorithm', 'TEXT'),
      requiredColumn('logical_digest', 'TEXT'),
      optionalColumn('base_logical_digest', 'TEXT'),
      requiredColumn('artifact_algorithm', 'TEXT'),
      requiredColumn('artifact_digest', 'TEXT'),
      requiredColumn('artifact_size', 'INTEGER'),
      requiredColumn('artifact_media_type', 'TEXT'),
      requiredColumn('coverage_json', 'TEXT'),
      requiredColumn('trust', 'TEXT'),
      requiredColumn('expected_batch_count', 'INTEGER'),
      requiredColumn('expected_counts_json', 'TEXT'),
      requiredColumn('expected_pack_provenance_json', 'TEXT'),
      requiredColumn('started_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS checkpoint_import_builds (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL CHECK (format_version = ${CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION}),
      source_repository_id TEXT NOT NULL CHECK (length(source_repository_id) = 64),
      source_commit_id TEXT NOT NULL,
      source_graph_content_id TEXT NOT NULL,
      abi_algorithm TEXT NOT NULL CHECK (abi_algorithm = 'sha256'),
      abi_digest TEXT NOT NULL CHECK (length(abi_digest) = 64),
      logical_algorithm TEXT NOT NULL CHECK (logical_algorithm = 'sha256'),
      logical_digest TEXT NOT NULL CHECK (length(logical_digest) = 64),
      base_logical_digest TEXT CHECK (base_logical_digest IS NULL OR length(base_logical_digest) = 64),
      artifact_algorithm TEXT NOT NULL CHECK (artifact_algorithm = 'sha256'),
      artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
      artifact_size INTEGER NOT NULL CHECK (artifact_size >= 0),
      artifact_media_type TEXT NOT NULL,
      coverage_json TEXT NOT NULL,
      trust TEXT NOT NULL CHECK (trust IN ('local-unverified', 'expected-descriptor-verified')),
      expected_batch_count INTEGER NOT NULL CHECK (expected_batch_count >= 0),
      expected_counts_json TEXT NOT NULL,
      expected_pack_provenance_json TEXT NOT NULL,
      started_at TEXT NOT NULL
    ) WITHOUT ROWID`,
    group: 'checkpoint',
    name: 'checkpoint_import_builds',
    requiredDefinitionPatterns: [
      new RegExp(`CHECK\\s*\\(\\s*format_version\\s*=\\s*${CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION}\\s*\\)`, 'i'),
      /CHECK\s*\(\s*abi_algorithm\s*=\s*'sha256'\s*\)/i,
      /CHECK\s*\(\s*logical_algorithm\s*=\s*'sha256'\s*\)/i,
      /CHECK\s*\(\s*artifact_algorithm\s*=\s*'sha256'\s*\)/i,
      /CHECK\s*\(\s*expected_batch_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*trust\s+IN\s*\(\s*'local-unverified'\s*,\s*'expected-descriptor-verified'\s*\)\s*\)/i,
    ],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('batch_index', 'INTEGER', 2),
      requiredColumn('digest_algorithm', 'TEXT'),
      requiredColumn('batch_digest', 'TEXT'),
      requiredColumn('record_count', 'INTEGER'),
      requiredColumn('completed_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS checkpoint_import_batches (
      snapshot_id TEXT NOT NULL REFERENCES checkpoint_import_builds(snapshot_id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      digest_algorithm TEXT NOT NULL CHECK (digest_algorithm = 'sha256'),
      batch_digest TEXT NOT NULL CHECK (length(batch_digest) = 64),
      record_count INTEGER NOT NULL CHECK (record_count >= 0),
      completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID`,
    foreignKeys: [{from: 'snapshot_id', onDelete: 'CASCADE', table: 'checkpoint_import_builds', to: 'snapshot_id'}],
    group: 'checkpoint',
    name: 'checkpoint_import_batches',
    requiredDefinitionPatterns: [
      /CHECK\s*\(\s*batch_index\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*digest_algorithm\s*=\s*'sha256'\s*\)/i,
      /CHECK\s*\(\s*record_count\s*>=\s*0\s*\)/i,
    ],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('format_version', 'INTEGER'),
      requiredColumn('source_repository_id', 'TEXT'),
      requiredColumn('source_commit_id', 'TEXT'),
      requiredColumn('source_graph_content_id', 'TEXT'),
      requiredColumn('abi_algorithm', 'TEXT'),
      requiredColumn('abi_digest', 'TEXT'),
      requiredColumn('logical_algorithm', 'TEXT'),
      requiredColumn('logical_digest', 'TEXT'),
      optionalColumn('base_logical_digest', 'TEXT'),
      requiredColumn('artifact_algorithm', 'TEXT'),
      requiredColumn('artifact_digest', 'TEXT'),
      requiredColumn('artifact_size', 'INTEGER'),
      requiredColumn('artifact_media_type', 'TEXT'),
      requiredColumn('coverage_json', 'TEXT'),
      requiredColumn('trust', 'TEXT'),
      requiredColumn('imported_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS checkpoint_import_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL CHECK (format_version = ${CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION}),
      source_repository_id TEXT NOT NULL CHECK (length(source_repository_id) = 64),
      source_commit_id TEXT NOT NULL,
      source_graph_content_id TEXT NOT NULL,
      abi_algorithm TEXT NOT NULL CHECK (abi_algorithm = 'sha256'),
      abi_digest TEXT NOT NULL CHECK (length(abi_digest) = 64),
      logical_algorithm TEXT NOT NULL CHECK (logical_algorithm = 'sha256'),
      logical_digest TEXT NOT NULL CHECK (length(logical_digest) = 64),
      base_logical_digest TEXT CHECK (base_logical_digest IS NULL OR length(base_logical_digest) = 64),
      artifact_algorithm TEXT NOT NULL CHECK (artifact_algorithm = 'sha256'),
      artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
      artifact_size INTEGER NOT NULL CHECK (artifact_size >= 0),
      artifact_media_type TEXT NOT NULL,
      coverage_json TEXT NOT NULL,
      trust TEXT NOT NULL CHECK (trust IN ('local-unverified', 'expected-descriptor-verified')),
      imported_at TEXT NOT NULL
    ) WITHOUT ROWID`,
    group: 'checkpoint',
    name: 'checkpoint_import_receipts',
    requiredDefinitionPatterns: [
      new RegExp(`CHECK\\s*\\(\\s*format_version\\s*=\\s*${CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION}\\s*\\)`, 'i'),
      /CHECK\s*\(\s*abi_algorithm\s*=\s*'sha256'\s*\)/i,
      /CHECK\s*\(\s*logical_algorithm\s*=\s*'sha256'\s*\)/i,
      /CHECK\s*\(\s*artifact_algorithm\s*=\s*'sha256'\s*\)/i,
      /CHECK\s*\(\s*trust\s+IN\s*\(\s*'local-unverified'\s*,\s*'expected-descriptor-verified'\s*\)\s*\)/i,
    ],
  },
] as const satisfies readonly PersistentExtensionTableContract[];

export const LEGACY_SNAPSHOT_BUILD_OWNERS_CONTRACT = {
  columns: [
    requiredColumn('snapshot_id', 'TEXT', 1),
    requiredColumn('owner_token', 'TEXT'),
    requiredColumn('claimed_at', 'TEXT'),
  ],
  createSql: `CREATE TABLE snapshot_build_owners (
    snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    owner_token TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  ) WITHOUT ROWID`,
  group: 'build',
  name: 'snapshot_build_owners',
} as const satisfies PersistentExtensionTableContract;

export const LEGACY_BUILDING_REFERENCES_V3_TABLE = 'legacy_building_references_v3';
export const LEGACY_BUILDING_REFERENCES_V3_CONTRACT = {
  columns: [
    requiredColumn('snapshot_id', 'TEXT', 1),
    requiredColumn('edge_id', 'TEXT', 2),
    requiredColumn('resolution_domain', 'TEXT'),
    requiredColumn('exported_only', 'INTEGER'),
    requiredColumn('alias_lookup_keys_json', 'TEXT'),
  ],
  createSql: `CREATE TABLE building_references (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    edge_id TEXT NOT NULL,
    resolution_domain TEXT NOT NULL,
    exported_only INTEGER NOT NULL CHECK (exported_only IN (0, 1)),
    alias_lookup_keys_json TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, edge_id)
  ) WITHOUT ROWID`,
  group: 'build',
  name: 'building_references',
} as const satisfies PersistentExtensionTableContract;

export const REMOVED_BETA30_INDEXES = ['snapshot_symbol_lookup_key', 'terms_lookup', 'terms_symbol'] as const;
export const CODE_GRAPH_PERSISTENT_EXTENSION_TABLE_NAMES = PERSISTENT_EXTENSION_TABLES.map(table => table.name);
