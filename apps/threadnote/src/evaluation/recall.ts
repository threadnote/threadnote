import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {deriveRecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import type {RecallCandidate, RecallRankContext} from '@threadnote/recall/rank';
import {rankRecallCandidates} from '@threadnote/recall/rank';
import * as EffectRecord from 'effect/Record';

export const RECALL_EVALUATION_VERSION = 2 as const;
export const RECALL_EVALUATION_RUN_VERSION = 1 as const;
export const RECALL_EVALUATION_RESULT_VERSION = 1 as const;
export const RECALL_EVALUATION_CUTOFFS = [1, 5, 10] as const;

export const RECALL_EVALUATION_CATEGORIES = [
  'exact_lexical',
  'semantic',
  'code_docs',
  'scope',
  'lifecycle',
  'authority',
  'time',
  'graph',
  'no_answer',
  'adversarial',
  'chunking',
  'multilingual',
] as const;

export type RecallEvaluationCategory = (typeof RECALL_EVALUATION_CATEGORIES)[number];
export type RecallEvaluationAnswerability = 'answerable' | 'no_answer';
export type RecallEvaluationStage = 'expanded' | 'lexical' | 'reranked' | 'semantic';
export type RecallEvaluationExpansionOutcome = 'fallback' | 'not_invoked' | 'succeeded';

export interface RecallEvaluationFixtureMetadataV2 {
  readonly createdAt: string;
  readonly description: string;
  readonly name: string;
  readonly provenance: string;
  readonly reviewed: boolean;
}

export interface RecallEvaluationAuthorityPair {
  readonly inferiorUri: string;
  readonly preferredUri: string;
}

export interface RecallEvaluationDocumentV2 extends RecallCandidate {
  readonly language: string;
  readonly provenance: string;
  readonly reviewed: boolean;
}

export interface RecallEvaluationQueryV2 {
  readonly authorityPairs?: readonly RecallEvaluationAuthorityPair[];
  readonly category: RecallEvaluationCategory;
  readonly expectedAnswerability: RecallEvaluationAnswerability;
  readonly expectedStages: readonly RecallEvaluationStage[];
  readonly forbiddenUris?: readonly string[];
  readonly id: string;
  readonly language: string;
  readonly now?: string;
  readonly project?: string;
  readonly provenance: string;
  readonly query: string;
  readonly relevance: Readonly<Record<string, number>>;
  readonly requiredReasonCodes?: readonly string[];
  readonly seedUris?: readonly string[];
}

export interface RecallEvaluationFixtureV2 {
  readonly documents: readonly RecallEvaluationDocumentV2[];
  readonly metadata: RecallEvaluationFixtureMetadataV2;
  readonly queries: readonly RecallEvaluationQueryV2[];
  readonly version: typeof RECALL_EVALUATION_VERSION;
}

export interface RecallEvaluationRankedHitV1 {
  readonly reasonCodes: readonly string[];
  readonly score?: number;
  readonly uri: string;
}

export interface RecallEvaluationQueryRunV1 {
  readonly candidatesRead?: number;
  readonly contextCharacters: number;
  readonly contextTokens?: number;
  readonly expansion?: RecallEvaluationExpansionOutcome;
  readonly id: string;
  readonly latencyMilliseconds?: number;
  readonly predictedAnswerability: RecallEvaluationAnswerability;
  readonly ranked: readonly RecallEvaluationRankedHitV1[];
  readonly stages: readonly RecallEvaluationStage[];
}

export interface RecallEvaluationRunV1 {
  readonly createdAt: string;
  readonly fixtureHash: string;
  readonly pipeline: {
    readonly model?: string;
    readonly name: string;
    readonly revision?: string;
  };
  readonly queries: readonly RecallEvaluationQueryRunV1[];
  readonly version: typeof RECALL_EVALUATION_RUN_VERSION;
}

export interface RecallEvaluationMetricSetV1 {
  readonly answerableQueries: number;
  readonly averageCandidatesRead: number;
  readonly authorityInversionRate: number;
  readonly averageContextCharacters: number;
  readonly averageContextTokens: number;
  readonly expansionFallbackRate: number;
  readonly expansionInvocationRate: number;
  readonly explanationCoverage: number;
  readonly forbiddenHitRate: number;
  readonly meanNdcgAt10: number;
  readonly meanNdcgAt5: number;
  readonly meanReciprocalRank: number;
  readonly noAnswerF1: number;
  readonly noAnswerPrecision: number;
  readonly noAnswerRecall: number;
  readonly queryCount: number;
  readonly recallAt1: number;
  readonly recallAt10: number;
  readonly recallAt5: number;
  readonly staleHitRate: number;
}

export interface RecallEvaluationResultV1 {
  readonly categories: Partial<Record<RecallEvaluationCategory, RecallEvaluationMetricSetV1>>;
  readonly failures: readonly string[];
  readonly metrics: RecallEvaluationMetricSetV1;
  readonly pipeline: RecallEvaluationRunV1['pipeline'];
  readonly queryResults: readonly {
    readonly category: RecallEvaluationCategory;
    readonly expectedAnswerability: RecallEvaluationAnswerability;
    readonly id: string;
    readonly predictedAnswerability: RecallEvaluationAnswerability;
    readonly rankedUris: readonly string[];
  }[];
  readonly version: typeof RECALL_EVALUATION_RESULT_VERSION;
}

export interface RecallEvaluationComparisonV1 {
  readonly baseline: string;
  readonly candidate: string;
  readonly categoryDeltas: Partial<Record<RecallEvaluationCategory, RecallEvaluationMetricDeltaV1>>;
  readonly metrics: RecallEvaluationMetricDeltaV1;
  readonly version: 1;
}

export type RecallEvaluationMetricDeltaV1 = {
  readonly [Key in keyof RecallEvaluationMetricSetV1]: number;
};

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const RecallEvaluationCategorySchema = Schema.Literals(RECALL_EVALUATION_CATEGORIES);
const RecallEvaluationAnswerabilitySchema = Schema.Literals(['answerable', 'no_answer']);
const RecallEvaluationStageSchema = Schema.Literals(['expanded', 'lexical', 'reranked', 'semantic']);

const RecallFieldsSchema = Schema.Struct({
  identifiers: Schema.optionalKey(Schema.Array(NonEmptyString)),
  keywords: Schema.optionalKey(Schema.Array(NonEmptyString)),
  project: Schema.optionalKey(NonEmptyString),
  title: Schema.optionalKey(NonEmptyString),
  topic: Schema.optionalKey(NonEmptyString),
});

const RecallRelationSchema = Schema.Struct({
  type: Schema.Literals(['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes']),
  uri: NonEmptyString,
});

const RecallCandidateSchema = Schema.Struct({
  authority: Schema.optionalKey(
    Schema.Literals(['agent_generated', 'canonical_repo', 'external', 'reviewed_shared', 'user_approved']),
  ),
  exactTerms: Schema.optionalKey(Schema.Array(NonEmptyString)),
  feedback: Schema.optionalKey(Schema.Finite),
  fields: Schema.optionalKey(RecallFieldsSchema),
  kind: Schema.optionalKey(Schema.Literals(['durable', 'handoff', 'incident', 'preference', 'smoke'])),
  relations: Schema.optionalKey(Schema.Array(RecallRelationSchema)),
  reranker: Schema.optionalKey(Schema.Finite),
  semantic: Schema.optionalKey(Schema.Finite),
  status: Schema.optionalKey(Schema.Literals(['active', 'archived', 'expired', 'superseded'])),
  text: NonEmptyString,
  timestamp: Schema.optionalKey(NonEmptyString),
  trust: Schema.optionalKey(Schema.Literals(['approved', 'inferred', 'untrusted'])),
  uri: NonEmptyString,
  validFrom: Schema.optionalKey(NonEmptyString),
  validTo: Schema.optionalKey(NonEmptyString),
  language: NonEmptyString,
  provenance: NonEmptyString,
  reviewed: Schema.Boolean,
});

const RecallEvaluationQuerySchemaV2 = Schema.Struct({
  authorityPairs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        inferiorUri: NonEmptyString,
        preferredUri: NonEmptyString,
      }),
    ),
  ),
  category: RecallEvaluationCategorySchema,
  expectedAnswerability: RecallEvaluationAnswerabilitySchema,
  expectedStages: Schema.Array(RecallEvaluationStageSchema),
  forbiddenUris: Schema.optionalKey(Schema.Array(NonEmptyString)),
  id: NonEmptyString,
  language: NonEmptyString,
  now: Schema.optionalKey(NonEmptyString),
  project: Schema.optionalKey(NonEmptyString),
  provenance: NonEmptyString,
  query: NonEmptyString,
  relevance: Schema.Record(NonEmptyString, NonNegativeFinite),
  requiredReasonCodes: Schema.optionalKey(Schema.Array(NonEmptyString)),
  seedUris: Schema.optionalKey(Schema.Array(NonEmptyString)),
});

