import {BACKGROUND_INFERENCE_ENV} from '@threadnote/inference/background/admission';
import {
  collectDevelopmentPayloadManifest,
  developmentPayloadManifestSha256,
  parseDevelopmentInstallReceipt,
} from './development-runtime.js';
import {
  verifyNativeInferenceOverlay,
  NATIVE_INFERENCE_DESCRIPTOR,
  nativeInferencePayloadPath,
} from './native-inference-payload.js';
import {localModelRuntimeLayer} from '@threadnote/inference/engine/local-model-runtime';
import {
  nodeLlamaCppEngineLayer,
  parseEmbeddingContextPoolSize,
  THREADNOTE_EMBEDDING_CONTEXTS_ENV,
} from '@threadnote/inference/engine/node-llama-cpp';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {deriveRecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {RecallReadyReadBoundary, RecallReadyReadBoundaryError} from '@threadnote/recall/read_boundary';
import {makeReadDeadline} from '@threadnote/platform/read_deadline';
import {verifyNativeVectorReaderPayload} from '@threadnote/recall/vector/native-reader-payload';
import {makeReadyRecallReadBoundary} from '@threadnote/threadnote/recall/ready_read_boundary';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {startExternalSampler} from './benchmark-code-graph.js';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {ScriptCommandExecutorLayer, ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError, scriptError} from './effect/errors.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {BunRuntime} from '@effect/platform-bun';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {Clock, Console, Context, DateTime, Effect, FileSystem, Layer, Path, Schema} from 'effect';
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
const options = parseOptions(import.meta.main ? process.argv.slice(2) : []);
let queryPhase = false;
let parentRuntimeInitializationMilliseconds: number | undefined;
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
        (options.productionPath && options.distributionRoot
          ? Layer.effect(
              LocalModelRuntime,
              Effect.gen(function* () {
                const path = yield* Path.Path;
                const root = path.resolve(options.distributionRoot!);
                yield* verifyNativeInferenceOverlay(root);
                const moduleSpecifier = (yield* path.toFileUrl(path.join(root, 'runtime', 'node-llama-cpp.js'))).href;
                const started = yield* Clock.currentTimeNanos;
                const context = yield* Layer.build(localModelRuntimeLayer(nodeLlamaCppEngineLayer({moduleSpecifier})));
                parentRuntimeInitializationMilliseconds =
                  Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND;
                return Context.get(context, LocalModelRuntime);
              }),
            )
          : LocalModelRuntime.nativeLayer
        ).pipe(Layer.provide(Layer.mergeAll(BunServices.layer, ScriptSystemInfoLayer))),
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

type ProductionBackend = 'baseline' | 'candidate';
interface ProductionQuerySample {
  readonly sample: number;
  readonly milliseconds: number;
  readonly success: boolean;
  readonly reason?: string;
  readonly querySha256?: string;
  readonly scoresSha256?: string;
  readonly children: readonly {operation: string; milliseconds: number; timeoutMs: number | undefined}[];
}
interface ProductionArmCapture {
  readonly pair: number;
  readonly backend: ProductionBackend;
  readonly samples: ProductionQuerySample[];
  readonly parentMemoryAtArmStart: ReturnType<typeof process.memoryUsage>;
  sampler?: Effect.Success<ReturnType<Effect.Success<ReturnType<typeof startExternalSampler>>['stop']>>;
  p95Milliseconds?: number;
  sampledTreePeakRssBytes?: number;
  resourceEvidenceComplete?: boolean;
  samplerSetupMilliseconds?: number;
  samplerStopMilliseconds?: number;
}

const productionSourcePaths = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  ':(glob)packages/*/src/**',
  ':(glob)packages/*/package.json',
  'apps/threadnote/src',
  'packages/recall/native-vector-reader/Cargo.toml',
  'packages/recall/native-vector-reader/Cargo.lock',
  'packages/recall/native-vector-reader/build.rs',
  'packages/recall/native-vector-reader/rust-toolchain.toml',
  'packages/recall/native-vector-reader/src',
  'scripts/benchmark-recall-vectors.ts',
  'scripts/benchmark-code-graph.ts',
  'scripts/code-graph-benchmark-sampler.ts',
  'scripts/windows-process-tree-sampler.ts',
  'scripts/windows-process-tree-sampler.ps1',
  'scripts/native-inference-payload.ts',
  'scripts/development-runtime.ts',
  'scripts/effect',
] as const;

const productionSourceFence = (candidateCommit: string) =>
  Effect.gen(function* () {
    const source = yield* readBenchmarkSourceFence();
    const path = yield* Path.Path;
    const command = yield* CommandExecutor;
    const cwd = yield* path.fromFileUrl(new URL('../', import.meta.url));
    const [difference, untracked, candidateHarness] = yield* Effect.all(
      [
        command.execute('git', ['diff', '--binary', '--no-ext-diff', candidateCommit, '--', ...productionSourcePaths], {
          cwd,
          maxOutputBytes: 32 * MEBIBYTE,
        }),
        command.execute('git', ['ls-files', '--others', '--exclude-standard', '--', ...productionSourcePaths], {cwd}),
        command.execute('git', ['show', `${candidateCommit}:scripts/benchmark-recall-vectors.ts`], {
          cwd,
          maxOutputBytes: MEBIBYTE,
        }),
      ],
      {concurrency: 2},
    );
    return {
      ...source,
      runtimeAndHarnessMatchCandidate:
        difference.stdout === '' &&
        untracked.stdout === '' &&
        source.instrumentationHash === sha256HexSync(candidateHarness.stdout),
      candidateHarnessSha256: sha256HexSync(candidateHarness.stdout),
      runtimeAndHarnessDiffSha256: sha256HexSync(difference.stdout),
      untrackedRuntimePathsSha256: sha256HexSync(untracked.stdout),
    };
  });

export const productionDistributionInventory = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: {path: string; sha256: string}[] = [];
    const visit = (directory: string): Effect.Effect<void, unknown, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        for (const name of (yield* fs.readDirectory(directory)).sort()) {
          const filename = path.join(directory, name);
          if (EffectOption.isSome(yield* fs.readLink(filename).pipe(Effect.option)))
            return yield* ScriptError.make({message: 'Production distributions cannot contain symlinks.'});
          const stat = yield* fs.stat(filename);
          if (stat.type === 'Directory') yield* visit(filename);
          else if (stat.type === 'File') {
            files.push({
              path: Effect2.pipe(path.relative(root, filename), EffectString.replaceAll('\\', '/')),
              sha256: sha256HexSync(yield* fs.readFile(filename)),
            });
          } else return yield* ScriptError.make({message: 'Unexpected distribution entry in production benchmark.'});
        }
      });
    yield* visit(root);
    return files;
  });

