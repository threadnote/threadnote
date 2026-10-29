import {Array as EffectArray, Option as EffectOption, Predicate, pipe as EffectPipe} from 'effect';
import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, DateTime, Effect, FileSystem, Layer, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';

import {
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
  type BenchmarkMeasurementV1,
} from '@threadnote/evidence/benchmark';
import {
  THREADNOTE_EMBEDDING_CONTEXTS_ENV,
  type EmbeddingContextPoolSize,
} from '@threadnote/inference/engine/node-llama-cpp';
import {atomicWrite, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_ROUNDS = 4;
const SCALE_SYMBOLS = 10_000;
const OBSERVATION_TIMEOUT_MILLISECONDS = 15 * 60_000;
const SAMPLER_MAXIMUM_GAP_MILLISECONDS = 1_000;
const CPU_RATIO_MAXIMUM = 1.35;
const HEARTBEAT_RATIO_MAXIMUM = 1.5;
const RSS_RATIO_MAXIMUM = 1.25;
const VECTOR_DISK_RATIO_MAXIMUM = 1.05;
const WILLIAMS_ORDER = [
  [1, 2, 8, 4],
  [2, 4, 1, 8],
  [4, 8, 2, 1],
  [8, 1, 4, 2],
] as const satisfies readonly (readonly EmbeddingContextPoolSize[])[];

interface EmbeddingContextBenchmarkOptions {
  readonly modelHome: string;
  readonly outputDirectory: string;
  readonly resume: boolean;
  readonly rounds: number;
}

export interface EmbeddingContextBenchmarkObservation {
  readonly artifact: string;
  readonly coldEmbeddingCpuMilliseconds: number;
  readonly coldEmbeddingRssBytes: number;
  readonly coldIndexMilliseconds: number;
  readonly coldSamplerGapMilliseconds: number;
  readonly coldVectorMilliseconds: number;
  readonly contexts: EmbeddingContextPoolSize;
  readonly heartbeatGapMilliseconds: number;
  readonly position: number;
  readonly round: number;
  readonly vectorIndexBytes: number;
  readonly vectorRows: number;
}

export interface EmbeddingContextBenchmarkSummary {
  readonly contexts: Readonly<Record<string, EmbeddingContextSummary>>;
  readonly createdAt: string;
  readonly observations: readonly EmbeddingContextBenchmarkObservation[];
  readonly promotion: {
    readonly candidate: EmbeddingContextPoolSize;
    readonly eligibleForReviewedDefaultChange: boolean;
    readonly minimumMedianSpeedup: number;
    readonly requiredRoundWins: number;
    readonly roundWinsAgainstOne: number;
  };
  readonly scaleSymbols: typeof SCALE_SYMBOLS;
  readonly schedule: readonly (readonly EmbeddingContextPoolSize[])[];
  readonly version: 1;
}

interface EmbeddingContextSummary {
  readonly coldEmbeddingCpuMilliseconds: DistributionSummary;
  readonly coldEmbeddingRssBytes: DistributionSummary;
  readonly coldIndexMilliseconds: DistributionSummary;
  readonly coldSamplerGapMilliseconds: DistributionSummary;
  readonly coldVectorMilliseconds: DistributionSummary;
  readonly heartbeatGapMilliseconds: DistributionSummary;
  readonly medianSpeedupAgainstOne: number;
  readonly observations: number;
  readonly vectorIndexBytes: DistributionSummary;
}

interface EmbeddingContextBenchmarkRunManifest {
  readonly commit: string;
  readonly createdAt: string;
  readonly rounds: number;
  readonly schedule: readonly (readonly EmbeddingContextPoolSize[])[];
  readonly version: 1;
}

interface DistributionSummary {
  readonly maximum: number;
  readonly median: number;
  readonly minimum: number;
  readonly p25: number;
  readonly p75: number;
}

export function embeddingContextBenchmarkSchedule(rounds: number): readonly (readonly EmbeddingContextPoolSize[])[] {
  if (!Number.isSafeInteger(rounds) || rounds < 4 || rounds > 16 || rounds % 4 !== 0) {
    throw ScriptError.make({message: '--rounds must be one of 4, 8, 12, or 16.'});
  }
  return Array.from({length: rounds}, (_, index) => WILLIAMS_ORDER[index % WILLIAMS_ORDER.length]);
}

export function parseEmbeddingContextBenchmarkArguments(args: readonly string[]): EmbeddingContextBenchmarkOptions {
  let modelHome: string | undefined;
  let outputDirectory: string | undefined;
  let resume = false;
  let rounds = DEFAULT_ROUNDS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const candidate = Effect2.pipe(args[++index], effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      );
      if (!candidate) throw ScriptError.make({message: `${argument} requires a value.`});
      return candidate;
    };
    if (argument === '--model-home') modelHome = value();
    else if (argument === '--output-dir') outputDirectory = value();
    else if (argument === '--rounds') rounds = Number(value());
    else if (argument === '--resume') resume = true;
    else throw ScriptError.make({message: `Unknown embedding-context benchmark option: ${argument}`});
  }
  if (!modelHome || !outputDirectory) {
    throw ScriptError.make({message: 'Embedding-context benchmark requires --model-home and --output-dir.'});
  }
  embeddingContextBenchmarkSchedule(rounds);
  return {modelHome, outputDirectory, resume, rounds};
}

