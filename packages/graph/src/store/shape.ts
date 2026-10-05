import type {Effect, Option} from 'effect';
import type {ResolvedCodeGraphIndexScope} from '../index_scope.js';
import type {CodeGraphScopeApplicabilityEvidence} from '../scope/applicability.js';
import type {
  StoredCodeGraphScopeApplicability,
  StoredCodeGraphScopeReceipt,
} from '../scope/applicability_store_types.js';
import type * as SqlClient from 'effect/sql/SqlClient';
import type {CodeGraphBlobReuseFile} from '../blob_reuse.js';
import type {CodeGraphCacheFactInput} from '../fact/budget.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import type {
  CodeGraphEffectiveFileHashMatches,
  CodeGraphEffectiveFilePathObservation,
  CodeGraphEffectiveSnapshotCitationEvidence,
  CodeGraphEffectiveSnapshotCitationEvidenceRequest,
  CodeGraphEffectiveSymbolLocatorMatches,
  CodeGraphSymbolSemanticLocatorV1,
} from '../citation/primitives.js';
import type {
  CodeGraphActivationProgressCallback,
  CodeGraphActiveViewFence,
  CodeGraphActiveViewIdentity,
  CodeGraphAnalysisEdgeAggregatePage,
  CodeGraphAnalysisSummary,
  CodeGraphAnalysisSymbolAggregatePage,
  CodeGraphCheckpointImportBuildBindingResult,
  CodeGraphCheckpointImportBuildInput,
  CodeGraphCheckpointImportFinalizeOptions,
  CodeGraphCheckpointImportReceipt,
  CodeGraphCheckpointImportReceiptInput,
  CodeGraphCheckpointImportReceiptRecordResult,
  CodeGraphCheckpointImportRecordPage,
  CodeGraphCheckpointImportRecordPageResult,
  CodeGraphCleanSnapshotAliasOptions,
  CodeGraphDatabaseHealth,
  CodeGraphDatabaseRepair,
  CodeGraphDirectPersistentCapacityProtector,
  CodeGraphFactCacheBatch,
  CodeGraphEdgeCursor,
  CodeGraphPersistentBuildClaim,
  CodeGraphPreparationGate,
  CodeGraphPreparedMaterializationSpool,
  CodeGraphLanguagePackProvenance,
  CodeGraphMaterializationSpoolContext,
  CodeGraphMaterializedShardAssociationBatch,
  CodeGraphMaterializedShardCacheBatch,
  CodeGraphOrphanProvenanceCandidatePage,
  CodeGraphOrphanProvenanceViewObservation,
  CodeGraphRemovedViewCleanupAuthorizationResult,
  CodeGraphRemovedViewCleanupEntry,
  CodeGraphRemovedViewCleanupStoreOptions,
  CodeGraphRemovedViewCleanupUpdate,
  CodeGraphRemovedViewCleanupUpdateResult,
  CodeGraphResolutionProgressCallback,
  CodeGraphResolutionSummary,
  CodeGraphRetiredSnapshotCleanupProgressCallback,
  CodeGraphReusableBaseReceipt,
  CodeGraphReusableBaseReceiptInput,
  CodeGraphReusableCleanBase,
  CodeGraphReusableCleanBaseSlice,
  CodeGraphReusableFoldForwardBase,
  CodeGraphReusableReexport,
  CodeGraphReusableReexportSeed,
  CodeGraphSecondaryIndexRestorationProgressCallback,
  CodeGraphRoutineMaintenanceOptions,
  CodeGraphRoutineMaintenanceResult,
  CodeGraphSnapshotLeaseAcquireOptions,
  CodeGraphSnapshotLeaseWriterOptions,
  CodeGraphSnapshotPromotionOptions,
  CodeGraphSnapshotPurgeObservationResult,
  CodeGraphSnapshotPurgeStoreOptions,
  CodeGraphSnapshotPurgeStoreResult,
  CodeGraphStagingBatch,
  CodeGraphStagingBatchProgressCallback,
  CodeGraphStagingProgressCallback,
  CodeGraphSymbolCursor,
  CodeGraphViewObservationResult,
  CodeGraphViewRemovalResult,
  CodeGraphViewRemovalStoreOptions,
  CodeGraphViewSnapshotLeaseRetainOptions,
  CodeGraphViewSnapshotLeaseRetainResult,
  CodeGraphViewSnapshotLeaseValidationResult,
  CodeGraphVisualizationCatalog,
  CodeGraphVisualizationCatalogOptions,
  CodeGraphVisualizationEdgePage,
  CodeGraphVisualizationRelationshipSummary,
  CodeGraphVisualizationScope,
  CodeGraphVisualizationScopeEdge,
  CodeGraphVisualizationScopeEdgeSummary,
  CodeGraphWorktreeReconciliationCandidate,
  CodeGraphWorktreeReconciliationClaimOptions,
  CodeGraphWorktreeReconciliationIndexPreparationResult,
  CodeGraphWorktreeReconciliationPreparationOptions,
  LoadedCodeGraphFacts,
  StoredCodeGraph,
} from './models.js';
import type {CodeGraphPersistentSchemaMigrationPhase} from './schema/contracts.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphQueryNode,
  CodeGraphReference,
  CodeGraphSnapshot,
  CodeGraphStoreFailure,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '../types.js';

