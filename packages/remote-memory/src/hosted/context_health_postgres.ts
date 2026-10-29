import {Array as EffectArray} from 'effect';
import type {Sql, ISql} from 'postgres';

import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {randomUuidV4} from '@threadnote/platform/uuid';
import {requireJsonValue} from '../json.js';
import {
  buildHostedContextHealthReceiptV1,
  buildHostedContextHealthScheduleV1,
  hostedContextHealthBackoffMilliseconds,
  hostedContextHealthTargetLabelsV1,
  selectHostedContextHealthJobsV1,
  verifyHostedContextHealthEvaluationV1,
  type HostedContextHealthPolicyV1,
  type HostedContextHealthReceiptV1,
  type HostedContextHealthRunInputV1,
  type HostedContextHealthScheduleReceiptV1,
  type HostedContextHealthScheduleV1,
} from './context_health.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const DATABASE_TIMEOUT_MILLISECONDS = 5_000;
const CLAIM_LEASE_MILLISECONDS = 5 * 60_000;
const MAXIMUM_CLAIM_CONCURRENCY = 64;
const MAXIMUM_OBSERVATION_SKEW_MILLISECONDS = 5 * 60_000;

export interface HostedContextHealthClaimV1 {
  readonly backlogDepth: number;
  readonly claimGeneration: number;
  readonly claimedAt: string;
  readonly claimToken: string;
  readonly dueAt: string;
  readonly memorySnapshotRevision: string;
  readonly priorConsecutiveStaleRuns: number;
  readonly repositoryCommit: string;
  readonly schedule: HostedContextHealthScheduleV1;
  readonly version: 1;
}

export interface HostedContextHealthClaimBatchV1 {
  readonly backlogDepth: number;
  readonly claims: readonly HostedContextHealthClaimV1[];
  readonly generation: number;
  readonly nextTenantOrdinal: number;
  readonly unavailableCount: number;
  readonly version: 1;
}

export interface HostedContextHealthCycleCompletionV1 {
  readonly applied: boolean;
  readonly backlogDepth: number;
  readonly generation: number;
  readonly schedulerLagMinutes: number;
  readonly status: 'failed' | 'healthy' | 'superseded';
  readonly version: 1;
}

interface DueDirectoryRow {
  readonly next_due_at: Date;
  readonly project_name: string;
  readonly schedule_id: string;
  readonly share_id: string;
  readonly tenant_id: string;
}

interface AuthoritativeEvidence {
  readonly memorySnapshotRevision: string;
  readonly priorConsecutiveStaleRuns: number;
  readonly repositoryCommit: string;
  readonly schedule: HostedContextHealthScheduleV1;
}

