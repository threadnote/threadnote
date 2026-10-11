import {Clock, Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import type {DoctorCheck} from '@threadnote/protocol/doctor';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {readOpenedFileSystemIdentity, readPathFileSystemIdentity} from '@threadnote/platform/system';
import {
  codeGraphMaintenanceLockPath,
  codeGraphRepositoriesRoot,
  codeGraphRepositoryLockPath,
  codeGraphRepositoryRoot,
} from './layout.js';
import {
  awaitCodeGraphWorktreeBuilds,
  codeGraphRepositoryLockActive,
  codeGraphWorktreeBuildActive,
  withCodeGraphDatabaseWriteLock,
  withCodeGraphReportedMaintenanceIntent,
  type CodeGraphMaintenanceProgress as CodeGraphReportedMaintenanceProgress,
  type CodeGraphMaintenanceProgressReporter,
} from './maintenance/gate.js';
import type {CodeGraphCliPurgeProgress} from './cli/progress.js';
import {CodeGraphStore, type CodeGraphDatabaseHealth} from './store.js';
import {CODE_GRAPH_SCHEMA_VERSION} from './types.js';
import {CODE_GRAPH_PERSISTENT_SCHEMA_CITATION_PREDECESSOR} from './store/schema/revision.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from './languages/registry.js';
import {diagnoseCodeGraphDatabaseReadOnly} from './store/health.js';
import {diagnoseCodeGraphDatabase} from './deep_diagnostics.js';
import {CODE_GRAPH_EXPLICIT_SCHEMA_PREPARATION_STEP_LIMIT} from './store/reconciliation/preparation.js';
import {codeGraphSchemaMigrationPreservesIncompleteSnapshots} from './store/schema/migration.js';

export {diagnoseCodeGraphDatabaseReadOnly} from './store/health.js';

class CodeGraphMaintenanceError extends Schema.TaggedError<CodeGraphMaintenanceError>()('CodeGraphMaintenanceError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface CodeGraphRepairSummary {
  readonly databases: number;
  readonly deferredDatabases: number;
  readonly discarded: number;
  readonly migratedDatabases: number;
  readonly obsoleteStoreBytes: number;
  readonly obsoleteStoreCheckouts: number;
  readonly obsoleteStoreFiles: number;
  readonly removedIncompleteSnapshots: number;
  readonly removedTemporaryFiles: number;
  readonly unsafeObsoleteEntries: number;
}

export interface ObsoleteCodeGraphStoreFile {
  readonly bytes: number;
  readonly checkoutId: string;
  readonly fileName: string;
  readonly kind: 'database' | 'shm' | 'wal';
  readonly path: string;
  readonly schemaVersion: number;
}

export interface ObsoleteCodeGraphStoreCheckout {
  readonly bytes: number;
  readonly checkoutId: string;
  readonly files: readonly ObsoleteCodeGraphStoreFile[];
  readonly versions: readonly number[];
}

export interface ObsoleteCodeGraphStoreInventory {
  readonly bytes: number;
  readonly checkouts: readonly ObsoleteCodeGraphStoreCheckout[];
  readonly fileCount: number;
  readonly unsafeEntryCount: number;
}

export interface ObsoleteCodeGraphStorePurgeSummary {
  readonly bytes: number;
  readonly checkoutId: string;
  readonly dryRun: boolean;
  readonly fileCount: number;
  readonly versions: readonly number[];
}

export interface ObsoleteCodeGraphStorePurgeInterlock {
  readonly beforeVerification?: (inventory: ObsoleteCodeGraphStoreInventory) => Effect.Effect<void>;
}

export interface CodeGraphIndexPurgeSummary {
  readonly checkoutId: string;
  readonly dryRun: boolean;
  readonly existed: boolean;
}

export interface CodeGraphIndexPurgeInterlock {
  readonly beforeRemoval?: () => Effect.Effect<void>;
  readonly beforeVerification?: () => Effect.Effect<void>;
}

interface CodeGraphIndexPurgeTarget {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly path: string;
}

export interface CodeGraphRepairCompletion {
  readonly doctorCheck: DoctorCheck;
  readonly summary: CodeGraphRepairSummary;
}

export interface CodeGraphRepairInterlock {
  /** @internal Deterministic race seam after the first worktree-builder drain. */
  readonly afterWorktreeDrain?: (database: string) => Effect.Effect<void, unknown>;
  /** @internal Deterministic filesystem-authority seam before spool cleanup verification. */
  readonly beforeSpoolCleanupVerification?: (repositoryRoot: string) => Effect.Effect<void, unknown>;
  /** @internal Deterministic race seam after authority verification and before quarantine. */
  readonly beforeSpoolQuarantine?: (spoolPath: string) => Effect.Effect<void, unknown>;
  /** @internal Deterministic race seam after quarantine verification and before removal. */
  readonly beforeSpoolRemoval?: (quarantinePath: string) => Effect.Effect<void, unknown>;
}

export interface CodeGraphMaintenanceProgress {
  readonly current: number;
  readonly phase:
    'checking' | 'cleaning-snapshots' | 'cleaning-vectors' | 'deferred' | 'discarding' | 'migrating-schema';
  readonly reason?: 'active-build' | 'deep-check-required' | 'schema-upgrade-on-use' | 'unreadable-database';
  readonly snapshots?: number;
  readonly total: number;
}

type CodeGraphProgressHandler = (progress: CodeGraphMaintenanceProgress) => Effect.Effect<void, unknown>;
type CodeGraphPurgeProgressHandler = (progress: CodeGraphCliPurgeProgress) => Effect.Effect<void, unknown>;
type CodeGraphRepairCompletionHandler<R> = (completion: CodeGraphRepairCompletion) => Effect.Effect<void, unknown, R>;
type CodeGraphQuickCheck =
  {readonly health: CodeGraphDatabaseHealth; readonly state: 'checked'} | {readonly state: 'unreadable'};

const OBSOLETE_GRAPH_FILE_PATTERN = /^graph-v([1-9]\d*)\.sqlite(?:-(wal|shm))?$/;
const MATERIALIZATION_SPOOL_FILE_PATTERN =
  /^materialization-spool-v(?:1|2)-(cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?)\.sqlite(?:-(?:journal|shm|wal))?$/u;

/**
 * Inventories obsolete checkout-local SQLite artifacts using directory metadata only.
 * It never opens a database or follows a symbolic link outside the checkout root.
 */
export const inspectObsoleteCodeGraphStores = Effect.fn('codeGraph.inspectObsoleteStores')(function* (
  threadnoteHome: string,
  checkoutId?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (checkoutId !== undefined && !/^[0-9a-f]{64}$/.test(checkoutId)) {
    return yield* CodeGraphMaintenanceError.make({message: 'Code graph checkout identity is invalid.'});
  }
  const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
  if (!(yield* fs.exists(repositories))) return emptyObsoleteInventory();
  if (yield* isSymbolicLink(fs, repositories)) {
    return {...emptyObsoleteInventory(), unsafeEntryCount: 1};
  }
  const repositoriesInfo = yield* fs.stat(repositories).pipe(Effect.option);
  if (repositoriesInfo._tag === 'None' || repositoriesInfo.value.type !== 'Directory') {
    return {...emptyObsoleteInventory(), unsafeEntryCount: 1};
  }
  const repositoriesRoot = yield* fs.realPath(repositories);
  const checkoutIds =
    checkoutId === undefined
      ? (yield* fs.readDirectory(repositories)).filter(value => /^[0-9a-f]{64}$/.test(value)).sort()
      : [checkoutId];
  const checkouts: ObsoleteCodeGraphStoreCheckout[] = [];
  let unsafeEntryCount = 0;
  for (const candidateCheckoutId of checkoutIds) {
    const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, candidateCheckoutId);
    if (!(yield* fs.exists(repositoryRoot))) continue;
    if (yield* isSymbolicLink(fs, repositoryRoot)) {
      unsafeEntryCount += 1;
      continue;
    }
    const repositoryInfo = yield* fs.stat(repositoryRoot).pipe(Effect.option);
    if (repositoryInfo._tag === 'None' || repositoryInfo.value.type !== 'Directory') {
      unsafeEntryCount += 1;
      continue;
    }
    const canonicalRepositoryRoot = yield* fs.realPath(repositoryRoot);
    if (!isContained(path, repositoriesRoot, canonicalRepositoryRoot)) {
      unsafeEntryCount += 1;
      continue;
    }
    const files: ObsoleteCodeGraphStoreFile[] = [];
    for (const fileName of (yield* fs.readDirectory(repositoryRoot)).sort()) {
      const parsed = obsoleteGraphFileName(fileName);
      if (!parsed) continue;
      const candidate = path.join(repositoryRoot, fileName);
      if (yield* isSymbolicLink(fs, candidate)) {
        unsafeEntryCount += 1;
        continue;
      }
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (info._tag === 'None' || info.value.type !== 'File') {
        unsafeEntryCount += 1;
        continue;
      }
      const canonical = yield* fs.realPath(candidate).pipe(Effect.option);
      if (
        canonical._tag === 'None' ||
        !isContained(path, canonicalRepositoryRoot, canonical.value) ||
        path.dirname(canonical.value) !== canonicalRepositoryRoot
      ) {
        unsafeEntryCount += 1;
        continue;
      }
      const size = Number(info.value.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        unsafeEntryCount += 1;
        continue;
      }
      files.push({
        bytes: size,
        checkoutId: candidateCheckoutId,
        fileName,
        kind: parsed.kind,
        path: canonical.value,
        schemaVersion: parsed.schemaVersion,
      });
    }
    if (files.length > 0) {
      checkouts.push({
        bytes: files.reduce((total, file) => total + file.bytes, 0),
        checkoutId: candidateCheckoutId,
        files,
        versions: [...new Set(files.map(file => file.schemaVersion))].sort((left, right) => left - right),
      });
    }
  }
  return {
    bytes: checkouts.reduce((total, entry) => total + entry.bytes, 0),
    checkouts,
    fileCount: checkouts.reduce((total, entry) => total + entry.files.length, 0),
    unsafeEntryCount,
  } satisfies ObsoleteCodeGraphStoreInventory;
});

