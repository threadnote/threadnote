import {startExternalSampler} from './benchmark-code-graph.js';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {ScriptCommandExecutorLayer, ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {BunRuntime} from '@effect/platform-bun';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {Clock, Console, DateTime, Effect, FileSystem, Layer, Path} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {benchmarkMeasurement, parseBenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {
  NATIVE_PERFORMANCE_CONTRACT,
  NATIVE_PERFORMANCE_STAGES,
  parseNativePerformanceCapture,
  nativePerformanceSourceChanges,
  createNativeStageTracing,
  nativeStagePartition,
} from '@threadnote/evidence/native-performance';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';

import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {
  rebuildVectorIndex,
  selectedSemanticScores,
  vectorIndexDatabaseFilename,
  type VectorIndexProgress,
} from '@threadnote/recall/vector-index';
import {assessRecallVectorPerformance} from './recall-vector-performance-budget.js';
import {assessVectorDatabaseStorage, createCompactedSqliteSnapshot} from './recall-vector-storage-budget.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw ScriptError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const MEBIBYTE = 1024 * 1024;
const DEFAULT_DOCUMENT_COUNT = 10_000;
const DEFAULT_QUERY_SAMPLES = 30;
const VECTOR_QUERY_RESULT_LIMIT = 25;
const options = parseOptions(process.argv.slice(2));
let queryPhase = false;
let lastQueryVector: readonly number[] = [];
const manifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(
    EffectArray.filter(BUILTIN_MODEL_MANIFESTS, model => model.role === 'embedding'),
    model => model.id === options.model,
  ),
)!;

if (!manifest) throw ScriptError.make({message: `Unknown benchmark model: ${options.model}`});

const modelStoreLayer = Layer.succeed(
  LocalModelStore,
  LocalModelStore.of({
    install: () => Effect.die(ScriptError.make({message: 'Unexpected model installation'})),
    path: home => `${home}/models/benchmark.gguf`,
    remove: () => Effect.succeed(false),
    status: home => Effect.succeed(modelInstallation(home)),
    verify: home => Effect.succeed(modelInstallation(home)),
  } satisfies LocalModelStoreShape),
);

const mockRuntimeLayer = Layer.succeed(
  LocalModelRuntime,
  LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: ({inputs, manifest: requested}) =>
      Effect.sync(() => {
        const vectors = EffectArray.map(inputs, input => deterministicVector(requested.dimensions ?? 0, input));
        if (queryPhase) lastQueryVector = vectors[0];
        return vectors;
      }),
    generate: () => Effect.die(ScriptError.make({message: 'Unexpected generation'})),
    rerank: () => Effect.die(ScriptError.make({message: 'Unexpected reranking'})),
  }),
);

const runtimeLayer = options.modelFile
  ? Layer.effect(
      LocalModelRuntime,
      Effect.gen(function* () {
        const real = yield* LocalModelRuntime;
        return LocalModelRuntime.of({
          ...real,
          embedMany: request =>
            queryPhase
              ? real.embedMany(request).pipe(
                  Effect.tap(vectors =>
                    Effect.sync(() => {
                      lastQueryVector = vectors[0];
                    }),
                  ),
                )
              : Effect.sync(() =>
                  EffectArray.map(request.inputs, input =>
                    deterministicVector(request.manifest.dimensions ?? 0, input),
                  ),
                ),
        });
      }),
    ).pipe(
      Layer.provide(
        LocalModelRuntime.nativeLayer.pipe(Layer.provide(Layer.mergeAll(BunServices.layer, ScriptSystemInfoLayer))),
      ),
    )
  : mockRuntimeLayer;

