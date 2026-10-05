import {Crypto, Effect, FileSystem, Option, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {type CodeGraphDatabaseSessionOptions} from './shape.js';
import {
  CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS,
  CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS,
  CODE_GRAPH_INTERNAL_CLEANUP_FOREGROUND_WAIT_MILLISECONDS,
  CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS,
  CodeGraphDatabaseSession,
  configureConnection,
  configureSqliteWriterConnection,
  inferredCodeGraphWriterLockPath,
  normalizedWriterGateWaitTimeout,
  useDatabaseDirect,
} from './session.js';
import {storeError} from './utilities.js';
import {initializeSchema} from './schema/initialization.js';
import {pruneRoutinePhysicalRowsPage} from './routine_cleanup.js';
import {drainCompletedPersistentBuildRows} from './activation/persistent.js';
import {initializeRoutineMaintenanceSchema} from './leases.js';
import {codeGraphWorktreeReconciliationSchemaCompatible} from './reconciliation.js';

export const makeCodeGraphStoreRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const path = yield* Path.Path;

  const crypto = yield* Crypto.Crypto;

  const system = yield* SystemInfo;

  const scope = yield* Effect.scope;

  const detachedCleanupActive = new Set<string>();

  const writerLockPathFor = (databasePath: string, options: CodeGraphDatabaseSessionOptions | undefined) =>
    options?.writerLockPath ?? inferredCodeGraphWriterLockPath(path, databasePath) ?? `${databasePath}.writer.lock`;

  const scheduleDetachedCleanup = (databasePath: string, cleanup: Effect.Effect<void>) =>
    Effect.gen(function* () {
      // Every detached collector is opportunistic and resumable. Running
      // more than one domain for the same database only adds SQLite
      // sessions and writer contention; a later foreground or maintenance
      // pass will resume whichever bounded domain was coalesced here.
      if (detachedCleanupActive.has(databasePath)) return;
      detachedCleanupActive.add(databasePath);
      const release = Effect.sync(() => detachedCleanupActive.delete(databasePath));
      yield* cleanup.pipe(Effect.ensuring(release), Effect.forkIn(scope));
    }).pipe(Effect.asVoid);

  const prepare = (databasePath: string) =>
    fs
      .makeDirectory(path.dirname(databasePath), {recursive: true, mode: 0o700})
      .pipe(Effect.mapError(cause => storeError('prepare code graph database', cause)));

  const withWriterGate = <A, E, R>(
    databasePath: string,
    effect: Effect.Effect<A, E, R>,
    waitTimeoutMilliseconds?: number,
  ) =>
    Effect.serviceOption(CodeGraphDatabaseSession).pipe(
      Effect.flatMap(session => {
        const options =
          Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
        if (options?.writerGateHeld) return effect;
        const writerLockPath = writerLockPathFor(databasePath, options);
        const requestedWaitTimeout = normalizedWriterGateWaitTimeout(waitTimeoutMilliseconds);
        const effectiveWaitTimeout =
          requestedWaitTimeout === 0 && detachedCleanupActive.has(databasePath)
            ? CODE_GRAPH_INTERNAL_CLEANUP_FOREGROUND_WAIT_MILLISECONDS
            : requestedWaitTimeout;
        const guarded = options?.onWriterReleased ? effect.pipe(Effect.ensuring(options.onWriterReleased())) : effect;
        return withExclusiveFileLock(
          fs,
          writerLockPath,
          {
            ...CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS,
            waitTimeoutMilliseconds: effectiveWaitTimeout,
            onAcquired: () => options?.onWriterAcquired?.() ?? Effect.void,
            onContention: () => options?.onWriterContention?.() ?? Effect.void,
          },
          guarded,
        ).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
        );
      }),
    );

  const leaseSchemaRemovedViewAuthority = new Map<string, boolean>();

  const ensureLeaseSchemaInitialized = (
    databasePath: string,
    sql: SqlClient.SqlClient,
    requireRemovedViewAuthority: boolean,
  ) => {
    const cachedRemovedViewAuthority = leaseSchemaRemovedViewAuthority.get(databasePath);
    if (cachedRemovedViewAuthority === true || (cachedRemovedViewAuthority === false && !requireRemovedViewAuthority)) {
      return Effect.void;
    }
    return initializeRoutineMaintenanceSchema(sql).pipe(
      Effect.flatMap(ready =>
        ready
          ? codeGraphWorktreeReconciliationSchemaCompatible(sql, false, false, requireRemovedViewAuthority).pipe(
              Effect.flatMap(compatible => (compatible ? Effect.void : initializeSchema(sql))),
            )
          : initializeSchema(sql),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          leaseSchemaRemovedViewAuthority.set(databasePath, requireRemovedViewAuthority);
        }),
      ),
    );
  };

  const ensureSchemaInitialized = (databasePath: string, sql: SqlClient.SqlClient, waitTimeoutMilliseconds?: number) =>
    Effect.gen(function* () {
      const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
      const matching =
        Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
      if (matching?.schemaInitialized) return;
      yield* withWriterGate(databasePath, initializeSchema(sql), waitTimeoutMilliseconds);
      // Schema setup can reset connection-level SQLite settings. Reapply only
      // settings that initializeSchema can affect; NORMAL durability is applied
      // later at the reconstructible-build boundary and needs no second report.
      if (matching?.sqliteWriterTuning && hasConnectionLevelWriterTuning(matching.sqliteWriterTuning)) {
        yield* configureSqliteWriterConnection(
          sql,
          matching.sqliteWriterTuning,
          'connection',
          matching.onSqliteWriterConfigured,
        );
      }
      if (matching) matching.schemaInitialized = true;
    });

  const startCompletedBuildCleanup = (
    databasePath: string,
    snapshotId: string | undefined,
    includeRoutinePhysical: boolean,
    options: CodeGraphDatabaseSessionOptions | undefined,
  ) =>
    Effect.gen(function* () {
      const writerLockPath = writerLockPathFor(databasePath, options);
      let completedBuildRemaining = true;
      const cleanupSweep = Effect.gen(function* () {
        // Purge owns the same gate before deleting the repository root. Check
        // existence only after acquiring it, and open SQLite inside the same
        // critical section, so a detached cleanup fiber cannot retain a
        // Windows file handle or recreate a database after purge.
        if (!(yield* fs.exists(databasePath))) return {deleted: 0, remaining: false};
        return yield* useDatabaseDirect(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* configureConnection(sql);
            let deleted = 0;
            if (completedBuildRemaining) {
              yield* options?.onCompletedBuildCleanupConnection?.() ?? Effect.void;
              const completed = yield* drainCompletedPersistentBuildRows(sql, snapshotId, undefined, 1);
              completedBuildRemaining = completed.remaining;
              deleted += completed.deleted;
              if (completed.remaining || !includeRoutinePhysical) {
                return {deleted, remaining: completed.remaining};
              }
            }
            const routine = yield* pruneRoutinePhysicalRowsPage(sql);
            return {deleted: deleted + routine.deleted, remaining: routine.remaining};
          }),
        );
      });
      const runSweep = withExclusiveFileLock(
        fs,
        writerLockPath,
        CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS,
        cleanupSweep,
      ).pipe(
        Effect.asSome,
        Effect.catchIf(isFileLockTimeout, () => Effect.succeedNone),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Path.Path, path),
        Effect.provideService(SystemInfo, system),
      );
      const cleanup = Effect.gen(function* () {
        for (;;) {
          const result = yield* runSweep;
          // Detached cleanup is opportunistic. Once a foreground writer
          // contends, stop this fiber and leave the reconstructible rows
          // for the next session or maintenance pass.
          if (Option.isNone(result) || !result.value.remaining) return;
          // Foreground writers poll the checkout gate every 25 ms. Detached
          // cleanup never queues on that gate and waits for two polling
          // windows before another bounded page.
          yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
        }
      });
      yield* scheduleDetachedCleanup(databasePath, cleanup.pipe(Effect.ignore));
    }).pipe(Effect.asVoid);

  const scheduleCompletedBuildCleanup = (databasePath: string, snapshotId?: string) =>
    Effect.gen(function* () {
      const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
      const options = Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
      if (options) {
        const request = options.detachedCleanupRequest;
        if (!request.completedBuild) {
          request.completedBuild = true;
          request.completedSnapshotId = snapshotId;
        } else if (request.completedSnapshotId !== snapshotId) {
          // Different snapshot-specific requests collapse safely to the
          // complete set of unreachable build-only rows.
          request.completedSnapshotId = undefined;
        }
        return;
      }
      yield* startCompletedBuildCleanup(databasePath, snapshotId, false, undefined);
    }).pipe(Effect.asVoid);

  const startRoutinePhysicalCleanup = (databasePath: string, options: CodeGraphDatabaseSessionOptions | undefined) =>
    Effect.gen(function* () {
      const writerLockPath = writerLockPathFor(databasePath, options);
      const cleanupSweep = Effect.gen(function* () {
        // Open SQLite only while holding the checkout writer gate. Purge
        // owns the same gate, so a detached collector cannot retain a
        // Windows handle or recreate a database after targeted deletion.
        if (!(yield* fs.exists(databasePath))) return {deleted: 0, remaining: false};
        return yield* useDatabaseDirect(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* configureConnection(sql);
            return yield* pruneRoutinePhysicalRowsPage(sql);
          }),
        );
      });
      const runSweep = withExclusiveFileLock(
        fs,
        writerLockPath,
        CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS,
        cleanupSweep,
      ).pipe(
        Effect.asSome,
        Effect.catchIf(isFileLockTimeout, () => Effect.succeedNone),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Path.Path, path),
        Effect.provideService(SystemInfo, system),
      );
      const cleanup = Effect.gen(function* () {
        // Pointer publication and lease release stay latency-bounded. Give
        // the foreground operation one polling window to finish before the
        // opportunistic collector attempts its first page.
        yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
        for (;;) {
          const result = yield* runSweep;
          // This collector is opportunistic and bounded to one table page
          // per writer-gate acquisition. Foreground work always wins; the
          // next lease/index/maintenance pass resumes any remaining rows.
          if (Option.isNone(result) || !result.value.remaining) return;
          yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
        }
      });
      yield* scheduleDetachedCleanup(databasePath, cleanup.pipe(Effect.ignore));
    }).pipe(Effect.asVoid);

  const scheduleRoutinePhysicalCleanup = (databasePath: string) =>
    Effect.gen(function* () {
      const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
      const options = Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
      if (options) {
        options.detachedCleanupRequest.routinePhysical = true;
        return;
      }
      yield* startRoutinePhysicalCleanup(databasePath, undefined);
    }).pipe(Effect.asVoid);
  return {
    withWriterGate,
    scheduleCompletedBuildCleanup,
    startCompletedBuildCleanup,
    startRoutinePhysicalCleanup,
    fs,
    system,
    crypto,
    prepare,
    ensureLeaseSchemaInitialized,
    scheduleRoutinePhysicalCleanup,
    ensureSchemaInitialized,
    scope,
    path,
  } as const;
});

function hasConnectionLevelWriterTuning(tuning: CodeGraphDatabaseSessionOptions['sqliteWriterTuning']): boolean {
  return (
    tuning?.mainCacheKiB !== undefined ||
    tuning?.mmapSizeBytes !== undefined ||
    tuning?.walAutoCheckpointPages !== undefined
  );
}

export type CodeGraphStoreRuntime = Effect.Success<typeof makeCodeGraphStoreRuntime>;
