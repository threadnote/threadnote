import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  adjudicateCodeGraphWindowsReplicas,
  type CodeGraphWindowsReplicaInput,
} from '../../../../scripts/adjudicate-code-graph-windows-replicas.js';
import type {BenchmarkArtifactV1, BenchmarkMeasurementV1} from '@threadnote/evidence/benchmark';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const GitCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const GitObjectId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const CalibrationReplicaFields = {
  archiveSha256: Sha256,
  artifactId: PositiveInteger,
  createdAt: Schema.String,
  environment: Schema.Struct({
    architecture: Schema.Literal('x64'),
    cpu: Schema.String,
    memoryBytes: PositiveInteger,
    operatingSystem: Schema.String,
  }),
  jobId: PositiveInteger,
  processCpuMilliseconds: Schema.Struct({
    coldMaterialization: Positive,
    hotQueryP95: Positive,
    oneFileMaterialization: Positive,
    wholeGraphAnalysisP95: Positive,
  }),
  rawJsonSha256: Sha256,
  replica: PositiveInteger,
  runnerIdentity: Schema.String,
  wallMilliseconds: Schema.Struct({
    coldIndex: Positive,
    coldMaterialization: Positive,
    hotQueryP50: Positive,
    hotQueryP95: Positive,
    oneFileIndex: Positive,
    oneFileMaterialization: Positive,
    wholeGraphAnalysisP95: Positive,
  }),
} as const;
const calibration = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      expected: Schema.Struct({
        processCpuP95DeltaMilliseconds: Schema.Finite,
        slowerTailHasLowerWallP50: Schema.Boolean,
        wallP95DeltaMilliseconds: Schema.Finite,
        wallP95Ratio: Positive,
      }),
      fixtureHash: Sha256,
      nestedMaterializationOutlier: Schema.Struct({
        aggregateArtifactId: PositiveInteger,
        aggregateArtifactSha256: Sha256,
        aggregateJobId: PositiveInteger,
        aggregateJsonSha256: Sha256,
        commit: GitCommit,
        expected: Schema.Struct({
          coldMaterializationProcessCpuObservedMaximum: Positive,
          oneFileMaterializationProcessCpuObservedMaximum: Positive,
          ordinaryPasses: Schema.Literal(2),
          safetyPassesAfterCorrection: Schema.Literal(3),
          safetyPassesBeforeCorrection: Schema.Literal(2),
        }),
        outlierDiagnostics: Schema.Struct({
          coldMaterializationProcessCpuMilliseconds: Positive,
          coldMaterializationWallToCpuRatio: Positive,
          coldMaximumProgressHeartbeatGapMilliseconds: Positive,
          sameOverlayReferenceIndexMilliseconds: Positive,
          sameOverlayReferenceMaterializationMilliseconds: Positive,
        }),
        replicas: Schema.Array(
          Schema.Struct({
            ...CalibrationReplicaFields,
            classification: Schema.Literals(['ordinary-pass', 'scheduler-storage-tail']),
          }),
        ),
        sourceTree: GitObjectId,
        workflowRun: PositiveInteger,
      }),
      observations: Schema.Array(
        Schema.Struct({
          archiveSha256: Sha256,
          artifactId: PositiveInteger,
          commit: GitCommit,
          processCpuMilliseconds: Schema.Struct({maximum: Positive, p50: Positive, p95: Positive}),
          rawJsonSha256: Sha256,
          runnerIdentity: Schema.String,
          sourceTree: GitObjectId,
          wallMilliseconds: Schema.Struct({maximum: Positive, p50: Positive, p95: Positive}),
          workflowRun: PositiveInteger,
        }),
      ),
      prospectiveReplicaSet: Schema.Struct({
        commit: GitCommit,
        expected: Schema.Struct({
          ordinaryPasses: Schema.Literal(2),
          safetyPassesAfterCorrection: Schema.Literal(3),
          schedulerTailWholeGraphWallToCpuP95Ratio: Positive,
          wholeGraphAnalysisProcessCpuObservedP95Maximum: Positive,
        }),
        replicas: Schema.Array(
          Schema.Struct({
            ...CalibrationReplicaFields,
            classification: Schema.Literals(['ordinary-pass', 'scheduler-wall-tail']),
          }),
        ),
        sourceTree: GitObjectId,
        workflowRun: PositiveInteger,
      }),
      policy: Schema.Struct({
        coldMaterializationProcessCpuMillisecondsMaximum: Schema.Literal(3000),
        hardWallP95MillisecondsMaximum: Schema.Literal(1900),
        headroomRatio: Schema.Literal(0.1),
        nestedMaterializationUsesEnclosingSafetyCeiling: Schema.Literal(true),
        oneFileMaterializationProcessCpuMillisecondsMaximum: Schema.Literal(200),
        ordinaryPassesMinimum: Schema.Literal(2),
        ordinaryWallP95MillisecondsMaximum: Schema.Literal(1050),
        replicas: Schema.Literal(3),
        roundingQuantumMilliseconds: Schema.Literal(100),
        samplesPerReplica: Schema.Literal(100),
        schedulerSensitiveWallClockSafetyMultiplier: Schema.Literal(2),
        wholeGraphAnalysisProcessCpuP95MillisecondsMaximum: Schema.Literal(400),
        warmupsPerReplica: Schema.Literal(5),
      }),
      runnerClass: Schema.Literal('github-hosted-windows-x64'),
      runtime: Schema.Literal('bun/1.3.14'),
      sourceTree: Schema.Literal('e1fc4934be4abf21711f1c15d3a72eaa9fda7d01'),
      type: Schema.Literal('threadnote-windows-native-hosted-replica-calibration'),
      version: Schema.Literal(1),
    }),
  ),
)(
  await Bun.file(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/windows-native-hosted-replica-calibration-v1.json',
  ).text(),
);
const budget: unknown = JSON.parse(
  await Bun.file('apps/threadnote/test/evaluation/baselines/code-graph-v1/budgets.json').text(),
);
const expectedCommit = Effect.pipe('a', EffectString.repeat(40));

