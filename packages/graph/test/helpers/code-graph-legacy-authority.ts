import {Array as EffectArray} from 'effect';
import {CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL} from '@threadnote/graph/store/schema/core';
import {CODE_GRAPH_SCOPE_QUERY_INDEX_DEFINITIONS} from '@threadnote/graph/store/query/indexes';
import {
  REMOVED_VIEWS_TABLE_SQL,
  REMOVED_VIEW_CLEANUP_COLUMNS,
  REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL,
  REMOVED_VIEW_CLEANUP_TABLE_SQL,
  REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
} from '@threadnote/graph/store/removed/view_schema_contracts';

/** Exact released r17 authority fixture; only call on canonical full-scope test rows. */
export const legacyCodeGraphAuthorityStatements = [
  ...EffectArray.map(CODE_GRAPH_SCOPE_QUERY_INDEX_DEFINITIONS, index => `DROP INDEX IF EXISTS ${index.name}`),
  ...EffectArray.map(REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS, trigger => `DROP TRIGGER ${trigger.name}`),
  'DROP TRIGGER active_snapshots_require_current_extractor',
  'DROP TABLE scope_applicability',
  'DROP TABLE snapshot_scope_receipts',
  ...EffectArray.flatMap(
    [
      {
        name: 'active_snapshots',
        columns: ['worktree_id', 'snapshot_id', 'activated_at'],
        sql: `CREATE TABLE active_snapshots (
      worktree_id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      activated_at TEXT NOT NULL
    )`,
      },
      {
        name: 'removed_views',
        columns: ['worktree_id', 'expected_snapshot_id', 'removed_at'],
        sql: REMOVED_VIEWS_TABLE_SQL,
      },
      {
        name: 'removed_view_cleanup',
        columns: EffectArray.map(REMOVED_VIEW_CLEANUP_COLUMNS, column => column.name),
        sql: REMOVED_VIEW_CLEANUP_TABLE_SQL,
      },
    ],
    table => [
      `CREATE TEMP TABLE fixture_${table.name} AS SELECT ${EffectArray.join(table.columns, ', ')} FROM ${table.name}`,
      `DROP TABLE ${table.name}`,
      table.sql,
      `INSERT INTO ${table.name} SELECT * FROM fixture_${table.name}`,
      `DROP TABLE fixture_${table.name}`,
    ],
  ),
  'ALTER TABLE snapshots DROP COLUMN scope_id',
  'CREATE INDEX active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id)',
  REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL,
  ...EffectArray.map(REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS, trigger => trigger.sql),
  CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL,
  "UPDATE schema_metadata SET value = '17' WHERE key = 'persistent_extension_schema_revision'",
];
