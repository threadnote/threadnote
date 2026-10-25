import {Schema, type Effect} from 'effect';
import type {CodeGraphScanningMetrics, CodeGraphSourceSizeBucket} from './progress/telemetry.js';
import type {CodeGraphMonikerV1} from './cross_repository/types.js';

export {
  CODE_GRAPH_CORE_SCHEMA_VERSION as CODE_GRAPH_SCHEMA_VERSION,
  CODE_GRAPH_MINIMUM_BACKGROUND_SCHEMA_REVISION as CODE_GRAPH_MINIMUM_BACKGROUND_MIGRATION_REVISION,
  CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION as CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
} from './store/schema/revision.js';
export const CODE_GRAPH_RESULT_VERSION = 1 as const;
export const CODE_GRAPH_EXTRACTOR_GENERATION = 14 as const;
export const CODE_GRAPH_EXTRACTOR_SET_VERSION = `native-code-graph-${CODE_GRAPH_EXTRACTOR_GENERATION}` as const;

export type CodeGraphSnapshotFileCitationSchemaState =
  | 'column-only'
  | 'column-only-with-authority'
  | 'column-only-with-predecessor-authority'
  | 'current'
  | 'incompatible'
  | 'released-absent'
  | 'released-absent-with-predecessor-authority'
  | 'released-absent-with-authority'
  | 'table-absent';

export type CodeGraphSnapshotFileCitationBaseIndexState = 'current' | 'incompatible' | 'missing';

export type CodeGraphProvenance = 'declared' | 'heuristic' | 'model' | 'resolved' | 'syntactic';
export type CodeGraphRelation =
  | 'calls'
  | 'configures'
  | 'constructs'
  | 'contains'
  | 'declares'
  | 'depends_on'
  | 'documents'
  | 'exports'
  | 'extends'
  | 'implements'
  | 'imports'
  | 'overrides'
  | 'reads_or_writes'
  | 'references'
  | 'reexports'
  | 'semantic_association'
  | 'tests';

export interface RepositoryIdentity {
  /** Local-only current branch when HEAD is attached. */
  readonly branch?: string;
  readonly caseMode: 'insensitive' | 'sensitive';
  readonly checkoutId: string;
  readonly displayName: string;
  readonly gitCommonDirectory: string;
  readonly headCommit: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly remoteIdentity?: string;
  readonly repoRoot: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
}

export interface RepositoryIdentityExpectation {
  readonly checkoutId: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
}

export interface CodeGraphInventoryFile {
  readonly blobId: string;
  /** Binary source bytes are retained only for the extraction batch that requested them. */
  readonly bytes?: Uint8Array;
  readonly content?: string;
  readonly contentHash: string;
  readonly contentOmittedReason?: 'metadata-only' | 'size-budget';
  readonly language: string;
  readonly mode: string;
  readonly path: string;
  /** Raw worktree SHA-256 retained only as a migration alias for pre-envelope citations. */
  readonly rawContentHash?: string;
  readonly size: number;
  readonly source: 'commit' | 'worktree';
}

export interface CodeGraphSpan {
  /** One-based UTF-16 column in `line`, matching TypeScript source positions. */
  readonly column: number;
  /** One-based exclusive UTF-16 column in `endLine`. */
  readonly endColumn: number;
  /** One-based line containing the exclusive end position. */
  readonly endLine: number;
  /** One-based line containing the inclusive start position. */
  readonly line: number;
}

export interface CodeGraphSymbol {
  readonly arity?: number;
  readonly contentHash: string;
  readonly documentation?: string;
  readonly exported: boolean;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly lookupKeys?: readonly string[];
  readonly name: string;
  readonly packageName?: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly resolutionDomain?: string;
  readonly resolutionScopeId?: string;
  readonly signature?: string;
  readonly span: CodeGraphSpan;
}

export interface CodeGraphEdge {
  readonly confidence: number;
  readonly evidencePath: string;
  readonly evidenceSpan: CodeGraphSpan;
  readonly id: string;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphRelation;
  readonly sourceId?: string;
  readonly sourceName: string;
  readonly targetId?: string;
  readonly targetName: string;
}

export interface CodeGraphFileFacts {
  /** Compact parser-time inputs retained for derivations that run after source content is released. */
  readonly derivationInputs?: CodeGraphDerivationInputs;
  readonly diagnostics: readonly string[];
  readonly edges: readonly CodeGraphEdge[];
  readonly monikers?: readonly CodeGraphMonikerV1[];
  readonly path: string;
  readonly references?: readonly CodeGraphReference[];
  readonly symbols: readonly CodeGraphSymbol[];
}

export interface CodeGraphDerivationInputs {
  readonly rationale?: readonly CodeGraphRationaleInput[];
}

export interface CodeGraphRationaleInput {
  readonly documentation: string;
  readonly line: number;
  readonly marker: string;
  readonly name: string;
}

export interface CodeGraphReference {
  readonly aliasLookupKeys?: readonly string[];
  readonly arity?: number;
  readonly edgeId: string;
  readonly evidencePath: string;
  readonly evidenceSpan: CodeGraphSpan;
  readonly exportedOnly?: boolean;
  readonly lookupTiers: readonly (readonly string[])[];
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphRelation;
  readonly resolutionDomain: string;
  readonly sourceId?: string;
  readonly sourceName: string;
  readonly targetName: string;
}

