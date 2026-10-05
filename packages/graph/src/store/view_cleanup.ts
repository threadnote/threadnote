import {Clock, DateTime, Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  type CodeGraphRemovedViewCleanupEvidence,
  type CodeGraphSnapshotPurgeStoreResult,
  type CodeGraphViewRemovalResult,
} from './models.js';
import {tableExists} from './session.js';
import {CodeGraphStoreError} from '../types.js';
import {
  COMPACT_LEXICAL_CLEANUP_SPECS,
  compactLexicalCleanupPageStatement,
  observeSnapshotPurge,
  RETIRED_SNAPSHOT_CLEANUP_SPECS,
  type RetiredSnapshotCleanupPage,
  retireReadySnapshotsIfUnused,
} from './cleanup_core.js';
import {lastStatementChangeCount} from './activation/core.js';
import {
  CODE_GRAPH_SNAPSHOT_ID,
  validateRemovedViewSnapshotAuthority,
  validateViewRemovalTarget,
  validCanonicalTimestamp,
  validRemovedViewCleanupEvidence,
} from './reconciliation/core.js';
import {codeGraphWorktreeReconciliationSchemaCompatible, ensureRemovedViewCleanupEpoch} from './reconciliation.js';
import {type CompactLexicalSnapshotKeyRow, validatedCompactLexicalCount} from './build/core.js';
import {nextCodeGraphActiveViewActivationTimestamp} from './active_views.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';

/** @internal Bounded keyset page retained for admission query-plan and load regressions. */

/** @internal Indexed due page retained for query-plan and crash-fairness regressions. */

const purgeSelectedSnapshot = Effect.fn('codeGraph.purgeSelectedSnapshot')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  expectedGraphEvidenceDigest: string,
  nowMilliseconds: number,
) {
  const core = yield* sql.withTransaction(
    Effect.gen(function* () {
      const observed = yield* observeSnapshotPurge(sql, snapshotId, nowMilliseconds);
      if (observed.state === 'not-found') return observed satisfies CodeGraphSnapshotPurgeStoreResult;
      if (observed.evidence.graphEvidenceDigest !== expectedGraphEvidenceDigest) {
        return {
          evidence: observed.evidence,
          snapshotId,
          state: 'state-changed',
        } satisfies CodeGraphSnapshotPurgeStoreResult;
      }
      if (observed.evidence.blockers.length > 0) {
        return {
          evidence: observed.evidence,
          snapshotId,
          state: 'blocked',
        } satisfies CodeGraphSnapshotPurgeStoreResult;
      }
      if (observed.evidence.snapshot.state === 'ready') {
        yield* sql.unsafe("UPDATE snapshots SET state = 'retired' WHERE id = ? AND state = 'ready'", [snapshotId]);
        if ((yield* lastStatementChangeCount(sql)) !== 1) {
          return yield* CodeGraphStoreError.of('Code graph snapshot purge target changed.');
        }
      }
      return {state: 'retired-core' as const};
    }),
  );
  if (core.state !== 'retired-core') return core;
  const cleanup = yield* pruneRetiredSnapshotRowsPage(sql, snapshotId).pipe(
    Effect.map(page => ({cleanupState: 'completed' as const, ...page})),
    Effect.orElseSucceed(
      () =>
        ({cleanupState: 'deferred' as const, deleted: 0, remaining: true}) satisfies {
          readonly cleanupState: 'deferred';
          readonly deleted: number;
          readonly remaining: boolean;
        },
    ),
  );
  const present = yield* sql.unsafe<{readonly present: unknown}>(
    'SELECT EXISTS(SELECT 1 FROM snapshots WHERE id = ? LIMIT 1) AS present',
    [snapshotId],
  );
  if (present.length !== 1 || (present[0]?.present !== 0 && present[0]?.present !== 1)) {
    return yield* CodeGraphStoreError.of('Code graph snapshot purge completion is invalid.');
  }
  return {
    cleanupState: cleanup.cleanupState,
    remaining: cleanup.remaining,
    rowsDeleted: cleanup.deleted,
    snapshotId,
    state: present[0].present === 0 ? 'purged' : 'retired',
  } satisfies CodeGraphSnapshotPurgeStoreResult;
});

