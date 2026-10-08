import {Cause, Clock, Console, DateTime, Effect, Option, Result, Schema} from 'effect';
import {stripFragment} from '@threadnote/platform/string-boundaries';
import {MAX_RECALL_SELECTION_CANDIDATES, type RecallSelectionCandidate} from '@threadnote/recall/selection';
import {uriSegment} from '@threadnote/workspace/manifest';
import type {MemoryRecord, MemoryRelationType} from '@threadnote/memory/document';
import {
  buildRecallSections,
  memoryUriProjectSegment,
  recallIndexPreselectionLimit,
  type ExactMatch,
  type RecallHit,
} from '@threadnote/recall/results';
import {rerankWithSelectedLocalModel} from '@threadnote/inference/models/inference';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {loadRecallFeedback} from './feedback.js';
import {
  currentRecallCorpusGeneration,
  loadRecallIndexData,
  loadRecallIndexDataBatch,
  recallIndexStatus,
  recallUriMatchesScopes,
} from './index.js';
import {recallWorkspaceScopeMatches} from './index/scope.js';
import {RECALL_RECENCY_CANDIDATE_RESERVE} from './index/query.js';
import {recallRankCandidateIsEligible, type RecallEligibilityPolicy} from './eligibility.js';
import {
  deduplicateLogicalRecallCandidates,
  originalQueryRequestsRecency,
  recallCandidateLogicalCorpusKey,
  rankRecallCandidates,
  recallCandidateMatchesWorkspaceBranch,
  type RecallCandidate,
  type RecallRankContext,
} from './rank.js';
import {recallLexicalTerms, recallTokens} from './tokenize.js';
import {normalizeRecallRerankerScore} from './reranker-score.js';
import {
  lexicalIndexUnavailableWarning,
  mergeRecallOperationalWarnings,
  type RecallOperationalWarning,
} from './warning.js';
import {
  ensureVectorIndex,
  rebuildVectorIndex,
  selectedSemanticScores,
  VectorCorpusGenerationChanged,
  VectorIndexCorrupt,
  vectorIndexGenerationReadiness,
  vectorIndexMatchesGeneration,
} from './vector-index.js';
import {
  lexicalRefreshDisposition,
  scheduleMcpRecallBackgroundRefresh,
  type McpRecallBackgroundRefreshSchedule,
} from './mcp/refresh.js';
import {retrieveRecallMemoryConnections, type RecallMemoryConnectionsResult} from './memory/connections.js';

interface RecallRuntimeConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

