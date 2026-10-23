import type {CodeGraphLeaseTimingObserver} from './lease_timing.js';
import type {Effect, Option} from 'effect';
import type {CodeGraphBuildOwnerIdentity} from '../build/owner.js';
import type {CodeGraphDirectPersistentCapacityBoundary} from '../disk/capacity.js';
import type {CodeGraphCacheFactInput} from '../fact/budget.js';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import type {CodeGraphCheckpointRecordKind, CodeGraphCheckpointRecordV1} from '../checkpoint/schema.js';
import type {
  CodeGraphWorkspaceBuildSystem,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceProvenance,
  CodeGraphWorkspace,
} from '../languages/types.js';
import {
  type CodeGraphSnapshotFileCitationBaseIndexState,
  type CodeGraphSnapshotFileCitationSchemaState,
  type CodeGraphEdge,
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphProvenance,
  type CodeGraphReference,
  type CodeGraphResolutionActivity,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  type CodeGraphStoreFailure,
} from '../types.js';
import {
  CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
  type CodeGraphInventoryExclusionReason,
} from '../inventory/policy.js';
import {
  CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION,
  CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
  CODE_GRAPH_RESOLUTION_SURFACE_VERSION,
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  codeGraphRuntimeSchemaRequiresReconnect,
} from './schema/revision.js';

export {
  CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION,
  CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
  CODE_GRAPH_RESOLUTION_SURFACE_VERSION,
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  codeGraphRuntimeSchemaRequiresReconnect,
};

export type CodeGraphCheckpointTrust = 'expected-descriptor-verified' | 'local-unverified';

export interface CodeGraphCheckpointSha256Digest {
  readonly algorithm: 'sha256';
  readonly digest: string;
}

export interface CodeGraphCheckpointArtifactDescriptor extends CodeGraphCheckpointSha256Digest {
  readonly mediaType: string;
  readonly size: number;
}

export interface CodeGraphCheckpointCoverageReason {
  readonly bytes: number;
  readonly code: string;
  readonly files: number;
}

export interface CodeGraphCheckpointCoverageSummary {
  readonly eligibleFiles: number;
  readonly excludedFiles: number;
  readonly reasons: readonly CodeGraphCheckpointCoverageReason[];
  readonly state: 'complete' | 'partial';
}

/**
 * Local provenance bound to a receiving clean root. Donor process, worktree,
 * environment, and database snapshot identities are intentionally absent.
 */
export interface CodeGraphCheckpointImportReceiptInput {
  readonly abi: CodeGraphCheckpointSha256Digest;
  readonly artifact: CodeGraphCheckpointArtifactDescriptor;
  /** Reserved for future delta formats; v1 self-contained roots require null. */
  readonly baseLogicalDigest: string | null;
  readonly coverage: CodeGraphCheckpointCoverageSummary;
  readonly formatVersion: typeof CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION;
  readonly logical: CodeGraphCheckpointSha256Digest;
  readonly source: {
    readonly commit: string;
    readonly graphContentId: string;
    readonly repositoryId: string;
  };
  readonly trust: CodeGraphCheckpointTrust;
}

export interface CodeGraphCheckpointImportReceipt extends CodeGraphCheckpointImportReceiptInput {
  readonly importedAt: string;
  /** Newly created local receiving snapshot, never a donor database identity. */
  readonly snapshotId: string;
}

export interface CodeGraphCheckpointImportBuildInput extends CodeGraphCheckpointImportReceiptInput {
  readonly batchCount: number;
  readonly packProvenance: readonly CodeGraphLanguagePackProvenance[];
  readonly recordCounts: Readonly<Record<CodeGraphCheckpointRecordKind, number>>;
}

export interface CodeGraphCheckpointImportRecordPage {
  readonly batchIndex: number;
  readonly digest: CodeGraphCheckpointSha256Digest;
  readonly records: readonly CodeGraphCheckpointRecordV1[];
}

export type CodeGraphCheckpointImportRecordPageResult =
  {readonly records: number; readonly state: 'already-staged'} | {readonly records: number; readonly state: 'staged'};

export interface CodeGraphCheckpointImportFinalizeOptions {
  readonly onProgress?: CodeGraphActivationProgressCallback;
  readonly persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector;
  readonly reusableBaseReceipt?: CodeGraphReusableBaseReceiptInput;
}

