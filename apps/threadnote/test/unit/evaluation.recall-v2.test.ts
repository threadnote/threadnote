import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {benchmarkMeasurement, parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {
  createRecallEvaluationFixtureV2,
  expandRecallEvaluationFixtureV2,
  recallEvaluationCategoryCounts,
} from '@threadnote/threadnote/evaluation/recall-fixture';
import {evaluateRecallNonInferiority} from '@threadnote/threadnote/evaluation/recall-gate';
import {
  compareRecallEvaluationResults,
  evaluateRecallRunV2,
  parseRecallEvaluationFixtureV2,
  parseRecallEvaluationRunV1,
  RECALL_EVALUATION_CATEGORIES,
  runLexicalRecallEvaluationV2,
  type RecallEvaluationRunV1,
} from '@threadnote/threadnote/evaluation/recall';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const RECALL_EVALUATION_TEST_TIMEOUT = 20_000;

describe('recall evaluation contract v2', () => {
  it('provides the reviewed 200-document and 250-query score-free fixture', () => {
    const fixture = createRecallEvaluationFixtureV2();

    expect(fixture.documents).toHaveLength(200);
    expect(fixture.queries).toHaveLength(250);
    expect(fixture.metadata.reviewed).toBe(true);
    expect(EffectArray.every(fixture.documents, document => document.semantic === undefined)).toBe(true);
    expect(EffectArray.every(fixture.documents, document => document.provenance.length > 0)).toBe(true);
    expect(
      EffectArray.every(fixture.queries, query => query.provenance.length > 0 && query.expectedStages.length > 0),
    ).toBe(true);

    const counts = recallEvaluationCategoryCounts(fixture);
    for (const category of RECALL_EVALUATION_CATEGORIES) {
      expect(counts[category], category).toBeGreaterThan(0);
    }
    expect(counts.no_answer).toBe(25);
  });

  it('round-trips the fixture and run schemas through JSON', () => {
    const fixture = createRecallEvaluationFixtureV2();
    const parsedFixture = parseRecallEvaluationFixtureV2(JSON.parse(JSON.stringify(fixture)));
    const run = oracleRun(parsedFixture);
    const parsedRun = parseRecallEvaluationRunV1(JSON.parse(JSON.stringify(run)));

    expect(parsedFixture).toEqual(fixture);
    expect(parsedRun).toEqual(run);
  });

  it('evaluates a complete oracle run without contract failures', () => {
    const fixture = createRecallEvaluationFixtureV2();
    const result = evaluateRecallRunV2(fixture, oracleRun(fixture));

    expect(result.failures).toEqual([]);
    expect(result.metrics.queryCount).toBe(250);
    expect(result.metrics.answerableQueries).toBe(225);
    expect(result.metrics.recallAt1).toBe(1);
    expect(result.metrics.recallAt5).toBe(1);
    expect(result.metrics.recallAt10).toBe(1);
    expect(result.metrics.meanReciprocalRank).toBe(1);
    expect(result.metrics.meanNdcgAt5).toBe(1);
    expect(result.metrics.meanNdcgAt10).toBe(1);
    expect(result.metrics.noAnswerPrecision).toBe(1);
    expect(result.metrics.noAnswerRecall).toBe(1);
    expect(result.metrics.noAnswerF1).toBe(1);
    expect(result.metrics.forbiddenHitRate).toBe(0);
    expect(result.metrics.staleHitRate).toBe(0);
    expect(result.metrics.authorityInversionRate).toBe(0);
    expect(result.metrics.explanationCoverage).toBe(1);
    expect(result.metrics.averageCandidatesRead).toBe(0);
    expect(result.metrics.expansionInvocationRate).toBe(0);
    expect(result.metrics.expansionFallbackRate).toBe(0);
  });

  it(
    'runs the existing deterministic ranker as a lexical-only v2 pipeline',
    () => {
      const fixture = createRecallEvaluationFixtureV2();
      const run = runLexicalRecallEvaluationV2(fixture, {
        createdAt: '2026-07-27T00:00:00.000Z',
        fixtureHash: 'fixture-hash',
      });
      const result = evaluateRecallRunV2(fixture, run);

      expect(run.queries).toHaveLength(fixture.queries.length);
      expect(EffectArray.every(run.queries, query => query.stages.includes('lexical'))).toBe(true);
      expect(result.metrics.queryCount).toBe(fixture.queries.length);
      expect(result.categories.exact_lexical?.recallAt5).toBeGreaterThan(0.9);
      expect(result.categories.semantic?.recallAt5).toBeLessThanOrEqual(1);
      expect(result.metrics.averageCandidatesRead).toBe(fixture.documents.length);
      expect(result.metrics.averageContextTokens).toBeGreaterThan(0);
    },
    RECALL_EVALUATION_TEST_TIMEOUT,
  );

  it(
    'reports comparable metric deltas between pipelines',
    () => {
      const fixture = createRecallEvaluationFixtureV2();
      const lexical = evaluateRecallRunV2(
        fixture,
        runLexicalRecallEvaluationV2(fixture, {
          createdAt: '2026-07-27T00:00:00.000Z',
          fixtureHash: 'fixture-hash',
        }),
      );
      const oracle = evaluateRecallRunV2(fixture, oracleRun(fixture));
      const comparison = compareRecallEvaluationResults(lexical, oracle);

      expect(comparison.baseline).toBe('threadnote-lexical-only');
      expect(comparison.candidate).toBe('oracle');
      expect(comparison.metrics.recallAt5).toBeGreaterThanOrEqual(0);
      expect(comparison.metrics.forbiddenHitRate).toBeLessThanOrEqual(0);
    },
    RECALL_EVALUATION_TEST_TIMEOUT,
  );

  it(
    'reports explicit-project and omitted-project global quality as separate retrieval modes',
    () => {
      const fixture = createRecallEvaluationFixtureV2();
      const explicit = evaluateRecallRunV2(
        fixture,
        runLexicalRecallEvaluationV2(fixture, {
          fixtureHash: 'fixture-hash',
          projectEligibility: 'explicit',
        }),
      );
      const global = evaluateRecallRunV2(
        fixture,
        runLexicalRecallEvaluationV2(fixture, {
          fixtureHash: 'fixture-hash',
          projectEligibility: 'global',
        }),
      );

      expect(explicit.metrics.forbiddenHitRate).toBe(0);
      expect(global.metrics.forbiddenHitRate).toBeGreaterThan(explicit.metrics.forbiddenHitRate);
      expect(global.metrics.recallAt5).toBeGreaterThanOrEqual(explicit.metrics.recallAt5);
    },
    RECALL_EVALUATION_TEST_TIMEOUT,
  );

  it('requires the global eligibility diagnostic to opt out of the explicit-project baseline', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, 'scripts/evaluate-recall-v2.ts', '--global-eligibility'],
      cwd: process.cwd(),
      stderr: 'pipe',
      stdout: 'pipe',
    });

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout.toString()}\n${result.stderr.toString()}`).toContain(
      '--global-eligibility requires --no-baseline',
    );
  });

  it(
    'gates aggregate and per-category quality without allowing safety regressions',
    () => {
      const fixture = createRecallEvaluationFixtureV2();
      const baseline = evaluateRecallRunV2(
        fixture,
        runLexicalRecallEvaluationV2(fixture, {
          createdAt: '2026-07-27T00:00:00.000Z',
          fixtureHash: 'fixture-hash',
        }),
      );
      const unchanged = evaluateRecallNonInferiority(baseline, baseline);
      const swappedContractFailure = evaluateRecallNonInferiority(baseline, {
        ...baseline,
        failures: [...baseline.failures.slice(1), 'new-query: newly introduced failure'],
      });
      const regressed = evaluateRecallNonInferiority(baseline, {
        ...baseline,
        metrics: {
          ...baseline.metrics,
          forbiddenHitRate: baseline.metrics.forbiddenHitRate + 0.001,
        },
      });

      expect(unchanged.passed).toBe(true);
      expect(swappedContractFailure.passed).toBe(false);
      expect(
        EffectArray.some(swappedContractFailure.failures, failure =>
          Effect.pipe(failure, EffectString.includes('new contract failure identities')),
        ),
      ).toBe(true);
      expect(regressed.passed).toBe(false);
      expect(regressed.failures).toContain('aggregate.forbiddenHitRate regressed by 0.001000; maximum 0.000000');
    },
    RECALL_EVALUATION_TEST_TIMEOUT,
  );

  it('rejects duplicate document and query identities', () => {
    const fixture = createRecallEvaluationFixtureV2();

    expect(() =>
      parseRecallEvaluationFixtureV2({
        ...fixture,
        documents: [...fixture.documents, fixture.documents[0]],
      }),
    ).toThrow(/Duplicate recall evaluation document URI/);
    expect(() =>
      parseRecallEvaluationFixtureV2({
        ...fixture,
        queries: [...fixture.queries, fixture.queries[0]],
      }),
    ).toThrow(/Duplicate recall evaluation query ID/);
  });

  fcProp(
    it,
    'expands deterministic distractors without changing reviewed queries',
    {
      documentCount: FC.integer({max: 2_000, min: 200}),
      seed: FC.integer({max: 0x7fffffff, min: 1}),
    },
    ({documentCount, seed}) => {
      const fixture = createRecallEvaluationFixtureV2();
      const left = expandRecallEvaluationFixtureV2(fixture, documentCount, seed);
      const right = expandRecallEvaluationFixtureV2(fixture, documentCount, seed);

      expect(left.documents).toHaveLength(documentCount);
      expect(left.queries).toEqual(fixture.queries);
      expect(left).toEqual(right);
      expect(new Set(EffectArray.map(left.documents, document => document.uri)).size).toBe(documentCount);
    },
    {fastCheck: {numRuns: 25}},
  );
});

describe('benchmark artifact contract v1', () => {
  it('summarizes and validates ordered percentile measurements', () => {
    const measurement = benchmarkMeasurement('exact-vector-scan', 'milliseconds', [5, 1, 4, 2, 3]);
    const artifact: BenchmarkArtifactV1 = {
      createdAt: '2026-07-27T00:00:00.000Z',
      environment: {
        architecture: 'arm64',
        commit: 'abc123',
        cpu: 'test cpu',
        dirty: false,
        fixtureHash: 'fixture-hash',
        memoryBytes: 16_000_000_000,
        node: 'v22.22.0',
        operatingSystem: 'darwin',
        packageManager: 'npm/11.7.0',
        runner: 'threadnote',
        runnerVersion: '1',
      },
      measurements: [measurement],
      metadata: {documents: 10_000, smoke: true},
      suite: 'recall-micro',
      version: 1,
      warmups: 5,
    };

    expect(measurement).toMatchObject({
      maximum: 5,
      mean: 3,
      minimum: 1,
      p50: 3,
      p95: 5,
      p99: 5,
      samples: 5,
    });
    expect(parseBenchmarkArtifactV1(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
  });

  it('rejects invalid percentile ordering', () => {
    const artifact = {
      createdAt: '2026-07-27T00:00:00.000Z',
      environment: {
        architecture: 'x64',
        commit: 'abc123',
        cpu: 'test cpu',
        dirty: false,
        fixtureHash: 'fixture-hash',
        memoryBytes: 1,
        node: 'v22.22.0',
        operatingSystem: 'linux',
        packageManager: 'npm/11.7.0',
        runner: 'threadnote',
        runnerVersion: '1',
      },
      measurements: [
        {
          maximum: 5,
          mean: 3,
          minimum: 1,
          name: 'invalid',
          p50: 4,
          p95: 3,
          p99: 5,
          samples: 5,
          unit: 'milliseconds',
        },
      ],
      metadata: {},
      suite: 'invalid',
      version: 1,
      warmups: 0,
    };

    expect(() => parseBenchmarkArtifactV1(artifact)).toThrow(/percentiles are not monotonically ordered/);
  });
});

function oracleRun(fixture: ReturnType<typeof createRecallEvaluationFixtureV2>): RecallEvaluationRunV1 {
  return {
    createdAt: '2026-07-27T00:00:00.000Z',
    fixtureHash: 'fixture-hash',
    pipeline: {name: 'oracle'},
    queries: EffectArray.map(fixture.queries, query => {
      const relevant = EffectArray.map(
        EffectArray.filter(EffectRecord.toEntries(query.relevance), ([, grade]) => grade > 0).sort(
          (left, right) => right[1] - left[1],
        ),
        ([uri]) => ({
          reasonCodes: query.requiredReasonCodes ?? ['oracle_relevance'],
          score: query.relevance[uri],
          uri,
        }),
      );
      return {
        candidatesRead: 0,
        contextCharacters: EffectArray.reduce(
          relevant,
          0,
          (characters, hit) =>
            characters +
            (EffectOption.getOrUndefined(EffectArray.findFirst(fixture.documents, document => document.uri === hit.uri))
              ?.text.length ?? 0),
        ),
        id: query.id,
        predictedAnswerability: query.expectedAnswerability,
        ranked: relevant,
        stages: ['lexical', 'semantic', 'reranked'],
      };
    }),
    version: 1,
  };
}
