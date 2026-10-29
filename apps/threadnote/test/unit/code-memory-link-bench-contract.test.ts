import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_BENCH_APPROVED_THRESHOLDS,
  CODE_MEMORY_LINK_BENCH_ID,
  CODE_MEMORY_LINK_BENCH_SCENARIO_KINDS,
  codeMemoryLinkBenchFixtureHash,
  evaluateCodeMemoryLinkBench,
  parseCodeMemoryLinkBenchFixtureV1,
  parseCodeMemoryLinkBenchObservationBundleV1,
  serializeCodeMemoryLinkBenchFixtureIdentity,
  type CodeMemoryLinkBenchCoverageV1,
  type CodeMemoryLinkBenchFixtureV1,
  type CodeMemoryLinkBenchJudgmentV1,
  type CodeMemoryLinkBenchObservationBundleV1,
  type CodeMemoryLinkBenchObservationV1,
  type CodeMemoryLinkBenchQueryV1,
  type CodeMemoryLinkBenchRankedMemoryV1,
  type CodeMemoryLinkBenchScenarioKind,
  type CodeMemoryLinkBenchThresholdsV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-bench-contract';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('CodeMemoryLinkBench contract', () => {
  it('passes the reviewed retrieval, safety, coverage, latency, and budget gates', () => {
    const result = evaluateCodeMemoryLinkBench(FIXTURE, OBSERVATIONS);

    expect(result.gate).toEqual({failures: [], passed: true});
    expect(result.metrics).toMatchObject({
      coverageAccuracy: 1,
      defaultEstimatedTokensMaximum: 1_200,
      directFirstRate: 1,
      duplicateResultCount: 0,
      exactCleanRecallAt3: 1,
      falseCurrentCount: 0,
      falseCurrentRate: 0,
      meanNdcgAt3: 1,
      codeCitationNoAnswerAccuracy: 1,
      directCodeCitationPrecisionAt3: 1,
      directCodeCitationPrecisionQueryCount: 9,
      relocationInclusiveRecallAt3: 1,
      warmupCountMinimum: 5,
      worstCaseEstimatedTokensMaximum: 1_400,
    });
    expect(result.metrics.warmIncrementalMilliseconds).toMatchObject({p95: 200, samples: 25});
  });

  it('accepts the bounded unresolved-anchor recovery field without changing frozen coverage truth', () => {
    const queryId = EffectOption.getOrUndefined(
      EffectArray.findFirst(FIXTURE.queries, query => query.scenario === 'stale-graph'),
    )!.id;
    const candidate = {
      ...OBSERVATIONS,
      observations: EffectArray.map(OBSERVATIONS.observations, observation =>
        observation.queryId === queryId
          ? {...observation, coverage: {...observation.coverage, unresolvedOrdinals: [0]}}
          : observation,
      ),
    };

    const parsed = parseCodeMemoryLinkBenchObservationBundleV1(candidate, FIXTURE);
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(parsed.observations, observation => observation.queryId === queryId),
      )?.coverage,
    ).toEqual({
      ...INCOMPLETE_COVERAGE,
      unresolvedOrdinals: [0],
    });
    expect(evaluateCodeMemoryLinkBench(FIXTURE, candidate).gate).toEqual({failures: [], passed: true});
  });

  it('rejects unresolved-anchor ordinals outside the requested coverage', () => {
    const queryId = EffectOption.getOrUndefined(
      EffectArray.findFirst(FIXTURE.queries, query => query.scenario === 'stale-graph'),
    )!.id;
    const candidate = {
      ...OBSERVATIONS,
      observations: EffectArray.map(OBSERVATIONS.observations, observation =>
        observation.queryId === queryId
          ? {...observation, coverage: {...observation.coverage, unresolvedOrdinals: [1]}}
          : observation,
      ),
    };

    expect(() => parseCodeMemoryLinkBenchObservationBundleV1(candidate, FIXTURE)).toThrow(
      'unresolved ordinals must be the ordered unresolved complement',
    );
  });

  it.each([
    ['k', 4],
    ['directFirstRateMinimum', 0.99],
    ['exactCleanRecallAt3Minimum', 0.99],
    ['relocationInclusiveRecallAt3Minimum', 0.94],
    ['codeCitationNoAnswerAccuracyMinimum', 0.99],
    ['directCodeCitationPrecisionAt3Minimum', 0.89],
    ['falseCurrentRateMaximum', 0.01],
    ['coverageAccuracyMinimum', 0.99],
    ['warmIncrementalP95MillisecondsMaximum', 251],
    ['defaultEstimatedTokensMaximum', 1_251],
    ['worstCaseEstimatedTokensMaximum', 1_501],
  ] satisfies ReadonlyArray<readonly [keyof CodeMemoryLinkBenchThresholdsV1, number]>)(
    'rejects a weakened %s threshold',
    (key, value) => {
      const candidate = {...FIXTURE, thresholds: {...FIXTURE.thresholds, [key]: value}};
      expect(() => parseCodeMemoryLinkBenchFixtureV1(candidate)).toThrow(`threshold ${key}`);
    },
  );

  it('is invariant to set-like fixture and observation ordering', () => {
    const expected = evaluateCodeMemoryLinkBench(FIXTURE, OBSERVATIONS);
    fc.assert(
      fc.property(
        fc.record({
          queryOffset: fc.nat({max: FIXTURE.queries.length - 1}),
          reverseCodeRefs: fc.boolean(),
          reverseJudgments: fc.boolean(),
          observationOffset: fc.nat({max: OBSERVATIONS.observations.length - 1}),
        }),
        ({observationOffset, queryOffset, reverseCodeRefs, reverseJudgments}) => {
          const fixture: CodeMemoryLinkBenchFixtureV1 = {
            ...FIXTURE,
            queries: EffectArray.map(rotate(FIXTURE.queries, queryOffset), query => ({
              ...query,
              codeRefs: reverseCodeRefs ? [...query.codeRefs].reverse() : query.codeRefs,
              judgments: reverseJudgments ? [...query.judgments].reverse() : query.judgments,
            })),
          };
          const observations: CodeMemoryLinkBenchObservationBundleV1 = {
            ...OBSERVATIONS,
            observations: rotate(OBSERVATIONS.observations, observationOffset),
          };
          expect(codeMemoryLinkBenchFixtureHash(fixture)).toBe(codeMemoryLinkBenchFixtureHash(FIXTURE));
          expect(serializeCodeMemoryLinkBenchFixtureIdentity(fixture)).toBe(
            serializeCodeMemoryLinkBenchFixtureIdentity(FIXTURE),
          );
          expect(evaluateCodeMemoryLinkBench(fixture, observations)).toEqual(expected);
        },
      ),
      {numRuns: 50},
    );
  });

  it('deduplicates ranked URIs before scoring and reports every duplicate', () => {
    const baseline = evaluateCodeMemoryLinkBench(FIXTURE, OBSERVATIONS);
    fc.assert(
      fc.property(fc.integer({min: 1, max: 12}), duplicateCount => {
        const candidate = replaceObservation(OBSERVATIONS, 'exact-symbol', observation => {
          const first = observation.rankedMemories[0];
          return {
            ...observation,
            rankedMemories: [
              first,
              ...Array.from({length: duplicateCount}, () => first),
              ...observation.rankedMemories.slice(1),
            ],
          };
        });
        const result = evaluateCodeMemoryLinkBench(FIXTURE, candidate);
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(result.queries, query => query.id === 'exact-symbol')),
        ).toMatchObject({
          duplicateResultCount: duplicateCount,
          ndcgAt3: EffectOption.getOrUndefined(
            EffectArray.findFirst(baseline.queries, query => query.id === 'exact-symbol'),
          )!.ndcgAt3,
          directCodeCitationPrecisionAt3: EffectOption.getOrUndefined(
            EffectArray.findFirst(baseline.queries, query => query.id === 'exact-symbol'),
          )!.directCodeCitationPrecisionAt3,
          recallAt3: EffectOption.getOrUndefined(
            EffectArray.findFirst(baseline.queries, query => query.id === 'exact-symbol'),
          )!.recallAt3,
        });
        expect(result.metrics.duplicateResultCount).toBe(duplicateCount);
        expect(result.gate.failures).toContain(`duplicate ranked result count ${duplicateCount}; required 0`);
      }),
      {numRuns: 30},
    );
  });

  it('scores direct code-citation Recall/Precision@3 while preserving visible ordering safety', () => {
    const candidate = replaceObservation(OBSERVATIONS, 'exact-symbol', observation => {
      const direct = observation.rankedMemories[0];
      const lexicalDecoy: CodeMemoryLinkBenchRankedMemoryV1 = {
        freshness: 'unknown',
        relationStatus: null,
        selectionBasis: 'lexical',
        uri: `${direct.uri}.lexical-decoy`,
      };
      return {...observation, rankedMemories: [lexicalDecoy, direct]};
    });

    const baseline = evaluateCodeMemoryLinkBench(FIXTURE, OBSERVATIONS);
    const result = evaluateCodeMemoryLinkBench(FIXTURE, candidate);
    const query = EffectOption.getOrUndefined(
      EffectArray.findFirst(result.queries, query => query.id === 'exact-symbol'),
    )!;
    expect(query).toMatchObject({
      directFirst: false,
      directCodeCitationPrecisionAt3: 1,
      recallAt3: 1,
    });
    expect(query.codeCitationRankedUris).toEqual([query.rankedUris[1]]);
    expect(query.ndcgAt3).toBeLessThan(
      EffectOption.getOrUndefined(EffectArray.findFirst(baseline.queries, query => query.id === 'exact-symbol'))!
        .ndcgAt3,
    );
    expect(
      EffectArray.some(result.gate.failures, failure =>
        Effect.pipe(failure, EffectString.startsWith('direct-first rate')),
      ),
    ).toBe(true);
  });

  it('does not let empty no-answer controls dilute a 0.333 direct-query Precision@3', () => {
    const lowPrecision = replaceObservation(OBSERVATIONS, 'exact-symbol', observation => {
      const direct = observation.rankedMemories[0];
      const harmful = (suffix: string): CodeMemoryLinkBenchRankedMemoryV1 => ({
        freshness: 'unknown',
        relationStatus: 'unknown',
        selectionBasis: 'code-citation',
        uri: `${direct.uri}.${suffix}`,
      });
      return {...observation, rankedMemories: [direct, harmful('harmful-a'), harmful('harmful-b')]};
    });
    const beforeControls = evaluateCodeMemoryLinkBench(FIXTURE, lowPrecision);
    const controls = Array.from({length: 20}, (_, index) => emptyControl(index));
    const fixtureWithControls: CodeMemoryLinkBenchFixtureV1 = {
      ...FIXTURE,
      queries: [...FIXTURE.queries, ...EffectArray.map(controls, control => control.query)],
    };
    const observationsWithControls: CodeMemoryLinkBenchObservationBundleV1 = {
      ...lowPrecision,
      observations: [...lowPrecision.observations, ...EffectArray.map(controls, control => control.observation)],
    };
    const afterControls = evaluateCodeMemoryLinkBench(fixtureWithControls, observationsWithControls);

    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(beforeControls.queries, query => query.id === 'exact-symbol'))!
        .directCodeCitationPrecisionAt3,
    ).toBeCloseTo(1 / 3);
    expect(beforeControls.metrics.directCodeCitationPrecisionQueryCount).toBe(9);
    expect(afterControls.metrics.directCodeCitationPrecisionQueryCount).toBe(
      beforeControls.metrics.directCodeCitationPrecisionQueryCount,
    );
    expect(afterControls.metrics.directCodeCitationPrecisionAt3).toBe(
      beforeControls.metrics.directCodeCitationPrecisionAt3,
    );
    expect(
      EffectArray.every(
        EffectArrayPipe(afterControls.queries, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (query, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues &&
              Effect.pipe(query.id, EffectString.startsWith('empty-control-')),
          ),
        ),
        query => query.directCodeCitationPrecisionAt3 === null,
      ),
    ).toBe(true);
  });

  it('fails a no-answer control that leaks an unknown code-citation result', () => {
    const control = emptyControl(0);
    const leaked: CodeMemoryLinkBenchRankedMemoryV1 = {
      freshness: 'unknown',
      relationStatus: 'unknown',
      selectionBasis: 'code-citation',
      uri: 'threadnote://user/benchmark/memories/leaked-unknown.md',
    };
    const fixture: CodeMemoryLinkBenchFixtureV1 = {...FIXTURE, queries: [...FIXTURE.queries, control.query]};
    const observations: CodeMemoryLinkBenchObservationBundleV1 = {
      ...OBSERVATIONS,
      observations: [...OBSERVATIONS.observations, {...control.observation, rankedMemories: [leaked]}],
    };

    const result = evaluateCodeMemoryLinkBench(fixture, observations);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.queries, query => query.id === control.query.id))
        ?.codeCitationNoAnswerCorrect,
    ).toBe(false);
    expect(result.gate.failures).toContain('code-citation no-answer accuracy 0.857143; minimum 1');
  });

  it('fails closed when a result below the visible top three is mutated into a lexical current claim', () => {
    fc.assert(
      fc.property(fc.constantFrom('changed', 'deleted', 'ambiguous-relocation'), queryId => {
        const candidate = replaceObservation(OBSERVATIONS, queryId, observation => ({
          ...observation,
          rankedMemories: [
            ...observation.rankedMemories,
            ...Array.from({length: 3}, (_, index): CodeMemoryLinkBenchRankedMemoryV1 => ({
              freshness: 'unknown',
              relationStatus: null,
              selectionBasis: 'lexical',
              uri: `threadnote://user/benchmark/memories/decoys/${queryId}-${index}.md`,
            })),
            {
              freshness: 'fresh',
              relationStatus: 'exact',
              selectionBasis: 'lexical',
              uri: `threadnote://user/benchmark/memories/false-current/${queryId}.md`,
            },
          ],
        }));
        const result = evaluateCodeMemoryLinkBench(FIXTURE, candidate);
        expect(result.metrics.falseCurrentCount).toBe(1);
        expect(result.metrics.falseCurrentRate).toBeGreaterThan(0);
        expect(result.gate.passed).toBe(false);
        expect(
          EffectArray.some(result.gate.failures, failure =>
            Effect.pipe(failure, EffectString.startsWith('false-current rate')),
          ),
        ).toBe(true);
      }),
      {numRuns: 30},
    );
  });
});