export async function registerHostedContextHealthSchedule(
  sql: Sql,
  schedule: HostedContextHealthScheduleV1,
  nextDueAt: string,
): Promise<HostedContextHealthScheduleReceiptV1> {
  const canonicalDueAt = timestamp(nextDueAt, 'next due timestamp');
  return sql.begin(async transaction => {
    await setTenant(transaction, schedule.tenantId);
    const targets = await transaction<{project_active: boolean; share_active: boolean; tenant_active: boolean}[]>`
      SELECT
        EXISTS(SELECT 1 FROM remote_memory.tenants WHERE id = ${schedule.tenantId} AND status = 'active') AS tenant_active,
        EXISTS(
          SELECT 1 FROM remote_memory.shares
          WHERE tenant_id = ${schedule.tenantId} AND id = ${schedule.shareId} AND status = 'active'
        ) AS share_active,
        EXISTS(
          SELECT 1 FROM remote_memory.projects
          WHERE tenant_id = ${schedule.tenantId} AND share_id = ${schedule.shareId}
            AND name = ${schedule.project} AND status = 'active'
        ) AS project_active
    `;
    if (!targets[0]?.tenant_active || !targets[0].share_active || !targets[0].project_active) {
      throw new Error('Hosted context health target is not an active tenant/share/project.');
    }
    await transaction`
      INSERT INTO remote_memory.context_health_policies(
        tenant_id, share_id, version, digest, policy_document
      ) VALUES (
        ${schedule.tenantId}, ${schedule.shareId}, ${schedule.policy.policyVersion}, ${schedule.policy.digest},
        ${transaction.json(requireJsonValue(schedule.policy))}
      )
      ON CONFLICT (tenant_id, share_id, version) DO NOTHING
    `;
    const policies = await transaction<{digest: string}[]>`
      SELECT digest FROM remote_memory.context_health_policies
      WHERE tenant_id = ${schedule.tenantId} AND share_id = ${schedule.shareId}
        AND version = ${schedule.policy.policyVersion}
    `;
    if (policies[0]?.digest !== schedule.policy.digest) {
      throw new Error('Hosted context health policy version already has another immutable digest.');
    }
    const current = await transaction<{schedule_id: string; status: string}[]>`
      SELECT schedule_id, status FROM remote_memory.context_health_schedules
      WHERE tenant_id = ${schedule.tenantId} AND share_id = ${schedule.shareId}
        AND project_name = ${schedule.project}
      FOR UPDATE
    `;
    if (current[0] && current[0].schedule_id !== schedule.scheduleId && current[0].status !== 'paused') {
      throw new Error('Hosted context health schedule changed; pause it before replacing its policy or cadence.');
    }
    const applied = await transaction<{next_due_at: Date; schedule_id: string; status: 'active' | 'paused'}[]>`
      INSERT INTO remote_memory.context_health_schedules(
        tenant_id, share_id, project_name, schedule_id, cadence_minutes,
        policy_version, policy_digest, status, next_due_at
      ) VALUES (
        ${schedule.tenantId}, ${schedule.shareId}, ${schedule.project}, ${schedule.scheduleId},
        ${schedule.cadenceMinutes}, ${schedule.policy.policyVersion}, ${schedule.policy.digest}, 'active',
        ${canonicalDueAt}
      )
      ON CONFLICT (tenant_id, share_id, project_name) DO UPDATE SET
        schedule_id = EXCLUDED.schedule_id,
        cadence_minutes = EXCLUDED.cadence_minutes,
        policy_version = EXCLUDED.policy_version,
        policy_digest = EXCLUDED.policy_digest,
        status = CASE
          WHEN remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
            THEN remote_memory.context_health_schedules.status
          ELSE 'active'
        END,
        next_due_at = CASE
          WHEN remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
            THEN remote_memory.context_health_schedules.next_due_at
          ELSE EXCLUDED.next_due_at
        END,
        consecutive_failures = CASE
          WHEN remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
            THEN remote_memory.context_health_schedules.consecutive_failures
          ELSE 0
        END,
        consecutive_stale_runs = CASE
          WHEN remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
            THEN remote_memory.context_health_schedules.consecutive_stale_runs
          ELSE 0
        END,
        last_attempt_at = CASE
          WHEN remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
            THEN remote_memory.context_health_schedules.last_attempt_at
          ELSE NULL
        END,
        last_success_at = CASE
          WHEN remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
            THEN remote_memory.context_health_schedules.last_success_at
          ELSE NULL
        END,
        last_success_receipt_id = CASE
          WHEN remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
            THEN remote_memory.context_health_schedules.last_success_receipt_id
          ELSE NULL
        END,
        last_failure_at = CASE
          WHEN remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
            THEN remote_memory.context_health_schedules.last_failure_at
          ELSE NULL
        END,
        last_failure_receipt_id = CASE
          WHEN remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
            THEN remote_memory.context_health_schedules.last_failure_receipt_id
          ELSE NULL
        END,
        updated_at = now()
      WHERE remote_memory.context_health_schedules.schedule_id = EXCLUDED.schedule_id
        OR remote_memory.context_health_schedules.status = 'paused'
      RETURNING schedule_id, next_due_at, status
    `;
    const row = applied[0];
    if (!row || row.schedule_id !== schedule.scheduleId) {
      throw new Error('Hosted context health schedule changed while it was being registered.');
    }
    await transaction`
      INSERT INTO remote_memory.context_health_due_directory(
        schedule_id, tenant_id, share_id, project_name, status, next_due_at
      ) VALUES (
        ${schedule.scheduleId}, ${schedule.tenantId}, ${schedule.shareId}, ${schedule.project},
        ${row.status}, ${row.next_due_at.toISOString()}
      )
      ON CONFLICT (schedule_id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id, share_id = EXCLUDED.share_id,
        project_name = EXCLUDED.project_name, status = EXCLUDED.status,
        next_due_at = EXCLUDED.next_due_at, claim_token = NULL,
        claim_expires_at = NULL, updated_at = now()
    `;
    return scheduleReceipt(schedule, row.next_due_at.toISOString(), row.status);
  });
}