const benchmarkLayer = Layer.mergeAll(
  BunServices.layer,
  LocalModelCatalog.layer([manifest]),
  modelStoreLayer,
  runtimeLayer,
  ScriptSystemInfoLayer,
  ScriptCommandExecutorLayer.pipe(Layer.provide(Layer.mergeAll(ScriptSystemInfoLayer, BunServices.layer))),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const captureStartedAt = DateTime.formatIso(yield* DateTime.now);
    const openingSource = yield* readBenchmarkSourceFence();
    const {commit: sourceCommit, dirty, instrumentationHash} = openingSource;
    if (options.modelFile && sha256HexSync(yield* fs.readFile(options.modelFile)) !== manifest.sha256) {
      return yield* ScriptError.make({message: 'Installed model SHA256 does not match pinned manifest.'});
    }
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-benchmark-'});
    const catalog = yield* LocalModelCatalog;
    yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
    const candidates = Array.from({length: options.documents}, (_, index) => ({
      text: `# Vector benchmark ${index}\n\nUnique vector benchmark document ${index}.`,
      uri: `threadnote://resources/repos/vector-benchmark/${Effect2.pipe(String(index), EffectString.padStart(6, '0'))}.md`,
    }));
    const initialRss = startRssSampler();
    let initialPeakRssBytes = initialRss.peak();
    const trackInitialMemory = (_progress: VectorIndexProgress) =>
      Effect.sync(() => {
        initialPeakRssBytes = Math.max(initialPeakRssBytes, process.memoryUsage().rss);
      });
    const initialStartedAt = yield* Clock.currentTimeNanos;
    const initial = yield* rebuildVectorIndex({agentContextHome: home}, manifest, candidates, {
      onProgress: trackInitialMemory,
    }).pipe(Effect.ensuring(Effect.sync(() => initialRss.stop())));
    const initialFinishedAt = yield* Clock.currentTimeNanos;
    initialPeakRssBytes = Math.max(initialPeakRssBytes, initialRss.peak(), process.memoryUsage().rss);
    const databasePath = path.join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename());
    const initialDatabaseBytes = Number((yield* fs.stat(databasePath)).size);
    const initialCompactedPath = path.join(home, 'initial-vector-index.compacted.sqlite');
    createCompactedSqliteSnapshot(databasePath, initialCompactedPath);
    const initialCompactedBytes = Number((yield* fs.stat(initialCompactedPath)).size);

    Bun.gc(true);
    const externalSampler = yield* Effect.acquireRelease(
      startExternalSampler(
        fs,
        path,
        path.join(home, 'query-telemetry'),
        home,
        databasePath,
        path.join(home, 'query-sampler-checkpoint.json'),
        'cold',
      ),
      sampler => sampler.stop('aborted').pipe(Effect.ignore),
    );
    yield* externalSampler.markPhase('vector-query');
    const queryRssBeforeBytes = process.memoryUsage().rss;
    const queryRss = startRssSampler();
    const queryDurations: number[] = [];
    const firstUseDurations: number[] = [];
    const queryCpu: number[] = [];
    const observerControlDurations: number[] = [];
    const observerProjectionDurations: number[] = [];
    const stageSamples: {sample: number; observation: ReturnType<typeof vectorStageObservation>}[] = [];
    const correctness: string[] = [];
    const oracleControls: {query: readonly number[]; scores: ReadonlyMap<string, number>}[] = [];
    queryPhase = true;
    let queryRssAfterBytes = queryRssBeforeBytes;
    yield* Effect.gen(function* () {
      for (let sample = 0; sample < options.samples + 1; sample += 1) {
        const targetIndex = sample % options.documents;
        let pairedDigest: string | undefined;
        const modes =
          options.stageAttribution && sample > 0
            ? sample % 2 === 0
              ? [false, true]
              : [true, false]
            : [options.stageAttribution];
        for (const observed of modes) {
          const cpuBefore = process.cpuUsage();
          const startedAt = yield* Clock.currentTimeNanos;
          const tracing = observed
            ? createNativeStageTracing([
                'vectorIndex.selectedSemanticScores',
                'vectorIndex.readSelectedScores',
                'sqlite',
              ])
            : undefined;
          const read = selectedSemanticScores({agentContextHome: home}, `vector benchmark query ${targetIndex}`, {
            limit: VECTOR_QUERY_RESULT_LIMIT,
          });
          const scores = yield* tracing ? Effect.withTracer(read, tracing.tracer) : read;
          const finishedAt = yield* Clock.currentTimeNanos;
          const cpu = process.cpuUsage(cpuBefore);
          const expectedSize = Math.min(VECTOR_QUERY_RESULT_LIMIT, options.documents);
          const expectedUri = candidates[targetIndex].uri;
          if (
            scores?.size !== expectedSize ||
            (!options.modelFile && options.distribution === 'sparse' && (scores.get(expectedUri) ?? -1) < 0.999)
          ) {
            return yield* ScriptError.make({
              message: `Vector benchmark returned ${scores?.size ?? 0}/${expectedSize} results without the exact target ${expectedUri}.`,
            });
          }
          oracleControls.push({query: [...lastQueryVector], scores: new Map(scores)});
          const digest = sha256HexSync(JSON.stringify([...(scores ?? [])]));
          if (pairedDigest !== undefined && pairedDigest !== digest)
            return yield* ScriptError.make({
              message: 'Observed/control request outputs differ; overhead comparison discarded.',
            });
          pairedDigest = digest;
          correctness.push(digest);
          const milliseconds = Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND;
          if (sample === 0) firstUseDurations.push(milliseconds);
          else if (observed || !options.stageAttribution) {
            queryDurations.push(milliseconds);
            queryCpu.push((cpu.user + cpu.system) / 1000);
          } else observerControlDurations.push(milliseconds);
          if (tracing) {
            const projectionStarted = performance.now();
            stageSamples.push({sample, observation: vectorStageObservation(tracing.snapshot())});
            if (sample > 0) observerProjectionDurations.push(performance.now() - projectionStarted);
          }
          queryRssAfterBytes = Math.max(queryRssAfterBytes, process.memoryUsage().rss);
        }
      }
    }).pipe(Effect.ensuring(Effect.sync(() => queryRss.stop())));
    queryRssAfterBytes = Math.max(queryRssAfterBytes, queryRss.peak());

    const externalTelemetry = yield* externalSampler.stop();
    const treePhase = externalTelemetry.phases['vector-query'];
    const treePeakRssBytes =
      externalTelemetry.processTelemetry.availability === 'available' && (treePhase?.processSamples ?? 0) > 0
        ? treePhase?.rssPeakBytes
        : undefined;
    for (const control of oracleControls) assertScalarOracle(databasePath, control.query, control.scores);
    Bun.gc(true);
    queryPhase = false;
    const changedCandidates = [
      ...candidates.slice(0, -1),
      {
        text: `# Vector benchmark ${options.documents - 1}\n\nChanged vector benchmark document ${options.documents - 1}.`,
        uri: candidates.at(-1)!.uri,
      },
    ];
    const incrementalRss = startRssSampler();
    let incrementalPeakRssBytes = incrementalRss.peak();
    const incrementalStartedAt = yield* Clock.currentTimeNanos;
    const incremental = yield* rebuildVectorIndex({agentContextHome: home}, manifest, changedCandidates, {
      onProgress: () =>
        Effect.sync(() => {
          incrementalPeakRssBytes = Math.max(incrementalPeakRssBytes, process.memoryUsage().rss);
        }),
    }).pipe(Effect.ensuring(Effect.sync(() => incrementalRss.stop())));
    const incrementalFinishedAt = yield* Clock.currentTimeNanos;
    incrementalPeakRssBytes = Math.max(incrementalPeakRssBytes, incrementalRss.peak(), process.memoryUsage().rss);
    const incrementalDatabaseBytes = Number((yield* fs.stat(databasePath)).size);
    const database = new Database(databasePath, {readonly: true});
    const storage = (() => {
      try {
        return {
          chunkMappings: count(database, 'vector_chunks'),
          generations: count(database, 'vector_generations'),
          vectorValues: count(database, 'vector_values'),
        };
      } finally {
        database.close();
      }
    })();
    const incrementalCompactedPath = path.join(home, 'incremental-vector-index.compacted.sqlite');
    createCompactedSqliteSnapshot(databasePath, incrementalCompactedPath);
    const incrementalCompactedBytes = Number((yield* fs.stat(incrementalCompactedPath)).size);
    const storageBudget = assessVectorDatabaseStorage(
      options.documents,
      {compactedBytes: initialCompactedBytes, databaseBytes: initialDatabaseBytes},
      {compactedBytes: incrementalCompactedBytes, databaseBytes: incrementalDatabaseBytes},
    );
    const sortedQueryDurations = [...queryDurations].sort((left, right) => left - right);
    const initialBuildMilliseconds = Number(initialFinishedAt - initialStartedAt) / NANOSECONDS_PER_MILLISECOND;
    const incrementalBuildMilliseconds =
      Number(incrementalFinishedAt - incrementalStartedAt) / NANOSECONDS_PER_MILLISECOND;
    const semanticQueryP95Milliseconds = percentile(sortedQueryDurations, 0.95);
    const performanceBudget = assessRecallVectorPerformance(options.documents, {
      incrementalBuildMilliseconds,
      initialBuildMilliseconds,
      semanticQueryP95Milliseconds,
    });
    const warmStageSamples = EffectArray.filter(stageSamples, sample => sample.sample > 0);
    const stagesAvailable =
      options.stageAttribution &&
      warmStageSamples.length === options.samples &&
      EffectArray.every(warmStageSamples, sample => sample.observation.available);
    const artifact = parseBenchmarkArtifactV1({
      version: 1,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      suite: 'native-performance-recall-vector-diagnostic-v1',
      warmups: 1,
      environment: {
        architecture: process.arch,
        commit: sourceCommit,
        dirty,
        cpu: hardware.cpuModel,
        memoryBytes: hardware.memoryBytes,
        fixtureHash: sha256HexSync(
          JSON.stringify({
            documents: options.documents,
            distribution: options.distribution,
            dimensions: manifest.dimensions,
          }),
        ),
        model: {
          backend: options.modelFile ? 'node-llama-cpp-query/synthetic-documents' : 'mock',
          id: manifest.id,
          revision: manifest.revision,
        },
        node: process.version,
        operatingSystem: hardware.operatingSystem,
        packageManager: `bun@${Bun.version}`,
        runner: 'benchmark-recall-vectors.ts',
        runnerVersion: 'native-performance-v1',
      },
      measurements: [
        benchmarkMeasurement('first-use-request', 'milliseconds', firstUseDurations),
        benchmarkMeasurement('warm-request', 'milliseconds', queryDurations),
        benchmarkMeasurement('warm-parent-cpu', 'milliseconds', queryCpu),
        benchmarkMeasurement('parent-peak-rss', 'bytes', [queryRssAfterBytes]),
        ...(treePeakRssBytes === undefined
          ? []
          : [benchmarkMeasurement('process-tree-sampled-peak-rss', 'bytes', [treePeakRssBytes])]),
        benchmarkMeasurement('database', 'bytes', [initialDatabaseBytes]),
        ...(observerControlDurations.length
          ? [
              benchmarkMeasurement('warm-observer-disabled-control', 'milliseconds', observerControlDurations),
              benchmarkMeasurement('observer-postprocessing', 'milliseconds', observerProjectionDurations),
            ]
          : []),
        ...(stagesAvailable
          ? [
              benchmarkMeasurement(
                'warm-sql-row-transport',
                'milliseconds',
                EffectArray.flatMap(warmStageSamples, sample =>
                  sample.observation.available ? [sample.observation.request.coveredMilliseconds] : [],
                ),
              ),
              benchmarkMeasurement(
                'warm-reader-exclusive-sql-residual',
                'milliseconds',
                EffectArray.flatMap(warmStageSamples, sample =>
                  sample.observation.available ? [sample.observation.reader.exclusiveResidualMilliseconds] : [],
                ),
              ),
            ]
          : []),
      ],
      metadata: {
        documents: options.documents,
        distribution: options.distribution,
        modelSha256: manifest.sha256,
        modelPurpose: 'recall',
        inference: options.modelFile ? 'real-query' : 'mock',
        correctnessDigest: sha256HexSync(JSON.stringify(correctness)),
        qualification: false,
        stageMethod: options.stageAttribution ? 'actual-sql-spans-union-v1/interleaved-observer-control' : 'disabled',
      },
    });
    const closingSource = yield* readBenchmarkSourceFence();
    const changedSource = nativePerformanceSourceChanges(openingSource, closingSource);
    if (changedSource.length > 0) {
      if (options.output) {
        yield* fs.makeDirectory(path.dirname(options.output), {recursive: true});
        yield* fs.writeFileString(
          options.output,
          `${JSON.stringify({version: 1, kind: 'mixed-source', changedSource, opening: openingSource, closing: closingSource, measurementsDiscarded: true}, undefined, 2)}\n`,
        );
      }
      return yield* ScriptError.make({
        message: `Mixed-source capture; measurements discarded: ${EffectArray.join(changedSource, ', ')}`,
      });
    }
    const limitations = [
      'Synthetic document embeddings; real-query mode verifies the pinned installed model without downloading it.',
      options.stageAttribution
        ? 'Actual SQLite spans include compilation/acquisition/native SQL and row construction; reader-exclusive-SQL residual includes validation/scoring/top-k plus transaction/session/reader control, not pure math.'
        : 'Stage attribution disabled; no SQL/scoring split claimed.',
      options.stageAttribution
        ? `Stage mode alternates observed/control order for${options.samples} matched warm query pairs: ${options.samples} primary observed requests and${options.samples} separately labeled observer-disabled controls. Tracer construction/completion is inside observed request clocks; interval projection is timed separately outside the request.`
        : 'Stage attribution disabled: no observer-control requests or interval projection are recorded.',
      'Parent CPU uses process.cpuUsage; external process-tree RSS samples (effective interval retained in telemetry) can miss peaks and cover the whole query phase. See sampler availability, failures and maximum gap.',
      'First-use is the first retrieval after fixture build, not cold process or filesystem cache.',
      'Independent fixture-oracle work runs after the query phase and external sampler have stopped.',
      'No native comparison or qualification; crypto refresh and Linux paired captures remain required.',
    ];
    const {capture} = parseNativePerformanceCapture(
      {
        version: 1,
        kind: 'diagnostic',
        component: 'vector',
        platform: `${process.platform}-${process.arch}`,
        workload: {
          kind: 'vector',
          documents: options.documents,
          dimensions: manifest.dimensions,
          distribution: options.distribution,
        },
        sourceFence: {opening: openingSource, closing: closingSource},
        inference: options.modelFile
          ? {
              kind: 'real-query',
              purpose: 'recall',
              weightsVerified: true,
              templateIdentity: `manifest-query-prefix-v1:${sha256HexSync(JSON.stringify(manifest.promptPrefixes))}`,
              model: {...artifact.environment.model, sha256: manifest.sha256, dimensions: manifest.dimensions},
            }
          : {kind: 'mock'},
        pair: options.pair,
        arm: options.arm,
        configurationHash: sha256HexSync(
          JSON.stringify({
            fixture: artifact.environment.fixtureHash,
            model: artifact.environment.model,
            modelSha256: manifest.sha256,
            runtime: Bun.version,
            cpu: hardware.cpuModel,
            operatingSystem: hardware.operatingSystem,
            architecture: process.arch,
            instrumentationHash,
            samples: options.samples,
            stageAttribution: options.stageAttribution,
          }),
        ),
        identities: {
          model: `${manifest.id}:${manifest.revision}:${manifest.sha256}`,
          purpose: 'recall',
          platform: `${process.platform}-${process.arch}`,
          method: options.stageAttribution
            ? 'selectedSemanticScores/sql-span-union-v1/interleaved-observer-control'
            : 'selectedSemanticScores',
          template: `manifest-query-prefix-v1:${sha256HexSync(JSON.stringify(manifest.promptPrefixes))}`,
          dimensions: String(manifest.dimensions),
          fixture: artifact.environment.fixtureHash,
          runtime: Bun.version,
          workers: '0',
          grammar: 'not-applicable',
          sampler:
            'existing external recursive process-tree sampler (effective interval in telemetry); parent RSS interval2ms; parent process.cpuUsage request delta',
          boundary: 'selectedSemanticScores with synthetic document embeddings',
        },
        correctnessDigest: artifact.metadata.correctnessDigest,
        firstUseMeasurement: 'first-use-request',
        warmMeasurement: 'warm-request',
        cpuMeasurement: 'warm-parent-cpu',
        ...(treePeakRssBytes === undefined ? {} : {processTreePeakRssMeasurement: 'process-tree-sampled-peak-rss'}),
        diskMeasurement: 'database',
        stages: EffectRecord.fromEntries(
          EffectArray.map(
            NATIVE_PERFORMANCE_STAGES,
            stage =>
              [
                stage,
                stage === 'sql-row-transport'
                  ? stagesAvailable
                    ? {
                        state: 'measured',
                        measurement: 'warm-sql-row-transport',
                        boundary:
                          'Actual request SQLite span UNION: SQL compilation/acquisition/native execution and row construction',
                      }
                    : {
                        state: 'unavailable',
                        reason: 'Observer disabled or incomplete span coverage; see raw stage observations',
                      }
                  : stage === 'validation-scoring-top-k'
                    ? stagesAvailable
                      ? {
                          state: 'measured',
                          measurement: 'warm-reader-exclusive-sql-residual',
                          boundary:
                            'Observed reader envelope minus UNION of its SQLite intervals: validation/scoring/top-k plus reader/transaction/control residual, not pure math',
                        }
                      : {
                          state: 'unavailable',
                          reason: 'Observer disabled or inconsistent span coverage; see raw stage observations',
                        }
                    : {state: 'not-applicable', reason: 'Vector workload'},
              ] as const,
          ),
        ),
        limitations,
      },
      artifact,
    );
    const result = {
      nativePerformance: {
        contract: NATIVE_PERFORMANCE_CONTRACT,
        artifact,
        capture,
        instrumentationHash,
        processTreeSampler: externalTelemetry,
        captureStartedAt,
        captureFinishedAt: DateTime.formatIso(yield* DateTime.now),
        rawWarmMilliseconds: queryDurations,
        rawWarmCpuMilliseconds: queryCpu,
        rawFirstUseMilliseconds: firstUseDurations,
        stageAttribution: {
          observerPairs: options.stageAttribution
            ? EffectArray.map(queryDurations, (observedMilliseconds, index) => ({
                sample: index + 1,
                order: (index + 1) % 2 === 0 ? 'control-first' : 'observed-first',
                observedMilliseconds,
                controlMilliseconds: observerControlDurations[index],
                signedRequestDeltaMilliseconds: observedMilliseconds - observerControlDurations[index],
                postprocessingMilliseconds: observerProjectionDurations[index],
              }))
            : [],
          enabled: options.stageAttribution,
          stagesAvailable,
          samples: stageSamples,
          observerControlMilliseconds: observerControlDurations,
          observerProjectionMilliseconds: observerProjectionDurations,
          accounting:
            'exclusive wall time subtracts interval UNION; overlapping envelopes are not additive; invalid coverage is unavailable and never clamped',
        },
        limitations,
      },
      budgets: {
        performance: performanceBudget,
      },
      database: {
        bytesAfterIncremental: incrementalDatabaseBytes,
        bytesAfterInitial: initialDatabaseBytes,
        compactedBytesAfterIncremental: incrementalCompactedBytes,
        compactedBytesAfterInitial: initialCompactedBytes,
        incrementalBytes: incrementalDatabaseBytes - initialDatabaseBytes,
        incrementalCompactedBytes: storageBudget.incrementalCompactedBytes,
        ...storage,
      },
      environment: {
        architecture: process.arch,
        bun: Bun.version,
        operatingSystem: process.platform,
      },
      fixture: {
        dimensions: manifest.dimensions,
        documents: options.documents,
        querySamples: options.samples,
      },
      scenarios: {
        incrementalBuild: {
          embeddedChunks: incremental.embeddedChunkCount,
          milliseconds: incrementalBuildMilliseconds,
          peakRssBytes: incrementalPeakRssBytes,
          reusedChunks: incremental.reusedChunkCount,
        },
        initialBuild: {
          embeddedChunks: initial.embeddedChunkCount,
          milliseconds: initialBuildMilliseconds,
          peakRssBytes: initialPeakRssBytes,
        },
        semanticQuery: {
          p50Milliseconds: percentile(sortedQueryDurations, 0.5),
          p95Milliseconds: semanticQueryP95Milliseconds,
          peakRssBytes: queryRssAfterBytes,
          resultCount: Math.min(VECTOR_QUERY_RESULT_LIMIT, options.documents),
          rssDeltaBytes: Math.max(0, queryRssAfterBytes - queryRssBeforeBytes),
          rssAfterBytes: queryRssAfterBytes,
          rssBeforeBytes: queryRssBeforeBytes,
          samples: options.samples,
        },
      },
      suite: 'recall-vector-storage-v1',
      version: 1,
    };
    yield* Console.log(JSON.stringify(result, undefined, 2));
    if (options.output) {
      yield* fs.makeDirectory(path.dirname(options.output), {recursive: true});
      yield* fs.writeFileString(options.output, `${JSON.stringify(result, undefined, 2)}\n`);
    }
    if (options.failOnBudget) {
      if (!performanceBudget.semanticQueryWithinBudget) {
        return yield* ScriptError.make({message: 'Semantic vector query exceeded its linear scale budget.'});
      }
      if (!performanceBudget.initialBuildWithinBudget) {
        return yield* ScriptError.make({message: 'Initial vector build exceeded its linear scale budget.'});
      }
      if (!performanceBudget.incrementalBuildWithinBudget) {
        return yield* ScriptError.make({
          message: 'Incremental vector build exceeded its linear or same-runner normalized budget.',
        });
      }
      const boundedScale = Math.max(1, options.documents / DEFAULT_DOCUMENT_COUNT);
      if (result.scenarios.initialBuild.peakRssBytes > boundedScale * 768 * MEBIBYTE) {
        return yield* ScriptError.make({message: 'Initial vector build exceeded its bounded-memory budget.'});
      }
      if (result.scenarios.incrementalBuild.peakRssBytes > boundedScale * 768 * MEBIBYTE) {
        return yield* ScriptError.make({message: 'Incremental vector build exceeded its bounded-memory budget.'});
      }
      if (result.scenarios.semanticQuery.rssDeltaBytes > 128 * MEBIBYTE) {
        return yield* ScriptError.make({message: 'Semantic vector query exceeded its bounded-memory budget.'});
      }
      if (!storageBudget.databaseBytesWithinBudget) {
        return yield* ScriptError.make({message: 'Vector database exceeded its per-document storage budget.'});
      }
      if (!storageBudget.incrementalCompactedBytesWithinBudget) {
        return yield* ScriptError.make({
          message: 'Incremental vector build caused unexpected compacted database growth.',
        });
      }
      if (incremental.embeddedChunkCount !== 1 || incremental.reusedChunkCount !== options.documents - 1) {
        return yield* ScriptError.make({message: 'Incremental vector build did not reuse all unchanged chunks.'});
      }
      if (storage.vectorValues !== options.documents || storage.chunkMappings !== options.documents) {
        return yield* ScriptError.make({
          message: 'Content-addressed vector storage duplicated unchanged vector values.',
        });
      }
    }
  }),
);

