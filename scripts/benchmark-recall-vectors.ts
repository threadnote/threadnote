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
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === options.model),
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
    const command = yield* CommandExecutor;
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const captureStartedAt = DateTime.formatIso(yield* DateTime.now);
    const instrumentationHash = sha256HexSync(yield* fs.readFile(yield* path.fromFileUrl(import.meta.url)));
    const sourceCommit = EffectString.trim((yield* command.execute('git', ['rev-parse', 'HEAD'])).stdout);
    const dirty =
      EffectString.trim((yield* command.execute('git', ['status', '--porcelain', '--untracked-files=no'])).stdout)
        .length > 0;
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
    const correctness: string[] = [];
    const oracleControls: {query: readonly number[]; scores: ReadonlyMap<string, number>}[] = [];
    queryPhase = true;
    let queryRssAfterBytes = queryRssBeforeBytes;
    yield* Effect.gen(function* () {
      for (let sample = 0; sample < options.samples + 1; sample += 1) {
        const targetIndex = sample % options.documents;
        const cpuBefore = process.cpuUsage();
        const startedAt = yield* Clock.currentTimeNanos;
        const scores = yield* selectedSemanticScores(
          {agentContextHome: home},
          `vector benchmark query ${targetIndex}`,
          {limit: VECTOR_QUERY_RESULT_LIMIT},
        );
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
        correctness.push(sha256HexSync(JSON.stringify([...(scores ?? [])])));
        const milliseconds = Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND;
        if (sample === 0) firstUseDurations.push(milliseconds);
        else {
          queryDurations.push(milliseconds);
          queryCpu.push((cpu.user + cpu.system) / 1000);
        }
        queryRssAfterBytes = Math.max(queryRssAfterBytes, process.memoryUsage().rss);
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
      ],
      metadata: {
        documents: options.documents,
        distribution: options.distribution,
        modelSha256: manifest.sha256,
        modelPurpose: 'recall',
        inference: options.modelFile ? 'real-query' : 'mock',
        correctnessDigest: sha256HexSync(JSON.stringify(correctness)),
        qualification: false,
      },
    });
    if (sha256HexSync(yield* fs.readFile(yield* path.fromFileUrl(import.meta.url))) !== instrumentationHash)
      return yield* ScriptError.make({message: 'Benchmark instrumentation changed during capture.'});
    const finalCommit = EffectString.trim((yield* command.execute('git', ['rev-parse', 'HEAD'])).stdout);
    if (finalCommit !== sourceCommit) return yield* ScriptError.make({message: 'Source HEAD changed during capture.'});
    const limitations = [
      'Synthetic document embeddings; real-query mode verifies the pinned installed model without downloading it.',
      'SQL/row transport and validation/scoring/top-k remain fused in the authorized read; no isolated stage claimed.',
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
          }),
        ),
        identities: {
          model: `${manifest.id}:${manifest.revision}:${manifest.sha256}`,
          purpose: 'recall',
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
                stage === 'sql-row-transport' || stage === 'validation-scoring-top-k'
                  ? {state: 'unavailable', reason: 'Fused authorized reader has no benchmark-only isolation seam'}
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
        captureFinishedAt: artifact.createdAt,
        rawWarmMilliseconds: queryDurations,
        rawWarmCpuMilliseconds: queryCpu,
        rawFirstUseMilliseconds: firstUseDurations,
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
