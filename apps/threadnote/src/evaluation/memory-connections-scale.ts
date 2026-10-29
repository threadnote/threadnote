import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import {Clock, DateTime, Effect, FileSystem, Path} from 'effect';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {readMemoryRecordsByUri} from '../memory/commands.js';
import {
  formatMemoryDocument,
  MEMORY_RELATION_TYPES,
  type MemoryMetadata,
  type MemoryRelation,
} from '@threadnote/memory/document';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {projectRecallMcpResponse} from '@threadnote/recall/mcp/response';
import {retrieveRecallMemoryConnections} from '@threadnote/recall/memory/connections';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  MEMORY_CONNECTIONS_SCALE_FIXTURE,
  MEMORY_CONNECTIONS_SCALE_SCENARIOS,
  memoryConnectionsScaleExpectedIds,
  memoryConnectionsScaleFixtureHash,
  type MemoryConnectionsScaleCaptureV1,
  type MemoryConnectionsScaleObservationV1,
  type MemoryConnectionsScaleScenarioId,
} from './memory-connections-scale-contract.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MemoryConnectionsWireSchema = Schema.Struct({
  memoryConnections: Schema.optionalKey(
    Schema.Struct({
      connections: Schema.Array(
        Schema.Struct({
          currentness: Schema.Literals(['conflicted', 'current', 'historical', 'unresolved']),
          direction: Schema.Literals(['incoming', 'outgoing']),
          distance: Schema.Literal(1),
          neighborMemoryId: Schema.optionalKey(Schema.String),
          origin: Schema.Literals(['evidence', 'references', 'relation', 'supersedes']),
          relationOrdinal: Schema.Finite,
          relationType: Schema.Literals(MEMORY_RELATION_TYPES),
          requestedOrdinal: Schema.Finite,
          resolution: Schema.Literals(['conflicted', 'resolved', 'unresolved']),
          sourceMemoryId: Schema.optionalKey(Schema.String),
          targetMemoryId: Schema.optionalKey(Schema.String),
        }),
      ),
      coverage: Schema.Struct({
        connectionCount: Schema.Finite,
        premiseCount: Schema.Finite,
        resultCount: Schema.Finite,
        truncated: Schema.Boolean,
      }),
      premises: Schema.Array(
        Schema.Struct({
          memoryId: Schema.optionalKey(Schema.String),
          requestedOrdinal: Schema.Finite,
          state: Schema.String,
        }),
      ),
    }),
  ),
  output: Schema.Struct({truncated: Schema.Boolean}),
  results: Schema.Array(Schema.Struct({uri: Schema.String})),
});

const MINIMUM_CORPUS_SIZE = 14;
const WRITE_BATCH_SIZE = 1_000;
const WRITE_CONCURRENCY = 64;
const FIXED_TIMESTAMP = '2026-08-31T00:00:00.000Z';
const encoder = new TextEncoder();

export interface MemoryConnectionsScaleWorkloadOptions {
  readonly memoryCandidates: number;
  readonly samples: number;
  readonly warmups: number;
}

class MemoryConnectionsScaleError extends Schema.TaggedError<
  MemoryConnectionsScaleError,
  {readonly brand: unique symbol}
>()('MemoryConnectionsScaleError', {message: Schema.String}) {}

