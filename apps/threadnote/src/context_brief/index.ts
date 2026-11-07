import {Array as EffectArray} from 'effect';
import {
  compileContextBriefWith,
  retrieveSemanticContextSourceEvidence,
  retrieveSemanticContextSymbol,
  filterSemanticContextMemory,
  projectSemanticContextKnowledge,
  type ContextBriefCompilerDependencies,
} from '@threadnote/context/compiler';
import type {Evidence} from '@threadnote/semantic/contracts';
export {compileContextBriefWith, type ContextBriefCompilerDependencies} from '@threadnote/context/compiler';
import {Clock, DateTime, Effect, Exit, Schema} from 'effect';
import {CodeGraphScopeRoutingError} from '@threadnote/graph/scope/routing';
import {withReadyRecallReadBoundary} from '../recall/ready_read_boundary.js';
import {ReadDeadlineExceeded, isReadCleanupUnconfirmed, type ReadDeadline} from '@threadnote/platform/read_deadline';
import {RecallReadyReadUnavailable} from '@threadnote/recall/index';
import {
  withNativeContextBriefReadSources,
  type ContextBriefNativeSemanticRead,
  type ContextBriefNativeSemanticState,
} from './native_read_boundary.js';
import {withProductionPhaseTiming} from '../effect/production_log.js';

import type {AnonymousTelemetryContextBriefCitationUnknownReason} from '../effect/telemetry.js';
import {
  makeContextBriefAnonymousTelemetryReporter,
  type ContextBriefCitationTelemetrySummary,
} from '../telemetry/context_brief.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {recordContextBriefValueEvent, type ContextBriefValueEventV1} from '../value_report/events.js';
import {loadPublishedProcedureCandidates} from '../procedure/repository.js';
import {
  selectVerifiedProcedureEvidence,
  type VerifiedProcedureCoverageGap,
} from '@threadnote/context/procedure/selection';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {
  retrieveContextBriefGraphEvidence,
  unavailableContextBriefGraphEvidence,
} from '@threadnote/context/graph/evidence';
import {retrieveContextBriefSourceEvidence} from '@threadnote/context/graph/source_evidence';
import type {ContextBriefSourceEvidenceRequest} from '@threadnote/context/graph/source_evidence';
import {
  unavailableContextBriefCodeLinkedMemoryEvidence,
  unavailableContextBriefMemoryEvidence,
} from '@threadnote/context/memory-evidence';
import {retrieveContextBriefCodeLinkedMemoryEvidence, retrieveContextBriefMemoryEvidence} from './memory_evidence.js';
import {planContextBrief} from '@threadnote/context/planner';
import {projectContextBrief} from '@threadnote/context/projector';
import type {
  ContextBriefGraphEvidenceV1,
  ContextBriefLogicalResultV1,
  ContextBriefMemoryRetrievalV1,
  ContextBriefPlanV1,
  ContextBriefRequestV1,
  ContextBriefResponseFormat,
  ProjectedContextBriefV1,
  SemanticContextKnowledgeV1,
  SemanticContextSourceBindingV1,
  SemanticContextSymbolTarget,
} from '@threadnote/context/types';

export interface ContextBriefRuntimeCompilerSources<
  GraphR = never,
  MemoryR = never,
  CitationR = never,
  ProjectR = never,
> {
  readonly citationValidation: NonNullable<
    ContextBriefCompilerDependencies<never, never, CitationR>['citationValidation']
  >;
  readonly codeLinkedMemoryAfterGraph?: boolean;
  readonly graphEvidence: ContextBriefCompilerDependencies<GraphR>['graphEvidence'];
  readonly codeLinkedMemoryEvidence?: ContextBriefCompilerDependencies<never, MemoryR>['codeLinkedMemoryEvidence'];
  readonly memoryEvidence: ContextBriefCompilerDependencies<never, MemoryR>['memoryEvidence'];
  readonly procedureEvidence?: ContextBriefCompilerDependencies<never, MemoryR>['procedureEvidence'];
  readonly projection: NonNullable<ContextBriefCompilerDependencies<never, never, never, ProjectR>['projection']>;
}