/** Claims a bounded fair batch from the database-owned due queue. */
export async function claimHostedContextHealthJobs(
  sql: Sql,
  concurrency: number,
): Promise<HostedContextHealthClaimBatchV1> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAXIMUM_CLAIM_CONCURRENCY) {
    throw new Error('Hosted context health scheduler concurrency is invalid.');
  }
  return sql.begin(async transaction => {
    await setOperationalTimeouts(transaction);
    const [worker] = await transaction<{generation: number; tenant_cursor_ordinal: number}[]>`
      SELECT generation::integer, tenant_cursor_ordinal::integer
      FROM remote_memory.context_health_worker_state
      WHERE worker_name = 'context-health'
      FOR UPDATE
    `;
    if (!worker) throw new Error('Hosted context health worker state is unavailable.');
    const [clock] = await transaction<{now: Date}[]>`SELECT clock_timestamp() AS now`;
    if (!clock) throw new Error('Hosted context health database clock is unavailable.');
    const candidates = await transaction<DueDirectoryRow[]>`
      SELECT schedule_id, tenant_id, share_id, project_name, next_due_at
      FROM remote_memory.context_health_due_directory
      WHERE status = 'active' AND next_due_at <= ${clock.now.toISOString()}::timestamptz
        AND (claim_token IS NULL OR claim_expires_at <= ${clock.now.toISOString()}::timestamptz)
      ORDER BY next_due_at, tenant_id, schedule_id
      LIMIT ${Math.min(1024, concurrency * 16)}
      FOR UPDATE SKIP LOCKED
    `;
    const generation = worker.generation + 1;
    const backlog = await authoritativeBacklog(transaction, clock.now);
    const claims: HostedContextHealthClaimV1[] = [];
    const remaining = new Map(EffectArray.map(candidates, candidate => [candidate.schedule_id, candidate]));
    let unavailableCount = 0;
    let nextTenantOrdinal = worker.tenant_cursor_ordinal;
    while (remaining.size > 0 && claims.length < concurrency) {
      const selection = selectHostedContextHealthJobsV1(
        EffectArray.map([...remaining.values()], row => ({
          dueAt: row.next_due_at.toISOString(),
          scheduleId: row.schedule_id,
          tenantId: row.tenant_id,
        })),
        {concurrency: 1, tenantCursorOrdinal: nextTenantOrdinal},
      );
      const selected = selection.jobs[0];
      if (!selected) break;
      nextTenantOrdinal = selection.nextTenantOrdinal;
      const candidate = remaining.get(selected.scheduleId);
      remaining.delete(selected.scheduleId);
      if (!candidate) continue;
      await setTenantContext(transaction, candidate.tenant_id);
      let evidence: AuthoritativeEvidence | undefined;
      try {
        evidence = await authoritativeEvidence(transaction, candidate, false);
      } catch {
        evidence = undefined;
      }
      if (!evidence) {
        await settleUnavailableCandidate(transaction, candidate, clock.now);
        unavailableCount += 1;
        continue;
      }
      const claimToken = Effect.pipe(randomUuidV4(), EffectString.replaceAll('-', ''));
      const expiresAt = new Date(clock.now.getTime() + CLAIM_LEASE_MILLISECONDS).toISOString();
      const rows = await transaction<{schedule_id: string}[]>`
        UPDATE remote_memory.context_health_due_directory SET
          claim_token = ${claimToken}, claim_expires_at = ${expiresAt},
          claim_generation = ${generation}, updated_at = clock_timestamp()
        WHERE schedule_id = ${candidate.schedule_id}
          AND (claim_token IS NULL OR claim_expires_at <= ${clock.now.toISOString()}::timestamptz)
        RETURNING schedule_id
      `;
      if (!rows[0]) {
        await settleUnavailableCandidate(transaction, candidate, clock.now);
        unavailableCount += 1;
        continue;
      }
      claims.push({
        backlogDepth: backlog.depth,
        claimGeneration: generation,
        claimedAt: clock.now.toISOString(),
        claimToken,
        dueAt: candidate.next_due_at.toISOString(),
        memorySnapshotRevision: evidence.memorySnapshotRevision,
        priorConsecutiveStaleRuns: evidence.priorConsecutiveStaleRuns,
        repositoryCommit: evidence.repositoryCommit,
        schedule: evidence.schedule,
        version: 1,
      });
    }
    await transaction`
      UPDATE remote_memory.context_health_worker_state SET
        generation = ${generation}, tenant_cursor_ordinal = ${nextTenantOrdinal}, updated_at = clock_timestamp()
      WHERE worker_name = 'context-health' AND generation = ${worker.generation}
    `;
    return {
      backlogDepth: backlog.depth,
      claims,
      generation,
      nextTenantOrdinal,
      unavailableCount,
      version: 1,
    };
  });
}

