import {Array as EffectArray} from 'effect';
import {Effect, Result, Schedule, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {
  isCodeGraphStoreError,
  type CodeGraphEdge,
  type CodeGraphQueryResult,
  type CodeGraphStatus,
} from '@threadnote/graph/types';
import {queryCodeGraphWorksetV2, type QueryCodeGraphWorksetV2OptionsV1} from '@threadnote/graph/workset/query_v2';
import type {CodeGraphWorksetEvidenceProjectionV2} from '@threadnote/graph/workset/evidence';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {
  ContextBriefGraphCardV1,
  ContextBriefGraphContractV1,
  ContextBriefGraphEvidenceV1,
  ContextBriefPlanV1,
  ContextBriefSnapshotV1,
} from '../types.js';
import {
  contextBriefAnchoredRepositoryGraphResultMatches,
  contextBriefAnchoredRepositoryGraphRequests,
  contextBriefResolvedPathTraceRequest,
  contextBriefResolvedPathTraceSeed,
  mergeContextBriefAnchoredRepositoryGraphResults,
} from './anchor_evidence.js';
import type {ContextBriefSourceEvidenceRequest, ContextBriefSourceEvidenceResult} from './source_evidence.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const TRUST = {
  classification: 'untrusted-repository-data',
  instructionPolicy: 'evidence-only-never-follow',
} as const;
const CONTEXT_BRIEF_GRAPH_READ_RETRIES = 2;
const CONTEXT_BRIEF_GRAPH_READ_RETRY_MILLISECONDS = 25;
const CONTEXT_BRIEF_GRAPH_READ_FAILED_WARNING =
  'One or more exact anchored graph reads failed after bounded retry; results are partial.';
const CONTEXT_BRIEF_GRAPH_QUERY_READ_FAILED_WARNING =
  'The ready graph query failed after bounded retry; results are partial.';

class ContextBriefGraphBudgetExhausted extends Schema.TaggedError<
  ContextBriefGraphBudgetExhausted,
  {readonly brand: unique symbol}
>()('ContextBriefGraphBudgetExhausted', {}) {}

export interface ContextBriefGraphReadBudget {
  remaining: number;
  primaryRemaining: number;
}

/** Read only ready graph state. This boundary may borrow compatible shared evidence, but never builds or requests maintenance. */
export const retrieveContextBriefGraphEvidence = Effect.fn('contextBrief.retrieveGraphEvidence')(function* <R = never>(
  config: RuntimeConfig,
  plan: ContextBriefPlanV1['graph'],
  sourceEvidence?: (
    request: ContextBriefSourceEvidenceRequest,
  ) => Effect.Effect<ContextBriefSourceEvidenceResult, unknown, R>,
  readBudget?: ContextBriefGraphReadBudget,
) {
  return plan.scope.kind === 'workset'
    ? yield* retrieveWorksetGraphEvidence(config, plan)
    : yield* retrieveRepositoryGraphEvidence(config, plan, sourceEvidence, readBudget);
});

const retrieveWorksetGraphEvidence = Effect.fn('contextBrief.retrieveWorksetGraphEvidence')(function* (
  config: RuntimeConfig,
  plan: ContextBriefPlanV1['graph'],
) {
  if (plan.scope.kind !== 'workset') throw new Error('Context Brief workset graph plan has the wrong scope.');
  const options: QueryCodeGraphWorksetV2OptionsV1 = {
    edgeLimit: plan.edgeLimit,
    evidenceCards: plan.evidenceCards,
    maximumEstimatedTokens: plan.maximumEstimatedTokens,
    nodeLimit: plan.nodeLimit,
    query: plan.query,
    worksetName: plan.scope.name,
  };
  const result = yield* queryCodeGraphWorksetV2(config, options);
  const evidence = fromWorksetProjection(result.structuredContent);
  return plan.detail === 'source' ? withSourceGap(evidence, 'graph-source-scope-unsupported') : evidence;
});

