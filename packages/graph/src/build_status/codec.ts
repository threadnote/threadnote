import {Array as EffectArray} from 'effect';
import {Option, Schema} from 'effect';
import {isCodeGraphCapacityFailureOperation} from '../disk/capacity.js';
import {CODE_GRAPH_BUILD_PHASES as VALID_PHASES, parseCodeGraphBuildScheduling} from './scheduling.js';
import {
  CODE_GRAPH_BUILD_COMMIT_ID,
  CODE_GRAPH_BUILD_ID,
  CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION,
  isBuildStatusHash,
  isBuildStatusRecord,
  isBuildStatusText,
  isBuildStatusTimestamp,
} from './validation.js';
import {
  CODE_GRAPH_TOP_SLOW_FILE_LIMIT,
  isCodeGraphSourceSizeBucket,
  type CodeGraphScanningMetrics,
  type CodeGraphSlowFileTelemetry,
} from '../progress/telemetry.js';
import type {
  CodeGraphDiskCapacityFailureEvidence,
  CodeGraphMaterializationActivity,
  CodeGraphMaterializationMetrics,
  CodeGraphMaterializationRows,
  CodeGraphOverlayFallbackReason,
} from '../types.js';
import {CodeGraphDiskCapacityObservationError, CodeGraphDiskCapacityPressureError} from '../types.js';
import type {
  CodeGraphBuildActivation,
  CodeGraphBuildActivity,
  CodeGraphBuildCapacityFailure,
  CodeGraphBuildCounters,
  CodeGraphBuildError,
  CodeGraphBuildExtraction,
  CodeGraphBuildMaterialization,
  CodeGraphBuildRegistration,
  CodeGraphBuildResolution,
  CodeGraphBuildState,
  CodeGraphBuildStatus,
  CodeGraphBuildTimings,
} from '../build_status.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const BUILD_ID = CODE_GRAPH_BUILD_ID;
const COMMIT_ID = CODE_GRAPH_BUILD_COMMIT_ID;
const VALID_STATES = ['completed', 'failed', 'queued', 'running'] as const satisfies readonly CodeGraphBuildState[];
const VALID_MATERIALIZATION_FALLBACK_REASONS = [
  'cache-incomplete',
  'disabled',
  'dynamic-aliases',
  'extractor-context-changed',
  'fact-budget-expanded',
  'file-set-changed',
  'forced-full-rebuild',
  'incremental-rewrite-unbounded',
  'no-materialized-changes',
  'project-closure-incomplete',
  'project-closure-unbounded',
  'reexport-closure-unbounded',
  'resolution-surface-changed',
  'staging-identity-mismatch',
  'staging-unavailable',
  'workspace-changed',
] as const satisfies readonly CodeGraphOverlayFallbackReason[];

const isRecord = isBuildStatusRecord;
const isHash = isBuildStatusHash;
const isText = isBuildStatusText;
const isTimestamp = isBuildStatusTimestamp;

/** Privacy-safe, bounded terminal receipt shared with the isolated parent process. */
export function codeGraphBuildStatusError(cause: unknown): CodeGraphBuildError {
  const capacity = Schema.is(CodeGraphDiskCapacityPressureError)(cause)
    ? codeGraphBuildCapacityFailure(cause.code, cause.operation, cause.evidence)
    : Schema.is(CodeGraphDiskCapacityObservationError)(cause)
      ? codeGraphBuildCapacityFailure(cause.code, cause.operation, cause.evidence)
      : undefined;
  return {
    ...(capacity === undefined ? {} : {capacity}),
    summary: privacySafeBuildError(cause),
  };
}

function codeGraphBuildCapacityFailure(
  code: CodeGraphBuildCapacityFailure['code'],
  operation: string,
  evidence: CodeGraphDiskCapacityFailureEvidence | undefined,
): CodeGraphBuildCapacityFailure | undefined {
  if (evidence === undefined || !isCodeGraphCapacityFailureOperation(operation)) return undefined;
  return {code, evidence, operation};
}

function privacySafeBuildError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const sanitized =
    Effect.pipe(
      raw,
      EffectString.replaceAll(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"`<>]|\\ )+/g, '<local-path>'),
      EffectString.replaceAll(/\s+/g, ' '),
      EffectString.trim,
    ) || 'Code graph build failed.';
  return sanitized.length <= 300 ? sanitized : `${Effect.pipe(sanitized, EffectString.slice(0, 299))}…`;
}

export function parseCodeGraphBuildStatus(value: unknown): CodeGraphBuildStatus | undefined {
  if (!isRecord(value) || value.schemaVersion !== CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION) return undefined;
  if (!isText(value.buildId, 64) || !BUILD_ID.test(value.buildId)) return undefined;
  if (!isRecord(value.identity) || !isRecord(value.owner) || !isRecord(value.timestamps)) return undefined;
  const scopeId = value.identity.scopeId;
  if (
    !isHash(value.identity.repositoryId) ||
    !isHash(value.identity.checkoutId) ||
    !isHash(value.identity.worktreeId) ||
    (scopeId !== undefined && (typeof scopeId !== 'string' || !/^code-graph-scope:[0-9a-f]{64}$/u.test(scopeId))) ||
    !isText(value.identity.commit, 64) ||
    !COMMIT_ID.test(value.identity.commit) ||
    !Number.isSafeInteger(value.owner.processId) ||
    Number(value.owner.processId) <= 0 ||
    value.owner.runtime !== 'bun' ||
    !isText(value.owner.runtimeVersion, 64) ||
    !isOneOf(value.phase, VALID_PHASES) ||
    !isOneOf(value.state, VALID_STATES)
  ) {
    return undefined;
  }
  const timestamps = value.timestamps;
  if (
    !isTimestamp(timestamps.startedAt) ||
    !isTimestamp(timestamps.phaseStartedAt) ||
    !isTimestamp(timestamps.lastProgressAt) ||
    !isTimestamp(timestamps.heartbeatAt) ||
    !isTimestamp(timestamps.updatedAt) ||
    (timestamps.completedAt !== undefined && !isTimestamp(timestamps.completedAt))
  ) {
    return undefined;
  }
  const counters = parseCounters(value.counters);
  const scheduling = parseCodeGraphBuildScheduling(value.scheduling);
  if (value.scheduling !== undefined && !scheduling) return undefined;
  if (!counters) return undefined;
  const activity = parseActivity(value.activity);
  if (value.activity !== undefined && !activity) return undefined;
  const activation = parseActivation(value.activation);
  if (value.activation !== undefined && !activation) return undefined;
  const timings = parseTimings(value.timings);
  if (value.timings !== undefined && !timings) return undefined;
  const materialization = parseMaterialization(value.materialization);
  if (value.materialization !== undefined && !materialization) return undefined;
  const registration = parseRegistration(value.registration);
  if (value.registration !== undefined && !registration) return undefined;
  const ownerStart = value.owner.processStartIdentity;
  if (ownerStart !== undefined && !isText(ownerStart, 256)) return undefined;
  const subphase = value.subphase;
  if (subphase !== undefined && !isText(subphase, 64)) return undefined;
  if (value.worktreeLockHeld !== undefined && typeof value.worktreeLockHeld !== 'boolean') return undefined;
  const error = parseError(value.error);
  if (value.error !== undefined && !error) return undefined;
  const eta = parseEta(value.eta);
  if (value.eta !== undefined && !eta) return undefined;
  const extraction = parseExtraction(value.extraction);
  if (value.extraction !== undefined && !extraction) return undefined;
  const result = parseResult(value.result);
  if (value.result !== undefined && !result) return undefined;
  const request = parseRequest(value.request);
  if (value.request !== undefined && !request) return undefined;
  const resolution = parseResolution(value.resolution);
  if (value.resolution !== undefined && !resolution) return undefined;
  const displayName = value.identity.displayName;
  if (displayName !== undefined && !isText(displayName, 256)) return undefined;
  return {
    ...(activation ? {activation} : {}),
    ...(activity ? {activity} : {}),
    buildId: value.buildId,
    counters,
    ...(error ? {error} : {}),
    ...(eta ? {eta} : {}),
    ...(extraction ? {extraction} : {}),
    identity: {
      checkoutId: value.identity.checkoutId,
      commit: value.identity.commit,
      ...(displayName ? {displayName} : {}),
      repositoryId: value.identity.repositoryId,
      ...(scopeId === undefined ? {} : {scopeId}),
      worktreeId: value.identity.worktreeId,
    },
    ...(materialization ? {materialization} : {}),
    ...(registration ? {registration} : {}),
    owner: {
      processId: Number(value.owner.processId),
      ...(ownerStart ? {processStartIdentity: ownerStart} : {}),
      runtime: 'bun',
      runtimeVersion: value.owner.runtimeVersion,
    },
    phase: value.phase,
    ...(request ? {request} : {}),
    ...(resolution ? {resolution} : {}),
    ...(result ? {result} : {}),
    schemaVersion: CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION,
    ...(scheduling ? {scheduling} : {}),
    state: value.state,
    ...(subphase ? {subphase} : {}),
    ...(timings ? {timings} : {}),
    ...(value.worktreeLockHeld !== undefined ? {worktreeLockHeld: value.worktreeLockHeld} : {}),
    timestamps: {
      ...(timestamps.completedAt ? {completedAt: timestamps.completedAt} : {}),
      heartbeatAt: timestamps.heartbeatAt,
      lastProgressAt: timestamps.lastProgressAt,
      phaseStartedAt: timestamps.phaseStartedAt,
      startedAt: timestamps.startedAt,
      updatedAt: timestamps.updatedAt,
    },
  };
}

