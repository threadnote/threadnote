#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {DateTime, Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
  CODE_MEMORY_LINK_SCALE_DEVELOPMENT_MAXIMUM_SAMPLES,
  CODE_MEMORY_LINK_SCALE_DEVELOPMENT_MAXIMUM_WARMUPS,
  codeMemoryLinkScaleCandidateBindingV1,
  codeMemoryLinkScaleAttestationSubjectV1,
  codeMemoryLinkScaleReleaseClaimFailures,
  evaluateCodeMemoryLinkScaleCapture,
  parseCodeMemoryLinkScaleBudgetV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-scale-contract';
import {runCodeMemoryLinkScaleWorkload} from '@threadnote/threadnote/evaluation/code-memory-link-scale';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_BUDGET = 'apps/threadnote/test/evaluation/baselines/code-memory-link-scale-v1/budget.json';
const CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS = [
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

export interface CodeMemoryLinkScaleTargetOptions {
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
    const options = parseCodeMemoryLinkScaleTargetArguments(yield* scriptArguments());
    if (!options.developmentSmoke && options.outputPath === undefined) {
      return yield* ScriptError.make({
        message:
          'Release capture requires --output; it must be signed and independently verified before release-scale promotion.',
      });
    }
    const budget = parseCodeMemoryLinkScaleBudgetV1(yield* readJsonFile(options.budgetPath));
    const observedCommitResult = gitResult(['rev-parse', 'HEAD']);
    const statusResult = gitResult(CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS);
    const observedCommit = observedCommitResult.text;
    const dirty = !statusResult.success || statusResult.text.length > 0;
    if (observedCommit.length !== 40) {
      return yield* ScriptError.make({message: 'Could not resolve the exact benchmark source commit.'});
    }
    if (!options.developmentSmoke && observedCommit !== options.candidateCommit) {
      return yield* ScriptError.make({
        message: `Observed commit ${observedCommit}; required exact candidate ${options.candidateCommit}.`,
      });
    }
    if (!options.developmentSmoke && dirty) {
      return yield* ScriptError.make({
        message: 'Release-scale evidence requires an exact clean checkout (dirty=false).',
      });
    }
    if (!options.developmentSmoke && !/^[0-9a-f]{64}$/u.test(options.builtArtifactSha256)) {
      return yield* ScriptError.make({message: 'Release-scale evidence requires the built target SHA-256 digest.'});
    }
    const system = yield* SystemInfo;
    const [hardware, sourceVersion] = yield* Effect.all([system.hardwareInfo, getThreadnoteVersion()]);
    const candidateBinding = readCandidateBinding(options.candidateCommit);
    if (!options.developmentSmoke && candidateBinding === undefined) {
      return yield* ScriptError.make({
        message: 'Release-scale evidence requires the exact candidate package manifest to be readable from Git.',
      });
    }
    const identity = identityFromEnvironment({
      builtArtifactSha256: options.builtArtifactSha256,
      candidateBinding,
      candidateCommit: options.candidateCommit,
      dirty,
      gitStatusObserved: statusResult.success,
      invocationMode: options.developmentSmoke ? 'development-smoke' : 'release-scale',
      observedCommit,
      sourceVersion,
      system,
      hardware,
    });
    if (!options.developmentSmoke) {
      const provenanceFailures = codeMemoryLinkScaleReleaseClaimFailures(identity, candidateBinding);
      if (provenanceFailures.length > 0) {
        return yield* ScriptError.make({message: EffectArray.join(provenanceFailures, '\n')});
      }
    }
    const capture = yield* runCodeMemoryLinkScaleWorkload({
      memoryCandidates: options.memoryCandidates,
      samples: options.samples,
      warmups: options.warmups,
    });
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      ...(candidateBinding === undefined ? {} : {candidateBinding}),
      capture,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      identity,
    });
    if (options.outputPath !== undefined) {
      yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
      if (!options.developmentSmoke)
        yield* atomicWrite(`${options.outputPath}.subject.json`, codeMemoryLinkScaleAttestationSubjectV1(artifact));
    }
    yield* printJson(artifact);
    const captureFailures = EffectArray.filter(
      artifact.gate.failures,
      failure =>
        failure !== 'artifact is a development smoke, not release-scale evidence' &&
        failure !== 'release-scale evidence requires an independently supplied runner binding',
    );
    if (!options.developmentSmoke && captureFailures.length > 0) {
      return yield* ScriptError.make({message: EffectArray.join(captureFailures, '\n')});
    }
  }),
);

export function parseCodeMemoryLinkScaleTargetArguments(args: readonly string[]): CodeMemoryLinkScaleTargetOptions {
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
    else throw ScriptError.make({message: `Unknown inverse-selector scale benchmark option: ${argument}`});
  }
  if (!candidateCommit) throw ScriptError.make({message: '--candidate-commit is required.'});
  if (!developmentSmoke && (memoryCandidates !== undefined || samples !== undefined || warmups !== undefined)) {
    throw ScriptError.make({
      message: '--memory-candidates, --samples, and --warmups require --development-smoke; release scale is fixed.',
    });
  }
  if (
    (samples ?? 0) > CODE_MEMORY_LINK_SCALE_DEVELOPMENT_MAXIMUM_SAMPLES ||
    (warmups ?? 0) > CODE_MEMORY_LINK_SCALE_DEVELOPMENT_MAXIMUM_WARMUPS
  ) {
    throw ScriptError.make({message: 'Development observation maximum is 25 samples and 5 warmups.'});
  }
  return {
    budgetPath,
    builtArtifactSha256,
    candidateCommit,
    developmentSmoke,
    memoryCandidates:
      memoryCandidates ?? (developmentSmoke ? 1_000 : CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.corpusMemoryCount),
    ...(outputPath === undefined ? {} : {outputPath}),
    samples: samples ?? (developmentSmoke ? 3 : CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.minimumSamples),
    warmups: warmups ?? (developmentSmoke ? 1 : CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.minimumWarmups),
  };
}

