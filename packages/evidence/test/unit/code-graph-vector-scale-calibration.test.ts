import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {enforceCodeGraphBenchmarkBudget} from '../../../../scripts/benchmark-code-graph.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {benchmarkMeasurement, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const GitCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u));

const PerformanceBudget = Schema.Struct({
  coldIndexP95MillisecondsMaximum: NonNegativeFinite,
  coldMaterializationP95MillisecondsMaximum: NonNegativeFinite,
  derivedIndexBytesMaximum: NonNegativeFinite,
  hotQueryP95MillisecondsMaximum: NonNegativeFinite,
  oneFileIncrementalP95MillisecondsMaximum: NonNegativeFinite,
  oneFileMaterializationP95MillisecondsMaximum: NonNegativeFinite,
  processPeakRssBytesMaximum: NonNegativeFinite,
  wholeGraphAnalysisP95MillisecondsMaximum: NonNegativeFinite,
});

const budgetFile = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      vectorScalePerformance: Schema.Struct({'100000': PerformanceBudget}),
    }),
  ),
)(await Bun.file('apps/threadnote/test/evaluation/baselines/code-graph-v1/budgets.json').text());
const budget = budgetFile.vectorScalePerformance['100000'];

const calibration = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      artifact: Schema.Struct({
        dirty: Schema.Literal(false),
        fixtureHash: Schema.Literal('generated-code-graph-vectors-v2:100000'),
        suite: Schema.Literal('code-graph-vectors-v1'),
        version: Schema.Literal(1),
        warmups: Schema.Literal(1),
      }),
      calibration: Schema.Struct({
        admissionMarginRatio: NonNegativeFinite,
        automaticRecalibrationOnFailure: Schema.Literal(false),
        basis: Schema.Literal('fixed-class-admission-envelope'),
        derivedColdIndexMaximumMilliseconds: NonNegativeFinite,
        prospectiveValidationRuns: Schema.Literal(1),
        roundUpIncrementMilliseconds: PositiveInteger,
      }),
      capacityCrossCheck: Schema.Struct({
        observedFasterThanPredictionRatio: NonNegativeFinite,
        predictedTargetColdIndexMilliseconds: NonNegativeFinite,
        sourceCommit: GitCommit,
        sourceCpuMathCores: PositiveInteger,
        sourceEffectiveContexts: PositiveInteger,
        sourceMedianColdIndexMilliseconds: NonNegativeFinite,
        sourcePath: Schema.Literal(
          'apps/threadnote/test/evaluation/candidates/threadnote-4.2.5/benchmarks/darwin-arm64-m1-max/code-graph-embedding-contexts-10000-2026-08-14.json',
        ),
        sourceScaleSymbols: Schema.Literal(10_000),
        sourceSha256: Sha256,
        sourceThreadCounts: Schema.Array(PositiveInteger),
        sourceVectorRows: PositiveInteger,
      }),
      observations: Schema.Struct({
        coldEmbeddingProgressProcessFailures: NonNegativeInteger,
        coldEmbeddingProgressProcessSamples: PositiveInteger,
        coldIndexMilliseconds: NonNegativeFinite,
        coldIndexSamples: PositiveInteger,
        coldMaterializationMilliseconds: NonNegativeFinite,
        coldVectorIndexMilliseconds: NonNegativeFinite,
        derivedIndexBytes: NonNegativeFinite,
        hotSemanticVectorQueryP95Milliseconds: NonNegativeFinite,
        hotSemanticVectorQuerySamples: PositiveInteger,
        incrementalProcessPeakRssBytes: NonNegativeFinite,
        oneFileReindexMaterializationMilliseconds: NonNegativeFinite,
        oneFileReindexMilliseconds: NonNegativeFinite,
        oneFileReindexVectorIndexMilliseconds: NonNegativeFinite,
        primaryQueryStructuralParity: Schema.Literal(1),
        sameOverlayFullRebuildMilliseconds: NonNegativeFinite,
        structuralGraphDigestParity: Schema.Literal(1),
        wholeGraphAnalysisP95Milliseconds: NonNegativeFinite,
        wholeGraphAnalysisSamples: PositiveInteger,
      }),
      provenance: Schema.Struct({
        artifactId: PositiveInteger,
        candidateCommit: GitCommit,
        createdAt: IsoInstant,
        rawArtifactSha256: Sha256,
        workflowAttempt: PositiveInteger,
        workflowRun: PositiveInteger,
      }),
      parity: Schema.Struct({
        coldPrimaryQueryStructuralDigest: Sha256,
        incrementalPrimaryQueryStructuralDigest: Sha256,
        incrementalStructuralGraphDigest: Sha256,
        sameOverlayPrimaryQueryStructuralDigest: Sha256,
        sameOverlayStructuralGraphDigest: Sha256,
      }),
      runner: Schema.Struct({
        architecture: Schema.Literal('arm64'),
        cpu: Schema.Literal('Apple M1 (Virtual)'),
        memoryBytes: PositiveInteger,
        operatingSystem: Schema.String,
        runnerClass: Schema.Literal('github-hosted-macos-arm64'),
        runtime: Schema.Literal('bun/1.3.14'),
      }),
      sampler: Schema.Struct({
        coldProcessFailures: NonNegativeInteger,
        coldProcessSamples: PositiveInteger,
        oneFileReindexProcessFailures: NonNegativeInteger,
        oneFileReindexProcessSamples: PositiveInteger,
        sameOverlayProcessFailures: NonNegativeInteger,
        sameOverlayProcessSamples: PositiveInteger,
      }),
      version: Schema.Literal(1),
      workload: Schema.Struct({
        embeddingContextCpuMathCores: PositiveInteger,
        embeddingContextPoolSizeEffective: PositiveInteger,
        embeddingContextPoolSizeRequested: PositiveInteger,
        embeddingContextThreadCounts: Schema.Array(PositiveInteger),
        embeddingModelGpuLayers: NonNegativeInteger,
        modelBackend: Schema.Literal('node-llama-cpp'),
        modelId: Schema.Literal('bge-small-en-v1.5-q8'),
        modelRevision: Schema.Literal('builtin-pinned'),
        scaleSymbols: Schema.Literal(100_000),
        vectorRows: PositiveInteger,
      }),
    }),
  ),
)(
  await Bun.file(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/vector-100000-macos-calibration-v1.json',
  ).text(),
);

