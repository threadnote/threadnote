import {Crypto, Effect, FileSystem, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {type CodeGraphBuildOwnerLiveness} from '../../build/owner.js';
import {corroborateCodeGraphBuildOwnerStatus} from '../../build_status.js';
import {codeGraphMaintenanceIntentActive} from '../../maintenance/gate.js';
import {codeGraphLayout, codeGraphSnapshotBuildLockPath} from '../../layout.js';
import {
  CODE_GRAPH_ABANDONED_BUILD_LOCK_OPTIONS,
  CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS,
  inferredCodeGraphWriterLockPath,
  useDatabase,
  useDatabaseDirect,
} from '../session.js';
import {CodeGraphStoreError} from '../../types.js';
import {storeError} from '../utilities.js';
import {
  selectPersistentBuildOwnerCandidates,
  persistentBuildOwnerCandidateValid,
  observePersistentBuildOwner,
} from '../maintenance_core.js';
import {
  initializeRoutineMaintenanceSchema,
  retireAbandonedPersistentBuild,
  releaseSnapshotLease,
  renewSnapshotLease,
} from '../leases.js';
import {pruneRetiredSnapshotRowsPage} from '../view_cleanup.js';
import {runRoutineMaintenancePage} from '../routine_cleanup.js';
import {type CodeGraphStoreRuntime} from '../runtime.js';
import {type CodeGraphStoreShape} from '../shape.js';

type CodeGraphStoreMaintenanceMethods = Pick<
  CodeGraphStoreShape,
  'runRoutineMaintenance' | 'releaseSnapshotLease' | 'renewSnapshotLease'
>;

export function makeCodeGraphStoreMaintenanceMethods(runtime: CodeGraphStoreRuntime): CodeGraphStoreMaintenanceMethods {
  const {path, fs, crypto, system, withWriterGate, ensureLeaseSchemaInitialized, scheduleRoutinePhysicalCleanup} =
    runtime;
  return {
    runRoutineMaintenance: (databasePath, options) =>
      Effect.gen(function* () {
        const writerLockPath = options?.writerLockPath ?? inferredCodeGraphWriterLockPath(path, databasePath);
        if (writerLockPath === undefined) {
          return {reason: 'writer-lock-unavailable', state: 'skipped'} as const;
        }
        if (!(yield* fs.exists(databasePath))) {
          return {reason: 'database-missing', state: 'skipped'} as const;
        }
        const runPage = Effect.gen(function* () {
          // Purge owns the same checkout gate. Re-check only after acquiring
          // it and open SQLite within the critical section, so maintenance
          // cannot recreate a removed database or retain a Windows handle.
          if (!(yield* fs.exists(databasePath))) {
            return {reason: 'database-missing', state: 'skipped'} as const;
          }
          return yield* useDatabaseDirect(databasePath, runRoutineMaintenancePage());
        });
        const withWriterLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          withExclusiveFileLock(fs, writerLockPath, CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS, effect);
        const ownerReconciliationAvailable =
          options?.threadnoteHome !== undefined &&
          options.checkoutId !== undefined &&
          /^[0-9a-f]{64}$/u.test(options.checkoutId);
        if (!ownerReconciliationAvailable) {
          return yield* withWriterLock(runPage).pipe(
            Effect.catchIf(isFileLockTimeout, () =>
              Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const),
            ),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
          );
        }

        const probe = yield* withWriterLock(
          Effect.gen(function* () {
            if (!(yield* fs.exists(databasePath))) {
              return {kind: 'result', result: {reason: 'database-missing', state: 'skipped'} as const} as const;
            }
            return yield* useDatabaseDirect(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                if (!(yield* initializeRoutineMaintenanceSchema(sql))) {
                  return {
                    kind: 'result',
                    result: {reason: 'schema-unavailable', state: 'skipped'} as const,
                  } as const;
                }
                const candidates = yield* selectPersistentBuildOwnerCandidates(sql);
                return candidates.length > 0
                  ? ({candidates, kind: 'candidates'} as const)
                  : ({kind: 'result', result: yield* runRoutineMaintenancePage()} as const);
              }),
            );
          }),
        ).pipe(
          Effect.catchIf(isFileLockTimeout, () =>
            Effect.succeed({
              kind: 'result',
              result: {reason: 'writer-busy', state: 'deferred'} as const,
            } as const),
          ),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
        );
        if (probe.kind === 'result') return probe.result;

        const validCandidates = probe.candidates.filter(persistentBuildOwnerCandidateValid);
        let candidate = validCandidates.find(owner => !system.isProcessRunning(owner.processId));
        if (candidate === undefined) {
          const selected = validCandidates[0];
          if (selected !== undefined && (yield* observePersistentBuildOwner(selected)) === 'dead') {
            candidate = selected;
          }
        }
        if (candidate === undefined) {
          return yield* withWriterLock(runPage).pipe(
            Effect.catchIf(isFileLockTimeout, () =>
              Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const),
            ),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
          );
        }

        const ownerLayout = codeGraphLayout(path, options.threadnoteHome, options.checkoutId, candidate.worktreeId);
        if (ownerLayout.databasePath !== databasePath || ownerLayout.databaseWriteLockPath !== writerLockPath) {
          return {reason: 'writer-lock-unavailable', state: 'skipped'} as const;
        }
        const worktreeLockPath = ownerLayout.lockPath;
        const snapshotLockPath = codeGraphSnapshotBuildLockPath(
          path,
          options.threadnoteHome,
          options.checkoutId,
          candidate.logicalSnapshotId,
        );
        const retire = withExclusiveFileLock(
          fs,
          worktreeLockPath,
          CODE_GRAPH_ABANDONED_BUILD_LOCK_OPTIONS,
          withExclusiveFileLock(
            fs,
            snapshotLockPath,
            CODE_GRAPH_ABANDONED_BUILD_LOCK_OPTIONS,
            Effect.gen(function* () {
              if (yield* codeGraphMaintenanceIntentActive(options.threadnoteHome!)) {
                return {reason: 'external-maintenance', state: 'deferred'} as const;
              }
              if (
                (yield* corroborateCodeGraphBuildOwnerStatus(ownerLayout, candidate.worktreeId, candidate)) ===
                'mismatch'
              ) {
                return {reason: 'owner-changed', state: 'deferred'} as const;
              }
              // The liveness proof must still hold after both target locks.
              // A PID that appeared in the interval without an exact start
              // identity changes the observation to unknown and refuses.
              const liveness: CodeGraphBuildOwnerLiveness = yield* observePersistentBuildOwner(candidate);
              if (liveness !== 'dead') return {reason: 'owner-changed', state: 'deferred'} as const;
              return yield* withExclusiveFileLock(
                fs,
                writerLockPath,
                CODE_GRAPH_ABANDONED_BUILD_LOCK_OPTIONS,
                Effect.gen(function* () {
                  if (!(yield* fs.exists(databasePath))) {
                    return {reason: 'database-missing', state: 'skipped'} as const;
                  }
                  const outcome = yield* useDatabaseDirect(databasePath, retireAbandonedPersistentBuild(candidate));
                  if (outcome === 'retired') {
                    return {
                      cleanup: 'abandoned-build',
                      expiredLeases: 0,
                      remaining: true,
                      retiredSnapshots: 1,
                      rowsDeleted: 0,
                      state: 'completed',
                    } as const;
                  }
                  return {
                    reason: outcome === 'protected' ? ('owner-protected' as const) : ('owner-changed' as const),
                    state: 'deferred',
                  } as const;
                }),
              ).pipe(
                Effect.catchIf(isFileLockTimeout, () =>
                  Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const),
                ),
              );
            }),
          ).pipe(
            Effect.catchIf(isFileLockTimeout, () =>
              Effect.succeed({reason: 'snapshot-busy', state: 'deferred'} as const),
            ),
          ),
        ).pipe(
          Effect.catchIf(isFileLockTimeout, () =>
            Effect.succeed({reason: 'worktree-busy', state: 'deferred'} as const),
          ),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
        );
        const ownerResult = yield* retire;
        if (
          ownerResult.state === 'deferred' &&
          ['owner-changed', 'owner-protected', 'snapshot-busy', 'worktree-busy'].includes(ownerResult.reason)
        ) {
          const ordinary = yield* withWriterLock(runPage).pipe(
            Effect.catchIf(isFileLockTimeout, () =>
              Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const),
            ),
          );
          if (
            ordinary.state === 'completed' &&
            (ordinary.cleanup !== 'none' ||
              ordinary.expiredLeases > 0 ||
              ordinary.retiredSnapshots > 0 ||
              ordinary.rowsDeleted > 0)
          ) {
            return ordinary;
          }
        }
        return ownerResult;
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(SystemInfo, system),
        Effect.mapError(cause => storeError('run routine code graph maintenance', cause)),
      ),
    releaseSnapshotLease: (databasePath, token, options) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? withWriterGate(
                databasePath,
                useDatabase(
                  databasePath,
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* ensureLeaseSchemaInitialized(databasePath, sql, false);
                    const retired = yield* releaseSnapshotLease(token);
                    return retired ? yield* pruneRetiredSnapshotRowsPage() : {deleted: 0, remaining: false};
                  }),
                ),
                options?.waitTimeoutMilliseconds,
              ).pipe(
                Effect.tap(cleanup => (cleanup.remaining ? scheduleRoutinePhysicalCleanup(databasePath) : Effect.void)),
                Effect.asVoid,
              )
            : Effect.void,
        ),
        Effect.mapError(cause => storeError('release code graph snapshot lease', cause)),
      ),
    renewSnapshotLease: (databasePath, token, durationMilliseconds, options) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? withWriterGate(
                databasePath,
                useDatabase(
                  databasePath,
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* ensureLeaseSchemaInitialized(databasePath, sql, false);
                    yield* renewSnapshotLease(token, durationMilliseconds);
                    return yield* pruneRetiredSnapshotRowsPage();
                  }),
                ),
                options?.waitTimeoutMilliseconds,
              ).pipe(
                Effect.tap(cleanup => (cleanup.remaining ? scheduleRoutinePhysicalCleanup(databasePath) : Effect.void)),
                Effect.asVoid,
              )
            : Effect.fail(CodeGraphStoreError.of('The code graph database disappeared while renewing a lease.')),
        ),
        Effect.mapError(cause => storeError('renew code graph snapshot lease', cause)),
      ),
  } as const;
}
