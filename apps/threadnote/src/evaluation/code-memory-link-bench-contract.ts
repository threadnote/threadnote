import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {benchmarkMeasurement, type BenchmarkMeasurementV1} from '@threadnote/evidence/benchmark';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_BENCH_VERSION = 1 as const;
export const CODE_MEMORY_LINK_BENCH_ID = 'code-memory-link-bench-v1' as const;
/** Changing reviewed truth requires an explicit source-reviewed hash update. */
export const CODE_MEMORY_LINK_BENCH_APPROVED_FIXTURE_HASH =
  'c4dd655b2c8d23927680600129978fdc663fd72b2bd5dcafb728578110409ff9' as const;
export const CODE_MEMORY_LINK_BENCH_MINIMUM_WARM_SAMPLES = 25 as const;
export const CODE_MEMORY_LINK_BENCH_MINIMUM_WARMUPS = 5 as const;

export const CODE_MEMORY_LINK_BENCH_LABELS = [
  'direct-current',
  'historical-warning',
  'supporting',
  'irrelevant-harmful',
] as const;
export const CODE_MEMORY_LINK_BENCH_STATUSES = ['exact', 'relocated', 'changed', 'deleted', 'unknown'] as const;
export const CODE_MEMORY_LINK_BENCH_SCENARIO_KINDS = [
  'exact-symbol',
  'exact-file',
  'relocated-symbol',
  'changed',
  'deleted',
  'ambiguous-relocation',
  'cross-repository-collision',
  'archived',
  'superseded',
  'conflicting-topic',
  'malformed-citation',
  'stale-graph',
  'dirty-overlay',
  'legacy-uncited',
  'high-noise-budget',
] as const;

export type CodeMemoryLinkBenchLabel = (typeof CODE_MEMORY_LINK_BENCH_LABELS)[number];
export type CodeMemoryLinkBenchStatus = (typeof CODE_MEMORY_LINK_BENCH_STATUSES)[number];
export type CodeMemoryLinkBenchScenarioKind = (typeof CODE_MEMORY_LINK_BENCH_SCENARIO_KINDS)[number];
export type CodeMemoryLinkBenchBudgetClass = 'default' | 'worst-case';

export interface CodeMemoryLinkBenchThresholdsV1 {
  readonly codeCitationNoAnswerAccuracyMinimum: number;
  readonly coverageAccuracyMinimum: number;
  readonly defaultEstimatedTokensMaximum: number;
  readonly directCodeCitationPrecisionAt3Minimum: number;
  readonly directFirstRateMinimum: number;
  readonly exactCleanRecallAt3Minimum: number;
  readonly falseCurrentRateMaximum: number;
  readonly k: number;
  readonly relocationInclusiveRecallAt3Minimum: number;
  readonly warmIncrementalP95MillisecondsMaximum: number;
  readonly worstCaseEstimatedTokensMaximum: number;
}

export const CODE_MEMORY_LINK_BENCH_APPROVED_THRESHOLDS: CodeMemoryLinkBenchThresholdsV1 = Object.freeze({
  codeCitationNoAnswerAccuracyMinimum: 1,
  coverageAccuracyMinimum: 1,
  defaultEstimatedTokensMaximum: 1_250,
  directCodeCitationPrecisionAt3Minimum: 0.9,
  directFirstRateMinimum: 1,
  exactCleanRecallAt3Minimum: 1,
  falseCurrentRateMaximum: 0,
  k: 3,
  relocationInclusiveRecallAt3Minimum: 0.95,
  warmIncrementalP95MillisecondsMaximum: 250,
  worstCaseEstimatedTokensMaximum: 1_500,
});

export interface CodeMemoryLinkBenchCoverageV1 {
  readonly complete: boolean;
  readonly matchedMemories: number;
  readonly requested: number;
  readonly resolved: number;
  readonly unresolvedOrdinals?: readonly number[];
}

export interface CodeMemoryLinkBenchJudgmentV1 {
  readonly expectedStatus: CodeMemoryLinkBenchStatus;
  readonly label: CodeMemoryLinkBenchLabel;
  readonly uri: string;
}

export interface CodeMemoryLinkBenchQueryV1 {
  readonly budgetClass: CodeMemoryLinkBenchBudgetClass;
  readonly codeRefs: readonly string[];
  readonly expectedCoverage: CodeMemoryLinkBenchCoverageV1;
  readonly id: string;
  readonly judgments: readonly CodeMemoryLinkBenchJudgmentV1[];
  readonly measureWarmIncrementalLatency: boolean;
  readonly scenario: CodeMemoryLinkBenchScenarioKind;
  readonly task: string;
}