export async function recordHostedContextHealthRun(
  sql: Sql,
  claim: HostedContextHealthClaimV1,
  input: HostedContextHealthRunInputV1,
  evaluationKey: string,
): Promise<HostedContextHealthReceiptV1> {
  return sql.begin(async transaction => {
    await setTenant(transaction, claim.schedule.tenantId);
    verifyHostedContextHealthEvaluationV1(input, evaluationKey);
    if (
      input.evaluationAttestation.claimToken !== claim.claimToken ||
      input.evaluationAttestation.claimGeneration !== claim.claimGeneration
    ) {
      throw new Error('Hosted context health evaluation attestation does not match its database claim.');
    }
    const requestedReceipt = buildHostedContextHealthReceiptV1(input);
    const existingReplay = await transaction<{receipt: HostedContextHealthReceiptV1}[]>`
      SELECT receipt FROM remote_memory.context_health_receipts
      WHERE tenant_id = ${claim.schedule.tenantId} AND schedule_id = ${claim.schedule.scheduleId}
        AND input_digest = ${requestedReceipt.inputDigest}
    `;
    if (existingReplay[0]) return existingReplay[0].receipt;
    const [clock] = await transaction<{now: Date}[]>`SELECT clock_timestamp() AS now`;
    if (!clock) throw new Error('Hosted context health database clock is unavailable.');
    const [claimed] = await transaction<
      {
        claim_expires_at: Date | null;
        claim_generation: number;
        claim_token: string | null;
        next_due_at: Date;
        project_name: string;
        share_id: string;
        tenant_id: string;
      }[]
    >`
      SELECT claim_token, claim_expires_at, claim_generation::integer, next_due_at,
        tenant_id, share_id, project_name
      FROM remote_memory.context_health_due_directory
      WHERE schedule_id = ${claim.schedule.scheduleId}
      FOR UPDATE
    `;
    if (
      !claimed ||
      claimed.claim_token !== claim.claimToken ||
      claimed.claim_generation !== claim.claimGeneration ||
      claimed.claim_expires_at === null ||
      claimed.claim_expires_at.getTime() <= clock.now.getTime() ||
      claimed.next_due_at.toISOString() !== claim.dueAt ||
      claimed.tenant_id !== claim.schedule.tenantId ||
      claimed.share_id !== claim.schedule.shareId ||
      claimed.project_name !== claim.schedule.project
    ) {
      const replayAfterClaim = await transaction<{receipt: HostedContextHealthReceiptV1}[]>`
        SELECT receipt FROM remote_memory.context_health_receipts
        WHERE tenant_id = ${claim.schedule.tenantId} AND schedule_id = ${claim.schedule.scheduleId}
          AND input_digest = ${requestedReceipt.inputDigest}
      `;
      if (replayAfterClaim[0]) return replayAfterClaim[0].receipt;
      throw new Error('Hosted context health claim is unavailable, expired, or changed.');
    }
    const target: DueDirectoryRow = {
      next_due_at: claimed.next_due_at,
      project_name: claimed.project_name,
      schedule_id: claim.schedule.scheduleId,
      share_id: claimed.share_id,
      tenant_id: claimed.tenant_id,
    };
    const evidence = await authoritativeEvidence(transaction, target, true);
    if (!evidence) throw new Error('Hosted context health target or immutable evidence is unavailable.');
    assertClaimEvidence(claim, evidence);
    assertRunMatchesClaim(input, claim, clock.now);
    const authoritativeInput: HostedContextHealthRunInputV1 = {
      ...input,
      backlogDepth: claim.backlogDepth,
      dueAt: claim.dueAt,
      memorySnapshotRevision: evidence.memorySnapshotRevision,
      priorConsecutiveStaleRuns: evidence.priorConsecutiveStaleRuns,
      repositoryCommit: evidence.repositoryCommit,
      schedule: evidence.schedule,
    };
    verifyHostedContextHealthEvaluationV1(authoritativeInput, evaluationKey);
    const receipt = buildHostedContextHealthReceiptV1(authoritativeInput);
    const existing = await transaction<{receipt: HostedContextHealthReceiptV1}[]>`
      SELECT receipt FROM remote_memory.context_health_receipts
      WHERE tenant_id = ${claim.schedule.tenantId} AND schedule_id = ${claim.schedule.scheduleId}
        AND input_digest = ${receipt.inputDigest}
    `;
    if (existing[0]) {
      await releaseClaim(transaction, claim, claimed.next_due_at.toISOString());
      return existing[0].receipt;
    }
    const [scheduleState] = await transaction<
      {consecutive_failures: number; consecutive_stale_runs: number; next_due_at: Date; status: string}[]
    >`
      SELECT status, next_due_at, consecutive_failures, consecutive_stale_runs::integer
      FROM remote_memory.context_health_schedules
      WHERE tenant_id = ${claim.schedule.tenantId} AND share_id = ${claim.schedule.shareId}
        AND project_name = ${claim.schedule.project} AND schedule_id = ${claim.schedule.scheduleId}
      FOR UPDATE
    `;
    if (
      !scheduleState ||
      scheduleState.status !== 'active' ||
      scheduleState.next_due_at.toISOString() !== claim.dueAt ||
      scheduleState.consecutive_stale_runs !== claim.priorConsecutiveStaleRuns
    ) {
      throw new Error('Hosted context health schedule is unavailable or changed.');
    }
    const [commitClock] = await transaction<{now: Date}[]>`SELECT clock_timestamp() AS now`;
    if (!commitClock || claimed.claim_expires_at.getTime() <= commitClock.now.getTime()) {
      throw new Error('Hosted context health claim expired before receipt commit.');
    }
    await transaction`
      INSERT INTO remote_memory.context_health_receipts(
        tenant_id, share_id, project_name, receipt_id, schedule_id, input_digest,
        outcome, receipt, observed_at
      ) VALUES (
        ${claim.schedule.tenantId}, ${claim.schedule.shareId}, ${claim.schedule.project}, ${receipt.receiptId},
        ${claim.schedule.scheduleId}, ${receipt.inputDigest}, ${receipt.outcome},
        ${transaction.json(requireJsonValue(receipt))}, ${receipt.observedAt}
      )
    `;
    const failed = receipt.outcome === 'unknown';
    const failureAttempt = Math.min(31, scheduleState.consecutive_failures + 1);
    const nextDueAt = new Date(
      commitClock.now.getTime() +
        (failed ? hostedContextHealthBackoffMilliseconds(failureAttempt) : claim.schedule.cadenceMinutes * 60_000),
    ).toISOString();
    await transaction`
      UPDATE remote_memory.context_health_schedules SET
        consecutive_failures = ${failed ? failureAttempt : 0},
        consecutive_stale_runs = ${receipt.consecutiveStaleRuns},
        last_attempt_at = ${commitClock.now.toISOString()},
        last_success_at = CASE WHEN ${failed} THEN last_success_at ELSE ${commitClock.now.toISOString()}::timestamptz END,
        last_success_receipt_id = CASE WHEN ${failed} THEN last_success_receipt_id ELSE ${receipt.receiptId} END,
        last_failure_at = CASE WHEN ${failed} THEN ${commitClock.now.toISOString()}::timestamptz ELSE last_failure_at END,
        last_failure_receipt_id = CASE WHEN ${failed} THEN ${receipt.receiptId} ELSE last_failure_receipt_id END,
        next_due_at = ${nextDueAt}, updated_at = clock_timestamp()
      WHERE tenant_id = ${claim.schedule.tenantId} AND share_id = ${claim.schedule.shareId}
        AND project_name = ${claim.schedule.project} AND schedule_id = ${claim.schedule.scheduleId}
    `;
    await releaseClaim(transaction, claim, nextDueAt);
    return receipt;
  });
}

