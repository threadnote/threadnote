import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {codeGraphSourceSpanFragment} from '@threadnote/graph/citation/primitives';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  createMemoryCodeCitation,
  MEMORY_SCHEMA_VERSION,
  type MemoryCodeCitationV1,
} from '@threadnote/memory/code/citation';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {loadRecallCodeLinks, loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  CODE_MEMORY_LINK_SCALE_FIXTURE,
  CODE_MEMORY_LINK_SCALE_SCENARIOS,
  codeMemoryLinkScaleExpectedTruncatedSelectorCount,
  codeMemoryLinkScaleExpectedUris,
  codeMemoryLinkScaleFixtureHash,
  type CodeMemoryLinkScaleLookupObservationV1,
  type CodeMemoryLinkScaleRuntimeCaptureV1,
  type CodeMemoryLinkScaleScenarioCaptureV1,
  type CodeMemoryLinkScaleScenarioId,
} from './code-memory-link-scale-contract.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const FIXED_INSTANT = '2026-08-29T00:00:00.000Z';
const SOURCE_COMMIT = Effect2.pipe('d', EffectString.repeat(40));
const SOURCE_SNAPSHOT_ID = `cgsn_${Effect2.pipe('e', EffectString.repeat(40))}`;
const SOURCE_GRAPH_CONTENT_ID = `cgc_${Effect2.pipe('f', EffectString.repeat(40))}`;
const EXTRACTOR_SET = 'code-memory-link-inverse-scale-v1';
const DIRECT_BACKLINK_MEMORY_COUNT = 3;
const ISOLATION_DECOY_MEMORY_COUNT = 1;
const DENSE_EXPECTED_RESULT_COUNT = codeMemoryLinkScaleExpectedUris('dense-shared-selector').length;
const MINIMUM_CORPUS_MEMORY_COUNT =
  DIRECT_BACKLINK_MEMORY_COUNT + ISOLATION_DECOY_MEMORY_COUNT + DENSE_EXPECTED_RESULT_COUNT;
const MEMORY_WRITE_BATCH_SIZE = 1_000;
const MEMORY_WRITE_CONCURRENCY = 64;
const encoder = new TextEncoder();
const NOISE_SEED = Number.parseInt(
  Effect2.pipe(sha256HexSync(CODE_MEMORY_LINK_SCALE_FIXTURE.seed), EffectString.slice(0, 8)),
  16,
);

const FILE_BACKLINK_SOURCE = 'export const inverseScaleFileBacklinks = true;\n';
const SYMBOL_BACKLINK_SOURCE = 'export function inverseScaleSymbol(): number { return 1; }\n';
const DENSE_SHARED_SELECTOR_SOURCE = 'export function inverseScaleDenseSharedSelector(): number { return 1; }\n';
const NO_ANSWER_SOURCE = 'export const inverseScaleNoAnswer = true;\n';

export interface CodeMemoryLinkScaleWorkloadOptions {
  readonly memoryCandidates: number;
  readonly samples: number;
  readonly warmups: number;
}

class CodeMemoryLinkScaleRuntimeError extends Schema.TaggedError<
  CodeMemoryLinkScaleRuntimeError,
  {readonly brand: unique symbol}
>()('CodeMemoryLinkScaleRuntimeError', {message: Schema.String}) {}

interface ScaleScenarioDefinition {
  readonly anchors: readonly MemoryCodeCitationV1[];
  readonly expectedTruncatedSelectorCount: number;
  readonly expectedUris: readonly string[];
  readonly id: CodeMemoryLinkScaleScenarioId;
}

interface MaterializedCorpus {
  readonly bytes: number;
  readonly config: RuntimeConfig;
  readonly noiseMemoryCount: number;
  readonly scenarios: readonly ScaleScenarioDefinition[];
}

/**
 * Build real canonical memory files, force-refresh the production recall SQLite
 * index, and sample the shipped inverse-selector query plus canonical reread.
 */
