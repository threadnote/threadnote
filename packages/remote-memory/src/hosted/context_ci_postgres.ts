import {assertHostedContextCiWorkerPrivileges} from '../runtime_privileges.js';
import {requireJsonValue} from '../json.js';
import type {Sql, ISql} from 'postgres';
import {
  admitHostedContextCiWebhookV1,
  ciIdentifier,
  hostedContextCiBackoffMilliseconds,
  parseHostedContextCiPolicyV1,
  type HostedContextCiJobV1,
  type HostedContextCiPolicyV1,
  type HostedContextCiWebhookV1,
} from './context_ci.js';
import {
  evaluateHostedContextCiJobV1,
  publishHostedContextCiJobV1,
  type HostedContextCiDiagnosticsV1,
  type HostedContextCiPublicationIdentityV1,
  type HostedContextCiReadIdentityV1,
} from './context_ci_operator.js';

const initializedWorkerPools = new WeakMap<Sql, Promise<void>>();

/** Call at startup and after any role, grant, helper, or migration change; a failed check poisons the pool. */
export function initializeHostedContextCiStorage(sql: Sql): Promise<void> {
  const initialized = assertHostedContextCiWorkerPrivileges(sql);
  initializedWorkerPools.set(sql, initialized);
  return initialized;
}

function workerStorageReady(sql: Sql): Promise<void> {
  return initializedWorkerPools.get(sql) ?? initializeHostedContextCiStorage(sql);
}

export interface HostedContextCiReceiptV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly attempt: number;
  readonly status: 'evaluated' | 'published' | 'retry' | 'failed';
  readonly reason?: 'evaluation-unavailable' | 'publication-unavailable' | 'immutable-ref-changed' | 'policy-changed';
  readonly retryAt?: string;
  readonly reportDigest?: string;
  readonly publicationDigest?: string;
}

/** Control-plane operations use an operator account; the queue worker cannot opt in or enable the service. */
export async function registerHostedContextCiTarget(sql: Sql, input: HostedContextCiPolicyV1): Promise<void> {
  const policy = parseHostedContextCiPolicyV1(input);
  await sql.begin(async transaction => {
    await setTenant(transaction, policy.tenantId);
    await transaction`
      INSERT INTO remote_memory.context_ci_tenant_limits(tenant_id) VALUES (${policy.tenantId})
      ON CONFLICT (tenant_id) DO NOTHING
    `;
    const rows = await transaction`
      INSERT INTO remote_memory.context_ci_targets(
        tenant_id, repository_id, share_id, project_name, policy_digest, policy
      ) VALUES (${policy.tenantId}, ${policy.repositoryId}, ${policy.shareId}, ${policy.project},
        ${policy.digest}, ${transaction.json(requireJsonValue(policy))})
      ON CONFLICT (tenant_id, repository_id) DO UPDATE SET
        share_id = EXCLUDED.share_id, project_name = EXCLUDED.project_name,
        policy_digest = EXCLUDED.policy_digest, policy = EXCLUDED.policy
      WHERE NOT remote_memory.context_ci_targets.opted_in
        OR remote_memory.context_ci_targets.policy_digest = EXCLUDED.policy_digest
      RETURNING tenant_id
    `;
    if (rows.length !== 1) throw new Error('Opt out before replacing a Context CI policy.');
  });
}

export async function setHostedContextCiEnabled(sql: Sql, enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new Error('Context CI switch is invalid.');
  await sql`UPDATE remote_memory.context_ci_control SET enabled = ${enabled} WHERE singleton`;
}

export async function setHostedContextCiOptIn(
  sql: Sql,
  tenantId: string,
  repositoryId: string,
  optedIn: boolean,
): Promise<void> {
  ciIdentifier(tenantId);
  ciIdentifier(repositoryId);
  if (typeof optedIn !== 'boolean') throw new Error('Context CI opt-in is invalid.');
  await sql.begin(async transaction => {
    await setTenant(transaction, tenantId);
    const changed = await transaction`
      UPDATE remote_memory.context_ci_targets SET opted_in = ${optedIn}
      WHERE tenant_id = ${tenantId} AND repository_id = ${repositoryId} RETURNING tenant_id
    `;
    if (changed.length !== 1) throw new Error('Context CI target is unavailable.');
  });
}