export interface CodeMemoryLinkBenchFixtureV1 {
  readonly id: typeof CODE_MEMORY_LINK_BENCH_ID;
  readonly queries: readonly CodeMemoryLinkBenchQueryV1[];
  readonly thresholds: CodeMemoryLinkBenchThresholdsV1;
  readonly version: typeof CODE_MEMORY_LINK_BENCH_VERSION;
}

export interface CodeMemoryLinkBenchRankedMemoryV1 {
  readonly freshness: 'fresh' | 'stale' | 'unknown';
  readonly relationStatus: CodeMemoryLinkBenchStatus | null;
  readonly selectionBasis: 'code-citation' | 'lexical';
  readonly uri: string;
}

export interface CodeMemoryLinkBenchObservationV1 {
  readonly coverage: CodeMemoryLinkBenchCoverageV1;
  readonly elapsedMilliseconds: number;
  readonly estimatedTokens: number;
  readonly queryId: string;
  readonly rankedMemories: readonly CodeMemoryLinkBenchRankedMemoryV1[];
  readonly responseBytes: number;
  readonly warmIncremental?: {
    readonly milliseconds: readonly number[];
    readonly warmups: number;
  };
}

export interface CodeMemoryLinkBenchObservationBundleV1 {
  readonly fixtureId: typeof CODE_MEMORY_LINK_BENCH_ID;
  readonly observations: readonly CodeMemoryLinkBenchObservationV1[];
  readonly version: typeof CODE_MEMORY_LINK_BENCH_VERSION;
}

export interface CodeMemoryLinkBenchQueryResultV1 {
  readonly codeCitationRankedUris: readonly string[];
  readonly codeCitationNoAnswerCorrect: boolean | null;
  readonly directCodeCitationPrecisionAt3: number | null;
  readonly coverageCorrect: boolean;
  readonly directFirst: boolean | null;
  readonly duplicateResultCount: number;
  readonly falseCurrentCount: number;
  readonly id: string;
  readonly ndcgAt3: number;
  readonly rankedUris: readonly string[];
  readonly recallAt3: number;
}

export interface CodeMemoryLinkBenchMetricsV1 {
  readonly codeCitationNoAnswerAccuracy: number;
  readonly coverageAccuracy: number;
  readonly defaultEstimatedTokensMaximum: number;
  readonly duplicateResultCount: number;
  readonly directCodeCitationPrecisionAt3: number;
  readonly directCodeCitationPrecisionQueryCount: number;
  readonly directFirstRate: number;
  readonly exactCleanRecallAt3: number;
  readonly falseCurrentCount: number;
  readonly falseCurrentRate: number;
  readonly meanNdcgAt3: number;
  readonly relocationInclusiveRecallAt3: number;
  readonly responseBytesMaximum: number;
  readonly warmIncrementalMilliseconds: BenchmarkMeasurementV1 | null;
  readonly warmupCountMinimum: number;
  readonly worstCaseEstimatedTokensMaximum: number;
}

export interface CodeMemoryLinkBenchResultV1 {
  readonly fixture: {readonly hash: string; readonly id: string; readonly queryCount: number};
  readonly gate: {readonly failures: readonly string[]; readonly passed: boolean};
  readonly metrics: CodeMemoryLinkBenchMetricsV1;
  readonly queries: readonly CodeMemoryLinkBenchQueryResultV1[];
  readonly version: typeof CODE_MEMORY_LINK_BENCH_VERSION;
}

/** Parse reviewed truth and reject threshold, scenario, or shape weakening. */
export function parseCodeMemoryLinkBenchFixtureV1(value: unknown): CodeMemoryLinkBenchFixtureV1 {
  const fixture = record(value, 'fixture');
  exactKeys(fixture, ['id', 'queries', 'thresholds', 'version']);
  if (fixture.version !== CODE_MEMORY_LINK_BENCH_VERSION) invalid('fixture version must be 1');
  if (fixture.id !== CODE_MEMORY_LINK_BENCH_ID) invalid(`fixture id must be ${CODE_MEMORY_LINK_BENCH_ID}`);
  const thresholds = parseThresholds(fixture.thresholds);
  if (!EffectArray.isArray(fixture.queries) || fixture.queries.length === 0)
    invalid('queries must be a non-empty array');
  const queries = EffectArray.map(fixture.queries, parseQuery);
  assertUnique(
    EffectArray.map(queries, query => query.id),
    'query ids',
  );
  for (const scenario of CODE_MEMORY_LINK_BENCH_SCENARIO_KINDS) {
    if (!EffectArray.some(queries, query => query.scenario === scenario))
      invalid(`missing reviewed scenario ${scenario}`);
  }
  if (!EffectArray.some(queries, query => query.budgetClass === 'default'))
    invalid('a default-budget query is required');
  if (!EffectArray.some(queries, query => query.budgetClass === 'worst-case'))
    invalid('a worst-case-budget query is required');
  if (!EffectArray.some(queries, query => query.measureWarmIncrementalLatency)) {
    invalid('a warm incremental latency query is required');
  }
  return {
    id: CODE_MEMORY_LINK_BENCH_ID,
    queries: [...queries].sort((left, right) => compareText(left.id, right.id)),
    thresholds,
    version: CODE_MEMORY_LINK_BENCH_VERSION,
  };
}