export const runCodeMemoryLinkScaleWorkload = Effect.fn('evaluation.codeMemoryLinkScaleWorkload')(function* (
  options: CodeMemoryLinkScaleWorkloadOptions,
) {
  validateOptions(options);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-link-scale-'});
  Bun.gc(true);
  const baselineRssBytes = process.memoryUsage().rss;
  return yield* Effect.acquireUseRelease(
    Effect.sync(startRssSampler),
    rss =>
      Effect.gen(function* () {
        const materializationStarted = yield* Clock.currentTimeNanos;
        const materialized = yield* materializeCorpus(fs, path, root, options.memoryCandidates, rss.observe);
        const materializationFinished = yield* Clock.currentTimeNanos;
        const indexStarted = yield* Clock.currentTimeNanos;
        yield* loadRecallIndexData(materialized.config, {
          forceRefresh: true,
          includeInactive: false,
          limit: 0,
          onProgress: () => Effect.sync(rss.observe),
          query: '',
        });
        const indexFinished = yield* Clock.currentTimeNanos;
        rss.observe();
        const status = yield* recallIndexStatus(materialized.config);
        if (!status.ready || status.documentCount !== options.memoryCandidates) {
          return yield* CodeMemoryLinkScaleRuntimeError.make({
            message: `Production recall index contains ${status.documentCount}/${options.memoryCandidates} memories.`,
          });
        }
        const scenarios = yield* Effect.forEach(
          materialized.scenarios,
          scenario => runScenario(materialized.config, scenario, options, rss.observe),
          {concurrency: 1},
        );
        const storage = yield* recallStorageBytes(fs, status.databasePath);
        rss.observe();
        const peakRssBytes = rss.peak();
        return {
          corpus: {
            corpusBytes: materialized.bytes,
            denseBacklinkMemoryCount: materialized.noiseMemoryCount,
            directBacklinkMemoryCount: DIRECT_BACKLINK_MEMORY_COUNT,
            indexedMemoryCount: status.documentCount,
            isolationDecoyMemoryCount: ISOLATION_DECOY_MEMORY_COUNT,
            materializedMemoryCount: options.memoryCandidates,
            noiseMemoryCount: materialized.noiseMemoryCount,
          },
          fixtureHash: codeMemoryLinkScaleFixtureHash(),
          resources: {
            addedPeakRssBytes: Math.max(0, peakRssBytes - baselineRssBytes),
            baselineRssBytes,
            indexBuildMilliseconds: elapsedMilliseconds(indexStarted, indexFinished),
            materializationMilliseconds: elapsedMilliseconds(materializationStarted, materializationFinished),
            peakRssBytes,
            recallDatabaseBytes: storage.database,
            recallStorageBytes: storage.total,
          },
          scenarios,
        } satisfies CodeMemoryLinkScaleRuntimeCaptureV1;
      }),
    rss => Effect.sync(rss.stop),
  );
});

const materializeCorpus = Effect.fn('evaluation.codeMemoryLinkScaleWorkload.materialize')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  memoryCandidates: number,
  observeRss: () => void,
) {
  const home = path.join(root, 'threadnote-home');
  const memoryRoot = path.join(
    home,
    'data',
    'local',
    'user',
    CODE_MEMORY_LINK_SCALE_FIXTURE.user,
    'memories',
    'durable',
    'projects',
    CODE_MEMORY_LINK_SCALE_FIXTURE.project,
  );
  yield* fs.makeDirectory(memoryRoot, {recursive: true, mode: 0o700});
  yield* writeSourceFixture(fs, path, root);
  const anchors = scaleAnchors();
  const direct = [
    memoryRecord('direct-file-a', anchors.file),
    memoryRecord('direct-file-b', anchors.file),
    memoryRecord('direct-symbol', anchors.symbol),
    memoryRecord('foreign-repository-isolation-decoy', anchors.foreignFile),
  ];
  let bytes = 0;
  for (const record of direct) {
    const target = path.join(memoryRoot, 'direct', `${record.slug}.md`);
    yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
    yield* fs.writeFileString(target, record.content);
    bytes += encoder.encode(record.content).byteLength;
  }
  const noiseMemoryCount = memoryCandidates - direct.length;
  const noiseRoot = path.join(memoryRoot, 'noise');
  for (let offset = 0; offset < noiseMemoryCount; offset += MEMORY_WRITE_BATCH_SIZE) {
    const end = Math.min(noiseMemoryCount, offset + MEMORY_WRITE_BATCH_SIZE);
    const shard = Effect2.pipe(String(Math.floor(offset / MEMORY_WRITE_BATCH_SIZE)), EffectString.padStart(3, '0'));
    const shardRoot = path.join(noiseRoot, shard);
    yield* fs.makeDirectory(shardRoot, {recursive: true, mode: 0o700});
    const batchBytes = yield* Effect.forEach(
      Array.from({length: end - offset}, (_, index) => offset + index),
      index => {
        const content = noiseMemory(index, anchors.denseSymbol);
        const target = path.join(shardRoot, `${Effect2.pipe(String(index), EffectString.padStart(6, '0'))}.md`);
        return fs.writeFileString(target, content).pipe(Effect.as(encoder.encode(content).byteLength));
      },
      {concurrency: MEMORY_WRITE_CONCURRENCY},
    );
    bytes += EffectArray.reduce(batchBytes, 0, (total, value) => total + value);
    observeRss();
    yield* Effect.yieldNow;
  }
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'code-memory-link-inverse-scale',
    manifestPath: path.join(root, 'manifest.json'),
    user: CODE_MEMORY_LINK_SCALE_FIXTURE.user,
  };
  return {
    bytes,
    config,
    noiseMemoryCount,
    scenarios: EffectArray.map(CODE_MEMORY_LINK_SCALE_SCENARIOS, id => ({
      anchors: scenarioAnchors(anchors, id),
      expectedTruncatedSelectorCount: codeMemoryLinkScaleExpectedTruncatedSelectorCount(id),
      expectedUris: codeMemoryLinkScaleExpectedUris(id),
      id,
    })),
  } satisfies MaterializedCorpus;
});

