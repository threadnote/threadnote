import * as EffectString from 'effect/String';
import * as Effect from 'effect';
export const REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY = 'removed_view_cleanup_admission_cursor';
export const REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY = 'removed_view_cleanup_epoch_sequence';
export const MAXIMUM_CANONICAL_DATE_MILLISECONDS = 253_402_300_799_999;

export const REMOVED_VIEWS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS removed_views (
  worktree_id TEXT PRIMARY KEY NOT NULL,
  expected_snapshot_id TEXT NOT NULL,
  removed_at TEXT NOT NULL
) WITHOUT ROWID`;

export const REMOVED_VIEW_CLEANUP_TABLE_SQL = `CREATE TABLE IF NOT EXISTS removed_view_cleanup (
  worktree_id TEXT NOT NULL CHECK (
    typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
  ),
  expected_snapshot_id TEXT NOT NULL CHECK (
    typeof(expected_snapshot_id) = 'text'
    AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
  ),
  removed_at TEXT NOT NULL CHECK (
    typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
  ),
  epoch INTEGER NOT NULL CHECK (
    typeof(epoch) = 'integer' AND epoch BETWEEN 1 AND 9007199254740991
  ),
  repository_id TEXT CHECK (
    repository_id IS NULL
    OR (typeof(repository_id) = 'text' AND length(CAST(repository_id AS BLOB)) = 64)
  ),
  provenance_record_digest TEXT CHECK (
    provenance_record_digest IS NULL
    OR (
      typeof(provenance_record_digest) = 'text'
      AND length(CAST(provenance_record_digest AS BLOB)) = 64
    )
  ),
  provenance_record_identity TEXT CHECK (
    provenance_record_identity IS NULL
    OR (
      typeof(provenance_record_identity) = 'text'
      AND length(CAST(provenance_record_identity AS BLOB)) = 64
    )
  ),
  phase TEXT NOT NULL CHECK (
    typeof(phase) = 'text'
    AND length(CAST(phase AS BLOB)) <= 15
    AND phase IN ('vector-pointers', 'build-status', 'provenance', 'complete')
  ),
  cursor_token TEXT CHECK (
    cursor_token IS NULL
    OR (typeof(cursor_token) = 'text' AND length(CAST(cursor_token AS BLOB)) BETWEEN 1 AND 512)
  ),
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991
  ),
  attempts INTEGER NOT NULL CHECK (
    typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 9007199254740991
  ),
  next_attempt_at INTEGER NOT NULL CHECK (
    typeof(next_attempt_at) = 'integer' AND next_attempt_at BETWEEN 0 AND 253402300799999
  ),
  blocked_code TEXT CHECK (
    blocked_code IS NULL
    OR (
      typeof(blocked_code) = 'text'
      AND length(CAST(blocked_code AS BLOB)) BETWEEN 1 AND 32
      AND blocked_code IN (
        'busy', 'evidence-unavailable', 'invalid-sidecar',
        'io-error', 'permission-denied', 'schema-incompatible'
      )
    )
  ),
  updated_at TEXT NOT NULL CHECK (
    typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24
  ),
  PRIMARY KEY (worktree_id, expected_snapshot_id),
  CHECK (phase <> 'complete' OR (cursor_token IS NULL AND blocked_code IS NULL)),
  CHECK (
    (repository_id IS NULL AND provenance_record_digest IS NULL AND provenance_record_identity IS NULL)
    OR (
      repository_id IS NOT NULL
      AND provenance_record_digest IS NOT NULL
      AND provenance_record_identity IS NOT NULL
    )
  )
) WITHOUT ROWID`;

const REMOVED_VIEW_CLEANUP_STORED_TABLE_SQL = Effect.pipe(
  REMOVED_VIEW_CLEANUP_TABLE_SQL,
  EffectString.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE'),
);
const REMOVED_VIEW_CLEANUP_STORED_TABLE_SQL_LITERAL = `'${Effect.pipe(REMOVED_VIEW_CLEANUP_STORED_TABLE_SQL, EffectString.replaceAll("'", "''"))}'`;

