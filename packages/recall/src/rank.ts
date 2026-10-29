import {Array as EffectArray} from 'effect';
import type {ExternalResourceMetadata} from '@threadnote/store/external-resource';
import type {MemoryAuthority, MemoryRelation, MemoryTrust} from '@threadnote/memory/document';
import {stripGeneratedMemoryHygieneSources} from '@threadnote/memory/hygiene/provenance';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
import {hasExactCasedCodeIdentifierMatch} from './identifier.js';
import {recallRankCandidateIsEligible, type RecallEligibilityPolicy} from './eligibility.js';
import {recallLexicalTerms} from './tokenize.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

export const RECALL_RANKER_VERSION = 'hybrid-v8';

export interface RecallFields {
  readonly identifiers?: readonly string[];
  readonly keywords?: readonly string[];
  readonly project?: string;
  readonly title?: string;
  readonly topic?: string;
  readonly workspaceScope?: string;
}

export interface RecallCandidate {
  readonly authority?: MemoryAuthority;
  /** Canonical body digest used only to prove that logical-memory aliases are byte-equivalent. */
  readonly contentHash?: string;
  /** Other authorized URIs that resolve to the same logical memory and canonical body. */
  readonly equivalentUris?: readonly string[];
  readonly exactTerms?: readonly string[];
  readonly externalSource?: ExternalResourceMetadata & {readonly fetchedAt: number};
  readonly feedback?: number;
  readonly fields?: RecallFields;
  /** The same memory_id was observed with more than one body digest in the authorized candidate set. */
  readonly identityConflict?: boolean;
  readonly kind?: MemoryKind;
  readonly memoryId?: string;
  readonly relations?: readonly MemoryRelation[];
  readonly reranker?: number;
  readonly semantic?: number;
  readonly status?: MemoryStatus;
  readonly text: string;
  readonly timestamp?: string;
  readonly trust?: MemoryTrust;
  readonly uri: string;
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface RecallRankContext {
  readonly allowExactRescue?: boolean;
  readonly allowSemanticRescue?: boolean;
  readonly corpusStatistics?: RecallCorpusStatistics;
  readonly eligibility?: RecallEligibilityPolicy;
  readonly includeInactive?: boolean;
  readonly includeTemporallyInvalid?: boolean;
  readonly minimumScore?: number;
  readonly now?: Date;
  readonly project?: string;
  /** Canonically verified one-hop memories that occupy a protected result prefix. */
  readonly protectedUris?: readonly string[];
  readonly queryVariants?: readonly string[];
  readonly seedUris?: readonly string[];
  readonly workspaceBranch?: string;
  readonly workspaceScope?: string;
}

export interface RecallCorpusStatistics {
  readonly averageDocumentLength: number;
  readonly documentCount: number;
  readonly documentFrequency: Readonly<Record<string, number>>;
  readonly totalDocumentLength: number;
}

export interface RecallSignals {
  readonly authority: number;
  readonly branch?: number;
  readonly bm25: number;
  readonly exact: number;
  readonly feedback: number;
  readonly field: number;
  readonly freshness: number;
  readonly graph: number;
  readonly kindIntent: number;
  readonly lifecycle: number;
  readonly reranker: number;
  readonly scope: number;
  readonly semantic: number;
  readonly temporal: number;
  readonly workspace: number;
}

export interface RecallReason {
  readonly code: string;
  readonly contribution: number;
  readonly detail: string;
}

export interface RankedRecallCandidate {
  readonly candidate: RecallCandidate;
  readonly finalScore: number;
  readonly passedRelevanceGate: boolean;
  readonly relevanceScore: number;
  readonly reasons: readonly RecallReason[];
  readonly signals: RecallSignals;
  readonly warnings: readonly string[];
}

export type RecallConfidenceLevel = 'high' | 'low' | 'medium' | 'no_answer';

export interface RecallConfidence {
  readonly level: RecallConfidenceLevel;
  readonly margin: number;
  readonly reason: string;
  readonly score: number;
}

export interface RankedRecallSet {
  readonly confidence: RecallConfidence;
  readonly rankerVersion: typeof RECALL_RANKER_VERSION;
  readonly results: readonly RankedRecallCandidate[];
}

export function shouldExpandRecall(confidence: {readonly level: RecallConfidenceLevel} | undefined): boolean {
  return confidence !== undefined && confidence.level !== 'high';
}

const SIGNAL_WEIGHTS = {
  authority: 0.04,
  branch: 0.06,
  bm25: 0.18,
  exact: 0.18,
  feedback: 0.03,
  field: 0.16,
  freshness: 0.04,
  graph: 0.07,
  kindIntent: 0.04,
  lifecycle: 0.05,
  reranker: 0.1,
  scope: 0.03,
  semantic: 0.16,
  temporal: 0.02,
  workspace: 0.04,
} as const;

const FIELD_WEIGHTS = {
  identifiers: 0.15,
  keywords: 0.2,
  project: 0.2,
  title: 0.35,
  topic: 0.3,
} as const;

const BM25_SATURATION = 1.2;
const BM25_LENGTH_NORMALIZATION = 0.75;
const BM25_IDF_SMOOTHING = 0.5;
const FIELD_QUERY_COVERAGE_WEIGHT = 0.4;
const FIELD_VALUE_PRECISION_WEIGHT = 0.6;
const FIELD_EXACT_SUBSET_BONUS = 0.2;
const RELEVANCE_GATE_MINIMUM = 0.08;
const EXACT_TERM_RESCUE_MINIMUM = 0.75;
const EXACT_TERM_RESCUE_FIELD_MINIMUM = 0.35;
const EXACT_CONTEXTUAL_TERM_SCORE = 1;
const EXACT_MULTI_TERM_BASE_SCORE = 0.4;
const EXACT_MULTI_TERM_IDF_COVERAGE_WEIGHT = 0.6;
const EXACT_IDENTIFIER_SCORE = 0.9;
const EXACT_MULTI_TERM_MINIMUM = 2;
const NO_ANSWER_SCORE_MINIMUM = 0.2;
const LEXICAL_ONLY_ANSWER_MINIMUM = 0.5;
const LEXICAL_ONLY_FOCUSED_FIELD_MINIMUM = 0.08;
const SEMANTIC_ONLY_ANSWER_MINIMUM = 0.271;
const SIGNAL_ABSENCE_MAXIMUM = 0.05;
const TEMPORALLY_INVALID_SCORE_MULTIPLIER = 0.25;
const UNKNOWN_FRESHNESS_SCORE = 0.5;
const UNKNOWN_SCOPE_SCORE = 0.5;
const RECENCY_INTENT_HALF_LIFE_DAYS = 14;
const RECENCY_INTENT_MINIMUM_MULTIPLIER = 0.25;
const UNKNOWN_RECENCY_INTENT_SCORE = 0;

const intentTerms = (terms: string): ReadonlySet<string> => new Set(Effect.pipe(terms, EffectString.split(' ')));

const MEMORY_KIND_INTENT_TERMS: Readonly<Record<MemoryKind, ReadonlySet<string>>> = {
  durable: intentTerms('contract decision invariant policy unsupported'),
  handoff: intentTerms('branch current handoff status'),
  incident: intentTerms('failure incident outage regression'),
  preference: intentTerms('preference style tone'),
  smoke: intentTerms('smoke'),
};
const META_TOPIC_TERMS = intentTerms('audit backlog benchmark eval evaluation fixture');
const META_QUERY_INTENT_TERMS = intentTerms(
  'accuracy audit backlog benchmark eval evaluation fixture latency performance quality test testing trial',
);

const FRESHNESS_HALF_LIFE_DAYS: Readonly<Record<MemoryKind, number>> = {
  durable: 180,
  handoff: 14,
  incident: 90,
  preference: 365,
  smoke: 14,
};

const RECENCY_INTENT_TERMS = new Set(['latest', 'newest', 'recent', 'recently']);
const RECENCY_INTENT_NEGATION_TERMS = new Set(['avoid', 'excluding', 'ignore', 'never', 'no', 'not', 'without']);
const RECENCY_INTENT_CLAUSE_BOUNDARY = /[.!?;,]+|\b(?:and|but|then)\b/iu;
const RECENCY_INTENT_WORD = /[\p{L}\p{N}_]+/gu;
const RECENCY_INTENT_NEGATION_DISTANCE = 8;

const AUTHORITY_SCORES: Readonly<Record<MemoryAuthority, number>> = {
  agent_generated: 0.6,
  canonical_repo: 1,
  external: 0.45,
  reviewed_shared: 0.85,
  user_approved: 0.95,
};

const TRUST_SCORES: Readonly<Record<MemoryTrust, number>> = {
  approved: 1,
  inferred: 0.6,
  untrusted: 0.2,
};

/**
 * Untrusted repository-derived resources are evidence, never an authority. They
 * are seeded verbatim and therefore win narrow lexical/field contests against
 * the curated memory that owns the same topic, so they are demoted after
 * relevance is established rather than through the small authority weight.
 */
const TRUST_SCORE_MULTIPLIERS: Readonly<Record<MemoryTrust, number>> = {
  approved: 1,
  inferred: 1,
  untrusted: 0.7,
};

const UNKNOWN_AUTHORITY_SCORE = 0.5;
const UNKNOWN_TRUST_SCORE = 0.5;
const AUTHORITY_BLEND_WEIGHT = 0.7;
const TRUST_BLEND_WEIGHT = 0.3;

const LIFECYCLE_SCORES: Readonly<Record<MemoryStatus, number>> = {
  active: 1,
  archived: 0.15,
  expired: 0,
  superseded: 0,
};

const LIFECYCLE_SCORE_MULTIPLIERS: Readonly<Record<MemoryStatus, number>> = {
  active: 1,
  archived: 0.35,
  expired: 0.1,
  superseded: 0.15,
};

const RELATION_WEIGHTS: Readonly<Record<MemoryRelation['type'], number>> = {
  depends_on: 0.9,
  evidence_for: 1,
  references: 0.65,
  related_to: 0.55,
  supersedes: 0.8,
};

const MAX_GRAPH_DISTANCE = 3;
const GRAPH_DISTANCE_PENALTY = 0.5;
const GRAPH_SEMANTIC_ANCHOR_MINIMUM = 0.65;
const MAX_GRAPH_SEMANTIC_ANCHORS = 2;
const SAME_IDENTITY_RELATION_WEIGHT = 0.75;
const SAME_IDENTITY_EDGE_WEIGHT = Math.sqrt(SAME_IDENTITY_RELATION_WEIGHT);
const IDENTITY_GRAPH_NODE_PREFIX = '\u0000identity:';
const EXPLANATION_CONTRIBUTION_MINIMUM = 0.005;
const CORROBORATING_SIGNAL_MINIMUM = 0.15;
const HIGH_CONFIDENCE_SCORE_MINIMUM = 0.58;
const HIGH_CONFIDENCE_MARGIN_MINIMUM = 0.08;
const HIGH_CONFIDENCE_SIGNAL_COUNT = 3;
const MEDIUM_CONFIDENCE_SCORE_MINIMUM = 0.36;
const MEDIUM_CONFIDENCE_SIGNAL_COUNT = 2;
const MILLISECONDS_PER_DAY = 86_400_000;
const HALF_LIFE_DECAY_BASE = 2;
const DETERMINISTIC_DEFAULT_NOW = new Date(0);

export function rankRecallCandidates(
  query: string,
  candidates: readonly RecallCandidate[],
  context: RecallRankContext = {},
): RankedRecallSet {
  const eligibility = context.eligibility;
  const eligibleCandidates = eligibility
    ? EffectArray.filter(
        candidates,
        (candidate, __effectArrayIndex) =>
          __effectArrayIndex in candidates && recallRankCandidateIsEligible(eligibility, candidate),
      )
    : candidates;
  const logicalCandidates = deduplicateLogicalRecallCandidates(eligibleCandidates);
  const queryTermVariants = [
    tokenize(query),
    ...EffectOption.getOrElse(
      EffectOption.map(EffectOption.fromNullishOr(context.queryVariants), variants =>
        EffectArray.map(
          [
            ...new Set(
              EffectArray.filter(
                EffectArray.map(variants, variant => Effect.pipe(variant, EffectString.trim)),
                Boolean,
              ),
            ),
          ],
          tokenize,
        ),
      ),
      () => [],
    ),
  ];
  const corpusStatistics = Effect.pipe(context.workspaceScope, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  )
    ? buildRecallTopicalCorpusStatistics(logicalCandidates)
    : (context.corpusStatistics ?? buildRecallCorpusStatistics(logicalCandidates));
  const semanticAnchors = EffectArray.map(
    EffectArray.filter(logicalCandidates, candidate => (candidate.semantic ?? 0) >= GRAPH_SEMANTIC_ANCHOR_MINIMUM)
      .sort((left, right) => (right.semantic ?? 0) - (left.semantic ?? 0) || compareCodeUnits(left.uri, right.uri))
      .slice(0, MAX_GRAPH_SEMANTIC_ANCHORS),
    candidate => candidate.uri,
  );
  const explicitSeedUris = [...new Set(context.seedUris ?? [])];
  const graphDistances = mergeGraphDistances(
    typedGraphDistances(logicalCandidates, explicitSeedUris),
    typedGraphDistances(logicalCandidates, semanticAnchors),
    new Set(explicitSeedUris),
  );
  const now = context.now ?? DETERMINISTIC_DEFAULT_NOW;
  const protectedOrdinalByUri = new Map(
    EffectArray.map([...new Set(context.protectedUris ?? [])], (uri, ordinal) => [uri, ordinal] as const),
  );
  const recencyIntent = originalQueryRequestsRecency(query);
  const scoredCandidates = EffectArray.map(logicalCandidates, candidate =>
    scoreCandidate(candidate, queryTermVariants, corpusStatistics, graphDistances, {
      ...context,
      now,
      recencyIntent,
    }),
  );
  const ranked = EffectArray.filter(scoredCandidates, (result, index) => {
    if (!(index in scoredCandidates)) return false;
    const protectedResult = protectedRecallOrdinal(result.candidate, protectedOrdinalByUri) !== undefined;
    const semanticRescue =
      context.allowSemanticRescue === true &&
      result.signals.semantic >= CORROBORATING_SIGNAL_MINIMUM &&
      result.relevanceScore >= SEMANTIC_ONLY_ANSWER_MINIMUM;
    return (
      (protectedResult ||
        (result.passedRelevanceGate &&
          (context.minimumScore === undefined ||
            result.relevanceScore >= context.minimumScore ||
            semanticRescue ||
            (context.allowExactRescue === true &&
              result.signals.exact >= EXACT_TERM_RESCUE_MINIMUM &&
              (result.signals.kindIntent === 1 ||
                result.signals.field >= EXACT_TERM_RESCUE_FIELD_MINIMUM ||
                EffectArray.some(qualifyingExactTerms(result.candidate), term => /[\p{N}_.-]/u.test(term))))))) &&
      (context.includeInactive === true || result.signals.lifecycle === LIFECYCLE_SCORES.active) &&
      (context.includeTemporallyInvalid === true || result.signals.temporal === 1)
    );
  }).sort((left, right) => {
    const leftProtected = protectedRecallOrdinal(left.candidate, protectedOrdinalByUri);
    const rightProtected = protectedRecallOrdinal(right.candidate, protectedOrdinalByUri);
    return (
      (leftProtected === undefined ? 1 : 0) - (rightProtected === undefined ? 1 : 0) ||
      (leftProtected ?? 0) - (rightProtected ?? 0) ||
      right.finalScore - left.finalScore ||
      right.signals.reranker - left.signals.reranker ||
      right.signals.semantic - left.signals.semantic ||
      compareCodeUnits(left.candidate.uri, right.candidate.uri)
    );
  });
  return {
    confidence: assessConfidence(ranked, query, queryTermVariants[0] ?? []),
    rankerVersion: RECALL_RANKER_VERSION,
    results: ranked,
  };
}

function protectedRecallOrdinal(
  candidate: RecallCandidate,
  protectedOrdinalByUri: ReadonlyMap<string, number>,
): number | undefined {
  let ordinal = protectedOrdinalByUri.get(candidate.uri);
  for (const uri of candidate.equivalentUris ?? []) {
    const aliasOrdinal = protectedOrdinalByUri.get(uri);
    if (aliasOrdinal !== undefined && (ordinal === undefined || aliasOrdinal < ordinal)) ordinal = aliasOrdinal;
  }
  return ordinal;
}

/**
 * Detect an explicit request for the newest available evidence. Only the
 * original user query reaches this function; generated query variants cannot
 * enable the temporal preference. `current` is deliberately excluded because
 * it commonly names a branch, worktree, or still-valid contract rather than a
 * request to prefer the newest timestamp.
 */
export function originalQueryRequestsRecency(originalQuery: string): boolean {
  return EffectArray.some(
    Effect.pipe(
      originalQuery,
      EffectString.normalize('NFC'),
      EffectString.toLowerCase,
      EffectString.split(RECENCY_INTENT_CLAUSE_BOUNDARY),
    ),
    clause => {
      const terms =
        Effect.pipe(
          clause,
          EffectString.match(RECENCY_INTENT_WORD),
          Effect.Option.getOrElse(() => null),
        ) ?? [];
      return EffectArray.some(terms, (term, index) => {
        if (!RECENCY_INTENT_TERMS.has(term)) return false;
        if (terms[index - 1] === 'least') return false;
        const precedingTerms = terms.slice(Math.max(0, index - RECENCY_INTENT_NEGATION_DISTANCE), index);
        return !EffectArray.some(precedingTerms, preceding => RECENCY_INTENT_NEGATION_TERMS.has(preceding));
      });
    },
  );
}

/**
 * Collapse only aliases that have both the same logical identity and the same
 * canonical body digest. This must run after URI authorization: the aliases on
 * the retained candidate are therefore safe to disclose to the current recall
 * request. A reused memory_id with divergent bodies deliberately remains as
 * separate conflict evidence.
 */
export function deduplicateLogicalRecallCandidates(candidates: readonly RecallCandidate[]): readonly RecallCandidate[] {
  if (candidates.length < 2) return candidates;

  const contentHashesByMemoryId = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (!candidate.memoryId || !candidate.contentHash) continue;
    const hashes = contentHashesByMemoryId.get(candidate.memoryId) ?? new Set<string>();
    hashes.add(candidate.contentHash);
    contentHashesByMemoryId.set(candidate.memoryId, hashes);
  }
  const conflictingMemoryIds = new Set(
    EffectArray.map(
      EffectArray.filter([...contentHashesByMemoryId], ([, hashes]) => hashes.size > 1),
      ([memoryId]) => memoryId,
    ),
  );