const CURRENT_COVERAGE: CodeMemoryLinkBenchCoverageV1 = {
  complete: true,
  matchedMemories: 1,
  requested: 1,
  resolved: 1,
};
const NO_MATCH_COVERAGE: CodeMemoryLinkBenchCoverageV1 = {
  complete: true,
  matchedMemories: 0,
  requested: 1,
  resolved: 1,
};
const INCOMPLETE_COVERAGE: CodeMemoryLinkBenchCoverageV1 = {
  complete: false,
  matchedMemories: 0,
  requested: 1,
  resolved: 0,
};

const FIXTURE: CodeMemoryLinkBenchFixtureV1 = {
  id: CODE_MEMORY_LINK_BENCH_ID,
  queries: EffectArray.map(CODE_MEMORY_LINK_BENCH_SCENARIO_KINDS, queryForScenario),
  thresholds: CODE_MEMORY_LINK_BENCH_APPROVED_THRESHOLDS,
  version: 1,
};

const OBSERVATIONS: CodeMemoryLinkBenchObservationBundleV1 = {
  fixtureId: CODE_MEMORY_LINK_BENCH_ID,
  observations: EffectArray.map(FIXTURE.queries, observationForQuery),
  version: 1,
};

function queryForScenario(scenario: CodeMemoryLinkBenchScenarioKind): CodeMemoryLinkBenchQueryV1 {
  const judgments = judgmentsForScenario(scenario);
  const incomplete = scenario === 'stale-graph';
  const matchedMemories = EffectArray.some(judgments, judgment => judgment.label !== 'irrelevant-harmful');
  return {
    budgetClass: scenario === 'high-noise-budget' ? 'worst-case' : 'default',
    codeRefs: [`src/${scenario}.ts`],
    expectedCoverage: incomplete ? INCOMPLETE_COVERAGE : matchedMemories ? CURRENT_COVERAGE : NO_MATCH_COVERAGE,
    id: scenario,
    judgments,
    measureWarmIncrementalLatency: scenario === 'high-noise-budget',
    scenario,
    task: `Evaluate ${scenario} memory backlinks.`,
  };
}

