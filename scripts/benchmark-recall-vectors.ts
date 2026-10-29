import {Array as EffectArray, Option as EffectOption} from 'effect';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {BunRuntime} from '@effect/platform-bun';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {Clock, Console, Effect, FileSystem, Layer, Path} from 'effect';
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
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw ScriptError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const MEBIBYTE = 1024 * 1024;
const DEFAULT_DOCUMENT_COUNT = 10_000;
const DEFAULT_QUERY_SAMPLES = 10;
const VECTOR_QUERY_RESULT_LIMIT = 25;
const manifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
)!;

const options = parseOptions(process.argv.slice(2));

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

const runtimeLayer = Layer.succeed(
  LocalModelRuntime,
  LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: ({inputs, manifest: requested}) =>
      Effect.sync(() => EffectArray.map(inputs, input => deterministicVector(requested.dimensions ?? 0, input))),
    generate: () => Effect.die(ScriptError.make({message: 'Unexpected generation'})),
    rerank: () => Effect.die(ScriptError.make({message: 'Unexpected reranking'})),
  }),
);

const benchmarkLayer = Layer.mergeAll(
  BunServices.layer,
  LocalModelCatalog.layer([manifest]),
  modelStoreLayer,
  runtimeLayer,
  ScriptSystemInfoLayer,
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
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
    const queryRssBeforeBytes = process.memoryUsage().rss;
    const queryRss = startRssSampler();
    const queryDurations: number[] = [];
    let queryRssAfterBytes = queryRssBeforeBytes;
    yield* Effect.gen(function* () {
      for (let sample = 0; sample < options.samples; sample += 1) {
        const targetIndex = sample % options.documents;
        const startedAt = yield* Clock.currentTimeNanos;
        const scores = yield* selectedSemanticScores(
          {agentContextHome: home},
          `vector benchmark query ${targetIndex}`,
          {limit: VECTOR_QUERY_RESULT_LIMIT},
        );
        const finishedAt = yield* Clock.currentTimeNanos;
        const expectedSize = Math.min(VECTOR_QUERY_RESULT_LIMIT, options.documents);
        const expectedUri = candidates[targetIndex].uri;
        if (scores?.size !== expectedSize || (scores.get(expectedUri) ?? -1) < 0.999) {
          return yield* ScriptError.make({
            message: `Vector benchmark returned ${scores?.size ?? 0}/${expectedSize} results without the exact target ${expectedUri}.`,
          });
        }
        queryDurations.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
        queryRssAfterBytes = Math.max(queryRssAfterBytes, process.memoryUsage().rss);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => queryRss.stop())));
    queryRssAfterBytes = Math.max(queryRssAfterBytes, queryRss.peak());

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
    const sortedQueryDurations = queryDurations.sort((left, right) => left - right);
    const initialBuildMilliseconds = Number(initialFinishedAt - initialStartedAt) / NANOSECONDS_PER_MILLISECOND;
    const incrementalBuildMilliseconds =
      Number(incrementalFinishedAt - incrementalStartedAt) / NANOSECONDS_PER_MILLISECOND;
    const semanticQueryP95Milliseconds = percentile(sortedQueryDurations, 0.95);
    const performanceBudget = assessRecallVectorPerformance(options.documents, {
      incrementalBuildMilliseconds,
      initialBuildMilliseconds,
      semanticQueryP95Milliseconds,
    });
    const result = {
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
  const numeric = Number(/(\d+)(?!.*\d)/.exec(input)?.[1] ?? 0);
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
    path: `${home}/models/benchmark.gguf`,
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
  readonly documents: number;
  readonly failOnBudget: boolean;
  readonly output?: string;
  readonly samples: number;
} {
  let documents = DEFAULT_DOCUMENT_COUNT;
  let failOnBudget = false;
  let output: string | undefined;
  let samples = DEFAULT_QUERY_SAMPLES;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--documents') documents = positiveInteger(arguments_[++index], '--documents');
    else if (argument === '--samples') samples = positiveInteger(arguments_[++index], '--samples');
    else if (argument === '--output') output = arguments_[++index];
    else if (argument === '--fail-on-budget') failOnBudget = true;
    else throw ScriptError.make({message: `Unknown vector benchmark option: ${argument}`});
  }
  return {...(output ? {output} : {}), documents, failOnBudget, samples};
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw ScriptError.make({message: `${option} requires a positive integer.`});
  return parsed;
}
