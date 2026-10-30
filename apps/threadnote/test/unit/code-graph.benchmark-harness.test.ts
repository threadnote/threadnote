import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {succeedUndefined} from '@threadnote/platform/optional';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {readFileSync} from '@threadnote/testing/node-fs';
import {it as effectIt} from '@effect/vitest';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {ByteSize, Clock, DateTime, Effect, FileSystem, Option, Path, PlatformError, Schedule, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import * as BunServices from '@effect/platform-bun/BunServices';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {Deferred, Fiber, Layer} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  applyBenchmarkOverlay,
  advanceCodeGraphBenchmarkRunCheckpoint,
  BENCHMARK_CHECKPOINT_INDEX_PHASES,
  initialCodeGraphBenchmarkRunCheckpoint,
  benchmarkIndexCheckpointMeasurement,
  makeBenchmarkRunCheckpoint,
  parseCodeGraphBenchmarkRunCheckpoint,
  embeddingRuntimeDiagnosticSchedule,
  parseEmbeddingRuntimeDiagnosticObservation,
  summarizeEmbeddingRuntimeDiagnostics,
  BenchmarkStageTimings,
  IndexPhaseTimeline,
  indexPhaseMeasurements,
  benchmarkDarwinStorageClassification,
  benchmarkLinuxStorageClassification,
  benchmarkVectorModelDirectoryName,
  CODE_GRAPH_SQLITE_WRITER_PROFILES,
  codeGraphBenchmarkSqlitePeak,
  codeGraphQueryResultParityEvidence,
  codeGraphQueryResultParityFailureMessage,
  codeGraphStructuralParityEvidence,
  codeGraphStructuralParityFailureMessage,
  codeGraphStructuralDigestSymbolLookupStatement,
  decodeBenchmarkSource,
  directoryBytes,
  externalBenchmarkPlatformSupported,
  measureBenchmarkIndex,
  measureSampledBenchmarkIndex,
  parseCodeGraphBenchmarkArguments,
  productionBenchmarkStorageGoverned,
  requiresLongScaleBenchmarkEvidence,
  restoreBenchmarkOverlay,
  sanitizedBenchmarkEnvironmentProvenance,
  semanticBenchmarkOverlay,
  sqliteStructuralGraphEvidence,
  validateSqliteWriterSettingsEvidence,
  vectorSemanticControlMinimumScore,
} from '../../../../scripts/benchmark-code-graph.js';
import type {
  CodeGraphBenchmarkSamplerArtifact,
  CodeGraphBenchmarkSamplerPhase,
} from '../../../../scripts/code-graph-benchmark-sampler.js';
import {
  embeddingContextBenchmarkSchedule,
  parseEmbeddingContextBenchmarkArguments,
  summarizeEmbeddingContextArtifacts,
} from '../../../../scripts/benchmark-code-graph-embedding-contexts.js';
import {git, prepareGeneratedCodeGraphFixture} from '../../../../scripts/code-graph-fixture.js';
import {codeGraphAnalysisLimitsForView} from '@threadnote/graph/analysis/render';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphStoreBusyError, type CodeGraphQueryResult, type RepositoryIdentity} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {benchmarkMeasurement, parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

function samplerPhase(databasePeakBytes: number): CodeGraphBenchmarkSamplerPhase {
  return {
    databasePeakBytes,
    samples: 1,
    shmPeakBytes: 0,
    temporaryPeakBytes: 0,
    walPeakBytes: 0,
  };
}

function samplerArtifact(
  phases: Readonly<Record<string, CodeGraphBenchmarkSamplerPhase>>,
): CodeGraphBenchmarkSamplerArtifact {
  return {
    intervalMilliseconds: 1000,
    phases,
    platform: 'linux',
    processTelemetry: {
      availability: 'unavailable',
      parentIdentityValidation: 'process-liveness-only',
      reason: 'unsupported-platform',
      source: 'none',
    },
    samples: 1,
    version: 4,
  };
}

function fileInfo(size: number): FileSystem.File.Info {
  return {
    type: 'File',
    mtime: Option.none(),
    atime: Option.none(),
    birthtime: Option.none(),
    dev: 0n,
    ino: Option.none(),
    mode: 0,
    nlink: Option.none(),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    size: ByteSize.bytes(size),
    blksize: Option.none(),
    blocks: Option.none(),
  };
}

const CONTROL = JSON.stringify({
  expectedLanguage: 'typescript',
  expectedPath: 'src/index.ts',
  query: 'indexSymbol',
});

describe('code graph external benchmark harness', () => {
  it('takes governed SQLite peaks from the independent sampler without losing the final boundary', () => {
    fc.assert(
      fc.property(
        fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
        fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
        fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
        (boundaryBytes, scanningBytes, resolvingBytes) => {
          const sampler = samplerArtifact({
            resolving: samplerPhase(resolvingBytes),
            scanning: samplerPhase(scanningBytes),
          });
          expect(codeGraphBenchmarkSqlitePeak(boundaryBytes, sampler, 'databasePeakBytes')).toBe(
            Math.max(boundaryBytes, scanningBytes, resolvingBytes),
          );
          expect(codeGraphBenchmarkSqlitePeak(boundaryBytes, undefined, 'databasePeakBytes')).toBe(boundaryBytes);
        },
      ),
      {numRuns: 250},
    );
  });

  it('classifies the backing macOS device without retaining device identity', () => {
    expect(
      benchmarkDarwinStorageClassification(
        'File System Personality: APFS\nType (Bundle): apfs\nDevice Location: Internal\nSolid State: Yes\n',
      ),
    ).toEqual({filesystem: 'apfs', location: 'internal', medium: 'solid-state'});
    expect(benchmarkDarwinStorageClassification('Internal: No\nSolid State: No\n')).toEqual({
      filesystem: 'unknown',
      location: 'external',
      medium: 'rotational',
    });
    expect(benchmarkDarwinStorageClassification('Network: Yes\nSolid State: Yes\n')).toEqual({
      filesystem: 'unknown',
      location: 'unknown',
      medium: 'virtual-or-network',
    });
  });

  it('classifies hosted Linux overlay storage without trusting its device alias', () => {
    expect(benchmarkLinuxStorageClassification('overlayfs', '/dev/root', [])).toBe('virtual-or-network');
    expect(benchmarkLinuxStorageClassification('ext4', '/dev/nvme0n1p1', ['0'])).toBe('solid-state');
    expect(benchmarkLinuxStorageClassification('xfs', '/dev/sda1', ['1'])).toBe('rotational');
    expect(benchmarkLinuxStorageClassification('ext4', '/dev/root', [])).toBe('unknown');
  });

  it('uses trusted GitHub-hosted Linux SSD attestation without weakening local storage governance', () => {
    const storage = (medium: 'rotational' | 'solid-state' | 'unknown' | 'virtual-or-network') => ({
      filesystem: 'bounded',
      location: 'unknown' as const,
      medium,
    });
    for (const medium of ['rotational', 'solid-state', 'unknown', 'virtual-or-network'] as const) {
      expect(productionBenchmarkStorageGoverned('linux', true, [storage(medium), storage(medium)])).toBe(true);
      expect(productionBenchmarkStorageGoverned('linux', false, [storage(medium), storage(medium)])).toBe(
        medium === 'solid-state',
      );
    }
    expect(productionBenchmarkStorageGoverned('darwin', true, [storage('unknown'), storage('unknown')])).toBe(false);
    expect(productionBenchmarkStorageGoverned('linux', false, [storage('solid-state'), storage('rotational')])).toBe(
      false,
    );
    expect(productionBenchmarkStorageGoverned('linux', true, [])).toBe(false);
  });

  it('ignores ordinary vector-maintenance metadata before filesystem inspection', () => {
    expect(benchmarkVectorModelDirectoryName('bge-small-en-v1.5-q8')).toBe(true);
    expect(benchmarkVectorModelDirectoryName('.ordinary-vector-retirement-v1.cursor')).toBe(false);
    expect(benchmarkVectorModelDirectoryName('.ordinary-vector-retirement-v1.cursor.tmp')).toBe(false);
  });

  effectIt.effect('keeps storage telemetry bounded when a listed entry disappears before stat', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join('benchmark', 'vectors');
      const disappearingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        exists: target => (String(target) === root ? Effect.succeed(true) : fileSystem.exists(target)),
        readDirectory: target =>
          String(target) === root
            ? Effect.succeed(['vectors-v1.sqlite', '.cursor.tmp'])
            : fileSystem.readDirectory(target),
        stat: target =>
          Effect2.pipe(String(target), EffectString.endsWith('.cursor.tmp'))
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: 'NotFound',
                  description: 'injected atomic telemetry disappearance',
                  method: 'stat',
                  module: 'FileSystem',
                  pathOrDescriptor: String(target),
                }),
              )
            : Effect2.pipe(String(target), EffectString.endsWith('vectors-v1.sqlite'))
              ? Effect.succeed(fileInfo(42))
              : fileSystem.stat(target),
      });

      expect(yield* directoryBytes(disappearingFileSystem, path, root)).toBe(42);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('applies the public path relevance policy to vector positive-control scores', () => {
    expect(vectorSemanticControlMinimumScore('src/architecture.ts')).toBe(0.64);
    expect(vectorSemanticControlMinimumScore('docs/architecture.md')).toBeLessThan(0.64);
    expect(vectorSemanticControlMinimumScore('test/architecture.test.ts')).toBeLessThan(0.64);
  });

  it('keeps whole-graph performance analysis on the aggregate-only path', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    expect(source).toContain("limits: codeGraphAnalysisLimitsForView('stats')");
    expect(source).toContain("result.coverage.topology.state !== 'not-requested'");
    expect(source).toContain('result.usage.edgeVisits !== 0');
    expect(codeGraphAnalysisLimitsForView('stats')).toEqual({
      communities: 0,
      communityMembers: 0,
      components: 0,
      confidenceFindings: 0,
      hubs: 0,
      memberships: 0,
      relationshipGroupMembers: 0,
      relationshipGroups: 0,
      surprisingLinks: 0,
    });
  });

  fcEffectProp(
    effectIt,
    'keeps repeated timing observations bounded and independent of returned snapshots',
    {durations: fc.array(fc.integer({min: 0, max: 1000}), {minLength: 1, maxLength: 12})},
    ({durations}) =>
      Effect.gen(function* () {
        const timings = new BenchmarkStageTimings();
        for (const duration of durations) {
          const complete = yield* timings.observe('snapshot-lease-release');
          yield* TestClock.adjust(duration);
          yield* complete;
        }
        const before = timings.observations();
        expect(before).toHaveLength(1);
        expect(before[0]?.[1]).toMatchObject({
          count: durations.length,
          maximumWallMilliseconds: Math.max(...durations),
          wallMilliseconds: EffectArray.reduce(durations, 0, (total, duration) => total + duration),
        });
        Object.assign(before[0][1], {wallMilliseconds: -1});
        expect(timings.observations()[0]?.[1].wallMilliseconds).toBeGreaterThanOrEqual(0);
        expect(timings.measurements('one-file-reindex')).toHaveLength(4);
      }),
    {fastCheck: {numRuns: 32}},
  );

  it('retains activation timing while exposing the post-completion tail', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({min: 0, max: 1000}),
          fc.integer({min: 0, max: 1000}),
          fc.integer({min: 0, max: 1000}),
          fc.integer({min: 0, max: 1000}),
        ),
        durations => {
          const telemetry = {cpuSystemMicroseconds: 0, cpuUserMicroseconds: 0, peakRssBytes: 0, rssBytes: 0};
          const timeline = new IndexPhaseTimeline(0n, telemetry);
          let at = 0;
          timeline.observe({phase: 'activating', subphase: 'validating-input', snapshotId: 'snapshot'}, 0n, telemetry);
          for (const [index, subphase] of (['writing-and-checkpointing', 'promoting', 'complete'] as const).entries()) {
            at += durations[index];
            timeline.observe(
              {phase: 'activating', subphase, snapshotId: 'snapshot'},
              BigInt(at) * 1_000_000n,
              telemetry,
            );
          }
          at += durations[3];
          timeline.finish(BigInt(at) * 1_000_000n, telemetry);
          const measurements = new Map(
            EffectArray.map(indexPhaseMeasurements('one-file-reindex', timeline, false), value => [
              value.name,
              value.maximum,
            ]),
          );
          expect(measurements.get('one-file-reindex-activation-lexical-only')).toBe(at);
          expect(measurements.get('one-file-reindex-post-activation-completion')).toBe(durations[3]);
          expect(
            (measurements.get('one-file-reindex-pre-activation-validation') ?? 0) +
              (measurements.get('one-file-reindex-snapshot-write-and-checkpoint') ?? 0) +
              (measurements.get('one-file-reindex-snapshot-promotion') ?? 0) +
              (measurements.get('one-file-reindex-post-activation-completion') ?? 0),
          ).toBe(at);
        },
      ),
      {numRuns: 64},
    );
  });

  effectIt.effect('separates lease releases after activation completion while retaining repeated calls', () =>
    Effect.gen(function* () {
      const telemetry = {cpuSystemMicroseconds: 0, cpuUserMicroseconds: 0, peakRssBytes: 0, rssBytes: 0};
      const timeline = new IndexPhaseTimeline(0n, telemetry);
      const early = yield* timeline.observeTiming('snapshot-lease-release');
      yield* TestClock.adjust(5);
      yield* early;
      timeline.observe({phase: 'activating', subphase: 'complete', snapshotId: 'snapshot'}, 5_000_000n, telemetry);
      for (let index = 0; index < 2; index += 1) {
        const scoped = yield* timeline.observeTiming('snapshot-lease-release');
        yield* TestClock.adjust(7);
        yield* scoped;
      }
      timeline.finish(19_000_000n, telemetry);
      const measurements = new Map(
        EffectArray.map(indexPhaseMeasurements('one-file-reindex', timeline, false), value => [
          value.name,
          value.maximum,
        ]),
      );
      expect(measurements.get('one-file-reindex-completion-snapshot-lease-release-count-n1')).toBe(1);
      expect(measurements.get('one-file-reindex-completion-snapshot-lease-release-after-complete-count-n1')).toBe(2);
      expect(measurements.get('one-file-reindex-completion-snapshot-lease-release-after-complete-wall-total-n1')).toBe(
        14,
      );
      expect(measurements.get('one-file-reindex-post-activation-completion')).toBe(14);
    }),
  );

  effectIt.effect('measures only index execution after setup and before cleanup', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      yield* TestClock.adjust(3_000);
      events.push('sampler-ready-and-overlay-applied');

      const measured = yield* measureBenchmarkIndex(() =>
        Effect.gen(function* () {
          events.push('index-started');
          yield* TestClock.adjust(125);
          events.push('index-finished');
          return 'summary';
        }),
      );

      yield* TestClock.adjust(5_000);
      events.push('overlay-restored-and-sampler-stopped');
      const afterCleanup = yield* Clock.currentTimeNanos;

      expect(measured.result).toBe('summary');
      expect(Number(measured.startedAt) / 1_000_000).toBe(3_000);
      expect(Number(measured.finishedAt - measured.startedAt) / 1_000_000).toBe(125);
      expect(Number(afterCleanup - measured.finishedAt) / 1_000_000).toBe(5_000);
      expect(measured.timeline.duration('start', 'finish')).toBe(125);
      expect(events).toEqual([
        'sampler-ready-and-overlay-applied',
        'index-started',
        'index-finished',
        'overlay-restored-and-sampler-stopped',
      ]);
    }),
  );

  effectIt.effect('samples only index work between overlay setup and restore', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const telemetry = samplerArtifact({index: samplerPhase(0)});
      const sampled = yield* Effect.acquireUseRelease(
        Effect.sync(() => events.push('overlay-applied')),
        () =>
          Effect.gen(function* () {
            const result = yield* measureSampledBenchmarkIndex(
              Effect.sync(() => {
                events.push('sampler-started');
                return {
                  mark: () => Effect.void,
                  stop: () =>
                    Effect.sync(() => {
                      events.push('sampler-stopped');
                      return telemetry;
                    }),
                };
              }),
              () =>
                Effect.gen(function* () {
                  events.push('index-started');
                  yield* TestClock.adjust(125);
                  events.push('index-finished');
                  return 'summary';
                }),
              Effect.sync(() => events.push('final-index-storage-sampled')),
            );
            events.push('post-index-control');
            return result;
          }),
        () => Effect.sync(() => events.push('overlay-restored')),
      );

      expect(sampled.measurement.result).toBe('summary');
      expect(sampled.telemetry).toBe(telemetry);
      expect(Number(sampled.measurement.finishedAt - sampled.measurement.startedAt) / 1_000_000).toBe(125);
      expect(events).toEqual([
        'overlay-applied',
        'sampler-started',
        'index-started',
        'index-finished',
        'final-index-storage-sampled',
        'sampler-stopped',
        'post-index-control',
        'overlay-restored',
      ]);
    }),
  );

  effectIt.effect('aborts the sampler before restoring an overlay when indexing fails', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const telemetry = samplerArtifact({index: samplerPhase(0)});
      const exit = yield* Effect.exit(
        Effect.acquireUseRelease(
          Effect.sync(() => events.push('overlay-applied')),
          () =>
            measureSampledBenchmarkIndex(
              Effect.sync(() => {
                events.push('sampler-started');
                return {
                  mark: () => Effect.void,
                  stop: state =>
                    Effect.sync(() => {
                      events.push(`sampler-stopped:${state}`);
                      return telemetry;
                    }),
                };
              }),
              () => Effect.fail(TestError.make({message: 'index failed'})),
              Effect.sync(() => events.push('final-index-storage-sampled')),
            ),
          () => Effect.sync(() => events.push('overlay-restored')),
        ),
      );

      expect(exit._tag).toBe('Failure');
      expect(events).toEqual(['overlay-applied', 'sampler-started', 'sampler-stopped:aborted', 'overlay-restored']);
    }),
  );

  it('wires all three index phases through the phase-pure sampler boundary', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    const cold = sourceSlice(source, 'const coldStoragePeak', 'const changedPath');
    const incremental = sourceSlice(source, 'const incrementalStoragePeak', 'const sameOverlayReferenceIdentity');
    const sameOverlay = sourceSlice(source, 'const sameOverlayReferenceStoragePeak', 'const coldStatusStarted');

    expectInOrder(cold, [
      "runCheckpoint?.mark('cold-index')",
      'measureSampledBenchmarkIndex(',
      'const coldExternalTelemetry',
      'const coldExternalQueryControls',
    ]);
    expectInOrder(incremental, [
      'applyBenchmarkOverlay(',
      'measureSampledBenchmarkIndex(',
      'restoreBenchmarkOverlay(',
      'const incrementalExternalTelemetry',
      'const incrementalExternalQueryControls',
    ]);
    expectInOrder(sameOverlay, [
      "system.setEnvironmentVariable('SQLITE_TMPDIR', sameOverlaySqliteTemporaryRoot)",
      'applyBenchmarkOverlay(',
      'measureSampledBenchmarkIndex(',
      'const controls',
      'restoreBenchmarkOverlay(',
      'const sameOverlayReferenceTelemetry',
    ]);
    expect(source).not.toContain('const coldStarted = yield* Clock.currentTimeNanos');
    expect(source).not.toContain('const incrementalStarted = yield* Clock.currentTimeNanos');
    expect(source).not.toContain('const sameOverlayReferenceStarted = yield* Clock.currentTimeNanos');
  });

  it('checkpoints and samples 100k evidence without enabling unrelated large-evidence behavior', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    expect(requiresLongScaleBenchmarkEvidence(99_999)).toBe(false);
    expect(requiresLongScaleBenchmarkEvidence(100_000)).toBe(true);
    expect(requiresLongScaleBenchmarkEvidence(250_000)).toBe(true);
    fc.assert(
      fc.property(fc.integer({max: 200_000, min: 0}), fc.integer({max: 200_000, min: 0}), (first, second) => {
        const lower = Math.min(first, second);
        const upper = Math.max(first, second);
        expect(Number(requiresLongScaleBenchmarkEvidence(lower))).toBeLessThanOrEqual(
          Number(requiresLongScaleBenchmarkEvidence(upper)),
        );
      }),
      {numRuns: 100},
    );
    expect(source).toContain('const checkpointedEvidenceRun = largeEvidenceRun || longScaleEvidenceRun');
    expect(source).toContain(
      'const sampleProcessTree = checkpointedEvidenceRun || options.embeddingContexts !== undefined',
    );
    expect(source).toContain('checkpointedEvidenceRun && options.outputPath');
    expect(source).toContain('const mcpOperationMatrix = largeEvidenceRun');
    expect(source).toContain('Math.min(options.samples, largeEvidenceRun ? 3 : 10)');
    expect(
      Effect2.pipe(
        source,
        EffectString.match(/sampleProcessTree\s*\? startExternalSampler/g),
        Effect2.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect2.pipe(
        source,
        EffectString.match(/sampler\s*\? Effect\.void\s*:\s*observeSqliteStoragePeak/g),
        Effect2.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
  });

  it('uses the centralized process maxRSS byte normalizer', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');

    expect(source).toContain('processResourceUsageMaxRssBytes(maxRss, process.platform, runtime)');
    expect(source).not.toContain("return 'bun' in process.versions ? maxRss : maxRss * 1_024");
  });

  it('preserves the governed Linux RSS ceiling while expressing it in bytes', () => {
    const ratchet = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          measurements: Schema.Struct({
            'cold-process-peak-rss': Schema.Struct({
              p95Maximum: Schema.Finite,
              unit: Schema.Literal('bytes'),
            }),
            'incremental-process-peak-rss': Schema.Struct({
              p95Maximum: Schema.Finite,
              unit: Schema.Literal('bytes'),
            }),
          }),
        }),
      ),
    )(
      readFileSync(
        'apps/threadnote/test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json',
        'utf8',
      ),
    );
    const governedCeilingBytes = 1_195_010 * 1_024;

    expect(ratchet.measurements['cold-process-peak-rss'].p95Maximum).toBe(governedCeilingBytes);
    expect(ratchet.measurements['incremental-process-peak-rss'].p95Maximum).toBe(governedCeilingBytes);
  });

  it('retains provenance-valid artifact evidence before reporting a budget or ratchet regression', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    const finalization = sourceSlice(source, 'let budgetFailure:', 'if (!options.quiet)');
    expectInOrder(finalization, [
      'enforceCodeGraphBenchmarkBudget(artifact, budget, options.scaleSymbols)',
      'enforceCodeGraphBenchmarkRatchet(artifact, ratchet)',
      'validateBenchmarkRuntimeProvenance(threadnoteSourceRoot)',
      'verifyBenchmarkSourceUnchanged(threadnoteSourceRoot, commit)',
      'atomicWrite(options.outputPath',
      'if (budgetFailure) return yield* budgetFailure',
      'if (ratchetFailure) return yield* ratchetFailure',
    ]);
  });

  it('retains privacy-safe structural parity evidence before a failed external run exits', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    const analysisParity = sourceSlice(
      source,
      'if (!incrementalAnalysis?.coverage.complete)',
      'const structuralGraphParityEvidence',
    );
    const parity = sourceSlice(
      source,
      'const structuralGraphParityEvidence = codeGraphStructuralParityEvidence(',
      'const coldLanguageCounts',
    );

    expectInOrder(analysisParity, [
      'const sameOverlayReferenceAnalysis = yield* analysis.analyze({',
      'databasePath: sameOverlayReferenceLayout.databasePath',
      'snapshot: sameOverlayReference.summary.snapshot',
      'const incrementalStructuralGraphEvidence',
      'const sameOverlayReferenceStructuralGraphEvidence',
    ]);
    expectInOrder(parity, [
      'if (!structuralGraphParityEvidence.parity)',
      '.structural-parity.json',
      'JSON.stringify(structuralGraphParityEvidence',
      'codeGraphStructuralParityFailureMessage(structuralGraphParityEvidence)',
      'const primaryQueryParityEvidence = codeGraphQueryResultParityEvidence(',
      'if (!primaryQueryParityEvidence.parity)',
      '.query-parity.json',
      'JSON.stringify(primaryQueryParityEvidence',
      'codeGraphQueryResultParityFailureMessage(primaryQueryParityEvidence)',
    ]);
  });

  it('accepts explicit retained homes and a validation-only preflight', () => {
    const parsed = parseCodeGraphBenchmarkArguments([
      '--repository',
      '/tmp/public-repository',
      '--incremental-path',
      'src/index.ts',
      '--control',
      CONTROL,
      '--output',
      '/tmp/evidence.json',
      '--home',
      '/tmp/primary-home',
      '--reference-home',
      '/tmp/reference-home',
      '--retain-homes',
      '--minimum-free-gib',
      '140',
      '--preflight',
    ]);

    expect(parsed).toMatchObject({
      homePath: '/tmp/primary-home',
      minimumFreeGiB: 140,
      preflight: true,
      referenceHomePath: '/tmp/reference-home',
      retainHomes: true,
    });
    expect(
      parseCodeGraphBenchmarkArguments([
        '--profile',
        'production-large',
        '--ratchet',
        '/tmp/production-large-ratchet.json',
        '--output',
        '/tmp/production-large.json',
      ]).ratchetPath,
    ).toBe('/tmp/production-large-ratchet.json');
    expect(() => parseCodeGraphBenchmarkArguments(['--preflight', '--ratchet', '/tmp/ratchet.json'])).toThrow(
      'cannot be combined with --preflight',
    );
    expect(() => parseCodeGraphBenchmarkArguments(['--ratchet', '/tmp/ratchet.json'])).toThrow('requires --output');
    expect(() =>
      parseCodeGraphBenchmarkArguments(['--profile', 'production-large', '--minimum-free-gib', '119']),
    ).toThrow('at least 120');
    expect(
      parseCodeGraphBenchmarkArguments([
        '--profile',
        'production-large',
        '--profile-files',
        '3000',
        '--profile-symbols',
        '110000',
        '--minimum-free-gib',
        '20',
      ]).minimumFreeGiB,
    ).toBe(20);
    expect(() =>
      parseCodeGraphBenchmarkArguments([
        '--profile',
        'production-large',
        '--profile-files',
        '3000',
        '--profile-symbols',
        '110000',
        '--minimum-free-gib',
        '19',
      ]),
    ).toThrow('at least 20');
    for (const partialOrOversizedProfile of [
      ['--profile-files', '3000'],
      ['--profile-symbols', '110000'],
      ['--profile-files', '3001', '--profile-symbols', '110000'],
      ['--profile-files', '3000', '--profile-symbols', '110001'],
      ['--profile-files', '3000', '--profile-symbols', '110000', '--vectors'],
    ]) {
      expect(() =>
        parseCodeGraphBenchmarkArguments([
          '--profile',
          'production-large',
          ...partialOrOversizedProfile,
          '--minimum-free-gib',
          '20',
        ]),
      ).toThrow('at least 120');
    }
  });

  it('selects explicit SQLite writer candidates without exposing production environment knobs', () => {
    for (const profile of EffectRecord.keys(CODE_GRAPH_SQLITE_WRITER_PROFILES)) {
      expect(parseCodeGraphBenchmarkArguments(['--sqlite-writer-profile', profile]).sqliteWriterProfile).toBe(profile);
    }
    expect(() => parseCodeGraphBenchmarkArguments(['--sqlite-writer-profile', 'unknown'])).toThrow(
      'Unknown SQLite writer benchmark profile',
    );
    expect(() =>
      parseCodeGraphBenchmarkArguments(['--sqlite-writer-profile', 'cache-256m', '--fail-on-budget']),
    ).toThrow('cannot use production budgets');
    expect(
      parseCodeGraphBenchmarkArguments(['--materialization-transaction-batches', '1'])
        .materializationTransactionBatchLimit,
    ).toBe(1);
    expect(
      parseCodeGraphBenchmarkArguments(['--materialization-transaction-batches', '4'])
        .materializationTransactionBatchLimit,
    ).toBe(4);
    expect(() => parseCodeGraphBenchmarkArguments(['--materialization-transaction-batches', '2'])).toThrow(
      'must be 1 or 4',
    );
  });

  it('governs both generated production homes before preparing the measured runtime', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    expect(
      Effect2.pipe(
        source,
        EffectString.match(/const sameOverlayReferenceHome/g),
        Effect2.Option.getOrElse(() => null),
      ),
    ).toHaveLength(1);
    expectInOrder(source, [
      'const sameOverlayReferenceHome',
      'productionBenchmarkGovernance(',
      "runCheckpoint?.mark('preparing-runtime')",
    ]);
  });

  it('checkpoints post-build analysis and structural parity independently of the long index phases', () => {
    const source = readFileSync('scripts/benchmark-code-graph.ts', 'utf8');
    expectInOrder(source, [
      "runCheckpoint?.mark('same-overlay-reference-index')",
      "runCheckpoint?.mark('post-build-analysis')",
      "runCheckpoint?.mark('structural-parity')",
      "runCheckpoint?.mark('concurrent-worktree-control')",
      "runCheckpoint?.mark('finalizing-artifact')",
    ]);
  });

  it('keeps isolated SQLite writer candidates on the production page-cache and WAL baseline', () => {
    const profiles = CODE_GRAPH_SQLITE_WRITER_PROFILES;

    expect(profiles.current.tuning).toEqual({mainCacheKiB: 32 * 1_024, walAutoCheckpointPages: 500});
    for (const cacheMiB of [8, 32, 64, 128, 256] as const) {
      expect(profiles[`cache-${cacheMiB}m`].tuning).toEqual({
        mainCacheKiB: cacheMiB * 1_024,
        walAutoCheckpointPages: 500,
      });
    }
    expect(profiles['mmap-256m'].tuning).toEqual({
      mainCacheKiB: 32 * 1_024,
      mmapSizeBytes: 256 * 1_024 * 1_024,
      walAutoCheckpointPages: 500,
    });
    expect(profiles['wal-checkpoint-8192'].tuning).toEqual({
      mainCacheKiB: 32 * 1_024,
      walAutoCheckpointPages: 8_192,
    });
    expect(profiles['building-normal-full-publication'].tuning).toEqual({
      mainCacheKiB: 32 * 1_024,
      reconstructibleBuildSynchronous: 'normal',
      walAutoCheckpointPages: 500,
    });
  });

  it('accepts only forced-no-reuse 10k embedding-context candidates', () => {
    for (const embeddingContexts of [1, 2, 4, 8] as const) {
      expect(
        parseCodeGraphBenchmarkArguments([
          '--vectors',
          '--scale-symbols',
          '10000',
          '--embedding-contexts',
          String(embeddingContexts),
        ]).embeddingContexts,
      ).toBe(embeddingContexts);
    }
    expect(() =>
      parseCodeGraphBenchmarkArguments(['--vectors', '--scale-symbols', '10000', '--embedding-contexts', '3']),
    ).toThrow('must be 1, 2, 4, or 8');
    expect(() => parseCodeGraphBenchmarkArguments(['--embedding-contexts', '4'])).toThrow(
      'requires --vectors --scale-symbols 10000',
    );
    expect(() =>
      parseCodeGraphBenchmarkArguments([
        '--vectors',
        '--scale-symbols',
        '10000',
        '--embedding-contexts',
        '4',
        '--fail-on-budget',
      ]),
    ).toThrow('cannot use production budgets');
    expect(
      parseCodeGraphBenchmarkArguments([
        '--vectors',
        '--scale-symbols',
        '10000',
        '--embedding-contexts',
        '1',
        '--quiet',
      ]).quiet,
    ).toBe(true);
  });

  it('uses a balanced embedding-context order and keeps promotion evidence reviewable', () => {
    const schedule = embeddingContextBenchmarkSchedule(4);
    expect(schedule).toEqual([
      [1, 2, 8, 4],
      [2, 4, 1, 8],
      [4, 8, 2, 1],
      [8, 1, 4, 2],
    ]);
    expect(
      parseEmbeddingContextBenchmarkArguments(['--model-home', '/tmp/models', '--output-dir', '/tmp/evidence']),
    ).toEqual({modelHome: '/tmp/models', outputDirectory: '/tmp/evidence', resume: false, rounds: 4});
    expect(
      parseEmbeddingContextBenchmarkArguments([
        '--model-home',
        '/tmp/models',
        '--output-dir',
        '/tmp/evidence',
        '--resume',
      ]),
    ).toMatchObject({resume: true});
    expect(() =>
      parseEmbeddingContextBenchmarkArguments([
        '--model-home',
        '/tmp/models',
        '--output-dir',
        '/tmp/evidence',
        '--rounds',
        '0',
      ]),
    ).toThrow('--rounds must be one of 4, 8, 12, or 16');

    for (const rounds of [4, 8, 12, 16]) {
      const balanced = embeddingContextBenchmarkSchedule(rounds);
      for (const contexts of [1, 2, 4, 8] as const) {
        expect(EffectArray.filter(balanced.flat(), candidate => candidate === contexts)).toHaveLength(rounds);
        for (let position = 0; position < 4; position += 1) {
          expect(EffectArray.filter(balanced, order => order[position] === contexts)).toHaveLength(rounds / 4);
        }
      }
    }

    const vectorMilliseconds = {1: 100, 2: 75, 4: 50, 8: 65} as const;
    const artifacts = EffectArray.flatMap(schedule, (order, round) =>
      EffectArray.map(order, (contexts, position) => ({
        artifact: embeddingContextArtifact(
          contexts,
          vectorMilliseconds[contexts] + round,
          contexts === 4 ? 1_100 : 1_000,
        ),
        artifactPath: `/evidence/round-${round + 1}-position-${position + 1}.json`,
      })),
    );
    const summary = summarizeEmbeddingContextArtifacts(artifacts, schedule);
    expect(summary.promotion).toMatchObject({
      candidate: 4,
      eligibleForReviewedDefaultChange: true,
      roundWinsAgainstOne: 4,
    });
    expect(summary.contexts['4']?.observations).toBe(4);
  });

  effectIt.effect('gives equivalent generated benchmark fixtures the same commit identity', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* prepareGeneratedCodeGraphFixture(10, true);
        const second = yield* prepareGeneratedCodeGraphFixture(10, true);
        const firstDependencySurface = yield* prepareGeneratedCodeGraphFixture(10, false, false, true);
        const secondDependencySurface = yield* prepareGeneratedCodeGraphFixture(10, false, false, true);
        const firstCommit = Effect2.pipe(
          (yield* git(first.repository, ['rev-parse', 'HEAD'])).stdout,
          EffectString.trim,
        );
        const secondCommit = Effect2.pipe(
          (yield* git(second.repository, ['rev-parse', 'HEAD'])).stdout,
          EffectString.trim,
        );
        const firstDependencySurfaceCommit = Effect2.pipe(
          (yield* git(firstDependencySurface.repository, ['rev-parse', 'HEAD'])).stdout,
          EffectString.trim,
        );
        const secondDependencySurfaceCommit = Effect2.pipe(
          (yield* git(secondDependencySurface.repository, ['rev-parse', 'HEAD'])).stdout,
          EffectString.trim,
        );
        expect(firstCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(secondCommit).toBe(firstCommit);
        expect(firstDependencySurface.incrementalSourcePath).toBe('packages/surface-core/src/index.ts');
        expect(secondDependencySurface.incrementalSourcePath).toBe(firstDependencySurface.incrementalSourcePath);
        expect(firstDependencySurfaceCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(secondDependencySurfaceCommit).toBe(firstDependencySurfaceCommit);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('rejects dirty, clamped, unsampled, or vector-mismatched embedding evidence', () => {
    const schedule = embeddingContextBenchmarkSchedule(4);
    const artifacts = EffectArray.flatMap(schedule, (order, round) =>
      EffectArray.map(order, (contexts, position) => ({
        artifact: embeddingContextArtifact(contexts, 100 - contexts, 1_000),
        artifactPath: `/evidence/round-${round + 1}-position-${position + 1}.json`,
      })),
    );
    const replace = (index: number, artifact: BenchmarkArtifactV1) =>
      EffectArray.map(artifacts, (item, itemIndex) => (itemIndex === index ? {...item, artifact} : item));
    expect(() =>
      summarizeEmbeddingContextArtifacts(
        replace(0, {...artifacts[0].artifact, environment: {...artifacts[0].artifact.environment, dirty: true}}),
        schedule,
      ),
    ).toThrow('dirty source');
    expect(() =>
      summarizeEmbeddingContextArtifacts(
        replace(1, {
          ...artifacts[1].artifact,
          metadata: {...artifacts[1].artifact.metadata, embeddingContextPoolSizeEffective: 1},
        }),
        schedule,
      ),
    ).toThrow('wrong context capacity');
    expect(() =>
      summarizeEmbeddingContextArtifacts(
        replace(2, {
          ...artifacts[2].artifact,
          metadata: {...artifacts[2].artifact.metadata, coldVectorMappingDigest: 'different'},
        }),
        schedule,
      ),
    ).toThrow('vector mapping digest');
    expect(() =>
      summarizeEmbeddingContextArtifacts(
        replace(3, {
          ...artifacts[3].artifact,
          measurements: EffectArray.map(artifacts[3].artifact.measurements, item =>
            item.name === 'cold-external-process-tree-failures-n1'
              ? benchmarkMeasurement(item.name, 'count', [1])
              : item,
          ),
        }),
        schedule,
      ),
    ).toThrow('lost process-tree samples');
    expect(() =>
      summarizeEmbeddingContextArtifacts(
        replace(1, {
          ...artifacts[1].artifact,
          metadata: {...artifacts[1].artifact.metadata, embeddingContextThreadCounts: '8'},
        }),
        schedule,
      ),
    ).toThrow('invalid CPU-thread partition');
    expect(() =>
      summarizeEmbeddingContextArtifacts(
        replace(1, {
          ...artifacts[1].artifact,
          metadata: {
            ...artifacts[1].artifact.metadata,
            environmentOverrides: JSON.stringify({
              THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '2',
              THREADNOTE_EMBEDDING_CONTEXTS: '2',
            }),
          },
        }),
        schedule,
      ),
    ).toThrow('non-embedding environment overrides');
  });

  it('requires effective PRAGMA readback and FULL-after-NORMAL publication ordering', () => {
    const connection = (benchmarkPhase: 'cold' | 'one-file-reindex' | 'same-overlay-reference') => ({
      benchmarkPhase,
      cacheSizePragma: -(32 * 1_024),
      journalMode: 'wal',
      mmapSizeBytes: 0,
      phase: 'connection' as const,
      synchronous: 2,
      walAutoCheckpointPages: 500,
    });
    const evidence = [
      connection('cold'),
      {...connection('cold'), phase: 'building' as const, synchronous: 1},
      {...connection('cold'), phase: 'publication' as const},
      connection('one-file-reindex'),
      connection('same-overlay-reference'),
      {...connection('same-overlay-reference'), phase: 'building' as const, synchronous: 1},
      {...connection('same-overlay-reference'), phase: 'publication' as const},
    ];

    expect(() => validateSqliteWriterSettingsEvidence('building-normal-full-publication', evidence)).not.toThrow();
    expect(() =>
      validateSqliteWriterSettingsEvidence(
        'building-normal-full-publication',
        EffectArray.filter(evidence, settings => settings.phase !== 'publication'),
      ),
    ).toThrow('did not restore FULL after NORMAL');
    expect(() =>
      validateSqliteWriterSettingsEvidence('current', [
        ...EffectArray.map(
          EffectArray.filter(evidence, settings => settings.phase === 'connection').slice(0, 2),
          settings => ({...settings, cacheSizePragma: -(32 * 1_024)}),
        ),
        {
          ...connection('same-overlay-reference'),
          cacheSizePragma: -(32 * 1_024),
          walAutoCheckpointPages: 8_192,
        },
      ]),
    ).toThrow('did not apply its WAL checkpoint cadence');
  });

  it('rejects retention without two explicit fresh home paths', () => {
    expect(() =>
      parseCodeGraphBenchmarkArguments([
        '--repository',
        '/tmp/public-repository',
        '--incremental-path',
        'src/index.ts',
        '--control',
        CONTROL,
        '--output',
        '/tmp/evidence.json',
        '--retain-homes',
      ]),
    ).toThrow('--retain-homes requires explicit --home and --reference-home paths');
  });

  it.each([
    ['source.ts', "import 'threadnote-benchmark-overlay';"],
    ['source.cjs', "require('threadnote-benchmark-overlay');"],
    ['Source.java', 'import threadnote.benchmark.Overlay;'],
    ['source.kt', 'import threadnote.benchmark.overlay'],
    ['source.swift', 'import ThreadnoteBenchmarkOverlay'],
    ['source.go', 'import _ "threadnote/benchmark/overlay"'],
    ['source.rs', 'use threadnote_benchmark_overlay as _;'],
    ['source.cpp', '#include <threadnote_benchmark_overlay.h>'],
    ['source.py', '__import__("threadnote_benchmark_overlay")'],
    ['BUILD.bazel', 'load("@threadnote_benchmark_overlay//:defs.bzl", "threadnote_benchmark_overlay")'],
    ['MODULE.bazel', 'load("@threadnote_benchmark_overlay//:defs.bzl", "threadnote_benchmark_overlay")'],
    ['rules.bzl', 'load("@threadnote_benchmark_overlay//:defs.bzl", "threadnote_benchmark_overlay")'],
  ])('adds a structural dependency to %s without declaring a benchmark symbol', (path, dependency) => {
    const overlaid = semanticBenchmarkOverlay(path, 'original');
    expect(overlaid).toContain(dependency);
    expect(overlaid).not.toContain('threadnoteBenchmarkOverlaySymbol');
    expect(overlaid).toContain('original');
  });

  it('preserves CRLF and inserts Java imports after the package declaration', () => {
    const overlaid = semanticBenchmarkOverlay('Source.java', 'package example;\r\n\r\nfinal class Source {}\r\n');
    expect(overlaid).toBe('package example;\r\nimport threadnote.benchmark.Overlay;\r\n\r\nfinal class Source {}\r\n');
    expect(Effect2.pipe(overlaid, EffectString.replaceAll('\r\n', ''))).not.toContain('\n');
  });

  it('rejects unsupported benchmark platforms before external evidence work starts', () => {
    expect(externalBenchmarkPlatformSupported('darwin')).toBe(true);
    expect(externalBenchmarkPlatformSupported('linux')).toBe(true);
    expect(externalBenchmarkPlatformSupported('win32')).toBe(false);
    expect(externalBenchmarkPlatformSupported('freebsd')).toBe(false);
  });

  it('redacts path-valued and semantic runner metadata while normalizing bounded controls', () => {
    const provenance = sanitizedBenchmarkEnvironmentProvenance({
      SQLITE_TMPDIR: '/private/customer/repository/sqlite-temp',
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'denyskashkovskyi-macbook',
      THREADNOTE_BENCHMARK_RUNNER_ID: 'denyskashkovskyi-macbook',
      THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS: '99999999',
      THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS: '2500',
      THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '99',
      THREADNOTE_EMBEDDING_CONTEXTS: '4',
    });

    expect(provenance).toMatchObject({
      SQLITE_TMPDIR: 'configured-path-redacted',
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'other',
      THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS: '3600000',
      THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS: '2500',
      THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '8',
      THREADNOTE_EMBEDDING_CONTEXTS: '4',
    });
    expect(provenance.THREADNOTE_BENCHMARK_RUNNER_ID).toMatch(/^runner-[0-9a-f]{16}$/);
    expect(JSON.stringify(provenance)).not.toContain('denyskashkovskyi');
    expect(JSON.stringify(provenance)).not.toContain('/Users/private');
    expect(JSON.stringify(provenance)).not.toContain('/private/customer');
  });

  it('omits invalid embedding-context overrides from benchmark provenance', () => {
    expect(
      sanitizedBenchmarkEnvironmentProvenance({
        THREADNOTE_EMBEDDING_CONTEXTS: '16',
      }),
    ).not.toHaveProperty('THREADNOTE_EMBEDDING_CONTEXTS');
  });

  it('projects only coarse hosted runner classes and always pseudonymizes explicit runner ids', () => {
    expect(
      sanitizedBenchmarkEnvironmentProvenance({
        THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-ubuntu-24.04-X64',
        THREADNOTE_BENCHMARK_RUNNER_ID: 'safe-looking-hostname',
      }),
    ).toMatchObject({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-linux-x64',
      THREADNOTE_BENCHMARK_RUNNER_ID: expect.stringMatching(/^runner-[0-9a-f]{16}$/),
    });
    expect(
      sanitizedBenchmarkEnvironmentProvenance({
        THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-macos-15-ARM64',
        THREADNOTE_BENCHMARK_RUNNER_ID: 'macos-arm64-runner',
      }),
    ).toMatchObject({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-macos-arm64',
      THREADNOTE_BENCHMARK_RUNNER_ID: expect.stringMatching(/^runner-[0-9a-f]{16}$/),
    });
    expect(
      sanitizedBenchmarkEnvironmentProvenance({
        THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-windows-latest-X64',
        THREADNOTE_BENCHMARK_RUNNER_ID: 'windows-x64-runner',
      }),
    ).toMatchObject({
      THREADNOTE_BENCHMARK_RUNNER_CLASS: 'github-hosted-windows-x64',
      THREADNOTE_BENCHMARK_RUNNER_ID: expect.stringMatching(/^runner-[0-9a-f]{16}$/),
    });
  });

  effectIt.effect('applies and restores the overlay byte-for-byte while preserving concurrent edits', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-benchmark-overlay-test-'});
          const file = path.join(root, 'source.ts');
          const original = new TextEncoder().encode('\uFEFFexport const source = 1;\r\n');
          const overlay = new TextEncoder().encode(
            semanticBenchmarkOverlay('source.ts', decodeBenchmarkSource(original)),
          );
          const concurrent = new TextEncoder().encode('export const userEdit = true;\n');

          yield* fs.writeFile(file, original);
          yield* applyBenchmarkOverlay(fs, file, original, overlay);
          const applied = yield* fs.readFile(file);
          yield* restoreBenchmarkOverlay(fs, file, overlay, original);
          const restored = yield* fs.readFile(file);

          yield* fs.writeFile(file, concurrent);
          const applyConflict = yield* Effect.exit(applyBenchmarkOverlay(fs, file, original, overlay));
          const afterApplyConflict = yield* fs.readFile(file);

          yield* fs.writeFile(file, original);
          yield* applyBenchmarkOverlay(fs, file, original, overlay);
          yield* fs.writeFile(file, concurrent);
          const restoreConflict = yield* Effect.exit(restoreBenchmarkOverlay(fs, file, overlay, original));
          const afterRestoreConflict = yield* fs.readFile(file);

          return {
            afterApplyConflict,
            afterRestoreConflict,
            applied,
            applyConflict: applyConflict._tag,
            restored,
            restoreConflict: restoreConflict._tag,
          };
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect([...result.applied]).toEqual([
        ...new TextEncoder().encode("\uFEFFimport 'threadnote-benchmark-overlay';\r\nexport const source = 1;\r\n"),
      ]);
      expect([...result.restored]).toEqual([...new TextEncoder().encode('\uFEFFexport const source = 1;\r\n')]);
      expect(result.applyConflict).toBe('Failure');
      expect(result.restoreConflict).toBe('Failure');
      expect([...result.afterApplyConflict]).toEqual([...new TextEncoder().encode('export const userEdit = true;\n')]);
      expect([...result.afterRestoreConflict]).toEqual([
        ...new TextEncoder().encode('export const userEdit = true;\n'),
      ]);
    }),
  );

  it('rejects non-UTF-8 overlay sources without lossy replacement', () => {
    expect(() => decodeBenchmarkSource(Uint8Array.from([0xc3, 0x28]))).toThrow('valid UTF-8');
  });

  it('rejects non-source incremental overlays', () => {
    expect(() => semanticBenchmarkOverlay('fixtures/data.json', '{}')).toThrow(
      'incremental benchmark path must use a supported source language',
    );
  });

  it('retains changed-file symbol lookups while invalidating changed-file aliases', () => {
    const rows = structuralDigestLookupRows({
      base: [
        lookupRow('alias-changed', 'alias-changed', 'alias', 'src/index.ts'),
        lookupRow('alias-null', 'alias-null', 'alias'),
        lookupRow('alias-unchanged', 'alias-unchanged', 'alias', 'src/other.ts'),
        lookupRow('deleted-symbol', 'deleted-symbol', 'symbol', 'src/index.ts'),
        lookupRow('overridden', 'overridden', 'symbol', 'src/index.ts'),
        lookupRow('symbol-changed', 'symbol-changed', 'symbol', 'src/index.ts'),
      ],
      changedPaths: ['src/index.ts'],
      current: [lookupRow('overridden', 'overridden', 'alias', 'src/current.ts')],
      deletedSymbolIds: ['deleted-symbol'],
    });

    expect(rows).toEqual([
      lookupRow('alias-null', 'alias-null', 'alias'),
      lookupRow('alias-unchanged', 'alias-unchanged', 'alias', 'src/other.ts'),
      lookupRow('overridden', 'overridden', 'alias', 'src/current.ts'),
      lookupRow('symbol-changed', 'symbol-changed', 'symbol', 'src/index.ts'),
    ]);
  });

  it('matches the persisted-delta lookup model for randomized changed paths and overrides', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(lookupRowArbitrary, {selector: row => `${row.lookup_key}\0${row.symbol_id}`}),
        fc.uniqueArray(lookupRowArbitrary, {selector: row => `${row.lookup_key}\0${row.symbol_id}`}),
        fc.uniqueArray(fc.constantFrom(...LOOKUP_PATHS)),
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/)),
        (base, current, changedPaths, deletedSymbolIds) => {
          const actual = structuralDigestLookupRows({base, changedPaths, current, deletedSymbolIds});
          const currentKeys = new Set(EffectArray.map(current, row => `${row.lookup_key}\0${row.symbol_id}`));
          const deleted = new Set(deletedSymbolIds);
          const changed = new Set(changedPaths);
          const expected = [
            ...current,
            ...EffectArray.filter(
              base,
              row =>
                !currentKeys.has(`${row.lookup_key}\0${row.symbol_id}`) &&
                !deleted.has(row.symbol_id) &&
                (row.provenance === 'symbol' || row.evidence_path === undefined || !changed.has(row.evidence_path)),
            ),
          ].sort(compareLookupRows);
          expect(actual).toEqual(expected);
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('holds a real snapshot lease and one WAL read snapshot across promotion and cleanup', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-structural-digest-interlock-'});
          const databasePath = path.join(root, 'graph-v3.sqlite');
          const identity: RepositoryIdentity = {
            caseMode: 'sensitive',
            checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
            displayName: 'structural-digest-fixture',
            gitCommonDirectory: root,
            headCommit: Effect2.pipe('1', EffectString.repeat(40)),
            objectFormat: 'sha1',
            repoRoot: root,
            repositoryId: Effect2.pipe('r', EffectString.repeat(64)),
            worktreeId: Effect2.pipe('w', EffectString.repeat(64)),
          };
          const baseSnapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
          const firstSnapshotId = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
          const replacementSnapshotId = `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`;
          const privatePath = 'src/private-customer-secret.ts';

          yield* store.initialize(databasePath);
          seedStructuralDigestInterlockDatabase(
            databasePath,
            identity,
            baseSnapshotId,
            firstSnapshotId,
            replacementSnapshotId,
            privatePath,
          );
          yield* store.promote(databasePath, identity, firstSnapshotId);
          const before = yield* sqliteStructuralGraphEvidence(databasePath, firstSnapshotId);
          const replacementWriter = new Database(databasePath, {strict: true});
          try {
            replacementWriter
              .query("UPDATE snapshots SET state = 'ready' WHERE id = ? AND state = 'building'")
              .run(replacementSnapshotId);
          } finally {
            replacementWriter.close(false);
          }
          let during = {
            activeSnapshotId: '',
            baseFileRows: 0,
            baseState: '',
            firstState: '',
            leaseRows: 0,
          };
          let leaseRenewals = 0;
          const pruneRetiredSnapshots = () =>
            store.pruneRetiredSnapshots(databasePath).pipe(
              Effect.retry({
                schedule: Schedule.spaced(25),
                times: 20,
                while: error => Schema.is(CodeGraphStoreBusyError)(error),
              }),
            );
          const pinned = yield* sqliteStructuralGraphEvidence(databasePath, firstSnapshotId, {
            onReadTransactionStarted: Effect.gen(function* () {
              yield* store.promote(databasePath, identity, replacementSnapshotId);
              yield* pruneRetiredSnapshots();
              // Superseded clean snapshots remain warm after lease release, so
              // the post-write parity check can read this generation directly.
              const writer = new Database(databasePath, {strict: true});
              try {
                writer.run('PRAGMA busy_timeout = 5000');
                writer
                  .query('UPDATE snapshots SET commit_id = ? WHERE id = ?')
                  .run(Effect2.pipe('3', EffectString.repeat(40)), firstSnapshotId);
                during = structuralDigestInterlockState(writer, baseSnapshotId, firstSnapshotId, identity.worktreeId);
              } finally {
                writer.close(false);
              }
              yield* Effect.sleep(125);
            }),
            onSnapshotLeaseRenewed: Effect.sync(() => {
              leaseRenewals += 1;
            }),
            snapshotLeaseRenewalMilliseconds: 100,
          });
          const after = yield* sqliteStructuralGraphEvidence(databasePath, firstSnapshotId);
          const mismatch = codeGraphStructuralParityEvidence(before, after);
          const failureMessage = codeGraphStructuralParityFailureMessage(mismatch);
          yield* pruneRetiredSnapshots();
          const finalDatabase = new Database(databasePath, {readonly: true, strict: true});
          try {
            const protectedSnapshotRows = Number(
              requiredRow(
                finalDatabase
                  .query<{readonly count: number}, SQLQueryBindings[]>(
                    'SELECT COUNT(*) AS count FROM snapshots WHERE id IN (?, ?)',
                  )
                  .get(baseSnapshotId, firstSnapshotId),
              ).count,
            );
            const leaseRows = Number(
              requiredRow(
                finalDatabase
                  .query<{readonly count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM snapshot_leases')
                  .get(),
              ).count,
            );
            return {
              after,
              before,
              during,
              failureMessage,
              leaseRows,
              mismatch,
              leaseRenewals,
              pinned,
              privacySafeEvidence: JSON.stringify(mismatch),
              privatePath,
              protectedSnapshotRows,
            };
          } finally {
            finalDatabase.close(false);
          }
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.pinned).toEqual(result.before);
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(result.before.streams, stream => stream.name === 'symbol-terms'),
        )?.rowCount,
      ).toBe(1);
      expect(result.after.digest).not.toBe(result.before.digest);
      expect(result.during).toEqual({
        activeSnapshotId: `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`,
        baseFileRows: 1,
        baseState: 'ready',
        firstState: 'ready',
        leaseRows: 1,
      });
      expect(EffectArray.map(result.mismatch.mismatchedStreams, stream => stream.name)).toEqual(['snapshot']);
      expect(result.leaseRenewals).toBeGreaterThanOrEqual(1);
      expect(result.failureMessage).toMatch(
        /^Structural graph digest parity failed: snapshot incremental\(count=1,sha256=[0-9a-f]{64}\) same-overlay-full\(count=1,sha256=[0-9a-f]{64}\)\.$/,
      );
      expect(result.privacySafeEvidence).not.toContain(result.privatePath);
      expect(result.privacySafeEvidence).not.toContain(Effect2.pipe('3', EffectString.repeat(40)));
      expect(result.failureMessage).not.toContain(result.privatePath);
      // Clean displaced snapshots remain warm after their last reader exits;
      // retaining the overlay also retains its physical base.
      expect(result.protectedSnapshotRows).toBe(2);
      expect(result.leaseRows).toBe(0);
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('keeps structural graph evidence independent of optional analysis summaries', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-structural-digest-summary-'});
          const databasePath = path.join(root, 'graph-v3.sqlite');
          const identity: RepositoryIdentity = {
            caseMode: 'sensitive',
            checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
            displayName: 'structural-digest-summary-fixture',
            gitCommonDirectory: root,
            headCommit: Effect2.pipe('1', EffectString.repeat(40)),
            objectFormat: 'sha1',
            repoRoot: root,
            repositoryId: Effect2.pipe('r', EffectString.repeat(64)),
            worktreeId: Effect2.pipe('w', EffectString.repeat(64)),
          };
          const baseSnapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
          const snapshotId = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
          const replacementSnapshotId = `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`;

          yield* store.initialize(databasePath);
          seedStructuralDigestInterlockDatabase(
            databasePath,
            identity,
            baseSnapshotId,
            snapshotId,
            replacementSnapshotId,
            'src/index.ts',
          );
          const withoutSummary = yield* sqliteStructuralGraphEvidence(databasePath, snapshotId);
          const writer = new Database(databasePath, {strict: true});
          try {
            const now = DateTime.formatIso(yield* DateTime.now);
            writer
              .query(
                `INSERT INTO snapshot_analysis_symbol_counts (snapshot_id, language, kind, count)
                 VALUES (?, 'typescript', 'function', 1)`,
              )
              .run(snapshotId);
            writer
              .query(
                `INSERT INTO snapshot_analysis_edge_histogram (
                   snapshot_id, provenance, relation, confidence, endpoint_state, count
                 ) VALUES (?, 'resolved', 'calls', 1, 0, 1)`,
              )
              .run(snapshotId);
            writer
              .query(
                `INSERT INTO snapshot_analysis_edge_counts (
                   snapshot_id, provenance, relation, count, confidence_invalid, confidence_total,
                   lowest_confidence, confidence_high, confidence_medium, confidence_low,
                   unresolved_endpoint_count, self_loop_count, review_finding_count
                 ) VALUES (?, 'resolved', 'calls', 1, 0, 1, 1, 1, 0, 0, 0, 0, 0)`,
              )
              .run(snapshotId);
            writer
              .query(
                `INSERT INTO snapshot_analysis_summary_receipts (
                   snapshot_id, version, symbol_count, edge_count, digest, created_at
                 ) VALUES (?, 1, 1, 1, ?, ?)`,
              )
              .run(snapshotId, Effect2.pipe('d', EffectString.repeat(64)), now);
          } finally {
            writer.close(false);
          }
          const withSummary = yield* sqliteStructuralGraphEvidence(databasePath, snapshotId);
          return {withSummary, withoutSummary};
        }),
      ).pipe(provideTestLayer(ApplicationLayer));

      expect(result.withSummary).toEqual(result.withoutSummary);
    }).pipe(TestClock.withLive),
  );
});

