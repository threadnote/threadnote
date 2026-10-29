import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';

import {benchmarkMeasurement} from '@threadnote/evidence/benchmark';

const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const GitObject = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const ArchiveDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));
const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u));
const RunnerIdentity = Schema.String.check(Schema.isPattern(/^runner-[0-9a-f]{16}$/u));

const Measurements = Schema.Struct({
  hotQueryMaximumMilliseconds: PositiveFinite,
  hotQueryP50Milliseconds: PositiveFinite,
  hotQueryP95Milliseconds: PositiveFinite,
  hotQueryProcessCpuMaximumMilliseconds: PositiveFinite,
  hotQueryProcessCpuP50Milliseconds: PositiveFinite,
  hotQueryProcessCpuP95Milliseconds: PositiveFinite,
  samples: PositiveInteger,
});

const CandidateFailure = Schema.Struct({
  archiveDigest: ArchiveDigest,
  artifactId: PositiveInteger,
  conclusion: Schema.Literal('failure'),
  createdAt: IsoInstant,
  cpu: Schema.String,
  headSha: GitObject,
  jobId: PositiveInteger,
  measurements: Measurements,
  rawJsonSha256: Sha256,
  runId: PositiveInteger,
  runnerIdentity: RunnerIdentity,
  sourceTreeSha: GitObject,
});

const HostedControl = Schema.Struct({
  archiveDigest: ArchiveDigest,
  artifactId: PositiveInteger,
  conclusion: Schema.Literal('success'),
  createdAt: IsoInstant,
  cpu: Schema.String,
  headSha: GitObject,
  jobId: PositiveInteger,
  measurements: Measurements,
  rawJsonSha256: Sha256,
  role: Schema.Union([Schema.Literal('identical-tree-control'), Schema.Literal('recent-hosted-control')]),
  runId: PositiveInteger,
  runnerIdentity: RunnerIdentity,
  sourceTreeSha: GitObject,
});

const Summary = Schema.Struct({
  maximum: PositiveFinite,
  minimum: PositiveFinite,
  upperMiddle: PositiveFinite,
});

const calibration = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      adjacentHundredSampleMethodControl: Schema.Struct({
        archiveDigest: ArchiveDigest,
        artifactId: PositiveInteger,
        conclusion: Schema.Literal('success'),
        createdAt: IsoInstant,
        fixtureHash: Schema.Literal('generated-code-graph-v1:10000'),
        headSha: GitObject,
        jobId: PositiveInteger,
        measurements: Measurements,
        rawJsonSha256: Sha256,
        runId: PositiveInteger,
        scope: Schema.Literal('method-control-only-different-10k-fixture-and-runner'),
        sourceTreeSha: GitObject,
      }),
      candidateFailure: CandidateFailure,
      createdAt: IsoInstant,
      fixture: Schema.Struct({
        architecture: Schema.Literal('x64'),
        fixtureHash: Schema.Literal('c4c45a6bcc25517df1fdae711f19f4989e13fde6b4763d596d547c6757230e7d'),
        operatingSystem: Schema.Literal('Windows 10.0.26100'),
        runnerClass: Schema.Literal('github-hosted-windows-x64'),
        runtime: Schema.Literal('bun/1.3.14'),
        runtimePlatform: Schema.Literal('win32'),
      }),
      governedInputs: Schema.Struct({
        additionalToleranceRatio: NonNegativeFinite,
        hotQueryP50MillisecondsMaximum: PositiveFinite,
        hotQueryP95MillisecondsMaximum: PositiveFinite,
        hotQueryProcessCpuP95MillisecondsMaximum: PositiveFinite,
        hotQueryWallP95ToleranceRatioMaximum: NonNegativeFinite,
        previousP95ExcludedUpperOrderStatistics: PositiveInteger,
        previousSamples: PositiveInteger,
        productionPercentileQuantile: PositiveFinite,
        prospectiveP95ExcludedUpperOrderStatistics: PositiveInteger,
        prospectiveSamples: PositiveInteger,
      }),
      observationOrder: Schema.Literal('reverse-chronological within recentHostedControls'),
      recentHostedControls: Schema.Array(HostedControl),
      recentHostedSummary: Schema.Struct({
        hotQueryP50Milliseconds: Summary,
        hotQueryP95Milliseconds: Summary,
        hotQueryProcessCpuP95Milliseconds: Summary,
        observationCount: PositiveInteger,
      }),
      releaseRequirement: Schema.Struct({
        prospectiveNativeHostedObservationRequired: Schema.Literal(true),
        thresholdsChanged: Schema.Literal(false),
      }),
      type: Schema.Literal('threadnote-windows-native-hosted-query-quantile-calibration'),
      version: Schema.Literal(1),
    }),
  ),
)(
  await Bun.file(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/windows-native-hosted-query-quantile-calibration-v1.json',
  ).text(),
);