export interface CodeGraphSnapshot {
  /** Missing scope denotes the canonical full-repository graph. */
  readonly scopeId?: string;
  readonly baseSnapshotId?: string;
  readonly commit: string;
  readonly completedAt?: string;
  readonly dirty: boolean;
  readonly edgeCount: number;
  readonly extractorSet: string;
  readonly fileCount: number;
  /** Content-addressed graph input identity, independent of commit and worktree pointers. */
  readonly graphContentId?: string;
  readonly id: string;
  readonly overlayFingerprint?: string;
  readonly repositoryId: string;
  readonly state: 'building' | 'failed' | 'ready' | 'retired';
  readonly symbolCount: number;
  readonly worktreeId: string;
}

/** Privacy-safe row cardinality emitted while cached facts are materialized. */
export interface CodeGraphMaterializationRows {
  readonly deduplicatedEdges?: number;
  readonly deduplicatedReferences?: number;
  readonly edges?: number;
  readonly lookupKeys?: number;
  readonly referenceCandidates?: number;
  readonly references?: number;
  readonly reexports?: number;
  readonly symbols?: number;
  readonly terms?: number;
}

/**
 * Cumulative wall time for attribution and adjacent final-batch preparation.
 * Attribution compute, shard serialization, persistence, and association are
 * mutually non-overlapping. The existing `attributing` stage remains an
 * inclusive cumulative timer; grouped shard persistence is recorded exactly
 * once rather than being divided speculatively across its logical batches. A
 * final shard-association flush can follow it.
 * Final-batch preparation spans the transition into row preparation. Keeping
 * them separate prevents codec and SQLite costs from hiding behind one
 * aggregate timer.
 */
export interface CodeGraphMaterializationSubphaseMilliseconds {
  readonly attributionCompute: number;
  readonly factBatchPreparation: number;
  readonly shardAssociation: number;
  readonly shardPersistence: number;
  readonly shardSerialization: number;
}

/**
 * Batch-local materialization activity. Paths, symbol names, and repository
 * content are deliberately excluded because this shape is persisted and
 * exposed through the CLI and Manager.
 */
export interface CodeGraphMaterializationActivity {
  /** Number of fully committed batches before the active batch. */
  readonly batchCompleted: number;
  readonly batchTotal: number;
  readonly cachedFactBytes?: number;
  readonly elapsedMilliseconds?: number;
  /** Exact UTF-8 JSON bytes of final attributed facts in this staging transaction. */
  readonly factsBytes?: number;
  readonly rows?: CodeGraphMaterializationRows;
  readonly sourceBytes: number;
  /** Batch-local cumulative wall time attributed to this bounded stage. */
  readonly stageElapsedMilliseconds?: number;
  readonly stage:
    | 'attributing'
    | 'committing'
    | 'loading-cache'
    | 'preparing-rows'
    | 'restoring-indexes'
    | 'writing-analysis'
    | 'writing-candidates'
    | 'writing-edges'
    | 'writing-facts'
    | 'writing-lookups'
    | 'writing-references'
    | 'writing-receipt'
    | 'writing-symbols'
    | 'writing-terms';
  readonly transactionMilliseconds?: number;
}