  const parents = EffectArray.map(candidates, (_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  const firstIndexByMemoryIdKey = new Map<string, number>();
  const indicesByLegacyKey = new Map<string, number[]>();
  EffectArray.forEach(candidates, (candidate, index) => {
    const memoryIdKey = logicalRecallMemoryIdKey(candidate);
    if (memoryIdKey) {
      const previous = firstIndexByMemoryIdKey.get(memoryIdKey);
      if (previous === undefined) firstIndexByMemoryIdKey.set(memoryIdKey, index);
      else union(previous, index);
    }
    const legacyKey = logicalRecallLegacyKey(candidate);
    if (legacyKey) indicesByLegacyKey.set(legacyKey, [...(indicesByLegacyKey.get(legacyKey) ?? []), index]);
  });
  for (const indices of indicesByLegacyKey.values()) {
    const memoryIds = new Set(
      EffectArray.flatMap(indices, index => (candidates[index]?.memoryId ? [candidates[index].memoryId] : [])),
    );
    if (memoryIds.size > 1) continue;
    const first = indices[0];
    if (first === undefined) continue;
    for (const index of indices.slice(1)) union(first, index);
  }

  const membersByRoot = new Map<number, RecallCandidate[]>();
  EffectArray.forEach(candidates, (candidate, index) => {
    const root = find(index);
    const members = membersByRoot.get(root) ?? [];
    members.push(candidate);
    membersByRoot.set(root, members);
  });
  return EffectArray.map(
    EffectArray.map(
      [...membersByRoot.entries()].sort(([left], [right]) => left - right),
      ([, members]) =>
        Effect.pipe(members, __effectReduceValues =>
          EffectArray.reduce(
            EffectArray.drop(__effectReduceValues, 1),
            Effect.Option.getOrElse(EffectArray.head(__effectReduceValues), () => {
              throw new TypeError('Reduce of empty array with no initial value');
            }),
            mergeEquivalentRecallCandidates,
          ),
        ),
    ),
    candidate =>
      candidate.memoryId && conflictingMemoryIds.has(candidate.memoryId)
        ? {...candidate, identityConflict: true}
        : candidate,
  );
}

export function recallMemoryContentHash(body: string): string {
  // Line endings and Threadnote's generated local-only hygiene trailer are
  // transport/provenance details. Every other byte belongs to the memory body;
  // Markdown/code indentation and trailing spaces remain identity-bearing.
  return sha256HexSync(Effect.pipe(stripGeneratedMemoryHygieneSources(body), EffectString.replace(/\r\n?/g, '\n')));
}

/** Stable physical-index grouping key used to keep share aliases from inflating corpus statistics. */
export function recallCandidateLogicalCorpusKey(candidate: RecallCandidate): string {
  return logicalRecallMemoryIdKey(candidate) ?? logicalRecallLegacyKey(candidate) ?? `uri\u0000${candidate.uri}`;
}

function logicalRecallMemoryIdKey(candidate: RecallCandidate): string | undefined {
  if (!candidate.memoryId || !candidate.contentHash || !candidate.kind) return undefined;
  return `memory-id\u0000${candidate.memoryId}\u0000${candidate.contentHash}\u0000${logicalRecallInvariantKey(candidate)}`;
}

function logicalRecallLegacyKey(candidate: RecallCandidate): string | undefined {
  if (!candidate.contentHash || !candidate.kind) return undefined;
  const project = Effect.pipe(
    candidate.fields?.project,
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  const topic = Effect.pipe(
    candidate.fields?.topic,
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  if (!project || !topic) return undefined;
  return `legacy-memory\u0000${candidate.kind}\u0000${project}\u0000${topic}\u0000${candidate.contentHash}\u0000${logicalRecallInvariantKey(candidate)}`;
}

function logicalRecallInvariantKey(candidate: RecallCandidate): string {
  return JSON.stringify([
    candidate.kind,
    Effect.pipe(
      candidate.fields?.project,
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
    ),
    Effect.pipe(
      candidate.fields?.topic,
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
    ),
    Effect.pipe(candidate.fields?.workspaceScope, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ),
    candidate.status,
    candidate.timestamp,
    candidate.validFrom,
    candidate.validTo,
  ]);
}

function mergeEquivalentRecallCandidates(left: RecallCandidate, right: RecallCandidate): RecallCandidate {
  const representative = compareRecallAliasAuthority(left, right) <= 0 ? left : right;
  const other = representative === left ? right : left;
  const equivalentUris = EffectArray.filter(
    [
      ...new Set([
        representative.uri,
        ...(representative.equivalentUris ?? []),
        other.uri,
        ...(other.equivalentUris ?? []),
      ]),
    ],
    uri => uri !== representative.uri,
  ).sort(compareCodeUnits);
  const relations = [
    ...new Map(
      EffectArray.map([...(left.relations ?? []), ...(right.relations ?? [])], relation => [
        `${relation.type}\u0000${relation.uri}`,
        relation,
      ]),
    ).values(),
  ].sort((a, b) => compareCodeUnits(a.type, b.type) || compareCodeUnits(a.uri, b.uri));
  const exactTerms = [...new Set([...(left.exactTerms ?? []), ...(right.exactTerms ?? [])])].sort(compareCodeUnits);
  const memoryIds = [
    ...new Set(EffectArray.filter([left.memoryId, right.memoryId], (value): value is string => Boolean(value))),
  ];
  return {
    ...representative,
    contentHash: representative.contentHash ?? other.contentHash,
    equivalentUris: equivalentUris.length > 0 ? equivalentUris : undefined,
    exactTerms: exactTerms.length > 0 ? exactTerms : undefined,
    feedback: strongestOptionalScore(left.feedback, right.feedback),
    identityConflict: left.identityConflict || right.identityConflict || memoryIds.length > 1 || undefined,
    memoryId: memoryIds.length === 1 ? memoryIds[0] : undefined,
    relations: relations.length > 0 ? relations : undefined,
    reranker: maximumOptionalScore(left.reranker, right.reranker),
    semantic: maximumOptionalScore(left.semantic, right.semantic),
  };
}

function compareRecallAliasAuthority(left: RecallCandidate, right: RecallCandidate): number {
  return (
    lifecycleScore(right.status) - lifecycleScore(left.status) ||
    authorityScore(right.authority, right.trust) - authorityScore(left.authority, left.trust) ||
    compareOptionalTimestampDescending(left.timestamp, right.timestamp) ||
    compareCodeUnits(left.uri, right.uri)
  );
}

function compareOptionalTimestampDescending(left: string | undefined, right: string | undefined): number {
  const leftTime = left ? Date.parse(left) : Number.NaN;
  const rightTime = right ? Date.parse(right) : Number.NaN;
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
  return normalizedRight - normalizedLeft;
}

function maximumOptionalScore(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function strongestOptionalScore(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.abs(left) === Math.abs(right) ? Math.max(left, right) : Math.abs(left) > Math.abs(right) ? left : right;
}

function scoreCandidate(
  candidate: RecallCandidate,
  queryTermVariants: readonly (readonly string[])[],
  corpusStatistics: RecallCorpusStatistics,
  graphDistances: ReadonlyMap<string, {readonly distance: number; readonly weight: number}>,
  context: RecallRankContext & {readonly now: Date; readonly recencyIntent: boolean},
): RankedRecallCandidate {
  const originalQueryTerms = queryTermVariants[0] ?? [];
  const strongestVariant = (score: (queryTerms: readonly string[]) => number): number =>
    Math.max(0, ...EffectArray.map(queryTermVariants, score));
  const semantic = clamp(candidate.semantic ?? 0);
  const reranker = clamp(candidate.reranker ?? 0);
  const topicalDocumentTerms = recallTopicalDocumentTerms(candidate);
  const bm25DocumentTerms = Effect.pipe(context.workspaceScope, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  )
    ? topicalDocumentTerms
    : recallDocumentTerms(candidate);
  const bm25 = strongestVariant(queryTerms => normalizedBm25(queryTerms, bm25DocumentTerms, corpusStatistics));
  const topicalBm25 = strongestVariant(queryTerms =>
    normalizedBm25(queryTerms, topicalDocumentTerms, corpusStatistics),
  );
  const field = strongestVariant(queryTerms => fieldScore(queryTerms, candidate.fields, {includeProject: true}));
  const topicalField = strongestVariant(queryTerms =>
    fieldScore(queryTerms, candidate.fields, {includeProject: false}),
  );
  const graph = graphScore(candidate.uri, graphDistances);
  const scope = scopeScore(context.project, candidate.fields?.project);
  const branchRelationship = workspaceBranchRelationship(context.workspaceBranch, candidate);
  const branch = branchRelationship.score;
  const workspace = workspaceScopeScore(context.workspaceScope, candidate.fields?.workspaceScope);
  const kindIntent = kindIntentScore(originalQueryTerms, candidate.kind);
  const exactTerms = qualifyingExactTerms(candidate);
  const exact = strongestVariant(queryTerms =>
    exactTermScore(queryTerms, exactTerms, candidate.fields, corpusStatistics, {
      kindIntent,
    }),
  );
  const freshness = freshnessScore(candidate.timestamp, candidate.kind, context.now);
  const authority = authorityScore(candidate.authority, candidate.trust);
  const lifecycle = lifecycleScore(candidate.status);
  const temporal = temporalScore(candidate.validFrom, candidate.validTo, context.now);
  const feedback = clampSigned(candidate.feedback ?? 0);
  const signals: RecallSignals = {
    authority,
    branch,
    bm25,
    exact,
    feedback,
    field,
    freshness,
    graph,
    kindIntent,
    lifecycle,
    reranker,
    scope,
    semantic,
    temporal,
    workspace,
  };
  const focusedLexicalEvidence =
    topicalField >= LEXICAL_ONLY_FOCUSED_FIELD_MINIMUM ||
    EffectArray.some(exactTerms, term => /[\p{N}_.-]/u.test(term));
  const passedRelevanceGate =
    Math.max(semantic, reranker, topicalBm25, exact, topicalField) >= RELEVANCE_GATE_MINIMUM &&
    (semantic > SIGNAL_ABSENCE_MAXIMUM ||
      reranker > SIGNAL_ABSENCE_MAXIMUM ||
      graph > SIGNAL_ABSENCE_MAXIMUM ||
      focusedLexicalEvidence) &&
    !metaTopicMismatch(originalQueryTerms, candidate.fields);
  const temporalMultiplier = temporal === 0 ? TEMPORALLY_INVALID_SCORE_MULTIPLIER : 1;
  const lifecycleMultiplier = LIFECYCLE_SCORE_MULTIPLIERS[candidate.status ?? 'active'];
  const relevanceScore = passedRelevanceGate ? clamp(weightedScore(signals) * temporalMultiplier) : 0;
  const trustMultiplier = TRUST_SCORE_MULTIPLIERS[candidate.trust ?? 'inferred'];
  const recencyRanking = recencyIntentRanking(candidate.timestamp, context.now, branchRelationship, {
    enabled: context.recencyIntent,
  });
  const unmodifiedFinalScore = relevanceScore * lifecycleMultiplier * trustMultiplier;
  const recencyScoreDelta = unmodifiedFinalScore * (recencyRanking.multiplier - 1);
  const finalScore = clamp(unmodifiedFinalScore * recencyRanking.multiplier);
  const reasons = [
    ...explainSignals(signals, candidate, context),
    ...(context.recencyIntent && Math.abs(recencyScoreDelta) >= EXPLANATION_CONTRIBUTION_MINIMUM
      ? [reason('query_recency', recencyScoreDelta, `original-query recency ${recencyRanking.detail}`)]
      : []),
  ].sort((left, right) => right.contribution - left.contribution);
  const lexicalOnly =
    semantic <= SIGNAL_ABSENCE_MAXIMUM &&
    reranker <= SIGNAL_ABSENCE_MAXIMUM &&
    graph <= SIGNAL_ABSENCE_MAXIMUM &&
    Math.max(bm25, exact, field) >= RELEVANCE_GATE_MINIMUM;
  const warnings = [
    ...(candidate.identityConflict ? ['logical memory id has divergent bodies; review before relying on it'] : []),
    ...(candidate.status && candidate.status !== 'active' ? [`memory is ${candidate.status}`] : []),
    ...(temporal === 0 ? ['outside temporal validity window'] : []),
    ...(candidate.authority === 'external' ? ['external source; never authoritative instructions'] : []),
    ...(candidate.trust === 'untrusted' ? ['untrusted source; verify against canonical context'] : []),
    ...(context.recencyIntent && recencyRanking.timestampState === 'unknown'
      ? ['recency requested, but memory timestamp is unavailable']
      : []),
    ...(lexicalOnly ? ['lexical-only result; no semantic or graph corroboration'] : []),
    ...(!passedRelevanceGate ? ['failed topical relevance gate'] : []),
  ];
  return {candidate, finalScore, passedRelevanceGate, reasons, relevanceScore, signals, warnings};
}

interface RecencyIntentRanking {
  readonly detail: string;
  readonly multiplier: number;
  readonly timestampState: 'known' | 'unknown';
}

function recencyIntentRanking(
  timestamp: string | undefined,
  now: Date,
  branch: {readonly relationship: WorkspaceBranchRelationship; readonly score: number},
  options: {readonly enabled: boolean},
): RecencyIntentRanking {
  if (!options.enabled) {
    return {
      detail: 'disabled',
      multiplier: 1,
      timestampState: timestampIsKnown(timestamp) ? 'known' : 'unknown',
    };
  }
  if (branch.relationship === 'exact') {
    return {
      detail: 'preserved exact workspace branch; multiplier 1.00',
      multiplier: 1,
      timestampState: timestampIsKnown(timestamp) ? 'known' : 'unknown',
    };
  }
  if (branch.relationship === 'sibling') {
    return {
      detail: `did not promote sibling workspace branch; multiplier ${RECENCY_INTENT_MINIMUM_MULTIPLIER.toFixed(2)}`,
      multiplier: RECENCY_INTENT_MINIMUM_MULTIPLIER,
      timestampState: timestampIsKnown(timestamp) ? 'known' : 'unknown',
    };
  }

  const score = recencyIntentTimestampScore(timestamp, now);
  const multiplier = RECENCY_INTENT_MINIMUM_MULTIPLIER + (1 - RECENCY_INTENT_MINIMUM_MULTIPLIER) * score;
  return {
    detail: `timestamp score ${score.toFixed(2)}; multiplier ${multiplier.toFixed(2)}`,
    multiplier,
    timestampState: timestampIsKnown(timestamp) ? 'known' : 'unknown',
  };
}

function recencyIntentTimestampScore(timestamp: string | undefined, now: Date): number {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(parsed)) return UNKNOWN_RECENCY_INTENT_SCORE;
  const ageDays = Math.max(0, (now.getTime() - parsed) / MILLISECONDS_PER_DAY);
  return clamp(HALF_LIFE_DECAY_BASE ** (-ageDays / RECENCY_INTENT_HALF_LIFE_DAYS));
}

function timestampIsKnown(timestamp: string | undefined): boolean {
  return timestamp !== undefined && Number.isFinite(Date.parse(timestamp));
}

function weightedScore(signals: RecallSignals): number {
  return (
    signals.semantic * SIGNAL_WEIGHTS.semantic +
    signals.bm25 * SIGNAL_WEIGHTS.bm25 +
    signals.exact * SIGNAL_WEIGHTS.exact +
    signals.field * SIGNAL_WEIGHTS.field +
    signals.graph * SIGNAL_WEIGHTS.graph +
    signals.kindIntent * SIGNAL_WEIGHTS.kindIntent +
    signals.reranker * SIGNAL_WEIGHTS.reranker +
    signals.scope * SIGNAL_WEIGHTS.scope +
    signals.freshness * SIGNAL_WEIGHTS.freshness +
    signals.authority * SIGNAL_WEIGHTS.authority +
    (signals.branch ?? 0) * SIGNAL_WEIGHTS.branch +
    signals.lifecycle * SIGNAL_WEIGHTS.lifecycle +
    signals.temporal * SIGNAL_WEIGHTS.temporal +
    signals.workspace * SIGNAL_WEIGHTS.workspace +
    signals.feedback * SIGNAL_WEIGHTS.feedback
  );
}

function exactTermScore(
  queryTerms: readonly string[],
  exactTerms: readonly string[] | undefined,
  fields: RecallFields | undefined,
  corpusStatistics: RecallCorpusStatistics,
  context: {readonly kindIntent: number},
): number {
  if (queryTerms.length === 0 || !exactTerms || exactTerms.length === 0) {
    return 0;
  }
  const uniqueQuery = new Set(queryTerms);
  const uniqueExactTerms = [
    ...new Set(
      EffectArray.filter(
        EffectArray.map(exactTerms, term => tokenize(term)[0]),
        (term): term is string => term !== undefined,
      ),
    ),
  ];
  const declaredIdentifiers = new Set(
    EffectArray.filter(
      EffectArray.map(fields?.identifiers ?? [], identifier => tokenize(identifier)[0]),
      (identifier): identifier is string => identifier !== undefined,
    ),
  );
  const matchedTerms = EffectArray.filter(uniqueExactTerms, term => {
    const termMatchesQuery = EffectArray.some(tokenize(term), token => uniqueQuery.has(token));
    return /[\p{N}_.-]/u.test(term)
      ? uniqueQuery.has(term) || (declaredIdentifiers.has(term) && termMatchesQuery)
      : termMatchesQuery;
  });
  const matches = matchedTerms.length;
  if (matches === 0) {
    return 0;
  }
  const queryCoverage = matches / uniqueQuery.size;
  const exactPrecision = matches / uniqueExactTerms.length;
  if (matches >= EXACT_MULTI_TERM_MINIMUM && exactPrecision === 1) {
    const matchedQueryTerms = new Set(
      EffectArray.filter(EffectArray.flatMap(matchedTerms, tokenize), term => uniqueQuery.has(term)),
    );
    const totalQueryWeight = EffectArray.reduce(
      [...uniqueQuery],
      0,
      (total, term) => total + inverseDocumentFrequency(term, corpusStatistics),
    );
    const matchedQueryWeight = EffectArray.reduce(
      [...matchedQueryTerms],
      0,
      (total, term) => total + inverseDocumentFrequency(term, corpusStatistics),
    );
    const idfWeightedCoverage = totalQueryWeight === 0 ? queryCoverage : matchedQueryWeight / totalQueryWeight;
    return clamp(
      Math.max(
        EXACT_TERM_RESCUE_MINIMUM,
        EXACT_MULTI_TERM_BASE_SCORE + idfWeightedCoverage * EXACT_MULTI_TERM_IDF_COVERAGE_WEIGHT,
      ),
    );
  }
  if (matches === 1 && exactPrecision === 1 && /[\p{N}_.-]/u.test(matchedTerms[0] ?? '')) {
    return EXACT_IDENTIFIER_SCORE;
  }
  if (
    matches === 1 &&
    exactPrecision === 1 &&
    context.kindIntent === 1 &&
    focusedFieldContainsTerm(fields, matchedTerms[0] ?? '')
  ) {
    return EXACT_CONTEXTUAL_TERM_SCORE;
  }
  return queryCoverage * exactPrecision;
}

function focusedFieldContainsTerm(fields: RecallFields | undefined, term: string): boolean {
  if (!fields || term.length === 0) {
    return false;
  }
  const focusedTerms = new Set(
    EffectArray.flatMap(
      EffectArray.filter(
        [fields.title, fields.topic, ...(fields.keywords ?? []), ...(fields.identifiers ?? [])],
        (value): value is string => typeof value === 'string',
      ),
      tokenize,
    ),
  );
  return EffectArray.some(tokenize(term), token => focusedTerms.has(token));
}

function metaTopicMismatch(queryTerms: readonly string[], fields: RecallFields | undefined): boolean {
  if (!fields || EffectArray.some(queryTerms, term => META_QUERY_INTENT_TERMS.has(term))) {
    return false;
  }
  const topicTerms = tokenize([fields.title ?? '', fields.topic ?? '']);
  return EffectArray.some(topicTerms, term => META_TOPIC_TERMS.has(term));
}

function normalizedBm25(
  queryTerms: readonly string[],
  documentTerms: readonly string[],
  corpusStatistics: RecallCorpusStatistics,
): number {
  if (queryTerms.length === 0 || documentTerms.length === 0) {
    return 0;
  }
  const termFrequency = new Map<string, number>();
  for (const term of documentTerms) {
    termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
  }
  let score = 0;
  let maximum = 0;
  for (const term of new Set(queryTerms)) {
    const frequency = termFrequency.get(term) ?? 0;
    const idf = inverseDocumentFrequency(term, corpusStatistics);
    maximum += idf * (BM25_SATURATION + 1);
    if (frequency === 0) {
      continue;
    }
    const denominator =
      frequency +
      BM25_SATURATION *
        (1 -
          BM25_LENGTH_NORMALIZATION +
          BM25_LENGTH_NORMALIZATION * (documentTerms.length / Math.max(1, corpusStatistics.averageDocumentLength)));
    score += idf * ((frequency * (BM25_SATURATION + 1)) / denominator);
  }
  return maximum === 0 ? 0 : clamp(score / maximum);
}

function inverseDocumentFrequency(term: string, corpusStatistics: RecallCorpusStatistics): number {
  const documentCount = Math.max(1, corpusStatistics.documentCount);
  const documentsWithTerm = EffectRecord.has(corpusStatistics.documentFrequency, term)
    ? (corpusStatistics.documentFrequency[term] ?? 0)
    : 0;
  return Math.log(
    1 + (documentCount - documentsWithTerm + BM25_IDF_SMOOTHING) / (documentsWithTerm + BM25_IDF_SMOOTHING),
  );
}

function fieldScore(
  queryTerms: readonly string[],
  fields: RecallFields | undefined,
  options: {readonly includeProject: boolean},
): number {
  if (queryTerms.length === 0 || !fields) {
    return 0;
  }
  const uniqueQuery = new Set(queryTerms);
  const coverage = (
    value: string | readonly string[] | undefined,
    options: {readonly rewardExactSubset: boolean},
  ): number => {
    const terms = new Set(tokenize(value ?? ''));
    if (terms.size === 0) {
      return 0;
    }
    const matches = EffectArray.filter([...uniqueQuery], term => terms.has(term)).length;
    const queryCoverage = matches / uniqueQuery.size;
    const valuePrecision = matches / terms.size;
    const exactSubsetBonus =
      options.rewardExactSubset && matches === terms.size && matches > 0 ? FIELD_EXACT_SUBSET_BONUS : 0;
    return clamp(
      queryCoverage * FIELD_QUERY_COVERAGE_WEIGHT + valuePrecision * FIELD_VALUE_PRECISION_WEIGHT + exactSubsetBonus,
    );
  };
  const keywordCoverage = Math.max(
    0,
    ...EffectArray.map(fields.keywords ?? [], keyword => coverage(keyword, {rewardExactSubset: true})),
  );
  return clamp(
    coverage(fields.title, {rewardExactSubset: true}) * FIELD_WEIGHTS.title +
      coverage(fields.topic, {rewardExactSubset: true}) * FIELD_WEIGHTS.topic +
      (options.includeProject ? coverage(fields.project, {rewardExactSubset: false}) * FIELD_WEIGHTS.project : 0) +
      keywordCoverage * FIELD_WEIGHTS.keywords +
      coverage(fields.identifiers, {rewardExactSubset: true}) * FIELD_WEIGHTS.identifiers,
  );
}

function kindIntentScore(queryTerms: readonly string[], kind: MemoryKind | undefined): number {
  const requestedKinds = EffectArray.filter(
    ['durable', 'handoff', 'incident', 'preference', 'smoke'] as const,
    candidateKind => EffectArray.some(queryTerms, term => MEMORY_KIND_INTENT_TERMS[candidateKind].has(term)),
  );
  if (requestedKinds.length === 0) {
    return 0;
  }
  return kind !== undefined && requestedKinds.includes(kind) ? 1 : 0;
}

function typedGraphDistances(
  candidates: readonly RecallCandidate[],
  seeds: readonly string[],
): ReadonlyMap<string, {readonly distance: number; readonly weight: number}> {
  if (seeds.length === 0) {
    return new Map();
  }
  const adjacency = new Map<string, Array<{readonly target: string; readonly weight: number}>>();
  const addEdge = (source: string, target: string, weight: number): void => {
    const edges = adjacency.get(source);
    if (edges) {
      edges.push({target, weight});
    } else {
      adjacency.set(source, [{target, weight}]);
    }
  };
  for (const candidate of candidates) {
    for (const relation of candidate.relations ?? []) {
      const weight = RELATION_WEIGHTS[relation.type];
      addEdge(candidate.uri, relation.uri, weight);
      addEdge(relation.uri, candidate.uri, weight);
    }
  }
  const sameIdentity = new Map<string, RecallCandidate[]>();
  for (const candidate of candidates) {
    const project = Effect.pipe(
      candidate.fields?.project,
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
    );
    const topic = Effect.pipe(
      candidate.fields?.topic,
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
    );
    if (!project || !topic) {
      continue;
    }
    const key = `${project}\n${topic}`;
    const group = sameIdentity.get(key);
    if (group) {
      group.push(candidate);
    } else {
      sameIdentity.set(key, [candidate]);
    }
  }
  for (const [identity, related] of sameIdentity) {
    const identityNode = `${IDENTITY_GRAPH_NODE_PREFIX}${identity}`;
    for (const candidate of related) {
      addEdge(candidate.uri, identityNode, SAME_IDENTITY_EDGE_WEIGHT);
      addEdge(identityNode, candidate.uri, SAME_IDENTITY_EDGE_WEIGHT);
    }
  }
  const distances = new Map<string, {distance: number; weight: number}>();
  const queue = EffectArray.map(seeds, uri => ({distance: 0, uri, weight: 1}));
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (!current || current.distance > MAX_GRAPH_DISTANCE) {
      continue;
    }
    const previous = distances.get(current.uri);
    if (previous && (previous.distance < current.distance || previous.weight >= current.weight)) {
      continue;
    }
    distances.set(current.uri, {distance: current.distance, weight: current.weight});
    for (const edge of adjacency.get(current.uri) ?? []) {
      queue.push({
        distance: current.distance + 1,
        uri: edge.target,
        weight: current.weight * edge.weight,
      });
    }
  }
  return distances;
}

function graphScore(
  uri: string,
  distances: ReadonlyMap<string, {readonly distance: number; readonly weight: number}>,
): number {
  const graph = distances.get(uri);
  return graph && graph.distance > 0 ? clamp(graph.weight / (1 + graph.distance * GRAPH_DISTANCE_PENALTY)) : 0;
}

function mergeGraphDistances(
  explicit: ReadonlyMap<string, {readonly distance: number; readonly weight: number}>,
  semantic: ReadonlyMap<string, {readonly distance: number; readonly weight: number}>,
  explicitSeeds: ReadonlySet<string>,
): ReadonlyMap<string, {readonly distance: number; readonly weight: number}> {
  const merged = new Map(explicit);
  for (const [uri, semanticDistance] of semantic) {
    const explicitDistance = explicit.get(uri);
    if (explicitSeeds.has(uri) || graphScore(uri, explicit) >= graphScore(uri, semantic)) {
      if (explicitDistance) merged.set(uri, explicitDistance);
      continue;
    }
    merged.set(uri, semanticDistance);
  }
  return merged;
}

function freshnessScore(timestamp: string | undefined, kind: MemoryKind | undefined, now: Date): number {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return UNKNOWN_FRESHNESS_SCORE;
  }
  const ageDays = Math.max(0, (now.getTime() - parsed) / MILLISECONDS_PER_DAY);
  const halfLifeDays = FRESHNESS_HALF_LIFE_DAYS[kind ?? 'durable'];
  return clamp(HALF_LIFE_DECAY_BASE ** (-ageDays / halfLifeDays));
}

function temporalScore(validFrom: string | undefined, validTo: string | undefined, now: Date): number {
  const nowMs = now.getTime();
  const fromMs = validFrom ? Date.parse(validFrom) : Number.NaN;
  const toMs = validTo ? Date.parse(validTo) : Number.NaN;
  if (Number.isFinite(fromMs) && nowMs < fromMs) {
    return 0;
  }
  if (Number.isFinite(toMs) && nowMs > toMs) {
    return 0;
  }
  return 1;
}

function authorityScore(authority: MemoryAuthority | undefined, trust: MemoryTrust | undefined): number {
  const authorityValue = authority ? AUTHORITY_SCORES[authority] : UNKNOWN_AUTHORITY_SCORE;
  const trustValue = trust ? TRUST_SCORES[trust] : UNKNOWN_TRUST_SCORE;
  return authorityValue * AUTHORITY_BLEND_WEIGHT + trustValue * TRUST_BLEND_WEIGHT;
}

function lifecycleScore(status: MemoryStatus | undefined): number {
  return status ? LIFECYCLE_SCORES[status] : LIFECYCLE_SCORES.active;
}

function scopeScore(currentProject: string | undefined, project: string | undefined): number {
  if (!currentProject || !project) {
    return UNKNOWN_SCOPE_SCORE;
  }
  return Effect.pipe(currentProject, EffectString.toLowerCase) === Effect.pipe(project, EffectString.toLowerCase)
    ? 1
    : 0;
}

type WorkspaceScopeRelationship = 'ancestor' | 'exact' | 'repo-wide' | 'sibling' | 'unavailable';

type WorkspaceBranchRelationship = 'exact' | 'neutral' | 'sibling' | 'unavailable';

function workspaceBranchRelationship(
  currentWorkspaceBranch: string | undefined,
  candidate: RecallCandidate,
): {readonly relationship: WorkspaceBranchRelationship; readonly score: number} {
  const current = normalizeWorkspaceBranch(currentWorkspaceBranch);
  if (!current || candidate.kind !== 'handoff') return {relationship: 'unavailable', score: 0};
  const branchLine = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      Effect.pipe(candidate.text, EffectString.split(/\r?\n/u)),
      line =>
        Effect.pipe(line, __effectPipeInput => {
          const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.slice(0, 'branch:'.length));
          const __effectPipeStage1 = Effect.pipe(__effectPipeStage0, EffectString.toLowerCase);
          return __effectPipeStage1;
        }) === 'branch:',
    ),
  );
  const recorded = normalizeWorkspaceBranch(
    Effect.pipe(
      branchLine,
      effectOptionalString =>
        effectOptionalString == null
          ? undefined
          : Effect.pipe(effectOptionalString, EffectString.slice('branch:'.length)),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
    ),
  );
  if (!recorded || recorded === 'current' || recorded === 'unknown') {
    return {relationship: 'neutral', score: 0.5};
  }
  return recorded === current ? {relationship: 'exact', score: 1} : {relationship: 'sibling', score: 0.25};
}

