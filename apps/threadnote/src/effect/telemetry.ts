import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import {OtlpSerialization, OtlpTracer} from 'effect/observability';
import {Cause, Clock, ConfigProvider, Context, Effect, Exit, Layer, Result, Tracer} from 'effect';
import type * as Headers from 'effect/http/Headers';
import type * as Duration from 'effect/Duration';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {
  anonymousTelemetryDiagnosticFromError,
  closedTelemetryErrorType,
  projectAnonymousTelemetryDiagnostic,
  readAnonymousTelemetryDiagnostic,
  readAnonymousTelemetryReportedOutcome,
  type AnonymousTelemetryReportedOutcome,
  type AnonymousTelemetryDiagnostic,
} from '../telemetry/diagnostic.js';
import {safeAnonymousTelemetryOperation} from '../telemetry/operations.js';

const TELEMETRY_SCHEMA_VERSION = 6;
const TELEMETRY_VERSION_MAX_BYTES = 96;
const FIRST_CHECKPOINT_DELAY = '30 seconds';
const CHECKPOINT_INTERVAL = '60 seconds';

export const ANONYMOUS_TELEMETRY_PHASES = [
  'context.brief.citation-validation',
  'context.brief.code-linked-memory',
  'context.brief.graph',
  'context.brief.memory',
  'context.brief.projection',
  'graph.activating',
  'graph.embedding',
  'graph.materializing',
  'graph.query.execute',
  'graph.query.snapshot',
  'graph.query.status',
  'graph.reclaiming',
  'graph.registering',
  'graph.resolving',
  'graph.scanning',
  'graph.sharing',
  'graph.waiting',
  'model.diagnostics',
  'model.embedding',
  'model.generation',
  'model.inference',
  'model.loading',
  'model.reranking',
  'memory.code-anchor-finalization',
  'recall.lexical-ranking',
  'recall.obsidian-sync',
  'recall.semantic-retrieval',
  'recall.shared-sync',
  'storage.reading',
  'storage.writing',
] as const;

export type AnonymousTelemetryPhase = (typeof ANONYMOUS_TELEMETRY_PHASES)[number];

export const ANONYMOUS_TELEMETRY_SUBPHASES = [
  'applying-deltas',
  'building-local-overlay',
  'complete',
  'discovering-shared-base',
  'downloading-checkpoint',
  'fallback',
  'promoting',
  'references',
  'skipped',
  'structural-ready',
  'summarizing-analysis',
  'validating-input',
  'writing-and-checkpointing',
] as const;

export type AnonymousTelemetrySubphase = (typeof ANONYMOUS_TELEMETRY_SUBPHASES)[number];

export const ANONYMOUS_TELEMETRY_STAGES = [
  'attributing',
  'checkpointing-snapshot',
  'committing',
  'committing-snapshot',
  'copying-edges',
  'copying-files',
  'copying-lookup-keys',
  'copying-reexports',
  'copying-symbols',
  'copying-terms',
  'copying-workspace',
  'extracting',
  'loading-cache',
  'persisting',
  'preparing-rows',
  'query-repository-identity',
  'query-serialization',
  'query-strict-reobservation',
  'query-worktree-observation',
  'reading',
  'recording-completion',
  'validating-input',
  'writing-analysis',
  'writing-candidates',
  'writing-edges',
  'writing-facts',
  'writing-lookups',
  'writing-receipt',
  'writing-references',
  'writing-symbols',
  'writing-terms',
] as const;

export type AnonymousTelemetryStage = (typeof ANONYMOUS_TELEMETRY_STAGES)[number];

export const ANONYMOUS_TELEMETRY_WAITING_REASONS = [
  'database-writer',
  'disk-capacity',
  'home-builder-cap',
  'prepared-spool-budget',
  'repository-lock',
  'request-lock',
  'snapshot-build',
] as const;

export type AnonymousTelemetryWaitingReason = (typeof ANONYMOUS_TELEMETRY_WAITING_REASONS)[number];

export const ANONYMOUS_TELEMETRY_AUTO_UPDATE_RESULTS = ['busy', 'current', 'disabled', 'failed', 'updated'] as const;
const ANONYMOUS_TELEMETRY_GRAPH_BUILD_KINDS = ['clean', 'dirty'] as const;
const ANONYMOUS_TELEMETRY_GRAPH_EFFICIENCY_CLASSES = [
  'critical-amplification-full',
  'expected-full',
  'full',
  'high-amplification-full',
  'incremental',
  'small-delta-full',
] as const;
const ANONYMOUS_TELEMETRY_GRAPH_FALLBACK_REASONS = [
  'cache-incomplete',
  'disabled',
  'dynamic-aliases',
  'extractor-context-changed',
  'fact-budget-expanded',
  'file-set-changed',
  'forced-full-rebuild',
  'incremental-rewrite-unbounded',
  'no-materialized-changes',
  'none',
  'project-closure-incomplete',
  'project-closure-unbounded',
  'reexport-closure-unbounded',
  'resolution-surface-changed',
  'staging-identity-mismatch',
  'staging-unavailable',
  'workspace-changed',
] as const;
const ANONYMOUS_TELEMETRY_GRAPH_MATERIALIZATION_MODES = [
  'full',
  'incremental-clean',
  'incremental-overlay',
  'reused-snapshot',
] as const;
const ANONYMOUS_TELEMETRY_GRAPH_RESOLUTION_CLOSURES = ['changed', 'full', 'none', 'project'] as const;
const ANONYMOUS_TELEMETRY_GRAPH_REQUEST_KINDS = [
  'analyze.communities',
  'analyze.community',
  'analyze.confidence',
  'analyze.full',
  'analyze.groups',
  'analyze.hubs',
  'analyze.stats',
  'analyze.surprises',
  'inspect.explain',
  'inspect.impact',
  'inspect.neighbors',
  'inspect.node',
  'inspect.path',
  'inspect.query',
  'inspect.topology',
] as const;
const ANONYMOUS_TELEMETRY_GRAPH_REQUEST_SCOPES = ['local', 'workset'] as const;
const ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_FRESHNESS = ['current', 'deferred', 'stale'] as const;
const ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_SELECTIONS = ['active', 'borrowed', 'none', 'promoted'] as const;
export const ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_SCOPES = ['local', 'workset'] as const;
export const ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CONTRACTS = ['code-anchored-v3', 'task-only-v2'] as const;
export const ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_MODES = [
  'brief',
  'explain',
  'impact',
  'locate',
  'resume',
  'trace',
] as const;
export const ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CODE_ANCHOR_COVERAGES = ['complete', 'partial', 'unavailable'] as const;
export const ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_GAP_CLASSES = [
  'mixed',
  'none',
  'truncated',
  'unavailable',
  'unresolved',
] as const;
export const ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_RETURNED_LANES = ['graph', 'memory', 'mixed', 'none'] as const;
export const ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_COVERAGES = [
  'complete',
  'none',
  'partial',
  'unavailable',
] as const;
export const ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_RESULTS = [
  'exact-only',
  'mixed',
  'none',
  'relocated',
  'stale',
  'unknown',
] as const;
export const ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_UNKNOWN_REASONS = [
  'ambiguous-relocation',
  'budget-exhausted',
  'invalid-citation',
  'mixed',
  'repository-unavailable',
  'snapshot-not-current',
  'snapshot-unavailable',
  'store-failure',
  'unsupported',
] as const;
export const ANONYMOUS_TELEMETRY_CODE_ANCHOR_FINALIZATION_TRIGGERS = [
  'context-brief',
  'explicit',
  'graph-index',
  'workset-prepare',
] as const;
export const ANONYMOUS_TELEMETRY_CODE_ANCHOR_FINALIZATION_RESULTS = [
  'conflict',
  'contended',
  'failed',
  'finalized',
  'mixed',
  'no-work',
  'pending',
] as const;