export const FROZEN_TYPESCRIPT_BASELINE_COMMIT = '66f4c1d8baed033ec484f4db2895ea2252b4e2d0';
const FROZEN_TYPESCRIPT_BASELINE_TREE = '6a2fe890e271866b797f2c4279bae8f2b2326ea4';
const BASELINE_PROVENANCE = 'baseline-build-provenance.json';
const InventoryEntrySchema = Schema.Struct({path: Schema.String, sha256: Schema.String});
const BaselineBuildSchema = Schema.Struct({
  format: Schema.Literal('threadnote-frozen-ts-baseline-build-v1'),
  origin: Schema.Literals(['frozen-source-build', 'verified-development-install']),
  originalReceipt: Schema.optionalKey(Schema.Unknown),
  source: Schema.Struct({
    commit: Schema.String,
    tree: Schema.String,
    dirty: Schema.Literal(false),
    packageSha256: Schema.String,
    lockfileSha256: Schema.String,
  }),
  build: Schema.Struct({
    command: Schema.Literals(['bun run build', 'existing-development-install-receipt']),
    dependencyInstallation: Schema.optionalKey(Schema.String),
    target: Schema.String,
    runtime: Schema.String,
    bun: Schema.String,
  }),
  executable: Schema.Struct({path: Schema.String, sha256: Schema.String}),
  releaseMetadataSha256: Schema.String,
  originalInventory: Schema.Array(InventoryEntrySchema),
  originalInventorySha256: Schema.String,
});
const baselineReleaseSchema = Schema.Struct({
  executable: Schema.String,
  runtime: Schema.String,
  target: Schema.String,
  version: Schema.String,
});

/** Baseline dependencies are staged without lifecycle builds/downloads; GNU optional inputs are build-only on musl. */
export function validateBaselineDependencyInstallation(target: string, command: string | undefined): string {
  const expected = `bun install --frozen-lockfile --ignore-scripts${EffectString.endsWith('-musl')(target) ? ' --libc=glibc' : ''}`;
  if (command !== expected)
    throw ScriptError.make({
      message: 'Baseline dependency staging command does not match its target or lifecycle policy.',
    });
  return command;
}

/** Benchmark build provenance is deliberately distinct from an installation receipt. Run BEFORE an overlay. */
export const writeBaselineBuildProvenance = (
  sourceRoot: string | undefined,
  distributionRoot: string | undefined,
  dependencyInstallation?: string,
) =>
  Effect.gen(function* () {
    if (!distributionRoot)
      return yield* ScriptError.make({
        message: 'Baseline provenance requires --baseline-distribution-root.',
      });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const command = yield* CommandExecutor;
    if (!sourceRoot) return yield* writeInstalledBaselineProvenance(distributionRoot);
    const source = path.resolve(sourceRoot);
    const root = path.resolve(distributionRoot);
    const git = (args: readonly string[]) => command.execute('git', args, {cwd: source, maxOutputBytes: MEBIBYTE});
    const commit = EffectString.trim((yield* git(['rev-parse', 'HEAD'])).stdout);
    const tree = EffectString.trim((yield* git(['rev-parse', 'HEAD^{tree}'])).stdout);
    if (
      commit !== FROZEN_TYPESCRIPT_BASELINE_COMMIT ||
      tree !== FROZEN_TYPESCRIPT_BASELINE_TREE ||
      (yield* git(['status', '--porcelain=v1', '--untracked-files=normal'])).stdout !== ''
    )
      return yield* ScriptError.make({message: 'Baseline provenance requires clean exact frozen TS66 source.'});
    if (yield* fs.exists(path.join(root, NATIVE_INFERENCE_DESCRIPTOR)))
      return yield* ScriptError.make({
        message: 'Record original baseline provenance before staging the inference overlay.',
      });
    const release = yield* Schema.decodeUnknownEffect(baselineReleaseSchema)(
      JSON.parse(yield* fs.readFileString(path.join(root, 'release.json'))),
    );
    const originalInventory = EffectArray.filter(
      yield* productionDistributionInventory(root),
      entry => entry.path !== BASELINE_PROVENANCE && entry.path !== 'development-install.json',
    );
    const executableSha256 = sha256HexSync(yield* fs.readFile(path.join(root, release.executable)));
    const provenance = {
      format: 'threadnote-frozen-ts-baseline-build-v1' as const,
      origin: 'frozen-source-build' as const,
      source: {
        commit,
        tree,
        dirty: false as const,
        packageSha256: sha256HexSync((yield* git(['show', 'HEAD:package.json'])).stdout),
        lockfileSha256: sha256HexSync((yield* git(['show', 'HEAD:bun.lock'])).stdout),
      },
      build: {
        command: 'bun run build' as const,
        dependencyInstallation: validateBaselineDependencyInstallation(release.target, dependencyInstallation),
        target: release.target,
        runtime: release.runtime,
        bun: Bun.version,
      },
      executable: {path: release.executable, sha256: executableSha256},
      releaseMetadataSha256: sha256HexSync(yield* fs.readFile(path.join(root, 'release.json'))),
      originalInventory,
      originalInventorySha256: sha256HexSync(JSON.stringify(originalInventory)),
    };
    if (release.runtime !== `bun-${Bun.version}` || !EffectString.endsWith(`local.g${commit}`)(release.version))
      return yield* ScriptError.make({message: 'Frozen baseline runtime/version does not match its build provenance.'});
    yield* fs.writeFileString(path.join(root, BASELINE_PROVENANCE), `${JSON.stringify(provenance, null, 2)}\n`);
    return provenance;
  });

/** Compare the semantic distribution outside the explicitly replaced inference component. */
export function baselineSemanticInventoryUnchanged(
  original: readonly {path: string; sha256: string}[],
  final: readonly {path: string; sha256: string}[],
): boolean {
  const semantic = (entries: readonly {path: string; sha256: string}[]) =>
    EffectArray.filter(
      entries,
      entry =>
        entry.path !== BASELINE_PROVENANCE &&
        entry.path !== 'development-install.json' &&
        entry.path !== NATIVE_INFERENCE_DESCRIPTOR &&
        !nativeInferencePayloadPath(entry.path),
    );
  return JSON.stringify(semantic(original)) === JSON.stringify(semantic(final));
}