function parseRegistration(value: unknown): CodeGraphBuildRegistration | undefined {
  if (!isRecord(value) || !isRecord(value.activity)) return undefined;
  const activity = value.activity;
  if (
    activity.stage !== 'loading-cache' ||
    !isNonNegativeFinite(activity.elapsedMilliseconds) ||
    !Number.isSafeInteger(activity.generations) ||
    Number(activity.generations) < 0 ||
    !Number.isSafeInteger(activity.keys) ||
    Number(activity.keys) < 0
  ) {
    return undefined;
  }
  return {
    activity: {
      elapsedMilliseconds: Number(activity.elapsedMilliseconds),
      generations: Number(activity.generations),
      keys: Number(activity.keys),
      stage: 'loading-cache',
    },
  };
}

function parseActivation(value: unknown): CodeGraphBuildActivation | undefined {
  if (!isRecord(value)) return undefined;
  const activity = parseActivationActivity(value.activity);
  return activity ? {activity} : undefined;
}

function parseActivationActivity(value: unknown): CodeGraphBuildActivation['activity'] | undefined {
  const stage = oneOf(value, 'stage', [
    'checkpointing-snapshot',
    'committing-snapshot',
    'copying-edges',
    'copying-files',
    'copying-lookup-keys',
    'copying-reexports',
    'copying-symbols',
    'copying-terms',
    'copying-workspace',
    'recording-completion',
    'validating-input',
  ]);
  const state = oneOf(value, 'state', ['completed', 'progress', 'started']);
  if (
    !isRecord(value) ||
    stage === undefined ||
    state === undefined ||
    !isNonNegativeFinite(value.elapsedMilliseconds) ||
    !isNonNegativeFinite(value.stageElapsedMilliseconds) ||
    !isTimestamp(value.startedAt)
  ) {
    return undefined;
  }
  if (value.rows !== undefined && !isNonNegativeSafeInteger(value.rows)) return undefined;
  if (value.transactionMilliseconds !== undefined && !isNonNegativeFinite(value.transactionMilliseconds)) {
    return undefined;
  }
  return {
    elapsedMilliseconds: Number(value.elapsedMilliseconds),
    ...(value.rows === undefined ? {} : {rows: Number(value.rows)}),
    stage,
    stageElapsedMilliseconds: Number(value.stageElapsedMilliseconds),
    startedAt: value.startedAt,
    state,
    ...(value.transactionMilliseconds === undefined
      ? {}
      : {transactionMilliseconds: Number(value.transactionMilliseconds)}),
  };
}

function parseResolution(value: unknown): CodeGraphBuildResolution | undefined {
  if (!isRecord(value)) return undefined;
  const activity = parseResolutionActivity(value.activity);
  return activity ? {activity} : undefined;
}

function parseResolutionActivity(value: unknown): CodeGraphBuildResolution['activity'] | undefined {
  if (!isRecord(value) || !isTimestamp(value.startedAt)) return undefined;
  const transactionStageMilliseconds = parseResolutionTransactionStageMilliseconds(value.transactionStageMilliseconds);
  if (value.transactionStageMilliseconds !== undefined && transactionStageMilliseconds === undefined) return undefined;
  if (
    value.longestTransactionMilliseconds !== undefined &&
    !isNonNegativeFinite(value.longestTransactionMilliseconds)
  ) {
    return undefined;
  }
  for (const key of [
    'aliasesDiscovered',
    'pageCompleted',
    'pageTotal',
    'pagesCompleted',
    'pass',
    'referencesCompleted',
    'referencesExamined',
    'referencesTotal',
    'resolved',
  ] as const) {
    if (!isNonNegativeSafeInteger(value[key])) return undefined;
  }
  for (const key of ['elapsedMilliseconds', 'matchingMilliseconds', 'transactionMilliseconds'] as const) {
    if (!isNonNegativeFinite(value[key])) return undefined;
  }
  if (
    Number(value.pass) < 1 ||
    Number(value.pageCompleted) > Number(value.pageTotal) ||
    Number(value.referencesCompleted) > Number(value.referencesTotal) ||
    Number(value.pageCompleted) > Number(value.pagesCompleted) ||
    Number(value.resolved) > Number(value.referencesExamined)
  ) {
    return undefined;
  }
  return {
    aliasesDiscovered: Number(value.aliasesDiscovered),
    elapsedMilliseconds: Number(value.elapsedMilliseconds),
    ...(value.longestTransactionMilliseconds === undefined
      ? {}
      : {longestTransactionMilliseconds: Number(value.longestTransactionMilliseconds)}),
    matchingMilliseconds: Number(value.matchingMilliseconds),
    pageCompleted: Number(value.pageCompleted),
    pageTotal: Number(value.pageTotal),
    pagesCompleted: Number(value.pagesCompleted),
    pass: Number(value.pass),
    referencesCompleted: Number(value.referencesCompleted),
    referencesExamined: Number(value.referencesExamined),
    referencesTotal: Number(value.referencesTotal),
    resolved: Number(value.resolved),
    startedAt: value.startedAt,
    transactionMilliseconds: Number(value.transactionMilliseconds),
    ...(transactionStageMilliseconds === undefined ? {} : {transactionStageMilliseconds}),
  };
}

function parseResolutionTransactionStageMilliseconds(value: unknown) {
  if (!isRecord(value)) return undefined;
  for (const key of [
    'preparingBatch',
    'retiringReferences',
    'updatingAnalysis',
    'writingAliases',
    'writingEdges',
  ] as const) {
    if (!isNonNegativeFinite(value[key])) return undefined;
  }
  return {
    preparingBatch: Number(value.preparingBatch),
    retiringReferences: Number(value.retiringReferences),
    updatingAnalysis: Number(value.updatingAnalysis),
    writingAliases: Number(value.writingAliases),
    writingEdges: Number(value.writingEdges),
  };
}