function readCandidateBinding(candidateCommit: string) {
  const manifest = gitResult(['show', `${candidateCommit}:package.json`]);
  if (!manifest.success) return undefined;
  try {
    return codeMemoryLinkScaleCandidateBindingV1(candidateCommit, JSON.parse(manifest.text) as unknown);
  } catch {
    return undefined;
  }
}

export function identityFromEnvironment(input: {
  readonly builtArtifactSha256: string;
  readonly candidateBinding: ReturnType<typeof readCandidateBinding>;
  readonly candidateCommit: string;
  readonly dirty: boolean;
  readonly gitStatusObserved: boolean;
  readonly hardware: {readonly cpuModel: string; readonly memoryBytes: number; readonly operatingSystem: string};
  readonly invocationMode: 'development-smoke' | 'release-scale';
  readonly observedCommit: string;
  readonly sourceVersion: string;
  readonly system: {
    readonly architecture: string;
    readonly environment: () => Record<string, string | undefined>;
    readonly platform: string;
    readonly runtimeVersion: string;
  };
}) {
  const environment = input.system.environment();
  const smoke = input.invocationMode === 'development-smoke';
  const fallbackCommit = /^[0-9a-f]{40}$/u.test(input.observedCommit) ? input.observedCommit : input.candidateCommit;
  const candidateVersion = input.candidateBinding?.candidateVersion ?? input.sourceVersion;
  return {
    architecture: input.system.architecture,
    builtArtifactSha256: input.builtArtifactSha256,
    candidateCommit: input.candidateCommit,
    candidateVersion,
    cpu: input.hardware.cpuModel,
    dirty: input.dirty,
    gitStatusObserved: input.gitStatusObserved,
    github: {
      actions: environment.GITHUB_ACTIONS === 'true',
      eventName:
        Effect2.pipe(environment.GITHUB_EVENT_NAME, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) || 'local',
      job:
        Effect2.pipe(environment.GITHUB_JOB, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) || 'local',
      ref:
        Effect2.pipe(environment.GITHUB_REF, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) || 'local',
      repository:
        Effect2.pipe(environment.GITHUB_REPOSITORY, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) || 'local',
      repositoryId:
        Effect2.pipe(environment.GITHUB_REPOSITORY_ID, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) || 'local',
      runAttempt: environmentInteger(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT', smoke),
      runId: environmentInteger(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID', smoke),
      sha: environmentCommit(environment.GITHUB_SHA, 'GITHUB_SHA', smoke, fallbackCommit),
      workflowRef:
        Effect2.pipe(environment.GITHUB_WORKFLOW_REF, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        ) || 'local',
      workflowSha: environmentCommit(environment.GITHUB_WORKFLOW_SHA, 'GITHUB_WORKFLOW_SHA', smoke, fallbackCommit),
    },
    invocationMode: input.invocationMode,
    memoryBytes: input.hardware.memoryBytes,
    observedCommit: input.observedCommit,
    operatingSystem: input.hardware.operatingSystem,
    packageManager: input.candidateBinding?.packageManager ?? 'bun@local',
    runnerArchitecture:
      Effect2.pipe(environment.RUNNER_ARCH, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || input.system.architecture,
    runnerClass:
      Effect2.pipe(environment.THREADNOTE_BENCHMARK_RUNNER_CLASS, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || 'local-unpinned',
    runnerEnvironment:
      Effect2.pipe(environment.RUNNER_ENVIRONMENT, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || 'local',
    runnerOperatingSystem:
      Effect2.pipe(environment.RUNNER_OS, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || input.system.platform,
    runtime: `bun/${input.system.runtimeVersion}`,
    sourceVersion: `threadnote-${input.sourceVersion}`,
  };
}

function environmentInteger(value: string | undefined, name: string, smoke: boolean): number {
  const parsed = Number(value);
  if (value !== undefined && /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(parsed)) return parsed;
  if (smoke) return 1;
  throw ScriptError.make({message: `Release scale requires a valid raw ${name} positive integer.`});
}

function environmentCommit(value: string | undefined, name: string, smoke: boolean, fallback: string): string {
  if (value !== undefined && /^[0-9a-f]{40}$/u.test(value)) return value;
  if (smoke) return fallback;
  throw ScriptError.make({message: `Release scale requires a valid raw ${name} commit SHA.`});
}

function gitResult(args: readonly string[]): {readonly success: boolean; readonly text: string} {
  const result = Bun.spawnSync({cmd: ['git', ...args], stderr: 'ignore', stdout: 'pipe'});
  return {
    success: result.exitCode === 0,
    text:
      result.exitCode === 0 && result.stdout
        ? Effect2.pipe(new TextDecoder().decode(result.stdout), EffectString.trim)
        : '',
  };
}

function commit(value: string | undefined, option: string): string {
  const parsed = required(value, option);
  if (!/^[0-9a-f]{40}$/u.test(parsed))
    throw ScriptError.make({message: `${option} requires exactly 40 lowercase hex characters.`});
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
