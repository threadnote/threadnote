import {Array as EffectArray} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, DateTime, Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {benchmarkMeasurement} from '@threadnote/evidence/benchmark';
import {
  createMonorepoShareRecallStressFixture,
  MONOREPO_SHARE_RECALL_STRESS_MODES,
  MONOREPO_SHARE_RECALL_STRESS_SCENARIOS,
  monorepoShareRecallStressCandidates,
  runMonorepoShareRecallStressPass,
  summarizeMonorepoShareRecallStressPass,
  type MonorepoShareRecallStressMode,
  type MonorepoShareRecallStressOptions,
  type MonorepoShareRecallStressScenario,
} from '@threadnote/threadnote/evaluation/recall-monorepo-stress';
import {RECALL_RANKER_VERSION} from '@threadnote/recall/rank';
import {recallCrossScopeLaneBudgets} from '@threadnote/recall/runtime';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {atomicWrite, fixtureHash, printJson, scriptArguments} from './effect/script.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const MAXIMUM_PHYSICAL_CANDIDATES_PER_SCENARIO = 250_000;

interface StressPass {
  readonly candidates: ReturnType<typeof monorepoShareRecallStressCandidates>;
  readonly fixture: ReturnType<typeof createMonorepoShareRecallStressFixture>;
  readonly key: `${MonorepoShareRecallStressScenario}:${MonorepoShareRecallStressMode}`;
  readonly mode: MonorepoShareRecallStressMode;
  readonly scenario: MonorepoShareRecallStressScenario;
}

const benchmarkRecallMonorepoShares = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const options = parseRecallMonorepoSharesBenchmarkArguments(yield* scriptArguments());
  const fixtures = EffectArray.map(MONOREPO_SHARE_RECALL_STRESS_SCENARIOS, scenario =>
    createMonorepoShareRecallStressFixture(options.fixture, scenario),
  );
  const passes: readonly StressPass[] = EffectArray.flatMap(fixtures, fixture =>
    EffectArray.map(MONOREPO_SHARE_RECALL_STRESS_MODES, mode => ({
      candidates: monorepoShareRecallStressCandidates(fixture, mode),
      fixture,
      key: `${fixture.scenario}:${mode}` as const,
      mode,
      scenario: fixture.scenario,
    })),
  );

  for (let index = 0; index < options.warmups; index += 1) {
    for (const pass of passes) runMonorepoShareRecallStressPass(pass.fixture, pass.candidates);
  }

  const durations = new Map(EffectArray.map(passes, pass => [pass.key, [] as number[]]));
  for (let index = 0; index < options.samples; index += 1) {
    for (const pass of rotateRecallBenchmarkPasses(passes, index)) {
      const startedAt = yield* Clock.currentTimeNanos;
      runMonorepoShareRecallStressPass(pass.fixture, pass.candidates);
      const finishedAt = yield* Clock.currentTimeNanos;
      durations.get(pass.key)!.push(Number(finishedAt - startedAt) / NANOSECONDS_PER_MILLISECOND);
    }
    yield* Effect.yieldNow;
  }

  const summaries = EffectRecord.fromEntries(
    EffectArray.map(MONOREPO_SHARE_RECALL_STRESS_SCENARIOS, scenario => [
      scenario,
      EffectRecord.fromEntries(
        EffectArray.map(
          EffectArray.filter(passes, pass => pass.scenario === scenario),
          pass => [
            pass.mode,
            summarizeMonorepoShareRecallStressPass(pass.fixture, pass.mode, pass.candidates, runPass(pass)),
          ],
        ),
      ),
    ]),
  );
  const [commit, status, hardware, sourceVersion, hash] = yield* Effect.all(
    [
      git(['rev-parse', 'HEAD']),
      git(['status', '--porcelain']),
      system.hardwareInfo,
      getThreadnoteVersion(),
      fixtureHash(JSON.stringify(fixtures)),
    ],
    {concurrency: 'unbounded'},
  );
  const artifact = {
    createdAt: DateTime.formatIso(yield* DateTime.now),
    environment: {
      architecture: system.architecture,
      commit,
      cpu: hardware.cpuModel,
      dirty: status.length > 0,
      fixtureHash: hash,
      memoryBytes: hardware.memoryBytes,
      operatingSystem: hardware.operatingSystem,
      runtime: `bun/${system.runtimeVersion}`,
    },
    measurements: EffectArray.map(passes, pass =>
      benchmarkMeasurement(`${pass.scenario}-${pass.mode}-rank-latency`, 'milliseconds', durations.get(pass.key)!),
    ),
    metadata: {
      rankerVersion: RECALL_RANKER_VERSION,
      sourceVersion: `threadnote-${sourceVersion}`,
      timingScope: 'in-memory ranking over pre-admitted candidates; excludes admission, SQLite, and filesystem I/O',
    },
    shape: {
      ...options.fixture,
      laneBudgets: recallCrossScopeLaneBudgets(options.fixture.topK),
      personalCopies: options.fixture.packages * options.fixture.logicalMemoriesPerPackage,
      physicalCandidatesPerScenario: fixtures[0].candidates.length,
      scenarios: EffectRecord.fromEntries(
        EffectArray.map(fixtures, fixture => [
          fixture.scenario,
          {
            relevantWorkspaceScope: fixture.relevantWorkspaceScope,
            targetWorkspaceScope: fixture.targetWorkspaceScope,
          },
        ]),
      ),
    },
    summaries,
    suite: 'recall-monorepo-shares-cross-scope',
    version: 2,
    warmups: options.warmups,
  };
  if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  yield* printJson(artifact);
});

