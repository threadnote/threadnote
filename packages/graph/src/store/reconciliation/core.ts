import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_BLOCKED_CODES,
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES,
  type CodeGraphRemovedViewCleanupBlockedCode,
  type CodeGraphRemovedViewCleanupEntry,
  type CodeGraphRemovedViewCleanupEvidence,
  type CodeGraphRemovedViewCleanupPhase,
  type CodeGraphViewObservationResult,
} from '../models.js';
import {
  MAXIMUM_CANONICAL_DATE_MILLISECONDS,
  REMOVED_VIEW_CLEANUP_COLUMNS,
  REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY,
} from '../removed/view_schema_contracts.js';
import {removedViewCleanupRecordedRevision} from '../removed/view_schema_inspection.js';
import {normalizeSchemaDefinition} from '../schema/normalization.js';
import {inspectBoundedSchemaMetadataValue} from '../schema/metadata.js';
import {tableExists} from '../session.js';
import {CodeGraphStoreError} from '../../types.js';
import {type CodeGraphSqlQueryStatement} from '../visualization_sql.js';
import {lastStatementChangeCount} from '../activation/core.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../../index_scope.js';
import {codeGraphScopeCursorParameters} from '../scope/cursor.js';
import {codeGraphScopeAuthorityInstalled} from '../scope/schema.js';

const validateViewRemovalTarget = Effect.fn('codeGraph.validateViewRemovalTarget')(function* (
  worktreeId: string,
  expectedSnapshotId: string,
) {
  if (!/^[0-9a-f]{64}$/.test(worktreeId)) {
    return yield* CodeGraphStoreError.of('Code graph worktree identity is invalid.');
  }
  if (!CODE_GRAPH_SNAPSHOT_ID.test(expectedSnapshotId)) {
    return yield* CodeGraphStoreError.of('Code graph snapshot identity is invalid.');
  }
});

const observeActiveView = Effect.fn('codeGraph.observeActiveView')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  expectedSnapshotId: string,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const activeViewsAvailable = yield* tableExists(sql, 'active_snapshots');
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const scoped = yield* codeGraphScopeAuthorityInstalled(sql);
  if (!scoped && scopeId !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY)
    return {expectedSnapshotId, state: 'not-found'} as const;
  const active = activeViewsAvailable
    ? yield* sql.unsafe<{readonly snapshot_id: unknown}>(
        `SELECT CASE
           WHEN typeof(snapshot_id) = 'text' AND length(CAST(snapshot_id AS BLOB)) BETWEEN 45 AND 67
           THEN snapshot_id ELSE NULL END AS snapshot_id
         FROM active_snapshots WHERE worktree_id = ? ${scoped ? 'AND scope_id = ?' : ''} LIMIT 2`,
        scoped ? [worktreeId, scopeId] : [worktreeId],
      )
    : [];
  const removed = removedViewsAvailable
    ? yield* sql.unsafe<{readonly expected_snapshot_id: unknown}>(
        `SELECT CASE
           WHEN typeof(expected_snapshot_id) = 'text'
                AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
           THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id
         FROM removed_views WHERE worktree_id = ? ${scoped ? 'AND scope_id = ?' : ''} LIMIT 2`,
        scoped ? [worktreeId, scopeId] : [worktreeId],
      )
    : [];
  const activeSnapshotId = active[0]?.snapshot_id;
  const removedSnapshotId = removed[0]?.expected_snapshot_id;

  if (
    active.length > 1 ||
    removed.length > 1 ||
    (activeSnapshotId !== undefined &&
      (typeof activeSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(activeSnapshotId))) ||
    (removedSnapshotId !== undefined &&
      (typeof removedSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(removedSnapshotId)))
  ) {
    return yield* CodeGraphStoreError.of('Code graph view authority is invalid.');
  }

  if (activeSnapshotId !== undefined && activeSnapshotId !== expectedSnapshotId) {
    return {
      expectedSnapshotId,
      observedSnapshotId: activeSnapshotId,
      observedState: 'active',
      state: 'stale-target',
    } satisfies CodeGraphViewObservationResult;
  }
  if (activeSnapshotId === expectedSnapshotId) {
    return {
      expectedSnapshotId,
      state: removedSnapshotId === expectedSnapshotId ? 'already-removed' : 'ready',
    } satisfies CodeGraphViewObservationResult;
  }
  if (removedSnapshotId === expectedSnapshotId) {
    return {expectedSnapshotId, state: 'already-removed'} satisfies CodeGraphViewObservationResult;
  }
  if (removedSnapshotId !== undefined) {
    return {
      expectedSnapshotId,
      observedSnapshotId: removedSnapshotId,
      observedState: 'removed',
      state: 'stale-target',
    } satisfies CodeGraphViewObservationResult;
  }
  return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewObservationResult;
});

