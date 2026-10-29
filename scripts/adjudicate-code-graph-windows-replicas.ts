#!/usr/bin/env bun
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';

import {parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {enforceCodeGraphBenchmarkBudget} from './benchmark-code-graph.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_BUDGET = 'apps/threadnote/test/evaluation/baselines/code-graph-v1/budgets.json';
const WINDOWS_REPLICA_FILE = /^code-graph-Windows-X64-replica-([123])\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const SANITIZED_RUNNER_IDENTITY = /^runner-[0-9a-f]{16}$/u;

interface WindowsReplicaPolicyV1 {
  readonly coldMaterializationProcessCpuMillisecondsMaximum: 3000;
  readonly hardWallP95MillisecondsMaximum: 1900;
  readonly nestedMaterializationUsesEnclosingSafetyCeiling: true;
  readonly oneFileMaterializationProcessCpuMillisecondsMaximum: 200;
  readonly ordinaryPassesMinimum: 2;
  readonly ordinaryWallP95MillisecondsMaximum: 1050;
  readonly replicas: 3;
  readonly samplesPerReplica: 100;
  readonly schedulerSensitiveWallClockSafetyMultiplier: 2;
  readonly wholeGraphAnalysisProcessCpuP95MillisecondsMaximum: 400;
  readonly warmupsPerReplica: 5;
}

export interface CodeGraphWindowsReplicaInput {
  readonly artifact: BenchmarkArtifactV1;
  readonly artifactSha256: string;
  readonly replica: number;
}

export interface CodeGraphWindowsReplicaGateV1 {
  readonly createdAt: string;
  readonly environment: {
    readonly architecture: string;
    readonly commit: string;
    readonly fixtureHash: string;
    readonly node: string;
    readonly operatingSystem: string;
    readonly runnerClass: string;
    readonly runtimePlatform: string;
  };
  readonly gate: {readonly failures: readonly string[]; readonly passed: boolean};
  readonly policy: WindowsReplicaPolicyV1 & {
    readonly adjudication: 'all-safety-and-two-of-three-ordinary';
    readonly experimentalUnit: 'independent-hosted-runner';
  };
  readonly replicas: readonly {
    readonly artifactSha256: string;
    readonly createdAt: string;
    readonly hotQuery: {
      readonly maximum: number;
      readonly p50: number;
      readonly p95: number;
      readonly samples: number;
    };
    readonly coldMaterializationProcessCpu: {
      readonly maximum: number;
      readonly p50: number;
      readonly p95: number;
      readonly samples: number;
    };
    readonly ordinaryPassed: boolean;
    readonly processCpu: {
      readonly maximum: number;
      readonly p50: number;
      readonly p95: number;
      readonly samples: number;
    };
    readonly oneFileMaterializationProcessCpu: {
      readonly maximum: number;
      readonly p50: number;
      readonly p95: number;
      readonly samples: number;
    };
    readonly replica: number;
    readonly runnerIdentity: string;
    readonly safetyPassed: boolean;
    readonly wholeGraphAnalysis: {
      readonly maximum: number;
      readonly p50: number;
      readonly p95: number;
      readonly samples: number;
    };
    readonly wholeGraphAnalysisProcessCpu: {
      readonly maximum: number;
      readonly p50: number;
      readonly p95: number;
      readonly samples: number;
    };
  }[];
  readonly suite: 'code-graph-windows-hosted-replicas-v1';
  readonly version: 1;
}

export function adjudicateCodeGraphWindowsReplicas(
  inputs: readonly CodeGraphWindowsReplicaInput[],
  budgetInput: unknown,
  expectedCommit: string,
): CodeGraphWindowsReplicaGateV1 {
  if (!GIT_COMMIT.test(expectedCommit))
    throw ScriptError.make({message: 'Expected commit must be an exact lowercase Git SHA-1.'});
  const policy = parseWindowsReplicaPolicy(budgetInput);
  const safetyBudget = windowsReplicaSafetyBudget(budgetInput, policy);
  const expectedFixtureHash = budgetFixtureHash(budgetInput);
  const sorted = [...inputs].sort((left, right) => left.replica - right.replica);
  const failures: string[] = [];
  const expectedReplicas = Array.from({length: policy.replicas}, (_, index) => index + 1);
  if (JSON.stringify(EffectArray.map(sorted, input => input.replica)) !== JSON.stringify(expectedReplicas)) {
    failures.push(
      `replica ordinals must be exactly ${EffectArray.join(
        EffectArray.map(expectedReplicas, item => (item === null || item === undefined ? '' : String(item))),
        ',',
      )}`,
    );
  }

  const parsed = EffectArray.map(sorted, input => ({artifact: parseBenchmarkArtifactV1(input.artifact), input}));
  for (const {artifact, input} of parsed) {
    assertUniqueMeasurementNames(artifact, `replica ${input.replica}`);
  }

  const observations = EffectArray.map(parsed, ({artifact, input}) => {
    const prefix = `replica ${input.replica}`;
    const runnerClass = stringMetadata(artifact, 'runnerClass');
    const runnerIdentity = stringMetadata(artifact, 'runnerIdentity');
    const runtimePlatform = stringMetadata(artifact, 'runtimePlatform');
    const hotQuery = requiredMeasurement(artifact, 'hot-exact-lexical-query');
    const processCpu = requiredMeasurement(artifact, 'hot-query-process-cpu');
    const coldMaterializationProcessCpu = requiredMeasurement(artifact, 'cold-materialization-process-cpu-n1');
    const oneFileMaterializationProcessCpu = requiredMeasurement(
      artifact,
      'one-file-reindex-materialization-process-cpu-n1',
    );
    const wholeGraphAnalysis = requiredMeasurement(artifact, 'whole-graph-structural-analysis');
    const wholeGraphAnalysisProcessCpu = requiredMeasurement(artifact, 'whole-graph-structural-analysis-process-cpu');

    if (!SHA256.test(input.artifactSha256)) failures.push(`${prefix} artifact digest is not lowercase SHA-256`);
    if (artifact.environment.commit !== expectedCommit) {
      failures.push(`${prefix} commit ${artifact.environment.commit}; expected ${expectedCommit}`);
    }
    if (artifact.environment.dirty) failures.push(`${prefix} checkout is dirty`);
    if (artifact.environment.fixtureHash !== expectedFixtureHash) {
      failures.push(`${prefix} fixture ${artifact.environment.fixtureHash}; expected ${expectedFixtureHash}`);
    }
    if (artifact.suite !== 'code-graph-v1') failures.push(`${prefix} suite ${artifact.suite}; expected code-graph-v1`);
    if (artifact.environment.architecture !== 'x64') {
      failures.push(`${prefix} architecture ${artifact.environment.architecture}; expected x64`);
    }
    if (runnerClass !== 'github-hosted-windows-x64') {
      failures.push(`${prefix} runner class ${runnerClass}; expected github-hosted-windows-x64`);
    }
    if (!SANITIZED_RUNNER_IDENTITY.test(runnerIdentity)) {
      failures.push(`${prefix} runner identity is missing or not privacy-safe`);
    }
    if (runtimePlatform !== 'win32') failures.push(`${prefix} runtime platform ${runtimePlatform}; expected win32`);
    if (artifact.warmups !== policy.warmupsPerReplica) {
      failures.push(`${prefix} warmups ${artifact.warmups}; expected ${policy.warmupsPerReplica}`);
    }
    if (hotQuery.samples !== policy.samplesPerReplica || processCpu.samples !== policy.samplesPerReplica) {
      failures.push(
        `${prefix} hot-query samples ${hotQuery.samples}/${processCpu.samples}; expected ${policy.samplesPerReplica}/${policy.samplesPerReplica}`,
      );
    }
    const invariantFailures = nativeReplicaInvariantFailures(artifact);
    failures.push(...EffectArray.map(invariantFailures, failure => `${prefix} ${failure}`));

    const safetyFailure = performanceBudgetFailure(artifact, safetyBudget);
    const materializationCpuFailures = nestedMaterializationCpuFailures(
      coldMaterializationProcessCpu,
      oneFileMaterializationProcessCpu,
      policy,
    );
    const analysisCpuFailures = wholeGraphAnalysisCpuFailures(wholeGraphAnalysis, wholeGraphAnalysisProcessCpu, policy);
    const ordinaryFailure = performanceBudgetFailure(artifact, budgetInput);
    if (safetyFailure !== undefined) failures.push(`${prefix} safety budget: ${safetyFailure}`);
    failures.push(...EffectArray.map(materializationCpuFailures, failure => `${prefix} safety budget: ${failure}`));
    failures.push(...EffectArray.map(analysisCpuFailures, failure => `${prefix} safety budget: ${failure}`));

    return {
      artifactSha256: input.artifactSha256,
      coldMaterializationProcessCpu: measurementSummary(coldMaterializationProcessCpu),
      createdAt: artifact.createdAt,
      hotQuery: {
        maximum: hotQuery.maximum,
        p50: hotQuery.p50,
        p95: hotQuery.p95,
        samples: hotQuery.samples,
      },
      ordinaryPassed: invariantFailures.length === 0 && ordinaryFailure === undefined,
      processCpu: {
        maximum: processCpu.maximum,
        p50: processCpu.p50,
        p95: processCpu.p95,
        samples: processCpu.samples,
      },
      oneFileMaterializationProcessCpu: measurementSummary(oneFileMaterializationProcessCpu),
      replica: input.replica,
      runnerIdentity,
      safetyPassed:
        invariantFailures.length === 0 &&
        safetyFailure === undefined &&
        materializationCpuFailures.length === 0 &&
        analysisCpuFailures.length === 0,
      wholeGraphAnalysis: measurementSummary(wholeGraphAnalysis),
      wholeGraphAnalysisProcessCpu: measurementSummary(wholeGraphAnalysisProcessCpu),
    };
  });

  for (const [label, values] of [
    ['artifact digests', EffectArray.map(observations, observation => observation.artifactSha256)],
    ['runner identities', EffectArray.map(observations, observation => observation.runnerIdentity)],
  ] as const) {
    if (new Set(values).size !== policy.replicas) failures.push(`${label} must be distinct across all replicas`);
  }
  for (const [label, values] of [
    ['commit', EffectArray.map(sorted, input => input.artifact.environment.commit)],
    ['fixture', EffectArray.map(sorted, input => input.artifact.environment.fixtureHash)],
    ['runtime', EffectArray.map(sorted, input => input.artifact.environment.node)],
    ['package manager', EffectArray.map(sorted, input => input.artifact.environment.packageManager)],
    ['operating system', EffectArray.map(sorted, input => input.artifact.environment.operatingSystem)],
    ['architecture', EffectArray.map(sorted, input => input.artifact.environment.architecture)],
  ] as const) {
    if (new Set(values).size !== 1) failures.push(`${label} must match across all replicas`);
  }
  const ordinaryPasses = EffectArray.filter(
    observations,
    (observation, __effectArrayIndex) => __effectArrayIndex in observations && observation.ordinaryPassed,
  ).length;
  if (ordinaryPasses < policy.ordinaryPassesMinimum) {
    failures.push(
      `ordinary performance budget passed ${ordinaryPasses}/${policy.replicas}; required ${policy.ordinaryPassesMinimum}`,
    );
  }

  const stableFailures = [...new Set(failures)].sort();
  const first = sorted[0]?.artifact;
  return {
    createdAt:
      EffectArray.map(observations, observation => observation.createdAt)
        .sort()
        .at(-1) ?? new Date(0).toISOString(),
    environment: {
      architecture: first?.environment.architecture ?? 'missing',
      commit: first?.environment.commit ?? 'missing',
      fixtureHash: first?.environment.fixtureHash ?? 'missing',
      node: first?.environment.node ?? 'missing',
      operatingSystem: first?.environment.operatingSystem ?? 'missing',
      runnerClass: first === undefined ? 'missing' : stringMetadata(first, 'runnerClass'),
      runtimePlatform: first === undefined ? 'missing' : stringMetadata(first, 'runtimePlatform'),
    },
    gate: {failures: stableFailures, passed: stableFailures.length === 0},
    policy: {
      ...policy,
      adjudication: 'all-safety-and-two-of-three-ordinary',
      experimentalUnit: 'independent-hosted-runner',
    },
    replicas: observations,
    suite: 'code-graph-windows-hosted-replicas-v1',
    version: 1,
  };
}

function nativeReplicaInvariantFailures(artifact: BenchmarkArtifactV1): readonly string[] {
  const failures: string[] = [];
  if (artifact.metadata.vectorEnabled !== false) failures.push('must be lexical-only');
  if ('scaleSymbols' in artifact.metadata) failures.push('must use the reviewed native development fixture');
  for (const name of [
    'cold-index',
    'cold-materialization',
    'one-file-reindex-index',
    'one-file-reindex-materialization',
  ] as const) {
    const measurement = EffectOption.getOrUndefined(
      EffectArray.findFirst(artifact.measurements, candidate => candidate.name === name),
    );
    if (measurement === undefined) continue;
    if (measurement.unit !== 'milliseconds') failures.push(`${name} measurement must use milliseconds`);
    if (measurement.samples !== 1) failures.push(`${name} samples ${measurement.samples}; expected 1`);
  }
  for (const [materializationName, enclosingName] of [
    ['cold-materialization', 'cold-index'],
    ['one-file-reindex-materialization', 'one-file-reindex-index'],
  ] as const) {
    const materialization = requiredMeasurement(artifact, materializationName);
    const enclosing = requiredMeasurement(artifact, enclosingName);
    if (materialization.maximum > enclosing.maximum) {
      failures.push(
        `${materializationName} maximum ${materialization.maximum} exceeds enclosing ${enclosingName} maximum ${enclosing.maximum}`,
      );
    }
  }
  for (const [name, expected] of [
    ['one-file-reindex-materialization-staged-files', 1],
    ['primary-query-structural-parity', 1],
    ['structural-graph-digest-parity', 1],
  ] as const) {
    const measurement = EffectOption.getOrUndefined(
      EffectArray.findFirst(artifact.measurements, candidate => candidate.name === name),
    );
    if (
      measurement === undefined ||
      measurement.unit !== 'count' ||
      measurement.samples !== 1 ||
      EffectArray.some(
        [measurement.minimum, measurement.p50, measurement.p95, measurement.p99, measurement.maximum],
        value => value !== expected,
      )
    ) {
      failures.push(`${name} must retain the exact value ${expected}`);
    }
  }
  const coldFiles = numberMetadata(artifact, 'coldFiles');
  const reusedFiles = numberMetadata(artifact, 'incrementalReusedFiles');
  const stagedFiles = numberMetadata(artifact, 'oneFileReindexStagedFiles');
  const totalFiles = numberMetadata(artifact, 'oneFileReindexTotalFiles');
  if (stagedFiles !== 1 || reusedFiles + stagedFiles !== coldFiles || totalFiles !== coldFiles) {
    failures.push('one-file incremental work accounting is inconsistent');
  }
  for (const [left, right, label] of [
    ['structuralGraphDigestIncremental', 'structuralGraphDigestSameOverlayReference', 'structural graph'],
    ['primaryQueryStructuralDigestIncremental', 'primaryQueryStructuralDigestSameOverlayReference', 'primary query'],
  ] as const) {
    const leftDigest = stringMetadata(artifact, left);
    const rightDigest = stringMetadata(artifact, right);
    if (!SHA256.test(leftDigest) || leftDigest !== rightDigest) failures.push(`${label} parity digest is invalid`);
  }
  return failures;
}

function nestedMaterializationCpuFailures(
  cold: BenchmarkArtifactV1['measurements'][number],
  oneFile: BenchmarkArtifactV1['measurements'][number],
  policy: WindowsReplicaPolicyV1,
): readonly string[] {
  const failures: string[] = [];
  for (const [name, measurement, maximum] of [
    ['cold-materialization-process-cpu-n1', cold, policy.coldMaterializationProcessCpuMillisecondsMaximum],
    [
      'one-file-reindex-materialization-process-cpu-n1',
      oneFile,
      policy.oneFileMaterializationProcessCpuMillisecondsMaximum,
    ],
  ] as const) {
    if (measurement.unit !== 'milliseconds') failures.push(`${name} measurement must use milliseconds`);
    if (measurement.samples !== 1) failures.push(`${name} samples ${measurement.samples}; expected 1`);
    if (measurement.maximum > maximum) {
      failures.push(`${name} maximum ${measurement.maximum} exceeds ${maximum}`);
    }
  }
  return failures;
}

function wholeGraphAnalysisCpuFailures(
  wall: BenchmarkArtifactV1['measurements'][number],
  processCpu: BenchmarkArtifactV1['measurements'][number],
  policy: WindowsReplicaPolicyV1,
): readonly string[] {
  const failures: string[] = [];
  if (wall.unit !== 'milliseconds') {
    failures.push('whole-graph-structural-analysis measurement must use milliseconds');
  }
  if (wall.samples !== 3) {
    failures.push(`whole-graph-structural-analysis samples ${wall.samples}; expected 3`);
  }
  if (processCpu.unit !== 'milliseconds') {
    failures.push('whole-graph-structural-analysis-process-cpu measurement must use milliseconds');
  }
  if (processCpu.samples !== wall.samples) {
    failures.push('whole-graph-structural-analysis-process-cpu sample count must match the wall measurement');
  }
  if (processCpu.p95 > policy.wholeGraphAnalysisProcessCpuP95MillisecondsMaximum) {
    failures.push(
      `whole-graph-structural-analysis-process-cpu p95 ${processCpu.p95} exceeds ${policy.wholeGraphAnalysisProcessCpuP95MillisecondsMaximum}`,
    );
  }
  return failures;
}

function measurementSummary(measurement: BenchmarkArtifactV1['measurements'][number]) {
  return {
    maximum: measurement.maximum,
    p50: measurement.p50,
    p95: measurement.p95,
    samples: measurement.samples,
  };
}

function performanceBudgetFailure(artifact: BenchmarkArtifactV1, budget: unknown): string | undefined {
  try {
    enforceCodeGraphBenchmarkBudget(artifact, budget, undefined);
    return undefined;
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return cause.message;
  }
}

function parseWindowsReplicaPolicy(value: unknown): WindowsReplicaPolicyV1 {
  const budget = requiredRecord(value, 'code graph budget');
  const policies = requiredRecord(budget.developmentPerformanceReplicaSetByRunnerClass, 'development replica policies');
  const policy = requiredRecord(policies['github-hosted-windows-x64'], 'hosted Windows replica policy');
  const expected: WindowsReplicaPolicyV1 = {
    coldMaterializationProcessCpuMillisecondsMaximum: 3000,
    hardWallP95MillisecondsMaximum: 1900,
    nestedMaterializationUsesEnclosingSafetyCeiling: true,
    oneFileMaterializationProcessCpuMillisecondsMaximum: 200,
    ordinaryPassesMinimum: 2,
    ordinaryWallP95MillisecondsMaximum: 1050,
    replicas: 3,
    samplesPerReplica: 100,
    schedulerSensitiveWallClockSafetyMultiplier: 2,
    wholeGraphAnalysisProcessCpuP95MillisecondsMaximum: 400,
    warmupsPerReplica: 5,
  };
  if (
    JSON.stringify(EffectRecord.keys(policy).sort()) !== JSON.stringify(EffectRecord.keys(expected).sort()) ||
    EffectArray.some(EffectRecord.toEntries(expected), ([key, expectedValue]) => policy[key] !== expectedValue)
  ) {
    throw ScriptError.make({message: 'Hosted Windows replica policy does not match the reviewed v1 contract.'});
  }
  const resolved = resolvedWindowsDevelopmentBudget(budget);
  const ordinaryMaximum = requiredNumber(resolved.hotQueryP95MillisecondsMaximum, 'ordinary wall p95 maximum');
  const tolerance = requiredNumber(resolved.hotQueryWallP95ToleranceRatioMaximum, 'ordinary wall p95 tolerance');
  if (ordinaryMaximum * (1 + tolerance) !== expected.ordinaryWallP95MillisecondsMaximum) {
    throw ScriptError.make({
      message: 'Hosted Windows ordinary replica boundary disagrees with the reviewed development budget.',
    });
  }
  return expected;
}

function windowsReplicaSafetyBudget(value: unknown, policy: WindowsReplicaPolicyV1): unknown {
  const budget = requiredRecord(value, 'code graph budget');
  const runnerPolicies = requiredRecord(budget.developmentPerformanceByRunnerClass, 'development runner policies');
  const windows = requiredRecord(runnerPolicies['github-hosted-windows-x64'], 'hosted Windows development policy');
  const resolved = resolvedWindowsDevelopmentBudget(budget);
  const safetyMaximum = (field: string): number =>
    requiredNumber(resolved[field], `resolved Windows ${field}`) * policy.schedulerSensitiveWallClockSafetyMultiplier;
  const coldIndexSafetyMaximum = safetyMaximum('coldIndexP95MillisecondsMaximum');
  const oneFileIndexSafetyMaximum = safetyMaximum('oneFileIncrementalP95MillisecondsMaximum');
  return {
    ...budget,
    developmentPerformanceByRunnerClass: {
      ...runnerPolicies,
      'github-hosted-windows-x64': {
        ...windows,
        coldIndexP95MillisecondsMaximum: coldIndexSafetyMaximum,
        coldMaterializationP95MillisecondsMaximum: coldIndexSafetyMaximum,
        hotQueryP95MillisecondsMaximum: policy.hardWallP95MillisecondsMaximum,
        hotQueryWallP95ToleranceRatioMaximum: 0,
        oneFileIncrementalP95MillisecondsMaximum: oneFileIndexSafetyMaximum,
        oneFileMaterializationP95MillisecondsMaximum: oneFileIndexSafetyMaximum,
        wholeGraphAnalysisP95MillisecondsMaximum: safetyMaximum('wholeGraphAnalysisP95MillisecondsMaximum'),
      },
    },
  };
}

function resolvedWindowsDevelopmentBudget(
  budget: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const base = requiredRecord(budget.developmentPerformance, 'development performance');
  const byPlatform = requiredRecord(budget.developmentPerformanceByPlatform, 'development platform policies');
  const windows = requiredRecord(byPlatform.win32, 'Windows development policy');
  const byRunner = requiredRecord(budget.developmentPerformanceByRunnerClass, 'development runner policies');
  const hosted = requiredRecord(byRunner['github-hosted-windows-x64'], 'hosted Windows development policy');
  return {...base, ...windows, ...hosted};
}

function budgetFixtureHash(value: unknown): string {
  const budget = requiredRecord(value, 'code graph budget');
  return requiredString(requiredRecord(budget.fixture, 'budget fixture').hash, 'budget fixture hash');
}

function requiredMeasurement(artifact: BenchmarkArtifactV1, name: string) {
  const measurement = EffectOption.getOrUndefined(
    EffectArray.findFirst(artifact.measurements, candidate => candidate.name === name),
  );
  if (measurement === undefined) throw ScriptError.make({message: `Replica artifact is missing ${name}.`});
  return measurement;
}

function assertUniqueMeasurementNames(artifact: BenchmarkArtifactV1, prefix: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const measurement of artifact.measurements) {
    if (seen.has(measurement.name)) duplicates.add(measurement.name);
    else seen.add(measurement.name);
  }
  if (duplicates.size > 0) {
    throw ScriptError.make({
      message: `${prefix} measurement names must be unique; duplicates: ${EffectArray.join([...duplicates].sort(), ', ')}`,
    });
  }
}

