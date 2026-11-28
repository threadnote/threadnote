import {Cause, Clock, Effect, Exit, FileSystem, Option, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {isFileLockTimeout, readExclusiveFileLockOwner} from '@threadnote/platform/file/lock';
import {syncWritableFile} from '@threadnote/platform/file/durability';
import {
  sqliteTemporaryDirectory,
  sqliteTemporaryDirectoryUsable,
} from '@threadnote/platform/sqlite_temporary_directory';
import {SystemInfo} from '@threadnote/platform/system';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {readModelSelection, selectedEmbeddingModelId} from '@threadnote/inference/models/selection';
import {RecallEmbeddingWakePort} from '../background/demand.js';
import {readActiveVectorGeneration, recallVectorStorage, vectorIndexStatus} from '../vector-index.js';
import {
  readSqlitePageStorage,
  RecallVectorCompactionThresholds,
  sqliteCompactionFreeSpace,
  sqliteCompactionRecommendation,
  type SqliteCompactionRecommendation,
} from './sqlite-pages.js';
import {recallVectorLockPath, withRecallVectorLock} from './storage.js';

/** A completed compaction waits a day; a deferral for free space and a failure retry sooner. */
export const RECALL_VECTOR_COMPACTION_COOLDOWN_MILLISECONDS = {
  complete: 24 * 60 * 60 * 1000,
  deferred: 5 * 60 * 1000,
  failed: 60 * 60 * 1000,
} as const;
/** A read checks the free pages of one model at most this often per process. */
const RECALL_VECTOR_COMPACTION_CHECK_INTERVAL_MILLISECONDS = 10 * 60 * 1000;
/** Worker catalog of maintenance-only demand: one empty entry per model, named `<model id>.json`. */
export const RECALL_VECTOR_COMPACTION_DEMAND_DIRECTORY = 'vector-compaction-demand-v1';

const bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * The one compaction record of a model, next to its database. Only the vector lock holder writes it. `running`
 * names the process that holds the lock; a later holder that still reads `running` knows that process stopped.
 */
const compactionStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literals(['running', 'complete', 'deferred', 'failed']),
  reason: Schema.optionalKey(
    Schema.Literals(['disk-space', 'interrupted', 'vacuum-failed', 'verification-failed', 'unit-failed']),
  ),
  processId: Schema.optionalKey(Schema.Int),
  at: Schema.Finite,
  notBefore: Schema.optionalKey(Schema.Finite),
  beforeBytes: Schema.optionalKey(bytes),
  afterBytes: Schema.optionalKey(bytes),
});
export type RecallVectorCompactionState = typeof compactionStateSchema.Type;
type CompactionReason = NonNullable<RecallVectorCompactionState['reason']>;

export type RecallVectorCompactionResult =
  | {readonly state: 'skipped'; readonly reason: 'missing' | 'cooldown' | 'not-needed' | 'lock-busy'}
  | {readonly state: 'complete'; readonly beforeBytes: number; readonly afterBytes: number}
  | {readonly state: 'deferred' | 'failed'; readonly reason: CompactionReason};

const locations = (path: Path.Path, home: string, modelId: string) => {
  const database = recallVectorStorage.databasePath(path, home, modelId);
  return {
    database,
    wal: database + '-wal',
    state: path.join(path.dirname(database), 'compaction.json'),
    demand: path.join(home, 'recall', RECALL_VECTOR_COMPACTION_DEMAND_DIRECTORY, modelId + '.json'),
  };
};

const fileBytes = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map(info => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );

const recommendation = (database: string) =>
  Effect.gen(function* () {
    const thresholds = yield* RecallVectorCompactionThresholds;
    return yield* readSqlitePageStorage(database).pipe(
      Effect.map(storage => sqliteCompactionRecommendation(storage, thresholds)),
      Effect.option,
    );
  });

/** Absent or unreadable state is no state: compaction is maintenance, and a reader never fails on it. */
export const readRecallVectorCompactionState = Effect.fn('recall.readVectorCompactionState')(function* (
  home: string,
  modelId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(locations(path, home, modelId).state).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(compactionStateSchema))),
    Effect.orElseSucceed(() => undefined),
  );
});