/** Internal compiler controls for reviewed callers; never part of the Context Brief request schema. */
interface ContextBriefCompilerOptions {
  readonly semanticContext?: ContextBriefNativeSemanticRead;
  readonly sourceEvidence?: (
    request: ContextBriefSourceEvidenceRequest,
  ) => Effect.Effect<
    Effect.Success<ReturnType<typeof retrieveContextBriefSourceEvidence>>,
    unknown,
    | Effect.Services<ReturnType<typeof retrieveContextBriefSourceEvidence>>
    | Effect.Services<ReturnType<typeof retrieveSemanticContextSymbol>>
  >;
  readonly allowedMemoryUriScopes?: readonly string[];
  readonly codeLinkedMemoryOnly?: boolean;
  readonly semanticMemoryTarget?: () => {
    readonly nodeId: string | null;
    readonly binding: SemanticContextSourceBindingV1 | null;
    readonly repositoryIdentityKind: 'local' | 'remote' | null;
    readonly gap?: string;
  };
  readonly includeProcedureEvidence?: boolean;
  readonly projection?: (
    logical: ContextBriefLogicalResultV1,
    maximumEstimatedTokens: number,
    responseFormat: ContextBriefResponseFormat,
  ) => ProjectedContextBriefV1;
}

/**
 * Measure raw phase outcomes before converting source failures into bounded
 * compiler gaps. This preserves a successful fail-soft brief without teaching
 * telemetry that an unavailable graph, recall store, or validator succeeded.
 */
export function instrumentContextBriefCompilerDependencies<
  GraphR = never,
  MemoryR = never,
  CitationR = never,
  ProjectR = never,
>(
  reporter: ReturnType<typeof makeContextBriefAnonymousTelemetryReporter>,
  sources: ContextBriefRuntimeCompilerSources<GraphR, MemoryR, CitationR, ProjectR>,
  requestedRepositories: number,
): ContextBriefCompilerDependencies<GraphR, MemoryR, CitationR, ProjectR> {
  return {
    codeLinkedMemoryAfterGraph: sources.codeLinkedMemoryAfterGraph,
    citationValidation: (scope, candidates, fence, deadline) =>
      reporter
        .citationValidation(
          withProductionPhaseTiming(
            'context.brief.citation-validation',
            sources.citationValidation(scope, candidates, fence, deadline),
          ),
          validations => summarizeContextBriefCitationTelemetry(candidates, validations),
        )
        .pipe(
          Effect.catchIf(
            error => !Schema.is(ReadDeadlineExceeded)(error) && !isReadCleanupUnconfirmed(error),
            () =>
              Clock.currentTimeMillis.pipe(
                Effect.map(now => failedContextBriefCitationValidations(candidates, new Date(now).toISOString())),
              ),
          ),
        ),
    graphEvidence: (graphPlan, readBudget) =>
      reporter
        .graph(
          withProductionPhaseTiming(
            'context.brief.graph',
            sources.graphEvidence(graphPlan, readBudget),
            contextBriefGraphPhaseOutcome,
          ),
          contextBriefGraphPhaseOutcome,
        )
        .pipe(
          Effect.catchIf(
            error =>
              !Schema.is(CodeGraphScopeRoutingError)(error) &&
              !Schema.is(ReadDeadlineExceeded)(error) &&
              !isReadCleanupUnconfirmed(error),
            () =>
              Effect.succeed(unavailableContextBriefGraphEvidence('graph-query-unavailable', requestedRepositories)),
          ),
        ),
    ...(sources.codeLinkedMemoryEvidence === undefined
      ? {}
      : {
          codeLinkedMemoryEvidence: (codePlan: ContextBriefPlanV1['codeAnchors'], deadline?: ReadDeadline) =>
            reporter
              .codeLinkedMemory(
                withProductionPhaseTiming(
                  'context.brief.code-linked-memory',
                  sources.codeLinkedMemoryEvidence!(codePlan, deadline),
                  contextBriefCodeLinkedMemoryPhaseOutcome,
                ),
                contextBriefCodeLinkedMemoryPhaseOutcome,
              )
              .pipe(
                Effect.catchIf(
                  error => !Schema.is(ReadDeadlineExceeded)(error) && !isReadCleanupUnconfirmed(error),
                  () =>
                    Effect.succeed(
                      unavailableContextBriefCodeLinkedMemoryEvidence(
                        codePlan.codeRefs.length,
                        'code-anchor-resolution-unavailable',
                      ),
                    ),
                ),
              ),
        }),
    memoryEvidence: (memoryPlan, deadline) =>
      reporter
        .memory(withProductionPhaseTiming('context.brief.memory', sources.memoryEvidence(memoryPlan, deadline)))
        .pipe(
          Effect.catchIf(
            error => !isReadCleanupUnconfirmed(error),
            error =>
              Effect.succeed(
                Schema.is(RecallReadyReadUnavailable)(error) && error.reason === 'budget-exhausted'
                  ? {...unavailableContextBriefMemoryEvidence(), gaps: ['memory-recall-budget-exhausted']}
                  : unavailableContextBriefMemoryEvidence(),
              ),
          ),
        ),
    ...(sources.procedureEvidence === undefined
      ? {}
      : {
          procedureEvidence: (plan: ContextBriefPlanV1, deadline?: ReadDeadline) =>
            withProductionPhaseTiming('context.brief.procedures', sources.procedureEvidence!(plan, deadline)).pipe(
              Effect.catchIf(
                error => !isReadCleanupUnconfirmed(error),
                () => Effect.succeed({gaps: ['procedure-evidence-unavailable'], procedures: []} as const),
              ),
            ),
        }),
    projection: (logical, maximumEstimatedTokens, responseFormat) =>
      reporter.projection(
        withProductionPhaseTiming(
          'context.brief.projection',
          sources.projection(logical, maximumEstimatedTokens, responseFormat),
        ),
        projected => projected.structuredContent.output.truncated,
        logical.coverage.memory.codeAnchors === undefined
          ? undefined
          : projected => ({
              ...logical.coverage.memory.codeAnchors!,
              gaps: logical.coverage.gaps,
              recoveryPresent: projected.structuredContent.recommendedFollowUps.length > 0,
            }),
        projected => {
          const graphReturned =
            projected.structuredContent.graph.cards.length + projected.structuredContent.graph.contracts.length > 0;
          const memoryReturned =
            projected.structuredContent.durableDecisions.length + projected.structuredContent.activeHandoffs.length > 0;
          return graphReturned && memoryReturned
            ? 'mixed'
            : graphReturned
              ? 'graph'
              : memoryReturned
                ? 'memory'
                : 'none';
        },
      ),
  };
}