function stringMetadata(artifact: BenchmarkArtifactV1, key: string): string {
  return requiredString(artifact.metadata[key], `artifact metadata ${key}`);
}

function numberMetadata(artifact: BenchmarkArtifactV1, key: string): number {
  return requiredNumber(artifact.metadata[key], `artifact metadata ${key}`);
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isUnknownRecord(value)) throw ScriptError.make({message: `${label} is invalid.`});
  return value;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw ScriptError.make({message: `${label} is invalid.`});
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw ScriptError.make({message: `${label} is invalid.`});
  return value;
}

interface AdjudicatorOptions {
  readonly budget: string;
  readonly expectedCommit: string;
  readonly failOnBudget: boolean;
  readonly input: string;
  readonly output: string;
}

function parseArguments(args: readonly string[]): AdjudicatorOptions {
  let budget = DEFAULT_BUDGET;
  let expectedCommit = '';
  let failOnBudget = false;
  let input = '';
  let output = '';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--budget') budget = requiredArgument(args[++index], argument);
    else if (argument === '--expected-commit') expectedCommit = requiredArgument(args[++index], argument);
    else if (argument === '--fail-on-budget') failOnBudget = true;
    else if (argument === '--input') input = requiredArgument(args[++index], argument);
    else if (argument === '--output') output = requiredArgument(args[++index], argument);
    else throw ScriptError.make({message: `Unknown Windows replica adjudicator option: ${argument}`});
  }
  if (!input || !output || !expectedCommit) {
    throw ScriptError.make({message: '--input, --output, and --expected-commit are required.'});
  }
  return {budget, expectedCommit, failOnBudget, input, output};
}