/** Parse one complete runtime observation set for the reviewed fixture. */
export function parseCodeMemoryLinkBenchObservationBundleV1(
  value: unknown,
  fixtureInput: CodeMemoryLinkBenchFixtureV1,
): CodeMemoryLinkBenchObservationBundleV1 {
  const fixture = parseCodeMemoryLinkBenchFixtureV1(fixtureInput);
  const bundle = record(value, 'observation bundle');
  exactKeys(bundle, ['fixtureId', 'observations', 'version']);
  if (bundle.version !== CODE_MEMORY_LINK_BENCH_VERSION) invalid('observation version must be 1');
  if (bundle.fixtureId !== fixture.id) invalid('observation fixture id does not match');
  if (!EffectArray.isArray(bundle.observations)) invalid('observations must be an array');
  const observations = EffectArray.map(bundle.observations, parseObservation);
  assertUnique(
    EffectArray.map(observations, observation => observation.queryId),
    'observation query ids',
  );
  const expectedIds = new Set(EffectArray.map(fixture.queries, query => query.id));
  if (
    observations.length !== expectedIds.size ||
    EffectArray.some(observations, observation => !expectedIds.has(observation.queryId))
  ) {
    invalid('observations must contain every reviewed query exactly once');
  }
  return {
    fixtureId: CODE_MEMORY_LINK_BENCH_ID,
    observations: [...observations].sort((left, right) => compareText(left.queryId, right.queryId)),
    version: CODE_MEMORY_LINK_BENCH_VERSION,
  };
}

/** Canonical reviewed truth is independent of set-like fixture ordering. */
export function serializeCodeMemoryLinkBenchFixtureIdentity(input: CodeMemoryLinkBenchFixtureV1): string {
  return `${JSON.stringify(parseCodeMemoryLinkBenchFixtureV1(input), undefined, 2)}\n`;
}

export function codeMemoryLinkBenchFixtureHash(input: CodeMemoryLinkBenchFixtureV1): string {
  return sha256HexSync(serializeCodeMemoryLinkBenchFixtureIdentity(input));
}

/** Fail closed when the executable release gate is pointed at unreviewed truth. */
export function assertApprovedCodeMemoryLinkBenchFixture(input: CodeMemoryLinkBenchFixtureV1): void {
  const actual = codeMemoryLinkBenchFixtureHash(input);
  if (actual !== CODE_MEMORY_LINK_BENCH_APPROVED_FIXTURE_HASH) {
    invalid(
      `fixture hash ${actual} is not the approved ${CODE_MEMORY_LINK_BENCH_APPROVED_FIXTURE_HASH}; review the complete truth set before updating the approved hash`,
    );
  }
}

