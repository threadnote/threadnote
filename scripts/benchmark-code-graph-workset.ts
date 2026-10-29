import {Array as EffectArray, Option as EffectOption} from 'effect';
import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  BENCHMARK_ARTIFACT_VERSION,
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
} from '@threadnote/evidence/benchmark';
import {atomicWrite, printJson, scriptArguments} from './effect/script.js';
import {
  codeGraphWorksetBenchmarkBudgetFailures,
  codeGraphWorksetBenchmarkMeasurements,
  codeGraphWorksetBenchmarkSample,
  codeGraphWorksetRuntimeConfig,
  indexPreparedCodeGraphWorksetFixture,
  measureCodeGraphWorksetQuery,
  publishIndexedCodeGraphWorksetCatalog,
} from './support/code-graph-workset-harness.js';
import {
  CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES,
  prepareCodeGraphWorksetFixture,
  removePreparedCodeGraphWorksetFixture,
  type CodeGraphWorksetFixtureSize,
} from './support/code-graph-workset-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_SAMPLES = 5;
const DEFAULT_WARMUPS = 1;
const BENCHMARK_QUERY_ID = 'symbol-resolve-tenant-session';

export interface CodeGraphWorksetBenchmarkArguments {
  readonly failOnBudget: boolean;
  readonly outputPath?: string;
  readonly samples: number;
  readonly sizes: readonly CodeGraphWorksetFixtureSize[];
  readonly warmups: number;
}

export function parseCodeGraphWorksetBenchmarkArguments(args: readonly string[]): CodeGraphWorksetBenchmarkArguments {
  let failOnBudget = false;
  let outputPath: string | undefined;
  let samples = DEFAULT_SAMPLES;
  let sizes: readonly CodeGraphWorksetFixtureSize[] = CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES;
  let warmups = DEFAULT_WARMUPS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--fail-on-budget') failOnBudget = true;
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--samples') samples = integer(args[++index], argument, 1, 100);
    else if (argument === '--sizes') sizes = parseBenchmarkSizes(required(args[++index], argument));
    else if (argument === '--warmups') warmups = integer(args[++index], argument, 0, 100);
    else throw ScriptError.make({message: `Unknown code graph workset benchmark option: ${argument}`});
  }
  return {failOnBudget, outputPath, samples, sizes, warmups};
}

export const benchmarkCodeGraphWorkset = Effect.scoped(
  Effect.gen(function* () {
    const options = parseCodeGraphWorksetBenchmarkArguments(yield* scriptArguments());
    const initialSize = options.sizes[0];
    if (initialSize === undefined)
      return yield* ScriptError.make({message: 'At least one benchmark size is required.'});
    let maximumSize: CodeGraphWorksetFixtureSize = initialSize;
    for (const size of options.sizes) if (size > maximumSize) maximumSize = size;
    const prepared = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => prepareCodeGraphWorksetFixture({size: maximumSize, stateProfile: 'all-clean'}),
        catch: cause => scriptError(cause),
      }),
      fixture =>
        Effect.tryPromise({
          try: () => removePreparedCodeGraphWorksetFixture(fixture),
          catch: cause => scriptError(cause),
        }).pipe(Effect.ignore),
    );
    yield* indexPreparedCodeGraphWorksetFixture(prepared);
    const selectedWorksets = EffectArray.map(options.sizes, size => {
      const workset = EffectOption.getOrUndefined(
        EffectArray.findFirst(prepared.plan.worksets, candidate => candidate.size === size),
      );
      if (!workset) throw ScriptError.make({message: `Fixture did not emit a size-${size} workset.`});
      return workset.name;
    });
    yield* publishIndexedCodeGraphWorksetCatalog(prepared, selectedWorksets);
    const config = codeGraphWorksetRuntimeConfig(prepared);
    const query = EffectOption.getOrUndefined(
      EffectArray.findFirst(prepared.plan.queries, candidate => candidate.id === BENCHMARK_QUERY_ID),
    );
    if (!query) return yield* ScriptError.make({message: `Fixture is missing benchmark query ${BENCHMARK_QUERY_ID}.`});

    const samples = [];
    for (const worksetSize of options.sizes) {
      const workset = EffectOption.getOrUndefined(
        EffectArray.findFirst(prepared.plan.worksets, candidate => candidate.size === worksetSize),
      );
      if (!workset) return yield* ScriptError.make({message: `Fixture did not emit a size-${worksetSize} workset.`});
      for (let warmup = 0; warmup < options.warmups; warmup += 1) {
        yield* measureCodeGraphWorksetQuery(config, workset.name, query.query);
      }
      for (let sample = 0; sample < options.samples; sample += 1) {
        const measured = yield* measureCodeGraphWorksetQuery(config, workset.name, query.query);
        samples.push(codeGraphWorksetBenchmarkSample(worksetSize, measured));
      }
    }

    const measurements = codeGraphWorksetBenchmarkMeasurements(samples);
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const [commit, dirty] = yield* Effect.all(
      [sourceGit(['rev-parse', 'HEAD']), sourceGit(['status', '--porcelain'])],
      {
        concurrency: 2,
      },
    );
    const artifact: BenchmarkArtifactV1 = parseBenchmarkArtifactV1({
      createdAt: benchmarkCreatedAt(system.environment()),
      environment: {
        architecture: system.architecture,
        commit,
        cpu: hardware.cpuModel,
        dirty: dirty.length > 0,
        fixtureHash: prepared.identity.id,
        memoryBytes: hardware.memoryBytes,
        node: `bun/${system.runtimeVersion}`,
        operatingSystem: hardware.operatingSystem,
        packageManager: `bun/${system.runtimeVersion}`,
        runner: 'threadnote-code-graph-workset',
        runnerVersion: '1',
      },
      measurements,
      metadata: {
        agentTokenEstimate: 'utf8-bytes-divided-by-3; not a representative tokenizer count',
        catalogBytesRead: 0,
        currentRepositoryCap: 0,
        evidenceUnit: 'globally-ranked-v2-evidence-card',
        firstEvidenceSemantics: 'buffered-response; delivered time-to-first equals completion',
        requestedSizes: EffectArray.join(
          EffectArray.map(options.sizes, item => (item === null || item === undefined ? '' : String(item))),
          ',',
        ),
        responseSurface: 'canonical Workset Search 2.0 structuredContent plus terse text',
        routingMode: 'complete indexed catalog with adaptive 4/4/16 deep expansion',
      },
      suite: 'code-graph-workset-v2',
      version: BENCHMARK_ARTIFACT_VERSION,
      warmups: options.warmups,
    });
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    yield* printJson(artifact);
    if (options.failOnBudget) {
      const failures = codeGraphWorksetBenchmarkBudgetFailures(measurements, options.sizes);
      if (failures.length > 0) return yield* ScriptError.make({message: EffectArray.join(failures, '\n')});
    }
  }),
);