function parseMaterialization(value: unknown): CodeGraphBuildMaterialization | undefined {
  if (!isRecord(value)) return undefined;
  const activity = parseMaterializationActivity(value.activity);
  if (value.activity !== undefined && !activity) return undefined;
  const metrics = parseMaterializationMetrics(value.metrics);
  if (value.metrics !== undefined && !metrics) return undefined;
  if (!activity && !metrics) return undefined;
  return {...(activity ? {activity} : {}), ...(metrics ? {metrics} : {})};
}

function parseMaterializationActivity(value: unknown): CodeGraphBuildMaterialization['activity'] | undefined {
  const stage = oneOf(value, 'stage', [
    'attributing',
    'committing',
    'loading-cache',
    'preparing-rows',
    'restoring-indexes',
    'writing-analysis',
    'writing-candidates',
    'writing-edges',
    'writing-facts',
    'writing-lookups',
    'writing-receipt',
    'writing-references',
    'writing-symbols',
    'writing-terms',
  ]);
  if (
    !isRecord(value) ||
    !isBatchProgress(value.batchCompleted, value.batchTotal) ||
    !Number.isSafeInteger(value.sourceBytes) ||
    Number(value.sourceBytes) < 0 ||
    stage === undefined ||
    !isTimestamp(value.startedAt)
  ) {
    return undefined;
  }
  if (value.cachedFactBytes !== undefined && !isNonNegativeSafeInteger(value.cachedFactBytes)) return undefined;
  if (value.elapsedMilliseconds !== undefined && !isNonNegativeFinite(value.elapsedMilliseconds)) return undefined;
  if (value.factsBytes !== undefined && !isNonNegativeSafeInteger(value.factsBytes)) return undefined;
  if (value.stageElapsedMilliseconds !== undefined && !isNonNegativeFinite(value.stageElapsedMilliseconds)) {
    return undefined;
  }
  if (value.transactionMilliseconds !== undefined && !isNonNegativeFinite(value.transactionMilliseconds)) {
    return undefined;
  }
  const rows = parseMaterializationRows(value.rows);
  if (value.rows !== undefined && !rows) return undefined;
  return {
    batchCompleted: Number(value.batchCompleted),
    batchTotal: Number(value.batchTotal),
    ...(value.cachedFactBytes === undefined ? {} : {cachedFactBytes: Number(value.cachedFactBytes)}),
    ...(value.elapsedMilliseconds === undefined ? {} : {elapsedMilliseconds: Number(value.elapsedMilliseconds)}),
    ...(value.factsBytes === undefined ? {} : {factsBytes: Number(value.factsBytes)}),
    ...(rows ? {rows} : {}),
    sourceBytes: Number(value.sourceBytes),
    stage,
    ...(value.stageElapsedMilliseconds === undefined
      ? {}
      : {stageElapsedMilliseconds: Number(value.stageElapsedMilliseconds)}),
    startedAt: value.startedAt,
    ...(value.transactionMilliseconds === undefined
      ? {}
      : {transactionMilliseconds: Number(value.transactionMilliseconds)}),
  };
}