export function summarizeEmbeddingContextArtifacts(
  artifacts: readonly {readonly artifact: BenchmarkArtifactV1; readonly artifactPath: string}[],
  schedule: readonly (readonly EmbeddingContextPoolSize[])[],
): EmbeddingContextBenchmarkSummary {
  if (artifacts.length !== schedule.length * 4)
    throw ScriptError.make({message: 'Embedding benchmark artifact count is incomplete.'});
  const first = artifacts[0]?.artifact;
  if (!first) throw ScriptError.make({message: 'Embedding benchmark requires at least one artifact.'});
  const observations = EffectArray.map(artifacts, ({artifact, artifactPath}, index) => {
    const round = Math.floor(index / 4);
    const position = index % 4;
    const contexts = schedule[round]?.[position];
    if (
      contexts === undefined ||
      artifact.metadata.embeddingContextPoolSizeRequested !== contexts ||
      artifact.metadata.embeddingContextPoolSizeEffective !== contexts
    ) {
      throw ScriptError.make({message: `Embedding benchmark artifact ${artifactPath} has the wrong context capacity.`});
    }
    validateThreadPlan(artifact, artifactPath, contexts);
    validateComparableArtifact(first, artifact, artifactPath);
    validateSamplerIntegrity(artifact, artifactPath);
    return {
      artifact: Effect2.pipe(artifactPath, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1)!,
      coldEmbeddingCpuMilliseconds: measurement(artifact, 'cold-embedding-progress-external-process-cpu-n1').mean,
      coldEmbeddingRssBytes: measurement(artifact, 'cold-embedding-progress-external-rss-peak-observed-n1').mean,
      coldIndexMilliseconds: measurement(artifact, 'cold-index').mean,
      coldSamplerGapMilliseconds: measurement(artifact, 'cold-external-process-tree-maximum-sample-gap-n1').mean,
      coldVectorMilliseconds: measurement(artifact, 'cold-vector-index').mean,
      contexts,
      heartbeatGapMilliseconds: measurement(artifact, 'cold-maximum-progress-heartbeat-gap-n1').mean,
      position: position + 1,
      round: round + 1,
      vectorIndexBytes: measurement(artifact, 'vector-index-disk').mean,
      vectorRows: measurement(artifact, 'vector-rows').mean,
    } satisfies EmbeddingContextBenchmarkObservation;
  });
  const baseline = EffectArray.filter(observations, observation => observation.contexts === 1);
  const summaries = EffectRecord.fromEntries(
    EffectArray.map([1, 2, 4, 8] as const, contexts => {
      const selected = EffectArray.filter(observations, observation => observation.contexts === contexts);
      const speedups = EffectArray.map(selected, observation => {
        const paired = EffectOption.getOrUndefined(
          EffectArray.findFirst(baseline, candidate => candidate.round === observation.round),
        )!;
        return paired.coldIndexMilliseconds / observation.coldIndexMilliseconds;
      });
      return [
        String(contexts),
        {
          coldEmbeddingCpuMilliseconds: distribution(
            EffectArray.map(selected, item => item.coldEmbeddingCpuMilliseconds),
          ),
          coldEmbeddingRssBytes: distribution(EffectArray.map(selected, item => item.coldEmbeddingRssBytes)),
          coldIndexMilliseconds: distribution(EffectArray.map(selected, item => item.coldIndexMilliseconds)),
          coldSamplerGapMilliseconds: distribution(EffectArray.map(selected, item => item.coldSamplerGapMilliseconds)),
          coldVectorMilliseconds: distribution(EffectArray.map(selected, item => item.coldVectorMilliseconds)),
          heartbeatGapMilliseconds: distribution(EffectArray.map(selected, item => item.heartbeatGapMilliseconds)),
          medianSpeedupAgainstOne: distribution(speedups).median,
          observations: selected.length,
          vectorIndexBytes: distribution(EffectArray.map(selected, item => item.vectorIndexBytes)),
        } satisfies EmbeddingContextSummary,
      ];
    }),
  );
  const candidate = EffectPipe([1, 2, 4, 8] as const, __effectReduceValues =>
    EffectArray.reduce(
      EffectArray.drop(__effectReduceValues, 1),
      EffectOption.getOrElse(EffectArray.head(__effectReduceValues), () => {
        throw new TypeError('Reduce of empty array with no initial value');
      }),
      (winner, contexts) =>
        summaries[String(contexts)].coldIndexMilliseconds.median <
        summaries[String(winner)].coldIndexMilliseconds.median
          ? contexts
          : winner,
    ),
  );
  const candidateSummary = summaries[String(candidate)];
  const baselineSummary = summaries['1'];
  const roundWinsAgainstOne =
    candidate === 1
      ? 0
      : EffectArray.filter(observations, observation => {
          if (observation.contexts !== candidate) return false;
          const paired = EffectOption.getOrUndefined(
            EffectArray.findFirst(baseline, item => item.round === observation.round),
          )!;
          return observation.coldIndexMilliseconds < paired.coldIndexMilliseconds;
        }).length;
  const requiredRoundWins = Math.max(3, Math.ceil(schedule.length * 0.75));
  const eligibleForReviewedDefaultChange =
    schedule.length >= DEFAULT_ROUNDS &&
    candidate !== 1 &&
    candidateSummary.medianSpeedupAgainstOne >= 1.1 &&
    roundWinsAgainstOne >= requiredRoundWins &&
    candidateSummary.coldEmbeddingRssBytes.median <= baselineSummary.coldEmbeddingRssBytes.median * RSS_RATIO_MAXIMUM &&
    candidateSummary.coldEmbeddingCpuMilliseconds.median <=
      baselineSummary.coldEmbeddingCpuMilliseconds.median * CPU_RATIO_MAXIMUM &&
    candidateSummary.heartbeatGapMilliseconds.median <=
      Math.max(
        SAMPLER_MAXIMUM_GAP_MILLISECONDS,
        baselineSummary.heartbeatGapMilliseconds.median * HEARTBEAT_RATIO_MAXIMUM,
      ) &&
    candidateSummary.vectorIndexBytes.median <= baselineSummary.vectorIndexBytes.median * VECTOR_DISK_RATIO_MAXIMUM;
  return {
    contexts: summaries,
    createdAt: new Date().toISOString(),
    observations,
    promotion: {
      candidate,
      eligibleForReviewedDefaultChange,
      minimumMedianSpeedup: 1.1,
      requiredRoundWins,
      roundWinsAgainstOne,
    },
    scaleSymbols: SCALE_SYMBOLS,
    schedule,
    version: 1,
  };
}

