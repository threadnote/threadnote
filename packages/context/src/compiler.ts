import {Array as EffectArray, Option as EffectOption} from 'effect';
import {DateTime, Effect, Schema} from 'effect';
import {
  makeReadDeadline,
  ReadDeadlineExceeded,
  withinReadDeadline,
  type ReadDeadline,
} from '@threadnote/platform/read_deadline';
import {succeedUndefined} from '@threadnote/platform/optional';
import type {ContextBriefGraphReadBudget} from './graph/evidence.js';
import type {VerifiedProcedureSelection} from './procedure/selection.js';
import {
  contextBriefResumeTaskAlignmentScore,
  contextBriefTaskGraphAnchors,
  unavailableContextBriefCodeLinkedMemoryEvidence,
  unavailableContextBriefMemoryEvidence,
  mergeContextBriefMemoryEvidence,
} from './memory-evidence.js';
import {assembleContextBriefLogicalResult, planContextBrief} from './planner.js';
import {projectContextBrief} from './projector.js';
import {unavailableContextBriefGraphEvidence} from './graph/evidence.js';
import type {
  ContextBriefGraphEvidenceV1,
  ContextBriefCitationValidationFenceV2,
  ContextBriefMemoryCandidateV1,
  ContextBriefMemoryRetrievalV1,
  ContextBriefLogicalResultV1,
  ContextBriefPlanV1,
  ContextBriefRequestV1,
  ContextBriefResponseFormat,
  ProjectedContextBriefV1,
} from './types.js';

export interface ContextBriefCompilerDependencies<
  GraphR = never,
  MemoryR = never,
  CitationR = never,
  ProjectR = never,
> {
  readonly graphEvidence: (
    plan: ContextBriefPlanV1['graph'],
    readBudget?: ContextBriefGraphReadBudget,
  ) => Effect.Effect<ContextBriefGraphEvidenceV1, unknown, GraphR>;
  readonly memoryEvidence: (
    plan: ContextBriefPlanV1['memory'],
    deadline?: ReadDeadline,
  ) => Effect.Effect<ContextBriefMemoryRetrievalV1, unknown, MemoryR>;
  readonly procedureEvidence?: (
    plan: ContextBriefPlanV1,
    deadline?: ReadDeadline,
  ) => Effect.Effect<VerifiedProcedureSelection, unknown, MemoryR>;
  readonly codeLinkedMemoryEvidence?: (
    plan: ContextBriefPlanV1['codeAnchors'],
    deadline?: ReadDeadline,
  ) => Effect.Effect<ContextBriefMemoryRetrievalV1, unknown, MemoryR>;
  readonly citationValidation?: (
    scope: ContextBriefPlanV1['scope'],
    candidates: ContextBriefMemoryRetrievalV1['candidates'],
    fence: ContextBriefCitationValidationFenceV2 | undefined,
    deadline?: ReadDeadline,
  ) => Effect.Effect<NonNullable<ContextBriefMemoryRetrievalV1['citationValidations']>, unknown, CitationR>;
  readonly projection?: (
    logical: ContextBriefLogicalResultV1,
    maximumEstimatedTokens: number,
    responseFormat: ContextBriefResponseFormat,
  ) => Effect.Effect<ProjectedContextBriefV1, unknown, ProjectR>;
}