const removeActiveView = Effect.fn('codeGraph.removeActiveView')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  expectedSnapshotId: string,
  requireReconciliationSchema = false,
  cleanupEvidence?: CodeGraphRemovedViewCleanupEvidence,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  yield* validateViewRemovalTarget(worktreeId, expectedSnapshotId);
  if (cleanupEvidence !== undefined && !validRemovedViewCleanupEvidence(cleanupEvidence)) {
    return yield* CodeGraphStoreError.of('Code graph removed view cleanup evidence is invalid.');
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* CodeGraphStoreError.of(
          requireReconciliationSchema
            ? 'Code graph reconciliation schema is unavailable.'
            : 'Code graph removal authority schema is unavailable.',
        );
      }
      const active = yield* sql.unsafe<{readonly activated_at: unknown; readonly snapshot_id: unknown}>(
        `SELECT CASE
           WHEN typeof(snapshot_id) = 'text' AND length(CAST(snapshot_id AS BLOB)) BETWEEN 45 AND 67
           THEN snapshot_id ELSE NULL END AS snapshot_id,
           CASE WHEN typeof(activated_at) = 'text' AND length(CAST(activated_at AS BLOB)) = 24
             THEN activated_at ELSE NULL END AS activated_at
         FROM active_snapshots WHERE worktree_id = ? AND scope_id = ? LIMIT 2`,
        [worktreeId, scopeId],
      );
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
        [worktreeId, scopeId],
      );
      const activeSnapshotId = active[0]?.snapshot_id;
      const activeActivatedAt = active[0]?.activated_at;
      const removedSnapshotId = removed[0]?.expected_snapshot_id;
      const removedAtValue = removed[0]?.removed_at;

      if (
        active.length > 1 ||
        (activeSnapshotId !== undefined &&
          (typeof activeSnapshotId !== 'string' ||
            !CODE_GRAPH_SNAPSHOT_ID.test(activeSnapshotId) ||
            typeof activeActivatedAt !== 'string' ||
            !validCanonicalTimestamp(activeActivatedAt))) ||
        removed.length > 1 ||
        (removedSnapshotId !== undefined &&
          (typeof removedSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(removedSnapshotId))) ||
        (removedAtValue !== undefined &&
          (typeof removedAtValue !== 'string' || !validCanonicalTimestamp(removedAtValue)))
      ) {
        return yield* CodeGraphStoreError.of('Code graph removed view authority is invalid.');
      }

      if (activeSnapshotId !== undefined && activeSnapshotId !== expectedSnapshotId) {
        return {
          expectedSnapshotId,
          observedSnapshotId: activeSnapshotId,
          observedState: 'active',
          state: 'stale-target',
        } satisfies CodeGraphViewRemovalResult;
      }
      if (activeSnapshotId === undefined) {
        if (removedSnapshotId === expectedSnapshotId) {
          if (typeof removedAtValue !== 'string') {
            return yield* CodeGraphStoreError.of('Code graph removed view authority is invalid.');
          }
          yield* validateRemovedViewSnapshotAuthority(sql, expectedSnapshotId, false);
          yield* ensureRemovedViewCleanupEpoch(
            sql,
            worktreeId,
            expectedSnapshotId,
            removedAtValue,
            false,
            cleanupEvidence,
            requireReconciliationSchema,
            scopeId,
          );
          return {
            expectedSnapshotId,
            retiredSnapshots: 0,
            state: 'already-removed',
          } satisfies CodeGraphViewRemovalResult;
        }
        if (removedSnapshotId !== undefined) {
          return {
            expectedSnapshotId,
            observedSnapshotId: removedSnapshotId,
            observedState: 'removed',
            state: 'stale-target',
          } satisfies CodeGraphViewRemovalResult;
        }
        return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewRemovalResult;
      }

      const alreadyRemoved = removedSnapshotId === expectedSnapshotId;
      if (alreadyRemoved && typeof removedAtValue !== 'string') {
        return yield* CodeGraphStoreError.of('Code graph removed view authority is invalid.');
      }
      yield* validateRemovedViewSnapshotAuthority(
        sql,
        expectedSnapshotId,
        true,
        alreadyRemoved ? undefined : cleanupEvidence,
      );
      const removedAt = nextCodeGraphActiveViewActivationTimestamp(DateTime.formatIso(yield* DateTime.now), [
        typeof activeActivatedAt === 'string' ? activeActivatedAt : undefined,
        typeof removedAtValue === 'string' ? removedAtValue : undefined,
      ]);
      if (removedAt === undefined) {
        return yield* CodeGraphStoreError.of('Code graph removed view generation is invalid.');
      }
      yield* sql`
        INSERT INTO removed_views (worktree_id, scope_id, expected_snapshot_id, removed_at)
        VALUES (${worktreeId}, ${scopeId}, ${expectedSnapshotId}, ${removedAt})
        ON CONFLICT(worktree_id, scope_id) DO UPDATE SET
          expected_snapshot_id = excluded.expected_snapshot_id,
          removed_at = excluded.removed_at
      `;
      yield* sql`
        DELETE FROM active_snapshots
        WHERE worktree_id = ${worktreeId} AND scope_id = ${scopeId} AND snapshot_id = ${expectedSnapshotId}
      `;
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* CodeGraphStoreError.of('Code graph view pointer changed during removal.');
      }
      yield* sql`DELETE FROM scope_applicability WHERE worktree_id = ${worktreeId} AND scope_id = ${scopeId}
        AND active_snapshot_id = ${expectedSnapshotId}`;
      yield* ensureRemovedViewCleanupEpoch(
        sql,
        worktreeId,
        expectedSnapshotId,
        removedAt,
        !alreadyRemoved,
        cleanupEvidence,
        requireReconciliationSchema,
        scopeId,
      );
      const retiredSnapshots = yield* Clock.currentTimeMillis.pipe(
        Effect.flatMap(now => retireReadySnapshotsIfUnused(sql, [expectedSnapshotId], now)),
      );
      return {
        expectedSnapshotId,
        retiredSnapshots,
        state: alreadyRemoved ? 'already-removed' : 'removed',
      } satisfies CodeGraphViewRemovalResult;
    }),
  );
});