/** Cumulative, privacy-safe measurements for the current materialization phase. */
export interface CodeGraphMaterializationMetrics {
  /** Files whose parser facts were postprocessed and attributed during this materialization. */
  readonly attributedFilesCompleted?: number;
  readonly attributionMilliseconds?: number;
  readonly batchesCompleted: number;
  readonly batchesTotal: number;
  readonly cachedFactBytesCompleted?: number;
  readonly cachedFactBytesTotal?: number;
  /** Saturating sum of materialized-shard and raw-fact replay bytes. */
  readonly cachedFactReplayBytesCompleted?: number;
  /** Exact consumed cached-fact bytes for current paths changed from the committed inventory. */
  readonly changedFactBytesCompleted?: number;
  /** Files selected from future cross-generation materialized-shard batches; zero until eligibility exists. */
  readonly crossGenerationShardFilesCompleted?: number;
  /** Files selected from complete materialized-shard batches for the current exact derivation. */
  readonly exactGenerationShardFilesCompleted?: number;
  /** Exact bounded reason a repository-wide rewrite was selected, when known. */
  readonly fallbackReason?: CodeGraphOverlayFallbackReason;
  /** Closed, path-free evidence for the assessment that selected the fallback. */
  readonly fallbackAssessment?: CodeGraphOverlayFallbackAssessment;
  /** Closed, path-free evidence for the resource boundary that selected the fallback. */
  readonly fallbackBoundary?: CodeGraphOverlayFallbackBoundary;
  /** Exact UTF-8 JSON bytes of final postprocessed and attributed facts. */
  readonly factsBytesCompleted?: number;
  readonly factsBytesTotal?: number;
  readonly loadingMilliseconds?: number;
  /** Exact UTF-8 bytes decoded from materialized shards, including inspected shards later discarded by batch fallback. */
  readonly materializedShardReplayBytesCompleted?: number;
  /** Files intentionally kept on raw-fact replay instead of duplicating a large derived shard cache. */
  readonly materializedShardCacheDeferredFilesCompleted?: number;
  /** Raw-fact bytes covered by the intentional derived-shard cache deferral. */
  readonly materializedShardCacheDeferredRawFactBytesCompleted?: number;
  readonly mode?: 'full' | 'incremental-clean' | 'incremental-overlay';
  /** Exact UTF-8 bytes decoded from raw parser-fact cache rows for attribution. */
  readonly rawFactReplayBytesCompleted?: number;
  /** Closed, path-free evidence for the declaration-publication gate. */
  readonly resolutionLookupKeyForm?: import('./resolution/surface.js').CodeGraphResolutionLookupKeyForm;
  /** Closed, path-free evidence for the declaration-publication gate. */
  readonly resolutionPublicationGate?: import('./resolution/surface.js').CodeGraphResolutionPublicationGate;
  readonly rows?: CodeGraphMaterializationRows;
  readonly sourceBytesCompleted: number;
  readonly sourceBytesTotal: number;
  /** Cumulative wall time attributed to privacy-safe materialization stages. */
  readonly stageMilliseconds?: Readonly<Partial<Record<CodeGraphMaterializationActivity['stage'], number>>>;
  readonly subphaseMilliseconds?: CodeGraphMaterializationSubphaseMilliseconds;
  readonly storage?: {
    /** Legacy combined value, present only when durable and TEMP data share one filesystem. */
    readonly availableBytes?: number;
    readonly durableAvailableBytes?: number;
    /** Allocated durable graph database pages observed during direct staging. */
    readonly durableDatabaseBytes?: number;
    readonly durableDatabaseHighWaterBytes?: number;
    /** On-disk main database size when materialization began. */
    readonly durableDatabaseStartBytes?: number;
    /** Current and peak main-database growth attributable to this build. */
    readonly durableDatabaseGrowthBytes?: number;
    readonly durableDatabaseGrowthHighWaterBytes?: number;
    readonly durableDatabaseFileBytes?: number;
    readonly durableDatabaseFileHighWaterBytes?: number;
    /** Main database plus observable WAL, SHM, and rollback-journal files. */
    readonly durableFilesystemBytes?: number;
    readonly durableFilesystemHighWaterBytes?: number;
    readonly durableJournalBytes?: number;
    readonly durableJournalHighWaterBytes?: number;
    readonly durableSharedMemoryBytes?: number;
    readonly durableSharedMemoryHighWaterBytes?: number;
    /** Reconstructible sorted materialization sidecar and its transient rollback journal. */
    readonly durableSidecarDatabaseBytes?: number;
    readonly durableSidecarDatabaseHighWaterBytes?: number;
    readonly durableSidecarJournalBytes?: number;
    readonly durableSidecarJournalHighWaterBytes?: number;
    /** Must remain zero because the spool contract uses DELETE journaling. */
    readonly durableSidecarWalBytes?: number;
    readonly durableSidecarWalHighWaterBytes?: number;
    readonly durableWalBytes?: number;
    readonly durableWalHighWaterBytes?: number;
    readonly decisionLayer?: 'whole-build-heuristic';
    readonly enforcement?: 'advisory';
    readonly estimateBasis?: 'cached-fact-bytes' | 'final-fact-bytes' | 'source-bytes-fallback';
    /** Allowance for one other repository/worktree build sharing the same disk. */
    readonly estimatedConcurrentBuildBytes?: number;
    readonly estimatedDurableFilesystemRequiredBytes?: number;
    readonly estimatedDurableSnapshotBytes?: number;
    readonly estimatedJournalBytes?: number;
    /** Combined estimate when all storage shares one filesystem; never a hard limit. */
    readonly estimatedRequiredBytes?: number;
    readonly estimatedTemporaryFilesystemRequiredBytes?: number;
    readonly estimatedTemporaryDatabaseBytes?: number;
    /** Whether SQLite TEMP and the durable graph database are on the same filesystem. */
    readonly filesystemsShared?: boolean;
    readonly materializationMode?: 'direct-persistent' | 'temporary-staged';
    readonly modelVersion?: number;
    readonly temporaryAvailableBytes?: number;
    /** Allocated SQLite TEMP database pages; rollback journals and subjournals are excluded. */
    readonly temporaryDatabaseBytes: number;
    readonly temporaryDatabaseHighWaterBytes: number;
  };
  readonly transactionMilliseconds?: number;
}

/**
 * Privacy-safe progress for the bounded reference-resolution pass. The
 * current-pass counters provide an honest finite denominator while
 * referencesExamined, pagesCompleted, and resolved remain cumulative across
 * alias-expansion passes.
 */
export interface CodeGraphResolutionActivity {
  readonly aliasesDiscovered: number;
  readonly elapsedMilliseconds: number;
  /** Longest completed SQLite resolution transaction in this build. */
  readonly longestTransactionMilliseconds?: number;
  readonly matchingMilliseconds: number;
  readonly pageCompleted: number;
  readonly pageTotal: number;
  readonly pagesCompleted: number;
  readonly pass: number;
  readonly referencesCompleted: number;
  readonly referencesExamined: number;
  readonly referencesTotal: number;
  readonly resolved: number;
  readonly transactionMilliseconds: number;
  readonly transactionStageMilliseconds?: CodeGraphResolutionTransactionStageMilliseconds;
}

export interface CodeGraphResolutionTransactionStageMilliseconds {
  readonly preparingBatch: number;
  readonly retiringReferences: number;
  readonly updatingAnalysis: number;
  readonly writingAliases: number;
  readonly writingEdges: number;
}