function judgmentsForScenario(scenario: CodeMemoryLinkBenchScenarioKind): readonly CodeMemoryLinkBenchJudgmentV1[] {
  const uri = `threadnote://user/benchmark/memories/durable/projects/threadnote/${scenario}.md`;
  switch (scenario) {
    case 'exact-symbol':
    case 'exact-file':
    case 'dirty-overlay':
      return [{expectedStatus: 'exact', label: 'direct-current', uri}];
    case 'relocated-symbol':
      return [{expectedStatus: 'relocated', label: 'direct-current', uri}];
    case 'changed':
      return [{expectedStatus: 'changed', label: 'historical-warning', uri}];
    case 'deleted':
      return [{expectedStatus: 'deleted', label: 'historical-warning', uri}];
    case 'ambiguous-relocation':
      return [{expectedStatus: 'unknown', label: 'historical-warning', uri}];
    case 'conflicting-topic':
      return [
        {expectedStatus: 'exact', label: 'direct-current', uri},
        {expectedStatus: 'unknown', label: 'irrelevant-harmful', uri: `${uri}.decoy`},
      ];
    case 'high-noise-budget':
      return [
        {expectedStatus: 'exact', label: 'direct-current', uri},
        {expectedStatus: 'unknown', label: 'supporting', uri: `${uri}.supporting`},
        {expectedStatus: 'unknown', label: 'irrelevant-harmful', uri: `${uri}.noise`},
      ];
    case 'cross-repository-collision':
    case 'archived':
    case 'superseded':
    case 'malformed-citation':
    case 'stale-graph':
    case 'legacy-uncited':
      return [{expectedStatus: 'unknown', label: 'irrelevant-harmful', uri}];
  }
}