const retrieveRepositoryGraphEvidence = Effect.fn('contextBrief.retrieveRepositoryGraphEvidence')(function* <R = never>(
  config: RuntimeConfig,
  plan: ContextBriefPlanV1['graph'],
  sourceEvidence?: (
    request: ContextBriefSourceEvidenceRequest,
  ) => Effect.Effect<ContextBriefSourceEvidenceResult, unknown, R>,
  readBudget?: ContextBriefGraphReadBudget,
) {
  if (plan.scope.kind !== 'repository') throw new Error('Context Brief repository graph plan has the wrong scope.');
  const callerCwd = plan.scope.callerCwd;
  const query = yield* CodeGraphQueryService;
  const scopeOptions = {project: plan.scope.project, manifestPath: config.manifestPath};
  let status = yield* query.status(config.agentContextHome, callerCwd, {...scopeOptions, requestMaintenance: false});
  if (status.readySnapshot === undefined) {
    status = yield* query.attachSharedReadySnapshot(config.agentContextHome, status.identity, status, {
      allowBorrowedStale: true,
      requestMaintenance: false,
    });
  }
  const readySnapshot = status.readySnapshot;
  if (readySnapshot === undefined) {
    return withSourceGapIfRequested(
      {
        ...unavailableContextBriefGraphEvidence('graph-ready-snapshot-missing', 1, {
          missing: 1,
        }),
        ...(status.projectCoverage === undefined ? {} : {projectCoverage: status.projectCoverage}),
      },
      plan,
    );
  }
  const retryBudget = readBudget ?? {remaining: CONTEXT_BRIEF_GRAPH_READ_RETRIES, primaryRemaining: 17};
  if (retryBudget.primaryRemaining <= 0) {
    return withSourceGapIfRequested(
      unavailableReadyRepositoryGraphEvidence(
        status,
        ['graph-read-budget-exhausted'],
        ['Ready graph inspection budget exhausted; results are partial.'],
      ),
      plan,
    );
  }
  const anchoredRequests = contextBriefAnchoredRepositoryGraphRequests(plan);
  if (anchoredRequests.length > 0) {
    const outcomes = yield* Effect.forEach(
      anchoredRequests,
      request =>
        Effect.gen(function* () {
          const primary = yield* Effect.result(
            retryContextBriefGraphRead(
              query.inspect({
                ...scopeOptions,
                cwd: callerCwd,
                depth: request.depth,
                direction: request.direction,
                edgeLimit: request.edgeLimit,
                nodeLimit: request.nodeLimit,
                operation: request.operation,
                ...(request.nodeId === undefined ? {} : {nodeId: request.nodeId}),
                ...(request.query === undefined ? {} : {query: request.query}),
                ...(request.seedQueries === undefined ? {} : {seedQueries: request.seedQueries}),
                ...(request.seedQueryCount === undefined ? {} : {seedQueryCount: request.seedQueryCount}),
                refresh: false,
                requestMaintenance: false,
                statusObservation: observationFromCodeGraphStatus(status),
                strictFreshness: false,
                threadnoteHome: config.agentContextHome,
              }),
              retryBudget,
            ),
          );
          if (Result.isFailure(primary)) {
            return {complete: false as const, readFailed: true, result: undefined};
          }
          if (!matchesReadyGraph(primary.success, request, status, readySnapshot.id)) {
            return {complete: false as const, readFailed: false, result: undefined};
          }
          if (request.phase === 'evidence') {
            return {complete: true as const, readFailed: false, result: primary.success};
          }
          const path = request.query;
          if (path === undefined) return {complete: false as const, readFailed: false, result: undefined};
          const seed = contextBriefResolvedPathTraceSeed(primary.success, path);
          if (seed === undefined) return {complete: false as const, readFailed: false, result: undefined};
          if (plan.mode === 'locate') {
            return {
              complete: true as const,
              readFailed: false,
              result: {...primary.success, edges: [], nodes: [seed]},
            };
          }
          const evidenceRequest = contextBriefResolvedPathTraceRequest(plan, seed.id);
          const evidence = yield* Effect.result(
            retryContextBriefGraphRead(
              query.inspect({
                ...scopeOptions,
                cwd: callerCwd,
                depth: evidenceRequest.depth,
                direction: evidenceRequest.direction,
                edgeLimit: evidenceRequest.edgeLimit,
                nodeId: evidenceRequest.nodeId,
                nodeLimit: evidenceRequest.nodeLimit,
                operation: evidenceRequest.operation,
                refresh: false,
                requestMaintenance: false,
                statusObservation: observationFromCodeGraphStatus(status),
                strictFreshness: false,
                threadnoteHome: config.agentContextHome,
              }),
              retryBudget,
            ),
          );
          if (
            Result.isSuccess(evidence) &&
            matchesReadyGraph(evidence.success, evidenceRequest, status, readySnapshot.id)
          ) {
            return {complete: true as const, readFailed: false, result: evidence.success};
          }
          return {
            complete: false as const,
            readFailed: Result.isFailure(evidence),
            result: {
              ...primary.success,
              edges: [],
              nodes: [seed],
              warnings: [
                ...primary.success.warnings,
                'Exact anchored relationship traversal was unavailable; results are partial.',
              ],
            },
          };
        }),
      // Large cold graphs are sensitive to nested SQLite read amplification:
      // the compiler already retrieves code-linked memory in parallel.
      {concurrency: 1},
    );
    const exact = EffectArray.flatMap(outcomes, outcome => (outcome.result === undefined ? [] : [outcome.result]));
    const readFailed = EffectArray.some(outcomes, outcome => outcome.readFailed);
    if (exact.length === 0) {
      return withSourceGapIfRequested(
        unavailableReadyRepositoryGraphEvidence(
          status,
          readFailed ? ['graph-query-unavailable', 'graph-repository-read-failed'] : ['graph-query-unavailable'],
          readFailed ? [CONTEXT_BRIEF_GRAPH_READ_FAILED_WARNING] : [],
        ),
        plan,
      );
    }
    const complete = EffectArray.filter(
      outcomes,
      (outcome, __effectArrayIndex) => __effectArrayIndex in outcomes && outcome.complete,
    ).length;
    const evidence = yield* repositoryEvidenceWithSources(
      mergeContextBriefAnchoredRepositoryGraphResults(plan, exact, anchoredRequests.length - complete),
      status,
      plan,
      sourceEvidence,
    );
    return complete === anchoredRequests.length
      ? evidence
      : {
          ...evidence,
          coverage: {...evidence.coverage, complete: false},
          gaps: stableGraphStrings([
            ...evidence.gaps,
            'graph-coverage-incomplete',
            ...(readFailed ? ['graph-repository-read-failed'] : []),
          ]),
          warnings: stableGraphStrings([
            ...evidence.warnings,
            ...(readFailed ? [CONTEXT_BRIEF_GRAPH_READ_FAILED_WARNING] : []),
          ]).slice(0, 16),
        };
  }
  const result = yield* Effect.result(
    retryContextBriefGraphRead(
      query.inspect({
        ...scopeOptions,
        cwd: callerCwd,
        edgeLimit: plan.edgeLimit,
        nodeLimit: plan.nodeLimit,
        operation: 'query',
        query: plan.query,
        refresh: false,
        requestMaintenance: false,
        statusObservation: observationFromCodeGraphStatus(status),
        strictFreshness: false,
        threadnoteHome: config.agentContextHome,
      }),
      retryBudget,
    ),
  );
  if (Result.isFailure(result)) {
    return withSourceGapIfRequested(
      unavailableReadyRepositoryGraphEvidence(
        status,
        ['graph-query-unavailable', 'graph-repository-read-failed'],
        [CONTEXT_BRIEF_GRAPH_QUERY_READ_FAILED_WARNING],
      ),
      plan,
    );
  }
  if (
    result.success.repository.repositoryId !== status.identity.repositoryId ||
    result.success.snapshot.id !== readySnapshot.id
  ) {
    return withSourceGapIfRequested(
      unavailableReadyRepositoryGraphEvidence(status, ['graph-query-unavailable'], []),
      plan,
    );
  }
  return yield* repositoryEvidenceWithSources(result.success, status, plan, sourceEvidence);
});