const writeState = Effect.fn('recall.writeVectorCompactionState')(function* (
  home: string,
  modelId: string,
  state: RecallVectorCompactionState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = locations(path, home, modelId).state;
  // The vector lock makes the holder the only writer, so one fixed temporary name is enough.
  yield* fs.writeFileString(file + '.tmp', JSON.stringify(state) + '\n', {mode: 0o600});
  yield* syncWritableFile(fs, file + '.tmp');
  yield* fs.rename(file + '.tmp', file);
});

/** The model id of a maintenance demand entry, or undefined for a name the worker must skip. */
export function recallVectorCompactionDemandModel(filename: string): string | undefined {
  return /^([a-z0-9][a-z0-9._-]{0,127})\.json$/u.exec(filename)?.[1];
}

export const completeRecallVectorCompactionDemand = Effect.fn('recall.completeVectorCompactionDemand')(function* (
  home: string,
  modelId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(locations(path, home, modelId).demand, {force: true});
});

const lastCheck = new Map<string, number>();

/**
 * The trigger of compaction, independent of vector demand: reads and finished builds call it. A read checks at
 * most once per interval per model; a finished build, which is when free pages appear, always checks. When the
 * free-page rule holds outside a cooldown, it records maintenance-only demand for the background worker and wakes
 * it. It never fails or slows its caller beyond one page-counter read.
 */
export const requestRecallVectorCompactionWhenDue = Effect.fn('recall.requestVectorCompactionWhenDue')(
  function* (home: string, modelId: string, trigger: 'read' | 'build' = 'read') {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    if (trigger === 'read') {
      const key = home + '\0' + modelId;
      const last = lastCheck.get(key);
      if (last !== undefined && now >= last && now - last < RECALL_VECTOR_COMPACTION_CHECK_INTERVAL_MILLISECONDS)
        return false;
      if (lastCheck.size >= 64) lastCheck.clear();
      lastCheck.set(key, now);
    }
    const location = locations(path, home, modelId);
    const state = yield* readRecallVectorCompactionState(home, modelId);
    if (state?.state === 'running' || (state?.notBefore !== undefined && state.notBefore > now)) return false;
    if (!(yield* fs.exists(location.database))) return false;
    const pages = yield* recommendation(location.database);
    if (Option.isNone(pages) || !pages.value.recommended) return false;
    // A worker must not resurrect an uninstalled home, so no directory above `recall/` is created here.
    for (const directory of [path.join(home, 'recall'), path.dirname(location.demand)])
      yield* fs
        .makeDirectory(directory, {mode: 0o700})
        .pipe(
          Effect.catchTag('PlatformError', error =>
            error.reason._tag === 'AlreadyExists' ? Effect.void : Effect.fail(error),
          ),
        );
    yield* fs
      .writeFileString(location.demand, '{"version":1}\n', {flag: 'wx', mode: 0o600})
      .pipe(
        Effect.catchTag('PlatformError', error =>
          error.reason._tag === 'AlreadyExists' ? Effect.void : Effect.fail(error),
        ),
      );
    const wake = yield* RecallEmbeddingWakePort;
    if (wake) yield* wake(home);
    return true;
  },
  Effect.catchCauseIf(
    cause => !Cause.hasInterrupts(cause),
    () => Effect.succeed(false),
  ),
);

/** The one compaction check of every reader: does a live process compact this model now? */
export const recallVectorCompactionRunning = Effect.fn('recall.vectorCompactionRunning')(function* (
  home: string,
  modelId: string,
) {
  const state = yield* readRecallVectorCompactionState(home, modelId);
  if (state?.state !== 'running' || state.processId === undefined) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const owner = yield* readExclusiveFileLockOwner(fs, recallVectorLockPath(path, home, modelId));
  if (Option.isNone(owner) || owner.value.processId !== state.processId) return false;
  const system = yield* Effect.serviceOption(SystemInfo);
  return Option.isNone(system) || system.value.isProcessRunning(state.processId);
});

/** The read state `compaction`: lexical recall answered, with this notice and no stale-index or repair hint. */
export const RECALL_SEMANTIC_COMPACTION_NOTICE =
  'Local AI recall notice: the semantic index is being compacted, so lexical recall answered. ' +
  'Semantic recall returns when the compaction ends.';

