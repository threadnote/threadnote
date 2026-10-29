import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {enforceCodeGraphBenchmarkBudget} from '../../../../scripts/benchmark-code-graph.js';
import {
  BenchmarkEnvironmentSchemaV1,
  BenchmarkMeasurementSchemaV1,
  benchmarkMeasurement,
  type BenchmarkArtifactV1,
} from '@threadnote/evidence/benchmark';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const GitCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const ArchiveDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));
const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u));

const PerformanceBudget = Schema.Struct({
  coldIndexP95MillisecondsMaximum: PositiveFinite,
  coldMaterializationP95MillisecondsMaximum: PositiveFinite,
  derivedIndexBytesMaximum: PositiveFinite,
  hotQueryP50MillisecondsMaximum: PositiveFinite,
  hotQueryP95MillisecondsMaximum: PositiveFinite,
  hotQueryProcessCpuP95MillisecondsMaximum: PositiveFinite,
  hotQueryWallP95ToleranceRatioMaximum: NonNegativeFinite,
  oneFileIncrementalP95MillisecondsMaximum: PositiveFinite,
  oneFileMaterializationP95MillisecondsMaximum: PositiveFinite,
  processPeakRssBytesMaximum: PositiveFinite,
  wholeGraphAnalysisP95MillisecondsMaximum: PositiveFinite,
});

const budgetFile = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      developmentPerformance: PerformanceBudget,
      developmentPerformanceByPlatform: Schema.Struct({
        win32: Schema.Struct({
          coldIndexP95MillisecondsMaximum: PositiveFinite,
          coldMaterializationP95MillisecondsMaximum: PositiveFinite,
          hotQueryP50MillisecondsMaximum: PositiveFinite,
          hotQueryP95MillisecondsMaximum: PositiveFinite,
          hotQueryProcessCpuP95MillisecondsMaximum: PositiveFinite,
          oneFileIncrementalP95MillisecondsMaximum: PositiveFinite,
          wholeGraphAnalysisP95MillisecondsMaximum: PositiveFinite,
        }),
      }),
      developmentPerformanceByRunnerClass: Schema.Struct({
        'github-hosted-windows-x64': Schema.Struct({
          hotQuerySamplesMinimum: Schema.Literal(100),
        }),
      }),
    }),
  ),
)(await Bun.file('apps/threadnote/test/evaluation/baselines/code-graph-v1/budgets.json').text());

const Observation = Schema.Struct({
  archiveDigest: ArchiveDigest,
  artifactId: PositiveInteger,
  createdAt: IsoInstant,
  digests: Schema.Struct({
    cold: Sha256,
    incremental: Sha256,
    sameOverlayReference: Sha256,
  }),
  environment: Schema.Struct({
    architecture: Schema.Literal('x64'),
    cpu: Schema.String,
    fixtureHash: Schema.Literal('c4c45a6bcc25517df1fdae711f19f4989e13fde6b4763d596d547c6757230e7d'),
    memoryBytes: PositiveInteger,
    operatingSystem: Schema.Literal('Windows 10.0.26100'),
    runnerClass: Schema.Literal('local-unclassified'),
    runtime: Schema.Literal('bun/1.3.14'),
  }),
  headSha: GitCommit,
  measurements: Schema.Struct({
    coldActivationLongestTransactionMilliseconds: NonNegativeFinite,
    coldIndexMilliseconds: PositiveFinite,
    coldMaterializationMilliseconds: PositiveFinite,
    coldMaterializationProcessCpuMilliseconds: NonNegativeFinite,
    coldMaximumProgressHeartbeatGapMilliseconds: NonNegativeFinite,
    coldProcessCpuMilliseconds: NonNegativeFinite,
    coldSnapshotWriteAndCheckpointMilliseconds: NonNegativeFinite,
  }),
  rawJsonSha256: Sha256,
  runId: PositiveInteger,
});