type AnonymousTelemetryGraphBuildKind = (typeof ANONYMOUS_TELEMETRY_GRAPH_BUILD_KINDS)[number];
type AnonymousTelemetryAutoUpdateResult = (typeof ANONYMOUS_TELEMETRY_AUTO_UPDATE_RESULTS)[number];
type AnonymousTelemetryGraphEfficiencyClass = (typeof ANONYMOUS_TELEMETRY_GRAPH_EFFICIENCY_CLASSES)[number];
type AnonymousTelemetryGraphFallbackReason = (typeof ANONYMOUS_TELEMETRY_GRAPH_FALLBACK_REASONS)[number];
type AnonymousTelemetryGraphMaterializationMode = (typeof ANONYMOUS_TELEMETRY_GRAPH_MATERIALIZATION_MODES)[number];
type AnonymousTelemetryGraphResolutionClosure = (typeof ANONYMOUS_TELEMETRY_GRAPH_RESOLUTION_CLOSURES)[number];
export type AnonymousTelemetryGraphRequestKind = (typeof ANONYMOUS_TELEMETRY_GRAPH_REQUEST_KINDS)[number];
export type AnonymousTelemetryGraphRequestScope = (typeof ANONYMOUS_TELEMETRY_GRAPH_REQUEST_SCOPES)[number];
export type AnonymousTelemetryGraphSnapshotFreshness = (typeof ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_FRESHNESS)[number];
export type AnonymousTelemetryGraphSnapshotSelection = (typeof ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_SELECTIONS)[number];
export type AnonymousTelemetryContextBriefScope = (typeof ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_SCOPES)[number];
export type AnonymousTelemetryContextBriefContract = (typeof ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CONTRACTS)[number];
export type AnonymousTelemetryContextBriefMode = (typeof ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_MODES)[number];
export type AnonymousTelemetryContextBriefCodeAnchorCoverage =
  (typeof ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CODE_ANCHOR_COVERAGES)[number];
export type AnonymousTelemetryContextBriefGapClass = (typeof ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_GAP_CLASSES)[number];
export type AnonymousTelemetryContextBriefReturnedLane =
  (typeof ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_RETURNED_LANES)[number];
export type AnonymousTelemetryContextBriefCitationCoverage =
  (typeof ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_COVERAGES)[number];
export type AnonymousTelemetryContextBriefCitationResult =
  (typeof ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_RESULTS)[number];
export type AnonymousTelemetryContextBriefCitationUnknownReason =
  (typeof ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_UNKNOWN_REASONS)[number];
export type AnonymousTelemetryCodeAnchorFinalizationTrigger =
  (typeof ANONYMOUS_TELEMETRY_CODE_ANCHOR_FINALIZATION_TRIGGERS)[number];
export type AnonymousTelemetryCodeAnchorFinalizationResult =
  (typeof ANONYMOUS_TELEMETRY_CODE_ANCHOR_FINALIZATION_RESULTS)[number];
export type AnonymousTelemetryQuantityBucket = '0' | `2^${number}`;

export interface AnonymousTelemetryFields {
  readonly autoUpdateRepairRequired?: boolean;
  readonly autoUpdateResult?: AnonymousTelemetryAutoUpdateResult;
  readonly batchesCompleted?: number;
  readonly batchesTotal?: number;
  readonly buildKind?: AnonymousTelemetryGraphBuildKind;
  readonly cachedFactReplayBytesBucket?: AnonymousTelemetryQuantityBucket;
  readonly changedFactBytesBucket?: AnonymousTelemetryQuantityBucket;
  readonly changedFilesBucket?: AnonymousTelemetryQuantityBucket;
  readonly completed?: number;
  readonly contextBriefCacheHitsBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefCodeAnchorCoverage?: AnonymousTelemetryContextBriefCodeAnchorCoverage;
  readonly contextBriefCodeAnchorGap?: boolean;
  readonly contextBriefCodeAnchorsMatchedMemoriesBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefCodeAnchorsRequestedBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefCodeAnchorsResolvedBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefContract?: AnonymousTelemetryContextBriefContract;
  readonly contextBriefGapClass?: AnonymousTelemetryContextBriefGapClass;
  readonly contextBriefCitationCoverage?: AnonymousTelemetryContextBriefCitationCoverage;
  readonly contextBriefCitationResult?: AnonymousTelemetryContextBriefCitationResult;
  readonly contextBriefCitationUnknownReason?: AnonymousTelemetryContextBriefCitationUnknownReason;
  readonly contextBriefCitationsBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefCitedMemoriesBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefExactCitationsBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefOutputTruncated?: boolean;
  readonly contextBriefMode?: AnonymousTelemetryContextBriefMode;
  readonly contextBriefRecoveryPresent?: boolean;
  readonly contextBriefReturnedLane?: AnonymousTelemetryContextBriefReturnedLane;
  readonly contextBriefRelocatedCitationsBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefRepositoriesValidatedBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefScope?: AnonymousTelemetryContextBriefScope;
  readonly contextBriefStaleCitationsBucket?: AnonymousTelemetryQuantityBucket;
  readonly contextBriefUnknownCitationsBucket?: AnonymousTelemetryQuantityBucket;
  readonly deletedFilesBucket?: AnonymousTelemetryQuantityBucket;
  readonly codeAnchorFinalizationConflictBucket?: AnonymousTelemetryQuantityBucket;
  readonly codeAnchorFinalizationFailedBucket?: AnonymousTelemetryQuantityBucket;
  readonly codeAnchorFinalizationFinalizedBucket?: AnonymousTelemetryQuantityBucket;
  readonly codeAnchorFinalizationLatencyMillisecondsBucket?: AnonymousTelemetryQuantityBucket;
  readonly codeAnchorFinalizationMatchedBucket?: AnonymousTelemetryQuantityBucket;
  readonly codeAnchorFinalizationPendingBucket?: AnonymousTelemetryQuantityBucket;
  readonly codeAnchorFinalizationResult?: AnonymousTelemetryCodeAnchorFinalizationResult;
  readonly codeAnchorFinalizationScannedBucket?: AnonymousTelemetryQuantityBucket;
  readonly codeAnchorFinalizationTrigger?: AnonymousTelemetryCodeAnchorFinalizationTrigger;
  readonly deltaFilesBucket?: AnonymousTelemetryQuantityBucket;
  readonly degradedFiles?: number;
  readonly degradationReason?:
    | 'abort'
    | 'allocation'
    | 'exit'
    | 'fact-bytes'
    | 'operation'
    | 'protocol'
    | 'rss'
    | 'source-bytes'
    | 'spawn'
    | 'symbols'
    | 'timeout'
    | 'write';
  readonly elapsedMilliseconds?: number;
  readonly efficiencyClass?: AnonymousTelemetryGraphEfficiencyClass;
  readonly extractedFilesBucket?: AnonymousTelemetryQuantityBucket;
  readonly extractionMilliseconds?: number;
  readonly factsBytesCompleted?: number;
  readonly factsBytesTotal?: number;
  readonly factReplayAmplificationBucket?: AnonymousTelemetryQuantityBucket;
  readonly fallbackReason?: AnonymousTelemetryGraphFallbackReason;
  readonly finalFactBytesBucket?: AnonymousTelemetryQuantityBucket;
  readonly mode?: AnonymousTelemetryGraphMaterializationMode;
  readonly operationElapsedMilliseconds?: number;
  readonly persistenceMilliseconds?: number;
  readonly phase?: AnonymousTelemetryPhase;
  readonly phaseOutcome?: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
  readonly readingMilliseconds?: number;
  readonly resolutionClosure?: AnonymousTelemetryGraphResolutionClosure;
  readonly reusedFilesBucket?: AnonymousTelemetryQuantityBucket;
  readonly requestKind?: AnonymousTelemetryGraphRequestKind;
  readonly requestScope?: AnonymousTelemetryGraphRequestScope;
  readonly rewriteAmplificationBucket?: AnonymousTelemetryQuantityBucket;
  readonly sourceBytesCompleted?: number;
  readonly sourceBytesTotal?: number;
  readonly stage?: AnonymousTelemetryStage;
  readonly stageElapsedMilliseconds?: number;
  readonly stagedFilesBucket?: AnonymousTelemetryQuantityBucket;
  readonly subphase?: AnonymousTelemetrySubphase;
  readonly snapshotEdgesBucket?: AnonymousTelemetryQuantityBucket;
  readonly snapshotFilesBucket?: AnonymousTelemetryQuantityBucket;
  readonly snapshotFreshness?: AnonymousTelemetryGraphSnapshotFreshness;
  readonly snapshotSelection?: AnonymousTelemetryGraphSnapshotSelection;
  readonly snapshotSymbolsBucket?: AnonymousTelemetryQuantityBucket;
  readonly total?: number;
  readonly totalFilesBucket?: AnonymousTelemetryQuantityBucket;
  readonly transactionMilliseconds?: number;
  readonly workUnitsCompleted?: number;
  readonly workUnitsTotal?: number;
  readonly waitingReason?: AnonymousTelemetryWaitingReason;
}

