import {Clock, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {type CodeGraphRoutineMaintenanceResult} from './models.js';
import {pruneRetiredSnapshotRowsPage} from './view_cleanup.js';
import {
  pruneRoutineCacheRowsPage,
  resetRoutineCacheCleanupState,
  type RoutinePhysicalCleanupPage,
} from './maintenance_core.js';
import {
  initializeRoutineMaintenanceSchema,
  reapExpiredSnapshotLeasesPage,
  retireRoutineLeaseCandidates,
} from './leases.js';
import {drainCompletedPersistentBuildRowsPage} from './activation/core.js';
import {retireExcessReadySnapshotsPage} from '../snapshot/retention.js';

/** Fresh facts are written before the durable building snapshot owns its inventory. */

const pruneRoutinePhysicalRowsPage = Effect.fn('codeGraph.pruneRoutinePhysicalRowsPage')(function* (
  sql: SqlClient.SqlClient,
) {
  const retired = yield* pruneRetiredSnapshotRowsPage(sql);
  if (retired.deleted > 0 || retired.remaining) {
    if (retired.deleted > 0 && !retired.remaining) yield* resetRoutineCacheCleanupState(sql);
    return {
      cleanup: retired.deleted > 0 ? 'retired-snapshot' : 'none',
      deleted: retired.deleted,
      // Once the final snapshot-owned row disappears, one more page must
      // inspect caches whose last durable reference disappeared with it.
      remaining: retired.remaining || retired.deleted > 0,
    } satisfies RoutinePhysicalCleanupPage;
  }
  return yield* pruneRoutineCacheRowsPage(sql);
});

const runRoutineMaintenancePage = Effect.fn('codeGraph.runRoutineMaintenancePage')(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* initializeRoutineMaintenanceSchema(sql))) {
    return {reason: 'schema-unavailable', state: 'skipped'} as const;
  }
  const now = yield* Clock.currentTimeMillis;
  const leasePage = yield* sql.withTransaction(
    Effect.gen(function* () {
      const expired = yield* reapExpiredSnapshotLeasesPage(sql, now);
      const retiredSnapshots = yield* retireRoutineLeaseCandidates(sql, expired.candidates, now);
      return {...expired, retiredSnapshots};
    }),
  );
  // The expired-token batch is itself this tick's bounded page. Leave all
  // physical row reclamation for the next trigger so one tick never combines
  // independent cleanup pages behind a single writer-gate acquisition.
  if (leasePage.deleted > 0 || leasePage.remaining) {
    return {
      cleanup: 'none',
      expiredLeases: leasePage.deleted,
      remaining: true,
      retiredSnapshots: leasePage.retiredSnapshots,
      rowsDeleted: 0,
      state: 'completed',
    } satisfies CodeGraphRoutineMaintenanceResult;
  }
  // Index completion contributes exactly one foreground routine unit. Apply
  // the ready-snapshot policy before draining that build's small checkpoint
  // rows so a short-lived CLI enforces retention instead of exiting first.
  const retention = yield* sql.withTransaction(retireExcessReadySnapshotsPage(sql, now));
  if (retention.retired > 0) {
    return {
      cleanup: 'none',
      expiredLeases: leasePage.deleted,
      remaining: true,
      retiredSnapshots: leasePage.retiredSnapshots + retention.retired,
      rowsDeleted: 0,
      state: 'completed',
    } satisfies CodeGraphRoutineMaintenanceResult;
  }
  const completed = yield* drainCompletedPersistentBuildRowsPage(sql);
  if (completed.deleted > 0) {
    return {
      cleanup: 'completed-build',
      expiredLeases: leasePage.deleted,
      remaining: true,
      retiredSnapshots: leasePage.retiredSnapshots,
      rowsDeleted: completed.deleted,
      state: 'completed',
    } satisfies CodeGraphRoutineMaintenanceResult;
  }
  const physical = yield* pruneRoutinePhysicalRowsPage(sql);
  return {
    cleanup: physical.cleanup,
    expiredLeases: leasePage.deleted,
    remaining: leasePage.remaining || physical.remaining,
    retiredSnapshots: leasePage.retiredSnapshots,
    rowsDeleted: physical.deleted,
    state: 'completed',
  } satisfies CodeGraphRoutineMaintenanceResult;
});

export {pruneRoutinePhysicalRowsPage, runRoutineMaintenancePage};
