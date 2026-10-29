import {Array as EffectArray} from 'effect';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../../index_scope.js';
import {
  REMOVED_VIEW_CLEANUP_COLUMNS,
  REMOVED_VIEW_CLEANUP_TABLE_SQL,
  REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
} from '../removed/view_schema_contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_SCOPE_COLUMN_SQL = `scope_id TEXT NOT NULL DEFAULT '${CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY}'`;

export const SCOPED_ACTIVE_SNAPSHOTS_TABLE_SQL = `CREATE TABLE active_snapshots (
  worktree_id TEXT NOT NULL,
  ${CODE_GRAPH_SCOPE_COLUMN_SQL},
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  activated_at TEXT NOT NULL,
  PRIMARY KEY (worktree_id, scope_id)
)`;

export const SCOPED_REMOVED_VIEWS_TABLE_SQL = `CREATE TABLE removed_views (
  worktree_id TEXT NOT NULL,
  ${CODE_GRAPH_SCOPE_COLUMN_SQL},
  expected_snapshot_id TEXT NOT NULL,
  removed_at TEXT NOT NULL,
  PRIMARY KEY (worktree_id, scope_id)
) WITHOUT ROWID`;

export const SCOPED_REMOVED_VIEW_CLEANUP_TABLE_SQL = Effect.pipe(REMOVED_VIEW_CLEANUP_TABLE_SQL, __effectPipeInput => {
  const __effectPipeStage0 = Effect.pipe(
    __effectPipeInput,
    EffectString.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE'),
  );
  const __effectPipeStage1 = Effect.pipe(
    __effectPipeStage0,
    EffectString.replace(
      '  expected_snapshot_id TEXT',
      `  ${CODE_GRAPH_SCOPE_COLUMN_SQL},\n  expected_snapshot_id TEXT`,
    ),
  );
  const __effectPipeStage2 = Effect.pipe(
    __effectPipeStage1,
    EffectString.replace(
      'PRIMARY KEY (worktree_id, expected_snapshot_id)',
      'PRIMARY KEY (worktree_id, scope_id, expected_snapshot_id)',
    ),
  );
  return __effectPipeStage2;
});

export const SCOPED_REMOVED_VIEW_CLEANUP_COLUMNS = [
  REMOVED_VIEW_CLEANUP_COLUMNS[0],
  {
    name: 'scope_id',
    notNull: true,
    primaryKeyPosition: 2,
    type: 'TEXT',
    defaultValue: `'${CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY}'`,
  },
  {...REMOVED_VIEW_CLEANUP_COLUMNS[1], primaryKeyPosition: 3},
  ...REMOVED_VIEW_CLEANUP_COLUMNS.slice(2),
] as const;

export const SCOPED_REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL = `CREATE INDEX removed_view_cleanup_due
  ON removed_view_cleanup (next_attempt_at, worktree_id, scope_id, expected_snapshot_id)
  WHERE phase <> 'complete'`;

const storedCleanupLiteral = `'${Effect.pipe(SCOPED_REMOVED_VIEW_CLEANUP_TABLE_SQL, EffectString.replaceAll("'", "''"))}'`;
const scopedCleanupGuard = `SELECT CASE WHEN
  (SELECT COUNT(*) FROM sqlite_master WHERE name = 'removed_view_cleanup' COLLATE NOCASE) <> 1
  OR NOT EXISTS (
    SELECT 1 FROM sqlite_master WHERE name = 'removed_view_cleanup' AND type = 'table'
      AND tbl_name = 'removed_view_cleanup' AND sql = ${storedCleanupLiteral}
  )
  OR (SELECT COUNT(*) FROM pragma_index_xinfo('sqlite_autoindex_removed_view_cleanup_1') WHERE "key" = 1) <> 3
  OR (SELECT COUNT(*) FROM pragma_index_xinfo('sqlite_autoindex_removed_view_cleanup_1')
      WHERE "key" = 1 AND "desc" = 0 AND coll = 'BINARY'
        AND ((seqno = 0 AND name = 'worktree_id') OR (seqno = 1 AND name = 'scope_id')
          OR (seqno = 2 AND name = 'expected_snapshot_id'))) <> 3
  THEN RAISE(ABORT, 'code graph removed view cleanup authority is incompatible') END;`;

/** Preserve lease baton validation while revoking only the exact logical view. */
export const SCOPED_REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS = EffectArray.map(
  REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
  trigger => ({
    name: trigger.name,
    sql: Effect.pipe(
      trigger.sql,
      EffectString.replace(/SELECT CASE[\s\S]*?END;/u, scopedCleanupGuard),
      EffectString.replaceAll(
        'WHERE worktree_id = OLD.worktree_id',
        'WHERE worktree_id = OLD.worktree_id AND scope_id = OLD.scope_id',
      ),
      EffectString.replaceAll(
        'WHERE worktree_id = NEW.worktree_id',
        'WHERE worktree_id = NEW.worktree_id AND scope_id = NEW.scope_id',
      ),
      EffectString.replace('UPDATE OF worktree_id,', 'UPDATE OF worktree_id, scope_id,'),
      EffectString.replace(
        'WHEN OLD.worktree_id <> NEW.worktree_id',
        'WHEN OLD.worktree_id <> NEW.worktree_id OR OLD.scope_id <> NEW.scope_id',
      ),
    ),
  }),
);

export const SNAPSHOT_SCOPE_RECEIPTS_TABLE_SQL = `CREATE TABLE snapshot_scope_receipts (
  snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  definition_digest TEXT,
  closure_digest TEXT,
  included_root_ids_json TEXT NOT NULL,
  included_component_ids_json TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial', 'legacy-full')),
  diagnostics_json TEXT NOT NULL
) WITHOUT ROWID`;

export const SCOPE_APPLICABILITY_TABLE_SQL = `CREATE TABLE scope_applicability (
  worktree_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  observed_commit TEXT NOT NULL,
  overlay_fingerprint TEXT,
  active_snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  definition_digest TEXT,
  closure_digest TEXT,
  inventory_fingerprint TEXT,
  extractor_set TEXT NOT NULL,
  admission_evidence_json TEXT,
  PRIMARY KEY (worktree_id, scope_id)
) WITHOUT ROWID`;