async function settleUnavailableCandidate(transaction: ISql, candidate: DueDirectoryRow, now: Date): Promise<void> {
  const [schedule] = await transaction<{consecutive_failures: number; status: string}[]>`
    SELECT status, consecutive_failures::integer
    FROM remote_memory.context_health_schedules
    WHERE tenant_id = ${candidate.tenant_id} AND share_id = ${candidate.share_id}
      AND project_name = ${candidate.project_name} AND schedule_id = ${candidate.schedule_id}
    FOR UPDATE
  `;
  const failureAttempt = Math.min(31, (schedule?.consecutive_failures ?? 0) + 1);
  const nextDueAt = new Date(now.getTime() + hostedContextHealthBackoffMilliseconds(failureAttempt)).toISOString();
  if (schedule?.status === 'active') {
    await transaction`
      UPDATE remote_memory.context_health_schedules SET
        consecutive_failures = ${failureAttempt}, last_attempt_at = ${now.toISOString()},
        last_failure_at = ${now.toISOString()}, next_due_at = ${nextDueAt}, updated_at = clock_timestamp()
      WHERE tenant_id = ${candidate.tenant_id} AND share_id = ${candidate.share_id}
        AND project_name = ${candidate.project_name} AND schedule_id = ${candidate.schedule_id}
    `;
  }
  await transaction`
    UPDATE remote_memory.context_health_due_directory SET
      next_due_at = ${nextDueAt}, claim_token = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
    WHERE schedule_id = ${candidate.schedule_id}
  `;
}