function contextBriefGraphPhaseOutcome(evidence: ContextBriefGraphEvidenceV1): 'success' | 'unavailable' {
  return !evidence.coverage.complete ||
    EffectArray.some(evidence.gaps, gap =>
      [
        'graph-coverage-incomplete',
        'graph-query-unavailable',
        'graph-ready-snapshot-missing',
        'graph-repository-read-failed',
        'graph-snapshots-missing',
      ].includes(gap),
    )
    ? 'unavailable'
    : 'success';
}

function contextBriefCodeLinkedMemoryPhaseOutcome(evidence: ContextBriefMemoryRetrievalV1): 'success' | 'unavailable' {
  const anchors = evidence.codeAnchorCoverage;
  return anchors === undefined ||
    anchors.resolved === 0 ||
    EffectArray.some(evidence.gaps, gap =>
      [
        'code-anchor-recall-unavailable',
        'code-anchor-ref-unsupported',
        'code-anchor-resolution-unavailable',
        'code-anchor-scope-unsupported',
        'code-anchor-selector-matches-unvalidated',
      ].includes(gap),
    )
    ? 'unavailable'
    : 'success';
}

/**
 * CLI/MCP-ready local runtime adapter. Graph failure and recall failure remain
 * explicit coverage gaps so either evidence source can still orient the task.
 */
