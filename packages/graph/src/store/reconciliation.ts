import {Clock, DateTime, Effect, Predicate} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import * as SqlError from 'effect/sql/SqlError';
import {
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS,
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES,
  type CodeGraphOrphanProvenanceCandidatePage,
  type CodeGraphOrphanProvenanceViewObservation,
  type CodeGraphRemovedViewCleanupEntry,
  type CodeGraphRemovedViewCleanupEvidence,
  type CodeGraphRemovedViewCleanupUpdate,
  type CodeGraphWorktreeReconciliationCandidate,
} from './models.js';
import {
  MAXIMUM_CANONICAL_DATE_MILLISECONDS,
  REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY,
  REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
} from './removed/view_schema_contracts.js';
import {
  removedViewAuthorityTableState,
  removedViewCleanupRecordedRevision,
  removedViewCleanupSchemaState,
} from './removed/view_schema_inspection.js';
import {normalizeSchemaDefinition} from './schema/normalization.js';
import {
  REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
  type SchemaMetadataMaximumRows,
  inspectBoundedSchemaMetadataRowCount,
  inspectBoundedSchemaMetadataValue,
} from './schema/metadata.js';
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeGraphStoreCorruptionError,
  CodeGraphStoreError,
  CodeGraphStoreIncompatibleSchemaError,
} from '../types.js';
import {codeGraphPersistentSchemaIsCurrent} from './schema/revision.js';
import {
  allocateRemovedViewCleanupEpoch,
  authorityPrimaryKeyBinary,
  boundedAuthorityTableDefinition,
  CLEANUP_TOKEN,
  CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES,
  CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS,
  CODE_GRAPH_SNAPSHOT_ID,
  CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX,
  codeGraphReconciliationIndexState,
  type CodeGraphReconciliationTable,
  codeGraphWorktreeReconciliationCandidatePageStatement,
  decodeRemovedViewCleanupRow,
  exactCodeGraphSnapshotStateCheck,
  observeRemovedViewCleanupAuthority,
  REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION,
  REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE,
  removedViewCleanupEntryCasParameters,
  type RemovedViewCleanupRow,
  removeMatchingLegacyCleanupPointer,
  revokeRemovedViewCleanupEntry,
  sameRemovedViewCleanupEntry,
  selectRemovedViewCleanupEntry,
  validateRemovedViewSnapshotAuthority,
  validCanonicalTimestamp,
  validRemovedViewCleanupBlockedCode,
  validRemovedViewCleanupEntry,
} from './reconciliation/core.js';
import {
  CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL,
  CODE_GRAPH_SCOPED_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL,
  codeGraphRemovedViewCleanupBaseSchemaAdmission,
  inspectRemovedViewCleanupAdmissionCursor,
} from './schema/core.js';
import {
  boundedSnapshotLeaseProjection,
  type BoundedSnapshotLeaseRow,
  decodeSnapshotLeaseManifest,
} from './maintenance_core.js';
import {lastStatementChangeCount} from './activation/core.js';
import {type CodeGraphSqlQueryStatement} from './visualization_sql.js';
import {codeGraphScopeAuthorityInstalled, codeGraphScopeAuthoritySchemaCompatible} from './scope/schema.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';
import {
  SCOPED_REMOVED_VIEW_CLEANUP_COLUMNS,
  SCOPED_REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
} from './scope/schema_contracts.js';
import {
  CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES,
  CODE_GRAPH_SCOPE_CURSOR_PATTERN,
  codeGraphScopeCursor,
  codeGraphScopeCursorParameters,
} from './scope/cursor.js';

const WORKTREE_RECONCILIATION_CURSOR_KEY = 'worktree_reconciliation_cursor';
const WORKTREE_RECONCILIATION_CURSOR_PATTERN = CODE_GRAPH_SCOPE_CURSOR_PATTERN;
const WORKTREE_RECONCILIATION_CURSOR_OPERATION = 'claim code graph reconciliation candidates';
const WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS = 67 satisfies SchemaMetadataMaximumRows;
const ORPHAN_PROVENANCE_CURSOR_KEY = 'orphan_provenance_cursor';
const ORPHAN_PROVENANCE_WORKTREE_ID_LIMIT = 4_096;

type WorktreeReconciliationCursorState =
  {readonly recorded: true; readonly value: string} | {readonly recorded: false; readonly value: undefined};

interface ReconciliationTrigger {
  readonly bounded_sql: string;
  readonly name: string;
  readonly sql_bytes: number;
  readonly tbl_name: string;
}

function isCodeGraphReconciliationTable(value: string): value is CodeGraphReconciliationTable {
  return Object.hasOwn(CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS, value);
}

function isReconciliationTrigger(value: unknown): value is ReconciliationTrigger {
  if (!Predicate.isObject(value)) return false;
  return (
    typeof value.name === 'string' &&
    value.name === value.name.toLowerCase() &&
    typeof value.tbl_name === 'string' &&
    value.tbl_name === value.tbl_name.toLowerCase() &&
    typeof value.sql_bytes === 'number' &&
    Number.isSafeInteger(value.sql_bytes) &&
    value.sql_bytes <= 8192 &&
    typeof value.bounded_sql === 'string'
  );
}

const admitOrRecoverWorktreeReconciliationSchema = Effect.fn('codeGraph.admitOrRecoverWorktreeReconciliationSchema')(
  function* (sql: SqlClient.SqlClient) {
    if (yield* codeGraphWorktreeReconciliationSchemaCompatible(sql)) return true;

    const revision = yield* removedViewCleanupRecordedRevision(
      sql,
      WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS,
    );
    if (revision.state !== 'recorded' || !codeGraphPersistentSchemaIsCurrent(revision.value)) {
      return false;
    }
    const metadataRowCount = yield* inspectBoundedSchemaMetadataRowCount(
      sql,
      WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS,
    );
    const cleanupCursor = yield* inspectRemovedViewCleanupAdmissionCursor(
      sql,
      WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS,
    );
    if (!cleanupCursor.current) return false;
    const admittedRows =
      REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - (cleanupCursor.cursor === undefined ? 1 : 0);
    if (metadataRowCount !== admittedRows + 1) return false;

    const cursor = yield* inspectBoundedSchemaMetadataValue(
      sql,
      WORKTREE_RECONCILIATION_CURSOR_KEY,
      CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES,
      WORKTREE_RECONCILIATION_LEGACY_MAXIMUM_METADATA_ROWS,
    );
    if (cursor.state === 'invalid') {
      return yield* worktreeReconciliationCursorStructuralError();
    }
    if (cursor.state === 'missing') return false;
    yield* clearWorktreeReconciliationCursor(sql, cursor.value);
    return yield* codeGraphWorktreeReconciliationSchemaCompatible(sql);
  },
);