export async function failHostedContextHealthClaim(sql: Sql, claim: HostedContextHealthClaimV1): Promise<void> {
  await sql.begin(async transaction => {
    await setTenant(transaction, claim.schedule.tenantId);
    const [claimed] = await transaction<{claim_generation: number; claim_token: string | null}[]>`
      SELECT claim_token, claim_generation::integer
      FROM remote_memory.context_health_due_directory
      WHERE schedule_id = ${claim.schedule.scheduleId}
      FOR UPDATE
    `;
    if (!claimed || claimed.claim_token !== claim.claimToken || claimed.claim_generation !== claim.claimGeneration)
      return;
    const [schedule] = await transaction<{consecutive_failures: number; status: string}[]>`
      SELECT status, consecutive_failures FROM remote_memory.context_health_schedules
      WHERE tenant_id = ${claim.schedule.tenantId} AND share_id = ${claim.schedule.shareId}
        AND project_name = ${claim.schedule.project} AND schedule_id = ${claim.schedule.scheduleId}
      FOR UPDATE
    `;
    const [clock] = await transaction<{now: Date}[]>`SELECT clock_timestamp() AS now`;
    if (!schedule || !clock || schedule.status !== 'active') {
      await releaseClaim(transaction, claim, claim.dueAt);
      return;
    }
    const failureAttempt = Math.min(31, schedule.consecutive_failures + 1);
    const nextDueAt = new Date(
      clock.now.getTime() + hostedContextHealthBackoffMilliseconds(failureAttempt),
    ).toISOString();
    await transaction`
      UPDATE remote_memory.context_health_schedules SET
        consecutive_failures = ${failureAttempt}, last_attempt_at = ${clock.now.toISOString()},
        last_failure_at = ${clock.now.toISOString()}, next_due_at = ${nextDueAt}, updated_at = clock_timestamp()
      WHERE tenant_id = ${claim.schedule.tenantId} AND share_id = ${claim.schedule.shareId}
        AND project_name = ${claim.schedule.project} AND schedule_id = ${claim.schedule.scheduleId}
    `;
    await releaseClaim(transaction, claim, nextDueAt);
  });
}

export async function completeHostedContextHealthCycle(
  sql: Sql,
  input: {readonly failed: boolean; readonly generation: number},
): Promise<HostedContextHealthCycleCompletionV1> {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('Hosted context health worker generation is invalid.');
  }
  return sql.begin(async transaction => {
    await setOperationalTimeouts(transaction);
    const [clock] = await transaction<{now: Date}[]>`SELECT clock_timestamp() AS now`;
    if (!clock) throw new Error('Hosted context health database clock is unavailable.');
    const backlog = await authoritativeBacklog(transaction, clock.now);
    const failed = input.failed || backlog.depth > 0;
    const rows = await transaction<{generation: number}[]>`
      UPDATE remote_memory.context_health_worker_state SET
        heartbeat_at = ${clock.now.toISOString()},
        last_success_at = CASE WHEN ${failed} THEN last_success_at ELSE ${clock.now.toISOString()}::timestamptz END,
        last_failure_at = CASE WHEN ${failed} THEN ${clock.now.toISOString()}::timestamptz ELSE last_failure_at END,
        failure_class = CASE
          WHEN ${input.failed} THEN 'health_evaluation_failed'
          WHEN ${backlog.depth > 0} THEN 'health_due_work_remaining'
          ELSE NULL
        END,
        backlog_depth = ${backlog.depth}, scheduler_lag_minutes = ${backlog.lagMinutes},
        updated_at = clock_timestamp()
      WHERE worker_name = 'context-health' AND generation = ${input.generation}
      RETURNING generation::integer
    `;
    return {
      applied: rows.length === 1,
      backlogDepth: backlog.depth,
      generation: input.generation,
      schedulerLagMinutes: backlog.lagMinutes,
      status: rows.length === 0 ? 'superseded' : failed ? 'failed' : 'healthy',
      version: 1,
    };
  });
}