const compileContextBriefRuntime = Effect.fn('contextBrief.compileRuntime')(function* (
  config: RuntimeConfig,
  input: ContextBriefRequestV1 | unknown,
  options: ContextBriefCompilerOptions = {},
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const request = planContextBrief(input);
  const requestedRepositories = request.scope.kind === 'repository' ? 1 : 0;
  const reporter = makeContextBriefAnonymousTelemetryReporter(request.scope.kind === 'workset' ? 'workset' : 'local', {
    contract: request.codeAnchors.codeRefs.length === 0 ? 'task-only-v2' : 'code-anchored-v3',
    mode: request.mode,
  });
  const compilation = Effect.gen(function* () {
    yield* reporter.annotate;
    return yield* compileContextBriefWith(
      instrumentContextBriefCompilerDependencies(
        reporter,
        yield* withNativeContextBriefReadSources(
          config,
          {
            citationValidation: (scope, candidates, fence) =>
              validateContextBriefMemoryCitations(config, scope, candidates, fence),
            graphEvidence: (graphPlan, readBudget) =>
              retrieveContextBriefGraphEvidence(
                config,
                graphPlan,
                options.sourceEvidence ?? retrieveContextBriefSourceEvidence,
                readBudget,
              ),
            codeLinkedMemoryAfterGraph: options.semanticMemoryTarget !== undefined,
            codeLinkedMemoryEvidence: codePlan => {
              const target = options.semanticMemoryTarget?.();
              if (target && (!target.nodeId || !target.binding || !target.repositoryIdentityKind))
                return Effect.succeed(
                  unavailableContextBriefCodeLinkedMemoryEvidence(
                    1,
                    target.gap ?? 'semantic-symbol-target-unavailable',
                  ),
                );
              return retrieveContextBriefCodeLinkedMemoryEvidence(
                config,
                target?.nodeId ? {...codePlan, codeRefs: [target.nodeId]} : codePlan,
                {allowedUriScopes: options.allowedMemoryUriScopes},
              ).pipe(
                Effect.map(memory =>
                  target?.nodeId && target.binding && target.repositoryIdentityKind
                    ? filterSemanticContextMemory(
                        memory,
                        target.nodeId,
                        target.binding.graph,
                        target.repositoryIdentityKind,
                      )
                    : memory,
                ),
              );
            },
            memoryEvidence: memoryPlan =>
              options.codeLinkedMemoryOnly
                ? Effect.succeed({
                    candidates: [],
                    consideredCandidates: 0,
                    gaps: [],
                    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
                  } satisfies ContextBriefMemoryRetrievalV1)
                : retrieveContextBriefMemoryEvidence(config, memoryPlan, options.allowedMemoryUriScopes),
            procedureEvidence: plan =>
              options.includeProcedureEvidence === false
                ? Effect.succeed({gaps: [], procedures: []})
                : loadPublishedProcedureCandidates(config).pipe(
                    Effect.map(repositoryEvidence => {
                      const selected = selectVerifiedProcedureEvidence({
                        candidates: repositoryEvidence.candidates,
                        cohort: config.user,
                        surface: plan.surface ?? config.agentId,
                        task: plan.task,
                      });
                      return {
                        gaps: [
                          ...new Set<VerifiedProcedureCoverageGap>([...repositoryEvidence.gaps, ...selected.gaps]),
                        ].sort(),
                        procedures: selected.procedures,
                      };
                    }),
                  ),
            projection: (logical, maximumEstimatedTokens, responseFormat) =>
              Effect.sync(() =>
                (options.projection ?? projectContextBrief)(logical, maximumEstimatedTokens, responseFormat),
              ),
          },
          {
            allowedUriScopes: options.allowedMemoryUriScopes,
            includeProcedureEvidence: options.includeProcedureEvidence,
            semantic: options.semanticContext,
          },
        ),
        requestedRepositories,
      ),
      {
        budgetTokens: request.outputBudgetTokens,
        ...(request.codeAnchors.codeRefs.length === 0 ? {} : {codeRefs: request.codeAnchors.codeRefs}),
        ...(request.detail === 'compact' ? {} : {detail: request.detail}),
        mode: request.mode,
        responseFormat: request.responseFormat,
        scope: request.scope,
        ...(request.surface === undefined ? {} : {surface: request.surface}),
        task: request.task,
      },
    );
  });
  return yield* withReadyRecallReadBoundary(compilation).pipe(
    Effect.onExit(exit =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap(completedAt =>
          recordContextBriefValueEvent(
            config.agentContextHome,
            contextBriefValueEventForExit(
              request,
              startedAt,
              completedAt,
              DateTime.formatIso(DateTime.makeUnsafe(completedAt)),
              exit,
            ),
          ),
        ),
        Effect.ignore,
      ),
    ),
  );
});

/** Compile a normal Context Brief using its stable two-argument public contract. */
export const compileContextBrief = Effect.fn('contextBrief.compile')(function* (
  config: RuntimeConfig,
  input: ContextBriefRequestV1 | unknown,
) {
  return yield* compileContextBriefRuntime(config, input);
});