function benchmarkQueryResult(
  nodeIds: readonly string[],
  edgeIds: readonly string[],
  warnings: readonly string[] = [],
  firstScore = 1,
): CodeGraphQueryResult {
  return {
    edges: EffectArray.map(edgeIds, id => ({
      confidence: 1,
      evidencePath: 'private/evidence.ts',
      evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
      id,
      provenance: 'resolved',
      relation: 'calls',
      sourceName: 'source',
      targetName: 'target',
    })),
    freshness: 'current',
    nodes: EffectArray.map(nodeIds, id => ({
      contentHash: `private-content-${id}`,
      exported: true,
      id,
      kind: 'function',
      language: 'typescript',
      name: id,
      path: `private/${id}.ts`,
      qualifiedName: id,
      score: firstScore,
      span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    })),
    operation: 'query',
    repository: {displayName: 'private-repository', repositoryId: 'private-repository-id'},
    snapshot: {
      commit: Effect2.pipe('1', EffectString.repeat(40)),
      dirty: true,
      id: 'private-snapshot',
      worktreeId: 'private-worktree',
    },
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    version: 1,
    warnings,
  };
}

describe('code graph benchmark query parity diagnostics', () => {
  it('separates ordering, score, payload, membership, and elapsed-time failures', () => {
    const baseline = benchmarkQueryResult(['private-node-a', 'private-node-b'], ['private-edge-a']);
    const reordered = benchmarkQueryResult(['private-node-b', 'private-node-a'], ['private-edge-a']);
    const rescored = benchmarkQueryResult(['private-node-a', 'private-node-b'], ['private-edge-a'], [], 0.25);
    const payloadChanged = {
      ...baseline,
      nodes: EffectArray.map(baseline.nodes, (node, index) =>
        index === 0 ? {...node, name: 'private-renamed-node'} : node,
      ),
    } satisfies CodeGraphQueryResult;
    const missing = benchmarkQueryResult(['private-node-a'], ['private-edge-a']);
    const timedOut = {
      ...missing,
      warnings: ['Graph traversal reached its elapsed-time budget; results are partial.'],
    } satisfies CodeGraphQueryResult;

    expect(codeGraphQueryResultParityEvidence(baseline, baseline).classification).toBe('ordered-match');
    expect(codeGraphQueryResultParityEvidence(baseline, reordered).classification).toBe('ordering-only');
    expect(codeGraphQueryResultParityEvidence(baseline, rescored).classification).toBe('score-only');
    expect(codeGraphQueryResultParityEvidence(baseline, payloadChanged).classification).toBe('payload-drift');
    expect(codeGraphQueryResultParityEvidence(baseline, missing).classification).toBe('membership-drift');
    const elapsedEvidence = codeGraphQueryResultParityEvidence(baseline, timedOut);
    expect(elapsedEvidence.classification).toBe('elapsed-time-partial');
    expect(codeGraphQueryResultParityFailureMessage(elapsedEvidence)).not.toContain('private-node');
    expect(JSON.stringify(elapsedEvidence)).not.toContain('private-node');
  });

  it('keeps canonical parity invariant under bounded node and edge permutations', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), {maxLength: 12, minLength: 1}),
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), {maxLength: 12}),
        fc.nat(),
        (nodeIds, edgeIds, offsetSeed) => {
          const rotate = <A>(values: readonly A[]): readonly A[] => {
            const offset = values.length === 0 ? 0 : offsetSeed % values.length;
            return [...values.slice(offset), ...values.slice(0, offset)];
          };
          const evidence = codeGraphQueryResultParityEvidence(
            benchmarkQueryResult(nodeIds, edgeIds),
            benchmarkQueryResult(rotate(nodeIds), rotate(edgeIds)),
          );
          expect(evidence.incremental.canonicalDigest).toBe(evidence.sameOverlayReference.canonicalDigest);
          expect(evidence.incremental.scorelessCanonicalDigest).toBe(
            evidence.sameOverlayReference.scorelessCanonicalDigest,
          );
          expect(['ordered-match', 'ordering-only']).toContain(evidence.classification);
        },
      ),
      {numRuns: 100},
    );
  });
});