function observationForQuery(query: CodeMemoryLinkBenchQueryV1): CodeMemoryLinkBenchObservationV1 {
  const rankedMemories = EffectArray.map(
    EffectArray.filter(query.judgments, judgment => judgment.label !== 'irrelevant-harmful').sort(
      (left, right) => labelRank(left.label) - labelRank(right.label),
    ),
    memoryForJudgment,
  );
  return {
    coverage: query.expectedCoverage,
    elapsedMilliseconds: 200,
    estimatedTokens: query.budgetClass === 'default' ? 1_200 : 1_400,
    queryId: query.id,
    rankedMemories,
    responseBytes: 3_600,
    ...(query.measureWarmIncrementalLatency
      ? {warmIncremental: {milliseconds: Array.from({length: 25}, () => 200), warmups: 5}}
      : {}),
  };
}

function emptyControl(index: number): {
  readonly observation: CodeMemoryLinkBenchObservationV1;
  readonly query: CodeMemoryLinkBenchQueryV1;
} {
  const id = `empty-control-${index}`;
  const query: CodeMemoryLinkBenchQueryV1 = {
    budgetClass: 'default',
    codeRefs: [`src/${id}.ts`],
    expectedCoverage: NO_MATCH_COVERAGE,
    id,
    judgments: [
      {
        expectedStatus: 'unknown',
        label: 'irrelevant-harmful',
        uri: `threadnote://user/benchmark/memories/controls/${id}.md`,
      },
    ],
    measureWarmIncrementalLatency: false,
    scenario: 'legacy-uncited',
    task: `Verify ${id} returns no linked memories.`,
  };
  return {
    observation: {
      coverage: NO_MATCH_COVERAGE,
      elapsedMilliseconds: 200,
      estimatedTokens: 1_200,
      queryId: id,
      rankedMemories: [],
      responseBytes: 3_600,
    },
    query,
  };
}

