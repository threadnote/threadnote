import {Array as EffectArray} from 'effect';
import {isReadonlyArray} from '@threadnote/platform/readonly-array';
import {Effect, Result} from 'effect';
import {
  recordAnonymousTelemetryFields,
  withAnonymousTelemetryCheckpoint,
  type AnonymousTelemetryContextBriefContract,
  type AnonymousTelemetryContextBriefCitationCoverage,
  type AnonymousTelemetryContextBriefCitationResult,
  type AnonymousTelemetryContextBriefCitationUnknownReason,
  type AnonymousTelemetryContextBriefScope,
  type AnonymousTelemetryContextBriefMode,
  type AnonymousTelemetryContextBriefReturnedLane,
  type AnonymousTelemetryFields,
  type AnonymousTelemetryQuantityBucket,
} from '../effect/telemetry.js';

export interface ContextBriefCitationTelemetrySummary {
  readonly cacheHits: number;
  readonly citations: number;
  readonly citedMemories: number;
  readonly coverage: AnonymousTelemetryContextBriefCitationCoverage;
  readonly exactCitations: number;
  readonly relocatedCitations: number;
  readonly repositoriesValidated: number;
  readonly staleCitations: number;
  readonly unknownCitations: number;
  readonly unknownReason?: AnonymousTelemetryContextBriefCitationUnknownReason;
}

export interface ContextBriefCodeAnchorTelemetrySummary {
  readonly complete: boolean;
  /** Private compiler gap codes; classified to a closed enum and never exported. */
  readonly gaps: readonly string[];
  readonly matchedMemories: number;
  readonly recoveryPresent: boolean;
  readonly requested: number;
  readonly resolved: number;
}

export interface ContextBriefRequestTelemetry {
  readonly contract: AnonymousTelemetryContextBriefContract;
  readonly mode: AnonymousTelemetryContextBriefMode;
}

export interface ContextBriefAnonymousTelemetryReporter {
  /** Records only the local/workset classification on the invocation recorder. */
  readonly annotate: Effect.Effect<void>;
  readonly citationValidation: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    summarize: ContextBriefCitationTelemetrySummary | ((value: A) => ContextBriefCitationTelemetrySummary),
  ) => Effect.Effect<A, E, R>;
  readonly graph: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    outcome?: (value: A) => 'success' | 'unavailable',
  ) => Effect.Effect<A, E, R>;
  readonly codeLinkedMemory: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    outcome?: (value: A) => 'success' | 'unavailable',
  ) => Effect.Effect<A, E, R>;
  readonly memory: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly projection: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    outputTruncated: boolean | ((value: A) => boolean),
    codeAnchors?: ContextBriefCodeAnchorTelemetrySummary | ((value: A) => ContextBriefCodeAnchorTelemetrySummary),
    returnedLane?:
      AnonymousTelemetryContextBriefReturnedLane | ((value: A) => AnonymousTelemetryContextBriefReturnedLane),
  ) => Effect.Effect<A, E, R>;
}

/**
 * Maps exact private counters to the schema-v5 0-or-power-of-two surface.
 * Invalid or internally inconsistent observations abstain instead of emitting
 * a partial result that could be mistaken for a complete quality sample.
 */
export function contextBriefCitationTelemetryFields(
  scope: AnonymousTelemetryContextBriefScope,
  summary: ContextBriefCitationTelemetrySummary,
): AnonymousTelemetryFields | undefined {
  const counts = [
    summary.cacheHits,
    summary.citations,
    summary.citedMemories,
    summary.exactCitations,
    summary.relocatedCitations,
    summary.repositoriesValidated,
    summary.staleCitations,
    summary.unknownCitations,
  ];
  if (!EffectArray.every(counts, isPrivateCount)) return undefined;
  if (
    summary.citedMemories > summary.citations ||
    summary.cacheHits > summary.citations ||
    summary.repositoriesValidated > summary.citations
  ) {
    return undefined;
  }
  const classifiedCitations =
    summary.exactCitations + summary.relocatedCitations + summary.staleCitations + summary.unknownCitations;
  if (classifiedCitations !== summary.citations) return undefined;
  const expectedCoverage =
    summary.citations === 0
      ? 'none'
      : summary.unknownCitations === 0
        ? 'complete'
        : summary.unknownCitations === summary.citations
          ? 'unavailable'
          : 'partial';
  if (
    summary.coverage !== expectedCoverage ||
    (summary.unknownCitations === 0 && summary.unknownReason !== undefined) ||
    (summary.unknownCitations > 0 && summary.unknownReason === undefined)
  ) {
    return undefined;
  }

  return {
    contextBriefCacheHitsBucket: contextBriefTelemetryQuantityBucket(summary.cacheHits),
    contextBriefCitationCoverage: summary.coverage,
    contextBriefCitationResult: contextBriefCitationResult(summary),
    ...(summary.unknownReason === undefined ? {} : {contextBriefCitationUnknownReason: summary.unknownReason}),
    contextBriefCitationsBucket: contextBriefTelemetryQuantityBucket(summary.citations),
    contextBriefCitedMemoriesBucket: contextBriefTelemetryQuantityBucket(summary.citedMemories),
    contextBriefExactCitationsBucket: contextBriefTelemetryQuantityBucket(summary.exactCitations),
    contextBriefRelocatedCitationsBucket: contextBriefTelemetryQuantityBucket(summary.relocatedCitations),
    contextBriefRepositoriesValidatedBucket: contextBriefTelemetryQuantityBucket(summary.repositoriesValidated),
    contextBriefScope: scope,
    contextBriefStaleCitationsBucket: contextBriefTelemetryQuantityBucket(summary.staleCitations),
    contextBriefUnknownCitationsBucket: contextBriefTelemetryQuantityBucket(summary.unknownCitations),
  };
}