function requiredArgument(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const options = parseArguments(yield* scriptArguments());
  const names = EffectArray.filter(
    yield* fs.readDirectory(options.input),
    __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
  ).sort();
  const inputs: CodeGraphWindowsReplicaInput[] = [];
  for (const name of names) {
    const match = WINDOWS_REPLICA_FILE.exec(name);
    if (match === null) return yield* ScriptError.make({message: `Unexpected replica artifact ${name}.`});
    const file = path.join(options.input, name);
    const raw = yield* fs.readFileString(file);
    const value: unknown = yield* Effect.try({
      catch: cause => ScriptError.make({message: `Could not parse replica artifact ${name}.`, cause}),
      try: () => JSON.parse(raw),
    });
    inputs.push({
      artifact: parseBenchmarkArtifactV1(value),
      artifactSha256: yield* sha256Hex(raw),
      replica: Number(match[1]),
    });
  }
  const result = adjudicateCodeGraphWindowsReplicas(
    inputs,
    yield* readJsonFile(options.budget),
    options.expectedCommit,
  );
  yield* atomicWrite(options.output, `${JSON.stringify(result, undefined, 2)}\n`);
  yield* printJson(result);
  if (options.failOnBudget && !result.gate.passed) {
    return yield* ScriptError.make({message: EffectArray.join(result.gate.failures, '\n')});
  }
});

const scriptLayer = Layer.mergeAll(BunServices.layer, ScriptSystemInfoLayer);

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, scriptLayer));
