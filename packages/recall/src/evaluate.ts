import {Array as EffectArray, Option as EffectOption} from 'effect';
import {deriveRecallEligibilityPolicy} from './eligibility.js';
import {isExternalResourceMetadata} from '@threadnote/store/external-resource';
import {isMemoryRelationType} from '@threadnote/memory/document';
import {isOneOf} from '@threadnote/platform/validation';
import {rankRecallCandidates, shouldExpandRecall, type RecallCandidate, type RecallConfidenceLevel} from './rank.js';
import * as EffectRecord from 'effect/Record';

export interface RecallEvaluationQuery {
  readonly expandedSemanticScores?: Readonly<Record<string, number>>;
  readonly expectedAnswerability: 'answerable' | 'no_answer';
  readonly expectedExpansion?: boolean;
  readonly forbiddenUris?: readonly string[];
  readonly id: string;
  readonly now?: string;
  readonly project?: string;
  readonly query: string;
  readonly relevance: Readonly<Record<string, number>>;
  readonly requiredReasonCodes?: readonly string[];
  readonly seedUris?: readonly string[];
  readonly semanticScores?: Readonly<Record<string, number>>;
}

export interface RecallEvaluationFixture {
  readonly documents: readonly RecallCandidate[];
  readonly queries: readonly RecallEvaluationQuery[];
  readonly version: 1;
}

export interface RecallEvaluationMetrics {
  readonly averageContextTokens: number;
  readonly meanNdcgAt5: number;
  readonly meanReciprocalRank: number;
  readonly noAnswerPrecision: number;
  readonly noAnswerRecall: number;
  readonly recallAt5: number;
  readonly requiredReasonsPresent: boolean;
  readonly staleHitRate: number;
}

export interface RecallEvaluationResult {
  readonly failures: readonly string[];
  readonly metrics: RecallEvaluationMetrics;
  readonly queryResults: readonly {
    readonly confidence: RecallConfidenceLevel;
    readonly expanded: boolean;
    readonly id: string;
    readonly initialConfidence: RecallConfidenceLevel;
    readonly rankedUris: readonly string[];
  }[];
  readonly version: 1;
}

const EVALUATION_CUTOFF = 5;
const ESTIMATED_CHARACTERS_PER_TOKEN = 4;

