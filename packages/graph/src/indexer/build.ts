import {Clock, Effect, FileSystem, Option, Path} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {CodeGraphProcessActivity} from '../runtime_ports.js';
import type {CodeGraphBuildOwnerIdentity} from '../build/owner.js';
import type {CodeGraphBuildResourceCoordinator} from '../build/resources.js';
import {canonicalCodeGraphMonikers} from '../cross_repository/monikers.js';
import {isNonResumableCodeGraphBuildFailure} from '../disk/capacity.js';
import {coordinateCodeGraphBuild, measureCodeGraphAttribution} from './build_coordination.js';
import type {CodeGraphEmbeddingIndexShape, CodeGraphEmbeddingStatus} from '../embedding.js';
import {finalCodeGraphFactBatches, serializeBoundedCodeGraphFact} from '../fact/budget.js';
import {
  assessIncrementalOverlay,
  assessReusableCleanBaseCompatibility,
  createCachedCodeGraphFactsAttributor,
  currentSnapshotReusableBaseReceipt,
  overlayFallbackDescription,
  reusableBaseFileSetFingerprint,
  reusableBaseComponentRankingJson,
} from './incremental.js';
import {
  CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS,
  CODE_GRAPH_LOCK_OPTIONS,
  PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES,
  PERSISTENT_MATERIALIZATION_TRANSACTION_FILES,
  PERSISTENT_MATERIALIZATION_TRANSACTION_SOURCE_BYTES,
  addMaterializationReplayMetrics,
  addMaterializationRows,
  applyIncrementalMaterialization,
  cachedFactsMetadata,
  codeGraphDirectPersistentCapacityProtector,
  deduplicateMaterializationRelationships,
  embeddingSymbolSource,
  emptyMaterializationReplayMetrics,
  estimatedMaterializationStorageBytes,
  extractorSetIdentity,
  extractorSetIdentityFromPackProvenance,
  factMaterializationBatches,
  forcedSnapshotIdentity,
  graphContentIdentity,
  incrementalMaterializationMetrics,
  initialMaterializationStorageTelemetry,
  loadCachedFacts,
  materializationRows,
  materializationRowsWithStoreProgress,
  materializationStagingStage,
  materializationStorageFiles,
  materializationStoragePlan,
  materializationStorageShortfalls,
  messageOf,
  persistentMaterializationTransactionBatches,
  promoteReadySnapshotWithCapacity,
  observeMaterializationStorage,
  reusableReadySnapshotForCleanCommit,
  selectedDecodedFactBytes,
  snapshotIdentity,
  uniqueById,
  verifyIndexInput,
  withIncrementalMaterializationStorageTelemetry,
} from './materialization.js';
import {type PendingMaterializationBatch, secondaryIndexRestorationReporter} from './materialization_batch.js';
import {verifyCommittedIndexInput} from './input/verification.js';
import {
  acquireFoldForwardBaseLeases,
  foldForwardCommittedBase,
  foldForwardLogicalCandidate,
  foldForwardMaterializationCounts,
  foldForwardPreparationOptions,
  persistedBaseCommittedBase,
} from './fold_forward.js';
import {
  CachedCodeGraphFactUnavailableDuringIndex,
  CodeGraphIndexOperationError,
  codeGraphInventoryFileChanged,
  sameInventoryPaths,
} from './shared.js';
import {
  attemptCommittedDirtyRootAlias,
  prepareReadyAnalysisSummary,
  reuseReadySnapshot,
  type ReusableCleanSnapshotInput,
} from './snapshot_reuse.js';
import type {
  CodeGraphIndexOptions,
  CodeGraphBuildAndActivateInput,
  CodeGraphSourceVerification,
  CommittedBaseResult,
  DirectPersistentCapacityProtection,
  IncrementalOverlayAssessment,
  IncrementalOverlayPreassessment,
  CodeGraphIndexResourceGate,
  CodeGraphPreparedSpoolBudgetGate,
  ReusableCleanSnapshotAttempt,
} from './types.js';
import {preferredIncrementalBaseCommitGroups} from '../incremental/base_selection.js';
import type {CodeGraphInventory} from '../inventory.js';
import {committedCodeGraphInventory} from '../inventory/scope.js';
import {codeGraphScopedBaseReusable} from '../scope/applicability.js';
import {makeCodeGraphMaterializedShardWriteQueue} from './materialized_shard_writes.js';
import {
  codeGraphMaterializedShardCacheBatchPlan,
  codeGraphMaterializedShardCacheWriteAdmission,
} from '../materialized_shard_cache_admission.js';
import {assessCodeGraphLanguagePackDelta} from '../languages/provenance.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import {assessCodeGraphWorkspaceCompatibility} from '../workspace/compatibility.js';
import {codeGraphSnapshotBuildLockPath, type CodeGraphLayout} from '../layout.js';
import {MaterializationSubphaseTiming} from '../materialization/subphase_timing.js';
import {codeGraphMaterializationSpoolPath} from '../materialization/spool.js';
import {
  materializedBatchShardDerivationIdentity,
  materializedFileShardIdentity,
  materializedShardRepositorySemanticEnvelope,
  shardDonorIds,
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphMaterializationSpoolContext,
  type CodeGraphRetiredSnapshotCleanupProgress,
  type CodeGraphReusableCleanBase,
  type CodeGraphStagingProgress,
  type CodeGraphStoreShape,
} from '../store.js';
import {
  type CodeGraphIndexSummary,
  type CodeGraphMaterializationActivity,
  type CodeGraphMaterializationMetrics,
  type CodeGraphMaterializationRows,
  type CodeGraphOverlayFallbackReason,
  type CodeGraphProgress,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '../types.js';

export const CODE_GRAPH_INTERRUPTED_BUILD_SUMMARY = 'Code graph build was interrupted before completion.';
export function settleInterruptedCodeGraphBuild(
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshotId: string,
  ownerToken?: string,
) {
  return ownerToken === undefined
    ? Effect.void
    : store.releasePersistentBuild(databasePath, snapshotId, CODE_GRAPH_INTERRUPTED_BUILD_SUMMARY, ownerToken);
}

export function withCodeGraphProcessLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  onContention: () => Effect.Effect<void>,
  builderOperation: string,
  effect: Effect.Effect<A, E, R>,
  coordination?: {
    readonly onAcquired: () => Effect.Effect<void, never>;
    readonly onCompleted: () => Effect.Effect<void, never>;
  },
) {
  return Effect.flatMap(CodeGraphProcessActivity, activity =>
    activity.withActivity(
      'graph-waiter',
      'repository-lock',
      withExclusiveFileLock(
        fs,
        lockPath,
        {
          ...CODE_GRAPH_LOCK_OPTIONS,
          onContention,
          ...(coordination ? {onAcquired: coordination.onAcquired, onCompleted: coordination.onCompleted} : {}),
        },
        activity.withActivity('graph-builder', builderOperation, effect),
      ),
    ),
  );
}

export function writerSessionOptions(
  layout: CodeGraphLayout,
  options: Pick<CodeGraphIndexOptions, 'onProgress' | 'onSqliteWriterConfigured' | 'sqliteWriterTuning'>,
  resumeProgress: () => Effect.Effect<void, unknown>,
  resources?: CodeGraphBuildResourceCoordinator,
) {
  return {
    cleanupCompletedBuildRows: true,
    ...(options.onSqliteWriterConfigured ? {onSqliteWriterConfigured: options.onSqliteWriterConfigured} : {}),
    onWriterContention: () =>
      (resources?.assertWriterMayWait ?? Effect.void).pipe(
        Effect.orDie,
        Effect.andThen(options.onProgress?.({phase: 'waiting', reason: 'database-writer'}) ?? Effect.void),
        Effect.ignore,
      ),
    onWriterAcquired: () =>
      (resources?.acquireWriter ?? Effect.void).pipe(Effect.orDie, Effect.andThen(resumeProgress()), Effect.ignore),
    onWriterReleased: () => (resources?.releaseWriter ?? Effect.void).pipe(Effect.orDie),
    sqliteWriterTuning: {
      reconstructibleBuildSynchronous: 'normal' as const,
      ...options.sqliteWriterTuning,
    },
    writerLockPath: layout.databaseWriteLockPath,
  } as const;
}

export function retiredSnapshotCleanupReporter(onProgress: CodeGraphIndexOptions['onProgress']) {
  return (progress: CodeGraphRetiredSnapshotCleanupProgress) =>
    (
      onProgress?.({
        completed: progress.snapshotsCompleted,
        pagesCompleted: progress.pagesCompleted,
        phase: 'reclaiming',
        rowsDeleted: progress.rowsDeleted,
        total: progress.snapshotsTotal,
        unit: 'snapshots',
      }) ?? Effect.void
    ).pipe(Effect.ignore);
}

export {prepareReadyAnalysisSummary, reuseReadySnapshot};

export {codeGraphBuildRequestKey} from './request/identity.js';