const LOOKUP_PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts'] as const;

interface StructuralLookupRow {
  readonly evidence_edge_id?: string;
  readonly evidence_path?: string;
  readonly exported: number;
  readonly lookup_key: string;
  readonly provenance: 'alias' | 'symbol';
  readonly resolution_domain: string;
  readonly symbol_id: string;
}

const lookupRowArbitrary = fc.record({
  evidence_edge_id: fc.option(fc.stringMatching(/^[a-z]{1,6}$/), {nil: undefined}),
  evidence_path: fc.option(fc.constantFrom(...LOOKUP_PATHS), {nil: undefined}),
  exported: fc.integer({max: 1, min: 0}),
  lookup_key: fc.stringMatching(/^[a-z]{1,6}$/),
  provenance: fc.constantFrom('alias' as const, 'symbol' as const),
  resolution_domain: fc.constantFrom('global', 'typescript'),
  symbol_id: fc.stringMatching(/^[a-z]{1,6}$/),
}) satisfies fc.Arbitrary<StructuralLookupRow>;

function lookupRow(
  lookupKey: string,
  symbolId: string,
  provenance: StructuralLookupRow['provenance'],
  evidencePath?: string,
): StructuralLookupRow {
  return {
    ...(evidencePath === undefined ? {} : {evidence_path: evidencePath}),
    exported: 1,
    lookup_key: lookupKey,
    provenance,
    resolution_domain: 'typescript',
    symbol_id: symbolId,
  };
}