export const REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS removed_view_cleanup_due
  ON removed_view_cleanup (next_attempt_at, worktree_id, expected_snapshot_id)
  WHERE phase <> 'complete'`;

const REMOVED_VIEW_CLEANUP_PRIMARY_KEY_TRIGGER_GUARD_SQL = `SELECT CASE
      WHEN (
        SELECT COUNT(*)
        FROM (
          SELECT name, type, tbl_name,
                 CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql ELSE NULL END AS sql
          FROM sqlite_master
          WHERE name = 'removed_view_cleanup' COLLATE NOCASE
          LIMIT 2
        )
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM (
          SELECT name, type, tbl_name,
                 CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql ELSE NULL END AS sql
          FROM sqlite_master
          WHERE name = 'removed_view_cleanup' COLLATE NOCASE
          LIMIT 2
        )
        WHERE name = 'removed_view_cleanup'
          AND type = 'table'
          AND tbl_name = 'removed_view_cleanup'
          AND sql = ${REMOVED_VIEW_CLEANUP_STORED_TABLE_SQL_LITERAL}
      )
      OR (
        SELECT COUNT(*)
        FROM (
          SELECT seqno, cid, name, "desc", coll, "key"
          FROM pragma_index_xinfo('sqlite_autoindex_removed_view_cleanup_1')
          LIMIT 3
        )
        WHERE (
          seqno = 0 AND cid = 0 AND name = 'worktree_id'
            AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
        ) OR (
          seqno = 1 AND cid = 1 AND name = 'expected_snapshot_id'
            AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
        ) OR (
          seqno = 2 AND cid = 2 AND name = 'removed_at'
            AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
        )
      ) <> 3
      THEN RAISE(ABORT, 'code graph removed view cleanup authority is incompatible')
    END;`;

const REMOVED_VIEW_CLEANUP_REVOKE_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS removed_views_cleanup_revoke_delete
  AFTER DELETE ON removed_views
  BEGIN
    ${REMOVED_VIEW_CLEANUP_PRIMARY_KEY_TRIGGER_GUARD_SQL}
    DELETE FROM removed_view_cleanup
    WHERE worktree_id = OLD.worktree_id
      AND expected_snapshot_id = OLD.expected_snapshot_id
      AND removed_at = OLD.removed_at;
  END`;

const SNAPSHOT_LEASE_BATON_INDEX_TRIGGER_GUARD_SQL = Effect.pipe(
  `SELECT CASE
      WHEN (
        SELECT COUNT(*)
        FROM (
          SELECT name, type, tbl_name,
                 CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 1024 THEN sql ELSE NULL END AS sql
          FROM sqlite_master
          WHERE name = 'snapshot_leases_snapshot_expiry' COLLATE NOCASE
          LIMIT 2
        )
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM (
          SELECT name, type, tbl_name,
                 CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 1024 THEN sql ELSE NULL END AS sql
          FROM sqlite_master
          WHERE name = 'snapshot_leases_snapshot_expiry' COLLATE NOCASE
          LIMIT 2
        )
        WHERE name = 'snapshot_leases_snapshot_expiry'
          AND type = 'index'
          AND tbl_name = 'snapshot_leases'
          AND typeof(sql) = 'text'
          AND length(CAST(sql AS BLOB)) <= 1024
          AND sql = 'CREATE INDEX snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)'
      )
      OR (
        SELECT COUNT(*)
        FROM (
          SELECT seqno, cid, name, "desc", coll, "key"
          FROM pragma_index_xinfo('snapshot_leases_snapshot_expiry')
          LIMIT 4
        )
      ) <> 3
      OR (
        SELECT COUNT(*)
        FROM (
          SELECT seqno, cid, name, "desc", coll, "key"
          FROM pragma_index_xinfo('snapshot_leases_snapshot_expiry')
          LIMIT 4
        )
        WHERE (
          seqno = 0 AND name = 'snapshot_id' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
        ) OR (
          seqno = 1 AND name = 'expires_at' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
        ) OR (
          seqno = 2 AND cid = -1 AND name IS NULL AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
        )
      ) <> 3
      OR EXISTS (
        SELECT 1
        FROM (
          SELECT
            typeof(token) AS token_type,
            length(CAST(token AS BLOB)) AS token_bytes,
            typeof(snapshot_id) AS snapshot_type,
            length(CAST(snapshot_id AS BLOB)) AS snapshot_bytes,
            CASE
              WHEN typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 253402300799999
              THEN 1 ELSE 0
            END AS expires_valid,
            CASE
              WHEN typeof(retire_when_inactive) = 'integer' AND retire_when_inactive IN (0, 1)
              THEN 1 ELSE 0
            END AS retire_valid
          FROM snapshot_leases INDEXED BY snapshot_leases_snapshot_expiry
          WHERE snapshot_id = NEW.expected_snapshot_id
            AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
          ORDER BY expires_at
          LIMIT 1
        )
        WHERE token_type <> 'text'
          OR token_bytes NOT BETWEEN 1 AND 1024
          OR snapshot_type <> 'text'
          OR snapshot_bytes NOT BETWEEN 1 AND 1024
          OR expires_valid <> 1
          OR retire_valid <> 1
      )
      THEN RAISE(ABORT, 'code graph snapshot lease baton index is incompatible')
    END;`,
  EffectString.replace(/\s+/gu, ' '),
  EffectString.trim,
);