const runScenario = Effect.fn('evaluation.codeMemoryLinkScaleWorkload.scenario')(function* (
  config: RuntimeConfig,
  scenario: ScaleScenarioDefinition,
  options: CodeMemoryLinkScaleWorkloadOptions,
  observeRss: () => void,
) {
  const run = () => runLookup(config, scenario.anchors, observeRss);
  const cold = yield* run();
  const warmups = yield* Effect.forEach(Array.from({length: options.warmups}), run, {
    concurrency: 1,
  });
  const samples = yield* Effect.forEach(Array.from({length: options.samples}), run, {
    concurrency: 1,
  });
  return {
    cold,
    expectedTruncatedSelectorCount: scenario.expectedTruncatedSelectorCount,
    expectedUris: scenario.expectedUris,
    id: scenario.id,
    samples,
    warmups,
  } satisfies CodeMemoryLinkScaleScenarioCaptureV1;
});

const runLookup = Effect.fn('evaluation.codeMemoryLinkScaleWorkload.lookup')(function* (
  config: RuntimeConfig,
  anchors: readonly MemoryCodeCitationV1[],
  observeRss: () => void,
) {
  let canonicalMismatchCount = 0;
  let truncatedSelectorCount = 0;
  const started = yield* Clock.currentTimeNanos;
  const matches = yield* loadRecallCodeLinks(config, {
    anchors,
    includeInactive: false,
    limit: 8,
    onCanonicalMismatch: count => {
      canonicalMismatchCount += count;
    },
    onSearchTruncated: count => {
      truncatedSelectorCount += count;
    },
    project: CODE_MEMORY_LINK_SCALE_FIXTURE.project,
  });
  const finished = yield* Clock.currentTimeNanos;
  observeRss();
  return {
    canonicalMismatchCount,
    milliseconds: elapsedMilliseconds(started, finished),
    returnedUris: EffectArray.map(matches, match => match.uri),
    truncatedSelectorCount,
  } satisfies CodeMemoryLinkScaleLookupObservationV1;
});

