import {Context, Effect, Layer} from 'effect';
import {makeCodeGraphStoreRuntime} from './store/runtime.js';
import {makeCodeGraphStoreDataMethods} from './store/service/data.js';
import {makeCodeGraphStoreLifecycleMethods} from './store/service/lifecycle.js';
import {makeCodeGraphStoreMaintenanceMethods} from './store/service/maintenance.js';
import {makeCodeGraphStoreStagingMethods} from './store/service/staging.js';
import {makeCodeGraphStoreCheckpointMethods} from './store/service/checkpoint.js';
import {type CodeGraphStoreShape} from './store/shape.js';

export {
  canonicalCodeGraphMonikers,
  codeGraphPackageMoniker,
  codeGraphProtobufMoniker,
  compareCodeGraphMonikers,
  normalizeNpmPackageName,
  normalizeProtobufImportPath,
  normalizeProtobufName,
  parseCodeGraphMonikerV1,
  type CodeGraphPackageMonikerInput,
  type CodeGraphProtobufMonikerInput,
} from './cross_repository/monikers.js';
export {
  CODE_GRAPH_EXTERNAL_DEPENDENCY_KINDS,
  CODE_GRAPH_MONIKER_STRICT_PARSE_OPTIONS,
  CODE_GRAPH_MONIKER_VERSION,
  CodeGraphExternalDependencySchemaV1,
  CodeGraphMonikerSchemaV1,
  CodeGraphPackageMonikerSchemaV1,
  CodeGraphProtobufMonikerSchemaV1,
  type CodeGraphExternalDependencyKind,
  type CodeGraphExternalDependencyV1,
  type CodeGraphMonikerRole,
  type CodeGraphMonikerV1,
  type CodeGraphPackageMonikerV1,
  type CodeGraphProtobufMonikerKind,
  type CodeGraphProtobufMonikerV1,
  type CodeGraphSourceEvidenceV1,
} from './cross_repository/types.js';
export {
  CODE_GRAPH_CITATION_QUERY_MAX_MATCHES_PER_TARGET,
  CODE_GRAPH_CITATION_QUERY_MAX_TARGETS,
  CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1,
  codeGraphSourceSpanFragment,
  createCodeGraphSourceSpanCanonicalizer,
  selectCodeGraphCitationContentHashTargets,
  type CodeGraphEffectiveFileHashMatches,
  type CodeGraphEffectiveFilePathObservation,
  type CodeGraphEffectiveSnapshotCitationEvidence,
  type CodeGraphEffectiveSnapshotCitationEvidenceRequest,
  type CodeGraphEffectiveSymbolLocatorMatches,
  type CodeGraphCitationFileRelocationFallbackV1,
  type CodeGraphSourceSpanFragmentFailureReason,
  type CodeGraphSourceSpanCanonicalizerV1,
  type CodeGraphSourceSpanFragmentResult,
  type CodeGraphSourceSpanFragmentV1,
  type CodeGraphSymbolSemanticLocatorV1,
} from './citation/primitives.js';