describe('hosted Windows native replica adjudication', () => {
  it('rederives the safety fuse and wall-only runner variance from retained exact-tree evidence', () => {
    expect(calibration.observations).toHaveLength(2);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.workflowRun)).size).toBe(2);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.artifactId)).size).toBe(2);
    expect(new Set(EffectArray.map(calibration.observations, observation => observation.rawJsonSha256)).size).toBe(2);
    expect(
      EffectArray.every(calibration.observations, observation => observation.sourceTree === calibration.sourceTree),
    ).toBe(true);
    const [ordinary, tail] = calibration.observations;
    if (ordinary === undefined || tail === undefined) throw new Error('Replica calibration observations are missing.');

    expect(tail.wallMilliseconds.p95 - ordinary.wallMilliseconds.p95).toBeCloseTo(
      calibration.expected.wallP95DeltaMilliseconds,
      8,
    );
    expect(tail.wallMilliseconds.p95 / ordinary.wallMilliseconds.p95).toBeCloseTo(
      calibration.expected.wallP95Ratio,
      12,
    );
    expect(tail.processCpuMilliseconds.p95 - ordinary.processCpuMilliseconds.p95).toBe(
      calibration.expected.processCpuP95DeltaMilliseconds,
    );
    expect(tail.wallMilliseconds.p50 < ordinary.wallMilliseconds.p50).toBe(
      calibration.expected.slowerTailHasLowerWallP50,
    );
    expect(
      Math.ceil(
        (tail.wallMilliseconds.p95 * (1 + calibration.policy.headroomRatio)) /
          calibration.policy.roundingQuantumMilliseconds,
      ) * calibration.policy.roundingQuantumMilliseconds,
    ).toBe(calibration.policy.hardWallP95MillisecondsMaximum);
  });

  it('rederives the cross-phase wall safety and analysis CPU companion from the prospective replica set', () => {
    const prospective = calibration.prospectiveReplicaSet;
    expect(EffectArray.map(prospective.replicas, replica => replica.replica)).toEqual([1, 2, 3]);
    expect(new Set(EffectArray.map(prospective.replicas, replica => replica.runnerIdentity)).size).toBe(3);
    expect(new Set(EffectArray.map(prospective.replicas, replica => replica.rawJsonSha256)).size).toBe(3);
    expect(
      EffectArray.filter(prospective.replicas, replica => replica.classification === 'ordinary-pass'),
    ).toHaveLength(prospective.expected.ordinaryPasses);
    const schedulerTail = EffectOption.getOrUndefined(
      EffectArray.findFirst(prospective.replicas, replica => replica.classification === 'scheduler-wall-tail'),
    );
    if (schedulerTail === undefined) throw new Error('Prospective scheduler-tail observation is missing.');
    expect(
      schedulerTail.wallMilliseconds.wholeGraphAnalysisP95 / schedulerTail.processCpuMilliseconds.wholeGraphAnalysisP95,
    ).toBeCloseTo(prospective.expected.schedulerTailWholeGraphWallToCpuP95Ratio, 8);
    const observedAnalysisCpuMaximum = Math.max(
      ...EffectArray.map(prospective.replicas, replica => replica.processCpuMilliseconds.wholeGraphAnalysisP95),
    );
    expect(observedAnalysisCpuMaximum).toBe(prospective.expected.wholeGraphAnalysisProcessCpuObservedP95Maximum);
    expect(Math.ceil((observedAnalysisCpuMaximum * 1.5) / 100) * 100).toBe(
      calibration.policy.wholeGraphAnalysisProcessCpuP95MillisecondsMaximum,
    );
  });

  it('accepts three safe ordinary replicas and one bounded ordinary wall-tail', () => {
    expect(adjudicate(replicas()).gate).toEqual({failures: [], passed: true});
    const oneTail = replicas([500, 1673.8084, 600]);
    const result = adjudicate(oneTail);
    expect(result.gate).toEqual({failures: [], passed: true});
    expect(EffectArray.map(result.replicas, replica => replica.ordinaryPassed)).toEqual([true, false, true]);
    expect(EffectArray.every(result.replicas, replica => replica.safetyPassed)).toBe(true);
  });

  it('accepts the prospective cross-phase scheduler tail with two complete ordinary passes', () => {
    const prospective = calibration.prospectiveReplicaSet;
    const result = adjudicateCodeGraphWindowsReplicas(prospectiveReplicaInputs(), budget, prospective.commit);
    expect(result.gate).toEqual({failures: [], passed: true});
    expect(
      EffectArrayPipe(result.replicas, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (replica, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && replica.ordinaryPassed,
        ),
      ),
    ).toHaveLength(prospective.expected.ordinaryPasses);
    expect(
      EffectArrayPipe(result.replicas, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (replica, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && replica.safetyPassed,
        ),
      ),
    ).toHaveLength(prospective.expected.safetyPassesAfterCorrection);
    expect(EffectArray.map(result.replicas, replica => replica.ordinaryPassed)).toEqual(
      EffectArray.map(prospective.replicas, replica => replica.classification === 'ordinary-pass'),
    );
    expect(EffectArray.map(result.replicas, replica => replica.hotQuery.p50)).toEqual(
      EffectArray.map(prospective.replicas, replica => replica.wallMilliseconds.hotQueryP50),
    );
    expect(EffectArray.map(result.replicas, replica => replica.hotQuery.p95)).toEqual(
      EffectArray.map(prospective.replicas, replica => replica.wallMilliseconds.hotQueryP95),
    );
    expect(EffectArray.map(result.replicas, replica => replica.processCpu.p95)).toEqual(
      EffectArray.map(prospective.replicas, replica => replica.processCpuMilliseconds.hotQueryP95),
    );
    expect(EffectArray.map(result.replicas, replica => replica.wholeGraphAnalysis.p95)).toEqual(
      EffectArray.map(prospective.replicas, replica => replica.wallMilliseconds.wholeGraphAnalysisP95),
    );
    expect(EffectArray.map(result.replicas, replica => replica.wholeGraphAnalysisProcessCpu.p95)).toEqual(
      EffectArray.map(prospective.replicas, replica => replica.processCpuMilliseconds.wholeGraphAnalysisP95),
    );
  });

  it('replays the candidate-C nested materialization tail under the enclosing phase safety contract', () => {
    const candidate = calibration.nestedMaterializationOutlier;
    expect(EffectArray.map(candidate.replicas, replica => replica.replica)).toEqual([1, 2, 3]);
    expect(new Set(EffectArray.map(candidate.replicas, replica => replica.artifactId)).size).toBe(3);
    expect(new Set(EffectArray.map(candidate.replicas, replica => replica.rawJsonSha256)).size).toBe(3);
    expect(
      EffectArray.filter(candidate.replicas, replica => replica.wallMilliseconds.coldMaterialization <= 16_000),
    ).toHaveLength(candidate.expected.safetyPassesBeforeCorrection);
    const observedColdMaterializationCpuMaximum = Math.max(
      ...EffectArray.map(candidate.replicas, replica => replica.processCpuMilliseconds.coldMaterialization),
    );
    const observedOneFileMaterializationCpuMaximum = Math.max(
      ...EffectArray.map(candidate.replicas, replica => replica.processCpuMilliseconds.oneFileMaterialization),
    );
    expect(observedColdMaterializationCpuMaximum).toBe(candidate.expected.coldMaterializationProcessCpuObservedMaximum);
    expect(observedOneFileMaterializationCpuMaximum).toBe(
      candidate.expected.oneFileMaterializationProcessCpuObservedMaximum,
    );
    expect(Math.ceil((observedColdMaterializationCpuMaximum * 1.5) / 1_000) * 1_000).toBe(
      calibration.policy.coldMaterializationProcessCpuMillisecondsMaximum,
    );
    expect(Math.ceil((observedOneFileMaterializationCpuMaximum * 1.5) / 100) * 100).toBe(
      calibration.policy.oneFileMaterializationProcessCpuMillisecondsMaximum,
    );

    const outlier = EffectOption.getOrUndefined(
      EffectArray.findFirst(candidate.replicas, replica => replica.classification === 'scheduler-storage-tail'),
    );
    if (outlier === undefined) throw new Error('Nested materialization outlier is missing.');
    expect(outlier.wallMilliseconds.coldMaterialization).toBeLessThan(outlier.wallMilliseconds.coldIndex);
    expect(
      outlier.wallMilliseconds.coldMaterialization /
        candidate.outlierDiagnostics.coldMaterializationProcessCpuMilliseconds,
    ).toBeCloseTo(candidate.outlierDiagnostics.coldMaterializationWallToCpuRatio, 12);
    expect(
      outlier.wallMilliseconds.coldMaterialization /
        candidate.outlierDiagnostics.sameOverlayReferenceMaterializationMilliseconds,
    ).toBeGreaterThan(10);
    expect(candidate.outlierDiagnostics.sameOverlayReferenceIndexMilliseconds).toBeLessThan(
      outlier.wallMilliseconds.coldIndex,
    );

    const result = adjudicateCodeGraphWindowsReplicas(calibratedReplicaInputs(candidate), budget, candidate.commit);
    expect(result.gate).toEqual({failures: [], passed: true});
    expect(result.policy.nestedMaterializationUsesEnclosingSafetyCeiling).toBe(true);
    expect(
      EffectArrayPipe(result.replicas, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (replica, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && replica.ordinaryPassed,
        ),
      ),
    ).toHaveLength(candidate.expected.ordinaryPasses);
    expect(
      EffectArrayPipe(result.replicas, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (replica, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && replica.safetyPassed,
        ),
      ),
    ).toHaveLength(candidate.expected.safetyPassesAfterCorrection);
    expect(EffectArray.map(result.replicas, replica => replica.ordinaryPassed)).toEqual([false, true, true]);
    expect(EffectArray.map(result.replicas, replica => replica.coldMaterializationProcessCpu.maximum)).toEqual(
      EffectArray.map(candidate.replicas, replica => replica.processCpuMilliseconds.coldMaterialization),
    );
    expect(EffectArray.map(result.replicas, replica => replica.oneFileMaterializationProcessCpu.maximum)).toEqual(
      EffectArray.map(candidate.replicas, replica => replica.processCpuMilliseconds.oneFileMaterialization),
    );
  });

  it('rejects two ordinary tails and any single safety-fuse breach', () => {
    expect(adjudicate(replicas([1050, 1050.000_001, 1050.000_001])).gate.failures).toContain(
      'ordinary performance budget passed 1/3; required 2',
    );
    expect(adjudicate(replicas([500, 600, 1900.000_001])).gate.failures).toEqual(
      expect.arrayContaining([expect.stringContaining('replica 3 safety budget')]),
    );
  });

  it('requires two replicas to pass the entire ordinary budget, not only the hot-query wall', () => {
    const inputs = replicas([500, 1762.7741, 600]);
    const third = inputs[2];
    if (third === undefined) throw new Error('Replica fixture is missing.');
    const result = adjudicate([
      ...inputs.slice(0, 2),
      {...third, artifact: replaceAllStatistics(third.artifact, 'whole-graph-structural-analysis', 2000.000_001)},
    ]);
    expect(EffectArray.map(result.replicas, replica => replica.ordinaryPassed)).toEqual([true, false, false]);
    expect(EffectArray.map(result.replicas, replica => replica.safetyPassed)).toEqual([true, true, true]);
    expect(result.gate.failures).toContain('ordinary performance budget passed 1/3; required 2');
  });

  it('applies two-times safety fuses to enclosing and independent governed Windows wall clocks', () => {
    const cases = [
      ['cold-index', 30_000],
      ['one-file-reindex-index', 20_000],
      ['whole-graph-structural-analysis', 4_000],
    ] as const;
    for (const [measurementName, safetyMaximum] of cases) {
      const inputs = replicas();
      const first = inputs[0];
      if (first === undefined) throw new Error('Replica fixture is missing.');
      const atBoundary = {
        ...first,
        artifact: replaceAllStatistics(first.artifact, measurementName, safetyMaximum),
      };
      expect(adjudicate([atBoundary, ...inputs.slice(1)]).gate.passed).toBe(true);
      const aboveBoundary = {
        ...first,
        artifact: replaceAllStatistics(first.artifact, measurementName, safetyMaximum + 0.000_001),
      };
      const result = adjudicate([aboveBoundary, ...inputs.slice(1)]);
      expect(result.gate.failures).toEqual(
        expect.arrayContaining([expect.stringContaining('replica 1 safety budget')]),
      );
    }
  });

  it('uses each enclosing phase safety ceiling for nested materialization and rejects invalid nesting', () => {
    for (const [enclosingName, materializationName, safetyMaximum] of [
      ['cold-index', 'cold-materialization', 30_000],
      ['one-file-reindex-index', 'one-file-reindex-materialization', 20_000],
    ] as const) {
      const inputs = replicas();
      const first = inputs[0];
      if (first === undefined) throw new Error('Replica fixture is missing.');
      const atBoundary = replaceAllStatistics(
        replaceAllStatistics(first.artifact, enclosingName, safetyMaximum),
        materializationName,
        safetyMaximum,
      );
      expect(adjudicate([{...first, artifact: atBoundary}, ...inputs.slice(1)]).gate.passed).toBe(true);

      const aboveBoundary = replaceAllStatistics(
        replaceAllStatistics(first.artifact, enclosingName, safetyMaximum + 0.000_001),
        materializationName,
        safetyMaximum + 0.000_001,
      );
      expect(adjudicate([{...first, artifact: aboveBoundary}, ...inputs.slice(1)]).gate.failures).toEqual(
        expect.arrayContaining([expect.stringContaining('replica 1 safety budget')]),
      );

      const invalidNesting = replaceAllStatistics(
        replaceAllStatistics(first.artifact, enclosingName, 2_000),
        materializationName,
        2_000.000_001,
      );
      const result = adjudicate([{...first, artifact: invalidNesting}, ...inputs.slice(1)]);
      expect(result.gate.passed).toBe(false);
      expect(result.gate.failures).toContain(
        `replica 1 ${materializationName} maximum 2000.000001 exceeds enclosing ${enclosingName} maximum 2000`,
      );
    }
  });

  it('rejects invalid units and cardinalities for every single-observation wall fuse', () => {
    const names = [
      'cold-index',
      'cold-materialization',
      'one-file-reindex-index',
      'one-file-reindex-materialization',
    ] as const;
    for (const name of names) {
      for (const [label, mutate, expected] of [
        [
          'unit',
          (value: BenchmarkMeasurementV1): BenchmarkMeasurementV1 => ({...value, unit: 'bytes'}),
          `${name} measurement must use milliseconds`,
        ],
        ['samples', (value: BenchmarkMeasurementV1) => ({...value, samples: 2}), `${name} samples 2; expected 1`],
      ] as const) {
        const inputs = replicas();
        const first = inputs[0];
        if (first === undefined) throw new Error('Replica fixture is missing.');
        const result = adjudicate([
          {...first, artifact: replaceMeasurement(first.artifact, name, mutate)},
          ...inputs.slice(1),
        ]);
        expect(result.gate.passed, `${name} ${label}`).toBe(false);
        expect(result.replicas[0]?.ordinaryPassed, `${name} ${label} ordinary classification`).toBe(false);
        expect(result.replicas[0]?.safetyPassed, `${name} ${label} safety classification`).toBe(false);
        expect(result.gate.failures, `${name} ${label} diagnostic`).toContain(`replica 1 ${expected}`);
      }
    }
  });

  it('fails closed immediately above each nested materialization process-CPU companion', () => {
    for (const [name, maximum, outputField] of [
      ['cold-materialization-process-cpu-n1', 3_000, 'coldMaterializationProcessCpu'],
      ['one-file-reindex-materialization-process-cpu-n1', 200, 'oneFileMaterializationProcessCpu'],
    ] as const) {
      const inputs = replicas();
      const first = inputs[0];
      if (first === undefined) throw new Error('Replica fixture is missing.');
      const atBoundary = {
        ...first,
        artifact: replaceAllStatistics(first.artifact, name, maximum),
      };
      const accepted = adjudicate([atBoundary, ...inputs.slice(1)]);
      expect(accepted.gate.passed, `${name} boundary`).toBe(true);
      expect(accepted.replicas[0]?.[outputField].maximum).toBe(maximum);

      const aboveBoundary = {
        ...first,
        artifact: replaceAllStatistics(first.artifact, name, maximum + 0.000_001),
      };
      const rejected = adjudicate([aboveBoundary, ...inputs.slice(1)]);
      expect(rejected.gate.passed, `${name} epsilon`).toBe(false);
      expect(rejected.replicas[0]?.safetyPassed).toBe(false);
      expect(rejected.gate.failures).toContain(
        `replica 1 safety budget: ${name} maximum ${maximum + 0.000_001} exceeds ${maximum}`,
      );
    }
  });

  it('rejects invalid units and cardinalities for nested materialization process-CPU companions', () => {
    for (const name of [
      'cold-materialization-process-cpu-n1',
      'one-file-reindex-materialization-process-cpu-n1',
    ] as const) {
      for (const [label, mutate, expected] of [
        [
          'unit',
          (value: BenchmarkMeasurementV1): BenchmarkMeasurementV1 => ({...value, unit: 'bytes'}),
          `${name} measurement must use milliseconds`,
        ],
        ['samples', (value: BenchmarkMeasurementV1) => ({...value, samples: 2}), `${name} samples 2; expected 1`],
      ] as const) {
        const inputs = replicas();
        const first = inputs[0];
        if (first === undefined) throw new Error('Replica fixture is missing.');
        const result = adjudicate([
          {...first, artifact: replaceMeasurement(first.artifact, name, mutate)},
          ...inputs.slice(1),
        ]);
        expect(result.gate.passed, `${name} ${label}`).toBe(false);
        expect(result.replicas[0]?.safetyPassed, `${name} ${label} safety classification`).toBe(false);
        expect(result.gate.failures, `${name} ${label} diagnostic`).toContain(`replica 1 safety budget: ${expected}`);
      }
    }
  });

  it('fails closed on the independent whole-graph analysis process-CPU companion', () => {
    const inputs = replicas();
    const first = inputs[0];
    if (first === undefined) throw new Error('Replica fixture is missing.');
    const atBoundary = {
      ...first,
      artifact: replaceAllStatistics(first.artifact, 'whole-graph-structural-analysis-process-cpu', 400),
    };
    expect(adjudicate([atBoundary, ...inputs.slice(1)]).gate.passed).toBe(true);
    const aboveBoundary = {
      ...first,
      artifact: replaceAllStatistics(first.artifact, 'whole-graph-structural-analysis-process-cpu', 400.000_001),
    };
    const result = adjudicate([aboveBoundary, ...inputs.slice(1)]);
    expect(result.gate.passed).toBe(false);
    expect(result.replicas[0]?.safetyPassed).toBe(false);
    expect(EffectArray.join(result.gate.failures, '\n')).toMatch(/whole-graph-structural-analysis-process-cpu p95/u);
  });

  it('fails closed on whole-graph wall and CPU unit or sample-shape drift', () => {
    const cases: readonly [string, (artifact: BenchmarkArtifactV1) => BenchmarkArtifactV1, string][] = [
      [
        'wall unit',
        artifact =>
          replaceMeasurement(artifact, 'whole-graph-structural-analysis', value => ({...value, unit: 'bytes'})),
        'whole-graph-structural-analysis measurement must use milliseconds',
      ],
      [
        'wall samples 2',
        artifact => replaceMeasurement(artifact, 'whole-graph-structural-analysis', value => ({...value, samples: 2})),
        'whole-graph-structural-analysis samples 2; expected 3',
      ],
      [
        'wall samples 4',
        artifact => replaceMeasurement(artifact, 'whole-graph-structural-analysis', value => ({...value, samples: 4})),
        'whole-graph-structural-analysis samples 4; expected 3',
      ],
      [
        'CPU unit',
        artifact =>
          replaceMeasurement(artifact, 'whole-graph-structural-analysis-process-cpu', value => ({
            ...value,
            unit: 'count',
          })),
        'whole-graph-structural-analysis-process-cpu measurement must use milliseconds',
      ],
      [
        'CPU samples 2',
        artifact =>
          replaceMeasurement(artifact, 'whole-graph-structural-analysis-process-cpu', value => ({
            ...value,
            samples: 2,
          })),
        'whole-graph-structural-analysis-process-cpu sample count must match the wall measurement',
      ],
      [
        'CPU samples 4',
        artifact =>
          replaceMeasurement(artifact, 'whole-graph-structural-analysis-process-cpu', value => ({
            ...value,
            samples: 4,
          })),
        'whole-graph-structural-analysis-process-cpu sample count must match the wall measurement',
      ],
    ];
    for (const [label, mutate, expected] of cases) {
      const inputs = replicas();
      const first = inputs[0];
      if (first === undefined) throw new Error('Replica fixture is missing.');
      const result = adjudicate([{...first, artifact: mutate(first.artifact)}, ...inputs.slice(1)]);
      expect(result.gate.passed, label).toBe(false);
      expect(result.replicas[0]?.safetyPassed, label).toBe(false);
      expect(result.gate.failures, label).toContain(`replica 1 safety budget: ${expected}`);
    }
  });

  it('rejects duplicate measurement names before any first-match budget lookup', () => {
    const inputs = replicas();
    const first = inputs[0];
    if (first === undefined) throw new Error('Replica fixture is missing.');
    const processCpu = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        first.artifact.measurements,
        measurement => measurement.name === 'whole-graph-structural-analysis-process-cpu',
      ),
    );
    if (processCpu === undefined) throw new Error('Whole-graph process CPU fixture is missing.');
    const contradictory = {
      ...processCpu,
      maximum: 1_000,
      mean: 1_000,
      minimum: 1_000,
      p50: 1_000,
      p95: 1_000,
      p99: 1_000,
    };
    expect(() =>
      adjudicate([
        {...first, artifact: {...first.artifact, measurements: [...first.artifact.measurements, contradictory]}},
        ...inputs.slice(1),
      ]),
    ).toThrowError(
      'replica 1 measurement names must be unique; duplicates: whole-graph-structural-analysis-process-cpu',
    );
  });

  it('fails closed on companion, non-wall, parity, and exact sample-count regressions', () => {
    const cases: readonly [string, (artifact: BenchmarkArtifactV1) => BenchmarkArtifactV1, RegExp][] = [
      [
        'wall median',
        artifact =>
          replaceMeasurement(artifact, 'hot-exact-lexical-query', value => ({
            ...value,
            maximum: Math.max(value.maximum, 751),
            p50: 751,
            p95: Math.max(value.p95, 751),
            p99: Math.max(value.p99, 751),
          })),
        /p50/u,
      ],
      [
        'process CPU',
        artifact =>
          replaceMeasurement(artifact, 'hot-query-process-cpu', value => ({
            ...value,
            maximum: 501,
            p95: 501,
            p99: 501,
          })),
        /hot-query-process-cpu/u,
      ],
      ['cold index', artifact => replaceAllStatistics(artifact, 'cold-index', 30_001), /cold-index/u],
      ['parity', artifact => replaceAllStatistics(artifact, 'structural-graph-digest-parity', 0), /parity/u],
      ['99 samples', artifact => replaceHotSampleCounts(artifact, 99), /hot-query samples 99\/99; expected 100\/100/u],
      [
        '101 samples',
        artifact => replaceHotSampleCounts(artifact, 101),
        /hot-query samples 101\/101; expected 100\/100/u,
      ],
    ];
    for (const [, mutate, expected] of cases) {
      const inputs = replicas();
      const first = inputs[0];
      if (first === undefined) throw new Error('Replica fixture is missing.');
      const result = adjudicate([{...first, artifact: mutate(first.artifact)}, ...inputs.slice(1)]);
      expect(result.gate.passed).toBe(false);
      expect(EffectArray.join(result.gate.failures, '\n')).toMatch(expected);
    }
  });

  it('requires exact ordinals, distinct runner identities and digests, and matching provenance', () => {
    const valid = replicas();
    expect(adjudicate(valid.slice(0, 2)).gate.failures).toContain('replica ordinals must be exactly 1,2,3');
    expect(adjudicate([valid[0], valid[0], valid[2]]).gate.failures).toEqual(
      expect.arrayContaining([
        'artifact digests must be distinct across all replicas',
        'replica ordinals must be exactly 1,2,3',
        'runner identities must be distinct across all replicas',
      ]),
    );
    const mismatched = EffectArray.map(valid, (input, index) =>
      index === 2
        ? {
            ...input,
            artifact: {
              ...input.artifact,
              environment: {...input.artifact.environment, operatingSystem: 'Windows changed'},
            },
          }
        : input,
    );
    expect(adjudicate(mismatched).gate.failures).toContain('operating system must match across all replicas');
  });

  it('is permutation-invariant and deterministic', () => {
    const forward = adjudicate(replicas([500, 1673.8084, 600]));
    const reverse = adjudicate([...replicas([500, 1673.8084, 600])].reverse());
    expect(reverse).toEqual(forward);
  });

  it('accepts exactly all-safe replica sets with at least two ordinary passes', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
        ),
        walls => {
          const expected =
            EffectArray.every(walls, value => value <= 1900) &&
            EffectArray.filter(walls, value => value <= 1050).length >= 2;
          expect(adjudicate(replicas(walls)).gate.passed).toBe(expected);
        },
      ),
      {numRuns: 100},
    );
  });

  it('accepts exactly scheduler-sensitive independent walls within their fixed safety multipliers', () => {
    const safetyFuses = [
      ['cold-index', 30_000],
      ['one-file-reindex-index', 20_000],
      ['whole-graph-structural-analysis', 4_000],
    ] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...safetyFuses),
        fc.double({max: 1.1, min: 0.5, noDefaultInfinity: true, noNaN: true}),
        ([measurementName, safetyMaximum], factor) => {
          const inputs = replicas();
          const first = inputs[0];
          if (first === undefined) throw new Error('Replica fixture is missing.');
          const value = safetyMaximum * factor;
          const mutated = {
            ...first,
            artifact: replaceAllStatistics(first.artifact, measurementName, value),
          };
          expect(adjudicate([mutated, ...inputs.slice(1)]).gate.passed).toBe(value <= safetyMaximum);
        },
      ),
      {numRuns: 100},
    );
  });

  it('accepts nested materialization exactly when it remains within its enclosing safe phase', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ['cold-index', 'cold-materialization', 30_000] as const,
          ['one-file-reindex-index', 'one-file-reindex-materialization', 20_000] as const,
        ),
        fc.double({max: 33_000, min: 1, noDefaultInfinity: true, noNaN: true}),
        fc.double({max: 33_000, min: 1, noDefaultInfinity: true, noNaN: true}),
        ([enclosingName, materializationName, safetyMaximum], enclosing, materialization) => {
          const inputs = replicas();
          const first = inputs[0];
          if (first === undefined) throw new Error('Replica fixture is missing.');
          const mutated = replaceAllStatistics(
            replaceAllStatistics(first.artifact, enclosingName, enclosing),
            materializationName,
            materialization,
          );
          const expected = enclosing <= safetyMaximum && materialization <= enclosing;
          expect(adjudicate([{...first, artifact: mutated}, ...inputs.slice(1)]).gate.passed).toBe(expected);
        },
      ),
      {numRuns: 100},
    );
  });

  it('accepts nested materialization process CPU exactly within each independent companion', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ['cold-materialization-process-cpu-n1', 3_000] as const,
          ['one-file-reindex-materialization-process-cpu-n1', 200] as const,
        ),
        fc.double({max: 3_300, min: 1, noDefaultInfinity: true, noNaN: true}),
        ([measurementName, safetyMaximum], processCpuMaximum) => {
          const inputs = replicas();
          const first = inputs[0];
          if (first === undefined) throw new Error('Replica fixture is missing.');
          const mutated = {
            ...first,
            artifact: replaceAllStatistics(first.artifact, measurementName, processCpuMaximum),
          };
          expect(adjudicate([mutated, ...inputs.slice(1)]).gate.passed).toBe(processCpuMaximum <= safetyMaximum);
        },
      ),
      {numRuns: 100},
    );
  });

  it('accepts exactly whole-graph analysis CPU p95 values within the independent companion', () => {
    fc.assert(
      fc.property(fc.double({max: 500, min: 200, noDefaultInfinity: true, noNaN: true}), processCpuP95 => {
        const inputs = replicas();
        const first = inputs[0];
        if (first === undefined) throw new Error('Replica fixture is missing.');
        const mutated = {
          ...first,
          artifact: replaceAllStatistics(first.artifact, 'whole-graph-structural-analysis-process-cpu', processCpuP95),
        };
        expect(adjudicate([mutated, ...inputs.slice(1)]).gate.passed).toBe(processCpuP95 <= 400);
      }),
      {numRuns: 100},
    );
  });

  it('is monotone under governed wall-tail regressions', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 2_100, min: 500, noDefaultInfinity: true, noNaN: true}),
        ),
        fc.tuple(
          fc.double({max: 500, min: 0, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 500, min: 0, noDefaultInfinity: true, noNaN: true}),
          fc.double({max: 500, min: 0, noDefaultInfinity: true, noNaN: true}),
        ),
        (walls, deltas) => {
          const before = adjudicate(replicas(walls)).gate.passed;
          const regressed: Triple = [walls[0] + deltas[0], walls[1] + deltas[1], walls[2] + deltas[2]];
          const after = adjudicate(replicas(regressed)).gate.passed;
          if (!before) expect(after).toBe(false);
        },
      ),
      {numRuns: 100},
    );
  });
});

