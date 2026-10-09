import {Schema} from 'effect';
import {ApplicationError} from '@threadnote/platform/errors';
import {diagnosticErrorType} from '../effect/production_log.js';
import {
  type CodeGraphStoreFailureCode,
  type CodeGraphStoreRecovery,
  isCodeGraphStoreError,
} from '@threadnote/graph/types';
import {CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_OPERATIONS} from '@threadnote/graph/disk/capacity';

const SAFE_TELEMETRY_ERROR_TYPES = new Set([
  'AggregateError',
  'AgentResponseBudgetTooSmallError',
  'ArchiveOperationError',
  'AiConsolidationFailed',
  'AiError',
  'AiMemoryEnrichmentFailed',
  'AiRecallExpansionFailed',
  'AiRecallSelectionFailed',
  'ApplicationError',
  'CandidateMemoryError',
  'CliOutputError',
  'CodeGraphAutomaticCompactionError',
  'CodeGraphAutomaticCompactionReceiptError',
  'CodeGraphBuildStatusError',
  'CodeGraphCacheCapacityPlanChanged',
  'CodeGraphCommandError',
  'CodeGraphCrossRepositoryRuntimeError',
  'CodeGraphDeepDiagnosticsError',
  'CodeGraphDiskReservationClaimControl',
  'CodeGraphDiskCapacityObservationError',
  'CodeGraphDiskCapacityPressureError',
  'CodeGraphDiskReservationLedgerError',
  'CodeGraphEmbeddingError',
  'CodeGraphExportError',
  'CodeGraphGitWorktreeRegistrationError',
  'CodeGraphIndexOperationError',
  'CodeGraphInventoryError',
  'CodeGraphLanguagePackError',
  'CodeGraphLocalProvenanceError',
  'CodeGraphMaintenanceActiveError',
  'CodeGraphMaintenanceError',
  'CodeGraphMaintenanceGateError',
  'CodeGraphPromotionCapacityPlanChanged',
  'CodeGraphQueryExpansionError',
  'CodeGraphRepositoryError',
  'CodeGraphRuntimeReconnectRequiredError',
  'CodeGraphSnapshotMonikerError',
  'CodeGraphSnapshotPurgeError',
  'CodeGraphSnapshotUnavailable',
  'CodeGraphStorageOperationError',
  'CodeGraphStoreBusyError',
  'CodeGraphStoreCorruptionError',
  'CodeGraphStoreError',
  'CodeGraphStoreIncompatibleSchemaError',
  'CodeGraphStoreNoSpaceError',
  'CodeGraphStorePermissionError',
  'CodeGraphStoreSchemaAdditiveError',
  'CodeGraphStoreTransientIoError',
  'CodeGraphVectorMaintenanceError',
  'CodeGraphVectorRetirementError',
  'CodeGraphViewRemovalError',
  'CodeGraphVisualizationError',
  'CodeGraphWatcherError',
  'CodeGraphWorksetCatalogError',
  'CodeGraphWorksetRouterError',
  'CommandFailed',
  'CommandOutputLimitExceeded',
  'CommandSpawnFailed',
  'CommandTimedOut',
  'CursorAttestationError',
  'CursorCloudOperationError',
  'CursorPluginError',
  'EmbeddingFailed',
  'Error',
  'FileLockTimeout',
  'GenerationFailed',
  'GitWorktreeRegistrationError',
  'HomeMigrationConflict',
  'HomeMigrationFailed',
  'HomeMigrationInsufficientSpace',
  'HomeMigrationUnsafe',
  'HttpRequestFailed',
  'HttpStatusError',
  'InferenceInterrupted',
  'InsufficientDiskSpace',
  'InsufficientMemory',
  'InstallationOperationError',
  'InvalidBuildHistorySidecarError',
  'InvalidBuildSidecarError',
  'InvalidModelOutput',
  'InvalidProjectSeedPattern',
  'InvalidResourceId',
  'IsolatedBuilderError',
  'LegacyLocalModelMigrationError',
  'LegacyRuntimeMigrationError',
  'LifecycleOperationError',
  'LocalAiOperationError',
  'LocalModelWorkerServerError',
  'LocalModelWorkerTransportError',
  'ManagerApiError',
  'ManagerGraphBusyError',
  'ManagerGraphLeaseError',
  'ManagerGraphViewActionBusyError',
  'ManagerGraphViewActionError',
  'ManagerGraphViewUnavailableError',
  'ManagerOperationError',
  'ManagerProcessApiError',
  'ManagerProjectRootError',
  'ManagerRequestInputError',
  'ManagerWorksetApiError',
  'ManifestOperationError',
  'McpBrokerError',
  'McpArgumentError',
  'McpOperationError',
  'McpServerOperationError',
  'McpToolError',
  'MemoryOperationError',
  'MemoryPointerNotFound',
  'MemoryRelocationError',
  'ModelChecksumMismatch',
  'ModelCommandError',
  'ModelDownloadFailed',
  'ModelLoadFailed',
  'ModelManifestInvalid',
  'ModelNotInstalled',
  'ModelSelectionError',
  'ModelStoreIoFailed',
  'NativeStatfsUnavailableError',
  'NativeRuntimeUnavailable',
  'ObsidianConfigurationError',
  'ObsidianInboxError',
  'ObsidianProjectionError',
  'ObsidianSourceError',
  'ParserWorkerError',
  'RangeError',
  'RecallIndexCorrupt',
  'RecallIndexOperationError',
  'RecallIndexSchemaIncompatible',
  'ReferenceError',
  'ReleaseNotesError',
  'RepositoryMaintenanceInterrupted',
  'RepositoryRegistrationLost',
  'ReportIssueCreateFailed',
  'ReportIssueInvalid',
  'ResourceAccessDenied',
  'ResourceAlreadyExists',
  'ResourceConflict',
  'ResourceIoFailed',
  'ResourceNotFound',
  'ResourcePathUnsafe',
  'RerankingFailed',
  'ReportedError',
  'SearchCommandError',
  'SeedingOperationError',
  'ShareOperationError',
  'SourceConfigurationError',
  'SourceCoordinatorError',
  'StandaloneProcessLeaseError',
  'StorageLayoutMigrationConflict',
  'SyntaxError',
  'SystemOperationError',
  'TelemetryConfigurationError',
  'ThreadnoteProcessTerminationError',
  'TreeSitterRuntimeError',
  'TypeError',
  'UnknownError',
  'UnsupportedNativeRuntime',
  'URIError',
  'UpdateOperationError',
  'UtilityOperationError',
  'VectorIndexCorrupt',
  'VectorIndexOperationError',
  'VectorInvalid',
  'VersionCommandError',
  'WindowsSystemError',
  'WorktreeChangedDuringIndex',
  'WorktreeChangedDuringQuery',
]);

