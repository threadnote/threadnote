import {sha256HexSync} from '@threadnote/platform/sha256';
import {AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN} from '@threadnote/protocol/agent-response';
import {
  CONTEXT_BRIEF_CITATION_RELOCATION_HINT_MAXIMUM_BYTES,
  CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
  CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
  CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
  CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
  CONTEXT_BRIEF_LEGACY_VERSION,
  CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
  CONTEXT_BRIEF_DEFAULT_PUBLIC_CODE_RELATIONS,
  CONTEXT_BRIEF_MAXIMUM_PUBLIC_CITATION_RECEIPTS,
  CONTEXT_BRIEF_MAXIMUM_PUBLIC_CODE_RELATIONS,
  CONTEXT_BRIEF_PROCEDURE_VERSION,
  CONTEXT_BRIEF_VERSION,
  parseContextBriefRequestV1,
  type ContextBriefCitationReceiptV2,
  type ContextBriefCitationSummaryV2,
  type ContextBriefContextIssueV1,
  type ContextBriefCitationValidationReceiptV2,
  type ContextBriefCodeAnchorCoverageV3,
  type ContextBriefFollowUpV1,
  type ContextBriefFreshness,
  type ContextBriefGraphEvidenceV1,
  type ContextBriefLogicalResultV1,
  type ContextBriefMemoryEvidenceV1,
  type ContextBriefMemoryRetrievalV1,
  type ContextBriefPlanV1,
  type ContextBriefPreciseEvidenceStatus,
  type ContextBriefRequestV1,
} from './types.js';
import type {VerifiedProcedureEvidence} from './procedure/selection.js';
import {
  classifyMemoryFreshness,
  contextBriefResumeTaskAlignmentScore,
  reconcileContextBriefMemoryFreshness,
} from '@threadnote/context/memory-evidence';

const MAXIMUM_ISSUES = 24;
const MAXIMUM_FOLLOW_UPS = 24;

/** Build a deterministic private retrieval plan. This is not a user-facing query language or output field. */
export function planContextBrief(input: ContextBriefRequestV1 | unknown): ContextBriefPlanV1 {
  const request = parseContextBriefRequestV1(input);
  const detail = request.detail ?? 'compact';
  const modeShape =
    request.mode === 'impact' || request.mode === 'trace'
      ? {edgeLimit: 64, evidenceCards: 10, nodeLimit: 24}
      : request.mode === 'explain'
        ? {edgeLimit: 48, evidenceCards: 8, nodeLimit: 20}
        : {edgeLimit: 32, evidenceCards: 8, nodeLimit: 16};
  return {
    codeAnchors: {
      candidateLimit: CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
      codeRefs: request.codeRefs ?? [],
      ...(request.scope.project === undefined ? {} : {project: request.scope.project}),
      query: request.task,
      scope: request.scope,
    },
    graph: {
      ...modeShape,
      codeRefs: request.codeRefs ?? [],
      detail,
      maximumEstimatedTokens: CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS,
      mode: request.mode,
      query: request.task,
      scope: request.scope,
      sourceMaximumBytes:
        detail === 'source'
          ? Math.floor(
              request.budgetTokens *
                AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN *
                (request.responseFormat === 'dual' ? 0.2 : 0.4),
            )
          : 0,
    },
    detail,
    memory: {
      candidateLimit: 24,
      query: request.task,
      requireResolvableMemoryIdentity: (request.codeRefs?.length ?? 0) > 0,
      scope: request.scope,
    },
    mode: request.mode,
    outputBudgetTokens: request.budgetTokens,
    responseFormat: request.responseFormat ?? 'dual',
    scope: request.scope,
    ...(request.surface === undefined ? {} : {surface: request.surface}),
    task: request.task,
  };
}