const inspectWorktreeReconciliationCursor = Effect.fn('codeGraph.inspectWorktreeReconciliationCursor')(function* (
  sql: SqlClient.SqlClient,
) {
  const inspection = yield* inspectBoundedSchemaMetadataValue(
    sql,
    WORKTREE_RECONCILIATION_CURSOR_KEY,
    CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES,
  );
  if (inspection.state === 'invalid') {
    return yield* worktreeReconciliationCursorStructuralError();
  }
  if (inspection.state === 'missing') {
    return {recorded: false, value: undefined} satisfies WorktreeReconciliationCursorState;
  }
  if (WORKTREE_RECONCILIATION_CURSOR_PATTERN.test(inspection.value)) {
    return {recorded: true, value: inspection.value} satisfies WorktreeReconciliationCursorState;
  }
  yield* clearWorktreeReconciliationCursor(sql, inspection.value);
  return {recorded: false, value: undefined} satisfies WorktreeReconciliationCursorState;
});

const clearWorktreeReconciliationCursor = Effect.fn('codeGraph.clearWorktreeReconciliationCursor')(function* (
  sql: SqlClient.SqlClient,
  recordedCursor: string,
) {
  yield* sql.unsafe(
    `DELETE FROM schema_metadata
     WHERE key = ? COLLATE BINARY
       AND value = ? COLLATE BINARY`,
    [WORKTREE_RECONCILIATION_CURSOR_KEY, recordedCursor],
  );
  if ((yield* lastStatementChangeCount(sql)) !== 1) {
    return yield* worktreeReconciliationCursorChangedError();
  }
  const clearedCursor = yield* inspectBoundedSchemaMetadataValue(
    sql,
    WORKTREE_RECONCILIATION_CURSOR_KEY,
    CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES,
  );
  if (clearedCursor.state !== 'missing') {
    return yield* worktreeReconciliationCursorChangedError();
  }
});

const recordWorktreeReconciliationCursor = Effect.fn('codeGraph.recordWorktreeReconciliationCursor')(function* (
  sql: SqlClient.SqlClient,
  current: WorktreeReconciliationCursorState,
  nextCursor: string,
) {
  if (current.recorded) {
    yield* sql.unsafe(
      `UPDATE schema_metadata
       SET value = ?
       WHERE key = ? COLLATE BINARY
         AND value = ? COLLATE BINARY`,
      [nextCursor, WORKTREE_RECONCILIATION_CURSOR_KEY, current.value],
    );
  } else {
    const metadataRowCount = yield* inspectBoundedSchemaMetadataRowCount(sql);
    const cleanupCursor = yield* inspectRemovedViewCleanupAdmissionCursor(sql);
    if (metadataRowCount === undefined || !cleanupCursor.current) {
      return yield* worktreeReconciliationCursorCapacityError();
    }
    const maximumRows =
      REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - (cleanupCursor.cursor === undefined ? 1 : 0);
    if (metadataRowCount >= maximumRows) return;
    yield* sql.unsafe(
      `INSERT INTO schema_metadata (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING`,
      [WORKTREE_RECONCILIATION_CURSOR_KEY, nextCursor],
    );
  }
  if ((yield* lastStatementChangeCount(sql)) !== 1) {
    return yield* worktreeReconciliationCursorChangedError();
  }
  const advancedCursor = yield* inspectBoundedSchemaMetadataValue(
    sql,
    WORKTREE_RECONCILIATION_CURSOR_KEY,
    CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES,
  );
  if (advancedCursor.state !== 'recorded' || advancedCursor.value !== nextCursor) {
    return yield* worktreeReconciliationCursorChangedError();
  }
});

const claimWorktreeReconciliationCandidates = Effect.fn('codeGraph.claimWorktreeReconciliationCandidates')(function* (
  sql: SqlClient.SqlClient,
  requestedLimit: number,
) {
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(32, requestedLimit)) : 32;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* admitOrRecoverWorktreeReconciliationSchema(sql))) {
        return yield* CodeGraphStoreError.of('Code graph reconciliation schema is unavailable.');
      }
      const cursorState = yield* inspectWorktreeReconciliationCursor(sql);
      const cursor = cursorState.value;
      const selectPage = (boundary: 'after' | 'through', pageLimit: number) => {
        const statement = codeGraphWorktreeReconciliationCandidatePageStatement(cursor, boundary, pageLimit);
        return sql.unsafe<{
          readonly repository_id: string | null;
          readonly snapshot_id: string;
          readonly snapshot_state: string;
          readonly tombstoned: number;
          readonly worktree_id: string;
          readonly scope_id: string;
        }>(statement.text, statement.parameters);
      };
      const after = yield* selectPage('after', limit);
      const rows =
        cursor === undefined || after.length >= limit
          ? after
          : [...after, ...(yield* selectPage('through', limit - after.length))];
      const lastRow = rows.at(-1);
      const nextCursor =
        lastRow === undefined ? undefined : codeGraphScopeCursor(lastRow.worktree_id, lastRow.scope_id);
      if (
        rows.some(
          row =>
            typeof row.repository_id !== 'string' ||
            !/^[0-9a-f]{64}$/.test(row.repository_id) ||
            !/^[0-9a-f]{64}$/.test(row.worktree_id) ||
            !/^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/.test(row.snapshot_id) ||
            !['building', 'failed', 'ready', 'retired'].includes(row.snapshot_state) ||
            (Number(row.tombstoned) !== 0 && Number(row.tombstoned) !== 1),
        )
      ) {
        return yield* CodeGraphStoreError.of('Code graph reconciliation candidate is invalid.');
      }
      if (nextCursor !== undefined) {
        yield* recordWorktreeReconciliationCursor(sql, cursorState, nextCursor);
      }
      return rows
        .filter(row => row.snapshot_state === 'ready' && Number(row.tombstoned) === 0)
        .map(row => ({
          repositoryId: row.repository_id!,
          snapshotId: row.snapshot_id,
          worktreeId: row.worktree_id,
          ...(row.scope_id === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY ? {} : {scopeId: row.scope_id}),
        })) satisfies readonly CodeGraphWorktreeReconciliationCandidate[];
    }),
  );
});