function memoryForJudgment(judgment: CodeMemoryLinkBenchJudgmentV1): CodeMemoryLinkBenchRankedMemoryV1 {
  return {
    freshness:
      judgment.expectedStatus === 'changed' || judgment.expectedStatus === 'deleted'
        ? 'stale'
        : judgment.expectedStatus === 'unknown'
          ? 'unknown'
          : 'fresh',
    relationStatus: judgment.label === 'supporting' ? null : judgment.expectedStatus,
    selectionBasis: judgment.label === 'supporting' ? 'lexical' : 'code-citation',
    uri: judgment.uri,
  };
}

function labelRank(label: CodeMemoryLinkBenchJudgmentV1['label']): number {
  return label === 'direct-current' ? 0 : label === 'historical-warning' ? 1 : label === 'supporting' ? 2 : 3;
}

function replaceObservation(
  bundle: CodeMemoryLinkBenchObservationBundleV1,
  queryId: string,
  replace: (observation: CodeMemoryLinkBenchObservationV1) => CodeMemoryLinkBenchObservationV1,
): CodeMemoryLinkBenchObservationBundleV1 {
  return {
    ...bundle,
    observations: EffectArray.map(bundle.observations, observation =>
      observation.queryId === queryId ? replace(observation) : observation,
    ),
  };
}

function rotate<T>(values: readonly T[], offset: number): readonly T[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}