function parseMaterializationMetrics(value: unknown): CodeGraphMaterializationMetrics | undefined {
  if (
    !isRecord(value) ||
    !isBatchProgress(value.batchesCompleted, value.batchesTotal) ||
    !isNonNegativeSafeInteger(value.sourceBytesCompleted) ||
    !isNonNegativeSafeInteger(value.sourceBytesTotal) ||
    Number(value.sourceBytesCompleted) > Number(value.sourceBytesTotal)
  ) {
    return undefined;
  }
  const fallbackReason =
    value.fallbackReason === undefined
      ? undefined
      : isOneOf(value.fallbackReason, VALID_MATERIALIZATION_FALLBACK_REASONS)
        ? value.fallbackReason
        : undefined;
  if (value.fallbackReason !== undefined && fallbackReason === undefined) return undefined;
  const fallbackAssessment = parseOverlayFallbackAssessment(value.fallbackAssessment);
  if (value.fallbackAssessment !== undefined && fallbackAssessment === undefined) return undefined;
  if (fallbackAssessment !== undefined && fallbackReason !== 'project-closure-incomplete') return undefined;
  const fallbackBoundary = parseOverlayFallbackBoundary(value.fallbackBoundary);
  if (value.fallbackBoundary !== undefined && fallbackBoundary === undefined) return undefined;
  if (fallbackBoundary !== undefined && fallbackReason !== 'project-closure-unbounded') return undefined;
  const mode = oneOf(value, 'mode', ['full', 'incremental-clean', 'incremental-overlay']);
  if (value.mode !== undefined && mode === undefined) return undefined;
  const resolutionPublicationGate = oneOf(value, 'resolutionPublicationGate', [
    'exported',
    'foreign-path',
    'non-typescript-domain',
    'own-path-local',
    'scope-mismatch',
    'unknown-lookup-form',
  ]);
  if (value.resolutionPublicationGate !== undefined && resolutionPublicationGate === undefined) return undefined;
  const resolutionLookupKeyForm = oneOf(value, 'resolutionLookupKeyForm', [
    'none',
    'non-typescript',
    'typescript-other',
    'typescript-path-scoped',
    'typescript-path-unscoped',
  ]);
  if (value.resolutionLookupKeyForm !== undefined && resolutionLookupKeyForm === undefined) return undefined;
  for (const key of [
    'attributedFilesCompleted',
    'cachedFactBytesCompleted',
    'cachedFactBytesTotal',
    'cachedFactReplayBytesCompleted',
    'changedFactBytesCompleted',
    'crossGenerationShardFilesCompleted',
    'exactGenerationShardFilesCompleted',
    'factsBytesCompleted',
    'factsBytesTotal',
    'materializedShardCacheDeferredFilesCompleted',
    'materializedShardCacheDeferredRawFactBytesCompleted',
    'materializedShardReplayBytesCompleted',
    'rawFactReplayBytesCompleted',
  ] as const) {
    if (value[key] !== undefined && !isNonNegativeSafeInteger(value[key])) return undefined;
  }
  const hasReplaySplit =
    value.materializedShardReplayBytesCompleted !== undefined || value.rawFactReplayBytesCompleted !== undefined;
  if (
    hasReplaySplit &&
    (value.cachedFactReplayBytesCompleted === undefined ||
      value.materializedShardReplayBytesCompleted === undefined ||
      value.rawFactReplayBytesCompleted === undefined ||
      Number(value.cachedFactReplayBytesCompleted) !==
        Math.min(
          Number.MAX_SAFE_INTEGER,
          Number(value.materializedShardReplayBytesCompleted) + Number(value.rawFactReplayBytesCompleted),
        ))
  ) {
    return undefined;
  }
  if (
    value.cachedFactBytesCompleted !== undefined &&
    value.cachedFactBytesTotal !== undefined &&
    Number(value.cachedFactBytesCompleted) > Number(value.cachedFactBytesTotal)
  ) {
    return undefined;
  }
  if (
    value.factsBytesCompleted !== undefined &&
    value.factsBytesTotal !== undefined &&
    Number(value.factsBytesCompleted) > Number(value.factsBytesTotal)
  ) {
    return undefined;
  }
  const hasDeferredShardCache =
    value.materializedShardCacheDeferredFilesCompleted !== undefined ||
    value.materializedShardCacheDeferredRawFactBytesCompleted !== undefined;
  if (
    hasDeferredShardCache &&
    (value.materializedShardCacheDeferredFilesCompleted === undefined ||
      value.materializedShardCacheDeferredRawFactBytesCompleted === undefined ||
      value.attributedFilesCompleted === undefined ||
      value.rawFactReplayBytesCompleted === undefined ||
      Number(value.materializedShardCacheDeferredFilesCompleted) > Number(value.attributedFilesCompleted) ||
      Number(value.materializedShardCacheDeferredRawFactBytesCompleted) > Number(value.rawFactReplayBytesCompleted))
  ) {
    return undefined;
  }
  for (const key of ['attributionMilliseconds', 'loadingMilliseconds', 'transactionMilliseconds'] as const) {
    if (value[key] !== undefined && !isNonNegativeFinite(value[key])) return undefined;
  }
  const rows = parseMaterializationRows(value.rows);
  if (value.rows !== undefined && !rows) return undefined;
  const stageMilliseconds = parseMaterializationStageMilliseconds(value.stageMilliseconds);
  if (value.stageMilliseconds !== undefined && !stageMilliseconds) return undefined;
  const subphaseMilliseconds = parseMaterializationSubphaseMilliseconds(value.subphaseMilliseconds);
  if (value.subphaseMilliseconds !== undefined && !subphaseMilliseconds) return undefined;
  const storage = parseMaterializationStorage(value.storage);
  if (value.storage !== undefined && !storage) return undefined;
  if (storage?.estimateBasis === 'cached-fact-bytes' && value.cachedFactBytesTotal === undefined) return undefined;
  if (storage?.estimateBasis === 'final-fact-bytes' && value.factsBytesTotal === undefined) return undefined;
  return {
    ...(value.attributedFilesCompleted === undefined
      ? {}
      : {attributedFilesCompleted: Number(value.attributedFilesCompleted)}),
    ...(fallbackReason === undefined ? {} : {fallbackReason}),
    ...(fallbackAssessment === undefined ? {} : {fallbackAssessment}),
    ...(fallbackBoundary === undefined ? {} : {fallbackBoundary}),
    ...(resolutionLookupKeyForm === undefined ? {} : {resolutionLookupKeyForm}),
    ...(resolutionPublicationGate === undefined ? {} : {resolutionPublicationGate}),
    ...(value.attributionMilliseconds === undefined
      ? {}
      : {attributionMilliseconds: Number(value.attributionMilliseconds)}),
    batchesCompleted: Number(value.batchesCompleted),
    batchesTotal: Number(value.batchesTotal),
    ...(value.cachedFactBytesCompleted === undefined
      ? {}
      : {cachedFactBytesCompleted: Number(value.cachedFactBytesCompleted)}),
    ...(value.cachedFactBytesTotal === undefined ? {} : {cachedFactBytesTotal: Number(value.cachedFactBytesTotal)}),
    ...(value.cachedFactReplayBytesCompleted === undefined
      ? {}
      : {cachedFactReplayBytesCompleted: Number(value.cachedFactReplayBytesCompleted)}),
    ...(value.changedFactBytesCompleted === undefined
      ? {}
      : {changedFactBytesCompleted: Number(value.changedFactBytesCompleted)}),
    ...(value.crossGenerationShardFilesCompleted === undefined
      ? {}
      : {crossGenerationShardFilesCompleted: Number(value.crossGenerationShardFilesCompleted)}),
    ...(value.exactGenerationShardFilesCompleted === undefined
      ? {}
      : {exactGenerationShardFilesCompleted: Number(value.exactGenerationShardFilesCompleted)}),
    ...(value.factsBytesCompleted === undefined ? {} : {factsBytesCompleted: Number(value.factsBytesCompleted)}),
    ...(value.factsBytesTotal === undefined ? {} : {factsBytesTotal: Number(value.factsBytesTotal)}),
    ...(value.loadingMilliseconds === undefined ? {} : {loadingMilliseconds: Number(value.loadingMilliseconds)}),
    ...(value.materializedShardReplayBytesCompleted === undefined
      ? {}
      : {materializedShardReplayBytesCompleted: Number(value.materializedShardReplayBytesCompleted)}),
    ...(value.materializedShardCacheDeferredFilesCompleted === undefined
      ? {}
      : {materializedShardCacheDeferredFilesCompleted: Number(value.materializedShardCacheDeferredFilesCompleted)}),
    ...(value.materializedShardCacheDeferredRawFactBytesCompleted === undefined
      ? {}
      : {
          materializedShardCacheDeferredRawFactBytesCompleted: Number(
            value.materializedShardCacheDeferredRawFactBytesCompleted,
          ),
        }),
    ...(mode === undefined ? {} : {mode}),
    ...(value.rawFactReplayBytesCompleted === undefined
      ? {}
      : {rawFactReplayBytesCompleted: Number(value.rawFactReplayBytesCompleted)}),
    ...(rows ? {rows} : {}),
    sourceBytesCompleted: Number(value.sourceBytesCompleted),
    sourceBytesTotal: Number(value.sourceBytesTotal),
    ...(stageMilliseconds ? {stageMilliseconds} : {}),
    ...(subphaseMilliseconds ? {subphaseMilliseconds} : {}),
    ...(storage ? {storage} : {}),
    ...(value.transactionMilliseconds === undefined
      ? {}
      : {transactionMilliseconds: Number(value.transactionMilliseconds)}),
  };
}

const isStringArray = (value: unknown): value is readonly string[] =>
  EffectArray.isArray(value) && EffectArray.every(value, (item): item is string => typeof item === 'string');

function parseOverlayFallbackAssessment(
  value: unknown,
): CodeGraphMaterializationMetrics['fallbackAssessment'] | undefined {
  const detail = oneOf(value, 'detail', [
    'dependency-model-incomplete',
    'duplicate-project-identity',
    'no-project-seeds',
    'path-owner-ambiguous',
    'path-unowned',
    'project-model-incomplete',
    'project-not-stable',
    'resolution-domain-unowned',
  ]);
  if (
    !isRecord(value) ||
    value.stage !== 'file-set-seed-assessment' ||
    detail === undefined ||
    !isNonNegativeSafeInteger(value.changedFiles) ||
    !isNonNegativeSafeInteger(value.addedFiles) ||
    !isNonNegativeSafeInteger(value.deletedFiles) ||
    Number(value.addedFiles) > Number(value.changedFiles)
  ) {
    return undefined;
  }
  const unownedResolutionDomainsValue = value.unownedResolutionDomains;
  const unownedResolutionDomains =
    unownedResolutionDomainsValue === undefined
      ? undefined
      : isStringArray(unownedResolutionDomainsValue) &&
          EffectArray.every(unownedResolutionDomainsValue, domain => domain.length > 0) &&
          new Set(unownedResolutionDomainsValue).size === unownedResolutionDomainsValue.length
        ? [...unownedResolutionDomainsValue].sort()
        : undefined;
  if (value.unownedResolutionDomains !== undefined && unownedResolutionDomains === undefined) return undefined;
  const unownedResolutionDomainFiles =
    value.unownedResolutionDomainFiles === undefined
      ? undefined
      : isNonNegativeSafeInteger(value.unownedResolutionDomainFiles)
        ? Number(value.unownedResolutionDomainFiles)
        : undefined;
  if (
    value.unownedResolutionDomainFiles !== undefined &&
    (unownedResolutionDomainFiles === undefined || unownedResolutionDomains === undefined)
  ) {
    return undefined;
  }
  return {
    addedFiles: Number(value.addedFiles),
    changedFiles: Number(value.changedFiles),
    deletedFiles: Number(value.deletedFiles),
    detail,
    stage: 'file-set-seed-assessment',
    ...(unownedResolutionDomains === undefined ? {} : {unownedResolutionDomains}),
    ...(unownedResolutionDomainFiles === undefined ? {} : {unownedResolutionDomainFiles}),
  };
}

function parseOverlayFallbackBoundary(value: unknown): CodeGraphMaterializationMetrics['fallbackBoundary'] | undefined {
  if (!isRecord(value)) return undefined;
  const pair = parseOverlayFallbackBoundaryPair(value.stage, value.metric);
  if (
    pair === undefined ||
    !isNonNegativeSafeInteger(value.changedFiles) ||
    !isNonNegativeSafeInteger(value.limit) ||
    !isNonNegativeSafeInteger(value.observedAtDecision) ||
    Number(value.observedAtDecision) <= Number(value.limit)
  ) {
    return undefined;
  }
  return {
    changedFiles: Number(value.changedFiles),
    limit: Number(value.limit),
    observedAtDecision: Number(value.observedAtDecision),
    ...pair,
  };
}