export function assembleContextBriefLogicalResult(input: {
  readonly graph: ContextBriefGraphEvidenceV1;
  readonly memory: ContextBriefMemoryRetrievalV1;
  readonly observedAt: string;
  readonly plan: ContextBriefPlanV1;
  readonly verifiedProcedureGaps?: readonly string[];
  readonly verifiedProcedures?: readonly VerifiedProcedureEvidence[];
}): ContextBriefLogicalResultV1 {
  const validations = new Map((input.memory.citationValidations ?? []).map(validation => [validation.uri, validation]));
  const memories = input.memory.candidates.flatMap(candidate => {
    const privateCitationReceipts = validationReceipts(
      candidate,
      validations.get(candidate.uri)?.receipts,
      input.observedAt,
    );
    const preciseStatus = aggregatePreciseStatus(privateCitationReceipts);
    const publicReceipts = publicCitationReceipts(privateCitationReceipts);
    const citationSummary = summarizeCitationReceipts(privateCitationReceipts);
    const validatedCodeRelations = publicCodeRelations(candidate, privateCitationReceipts);
    const cohortCodeRelations = validatedCodeRelations
      .filter(relation => relation.status === 'exact' || relation.status === 'relocated')
      .slice(0, CONTEXT_BRIEF_MAXIMUM_PUBLIC_CODE_RELATIONS);
    const codeRelations = validatedCodeRelations.slice(0, CONTEXT_BRIEF_DEFAULT_PUBLIC_CODE_RELATIONS);
    const citationReceipts = compactCodeLinkedCitationReceipts(publicReceipts, validatedCodeRelations);
    const coarse = classifyMemoryFreshness(candidate.sourceCommit, input.graph.resolvedSnapshots);
    const {
      actionCard: privateActionCard,
      citationErrorCount,
      codeCitations: _privateCodeCitations,
      codeLinkMatches: _privateCodeLinkMatches,
      lexicallySelected: _privateLexicallySelected,
      ...fullPublicCandidate
    } = candidate;
    if (
      candidate.codeLinkMatches !== undefined &&
      candidate.codeLinkMatches.length > 0 &&
      validatedCodeRelations.length === 0 &&
      candidate.lexicallySelected !== true
    ) {
      return [];
    }
    return [
      {
        ...fullPublicCandidate,
        ...(privateActionCard !== undefined &&
        preciseStatus === 'exact' &&
        codeRelations.some(relation => relation.status === 'exact')
          ? {actionCard: privateActionCard}
          : {}),
        ...(citationErrorCount === 0 ? {} : {citationErrorCount}),
        ...(citationReceipts.length === 0 ? {} : {citationReceipts}),
        ...(citationSummary === undefined ? {} : {citationSummary}),
        ...(cohortCodeRelations.length === 0 ? {} : {cohortCodeRelations}),
        ...(codeRelations.length === 0 ? {} : {codeRelations, selectionBasis: 'code-citation' as const}),
        freshness: preciseStatus === undefined ? coarse : reconcileContextBriefMemoryFreshness(coarse, preciseStatus),
        freshnessBasis: preciseStatus === undefined ? ('source-commit' as const) : ('code-citations' as const),
        ...(preciseStatus === undefined ? {} : {preciseStatus}),
      },
    ];
  }) satisfies readonly ContextBriefMemoryEvidenceV1[];
  const validatedCodeLinkedMemories = memories.filter(memory => memory.selectionBasis === 'code-citation').length;
  const durableDecisions = stableMemories(memories.filter(memory => memory.kind === 'durable'));
  const handoffs = prioritizeHandoffs(
    memories.filter(memory => memory.kind === 'handoff'),
    input.plan.mode,
    input.plan.task,
  );
  const issues = contextIssues(memories);
  const procedureGaps = stableUnique(input.verifiedProcedureGaps ?? []);
  const generalGaps = stableUnique([
    ...input.graph.gaps,
    ...contextBriefGraphWarningGaps(input.graph.warnings),
    ...input.memory.gaps,
    ...(input.graph.cards.length === 0 ? ['no-graph-evidence'] : []),
    ...(memories.length === 0 ? ['no-relevant-active-memory'] : []),
    ...(memories.some(memory => memory.freshness === 'unknown') ? ['memory-freshness-unknown'] : []),
    ...(input.plan.mode === 'resume' &&
    !handoffs.some(memory => memory.freshness === 'fresh' && memory.continuationCard !== undefined)
      ? ['resume-continuation-card-unavailable']
      : []),
    ...(memories.some(memory => (memory.citationErrorCount ?? 0) > 0) ? ['memory-code-citations-invalid'] : []),
    ...(memories.some(memory => memory.preciseStatus === 'relocated') ? ['memory-code-links-relocated'] : []),
    ...(input.memory.codeAnchorCoverage !== undefined &&
    input.memory.codeAnchorCoverage.matchedMemories > 0 &&
    validatedCodeLinkedMemories === 0
      ? ['code-anchor-selector-matches-unvalidated']
      : []),
  ]).filter(gap => !procedureGaps.includes(gap));
  const gaps = [...procedureGaps, ...generalGaps].slice(0, MAXIMUM_ISSUES);
  const freshness = scopeFreshness(input.graph);
  return {
    coverage: {
      gaps,
      graph: input.graph.coverage,
      memory: {
        ...(input.memory.codeAnchorCoverage === undefined
          ? {}
          : {
              codeAnchors: {
                ...input.memory.codeAnchorCoverage,
                matchedMemories: validatedCodeLinkedMemories,
              },
            }),
        consideredCandidates: input.memory.consideredCandidates,
        durableCandidates: durableDecisions.length,
        fresh: memories.filter(memory => memory.freshness === 'fresh').length,
        handoffCandidates: handoffs.length,
        stale: memories.filter(memory => memory.freshness === 'stale').length,
        unknown: memories.filter(memory => memory.freshness === 'unknown').length,
      },
    },
    durableDecisions,
    recommendedFollowUps: exactFollowUps(input.graph, memories, input.plan, input.memory.codeAnchorCoverage),
    graph: input.graph,
    activeHandoffs: handoffs,
    stalenessAndConflicts: issues,
    mode: input.plan.mode,
    scope: {
      ...(input.graph.projectCoverage === undefined ? {} : {projectCoverage: input.graph.projectCoverage}),
      freshness,
      kind: input.plan.scope.kind,
      name: input.plan.scope.kind === 'workset' ? input.plan.scope.name : 'current-repository',
      readyRepositories: input.graph.coverage.readyRepositories,
      requestedRepositories: input.graph.coverage.requestedRepositories,
    },
    task: input.plan.task,
    verifiedProcedures: input.verifiedProcedures ?? [],
    trust: {
      compiler: {modelsRequired: false, queryPlanExposed: false},
      graph: input.graph.trust,
      memory: input.memory.trust,
    },
    type: 'context-brief',
    version:
      (input.verifiedProcedures?.length ?? 0) > 0
        ? CONTEXT_BRIEF_PROCEDURE_VERSION
        : input.plan.codeAnchors.codeRefs.length === 0
          ? CONTEXT_BRIEF_LEGACY_VERSION
          : CONTEXT_BRIEF_VERSION,
  };
}