const repositoryEvidenceWithSources = Effect.fn('contextBrief.repositoryEvidenceWithSources')(function* <R = never>(
  result: CodeGraphQueryResult,
  status: CodeGraphStatus,
  plan: ContextBriefPlanV1['graph'],
  sourceEvidence?: (
    request: ContextBriefSourceEvidenceRequest,
  ) => Effect.Effect<ContextBriefSourceEvidenceResult, unknown, R>,
) {
  const evidence = fromRepositoryQuery(result);
  if (plan.detail !== 'source') return evidence;
  if (result.freshness !== 'current') return withSourceGap(evidence, 'graph-source-snapshot-not-current');
  if (sourceEvidence === undefined) return withSourceGap(evidence, 'graph-source-reader-unavailable');
  const source = yield* sourceEvidence({
    identity: status.identity,
    maximumContentBytes: plan.sourceMaximumBytes,
    repositoryKey: result.repository.displayName,
    result,
  }).pipe(Effect.orElseSucceed(() => ({excerpts: [], gaps: ['graph-source-read-failed']}) as const));
  return {
    ...evidence,
    gaps: stableGraphStrings([...evidence.gaps, ...source.gaps]),
    ...(source.excerpts.length === 0 ? {} : {sourceExcerpts: source.excerpts}),
  };
});