export const codeGraphDoctorCheck = Effect.fn('codeGraph.doctorCheck')(function* (
  threadnoteHome: string,
  onProgress?: CodeGraphProgressHandler,
  precomputed?: DoctorCheck,
) {
  if (precomputed) return precomputed;
  const path = yield* Path.Path;
  const databases = yield* codeGraphDatabasePaths(threadnoteHome);
  const obsolete = yield* inspectObsoleteCodeGraphStores(threadnoteHome);
  if (databases.length === 0) return codeGraphDoctorResult(0, 0, 0, 0, 0, 0, obsolete);
  let ready = 0;
  let deferred = 0;
  let incomplete = 0;
  let migrationPending = 0;
  let unhealthy = 0;
  for (const [index, database] of databases.entries()) {
    yield* onProgress?.({current: index + 1, phase: 'checking', total: databases.length}) ?? Effect.void;
    const repositoryId = path.basename(path.dirname(database));
    const maintenanceDeferred =
      (yield* codeGraphRepositoryLockActive(threadnoteHome, repositoryId)) ||
      (yield* codeGraphWorktreeBuildActive(threadnoteHome, repositoryId));
    if (maintenanceDeferred) {
      deferred += 1;
      yield* onProgress?.({
        current: index + 1,
        phase: 'deferred',
        reason: 'active-build',
        total: databases.length,
      }) ?? Effect.void;
    }
    const checked = yield* diagnoseCodeGraphDatabaseReadOnly(database, false).pipe(
      Effect.map(health => ({health, state: 'checked'})),
      Effect.orElseSucceed((): CodeGraphQuickCheck => ({state: 'unreadable'})),
    );
    const health = checked.state === 'checked' ? checked.health : undefined;
    if (!health) {
      unhealthy += 1;
      continue;
    }
    if (health.integrity === 'migration-pending') {
      ready += health.readySnapshots;
      incomplete += health.buildingSnapshots + health.failedSnapshots;
      migrationPending += 1;
      continue;
    }
    if (health.integrity !== 'ok') {
      unhealthy += 1;
      continue;
    }
    ready += health.readySnapshots;
    incomplete += health.buildingSnapshots + health.failedSnapshots;
  }
  return codeGraphDoctorResult(databases.length, ready, incomplete, unhealthy, deferred, migrationPending, obsolete);
});

