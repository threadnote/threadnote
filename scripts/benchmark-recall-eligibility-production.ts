import {Array as EffectArray, Option as EffectOption} from 'effect';
import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {Clock, DateTime, Effect, FileSystem, Layer, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {benchmarkMeasurement} from '@threadnote/evidence/benchmark';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {deriveRecallEligibilityPolicy, type RecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {loadRecallIndexData, type RecallIndexQueryDiagnostics} from '@threadnote/recall/index';
import {rebuildVectorIndex, selectedSemanticScores, vectorIndexDatabaseFilename} from '@threadnote/recall/vector-index';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, scriptArguments} from './effect/script.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw ScriptError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const DEFAULT_DISTRACTORS_PER_CLASS = 525;
const DEFAULT_SAMPLES = 5;
const DEFAULT_TOP_K = 5;
const DEFAULT_WARMUPS = 1;
const MINIMUM_DISTRACTORS_PER_CLASS = 501;
const TARGET_PROJECT = 'target-app';
const OTHER_PROJECT = 'other-app';
const ORDINARY_QUERY = 'deployment safemode contract';
const APPROVED_QUERY = 'approved canonical deployment safemode contract';
const PROFILES = ['unrestricted', 'explicit-project', 'approved-authoritative'] as const;
const manifest = EffectOption.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
)!;

type Profile = (typeof PROFILES)[number];

interface LexicalPassResult {
  readonly postingRows: number;
  readonly postingStatements: number;
  readonly projectlessRecovered: boolean;
  readonly queryTerms: number;
  readonly resultCount: number;
  readonly targetRecovered: boolean;
  readonly wrongProjectResults: number;
  readonly unapprovedResults: number;
}

interface VectorPassResult {
  readonly eligibleRows: number;
  readonly projectlessRecovered: boolean;
  readonly resultCount: number;
  readonly targetRecovered: boolean;
  readonly wrongProjectResults: number;
  readonly unapprovedResults: number;
}

interface Fixture {
  readonly manifestSha256: string;
  readonly projectlessUri: string;
  readonly targetUri: string;
  readonly totalDocuments: number;
}

const modelStoreLayer = Layer.succeed(
  LocalModelStore,
  LocalModelStore.of({
    install: () => Effect.die(ScriptError.make({message: 'Unexpected model installation'})),
    path: home => `${home}/models/eligibility-benchmark.gguf`,
    remove: () => Effect.succeed(false),
    status: home => Effect.succeed(modelInstallation(home)),
    verify: home => Effect.succeed(modelInstallation(home)),
  } satisfies LocalModelStoreShape),
);

const runtimeLayer = Layer.succeed(
  LocalModelRuntime,
  LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fixture', buildType: 'prebuilt', cpuMathCores: 1}),
    embedMany: ({inputs, manifest: requested}) =>
      Effect.sync(() => EffectArray.map(inputs, input => fixtureVector(requested.dimensions ?? 0, input))),
    generate: () => Effect.die(ScriptError.make({message: 'Unexpected generation'})),
    rerank: () => Effect.die(ScriptError.make({message: 'Unexpected reranking'})),
  }),
);

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const benchmarkLayer = Layer.mergeAll(
  systemLayer,
  commandLayer,
  LocalModelCatalog.layer([manifest]),
  modelStoreLayer,
  runtimeLayer,
).pipe(Layer.provideMerge(BunServices.layer));

