import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {compareCodeUnits} from '../ordering.js';
import {retireReadySnapshotsIfUnused} from '../store/cleanup_core.js';
import {CODE_GRAPH_SNAPSHOT_ID, validCanonicalTimestamp} from '../store/reconciliation/core.js';
import {CodeGraphStoreError} from '../types.js';

export const CODE_GRAPH_DETACHED_READY_COUNT_MAXIMUM = 2;
export const CODE_GRAPH_DETACHED_READY_ESTIMATED_BYTES_MAXIMUM = 4 * 1_024 * 1_024 * 1_024;
export const CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_SYMBOL = 60 * 1_024;
export const CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_EDGE = 128;
export const CODE_GRAPH_RETENTION_ESTIMATED_BYTES_MINIMUM = 64 * 1_024 * 1_024;
export const CODE_GRAPH_RETENTION_RETIRE_PAGE_SIZE = 16;

export interface CodeGraphSnapshotRetentionCandidate {
  readonly commit: string;
  readonly completedAt: string;
  readonly edgeCount: number;
  readonly graphContentId?: string;
  readonly hasNewerEquivalent: boolean;
  readonly id: string;
  readonly repositoryId: string;
  readonly symbolCount: number;
}

export interface CodeGraphSnapshotRetentionSelection {
  readonly retire: readonly CodeGraphSnapshotRetentionCandidate[];
  readonly retain: readonly CodeGraphSnapshotRetentionCandidate[];
}

/**
 * Deterministic warm-cache policy. Authority-protected snapshots never enter
 * this selector; among detached candidates it keeps the newest bounded set,
 * coalesces graph-equivalent SHAs, and applies both count and measured-baseline
 * byte estimates without making physical-allocation claims.
 */
export function selectCodeGraphSnapshotRetention(
  candidates: readonly CodeGraphSnapshotRetentionCandidate[],
): CodeGraphSnapshotRetentionSelection {
  const ordered = [...candidates].sort(
    (left, right) =>
      compareCodeUnits(left.repositoryId, right.repositoryId) ||
      compareCodeUnits(right.completedAt, left.completedAt) ||
      compareCodeUnits(right.id, left.id),
  );
  const retain: CodeGraphSnapshotRetentionCandidate[] = [];
  const retire: CodeGraphSnapshotRetentionCandidate[] = [];
  let repositoryId: string | undefined;
  let retainedBytes = 0;
  let retainedCount = 0;
  let equivalent = new Set<string>();
  for (const candidate of ordered) {
    if (candidate.repositoryId !== repositoryId) {
      repositoryId = candidate.repositoryId;
      retainedBytes = 0;
      retainedCount = 0;
      equivalent = new Set<string>();
    }
    const equivalenceKey = `${candidate.commit}\0${candidate.graphContentId ?? candidate.id}`;
    const duplicate = candidate.hasNewerEquivalent || equivalent.has(equivalenceKey);
    equivalent.add(equivalenceKey);
    const estimatedBytes = estimatedCodeGraphSnapshotRetentionBytes(candidate);
    const exceedsBytes =
      retainedCount > 0 && retainedBytes > CODE_GRAPH_DETACHED_READY_ESTIMATED_BYTES_MAXIMUM - estimatedBytes;
    if (duplicate || retainedCount >= CODE_GRAPH_DETACHED_READY_COUNT_MAXIMUM || exceedsBytes) {
      retire.push(candidate);
      continue;
    }
    retain.push(candidate);
    retainedCount += 1;
    retainedBytes += estimatedBytes;
  }
  return {retain, retire};
}

export function estimatedCodeGraphSnapshotRetentionBytes(
  snapshot: Pick<CodeGraphSnapshotRetentionCandidate, 'edgeCount' | 'symbolCount'>,
): number {
  if (
    !Number.isSafeInteger(snapshot.symbolCount) ||
    snapshot.symbolCount < 0 ||
    !Number.isSafeInteger(snapshot.edgeCount) ||
    snapshot.edgeCount < 0
  ) {
    throw new Error('Code graph snapshot retention counts are invalid.');
  }
  const estimate =
    snapshot.symbolCount * CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_SYMBOL +
    snapshot.edgeCount * CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_EDGE;
  return Math.max(CODE_GRAPH_RETENTION_ESTIMATED_BYTES_MINIMUM, Math.min(Number.MAX_SAFE_INTEGER, estimate));
}

interface RawSnapshotRetentionCandidate {
  readonly commit_id: unknown;
  readonly completed_at: unknown;
  readonly edge_count: unknown;
  readonly graph_content_id: unknown;
  readonly has_newer_equivalent: unknown;
  readonly id: unknown;
  readonly repository_id: unknown;
  readonly symbol_count: unknown;
}