/**
 * The one compaction check of every semantic read path: a read that failed or ran out of time while a live
 * process compacts the selected model's vector file is the compaction's, not a stale or damaged index.
 */
export const semanticReadDuringCompaction = (config: {readonly agentContextHome: string}) =>
  Effect.gen(function* () {
    const modelId = selectedEmbeddingModelId(yield* readModelSelection(config.agentContextHome), 'recall');
    return modelId !== undefined && (yield* recallVectorCompactionRunning(config.agentContextHome, modelId));
  }).pipe(Effect.orElseSucceed(() => false));

/** The storage report of `threadnote index status`: file sizes, free pages and the last compaction state. */
export const recallVectorStorageReport = Effect.fn('recall.vectorStorageReport')(function* (
  home: string,
  modelId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const location = locations(path, home, modelId);
  if (!(yield* fs.exists(location.database))) return undefined;
  const pages = yield* recommendation(location.database);
  return {
    fileBytes: yield* fileBytes(fs, location.database),
    walBytes: yield* fileBytes(fs, location.wal),
    reclaimableBytes: Option.isSome(pages) ? pages.value.reclaimableBytes : undefined,
    compaction: yield* readRecallVectorCompactionState(home, modelId),
  };
});

/** Both VACUUM writes must fit: the copy in the SQLite temporary directory and the WAL next to the database. */
const enoughFreeSpace = Effect.fn('recall.vectorCompactionFreeSpace')(function* (
  database: string,
  pages: SqliteCompactionRecommendation,
  marginBytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const directory = path.dirname(database);
  const temporary = yield* sqliteTemporaryDirectory(
    {environment: system.environment(), platform: system.platform, temporaryDirectory: system.tempDirectory},
    candidate => sqliteTemporaryDirectoryUsable(fs, candidate),
  );
  if (temporary === undefined) return false;
  const device = (candidate: string) =>
    fs.stat(candidate).pipe(
      Effect.map(info => info.dev),
      Effect.option,
    );
  const [databaseDevice, temporaryDevice] = [yield* device(directory), yield* device(temporary)];
  const need = sqliteCompactionFreeSpace({
    liveBytes: pages.liveBytes,
    walBytes: yield* fileBytes(fs, database + '-wal'),
    marginBytes,
    // An unknown device counts as one filesystem, which needs the larger single total.
    sameFilesystem:
      Option.isNone(databaseDevice) || Option.isNone(temporaryDevice) || databaseDevice.value === temporaryDevice.value,
  });
  const available = (candidate: string) =>
    system.availableDiskBytes(candidate).pipe(Effect.orElseSucceed(() => undefined));
  const databaseFree = yield* available(directory);
  const temporaryFree = yield* available(temporary);
  return (
    databaseFree !== undefined &&
    databaseFree >= need.database &&
    temporaryFree !== undefined &&
    temporaryFree >= need.temporary
  );
});

/**
 * One maintenance unit under the vector write lock, so no build step or publication runs during it. SQLite keeps
 * the old file intact when VACUUM fails or its process stops. `complete` is recorded in the same uninterruptible
 * step as VACUUM's commit; the checkpoint and the verification follow. Every other exit after `running` records
 * a failure, so each outcome leaves a valid database and a state with a cooldown.
 */