interface PrepareRecallSectionsInput<R> {
  readonly allowExactRescue: boolean;
  readonly allowSemanticRescue?: boolean;
  readonly allowedUriScopes?: readonly string[];
  readonly candidateUris?: readonly string[];
  readonly exactMatches: readonly ExactMatch[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly feedbackQuery: string;
  readonly includeInactive: boolean;
  readonly limit: number;
  readonly minimumScore?: number;
  readonly memoryRefs?: readonly string[];
  readonly passes: ReadonlyArray<readonly RecallHit[]>;
  readonly preferredUriScopes?: readonly string[];
  readonly project?: string;
  readonly query: string;
  readonly queryVariants?: readonly string[];
  readonly relationTypes?: readonly MemoryRelationType[];
  readonly readRecords: (uris: readonly string[]) => Effect.Effect<readonly MemoryRecord[], unknown, R>;
  readonly rerankerCache?: RecallRerankerCache;
  readonly seedUris?: readonly string[];
  readonly semanticResult?: Option.Option<RecallSemanticScoresResult>;
  readonly semanticGenerationMismatchPolicy?: 'fallback' | 'reload';
  /** Current Git branch for explicit current-branch intent; structural rank context, never topical query text. */
  readonly workspaceBranch?: string;
  /** Structured, repo-relative component scope used for candidate sourcing and ranking, never as topical query text. */
  readonly workspaceScope?: string;
}

const EXPANSION_VOCABULARY_LIMIT = 50;
const EXPANSION_VOCABULARY_INDEX_SAMPLE_LIMIT = 200;
const EXPANSION_VOCABULARY_RANKED_RESERVE = 25;
const EXPANSION_DESCRIPTION_TERM_LIMIT = 6;
const EXPANSION_DESCRIPTION_LENGTH_LIMIT = 80;
const EXPANSION_DESCRIPTION_SEPARATOR = ' :: ';
const MAX_DETERMINISTIC_QUERY_VARIANTS = 3;
const MINIMUM_QUERY_VARIANT_TERMS = 2;
const NATIVE_RERANK_CANDIDATE_LIMIT = 32;
const NATIVE_RERANK_DOCUMENT_LIMIT = 4_000;
const SEMANTIC_GENERATION_RETRY_LIMIT = 2;
const WORKSPACE_CANDIDATE_RESERVE_MAXIMUM = 16;
const WORKSPACE_CANDIDATE_RESERVE_MULTIPLIER = 2;
const CROSS_SCOPE_CANDIDATE_RESERVE_MAXIMUM = 4;
const CROSS_SCOPE_CANDIDATE_SELECTION_MAXIMUM = 16;
export const MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS = 15_000;
export const MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS = 60_000;

export interface RecallCrossScopeLaneBudgets {
  readonly admissionLimit: number;
  readonly crossScopeReserve: number;
  readonly crossSelectionLimit: number;
  readonly protectedReserve: number;
}

/** Shared production/benchmark budgets for the bounded workspace candidate lanes. */
export function recallCrossScopeLaneBudgets(resultLimit: number): RecallCrossScopeLaneBudgets {
  const limit = Math.max(0, Math.floor(resultLimit));
  return {
    admissionLimit: limit === 0 ? 0 : recallIndexPreselectionLimit(limit),
    crossScopeReserve:
      limit === 0 ? 0 : Math.min(CROSS_SCOPE_CANDIDATE_RESERVE_MAXIMUM, Math.max(2, Math.ceil(limit / 2))),
    crossSelectionLimit: limit === 0 ? 0 : Math.min(CROSS_SCOPE_CANDIDATE_SELECTION_MAXIMUM, Math.max(4, limit * 2)),
    protectedReserve:
      limit === 0
        ? 0
        : Math.min(WORKSPACE_CANDIDATE_RESERVE_MAXIMUM, Math.max(1, limit * WORKSPACE_CANDIDATE_RESERVE_MULTIPLIER)),
  };
}

/** Query the dedicated sibling lane unless the broad topical query proved it returned every match. */
export function recallCrossScopeFallbackRequired(queryExhaustive: boolean | undefined): boolean {
  return queryExhaustive !== true;
}

export interface RecallRerankerCache {
  readonly scores: Map<string, number>;
  unavailable: boolean;
}

export function createRecallRerankerCache(): RecallRerankerCache {
  return {scores: new Map(), unavailable: false};
}

export function deterministicRecallQueryVariants(query: string): readonly string[] {
  const clauses = splitRecallQueryClauses(query);
  if (clauses.length < 2 || clauses.some(clause => recallTokens(clause).length < MINIMUM_QUERY_VARIANT_TERMS)) {
    return [];
  }
  return clauses.slice(0, MAX_DETERMINISTIC_QUERY_VARIANTS);
}

function splitRecallQueryClauses(query: string): readonly string[] {
  const clauses: string[] = [];
  for (const segment of query.replaceAll(',', ';').split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const segmentWords = trimmed.split(/\s+/u);
    const leadingWhitespace = segment[0] !== trimmed[0];
    const trailingWhitespace = segment.at(-1) !== trimmed.at(-1);
    let words: string[] = [];
    const flush = (): void => {
      if (words.length > 0) clauses.push(words.join(' '));
      words = [];
    };
    for (const [index, word] of segmentWords.entries()) {
      const normalized = word.toLowerCase();
      const surroundedByWhitespace =
        (index > 0 || leadingWhitespace) && (index < segmentWords.length - 1 || trailingWhitespace);
      if ((normalized === 'and' || normalized === 'or') && surroundedByWhitespace) flush();
      else if (word) words.push(word);
    }
    flush();
  }
  return clauses;
}

function recallQueryVariants(query: string, supplied: readonly string[] | undefined): readonly string[] {
  const seen = new Set([query.trim().toLowerCase()]);
  const variants: string[] = [];
  for (const variant of [...deterministicRecallQueryVariants(query), ...(supplied ?? [])]) {
    const normalized = variant.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    variants.push(normalized);
  }
  return variants;
}

/**
 * Shared Effect orchestration for CLI and MCP recall. The entry points remain
 * responsible for their search passes and rendering, while record hydration,
 * feedback, local-index loading, and hybrid ranking follow one implementation.
 */
export const prepareRecallSections = Effect.fn('recall.prepareSections')(function* <R>(
  config: RecallRuntimeConfig,
  input: PrepareRecallSectionsInput<R>,
) {
  let operationalWarnings: readonly RecallOperationalWarning[] = [];
  let semanticResult =
    input.semanticResult === undefined
      ? yield* loadRecallSemanticScoresResult(
          config,
          input.query,
          input.limit,
          input.eligibility,
          input.allowedUriScopes,
        )
      : Option.getOrElse(input.semanticResult, emptyRecallSemanticScoresResult);
  for (let retry = 0; ; retry += 1) {
    const prepared = yield* prepareRecallSectionsAttempt(config, input, semanticResult);
    operationalWarnings = mergeRecallOperationalWarnings(operationalWarnings, prepared.operationalWarnings);
    if (yield* semanticResultMatchesLexicalSnapshot(config, semanticResult, prepared.generations)) {
      return {...prepared.sections, operationalWarnings, semanticResult};
    }
    if (input.semanticGenerationMismatchPolicy === 'fallback' || retry >= SEMANTIC_GENERATION_RETRY_LIMIT) {
      const lexicalOnly = yield* prepareRecallSectionsAttempt(
        config,
        input,
        emptyRecallSemanticScoresResult(semanticResult.warning),
      );
      return {
        ...lexicalOnly.sections,
        operationalWarnings: mergeRecallOperationalWarnings(operationalWarnings, lexicalOnly.operationalWarnings),
        semanticResult: emptyRecallSemanticScoresResult(semanticResult.warning),
      };
    }
    semanticResult = yield* loadRecallSemanticScoresResult(
      config,
      input.query,
      input.limit,
      input.eligibility,
      input.allowedUriScopes,
    );
  }
});

const prepareRecallSectionsAttempt = Effect.fn('recall.prepareSectionsAttempt')(function* <R>(
  config: RecallRuntimeConfig,
  input: PrepareRecallSectionsInput<R>,
  semanticResult: RecallSemanticScoresResult,
) {
  const memoryConnections: RecallMemoryConnectionsResult | undefined = input.memoryRefs?.length
    ? yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: input.allowedUriScopes?.length
          ? [...input.allowedUriScopes]
          : [`threadnote://user/${uriSegment(config.user)}/memories`],
        eligibility: input.eligibility,
        includeHistorical: input.includeInactive,
        limit: input.limit,
        memoryRefs: input.memoryRefs,
        readRecords: input.readRecords,
        relationTypes: input.relationTypes,
      })
    : undefined;
  const navigationOnly = input.query.trim().length === 0 && memoryConnections !== undefined;
  const semanticScores = Option.getOrUndefined(semanticResult.scores);
  const rankingUris = [
    ...new Set([
      ...input.passes.flatMap(pass => pass.map(hit => hit.uri.replace(/#.*$/, ''))),
      ...input.exactMatches.map(match => match.uri.replace(/#.*$/, '')),
      ...(!navigationOnly ? (semanticScores?.keys() ?? []) : []),
      ...(memoryConnections?.candidates.map(candidate => candidate.uri) ?? []),
    ]),
  ];
  const records = yield* input.readRecords(rankingUris);
  const now = yield* DateTime.nowAsDate;
  const queryVariants = recallQueryVariants(input.query, input.queryVariants);
  const indexQueries = navigationOnly ? [] : [input.query, ...queryVariants];
  const scopeSets: ReadonlyArray<readonly string[] | undefined> = input.allowedUriScopes?.length
    ? [input.allowedUriScopes]
    : input.preferredUriScopes?.length
      ? [input.preferredUriScopes, undefined]
      : [undefined];
  const indexCandidateLimit = recallIndexPreselectionLimit(input.limit);
  const recencyIntent = originalQueryRequestsRecency(input.query);
  const laneBudgets = recallCrossScopeLaneBudgets(input.limit);
  const topicalIndexSelections = indexQueries.flatMap(indexQuery =>
    scopeSets.map(allowedUriScopes => ({
      allowedUriScopes,
      eligibility: input.eligibility,
      limit: indexCandidateLimit,
      query: indexQuery,
      recencyIntent,
      requiredUris: rankingUris,
    })),
  );
  const workspaceScope = navigationOnly ? undefined : input.workspaceScope?.trim();
  const workspaceIndexSelections = workspaceScope
    ? scopeSets.map(allowedUriScopes => ({
        allowedUriScopes,
        eligibility: input.eligibility,
        limit: indexCandidateLimit,
        query: input.query,
        requiredUris: rankingUris,
        workspaceScope,
      }))
    : [];
  const workspaceProject = input.project?.trim() || undefined;
  const workspaceBranch = navigationOnly ? undefined : input.workspaceBranch?.trim();
  const branchIndexSelections = workspaceBranch
    ? scopeSets.map(allowedUriScopes => ({
        allowedUriScopes,
        eligibility: input.eligibility,
        limit: indexCandidateLimit,
        query: `${input.query} ${workspaceBranch}`,
        requiredUris: rankingUris,
      }))
    : [];
  const [feedbackByUri, recallIndexResult] = yield* Effect.all(
    [
      loadRecallFeedback(config.agentContextHome, {
        now,
        project: input.project,
        query: input.feedbackQuery,
      }),
      loadRecallIndexDataBatch(config, {
        includeInactive: input.includeInactive,
        selections: [...topicalIndexSelections, ...workspaceIndexSelections, ...branchIndexSelections],
      }).pipe(Effect.result),
    ],
    {concurrency: 2},
  );
  const recallIndexes = Result.isSuccess(recallIndexResult) ? recallIndexResult.success : [];
  const operationalWarnings = Result.isFailure(recallIndexResult) ? [lexicalIndexUnavailableWarning()] : [];
  const flattenedRecallIndexes = recallIndexes;
  const generations = [
    ...new Set(flattenedRecallIndexes.flatMap(index => (index?.generation ? [index.generation] : []))),
  ];
  const topicalRecallIndexes = flattenedRecallIndexes.slice(0, topicalIndexSelections.length);
  const broadTopicalRecallIndexes = indexQueries.map(
    (_query, index) => topicalRecallIndexes[index * scopeSets.length + Math.max(0, scopeSets.length - 1)],
  );
  const workspaceSelectionEnd = topicalIndexSelections.length + workspaceIndexSelections.length;
  const workspaceRecallIndexes = flattenedRecallIndexes.slice(topicalIndexSelections.length, workspaceSelectionEnd);
  const branchRecallIndexes = flattenedRecallIndexes.slice(workspaceSelectionEnd);
  const recallIndex = topicalRecallIndexes.find(index => index !== undefined);
  const topicalRecallIndexCandidateSets = topicalRecallIndexes.map(index => index?.candidates ?? []);
  const recentRecallIndexCandidateSets = topicalRecallIndexes.map(index => index?.recentCandidates ?? []);
  const workspaceRecallIndexCandidateSets = workspaceRecallIndexes.map(index => index?.candidates ?? []);
  const branchRecallIndexCandidateSets = branchRecallIndexes.map(index => index?.candidates ?? []);
  const recallIndexCandidateSets = [
    ...topicalRecallIndexCandidateSets,
    ...workspaceRecallIndexCandidateSets,
    ...branchRecallIndexCandidateSets,
  ];
  const withSemanticScore = (candidate: RecallCandidate): RecallCandidate => {
    const semantic = semanticScores?.get(candidate.uri.replace(/#.*$/, ''));
    return semantic === undefined ? candidate : {...candidate, semantic};
  };
  const prioritizedWorkspaceCandidates = workspaceScope
    ? prioritizeWorkspaceRecallCandidates(
        input.query,
        mergeRecallIndexCandidates(workspaceRecallIndexCandidateSets).map(withSemanticScore),
        {
          includeInactive: input.includeInactive,
          now,
          project: input.project,
          queryVariants,
          workspaceScope,
        },
      )
    : [];
  const prioritizedBranchCandidates = workspaceBranch
    ? prioritizeBranchRecallCandidates(
        input.query,
        mergeRecallIndexCandidates(branchRecallIndexCandidateSets).map(withSemanticScore),
        {
          includeInactive: input.includeInactive,
          now,
          project: input.project,
          queryVariants,
          workspaceBranch,
        },
      )
    : [];
  const topicalCrossScopeCandidates = workspaceScope
    ? prioritizeCrossScopeRecallCandidates(
        input.query,
        mergeRecallIndexCandidates(topicalRecallIndexCandidateSets).map(withSemanticScore),
        {
          includeInactive: input.includeInactive,
          now,
          project: input.project,
          queryVariants,
          workspaceScope,
        },
      )
    : [];
  const prioritizedRecentCandidates = recencyIntent
    ? rankRecallCandidates(
        input.query,
        mergeRecallIndexCandidates(recentRecallIndexCandidateSets).map(withSemanticScore),
        {
          eligibility: input.eligibility,
          includeInactive: input.includeInactive,
          now,
          project: input.project,
          queryVariants,
          workspaceBranch: input.workspaceBranch,
          workspaceScope,
        },
      ).results.map(result => result.candidate)
    : [];
  const shouldLoadCrossScopeFallback =
    Result.isSuccess(recallIndexResult) &&
    workspaceScope !== undefined &&
    workspaceProject !== undefined &&
    broadTopicalRecallIndexes.some(index => recallCrossScopeFallbackRequired(index?.queryExhaustive));
  const crossScopeFallbackResult = shouldLoadCrossScopeFallback
    ? yield* loadRecallIndexData(config, {
        // An explicit URI restriction is a hard authorization boundary. Soft
        // preferred scopes already received their own topical pass above; the
        // one fallback query searches the authorized global corpus so the
        // preference cannot double the expensive sibling selection.
        allowedUriScopes: input.allowedUriScopes?.length ? input.allowedUriScopes : undefined,
        eligibility: input.eligibility,
        includeInactive: input.includeInactive,
        limit: laneBudgets.crossSelectionLimit,
        project: workspaceProject,
        // Query variants are topical evidence too. Combining them keeps this
        // to one bounded sibling selection while rescuing a relevant memory
        // whose wording is reachable only through an approved rewrite.
        query: indexQueries.join(' '),
        workspaceScope,
        workspaceScopeMode: 'sibling',
      }).pipe(Effect.result)
    : undefined;
  const crossScopeFallbackCandidates =
    workspaceScope && crossScopeFallbackResult && Result.isSuccess(crossScopeFallbackResult)
      ? prioritizeCrossScopeRecallCandidates(input.query, crossScopeFallbackResult.success.candidates, {
          includeInactive: input.includeInactive,
          now,
          project: input.project,
          queryVariants,
          workspaceScope,
        })
      : [];
  const prioritizedCrossScopeCandidates = workspaceScope
    ? prioritizeCrossScopeRecallCandidates(
        input.query,
        mergeRecallIndexCandidates([topicalCrossScopeCandidates, crossScopeFallbackCandidates]),
        {
          includeInactive: input.includeInactive,
          now,
          project: input.project,
          queryVariants,
          workspaceScope,
        },
      )
    : [];
  if (crossScopeFallbackResult && Result.isFailure(crossScopeFallbackResult)) {
    operationalWarnings.push(lexicalIndexUnavailableWarning());
  }
  if (
    crossScopeFallbackResult &&
    Result.isSuccess(crossScopeFallbackResult) &&
    crossScopeFallbackResult.success.generation &&
    !generations.includes(crossScopeFallbackResult.success.generation)
  ) {
    generations.push(crossScopeFallbackResult.success.generation);
  }
  const semanticCandidates = mergeRecallCandidateLanes(
    [mergeRecallIndexCandidates(topicalRecallIndexCandidateSets).map(withSemanticScore)],
    [memoryConnections?.candidates ?? [], prioritizedBranchCandidates, prioritizedWorkspaceCandidates],
    [prioritizedCrossScopeCandidates],
    {
      admissionLimit: indexCandidateLimit,
      crossScopeReserve: laneBudgets.crossScopeReserve,
      protectedReserve: Math.max(laneBudgets.protectedReserve, memoryConnections?.candidates.length ?? 0),
      recencyCandidateSets: [prioritizedRecentCandidates],
      recencyReserve: RECALL_RECENCY_CANDIDATE_RESERVE,
    },
  );
  const indexedCandidates = navigationOnly
    ? semanticCandidates
    : yield* applySelectedNativeReranker(
        config.agentContextHome,
        input.query,
        semanticCandidates,
        input.rerankerCache,
      ).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            if (input.rerankerCache) input.rerankerCache.unavailable = true;
            return applyCachedRerankerScores(semanticCandidates, input.rerankerCache);
          }),
        ),
      );
  const unreadIndexedMemoryUris = unreadIndexedMemoryRecordUris(indexedCandidates, records);
  const extraRecords = unreadIndexedMemoryUris.length > 0 ? yield* input.readRecords(unreadIndexedMemoryUris) : [];
  const extraRecordUris = new Set(extraRecords.map(record => record.uri.replace(/#.*$/, '')));
  const absentMemoryUris = unreadIndexedMemoryUris.filter(uri => !extraRecordUris.has(uri.replace(/#.*$/, '')));
  const liveRecords = extraRecords.length > 0 ? [...records, ...extraRecords] : records;
  const expansionCandidates = mergeRecallExpansionCandidates(
    recallIndexCandidateSets,
    rankingUris,
    topicalRecallIndexCandidateSets.length,
  ).filter(candidate => recallRuntimeCandidateIsEligible(candidate, input.eligibility));
  const sections = buildRecallSections(input.passes, input.exactMatches, input.limit, {
    absentMemoryUris,
    allowExactRescue: input.allowExactRescue,
    allowSemanticRescue: input.allowSemanticRescue,
    allowedUriScopes: input.allowedUriScopes,
    candidateUris: input.candidateUris,
    corpusStatistics: workspaceScope ? undefined : recallIndex?.corpusStatistics,
    eligibility: input.eligibility,
    feedbackByUri,
    includeInactive: input.includeInactive,
    indexedCandidates,
    minimumScore: input.minimumScore,
    now,
    project: input.project,
    query: input.query,
    queryVariants,
    records: liveRecords,
    protectedUris: memoryConnections?.candidates.map(candidate => candidate.uri),
    seedUris: input.seedUris,
    workspaceBranch: input.workspaceBranch,
    workspaceScope,
  });
  return {
    generations,
    operationalWarnings,
    sections: {...sections, expansionCandidates, ...(memoryConnections ? {memoryConnections} : {})},
  };
});

export interface RecallSemanticScoresResult {
  readonly corpusGeneration: Option.Option<string>;
  readonly scores: Option.Option<ReadonlyMap<string, number>>;
  readonly warning: Option.Option<string>;
}

export type BoundedRecallSemanticRetrieval<A> =
  | {readonly status: 'completed'; readonly value: A}
  | {readonly cause: Cause.Cause<unknown>; readonly status: 'failed'}
  | {readonly status: 'timed-out'};

export type GatedRecallSemanticRetrieval<A> = BoundedRecallSemanticRetrieval<A> | {readonly status: 'cooldown'};

export interface McpRecallSemanticScoresResult {
  readonly result: RecallSemanticScoresResult;
  readonly status: 'available' | 'failed' | 'timed-out' | 'unavailable';
}

type McpReadOnlySemanticScoresAttempt =
  | {
      readonly corpusGeneration: string;
      readonly scores: ReadonlyMap<string, number> | undefined;
      readonly state: 'available';
    }
  | {readonly manifest: LocalModelManifest; readonly state: 'refreshable'}
  | {readonly state: 'structurally-unavailable'}
  | {readonly state: 'unavailable'};

export function emptyRecallSemanticScoresResult(
  warning: Option.Option<string> = Option.none(),
): RecallSemanticScoresResult {
  return {
    corpusGeneration: Option.none(),
    scores: Option.none(),
    warning,
  };
}

export function boundedRecallSemanticRetrieval<A, E, R>(
  retrieval: Effect.Effect<A, E, R>,
): Effect.Effect<BoundedRecallSemanticRetrieval<A>, never, R> {
  return retrieval.pipe(
    Effect.map(value => ({status: 'completed' as const, value})),
    Effect.catchCauseIf(
      cause => !Cause.hasInterrupts(cause),
      cause => Effect.succeed({cause: cause, status: 'failed' as const}),
    ),
    Effect.catchCause(cause => Effect.failCause(cause as Cause.Cause<never>)),
    Effect.timeoutOrElse({
      duration: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS,
      orElse: () => Effect.succeed({status: 'timed-out' as const}),
    }),
  );
}

export function createMcpRecallSemanticRetrievalGate() {
  const retryAfterByRuntime = new WeakMap<object, {readonly deadline: bigint}>();
  const cooldownNanos = BigInt(MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS) * 1_000_000n;
  return <A, E, R>(
    runtime: object,
    retrieval: Effect.Effect<A, E, R>,
  ): Effect.Effect<GatedRecallSemanticRetrieval<A>, never, R> =>
    Effect.gen(function* () {
      const now = yield* Clock.monotonicTimeNanos;
      const previousCooldown = retryAfterByRuntime.get(runtime);
      if (previousCooldown && previousCooldown.deadline > now) return {status: 'cooldown'} as const;
      const result = yield* boundedRecallSemanticRetrieval(retrieval);
      if (result.status === 'timed-out') {
        retryAfterByRuntime.set(runtime, {deadline: (yield* Clock.monotonicTimeNanos) + cooldownNanos});
      } else if (retryAfterByRuntime.get(runtime) === previousCooldown) {
        retryAfterByRuntime.delete(runtime);
      }
      return result;
    });
}

const mcpRecallSemanticRetrievalGate = createMcpRecallSemanticRetrievalGate();

/**
 * MCP recall uses only the already-active lexical/vector generations. It never
 * builds, repairs, or retries derived storage while a client request is open.
 */
export const loadMcpRecallSemanticScoresResult = Effect.fn('recall.loadMcpSemanticScoresResult')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  const semanticLimit = recallIndexPreselectionLimit(limit);
  const runtime = yield* LocalModelRuntime;
  const attempt = yield* mcpRecallSemanticRetrievalGate(
    runtime,
    loadReadOnlySemanticScoresAttempt(config, query, semanticLimit, eligibility, allowedUriScopes),
  );
  if (attempt.status === 'cooldown') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallCooldownWarning())),
      status: 'unavailable',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.status === 'timed-out') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallTimeoutWarning())),
      status: 'timed-out',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.status === 'failed') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallFailureWarning(attempt.cause))),
      status: 'failed',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.value.state === 'refreshable') {
    const schedule = yield* scheduleMcpRecallBackgroundRefresh(config, attempt.value.manifest);
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallRefreshingWarning(schedule))),
      status: 'unavailable',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.value.state === 'structurally-unavailable') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallStructuralWarning())),
      status: 'failed',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.value.state === 'unavailable' || attempt.value.scores === undefined) {
    return {result: emptyRecallSemanticScoresResult(), status: 'unavailable'} satisfies McpRecallSemanticScoresResult;
  }
  return {
    result: {
      corpusGeneration: Option.some(attempt.value.corpusGeneration),
      scores: Option.fromNullishOr(attempt.value.scores),
      warning: Option.none(),
    },
    status: 'available',
  } satisfies McpRecallSemanticScoresResult;
});