type OverlayFallbackBoundaryPair =
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
    };

function parseOverlayFallbackBoundaryPair(stage: unknown, metric: unknown): OverlayFallbackBoundaryPair | undefined {
  if (typeof stage !== 'string') return undefined;
  if (stage === 'project-closure-selection') {
    const parsedMetric = oneOfValue(metric, ['affected-files', 'cached-fact-bytes', 'source-bytes']);
    return parsedMetric === undefined ? undefined : {metric: parsedMetric, stage};
  }
  if (stage === 'resolution-candidate-scan') {
    const parsedMetric = oneOfValue(metric, [
      'candidate-lookup-keys',
      'candidate-projection-associations',
      'candidate-projection-file-associations',
      'candidate-projection-observations',
      'candidate-projection-observed-key-bytes',
      'candidate-reexport-key-bytes',
      'candidate-reexport-lookup-keys',
      'candidate-reexports',
      'candidate-scan-fact-bytes',
      'candidate-scan-files',
      'candidate-selected-files',
    ]);
    return parsedMetric === undefined ? undefined : {metric: parsedMetric, stage};
  }
  if (stage !== 'resolution-candidate-rewrite') return undefined;
  const parsedMetric = oneOfValue(metric, ['cached-fact-bytes', 'candidate-selected-files', 'source-bytes']);
  return parsedMetric === undefined ? undefined : {metric: parsedMetric, stage};
}

function parseMaterializationSubphaseMilliseconds(
  value: unknown,
): CodeGraphMaterializationMetrics['subphaseMilliseconds'] | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
    'attributionCompute',
    'factBatchPreparation',
    'shardAssociation',
    'shardPersistence',
    'shardSerialization',
  ] as const;
  if (
    EffectRecord.keys(value).length !== keys.length ||
    EffectArray.some(keys, key => !isNonNegativeFinite(value[key]))
  ) {
    return undefined;
  }
  return {
    attributionCompute: Number(value.attributionCompute),
    factBatchPreparation: Number(value.factBatchPreparation),
    shardAssociation: Number(value.shardAssociation),
    shardPersistence: Number(value.shardPersistence),
    shardSerialization: Number(value.shardSerialization),
  };
}

function parseMaterializationStageMilliseconds(
  value: unknown,
): CodeGraphMaterializationMetrics['stageMilliseconds'] | undefined {
  if (!isRecord(value)) return undefined;
  const stages = [
    'attributing',
    'committing',
    'loading-cache',
    'preparing-rows',
    'restoring-indexes',
    'writing-analysis',
    'writing-candidates',
    'writing-edges',
    'writing-facts',
    'writing-lookups',
    'writing-receipt',
    'writing-references',
    'writing-symbols',
    'writing-terms',
  ] as const satisfies readonly CodeGraphMaterializationActivity['stage'][];
  const allowed = new Set<string>(stages);
  const parsed: Partial<Record<CodeGraphMaterializationActivity['stage'], number>> = {};
  for (const [stage, milliseconds] of EffectRecord.toEntries(value)) {
    if (!allowed.has(stage) || !isNonNegativeFinite(milliseconds)) return undefined;
    const parsedStage = oneOfValue(stage, stages);
    if (parsedStage === undefined) return undefined;
    parsed[parsedStage] = Number(milliseconds);
  }
  return parsed;
}