/**
 * Graph warnings may contain repository-derived text, so Context Brief exposes
 * bounded stable coverage codes instead of copying warning prose into either
 * agent channel. Every warning produces a generic signal; known partiality
 * classes add a more actionable code without claiming more than the source.
 */
export function contextBriefGraphWarningGaps(warnings: readonly string[]): readonly string[] {
  if (warnings.length === 0) return [];
  const normalized = warnings.map(warning => warning.normalize('NFKC').toLowerCase());
  return stableUnique([
    'graph-query-warning',
    ...(normalized.some(warning => /bridge|cross[- ]repository/u.test(warning))
      ? ['graph-bridge-evidence-incomplete']
      : []),
    ...(normalized.some(warning => /partial|limit|budget|elapsed|timed out|unavailable|withheld/u.test(warning))
      ? ['graph-evidence-partial']
      : []),
    ...(normalized.some(warning => /not found|did not resolve|unresolved/u.test(warning))
      ? ['graph-selector-unresolved']
      : []),
    ...(normalized.some(warning => /semantic|vector/u.test(warning)) ? ['graph-semantic-evidence-incomplete'] : []),
  ]);
}

function stableMemories(memories: readonly ContextBriefMemoryEvidenceV1[]): readonly ContextBriefMemoryEvidenceV1[] {
  return [...memories]
    .sort((left, right) => left.rank - right.rank || compareText(left.uri, right.uri))
    .map((memory, rank) => ({...memory, rank}));
}