export function recallCandidateMatchesWorkspaceBranch(
  currentWorkspaceBranch: string,
  candidate: RecallCandidate,
): boolean {
  return workspaceBranchRelationship(currentWorkspaceBranch, candidate).relationship === 'exact';
}

function normalizeWorkspaceBranch(branch: string | undefined): string | undefined {
  return (
    Effect.pipe(
      branch,
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      effectOptionalString =>
        effectOptionalString == null
          ? undefined
          : Effect.pipe(effectOptionalString, EffectString.replaceAll('\\', '/')),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
    ) || undefined
  );
}

function workspaceScopeRelationship(
  currentWorkspaceScope: string | undefined,
  candidateWorkspaceScope: string | undefined,
): {readonly relationship: WorkspaceScopeRelationship; readonly score: number} {
  const current = normalizeWorkspaceScope(currentWorkspaceScope);
  if (!current) return {relationship: 'unavailable', score: 0};
  const candidate = normalizeWorkspaceScope(candidateWorkspaceScope);
  if (!candidate) return {relationship: 'repo-wide', score: 0.5};
  if (candidate === current) return {relationship: 'exact', score: 1};
  if (Effect.pipe(current, EffectString.startsWith(`${candidate}/`))) return {relationship: 'ancestor', score: 0.75};
  return {relationship: 'sibling', score: 0.25};
}