const benchmarkRecallEligibilityProduction = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const options = parseRecallEligibilityBenchmarkArguments(yield* scriptArguments());
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-eligibility-production-'});
    const fixture = yield* writeFixture(fs, path, home, options.distractorsPerClass);
    const config = {account: 'local', agentContextHome: home, user: 'benchmark'};
    const corpus = yield* loadRecallIndexData(config, {
      forceRefresh: true,
      includeInactive: false,
    });
    if (corpus.candidates.length !== fixture.totalDocuments) {
      return yield* ScriptError.make({
        message: `Eligibility fixture indexed ${corpus.candidates.length}/${fixture.totalDocuments} logical documents.`,
      });
    }

    const catalog = yield* LocalModelCatalog;
    yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
    const vectorBuild = yield* rebuildVectorIndex({agentContextHome: home}, manifest, corpus.candidates);
    const vectorRows = readVectorEligibilityRows(path, home);

    for (let warmup = 0; warmup < options.warmups; warmup += 1) {
      for (const profile of PROFILES) {
        yield* runLexicalPass(config, fixture, options.topK, profile);
        yield* runVectorPass(config, fixture, options.topK, profile, vectorRows[profile]);
      }
    }

    const lexicalDurations = new Map<Profile, number[]>(EffectArray.map(PROFILES, profile => [profile, []]));
    const vectorDurations = new Map<Profile, number[]>(EffectArray.map(PROFILES, profile => [profile, []]));
    const lexicalSummaries = new Map<Profile, LexicalPassResult>();
    const vectorSummaries = new Map<Profile, VectorPassResult>();
    for (let sample = 0; sample < options.samples; sample += 1) {
      for (const profile of rotateProfiles(sample)) {
        const lexicalStartedAt = yield* Clock.currentTimeNanos;
        const lexical = yield* runLexicalPass(config, fixture, options.topK, profile);
        const lexicalFinishedAt = yield* Clock.currentTimeNanos;
        lexicalDurations.get(profile)!.push(Number(lexicalFinishedAt - lexicalStartedAt) / NANOSECONDS_PER_MILLISECOND);
        lexicalSummaries.set(profile, lexical);

        const vectorStartedAt = yield* Clock.currentTimeNanos;
        const vector = yield* runVectorPass(config, fixture, options.topK, profile, vectorRows[profile]);
        const vectorFinishedAt = yield* Clock.currentTimeNanos;
        vectorDurations.get(profile)!.push(Number(vectorFinishedAt - vectorStartedAt) / NANOSECONDS_PER_MILLISECOND);
        vectorSummaries.set(profile, vector);
      }
      yield* Effect.yieldNow;
    }
    assertExpectedRecovery('lexical', lexicalSummaries);
    assertExpectedRecovery('vector', vectorSummaries);

    const [commit, status, hardware, sourceVersion] = yield* Effect.all(
      [git(['rev-parse', 'HEAD']), git(['status', '--porcelain']), system.hardwareInfo, getThreadnoteVersion()],
      {concurrency: 'unbounded'},
    );
    const measurements = EffectArray.flatMap(PROFILES, profile => [
      benchmarkMeasurement(`lexical:${profile}:latency`, 'milliseconds', lexicalDurations.get(profile)!),
      benchmarkMeasurement(`vector:${profile}:latency`, 'milliseconds', vectorDurations.get(profile)!),
    ]);
    const artifact = {
      createdAt: DateTime.formatIso(yield* DateTime.now),
      environment: {
        architecture: system.architecture,
        commit,
        cpu: hardware.cpuModel,
        dirty: status.length > 0,
        fixtureHash: fixture.manifestSha256,
        memoryBytes: hardware.memoryBytes,
        operatingSystem: hardware.operatingSystem,
        runtime: `bun/${system.runtimeVersion}`,
      },
      measurements,
      metadata: {
        lexicalTimingScope:
          'warm production loadRecallIndexData query against an already-built SQLite index; fixture scan and index construction excluded',
        semanticQualityMeasured: false,
        sourceVersion: `threadnote-${sourceVersion}`,
        timingGate: false,
        vectorEmbedding:
          'fixture-controlled normalized vectors isolate SQL eligibility before semantic scoring/top-k; real embedding-model quality is intentionally excluded',
        vectorTimingScope:
          'production selectedSemanticScores query including fixture query embedding, eligible SQLite row scan, vector scoring, top-k, and alias expansion; vector construction excluded',
      },
      shape: {
        approvedProjectlessDocuments: 1,
        approvedTargetDocuments: 1,
        distractorsPerClass: options.distractorsPerClass,
        profiles: PROFILES,
        strongerSameProjectUnapprovedDocuments: options.distractorsPerClass,
        strongerWrongProjectApprovedDocuments: options.distractorsPerClass,
        topK: options.topK,
        totalDocuments: fixture.totalDocuments,
        vectorChunks: vectorBuild.chunkCount,
      },
      suite: 'recall-eligibility-production',
      summaries: {
        lexical: EffectRecord.fromEntries(lexicalSummaries),
        vector: EffectRecord.fromEntries(vectorSummaries),
      },
      version: 1,
      warmups: options.warmups,
    };
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    yield* printJson(artifact);
  }),
);