export interface AnonymousTelemetryRuntimeOptions {
  readonly correlationScope: 'broker' | 'invocation' | 'provider-session';
  readonly endpoint: string;
  /** @internal Deterministic exporter controls for focused tests. */
  readonly exportInterval?: Duration.Input;
  readonly headers?: Headers.Input;
  readonly isEnabled?: Effect.Effect<boolean, never>;
  /** @internal Deterministic exporter controls for focused tests. */
  readonly maxBatchSize?: number;
  readonly serviceVersion: string;
  readonly sessionId: string;
  /** @internal Entry-point-specific final flush budget. */
  readonly shutdownTimeout?: Duration.Input;
}

export interface AnonymousTelemetryInvocationOptions<A = unknown> {
  readonly component: 'cli' | 'mcp';
  readonly operation: string;
  readonly reportedFailure?: (value: A) => boolean;
  readonly reportedFailureType?: string;
  readonly reportedOutcome?: (value: A) => AnonymousTelemetryReportedOutcome | undefined;
}

export interface AnonymousTelemetryCheckpointOptions<A> {
  /** Closed fields known before the checkpointed operation starts. */
  readonly fields: AnonymousTelemetryFields;
  /** Defaults to true. False keeps checkpoint-only fields off the terminal recorder. */
  readonly retainFields?: boolean;
  /** Additional closed fields derived only from a successful result. */
  readonly successFields?: (value: A) => AnonymousTelemetryFields;
  readonly successOutcome?: (value: A) => 'failure' | 'success' | 'timed-out' | 'unavailable';
}

interface MutableAnonymousTelemetryRecorder {
  active: boolean;
  readonly component: 'cli' | 'mcp';
  fields: AnonymousTelemetryFields;
  readonly invocationId?: string;
  readonly operation: string;
}

interface AnonymousTelemetryService {
  readonly emit: (options: AnonymousTelemetryEventOptions) => Effect.Effect<void>;
  readonly instrument: <A, E, R>(
    options: AnonymousTelemetryInvocationOptions<A>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

interface AnonymousTelemetryEventOptions {
  readonly component: 'cli' | 'mcp';
  readonly diagnostic?: AnonymousTelemetryDiagnostic;
  /** Wall-clock duration of a terminal lifecycle event. */
  readonly durationMilliseconds?: number;
  readonly errorType?: string;
  readonly event?: 'checkpoint' | 'lifecycle';
  readonly fields?: AnonymousTelemetryFields;
  readonly invocationId?: string;
  readonly operation: string;
  readonly outcome?: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
}

const noOpService: AnonymousTelemetryService = {
  emit: () => Effect.void,
  instrument: (_options, effect) => effect,
};

const AnonymousTelemetry = Context.Reference<AnonymousTelemetryService>('threadnote/AnonymousTelemetry', {
  defaultValue: () => noOpService,
});

const CurrentAnonymousTelemetryRecorder = Context.Reference<MutableAnonymousTelemetryRecorder | undefined>(
  'threadnote/CurrentAnonymousTelemetryRecorder',
  {defaultValue: () => undefined},
);

/**
 * Installs a private traces-only OTLP exporter. The tracer is captured by the
 * service layer and never merged into Threadnote's application context.
 */
export function anonymousTelemetryLayer(options?: AnonymousTelemetryRuntimeOptions) {
  if (options === undefined) return Layer.succeed(AnonymousTelemetry, noOpService);
  const isEnabled = (options.isEnabled ?? Effect.succeed(true)).pipe(Effect.catchCause(() => Effect.succeed(false)));
  const transportLayer = anonymousTelemetryHttpClientLayer(isEnabled);
  const privateTracerLayer = OtlpTracer.layer({
    exportInterval: options.exportInterval ?? '5 seconds',
    ...(options.headers === undefined ? {} : {headers: options.headers}),
    maxBatchSize: options.maxBatchSize ?? 64,
    resource: {
      attributes: {
        'session.id': safeAgentSessionId(options.sessionId),
        'threadnote.session.scope': safeCorrelationScope(options.correlationScope),
        'threadnote.telemetry.schema_version': TELEMETRY_SCHEMA_VERSION,
      },
      serviceName: 'threadnote',
      serviceVersion: safeVersion(options.serviceVersion),
    },
    shutdownTimeout: options.shutdownTimeout ?? '3 seconds',
    url: options.endpoint,
  }).pipe(
    Layer.provide(OtlpSerialization.layerProtobuf),
    Layer.provide(transportLayer),
    // OtlpResource otherwise merges ambient OTEL_RESOURCE_ATTRIBUTES and
    // OTEL_SERVICE_* values, which are outside Threadnote's consent allowlist.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  );
  return Layer.effect(
    AnonymousTelemetry,
    Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const system = yield* SystemInfo;
      return AnonymousTelemetry.of(makeAnonymousTelemetryService(tracer, system, isEnabled));
    }),
  ).pipe(Layer.provide(privateTracerLayer));
}

/**
 * Captures a redirect-denying fetch client and gates every actual OTLP request
 * on current consent. Returning a synthetic success when consent was revoked
 * makes Effect's exporter discard its already-dequeued batch without sending,
 * retrying, or entering its temporary failure backoff.
 */
function anonymousTelemetryHttpClientLayer(isEnabled: Effect.Effect<boolean, never>) {
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.RequestInit, {
        redirect: 'error',
      }),
    ),
  );
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, client =>
      HttpClient.transform(client, (requestEffect, request) =>
        Effect.flatMap(isEnabled, enabled =>
          enabled
            ? requestEffect
            : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, {status: 204}))),
        ),
      ),
    ),
  ).pipe(Layer.provide(fetchLayer));
}

/** @internal Focused tests can observe the exact private tracer envelope. */
export function anonymousTelemetryTestLayer(options: {
  readonly invocationId?: () => string | undefined;
  readonly isEnabled?: Effect.Effect<boolean, never>;
  readonly system: SystemInfoShape;
  readonly tracer: Tracer.Tracer;
}) {
  return Layer.succeed(
    AnonymousTelemetry,
    makeAnonymousTelemetryService(
      options.tracer,
      options.system,
      options.isEnabled ?? Effect.succeed(true),
      options.invocationId,
    ),
  );
}

function makeAnonymousTelemetryService(
  tracer: Tracer.Tracer,
  system: SystemInfoShape,
  enabled: Effect.Effect<boolean, never>,
  invocationId: () => string | undefined = safeAnonymousInvocationId,
): AnonymousTelemetryService {
  const isEnabled = enabled.pipe(Effect.catchCause(() => Effect.succeed(false)));
  const emit = (event: AnonymousTelemetryEventOptions) =>
    isEnabled.pipe(
      Effect.flatMap(enabled =>
        enabled
          ? Effect.suspend(() => {
              const diagnostic = projectAnonymousTelemetryDiagnostic(event.diagnostic);
              const errorType =
                diagnostic?.errorType ??
                (event.errorType === undefined ? undefined : closedTelemetryErrorType(event.errorType));
              return emitSafeSpan(
                tracer,
                system,
                event,
                event.outcome === undefined
                  ? undefined
                  : {
                      durationMilliseconds: event.durationMilliseconds ?? event.fields?.elapsedMilliseconds ?? 0,
                      ...(diagnostic === undefined ? {} : {diagnostic}),
                      ...(errorType === undefined ? {} : {errorType}),
                      outcome: event.outcome,
                    },
                undefined,
              );
            })
          : Effect.void,
      ),
      Effect.ignoreCause,
      Effect.withTracerEnabled(false),
    );
  return {
    emit,
    instrument: <A, E, R>(
      invocation: AnonymousTelemetryInvocationOptions<A>,
      applicationEffect: Effect.Effect<A, E, R>,
    ) =>
      Effect.flatMap(isEnabled, initiallyEnabled => {
        if (!initiallyEnabled) return applicationEffect;
        return Effect.uninterruptibleMask(restore =>
          Effect.scoped(
            Effect.gen(function* () {
              const recorder: MutableAnonymousTelemetryRecorder = {
                active: true,
                component: invocation.component,
                fields: {},
                invocationId: optionalInvocationId(invocationId),
                operation: invocation.operation,
              };
              const startedAt = yield* Clock.currentTimeMillis;
              const startMemory = safeMemoryUsage(system);
              yield* Effect.forkScoped(
                restore(
                  telemetryCheckpoints(emit, invocation, recorder, startedAt).pipe(Effect.withTracerEnabled(false)),
                ),
              );
              const exit = yield* Effect.exit(
                restore(
                  applicationEffect.pipe(
                    Effect.provideService(CurrentAnonymousTelemetryRecorder, recorder),
                    Effect.withTracerEnabled(false),
                  ),
                ),
              );
              recorder.active = false;
              const finishedAt = yield* Clock.currentTimeMillis;
              const endMemory = safeMemoryUsage(system);
              const classification = completionClassification(exit, invocation);
              if (yield* isEnabled) {
                yield* Effect.suspend(() =>
                  emitSafeSpan(
                    tracer,
                    system,
                    {
                      component: invocation.component,
                      fields: completionTelemetryFields(recorder.fields, classification.outcome),
                      invocationId: recorder.invocationId,
                      operation: invocation.operation,
                    },
                    {
                      durationMilliseconds: Math.max(0, finishedAt - startedAt),
                      ...classification,
                    },
                    {end: endMemory, start: startMemory},
                  ),
                ).pipe(Effect.ignoreCause);
              }
              return Exit.isSuccess(exit) ? exit.value : yield* Effect.failCause(exit.cause);
            }),
          ),
        );
      }),
  };
}