export const RecallEvaluationFixtureSchemaV2 = Schema.Struct({
  documents: Schema.Array(RecallCandidateSchema),
  metadata: Schema.Struct({
    createdAt: NonEmptyString,
    description: NonEmptyString,
    name: NonEmptyString,
    provenance: NonEmptyString,
    reviewed: Schema.Boolean,
  }),
  queries: Schema.Array(RecallEvaluationQuerySchemaV2),
  version: Schema.Literal(RECALL_EVALUATION_VERSION),
});

const RecallEvaluationRankedHitSchemaV1 = Schema.Struct({
  reasonCodes: Schema.Array(NonEmptyString),
  score: Schema.optionalKey(Schema.Finite),
  uri: NonEmptyString,
});

const RecallEvaluationQueryRunSchemaV1 = Schema.Struct({
  candidatesRead: Schema.optionalKey(NonNegativeFinite),
  contextCharacters: NonNegativeFinite,
  contextTokens: Schema.optionalKey(NonNegativeFinite),
  expansion: Schema.optionalKey(Schema.Literals(['fallback', 'not_invoked', 'succeeded'])),
  id: NonEmptyString,
  latencyMilliseconds: Schema.optionalKey(NonNegativeFinite),
  predictedAnswerability: RecallEvaluationAnswerabilitySchema,
  ranked: Schema.Array(RecallEvaluationRankedHitSchemaV1),
  stages: Schema.Array(RecallEvaluationStageSchema),
});