type Triple = readonly [number, number, number];

function adjudicate(inputs: readonly CodeGraphWindowsReplicaInput[]) {
  return adjudicateCodeGraphWindowsReplicas(inputs, budget, expectedCommit);
}

function replicas(walls: Triple = [500, 600, 700]): readonly CodeGraphWindowsReplicaInput[] {
  return EffectArray.map(walls, (wallP95, index) => ({
    artifact: artifact(index + 1, wallP95),
    artifactSha256: Effect.pipe(String(index + 1), EffectString.repeat(64)),
    replica: index + 1,
  }));
}

function prospectiveReplicaInputs(): readonly CodeGraphWindowsReplicaInput[] {
  return calibratedReplicaInputs(calibration.prospectiveReplicaSet);
}

type CalibratedReplicaSet = {
  readonly commit: string;
  readonly replicas: readonly Omit<(typeof calibration.prospectiveReplicaSet.replicas)[number], 'classification'>[];
};

function calibratedReplicaInputs(replicaSet: CalibratedReplicaSet): readonly CodeGraphWindowsReplicaInput[] {
  return EffectArray.map(replicaSet.replicas, replica => {
    let replay = artifact(replica.replica, replica.wallMilliseconds.hotQueryP95);
    replay = {
      ...replay,
      createdAt: replica.createdAt,
      environment: {
        ...replay.environment,
        architecture: replica.environment.architecture,
        commit: replicaSet.commit,
        cpu: replica.environment.cpu,
        memoryBytes: replica.environment.memoryBytes,
        operatingSystem: replica.environment.operatingSystem,
      },
      metadata: {...replay.metadata, runnerIdentity: replica.runnerIdentity},
    };
    replay = replaceAllStatistics(replay, 'cold-index', replica.wallMilliseconds.coldIndex);
    replay = replaceAllStatistics(replay, 'cold-materialization', replica.wallMilliseconds.coldMaterialization);
    replay = replaceAllStatistics(
      replay,
      'cold-materialization-process-cpu-n1',
      replica.processCpuMilliseconds.coldMaterialization,
    );
    replay = replaceAllStatistics(replay, 'one-file-reindex-index', replica.wallMilliseconds.oneFileIndex);
    replay = replaceAllStatistics(
      replay,
      'one-file-reindex-materialization',
      replica.wallMilliseconds.oneFileMaterialization,
    );
    replay = replaceAllStatistics(
      replay,
      'one-file-reindex-materialization-process-cpu-n1',
      replica.processCpuMilliseconds.oneFileMaterialization,
    );
    replay = replaceMeasurement(replay, 'hot-exact-lexical-query', value => ({
      ...value,
      maximum: Math.max(value.maximum, replica.wallMilliseconds.hotQueryP95),
      minimum: Math.min(value.minimum, replica.wallMilliseconds.hotQueryP50),
      p50: replica.wallMilliseconds.hotQueryP50,
      p95: replica.wallMilliseconds.hotQueryP95,
      p99: Math.max(value.p99, replica.wallMilliseconds.hotQueryP95),
    }));
    replay = replaceMeasurement(replay, 'hot-query-process-cpu', value => ({
      ...value,
      maximum: Math.max(value.maximum, replica.processCpuMilliseconds.hotQueryP95),
      p95: replica.processCpuMilliseconds.hotQueryP95,
      p99: Math.max(value.p99, replica.processCpuMilliseconds.hotQueryP95),
    }));
    replay = replaceAllStatistics(
      replay,
      'whole-graph-structural-analysis',
      replica.wallMilliseconds.wholeGraphAnalysisP95,
    );
    replay = replaceAllStatistics(
      replay,
      'whole-graph-structural-analysis-process-cpu',
      replica.processCpuMilliseconds.wholeGraphAnalysisP95,
    );
    return {artifact: replay, artifactSha256: replica.rawJsonSha256, replica: replica.replica};
  });
}