const guardedMeasurements = [
  {
    budgetKey: 'coldIndexP95MillisecondsMaximum',
    measurementName: 'cold-index',
    observationKey: 'coldIndexMilliseconds',
    samples: calibration.observations.coldIndexSamples,
    unit: 'milliseconds',
  },
  {
    budgetKey: 'coldMaterializationP95MillisecondsMaximum',
    measurementName: 'cold-materialization',
    observationKey: 'coldMaterializationMilliseconds',
    samples: 1,
    unit: 'milliseconds',
  },
  {
    budgetKey: 'oneFileIncrementalP95MillisecondsMaximum',
    measurementName: 'one-file-reindex-index',
    observationKey: 'oneFileReindexMilliseconds',
    samples: 1,
    unit: 'milliseconds',
  },
  {
    budgetKey: 'oneFileMaterializationP95MillisecondsMaximum',
    measurementName: 'one-file-reindex-materialization',
    observationKey: 'oneFileReindexMaterializationMilliseconds',
    samples: 1,
    unit: 'milliseconds',
  },
  {
    budgetKey: 'hotQueryP95MillisecondsMaximum',
    measurementName: 'hot-semantic-vector-query',
    observationKey: 'hotSemanticVectorQueryP95Milliseconds',
    samples: calibration.observations.hotSemanticVectorQuerySamples,
    unit: 'milliseconds',
  },
  {
    budgetKey: 'wholeGraphAnalysisP95MillisecondsMaximum',
    measurementName: 'whole-graph-structural-analysis',
    observationKey: 'wholeGraphAnalysisP95Milliseconds',
    samples: calibration.observations.wholeGraphAnalysisSamples,
    unit: 'milliseconds',
  },
  {
    budgetKey: 'processPeakRssBytesMaximum',
    measurementName: 'incremental-process-peak-rss',
    observationKey: 'incrementalProcessPeakRssBytes',
    samples: 1,
    unit: 'bytes',
  },
  {
    budgetKey: 'derivedIndexBytesMaximum',
    measurementName: 'derived-index-disk',
    observationKey: 'derivedIndexBytes',
    samples: 1,
    unit: 'bytes',
  },
] as const;