export * from './store/models.js';
export type {
  CodeGraphDatabaseSessionOptions,
  CodeGraphSqliteWriterSettings,
  CodeGraphSqliteWriterTuning,
  CodeGraphStoreShape,
} from './store/shape.js';
export {
  CODE_GRAPH_PERSISTENT_EXTENSION_TABLE_NAMES,
  type CodeGraphPersistentSchemaMigrationPhase,
} from './store/schema/contracts.js';
export {codeGraphPersistentExtensionSchemaCompatible} from './store/schema/inspection.js';
export {CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} from './store/cache/authority.js';
export {CODE_GRAPH_DATABASE_PAGE_SIZE_BYTES} from './store/schema/initialization.js';
export {CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION} from './types.js';
export {nextPersistentActivationBatchRows} from './store/activation/core.js';
export {codeGraphPersistedEndpointValidationPageStatement} from './store/activation/persistent.js';
export {persistentFullShardPublicationPlan} from './store/activation/persistent.js';
export {
  codeGraphAnalysisEdgeAggregatePageStatement,
  codeGraphAnalysisSummaryDigest,
  codeGraphAnalysisSymbolAggregatePageStatement,
} from './store/analysis.js';
export {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from './store/build/core.js';
export {codeGraphCompactLexicalDeepAuditStatement} from './store/build/preparation.js';
export {
  codeGraphMaterializedShardAssociationPageStatement,
  materializedBatchShardDerivationIdentity,
  materializedFileShardIdentity,
  materializedShardRepositorySemanticEnvelope,
  materializedShardDerivationIdentity,
  shardDonorIds,
} from './store/cache.js';
export {
  codeGraphCompactLexicalCleanupPageStatement,
  codeGraphExactSnapshotRetirementStatement,
} from './store/cleanup_core.js';
export {
  CODE_GRAPH_ROUTINE_CACHE_PAGE_SIZE,
  codeGraphRoutineFileBlobCleanupPageStatement,
  codeGraphRoutineMaterializedShardCleanupPageStatement,
} from './store/maintenance_core.js';
export {
  codeGraphAdjacencyQueryStatement,
  codeGraphDirectEdgeQueryStatement,
  codeGraphCachedCommittedFileKeysStatement,
  codeGraphExactSymbolQueryStatement,
  codeGraphSymbolPathClass,
  codeGraphSymbolPathScoreMultiplier,
  codeGraphSymbolSearchScoreMultiplier,
  codeGraphSymbolsByIdsQueryStatement,
  isCanonicalAbsoluteBazelLabel,
  type CodeGraphSymbolPathClass,
} from './store/query/core.js';
export {
  codeGraphCompleteMaterializedShardDonorStatement,
  codeGraphEffectiveSymbolTermsQueryStatement,
  codeGraphTermCandidateQueryStatement,
} from './store/queries.js';
export {
  codeGraphEffectiveFilesByContentHashesQueryStatement,
  codeGraphEffectiveFilesByPathsQueryStatement,
  codeGraphEffectiveSymbolsBySemanticLocatorsQueryStatement,
} from './store/citation_queries.js';
export {
  codeGraphRemovedViewCleanupAdmissionPageStatement,
  codeGraphRemovedViewCleanupDuePageStatement,
} from './store/reconciliation.js';
export {codeGraphWorktreeReconciliationCandidatePageStatement} from './store/reconciliation/core.js';
export {
  codeGraphPersistentReferencePageStatement,
  codeGraphPersistedDeltaResolutionPageStatement,
  partitionPersistedReferenceEdges,
  type PersistedReferenceEdgePartition,
} from './store/resolution/core.js';
export {
  codeGraphPersistentLookupMatchStatement,
  resolvePersistedReferenceSelections,
  type PersistedLookupPair,
  type PersistedLookupSummary,
  type PersistedReferenceResolutionInput,
  type PersistedReferenceResolutionSelection,
} from './store/resolution/matching.js';
export {codeGraphRemovedViewCleanupSchemaAdmission} from './store/schema/migration.js';
export {type CodeGraphPersistentReferencePageLimits} from './store/staging_core.js';
export {normalizedTerms, sanitizeCodeGraphStoreDiagnostic} from './store/utilities.js';
export {
  CodeGraphCheckpointReuseHydrationError,
  hydrateCodeGraphCheckpointReusableBaseReceipt,
} from './checkpoint/import_reuse.js';
export {
  codeGraphVisualizationCatalogComponentStatement,
  codeGraphVisualizationScopeEndpointStatement,
  codeGraphVisualizationScopeSummaryStatementCount,
  codeGraphVisualizationSymbolsQueryStatement,
  type CodeGraphSqlQueryStatement,
} from './store/visualization_sql.js';
export {
  codeGraphVisualizationScopeEdgeSampleStatements,
  codeGraphVisualizationScopeSymbolSampleStatements,
} from './store/visualization.js';

export class CodeGraphStore extends Context.Service<CodeGraphStore, CodeGraphStoreShape>()(
  '@threadnote/graph/store/CodeGraphStore',
) {
  static readonly layer = Layer.effect(
    CodeGraphStore,
    Effect.gen(function* () {
      const runtime = yield* makeCodeGraphStoreRuntime;
      return CodeGraphStore.of({
        ...makeCodeGraphStoreCheckpointMethods(runtime),
        ...makeCodeGraphStoreLifecycleMethods(runtime),
        ...makeCodeGraphStoreDataMethods(runtime),
        ...makeCodeGraphStoreMaintenanceMethods(runtime),
        ...makeCodeGraphStoreStagingMethods(runtime),
      });
    }),
  );
}

export type {CodeGraphLeaseTimingObserver} from './store/lease_timing.js';