export const repairCodeGraphIndexes = Effect.fn('codeGraph.repairIndexes')(function* <R = never>(
  threadnoteHome: string,
  dryRun: boolean,
  onProgress?: CodeGraphProgressHandler,
  onComplete?: CodeGraphRepairCompletionHandler<R>,
  options: {
    readonly interlock?: CodeGraphRepairInterlock;
    readonly migrateSchema?: boolean;
    readonly mode?: 'deep' | 'quick';
    readonly targetCheckoutId?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  if (options.targetCheckoutId !== undefined && !/^[0-9a-f]{64}$/.test(options.targetCheckoutId)) {
    return yield* CodeGraphMaintenanceError.make({message: 'Code graph checkout identity is invalid.'});
  }
  const repair = (reporter?: CodeGraphMaintenanceProgressReporter) =>
    Effect.gen(function* () {
      const allDatabases = yield* codeGraphDatabasePaths(threadnoteHome);
      const allRepositoryCheckoutIds = yield* codeGraphRepositoryCheckoutIds(threadnoteHome);
      const repositoryCheckoutIds =
        options.targetCheckoutId === undefined
          ? allRepositoryCheckoutIds
          : allRepositoryCheckoutIds.filter(checkoutId => checkoutId === options.targetCheckoutId);
      const databases =
        options.targetCheckoutId === undefined
          ? allDatabases
          : allDatabases.filter(database => path.basename(path.dirname(database)) === options.targetCheckoutId);
      const obsoleteBefore =
        options.targetCheckoutId === undefined
          ? yield* inspectObsoleteCodeGraphStores(threadnoteHome)
          : emptyObsoleteInventory();
      const deep = options.mode !== 'quick';
      let deferredDatabases = 0;
      let databaseCount = databases.length;
      let discarded = 0;
      let migratedDatabases = 0;
      let removedIncompleteSnapshots = 0;
      let remainingIncompleteSnapshots = 0;
      let removedTemporaryFiles = 0;
      let readySnapshots = 0;
      const reportedTotal = Math.max(1, databases.length);
      yield* reporter?.progress({completed: 0, phase: 'acquiring-gates', total: reportedTotal}) ?? Effect.void;
      for (const [index, database] of databases.entries()) {
        const progress = (input: Omit<CodeGraphMaintenanceProgress, 'current' | 'total'>) =>
          (reporter?.progress(repairReportedProgress(index + 1, reportedTotal, input.phase)) ?? Effect.void).pipe(
            Effect.andThen(onProgress?.({current: index + 1, total: databases.length, ...input}) ?? Effect.void),
          );
        yield* progress({phase: 'checking'});
        const repositoryRoot = path.dirname(database);
        const maintained = yield* withDatabaseLock(
          fs,
          path,
          threadnoteHome,
          database,
          Effect.gen(function* () {
            const decision = yield* Effect.scoped(
              Effect.gen(function* () {
                const checkoutId = path.basename(repositoryRoot);
                const repositoryTarget = yield* openCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
                if (repositoryTarget === undefined) {
                  return yield* CodeGraphMaintenanceError.make({
                    message: 'Code graph checkout target changed before repair.',
                  });
                }
                return yield* store.withSession(
                  database,
                  Effect.gen(function* () {
                    let diagnosed = yield* diagnoseCodeGraphDatabase(threadnoteHome, database, deep).pipe(
                      Effect.option,
                    );
                    let previewingSchemaMigration = false;
                    let previewedMigrationPreservesIncompleteSnapshots = false;
                    // A same-name alias index can belong to another table or carry
                    // incompatible keys. The initializer must never bless that drift.
                    // Quick repair preserves the derived store for an explicit deep
                    // decision; deep repair can discard it identically in preview and
                    // apply without claiming that schema migration succeeded.
                    if (
                      diagnosed._tag === 'Some' &&
                      diagnosed.value.integrity === 'incompatible' &&
                      (diagnosed.value.snapshotFileCitationBaseIndexes === 'incompatible' ||
                        diagnosed.value.snapshotFileCitationSchema === 'incompatible' ||
                        diagnosed.value.snapshotFileCitationSchema === 'column-only-with-authority' ||
                        (diagnosed.value.snapshotFileCitationSchema === 'released-absent-with-authority' &&
                          diagnosed.value.persistentExtensionSchemaRevision !==
                            CODE_GRAPH_PERSISTENT_SCHEMA_CITATION_PREDECESSOR.value))
                    ) {
                      return deep ? ('discard' as const) : ('schema-upgrade-on-use' as const);
                    }
                    const schemaMigrationPreservesIncompleteSnapshots =
                      diagnosed._tag === 'Some' &&
                      codeGraphSchemaMigrationPreservesIncompleteSnapshots(
                        diagnosed.value.persistentExtensionSchemaRevision,
                        diagnosed.value.snapshotFileCitationSchema,
                        diagnosed.value.snapshotFileCitationBaseIndexes,
                      );
                    if (
                      diagnosed._tag === 'Some' &&
                      diagnosed.value?.schemaVersion === CODE_GRAPH_SCHEMA_VERSION &&
                      (diagnosed.value.integrity === 'incompatible' ||
                        diagnosed.value.integrity === 'migration-pending')
                    ) {
                      if (options.migrateSchema) {
                        yield* progress({phase: 'migrating-schema'});
                        if (dryRun) {
                          if (
                            diagnosed.value.integrity === 'migration-pending' ||
                            schemaMigrationPreservesIncompleteSnapshots
                          ) {
                            const preparation = yield* store.prepareWorktreeReconciliationIndexes(database, {
                              preview: true,
                            });
                            if (preparation.state === 'deferred') return 'schema-upgrade-on-use' as const;
                            previewedMigrationPreservesIncompleteSnapshots =
                              codeGraphSchemaMigrationPreservesIncompleteSnapshots(
                                diagnosed.value.persistentExtensionSchemaRevision,
                                diagnosed.value.snapshotFileCitationSchema,
                                diagnosed.value.snapshotFileCitationBaseIndexes,
                              );
                          }
                          migratedDatabases += 1;
                          previewingSchemaMigration = true;
                        } else {
                          if (
                            diagnosed.value.integrity === 'migration-pending' ||
                            schemaMigrationPreservesIncompleteSnapshots
                          ) {
                            let preparation = yield* store.prepareWorktreeReconciliationIndexes(database);
                            for (
                              let step = 1;
                              preparation.state === 'prepared' &&
                              step < CODE_GRAPH_EXPLICIT_SCHEMA_PREPARATION_STEP_LIMIT;
                              step += 1
                            ) {
                              preparation = yield* store.prepareWorktreeReconciliationIndexes(database);
                            }
                            if (preparation.state === 'deferred') return 'schema-upgrade-on-use' as const;
                          }
                          yield* store.initialize(database);
                          diagnosed = yield* diagnoseCodeGraphDatabase(threadnoteHome, database, deep).pipe(
                            Effect.option,
                          );
                          if (diagnosed._tag === 'Some' && diagnosed.value?.integrity === 'ok') {
                            migratedDatabases += 1;
                          } else {
                            return 'schema-upgrade-on-use' as const;
                          }
                        }
                      } else {
                        // Same-version beta databases with a missing revision or an
                        // incompatible extension-table contract are recoverable on the
                        // next ordinary writer open.
                        // Never discard their ready snapshots as if the canonical graph
                        // rows were corrupt merely because this maintenance pass is
                        // deliberately read-only while holding the checkout gate.
                        return 'schema-upgrade-on-use' as const;
                      }
                    }
                    // A failed diagnostic is not evidence of corruption. In particular,
                    // transient I/O, permissions, or an unreadable schema must never turn
                    // an explicit deep check into recursive deletion of the graph store.
                    if (diagnosed._tag === 'None') {
                      return deep ? ('unreadable-database' as const) : ('deep-check-required' as const);
                    }
                    if (!previewingSchemaMigration && diagnosed.value.integrity !== 'ok') {
                      return deep ? ('discard' as const) : ('deep-check-required' as const);
                    }
                    const incomplete = diagnosed.value.buildingSnapshots + diagnosed.value.failedSnapshots;
                    let retainedIncompleteSnapshotIds: readonly string[] = [];
                    readySnapshots += diagnosed.value.readySnapshots;
                    if (!deep && incomplete > 0) return 'deep-check-required' as const;
                    if (!deep) return 'maintained' as const;
                    if (
                      incomplete > 0 &&
                      (!previewingSchemaMigration || previewedMigrationPreservesIncompleteSnapshots)
                    ) {
                      yield* progress({phase: 'cleaning-snapshots', snapshots: incomplete});
                      const repaired = yield* store.repair(database, dryRun, {
                        allowSchemaMigrationPreview: previewedMigrationPreservesIncompleteSnapshots,
                      });
                      const removed = repaired?.removedSnapshots ?? 0;
                      retainedIncompleteSnapshotIds = repaired?.retainedIncompleteSnapshotIds ?? [];
                      removedIncompleteSnapshots += removed;
                      remainingIncompleteSnapshots += Math.max(0, incomplete - removed);
                    }
                    // Build-time cache GC can delete parser facts belonging to another
                    // linked worktree before that worktree activates its snapshot. This
                    // path has drained every worktree lock for the checkout, so
                    // it is safe to collect cache facts shared by its linked worktrees.
                    if (!dryRun) {
                      yield* store.pruneRetiredSnapshots(database);
                      yield* store.pruneCachedFacts(database, BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentities);
                    }
                    yield* progress({phase: 'cleaning-vectors'});
                    yield* options.interlock?.beforeSpoolCleanupVerification?.(repositoryTarget.path) ?? Effect.void;
                    removedTemporaryFiles += yield* cleanTemporaryMaterializationSpoolFiles(
                      fs,
                      path,
                      threadnoteHome,
                      checkoutId,
                      repositoryTarget,
                      new Set(retainedIncompleteSnapshotIds),
                      dryRun,
                      options.interlock,
                    );
                    removedTemporaryFiles += yield* cleanTemporaryVectorFiles(
                      fs,
                      path,
                      threadnoteHome,
                      checkoutId,
                      repositoryTarget,
                      path.join(repositoryRoot, 'vectors'),
                      dryRun,
                      options.interlock,
                    );
                    return 'maintained' as const;
                  }),
                  {writerGateHeld: true},
                );
              }),
            );
            if (decision !== 'discard') return decision;

            // The session-scoped SqliteClient has finalized before this branch.
            // Keep the repository and database writer gates held while closing
            // the handle first, otherwise Windows rejects recursive deletion of
            // the incompatible SQLite store with a sharing violation.
            discarded += 1;
            yield* progress({phase: 'discarding'});
            if (!dryRun) yield* fs.remove(repositoryRoot, {force: true, recursive: true});
            return 'maintained' as const;
          }),
          0,
          options.interlock?.afterWorktreeDrain,
        ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed('active-build' as const)));
        if (maintained !== 'maintained') {
          deferredDatabases += 1;
          yield* progress({
            phase: 'deferred',
            reason: maintained,
          });
        }
      }
      const databaseCheckoutIds = new Set(databases.map(database => path.basename(path.dirname(database))));
      const spoolOnlyCheckoutIds = deep
        ? repositoryCheckoutIds.filter(checkoutId => !databaseCheckoutIds.has(checkoutId))
        : [];
      for (const checkoutId of spoolOnlyCheckoutIds) {
        const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
        const database = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
        const cleaned = yield* withDatabaseLock(
          fs,
          path,
          threadnoteHome,
          database,
          Effect.scoped(
            Effect.gen(function* () {
              // The root was database-less during inventory, but a builder may
              // have completed before this checkout's gates were acquired. Do
              // not apply the empty-retention model to its newly durable state.
              if (yield* fs.exists(database)) return undefined;
              const repositoryTarget = yield* openCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
              if (repositoryTarget === undefined) return 0;
              yield* options.interlock?.beforeSpoolCleanupVerification?.(repositoryTarget.path) ?? Effect.void;
              return yield* cleanTemporaryMaterializationSpoolFiles(
                fs,
                path,
                threadnoteHome,
                checkoutId,
                repositoryTarget,
                new Set(),
                dryRun,
                options.interlock,
              );
            }),
          ),
          0,
          options.interlock?.afterWorktreeDrain,
        ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed(0)));
        if (cleaned === undefined) {
          databaseCount += 1;
          deferredDatabases += 1;
        } else {
          removedTemporaryFiles += cleaned;
        }
      }
      const currentDatabases =
        options.targetCheckoutId === undefined
          ? yield* codeGraphDatabasePaths(threadnoteHome)
          : (yield* codeGraphDatabasePaths(threadnoteHome)).filter(
              database => path.basename(path.dirname(database)) === options.targetCheckoutId,
            );
      const obsolete =
        options.targetCheckoutId !== undefined
          ? emptyObsoleteInventory()
          : dryRun
            ? obsoleteBefore
            : yield* inspectObsoleteCodeGraphStores(threadnoteHome);
      const summary = {
        databases: databaseCount,
        deferredDatabases,
        discarded,
        migratedDatabases,
        obsoleteStoreBytes: obsolete.bytes,
        obsoleteStoreCheckouts: obsolete.checkouts.length,
        obsoleteStoreFiles: obsolete.fileCount,
        removedIncompleteSnapshots,
        removedTemporaryFiles,
        unsafeObsoleteEntries: obsolete.unsafeEntryCount,
      } satisfies CodeGraphRepairSummary;
      yield* onComplete?.({
        doctorCheck: codeGraphDoctorResult(
          currentDatabases.length,
          readySnapshots,
          dryRun ? removedIncompleteSnapshots + remainingIncompleteSnapshots : remainingIncompleteSnapshots,
          dryRun ? discarded : 0,
          deferredDatabases,
          dryRun ? migratedDatabases : 0,
          obsolete,
        ),
        summary,
      }) ?? Effect.void;
      return summary;
    });
  if (options.targetCheckoutId !== undefined) {
    // The checkout gate plus the under-writer-gate builder recheck isolates this
    // repository without pausing builders for unrelated checkouts.
    return yield* repair();
  }
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    CODE_GRAPH_LOCK_OPTIONS,
    withCodeGraphReportedMaintenanceIntent(
      threadnoteHome,
      {operation: 'graph-maintenance'},
      {completed: 0, phase: 'acquiring-gates', total: 1},
      reporter => repair(reporter),
    ),
  );
});