function withSourceGapIfRequested(
  evidence: ContextBriefGraphEvidenceV1,
  plan: ContextBriefPlanV1['graph'],
): ContextBriefGraphEvidenceV1 {
  return plan.detail === 'source' ? withSourceGap(evidence, 'graph-source-evidence-unavailable') : evidence;
}

function withSourceGap(evidence: ContextBriefGraphEvidenceV1, gap: string): ContextBriefGraphEvidenceV1 {
  return {...evidence, gaps: stableGraphStrings([...evidence.gaps, gap])};
}

function matchesReadyGraph(
  result: CodeGraphQueryResult,
  request: Parameters<typeof contextBriefAnchoredRepositoryGraphResultMatches>[0],
  status: CodeGraphStatus,
  snapshotId: string,
): boolean {
  return (
    result.repository.repositoryId === status.identity.repositoryId &&
    result.snapshot.id === snapshotId &&
    contextBriefAnchoredRepositoryGraphResultMatches(request, result)
  );
}

export function fromWorksetProjection(result: CodeGraphWorksetEvidenceProjectionV2): ContextBriefGraphEvidenceV1 {
  const cards = EffectArray.map(result.cards, (card, rank): ContextBriefGraphCardV1 => ({
    id: card.id,
    rank,
    reason: compactText(card.reason.summary, 160),
    ref: card.ref,
    repositoryKey: card.repositoryKey,
    symbol: {
      kind: compactText(card.symbol.kind, 80),
      language: compactText(card.symbol.language, 80),
      line: card.symbol.span.line,
      name: compactText(card.symbol.name, 160),
      ...(card.symbol.packageName === undefined ? {} : {packageName: compactText(card.symbol.packageName, 160)}),
      path: card.symbol.path,
      qualifiedName: compactText(card.symbol.qualifiedName, 240),
    },
  }));
  const contracts = uniqueContracts(
    EffectArray.flatMap(result.cards, (card, cardRank) =>
      EffectArray.map(card.relationships, (relationship, relationshipRank): ContextBriefGraphContractV1 => ({
        authority: relationship.authority,
        evidence: {
          line: relationship.evidence.span.line,
          path: relationship.evidence.path,
          repositoryKey: relationship.evidence.repositoryKey,
        },
        id: contractId([
          relationship.source.ref,
          relationship.relation,
          relationship.target.ref,
          relationship.evidence.repositoryKey,
          relationship.evidence.path,
          String(relationship.evidence.span.line),
        ]),
        provenance: relationship.provenance,
        rank: cardRank * 32 + relationshipRank,
        relation: relationship.relation,
        sourceRef: relationship.source.ref,
        targetRef: relationship.target.ref,
      })),
    ),
  );
  const snapshots = EffectArray.map(
    EffectArray.filter(
      EffectRecord.toEntries(result.repositories),
      ([, receipt]) => receipt.snapshot !== undefined,
    ).sort(([left], [right]) => compareText(left, right)),
    ([repositoryKey, receipt]): ContextBriefSnapshotV1 => ({
      commit: receipt.snapshot!.commit,
      dirty: receipt.snapshot!.dirty,
      freshness: receipt.snapshot!.freshness === 'current' ? 'fresh' : 'stale',
      repositoryId: receipt.repositoryId,
      repositoryKey,
      snapshotId: receipt.snapshot!.id,
    }),
  );
  const readyRepositories = (result.coverage.states.current ?? 0) + (result.coverage.states.stale ?? 0);
  const gaps = [
    ...(result.coverage.complete ? [] : ['graph-coverage-incomplete']),
    ...((result.coverage.states.missing ?? 0) > 0 ? ['graph-snapshots-missing'] : []),
    ...((result.coverage.states.failed ?? 0) > 0 ? ['graph-repository-read-failed'] : []),
    ...(result.output.omittedCards > 0 ? ['graph-evidence-has-continuation'] : []),
  ];
  return {
    cards,
    citationValidationFence: {
      generation: result.workset.generation,
      kind: 'workset',
      workset: result.workset.name,
    },
    ...(result.continuation === undefined ? {} : {continuation: result.continuation}),
    contracts,
    coverage: {
      complete: result.coverage.complete,
      consideredRepositories: result.coverage.consideredRepositories,
      readyRepositories,
      requestedRepositories: result.coverage.requestedRepositories,
      states: result.coverage.states,
    },
    gaps,
    resolvedSnapshots: result.coverage.requestedRepositories === 1 && snapshots.length === 1 ? snapshots : [],
    trust: TRUST,
    warnings: EffectArray.map(result.warnings, warning => compactText(warning, 240)).slice(0, 16),
  };
}