const benchmark = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const options = parseEmbeddingContextBenchmarkArguments(yield* scriptArguments());
    const outputDirectory = path.resolve(options.outputDirectory);
    const modelHome = path.resolve(options.modelHome);
    const sourceRoot = yield* path.fromFileUrl(new URL('..', import.meta.url));
    yield* fs.makeDirectory(outputDirectory, {recursive: true});
    const summaryPath = path.join(outputDirectory, 'summary.json');
    if (yield* fs.exists(summaryPath))
      return yield* ScriptError.make({message: `Summary already exists: ${summaryPath}`});
    const benchmarkScript = yield* path.fromFileUrl(new URL('./benchmark-code-graph.ts', import.meta.url));
    const schedule = embeddingContextBenchmarkSchedule(options.rounds);
    const source = yield* cleanSourceState(sourceRoot);
    const runManifestPath = path.join(outputDirectory, 'run.json');
    if (yield* fs.exists(runManifestPath)) {
      if (!options.resume) {
        return yield* ScriptError.make({message: `Run manifest already exists; pass --resume: ${runManifestPath}`});
      }
      validateRunManifest(yield* readJsonFile(runManifestPath), source.commit, schedule);
    } else {
      const manifest: EmbeddingContextBenchmarkRunManifest = {
        commit: source.commit,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        rounds: options.rounds,
        schedule,
        version: 1,
      };
      yield* atomicWrite(runManifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
    }
    const existingArtifacts = new Map<string, BenchmarkArtifactV1>();
    let comparableReference: BenchmarkArtifactV1 | undefined;
    for (const [roundIndex, order] of schedule.entries()) {
      for (const [positionIndex, contexts] of order.entries()) {
        const artifactPath = path.join(
          outputDirectory,
          `round-${roundIndex + 1}-position-${positionIndex + 1}-contexts-${contexts}.json`,
        );
        if (!(yield* fs.exists(artifactPath))) continue;
        if (!options.resume) {
          return yield* ScriptError.make({message: `Benchmark artifact already exists: ${artifactPath}`});
        }
        const artifact = parseBenchmarkArtifactV1(yield* readJsonFile(artifactPath));
        validateObservationArtifact(artifact, artifactPath, source.commit, contexts);
        validateSamplerIntegrity(artifact, artifactPath);
        if (comparableReference) validateComparableArtifact(comparableReference, artifact, artifactPath);
        else comparableReference = artifact;
        existingArtifacts.set(artifactPath, artifact);
      }
    }

    const artifacts: Array<{readonly artifact: BenchmarkArtifactV1; readonly artifactPath: string}> = [];
    for (const [roundIndex, order] of schedule.entries()) {
      for (const [positionIndex, contexts] of order.entries()) {
        const artifactPath = path.join(
          outputDirectory,
          `round-${roundIndex + 1}-position-${positionIndex + 1}-contexts-${contexts}.json`,
        );
        const existingArtifact = existingArtifacts.get(artifactPath);
        if (existingArtifact) {
          const artifact = existingArtifact;
          artifacts.push({artifact, artifactPath});
          yield* Console.log(`Reusing completed embedding context observation: ${artifactPath}`);
          continue;
        }
        yield* assertSourceState(sourceRoot, source.commit);
        yield* Console.log(
          `Embedding context benchmark round ${roundIndex + 1}/${schedule.length}, position ${positionIndex + 1}/4: ${contexts} context(s).`,
        );
        yield* runObservation(sourceRoot, benchmarkScript, artifactPath, modelHome, contexts);
        yield* assertSourceState(sourceRoot, source.commit);
        const artifact = parseBenchmarkArtifactV1(yield* readJsonFile(artifactPath));
        validateObservationArtifact(artifact, artifactPath, source.commit, contexts);
        validateSamplerIntegrity(artifact, artifactPath);
        if (comparableReference) validateComparableArtifact(comparableReference, artifact, artifactPath);
        else comparableReference = artifact;
        artifacts.push({artifact, artifactPath});
      }
    }
    yield* assertSourceState(sourceRoot, source.commit);
    const summary = summarizeEmbeddingContextArtifacts(artifacts, schedule);
    yield* atomicWrite(summaryPath, `${JSON.stringify(summary, undefined, 2)}\n`);
    yield* Console.log(`Embedding context benchmark summary: ${summaryPath}`);
  }),
);