function codeGraphDoctorResult(
  databases: number,
  readySnapshots: number,
  incompleteSnapshots: number,
  unhealthyDatabases: number,
  deferredDatabases = 0,
  migrationPendingDatabases = 0,
  obsolete = emptyObsoleteInventory(),
): DoctorCheck {
  if (databases === 0 && obsolete.fileCount === 0 && obsolete.unsafeEntryCount === 0) {
    return {
      detail: 'no repository graph built yet; `threadnote graph query` builds one lazily',
      name: 'native code graph',
      status: 'ok',
    };
  }
  return {
    detail:
      `${databases} database(s); ${readySnapshots} ready snapshot(s); ${incompleteSnapshots} incomplete snapshot(s)` +
      (unhealthyDatabases > 0 ? `; ${unhealthyDatabases} database(s) need a disposable rebuild` : '') +
      (deferredDatabases > 0 ? `; ${deferredDatabases} database maintenance check(s) deferred` : '') +
      (migrationPendingDatabases > 0
        ? `; ${migrationPendingDatabases} database(s) remain usable while background schema migration is pending`
        : '') +
      (obsolete.fileCount > 0
        ? `; ${obsolete.fileCount} obsolete store file(s), ${obsolete.bytes} byte(s), across ${obsolete.checkouts.length} checkout(s); run \`threadnote graph purge --obsolete\``
        : '') +
      (obsolete.unsafeEntryCount > 0
        ? `; ${obsolete.unsafeEntryCount} unsafe obsolete-shaped filesystem entry/entries require manual review`
        : ''),
    name: 'native code graph',
    status:
      unhealthyDatabases > 0 || obsolete.unsafeEntryCount > 0
        ? 'fail'
        : incompleteSnapshots > 0 || deferredDatabases > 0 || migrationPendingDatabases > 0 || obsolete.fileCount > 0
          ? 'warn'
          : 'ok',
  };
}

export const codeGraphDatabasePaths = Effect.fn('codeGraph.databasePaths')(function* (threadnoteHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
  if ((yield* fs.readLink(repositories).pipe(Effect.option))._tag === 'Some') return [];
  if (!(yield* fs.exists(repositories))) return [];
  const output: string[] = [];
  for (const repositoryId of yield* fs.readDirectory(repositories)) {
    if (!/^[0-9a-f]{64}$/.test(repositoryId)) continue;
    const repositoryRoot = path.join(repositories, repositoryId);
    if ((yield* fs.readLink(repositoryRoot).pipe(Effect.option))._tag === 'Some') continue;
    const repositoryInfo = yield* fs.stat(repositoryRoot).pipe(Effect.option);
    if (repositoryInfo._tag === 'None' || repositoryInfo.value.type !== 'Directory') continue;
    const database = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    if ((yield* fs.readLink(database).pipe(Effect.option))._tag === 'Some') continue;
    const databaseInfo = yield* fs.stat(database).pipe(Effect.option);
    if (databaseInfo._tag === 'Some' && databaseInfo.value.type === 'File') output.push(database);
  }
  return output.sort();
});

function codeGraphRepositoryCheckoutIds(threadnoteHome: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
    if (Option.isSome(yield* fs.readLink(repositories).pipe(Effect.option))) return [];
    const info = yield* fs.stat(repositories).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== 'Directory') return [];
    return (yield* fs.readDirectory(repositories)).filter(name => /^[0-9a-f]{64}$/u.test(name)).sort();
  });
}

function repairReportedProgress(
  current: number,
  total: number,
  phase: CodeGraphMaintenanceProgress['phase'],
): CodeGraphReportedMaintenanceProgress {
  const safeTotal = Math.max(1, total);
  return {
    completed: Math.min(safeTotal, Math.max(0, current)),
    phase:
      phase === 'cleaning-snapshots' || phase === 'cleaning-vectors' || phase === 'discarding'
        ? 'retiring-and-cleaning'
        : 'verifying-graph',
    total: safeTotal,
  };
}