/** @internal Indexed cursor-page statement retained for query-plan and high-cardinality regressions. */
export function codeGraphWorktreeReconciliationCandidatePageStatement(
  cursor: string | undefined,
  boundary: 'after' | 'through',
  requestedLimit: number,
): CodeGraphSqlQueryStatement {
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(32, requestedLimit)) : 32;
  const cursorPredicate =
    cursor === undefined
      ? ''
      : boundary === 'after'
        ? 'WHERE (worktree_id, scope_id) > (?, ?)'
        : 'WHERE (worktree_id, scope_id) <= (?, ?)';
  return {
    parameters: cursor === undefined ? [limit] : [...codeGraphScopeCursorParameters(cursor), limit],
    text: `WITH raw_page AS MATERIALIZED (
        SELECT worktree_id, scope_id, snapshot_id
        FROM active_snapshots
        ${cursorPredicate}
        ORDER BY worktree_id, scope_id
        LIMIT ?
      )
      SELECT
        snapshots.repository_id,
        raw_page.snapshot_id,
        snapshots.state AS snapshot_state,
        CASE WHEN removed.worktree_id IS NULL THEN 0 ELSE 1 END AS tombstoned,
        raw_page.worktree_id, raw_page.scope_id
      FROM raw_page
      LEFT JOIN snapshots ON snapshots.id = raw_page.snapshot_id
      LEFT JOIN removed_views AS removed
        ON removed.worktree_id = raw_page.worktree_id
       AND removed.scope_id = raw_page.scope_id
       AND removed.expected_snapshot_id = raw_page.snapshot_id
      ORDER BY raw_page.worktree_id, raw_page.scope_id`,
  };
}

interface CodeGraphReconciliationSchemaColumn {
  readonly defaultValue?: string;
  readonly name: string;
  readonly notNull: boolean;
  readonly primaryKeyPosition: number;
  readonly type: string;
}

const CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS = {
  active_snapshots: [
    {name: 'worktree_id', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'snapshot_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'activated_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  ],
  removed_views: [
    {name: 'worktree_id', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'expected_snapshot_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'removed_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  ],
  removed_view_cleanup: REMOVED_VIEW_CLEANUP_COLUMNS,
  schema_metadata: [
    {name: 'key', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'value', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  ],
  snapshots: [
    {name: 'id', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'repository_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'worktree_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'commit_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'graph_content_id', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'base_snapshot_id', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'extractor_set', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'dirty', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {name: 'overlay_fingerprint', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'state', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'file_count', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {name: 'symbol_count', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {name: 'edge_count', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {name: 'started_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'completed_at', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'failure_summary', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  ],
  snapshot_leases: [
    {name: 'token', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'snapshot_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'expires_at', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {defaultValue: '0', name: 'retire_when_inactive', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  ],
} as const satisfies Record<string, readonly CodeGraphReconciliationSchemaColumn[]>;

type CodeGraphReconciliationTable = keyof typeof CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS;

const CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES = [
  {
    columns: ['snapshot_id', 'worktree_id'],
    definition: 'CREATE INDEX active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id)',
    name: 'active_snapshots_snapshot_worktree',
    table: 'active_snapshots',
  },
  {
    columns: ['base_snapshot_id', 'state', 'id'],
    definition: 'CREATE INDEX snapshots_base_state_id ON snapshots(base_snapshot_id, state, id)',
    name: 'snapshots_base_state_id',
    table: 'snapshots',
  },
  {
    columns: ['snapshot_id', 'expires_at'],
    definition: 'CREATE INDEX snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)',
    name: 'snapshot_leases_snapshot_expiry',
    table: 'snapshot_leases',
  },
] as const;

const CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX = {
  columns: ['expires_at'],
  definition: 'CREATE INDEX snapshot_leases_expiry ON snapshot_leases(expires_at)',
  name: 'snapshot_leases_expiry',
  table: 'snapshot_leases',
} as const;

const authorityPrimaryKeyBinary = Effect.fn('codeGraph.authorityPrimaryKeyBinary')(function* (
  sql: SqlClient.SqlClient,
  table: 'active_snapshots' | 'snapshot_leases' | 'snapshots',
  column: 'id' | 'token' | 'worktree_id',
) {
  const expectedName = `sqlite_autoindex_${table}_1`;
  const indexes = yield* sql.unsafe<{
    readonly name: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, tbl_name, type
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT 2`,
    [expectedName],
  );
  const name = indexes[0]?.name;
  if (
    indexes.length !== 1 ||
    typeof name !== 'string' ||
    name !== expectedName ||
    indexes[0]?.tbl_name !== table ||
    indexes[0]?.type !== 'index'
  ) {
    return false;
  }
  const columns = yield* sql.unsafe<{
    readonly cid: unknown;
    readonly coll: unknown;
    readonly desc: unknown;
    readonly key: unknown;
    readonly name: unknown;
    readonly seqno: unknown;
  }>(`SELECT * FROM pragma_index_xinfo(?) LIMIT 3`, [name]);
  return (
    columns.length === 2 &&
    columns[0]?.seqno === 0 &&
    columns[0]?.name === column &&
    columns[0]?.desc === 0 &&
    columns[0]?.coll === 'BINARY' &&
    columns[0]?.key === 1 &&
    columns[1]?.seqno === 1 &&
    columns[1]?.cid === -1 &&
    columns[1]?.name === null &&
    columns[1]?.desc === 0 &&
    columns[1]?.coll === 'BINARY' &&
    columns[1]?.key === 0
  );
});

const boundedAuthorityTableDefinition = Effect.fn('codeGraph.boundedAuthorityTableDefinition')(function* (
  sql: SqlClient.SqlClient,
  table: 'snapshot_leases' | 'snapshots',
) {
  const definitions = yield* sql.unsafe<{
    readonly bounded_sql: unknown;
    readonly name: unknown;
    readonly sql_bytes: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql
              ELSE NULL
            END AS bounded_sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT 2`,
    [table],
  );
  const definition = definitions[0];
  return definitions.length === 1 &&
    definition?.name === table &&
    definition.type === 'table' &&
    definition.tbl_name === table &&
    typeof definition.sql_bytes === 'number' &&
    Number.isSafeInteger(definition.sql_bytes) &&
    definition.sql_bytes <= 8192 &&
    typeof definition.bounded_sql === 'string'
    ? definition.bounded_sql
    : undefined;
});

function exactCodeGraphSnapshotStateCheck(definition: string): boolean {
  const match = /\bstate\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\((?<values>[^)]*)\)\s*\)/iu.exec(definition);
  const values = match?.groups?.values;
  if (values === undefined || values.replace(/'[^']*'/gu, '').replace(/[\s,]/gu, '') !== '') return false;
  return (
    [...values.matchAll(/'([^']*)'/gu)].map(value => value[1]).join('\0') ===
    ['building', 'ready', 'failed', 'retired'].join('\0')
  );
}

type CodeGraphReconciliationRequiredIndex =
  (typeof CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES)[number] | typeof CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX;

const codeGraphReconciliationIndexState = Effect.fn('codeGraph.reconciliationIndexState')(function* (
  sql: SqlClient.SqlClient,
  index: CodeGraphReconciliationRequiredIndex,
) {
  const definitions = yield* sql.unsafe<{
    readonly bounded_sql: unknown;
    readonly name: unknown;
    readonly sql_bytes: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 1024 THEN sql
              ELSE NULL
            END AS bounded_sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT 2`,
    [index.name],
  );
  if (definitions.length === 0) return 'missing' as const;
  if (
    definitions.length !== 1 ||
    definitions[0]?.name !== index.name ||
    definitions[0]?.type !== 'index' ||
    definitions[0]?.tbl_name !== index.table ||
    typeof definitions[0]?.sql_bytes !== 'number' ||
    !Number.isSafeInteger(definitions[0].sql_bytes) ||
    definitions[0].sql_bytes > 1024 ||
    typeof definitions[0]?.bounded_sql !== 'string' ||
    normalizeSchemaDefinition(definitions[0].bounded_sql) !== normalizeSchemaDefinition(index.definition)
  ) {
    return 'incompatible' as const;
  }
  const xinfo = yield* sql.unsafe<{
    readonly coll: string;
    readonly desc: number;
    readonly key: number;
    readonly name: string | null;
    readonly seqno: number;
  }>(`SELECT * FROM pragma_index_xinfo(?) LIMIT ${index.columns.length + 2}`, [index.name]);
  const keyColumns = xinfo.filter(column => Number(column.key) === 1).sort((left, right) => left.seqno - right.seqno);
  return xinfo.length === index.columns.length + 1 &&
    keyColumns.length === index.columns.length &&
    keyColumns.every(
      (column, columnIndex) =>
        column.name === index.columns[columnIndex] &&
        column.coll.toUpperCase() === 'BINARY' &&
        Number(column.desc) === 0,
    )
    ? ('ready' as const)
    : ('incompatible' as const);
});

const ensureInitialReconciliationIndexes = Effect.fn('codeGraph.ensureInitialReconciliationIndexes')(function* (
  sql: SqlClient.SqlClient,
) {
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  const expiryIndexState = yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX);
  if (expiryIndexState !== 'ready') {
    if (expiryIndexState === 'incompatible') {
      return yield* CodeGraphStoreError.of('Code graph snapshot lease expiry index is incompatible.');
    }
    const rows = yield* sql.unsafe('SELECT 1 FROM snapshot_leases LIMIT 1');
    if (revision.state !== 'missing' || rows.length !== 0) {
      return yield* CodeGraphStoreError.of('Code graph snapshot lease expiry index is unavailable.');
    }
    yield* sql.unsafe(CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX.definition);
    if ((yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX)) !== 'ready') {
      return yield* CodeGraphStoreError.of('Code graph snapshot lease expiry index changed during setup.');
    }
  }
  for (const index of CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES) {
    const state = yield* codeGraphReconciliationIndexState(sql, index);
    if (state === 'ready') continue;
    if (state === 'incompatible') {
      return yield* CodeGraphStoreError.of('Code graph reconciliation index is incompatible.');
    }
    // Only an empty, not-yet-versioned core database may create all required
    // indexes synchronously. Existing databases prepare one missing index per
    // bounded maintenance tick before publishing revision 8.
    if (revision.state !== 'missing') {
      return yield* CodeGraphStoreError.of('Code graph reconciliation index is unavailable.');
    }
    const rows = yield* sql.unsafe(`SELECT 1 FROM "${index.table}" LIMIT 1`);
    if (rows.length !== 0) {
      return yield* CodeGraphStoreError.of('Code graph reconciliation index requires preparation.');
    }
    yield* sql.unsafe(index.definition);
    if ((yield* codeGraphReconciliationIndexState(sql, index)) !== 'ready') {
      return yield* CodeGraphStoreError.of('Code graph reconciliation index changed during setup.');
    }
  }
});

interface RemovedViewCleanupRow {
  readonly scope_id?: unknown;
  readonly attempts: unknown;
  readonly blocked_code: unknown;
  readonly cursor_token: unknown;
  readonly epoch: unknown;
  readonly expected_snapshot_id: unknown;
  readonly next_attempt_at: unknown;
  readonly phase: unknown;
  readonly provenance_record_digest: unknown;
  readonly provenance_record_identity: unknown;
  readonly removed_at: unknown;
  readonly repository_id: unknown;
  readonly revision: unknown;
  readonly updated_at: unknown;
  readonly worktree_id: unknown;
}

const REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION = `
  CASE WHEN typeof(scope_id) = 'text' AND length(CAST(scope_id AS BLOB)) BETWEEN 1 AND 81
    THEN scope_id ELSE NULL END AS scope_id,
  CASE WHEN typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
    THEN worktree_id ELSE NULL END AS worktree_id,
  CASE WHEN typeof(expected_snapshot_id) = 'text'
         AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
    THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id,
  CASE WHEN typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
    THEN removed_at ELSE NULL END AS removed_at,
  CASE WHEN typeof(epoch) = 'integer' AND epoch BETWEEN 1 AND 9007199254740991
    THEN epoch ELSE NULL END AS epoch,
  CASE WHEN repository_id IS NULL OR (
         typeof(repository_id) = 'text' AND length(CAST(repository_id AS BLOB)) = 64
       ) THEN repository_id ELSE 0 END AS repository_id,
  CASE WHEN provenance_record_digest IS NULL OR (
         typeof(provenance_record_digest) = 'text'
         AND length(CAST(provenance_record_digest AS BLOB)) = 64
       ) THEN provenance_record_digest ELSE 0 END AS provenance_record_digest,
  CASE WHEN provenance_record_identity IS NULL OR (
         typeof(provenance_record_identity) = 'text'
         AND length(CAST(provenance_record_identity AS BLOB)) = 64
       ) THEN provenance_record_identity ELSE 0 END AS provenance_record_identity,
  CASE WHEN typeof(phase) = 'text' AND length(CAST(phase AS BLOB)) <= 15
    THEN phase ELSE NULL END AS phase,
  CASE WHEN cursor_token IS NULL OR (
         typeof(cursor_token) = 'text' AND length(CAST(cursor_token AS BLOB)) BETWEEN 1 AND 512
       ) THEN cursor_token ELSE 0 END AS cursor_token,
  CASE WHEN typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991
    THEN revision ELSE NULL END AS revision,
  CASE WHEN typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 9007199254740991
    THEN attempts ELSE NULL END AS attempts,
  CASE WHEN typeof(next_attempt_at) = 'integer' AND next_attempt_at BETWEEN 0 AND 253402300799999
    THEN next_attempt_at ELSE NULL END AS next_attempt_at,
  CASE WHEN blocked_code IS NULL OR (
         typeof(blocked_code) = 'text' AND length(CAST(blocked_code AS BLOB)) BETWEEN 1 AND 32
       ) THEN blocked_code ELSE 0 END AS blocked_code,
  CASE WHEN typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24
    THEN updated_at ELSE NULL END AS updated_at`;

const CLEANUP_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/u;

const CODE_GRAPH_SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;

function validRemovedViewCleanupBlockedCode(value: string): value is CodeGraphRemovedViewCleanupBlockedCode {
  return CODE_GRAPH_REMOVED_VIEW_CLEANUP_BLOCKED_CODES.some(code => code === value);
}

function validRemovedViewCleanupPhase(value: string): value is CodeGraphRemovedViewCleanupPhase {
  return CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.some(phase => phase === value);
}

function validCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    value.length === 24 &&
    Number.isFinite(milliseconds) &&
    milliseconds <= MAXIMUM_CANONICAL_DATE_MILLISECONDS &&
    new Date(milliseconds).toISOString() === value
  );
}

function validRemovedViewCleanupEvidence(evidence: CodeGraphRemovedViewCleanupEvidence): boolean {
  return (
    /^[0-9a-f]{64}$/u.test(evidence.repositoryId) &&
    /^[0-9a-f]{64}$/u.test(evidence.recordDigest) &&
    /^[0-9a-f]{64}$/u.test(evidence.recordIdentity)
  );
}

function decodeRemovedViewCleanupRow(row: RemovedViewCleanupRow): CodeGraphRemovedViewCleanupEntry | undefined {
  if (
    (row.scope_id !== undefined &&
      row.scope_id !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY &&
      (typeof row.scope_id !== 'string' || !/^code-graph-scope:[0-9a-f]{64}$/u.test(row.scope_id))) ||
    typeof row.worktree_id !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(row.worktree_id) ||
    typeof row.expected_snapshot_id !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(row.expected_snapshot_id) ||
    typeof row.removed_at !== 'string' ||
    !validCanonicalTimestamp(row.removed_at) ||
    typeof row.epoch !== 'number' ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch <= 0 ||
    (row.repository_id !== null &&
      (typeof row.repository_id !== 'string' || !/^[0-9a-f]{64}$/u.test(row.repository_id))) ||
    (row.provenance_record_digest !== null &&
      (typeof row.provenance_record_digest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.provenance_record_digest))) ||
    (row.provenance_record_identity !== null &&
      (typeof row.provenance_record_identity !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(row.provenance_record_identity))) ||
    !(
      (row.repository_id === null &&
        row.provenance_record_digest === null &&
        row.provenance_record_identity === null) ||
      (typeof row.repository_id === 'string' &&
        typeof row.provenance_record_digest === 'string' &&
        typeof row.provenance_record_identity === 'string')
    ) ||
    typeof row.phase !== 'string' ||
    !validRemovedViewCleanupPhase(row.phase) ||
    (row.cursor_token !== null && (typeof row.cursor_token !== 'string' || !CLEANUP_TOKEN.test(row.cursor_token))) ||
    (row.phase === 'complete' && (row.cursor_token !== null || row.blocked_code !== null)) ||
    typeof row.revision !== 'number' ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    typeof row.attempts !== 'number' ||
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 0 ||
    typeof row.next_attempt_at !== 'number' ||
    !Number.isSafeInteger(row.next_attempt_at) ||
    row.next_attempt_at < 0 ||
    row.next_attempt_at > MAXIMUM_CANONICAL_DATE_MILLISECONDS ||
    (row.blocked_code !== null &&
      (typeof row.blocked_code !== 'string' || !validRemovedViewCleanupBlockedCode(row.blocked_code))) ||
    typeof row.updated_at !== 'string' ||
    !validCanonicalTimestamp(row.updated_at)
  ) {
    return undefined;
  }
  return {
    ...(typeof row.scope_id === 'string' && row.scope_id !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY
      ? {scopeId: row.scope_id}
      : {}),
    attempts: row.attempts,
    ...(typeof row.blocked_code === 'string' ? {blockedCode: row.blocked_code} : {}),
    ...(typeof row.cursor_token === 'string' ? {cursorToken: row.cursor_token} : {}),
    epoch: row.epoch,
    expectedSnapshotId: row.expected_snapshot_id,
    nextAttemptAt: row.next_attempt_at,
    phase: row.phase,
    ...(typeof row.provenance_record_digest === 'string' ? {provenanceRecordDigest: row.provenance_record_digest} : {}),
    ...(typeof row.provenance_record_identity === 'string'
      ? {provenanceRecordIdentity: row.provenance_record_identity}
      : {}),
    removedAt: row.removed_at,
    ...(typeof row.repository_id === 'string' ? {repositoryId: row.repository_id} : {}),
    revision: row.revision,
    updatedAt: row.updated_at,
    worktreeId: row.worktree_id,
  };
}

function sameRemovedViewCleanupEntry(
  left: CodeGraphRemovedViewCleanupEntry,
  right: CodeGraphRemovedViewCleanupEntry,
): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    (left.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) ===
      (right.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) &&
    left.expectedSnapshotId === right.expectedSnapshotId &&
    left.removedAt === right.removedAt &&
    left.epoch === right.epoch &&
    left.repositoryId === right.repositoryId &&
    left.provenanceRecordDigest === right.provenanceRecordDigest &&
    left.provenanceRecordIdentity === right.provenanceRecordIdentity &&
    left.phase === right.phase &&
    left.cursorToken === right.cursorToken &&
    left.revision === right.revision &&
    left.attempts === right.attempts &&
    left.nextAttemptAt === right.nextAttemptAt &&
    left.blockedCode === right.blockedCode &&
    left.updatedAt === right.updatedAt
  );
}

const selectRemovedViewCleanupEntry = Effect.fn('codeGraph.selectRemovedViewCleanupEntry')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  expectedSnapshotId: string,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const rows = yield* sql.unsafe<RemovedViewCleanupRow>(
    `SELECT ${REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION}
     FROM removed_view_cleanup
     WHERE worktree_id = ? AND scope_id = ? AND expected_snapshot_id = ?
     LIMIT 1`,
    [worktreeId, scopeId, expectedSnapshotId],
  );
  if (rows.length === 0) return undefined;
  const entry = decodeRemovedViewCleanupRow(rows[0]);
  if (entry === undefined) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup row is invalid.');
  }
  return entry;
});

const validateRemovedViewSnapshotAuthority = Effect.fn('codeGraph.validateRemovedViewSnapshotAuthority')(function* (
  sql: SqlClient.SqlClient,
  expectedSnapshotId: string,
  requireSnapshot: boolean,
  evidence?: CodeGraphRemovedViewCleanupEvidence,
) {
  const snapshots = yield* sql.unsafe<{
    readonly id: unknown;
    readonly repository_id: unknown;
    readonly worktree_id: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) BETWEEN 45 AND 67
         THEN id ELSE NULL END AS id,
       CASE WHEN typeof(repository_id) = 'text' AND length(CAST(repository_id AS BLOB)) = 64
         THEN repository_id ELSE NULL END AS repository_id,
       CASE WHEN typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
         THEN worktree_id ELSE NULL END AS worktree_id
     FROM snapshots WHERE id = ? LIMIT 2`,
    [expectedSnapshotId],
  );
  if (snapshots.length === 0) {
    if (!requireSnapshot) return;
    return yield* CodeGraphStoreError.of('Code graph removed view snapshot authority is unavailable.');
  }
  const snapshot = snapshots[0];
  if (
    snapshots.length !== 1 ||
    snapshot.id !== expectedSnapshotId ||
    typeof snapshot.id !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(snapshot.id) ||
    typeof snapshot.repository_id !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(snapshot.repository_id) ||
    typeof snapshot.worktree_id !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(snapshot.worktree_id) ||
    (evidence !== undefined && evidence.repositoryId !== snapshot.repository_id)
  ) {
    return yield* CodeGraphStoreError.of('Code graph removed view snapshot authority is invalid.');
  }
});

const allocateRemovedViewCleanupEpoch = Effect.fn('codeGraph.allocateRemovedViewCleanupEpoch')(function* (
  sql: SqlClient.SqlClient,
) {
  const sequence = yield* inspectBoundedSchemaMetadataValue(sql, REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY, 16);
  if (
    sequence.state !== 'recorded' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(sequence.value) ||
    !Number.isSafeInteger(Number(sequence.value)) ||
    Number(sequence.value) >= Number.MAX_SAFE_INTEGER
  ) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup epoch sequence is invalid.');
  }
  const epoch = Number(sequence.value) + 1;
  yield* sql`
    UPDATE schema_metadata
    SET value = ${String(epoch)}
    WHERE key = ${REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY}
      AND value = ${sequence.value}
  `;
  if ((yield* lastStatementChangeCount(sql)) !== 1) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup epoch sequence changed.');
  }
  return epoch;
});

function validRemovedViewCleanupEntry(entry: CodeGraphRemovedViewCleanupEntry): boolean {
  const decoded = decodeRemovedViewCleanupRow({
    scope_id: entry.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
    attempts: entry.attempts,
    blocked_code: entry.blockedCode ?? null,
    cursor_token: entry.cursorToken ?? null,
    epoch: entry.epoch,
    expected_snapshot_id: entry.expectedSnapshotId,
    next_attempt_at: entry.nextAttemptAt,
    phase: entry.phase,
    provenance_record_digest: entry.provenanceRecordDigest ?? null,
    provenance_record_identity: entry.provenanceRecordIdentity ?? null,
    removed_at: entry.removedAt,
    repository_id: entry.repositoryId ?? null,
    revision: entry.revision,
    updated_at: entry.updatedAt,
    worktree_id: entry.worktreeId,
  });
  return decoded !== undefined && sameRemovedViewCleanupEntry(decoded, entry);
}

const REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE = `worktree_id = ?
  AND scope_id = ?
  AND expected_snapshot_id = ?
  AND removed_at = ?
  AND epoch = ?
  AND repository_id IS ?
  AND provenance_record_digest IS ?
  AND provenance_record_identity IS ?
  AND phase = ?
  AND cursor_token IS ?
  AND revision = ?
  AND attempts = ?
  AND next_attempt_at = ?
  AND blocked_code IS ?
  AND updated_at = ?`;

function removedViewCleanupEntryCasParameters(entry: CodeGraphRemovedViewCleanupEntry): readonly unknown[] {
  return [
    entry.worktreeId,
    entry.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
    entry.expectedSnapshotId,
    entry.removedAt,
    entry.epoch,
    entry.repositoryId ?? null,
    entry.provenanceRecordDigest ?? null,
    entry.provenanceRecordIdentity ?? null,
    entry.phase,
    entry.cursorToken ?? null,
    entry.revision,
    entry.attempts,
    entry.nextAttemptAt,
    entry.blockedCode ?? null,
    entry.updatedAt,
  ];
}

const revokeRemovedViewCleanupEntry = Effect.fn('codeGraph.revokeRemovedViewCleanupEntry')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
) {
  yield* sql.unsafe(
    `DELETE FROM removed_view_cleanup WHERE ${REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE}`,
    removedViewCleanupEntryCasParameters(entry),
  );
  if ((yield* lastStatementChangeCount(sql)) !== 1) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup revocation changed.');
  }
});