export const verifyFrozenBaseline = (root: string, candidateTarget: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const command = yield* CommandExecutor;
    const cwd = yield* path.fromFileUrl(new URL('../', import.meta.url));
    const release = yield* Schema.decodeUnknownEffect(baselineReleaseSchema)(
      JSON.parse(yield* fs.readFileString(path.join(root, 'release.json'))),
    );
    if (
      release.target !== candidateTarget ||
      release.runtime !== `bun-${Bun.version}` ||
      release.version !== `5.3.6-local.g${FROZEN_TYPESCRIPT_BASELINE_COMMIT}`
    )
      return yield* ScriptError.make({
        message: 'Baseline must be the frozen TS66 build for the candidate target and parent Bun.',
      });
    if (yield* fs.exists(path.join(root, 'runtime', 'vector-reader')))
      return yield* ScriptError.make({message: 'Frozen TS baseline unexpectedly contains the native vector reader.'});
    const packageSha256 = sha256HexSync(
      (yield* command.execute('git', ['show', `${FROZEN_TYPESCRIPT_BASELINE_COMMIT}:package.json`], {cwd})).stdout,
    );
    const lockfileSha256 = sha256HexSync(
      (yield* command.execute('git', ['show', `${FROZEN_TYPESCRIPT_BASELINE_COMMIT}:bun.lock`], {
        cwd,
        maxOutputBytes: 4 * MEBIBYTE,
      })).stdout,
    );
    const executableSha256 = sha256HexSync(yield* fs.readFile(path.join(root, release.executable)));
    const releaseMetadataSha256 = sha256HexSync(yield* fs.readFile(path.join(root, 'release.json')));
    const finalInventory = yield* productionDistributionInventory(root);
    if (yield* fs.exists(path.join(root, BASELINE_PROVENANCE))) {
      const provenance = yield* Schema.decodeUnknownEffect(BaselineBuildSchema)(
        JSON.parse(yield* fs.readFileString(path.join(root, BASELINE_PROVENANCE))),
      );
      if (
        provenance.source.commit !== FROZEN_TYPESCRIPT_BASELINE_COMMIT ||
        provenance.source.tree !== FROZEN_TYPESCRIPT_BASELINE_TREE ||
        provenance.source.packageSha256 !== packageSha256 ||
        provenance.source.lockfileSha256 !== lockfileSha256 ||
        provenance.build.target !== release.target ||
        provenance.build.runtime !== release.runtime ||
        provenance.build.bun !== Bun.version ||
        provenance.executable.path !== release.executable ||
        provenance.executable.sha256 !== executableSha256 ||
        provenance.releaseMetadataSha256 !== releaseMetadataSha256 ||
        provenance.originalInventorySha256 !== sha256HexSync(JSON.stringify(provenance.originalInventory))
      )
        return yield* ScriptError.make({
          message: 'Frozen baseline build provenance does not match its source/executable.',
        });
      if (provenance.origin === 'verified-development-install') {
        const originalReceipt = EffectOption.getOrUndefined(parseDevelopmentInstallReceipt(provenance.originalReceipt));
        if (
          !originalReceipt ||
          provenance.build.command !== 'existing-development-install-receipt' ||
          originalReceipt.sourceCommit !== provenance.source.commit ||
          originalReceipt.sourcePackageManifestSha256 !== packageSha256 ||
          originalReceipt.sourceLockfileSha256 !== lockfileSha256 ||
          originalReceipt.executableSha256 !== executableSha256 ||
          originalReceipt.releaseMetadataSha256 !== releaseMetadataSha256 ||
          originalReceipt.target !== release.target ||
          (yield* developmentPayloadManifestSha256(originalReceipt.payloadManifest)) !==
            originalReceipt.payloadManifestSha256 ||
          JSON.stringify(
            EffectArray.map(originalReceipt.payloadManifest, entry => ({path: entry.path, sha256: entry.sha256})),
          ) !== JSON.stringify(provenance.originalInventory)
        )
          return yield* ScriptError.make({
            message: 'Original development receipt does not authenticate the baseline component provenance.',
          });
      } else if (
        provenance.build.command !== 'bun run build' ||
        provenance.originalReceipt !== undefined ||
        provenance.build.dependencyInstallation !==
          validateBaselineDependencyInstallation(release.target, provenance.build.dependencyInstallation)
      )
        return yield* ScriptError.make({message: 'CI baseline provenance is not an installation receipt.'});
      const overlay = yield* verifyNativeInferenceOverlay(root);
      if (
        overlay.bunTarget !== candidateTarget ||
        overlay.bunVersion !== Bun.version ||
        !baselineSemanticInventoryUnchanged(provenance.originalInventory, finalInventory)
      )
        return yield* ScriptError.make({
          message: 'Baseline differs from its original closure beyond the declared shared inference overlay.',
        });
      return {
        kind: 'benchmark-build-with-inference-overlay' as const,
        release,
        executableSha256,
        releaseMetadataSha256,
        source: provenance.source,
        provenance,
        overlay,
        finalInventory,
        finalInventorySha256: sha256HexSync(JSON.stringify(finalInventory)),
      };
    }
    const receipt = EffectOption.getOrUndefined(
      parseDevelopmentInstallReceipt(JSON.parse(yield* fs.readFileString(path.join(root, 'development-install.json')))),
    );
    if (
      !receipt ||
      receipt.sourceCommit !== FROZEN_TYPESCRIPT_BASELINE_COMMIT ||
      receipt.sourcePackageManifestSha256 !== packageSha256 ||
      receipt.sourceLockfileSha256 !== lockfileSha256 ||
      receipt.executableSha256 !== executableSha256 ||
      receipt.releaseMetadataSha256 !== releaseMetadataSha256 ||
      receipt.target !== release.target ||
      receipt.runtime !== release.runtime
    )
      return yield* ScriptError.make({message: 'Genuine frozen development receipt does not match the baseline.'});
    const originalManifest = yield* collectDevelopmentPayloadManifest(root);
    if (
      JSON.stringify(originalManifest) !== JSON.stringify(receipt.payloadManifest) ||
      (yield* developmentPayloadManifestSha256(originalManifest)) !== receipt.payloadManifestSha256
    )
      return yield* ScriptError.make({message: 'Installed TS66 baseline payload differs from its genuine receipt.'});
    return {
      kind: 'original-development-install' as const,
      release,
      executableSha256,
      releaseMetadataSha256,
      source: {
        commit: receipt.sourceCommit,
        tree: FROZEN_TYPESCRIPT_BASELINE_TREE,
        dirty: false as const,
        packageSha256,
        lockfileSha256,
      },
      receipt,
      overlay: undefined,
      finalInventory,
      finalInventorySha256: sha256HexSync(JSON.stringify(finalInventory)),
    };
  });

