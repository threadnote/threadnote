import {Array as EffectArray} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, DateTime, Effect, FileSystem, Path, Schema} from 'effect';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '@threadnote/graph/indexer';
import type {CodeGraphIndexSummary, CodeGraphMaterializationMetrics, CodeGraphProgress} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {benchmarkMeasurement, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {
  benchmarkStorageEnvironment,
  enforceCodeGraphBenchmarkRatchet,
  validateBenchmarkRuntimeProvenance,
  validateCodeGraphBenchmarkRatchet,
  type BenchmarkRuntimeProvenance,
  type BenchmarkStorageEnvironment,
} from './benchmark-code-graph.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import {generatedStaticReexportControlStatement, prepareGeneratedCodeGraphFixture} from './code-graph-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

interface DirtyOverlayBenchmarkOptions {
  readonly governed: boolean;
  readonly minimumFreeGiB: number;
  readonly outputPath?: string;
  readonly ratchetPath?: string;
  readonly samples: number;
  readonly scenario: DirtyOverlayBenchmarkScenario;
  readonly scaleSymbols: number;
}

export type DirtyOverlayBenchmarkScenario = 'body-only' | 'changed-export' | 'unchanged-static-reexport';

interface DirtyOverlayObservation {
  readonly attributionContextFiles?: number;
  readonly baseFactsLoaded?: number;
  readonly changedFiles?: number;
  readonly closureProjects?: number;
  readonly cpuMilliseconds: number;
  readonly durationMilliseconds: number;
  readonly edges: number;
  readonly factReplayAmplification?: number;
  readonly fallbackReason?: string;
  readonly inventoryFilesInspected?: number;
  readonly materializationMilliseconds: number;
  readonly materializationMode: string;
  readonly probedDependencyPaths?: number;
  readonly replay: DirtyOverlayReplayEvidence;
  readonly resolutionClosure?: string;
  readonly rewriteAmplification?: number;
  readonly stagedFiles: number;
  readonly symbols: number;
  readonly totalFiles: number;
}

interface DirtyOverlayGovernanceEvidence {
  readonly availableBytes: number;
  readonly minimumFreeBytes: number;
  readonly runtimeProvenance: BenchmarkRuntimeProvenance;
  readonly storage: BenchmarkStorageEnvironment;
  readonly tempFilesystemValidated: true;
}

export interface DirtyOverlayReplayEvidence {
  readonly attributedFiles: number;
  readonly cachedFactReplayBytes: number;
  readonly changedFactBytes: number;
  readonly crossGenerationShardFiles: number;
  readonly exactGenerationShardFiles: number;
  readonly materializedShardReplayBytes: number;
  readonly rawFactReplayBytes: number;
}

const benchmarkCodeGraphDirtyOverlay = Effect.scoped(
  Effect.gen(function* () {
    const options = parseDirtyOverlayBenchmarkArguments(yield* scriptArguments());
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const indexer = yield* CodeGraphIndexer;
    const path = yield* Path.Path;
    const sourceRoot = yield* path.fromFileUrl(new URL('..', import.meta.url));
    const ratchet = options.ratchetPath ? yield* readJsonFile(options.ratchetPath) : undefined;
    if (ratchet !== undefined) {
      yield* Effect.try({
        catch: cause => ScriptError.make({message: `Dirty-overlay performance ratchet is invalid: ${String(cause)}`}),
        try: () => validateCodeGraphBenchmarkRatchet(ratchet),
      });
    }
    const governance = options.governed
      ? yield* prepareDirtyOverlayGovernance(system, sourceRoot, options.minimumFreeGiB)
      : undefined;
    const incremental: DirtyOverlayObservation[] = [];
    const full: DirtyOverlayObservation[] = [];

    for (let sample = 0; sample < options.samples; sample += 1) {
      const order = sample % 2 === 0 ? ([false, true] as const) : ([true, false] as const);
      for (const enabled of order) {
        const observation = yield* Effect.scoped(
          runDirtyOverlayIndex(indexer, options.scaleSymbols, enabled, options.scenario),
        );
        (enabled ? incremental : full).push(observation);
      }
    }

    for (let index = 0; index < options.samples; index += 1) {
      const incrementalSample = incremental[index];
      const fullSample = full[index];
      if (
        incrementalSample.symbols !== fullSample.symbols ||
        incrementalSample.edges !== fullSample.edges ||
        incrementalSample.totalFiles !== fullSample.totalFiles
      ) {
        return yield* ScriptError.make({
          message: `Dirty-overlay benchmark graph shape diverged in sample ${index + 1}.`,
        });
      }
    }

    const incrementalDuration = summarize(EffectArray.map(incremental, sample => sample.durationMilliseconds));
    const fullDuration = summarize(EffectArray.map(full, sample => sample.durationMilliseconds));
    const incrementalMaterialization = summarize(
      EffectArray.map(incremental, sample => sample.materializationMilliseconds),
    );
    const fullMaterialization = summarize(EffectArray.map(full, sample => sample.materializationMilliseconds));
    const finalRuntimeProvenance = governance ? yield* validateBenchmarkRuntimeProvenance(sourceRoot) : undefined;
    if (
      governance !== undefined &&
      JSON.stringify(finalRuntimeProvenance) !== JSON.stringify(governance.runtimeProvenance)
    ) {
      return yield* ScriptError.make({
        message: 'Dirty-overlay benchmark source/runtime provenance changed during the run.',
      });
    }
    const ratchetArtifact = dirtyOverlayRatchetArtifact({
      full,
      governance,
      hardware,
      incremental,
      options,
      runtimeVersion: system.runtimeVersion,
      runtimePlatform: system.platform,
    });
    const artifact = {
      createdAt: DateTime.formatIso(yield* DateTime.now),
      environment: {
        architecture: system.architecture,
        cpu: hardware.cpuModel,
        ...(governance === undefined
          ? {provenance: 'unverified-development-run'}
          : {
              availableBytes: governance.availableBytes,
              commit: governance.runtimeProvenance.sourceCommit,
              minimumFreeBytes: governance.minimumFreeBytes,
              provenance: governance.runtimeProvenance,
              storage: governance.storage,
            }),
        memoryBytes: hardware.memoryBytes,
        operatingSystem: hardware.operatingSystem,
        runtime: `bun/${system.runtimeVersion}`,
      },
      fixture: {
        ...(options.scenario === 'body-only'
          ? {bodyOnlyModifiedFiles: 1}
          : options.scenario === 'unchanged-static-reexport'
            ? {
                scaleSemantics:
                  `target symbols; this run has ${incremental[0]?.totalFiles ?? 0} indexed files, ` +
                  `not ${options.scaleSymbols} files`,
                scenario: options.scenario,
                spanOnlyStaticReexportModifiedFiles: 1,
              }
            : {
                dependencySurfaceModifiedFiles: 1,
                scaleSemantics:
                  `target background symbols; this run has ${incremental[0]?.totalFiles ?? 0} indexed files, ` +
                  `not ${options.scaleSymbols} files`,
                scenario: options.scenario,
              }),
        targetSymbols: options.scaleSymbols,
      },
      measurements: {
        full: {
          cpuMilliseconds: summarize(EffectArray.map(full, sample => sample.cpuMilliseconds)),
          durationMilliseconds: fullDuration,
          ...(options.scenario !== 'body-only'
            ? {
                factReplayAmplification: full[0]?.factReplayAmplification ?? 0,
                rewriteAmplification: full[0]?.rewriteAmplification ?? 0,
                totalFiles: full[0]?.totalFiles ?? 0,
              }
            : {}),
          materializationMilliseconds: fullMaterialization,
          replay: full[0].replay,
          stagedFiles: full[0]?.stagedFiles ?? 0,
        },
        incremental: {
          cpuMilliseconds: summarize(EffectArray.map(incremental, sample => sample.cpuMilliseconds)),
          durationMilliseconds: incrementalDuration,
          ...(options.scenario !== 'body-only'
            ? {
                factReplayAmplification: incremental[0]?.factReplayAmplification ?? 0,
                rewriteAmplification: incremental[0]?.rewriteAmplification ?? 0,
                totalFiles: incremental[0]?.totalFiles ?? 0,
              }
            : {}),
          materializationMilliseconds: incrementalMaterialization,
          replay: incremental[0].replay,
          stagedFiles: incremental[0]?.stagedFiles ?? 0,
        },
        improvement: {
          durationPercent: percentReduction(fullDuration.mean, incrementalDuration.mean),
          materializationPercent: percentReduction(fullMaterialization.mean, incrementalMaterialization.mean),
        },
      },
      observations: {full, incremental},
      ratchetArtifact,
      samples: options.samples,
      version: 2,
    };
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    yield* printJson(artifact);
    if (ratchet !== undefined) {
      return yield* Effect.try({
        catch: cause =>
          Schema.is(ScriptError)(cause)
            ? cause
            : ScriptError.make({message: `Dirty-overlay performance ratchet failed: ${String(cause)}`}),
        try: () => enforceCodeGraphBenchmarkRatchet(ratchetArtifact, ratchet),
      });
    }
  }),
);

const prepareDirtyOverlayGovernance = Effect.fn('benchmarkCodeGraphDirtyOverlay.prepareGovernance')(function* (
  system: SystemInfoShape,
  sourceRoot: string,
  minimumFreeGiB: number,
) {
  const minimumFreeBytes = minimumFreeGiB * 1_073_741_824;
  const [runtimeProvenance, storage, availableBytes] = yield* Effect.all(
    [
      validateBenchmarkRuntimeProvenance(sourceRoot),
      benchmarkStorageEnvironment(system.tempDirectory),
      system.availableDiskBytes(system.tempDirectory),
    ],
    {concurrency: 3},
  );
  if (availableBytes === undefined || availableBytes < minimumFreeBytes) {
    return yield* ScriptError.make({
      message: `Governed dirty-overlay benchmark requires at least ${minimumFreeGiB} GiB free on its temporary filesystem.`,
    });
  }
  if (storage.medium !== 'solid-state') {
    return yield* ScriptError.make({
      message: `Governed dirty-overlay benchmark requires solid-state storage; detected ${storage.medium}.`,
    });
  }
  if (system.platform === 'darwin' && storage.location !== 'internal') {
    return yield* ScriptError.make({
      message: `Governed dirty-overlay benchmark requires the internal macOS device; detected ${storage.location}.`,
    });
  }
  return {
    availableBytes,
    minimumFreeBytes,
    runtimeProvenance,
    storage,
    tempFilesystemValidated: true,
  } satisfies DirtyOverlayGovernanceEvidence;
});

export function dirtyOverlayRatchetArtifact(input: {
  readonly full: readonly DirtyOverlayObservation[];
  readonly governance?: DirtyOverlayGovernanceEvidence;
  readonly hardware: {
    readonly cpuModel: string;
    readonly memoryBytes: number;
    readonly operatingSystem: string;
  };
  readonly incremental: readonly DirtyOverlayObservation[];
  readonly options: DirtyOverlayBenchmarkOptions;
  readonly runtimePlatform: string;
  readonly runtimeVersion: string;
}): BenchmarkArtifactV1 {
  const fixtureHash = `generated-code-graph-dirty-overlay-v2:${input.options.scenario}:${input.options.scaleSymbols}`;
  const runnerClass =
    Effect2.pipe(process.env.THREADNOTE_BENCHMARK_RUNNER_CLASS, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) || 'local-unclassified';
  const firstIncremental = input.incremental[0];
  const firstFull = input.full[0];
  const measurements = [
    benchmarkMeasurement(
      'incremental-duration',
      'milliseconds',
      EffectArray.map(input.incremental, sample => sample.durationMilliseconds),
    ),
    benchmarkMeasurement(
      'incremental-cpu',
      'milliseconds',
      EffectArray.map(input.incremental, sample => sample.cpuMilliseconds),
    ),
    benchmarkMeasurement(
      'incremental-materialization',
      'milliseconds',
      EffectArray.map(input.incremental, sample => sample.materializationMilliseconds),
    ),
    benchmarkMeasurement(
      'full-duration',
      'milliseconds',
      EffectArray.map(input.full, sample => sample.durationMilliseconds),
    ),
    benchmarkMeasurement(
      'full-cpu',
      'milliseconds',
      EffectArray.map(input.full, sample => sample.cpuMilliseconds),
    ),
    benchmarkMeasurement(
      'full-materialization',
      'milliseconds',
      EffectArray.map(input.full, sample => sample.materializationMilliseconds),
    ),
    benchmarkMeasurement(
      'incremental-duration-reduction',
      'percent',
      EffectArray.map(input.incremental, (sample, index) =>
        Math.max(0, percentReduction(input.full[index].durationMilliseconds, sample.durationMilliseconds)),
      ),
    ),
    benchmarkMeasurement(
      'incremental-materialization-reduction',
      'percent',
      EffectArray.map(input.incremental, (sample, index) =>
        Math.max(
          0,
          percentReduction(input.full[index].materializationMilliseconds, sample.materializationMilliseconds),
        ),
      ),
    ),
    ...dirtyOverlayObservationMeasurements('incremental', input.incremental),
    ...dirtyOverlayObservationMeasurements('full', input.full),
  ];
  return {
    createdAt: new Date().toISOString(),
    environment: {
      architecture: process.arch,
      commit: input.governance?.runtimeProvenance.sourceCommit ?? 'unverified-development-run',
      cpu: input.hardware.cpuModel,
      dirty: input.governance === undefined,
      fixtureHash,
      memoryBytes: input.hardware.memoryBytes,
      node: `bun/${input.runtimeVersion}`,
      operatingSystem: input.hardware.operatingSystem,
      packageManager: `bun/${input.runtimeVersion}`,
      runner: 'threadnote-code-graph-dirty-overlay',
      runnerVersion: '2',
    },
    measurements,
    metadata: {
      fullMaterializationMode: firstFull?.materializationMode ?? 'missing',
      governed: input.governance !== undefined,
      incrementalMaterializationMode: firstIncremental?.materializationMode ?? 'missing',
      minimumFreeGiB: input.options.minimumFreeGiB,
      resolutionClosure: firstIncremental?.resolutionClosure ?? 'none',
      runnerClass,
      runtimePlatform: input.runtimePlatform,
      scenario: input.options.scenario,
      storageLocation: input.governance?.storage.location ?? 'unverified',
      storageMedium: input.governance?.storage.medium ?? 'unverified',
      targetSymbols: input.options.scaleSymbols,
      vectorEnabled: false,
    },
    suite: 'threadnote-code-graph-dirty-overlay',
    version: 1,
    warmups: 0,
  };
}

function dirtyOverlayObservationMeasurements(
  prefix: 'full' | 'incremental',
  observations: readonly DirtyOverlayObservation[],
): readonly ReturnType<typeof benchmarkMeasurement>[] {
  const numericFields = [
    ['attribution-context-files', 'attributionContextFiles', 'count'],
    ['base-facts-loaded', 'baseFactsLoaded', 'count'],
    ['changed-files', 'changedFiles', 'count'],
    ['closure-projects', 'closureProjects', 'count'],
    ['edges', 'edges', 'count'],
    ['fact-replay-amplification', 'factReplayAmplification', 'count'],
    ['inventory-files-inspected', 'inventoryFilesInspected', 'count'],
    ['probed-dependency-paths', 'probedDependencyPaths', 'count'],
    ['rewrite-amplification', 'rewriteAmplification', 'count'],
    ['staged-files', 'stagedFiles', 'count'],
    ['symbols', 'symbols', 'count'],
    ['total-files', 'totalFiles', 'count'],
  ] as const;
  const replayFields = [
    ['attributed-files', 'attributedFiles', 'count'],
    ['cached-fact-replay-bytes', 'cachedFactReplayBytes', 'bytes'],
    ['changed-fact-bytes', 'changedFactBytes', 'bytes'],
    ['cross-generation-shard-files', 'crossGenerationShardFiles', 'count'],
    ['exact-generation-shard-files', 'exactGenerationShardFiles', 'count'],
    ['materialized-shard-replay-bytes', 'materializedShardReplayBytes', 'bytes'],
    ['raw-fact-replay-bytes', 'rawFactReplayBytes', 'bytes'],
  ] as const;
  return [
    ...EffectArray.flatMap(numericFields, ([name, field, unit]) => {
      const values = EffectArray.filter(
        EffectArray.map(observations, observation => observation[field]),
        value => value !== undefined,
      );
      return values.length === observations.length ? [benchmarkMeasurement(`${prefix}-${name}`, unit, values)] : [];
    }),
    ...EffectArray.map(replayFields, ([name, field, unit]) =>
      benchmarkMeasurement(
        `${prefix}-${name}`,
        unit,
        EffectArray.map(observations, observation => observation.replay[field]),
      ),
    ),
  ];
}

const runDirtyOverlayIndex = Effect.fn('benchmarkCodeGraphDirtyOverlay.run')(function* (
  indexer: CodeGraphIndexerShape,
  scaleSymbols: number,
  incrementalOverlay: boolean,
  scenario: DirtyOverlayBenchmarkScenario,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prepared = yield* prepareGeneratedCodeGraphFixture(
    scaleSymbols,
    false,
    scenario === 'unchanged-static-reexport',
    scenario === 'changed-export',
  );
  yield* indexer.index({cwd: prepared.repository, incrementalOverlay: false, threadnoteHome: prepared.home});
  const changedPath = path.join(prepared.repository, prepared.incrementalSourcePath ?? 'src/module-00000.ts');
  const committed = yield* fs.readFileString(changedPath);
  const changed = dirtyOverlayChangedSource(scenario, committed);
  yield* fs.writeFileString(changedPath, changed);

  let materializationStarted: bigint | undefined;
  let materializationNanoseconds = 0n;
  let finalMaterializationMetrics: Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['metrics'];
  let previousProgressPhase: CodeGraphProgress['phase'] | undefined;
  const observeProgress = (progress: CodeGraphProgress) =>
    Clock.currentTimeNanos.pipe(
      Effect.tap(now =>
        Effect.sync(() => {
          if (progress.phase === 'materializing') {
            if (previousProgressPhase !== 'materializing') finalMaterializationMetrics = undefined;
            if (progress.metrics !== undefined) finalMaterializationMetrics = progress.metrics;
          }
          if (progress.phase === 'materializing') {
            materializationStarted ??= now;
          } else if (materializationStarted !== undefined) {
            materializationNanoseconds += now - materializationStarted;
            materializationStarted = undefined;
          }
          previousProgressPhase = progress.phase;
        }),
      ),
    );
  const started = yield* Clock.currentTimeNanos;
  const cpuStarted = process.cpuUsage();
  const summary = yield* indexer.index({
    cwd: prepared.repository,
    incrementalOverlay,
    onProgress: observeProgress,
    threadnoteHome: prepared.home,
  });
  const finished = yield* Clock.currentTimeNanos;
  if (materializationStarted !== undefined) materializationNanoseconds += finished - materializationStarted;
  validateMaterialization(summary, incrementalOverlay, scenario);
  const changedFactBytes =
    summary.incrementalWork?.factBytes ?? finalMaterializationMetrics?.changedFactBytesCompleted ?? 0;
  if (scenario === 'unchanged-static-reexport' && changedFactBytes <= 0) {
    return yield* ScriptError.make({message: 'Dirty-overlay benchmark did not retain changed-fact byte evidence.'});
  }
  const replay = incrementalOverlay
    ? incrementalDirtyOverlayReplayEvidence(changedFactBytes)
    : dirtyOverlayReplayEvidence(finalMaterializationMetrics, changedFactBytes);
  const amplification =
    scenario !== 'body-only'
      ? dirtyOverlayAmplificationEvidence({
          cachedFactReplayBytes: replay.cachedFactReplayBytes,
          changedFactBytes,
          deltaFiles: 1,
          stagedFiles: summary.materialization?.stagedFiles ?? 0,
        })
      : undefined;
  const cpu = process.cpuUsage(cpuStarted);
  return {
    ...(summary.incrementalWork?.attributionContextFiles === undefined
      ? {}
      : {attributionContextFiles: summary.incrementalWork.attributionContextFiles}),
    ...(summary.incrementalWork?.baseFactsLoaded === undefined
      ? {}
      : {baseFactsLoaded: summary.incrementalWork.baseFactsLoaded}),
    ...(summary.incrementalWork?.changedFiles === undefined
      ? {}
      : {changedFiles: summary.incrementalWork.changedFiles}),
    ...(summary.materialization?.closureProjects === undefined
      ? {}
      : {closureProjects: summary.materialization.closureProjects}),
    cpuMilliseconds: (cpu.system + cpu.user) / 1_000,
    durationMilliseconds: Number(finished - started) / NANOSECONDS_PER_MILLISECOND,
    edges: summary.snapshot.edgeCount,
    ...(amplification === undefined
      ? {}
      : {
          factReplayAmplification: amplification.factReplayAmplification,
          rewriteAmplification: amplification.rewriteAmplification,
        }),
    ...(summary.materialization?.fallbackReason ? {fallbackReason: summary.materialization.fallbackReason} : {}),
    ...(summary.incrementalWork?.inventoryFilesInspected === undefined
      ? {}
      : {inventoryFilesInspected: summary.incrementalWork.inventoryFilesInspected}),
    materializationMilliseconds: Number(materializationNanoseconds) / NANOSECONDS_PER_MILLISECOND,
    materializationMode: summary.materialization?.mode ?? 'unreported',
    ...(summary.incrementalWork?.probedDependencyPaths === undefined
      ? {}
      : {probedDependencyPaths: summary.incrementalWork.probedDependencyPaths}),
    replay,
    ...(summary.materialization?.resolutionClosure === undefined
      ? {}
      : {resolutionClosure: summary.materialization.resolutionClosure}),
    stagedFiles: summary.materialization?.stagedFiles ?? -1,
    symbols: summary.snapshot.symbolCount,
    totalFiles: summary.materialization?.totalFiles ?? -1,
  } satisfies DirtyOverlayObservation;
});

export function dirtyOverlayReplayEvidence(
  metrics: CodeGraphMaterializationMetrics | undefined,
  changedFactBytes: number,
): DirtyOverlayReplayEvidence {
  if (
    metrics?.attributedFilesCompleted === undefined ||
    metrics.cachedFactReplayBytesCompleted === undefined ||
    metrics.changedFactBytesCompleted === undefined ||
    metrics.crossGenerationShardFilesCompleted === undefined ||
    metrics.exactGenerationShardFilesCompleted === undefined ||
    metrics.materializedShardReplayBytesCompleted === undefined ||
    metrics.rawFactReplayBytesCompleted === undefined
  ) {
    throw ScriptError.make({message: 'Dirty-overlay benchmark did not retain complete physical replay evidence.'});
  }
  const cachedFactReplayBytes = metrics.cachedFactReplayBytesCompleted;
  const materializedShardReplayBytes = metrics.materializedShardReplayBytesCompleted;
  const rawFactReplayBytes = metrics.rawFactReplayBytesCompleted;
  if (cachedFactReplayBytes !== Math.min(Number.MAX_SAFE_INTEGER, materializedShardReplayBytes + rawFactReplayBytes)) {
    throw ScriptError.make({message: 'Dirty-overlay benchmark replay-byte split is inconsistent.'});
  }
  if (changedFactBytes !== metrics.changedFactBytesCompleted) {
    throw ScriptError.make({message: 'Dirty-overlay benchmark changed-fact byte evidence is inconsistent.'});
  }
  return {
    attributedFiles: metrics.attributedFilesCompleted,
    cachedFactReplayBytes,
    changedFactBytes,
    crossGenerationShardFiles: metrics.crossGenerationShardFilesCompleted,
    exactGenerationShardFiles: metrics.exactGenerationShardFilesCompleted,
    materializedShardReplayBytes,
    rawFactReplayBytes,
  };
}

function incrementalDirtyOverlayReplayEvidence(changedFactBytes: number): DirtyOverlayReplayEvidence {
  return {
    attributedFiles: 0,
    cachedFactReplayBytes: 0,
    changedFactBytes,
    crossGenerationShardFiles: 0,
    exactGenerationShardFiles: 0,
    materializedShardReplayBytes: 0,
    rawFactReplayBytes: 0,
  };
}

export function dirtyOverlayAmplificationEvidence(input: {
  readonly cachedFactReplayBytes: number;
  readonly changedFactBytes: number;
  readonly deltaFiles: number;
  readonly stagedFiles: number;
}): {readonly factReplayAmplification: number; readonly rewriteAmplification: number} {
  return {
    factReplayAmplification: integerAmplification(input.cachedFactReplayBytes, input.changedFactBytes),
    rewriteAmplification: integerAmplification(input.stagedFiles, input.deltaFiles),
  };
}

export function dirtyOverlayChangedSource(scenario: DirtyOverlayBenchmarkScenario, committed: string): string {
  if (scenario === 'body-only') {
    if (!Effect2.pipe(committed, EffectString.includes('return 0;'))) {
      throw ScriptError.make({message: 'Dirty-overlay benchmark fixture lost its body-only edit marker.'});
    }
    return Effect2.pipe(committed, EffectString.replace('return 0;', 'return 1000000;'));
  }
  if (scenario === 'changed-export') {
    if (!Effect2.pipe(committed, EffectString.includes('export function dependencySurfaceControl()'))) {
      throw ScriptError.make({message: 'Dirty-overlay benchmark fixture lost its dependency-surface edit marker.'});
    }
    return `${committed}${Effect2.pipe(committed, EffectString.endsWith('\n')) ? '' : '\n'}export function publishedDependencySurfaceControl(): number { return 2; }\n`;
  }
  if (!Effect2.pipe(committed, EffectString.includes(generatedStaticReexportControlStatement()))) {
    throw ScriptError.make({message: 'Dirty-overlay benchmark fixture lost its static re-export control.'});
  }
  return `// Span-only benchmark edit; resolver input below is byte-identical.\n${committed}`;
}

function integerAmplification(numerator: number, denominator: number): number {
  return numerator <= 0 ? 0 : Math.floor(numerator / Math.max(1, denominator));
}

function validateMaterialization(
  summary: CodeGraphIndexSummary,
  incrementalOverlay: boolean,
  scenario: DirtyOverlayBenchmarkScenario,
): void {
  if (incrementalOverlay) {
    const valid =
      scenario === 'changed-export'
        ? summary.materialization?.mode === 'incremental-overlay' &&
          summary.materialization.closureProjects === 2 &&
          summary.materialization.resolutionClosure === 'project' &&
          summary.materialization.stagedFiles === 4 &&
          summary.incrementalWork?.attributionContextFiles === 4 &&
          summary.incrementalWork?.baseFactsLoaded === 4 &&
          summary.incrementalWork.changedFiles === 4 &&
          summary.incrementalWork.inventoryFilesInspected === 4 &&
          summary.materialization.totalFiles > summary.materialization.stagedFiles
        : summary.materialization?.mode === 'incremental-overlay' && summary.materialization.stagedFiles === 1;
    if (!valid) {
      throw ScriptError.make({
        message: `Incremental dirty-overlay benchmark fell back: ${JSON.stringify(summary.materialization)}.`,
      });
    }
    return;
  }
  if (summary.materialization?.mode !== 'full' || summary.materialization.fallbackReason !== 'disabled') {
    throw ScriptError.make({
      message: `Full dirty-overlay benchmark did not use its control path: ${JSON.stringify(summary.materialization)}.`,
    });
  }
}

function summarize(values: readonly number[]): {
  readonly maximum: number;
  readonly mean: number;
  readonly minimum: number;
} {
  if (values.length === 0)
    throw ScriptError.make({message: 'Dirty-overlay benchmark requires at least one observation.'});
  return {
    maximum: Math.max(...values),
    mean: EffectArray.reduce(values, 0, (total, value) => total + value) / values.length,
    minimum: Math.min(...values),
  };
}

function percentReduction(baseline: number, improved: number): number {
  return baseline === 0 ? 0 : ((baseline - improved) / baseline) * 100;
}

export function parseDirtyOverlayBenchmarkArguments(args: readonly string[]): DirtyOverlayBenchmarkOptions {
  let governed = false;
  let minimumFreeGiB = 120;
  let outputPath: string | undefined;
  let ratchetPath: string | undefined;
  let samples = 3;
  let scenario: DirtyOverlayBenchmarkScenario = 'body-only';
  let scaleSymbols = 10_000;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--governed') governed = true;
    else if (argument === '--minimum-free-gib') minimumFreeGiB = integer(args[++index], argument, 1);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--ratchet') ratchetPath = required(args[++index], argument);
    else if (argument === '--samples') samples = integer(args[++index], argument, 1);
    else if (argument === '--scenario') {
      const value = required(args[++index], argument);
      if (value !== 'body-only' && value !== 'changed-export' && value !== 'unchanged-static-reexport') {
        throw ScriptError.make({
          message: '--scenario must be body-only, changed-export, or unchanged-static-reexport.',
        });
      }
      scenario = value;
    } else if (argument === '--scale-symbols') scaleSymbols = integer(args[++index], argument, 1);
    else throw ScriptError.make({message: `Unknown dirty-overlay benchmark option: ${argument}`});
  }
  if (scenario === 'unchanged-static-reexport' && scaleSymbols < 101) {
    throw ScriptError.make({message: '--scenario unchanged-static-reexport requires --scale-symbols at least 101.'});
  }
  if (governed && minimumFreeGiB < 120) {
    throw ScriptError.make({message: '--governed requires --minimum-free-gib of at least 120.'});
  }
  if (governed && outputPath === undefined) {
    throw ScriptError.make({message: '--governed requires --output so exact evidence is retained.'});
  }
  if (ratchetPath !== undefined && (!governed || outputPath === undefined)) {
    throw ScriptError.make({message: '--ratchet requires --governed and --output.'});
  }
  return {
    governed,
    minimumFreeGiB,
    ...(outputPath === undefined ? {} : {outputPath}),
    ...(ratchetPath === undefined ? {} : {ratchetPath}),
    samples,
    scaleSymbols,
    scenario,
  };
}

function integer(value: string | undefined, option: string, minimum: number): number {
  const parsed = Number.parseInt(required(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw ScriptError.make({message: `${option} must be at least ${minimum}`});
  return parsed;
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkCodeGraphDirtyOverlay, ApplicationLayer));