function parseBenchmarkSizes(value: string): readonly CodeGraphWorksetFixtureSize[] {
  const parts = Effect2.pipe(value, EffectString.split(','));
  if (parts.length === 0 || EffectArray.some(parts, part => !Effect2.pipe(part, EffectString.trim)))
    throw ScriptError.make({message: '--sizes requires comma-separated sizes.'});
  const sizes: number[] = EffectArray.map(parts, (part: string): number =>
    Number(Effect2.pipe(part, EffectString.trim)),
  );
  if (EffectArray.some(sizes, size => !Number.isSafeInteger(size) || size < 1)) {
    throw ScriptError.make({message: '--sizes requires positive integer sizes.'});
  }
  if (new Set(sizes).size !== sizes.length) throw ScriptError.make({message: '--sizes sizes must be unique.'});
  for (const size of sizes) {
    if (!isCodeGraphWorksetFixtureSize(size)) {
      throw ScriptError.make({
        message: `--sizes only accepts benchmark sizes: ${EffectArray.join(
          EffectArray.map(CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES, item =>
            item === null || item === undefined ? '' : String(item),
          ),
          ', ',
        )}. Received ${size}.`,
      });
    }
  }
  return EffectArray.filter(
    [...sizes].sort((left, right) => left - right),
    isCodeGraphWorksetFixtureSize,
  );
}

function isCodeGraphWorksetFixtureSize(value: number): value is CodeGraphWorksetFixtureSize {
  return EffectArray.some(CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES, size => size === value);
}

function integer(value: string | undefined, option: string, minimum: number, maximum: number): number {
  const parsed = Number(required(value, option));
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw ScriptError.make({message: `${option} must be an integer from ${minimum} through ${maximum}.`});
  }
  return parsed;
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

function benchmarkCreatedAt(environment: NodeJS.ProcessEnv): string {
  const epoch = environment.SOURCE_DATE_EPOCH;
  if (epoch === undefined) return new Date().toISOString();
  if (!/^\d+$/.test(epoch))
    throw ScriptError.make({message: 'SOURCE_DATE_EPOCH must be a non-negative integer number of seconds.'});
  const date = new Date(Number(epoch) * 1_000);
  if (!Number.isFinite(date.getTime()))
    throw ScriptError.make({message: 'SOURCE_DATE_EPOCH is outside the supported date range.'});
  return date.toISOString();
}

const sourceGit = Effect.fn('benchmarkCodeGraphWorkset.git')((args: readonly string[]) =>
  runCommandEffect('git', ['-C', process.cwd(), ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}).pipe(
    Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
  ),
);

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkCodeGraphWorkset, ApplicationLayer));
