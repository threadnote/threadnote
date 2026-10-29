import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {Schema} from 'effect';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {
  enforceCodeGraphBenchmarkBudget,
  sanitizedBenchmarkEnvironmentProvenance,
} from '../../../../scripts/benchmark-code-graph.js';
import {
  BenchmarkArtifactSchemaV1,
  benchmarkMeasurement,
  type BenchmarkArtifactV1,
  parseBenchmarkArtifactV1,
} from '@threadnote/evidence/benchmark';
import {readFileSync} from '@threadnote/testing/node-fs';

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const GitCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const ArchiveDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));

const GuardedHotQueryBudget = Schema.Struct({
  hotQueryP50MillisecondsMaximum: PositiveFinite,
  hotQueryP95MillisecondsMaximum: PositiveFinite,
  hotQueryProcessCpuP95MillisecondsMaximum: PositiveFinite,
  hotQuerySamplesMinimum: PositiveInteger,
  hotQueryWallP95ToleranceRatioMaximum: NonNegativeFinite,
  oneFileIncrementalP95MillisecondsMaximum: PositiveFinite,
});

const ScalePerformanceBudget = Schema.Struct({
  coldIndexP95MillisecondsMaximum: PositiveFinite,
  coldMaterializationP95MillisecondsMaximum: PositiveFinite,
  derivedIndexBytesMaximum: PositiveFinite,
  hotQueryP95MillisecondsMaximum: PositiveFinite,
  oneFileIncrementalP95MillisecondsMaximum: PositiveFinite,
  oneFileMaterializationP95MillisecondsMaximum: PositiveFinite,
  processPeakRssBytesMaximum: PositiveFinite,
  wholeGraphAnalysisP95MillisecondsMaximum: PositiveFinite,
});

const budgetFile = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      developmentPerformance: GuardedHotQueryBudget,
      scalePerformance: Schema.Struct({
        '10000': ScalePerformanceBudget,
      }),
      scalePerformanceByRunnerClass: Schema.Struct({
        'github-hosted-windows-x64': Schema.Struct({'10000': GuardedHotQueryBudget}),
      }),
    }),
  ),
)(await Bun.file('apps/threadnote/test/evaluation/baselines/code-graph-v1/budgets.json').text());

const Summary = Schema.Struct({
  breaches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maximum: PositiveFinite,
  minimum: PositiveFinite,
  p50: PositiveFinite,
  p95: PositiveFinite,
});

const Observation = Schema.Struct({
  archiveDigest: ArchiveDigest,
  artifactId: PositiveInteger,
  createdAt: Schema.String,
  environment: Schema.Struct({
    cpu: Schema.String,
    memoryBytes: PositiveInteger,
    operatingSystem: Schema.String,
    runtime: Schema.String,
  }),
  headBranch: Schema.String,
  headSha: GitCommit,
  measurements: Schema.Struct({
    coldIndexMilliseconds: PositiveFinite,
    coldMaterializationMilliseconds: PositiveFinite,
    hotQueryP50Milliseconds: PositiveFinite,
    hotQueryP95Milliseconds: PositiveFinite,
    hotQueryProcessCpuP50Milliseconds: NonNegativeFinite,
    hotQueryProcessCpuP95Milliseconds: NonNegativeFinite,
    samples: PositiveInteger,
  }),
  runId: PositiveInteger,
});

