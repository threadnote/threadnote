import {Clock, DateTime, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  type CodeGraphViewSnapshotLeaseRetainOptions,
  type CodeGraphViewSnapshotLeaseRetainResult,
  type CodeGraphViewSnapshotLeaseValidationResult,
} from './models.js';
import {MAXIMUM_CANONICAL_DATE_MILLISECONDS, REMOVED_VIEWS_TABLE_SQL} from './removed/view_schema_contracts.js';
import {removedViewAuthorityTableState, removedViewCleanupRecordedRevision} from './removed/view_schema_inspection.js';
import {configureConnection, tableExists} from './session.js';
import {CodeGraphStoreError} from '../types.js';
import {
  codeGraphPersistentSchemaIsCurrentOrNewer,
  codeGraphPersistentSchemaMigrationPending,
  observeCodeGraphPersistentSchemaRevision,
} from './schema/revision.js';
import {
  boundedSnapshotLeaseProjection,
  type BoundedSnapshotLeaseRow,
  CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE,
  decodeSnapshotLeaseManifest,
  type RoutineExpiredLeasePage,
  routineMaintenanceColumnsAvailable,
  type SnapshotLeaseManifest,
} from './maintenance_core.js';
import {
  authorityPrimaryKeyBinary,
  CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES,
  CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX,
  codeGraphReconciliationIndexState,
  observeActiveView,
} from './reconciliation/core.js';
import {ensureSnapshotLeaseSchema} from './schema/core.js';
import {type PersistentBuildOwnerCandidate} from './internal_models.js';
import {codeGraphWorktreeReconciliationSchemaCompatible} from './reconciliation.js';
import {lastStatementChangeCount} from './activation/core.js';
import {codeGraphScopeAuthorityInstalled} from './scope/schema.js';
import {retireReadySnapshotsIfUnused} from './cleanup_core.js';
import {
  CODE_GRAPH_DETACHED_READY_COUNT_MAXIMUM,
  CODE_GRAPH_DETACHED_READY_ESTIMATED_BYTES_MAXIMUM,
  CODE_GRAPH_RETENTION_ESTIMATED_BYTES_MINIMUM,
  CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_EDGE,
  CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_SYMBOL,
} from '../snapshot/retention.js';

/** Fresh facts are written before the durable building snapshot owns its inventory. */

const initializeRoutineMaintenanceSchema = Effect.fn('codeGraph.initializeRoutineMaintenanceSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* configureConnection(sql);
  // Routine maintenance may repair the additive lease surface, but it must not
  // publish a partially initialized graph or run the replacement migrations
  // owned by an index/explicit repair session.
  if (!(yield* tableExists(sql, 'snapshots')) || !(yield* tableExists(sql, 'active_snapshots'))) return false;
  if (
    !(yield* routineMaintenanceColumnsAvailable(sql, 'snapshots', [
      'base_snapshot_id',
      'id',
      'state',
      'worktree_id',
    ])) ||
    !(yield* routineMaintenanceColumnsAvailable(sql, 'active_snapshots', ['snapshot_id', 'worktree_id']))
  ) {
    return false;
  }
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  if (revision.state === 'invalid') return false;
  const recordedRevision = revision.state === 'recorded' ? revision.value : undefined;
  if (observeCodeGraphPersistentSchemaRevision(recordedRevision).state === 'newer') return false;
  const removedViewAuthority = yield* removedViewAuthorityTableState(sql);
  if (removedViewAuthority === 'incompatible') return false;
  if (removedViewAuthority === 'absent' && recordedRevision !== undefined) {
    if (!codeGraphPersistentSchemaMigrationPending(recordedRevision)) return false;
    yield* sql.unsafe(REMOVED_VIEWS_TABLE_SQL);
    if ((yield* removedViewAuthorityTableState(sql)) !== 'compatible') return false;
  }
  if (
    (yield* tableExists(sql, 'snapshot_leases')) &&
    !(yield* routineMaintenanceColumnsAvailable(sql, 'snapshot_leases', ['expires_at', 'snapshot_id', 'token']))
  ) {
    return false;
  }
  const leaseTableExists = yield* tableExists(sql, 'snapshot_leases');
  const successorIndexState = leaseTableExists
    ? yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES[2])
    : ('missing' as const);
  if (
    successorIndexState === 'incompatible' ||
    (codeGraphPersistentSchemaIsCurrentOrNewer(recordedRevision) && successorIndexState !== 'ready')
  ) {
    return false;
  }
  let createExpiryIndex = !leaseTableExists;
  if (leaseTableExists) {
    const expiryIndexState = yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX);
    if (expiryIndexState === 'incompatible') return false;
    if (expiryIndexState === 'missing') {
      if (recordedRevision === undefined) {
        const rows = yield* sql.unsafe('SELECT 1 FROM snapshot_leases LIMIT 1');
        if (rows.length !== 0) return false;
      }
      createExpiryIndex = true;
    }
  }
  yield* ensureSnapshotLeaseSchema(sql);
  if (createExpiryIndex) {
    yield* sql.unsafe(CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX.definition);
  }
  if ((yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX)) !== 'ready') {
    return false;
  }
  return true;
});