/** Materialize, index, and sample the full seeded one-hop retrieval path. */
export const runMemoryConnectionsScaleWorkload = Effect.fn('evaluation.memoryConnectionsScale')(function* (
  options: MemoryConnectionsScaleWorkloadOptions,
) {
  validateOptions(options);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connections-scale-'});
  Bun.gc(true);
  const baselineRssBytes = process.memoryUsage().rss;
  return yield* Effect.acquireUseRelease(
    Effect.sync(startRssSampler),
    rss =>
      Effect.gen(function* () {
        const materializationStarted = yield* Clock.currentTimeNanos;
        const corpus = yield* materializeCorpus(fs, path, root, options.memoryCandidates, rss.observe);
        const materializationFinished = yield* Clock.currentTimeNanos;
        const indexStarted = yield* Clock.currentTimeNanos;
        yield* loadRecallIndexData(corpus.config, {
          forceRefresh: true,
          includeInactive: true,
          onProgress: () => Effect.sync(rss.observe),
        });
        const indexFinished = yield* Clock.currentTimeNanos;
        const status = yield* recallIndexStatus(corpus.config, true);
        if (!status.ready || status.documentCount !== options.memoryCandidates) {
          return yield* MemoryConnectionsScaleError.make({
            message: `Recall index contains ${status.documentCount}/${options.memoryCandidates} memories.`,
          });
        }
        const scenarios = yield* Effect.forEach(
          MEMORY_CONNECTIONS_SCALE_SCENARIOS,
          id => runScenario(corpus.config, id, options),
          {concurrency: 1},
        );
        const storage = yield* recallStorageBytes(fs, status.databasePath);
        rss.observe();
        const peakRssBytes = rss.peak();
        return {
          corpus: {
            authorizedHubMemoryCount: corpus.authorizedHubMemoryCount,
            corpusBytes: corpus.bytes,
            indexedMemoryCount: status.documentCount,
            materializedMemoryCount: options.memoryCandidates,
          },
          fixtureHash: memoryConnectionsScaleFixtureHash(),
          resources: {
            addedPeakRssBytes: Math.max(0, peakRssBytes - baselineRssBytes),
            baselineRssBytes,
            indexBuildMilliseconds: elapsed(indexStarted, indexFinished),
            materializationMilliseconds: elapsed(materializationStarted, materializationFinished),
            peakRssBytes,
            recallDatabaseBytes: storage.database,
            recallStorageBytes: storage.total,
          },
          scenarios,
        } satisfies MemoryConnectionsScaleCaptureV1;
      }),
    rss => Effect.sync(rss.stop),
  );
});

const materializeCorpus = Effect.fn('evaluation.memoryConnectionsScale.materialize')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  memoryCandidates: number,
  observeRss: () => void,
) {
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: path.join(root, 'threadnote-home'),
    agentId: 'memory-connections-scale',
    manifestPath: path.join(root, 'manifest.yaml'),
    user: MEMORY_CONNECTIONS_SCALE_FIXTURE.user,
  };
  const fixed = [
    document('hub-seed', 'tn_scale_hub'),
    document('sparse-seed', 'tn_scale_sparse'),
    document('sparse-a', 'tn_sparse_a', [relationTo('tn_scale_sparse')]),
    document('sparse-b', 'tn_sparse_b', [relationTo('tn_scale_sparse')]),
    document('empty', 'tn_scale_empty'),
  ];
  let bytes = 0;
  for (const item of fixed) bytes += yield* writeDocument(fs, path, config, item);
  bytes += yield* writeDocument(
    fs,
    path,
    config,
    document('foreign-hub', 'tn_foreign_hub', [relationTo('tn_scale_hub')], 'outside'),
  );
  const authorizedHubMemoryCount = memoryCandidates - fixed.length - 1;
  for (let offset = 0; offset < authorizedHubMemoryCount; offset += WRITE_BATCH_SIZE) {
    const end = Math.min(authorizedHubMemoryCount, offset + WRITE_BATCH_SIZE);
    const shard = Effect2.pipe(String(Math.floor(offset / WRITE_BATCH_SIZE)), EffectString.padStart(3, '0'));
    const batchBytes = yield* Effect.forEach(
      Array.from({length: end - offset}, (_, index) => offset + index),
      index =>
        writeDocument(
          fs,
          path,
          config,
          document(
            `hub/${shard}/hub-${Effect2.pipe(String(index), EffectString.padStart(6, '0'))}`,
            `tn_hub_${Effect2.pipe(String(index), EffectString.padStart(6, '0'))}`,
            [relationTo('tn_scale_hub')],
          ),
        ),
      {concurrency: WRITE_CONCURRENCY},
    );
    bytes += EffectArray.reduce(batchBytes, 0, (total, value) => total + value);
    observeRss();
    yield* Effect.yieldNow;
  }
  return {authorizedHubMemoryCount, bytes, config};
});

