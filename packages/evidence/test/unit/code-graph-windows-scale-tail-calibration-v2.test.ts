import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {enforceCodeGraphBenchmarkBudget} from '../../../../scripts/benchmark-code-graph.js';
import {
  BenchmarkArtifactSchemaV1,
  type BenchmarkArtifactV1,
  parseBenchmarkArtifactV1,
} from '@threadnote/evidence/benchmark';

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const GitCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const ArchiveDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

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
      scalePerformance: Schema.Struct({
        '10000': ScalePerformanceBudget,
      }),
      scalePerformanceByRunnerClass: Schema.Struct({
        'github-hosted-windows-x64': Schema.Struct({'10000': GuardedHotQueryBudget}),
      }),
      developmentPerformanceReplicaSetByRunnerClass: Schema.Struct({
        'github-hosted-windows-x64': Schema.Struct({
          schedulerSensitiveWallClockSafetyMultiplier: Schema.Literal(2),
        }),
      }),
    }),
  ),
)(await Bun.file('apps/threadnote/test/evaluation/baselines/code-graph-v1/budgets.json').text());

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
    oneFileActivationMilliseconds: Schema.optionalKey(PositiveFinite),
    oneFileActivationProcessCpuMilliseconds: Schema.optionalKey(NonNegativeFinite),
    oneFileHeartbeatGapMilliseconds: Schema.optionalKey(NonNegativeFinite),
    oneFileIndexMilliseconds: Schema.optionalKey(PositiveFinite),
    samples: PositiveInteger,
  }),
  runId: PositiveInteger,
});

const calibration = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      candidateArchiveDigest: ArchiveDigest,
      candidateArtifactId: PositiveInteger,
      candidateArtifactRawJsonSha256: Sha256,
      candidateBudgetArtifact: BenchmarkArtifactSchemaV1,
      candidateCommit: GitCommit,
      candidateWorkflow: Schema.Struct({
        conclusion: Schema.Literal('failure'),
        head_sha: GitCommit,
        id: PositiveInteger,
        name: Schema.Literal('Code graph 10k · windows-latest'),
        run_attempt: Schema.Literal(2),
        run_id: PositiveInteger,
      }),
      derivation: Schema.Struct({
        candidateHotQueryP50Milliseconds: PositiveFinite,
        candidateHotQueryP95Milliseconds: PositiveFinite,
        candidateHotQueryProcessCpuP95Milliseconds: NonNegativeFinite,
        candidateOneFileActivationMilliseconds: PositiveFinite,
        candidateOneFileActivationProcessCpuMilliseconds: NonNegativeFinite,
        candidateOneFileHeartbeatGapMilliseconds: NonNegativeFinite,
        candidateOneFileIndexMilliseconds: PositiveFinite,
        observationCount: PositiveInteger,
        priorHotQueryP50: Schema.Struct({
          breaches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          maximum: PositiveFinite,
          minimum: PositiveFinite,
          p50: PositiveFinite,
          p95: PositiveFinite,
        }),
        priorHotQueryP95: Schema.Struct({
          breaches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          maximum: PositiveFinite,
          minimum: PositiveFinite,
          p50: PositiveFinite,
          p95: PositiveFinite,
        }),
        priorHotQueryProcessCpuP95: Schema.Struct({
          breaches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          maximum: PositiveFinite,
          minimum: PositiveFinite,
          p50: PositiveFinite,
          p95: PositiveFinite,
        }),
        priorObservationCount: PositiveInteger,
        prospectiveHotQueryP95MillisecondsMaximum: PositiveFinite,
        prospectiveOneFileIncrementalP95MillisecondsMaximum: PositiveFinite,
        repeatAttemptHotQueryP95Milliseconds: PositiveFinite,
        repeatAttemptOneFileIndexMilliseconds: PositiveFinite,
      }),
      governedInputs: Schema.Struct({
        additionalToleranceRatio: NonNegativeFinite,
        companionHotQueryP50MillisecondsMaximum: PositiveFinite,
        companionHotQueryProcessCpuP95MillisecondsMaximum: PositiveFinite,
        headroomRatio: PositiveFinite,
        previousHotQueryP95MillisecondsMaximum: PositiveFinite,
        previousOneFileIncrementalP95MillisecondsMaximum: PositiveFinite,
        requiredSamples: PositiveInteger,
        roundingQuantumMilliseconds: PositiveInteger,
        schedulerSensitiveWallClockSafetyMultiplier: Schema.Literal(2),
      }),
      observationOrder: Schema.Literal('reverse-chronological; observations[0] is the candidate failure'),
      observations: Schema.Array(Observation),
      provenance: Schema.Struct({
        runnerClass: Schema.Literal('github-hosted-windows-x64'),
        runnerIdentity: Schema.String.check(Schema.isPattern(/^runner-[0-9a-f]{16}$/u)),
        source: Schema.String,
      }),
      repeatAttemptArtifact: Schema.Struct({
        archiveDigest: ArchiveDigest,
        artifactId: PositiveInteger,
        artifactRawJsonSha256: Sha256,
        createdAt: Schema.String,
        jobId: PositiveInteger,
        runAttempt: Schema.Literal(1),
      }),
      type: Schema.Literal('threadnote-windows-scale-10k-hosted-tail-calibration'),
      version: Schema.Literal(2),
    }),
  ),
)(
  await Bun.file(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/windows-scale-10k-hosted-tail-calibration-v2.json',
  ).text(),
);