function artifact(replica: number, wallP95: number): BenchmarkArtifactV1 {
  return {
    createdAt: `2026-09-01T00:00:0${replica}.000Z`,
    environment: {
      architecture: 'x64',
      commit: expectedCommit,
      cpu: `hosted-cpu-${replica}`,
      dirty: false,
      fixtureHash: 'c4c45a6bcc25517df1fdae711f19f4989e13fde6b4763d596d547c6757230e7d',
      memoryBytes: 16 * 1_024 * 1_024 * 1_024,
      node: 'bun/1.3.14',
      operatingSystem: 'Windows 10.0.26100',
      packageManager: 'bun/1.3.14',
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements: [
      measurement('cold-index', 1_000),
      measurement('cold-materialization', 1_000),
      measurement('cold-materialization-process-cpu-n1', 1_000),
      measurement('one-file-reindex-index', 1_000),
      measurement('one-file-reindex-materialization', 1_000),
      measurement('one-file-reindex-materialization-process-cpu-n1', 100),
      {
        ...measurement('hot-exact-lexical-query', wallP95, 100),
        maximum: Math.max(wallP95, 700),
        mean: Math.min(wallP95, 450),
        minimum: Math.min(wallP95, 350),
        p50: Math.min(wallP95, 400),
        p95: wallP95,
        p99: Math.max(wallP95, 700),
      },
      {
        ...measurement('hot-query-process-cpu', 250, 100),
        mean: 180,
        minimum: 100,
        p50: 180,
        p95: 250,
      },
      measurement('whole-graph-structural-analysis', 500, 3),
      measurement('whole-graph-structural-analysis-process-cpu', 250, 3),
      measurement('incremental-process-peak-rss', 64 * 1_024 * 1_024, 1, 'bytes'),
      measurement('derived-index-disk', 16 * 1_024 * 1_024, 1, 'bytes'),
      measurement('one-file-reindex-materialization-staged-files', 1, 1, 'count'),
      measurement('primary-query-structural-parity', 1, 1, 'count'),
      measurement('structural-graph-digest-parity', 1, 1, 'count'),
    ],
    metadata: {
      coldFiles: 13,
      incrementalReusedFiles: 12,
      oneFileReindexStagedFiles: 1,
      oneFileReindexTotalFiles: 13,
      primaryQueryStructuralDigestIncremental: Effect.pipe('1', EffectString.repeat(64)),
      primaryQueryStructuralDigestSameOverlayReference: Effect.pipe('1', EffectString.repeat(64)),
      runnerClass: 'github-hosted-windows-x64',
      runnerIdentity: `runner-${Effect.pipe(replica.toString(16), EffectString.padStart(16, '0'))}`,
      runtimePlatform: 'win32',
      structuralGraphDigestIncremental: Effect.pipe('2', EffectString.repeat(64)),
      structuralGraphDigestSameOverlayReference: Effect.pipe('2', EffectString.repeat(64)),
      vectorEnabled: false,
    },
    suite: 'code-graph-v1',
    version: 1,
    warmups: 5,
  };
}

function measurement(
  name: string,
  value: number,
  samples = 1,
  unit: BenchmarkMeasurementV1['unit'] = 'milliseconds',
): BenchmarkMeasurementV1 {
  return {maximum: value, mean: value, minimum: value, name, p50: value, p95: value, p99: value, samples, unit};
}

function replaceHotSampleCounts(artifact: BenchmarkArtifactV1, samples: number): BenchmarkArtifactV1 {
  return {
    ...artifact,
    measurements: EffectArray.map(artifact.measurements, measurement =>
      measurement.name === 'hot-exact-lexical-query' || measurement.name === 'hot-query-process-cpu'
        ? {...measurement, samples}
        : measurement,
    ),
  };
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