function parseMaterializationStorage(
  value: unknown,
): NonNullable<CodeGraphMaterializationMetrics['storage']> | undefined {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.temporaryDatabaseBytes) ||
    !isNonNegativeSafeInteger(value.temporaryDatabaseHighWaterBytes) ||
    Number(value.temporaryDatabaseBytes) > Number(value.temporaryDatabaseHighWaterBytes)
  ) {
    return undefined;
  }
  const decisionLayer = oneOf(value, 'decisionLayer', ['whole-build-heuristic']);
  const enforcement = oneOf(value, 'enforcement', ['advisory']);
  if (value.decisionLayer !== undefined && decisionLayer === undefined) return undefined;
  if (value.enforcement !== undefined && enforcement === undefined) return undefined;
  if (
    value.modelVersion !== undefined &&
    (!isNonNegativeSafeInteger(value.modelVersion) || Number(value.modelVersion) < 1)
  ) {
    return undefined;
  }
  const estimateBasis = oneOf(value, 'estimateBasis', [
    'cached-fact-bytes',
    'final-fact-bytes',
    'source-bytes-fallback',
  ]);
  if (value.estimateBasis !== undefined && estimateBasis === undefined) return undefined;
  for (const key of [
    'availableBytes',
    'durableAvailableBytes',
    'durableDatabaseBytes',
    'durableDatabaseFileBytes',
    'durableDatabaseFileHighWaterBytes',
    'durableDatabaseGrowthBytes',
    'durableDatabaseGrowthHighWaterBytes',
    'durableDatabaseHighWaterBytes',
    'durableDatabaseStartBytes',
    'durableFilesystemBytes',
    'durableFilesystemHighWaterBytes',
    'durableJournalBytes',
    'durableJournalHighWaterBytes',
    'durableSharedMemoryBytes',
    'durableSharedMemoryHighWaterBytes',
    'durableSidecarDatabaseBytes',
    'durableSidecarDatabaseHighWaterBytes',
    'durableSidecarJournalBytes',
    'durableSidecarJournalHighWaterBytes',
    'durableSidecarWalBytes',
    'durableSidecarWalHighWaterBytes',
    'durableWalBytes',
    'durableWalHighWaterBytes',
    'estimatedConcurrentBuildBytes',
    'estimatedDurableFilesystemRequiredBytes',
    'estimatedDurableSnapshotBytes',
    'estimatedJournalBytes',
    'estimatedRequiredBytes',
    'estimatedTemporaryFilesystemRequiredBytes',
    'estimatedTemporaryDatabaseBytes',
    'temporaryAvailableBytes',
  ] as const) {
    if (value[key] !== undefined && !isNonNegativeSafeInteger(value[key])) return undefined;
  }
  if (value.filesystemsShared !== undefined && typeof value.filesystemsShared !== 'boolean') return undefined;
  const materializationMode = oneOf(value, 'materializationMode', ['direct-persistent', 'temporary-staged']);
  if (value.materializationMode !== undefined && materializationMode === undefined) return undefined;
  for (const [current, highWater] of [
    ['durableDatabaseFileBytes', 'durableDatabaseFileHighWaterBytes'],
    ['durableDatabaseGrowthBytes', 'durableDatabaseGrowthHighWaterBytes'],
    ['durableFilesystemBytes', 'durableFilesystemHighWaterBytes'],
    ['durableJournalBytes', 'durableJournalHighWaterBytes'],
    ['durableSharedMemoryBytes', 'durableSharedMemoryHighWaterBytes'],
    ['durableSidecarDatabaseBytes', 'durableSidecarDatabaseHighWaterBytes'],
    ['durableSidecarJournalBytes', 'durableSidecarJournalHighWaterBytes'],
    ['durableSidecarWalBytes', 'durableSidecarWalHighWaterBytes'],
    ['durableWalBytes', 'durableWalHighWaterBytes'],
  ] as const) {
    if (
      value[current] !== undefined &&
      value[highWater] !== undefined &&
      Number(value[current]) > Number(value[highWater])
    ) {
      return undefined;
    }
  }
  if (
    value.durableDatabaseBytes !== undefined &&
    value.durableDatabaseHighWaterBytes !== undefined &&
    Number(value.durableDatabaseBytes) > Number(value.durableDatabaseHighWaterBytes)
  ) {
    return undefined;
  }
  if (
    value.estimatedRequiredBytes !== undefined &&
    value.estimatedConcurrentBuildBytes !== undefined &&
    Number(value.estimatedRequiredBytes) < Number(value.estimatedConcurrentBuildBytes)
  ) {
    return undefined;
  }
  return {
    ...(decisionLayer === undefined ? {} : {decisionLayer}),
    ...(enforcement === undefined ? {} : {enforcement}),
    ...(value.modelVersion === undefined ? {} : {modelVersion: Number(value.modelVersion)}),
    ...(value.availableBytes === undefined ? {} : {availableBytes: Number(value.availableBytes)}),
    ...(value.durableAvailableBytes === undefined ? {} : {durableAvailableBytes: Number(value.durableAvailableBytes)}),
    ...(value.durableDatabaseBytes === undefined ? {} : {durableDatabaseBytes: Number(value.durableDatabaseBytes)}),
    ...(value.durableDatabaseFileBytes === undefined
      ? {}
      : {durableDatabaseFileBytes: Number(value.durableDatabaseFileBytes)}),
    ...(value.durableDatabaseFileHighWaterBytes === undefined
      ? {}
      : {durableDatabaseFileHighWaterBytes: Number(value.durableDatabaseFileHighWaterBytes)}),
    ...(value.durableDatabaseGrowthBytes === undefined
      ? {}
      : {durableDatabaseGrowthBytes: Number(value.durableDatabaseGrowthBytes)}),
    ...(value.durableDatabaseGrowthHighWaterBytes === undefined
      ? {}
      : {durableDatabaseGrowthHighWaterBytes: Number(value.durableDatabaseGrowthHighWaterBytes)}),
    ...(value.durableDatabaseHighWaterBytes === undefined
      ? {}
      : {durableDatabaseHighWaterBytes: Number(value.durableDatabaseHighWaterBytes)}),
    ...(value.durableDatabaseStartBytes === undefined
      ? {}
      : {durableDatabaseStartBytes: Number(value.durableDatabaseStartBytes)}),
    ...(value.durableFilesystemBytes === undefined
      ? {}
      : {durableFilesystemBytes: Number(value.durableFilesystemBytes)}),
    ...(value.durableFilesystemHighWaterBytes === undefined
      ? {}
      : {durableFilesystemHighWaterBytes: Number(value.durableFilesystemHighWaterBytes)}),
    ...(value.durableJournalBytes === undefined ? {} : {durableJournalBytes: Number(value.durableJournalBytes)}),
    ...(value.durableJournalHighWaterBytes === undefined
      ? {}
      : {durableJournalHighWaterBytes: Number(value.durableJournalHighWaterBytes)}),
    ...(value.durableSharedMemoryBytes === undefined
      ? {}
      : {durableSharedMemoryBytes: Number(value.durableSharedMemoryBytes)}),
    ...(value.durableSharedMemoryHighWaterBytes === undefined
      ? {}
      : {durableSharedMemoryHighWaterBytes: Number(value.durableSharedMemoryHighWaterBytes)}),
    ...(value.durableSidecarDatabaseBytes === undefined
      ? {}
      : {durableSidecarDatabaseBytes: Number(value.durableSidecarDatabaseBytes)}),
    ...(value.durableSidecarDatabaseHighWaterBytes === undefined
      ? {}
      : {durableSidecarDatabaseHighWaterBytes: Number(value.durableSidecarDatabaseHighWaterBytes)}),
    ...(value.durableSidecarJournalBytes === undefined
      ? {}
      : {durableSidecarJournalBytes: Number(value.durableSidecarJournalBytes)}),
    ...(value.durableSidecarJournalHighWaterBytes === undefined
      ? {}
      : {durableSidecarJournalHighWaterBytes: Number(value.durableSidecarJournalHighWaterBytes)}),
    ...(value.durableSidecarWalBytes === undefined
      ? {}
      : {durableSidecarWalBytes: Number(value.durableSidecarWalBytes)}),
    ...(value.durableSidecarWalHighWaterBytes === undefined
      ? {}
      : {durableSidecarWalHighWaterBytes: Number(value.durableSidecarWalHighWaterBytes)}),
    ...(value.durableWalBytes === undefined ? {} : {durableWalBytes: Number(value.durableWalBytes)}),
    ...(value.durableWalHighWaterBytes === undefined
      ? {}
      : {durableWalHighWaterBytes: Number(value.durableWalHighWaterBytes)}),
    ...(estimateBasis === undefined ? {} : {estimateBasis}),
    ...(value.estimatedConcurrentBuildBytes === undefined
      ? {}
      : {estimatedConcurrentBuildBytes: Number(value.estimatedConcurrentBuildBytes)}),
    ...(value.estimatedDurableFilesystemRequiredBytes === undefined
      ? {}
      : {estimatedDurableFilesystemRequiredBytes: Number(value.estimatedDurableFilesystemRequiredBytes)}),
    ...(value.estimatedDurableSnapshotBytes === undefined
      ? {}
      : {estimatedDurableSnapshotBytes: Number(value.estimatedDurableSnapshotBytes)}),
    ...(value.estimatedJournalBytes === undefined ? {} : {estimatedJournalBytes: Number(value.estimatedJournalBytes)}),
    ...(value.estimatedRequiredBytes === undefined
      ? {}
      : {estimatedRequiredBytes: Number(value.estimatedRequiredBytes)}),
    ...(value.estimatedTemporaryFilesystemRequiredBytes === undefined
      ? {}
      : {estimatedTemporaryFilesystemRequiredBytes: Number(value.estimatedTemporaryFilesystemRequiredBytes)}),
    ...(value.estimatedTemporaryDatabaseBytes === undefined
      ? {}
      : {estimatedTemporaryDatabaseBytes: Number(value.estimatedTemporaryDatabaseBytes)}),
    ...(value.filesystemsShared === undefined ? {} : {filesystemsShared: value.filesystemsShared}),
    ...(materializationMode === undefined ? {} : {materializationMode}),
    ...(value.temporaryAvailableBytes === undefined
      ? {}
      : {temporaryAvailableBytes: Number(value.temporaryAvailableBytes)}),
    temporaryDatabaseBytes: Number(value.temporaryDatabaseBytes),
    temporaryDatabaseHighWaterBytes: Number(value.temporaryDatabaseHighWaterBytes),
  };
}

function parseMaterializationRows(value: unknown): CodeGraphMaterializationRows | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
    'deduplicatedEdges',
    'deduplicatedReferences',
    'edges',
    'lookupKeys',
    'referenceCandidates',
    'references',
    'reexports',
    'symbols',
    'terms',
  ] as const;
  for (const key of keys) {
    if (value[key] !== undefined && !isNonNegativeSafeInteger(value[key])) return undefined;
  }
  return EffectRecord.fromEntries(
    EffectArray.flatMap(keys, key => (value[key] === undefined ? [] : [[key, Number(value[key])]])),
  );
}