const calibration = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      candidateBudgetArtifact: BenchmarkArtifactSchemaV1,
      candidateCommit: GitCommit,
      candidateWorkflow: Schema.Struct({
        conclusion: Schema.Literal('failure'),
        head_sha: GitCommit,
        id: PositiveInteger,
        name: Schema.Literal('Code graph 10k · windows-latest'),
        run_id: PositiveInteger,
        steps: Schema.Array(
          Schema.Struct({
            completedAt: Schema.String,
            conclusion: Schema.String,
            name: Schema.String,
            startedAt: Schema.String,
          }),
        ),
      }),
      derivation: Schema.Struct({
        candidateHotQueryP50Milliseconds: PositiveFinite,
        candidateHotQueryP95Milliseconds: PositiveFinite,
        candidateHotQueryProcessCpuP95Milliseconds: NonNegativeFinite,
        observationCount: PositiveInteger,
        priorHotQueryP50: Summary,
        priorHotQueryP95: Summary,
        priorHotQueryProcessCpuP95: Summary,
        priorObservationCount: PositiveInteger,
        prospectiveHotQueryP95MillisecondsMaximum: PositiveFinite,
      }),
      governedInputs: Schema.Struct({
        additionalToleranceRatio: NonNegativeFinite,
        companionHotQueryP50MillisecondsMaximum: PositiveFinite,
        companionHotQueryProcessCpuP95MillisecondsMaximum: PositiveFinite,
        headroomRatio: PositiveFinite,
        previousHotQueryP95MillisecondsMaximum: PositiveFinite,
        requiredSamples: PositiveInteger,
        roundingQuantumMilliseconds: PositiveInteger,
      }),
      observationOrder: Schema.Literal('reverse-chronological; observations[0] is the candidate failure'),
      observations: Schema.Array(Observation),
      provenanceCorrection: Schema.Struct({
        observedRunnerClass: Schema.Literal('local-unclassified'),
        observedRunnerIdentity: Schema.Literal('local'),
        prospectiveRunnerClass: Schema.Literal('github-hosted-windows-x64'),
      }),
      type: Schema.Literal('threadnote-windows-scale-10k-hosted-tail-calibration'),
      version: Schema.Literal(1),
    }),
  ),
)(
  await Bun.file(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/windows-scale-10k-hosted-tail-calibration-v1.json',
  ).text(),
);

const quantileCalibration = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      candidateCommit: GitCommit,
      candidateWorkflow: Schema.Struct({
        archiveDigest: ArchiveDigest,
        artifactId: PositiveInteger,
        artifactRawJsonSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
        conclusion: Schema.Literal('failure'),
        jobId: PositiveInteger,
        runId: PositiveInteger,
      }),
      createdAt: Schema.String,
      environment: Schema.Struct({
        architecture: Schema.Literal('x64'),
        cpu: Schema.String,
        memoryBytes: PositiveInteger,
        operatingSystem: Schema.String,
        runnerClass: Schema.Literal('github-hosted-windows-x64'),
        runnerIdentity: Schema.String.check(Schema.isPattern(/^runner-[0-9a-f]{16}$/u)),
        runtime: Schema.Literal('bun/1.3.14'),
        runtimePlatform: Schema.Literal('win32'),
      }),
      governedInputs: Schema.Struct({
        additionalToleranceRatio: NonNegativeFinite,
        companionHotQueryP50MillisecondsMaximum: PositiveFinite,
        companionHotQueryProcessCpuP95MillisecondsMaximum: PositiveFinite,
        hardWallP95MillisecondsMaximum: PositiveFinite,
        productionP95ExcludedUpperOrderStatistics: PositiveInteger,
        previousSamples: PositiveInteger,
        prospectiveSamples: PositiveInteger,
      }),
      measurements: Schema.Struct({
        exactReadyProcessCpuP95Milliseconds: NonNegativeFinite,
        exactReadyWallMaximumMilliseconds: PositiveFinite,
        exactReadyWallP50Milliseconds: PositiveFinite,
        exactReadyWallP95Milliseconds: PositiveFinite,
        outerProcessCpuP50Milliseconds: NonNegativeFinite,
        outerProcessCpuP95Milliseconds: NonNegativeFinite,
        outerWallMaximumMilliseconds: PositiveFinite,
        outerWallP50Milliseconds: PositiveFinite,
        outerWallP95Milliseconds: PositiveFinite,
        samples: PositiveInteger,
      }),
      type: Schema.Literal('threadnote-windows-scale-10k-hosted-quantile-calibration'),
      version: Schema.Literal(1),
    }),
  ),
)(
  await Bun.file(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/windows-scale-10k-hosted-quantile-calibration-v1.json',
  ).text(),
);

