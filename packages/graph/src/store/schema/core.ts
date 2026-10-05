import {Clock, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import * as SqlError from 'effect/sql/SqlError';
import {
  REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY,
  REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY,
} from '../removed/view_schema_contracts.js';
import {
  removedViewAuthorityTableState,
  removedViewCleanupRecordedRevision,
  removedViewCleanupSchemaState,
} from '../removed/view_schema_inspection.js';
import {
  REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
  type SchemaMetadataMaximumRows,
  inspectBoundedSchemaMetadataRowCount,
  inspectBoundedSchemaMetadataValue,
} from './metadata.js';
import {tableExists} from '../session.js';
import {codeGraphPersistentSchemaIsCurrent} from './revision.js';
import {CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES, CODE_GRAPH_SCOPE_CURSOR_PATTERN} from '../scope/cursor.js';

const removedViewCleanupSchemaCurrent = Effect.fn('codeGraph.removedViewCleanupSchemaCurrent')(function* (
  sql: SqlClient.SqlClient,
) {
  return (yield* removedViewCleanupSchemaState(sql)) === 'compatible';
});

const inspectRemovedViewCleanupAdmissionCursor = Effect.fn('codeGraph.inspectRemovedViewCleanupAdmissionCursor')(
  function* (
    sql: SqlClient.SqlClient,
    maximumMetadataRows: SchemaMetadataMaximumRows = REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
  ) {
    const inspection = yield* inspectBoundedSchemaMetadataValue(
      sql,
      REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY,
      CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES,
      maximumMetadataRows,
    );
    if (inspection.state === 'missing') return {current: true, cursor: undefined} as const;
    if (inspection.state === 'invalid' || !CODE_GRAPH_SCOPE_CURSOR_PATTERN.test(inspection.value)) {
      return {current: false, cursor: undefined} as const;
    }
    return {current: true, cursor: inspection.value} as const;
  },
);

const removedViewCleanupEpochSequenceCurrent = Effect.fn('codeGraph.removedViewCleanupEpochSequenceCurrent')(function* (
  sql: SqlClient.SqlClient,
) {
  const inspection = yield* inspectBoundedSchemaMetadataValue(sql, REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY, 16);
  return (
    inspection.state === 'recorded' &&
    /^(?:0|[1-9][0-9]*)$/u.test(inspection.value) &&
    Number.isSafeInteger(Number(inspection.value))
  );
});

interface CodeGraphRemovedViewCleanupSchemaAdmission {
  readonly current: boolean;
  readonly persistentExtensionSchemaRevision: number | undefined;
}

const codeGraphRemovedViewCleanupBaseSchemaAdmission: (
  sql: SqlClient.SqlClient,
) => Effect.Effect<CodeGraphRemovedViewCleanupSchemaAdmission, SqlError.SqlError> = Effect.fn(
  'codeGraph.removedViewCleanupBaseSchemaAdmission',
)(function* (sql: SqlClient.SqlClient) {
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  const persistentExtensionSchemaRevision = revision.state === 'recorded' ? revision.value : undefined;
  if (!codeGraphPersistentSchemaIsCurrent(persistentExtensionSchemaRevision)) {
    return {current: false, persistentExtensionSchemaRevision} as const;
  }
  if (!(yield* removedViewCleanupEpochSequenceCurrent(sql))) {
    return {current: false, persistentExtensionSchemaRevision} as const;
  }
  const metadataRowCount = yield* inspectBoundedSchemaMetadataRowCount(sql);
  if (metadataRowCount === undefined) {
    return {current: false, persistentExtensionSchemaRevision} as const;
  }
  const admissionCursor = yield* inspectRemovedViewCleanupAdmissionCursor(sql);
  return {
    current:
      admissionCursor.current &&
      metadataRowCount <=
        (admissionCursor.cursor === undefined
          ? REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - 1
          : REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS) &&
      (yield* removedViewAuthorityTableState(sql)) === 'compatible' &&
      (yield* removedViewCleanupSchemaCurrent(sql)),
    persistentExtensionSchemaRevision,
  } as const;
});

const ensureSnapshotLeaseSchema = Effect.fn('codeGraph.ensureSnapshotLeaseSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_leases (
      token TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      retire_when_inactive INTEGER NOT NULL DEFAULT 0 CHECK (retire_when_inactive IN (0, 1))
    )
  `);
  const addedLeaseRetirement = yield* ensureColumn(
    sql,
    'snapshot_leases',
    'retire_when_inactive',
    'INTEGER NOT NULL DEFAULT 0 CHECK (retire_when_inactive IN (0, 1))',
  );
  if (!addedLeaseRetirement) return;
  const now = yield* Clock.currentTimeMillis;
  // Existing runtimes did not record whether a lease pinned an active view.
  // Preserve live non-active consumers, but migrate current pointers and
  // already-expired displaced pointers so the upgrade can reclaim their
  // abandoned history on the next lease sweep.
  if (yield* tableExists(sql, 'removed_views')) {
    yield* sql`
      UPDATE snapshot_leases AS lease
      SET retire_when_inactive = 1
      WHERE EXISTS (
        SELECT 1 FROM active_snapshots AS active
        WHERE active.snapshot_id = lease.snapshot_id
          AND NOT EXISTS (
            SELECT 1 FROM removed_views AS removed
            WHERE removed.worktree_id = active.worktree_id
              AND removed.expected_snapshot_id = active.snapshot_id
          )
      ) OR (
        lease.expires_at <= ${now}
        AND EXISTS (
          SELECT 1
          FROM snapshots AS candidate
          JOIN active_snapshots AS active ON active.worktree_id = candidate.worktree_id
          WHERE candidate.id = lease.snapshot_id
        )
      )
    `;
    return;
  }
  // Partial and mixed-version schemas may not have the additive tombstone
  // table yet. Keep the legacy active-pointer migration conservative without
  // creating unrelated schema as a side effect of lease maintenance.
  yield* sql`
    UPDATE snapshot_leases AS lease
    SET retire_when_inactive = 1
    WHERE EXISTS (
      SELECT 1 FROM active_snapshots AS active
      WHERE active.snapshot_id = lease.snapshot_id
    ) OR (
      lease.expires_at <= ${now}
      AND EXISTS (
        SELECT 1
        FROM snapshots AS candidate
        JOIN active_snapshots AS active ON active.worktree_id = candidate.worktree_id
        WHERE candidate.id = lease.snapshot_id
      )
    )
  `;
});

const CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL = `CREATE TRIGGER active_snapshots_require_current_extractor
  BEFORE INSERT ON active_snapshots
  FOR EACH ROW
  WHEN NOT EXISTS (
    SELECT 1
    FROM snapshot_extractor_generations AS generation
    JOIN schema_metadata AS minimum
      ON minimum.key = 'minimum_extractor_generation'
    WHERE generation.snapshot_id = NEW.snapshot_id
      AND generation.generation >= CAST(minimum.value AS INTEGER)
  )
  BEGIN
    SELECT RAISE(ABORT, 'Code graph snapshot was built by an older extractor generation.');
  END`;

const CODE_GRAPH_SCOPED_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL =
  CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL.replace(
    'FROM snapshot_extractor_generations AS generation',
    'FROM snapshot_extractor_generations AS generation JOIN snapshots AS snapshot ON snapshot.id = generation.snapshot_id',
  ).replace(
    'WHERE generation.snapshot_id = NEW.snapshot_id',
    'WHERE generation.snapshot_id = NEW.snapshot_id AND snapshot.scope_id = NEW.scope_id',
  );

const ensureColumn = Effect.fn('codeGraph.ensureColumn')(function* (
  sql: SqlClient.SqlClient,
  table: string,
  column: string,
  declaration: string,
) {
  const columns = yield* sql.unsafe<{readonly name: string}>(`PRAGMA table_info(${table})`);
  if (columns.some(candidate => candidate.name === column)) return false;
  yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  return true;
});

export {
  removedViewCleanupSchemaCurrent,
  inspectRemovedViewCleanupAdmissionCursor,
  CodeGraphRemovedViewCleanupSchemaAdmission,
  CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL,
  CODE_GRAPH_SCOPED_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL,
  ensureColumn,
  ensureSnapshotLeaseSchema,
  removedViewCleanupEpochSequenceCurrent,
  codeGraphRemovedViewCleanupBaseSchemaAdmission,
};