function runObservation(
  sourceRoot: string,
  benchmarkScript: string,
  artifactPath: string,
  modelHome: string,
  contexts: EmbeddingContextPoolSize,
) {
  return runCommandEffect(
    process.execPath,
    [
      benchmarkScript,
      '--vectors',
      '--scale-symbols',
      String(SCALE_SYMBOLS),
      '--embedding-contexts',
      String(contexts),
      '--model-home',
      modelHome,
      '--samples',
      '1',
      '--warmups',
      '0',
      '--quiet',
      '--output',
      artifactPath,
    ],
    {
      cwd: sourceRoot,
      maxOutputBytes: 64 * 1_024,
      timeoutMs: OBSERVATION_TIMEOUT_MILLISECONDS,
    },
  ).pipe(
    Effect.asVoid,
    Effect.mapError(cause => ScriptError.make({message: `Embedding context ${contexts} benchmark failed.`, cause})),
  );
}

function validateObservationArtifact(
  artifact: BenchmarkArtifactV1,
  artifactPath: string,
  commit: string,
  contexts: EmbeddingContextPoolSize,
): void {
  if (
    artifact.environment.commit !== commit ||
    artifact.environment.dirty ||
    artifact.metadata.embeddingContextPoolSizeRequested !== contexts ||
    artifact.metadata.embeddingContextPoolSizeEffective !== contexts
  ) {
    throw ScriptError.make({
      message: `Embedding benchmark artifact ${artifactPath} does not match its scheduled clean run.`,
    });
  }
  validateThreadPlan(artifact, artifactPath, contexts);
}