export interface CodeGraphStoreShape {
  readonly withSession: <A, E, R>(
    databasePath: string,
    effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
    options?: CodeGraphDatabaseSessionOptions,
  ) => Effect.Effect<A, E | CodeGraphStoreFailure, Exclude<R, SqlClient.SqlClient>>;
  /** Release disposable SQLite page-cache allocations between index phases. */
  readonly shrinkMemory: (databasePath: string) => Effect.Effect<void, CodeGraphStoreFailure>;
  /** Read-only preflight used before a long-lived process starts an isolated builder. */
  readonly assertRuntimeSchemaCompatible: (databasePath: string) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly bindCheckpointImportBuild: (
    databasePath: string,
    snapshotId: string,
    input: CodeGraphCheckpointImportBuildInput,
  ) => Effect.Effect<CodeGraphCheckpointImportBuildBindingResult, CodeGraphStoreFailure>;
  readonly checkpointImportReceipt: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphCheckpointImportReceipt | undefined, CodeGraphStoreFailure>;
  readonly finalizeCheckpointImport: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    ownerToken: string,
    input: CodeGraphCheckpointImportReceiptInput,
    options?: CodeGraphCheckpointImportFinalizeOptions,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly readySnapshotByLogicalDigest: (
    databasePath: string,
    repositoryId: string,
    logicalDigest: string,
    abiDigest?: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreFailure>;
  readonly recordCheckpointImportReceipt: (
    databasePath: string,
    snapshotId: string,
    input: CodeGraphCheckpointImportReceiptInput,
  ) => Effect.Effect<CodeGraphCheckpointImportReceiptRecordResult, CodeGraphStoreFailure>;
  readonly stageCheckpointImportRecordPage: (
    databasePath: string,
    snapshotId: string,
    ownerToken: string,
    page: CodeGraphCheckpointImportRecordPage,
  ) => Effect.Effect<CodeGraphCheckpointImportRecordPageResult, CodeGraphStoreFailure>;
  readonly activate: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    files: readonly CodeGraphInventoryFile[],
    symbols: readonly CodeGraphSymbol[],
    edges: readonly CodeGraphEdge[],
    snapshotPackProvenance?: readonly CodeGraphLanguagePackProvenance[],
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly activateStaged: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    reusableBaseReceipt?: CodeGraphReusableBaseReceiptInput,
    promotionLeaseDurationMilliseconds?: number,
    onProgress?: CodeGraphActivationProgressCallback,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
    snapshotPackProvenance?: readonly CodeGraphLanguagePackProvenance[],
    materializedFileShardAssociationsComplete?: boolean,
    checkpointImportReceipt?: CodeGraphCheckpointImportReceiptInput,
  ) => Effect.Effect<Option.Option<string>, CodeGraphStoreFailure>;
  readonly activateCleanSnapshotAlias?: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    baseSnapshotId: string,
    currentSnapshotReceipt: CodeGraphReusableBaseReceiptInput,
    options?: CodeGraphCleanSnapshotAliasOptions,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly cacheFacts: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphCacheFactInput[],
    extractorSet: string,
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly cacheFactBatches: (
    databasePath: string,
    batches: readonly CodeGraphFactCacheBatch[],
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly cacheMaterializedFileShards: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphCacheFactInput[],
    extractorSet: string,
    derivationIdentity: string,
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly cacheMaterializedFileShardBatches: (
    databasePath: string,
    batches: readonly CodeGraphMaterializedShardCacheBatch[],
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly associateMaterializedFileShardBatches: (
    databasePath: string,
    snapshotId: string,
    ownerToken: string,
    batches: readonly CodeGraphMaterializedShardAssociationBatch[],
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly acquireSnapshotLease: (
    databasePath: string,
    snapshotId: string,
    durationMilliseconds: number,
    options?: CodeGraphSnapshotLeaseAcquireOptions,
  ) => Effect.Effect<string, CodeGraphStoreFailure>;
  readonly retainViewSnapshotLease: (
    databasePath: string,
    worktreeId: string,
    snapshotId: string,
    durationMilliseconds: number,
    options?: CodeGraphViewSnapshotLeaseRetainOptions,
  ) => Effect.Effect<CodeGraphViewSnapshotLeaseRetainResult, CodeGraphStoreFailure>;
  readonly validateViewSnapshotLease: (
    databasePath: string,
    worktreeId: string,
    snapshotId: string,
    token: string,
    minimumRemainingMilliseconds: number,
  ) => Effect.Effect<CodeGraphViewSnapshotLeaseValidationResult, CodeGraphStoreFailure>;
  readonly promote: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshotId: string,
    options?: CodeGraphSnapshotPromotionOptions,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly observeView: (
    databasePath: string,
    worktreeId: string,
    expectedSnapshotId: string,
    scopeId?: string,
  ) => Effect.Effect<CodeGraphViewObservationResult, CodeGraphStoreFailure>;
  readonly claimWorktreeReconciliationCandidates: (
    databasePath: string,
    limit: number,
    options?: CodeGraphWorktreeReconciliationClaimOptions,
  ) => Effect.Effect<readonly CodeGraphWorktreeReconciliationCandidate[], CodeGraphStoreFailure>;
  readonly claimOrphanProvenanceCandidates: (
    databasePath: string,
    worktreeIds: readonly string[],
    limit: number,
    options?: CodeGraphWorktreeReconciliationClaimOptions,
  ) => Effect.Effect<CodeGraphOrphanProvenanceCandidatePage, CodeGraphStoreFailure>;
  readonly observeOrphanProvenanceView: (
    databasePath: string,
    worktreeId: string,
    options?: CodeGraphWorktreeReconciliationClaimOptions,
  ) => Effect.Effect<CodeGraphOrphanProvenanceViewObservation, CodeGraphStoreFailure>;
  readonly prepareWorktreeReconciliationIndexes: (
    databasePath: string,
    options?: CodeGraphWorktreeReconciliationPreparationOptions,
  ) => Effect.Effect<CodeGraphWorktreeReconciliationIndexPreparationResult, CodeGraphStoreFailure>;
  readonly removeView: (
    databasePath: string,
    worktreeId: string,
    expectedSnapshotId: string,
    options?: CodeGraphViewRemovalStoreOptions,
  ) => Effect.Effect<CodeGraphViewRemovalResult, CodeGraphStoreFailure>;
  readonly observeSnapshotPurge: (
    databasePath: string,
    snapshotId: string,
    nowMilliseconds: number,
  ) => Effect.Effect<CodeGraphSnapshotPurgeObservationResult, CodeGraphStoreFailure>;
  readonly purgeSnapshot: (
    databasePath: string,
    snapshotId: string,
    expectedGraphEvidenceDigest: string,
    nowMilliseconds: number,
    options?: CodeGraphSnapshotPurgeStoreOptions,
  ) => Effect.Effect<CodeGraphSnapshotPurgeStoreResult, CodeGraphStoreFailure>;
  readonly claimRemovedViewCleanupCandidates: (
    databasePath: string,
    nowMilliseconds: number,
    limit: number,
    options?: CodeGraphRemovedViewCleanupStoreOptions,
  ) => Effect.Effect<readonly CodeGraphRemovedViewCleanupEntry[], CodeGraphStoreFailure>;
  readonly authorizeRemovedViewCleanup: (
    databasePath: string,
    entry: CodeGraphRemovedViewCleanupEntry,
    options?: CodeGraphRemovedViewCleanupStoreOptions,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupAuthorizationResult, CodeGraphStoreFailure>;
  readonly updateRemovedViewCleanup: (
    databasePath: string,
    entry: CodeGraphRemovedViewCleanupEntry,
    update: CodeGraphRemovedViewCleanupUpdate,
    options?: CodeGraphRemovedViewCleanupStoreOptions,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupUpdateResult, CodeGraphStoreFailure>;
  readonly initialize: (
    databasePath: string,
    options?: {readonly waitTimeoutMilliseconds?: number},
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly prepareActivation: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    persistentSnapshotId?: string,
    persistentBatchCount?: number,
    persistentOwnerToken?: string,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly finalizePersistentMaterializationPlan: (
    databasePath: string,
    expectedBatchCount: number,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
    onSecondaryIndexProgress?: CodeGraphSecondaryIndexRestorationProgressCallback,
    materializationSpool?: CodeGraphMaterializationSpoolContext,
    preparedSpool?: CodeGraphPreparedMaterializationSpool,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly preparePersistentMaterializationSpool: (
    databasePath: string,
    expectedBatchCount: number,
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector | undefined,
    materializationSpool: CodeGraphMaterializationSpoolContext,
    preparationGate: CodeGraphPreparationGate,
  ) => Effect.Effect<CodeGraphPreparedMaterializationSpool, CodeGraphStoreFailure | unknown>;
  readonly preparePersistedIncrementalActivation: (
    databasePath: string,
    baseSnapshotId: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
    options?: {
      readonly deletedPaths?: readonly string[];
      readonly foldForward?: {
        readonly snapshotId: string;
        readonly stagedPayloadBytes: number;
        readonly stagedRows: number;
      };
      readonly resolutionClosure?: 'changed' | 'full' | 'project';
    },
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<boolean, CodeGraphStoreFailure>;
  readonly replaceStagedModifiedFiles: (
    databasePath: string,
    baseSnapshotId: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<boolean, CodeGraphStoreFailure>;
  readonly diagnose: (
    databasePath: string,
  ) => Effect.Effect<CodeGraphDatabaseHealth | undefined, CodeGraphStoreFailure>;
  readonly cachedCommittedFileKeys: (
    databasePath: string,
    extractorSet: string,
    files?: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  ) => Effect.Effect<ReadonlySet<string>, CodeGraphStoreFailure>;
  readonly discardInvalidCachedFacts?: (
    databasePath: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly loadCachedFacts: (
    databasePath: string,
    files: readonly CodeGraphBlobReuseFile[],
    extractorSet: string,
    options?: {readonly decode?: boolean},
  ) => Effect.Effect<LoadedCodeGraphFacts, CodeGraphStoreFailure>;
  readonly loadMaterializedFileShards: (
    databasePath: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
    extractorSet: string,
    derivationIdentity: string,
    provenance?: {
      readonly currentGraphContentId: string;
      readonly snapshotIds: readonly string[];
    },
  ) => Effect.Effect<LoadedCodeGraphFacts, CodeGraphStoreFailure>;
  readonly loadSnapshotMaterializedFileShards?: (
    databasePath: string,
    snapshotId: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  ) => Effect.Effect<LoadedCodeGraphFacts, CodeGraphStoreFailure>;
  readonly loadGraph: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<StoredCodeGraph, CodeGraphStoreFailure>;
  readonly loadSymbols: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreFailure>;
  readonly loadEdgePage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphEdgeCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphEdge[], CodeGraphStoreFailure>;
  readonly loadSymbolPage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphSymbolCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreFailure>;
  readonly loadAnalysisSymbolAggregatePage: (
    databasePath: string,
    snapshotId: string,
    cursorId: string | undefined,
    limit: number,
  ) => Effect.Effect<CodeGraphAnalysisSymbolAggregatePage, CodeGraphStoreFailure>;
  readonly loadAnalysisEdgeAggregatePage: (
    databasePath: string,
    snapshotId: string,
    cursorId: string | undefined,
    limit: number,
  ) => Effect.Effect<CodeGraphAnalysisEdgeAggregatePage, CodeGraphStoreFailure>;
  readonly loadAnalysisSummary: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<Option.Option<CodeGraphAnalysisSummary>, CodeGraphStoreFailure>;
  readonly ensureAnalysisSummary: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<boolean, CodeGraphStoreFailure>;
  readonly countEmbeddingSymbols: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<number, CodeGraphStoreFailure>;
  readonly loadEmbeddingSymbolPage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphSymbolCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreFailure>;
  readonly loadVisualizationCatalog: (
    databasePath: string,
    metrics?: 'complete' | 'deferred',
    options?: CodeGraphVisualizationCatalogOptions,
  ) => Effect.Effect<CodeGraphVisualizationCatalog | undefined, CodeGraphStoreFailure>;
  readonly loadActiveViewIdentities: (
    databasePath: string,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphActiveViewIdentity[], CodeGraphStoreFailure>;
  readonly loadActiveViewFence: (
    databasePath: string,
    worktreeId: string,
    scopeId?: string,
  ) => Effect.Effect<CodeGraphActiveViewFence | undefined, CodeGraphStoreFailure>;
  readonly loadVisualizationCatalogs: (
    databasePath: string,
    metrics?: 'complete' | 'deferred',
    options?: CodeGraphVisualizationCatalogOptions,
  ) => Effect.Effect<readonly CodeGraphVisualizationCatalog[], CodeGraphStoreFailure>;
  readonly loadVisualizationScopeEdges: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphVisualizationScopeEdge[], CodeGraphStoreFailure>;
  readonly loadVisualizationScopeEdgeSummary: (
    databasePath: string,
    snapshotId: string,
    scopeIds: readonly string[],
    limit: number,
  ) => Effect.Effect<CodeGraphVisualizationScopeEdgeSummary, CodeGraphStoreFailure>;
  readonly loadVisualizationSymbols: (
    databasePath: string,
    snapshotId: string,
    scope: CodeGraphVisualizationScope,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreFailure>;
  readonly edgesForNodes: (
    databasePath: string,
    snapshotId: string,
    nodeIds: readonly string[],
    direction: 'both' | 'incoming' | 'outgoing',
    limit: number,
    allowedProvenances: readonly CodeGraphProvenance[],
  ) => Effect.Effect<readonly CodeGraphEdge[], CodeGraphStoreFailure>;
  readonly directEdgeBetweenNodes: (
    databasePath: string,
    snapshotId: string,
    sourceId: string,
    targetId: string,
    allowedProvenances: readonly CodeGraphProvenance[],
  ) => Effect.Effect<CodeGraphEdge | undefined, CodeGraphStoreFailure>;
  readonly representativeEdgesForNodes: (
    databasePath: string,
    snapshotId: string,
    nodeIds: readonly string[],
    direction: 'both' | 'incoming' | 'outgoing',
    limit: number,
    allowedProvenances: readonly CodeGraphProvenance[],
  ) => Effect.Effect<CodeGraphVisualizationEdgePage, CodeGraphStoreFailure>;
  readonly relationshipSummaryForNode: (
    databasePath: string,
    snapshotId: string,
    nodeId: string,
    allowedProvenances: readonly CodeGraphProvenance[],
    limit?: number,
  ) => Effect.Effect<CodeGraphVisualizationRelationshipSummary, CodeGraphStoreFailure>;
  readonly findSymbolsByPathAndName: (
    databasePath: string,
    snapshotId: string,
    path: string,
    name: string,
  ) => Effect.Effect<readonly CodeGraphQueryNode[], CodeGraphStoreFailure>;
  readonly markBuilding: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly claimPersistentBuild: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    claim: CodeGraphPersistentBuildClaim,
  ) => Effect.Effect<string, CodeGraphStoreFailure>;
  readonly releasePersistentBuild: (
    databasePath: string,
    snapshotId: string,
    summary: string,
    ownerToken: string,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly resumableForcedBuild: (
    databasePath: string,
    logicalSnapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreFailure>;
  readonly resumableBuildById: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreFailure>;
  readonly retireIncompleteWorktreeSnapshots: (
    databasePath: string,
    repositoryId: string,
    worktreeId: string,
    retainedSnapshotIds: ReadonlySet<string>,
    onProgress?: CodeGraphRetiredSnapshotCleanupProgressCallback,
    options?: {readonly cleanupMode?: 'deferred' | 'required'; readonly scopeId?: string},
  ) => Effect.Effect<number, CodeGraphStoreFailure>;
  readonly markFailed: (
    databasePath: string,
    snapshotId: string,
    summary: string,
    ownerToken?: string,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly readySnapshot: (
    databasePath: string,
    worktreeId: string,
    scopeId?: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreFailure>;
  readonly loadScopeApplicability: (
    databasePath: string,
    worktreeId: string,
    scopeId?: string,
  ) => Effect.Effect<StoredCodeGraphScopeApplicability | undefined, CodeGraphStoreFailure>;
  readonly loadSnapshotScopeReceipt: (
    databasePath: string,
    snapshotId: string,
    scopeId: string,
  ) => Effect.Effect<StoredCodeGraphScopeReceipt | undefined, CodeGraphStoreFailure>;
  readonly recordScopeApplicability: (
    databasePath: string,
    snapshotId: string,
    evidence: CodeGraphScopeApplicabilityEvidence,
    scope?: ResolvedCodeGraphIndexScope,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly readySnapshotById: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreFailure>;
  readonly currentLexicalReadySnapshotById: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreFailure>;
  readonly readySnapshotForCommit: (
    databasePath: string,
    repositoryId: string,
    commit: string,
    extractorSet?: string,
    scopeId?: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreFailure>;
  readonly recentReadySnapshotsForRepository: (
    databasePath: string,
    repositoryId: string,
    scopeId?: string,
  ) => Effect.Effect<readonly CodeGraphSnapshot[], CodeGraphStoreFailure>;
  readonly reusableBaseReceipt: (
    databasePath: string,
    snapshotId: string,
    options?: {readonly allowDirtyRoot?: boolean},
  ) => Effect.Effect<CodeGraphReusableBaseReceipt | undefined, CodeGraphStoreFailure>;
  /** Exact clean layered snapshot admitted only as a logical fold-forward comparator. */
  readonly reusableFoldForwardBase?: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphReusableFoldForwardBase | undefined, CodeGraphStoreFailure>;
  readonly snapshotPackProvenance: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphLanguagePackProvenance[] | undefined, CodeGraphStoreFailure>;
  readonly reusableCleanBase?: (
    databasePath: string,
    repositoryId: string,
    extractorSet: string,
    workspaceFingerprint: string,
    fileSetFingerprint: string,
    graphContentId?: string,
    preferredCommitGroups?: readonly (readonly string[])[],
    allowExtractorMismatch?: boolean,
    workspaceProjectsJson?: string,
    excludedSnapshotIds?: readonly string[],
    scopeId?: string,
  ) => Effect.Effect<CodeGraphReusableCleanBase | undefined, CodeGraphStoreFailure>;
  readonly reusableCleanBaseForCommit: (
    databasePath: string,
    repositoryId: string,
    commit: string,
    scopeId?: string,
  ) => Effect.Effect<CodeGraphReusableCleanBase | undefined, CodeGraphStoreFailure>;
  readonly reusableCleanBaseForCommitPaths?: (
    databasePath: string,
    repositoryId: string,
    commit: string,
    paths: readonly string[],
    scopeId?: string,
  ) => Effect.Effect<CodeGraphReusableCleanBaseSlice | undefined, CodeGraphStoreFailure>;
  readonly existingSnapshotFilePaths?: (
    databasePath: string,
    snapshotId: string,
    paths: readonly string[],
  ) => Effect.Effect<readonly string[] | undefined, CodeGraphStoreFailure>;
  /** Bounded effective sparse-overlay-plus-base file observations, aligned to unique input paths. */
  readonly effectiveSnapshotFilesByPaths: (
    databasePath: string,
    snapshotId: string,
    paths: readonly string[],
  ) => Effect.Effect<readonly CodeGraphEffectiveFilePathObservation[], CodeGraphStoreFailure>;
  /** Bounded effective file relocation candidates, aligned to unique input hashes. */
  readonly effectiveSnapshotFilesByContentHashes: (
    databasePath: string,
    snapshotId: string,
    contentHashes: readonly string[],
    limitPerHash: number,
  ) => Effect.Effect<readonly CodeGraphEffectiveFileHashMatches[], CodeGraphStoreFailure>;
  /** Bounded, exact, path-independent effective symbol candidates. */
  readonly effectiveSnapshotSymbolsBySemanticLocators: (
    databasePath: string,
    snapshotId: string,
    locators: readonly CodeGraphSymbolSemanticLocatorV1[],
    limitPerLocator: number,
  ) => Effect.Effect<readonly CodeGraphEffectiveSymbolLocatorMatches[], CodeGraphStoreFailure>;
  /**
   * All bounded citation observations in one read-only database session.
   * Callers observing a displaced/workset snapshot must hold its snapshot lease
   * for the full call and independently verify current-worktree identity.
   */
  readonly effectiveSnapshotCitationEvidence: (
    databasePath: string,
    snapshotId: string,
    request: CodeGraphEffectiveSnapshotCitationEvidenceRequest,
  ) => Effect.Effect<CodeGraphEffectiveSnapshotCitationEvidence, CodeGraphStoreFailure>;
  readonly snapshotProjectClosureFiles?: (
    databasePath: string,
    snapshotId: string,
    prefixes: readonly string[],
  ) => Effect.Effect<readonly CodeGraphInventoryFile[] | undefined, CodeGraphStoreFailure>;
  readonly reusableOverlayBase?: (
    databasePath: string,
    repositoryId: string,
    extractorSet: string,
    overlayFingerprint: string,
  ) => Effect.Effect<CodeGraphReusableCleanBase | undefined, CodeGraphStoreFailure>;
  readonly reusableReexports: (
    databasePath: string,
    snapshotId: string,
    seeds: readonly CodeGraphReusableReexportSeed[],
    options?: {readonly allowDirtyRoot?: boolean; readonly maxRows?: number},
  ) => Effect.Effect<readonly CodeGraphReusableReexport[] | undefined, CodeGraphStoreFailure>;
  readonly pruneCachedFacts: (
    databasePath: string,
    acceptedExtractorSets?: readonly string[],
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly pruneRetiredSnapshots: (databasePath: string) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly repair: (
    databasePath: string,
    dryRun?: boolean,
    options?: {
      /** @internal Set only after bounded preparation proves that migration preserves incomplete snapshots. */
      readonly allowSchemaMigrationPreview?: boolean;
    },
  ) => Effect.Effect<CodeGraphDatabaseRepair | undefined, CodeGraphStoreFailure>;
  readonly runRoutineMaintenance: (
    databasePath: string,
    options?: CodeGraphRoutineMaintenanceOptions,
  ) => Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreFailure>;
  readonly releaseSnapshotLease: (
    databasePath: string,
    token: string,
    options?: CodeGraphSnapshotLeaseWriterOptions,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly renewSnapshotLease: (
    databasePath: string,
    token: string,
    durationMilliseconds: number,
    options?: CodeGraphSnapshotLeaseWriterOptions,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly searchSymbols: (
    databasePath: string,
    snapshotId: string,
    query: string,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphQueryNode[], CodeGraphStoreFailure>;
  readonly searchSymbolsMany: (
    databasePath: string,
    snapshotId: string,
    queries: readonly string[],
    limit: number,
  ) => Effect.Effect<readonly (readonly CodeGraphQueryNode[])[], CodeGraphStoreFailure>;
  readonly searchSymbolsByPaths: (
    databasePath: string,
    snapshotId: string,
    paths: readonly string[],
    limitPerPath: number,
  ) => Effect.Effect<readonly (readonly CodeGraphQueryNode[])[], CodeGraphStoreFailure>;
  readonly symbolsByIds: (
    databasePath: string,
    snapshotId: string,
    ids: readonly string[],
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreFailure>;
  readonly stageActivationFacts: (
    databasePath: string,
    symbols: readonly CodeGraphSymbol[],
    edges: readonly CodeGraphEdge[],
    references?: readonly CodeGraphReference[],
    onProgress?: CodeGraphStagingProgressCallback,
    batchIndex?: number,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
    monikers?: readonly CodeGraphMonikerV1[],
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly stageActivationFactBatches: (
    databasePath: string,
    batches: readonly CodeGraphStagingBatch[],
    onProgress?: CodeGraphStagingBatchProgressCallback,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
    materializationSpool?: CodeGraphMaterializationSpoolContext,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly stageWorkspaceCatalog: (
    databasePath: string,
    workspace: CodeGraphWorkspace,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreFailure>;
  readonly resolveStagedReferences: (
    databasePath: string,
    onProgress?: CodeGraphResolutionProgressCallback,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<CodeGraphResolutionSummary, CodeGraphStoreFailure>;
  readonly stagedFactCounts: (
    databasePath: string,
  ) => Effect.Effect<{readonly edges: number; readonly symbols: number}, CodeGraphStoreFailure>;
}

export interface CodeGraphDatabaseSessionOptions {
  /** @internal Open a writable connection only when the database already exists. */
  readonly existingOnly?: boolean;
  /** @internal Open a non-creating, query-only SQLite connection without WAL bootstrap writes. */
  readonly readOnly?: boolean;
  /** @internal Ordinary index sessions reclaim a bounded page of completed build-only rows after foreground work. */
  readonly cleanupCompletedBuildRows?: boolean;
  /** @internal Observes the point at which gated background cleanup may open SQLite. */
  readonly onCompletedBuildCleanupConnection?: () => Effect.Effect<void, never>;
  /** @internal Deterministic transaction-boundary observer used by migration fault tests. */
  readonly onPersistentSchemaMigrationPhase?: (
    phase: CodeGraphPersistentSchemaMigrationPhase,
  ) => Effect.Effect<void, never>;
  /** @internal Deterministic checkout-writer acquisition observer used by coordination tests. */
  readonly onWriterAcquired?: () => Effect.Effect<void, never>;
  readonly onWriterContention?: () => Effect.Effect<void, never>;
  readonly onWriterReleased?: () => Effect.Effect<void, never>;
  /** @internal Records effective PRAGMA values for controlled benchmark evidence. */
  readonly onSqliteWriterConfigured?: (settings: CodeGraphSqliteWriterSettings) => Effect.Effect<void, never>;
  /** @internal Benchmark-only overrides. Production indexing leaves this unset. */
  readonly sqliteWriterTuning?: CodeGraphSqliteWriterTuning;
  /** @internal The caller already owns this database's checkout-wide writer gate. */
  readonly writerGateHeld?: boolean;
  readonly writerLockPath?: string;
}

export interface CodeGraphSqliteWriterTuning {
  readonly mainCacheKiB?: number;
  readonly mmapSizeBytes?: number;
  /** Use NORMAL only while a clean, unpublished snapshot remains reconstructible. */
  readonly reconstructibleBuildSynchronous?: 'normal';
  readonly walAutoCheckpointPages?: number;
}

export interface CodeGraphSqliteWriterSettings {
  readonly cacheSizePragma: number;
  readonly journalMode: string;
  readonly mmapSizeBytes: number;
  readonly phase: 'building' | 'connection' | 'publication';
  readonly synchronous: number;
  readonly walAutoCheckpointPages: number;
}
