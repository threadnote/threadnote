import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {enforceCodeGraphBenchmarkBudget} from '../../../../scripts/benchmark-code-graph.js';
import type {BenchmarkArtifactV1, BenchmarkMeasurementV1} from '@threadnote/evidence/benchmark';

const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const GitObjectId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const RunnerIdentity = Schema.String.check(Schema.isPattern(/^runner-[0-9a-f]{16}$/u));

const calibration = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      codeGraphSourceTree: Schema.Literal('9278a440106017f54944df66885831518ff9e863'),
      collection: Schema.Struct({samples: Schema.Literal(25), warmups: Schema.Literal(5)}),
      expected: Schema.Struct({
        guardedBreaches: Schema.Literal(0),
        maximumObservedWallP50Milliseconds: Positive,
        observations: Schema.Literal(6),
        ordinaryBoundaryDeltaMilliseconds: Positive,
        ordinaryBoundaryRatio: Positive,
        ordinaryBreaches: Schema.Literal(1),
      }),
      fixtureHash: Sha256,
      observations: Schema.Array(
        Schema.Struct({
          archiveSha256: Sha256,
          artifactId: PositiveInteger,
          benchmarkHarnessBlob: GitObjectId,
          codeGraphSourceTree: GitObjectId,
          commit: GitObjectId,
          createdAt: Schema.String,
          jobId: PositiveInteger,
          processCpuMilliseconds: Schema.Struct({maximum: Positive, p95: Positive}),
          rawJsonSha256: Sha256,
          runnerIdentity: RunnerIdentity,
          sourceTree: GitObjectId,
          wallMilliseconds: Schema.Struct({maximum: Positive, p50: Positive, p95: Positive}),
          workflowRun: PositiveInteger,
        }),
      ),
      policy: Schema.Struct({
        guardedToleranceRatioMaximum: Schema.Literal(0.05),
        guardedWallP50MillisecondsMaximum: Schema.Literal(131.25),
        hotWallP95MillisecondsMaximum: Schema.Literal(250),
        hotWallP95ToleranceRatioMaximum: Schema.Literal(0.05),
        ordinaryWallP50MillisecondsMaximum: Schema.Literal(125),
        processCpuP95MillisecondsMaximum: Schema.Literal(250),
      }),
      runnerClass: Schema.Literal('github-hosted-macos-arm64'),
      runtime: Schema.Literal('bun/1.3.14'),
      type: Schema.Literal('threadnote-macos-native-hosted-median-calibration'),
      version: Schema.Literal(1),
    }),
  ),
)(
  await Bun.file(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/macos-native-hosted-median-calibration-v1.json',
  ).text(),
);
const budget: unknown = JSON.parse(
  await Bun.file('apps/threadnote/test/evaluation/baselines/code-graph-v1/budgets.json').text(),
);