/** Preserve an authenticated local original BEFORE applying a shared inference overlay to its private copy. */
export const writeInstalledBaselineProvenance = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const release = yield* Schema.decodeUnknownEffect(baselineReleaseSchema)(
      JSON.parse(yield* fs.readFileString(path.join(root, 'release.json'))),
    );
    const original = yield* verifyFrozenBaseline(root, release.target);
    if (original.kind !== 'original-development-install')
      return yield* ScriptError.make({
        message: 'Local original provenance requires the genuine unmodified development installation.',
      });
    const originalInventory = EffectArray.map(original.receipt.payloadManifest, entry => ({
      path: entry.path,
      sha256: entry.sha256,
    }));
    const provenance = {
      format: 'threadnote-frozen-ts-baseline-build-v1',
      origin: 'verified-development-install',
      originalReceipt: original.receipt,
      source: original.source,
      build: {
        command: 'existing-development-install-receipt',
        dependencyInstallation: original.receipt.dependencyInstallation,
        target: release.target,
        runtime: release.runtime,
        bun: Bun.version,
      },
      executable: {path: release.executable, sha256: original.executableSha256},
      releaseMetadataSha256: original.releaseMetadataSha256,
      originalInventory,
      originalInventorySha256: sha256HexSync(JSON.stringify(originalInventory)),
    };
    yield* fs.writeFileString(path.join(root, BASELINE_PROVENANCE), `${JSON.stringify(provenance, null, 2)}\n`);
    return provenance;
  });

const makeProductionFixture = (home: string, documents: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = {
      account: 'local',
      user: 'benchmark',
      agentContextHome: home,
      manifestPath: path.join(home, 'manifest.yaml'),
    };
    yield* fs.makeDirectory(home, {recursive: true});
    yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
    const directory = path.join(home, 'data/local/user/benchmark/memories/durable/projects/benchmark');
    yield* fs.makeDirectory(directory, {recursive: true});
    // Every vector has its own legitimate canonical source and lexical metadata.
    for (let index = 0; index < documents; index++) {
      yield* fs.writeFileString(
        path.join(directory, `${Effect2.pipe(String(index), EffectString.padStart(6, '0'))}.md`),
        formatMemoryDocument(
          'MEMORY',
          {
            kind: 'durable',
            status: 'active',
            project: 'benchmark',
            memoryId: `tn_vector_benchmark_${index}`,
            sourceAgentClient: 'benchmark',
            timestamp: '2026-11-04T00:00:00.000Z',
          },
          `Unique vector production benchmark document ${index}.`,
        ),
      );
    }
    yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
    const lexical = yield* loadRecallIndexData(config, {includeInactive: false});
    if (lexical.candidates.length !== documents)
      return yield* ScriptError.make({
        message: 'Production benchmark canonical candidate count differs from requested count.',
      });
    const status = yield* rebuildVectorIndex(config, manifest, lexical.candidates, {
      corpusGeneration: lexical.generation,
    });
    if (status.chunkCount !== documents)
      return yield* ScriptError.make({message: 'Production benchmark vector count differs from canonical count.'});
    return {
      config,
      corpusGeneration: lexical.generation,
      documents,
      databasePath: path.join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename()),
    };
  });