/** Coarse monotone bucket; exact counts never leave the process. */
export function contextBriefTelemetryQuantityBucket(value: number): AnonymousTelemetryQuantityBucket | undefined {
  if (!isPrivateCount(value)) return undefined;
  return value === 0 ? '0' : `2^${Math.floor(Math.log2(value))}`;
}

/** Project the v3 anchor round trip without admitting selectors, ordinals, or memory identities. */
export function contextBriefCodeAnchorTelemetryFields(
  summary: ContextBriefCodeAnchorTelemetrySummary,
  outputTruncated = false,
): AnonymousTelemetryFields | undefined {
  if (
    typeof summary.complete !== 'boolean' ||
    typeof summary.recoveryPresent !== 'boolean' ||
    !isReadonlyArray(summary.gaps) ||
    !EffectArray.every(summary.gaps, gap => typeof gap === 'string') ||
    !EffectArray.every([summary.requested, summary.resolved, summary.matchedMemories], isPrivateCount) ||
    summary.requested === 0 ||
    summary.resolved > summary.requested ||
    summary.complete !== (summary.resolved === summary.requested)
  ) {
    return undefined;
  }
  const resolutionUnavailable = EffectArray.some(summary.gaps, gap =>
    ['code-anchor-ref-unsupported', 'code-anchor-resolution-unavailable', 'code-anchor-scope-unsupported'].includes(
      gap,
    ),
  );
  const unavailable =
    resolutionUnavailable ||
    EffectArray.some(summary.gaps, gap =>
      ['code-anchor-recall-unavailable', 'code-anchor-selector-matches-unvalidated'].includes(gap),
    );
  const unresolved = !summary.complete && !resolutionUnavailable;
  const truncated = outputTruncated || summary.gaps.includes('code-anchor-recall-truncated');
  const gapClasses = [
    ...(unavailable ? (['unavailable'] as const) : []),
    ...(unresolved ? (['unresolved'] as const) : []),
    ...(truncated ? (['truncated'] as const) : []),
  ];
  const gapClass = gapClasses.length === 0 ? 'none' : gapClasses.length === 1 ? gapClasses[0] : 'mixed';
  return {
    contextBriefCodeAnchorCoverage: resolutionUnavailable ? 'unavailable' : summary.complete ? 'complete' : 'partial',
    contextBriefCodeAnchorGap: gapClass !== 'none',
    contextBriefGapClass: gapClass,
    contextBriefCodeAnchorsMatchedMemoriesBucket: contextBriefTelemetryQuantityBucket(summary.matchedMemories),
    contextBriefCodeAnchorsRequestedBucket: contextBriefTelemetryQuantityBucket(summary.requested),
    contextBriefCodeAnchorsResolvedBucket: contextBriefTelemetryQuantityBucket(summary.resolved),
    contextBriefRecoveryPresent: summary.recoveryPresent,
  };
}

/**
 * Independent reporter foundation. Context Brief wiring owns only the phase
 * boundaries and a selector for its successful result; this module owns the
 * privacy projection and never receives task text, paths, identities, or raw
 * failures.
 */