/** Evaluate ranked runtime observations against frozen retrieval, safety, latency, and budget gates. */
export function evaluateCodeMemoryLinkBench(
  fixtureInput: CodeMemoryLinkBenchFixtureV1,
  observationsInput: CodeMemoryLinkBenchObservationBundleV1,
): CodeMemoryLinkBenchResultV1 {
  const fixture = parseCodeMemoryLinkBenchFixtureV1(fixtureInput);
  const bundle = parseCodeMemoryLinkBenchObservationBundleV1(observationsInput, fixture);
  const observations = new Map(EffectArray.map(bundle.observations, observation => [observation.queryId, observation]));
  const evaluated = EffectArray.map(fixture.queries, query => evaluateQuery(query, observations.get(query.id)!));
  const exact = EffectArray.filter(
    evaluated,
    (result, __effectArrayIndex) => __effectArrayIndex in evaluated && result.exactClean,
  );
  const relocationInclusive = EffectArray.filter(
    evaluated,
    (result, __effectArrayIndex) => __effectArrayIndex in evaluated && result.relocationInclusive,
  );
  const warmObservations = EffectArray.map(
    EffectArrayPipe(fixture.queries, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (query, __effectArrayIndex2) =>
          __effectArrayIndex2 in __effectArrayValues && query.measureWarmIncrementalLatency,
      ),
    ),
    query => observations.get(query.id)!,
  );
  const warmSamples = EffectArray.flatMap(
    warmObservations,
    observation => observation.warmIncremental?.milliseconds ?? [],
  );
  const warmIncrementalMilliseconds =
    warmSamples.length === 0
      ? null
      : benchmarkMeasurement('code-memory-link-warm-incremental', 'milliseconds', warmSamples);
  const currentClaims = EffectArray.reduce(evaluated, 0, (total, result) => total + result.currentClaimCount);
  const falseCurrentCount = EffectArray.reduce(
    evaluated,
    0,
    (total, result) => total + result.public.falseCurrentCount,
  );
  const directCodeCitationPrecisionScores = EffectArray.flatMap(evaluated, result =>
    result.public.directCodeCitationPrecisionAt3 === null ? [] : [result.public.directCodeCitationPrecisionAt3],
  );
  const directFirstScores = EffectArray.flatMap(evaluated, result =>
    result.public.directFirst === null ? [] : [result.public.directFirst ? 1 : 0],
  );
  const codeCitationNoAnswerScores = EffectArray.flatMap(evaluated, result =>
    result.public.codeCitationNoAnswerCorrect === null ? [] : [result.public.codeCitationNoAnswerCorrect ? 1 : 0],
  );
  const defaults = EffectArray.map(
    EffectArray.filter(fixture.queries, query => query.budgetClass === 'default'),
    query => observations.get(query.id)!.estimatedTokens,
  );
  const worstCases = EffectArray.map(
    EffectArray.filter(fixture.queries, query => query.budgetClass === 'worst-case'),
    query => observations.get(query.id)!.estimatedTokens,
  );
  const metrics: CodeMemoryLinkBenchMetricsV1 = {
    codeCitationNoAnswerAccuracy: mean(codeCitationNoAnswerScores),
    coverageAccuracy: mean(EffectArray.map(evaluated, result => (result.public.coverageCorrect ? 1 : 0))),
    defaultEstimatedTokensMaximum: Math.max(...defaults),
    duplicateResultCount: EffectArray.reduce(
      evaluated,
      0,
      (total, result) => total + result.public.duplicateResultCount,
    ),
    directCodeCitationPrecisionAt3: mean(directCodeCitationPrecisionScores),
    directCodeCitationPrecisionQueryCount: directCodeCitationPrecisionScores.length,
    directFirstRate: mean(directFirstScores),
    exactCleanRecallAt3: mean(EffectArray.map(exact, result => result.public.recallAt3)),
    falseCurrentCount,
    falseCurrentRate: ratio(falseCurrentCount, currentClaims, 0),
    meanNdcgAt3: mean(EffectArray.map(evaluated, result => result.public.ndcgAt3)),
    relocationInclusiveRecallAt3: mean(EffectArray.map(relocationInclusive, result => result.public.recallAt3)),
    responseBytesMaximum: Math.max(...EffectArray.map(bundle.observations, observation => observation.responseBytes)),
    warmIncrementalMilliseconds,
    warmupCountMinimum: Math.min(
      ...EffectArray.map(warmObservations, observation => observation.warmIncremental?.warmups ?? 0),
    ),
    worstCaseEstimatedTokensMaximum: Math.max(...worstCases),
  };
  const failures = gateFailures(fixture.thresholds, metrics, warmSamples.length).sort(compareText);
  return {
    fixture: {hash: codeMemoryLinkBenchFixtureHash(fixture), id: fixture.id, queryCount: fixture.queries.length},
    gate: {failures, passed: failures.length === 0},
    metrics,
    queries: EffectArray.map(evaluated, result => result.public),
    version: CODE_MEMORY_LINK_BENCH_VERSION,
  };
}

interface EvaluatedQuery {
  readonly currentClaimCount: number;
  readonly exactClean: boolean;
  readonly public: CodeMemoryLinkBenchQueryResultV1;
  readonly relocationInclusive: boolean;
}

