import {Clock, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {type CodeGraphDatabaseRepair} from './models.js';
import {CodeGraphStoreError} from '../types.js';
import {diagnoseDatabase} from './diagnostics.js';
import {pruneRetiredSnapshotRows} from './retirement.js';
import {pruneUnreferencedFileBlobs} from './cleanup_core.js';
import {codeGraphPersistentExtensionSchemaCompatible} from './schema/inspection.js';
import {codeGraphSchemaMigrationPreservesIncompleteSnapshots} from './schema/migration.js';

/** Exact read-only cleanup admission, including a preparation-proven migration preview. */

const repairDatabase = Effect.fn('codeGraph.repairDatabase')(function* (
  dryRun: boolean,
  allowSchemaMigrationPreview = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const health = yield* diagnoseDatabase();
  const schemaMigrationPreviewAllowed =
    dryRun &&
    allowSchemaMigrationPreview &&
    (health.integrity === 'incompatible' || health.integrity === 'migration-pending') &&
    codeGraphSchemaMigrationPreservesIncompleteSnapshots(
      health.persistentExtensionSchemaRevision,
      health.snapshotFileCitationSchema,
      health.snapshotFileCitationBaseIndexes,
    ) &&
    (yield* codeGraphPersistentExtensionSchemaCompatible(sql));
  if (health.integrity !== 'ok' && !schemaMigrationPreviewAllowed) {
    return yield* CodeGraphStoreError.of(`Code graph database is ${health.integrity}; discard and rebuild it.`);
  }
  const now = yield* Clock.currentTimeMillis;
  const retainedIncompleteSnapshots = yield* sql<{readonly id: string}>`
    SELECT snapshot.id
    FROM snapshots AS snapshot
    WHERE snapshot.state IN ('building', 'failed')
      AND EXISTS (
        SELECT 1 FROM snapshot_leases AS lease
        WHERE lease.snapshot_id = snapshot.id AND lease.expires_at > ${now}
      )
    ORDER BY snapshot.id
  `;
  const retainedIncompleteSnapshotIds = retainedIncompleteSnapshots.map(snapshot => snapshot.id);
  if (dryRun) {
    const candidates = yield* sql<{readonly count: number}>`
      SELECT COUNT(*) AS count
      FROM snapshots AS snapshot
      WHERE snapshot.state IN ('building', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_leases AS lease
          WHERE lease.snapshot_id = snapshot.id AND lease.expires_at > ${now}
        )
    `;
    return {
      removedSnapshots: Number(candidates[0]?.count ?? 0),
      retainedIncompleteSnapshotIds,
    } satisfies CodeGraphDatabaseRepair;
  }
  const candidates = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM snapshots AS snapshot
    WHERE snapshot.state IN ('building', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_leases AS lease
        WHERE lease.snapshot_id = snapshot.id AND lease.expires_at > ${now}
      )
  `;
  const removedSnapshots = Number(candidates[0]?.count ?? 0);
  yield* sql.withTransaction(
    Effect.asVoid(sql`
        UPDATE snapshots
        SET state = 'retired'
        WHERE state IN ('building', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_leases AS lease
            WHERE lease.snapshot_id = snapshots.id AND lease.expires_at > ${now}
          )
      `),
  );
  yield* pruneRetiredSnapshotRows();
  yield* sql.withTransaction(pruneUnreferencedFileBlobs(sql));
  return {removedSnapshots, retainedIncompleteSnapshotIds} satisfies CodeGraphDatabaseRepair;
});

export {repairDatabase};
