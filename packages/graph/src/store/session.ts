import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Cause, Context, Effect, Layer, Option, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import * as SqlError from 'effect/sql/SqlError';
import type {
  CodeGraphDatabaseSessionOptions,
  CodeGraphSqliteWriterSettings,
  CodeGraphSqliteWriterTuning,
} from './shape.js';
import {CODE_GRAPH_SCHEMA_VERSION, CodeGraphStoreError, type CodeGraphStoreFailure} from '../types.js';

export interface CodeGraphDatabaseSessionShape extends CodeGraphDatabaseSessionOptions {
  readonly databasePath: string;
  readonly detachedCleanupRequest: {
    completedBuild: boolean;
    completedSnapshotId: string | undefined;
    routinePhysical: boolean;
  };
  reconstructibleDurabilityConfigured: boolean;
  schemaInitialized: boolean;
  readonly sql: SqlClient.SqlClient;
}

export class CodeGraphDatabaseSession extends Context.Service<
  CodeGraphDatabaseSession,
  CodeGraphDatabaseSessionShape
>()('@threadnote/graph/store/session/CodeGraphDatabaseSession') {}

export function useDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.serviceOption(CodeGraphDatabaseSession).pipe(
    Effect.flatMap(session =>
      Option.isSome(session) && session.value.databasePath === databasePath
        ? effect.pipe(Effect.provideService(SqlClient.SqlClient, session.value.sql))
        : useDatabaseDirect(databasePath, effect),
    ),
  );
}

export function useReadOnlyDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.serviceOption(CodeGraphDatabaseSession).pipe(
    Effect.flatMap(session =>
      Option.isSome(session) && session.value.databasePath === databasePath
        ? effect.pipe(Effect.provideService(SqlClient.SqlClient, session.value.sql))
        : useDatabaseDirect(databasePath, effect, true),
    ),
  );
}

export function useExistingDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E | CodeGraphStoreFailure, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        create: false,
        disableWAL: true,
        filename: databasePath,
        readonly: false,
        readwrite: true,
      }),
    ).pipe(
      Effect.catchCauseIf(
        cause => !Cause.hasInterruptsOnly(cause),
        () => Effect.fail(CodeGraphStoreError.of('Existing code graph database could not be opened.')),
      ),
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
  );
}

export function useDatabaseDirect<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
  readOnly = false,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  const layer = readOnly
    ? SqliteClient.layer({
        create: false,
        disableWAL: true,
        filename: databasePath,
        readonly: true,
        readwrite: false,
      })
    : SqliteClient.layer({disableWAL: true, filename: databasePath});
  return Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