/** Privacy-safe progress for copying a staged graph into its durable snapshot. */
export interface CodeGraphActivationActivity {
  readonly elapsedMilliseconds: number;
  readonly rows?: number;
  readonly stage:
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
  readonly stageElapsedMilliseconds: number;
  readonly state: 'completed' | 'progress' | 'started';
  /** Duration of the most recently committed bounded copy transaction. */
  readonly transactionMilliseconds?: number;
}

/** Path-free observation of the cache-authority admission gate. */
export interface CodeGraphRegistrationActivity {
  readonly elapsedMilliseconds: number;
  readonly generations: number;
  readonly keys: number;
  readonly stage: 'loading-cache';
}

export type CodeGraphProgress =
  | {
      readonly activity?: CodeGraphRegistrationActivity;
      readonly phase: 'registering';
    }
  | {
      readonly phase: 'sharing';
      readonly subphase:
        'applying-deltas' | 'building-local-overlay' | 'discovering-shared-base' | 'downloading-checkpoint';
    }
  | {
      readonly admission?: import('./builder/admission_scheduler.js').CodeGraphBuilderAdmissionQueue;
      readonly phase: 'waiting';
      readonly reason?:
        | 'database-writer'
        | 'disk-capacity'
        | 'home-builder-cap'
        | 'prepared-spool-budget'
        | 'repository-lock'
        | 'request-lock'
        | 'snapshot-build';
    }
  | {
      readonly completed: number;
      readonly pagesCompleted: number;
      readonly phase: 'reclaiming';
      readonly rowsDeleted: number;
      readonly total: number;
      readonly unit: 'snapshots';
    }
  | {
      readonly accepted: number;
      readonly activity?: {
        /** Batch-local progress; repository-derived paths never enter persisted build status. */
        readonly batchCompleted: number;
        readonly batchTotal: number;
        readonly bytes: number;
        readonly classifier?: string;
        readonly degraded?: boolean;
        readonly degradationReason?: import('./parser_worker.js').ParserWorkerFailureReason;
        readonly factsBytes?: number;
        readonly language: string;
        readonly parseMilliseconds?: number;
        readonly path: string;
        readonly persistMilliseconds?: number;
        readonly relations?: number;
        readonly role?: string;
        readonly sizeBucket?: CodeGraphSourceSizeBucket;
        readonly stage: 'extracting' | 'persisting' | 'reading';
        readonly symbols?: number;
      };
      readonly completed: number;
      readonly excluded: number;
      /** Cumulative, path-free extraction workload for class-weighted phase ETA. */
      readonly metrics?: CodeGraphScanningMetrics;
      readonly phase: 'scanning';
      readonly skipped: number;
      readonly timings?: {
        readonly extractionMilliseconds: number;
        readonly persistenceMilliseconds: number;
        readonly readingMilliseconds: number;
        readonly serializationMilliseconds: number;
      };
      readonly total: number;
      readonly unit: 'files';
    }
  | {
      readonly activity?: CodeGraphMaterializationActivity;
      readonly completed: number;
      readonly metrics?: CodeGraphMaterializationMetrics;
      readonly phase: 'materializing';
      readonly reused: number;
      readonly total: number;
      readonly unit: 'files';
    }
  | {
      readonly activity?: CodeGraphResolutionActivity;
      readonly phase: 'resolving';
      readonly subphase: 'references';
    }
  | {
      readonly edges: number;
      readonly phase: 'resolving';
      readonly resolved: number;
      readonly subphase: 'complete';
      readonly symbols: number;
    }
  | {
      readonly activity?: CodeGraphActivationActivity;
      readonly phase: 'activating';
      readonly snapshotId: string;
      readonly subphase?:
        | 'complete'
        | 'promoting'
        | 'structural-ready'
        | 'summarizing-analysis'
        | 'validating-input'
        | 'writing-and-checkpointing';
    }
  | {
      readonly completed: number;
      readonly embedded: number;
      readonly phase: 'embedding';
      readonly reused: number;
      readonly total: number;
      readonly unit: 'symbols';
    };

export interface CodeGraphDeferredVectorPlan {
  readonly complete: Effect.Effect<CodeGraphIndexSummary, unknown>;
}

export const CODE_GRAPH_DEFERRED_VECTORS: unique symbol = Symbol('codeGraph.deferredVectors');

export interface CodeGraphIndexSummary {
  /** @internal In-process work captured under structural publication gates; omitted from JSON. */
  readonly [CODE_GRAPH_DEFERRED_VECTORS]?: CodeGraphDeferredVectorPlan;
  readonly diagnostics: readonly string[];
  readonly durationMs: number;
  readonly identity: RepositoryIdentity;
  readonly incrementalWork?: import('./incremental/work.js').CodeGraphIncrementalWork;
  readonly materialization?: {
    /** Prior logical-delta files copied from persisted rows without fact decoding. */
    readonly carriedFiles?: number;
    readonly closureProjects?: number;
    readonly fallbackAssessment?: CodeGraphOverlayFallbackAssessment;
    readonly fallbackBoundary?: CodeGraphOverlayFallbackBoundary;
    readonly fallbackReason?: CodeGraphOverlayFallbackReason;
    readonly mode: 'full' | 'incremental-clean' | 'incremental-overlay' | 'reused-snapshot';
    /** Files freshly decoded/attributed for this build; `stagedFiles` remains the physical delta size. */
    readonly freshStagedFiles?: number;
    readonly resolutionClosure?: 'changed' | 'full' | 'project';
    readonly resolutionLookupKeyForm?: import('./resolution/surface.js').CodeGraphResolutionLookupKeyForm;
    readonly resolutionPublicationGate?: import('./resolution/surface.js').CodeGraphResolutionPublicationGate;
    readonly stagedFiles: number;
    readonly totalFiles: number;
  };
  readonly reusedFiles: number;
  readonly skippedFiles: number;
  readonly snapshot: CodeGraphSnapshot;
}