const calibration = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      candidateBudgetArtifact: Schema.Struct({
        createdAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)),
        environment: BenchmarkEnvironmentSchemaV1,
        metadata: Schema.Struct({
          runnerClass: Schema.Literal('local-unclassified'),
          runtimePlatform: Schema.Literal('win32'),
          vectorEnabled: Schema.Literal(false),
        }),
        suite: Schema.Literal('code-graph-v1'),
        version: Schema.Literal(1),
        warmups: Schema.Literal(5),
      }),
      candidateBudgetMeasurements: Schema.Array(BenchmarkMeasurementSchemaV1),
      candidateCommit: GitCommit,
      candidateWorkflow: Schema.Struct({
        artifactStep: Schema.Struct({
          conclusion: Schema.Literal('success'),
          name: Schema.Literal('Run actions/upload-artifact@v7'),
        }),
        captureStep: Schema.Struct({
          conclusion: Schema.Literal('failure'),
          name: Schema.Literal('Capture native graph benchmark'),
        }),
        jobId: PositiveInteger,
        jobName: Schema.Literal('Code graph · windows-latest'),
        qualityStep: Schema.Struct({
          conclusion: Schema.Literal('success'),
          name: Schema.Literal('Gate native graph quality'),
        }),
        runId: PositiveInteger,
      }),
      derivation: Schema.Struct({
        candidateColdIndexMilliseconds: PositiveFinite,
        candidateColdMaterializationMilliseconds: PositiveFinite,
        priorColdIndex: Schema.Struct({
          breaches: Schema.Literal(0),
          maximum: PositiveFinite,
          minimum: PositiveFinite,
          p50: PositiveFinite,
          p95: PositiveFinite,
        }),
        priorColdMaterialization: Schema.Struct({
          breaches: Schema.Literal(0),
          maximum: PositiveFinite,
          minimum: PositiveFinite,
          p50: PositiveFinite,
          p95: PositiveFinite,
        }),
        priorObservationCount: PositiveInteger,
        prospectiveColdIndexMaximumMilliseconds: PositiveFinite,
        prospectiveColdMaterializationMaximumMilliseconds: PositiveFinite,
      }),
      governedInputs: Schema.Struct({
        coldIndexPriorMaximumMilliseconds: PositiveFinite,
        coldMaterializationPriorMaximumMilliseconds: PositiveFinite,
        headroomRatio: PositiveFinite,
        roundingQuantumMilliseconds: PositiveInteger,
      }),
      observationOrder: Schema.Literal('reverse-chronological; observations[0] is the candidate failure'),
      observations: Schema.Array(Observation),
      type: Schema.Literal('threadnote-windows-native-hosted-tail-calibration'),
      version: Schema.Literal(1),
    }),
  ),
)(
  await Bun.file(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/windows-native-hosted-tail-calibration-v1.json',
  ).text(),
);

const windowsBudget = budgetFile.developmentPerformanceByPlatform.win32;
const candidateBudgetMeasurementNames = [
  'cold-index',
  'cold-materialization',
  'one-file-reindex-index',
  'one-file-reindex-materialization',
  'hot-exact-lexical-query',
  'hot-query-process-cpu',
  'whole-graph-structural-analysis',
  'incremental-process-peak-rss',
  'derived-index-disk',
];
const previousBudgetFile = {
  ...budgetFile,
  developmentPerformanceByPlatform: {
    win32: {
      ...windowsBudget,
      coldIndexP95MillisecondsMaximum: calibration.governedInputs.coldIndexPriorMaximumMilliseconds,
      coldMaterializationP95MillisecondsMaximum: calibration.governedInputs.coldMaterializationPriorMaximumMilliseconds,
    },
  },
};