function publishPurgeProgress(
  reporter: CodeGraphMaintenanceProgressReporter,
  onProgress: CodeGraphPurgeProgressHandler | undefined,
  dryRun: boolean,
  input: {
    readonly checkoutCurrent?: number;
    readonly checkoutTotal?: number;
    readonly completed: number;
    readonly filesRemoved?: number;
    readonly filesTotal?: number;
    readonly gate: CodeGraphReportedMaintenanceProgress['phase'];
    readonly phase: CodeGraphCliPurgeProgress['phase'];
    readonly total: number;
  },
) {
  return reporter.progress({completed: input.completed, phase: input.gate, total: input.total}).pipe(
    Effect.andThen(
      onProgress?.({
        ...(input.checkoutCurrent === undefined ? {} : {checkoutCurrent: input.checkoutCurrent}),
        ...(input.checkoutTotal === undefined ? {} : {checkoutTotal: input.checkoutTotal}),
        dryRun,
        ...(input.filesRemoved === undefined ? {} : {filesRemoved: input.filesRemoved}),
        ...(input.filesTotal === undefined ? {} : {filesTotal: input.filesTotal}),
        phase: input.phase,
      }) ?? Effect.void,
    ),
  );
}

/**
 * Explicitly removes only older schema-version SQLite artifacts from one checkout.
 * Both maintenance and checkout locks are attempted once; an active build or repair
 * causes an immediate failure rather than a surprising wait.
 */
export const purgeObsoleteCodeGraphStores = Effect.fn('codeGraph.purgeObsoleteStores')(function* (
  threadnoteHome: string,
  checkoutId: string,
  options: {
    readonly dryRun: boolean;
    readonly interlock?: ObsoleteCodeGraphStorePurgeInterlock;
    readonly onProgress?: CodeGraphPurgeProgressHandler;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!/^[0-9a-f]{64}$/.test(checkoutId)) {
    return yield* CodeGraphMaintenanceError.make({message: 'Code graph checkout identity is invalid.'});
  }
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    CODE_GRAPH_PURGE_LOCK_OPTIONS,
    withCodeGraphReportedMaintenanceIntent(
      threadnoteHome,
      {checkoutId, operation: 'graph-maintenance'},
      {completed: 0, phase: 'acquiring-gates', total: 4},
      reporter =>
        withExclusiveFileLock(
          fs,
          codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId),
          CODE_GRAPH_PURGE_LOCK_OPTIONS,
          Effect.gen(function* () {
            yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
              completed: 1,
              gate: 'waiting-builders',
              phase: 'waiting-builders',
              total: 4,
            });
            yield* awaitCodeGraphWorktreeBuilds(threadnoteHome, checkoutId, 0);
            return yield* withCodeGraphDatabaseWriteLock(
              threadnoteHome,
              checkoutId,
              Effect.gen(function* () {
                yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
                  completed: 2,
                  gate: 'verifying-graph',
                  phase: 'verifying',
                  total: 4,
                });
                const initial = yield* inspectObsoleteCodeGraphStores(threadnoteHome, checkoutId);
                yield* refuseUnsafeObsoleteInventory(initial);
                yield* options.interlock?.beforeVerification?.(initial) ?? Effect.void;
                const verified = yield* inspectObsoleteCodeGraphStores(threadnoteHome, checkoutId);
                yield* refuseUnsafeObsoleteInventory(verified);
                const checkout = verified.checkouts.find(entry => entry.checkoutId === checkoutId);
                const files = checkout?.files ?? [];
                yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
                  completed: 3,
                  filesRemoved: 0,
                  filesTotal: files.length,
                  gate: 'retiring-and-cleaning',
                  phase: 'removing-obsolete',
                  total: 4,
                });
                if (!options.dryRun) {
                  for (const file of files) {
                    yield* verifyObsoletePurgeTarget(fs, path, threadnoteHome, checkoutId, file);
                  }
                  for (const [index, file] of files.entries()) {
                    yield* fs.remove(file.path);
                    yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
                      completed: 4,
                      filesRemoved: index + 1,
                      filesTotal: files.length,
                      gate: 'retiring-and-cleaning',
                      phase: 'deleting',
                      total: 4,
                    });
                  }
                }
                yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
                  completed: 4,
                  filesRemoved: files.length,
                  filesTotal: files.length,
                  gate: 'retiring-and-cleaning',
                  phase: 'deleting',
                  total: 4,
                });
                return {
                  bytes: checkout?.bytes ?? 0,
                  checkoutId,
                  dryRun: options.dryRun,
                  fileCount: files.length,
                  versions: checkout?.versions ?? [],
                } satisfies ObsoleteCodeGraphStorePurgeSummary;
              }),
              0,
            );
          }),
        ),
    ),
  );
});

/**
 * Removes one checkout-local disposable graph store without resolving a source worktree.
 * The checkout root is derived from a validated identity, checked twice under all graph
 * maintenance locks, and must remain an immediate non-symbolic-link child of the graph
 * repositories directory.
 */
export const purgeCodeGraphIndex = Effect.fn('codeGraph.purgeIndex')(function* (
  threadnoteHome: string,
  checkoutId: string,
  options: {
    readonly dryRun: boolean;
    readonly interlock?: CodeGraphIndexPurgeInterlock;
    readonly onProgress?: CodeGraphPurgeProgressHandler;
    readonly waitTimeoutMilliseconds?: number;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  if (!/^[0-9a-f]{64}$/.test(checkoutId)) {
    return yield* CodeGraphMaintenanceError.make({message: 'Code graph checkout identity is invalid.'});
  }
  const waitTimeoutMilliseconds = options.waitTimeoutMilliseconds ?? 0;
  const lockOptions = {...CODE_GRAPH_PURGE_LOCK_OPTIONS, waitTimeoutMilliseconds};
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    lockOptions,
    withCodeGraphReportedMaintenanceIntent(
      threadnoteHome,
      {checkoutId, operation: 'graph-maintenance'},
      {completed: 0, phase: 'acquiring-gates', total: 5},
      reporter =>
        withExclusiveFileLock(
          fs,
          codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId),
          lockOptions,
          Effect.gen(function* () {
            yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
              completed: 1,
              gate: 'waiting-builders',
              phase: 'waiting-builders',
              total: 5,
            });
            yield* awaitCodeGraphWorktreeBuilds(threadnoteHome, checkoutId, waitTimeoutMilliseconds);
            return yield* withCodeGraphDatabaseWriteLock(
              threadnoteHome,
              checkoutId,
              Effect.gen(function* () {
                const purgeTarget = yield* Effect.scoped(
                  Effect.gen(function* () {
                    // Keep the original directory open until it has been moved into quarantine.
                    // POSIX may recycle a deleted directory's inode immediately; the live handle
                    // prevents that replacement from comparing equal to the planned target.
                    yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
                      completed: 2,
                      gate: 'verifying-graph',
                      phase: 'verifying',
                      total: 5,
                    });
                    const initial = yield* openCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
                    yield* options.interlock?.beforeVerification?.() ?? Effect.void;
                    const verified = yield* inspectCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
                    if (!sameCodeGraphIndexPurgeTarget(initial, verified)) {
                      return yield* CodeGraphMaintenanceError.make({
                        message: 'Code graph checkout target changed before purge.',
                      });
                    }
                    if (verified === undefined || options.dryRun) {
                      return {existed: verified !== undefined, quarantine: undefined};
                    }

                    yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
                      completed: 3,
                      gate: 'retiring-and-cleaning',
                      phase: 'quarantining',
                      total: 5,
                    });
                    yield* options.interlock?.beforeRemoval?.() ?? Effect.void;
                    const quarantine = path.join(
                      path.dirname(verified.path),
                      `.${checkoutId}.${yield* crypto.randomUUIDv4()}.purging`,
                    );
                    yield* fs.rename(verified.path, quarantine);
                    const moved = yield* inspectQuarantinedCodeGraphIndexPurgeTarget(fs, quarantine);
                    if (!sameCodeGraphIndexPurgeTarget(verified, moved)) {
                      yield* restoreQuarantinedCodeGraphIndexPurgeTarget(fs, quarantine, verified.path);
                      return yield* CodeGraphMaintenanceError.make({
                        message: 'Code graph checkout target changed before purge.',
                      });
                    }
                    return {existed: true, quarantine};
                  }),
                );
                if (purgeTarget.quarantine !== undefined) {
                  yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
                    completed: 4,
                    gate: 'retiring-and-cleaning',
                    phase: 'deleting',
                    total: 5,
                  });
                  // Close the directory handle before recursive deletion for Windows parity.
                  yield* fs.remove(purgeTarget.quarantine, {force: true, recursive: true});
                }
                yield* publishPurgeProgress(reporter, options.onProgress, options.dryRun, {
                  completed: 5,
                  gate: 'retiring-and-cleaning',
                  phase: 'deleting',
                  total: 5,
                });
                return {
                  checkoutId,
                  dryRun: options.dryRun,
                  existed: purgeTarget.existed,
                } satisfies CodeGraphIndexPurgeSummary;
              }),
              waitTimeoutMilliseconds,
            );
          }),
        ),
    ),
  );
});