function workspaceScopeScore(currentWorkspaceScope: string | undefined, candidateWorkspaceScope: string | undefined) {
  return workspaceScopeRelationship(currentWorkspaceScope, candidateWorkspaceScope).score;
}

function normalizeWorkspaceScope(scope: string | undefined): string | undefined {
  const normalized = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(scope), value =>
      Effect.pipe(
        EffectArray.join(
          EffectArray.filter(
            Effect.pipe(value, EffectString.trim, EffectString.replaceAll('\\', '/'), EffectString.split('/')),
            segment => segment.length > 0 && segment !== '.',
          ),
          '/',
        ),
        EffectString.toLowerCase,
      ),
    ),
  );
  return normalized || undefined;
}

function explainSignals(
  signals: RecallSignals,
  candidate: RecallCandidate,
  context: RecallRankContext,
): readonly RecallReason[] {
  const reasons: RecallReason[] = [
    reason(
      'native_reranker',
      signals.reranker * SIGNAL_WEIGHTS.reranker,
      `native reranker score ${signals.reranker.toFixed(2)}`,
    ),
    reason(
      'semantic_similarity',
      signals.semantic * SIGNAL_WEIGHTS.semantic,
      `semantic similarity ${signals.semantic.toFixed(2)}`,
    ),
    reason('bm25_lexical', signals.bm25 * SIGNAL_WEIGHTS.bm25, `BM25/IDF lexical score ${signals.bm25.toFixed(2)}`),
    reason(
      'exact_term_match',
      signals.exact * SIGNAL_WEIGHTS.exact,
      `exact-term corroboration ${signals.exact.toFixed(2)}`,
    ),
    reason(
      'field_match',
      signals.field * SIGNAL_WEIGHTS.field,
      `title/topic/project/identifier score ${signals.field.toFixed(2)}`,
    ),
    reason(
      'graph_proximity',
      signals.graph * SIGNAL_WEIGHTS.graph,
      `typed graph proximity ${signals.graph.toFixed(2)}`,
    ),
    reason(
      'memory_kind_intent',
      signals.kindIntent * SIGNAL_WEIGHTS.kindIntent,
      `memory-kind intent ${signals.kindIntent.toFixed(2)}`,
    ),
    reason('freshness', signals.freshness * SIGNAL_WEIGHTS.freshness, `recency score ${signals.freshness.toFixed(2)}`),
    reason(
      'authority_trust',
      signals.authority * SIGNAL_WEIGHTS.authority,
      `authority/trust score ${signals.authority.toFixed(2)}`,
    ),
    reason(
      'lifecycle',
      signals.lifecycle * SIGNAL_WEIGHTS.lifecycle,
      `lifecycle score ${signals.lifecycle.toFixed(2)}`,
    ),
    reason(
      'temporal_validity',
      signals.temporal * SIGNAL_WEIGHTS.temporal,
      `temporal validity ${signals.temporal.toFixed(2)}`,
    ),
    reason(
      'user_feedback',
      signals.feedback * SIGNAL_WEIGHTS.feedback,
      `bounded user feedback ${signals.feedback.toFixed(2)}`,
    ),
  ];
  if (context.project && candidate.fields?.project) {
    reasons.push(
      reason('project_scope', signals.scope * SIGNAL_WEIGHTS.scope, `project scope ${signals.scope.toFixed(2)}`),
    );
  }
  const branchRelationship = workspaceBranchRelationship(context.workspaceBranch, candidate);
  if (branchRelationship.relationship !== 'unavailable') {
    reasons.push(
      reason(
        'workspace_branch',
        (signals.branch ?? 0) * SIGNAL_WEIGHTS.branch,
        `workspace branch ${branchRelationship.relationship} ${(signals.branch ?? 0).toFixed(2)}`,
      ),
    );
  }
  const workspaceRelationship = workspaceScopeRelationship(context.workspaceScope, candidate.fields?.workspaceScope);
  if (workspaceRelationship.relationship !== 'unavailable') {
    reasons.push(
      reason(
        'workspace_scope',
        signals.workspace * SIGNAL_WEIGHTS.workspace,
        `workspace scope ${workspaceRelationship.relationship} ${signals.workspace.toFixed(2)}`,
      ),
    );
  }
  return EffectArray.filter(reasons, item => Math.abs(item.contribution) >= EXPLANATION_CONTRIBUTION_MINIMUM).sort(
    (left, right) => right.contribution - left.contribution,
  );
}