function runLexicalPass(
  config: {readonly account: string; readonly agentContextHome: string; readonly user: string},
  fixture: Fixture,
  topK: number,
  profile: Profile,
) {
  return Effect.gen(function* () {
    let diagnostics: RecallIndexQueryDiagnostics = {postingRows: 0, postingStatements: 0, queryTerms: 0};
    const result = yield* loadRecallIndexData(config, {
      eligibility: profileEligibility(profile),
      includeInactive: false,
      limit: topK,
      onQueryDiagnostics: observed =>
        Effect.sync(() => {
          diagnostics = observed;
        }),
      query: profileQuery(profile),
    });
    return {
      ...summarizeUris(
        EffectArray.map(result.candidates, candidate => candidate.uri),
        fixture,
      ),
      ...diagnostics,
    } satisfies LexicalPassResult;
  });
}

function runVectorPass(
  config: {readonly agentContextHome: string},
  fixture: Fixture,
  topK: number,
  profile: Profile,
  eligibleRows: number,
) {
  return Effect.gen(function* () {
    const scores = yield* selectedSemanticScores(config, profileQuery(profile), {
      eligibility: profileEligibility(profile),
      limit: topK,
    });
    if (scores === undefined)
      return yield* ScriptError.make({message: 'Vector eligibility benchmark index is absent.'});
    const summary = summarizeUris([...scores.keys()], fixture);
    return {...summary, eligibleRows} satisfies VectorPassResult;
  });
}

function summarizeUris(uris: readonly string[], fixture: Fixture): Omit<VectorPassResult, 'eligibleRows'> {
  return {
    projectlessRecovered: uris.includes(fixture.projectlessUri),
    resultCount: uris.length,
    targetRecovered: uris.includes(fixture.targetUri),
    unapprovedResults: EffectArray.filter(
      uris,
      (uri, index) =>
        index in uris && Effect2.pipe(uri, EffectString.includes('/memories/durable/projects/target-app/unapproved-')),
    ).length,
    wrongProjectResults: EffectArray.filter(
      uris,
      (uri, index) => index in uris && Effect2.pipe(uri, EffectString.includes('/projects/other-app/wrong-')),
    ).length,
  };
}

function profileEligibility(profile: Profile): RecallEligibilityPolicy | undefined {
  if (profile === 'unrestricted') {
    return deriveRecallEligibilityPolicy({originalQuery: ORDINARY_QUERY});
  }
  return deriveRecallEligibilityPolicy({
    explicitProject: TARGET_PROJECT,
    originalQuery: profile === 'approved-authoritative' ? APPROVED_QUERY : ORDINARY_QUERY,
  });
}

function profileQuery(profile: Profile): string {
  return profile === 'approved-authoritative' ? APPROVED_QUERY : ORDINARY_QUERY;
}

function assertExpectedRecovery(
  retriever: 'lexical' | 'vector',
  summaries: ReadonlyMap<
    Profile,
    {
      readonly projectlessRecovered: boolean;
      readonly targetRecovered: boolean;
      readonly unapprovedResults: number;
      readonly wrongProjectResults: number;
    }
  >,
): void {
  const unrestricted = summaries.get('unrestricted');
  const project = summaries.get('explicit-project');
  const approved = summaries.get('approved-authoritative');
  if (!unrestricted || !project || !approved)
    throw ScriptError.make({message: `${retriever} benchmark omitted a profile.`});
  if (unrestricted.targetRecovered || project.targetRecovered || !approved.targetRecovered) {
    throw ScriptError.make({
      message: `${retriever} eligibility did not recover the target only after both project and authority filtering.`,
    });
  }
  if (unrestricted.wrongProjectResults === 0) {
    throw ScriptError.make({
      message: `${retriever} unrestricted results did not expose stronger wrong-project competition.`,
    });
  }
  if (project.wrongProjectResults !== 0 || project.unapprovedResults === 0) {
    throw ScriptError.make({
      message: `${retriever} project filtering did not replace wrong-project results with stronger same-project memories.`,
    });
  }
  if (approved.unapprovedResults !== 0 || approved.wrongProjectResults !== 0) {
    throw ScriptError.make({message: `${retriever} approved-authoritative results retained disallowed documents.`});
  }
  if (!approved.projectlessRecovered) {
    throw ScriptError.make({message: `${retriever} project filtering removed approved projectless guidance.`});
  }
}