const loadReadOnlySemanticScoresAttempt = Effect.fn('recall.loadReadOnlySemanticScoresAttempt')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = selection.roles.embedding;
  if (!modelId) return {state: 'unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== 'embedding') return {state: 'unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
  const store = yield* LocalModelStore;
  const installed = yield* store.status(config.agentContextHome, manifest);
  if (!installed.installed) return {state: 'unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
  const lexicalStatus = yield* recallIndexStatus(config, false);
  const lexicalDisposition = lexicalRefreshDisposition(lexicalStatus);
  if (lexicalDisposition === 'refreshable') {
    return {manifest, state: 'refreshable'} satisfies McpReadOnlySemanticScoresAttempt;
  }
  if (lexicalDisposition === 'unsafe' || !lexicalStatus.generation) {
    return {state: 'structurally-unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
  }
  const corpusGeneration = lexicalStatus.generation;
  const vectorReadiness = yield* vectorIndexGenerationReadiness(config.agentContextHome, manifest, corpusGeneration);
  if (vectorReadiness === 'corrupt') {
    return {state: 'structurally-unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
  }
  if (vectorReadiness === 'missing' || vectorReadiness === 'stale') {
    return {manifest, state: 'refreshable'} satisfies McpReadOnlySemanticScoresAttempt;
  }
  const scores = yield* selectedSemanticScores(config, query, {
    corpusGeneration,
    currentCorpusGeneration: () => currentRecallCorpusGeneration(config),
    allowedUriScopes,
    eligibility,
    limit,
  });
  return {corpusGeneration, scores, state: 'available'} satisfies McpReadOnlySemanticScoresAttempt;
});

const semanticResultMatchesLexicalSnapshot = Effect.fn('recall.semanticResultMatchesLexicalSnapshot')(function* (
  config: RecallRuntimeConfig,
  semanticResult: RecallSemanticScoresResult,
  snapshotGenerations: readonly string[],
) {
  if (Option.isNone(semanticResult.scores)) return true;
  if (Option.isNone(semanticResult.corpusGeneration)) return false;
  const semanticGeneration = semanticResult.corpusGeneration.value;
  if (snapshotGenerations.length !== 1 || snapshotGenerations[0] !== semanticGeneration) {
    return false;
  }
  const currentGeneration = yield* currentRecallCorpusGeneration(config);
  return Option.isSome(currentGeneration) && currentGeneration.value === semanticGeneration;
});

export const loadRecallSemanticScoresResult = Effect.fn('recall.loadSemanticScoresResult')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  return yield* Effect.gen(function* () {
    const selection = yield* readModelSelection(config.agentContextHome);
    const modelId = selection.roles.embedding;
    if (!modelId) return undefined;
    const catalog = yield* LocalModelCatalog;
    const manifest = yield* catalog.get(modelId);
    if (manifest.role !== 'embedding') return undefined;
    const store = yield* LocalModelStore;
    const installed = yield* store.status(config.agentContextHome, manifest);
    if (!installed.installed) return undefined;
    const semanticLimit = recallIndexPreselectionLimit(limit);
    return yield* loadCurrentSemanticScores(config, manifest, query, semanticLimit, eligibility, allowedUriScopes);
  }).pipe(
    Effect.map(snapshot =>
      snapshot === undefined
        ? emptyRecallSemanticScoresResult()
        : ({
            corpusGeneration: Option.some(snapshot.corpusGeneration),
            scores: Option.fromNullishOr(snapshot.scores),
            warning: Option.none(),
          } satisfies RecallSemanticScoresResult),
    ),
    Effect.catchCauseIf(
      cause => !Cause.hasInterruptsOnly(cause),
      cause => Effect.succeed(emptyRecallSemanticScoresResult(Option.some(semanticRecallFailureWarning(cause)))),
    ),
  );
});