function reason(code: string, contribution: number, detail: string): RecallReason {
  return {code, contribution, detail};
}

function assessConfidence(
  results: readonly RankedRecallCandidate[],
  originalQuery: string,
  originalQueryTerms: readonly string[],
): RecallConfidence {
  const first = results[0]?.relevanceScore ?? 0;
  const second = results[1]?.relevanceScore ?? 0;
  const margin = Math.max(0, first - second);
  const topSignals = results[0]?.signals;
  const exactDistinctiveIdentifier = results[0]
    ? hasExactDistinctiveIdentifierMatch(originalQuery, originalQueryTerms, results[0].candidate.fields)
    : false;
  const corroboratingSignals = results[0]
    ? EffectArray.filter(
        [
          results[0].signals.semantic,
          results[0].signals.bm25,
          results[0].signals.exact,
          results[0].signals.field,
          results[0].signals.graph,
        ],
        signal => signal >= CORROBORATING_SIGNAL_MINIMUM,
      ).length
    : 0;
  const weakLexicalOnly =
    topSignals !== undefined &&
    topSignals.semantic <= SIGNAL_ABSENCE_MAXIMUM &&
    topSignals.graph <= SIGNAL_ABSENCE_MAXIMUM &&
    Math.max(topSignals.bm25, topSignals.exact, topSignals.field) < LEXICAL_ONLY_ANSWER_MINIMUM &&
    !exactDistinctiveIdentifier;
  const weakSemanticOnly =
    topSignals !== undefined &&
    topSignals.semantic > SIGNAL_ABSENCE_MAXIMUM &&
    topSignals.reranker <= SIGNAL_ABSENCE_MAXIMUM &&
    Math.max(topSignals.bm25, topSignals.exact, topSignals.field) < CORROBORATING_SIGNAL_MINIMUM &&
    first < SEMANTIC_ONLY_ANSWER_MINIMUM;
  if (results.length === 0 || first < NO_ANSWER_SCORE_MINIMUM || weakLexicalOnly || weakSemanticOnly) {
    return {
      level: 'no_answer',
      margin,
      reason: 'No candidate passed the minimum combined relevance threshold.',
      score: first,
    };
  }
  if (
    first >= HIGH_CONFIDENCE_SCORE_MINIMUM &&
    (margin >= HIGH_CONFIDENCE_MARGIN_MINIMUM || corroboratingSignals >= HIGH_CONFIDENCE_SIGNAL_COUNT)
  ) {
    return {level: 'high', margin, reason: 'Strong top score with corroborating retrieval signals.', score: first};
  }
  if (first >= MEDIUM_CONFIDENCE_SCORE_MINIMUM && corroboratingSignals >= MEDIUM_CONFIDENCE_SIGNAL_COUNT) {
    return {level: 'medium', margin, reason: 'Useful match, but ranking evidence is not decisive.', score: first};
  }
  return {level: 'low', margin, reason: 'Only weak or single-signal evidence supports the top result.', score: first};
}

