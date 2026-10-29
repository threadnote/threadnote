import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Effect, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogPublishedGenerationV1,
  type CodeGraphWorksetCatalogRoutingSymbolRecordV1,
} from '../workset_catalog/types.js';
import {
  normalizeCodeGraphWorksetRoutingExactKey,
  normalizeCodeGraphWorksetRoutingTerms,
} from '../workset_catalog/routing_normalization.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_GRAPH_WORKSET_ROUTER_VERSION = 1 as const;

/**
 * Hard query-path bounds. Candidate sources must apply the per-lane limit in
 * their indexed read; the router never compensates with a broad symbol scan.
 */
export const CODE_GRAPH_WORKSET_ROUTER_LIMITS = {
  candidateLimitPerLaneDefault: 128,
  candidateLimitPerLaneMaximum: 512,
  diversityRepositoryLimitDefault: 8,
  diversityRepositoryLimitMaximum: 32,
  expansionBatchMaximum: 32,
  queryBytesMaximum: 4_096,
  queryTermBytesMaximum: 256,
  queryTokensMaximum: 32,
  repositoryLimitDefault: 64,
  repositoryLimitMaximum: 512,
  routerCursorBytesMaximum: 8_192,
  sourceCursorBytesMaximum: 2_048,
  symbolLimitDefault: 24,
  symbolLimitMaximum: 128,
  symbolsPerRepositoryDefault: 4,
  symbolsPerRepositoryMaximum: 16,
} as const;

export const CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS = {
  exactLookupKey: 1_400,
  exactName: 1_100,
  exactPackage: 800,
  exactPath: 850,
  exactQualifiedName: 1_250,
  exported: 75,
  lexicalCoverage: 600,
  lexicalLaneRank: 175,
  pathSuffix: 300,
  exactLaneRank: 225,
} as const;

export type CodeGraphWorksetRouterErrorReason = 'invalid-input' | 'missing' | 'source-contract' | 'stale-cursor';

export class CodeGraphWorksetRouterError extends Schema.TaggedError<
  CodeGraphWorksetRouterError,
  {readonly brand: unique symbol}
>()('CodeGraphWorksetRouterError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
  reason: Schema.Literals(['invalid-input', 'missing', 'source-contract', 'stale-cursor']),
}) {
  static of(
    reason: CodeGraphWorksetRouterErrorReason,
    message: string,
    options?: ErrorOptions,
  ): CodeGraphWorksetRouterError {
    return CodeGraphWorksetRouterError.make({
      message,
      reason,
      ...(options?.cause === undefined ? {} : {cause: options.cause}),
    });
  }
}

export interface CodeGraphWorksetNormalizedRouterQueryV1 {
  /** NFKC-normalized, whitespace-collapsed, lower-case task text. */
  readonly canonical: string;
  readonly digest: string;
  /** A bounded lexical projection of the task, not a user-facing query language. */
  readonly terms: readonly string[];
  readonly termsTruncated: boolean;
}

export type CodeGraphWorksetCatalogCandidateLaneV1 = 'exact' | 'lexical';

export interface CodeGraphWorksetCatalogCandidateHitV1 {
  /** Stable one-based rank within this lane and catalog generation. */
  readonly catalogRank: number;
  readonly symbol: CodeGraphWorksetCatalogRoutingSymbolRecordV1;
}

export interface CodeGraphWorksetCatalogCandidateCoverageV1 {
  readonly consideredMemberCount: number;
  readonly eligibleMemberCount: number;
  /** `partial` is legal only for explicitly marked in-memory test sources. */
  readonly state: 'complete' | 'partial';
}

export interface CodeGraphWorksetCatalogCandidatePageV1 {
  readonly coverage: CodeGraphWorksetCatalogCandidateCoverageV1;
  readonly generationId: string;
  readonly hits: readonly CodeGraphWorksetCatalogCandidateHitV1[];
  readonly lane: CodeGraphWorksetCatalogCandidateLaneV1;
  /** Source-private, stable keyset cursor. It is wrapped by the router cursor. */
  readonly next?: string;
}

export interface CodeGraphWorksetCatalogCandidateRequestV1 {
  readonly after?: string;
  readonly generationId: string;
  readonly limit: number;
  /** Candidate-source fairness fence; apply before the global lane limit. */
  readonly maximumHitsPerMember: number;
  readonly query: CodeGraphWorksetNormalizedRouterQueryV1;
  readonly worksetName: string;
}

/**
 * Narrow adapter boundary for the catalog's indexed candidate reads. A
 * production adapter must evaluate all members through indexes and report
 * complete member coverage even when the bounded hit page has a continuation.
 */
export interface CodeGraphWorksetCatalogCandidateSourceV1 {
  readonly mode: 'catalog-index' | 'in-memory-test';
  readonly readGeneration: (
    worksetName: string,
  ) => Effect.Effect<CodeGraphWorksetCatalogPublishedGenerationV1 | undefined, CodeGraphWorksetCatalogError>;
  readonly readExactCandidates: (
    request: CodeGraphWorksetCatalogCandidateRequestV1,
  ) => Effect.Effect<CodeGraphWorksetCatalogCandidatePageV1, CodeGraphWorksetCatalogError>;
  readonly readLexicalCandidates: (
    request: CodeGraphWorksetCatalogCandidateRequestV1,
  ) => Effect.Effect<CodeGraphWorksetCatalogCandidatePageV1, CodeGraphWorksetCatalogError>;
}

export interface CodeGraphWorksetRouterLimitsV1 {
  readonly candidateLimitPerLane?: number;
  readonly diversityRepositoryLimit?: number;
  readonly repositoryLimit?: number;
  readonly symbolLimit?: number;
  readonly symbolsPerRepository?: number;
}

interface ResolvedCodeGraphWorksetRouterLimitsV1 {
  readonly candidateLimitPerLane: number;
  readonly diversityRepositoryLimit: number;
  readonly repositoryLimit: number;
  readonly symbolLimit: number;
  readonly symbolsPerRepository: number;
}

export interface CodeGraphWorksetRouterRequestV1 {
  /** Internal retrieval continuation, not the materialized result cursor. */
  readonly cursor?: string;
  readonly limits?: CodeGraphWorksetRouterLimitsV1;
  /** Plain task text; this boundary deliberately does not accept a DSL. */
  readonly query: string;
  readonly worksetName: string;
}