describe('hosted macOS ARM64 100k vector calibration', () => {
  it('rederives the prospective cold-index ceiling from retained evidence', () => {
    const derivedMaximum =
      Math.ceil(
        (calibration.observations.coldIndexMilliseconds * (1 + calibration.calibration.admissionMarginRatio)) /
          calibration.calibration.roundUpIncrementMilliseconds,
      ) * calibration.calibration.roundUpIncrementMilliseconds;

    expect(derivedMaximum).toBe(1_350_000);
    expect(calibration.calibration.derivedColdIndexMaximumMilliseconds).toBe(derivedMaximum);
    expect(budget.coldIndexP95MillisecondsMaximum).toBe(derivedMaximum);
    expect(derivedMaximum / calibration.observations.sameOverlayFullRebuildMilliseconds - 1).toBeGreaterThan(0.07);
    expect(derivedMaximum / calibration.observations.sameOverlayFullRebuildMilliseconds - 1).toBeLessThan(0.08);
    expect(calibration.observations.coldVectorIndexMilliseconds).toBeGreaterThan(
      calibration.observations.coldIndexMilliseconds * 0.9,
    );
    expect(calibration.observations.coldEmbeddingProgressProcessFailures).toBe(0);
    expect(calibration.observations.coldEmbeddingProgressProcessSamples).toBeGreaterThan(3_000);
    expect(calibration.observations.primaryQueryStructuralParity).toBe(1);
    expect(calibration.observations.structuralGraphDigestParity).toBe(1);
    expect([
      calibration.sampler.coldProcessFailures,
      calibration.sampler.oneFileReindexProcessFailures,
      calibration.sampler.sameOverlayProcessFailures,
    ]).toEqual([0, 0, 0]);
    expect([
      calibration.sampler.coldProcessSamples,
      calibration.sampler.oneFileReindexProcessSamples,
      calibration.sampler.sameOverlayProcessSamples,
    ]).toEqual([4_156, 152, 4_352]);
    expect(calibration.parity.incrementalStructuralGraphDigest).toBe(
      calibration.parity.sameOverlayStructuralGraphDigest,
    );
    expect(
      new Set([
        calibration.parity.coldPrimaryQueryStructuralDigest,
        calibration.parity.incrementalPrimaryQueryStructuralDigest,
        calibration.parity.sameOverlayPrimaryQueryStructuralDigest,
      ]).size,
    ).toBe(1);
  });

  it('rederives the independent CPU-capacity cross-check from retained governed evidence', async () => {
    const source = await Bun.file(calibration.capacityCrossCheck.sourcePath).text();
    expect(sha256HexSync(source)).toBe(calibration.capacityCrossCheck.sourceSha256);
    const governedSweep = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          contexts: Schema.Struct({
            '2': Schema.Struct({coldIndexMilliseconds: Schema.Struct({median: NonNegativeFinite})}),
          }),
          controls: Schema.Struct({vectorRowCounts: Schema.Array(PositiveInteger)}),
          environment: Schema.Struct({cpuMathCores: PositiveInteger}),
          scope: Schema.Struct({scaleSymbols: PositiveInteger}),
          source: Schema.Struct({threadnoteCommit: GitCommit}),
          threadPlans: Schema.Array(
            Schema.Struct({
              contexts: PositiveInteger,
              threads: Schema.String,
            }),
          ),
        }),
      ),
    )(source);
    const sourceVectorRows = governedSweep.controls.vectorRowCounts[0];
    const sourceThreadPlan = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        governedSweep.threadPlans,
        plan => plan.contexts === calibration.capacityCrossCheck.sourceEffectiveContexts,
      ),
    );
    if (sourceVectorRows === undefined || sourceThreadPlan === undefined) {
      throw new Error('Governed embedding-context evidence is incomplete.');
    }

    expect(governedSweep.controls.vectorRowCounts).toEqual([sourceVectorRows]);
    expect(governedSweep.source.threadnoteCommit).toBe(calibration.capacityCrossCheck.sourceCommit);
    expect(governedSweep.scope.scaleSymbols).toBe(calibration.capacityCrossCheck.sourceScaleSymbols);
    expect(governedSweep.environment.cpuMathCores).toBe(calibration.capacityCrossCheck.sourceCpuMathCores);
    expect(governedSweep.contexts['2'].coldIndexMilliseconds.median).toBe(
      calibration.capacityCrossCheck.sourceMedianColdIndexMilliseconds,
    );
    expect(sourceVectorRows).toBe(calibration.capacityCrossCheck.sourceVectorRows);
    expect(sourceThreadPlan.threads).toBe(
      EffectArray.join(
        EffectArray.map(calibration.capacityCrossCheck.sourceThreadCounts, item =>
          item === null || item === undefined ? '' : String(item),
        ),
        ',',
      ),
    );

    const predicted =
      governedSweep.contexts['2'].coldIndexMilliseconds.median *
      (calibration.workload.vectorRows / sourceVectorRows) *
      (governedSweep.environment.cpuMathCores / calibration.workload.embeddingContextCpuMathCores);
    const observedFasterRatio = (predicted - calibration.observations.coldIndexMilliseconds) / predicted;

    expect(predicted).toBeCloseTo(calibration.capacityCrossCheck.predictedTargetColdIndexMilliseconds, 6);
    expect(observedFasterRatio).toBeCloseTo(calibration.capacityCrossCheck.observedFasterThanPredictionRatio, 12);
    expect(observedFasterRatio).toBeGreaterThan(0.08);
    expect(calibration.capacityCrossCheck.sourceThreadCounts).toEqual([4, 4]);
    expect(calibration.workload.embeddingContextThreadCounts).toEqual([2, 1]);
  });

  it('admits the retained observation and keeps every independent guard strict', () => {
    const artifact = calibrationArtifact();
    expect(() => enforceCodeGraphBenchmarkBudget(artifact, budgetFile, 100_000)).not.toThrow();

    fc.assert(
      fc.property(fc.constantFrom(...guardedMeasurements), fc.integer({max: 100_000, min: 1}), (guard, delta) => {
        const regressed = calibrationArtifact({
          measurementName: guard.measurementName,
          value: budget[guard.budgetKey] + delta,
        });
        expect(() => enforceCodeGraphBenchmarkBudget(regressed, budgetFile, 100_000)).toThrow(
          new RegExp(guard.measurementName, 'u'),
        );
      }),
      {numRuns: 50},
    );
  });
});