const retireAbandonedPersistentBuild = Effect.fn('codeGraph.retireAbandonedPersistentBuild')(function* (
  candidate: PersistentBuildOwnerCandidate,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* initializeRoutineMaintenanceSchema(sql))) return 'changed' as const;
  const now = yield* Clock.currentTimeMillis;
  const completedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
  const retired = yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{readonly id: string}>`
        UPDATE snapshots
        SET state = 'retired',
            completed_at = COALESCE(completed_at, ${completedAt}),
            failure_summary = COALESCE(
              failure_summary,
              'Automatic maintenance retired a build whose exact owner process exited.'
            )
        WHERE id = ${candidate.snapshotId}
          AND worktree_id = ${candidate.worktreeId}
          AND state IN ('building', 'failed')
          AND EXISTS (
            SELECT 1
            FROM snapshot_build_owners AS owner
            JOIN snapshot_build_owner_instances AS instance ON instance.snapshot_id = owner.snapshot_id
            WHERE owner.snapshot_id = snapshots.id
              AND owner.owner_token = ${candidate.ownerToken}
              AND instance.owner_token = owner.owner_token
              AND instance.build_id = ${candidate.buildId}
              AND instance.process_id = ${candidate.processId}
              AND instance.process_start_identity IS ${candidate.processStartIdentity ?? null}
              AND instance.logical_snapshot_id = ${candidate.logicalSnapshotId}
          )
          AND NOT EXISTS (SELECT 1 FROM active_snapshots WHERE snapshot_id = snapshots.id)
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_leases WHERE snapshot_id = snapshots.id AND expires_at > ${now}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM snapshots AS dependent
            WHERE dependent.base_snapshot_id = snapshots.id AND dependent.state <> 'retired'
          )
        RETURNING id
      `;
      if (rows.length === 0) return false;
      yield* sql`
        DELETE FROM snapshot_build_owners
        WHERE snapshot_id = ${candidate.snapshotId} AND owner_token = ${candidate.ownerToken}
      `;
      return true;
    }),
  );
  if (retired) return 'retired' as const;
  const exact = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM snapshot_build_owners AS owner
    JOIN snapshot_build_owner_instances AS instance ON instance.snapshot_id = owner.snapshot_id
    JOIN snapshots AS snapshot ON snapshot.id = owner.snapshot_id
    WHERE owner.snapshot_id = ${candidate.snapshotId}
      AND owner.owner_token = ${candidate.ownerToken}
      AND instance.owner_token = owner.owner_token
      AND instance.build_id = ${candidate.buildId}
      AND instance.process_id = ${candidate.processId}
      AND instance.process_start_identity IS ${candidate.processStartIdentity ?? null}
      AND instance.logical_snapshot_id = ${candidate.logicalSnapshotId}
      AND snapshot.worktree_id = ${candidate.worktreeId}
      AND snapshot.state IN ('building', 'failed')
  `;
  return Number(exact[0]?.count ?? 0) === 1 ? ('protected' as const) : ('changed' as const);
});

const reapExpiredSnapshotLeasesPage = Effect.fn('codeGraph.reapExpiredSnapshotLeasesPage')(function* (
  sql: SqlClient.SqlClient,
  now: number,
) {
  if (!(yield* authorityPrimaryKeyBinary(sql, 'snapshot_leases', 'token'))) {
    return yield* CodeGraphStoreError.of('Code graph snapshot lease capability schema is invalid.');
  }
  if ((yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX)) !== 'ready') {
    return yield* CodeGraphStoreError.of('Code graph snapshot lease expiry index is invalid.');
  }
  const rows = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
    `SELECT ${boundedSnapshotLeaseProjection('lease')}
     FROM snapshot_leases AS lease
     WHERE lease.expires_at <= ?
     ORDER BY lease.expires_at
     LIMIT ?`,
    [now, CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE],
  );
  if (rows.length === 0) {
    return {candidates: [], deleted: 0, remaining: false} satisfies RoutineExpiredLeasePage;
  }
  const leases = rows.map(decodeSnapshotLeaseManifest);
  if (leases.some(lease => lease === undefined)) {
    return yield* CodeGraphStoreError.of('Code graph snapshot lease manifest is invalid.');
  }
  const decodedLeases: SnapshotLeaseManifest[] = [];
  for (const lease of leases) {
    if (lease !== undefined) decodedLeases.push(lease);
  }
  const retirementAuthorityCurrent = yield* codeGraphWorktreeReconciliationSchemaCompatible(sql);
  const successorIndexReady =
    (yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES[2])) === 'ready';
  const flaggedSnapshotIds = [
    ...new Set(decodedLeases.filter(lease => lease.retireWhenInactive === 1).map(lease => lease.snapshotId)),
  ];
  const candidates: string[] = [];
  const preservedTokens = new Set<string>();
  if (!successorIndexReady) {
    for (const lease of decodedLeases) {
      if (lease.retireWhenInactive === 1) preservedTokens.add(lease.token);
    }
  }
  for (const snapshotId of flaggedSnapshotIds) {
    if (!successorIndexReady) continue;
    const successorRows = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
      `SELECT ${boundedSnapshotLeaseProjection('lease')}
       FROM snapshot_leases AS lease
       WHERE lease.snapshot_id = ? AND lease.expires_at > ?
       ORDER BY lease.expires_at
       LIMIT 1`,
      [snapshotId, now],
    );
    const successor = successorRows[0] === undefined ? undefined : decodeSnapshotLeaseManifest(successorRows[0]);
    if (successorRows[0] !== undefined && successor === undefined) {
      return yield* CodeGraphStoreError.of('Code graph snapshot lease manifest is invalid.');
    }
    if (successor === undefined) {
      if (retirementAuthorityCurrent) {
        candidates.push(snapshotId);
      } else {
        const carrier = decodedLeases.find(lease => lease.snapshotId === snapshotId && lease.retireWhenInactive === 1);
        if (carrier !== undefined) preservedTokens.add(carrier.token);
      }
      continue;
    }
    yield* sql`
      UPDATE snapshot_leases
      SET retire_when_inactive = 1
      WHERE token = ${successor.token}
    `;
  }
  const tokens = decodedLeases.filter(lease => !preservedTokens.has(lease.token)).map(lease => lease.token);
  if (tokens.length > 0) {
    yield* sql`DELETE FROM snapshot_leases WHERE ${sql.in('token', tokens)}`;
  }
  return {
    candidates,
    deleted: tokens.length > 0 ? yield* lastStatementChangeCount(sql) : 0,
    // A full page is conservatively reported as remaining. The next ordinary
    // tick cheaply proves whether another page exists.
    remaining: preservedTokens.size > 0 || rows.length === CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE,
  } satisfies RoutineExpiredLeasePage;
});

const reapAndRetireExpiredSnapshotLeasesPage = Effect.fn('codeGraph.reapAndRetireExpiredSnapshotLeasesPage')(function* (
  sql: SqlClient.SqlClient,
  now: number,
) {
  const expired = yield* reapExpiredSnapshotLeasesPage(sql, now);
  return yield* retireRoutineLeaseCandidates(sql, expired.candidates, now);
});

const retireRoutineLeaseCandidates = Effect.fn('codeGraph.retireRoutineLeaseCandidates')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
  now: number,
) {
  const candidates = [...new Set(snapshotIds)].slice(0, CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE);
  if (candidates.length === 0) return 0;
  // Retire only the bounded lease targets. Their detached bases remain a safe
  // warm cache and can be reconsidered by ordinary pointer reconciliation.
  return yield* retireReadySnapshotsIfUnused(sql, candidates, now);
});

const acquireSnapshotLease = Effect.fn('codeGraph.acquireSnapshotLease')(function* (
  snapshotId: string,
  durationMilliseconds: number,
  token: string,
  retireWhenInactive: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false, false, false))) {
        return yield* CodeGraphStoreError.of('Code graph snapshot lease authority schema is invalid.');
      }
      const ready = yield* sql<{readonly id: string}>`
        SELECT id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
      `;
      if (!ready[0]) {
        return yield* CodeGraphStoreError.of(`Ready snapshot ${snapshotId} is no longer available.`);
      }
      if (token.startsWith('retained-base:')) {
        const targets = yield* sql<{
          readonly estimated_bytes: number;
          readonly physical_id: string;
          readonly repository_id: string;
          readonly worktree_id: string;
        }>`
          SELECT repository_id, worktree_id, COALESCE(base_snapshot_id, id) AS physical_id,
                 MAX(
                   ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_MINIMUM},
                   symbol_count * ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_SYMBOL} +
                     edge_count * ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_EDGE}
                 ) AS estimated_bytes
          FROM snapshots
          WHERE id = ${snapshotId} AND state = 'ready'
          LIMIT 1
        `;
        const target = targets[0];
        if (!target) {
          return yield* CodeGraphStoreError.of('Retained code graph base is no longer available.');
        }
        const retainedReservations = yield* sql<{
          readonly estimated_bytes: number;
          readonly physical_id: string;
          readonly repository_id: string;
          readonly worktree_id: string;
        }>`
          SELECT snapshot.repository_id, snapshot.worktree_id,
                 COALESCE(snapshot.base_snapshot_id, snapshot.id) AS physical_id,
                 MAX(
                   ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_MINIMUM},
                   snapshot.symbol_count * ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_SYMBOL} +
                     snapshot.edge_count * ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_EDGE}
                 ) AS estimated_bytes
          FROM snapshot_leases AS lease
          JOIN snapshots AS snapshot ON snapshot.id = lease.snapshot_id
          WHERE lease.token GLOB 'retained-base:*' AND lease.expires_at > ${now}
          GROUP BY snapshot.repository_id, snapshot.worktree_id, physical_id
        `;
        if (
          retainedReservations.some(
            row =>
              row.worktree_id === target.worktree_id &&
              row.repository_id === target.repository_id &&
              row.physical_id !== target.physical_id,
          )
        ) {
          return yield* CodeGraphStoreError.of('The worktree already has a retained committed code graph base.');
        }
        const detachedReady = yield* sql<{
          readonly estimated_bytes: number;
          readonly physical_id: string;
          readonly repository_id: string;
          readonly worktree_id: string;
        }>`
          SELECT snapshot.repository_id, snapshot.worktree_id,
                 COALESCE(snapshot.base_snapshot_id, snapshot.id) AS physical_id,
                 MAX(
                   MAX(
                     ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_MINIMUM},
                     snapshot.symbol_count * ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_SYMBOL} +
                       snapshot.edge_count * ${CODE_GRAPH_RETENTION_ESTIMATED_BYTES_PER_EDGE}
                   )
                 ) AS estimated_bytes
          FROM snapshots AS snapshot
          WHERE snapshot.repository_id = ${target.repository_id}
            AND snapshot.state = 'ready'
            AND snapshot.completed_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM active_snapshots AS active
              WHERE active.snapshot_id = snapshot.id
                AND NOT EXISTS (
                  SELECT 1 FROM removed_views AS removed
                  WHERE removed.worktree_id = active.worktree_id
                    AND removed.expected_snapshot_id = active.snapshot_id
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM snapshots AS child
              WHERE child.base_snapshot_id = snapshot.id
              LIMIT 1
            )
          GROUP BY snapshot.repository_id, physical_id
        `;
        const physical = new Map(
          [...detachedReady, ...retainedReservations]
            .filter(row => row.repository_id === target.repository_id)
            .map(row => [row.physical_id, row] as const),
        );
        if (!physical.has(target.physical_id)) physical.set(target.physical_id, target);
        const retainedBytes = [...physical.values()].reduce((total, row) => total + row.estimated_bytes, 0);
        if (
          physical.size > CODE_GRAPH_DETACHED_READY_COUNT_MAXIMUM ||
          retainedBytes > CODE_GRAPH_DETACHED_READY_ESTIMATED_BYTES_MAXIMUM
        ) {
          return yield* CodeGraphStoreError.of('Retained code graph bases would exceed detached-ready capacity.');
        }
      }
      yield* sql`
        INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
        VALUES (
          ${token}, ${snapshotId}, ${now + duration},
          -- Clean snapshots remain bounded warm-cache candidates after
          -- displacement. An explicit transient lease still opts into
          -- retirement independently of this dirty-view baton.
          CASE WHEN ${retireWhenInactive ? 1 : 0} = 1 OR EXISTS (
            SELECT 1
            FROM active_snapshots AS active
            JOIN snapshots AS snapshot
              ON snapshot.id = active.snapshot_id
             AND snapshot.dirty = 1
            WHERE active.snapshot_id = ${snapshotId}
              AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active.worktree_id
                  AND removed.expected_snapshot_id = active.snapshot_id
              )
          ) THEN 1 ELSE 0 END
        )
      `;
      // The new lease protects its target before expired readers are reaped.
      // This makes the next ordinary graph read self-heal snapshots left by a
      // crashed process without racing a caller that is reacquiring that view.
      yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
    }),
  );
  return token;
});

const retainViewSnapshotLease = Effect.fn('codeGraph.retainViewSnapshotLease')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  snapshotId: string,
  durationMilliseconds: number,
  candidateToken: string,
  options?: CodeGraphViewSnapshotLeaseRetainOptions,
) {
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  const minimumRemaining = Math.max(0, Math.min(duration, Math.floor(options?.minimumRemainingMilliseconds ?? 0)));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false, false))) {
        return yield* CodeGraphStoreError.of('Code graph snapshot lease authority schema is invalid.');
      }
      const observation = yield* observeActiveView(sql, worktreeId, snapshotId, options?.scopeId);
      yield* options?.afterViewObserved?.() ?? Effect.void;
      if (observation.state !== 'ready') {
        return {observation, state: 'view-unavailable'} satisfies CodeGraphViewSnapshotLeaseRetainResult;
      }

      if (options?.existingToken) {
        const existing = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
          `SELECT ${boundedSnapshotLeaseProjection('lease')}
           FROM snapshot_leases AS lease
           WHERE lease.token = ?
           LIMIT 1`,
          [options.existingToken],
        );
        const row = existing[0] === undefined ? undefined : decodeSnapshotLeaseManifest(existing[0]);
        if (existing[0] !== undefined && row === undefined) {
          return yield* CodeGraphStoreError.of('Code graph snapshot lease manifest is invalid.');
        }
        const expiresAt = row?.expiresAt ?? 0;
        if (row?.snapshotId === snapshotId && expiresAt > now) {
          if (expiresAt > now + minimumRemaining) {
            return {
              expiresAt,
              state: 'retained',
              token: row.token,
            } satisfies CodeGraphViewSnapshotLeaseRetainResult;
          }
          const renewedUntil = now + duration;
          yield* sql`
            UPDATE snapshot_leases
            SET expires_at = ${renewedUntil}, retire_when_inactive = 1
            WHERE token = ${row.token} AND snapshot_id = ${snapshotId} AND expires_at > ${now}
          `;
          if ((yield* lastStatementChangeCount(sql)) === 1) {
            yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
            return {
              expiresAt: renewedUntil,
              state: 'retained',
              token: row.token,
            } satisfies CodeGraphViewSnapshotLeaseRetainResult;
          }
        }
      }

      const expiresAt = now + duration;
      yield* sql`
        INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
        VALUES (${candidateToken}, ${snapshotId}, ${expiresAt}, 1)
      `;
      yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
      return {
        expiresAt,
        state: 'retained',
        token: candidateToken,
      } satisfies CodeGraphViewSnapshotLeaseRetainResult;
    }),
  );
});

/**
 * Read-only linearization point for Manager's writer-busy fallback. A cached
 * process token is reusable only while the exact active view and the exact
 * unexpired lease coexist in one SQLite snapshot and no exact tombstone does.
 */
const validateViewSnapshotLease = Effect.fn('codeGraph.validateViewSnapshotLease')(function* (
  worktreeId: string,
  snapshotId: string,
  token: string,
  minimumRemainingMilliseconds: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe('PRAGMA busy_timeout = 0');
  yield* sql.unsafe('PRAGMA query_only = ON');
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false, false))) {
        return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
      }
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{readonly expires_at: number}>`
        SELECT CASE
          WHEN typeof(lease.expires_at) = 'integer'
            AND lease.expires_at BETWEEN 0 AND ${MAXIMUM_CANONICAL_DATE_MILLISECONDS}
          THEN lease.expires_at ELSE NULL END AS expires_at
        FROM active_snapshots AS active
        JOIN snapshots AS snapshot
          ON snapshot.id = active.snapshot_id
         AND snapshot.state = 'ready'
        JOIN snapshot_leases AS lease
          ON lease.token = ${token}
         AND lease.snapshot_id = active.snapshot_id
        WHERE active.worktree_id = ${worktreeId}
          AND active.snapshot_id = ${snapshotId}
          ${sql.unsafe((yield* codeGraphScopeAuthorityInstalled(sql)) ? 'AND active.scope_id = snapshot.scope_id' : '')}
          AND lease.expires_at > ${now + minimumRemainingMilliseconds}
          AND NOT EXISTS (
            SELECT 1 FROM removed_views AS removed
            WHERE removed.worktree_id = active.worktree_id
              ${sql.unsafe((yield* codeGraphScopeAuthorityInstalled(sql)) ? 'AND removed.scope_id = active.scope_id' : '')}
              AND removed.expected_snapshot_id = active.snapshot_id
          )
        LIMIT 1
      `;
      const expiresAt = Number(rows[0]?.expires_at ?? 0);
      return Number.isSafeInteger(expiresAt) && expiresAt > now + minimumRemainingMilliseconds
        ? ({expiresAt, state: 'valid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult)
        : ({state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult);
    }),
  );
});

const releaseSnapshotLease = Effect.fn('codeGraph.releaseSnapshotLease')(function* (token: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false, false, false))) {
        return yield* CodeGraphStoreError.of('Code graph snapshot lease authority schema is invalid.');
      }
      const now = yield* Clock.currentTimeMillis;
      const releasedRows = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
        `SELECT ${boundedSnapshotLeaseProjection('lease')}
         FROM snapshot_leases AS lease
         WHERE lease.token = ?
         LIMIT 1`,
        [token],
      );
      const releasedCandidates: string[] = [];
      const row = releasedRows[0] === undefined ? undefined : decodeSnapshotLeaseManifest(releasedRows[0]);
      if (releasedRows[0] !== undefined && row === undefined) {
        return yield* CodeGraphStoreError.of('Code graph snapshot lease manifest is invalid.');
      }
      if (row?.retireWhenInactive === 1) {
        const successorRows = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
          `SELECT ${boundedSnapshotLeaseProjection('lease')}
           FROM snapshot_leases AS lease
           WHERE lease.snapshot_id = ?
             AND lease.token <> ?
             AND lease.expires_at > ?
           ORDER BY lease.expires_at
           LIMIT 1`,
          [row.snapshotId, token, now],
        );
        const successor = successorRows[0] === undefined ? undefined : decodeSnapshotLeaseManifest(successorRows[0]);
        if (successorRows[0] !== undefined && successor === undefined) {
          return yield* CodeGraphStoreError.of('Code graph snapshot lease manifest is invalid.');
        }
        if (successor === undefined) {
          // Ordinary readers and baton transfers do not retire this snapshot.
          // Observe full retirement authority only when its result is needed,
          // inside the same transaction and before admitting any retirement.
          if (yield* codeGraphWorktreeReconciliationSchemaCompatible(sql)) releasedCandidates.push(row.snapshotId);
        } else {
          yield* sql`
            UPDATE snapshot_leases
            SET retire_when_inactive = 1
            WHERE token = ${successor.token}
          `;
        }
      }
      if (row !== undefined) {
        yield* sql`
          DELETE FROM snapshot_leases
          WHERE token = ${token}
        `;
      }
      const releasedRetirements = yield* retireRoutineLeaseCandidates(sql, releasedCandidates, now);
      const expiredRetirements = yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
      return releasedRetirements + expiredRetirements > 0;
    }),
  );
});

const renewSnapshotLease = Effect.fn('codeGraph.renewSnapshotLease')(function* (
  token: string,
  durationMilliseconds: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false, false, false))) {
        return yield* CodeGraphStoreError.of('Code graph snapshot lease authority schema is invalid.');
      }
      const active = yield* sql<{readonly present: number}>`
        SELECT 1 AS present FROM snapshot_leases WHERE token = ${token} AND expires_at > ${now} LIMIT 1
      `;
      if (!active[0]) {
        return yield* CodeGraphStoreError.of('The code graph snapshot lease expired before renewal.');
      }
      yield* sql`
        UPDATE snapshot_leases SET expires_at = ${now + duration} WHERE token = ${token}
      `;
      yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
    }),
  );
});

export {
  retireRoutineLeaseCandidates,
  initializeRoutineMaintenanceSchema,
  reapExpiredSnapshotLeasesPage,
  reapAndRetireExpiredSnapshotLeasesPage,
  retireAbandonedPersistentBuild,
  acquireSnapshotLease,
  retainViewSnapshotLease,
  validateViewSnapshotLease,
  releaseSnapshotLease,
  renewSnapshotLease,
};
