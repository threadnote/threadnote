#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {DateTime, Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  evaluateMemoryConnectionsScaleCapture,
  memoryConnectionsScaleCandidateBinding,
  MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
  parseMemoryConnectionsScaleArtifactV1,
  parseMemoryConnectionsScaleBudgetV1,
} from '@threadnote/threadnote/evaluation/memory-connections-scale-contract';
import {runMemoryConnectionsScaleWorkload} from '@threadnote/threadnote/evaluation/memory-connections-scale';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_BUDGET = 'apps/threadnote/test/evaluation/baselines/memory-connections-scale-v1/budget.json';
const GIT_STATUS_ARGS = [
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

export interface MemoryConnectionsScaleTargetOptions {
  readonly budgetPath: string;
  readonly builtArtifactSha256: string;
  readonly candidateCommit: string;
  readonly developmentSmoke: boolean;
  readonly memoryCandidates: number;
  readonly outputPath?: string;
  readonly samples: number;
  readonly warmups: number;
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const options = parseMemoryConnectionsScaleTargetArguments(yield* scriptArguments());
    const budget = parseMemoryConnectionsScaleBudgetV1(yield* readJsonFile(options.budgetPath));
    const commitObservation = gitObservation(['rev-parse', 'HEAD']);
    const statusObservation = gitObservation(GIT_STATUS_ARGS);
    const observedCommit = commitObservation.text;
    const dirty = !statusObservation.success || statusObservation.text.length > 0;
    if (!commitObservation.success || !/^[0-9a-f]{40}$/u.test(observedCommit)) {
      return yield* ScriptError.make({message: 'Could not resolve the exact benchmark source commit.'});
    }
    if (!options.developmentSmoke && (observedCommit !== options.candidateCommit || dirty)) {
      return yield* ScriptError.make({message: 'Release-scale evidence requires the exact clean candidate checkout.'});
    }
    const candidate = yield* readCandidateBinding(options.candidateCommit);
    const capture = yield* runMemoryConnectionsScaleWorkload({
      memoryCandidates: options.memoryCandidates,
      samples: options.samples,
      warmups: options.warmups,
    });
    const system = yield* SystemInfo;
    const hardware = yield* system.hardwareInfo;
    const environment = system.environment();
    const evaluated = evaluateMemoryConnectionsScaleCapture({
      budget,
      candidate,
      capture,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      identity: {
        architecture: system.architecture,
        builtArtifactSha256: options.builtArtifactSha256,
        candidateCommit: options.candidateCommit,
        cpu: hardware.cpuModel,
        dirty,
        gitStatusObserved: statusObservation.success,
        githubActions: environment.GITHUB_ACTIONS === 'true',
        invocationMode: options.developmentSmoke ? 'development-smoke' : 'release-scale',
        observedCommit,
        operatingSystem: hardware.operatingSystem,
        packageManager: candidate.packageManager,
        runnerArchitecture: environment.RUNNER_ARCH ?? system.architecture,
        runnerClass: environment.THREADNOTE_BENCHMARK_RUNNER_CLASS ?? 'local-unpinned',
        runnerEnvironment: environment.RUNNER_ENVIRONMENT ?? 'local',
        runnerOperatingSystem: environment.RUNNER_OS ?? system.platform,
        runtime: `bun/${system.runtimeVersion}`,
        sourceVersion: candidate.sourceVersion,
      },
    });
    const artifact = parseMemoryConnectionsScaleArtifactV1(evaluated, budget, candidate);
    if (options.outputPath !== undefined) {
      yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    }
    yield* printJson(artifact);
    if (!options.developmentSmoke && !artifact.gate.passed) {
      return yield* ScriptError.make({message: EffectArray.join(artifact.gate.failures, '\n')});
    }
  }),
);

export function parseMemoryConnectionsScaleTargetArguments(
  args: readonly string[],
): MemoryConnectionsScaleTargetOptions {
  let budgetPath = DEFAULT_BUDGET;
  let builtArtifactSha256 = '';
  let candidateCommit = '';
  let developmentSmoke = false;
  let memoryCandidates: number | undefined;
  let outputPath: string | undefined;
  let samples: number | undefined;
  let warmups: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--budget') budgetPath = required(args[++index], argument);
    else if (argument === '--built-artifact-sha256') builtArtifactSha256 = required(args[++index], argument);
    else if (argument === '--candidate-commit') candidateCommit = commit(args[++index], argument);
    else if (argument === '--development-smoke') developmentSmoke = true;
    else if (argument === '--memory-candidates') memoryCandidates = positiveInteger(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else throw ScriptError.make({message: `Unknown memory-connections scale option: ${argument}`});
  }
  if (!candidateCommit) throw ScriptError.make({message: '--candidate-commit is required.'});
  if (!developmentSmoke && (memoryCandidates !== undefined || samples !== undefined || warmups !== undefined)) {
    throw ScriptError.make({message: '--memory-candidates, --samples, and --warmups require --development-smoke.'});
  }
  return {
    budgetPath,
    builtArtifactSha256,
    candidateCommit,
    developmentSmoke,
    memoryCandidates:
      memoryCandidates ?? (developmentSmoke ? 1_000 : MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.corpusMemoryCount),
    ...(outputPath === undefined ? {} : {outputPath}),
    samples: samples ?? (developmentSmoke ? 3 : MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.minimumSamples),
    warmups: warmups ?? (developmentSmoke ? 1 : MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.minimumWarmups),
  };
}

function gitObservation(args: readonly string[]): {readonly success: boolean; readonly text: string} {
  const result = Bun.spawnSync({cmd: ['git', ...args], stderr: 'ignore', stdout: 'pipe'});
  return {
    success: result.exitCode === 0,
    text: result.stdout ? Effect2.pipe(new TextDecoder().decode(result.stdout), EffectString.trim) : '',
  };
}

const readCandidateBinding = Effect.fn('memoryConnectionsScale.readCandidate')(function* (candidateCommit: string) {
  const manifest = gitObservation(['show', `${candidateCommit}:package.json`]);
  if (!manifest.success) {
    return yield* ScriptError.make({message: 'Could not read package.json from the exact release candidate.'});
  }
  return yield* Effect.try({
    try: () => memoryConnectionsScaleCandidateBinding(candidateCommit, JSON.parse(manifest.text) as unknown),
    catch: cause => ScriptError.make({message: 'Could not validate the candidate package and Bun versions.', cause}),
  });
});

function commit(value: string | undefined, option: string): string {
  const parsed = required(value, option);
  if (!/^[0-9a-f]{40}$/u.test(parsed))
    throw ScriptError.make({message: `${option} requires 40 lowercase hex characters.`});
  return parsed;
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = nonNegativeInteger(value, option);
  if (parsed < 1) throw ScriptError.make({message: `${option} requires a positive integer.`});
  return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string): number {
  const raw = required(value, option);
  if (!/^\d+$/u.test(raw)) throw ScriptError.make({message: `${option} requires a non-negative integer.`});
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw ScriptError.make({message: `${option} exceeds the safe integer range.`});
  return parsed;
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