export type CodeGraphOverlayFallbackReason =
  | 'cache-incomplete'
  | 'disabled'
  | 'dynamic-aliases'
  | 'extractor-context-changed'
  | 'fact-budget-expanded'
  | 'file-set-changed'
  | 'forced-full-rebuild'
  | 'incremental-rewrite-unbounded'
  | 'no-materialized-changes'
  | 'project-closure-incomplete'
  | 'project-closure-unbounded'
  | 'reexport-closure-unbounded'
  | 'resolution-surface-changed'
  | 'staging-identity-mismatch'
  | 'staging-unavailable'
  | 'workspace-changed';

export type CodeGraphProjectFileSetFallbackDetail =
  | 'dependency-model-incomplete'
  | 'duplicate-project-identity'
  | 'no-project-seeds'
  | 'path-owner-ambiguous'
  | 'path-unowned'
  | 'project-model-incomplete'
  | 'project-not-stable'
  | 'resolution-domain-unowned';

export type CodeGraphProjectClosureFallbackMetric =
  | 'affected-files'
  | 'cached-fact-bytes'
  | 'candidate-lookup-keys'
  | 'candidate-projection-associations'
  | 'candidate-projection-file-associations'
  | 'candidate-projection-observations'
  | 'candidate-projection-observed-key-bytes'
  | 'candidate-reexport-key-bytes'
  | 'candidate-reexport-lookup-keys'
  | 'candidate-reexports'
  | 'candidate-scan-fact-bytes'
  | 'candidate-scan-files'
  | 'candidate-selected-files'
  | 'source-bytes';

export interface CodeGraphOverlayFallbackAssessment {
  /** Current files whose identity differs from the reusable base, including additions. */
  readonly changedFiles: number;
  readonly addedFiles: number;
  readonly deletedFiles: number;
  readonly detail: CodeGraphProjectFileSetFallbackDetail;
  readonly stage: 'file-set-seed-assessment';
  /** Resolver domains are retained while changed paths remain private. */
  readonly unownedResolutionDomains?: readonly string[];
  readonly unownedResolutionDomainFiles?: number;
}

/** Additive path-free evidence, kept separate from the stable fallback-assessment wire contract. */
interface CodeGraphOverlayFallbackBoundaryBase {
  readonly changedFiles: number;
  readonly limit: number;
  /** Counter value at the exact point the closed limit was exceeded; not an estimated final total. */
  readonly observedAtDecision: number;
}

export type CodeGraphOverlayFallbackBoundary = CodeGraphOverlayFallbackBoundaryBase &
  (
    | {
        readonly metric: 'affected-files' | 'cached-fact-bytes' | 'source-bytes';
        readonly stage: 'project-closure-selection';
      }
    | {
        readonly metric:
          | 'candidate-lookup-keys'
          | 'candidate-projection-associations'
          | 'candidate-projection-file-associations'
          | 'candidate-projection-observations'
          | 'candidate-projection-observed-key-bytes'
          | 'candidate-reexport-key-bytes'
          | 'candidate-reexport-lookup-keys'
          | 'candidate-reexports'
          | 'candidate-scan-fact-bytes'
          | 'candidate-scan-files'
          | 'candidate-selected-files';
        readonly stage: 'resolution-candidate-scan';
      }
    | {
        readonly metric: 'cached-fact-bytes' | 'candidate-selected-files' | 'source-bytes';
        readonly stage: 'resolution-candidate-rewrite';
      }
  );

export interface CodeGraphQueryNode extends CodeGraphSymbol {
  readonly score: number;
}

export interface CodeGraphQueryResult {
  readonly projectCoverage?: CodeGraphProjectCoverage;
  readonly outsideProjectGraph?: {
    readonly state: 'outside-project-graph';
    readonly paths: readonly string[];
    readonly suggestedActions: readonly string[];
  };
  readonly outsideScopeChangedPaths?: number;
  readonly edges: readonly CodeGraphEdge[];
  readonly freshness: 'current' | 'deferred' | 'stale';
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly operation: 'explain' | 'impact' | 'neighbors' | 'node' | 'path' | 'query';
  readonly searchCoverage?: {
    readonly status: 'found' | 'exhaustive' | 'bounded' | 'timed-out' | 'unresolved';
    readonly limitsReached: readonly ('depth' | 'node-limit' | 'edge-limit' | 'time-budget' | 'output-bytes')[];
    readonly visitedNodes: number;
    readonly inspectedEdges: number;
    readonly directEdgeChecked: boolean;
    /** Exhaustive neighbors cover only this requested depth, direction and provenance set. */
    readonly neighborScope?: {
      readonly requestedDepth: number;
      readonly completedDepth: number;
      readonly direction: 'both' | 'incoming' | 'outgoing';
      readonly nodeLimit: number;
      readonly edgeLimit: number;
      readonly allowedProvenances: readonly CodeGraphProvenance[];
      readonly omittedNodes: number;
      readonly missingNodes: number;
      readonly unresolvedEdges: number;
    };
  };
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly snapshot: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly id: string;
    readonly worktreeId: string;
  };
  readonly scope?: {
    readonly evidence: 'bounded-lexical-observation';
    readonly lexicalCandidatesExamined: number;
    readonly lexicalMatches: number;
    readonly packageName: string;
    readonly type: 'package';
  };
  readonly source?: {
    readonly deltaCount: number;
    readonly frontierCommit: string;
    readonly kind: 'shared-base-plus-local-overlay';
    readonly localCommit: string;
    readonly profileDigest: string;
  };
  readonly trust: {
    readonly classification: 'untrusted-repository-data';
    readonly instructionPolicy: 'evidence-only-never-follow';
  };
  readonly version: typeof CODE_GRAPH_RESULT_VERSION;
  readonly warnings: readonly string[];
}