export type CodeGraphWorksetRouterExactMatchV1 =
  'lookup-key' | 'name' | 'package' | 'path' | 'path-suffix' | 'qualified-name';

export type CodeGraphWorksetRouterScoreFeatureV1 =
  | 'exact-lane-rank'
  | 'exact-lookup-key'
  | 'exact-name'
  | 'exact-package'
  | 'exact-path'
  | 'exact-qualified-name'
  | 'exported'
  | 'lexical-coverage'
  | 'lexical-lane-rank'
  | 'path-suffix';

export interface CodeGraphWorksetRouterScoreSignalV1 {
  readonly contribution: number;
  readonly feature: CodeGraphWorksetRouterScoreFeatureV1;
  /** Fixed-point value from 0 through 1000. */
  readonly value: number;
  readonly weight: number;
}

export interface CodeGraphWorksetRouterSymbolProvenanceV1 {
  readonly exactCatalogRank?: number;
  readonly lexicalCatalogRank?: number;
  readonly projectionDigest: string;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

export interface CodeGraphWorksetRouterRankedSymbolV1 {
  readonly exactMatches: readonly CodeGraphWorksetRouterExactMatchV1[];
  readonly globalRank: number;
  readonly provenance: CodeGraphWorksetRouterSymbolProvenanceV1;
  readonly score: number;
  readonly scoreReceipt: {
    readonly signals: readonly CodeGraphWorksetRouterScoreSignalV1[];
    readonly total: number;
    readonly version: typeof CODE_GRAPH_WORKSET_ROUTER_VERSION;
  };
  readonly selectionReason: 'global-score' | 'repository-diversity';
  readonly selectionRank: number;
  readonly symbol: CodeGraphWorksetCatalogRoutingSymbolRecordV1;
}

export interface CodeGraphWorksetRouterRepositoryCandidateV1 {
  readonly bestSymbolKey: string;
  readonly exactSymbolCount: number;
  readonly matchingSymbolCount: number;
  readonly projectionDigest: string;
  readonly rank: number;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly score: number;
  readonly scoreReceipt: {
    readonly bestSymbolContribution: number;
    readonly exactMatchContribution: number;
    readonly supportingSymbolContribution: number;
    readonly total: number;
    readonly version: typeof CODE_GRAPH_WORKSET_ROUTER_VERSION;
  };
  readonly snapshotId: string;
}

export interface CodeGraphWorksetRouterUncertaintyV1 {
  readonly reasons: readonly (
    | 'close-repository-scores'
    | 'exact-identity-in-multiple-repositories'
    | 'member-coverage-partial'
    | 'no-candidates'
    | 'weak-top-score'
  )[];
  readonly shouldExpand: boolean;
  readonly state: 'ambiguous' | 'confident' | 'empty' | 'low-confidence' | 'partial';
}

export interface CodeGraphWorksetRouterExpansionBatchV1 {
  readonly exhausted: boolean;
  readonly repositories: readonly CodeGraphWorksetRouterRepositoryCandidateV1[];
  readonly requestedBatchSize: number;
}

export interface CodeGraphWorksetRouterCoverageReceiptV1 {
  readonly consideredMemberCount: number;
  readonly eligibleMemberCount: number;
  readonly source: 'catalog-index' | 'in-memory-test';
  readonly state: 'complete' | 'partial';
}

export interface CodeGraphWorksetRouterResultV1 {
  readonly continuation?: string;
  readonly coverage: CodeGraphWorksetRouterCoverageReceiptV1;
  readonly expansion: CodeGraphWorksetRouterExpansionBatchV1;
  readonly generationId: string;
  readonly query: CodeGraphWorksetNormalizedRouterQueryV1;
  readonly repositories: readonly CodeGraphWorksetRouterRepositoryCandidateV1[];
  readonly retrieval: {
    readonly candidateLimitPerLane: number;
    readonly exactHits: number;
    readonly exactLaneExhausted: boolean;
    readonly lexicalHits: number;
    readonly lexicalLaneExhausted: boolean;
  };
  readonly symbols: readonly CodeGraphWorksetRouterRankedSymbolV1[];
  readonly uncertainty: CodeGraphWorksetRouterUncertaintyV1;
  readonly version: typeof CODE_GRAPH_WORKSET_ROUTER_VERSION;
  readonly worksetName: string;
}

interface MergedCandidate {
  readonly exactCatalogRank?: number;
  readonly lexicalCatalogRank?: number;
  readonly symbol: CodeGraphWorksetCatalogRoutingSymbolRecordV1;
}

export interface CodeGraphWorksetRouterScoredCandidateV1 {
  readonly exactMatches: readonly CodeGraphWorksetRouterExactMatchV1[];
  readonly globalRank: number;
  readonly memberKey: string;
  readonly provenance: CodeGraphWorksetRouterSymbolProvenanceV1;
  readonly score: number;
  readonly scoreReceipt: CodeGraphWorksetRouterRankedSymbolV1['scoreReceipt'];
  readonly symbol: CodeGraphWorksetCatalogRoutingSymbolRecordV1;
  readonly symbolKey: string;
}

interface RouterCursorPayloadV1 {
  readonly exactAfter?: string;
  readonly exactCoverage: CodeGraphWorksetCatalogCandidateCoverageV1;
  readonly generationId: string;
  readonly lexicalAfter?: string;
  readonly lexicalCoverage: CodeGraphWorksetCatalogCandidateCoverageV1;
  readonly queryDigest: string;
  readonly requestDigest: string;
  readonly worksetName: string;
}

const ROUTER_CURSOR_PREFIX = 'cgwr_';
const INITIAL_EXPANSION_BATCH_SIZE = 4;
const LOW_CONFIDENCE_SCORE = 225;
const CLOSE_REPOSITORY_SCORE_ABSOLUTE = 100;
const CLOSE_REPOSITORY_SCORE_RATIO = 0.05;

export function normalizeCodeGraphWorksetRouterQuery(query: string): CodeGraphWorksetNormalizedRouterQueryV1 {
  if (
    typeof query !== 'string' ||
    Buffer.byteLength(query, 'utf8') > CODE_GRAPH_WORKSET_ROUTER_LIMITS.queryBytesMaximum
  ) {
    throw invalid('Workset router query exceeds the supported bound.');
  }
  if (containsUnsupportedControlCharacter(query)) throw invalid('Workset router query contains a control character.');
  const canonical = normalizeCodeGraphWorksetRoutingExactKey(query);
  if (
    canonical.length === 0 ||
    Buffer.byteLength(canonical, 'utf8') > CODE_GRAPH_WORKSET_ROUTER_LIMITS.queryBytesMaximum
  ) {
    throw invalid('Workset router query must be non-empty after normalization and remain within its byte bound.');
  }
  const normalizedTerms = normalizeCodeGraphWorksetRoutingTerms(query, {
    maximumTermBytes: CODE_GRAPH_WORKSET_ROUTER_LIMITS.queryTermBytesMaximum,
    maximumTerms: CODE_GRAPH_WORKSET_ROUTER_LIMITS.queryTokensMaximum,
  });
  const terms = [...normalizedTerms.terms].sort(compareText);
  const digest = sha256HexSync(JSON.stringify(['threadnote-workset-router-query-v1', canonical, terms]));
  return {
    canonical,
    digest,
    terms,
    termsTruncated: normalizedTerms.truncated,
  };
}

export function codeGraphWorksetRouterExactMatches(
  query: CodeGraphWorksetNormalizedRouterQueryV1,
  symbol: CodeGraphWorksetCatalogRoutingSymbolRecordV1,
): readonly CodeGraphWorksetRouterExactMatchV1[] {
  const matches: CodeGraphWorksetRouterExactMatchV1[] = [];
  const canonical = query.canonical;
  if (EffectArray.some(symbol.lookupKeys, value => normalizeCodeGraphWorksetRoutingExactKey(value) === canonical))
    matches.push('lookup-key');
  if (normalizeCodeGraphWorksetRoutingExactKey(symbol.qualifiedName) === canonical) matches.push('qualified-name');
  if (normalizeCodeGraphWorksetRoutingExactKey(symbol.name) === canonical) matches.push('name');
  if (symbol.packageName !== undefined && normalizeCodeGraphWorksetRoutingExactKey(symbol.packageName) === canonical)
    matches.push('package');
  const path = normalizeCodeGraphWorksetRoutingExactKey(symbol.path);
  if (path === canonical) matches.push('path');
  else if (Effect2.pipe(path, EffectString.endsWith(`/${canonical}`))) matches.push('path-suffix');
  return matches;
}

export function rankCodeGraphWorksetRouterCandidates(input: {
  readonly exactHits: readonly CodeGraphWorksetCatalogCandidateHitV1[];
  readonly hasMoreCandidates?: boolean;
  readonly lexicalHits: readonly CodeGraphWorksetCatalogCandidateHitV1[];
  readonly limits?: CodeGraphWorksetRouterLimitsV1;
  readonly memberCoverageState?: 'complete' | 'partial';
  readonly query: CodeGraphWorksetNormalizedRouterQueryV1;
}): {
  readonly expansion: CodeGraphWorksetRouterExpansionBatchV1;
  readonly repositories: readonly CodeGraphWorksetRouterRepositoryCandidateV1[];
  readonly symbols: readonly CodeGraphWorksetRouterRankedSymbolV1[];
  readonly uncertainty: CodeGraphWorksetRouterUncertaintyV1;
} {
  const limits = resolveLimits(input.limits);
  assertHitsBounded(input.exactHits, limits.candidateLimitPerLane, 'exact');
  assertHitsBounded(input.lexicalHits, limits.candidateLimitPerLane, 'lexical');
  const merged = mergeCandidateHits(input.exactHits, input.lexicalHits);
  const scored = EffectArray.map(merged, candidate => scoreCandidate(input.query, candidate)).sort(
    compareScoredCandidate,
  );
  const globallyRanked = EffectArray.map(scored, (candidate, index) => ({...candidate, globalRank: index + 1}));
  const repositories = aggregateCodeGraphWorksetRepositoryCandidates(globallyRanked).slice(0, limits.repositoryLimit);
  const admittedMembers = new Set(EffectArray.map(repositories, candidate => memberKey(candidate)));
  const admittedSymbols = EffectArray.filter(
    globallyRanked,
    (candidate, __effectArrayIndex) => __effectArrayIndex in globallyRanked && admittedMembers.has(candidate.memberKey),
  );
  const symbols = selectDiverseSymbols(admittedSymbols, repositories, limits);
  const uncertainty = classifyCodeGraphWorksetRouterUncertainty({
    hasMoreCandidates: input.hasMoreCandidates ?? false,
    memberCoverageState: input.memberCoverageState ?? 'complete',
    repositories,
    symbols,
  });
  const expansion = selectCodeGraphWorksetRouterExpansionBatch(repositories, {
    batchSize: INITIAL_EXPANSION_BATCH_SIZE,
  });
  return {expansion, repositories, symbols, uncertainty};
}

export function aggregateCodeGraphWorksetRepositoryCandidates(
  symbols: readonly CodeGraphWorksetRouterScoredCandidateV1[],
): readonly CodeGraphWorksetRouterRepositoryCandidateV1[] {
  const groups = new Map<string, CodeGraphWorksetRouterScoredCandidateV1[]>();
  for (const symbol of symbols) {
    const entries = groups.get(symbol.memberKey) ?? [];
    entries.push(symbol);
    groups.set(symbol.memberKey, entries);
  }
  const candidates = EffectArray.map([...groups.values()], entries => {
    entries.sort(compareScoredCandidate);
    const best = entries[0];
    const supportingSymbolContribution = Math.floor((entries[1]?.score ?? 0) * 0.2);
    const exactSymbolCount = EffectArray.filter(entries, entry => entry.exactMatches.length > 0).length;
    const exactMatchContribution = Math.min(exactSymbolCount, 3) * 100;
    const score = best.score + supportingSymbolContribution + exactMatchContribution;
    return {
      bestSymbolKey: best.symbolKey,
      exactSymbolCount,
      matchingSymbolCount: entries.length,
      projectionDigest: best.symbol.projectionDigest,
      rank: 0,
      repositoryId: best.symbol.repositoryId,
      repositoryKey: best.symbol.repositoryKey,
      score,
      scoreReceipt: {
        bestSymbolContribution: best.score,
        exactMatchContribution,
        supportingSymbolContribution,
        total: score,
        version: CODE_GRAPH_WORKSET_ROUTER_VERSION,
      },
      snapshotId: best.symbol.snapshotId,
    } satisfies CodeGraphWorksetRouterRepositoryCandidateV1;
  });
  return EffectArray.map(candidates.sort(compareRepositoryCandidate), (candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));
}

export function classifyCodeGraphWorksetRouterUncertainty(input: {
  readonly hasMoreCandidates: boolean;
  readonly memberCoverageState: 'complete' | 'partial';
  readonly repositories: readonly CodeGraphWorksetRouterRepositoryCandidateV1[];
  readonly symbols: readonly CodeGraphWorksetRouterRankedSymbolV1[];
}): CodeGraphWorksetRouterUncertaintyV1 {
  if (input.memberCoverageState === 'partial') {
    return {reasons: ['member-coverage-partial'], shouldExpand: true, state: 'partial'};
  }
  const first = input.repositories[0];
  if (first === undefined || input.symbols.length === 0) {
    return {reasons: ['no-candidates'], shouldExpand: input.hasMoreCandidates, state: 'empty'};
  }
  const exactRepositories = new Set(
    EffectArray.map(
      EffectArray.filter(input.repositories, repository => repository.exactSymbolCount > 0),
      repository => memberKey(repository),
    ),
  );
  if (exactRepositories.size > 1) {
    return {
      reasons: ['exact-identity-in-multiple-repositories'],
      shouldExpand: true,
      state: 'ambiguous',
    };
  }
  const second = input.repositories[1];
  if (second !== undefined) {
    const margin = first.score - second.score;
    if (margin <= Math.max(CLOSE_REPOSITORY_SCORE_ABSOLUTE, Math.floor(first.score * CLOSE_REPOSITORY_SCORE_RATIO))) {
      return {reasons: ['close-repository-scores'], shouldExpand: true, state: 'ambiguous'};
    }
  }
  if (first.score < LOW_CONFIDENCE_SCORE) {
    return {reasons: ['weak-top-score'], shouldExpand: true, state: 'low-confidence'};
  }
  return {reasons: [], shouldExpand: false, state: 'confident'};
}

export function selectCodeGraphWorksetRouterExpansionBatch(
  repositories: readonly CodeGraphWorksetRouterRepositoryCandidateV1[],
  input: {
    readonly alreadySelectedRepositoryKeys?: ReadonlySet<string>;
    readonly batchSize: number;
  },
): CodeGraphWorksetRouterExpansionBatchV1 {
  const batchSize = boundedInteger(
    input.batchSize,
    'expansion batch size',
    1,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.expansionBatchMaximum,
  );
  const selected = input.alreadySelectedRepositoryKeys ?? new Set<string>();
  const remaining = EffectArray.filter(repositories, candidate => !selected.has(candidate.repositoryKey));
  return {
    exhausted: remaining.length <= batchSize,
    repositories: remaining.slice(0, batchSize),
    requestedBatchSize: batchSize,
  };
}

export const routeCodeGraphWorksetCatalogCandidates = Effect.fn('codeGraphWorksetRouter.routeCatalogCandidates')(
  function* (source: CodeGraphWorksetCatalogCandidateSourceV1, input: CodeGraphWorksetRouterRequestV1) {
    const prepared = yield* validateEffect(() => {
      const limits = resolveLimits(input.limits);
      const query = normalizeCodeGraphWorksetRouterQuery(input.query);
      return {
        cursor: input.cursor === undefined ? undefined : decodeRouterCursor(input.cursor),
        limits,
        query,
        requestDigest: routerRequestDigest(query, limits),
        worksetName: boundedText(input.worksetName, 'workset name', 256),
      };
    });
    if (prepared.cursor !== undefined) {
      if (
        prepared.cursor.queryDigest !== prepared.query.digest ||
        prepared.cursor.requestDigest !== prepared.requestDigest ||
        prepared.cursor.worksetName !== prepared.worksetName
      ) {
        return yield* staleCursor('Workset router cursor does not belong to this query.');
      }
    }
    const generation = yield* source.readGeneration(prepared.worksetName);
    if (generation === undefined) {
      return yield* CodeGraphWorksetRouterError.of('missing', 'No published catalog generation exists.');
    }
    if (prepared.cursor !== undefined && prepared.cursor.generationId !== generation.id) {
      return yield* staleCursor('Workset router cursor belongs to a superseded catalog generation.');
    }
    const exactRequest = candidateRequest(prepared, generation.id, prepared.cursor?.exactAfter);
    const lexicalRequest = candidateRequest(prepared, generation.id, prepared.cursor?.lexicalAfter);
    const [exactPage, lexicalPage] = yield* Effect.all(
      [
        prepared.cursor !== undefined && prepared.cursor.exactAfter === undefined
          ? Effect.succeed(exhaustedPage('exact', generation, prepared.cursor.exactCoverage))
          : source.readExactCandidates(exactRequest),
        prepared.cursor !== undefined && prepared.cursor.lexicalAfter === undefined
          ? Effect.succeed(exhaustedPage('lexical', generation, prepared.cursor.lexicalCoverage))
          : source.readLexicalCandidates(lexicalRequest),
      ],
      {concurrency: 2},
    );
    const validated = yield* validateEffect(() => {
      validateCandidatePage(source.mode, generation, exactPage, exactRequest, 'exact');
      validateCandidatePage(source.mode, generation, lexicalPage, lexicalRequest, 'lexical');
      return combineCandidatePages(source.mode, generation, prepared, exactPage, lexicalPage);
    });
    return validated;
  },
);

function combineCandidatePages(
  sourceMode: CodeGraphWorksetCatalogCandidateSourceV1['mode'],
  generation: CodeGraphWorksetCatalogPublishedGenerationV1,
  prepared: {
    readonly limits: ResolvedCodeGraphWorksetRouterLimitsV1;
    readonly query: CodeGraphWorksetNormalizedRouterQueryV1;
    readonly requestDigest: string;
    readonly worksetName: string;
  },
  exactPage: CodeGraphWorksetCatalogCandidatePageV1,
  lexicalPage: CodeGraphWorksetCatalogCandidatePageV1,
): CodeGraphWorksetRouterResultV1 {
  const coverageState =
    exactPage.coverage.state === 'complete' && lexicalPage.coverage.state === 'complete' ? 'complete' : 'partial';
  const ranked = rankCodeGraphWorksetRouterCandidates({
    exactHits: exactPage.hits,
    hasMoreCandidates: exactPage.next !== undefined || lexicalPage.next !== undefined,
    lexicalHits: lexicalPage.hits,
    limits: prepared.limits,
    memberCoverageState: coverageState,
    query: prepared.query,
  });
  const continuation =
    exactPage.next === undefined && lexicalPage.next === undefined
      ? undefined
      : encodeRouterCursor({
          ...(exactPage.next === undefined ? {} : {exactAfter: exactPage.next}),
          exactCoverage: exactPage.coverage,
          generationId: generation.id,
          ...(lexicalPage.next === undefined ? {} : {lexicalAfter: lexicalPage.next}),
          lexicalCoverage: lexicalPage.coverage,
          queryDigest: prepared.query.digest,
          requestDigest: prepared.requestDigest,
          worksetName: prepared.worksetName,
        });
  return {
    ...(continuation === undefined ? {} : {continuation}),
    coverage: {
      consideredMemberCount: Math.min(
        exactPage.coverage.consideredMemberCount,
        lexicalPage.coverage.consideredMemberCount,
      ),
      eligibleMemberCount: generation.members.length,
      source: sourceMode,
      state: coverageState,
    },
    expansion: ranked.expansion,
    generationId: generation.id,
    query: prepared.query,
    repositories: ranked.repositories,
    retrieval: {
      candidateLimitPerLane: prepared.limits.candidateLimitPerLane,
      exactHits: exactPage.hits.length,
      exactLaneExhausted: exactPage.next === undefined,
      lexicalHits: lexicalPage.hits.length,
      lexicalLaneExhausted: lexicalPage.next === undefined,
    },
    symbols: ranked.symbols,
    uncertainty: ranked.uncertainty,
    version: CODE_GRAPH_WORKSET_ROUTER_VERSION,
    worksetName: prepared.worksetName,
  };
}

function scoreCandidate(
  query: CodeGraphWorksetNormalizedRouterQueryV1,
  candidate: MergedCandidate,
): CodeGraphWorksetRouterScoredCandidateV1 {
  const symbol = candidate.symbol;
  const exactMatches = codeGraphWorksetRouterExactMatches(query, symbol);
  if (candidate.exactCatalogRank !== undefined && exactMatches.length === 0) {
    throw sourceContract('Exact candidate source returned a symbol without an exact field match.');
  }
  const signals: CodeGraphWorksetRouterScoreSignalV1[] = [];
  const add = (feature: CodeGraphWorksetRouterScoreFeatureV1, value: number, weight: number): void => {
    if (value <= 0) return;
    const boundedValue = Math.max(0, Math.min(1_000, Math.round(value)));
    signals.push({contribution: Math.round((boundedValue * weight) / 1_000), feature, value: boundedValue, weight});
  };
  add(
    'exact-lookup-key',
    exactMatches.includes('lookup-key') ? 1_000 : 0,
    CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.exactLookupKey,
  );
  add(
    'exact-qualified-name',
    exactMatches.includes('qualified-name') ? 1_000 : 0,
    CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.exactQualifiedName,
  );
  add('exact-name', exactMatches.includes('name') ? 1_000 : 0, CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.exactName);
  add(
    'exact-package',
    exactMatches.includes('package') ? 1_000 : 0,
    CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.exactPackage,
  );
  add('exact-path', exactMatches.includes('path') ? 1_000 : 0, CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.exactPath);
  add(
    'path-suffix',
    exactMatches.includes('path-suffix') ? 1_000 : 0,
    CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.pathSuffix,
  );
  add(
    'lexical-coverage',
    lexicalCoverage(query.terms, symbol),
    CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.lexicalCoverage,
  );
  add('exported', symbol.exported ? 1_000 : 0, CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.exported);
  if (candidate.exactCatalogRank !== undefined) {
    add(
      'exact-lane-rank',
      reciprocalRankValue(candidate.exactCatalogRank),
      CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.exactLaneRank,
    );
  }
  if (candidate.lexicalCatalogRank !== undefined) {
    add(
      'lexical-lane-rank',
      reciprocalRankValue(candidate.lexicalCatalogRank),
      CODE_GRAPH_WORKSET_ROUTER_SCORE_WEIGHTS.lexicalLaneRank,
    );
  }
  const score = EffectArray.reduce(signals, 0, (total, signal) => total + signal.contribution);
  const symbolKey = candidateKey(symbol);
  return {
    exactMatches,
    globalRank: 0,
    memberKey: memberKey(symbol),
    provenance: {
      ...(candidate.exactCatalogRank === undefined ? {} : {exactCatalogRank: candidate.exactCatalogRank}),
      ...(candidate.lexicalCatalogRank === undefined ? {} : {lexicalCatalogRank: candidate.lexicalCatalogRank}),
      projectionDigest: symbol.projectionDigest,
      repositoryId: symbol.repositoryId,
      repositoryKey: symbol.repositoryKey,
      snapshotId: symbol.snapshotId,
    },
    score,
    scoreReceipt: {signals, total: score, version: CODE_GRAPH_WORKSET_ROUTER_VERSION},
    symbol,
    symbolKey,
  };
}

function selectDiverseSymbols(
  candidates: readonly CodeGraphWorksetRouterScoredCandidateV1[],
  repositories: readonly CodeGraphWorksetRouterRepositoryCandidateV1[],
  limits: ResolvedCodeGraphWorksetRouterLimitsV1,
): readonly CodeGraphWorksetRouterRankedSymbolV1[] {
  const selected: {
    readonly candidate: CodeGraphWorksetRouterScoredCandidateV1;
    readonly reason: CodeGraphWorksetRouterRankedSymbolV1['selectionReason'];
  }[] = [];
  const selectedKeys = new Set<string>();
  const countsByMember = new Map<string, number>();
  const select = (
    candidate: CodeGraphWorksetRouterScoredCandidateV1,
    reason: CodeGraphWorksetRouterRankedSymbolV1['selectionReason'],
  ): void => {
    if (selected.length >= limits.symbolLimit || selectedKeys.has(candidate.symbolKey)) return;
    const count = countsByMember.get(candidate.memberKey) ?? 0;
    if (count >= limits.symbolsPerRepository) return;
    selected.push({candidate, reason});
    selectedKeys.add(candidate.symbolKey);
    countsByMember.set(candidate.memberKey, count + 1);
  };
  for (const repository of repositories.slice(0, limits.diversityRepositoryLimit)) {
    const key = memberKey(repository);
    const candidate = EffectOption.getOrUndefined(EffectArray.findFirst(candidates, entry => entry.memberKey === key));
    if (candidate !== undefined) select(candidate, 'repository-diversity');
  }
  for (const candidate of candidates) select(candidate, 'global-score');
  return EffectArray.map(selected, ({candidate, reason}, index) => ({
    exactMatches: candidate.exactMatches,
    globalRank: candidate.globalRank,
    provenance: candidate.provenance,
    score: candidate.score,
    scoreReceipt: candidate.scoreReceipt,
    selectionRank: index + 1,
    selectionReason: reason,
    symbol: candidate.symbol,
  }));
}

function mergeCandidateHits(
  exactHits: readonly CodeGraphWorksetCatalogCandidateHitV1[],
  lexicalHits: readonly CodeGraphWorksetCatalogCandidateHitV1[],
): readonly MergedCandidate[] {
  const candidates = new Map<string, MergedCandidate>();
  const merge = (hit: CodeGraphWorksetCatalogCandidateHitV1, lane: CodeGraphWorksetCatalogCandidateLaneV1): void => {
    validateCatalogRank(hit.catalogRank);
    const key = candidateKey(hit.symbol);
    const existing = candidates.get(key);
    if (existing !== undefined && symbolFingerprint(existing.symbol) !== symbolFingerprint(hit.symbol)) {
      throw sourceContract(`Catalog candidate ${key} has conflicting projection records.`);
    }
    candidates.set(key, {
      ...(lane === 'exact'
        ? {exactCatalogRank: Math.min(hit.catalogRank, existing?.exactCatalogRank ?? Number.MAX_SAFE_INTEGER)}
        : existing?.exactCatalogRank === undefined
          ? {}
          : {exactCatalogRank: existing.exactCatalogRank}),
      ...(lane === 'lexical'
        ? {lexicalCatalogRank: Math.min(hit.catalogRank, existing?.lexicalCatalogRank ?? Number.MAX_SAFE_INTEGER)}
        : existing?.lexicalCatalogRank === undefined
          ? {}
          : {lexicalCatalogRank: existing.lexicalCatalogRank}),
      symbol: existing?.symbol ?? hit.symbol,
    });
  };
  for (const hit of exactHits) merge(hit, 'exact');
  for (const hit of lexicalHits) merge(hit, 'lexical');
  return [...candidates.values()];
}

function lexicalCoverage(queryTerms: readonly string[], symbol: CodeGraphWorksetCatalogRoutingSymbolRecordV1): number {
  if (queryTerms.length === 0 || symbol.terms.length === 0) return 0;
  const termWeights = new Map<string, number>();
  let maximumWeight = 0;
  for (const entry of symbol.terms) {
    maximumWeight = Math.max(maximumWeight, entry.weight);
    termWeights.set(entry.term, Math.max(termWeights.get(entry.term) ?? 0, entry.weight));
  }
  if (maximumWeight <= 0) return 0;
  const value = EffectArray.reduce(
    queryTerms,
    0,
    (total, term) => total + Math.min(1, (termWeights.get(term) ?? 0) / maximumWeight),
  );
  return Math.round((value / queryTerms.length) * 1_000);
}

function validateCandidatePage(
  sourceMode: CodeGraphWorksetCatalogCandidateSourceV1['mode'],
  generation: CodeGraphWorksetCatalogPublishedGenerationV1,
  page: CodeGraphWorksetCatalogCandidatePageV1,
  request: CodeGraphWorksetCatalogCandidateRequestV1,
  lane: CodeGraphWorksetCatalogCandidateLaneV1,
): void {
  if (page.generationId !== generation.id || page.lane !== lane) {
    throw sourceContract(`Catalog ${lane} candidate page does not match its request.`);
  }
  assertHitsBounded(page.hits, request.limit, lane);
  if (
    !Number.isSafeInteger(page.coverage.eligibleMemberCount) ||
    page.coverage.eligibleMemberCount !== generation.members.length ||
    !Number.isSafeInteger(page.coverage.consideredMemberCount) ||
    page.coverage.consideredMemberCount < 0 ||
    page.coverage.consideredMemberCount > page.coverage.eligibleMemberCount
  ) {
    throw sourceContract(`Catalog ${lane} candidate page has an invalid member-coverage receipt.`);
  }
  if (page.coverage.state === 'complete' && page.coverage.consideredMemberCount !== generation.members.length) {
    throw sourceContract(`Catalog ${lane} candidate page claims incomplete complete coverage.`);
  }
  if (sourceMode === 'catalog-index' && page.coverage.state !== 'complete') {
    throw sourceContract('Production catalog candidate sources cannot report partial member coverage.');
  }
  if (page.next !== undefined) {
    boundedText(page.next, `${lane} source cursor`, CODE_GRAPH_WORKSET_ROUTER_LIMITS.sourceCursorBytesMaximum);
    if (page.hits.length === 0) throw sourceContract(`Catalog ${lane} candidate continuation made no progress.`);
  }
  const members = new Map(EffectArray.map(generation.members, member => [member.repositoryKey, member]));
  const ranks = new Set<number>();
  for (const hit of page.hits) {
    validateCatalogRank(hit.catalogRank);
    if (ranks.has(hit.catalogRank)) throw sourceContract(`Catalog ${lane} candidate ranks are not unique.`);
    ranks.add(hit.catalogRank);
    const member = members.get(hit.symbol.repositoryKey);
    if (
      member === undefined ||
      member.ordinal !== hit.symbol.ordinal ||
      member.repositoryId !== hit.symbol.repositoryId ||
      member.snapshotId !== hit.symbol.snapshotId ||
      member.projectionDigest !== hit.symbol.projectionDigest
    ) {
      throw sourceContract(`Catalog ${lane} candidate is not part of the published generation.`);
    }
  }
  const hitsByMember = new Map<string, number>();
  for (const hit of page.hits) {
    const key = memberKey(hit.symbol);
    const count = (hitsByMember.get(key) ?? 0) + 1;
    if (count > request.maximumHitsPerMember) {
      throw sourceContract(`Catalog ${lane} candidate page exceeded its per-member fairness bound.`);
    }
    hitsByMember.set(key, count);
  }
}

function candidateRequest(
  prepared: {
    readonly limits: ResolvedCodeGraphWorksetRouterLimitsV1;
    readonly query: CodeGraphWorksetNormalizedRouterQueryV1;
    readonly worksetName: string;
  },
  generationId: string,
  after?: string,
): CodeGraphWorksetCatalogCandidateRequestV1 {
  return {
    ...(after === undefined ? {} : {after}),
    generationId,
    limit: prepared.limits.candidateLimitPerLane,
    maximumHitsPerMember: Math.min(
      prepared.limits.candidateLimitPerLane,
      Math.max(2, prepared.limits.symbolsPerRepository),
    ),
    query: prepared.query,
    worksetName: prepared.worksetName,
  };
}

function exhaustedPage(
  lane: CodeGraphWorksetCatalogCandidateLaneV1,
  generation: CodeGraphWorksetCatalogPublishedGenerationV1,
  previousCoverage: CodeGraphWorksetCatalogCandidateCoverageV1,
): CodeGraphWorksetCatalogCandidatePageV1 {
  return {
    coverage: previousCoverage,
    generationId: generation.id,
    hits: [],
    lane,
  };
}

function resolveLimits(input: CodeGraphWorksetRouterLimitsV1 = {}): ResolvedCodeGraphWorksetRouterLimitsV1 {
  const candidateLimitPerLane = boundedOptionalInteger(
    input.candidateLimitPerLane,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.candidateLimitPerLaneDefault,
    'candidate limit per lane',
    1,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.candidateLimitPerLaneMaximum,
  );
  const repositoryLimit = boundedOptionalInteger(
    input.repositoryLimit,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.repositoryLimitDefault,
    'repository candidate limit',
    1,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.repositoryLimitMaximum,
  );
  const symbolLimit = boundedOptionalInteger(
    input.symbolLimit,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.symbolLimitDefault,
    'symbol candidate limit',
    1,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.symbolLimitMaximum,
  );
  const symbolsPerRepository = boundedOptionalInteger(
    input.symbolsPerRepository,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.symbolsPerRepositoryDefault,
    'symbols per repository limit',
    1,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.symbolsPerRepositoryMaximum,
  );
  const diversityRepositoryLimit = boundedOptionalInteger(
    input.diversityRepositoryLimit,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.diversityRepositoryLimitDefault,
    'diversity repository limit',
    1,
    CODE_GRAPH_WORKSET_ROUTER_LIMITS.diversityRepositoryLimitMaximum,
  );
  return {
    candidateLimitPerLane,
    diversityRepositoryLimit: Math.min(diversityRepositoryLimit, repositoryLimit, symbolLimit),
    repositoryLimit,
    symbolLimit,
    symbolsPerRepository: Math.min(symbolsPerRepository, symbolLimit),
  };
}

function assertHitsBounded(
  hits: readonly CodeGraphWorksetCatalogCandidateHitV1[],
  limit: number,
  lane: CodeGraphWorksetCatalogCandidateLaneV1,
): void {
  if (hits.length > limit) throw sourceContract(`Catalog ${lane} candidate page exceeded its requested bound.`);
}

function reciprocalRankValue(rank: number): number {
  return Math.max(1, Math.floor(1_000 / rank));
}

function candidateKey(symbol: CodeGraphWorksetCatalogRoutingSymbolRecordV1): string {
  return `${memberKey(symbol)}\u0000${symbol.nodeId}`;
}

function memberKey(value: {
  readonly projectionDigest: string;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}): string {
  return `${value.repositoryId}\u0000${value.repositoryKey}\u0000${value.snapshotId}\u0000${value.projectionDigest}`;
}

function symbolFingerprint(symbol: CodeGraphWorksetCatalogRoutingSymbolRecordV1): string {
  return JSON.stringify([
    symbol.repositoryKey,
    symbol.repositoryId,
    symbol.snapshotId,
    symbol.projectionDigest,
    symbol.nodeId,
    symbol.kind,
    symbol.language,
    symbol.exported,
    symbol.packageName ?? null,
    symbol.path,
    symbol.name,
    symbol.qualifiedName,
    symbol.span,
    symbol.lookupKeys,
    symbol.terms,
  ]);
}

function compareScoredCandidate(
  left: CodeGraphWorksetRouterScoredCandidateV1,
  right: CodeGraphWorksetRouterScoredCandidateV1,
): number {
  return (
    right.score - left.score ||
    compareText(left.symbol.repositoryId, right.symbol.repositoryId) ||
    compareText(left.symbol.path, right.symbol.path) ||
    left.symbol.span.line - right.symbol.span.line ||
    left.symbol.span.column - right.symbol.span.column ||
    left.symbol.span.endLine - right.symbol.span.endLine ||
    left.symbol.span.endColumn - right.symbol.span.endColumn ||
    compareText(left.symbol.nodeId, right.symbol.nodeId) ||
    compareText(left.symbol.repositoryKey, right.symbol.repositoryKey) ||
    compareText(left.symbol.snapshotId, right.symbol.snapshotId)
  );
}

function compareRepositoryCandidate(
  left: CodeGraphWorksetRouterRepositoryCandidateV1,
  right: CodeGraphWorksetRouterRepositoryCandidateV1,
): number {
  return (
    right.score - left.score ||
    compareText(left.repositoryId, right.repositoryId) ||
    compareText(left.repositoryKey, right.repositoryKey) ||
    compareText(left.snapshotId, right.snapshotId) ||
    compareText(left.projectionDigest, right.projectionDigest)
  );
}

function routerRequestDigest(
  query: CodeGraphWorksetNormalizedRouterQueryV1,
  limits: ResolvedCodeGraphWorksetRouterLimitsV1,
): string {
  return sha256HexSync(
    JSON.stringify([
      'threadnote-workset-router-request-v1',
      query.digest,
      limits.candidateLimitPerLane,
      limits.repositoryLimit,
      limits.symbolLimit,
      limits.symbolsPerRepository,
      limits.diversityRepositoryLimit,
    ]),
  );
}

function encodeRouterCursor(payload: RouterCursorPayloadV1): string {
  const serialized = JSON.stringify([
    CODE_GRAPH_WORKSET_ROUTER_VERSION,
    payload.worksetName,
    payload.queryDigest,
    payload.requestDigest,
    payload.generationId,
    payload.exactAfter ?? null,
    payload.exactCoverage.state,
    payload.exactCoverage.consideredMemberCount,
    payload.lexicalAfter ?? null,
    payload.lexicalCoverage.state,
    payload.lexicalCoverage.consideredMemberCount,
    payload.exactCoverage.eligibleMemberCount,
  ]);
  return `${ROUTER_CURSOR_PREFIX}${Buffer.from(serialized, 'utf8').toString('base64url')}`;
}

function decodeRouterCursor(cursor: string): RouterCursorPayloadV1 {
  boundedText(cursor, 'router cursor', CODE_GRAPH_WORKSET_ROUTER_LIMITS.routerCursorBytesMaximum);
  if (!Effect2.pipe(cursor, EffectString.startsWith(ROUTER_CURSOR_PREFIX)))
    throw invalid('Workset router cursor is invalid.');
  try {
    const encoded = Effect2.pipe(cursor, EffectString.slice(ROUTER_CURSOR_PREFIX.length));
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(decoded);
    if (!EffectArray.isArray(value) || value.length !== 12 || value[0] !== CODE_GRAPH_WORKSET_ROUTER_VERSION) {
      throw invalid('Workset router cursor version is incompatible.');
    }
    const worksetName = boundedText(value[1], 'cursor workset name', 256);
    const queryDigest = boundedDigest(value[2], 'cursor query digest');
    const requestDigest = boundedDigest(value[3], 'cursor request digest');
    const generationId = boundedText(value[4], 'cursor generation identity', 256);
    const exactAfter = optionalCursorValue(value[5], 'exact cursor');
    const exactCoverageState = cursorCoverageState(value[6]);
    const exactConsidered = cursorMemberCount(value[7], 'exact considered member count');
    const lexicalAfter = optionalCursorValue(value[8], 'lexical cursor');
    const lexicalCoverageState = cursorCoverageState(value[9]);
    const lexicalConsidered = cursorMemberCount(value[10], 'lexical considered member count');
    const eligibleMemberCount = cursorMemberCount(value[11], 'eligible member count');
    if (exactConsidered > eligibleMemberCount || lexicalConsidered > eligibleMemberCount) {
      throw invalid('Workset router cursor member coverage is invalid.');
    }
    if (exactAfter === undefined && lexicalAfter === undefined) throw invalid('Workset router cursor is exhausted.');
    const payload = {
      ...(exactAfter === undefined ? {} : {exactAfter}),
      exactCoverage: {
        consideredMemberCount: exactConsidered,
        eligibleMemberCount,
        state: exactCoverageState,
      },
      generationId,
      ...(lexicalAfter === undefined ? {} : {lexicalAfter}),
      lexicalCoverage: {
        consideredMemberCount: lexicalConsidered,
        eligibleMemberCount,
        state: lexicalCoverageState,
      },
      queryDigest,
      requestDigest,
      worksetName,
    };
    if (encodeRouterCursor(payload) !== cursor) throw invalid('Workset router cursor encoding is non-canonical.');
    return payload;
  } catch (cause) {
    if (Schema.is(CodeGraphWorksetRouterError)(cause)) throw cause;
    throw invalid('Workset router cursor is invalid.', cause);
  }
}

function cursorCoverageState(value: unknown): CodeGraphWorksetCatalogCandidateCoverageV1['state'] {
  if (value !== 'complete' && value !== 'partial') throw invalid('Workset router cursor coverage state is invalid.');
  return value;
}

function cursorMemberCount(value: unknown, label: string): number {
  return boundedInteger(
    typeof value === 'number' ? value : Number.NaN,
    label,
    0,
    CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration,
  );
}

function optionalCursorValue(value: unknown, label: string): string | undefined {
  if (value === null) return undefined;
  return boundedText(value, label, CODE_GRAPH_WORKSET_ROUTER_LIMITS.sourceCursorBytesMaximum);
}

function boundedDigest(value: unknown, label: string): string {
  const digest = boundedText(value, label, 64);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw invalid(`Workset ${label} is invalid.`);
  return digest;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    containsControlCharacter(value)
  ) {
    throw invalid(`Workset ${label} is invalid.`);
  }
  return value;
}