/** Document code evidence remains useful when exact symbol memory selection must abstain. */
export const compileSemanticContextKnowledge = Effect.fn('contextBrief.semanticKnowledge')(function* (
  config: RuntimeConfig,
  input: ContextBriefRequestV1,
  evidence: Evidence,
  target: SemanticContextSymbolTarget | null = null,
): Effect.fn.Return<
  SemanticContextKnowledgeV1,
  unknown,
  Effect.Services<ReturnType<typeof compileContextBriefRuntime>>
> {
  const state: ContextBriefNativeSemanticState = {
    binding: null,
    repositoryIdentityKind: null,
    selection: {nodeId: null, gap: 'semantic-symbol-target-unavailable'},
  };
  const projected = yield* compileContextBriefRuntime(
    config,
    {...input, detail: 'source', responseFormat: 'agent'},
    {
      codeLinkedMemoryOnly: true,
      includeProcedureEvidence: false,
      semanticContext: {evidence, target, state},
      semanticMemoryTarget: () => ({
        ...state.selection,
        binding: state.binding,
        repositoryIdentityKind: state.repositoryIdentityKind,
      }),
      sourceEvidence: (request: ContextBriefSourceEvidenceRequest) =>
        retrieveSemanticContextSourceEvidence(request, evidence).pipe(
          Effect.flatMap(result =>
            Effect.gen(function* () {
              state.binding = result.binding;
              state.repositoryIdentityKind = request.identity.remoteIdentity ? 'remote' : 'local';
              state.selection = yield* retrieveSemanticContextSymbol(
                config,
                request,
                evidence,
                target,
                state.binding,
              ).pipe(Effect.orElseSucceed(() => ({nodeId: null, gap: 'semantic-symbol-lookup-unavailable'})));
              return result.source;
            }),
          ),
        ),
    },
  );
  const knowledge = projectSemanticContextKnowledge(projected, state.binding);
  return {
    ...knowledge,
    memorySelection:
      state.selection.nodeId && state.binding && target
        ? {
            version: 1 as const,
            scope: 'symbol-and-file' as const,
            nodeId: state.selection.nodeId,
            observation: state.binding.observation,
            graph: state.binding.graph,
            definitionRange: target.range,
          }
        : null,
    gaps: [
      ...new Set([
        ...knowledge.gaps,
        ...(state.selection.gap ? [state.selection.gap] : ['semantic-symbol-memory-coverage-incomplete']),
      ]),
    ],
  };
});

/** Cloud callers supply their validated share roots; unscoped procedure discovery stays disabled. */
export const compileScopedContextBrief = Effect.fn('contextBrief.compileScoped')(function* (
  config: RuntimeConfig,
  input: ContextBriefRequestV1 | unknown,
  allowedMemoryUriScopes: readonly string[],
) {
  return yield* compileContextBriefRuntime(config, input, {
    allowedMemoryUriScopes,
    includeProcedureEvidence: false,
  });
});

/** Compile through the normal runtime evidence boundaries with one reviewed private projection. */
export const compileContextBriefRuntimeProjection = Effect.fn('contextBrief.compileRuntimeProjection')(function* (
  config: RuntimeConfig,
  input: ContextBriefRequestV1 | unknown,
  projection: NonNullable<ContextBriefCompilerOptions['projection']>,
) {
  return yield* compileContextBriefRuntime(config, input, {projection});
});

/** Compile the final source-verification brief used only by setup. */
export const compileSetupSourceVerificationBrief = Effect.fn('contextBrief.compileSetupSourceVerification')(function* (
  config: RuntimeConfig,
  input: ContextBriefRequestV1 | unknown,
) {
  return yield* compileContextBriefRuntime(config, input, {
    codeLinkedMemoryOnly: true,
    includeProcedureEvidence: false,
  });
});

export function contextBriefValueEventForExit(
  request: ContextBriefPlanV1,
  startedAt: number,
  completedAt: number,
  timestamp: string,
  exit: Exit.Exit<ProjectedContextBriefV1, unknown>,
): Omit<ContextBriefValueEventV1, 'kind' | 'version'> {
  const projected = Exit.isSuccess(exit) ? exit.value : undefined;
  const codeAnchors = projected?.structuredContent.coverage.memory.codeAnchors;
  return {
    coverageGaps: projected?.structuredContent.coverage.gaps.length ?? 0,
    durationMilliseconds: Math.max(0, completedAt - startedAt),
    estimatedTokens: projected?.measurement.estimatedTokens ?? 0,
    ...(request.scope.project === undefined ? {} : {project: request.scope.project}),
    requestedCodeAnchors: codeAnchors?.requested ?? request.codeAnchors.codeRefs.length,
    resolvedCodeAnchors: codeAnchors?.resolved ?? 0,
    successful: projected !== undefined,
    timestamp,
  };
}

function failedContextBriefCitationValidations(
  candidates: ContextBriefMemoryRetrievalV1['candidates'],
  observedAt: string,
): NonNullable<ContextBriefMemoryRetrievalV1['citationValidations']> {
  return EffectArray.flatMap(candidates, candidate =>
    candidate.codeCitations.length === 0
      ? []
      : [
          {
            receipts: EffectArray.map(candidate.codeCitations, citation => ({
              candidateCount: 0,
              citationId: citation.id,
              coverage: 'incomplete' as const,
              kind: citation.target.kind,
              observedAt,
              reason: 'validation-error' as const,
              repositoryId: citation.repositoryId,
              sourcePath: citation.path,
              status: 'unknown' as const,
              strategy: 'none' as const,
              validatorVersion: 1 as const,
            })),
            uri: candidate.uri,
          },
        ],
  );
}

