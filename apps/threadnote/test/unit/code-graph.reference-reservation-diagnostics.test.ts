import {readFileSync} from '@threadnote/testing/node-fs';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, it} from 'vitest';
import {
  BenchmarkStageTimings,
  createCodeGraphProductionRatchet,
  enforceCodeGraphBenchmarkRatchet,
  productionProfileArtifactMetadata,
  PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS,
  type CodeGraphBenchmarkMeasurementRatchetV1,
} from '../../../../scripts/benchmark-code-graph.js';
import {PRODUCTION_LARGE_CODE_GRAPH_PROFILE} from '../../../../scripts/code-graph-fixture.js';
import {benchmarkMeasurement, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM} from '@threadnote/graph/materialized_shard_cache_admission';

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
    measurements: measurements.map(measurement =>
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
      benchmarkMeasuredSourceLockfileSha256: 'a'.repeat(64),
      benchmarkMeasuredSourcePackageManifestSha256: 'b'.repeat(64),
      benchmarkGithubRunnerArchitecture: 'X64',
      benchmarkGithubRunnerEnvironment: 'github-hosted',
      benchmarkGithubRunnerOperatingSystem: 'Linux',
      benchmarkSourceValidationMode: 'github-actions-clean-source',
      benchmarkValidatedManagedPayload: 'not-applicable-github-actions-clean-source',
      ...(suite.startsWith('code-graph-production-large-')
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
  return required.map(measurement =>
    benchmarkMeasurement(measurement.name, measurement.unit, [
      measurement.name === 'cold-activation-observed-stages-n1'
        ? 3
        : measurement.name.endsWith('-materialization-cached-fact-replay-bytes-n1')
          ? CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 2
          : measurement.name.endsWith('-materialization-cached-fact-bytes-total-n1')
            ? CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 1
            : measurement.name.endsWith('-materialization-raw-fact-replay-bytes-n1') ||
                measurement.name.endsWith('-materialized-shard-cache-deferred-raw-fact-bytes-n1')
              ? CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 1
              : /-materialization-subphase-shard-(?:association|persistence|serialization)-n1$/u.test(measurement.name)
                ? 0
                : measurement.name.startsWith('production-shape-')
                  ? 100
                  : measurement.name.startsWith('cold-activation-copying-') && measurement.name.endsWith('-observed-n1')
                    ? 0
                    : measurement.name.endsWith('-activation-observed-stages-n1')
                      ? 32
                      : measurement.name.endsWith('-external-sampler-version-n1')
                        ? 4
                        : measurement.name.endsWith('-materialization-sidecar-wal-high-water-n1')
                          ? 0
                          : measurement.name.endsWith('-external-process-tree-failures-n1') ||
                              measurement.name.endsWith('-external-open-temp-process-tree-failures-n1')
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
      primaryQueryStructuralDigestCold: '1'.repeat(64),
      primaryQueryStructuralDigestIncremental: '2'.repeat(64),
      primaryQueryStructuralDigestSameOverlayReference: '2'.repeat(64),
      retrievalMode: 'lexical-only',
      runnerClass: 'governed-test',
      runtimePlatform: 'darwin',
      sameOverlayReferenceMaterializationMode: 'full',
      sameOverlayReferenceMaterializationStorageMode: 'direct-persistent',
      sqlitePageSizeBytes: 8192,
      sqliteVersion: '3.49.1',
      structuralGraphDigestCold: coldIndexMilliseconds.toString(16).padStart(64, '0'),
      structuralGraphDigestIncremental: (coldIndexMilliseconds + 1).toString(16).padStart(64, '0'),
      structuralGraphDigestSameOverlayReference: (coldIndexMilliseconds + 1).toString(16).padStart(64, '0'),
      vectorEnabled: false,
    },
    'code-graph-production-large-v2',
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
    ...artifact.measurements.filter(item => item.name !== referenceName),
    benchmarkMeasurement(referenceName, 'milliseconds', [value]),
  ],
});
const artifacts = [100, 105, 110].map(value => withReference(governed(value, 'cold-scanning-progress'), 16));
const syntheticRatchet = createCodeGraphProductionRatchet(artifacts);
const pinned = JSON.parse(
  readFileSync(
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
    'utf8',
  ),
) as {measurements: Record<string, CodeGraphBenchmarkMeasurementRatchetV1>};
const ratchet = {
  ...syntheticRatchet,
  measurements: {...syntheticRatchet.measurements, [referenceName]: pinned.measurements[referenceName]},
};
const diagnostics = ['cold', 'one-file-reindex', 'same-overlay-reference'].flatMap(prefix =>
  stages.flatMap(stage =>
    ['count', 'process-cpu-total', 'wall-maximum', 'wall-total'].map(statistic =>
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
  const observed = artifacts.map(withDiagnostics);
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
        expect(measurements.find(item => item.name === `${prefix}-count-n1`)?.p95).toBe(2);
        expect(measurements.find(item => item.name === `${prefix}-wall-total-n1`)?.p95).toBe(7);
        expect(measurements.find(item => item.name === `${prefix}-wall-maximum-n1`)?.p95).toBe(5);
        expect(measurements.find(item => item.name === `${prefix}-process-cpu-total-n1`)?.p95).toBeGreaterThanOrEqual(
          0,
        );
      }
    }),
);