/** Adds a privacy-safe diagnostic envelope around one application Effect. */
export function withAnonymousTelemetry<A, E, R>(
  options: AnonymousTelemetryInvocationOptions<A>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.flatMap(AnonymousTelemetry, service => service.instrument(options, effect));
}

/** Emits a successful immediate checkpoint with only closed telemetry fields. */
export function emitAnonymousTelemetryEvent(options: AnonymousTelemetryEventOptions): Effect.Effect<void> {
  return Effect.flatMap(CurrentAnonymousTelemetryRecorder, recorder =>
    Effect.flatMap(AnonymousTelemetry, service =>
      service.emit({
        ...options,
        invocationId: options.invocationId ?? recorder?.invocationId,
      }),
    ),
  );
}

/** Emits a checkpoint measured by an isolated child without re-running its work in this process. */
export function emitObservedAnonymousTelemetryCheckpoint(options: {
  readonly durationMilliseconds: number;
  readonly fields: AnonymousTelemetryFields;
  readonly outcome: 'failure' | 'interrupted' | 'success';
}): Effect.Effect<void> {
  return Effect.flatMap(CurrentAnonymousTelemetryRecorder, recorder => {
    if (recorder === undefined || !recorder.active) return Effect.void;
    const durationMilliseconds =
      Number.isSafeInteger(options.durationMilliseconds) && options.durationMilliseconds >= 0
        ? options.durationMilliseconds
        : 0;
    return Effect.flatMap(AnonymousTelemetry, service =>
      service.emit({
        component: recorder.component,
        durationMilliseconds,
        event: 'checkpoint',
        fields: {
          ...options.fields,
          elapsedMilliseconds: durationMilliseconds,
          phaseOutcome: options.outcome,
        },
        invocationId: recorder.invocationId,
        operation: recorder.operation,
        outcome: options.outcome,
      }),
    );
  });
}

/** Records bounded progress on the current operation without network I/O. */
export function recordAnonymousTelemetryFields(fields: AnonymousTelemetryFields): Effect.Effect<void> {
  return Effect.flatMap(CurrentAnonymousTelemetryRecorder, recorder =>
    recorder === undefined || !recorder.active
      ? Effect.void
      : Effect.sync(() => {
          recorder.fields = mergeTelemetryFields(recorder.fields, fields);
        }),
  );
}

/**
 * Removes an invocation-local recorder before a long-lived service captures
 * the surrounding context for later requests.
 */
export function omitAnonymousTelemetryRecorder<R>(context: Context.Context<R>): Context.Context<R> {
  return Context.omit(CurrentAnonymousTelemetryRecorder)(context);
}

export function withAnonymousTelemetryPhase<A, E, R>(
  phase: AnonymousTelemetryPhase,
  effect: Effect.Effect<A, E, R>,
  successOutcome?: (value: A) => 'failure' | 'success' | 'timed-out' | 'unavailable',
): Effect.Effect<A, E, R> {
  return withAnonymousTelemetryCheckpoint({fields: {phase}, successOutcome}, effect);
}

/**
 * Emits one invocation-scoped checkpoint when an Effect exits. Failure and
 * interruption keep only fields known before execution; result-derived fields
 * are admitted only after a successful exit.
 */
export function withAnonymousTelemetryCheckpoint<A, E, R>(
  options: AnonymousTelemetryCheckpointOptions<A>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.flatMap(CurrentAnonymousTelemetryRecorder, recorder => {
    if (recorder === undefined || !recorder.active) return effect;
    return Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* effect.pipe(
        Effect.onExit(exit =>
          Effect.suspend(() =>
            Effect.gen(function* () {
              if (!recorder.active) return;
              const finishedAt = yield* Clock.currentTimeMillis;
              const elapsedMilliseconds = Math.max(0, finishedAt - startedAt);
              const classified = safePhaseOutcome(exit, options.successOutcome);
              const successFields =
                Exit.isSuccess(exit) && classified.outcome === 'success'
                  ? Result.try(() => options.successFields?.(exit.value) ?? {})
                  : Result.succeed({});
              const fields = {
                ...options.fields,
                ...(Result.isSuccess(successFields) ? successFields.success : {}),
                elapsedMilliseconds,
                phaseOutcome: classified.outcome,
              } as const;
              if (options.retainFields !== false) yield* recordAnonymousTelemetryFields(fields);
              yield* emitAnonymousTelemetryEvent({
                component: recorder.component,
                ...(classified.errorType === undefined ? {} : {errorType: classified.errorType}),
                event: 'checkpoint',
                fields,
                invocationId: recorder.invocationId,
                operation: recorder.operation,
                outcome: classified.outcome,
              });
            }),
          ).pipe(Effect.ignoreCause),
        ),
      );
    });
  });
}

function safePhaseOutcome<A, E>(
  exit: Exit.Exit<A, E>,
  successOutcome: ((value: A) => 'failure' | 'success' | 'timed-out' | 'unavailable') | undefined,
) {
  const classified = Result.try(() => phaseOutcome(exit, successOutcome));
  if (Result.isSuccess(classified)) return classified.success;
  return {errorType: 'UnknownError', outcome: Exit.isSuccess(exit) ? ('success' as const) : ('failure' as const)};
}

function phaseOutcome<A, E>(
  exit: Exit.Exit<A, E>,
  successOutcome: ((value: A) => 'failure' | 'success' | 'timed-out' | 'unavailable') | undefined,
) {
  if (Exit.isSuccess(exit)) {
    const outcome = Result.try(() => successOutcome?.(exit.value) ?? 'success');
    return {outcome: Result.isSuccess(outcome) ? outcome.success : ('success' as const)};
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return {outcome: 'interrupted' as const};
  return {
    errorType: anonymousTelemetryDiagnosticFromError(Cause.squash(exit.cause))?.errorType ?? 'UnknownError',
    outcome: 'failure' as const,
  };
}

function telemetryCheckpoints<A>(
  emit: AnonymousTelemetryService['emit'],
  invocation: AnonymousTelemetryInvocationOptions<A>,
  recorder: MutableAnonymousTelemetryRecorder,
  startedAt: number,
) {
  return Effect.sleep(FIRST_CHECKPOINT_DELAY).pipe(
    Effect.andThen(
      Effect.forever(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap(now =>
            emit({
              component: invocation.component,
              event: 'checkpoint',
              fields: {...recorder.fields, operationElapsedMilliseconds: Math.max(0, now - startedAt)},
              invocationId: recorder.invocationId,
              operation: invocation.operation,
            }),
          ),
          Effect.andThen(Effect.sleep(CHECKPOINT_INTERVAL)),
        ),
      ),
    ),
  );
}