const runProductionVectorBenchmark = Effect.scoped(
  Effect.gen(function* () {
    const preflightStartedAt = yield* Clock.currentTimeNanos;
    if (
      !options.output ||
      !options.modelFile ||
      !options.distributionRoot ||
      !options.baselineDistributionRoot ||
      options.distribution === 'sparse' ||
      manifest.id !== 'bge-small-en-v1.5-q8'
    )
      return yield* ScriptError.make({
        message:
          '--production-path requires --output, --model-file for pinned BGE, --distribution-root, independent --baseline-distribution-root and --distribution dense|tied.',
      });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const command = yield* CommandExecutor;
    const runtime = yield* LocalModelRuntime;
    const captureStartedAt = DateTime.formatIso(yield* DateTime.now);
    const modelPath = options.modelFile;
    if (sha256HexSync(yield* fs.readFile(modelPath)) !== manifest.sha256)
      return yield* ScriptError.make({message: 'Production benchmark model differs from the pinned builtin SHA256.'});
    const distributionRoot = path.resolve(options.distributionRoot);
    const nativeManifest = yield* Effect.tryPromise({
      try: () =>
        verifyNativeVectorReaderPayload(path.join(distributionRoot, 'runtime', 'vector-reader', 'manifest.json')),
      catch: scriptError,
    });
    if (nativeManifest.development)
      return yield* ScriptError.make({message: 'Production capture requires a strict standalone payload.'});
    const release = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        executable: Schema.String,
        sourceIdentity: Schema.Struct({
          commit: Schema.String,
          tree: Schema.String,
          target: Schema.String,
          bun: Schema.String,
        }),
      }),
    )(JSON.parse(yield* fs.readFileString(path.join(distributionRoot, 'release.json'))));
    if (
      release.sourceIdentity.commit !== nativeManifest.buildInfo.sourceCommit ||
      release.sourceIdentity.tree !== nativeManifest.buildInfo.sourceTree ||
      release.sourceIdentity.target !== nativeManifest.bunTarget ||
      release.sourceIdentity.bun !== Bun.version
    )
      return yield* ScriptError.make({message: 'Compiled candidate, payload and parent Bun identities must agree.'});
    const openingSource = yield* productionSourceFence(nativeManifest.buildInfo.sourceCommit);
    const baselineDistributionRoot = path.resolve(options.baselineDistributionRoot);
    if ((yield* fs.realPath(baselineDistributionRoot)) === (yield* fs.realPath(distributionRoot)))
      return yield* ScriptError.make({
        message: 'Candidate and independent frozen TS baseline must have separate roots.',
      });
    const baselineEvidence = yield* verifyFrozenBaseline(baselineDistributionRoot, release.sourceIdentity.target);
    const inferenceOverlay = yield* verifyNativeInferenceOverlay(distributionRoot);
    if (inferenceOverlay.bunTarget !== release.sourceIdentity.target || inferenceOverlay.bunVersion !== Bun.version)
      return yield* ScriptError.make({
        message: 'Staged inference target/Bun differs from the native semantic candidate.',
      });
    const inputInventory = yield* productionDistributionInventory(distributionRoot);
    const baselineInputInventory = baselineEvidence.finalInventory;
    for (const file of inferenceOverlay.files) {
      if (
        EffectOption.getOrUndefined(EffectArray.findFirst(baselineInputInventory, entry => entry.path === file.path))
          ?.sha256 !== file.sha256
      )
        return yield* ScriptError.make({
          message: 'Baseline and candidate must use the same verified staged inference closure.',
        });
    }
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-production-'});
    const candidateRoot = path.join(home, 'candidate');
    const baselineRoot = path.join(home, 'baseline');
    // Physical private copies never alter hard-link counts of a globally installed baseline.
    for (const [sourceRoot, destinationRoot, inventory] of [
      [distributionRoot, candidateRoot, inputInventory],
      [baselineDistributionRoot, baselineRoot, baselineInputInventory],
    ] as const) {
      for (const entry of inventory) {
        const source = path.join(sourceRoot, entry.path);
        const destination = path.join(destinationRoot, entry.path);
        yield* fs.makeDirectory(path.dirname(destination), {recursive: true});
        yield* fs.copyFile(source, destination);
        if (system.platform !== 'win32') yield* fs.chmod(destination, (yield* fs.stat(source)).mode & 0o777);
      }
    }
    const candidateInventory = yield* productionDistributionInventory(candidateRoot);
    const baselineInventory = yield* productionDistributionInventory(baselineRoot);
    if (
      JSON.stringify(inputInventory) !== JSON.stringify(candidateInventory) ||
      JSON.stringify(baselineInputInventory) !== JSON.stringify(baselineInventory)
    )
      return yield* ScriptError.make({
        message: 'An independent frozen distribution changed while creating capture arms.',
      });
    const executableFor = (backend: ProductionBackend) =>
      path.join(
        backend === 'candidate' ? candidateRoot : baselineRoot,
        backend === 'candidate' ? release.executable : baselineEvidence.release.executable,
      );
    const distributionSetupMilliseconds =
      Number((yield* Clock.currentTimeNanos) - preflightStartedAt) / NANOSECONDS_PER_MILLISECOND;
    const setupStarted = yield* Clock.currentTimeNanos;
    yield* Console.log(
      `Building ${options.documents} canonical ${options.distribution} documents for compiled production retrieval.`,
    );
    const fixture = yield* makeProductionFixture(path.join(home, 'fixture'), options.documents);
    const setupMilliseconds = Number((yield* Clock.currentTimeNanos) - setupStarted) / NANOSECONDS_PER_MILLISECOND;
    const databaseSha256 = sha256HexSync(yield* fs.readFile(fixture.databasePath));
    const eligibility = deriveRecallEligibilityPolicy({
      explicitProject: 'benchmark',
      originalQuery: 'vector production benchmark',
    });
    const arms: ProductionArmCapture[] = [];
    const executableVerification: {
      backend: ProductionBackend;
      milliseconds: number;
      success: boolean;
      version?: string;
    }[] = [];
    const firstUse: {
      modelMilliseconds?: number;
      requests: {backend: ProductionBackend; result: ProductionQuerySample}[];
    } = {requests: []};
    const oracleControls: {querySha256: string; scoresSha256: string}[] = [];
    const proof: {backend: ProductionBackend; result: ProductionQuerySample}[] = [];
    const pairGates: {
      pair: number;
      baselineP95?: number;
      candidateP95?: number;
      latencyPassed: boolean;
      rssPassed: boolean;
      complete: boolean;
    }[] = [];
    let oracleSetupMilliseconds: number | undefined;
    let discriminatorSetupMilliseconds: number | undefined;
    let parentRuntimeDiagnostics: unknown;
    let sourceStable = false;
    let fixtureStable = false;
    let distributionStable = false;
    let modelStable = false;
    let caseGatesPassed = false;
    let closingSource: typeof openingSource | undefined;
    let fatal: string | undefined;
    const capture = () => ({
      format: 'threadnote-native-vector-production-v2',
      captureStartedAt,
      capturedCandidate: release.sourceIdentity,
      capturedBaseline: baselineEvidence,
      inferenceOverlay,
      sharedParentInference: {
        module: path.join(distributionRoot, 'runtime', 'node-llama-cpp.js'),
        moduleSha256: EffectOption.getOrUndefined(
          EffectArray.findFirst(inferenceOverlay.files, file => file.path === 'runtime/node-llama-cpp.js'),
        )?.sha256,
        policy: {
          selection: 'existing engine host and environment defaults through moduleSpecifier',
          background: system.environment()[BACKGROUND_INFERENCE_ENV] === '1',
          requestedContexts: parseEmbeddingContextPoolSize(system.environment()[THREADNOTE_EMBEDDING_CONTEXTS_ENV]),
          platform: system.platform,
          architecture: system.architecture,
        },
        runtimeDiagnostics: parentRuntimeDiagnostics,
      },
      platform: {
        platform: system.platform,
        architecture: system.architecture,
        libc: system.libc?.(),
        bun: Bun.version,
        nativeTarget: release.sourceIdentity.target,
      },
      model: {id: manifest.id, sha256: manifest.sha256, dimensions: manifest.dimensions},
      configuration: {
        documents: options.documents,
        distribution: options.distribution,
        samples: options.samples,
        pairs: options.pairs,
        resultLimit: VECTOR_QUERY_RESULT_LIMIT,
        fullQueryDeadlineMilliseconds: 2000,
        cleanupReserveMilliseconds: 1100,
        processTreeRssPolicy: {
          minimumSuccessfulSamples: 2,
          maximumObservedGapMilliseconds: 1000,
          failedPollsAllowed: 0,
        },
      },
      boundary:
        'selectedSemanticScores + real pinned query inference + actual compiled owned ready-read children + authorization/lexical/canonical opening and closing fences',
      syntheticDocumentEmbeddings: true,
      qualified: false,
      qualificationScope:
        'One case only; default adoption additionally requires all dense/tied 100k/10k cases on all eight native target profiles.',
      diagnostic:
        options.pairs < 3 ||
        options.samples < 30 ||
        ![10_000, 100_000].includes(options.documents) ||
        !openingSource.runtimeAndHarnessMatchCandidate,
      nativeManifest,
      candidateInventory,
      baselineInventory,
      openingSource,
      closingSource,
      sourceStable,
      fixtureStable,
      distributionStable,
      modelStable,
      fixture: {
        documents: fixture.documents,
        corpusGeneration: fixture.corpusGeneration,
        databaseSha256,
        setupMilliseconds,
      },
      executableVerification,
      setupCosts: {
        distributionMilliseconds: distributionSetupMilliseconds,
        fixtureMilliseconds: setupMilliseconds,
        oracleControlsMilliseconds: oracleSetupMilliseconds,
        discriminatorMilliseconds: discriminatorSetupMilliseconds,
        parentRuntimeInitializationMilliseconds,
      },
      firstUse,
      nativeExecutionProof: proof,
      oracleControls,
      arms,
      pairGates,
      caseGatesPassed,
      fatal,
    });
    const writeCapture = () =>
      Effect.suspend(() =>
        options.output ? fs.writeFileString(options.output, `${JSON.stringify(capture(), null, 2)}\n`) : Effect.void,
      );
    if (options.output) yield* fs.makeDirectory(path.dirname(options.output), {recursive: true});
    const executeQuery = (
      backend: ProductionBackend,
      selectedFixture: typeof fixture,
      sample: number,
      expected?: {querySha256: string; scoresSha256: string},
    ) =>
      Effect.gen(function* () {
        const environment: NodeJS.ProcessEnv = {
          ...system.environment(),
          THREADNOTE_HOME: selectedFixture.config.agentContextHome,
          THREADNOTE_INSTALL_ROOT: path.join(home, 'private-install'),
        };
        delete environment.THREADNOTE_NATIVE_VECTOR_READER_MANIFEST;
        delete environment.THREADNOTE_NATIVE_VECTOR_READER_SOURCE_ROOT;
        const selected = {
          ...system,
          executablePath: executableFor(backend),
          environment: () => environment,
        };
        const children: {operation: string; milliseconds: number; timeoutMs: number | undefined}[] = [];
        const observedCommands = CommandExecutor.of({
          ...command,
          execute: (executable, args, requestOptions) =>
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeNanos;
              const reply = yield* command.execute(executable, args, requestOptions).pipe(Effect.result);
              const operation = requestOptions?.input
                ? (yield* Schema.decodeUnknownEffect(Schema.Struct({operation: Schema.String}))(
                    JSON.parse(new TextDecoder().decode(requestOptions.input)),
                  ).pipe(Effect.orDie)).operation
                : 'unknown';
              children.push({
                operation,
                milliseconds: Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND,
                timeoutMs: requestOptions?.timeoutMs,
              });
              return yield* reply._tag === 'Failure' ? Effect.fail(reply.failure) : Effect.succeed(reply.success);
            }),
        });
        lastQueryVector = [];
        const started = yield* Clock.currentTimeNanos;
        const result = yield* Effect.gen(function* () {
          const boundary = yield* makeReadyRecallReadBoundary(yield* makeReadDeadline(2000)).pipe(
            Effect.provideService(SystemInfo, selected),
            Effect.provideService(CommandExecutor, observedCommands),
          );
          return yield* selectedSemanticScores(
            selectedFixture.config,
            `Unique vector production benchmark document ${sample}.`,
            {
              limit: VECTOR_QUERY_RESULT_LIMIT,
              eligibility,
            },
          ).pipe(Effect.provideService(RecallReadyReadBoundary, boundary));
        }).pipe(Effect.result);
        const milliseconds = Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND;
        if (result._tag === 'Failure') {
          const reason = Schema.is(RecallReadyReadBoundaryError)(result.failure)
            ? result.failure.reason
            : 'semantic-failure';
          return {sample, milliseconds, success: false, reason, children} satisfies ProductionQuerySample;
        }
        if (!result.success)
          return {
            sample,
            milliseconds,
            success: false,
            reason: 'absent-result',
            children,
          } satisfies ProductionQuerySample;
        const querySha256 = sha256HexSync(JSON.stringify(scalarNormalizedQuery(lastQueryVector)));
        const scoresSha256 = sha256HexSync(JSON.stringify([...result.success]));
        const parity = expected ?? {
          querySha256,
          scoresSha256: sha256HexSync(
            JSON.stringify([...scalarOracleScores(selectedFixture.databasePath, lastQueryVector)]),
          ),
        };
        const success = parity.querySha256 === querySha256 && parity.scoresSha256 === scoresSha256;
        return {
          sample,
          milliseconds,
          success,
          ...(success ? {} : {reason: 'query-or-scalar-oracle-mismatch'}),
          querySha256,
          scoresSha256,
          children,
        } satisfies ProductionQuerySample;
      });
    yield* Effect.gen(function* () {
      // Release/install setup verifies executable startup separately from semantic requests.
      for (const backend of ['baseline', 'candidate'] as const) {
        const started = yield* Clock.currentTimeNanos;
        const verification = yield* command
          .execute(executableFor(backend), ['--version'], {
            env: {
              ...system.environment(),
              THREADNOTE_HOME: fixture.config.agentContextHome,
              THREADNOTE_INSTALL_ROOT: path.join(home, 'private-install'),
            },
            timeoutMs: 5000,
            maxOutputBytes: 16 * 1024,
            forceKillAfterMilliseconds: 0,
            sensitiveOutput: true,
            verifyOwnedProcessExit: system.platform === 'win32' ? 'leader' : 'group',
          })
          .pipe(Effect.result);
        executableVerification.push({
          backend,
          milliseconds: Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND,
          success: verification._tag === 'Success',
          ...(verification._tag === 'Success' ? {version: EffectString.trim(verification.success.stdout)} : {}),
        });
        if (verification._tag === 'Failure') return yield* verification.failure;
      }
      parentRuntimeDiagnostics = yield* runtime.diagnostics;
      Bun.gc(true);
      queryPhase = true;
      const modelStarted = yield* Clock.currentTimeNanos;
      yield* runtime.embedMany({
        inputs: [`${manifest.promptPrefixes?.query ?? ''}Unique vector production benchmark document 0.`],
        manifest,
        modelPath,
      });
      firstUse.modelMilliseconds = Number((yield* Clock.currentTimeNanos) - modelStarted) / NANOSECONDS_PER_MILLISECOND;
      parentRuntimeDiagnostics = yield* runtime.diagnostics;
      for (const backend of ['baseline', 'candidate'] as const) {
        firstUse.requests.push({backend, result: yield* executeQuery(backend, fixture, 0)});
      }
      const discriminatorStartedAt = yield* Clock.currentTimeNanos;
      // A separate tiny VIEW discriminates the actual SQLite engine without changing measured data or production code.
      queryPhase = false;
      const proofFixture = yield* makeProductionFixture(path.join(home, 'proof'), 2);
      Bun.gc(true);
      queryPhase = true;
      const proofDb = new Database(proofFixture.databasePath);
      try {
        proofDb.exec('ALTER TABLE vector_values RENAME TO fixture_vector_values');
        const sourceId = Effect2.pipe(nativeManifest.buildInfo.sqliteSourceId, EffectString.replaceAll("'", "''"));
        const hostSourceId = requiredRow(proofDb.query<{id: string}, []>('SELECT sqlite_source_id() AS id').get()).id;
        if (hostSourceId === nativeManifest.buildInfo.sqliteSourceId)
          throw ScriptError.make({message: 'SQLite engines cannot be discriminated on this host.'});
        proofDb.exec(
          `CREATE VIEW vector_values AS SELECT id,vector_key,CASE WHEN sqlite_source_id()='${sourceId}' THEN vector ELSE X'00' END AS vector FROM fixture_vector_values`,
        );
      } finally {
        proofDb.close();
      }
      // The oracle reads original stored bytes; native must return them, TS must fail strict validation.
      const proofVector = yield* runtime.embedMany({
        inputs: [`${manifest.promptPrefixes?.query ?? ''}Unique vector production benchmark document 0.`],
        manifest,
        modelPath,
      });
      const proofExpected = {
        querySha256: sha256HexSync(JSON.stringify(scalarNormalizedQuery(proofVector[0]))),
        scoresSha256: sha256HexSync(
          JSON.stringify([...scalarOracleScores(proofFixture.databasePath, proofVector[0], 'fixture_vector_values')]),
        ),
      };
      for (const backend of ['baseline', 'candidate'] as const)
        proof.push({backend, result: yield* executeQuery(backend, proofFixture, 0, proofExpected)});
      discriminatorSetupMilliseconds =
        Number((yield* Clock.currentTimeNanos) - discriminatorStartedAt) / NANOSECONDS_PER_MILLISECOND;
      yield* writeCapture();
      if (proof[0]?.result.success || proof[0]?.result.reason !== 'worker-failed' || !proof[1]?.result.success)
        return yield* ScriptError.make({
          message: 'Actual compiled native/TypeScript engine proof failed; capture is unqualified.',
        });
      const expected = oracleControls;
      const oracleStartedAt = yield* Clock.currentTimeNanos;
      for (let sample = 0; sample < options.samples; sample++) {
        const vector = (yield* runtime.embedMany({
          inputs: [`${manifest.promptPrefixes?.query ?? ''}Unique vector production benchmark document ${sample}.`],
          manifest,
          modelPath,
        }))[0];
        expected.push({
          querySha256: sha256HexSync(JSON.stringify(scalarNormalizedQuery(vector))),
          scoresSha256: sha256HexSync(JSON.stringify([...scalarOracleScores(fixture.databasePath, vector)])),
        });
      }
      oracleSetupMilliseconds = Number((yield* Clock.currentTimeNanos) - oracleStartedAt) / NANOSECONDS_PER_MILLISECOND;
      for (let pair = 1; pair <= options.pairs; pair++) {
        const order: readonly ProductionBackend[] =
          pair % 2 === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const backend of order) {
          Bun.gc(true);
          const arm: ProductionArmCapture = {pair, backend, samples: [], parentMemoryAtArmStart: process.memoryUsage()};
          arms.push(arm);
          const samplerRoot = path.join(home, `sampler-${pair}-${backend}`);
          const sampledTemporaryRoot = path.join(samplerRoot, 'temp');
          yield* fs.makeDirectory(sampledTemporaryRoot, {recursive: true});
          const samplerStartedAt = yield* Clock.currentTimeNanos;
          const sampler = yield* Effect.acquireRelease(
            startExternalSampler(
              fs,
              path,
              samplerRoot,
              sampledTemporaryRoot,
              fixture.databasePath,
              options.output
                ? `${options.output}.pair-${pair}-${backend}.sampler.json`
                : path.join(samplerRoot, 'checkpoint.json'),
              'cold',
              false,
              system.platform === 'win32',
            ),
            handle => handle.stop('aborted').pipe(Effect.ignore),
          );
          arm.samplerSetupMilliseconds =
            Number((yield* Clock.currentTimeNanos) - samplerStartedAt) / NANOSECONDS_PER_MILLISECOND;
          yield* sampler.markPhase('production-query');
          for (let sample = 0; sample < options.samples; sample++) {
            const result = yield* executeQuery(backend, fixture, sample, expected[sample]);
            arm.samples.push(result);
            if (result.reason === 'cleanup-unconfirmed')
              return yield* ScriptError.make({message: 'Owned worker cleanup was not confirmed; capture stopped.'});
          }
          const samplerStopStartedAt = yield* Clock.currentTimeNanos;
          arm.sampler = yield* sampler.stop();
          arm.samplerStopMilliseconds =
            Number((yield* Clock.currentTimeNanos) - samplerStopStartedAt) / NANOSECONDS_PER_MILLISECOND;
          const phase = arm.sampler.phases['production-query'];
          arm.resourceEvidenceComplete =
            arm.sampler.processTelemetry.availability === 'available' &&
            arm.sampler.processTelemetry.scope === 'recursive-process-tree' &&
            (phase?.processSamples ?? 0) > 1 &&
            (phase?.processSampleFailures ?? 0) === 0 &&
            (phase?.processSampleGapPeakMilliseconds ?? Infinity) <= 1000 &&
            (phase?.processPeakCount ?? 0) > 1;
          arm.sampledTreePeakRssBytes = arm.resourceEvidenceComplete ? phase?.rssPeakBytes : undefined;
          const successful = EffectArray.filter(arm.samples, value => value.success);
          if (successful.length === options.samples)
            arm.p95Milliseconds = percentile(
              EffectArray.map(successful, value => value.milliseconds).sort((a, b) => a - b),
              0.95,
            );
          yield* writeCapture();
          yield* Console.log(
            `Production pair ${pair} ${backend}: ${successful.length}/${options.samples} exact requests, p95 ${arm.p95Milliseconds ?? 'unavailable'} ms.`,
          );
        }
        const baseline = EffectOption.getOrUndefined(
          EffectArray.findFirst(arms, arm => arm.pair === pair && arm.backend === 'baseline'),
        );
        const candidate = EffectOption.getOrUndefined(
          EffectArray.findFirst(arms, arm => arm.pair === pair && arm.backend === 'candidate'),
        );
        const complete = baseline?.p95Milliseconds !== undefined && candidate?.p95Milliseconds !== undefined;
        const latencyPassed =
          complete &&
          (options.documents === 100_000 && options.distribution === 'dense'
            ? candidate.p95Milliseconds! <= baseline.p95Milliseconds! * 0.8
            : options.documents === 10_000
              ? candidate.p95Milliseconds! - baseline.p95Milliseconds! <= Math.max(5, baseline.p95Milliseconds! * 0.05)
              : true);
        const rssPassed =
          baseline?.sampledTreePeakRssBytes !== undefined &&
          candidate?.sampledTreePeakRssBytes !== undefined &&
          candidate.sampledTreePeakRssBytes <= baseline.sampledTreePeakRssBytes * 1.1;
        pairGates.push({
          pair,
          baselineP95: baseline?.p95Milliseconds,
          candidateP95: candidate?.p95Milliseconds,
          latencyPassed,
          rssPassed,
          complete,
        });
      }
      closingSource = yield* productionSourceFence(nativeManifest.buildInfo.sourceCommit);
      sourceStable =
        openingSource.runtimeAndHarnessDiffSha256 === closingSource.runtimeAndHarnessDiffSha256 &&
        openingSource.untrackedRuntimePathsSha256 === closingSource.untrackedRuntimePathsSha256 &&
        openingSource.instrumentationHash === closingSource.instrumentationHash;
      fixtureStable = databaseSha256 === sha256HexSync(yield* fs.readFile(fixture.databasePath));
      distributionStable =
        JSON.stringify(candidateInventory) === JSON.stringify(yield* productionDistributionInventory(candidateRoot)) &&
        JSON.stringify(baselineInventory) === JSON.stringify(yield* productionDistributionInventory(baselineRoot)) &&
        JSON.stringify(inputInventory) === JSON.stringify(yield* productionDistributionInventory(distributionRoot)) &&
        JSON.stringify(baselineInputInventory) ===
          JSON.stringify(yield* productionDistributionInventory(baselineDistributionRoot));
      modelStable = manifest.sha256 === sha256HexSync(yield* fs.readFile(modelPath));
      const firstUsePassed = EffectArray.every(firstUse.requests, value => value.result.success);
      caseGatesPassed =
        openingSource.runtimeAndHarnessMatchCandidate &&
        sourceStable &&
        fixtureStable &&
        distributionStable &&
        modelStable &&
        firstUsePassed &&
        options.pairs >= 3 &&
        options.samples >= 30 &&
        [10_000, 100_000].includes(options.documents) &&
        EffectArray.every(pairGates, value => value.complete && value.latencyPassed && value.rssPassed);
      const semanticFailure =
        EffectArray.some(
          firstUse.requests,
          value => !value.result.success && value.result.reason !== 'budget-exhausted',
        ) ||
        EffectArray.some(arms, arm =>
          EffectArray.some(arm.samples, value => !value.success && value.reason !== 'budget-exhausted'),
        );
      if (semanticFailure || !sourceStable || !fixtureStable || !distributionStable || !modelStable)
        return yield* ScriptError.make({
          message:
            'Production capture has semantic/parity/ownership or source/fixture failures; see retained artifact.',
        });
      if (options.failOnBudget && !caseGatesPassed)
        return yield* ScriptError.make({message: 'Production case did not pass the unchanged R5 capture gates.'});
    }).pipe(
      Effect.onError(cause =>
        Effect.sync(() => {
          fatal = String(cause);
        }),
      ),
      Effect.ensuring(writeCapture().pipe(Effect.orDie)),
    );
    if (!options.output) yield* Console.log(JSON.stringify(capture(), null, 2));
  }),
);