const readBenchmarkSourceFence = Effect.fn('benchmarkRecallVectors.sourceFence')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const command = yield* CommandExecutor;
  const cwd = yield* path.fromFileUrl(new URL('../', import.meta.url));
  const git = (args: readonly string[]) => command.execute('git', args, {cwd, maxOutputBytes: 32 * 1024 * 1024});
  const [commit, trackedDiff, index, status] = yield* Effect.all(
    [
      git(['rev-parse', 'HEAD']),
      git(['diff', '--binary', '--no-ext-diff', 'HEAD', '--']),
      git(['ls-files', '--stage', '-z']),
      git(['status', '--porcelain=v1', '--untracked-files=normal', '-z']),
    ],
    {concurrency: 4},
  );
  return {
    commit: EffectString.trim(commit.stdout),
    dirty: status.stdout.length > 0,
    trackedDiffHash: sha256HexSync(trackedDiff.stdout),
    indexHash: sha256HexSync(index.stdout),
    statusHash: sha256HexSync(status.stdout),
    instrumentationHash: sha256HexSync(yield* fs.readFile(yield* path.fromFileUrl(new URL(import.meta.url)))),
  };
});

BunRuntime.runMain(provideScriptLayer(program, benchmarkLayer));

function deterministicVector(dimensions: number, input: string): readonly number[] {
  if (options.distribution === 'tied') return Array.from({length: dimensions}, () => 1 / Math.sqrt(dimensions));
  const numeric = Number(/(\d+)(?!.*\d)/.exec(input)?.[1] ?? 0);
  if (options.distribution === 'dense') {
    const vector = Array.from({length: dimensions}, (_, index) => Math.sin((numeric + 1) * (index + 1)));
    const magnitude = Math.sqrt(EffectArray.reduce(vector, 0, (sum, value) => sum + value * value));
    return EffectArray.map(vector, value => value / magnitude);
  }
  const vector = new Array<number>(dimensions).fill(0);
  const primary = numeric % dimensions;
  const secondary = (primary + Math.floor(numeric / dimensions) + 1) % dimensions;
  vector[primary] = 2 / Math.sqrt(5);
  vector[secondary] = 1 / Math.sqrt(5);
  return vector;
}