describe('hosted Windows native cold-tail calibration', () => {
  it('rederives the historical context and the prospective single-observation fuses', () => {
    const candidate = requiredObservation(calibration.observations[0]);
    const prior = calibration.observations.slice(1);
    const priorColdIndex = EffectArray.map(prior, observation => observation.measurements.coldIndexMilliseconds);
    const priorMaterialization = EffectArray.map(
      prior,
      observation => observation.measurements.coldMaterializationMilliseconds,
    );

    expect(calibration.observations).toHaveLength(32);
    expect(prior).toHaveLength(calibration.derivation.priorObservationCount);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.runId)).size).toBe(32);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.artifactId)).size).toBe(32);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.rawJsonSha256)).size).toBe(32);
    expect(EffectArray.map(calibration.candidateBudgetMeasurements, measurement => measurement.name)).toEqual(
      candidateBudgetMeasurementNames,
    );
    expect(calibration.candidateWorkflow).toMatchObject({
      artifactStep: {conclusion: 'success'},
      captureStep: {conclusion: 'failure'},
      jobId: 99_669_723_176,
      qualityStep: {conclusion: 'success'},
      runId: candidate.runId,
    });
    expect(
      Effect.pipe(calibration.observations, __effectNativeArray =>
        EffectArray.every(
          __effectNativeArray,
          (observation, index) =>
            index === 0 ||
            Date.parse(requiredObservation(__effectNativeArray[index - 1]).createdAt) >=
              Date.parse(observation.createdAt),
        ),
      ),
    ).toBe(true);
    expect(
      EffectArray.every(
        calibration.observations,
        observation => observation.digests.incremental === observation.digests.sameOverlayReference,
      ),
    ).toBe(true);

    expect(summary(priorColdIndex, calibration.governedInputs.coldIndexPriorMaximumMilliseconds)).toEqual(
      calibration.derivation.priorColdIndex,
    );
    expect(
      summary(priorMaterialization, calibration.governedInputs.coldMaterializationPriorMaximumMilliseconds),
    ).toEqual(calibration.derivation.priorColdMaterialization);
    expect(candidate.headSha).toBe(calibration.candidateCommit);
    expect(candidate.measurements.coldIndexMilliseconds).toBe(calibration.derivation.candidateColdIndexMilliseconds);
    expect(candidate.measurements.coldMaterializationMilliseconds).toBe(
      calibration.derivation.candidateColdMaterializationMilliseconds,
    );

    const derive = (value: number) =>
      Math.ceil(
        (value * (1 + calibration.governedInputs.headroomRatio)) /
          calibration.governedInputs.roundingQuantumMilliseconds,
      ) * calibration.governedInputs.roundingQuantumMilliseconds;
    expect(derive(candidate.measurements.coldIndexMilliseconds)).toBe(
      calibration.derivation.prospectiveColdIndexMaximumMilliseconds,
    );
    expect(derive(candidate.measurements.coldMaterializationMilliseconds)).toBe(
      calibration.derivation.prospectiveColdMaterializationMaximumMilliseconds,
    );
    expect(windowsBudget.coldIndexP95MillisecondsMaximum).toBe(
      calibration.derivation.prospectiveColdIndexMaximumMilliseconds,
    );
    expect(windowsBudget.coldMaterializationP95MillisecondsMaximum).toBe(
      calibration.derivation.prospectiveColdMaterializationMaximumMilliseconds,
    );
  });

  it('binds the candidate tail to wall/storage delay rather than increased graph CPU work', () => {
    const candidate = requiredObservation(calibration.observations[0]);
    const predecessor = requiredObservation(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          calibration.observations,
          observation => observation.headSha === '4cf4c966cf272a3cb066db29750a415766ec5954',
        ),
      ),
    );

    expect(candidate.artifactId).toBe(9_778_600_223);
    expect(candidate.runId).toBe(33_447_480_677);
    expect(candidate.rawJsonSha256).toBe('b00b2e24b5d647e613cdd91c5521afef1bb79351556a86c456c39ce670cc6e86');
    expect(candidate.measurements.coldProcessCpuMilliseconds).toBeLessThan(
      predecessor.measurements.coldProcessCpuMilliseconds,
    );
    expect(candidate.measurements.coldMaterializationProcessCpuMilliseconds).toBeLessThan(
      predecessor.measurements.coldMaterializationProcessCpuMilliseconds * 1.1,
    );
    expect(candidate.measurements.coldIndexMilliseconds).toBeGreaterThan(
      predecessor.measurements.coldIndexMilliseconds * 1.8,
    );
    expect(candidate.measurements.coldMaterializationMilliseconds).toBeGreaterThan(
      predecessor.measurements.coldMaterializationMilliseconds * 3.7,
    );
    expect(candidate.measurements.coldMaximumProgressHeartbeatGapMilliseconds).toBeGreaterThan(
      predecessor.measurements.coldMaximumProgressHeartbeatGapMilliseconds * 4,
    );
    expect(candidate.measurements.coldSnapshotWriteAndCheckpointMilliseconds).toBeGreaterThan(
      predecessor.measurements.coldSnapshotWriteAndCheckpointMilliseconds * 10,
    );
  });

  it('replays the exact old two-failure set and the prospective all-budget pass', () => {
    const artifact = candidateArtifact();
    const previousFailures = budgetFailures(artifact, previousBudgetFile);

    expect(previousFailures).toHaveLength(2);
    expect(previousFailures[0]).toMatch(/^cold-index /u);
    expect(previousFailures[1]).toMatch(/^cold-materialization /u);
    expect(() => enforceCodeGraphBenchmarkBudget(artifact, budgetFile, undefined)).not.toThrow();
  });

  it('keeps the Windows fuse prospective, platform-scoped, and strict above its boundary', () => {
    const candidate = requiredObservation(calibration.observations[0]);
    expect(() => enforceCodeGraphBenchmarkBudget(candidateArtifact(), budgetFile, undefined)).not.toThrow();
    expect(() => enforceCodeGraphBenchmarkBudget(candidateArtifact('linux'), budgetFile, undefined)).toThrow(
      /cold-index|cold-materialization/u,
    );

    const atBoundary = replaceAllStatistics(
      replaceAllStatistics(candidateArtifact(), 'cold-index', windowsBudget.coldIndexP95MillisecondsMaximum),
      'cold-materialization',
      windowsBudget.coldMaterializationP95MillisecondsMaximum,
    );
    expect(() => enforceCodeGraphBenchmarkBudget(atBoundary, budgetFile, undefined)).not.toThrow();

    fc.assert(
      fc.property(
        fc.constantFrom<'cold-index' | 'cold-materialization'>('cold-index', 'cold-materialization'),
        fc.double({max: 100_000, min: 0.000_001, noDefaultInfinity: true, noNaN: true}),
        (measurement, delta) => {
          const maximum =
            measurement === 'cold-index'
              ? windowsBudget.coldIndexP95MillisecondsMaximum
              : windowsBudget.coldMaterializationP95MillisecondsMaximum;
          const regressed = replaceAllStatistics(atBoundary, measurement, maximum + delta);
          expect(() => enforceCodeGraphBenchmarkBudget(regressed, budgetFile, undefined)).toThrow(
            new RegExp(measurement, 'u'),
          );
        },
      ),
      {numRuns: 100},
    );

    expect(candidate.measurements.coldIndexMilliseconds).toBeLessThan(windowsBudget.coldIndexP95MillisecondsMaximum);
    expect(candidate.measurements.coldMaterializationMilliseconds).toBeLessThan(
      windowsBudget.coldMaterializationP95MillisecondsMaximum,
    );
  });

  it('requires 100 hot-query samples only on the matching hosted Windows runner class', () => {
    const hosted = hostedCandidateArtifact(100);
    expect(() => enforceCodeGraphBenchmarkBudget(hosted, budgetFile, undefined)).not.toThrow();
    expect(() => enforceCodeGraphBenchmarkBudget(candidateArtifact(), budgetFile, undefined)).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkBudget(hostedCandidateArtifact(25, {architecture: 'arm64'}), budgetFile, undefined),
    ).not.toThrow();
    expect(budgetFailures(hostedCandidateArtifact(25, {runtimePlatform: 'linux'}), budgetFile)).not.toContain(
      'hot-exact-lexical-query requires at least 100 samples for wall tolerance',
    );
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        hostedCandidateArtifact(25, {runnerClass: 'github-hosted-linux-x64'}),
        budgetFile,
        undefined,
      ),
    ).not.toThrow();

    fc.assert(
      fc.property(fc.integer({max: 99, min: 1}), samples => {
        expect(() => enforceCodeGraphBenchmarkBudget(hostedCandidateArtifact(samples), budgetFile, undefined)).toThrow(
          /requires at least 100 samples/u,
        );
      }),
      {numRuns: 100},
    );
    fc.assert(
      fc.property(fc.integer({max: 250, min: 100}), samples => {
        expect(() =>
          enforceCodeGraphBenchmarkBudget(hostedCandidateArtifact(samples), budgetFile, undefined),
        ).not.toThrow();
      }),
      {numRuns: 100},
    );
  });

  it('uses the production percentile at the four-versus-five guarded wall-tail boundary', () => {
    const wallMaximum =
      windowsBudget.hotQueryP95MillisecondsMaximum *
      (1 + budgetFile.developmentPerformance.hotQueryWallP95ToleranceRatioMaximum);
    const wallSamples = (breaches: 4 | 5) => [
      ...Array.from({length: 95}, () => 500),
      ...(breaches === 4 ? [wallMaximum] : []),
      ...Array.from({length: breaches}, () => wallMaximum + 1),
    ];
    const withWall = (breaches: 4 | 5) =>
      replaceMeasurement(hostedCandidateArtifact(100), 'hot-exact-lexical-query', () =>
        benchmarkMeasurement('hot-exact-lexical-query', 'milliseconds', wallSamples(breaches)),
      );

    expect(() => enforceCodeGraphBenchmarkBudget(withWall(4), budgetFile, undefined)).not.toThrow();
    expect(() => enforceCodeGraphBenchmarkBudget(withWall(5), budgetFile, undefined)).toThrow(
      /hot-exact-lexical-query/u,
    );
  });

  it('keeps every unchanged independent budget strict above its boundary', () => {
    const unchangedGuards: readonly GuardMutation[] = [
      {
        expected: /one-file-reindex-index/u,
        regress: (artifact, delta) =>
          replaceAllStatistics(
            artifact,
            'one-file-reindex-index',
            windowsBudget.oneFileIncrementalP95MillisecondsMaximum + delta,
          ),
      },
      {
        expected: /one-file-reindex-materialization/u,
        regress: (artifact, delta) =>
          replaceAllStatistics(
            artifact,
            'one-file-reindex-materialization',
            budgetFile.developmentPerformance.oneFileMaterializationP95MillisecondsMaximum + delta,
          ),
      },
      {
        expected: /whole-graph-structural-analysis/u,
        regress: (artifact, delta) =>
          replaceAllStatistics(
            artifact,
            'whole-graph-structural-analysis',
            windowsBudget.wholeGraphAnalysisP95MillisecondsMaximum + delta,
          ),
      },
      {
        expected: /incremental-process-peak-rss/u,
        regress: (artifact, delta) =>
          replaceAllStatistics(
            artifact,
            'incremental-process-peak-rss',
            budgetFile.developmentPerformance.processPeakRssBytesMaximum + delta,
          ),
      },
      {
        expected: /derived-index-disk/u,
        regress: (artifact, delta) =>
          replaceAllStatistics(
            artifact,
            'derived-index-disk',
            budgetFile.developmentPerformance.derivedIndexBytesMaximum + delta,
          ),
      },
      {
        expected: /p50/u,
        regress: (artifact, delta) =>
          replaceMeasurement(artifact, 'hot-exact-lexical-query', measurement => {
            const value = windowsBudget.hotQueryP50MillisecondsMaximum + delta;
            return {
              ...measurement,
              maximum: Math.max(measurement.maximum, value),
              p50: value,
              p95: Math.max(measurement.p95, value),
              p99: Math.max(measurement.p99, value),
            };
          }),
      },
      {
        expected: /hot-query-process-cpu/u,
        regress: (artifact, delta) =>
          replaceMeasurement(artifact, 'hot-query-process-cpu', measurement => {
            const value = windowsBudget.hotQueryProcessCpuP95MillisecondsMaximum + delta;
            return {
              ...measurement,
              maximum: Math.max(measurement.maximum, value),
              p95: value,
              p99: value,
            };
          }),
      },
      {
        expected: /hot-exact-lexical-query/u,
        regress: (artifact, delta) =>
          replaceMeasurement(artifact, 'hot-exact-lexical-query', measurement => {
            const value =
              windowsBudget.hotQueryP95MillisecondsMaximum *
                (1 + budgetFile.developmentPerformance.hotQueryWallP95ToleranceRatioMaximum) +
              delta;
            return {
              ...measurement,
              maximum: Math.max(measurement.maximum, value),
              p95: value,
              p99: value,
            };
          }),
      },
    ];

    fc.assert(
      fc.property(
        fc.integer({max: unchangedGuards.length - 1, min: 0}),
        fc.double({max: 100_000, min: 0.000_001, noDefaultInfinity: true, noNaN: true}),
        (guardIndex, delta) => {
          const guard = requiredObservation(unchangedGuards[guardIndex]);
          expect(() =>
            enforceCodeGraphBenchmarkBudget(guard.regress(candidateArtifact(), delta), budgetFile, undefined),
          ).toThrow(guard.expected);
        },
      ),
      {numRuns: 160},
    );
  });
});