function isBatchProgress(completed: unknown, total: unknown): boolean {
  return isNonNegativeSafeInteger(completed) && isNonNegativeSafeInteger(total) && Number(completed) <= Number(total);
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseActivity(value: unknown): CodeGraphBuildActivity | undefined {
  const stage = oneOf(value, 'stage', ['extracting', 'persisting', 'reading']);
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.batchCompleted) ||
    !Number.isSafeInteger(value.batchTotal) ||
    Number(value.batchCompleted) < 0 ||
    Number(value.batchTotal) < 0 ||
    Number(value.batchCompleted) > Number(value.batchTotal) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 0 ||
    !isText(value.language, 64) ||
    stage === undefined ||
    (value.classifier !== undefined && !isText(value.classifier, 64)) ||
    (value.degraded !== undefined && typeof value.degraded !== 'boolean') ||
    (value.role !== undefined && !isText(value.role, 64)) ||
    (value.sizeBucket !== undefined && !isCodeGraphSourceSizeBucket(value.sizeBucket))
  ) {
    return undefined;
  }
  for (const key of ['factsBytes', 'relations', 'symbols'] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) return undefined;
  }
  for (const key of ['parseMilliseconds', 'persistMilliseconds'] as const) {
    if (value[key] !== undefined && !isNonNegativeFinite(value[key])) return undefined;
  }
  return {
    batchCompleted: Number(value.batchCompleted),
    batchTotal: Number(value.batchTotal),
    bytes: Number(value.bytes),
    ...(value.classifier === undefined ? {} : {classifier: value.classifier}),
    ...(typeof value.degraded === 'boolean' ? {degraded: value.degraded} : {}),
    ...(value.factsBytes === undefined ? {} : {factsBytes: Number(value.factsBytes)}),
    language: value.language,
    ...(value.parseMilliseconds === undefined ? {} : {parseMilliseconds: Number(value.parseMilliseconds)}),
    ...(value.persistMilliseconds === undefined ? {} : {persistMilliseconds: Number(value.persistMilliseconds)}),
    ...(value.relations === undefined ? {} : {relations: Number(value.relations)}),
    ...(value.role === undefined ? {} : {role: value.role}),
    ...(value.sizeBucket === undefined ? {} : {sizeBucket: value.sizeBucket}),
    stage,
    ...(value.symbols === undefined ? {} : {symbols: Number(value.symbols)}),
  };
}

function parseExtraction(value: unknown): CodeGraphBuildExtraction | undefined {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.completedFiles) ||
    !isNonNegativeSafeInteger(value.slowFiles) ||
    Number(value.slowFiles) > Number(value.completedFiles) ||
    !EffectArray.isArray(value.topSlowFiles) ||
    value.topSlowFiles.length > CODE_GRAPH_TOP_SLOW_FILE_LIMIT
  ) {
    return undefined;
  }
  const topSlowFiles = EffectArray.map(value.topSlowFiles, parseSlowFileTelemetry);
  if (EffectArray.some(topSlowFiles, sample => sample === undefined)) return undefined;
  const metrics = value.metrics === undefined ? undefined : parseScanningMetrics(value.metrics);
  if (value.metrics !== undefined && metrics === undefined) return undefined;
  const samples: CodeGraphSlowFileTelemetry[] = [];
  for (const sample of topSlowFiles) {
    if (sample === undefined) return undefined;
    samples.push(sample);
  }
  if (
    EffectArray.some(
      samples,
      (sample, index) =>
        index > 0 &&
        (sample.durationMilliseconds > samples[index - 1].durationMilliseconds ||
          (sample.durationMilliseconds === samples[index - 1].durationMilliseconds &&
            Effect.pipe(sample.pathHash, EffectString.localeCompare(samples[index - 1].pathHash)) < 0)),
    )
  ) {
    return undefined;
  }
  return {
    completedFiles: Number(value.completedFiles),
    ...(metrics === undefined ? {} : {metrics}),
    slowFiles: Number(value.slowFiles),
    topSlowFiles: samples,
  };
}

function parseScanningMetrics(value: unknown): CodeGraphScanningMetrics | undefined {
  if (!isRecord(value)) return undefined;
  if (value.degradedFiles !== undefined && !isNonNegativeSafeInteger(value.degradedFiles)) return undefined;
  for (const key of [
    'factsBytesCompleted',
    'sourceBytesCompleted',
    'sourceBytesTotal',
    'workUnitsCompleted',
    'workUnitsTotal',
  ] as const) {
    if (!isNonNegativeSafeInteger(value[key])) return undefined;
  }
  if (
    Number(value.sourceBytesCompleted) > Number(value.sourceBytesTotal) ||
    Number(value.workUnitsCompleted) > Number(value.workUnitsTotal)
  ) {
    return undefined;
  }
  return {
    ...(value.degradedFiles === undefined ? {} : {degradedFiles: Number(value.degradedFiles)}),
    factsBytesCompleted: Number(value.factsBytesCompleted),
    sourceBytesCompleted: Number(value.sourceBytesCompleted),
    sourceBytesTotal: Number(value.sourceBytesTotal),
    workUnitsCompleted: Number(value.workUnitsCompleted),
    workUnitsTotal: Number(value.workUnitsTotal),
  };
}

function parseSlowFileTelemetry(value: unknown): CodeGraphSlowFileTelemetry | undefined {
  if (
    !isRecord(value) ||
    !isText(value.classifier, 64) ||
    !isNonNegativeFinite(value.durationMilliseconds) ||
    !isText(value.extension, 16) ||
    !isText(value.language, 64) ||
    typeof value.pathHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.pathHash) ||
    !isText(value.role, 64) ||
    !isCodeGraphSourceSizeBucket(value.sizeBucket) ||
    !isNonNegativeSafeInteger(value.sourceBytes) ||
    (value.degraded !== undefined && typeof value.degraded !== 'boolean')
  ) {
    return undefined;
  }
  for (const key of ['factsBytes', 'relations', 'symbols'] as const) {
    if (value[key] !== undefined && !isNonNegativeSafeInteger(value[key])) return undefined;
  }
  return {
    classifier: value.classifier,
    ...(value.degraded === undefined ? {} : {degraded: value.degraded}),
    durationMilliseconds: Number(value.durationMilliseconds),
    extension: value.extension,
    ...(value.factsBytes === undefined ? {} : {factsBytes: Number(value.factsBytes)}),
    language: value.language,
    pathHash: value.pathHash,
    ...(value.relations === undefined ? {} : {relations: Number(value.relations)}),
    role: value.role,
    sizeBucket: value.sizeBucket,
    sourceBytes: Number(value.sourceBytes),
    ...(value.symbols === undefined ? {} : {symbols: Number(value.symbols)}),
  };
}

function parseTimings(value: unknown): CodeGraphBuildTimings | undefined {
  return isRecord(value) &&
    isNonNegativeFinite(value.extractionMilliseconds) &&
    isNonNegativeFinite(value.persistenceMilliseconds) &&
    isNonNegativeFinite(value.readingMilliseconds) &&
    (value.serializationMilliseconds === undefined || isNonNegativeFinite(value.serializationMilliseconds))
    ? {
        extractionMilliseconds: Number(value.extractionMilliseconds),
        persistenceMilliseconds: Number(value.persistenceMilliseconds),
        readingMilliseconds: Number(value.readingMilliseconds),
        ...(value.serializationMilliseconds === undefined
          ? {}
          : {serializationMilliseconds: Number(value.serializationMilliseconds)}),
      }
    : undefined;
}

function isNonNegativeFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function oneOfValue<const Values extends readonly string[]>(
  value: unknown,
  options: Values,
): Values[number] | undefined {
  return typeof value === 'string' && EffectArray.some(options, option => option === value) ? value : undefined;
}

function isOneOf<const Values extends readonly string[]>(value: unknown, options: Values): value is Values[number] {
  return oneOfValue(value, options) !== undefined;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  key: string,
  options: Values,
): Values[number] | undefined {
  return isRecord(value) ? oneOfValue(value[key], options) : undefined;
}

function parseRequest(value: unknown): CodeGraphBuildStatus['request'] | undefined {
  return isRecord(value) && isHash(value.key) ? {key: value.key} : undefined;
}