/** @internal Target-rooted exact retirement retained for deterministic query-plan regressions. */

/** @internal Exact indexed cleanup statement retained for query-plan regression tests. */

/**
 * Reclaim at most one bounded table page. Lease acquisition and a release that
 * actually retires a snapshot use this foreground step, while pointer promotion
 * schedules the same state machine as a best-effort detached collector. Query
 * completion therefore never cascades a repository-sized snapshot delete,
 * while repeated ordinary use still makes durable progress if a short-lived CLI
 * interrupts the detached fiber.
 */
const pruneRetiredSnapshotRowsPage = Effect.fn('codeGraph.pruneRetiredSnapshotRowsPage')(function* (
  providedSql?: SqlClient.SqlClient,
  snapshotId?: string,
) {
  const sql = providedSql ?? (yield* SqlClient.SqlClient);
  const targetSnapshotId = snapshotId ?? null;
  const pending = yield* sql.unsafe<{readonly present: number}>(
    `SELECT EXISTS(
       SELECT 1 FROM snapshots
       WHERE state = 'retired' AND (? IS NULL OR id = ?)
       LIMIT 1
     ) AS present`,
    [targetSnapshotId, targetSnapshotId],
  );
  if (Number(pending[0]?.present ?? 0) === 0) {
    return {deleted: 0, remaining: false} satisfies RetiredSnapshotCleanupPage;
  }

  const compactSchemaAvailable =
    (yield* tableExists(sql, 'lexical_compact_snapshots')) && (yield* tableExists(sql, 'lexical_storage_formats'));
  const compactTargets = compactSchemaAvailable
    ? yield* sql.unsafe<CompactLexicalSnapshotKeyRow & {readonly snapshot_id: string}>(
        `
        SELECT compact.snapshot_key, compact.snapshot_id
        FROM lexical_compact_snapshots AS compact
        JOIN snapshots AS snapshot ON snapshot.id = compact.snapshot_id
        WHERE snapshot.state = 'retired' AND (? IS NULL OR snapshot.id = ?)
        ORDER BY compact.snapshot_id
        LIMIT 1
        `,
        [targetSnapshotId, targetSnapshotId],
      )
    : [];
  const compactTarget = compactTargets[0];
  if (compactTarget !== undefined) {
    const compactSnapshotKey = yield* validatedCompactLexicalCount(compactTarget.snapshot_key, 'cleanup snapshot key');
    for (const spec of COMPACT_LEXICAL_CLEANUP_SPECS) {
      if (!(yield* tableExists(sql, spec.table))) continue;
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const statement = compactLexicalCleanupPageStatement(
            spec,
            compactSnapshotKey,
            spec.batchRows,
            Option.some(compactTarget.snapshot_id),
          );
          yield* sql.unsafe(statement.text, statement.parameters);
          return yield* lastStatementChangeCount(sql);
        }),
      );
      if (!Number.isSafeInteger(deleted) || deleted < 0) {
        return yield* CodeGraphStoreError.of('Retired snapshot cleanup returned an invalid row count.');
      }
      if (deleted > 0) return {deleted, remaining: true} satisfies RetiredSnapshotCleanupPage;
    }
    const metadataDeleted = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `DELETE FROM lexical_storage_formats
           WHERE snapshot_id = ?
             AND EXISTS (SELECT 1 FROM snapshots WHERE id = ? AND state = 'retired')`,
          [compactTarget.snapshot_id, compactTarget.snapshot_id],
        );
        const formatRows = yield* lastStatementChangeCount(sql);
        yield* sql.unsafe(
          `DELETE FROM lexical_compact_snapshots
           WHERE snapshot_key = ? AND snapshot_id = ?
             AND EXISTS (SELECT 1 FROM snapshots WHERE id = ? AND state = 'retired')`,
          [compactSnapshotKey, compactTarget.snapshot_id, compactTarget.snapshot_id],
        );
        return formatRows + (yield* lastStatementChangeCount(sql));
      }),
    );
    if (metadataDeleted > 0) {
      return {deleted: metadataDeleted, remaining: true} satisfies RetiredSnapshotCleanupPage;
    }
  }

  for (const spec of RETIRED_SNAPSHOT_CLEANUP_SPECS) {
    if (!(yield* tableExists(sql, spec.table))) continue;
    const deleted = yield* sql.withTransaction(
      Effect.gen(function* () {
        const key = `(${spec.keyColumns.join(', ')})`;
        yield* sql.unsafe(
          `DELETE FROM ${spec.table}
           WHERE ${key} IN (
             SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
             FROM ${spec.table} AS candidate
             WHERE candidate.snapshot_id IN (
               SELECT id FROM snapshots
               WHERE state = 'retired' AND (? IS NULL OR id = ?)
             )
             ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
             LIMIT ?
           )`,
          [targetSnapshotId, targetSnapshotId, spec.batchRows],
        );
        return yield* lastStatementChangeCount(sql);
      }),
    );
    if (!Number.isSafeInteger(deleted) || deleted < 0) {
      return yield* CodeGraphStoreError.of('Retired snapshot cleanup returned an invalid row count.');
    }
    if (deleted > 0) return {deleted, remaining: true} satisfies RetiredSnapshotCleanupPage;
  }

  const removed = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `DELETE FROM snapshots WHERE id IN (
           SELECT id FROM snapshots
           WHERE state = 'retired' AND (? IS NULL OR id = ?)
           ORDER BY id LIMIT 100
         )`,
        [targetSnapshotId, targetSnapshotId],
      );
      return yield* lastStatementChangeCount(sql);
    }),
  );
  if (!Number.isSafeInteger(removed) || removed < 0) {
    return yield* CodeGraphStoreError.of('Retired snapshot cleanup returned an invalid count.');
  }
  const remaining = yield* sql.unsafe<{readonly present: number}>(
    `SELECT EXISTS(
       SELECT 1 FROM snapshots
       WHERE state = 'retired' AND (? IS NULL OR id = ?)
       LIMIT 1
     ) AS present`,
    [targetSnapshotId, targetSnapshotId],
  );
  return {
    deleted: removed,
    remaining: Number(remaining[0]?.present ?? 0) !== 0,
  } satisfies RetiredSnapshotCleanupPage;
});

export {pruneRetiredSnapshotRowsPage, purgeSelectedSnapshot, removeActiveView};