function worktreeReconciliationCursorStructuralError(): CodeGraphStoreCorruptionError {
  return CodeGraphStoreCorruptionError.of('Code graph reconciliation cursor metadata is structurally invalid.', {
    operation: WORKTREE_RECONCILIATION_CURSOR_OPERATION,
  });
}

function worktreeReconciliationCursorChangedError(): CodeGraphStoreCorruptionError {
  return CodeGraphStoreCorruptionError.of(
    'Code graph reconciliation cursor metadata changed before it could advance.',
    {
      operation: WORKTREE_RECONCILIATION_CURSOR_OPERATION,
    },
  );
}

function worktreeReconciliationCursorCapacityError(): CodeGraphStoreIncompatibleSchemaError {
  return CodeGraphStoreIncompatibleSchemaError.of(
    'Code graph reconciliation cursor metadata capacity is unavailable.',
    {
      operation: WORKTREE_RECONCILIATION_CURSOR_OPERATION,
    },
  );
}

const claimOrphanProvenanceCandidates = Effect.fn('codeGraph.claimOrphanProvenanceCandidates')(function* (
  sql: SqlClient.SqlClient,
  requestedWorktreeIds: readonly string[],
  requestedLimit: number,
) {
  if (
    requestedWorktreeIds.length > ORPHAN_PROVENANCE_WORKTREE_ID_LIMIT ||
    requestedWorktreeIds.some(worktreeId => !/^[0-9a-f]{64}$/.test(worktreeId))
  ) {
    return yield* CodeGraphStoreError.of('Code graph provenance candidate inventory is invalid.');
  }
  const worktreeIds = [...new Set(requestedWorktreeIds)].sort();
  if (worktreeIds.length !== requestedWorktreeIds.length) {
    return yield* CodeGraphStoreError.of('Code graph provenance candidate inventory is invalid.');
  }
  if (worktreeIds.length === 0) {
    return {worktreeIds: []} as const satisfies CodeGraphOrphanProvenanceCandidatePage;
  }
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(32, requestedLimit)) : 32;
  const encodedWorktreeIds = JSON.stringify(worktreeIds);
  const worktreeIdSet = new Set(worktreeIds);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* CodeGraphStoreError.of('Code graph reconciliation schema is unavailable.');
      }
      const cursorInspection = yield* inspectBoundedSchemaMetadataValue(sql, ORPHAN_PROVENANCE_CURSOR_KEY, 64);
      if (cursorInspection.state === 'invalid') {
        return yield* CodeGraphStoreError.of('Code graph provenance reconciliation cursor metadata is invalid.');
      }
      const cursor =
        cursorInspection.state === 'recorded' && /^[0-9a-f]{64}$/u.test(cursorInspection.value)
          ? cursorInspection.value
          : undefined;
      const cursorRecovery =
        cursorInspection.state === 'recorded' && cursor === undefined ? ('invalid-format' as const) : undefined;
      const selectPage = (boundary: 'after' | 'through', pageLimit: number) => {
        const predicate =
          cursor === undefined ? '' : boundary === 'after' ? 'AND candidate.value > ?' : 'AND candidate.value <= ?';
        const parameters =
          cursor === undefined ? [encodedWorktreeIds, pageLimit] : [encodedWorktreeIds, cursor, pageLimit];
        return sql.unsafe<{readonly worktree_id: unknown}>(
          `SELECT candidate.value AS worktree_id
           FROM json_each(?) AS candidate
           LEFT JOIN active_snapshots AS active ON active.worktree_id = candidate.value
           WHERE candidate.type = 'text'
             AND active.worktree_id IS NULL
             ${predicate}
           ORDER BY candidate.value
           LIMIT ?`,
          parameters,
        );
      };
      const after = yield* selectPage('after', limit);
      const rows =
        cursor === undefined || after.length >= limit
          ? after
          : [...after, ...(yield* selectPage('through', limit - after.length))];
      const selected: string[] = [];
      for (const row of rows) {
        if (
          typeof row.worktree_id !== 'string' ||
          !/^[0-9a-f]{64}$/.test(row.worktree_id) ||
          !worktreeIdSet.has(row.worktree_id)
        ) {
          return yield* CodeGraphStoreError.of('Code graph provenance reconciliation candidate is invalid.');
        }
        selected.push(row.worktree_id);
      }
      const nextCursor = selected.at(-1);
      if (nextCursor !== undefined) {
        if (cursorInspection.state === 'missing') {
          const metadataRowCount = yield* inspectBoundedSchemaMetadataRowCount(sql);
          const removedViewAdmissionCursor = yield* inspectRemovedViewCleanupAdmissionCursor(sql);
          const metadataRowLimit =
            removedViewAdmissionCursor.cursor === undefined
              ? REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - 1
              : REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS;
          if (
            metadataRowCount === undefined ||
            !removedViewAdmissionCursor.current ||
            metadataRowCount >= metadataRowLimit
          ) {
            return yield* CodeGraphStoreError.of(
              'Code graph provenance reconciliation cursor metadata has no capacity.',
            );
          }
          yield* sql.unsafe(`INSERT INTO schema_metadata (key, value) VALUES (?, ?)`, [
            ORPHAN_PROVENANCE_CURSOR_KEY,
            nextCursor,
          ]);
        } else {
          yield* sql.unsafe(`UPDATE schema_metadata SET value = ? WHERE key = ? AND value = ?`, [
            nextCursor,
            ORPHAN_PROVENANCE_CURSOR_KEY,
            cursorInspection.value,
          ]);
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* CodeGraphStoreError.of('Code graph provenance reconciliation cursor changed.');
          }
        }
      } else if (cursorRecovery !== undefined && cursorInspection.state === 'recorded') {
        yield* sql.unsafe(`DELETE FROM schema_metadata WHERE key = ? AND value = ?`, [
          ORPHAN_PROVENANCE_CURSOR_KEY,
          cursorInspection.value,
        ]);
        if ((yield* lastStatementChangeCount(sql)) !== 1) {
          return yield* CodeGraphStoreError.of('Code graph provenance reconciliation cursor changed.');
        }
      }
      return {
        ...(cursorRecovery === undefined ? {} : {cursorRecovery}),
        worktreeIds: selected,
      } as const satisfies CodeGraphOrphanProvenanceCandidatePage;
    }),
  );
});