export function fromRepositoryQuery(result: CodeGraphQueryResult): ContextBriefGraphEvidenceV1 {
  const repositoryKey = compactText(result.repository.displayName, 160);
  const cards = EffectArray.map(result.nodes, (node, rank): ContextBriefGraphCardV1 => ({
    id: `cbgc_${Effect2.pipe(sha256HexSync(`${result.repository.repositoryId}\u0000${node.id}`), EffectString.slice(0, 24))}`,
    rank,
    reason: `Indexed symbol match (${node.score.toFixed(3)}).`,
    ref: node.id,
    repositoryKey,
    symbol: {
      kind: compactText(node.kind, 80),
      language: compactText(node.language, 80),
      line: node.span.line,
      name: compactText(node.name, 160),
      ...(node.packageName === undefined ? {} : {packageName: compactText(node.packageName, 160)}),
      path: node.path,
      qualifiedName: compactText(node.qualifiedName, 240),
    },
  }));
  const contracts = uniqueContracts(
    EffectArray.flatMap(result.edges, (edge, rank) => repositoryContract(edge, rank, repositoryKey)),
  );
  const snapshot: ContextBriefSnapshotV1 = {
    commit: result.snapshot.commit,
    dirty: result.snapshot.dirty,
    freshness: result.freshness === 'current' ? 'fresh' : result.freshness === 'stale' ? 'stale' : 'unknown',
    repositoryId: result.repository.repositoryId,
    repositoryKey,
    snapshotId: result.snapshot.id,
  };
  return {
    ...(result.projectCoverage === undefined ? {} : {projectCoverage: result.projectCoverage}),
    cards,
    citationValidationFence: {
      kind: 'repository',
      repositoryId: result.repository.repositoryId,
      snapshotId: result.snapshot.id,
    },
    contracts,
    coverage: {
      complete: result.projectCoverage?.completeness !== 'partial',
      consideredRepositories: 1,
      readyRepositories: 1,
      requestedRepositories: 1,
      states: {[result.freshness]: 1},
    },
    gaps: result.projectCoverage?.completeness === 'partial' ? ['graph-project-scope-partial'] : [],
    resolvedSnapshots: [snapshot],
    trust: TRUST,
    warnings: EffectArray.map(result.warnings, warning => compactText(warning, 240)).slice(0, 16),
  };
}

export function unavailableContextBriefGraphEvidence(
  gap = 'graph-query-unavailable',
  requestedRepositories = 0,
  states: Readonly<Record<string, number>> = {},
): ContextBriefGraphEvidenceV1 {
  return {
    cards: [],
    contracts: [],
    coverage: {
      complete: false,
      consideredRepositories: 0,
      readyRepositories: 0,
      requestedRepositories,
      states,
    },
    gaps: [gap],
    resolvedSnapshots: [],
    trust: TRUST,
    warnings: [],
  };
}