/**
 * Deliberately closed diagnostic shape that can cross the anonymous telemetry
 * boundary. Free-form errors, messages, stacks, paths, and query input are not
 * representable here.
 */
export interface AnonymousTelemetryDiagnostic {
  readonly code?: CodeGraphStoreFailureCode;
  readonly domain?: 'code-graph-storage' | 'model-worker';
  readonly errorType: string;
  readonly operation?: string;
  readonly reason?: 'crash' | 'exit' | 'protocol' | 'spawn' | 'timeout' | 'write';
  readonly recovery?: CodeGraphStoreRecovery;
  readonly retryable?: boolean;
}

export type AnonymousTelemetryReportedOutcome = 'failure' | 'timed-out' | 'unavailable';

const ANONYMOUS_TELEMETRY_DIAGNOSTIC = Symbol('threadnote/anonymous-telemetry-diagnostic');
const ANONYMOUS_TELEMETRY_REPORTED_OUTCOME = Symbol('threadnote/anonymous-telemetry-reported-outcome');
const ANONYMOUS_TELEMETRY_REPORTED_OUTCOMES = new Set<AnonymousTelemetryReportedOutcome>([
  'failure',
  'timed-out',
  'unavailable',
]);
const CODE_GRAPH_STORE_FAILURE_CODES = new Set<CodeGraphStoreFailureCode>([
  'busy',
  'confirmed-corruption',
  'incompatible-schema',
  'no-space',
  'permission',
  'schema-additive',
  'transient-io',
  'unknown',
]);
const CODE_GRAPH_STORE_RECOVERIES = new Set<CodeGraphStoreRecovery>([
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
const MODEL_WORKER_OPERATIONS = new Set(['diagnostics', 'embed-many', 'generate', 'rerank']);
const MODEL_WORKER_REASONS = new Set(['crash', 'exit', 'protocol', 'spawn', 'timeout', 'write']);

// These labels are authored in Threadnote source. A grammar alone is not a
// privacy boundary: a malformed carrier could otherwise smuggle an arbitrary
// user-shaped string into an outbound attribute.
const CODE_GRAPH_FAILURE_OPERATIONS = new Set([
  ...CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_OPERATIONS,
  'acquire code graph snapshot lease',
  'activate code graph snapshot',
  'activate staged code graph snapshot',
  'aggregate code graph edge page',
  'aggregate code graph symbol page',
  'automatic code graph recovery',
  'cache code graph file facts',
  'cache materialized code graph file shards',
  'check code graph runtime compatibility',
  'code graph storage',
  'coordinate code graph maintenance',
  'diagnose code graph database',
  'initialize code graph database',
  'load active code graph view identities',
  'load cached code graph facts',
  'load cached code graph file keys',
  'load code graph adjacency',
  'load code graph analysis summary',
  'load code graph edge page',
  'load code graph embedding symbol page',
  'load code graph snapshot',
  'load code graph snapshot symbols',
  'load code graph symbol page',
  'load code graph symbols',
  'load code graph visualization catalog',
  'load code graph visualization catalogs',
  'load code graph visualization scope edges',
  'load code graph visualization symbols',
  'load materialized code graph file shards',
  'load ready code graph snapshot',
  'load ready code graph snapshot by identity',
  'load ready code graph snapshot for commit',
  'load representative code graph adjacency',
  'load reusable clean code graph base',
  'load reusable code graph base receipt',
  'mutate graph view',
  'observe code graph snapshot purge',
  'observe code graph view',
  'prepare code graph database',
  'prepare staged code graph activation',
  'promote code graph snapshot',
  'prune cached code graph facts',
  'prune retired code graph snapshots',
  'protect code graph storage',
  'purge selected code graph snapshot',
  'refresh code graph',
  'release code graph SQLite memory',
  'release code graph snapshot lease',
  'remove code graph view',
  'renew code graph snapshot lease',
  'repair code graph database',
  'resolve qualified code graph symbol',
  'resolve staged code graph references',
  'retire incomplete code graph snapshots',
  'run routine code graph maintenance',
  'search code graph symbols',
  'search code graph symbols by path',
  'stage code graph facts',
  'stage code graph workspace catalog',
  'stage grouped code graph facts',
  'start code graph snapshot',
  'summarize code graph relationships',
  'use code graph database session',
  'validate code graph view snapshot lease',
]);
const MAXIMUM_CAUSE_DEPTH = 8;

type DiagnosticCarrier = {
  readonly [ANONYMOUS_TELEMETRY_DIAGNOSTIC]?: AnonymousTelemetryDiagnostic;
  readonly [ANONYMOUS_TELEMETRY_REPORTED_OUTCOME]?: AnonymousTelemetryReportedOutcome;
};

/** Attach metadata without changing the enumerable MCP result sent on the wire. */
export function attachAnonymousTelemetryDiagnostic<A extends object>(
  value: A,
  diagnostic: AnonymousTelemetryDiagnostic | undefined,
): A {
  const projected = projectAnonymousTelemetryDiagnostic(diagnostic);
  if (projected === undefined) return value;
  try {
    Object.defineProperty(value, ANONYMOUS_TELEMETRY_DIAGNOSTIC, {
      configurable: false,
      enumerable: false,
      value: projected,
      writable: false,
    });
  } catch {
    // Diagnostic bookkeeping must never alter the application value.
  }
  return value;
}

export function readAnonymousTelemetryDiagnostic(value: unknown): AnonymousTelemetryDiagnostic | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    return projectAnonymousTelemetryDiagnostic((value as DiagnosticCarrier)[ANONYMOUS_TELEMETRY_DIAGNOSTIC]);
  } catch {
    return undefined;
  }
}