const observeOrphanProvenanceView = Effect.fn('codeGraph.observeOrphanProvenanceView')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
) {
  if (!/^[0-9a-f]{64}$/.test(worktreeId)) {
    return yield* CodeGraphStoreError.of('Code graph worktree identity is invalid.');
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* CodeGraphStoreError.of('Code graph reconciliation schema is unavailable.');
      }
      const rows = yield* sql.unsafe<{readonly snapshot_id: unknown}>(
        `SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ? ORDER BY scope_id LIMIT 1`,
        [worktreeId],
      );
      const snapshotId = rows[0]?.snapshot_id;
      if (
        rows.length > 1 ||
        (snapshotId !== undefined && (typeof snapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(snapshotId)))
      ) {
        return yield* CodeGraphStoreError.of('Code graph view authority is invalid.');
      }
      return snapshotId === undefined
        ? ({state: 'absent'} as const satisfies CodeGraphOrphanProvenanceViewObservation)
        : ({
            snapshotId,
            state: 'active',
          } as const satisfies CodeGraphOrphanProvenanceViewObservation);
    }),
  );
});

/** @internal Indexed cursor-page statement retained for query-plan and high-cardinality regressions. */

const codeGraphWorktreeReconciliationSchemaCompatible: (
  sql: SqlClient.SqlClient,
  requireIndexes?: boolean,
  requireCleanup?: boolean,
  requireRemovedViewAuthority?: boolean,
  requireLeaseExpiryIndex?: boolean,
) => Effect.Effect<boolean, SqlError.SqlError> = Effect.fn('codeGraph.worktreeReconciliationSchemaCompatible')(
  function* (
    sql: SqlClient.SqlClient,
    requireIndexes = true,
    requireCleanup = true,
    requireRemovedViewAuthority = true,
    requireLeaseExpiryIndex = true,
  ) {
    const extensionRevision = yield* removedViewCleanupRecordedRevision(sql);
    if (extensionRevision.state === 'invalid') return false;
    if (requireRemovedViewAuthority && (yield* removedViewAuthorityTableState(sql)) !== 'compatible') return false;
    if (requireCleanup && (yield* removedViewCleanupSchemaState(sql)) !== 'compatible') return false;
    const scoped = yield* codeGraphScopeAuthorityInstalled(sql);
    // Narrow callers (lease release/renewal) intentionally do not observe
    // removed-view cleanup authority until they need to retire a snapshot.
    // Do not turn an unrelated cleanup defect into a failure to release an
    // ordinary reader lease; the later full-authority observation remains
    // mandatory before retirement is admitted.
    const scopedAuthorityNames = [
      ...(requireRemovedViewAuthority ? ['removed_views'] : []),
      ...(requireCleanup
        ? [
            'removed_view_cleanup',
            'removed_view_cleanup_due',
            ...SCOPED_REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.map(trigger => trigger.name),
          ]
        : []),
    ];
    if (
      scoped &&
      scopedAuthorityNames.length > 0 &&
      !(yield* codeGraphScopeAuthoritySchemaCompatible(sql, scopedAuthorityNames))
    )
      return false;
    const cleanupTriggerDefinitions = scoped
      ? SCOPED_REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS
      : REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS;
    for (const tableName of Object.keys(CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS)) {
      if (!isCodeGraphReconciliationTable(tableName)) return false;
      const table = tableName;
      if (table === 'removed_view_cleanup' && !requireCleanup) continue;
      if (table === 'removed_views' && !requireRemovedViewAuthority) continue;
      const scopedColumn = {
        name: 'scope_id',
        notNull: true,
        primaryKeyPosition: table === 'snapshots' ? 0 : 2,
        type: 'TEXT',
        defaultValue: `'${CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY}'`,
      };
      const expectedColumns = !scoped
        ? CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS[table]
        : table === 'removed_view_cleanup'
          ? SCOPED_REMOVED_VIEW_CLEANUP_COLUMNS
          : table === 'active_snapshots' || table === 'removed_views' || table === 'snapshots'
            ? [...CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS[table], scopedColumn]
            : CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS[table];
      const columns = yield* sql.unsafe<{
        readonly dflt_value: unknown;
        readonly hidden: number;
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
        readonly type: string;
      }>(
        `SELECT * FROM pragma_table_xinfo('${table}')
         LIMIT ${expectedColumns.length + 1}`,
      );
      const observed = columns
        .map(column => ({
          hidden: Number(column.hidden),
          defaultValue: column.dflt_value,
          name: column.name,
          notNull: Number(column.notnull) === 1,
          primaryKeyPosition: Number(column.pk),
          type: column.type.toUpperCase(),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const expected = [...expectedColumns].sort((left, right) => left.name.localeCompare(right.name));
      if (
        observed.length !== expected.length ||
        observed.some((column, index) => {
          const contract = expected[index];
          return (
            contract === undefined ||
            column.hidden !== 0 ||
            column.defaultValue !== ('defaultValue' in contract ? contract.defaultValue : null) ||
            column.name !== contract.name ||
            column.type !== contract.type ||
            column.notNull !== contract.notNull ||
            column.primaryKeyPosition !== contract.primaryKeyPosition
          );
        })
      ) {
        return false;
      }
    }
    if (
      (!scoped && !(yield* authorityPrimaryKeyBinary(sql, 'active_snapshots', 'worktree_id'))) ||
      !(yield* authorityPrimaryKeyBinary(sql, 'snapshot_leases', 'token')) ||
      !(yield* authorityPrimaryKeyBinary(sql, 'snapshots', 'id')) ||
      (requireLeaseExpiryIndex &&
        (yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX)) !== 'ready')
    ) {
      return false;
    }
    const schemaVersion = yield* inspectBoundedSchemaMetadataValue(sql, 'schema_version', 16);
    if (schemaVersion.state !== 'recorded' || schemaVersion.value !== String(CODE_GRAPH_SCHEMA_VERSION)) {
      if (!(extensionRevision.state === 'missing' && schemaVersion.state === 'missing')) return false;
    }
    const activeForeignKeys = yield* sql.unsafe<{
      readonly from: string;
      readonly match: string;
      readonly on_delete: string;
      readonly on_update: string;
      readonly table: string;
      readonly to: string;
    }>(`SELECT * FROM pragma_foreign_key_list('active_snapshots') LIMIT 2`);
    if (
      activeForeignKeys.length !== 1 ||
      activeForeignKeys[0]?.from !== 'snapshot_id' ||
      activeForeignKeys[0]?.to !== 'id' ||
      activeForeignKeys[0]?.table !== 'snapshots' ||
      activeForeignKeys[0]?.on_delete.toUpperCase() !== 'CASCADE' ||
      activeForeignKeys[0]?.on_update.toUpperCase() !== 'NO ACTION' ||
      activeForeignKeys[0]?.match.toUpperCase() !== 'NONE'
    ) {
      return false;
    }
    const removedForeignKeys = yield* sql.unsafe(`SELECT 1 FROM pragma_foreign_key_list('removed_views') LIMIT 1`);
    if (removedForeignKeys.length !== 0) return false;
    if (requireCleanup && !(yield* codeGraphRemovedViewCleanupBaseSchemaAdmission(sql)).current) {
      return false;
    }
    const snapshotForeignKeys = yield* sql.unsafe<{
      readonly from: string;
      readonly match: string;
      readonly on_delete: string;
      readonly on_update: string;
      readonly table: string;
      readonly to: string;
    }>(`SELECT * FROM pragma_foreign_key_list('snapshots') LIMIT 2`);
    if (
      snapshotForeignKeys.length !== 1 ||
      snapshotForeignKeys[0]?.from !== 'repository_id' ||
      snapshotForeignKeys[0]?.to !== 'id' ||
      snapshotForeignKeys[0]?.table !== 'repositories' ||
      snapshotForeignKeys[0]?.on_delete.toUpperCase() !== 'CASCADE' ||
      snapshotForeignKeys[0]?.on_update.toUpperCase() !== 'NO ACTION' ||
      snapshotForeignKeys[0]?.match.toUpperCase() !== 'NONE'
    ) {
      return false;
    }
    const leaseForeignKeys = yield* sql.unsafe<{
      readonly from: string;
      readonly match: string;
      readonly on_delete: string;
      readonly on_update: string;
      readonly table: string;
      readonly to: string;
    }>(`SELECT * FROM pragma_foreign_key_list('snapshot_leases') LIMIT 2`);
    if (
      leaseForeignKeys.length !== 1 ||
      leaseForeignKeys[0]?.from !== 'snapshot_id' ||
      leaseForeignKeys[0]?.to !== 'id' ||
      leaseForeignKeys[0]?.table !== 'snapshots' ||
      leaseForeignKeys[0]?.on_delete.toUpperCase() !== 'CASCADE' ||
      leaseForeignKeys[0]?.on_update.toUpperCase() !== 'NO ACTION' ||
      leaseForeignKeys[0]?.match.toUpperCase() !== 'NONE'
    ) {
      return false;
    }
    const leaseDefinition = yield* boundedAuthorityTableDefinition(sql, 'snapshot_leases');
    const snapshotDefinition = yield* boundedAuthorityTableDefinition(sql, 'snapshots');
    if (!(
      (!requireRemovedViewAuthority || (yield* removedViewAuthorityTableState(sql)) === 'compatible') &&
      leaseDefinition !== undefined &&
      /\bretire_when_inactive\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0\s+CHECK\s*\(\s*retire_when_inactive\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/iu.test(
        leaseDefinition,
      ) &&
      snapshotDefinition !== undefined &&
      exactCodeGraphSnapshotStateCheck(snapshotDefinition)
    )) {
      return false;
    }
    if (requireIndexes) {
      for (const index of CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES) {
        if ((yield* codeGraphReconciliationIndexState(sql, index)) !== 'ready') return false;
      }
    }
    const triggerTables = [
      'schema_metadata',
      'active_snapshots',
      ...(requireCleanup ? ['removed_views'] : []),
      'snapshots',
      'snapshot_leases',
    ];
    const triggers = yield* sql.unsafe<{
      readonly bounded_sql: unknown;
      readonly name: unknown;
      readonly sql_bytes: unknown;
      readonly tbl_name: unknown;
    }>(`SELECT name, tbl_name,
               CASE
                 WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql
                 ELSE NULL
               END AS bounded_sql,
               length(CAST(sql AS BLOB)) AS sql_bytes
        FROM sqlite_master
        WHERE type = 'trigger'
          AND tbl_name IN (${triggerTables.map(table => `'${table}' COLLATE NOCASE`).join(', ')})
        ORDER BY name
        LIMIT 5`);
    const verifiedTriggers: ReconciliationTrigger[] = [];
    for (const trigger of triggers) {
      if (!isReconciliationTrigger(trigger)) return false;
      verifiedTriggers.push(trigger);
    }
    const activeTrigger = verifiedTriggers.filter(
      trigger => trigger.name === 'active_snapshots_require_current_extractor',
    );
    const cleanupTriggers = requireCleanup
      ? verifiedTriggers.filter(trigger => cleanupTriggerDefinitions.some(expected => expected.name === trigger.name))
      : [];
    const expectedTriggerCount = 1 + cleanupTriggers.length;
    if (
      verifiedTriggers.length !== expectedTriggerCount ||
      activeTrigger.length !== 1 ||
      activeTrigger[0]?.tbl_name !== 'active_snapshots' ||
      normalizeSchemaDefinition(activeTrigger[0]?.bounded_sql ?? '') !==
        normalizeSchemaDefinition(
          scoped
            ? CODE_GRAPH_SCOPED_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL
            : CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL,
        ) ||
      (requireCleanup && cleanupTriggers.length !== cleanupTriggerDefinitions.length) ||
      cleanupTriggers.some(trigger => {
        const expected = cleanupTriggerDefinitions.find(candidate => candidate.name === trigger.name);
        return (
          expected === undefined ||
          trigger.tbl_name !== 'removed_views' ||
          normalizeSchemaDefinition(trigger.bounded_sql) !== normalizeSchemaDefinition(expected.sql)
        );
      })
    ) {
      return false;
    }
    return true;
  },
);

const markSnapshotLeaseRetirementBaton = Effect.fn('codeGraph.markSnapshotLeaseRetirementBaton')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  now: number,
  onlyIfDirty = false,
) {
  // Ordinary pointer displacement retires only disposable dirty overlays.
  // Explicit view removal leaves onlyIfDirty false so its exact clean or dirty
  // target still retires after the final reader releases it.
  const rows = yield* sql.unsafe<BoundedSnapshotLeaseRow & {readonly lease_rowid: unknown}>(
    `SELECT
       CASE WHEN typeof(lease.rowid) = 'integer' AND lease.rowid BETWEEN 1 AND 9007199254740991
         THEN lease.rowid ELSE NULL END AS lease_rowid,
       ${boundedSnapshotLeaseProjection('lease')}
     FROM snapshot_leases AS lease INDEXED BY snapshot_leases_snapshot_expiry
     JOIN snapshots AS snapshot
       ON snapshot.id = lease.snapshot_id
     WHERE lease.snapshot_id = ? AND lease.expires_at > ?
       AND (${onlyIfDirty ? 1 : 0} = 0 OR snapshot.dirty = 1)
     ORDER BY lease.expires_at
     LIMIT 1`,
    [snapshotId, now],
  );
  if (rows.length === 0) return 0;
  const lease = decodeSnapshotLeaseManifest(rows[0]);
  const rowid = rows[0]?.lease_rowid;
  if (
    lease === undefined ||
    lease.snapshotId !== snapshotId ||
    typeof rowid !== 'number' ||
    !Number.isSafeInteger(rowid) ||
    rowid <= 0
  ) {
    return yield* CodeGraphStoreError.of('Code graph snapshot lease baton is invalid.');
  }
  yield* sql`
    UPDATE snapshot_leases
    SET retire_when_inactive = 1
    WHERE rowid = ${rowid}
  `;
  return yield* lastStatementChangeCount(sql);
});

const ensureRemovedViewCleanupEpoch = Effect.fn('codeGraph.ensureRemovedViewCleanupEpoch')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  expectedSnapshotId: string,
  updatedAt: string,
  bindNewEpochEvidence: boolean,
  evidence?: CodeGraphRemovedViewCleanupEvidence,
  requireExistingEvidenceMatch = false,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const existing = yield* selectRemovedViewCleanupEntry(sql, worktreeId, expectedSnapshotId, scopeId);
  if (existing !== undefined) {
    if (existing.removedAt !== updatedAt) {
      yield* sql`
        DELETE FROM removed_view_cleanup
        WHERE worktree_id = ${worktreeId}
          AND scope_id = ${scopeId}
          AND expected_snapshot_id = ${expectedSnapshotId}
          AND removed_at = ${existing.removedAt}
          AND epoch = ${existing.epoch}
          AND revision = ${existing.revision}
      `;
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* CodeGraphStoreError.of('Code graph removed view cleanup epoch changed.');
      }
    } else {
      if (
        (bindNewEpochEvidence || requireExistingEvidenceMatch) &&
        existing.repositoryId !== undefined &&
        evidence !== undefined &&
        (existing.repositoryId !== evidence.repositoryId ||
          existing.provenanceRecordDigest !== evidence.recordDigest ||
          existing.provenanceRecordIdentity !== evidence.recordIdentity)
      ) {
        return yield* CodeGraphStoreError.of('Code graph removed view cleanup evidence changed.');
      }
      // Epoch evidence is immutable. A later retry cannot attach current
      // sidecar evidence to a legacy tombstone that predates that evidence.
      if (!bindNewEpochEvidence) {
        yield* markSnapshotLeaseRetirementBaton(sql, expectedSnapshotId, yield* Clock.currentTimeMillis);
      }
      return;
    }
  }

  const boundEvidence = bindNewEpochEvidence ? evidence : undefined;
  const epoch = yield* allocateRemovedViewCleanupEpoch(sql);
  yield* sql`
    INSERT INTO removed_view_cleanup (
      worktree_id, scope_id, expected_snapshot_id, removed_at, epoch, repository_id,
      provenance_record_digest, provenance_record_identity,
      phase, cursor_token, revision, attempts, next_attempt_at,
      blocked_code, updated_at
    ) VALUES (
      ${worktreeId}, ${scopeId}, ${expectedSnapshotId}, ${updatedAt}, ${epoch}, ${boundEvidence?.repositoryId ?? null},
      ${boundEvidence?.recordDigest ?? null}, ${boundEvidence?.recordIdentity ?? null},
      'vector-pointers', NULL, 0, 0, 0, NULL, ${updatedAt}
    )
  `;
  if (!bindNewEpochEvidence) {
    yield* markSnapshotLeaseRetirementBaton(sql, expectedSnapshotId, yield* Clock.currentTimeMillis);
  }
});