interface GuardMutation {
  readonly expected: RegExp;
  readonly regress: (artifact: BenchmarkArtifactV1, delta: number) => BenchmarkArtifactV1;
}

function requiredObservation<T>(observation: T | undefined): T {
  if (observation === undefined) throw new Error('Windows calibration observation is missing.');
  return observation;
}

function summary(values: readonly number[], previousMaximum: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const nearestRank = (percentile: number) =>
    requiredObservation(sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]);
  return {
    breaches: EffectArray.filter(sorted, value => value > previousMaximum).length,
    maximum: requiredObservation(sorted.at(-1)),
    minimum: requiredObservation(sorted[0]),
    p50: nearestRank(0.5),
    p95: nearestRank(0.95),
  };
}

function candidateArtifact(
  runtimePlatform: string = calibration.candidateBudgetArtifact.metadata.runtimePlatform,
): BenchmarkArtifactV1 {
  return {
    ...calibration.candidateBudgetArtifact,
    measurements: calibration.candidateBudgetMeasurements,
    metadata: {...calibration.candidateBudgetArtifact.metadata, runtimePlatform},
  };
}

function hostedCandidateArtifact(
  samples: number,
  overrides: {
    readonly architecture?: string;
    readonly runnerClass?: string;
    readonly runtimePlatform?: string;
  } = {},
): BenchmarkArtifactV1 {
  const artifact = candidateArtifact(overrides.runtimePlatform);
  return {
    ...artifact,
    environment: {...artifact.environment, architecture: overrides.architecture ?? artifact.environment.architecture},
    measurements: EffectArray.map(artifact.measurements, measurement =>
      measurement.name === 'hot-exact-lexical-query' || measurement.name === 'hot-query-process-cpu'
        ? {...measurement, samples}
        : measurement,
    ),
    metadata: {...artifact.metadata, runnerClass: overrides.runnerClass ?? 'github-hosted-windows-x64'},
  };
}