export const RecallEvaluationRunSchemaV1 = Schema.Struct({
  createdAt: NonEmptyString,
  fixtureHash: NonEmptyString,
  pipeline: Schema.Struct({
    model: Schema.optionalKey(NonEmptyString),
    name: NonEmptyString,
    revision: Schema.optionalKey(NonEmptyString),
  }),
  queries: Schema.Array(RecallEvaluationQueryRunSchemaV1),
  version: Schema.Literal(RECALL_EVALUATION_RUN_VERSION),
});

export function parseRecallEvaluationFixtureV2(value: unknown): RecallEvaluationFixtureV2 {
  const decoded = Schema.decodeUnknownSync(RecallEvaluationFixtureSchemaV2)(value);
  validateRecallEvaluationFixtureV2(decoded);
  return decoded;
}

export function parseRecallEvaluationRunV1(value: unknown): RecallEvaluationRunV1 {
  return Schema.decodeUnknownSync(RecallEvaluationRunSchemaV1)(value);
}

export function validateRecallEvaluationFixtureV2(fixture: RecallEvaluationFixtureV2): void {
  const documentUris = new Set<string>();
  for (const document of fixture.documents) {
    if (documentUris.has(document.uri)) {
      throw new Error(`Duplicate recall evaluation document URI: ${document.uri}`);
    }
    documentUris.add(document.uri);
  }

  const queryIds = new Set<string>();
  for (const query of fixture.queries) {
    if (queryIds.has(query.id)) {
      throw new Error(`Duplicate recall evaluation query ID: ${query.id}`);
    }
    queryIds.add(query.id);
    if (
      query.expectedAnswerability === 'answerable' &&
      !EffectArray.some(EffectRecord.values(query.relevance), grade => grade > 0)
    ) {
      throw new Error(`Answerable recall evaluation query has no relevant document: ${query.id}`);
    }
    if (
      query.expectedAnswerability === 'no_answer' &&
      EffectArray.some(EffectRecord.values(query.relevance), grade => grade > 0)
    ) {
      throw new Error(`No-answer recall evaluation query has relevant documents: ${query.id}`);
    }
    for (const [uri, grade] of EffectRecord.toEntries(query.relevance)) {
      if (!documentUris.has(uri)) {
        throw new Error(`Recall evaluation query ${query.id} references missing document: ${uri}`);
      }
      if (!Number.isInteger(grade) || grade < 0 || grade > 3) {
        throw new Error(`Recall evaluation query ${query.id} has invalid relevance grade ${grade} for ${uri}`);
      }
    }
    for (const uri of query.forbiddenUris ?? []) {
      if (!documentUris.has(uri)) {
        throw new Error(`Recall evaluation query ${query.id} forbids missing document: ${uri}`);
      }
    }
    for (const pair of query.authorityPairs ?? []) {
      if (!documentUris.has(pair.preferredUri) || !documentUris.has(pair.inferiorUri)) {
        throw new Error(`Recall evaluation query ${query.id} has an authority pair with a missing document`);
      }
    }
    if (query.expectedStages.length === 0) {
      throw new Error(`Recall evaluation query ${query.id} must declare at least one expected stage`);
    }
  }
}