export const retireExcessReadySnapshotsPage = Effect.fn('codeGraph.retireExcessReadySnapshotsPage')(function* (
  sql: SqlClient.SqlClient,
  now: number,
) {
  if (!(yield* snapshotRetentionSchemaCurrent(sql))) return {remaining: false, retired: 0};
  const limit = CODE_GRAPH_DETACHED_READY_COUNT_MAXIMUM + CODE_GRAPH_RETENTION_RETIRE_PAGE_SIZE;
  const rows = yield* sql.unsafe<RawSnapshotRetentionCandidate>(
    `WITH eligible AS (
       SELECT candidate.id, candidate.repository_id, candidate.commit_id,
              candidate.graph_content_id, candidate.symbol_count, candidate.edge_count,
              candidate.completed_at,
              EXISTS (
                SELECT 1 FROM snapshots AS newer
                WHERE newer.repository_id = candidate.repository_id
                  AND newer.state = 'ready'
                  AND newer.commit_id = candidate.commit_id
                  AND COALESCE(newer.graph_content_id, newer.id) =
                      COALESCE(candidate.graph_content_id, candidate.id)
                  AND (newer.completed_at > candidate.completed_at OR
                       (newer.completed_at = candidate.completed_at AND newer.id > candidate.id))
              ) AS has_newer_equivalent,
              MAX(
                ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_MINIMUM},
                candidate.symbol_count * ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_SYMBOL} +
                  candidate.edge_count * ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_EDGE}
              ) AS estimated_bytes
         FROM snapshots AS candidate
        WHERE candidate.state = 'ready'
          AND candidate.completed_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM active_snapshots AS active
            WHERE active.snapshot_id = candidate.id
              AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active.worktree_id
                  AND removed.expected_snapshot_id = active.snapshot_id
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_leases AS lease
            WHERE lease.snapshot_id = candidate.id AND lease.expires_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshots AS child INDEXED BY snapshots_base_state_id
            WHERE child.base_snapshot_id = candidate.id
            LIMIT 1
          )
     ), target_repository AS (
       SELECT repository_id
         FROM eligible
        GROUP BY repository_id
       HAVING COUNT(*) > ${CODE_GRAPH_DETACHED_READY_COUNT_MAXIMUM}
          OR SUM(has_newer_equivalent) > 0
          OR (COUNT(*) > 1 AND SUM(estimated_bytes) > ${CODE_GRAPH_DETACHED_READY_ESTIMATED_BYTES_MAXIMUM})
        ORDER BY repository_id
        LIMIT 1
     )
     SELECT candidate.id, candidate.repository_id, candidate.commit_id,
            candidate.graph_content_id, candidate.symbol_count, candidate.edge_count,
            candidate.completed_at, candidate.has_newer_equivalent
       FROM eligible AS candidate
       JOIN target_repository AS target USING (repository_id)
      ORDER BY candidate.repository_id, candidate.completed_at DESC, candidate.id DESC
      LIMIT ?`,
    [now, limit],
  );
  const candidates = rows.flatMap(row => {
    const decoded = decodeSnapshotRetentionCandidate(row);
    return decoded === undefined ? [] : [decoded];
  });
  const selection = selectCodeGraphSnapshotRetention(candidates);
  const retire = selection.retire.slice(0, CODE_GRAPH_RETENTION_RETIRE_PAGE_SIZE);
  const retired = yield* retireReadySnapshotsIfUnused(
    sql,
    retire.map(candidate => candidate.id),
    now,
  );
  if (retired !== retire.length) {
    return yield* CodeGraphStoreError.of('Code graph snapshot retention authority changed.');
  }
  return {remaining: retire.length === CODE_GRAPH_RETENTION_RETIRE_PAGE_SIZE, retired};
});

function decodeSnapshotRetentionCandidate(
  row: RawSnapshotRetentionCandidate,
): CodeGraphSnapshotRetentionCandidate | undefined {
  if (
    typeof row.id !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(row.id) ||
    typeof row.repository_id !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(row.repository_id) ||
    typeof row.commit_id !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(row.commit_id) ||
    (row.graph_content_id !== null &&
      (typeof row.graph_content_id !== 'string' ||
        row.graph_content_id.length > 128 ||
        row.graph_content_id.includes('\0'))) ||
    typeof row.completed_at !== 'string' ||
    !validCanonicalTimestamp(row.completed_at) ||
    typeof row.symbol_count !== 'number' ||
    !Number.isSafeInteger(row.symbol_count) ||
    row.symbol_count < 0 ||
    typeof row.edge_count !== 'number' ||
    !Number.isSafeInteger(row.edge_count) ||
    row.edge_count < 0 ||
    (row.has_newer_equivalent !== 0 && row.has_newer_equivalent !== 1)
  ) {
    return undefined;
  }
  return {
    commit: row.commit_id,
    completedAt: row.completed_at,
    edgeCount: row.edge_count,
    ...(row.graph_content_id === null ? {} : {graphContentId: row.graph_content_id}),
    hasNewerEquivalent: row.has_newer_equivalent === 1,
    id: row.id,
    repositoryId: row.repository_id,
    symbolCount: row.symbol_count,
  };
}

const snapshotRetentionSchemaCurrent = Effect.fn('codeGraph.snapshotRetentionSchemaCurrent')(function* (
  sql: SqlClient.SqlClient,
) {
  const required = {
    active_snapshots: ['snapshot_id', 'worktree_id'],
    removed_views: ['expected_snapshot_id', 'worktree_id'],
    snapshot_leases: ['expires_at', 'snapshot_id'],
    snapshots: [
      'base_snapshot_id',
      'commit_id',
      'completed_at',
      'edge_count',
      'graph_content_id',
      'id',
      'repository_id',
      'state',
      'symbol_count',
    ],
  } as const;
  for (const [table, columns] of Object.entries(required)) {
    const rows = yield* sql.unsafe<{readonly name: unknown}>('SELECT name FROM pragma_table_info(?) LIMIT 64', [table]);
    const names = new Set(rows.flatMap(row => (typeof row.name === 'string' ? [row.name] : [])));
    if (columns.some(column => !names.has(column))) return false;
  }
  const indexes = yield* sql.unsafe<{readonly name: unknown; readonly type: unknown}>(
    `SELECT name, type FROM sqlite_schema
     WHERE name IN ('snapshots_base_state_id', 'snapshot_leases_snapshot_expiry')`,
  );
  return (
    indexes.length === 2 &&
    indexes.every(row => typeof row.name === 'string' && row.type === 'index') &&
    new Set(indexes.map(row => row.name)).size === 2
  );
});