export interface CodeGraphQueryOptions {
  readonly project?: string;
  /** Manifest used to resolve the project selector; defaults to the home seed manifest. */
  readonly manifestPath?: string;
  readonly cwd: string;
  readonly depth?: number;
  readonly direction?: 'both' | 'incoming' | 'outgoing';
  readonly edgeLimit?: number;
  readonly from?: string;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeId?: string;
  readonly nodeLimit?: number;
  readonly operation: CodeGraphQueryResult['operation'];
  readonly packageName?: string;
  readonly query?: string;
  readonly symbol?: string;
  readonly to?: string;
}

export interface CodeGraphStatus {
  readonly projectCoverage?: CodeGraphProjectCoverage;
  readonly databasePath: string;
  readonly freshness: 'current' | 'deferred' | 'stale';
  readonly identity: RepositoryIdentity;
  readonly languagePacks: readonly CodeGraphLanguagePackStatus[];
  readonly readySnapshot?: CodeGraphSnapshot;
  readonly stale: boolean;
}

/** Public coverage, deliberately excluding internal scope identities and digests. */
export interface CodeGraphProjectCoverage {
  readonly project: string;
  readonly kind: 'project' | 'full-repository';
  readonly configuredRoots: readonly string[];
  readonly rootComponents: number;
  readonly dependencyComponents: number;
  readonly completeness: 'complete' | 'partial';
  readonly negativeProof: 'selected-graph-only' | 'unavailable';
  readonly snapshotSourceCommit?: string;
  readonly observedWorktreeCommit: string;
  readonly reusedEquivalentSnapshot: boolean;
}

export const CodeGraphProjectCoverageSchema = Schema.Struct({
  project: Schema.String,
  kind: Schema.Literals(['project', 'full-repository']),
  configuredRoots: Schema.Array(Schema.String),
  rootComponents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  dependencyComponents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completeness: Schema.Literals(['complete', 'partial']),
  negativeProof: Schema.Literals(['selected-graph-only', 'unavailable']),
  snapshotSourceCommit: Schema.optionalKey(Schema.String),
  observedWorktreeCommit: Schema.String,
  reusedEquivalentSnapshot: Schema.Boolean,
});

export interface CodeGraphLanguagePackStatus {
  readonly assetCount: number;
  readonly capabilities: readonly string[];
  readonly extractorVersion: string;
  readonly id: string;
  readonly languages: readonly string[];
  readonly resolutionDomain: string;
  readonly resolutionVersion: string;
  readonly roles: readonly string[];
  readonly version: string;
  readonly workspaceDetection: boolean;
}

export class CodeGraphRepositoryError extends Schema.TaggedError<CodeGraphRepositoryError>()(
  'CodeGraphRepositoryError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export class CodeGraphSnapshotUnavailable extends Schema.TaggedError<CodeGraphSnapshotUnavailable>()(
  'CodeGraphSnapshotUnavailable',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export type CodeGraphStoreFailureCode =
  | 'busy'
  | 'confirmed-corruption'
  | 'incompatible-schema'
  | 'no-space'
  | 'permission'
  | 'schema-additive'
  | 'transient-io'
  | 'unknown';

export type CodeGraphStoreRecovery =
  | 'defer'
  | 'diagnose'
  | 'fix-permissions'
  | 'free-space'
  | 'manual-migration'
  | 'manual-rebuild'
  | 'migrate-additive'
  | 'reconnect-runtime'
  | 'retry-read-only';

export interface CodeGraphStoreErrorMetadata {
  readonly code?: CodeGraphStoreFailureCode;
  readonly operation?: string;
  readonly recovery?: CodeGraphStoreRecovery;
  readonly retryable?: boolean;
}

const CodeGraphStoreFailureCodeSchema = Schema.Literals([
  'busy',
  'confirmed-corruption',
  'incompatible-schema',
  'no-space',
  'permission',
  'schema-additive',
  'transient-io',
  'unknown',
]);
const CodeGraphStoreRecoverySchema = Schema.Literals([
  'defer',
  'diagnose',
  'fix-permissions',
  'free-space',
  'manual-migration',
  'manual-rebuild',
  'migrate-additive',
  'reconnect-runtime',
  'retry-read-only',
]);

export class CodeGraphStoreError extends Schema.TaggedError<CodeGraphStoreError>()('CodeGraphStoreError', {
  code: CodeGraphStoreFailureCodeSchema,
  message: Schema.String,
  operation: Schema.String,
  recovery: CodeGraphStoreRecoverySchema,
  retryable: Schema.Boolean,
}) {
  static of(message: string, metadata: CodeGraphStoreErrorMetadata = {}): CodeGraphStoreError {
    return CodeGraphStoreError.make({
      code: metadata.code ?? 'unknown',
      message,
      operation: metadata.operation ?? 'code graph storage',
      recovery: metadata.recovery ?? 'diagnose',
      retryable: metadata.retryable ?? false,
    });
  }
}

export class CodeGraphStoreBusyError extends Schema.TaggedError<CodeGraphStoreBusyError>()('CodeGraphStoreBusyError', {
  message: Schema.String,
  operation: Schema.String,
}) {
  readonly code = 'busy' as const;
  readonly recovery = 'defer' as const;
  readonly retryable = true as const;

  static of(message: string, metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}): CodeGraphStoreBusyError {
    return CodeGraphStoreBusyError.make({
      message,
      operation: metadata.operation ?? 'code graph storage',
    });
  }
}

