import {DateTime, Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import * as SqlError from 'effect/sql/SqlError';
import {
  REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY,
  REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL,
  REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY,
  REMOVED_VIEW_CLEANUP_TABLE_SQL,
  REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
} from '../removed/view_schema_contracts.js';
import {
  removedViewAuthorityTableState,
  removedViewCleanupRecordedRevision,
  removedViewCleanupSchemaState,
} from '../removed/view_schema_inspection.js';
import {
  LEGACY_BUILDING_REFERENCES_V3_CONTRACT,
  LEGACY_BUILDING_REFERENCES_V3_TABLE,
  LEGACY_SNAPSHOT_BUILD_OWNERS_CONTRACT,
  PERSISTENT_EXTENSION_TABLES,
  REMOVED_BETA30_INDEXES,
} from './contracts.js';
import {
  inspectPersistentExtensionTables,
  persistentExtensionTableInspection,
  validatePersistentExtensionTables,
} from './inspection.js';
import {
  REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS,
  REMOVED_VIEW_CLEANUP_LEGACY_MAXIMUM_METADATA_ROWS,
  inspectBoundedSchemaMetadataRowCount,
  inspectBoundedSchemaMetadataValue,
} from './metadata.js';
import {CodeGraphDatabaseSession, tableExists} from '../session.js';
import {
  type CodeGraphSnapshotFileCitationBaseIndexState,
  type CodeGraphSnapshotFileCitationSchemaState,
  CodeGraphStoreError,
} from '../../types.js';
import {
  CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION,
  codeGraphPersistentSchemaIsCurrent,
  codeGraphPersistentSchemaIsOlder,
  codeGraphPersistentSchemaRevisionValue,
  codeGraphPersistentSchemaSupports,
  observeCodeGraphPersistentSchemaRevision,
  planCodeGraphPersistentSchemaUpgrade,
} from './revision.js';
import {CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX, codeGraphReconciliationIndexState} from '../reconciliation/core.js';
import {codeGraphWorktreeReconciliationSchemaCompatible} from '../reconciliation.js';
import {ensureCodeGraphFileBlobAuthority} from '../cache/authority.js';
import {
  type CodeGraphSnapshotFileCitationSchemaAuthorization,
  codeGraphSnapshotFileCitationSchemaMigrationPreserves,
  ensureCodeGraphSnapshotFileCitationSchema,
} from '../file_alias_schema.js';
import {
  CODE_GRAPH_QUERY_INDEX_DEFINITIONS,
  ensureCodeGraphQueryIndexes,
  ensureCodeGraphScopeQueryIndexes,
} from '../query/indexes.js';
import {
  CODE_GRAPH_SCOPED_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL,
  codeGraphRemovedViewCleanupBaseSchemaAdmission,
  type CodeGraphRemovedViewCleanupSchemaAdmission,
  removedViewCleanupSchemaCurrent,
} from './core.js';
import {codeGraphScopeAuthorityInstalled, migrateCodeGraphScopeAuthority} from '../scope/schema.js';
import {CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES, CODE_GRAPH_SCOPE_CURSOR_PATTERN} from '../scope/cursor.js';

/** Additive revisions 16 and 17 preserve incomplete resumable-build rows. */
export function codeGraphSchemaMigrationPreservesIncompleteSnapshots(
  revision: number | undefined,
  snapshotFileCitationSchema: CodeGraphSnapshotFileCitationSchemaState,
  snapshotFileCitationBaseIndexes: CodeGraphSnapshotFileCitationBaseIndexState,
): boolean {
  return codeGraphSnapshotFileCitationSchemaMigrationPreserves(
    revision,
    snapshotFileCitationSchema,
    snapshotFileCitationBaseIndexes,
  );
}

const preflightRemovedViewCleanupSchema = Effect.fn('codeGraph.preflightRemovedViewCleanupSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  const removedViewAuthority = yield* removedViewAuthorityTableState(sql);
  if (removedViewAuthority === 'incompatible') {
    return yield* CodeGraphStoreError.of('Code graph removed view authority schema is incompatible.');
  }
  const schema = yield* removedViewCleanupSchemaState(sql);
  if (schema === 'incompatible') {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup schema is incompatible.');
  }
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  const recordedRevision = revision.state === 'recorded' ? revision.value : undefined;
  if (
    codeGraphPersistentSchemaSupports(recordedRevision, 'graph-scope-authority') &&
    !(yield* codeGraphScopeAuthorityInstalled(sql))
  ) {
    return yield* CodeGraphStoreError.of('Code graph scope authority schema is unavailable.');
  }
  const revisionObservation = observeCodeGraphPersistentSchemaRevision(recordedRevision);
  if (revisionObservation.state === 'newer') {
    return yield* CodeGraphStoreError.of(
      `Code graph persistent extension schema ${revisionObservation.value} is newer than ${CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION}.`,
    );
  }
  const leaseObjects = yield* sql.unsafe<{readonly name: unknown; readonly type: unknown}>(
    `SELECT name, type
     FROM sqlite_master
     WHERE name = 'snapshot_leases' COLLATE NOCASE
     LIMIT 2`,
  );
  if (
    leaseObjects.length > 1 ||
    (leaseObjects.length === 1 && (leaseObjects[0]?.name !== 'snapshot_leases' || leaseObjects[0]?.type !== 'table'))
  ) {
    return yield* CodeGraphStoreError.of('Code graph snapshot lease schema is incompatible.');
  }
  if (leaseObjects.length === 1) {
    const expiryIndexState = yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX);
    if (expiryIndexState === 'incompatible') {
      return yield* CodeGraphStoreError.of('Code graph snapshot lease expiry index is incompatible.');
    }
    if (expiryIndexState === 'missing') {
      const rows = yield* sql.unsafe('SELECT 1 FROM snapshot_leases LIMIT 1');
      if (revision.state !== 'missing' || rows.length !== 0) {
        return yield* CodeGraphStoreError.of('Code graph snapshot lease expiry index is unavailable.');
      }
    }
  }
  const metadataPresent = revision.state === 'recorded' || (revision.state === 'missing' && revision.metadataPresent);
  const metadataRowCount = metadataPresent ? yield* inspectBoundedSchemaMetadataRowCount(sql) : 0;
  const epochSequence = metadataPresent
    ? yield* inspectBoundedSchemaMetadataValue(sql, REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY, 16)
    : ({state: 'missing'} as const);
  const admissionCursor = metadataPresent
    ? yield* inspectBoundedSchemaMetadataValue(
        sql,
        REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY,
        CODE_GRAPH_SCOPE_CURSOR_MAXIMUM_BYTES,
      )
    : ({state: 'missing'} as const);
  const epochSequenceCurrent =
    epochSequence.state === 'recorded' &&
    /^(?:0|[1-9][0-9]*)$/u.test(epochSequence.value) &&
    Number.isSafeInteger(Number(epochSequence.value));
  const cursorCurrent =
    admissionCursor.state === 'missing' ||
    (admissionCursor.state === 'recorded' && CODE_GRAPH_SCOPE_CURSOR_PATTERN.test(admissionCursor.value));
  const ownerInstanceMarkerObjects =
    schema === 'absent' && revision.state === 'missing'
      ? yield* sql.unsafe(
          `SELECT name FROM sqlite_master
           WHERE name = 'snapshot_build_owner_instances' COLLATE NOCASE
           LIMIT 1`,
        )
      : [];
  const coreAuthorityCurrent = codeGraphPersistentSchemaSupports(recordedRevision, 'worktree-reconciliation-authority')
    ? yield* codeGraphWorktreeReconciliationSchemaCompatible(
        sql,
        schema === 'compatible',
        false,
        removedViewAuthority === 'compatible',
      )
    : true;
  if (
    revision.state === 'invalid' ||
    metadataRowCount === undefined ||
    epochSequence.state === 'invalid' ||
    (epochSequence.state === 'recorded' && !epochSequenceCurrent) ||
    !cursorCurrent ||
    (schema === 'absent' && codeGraphPersistentSchemaSupports(recordedRevision, 'removed-view-cleanup-authority')) ||
    (schema === 'absent' && (epochSequence.state !== 'missing' || admissionCursor.state !== 'missing')) ||
    (schema === 'absent' &&
      metadataRowCount >
        REMOVED_VIEW_CLEANUP_LEGACY_MAXIMUM_METADATA_ROWS -
          (revision.state === 'missing' && revision.metadataPresent ? 1 : 0)) ||
    (schema === 'compatible' &&
      (!codeGraphPersistentSchemaSupports(recordedRevision, 'removed-view-cleanup-authority') ||
        !epochSequenceCurrent)) ||
    (schema === 'compatible' && removedViewAuthority !== 'compatible') ||
    (schema === 'compatible' &&
      metadataRowCount >
        (admissionCursor.state === 'missing'
          ? REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - 1
          : REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS)) ||
    ownerInstanceMarkerObjects.length > 0 ||
    !coreAuthorityCurrent
  ) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup schema is incompatible.');
  }
  // Table and index creation plus the authority revision are one transaction.
  // Later additive extension revisions may retain this exact verified schema;
  // a missing or partial authority at revision 8+ is drift and never self-heals.
});