export function makeContextBriefAnonymousTelemetryReporter(
  scope: AnonymousTelemetryContextBriefScope,
  request: ContextBriefRequestTelemetry = {contract: 'task-only-v2', mode: 'brief'},
): ContextBriefAnonymousTelemetryReporter {
  let retainedCitationFields: AnonymousTelemetryFields | undefined;
  const requestFields = {
    contextBriefContract: request.contract,
    contextBriefMode: request.mode,
    contextBriefScope: scope,
  } as const;
  const checkpoint = <A, E, R>(
    phase: 'context.brief.code-linked-memory' | 'context.brief.graph' | 'context.brief.memory',
    effect: Effect.Effect<A, E, R>,
    outcome?: (value: A) => 'success' | 'unavailable',
  ) =>
    withAnonymousTelemetryCheckpoint(
      {
        fields: {...requestFields, phase},
        retainFields: false,
        ...(outcome === undefined ? {} : {successOutcome: outcome}),
      },
      effect,
    );

  return {
    annotate: recordAnonymousTelemetryFields(requestFields),
    citationValidation: (effect, summarize) => {
      const measured = Effect.sync(() => {
        retainedCitationFields = undefined;
      }).pipe(
        Effect.andThen(effect),
        Effect.map(value => {
          const projection = Result.try(() =>
            contextBriefCitationTelemetryFields(scope, typeof summarize === 'function' ? summarize(value) : summarize),
          );
          return {
            fields: Result.isSuccess(projection) ? projection.success : undefined,
            value,
          } as const;
        }),
      );
      return withAnonymousTelemetryCheckpoint(
        {
          fields: {...requestFields, phase: 'context.brief.citation-validation'},
          retainFields: false,
          successFields: measuredValue => measuredValue.fields ?? {},
          successOutcome: measuredValue => (measuredValue.fields === undefined ? 'unavailable' : 'success'),
        },
        measured,
      ).pipe(
        Effect.tap(measuredValue =>
          Effect.sync(() => {
            retainedCitationFields = measuredValue.fields;
          }),
        ),
        Effect.map(measuredValue => measuredValue.value),
      );
    },
    codeLinkedMemory: (effect, outcome) => checkpoint('context.brief.code-linked-memory', effect, outcome),
    graph: (effect, outcome) => checkpoint('context.brief.graph', effect, outcome),
    memory: effect => checkpoint('context.brief.memory', effect),
    projection: (effect, outputTruncated, codeAnchors, returnedLane) => {
      const measured = effect.pipe(
        Effect.map(value => {
          const projection = Result.try(() =>
            typeof outputTruncated === 'function' ? outputTruncated(value) : outputTruncated,
          );
          const truncated =
            Result.isSuccess(projection) && typeof projection.success === 'boolean' ? projection.success : undefined;
          const anchorProjection =
            codeAnchors === undefined || truncated === undefined
              ? Result.succeed(undefined)
              : Result.try(() =>
                  contextBriefCodeAnchorTelemetryFields(
                    typeof codeAnchors === 'function' ? codeAnchors(value) : codeAnchors,
                    truncated,
                  ),
                );
          const anchorFields = Result.isSuccess(anchorProjection) ? anchorProjection.success : undefined;
          const laneProjection =
            returnedLane === undefined
              ? Result.succeed(undefined)
              : Result.try(() => (typeof returnedLane === 'function' ? returnedLane(value) : returnedLane));
          const lane = Result.isSuccess(laneProjection) ? laneProjection.success : undefined;
          return {anchorFields, lane, truncated, value} as const;
        }),
      );
      return withAnonymousTelemetryCheckpoint(
        {
          fields: {...requestFields, phase: 'context.brief.projection'},
          retainFields: false,
          successFields: measuredValue =>
            measuredValue.truncated === undefined
              ? {}
              : {
                  ...measuredValue.anchorFields,
                  contextBriefOutputTruncated: measuredValue.truncated,
                  ...(measuredValue.lane === undefined ? {} : {contextBriefReturnedLane: measuredValue.lane}),
                },
          successOutcome: measuredValue =>
            measuredValue.truncated === undefined ||
            (codeAnchors !== undefined && measuredValue.anchorFields === undefined) ||
            (returnedLane !== undefined && measuredValue.lane === undefined)
              ? 'unavailable'
              : 'success',
        },
        measured,
      ).pipe(
        Effect.tap(measuredValue =>
          measuredValue.truncated === undefined || retainedCitationFields === undefined
            ? Effect.void
            : recordAnonymousTelemetryFields({
                ...retainedCitationFields,
                ...measuredValue.anchorFields,
                contextBriefOutputTruncated: measuredValue.truncated,
                ...(measuredValue.lane === undefined ? {} : {contextBriefReturnedLane: measuredValue.lane}),
                ...requestFields,
                phase: 'context.brief.projection',
              }),
        ),
        Effect.map(measuredValue => measuredValue.value),
      );
    },
  };
}

function contextBriefCitationResult(
  summary: ContextBriefCitationTelemetrySummary,
): AnonymousTelemetryContextBriefCitationResult {
  if (summary.citations === 0) return 'none';
  if (summary.staleCitations > 0 && summary.unknownCitations > 0) return 'mixed';
  if (summary.staleCitations > 0) return 'stale';
  if (summary.unknownCitations > 0) return 'unknown';
  if (summary.relocatedCitations > 0) return 'relocated';
  return 'exact-only';
}

function isPrivateCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