export const buildOwnedCleanSnapshot = Effect.fn('codeGraph.buildOwnedCleanSnapshot')(function* (input: {
  readonly buildOwner: CodeGraphBuildOwnerIdentity;
  readonly capacityProtection: DirectPersistentCapacityProtection;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
  readonly existing: CodeGraphSnapshot | undefined;
  readonly fallbackSnapshotId: string;
  readonly force: boolean;
  readonly sourceVerification?: CodeGraphSourceVerification;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly legacyBuildAdmission?: CodeGraphIndexResourceGate;
  readonly layout: CodeGraphLayout;
  readonly logicalSnapshotId: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly persistentMaterializationTransactionBatchLimit?: 1 | 4;
  readonly preparationGate?: CodeGraphIndexResourceGate;
  readonly preparedSpoolBudgetGate?: CodeGraphPreparedSpoolBudgetGate;
  readonly reclaimSnapshots: (cleanupMode: 'deferred' | 'required') => Effect.Effect<void, unknown>;
  readonly requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string};
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}) {
  return yield* withExclusiveFileLock(
    input.fs,
    codeGraphSnapshotBuildLockPath(
      yield* Path.Path,
      input.threadnoteHome,
      input.identity.checkoutId,
      input.logicalSnapshotId,
    ),
    {
      ...CODE_GRAPH_LOCK_OPTIONS,
      onContention: () =>
        (input.onProgress?.({phase: 'waiting', reason: 'snapshot-build'}) ?? Effect.void).pipe(Effect.ignore),
    },
    Effect.gen(function* () {
      let cleanFallbackAssessment: IncrementalOverlayAssessment | undefined;
      if (!input.force) {
        let ready = yield* input.store.currentLexicalReadySnapshotById(
          input.layout.databasePath,
          input.logicalSnapshotId,
        );
        if (!ready) {
          const extractorSet = extractorSetIdentity(input.inventory.files, input.languagePacks);
          ready = yield* reusableReadySnapshotForCleanCommit({
            scopeId: input.inventory.scope?.scopeKey,
            databasePath: input.layout.databasePath,
            extractorSet,
            graphContentId: graphContentIdentity(extractorSet, input.inventory.files, input.inventory.scope),
            headCommit: input.identity.headCommit,
            repositoryId: input.identity.repositoryId,
            store: input.store,
          });
        }
        if (ready) {
          yield* input.reclaimSnapshots('deferred');
          if (input.existing?.id !== ready.id) {
            yield* promoteReadySnapshotWithCapacity(input, ready.id);
          }
          return yield* reuseReadySnapshot({
            embedding: input.embedding,
            ensureVectors: input.ensureVectors,
            identity: input.identity,
            layout: input.layout,
            onProgress: input.onProgress,
            reusedFiles: input.inventory.files.length - input.inventory.parsedFiles,
            skippedFiles: input.inventory.skipped,
            snapshot: ready,
            startedAt: input.startedAt,
            store: input.store,
            threadnoteHome: input.threadnoteHome,
            totalFiles: input.inventory.files.length,
          });
        }
      }
      // New clean aliases also copy monikers, file-shard links, and workspace rows.
      // Drain retired payload before either alias publication or materialization.
      yield* input.reclaimSnapshots('required');
      if (!input.force) {
        const workspace =
          input.inventory.workspace ?? (yield* input.languagePacks.discoverWorkspace(input.inventory.files));
        const reused = yield* attemptReusableCleanSnapshot(input, workspace);
        if (Option.isSome(reused)) {
          if (reused.value.mode === 'complete') return reused.value.summary;
          cleanFallbackAssessment = reused.value;
        }
      }
      const resumed =
        input.force && input.sourceVerification === undefined
          ? yield* input.store.resumableForcedBuild(input.layout.databasePath, input.logicalSnapshotId)
          : undefined;
      const building: CodeGraphSnapshot = resumed ?? {
        commit: input.identity.headCommit,
        dirty: false,
        edgeCount: 0,
        extractorSet: extractorSetIdentity(input.inventory.files, input.languagePacks),
        fileCount: 0,
        graphContentId: graphContentIdentity(
          extractorSetIdentity(input.inventory.files, input.languagePacks),
          input.inventory.files,
          input.inventory.scope,
        ),
        id: input.fallbackSnapshotId,
        repositoryId: input.identity.repositoryId,
        state: 'building',
        symbolCount: 0,
        worktreeId: input.identity.worktreeId,
        scopeId: input.inventory.scope?.scopeKey,
      };
      const ownerToken = yield* input.store.claimPersistentBuild(input.layout.databasePath, input.identity, building, {
        logicalSnapshotId: input.logicalSnapshotId,
        owner: input.buildOwner,
      });
      return yield* buildAndActivate({
        ...input,
        activatePointer: true,
        building,
        incrementalAssessment: cleanFallbackAssessment,
        persistentOwnerToken: ownerToken,
      }).pipe(
        Effect.onInterrupt(() =>
          settleInterruptedCodeGraphBuild(input.store, input.layout.databasePath, building.id, ownerToken),
        ),
        Effect.catchIf(isNonResumableCodeGraphBuildFailure, cause =>
          input.store
            .markFailed(input.layout.databasePath, building.id, messageOf(cause), ownerToken)
            .pipe(Effect.andThen(Effect.fail(cause))),
        ),
      );
    }),
  );
});

const attemptReusableCleanCandidate = Effect.fn('codeGraph.attemptReusableCleanCandidate')(function* (
  input: ReusableCleanSnapshotInput,
  workspace: CodeGraphWorkspace,
  candidate: CodeGraphReusableCleanBase,
  extractorSet: string,
) {
  if (candidate.snapshot.id === input.logicalSnapshotId) return Option.none<ReusableCleanSnapshotAttempt>();
  if (!(yield* codeGraphScopedBaseReusable(input, candidate))) return Option.none<ReusableCleanSnapshotAttempt>();
  const baseByPath = new Map(candidate.files.map(file => [file.path, file]));
  if (input.inventory.files.some(file => file.source !== 'commit')) {
    return Option.none<ReusableCleanSnapshotAttempt>();
  }
  const lease = yield* input.store
    .acquireSnapshotLease(input.layout.databasePath, candidate.snapshot.id, CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS)
    .pipe(Effect.option);
  if (Option.isNone(lease)) return Option.none<ReusableCleanSnapshotAttempt>();
  return yield* Effect.acquireUseRelease(
    Effect.succeed(lease.value),
    () =>
      Effect.gen(function* () {
        const packDelta =
          candidate.snapshot.extractorSet === extractorSet
            ? ({changedPackIds: [], mode: 'compatible'} as const)
            : assessCodeGraphLanguagePackDelta(
                candidate.receipt.packProvenance,
                input.languagePacks.activePackProvenance(input.inventory.files.map(file => file.path)),
              );
        if (
          packDelta.mode === 'fallback' ||
          (candidate.snapshot.extractorSet !== extractorSet &&
            candidate.snapshot.extractorSet !==
              extractorSetIdentityFromPackProvenance(candidate.receipt.packProvenance))
        ) {
          return Option.some<ReusableCleanSnapshotAttempt>({mode: 'fallback', reason: 'extractor-context-changed'});
        }
        const changedPackIds = new Set(packDelta.changedPackIds);
        const modifiedFiles = input.inventory.files.filter(file => {
          const base = baseByPath.get(file.path);
          return (
            !base ||
            base.contentHash !== file.contentHash ||
            base.language !== file.language ||
            base.mode !== file.mode ||
            base.size !== file.size ||
            Option.match(input.languagePacks.match(file.path), {
              onNone: () => false,
              onSome: match => changedPackIds.has(match.pack.id),
            })
          );
        });
        const currentPaths = new Set(input.inventory.files.map(file => file.path));
        const deletedPaths = candidate.files.filter(file => !currentPaths.has(file.path)).map(file => file.path);
        const aliasWorkspaceCompatible =
          candidate.receipt.workspaceFingerprint === workspace.fingerprint ||
          (candidate.receipt.inventory?.workspace !== undefined &&
            assessCodeGraphWorkspaceCompatibility(candidate.receipt.inventory.workspace, workspace).mode ===
              'unchanged');
        if (
          modifiedFiles.length === 0 &&
          deletedPaths.length === 0 &&
          candidate.snapshot.extractorSet === extractorSet &&
          aliasWorkspaceCompatible
        ) {
          const alias: CodeGraphSnapshot = {
            baseSnapshotId: candidate.snapshot.id,
            commit: input.identity.headCommit,
            dirty: false,
            edgeCount: candidate.snapshot.edgeCount,
            extractorSet,
            fileCount: candidate.snapshot.fileCount,
            graphContentId: graphContentIdentity(extractorSet, input.inventory.files, input.inventory.scope),
            id: input.logicalSnapshotId,
            repositoryId: input.identity.repositoryId,
            scopeId: input.inventory.scope?.scopeKey,
            state: 'ready',
            symbolCount: candidate.snapshot.symbolCount,
            worktreeId: input.identity.worktreeId,
          };
          yield* input.onProgress?.({phase: 'activating', snapshotId: alias.id, subphase: 'validating-input'}) ??
            Effect.void;
          yield* verifyIndexInput(input.identity, true, input.threadnoteHome, input.requestedOverlay, input.inventory);
          yield* input.store.activateCleanSnapshotAlias!(
            input.layout.databasePath,
            input.identity,
            alias,
            candidate.snapshot.id,
            currentSnapshotReusableBaseReceipt(
              input.inventory,
              workspace,
              input.languagePacks.activePackProvenance(input.inventory.files.map(file => file.path)),
            ),
          );
          yield* input.onProgress?.({phase: 'activating', snapshotId: alias.id, subphase: 'promoting'}) ?? Effect.void;
          yield* verifyCommittedIndexInput({
            databasePath: input.layout.databasePath,
            identity: input.identity,
            scopeInventory: input.inventory,
            physicalSnapshotId: candidate.snapshot.id,
            requestedOverlay: input.requestedOverlay,
            snapshotId: alias.id,
            store: input.store,
            threadnoteHome: input.threadnoteHome,
          });
          yield* promoteReadySnapshotWithCapacity(input, alias.id);
          yield* input.onProgress?.({phase: 'activating', snapshotId: alias.id, subphase: 'promoting'}) ?? Effect.void;
          yield* verifyCommittedIndexInput({
            databasePath: input.layout.databasePath,
            identity: input.identity,
            scopeInventory: input.inventory,
            physicalSnapshotId: candidate.snapshot.id,
            requestedOverlay: input.requestedOverlay,
            snapshotId: alias.id,
            store: input.store,
            threadnoteHome: input.threadnoteHome,
          });
          return Option.some<ReusableCleanSnapshotAttempt>({
            mode: 'complete',
            summary: yield* reuseReadySnapshot({
              embedding: input.embedding,
              ensureVectors: input.ensureVectors,
              identity: input.identity,
              layout: input.layout,
              onProgress: input.onProgress,
              reusedFiles: input.inventory.files.length,
              skippedFiles: input.inventory.skipped,
              snapshot: alias,
              startedAt: input.startedAt,
              store: input.store,
              threadnoteHome: input.threadnoteHome,
              totalFiles: input.inventory.files.length,
            }),
          });
        }
        const assessmentInput = {
          candidate,
          inventory: input.inventory,
          languagePacks: input.languagePacks,
          layout: input.layout,
          store: input.store,
        };
        const boundedAssessment = yield* assessReusableCleanBaseCompatibility(
          assessmentInput,
          workspace,
          modifiedFiles,
        );
        if (boundedAssessment.mode === 'fallback') {
          return Option.some<ReusableCleanSnapshotAttempt>(boundedAssessment);
        }
        const preassessment = boundedAssessment;
        const committedBase: CommittedBaseResult = {
          diagnostics: [],
          leaseToken: Option.none(),
          snapshot: candidate.snapshot,
          stagingReusable: false,
        };
        const building: CodeGraphSnapshot = {
          baseSnapshotId: candidate.snapshot.id,
          commit: input.identity.headCommit,
          dirty: false,
          edgeCount: 0,
          extractorSet,
          fileCount: 0,
          graphContentId: graphContentIdentity(extractorSet, input.inventory.files, input.inventory.scope),
          id: input.logicalSnapshotId,
          repositoryId: input.identity.repositoryId,
          scopeId: input.inventory.scope?.scopeKey,
          state: 'building',
          symbolCount: 0,
          worktreeId: input.identity.worktreeId,
        };
        const incrementalAssessment = yield* assessIncrementalOverlay(
          {
            building,
            committedBase,
            force: false,
            incrementalOverlayEnabled: true,
            inventory: input.inventory,
            languagePacks: input.languagePacks,
            layout: input.layout,
            store: input.store,
          },
          workspace,
          preassessment,
        );
        if (incrementalAssessment.mode === 'fallback') {
          return Option.some<ReusableCleanSnapshotAttempt>(incrementalAssessment);
        }
        yield* input.onProgress?.({
          completed: 0,
          phase: 'materializing',
          reused: input.inventory.files.length - incrementalAssessment.files.length,
          total: incrementalAssessment.files.length,
          unit: 'files',
        }) ?? Effect.void;
        const preparedMaterialization = yield* withIncrementalMaterializationStorageTelemetry(
          input.fs,
          input.layout.databasePath,
          input.store.preparePersistedIncrementalActivation(
            input.layout.databasePath,
            candidate.snapshot.id,
            incrementalAssessment.files,
            incrementalAssessment.facts,
            {
              deletedPaths: incrementalAssessment.deletedPaths,
              resolutionClosure: incrementalAssessment.resolutionClosure,
            },
            codeGraphDirectPersistentCapacityProtector(input),
          ),
        );
        const prepared = preparedMaterialization.result;
        if (!prepared) {
          return Option.some<ReusableCleanSnapshotAttempt>({mode: 'fallback', reason: 'staging-identity-mismatch'});
        }
        yield* input.store.markBuilding(input.layout.databasePath, input.identity, building);
        if (preassessment.committedWorkspace.fingerprint !== workspace.fingerprint) {
          yield* input.store.stageWorkspaceCatalog(
            input.layout.databasePath,
            workspace,
            codeGraphDirectPersistentCapacityProtector(input),
          );
        }
        const summary = yield* buildAndActivate({
          activatePointer: true,
          building,
          capacityProtection: input.capacityProtection,
          committedBase,
          embedding: input.embedding,
          ensureVectors: input.ensureVectors,
          existing: input.existing,
          force: false,
          fs: input.fs,
          identity: input.identity,
          incrementalAssessment,
          incrementalMaterializationStorageTelemetry: preparedMaterialization.storage,
          incrementalOverlayEnabled: true,
          incrementalPrepared: true,
          inventory: input.inventory,
          languagePacks: input.languagePacks,
          layout: input.layout,
          onProgress: input.onProgress,
          persistentMaterializationTransactionBatchLimit: input.persistentMaterializationTransactionBatchLimit,
          requestedOverlay: input.requestedOverlay,
          startedAt: input.startedAt,
          store: input.store,
          threadnoteHome: input.threadnoteHome,
          workspace,
        }).pipe(
          Effect.onInterrupt(() =>
            settleInterruptedCodeGraphBuild(input.store, input.layout.databasePath, building.id),
          ),
          Effect.tapError(cause => input.store.markFailed(input.layout.databasePath, building.id, messageOf(cause))),
        );
        return Option.some<ReusableCleanSnapshotAttempt>({mode: 'complete', summary});
      }),
    token => input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.ignore),
  );
});

