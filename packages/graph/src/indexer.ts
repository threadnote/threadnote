export {resumeExistingCodeGraphEmbeddingDemand} from './lifecycle/opportunity.js';
export {observeCodeGraphSemanticStatus} from './vector/status.js';
export {
  budgetCachedCodeGraphFacts,
  cachedCodeGraphFactBytes,
  cachedCodeGraphFactByteUpperBound,
  CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
  CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM,
  CODE_GRAPH_REFERENCE_CANDIDATE_BUDGET_DIAGNOSTIC,
  compactCachedFileRelationships,
  finalCodeGraphFactBatches,
} from './fact/budget.js';

export {CodeGraphIndexer, codeGraphInventoryNeedsSynchronousReclamation} from './indexer/service.js';
export {
  codeGraphIndexEnsuresVectors,
  codeGraphIndexVectorPolicy,
  type CodeGraphVectorPolicy,
  type CodeGraphCommitLease,
  type CodeGraphIndexerShape,
  type CodeGraphIndexOptions,
  type DirectPersistentCapacityProtection,
} from './indexer/types.js';
export {
  createCachedCodeGraphFactsAttributor,
  deriveCachedCodeGraphFacts,
  hasSameCodeGraphResolutionSurface,
  resolvePersistedReexportTerminals,
  reusableBaseFileSetFingerprint,
} from './indexer/incremental.js';
export {
  addMaterializationReplayMetrics,
  addMaterializationRows,
  cacheContentBatch,
  codeGraphActiveParserCacheKey,
  CODE_GRAPH_MATERIALIZATION_STORAGE_HEURISTIC_MODEL_VERSION,
  codeGraphDirectPersistentCapacityProtector,
  codeGraphParserCacheLookupGenerations,
  deduplicateMaterializationRelationships,
  directFullSnapshotIdentity,
  emptyMaterializationReplayMetrics,
  estimatedMaterializationStorageBytes,
  extractorSetIdentity,
  extractorSetIdentityFromPackProvenance,
  factMaterializationBatches,
  graphContentIdentity,
  materializationRowsWithStoreProgress,
  materializationStoragePlan,
  materializationStorageShortfalls,
  parserCacheIdentity,
  persistentMaterializationTransactionBatches,
  shouldReuseReadySnapshotForCleanCommit,
  snapshotIdentity,
  sparseOverlayGraphContentIdentity,
  sparseOverlaySnapshotIdentity,
  type CodeGraphCacheContentCoalescer,
  type CodeGraphCacheExtractedRow,
  type DirectPersistentCapacityContext,
  type CodeGraphMaterializationReplayMetrics,
  type CodeGraphMaterializationReplayObservation,
  type MaterializationStorageAvailability,
  type MaterializationStoragePlan,
  type PersistentMaterializationTransactionCandidate,
} from './indexer/materialization.js';