export function runLexicalRecallEvaluationV2(
  fixture: RecallEvaluationFixtureV2,
  options: {
    readonly createdAt?: string;
    readonly fixtureHash: string;
    readonly limit?: number;
    readonly pipelineName?: string;
    readonly projectEligibility?: 'explicit' | 'global';
  },
): RecallEvaluationRunV1 {
  const limit = Math.max(1, options.limit ?? 10);
  return {
    createdAt: options.createdAt ?? new Date().toISOString(),
    fixtureHash: options.fixtureHash,
    pipeline: {name: options.pipelineName ?? 'threadnote-lexical-only'},
    queries: EffectArray.map(fixture.queries, query => {
      const context: RecallRankContext = {
        eligibility: deriveRecallEligibilityPolicy({
          explicitProject: options.projectEligibility === 'global' ? undefined : query.project,
          originalQuery: query.query,
        }),
        now: query.now ? new Date(query.now) : undefined,
        project: query.project,
        seedUris: query.seedUris,
      };
      const ranked = rankRecallCandidates(
        query.query,
        EffectArray.map(fixture.documents, document => ({...document, semantic: 0})),
        context,
      );
      const hits = EffectArray.map(ranked.results.slice(0, limit), result => ({
        reasonCodes: EffectArray.map(result.reasons, reason => reason.code),
        score: result.finalScore,
        uri: result.candidate.uri,
      }));
      return {
        candidatesRead: fixture.documents.length,
        contextCharacters: EffectArray.reduce(
          ranked.results.slice(0, limit),
          0,
          (characters, result) => characters + result.candidate.text.length,
        ),
        contextTokens: Math.ceil(
          EffectArray.reduce(
            ranked.results.slice(0, limit),
            0,
            (characters, result) => characters + result.candidate.text.length,
          ) / 4,
        ),
        expansion: 'not_invoked',
        id: query.id,
        predictedAnswerability: ranked.confidence.level === 'no_answer' ? 'no_answer' : 'answerable',
        ranked: hits,
        stages: ['lexical'],
      };
    }),
    version: RECALL_EVALUATION_RUN_VERSION,
  };
}

export interface RecallEvaluationQueryScores {
  readonly reranker?: ReadonlyMap<string, number>;
  readonly semantic?: ReadonlyMap<string, number>;
}