function hasExactDistinctiveIdentifierMatch(
  originalQuery: string,
  queryTerms: readonly string[],
  fields: RecallFields | undefined,
): boolean {
  if (!fields?.identifiers?.length) {
    return false;
  }
  const identifiers = new Set(
    EffectArray.filter(
      EffectArray.map(fields.identifiers, identifier => tokenize(identifier)[0]),
      (identifier): identifier is string => identifier !== undefined,
    ),
  );
  return (
    EffectArray.some(queryTerms, term => /[\p{N}_.-]/u.test(term) && identifiers.has(term)) ||
    hasExactCasedCodeIdentifierMatch(originalQuery, fields.identifiers)
  );
}

export function recallDocumentTerms(candidate: RecallCandidate): readonly string[] {
  return tokenize(
    EffectArray.join(
      EffectArray.filter(
        [
          candidate.text,
          candidate.fields?.title,
          candidate.fields?.topic,
          candidate.fields?.project,
          candidate.fields?.workspaceScope,
          ...(candidate.fields?.keywords ?? []),
          ...(candidate.fields?.identifiers ?? []),
        ],
        (value): value is string => typeof value === 'string',
      ),
      ' ',
    ),
  );
}

function recallTopicalDocumentTerms(candidate: RecallCandidate): readonly string[] {
  return tokenize(
    EffectArray.join(
      EffectArray.filter(
        [
          candidate.text,
          candidate.fields?.title,
          candidate.fields?.topic,
          ...(candidate.fields?.keywords ?? []),
          ...(candidate.fields?.identifiers ?? []),
        ],
        (value): value is string => typeof value === 'string',
      ),
      ' ',
    ),
  );
}