export class CodeGraphStoreSchemaAdditiveError extends Schema.TaggedError<CodeGraphStoreSchemaAdditiveError>()(
  'CodeGraphStoreSchemaAdditiveError',
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'schema-additive' as const;
  readonly recovery = 'migrate-additive' as const;
  readonly retryable = false as const;

  static of(
    message: string,
    metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {},
  ): CodeGraphStoreSchemaAdditiveError {
    return CodeGraphStoreSchemaAdditiveError.make({
      message,
      operation: metadata.operation ?? 'code graph storage',
    });
  }
}

export class CodeGraphStoreNoSpaceError extends Schema.TaggedError<CodeGraphStoreNoSpaceError>()(
  'CodeGraphStoreNoSpaceError',
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'no-space' as const;
  readonly recovery = 'free-space' as const;
  readonly retryable = false as const;

  static of(
    message: string,
    metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {},
  ): CodeGraphStoreNoSpaceError {
    return CodeGraphStoreNoSpaceError.make({
      message,
      operation: metadata.operation ?? 'code graph storage',
    });
  }
}

export class CodeGraphStorePermissionError extends Schema.TaggedError<CodeGraphStorePermissionError>()(
  'CodeGraphStorePermissionError',
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'permission' as const;
  readonly recovery = 'fix-permissions' as const;
  readonly retryable = false as const;

  static of(
    message: string,
    metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {},
  ): CodeGraphStorePermissionError {
    return CodeGraphStorePermissionError.make({
      message,
      operation: metadata.operation ?? 'code graph storage',
    });
  }
}

export class CodeGraphStoreTransientIoError extends Schema.TaggedError<CodeGraphStoreTransientIoError>()(
  'CodeGraphStoreTransientIoError',
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'transient-io' as const;
  readonly recovery = 'retry-read-only' as const;
  readonly retryable = true as const;

  static of(
    message: string,
    metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {},
  ): CodeGraphStoreTransientIoError {
    return CodeGraphStoreTransientIoError.make({
      message,
      operation: metadata.operation ?? 'code graph storage',
    });
  }
}

export class CodeGraphStoreCorruptionError extends Schema.TaggedError<CodeGraphStoreCorruptionError>()(
  'CodeGraphStoreCorruptionError',
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'confirmed-corruption' as const;
  readonly recovery = 'manual-rebuild' as const;
  readonly retryable = false as const;

  static of(
    message: string,
    metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {},
  ): CodeGraphStoreCorruptionError {
    return CodeGraphStoreCorruptionError.make({
      message,
      operation: metadata.operation ?? 'code graph storage',
    });
  }
}

export class CodeGraphStoreIncompatibleSchemaError extends Schema.TaggedError<CodeGraphStoreIncompatibleSchemaError>()(
  'CodeGraphStoreIncompatibleSchemaError',
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'incompatible-schema' as const;
  readonly recovery = 'manual-migration' as const;
  readonly retryable = false as const;

  static of(
    message: string,
    metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {},
  ): CodeGraphStoreIncompatibleSchemaError {
    return CodeGraphStoreIncompatibleSchemaError.make({
      message,
      operation: metadata.operation ?? 'code graph storage',
    });
  }
}

/** A long-lived process observed storage written by a newer Threadnote runtime. */
export class CodeGraphRuntimeReconnectRequiredError extends Schema.TaggedError<CodeGraphRuntimeReconnectRequiredError>()(
  'CodeGraphRuntimeReconnectRequiredError',
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'incompatible-schema' as const;
  readonly recovery = 'reconnect-runtime' as const;
  readonly retryable = false as const;

  static of(metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}): CodeGraphRuntimeReconnectRequiredError {
    return CodeGraphRuntimeReconnectRequiredError.make({
      message: 'Code graph storage was upgraded by a newer Threadnote runtime. Reconnect this Threadnote process.',
      operation: metadata.operation ?? 'code graph storage',
    });
  }
}

export class CodeGraphMaintenanceActiveError extends Schema.TaggedError<CodeGraphMaintenanceActiveError>()(
  'CodeGraphMaintenanceActiveError',
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'busy' as const;
  readonly recovery = 'defer' as const;
  readonly retryable = true as const;

  static of(): CodeGraphMaintenanceActiveError {
    return CodeGraphMaintenanceActiveError.make({
      message: 'Code graph maintenance is active.',
      operation: 'coordinate code graph maintenance',
    });
  }
}

