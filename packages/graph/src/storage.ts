import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {recordCodeGraphAutomaticCompactionAttempt} from './automatic/compaction_receipt.js';
import {codeGraphMaintenanceLockPath, codeGraphRepositoryLockPath, codeGraphRepositoryRoot} from './layout.js';
import {
  awaitCodeGraphWorktreeBuilds,
  codeGraphRepositoryLockActive,
  codeGraphWorktreeBuildActive,
  withCodeGraphDatabaseWriteLock,
  withCodeGraphReportedMaintenanceIntent,
} from './maintenance/gate.js';
import {CODE_GRAPH_SCHEMA_VERSION, type CodeGraphSnapshot} from './types.js';
import {CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES} from './store/session.js';
import {
  CODE_GRAPH_STORAGE_SEMANTIC_OBJECT_LIMIT,
  readCodeGraphStorageSemanticAttribution,
  type CodeGraphStorageSemanticAttribution,
} from './storage/attribution.js';

class CodeGraphStorageOperationError extends Schema.TaggedError<
  CodeGraphStorageOperationError,
  {readonly brand: unique symbol}
>()('CodeGraphStorageOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export const CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_BYTES = 512 * 1024 * 1024;
export const CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_RATIO = 0.2;
export const CODE_GRAPH_COMPACTION_MIN_SAFETY_MARGIN_BYTES = 512 * 1024 * 1024;
export const CODE_GRAPH_COMPACTION_SAFETY_MARGIN_RATIO = 0.1;
export const CODE_GRAPH_STORAGE_ATTRIBUTION_OBJECT_LIMIT = 128;

export interface CodeGraphStorageThreshold {
  readonly minimumReclaimableBytes: number;
  readonly minimumReclaimableRatio: number;
  readonly recommended: boolean;
  readonly reason?: 'freelist' | 'freelist-and-fragmentation';
}

export interface CodeGraphPageStorage {
  readonly attribution?: CodeGraphStorageAttribution;
  /** Freelist bytes plus measured unused space inside live B-tree pages. */
  readonly compactionOpportunityBytes?: number;
  readonly compactionOpportunityRatio?: number;
  readonly freelistPages: number;
  readonly fragmentedBytes?: number;
  readonly fragmentationRatio?: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly reclaimableBytes: number;
  readonly reclaimableRatio: number;
  readonly state: 'available';
  readonly threshold: CodeGraphStorageThreshold;
}

export interface CodeGraphStorageObjectAttribution {
  readonly bytes: number;
  readonly kind: 'index' | 'internal' | 'table';
  readonly name: string;
  readonly pages: number;
}

export type CodeGraphStorageAttribution = CodeGraphStorageAttributionAvailable | CodeGraphStorageAttributionUnavailable;

export interface CodeGraphStorageAttributionAvailable {
  /** Logical allocated bytes represented by page_count * page_size. */
  readonly allocatedBytes: number;
  /** Bytes assigned by SQLite dbstat to named B-trees. */
  readonly attributedBytes: number;
  readonly freelistBytes: number;
  /** Unused payload capacity inside live B-tree pages, measured by SQLite dbstat. */
  readonly fragmentedBytes: number;
  readonly objectCount: number;
  readonly objects: readonly CodeGraphStorageObjectAttribution[];
  readonly objectsTruncated: boolean;
  /** Exact B-tree groups plus bounded logical per-snapshot payload attribution. */
  readonly semantic: CodeGraphStorageSemanticAttribution;
  readonly state: 'available';
  /** Pointer-map or other pages not assigned to a named B-tree or freelist. */
  readonly unattributedBytes: number;
}

export interface CodeGraphStorageAttributionUnavailable {
  readonly reason: 'sqlite-dbstat-unavailable';
  readonly state: 'unavailable';
}

/** @internal Exact remainder after assigning allocated SQLite pages to objects and the freelist. */
export function codeGraphStorageUnattributedBytes(
  allocatedBytes: number,
  attributedBytes: number,
  freelistBytes: number,
): number {
  for (const [label, value] of [
    ['allocated', allocatedBytes],
    ['attributed', attributedBytes],
    ['freelist', freelistBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw CodeGraphStorageOperationError.make({message: `Invalid SQLite ${label} storage bytes.`});
  }
  if (attributedBytes > allocatedBytes || freelistBytes > allocatedBytes - attributedBytes) {
    throw CodeGraphStorageOperationError.make({message: 'SQLite storage attribution exceeds allocated page bytes.'});
  }
  return allocatedBytes - attributedBytes - freelistBytes;
}

/**
 * Recommends VACUUM from either fully free pages or the combined footprint of
 * free pages and unused capacity left by write churn inside live B-tree pages.
 */
export function codeGraphCompactionRecommendation(input: {
  readonly allocatedBytes: number;
  readonly fragmentedBytes: number;
  readonly reclaimableBytes: number;
}): CodeGraphStorageThreshold & {
  readonly compactionOpportunityBytes: number;
  readonly compactionOpportunityRatio: number;
} {
  const {allocatedBytes, fragmentedBytes, reclaimableBytes} = input;
  for (const [label, value] of [
    ['allocated', allocatedBytes],
    ['fragmented', fragmentedBytes],
    ['reclaimable', reclaimableBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw CodeGraphStorageOperationError.make({message: `Invalid SQLite ${label} storage bytes.`});
  }
  const compactionOpportunityBytes = reclaimableBytes + fragmentedBytes;
  if (
    !Number.isSafeInteger(compactionOpportunityBytes) ||
    reclaimableBytes > allocatedBytes ||
    compactionOpportunityBytes > allocatedBytes
  ) {
    throw CodeGraphStorageOperationError.make({message: 'SQLite compaction opportunity exceeds allocated page bytes.'});
  }
  const reclaimableRatio = allocatedBytes === 0 ? 0 : reclaimableBytes / allocatedBytes;
  const compactionOpportunityRatio = allocatedBytes === 0 ? 0 : compactionOpportunityBytes / allocatedBytes;
  const freelistRecommended =
    reclaimableBytes >= CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_BYTES &&
    reclaimableRatio >= CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_RATIO;
  const fragmentationRecommended =
    compactionOpportunityBytes >= CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_BYTES &&
    compactionOpportunityRatio >= CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_RATIO;
  return {
    compactionOpportunityBytes,
    compactionOpportunityRatio,
    minimumReclaimableBytes: CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_BYTES,
    minimumReclaimableRatio: CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_RATIO,
    recommended: freelistRecommended || fragmentationRecommended,
    ...((freelistRecommended
      ? {reason: 'freelist'}
      : fragmentationRecommended
        ? {reason: 'freelist-and-fragmentation'}
        : {}) satisfies Pick<CodeGraphStorageThreshold, 'reason'>),
  };
}

export interface CodeGraphDeferredPageStorage {
  readonly reason: 'active-build';
  readonly state: 'deferred';
  readonly threshold: Omit<CodeGraphStorageThreshold, 'recommended'>;
}

export interface CodeGraphUnavailablePageStorage {
  readonly reason: 'database-busy-or-unreadable';
  readonly state: 'unavailable';
  readonly threshold: Omit<CodeGraphStorageThreshold, 'recommended'>;
}

export interface CodeGraphActiveStorage {
  readonly availableBytes?: number;
  readonly checkoutId: string;
  readonly databaseBytes: number;
  readonly databasePath: string;
  /** Exact DB, rollback journal, WAL, and SHM bytes visible on the durable filesystem. */
  readonly filesystemBytes: number;
  readonly journalBytes: number;
  readonly pageStorage: CodeGraphDeferredPageStorage | CodeGraphPageStorage | CodeGraphUnavailablePageStorage;
  readonly shmBytes: number;
  readonly state: 'available';
  /** Filesystem bytes plus currently reported SQLite TEMP database bytes. */
  readonly totalBytes: number;
  readonly temporaryBytes: number;
  readonly walBytes: number;
}

export interface CodeGraphMissingStorage {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly state: 'missing';
}

export type CodeGraphStorage = CodeGraphActiveStorage | CodeGraphMissingStorage;

export interface CodeGraphCompactionInterlock {
  readonly beforeRevalidation?: (storage: CodeGraphActiveStorage) => Effect.Effect<void>;
}

export interface CodeGraphCompactionSummary {
  readonly action: 'compacted' | 'deferred' | 'missing' | 'not-needed' | 'would-compact';
  readonly after?: CodeGraphActiveStorage;
  readonly before?: CodeGraphActiveStorage;
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly dryRun: boolean;
  readonly reason?: 'active-build' | 'active-maintenance';
  readonly reclaimedBytes: number;
}

interface CodeGraphFileIdentity {
  readonly birthtimeMilliseconds: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly modifiedAtMilliseconds: number;
  readonly size: bigint;
}

interface CodeGraphCompactionReceipt {
  readonly activeSnapshots: number;
  readonly schemaVersion: number;
  readonly snapshotStates: Readonly<Record<CodeGraphSnapshot['state'], number>>;
}

const STORAGE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 1,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 0,
} as const;

/**
 * Reads exact DB/WAL/SHM bytes from filesystem metadata. Page statistics require
 * a tiny read-only PRAGMA connection, which is deliberately skipped whenever an
 * active repository lock is present.
 */
export const inspectCodeGraphStorage = Effect.fn('codeGraph.inspectStorage')(function* (
  threadnoteHome: string,
  checkoutId: string,
  options: {
    readonly attributeObjects?: boolean;
    /** Measure live-page fragmentation without collecting full semantic attribution. */
    readonly measureFragmentation?: boolean;
    readonly openWhileLocked?: boolean;
    /** Current TEMP database bytes reported by an active build status. */
    readonly temporaryBytes?: number;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
  const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
  const database = yield* regularFileBytes(fs, databasePath);
  if (database.state === 'missing') {
    return {checkoutId, databasePath, state: 'missing'} satisfies CodeGraphMissingStorage;
  }
  const [wal, shm, journal, availableBytes] = yield* Effect.all(
    [
      regularFileBytes(fs, `${databasePath}-wal`),
      regularFileBytes(fs, `${databasePath}-shm`),
      regularFileBytes(fs, `${databasePath}-journal`),
      system.availableDiskBytes(repositoryRoot).pipe(Effect.orElseSucceed(() => undefined)),
    ],
    {concurrency: 4},
  );
  const locked =
    !options.openWhileLocked &&
    ((yield* codeGraphRepositoryLockActive(threadnoteHome, checkoutId)) ||
      (yield* codeGraphWorktreeBuildActive(threadnoteHome, checkoutId)));
  const threshold = {
    minimumReclaimableBytes: CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_BYTES,
    minimumReclaimableRatio: CODE_GRAPH_COMPACTION_MIN_RECLAIMABLE_RATIO,
  } as const;
  const pageStorage = locked
    ? ({reason: 'active-build', state: 'deferred', threshold} satisfies CodeGraphDeferredPageStorage)
    : yield* readPageStorage(
        databasePath,
        options.attributeObjects === true,
        options.measureFragmentation === true,
      ).pipe(
        Effect.orElseSucceed(
          () =>
            ({
              reason: 'database-busy-or-unreadable',
              state: 'unavailable',
              threshold,
            }) satisfies CodeGraphUnavailablePageStorage,
        ),
      );
  const walBytes = wal.state === 'available' ? wal.bytes : 0;
  const shmBytes = shm.state === 'available' ? shm.bytes : 0;
  const journalBytes = journal.state === 'available' ? journal.bytes : 0;
  const temporaryBytes = nonNegativeSafeBytes(options.temporaryBytes) ? options.temporaryBytes : 0;
  const filesystemBytes = database.bytes + walBytes + shmBytes + journalBytes;
  return {
    ...(nonNegativeSafeBytes(availableBytes) ? {availableBytes} : {}),
    checkoutId,
    databaseBytes: database.bytes,
    databasePath,
    filesystemBytes,
    journalBytes,
    pageStorage,
    shmBytes,
    state: 'available',
    temporaryBytes,
    totalBytes: filesystemBytes + temporaryBytes,
    walBytes,
  } satisfies CodeGraphActiveStorage;
});

function nonNegativeSafeBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Explicit compaction uses SQLite's transactional VACUUM implementation. SQLite
 * builds a private replacement database and commits it back atomically; a failed
 * or interrupted VACUUM leaves the original database intact. Threadnote adds its
 * maintenance + checkout locks, zero-wait contention deferral, target-identity
 * revalidation, pre/post integrity receipts, and WAL checkpoints around it.
 */
export const compactCodeGraphStorage = Effect.fn('codeGraph.compactStorage')(function* (
  threadnoteHome: string,
  checkoutId: string,
  options: {
    readonly dryRun: boolean;
    readonly force?: boolean;
    readonly interlock?: CodeGraphCompactionInterlock;
    /** Automatic sidecar candidates must never promote structural slack to VACUUM. */
    readonly operation?: 'automatic-journal';
    readonly onProgress?: (phase: 'compacting' | 'inspecting' | 'waiting-builders') => Effect.Effect<void, unknown>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const databasePath = path.join(
    codeGraphRepositoryRoot(path, threadnoteHome, checkoutId),
    `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
  );
  const deferred = (reason: CodeGraphCompactionSummary['reason']) =>
    ({
      action: 'deferred',
      checkoutId,
      databasePath,
      dryRun: options.dryRun,
      reason,
      reclaimedBytes: 0,
    }) satisfies CodeGraphCompactionSummary;
  let reportMaintenance: (progress: {
    readonly completed: number;
    readonly phase: 'acquiring-gates' | 'retiring-and-cleaning' | 'verifying-graph' | 'waiting-builders';
    readonly total: number;
  }) => Effect.Effect<void> = () => Effect.void;
  const checkoutMaintenance = withExclusiveFileLock(
    fs,
    codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId),
    STORAGE_LOCK_OPTIONS,
    Effect.gen(function* () {
      yield* options.onProgress?.('waiting-builders') ?? Effect.void;
      yield* reportMaintenance({completed: 1, phase: 'waiting-builders', total: 3});
      yield* awaitCodeGraphWorktreeBuilds(threadnoteHome, checkoutId, 0);
      return yield* withCodeGraphDatabaseWriteLock(
        threadnoteHome,
        checkoutId,
        Effect.gen(function* () {
          yield* options.onProgress?.('inspecting') ?? Effect.void;
          yield* reportMaintenance({completed: 2, phase: 'verifying-graph', total: 3});
          const before = yield* inspectCodeGraphStorage(threadnoteHome, checkoutId, {
            measureFragmentation: true,
            openWhileLocked: true,
          });
          if (before.state === 'missing') {
            return {
              action: 'missing',
              checkoutId,
              databasePath,
              dryRun: options.dryRun,
              reclaimedBytes: 0,
            } satisfies CodeGraphCompactionSummary;
          }
          if (before.pageStorage.state !== 'available') {
            return yield* CodeGraphStorageOperationError.make({
              message: 'Code graph page storage could not be inspected under its lock.',
            });
          }
          // Explicit requests retain the established force semantics, while
          // automatic callers only ever reach this path for freelist-backed
          // candidates. Manual structural recommendations remain VACUUM work.
          const vacuumRecommended =
            options.operation !== 'automatic-journal' &&
            (options.force === true || before.pageStorage.threshold.recommended);
          const walReclamationRecommended = before.walBytes > CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES;
          if (!vacuumRecommended && !walReclamationRecommended) {
            return {
              action: 'not-needed',
              before,
              checkoutId,
              databasePath,
              dryRun: options.dryRun,
              reclaimedBytes: 0,
            } satisfies CodeGraphCompactionSummary;
          }
          const identity = yield* requireRegularFileIdentity(fs, databasePath);
          const receipt = yield* readCompactionReceipt(databasePath);
          yield* options.interlock?.beforeRevalidation?.(before) ?? Effect.void;
          yield* verifyRegularFileIdentity(fs, databasePath, identity);
          if (options.dryRun) {
            return {
              action: 'would-compact',
              before,
              checkoutId,
              databasePath,
              dryRun: true,
              reclaimedBytes: vacuumRecommended
                ? (before.pageStorage.compactionOpportunityBytes ?? before.pageStorage.reclaimableBytes)
                : Math.max(0, before.walBytes - CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES),
            } satisfies CodeGraphCompactionSummary;
          }
          yield* options.onProgress?.('compacting') ?? Effect.void;
          yield* reportMaintenance({completed: 3, phase: 'retiring-and-cleaning', total: 3});
          if (vacuumRecommended) {
            yield* verifyCompactionDiskHeadroom(system, path.dirname(databasePath), before);
            yield* vacuumDatabase(databasePath);
          } else {
            yield* reclaimWalStorage(databasePath);
            const afterJournalIdentity = yield* requireRegularFileIdentity(fs, databasePath);
            if (!sameRegularFileTarget(identity, afterJournalIdentity)) {
              return yield* CodeGraphStorageOperationError.make({
                message: 'Code graph database changed during WAL reclamation; retry after current work finishes.',
              });
            }
          }
          const afterReceipt = yield* readCompactionReceipt(databasePath);
          if (!sameCompactionReceipt(receipt, afterReceipt)) {
            return yield* CodeGraphStorageOperationError.make({
              message: 'Code graph compaction changed the active snapshot receipt.',
            });
          }
          const after = yield* inspectCodeGraphStorage(threadnoteHome, checkoutId, {openWhileLocked: true});
          if (after.state === 'missing') {
            return yield* CodeGraphStorageOperationError.make({
              message: 'Code graph database disappeared during compaction.',
            });
          }
          const summary = {
            action: 'compacted',
            after,
            before,
            checkoutId,
            databasePath,
            dryRun: false,
            reclaimedBytes: Math.max(0, before.filesystemBytes - after.filesystemBytes),
          } satisfies CodeGraphCompactionSummary;
          yield* recordCodeGraphAutomaticCompactionAttempt(
            threadnoteHome,
            {checkoutId, opportunityBytes: codeGraphCompactionSummaryOpportunityBytes(summary)},
            {action: summary.action, reclaimedBytes: summary.reclaimedBytes},
          );
          return summary;
        }),
        0,
      );
    }),
  ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed(deferred('active-build'))));
  const maintain = withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    STORAGE_LOCK_OPTIONS,
    withCodeGraphReportedMaintenanceIntent(
      threadnoteHome,
      {checkoutId, operation: 'graph-maintenance'},
      {completed: 0, phase: 'acquiring-gates', total: 3},
      reporter => {
        reportMaintenance = reporter.progress;
        return checkoutMaintenance;
      },
    ),
  ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed(deferred('active-maintenance'))));
  if (options.dryRun) return yield* maintain;
  const candidate = (opportunityBytes: number) => ({checkoutId, opportunityBytes});
  return yield* maintain.pipe(
    Effect.tap(summary =>
      summary.action === 'compacted'
        ? Effect.void
        : recordCodeGraphAutomaticCompactionAttempt(
            threadnoteHome,
            candidate(codeGraphCompactionSummaryOpportunityBytes(summary)),
            {action: summary.action, reclaimedBytes: summary.reclaimedBytes},
          ),
    ),
    Effect.tapError(() => recordCodeGraphAutomaticCompactionAttempt(threadnoteHome, candidate(0), undefined)),
  );
});

function codeGraphCompactionSummaryOpportunityBytes(summary: CodeGraphCompactionSummary): number {
  if (!('before' in summary) || summary.before === undefined || summary.before.pageStorage.state !== 'available') {
    return 0;
  }
  return summary.before.pageStorage.compactionOpportunityBytes ?? summary.before.pageStorage.reclaimableBytes;
}

export function codeGraphCompactionRequiredFreeBytes(
  storage: Pick<CodeGraphActiveStorage, 'databaseBytes' | 'walBytes'>,
): number {
  // SQLite may need one database-sized temporary copy and another database-sized
  // rollback journal while VACUUM copies the compacted image back. Existing WAL
  // bytes and a separate safety margin remain additional conservative headroom.
  const vacuumWorkingBytes = storage.databaseBytes * 2 + storage.walBytes;
  const safetyMargin = Math.max(
    CODE_GRAPH_COMPACTION_MIN_SAFETY_MARGIN_BYTES,
    Math.ceil(vacuumWorkingBytes * CODE_GRAPH_COMPACTION_SAFETY_MARGIN_RATIO),
  );
  const required = vacuumWorkingBytes + safetyMargin;
  if (!Number.isSafeInteger(required) || required < 0) {
    throw CodeGraphStorageOperationError.make({
      message: 'Code graph compaction storage requirement exceeds the supported byte range.',
    });
  }
  return required;
}

const verifyCompactionDiskHeadroom = Effect.fn('codeGraph.verifyCompactionDiskHeadroom')(function* (
  system: SystemInfoShape,
  directory: string,
  storage: Pick<CodeGraphActiveStorage, 'databaseBytes' | 'walBytes'>,
) {
  const requiredBytes = codeGraphCompactionRequiredFreeBytes(storage);
  const availableBytes = yield* system.availableDiskBytes(directory).pipe(
    Effect.mapError(cause =>
      CodeGraphStorageOperationError.make({
        cause,
        message:
          `Could not inspect free disk space before code graph compaction. ` +
          `Verify at least ${requiredBytes.toLocaleString()} bytes are free and retry; the database was not modified.`,
      }),
    ),
  );
  if (availableBytes === undefined) {
    return yield* CodeGraphStorageOperationError.make({
      message:
        `Could not determine free disk space before code graph compaction. ` +
        `Verify at least ${requiredBytes.toLocaleString()} bytes are free and retry; the database was not modified.`,
    });
  }
  if (availableBytes < requiredBytes) {
    return yield* CodeGraphStorageOperationError.make({
      message:
        `Code graph compaction needs ${requiredBytes.toLocaleString()} bytes free, but only ` +
        `${availableBytes.toLocaleString()} bytes are available. Free disk space and retry; the database was not modified.`,
    });
  }
});

function regularFileBytes(
  fs: FileSystem.FileSystem,
  candidate: string,
): Effect.Effect<{readonly bytes: number; readonly state: 'available'} | {readonly state: 'missing'}, Error | unknown> {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
      return yield* CodeGraphStorageOperationError.make({
        message: `Refusing symbolic-link code graph storage path: ${candidate}`,
      });
    }
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (Option.isNone(info)) return {state: 'missing'} as const;
    if (info.value.type !== 'File') {
      return yield* CodeGraphStorageOperationError.make({
        message: `Code graph storage path is not a regular file: ${candidate}`,
      });
    }
    const bytes = Number(info.value.size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return yield* CodeGraphStorageOperationError.make({message: `Code graph storage size is invalid: ${candidate}`});
    }
    return {bytes, state: 'available'} as const;
  });
}

function readPageStorage(
  databasePath: string,
  attributeObjects: boolean,
  measureFragmentation: boolean,
): Effect.Effect<CodeGraphPageStorage, Error> {
  return Effect.try({
    try: () => {
      const database = new Database(databasePath, {readonly: true, strict: true});
      try {
        database.exec('PRAGMA busy_timeout = 50');
        const pageSize = pragmaNumber(database, 'page_size');
        const pageCount = pragmaNumber(database, 'page_count');
        const freelistPages = pragmaNumber(database, 'freelist_count');
        const reclaimableBytes = safeProduct(pageSize, freelistPages, 'reclaimable byte count');
        const reclaimableRatio = pageCount === 0 ? 0 : Math.min(1, freelistPages / pageCount);
        const attribution = attributeObjects
          ? readStorageAttribution(database, pageCount, pageSize, reclaimableBytes)
          : undefined;
        const measuredFragmentedBytes =
          attribution?.state === 'available'
            ? attribution.fragmentedBytes
            : measureFragmentation
              ? readFragmentedStorageBytes(database)
              : undefined;
        const fragmentedBytes = measuredFragmentedBytes ?? 0;
        const recommendation = codeGraphCompactionRecommendation({
          allocatedBytes: safeProduct(pageSize, pageCount, 'allocated storage bytes'),
          fragmentedBytes,
          reclaimableBytes,
        });
        return {
          ...(attribution ? {attribution} : {}),
          ...(measuredFragmentedBytes !== undefined
            ? {
                compactionOpportunityBytes: recommendation.compactionOpportunityBytes,
                compactionOpportunityRatio: recommendation.compactionOpportunityRatio,
                fragmentedBytes,
                fragmentationRatio: pageCount === 0 ? 0 : fragmentedBytes / (pageCount * pageSize),
              }
            : {}),
          freelistPages,
          pageCount,
          pageSize,
          reclaimableBytes,
          reclaimableRatio,
          state: 'available',
          threshold: recommendation,
        } satisfies CodeGraphPageStorage;
      } finally {
        database.close(false);
      }
    },
    catch: cause =>
      CodeGraphStorageOperationError.make({message: `Could not inspect code graph page storage: ${errorText(cause)}`}),
  });
}

function readFragmentedStorageBytes(database: Database): number | undefined {
  const dbstat = database
    .query<{readonly enabled: bigint | number}, []>("SELECT sqlite_compileoption_used('ENABLE_DBSTAT_VTAB') AS enabled")
    .get();
  if (safeCount(dbstat?.enabled ?? 0, 'dbstat availability') !== 1) return undefined;
  const row = database
    .query<{readonly bytes: bigint | number}, []>('SELECT COALESCE(SUM(unused), 0) AS bytes FROM dbstat')
    .get();
  return safeCount(row?.bytes ?? 0, 'fragmented storage bytes');
}

function readStorageAttribution(
  database: Database,
  pageCount: number,
  pageSize: number,
  freelistBytes: number,
): CodeGraphStorageAttribution {
  const dbstat = database
    .query<{readonly enabled: bigint | number}, []>("SELECT sqlite_compileoption_used('ENABLE_DBSTAT_VTAB') AS enabled")
    .get();
  if (safeCount(dbstat?.enabled ?? 0, 'dbstat availability') !== 1) {
    return {reason: 'sqlite-dbstat-unavailable', state: 'unavailable'};
  }
  const rows = database
    .query<
      {
        readonly bytes: bigint | number;
        readonly kind: CodeGraphStorageObjectAttribution['kind'];
        readonly name: string;
        readonly object_count: bigint | number;
        readonly pages: bigint | number;
        readonly total_bytes: bigint | number;
        readonly total_unused_bytes: bigint | number;
      },
      [number]
    >(
      `SELECT dbstat.name AS name,
              CASE
                WHEN dbstat.name = 'sqlite_schema' THEN 'internal'
                WHEN schema.type = 'index' THEN 'index'
                WHEN schema.type = 'table' THEN 'table'
                ELSE 'internal'
              END AS kind,
              SUM(dbstat.pgsize) AS bytes,
              COUNT(*) AS pages,
              SUM(SUM(dbstat.pgsize)) OVER () AS total_bytes,
              SUM(SUM(dbstat.unused)) OVER () AS total_unused_bytes,
              COUNT(*) OVER () AS object_count
         FROM dbstat
         LEFT JOIN sqlite_schema AS schema ON schema.name = dbstat.name
        GROUP BY dbstat.name, kind
        ORDER BY bytes DESC, dbstat.name ASC
        LIMIT ?`,
    )
    .all(CODE_GRAPH_STORAGE_SEMANTIC_OBJECT_LIMIT + 1);
  const semanticRows = EffectArray.map(rows.slice(0, CODE_GRAPH_STORAGE_SEMANTIC_OBJECT_LIMIT), row => ({
    bytes: safeCount(row.bytes, `storage object ${safeStorageObjectName(row.name)} bytes`),
    name: safeStorageObjectName(row.name),
    pages: safeCount(row.pages, `storage object ${safeStorageObjectName(row.name)} pages`),
  }));
  const attributedBytes = safeCount(rows[0]?.total_bytes ?? 0, 'attributed storage bytes');
  const fragmentedBytes = safeCount(rows[0]?.total_unused_bytes ?? 0, 'fragmented storage bytes');
  const objectCount = safeCount(rows[0]?.object_count ?? 0, 'attributed storage objects');
  const objectsTruncated = objectCount > CODE_GRAPH_STORAGE_ATTRIBUTION_OBJECT_LIMIT;
  const objects = EffectArray.map(rows.slice(0, CODE_GRAPH_STORAGE_ATTRIBUTION_OBJECT_LIMIT), row => ({
    bytes: safeCount(row.bytes, `storage object ${safeStorageObjectName(row.name)} bytes`),
    kind: row.kind,
    name: safeStorageObjectName(row.name),
    pages: safeCount(row.pages, `storage object ${safeStorageObjectName(row.name)} pages`),
  }));
  const allocatedBytes = safeProduct(pageCount, pageSize, 'allocated storage bytes');
  return {
    allocatedBytes,
    attributedBytes,
    freelistBytes,
    fragmentedBytes,
    objectCount,
    objects,
    objectsTruncated,
    semantic: readCodeGraphStorageSemanticAttribution(database, semanticRows, objectCount, attributedBytes),
    state: 'available',
    unattributedBytes: codeGraphStorageUnattributedBytes(allocatedBytes, attributedBytes, freelistBytes),
  };
}

function safeStorageObjectName(value: string): string {
  return /^[a-zA-Z0-9_]{1,128}$/.test(value) ? value : 'unrecognized-schema-object';
}

function readCompactionReceipt(databasePath: string): Effect.Effect<CodeGraphCompactionReceipt, Error> {
  return Effect.try({
    try: () => {
      const database = new Database(databasePath, {readonly: true, strict: true});
      try {
        database.exec('PRAGMA busy_timeout = 50');
        const integrity = database.query<{readonly quick_check?: string}, []>('PRAGMA quick_check').get();
        if (integrity?.quick_check !== 'ok')
          throw CodeGraphStorageOperationError.make({
            message: `quick_check returned ${integrity?.quick_check ?? 'no row'}`,
          });
        const schema = database
          .query<{readonly value?: string}, []>("SELECT value FROM schema_metadata WHERE key = 'schema_version'")
          .get();
        const schemaVersion = Number.parseInt(schema?.value ?? '', 10);
        if (schemaVersion !== CODE_GRAPH_SCHEMA_VERSION) {
          throw CodeGraphStorageOperationError.make({
            message: `schema version ${schema?.value ?? 'missing'} is not supported`,
          });
        }
        const stateRows = database
          .query<{readonly count: bigint | number; readonly state: CodeGraphSnapshot['state']}, []>(
            'SELECT state, COUNT(*) AS count FROM snapshots GROUP BY state ORDER BY state',
          )
          .all();
        const snapshotStates: Record<CodeGraphSnapshot['state'], number> = {
          building: 0,
          failed: 0,
          ready: 0,
          retired: 0,
        };
        for (const row of stateRows) snapshotStates[row.state] = safeCount(row.count, `snapshot state ${row.state}`);
        const active = database
          .query<{readonly count?: bigint | number}, []>('SELECT COUNT(*) AS count FROM active_snapshots')
          .get();
        return {
          activeSnapshots: safeCount(active?.count ?? 0, 'active snapshot'),
          schemaVersion,
          snapshotStates,
        } satisfies CodeGraphCompactionReceipt;
      } finally {
        database.close(false);
      }
    },
    catch: cause =>
      CodeGraphStorageOperationError.make({
        message: `Could not verify code graph compaction receipt: ${errorText(cause)}`,
      }),
  });
}

function vacuumDatabase(databasePath: string): Effect.Effect<void, Error> {
  return Effect.try({
    try: () => {
      const database = new Database(databasePath, {create: false, strict: true});
      try {
        database.exec('PRAGMA busy_timeout = 0');
        const before = database.query<{readonly busy?: number}, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (Number(before?.busy ?? 0) !== 0)
          throw CodeGraphStorageOperationError.make({
            message: 'active SQLite readers prevented the preflight checkpoint',
          });
        database.exec('VACUUM');
        const after = database.query<{readonly busy?: number}, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (Number(after?.busy ?? 0) !== 0)
          throw CodeGraphStorageOperationError.make({message: 'active SQLite readers prevented the final checkpoint'});
      } finally {
        database.close(false);
      }
    },
    catch: cause =>
      CodeGraphStorageOperationError.make({message: `Code graph compaction failed safely: ${errorText(cause)}`}),
  });
}

/**
 * Reclaim retained WAL allocation without VACUUM's replacement-database
 * headroom. A zero busy timeout turns active readers or writers into a safe
 * failure instead of queueing maintenance behind them.
 */
function reclaimWalStorage(databasePath: string): Effect.Effect<void, Error> {
  return Effect.try({
    try: () => {
      const database = new Database(databasePath, {create: false, strict: true});
      try {
        database.exec('PRAGMA busy_timeout = 0');
        database.exec(`PRAGMA journal_size_limit = ${CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
        const checkpoint = database.query<{readonly busy?: number}, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (Number(checkpoint?.busy ?? 0) !== 0) {
          throw CodeGraphStorageOperationError.make({message: 'active SQLite readers prevented WAL reclamation'});
        }
      } finally {
        database.close(false);
      }
    },
    catch: cause =>
      CodeGraphStorageOperationError.make({
        message: `Code graph WAL reclamation failed safely: ${errorText(cause)}`,
      }),
  });
}

function pragmaNumber(database: Database, pragma: 'freelist_count' | 'page_count' | 'page_size'): number {
  const row = database.query<Record<string, bigint | number>, []>(`PRAGMA ${pragma}`).get();
  return safeCount(row?.[pragma] ?? 0, pragma);
}

function safeCount(value: bigint | number, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0)
    throw CodeGraphStorageOperationError.make({message: `Invalid SQLite ${label}.`});
  return count;
}

function safeProduct(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0)
    throw CodeGraphStorageOperationError.make({message: `Invalid SQLite ${label}.`});
  return value;
}

function requireRegularFileIdentity(fs: FileSystem.FileSystem, candidate: string) {
  return fs
    .stat(candidate)
    .pipe(
      Effect.flatMap(info =>
        Effect.fromOption(fileIdentity(info), () =>
          CodeGraphStorageOperationError.make({message: 'Code graph database lacks stable identity metadata.'}),
        ),
      ),
    );
}

function verifyRegularFileIdentity(fs: FileSystem.FileSystem, candidate: string, expected: CodeGraphFileIdentity) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
      return yield* CodeGraphStorageOperationError.make({
        message: 'Code graph database became a symbolic link before compaction.',
      });
    }
    const current = yield* requireRegularFileIdentity(fs, candidate);
    if (!sameFileIdentity(expected, current)) {
      return yield* CodeGraphStorageOperationError.make({
        message: 'Code graph database changed before compaction; retry after current work finishes.',
      });
    }
  });
}