function validateComparableArtifact(reference: BenchmarkArtifactV1, artifact: BenchmarkArtifactV1, path: string): void {
  if (reference.environment.dirty || artifact.environment.dirty) {
    throw ScriptError.make({message: `Embedding benchmark artifact ${path} was produced from dirty source.`});
  }
  const comparisons = [
    ['commit', reference.environment.commit, artifact.environment.commit],
    ['architecture', reference.environment.architecture, artifact.environment.architecture],
    ['CPU', reference.environment.cpu, artifact.environment.cpu],
    ['memory', reference.environment.memoryBytes, artifact.environment.memoryBytes],
    ['operating system', reference.environment.operatingSystem, artifact.environment.operatingSystem],
    ['Bun runtime', reference.environment.node, artifact.environment.node],
    ['package manager', reference.environment.packageManager, artifact.environment.packageManager],
    ['benchmark runner', reference.environment.runner, artifact.environment.runner],
    ['benchmark runner version', reference.environment.runnerVersion, artifact.environment.runnerVersion],
    ['fixture', reference.environment.fixtureHash, artifact.environment.fixtureHash],
    ['model', JSON.stringify(reference.environment.model), JSON.stringify(artifact.environment.model)],
    ['runner', reference.metadata.sameRunnerComparisonKey, artifact.metadata.sameRunnerComparisonKey],
    ['runner class', reference.metadata.runnerClass, artifact.metadata.runnerClass],
    ['runner identity', reference.metadata.runnerIdentity, artifact.metadata.runnerIdentity],
    ['runtime platform', reference.metadata.runtimePlatform, artifact.metadata.runtimePlatform],
    [
      'effective parser memory',
      reference.metadata.effectiveParserMemoryBytes,
      artifact.metadata.effectiveParserMemoryBytes,
    ],
    ['effective parser workers', reference.metadata.effectiveParserWorkers, artifact.metadata.effectiveParserWorkers],
    ['CPU math cores', reference.metadata.embeddingContextCpuMathCores, artifact.metadata.embeddingContextCpuMathCores],
    [
      'non-embedding environment overrides',
      normalizedEnvironmentOverrides(reference),
      normalizedEnvironmentOverrides(artifact),
    ],
    ['vector rows', reference.metadata.vectorRows, artifact.metadata.vectorRows],
    ['vector mapping digest', reference.metadata.coldVectorMappingDigest, artifact.metadata.coldVectorMappingDigest],
    ['embedding GPU layers', reference.metadata.embeddingModelGpuLayers, artifact.metadata.embeddingModelGpuLayers],
    [
      'cold structural digest',
      reference.metadata.structuralGraphDigestCold,
      artifact.metadata.structuralGraphDigestCold,
    ],
  ] as const;
  for (const [label, expected, actual] of comparisons) {
    if (actual !== expected)
      throw ScriptError.make({message: `Embedding benchmark artifact ${path} changed ${label}.`});
  }
  if (artifact.metadata.vectorEnabled !== true || artifact.metadata.scaleSymbols !== SCALE_SYMBOLS) {
    throw ScriptError.make({message: `Embedding benchmark artifact ${path} is not a 10k vector run.`});
  }
  if (artifact.suite !== reference.suite || artifact.version !== reference.version || artifact.warmups !== 0) {
    throw ScriptError.make({message: `Embedding benchmark artifact ${path} changed its benchmark contract.`});
  }
}