function startRssSampler(): {readonly peak: () => number; readonly stop: () => void} {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 2);
  return {
    peak: () => peak,
    stop: () => clearInterval(timer),
  };
}

function modelInstallation(home: string) {
  return {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: options.modelFile ?? `${home}/models/benchmark.gguf`,
    verified: true,
  };
}

function count(database: Database, table: string): number {
  return Number(
    requiredRow(
      database.query<{readonly count: number}, SQLQueryBindings[]>(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    ).count,
  );
}

function percentile(sorted: readonly number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function parseOptions(arguments_: readonly string[]): {
  readonly arm: 'baseline' | 'candidate';
  readonly pair: number;
  readonly distribution: 'dense' | 'tied' | 'sparse';
  readonly model: string;
  readonly modelFile?: string;
  readonly documents: number;
  readonly failOnBudget: boolean;
  readonly output?: string;
  readonly samples: number;
  readonly stageAttribution: boolean;
} {
  let arm: 'baseline' | 'candidate' = 'baseline';
  let pair = 1;
  let distribution: 'dense' | 'tied' | 'sparse' = 'sparse';
  let model = 'bge-small-en-v1.5-q8';
  let modelFile: string | undefined;
  let documents = DEFAULT_DOCUMENT_COUNT;
  let failOnBudget = false;
  let output: string | undefined;
  let samples = DEFAULT_QUERY_SAMPLES;
  let stageAttribution = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--pair') pair = positiveInteger(arguments_[++index], '--pair');
    else if (argument === '--arm') {
      const value = arguments_[++index];
      if (value !== 'baseline' && value !== 'candidate') throw ScriptError.make({message: 'Invalid arm'});
      arm = value;
    } else if (argument === '--distribution') {
      const value = arguments_[++index];
      if (value !== 'dense' && value !== 'tied' && value !== 'sparse')
        throw ScriptError.make({message: 'Invalid distribution'});
      distribution = value;
    } else if (argument === '--model') model = arguments_[++index];
    else if (argument === '--model-file') modelFile = arguments_[++index];
    else if (argument === '--documents') documents = positiveInteger(arguments_[++index], '--documents');
    else if (argument === '--samples') samples = positiveInteger(arguments_[++index], '--samples');
    else if (argument === '--output') output = arguments_[++index];
    else if (argument === '--stage-attribution') stageAttribution = true;
    else if (argument === '--fail-on-budget') failOnBudget = true;
    else throw ScriptError.make({message: `Unknown vector benchmark option: ${argument}`});
  }
  return {
    ...(output ? {output} : {}),
    ...(modelFile ? {modelFile} : {}),
    arm,
    pair,
    distribution,
    model,
    documents,
    failOnBudget,
    samples,
    stageAttribution,
  };
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw ScriptError.make({message: `${option} requires a positive integer.`});
  return parsed;
}

/** Independent full-sort oracle over fixture rows, outside every measured request. */
function assertScalarOracle(databasePath: string, query: readonly number[], actual: ReadonlyMap<string, number>): void {
  const database = new Database(databasePath, {readonly: true});
  try {
    const magnitude = Math.sqrt(EffectArray.reduce(query, 0, (sum, value) => sum + value * value));
    const inverseMagnitude = 1 / magnitude;
    const normalized = EffectArray.map(query, value => value * inverseMagnitude);
    const rows = database
      .query<{chunk_id: string; uri: string; vector: Uint8Array}, []>(
        'SELECT chunk.chunk_id, chunk.uri, value.vector FROM vector_chunks chunk JOIN vector_values value ON value.id = chunk.vector_id',
      )
      .all();
    const ranked = EffectArray.map(rows, row => {
      const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      let score = 0;
      for (let index = 0; index < normalized.length; index += 1)
        score += normalized[index] * view.getFloat32(index * 4, true);
      return {id: row.chunk_id, uri: row.uri, score: Math.max(-1, Math.min(1, score))};
    }).sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    // Preserve negative-score ranking before the presentation clamp.
    const expected = ranked.slice(0, VECTOR_QUERY_RESULT_LIMIT);
    if (
      expected.length !== actual.size ||
      EffectArray.some(expected, row => actual.get(row.uri) !== Math.max(0, row.score))
    ) {
      throw ScriptError.make({message: 'Real-query result differs from independent full-sort fixture oracle.'});
    }
  } finally {
    database.close();
  }
}

function vectorStageObservation(snapshot: ReturnType<ReturnType<typeof createNativeStageTracing>['snapshot']>) {
  const requests = EffectArray.filter(snapshot.spans, span => span.name === 'vectorIndex.selectedSemanticScores');
  const readers = EffectArray.filter(snapshot.spans, span => span.name === 'vectorIndex.readSelectedScores');
  const sql = EffectArray.filter(snapshot.spans, span => span.name === 'sqlite');
  if (
    snapshot.overflow ||
    requests.length !== 1 ||
    readers.length !== 1 ||
    sql.length === 0 ||
    EffectArray.some(snapshot.spans, span => !span.success)
  ) {
    return {
      available: false as const,
      errors: ['missing/failed/overflowed request, reader or SQL spans'],
      requestCount: requests.length,
      readerCount: readers.length,
      sqlCount: sql.length,
    };
  }
  const request = nativeStagePartition(requests[0], sql);
  const readerSql = EffectArray.filter(sql, span => span.end > readers[0].start && span.start < readers[0].end);
  const reader = nativeStagePartition(readers[0], readerSql);
  if (!request.available || !reader.available || readerSql.length === 0)
    return {available: false as const, errors: ['inconsistent or missing SQL coverage'], request, reader};
  return {available: true as const, request, reader, requestSqlCount: sql.length, readerSqlCount: readerSql.length};
}