export const purgeCodeGraphRepositoryRoot = Effect.fn('codeGraph.purgeRepositoryRoot')(function* (
  threadnoteHome: string,
  checkoutId: string,
  repositoryRoot: string,
  onProgress?: CodeGraphPurgeProgressHandler,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    CODE_GRAPH_LOCK_OPTIONS,
    withCodeGraphReportedMaintenanceIntent(
      threadnoteHome,
      {checkoutId, operation: 'graph-maintenance'},
      {completed: 0, phase: 'acquiring-gates', total: 3},
      reporter =>
        withExclusiveFileLock(
          fs,
          codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId),
          CODE_GRAPH_LOCK_OPTIONS,
          Effect.gen(function* () {
            yield* publishPurgeProgress(reporter, onProgress, false, {
              completed: 1,
              gate: 'waiting-builders',
              phase: 'waiting-builders',
              total: 3,
            });
            yield* awaitCodeGraphWorktreeBuilds(
              threadnoteHome,
              checkoutId,
              CODE_GRAPH_LOCK_OPTIONS.waitTimeoutMilliseconds,
            );
            yield* publishPurgeProgress(reporter, onProgress, false, {
              completed: 2,
              gate: 'retiring-and-cleaning',
              phase: 'deleting',
              total: 3,
            });
            yield* withCodeGraphDatabaseWriteLock(
              threadnoteHome,
              checkoutId,
              fs.remove(repositoryRoot, {recursive: true, force: true}),
            );
            yield* publishPurgeProgress(reporter, onProgress, false, {
              completed: 3,
              gate: 'retiring-and-cleaning',
              phase: 'deleting',
              total: 3,
            });
          }),
        ),
    ),
  );
  return repositoryRoot;
});

export const purgeAllCodeGraphIndexes = Effect.fn('codeGraph.purgeAllIndexes')(function* (
  threadnoteHome: string,
  onProgress?: CodeGraphPurgeProgressHandler,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    CODE_GRAPH_LOCK_OPTIONS,
    withCodeGraphReportedMaintenanceIntent(
      threadnoteHome,
      {operation: 'graph-maintenance'},
      {completed: 0, phase: 'acquiring-gates', total: 1},
      reporter =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(repositories))) return path.dirname(repositories);
          if ((yield* fs.readLink(repositories).pipe(Effect.option))._tag === 'Some') {
            yield* fs.remove(repositories, {force: true});
            return path.dirname(repositories);
          }
          const repositoryIds = (yield* fs.readDirectory(repositories))
            .filter(name => /^[0-9a-f]{64}$/.test(name))
            .sort();
          const total = Math.max(1, repositoryIds.length);
          yield* reporter.progress({completed: 0, phase: 'waiting-builders', total});
          for (const [index, repositoryId] of repositoryIds.entries()) {
            const repositoryRoot = path.join(repositories, repositoryId);
            if ((yield* fs.readLink(repositoryRoot).pipe(Effect.option))._tag === 'Some') continue;
            yield* publishPurgeProgress(reporter, onProgress, false, {
              checkoutCurrent: index + 1,
              checkoutTotal: repositoryIds.length,
              completed: index + 1,
              gate: 'waiting-builders',
              phase: 'waiting-builders',
              total,
            });
            yield* withExclusiveFileLock(
              fs,
              codeGraphRepositoryLockPath(path, threadnoteHome, repositoryId),
              CODE_GRAPH_LOCK_OPTIONS,
              awaitCodeGraphWorktreeBuilds(
                threadnoteHome,
                repositoryId,
                CODE_GRAPH_LOCK_OPTIONS.waitTimeoutMilliseconds,
              ).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    yield* publishPurgeProgress(reporter, onProgress, false, {
                      checkoutCurrent: index + 1,
                      checkoutTotal: repositoryIds.length,
                      completed: index + 1,
                      gate: 'retiring-and-cleaning',
                      phase: 'deleting',
                      total,
                    });
                    yield* withCodeGraphDatabaseWriteLock(
                      threadnoteHome,
                      repositoryId,
                      fs.remove(repositoryRoot, {force: true, recursive: true}),
                    );
                  }),
                ),
              ),
            );
          }
          const graphRoot = path.dirname(repositories);
          yield* publishPurgeProgress(reporter, onProgress, false, {
            checkoutCurrent: repositoryIds.length,
            checkoutTotal: repositoryIds.length,
            completed: total,
            gate: 'retiring-and-cleaning',
            phase: 'deleting',
            total,
          });
          yield* fs.remove(graphRoot, {force: true, recursive: true});
          return graphRoot;
        }),
    ),
  );
});

function cleanTemporaryVectorFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  repositoryTarget: CodeGraphIndexPurgeTarget,
  directory: string,
  dryRun: boolean,
  interlock?: CodeGraphRepairInterlock,
): Effect.Effect<number, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const verified = yield* inspectCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
    if (!sameCodeGraphIndexPurgeTarget(repositoryTarget, verified)) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Code graph checkout target changed before temporary-file cleanup.',
      });
    }
    if ((yield* fs.readLink(directory).pipe(Effect.option))._tag === 'Some') return 0;
    if (!(yield* fs.exists(directory))) return 0;
    const root = yield* fs.realPath(directory);
    if (!isContained(path, repositoryTarget.path, root)) return 0;
    return yield* cleanTemporaryVectorFilesContained(
      fs,
      path,
      threadnoteHome,
      checkoutId,
      repositoryTarget,
      root,
      root,
      dryRun,
      interlock,
    );
  });
}

/** @internal Exact basename parser shared with spool-repair property tests. */
export function codeGraphTemporaryMaterializationSpoolSnapshotId(fileName: string): string | undefined {
  return MATERIALIZATION_SPOOL_FILE_PATTERN.exec(fileName)?.[1];
}

function cleanTemporaryMaterializationSpoolFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  repositoryTarget: CodeGraphIndexPurgeTarget,
  retainedIncompleteSnapshotIds: ReadonlySet<string>,
  dryRun: boolean,
  interlock?: CodeGraphRepairInterlock,
): Effect.Effect<number, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const verified = yield* inspectCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
    if (!sameCodeGraphIndexPurgeTarget(repositoryTarget, verified)) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Code graph checkout target changed before spool cleanup.',
      });
    }
    const root = repositoryTarget.path;
    let removed = 0;
    for (const name of (yield* fs.readDirectory(root)).sort()) {
      const snapshotId = codeGraphTemporaryMaterializationSpoolSnapshotId(name);
      if (snapshotId === undefined || retainedIncompleteSnapshotIds.has(snapshotId)) continue;
      const child = path.join(root, name);
      if ((yield* fs.readLink(child).pipe(Effect.option))._tag === 'Some') continue;
      const canonical = yield* fs.realPath(child).pipe(Effect.option);
      if (
        canonical._tag === 'None' ||
        path.dirname(canonical.value) !== root ||
        path.basename(canonical.value) !== name
      ) {
        continue;
      }
      removed += yield* cleanTemporaryMaterializationSpoolFile(
        fs,
        path,
        threadnoteHome,
        checkoutId,
        repositoryTarget,
        canonical.value,
        name,
        dryRun,
        interlock,
      );
    }
    return removed;
  });
}

function cleanTemporaryMaterializationSpoolFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  repositoryTarget: CodeGraphIndexPurgeTarget,
  candidate: string,
  fileName: string,
  dryRun: boolean,
  interlock?: CodeGraphRepairInterlock,
): Effect.Effect<number, unknown, Crypto.Crypto> {
  return Effect.scoped(
    Effect.gen(function* () {
      const info = yield* fs.stat(candidate);
      const identity = yield* readPathFileSystemIdentity(candidate, info, 'File');
      if (Option.isNone(identity)) return 0;
      const target = {...identity.value, path: candidate} satisfies CodeGraphIndexPurgeTarget;
      const opened = yield* fs.open(candidate, {flag: 'r'});
      const openedInfo = yield* opened.stat;
      const openedIdentity = yield* readOpenedFileSystemIdentity(opened, openedInfo, 'File');
      if (
        Option.isNone(openedIdentity) ||
        target.dev !== openedIdentity.value.dev ||
        target.ino !== openedIdentity.value.ino
      ) {
        return yield* CodeGraphMaintenanceError.make({message: 'Temporary graph file changed while opening.'});
      }
      yield* verifyCodeGraphSpoolCleanupAuthority(fs, path, threadnoteHome, checkoutId, repositoryTarget, target);
      if (dryRun) return 1;
      yield* interlock?.beforeSpoolQuarantine?.(candidate) ?? Effect.void;
      const crypto = yield* Crypto.Crypto;
      const quarantine = path.join(repositoryTarget.path, `.${fileName}.${yield* crypto.randomUUIDv4()}.repair`);
      yield* fs.rename(candidate, quarantine);
      return yield* Effect.gen(function* () {
        yield* verifyCodeGraphSpoolCleanupAuthority(fs, path, threadnoteHome, checkoutId, repositoryTarget, {
          ...target,
          path: quarantine,
        });
        yield* interlock?.beforeSpoolRemoval?.(quarantine) ?? Effect.void;
        yield* verifyCodeGraphSpoolCleanupAuthority(fs, path, threadnoteHome, checkoutId, repositoryTarget, {
          ...target,
          path: quarantine,
        });
        yield* fs.remove(quarantine, {force: true});
        return 1;
      }).pipe(Effect.ensuring(restoreQuarantinedSpool(fs, quarantine, candidate)));
    }),
  );
}

function verifyCodeGraphSpoolCleanupAuthority(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  repositoryTarget: CodeGraphIndexPurgeTarget,
  fileTarget: CodeGraphIndexPurgeTarget,
) {
  return Effect.gen(function* () {
    const currentRepository = yield* inspectCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
    if (!sameCodeGraphIndexPurgeTarget(repositoryTarget, currentRepository)) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Code graph checkout target changed during spool cleanup.',
      });
    }
    if (Option.isSome(yield* fs.readLink(fileTarget.path).pipe(Effect.option))) {
      return yield* CodeGraphMaintenanceError.make({message: 'Temporary graph file became a symbolic link.'});
    }
    const currentInfo = yield* fs.stat(fileTarget.path).pipe(Effect.option);
    const currentIdentity = Option.isSome(currentInfo)
      ? yield* readPathFileSystemIdentity(fileTarget.path, currentInfo.value, 'File')
      : Option.none();
    if (
      Option.isNone(currentInfo) ||
      Option.isNone(currentIdentity) ||
      currentIdentity.value.dev !== fileTarget.dev ||
      currentIdentity.value.ino !== fileTarget.ino
    ) {
      return yield* CodeGraphMaintenanceError.make({message: 'Temporary graph file target changed during cleanup.'});
    }
  });
}

function restoreQuarantinedSpool(
  fs: FileSystem.FileSystem,
  quarantine: string,
  original: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const quarantineIsLink = Option.isSome(yield* fs.readLink(quarantine).pipe(Effect.option));
    const originalIsLink = Option.isSome(yield* fs.readLink(original).pipe(Effect.option));
    if ((!quarantineIsLink && !(yield* fs.exists(quarantine))) || originalIsLink || (yield* fs.exists(original)))
      return;
    yield* fs.rename(quarantine, original);
  }).pipe(Effect.ignore);
}

function cleanTemporaryVectorFilesContained(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  repositoryTarget: CodeGraphIndexPurgeTarget,
  root: string,
  directory: string,
  dryRun: boolean,
  interlock?: CodeGraphRepairInterlock,
): Effect.Effect<number, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    let removed = 0;
    for (const name of yield* fs.readDirectory(directory)) {
      const child = path.join(directory, name);
      if ((yield* fs.readLink(child).pipe(Effect.option))._tag === 'Some') continue;
      const canonical = yield* fs.realPath(child).pipe(Effect.option);
      if (canonical._tag === 'None' || !isContained(path, root, canonical.value)) continue;
      const info = yield* fs.stat(child);
      if (info.type === 'Directory') {
        removed += yield* cleanTemporaryVectorFilesContained(
          fs,
          path,
          threadnoteHome,
          checkoutId,
          repositoryTarget,
          root,
          canonical.value,
          dryRun,
          interlock,
        );
      } else if (info.type === 'File' && (name.endsWith('.tmp') || name.endsWith('.staging'))) {
        removed += yield* cleanTemporaryMaterializationSpoolFile(
          fs,
          path,
          threadnoteHome,
          checkoutId,
          repositoryTarget,
          canonical.value,
          name,
          dryRun,
          interlock,
        );
      }
    }
    return removed;
  });
}

function withDatabaseLock<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  database: string,
  effect: Effect.Effect<A, E, R>,
  waitTimeoutMilliseconds = CODE_GRAPH_LOCK_OPTIONS.waitTimeoutMilliseconds,
  afterWorktreeDrain?: (database: string) => Effect.Effect<void, unknown>,
) {
  const repositoryId = path.basename(path.dirname(database));
  return withExclusiveFileLock(
    fs,
    codeGraphRepositoryLockPath(path, threadnoteHome, repositoryId),
    {...CODE_GRAPH_LOCK_OPTIONS, waitTimeoutMilliseconds},
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      for (;;) {
        const remaining = Math.max(0, waitTimeoutMilliseconds - ((yield* Clock.currentTimeMillis) - startedAt));
        yield* awaitCodeGraphWorktreeBuilds(threadnoteHome, repositoryId, remaining);
        yield* afterWorktreeDrain?.(database) ?? Effect.void;
        type DatabaseLockAttempt = {readonly state: 'completed'; readonly value: A} | {readonly state: 'late-builder'};
        const acquired = yield* withCodeGraphDatabaseWriteLock(
          threadnoteHome,
          repositoryId,
          codeGraphWorktreeBuildActive(threadnoteHome, repositoryId).pipe(
            Effect.flatMap(active =>
              active
                ? Effect.succeed<DatabaseLockAttempt>({state: 'late-builder'})
                : effect.pipe(Effect.map(value => ({state: 'completed', value}) satisfies DatabaseLockAttempt)),
            ),
          ),
          remaining,
        );
        if (acquired.state === 'completed') return acquired.value;
        // Release the database writer gate before waiting. A late builder can
        // otherwise deadlock while holding its worktree lock and waiting to
        // publish its BUILDING row through this same writer gate.
      }
    }),
  );
}