export const configureConnection = Effect.fn('codeGraph.configureConnection')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe(`PRAGMA journal_size_limit = ${CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
});

export const configureReadConnection = Effect.fn('codeGraph.configureReadConnection')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe('PRAGMA query_only = ON');
});

// One indexing writer owns the repository-sized B-trees. The former 64 KiB
// cache repeatedly evicted their upper pages at production scale; 32 MiB was
// the smallest screened setting with a material cold-build win, while staying
// bounded independently of repository size and leaving read sessions small.
export const CODE_GRAPH_WRITER_MAIN_CACHE_KIB = 32 * 1_024;
export const CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1_024 * 1_024;
const CODE_GRAPH_SQLITE_WRITER_CACHE_KIB_MAXIMUM = 4 * 1_024 * 1_024;
const CODE_GRAPH_SQLITE_WRITER_MMAP_BYTES_MAXIMUM = 64 * 1_024 * 1_024 * 1_024;
const CODE_GRAPH_SQLITE_WRITER_WAL_CHECKPOINT_PAGES_MAXIMUM = 1_000_000;

export const configureSqliteWriterConnection = Effect.fn('codeGraph.configureSqliteWriterConnection')(function* (
  sql: SqlClient.SqlClient,
  tuning: CodeGraphSqliteWriterTuning,
  phase: CodeGraphSqliteWriterSettings['phase'],
  observe?: (settings: CodeGraphSqliteWriterSettings) => Effect.Effect<void, never>,
) {
  if (tuning.mainCacheKiB !== undefined) {
    const value = sqlitePragmaInteger(
      tuning.mainCacheKiB,
      'SQLite writer cache KiB',
      1,
      CODE_GRAPH_SQLITE_WRITER_CACHE_KIB_MAXIMUM,
    );
    yield* sql.unsafe(`PRAGMA main.cache_size = -${value}`);
    const pageSize = yield* sql.unsafe<{readonly page_size: number}>('PRAGMA main.page_size');
    const bytesPerPage = Number(pageSize[0]?.page_size ?? 0);
    if (!Number.isSafeInteger(bytesPerPage) || bytesPerPage < 512) {
      return yield* CodeGraphStoreError.of('SQLite writer page size is invalid.');
    }
    // SQLite's connection default can retain a 20,000-page spill threshold
    // even after cache_size is lowered. Bind spill to the configured byte
    // budget so a publication transaction cannot silently grow tens of MiB
    // beyond the reviewed writer cache.
    const spillPages = Math.max(1, Math.ceil((value * 1_024) / bytesPerPage));
    yield* sql.unsafe(`PRAGMA cache_spill = ${spillPages}`);
  }
  if (tuning.mmapSizeBytes !== undefined) {
    const value = sqlitePragmaInteger(
      tuning.mmapSizeBytes,
      'SQLite writer mmap bytes',
      0,
      CODE_GRAPH_SQLITE_WRITER_MMAP_BYTES_MAXIMUM,
    );
    yield* sql.unsafe(`PRAGMA main.mmap_size = ${value}`);
  }
  if (tuning.walAutoCheckpointPages !== undefined) {
    const value = sqlitePragmaInteger(
      tuning.walAutoCheckpointPages,
      'SQLite writer WAL auto-checkpoint pages',
      0,
      CODE_GRAPH_SQLITE_WRITER_WAL_CHECKPOINT_PAGES_MAXIMUM,
    );
    yield* sql.unsafe(`PRAGMA wal_autocheckpoint = ${value}`);
  }
  yield* reportSqliteWriterSettings(sql, phase, observe);
});

export const configureReconstructibleBuildDurability = Effect.fn('codeGraph.configureReconstructibleBuildDurability')(
  function* (sql: SqlClient.SqlClient) {
    const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
    if (
      Option.isNone(session) ||
      session.value.sql !== sql ||
      session.value.sqliteWriterTuning?.reconstructibleBuildSynchronous !== 'normal' ||
      session.value.reconstructibleDurabilityConfigured
    ) {
      return;
    }
    // Only unpublished full-build rows use NORMAL. They are ignored by readers,
    // fingerprinted by batch, and can be resumed or reconstructed after a crash.
    yield* sql.unsafe('PRAGMA synchronous = NORMAL');
    session.value.reconstructibleDurabilityConfigured = true;
    yield* reportSqliteWriterSettings(sql, 'building', session.value.onSqliteWriterConfigured);
  },
);

export const configurePublicationDurability = Effect.fn('codeGraph.configurePublicationDurability')(function* (
  sql: SqlClient.SqlClient,
) {
  const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
  if (
    Option.isNone(session) ||
    session.value.sql !== sql ||
    session.value.sqliteWriterTuning?.reconstructibleBuildSynchronous !== 'normal'
  ) {
    return;
  }
  // The ready-state CAS is the publication boundary. FULL makes that commit
  // sync the WAL containing every earlier NORMAL full-build transaction before
  // readers can observe the snapshot as ready.
  yield* sql.unsafe('PRAGMA synchronous = FULL');
  session.value.reconstructibleDurabilityConfigured = false;
  yield* reportSqliteWriterSettings(sql, 'publication', session.value.onSqliteWriterConfigured);
});

const reportSqliteWriterSettings = Effect.fn('codeGraph.reportSqliteWriterSettings')(function* (
  sql: SqlClient.SqlClient,
  phase: CodeGraphSqliteWriterSettings['phase'],
  observe?: (settings: CodeGraphSqliteWriterSettings) => Effect.Effect<void, never>,
) {
  if (!observe) return;
  const [cache, journal, mmap, synchronous, wal] = yield* Effect.all(
    [
      sql.unsafe<{readonly cache_size: number}>('PRAGMA main.cache_size'),
      sql.unsafe<{readonly journal_mode: string}>('PRAGMA main.journal_mode'),
      sql.unsafe<{readonly mmap_size: number}>('PRAGMA main.mmap_size'),
      sql.unsafe<{readonly synchronous: number}>('PRAGMA main.synchronous'),
      sql.unsafe<{readonly wal_autocheckpoint: number}>('PRAGMA wal_autocheckpoint'),
    ] as const,
    {concurrency: 1},
  );
  yield* observe({
    cacheSizePragma: Number(cache[0]?.cache_size ?? 0),
    journalMode: String(journal[0]?.journal_mode ?? 'unknown'),
    mmapSizeBytes: Number(mmap[0]?.mmap_size ?? 0),
    phase,
    synchronous: Number(synchronous[0]?.synchronous ?? -1),
    walAutoCheckpointPages: Number(wal[0]?.wal_autocheckpoint ?? 0),
  });
});

function sqlitePragmaInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw CodeGraphStoreError.of(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export const CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: Number.POSITIVE_INFINITY,
} as const;

export const CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS = {
  ...CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS,
  waitTimeoutMilliseconds: 0,
} as const;

export const CODE_GRAPH_ABANDONED_BUILD_LOCK_OPTIONS = {
  ...CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS,
  recoverReusedProcessIdImmediately: true,
} as const;

export const CODE_GRAPH_ABANDONED_BUILD_CANDIDATE_LIMIT = 64;
export const CODE_GRAPH_ABANDONED_BUILD_CURSOR_KEY = 'routine_abandoned_build_owner_cursor';

export const CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS = CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS.retryIntervalMilliseconds * 2;
/** Same-process opportunistic cleanup yields before a foreground zero-wait action reports external contention. */
export const CODE_GRAPH_INTERNAL_CLEANUP_FOREGROUND_WAIT_MILLISECONDS = 250;

export function normalizedWriterGateWaitTimeout(waitTimeoutMilliseconds: number | undefined): number {
  if (waitTimeoutMilliseconds === undefined || waitTimeoutMilliseconds === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(waitTimeoutMilliseconds)) return 0;
  return Math.max(0, Math.floor(waitTimeoutMilliseconds));
}

export function inferredCodeGraphWriterLockPath(path: Path.Path, databasePath: string): string | undefined {
  if (path.basename(databasePath) !== `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`) return undefined;
  const repositoryRoot = path.dirname(databasePath);
  const checkoutId = path.basename(repositoryRoot);
  const repositoriesRoot = path.dirname(repositoryRoot);
  const codeGraphRoot = path.dirname(repositoriesRoot);
  const indexesRoot = path.dirname(codeGraphRoot);
  if (
    !/^[0-9a-f]{64}$/.test(checkoutId) ||
    path.basename(repositoriesRoot) !== 'repositories' ||
    path.basename(codeGraphRoot) !== 'code-graph' ||
    path.basename(indexesRoot) !== 'indexes'
  ) {
    return undefined;
  }
  return path.join(
    path.dirname(indexesRoot),
    'locks',
    'indexes',
    'code-graph',
    'database-writes',
    `${checkoutId}.lock`,
  );
}

export function tableExists(sql: SqlClient.SqlClient, table: string): Effect.Effect<boolean, SqlError.SqlError> {
  return sql<{readonly name: string}>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table} LIMIT 1
  `.pipe(Effect.map(rows => rows.length > 0));
}