function evaluateQuery(
  query: CodeMemoryLinkBenchQueryV1,
  observation: CodeMemoryLinkBenchObservationV1,
): EvaluatedQuery {
  const unique = uniqueRankedMemories(observation.rankedMemories);
  const visibleTop = unique.slice(0, CODE_MEMORY_LINK_BENCH_APPROVED_THRESHOLDS.k);
  const codeCitationLane = EffectArray.filter(unique, memory => memory.selectionBasis === 'code-citation');
  const codeCitationTop = codeCitationLane.slice(0, CODE_MEMORY_LINK_BENCH_APPROVED_THRESHOLDS.k);
  const judgments = new Map(EffectArray.map(query.judgments, judgment => [judgment.uri, judgment]));
  const direct = EffectArray.filter(query.judgments, judgment => judgment.label === 'direct-current');
  const codeCitationTruth = EffectArray.filter(
    query.judgments,
    judgment => judgment.label === 'direct-current' || judgment.label === 'historical-warning',
  );
  const firstVisible = unique[0];
  const directFirst =
    direct.length === 0
      ? null
      : firstVisible !== undefined &&
        judgments.get(firstVisible.uri)?.label === 'direct-current' &&
        satisfiesJudgment(firstVisible, judgments.get(firstVisible.uri)!);
  const falseCurrentCount = EffectArray.filter(unique, memory => {
    const truth = judgments.get(memory.uri)?.label ?? 'irrelevant-harmful';
    return truth !== 'direct-current' && claimsCurrent(memory);
  }).length;
  const currentClaimCount = EffectArray.filter(
    unique,
    (__effectFilterValue: (typeof unique)[number], __effectFilterIndex: number) =>
      __effectFilterIndex in unique && claimsCurrent(__effectFilterValue),
  ).length;
  return {
    currentClaimCount,
    exactClean: query.scenario === 'exact-file' || query.scenario === 'exact-symbol',
    public: {
      codeCitationRankedUris: EffectArray.map(codeCitationLane, memory => memory.uri),
      codeCitationNoAnswerCorrect: codeCitationTruth.length === 0 ? codeCitationLane.length === 0 : null,
      directCodeCitationPrecisionAt3:
        codeCitationTruth.length === 0
          ? null
          : codeCitationTop.length === 0
            ? 0
            : EffectArray.filter(codeCitationTop, memory => {
                const judgment = judgments.get(memory.uri);
                return (
                  judgment !== undefined &&
                  (judgment.label === 'direct-current' || judgment.label === 'historical-warning') &&
                  satisfiesJudgment(memory, judgment)
                );
              }).length / codeCitationTop.length,
      coverageCorrect: sameCoverage(query.expectedCoverage, observation.coverage),
      directFirst,
      duplicateResultCount: observation.rankedMemories.length - unique.length,
      falseCurrentCount,
      id: query.id,
      ndcgAt3: ndcgAt3(visibleTop, query.judgments),
      rankedUris: EffectArray.map(unique, memory => memory.uri),
      recallAt3: ratio(
        EffectArray.filter(codeCitationTop, memory => {
          const judgment = judgments.get(memory.uri);
          return judgment?.label === 'direct-current' && satisfiesJudgment(memory, judgment);
        }).length,
        direct.length,
        1,
      ),
    },
    relocationInclusive: direct.length > 0,
  };
}

function gateFailures(
  thresholds: CodeMemoryLinkBenchThresholdsV1,
  metrics: CodeMemoryLinkBenchMetricsV1,
  warmSampleCount: number,
): string[] {
  const failures: string[] = [];
  minimum(failures, 'exact clean Recall@3', metrics.exactCleanRecallAt3, thresholds.exactCleanRecallAt3Minimum);
  minimum(
    failures,
    'relocation-inclusive Recall@3',
    metrics.relocationInclusiveRecallAt3,
    thresholds.relocationInclusiveRecallAt3Minimum,
  );
  minimum(
    failures,
    'direct code-citation Precision@3',
    metrics.directCodeCitationPrecisionAt3,
    thresholds.directCodeCitationPrecisionAt3Minimum,
  );
  minimum(failures, 'direct-first rate', metrics.directFirstRate, thresholds.directFirstRateMinimum);
  minimum(failures, 'coverage accuracy', metrics.coverageAccuracy, thresholds.coverageAccuracyMinimum);
  minimum(
    failures,
    'code-citation no-answer accuracy',
    metrics.codeCitationNoAnswerAccuracy,
    thresholds.codeCitationNoAnswerAccuracyMinimum,
  );
  maximum(failures, 'false-current rate', metrics.falseCurrentRate, thresholds.falseCurrentRateMaximum);
  maximum(
    failures,
    'default estimated tokens',
    metrics.defaultEstimatedTokensMaximum,
    thresholds.defaultEstimatedTokensMaximum,
  );
  maximum(
    failures,
    'worst-case estimated tokens',
    metrics.worstCaseEstimatedTokensMaximum,
    thresholds.worstCaseEstimatedTokensMaximum,
  );
  if (metrics.duplicateResultCount !== 0) {
    failures.push(`duplicate ranked result count ${metrics.duplicateResultCount}; required 0`);
  }
  if (warmSampleCount < CODE_MEMORY_LINK_BENCH_MINIMUM_WARM_SAMPLES) {
    failures.push(
      `warm incremental samples ${warmSampleCount}; minimum ${CODE_MEMORY_LINK_BENCH_MINIMUM_WARM_SAMPLES}`,
    );
  }
  if (metrics.warmupCountMinimum < CODE_MEMORY_LINK_BENCH_MINIMUM_WARMUPS) {
    failures.push(`warmup count ${metrics.warmupCountMinimum}; minimum ${CODE_MEMORY_LINK_BENCH_MINIMUM_WARMUPS}`);
  }
  if (metrics.warmIncrementalMilliseconds !== null) {
    maximum(
      failures,
      'warm incremental p95 milliseconds',
      metrics.warmIncrementalMilliseconds.p95,
      thresholds.warmIncrementalP95MillisecondsMaximum,
    );
  }
  return failures;
}