const attemptReusableCleanSnapshot = Effect.fn('codeGraph.attemptReusableCleanSnapshot')(function* (
  input: ReusableCleanSnapshotInput,
  workspace: CodeGraphWorkspace,
) {
  if (!input.store.activateCleanSnapshotAlias) {
    return Option.none<ReusableCleanSnapshotAttempt>();
  }
  const committedDirtyRoot =
    input.inventory.scope === undefined
      ? yield* attemptCommittedDirtyRootAlias(input, workspace)
      : Option.none<ReusableCleanSnapshotAttempt>();
  if (Option.isSome(committedDirtyRoot)) return committedDirtyRoot;
  if (!input.store.reusableCleanBase) return Option.none<ReusableCleanSnapshotAttempt>();
  const extractorSet = extractorSetIdentity(input.inventory.files, input.languagePacks);
  const preferredCommitGroups = yield* preferredIncrementalBaseCommitGroups(
    input.identity.repoRoot,
    input.identity.headCommit,
  );
  const excludedSnapshotIds: string[] = [];
  let firstFallback = Option.none<ReusableCleanSnapshotAttempt>();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = yield* input.store.reusableCleanBase(
      input.layout.databasePath,
      input.identity.repositoryId,
      extractorSet,
      workspace.fingerprint,
      reusableBaseFileSetFingerprint(input.inventory.files),
      graphContentIdentity(extractorSet, input.inventory.files, input.inventory.scope),
      attempt === 0 ? preferredCommitGroups : undefined,
      true,
      reusableBaseComponentRankingJson(workspace),
      excludedSnapshotIds,
      input.inventory.scope?.scopeKey,
    );
    if (!candidate) break;
    excludedSnapshotIds.push(candidate.snapshot.id);
    const outcome = yield* attemptReusableCleanCandidate(input, workspace, candidate, extractorSet);
    if (Option.isSome(outcome)) {
      if (outcome.value.mode === 'complete') return outcome;
      if (Option.isNone(firstFallback)) firstFallback = outcome;
    }
  }
  return firstFallback;
});