/** Copy an untrusted carrier into the exact closed shape allowed on the wire. */
export function projectAnonymousTelemetryDiagnostic(
  diagnostic: AnonymousTelemetryDiagnostic | undefined,
): AnonymousTelemetryDiagnostic | undefined {
  try {
    if (diagnostic === undefined || typeof diagnostic !== 'object') return undefined;
    const errorType = closedTelemetryErrorType(diagnostic.errorType);
    const domain = diagnostic.domain;
    if (domain === undefined) return Object.freeze({errorType});
    if (domain === 'model-worker') {
      if (
        diagnostic.operation === undefined ||
        !MODEL_WORKER_OPERATIONS.has(diagnostic.operation) ||
        diagnostic.reason === undefined ||
        !MODEL_WORKER_REASONS.has(diagnostic.reason)
      ) {
        return Object.freeze({errorType});
      }
      return Object.freeze({
        domain,
        errorType,
        operation: diagnostic.operation,
        reason: diagnostic.reason,
      });
    }
    if (domain !== 'code-graph-storage') return Object.freeze({errorType});
    if (diagnostic.code !== undefined && !CODE_GRAPH_STORE_FAILURE_CODES.has(diagnostic.code)) {
      return Object.freeze({errorType});
    }
    if (diagnostic.recovery !== undefined && !CODE_GRAPH_STORE_RECOVERIES.has(diagnostic.recovery)) {
      return Object.freeze({errorType});
    }
    if (diagnostic.operation !== undefined && !CODE_GRAPH_FAILURE_OPERATIONS.has(diagnostic.operation)) {
      return Object.freeze({errorType});
    }
    if (diagnostic.retryable !== undefined && typeof diagnostic.retryable !== 'boolean') {
      return Object.freeze({errorType});
    }
    return Object.freeze({
      ...(diagnostic.code === undefined ? {} : {code: diagnostic.code}),
      domain,
      errorType,
      ...(diagnostic.operation === undefined ? {} : {operation: diagnostic.operation}),
      ...(diagnostic.recovery === undefined ? {} : {recovery: diagnostic.recovery}),
      ...(diagnostic.retryable === undefined ? {} : {retryable: diagnostic.retryable}),
    });
  } catch {
    return undefined;
  }
}