const hostedBudget = budgetFile.scalePerformanceByRunnerClass['github-hosted-windows-x64']['10000'];
const scaleBudget = budgetFile.scalePerformance['10000'];
const previousWindowsOverride = {
  hotQueryP50MillisecondsMaximum: 750,
  hotQueryP95MillisecondsMaximum: 1_200,
  hotQueryProcessCpuP95MillisecondsMaximum: 500,
  hotQuerySamplesMinimum: 100,
  hotQueryWallP95ToleranceRatioMaximum: 0,
} as const;

describe('hosted Windows 10k scheduler-tail calibration v2', () => {
  it('rederives the 100-sample wall fuse and the 2x one-file safety ceiling', () => {
    const candidate = required(calibration.observations[0]);
    const prior = calibration.observations.slice(1);
    const governed = calibration.governedInputs;
    const derivedQuery =
      Math.ceil(
        (candidate.measurements.hotQueryP95Milliseconds * (1 + governed.headroomRatio)) /
          governed.roundingQuantumMilliseconds,
      ) * governed.roundingQuantumMilliseconds;
    const derivedOneFile =
      governed.previousOneFileIncrementalP95MillisecondsMaximum * governed.schedulerSensitiveWallClockSafetyMultiplier;

    expect(calibration.observations).toHaveLength(calibration.derivation.observationCount);
    expect(prior).toHaveLength(calibration.derivation.priorObservationCount);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.artifactId)).size).toBe(27);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.archiveDigest)).size).toBe(27);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.runId)).size).toBe(26);
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
        governed.companionHotQueryP50MillisecondsMaximum,
      ),
    ).toEqual(calibration.derivation.priorHotQueryP50);
    expect(
      summary(
        EffectArray.map(prior, observation => observation.measurements.hotQueryP95Milliseconds),
        governed.previousHotQueryP95MillisecondsMaximum,
      ),
    ).toEqual(calibration.derivation.priorHotQueryP95);
    expect(
      summary(
        EffectArray.map(prior, observation => observation.measurements.hotQueryProcessCpuP95Milliseconds),
        governed.companionHotQueryProcessCpuP95MillisecondsMaximum,
      ),
    ).toEqual(calibration.derivation.priorHotQueryProcessCpuP95);
    expect(derivedQuery).toBe(2_800);
    expect(derivedQuery).toBe(calibration.derivation.prospectiveHotQueryP95MillisecondsMaximum);
    expect(derivedOneFile).toBe(30_000);
    expect(derivedOneFile).toBe(calibration.derivation.prospectiveOneFileIncrementalP95MillisecondsMaximum);
    expect(derivedOneFile).toBe(
      scaleBudget.oneFileIncrementalP95MillisecondsMaximum *
        budgetFile.developmentPerformanceReplicaSetByRunnerClass['github-hosted-windows-x64']
          .schedulerSensitiveWallClockSafetyMultiplier,
    );
    expect(hostedBudget).toEqual({
      hotQueryP50MillisecondsMaximum: governed.companionHotQueryP50MillisecondsMaximum,
      hotQueryP95MillisecondsMaximum: derivedQuery,
      hotQueryProcessCpuP95MillisecondsMaximum: governed.companionHotQueryProcessCpuP95MillisecondsMaximum,
      hotQuerySamplesMinimum: governed.requiredSamples,
      hotQueryWallP95ToleranceRatioMaximum: governed.additionalToleranceRatio,
      oneFileIncrementalP95MillisecondsMaximum: derivedOneFile,
    });
    expect(scaleBudget.hotQueryP95MillisecondsMaximum).toBe(1_000);
    expect(scaleBudget.oneFileIncrementalP95MillisecondsMaximum).toBe(15_000);
  });

  it('binds both hosted attempts to wall delay while median, CPU, and non-Windows ceilings stay green', () => {
    const candidate = required(calibration.observations[0]);
    const repeat = required(calibration.observations[1]);
    const derivation = calibration.derivation;
    const governed = calibration.governedInputs;

    expect(candidate.headSha).toBe(calibration.candidateCommit);
    expect(calibration.candidateWorkflow.head_sha).toBe(calibration.candidateCommit);
    expect(candidate.artifactId).toBe(calibration.candidateArtifactId);
    expect(repeat.artifactId).toBe(calibration.repeatAttemptArtifact.artifactId);
    expect(candidate.measurements.samples).toBe(100);
    expect(repeat.measurements.samples).toBe(100);
    expect(candidate.measurements.hotQueryP50Milliseconds).toBeLessThan(
      governed.companionHotQueryP50MillisecondsMaximum,
    );
    expect(repeat.measurements.hotQueryP50Milliseconds).toBeLessThan(governed.companionHotQueryP50MillisecondsMaximum);
    expect(candidate.measurements.hotQueryProcessCpuP95Milliseconds).toBeLessThan(
      governed.companionHotQueryProcessCpuP95MillisecondsMaximum,
    );
    expect(repeat.measurements.hotQueryProcessCpuP95Milliseconds).toBeLessThan(
      governed.companionHotQueryProcessCpuP95MillisecondsMaximum,
    );
    expect(candidate.measurements.hotQueryP95Milliseconds).toBeGreaterThan(
      governed.previousHotQueryP95MillisecondsMaximum,
    );
    expect(repeat.measurements.hotQueryP95Milliseconds).toBeGreaterThan(
      governed.previousHotQueryP95MillisecondsMaximum,
    );
    expect(
      candidate.measurements.hotQueryP95Milliseconds / candidate.measurements.hotQueryProcessCpuP95Milliseconds,
    ).toBeGreaterThan(8);
    expect(required(candidate.measurements.oneFileIndexMilliseconds)).toBeGreaterThan(
      governed.previousOneFileIncrementalP95MillisecondsMaximum,
    );
    expect(required(repeat.measurements.oneFileIndexMilliseconds)).toBeLessThan(
      governed.previousOneFileIncrementalP95MillisecondsMaximum,
    );
    expect(required(candidate.measurements.oneFileHeartbeatGapMilliseconds)).toBeGreaterThan(10_000);
    expect(required(candidate.measurements.oneFileActivationProcessCpuMilliseconds)).toBeLessThan(1_000);
    expect(derivation.priorHotQueryP95.breaches).toBe(1);
    expect(derivation.repeatAttemptHotQueryP95Milliseconds).toBe(repeat.measurements.hotQueryP95Milliseconds);
  });

  it('replays the candidate: previous fuse fails, each override is required, and the v2 budget passes', () => {
    const artifact = parseBenchmarkArtifactV1(calibration.candidateBudgetArtifact);
    const previousBudget = {
      ...budgetFile,
      scalePerformanceByRunnerClass: {
        'github-hosted-windows-x64': {'10000': previousWindowsOverride},
      },
    };
    const queryOnlyBudget = {
      ...budgetFile,
      scalePerformanceByRunnerClass: {
        'github-hosted-windows-x64': {
          '10000': {
            ...previousWindowsOverride,
            hotQueryP95MillisecondsMaximum: hostedBudget.hotQueryP95MillisecondsMaximum,
          },
        },
      },
    };
    const oneFileOnlyBudget = {
      ...budgetFile,
      scalePerformanceByRunnerClass: {
        'github-hosted-windows-x64': {
          '10000': {
            ...previousWindowsOverride,
            oneFileIncrementalP95MillisecondsMaximum: hostedBudget.oneFileIncrementalP95MillisecondsMaximum,
          },
        },
      },
    };

    expect(artifact.metadata.runnerClass).toBe('github-hosted-windows-x64');
    expect(() => enforceCodeGraphBenchmarkBudget(artifact, previousBudget, 10_000)).toThrow(
      /one-file-reindex-index[\s\S]*hot-exact-lexical-query|hot-exact-lexical-query[\s\S]*one-file-reindex-index/u,
    );
    expect(() => enforceCodeGraphBenchmarkBudget(artifact, queryOnlyBudget, 10_000)).toThrow(/one-file-reindex-index/u);
    expect(() => enforceCodeGraphBenchmarkBudget(artifact, oneFileOnlyBudget, 10_000)).toThrow(
      /hot-exact-lexical-query/u,
    );
    expect(() => enforceCodeGraphBenchmarkBudget(artifact, budgetFile, 10_000)).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkBudget(withRunnerClass(artifact, 'github-hosted-linux-x64'), budgetFile, 10_000),
    ).toThrow(/hot-exact-lexical-query|one-file-reindex-index/u);
  });

  it('keeps the p95 and one-file companion guards strict above each hosted boundary', () => {
    const artifact = parseBenchmarkArtifactV1(calibration.candidateBudgetArtifact);
    const boundary = replaceStatistics(artifact, {
      p50: hostedBudget.hotQueryP50MillisecondsMaximum,
      p95: hostedBudget.hotQueryP95MillisecondsMaximum,
      processCpuP95: hostedBudget.hotQueryProcessCpuP95MillisecondsMaximum,
      oneFileIndex: hostedBudget.oneFileIncrementalP95MillisecondsMaximum,
    });
    expect(() => enforceCodeGraphBenchmarkBudget(boundary, budgetFile, 10_000)).not.toThrow();

    fc.assert(
      fc.property(
        fc.constantFrom('p50' as const, 'p95' as const, 'cpu' as const, 'oneFile' as const),
        fc.double({max: 400, min: 0.000_001, noDefaultInfinity: true, noNaN: true}),
        (guard, delta) => {
          const regressed = replaceStatistics(boundary, {
            p50: hostedBudget.hotQueryP50MillisecondsMaximum + (guard === 'p50' ? delta : 0),
            p95: hostedBudget.hotQueryP95MillisecondsMaximum + (guard === 'p95' ? delta : 0),
            processCpuP95: hostedBudget.hotQueryProcessCpuP95MillisecondsMaximum + (guard === 'cpu' ? delta : 0),
            oneFileIndex: hostedBudget.oneFileIncrementalP95MillisecondsMaximum + (guard === 'oneFile' ? delta : 0),
          });
          expect(() => enforceCodeGraphBenchmarkBudget(regressed, budgetFile, 10_000)).toThrow(
            guard === 'p50'
              ? /p50/u
              : guard === 'cpu'
                ? /hot-query-process-cpu/u
                : guard === 'oneFile'
                  ? /one-file-reindex-index/u
                  : /hot-exact-lexical-query/u,
          );
        },
      ),
      {numRuns: 120},
    );
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Windows 10k v2 calibration value is missing.');
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

function withRunnerClass(artifact: BenchmarkArtifactV1, runnerClass: string): BenchmarkArtifactV1 {
  return parseBenchmarkArtifactV1({
    ...artifact,
    metadata: {...artifact.metadata, runnerClass},
  });
}

function replaceStatistics(
  artifact: BenchmarkArtifactV1,
  values: {
    readonly p50: number;
    readonly p95: number;
    readonly processCpuP95: number;
    readonly oneFileIndex: number;
  },
): BenchmarkArtifactV1 {
  return parseBenchmarkArtifactV1({
    ...artifact,
    measurements: EffectArray.map(artifact.measurements, measurement => {
      if (measurement.name === 'hot-exact-lexical-query') {
        const maximum = Math.max(values.p50, values.p95);
        return {...measurement, maximum, p50: values.p50, p95: values.p95, p99: maximum};
      }
      if (measurement.name === 'hot-query-process-cpu') {
        const maximum = Math.max(measurement.p50, values.processCpuP95);
        return {...measurement, maximum, p95: values.processCpuP95, p99: maximum};
      }
      if (measurement.name === 'one-file-reindex-index') {
        return {
          ...measurement,
          maximum: values.oneFileIndex,
          mean: values.oneFileIndex,
          minimum: values.oneFileIndex,
          p50: values.oneFileIndex,
          p95: values.oneFileIndex,
          p99: values.oneFileIndex,
        };
      }
      return measurement;
    }),
  });
}