function prioritizeHandoffs(
  memories: readonly ContextBriefMemoryEvidenceV1[],
  mode: ContextBriefPlanV1['mode'],
  task: string,
): readonly ContextBriefMemoryEvidenceV1[] {
  const priority = (memory: ContextBriefMemoryEvidenceV1): number =>
    mode === 'resume' && memory.freshness === 'fresh' && memory.continuationCard !== undefined ? 0 : 1;
  return [...memories]
    .sort(
      (left, right) =>
        priority(left) - priority(right) ||
        (mode === 'resume'
          ? contextBriefResumeTaskAlignmentScore(task, right) - contextBriefResumeTaskAlignmentScore(task, left)
          : 0) ||
        left.rank - right.rank ||
        compareText(left.uri, right.uri),
    )
    .map((memory, rank) => ({...memory, rank}));
}

function scopeFreshness(graph: ContextBriefGraphEvidenceV1): ContextBriefFreshness {
  if (graph.coverage.requestedRepositories === 0 || graph.coverage.readyRepositories === 0) return 'unknown';
  if (!graph.coverage.complete || graph.coverage.readyRepositories < graph.coverage.requestedRepositories)
    return 'stale';
  if (graph.resolvedSnapshots.length === 1) return graph.resolvedSnapshots[0].freshness;
  const stale =
    (graph.coverage.states.stale ?? 0) + (graph.coverage.states.missing ?? 0) + (graph.coverage.states.failed ?? 0);
  return stale > 0 ? 'stale' : 'fresh';
}

function contextIssues(memories: readonly ContextBriefMemoryEvidenceV1[]): readonly ContextBriefContextIssueV1[] {
  const issues: ContextBriefContextIssueV1[] = [];
  for (const memory of memories) {
    if ((memory.citationErrorCount ?? 0) > 0) {
      issues.push({
        id: issueId('invalid-code-citation', [memory.uri]),
        kind: 'invalid-code-citation',
        rank: issues.length,
        summary: `${memory.citationErrorCount ?? 0} malformed code citation line(s) were ignored for ${memory.topic ?? memory.uri}.`,
        uris: [memory.uri],
      });
    }
    if (memory.citationReceipts?.some(receipt => receipt.status === 'relocated')) {
      issues.push({
        id: issueId('stale-link', [memory.uri]),
        kind: 'stale-link',
        rank: issues.length,
        summary: `Cited code moved for ${memory.topic ?? memory.uri}; the memory remains fresh but its stored link is stale.`,
        uris: [memory.uri],
      });
    }
    if (memory.freshness === 'fresh') continue;
    const kind = memory.freshness === 'stale' ? 'stale-memory' : 'unknown-memory-freshness';
    issues.push({
      id: issueId(kind, [memory.uri]),
      kind,
      rank: issues.length,
      summary:
        memory.freshness === 'stale'
          ? memory.preciseStatus === 'changed' || memory.preciseStatus === 'deleted'
            ? `Cited code changed or was deleted for ${memory.topic ?? memory.uri}.`
            : `Source commit differs for ${memory.topic ?? memory.uri}.`
          : memory.preciseStatus === 'unknown' || (memory.citationErrorCount ?? 0) > 0
            ? `Cited code cannot be validated safely for ${memory.topic ?? memory.uri}.`
            : `Source commit cannot be resolved unambiguously for ${memory.topic ?? memory.uri}.`,
      uris: [memory.uri],
    });
  }

  const byIdentity = new Map<string, ContextBriefMemoryEvidenceV1[]>();
  for (const memory of memories) {
    if (!memory.project || !memory.topic) continue;
    const key = `${memory.kind}\u0000${memory.project.normalize('NFKC').toLowerCase()}\u0000${memory.topic
      .normalize('NFKC')
      .toLowerCase()}`;
    const group = byIdentity.get(key) ?? [];
    group.push(memory);
    byIdentity.set(key, group);
  }
  for (const group of byIdentity.values()) {
    const identities = new Set(group.map(memory => `${memory.sourceCommit ?? ''}\u0000${memory.excerpt}`));
    if (group.length < 2 || identities.size < 2) continue;
    const uris = group.map(memory => memory.uri).sort(compareText);
    issues.push({
      id: issueId('candidate-conflict', uris),
      kind: 'candidate-conflict',
      rank: issues.length,
      summary: `Multiple active memories disagree for ${group[0].project}/${group[0].topic}.`,
      uris,
    });
  }
  return issues
    .sort((left, right) => issuePriority(left.kind) - issuePriority(right.kind) || compareText(left.id, right.id))
    .slice(0, MAXIMUM_ISSUES)
    .map((issue, rank) => ({...issue, rank}));
}