function parseThresholds(value: unknown): CodeMemoryLinkBenchThresholdsV1 {
  const thresholds = record(value, 'thresholds');
  exactKeys(thresholds, EffectRecord.keys(CODE_MEMORY_LINK_BENCH_APPROVED_THRESHOLDS));
  for (const [key, expected] of EffectRecord.toEntries(CODE_MEMORY_LINK_BENCH_APPROVED_THRESHOLDS)) {
    if (thresholds[key] !== expected) invalid(`threshold ${key} must equal ${expected}`);
  }
  return CODE_MEMORY_LINK_BENCH_APPROVED_THRESHOLDS;
}

function parseQuery(value: unknown): CodeMemoryLinkBenchQueryV1 {
  const query = record(value, 'query');
  exactKeys(query, [
    'budgetClass',
    'codeRefs',
    'expectedCoverage',
    'id',
    'judgments',
    'measureWarmIncrementalLatency',
    'scenario',
    'task',
  ]);
  const codeRefs = stringArray(query.codeRefs, 'query codeRefs');
  if (codeRefs.length === 0 || codeRefs.length > 8) invalid('query codeRefs must contain 1-8 values');
  assertUnique(codeRefs, 'query codeRefs');
  if (!EffectArray.isArray(query.judgments)) invalid('query judgments must be an array');
  const judgments = EffectArray.map(query.judgments, parseJudgment);
  assertUnique(
    EffectArray.map(judgments, judgment => judgment.uri),
    'judgment uris',
  );
  const scenario = literal(query.scenario, CODE_MEMORY_LINK_BENCH_SCENARIO_KINDS, 'query scenario');
  if (scenario === 'exact-file' || scenario === 'exact-symbol' || scenario === 'relocated-symbol') {
    if (!EffectArray.some(judgments, judgment => judgment.label === 'direct-current')) {
      invalid(`scenario ${scenario} requires direct-current truth`);
    }
  }
  const expectedCoverage = parseCoverage(query.expectedCoverage);
  if (expectedCoverage.requested !== codeRefs.length) {
    invalid('expected coverage requested count must equal query codeRefs');
  }
  if (
    expectedCoverage.matchedMemories >
    EffectArray.filter(judgments, judgment => judgment.label !== 'irrelevant-harmful').length
  ) {
    invalid('expected matched memories exceed judged useful memories');
  }
  return {
    budgetClass: literal(query.budgetClass, ['default', 'worst-case'] as const, 'query budget class'),
    codeRefs: [...codeRefs].sort(compareText),
    expectedCoverage,
    id: nonEmptyString(query.id, 'query id'),
    judgments: [...judgments].sort((left, right) => compareText(left.uri, right.uri)),
    measureWarmIncrementalLatency: boolean(query.measureWarmIncrementalLatency, 'latency flag'),
    scenario,
    task: nonEmptyString(query.task, 'query task'),
  };
}

function parseJudgment(value: unknown): CodeMemoryLinkBenchJudgmentV1 {
  const judgment = record(value, 'judgment');
  exactKeys(judgment, ['expectedStatus', 'label', 'uri']);
  const label = literal(judgment.label, CODE_MEMORY_LINK_BENCH_LABELS, 'judgment label');
  const expectedStatus = literal(judgment.expectedStatus, CODE_MEMORY_LINK_BENCH_STATUSES, 'expected status');
  if (label === 'direct-current' && expectedStatus !== 'exact' && expectedStatus !== 'relocated') {
    invalid('direct-current truth must expect exact or relocated status');
  }
  if (
    label === 'historical-warning' &&
    expectedStatus !== 'changed' &&
    expectedStatus !== 'deleted' &&
    expectedStatus !== 'unknown'
  ) {
    invalid('historical-warning truth must expect changed, deleted, or unknown status');
  }
  return {expectedStatus, label, uri: nonEmptyString(judgment.uri, 'judgment uri')};
}