/** Attach a closed non-success outcome without changing an MCP result's JSON wire representation. */
export function attachAnonymousTelemetryReportedOutcome<A extends object>(
  value: A,
  outcome: AnonymousTelemetryReportedOutcome | undefined,
): A {
  if (outcome === undefined || !ANONYMOUS_TELEMETRY_REPORTED_OUTCOMES.has(outcome)) return value;
  try {
    Object.defineProperty(value, ANONYMOUS_TELEMETRY_REPORTED_OUTCOME, {
      configurable: false,
      enumerable: false,
      value: outcome,
      writable: false,
    });
  } catch {
    // Outcome bookkeeping must never alter the application value.
  }
  return value;
}

export function readAnonymousTelemetryReportedOutcome(value: unknown): AnonymousTelemetryReportedOutcome | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const outcome = (value as DiagnosticCarrier)[ANONYMOUS_TELEMETRY_REPORTED_OUTCOME];
    return outcome !== undefined && ANONYMOUS_TELEMETRY_REPORTED_OUTCOMES.has(outcome) ? outcome : undefined;
  } catch {
    return undefined;
  }
}

/** Preserve private telemetry metadata while adapting an MCP result to another result class. */
export function copyAnonymousTelemetryMetadata<A extends object>(target: A, source: unknown): A {
  return attachAnonymousTelemetryReportedOutcome(
    attachAnonymousTelemetryDiagnostic(target, readAnonymousTelemetryDiagnostic(source)),
    readAnonymousTelemetryReportedOutcome(source),
  );
}

/** Project a refresh failure through the same closed storage diagnostic contract as CodeGraphStoreError. */
export function anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure(failure: {
  readonly code: CodeGraphStoreFailureCode;
  readonly operation: 'refresh code graph';
  readonly recovery: CodeGraphStoreRecovery;
  readonly retryable: boolean;
}): AnonymousTelemetryDiagnostic {
  return (
    projectAnonymousTelemetryDiagnostic({
      code: failure.code,
      domain: 'code-graph-storage',
      errorType: 'CodeGraphStoreError',
      operation: 'refresh code graph',
      recovery: failure.recovery,
      retryable: failure.retryable,
    }) ?? Object.freeze({errorType: 'CodeGraphStoreError'})
  );
}

/**
 * Extract only the structured CodeGraphStoreError contract. ApplicationError
 * wrappers are followed, but arbitrary object properties are never traversed.
 */
export function anonymousTelemetryDiagnosticFromError(error: unknown): AnonymousTelemetryDiagnostic | undefined {
  try {
    let current = error;
    for (let depth = 0; depth <= MAXIMUM_CAUSE_DEPTH; depth += 1) {
      const attached = readAnonymousTelemetryDiagnostic(current);
      if (attached !== undefined) return attached;
      if (isCodeGraphStoreError(current)) {
        return projectAnonymousTelemetryDiagnostic({
          code: current.code,
          domain: 'code-graph-storage' as const,
          errorType: diagnosticErrorType(current),
          operation: current.operation,
          recovery: current.recovery,
          retryable: current.retryable,
        });
      }
      if (!Schema.is(ApplicationError)(current)) {
        return Object.freeze({errorType: directDiagnosticErrorType(current)});
      }
      current = current.cause;
    }
    return Object.freeze({errorType: directDiagnosticErrorType(error)});
  } catch {
    return Object.freeze({errorType: 'UnknownError'});
  }
}

export function attachAnonymousTelemetryError<A extends object>(value: A, error: unknown): A {
  return attachAnonymousTelemetryDiagnostic(value, anonymousTelemetryDiagnosticFromError(error));
}

function directDiagnosticErrorType(error: unknown): string {
  // Telemetry should report the stable outer tagged failure (for example
  // InsufficientMemory), not follow an arbitrary nested cause to the generic
  // Error that happens to carry its private message or stack.
  return closedTelemetryErrorType(diagnosticErrorType(error, Number.MAX_SAFE_INTEGER));
}

/** Free-form Error.name and _tag values never cross the anonymous boundary. */
export function closedTelemetryErrorType(value: string | undefined): string {
  return value !== undefined && SAFE_TELEMETRY_ERROR_TYPES.has(value) ? value : 'UnknownError';
}
