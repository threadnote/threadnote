import {Array as EffectArray} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, DateTime, Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  BENCHMARK_ARTIFACT_VERSION,
  benchmarkMeasurement,
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
} from '@threadnote/evidence/benchmark';
import {
  createRecallEvaluationFixtureV2,
  expandRecallEvaluationFixtureV2,
  serializeRecallEvaluationFixtureV2Identity,
} from '@threadnote/threadnote/evaluation/recall-fixture';
import {deriveRecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {rankRecallCandidates, RECALL_RANKER_VERSION} from '@threadnote/recall/rank';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const CLEAN_GIT_STATUS_ARGUMENTS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'status.showUntrackedFiles=all',
  '-c',
  'diff.ignoreSubmodules=none',
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--ignore-submodules=none',
  '--no-renames',
] as const;

const benchmarkRecall = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const threadnoteVersion = yield* getThreadnoteVersion();
  const options = parseArguments(yield* scriptArguments());
  const initialCleanCommit = options.requireClean
    ? yield* Effect.all([git(['rev-parse', 'HEAD']), git(CLEAN_GIT_STATUS_ARGUMENTS)], {
        concurrency: 'unbounded',
      }).pipe(
        Effect.flatMap(([commit, status]) =>
          status.length > 0
            ? ScriptError.make({
                message: '--require-clean requires a clean checkout with no tracked or untracked changes.',
              })
            : Effect.succeed(commit),
        ),
      )
    : undefined;
  const fixture = expandRecallEvaluationFixtureV2(
    createRecallEvaluationFixtureV2(),
    options.documentCount,
    options.seed,
  );
  const hash = yield* fixtureHash(serializeRecallEvaluationFixtureV2Identity(fixture));
  const query = fixture.queries[0];
  const runQuery = () =>
    rankRecallCandidates(query.query, fixture.documents, {
      eligibility: deriveRecallEligibilityPolicy({
        explicitProject: query.project,
        originalQuery: query.query,
      }),
      now: query.now ? new Date(query.now) : undefined,
      project: query.project,
      seedUris: query.seedUris,
    });

  for (let index = 0; index < options.warmups; index += 1) runQuery();
  const durations: number[] = [];
  const rss: number[] = [];
  const externalMemory: number[] = [];
  const heapUsed: number[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    const startedAt = yield* Clock.currentTimeNanos;
    const result = runQuery();
    const finishedAt = yield* Clock.currentTimeNanos;
    durations.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
    if (!result.results[0]) return yield* ScriptError.make({message: 'Recall benchmark returned no result'});
    const memory = system.memoryUsage();
    rss.push(memory.rss);
    externalMemory.push(memory.external);
    heapUsed.push(memory.heapUsed);
    yield* Effect.yieldNow;
  }
  const latency = benchmarkMeasurement('hybrid-rank-one-query', 'milliseconds', durations);
  const throughput = EffectArray.map(durations, duration => 1_000 / duration);
  const [commit, status, hardware] = yield* Effect.all(
    [git(['rev-parse', 'HEAD']), git(CLEAN_GIT_STATUS_ARGUMENTS), system.hardwareInfo],
    {
      concurrency: 'unbounded',
    },
  );
  if (options.requireClean && (status.length > 0 || commit !== initialCleanCommit)) {
    return yield* ScriptError.make({
      message: '--require-clean checkout changed while the recall benchmark was running.',
    });
  }

  const artifact: BenchmarkArtifactV1 = {
    createdAt: DateTime.formatIso(yield* DateTime.now),
    environment: {
      architecture: system.architecture,
      commit,
      cpu: hardware.cpuModel,
      dirty: status.length > 0,
      fixtureHash: hash,
      memoryBytes: hardware.memoryBytes,
      node: `bun/${system.runtimeVersion}`,
      operatingSystem: hardware.operatingSystem,
      packageManager: `bun/${system.runtimeVersion}`,
      runner: 'threadnote-recall-e2e',
      runnerVersion: '2',
    },
    measurements: [
      latency,
      benchmarkMeasurement('hybrid-rank-throughput', 'operations_per_second', throughput),
      benchmarkMeasurement('process-rss', 'bytes', rss),
      benchmarkMeasurement('process-external-memory', 'bytes', externalMemory),
      benchmarkMeasurement('process-heap-used', 'bytes', heapUsed),
    ],
    metadata: {
      documents: fixture.documents.length,
      homeRedacted: system.homeDirectory.length > 0,
      queries: fixture.queries.length,
      rankerVersion: RECALL_RANKER_VERSION,
      sampleProfile: options.samples < 10 ? 'scale-boundary' : 'standard',
      seed: options.seed,
      sourceVersion: `threadnote-${threadnoteVersion}`,
    },
    suite: 'recall-v2',
    version: BENCHMARK_ARTIFACT_VERSION,
    warmups: options.warmups,
  };
  parseBenchmarkArtifactV1(artifact);
  if (options.outputPath) {
    yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  }
  yield* printJson(artifact);
});

interface BenchmarkOptions {
  readonly documentCount: number;
  readonly outputPath?: string;
  readonly requireClean: boolean;
  readonly samples: number;
  readonly seed: number;
  readonly warmups: number;
}

function parseArguments(args: readonly string[]): BenchmarkOptions {
  let documentCount = 10_000;
  let outputPath: string | undefined;
  let requireClean = false;
  let samples = 25;
  let seed = 0x4_00_00;
  let warmups = 5;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--documents') documentCount = positiveInteger(args[++index], argument);
    else if (argument === '--output') outputPath = requiredValue(args[++index], argument);
    else if (argument === '--require-clean') requireClean = true;
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--seed') seed = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else throw ScriptError.make({message: `Unknown recall benchmark option: ${argument}`});
  }
  return {documentCount, outputPath, requireClean, samples, seed, warmups};
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
  const parsed = Number.parseInt(requiredValue(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw ScriptError.make({message: `${option} requires a non-negative integer`});
  }
  return parsed;
}

function requiredValue(value: string | undefined, option: string): string {
  if (
    !Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  )
    throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

BunRuntime.runMain(provideScriptLayer(benchmarkRecall, ApplicationLayer));