export type CodeGraphCheckpointImportBuildBindingResult = {readonly state: 'already-bound'} | {readonly state: 'bound'};

export type CodeGraphCheckpointImportReceiptRecordResult =
  | {readonly receipt: CodeGraphCheckpointImportReceipt; readonly state: 'already-recorded'}
  | {readonly receipt: CodeGraphCheckpointImportReceipt; readonly state: 'recorded'};

export interface CodeGraphInventoryPolicyExclusionReasonSummary {
  readonly bytes: number;
  readonly files: number;
  readonly reason: CodeGraphInventoryExclusionReason;
}

export interface CodeGraphInventoryPolicyExclusionSummary {
  readonly bytes: number;
  readonly files: number;
  readonly policyVersion: typeof CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION;
  readonly reasons: readonly CodeGraphInventoryPolicyExclusionReasonSummary[];
}

export interface CodeGraphInventoryReuseReceipt {
  readonly attributionFiles: readonly CodeGraphAttributionContextFile[];
  readonly contract: string;
  readonly diagnostics: readonly string[];
  readonly environmentFingerprint: string;
  readonly includeOpaqueCorpusAssets: boolean;
  readonly policyExclusions: CodeGraphInventoryPolicyExclusionSummary;
  readonly skipped: number;
  readonly version: typeof CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION;
  readonly workspace: CodeGraphWorkspace;
}

export type CodeGraphAttributionContextFile = Pick<
  CodeGraphInventoryFile,
  'blobId' | 'contentHash' | 'language' | 'mode' | 'path' | 'size'
> & {
  readonly content: string;
  readonly source: 'commit';
};

export interface CodeGraphReusableBaseReceiptInput {
  readonly fileSetFingerprint: string;
  readonly inventory?: CodeGraphInventoryReuseReceipt;
  readonly packProvenance: readonly CodeGraphLanguagePackProvenance[];
  readonly workspaceFingerprint: string;
}

/** Exact physical-root evidence required when a clean commit aliases its just-committed dirty graph. */
export interface CodeGraphCleanSnapshotAliasOptions {
  readonly exactBaseFiles?: readonly Pick<
    CodeGraphInventoryFile,
    'contentHash' | 'language' | 'mode' | 'path' | 'size'
  >[];
  readonly expectedBaseGraphContentId?: string;
}

export interface CodeGraphLanguagePackProvenance {
  readonly cacheIdentity: string;
  readonly derivationIdentity: string;
  readonly id: string;
  readonly resolutionDomain: string;
  readonly resolutionVersion: string;
}

export interface CodeGraphMaterializedShardAssociationBatch {
  readonly derivationIdentity: string;
  readonly extractorSet: string;
  readonly files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[];
  readonly selectedShardIds: ReadonlyMap<string, string>;
}

export interface CodeGraphFactCacheBatch {
  readonly extractorSet: string;
  readonly facts: readonly CodeGraphCacheFactInput[];
  readonly files: readonly CodeGraphInventoryFile[];
}

export interface CodeGraphMaterializedShardCacheBatch {
  readonly derivationIdentity: string;
  readonly extractorSet: string;
  readonly facts: readonly CodeGraphCacheFactInput[];
  readonly files: readonly CodeGraphInventoryFile[];
}

export interface CodeGraphReusableBaseReceipt extends CodeGraphReusableBaseReceiptInput {
  readonly aliasCount: number;
  readonly formatVersion: number;
  readonly lookupCount: number;
  readonly resolutionSurfaceVersion: number;
  readonly reexportCount: number;
  readonly snapshotId: string;
}

export interface CodeGraphReusableCleanBase {
  readonly files: readonly CodeGraphInventoryFile[];
  readonly receipt: CodeGraphReusableBaseReceipt;
  readonly snapshot: CodeGraphSnapshot;
}

export const CODE_GRAPH_FOLD_FORWARD_RECEIPT_VERSION = 1;

/**
 * A clean one-level delta admitted only as a logical comparison point. Its
 * root remains the sole physical base for every later incremental snapshot.
 */
export interface CodeGraphReusableFoldForwardBase {
  readonly logicalFiles: readonly CodeGraphInventoryFile[];
  readonly logicalSnapshot: CodeGraphSnapshot;
  readonly priorDeltaPaths: readonly string[];
  readonly priorStagedPayloadBytes: number;
  readonly priorStagedRows: number;
  readonly rootReceipt: CodeGraphReusableBaseReceipt;
  readonly rootSnapshot: CodeGraphSnapshot;
}