export function runScoredRecallEvaluationV2(
  fixture: RecallEvaluationFixtureV2,
  scoresByQuery: ReadonlyMap<string, RecallEvaluationQueryScores>,
  options: {
    readonly createdAt?: string;
    readonly fixtureHash: string;
    readonly limit?: number;
    readonly model?: string;
    readonly pipelineName: string;
    readonly projectEligibility?: 'explicit' | 'global';
    readonly revision?: string;
  },
): RecallEvaluationRunV1 {
  const limit = Math.max(1, options.limit ?? 10);
  return {
    createdAt: options.createdAt ?? new Date().toISOString(),
    fixtureHash: options.fixtureHash,
    pipeline: {
      model: options.model,
      name: options.pipelineName,
      revision: options.revision,
    },
    queries: EffectArray.map(fixture.queries, query => {
      const scores = scoresByQuery.get(query.id);
      const ranked = rankRecallCandidates(
        query.query,
        EffectArray.map(fixture.documents, document => ({
          ...document,
          reranker: scores?.reranker?.get(document.uri) ?? 0,
          semantic: scores?.semantic?.get(document.uri) ?? 0,
        })),
        {
          eligibility: deriveRecallEligibilityPolicy({
            explicitProject: options.projectEligibility === 'global' ? undefined : query.project,
            originalQuery: query.query,
          }),
          now: query.now ? new Date(query.now) : undefined,
          project: query.project,
          seedUris: query.seedUris,
        },
      );
      const selected = ranked.results.slice(0, limit);
      const contextCharacters = EffectArray.reduce(
        selected,
        0,
        (characters, result) => characters + result.candidate.text.length,
      );
      return {
        candidatesRead: fixture.documents.length,
        contextCharacters,
        contextTokens: Math.ceil(contextCharacters / 4),
        expansion: 'not_invoked',
        id: query.id,
        predictedAnswerability: ranked.confidence.level === 'no_answer' ? 'no_answer' : 'answerable',
        ranked: EffectArray.map(selected, result => ({
          reasonCodes: EffectArray.map(result.reasons, reason => reason.code),
          score: result.finalScore,
          uri: result.candidate.uri,
        })),
        stages: [
          'lexical' as const,
          ...(scores?.semantic ? (['semantic'] as const) : []),
          ...(scores?.reranker ? (['reranked'] as const) : []),
        ],
      };
    }),
    version: RECALL_EVALUATION_RUN_VERSION,
  };
}

export function evaluateRecallRunV2(
  fixture: RecallEvaluationFixtureV2,
  run: RecallEvaluationRunV1,
): RecallEvaluationResultV1 {
  validateRecallEvaluationFixtureV2(fixture);
  const queryById = new Map(EffectArray.map(fixture.queries, query => [query.id, query]));
  const duplicateRunIds = duplicates(EffectArray.map(run.queries, query => query.id));
  const failures = EffectArray.map(duplicateRunIds, id => `duplicate run query: ${id}`);
  const unknownRunIds = EffectArray.filter(
    EffectArray.map(run.queries, query => query.id),
    id => !queryById.has(id),
  );
  failures.push(...EffectArray.map(unknownRunIds, id => `unknown run query: ${id}`));

  const runById = new Map(EffectArray.map(run.queries, query => [query.id, query]));
  const observations: QueryObservation[] = [];
  for (const query of fixture.queries) {
    const queryRun = runById.get(query.id);
    if (!queryRun) {
      failures.push(`${query.id}: run result is missing`);
      observations.push(missingObservation(query));
      continue;
    }
    const rankedUris = EffectArray.map(queryRun.ranked, hit => hit.uri);
    const unknownUris = EffectArray.filter(
      rankedUris,
      uri => !EffectArray.some(fixture.documents, document => document.uri === uri),
    );
    failures.push(...EffectArray.map(unknownUris, uri => `${query.id}: run returned unknown URI ${uri}`));
    const expectedNoAnswer = query.expectedAnswerability === 'no_answer';
    const predictedNoAnswer = queryRun.predictedAnswerability === 'no_answer';
    if (expectedNoAnswer !== predictedNoAnswer) {
      failures.push(`${query.id}: expected ${query.expectedAnswerability}, got ${queryRun.predictedAnswerability}`);
    }

    const topReasonCodes = new Set(queryRun.ranked[0]?.reasonCodes ?? []);
    const missingReasonCodes = EffectArray.filter(query.requiredReasonCodes ?? [], code => !topReasonCodes.has(code));
    failures.push(
      ...EffectArray.map(missingReasonCodes, code => `${query.id}: top result is missing required reason ${code}`),
    );
    const missingStages = EffectArray.filter(query.expectedStages, stage => !queryRun.stages.includes(stage));
    failures.push(...EffectArray.map(missingStages, stage => `${query.id}: run is missing expected stage ${stage}`));

    const forbiddenHits = EffectArray.filter(rankedUris, uri => query.forbiddenUris?.includes(uri) === true);
    failures.push(...EffectArray.map(forbiddenHits, uri => `${query.id}: forbidden result surfaced: ${uri}`));

    observations.push(observeQuery(query, queryRun, fixture.documents));
  }

  const categories: Partial<Record<RecallEvaluationCategory, RecallEvaluationMetricSetV1>> = {};
  for (const category of RECALL_EVALUATION_CATEGORIES) {
    const matching = EffectArray.filter(observations, observation => observation.query.category === category);
    if (matching.length > 0) {
      categories[category] = aggregateObservations(matching);
    }
  }

  return {
    categories,
    failures,
    metrics: aggregateObservations(observations),
    pipeline: run.pipeline,
    queryResults: EffectArray.map(observations, observation => ({
      category: observation.query.category,
      expectedAnswerability: observation.query.expectedAnswerability,
      id: observation.query.id,
      predictedAnswerability: observation.run.predictedAnswerability,
      rankedUris: observation.rankedUris,
    })),
    version: RECALL_EVALUATION_RESULT_VERSION,
  };
}