function scalarNormalizedQuery(query: readonly number[]): readonly number[] {
  let magnitude = 0;
  for (const component of query) magnitude += component * component;
  const inverse = 1 / Math.sqrt(magnitude);
  return EffectArray.map(query, component => component * inverse);
}

function scalarOracleScores(
  databasePath: string,
  query: readonly number[],
  valuesTable: 'vector_values' | 'fixture_vector_values' = 'vector_values',
): ReadonlyMap<string, number> {
  const database = new Database(databasePath, {readonly: true});
  try {
    const normalized = scalarNormalizedQuery(query);
    const rows = database
      .query<{chunk_id: string; uri: string; vector: Uint8Array}, []>(
        `SELECT chunk.chunk_id,chunk.uri,value.vector FROM vector_chunks chunk JOIN ${valuesTable} value ON value.id=chunk.vector_id`,
      )
      .all();
    const ranked = EffectArray.map(rows, row => {
      const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      let score = 0;
      for (let index = 0; index < normalized.length; index++)
        score += normalized[index] * view.getFloat32(index * 4, true);
      return {id: row.chunk_id, uri: row.uri, score: Math.max(-1, Math.min(1, score))};
    }).sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const scores = new Map<string, number>();
    for (const row of ranked.slice(0, VECTOR_QUERY_RESULT_LIMIT))
      scores.set(row.uri, Math.max(scores.get(row.uri) ?? 0, Math.max(0, row.score)));
    return scores;
  } finally {
    database.close();
  }
}