const loadCurrentSemanticScores = Effect.fn('recall.loadCurrentSemanticScores')(function* (
  config: RecallRuntimeConfig,
  manifest: LocalModelManifest,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  for (let retry = 0; retry <= SEMANTIC_GENERATION_RETRY_LIMIT; retry += 1) {
    const attempt = yield* loadSemanticScoresAttempt(
      config,
      manifest,
      query,
      limit,
      eligibility,
      allowedUriScopes,
    ).pipe(Effect.result);
    if (Result.isSuccess(attempt)) return attempt.success;
    if (Schema.is(VectorCorpusGenerationChanged)(attempt.failure) && retry < SEMANTIC_GENERATION_RETRY_LIMIT) {
      continue;
    }
    return yield* Effect.fail(attempt.failure);
  }
  return yield* Effect.die(new Error('Semantic generation retry loop exhausted without a result.'));
});

const loadSemanticScoresAttempt = Effect.fn('recall.loadSemanticScoresAttempt')(function* (
  config: RecallRuntimeConfig,
  manifest: LocalModelManifest,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  const fence = () => currentRecallCorpusGeneration(config);
  const snapshot = yield* loadRecallIndexData(config, {
    includeInactive: false,
    limit: 0,
    query: '',
  });
  let corpusGeneration = snapshot.generation;
  if (!(yield* vectorIndexMatchesGeneration(config.agentContextHome, manifest, corpusGeneration))) {
    const index = yield* loadRecallIndexData(config, {includeInactive: false});
    corpusGeneration = index.generation;
    yield* ensureVectorIndex(config, manifest, index.candidates, {
      corpusGeneration,
      currentCorpusGeneration: fence,
    });
  }
  return yield* selectedSemanticScores(config, query, {
    allowedUriScopes,
    corpusGeneration,
    currentCorpusGeneration: fence,
    eligibility,
    limit,
  }).pipe(
    Effect.map(scores => ({corpusGeneration, scores})),
    Effect.catchIf(
      (error): error is VectorIndexCorrupt => Schema.is(VectorIndexCorrupt)(error),
      () =>
        Effect.gen(function* () {
          const index = yield* loadRecallIndexData(config, {includeInactive: false});
          yield* rebuildVectorIndex(config, manifest, index.candidates, {
            corpusGeneration: index.generation,
            currentCorpusGeneration: fence,
          });
          const scores = yield* selectedSemanticScores(config, query, {
            allowedUriScopes,
            corpusGeneration: index.generation,
            currentCorpusGeneration: fence,
            eligibility,
            limit,
          });
          return {corpusGeneration: index.generation, scores};
        }),
    ),
  );
});