export async function setHostedContextHealthScheduleStatus(
  sql: Sql,
  input: {
    readonly project: string;
    readonly shareId: string;
    readonly status: 'active' | 'paused';
    readonly tenantId: string;
  },
): Promise<{
  readonly changed: boolean;
  readonly labels: {project: string; share: string; tenant: string};
  readonly status: 'active' | 'paused';
  readonly version: 1;
}> {
  return sql.begin(async transaction => {
    await setTenant(transaction, input.tenantId);
    const schedules = await transaction<{schedule_id: string; status: 'active' | 'paused'}[]>`
      SELECT schedule_id, status FROM remote_memory.context_health_schedules
      WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId} AND project_name = ${input.project}
      FOR UPDATE
    `;
    if (!schedules[0]) throw new Error('Hosted context health schedule is unavailable.');
    if (schedules[0].status === input.status) {
      return {
        changed: false,
        labels: hostedContextHealthTargetLabelsV1(input),
        status: input.status,
        version: 1,
      };
    }
    const rows = await transaction<{schedule_id: string}[]>`
      UPDATE remote_memory.context_health_schedules SET status = ${input.status}, updated_at = now()
      WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId} AND project_name = ${input.project}
      RETURNING schedule_id
    `;
    await transaction`
      UPDATE remote_memory.context_health_due_directory SET
        status = ${input.status}, claim_token = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
      WHERE schedule_id = ${schedules[0].schedule_id}
    `;
    return {
      changed: rows.length > 0,
      labels: hostedContextHealthTargetLabelsV1(input),
      status: input.status,
      version: 1,
    };
  });
}

async function authoritativeEvidence(
  transaction: ISql,
  target: DueDirectoryRow,
  lock: boolean,
): Promise<AuthoritativeEvidence | undefined> {
  if (lock) {
    const [locked] = await transaction<{active: boolean}[]>`
      SELECT remote_memory.lock_context_health_target(
        ${target.tenant_id}, ${target.share_id}, ${target.project_name}, ${target.schedule_id}
      ) AS active
    `;
    if (!locked?.active) return undefined;
  }
  const rows = await transaction<
    {
      cadence_minutes: number;
      consecutive_stale_runs: number;
      git_ingest_snapshot_commit: string | null;
      policy_document: HostedContextHealthPolicyV1;
      policy_digest: string;
      schedule_id: string;
      share_generation: string | number;
    }[]
  >`
    SELECT c.schedule_id, c.cadence_minutes, c.policy_digest,
      c.consecutive_stale_runs::integer, policy.policy_document,
      s.git_ingest_snapshot_commit, s.share_generation
    FROM remote_memory.context_health_schedules c
    JOIN remote_memory.context_health_policies policy
      ON policy.tenant_id = c.tenant_id AND policy.share_id = c.share_id
      AND policy.version = c.policy_version AND policy.digest = c.policy_digest
    JOIN remote_memory.tenants t ON t.id = c.tenant_id
    JOIN remote_memory.shares s ON s.tenant_id = c.tenant_id AND s.id = c.share_id
    JOIN remote_memory.projects p
      ON p.tenant_id = c.tenant_id AND p.share_id = c.share_id AND p.name = c.project_name
    WHERE c.schedule_id = ${target.schedule_id} AND c.tenant_id = ${target.tenant_id}
      AND c.share_id = ${target.share_id} AND c.project_name = ${target.project_name}
      AND c.status = 'active' AND t.status = 'active' AND s.status = 'active' AND p.status = 'active'
  `;
  const row = rows[0];
  if (!row?.git_ingest_snapshot_commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(row.git_ingest_snapshot_commit)) {
    return undefined;
  }
  const [binding] = await transaction<{present: boolean}[]>`
    SELECT EXISTS(
      SELECT 1 FROM remote_memory.project_repository_bindings
      WHERE tenant_id = ${target.tenant_id} AND share_id = ${target.share_id}
        AND project_name = ${target.project_name}
    ) AS present
  `;
  if (!binding?.present) return undefined;
  const memoryRows = await transaction<
    {
      content_hash: string;
      current_revision_id: string;
      git_commit: string | null;
      git_observed_commit: string | null;
      head_id: string;
      kind: string;
      topic: string;
    }[]
  >`
    SELECT h.id AS head_id, h.kind, h.topic, h.current_revision_id,
      r.content_hash, r.git_commit, r.git_observed_commit
    FROM remote_memory.memory_heads h
    JOIN remote_memory.memory_revisions r
      ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id
      AND r.head_id = h.id AND r.id = h.current_revision_id
    WHERE h.tenant_id = ${target.tenant_id} AND h.share_id = ${target.share_id}
      AND h.project = ${target.project_name} AND h.status = 'active'
    ORDER BY h.kind, h.topic, h.id
  `;
  if (
    EffectArray.some(
      memoryRows,
      memory => memory.git_commit === null || memory.git_observed_commit !== row.git_ingest_snapshot_commit,
    )
  ) {
    return undefined;
  }
  const schedule = buildHostedContextHealthScheduleV1({
    cadenceMinutes: row.cadence_minutes,
    policy: row.policy_document,
    project: target.project_name,
    shareId: target.share_id,
    tenantId: target.tenant_id,
  });
  if (schedule.scheduleId !== row.schedule_id || schedule.policy.digest !== row.policy_digest) return undefined;
  return {
    memorySnapshotRevision: sha256HexSync(
      JSON.stringify({
        repositoryCommit: row.git_ingest_snapshot_commit,
        revisions: memoryRows,
        shareGeneration: String(row.share_generation),
      }),
    ),
    priorConsecutiveStaleRuns: row.consecutive_stale_runs,
    repositoryCommit: row.git_ingest_snapshot_commit,
    schedule,
  };
}