const REMOVED_VIEW_CLEANUP_REVOKE_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS removed_views_cleanup_revoke_insert
  AFTER INSERT ON removed_views
  BEGIN
    ${REMOVED_VIEW_CLEANUP_PRIMARY_KEY_TRIGGER_GUARD_SQL}
    ${SNAPSHOT_LEASE_BATON_INDEX_TRIGGER_GUARD_SQL}
    DELETE FROM removed_view_cleanup
    WHERE worktree_id = NEW.worktree_id
      AND expected_snapshot_id = NEW.expected_snapshot_id;
    UPDATE snapshot_leases
    SET retire_when_inactive = 1
    WHERE rowid = (
      SELECT rowid
      FROM snapshot_leases INDEXED BY snapshot_leases_snapshot_expiry
      WHERE snapshot_id = NEW.expected_snapshot_id
        AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ORDER BY expires_at
      LIMIT 1
    );
  END`;

const REMOVED_VIEW_CLEANUP_REVOKE_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS removed_views_cleanup_revoke_update
  AFTER UPDATE OF worktree_id, expected_snapshot_id, removed_at ON removed_views
  WHEN OLD.worktree_id <> NEW.worktree_id
    OR OLD.expected_snapshot_id <> NEW.expected_snapshot_id
    OR OLD.removed_at <> NEW.removed_at
  BEGIN
    ${REMOVED_VIEW_CLEANUP_PRIMARY_KEY_TRIGGER_GUARD_SQL}
    ${SNAPSHOT_LEASE_BATON_INDEX_TRIGGER_GUARD_SQL}
    DELETE FROM removed_view_cleanup
    WHERE worktree_id = OLD.worktree_id
      AND expected_snapshot_id = OLD.expected_snapshot_id
      AND removed_at = OLD.removed_at
      AND phase <> 'complete';
    DELETE FROM removed_view_cleanup
    WHERE worktree_id = NEW.worktree_id
      AND expected_snapshot_id = NEW.expected_snapshot_id;
    UPDATE snapshot_leases
    SET retire_when_inactive = 1
    WHERE rowid = (
      SELECT rowid
      FROM snapshot_leases INDEXED BY snapshot_leases_snapshot_expiry
      WHERE snapshot_id = NEW.expected_snapshot_id
        AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ORDER BY expires_at
      LIMIT 1
    );
  END`;

export const REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS = [
  {name: 'removed_views_cleanup_revoke_delete', sql: REMOVED_VIEW_CLEANUP_REVOKE_DELETE_TRIGGER_SQL},
  {name: 'removed_views_cleanup_revoke_insert', sql: REMOVED_VIEW_CLEANUP_REVOKE_INSERT_TRIGGER_SQL},
  {name: 'removed_views_cleanup_revoke_update', sql: REMOVED_VIEW_CLEANUP_REVOKE_UPDATE_TRIGGER_SQL},
] as const;

export const REMOVED_VIEW_CLEANUP_COLUMNS = [
  {name: 'worktree_id', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
  {name: 'expected_snapshot_id', notNull: true, primaryKeyPosition: 2, type: 'TEXT'},
  {name: 'removed_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'epoch', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  {name: 'repository_id', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'provenance_record_digest', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'provenance_record_identity', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'phase', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'cursor_token', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'revision', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  {name: 'attempts', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  {name: 'next_attempt_at', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  {name: 'blocked_code', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'updated_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
] as const;