/**
 * Bounded persisted-base projection for dirty admission. Unlike
 * `CodeGraphReusableCleanBase`, `files` contains only the exact requested
 * paths; `snapshot.fileCount` remains the complete base cardinality.
 */
export interface CodeGraphReusableCleanBaseSlice {
  readonly files: readonly CodeGraphInventoryFile[];
  readonly receipt: CodeGraphReusableBaseReceipt;
  readonly snapshot: CodeGraphSnapshot;
}

export interface CodeGraphReusableReexport {
  readonly importedName: string;
  readonly localName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface CodeGraphReusableReexportSeed {
  readonly name: string;
  readonly path: string;
}

export interface StoredCodeGraph {
  readonly edges: readonly CodeGraphEdge[];
  readonly snapshot: CodeGraphSnapshot;
  readonly symbols: readonly CodeGraphSymbol[];
}

export interface CodeGraphEdgeCursor {
  readonly id: string;
  readonly relation: string;
  readonly sourceName: string;
  readonly targetName: string;
}

export interface CodeGraphSymbolCursor {
  readonly id: string;
  readonly path: string;
  readonly qualifiedName: string;
}

export interface CodeGraphAnalysisSymbolAggregate {
  readonly count: number;
  readonly kind: string;
  readonly language: string;
}

export interface CodeGraphAnalysisSymbolAggregatePage {
  readonly counts: readonly CodeGraphAnalysisSymbolAggregate[];
  readonly lastId?: string;
  readonly rows: number;
}

export interface CodeGraphAnalysisEdgeAggregate {
  readonly confidenceHigh: number;
  readonly confidenceInvalid: number;
  readonly confidenceLow: number;
  readonly confidenceMedium: number;
  readonly confidenceTotal: number;
  readonly count: number;
  readonly lowestConfidence: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly reviewFindingCount: number;
  readonly selfLoopCount: number;
  readonly unresolvedEndpointCount: number;
}

export interface CodeGraphAnalysisEdgeAggregatePage {
  readonly counts: readonly CodeGraphAnalysisEdgeAggregate[];
  readonly lastId?: string;
  readonly rows: number;
}

export interface CodeGraphAnalysisSummary {
  readonly digest: string;
  readonly edgeCount: number;
  readonly edges: readonly CodeGraphAnalysisEdgeAggregate[];
  readonly symbolCount: number;
  readonly symbols: readonly CodeGraphAnalysisSymbolAggregate[];
  readonly version: 1;
}

export interface CodeGraphDatabaseHealth {
  readonly activeSnapshots: number;
  readonly buildingSnapshots: number;
  readonly cachedFileBlobs: number;
  readonly failedSnapshots: number;
  readonly foreignKeyViolations: number;
  readonly integrity: 'corrupt' | 'incompatible' | 'migration-pending' | 'ok';
  readonly persistentExtensionSchemaRevision?: number;
  readonly snapshotFileCitationBaseIndexes: CodeGraphSnapshotFileCitationBaseIndexState;
  readonly snapshotFileCitationSchema: CodeGraphSnapshotFileCitationSchemaState;
  readonly readySnapshots: number;
  readonly schemaVersion?: number;
}

export interface CodeGraphDatabaseRepair {
  readonly removedSnapshots: number;
  /** Incomplete snapshots whose live leases still protect resumable spool state. */
  readonly retainedIncompleteSnapshotIds: readonly string[];
}

export type CodeGraphRoutineMaintenanceDiagnostic = 'orphan-provenance-cursor-recovered';

export type CodeGraphRoutineMaintenanceResult =
  | {
      readonly cleanup:
        | 'abandoned-build'
        | 'build-status-history'
        | 'completed-build'
        | 'file-blob-cache'
        | 'materialized-shard-cache'
        | 'none'
        | 'orphan-provenance'
        | 'reconciliation-index'
        | 'removed-worktree-view'
        | 'schema-migration'
        | 'retired-snapshot';
      /** Closed, path-free maintenance observations safe for CLI and Manager diagnostics. */
      readonly diagnostics?: readonly CodeGraphRoutineMaintenanceDiagnostic[];
      readonly expiredLeases: number;
      readonly remaining: boolean;
      readonly retiredSnapshots: number;
      readonly rowsDeleted: number;
      readonly state: 'completed';
    }
  | {
      readonly reason:
        | 'external-maintenance'
        | 'home-tick-active'
        | 'owner-changed'
        | 'owner-protected'
        | 'snapshot-busy'
        | 'status-sidecar-unavailable'
        | 'worktree-busy'
        | 'writer-busy';
      /** Closed, path-free maintenance observations safe for CLI and Manager diagnostics. */
      readonly diagnostics?: readonly CodeGraphRoutineMaintenanceDiagnostic[];
      readonly state: 'deferred';
    }
  | {
      /** Closed, path-free maintenance observations safe for CLI and Manager diagnostics. */
      readonly diagnostics?: readonly CodeGraphRoutineMaintenanceDiagnostic[];
      readonly reason: 'database-missing' | 'schema-unavailable' | 'writer-lock-unavailable';
      readonly state: 'skipped';
    };

export interface CodeGraphRoutineMaintenanceOptions {
  /** Stable checkout identity required for exact abandoned-owner reconciliation. */
  readonly checkoutId?: string;
  /** Threadnote home required to derive target worktree and logical-snapshot locks. */
  readonly threadnoteHome?: string;
  /** Checkout-wide writer gate. Production callers pass the path from CodeGraphLayout. */
  readonly writerLockPath?: string;
}

export interface CodeGraphRetiredSnapshotCleanupProgress {
  readonly pagesCompleted: number;
  readonly rowsDeleted: number;
  readonly snapshotsCompleted: number;
  readonly snapshotsTotal: number;
}

export type CodeGraphRetiredSnapshotCleanupProgressCallback = (
  progress: CodeGraphRetiredSnapshotCleanupProgress,
) => Effect.Effect<void, never>;

export interface CodeGraphPersistentBuildClaim {
  readonly logicalSnapshotId: string;
  readonly owner: CodeGraphBuildOwnerIdentity;
}

export interface LoadedCodeGraphFacts {
  /** UTF-8 bytes occupied by the successfully decoded cached fact payloads. */
  readonly bytes: number;
  readonly bytesByPath?: ReadonlyMap<string, number>;
  /** Materialized shard paths with provenance in the current graph-content generation. */
  readonly exactGenerationFiles?: number;
  readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
  /** Paths represented by stored rows, also populated for metadata-only reads. */
  readonly keys?: ReadonlySet<string>;
  /** Stable shard IDs selected for each decoded materialized path. */
  readonly materializedShardIdsByPath?: ReadonlyMap<string, string>;
}

export type CodeGraphStagingStage =
  | 'analysis'
  | 'committed'
  | 'committing'
  | 'edges'
  | 'lookup-keys'
  | 'reference-candidates'
  | 'references'
  | 'receipt'
  | 'reexports'
  | 'symbols'
  | 'terms'
  | 'validating';

export interface CodeGraphStagingProgress {
  readonly chunkRows: number;
  /** Allocated durable database pages while a clean snapshot is built in place. */
  readonly durableDatabaseBytes?: number;
  readonly elapsedMilliseconds: number;
  readonly rowsCompleted: number;
  readonly stage: CodeGraphStagingStage;
  /** Batch-local wall time spent in bounded SQLite work for this stage. */
  readonly stageElapsedMilliseconds?: number;
  /** Allocated TEMP database pages; excludes rollback journals and subjournals. */
  readonly temporaryDatabaseBytes?: number;
}

export type CodeGraphStagingProgressCallback = (progress: CodeGraphStagingProgress) => Effect.Effect<void, never>;

export interface CodeGraphStagingBatch {
  readonly batchIndex: number;
  readonly edges: readonly CodeGraphEdge[];
  /** Exact UTF-8 JSON bytes of the attributed facts represented by this batch. */
  readonly finalFactBytes?: number;
  readonly monikers?: readonly CodeGraphMonikerV1[];
  readonly references: readonly CodeGraphReference[];
  /** Exact source bytes represented by this deterministic materialization batch. */
  readonly sourceBytes?: number;
  readonly symbols: readonly CodeGraphSymbol[];
}

export interface CodeGraphMaterializationSpoolContext {
  readonly checkoutId: string;
  readonly onStorageObservation?: (observation: CodeGraphMaterializationStorageObservation) => void;
  readonly repositoryRoot: string;
}

export interface CodeGraphPreparedMaterializationSpool {
  readonly batchCount: number;
  readonly spoolIdentity: string;
  readonly spoolPath: string;
  readonly surfaces: readonly {readonly name: string; readonly rowCount: number}[];
}

export type CodeGraphPreparationGate = <A, E, R>(
  preparation: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | unknown, R>;

export interface CodeGraphMaterializationStorageObservation {
  readonly databaseBytes: number;
  readonly journalBytes: number;
  readonly sharedMemoryBytes: number;
  readonly sidecarDatabaseBytes: number;
  readonly sidecarJournalBytes: number;
  readonly sidecarSharedMemoryBytes: number;
  readonly sidecarWalBytes: number;
  readonly totalBytes: number;
  readonly walBytes: number;
}

export type CodeGraphDirectPersistentCapacityProtector = <A, E, R>(
  boundary: CodeGraphDirectPersistentCapacityBoundary,
  transaction: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | CodeGraphStoreFailure, R>;

export type CodeGraphStagingBatchProgressCallback = (
  batchIndex: number,
  progress: CodeGraphStagingProgress,
) => Effect.Effect<void, never>;

export interface CodeGraphSecondaryIndexRestorationProgress {
  readonly completed: number;
  readonly elapsedMilliseconds: number;
  readonly total: number;
}

export type CodeGraphSecondaryIndexRestorationProgressCallback = (
  progress: CodeGraphSecondaryIndexRestorationProgress,
) => Effect.Effect<void, never>;

export type CodeGraphActivationStage =
  | 'checkpointing-snapshot'
  | 'committing-snapshot'
  | 'copying-edges'
  | 'copying-files'
  | 'copying-lookup-keys'
  | 'copying-reexports'
  | 'copying-symbols'
  | 'copying-terms'
  | 'copying-workspace'
  | 'recording-completion'
  | 'validating-input';

export interface CodeGraphActivationProgress {
  readonly elapsedMilliseconds: number;
  readonly rows?: number;
  readonly stage: CodeGraphActivationStage;
  readonly stageElapsedMilliseconds: number;
  readonly state: 'completed' | 'progress' | 'started';
  readonly transactionMilliseconds?: number;
}

export type CodeGraphActivationProgressCallback = (progress: CodeGraphActivationProgress) => Effect.Effect<void, never>;

export type CodeGraphResolutionProgressCallback = (progress: CodeGraphResolutionActivity) => Effect.Effect<void, never>;

export interface CodeGraphResolutionSummary {
  readonly aliasesDiscovered: number;
  readonly elapsedMilliseconds: number;
  readonly longestTransactionMilliseconds: number;
  readonly matchingMilliseconds: number;
  readonly pagesCompleted: number;
  readonly passesCompleted: number;
  readonly referencesExamined: number;
  readonly resolved: number;
  readonly transactionMilliseconds: number;
}

export interface CodeGraphVisualizationProject {
  readonly buildSystem?: CodeGraphWorkspaceBuildSystem;
  readonly dependencies: readonly {
    readonly evidence?: string;
    readonly provenance: CodeGraphWorkspaceProvenance;
    readonly targetId: string;
  }[];
  readonly diagnostics: readonly string[];
  readonly fileCount: number;
  readonly id: string;
  readonly kind: CodeGraphWorkspaceComponentKind | 'documentation' | 'legacy-group';
  readonly label: string;
  readonly languages: readonly string[];
  readonly model: 'component' | 'facet' | 'legacy-fallback';
  readonly provenance: CodeGraphWorkspaceProvenance | 'legacy';
  readonly resolutionDomain?: string;
  readonly root?: string;
  readonly sourceRoots: readonly string[];
  readonly symbolCount: number;
  readonly workspaceId?: string;
  readonly workspaceRoots: readonly string[];
}

export interface CodeGraphVisualizationWorkspace {
  readonly buildSystem: CodeGraphWorkspaceBuildSystem;
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly root: string;
}

export interface CodeGraphVisualizationScopeEdge {
  readonly confidence: number;
  readonly count: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: 'declared-build-dependency' | 'source-relationship';
}

export interface CodeGraphVisualizationCatalog {
  readonly accounting: {
    readonly attributedSymbols: number;
    readonly componentSymbols: number;
    readonly fallbackSymbols: number;
    readonly omittedSymbols: number;
    readonly totalSymbols: number;
  };
  readonly activatedAt?: string;
  readonly metrics: 'complete' | 'deferred';
  readonly model: 'legacy-fallback' | 'workspace';
  readonly projectCount: number;
  readonly projects: readonly CodeGraphVisualizationProject[];
  readonly projectsTruncated: boolean;
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly snapshot: CodeGraphSnapshot;
  readonly viewWorktreeId: string;
  readonly viewScopeId?: string;
  readonly workspaceCount: number;
  readonly workspaces: readonly CodeGraphVisualizationWorkspace[];
  readonly workspacesTruncated: boolean;
}

/** Bounded active-pointer identity used by cheap cross-process catalog invalidation. */
export interface CodeGraphActiveViewIdentity {
  readonly scopeId?: string;
  readonly activatedAt?: string;
  readonly repositoryId: string;
  readonly snapshotId: string;
  readonly worktreeId: string;
}

/** Exact active-pointer generation used to fence a read across external work. */
export interface CodeGraphActiveViewFence {
  readonly scopeId?: string;
  readonly activatedAt: string;
  readonly snapshotId: string;
  readonly worktreeId: string;
}

export interface CodeGraphVisualizationRelationshipSummary {
  readonly incoming: number;
  readonly outgoing: number;
  readonly provenances: readonly {
    readonly count: number;
    readonly provenance: CodeGraphProvenance;
  }[];
  readonly relations: readonly {
    readonly count: number;
    readonly incoming: number;
    readonly outgoing: number;
    readonly relation: CodeGraphEdge['relation'];
  }[];
  readonly sampledEdges: number;
  readonly truncated: boolean;
}

export interface CodeGraphVisualizationScopeEdgeSummary {
  readonly edges: readonly CodeGraphVisualizationScopeEdge[];
  readonly sampledScopes: number;
  readonly truncated: boolean;
}

export interface CodeGraphVisualizationEdgePage {
  readonly edges: readonly CodeGraphEdge[];
  readonly truncated: boolean;
}

export interface CodeGraphVisualizationCatalogOptions {
  readonly scopeId?: string;
  readonly scopeIds?: readonly string[];
  readonly includeDependencies?: boolean;
  readonly projectOffset?: number;
  readonly projectId?: Option.Option<string>;
  readonly projectLimit?: number;
  readonly projectQuery?: Option.Option<string>;
  readonly snapshotId?: Option.Option<string>;
  readonly viewLimit?: number;
  readonly viewOffset?: number;
  readonly viewQuery?: Option.Option<string>;
  readonly workspaceLimit?: number;
  readonly workspaceOffset?: number;
  readonly workspaceQuery?: Option.Option<string>;
}

export type CodeGraphVisualizationScope =
  | {readonly type: 'all'}
  | {readonly type: 'component'; readonly value: string}
  | {readonly type: 'documentation-facet'}
  | {readonly type: 'package'; readonly value: string}
  | {readonly type: 'path'; readonly value: string}
  | {readonly type: 'unscoped'};

export interface CodeGraphSnapshotLeaseWriterOptions {
  /** @internal Optional diagnostic observer; does not alter lease policy. */
  readonly onTiming?: CodeGraphLeaseTimingObserver;
  /** Maximum time to wait for another checkout writer. Omit to preserve the unbounded background-worker contract. */
  readonly waitTimeoutMilliseconds?: number;
}

export interface CodeGraphSnapshotPromotionOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** @internal Capacity reservation wrapped outside the checkout writer gate. */
  readonly persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector;
}

export interface CodeGraphSnapshotLeaseAcquireOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** Reserve a committed-but-unpromoted ready row inside detached-ready caps. */
  readonly retainedBase?: boolean;
  readonly retireWhenInactive?: boolean;
}

export interface CodeGraphViewSnapshotLeaseRetainOptions extends CodeGraphSnapshotLeaseWriterOptions {
  readonly scopeId?: string;
  /** Existing process-owned lease token to validate or renew under the same writer gate as the view observation. */
  readonly existingToken?: string;
  /** Minimum remaining lifetime required before an existing token may be reused without renewal. */
  readonly minimumRemainingMilliseconds?: number;
  /** Deterministic test interlock executed after observation while the cross-process writer gate remains held. */
  readonly afterViewObserved?: () => Effect.Effect<void, unknown, never>;
}

export type CodeGraphViewSnapshotLeaseRetainResult =
  | {
      readonly expiresAt: number;
      readonly state: 'retained';
      readonly token: string;
    }
  | {
      readonly observation: CodeGraphViewObservationResult;
      readonly state: 'view-unavailable';
    };

export type CodeGraphViewSnapshotLeaseValidationResult =
  {readonly expiresAt: number; readonly state: 'valid'} | {readonly state: 'invalid'};

export interface CodeGraphViewRemovalStoreOptions extends CodeGraphSnapshotLeaseWriterOptions {
  readonly scopeId?: string;
  /** Final containment proof run while the checkout writer gate is held and immediately before SQLite is opened. */
  readonly beforeDatabaseOpen?: () => Effect.Effect<void, unknown>;
  /** Exact path-free provenance evidence captured before the core removal CAS. */
  readonly cleanupEvidence?: CodeGraphRemovedViewCleanupEvidence;
  /** @internal Require the exact automatic-reconciliation schema again inside the final writer transaction. */
  readonly requireReconciliationSchema?: true;
}

export interface CodeGraphWorktreeReconciliationClaimOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** Final containment proof run under the writer gate immediately before SQLite is opened. */
  readonly beforeDatabaseOpen?: () => Effect.Effect<void, unknown>;
}

