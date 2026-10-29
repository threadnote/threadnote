import {Array as EffectArray} from 'effect';
import type {ISql} from 'postgres';
import type {AuthorizedRemotePrincipal} from '../authorization.js';
import {remoteMemoryError} from '../errors.js';
import {requireJsonValue} from '../json.js';

export interface StoredRememberPublicationPlanV1 {
  readonly contentHash: string;
  readonly kind: 'remember_publication_plan';
  readonly memoryId: string;
  readonly proposedRevision: string;
  readonly renderedAt: string;
  readonly version: 1;
}

export type RememberPublicationPlanRecordResult =
  | {readonly kind: 'outcome'; readonly outcome: unknown}
  | {readonly kind: 'prepared'; readonly plan: StoredRememberPublicationPlanV1};

export async function recordRememberPublicationPlan(
  transaction: ISql,
  principal: AuthorizedRemotePrincipal,
  operationId: string,
  fingerprint: string,
  plan: StoredRememberPublicationPlanV1,
): Promise<RememberPublicationPlanRecordResult> {
  const updated = await transaction<{outcome: unknown}[]>`
    UPDATE remote_memory.idempotency_records SET outcome = ${transaction.json(requireJsonValue(plan))}
    WHERE tenant_id = ${principal.tenantId} AND principal_id = ${principal.principalId}
      AND operation_id = ${operationId} AND request_hash = ${fingerprint}
      AND outcome->>'kind' = 'rejected'
      AND outcome->'error'->'details'->>'reason' = 'outcome_ambiguous'
    RETURNING outcome
  `;
  if (updated[0]) return {kind: 'prepared', plan};
  const rows = await transaction<{readonly outcome: unknown | null; readonly request_hash: string}[]>`
    SELECT request_hash, outcome
    FROM remote_memory.idempotency_records
    WHERE tenant_id = ${principal.tenantId} AND principal_id = ${principal.principalId}
      AND operation_id = ${operationId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row || row.request_hash !== fingerprint) {
    throw remoteMemoryError('idempotency_mismatch', 'The operation id was already used for a different request.');
  }
  const existingPlan = storedRememberPublicationPlan(row.outcome);
  if (existingPlan) {
    if (!rememberPublicationPlansEqual(existingPlan, plan)) {
      throw remoteMemoryError('service_unavailable', 'The prepared remote memory publication changed.');
    }
    return {kind: 'prepared', plan: existingPlan};
  }
  if (row.outcome === null) {
    throw remoteMemoryError(
      'service_unavailable',
      'The operation outcome is unavailable and will not be re-executed.',
      {
        reason: 'outcome_ambiguous',
      },
    );
  }
  return {kind: 'outcome', outcome: row.outcome};
}

export function storedRememberPublicationPlan(value: unknown): StoredRememberPublicationPlanV1 | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    EffectArray.isArray(value) ||
    !isStoredRememberPublicationPlan(value)
  ) {
    return undefined;
  }
  return value;
}

function isStoredRememberPublicationPlan(value: object): value is StoredRememberPublicationPlanV1 {
  if (!('kind' in value) || !('version' in value)) return false;
  if (
    value.kind !== 'remember_publication_plan' ||
    value.version !== 1 ||
    !('contentHash' in value) ||
    typeof value.contentHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.contentHash) ||
    !('memoryId' in value) ||
    typeof value.memoryId !== 'string' ||
    !/^tn_[0-9a-f]{32}$/u.test(value.memoryId) ||
    !('proposedRevision' in value) ||
    typeof value.proposedRevision !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.proposedRevision) ||
    !('renderedAt' in value) ||
    typeof value.renderedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.renderedAt))
  ) {
    return false;
  }
  return true;
}

export function storedRememberPublicationPlanDate(plan: StoredRememberPublicationPlanV1): Date {
  const renderedAt = new Date(plan.renderedAt);
  if (!Number.isFinite(renderedAt.getTime()) || renderedAt.toISOString() !== plan.renderedAt) {
    throw remoteMemoryError('service_unavailable', 'The prepared remote memory publication timestamp is invalid.');
  }
  return renderedAt;
}

function rememberPublicationPlansEqual(
  left: StoredRememberPublicationPlanV1,
  right: StoredRememberPublicationPlanV1,
): boolean {
  return (
    left.contentHash === right.contentHash &&
    left.memoryId === right.memoryId &&
    left.proposedRevision === right.proposedRevision &&
    left.renderedAt === right.renderedAt
  );
}
