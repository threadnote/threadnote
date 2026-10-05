import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {type CodeGraphActiveViewFence, type CodeGraphActiveViewIdentity} from './models.js';
import {CODE_GRAPH_SNAPSHOT_ID, validCanonicalTimestamp} from './reconciliation/core.js';
import {MAXIMUM_CANONICAL_DATE_MILLISECONDS} from './removed/view_schema_contracts.js';
import {configureConnection, tableExists} from './session.js';
import {CodeGraphStoreError} from '../types.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';
import {codeGraphScopeAuthorityInstalled} from './scope/schema.js';

const ACTIVE_VIEW_IDENTITY_LIMIT_MAXIMUM = 64;

/** Advance a canonical wall-clock candidate past every durable view generation. */
export function nextCodeGraphActiveViewActivationTimestamp(
  candidate: string,
  previous: readonly (string | undefined)[],
): string | undefined {
  if (!validCanonicalTimestamp(candidate)) return undefined;
  let nextMilliseconds = Date.parse(candidate);
  for (const value of previous) {
    if (value === undefined) continue;
    if (!validCanonicalTimestamp(value)) return undefined;
    nextMilliseconds = Math.max(nextMilliseconds, Date.parse(value) + 1);
  }
  if (nextMilliseconds > MAXIMUM_CANONICAL_DATE_MILLISECONDS) return undefined;
  return new Date(nextMilliseconds).toISOString();
}

/** Cheap bounded pointer read for Manager's cross-process catalog revision. */
export const selectActiveViewIdentities = Effect.fn('codeGraph.selectActiveViewIdentities')(function* (limit: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(ACTIVE_VIEW_IDENTITY_LIMIT_MAXIMUM, limit))
    : ACTIVE_VIEW_IDENTITY_LIMIT_MAXIMUM;
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const scoped = yield* codeGraphScopeAuthorityInstalled(sql);
  const rows = yield* sql.unsafe<{
    readonly activated_at: string | null;
    readonly repository_id: string;
    readonly snapshot_id: string;
    readonly worktree_id: string;
    readonly scope_id?: string;
  }>(
    `SELECT active_snapshots.activated_at, active_snapshots.snapshot_id,
       active_snapshots.worktree_id, snapshots.repository_id ${scoped ? ', active_snapshots.scope_id' : ''}
     FROM active_snapshots
     JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
     WHERE snapshots.state = 'ready'
       ${
         removedViewsAvailable
           ? `AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active_snapshots.worktree_id
                  ${scoped ? 'AND removed.scope_id = active_snapshots.scope_id' : ''}
                  AND removed.expected_snapshot_id = active_snapshots.snapshot_id
              )`
           : ''
       }
     ORDER BY active_snapshots.activated_at DESC, active_snapshots.worktree_id ${scoped ? ', active_snapshots.scope_id' : ''}
     LIMIT ?`,
    [boundedLimit],
  );
  return rows.map(
    row =>
      ({
        ...(typeof row.activated_at === 'string' ? {activatedAt: row.activated_at} : {}),
        repositoryId: row.repository_id,
        snapshotId: row.snapshot_id,
        worktreeId: row.worktree_id,
        ...(row.scope_id !== undefined && row.scope_id !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY
          ? {scopeId: row.scope_id}
          : {}),
      }) satisfies CodeGraphActiveViewIdentity,
  );
});

/** Read one exact active-pointer generation without opening another database session. */
export const selectActiveViewFence = Effect.fn('codeGraph.selectActiveViewFence')(function* (
  worktreeId: string,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  if (!/^[0-9a-f]{64}$/u.test(worktreeId)) {
    return yield* CodeGraphStoreError.of('Code graph worktree identity is invalid.');
  }
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const scoped = yield* codeGraphScopeAuthorityInstalled(sql);
  if (!scoped && scopeId !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) return undefined;
  const rows = yield* sql.unsafe<{
    readonly activated_at: unknown;
    readonly snapshot_id: unknown;
  }>(
    `SELECT activated_at, snapshot_id
     FROM active_snapshots
     WHERE worktree_id = ? ${scoped ? 'AND scope_id = ?' : ''}
     LIMIT 2`,
    scoped ? [worktreeId, scopeId] : [worktreeId],
  );
  if (rows.length === 0) return undefined;
  const activatedAt = rows[0]?.activated_at;
  const snapshotId = rows[0]?.snapshot_id;
  if (
    rows.length !== 1 ||
    typeof activatedAt !== 'string' ||
    !validCanonicalTimestamp(activatedAt) ||
    typeof snapshotId !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(snapshotId)
  ) {
    return yield* CodeGraphStoreError.of('Code graph active view authority is invalid.');
  }
  return {
    activatedAt,
    snapshotId,
    worktreeId,
    ...(scopeId === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY ? {} : {scopeId}),
  } satisfies CodeGraphActiveViewFence;
});