export interface CodeGraphWorktreeReconciliationPreparationOptions extends CodeGraphWorktreeReconciliationClaimOptions {
  /** @internal Deterministic rollback seam after the preview transaction starts. */
  readonly afterPreviewTransactionStarted?: () => Effect.Effect<void, unknown>;
  /** Simulate the bounded preparation transaction and roll every schema change back before returning. */
  readonly preview?: boolean;
}

export interface CodeGraphWorktreeReconciliationCandidate {
  readonly scopeId?: string;
  readonly repositoryId: string;
  readonly snapshotId: string;
  readonly worktreeId: string;
}

export interface CodeGraphOrphanProvenanceCandidatePage {
  /** Advisory cursor repair performed atomically with this claim. Never grants deletion authority. */
  readonly cursorRecovery?: 'invalid-format';
  readonly worktreeIds: readonly string[];
}

export type CodeGraphOrphanProvenanceViewObservation =
  {readonly state: 'absent'} | {readonly snapshotId: string; readonly state: 'active'};

export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES = [
  'vector-pointers',
  'build-status',
  'provenance',
  'complete',
] as const;

export type CodeGraphRemovedViewCleanupPhase = (typeof CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES)[number];

export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_BLOCKED_CODES = [
  'busy',
  'evidence-unavailable',
  'invalid-sidecar',
  'io-error',
  'permission-denied',
  'schema-incompatible',
] as const;