function emitSafeSpan(
  tracer: Tracer.Tracer,
  system: SystemInfoShape,
  event: AnonymousTelemetryEventOptions,
  completion?: Readonly<{
    durationMilliseconds: number;
    errorType?: string;
    outcome: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
    diagnostic?: AnonymousTelemetryDiagnostic;
  }>,
  memory?: Readonly<{end: ReturnType<typeof safeMemoryUsage>; start: ReturnType<typeof safeMemoryUsage>}>,
): Effect.Effect<void> {
  const operation = safeAnonymousTelemetryOperation(event.operation);
  const attributes: Record<string, unknown> = {
    'threadnote.component': safeComponent(event.component),
    'threadnote.event': safeEvent(event.event),
    ...(event.invocationId === undefined ? {} : {'threadnote.invocation.id': safeInvocationId(event.invocationId)}),
    'threadnote.operation': operation,
    'threadnote.runtime.architecture': safeRuntimeLabel(system.architecture),
    'threadnote.runtime.platform': safeRuntimeLabel(system.platform),
    'threadnote.runtime.version': safeVersion(system.runtimeVersion),
    ...telemetryFieldAttributes(event.fields),
    ...(memory === undefined
      ? currentMemoryAttributes(safeMemoryUsage(system))
      : memoryAttributes(memory.start, memory.end)),
  };
  if (completion !== undefined) {
    attributes['threadnote.duration_ms'] = boundedNumber(completion.durationMilliseconds);
    attributes['threadnote.outcome'] = safeOutcome(completion.outcome);
    if (completion.errorType !== undefined) attributes['error.type'] = closedTelemetryErrorType(completion.errorType);
    const diagnostic = projectAnonymousTelemetryDiagnostic(completion.diagnostic);
    if (diagnostic?.domain !== undefined) attributes['threadnote.failure.domain'] = diagnostic.domain;
    if (diagnostic?.code !== undefined) attributes['threadnote.failure.code'] = diagnostic.code;
    if (diagnostic?.operation !== undefined)
      attributes['threadnote.failure.operation'] = diagnostic.operation.replaceAll(' ', '-');
    if (diagnostic?.recovery !== undefined) attributes['threadnote.failure.recovery'] = diagnostic.recovery;
    if (diagnostic?.reason !== undefined) attributes['threadnote.failure.reason'] = diagnostic.reason;
    if (diagnostic?.retryable !== undefined) attributes['threadnote.failure.retryable'] = diagnostic.retryable;
  }
  return Effect.withSpan(Effect.annotateCurrentSpan(attributes), 'threadnote.anonymous-diagnostic', {
    attributes: {},
    captureStackTrace: false,
    root: true,
  }).pipe(
    Effect.provideService(Tracer.Tracer, tracer),
    Effect.withTracerEnabled(true),
    Effect.ignoreCause,
    Effect.withTracerEnabled(false),
  );
}

function completionClassification<A, E>(
  exit: Exit.Exit<A, E>,
  options: AnonymousTelemetryInvocationOptions<A>,
): {
  readonly diagnostic?: AnonymousTelemetryDiagnostic;
  readonly errorType?: string;
  readonly outcome: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
} {
  const result = Result.try(() => unsafeCompletionClassification(exit, options));
  return Result.isSuccess(result) ? result.success : {outcome: Exit.isSuccess(exit) ? 'success' : 'failure'};
}