export function evaluateRecallFixture(fixture: RecallEvaluationFixture): RecallEvaluationResult {
  const failures: string[] = [];
  const ndcgScores: number[] = [];
  const reciprocalRanks: number[] = [];
  let relevantExpected = 0;
  let relevantFound = 0;
  let forbiddenHits = 0;
  let returnedHits = 0;
  let predictedNoAnswer = 0;
  let expectedNoAnswer = 0;
  let correctNoAnswer = 0;
  let contextTokens = 0;
  let requiredReasonsPresent = true;
  const queryResults: Array<{
    readonly confidence: RecallConfidenceLevel;
    readonly expanded: boolean;
    readonly id: string;
    readonly initialConfidence: RecallConfidenceLevel;
    readonly rankedUris: readonly string[];
  }> = [];

  for (const query of fixture.queries) {
    const rankWithSemanticScores = (semanticScores: Readonly<Record<string, number>>) =>
      rankRecallCandidates(
        query.query,
        EffectArray.map(fixture.documents, document => ({
          ...document,
          semantic: semanticScores[document.uri] ?? 0,
        })),
        {
          eligibility: deriveRecallEligibilityPolicy({
            explicitProject: query.project,
            originalQuery: query.query,
          }),
          now: query.now ? new Date(query.now) : undefined,
          project: query.project,
          seedUris: query.seedUris,
        },
      );
    const initial = rankWithSemanticScores(query.semanticScores ?? {});
    const expanded =
      shouldExpandRecall(initial.confidence) &&
      query.expandedSemanticScores !== undefined &&
      EffectRecord.keys(query.expandedSemanticScores).length > 0;
    const ranked = expanded
      ? rankWithSemanticScores(
          EffectRecord.fromEntries(
            EffectArray.map(fixture.documents, document => [
              document.uri,
              Math.max(query.semanticScores?.[document.uri] ?? 0, query.expandedSemanticScores?.[document.uri] ?? 0),
            ]),
          ),
        )
      : initial;
    const top = ranked.results.slice(0, EVALUATION_CUTOFF);
    const rankedUris = EffectArray.map(top, result => result.candidate.uri);
    queryResults.push({
      confidence: ranked.confidence.level,
      expanded,
      id: query.id,
      initialConfidence: initial.confidence.level,
      rankedUris,
    });
    if (query.expectedExpansion !== undefined && expanded !== query.expectedExpansion) {
      failures.push(`${query.id}: expected expansion ${query.expectedExpansion}, got ${expanded}`);
    }
    const relevantUris = EffectArray.map(
      EffectArray.filter(EffectRecord.toEntries(query.relevance), ([, grade]) => grade > 0),
      ([uri]) => uri,
    );
    relevantExpected += relevantUris.length;
    relevantFound += EffectArray.filter(relevantUris, uri => rankedUris.includes(uri)).length;
    const firstRelevantRank = EffectOption.getOrElse(
      EffectArray.findFirstIndex(rankedUris, uri => (query.relevance[uri] ?? 0) > 0),
      () => -1,
    );
    if (query.expectedAnswerability === 'answerable') {
      reciprocalRanks.push(firstRelevantRank === -1 ? 0 : 1 / (firstRelevantRank + 1));
    }
    ndcgScores.push(ndcgAtCutoff(rankedUris, query.relevance, EVALUATION_CUTOFF));
    forbiddenHits += EffectArray.filter(rankedUris, uri => query.forbiddenUris?.includes(uri) === true).length;
    returnedHits += rankedUris.length;
    contextTokens += Math.ceil(
      EffectArray.reduce(top, 0, (characters, result) => characters + result.candidate.text.length) /
        ESTIMATED_CHARACTERS_PER_TOKEN,
    );

    const predicted = ranked.confidence.level === 'no_answer';
    const expected = query.expectedAnswerability === 'no_answer';
    predictedNoAnswer += predicted ? 1 : 0;
    expectedNoAnswer += expected ? 1 : 0;
    correctNoAnswer += predicted && expected ? 1 : 0;
    if (predicted !== expected) {
      failures.push(`${query.id}: expected ${query.expectedAnswerability}, got confidence ${ranked.confidence.level}`);
    }

    const topReasons = top[0]?.reasons ?? [];
    const topReasonCodes = new Set(EffectArray.map(topReasons, reason => reason.code));
    for (const code of query.requiredReasonCodes ?? []) {
      if (!topReasonCodes.has(code)) {
        requiredReasonsPresent = false;
        failures.push(`${query.id}: top result is missing required reason ${code}`);
      }
    }
    for (const uri of query.forbiddenUris ?? []) {
      if (rankedUris.includes(uri)) {
        failures.push(`${query.id}: forbidden stale or wrong-scope result surfaced: ${uri}`);
      }
    }
  }

  const queryCount = fixture.queries.length;
  return {
    failures,
    metrics: {
      averageContextTokens: queryCount === 0 ? 0 : contextTokens / queryCount,
      meanNdcgAt5: mean(ndcgScores),
      meanReciprocalRank: mean(reciprocalRanks),
      noAnswerPrecision: predictedNoAnswer === 0 ? 1 : correctNoAnswer / predictedNoAnswer,
      noAnswerRecall: expectedNoAnswer === 0 ? 1 : correctNoAnswer / expectedNoAnswer,
      recallAt5: relevantExpected === 0 ? 1 : relevantFound / relevantExpected,
      requiredReasonsPresent,
      staleHitRate: returnedHits === 0 ? 0 : forbiddenHits / returnedHits,
    },
    queryResults,
    version: 1,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function hasOptionalField(
  value: Record<string, unknown>,
  key: string,
  predicate: (field: unknown) => boolean,
): boolean {
  return !(key in value) || value[key] === undefined || predicate(value[key]);
}

function isStringArray(value: unknown): value is readonly string[] {
  return EffectArray.isArray(value) && EffectArray.every(value, (item: unknown) => typeof item === 'string');
}

function isStringNumberRecord(value: unknown): value is Readonly<Record<string, number>> {
  return (
    isRecord(value) &&
    EffectArray.every(EffectRecord.toEntries(value), ([, item]) => typeof item === 'number' && Number.isFinite(item))
  );
}

function isRecallFields(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasOptionalField(value, 'identifiers', isStringArray) &&
    hasOptionalField(value, 'keywords', isStringArray) &&
    hasOptionalField(value, 'project', field => typeof field === 'string') &&
    hasOptionalField(value, 'title', field => typeof field === 'string') &&
    hasOptionalField(value, 'topic', field => typeof field === 'string') &&
    hasOptionalField(value, 'workspaceScope', field => typeof field === 'string')
  );
}

function isRecallCandidate(value: unknown): value is RecallCandidate {
  if (!isRecord(value) || typeof value.text !== 'string' || typeof value.uri !== 'string') return false;
  return (
    hasOptionalField(value, 'authority', field =>
      isOneOf(['agent_generated', 'canonical_repo', 'external', 'reviewed_shared', 'user_approved'], field),
    ) &&
    hasOptionalField(value, 'contentHash', field => typeof field === 'string') &&
    hasOptionalField(value, 'equivalentUris', isStringArray) &&
    hasOptionalField(value, 'exactTerms', isStringArray) &&
    hasOptionalField(
      value,
      'externalSource',
      field =>
        isRecord(field) &&
        isExternalResourceMetadata(field) &&
        'fetchedAt' in field &&
        typeof field.fetchedAt === 'number' &&
        Number.isFinite(field.fetchedAt),
    ) &&
    hasOptionalField(value, 'feedback', field => typeof field === 'number' && Number.isFinite(field)) &&
    hasOptionalField(value, 'fields', isRecallFields) &&
    hasOptionalField(value, 'identityConflict', field => typeof field === 'boolean') &&
    hasOptionalField(value, 'kind', field =>
      isOneOf(['durable', 'handoff', 'incident', 'preference', 'smoke'], field),
    ) &&
    hasOptionalField(value, 'memoryId', field => typeof field === 'string') &&
    hasOptionalField(
      value,
      'relations',
      field =>
        EffectArray.isArray(field) &&
        EffectArray.every(
          field,
          (relation: unknown) =>
            isRecord(relation) &&
            'type' in relation &&
            typeof relation.type === 'string' &&
            isMemoryRelationType(relation.type) &&
            'uri' in relation &&
            typeof relation.uri === 'string',
        ),
    ) &&
    hasOptionalField(value, 'reranker', field => typeof field === 'number' && Number.isFinite(field)) &&
    hasOptionalField(value, 'semantic', field => typeof field === 'number' && Number.isFinite(field)) &&
    hasOptionalField(value, 'status', field => isOneOf(['active', 'archived', 'expired', 'superseded'], field)) &&
    hasOptionalField(value, 'timestamp', field => typeof field === 'string') &&
    hasOptionalField(value, 'trust', field => isOneOf(['approved', 'inferred', 'untrusted'], field)) &&
    hasOptionalField(value, 'validFrom', field => typeof field === 'string') &&
    hasOptionalField(value, 'validTo', field => typeof field === 'string')
  );
}

function isRecallEvaluationQuery(value: unknown): value is RecallEvaluationQuery {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.query !== 'string' ||
    (value.expectedAnswerability !== 'answerable' && value.expectedAnswerability !== 'no_answer') ||
    !isStringNumberRecord(value.relevance)
  )
    return false;
  return (
    hasOptionalField(value, 'expandedSemanticScores', isStringNumberRecord) &&
    hasOptionalField(value, 'expectedExpansion', field => typeof field === 'boolean') &&
    hasOptionalField(value, 'forbiddenUris', isStringArray) &&
    hasOptionalField(value, 'now', field => typeof field === 'string') &&
    hasOptionalField(value, 'project', field => typeof field === 'string') &&
    hasOptionalField(value, 'requiredReasonCodes', isStringArray) &&
    hasOptionalField(value, 'seedUris', isStringArray) &&
    hasOptionalField(value, 'semanticScores', isStringNumberRecord)
  );
}