function parseObservation(value: unknown): CodeMemoryLinkBenchObservationV1 {
  const observation = record(value, 'observation');
  exactKeys(
    observation,
    [
      'coverage',
      'elapsedMilliseconds',
      'estimatedTokens',
      'queryId',
      'rankedMemories',
      'responseBytes',
      'warmIncremental',
    ],
    ['coverage', 'elapsedMilliseconds', 'estimatedTokens', 'queryId', 'rankedMemories', 'responseBytes'],
  );
  if (!EffectArray.isArray(observation.rankedMemories)) invalid('rankedMemories must be an array');
  const warm =
    observation.warmIncremental === undefined ? undefined : parseWarmIncremental(observation.warmIncremental);
  return {
    coverage: parseCoverage(observation.coverage),
    elapsedMilliseconds: nonNegativeFinite(observation.elapsedMilliseconds, 'elapsed milliseconds'),
    estimatedTokens: nonNegativeInteger(observation.estimatedTokens, 'estimated tokens'),
    queryId: nonEmptyString(observation.queryId, 'observation query id'),
    rankedMemories: EffectArray.map(observation.rankedMemories, parseRankedMemory),
    responseBytes: nonNegativeInteger(observation.responseBytes, 'response bytes'),
    ...(warm === undefined ? {} : {warmIncremental: warm}),
  };
}

function parseRankedMemory(value: unknown): CodeMemoryLinkBenchRankedMemoryV1 {
  const memory = record(value, 'ranked memory');
  exactKeys(memory, ['freshness', 'relationStatus', 'selectionBasis', 'uri']);
  return {
    freshness: literal(memory.freshness, ['fresh', 'stale', 'unknown'] as const, 'memory freshness'),
    relationStatus:
      memory.relationStatus === null
        ? null
        : literal(memory.relationStatus, CODE_MEMORY_LINK_BENCH_STATUSES, 'relation status'),
    selectionBasis: literal(memory.selectionBasis, ['code-citation', 'lexical'] as const, 'selection basis'),
    uri: nonEmptyString(memory.uri, 'ranked memory uri'),
  };
}

function parseCoverage(value: unknown): CodeMemoryLinkBenchCoverageV1 {
  const coverage = record(value, 'coverage');
  exactKeys(
    coverage,
    ['complete', 'matchedMemories', 'requested', 'resolved', 'unresolvedOrdinals'],
    ['complete', 'matchedMemories', 'requested', 'resolved'],
  );
  const unresolvedOrdinals =
    coverage.unresolvedOrdinals === undefined
      ? undefined
      : nonNegativeIntegerArray(coverage.unresolvedOrdinals, 'coverage unresolved ordinals');
  const parsed = {
    complete: boolean(coverage.complete, 'coverage complete'),
    matchedMemories: nonNegativeInteger(coverage.matchedMemories, 'coverage matched memories'),
    requested: nonNegativeInteger(coverage.requested, 'coverage requested'),
    resolved: nonNegativeInteger(coverage.resolved, 'coverage resolved'),
    ...(unresolvedOrdinals === undefined ? {} : {unresolvedOrdinals}),
  };
  if (parsed.resolved > parsed.requested) invalid('coverage resolved cannot exceed requested');
  if (parsed.complete !== (parsed.resolved === parsed.requested))
    invalid('coverage completeness must match resolution');
  if (
    unresolvedOrdinals !== undefined &&
    (EffectArray.some(
      unresolvedOrdinals,
      (ordinal, index) => ordinal >= parsed.requested || ordinal <= (unresolvedOrdinals[index - 1] ?? -1),
    ) ||
      parsed.resolved + unresolvedOrdinals.length !== parsed.requested)
  ) {
    invalid('coverage unresolved ordinals must be the ordered unresolved complement');
  }
  return parsed;
}

function parseWarmIncremental(value: unknown): NonNullable<CodeMemoryLinkBenchObservationV1['warmIncremental']> {
  const warm = record(value, 'warm incremental measurement');
  exactKeys(warm, ['milliseconds', 'warmups']);
  if (!EffectArray.isArray(warm.milliseconds)) invalid('warm incremental milliseconds must be an array');
  return {
    milliseconds: EffectArray.map(warm.milliseconds, value =>
      nonNegativeFinite(value, 'warm incremental milliseconds'),
    ),
    warmups: nonNegativeInteger(warm.warmups, 'warmup count'),
  };
}