function readVectorEligibilityRows(path: Path.Path, home: string): Readonly<Record<Profile, number>> {
  const databasePath = path.join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename());
  const database = new Database(databasePath, {readonly: true});
  try {
    const count = (predicate: string, parameters: readonly string[] = []) =>
      Number(
        requiredRow(
          database
            .query<{readonly count: number}, SQLQueryBindings[]>(
              `SELECT COUNT(*) AS count
               FROM vector_chunks
               WHERE generation = (SELECT generation FROM vector_pointer WHERE singleton = 1)
                 AND ${predicate}`,
            )
            .get(...parameters),
        ).count,
      );
    return {
      'approved-authoritative': count('(project IS NULL OR project = ?) AND approved_authoritative = 1', [
        TARGET_PROJECT,
      ]),
      'explicit-project': count('(project IS NULL OR project = ?)', [TARGET_PROJECT]),
      unrestricted: count('1 = 1'),
    };
  } finally {
    database.close();
  }
}

function writeFixture(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  distractorsPerClass: number,
): Effect.Effect<Fixture, unknown> {
  return Effect.gen(function* () {
    const memoriesRoot = path.join(home, 'data', 'local', 'user', 'benchmark', 'memories');
    const sharedRoot = path.join(memoriesRoot, 'shared', 'team', 'durable');
    const wrongRoot = path.join(sharedRoot, 'projects', OTHER_PROJECT);
    const targetRoot = path.join(sharedRoot, 'projects', TARGET_PROJECT);
    const projectlessRoot = path.join(sharedRoot, 'global');
    const unapprovedRoot = path.join(memoriesRoot, 'durable', 'projects', TARGET_PROJECT);
    yield* Effect.forEach([wrongRoot, targetRoot, projectlessRoot, unapprovedRoot], root =>
      fs.makeDirectory(root, {recursive: true}),
    );

    const records = [
      ...Array.from({length: distractorsPerClass}, (_unused, index) => ({
        content: strongerMemory(OTHER_PROJECT, `wrong-${index}`, index, 'wrong-project-strong-vector', true),
        path: path.join(wrongRoot, `wrong-${Effect2.pipe(String(index), EffectString.padStart(4, '0'))}.md`),
      })),
      ...Array.from({length: distractorsPerClass}, (_unused, index) => ({
        content: strongerMemory(TARGET_PROJECT, `unapproved-${index}`, index, 'unapproved-strong-vector', false),
        path: path.join(unapprovedRoot, `unapproved-${Effect2.pipe(String(index), EffectString.padStart(4, '0'))}.md`),
      })),
      {
        content: weakerMemory(TARGET_PROJECT, 'eligible-target', 'eligible-weaker-vector'),
        path: path.join(targetRoot, 'eligible-target.md'),
      },
      {
        content: weakerMemory(undefined, 'approved-global', 'projectless-approved-vector'),
        path: path.join(projectlessRoot, 'approved-global.md'),
      },
    ];
    yield* Effect.forEach(records, record => fs.writeFileString(record.path, record.content), {
      concurrency: 32,
      discard: true,
    });
    return {
      manifestSha256: sha256HexSync(
        JSON.stringify({
          records: EffectArray.map(records, record => ({
            contentSha256: sha256HexSync(record.content),
            relativePath: Effect2.pipe(path.relative(memoriesRoot, record.path), EffectString.replaceAll('\\', '/')),
          })),
          version: 1,
        }),
      ),
      projectlessUri: 'threadnote://user/benchmark/memories/shared/team/durable/global/approved-global.md',
      targetUri: 'threadnote://user/benchmark/memories/shared/team/durable/projects/target-app/eligible-target.md',
      totalDocuments: records.length,
    };
  });
}