function structuralDigestLookupRows(input: {
  readonly base: readonly StructuralLookupRow[];
  readonly changedPaths: readonly string[];
  readonly current: readonly StructuralLookupRow[];
  readonly deletedSymbolIds: readonly string[];
}): readonly StructuralLookupRow[] {
  const database = new Database(':memory:', {strict: true});
  try {
    database.run(`CREATE TABLE snapshot_symbol_lookup (
      snapshot_id TEXT NOT NULL,
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (snapshot_id, lookup_key, symbol_id)
    ) WITHOUT ROWID`);
    database.run(`CREATE TABLE snapshot_symbol_deletions (
      snapshot_id TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, symbol_id)
    ) WITHOUT ROWID`);
    database.run(`CREATE TABLE snapshot_files (
      snapshot_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID`);
    const insertLookup = database.query(`INSERT INTO snapshot_symbol_lookup (
      snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
      provenance, evidence_edge_id, evidence_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [snapshotId, rows] of [
      ['base', input.base],
      ['current', input.current],
    ] as const) {
      for (const row of rows) {
        insertLookup.run(
          snapshotId,
          row.lookup_key,
          row.symbol_id,
          row.resolution_domain,
          row.exported,
          row.provenance,
          row.evidence_edge_id ?? null,
          row.evidence_path ?? null,
        );
      }
    }
    const insertChanged = database.query('INSERT INTO snapshot_files (snapshot_id, path) VALUES (?, ?)');
    for (const changedPath of input.changedPaths) insertChanged.run('current', changedPath);
    const insertDeleted = database.query(
      'INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id) VALUES (?, ?)',
    );
    for (const symbolId of new Set(input.deletedSymbolIds)) insertDeleted.run('current', symbolId);
    const statement = codeGraphStructuralDigestSymbolLookupStatement('current', 'base');
    return EffectArray.map(
      database.query<StructuralLookupRow, SQLQueryBindings[]>(statement.text).all(...statement.parameters),
      row => ({
        ...(row.evidence_edge_id === null ? {} : {evidence_edge_id: row.evidence_edge_id}),
        ...(row.evidence_path === null ? {} : {evidence_path: row.evidence_path}),
        exported: Number(row.exported),
        lookup_key: row.lookup_key,
        provenance: row.provenance,
        resolution_domain: row.resolution_domain,
        symbol_id: row.symbol_id,
      }),
    );
  } finally {
    database.close(false);
  }
}

function embeddingContextArtifact(
  contexts: 1 | 2 | 4 | 8,
  coldVectorMilliseconds: number,
  coldEmbeddingRssBytes: number,
): BenchmarkArtifactV1 {
  return {
    createdAt: '2026-08-14T00:00:00.000Z',
    environment: {
      architecture: 'arm64',
      commit: Effect2.pipe('a', EffectString.repeat(40)),
      cpu: 'test cpu',
      dirty: false,
      fixtureHash: 'generated-code-graph-vectors-v2:10000',
      memoryBytes: 64 * 1_024 ** 3,
      model: {backend: 'node-llama-cpp', id: 'bge-small-en-v1.5-q8', revision: 'builtin-pinned'},
      node: 'bun/test',
      operatingSystem: 'darwin',
      packageManager: 'bun/test',
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements: [
      benchmarkMeasurement('cold-index', 'milliseconds', [coldVectorMilliseconds + 10]),
      benchmarkMeasurement('cold-vector-index', 'milliseconds', [coldVectorMilliseconds]),
      benchmarkMeasurement('cold-embedding-progress-external-process-cpu-n1', 'milliseconds', [500]),
      benchmarkMeasurement('cold-embedding-progress-external-rss-peak-observed-n1', 'bytes', [coldEmbeddingRssBytes]),
      benchmarkMeasurement('cold-embedding-progress-external-process-samples-n1', 'count', [10]),
      benchmarkMeasurement('cold-external-sampler-version-n1', 'count', [4]),
      benchmarkMeasurement('cold-external-storage-samples-n1', 'count', [10]),
      benchmarkMeasurement('cold-external-process-tree-samples-n1', 'count', [10]),
      benchmarkMeasurement('cold-external-process-tree-attempts-n1', 'count', [10]),
      benchmarkMeasurement('cold-external-process-tree-failures-n1', 'count', [0]),
      benchmarkMeasurement('cold-external-process-tree-maximum-sample-gap-n1', 'milliseconds', [25]),
      benchmarkMeasurement('cold-maximum-progress-heartbeat-gap-n1', 'milliseconds', [25]),
      benchmarkMeasurement('vector-index-disk', 'bytes', [1_000_000]),
      benchmarkMeasurement('vector-rows', 'count', [10_000]),
    ],
    metadata: {
      coldVectorMappingDigest: 'vector-mapping-digest',
      effectiveParserMemoryBytes: 64 * 1_024 ** 3,
      effectiveParserWorkers: 4,
      embeddingContextCpuMathCores: 8,
      embeddingContextPoolSizeEffective: contexts,
      embeddingContextPoolSizeRequested: contexts,
      embeddingContextThreadCounts:
        contexts === 1
          ? 'upstream-default'
          : EffectArray.join(
              Array.from({length: contexts}, () => String(8 / contexts)),
              ',',
            ),
      embeddingModelGpuLayers: 0,
      environmentOverrides: JSON.stringify({THREADNOTE_EMBEDDING_CONTEXTS: String(contexts)}),
      runnerClass: 'test-runner-class',
      runnerIdentity: 'test-runner-identity',
      sameRunnerComparisonKey: 'same-runner',
      scaleSymbols: 10_000,
      structuralGraphDigestCold: 'structural-digest',
      vectorEnabled: true,
      vectorRows: 10_000,
    },
    suite: 'code-graph-vectors-v1',
    version: 1,
    warmups: 0,
  };
}

function compareLookupRows(left: StructuralLookupRow, right: StructuralLookupRow): number {
  return (
    Effect2.pipe(left.lookup_key, EffectString.localeCompare(right.lookup_key)) ||
    Effect2.pipe(left.symbol_id, EffectString.localeCompare(right.symbol_id))
  );
}

function sourceSlice(source: string, from: string, to: string): string {
  const start = Effect2.pipe(
    source,
    EffectString.indexOf(from),
    Effect2.Option.getOrElse(() => -1),
  );
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const end = source.indexOf(to, start + from.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return Effect2.pipe(source, EffectString.slice(start, end));
}

function expectInOrder(source: string, markers: readonly string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    const next = source.indexOf(marker, cursor + 1);
    expect(next, `missing or out-of-order benchmark marker: ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function seedStructuralDigestInterlockDatabase(
  databasePath: string,
  identity: RepositoryIdentity,
  baseSnapshotId: string,
  firstSnapshotId: string,
  replacementSnapshotId: string,
  privatePath: string,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const now = new Date().toISOString();
    database.run('PRAGMA foreign_keys = ON');
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(identity.repositoryId, identity.displayName, identity.objectFormat, now, now);
    const insertSnapshot = database.query(
      `INSERT INTO snapshots (
        id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set, dirty, state,
        file_count, symbol_count, edge_count, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'ready', ?, 0, 0, ?, ?)`,
    );
    insertSnapshot.run(
      baseSnapshotId,
      identity.repositoryId,
      identity.worktreeId,
      identity.headCommit,
      null,
      'benchmark-digest-test',
      1,
      now,
      now,
    );
    insertSnapshot.run(
      firstSnapshotId,
      identity.repositoryId,
      identity.worktreeId,
      identity.headCommit,
      baseSnapshotId,
      'benchmark-digest-test',
      1,
      now,
      now,
    );
    insertSnapshot.run(
      replacementSnapshotId,
      identity.repositoryId,
      identity.worktreeId,
      identity.headCommit,
      null,
      'benchmark-digest-test',
      0,
      now,
      now,
    );
    database.query("UPDATE snapshots SET state = 'building' WHERE id = ?").run(replacementSnapshotId);
    const minimum = requiredRow(
      database
        .query<{readonly generation: number}, SQLQueryBindings[]>(
          "SELECT CAST(value AS INTEGER) AS generation FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
        )
        .get(),
    );
    const insertGeneration = database.query(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    insertGeneration.run(baseSnapshotId, minimum.generation);
    insertGeneration.run(firstSnapshotId, minimum.generation);
    insertGeneration.run(replacementSnapshotId, minimum.generation);
    database
      .query(
        `INSERT INTO snapshot_files (
          snapshot_id, path, content_hash, language, mode, size, source
        ) VALUES (?, ?, ?, 'typescript', '100644', 32, 'commit')`,
      )
      .run(baseSnapshotId, privatePath, Effect2.pipe('f', EffectString.repeat(64)));
    database.query('INSERT INTO lexical_compact_snapshots (snapshot_id) VALUES (?)').run(baseSnapshotId);
    const lexicalSnapshot = requiredRow(
      database
        .query<{readonly snapshot_key: number}, SQLQueryBindings[]>(
          'SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ?',
        )
        .get(baseSnapshotId),
    );
    database
      .query('INSERT INTO lexical_compact_terms (snapshot_key, term) VALUES (?, ?)')
      .run(lexicalSnapshot.snapshot_key, 'private');
    database
      .query('INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id) VALUES (?, ?)')
      .run(lexicalSnapshot.snapshot_key, 'private-symbol');
    const lexicalTerm = requiredRow(
      database
        .query<{readonly term_key: number}, SQLQueryBindings[]>(
          'SELECT term_key FROM lexical_compact_terms WHERE snapshot_key = ?',
        )
        .get(lexicalSnapshot.snapshot_key),
    );
    const lexicalSymbol = requiredRow(
      database
        .query<{readonly symbol_key: number}, SQLQueryBindings[]>(
          'SELECT symbol_key FROM lexical_compact_symbols WHERE snapshot_key = ?',
        )
        .get(lexicalSnapshot.snapshot_key),
    );
    database
      .query(
        `INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
         VALUES (?, ?, ?, ?)`,
      )
      .run(lexicalSnapshot.snapshot_key, lexicalTerm.term_key, lexicalSymbol.symbol_key, 3);
    database
      .query(
        `INSERT INTO lexical_storage_formats (
          snapshot_id, format_version, posting_count, symbol_count, term_count, created_at
        ) VALUES (?, 1, 1, 1, 1, ?)`,
      )
      .run(baseSnapshotId, now);
  } finally {
    database.close(false);
  }
}

function structuralDigestInterlockState(
  database: Database,
  baseSnapshotId: string,
  firstSnapshotId: string,
  worktreeId: string,
): {
  readonly activeSnapshotId: string;
  readonly baseFileRows: number;
  readonly baseState: string;
  readonly firstState: string;
  readonly leaseRows: number;
} {
  const state = requiredRow(
    database
      .query<
        {
          readonly active_snapshot_id: string;
          readonly base_file_rows: number;
          readonly base_state: string;
          readonly first_state: string;
          readonly lease_rows: number;
        },
        SQLQueryBindings[]
      >(
        `SELECT
        (SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?) AS active_snapshot_id,
        (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = ?) AS base_file_rows,
        (SELECT state FROM snapshots WHERE id = ?) AS base_state,
        (SELECT state FROM snapshots WHERE id = ?) AS first_state,
        (SELECT COUNT(*) FROM snapshot_leases WHERE snapshot_id = ?) AS lease_rows`,
      )
      .get(worktreeId, baseSnapshotId, baseSnapshotId, firstSnapshotId, firstSnapshotId),
  );
  return {
    activeSnapshotId: state.active_snapshot_id,
    baseFileRows: Number(state.base_file_rows),
    baseState: state.base_state,
    firstState: state.first_state,
    leaseRows: Number(state.lease_rows),
  };
}

describe('bound benchmark interruption checkpoints', () => {
  const instant = '2026-10-30T12:00:00.000Z';
  const provenance = {
    architecture: 'arm64',
    bunVersion: '1.4.4',
    fixture: 'code-graph-polyglot-v1',
    platform: 'darwin',
    scaleSymbols: 100000,
    sourceCommit: '1111111111111111111111111111111111111111',
    vectors: true,
  } as const;
  const model = {
    id: 'bge-small-en-v1.5-q8',
    sha256: 'f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804',
  };
  const coreMeasurement = {
    fileCount: 1000,
    indexWallMilliseconds: 1234,
    parentProcessCpuMilliseconds: 234,
    snapshotId: 'cgsn_1111111111111111111111111111111111111111',
    symbolCount: 100000,
  };
  const evidence = {
    ...coreMeasurement,
    processTreeCpuMilliseconds: 3456,
    embeddingProcessCpuMilliseconds: 3000,
    vectors: {
      cpuMathCores: 3,
      effectiveContexts: 2,
      modelGpuLayers: 0,
      requestedContexts: 8,
      storedRows: 202006,
      threadCounts: [2, 1],
    },
  };
  const bound = () =>
    advanceCodeGraphBenchmarkRunCheckpoint(
      initialCodeGraphBenchmarkRunCheckpoint(provenance, instant),
      {
        type: 'bind',
        fixtureHash: 'generated-code-graph-vectors-v2:100000',
        model,
      },
      instant,
    );

  it('refuses lost measurements, forged completion, changed provenance and qualifying sidecars', () => {
    const running = advanceCodeGraphBenchmarkRunCheckpoint(bound(), {type: 'mark', phase: 'cold-index'}, instant);
    expect(() =>
      advanceCodeGraphBenchmarkRunCheckpoint(running, {type: 'mark', phase: 'hot-query-and-mutation'}, instant),
    ).toThrow('retain completed index measurements');
    expect(() => advanceCodeGraphBenchmarkRunCheckpoint(running, {type: 'finish', state: 'complete'}, instant)).toThrow(
      'checkpoint',
    );
    expect(() =>
      advanceCodeGraphBenchmarkRunCheckpoint(running, {type: 'bind', fixtureHash: 'changed', model}, instant),
    ).toThrow('before indexing');
    expect(() =>
      parseCodeGraphBenchmarkRunCheckpoint({
        ...running,
        diagnostics: {...running.diagnostics, releaseQualification: true},
      }),
    ).toThrow('checkpoint diagnostics');
    expect(() => parseBenchmarkArtifactV1(running)).toThrow();
    const measured = advanceCodeGraphBenchmarkRunCheckpoint(
      running,
      {
        type: 'measure-index',
        phase: 'cold-index',
        measurement: coreMeasurement,
      },
      instant,
    );
    expect(() =>
      advanceCodeGraphBenchmarkRunCheckpoint(
        measured,
        {
          type: 'complete-index',
          phase: 'cold-index',
          evidence: {...evidence, indexWallMilliseconds: 1235},
        },
        instant,
      ),
    ).toThrow('measurement changed');
    expect(() =>
      parseCodeGraphBenchmarkRunCheckpoint({
        ...bound(),
        diagnostics: {
          ...bound().diagnostics,
          indexes: [
            {phase: 'cold-index', state: 'pending', measurement: coreMeasurement},
            {phase: 'incremental-index', state: 'pending'},
            {phase: 'same-overlay-reference-index', state: 'pending'},
          ],
        },
      }),
    ).toThrow('index evidence');
  });

  it('retains completed evidence monotonically and round trips every bounded cancellation boundary', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 3}), fc.boolean(), fc.nat(1000000), (completed, failed, wall) => {
        let checkpoint = bound();
        for (const phase of BENCHMARK_CHECKPOINT_INDEX_PHASES.slice(0, completed)) {
          checkpoint = advanceCodeGraphBenchmarkRunCheckpoint(checkpoint, {type: 'mark', phase}, instant);
          checkpoint = advanceCodeGraphBenchmarkRunCheckpoint(
            checkpoint,
            {
              type: 'measure-index',
              phase,
              measurement: {...coreMeasurement, indexWallMilliseconds: wall},
            },
            instant,
          );
          checkpoint = advanceCodeGraphBenchmarkRunCheckpoint(
            checkpoint,
            {type: 'complete-index', phase, evidence: {...evidence, indexWallMilliseconds: wall}},
            instant,
          );
        }
        if (completed < 3)
          checkpoint = advanceCodeGraphBenchmarkRunCheckpoint(
            checkpoint,
            {type: 'mark', phase: BENCHMARK_CHECKPOINT_INDEX_PHASES[completed]},
            instant,
          );
        const before = JSON.stringify(checkpoint);
        const state = failed || completed < 3 ? 'failed' : 'complete';
        const final = advanceCodeGraphBenchmarkRunCheckpoint(checkpoint, {type: 'finish', state}, instant);
        expect(JSON.stringify(checkpoint)).toBe(before);
        expect(
          final.diagnostics && EffectArray.filter(final.diagnostics.indexes, item => item.state === 'complete'),
        ).toHaveLength(completed);
        expect(parseCodeGraphBenchmarkRunCheckpoint(JSON.parse(JSON.stringify(final)))).toEqual(final);
        expect(advanceCodeGraphBenchmarkRunCheckpoint(final, {type: 'finish', state}, instant)).toEqual(final);
        expect(() =>
          advanceCodeGraphBenchmarkRunCheckpoint(final, {type: 'mark', phase: 'cold-index'}, instant),
        ).toThrow('terminal');
        expect(() => parseBenchmarkArtifactV1(final)).toThrow();
      }),
      {numRuns: 40},
    );
  });

  for (const fault of ['retention-interruption', 'storage-failure', 'sampler-stop-failure'] as const) {
    effectIt.effect(`retains core measurements across ${fault} after successful indexing`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-checkpoint-boundary-'});
        const output = path.join(root, 'capture.json.run.json');
        const retaining = yield* Deferred.make<void>();
        const releaseRetention = yield* Deferred.make<void>();
        const program = Effect.gen(function* () {
          const checkpoint = yield* Effect.acquireRelease(makeBenchmarkRunCheckpoint(output, provenance), value =>
            value.finish('failed'),
          );
          yield* checkpoint.bind('generated-code-graph-vectors-v2:100000', model);
          yield* checkpoint.mark('cold-index');
          yield* measureSampledBenchmarkIndex(
            fault === 'sampler-stop-failure'
              ? Effect.succeed({
                  mark: () => Effect.void,
                  stop: () => Effect.fail(TestError.make({message: 'sampler stop failed'})),
                })
              : succeedUndefined,
            () =>
              TestClock.adjust(7).pipe(
                Effect.as({snapshot: {id: evidence.snapshotId, fileCount: 1000, symbolCount: 100000}}),
              ),
            fault === 'storage-failure'
              ? Effect.fail(TestError.make({message: 'storage observation failed'}))
              : Effect.void,
            undefined,
            measured =>
              Effect.gen(function* () {
                const core = benchmarkIndexCheckpointMeasurement(measured);
                const cpuBeforeRetention = core.parentProcessCpuMilliseconds;
                yield* Deferred.succeed(retaining, undefined);
                if (fault === 'retention-interruption') yield* Deferred.await(releaseRetention);
                yield* TestClock.adjust(50);
                yield* checkpoint.measureIndex('cold-index', core);
                expect(benchmarkIndexCheckpointMeasurement(measured)).toEqual(core);
                expect(core.indexWallMilliseconds).toBe(7);
                expect(core.parentProcessCpuMilliseconds).toBe(cpuBeforeRetention);
              }),
          );
        }).pipe(Effect.scoped);
        if (fault === 'retention-interruption') {
          const fiber = yield* program.pipe(Effect.forkChild);
          yield* Deferred.await(retaining);
          const interrupting = yield* Deferred.make<void>();
          const interrupter = yield* Deferred.succeed(interrupting, undefined).pipe(
            Effect.andThen(Fiber.interrupt(fiber)),
            Effect.forkChild,
          );
          yield* Deferred.await(interrupting);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(releaseRetention, undefined);
          yield* Fiber.join(interrupter);
        } else {
          expect((yield* Effect.exit(program))._tag).toBe('Failure');
        }
        const retained = parseCodeGraphBenchmarkRunCheckpoint(JSON.parse(yield* fs.readFileString(output)));
        expect(retained).toMatchObject({
          state: 'failed',
          phase: 'cold-index',
          diagnostics: {
            provenance: {...provenance, model},
            indexes: [
              {
                state: 'incomplete',
                measurement: {
                  snapshotId: evidence.snapshotId,
                  fileCount: 1000,
                  symbolCount: 100000,
                  indexWallMilliseconds: 7,
                },
              },
              {state: 'pending'},
              {state: 'pending'},
            ],
          },
        });
        expect(retained.diagnostics?.indexes[0].evidence).toBeUndefined();
        expect(() => parseBenchmarkArtifactV1(retained)).toThrow();
      }).pipe(provideTestLayer(TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer)))),
    );
  }

  effectIt.effect('persists cold and incremental measurements when the independent reference is interrupted', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-checkpoint-cancellation-'});
      const output = path.join(root, 'capture.json.run.json');
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Effect.gen(function* () {
        const checkpoint = yield* Effect.acquireRelease(makeBenchmarkRunCheckpoint(output, provenance), value =>
          value.finish('failed'),
        );
        yield* checkpoint.bind('generated-code-graph-vectors-v2:100000', model);
        for (const phase of BENCHMARK_CHECKPOINT_INDEX_PHASES.slice(0, 2)) {
          yield* checkpoint.mark(phase);
          yield* checkpoint.completeIndex(phase, evidence);
        }
        yield* checkpoint.mark('same-overlay-reference-index');
        yield* Deferred.succeed(ready, undefined);
        return yield* Effect.never;
      }).pipe(Effect.scoped, Effect.forkChild);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      const retained = parseCodeGraphBenchmarkRunCheckpoint(JSON.parse(yield* fs.readFileString(output)));
      expect(retained).toMatchObject({
        state: 'failed',
        phase: 'same-overlay-reference-index',
        diagnostics: {
          releaseQualification: false,
          provenance: {...provenance, model},
          indexes: [
            {phase: 'cold-index', state: 'complete', evidence},
            {phase: 'incremental-index', state: 'complete', evidence},
            {phase: 'same-overlay-reference-index', state: 'incomplete'},
          ],
        },
      });
      expect(() => parseBenchmarkArtifactV1(retained)).toThrow();
    }).pipe(provideTestLayer(TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer)))),
  );
});