function calibrationArtifact(
  override?: Readonly<{measurementName: (typeof guardedMeasurements)[number]['measurementName']; value: number}>,
): BenchmarkArtifactV1 {
  return {
    createdAt: calibration.provenance.createdAt,
    environment: {
      architecture: calibration.runner.architecture,
      commit: calibration.provenance.candidateCommit,
      cpu: calibration.runner.cpu,
      dirty: calibration.artifact.dirty,
      fixtureHash: calibration.artifact.fixtureHash,
      memoryBytes: calibration.runner.memoryBytes,
      model: {
        backend: calibration.workload.modelBackend,
        id: calibration.workload.modelId,
        revision: calibration.workload.modelRevision,
      },
      node: calibration.runner.runtime,
      operatingSystem: calibration.runner.operatingSystem,
      packageManager: calibration.runner.runtime,
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements: EffectArray.map(guardedMeasurements, guard =>
      benchmarkMeasurement(
        guard.measurementName,
        guard.unit,
        Array.from({length: guard.samples}, () =>
          override?.measurementName === guard.measurementName
            ? override.value
            : calibration.observations[guard.observationKey],
        ),
      ),
    ),
    metadata: {scaleSymbols: calibration.workload.scaleSymbols, vectorEnabled: true},
    suite: calibration.artifact.suite,
    version: calibration.artifact.version,
    warmups: calibration.artifact.warmups,
  };
}