const benchmarkWorkflow = Schema.decodeUnknownSync(
  Schema.Struct({
    jobs: Schema.Struct({
      'code-graph-10k': Schema.Struct({
        steps: Schema.Array(
          Schema.Struct({
            env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
            if: Schema.optionalKey(Schema.String),
            name: Schema.optionalKey(Schema.String),
            run: Schema.optionalKey(Schema.String),
            uses: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    }),
  }),
)(load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {schema: JSON_SCHEMA}));

const hostedBudget = budgetFile.scalePerformanceByRunnerClass['github-hosted-windows-x64']['10000'];

describe('hosted Windows 10k scheduler-tail calibration', () => {
  it('rederives the retained hosted history and the prospective hard wall fuse', () => {
    const candidate = required(calibration.observations[0]);
    const prior = calibration.observations.slice(1);

    expect(calibration.observations).toHaveLength(calibration.derivation.observationCount);
    expect(prior).toHaveLength(calibration.derivation.priorObservationCount);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.artifactId)).size).toBe(25);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.runId)).size).toBe(25);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.archiveDigest)).size).toBe(25);
    expect(
      EffectArrayPipe(calibration.observations, __effectNativeArray =>
        EffectArray.every(
          __effectNativeArray,
          (observation, index) =>
            index === 0 ||
            Date.parse(required(__effectNativeArray[index - 1]).createdAt) >= Date.parse(observation.createdAt),
        ),
      ),
    ).toBe(true);

    expect(
      summary(
        EffectArray.map(prior, observation => observation.measurements.hotQueryP50Milliseconds),
        750,
      ),
    ).toEqual(calibration.derivation.priorHotQueryP50);
    expect(
      summary(
        EffectArray.map(prior, observation => observation.measurements.hotQueryP95Milliseconds),
        1_000,
      ),
    ).toEqual(calibration.derivation.priorHotQueryP95);
    expect(
      summary(
        EffectArray.map(prior, observation => observation.measurements.hotQueryProcessCpuP95Milliseconds),
        500,
      ),
    ).toEqual(calibration.derivation.priorHotQueryProcessCpuP95);

    const derived =
      Math.ceil(
        (candidate.measurements.hotQueryP95Milliseconds * (1 + calibration.governedInputs.headroomRatio)) /
          calibration.governedInputs.roundingQuantumMilliseconds,
      ) * calibration.governedInputs.roundingQuantumMilliseconds;
    expect(derived).toBe(calibration.derivation.prospectiveHotQueryP95MillisecondsMaximum);
    expect(derived).toBe(1_200);
    expect(calibration.governedInputs.additionalToleranceRatio).toBe(0);
    expect(hostedBudget.hotQueryP50MillisecondsMaximum).toBe(
      calibration.governedInputs.companionHotQueryP50MillisecondsMaximum,
    );
    expect(hostedBudget.hotQueryProcessCpuP95MillisecondsMaximum).toBe(
      calibration.governedInputs.companionHotQueryProcessCpuP95MillisecondsMaximum,
    );
    expect(hostedBudget.hotQuerySamplesMinimum).toBe(quantileCalibration.governedInputs.prospectiveSamples);
    expect(hostedBudget.hotQueryWallP95ToleranceRatioMaximum).toBe(calibration.governedInputs.additionalToleranceRatio);
  });

  it('binds the failure to hosted wall delay while the independent CPU guard stayed green', () => {
    const candidate = required(calibration.observations[0]);
    const predecessor = required(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(calibration.observations, observation => observation.artifactId === 9_779_699_070),
      ),
    );
    const checkout = required(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(calibration.candidateWorkflow.steps, step => step.name === 'Run actions/checkout@v7'),
      ),
    );
    const install = required(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          calibration.candidateWorkflow.steps,
          step => step.name === 'Run bun install --frozen-lockfile',
        ),
      ),
    );

    expect(candidate.headSha).toBe(calibration.candidateCommit);
    expect(calibration.candidateWorkflow.head_sha).toBe(calibration.candidateCommit);
    expect(candidate.measurements.hotQueryP95Milliseconds).toBeGreaterThan(
      calibration.derivation.priorHotQueryP95.maximum,
    );
    expect(candidate.measurements.hotQueryProcessCpuP95Milliseconds).toBeLessThan(
      calibration.derivation.priorHotQueryProcessCpuP95.p50,
    );
    expect(candidate.measurements.hotQueryP95Milliseconds).toBeGreaterThan(
      predecessor.measurements.hotQueryP95Milliseconds * 2.7,
    );
    expect(candidate.measurements.hotQueryProcessCpuP95Milliseconds).toBeLessThan(
      predecessor.measurements.hotQueryProcessCpuP95Milliseconds,
    );
    expect(durationSeconds(checkout)).toBe(82);
    expect(durationSeconds(install)).toBe(188);
  });

  it('fixes provenance, increases the sample count, and keeps the override runner-scoped', () => {
    const job = benchmarkWorkflow.jobs['code-graph-10k'];
    const capture = required(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(job.steps, step => step.name === 'Gate 10k-symbol indexing and queries'),
      ),
    );
    const upload = required(
      EffectOption.getOrUndefined(EffectArray.findFirst(job.steps, step => step.uses === 'actions/upload-artifact@v7')),
    );

    expect(capture.env).toEqual({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-${{ matrix.os }}-${{ runner.arch }}',
      THREADNOTE_BENCHMARK_RUNNER_ID: '${{ runner.name }}',
    });
    expect(capture.run).toContain('--samples 100');
    expect(upload.if).toBe('always()');
    expect(
      sanitizedBenchmarkEnvironmentProvenance({
        THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-windows-latest-X64',
        THREADNOTE_BENCHMARK_RUNNER_ID: 'GitHub Actions 1000036813',
      }),
    ).toEqual({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-windows-x64',
      THREADNOTE_BENCHMARK_RUNNER_ID: expect.stringMatching(/^runner-[0-9a-f]{16}$/u),
    });
  });

  it('retains the failed 25-sample validation and increases quantile resolution without widening any guard', () => {
    const measurement = quantileCalibration.measurements;
    const governed = quantileCalibration.governedInputs;

    expect(quantileCalibration.candidateCommit).toBe('9126348fdce549b54036223f667efb24c4cfc123');
    expect(quantileCalibration.candidateWorkflow).toMatchObject({
      artifactId: 9_781_216_114,
      jobId: 99_692_956_963,
      runId: 33_454_986_359,
    });
    expect(measurement.samples).toBe(governed.previousSamples);
    expect(measurement.outerWallP95Milliseconds / measurement.outerProcessCpuP95Milliseconds).toBeGreaterThan(5.9);
    expect(measurement.outerWallP95Milliseconds / measurement.exactReadyWallP95Milliseconds).toBeGreaterThan(4.1);
    expect(measurement.outerProcessCpuP95Milliseconds).toBeLessThan(
      governed.companionHotQueryProcessCpuP95MillisecondsMaximum,
    );
    expect(measurement.exactReadyWallP95Milliseconds).toBeLessThan(governed.hardWallP95MillisecondsMaximum / 2);
    expect(governed.prospectiveSamples).toBe(100);
    expect(governed.prospectiveSamples - (Math.floor(governed.prospectiveSamples * 0.95) + 1)).toBe(
      governed.productionP95ExcludedUpperOrderStatistics,
    );
    expect(governed.hardWallP95MillisecondsMaximum).toBe(1_200);
    expect(hostedBudget).toMatchObject({
      hotQueryP50MillisecondsMaximum: governed.companionHotQueryP50MillisecondsMaximum,
      hotQueryProcessCpuP95MillisecondsMaximum: governed.companionHotQueryProcessCpuP95MillisecondsMaximum,
      hotQuerySamplesMinimum: governed.prospectiveSamples,
      hotQueryWallP95ToleranceRatioMaximum: governed.additionalToleranceRatio,
    });
  });

  it('uses the production percentile at the four-versus-five wall-breach boundary', () => {
    const wallMaximum = hostedBudget.hotQueryP95MillisecondsMaximum;
    const wallSamples = (breaches: 4 | 5) => [
      ...Array.from({length: 95}, () => 500),
      ...(breaches === 4 ? [wallMaximum] : []),
      ...Array.from({length: breaches}, () => wallMaximum + 1),
    ];
    const fourBreaches = benchmarkMeasurement('hot-exact-lexical-query', 'milliseconds', wallSamples(4));
    const fiveBreaches = benchmarkMeasurement('hot-exact-lexical-query', 'milliseconds', wallSamples(5));
    const withHotQuery = (measurement: ReturnType<typeof benchmarkMeasurement>) => {
      const artifact = candidateArtifact({runnerClass: 'github-hosted-windows-x64', samples: 100});
      return parseBenchmarkArtifactV1({
        ...artifact,
        measurements: EffectArray.map(artifact.measurements, candidate =>
          candidate.name === 'hot-exact-lexical-query' ? measurement : candidate,
        ),
      });
    };

    expect(fourBreaches.p95).toBe(wallMaximum);
    expect(fiveBreaches.p95).toBe(wallMaximum + 1);
    expect(() => enforceCodeGraphBenchmarkBudget(withHotQuery(fourBreaches), budgetFile, 10_000)).not.toThrow();
    expect(() => enforceCodeGraphBenchmarkBudget(withHotQuery(fiveBreaches), budgetFile, 10_000)).toThrow(
      /hot-exact-lexical-query/u,
    );
  });

  it('replays the failure, admits the prospective hosted sample, and rejects undersampling', () => {
    const previousBudget = {...budgetFile, scalePerformanceByRunnerClass: {}};
    const observed = candidateArtifact({runnerClass: 'local-unclassified', samples: 10});
    const prospective = candidateArtifact({runnerClass: 'github-hosted-windows-x64', samples: 100});

    expect(() => enforceCodeGraphBenchmarkBudget(observed, previousBudget, 10_000)).toThrow(/hot-exact-lexical-query/u);
    expect(() => enforceCodeGraphBenchmarkBudget(prospective, budgetFile, 10_000)).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        candidateArtifact({runnerClass: 'github-hosted-windows-x64', samples: 99}),
        budgetFile,
        10_000,
      ),
    ).toThrow(/requires at least 100 samples/u);
    expect(() => enforceCodeGraphBenchmarkBudget(observed, budgetFile, 10_000)).toThrow(/hot-exact-lexical-query/u);
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        candidateArtifact({runnerClass: 'github-hosted-linux-x64', samples: 25}),
        budgetFile,
        10_000,
      ),
    ).toThrow(/hot-exact-lexical-query/u);
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        candidateArtifact({runnerClass: 'github-hosted-windows-x64', runtimePlatform: 'linux', samples: 25}),
        budgetFile,
        10_000,
      ),
    ).toThrow(/hot-exact-lexical-query/u);
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        candidateArtifact({architecture: 'arm64', runnerClass: 'github-hosted-windows-x64', samples: 25}),
        budgetFile,
        10_000,
      ),
    ).toThrow(/hot-exact-lexical-query/u);

    fc.assert(
      fc.property(fc.integer({max: 99, min: 1}), samples => {
        expect(() =>
          enforceCodeGraphBenchmarkBudget(
            candidateArtifact({runnerClass: 'github-hosted-windows-x64', samples}),
            budgetFile,
            10_000,
          ),
        ).toThrow(/requires at least 100 samples/u);
      }),
      {numRuns: 100},
    );
    fc.assert(
      fc.property(fc.integer({max: 250, min: 100}), samples => {
        expect(() =>
          enforceCodeGraphBenchmarkBudget(
            candidateArtifact({runnerClass: 'github-hosted-windows-x64', samples}),
            budgetFile,
            10_000,
          ),
        ).not.toThrow();
      }),
      {numRuns: 100},
    );
  });

  it('keeps the p95, p50, and process-CPU companion guards strict above each boundary', () => {
    const boundary = replaceHotQueryStatistics(
      candidateArtifact({runnerClass: 'github-hosted-windows-x64', samples: 100}),
      {
        p50: hostedBudget.hotQueryP50MillisecondsMaximum,
        p95: hostedBudget.hotQueryP95MillisecondsMaximum,
        processCpuP95: hostedBudget.hotQueryProcessCpuP95MillisecondsMaximum,
      },
    );
    expect(() => enforceCodeGraphBenchmarkBudget(boundary, budgetFile, 10_000)).not.toThrow();

    fc.assert(
      fc.property(
        fc.constantFrom('p50' as const, 'p95' as const, 'cpu' as const),
        fc.double({max: 400, min: 0.000_001, noDefaultInfinity: true, noNaN: true}),
        (guard, delta) => {
          const regressed = replaceHotQueryStatistics(boundary, {
            p50: hostedBudget.hotQueryP50MillisecondsMaximum + (guard === 'p50' ? delta : 0),
            p95: hostedBudget.hotQueryP95MillisecondsMaximum + (guard === 'p95' ? delta : 0),
            processCpuP95: hostedBudget.hotQueryProcessCpuP95MillisecondsMaximum + (guard === 'cpu' ? delta : 0),
          });
          expect(() => enforceCodeGraphBenchmarkBudget(regressed, budgetFile, 10_000)).toThrow(
            guard === 'p50' ? /p50/u : guard === 'cpu' ? /hot-query-process-cpu/u : /hot-exact-lexical-query/u,
          );
        },
      ),
      {numRuns: 120},
    );
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Windows 10k calibration value is missing.');
  return value;
}

function summary(values: readonly number[], maximum: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number) => required(sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)]);
  return {
    breaches: EffectArray.filter(sorted, value => value > maximum).length,
    maximum: required(sorted.at(-1)),
    minimum: required(sorted[0]),
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function durationSeconds(step: {readonly completedAt: string; readonly startedAt: string}): number {
  return (Date.parse(step.completedAt) - Date.parse(step.startedAt)) / 1_000;
}

function candidateArtifact(input: {
  readonly architecture?: string;
  readonly runnerClass: string;
  readonly runtimePlatform?: string;
  readonly samples: number;
}): BenchmarkArtifactV1 {
  return parseBenchmarkArtifactV1({
    ...calibration.candidateBudgetArtifact,
    environment: {
      ...calibration.candidateBudgetArtifact.environment,
      architecture: input.architecture ?? calibration.candidateBudgetArtifact.environment.architecture,
    },
    measurements: EffectArray.map(calibration.candidateBudgetArtifact.measurements, measurement =>
      measurement.name === 'hot-exact-lexical-query' || measurement.name === 'hot-query-process-cpu'
        ? {...measurement, samples: input.samples}
        : measurement,
    ),
    metadata: {
      ...calibration.candidateBudgetArtifact.metadata,
      runnerClass: input.runnerClass,
      runtimePlatform: input.runtimePlatform ?? calibration.candidateBudgetArtifact.metadata.runtimePlatform,
    },
  });
}

function replaceHotQueryStatistics(
  artifact: BenchmarkArtifactV1,
  values: {readonly p50: number; readonly p95: number; readonly processCpuP95: number},
): BenchmarkArtifactV1 {
  return parseBenchmarkArtifactV1({
    ...artifact,
    measurements: EffectArray.map(artifact.measurements, measurement => {
      if (measurement.name === 'hot-exact-lexical-query') {
        const maximum = Math.max(values.p50, values.p95);
        return {...measurement, maximum, p50: values.p50, p95: maximum, p99: maximum};
      }
      if (measurement.name === 'hot-query-process-cpu') {
        const maximum = Math.max(measurement.p50, values.processCpuP95);
        return {...measurement, maximum, p95: maximum, p99: maximum};
      }
      return measurement;
    }),
  });
}