function exactFollowUps(
  graph: ContextBriefGraphEvidenceV1,
  memories: readonly ContextBriefMemoryEvidenceV1[],
  plan: ContextBriefPlanV1,
  codeAnchorCoverage?: ContextBriefCodeAnchorCoverageV3,
): readonly ContextBriefFollowUpV1[] {
  const followUps: ContextBriefFollowUpV1[] = [];
  const staleRepositoryAnchors =
    plan.scope.kind === 'repository' &&
    plan.codeAnchors.codeRefs.length > 0 &&
    graph.coverage.readyRepositories > 0 &&
    scopeFreshness(graph) === 'stale' &&
    codeAnchorCoverage?.complete === false;
  const graphStatusRequired =
    graph.coverage.readyRepositories === 0 ||
    graph.gaps.includes('graph-repository-read-failed') ||
    staleRepositoryAnchors;
  if (
    graphStatusRequired &&
    (plan.scope.kind === 'workset' || new TextEncoder().encode(plan.scope.callerCwd).byteLength <= 128)
  ) {
    followUps.push({
      arguments:
        plan.scope.kind === 'repository'
          ? {
              budgetTokens: CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
              callerCwd: plan.scope.callerCwd,
              edgeLimit: CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
              nodeLimit: CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
              operation: 'query',
              query: 'code graph readiness',
            }
          : {
              budgetTokens: CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
              edgeLimit: CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
              nodeLimit: CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
              operation: 'query',
              query: 'code graph readiness',
              workset: plan.scope.name,
            },
      id: followUpId('graph-status', plan.scope.kind),
      operation: 'graph-status',
      rank: followUps.length,
      scope: plan.scope.kind,
      tool: 'inspect_code_graph',
      ...(plan.scope.kind === 'workset' ? {workset: plan.scope.name} : {}),
    });
  }
  const firstCardHasCurrentSource = graph.sourceExcerpts?.some(
    source => source.freshness === 'fresh' && source.coveredGraphRefs.includes(graph.cards[0]?.ref ?? ''),
  );
  if (plan.scope.kind === 'repository' && new TextEncoder().encode(plan.scope.callerCwd).byteLength <= 128) {
    for (const card of firstCardHasCurrentSource
      ? []
      : [...graph.cards].sort((left, right) => left.rank - right.rank || compareText(left.id, right.id))) {
      followUps.push({
        arguments: {
          budgetTokens: CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
          callerCwd: plan.scope.callerCwd,
          edgeLimit: CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
          nodeId: card.ref,
          nodeLimit: CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
          operation: 'node',
        },
        id: followUpId('inspect-node', card.ref),
        operation: 'inspect-node',
        rank: followUps.length,
        ref: card.ref,
        tool: 'inspect_code_graph',
      });
    }
  }
  const graphCardRefs = new Set(graph.cards.map(card => card.ref));
  const relocatedNodeIds = stableUnique(
    memories.flatMap(memory =>
      (memory.citationReceipts ?? []).flatMap(receipt =>
        receipt.status === 'relocated' && receipt.observedNodeId !== undefined ? [receipt.observedNodeId] : [],
      ),
    ),
  );
  if (plan.scope.kind === 'repository' && new TextEncoder().encode(plan.scope.callerCwd).byteLength <= 128) {
    for (const observedNodeId of relocatedNodeIds) {
      if (graphCardRefs.has(observedNodeId)) continue;
      followUps.push({
        arguments: {
          budgetTokens: CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
          callerCwd: plan.scope.callerCwd,
          edgeLimit: CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
          nodeId: observedNodeId,
          nodeLimit: CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
          operation: 'node',
        },
        id: followUpId('inspect-node', observedNodeId),
        operation: 'inspect-node',
        rank: followUps.length,
        ref: observedNodeId,
        tool: 'inspect_code_graph',
      });
    }
  }
  for (const memory of stableMemories(memories)) {
    if (plan.mode === 'resume' && memory.continuationCard !== undefined) continue;
    followUps.push({
      arguments: {uri: memory.uri},
      id: followUpId('read-memory', memory.uri),
      operation: 'read-memory',
      rank: followUps.length,
      tool: 'read_context',
      uri: memory.uri,
    });
  }
  if (graph.continuation !== undefined && plan.scope.kind === 'workset') {
    followUps.push({
      arguments: {
        budgetTokens: CONTEXT_BRIEF_FOLLOW_UP_BUDGET_TOKENS,
        cursor: graph.continuation.cursor,
        edgeLimit: CONTEXT_BRIEF_FOLLOW_UP_EDGE_LIMIT,
        nodeLimit: CONTEXT_BRIEF_FOLLOW_UP_NODE_LIMIT,
        operation: 'query',
        workset: plan.scope.name,
      },
      cursor: graph.continuation.cursor,
      id: followUpId('continue-workset', graph.continuation.cursor),
      operation: 'continue-workset',
      rank: followUps.length,
      tool: 'inspect_code_graph',
      workset: plan.scope.name,
    });
  }
  return followUps.slice(0, MAXIMUM_FOLLOW_UPS).map((followUp, rank) => ({...followUp, rank}));
}