const observeRemovedViewCleanupAuthority = Effect.fn('codeGraph.observeRemovedViewCleanupAuthority')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
) {
  const removed = yield* sql.unsafe<{
    readonly expected_snapshot_id: unknown;
    readonly removed_at: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(expected_snapshot_id) = 'text'
                  AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
         THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id,
       CASE WHEN typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
         THEN removed_at ELSE NULL END AS removed_at
     FROM removed_views WHERE worktree_id = ? AND scope_id = ? LIMIT 2`,
    [entry.worktreeId, entry.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY],
  );
  if (removed.length === 0) return {state: 'stale'} as const;
  if (
    removed.length !== 1 ||
    typeof removed[0]?.expected_snapshot_id !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(removed[0].expected_snapshot_id) ||
    typeof removed[0]?.removed_at !== 'string' ||
    !validCanonicalTimestamp(removed[0].removed_at)
  ) {
    return yield* CodeGraphStoreError.of('Code graph removed view authority is invalid.');
  }
  if (removed[0].expected_snapshot_id !== entry.expectedSnapshotId || removed[0].removed_at !== entry.removedAt) {
    return {state: 'stale'} as const;
  }
  const evidence =
    entry.repositoryId !== undefined &&
    entry.provenanceRecordDigest !== undefined &&
    entry.provenanceRecordIdentity !== undefined
      ? {
          recordDigest: entry.provenanceRecordDigest,
          recordIdentity: entry.provenanceRecordIdentity,
          repositoryId: entry.repositoryId,
        }
      : undefined;
  yield* validateRemovedViewSnapshotAuthority(sql, entry.expectedSnapshotId, false, evidence);
  const active = yield* sql.unsafe<{readonly snapshot_id: unknown}>(
    `SELECT CASE
       WHEN typeof(snapshot_id) = 'text' AND length(CAST(snapshot_id AS BLOB)) BETWEEN 45 AND 67
       THEN snapshot_id ELSE NULL END AS snapshot_id
     FROM active_snapshots WHERE worktree_id = ? AND scope_id = ? LIMIT 2`,
    [entry.worktreeId, entry.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY],
  );
  const activeSnapshotId = active[0]?.snapshot_id;
  if (
    active.length > 1 ||
    (activeSnapshotId !== undefined &&
      (typeof activeSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(activeSnapshotId)))
  ) {
    return yield* CodeGraphStoreError.of('Code graph active view authority is invalid.');
  }
  return activeSnapshotId === undefined || activeSnapshotId === entry.expectedSnapshotId
    ? ({matchingActivePointer: activeSnapshotId === entry.expectedSnapshotId, state: 'authorized'} as const)
    : ({observedSnapshotId: activeSnapshotId, state: 'active-pointer-changed'} as const);
});

const removeMatchingLegacyCleanupPointer = Effect.fn('codeGraph.removeMatchingLegacyCleanupPointer')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
  matchingActivePointer: boolean,
) {
  if (matchingActivePointer) {
    yield* sql`
      DELETE FROM active_snapshots
      WHERE worktree_id = ${entry.worktreeId} AND snapshot_id = ${entry.expectedSnapshotId}
        AND scope_id = ${entry.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY}
    `;
    if ((yield* lastStatementChangeCount(sql)) !== 1) {
      return yield* CodeGraphStoreError.of('Code graph active view pointer changed.');
    }
  }
});

export {
  CODE_GRAPH_SNAPSHOT_ID,
  CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES,
  CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX,
  validCanonicalTimestamp,
  RemovedViewCleanupRow,
  sameRemovedViewCleanupEntry,
  validateRemovedViewSnapshotAuthority,
  REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE,
  removedViewCleanupEntryCasParameters,
  authorityPrimaryKeyBinary,
  REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION,
  CLEANUP_TOKEN,
  validRemovedViewCleanupBlockedCode,
  decodeRemovedViewCleanupRow,
  selectRemovedViewCleanupEntry,
  validRemovedViewCleanupEntry,
  revokeRemovedViewCleanupEntry,
  observeRemovedViewCleanupAuthority,
  removeMatchingLegacyCleanupPointer,
  validateViewRemovalTarget,
  observeActiveView,
  CodeGraphReconciliationSchemaColumn,
  CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS,
  CodeGraphReconciliationTable,
  boundedAuthorityTableDefinition,
  exactCodeGraphSnapshotStateCheck,
  CodeGraphReconciliationRequiredIndex,
  codeGraphReconciliationIndexState,
  ensureInitialReconciliationIndexes,
  validRemovedViewCleanupEvidence,
  allocateRemovedViewCleanupEpoch,
};