export const loadRecallSemanticScores = Effect.fn('recall.loadSemanticScores')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  const result = yield* loadRecallSemanticScoresResult(config, query, limit, eligibility, allowedUriScopes);
  if (Option.isSome(result.warning)) yield* Console.warn(result.warning.value);
  return Option.getOrUndefined(result.scores);
});

function semanticRecallFailureWarning(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const failureType =
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'EmbeddingFailed' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('isolated worker retry was exhausted')
      ? 'LocalModelWorkerRetryExhausted'
      : semanticRecallFailureType(error);
  return (
    `Local AI recall warning: semantic retrieval failed (${failureType}); deterministic lexical recall continued. ` +
    'Run threadnote doctor --dry-run if this repeats.'
  );
}

function semanticRecallTimeoutWarning(): string {
  return (
    `Local AI recall warning: semantic retrieval timed out after ${MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS}ms; ` +
    'deterministic lexical recall continued. Run threadnote doctor --dry-run if this repeats.'
  );
}

function semanticRecallCooldownWarning(): string {
  return (
    'Local AI recall warning: semantic retrieval was skipped after a recent timeout; ' +
    `deterministic lexical recall continued. Retry after ${MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS / 1_000}s ` +
    'or run threadnote doctor --dry-run if this repeats.'
  );
}

function semanticRecallRefreshingWarning(schedule: McpRecallBackgroundRefreshSchedule): string {
  const activity =
    schedule === 'scheduled'
      ? 'A single background refresh was scheduled'
      : 'A single background refresh is already running';
  return (
    `Local AI recall warning: semantic indexes are stale or missing. ${activity}; ` +
    'lexical recall continued without waiting.'
  );
}

function semanticRecallStructuralWarning(): string {
  return (
    'Local AI recall warning: semantic index storage failed read-only validation. Lexical recall continued; ' +
    'no automatic repair ran. Run threadnote doctor --dry-run.'
  );
}

function semanticRecallFailureType(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('_tag' in error) || typeof error._tag !== 'string') {
    return 'SemanticRecallUnavailable';
  }
  return [
    'EmbeddingFailed',
    'InferenceInterrupted',
    'InsufficientMemory',
    'ModelLoadFailed',
    'ModelNotInstalled',
    'NativeRuntimeUnavailable',
    'UnsupportedNativeRuntime',
    'VectorIndexCorrupt',
  ].includes(error._tag)
    ? error._tag
    : 'SemanticRecallUnavailable';
}

const applySelectedNativeReranker = Effect.fn('recall.applySelectedNativeReranker')(function* (
  home: string,
  query: string,
  candidates: readonly RecallCandidate[],
  cache?: RecallRerankerCache,
) {
  const shortlist = candidates.slice(0, NATIVE_RERANK_CANDIDATE_LIMIT);
  if (shortlist.length === 0) return candidates;
  const missing = shortlist.filter(candidate => !cache?.scores.has(rerankerCacheKey(candidate)));
  if (missing.length === 0 || cache?.unavailable === true) {
    return applyCachedRerankerScores(candidates, cache);
  }
  const scores = yield* rerankWithSelectedLocalModel(
    home,
    query,
    missing.map(candidate => candidate.text.slice(0, NATIVE_RERANK_DOCUMENT_LIMIT)),
  );
  if (!scores) {
    if (cache) cache.unavailable = true;
    return applyCachedRerankerScores(candidates, cache);
  }
  const scoresByKey = cache?.scores ?? new Map<string, number>();
  for (const [index, candidate] of missing.entries()) {
    scoresByKey.set(rerankerCacheKey(candidate), normalizeRecallRerankerScore(scores[index] ?? 0));
  }
  return applyCachedRerankerScores(candidates, {scores: scoresByKey, unavailable: false});
});