function issuePriority(kind: ContextBriefContextIssueV1['kind']): number {
  switch (kind) {
    case 'candidate-conflict':
      return 0;
    case 'invalid-code-citation':
      return 1;
    case 'stale-memory':
      return 2;
    case 'stale-link':
      return 3;
    case 'unknown-memory-freshness':
      return 4;
  }
}

function validationReceipts(
  candidate: ContextBriefMemoryRetrievalV1['candidates'][number],
  observed: readonly ContextBriefCitationValidationReceiptV2[] | undefined,
  observedAt: string,
): readonly ContextBriefCitationValidationReceiptV2[] {
  const observedById = new Map((observed ?? []).map(receipt => [receipt.citationId, receipt]));
  const receipts = candidate.codeCitations.map(
    citation =>
      observedById.get(citation.id) ?? {
        candidateCount: 0,
        citationId: citation.id,
        coverage: 'incomplete' as const,
        kind: citation.target.kind,
        observedAt,
        reason: 'repository-unavailable' as const,
        repositoryId: citation.repositoryId,
        sourcePath: citation.path,
        status: 'unknown' as const,
        strategy: 'none' as const,
        validatorVersion: CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
      },
  );
  for (let index = 0; index < candidate.citationErrorCount; index += 1) {
    receipts.push({
      candidateCount: 0,
      citationId: `tncc_${sha256HexSync(`${candidate.uri}\u0000malformed\u0000${index}`).slice(0, 40)}`,
      coverage: 'incomplete',
      kind: 'malformed',
      observedAt,
      reason: 'malformed-citation',
      status: 'unknown',
      strategy: 'none',
      validatorVersion: CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
    });
  }
  return receipts;
}