async function authoritativeBacklog(
  transaction: ISql,
  now: Date,
): Promise<{readonly depth: number; readonly lagMinutes: number}> {
  const [row] = await transaction<{depth: number; oldest_due_at: Date | null}[]>`
    SELECT count(*)::integer AS depth, min(next_due_at) AS oldest_due_at
    FROM remote_memory.context_health_due_directory
    WHERE status = 'active' AND next_due_at <= ${now.toISOString()}::timestamptz
  `;
  const oldest = row?.oldest_due_at?.getTime();
  return {
    depth: row?.depth ?? 0,
    lagMinutes: oldest === undefined ? 0 : Math.max(0, Math.floor((now.getTime() - oldest) / 60_000)),
  };
}

async function releaseClaim(transaction: ISql, claim: HostedContextHealthClaimV1, nextDueAt: string): Promise<void> {
  const rows = await transaction<{schedule_id: string}[]>`
    UPDATE remote_memory.context_health_due_directory SET
      next_due_at = ${nextDueAt}, claim_token = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
    WHERE schedule_id = ${claim.schedule.scheduleId} AND claim_token = ${claim.claimToken}
      AND claim_generation = ${claim.claimGeneration}
    RETURNING schedule_id
  `;
  if (!rows[0]) throw new Error('Hosted context health claim changed before release.');
}

function assertClaimEvidence(claim: HostedContextHealthClaimV1, evidence: AuthoritativeEvidence): void {
  if (
    canonicalJson(claim.schedule) !== canonicalJson(evidence.schedule) ||
    claim.repositoryCommit !== evidence.repositoryCommit ||
    claim.memorySnapshotRevision !== evidence.memorySnapshotRevision ||
    claim.priorConsecutiveStaleRuns !== evidence.priorConsecutiveStaleRuns
  ) {
    throw new Error('Hosted context health immutable evidence changed after claim.');
  }
}

function assertRunMatchesClaim(
  input: HostedContextHealthRunInputV1,
  claim: HostedContextHealthClaimV1,
  now: Date,
): void {
  if (
    canonicalJson(input.schedule) !== canonicalJson(claim.schedule) ||
    input.dueAt !== claim.dueAt ||
    input.repositoryCommit !== claim.repositoryCommit ||
    input.memorySnapshotRevision !== claim.memorySnapshotRevision ||
    input.priorConsecutiveStaleRuns !== claim.priorConsecutiveStaleRuns ||
    input.backlogDepth !== claim.backlogDepth
  ) {
    throw new Error('Hosted context health evaluation does not match its database claim.');
  }
  const observed = Date.parse(input.observedAt);
  if (!Number.isFinite(observed) || Math.abs(now.getTime() - observed) > MAXIMUM_OBSERVATION_SKEW_MILLISECONDS) {
    throw new Error('Hosted context health observation is outside the database clock skew window.');
  }
}

function scheduleReceipt(
  schedule: HostedContextHealthScheduleV1,
  nextDueAt: string,
  status: 'active' | 'paused',
): HostedContextHealthScheduleReceiptV1 {
  return {
    cadenceMinutes: schedule.cadenceMinutes,
    labels: hostedContextHealthTargetLabelsV1(schedule),
    nextDueAt,
    policyDigest: schedule.policy.digest,
    scheduleId: schedule.scheduleId,
    status,
    version: 1,
  };
}

async function setTenant(transaction: ISql, tenantId: string): Promise<void> {
  await setOperationalTimeouts(transaction);
  await setTenantContext(transaction, tenantId);
}

async function setOperationalTimeouts(transaction: ISql): Promise<void> {
  await transaction`SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)`;
  await transaction`SELECT set_config('statement_timeout', ${String(DATABASE_TIMEOUT_MILLISECONDS)}, true)`;
  await transaction`SELECT set_config('lock_timeout', ${String(DATABASE_TIMEOUT_MILLISECONDS)}, true)`;
  await transaction`SELECT set_config('transaction_timeout', ${String(DATABASE_TIMEOUT_MILLISECONDS)}, true)`;
}

async function setTenantContext(transaction: ISql, tenantId: string): Promise<void> {
  await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
}

function timestamp(value: string, name: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`Invalid hosted context health ${name}.`);
  }
  return value;
}