/** Operator-only compaction retains the immutable identity and bounded attempt receipts indefinitely. */
export async function archiveHostedContextCiJobs(sql: Sql, tenantId: string, repositoryId: string): Promise<number> {
  ciIdentifier(tenantId);
  ciIdentifier(repositoryId);
  return sql.begin(async transaction => {
    await setTenant(transaction, tenantId);
    await transaction`SELECT singleton FROM remote_memory.context_ci_control WHERE singleton FOR SHARE`;
    const target = await transaction`
      SELECT c.tenant_id FROM remote_memory.context_ci_targets c
      JOIN remote_memory.tenants t ON t.id = c.tenant_id
      JOIN remote_memory.shares s ON s.tenant_id = c.tenant_id AND s.id = c.share_id
      JOIN remote_memory.projects p ON p.tenant_id = c.tenant_id AND p.share_id = c.share_id AND p.name = c.project_name
      WHERE c.tenant_id = ${tenantId} AND c.repository_id = ${repositoryId} FOR SHARE OF c, t, s, p
    `;
    if (target.length !== 1) throw new Error('Context CI target is unavailable.');
    await transaction`SELECT tenant_id FROM remote_memory.context_ci_tenant_limits
      WHERE tenant_id = ${tenantId} FOR UPDATE`;
    const archived = await transaction`
      UPDATE remote_memory.context_ci_jobs SET archived_outcome = stage, stage = 'archived', job = NULL, diagnostics = NULL
      WHERE tenant_id = ${tenantId} AND repository_id = ${repositoryId} AND stage IN ('published', 'failed')
      RETURNING job_id
    `;
    return archived.length;
  });
}

export async function enqueueHostedContextCiWebhook(
  sql: Sql,
  input: {
    readonly tenantId: string;
    readonly repositoryId: string;
    readonly webhook: HostedContextCiWebhookV1;
    readonly webhookKey: string;
  },
): Promise<{
  readonly status: 'accepted' | 'replay' | 'denied' | 'rate-limited' | 'queue-full';
  readonly jobId?: string;
  readonly retryAfterMilliseconds?: number;
}> {
  ciIdentifier(input.tenantId);
  ciIdentifier(input.repositoryId);
  await workerStorageReady(sql);
  return sql.begin(async transaction => {
    await setTenant(transaction, input.tenantId);
    const policy = await activePolicy(transaction, input.tenantId, input.repositoryId);
    if (!policy) return {status: 'denied' as const};
    const [clock] = await transaction<{now: Date}[]>`SELECT clock_timestamp() AS now`;
    let job: HostedContextCiJobV1;
    try {
      job = admitHostedContextCiWebhookV1(policy, input.webhook, input.webhookKey, clock.now.getTime());
    } catch {
      return {status: 'denied' as const};
    }
    // One tenant lock serializes admission across all its repositories and replicas.
    const [limits] = await transaction<{window_started_at: Date; request_count: number}[]>`
      SELECT window_started_at, request_count FROM remote_memory.context_ci_tenant_limits
      WHERE tenant_id = ${input.tenantId} FOR UPDATE
    `;
    if (!limits) throw new Error('Context CI tenant limits are unavailable.');
    const existing = await transaction`
      SELECT job_id FROM remote_memory.context_ci_jobs WHERE tenant_id = ${input.tenantId} AND job_id = ${job.jobId}
    `;
    if (existing.length) return {status: 'replay' as const, jobId: job.jobId};
    const [bounds] = await transaction<{queue_limit: number; rate_limit: number}[]>`
      SELECT min((policy->>'queueLimit')::integer) AS queue_limit,
        min((policy->>'requestsPerMinute')::integer) AS rate_limit
      FROM remote_memory.context_ci_targets WHERE tenant_id = ${input.tenantId} AND opted_in
    `;
    const [depth] = await transaction<{count: number}[]>`
      SELECT count(*)::integer AS count FROM remote_memory.context_ci_jobs
      WHERE tenant_id = ${input.tenantId} AND stage <> 'archived'
    `;
    if (depth.count >= bounds.queue_limit) return {status: 'queue-full' as const};
    const elapsed = clock.now.getTime() - limits.window_started_at.getTime();
    if (elapsed < 60_000 && limits.request_count >= bounds.rate_limit) {
      return {status: 'rate-limited' as const, retryAfterMilliseconds: Math.max(1, 60_000 - elapsed)};
    }
    await transaction`
      UPDATE remote_memory.context_ci_tenant_limits
      SET window_started_at = CASE WHEN ${elapsed >= 60_000} THEN ${clock.now} ELSE window_started_at END,
        request_count = CASE WHEN ${elapsed >= 60_000} THEN 1 ELSE request_count + 1 END
      WHERE tenant_id = ${input.tenantId}
    `;
    await transaction`
      INSERT INTO remote_memory.context_ci_jobs(tenant_id, repository_id, job_id, input_digest, job)
      VALUES (${input.tenantId}, ${input.repositoryId}, ${job.jobId}, ${job.inputDigest},
        ${transaction.json(requireJsonValue(job))})
    `;
    return {status: 'accepted' as const, jobId: job.jobId};
  });
}