function budgetFailures(artifact: BenchmarkArtifactV1, budgets: typeof budgetFile): readonly string[] {
  try {
    enforceCodeGraphBenchmarkBudget(artifact, budgets, undefined);
    return [];
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const prefix = 'Code graph performance budget failed: ';
    if (!Effect.pipe(error.message, EffectString.startsWith(prefix))) throw error;
    return Effect.pipe(error.message, EffectString.slice(prefix.length), EffectString.split('; '));
  }
}

function replaceAllStatistics(artifact: BenchmarkArtifactV1, name: string, value: number): BenchmarkArtifactV1 {
  return replaceMeasurement(artifact, name, measurement => ({
    ...measurement,
    maximum: value,
    mean: value,
    minimum: value,
    p50: value,
    p95: value,
    p99: value,
  }));
}

function replaceMeasurement(
  artifact: BenchmarkArtifactV1,
  name: string,
  update: (measurement: BenchmarkArtifactV1['measurements'][number]) => BenchmarkArtifactV1['measurements'][number],
): BenchmarkArtifactV1 {
  const measurement = EffectOption.getOrUndefined(
    EffectArray.findFirst(artifact.measurements, candidate => candidate.name === name),
  );
  if (measurement === undefined) throw new Error(`Candidate budget measurement ${name} is missing.`);
  return {
    ...artifact,
    measurements: EffectArray.map(artifact.measurements, candidate =>
      candidate.name === name ? update(measurement) : candidate,
    ),
  };
}