function qualifyingExactTerms(candidate: RecallCandidate): readonly string[] {
  const topicalTerms = new Set(recallTopicalDocumentTerms(candidate));
  const projectTerms = new Set(tokenize(candidate.fields?.project ?? ''));
  const kindIntentTerms = candidate.kind ? MEMORY_KIND_INTENT_TERMS[candidate.kind] : undefined;
  const exactTerms = candidate.exactTerms ?? [];
  return EffectArray.filter(exactTerms, (term, __effectArrayIndex) => {
    if (!(__effectArrayIndex in exactTerms)) return false;
    const normalized = tokenize(term)[0];
    return (
      normalized !== undefined &&
      topicalTerms.has(normalized) &&
      !projectTerms.has(normalized) &&
      kindIntentTerms?.has(normalized) !== true
    );
  });
}

export function buildRecallCorpusStatistics(candidates: readonly RecallCandidate[]): RecallCorpusStatistics {
  return recallCorpusStatistics(EffectArray.map(candidates, candidate => recallDocumentTerms(candidate)));
}

/** Ranking-only corpus statistics exclude structural project/workspace postings. */
export function buildRecallTopicalCorpusStatistics(candidates: readonly RecallCandidate[]): RecallCorpusStatistics {
  const logicalCandidates = deduplicateLogicalRecallCandidates(candidates);
  return recallCorpusStatistics(EffectArray.map(logicalCandidates, candidate => recallTopicalDocumentTerms(candidate)));
}

function recallCorpusStatistics(corpus: readonly (readonly string[])[]): RecallCorpusStatistics {
  const frequencies = new Map<string, number>();
  for (const terms of corpus) {
    for (const term of new Set(terms)) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  const totalDocumentLength = EffectArray.reduce(corpus, 0, (sum, terms) => sum + terms.length);
  return {
    averageDocumentLength: corpus.length === 0 ? 1 : totalDocumentLength / corpus.length,
    documentCount: corpus.length,
    documentFrequency: EffectRecord.fromEntries(frequencies),
    totalDocumentLength,
  };
}

function tokenize(value: string | readonly string[]): readonly string[] {
  const text = typeof value === 'string' ? value : EffectArray.join(value, ' ');
  return recallLexicalTerms(text);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