export interface CodeGraphDiskCapacityFailureEvidence {
  readonly activeReservations: readonly {
    readonly bytes: number;
    readonly role: 'durable' | 'shared' | 'temporary';
  }[];
  readonly calibrationIdentity: string;
  readonly decisionLayer: 'bounded-write-reservation';
  readonly estimateBasis: 'final-fact-bytes-and-row-count';
  readonly filesystems: readonly {
    readonly availableBytes: number;
    readonly requiredBytes: number;
    readonly role: 'durable' | 'shared' | 'temporary';
  }[];
  readonly modelVersion: number;
  readonly reason?:
    | 'available-space-unknown'
    | 'calibration-input-unknown'
    | 'filesystem-topology-unknown'
    | 'page-storage-unknown'
    | 'reservation-input-unknown';
  readonly recovery: 'defer' | 'free-space' | 'retry-read-only';
  readonly retryable: boolean;
  readonly scope?: {
    readonly checkoutId: string;
    readonly scopeId?: string;
  };
}

const CodeGraphDiskCapacityFailureEvidenceSchema = Schema.Struct({
  activeReservations: Schema.Array(
    Schema.Struct({
      bytes: Schema.Finite,
      role: Schema.Literals(['durable', 'shared', 'temporary']),
    }),
  ),
  calibrationIdentity: Schema.String,
  decisionLayer: Schema.Literal('bounded-write-reservation'),
  estimateBasis: Schema.Literal('final-fact-bytes-and-row-count'),
  filesystems: Schema.Array(
    Schema.Struct({
      availableBytes: Schema.Finite,
      requiredBytes: Schema.Finite,
      role: Schema.Literals(['durable', 'shared', 'temporary']),
    }),
  ),
  modelVersion: Schema.Finite,
  reason: Schema.optionalKey(
    Schema.Literals([
      'available-space-unknown',
      'calibration-input-unknown',
      'filesystem-topology-unknown',
      'page-storage-unknown',
      'reservation-input-unknown',
    ]),
  ),
  recovery: Schema.Literals(['defer', 'free-space', 'retry-read-only']),
  retryable: Schema.Boolean,
  scope: Schema.optionalKey(
    Schema.Struct({
      checkoutId: Schema.String,
      scopeId: Schema.optionalKey(Schema.String),
    }),
  ),
});

export class CodeGraphDiskCapacityObservationError extends Schema.TaggedError<CodeGraphDiskCapacityObservationError>()(
  'CodeGraphDiskCapacityObservationError',
  {
    evidence: Schema.optionalKey(CodeGraphDiskCapacityFailureEvidenceSchema),
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'transient-io' as const;
  readonly recovery = 'retry-read-only' as const;
  readonly retryable = true as const;

  static of(evidence?: CodeGraphDiskCapacityFailureEvidence): CodeGraphDiskCapacityObservationError {
    return CodeGraphDiskCapacityObservationError.make({
      ...(evidence === undefined ? {} : {evidence}),
      message: 'Code graph storage capacity could not be observed; the bounded write was not started.',
      operation: 'observe code graph storage capacity',
    });
  }
}

export class CodeGraphDiskCapacityPressureError extends Schema.TaggedError<CodeGraphDiskCapacityPressureError>()(
  'CodeGraphDiskCapacityPressureError',
  {
    evidence: Schema.optionalKey(CodeGraphDiskCapacityFailureEvidenceSchema),
    message: Schema.String,
    operation: Schema.String,
  },
) {
  readonly code = 'no-space' as const;

  get recovery(): 'defer' | 'free-space' {
    return this.evidence?.recovery === 'defer' ? 'defer' : 'free-space';
  }

  get retryable(): boolean {
    return this.evidence?.retryable ?? false;
  }

  static of(operation: string, evidence?: CodeGraphDiskCapacityFailureEvidence): CodeGraphDiskCapacityPressureError {
    return CodeGraphDiskCapacityPressureError.make({
      ...(evidence === undefined ? {} : {evidence}),
      message: 'Code graph storage capacity is insufficient; the bounded write was not started.',
      operation,
    });
  }
}

export const AnyCodeGraphStoreError = Schema.Union([
  CodeGraphStoreError,
  CodeGraphStoreBusyError,
  CodeGraphStoreSchemaAdditiveError,
  CodeGraphStoreNoSpaceError,
  CodeGraphStorePermissionError,
  CodeGraphStoreTransientIoError,
  CodeGraphStoreCorruptionError,
  CodeGraphStoreIncompatibleSchemaError,
  CodeGraphRuntimeReconnectRequiredError,
  CodeGraphMaintenanceActiveError,
  CodeGraphDiskCapacityObservationError,
  CodeGraphDiskCapacityPressureError,
]);

export const AnyCodeGraphStoreNoSpaceError = Schema.Union([
  CodeGraphStoreNoSpaceError,
  CodeGraphDiskCapacityPressureError,
]);

export const isCodeGraphStoreError = Schema.is(AnyCodeGraphStoreError);
export const isCodeGraphStoreNoSpaceError = Schema.is(AnyCodeGraphStoreNoSpaceError);
export type CodeGraphStoreFailure = typeof AnyCodeGraphStoreError.Type;