function publicCitationReceipts(
  receipts: readonly ContextBriefCitationValidationReceiptV2[],
): readonly ContextBriefCitationReceiptV2[] {
  const auditReceipt = receipts.find(
    receipt =>
      receipt.status === 'relocated' &&
      (publicObservedNodeId(receipt) !== undefined || boundedRelocationHint(receipt.observedPath) !== undefined),
  );
  return receipts.slice(0, CONTEXT_BRIEF_MAXIMUM_PUBLIC_CITATION_RECEIPTS).map(receipt => {
    // One move hint per memory is enough to provide an exact audit follow-up
    // without letting repeated optional metadata evict the memory itself.
    const observedNodeId = receipt === auditReceipt ? publicObservedNodeId(receipt) : undefined;
    const relocationHint =
      receipt === auditReceipt && observedNodeId === undefined
        ? boundedRelocationHint(receipt.observedPath)
        : undefined;
    return {
      citationId: receipt.citationId,
      ...(observedNodeId === undefined ? {} : {observedNodeId}),
      reason: receipt.reason,
      ...(relocationHint === undefined ? {} : {relocationHint}),
      status: receipt.status,
    };
  });
}

function publicCodeRelations(
  candidate: ContextBriefMemoryRetrievalV1['candidates'][number],
  receipts: readonly ContextBriefCitationValidationReceiptV2[],
): readonly NonNullable<ContextBriefMemoryEvidenceV1['codeRelations']>[number][] {
  if (candidate.codeLinkMatches === undefined || candidate.codeLinkMatches.length === 0) return [];
  const receiptsById = new Map(receipts.map(receipt => [receipt.citationId, receipt]));
  const seenAnchors = new Set<number>();
  return candidate.codeLinkMatches
    .flatMap(match => {
      const receipt = receiptsById.get(match.citationId);
      const status = codeLinkRelationStatus(match, receipt);
      if (status === undefined) return [];
      return [
        {
          anchorOrdinal: match.anchorOrdinal,
          citationId: match.citationId,
          kind: match.matchKind.startsWith('symbol-') ? ('symbol' as const) : ('file' as const),
          strength: codeLinkMatchPriority(match.matchKind),
          status,
        },
      ];
    })
    .sort(
      (left, right) =>
        codeRelationStatusPriority(left.status) - codeRelationStatusPriority(right.status) ||
        left.strength - right.strength ||
        left.anchorOrdinal - right.anchorOrdinal ||
        compareText(left.citationId, right.citationId),
    )
    .flatMap(({strength: _strength, ...relation}) => {
      if (seenAnchors.has(relation.anchorOrdinal)) return [];
      seenAnchors.add(relation.anchorOrdinal);
      return [relation];
    });
}

function codeRelationStatusPriority(status: ContextBriefPreciseEvidenceStatus): number {
  switch (status) {
    case 'exact':
      return 0;
    case 'relocated':
      return 1;
    case 'changed':
    case 'deleted':
      return 2;
    case 'unknown':
      return 3;
  }
}

function compactCodeLinkedCitationReceipts(
  receipts: readonly ContextBriefCitationReceiptV2[],
  relations: readonly NonNullable<ContextBriefMemoryEvidenceV1['codeRelations']>[number][],
): readonly ContextBriefCitationReceiptV2[] {
  if (relations.length === 0) return receipts;
  return receipts
    .filter(receipt => receipt.observedNodeId !== undefined || receipt.relocationHint !== undefined)
    .slice(0, 1);
}

function codeLinkRelationStatus(
  match: NonNullable<ContextBriefMemoryRetrievalV1['candidates'][number]['codeLinkMatches']>[number],
  receipt: ContextBriefCitationValidationReceiptV2 | undefined,
): ContextBriefPreciseEvidenceStatus | undefined {
  switch (match.matchKind) {
    case 'symbol-locator':
      return match.anchorNodeId !== undefined && receipt?.observedNodeId === match.anchorNodeId
        ? (receipt?.status ?? 'unknown')
        : undefined;
    case 'file-content':
      return receipt?.observedPath === match.anchorPath ? (receipt?.status ?? 'unknown') : undefined;
    case 'symbol-node': {
      if (match.anchorNodeId === undefined) return undefined;
      if (receipt?.observedNodeId === undefined) return 'unknown';
      return receipt.observedNodeId === match.anchorNodeId ? receipt.status : undefined;
    }
    case 'file-path':
      if (receipt?.observedPath === undefined) return 'unknown';
      return receipt.observedPath === match.anchorPath ? receipt.status : undefined;
  }
}