function strongerMemory(
  project: string,
  topic: string,
  index: number,
  vectorMarker: string,
  strongest: boolean,
): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      `project: ${project}`,
      `topic: approved-canonical-deployment-safemode-contract-${topic}`,
      'keywords: approved canonical deployment safemode contract',
      'source_agent_client: benchmark',
      'timestamp: 2026-08-20T00:00:00.000Z',
      '',
      EffectArray.join(
        [
          'Approved canonical deployment safemode contract deployment safemode contract',
          ...(strongest ? ['approved canonical deployment safemode contract'] : []),
          `${vectorMarker} record ${index}.`,
        ],
        ' ',
      ),
    ],
    '\n',
  );
}

function weakerMemory(project: string | undefined, topic: string, vectorMarker: string): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      ...(project === undefined ? [] : [`project: ${project}`]),
      `topic: ${topic}`,
      'source_agent_client: benchmark',
      'timestamp: 2026-08-20T00:00:00.000Z',
      '',
      `Approved canonical deployment safemode contract ${vectorMarker}.`,
    ],
    '\n',
  );
}

function fixtureVector(dimensions: number, input: string): readonly number[] {
  if (Effect2.pipe(input, EffectString.includes('eligible-weaker-vector'))) return blendedVector(dimensions, 0.8);
  if (Effect2.pipe(input, EffectString.includes('projectless-approved-vector'))) return blendedVector(dimensions, 0.9);
  if (Effect2.pipe(input, EffectString.includes('unapproved-strong-vector'))) return blendedVector(dimensions, 0.98);
  return unitVector(dimensions);
}

function unitVector(dimensions: number): readonly number[] {
  const vector = new Array<number>(dimensions).fill(0);
  if (dimensions > 0) vector[0] = 1;
  return vector;
}

function blendedVector(dimensions: number, primary: number): readonly number[] {
  const vector = unitVector(dimensions).slice();
  if (dimensions > 0) vector[0] = primary;
  if (dimensions > 1) vector[1] = Math.sqrt(1 - primary * primary);
  return vector;
}

function modelInstallation(home: string) {
  return {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/eligibility-benchmark.gguf`,
    verified: true,
  };
}

function rotateProfiles(sample: number): readonly Profile[] {
  const offset = sample % PROFILES.length;
  return [...PROFILES.slice(offset), ...PROFILES.slice(0, offset)];
}

export interface RecallEligibilityBenchmarkOptions {
  readonly distractorsPerClass: number;
  readonly outputPath?: string;
  readonly samples: number;
  readonly topK: number;
  readonly warmups: number;
}

export function parseRecallEligibilityBenchmarkArguments(args: readonly string[]): RecallEligibilityBenchmarkOptions {
  let distractorsPerClass = DEFAULT_DISTRACTORS_PER_CLASS;
  let outputPath: string | undefined;
  let samples = DEFAULT_SAMPLES;
  let topK = DEFAULT_TOP_K;
  let warmups = DEFAULT_WARMUPS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--distractors-per-class') {
      distractorsPerClass = positiveInteger(args[++index], argument);
    } else if (argument === '--output') outputPath = requiredValue(args[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--top-k') topK = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else throw ScriptError.make({message: `Unknown recall eligibility benchmark option: ${argument}`});
  }
  if (distractorsPerClass < MINIMUM_DISTRACTORS_PER_CLASS) {
    throw ScriptError.make({
      message: `--distractors-per-class must be at least ${MINIMUM_DISTRACTORS_PER_CLASS} to exceed the lexical posting pool`,
    });
  }
  if (distractorsPerClass > 10_000) {
    throw ScriptError.make({message: '--distractors-per-class must not exceed 10,000'});
  }
  return {distractorsPerClass, outputPath, samples, topK, warmups};
}

const git = Effect.fn('benchmark.git')((arguments_: readonly string[]) =>
  runCommandEffect('git', arguments_, {timeoutMs: 30_000}).pipe(
    Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
  ),
);

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = nonNegativeInteger(value, option);
  if (parsed < 1) throw ScriptError.make({message: `${option} requires a positive integer`});
  return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string): number {
  const raw = requiredValue(value, option);
  if (!/^\d+$/u.test(raw)) throw ScriptError.make({message: `${option} requires a non-negative integer`});
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw ScriptError.make({message: `${option} requires a non-negative integer`});
  }
  return parsed;
}

function requiredValue(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkRecallEligibilityProduction, benchmarkLayer));
