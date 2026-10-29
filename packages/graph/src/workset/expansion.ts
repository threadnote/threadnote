import type {CodeGraphWorksetRouterRepositoryCandidateV1} from './router.js';
import {Array as EffectArray} from 'effect';

export const CODE_GRAPH_WORKSET_EXPANSION_VERSION = 1 as const;
export const CODE_GRAPH_WORKSET_EXPANSION_SCHEDULE = [4, 4, 16] as const;

export interface CodeGraphWorksetExpansionControllerInputV1 {
  readonly activeGraphBuilds?: number;
  readonly alreadySelectedRepositoryKeys?: ReadonlySet<string>;
  readonly cancelled?: boolean;
  readonly memoryPressure?: 'elevated' | 'high' | 'normal';
  readonly openDatabaseBudget?: number;
  readonly phase: number;
  readonly recentQueryMilliseconds?: readonly number[];
  readonly remainingMilliseconds: number;
  readonly repositories: readonly CodeGraphWorksetRouterRepositoryCandidateV1[];
}

export interface CodeGraphWorksetExpansionControllerResultV1 {
  readonly concurrency: number;
  readonly estimatedBatchMilliseconds: number;
  readonly repositories: readonly CodeGraphWorksetRouterRepositoryCandidateV1[];
  readonly requestedBatchSize: number;
  readonly stopReason: 'cancelled' | 'continue' | 'deadline' | 'exhaustion';
  readonly version: typeof CODE_GRAPH_WORKSET_EXPANSION_VERSION;
}

/**
 * Select the next deterministic repository prefix under deadline and local
 * resource pressure. This controller affects throughput only; it never
 * reorders the router's globally ranked repository sequence.
 */
export function selectCodeGraphWorksetAdaptiveExpansionBatch(
  input: CodeGraphWorksetExpansionControllerInputV1,
): CodeGraphWorksetExpansionControllerResultV1 {
  const phase = boundedInteger(input.phase, 'expansion phase', 0, 1_000);
  const remainingMilliseconds = boundedInteger(input.remainingMilliseconds, 'remaining deadline', 0, 60 * 60_000);
  const openDatabaseBudget = boundedInteger(input.openDatabaseBudget ?? 4, 'open database budget', 1, 64);
  const activeGraphBuilds = boundedInteger(input.activeGraphBuilds ?? 0, 'active graph build count', 0, 10_000);
  const memoryPressure = input.memoryPressure ?? 'normal';
  const selected = input.alreadySelectedRepositoryKeys ?? new Set<string>();
  const remaining = EffectArray.filter(input.repositories, repository => !selected.has(repository.repositoryKey));
  const concurrency = adaptiveConcurrency(openDatabaseBudget, activeGraphBuilds, memoryPressure);
  const requestedBatchSize = scheduledBatchSize(phase, memoryPressure);
  const perWaveMilliseconds = conservativeRecentLatency(input.recentQueryMilliseconds);

  if (input.cancelled === true) return empty('cancelled', concurrency, requestedBatchSize);
  if (remaining.length === 0) return empty('exhaustion', concurrency, requestedBatchSize);
  const usableMilliseconds = Math.max(0, remainingMilliseconds - 50);
  const waves = Math.floor(usableMilliseconds / perWaveMilliseconds);
  const deadlineCapacity = waves * concurrency;
  const batchSize = Math.min(requestedBatchSize, remaining.length, deadlineCapacity);
  if (batchSize < 1) return empty('deadline', concurrency, requestedBatchSize);
  const repositories = remaining.slice(0, batchSize);
  return {
    concurrency,
    estimatedBatchMilliseconds: Math.ceil(repositories.length / concurrency) * perWaveMilliseconds,
    repositories,
    requestedBatchSize,
    stopReason: 'continue',
    version: CODE_GRAPH_WORKSET_EXPANSION_VERSION,
  };
}

function adaptiveConcurrency(
  openDatabaseBudget: number,
  activeGraphBuilds: number,
  memoryPressure: 'elevated' | 'high' | 'normal',
): number {
  const pressureCap = memoryPressure === 'high' ? 1 : memoryPressure === 'elevated' ? 2 : 4;
  const buildCap = activeGraphBuilds >= 4 ? 1 : activeGraphBuilds > 0 ? 2 : 4;
  return Math.max(1, Math.min(openDatabaseBudget, pressureCap, buildCap));
}

function scheduledBatchSize(phase: number, memoryPressure: 'elevated' | 'high' | 'normal'): number {
  const scheduled =
    CODE_GRAPH_WORKSET_EXPANSION_SCHEDULE[Math.min(phase, CODE_GRAPH_WORKSET_EXPANSION_SCHEDULE.length - 1)];
  return memoryPressure === 'high'
    ? Math.min(2, scheduled)
    : memoryPressure === 'elevated'
      ? Math.min(4, scheduled)
      : scheduled;
}

function conservativeRecentLatency(samples: readonly number[] | undefined): number {
  if (samples === undefined || samples.length === 0) return 250;
  const valid = EffectArray.filter(
    samples,
    (sample, __effectArrayIndex) =>
      __effectArrayIndex in samples && Number.isFinite(sample) && sample >= 1 && sample <= 60_000,
  ).sort((a, b) => a - b);
  if (valid.length === 0) return 250;
  return Math.ceil(valid[Math.min(valid.length - 1, Math.ceil(valid.length * 0.95) - 1)]);
}

function empty(
  stopReason: Exclude<CodeGraphWorksetExpansionControllerResultV1['stopReason'], 'continue'>,
  concurrency: number,
  requestedBatchSize: number,
): CodeGraphWorksetExpansionControllerResultV1 {
  return {
    concurrency,
    estimatedBatchMilliseconds: 0,
    repositories: [],
    requestedBatchSize,
    stopReason,
    version: CODE_GRAPH_WORKSET_EXPANSION_VERSION,
  };
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Workset ${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