export type CodeGraphRemovedViewCleanupBlockedCode = (typeof CODE_GRAPH_REMOVED_VIEW_CLEANUP_BLOCKED_CODES)[number];

export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS = 30_000;
export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS = 32;

export interface CodeGraphRemovedViewCleanupEvidence {
  readonly recordDigest: string;
  readonly recordIdentity: string;
  readonly repositoryId: string;
}

/** Path-free durable cleanup epoch selected from one immutable tombstone. */
export interface CodeGraphRemovedViewCleanupEntry {
  readonly scopeId?: string;
  readonly attempts: number;
  readonly blockedCode?: CodeGraphRemovedViewCleanupBlockedCode;
  readonly cursorToken?: string;
  readonly epoch: number;
  readonly expectedSnapshotId: string;
  readonly nextAttemptAt: number;
  readonly phase: CodeGraphRemovedViewCleanupPhase;
  readonly provenanceRecordDigest?: string;
  readonly provenanceRecordIdentity?: string;
  readonly removedAt: string;
  readonly repositoryId?: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly worktreeId: string;
}

export interface CodeGraphRemovedViewCleanupUpdate {
  readonly attempts: number;
  readonly blockedCode?: CodeGraphRemovedViewCleanupBlockedCode;
  readonly cursorToken?: string;
  readonly nextAttemptAt: number;
  readonly phase: CodeGraphRemovedViewCleanupPhase;
  readonly updatedAt: string;
}