function scaleAnchors(): {
  readonly denseFile: MemoryCodeCitationV1;
  readonly denseSymbol: MemoryCodeCitationV1;
  readonly file: MemoryCodeCitationV1;
  readonly foreignFile: MemoryCodeCitationV1;
  readonly noAnswer: MemoryCodeCitationV1;
  readonly symbol: MemoryCodeCitationV1;
} {
  const filePath = fixtureScenario('file-backlinks').codePath;
  const symbolScenario = fixtureScenario('symbol-backlink');
  const densePath = fixtureScenario('dense-shared-selector').codePath;
  const noAnswerPath = fixtureScenario('no-answer').codePath;
  const file = fileCitation(filePath, FILE_BACKLINK_SOURCE, CODE_MEMORY_LINK_SCALE_FIXTURE.repositoryId);
  return {
    denseFile: fileCitation(densePath, DENSE_SHARED_SELECTOR_SOURCE, CODE_MEMORY_LINK_SCALE_FIXTURE.repositoryId),
    denseSymbol: symbolCitation(
      densePath,
      fixtureScenario('dense-shared-selector').nodeId,
      DENSE_SHARED_SELECTOR_SOURCE,
      'inverseScaleDenseSharedSelector',
    ),
    file,
    foreignFile: fileCitation(filePath, FILE_BACKLINK_SOURCE, CODE_MEMORY_LINK_SCALE_FIXTURE.foreignRepositoryId),
    noAnswer: fileCitation(noAnswerPath, NO_ANSWER_SOURCE, CODE_MEMORY_LINK_SCALE_FIXTURE.repositoryId),
    symbol: symbolCitation(
      symbolScenario.codePath,
      symbolScenario.nodeId,
      SYMBOL_BACKLINK_SOURCE,
      'inverseScaleSymbol',
    ),
  };
}

function fileCitation(path: string, content: string, repositoryId: string): MemoryCodeCitationV1 {
  return createMemoryCodeCitation({
    extractorSet: EXTRACTOR_SET,
    fileContentHash: {algorithm: 'sha256', value: sha256HexSync(content)},
    path,
    repositoryId,
    repositoryIdentityKind: 'remote',
    sourceCommit: SOURCE_COMMIT,
    sourceDirty: false,
    sourceGraphContentId: SOURCE_GRAPH_CONTENT_ID,
    sourceSnapshotId: SOURCE_SNAPSHOT_ID,
    target: {kind: 'file'},
    version: 1,
  });
}

function symbolCitation(path: string, nodeId: string, content: string, name: string): MemoryCodeCitationV1 {
  const span = {column: 1, endColumn: Effect2.pipe(content, EffectString.trimEnd).length + 1, endLine: 1, line: 1};
  const fragment = codeGraphSourceSpanFragment(content, span);
  if (!fragment.ok) throw new Error(`Invalid inverse scale symbol fixture: ${fragment.reason}.`);
  return createMemoryCodeCitation({
    extractorSet: EXTRACTOR_SET,
    fileContentHash: {algorithm: 'sha256', value: sha256HexSync(content)},
    path,
    repositoryId: CODE_MEMORY_LINK_SCALE_FIXTURE.repositoryId,
    repositoryIdentityKind: 'remote',
    sourceCommit: SOURCE_COMMIT,
    sourceDirty: false,
    sourceGraphContentId: SOURCE_GRAPH_CONTENT_ID,
    sourceSnapshotId: SOURCE_SNAPSHOT_ID,
    target: {
      fragmentCanonicalization: 'utf8-source-span-v1',
      fragmentHash: {algorithm: 'sha256', value: fragment.fragment.sha256},
      kind: 'symbol',
      language: 'typescript',
      name,
      nodeId,
      qualifiedName: name,
      signatureHash: {algorithm: 'sha256', value: sha256HexSync(`${name}(): number`)},
      span,
      symbolKind: 'function',
    },
    version: 1,
  });
}

function memoryRecord(slug: string, citation: MemoryCodeCitationV1): {readonly content: string; readonly slug: string} {
  return {
    content: formatMemoryDocument(
      'MEMORY',
      {
        codeCitations: [citation],
        kind: 'durable',
        project: CODE_MEMORY_LINK_SCALE_FIXTURE.project,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceAgentClient: 'benchmark',
        status: 'active',
        timestamp: FIXED_INSTANT,
        topic: slug,
      },
      `Deterministic direct backlink sentinel ${slug}.`,
    ),
    slug,
  };
}

function noiseMemory(index: number, citation: MemoryCodeCitationV1): string {
  const cohort = seededNoiseCohort(index);
  return formatMemoryDocument(
    'MEMORY',
    {
      codeCitations: [citation],
      kind: 'durable',
      project: CODE_MEMORY_LINK_SCALE_FIXTURE.project,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'benchmark',
      status: 'active',
      timestamp: FIXED_INSTANT,
      topic: `inverse-selector-noise-${Effect2.pipe(String(cohort), EffectString.padStart(2, '0'))}`,
    },
    `Seeded dense-selector cohort ${cohort}: every noise memory cites the same governed source anchor.`,
  );
}