describe('isolated embedding runtime diagnostics', () => {
  const hash = (value: string) => EffectString.repeat(64)(value);
  const observation = (
    cell: ReturnType<typeof embeddingRuntimeDiagnosticSchedule>[number],
    bunFactor = 3,
    libraryFactor = 2,
    roundScale = 1,
  ) => {
    const wall =
      100 *
      (cell.bunVersion === '1.4.4' ? bunFactor : 1) *
      (cell.libraryVersion === '3.22.2' ? libraryFactor : 1) *
      (1 + cell.round * roundScale);
    return parseEmbeddingRuntimeDiagnosticObservation({
      ...cell,
      releaseQualification: false,
      modelSha256: hash('a'),
      inputSha256: hash('b'),
      tokenSha256: hash('c'),
      vectorSha256: hash('d'),
      sourceCommit: EffectString.repeat(40)('1'),
      sourceScriptSha256: hash('e'),
      bunExecutableSha256: hash(cell.bunVersion === '1.4.4' ? '1' : '2'),
      libraryPackageSha256: hash(cell.libraryVersion === '3.22.2' ? '3' : '4'),
      dependencyLockSha256: hash(cell.libraryVersion === '3.22.2' ? '5' : '6'),
      nativeBinaries: {'mac-arm64-metal/llama-addon.node': hash(cell.libraryVersion === '3.22.2' ? '7' : '8')},
      inputCount: 2048,
      vectorCount: 2048,
      dimensions: 384,
      tokenCount: 103212,
      contextSize: 512,
      cpuMathCores: 3,
      effectiveContexts: 2,
      requestedContexts: 8,
      modelGpuLayers: 0,
      threadCounts: [2, 1],
      nativeBackend: 'metal',
      buildType: 'prebuilt',
      setupAndWarmupWallMilliseconds: 10,
      inferenceWallMilliseconds: wall,
      inferenceCpuMilliseconds: 2 * wall,
      processCommandWallMilliseconds: wall + 100,
      processPeakRssBytes: 100000000,
      host: {
        logicalCpus: 4,
        totalMemoryBytes: 8000000000,
        freeMemoryBytesBefore: 4000000000,
        freeMemoryBytesAfter: 3900000000,
        loadAverageBefore: [0, 0, 0],
        loadAverageAfter: [2, 1, 1],
        cpuBusyFraction: 0.75,
      },
    });
  };

  it('balances every runtime/library cell and position on one sixteen-process schedule', () => {
    const schedule = embeddingRuntimeDiagnosticSchedule();
    expect(schedule).toHaveLength(16);
    for (let round = 1; round <= 4; round += 1) {
      const cells = EffectArray.filter(schedule, cell => cell.round === round);
      expect(new Set(EffectArray.map(cells, cell => `${cell.bunVersion}/${cell.libraryVersion}`)).size).toBe(4);
      expect(EffectArray.map(cells, cell => cell.position)).toEqual([1, 2, 3, 4]);
    }
    for (let position = 1; position <= 4; position += 1) {
      expect(
        new Set(
          EffectArray.map(
            EffectArray.filter(schedule, cell => cell.position === position),
            cell => `${cell.bunVersion}/${cell.libraryVersion}`,
          ),
        ).size,
      ).toBe(4);
    }
  });

  it('admits matched contrasts independently of common per-round scaling without mutating observations', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 4}),
        fc.integer({min: 1, max: 4}),
        fc.integer({min: 1, max: 20}),
        (bunFactor, libraryFactor, scale) => {
          const values = EffectArray.map(embeddingRuntimeDiagnosticSchedule(), cell =>
            observation(cell, bunFactor, libraryFactor, scale),
          );
          const before = JSON.stringify(values);
          const result = summarizeEmbeddingRuntimeDiagnostics(values, hash('a'));
          expect(result.releaseQualification).toBe(false);
          expect(
            EffectArray.map(result.contrasts, item => [
              item.factor,
              item.pairs.length,
              item.medianWallRatio,
              item.medianCpuRatio,
            ]),
          ).toEqual([
            ['bunVersion', 8, bunFactor, bunFactor],
            ['libraryVersion', 8, libraryFactor, libraryFactor],
          ]);
          expect(JSON.stringify(values)).toBe(before);
          expect(() => parseBenchmarkArtifactV1(result)).toThrow();
        },
      ),
      {numRuns: 24},
    );
  });

  it('rejects partial, reordered, changed-work and changed-capacity or binary comparisons', () => {
    const values = EffectArray.map(embeddingRuntimeDiagnosticSchedule(), cell => observation(cell));
    expect(() => summarizeEmbeddingRuntimeDiagnostics(values.slice(1), hash('a'))).toThrow('incomplete');
    expect(() => summarizeEmbeddingRuntimeDiagnostics([values[1], values[0], ...values.slice(2)], hash('a'))).toThrow(
      'schedule',
    );
    const changes = [
      {modelSha256: hash('f')},
      {inputSha256: hash('f')},
      {tokenSha256: hash('f')},
      {tokenCount: 103213},
      {vectorSha256: hash('f')},
      {sourceCommit: EffectString.repeat(40)('2')},
      {sourceScriptSha256: hash('f')},
      {bunExecutableSha256: hash('f')},
      {libraryPackageSha256: hash('f')},
      {dependencyLockSha256: hash('f')},
      {nativeBinaries: {'mac-arm64-metal/llama-addon.node': hash('f')}},
      {host: {...values[3].host, totalMemoryBytes: 16000000000}},
      {effectiveContexts: 1},
      {threadCounts: [1, 2]},
      {releaseQualification: true},
    ];
    for (const change of changes)
      expect(() =>
        summarizeEmbeddingRuntimeDiagnostics(
          [...values.slice(0, 3), {...values[3], ...change}, ...values.slice(4)],
          hash('a'),
        ),
      ).toThrow();
  });

  it('keeps the hosted comparison manual-only and the 100k performance gate unchanged', () => {
    const workflow = readFileSync(new URL('../../../../.github/workflows/benchmarks.yml', import.meta.url), 'utf8');
    const diagnostic = EffectString.split('  code-graph-vectors:')(
      EffectString.split('  embedding-runtime-diagnostics:')(workflow)[1],
    )[0];
    expect(diagnostic).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.include_embedding_runtime_diagnostics",
    );
    expect(diagnostic).toContain('runs-on: macos-15');
    expect(diagnostic).toContain('--embedding-runtime-diagnostics');
    expect(diagnostic).toContain('--ignore-scripts');
    expect(diagnostic).not.toContain('--fail-on-budget');
    expect(workflow).toContain('timeout-minutes: 65');
    expect(workflow).toContain('--scale-symbols 100000');
    expect(workflow).toContain('--fail-on-budget');
  });
});
