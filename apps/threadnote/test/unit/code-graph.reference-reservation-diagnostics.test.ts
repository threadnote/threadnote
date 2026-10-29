import {Array as EffectArray, Option as EffectOption} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import {it as effectIt} from '@effect/vitest';
import {Effect, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, it} from 'vitest';
import {
  BenchmarkStageTimings,
  createCodeGraphProductionRatchet,
  enforceCodeGraphBenchmarkRatchet,
  productionProfileArtifactMetadata,
  PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS,
} from '../../../../scripts/benchmark-code-graph.js';
import {PRODUCTION_LARGE_CODE_GRAPH_PROFILE} from '../../../../scripts/code-graph-fixture.js';
import {benchmarkMeasurement, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM} from '@threadnote/graph/materialized_shard_cache_admission';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function benchmarkArtifact(
  measurements: BenchmarkArtifactV1['measurements'],
  metadata: BenchmarkArtifactV1['metadata'] = {},
  suite = 'code-graph-v1',
): BenchmarkArtifactV1 {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const externalCommit =
    typeof metadata.externalRepositoryCommit === 'string' ? metadata.externalRepositoryCommit : undefined;
  return {
    createdAt: '2026-08-01T00:00:00.000Z',
    environment: {
      architecture: 'x64',
      commit,
      cpu: 'test',
      dirty: false,
      fixtureHash:
        suite === 'code-graph-external-repository-v1' && externalCommit
          ? `external-code-graph-v1:${externalCommit}`
          : 'fixture',
      memoryBytes: 1,
      node: 'bun/test',
      operatingSystem: 'linux',
      packageManager: 'bun/test',
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements: EffectArray.map(measurements, measurement =>
      typeof metadata.releaseEvidenceRef === 'string' &&
      ['hot-exact-lexical-query', 'manager-bounded-query'].includes(measurement.name)
        ? benchmarkMeasurement(
            measurement.name,
            measurement.unit,
            Array.from({length: 25}, () => measurement.maximum),
          )
        : measurement,
    ),
    metadata: {
      benchmarkMeasuredExecutionMode: 'local-source-application-layer',
      benchmarkMeasuredSourceCommit: commit,
      benchmarkMeasuredSourceLockfileSha256: Effect2.pipe('a', EffectString.repeat(64)),
      benchmarkMeasuredSourcePackageManifestSha256: Effect2.pipe('b', EffectString.repeat(64)),
      benchmarkGithubRunnerArchitecture: 'X64',
      benchmarkGithubRunnerEnvironment: 'github-hosted',
      benchmarkGithubRunnerOperatingSystem: 'Linux',
      benchmarkSourceValidationMode: 'github-actions-clean-source',
      benchmarkValidatedManagedPayload: 'not-applicable-github-actions-clean-source',
      ...(Effect2.pipe(suite, EffectString.startsWith('code-graph-production-large-'))
        ? {
            ...productionProfileArtifactMetadata(PRODUCTION_LARGE_CODE_GRAPH_PROFILE),
            releaseEvidenceRef: 'refs/tags/v4.0.0-beta.30',
            releaseEvidenceHarnessCommit: commit,
            releaseEvidenceHarnessDeltaPaths: '[]',
            releaseEvidenceResolvedSha: commit,
            releaseEvidenceSha: commit,
            releaseEvidenceSourceMode: 'exact-release',
          }
        : {}),
      ...metadata,
    },
    suite,
    version: 1,
    warmups: 5,
  };
}

function requiredReleaseMeasurements(
  required: readonly {
    readonly name: string;
    readonly unit: BenchmarkArtifactV1['measurements'][number]['unit'];
  }[],
): BenchmarkArtifactV1['measurements'] {
  return EffectArray.map(required, measurement =>
    benchmarkMeasurement(measurement.name, measurement.unit, [
      measurement.name === 'cold-activation-observed-stages-n1'
        ? 3
        : Effect2.pipe(measurement.name, EffectString.endsWith('-materialization-cached-fact-replay-bytes-n1'))
          ? CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 2
          : Effect2.pipe(measurement.name, EffectString.endsWith('-materialization-cached-fact-bytes-total-n1'))
            ? CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 1
            : Effect2.pipe(measurement.name, EffectString.endsWith('-materialization-raw-fact-replay-bytes-n1')) ||
                Effect2.pipe(
                  measurement.name,
                  EffectString.endsWith('-materialized-shard-cache-deferred-raw-fact-bytes-n1'),
                )
              ? CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 1
              : /-materialization-subphase-shard-(?:association|persistence|serialization)-n1$/u.test(measurement.name)
                ? 0
                : Effect2.pipe(measurement.name, EffectString.startsWith('production-shape-'))
                  ? 100
                  : Effect2.pipe(measurement.name, EffectString.startsWith('cold-activation-copying-')) &&
                      Effect2.pipe(measurement.name, EffectString.endsWith('-observed-n1'))
                    ? 0
                    : Effect2.pipe(measurement.name, EffectString.endsWith('-activation-observed-stages-n1'))
                      ? 32
                      : Effect2.pipe(measurement.name, EffectString.endsWith('-external-sampler-version-n1'))
                        ? 4
                        : Effect2.pipe(
                              measurement.name,
                              EffectString.endsWith('-materialization-sidecar-wal-high-water-n1'),
                            )
                          ? 0
                          : Effect2.pipe(
                                measurement.name,
                                EffectString.endsWith('-external-process-tree-failures-n1'),
                              ) ||
                              Effect2.pipe(
                                measurement.name,
                                EffectString.endsWith('-external-open-temp-process-tree-failures-n1'),
                              )
                            ? 0
                            : measurement.name === 'one-file-reindex-materialization-stage-restoring-indexes-n1'
                              ? 0
                              : 1,
    ]),
  );
}

const governed = (coldIndexMilliseconds: number, sampledPhase: string): BenchmarkArtifactV1 =>
  benchmarkArtifact(
    [
      ...requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      benchmarkMeasurement('cold-index', 'milliseconds', [coldIndexMilliseconds]),
      benchmarkMeasurement('whole-graph-structural-analysis', 'milliseconds', [77]),
      benchmarkMeasurement('whole-graph-structural-analysis-process-cpu', 'milliseconds', [10]),
      benchmarkMeasurement('hot-exact-lexical-query', 'milliseconds', [coldIndexMilliseconds + 200]),
      benchmarkMeasurement('hot-query-process-cpu', 'milliseconds', [coldIndexMilliseconds + 100]),
      benchmarkMeasurement('mcp-impact-duration', 'milliseconds', [coldIndexMilliseconds + 50]),
      benchmarkMeasurement('cold-registration-lock-and-database-setup', 'milliseconds', [coldIndexMilliseconds]),
      benchmarkMeasurement('cold-registration-process-cpu-n1', 'milliseconds', [coldIndexMilliseconds]),
      benchmarkMeasurement('cold-process-peak-rss', 'bytes', [512 * 1_048_576 + coldIndexMilliseconds]),
      benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [512 * 1_048_576 + coldIndexMilliseconds]),
      benchmarkMeasurement('cold-sqlite-wal-peak-observed', 'bytes', [coldIndexMilliseconds]),
      benchmarkMeasurement('same-overlay-reference-registration-lock-and-database-setup', 'milliseconds', [
        coldIndexMilliseconds + 10,
      ]),
      benchmarkMeasurement('cold-materialization-stage-committing-n1', 'milliseconds', [100]),
      benchmarkMeasurement('one-file-reindex-materialization-stage-committing-n1', 'milliseconds', [100]),
      benchmarkMeasurement('same-overlay-reference-materialization-stage-committing-n1', 'milliseconds', [100]),
      benchmarkMeasurement('cold-materialization-stage-preparing-rows-n1', 'milliseconds', [100]),
      benchmarkMeasurement('cold-hosted-subphase-n1', 'milliseconds', [1_000]),
      benchmarkMeasurement('cold-hosted-microphase-n1', 'milliseconds', [128]),
      benchmarkMeasurement('cold-zero-duration-n1', 'milliseconds', [0]),
      benchmarkMeasurement('hosted-sampler-samples-n1', 'count', [coldIndexMilliseconds]),
      benchmarkMeasurement('one-file-reindex-index', 'milliseconds', [29_000]),
      benchmarkMeasurement('one-file-reindex-post-committed-scan-overlay-and-workspace', 'milliseconds', [4_900]),
      benchmarkMeasurement('one-file-reindex-registration-lock-and-database-setup', 'milliseconds', [4_900]),
      benchmarkMeasurement(`${sampledPhase}-external-process-cpu-n1`, 'milliseconds', [17]),
    ],
    {
      benchmarkDiskFilesystem: 'apfs',
      benchmarkDiskLocation: 'internal',
      benchmarkDiskMedium: 'solid-state',
      benchmarkFilesystemsShared: true,
      benchmarkGoverned: true,
      benchmarkMinimumFreeBytes: 120 * 1_073_741_824,
      benchmarkPrimaryAvailableBytesAtStart: 140 * 1_073_741_824,
      benchmarkReferenceAvailableBytesAtStart: 140 * 1_073_741_824,
      benchmarkReferenceDiskFilesystem: 'apfs',
      benchmarkReferenceDiskLocation: 'internal',
      benchmarkReferenceDiskMedium: 'solid-state',
      coldEdges: 3,
      coldFiles: 2,
      coldMaterializationStorageMode: 'direct-persistent',
      coldSymbols: 5,
      effectiveParserMemoryBytes: 64 * 1_073_741_824,
      effectiveParserWorkers: 4,
      oneFileReindexMaterializationMode: 'incremental-overlay',
      oneFileReindexMaterializationStorageMode: 'unreported',
      primaryQueryStructuralDigestCold: Effect2.pipe('1', EffectString.repeat(64)),
      primaryQueryStructuralDigestIncremental: Effect2.pipe('2', EffectString.repeat(64)),
      primaryQueryStructuralDigestSameOverlayReference: Effect2.pipe('2', EffectString.repeat(64)),
      retrievalMode: 'lexical-only',
      runnerClass: 'governed-test',
      runtimePlatform: 'darwin',
      sameOverlayReferenceMaterializationMode: 'full',
      sameOverlayReferenceMaterializationStorageMode: 'direct-persistent',
      sqlitePageSizeBytes: 8192,
      sqliteVersion: '3.49.1',
      structuralGraphDigestCold: Effect2.pipe(coldIndexMilliseconds.toString(16), EffectString.padStart(64, '0')),
      structuralGraphDigestIncremental: Effect2.pipe(
        (coldIndexMilliseconds + 1).toString(16),
        EffectString.padStart(64, '0'),
      ),
      structuralGraphDigestSameOverlayReference: Effect2.pipe(
        (coldIndexMilliseconds + 1).toString(16),
        EffectString.padStart(64, '0'),
      ),
      vectorEnabled: false,
    },
    'code-graph-production-large-v2',
  );