const runScenario = Effect.fn('evaluation.memoryConnectionsScale.scenario')(function* (
  config: RuntimeConfig,
  id: MemoryConnectionsScaleScenarioId,
  options: MemoryConnectionsScaleWorkloadOptions,
) {
  const run = () => runLookup(config, id);
  const cold = yield* run();
  const warmups = yield* Effect.forEach(Array.from({length: options.warmups}), run, {concurrency: 1});
  const samples = yield* Effect.forEach(Array.from({length: options.samples}), run, {concurrency: 1});
  const fixture = EffectOption.getOrUndefined(
    EffectArray.findFirst(MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios, value => value.id === id),
  )!;
  return {
    cold,
    expectedMemoryIds: memoryConnectionsScaleExpectedIds(id),
    expectedTruncated: fixture.expectedTruncated,
    id,
    samples,
    warmups,
  };
});

const runLookup = Effect.fn('evaluation.memoryConnectionsScale.lookup')(function* (
  config: RuntimeConfig,
  id: MemoryConnectionsScaleScenarioId,
) {
  const fixture = EffectOption.getOrUndefined(
    EffectArray.findFirst(MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios, value => value.id === id),
  )!;
  const started = yield* Clock.currentTimeNanos;
  const result = yield* retrieveRecallMemoryConnections(config, {
    allowedUriScopes: [memoryProjectRoot(config.user)],
    limit: 8,
    memoryRefs: [`threadnote://memory/${fixture.premiseMemoryId}`],
    now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-08-31T12:00:00.000Z')),
    readRecords: uris => readMemoryRecordsByUri(config, uris),
  });
  const projection = projectRecallMcpResponse(
    {
      memoryConnections: result,
      queryExpansions: [],
      rankerVersion: 'memory-connections-scale-v1',
      results: EffectArray.map(result.candidates, candidate => ({
        category: 'memories',
        contextType: 'memory',
        score: 1,
        snippet: '',
        uri: candidate.uri,
      })),
    },
    {budgetTokens: 1_500},
  );
  const wire: unknown = JSON.parse(JSON.stringify(projection.structuredContent));
  if (!Schema.is(MemoryConnectionsWireSchema)(wire)) {
    throw new Error('Serialized recall projection has an invalid memory-connection shape.');
  }
  const wireConnections = wire.memoryConnections?.connections ?? [];
  const wirePremises = wire.memoryConnections?.premises ?? [];
  const memoryIdByUri = new Map(
    EffectArray.flatMap(result.candidates, candidate =>
      candidate.memoryId ? [[candidate.uri, candidate.memoryId] as const] : [],
    ),
  );
  const finished = yield* Clock.currentTimeNanos;
  return {
    canonicalRereads: result.diagnostics.canonicalRereads,
    estimatedTokens: projection.measurement.estimatedTokens,
    milliseconds: elapsed(started, finished),
    omittedConnectionReceiptCount: Math.max(0, result.connections.length - wireConnections.length),
    omittedPremiseReceiptCount: Math.max(0, result.premises.length - wirePremises.length),
    projectedConnections: EffectArray.map(wireConnections, connection => ({
      currentness: connection.currentness,
      direction: connection.direction,
      distance: connection.distance,
      neighborMemoryId: connection.neighborMemoryId ?? null,
      origin: connection.origin,
      relationOrdinal: connection.relationOrdinal,
      relationType: connection.relationType,
      requestedOrdinal: connection.requestedOrdinal,
      resolution: connection.resolution,
      sourceMemoryId: connection.sourceMemoryId ?? null,
      targetMemoryId: connection.targetMemoryId ?? null,
    })),
    projectedCoverageConnectionCount: wire.memoryConnections?.coverage.connectionCount ?? -1,
    projectedCoveragePremiseCount: wire.memoryConnections?.coverage.premiseCount ?? -1,
    projectedCoverageResultCount: wire.memoryConnections?.coverage.resultCount ?? -1,
    projectedConnectionCoverageTruncated: wire.memoryConnections?.coverage.truncated ?? true,
    projectedOutputTruncated: wire.output.truncated,
    projectedPremises: EffectArray.map(wirePremises, premise => ({
      memoryId: premise.memoryId ?? null,
      requestedOrdinal: premise.requestedOrdinal,
      state: premise.state,
    })),
    rawLinkRows: result.diagnostics.rawLinkRows,
    retrievalTruncated: result.coverage.truncated,
    returnedMemoryIds: EffectArray.flatMap(wire.results, candidate => {
      const memoryId = memoryIdByUri.get(candidate.uri);
      return memoryId ? [memoryId] : [];
    }),
  } satisfies MemoryConnectionsScaleObservationV1;
});