function validRemovedViewCleanupUpdate(
  entry: CodeGraphRemovedViewCleanupEntry,
  update: CodeGraphRemovedViewCleanupUpdate,
): boolean {
  const currentPhase = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(entry.phase);
  const nextPhase = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(update.phase);
  const samePhase = nextPhase === currentPhase;
  const advancesPhase = nextPhase === currentPhase + 1;
  const progress =
    samePhase &&
    update.blockedCode === undefined &&
    update.cursorToken !== undefined &&
    update.cursorToken !== entry.cursorToken;
  const deferred = samePhase && update.blockedCode !== undefined;
  return (
    currentPhase >= 0 &&
    currentPhase < CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.length - 1 &&
    (samePhase || advancesPhase) &&
    entry.revision < Number.MAX_SAFE_INTEGER &&
    Number.isSafeInteger(update.attempts) &&
    Number.isSafeInteger(update.nextAttemptAt) &&
    update.nextAttemptAt >= 0 &&
    update.nextAttemptAt <= MAXIMUM_CANONICAL_DATE_MILLISECONDS &&
    (update.cursorToken === undefined || CLEANUP_TOKEN.test(update.cursorToken)) &&
    (update.blockedCode === undefined || validRemovedViewCleanupBlockedCode(update.blockedCode)) &&
    validCanonicalTimestamp(update.updatedAt) &&
    Date.parse(update.updatedAt) >= Date.parse(entry.updatedAt) &&
    ((progress && update.attempts === entry.attempts) ||
      (deferred &&
        entry.attempts < Number.MAX_SAFE_INTEGER &&
        update.attempts === entry.attempts + 1 &&
        update.cursorToken === entry.cursorToken &&
        update.nextAttemptAt > entry.nextAttemptAt) ||
      (advancesPhase &&
        update.attempts === 0 &&
        update.cursorToken === undefined &&
        update.blockedCode === undefined)) &&
    (update.phase !== 'complete' || (update.cursorToken === undefined && update.blockedCode === undefined))
  );
}