/** One call advances at most one stage. The evaluation commit precedes any external publication. */
export async function runHostedContextCiOperator(
  sql: Sql,
  input: {
    readonly tenantId: string;
    readonly reader: HostedContextCiReadIdentityV1;
    readonly publisher?: HostedContextCiPublicationIdentityV1;
  },
): Promise<HostedContextCiReceiptV1 | undefined> {
  ciIdentifier(input.tenantId);
  await workerStorageReady(sql);
  return sql.begin(async transaction => {
    await setTenant(transaction, input.tenantId);
    const [row] = await transaction<
      {
        job: HostedContextCiJobV1;
        repository_id: string;
        stage: 'queued' | 'evaluated';
        attempts: number;
        diagnostics: HostedContextCiDiagnosticsV1 | null;
      }[]
    >`
      SELECT j.job, j.repository_id, j.stage, j.attempts, j.diagnostics
      FROM remote_memory.context_ci_jobs j JOIN remote_memory.context_ci_targets c
        ON c.tenant_id = j.tenant_id AND c.repository_id = j.repository_id
      WHERE j.tenant_id = ${input.tenantId} AND j.stage = ${input.publisher !== undefined ? 'evaluated' : 'queued'}
        AND j.available_at <= clock_timestamp() AND c.opted_in
      ORDER BY j.available_at, j.job_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
    `;
    if (!row) return undefined;
    const policy = await activePolicy(transaction, input.tenantId, row.repository_id);
    if (!policy) return undefined;
    const lease = await transaction`
      SELECT tenant_id FROM remote_memory.context_ci_tenant_limits
      WHERE tenant_id = ${input.tenantId} FOR UPDATE SKIP LOCKED
    `;
    if (lease.length !== 1) return undefined;
    const attempt = row.attempts + 1;
    const result =
      row.job.policyDigest !== policy.digest
        ? {status: 'retry' as const, reason: 'policy-changed' as const}
        : row.stage === 'queued'
          ? await evaluateHostedContextCiJobV1(policy, row.job, input.reader)
          : row.diagnostics && input.publisher
            ? await publishHostedContextCiJobV1(policy, row.job, row.diagnostics, input.reader, input.publisher)
            : {status: 'retry' as const, reason: 'publication-unavailable' as const};
    const terminal =
      result.status === 'retry' &&
      (attempt >= policy.maxAttempts + (row.stage === 'evaluated' ? 1 : 0) ||
        result.reason === 'immutable-ref-changed' ||
        result.reason === 'policy-changed');
    const [clock] = await transaction<{now: Date}[]>`SELECT clock_timestamp() AS now`;
    const retryAt =
      result.status === 'retry' && !terminal
        ? new Date(clock.now.getTime() + hostedContextCiBackoffMilliseconds(attempt)).toISOString()
        : undefined;
    const receipt: HostedContextCiReceiptV1 = {
      version: 1,
      jobId: row.job.jobId,
      attempt,
      status: terminal ? 'failed' : result.status,
      ...(result.status === 'retry' ? {reason: result.reason} : {}),
      ...(retryAt === undefined ? {} : {retryAt}),
      ...(result.status === 'evaluated' ? {reportDigest: result.diagnostics.digest} : {}),
      ...(result.status === 'published'
        ? {reportDigest: result.reportDigest, publicationDigest: result.publicationDigest}
        : {}),
    };
    const nextStage = terminal ? 'failed' : result.status === 'retry' ? row.stage : result.status;
    await transaction`
      UPDATE remote_memory.context_ci_jobs SET stage = ${nextStage}, attempts = ${attempt},
        available_at = ${retryAt ?? clock.now.toISOString()},
        diagnostics = ${transaction.json(requireJsonValue(result.status === 'evaluated' ? result.diagnostics : row.diagnostics))}
      WHERE tenant_id = ${input.tenantId} AND job_id = ${row.job.jobId}
    `;
    await transaction`
      INSERT INTO remote_memory.context_ci_receipts(tenant_id, job_id, attempt, receipt)
      VALUES (${input.tenantId}, ${row.job.jobId}, ${attempt}, ${transaction.json(requireJsonValue(receipt))})
    `;
    return receipt;
  });
}

async function activePolicy(
  transaction: ISql,
  tenantId: string,
  repositoryId: string,
): Promise<HostedContextCiPolicyV1 | undefined> {
  const [lock] = await transaction<{active: boolean}[]>`
    SELECT remote_memory.lock_context_ci_target(${tenantId}, ${repositoryId}) AS active
  `;
  if (!lock.active) return undefined;
  const [row] = await transaction<{policy: HostedContextCiPolicyV1}[]>`
    SELECT policy FROM remote_memory.context_ci_targets WHERE tenant_id = ${tenantId} AND repository_id = ${repositoryId}
  `;
  const policy = parseHostedContextCiPolicyV1(row.policy);
  if (policy.tenantId !== tenantId || policy.repositoryId !== repositoryId)
    throw new Error('Context CI policy scope mismatch.');
  return policy;
}

async function setTenant(transaction: ISql, tenantId: string): Promise<void> {
  await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
  await transaction`SELECT set_config('statement_timeout', '30000', true)`;
  await transaction`SELECT set_config('transaction_timeout', '60000', true)`;
}