function applyCachedRerankerScores(
  candidates: readonly RecallCandidate[],
  cache: RecallRerankerCache | undefined,
): readonly RecallCandidate[] {
  if (!cache || cache.scores.size === 0) return candidates;
  return candidates.map(candidate => {
    const reranker = cache.scores.get(rerankerCacheKey(candidate));
    return reranker === undefined ? candidate : {...candidate, reranker};
  });
}

function rerankerCacheKey(candidate: RecallCandidate): string {
  return `${candidate.uri}\u0000${candidate.text}`;
}

function unreadIndexedMemoryRecordUris(
  indexedCandidates: readonly RecallCandidate[],
  records: readonly MemoryRecord[],
): readonly string[] {
  const live = new Set(records.map(record => record.uri.replace(/#.*$/, '')));
  const unread = new Set<string>();
  for (const candidate of indexedCandidates) {
    for (const uri of [candidate.uri, ...(candidate.equivalentUris ?? [])]) {
      const documentUri = uri.replace(/#.*$/, '');
      if (documentUri.includes('/memories/') && !live.has(documentUri)) {
        unread.add(documentUri);
      }
    }
  }
  return [...unread];
}

export function buildRecallSelectionCandidates(
  ranked: readonly RecallHit[],
  indexedCandidates: readonly RecallCandidate[],
  limit: number,
): readonly RecallSelectionCandidate[] {
  const indexedByUri = new Map(indexedCandidates.map(candidate => [stripFragment(candidate.uri), candidate]));
  return ranked.slice(0, Math.min(limit, MAX_RECALL_SELECTION_CANDIDATES)).map((hit, index) => {
    const uri = stripFragment(hit.uri);
    const indexed = indexedByUri.get(uri);
    const uriTopic = uri.slice(uri.lastIndexOf('/') + 1).replace(/\.[a-z0-9]+$/i, '');
    const project =
      indexed?.fields?.project ??
      memoryUriProjectSegment(uri) ??
      /^threadnote:\/\/resources\/repos\/([^/]+)/.exec(uri)?.[1];
    const fields = [
      `category=${hit.category}`,
      project ? `project=${project}` : undefined,
      `topic=${indexed?.fields?.topic ?? uriTopic}`,
      indexed?.fields?.workspaceScope ? `workspace_scope=${indexed.fields.workspaceScope}` : undefined,
      indexed?.fields?.title ? `title=${indexed.fields.title}` : undefined,
      indexed?.fields?.keywords?.length ? `keywords=${indexed.fields.keywords.join(', ')}` : undefined,
    ].filter((field): field is string => field !== undefined);
    const excerpt = recallSelectionExcerpt(indexed?.text || hit.snippet || '');
    return {
      id: `c${index + 1}`,
      summary: [...fields, excerpt ? `excerpt=${excerpt}` : undefined]
        .filter((part): part is string => part !== undefined)
        .join(' | '),
      uri,
    };
  });
}

export function buildRecallIndexSelectionCandidates(
  indexedCandidates: readonly RecallCandidate[],
  project: string | undefined,
  limit: number,
): readonly RecallSelectionCandidate[] {
  const normalizedProject = project?.trim().toLowerCase();
  const candidates = normalizedProject
    ? indexedCandidates.filter(candidate => candidate.fields?.project?.trim().toLowerCase() === normalizedProject)
    : indexedCandidates;
  return candidates.slice(0, Math.min(limit, MAX_RECALL_SELECTION_CANDIDATES)).map((candidate, index) => {
    const uri = candidate.uri.replace(/#.*$/, '');
    const uriTopic = uri.slice(uri.lastIndexOf('/') + 1).replace(/\.[a-z0-9]+$/i, '');
    const fields = [
      candidate.kind ? `kind=${candidate.kind}` : 'category=resource',
      candidate.fields?.project ? `project=${candidate.fields.project}` : undefined,
      `topic=${candidate.fields?.topic ?? uriTopic}`,
      candidate.fields?.workspaceScope ? `workspace_scope=${candidate.fields.workspaceScope}` : undefined,
      candidate.fields?.title ? `title=${candidate.fields.title}` : undefined,
      candidate.fields?.keywords?.length ? `keywords=${candidate.fields.keywords.join(', ')}` : undefined,
    ].filter((field): field is string => field !== undefined);
    const excerpt = recallSelectionExcerpt(candidate.text);
    return {
      id: `c${index + 1}`,
      summary: [...fields, excerpt ? `excerpt=${excerpt}` : undefined]
        .filter((part): part is string => part !== undefined)
        .join(' | '),
      uri,
    };
  });
}

export function recallSelectionQueries(
  candidates: readonly RecallSelectionCandidate[],
  indexedCandidates: readonly RecallCandidate[],
  selectedIds: readonly string[],
  originalQuery: string,
  limit: number,
): readonly string[] {
  const selectedUris = new Set(
    candidates.filter(candidate => selectedIds.includes(candidate.id)).map(candidate => candidate.uri),
  );
  const queryTerms = new Map(
    recallTokens(originalQuery).flatMap(term => {
      const weight = /^\p{Lu}[\p{Lu}\p{N}_.-]{2,}$/u.test(term) ? 4 : 1;
      return recallLexicalTerms(term).map(normalized => [normalized, weight] as const);
    }),
  );
  const selectedCandidates = indexedCandidates
    .map((candidate, index) => {
      const fieldTerms = new Set(
        recallLexicalTerms(
          [candidate.fields?.topic, candidate.fields?.title, ...(candidate.fields?.keywords ?? [])]
            .filter((value): value is string => value !== undefined)
            .join(' '),
        ),
      );
      const bodyTerms = new Set(recallLexicalTerms(candidate.text));
      return {
        candidate,
        index,
        overlap: [...queryTerms].reduce(
          (score, [term, weight]) =>
            score + (fieldTerms.has(term) ? weight * 2 : 0) + (bodyTerms.has(term) ? weight : 0),
          0,
        ),
      };
    })
    .filter(({candidate}) => selectedUris.has(candidate.uri.replace(/#.*$/, '')))
    .sort((left, right) => right.overlap - left.overlap || left.index - right.index);
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const {candidate} of selectedCandidates) {
    const query = candidate.fields?.topic?.trim() || candidate.fields?.title?.trim();
    const key = query?.toLowerCase();
    if (!query || !key || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length === limit) break;
  }
  return queries;
}

function recallSelectionExcerpt(value: string): string {
  const terms: string[] = [];
  let previous = '';
  for (const term of value.replace(/\s+/g, ' ').trim().split(' ')) {
    const key = term.toLowerCase();
    if (!term || key === previous) continue;
    terms.push(term);
    previous = key;
  }
  return terms.join(' ').slice(0, 240).trim();
}

export function recallSelectionAnchorIds(
  candidates: readonly RecallSelectionCandidate[],
  ranked: readonly RecallHit[],
): readonly string[] {
  const idByUri = new Map(candidates.map(candidate => [candidate.uri, candidate.id]));
  return ranked
    .slice(0, 2)
    .filter(hit => !hit.rankWarnings?.some(warning => warning.includes('lexical-only')))
    .map(hit => idByUri.get(hit.uri.replace(/#.*$/, '')))
    .filter((id): id is string => id !== undefined);
}

export function selectedRecallCandidateUris(
  candidates: readonly RecallSelectionCandidate[],
  selectedIds: readonly string[],
  anchorIds: readonly string[] = [],
): readonly string[] {
  const selected = new Set([...anchorIds, ...selectedIds]);
  return candidates
    .filter(candidate => selected.has(candidate.id))
    .slice(0, 8)
    .map(candidate => candidate.uri);
}

export const loadRecallExpansionVocabulary = Effect.fn('recall.loadExpansionVocabulary')(function* (
  config: RecallRuntimeConfig,
  input: {
    readonly allowedUriScopes?: readonly string[];
    readonly eligibility?: RecallEligibilityPolicy;
    readonly includeInactive: boolean;
    readonly project?: string;
    readonly rankedCandidates?: readonly RecallCandidate[];
  },
) {
  if (!input.project) return [];
  const rankedCandidates = (input.rankedCandidates ?? []).filter(
    candidate =>
      recallUriMatchesScopes(candidate.uri, input.allowedUriScopes) &&
      recallRuntimeCandidateIsEligible(candidate, input.eligibility),
  );
  const rankedVocabulary = recallExpansionVocabulary(rankedCandidates, input.project);
  if (rankedVocabulary.length >= EXPANSION_VOCABULARY_LIMIT) {
    return rankedVocabulary;
  }
  const index = yield* loadRecallIndexData(config, {
    allowedUriScopes: input.allowedUriScopes,
    eligibility: input.eligibility,
    includeInactive: input.includeInactive,
    limit: EXPANSION_VOCABULARY_INDEX_SAMPLE_LIMIT,
    project: input.project,
  });
  return recallExpansionVocabulary(mergeRecallIndexCandidates([rankedCandidates, index.candidates]), input.project);
});

export function mergeRecallIndexCandidates(
  candidateSets: readonly (readonly RecallCandidate[])[],
): readonly RecallCandidate[] {
  const mergedByUri = new Map<string, RecallCandidate>();
  const maximumLength = Math.max(0, ...candidateSets.map(candidates => candidates.length));
  for (let index = 0; index < maximumLength; index += 1) {
    for (const candidates of candidateSets) {
      const candidate = candidates[index];
      if (!candidate) continue;
      const retained = mergedByUri.get(candidate.uri);
      if (!retained) mergedByUri.set(candidate.uri, candidate);
      else if (candidate.identityConflict && !retained.identityConflict) {
        mergedByUri.set(candidate.uri, {...retained, identityConflict: true});
      }
    }
  }
  return deduplicateLogicalRecallCandidates([...mergedByUri.values()]);
}

function recallRuntimeCandidateIsEligible(
  candidate: RecallCandidate,
  eligibility: RecallEligibilityPolicy | undefined,
): boolean {
  return eligibility === undefined || recallRankCandidateIsEligible(eligibility, candidate);
}

/**
 * Preserve a topical head while reserving a small admission lane for the
 * structured workspace source. Supplemental duplicates are promoted into that
 * lane so a current-package match cannot remain hidden beyond the ranker's
 * bounded window; the remaining candidates retain deterministic source order.
 */
export function mergePrioritizedRecallIndexCandidates(
  topicalCandidateSets: readonly (readonly RecallCandidate[])[],
  supplementalCandidateSets: readonly (readonly RecallCandidate[])[],
  options: {readonly admissionLimit?: number; readonly supplementalReserve?: number} = {},
): readonly RecallCandidate[] {
  const topical = mergeRecallIndexCandidates(topicalCandidateSets);
  const supplemental = mergeRecallIndexCandidates(supplementalCandidateSets);
  const admissionLimit = Math.max(0, Math.floor(options.admissionLimit ?? 0));
  const requestedReserve = Math.max(0, Math.floor(options.supplementalReserve ?? 0));
  if (admissionLimit === 0 || requestedReserve === 0 || supplemental.length === 0) {
    return deduplicateLogicalRecallCandidates(uniqueRecallCandidatesByUri([...topical, ...supplemental]));
  }

  const reserve = Math.min(requestedReserve, supplemental.length, admissionLimit);
  const supplementalHead = supplemental.slice(0, reserve);
  const supplementalHeadUris = new Set(supplementalHead.map(candidate => candidate.uri));
  const topicalWithoutReserved = topical.filter(candidate => !supplementalHeadUris.has(candidate.uri));
  const topicalHeadLength = Math.max(0, admissionLimit - supplementalHead.length);
  return deduplicateLogicalRecallCandidates(
    uniqueRecallCandidatesByUri([
      ...topicalWithoutReserved.slice(0, topicalHeadLength),
      ...supplementalHead,
      ...topicalWithoutReserved.slice(topicalHeadLength),
      ...supplemental.slice(reserve),
    ]),
  );
}

/**
 * Admit protected workspace/branch candidates and outside-hierarchy
 * challengers through independent bounded reserves. A busy protected lane can
 * therefore never consume the challenger's tiny admission budget.
 */
export function mergeRecallCandidateLanes(
  topicalCandidateSets: readonly (readonly RecallCandidate[])[],
  protectedCandidateSets: readonly (readonly RecallCandidate[])[],
  crossScopeCandidateSets: readonly (readonly RecallCandidate[])[],
  options: {
    readonly admissionLimit: number;
    readonly crossScopeReserve: number;
    readonly protectedReserve: number;
    readonly recencyCandidateSets?: readonly (readonly RecallCandidate[])[];
    readonly recencyReserve?: number;
  },
): readonly RecallCandidate[] {
  const topical = mergeRecallIndexCandidates(topicalCandidateSets);
  const protectedCandidates = mergeRecallIndexCandidates(protectedCandidateSets);
  const crossScopeCandidates = mergeRecallIndexCandidates(crossScopeCandidateSets);
  const recentCandidates = mergeRecallIndexCandidates(options.recencyCandidateSets ?? []);
  const admissionLimit = Math.max(0, Math.floor(options.admissionLimit));
  if (admissionLimit === 0) {
    return deduplicateLogicalRecallCandidates(
      uniqueRecallCandidatesByUri([...topical, ...recentCandidates, ...protectedCandidates, ...crossScopeCandidates]),
    );
  }
  const reservedKeys = new Set<string>();
  const recentHead = selectRecallLaneHead(
    recentCandidates,
    Math.min(Math.max(0, Math.floor(options.recencyReserve ?? 0)), admissionLimit),
    reservedKeys,
  );
  const protectedHead = selectRecallLaneHead(
    protectedCandidates,
    Math.min(Math.max(0, Math.floor(options.protectedReserve)), admissionLimit - recentHead.length),
    reservedKeys,
  );
  const crossHead = selectRecallLaneHead(
    crossScopeCandidates,
    Math.min(
      Math.max(0, Math.floor(options.crossScopeReserve)),
      admissionLimit - recentHead.length - protectedHead.length,
    ),
    reservedKeys,
  );
  const reserved = [...recentHead, ...protectedHead, ...crossHead];
  const topicalWithoutReserved = topical.filter(candidate => !reservedKeys.has(recallCandidateAdmissionKey(candidate)));
  const topicalHeadLength = Math.max(0, admissionLimit - reserved.length);
  return deduplicateLogicalRecallCandidates(
    uniqueRecallCandidatesByUri([
      ...topicalWithoutReserved.slice(0, topicalHeadLength),
      ...reserved,
      ...topicalWithoutReserved.slice(topicalHeadLength),
      ...protectedCandidates.slice(protectedHead.length),
      ...crossScopeCandidates.slice(crossHead.length),
      ...recentCandidates.slice(recentHead.length),
    ]),
  );
}

/**
 * Restrict the supplemental lane to repo-wide memories and the current
 * component hierarchy, then use the untouched topical query to order that
 * bounded pool before admission.
 * Scope affects sourcing and tie-breaking only; the ranker's topical gate and
 * scoped corpus statistics remain free of workspace path terms.
 */
export function prioritizeWorkspaceRecallCandidates(
  query: string,
  candidates: readonly RecallCandidate[],
  context: Pick<RecallRankContext, 'includeInactive' | 'now' | 'project' | 'queryVariants'> & {
    readonly workspaceScope: string;
  },
): readonly RecallCandidate[] {
  const scopedCandidates = candidates.filter(candidate =>
    workspaceScopeContains(context.workspaceScope, candidate.fields?.workspaceScope),
  );
  return rankRecallCandidates(query, scopedCandidates, context).results.map(result => result.candidate);
}

/**
 * Keep only memories outside the current component hierarchy and require them
 * to pass the normal topical relevance gate before they can use the challenger
 * reserve. Workspace path text and the scope relationship are deliberately not
 * ranking inputs for this lane.
 */
export function prioritizeCrossScopeRecallCandidates(
  query: string,
  candidates: readonly RecallCandidate[],
  context: Pick<RecallRankContext, 'includeInactive' | 'now' | 'project' | 'queryVariants'> & {
    readonly workspaceScope: string;
  },
): readonly RecallCandidate[] {
  const project = context.project?.trim().toLowerCase();
  const crossScopeCandidates = candidates.filter(
    candidate =>
      recallWorkspaceScopeMatches(context.workspaceScope, candidate.fields?.workspaceScope, 'sibling') &&
      (!project || candidate.fields?.project?.trim().toLowerCase() === project),
  );
  return rankRecallCandidates(query, crossScopeCandidates, {
    includeInactive: context.includeInactive,
    now: context.now,
    project: context.project,
    queryVariants: context.queryVariants,
  }).results.map(result => result.candidate);
}

export function prioritizeBranchRecallCandidates(
  query: string,
  candidates: readonly RecallCandidate[],
  context: Pick<RecallRankContext, 'includeInactive' | 'now' | 'project' | 'queryVariants'> & {
    readonly workspaceBranch: string;
  },
): readonly RecallCandidate[] {
  const branchCandidates = candidates.filter(candidate =>
    recallCandidateMatchesWorkspaceBranch(context.workspaceBranch, candidate),
  );
  return rankRecallCandidates(query, branchCandidates, context).results.map(result => result.candidate);
}

function workspaceScopeContains(currentScope: string, candidateScope: string | undefined): boolean {
  const current = normalizeWorkspaceScope(currentScope);
  if (current !== undefined && candidateScope === undefined) return true;
  const candidate = normalizeWorkspaceScope(candidateScope);
  return (
    current !== undefined && candidate !== undefined && (candidate === current || current.startsWith(`${candidate}/`))
  );
}

function normalizeWorkspaceScope(scope: string | undefined): string | undefined {
  const normalized = scope
    ?.trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.')
    .join('/')
    .toLowerCase();
  return normalized || undefined;
}

function selectRecallLaneHead(
  candidates: readonly RecallCandidate[],
  limit: number,
  selectedKeys: Set<string>,
): readonly RecallCandidate[] {
  const selected: RecallCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const key = recallCandidateAdmissionKey(candidate);
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    selected.push(candidate);
  }
  return selected;
}

function recallCandidateAdmissionKey(candidate: RecallCandidate): string {
  return recallCandidateLogicalCorpusKey(candidate);
}

function uniqueRecallCandidatesByUri(candidates: readonly RecallCandidate[]): readonly RecallCandidate[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    if (seen.has(candidate.uri)) return false;
    seen.add(candidate.uri);
    return true;
  });
}

export function mergeRecallExpansionCandidates(
  candidateSets: readonly (readonly RecallCandidate[])[],
  requiredUris: readonly string[],
  topicalSetCount = candidateSets.length,
): readonly RecallCandidate[] {
  const required = new Set(requiredUris.map(stripFragment));
  const reorderedCandidateSets = candidateSets.map(candidates => [
    ...candidates.filter(candidate => !required.has(stripFragment(candidate.uri))),
    ...candidates.filter(candidate => required.has(stripFragment(candidate.uri))),
  ]);
  return mergePrioritizedRecallIndexCandidates(
    reorderedCandidateSets.slice(0, topicalSetCount),
    reorderedCandidateSets.slice(topicalSetCount),
  );
}

export function recallExpansionVocabulary(
  candidates: readonly RecallCandidate[],
  project: string | undefined,
): readonly string[] {
  if (!project) return [];
  const normalizedProject = project.trim().toLowerCase();
  const seen = new Set<string>();
  const vocabulary: string[] = [];
  const projectCandidates = prioritizeRecallExpansionCandidates(
    candidates.filter(candidate => candidate.fields?.project?.trim().toLowerCase() === normalizedProject),
  );
  const append = (term: string | undefined, dedupeTerm = term): boolean => {
    const value = term?.trim();
    const dedupeValue = dedupeTerm?.trim();
    const key = dedupeValue?.toLowerCase();
    if (!value || !dedupeValue || dedupeValue.length > 120 || !key || seen.has(key)) return false;
    seen.add(key);
    vocabulary.push(value);
    return vocabulary.length === EXPANSION_VOCABULARY_LIMIT;
  };
  for (const candidate of projectCandidates) {
    const topic = candidate.fields?.topic?.trim();
    const description = recallExpansionDescription(candidate.text);
    if (append(topic && description ? `${topic}${EXPANSION_DESCRIPTION_SEPARATOR}${description}` : topic, topic)) {
      return vocabulary;
    }
  }
  for (const candidate of projectCandidates) {
    for (const identifier of candidate.fields?.identifiers ?? []) {
      if (append(identifier)) return vocabulary;
    }
  }
  return vocabulary;
}

function prioritizeRecallExpansionCandidates(candidates: readonly RecallCandidate[]): readonly RecallCandidate[] {
  const prioritized: RecallCandidate[] = [];
  const seen = new Set<string>();
  const append = (candidate: RecallCandidate): void => {
    if (seen.has(candidate.uri)) return;
    seen.add(candidate.uri);
    prioritized.push(candidate);
  };
  for (const candidate of candidates.slice(0, EXPANSION_VOCABULARY_RANKED_RESERVE)) append(candidate);
  for (const candidate of [...candidates].sort((left, right) => timestampValue(right) - timestampValue(left))) {
    append(candidate);
  }
  for (const candidate of candidates) append(candidate);
  return prioritized;
}

function timestampValue(candidate: RecallCandidate): number {
  if (!candidate.timestamp) return Number.NEGATIVE_INFINITY;
  const value = Date.parse(candidate.timestamp);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function recallExpansionDescription(text: string): string {
  const terms: string[] = [];
  let previous = '';
  for (const rawTerm of text.split(/\s+/)) {
    const term = rawTerm.trim();
    const key = term.toLowerCase();
    if (!term || key === previous) continue;
    terms.push(term);
    previous = key;
    if (terms.length === EXPANSION_DESCRIPTION_TERM_LIMIT) break;
  }
  return terms.join(' ').slice(0, EXPANSION_DESCRIPTION_LENGTH_LIMIT).trim();
}