function boundedOptionalInteger(
  value: number | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  return boundedInteger(value ?? fallback, label, minimum, maximum);
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`Workset ${label} must be an integer from ${String(minimum)} through ${String(maximum)}.`);
  }
  return value;
}

function validateCatalogRank(rank: number): void {
  if (!Number.isSafeInteger(rank) || rank < 1) throw sourceContract('Catalog candidate rank is invalid.');
}

function containsUnsupportedControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = Effect2.pipe(
      character,
      EffectString.codePointAt(0),
      Effect2.Option.getOrElse(() => undefined),
    )!;
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    if (code === 0x7f) return true;
  }
  return false;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = Effect2.pipe(
      character,
      EffectString.codePointAt(0),
      Effect2.Option.getOrElse(() => undefined),
    )!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateEffect<A>(evaluate: () => A): Effect.Effect<A, CodeGraphWorksetRouterError> {
  return Effect.try({
    catch: cause =>
      Schema.is(CodeGraphWorksetRouterError)(cause)
        ? cause
        : CodeGraphWorksetRouterError.of('invalid-input', 'Workset router validation failed.', {cause}),
    try: evaluate,
  });
}

function invalid(message: string, cause?: unknown): CodeGraphWorksetRouterError {
  return CodeGraphWorksetRouterError.of('invalid-input', message, cause === undefined ? undefined : {cause});
}

function sourceContract(message: string): CodeGraphWorksetRouterError {
  return CodeGraphWorksetRouterError.of('source-contract', message);
}

function staleCursor(message: string): CodeGraphWorksetRouterError {
  return CodeGraphWorksetRouterError.of('stale-cursor', message);
}
