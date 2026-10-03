import {DateTime, Effect} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import type {VerifiedProcedureSelection} from './procedure/selection.js';
import {
  contextBriefResumeTaskAlignmentScore,
  unavailableContextBriefCodeLinkedMemoryEvidence,
  mergeContextBriefMemoryEvidence,
} from './memory-evidence.js';
import {assembleContextBriefLogicalResult, planContextBrief} from './planner.js';
import {projectContextBrief} from './projector.js';
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
  ) => Effect.Effect<ContextBriefGraphEvidenceV1, unknown, GraphR>;
  readonly memoryEvidence: (
    plan: ContextBriefPlanV1['memory'],
  ) => Effect.Effect<ContextBriefMemoryRetrievalV1, unknown, MemoryR>;
  readonly procedureEvidence?: (
    plan: ContextBriefPlanV1,
  ) => Effect.Effect<VerifiedProcedureSelection, unknown, MemoryR>;
  readonly codeLinkedMemoryEvidence?: (
    plan: ContextBriefPlanV1['codeAnchors'],
  ) => Effect.Effect<ContextBriefMemoryRetrievalV1, unknown, MemoryR>;
  readonly citationValidation?: (
    scope: ContextBriefPlanV1['scope'],
    candidates: ContextBriefMemoryRetrievalV1['candidates'],
    fence: ContextBriefCitationValidationFenceV2 | undefined,
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
  const observedAt = DateTime.formatIso(yield* DateTime.now);
  const codeLinkedMemory =
    plan.codeAnchors.codeRefs.length === 0
      ? succeedUndefined
      : dependencies.codeLinkedMemoryEvidence === undefined
        ? Effect.succeed(unavailableContextBriefCodeLinkedMemoryEvidence(plan.codeAnchors.codeRefs.length))
        : dependencies.codeLinkedMemoryEvidence(plan.codeAnchors);
  const [eagerGraph, lexicalMemory, linkedMemory, procedureEvidence] = yield* Effect.all(
    [
      plan.mode === 'resume' ? succeedUndefined : dependencies.graphEvidence(plan.graph),
      dependencies.memoryEvidence(plan.memory),
      codeLinkedMemory,
      dependencies.procedureEvidence?.(plan) ?? Effect.succeed({gaps: [], procedures: []}),
    ],
    {concurrency: 4},
  );
  const initialGraph =
    eagerGraph ??
    (yield* dependencies.graphEvidence(
      withResumeMemoryGraphAnchors(plan.graph, lexicalMemory, plan.codeAnchors.candidateLimit),
    ));
  const memory = mergeContextBriefMemoryEvidence(
    lexicalMemory,
    linkedMemory,
    plan.memory.candidateLimit,
    plan.codeAnchors.candidateLimit,
  );
  const initialValidations = dependencies.citationValidation
    ? yield* dependencies.citationValidation(plan.scope, memory.candidates, initialGraph.citationValidationFence)
    : memory.citationValidations;
  let graph = initialGraph;
  let validatedMemory =
    initialValidations === undefined ? memory : {...memory, citationValidations: initialValidations};
  if (plan.mode === 'resume' && plan.graph.codeRefs.length === 0) {
    const initialLogical = assembleContextBriefLogicalResult({
      graph,
      memory: validatedMemory,
      observedAt,
      plan,
      verifiedProcedureGaps: procedureEvidence.gaps,
      verifiedProcedures: procedureEvidence.procedures,
    });
    const selected = memory.candidates.find(candidate => candidate.uri === initialLogical.activeHandoffs[0]?.uri);
    const selectedPlan = withSelectedResumeGraphAnchors(plan.graph, selected, plan.codeAnchors.candidateLimit);
    const initialPlan = withResumeMemoryGraphAnchors(plan.graph, lexicalMemory, plan.codeAnchors.candidateLimit);
    if (!sameCodeRefs(selectedPlan.codeRefs, initialPlan.codeRefs)) {
      graph = yield* dependencies.graphEvidence(selectedPlan);
      if (!sameGraphValidationFence(initialGraph, graph)) {
        const refreshedValidations = dependencies.citationValidation
          ? yield* dependencies.citationValidation(plan.scope, memory.candidates, graph.citationValidationFence)
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
      const refreshedSelected = memory.candidates.find(
        candidate => candidate.uri === refreshedLogical.activeHandoffs[0]?.uri,
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

function withResumeMemoryGraphAnchors(
  graphPlan: ContextBriefPlanV1['graph'],
  memory: ContextBriefMemoryRetrievalV1,
  maximumRefs: number,
): ContextBriefPlanV1['graph'] {
  if (graphPlan.codeRefs.length > 0) return graphPlan;
  const handoff = [...memory.candidates]
    .filter(candidate => candidate.kind === 'handoff' && candidate.continuationCard !== undefined)
    .sort(
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
      handoff.codeCitations.map(citation =>
        citation.target.kind === 'symbol' && /^cgs_[0-9a-f]{32}$/u.test(citation.target.nodeId)
          ? citation.target.nodeId
          : citation.path,
      ),
    ),
  ].slice(0, maximumRefs);
  return codeRefs.length === 0 ? graphPlan : {...graphPlan, codeRefs};
}

function sameCodeRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((ref, index) => ref === right[index]);
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