if (import.meta.main)
  BunRuntime.runMain(
    options.writeBaselineProvenance
      ? provideScriptLayer(
          writeBaselineBuildProvenance(
            options.baselineSourceRoot,
            options.baselineDistributionRoot,
            options.baselineInstallCommand,
          ),
          benchmarkLayer,
        )
      : options.productionPath
        ? provideScriptLayer(
            runProductionVectorBenchmark,
            Layer.mergeAll(ApplicationLayer, LocalModelCatalog.layer([manifest]), modelStoreLayer, runtimeLayer),
          )
        : provideScriptLayer(program, benchmarkLayer),
  );

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
  readonly productionPath: boolean;
  readonly distributionRoot?: string;
  readonly baselineDistributionRoot?: string;
  readonly baselineSourceRoot?: string;
  readonly baselineInstallCommand?: string;
  readonly writeBaselineProvenance: boolean;
  readonly pairs: number;
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
  let productionPath = false;
  let distributionRoot: string | undefined;
  let baselineDistributionRoot: string | undefined;
  let baselineSourceRoot: string | undefined;
  let baselineInstallCommand: string | undefined;
  let writeBaselineProvenance = false;
  let pairs = 3;
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
    if (argument === '--production-path') productionPath = true;
    else if (argument === '--write-baseline-provenance') writeBaselineProvenance = true;
    else if (argument === '--baseline-install-command') baselineInstallCommand = arguments_[++index];
    else if (argument === '--baseline-source-root') baselineSourceRoot = arguments_[++index];
    else if (argument === '--baseline-distribution-root') baselineDistributionRoot = arguments_[++index];
    else if (argument === '--distribution-root') distributionRoot = arguments_[++index];
    else if (argument === '--pairs') pairs = positiveInteger(arguments_[++index], '--pairs');
    else if (argument === '--pair') pair = positiveInteger(arguments_[++index], '--pair');
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
    productionPath,
    writeBaselineProvenance,
    ...(baselineDistributionRoot ? {baselineDistributionRoot} : {}),
    ...(baselineSourceRoot ? {baselineSourceRoot} : {}),
    ...(baselineInstallCommand ? {baselineInstallCommand} : {}),
    pairs,
    ...(distributionRoot ? {distributionRoot} : {}),
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
