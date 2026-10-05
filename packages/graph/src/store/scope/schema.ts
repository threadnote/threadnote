import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../../index_scope.js';
import {
  REMOVED_VIEW_CLEANUP_COLUMNS,
  REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
} from '../removed/view_schema_contracts.js';
import {normalizeSchemaDefinition} from '../schema/normalization.js';
import {
  CODE_GRAPH_SCOPE_COLUMN_SQL,
  SCOPED_ACTIVE_SNAPSHOTS_TABLE_SQL,
  SCOPED_REMOVED_VIEWS_TABLE_SQL,
  SCOPED_REMOVED_VIEW_CLEANUP_TABLE_SQL,
  SCOPED_REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL,
  SCOPED_REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
  SNAPSHOT_SCOPE_RECEIPTS_TABLE_SQL,
  SCOPE_APPLICABILITY_TABLE_SQL,
} from './schema_contracts.js';
import {CodeGraphStoreError} from '../../types.js';

export const codeGraphScopeAuthorityInstalled = Effect.fn('codeGraph.scopeAuthorityInstalled')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe(`SELECT 1 FROM pragma_table_xinfo('snapshots') WHERE name = 'scope_id' LIMIT 1`);
  return rows.length === 1;
});

const scopedDefinitions = [
  {name: 'active_snapshots', type: 'table', sql: SCOPED_ACTIVE_SNAPSHOTS_TABLE_SQL},
  {name: 'removed_views', type: 'table', sql: SCOPED_REMOVED_VIEWS_TABLE_SQL},
  {name: 'removed_view_cleanup', type: 'table', sql: SCOPED_REMOVED_VIEW_CLEANUP_TABLE_SQL},
  {name: 'removed_view_cleanup_due', type: 'index', sql: SCOPED_REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL},
  {name: 'snapshot_scope_receipts', type: 'table', sql: SNAPSHOT_SCOPE_RECEIPTS_TABLE_SQL},
  {name: 'scope_applicability', type: 'table', sql: SCOPE_APPLICABILITY_TABLE_SQL},
  ...SCOPED_REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.map(trigger => ({...trigger, type: 'trigger'})),
] as const;

export const codeGraphScopeAuthoritySchemaCompatible = Effect.fn('codeGraph.scopeAuthoritySchemaCompatible')(function* (
  sql: SqlClient.SqlClient,
  names?: readonly string[],
) {
  if (!(yield* codeGraphScopeAuthorityInstalled(sql))) return false;
  for (const definition of scopedDefinitions) {
    if (names !== undefined && !names.includes(definition.name)) continue;
    const rows = yield* sql.unsafe<{readonly name: string; readonly type: string; readonly sql: string | null}>(
      `SELECT name, type, CASE WHEN length(CAST(sql AS BLOB)) <= 16384 THEN sql ELSE NULL END AS sql
       FROM sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 2`,
      [definition.name],
    );
    if (
      rows.length !== 1 ||
      rows[0]?.name !== definition.name ||
      rows[0]?.type !== definition.type ||
      normalizeSchemaDefinition(rows[0]?.sql ?? '') !== normalizeSchemaDefinition(definition.sql)
    )
      return false;
  }
  if (
    names === undefined &&
    (yield* sql.unsafe(`SELECT 1 FROM sqlite_master WHERE type = 'trigger'
    AND tbl_name IN ('snapshot_scope_receipts', 'scope_applicability') LIMIT 1`)).length !== 0
  )
    return false;
  return true;
});

/** Called inside the extension publication transaction after exact legacy admission. */
export const migrateCodeGraphScopeAuthority = Effect.fn('codeGraph.migrateScopeAuthority')(function* (
  sql: SqlClient.SqlClient,
) {
  if (yield* codeGraphScopeAuthorityInstalled(sql)) {
    if (!(yield* codeGraphScopeAuthoritySchemaCompatible(sql))) {
      return yield* CodeGraphStoreError.of('Code graph scope authority schema is incompatible.');
    }
    return;
  }
  yield* sql.unsafe(`ALTER TABLE snapshots ADD COLUMN ${CODE_GRAPH_SCOPE_COLUMN_SQL}`);
  for (const trigger of REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS) yield* sql.unsafe(`DROP TRIGGER ${trigger.name}`);
  // Copy only authority rows. Facts, immutable snapshot IDs, and leases remain in place.
  const tables = [
    {
      name: 'active_snapshots',
      sql: SCOPED_ACTIVE_SNAPSHOTS_TABLE_SQL,
      columns: ['worktree_id', 'snapshot_id', 'activated_at'],
    },
    {
      name: 'removed_views',
      sql: SCOPED_REMOVED_VIEWS_TABLE_SQL,
      columns: ['worktree_id', 'expected_snapshot_id', 'removed_at'],
    },
    {
      name: 'removed_view_cleanup',
      sql: SCOPED_REMOVED_VIEW_CLEANUP_TABLE_SQL,
      columns: REMOVED_VIEW_CLEANUP_COLUMNS.map(column => column.name),
    },
  ];
  for (const table of tables) {
    const projection = table.columns.join(', ');
    const temporary = `${table.name}_scope_migration`;
    yield* sql.unsafe(`CREATE TEMP TABLE ${temporary} AS SELECT ${projection} FROM ${table.name}`);
    yield* sql.unsafe(`DROP TABLE ${table.name}`);
    yield* sql.unsafe(table.sql);
    yield* sql.unsafe(`INSERT INTO ${table.name} (${projection}, scope_id) SELECT ${projection}, ? FROM ${temporary}`, [
      CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
    ]);
    yield* sql.unsafe(`DROP TABLE temp.${temporary}`);
  }
  yield* sql.unsafe(SCOPED_REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL);
  for (const trigger of SCOPED_REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS) yield* sql.unsafe(trigger.sql);
  yield* sql.unsafe(SNAPSHOT_SCOPE_RECEIPTS_TABLE_SQL);
  yield* sql.unsafe(SCOPE_APPLICABILITY_TABLE_SQL);
  yield* sql`INSERT INTO snapshot_scope_receipts (snapshot_id, scope_id, included_root_ids_json,
    included_component_ids_json, completeness, diagnostics_json)
    SELECT id, ${CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY}, '[]', '[]', 'legacy-full', '[]' FROM snapshots`;
  yield* sql`INSERT INTO scope_applicability (worktree_id, scope_id, observed_commit, overlay_fingerprint,
    active_snapshot_id, extractor_set)
    SELECT active.worktree_id, active.scope_id, snapshot.commit_id, snapshot.overlay_fingerprint, snapshot.id,
      snapshot.extractor_set FROM active_snapshots AS active JOIN snapshots AS snapshot ON snapshot.id = active.snapshot_id`;
  yield* sql.unsafe('CREATE INDEX active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id)');
});