/** @internal Bounded keyset page retained for admission query-plan and load regressions. */
export function codeGraphRemovedViewCleanupAdmissionPageStatement(
  cursor: string | undefined,
  boundary: 'after' | 'through',
  requestedLimit = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
): CodeGraphSqlQueryStatement {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS, requestedLimit))
    : CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS;
  const predicate =
    cursor === undefined
      ? ''
      : boundary === 'after'
        ? 'WHERE (removed.worktree_id, removed.scope_id) > (?, ?)'
        : 'WHERE (removed.worktree_id, removed.scope_id) <= (?, ?)';
  return {
    parameters: cursor === undefined ? [limit] : [...codeGraphScopeCursorParameters(cursor), limit],
    text: `SELECT
        scope_id,
        CASE WHEN typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
          THEN worktree_id ELSE NULL END AS worktree_id,
        CASE WHEN typeof(expected_snapshot_id) = 'text'
               AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
          THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id,
        CASE WHEN typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
          THEN removed_at ELSE NULL END AS removed_at
      FROM removed_views AS removed
      ${predicate}
      ORDER BY removed.worktree_id, removed.scope_id
      LIMIT ?`,
  };
}

/** @internal Indexed due page retained for query-plan and crash-fairness regressions. */
export function codeGraphRemovedViewCleanupDuePageStatement(
  nowMilliseconds: number,
  requestedLimit = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
): CodeGraphSqlQueryStatement {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS, requestedLimit))
    : CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS;
  return {
    parameters: [nowMilliseconds, limit],
    text: `SELECT ${REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION}
      FROM removed_view_cleanup AS cleanup INDEXED BY removed_view_cleanup_due
      WHERE cleanup.phase <> 'complete' AND cleanup.next_attempt_at <= ?
      ORDER BY cleanup.next_attempt_at, cleanup.worktree_id, cleanup.scope_id, cleanup.expected_snapshot_id
      LIMIT ?`,
  };
}