interface ScaleDocument {
  readonly memoryId: string;
  readonly project: string;
  readonly relations: readonly MemoryRelation[];
  readonly topic: string;
}

function document(
  topic: string,
  memoryId: string,
  relations: readonly MemoryRelation[] = [],
  project = 'threadnote',
): ScaleDocument {
  return {memoryId, project, relations, topic};
}

function relationTo(memoryId: string): MemoryRelation {
  return {type: 'related_to', uri: `threadnote://memory/${memoryId}`};
}

const writeDocument = Effect.fn('evaluation.memoryConnectionsScale.writeDocument')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RuntimeConfig,
  item: ScaleDocument,
) {
  const target = path.join(
    config.agentContextHome,
    'data',
    config.account,
    'user',
    config.user,
    'memories',
    'durable',
    'projects',
    item.project,
    `${item.topic}.md`,
  );
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: item.memoryId,
    project: item.project,
    relations: item.relations,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: 'memory-connections-scale',
    status: 'active',
    timestamp: FIXED_TIMESTAMP,
    topic: Effect2.pipe(item.topic, EffectString.split('/')).at(-1),
  };
  const content = formatMemoryDocument('MEMORY', metadata, 'Deterministic one-hop scale fixture memory.');
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(target, content);
  return encoder.encode(content).byteLength;
});

function memoryProjectRoot(user: string): string {
  return `threadnote://user/${user}/memories/durable/projects/threadnote`;
}

function recallStorageBytes(fs: FileSystem.FileSystem, databasePath: string) {
  return Effect.gen(function* () {
    const sizes = yield* Effect.forEach(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`],
      candidate =>
        fs.stat(candidate).pipe(
          Effect.map(value => Number(value.size)),
          Effect.orElseSucceed(() => 0),
        ),
      {concurrency: 4},
    );
    return {database: sizes[0], total: EffectArray.reduce(sizes, 0, (total, size) => total + size)};
  });
}

function startRssSampler(): {readonly observe: () => void; readonly peak: () => number; readonly stop: () => void} {
  let peak = process.memoryUsage().rss;
  const observe = () => {
    peak = Math.max(peak, process.memoryUsage().rss);
  };
  const timer = setInterval(observe, 5);
  return {observe, peak: () => peak, stop: () => clearInterval(timer)};
}

function elapsed(started: bigint, finished: bigint): number {
  return Number(finished - started) / 1_000_000;
}

function validateOptions(options: MemoryConnectionsScaleWorkloadOptions): void {
  if (!Number.isSafeInteger(options.memoryCandidates) || options.memoryCandidates < MINIMUM_CORPUS_SIZE) {
    throw MemoryConnectionsScaleError.make({message: `memoryCandidates must be at least ${MINIMUM_CORPUS_SIZE}.`});
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1) {
    throw MemoryConnectionsScaleError.make({message: 'samples must be a positive safe integer.'});
  }
  if (!Number.isSafeInteger(options.warmups) || options.warmups < 0) {
    throw MemoryConnectionsScaleError.make({message: 'warmups must be a non-negative safe integer.'});
  }
}