export type CodeGraphRemovedViewCleanupAuthorizationResult =
  | {readonly entry: CodeGraphRemovedViewCleanupEntry; readonly state: 'authorized'}
  | {readonly observedSnapshotId: string; readonly state: 'active-pointer-changed'}
  | {readonly state: 'stale'};

export type CodeGraphRemovedViewCleanupUpdateResult =
  | {readonly entry: CodeGraphRemovedViewCleanupEntry; readonly state: 'updated'}
  | {readonly observedSnapshotId: string; readonly state: 'active-pointer-changed'}
  | {readonly state: 'stale'};

export interface CodeGraphRemovedViewCleanupStoreOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** Final containment proof run under the checkout writer gate immediately before SQLite is opened. */
  readonly beforeDatabaseOpen?: () => Effect.Effect<void, unknown>;
}

export type CodeGraphWorktreeReconciliationIndexPreparationResult =
  | {readonly state: 'migration-ready'}
  | {readonly state: 'ready'}
  | {readonly index: string; readonly state: 'prepared'}
  | {readonly reason: 'incompatible-schema'; readonly state: 'deferred'};

export type CodeGraphViewRemovalResult =
  | {
      readonly expectedSnapshotId: string;
      readonly retiredSnapshots: number;
      readonly state: 'already-removed' | 'removed';
    }
  | {
      readonly expectedSnapshotId: string;
      readonly observedSnapshotId: string;
      readonly observedState: 'active' | 'removed';
      readonly state: 'stale-target';
    }
  | {
      readonly expectedSnapshotId: string;
      readonly state: 'not-found';
    };