const ratchetMeasurementSchema = Schema.StructWithRest(
  Schema.Struct({
    meanMaximum: Schema.optional(Schema.Finite),
    maximum: Schema.optional(Schema.Finite),
    minimum: Schema.optional(Schema.Finite),
    p50Maximum: Schema.optional(Schema.Finite),
    p95Maximum: Schema.optional(Schema.Finite),
    p99Maximum: Schema.optional(Schema.Finite),
    samplesMinimum: Schema.optional(Schema.Finite),
    unit: Schema.Union([
      Schema.Literal('bytes'),
      Schema.Literal('count'),
      Schema.Literal('milliseconds'),
      Schema.Literal('operations_per_second'),
      Schema.Literal('percent'),
    ]),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const pinnedRatchetSchema = Schema.StructWithRest(
  Schema.Struct({measurements: Schema.Record(Schema.String, ratchetMeasurementSchema)}),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const stages = [
  'reference-reservation-owner-identity',
  'reference-reservation-claim',
  'reference-reservation-use',
  'reference-reservation-release',
] as const;
const referenceName = 'one-file-reindex-reference-resolution';
const withReference = (artifact: BenchmarkArtifactV1, value: number): BenchmarkArtifactV1 => ({
  ...artifact,
  measurements: [
    ...EffectArray.filter(artifact.measurements, item => item.name !== referenceName),
    benchmarkMeasurement(referenceName, 'milliseconds', [value]),
  ],
});
const artifacts = EffectArray.map([100, 105, 110], value =>
  withReference(governed(value, 'cold-scanning-progress'), 16),
);
const syntheticRatchet = createCodeGraphProductionRatchet(artifacts);
const pinned = Schema.decodeUnknownSync(pinnedRatchetSchema)(
  JSON.parse(
    readFileSync(
      'apps/threadnote/test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
      'utf8',
    ),
  ),
);
const ratchet = {
  ...syntheticRatchet,
  measurements: {...syntheticRatchet.measurements, [referenceName]: pinned.measurements[referenceName]},
};
const diagnostics = EffectArray.flatMap(['cold', 'one-file-reindex', 'same-overlay-reference'], prefix =>
  EffectArray.flatMap(stages, stage =>
    EffectArray.map(['count', 'process-cpu-total', 'wall-maximum', 'wall-total'], statistic =>
      benchmarkMeasurement(
        `${prefix}-completion-${stage}-${statistic}-n1`,
        statistic === 'count' ? 'count' : 'milliseconds',
        [1_000_000],
      ),
    ),
  ),
);
const withDiagnostics = (artifact: BenchmarkArtifactV1): BenchmarkArtifactV1 => ({
  ...artifact,
  measurements: [...artifact.measurements, ...diagnostics],
});

it('reference reservation diagnostics retain only the four closed subdivisions without changing assessed work', () => {
  const before = structuredClone(artifacts);
  const observed = EffectArray.map(artifacts, withDiagnostics);
  expect(diagnostics).toHaveLength(48);
  expect(createCodeGraphProductionRatchet(observed)).toEqual(syntheticRatchet);
  expect(() => enforceCodeGraphBenchmarkRatchet(observed[0], ratchet)).not.toThrow();
  expect(observed[0].measurements.slice(-48)).toEqual(diagnostics);
  expect(artifacts).toEqual(before);
});

it('reference reservation diagnostics retain the actual 188.338706ms versus 125ms refusal', () => {
  expect(ratchet.measurements[referenceName].p95Maximum).toBe(125);
  expect(() =>
    enforceCodeGraphBenchmarkRatchet(withDiagnostics(withReference(artifacts[0], 188.338706)), ratchet),
  ).toThrow(/one-file-reindex-reference-resolution p95 188\.338706 exceeds 125/u);
});

it('reference reservation diagnostics reject unknown stage, statistic, prefix and duplicate names', () => {
  for (const name of [
    'cold-completion-reference-reservation-future-count-n1',
    'cold-completion-reference-reservation-use-unknown-n1',
    'bootstrap-completion-reference-reservation-use-count-n1',
  ]) {
    const candidate = withDiagnostics(artifacts[0]);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        {...candidate, measurements: [...candidate.measurements, benchmarkMeasurement(name, 'count', [1])]},
        ratchet,
      ),
    ).toThrow(/stable production measurement set changed/u);
  }
  const candidate = withDiagnostics(artifacts[0]);
  expect(() =>
    enforceCodeGraphBenchmarkRatchet(
      {...candidate, measurements: [...candidate.measurements, diagnostics[0]]},
      ratchet,
    ),
  ).toThrow(/unique assessed measurement names/u);
});

effectIt.effect(
  'reference reservation diagnostics use the existing bounded wall CPU count and maximum projection',
  () =>
    Effect.gen(function* () {
      const timings = new BenchmarkStageTimings();
      for (const stage of stages) {
        for (const duration of [2, 5]) {
          const complete = yield* timings.observe(stage);
          yield* TestClock.adjust(duration);
          yield* complete;
        }
      }
      const measurements = timings.measurements('one-file-reindex');
      expect(measurements).toHaveLength(16);
      for (const stage of stages) {
        const prefix = `one-file-reindex-completion-${stage}`;
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(measurements, item => item.name === `${prefix}-count-n1`))
            ?.p95,
        ).toBe(2);
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(measurements, item => item.name === `${prefix}-wall-total-n1`),
          )?.p95,
        ).toBe(7);
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(measurements, item => item.name === `${prefix}-wall-maximum-n1`),
          )?.p95,
        ).toBe(5);
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(measurements, item => item.name === `${prefix}-process-cpu-total-n1`),
          )?.p95,
        ).toBeGreaterThanOrEqual(0);
      }
    }),
);