export const attemptReusableDirtyBase = Effect.fn('codeGraph.attemptReusableDirtyBase')(function* (
  input: {
    readonly extractorSet: string;
    readonly identity: RepositoryIdentity;
    readonly inventory: CodeGraphInventory;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly layout: CodeGraphLayout;
    readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
    readonly store: CodeGraphStoreShape;
  },
  workspace: CodeGraphWorkspace,
) {
  if (!input.store.reusableCleanBase && !input.store.reusableOverlayBase) {
    return Option.none<{
      readonly committedBase: CommittedBaseResult;
      readonly preassessment: Extract<IncrementalOverlayPreassessment, {readonly mode: 'compatible'}>;
    }>();
  }
  const retainedOverlayCandidate =
    input.inventory.scope === undefined && input.inventory.overlayFingerprint && input.store.reusableOverlayBase
      ? yield* input.store.reusableOverlayBase(
          input.layout.databasePath,
          input.identity.repositoryId,
          input.extractorSet,
          input.inventory.overlayFingerprint,
        )
      : undefined;
  const committedExtractorSet = extractorSetIdentity(input.inventory.committedFiles, input.languagePacks);
  const exactCommittedSnapshotId = snapshotIdentity(
    input.identity,
    false,
    committedExtractorSet,
    input.inventory.committedFiles,
    input.inventory.scope,
  );
  const exactCommittedSnapshot = yield* input.store.currentLexicalReadySnapshotById(
    input.layout.databasePath,
    exactCommittedSnapshotId,
  );
  if (!retainedOverlayCandidate && exactCommittedSnapshot && exactCommittedSnapshot.baseSnapshotId === undefined)
    return Option.none();
  const committedFileSetFingerprint = reusableBaseFileSetFingerprint(input.inventory.committedFiles);
  const committedGraphContentId = graphContentIdentity(
    committedExtractorSet,
    input.inventory.committedFiles,
    input.inventory.scope,
  );
  const exactCommittedDirtyRoot = exactCommittedSnapshot?.baseSnapshotId
    ? yield* input.store.currentLexicalReadySnapshotById(
        input.layout.databasePath,
        exactCommittedSnapshot.baseSnapshotId,
      )
    : undefined;
  const exactCommittedDirtyRootReceipt =
    exactCommittedDirtyRoot?.dirty && exactCommittedDirtyRoot.baseSnapshotId === undefined
      ? yield* input.store.reusableBaseReceipt(input.layout.databasePath, exactCommittedDirtyRoot.id, {
          allowDirtyRoot: true,
        })
      : undefined;
  const exactCommittedDirtyAlias =
    exactCommittedSnapshot &&
    exactCommittedDirtyRoot &&
    exactCommittedDirtyRootReceipt &&
    exactCommittedSnapshot.baseSnapshotId === exactCommittedDirtyRoot.id &&
    exactCommittedSnapshot.repositoryId === input.identity.repositoryId &&
    exactCommittedSnapshot.extractorSet === committedExtractorSet &&
    exactCommittedSnapshot.graphContentId === committedGraphContentId &&
    exactCommittedSnapshot.fileCount === input.inventory.committedFiles.length &&
    exactCommittedSnapshot.fileCount === exactCommittedDirtyRoot.fileCount &&
    exactCommittedSnapshot.symbolCount === exactCommittedDirtyRoot.symbolCount &&
    exactCommittedSnapshot.edgeCount === exactCommittedDirtyRoot.edgeCount &&
    exactCommittedDirtyRootReceipt.fileSetFingerprint === committedFileSetFingerprint &&
    exactCommittedDirtyRootReceipt.workspaceFingerprint === workspace.fingerprint
      ? {
          logicalSnapshot: exactCommittedSnapshot,
          rootReceipt: exactCommittedDirtyRootReceipt,
          rootSnapshot: exactCommittedDirtyRoot,
        }
      : undefined;
  const foldForwardBase =
    !retainedOverlayCandidate &&
    !exactCommittedDirtyAlias &&
    exactCommittedSnapshot?.baseSnapshotId &&
    input.store.reusableFoldForwardBase
      ? yield* input.store.reusableFoldForwardBase(input.layout.databasePath, exactCommittedSnapshot.id)
      : undefined;
  const commitReady = yield* input.store.readySnapshotForCommit(
    input.layout.databasePath,
    input.identity.repositoryId,
    input.identity.headCommit,
    committedExtractorSet,
    input.inventory.scope?.scopeKey,
  );
  const commitReceipt = commitReady
    ? yield* input.store.reusableBaseReceipt(input.layout.databasePath, commitReady.id)
    : undefined;
  let candidate: CodeGraphReusableCleanBase | undefined =
    (exactCommittedDirtyAlias
      ? {
          files: input.inventory.committedFiles,
          receipt: exactCommittedDirtyAlias.rootReceipt,
          snapshot: exactCommittedDirtyAlias.logicalSnapshot,
        }
      : undefined) ??
    retainedOverlayCandidate ??
    (foldForwardBase ? foldForwardLogicalCandidate(foldForwardBase) : undefined) ??
    (commitReady &&
    commitReceipt &&
    commitReady.graphContentId === committedGraphContentId &&
    commitReceipt.fileSetFingerprint === committedFileSetFingerprint &&
    commitReceipt.workspaceFingerprint === workspace.fingerprint
      ? {files: input.inventory.committedFiles, receipt: commitReceipt, snapshot: commitReady}
      : undefined);
  if (!candidate && input.store.reusableCleanBase) {
    const preferredCommitGroups = yield* preferredIncrementalBaseCommitGroups(
      input.identity.repoRoot,
      input.identity.headCommit,
    );
    candidate = yield* input.store.reusableCleanBase(
      input.layout.databasePath,
      input.identity.repositoryId,
      input.extractorSet,
      workspace.fingerprint,
      reusableBaseFileSetFingerprint(input.inventory.files),
      graphContentIdentity(input.extractorSet, input.inventory.files, input.inventory.scope),
      preferredCommitGroups,
      true,
      reusableBaseComponentRankingJson(workspace),
      undefined,
      input.inventory.scope?.scopeKey,
    );
  }
  if (!candidate) return Option.none();
  if (!(yield* codeGraphScopedBaseReusable(input, candidate))) return Option.none();
  const physicalSnapshot =
    exactCommittedDirtyAlias?.rootSnapshot ?? foldForwardBase?.rootSnapshot ?? candidate.snapshot;
  const leaseTokens = yield* acquireFoldForwardBaseLeases(
    input.store,
    input.layout.databasePath,
    physicalSnapshot.id,
    CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS,
    foldForwardBase?.logicalSnapshot.id,
  );
  if (Option.isNone(leaseTokens)) return Option.none();
  const packDelta =
    candidate.snapshot.extractorSet === input.extractorSet
      ? ({changedPackIds: [], mode: 'compatible'} as const)
      : assessCodeGraphLanguagePackDelta(
          candidate.receipt.packProvenance,
          input.languagePacks.activePackProvenance(input.inventory.files.map(file => file.path)),
        );
  if (
    packDelta.mode === 'fallback' ||
    (candidate.snapshot.extractorSet !== input.extractorSet &&
      candidate.snapshot.extractorSet !== extractorSetIdentityFromPackProvenance(candidate.receipt.packProvenance))
  ) {
    return Option.none();
  }
  const changedPackIds = new Set(packDelta.changedPackIds);
  const alignedCommitCandidate = sameInventoryPaths(candidate.files, input.inventory.files);
  const baseByPath = alignedCommitCandidate ? undefined : new Map(candidate.files.map(file => [file.path, file]));
  const currentPaths = alignedCommitCandidate ? undefined : new Set(input.inventory.files.map(file => file.path));
  const modifiedFiles = input.inventory.files.filter((file, index) => {
    const base = alignedCommitCandidate ? candidate.files[index] : baseByPath!.get(file.path);
    return codeGraphInventoryFileChanged(base, file, input.languagePacks, changedPackIds);
  });
  const deletedPaths = alignedCommitCandidate
    ? []
    : candidate.files.filter(file => !currentPaths!.has(file.path)).map(file => file.path);
  if (modifiedFiles.length === 0 && deletedPaths.length === 0) return Option.none();
  const assessmentInput = {
    candidate,
    inventory: input.inventory,
    languagePacks: input.languagePacks,
    layout: input.layout,
    store: input.store,
  };
  const boundedAssessment = yield* assessReusableCleanBaseCompatibility(assessmentInput, workspace, modifiedFiles);
  if (boundedAssessment.mode === 'fallback') return Option.none();
  const preassessment = boundedAssessment;
  return Option.some({
    committedBase: foldForwardBase
      ? foldForwardCommittedBase(foldForwardBase, leaseTokens.value)
      : persistedBaseCommittedBase(candidate, physicalSnapshot, leaseTokens.value.physical, input.identity.headCommit),
    preassessment,
  });
});
export const ensureCommittedBase = Effect.fn('codeGraph.ensureCommittedBase')(function* (input: {
  readonly buildOwner: CodeGraphBuildOwnerIdentity;
  readonly capacityProtection: DirectPersistentCapacityProtection;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly existing?: CodeGraphSnapshot;
  readonly force: boolean;
  readonly forceGeneration?: string;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly inventory: CodeGraphInventory;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly legacyBuildAdmission?: CodeGraphIndexResourceGate;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly persistentMaterializationTransactionBatchLimit?: 1 | 4;
  readonly preparationGate?: CodeGraphIndexResourceGate;
  readonly preparedSpoolBudgetGate?: CodeGraphPreparedSpoolBudgetGate;
  readonly requestedOverlay?: {readonly dirty: boolean; readonly fingerprint?: string};
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
}) {
  const cleanInventory = committedCodeGraphInventory(input.inventory);
  const extractorSet = extractorSetIdentity(cleanInventory.files, input.languagePacks);
  const graphContentId = graphContentIdentity(extractorSet, cleanInventory.files, cleanInventory.scope);
  const logicalSnapshotId = snapshotIdentity(
    input.identity,
    false,
    extractorSet,
    cleanInventory.files,
    cleanInventory.scope,
  );
  const snapshotId = forcedSnapshotIdentity(logicalSnapshotId, input.forceGeneration);
  const existingExact = yield* input.store.currentLexicalReadySnapshotById(input.layout.databasePath, snapshotId);
  const existing =
    existingExact ??
    (input.force
      ? undefined
      : yield* reusableReadySnapshotForCleanCommit({
          scopeId: input.inventory.scope?.scopeKey,
          databasePath: input.layout.databasePath,
          extractorSet,
          graphContentId,
          headCommit: input.identity.headCommit,
          repositoryId: input.identity.repositoryId,
          store: input.store,
        }));
  if (existing) {
    const lease = yield* input.store
      .acquireSnapshotLease(input.layout.databasePath, existing.id, CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS)
      .pipe(Effect.option);
    if (Option.isSome(lease)) {
      const leaseToken = yield* Effect.acquireRelease(Effect.succeed(lease.value), token =>
        input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.ignore),
      );
      const summary = {
        diagnostics: [],
        durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
        identity: input.identity,
        materialization: {mode: 'reused-snapshot', stagedFiles: 0, totalFiles: cleanInventory.files.length},
        reusedFiles: cleanInventory.files.length - cleanInventory.parsedFiles,
        skippedFiles: cleanInventory.skipped,
        snapshot: existing,
      } satisfies CodeGraphIndexSummary;
      return {
        diagnostics: [],
        leaseToken: Option.some(leaseToken),
        snapshot: existing,
        stagingReusable: false,
        summary,
      } satisfies CommittedBaseResult;
    }
  }
  const summary = yield* withExclusiveFileLock(
    input.fs,
    codeGraphSnapshotBuildLockPath(
      yield* Path.Path,
      input.threadnoteHome,
      input.identity.checkoutId,
      logicalSnapshotId,
    ),
    {
      ...CODE_GRAPH_LOCK_OPTIONS,
      onContention: () =>
        (input.onProgress?.({phase: 'waiting', reason: 'snapshot-build'}) ?? Effect.void).pipe(Effect.ignore),
    },
    Effect.gen(function* () {
      if (!input.force) {
        const ready =
          (yield* input.store.currentLexicalReadySnapshotById(input.layout.databasePath, logicalSnapshotId)) ??
          (yield* reusableReadySnapshotForCleanCommit({
            scopeId: input.inventory.scope?.scopeKey,
            databasePath: input.layout.databasePath,
            extractorSet,
            graphContentId,
            headCommit: input.identity.headCommit,
            repositoryId: input.identity.repositoryId,
            store: input.store,
          }));
        if (ready) {
          return {
            diagnostics: [],
            durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
            identity: input.identity,
            materialization: {mode: 'reused-snapshot', stagedFiles: 0, totalFiles: cleanInventory.files.length},
            reusedFiles: cleanInventory.files.length - cleanInventory.parsedFiles,
            skippedFiles: cleanInventory.skipped,
            snapshot: ready,
          } satisfies CodeGraphIndexSummary;
        }
      }
      const resumed = input.force
        ? yield* input.store.resumableForcedBuild(input.layout.databasePath, logicalSnapshotId)
        : undefined;
      const building: CodeGraphSnapshot = resumed ?? {
        commit: input.identity.headCommit,
        dirty: false,
        edgeCount: 0,
        extractorSet,
        fileCount: 0,
        graphContentId,
        id: snapshotId,
        repositoryId: input.identity.repositoryId,
        scopeId: input.inventory.scope?.scopeKey,
        state: 'building',
        symbolCount: 0,
        worktreeId: input.identity.worktreeId,
      };
      const ownerToken = yield* input.store.claimPersistentBuild(input.layout.databasePath, input.identity, building, {
        logicalSnapshotId,
        owner: input.buildOwner,
      });
      return yield* buildAndActivate({
        ...input,
        activatePointer: false,
        building,
        ensureVectors: false,
        existing: input.existing,
        inventory: cleanInventory,
        persistentOwnerToken: ownerToken,
      }).pipe(
        Effect.onInterrupt(() =>
          settleInterruptedCodeGraphBuild(input.store, input.layout.databasePath, building.id, ownerToken),
        ),
        Effect.catchIf(isNonResumableCodeGraphBuildFailure, cause =>
          input.store
            .markFailed(input.layout.databasePath, building.id, messageOf(cause), ownerToken)
            .pipe(Effect.andThen(Effect.fail(cause))),
        ),
      );
    }),
  );
  return {
    diagnostics: summary.diagnostics,
    leaseToken: Option.none(),
    snapshot: summary.snapshot,
    // Clean builds materialize into `building`; dirty overlays reuse the ready persisted base instead of a
    // connection-private full staging graph.
    stagingReusable: false,
    summary,
  } satisfies CommittedBaseResult;
});

