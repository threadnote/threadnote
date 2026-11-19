import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {CodeGraphStore} from '../store.js';
import {decodeCodeGraphInventoryReuseReceipt} from '../inventory/reuse.js';
import {
  CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS,
  CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_RENEWAL_INTERVAL_MILLISECONDS,
  type CodeGraphCheckpointProjectionRequest,
  CodeGraphCheckpointProjectionError,
  attemptProjection,
  validateSelectedSnapshot,
  normalizePageSize,
  validateProjectionIdentity,
  observeExactCleanRepository,
  projectInReadTransaction,
} from './authority.js';
export {
  CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS,
  CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_RENEWAL_INTERVAL_MILLISECONDS,
  CODE_GRAPH_CHECKPOINT_PROJECTION_DEFAULT_PAGE_SIZE,
  CODE_GRAPH_CHECKPOINT_PROJECTION_MAXIMUM_PAGE_SIZE,
  CODE_GRAPH_CHECKPOINT_GIT_PATHSPEC_BYTES_MAXIMUM,
  CodeGraphCheckpointProjectionError,
  codeGraphCheckpointCoverage,
  codeGraphCheckpointGitPathBatches,
  parseGitTreeEntries,
  type CodeGraphCheckpointProjectionRequest,
  type CodeGraphCheckpointProjectionSummary,
} from './authority.js';

export function projectCodeGraphCheckpointV1<E, R>(request: CodeGraphCheckpointProjectionRequest<E, R>) {
  return Effect.gen(function* () {
    const pageSize = yield* attemptProjection('Checkpoint projection request is invalid.', () => {
      validateProjectionIdentity(request.identity);
      return normalizePageSize(request.pageSize);
    });
    const store = yield* CodeGraphStore;
    yield* observeExactCleanRepository(request.identity, 'before');
    const selected = yield* store.readySnapshotById(request.databasePath, request.snapshotId);
    if (selected === undefined) {
      return yield* CodeGraphCheckpointProjectionError.make({
        message: `Ready snapshot ${request.snapshotId} was not found.`,
      });
    }
    yield* attemptProjection('Checkpoint source snapshot is invalid.', () =>
      validateSelectedSnapshot(selected, request.identity),
    );
    const lease = yield* store.acquireSnapshotLease(
      request.databasePath,
      selected.id,
      CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS,
    );
    const renewLease = Effect.sleep(CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_RENEWAL_INTERVAL_MILLISECONDS).pipe(
      Effect.andThen(
        store.renewSnapshotLease(request.databasePath, lease, CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS),
      ),
      Effect.forever,
    );
    const projection = store
      .withSession(request.databasePath, projectInReadTransaction(request, selected, pageSize), {readOnly: true})
      .pipe(Effect.tap(() => observeExactCleanRepository(request.identity, 'after')));
    return yield* Effect.raceFirst(projection, renewLease).pipe(
      Effect.ensuring(store.releaseSnapshotLease(request.databasePath, lease).pipe(Effect.ignore)),
    );
  });
}

/** A ready snapshot that file-fact projection cannot read until a full rebuild persists its shards. */
export interface CodeGraphCheckpointShardRebuild {
  readonly includeOpaqueCorpusAssets: boolean;
}

/**
 * Finds a snapshot file without the materialized shard that file-fact projection joins. Returns
 * undefined when every shard is present, or when projection rejects the snapshot for another reason.
 */
export function codeGraphCheckpointShardRebuild(databasePath: string, snapshotId: string) {
  return Effect.gen(function* () {
    const store = yield* CodeGraphStore;
    const rows = yield* store.withSession(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{readonly inventory_receipt_json: unknown; readonly missing: number}>(
          `SELECT receipt.inventory_receipt_json,
                  EXISTS (
                    SELECT 1 FROM snapshot_files AS file
                    WHERE file.snapshot_id = receipt.snapshot_id AND NOT EXISTS (
                      SELECT 1 FROM snapshot_file_shards AS association
                      JOIN materialized_file_shards AS shard ON shard.id = association.shard_id
                      WHERE association.snapshot_id = file.snapshot_id AND association.path = file.path
                    )
                  ) AS missing
           FROM snapshot_reuse_receipts AS receipt
           WHERE receipt.snapshot_id = ?`,
          [snapshotId],
        );
      }),
      {readOnly: true},
    );
    const row = rows[0];
    const inventory = decodeCodeGraphInventoryReuseReceipt(row?.inventory_receipt_json);
    if (row === undefined || Number(row.missing) === 0 || inventory === undefined) return undefined;
    return {includeOpaqueCorpusAssets: inventory.includeOpaqueCorpusAssets} satisfies CodeGraphCheckpointShardRebuild;
  });
}