function unsafeCompletionClassification<A, E>(
  exit: Exit.Exit<A, E>,
  options: AnonymousTelemetryInvocationOptions<A>,
): {
  readonly diagnostic?: AnonymousTelemetryDiagnostic;
  readonly errorType?: string;
  readonly outcome: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable';
} {
  if (Exit.isSuccess(exit)) {
    const reportedOutcome = Result.try(() => options.reportedOutcome?.(exit.value));
    if (Result.isSuccess(reportedOutcome) && reportedOutcome.success !== undefined) {
      const diagnostic = projectAnonymousTelemetryDiagnostic(readAnonymousTelemetryDiagnostic(exit.value));
      return {
        ...(diagnostic === undefined ? {} : {diagnostic}),
        errorType: diagnostic?.errorType ?? closedTelemetryErrorType(options.reportedFailureType ?? 'ReportedError'),
        outcome: reportedOutcome.success,
      };
    }
    const reported = Result.try(() => options.reportedFailure?.(exit.value) === true);
    if (!Result.isSuccess(reported) || !reported.success) return {outcome: 'success'};
    const diagnostic = projectAnonymousTelemetryDiagnostic(readAnonymousTelemetryDiagnostic(exit.value));
    return {
      ...(diagnostic === undefined ? {} : {diagnostic}),
      errorType: diagnostic?.errorType ?? closedTelemetryErrorType(options.reportedFailureType ?? 'ReportedError'),
      outcome: 'failure',
    };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return {outcome: 'interrupted'};
  const error = Cause.squash(exit.cause);
  const diagnostic = projectAnonymousTelemetryDiagnostic(
    readAnonymousTelemetryDiagnostic(error) ?? anonymousTelemetryDiagnosticFromError(error),
  );
  const reportedOutcome = readAnonymousTelemetryReportedOutcome(error);
  return {
    ...(diagnostic === undefined ? {} : {diagnostic}),
    errorType: diagnostic?.errorType ?? 'UnknownError',
    outcome: reportedOutcome ?? 'failure',
  };
}

function telemetryFieldAttributes(fields: AnonymousTelemetryFields | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const attributes: Record<string, unknown> = {};
  const autoUpdateResult = fields.autoUpdateResult;
  if (autoUpdateResult !== undefined && ANONYMOUS_TELEMETRY_AUTO_UPDATE_RESULTS.includes(autoUpdateResult)) {
    attributes['threadnote.auto_update.result'] = autoUpdateResult;
    if (autoUpdateResult === 'updated' && typeof fields.autoUpdateRepairRequired === 'boolean') {
      attributes['threadnote.auto_update.repair_required'] = fields.autoUpdateRepairRequired;
    }
  }
  if (fields.phase !== undefined && ANONYMOUS_TELEMETRY_PHASES.includes(fields.phase)) {
    attributes['threadnote.phase'] = fields.phase;
  }
  if (fields.subphase !== undefined && ANONYMOUS_TELEMETRY_SUBPHASES.includes(fields.subphase)) {
    attributes['threadnote.subphase'] = fields.subphase;
  }
  if (
    fields.contextBriefScope !== undefined &&
    ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_SCOPES.includes(fields.contextBriefScope)
  ) {
    attributes['threadnote.context_brief.scope'] = fields.contextBriefScope;
  }
  if (
    fields.contextBriefContract !== undefined &&
    ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CONTRACTS.includes(fields.contextBriefContract)
  ) {
    attributes['threadnote.context_brief.contract'] = fields.contextBriefContract;
  }
  if (
    fields.contextBriefMode !== undefined &&
    ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_MODES.includes(fields.contextBriefMode)
  ) {
    attributes['threadnote.context_brief.mode'] = fields.contextBriefMode;
  }
  if (
    fields.contextBriefGapClass !== undefined &&
    ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_GAP_CLASSES.includes(fields.contextBriefGapClass)
  ) {
    attributes['threadnote.context_brief.gap_class'] = fields.contextBriefGapClass;
  }
  if (
    fields.contextBriefReturnedLane !== undefined &&
    ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_RETURNED_LANES.includes(fields.contextBriefReturnedLane)
  ) {
    attributes['threadnote.context_brief.returned_lane'] = fields.contextBriefReturnedLane;
  }
  if (
    fields.contextBriefCodeAnchorCoverage !== undefined &&
    ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CODE_ANCHOR_COVERAGES.includes(fields.contextBriefCodeAnchorCoverage)
  ) {
    attributes['threadnote.context_brief.code_anchor_coverage'] = fields.contextBriefCodeAnchorCoverage;
  }
  if (
    fields.contextBriefCitationCoverage !== undefined &&
    ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_COVERAGES.includes(fields.contextBriefCitationCoverage)
  ) {
    attributes['threadnote.context_brief.citation_coverage'] = fields.contextBriefCitationCoverage;
  }
  if (
    fields.contextBriefCitationResult !== undefined &&
    ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_RESULTS.includes(fields.contextBriefCitationResult)
  ) {
    attributes['threadnote.context_brief.citation_result'] = fields.contextBriefCitationResult;
  }
  if (
    fields.contextBriefCitationUnknownReason !== undefined &&
    ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_UNKNOWN_REASONS.includes(fields.contextBriefCitationUnknownReason)
  ) {
    attributes['threadnote.context_brief.citation_unknown_reason'] = fields.contextBriefCitationUnknownReason;
  }
  if (typeof fields.contextBriefOutputTruncated === 'boolean') {
    attributes['threadnote.context_brief.output_truncated'] = fields.contextBriefOutputTruncated;
  }
  if (typeof fields.contextBriefCodeAnchorGap === 'boolean') {
    attributes['threadnote.context_brief.code_anchor_gap'] = fields.contextBriefCodeAnchorGap;
  }
  if (typeof fields.contextBriefRecoveryPresent === 'boolean') {
    attributes['threadnote.context_brief.recovery_present'] = fields.contextBriefRecoveryPresent;
  }
  if (
    fields.codeAnchorFinalizationTrigger !== undefined &&
    ANONYMOUS_TELEMETRY_CODE_ANCHOR_FINALIZATION_TRIGGERS.includes(fields.codeAnchorFinalizationTrigger)
  ) {
    attributes['threadnote.code_anchor_finalization.trigger'] = fields.codeAnchorFinalizationTrigger;
  }
  if (
    fields.codeAnchorFinalizationResult !== undefined &&
    ANONYMOUS_TELEMETRY_CODE_ANCHOR_FINALIZATION_RESULTS.includes(fields.codeAnchorFinalizationResult)
  ) {
    attributes['threadnote.code_anchor_finalization.result'] = fields.codeAnchorFinalizationResult;
  }
  if (
    fields.phaseOutcome !== undefined &&
    ['failure', 'interrupted', 'success', 'timed-out', 'unavailable'].includes(fields.phaseOutcome)
  ) {
    attributes['threadnote.phase.outcome'] = fields.phaseOutcome;
  }
  if (fields.stage !== undefined && ANONYMOUS_TELEMETRY_STAGES.includes(fields.stage)) {
    attributes['threadnote.stage'] = fields.stage;
  }
  if (fields.degradationReason !== undefined && isDegradationReason(fields.degradationReason)) {
    attributes['threadnote.graph.degradation_reason'] = fields.degradationReason;
  }
  if (fields.waitingReason !== undefined && ANONYMOUS_TELEMETRY_WAITING_REASONS.includes(fields.waitingReason)) {
    attributes['threadnote.waiting_reason'] = fields.waitingReason;
  }
  if (fields.buildKind !== undefined && ANONYMOUS_TELEMETRY_GRAPH_BUILD_KINDS.includes(fields.buildKind)) {
    attributes['threadnote.graph.build_kind'] = fields.buildKind;
  }
  if (
    fields.efficiencyClass !== undefined &&
    ANONYMOUS_TELEMETRY_GRAPH_EFFICIENCY_CLASSES.includes(fields.efficiencyClass)
  ) {
    attributes['threadnote.graph.efficiency_class'] = fields.efficiencyClass;
  }
  if (
    fields.fallbackReason !== undefined &&
    ANONYMOUS_TELEMETRY_GRAPH_FALLBACK_REASONS.includes(fields.fallbackReason)
  ) {
    attributes['threadnote.graph.fallback_reason'] = fields.fallbackReason;
  }
  if (fields.mode !== undefined && ANONYMOUS_TELEMETRY_GRAPH_MATERIALIZATION_MODES.includes(fields.mode)) {
    attributes['threadnote.graph.materialization_mode'] = fields.mode;
  }
  if (
    fields.resolutionClosure !== undefined &&
    ANONYMOUS_TELEMETRY_GRAPH_RESOLUTION_CLOSURES.includes(fields.resolutionClosure)
  ) {
    attributes['threadnote.graph.resolution_closure'] = fields.resolutionClosure;
  }
  if (fields.requestKind !== undefined && ANONYMOUS_TELEMETRY_GRAPH_REQUEST_KINDS.includes(fields.requestKind)) {
    attributes['threadnote.graph.request_kind'] = fields.requestKind;
  }
  if (fields.requestScope !== undefined && ANONYMOUS_TELEMETRY_GRAPH_REQUEST_SCOPES.includes(fields.requestScope)) {
    attributes['threadnote.graph.request_scope'] = fields.requestScope;
  }
  if (
    fields.snapshotFreshness !== undefined &&
    ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_FRESHNESS.includes(fields.snapshotFreshness)
  ) {
    attributes['threadnote.graph.snapshot_freshness'] = fields.snapshotFreshness;
  }
  if (
    fields.snapshotSelection !== undefined &&
    ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_SELECTIONS.includes(fields.snapshotSelection)
  ) {
    attributes['threadnote.graph.snapshot_selection'] = fields.snapshotSelection;
  }
  for (const [key, attribute] of Object.entries(GRAPH_QUANTITY_BUCKET_ATTRIBUTE_KEYS)) {
    const value = recordValue(fields, key);
    if (isQuantityBucket(value)) Reflect.set(attributes, attribute, value);
  }
  for (const [key, attribute] of Object.entries(CONTEXT_BRIEF_QUANTITY_BUCKET_ATTRIBUTE_KEYS)) {
    const value = recordValue(fields, key);
    if (isQuantityBucket(value)) Reflect.set(attributes, attribute, value);
  }
  for (const [key, attribute] of Object.entries(CODE_ANCHOR_FINALIZATION_QUANTITY_BUCKET_ATTRIBUTE_KEYS)) {
    const value = recordValue(fields, key);
    if (isQuantityBucket(value)) Reflect.set(attributes, attribute, value);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (
      key === 'phase' ||
      key === 'phaseOutcome' ||
      key === 'degradationReason' ||
      key === 'stage' ||
      key === 'subphase' ||
      key === 'waitingReason' ||
      value === undefined
    )
      continue;
    if (!Number.isFinite(value) || value < 0) continue;
    const attribute = recordValue(FIELD_ATTRIBUTE_KEYS, key);
    if (typeof attribute !== 'string') continue;
    Reflect.set(attributes, attribute, QUANTITY_FIELD_KEYS.has(key) ? quantityBucket(value) : boundedNumber(value));
  }
  return attributes;
}

type NumericTelemetryField = Exclude<
  keyof AnonymousTelemetryFields,
  | CodeAnchorFinalizationQuantityBucketField
  | ContextBriefQuantityBucketField
  | GraphQuantityBucketField
  | 'autoUpdateRepairRequired'
  | 'autoUpdateResult'
  | 'buildKind'
  | 'codeAnchorFinalizationResult'
  | 'codeAnchorFinalizationTrigger'
  | 'contextBriefCodeAnchorCoverage'
  | 'contextBriefCodeAnchorGap'
  | 'contextBriefContract'
  | 'contextBriefGapClass'
  | 'contextBriefCitationCoverage'
  | 'contextBriefCitationResult'
  | 'contextBriefCitationUnknownReason'
  | 'contextBriefOutputTruncated'
  | 'contextBriefMode'
  | 'contextBriefRecoveryPresent'
  | 'contextBriefReturnedLane'
  | 'contextBriefScope'
  | 'degradationReason'
  | 'efficiencyClass'
  | 'fallbackReason'
  | 'mode'
  | 'phase'
  | 'phaseOutcome'
  | 'requestKind'
  | 'requestScope'
  | 'resolutionClosure'
  | 'snapshotFreshness'
  | 'snapshotSelection'
  | 'stage'
  | 'subphase'
  | 'waitingReason'
>;

type CodeAnchorFinalizationQuantityBucketField =
  | 'codeAnchorFinalizationConflictBucket'
  | 'codeAnchorFinalizationFailedBucket'
  | 'codeAnchorFinalizationFinalizedBucket'
  | 'codeAnchorFinalizationLatencyMillisecondsBucket'
  | 'codeAnchorFinalizationMatchedBucket'
  | 'codeAnchorFinalizationPendingBucket'
  | 'codeAnchorFinalizationScannedBucket';

type GraphQuantityBucketField =
  | 'cachedFactReplayBytesBucket'
  | 'changedFactBytesBucket'
  | 'changedFilesBucket'
  | 'deletedFilesBucket'
  | 'deltaFilesBucket'
  | 'extractedFilesBucket'
  | 'factReplayAmplificationBucket'
  | 'finalFactBytesBucket'
  | 'reusedFilesBucket'
  | 'rewriteAmplificationBucket'
  | 'snapshotEdgesBucket'
  | 'snapshotFilesBucket'
  | 'snapshotSymbolsBucket'
  | 'stagedFilesBucket'
  | 'totalFilesBucket';

type ContextBriefQuantityBucketField =
  | 'contextBriefCacheHitsBucket'
  | 'contextBriefCodeAnchorsMatchedMemoriesBucket'
  | 'contextBriefCodeAnchorsRequestedBucket'
  | 'contextBriefCodeAnchorsResolvedBucket'
  | 'contextBriefCitationsBucket'
  | 'contextBriefCitedMemoriesBucket'
  | 'contextBriefExactCitationsBucket'
  | 'contextBriefRelocatedCitationsBucket'
  | 'contextBriefRepositoriesValidatedBucket'
  | 'contextBriefStaleCitationsBucket'
  | 'contextBriefUnknownCitationsBucket';

const CONTEXT_BRIEF_QUANTITY_BUCKET_ATTRIBUTE_KEYS: Readonly<Record<ContextBriefQuantityBucketField, string>> = {
  contextBriefCacheHitsBucket: 'threadnote.context_brief.cache_hits_bucket',
  contextBriefCodeAnchorsMatchedMemoriesBucket: 'threadnote.context_brief.code_anchors_matched_memories_bucket',
  contextBriefCodeAnchorsRequestedBucket: 'threadnote.context_brief.code_anchors_requested_bucket',
  contextBriefCodeAnchorsResolvedBucket: 'threadnote.context_brief.code_anchors_resolved_bucket',
  contextBriefCitationsBucket: 'threadnote.context_brief.citations_bucket',
  contextBriefCitedMemoriesBucket: 'threadnote.context_brief.cited_memories_bucket',
  contextBriefExactCitationsBucket: 'threadnote.context_brief.exact_citations_bucket',
  contextBriefRelocatedCitationsBucket: 'threadnote.context_brief.relocated_citations_bucket',
  contextBriefRepositoriesValidatedBucket: 'threadnote.context_brief.repositories_validated_bucket',
  contextBriefStaleCitationsBucket: 'threadnote.context_brief.stale_citations_bucket',
  contextBriefUnknownCitationsBucket: 'threadnote.context_brief.unknown_citations_bucket',
};

const CODE_ANCHOR_FINALIZATION_QUANTITY_BUCKET_ATTRIBUTE_KEYS: Readonly<
  Record<CodeAnchorFinalizationQuantityBucketField, string>
> = {
  codeAnchorFinalizationConflictBucket: 'threadnote.code_anchor_finalization.conflict_bucket',
  codeAnchorFinalizationFailedBucket: 'threadnote.code_anchor_finalization.failed_bucket',
  codeAnchorFinalizationFinalizedBucket: 'threadnote.code_anchor_finalization.finalized_bucket',
  codeAnchorFinalizationLatencyMillisecondsBucket: 'threadnote.code_anchor_finalization.latency_ms_bucket',
  codeAnchorFinalizationMatchedBucket: 'threadnote.code_anchor_finalization.matched_bucket',
  codeAnchorFinalizationPendingBucket: 'threadnote.code_anchor_finalization.pending_bucket',
  codeAnchorFinalizationScannedBucket: 'threadnote.code_anchor_finalization.scanned_bucket',
};

const GRAPH_QUANTITY_BUCKET_ATTRIBUTE_KEYS: Readonly<Record<GraphQuantityBucketField, string>> = {
  cachedFactReplayBytesBucket: 'threadnote.graph.cached_fact_replay_bytes_bucket',
  changedFactBytesBucket: 'threadnote.graph.changed_fact_bytes_bucket',
  changedFilesBucket: 'threadnote.graph.changed_files_bucket',
  deletedFilesBucket: 'threadnote.graph.deleted_files_bucket',
  deltaFilesBucket: 'threadnote.graph.delta_files_bucket',
  extractedFilesBucket: 'threadnote.graph.extracted_files_bucket',
  factReplayAmplificationBucket: 'threadnote.graph.fact_replay_amplification_bucket',
  finalFactBytesBucket: 'threadnote.graph.final_fact_bytes_bucket',
  reusedFilesBucket: 'threadnote.graph.reused_files_bucket',
  rewriteAmplificationBucket: 'threadnote.graph.rewrite_amplification_bucket',
  snapshotEdgesBucket: 'threadnote.graph.snapshot_edges_bucket',
  snapshotFilesBucket: 'threadnote.graph.snapshot_files_bucket',
  snapshotSymbolsBucket: 'threadnote.graph.snapshot_symbols_bucket',
  stagedFilesBucket: 'threadnote.graph.staged_files_bucket',
  totalFilesBucket: 'threadnote.graph.total_files_bucket',
};

const FIELD_ATTRIBUTE_KEYS: Readonly<Record<NumericTelemetryField, string>> = {
  batchesCompleted: 'threadnote.work.batches_completed_bucket',
  batchesTotal: 'threadnote.work.batches_total_bucket',
  completed: 'threadnote.work.completed_bucket',
  degradedFiles: 'threadnote.work.degraded_files_bucket',
  elapsedMilliseconds: 'threadnote.phase.elapsed_ms',
  extractionMilliseconds: 'threadnote.phase.extraction_ms',
  factsBytesCompleted: 'threadnote.work.facts_bytes_completed_bucket',
  factsBytesTotal: 'threadnote.work.facts_bytes_total_bucket',
  operationElapsedMilliseconds: 'threadnote.operation.elapsed_ms',
  persistenceMilliseconds: 'threadnote.phase.persistence_ms',
  readingMilliseconds: 'threadnote.phase.reading_ms',
  sourceBytesCompleted: 'threadnote.work.source_bytes_completed_bucket',
  sourceBytesTotal: 'threadnote.work.source_bytes_total_bucket',
  stageElapsedMilliseconds: 'threadnote.phase.stage_elapsed_ms',
  total: 'threadnote.work.total_bucket',
  transactionMilliseconds: 'threadnote.phase.transaction_ms',
  workUnitsCompleted: 'threadnote.work.units_completed_bucket',
  workUnitsTotal: 'threadnote.work.units_total_bucket',
};

const QUANTITY_FIELD_KEYS: ReadonlySet<string> = new Set<NumericTelemetryField>([
  'batchesCompleted',
  'batchesTotal',
  'completed',
  'degradedFiles',
  'factsBytesCompleted',
  'factsBytesTotal',
  'sourceBytesCompleted',
  'sourceBytesTotal',
  'total',
  'workUnitsCompleted',
  'workUnitsTotal',
]);

function mergeTelemetryFields(
  current: AnonymousTelemetryFields,
  next: AnonymousTelemetryFields,
): AnonymousTelemetryFields {
  const phaseChanged = next.phase !== undefined && next.phase !== current.phase;
  const stageChanged = next.stage !== undefined && next.stage !== current.stage;
  const merged: AnonymousTelemetryFields = {
    ...current,
    ...(phaseChanged
      ? {
          elapsedMilliseconds: undefined,
          extractionMilliseconds: undefined,
          persistenceMilliseconds: undefined,
          phaseOutcome: undefined,
          readingMilliseconds: undefined,
          stage: undefined,
          stageElapsedMilliseconds: undefined,
          subphase: undefined,
          transactionMilliseconds: undefined,
          waitingReason: undefined,
        }
      : {}),
    ...(stageChanged ? {stageElapsedMilliseconds: undefined, transactionMilliseconds: undefined} : {}),
  };
  for (const [key, value] of recordEntries(next)) {
    if (value === undefined) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) continue;
      const previous = recordValue(merged, key);
      Reflect.set(merged, key, typeof previous === 'number' ? Math.max(previous, value) : value);
    } else if (
      (key === 'autoUpdateRepairRequired' && typeof value === 'boolean') ||
      (key === 'autoUpdateResult' && isOneOf(value, ANONYMOUS_TELEMETRY_AUTO_UPDATE_RESULTS)) ||
      (key === 'codeAnchorFinalizationTrigger' &&
        isOneOf(value, ANONYMOUS_TELEMETRY_CODE_ANCHOR_FINALIZATION_TRIGGERS)) ||
      (key === 'codeAnchorFinalizationResult' &&
        isOneOf(value, ANONYMOUS_TELEMETRY_CODE_ANCHOR_FINALIZATION_RESULTS)) ||
      (key === 'contextBriefCodeAnchorGap' && typeof value === 'boolean') ||
      (key === 'contextBriefRecoveryPresent' && typeof value === 'boolean') ||
      (key === 'contextBriefOutputTruncated' && typeof value === 'boolean') ||
      (key === 'contextBriefContract' && isOneOf(value, ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CONTRACTS)) ||
      (key === 'contextBriefMode' && isOneOf(value, ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_MODES)) ||
      (key === 'contextBriefGapClass' && isOneOf(value, ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_GAP_CLASSES)) ||
      (key === 'contextBriefReturnedLane' && isOneOf(value, ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_RETURNED_LANES)) ||
      (key === 'contextBriefCodeAnchorCoverage' &&
        isOneOf(value, ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CODE_ANCHOR_COVERAGES)) ||
      (key === 'contextBriefScope' && isOneOf(value, ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_SCOPES)) ||
      (key === 'contextBriefCitationCoverage' &&
        isOneOf(value, ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_COVERAGES)) ||
      (key === 'contextBriefCitationResult' && isOneOf(value, ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_RESULTS)) ||
      (key === 'contextBriefCitationUnknownReason' &&
        isOneOf(value, ANONYMOUS_TELEMETRY_CONTEXT_BRIEF_CITATION_UNKNOWN_REASONS)) ||
      (key === 'phase' && isOneOf(value, ANONYMOUS_TELEMETRY_PHASES)) ||
      (key === 'subphase' && isOneOf(value, ANONYMOUS_TELEMETRY_SUBPHASES)) ||
      (key === 'phaseOutcome' && isOneOf(value, ['failure', 'interrupted', 'success', 'timed-out', 'unavailable'])) ||
      (key === 'degradationReason' && typeof value === 'string' && isDegradationReason(value)) ||
      (key === 'stage' && isOneOf(value, ANONYMOUS_TELEMETRY_STAGES)) ||
      (key === 'waitingReason' && isOneOf(value, ANONYMOUS_TELEMETRY_WAITING_REASONS)) ||
      (key === 'requestKind' && isOneOf(value, ANONYMOUS_TELEMETRY_GRAPH_REQUEST_KINDS)) ||
      (key === 'requestScope' && isOneOf(value, ANONYMOUS_TELEMETRY_GRAPH_REQUEST_SCOPES)) ||
      (key === 'snapshotFreshness' && isOneOf(value, ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_FRESHNESS)) ||
      (key === 'snapshotSelection' && isOneOf(value, ANONYMOUS_TELEMETRY_GRAPH_SNAPSHOT_SELECTIONS)) ||
      ((key in GRAPH_QUANTITY_BUCKET_ATTRIBUTE_KEYS ||
        key in CONTEXT_BRIEF_QUANTITY_BUCKET_ATTRIBUTE_KEYS ||
        key in CODE_ANCHOR_FINALIZATION_QUANTITY_BUCKET_ATTRIBUTE_KEYS) &&
        isQuantityBucket(value))
    ) {
      Reflect.set(merged, key, value);
    }
  }
  return merged;
}