/** Deterministic compiler core with injected read boundaries for focused tests and alternate clients. */
export const compileContextBriefWith = Effect.fn('contextBrief.compileWith')(function* <
  GraphR = never,
  MemoryR = never,
  CitationR = never,
  ProjectR = never,
>(
  dependencies: ContextBriefCompilerDependencies<GraphR, MemoryR, CitationR, ProjectR>,
  input: ContextBriefRequestV1 | unknown,
) {
  const plan = planContextBrief(input);
  const ordinaryTaskAnchors =
    plan.scope.kind === 'repository' &&
    (plan.mode === 'brief' || plan.mode === 'explain') &&
    plan.graph.codeRefs.length === 0;
  const lexicalDeadline = yield* makeReadDeadline(2_000);
  const graphDeadline = yield* makeReadDeadline(5_000);
  const readBudget = {remaining: 2, primaryRemaining: 17, deadline: graphDeadline};
  const readGraph = (graphPlan: ContextBriefPlanV1['graph']) =>
    withinReadDeadline(
      graphDeadline,
      Effect.suspend(() => dependencies.graphEvidence(graphPlan, readBudget)),
    ).pipe(
      Effect.catchIf(Schema.is(ReadDeadlineExceeded), () =>
        Effect.succeed(
          unavailableContextBriefGraphEvidence('graph-read-budget-exhausted', plan.scope.kind === 'repository' ? 1 : 0),
        ),
      ),
    );
  const readCitations = (
    candidates: ContextBriefMemoryRetrievalV1['candidates'],
    fence: ContextBriefCitationValidationFenceV2 | undefined,
  ) =>
    dependencies.citationValidation === undefined
      ? succeedUndefined
      : withinReadDeadline(
          graphDeadline,
          Effect.suspend(() => dependencies.citationValidation!(plan.scope, candidates, fence, graphDeadline)),
        ).pipe(
          Effect.catchIf(Schema.is(ReadDeadlineExceeded), () =>
            Effect.succeed(budgetExpiredCitationValidations(candidates, observedAt)),
          ),
        );
  const observedAt = DateTime.formatIso(yield* DateTime.now);
  const codeLinkedMemory =
    plan.codeAnchors.codeRefs.length === 0
      ? succeedUndefined
      : dependencies.codeLinkedMemoryEvidence === undefined
        ? Effect.succeed(unavailableContextBriefCodeLinkedMemoryEvidence(plan.codeAnchors.codeRefs.length))
        : withinReadDeadline(
            graphDeadline,
            Effect.suspend(() => dependencies.codeLinkedMemoryEvidence!(plan.codeAnchors, graphDeadline)),
          ).pipe(
            Effect.catchIf(Schema.is(ReadDeadlineExceeded), () =>
              Effect.succeed(
                unavailableContextBriefCodeLinkedMemoryEvidence(
                  plan.codeAnchors.codeRefs.length,
                  'code-anchor-read-budget-exhausted',
                ),
              ),
            ),
          );
  const [eagerGraph, lexicalMemory, linkedMemory, procedureEvidence] = yield* Effect.all(
    [
      plan.mode === 'resume' ? succeedUndefined : readGraph(plan.graph),
      withinReadDeadline(
        lexicalDeadline,
        Effect.suspend(() => dependencies.memoryEvidence(plan.memory, lexicalDeadline)),
      ).pipe(
        Effect.catchIf(Schema.is(ReadDeadlineExceeded), () =>
          Effect.succeed({...unavailableContextBriefMemoryEvidence(), gaps: ['memory-recall-budget-exhausted']}),
        ),
      ),
      codeLinkedMemory,
      dependencies.procedureEvidence === undefined
        ? Effect.succeed({gaps: [], procedures: []})
        : withinReadDeadline(
            graphDeadline,
            Effect.suspend(() => dependencies.procedureEvidence!(plan, graphDeadline)),
          ).pipe(
            Effect.catchIf(Schema.is(ReadDeadlineExceeded), () =>
              Effect.succeed({gaps: ['procedure-evidence-unavailable'] as const, procedures: []}),
            ),
          ),
    ],
    {concurrency: 4},
  );
  const initialGraph =
    eagerGraph ??
    (yield* readGraph(withResumeMemoryGraphAnchors(plan.graph, lexicalMemory, plan.codeAnchors.candidateLimit)));
  const memory = mergeContextBriefMemoryEvidence(
    lexicalMemory,
    linkedMemory,
    plan.memory.candidateLimit,
    plan.codeAnchors.candidateLimit,
  );
  const initialValidations = dependencies.citationValidation
    ? yield* readCitations(memory.candidates, initialGraph.citationValidationFence)
    : memory.citationValidations;
  let graph = initialGraph;
  let validatedMemory =
    initialValidations === undefined ? memory : {...memory, citationValidations: initialValidations};
  if (ordinaryTaskAnchors) {
    const codeRefs = contextBriefTaskGraphAnchors(plan.graph.query, lexicalMemory, initialGraph, 8);
    if (codeRefs.length > 0) {
      const anchored = yield* readGraph({...plan.graph, codeRefs});
      // Locators are hints. An unresolved locator must never erase the truthful task-only read.
      if (
        anchored.citationValidationFence?.kind === 'repository' &&
        initialGraph.citationValidationFence?.kind === 'repository' &&
        anchored.citationValidationFence.repositoryId === initialGraph.citationValidationFence.repositoryId &&
        EffectArray.some(anchored.resolvedSnapshots, snapshot => snapshot.freshness === 'fresh') &&
        EffectArray.some(anchored.cards, card => codeRefs.includes(card.symbol.path)) &&
        (plan.graph.detail !== 'source' ||
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(anchored.sourceExcerpts), __effectArrayReceiver =>
              EffectArray.some(
                __effectArrayReceiver,
                __effectArrayValue => !!(source => codeRefs.includes(source.path))(__effectArrayValue),
              ),
            ),
          ))
      ) {
        graph = anchored;
        if (!sameGraphValidationFence(initialGraph, graph)) {
          const validations = dependencies.citationValidation
            ? yield* readCitations(memory.candidates, graph.citationValidationFence)
            : undefined;
          validatedMemory = {...memory, citationValidations: validations};
        }
      } else {
        graph = {...initialGraph, gaps: [...new Set([...initialGraph.gaps, 'task-anchor-source-unavailable'])]};
      }
    } else {
      graph = {...initialGraph, gaps: [...new Set([...initialGraph.gaps, 'task-anchor-locators-unavailable'])]};
    }
  }
  if (plan.mode === 'resume' && plan.graph.codeRefs.length === 0) {
    const initialLogical = assembleContextBriefLogicalResult({
      graph,
      memory: validatedMemory,
      observedAt,
      plan,
      verifiedProcedureGaps: procedureEvidence.gaps,
      verifiedProcedures: procedureEvidence.procedures,
    });
    const selected = EffectOption.getOrUndefined(
      EffectArray.findFirst(memory.candidates, candidate => candidate.uri === initialLogical.activeHandoffs[0]?.uri),
    );
    const selectedPlan = withSelectedResumeGraphAnchors(plan.graph, selected, plan.codeAnchors.candidateLimit);
    const initialPlan = withResumeMemoryGraphAnchors(plan.graph, lexicalMemory, plan.codeAnchors.candidateLimit);
    if (!sameCodeRefs(selectedPlan.codeRefs, initialPlan.codeRefs)) {
      graph = yield* readGraph(selectedPlan);
      if (!sameGraphValidationFence(initialGraph, graph)) {
        const refreshedValidations = dependencies.citationValidation
          ? yield* readCitations(memory.candidates, graph.citationValidationFence)
          : undefined;
        validatedMemory =
          refreshedValidations === undefined
            ? {...memory, citationValidations: undefined}
            : {...memory, citationValidations: refreshedValidations};
      }
      const refreshedLogical = assembleContextBriefLogicalResult({
        graph,
        memory: validatedMemory,
        observedAt,
        plan,
        verifiedProcedureGaps: procedureEvidence.gaps,
        verifiedProcedures: procedureEvidence.procedures,
      });
      const refreshedSelected = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          memory.candidates,
          candidate => candidate.uri === refreshedLogical.activeHandoffs[0]?.uri,
        ),
      );
      if (
        !sameCodeRefs(
          selectedPlan.codeRefs,
          withSelectedResumeGraphAnchors(plan.graph, refreshedSelected, plan.codeAnchors.candidateLimit).codeRefs,
        )
      ) {
        // A generation change can alter the selected handoff. Do not publish cards from the
        // now unrelated anchored read as if they supported that continuation.
        graph = {
          ...graph,
          cards: [],
          contracts: [],
          coverage: {...graph.coverage, complete: false},
          gaps: [...graph.gaps, 'resume-anchor-validation-changed'],
          sourceExcerpts: [],
        };
      }
    }
  }
  const logical = assembleContextBriefLogicalResult({
    graph,
    memory: validatedMemory,
    observedAt,
    plan,
    verifiedProcedureGaps: procedureEvidence.gaps,
    verifiedProcedures: procedureEvidence.procedures,
  });
  return yield* dependencies.projection
    ? dependencies.projection(logical, plan.outputBudgetTokens, plan.responseFormat)
    : Effect.sync(() => projectContextBrief(logical, plan.outputBudgetTokens, plan.responseFormat));
});