/** Project private validation receipts into the closed, count-only telemetry vocabulary. */
export function summarizeContextBriefCitationTelemetry(
  candidates: ContextBriefMemoryRetrievalV1['candidates'],
  validations: NonNullable<ContextBriefMemoryRetrievalV1['citationValidations']>,
): ContextBriefCitationTelemetrySummary {
  const validationsByUri = new Map(EffectArray.map(validations, validation => [validation.uri, validation]));
  let cacheHits = 0;
  let citations = 0;
  let citedMemories = 0;
  let exactCitations = 0;
  let relocatedCitations = 0;
  let staleCitations = 0;
  let unknownCitations = 0;
  const repositoriesValidated = new Set<string>();
  const unknownReasons = new Set<AnonymousTelemetryContextBriefCitationUnknownReason>();

  for (const candidate of candidates) {
    const citationCount = candidate.codeCitations.length + candidate.citationErrorCount;
    if (citationCount === 0) continue;
    citations += citationCount;
    citedMemories += 1;
    const validation = validationsByUri.get(candidate.uri);
    cacheHits += Math.min(validation?.cacheHits ?? 0, candidate.codeCitations.length);
    const receiptsById = new Map(EffectArray.map(validation?.receipts ?? [], receipt => [receipt.citationId, receipt]));
    for (const citation of candidate.codeCitations) {
      const receipt = receiptsById.get(citation.id);
      if (receipt?.snapshotId !== undefined && receipt.repositoryId !== undefined) {
        repositoriesValidated.add(receipt.repositoryId);
      }
      switch (receipt?.status) {
        case 'exact':
          exactCitations += 1;
          break;
        case 'relocated':
          relocatedCitations += 1;
          break;
        case 'changed':
        case 'deleted':
          staleCitations += 1;
          break;
        case 'unknown':
          unknownCitations += 1;
          unknownReasons.add(telemetryUnknownReason(receipt.reason));
          break;
        case undefined:
          unknownCitations += 1;
          unknownReasons.add('repository-unavailable');
          break;
      }
    }
    if (candidate.citationErrorCount > 0) {
      unknownCitations += candidate.citationErrorCount;
      unknownReasons.add('invalid-citation');
    }
  }

  const coverage =
    citations === 0
      ? ('none' as const)
      : unknownCitations === 0
        ? ('complete' as const)
        : unknownCitations === citations
          ? ('unavailable' as const)
          : ('partial' as const);
  return {
    cacheHits,
    citations,
    citedMemories,
    coverage,
    exactCitations,
    relocatedCitations,
    repositoriesValidated: repositoriesValidated.size,
    staleCitations,
    unknownCitations,
    ...(unknownCitations === 0
      ? {}
      : {unknownReason: unknownReasons.size === 1 ? [...unknownReasons][0] : ('mixed' as const)}),
  };
}

function telemetryUnknownReason(
  reason: NonNullable<ContextBriefMemoryRetrievalV1['citationValidations']>[number]['receipts'][number]['reason'],
): AnonymousTelemetryContextBriefCitationUnknownReason {
  switch (reason) {
    case 'ambiguous-relocation':
      return 'ambiguous-relocation';
    case 'citation-limit':
      return 'budget-exhausted';
    case 'extractor-mismatch':
      return 'unsupported';
    case 'graph-incomplete':
      return 'snapshot-unavailable';
    case 'graph-stale':
      return 'snapshot-not-current';
    case 'malformed-citation':
      return 'invalid-citation';
    case 'repository-ambiguous':
    case 'repository-unavailable':
      return 'repository-unavailable';
    case 'validation-error':
      return 'store-failure';
    case 'exact':
    case 'relocated':
    case 'source-changed':
    case 'source-deleted':
      return 'unsupported';
  }
}

export * from '@threadnote/context/graph/evidence';
export * from '@threadnote/context/graph/source_evidence';
export * from '@threadnote/context/graph/anchor_evidence';
export * from '@threadnote/context/citation_validation';
export * from './memory_evidence.js';
export * from '@threadnote/context/planner';
export * from '@threadnote/context/projector';
export * from '@threadnote/context/types';
