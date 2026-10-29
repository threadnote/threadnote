import {Array as EffectArray} from 'effect';
import type {CodeGraphBuildStatus} from '../build_status.js';
import type {CodeGraphBuildResource} from '../build/resources.js';
import type {CodeGraphBuilderAdmissionQueue} from '../builder/admission_scheduler.js';
import {isBuildStatusRecord, isBuildStatusTimestamp} from './validation.js';
import type {CodeGraphProgress} from '../types.js';
import * as EffectRecord from 'effect/Record';

export const CODE_GRAPH_BUILD_PHASES = [
  'activating',
  'embedding',
  'materializing',
  'reclaiming',
  'registering',
  'resolving',
  'scanning',
  'sharing',
  'waiting',
] as const satisfies readonly CodeGraphProgress['phase'][];
export const CODE_GRAPH_BUILD_WAIT_REASONS = [
  'database-writer',
  'disk-capacity',
  'home-builder-cap',
  'prepared-spool-budget',
  'repository-lock',
  'request-lock',
  'snapshot-build',
] as const;
type WaitReason = NonNullable<Extract<CodeGraphProgress, {phase: 'waiting'}>['reason']>;

export interface CodeGraphBuildScheduling {
  readonly admittedAt?: string;
  readonly blocker?: WaitReason;
  readonly resource?: CodeGraphBuildResource;
  readonly queue?: CodeGraphBuilderAdmissionQueue;
  readonly phaseMilliseconds?: Partial<Readonly<Record<CodeGraphProgress['phase'], number>>>;
  readonly waitMilliseconds?: Partial<Readonly<Record<WaitReason, number>>>;
}

export function accountCodeGraphBuildScheduling<
  T extends {readonly accountedAtMilliseconds: number; readonly status: CodeGraphBuildStatus},
>(current: T, now: number): T {
  return {
    ...current,
    accountedAtMilliseconds: now,
    status: {
      ...current.status,
      scheduling: accumulateCodeGraphBuildScheduling(current.status, now - current.accountedAtMilliseconds),
    },
  };
}

export function observeCodeGraphBuildAdmission(
  status: CodeGraphBuildStatus,
  queue: CodeGraphBuilderAdmissionQueue | undefined,
  now: number,
): CodeGraphBuildStatus {
  return {
    ...status,
    scheduling: queue
      ? {...status.scheduling, queue}
      : {
          ...status.scheduling,
          admittedAt: status.scheduling?.admittedAt ?? new Date(now).toISOString(),
          blocker: undefined,
        },
  };
}

export function observeCodeGraphBuildResource(
  status: CodeGraphBuildStatus,
  resource: CodeGraphBuildResource | undefined,
): CodeGraphBuildStatus {
  return {...status, scheduling: {...status.scheduling, resource}};
}

/** Account observed intervals only. Absent legacy telemetry stays unknown. */
export function accumulateCodeGraphBuildScheduling(
  status: Pick<CodeGraphBuildStatus, 'phase' | 'scheduling' | 'state'>,
  elapsed: number,
): CodeGraphBuildScheduling | undefined {
  const scheduling = status.scheduling;
  if (!scheduling || status.state === 'completed' || status.state === 'failed') return scheduling;
  const delta = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, elapsed));
  const add = (previous: number | undefined) => Math.min(Number.MAX_SAFE_INTEGER, (previous ?? 0) + delta);
  return {
    ...scheduling,
    phaseMilliseconds: {
      ...scheduling.phaseMilliseconds,
      [status.phase]: add(scheduling.phaseMilliseconds?.[status.phase]),
    },
    ...(scheduling.blocker
      ? {
          waitMilliseconds: {
            ...scheduling.waitMilliseconds,
            [scheduling.blocker]: add(scheduling.waitMilliseconds?.[scheduling.blocker]),
          },
        }
      : {}),
  };
}

/** Closed key sets bound storage and prevent paths or arbitrary labels entering projections. */
export function parseCodeGraphBuildScheduling(value: unknown): CodeGraphBuildScheduling | undefined {
  if (!isBuildStatusRecord(value)) return undefined;
  if (value.admittedAt !== undefined && !isBuildStatusTimestamp(value.admittedAt)) return undefined;
  if (value.blocker !== undefined && !isWaitReason(value.blocker)) return undefined;
  if (value.resource !== undefined && !isBuildResource(value.resource)) {
    return undefined;
  }
  const queue = value.queue;
  if (
    queue !== undefined &&
    (!isBuildStatusRecord(queue) ||
      (queue.admissionClass !== 'background' && queue.admissionClass !== 'current-required') ||
      !isBuildStatusTimestamp(queue.enqueuedAt) ||
      !isCount(queue.position, 256) ||
      !isCount(queue.size, 256) ||
      queue.position < 1 ||
      queue.position > queue.size)
  )
    return undefined;
  const phaseMilliseconds = parseDurations(value.phaseMilliseconds, CODE_GRAPH_BUILD_PHASES);
  const waitMilliseconds = parseDurations(value.waitMilliseconds, CODE_GRAPH_BUILD_WAIT_REASONS);
  if (value.phaseMilliseconds !== undefined && phaseMilliseconds === undefined) return undefined;
  if (value.waitMilliseconds !== undefined && waitMilliseconds === undefined) return undefined;
  return {
    ...(typeof value.admittedAt === 'string' ? {admittedAt: value.admittedAt} : {}),
    ...(isWaitReason(value.blocker) ? {blocker: value.blocker} : {}),
    ...(isBuildResource(value.resource) ? {resource: value.resource} : {}),
    ...(isBuildStatusRecord(queue) &&
    (queue.admissionClass === 'background' || queue.admissionClass === 'current-required')
      ? {
          queue: {
            admissionClass: queue.admissionClass,
            enqueuedAt: String(queue.enqueuedAt),
            position: Number(queue.position),
            size: Number(queue.size),
          },
        }
      : {}),
    ...(phaseMilliseconds ? {phaseMilliseconds} : {}),
    ...(waitMilliseconds ? {waitMilliseconds} : {}),
  };
}

function isWaitReason(value: unknown): value is WaitReason {
  return typeof value === 'string' && EffectArray.some(CODE_GRAPH_BUILD_WAIT_REASONS, reason => reason === value);
}

function isBuildResource(value: unknown): value is CodeGraphBuildResource {
  return (
    value === 'checkout-writer' ||
    value === 'home-builder-slot' ||
    value === 'home-preparation-slot' ||
    value === 'prepared-spool-budget'
  );
}

function isCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function parseDurations<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, number>> | undefined {
  if (!isBuildStatusRecord(value)) return undefined;
  const output: Partial<Record<K, number>> = {};
  for (const key of EffectRecord.keys(value)) {
    if (!EffectArray.some(keys, known => known === key) || !isCount(value[key])) return undefined;
  }
  for (const key of keys) if (typeof value[key] === 'number') output[key] = value[key];
  return output;
}