describe('hosted macOS native median calibration', () => {
  it('rederives one ordinary breach and no guarded breach from independent hosted runners', () => {
    const medians = EffectArray.map(calibration.observations, observation => observation.wallMilliseconds.p50);
    expect(medians).toHaveLength(calibration.expected.observations);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.workflowRun)).size).toBe(
      calibration.expected.observations,
    );
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.jobId)).size).toBe(
      calibration.expected.observations,
    );
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.artifactId)).size).toBe(
      calibration.expected.observations,
    );
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.archiveSha256)).size).toBe(
      calibration.expected.observations,
    );
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.rawJsonSha256)).size).toBe(
      calibration.expected.observations,
    );
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.runnerIdentity)).size).toBe(
      calibration.expected.observations,
    );
    expect(
      EffectArray.every(
        calibration.observations,
        observation => observation.codeGraphSourceTree === calibration.codeGraphSourceTree,
      ),
    ).toBe(true);
    expect(
      new Set(EffectArray.map(calibration.observations.slice(-3), observation => observation.benchmarkHarnessBlob))
        .size,
    ).toBe(1);
    expect(Math.max(...medians)).toBe(calibration.expected.maximumObservedWallP50Milliseconds);
    expect(
      calibration.expected.maximumObservedWallP50Milliseconds - calibration.policy.ordinaryWallP50MillisecondsMaximum,
    ).toBeCloseTo(calibration.expected.ordinaryBoundaryDeltaMilliseconds, 9);
    expect(
      calibration.expected.maximumObservedWallP50Milliseconds / calibration.policy.ordinaryWallP50MillisecondsMaximum,
    ).toBeCloseTo(calibration.expected.ordinaryBoundaryRatio, 9);
    expect(
      EffectArray.filter(medians, value => value > calibration.policy.ordinaryWallP50MillisecondsMaximum),
    ).toHaveLength(calibration.expected.ordinaryBreaches);
    expect(
      EffectArray.filter(medians, value => value > calibration.policy.guardedWallP50MillisecondsMaximum),
    ).toHaveLength(calibration.expected.guardedBreaches);
    expect(
      calibration.policy.ordinaryWallP50MillisecondsMaximum * (1 + calibration.policy.guardedToleranceRatioMaximum),
    ).toBe(calibration.policy.guardedWallP50MillisecondsMaximum);
    expect(
      EffectArray.every(
        calibration.observations,
        observation =>
          observation.wallMilliseconds.p95 <= calibration.policy.hotWallP95MillisecondsMaximum &&
          observation.processCpuMilliseconds.p95 <= calibration.policy.processCpuP95MillisecondsMaximum,
      ),
    ).toBe(true);
  });

  it('applies the median tolerance only to the matching hosted macOS runner class', () => {
    expect(() => enforceCodeGraphBenchmarkBudget(macArtifact(125), budget, undefined)).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        macArtifact(calibration.expected.maximumObservedWallP50Milliseconds),
        budget,
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        macArtifact(calibration.policy.guardedWallP50MillisecondsMaximum),
        budget,
        undefined,
      ),
    ).not.toThrow();

    for (const artifact of [
      macArtifact(calibration.expected.maximumObservedWallP50Milliseconds, {runnerClass: 'local-unclassified'}),
      macArtifact(calibration.expected.maximumObservedWallP50Milliseconds, {architecture: 'x64'}),
      macArtifact(calibration.expected.maximumObservedWallP50Milliseconds, {runtimePlatform: 'linux'}),
    ]) {
      expect(() => enforceCodeGraphBenchmarkBudget(artifact, budget, undefined)).toThrow(/p50/u);
    }
  });

  it('keeps the CPU and p95 companions strict while failing monotonically above the median boundary', () => {
    const cpuRegression = replaceMeasurement(macArtifact(125), 'hot-query-process-cpu', measurement => ({
      ...measurement,
      maximum: 250.001,
      p95: 250.001,
      p99: 250.001,
    }));
    expect(() => enforceCodeGraphBenchmarkBudget(cpuRegression, budget, undefined)).toThrow(/hot-query-process-cpu/u);

    const p95Regression = replaceMeasurement(macArtifact(125), 'hot-exact-lexical-query', measurement => ({
      ...measurement,
      maximum: 262.501,
      p95: 262.501,
      p99: 262.501,
    }));
    expect(() => enforceCodeGraphBenchmarkBudget(p95Regression, budget, undefined)).toThrow(/hot-exact-lexical-query/u);

    fc.assert(
      fc.property(fc.double({max: 10_000, min: 0.000_001, noDefaultInfinity: true, noNaN: true}), delta => {
        expect(() =>
          enforceCodeGraphBenchmarkBudget(
            macArtifact(calibration.policy.guardedWallP50MillisecondsMaximum + delta),
            budget,
            undefined,
          ),
        ).toThrow(/p50/u);
      }),
      {numRuns: 100},
    );
  });
});

function macArtifact(
  wallP50: number,
  overrides: {
    readonly architecture?: string;
    readonly runnerClass?: string;
    readonly runtimePlatform?: string;
  } = {},
): BenchmarkArtifactV1 {
  const wallP95 = Math.max(155, wallP50);
  return {
    createdAt: '2026-09-01T03:37:45.778Z',
    environment: {
      architecture: overrides.architecture ?? 'arm64',
      commit: '9d037a04c5f23da0a356d2578d0e0d6af5144a4d',
      cpu: 'Apple M1 (Virtual)',
      dirty: false,
      fixtureHash: calibration.fixtureHash,
      memoryBytes: 7 * 1_024 * 1_024 * 1_024,
      node: calibration.runtime,
      operatingSystem: 'macOS 26.5.2',
      packageManager: calibration.runtime,
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements: [
      measurement('cold-index', 1_000),
      measurement('cold-materialization', 1_000),
      measurement('one-file-reindex-index', 1_000),
      measurement('one-file-reindex-materialization', 1_000),
      measurement('hot-exact-lexical-query', wallP95, 25, 'milliseconds', wallP50),
      measurement('hot-query-process-cpu', 140, 25),
      measurement('whole-graph-structural-analysis', 100, 3),
      measurement('incremental-process-peak-rss', 64 * 1_024 * 1_024, 1, 'bytes'),
      measurement('derived-index-disk', 16 * 1_024 * 1_024, 1, 'bytes'),
    ],
    metadata: {
      runnerClass: overrides.runnerClass ?? calibration.runnerClass,
      runnerIdentity: 'runner-ec74ec681d0f8c03',
      runtimePlatform: overrides.runtimePlatform ?? 'darwin',
      vectorEnabled: false,
    },
    suite: 'code-graph-v1',
    version: 1,
    warmups: calibration.collection.warmups,
  };
}

function measurement(
  name: string,
  value: number,
  samples = 1,
  unit: BenchmarkMeasurementV1['unit'] = 'milliseconds',
  p50 = value,
): BenchmarkMeasurementV1 {
  return {maximum: value, mean: p50, minimum: p50, name, p50, p95: value, p99: value, samples, unit};
}

function replaceMeasurement(
  artifact: BenchmarkArtifactV1,
  name: string,
  update: (measurement: BenchmarkMeasurementV1) => BenchmarkMeasurementV1,
): BenchmarkArtifactV1 {
  const current = EffectOption.getOrUndefined(
    EffectArray.findFirst(artifact.measurements, measurement => measurement.name === name),
  );
  if (current === undefined) throw new Error(`Missing measurement ${name}.`);
  return {
    ...artifact,
    measurements: EffectArray.map(artifact.measurements, measurement =>
      measurement.name === name ? update(current) : measurement,
    ),
  };
}