export const runRecallVectorCompaction = Effect.fn('recall.vectorCompaction')(function* (
  home: string,
  manifest: LocalModelManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const thresholds = yield* RecallVectorCompactionThresholds;
  const location = locations(path, home, manifest.id);
  const skipped = (reason: Extract<RecallVectorCompactionResult, {state: 'skipped'}>['reason']) =>
    ({state: 'skipped', reason}) satisfies RecallVectorCompactionResult;
  if (!(yield* fs.exists(location.database))) return skipped('missing');
  const previous = yield* readRecallVectorCompactionState(home, manifest.id);
  if (previous?.state !== 'running') {
    if (previous?.notBefore !== undefined && previous.notBefore > (yield* Clock.currentTimeMillis))
      return skipped('cooldown');
    const pages = yield* recommendation(location.database);
    if (Option.isNone(pages) || !pages.value.recommended) return skipped('not-needed');
  }
  let recorded: RecallVectorCompactionState['state'] | undefined;
  const record = (
    state: RecallVectorCompactionState['state'],
    fields: Partial<Omit<RecallVectorCompactionState, 'version' | 'state' | 'at'>> = {},
  ) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const cooldown = state === 'running' ? undefined : RECALL_VECTOR_COMPACTION_COOLDOWN_MILLISECONDS[state];
      yield* writeState(home, manifest.id, {
        version: 1,
        state,
        at,
        ...(cooldown === undefined ? {} : {notBefore: at + cooldown}),
        ...fields,
      });
      recorded = state;
    });
  const finish = (state: 'deferred' | 'failed', reason: CompactionReason, beforeBytes?: number) =>
    record(state, {reason, ...(beforeBytes === undefined ? {} : {beforeBytes})}).pipe(
      Effect.as({state, reason} satisfies RecallVectorCompactionResult),
    );

  const compact = (pages: SqliteCompactionRecommendation, beforeBytes: number) =>
    Effect.gen(function* () {
      if (!(yield* enoughFreeSpace(location.database, pages, thresholds.safetyMarginBytes)))
        return yield* finish('deferred', 'disk-space');
      const ready = yield* readActiveVectorGeneration(home, manifest);
      let committedBytes: number | undefined;
      yield* recallVectorStorage
        .use(
          location.database,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe('PRAGMA busy_timeout = 1000');
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* sql.unsafe('VACUUM');
                const [size] = yield* sql.unsafe<{readonly page_size: number}>('PRAGMA page_size');
                const [count] = yield* sql.unsafe<{readonly page_count: number}>('PRAGMA page_count');
                const afterBytes = Number(size?.page_size ?? 0) * Number(count?.page_count ?? 0);
                yield* record('complete', {beforeBytes, afterBytes});
                committedBytes = afterBytes;
              }),
            );
            // Best effort: readers that still hold the WAL leave it to the next ordinary checkpoint.
            yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)').pipe(Effect.ignore);
          }),
        )
        .pipe(Effect.ignore);
      if (committedBytes === undefined) return yield* finish('failed', 'vacuum-failed', beforeBytes);
      // The ready generation must be the same row set, and every one of its vectors must still decode.
      const after = yield* vectorIndexStatus(home, manifest);
      if (ready !== undefined && (!after.ready || after.generation !== ready.generation))
        return yield* finish('failed', 'verification-failed', beforeBytes);
      return {state: 'complete', beforeBytes, afterBytes: committedBytes} satisfies RecallVectorCompactionResult;
    });

  return yield* withRecallVectorLock(
    home,
    manifest.id,
    Effect.gen(function* () {
      const current = yield* readRecallVectorCompactionState(home, manifest.id);
      const pages = yield* recommendation(location.database);
      // Only a lock holder writes `running`, so a holder that reads it took the lock over from a stopped process.
      if (current?.state === 'running') {
        if (Option.isNone(pages) || pages.value.recommended) return yield* finish('failed', 'interrupted');
        // Free pages below the rule: that process stopped after its VACUUM committed.
        const afterBytes = pages.value.liveBytes + pages.value.reclaimableBytes;
        const beforeBytes = current.beforeBytes ?? afterBytes;
        yield* record('complete', {beforeBytes, afterBytes});
        return {state: 'complete', beforeBytes, afterBytes} satisfies RecallVectorCompactionResult;
      }
      if (Option.isNone(pages) || !pages.value.recommended) return skipped('not-needed');
      const beforeBytes = yield* fileBytes(fs, location.database);
      yield* record('running', {processId: system.processId, beforeBytes});
      return yield* compact(pages.value, beforeBytes).pipe(
        Effect.onExit(exit =>
          Exit.isFailure(exit) && recorded === 'running'
            ? record('failed', {
                reason: Cause.hasInterrupts(exit.cause) ? 'interrupted' : 'unit-failed',
                beforeBytes,
              }).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
    }),
  ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed(skipped('lock-busy'))));
});