/** Exact read-only admission shared by cleanup writers and both health paths. */
export const codeGraphRemovedViewCleanupSchemaAdmission: (
  sql: SqlClient.SqlClient,
) => Effect.Effect<CodeGraphRemovedViewCleanupSchemaAdmission, SqlError.SqlError> = Effect.fn(
  'codeGraph.removedViewCleanupSchemaAdmission',
)(function* (sql: SqlClient.SqlClient) {
  const admission = yield* codeGraphRemovedViewCleanupBaseSchemaAdmission(sql);
  return {
    ...admission,
    current: admission.current && (yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, true, false)),
  } as const;
});

const ensureRemovedViewCleanupSchema = Effect.fn('codeGraph.ensureRemovedViewCleanupSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* preflightRemovedViewCleanupSchema(sql);
  if (yield* codeGraphScopeAuthorityInstalled(sql)) return;
  yield* sql.unsafe(REMOVED_VIEW_CLEANUP_TABLE_SQL);
  yield* sql.unsafe(REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL);
  for (const trigger of REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS) yield* sql.unsafe(trigger.sql);
  if (!(yield* removedViewCleanupSchemaCurrent(sql))) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup schema is incompatible.');
  }
});

/** Keep query-required core indexes compatible across additive extension upgrades. */
const ensureCurrentCodeGraphQueryIndexes = Effect.fn('codeGraph.ensureCurrentQueryIndexes')(function* (
  sql: SqlClient.SqlClient,
) {
  // These projections are covered by the NOCASE name and visualization scope
  // indexes. Drop them during the same revision transaction as the target-edge
  // replacement so an upgraded database cannot advertise the new revision
  // while retaining only the legacy query surface.
  yield* sql.unsafe('DROP INDEX IF EXISTS symbols_name');
  yield* sql.unsafe('DROP INDEX IF EXISTS symbols_resolution_scope');
  yield* sql.unsafe('DROP INDEX IF EXISTS edges_target');
  yield* ensureCodeGraphQueryIndexes(
    sql,
    CODE_GRAPH_QUERY_INDEX_DEFINITIONS.filter(
      definition => definition.name === 'edges_target_resolved' || definition.name === 'edges_evidence_path',
    ),
  );
  // Cache admission runs before inventory and previously evaluated JSON
  // authority from every fact payload in the selected extractor generation.
  // A narrow trigger-maintained table materializes that authority at write
  // time and serves every admission projection without reading fact payloads
  // or weakening corrupt-row rejection.
  yield* ensureCodeGraphFileBlobAuthority(sql);
});