function fileIdentity(info: FileSystem.File.Info): Option.Option<CodeGraphFileIdentity> {
  const birthtime = Option.getOrUndefined(info.birthtime);
  const ino = Option.getOrUndefined(info.ino);
  const modifiedAt = Option.getOrUndefined(info.mtime);
  return info.type !== 'File' || birthtime === undefined || ino === undefined || modifiedAt === undefined
    ? Option.none()
    : Option.some({
        birthtimeMilliseconds: birthtime.getTime(),
        dev: info.dev,
        ino,
        modifiedAtMilliseconds: modifiedAt.getTime(),
        size: info.size,
      });
}

function sameFileIdentity(left: CodeGraphFileIdentity, right: CodeGraphFileIdentity): boolean {
  return (
    left.birthtimeMilliseconds === right.birthtimeMilliseconds &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.modifiedAtMilliseconds === right.modifiedAtMilliseconds &&
    left.size === right.size
  );
}

/** Journal reclamation may update mtime but must never swap the database target. */
function sameRegularFileTarget(left: CodeGraphFileIdentity, right: CodeGraphFileIdentity): boolean {
  return left.birthtimeMilliseconds === right.birthtimeMilliseconds && left.dev === right.dev && left.ino === right.ino;
}

function sameCompactionReceipt(left: CodeGraphCompactionReceipt, right: CodeGraphCompactionReceipt): boolean {
  return (
    left.activeSnapshots === right.activeSnapshots &&
    left.schemaVersion === right.schemaVersion &&
    left.snapshotStates.building === right.snapshotStates.building &&
    left.snapshotStates.failed === right.snapshotStates.failed &&
    left.snapshotStates.ready === right.snapshotStates.ready &&
    left.snapshotStates.retired === right.snapshotStates.retired
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