const budget = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      developmentPerformance: Schema.Struct({
        hotQuerySamplesMinimum: PositiveInteger,
        hotQueryWallP95ToleranceRatioMaximum: NonNegativeFinite,
      }),
      developmentPerformanceByPlatform: Schema.Struct({
        win32: Schema.Struct({
          hotQueryP50MillisecondsMaximum: PositiveFinite,
          hotQueryP95MillisecondsMaximum: PositiveFinite,
          hotQueryProcessCpuP95MillisecondsMaximum: PositiveFinite,
        }),
      }),
      developmentPerformanceByRunnerClass: Schema.Struct({
        'github-hosted-windows-x64': Schema.Struct({hotQuerySamplesMinimum: PositiveInteger}),
      }),
    }),
  ),
)(await Bun.file('apps/threadnote/test/evaluation/baselines/code-graph-v1/budgets.json').text());

describe('hosted Windows native query quantile calibration', () => {
  it('binds the failure to unique retained artifacts and an identical-tree passing control', () => {
    const candidate = calibration.candidateFailure;
    const controls = calibration.recentHostedControls;
    const identicalTreeControl = required(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(controls, control => control.role === 'identical-tree-control'),
      ),
    );
    const allNative = [candidate, ...controls];

    expect(controls).toHaveLength(calibration.recentHostedSummary.observationCount);
    expect(new Set(EffectArray.map(allNative, observation => observation.runId)).size).toBe(allNative.length);
    expect(new Set(EffectArray.map(allNative, observation => observation.jobId)).size).toBe(allNative.length);
    expect(new Set(EffectArray.map(allNative, observation => observation.artifactId)).size).toBe(allNative.length);
    expect(new Set(EffectArray.map(allNative, observation => observation.archiveDigest)).size).toBe(allNative.length);
    expect(new Set(EffectArray.map(allNative, observation => observation.rawJsonSha256)).size).toBe(allNative.length);
    expect(candidate.headSha).toBe('1ce43969b08a772cb19e712eb71d7d34c38b7b66');
    expect(identicalTreeControl.headSha).toBe('a4969ac636e905ea4cb6f03529ff2a132c5d5eb5');
    expect(candidate.sourceTreeSha).toBe(identicalTreeControl.sourceTreeSha);
    expect(candidate.measurements.hotQueryP50Milliseconds).toBeGreaterThan(
      calibration.governedInputs.hotQueryP50MillisecondsMaximum,
    );
    expect(identicalTreeControl.measurements.hotQueryP50Milliseconds).toBeLessThan(
      calibration.governedInputs.hotQueryP50MillisecondsMaximum,
    );
  });

  it('rederives recent hosted distributions and preserves the independent CPU diagnosis', () => {
    const controls = calibration.recentHostedControls;
    const governed = calibration.governedInputs;
    const guardedWallP95Maximum =
      governed.hotQueryP95MillisecondsMaximum * (1 + governed.hotQueryWallP95ToleranceRatioMaximum);

    expect(summary(EffectArray.map(controls, control => control.measurements.hotQueryP50Milliseconds))).toEqual(
      calibration.recentHostedSummary.hotQueryP50Milliseconds,
    );
    expect(summary(EffectArray.map(controls, control => control.measurements.hotQueryP95Milliseconds))).toEqual(
      calibration.recentHostedSummary.hotQueryP95Milliseconds,
    );
    expect(
      summary(EffectArray.map(controls, control => control.measurements.hotQueryProcessCpuP95Milliseconds)),
    ).toEqual(calibration.recentHostedSummary.hotQueryProcessCpuP95Milliseconds);
    expect(
      EffectArray.every(
        controls,
        control => control.measurements.hotQueryP50Milliseconds <= governed.hotQueryP50MillisecondsMaximum,
      ),
    ).toBe(true);
    expect(
      EffectArray.every(controls, control => control.measurements.hotQueryP95Milliseconds <= guardedWallP95Maximum),
    ).toBe(true);
    expect(
      EffectArray.every(
        controls,
        control =>
          control.measurements.hotQueryProcessCpuP95Milliseconds <= governed.hotQueryProcessCpuP95MillisecondsMaximum,
      ),
    ).toBe(true);
    expect(calibration.candidateFailure.measurements.hotQueryP95Milliseconds).toBeGreaterThan(guardedWallP95Maximum);
    expect(calibration.candidateFailure.measurements.hotQueryProcessCpuP95Milliseconds).toBeLessThan(
      governed.hotQueryProcessCpuP95MillisecondsMaximum,
    );
  });

  it('increases only hosted Windows quantile resolution and requires prospective native evidence', () => {
    const governed = calibration.governedInputs;
    const hostedWindows = budget.developmentPerformanceByRunnerClass['github-hosted-windows-x64'];
    const win32 = budget.developmentPerformanceByPlatform.win32;

    expect(governed.previousSamples).toBe(budget.developmentPerformance.hotQuerySamplesMinimum);
    expect(governed.prospectiveSamples).toBe(hostedWindows.hotQuerySamplesMinimum);
    expect(governed.hotQueryP50MillisecondsMaximum).toBe(win32.hotQueryP50MillisecondsMaximum);
    expect(governed.hotQueryP95MillisecondsMaximum).toBe(win32.hotQueryP95MillisecondsMaximum);
    expect(governed.hotQueryProcessCpuP95MillisecondsMaximum).toBe(win32.hotQueryProcessCpuP95MillisecondsMaximum);
    expect(governed.hotQueryWallP95ToleranceRatioMaximum).toBe(
      budget.developmentPerformance.hotQueryWallP95ToleranceRatioMaximum,
    );
    expect(governed.additionalToleranceRatio).toBe(0);
    expect(excludedUpperOrderStatistics(governed.previousSamples, governed.productionPercentileQuantile)).toBe(
      governed.previousP95ExcludedUpperOrderStatistics,
    );
    expect(excludedUpperOrderStatistics(governed.prospectiveSamples, governed.productionPercentileQuantile)).toBe(
      governed.prospectiveP95ExcludedUpperOrderStatistics,
    );

    const guardedWallP95Maximum =
      governed.hotQueryP95MillisecondsMaximum * (1 + governed.hotQueryWallP95ToleranceRatioMaximum);
    const wallSamples = (breaches: 4 | 5) => [
      ...Array.from({length: 95}, () => 500),
      ...(breaches === 4 ? [guardedWallP95Maximum] : []),
      ...Array.from({length: breaches}, () => guardedWallP95Maximum + 1),
    ];
    expect(benchmarkMeasurement('hot-exact-lexical-query', 'milliseconds', wallSamples(4)).p95).toBe(
      guardedWallP95Maximum,
    );
    expect(benchmarkMeasurement('hot-exact-lexical-query', 'milliseconds', wallSamples(5)).p95).toBe(
      guardedWallP95Maximum + 1,
    );

    const methodControl = calibration.adjacentHundredSampleMethodControl;
    expect(methodControl.headSha).toBe(calibration.candidateFailure.headSha);
    expect(methodControl.sourceTreeSha).toBe(calibration.candidateFailure.sourceTreeSha);
    expect(methodControl.fixtureHash).not.toBe(calibration.fixture.fixtureHash);
    expect(methodControl.measurements.samples).toBe(governed.prospectiveSamples);
    expect(methodControl.measurements.hotQueryP50Milliseconds).toBeLessThan(governed.hotQueryP50MillisecondsMaximum);
    expect(methodControl.measurements.hotQueryP95Milliseconds).toBeLessThan(guardedWallP95Maximum);
    expect(methodControl.measurements.hotQueryProcessCpuP95Milliseconds).toBeLessThan(
      governed.hotQueryProcessCpuP95MillisecondsMaximum,
    );
    expect(calibration.releaseRequirement).toEqual({
      prospectiveNativeHostedObservationRequired: true,
      thresholdsChanged: false,
    });
  });
});

function summary(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    maximum: required(sorted.at(-1)),
    minimum: required(sorted[0]),
    upperMiddle: required(sorted[Math.floor(sorted.length / 2)]),
  };
}

function excludedUpperOrderStatistics(samples: number, quantile: number): number {
  return samples - (Math.floor(samples * quantile) + 1);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Windows native query calibration value is missing.');
  return value;
}