function isRecallEvaluationFixture(value: unknown): value is RecallEvaluationFixture {
  return (
    isRecord(value) &&
    value.version === 1 &&
    EffectArray.isArray(value.documents) &&
    EffectArray.every(value.documents, isRecallCandidate) &&
    EffectArray.isArray(value.queries) &&
    EffectArray.every(value.queries, isRecallEvaluationQuery)
  );
}

export function parseRecallEvaluationFixture(value: unknown): RecallEvaluationFixture {
  if (!isRecallEvaluationFixture(value))
    throw new Error('Expected a recall evaluation fixture with version 1, documents, and queries.');
  return value;
}

function ndcgAtCutoff(
  rankedUris: readonly string[],
  relevance: Readonly<Record<string, number>>,
  cutoff: number,
): number {
  const actual = discountedCumulativeGain(EffectArray.map(rankedUris.slice(0, cutoff), uri => relevance[uri] ?? 0));
  const ideal = discountedCumulativeGain(
    EffectRecord.values(relevance)
      .sort((left, right) => right - left)
      .slice(0, cutoff),
  );
  return ideal === 0 ? 1 : actual / ideal;
}

function discountedCumulativeGain(grades: readonly number[]): number {
  return EffectArray.reduce(grades, 0, (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : EffectArray.reduce(values, 0, (sum, value) => sum + value) / values.length;
}