export function compareRecallEvaluationResults(
  baseline: RecallEvaluationResultV1,
  candidate: RecallEvaluationResultV1,
): RecallEvaluationComparisonV1 {
  const categoryDeltas: Partial<Record<RecallEvaluationCategory, RecallEvaluationMetricDeltaV1>> = {};
  for (const category of RECALL_EVALUATION_CATEGORIES) {
    const baselineMetrics = baseline.categories[category];
    const candidateMetrics = candidate.categories[category];
    if (baselineMetrics && candidateMetrics) {
      categoryDeltas[category] = metricDelta(baselineMetrics, candidateMetrics);
    }
  }
  return {
    baseline: baseline.pipeline.name,
    candidate: candidate.pipeline.name,
    categoryDeltas,
    metrics: metricDelta(baseline.metrics, candidate.metrics),
    version: 1,
  };
}

interface QueryObservation {
  readonly authorityInversions: number;
  readonly authorityPairs: number;
  readonly candidatesRead: number;
  readonly contextCharacters: number;
  readonly contextTokens: number;
  readonly expectedNoAnswer: boolean;
  readonly expansionFallback: boolean;
  readonly expansionInvoked: boolean;
  readonly explanationSatisfied: boolean;
  readonly forbiddenHits: number;
  readonly predictedNoAnswer: boolean;
  readonly query: RecallEvaluationQueryV2;
  readonly rankedCount: number;
  readonly rankedUris: readonly string[];
  readonly run: RecallEvaluationQueryRunV1;
  readonly staleHits: number;
}

function observeQuery(
  query: RecallEvaluationQueryV2,
  run: RecallEvaluationQueryRunV1,
  documents: readonly RecallEvaluationDocumentV2[],
): QueryObservation {
  const rankedUris = EffectArray.map(run.ranked, hit => hit.uri);
  const documentsByUri = new Map(EffectArray.map(documents, document => [document.uri, document]));
  let authorityInversions = 0;
  for (const pair of query.authorityPairs ?? []) {
    const preferredRank = rankedUris.indexOf(pair.preferredUri);
    const inferiorRank = rankedUris.indexOf(pair.inferiorUri);
    if (inferiorRank !== -1 && (preferredRank === -1 || inferiorRank < preferredRank)) {
      authorityInversions += 1;
    }
  }
  const topReasonCodes = new Set(run.ranked[0]?.reasonCodes ?? []);
  return {
    authorityInversions,
    authorityPairs: query.authorityPairs?.length ?? 0,
    candidatesRead: run.candidatesRead ?? rankedUris.length,
    contextCharacters: run.contextCharacters,
    contextTokens: run.contextTokens ?? Math.ceil(run.contextCharacters / 4),
    expectedNoAnswer: query.expectedAnswerability === 'no_answer',
    expansionFallback: run.expansion === 'fallback',
    expansionInvoked: run.expansion === 'fallback' || run.expansion === 'succeeded',
    explanationSatisfied: EffectArray.every(query.requiredReasonCodes ?? [], code => topReasonCodes.has(code)),
    forbiddenHits: EffectArray.filter(rankedUris, uri => query.forbiddenUris?.includes(uri) === true).length,
    predictedNoAnswer: run.predictedAnswerability === 'no_answer',
    query,
    rankedCount: rankedUris.length,
    rankedUris,
    run,
    staleHits: EffectArray.filter(rankedUris, uri => {
      const document = documentsByUri.get(uri);
      return document?.status === 'archived' || document?.status === 'superseded';
    }).length,
  };
}