function obsoleteGraphFileName(
  fileName: string,
): {readonly kind: ObsoleteCodeGraphStoreFile['kind']; readonly schemaVersion: number} | undefined {
  const match = OBSOLETE_GRAPH_FILE_PATTERN.exec(fileName);
  if (!match) return undefined;
  const schemaVersion = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion >= CODE_GRAPH_SCHEMA_VERSION) return undefined;
  return {
    kind: match[2] === 'wal' ? 'wal' : match[2] === 'shm' ? 'shm' : 'database',
    schemaVersion,
  };
}

function emptyObsoleteInventory(): ObsoleteCodeGraphStoreInventory {
  return {bytes: 0, checkouts: [], fileCount: 0, unsafeEntryCount: 0};
}

function openCodeGraphIndexPurgeTarget(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
) {
  return Effect.gen(function* () {
    const planned = yield* inspectCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
    if (planned === undefined) return undefined;

    const opened = yield* fs.open(planned.path, {flag: 'r'});
    const openedInfo = yield* opened.stat;
    const openedIdentity = yield* readOpenedFileSystemIdentity(opened, openedInfo, 'Directory');
    if (Option.isNone(openedIdentity)) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Refusing code graph purge without stable checkout identity metadata.',
      });
    }
    const target = {...openedIdentity.value, path: planned.path} satisfies CodeGraphIndexPurgeTarget;
    const current = yield* inspectCodeGraphIndexPurgeTarget(fs, path, threadnoteHome, checkoutId);
    if (!sameCodeGraphIndexPurgeTarget(target, current)) {
      return yield* CodeGraphMaintenanceError.make({message: 'Code graph checkout target changed before purge.'});
    }
    return target;
  });
}

function inspectCodeGraphIndexPurgeTarget(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
): Effect.Effect<CodeGraphIndexPurgeTarget | undefined, Error | unknown> {
  return Effect.gen(function* () {
    const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
    if (!(yield* fs.exists(repositories))) return undefined;
    if (yield* isSymbolicLink(fs, repositories)) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Refusing code graph purge through a symbolic-link repositories root.',
      });
    }
    const repositoriesInfo = yield* fs.stat(repositories).pipe(Effect.option);
    if (repositoriesInfo._tag === 'None' || repositoriesInfo.value.type !== 'Directory') {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Refusing code graph purge because the repositories root is not a directory.',
      });
    }
    const canonicalRepositories = yield* fs.realPath(repositories);
    const canonicalHome = yield* fs.realPath(threadnoteHome);
    const expectedRepositories = path.join(canonicalHome, 'indexes', 'code-graph', 'repositories');
    if (canonicalRepositories !== expectedRepositories) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Refusing code graph purge outside the canonical Threadnote home.',
      });
    }
    const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
    if (!(yield* fs.exists(repositoryRoot))) return undefined;
    if (yield* isSymbolicLink(fs, repositoryRoot)) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Refusing code graph purge through a symbolic-link checkout root.',
      });
    }
    const repositoryInfo = yield* fs.stat(repositoryRoot).pipe(Effect.option);
    if (repositoryInfo._tag === 'None' || repositoryInfo.value.type !== 'Directory') {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Refusing code graph purge because the checkout root is not a directory.',
      });
    }
    const canonicalRepository = yield* fs.realPath(repositoryRoot);
    if (
      path.dirname(canonicalRepository) !== canonicalRepositories ||
      path.basename(canonicalRepository) !== checkoutId ||
      !isContained(path, canonicalRepositories, canonicalRepository)
    ) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Refusing code graph purge outside the repositories root.',
      });
    }
    const identity = yield* readPathFileSystemIdentity(repositoryRoot, repositoryInfo.value, 'Directory');
    if (Option.isNone(identity)) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Refusing code graph purge without stable checkout identity metadata.',
      });
    }
    return {...identity.value, path: canonicalRepository};
  });
}

function inspectQuarantinedCodeGraphIndexPurgeTarget(
  fs: FileSystem.FileSystem,
  quarantine: string,
): Effect.Effect<CodeGraphIndexPurgeTarget | undefined, never> {
  return Effect.gen(function* () {
    if (yield* isSymbolicLink(fs, quarantine)) return undefined;
    const info = yield* fs.stat(quarantine).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== 'Directory') return undefined;
    const identity = yield* readPathFileSystemIdentity(quarantine, info.value, 'Directory');
    return Option.isNone(identity) ? undefined : {...identity.value, path: quarantine};
  });
}

function sameCodeGraphIndexPurgeTarget(
  left: CodeGraphIndexPurgeTarget | undefined,
  right: CodeGraphIndexPurgeTarget | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.dev === right.dev && left.ino === right.ino;
}

function restoreQuarantinedCodeGraphIndexPurgeTarget(
  fs: FileSystem.FileSystem,
  quarantine: string,
  target: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (yield* fs.exists(target)) return;
    yield* fs.rename(quarantine, target);
  }).pipe(Effect.ignore);
}

function isSymbolicLink(fs: FileSystem.FileSystem, candidate: string): Effect.Effect<boolean, never> {
  return fs.readLink(candidate).pipe(
    Effect.option,
    Effect.map(result => result._tag === 'Some'),
  );
}

function refuseUnsafeObsoleteInventory(inventory: ObsoleteCodeGraphStoreInventory): Effect.Effect<void, Error> {
  return inventory.unsafeEntryCount > 0
    ? Effect.fail(
        CodeGraphMaintenanceError.make({
          message: `Refusing obsolete code graph cleanup: ${inventory.unsafeEntryCount} obsolete-shaped entry/entries are symbolic links, non-files, or outside the checkout root.`,
        }),
      )
    : Effect.void;
}

function verifyObsoletePurgeTarget(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  file: ObsoleteCodeGraphStoreFile,
): Effect.Effect<void, Error | unknown> {
  return Effect.gen(function* () {
    const parsed = obsoleteGraphFileName(file.fileName);
    if (!parsed || parsed.schemaVersion !== file.schemaVersion || parsed.kind !== file.kind) {
      return yield* CodeGraphMaintenanceError.make({
        message: `Refusing unexpected obsolete graph target ${file.fileName}.`,
      });
    }
    const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
    if (yield* isSymbolicLink(fs, repositoryRoot)) {
      return yield* CodeGraphMaintenanceError.make({
        message: 'Refusing obsolete graph cleanup through a symbolic-link checkout root.',
      });
    }
    const candidate = path.join(repositoryRoot, file.fileName);
    if (yield* isSymbolicLink(fs, candidate)) {
      return yield* CodeGraphMaintenanceError.make({
        message: `Refusing symbolic-link obsolete graph target ${file.fileName}.`,
      });
    }
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (info._tag === 'None' || info.value.type !== 'File') {
      return yield* CodeGraphMaintenanceError.make({
        message: `Obsolete graph target changed before cleanup: ${file.fileName}.`,
      });
    }
    const canonicalRoot = yield* fs.realPath(repositoryRoot);
    const canonical = yield* fs.realPath(candidate);
    if (
      canonical !== file.path ||
      path.dirname(canonical) !== canonicalRoot ||
      !isContained(path, canonicalRoot, canonical)
    ) {
      return yield* CodeGraphMaintenanceError.make({
        message: `Obsolete graph target escaped its checkout root: ${file.fileName}.`,
      });
    }
  });
}

function isContained(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const CODE_GRAPH_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;

const CODE_GRAPH_PURGE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 1,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 0,
} as const;