function codeLinkMatchPriority(
  matchKind: NonNullable<ContextBriefMemoryRetrievalV1['candidates'][number]['codeLinkMatches']>[number]['matchKind'],
): number {
  switch (matchKind) {
    case 'symbol-node':
      return 0;
    case 'symbol-locator':
      return 1;
    case 'file-path':
      return 2;
    case 'file-content':
      return 3;
  }
}

function summarizeCitationReceipts(
  receipts: readonly ContextBriefCitationValidationReceiptV2[],
): ContextBriefCitationSummaryV2 | undefined {
  if (receipts.length === 0) return undefined;
  return {
    coverage: receipts.every(isCurrentCompleteReceipt) ? 'current-complete' : 'incomplete',
    exact: receipts.filter(receipt => receipt.status === 'exact').length,
    relocated: receipts.filter(receipt => receipt.status === 'relocated').length,
    stale: receipts.filter(receipt => receipt.status === 'changed' || receipt.status === 'deleted').length,
    unknown: receipts.filter(receipt => receipt.status === 'unknown').length,
    validatorVersion: CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
  };
}

function isCurrentCompleteReceipt(receipt: ContextBriefCitationValidationReceiptV2): boolean {
  return receipt.coverage === 'current-complete';
}

function publicObservedNodeId(receipt: ContextBriefCitationValidationReceiptV2): string | undefined {
  if (receipt.status !== 'exact' && receipt.status !== 'relocated') return undefined;
  return receipt.observedNodeId !== undefined &&
    /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u.test(receipt.observedNodeId)
    ? receipt.observedNodeId
    : undefined;
}

function boundedRelocationHint(observedPath: string | undefined): string | undefined {
  if (observedPath === undefined || hasUnsupportedControlCharacter(observedPath)) return undefined;
  const pathTail = observedPath
    .replace(/\\/gu, '/')
    .split('/')
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    .slice(-2)
    .join('/');
  if (pathTail === '') return undefined;
  const encoder = new TextEncoder();
  if (encoder.encode(pathTail).byteLength <= CONTEXT_BRIEF_CITATION_RELOCATION_HINT_MAXIMUM_BYTES) return pathTail;
  let suffix = '';
  for (const character of [...pathTail].reverse()) {
    const candidate = `${character}${suffix}`;
    if (encoder.encode(`…${candidate}`).byteLength > CONTEXT_BRIEF_CITATION_RELOCATION_HINT_MAXIMUM_BYTES) break;
    suffix = candidate;
  }
  return suffix === '' ? undefined : `…${suffix}`;
}

function hasUnsupportedControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 || code === 133 || code === 8_232 || code === 8_233;
  });
}

export function aggregatePreciseStatus(
  receipts: readonly Pick<ContextBriefCitationValidationReceiptV2, 'status'>[],
): ContextBriefMemoryEvidenceV1['preciseStatus'] {
  if (receipts.length === 0) return undefined;
  if (receipts.some(receipt => receipt.status === 'changed')) return 'changed';
  if (receipts.some(receipt => receipt.status === 'deleted')) return 'deleted';
  if (receipts.some(receipt => receipt.status === 'unknown')) return 'unknown';
  return receipts.some(receipt => receipt.status === 'relocated') ? 'relocated' : 'exact';
}

function issueId(kind: ContextBriefContextIssueV1['kind'], uris: readonly string[]): string {
  return `cbci_${sha256HexSync(`${kind}\u0000${uris.join('\u0000')}`).slice(0, 24)}`;
}

function followUpId(kind: string, target: string): string {
  return `cbfu_${sha256HexSync(`${kind}\u0000${target}`).slice(0, 24)}`;
}

function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