export type CodeGraphViewObservationResult =
  | {
      readonly expectedSnapshotId: string;
      readonly state: 'already-removed' | 'ready';
    }
  | {
      readonly expectedSnapshotId: string;
      readonly observedSnapshotId: string;
      readonly observedState: 'active' | 'removed';
      readonly state: 'stale-target';
    }
  | {
      readonly expectedSnapshotId: string;
      readonly state: 'not-found';
    };

export const CODE_GRAPH_SNAPSHOT_PURGE_GRAPH_BLOCKER_CODES = [
  'active-view',
  'alias-snapshot',
  'base-required',
  'build-owned',
  'cleanup-pending',
  'live-lease',
  'unsupported-state',
] as const;

export type CodeGraphSnapshotPurgeGraphBlockerCode = (typeof CODE_GRAPH_SNAPSHOT_PURGE_GRAPH_BLOCKER_CODES)[number];

export interface CodeGraphSnapshotPurgeLeaseEvidence {
  readonly expiresAt: number;
  /** SHA-256 of the private lease token; the token itself never leaves Store. */
  readonly identity: string;
}

export interface CodeGraphSnapshotPurgeGraphEvidence {
  readonly activeViewIds: readonly string[];
  readonly blockers: readonly CodeGraphSnapshotPurgeGraphBlockerCode[];
  readonly buildOwnerIds: readonly string[];
  readonly childSnapshotIds: readonly string[];
  readonly cleanupEpochs: readonly string[];
  readonly graphEvidenceDigest: string;
  readonly liveLeases: readonly CodeGraphSnapshotPurgeLeaseEvidence[];
  readonly snapshot: CodeGraphSnapshot;
}

export type CodeGraphSnapshotPurgeObservationResult =
  | {readonly snapshotId: string; readonly state: 'not-found'}
  | {readonly evidence: CodeGraphSnapshotPurgeGraphEvidence; readonly snapshotId: string; readonly state: 'observed'};

export type CodeGraphSnapshotPurgeStoreResult =
  | {readonly snapshotId: string; readonly state: 'not-found'}
  | {
      readonly evidence: CodeGraphSnapshotPurgeGraphEvidence;
      readonly snapshotId: string;
      readonly state: 'blocked' | 'state-changed';
    }
  | {
      readonly cleanupState: 'completed' | 'deferred';
      readonly remaining: boolean;
      readonly rowsDeleted: number;
      readonly snapshotId: string;
      readonly state: 'purged' | 'retired';
    };

export interface CodeGraphSnapshotPurgeStoreOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** Final containment proof while the checkout writer gate is held and before SQLite opens. */
  readonly beforeDatabaseOpen?: () => Effect.Effect<void, unknown>;
}