/** Result-derived Context Brief classifications are terminal-success-only. */
function completionTelemetryFields(
  fields: AnonymousTelemetryFields,
  outcome: 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable',
): AnonymousTelemetryFields {
  if (outcome === 'success') return fields;
  const {
    contextBriefCacheHitsBucket: _cacheHits,
    contextBriefCodeAnchorCoverage: _codeAnchorCoverage,
    contextBriefCodeAnchorGap: _codeAnchorGap,
    contextBriefCodeAnchorsMatchedMemoriesBucket: _codeAnchorMatchedMemories,
    contextBriefCodeAnchorsRequestedBucket: _codeAnchorsRequested,
    contextBriefCodeAnchorsResolvedBucket: _codeAnchorsResolved,
    contextBriefGapClass: _gapClass,
    contextBriefCitationCoverage: _coverage,
    contextBriefCitationResult: _result,
    contextBriefCitationUnknownReason: _unknownReason,
    contextBriefCitationsBucket: _citations,
    contextBriefCitedMemoriesBucket: _citedMemories,
    contextBriefExactCitationsBucket: _exact,
    contextBriefOutputTruncated: _truncated,
    contextBriefRecoveryPresent: _recoveryPresent,
    contextBriefReturnedLane: _returnedLane,
    contextBriefRelocatedCitationsBucket: _relocated,
    contextBriefRepositoriesValidatedBucket: _repositories,
    contextBriefStaleCitationsBucket: _stale,
    contextBriefUnknownCitationsBucket: _unknown,
    ...safeFields
  } = fields;
  return safeFields;
}