const admitRemovedViewCleanupEpoch = Effect.fn('codeGraph.admitRemovedViewCleanupEpoch')(function* (
  sql: SqlClient.SqlClient,
) {
  const cursorInspection = yield* inspectRemovedViewCleanupAdmissionCursor(sql);
  if (!cursorInspection.current) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup admission cursor is invalid.');
  }
  const cursor = cursorInspection.cursor;
  const selectPage = (boundary: 'after' | 'through', limit: number) => {
    const statement = codeGraphRemovedViewCleanupAdmissionPageStatement(cursor, boundary, limit);
    return sql.unsafe<{
      readonly expected_snapshot_id: unknown;
      readonly removed_at: unknown;
      readonly worktree_id: unknown;
      readonly scope_id: string;
    }>(statement.text, statement.parameters);
  };
  const after = yield* selectPage('after', CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS);
  const rows =
    cursor === undefined || after.length >= CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS
      ? after
      : [...after, ...(yield* selectPage('through', CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS - after.length))];
  const tombstones: Array<{
    readonly expectedSnapshotId: string;
    readonly removedAt: string;
    readonly worktreeId: string;
    readonly scopeId: string;
  }> = [];
  for (const row of rows) {
    if (
      typeof row.worktree_id !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(row.worktree_id) ||
      typeof row.expected_snapshot_id !== 'string' ||
      !CODE_GRAPH_SNAPSHOT_ID.test(row.expected_snapshot_id) ||
      typeof row.removed_at !== 'string' ||
      !validCanonicalTimestamp(row.removed_at)
    ) {
      return yield* CodeGraphStoreError.of('Code graph removed view cleanup admission row is invalid.');
    }
    tombstones.push({
      expectedSnapshotId: row.expected_snapshot_id,
      removedAt: row.removed_at,
      worktreeId: row.worktree_id,
      scopeId: row.scope_id,
    });
  }

  const lastTombstone = tombstones.at(-1);
  let nextCursor =
    lastTombstone === undefined ? undefined : codeGraphScopeCursor(lastTombstone.worktreeId, lastTombstone.scopeId);
  for (const tombstone of tombstones) {
    const existing = yield* selectRemovedViewCleanupEntry(
      sql,
      tombstone.worktreeId,
      tombstone.expectedSnapshotId,
      tombstone.scopeId,
    );
    if (existing !== undefined && existing.removedAt === tombstone.removedAt) continue;
    yield* validateRemovedViewSnapshotAuthority(sql, tombstone.expectedSnapshotId, false);
    yield* ensureRemovedViewCleanupEpoch(
      sql,
      tombstone.worktreeId,
      tombstone.expectedSnapshotId,
      tombstone.removedAt,
      false,
      undefined,
      false,
      tombstone.scopeId,
    );
    nextCursor = codeGraphScopeCursor(tombstone.worktreeId, tombstone.scopeId);
    break;
  }
  if (nextCursor !== undefined) {
    yield* sql`
      INSERT INTO schema_metadata (key, value)
      VALUES (${REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY}, ${nextCursor})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `;
  }
});