function unavailableReadyRepositoryGraphEvidence(
  status: CodeGraphStatus,
  gaps: readonly string[],
  warnings: readonly string[],
): ContextBriefGraphEvidenceV1 {
  const snapshot = status.readySnapshot;
  if (snapshot === undefined) return unavailableContextBriefGraphEvidence(gaps[0], 1, {missing: 1});
  const repositoryKey = compactText(status.identity.displayName, 160);
  const freshness =
    status.freshness === 'current' ? 'fresh' : status.freshness === 'stale' ? 'stale' : ('unknown' as const);
  return {
    ...(status.projectCoverage === undefined ? {} : {projectCoverage: status.projectCoverage}),
    cards: [],
    citationValidationFence: {
      kind: 'repository',
      repositoryId: status.identity.repositoryId,
      snapshotId: snapshot.id,
    },
    contracts: [],
    coverage: {
      complete: false,
      consideredRepositories: 1,
      readyRepositories: 1,
      requestedRepositories: 1,
      states: {[status.freshness]: 1},
    },
    gaps: stableGraphStrings(gaps),
    resolvedSnapshots: [
      {
        commit: snapshot.commit,
        dirty: snapshot.dirty,
        freshness,
        repositoryId: status.identity.repositoryId,
        repositoryKey,
        snapshotId: snapshot.id,
      },
    ],
    trust: TRUST,
    warnings: stableGraphStrings(warnings).slice(0, 16),
  };
}

function retryContextBriefGraphRead<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  budget: ContextBriefGraphReadBudget,
): Effect.Effect<A, E | ContextBriefGraphBudgetExhausted, R> {
  return Effect.suspend((): Effect.Effect<A, E | ContextBriefGraphBudgetExhausted, R> => {
    if (budget.primaryRemaining <= 0) return Effect.fail(ContextBriefGraphBudgetExhausted.make({}));
    budget.primaryRemaining -= 1;
    return effect.pipe(
      Effect.retry({
        schedule: Schedule.spaced(CONTEXT_BRIEF_GRAPH_READ_RETRY_MILLISECONDS),
        times: CONTEXT_BRIEF_GRAPH_READ_RETRIES,
        while: error => {
          if (!isCodeGraphStoreError(error) || !error.retryable || budget.remaining <= 0) return false;
          budget.remaining -= 1;
          return true;
        },
      }),
    );
  });
}

function stableGraphStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function repositoryContract(
  edge: CodeGraphEdge,
  rank: number,
  repositoryKey: string,
): readonly ContextBriefGraphContractV1[] {
  if (edge.sourceId === undefined || edge.targetId === undefined) return [];
  return [
    {
      authority: edge.provenance === 'heuristic' || edge.provenance === 'model' ? 'supporting' : 'authoritative',
      evidence: {line: edge.evidenceSpan.line, path: edge.evidencePath, repositoryKey},
      id: contractId([
        edge.sourceId,
        edge.relation,
        edge.targetId,
        repositoryKey,
        edge.evidencePath,
        String(edge.evidenceSpan.line),
      ]),
      provenance: edge.provenance,
      rank,
      relation: edge.relation,
      sourceRef: edge.sourceId,
      targetRef: edge.targetId,
    },
  ];
}

function uniqueContracts(contracts: readonly ContextBriefGraphContractV1[]): readonly ContextBriefGraphContractV1[] {
  const byId = new Map<string, ContextBriefGraphContractV1>();
  for (const contract of contracts) {
    const current = byId.get(contract.id);
    if (current === undefined || contract.rank < current.rank) byId.set(contract.id, contract);
  }
  return EffectArray.map(
    [...byId.values()].sort((left, right) => left.rank - right.rank || compareText(left.id, right.id)).slice(0, 64),
    (contract, rank) => ({...contract, rank}),
  );
}

function contractId(parts: readonly string[]): string {
  return `cbct_${Effect2.pipe(sha256HexSync(EffectArray.join(parts, '\u0000')), EffectString.slice(0, 24))}`;
}

function compactText(value: string, maximumBytes: number): string {
  const normalized = Effect2.pipe(value, EffectString.replace(/\s+/gu, ' '), EffectString.trim);
  if (new TextEncoder().encode(normalized).byteLength <= maximumBytes) return normalized;
  let prefix = '';
  for (const character of normalized) {
    if (new TextEncoder().encode(`${prefix}${character}…`).byteLength > maximumBytes) break;
    prefix += character;
  }
  return `${prefix}…`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