function safeMemoryUsage(system: SystemInfoShape) {
  const result = Result.try(() => system.memoryUsage());
  if (!Result.isSuccess(result)) return undefined;
  return {
    external: boundedNumber(result.success.external),
    heapUsed: boundedNumber(result.success.heapUsed),
    peakRss: boundedNumber(result.success.peakRss ?? result.success.rss),
    rss: boundedNumber(result.success.rss),
  };
}

function memoryAttributes(
  start: ReturnType<typeof safeMemoryUsage>,
  end?: ReturnType<typeof safeMemoryUsage>,
): Record<string, unknown> {
  if (start === undefined) return {};
  return {
    'threadnote.memory.external.start_bucket': byteBucket(start.external),
    'threadnote.memory.heap.start_bucket': byteBucket(start.heapUsed),
    'threadnote.memory.peak_rss.start_bucket': byteBucket(start.peakRss),
    'threadnote.memory.rss.start_bucket': byteBucket(start.rss),
    ...(end === undefined
      ? {}
      : {
          'threadnote.memory.external.end_bucket': byteBucket(end.external),
          'threadnote.memory.heap.end_bucket': byteBucket(end.heapUsed),
          'threadnote.memory.peak_rss.end_bucket': byteBucket(end.peakRss),
          'threadnote.memory.rss.end_bucket': byteBucket(end.rss),
        }),
  };
}

function currentMemoryAttributes(current: ReturnType<typeof safeMemoryUsage>): Record<string, unknown> {
  if (current === undefined) return {};
  return {
    'threadnote.memory.external.current_bucket': byteBucket(current.external),
    'threadnote.memory.heap.current_bucket': byteBucket(current.heapUsed),
    'threadnote.memory.peak_rss.current_bucket': byteBucket(current.peakRss),
    'threadnote.memory.rss.current_bucket': byteBucket(current.rss),
  };
}

function byteBucket(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes < 32) return '<32MiB';
  if (mebibytes < 64) return '32-64MiB';
  if (mebibytes < 128) return '64-128MiB';
  if (mebibytes < 256) return '128-256MiB';
  if (mebibytes < 512) return '256-512MiB';
  if (mebibytes < 1_024) return '512MiB-1GiB';
  if (mebibytes < 2_048) return '1-2GiB';
  if (mebibytes < 4_096) return '2-4GiB';
  return '>=4GiB';
}

function quantityBucket(value: number): string {
  if (value <= 0) return '0';
  const exponent = Math.min(52, Math.floor(Math.log2(value)));
  return `2^${exponent}`;
}

function recordValue(record: object, key: string): unknown {
  for (const [candidateKey, value] of recordEntries(record)) {
    if (candidateKey === key) return value;
  }
  return undefined;
}

function recordEntries(record: object): readonly (readonly [string, unknown])[] {
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(record)) entries.push([key, Reflect.get(record, key)]);
  return entries;
}

function isOneOf<const Values extends readonly string[]>(value: unknown, options: Values): value is Values[number] {
  return typeof value === 'string' && options.some(option => option === value);
}

function isQuantityBucket(value: unknown): value is AnonymousTelemetryQuantityBucket {
  if (typeof value !== 'string') return false;
  if (value === '0') return true;
  const match = /^2\^(\d{1,2})$/u.exec(value);
  if (match === null) return false;
  const exponent = Number(match[1]);
  return Number.isInteger(exponent) && exponent >= 0 && exponent <= 52;
}

function boundedNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))) : 0;
}

function safeRuntimeLabel(value: string): string {
  return /^[A-Za-z0-9_.-]{1,40}$/u.test(value) ? value : 'unknown';
}

function safeVersion(value: string): string {
  return value.length <= TELEMETRY_VERSION_MAX_BYTES &&
    /^(?:unknown|[0-9]+(?:\.[0-9]+){0,3}(?:[-+][0-9A-Za-z.-]{1,64})?|test)$/u.test(value)
    ? value
    : 'unknown';
}

function safeAgentSessionId(value: string): string {
  return /^tns_[\da-f]{32}$/u.test(value) ? value : 'tns_00000000000000000000000000000000';
}

function safeCorrelationScope(value: string): 'broker' | 'invocation' | 'provider-session' {
  return value === 'broker' || value === 'provider-session' ? value : 'invocation';
}

function safeAnonymousInvocationId(): string | undefined {
  const generated = Result.try(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return `tni_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  });
  return Result.isSuccess(generated) ? generated.success : undefined;
}

function optionalInvocationId(factory: () => string | undefined): string | undefined {
  const generated = Result.try(factory);
  if (!Result.isSuccess(generated) || generated.success === undefined) return undefined;
  return /^tni_[\da-f]{24}$/u.test(generated.success) ? generated.success : undefined;
}

function safeInvocationId(value: string): string {
  return /^tni_[\da-f]{24}$/u.test(value) ? value : 'tni_000000000000000000000000';
}

function safeComponent(value: unknown): 'cli' | 'mcp' {
  return value === 'mcp' ? 'mcp' : 'cli';
}

function safeEvent(value: unknown): 'checkpoint' | 'completion' | 'lifecycle' {
  return value === 'checkpoint' || value === 'lifecycle' ? value : 'completion';
}

function safeOutcome(value: unknown): 'failure' | 'interrupted' | 'success' | 'timed-out' | 'unavailable' {
  return value === 'failure' || value === 'interrupted' || value === 'timed-out' || value === 'unavailable'
    ? value
    : 'success';
}

function isDegradationReason(value: unknown): value is NonNullable<AnonymousTelemetryFields['degradationReason']> {
  return (
    value === 'abort' ||
    value === 'allocation' ||
    value === 'exit' ||
    value === 'fact-bytes' ||
    value === 'operation' ||
    value === 'protocol' ||
    value === 'rss' ||
    value === 'source-bytes' ||
    value === 'spawn' ||
    value === 'symbols' ||
    value === 'timeout' ||
    value === 'write'
  );
}