function validateThreadPlan(artifact: BenchmarkArtifactV1, path: string, contexts: EmbeddingContextPoolSize): void {
  const cpuMathCores = artifact.metadata.embeddingContextCpuMathCores;
  const gpuLayers = artifact.metadata.embeddingModelGpuLayers;
  const encoded = artifact.metadata.embeddingContextThreadCounts;
  if (typeof cpuMathCores !== 'number' || !Number.isSafeInteger(cpuMathCores) || cpuMathCores < 1) {
    throw ScriptError.make({message: `Embedding benchmark artifact ${path} has invalid CPU math-core telemetry.`});
  }
  if (contexts === 1) {
    if (encoded !== 'upstream-default') {
      throw ScriptError.make({message: `Embedding benchmark artifact ${path} changed the one-context thread default.`});
    }
    return;
  }
  if (gpuLayers !== 0 || typeof encoded !== 'string') {
    throw ScriptError.make({
      message: `Embedding benchmark artifact ${path} is not a CPU-thread-partitioned observation.`,
    });
  }
  const threads: number[] = EffectArray.map(Effect2.pipe(encoded, EffectString.split(',')), (value: string): number =>
    Number(value),
  );
  if (
    threads.length !== contexts ||
    EffectArray.some(threads, value => !Number.isSafeInteger(value) || value < 1) ||
    EffectArray.reduce(threads, 0, (sum, value) => sum + value) !== cpuMathCores ||
    EffectArray.some(threads, (value, index) => index > 0 && value > threads[index - 1]) ||
    EffectOption.getOrElse(EffectArray.head(threads), () => 0) -
      EffectOption.getOrElse(EffectArray.last(threads), () => 0) >
      1
  ) {
    throw ScriptError.make({message: `Embedding benchmark artifact ${path} has an invalid CPU-thread partition.`});
  }
}

function normalizedEnvironmentOverrides(artifact: BenchmarkArtifactV1): string {
  const encoded = artifact.metadata.environmentOverrides;
  if (typeof encoded !== 'string')
    throw ScriptError.make({message: 'Embedding benchmark artifact has no environment provenance.'});
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (cause) {
    throw ScriptError.make({message: 'Embedding benchmark artifact has invalid environment provenance.', cause});
  }
  if (!Predicate.isObject(parsed)) {
    throw ScriptError.make({message: 'Embedding benchmark artifact has invalid environment provenance.'});
  }
  const values = {...parsed};
  delete values[THREADNOTE_EMBEDDING_CONTEXTS_ENV];
  return JSON.stringify(
    EffectRecord.fromEntries(
      EffectRecord.toEntries(values).sort(([left], [right]) => Effect2.pipe(left, EffectString.localeCompare(right))),
    ),
  );
}