const claimRemovedViewCleanupCandidates = Effect.fn('codeGraph.claimRemovedViewCleanupCandidates')(function* (
  sql: SqlClient.SqlClient,
  nowMilliseconds: number,
  requestedLimit: number,
) {
  if (
    !Number.isSafeInteger(nowMilliseconds) ||
    nowMilliseconds < 0 ||
    nowMilliseconds > MAXIMUM_CANONICAL_DATE_MILLISECONDS - CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit <= 0
  ) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup claim time is invalid.');
  }
  const nextAttemptAt = nowMilliseconds + CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* CodeGraphStoreError.of('Code graph removed view cleanup schema is unavailable.');
      }
      yield* admitRemovedViewCleanupEpoch(sql);
      const statement = codeGraphRemovedViewCleanupDuePageStatement(nowMilliseconds, requestedLimit);
      const rows = yield* sql.unsafe<RemovedViewCleanupRow>(statement.text, statement.parameters);
      const entries: CodeGraphRemovedViewCleanupEntry[] = [];
      for (const row of rows) {
        const entry = decodeRemovedViewCleanupRow(row);
        if (entry === undefined || entry.revision >= Number.MAX_SAFE_INTEGER) {
          return yield* CodeGraphStoreError.of('Code graph removed view cleanup claim row is invalid.');
        }
        entries.push(entry);
      }
      const claimed: CodeGraphRemovedViewCleanupEntry[] = [];
      for (const entry of entries) {
        const claimedAt = DateTime.formatIso(
          DateTime.makeUnsafe(Math.max(nowMilliseconds, Date.parse(entry.updatedAt))),
        );
        yield* sql.unsafe(
          `UPDATE removed_view_cleanup
           SET revision = ?, next_attempt_at = ?, updated_at = ?
           WHERE ${REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE}`,
          [entry.revision + 1, nextAttemptAt, claimedAt, ...removedViewCleanupEntryCasParameters(entry)],
        );
        if ((yield* lastStatementChangeCount(sql)) !== 1) {
          return yield* CodeGraphStoreError.of('Code graph removed view cleanup claim changed.');
        }
        claimed.push({...entry, nextAttemptAt, revision: entry.revision + 1, updatedAt: claimedAt});
      }
      return claimed;
    }),
  );
});

const authorizeRemovedViewCleanup = Effect.fn('codeGraph.authorizeRemovedViewCleanup')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
) {
  if (!validRemovedViewCleanupEntry(entry) || entry.phase === 'complete') {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup candidate is invalid.');
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* CodeGraphStoreError.of('Code graph removed view cleanup schema is unavailable.');
      }
      const current = yield* selectRemovedViewCleanupEntry(
        sql,
        entry.worktreeId,
        entry.expectedSnapshotId,
        entry.scopeId,
      );
      if (current === undefined || !sameRemovedViewCleanupEntry(current, entry)) return {state: 'stale'} as const;
      const authority = yield* observeRemovedViewCleanupAuthority(sql, entry);
      if (authority.state === 'stale') {
        yield* revokeRemovedViewCleanupEntry(sql, entry);
        return authority;
      }
      if (authority.state !== 'authorized') return authority;
      yield* removeMatchingLegacyCleanupPointer(sql, entry, authority.matchingActivePointer);
      if (entry.phase === 'provenance') {
        const view = yield* observeOrphanProvenanceView(sql, entry.worktreeId);
        if (view.state === 'active') {
          return {observedSnapshotId: view.snapshotId, state: 'active-pointer-changed'} as const;
        }
      }
      return {entry, state: 'authorized'} as const;
    }),
  );
});

const updateRemovedViewCleanup = Effect.fn('codeGraph.updateRemovedViewCleanup')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
  update: CodeGraphRemovedViewCleanupUpdate,
) {
  if (!validRemovedViewCleanupEntry(entry) || !validRemovedViewCleanupUpdate(entry, update)) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup update is invalid.');
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* CodeGraphStoreError.of('Code graph removed view cleanup schema is unavailable.');
      }
      const current = yield* selectRemovedViewCleanupEntry(
        sql,
        entry.worktreeId,
        entry.expectedSnapshotId,
        entry.scopeId,
      );
      if (current === undefined || !sameRemovedViewCleanupEntry(current, entry)) return {state: 'stale'} as const;
      const authority = yield* observeRemovedViewCleanupAuthority(sql, entry);
      if (authority.state === 'stale') {
        yield* revokeRemovedViewCleanupEntry(sql, entry);
        return authority;
      }
      if (authority.state !== 'authorized') return authority;
      yield* sql.unsafe(
        `UPDATE removed_view_cleanup
         SET phase = ?, cursor_token = ?, revision = ?, attempts = ?,
             next_attempt_at = ?, blocked_code = ?, updated_at = ?
         WHERE ${REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE}`,
        [
          update.phase,
          update.cursorToken ?? null,
          entry.revision + 1,
          update.attempts,
          update.nextAttemptAt,
          update.blockedCode ?? null,
          update.updatedAt,
          ...removedViewCleanupEntryCasParameters(entry),
        ],
      );
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* CodeGraphStoreError.of('Code graph removed view cleanup update changed.');
      }
      yield* removeMatchingLegacyCleanupPointer(sql, entry, authority.matchingActivePointer);
      const updated = yield* selectRemovedViewCleanupEntry(sql, entry.worktreeId, entry.expectedSnapshotId);
      if (updated === undefined) {
        return yield* CodeGraphStoreError.of('Code graph removed view cleanup update disappeared.');
      }
      return {entry: updated, state: 'updated'} as const;
    }),
  );
});

export {
  codeGraphWorktreeReconciliationSchemaCompatible,
  markSnapshotLeaseRetirementBaton,
  ensureRemovedViewCleanupEpoch,
  validRemovedViewCleanupUpdate,
  admitRemovedViewCleanupEpoch,
  claimOrphanProvenanceCandidates,
  claimWorktreeReconciliationCandidates,
  observeOrphanProvenanceView,
  claimRemovedViewCleanupCandidates,
  authorizeRemovedViewCleanup,
  updateRemovedViewCleanup,
};