function uniqueRankedMemories(
  memories: readonly CodeMemoryLinkBenchRankedMemoryV1[],
): readonly CodeMemoryLinkBenchRankedMemoryV1[] {
  const seen = new Set<string>();
  return EffectArray.filter(memories, memory => !seen.has(memory.uri) && !!seen.add(memory.uri));
}

function claimsCurrent(memory: CodeMemoryLinkBenchRankedMemoryV1): boolean {
  return (
    memory.relationStatus === 'exact' ||
    memory.relationStatus === 'relocated' ||
    (memory.selectionBasis === 'code-citation' && memory.freshness === 'fresh')
  );
}

function relevanceGrade(label: CodeMemoryLinkBenchLabel): number {
  return label === 'direct-current' ? 3 : label === 'historical-warning' ? 2 : label === 'supporting' ? 1 : 0;
}

function ndcgAt3(
  rankedMemories: readonly CodeMemoryLinkBenchRankedMemoryV1[],
  judgments: readonly CodeMemoryLinkBenchJudgmentV1[],
): number {
  const byUri = new Map(EffectArray.map(judgments, judgment => [judgment.uri, judgment]));
  const actual = dcg(
    EffectArray.map(rankedMemories, memory => {
      const judgment = byUri.get(memory.uri);
      return judgment === undefined || !satisfiesJudgment(memory, judgment) ? 0 : relevanceGrade(judgment.label);
    }),
  );
  const idealGrades = EffectArray.map(judgments, judgment => relevanceGrade(judgment.label))
    .sort((left, right) => right - left)
    .slice(0, CODE_MEMORY_LINK_BENCH_APPROVED_THRESHOLDS.k);
  const ideal = dcg(idealGrades);
  if (ideal === 0) return rankedMemories.length === 0 ? 1 : 0;
  return actual / ideal;
}

function satisfiesJudgment(
  memory: CodeMemoryLinkBenchRankedMemoryV1,
  judgment: CodeMemoryLinkBenchJudgmentV1,
): boolean {
  switch (judgment.label) {
    case 'direct-current':
      return (
        memory.selectionBasis === 'code-citation' &&
        memory.freshness === 'fresh' &&
        memory.relationStatus === judgment.expectedStatus
      );
    case 'historical-warning':
      return (
        memory.selectionBasis === 'code-citation' &&
        memory.relationStatus === judgment.expectedStatus &&
        (judgment.expectedStatus === 'unknown' ? memory.freshness === 'unknown' : memory.freshness !== 'fresh')
      );
    case 'supporting':
      return memory.selectionBasis === 'lexical' && !claimsCurrent(memory);
    case 'irrelevant-harmful':
      return false;
  }
}

function dcg(grades: readonly number[]): number {
  return EffectArray.reduce(grades, 0, (total, grade, index) => total + (2 ** grade - 1) / Math.log2(index + 2));
}

function sameCoverage(left: CodeMemoryLinkBenchCoverageV1, right: CodeMemoryLinkBenchCoverageV1): boolean {
  return (
    left.complete === right.complete &&
    left.matchedMemories === right.matchedMemories &&
    left.requested === right.requested &&
    left.resolved === right.resolved
  );
}

function minimum(failures: string[], label: string, actual: number, expected: number): void {
  if (actual < expected) failures.push(`${label} ${format(actual)}; minimum ${format(expected)}`);
}

function maximum(failures: string[], label: string, actual: number, expected: number): void {
  if (actual > expected) failures.push(`${label} ${format(actual)}; maximum ${format(expected)}`);
}

function ratio(numerator: number, denominator: number, empty: number): number {
  return denominator === 0 ? empty : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : EffectArray.reduce(values, 0, (total, value) => total + value) / values.length;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6);
}

function stringArray(value: unknown, label: string): string[] {
  if (!EffectArray.isArray(value)) invalid(`${label} must be an array`);
  return EffectArray.map(value, item => nonEmptyString(item, label));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required = allowed): void {
  if (
    EffectArray.some(EffectRecord.keys(value), key => !allowed.includes(key)) ||
    EffectArray.some(required, key => !EffectRecord.has(value, key))
  ) {
    invalid('object has unsupported or missing fields');
  }
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Effect.pipe(value, EffectString.trim))
    invalid(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeIntegerArray(value: unknown, label: string): number[] {
  if (!EffectArray.isArray(value)) invalid(`${label} must be an array`);
  return EffectArray.map(value, item => nonNegativeInteger(item, label));
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`${label} must be non-negative`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
  throw new Error(`Invalid CodeMemoryLinkBench v1: ${message}.`);
}