function validateSamplerIntegrity(artifact: BenchmarkArtifactV1, path: string): void {
  const positive = [
    'cold-external-storage-samples-n1',
    'cold-external-process-tree-samples-n1',
    'cold-external-process-tree-attempts-n1',
    'cold-embedding-progress-external-process-samples-n1',
  ];
  for (const name of positive) {
    if (measurement(artifact, name).minimum < 1) {
      throw ScriptError.make({message: `Embedding benchmark artifact ${path} has no usable ${name}.`});
    }
  }
  if (measurement(artifact, 'cold-external-sampler-version-n1').minimum < 4) {
    throw ScriptError.make({message: `Embedding benchmark artifact ${path} used an unsupported sampler.`});
  }
  if (measurement(artifact, 'cold-external-process-tree-failures-n1').maximum !== 0) {
    throw ScriptError.make({message: `Embedding benchmark artifact ${path} lost process-tree samples.`});
  }
  if (
    measurement(artifact, 'cold-external-process-tree-maximum-sample-gap-n1').maximum > SAMPLER_MAXIMUM_GAP_MILLISECONDS
  ) {
    throw ScriptError.make({message: `Embedding benchmark artifact ${path} exceeded the sampler gap ceiling.`});
  }
}

function measurement(artifact: BenchmarkArtifactV1, name: string): BenchmarkMeasurementV1 {
  const value = EffectOption.getOrUndefined(
    EffectArray.findFirst(artifact.measurements, candidate => candidate.name === name),
  );
  if (!value) throw ScriptError.make({message: `Embedding benchmark artifact is missing ${name}.`});
  return value;
}

function distribution(values: readonly number[]): DistributionSummary {
  if (values.length === 0 || EffectArray.some(values, value => !Number.isFinite(value) || value < 0)) {
    throw ScriptError.make({message: 'Embedding benchmark distribution is empty or invalid.'});
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
  return {
    maximum: sorted.at(-1)!,
    median: percentile(0.5),
    minimum: sorted[0],
    p25: percentile(0.25),
    p75: percentile(0.75),
  };
}

const cleanSourceState = Effect.fn('embeddingContextBenchmark.cleanSourceState')(function* (sourceRoot: string) {
  const [commitResult, statusResult] = yield* Effect.all(
    [
      runCommandEffect('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, maxOutputBytes: 4_096, timeoutMs: 30_000}),
      runCommandEffect(
        'git',
        [
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.untrackedCache=false',
          '-c',
          'status.showUntrackedFiles=all',
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
          '--no-renames',
        ],
        {cwd: sourceRoot, maxOutputBytes: 64 * 1_024, timeoutMs: 30_000},
      ),
    ],
    {concurrency: 2},
  ).pipe(Effect.mapError(cause => ScriptError.make({message: 'Could not validate benchmark source state.', cause})));
  const commit = Effect2.pipe(commitResult.stdout, EffectString.trim);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    return yield* ScriptError.make({message: 'Embedding benchmark source commit is invalid.'});
  }
  if (Effect2.pipe(statusResult.stdout, EffectString.trim)) {
    return yield* ScriptError.make({message: 'Embedding context promotion evidence requires a clean checkout.'});
  }
  return {commit};
});

const assertSourceState = Effect.fn('embeddingContextBenchmark.assertSourceState')(function* (
  sourceRoot: string,
  expectedCommit: string,
) {
  const current = yield* cleanSourceState(sourceRoot);
  if (current.commit !== expectedCommit) {
    return yield* ScriptError.make({message: 'Embedding benchmark source commit changed during the run.'});
  }
});

function validateRunManifest(
  value: unknown,
  commit: string,
  schedule: readonly (readonly EmbeddingContextPoolSize[])[],
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('commit' in value) ||
    value.commit !== commit ||
    !('rounds' in value) ||
    value.rounds !== schedule.length ||
    !('schedule' in value) ||
    JSON.stringify(value.schedule) !== JSON.stringify(schedule)
  ) {
    throw ScriptError.make({message: 'Embedding context benchmark run manifest does not match this invocation.'});
  }
}

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const scriptLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmark, scriptLayer));