/** Budget expiry is missing proof, never a current/changed citation verdict. */
function budgetExpiredCitationValidations(
  candidates: ContextBriefMemoryRetrievalV1['candidates'],
  observedAt: string,
): NonNullable<ContextBriefMemoryRetrievalV1['citationValidations']> {
  return EffectArray.flatMap(candidates, candidate =>
    candidate.codeCitations.length === 0
      ? []
      : [
          {
            uri: candidate.uri,
            receipts: EffectArray.map(candidate.codeCitations, citation => ({
              candidateCount: 0,
              citationId: citation.id,
              coverage: 'incomplete' as const,
              kind: citation.target.kind,
              observedAt,
              reason: 'citation-limit' as const,
              repositoryId: citation.repositoryId,
              sourcePath: citation.path,
              status: 'unknown' as const,
              strategy: 'none' as const,
              validatorVersion: 1 as const,
            })),
          },
        ],
  );
}

function withResumeMemoryGraphAnchors(
  graphPlan: ContextBriefPlanV1['graph'],
  memory: ContextBriefMemoryRetrievalV1,
  maximumRefs: number,
): ContextBriefPlanV1['graph'] {
  if (graphPlan.codeRefs.length > 0) return graphPlan;
  const handoff = EffectArray.filter(
    [...memory.candidates],
    candidate => candidate.kind === 'handoff' && candidate.continuationCard !== undefined,
  ).sort(
    (left, right) =>
      contextBriefResumeTaskAlignmentScore(graphPlan.query, right) -
        contextBriefResumeTaskAlignmentScore(graphPlan.query, left) ||
      left.rank - right.rank ||
      (left.uri === right.uri ? 0 : left.uri < right.uri ? -1 : 1),
  )[0];
  return withSelectedResumeGraphAnchors(graphPlan, handoff, maximumRefs);
}