const migratePersistentExtensionTables = Effect.fn('codeGraph.migratePersistentExtensionTables')(function* (
  sql: SqlClient.SqlClient,
  snapshotFileCitationAuthorization: CodeGraphSnapshotFileCitationSchemaAuthorization,
) {
  const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
  const observe = Option.isSome(session) ? session.value.onPersistentSchemaMigrationPhase : undefined;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const revision = yield* sql<{readonly value: string}>`
        SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision' LIMIT 1
      `;
      const revisionPlan = planCodeGraphPersistentSchemaUpgrade(revision[0]?.value);
      const recordedRevision = codeGraphPersistentSchemaRevisionValue(revision[0]?.value);
      if (revisionPlan.state === 'reject-newer') {
        return yield* CodeGraphStoreError.of(
          `Code graph persistent extension schema ${revisionPlan.value} is newer than ${CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION}.`,
        );
      }
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, true, false))) {
        return yield* CodeGraphStoreError.of('Code graph cleanup authority schema is incompatible.');
      }
      yield* ensureCodeGraphSnapshotFileCitationSchema(sql, snapshotFileCitationAuthorization);
      const cleanupSchemaState = yield* removedViewCleanupSchemaState(sql);
      yield* ensureRemovedViewCleanupSchema(sql);
      if (cleanupSchemaState === 'absent') {
        yield* sql`
          INSERT INTO schema_metadata (key, value)
          VALUES (${REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY}, '0')
        `;
        yield* observe?.('added-removed-view-cleanup') ?? Effect.void;
      }
      if (codeGraphPersistentSchemaIsOlder(recordedRevision)) {
        yield* ensureCurrentCodeGraphQueryIndexes(sql);
        yield* observe?.('migrated-query-indexes') ?? Effect.void;
      }
      if (revisionPlan.state === 'upgrade' && revisionPlan.route === 'bridge-build-owner-instance') {
        const ownerInstances = PERSISTENT_EXTENSION_TABLES.find(
          table => table.name === 'snapshot_build_owner_instances',
        );
        if (ownerInstances === undefined) {
          return yield* CodeGraphStoreError.of('Persistent build owner instance schema is unavailable.');
        }
        const inspection = yield* persistentExtensionTableInspection(sql, ownerInstances);
        if (!inspection.exists) {
          // Revision 7 adds only exact owner-instance evidence. Never infer it
          // from legacy PID-bearing tokens: an old writer may still replace the
          // parent row, and the strict token join must then fail closed.
          yield* sql.unsafe(ownerInstances.createSql);
          yield* observe?.('added-build-owner-instance') ?? Effect.void;
        }
      }
      if (revisionPlan.state === 'upgrade' && revisionPlan.route === 'extend-checkpoint-import') {
        const checkpointTables = PERSISTENT_EXTENSION_TABLES.filter(table => table.group === 'checkpoint');
        for (const table of checkpointTables) {
          const inspection = yield* persistentExtensionTableInspection(sql, table);
          if (inspection.exists && !inspection.compatible) {
            return yield* CodeGraphStoreError.of(`Code graph checkpoint import schema ${table.name} is incompatible.`);
          }
          if (!inspection.exists) yield* sql.unsafe(table.createSql);
        }
        yield* observe?.('added-checkpoint-import') ?? Effect.void;
      }
      const legacyBuildOwners = yield* persistentExtensionTableInspection(sql, LEGACY_SNAPSHOT_BUILD_OWNERS_CONTRACT);
      if (legacyBuildOwners.compatible) {
        const completedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE snapshots
          SET state = 'retired',
              completed_at = COALESCE(completed_at, ${completedAt}),
              failure_summary = COALESCE(
                failure_summary,
                'Persistent code graph materialization plan changed; rebuild required.'
              )
          WHERE state IN ('building', 'failed')
        `;
        const retired = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
        if (Number(retired[0]?.count ?? 0) > 0) yield* observe?.('retired-incomplete') ?? Effect.void;
        // The beta.30 owner table is tiny. Upgrade it in place so retiring a
        // multi-gigabyte interrupted build never synchronously drops its
        // staging tables; bounded maintenance reclaims those rows later.
        yield* sql.unsafe(`
          ALTER TABLE snapshot_build_owners
          ADD COLUMN expected_batch_count INTEGER
          CHECK (expected_batch_count IS NULL OR expected_batch_count >= 0)
        `);
        yield* observe?.('added-materialization-plan') ?? Effect.void;
      }
      if (revisionPlan.state === 'upgrade' && revisionPlan.route === 'retire-legacy-references-and-rebuild') {
        const legacyReferences = yield* persistentExtensionTableInspection(sql, LEGACY_BUILDING_REFERENCES_V3_CONTRACT);
        const alreadyRenamed = yield* tableExists(sql, LEGACY_BUILDING_REFERENCES_V3_TABLE);
        if (legacyReferences.compatible && !alreadyRenamed) {
          const completedAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            UPDATE snapshots
            SET state = 'retired',
                completed_at = COALESCE(completed_at, ${completedAt}),
                failure_summary = COALESCE(
                  failure_summary,
                  'Persistent reference candidate format changed; rebuild required.'
                )
            WHERE state IN ('building', 'failed')
          `;
          const retired = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
          if (Number(retired[0]?.count ?? 0) > 0) yield* observe?.('retired-incomplete') ?? Effect.void;
          // Renaming the old reference surface is metadata-only. Its rows and
          // the much larger row-per-candidate table remain available to the
          // bounded maintenance collector instead of being dropped in this
          // schema transaction.
          yield* sql.unsafe(`ALTER TABLE building_references RENAME TO ${LEGACY_BUILDING_REFERENCES_V3_TABLE}`);
          const currentReferences = PERSISTENT_EXTENSION_TABLES.find(table => table.name === 'building_references');
          if (currentReferences === undefined) {
            return yield* CodeGraphStoreError.of('Current persistent reference schema is unavailable.');
          }
          yield* sql.unsafe(currentReferences.createSql);
        }
      }
      const inspections = yield* inspectPersistentExtensionTables(sql);
      const extensionSchemaCompatible = inspections.every(inspection => inspection.exists && inspection.compatible);
      if (
        codeGraphPersistentSchemaSupports(recordedRevision, 'direct-current-contract-adoption') &&
        extensionSchemaCompatible
      ) {
        yield* migrateCodeGraphScopeAuthority(sql);
        yield* ensureCodeGraphScopeQueryIndexes(sql);
        yield* sql.unsafe('DROP TRIGGER IF EXISTS active_snapshots_require_current_extractor');
        yield* sql.unsafe(CODE_GRAPH_SCOPED_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL);
        if (!codeGraphPersistentSchemaSupports(recordedRevision, 'graph-scope-authority'))
          yield* observe?.('added-graph-scope-authority') ?? Effect.void;
        if (!codeGraphPersistentSchemaIsCurrent(recordedRevision)) {
          yield* sql`
            INSERT INTO schema_metadata (key, value)
            VALUES ('persistent_extension_schema_revision', ${String(CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION)})
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `;
          yield* observe?.('recorded-revision') ?? Effect.void;
        }
        if (!(yield* codeGraphRemovedViewCleanupSchemaAdmission(sql)).current) {
          return yield* CodeGraphStoreError.of('Code graph removed view cleanup schema is unavailable.');
        }
        return;
      }
      const incompatibleGroups = new Set(
        inspections
          .filter(inspection => inspection.exists && !inspection.compatible)
          .map(inspection => inspection.group),
      );
      const missingTable = inspections.some(inspection => !inspection.exists);
      const lexicalReadSurfaceMissing = inspections.some(
        inspection => inspection.group === 'lexical' && !inspection.exists,
      );
      const crossRepositoryAuthorityUnavailable = inspections.some(
        inspection => inspection.group === 'cross-repository' && (!inspection.exists || !inspection.compatible),
      );
      const crossRepositorySnapshotAuthorityLost =
        crossRepositoryAuthorityUnavailable &&
        codeGraphPersistentSchemaSupports(recordedRevision, 'worktree-reconciliation-authority');
      const incomplete = yield* sql<{readonly count: number}>`
        SELECT COUNT(*) AS count FROM snapshots WHERE state IN ('building', 'failed')
      `;
      const hasIncompleteSnapshots = Number(incomplete[0]?.count ?? 0) > 0;

      // A receipt from a different resumable-build contract cannot prove that
      // already committed rows belong to the caller's current fact batch. Keep
      // ready snapshots intact, but make every incomplete snapshot unreachable
      // before replacing its build-only schema. Retired rows are reclaimed by
      // the normal bounded collector instead of one unbounded cascade here.
      if (hasIncompleteSnapshots && (missingTable || incompatibleGroups.size > 0)) {
        const completedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE snapshots
          SET state = 'retired',
              completed_at = COALESCE(completed_at, ${completedAt}),
              failure_summary = COALESCE(
                failure_summary,
                'Persistent code graph build schema changed; rebuild required.'
              )
          WHERE state IN ('building', 'failed')
        `;
        yield* observe?.('retired-incomplete') ?? Effect.void;
      }
      // Revision 10 makes external declarations and monikers part of snapshot
      // authority rather than a reconstructible summary. A ready pre-v10
      // snapshot cannot prove that it contains those declarations, and a
      // current snapshot whose tables drifted must not remain active after the
      // tables are recreated empty. Revoke its pointer in the same migration
      // transaction and let the ordinary identity path rebuild it.
      if (crossRepositorySnapshotAuthorityLost) {
        if (yield* tableExists(sql, 'active_snapshots')) {
          yield* sql`
            DELETE FROM active_snapshots
            WHERE snapshot_id IN (SELECT id FROM snapshots WHERE state = 'ready')
          `;
        }
        yield* sql`
          UPDATE snapshots
          SET state = 'retired',
              completed_at = COALESCE(completed_at, ${DateTime.formatIso(yield* DateTime.now)}),
              failure_summary = COALESCE(
                failure_summary,
                'Cross-repository declaration storage changed; rebuild required.'
              )
          WHERE state = 'ready'
        `;
        yield* observe?.('retired-incompatible-ready') ?? Effect.void;
      }
      // Revision 5 is the first schema that can claim compact lexical storage.
      // If any table in that contract is missing or incompatible, keeping a
      // ready snapshot while replacing its dictionaries would make the graph
      // appear healthy but return no lexical candidates. Invalidate the ready
      // pointer atomically and let the normal snapshot-identity path rebuild it.
      // Revision 4 snapshots remain readable from legacy symbol_terms while the
      // new compact tables are introduced alongside them.
      if (
        codeGraphPersistentSchemaSupports(recordedRevision, 'compact-lexical-authority') &&
        (incompatibleGroups.has('lexical') || lexicalReadSurfaceMissing)
      ) {
        if (yield* tableExists(sql, 'active_snapshots')) {
          yield* sql`
            DELETE FROM active_snapshots
            WHERE snapshot_id IN (SELECT id FROM snapshots WHERE state = 'ready')
          `;
        }
        yield* sql`
          UPDATE snapshots
          SET state = 'retired',
              completed_at = COALESCE(completed_at, ${DateTime.formatIso(yield* DateTime.now)}),
              failure_summary = COALESCE(
                failure_summary,
                'Compact lexical storage schema changed; rebuild required.'
              )
          WHERE state = 'ready'
        `;
        yield* observe?.('retired-incompatible-ready') ?? Effect.void;
      }
      for (const group of incompatibleGroups) {
        for (const table of [...PERSISTENT_EXTENSION_TABLES].reverse()) {
          if (table.group === group) yield* sql.unsafe(`DROP TABLE IF EXISTS "${table.name}"`);
        }
      }
      yield* observe?.('dropped-incompatible') ?? Effect.void;
      for (const table of PERSISTENT_EXTENSION_TABLES) yield* sql.unsafe(table.createSql);
      yield* observe?.('created-extensions') ?? Effect.void;
      for (const index of REMOVED_BETA30_INDEXES) yield* sql.unsafe(`DROP INDEX IF EXISTS "${index}"`);
      yield* observe?.('dropped-obsolete-indexes') ?? Effect.void;
      yield* validatePersistentExtensionTables(sql);
      yield* observe?.('validated') ?? Effect.void;
      yield* migrateCodeGraphScopeAuthority(sql);
      yield* ensureCodeGraphScopeQueryIndexes(sql);
      yield* sql.unsafe('DROP TRIGGER IF EXISTS active_snapshots_require_current_extractor');
      yield* sql.unsafe(CODE_GRAPH_SCOPED_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL);
      if (!codeGraphPersistentSchemaSupports(recordedRevision, 'graph-scope-authority'))
        yield* observe?.('added-graph-scope-authority') ?? Effect.void;
      yield* sql`
        INSERT INTO schema_metadata (key, value)
        VALUES ('persistent_extension_schema_revision', ${String(CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION)})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `;
      yield* observe?.('recorded-revision') ?? Effect.void;
      if (!(yield* codeGraphRemovedViewCleanupSchemaAdmission(sql)).current) {
        return yield* CodeGraphStoreError.of('Code graph removed view cleanup schema is unavailable.');
      }
    }),
  );
});

export {
  preflightRemovedViewCleanupSchema,
  ensureRemovedViewCleanupSchema,
  ensureCurrentCodeGraphQueryIndexes,
  migratePersistentExtensionTables,
};