function seededNoiseCohort(index: number): number {
  let value = (index ^ NOISE_SEED) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb_352d);
  value = Math.imul(value ^ (value >>> 15), 0x846c_a68b);
  return (value ^ (value >>> 16)) & 63;
}

function fixtureScenario<Id extends CodeMemoryLinkScaleScenarioId>(
  id: Id,
): Extract<(typeof CODE_MEMORY_LINK_SCALE_FIXTURE.scenarios)[number], {readonly id: Id}> {
  const scenario = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      CODE_MEMORY_LINK_SCALE_FIXTURE.scenarios,
      (candidate): candidate is Extract<(typeof CODE_MEMORY_LINK_SCALE_FIXTURE.scenarios)[number], {readonly id: Id}> =>
        candidate.id === id,
    ),
  );
  if (scenario === undefined) throw new Error(`Missing code-memory-link scale scenario: ${id}`);
  return scenario;
}

function scenarioAnchors(anchors: ReturnType<typeof scaleAnchors>, id: CodeMemoryLinkScaleScenarioId) {
  switch (id) {
    case 'dense-shared-selector':
      return [anchors.denseFile, anchors.denseSymbol];
    case 'file-backlinks':
      return [anchors.file];
    case 'no-answer':
      return [anchors.noAnswer];
    case 'symbol-backlink':
      return [anchors.symbol];
  }
}

function writeSourceFixture(fs: FileSystem.FileSystem, path: Path.Path, root: string) {
  const sources = [
    [fixtureScenario('file-backlinks').codePath, FILE_BACKLINK_SOURCE],
    [fixtureScenario('symbol-backlink').codePath, SYMBOL_BACKLINK_SOURCE],
    [fixtureScenario('dense-shared-selector').codePath, DENSE_SHARED_SELECTOR_SOURCE],
    [fixtureScenario('no-answer').codePath, NO_ANSWER_SOURCE],
  ] as const;
  return Effect.forEach(
    sources,
    ([relativePath, content]) => {
      const target = path.join(root, relativePath);
      return fs
        .makeDirectory(path.dirname(target), {recursive: true})
        .pipe(Effect.andThen(fs.writeFileString(target, content)));
    },
    {concurrency: 4, discard: true},
  );
}

function recallStorageBytes(fs: FileSystem.FileSystem, databasePath: string) {
  return Effect.gen(function* () {
    const sizes = yield* Effect.forEach(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`],
      candidate =>
        fs.stat(candidate).pipe(
          Effect.map(info => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        ),
      {concurrency: 4},
    );
    return {database: sizes[0], total: EffectArray.reduce(sizes, 0, (total, size) => total + size)};
  });
}

function startRssSampler(): {
  readonly observe: () => void;
  readonly peak: () => number;
  readonly stop: () => void;
} {
  let peak = process.memoryUsage().rss;
  const observe = () => {
    peak = Math.max(peak, process.memoryUsage().rss);
  };
  const timer = setInterval(observe, 5);
  return {observe, peak: () => peak, stop: () => clearInterval(timer)};
}

function elapsedMilliseconds(started: bigint, finished: bigint): number {
  return Number(finished - started) / 1_000_000;
}

function validateOptions(options: CodeMemoryLinkScaleWorkloadOptions): void {
  if (!Number.isSafeInteger(options.memoryCandidates) || options.memoryCandidates < MINIMUM_CORPUS_MEMORY_COUNT) {
    throw CodeMemoryLinkScaleRuntimeError.make({
      message: `memoryCandidates must be a safe integer of at least ${MINIMUM_CORPUS_MEMORY_COUNT}.`,
    });
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1) {
    throw CodeMemoryLinkScaleRuntimeError.make({message: 'samples must be a positive safe integer.'});
  }
  if (!Number.isSafeInteger(options.warmups) || options.warmups < 0) {
    throw CodeMemoryLinkScaleRuntimeError.make({message: 'warmups must be a non-negative safe integer.'});
  }
}