function missingObservation(query: RecallEvaluationQueryV2): QueryObservation {
  return {
    authorityInversions: 0,
    authorityPairs: query.authorityPairs?.length ?? 0,
    candidatesRead: 0,
    contextCharacters: 0,
    contextTokens: 0,
    expectedNoAnswer: query.expectedAnswerability === 'no_answer',
    expansionFallback: false,
    expansionInvoked: false,
    explanationSatisfied: false,
    forbiddenHits: 0,
    predictedNoAnswer: true,
    query,
    rankedCount: 0,
    rankedUris: [],
    run: {
      contextCharacters: 0,
      id: query.id,
      predictedAnswerability: 'no_answer',
      ranked: [],
      stages: [],
    },
    staleHits: 0,
  };
}

function aggregateObservations(observations: readonly QueryObservation[]): RecallEvaluationMetricSetV1 {
  const answerable = EffectArray.filter(observations, observation => !observation.expectedNoAnswer);
  const expectedNoAnswer = EffectArray.filter(observations, observation => observation.expectedNoAnswer).length;
  const predictedNoAnswer = EffectArray.filter(observations, observation => observation.predictedNoAnswer).length;
  const correctNoAnswer = EffectArray.filter(
    observations,
    observation => observation.expectedNoAnswer && observation.predictedNoAnswer,
  ).length;
  const noAnswerPrecision = predictedNoAnswer === 0 ? 1 : correctNoAnswer / predictedNoAnswer;
  const noAnswerRecall = expectedNoAnswer === 0 ? 1 : correctNoAnswer / expectedNoAnswer;
  const noAnswerF1 =
    noAnswerPrecision + noAnswerRecall === 0
      ? 0
      : (2 * noAnswerPrecision * noAnswerRecall) / (noAnswerPrecision + noAnswerRecall);
  const authorityPairs = sum(EffectArray.map(observations, observation => observation.authorityPairs));
  const rankedCount = sum(EffectArray.map(observations, observation => observation.rankedCount));
  return {
    answerableQueries: answerable.length,
    averageCandidatesRead:
      observations.length === 0
        ? 0
        : sum(EffectArray.map(observations, observation => observation.candidatesRead)) / observations.length,
    authorityInversionRate:
      authorityPairs === 0
        ? 0
        : sum(EffectArray.map(observations, observation => observation.authorityInversions)) / authorityPairs,
    averageContextCharacters:
      observations.length === 0
        ? 0
        : sum(EffectArray.map(observations, observation => observation.contextCharacters)) / observations.length,
    averageContextTokens:
      observations.length === 0
        ? 0
        : sum(EffectArray.map(observations, observation => observation.contextTokens)) / observations.length,
    expansionFallbackRate:
      EffectArray.filter(observations, observation => observation.expansionInvoked).length === 0
        ? 0
        : EffectArray.filter(observations, observation => observation.expansionFallback).length /
          EffectArray.filter(observations, observation => observation.expansionInvoked).length,
    expansionInvocationRate:
      observations.length === 0
        ? 0
        : EffectArray.filter(observations, observation => observation.expansionInvoked).length / observations.length,
    explanationCoverage:
      observations.length === 0
        ? 1
        : EffectArray.filter(observations, observation => observation.explanationSatisfied).length /
          observations.length,
    forbiddenHitRate:
      rankedCount === 0
        ? 0
        : sum(EffectArray.map(observations, observation => observation.forbiddenHits)) / rankedCount,
    meanNdcgAt10: mean(
      EffectArray.map(answerable, observation =>
        ndcgAtCutoff(observation.rankedUris, observation.query.relevance, RECALL_EVALUATION_CUTOFFS[2]),
      ),
    ),
    meanNdcgAt5: mean(
      EffectArray.map(answerable, observation =>
        ndcgAtCutoff(observation.rankedUris, observation.query.relevance, RECALL_EVALUATION_CUTOFFS[1]),
      ),
    ),
    meanReciprocalRank: mean(
      EffectArray.map(answerable, observation => {
        const rank = EffectOption.getOrElse(
          EffectArray.findFirstIndex(observation.rankedUris, uri => (observation.query.relevance[uri] ?? 0) > 0),
          () => -1,
        );
        return rank === -1 ? 0 : 1 / (rank + 1);
      }),
    ),
    noAnswerF1,
    noAnswerPrecision,
    noAnswerRecall,
    queryCount: observations.length,
    recallAt1: mean(EffectArray.map(answerable, observation => recallAtCutoff(observation, 1))),
    recallAt10: mean(EffectArray.map(answerable, observation => recallAtCutoff(observation, 10))),
    recallAt5: mean(EffectArray.map(answerable, observation => recallAtCutoff(observation, 5))),
    staleHitRate:
      rankedCount === 0 ? 0 : sum(EffectArray.map(observations, observation => observation.staleHits)) / rankedCount,
  };
}