const buildAndActivateInternal = Effect.fn('codeGraph.buildAndActivate')(function* (
  input: CodeGraphBuildAndActivateInput,
) {
  const splitPreparation =
    input.persistentOwnerToken !== undefined &&
    input.incrementalPrepared !== true &&
    input.incrementalAssessment?.mode !== 'eligible';
  const runPreparation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    splitPreparation && input.preparationGate ? input.preparationGate(effect) : effect;
  const workspace =
    input.workspace ??
    input.inventory.workspace ??
    (yield* runPreparation(input.languagePacks.discoverWorkspace(input.inventory.files)));
  const directPersistentMaterialization = input.persistentOwnerToken !== undefined;
  const materializationSpoolStoragePath = directPersistentMaterialization
    ? codeGraphMaterializationSpoolPath(yield* Path.Path, input.layout, input.building.id)
    : undefined;
  const protectDirectPersistentWrite = codeGraphDirectPersistentCapacityProtector(input);
  const persistentCapacityGuard = protectDirectPersistentWrite;
  const extractionDiagnostics: string[] = [...workspace.diagnostics];
  let materializedFiles = 0;
  let materializedShardFilesReused = 0;
  let materializedShardCacheDeferredFiles = 0;
  let materializedShardCacheDeferredRawFactBytes = 0;
  let materializedShardAssociationsComplete = directPersistentMaterialization;
  const totalFiles = input.sparseProjection?.totalFiles ?? input.inventory.files.length;
  const packProvenance =
    input.sparseProjection?.packProvenance ??
    input.languagePacks.activePackProvenance(input.inventory.files.map(file => file.path));
  const reusedFiles = totalFiles - input.inventory.parsedFiles;
  const incrementalAssessment =
    input.incrementalAssessment ??
    (input.inventory.dirty ? yield* assessIncrementalOverlay(input, workspace) : undefined);
  const fallbackAssessment =
    incrementalAssessment?.mode === 'fallback' ? incrementalAssessment.fallbackAssessment : undefined;
  const fallbackBoundary =
    incrementalAssessment?.mode === 'fallback' ? incrementalAssessment.fallbackBoundary : undefined;
  let fallbackReason: CodeGraphOverlayFallbackReason | undefined =
    incrementalAssessment?.mode === 'fallback'
      ? incrementalAssessment.reason
      : input.existing !== undefined &&
          input.existing.extractorSet !== input.building.extractorSet &&
          incrementalAssessment?.mode !== 'eligible'
        ? 'extractor-context-changed'
        : undefined;
  let incrementalApplied = false;
  let incrementalStorageTelemetry = input.incrementalMaterializationStorageTelemetry;
  if (incrementalAssessment?.mode === 'eligible') {
    const incrementalReusedFiles = totalFiles - incrementalAssessment.files.length;
    if (input.incrementalPrepared !== true) {
      yield* input.onProgress?.({
        completed: 0,
        phase: 'materializing',
        reused: incrementalReusedFiles,
        total: incrementalAssessment.files.length,
        unit: 'files',
      }) ?? Effect.void;
    }
    const applied = yield* applyIncrementalMaterialization({
      assessment: incrementalAssessment,
      baseSnapshotId: input.committedBase!.snapshot.id,
      databasePath: input.layout.databasePath,
      fs: input.fs,
      ...foldForwardPreparationOptions(input.committedBase?.foldForward),
      persistentCapacityProtector: protectDirectPersistentWrite,
      prepared: input.incrementalPrepared === true,
      storage: incrementalStorageTelemetry,
      store: input.store,
    });
    incrementalApplied = applied.result;
    incrementalStorageTelemetry = applied.storage;
    if (incrementalApplied) {
      if (input.incrementalPrepared !== true) {
        yield* input.store.stageWorkspaceCatalog(input.layout.databasePath, workspace, persistentCapacityGuard);
      }
      materializedFiles = incrementalAssessment.files.length;
      for (const diagnostic of [
        ...input.committedBase!.diagnostics,
        ...incrementalAssessment.facts.flatMap(file => file.diagnostics),
      ]) {
        if (extractionDiagnostics.length >= 100) break;
        if (!extractionDiagnostics.includes(diagnostic)) extractionDiagnostics.push(diagnostic);
      }
      yield* input.onProgress?.({
        completed: materializedFiles,
        ...(incrementalStorageTelemetry === undefined
          ? {}
          : {
              metrics: incrementalMaterializationMetrics(
                incrementalAssessment,
                incrementalStorageTelemetry,
                input.inventory.dirty,
              ),
            }),
        phase: 'materializing',
        reused: incrementalReusedFiles,
        total: incrementalAssessment.files.length,
        unit: 'files',
      }) ?? Effect.void;
    } else {
      fallbackReason = 'staging-identity-mismatch';
    }
  }
  if (!incrementalApplied) {
    const attributeFacts = createCachedCodeGraphFactsAttributor(input.inventory.files, workspace);
    const currentGraphContentId = graphContentIdentity(
      input.building.extractorSet,
      input.inventory.files,
      input.inventory.scope,
    );
    const repositorySemanticEnvelope = materializedShardRepositorySemanticEnvelope(input.inventory.files);
    const donorSnapshotIds = shardDonorIds(input.building.id, input.committedBase?.snapshot.id, input.existing?.id);
    const sourceBytesTotal = input.inventory.files.reduce((total, file) => total + file.size, 0);
    const cachedMetadata = yield* cachedFactsMetadata(
      input.store,
      input.layout.databasePath,
      input.inventory.files,
      input.languagePacks,
    );
    if (cachedMetadata.files !== input.inventory.files.length) {
      return yield* CodeGraphIndexOperationError.make({
        message: 'Cached code graph facts are incomplete during materialization planning; retry with a full rebuild.',
      });
    }
    const batches = factMaterializationBatches(input.inventory.files, cachedMetadata.bytesByPath);
    const cachedFactBytesTotal = cachedMetadata.bytes;
    const materializedShardCacheWriteAdmission = codeGraphMaterializedShardCacheWriteAdmission(cachedFactBytesTotal);
    const committedHashesByPath = new Map(input.inventory.committedFiles.map(file => [file.path, file.contentHash]));
    const changedCurrentPaths = new Set(
      input.inventory.files
        .filter(file => committedHashesByPath.get(file.path) !== file.contentHash)
        .map(file => file.path),
    );
    let replayMetrics = emptyMaterializationReplayMetrics();
    let changedFactBytesCompleted: number | undefined = 0;
    const storageEstimate = estimatedMaterializationStorageBytes(
      cachedFactBytesTotal,
      sourceBytesTotal,
      directPersistentMaterialization ? 'direct-persistent' : 'temporary-staged',
      'cached-fact-bytes',
    );
    const system = yield* SystemInfo;
    const [durableAvailableBytes, temporaryAvailableBytes, durableFilesystem, temporaryFilesystem] = yield* Effect.all(
      [
        system.availableDiskBytes(input.layout.repositoryRoot).pipe(Effect.orElseSucceed(() => undefined)),
        system.availableDiskBytes(system.tempDirectory).pipe(Effect.orElseSucceed(() => undefined)),
        input.fs.stat(input.layout.repositoryRoot).pipe(
          Effect.map(info => info.dev),
          Effect.option,
        ),
        input.fs.stat(system.tempDirectory).pipe(
          Effect.map(info => info.dev),
          Effect.option,
        ),
      ] as const,
      {concurrency: 'unbounded'},
    );
    const filesystemsShared =
      Option.isSome(durableFilesystem) && Option.isSome(temporaryFilesystem)
        ? durableFilesystem.value === temporaryFilesystem.value
        : undefined;
    const storagePlan = materializationStoragePlan(storageEstimate, {
      durableAvailableBytes,
      filesystemsShared,
      temporaryAvailableBytes,
    });
    let batchesCompleted = 0;
    // Attribution can split a cached-fact batch, so this lower bound converges as batches decode.
    let batchesTotal = batches.length;
    let sourceBytesCompleted = 0;
    let loadingMilliseconds = 0;
    let attributionMilliseconds = 0;
    const materializationSubphases = new MaterializationSubphaseTiming();
    let transactionMilliseconds = 0;
    let cachedFactBytesCompleted = 0;
    let factsBytesCompleted = 0;
    let durableDatabaseBytes = 0;
    let durableDatabaseHighWaterBytes = 0;
    const storageAtStart = yield* materializationStorageFiles(
      input.fs,
      input.layout.databasePath,
      materializationSpoolStoragePath ? [materializationSpoolStoragePath] : [],
    );
    let storageTelemetry = initialMaterializationStorageTelemetry(storageAtStart, directPersistentMaterialization);
    let lastStorageFileSampleAt = Number.NEGATIVE_INFINITY;
    let temporaryDatabaseBytes = 0;
    let temporaryDatabaseHighWaterBytes = 0;
    let materializedRows: CodeGraphMaterializationRows = {};
    const stageMilliseconds: Partial<Record<CodeGraphMaterializationActivity['stage'], number>> = {};
    const metrics = (finalFactsBytesTotal?: number): CodeGraphMaterializationMetrics => ({
      attributionMilliseconds,
      batchesCompleted,
      batchesTotal,
      cachedFactBytesCompleted,
      cachedFactBytesTotal,
      ...replayMetrics,
      ...(changedFactBytesCompleted === undefined ? {} : {changedFactBytesCompleted}),
      ...(fallbackAssessment === undefined ? {} : {fallbackAssessment}),
      ...(fallbackBoundary === undefined ? {} : {fallbackBoundary}),
      ...(fallbackReason === undefined ? {} : {fallbackReason}),
      factsBytesCompleted,
      ...(finalFactsBytesTotal === undefined ? {} : {factsBytesTotal: finalFactsBytesTotal}),
      loadingMilliseconds,
      mode: 'full',
      ...(incrementalAssessment?.resolutionPublicationAssessment
        ? {
            resolutionLookupKeyForm: incrementalAssessment.resolutionPublicationAssessment.lookupKeyForm,
            resolutionPublicationGate: incrementalAssessment.resolutionPublicationAssessment.gate,
          }
        : {}),
      rows: materializedRows,
      sourceBytesCompleted,
      sourceBytesTotal,
      stageMilliseconds: {...stageMilliseconds},
      // Only publish cumulative subphase evidence at the terminal update to avoid sustained allocator pressure.
      ...(finalFactsBytesTotal === undefined ? {} : {subphaseMilliseconds: materializationSubphases.snapshot()}),
      storage: {
        ...storagePlan,
        durableDatabaseBytes,
        durableDatabaseHighWaterBytes,
        ...storageTelemetry,
        temporaryDatabaseBytes,
        temporaryDatabaseHighWaterBytes,
      },
      transactionMilliseconds,
    });
    const materializationSpoolContext: CodeGraphMaterializationSpoolContext | undefined =
      directPersistentMaterialization
        ? {
            checkoutId: input.layout.checkoutId,
            onStorageObservation: current => {
              storageTelemetry = observeMaterializationStorage(storageTelemetry, current);
            },
            repositoryRoot: input.layout.repositoryRoot,
          }
        : undefined;
    const refreshStorageFiles = (force = false) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (!force && now - lastStorageFileSampleAt < 1_000) return;
        const current = yield* materializationStorageFiles(
          input.fs,
          input.layout.databasePath,
          materializationSpoolStoragePath ? [materializationSpoolStoragePath] : [],
        );
        storageTelemetry = observeMaterializationStorage(storageTelemetry, current);
        lastStorageFileSampleAt = now;
      });
    const storageShortfalls = materializationStorageShortfalls(storagePlan);
    if (storageShortfalls.length > 0) {
      extractionDiagnostics.push(
        directPersistentMaterialization
          ? `Available ${storageShortfalls.join(' and ')} disk space is below the advisory whole-build ` +
              'materialization estimate; indexing will continue under measured bounded-write reservations.'
          : `Available ${storageShortfalls.join(' and ')} disk space is below the heuristic materialization ` +
              'estimate; indexing will continue while reporting actual TEMP database usage.',
      );
    }
    yield* input.onProgress?.({
      completed: materializedFiles,
      metrics: metrics(),
      phase: 'materializing',
      reused: reusedFiles,
      total: totalFiles,
      unit: 'files',
    }) ?? Effect.void;
    yield* input.store.prepareActivation(
      input.layout.databasePath,
      input.inventory.files,
      directPersistentMaterialization ? input.building.id : undefined,
      undefined,
      input.persistentOwnerToken,
      persistentCapacityGuard,
    );
    yield* input.store.stageWorkspaceCatalog(input.layout.databasePath, workspace, persistentCapacityGuard);
    let persistentBatchCursor = 0;
    const persistentTransactionBatchLimit = input.persistentMaterializationTransactionBatchLimit ?? 4;
    const pendingBatches: PendingMaterializationBatch[] = [];
    const shardWrites = makeCodeGraphMaterializedShardWriteQueue({
      databasePath: input.layout.databasePath,
      onAssociation: elapsed => materializationSubphases.add('shardAssociation', elapsed),
      onCachePersistence: (elapsed, recordInAttribution) => {
        materializationSubphases.add('shardPersistence', elapsed);
        if (!recordInAttribution) return;
        attributionMilliseconds += elapsed;
        stageMilliseconds.attributing = attributionMilliseconds;
      },
      ownerToken: input.persistentOwnerToken!,
      persistentCapacityProtector: protectDirectPersistentWrite,
      snapshotId: input.building.id,
      store: input.store,
      transactionBatchLimit: persistentTransactionBatchLimit,
    });
    const reportStagingProgress = (batch: PendingMaterializationBatch, progress: CodeGraphStagingProgress) => {
      if (progress.temporaryDatabaseBytes !== undefined) {
        temporaryDatabaseBytes = progress.temporaryDatabaseBytes;
        temporaryDatabaseHighWaterBytes = Math.max(temporaryDatabaseHighWaterBytes, progress.temporaryDatabaseBytes);
      }
      if (progress.durableDatabaseBytes !== undefined) {
        durableDatabaseBytes = progress.durableDatabaseBytes;
        durableDatabaseHighWaterBytes = Math.max(durableDatabaseHighWaterBytes, progress.durableDatabaseBytes);
      }
      const activityStage = materializationStagingStage(progress);
      const timingKey = progress.stage === 'committed' ? 'committing' : progress.stage;
      const previousStageMilliseconds = batch.stageMilliseconds.get(timingKey) ?? 0;
      const currentStageMilliseconds = progress.stageElapsedMilliseconds ?? 0;
      const stageDeltaMilliseconds = Math.max(0, currentStageMilliseconds - previousStageMilliseconds);
      batch.stageMilliseconds.set(timingKey, currentStageMilliseconds);
      stageMilliseconds[activityStage] = (stageMilliseconds[activityStage] ?? 0) + stageDeltaMilliseconds;
      batch.rows = materializationRowsWithStoreProgress(batch.rows, progress);
      return refreshStorageFiles(progress.stage === 'committed').pipe(
        Effect.andThen(
          input.onProgress?.({
            activity: {
              batchCompleted: batch.batchIndex,
              batchTotal: batchesTotal,
              cachedFactBytes: batch.batchCachedFactBytes,
              elapsedMilliseconds: progress.elapsedMilliseconds,
              factsBytes: batch.factBytes,
              rows: batch.rows,
              sourceBytes: batch.sourceBytes,
              stage: activityStage,
              stageElapsedMilliseconds: currentStageMilliseconds,
              transactionMilliseconds: progress.elapsedMilliseconds,
            },
            completed: materializedFiles,
            metrics: metrics(),
            phase: 'materializing',
            reused: reusedFiles,
            total: totalFiles,
            unit: 'files',
          }) ?? Effect.void,
        ),
        Effect.ignore,
      );
    };
    const flushPendingBatches = () =>
      Effect.gen(function* () {
        yield* shardWrites.flushCaches();
        if (pendingBatches.length === 0) return;
        const group = pendingBatches.splice(0, pendingBatches.length);
        const groupByIndex = new Map(group.map(batch => [batch.batchIndex, batch]));
        const transactionStartedAt = yield* Clock.currentTimeMillis;
        if (directPersistentMaterialization) {
          const append = input.store.stageActivationFactBatches(
            input.layout.databasePath,
            group.map(batch => ({
              batchIndex: batch.batchIndex,
              edges: batch.edges,
              finalFactBytes: batch.factBytes,
              monikers: batch.monikers,
              references: batch.references,
              sourceBytes: batch.sourceBytes,
              symbols: batch.symbols,
            })),
            (batchIndex, progress) => reportStagingProgress(groupByIndex.get(batchIndex)!, progress),
            persistentCapacityGuard,
            materializationSpoolContext,
          );
          yield* input.preparationGate ? input.preparationGate(append) : append;
        } else {
          for (const batch of group) {
            yield* input.store.stageActivationFacts(
              input.layout.databasePath,
              batch.symbols,
              batch.edges,
              batch.references,
              progress => reportStagingProgress(batch, progress),
              batch.batchIndex,
              persistentCapacityGuard,
              batch.monikers,
            );
          }
        }
        const groupTransactionMilliseconds = (yield* Clock.currentTimeMillis) - transactionStartedAt;
        transactionMilliseconds += groupTransactionMilliseconds;
        for (let index = 0; index < group.length; index += 1) {
          const batch = group[index];
          const accountedTransactionMilliseconds = index === group.length - 1 ? groupTransactionMilliseconds : 0;
          materializedFiles += batch.fileCount;
          batchesCompleted += 1;
          sourceBytesCompleted += batch.sourceBytes;
          cachedFactBytesCompleted += batch.batchCachedFactBytes;
          factsBytesCompleted += batch.factBytes;
          materializedRows = addMaterializationRows(materializedRows, batch.rows);
          yield* input.onProgress?.({
            activity: {
              batchCompleted: batch.batchIndex,
              batchTotal: batchesTotal,
              cachedFactBytes: batch.batchCachedFactBytes,
              elapsedMilliseconds:
                batch.loadingMilliseconds + batch.attributionMilliseconds + accountedTransactionMilliseconds,
              factsBytes: batch.factBytes,
              rows: batch.rows,
              sourceBytes: batch.sourceBytes,
              stage: 'committing',
              transactionMilliseconds: accountedTransactionMilliseconds,
            },
            completed: materializedFiles,
            metrics: metrics(),
            phase: 'materializing',
            reused: reusedFiles,
            total: totalFiles,
            unit: 'files',
          }) ?? Effect.void;
        }
      });
    for (const files of batches) {
      const shardDerivationIdentity = materializedBatchShardDerivationIdentity(
        input.building.extractorSet,
        workspace.fingerprint,
        repositorySemanticEnvelope,
        files,
      );
      const sourceBytes = files.reduce((total, file) => total + file.size, 0);
      yield* input.onProgress?.({
        activity: {
          batchCompleted: batchesCompleted,
          batchTotal: batchesTotal,
          sourceBytes,
          stage: 'loading-cache',
        },
        completed: materializedFiles,
        metrics: metrics(),
        phase: 'materializing',
        reused: reusedFiles,
        total: totalFiles,
        unit: 'files',
      }) ?? Effect.void;
      const loadingStartedAt = yield* Clock.currentTimeMillis;
      // Attribution may inspect peer facts in this deterministic source batch (for example, TypeScript barrels).
      // Reuse only a complete batch so a hit/miss partition cannot become a persisted derivation input.
      const materializedShards =
        directPersistentMaterialization && input.sourceVerification === undefined
          ? yield* input.store.loadMaterializedFileShards(
              input.layout.databasePath,
              files,
              input.building.extractorSet,
              shardDerivationIdentity,
              {currentGraphContentId, snapshotIds: donorSnapshotIds},
            )
          : {
              bytes: 0,
              bytesByPath: new Map<string, number>(),
              exactGenerationFiles: 0,
              facts: new Map(),
              materializedShardIdsByPath: new Map<string, string>(),
            };
      const exactGenerationShardFiles = materializedShards.exactGenerationFiles;
      const materializedShardBatchComplete =
        directPersistentMaterialization &&
        exactGenerationShardFiles !== undefined &&
        Number.isSafeInteger(exactGenerationShardFiles) &&
        exactGenerationShardFiles >= 0 &&
        exactGenerationShardFiles <= files.length &&
        materializedShards.facts.size === files.length &&
        materializedShards.materializedShardIdsByPath?.size === files.length;
      const fallbackFiles = materializedShardBatchComplete ? [] : files;
      const cached = yield* runPreparation(
        loadCachedFacts(input.store, input.layout.databasePath, fallbackFiles, input.languagePacks),
      );
      const materializedShardCacheBatchPlan = codeGraphMaterializedShardCacheBatchPlan(
        materializedShardCacheWriteAdmission,
        materializedShardBatchComplete,
      );
      const deferMaterializedShardCache =
        directPersistentMaterialization && !materializedShardCacheBatchPlan.associationsComplete;
      // Count valid final-shard decodes even when an incomplete batch falls back to raw facts.
      const batchReplayBytes = Math.min(Number.MAX_SAFE_INTEGER, materializedShards.bytes + cached.bytes);
      replayMetrics = addMaterializationReplayMetrics(replayMetrics, {
        crossGenerationShardFiles: materializedShardBatchComplete ? files.length - exactGenerationShardFiles : 0,
        exactGenerationShardFiles: materializedShardBatchComplete ? exactGenerationShardFiles : 0,
        materializedShardReplayBytes: materializedShards.bytes,
        rawFactReplayBytes: cached.bytes,
      });
      // Changed-fact bytes measure the selected representation, not every physical cache decode.
      const batchChangedFactBytes = selectedDecodedFactBytes(
        materializedShardBatchComplete ? materializedShards.bytesByPath : cached.bytesByPath,
        files.filter(file => changedCurrentPaths.has(file.path)).map(file => file.path),
      );
      changedFactBytesCompleted =
        changedFactBytesCompleted === undefined || batchChangedFactBytes === undefined
          ? undefined
          : Math.min(Number.MAX_SAFE_INTEGER, changedFactBytesCompleted + batchChangedFactBytes);
      const batchLoadingMilliseconds = (yield* Clock.currentTimeMillis) - loadingStartedAt;
      loadingMilliseconds += batchLoadingMilliseconds;
      stageMilliseconds['loading-cache'] = loadingMilliseconds;
      if (fallbackFiles.some(file => !cached.facts.has(file.path))) {
        return yield* CachedCodeGraphFactUnavailableDuringIndex.make({});
      }
      yield* input.onProgress?.({
        activity: {
          batchCompleted: batchesCompleted,
          batchTotal: batchesTotal,
          cachedFactBytes: batchReplayBytes,
          elapsedMilliseconds: batchLoadingMilliseconds,
          sourceBytes,
          stage: 'attributing',
        },
        completed: materializedFiles,
        metrics: metrics(),
        phase: 'materializing',
        reused: reusedFiles,
        total: totalFiles,
        unit: 'files',
      }) ?? Effect.void;
      const batchAttributionStartedTotal = attributionMilliseconds;
      const sourceVerificationStartedAt = yield* Clock.currentTimeMillis;
      const materializationFacts =
        input.sourceVerification === undefined
          ? cached.facts
          : yield* input.sourceVerification.materializeFacts({facts: cached.facts, files: fallbackFiles});
      attributionMilliseconds += (yield* Clock.currentTimeMillis) - sourceVerificationStartedAt;
      let flushShardCacheAfterAttribution = false;
      const [attributionComputeMilliseconds, attributedFallbackFacts] = yield* measureCodeGraphAttribution(
        runPreparation,
        Effect.sync(() =>
          materializationSubphases.measure('attributionCompute', () =>
            attributeFacts(
              fallbackFiles.map(file =>
                input.languagePacks.postprocessFile(file, materializationFacts.get(file.path)!),
              ),
            ),
          ),
        ),
      );
      attributionMilliseconds += attributionComputeMilliseconds;
      const attributionPersistenceStartedAt = yield* Clock.currentTimeMillis;
      replayMetrics = addMaterializationReplayMetrics(replayMetrics, {
        attributedFiles: fallbackFiles.length,
        materializedShardCacheDeferredFiles: deferMaterializedShardCache ? fallbackFiles.length : 0,
        materializedShardCacheDeferredRawFactBytes: deferMaterializedShardCache ? cached.bytes : 0,
      });
      materializedShardCacheDeferredFiles = replayMetrics.materializedShardCacheDeferredFilesCompleted;
      materializedShardCacheDeferredRawFactBytes = replayMetrics.materializedShardCacheDeferredRawFactBytesCompleted;
      if (
        fallbackFiles.length > 0 &&
        directPersistentMaterialization &&
        materializedShardCacheBatchPlan.cacheFallback
      ) {
        const serializedFallbackFacts = materializationSubphases.measure('shardSerialization', () =>
          attributedFallbackFacts.map(fact => serializeBoundedCodeGraphFact(fact)),
        );
        flushShardCacheAfterAttribution = shardWrites.enqueueCache({
          derivationIdentity: shardDerivationIdentity,
          extractorSet: input.building.extractorSet,
          facts: serializedFallbackFacts,
          files: fallbackFiles,
        });
      }
      if (directPersistentMaterialization && materializedShardCacheBatchPlan.associate) {
        const selectedShardIds = materializedShardBatchComplete
          ? materializedShards.materializedShardIdsByPath
          : new Map(
              files.map(file => [
                file.path,
                materializedFileShardIdentity(
                  file.contentHash,
                  input.building.extractorSet,
                  shardDerivationIdentity,
                  file.path,
                ),
              ]),
            );
        const flushShardAssociations = shardWrites.enqueueAssociation({
          derivationIdentity: shardDerivationIdentity,
          extractorSet: input.building.extractorSet,
          files,
          selectedShardIds,
        });
        if (flushShardAssociations) {
          // This physical work is already captured by the batch-local attribution timer.
          yield* shardWrites.flushAssociations(false);
        }
      } else if (directPersistentMaterialization && !materializedShardCacheBatchPlan.associationsComplete) {
        materializedShardAssociationsComplete = false;
      }
      const attributedFallbackByPath = new Map(attributedFallbackFacts.map(fact => [fact.path, fact]));
      const facts = files.map(file =>
        materializedShardBatchComplete
          ? materializedShards.facts.get(file.path)!
          : attributedFallbackByPath.get(file.path)!,
      );
      materializedShardFilesReused += materializedShardBatchComplete ? files.length : 0;
      attributionMilliseconds += (yield* Clock.currentTimeMillis) - attributionPersistenceStartedAt;
      if (flushShardCacheAfterAttribution) yield* shardWrites.flushCaches();
      stageMilliseconds.attributing = attributionMilliseconds;
      const batchAttributionMilliseconds = attributionMilliseconds - batchAttributionStartedTotal;
      const finalBatchPreparationStartedAt = performance.now();
      const finalBatches = yield* runPreparation(Effect.sync(() => finalCodeGraphFactBatches(facts)));
      materializationSubphases.add('factBatchPreparation', performance.now() - finalBatchPreparationStartedAt);
      batchesTotal += Math.max(0, finalBatches.length - 1);
      if (extractionDiagnostics.length < 100) {
        extractionDiagnostics.push(
          ...finalBatches
            .flatMap(batch => batch.flatMap(value => value.facts.diagnostics))
            .slice(0, 100 - extractionDiagnostics.length),
        );
      }
      const filesByPath = new Map(files.map(file => [file.path, file]));
      for (let finalBatchIndex = 0; finalBatchIndex < finalBatches.length; finalBatchIndex += 1) {
        const rowPreparationStartedAt = performance.now();
        const finalBatch = finalBatches[finalBatchIndex];
        const finalFacts = finalBatch.map(value => value.facts);
        const batchFinalFactBytes = finalBatch.reduce((total, value) => total + value.bytes, 0);
        const batchFiles = finalFacts.map(fact => filesByPath.get(fact.path)!);
        const batchSourceBytes = batchFiles.reduce((total, file) => total + file.size, 0);
        const batchCachedFactBytes = batchFiles.reduce(
          (total, file) => total + (cachedMetadata.bytesByPath.get(file.path) ?? 0),
          0,
        );
        const symbols = uniqueById(finalFacts.flatMap(file => file.symbols));
        const relationships = deduplicateMaterializationRelationships(
          finalFacts.flatMap(file => file.edges),
          finalFacts.flatMap(file => file.references ?? []),
        );
        const edges = relationships.edges;
        const references = relationships.references;
        const monikers = canonicalCodeGraphMonikers(finalFacts.flatMap(file => file.monikers ?? []));
        const rows = materializationRows(symbols, edges.length, references, {
          edges: relationships.duplicateEdges,
          references: relationships.duplicateReferences,
        });
        materializationSubphases.add('factBatchPreparation', performance.now() - rowPreparationStartedAt);
        yield* input.onProgress?.({
          activity: {
            batchCompleted: batchesCompleted,
            batchTotal: batchesTotal,
            cachedFactBytes: batchCachedFactBytes,
            elapsedMilliseconds: finalBatchIndex === 0 ? batchAttributionMilliseconds : 0,
            factsBytes: batchFinalFactBytes,
            rows,
            sourceBytes: batchSourceBytes,
            stage: 'writing-facts',
          },
          completed: materializedFiles,
          metrics: metrics(),
          phase: 'materializing',
          reused: reusedFiles,
          total: totalFiles,
          unit: 'files',
        }) ?? Effect.void;
        const candidate: PendingMaterializationBatch = {
          attributionMilliseconds: finalBatchIndex === 0 ? batchAttributionMilliseconds : 0,
          batchCachedFactBytes,
          batchFiles,
          batchIndex: persistentBatchCursor,
          edges,
          factBytes: batchFinalFactBytes,
          fileCount: batchFiles.length,
          loadingMilliseconds: finalBatchIndex === 0 ? batchLoadingMilliseconds : 0,
          monikers,
          references,
          rows,
          sourceBytes: batchSourceBytes,
          stageMilliseconds: new Map(),
          symbols,
        };
        if (
          directPersistentMaterialization &&
          persistentMaterializationTransactionBatches([...pendingBatches, candidate], persistentTransactionBatchLimit)
            .length > 1
        ) {
          yield* flushPendingBatches();
        }
        pendingBatches.push(candidate);
        persistentBatchCursor += 1;
        const pendingFactsBytes = pendingBatches.reduce((total, batch) => total + batch.factBytes, 0);
        const pendingFiles = pendingBatches.reduce((total, batch) => total + batch.fileCount, 0);
        const pendingSourceBytes = pendingBatches.reduce((total, batch) => total + batch.sourceBytes, 0);
        if (
          !directPersistentMaterialization ||
          pendingBatches.length >= persistentTransactionBatchLimit ||
          pendingFiles >= PERSISTENT_MATERIALIZATION_TRANSACTION_FILES ||
          pendingSourceBytes >= PERSISTENT_MATERIALIZATION_TRANSACTION_SOURCE_BYTES ||
          pendingFactsBytes >= PERSISTENT_MATERIALIZATION_TRANSACTION_FACT_BYTES
        ) {
          yield* flushPendingBatches();
        }
      }
    }
    yield* flushPendingBatches();
    yield* shardWrites.flushCaches();
    yield* shardWrites.flushAssociations();
    batchesTotal = persistentBatchCursor;
    if (directPersistentMaterialization) {
      const preparedSpool =
        materializationSpoolContext && input.preparationGate
          ? yield* input.store.preparePersistentMaterializationSpool(
              input.layout.databasePath,
              persistentBatchCursor,
              persistentCapacityGuard,
              materializationSpoolContext,
              input.preparationGate,
            )
          : undefined;
      yield* input.store.finalizePersistentMaterializationPlan(
        input.layout.databasePath,
        persistentBatchCursor,
        persistentCapacityGuard,
        secondaryIndexRestorationReporter({
          batchCompleted: batchesCompleted,
          batchTotal: batchesTotal,
          completed: materializedFiles,
          metrics,
          onProgress: input.onProgress,
          refreshStorageFiles: () => refreshStorageFiles(true),
          reused: reusedFiles,
          stageMilliseconds,
          total: totalFiles,
        }),
        materializationSpoolContext,
        preparedSpool,
      );
      yield* refreshStorageFiles(true);
    }
    yield* input.onProgress?.({
      completed: materializedFiles,
      metrics: metrics(factsBytesCompleted),
      phase: 'materializing',
      reused: reusedFiles,
      total: totalFiles,
      unit: 'files',
    }) ?? Effect.void;
  }
  const reusableBaseReceipt =
    incrementalApplied && input.inventory.dirty
      ? undefined
      : currentSnapshotReusableBaseReceipt(input.inventory, workspace, packProvenance);
  yield* input.onProgress?.({phase: 'resolving', subphase: 'references'}) ?? Effect.void;
  const resolution = yield* input.store.resolveStagedReferences(
    input.layout.databasePath,
    activity =>
      (
        input.onProgress?.({
          activity,
          phase: 'resolving',
          subphase: 'references',
        }) ?? Effect.void
      ).pipe(Effect.ignore, Effect.andThen(Effect.yieldNow)),
    persistentCapacityGuard,
  );
  const stagedCounts = yield* input.store.stagedFactCounts(input.layout.databasePath);
  yield* input.onProgress?.({
    edges: stagedCounts.edges,
    phase: 'resolving',
    resolved: resolution.resolved,
    subphase: 'complete',
    symbols: stagedCounts.symbols,
  }) ?? Effect.void;
  yield* input.store.shrinkMemory(input.layout.databasePath);
  const ready: CodeGraphSnapshot = {
    ...input.building,
    edgeCount: stagedCounts.edges,
    fileCount: totalFiles,
    state: 'ready',
    symbolCount: stagedCounts.symbols,
  };
  yield* input.onProgress?.({phase: 'activating', snapshotId: ready.id, subphase: 'validating-input'}) ?? Effect.void;
  yield* verifyIndexInput(
    input.identity,
    input.activatePointer && !input.building.dirty && input.inventory.scope === undefined,
    input.threadnoteHome,
    input.requestedOverlay,
    input.inventory,
  );
  yield* input.onProgress?.({
    phase: 'activating',
    snapshotId: ready.id,
    subphase: 'writing-and-checkpointing',
  }) ?? Effect.void;
  const activationLease = yield* Effect.acquireRelease(
    input.store.activateStaged(
      input.layout.databasePath,
      input.identity,
      ready,
      reusableBaseReceipt,
      CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS,
      activity =>
        (
          input.onProgress?.({
            activity,
            phase: 'activating',
            snapshotId: ready.id,
          }) ?? Effect.void
        ).pipe(Effect.ignore),
      persistentCapacityGuard,
      packProvenance,
      directPersistentMaterialization && !incrementalApplied && materializedShardAssociationsComplete,
    ),
    lease =>
      Option.match(lease, {
        onNone: () => Effect.void,
        onSome: token => input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.ignore),
      }),
  );
  const activated = yield* input.store.currentLexicalReadySnapshotById(input.layout.databasePath, ready.id);
  if (!activated) {
    return yield* CodeGraphIndexOperationError.make({
      message: 'Activated code graph snapshot could not be read back from its store.',
    });
  }
  yield* input.store.shrinkMemory(input.layout.databasePath);
  if (input.activatePointer) {
    yield* input.onProgress?.({phase: 'activating', snapshotId: activated.id, subphase: 'promoting'}) ?? Effect.void;
    // A completed dirty target can become stale while progress callbacks run. Promote its coherent
    // snapshot before the post-promotion fence requests a retry; clean targets still require exact input.
    if (input.building.dirty && input.inventory.scope === undefined) {
      yield* verifyIndexInput(input.identity, false, input.threadnoteHome, input.requestedOverlay);
    } else {
      yield* verifyCommittedIndexInput({
        databasePath: input.layout.databasePath,
        identity: input.identity,
        scopeInventory: input.inventory,
        requestedOverlay: input.requestedOverlay,
        snapshotId: activated.id,
        store: input.store,
        threadnoteHome: input.threadnoteHome,
      });
    }
    yield* input.store.promote(input.layout.databasePath, input.identity, activated.id, {
      persistentCapacityProtector: protectDirectPersistentWrite,
    });
    yield* input.store.shrinkMemory(input.layout.databasePath);
    yield* input.onProgress?.({phase: 'activating', snapshotId: activated.id, subphase: 'promoting'}) ?? Effect.void;
    yield* verifyCommittedIndexInput({
      databasePath: input.layout.databasePath,
      identity: input.identity,
      scopeInventory: input.inventory,
      requestedOverlay: input.requestedOverlay,
      snapshotId: activated.id,
      store: input.store,
      threadnoteHome: input.threadnoteHome,
    });
    if (Option.isSome(activationLease)) {
      yield* input.store.releaseSnapshotLease(input.layout.databasePath, activationLease.value);
    }
  }
  if (input.committedBase && Option.isSome(input.committedBase.leaseToken)) {
    yield* input.store.releaseSnapshotLease(input.layout.databasePath, input.committedBase.leaseToken.value);
  }
  for (const token of input.committedBase?.additionalLeaseTokens ?? []) {
    yield* input.store.releaseSnapshotLease(input.layout.databasePath, token);
  }
  yield* input.onProgress?.({
    phase: 'activating',
    snapshotId: activated.id,
    subphase: input.activatePointer ? 'structural-ready' : 'complete',
  }) ?? Effect.void;
  const activatedReady = activated;
  let analysisSummaryFailure: string | undefined;
  const analysisSummaryBackfilled =
    input.activatePointer && !activatedReady.dirty
      ? yield* prepareReadyAnalysisSummary({
          databasePath: input.layout.databasePath,
          onProgress: input.onProgress,
          snapshotId: activatedReady.id,
          store: input.store,
        }).pipe(
          Effect.catch(cause =>
            Effect.sync(() => {
              analysisSummaryFailure = messageOf(cause);
              return false;
            }),
          ),
        )
      : yield* (
          input.onProgress?.({
            phase: 'activating',
            snapshotId: activatedReady.id,
            subphase: 'complete',
          }) ?? Effect.void
        ).pipe(Effect.as(false));
  const embedding = input.ensureVectors
    ? yield* input.embedding
        .ensure(
          input.threadnoteHome,
          input.layout,
          activatedReady,
          embeddingSymbolSource(input.store, input.layout.databasePath, activatedReady.id),
          {
            force: input.force,
            onProgress: input.onProgress,
          },
        )
        .pipe(
          Effect.catch(cause =>
            Effect.succeed({
              embedded: 0,
              ready: false,
              reason: messageOf(cause),
              reused: 0,
            } satisfies CodeGraphEmbeddingStatus),
          ),
        )
    : ({embedded: 0, ready: true, reused: 0} satisfies CodeGraphEmbeddingStatus);
  const foldForwardMaterialization =
    incrementalApplied && incrementalAssessment?.mode === 'eligible' && input.committedBase?.foldForward
      ? foldForwardMaterializationCounts(
          input.committedBase.foldForward.priorDeltaPaths,
          incrementalAssessment.files,
          incrementalAssessment.deletedPaths,
        )
      : undefined;
  if (input.activatePointer) {
    yield* input.fs.remove(input.layout.staleMarkerPath, {force: true}).pipe(Effect.ignore);
  }
  return {
    diagnostics: [
      ...(input.inventory.diagnostics ?? []),
      ...extractionDiagnostics,
      ...(input.inventory.dirty
        ? [
            incrementalApplied
              ? incrementalAssessment?.mode === 'eligible' && incrementalAssessment.reuse === 'persisted-base'
                ? `Dirty overlay reused persisted clean base for ${materializedFiles.toLocaleString()} modified file(s).`
                : `Dirty overlay reused clean staging for ${materializedFiles.toLocaleString()} modified file(s).`
              : `Dirty overlay used full materialization: ${overlayFallbackDescription(fallbackReason ?? 'staging-unavailable')}.`,
          ]
        : incrementalApplied
          ? [`Clean snapshot reused persisted base for ${materializedFiles.toLocaleString()} modified file(s).`]
          : []),
      ...(materializedShardFilesReused > 0
        ? [`Reused content-addressed materialized shards for ${materializedShardFilesReused.toLocaleString()} file(s).`]
        : []),
      ...(materializedShardCacheDeferredFiles > 0
        ? [
            `Deferred derived materialized-shard caching for ${materializedShardCacheDeferredFiles.toLocaleString()} ` +
              `file(s) covering ${materializedShardCacheDeferredRawFactBytes.toLocaleString()} raw fact byte(s).`,
          ]
        : []),
      ...(analysisSummaryBackfilled ? ['Built the persisted whole-graph analysis summary after promotion.'] : []),
      ...(analysisSummaryFailure
        ? [`Whole-graph analysis summary will be retried lazily: ${analysisSummaryFailure}`]
        : []),
      ...(embedding.ready ? [] : [`Vector graph retrieval unavailable: ${embedding.reason ?? 'unknown reason'}`]),
    ].slice(0, 100),
    durationMs: (yield* Clock.currentTimeMillis) - input.startedAt,
    identity: input.identity,
    ...(incrementalApplied && incrementalAssessment?.mode === 'eligible'
      ? {incrementalWork: incrementalAssessment.work}
      : {}),
    materialization: {
      ...(foldForwardMaterialization ?? {}),
      ...(incrementalApplied && incrementalAssessment?.mode === 'eligible'
        ? {
            ...(incrementalAssessment.closureProjects === undefined
              ? {}
              : {closureProjects: incrementalAssessment.closureProjects}),
            ...(incrementalAssessment.resolutionClosure === undefined
              ? {}
              : {resolutionClosure: incrementalAssessment.resolutionClosure}),
          }
        : {}),
      ...(fallbackReason ? {fallbackReason} : {}),
      ...(fallbackAssessment === undefined ? {} : {fallbackAssessment}),
      ...(fallbackBoundary === undefined ? {} : {fallbackBoundary}),
      ...(incrementalAssessment?.resolutionPublicationAssessment
        ? {
            resolutionLookupKeyForm: incrementalAssessment.resolutionPublicationAssessment.lookupKeyForm,
            resolutionPublicationGate: incrementalAssessment.resolutionPublicationAssessment.gate,
          }
        : {}),
      mode: incrementalApplied ? (input.inventory.dirty ? 'incremental-overlay' : 'incremental-clean') : 'full',
      stagedFiles: foldForwardMaterialization?.stagedFiles ?? materializedFiles,
      totalFiles,
    },
    reusedFiles,
    skippedFiles: input.inventory.skipped,
    snapshot: activatedReady,
  } satisfies CodeGraphIndexSummary;
});

export function buildAndActivate(input: CodeGraphBuildAndActivateInput) {
  return coordinateCodeGraphBuild(input, buildAndActivateInternal);
}
