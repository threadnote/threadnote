import {Array as EffectArray} from 'effect';

export const CODE_GRAPH_BUILD_STATUS_SCHEMA_VERSION = 1 as const;

export const CODE_GRAPH_BUILD_HASH_ID = /^[0-9a-f]{64}$/;
export const CODE_GRAPH_BUILD_ID = /^[0-9a-f-]{16,64}$/;
export const CODE_GRAPH_BUILD_COMMIT_ID = /^[0-9a-f]{7,64}$/;
/** Failed receipts stay visible until this age, then Manager and history prune retire them. */
export const CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS = 60 * 60 * 1_000;

/** Keep a failed Manager card only while its observed heartbeat age is finite and within retention. */
export function codeGraphFailedBuildStatusCurrent(heartbeatAgeMilliseconds: number): boolean {
  return (
    Number.isFinite(heartbeatAgeMilliseconds) &&
    heartbeatAgeMilliseconds <= CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS
  );
}

/** History prune may delete a failed receipt only after a finite observed age exceeds retention. */
export function codeGraphFailedBuildStatusExpired(heartbeatAgeMilliseconds: number): boolean {
  return (
    Number.isFinite(heartbeatAgeMilliseconds) &&
    heartbeatAgeMilliseconds > CODE_GRAPH_FAILED_BUILD_STATUS_RETENTION_MILLISECONDS
  );
}

/** @internal Pure retention boundary for expired failed receipts. Age is history policy, not live-owner authority. */
export function codeGraphFailedBuildStatusRemovable(
  status: {
    readonly buildId: string;
    readonly observation: {readonly heartbeatAgeMilliseconds: number};
    readonly state: string;
  },
  protectedBuildId?: string,
): boolean {
  return (
    status.state === 'failed' &&
    status.buildId !== protectedBuildId &&
    codeGraphFailedBuildStatusExpired(status.observation.heartbeatAgeMilliseconds)
  );
}

export function isBuildStatusRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

export function isBuildStatusHash(value: unknown): value is string {
  return typeof value === 'string' && CODE_GRAPH_BUILD_HASH_ID.test(value);
}

export function isBuildStatusText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\p{Cc}]/u.test(value);
}

export function isBuildStatusTimestamp(value: unknown): value is string {
  return isBuildStatusText(value, 64) && Number.isFinite(Date.parse(value));
}