function recallAtCutoff(observation: QueryObservation, cutoff: number): number {
  const relevantUris = EffectArray.map(
    EffectArray.filter(EffectRecord.toEntries(observation.query.relevance), ([, grade]) => grade > 0),
    ([uri]) => uri,
  );
  if (relevantUris.length === 0) return 1;
  const ranked = new Set(observation.rankedUris.slice(0, cutoff));
  return EffectArray.filter(relevantUris, uri => ranked.has(uri)).length / relevantUris.length;
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
  return EffectArray.reduce(grades, 0, (total, grade, index) => total + (2 ** grade - 1) / Math.log2(index + 2));
}

function metricDelta(
  baseline: RecallEvaluationMetricSetV1,
  candidate: RecallEvaluationMetricSetV1,
): RecallEvaluationMetricDeltaV1 {
  return {
    answerableQueries: candidate.answerableQueries - baseline.answerableQueries,
    averageCandidatesRead: candidate.averageCandidatesRead - baseline.averageCandidatesRead,
    authorityInversionRate: candidate.authorityInversionRate - baseline.authorityInversionRate,
    averageContextCharacters: candidate.averageContextCharacters - baseline.averageContextCharacters,
    averageContextTokens: candidate.averageContextTokens - baseline.averageContextTokens,
    expansionFallbackRate: candidate.expansionFallbackRate - baseline.expansionFallbackRate,
    expansionInvocationRate: candidate.expansionInvocationRate - baseline.expansionInvocationRate,
    explanationCoverage: candidate.explanationCoverage - baseline.explanationCoverage,
    forbiddenHitRate: candidate.forbiddenHitRate - baseline.forbiddenHitRate,
    meanNdcgAt10: candidate.meanNdcgAt10 - baseline.meanNdcgAt10,
    meanNdcgAt5: candidate.meanNdcgAt5 - baseline.meanNdcgAt5,
    meanReciprocalRank: candidate.meanReciprocalRank - baseline.meanReciprocalRank,
    noAnswerF1: candidate.noAnswerF1 - baseline.noAnswerF1,
    noAnswerPrecision: candidate.noAnswerPrecision - baseline.noAnswerPrecision,
    noAnswerRecall: candidate.noAnswerRecall - baseline.noAnswerRecall,
    queryCount: candidate.queryCount - baseline.queryCount,
    recallAt1: candidate.recallAt1 - baseline.recallAt1,
    recallAt10: candidate.recallAt10 - baseline.recallAt10,
    recallAt5: candidate.recallAt5 - baseline.recallAt5,
    staleHitRate: candidate.staleHitRate - baseline.staleHitRate,
  };
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return EffectArray.reduce(values, 0, (total, value) => total + value);
}