function withSelectedResumeGraphAnchors(
  graphPlan: ContextBriefPlanV1['graph'],
  handoff: ContextBriefMemoryCandidateV1 | undefined,
  maximumRefs: number,
): ContextBriefPlanV1['graph'] {
  if (handoff === undefined || graphPlan.codeRefs.length > 0) return graphPlan;
  const codeRefs = [
    ...new Set(
      EffectArray.map(handoff.codeCitations, citation =>
        citation.target.kind === 'symbol' && /^cgs_[0-9a-f]{32}$/u.test(citation.target.nodeId)
          ? citation.target.nodeId
          : citation.path,
      ),
    ),
  ].slice(0, maximumRefs);
  return codeRefs.length === 0 ? graphPlan : {...graphPlan, codeRefs};
}

function sameCodeRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && EffectArray.every(left, (ref, index) => ref === right[index]);
}

function sameGraphValidationFence(left: ContextBriefGraphEvidenceV1, right: ContextBriefGraphEvidenceV1): boolean {
  const a = left.citationValidationFence;
  const b = right.citationValidationFence;
  if (a?.kind !== b?.kind) return false;
  if (a?.kind === 'repository' && b?.kind === 'repository') {
    return a.repositoryId === b.repositoryId && a.snapshotId === b.snapshotId;
  }
  if (a?.kind === 'workset' && b?.kind === 'workset') {
    return (
      a.workset === b.workset && a.generation.id === b.generation.id && a.generation.digest === b.generation.digest
    );
  }
  return JSON.stringify(left.resolvedSnapshots) === JSON.stringify(right.resolvedSnapshots);
}