export interface RecallMonorepoSharesBenchmarkOptions {
  readonly fixture: MonorepoShareRecallStressOptions;
  readonly outputPath?: string;
  readonly samples: number;
  readonly warmups: number;
}

export function parseRecallMonorepoSharesBenchmarkArguments(
  args: readonly string[],
): RecallMonorepoSharesBenchmarkOptions {
  let packages = 64;
  let logicalMemoriesPerPackage = 128;
  let shareAliasesPerMemory = 3;
  let targetPackage = 0;
  let siblingPackage: number | undefined;
  let topK = 5;
  let seed = 0x4_02_07;
  let samples = 10;
  let warmups = 2;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--packages') packages = positiveInteger(args[++index], argument);
    else if (argument === '--logical-per-package') {
      logicalMemoriesPerPackage = positiveInteger(args[++index], argument);
    } else if (argument === '--share-aliases') shareAliasesPerMemory = nonNegativeInteger(args[++index], argument);
    else if (argument === '--target-package') targetPackage = nonNegativeInteger(args[++index], argument);
    else if (argument === '--sibling-package') siblingPackage = nonNegativeInteger(args[++index], argument);
    else if (argument === '--top-k') topK = positiveInteger(args[++index], argument);
    else if (argument === '--seed') seed = positiveInteger(args[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else if (argument === '--output') outputPath = requiredValue(args[++index], argument);
    else throw ScriptError.make({message: `Unknown monorepo/share recall benchmark option: ${argument}`});
  }
  if (packages < 2)
    throw ScriptError.make({message: '--packages must include a current package and a sibling package'});
  if (targetPackage >= packages) throw ScriptError.make({message: '--target-package must be smaller than --packages'});
  const resolvedSiblingPackage = siblingPackage ?? (targetPackage + 1) % packages;
  if (resolvedSiblingPackage >= packages)
    throw ScriptError.make({message: '--sibling-package must be smaller than --packages'});
  if (resolvedSiblingPackage === targetPackage) {
    throw ScriptError.make({message: '--sibling-package must differ from --target-package'});
  }
  const physicalCandidates = packages * logicalMemoriesPerPackage * (shareAliasesPerMemory + 1);
  if (!Number.isSafeInteger(physicalCandidates) || physicalCandidates > MAXIMUM_PHYSICAL_CANDIDATES_PER_SCENARIO) {
    throw ScriptError.make({
      message: `Generated workload must not exceed ${MAXIMUM_PHYSICAL_CANDIDATES_PER_SCENARIO.toLocaleString('en-US')} physical candidates per scenario.`,
    });
  }
  return {
    fixture: {
      logicalMemoriesPerPackage,
      packages,
      seed,
      shareAliasesPerMemory,
      siblingPackage: resolvedSiblingPackage,
      targetPackage,
      topK,
    },
    outputPath,
    samples,
    warmups,
  };
}

function runPass(pass: StressPass) {
  return runMonorepoShareRecallStressPass(pass.fixture, pass.candidates);
}

/** Rotate the complete pass matrix so no fixed scenario/mode always pays the same order bias. */
export function rotateRecallBenchmarkPasses<T>(passes: readonly T[], sample: number): readonly T[] {
  if (passes.length === 0) return [];
  const offset = sample % passes.length;
  return [...passes.slice(offset), ...passes.slice(0, offset)];
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

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkRecallMonorepoShares, ApplicationLayer));