function parseCounters(value: unknown): CodeGraphBuildCounters | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
    'accepted',
    'completed',
    'edges',
    'embedded',
    'excluded',
    'pagesCompleted',
    'reused',
    'resolved',
    'rowsDeleted',
    'skipped',
    'symbols',
    'total',
  ] as const;
  for (const key of keys) {
    const counter = value[key];
    if (counter !== undefined && (!Number.isSafeInteger(counter) || Number(counter) < 0)) return undefined;
  }
  if (value.unit !== undefined && !['files', 'references', 'snapshots', 'symbols'].includes(String(value.unit)))
    return undefined;
  return EffectRecord.fromEntries(
    EffectArray.flatMap([...keys, 'unit' as const], key => (value[key] === undefined ? [] : [[key, value[key]]])),
  );
}

function parseError(value: unknown): CodeGraphBuildStatus['error'] | undefined {
  if (!isRecord(value) || !isText(value.summary, 300)) return undefined;
  const capacity = parseCapacityFailure(value.capacity);
  if (value.capacity !== undefined && capacity === undefined) return undefined;
  return {...(capacity === undefined ? {} : {capacity}), summary: value.summary};
}

export function parseCapacityFailure(value: unknown): CodeGraphBuildCapacityFailure | undefined {
  if (!isRecord(value) || !isCodeGraphCapacityFailureOperation(value.operation)) return undefined;
  const code = oneOfValue(value.code, ['no-space', 'transient-io']);
  const evidence = parseCapacityFailureEvidence(value.evidence);
  if (code === undefined || evidence === undefined) return undefined;
  if (code === 'transient-io' && (evidence.recovery !== 'retry-read-only' || !evidence.retryable)) return undefined;
  if (
    code === 'no-space' &&
    (evidence.recovery === 'retry-read-only' ||
      (evidence.recovery === 'defer' && !evidence.retryable) ||
      (evidence.recovery === 'free-space' && evidence.retryable))
  ) {
    return undefined;
  }
  return {code, evidence, operation: value.operation};
}

function parseCapacityFailureEvidence(value: unknown): CodeGraphBuildCapacityFailure['evidence'] | undefined {
  if (
    !isRecord(value) ||
    value.decisionLayer !== 'bounded-write-reservation' ||
    value.estimateBasis !== 'final-fact-bytes-and-row-count' ||
    !isText(value.calibrationIdentity, 256) ||
    !Number.isSafeInteger(value.modelVersion) ||
    Number(value.modelVersion) <= 0 ||
    typeof value.retryable !== 'boolean'
  ) {
    return undefined;
  }
  const recovery = oneOfValue(value.recovery, ['defer', 'free-space', 'retry-read-only']);
  const reason = oneOfValue(value.reason, [
    'available-space-unknown',
    'calibration-input-unknown',
    'filesystem-topology-unknown',
    'page-storage-unknown',
    'reservation-input-unknown',
  ]);
  if (recovery === undefined || (value.reason !== undefined && reason === undefined)) return undefined;
  const activeReservations = parseCapacityRoles(value.activeReservations, 'bytes');
  const filesystems = parseCapacityFilesystems(value.filesystems);
  if (activeReservations === undefined || filesystems === undefined) return undefined;
  const scope = parseCapacityScope(value.scope);
  if (value.scope !== undefined && scope === undefined) return undefined;
  return {
    activeReservations,
    calibrationIdentity: value.calibrationIdentity,
    decisionLayer: value.decisionLayer,
    estimateBasis: value.estimateBasis,
    filesystems,
    modelVersion: Number(value.modelVersion),
    ...(reason === undefined ? {} : {reason}),
    recovery,
    retryable: value.retryable,
    ...(scope === undefined ? {} : {scope}),
  };
}

function parseCapacityRoles(
  value: unknown,
  bytesKey: 'bytes',
): CodeGraphBuildCapacityFailure['evidence']['activeReservations'] | undefined {
  if (!EffectArray.isArray(value) || value.length > 3) return undefined;
  const roles = new Set<string>();
  const parsed: Array<{bytes: number; role: 'durable' | 'shared' | 'temporary'}> = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const role = oneOfValue(entry.role, ['durable', 'shared', 'temporary']);
    if (
      role === undefined ||
      roles.has(role) ||
      !Number.isSafeInteger(entry[bytesKey]) ||
      Number(entry[bytesKey]) < 0
    ) {
      return undefined;
    }
    roles.add(role);
    parsed.push({bytes: Number(entry[bytesKey]), role});
  }
  return parsed;
}

function parseCapacityFilesystems(
  value: unknown,
): CodeGraphBuildCapacityFailure['evidence']['filesystems'] | undefined {
  if (!EffectArray.isArray(value) || value.length > 3) return undefined;
  const roles = new Set<string>();
  const parsed: Array<{
    availableBytes: number;
    requiredBytes: number;
    role: 'durable' | 'shared' | 'temporary';
  }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const role = oneOfValue(entry.role, ['durable', 'shared', 'temporary']);
    if (
      role === undefined ||
      roles.has(role) ||
      !Number.isSafeInteger(entry.availableBytes) ||
      Number(entry.availableBytes) < 0 ||
      !Number.isSafeInteger(entry.requiredBytes) ||
      Number(entry.requiredBytes) < 0
    ) {
      return undefined;
    }
    roles.add(role);
    parsed.push({
      availableBytes: Number(entry.availableBytes),
      requiredBytes: Number(entry.requiredBytes),
      role,
    });
  }
  return parsed;
}

function parseCapacityScope(value: unknown): CodeGraphBuildCapacityFailure['evidence']['scope'] | undefined {
  if (!isRecord(value) || !isHash(value.checkoutId)) return undefined;
  if (
    value.scopeId !== undefined &&
    (typeof value.scopeId !== 'string' || !/^code-graph-scope:[0-9a-f]{64}$/u.test(value.scopeId))
  ) {
    return undefined;
  }
  return {checkoutId: value.checkoutId, ...(value.scopeId === undefined ? {} : {scopeId: value.scopeId})};
}

function parseEta(value: unknown): CodeGraphBuildStatus['eta'] | undefined {
  if (!isRecord(value) || value.scope !== 'phase') return undefined;
  const confidence = oneOfValue(value.confidence, ['high', 'low', 'medium']);
  const basis = Option.fromUndefinedOr(value.basis).pipe(
    Option.flatMap(candidate =>
      Option.fromUndefinedOr(
        oneOfValue(candidate, ['cached-fact-bytes', 'extraction-work', 'files', 'final-fact-bytes', 'source-bytes']),
      ),
    ),
  );
  if (
    confidence === undefined ||
    (value.basis !== undefined && Option.isNone(basis)) ||
    typeof value.remainingMilliseconds !== 'number' ||
    !Number.isSafeInteger(value.remainingMilliseconds) ||
    value.remainingMilliseconds < 0
  ) {
    return undefined;
  }
  return {
    ...(Option.isSome(basis) ? {basis: basis.value} : {}),
    confidence,
    remainingMilliseconds: value.remainingMilliseconds,
    scope: 'phase',
  };
}

function parseResult(value: unknown): CodeGraphBuildStatus['result'] | undefined {
  if (!isRecord(value) || typeof value.dirty !== 'boolean' || !isText(value.snapshotId, 128)) return undefined;
  for (const key of ['edges', 'files', 'symbols'] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return undefined;
  }
  const overlayAssessment = value.overlayAssessment;
  const overlayOutcome = !isRecord(overlayAssessment)
    ? undefined
    : oneOfValue(overlayAssessment.outcome, ['overlay-success', ...VALID_MATERIALIZATION_FALLBACK_REASONS]);
  if (overlayAssessment !== undefined && overlayOutcome === undefined) return undefined;
  return {
    dirty: value.dirty,
    edges: Number(value.edges),
    files: Number(value.files),
    ...(overlayOutcome === undefined ? {} : {overlayAssessment: {outcome: overlayOutcome}}),
    snapshotId: value.snapshotId,
    symbols: Number(value.symbols),
  };
}
