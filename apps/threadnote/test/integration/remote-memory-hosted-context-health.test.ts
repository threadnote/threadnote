import postgres, {type Sql, type TransactionSql} from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {aggregateContextHealthReportsV1} from '@threadnote/context/health_schedule';
import type {ContextHealthReportV1} from '@threadnote/context/health';
import {randomUuidV4} from '@threadnote/threadnote/crypto/uuid';
import {
  buildHostedContextHealthPolicyV1,
  buildHostedContextHealthScheduleV1,
  signHostedContextHealthEvaluationV1,
  type HostedContextHealthRunInputV1,
} from '@threadnote/remote-memory/hosted/context_health';
import {
  claimHostedContextHealthJobs,
  completeHostedContextHealthCycle,
  failHostedContextHealthClaim,
  recordHostedContextHealthRun,
  registerHostedContextHealthSchedule,
  setHostedContextHealthScheduleStatus,
  type HostedContextHealthClaimV1,
} from '@threadnote/remote-memory/hosted/context_health_postgres';
import {PostgresRemoteControlPlane} from '@threadnote/remote-memory/postgres/control_plane';
import {
  createRemoteMemoryPostgresFixture,
  type RemoteMemoryPostgresFixture,
} from '../helpers/remote-memory-postgres.js';

const databaseUrl = process.env.THREADNOTE_TEST_POSTGRES_URL;
const tenantId = 'hosted-health-tenant';
const shareId = 'hosted-health-share';
const project = 'threadnote';
const repositoryCommit = '1'.repeat(40);
const evaluationKey = 'test-context-health-evaluation-key-32-bytes';

(databaseUrl ? describe : describe.skip)('hosted organization context health PostgreSQL receipts', () => {
  let database: RemoteMemoryPostgresFixture;
  let admin: ReturnType<typeof postgres>;
  let healthWorker: ReturnType<typeof postgres>;
  let healthWorkerRoleName: string;

  beforeAll(async () => {
    database = await createRemoteMemoryPostgresFixture(databaseUrl!);
    admin = postgres(databaseUrl!, {max: 1, onnotice: () => undefined});
    healthWorkerRoleName = database.runtimeRoleName.replace('runtime', 'context_health_worker');
    const password = randomUuidV4().replaceAll('-', '');
    await admin.unsafe(
      `CREATE ROLE ${healthWorkerRoleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${database.databaseName} TO ${healthWorkerRoleName}`);
    const healthGrants = (await Bun.file('deploy/remote-memory/grants/002-context-health-worker.sql').text())
      .replace(/^\\set .*$/gm, '')
      .replaceAll('threadnote_context_health_worker', healthWorkerRoleName);
    await database.migratorSql.unsafe(healthGrants);
    const healthUrl = new URL(databaseUrl!);
    healthUrl.pathname = `/${database.databaseName}`;
    healthUrl.username = healthWorkerRoleName;
    healthUrl.password = password;
    healthWorker = postgres(healthUrl.toString(), {max: 4, onnotice: () => undefined});
    await new PostgresRemoteControlPlane(database.migratorSql).provision({
      capabilities: ['memory:read'],
      clientId: 'health-worker-client',
      cursorAttestationRequired: false,
      displayName: 'Hosted health acceptance',
      issuer: 'https://identity.example.test/oauth2/pilot',
      policyVersion: 'reader-v1',
      principalId: 'health-worker',
      projects: [project],
      region: 'test',
      repositoryBindings: {[project]: ['https://github.com/example/threadnote.git']},
      shareId,
      sharePolicyVersion: 'share-v1',
      subject: 'health-worker-subject',
      tenantId,
    });
    await withTenant(database.migratorSql, tenantId, async transaction => {
      await transaction`
        UPDATE remote_memory.shares SET git_ingest_snapshot_commit = ${repositoryCommit}
        WHERE tenant_id = ${tenantId} AND id = ${shareId}
      `;
    });
  });

  afterAll(async () => {
    await healthWorker?.end({timeout: 5});
    await database?.dispose();
    if (healthWorkerRoleName) await admin?.unsafe(`DROP ROLE IF EXISTS ${healthWorkerRoleName}`);
    await admin?.end({timeout: 5});
  });

  it('persists explicit success/failure receipts and replays inputs idempotently without memory mutation', async () => {
    const policy = buildHostedContextHealthPolicyV1({
      backlogAlertCount: 10,
      persistentStaleRuns: 2,
      policyVersion: 'pilot-health-v1',
      schedulerLagMinutes: 15,
      supportOwner: 'pilot-support-primary',
      workerHeartbeatMinutes: 5,
    });
    const schedule = buildHostedContextHealthScheduleV1({cadenceMinutes: 60, policy, project, shareId, tenantId});
    const dueAt = await databaseTimestamp(database.migratorSql);
    const registration = await registerHostedContextHealthSchedule(database.migratorSql, schedule, dueAt);
    const registrationReplay = await registerHostedContextHealthSchedule(database.migratorSql, schedule, dueAt);
    const batch = await claimHostedContextHealthJobs(healthWorker, 1);
    const claim = batch.claims[0];
    const input = runInput(claim, aggregate());

    const [first, replay] = await Promise.all([
      recordHostedContextHealthRun(healthWorker, claim, input, evaluationKey),
      recordHostedContextHealthRun(healthWorker, claim, structuredClone(input), evaluationKey),
    ]);
    const completion = await completeHostedContextHealthCycle(healthWorker, {
      failed: false,
      generation: batch.generation,
    });
    const registrationAfterRun = await registerHostedContextHealthSchedule(database.migratorSql, schedule, dueAt);
    const paused = await setHostedContextHealthScheduleStatus(database.migratorSql, {
      project,
      shareId,
      status: 'paused',
      tenantId,
    });
    const registrationWhilePaused = await registerHostedContextHealthSchedule(database.migratorSql, schedule, dueAt);
    const resumed = await setHostedContextHealthScheduleStatus(database.migratorSql, {
      project,
      shareId,
      status: 'active',
      tenantId,
    });
    await forceScheduleDue(database, schedule.scheduleId);
    const failureBatch = await claimHostedContextHealthJobs(healthWorker, 1);
    const failureClaim = failureBatch.claims[0];
    const failureInput = resign(
      {
        ...runInput(failureClaim, aggregate(true)),
        signals: {
          citationChanged: 0,
          citationCurrent: 2,
          citationMissing: 0,
          citationUnknown: 1,
          failedChecks: 1,
          policyDrift: 0,
          staleHandoffs: 0,
          unindexedScope: 0,
        },
      },
      failureClaim,
    );
    const [failure, failureReplay] = await Promise.all([
      recordHostedContextHealthRun(healthWorker, failureClaim, failureInput, evaluationKey),
      recordHostedContextHealthRun(healthWorker, failureClaim, structuredClone(failureInput), evaluationKey),
    ]);
    await completeHostedContextHealthCycle(healthWorker, {failed: true, generation: failureBatch.generation});

    expect(batch.backlogDepth).toBe(1);
    expect(claim.repositoryCommit).toBe(repositoryCommit);
    expect(registration.labels).toEqual(first.labels);
    expect(registrationReplay).toEqual(registration);
    expect(Date.parse(registrationAfterRun.nextDueAt)).toBeGreaterThan(Date.parse(dueAt));
    expect(paused).toMatchObject({changed: true, status: 'paused'});
    expect(registrationWhilePaused).toMatchObject({status: 'paused'});
    expect(resumed).toMatchObject({changed: true, status: 'active'});
    expect(replay).toEqual(first);
    expect(failureReplay).toEqual(failure);
    expect(completion).toMatchObject({applied: true, backlogDepth: 0, status: 'healthy'});
    await expect(
      setHostedContextHealthScheduleStatus(database.migratorSql, {
        project: 'missing-project',
        shareId,
        status: 'paused',
        tenantId,
      }),
    ).rejects.toThrow(/schedule is unavailable/i);
    await database.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
      const receipts = await transaction<{count: number}[]>`
        SELECT count(*)::integer AS count FROM remote_memory.context_health_receipts
        WHERE tenant_id = ${tenantId} AND share_id = ${shareId}
      `;
      const schedules = await transaction<
        {last_failure_receipt_id: string | null; last_success_receipt_id: string | null}[]
      >`
        SELECT last_success_receipt_id, last_failure_receipt_id
        FROM remote_memory.context_health_schedules
        WHERE tenant_id = ${tenantId} AND share_id = ${shareId} AND project_name = ${project}
      `;
      const memories = await transaction<{count: number}[]>`
        SELECT count(*)::integer AS count FROM remote_memory.memory_revisions
        WHERE tenant_id = ${tenantId} AND share_id = ${shareId}
      `;
      expect(receipts).toEqual([{count: 2}]);
      expect(schedules).toEqual([
        {last_failure_receipt_id: failure.receiptId, last_success_receipt_id: first.receiptId},
      ]);
      expect(memories).toEqual([{count: 0}]);
    });
  });

  it('claims each due revision once and fails closed on fabricated, stale-clock, and archived evidence', async () => {
    const policy = buildHostedContextHealthPolicyV1({
      backlogAlertCount: 10,
      persistentStaleRuns: 2,
      policyVersion: 'pilot-health-v1',
      schedulerLagMinutes: 15,
      supportOwner: 'pilot-support-primary',
      workerHeartbeatMinutes: 5,
    });
    const schedule = buildHostedContextHealthScheduleV1({cadenceMinutes: 60, policy, project, shareId, tenantId});

    await forceScheduleDue(database, schedule.scheduleId);
    const competing = await Promise.all([
      claimHostedContextHealthJobs(healthWorker, 1),
      claimHostedContextHealthJobs(healthWorker, 1),
    ]);
    expect(competing.map(batch => batch.claims.length).sort()).toEqual([0, 1]);
    const claimed = competing.flatMap(batch => batch.claims)[0];
    const follower = await claimHostedContextHealthJobs(healthWorker, 1);
    expect(follower.claims).toEqual([]);
    await expect(
      completeHostedContextHealthCycle(healthWorker, {failed: false, generation: claimed.claimGeneration}),
    ).resolves.toMatchObject({applied: false, status: 'superseded'});
    await expect(
      completeHostedContextHealthCycle(healthWorker, {failed: false, generation: follower.generation}),
    ).resolves.toMatchObject({applied: true, backlogDepth: 1, status: 'failed'});
    const beforeFabricatedWrite = await receiptCount(database.migratorSql, claimed.schedule.scheduleId);
    await expect(
      recordHostedContextHealthRun(
        healthWorker,
        claimed,
        {
          ...runInput(claimed, aggregate(true)),
          aggregate: aggregate(),
          signals: runInput(claimed, aggregate()).signals,
        },
        evaluationKey,
      ),
    ).rejects.toThrow(/attestation is invalid/i);
    expect(await receiptCount(database.migratorSql, claimed.schedule.scheduleId)).toBe(beforeFabricatedWrite);
    await expect(
      recordHostedContextHealthRun(
        healthWorker,
        claimed,
        resign(
          {
            ...runInput(claimed, aggregate()),
            repositoryCommit: 'f'.repeat(40),
          },
          claimed,
        ),
        evaluationKey,
      ),
    ).rejects.toThrow(/does not match its database claim/i);
    await failHostedContextHealthClaim(healthWorker, claimed);

    await forceScheduleDue(database, schedule.scheduleId);
    const archivedClaim = (await claimHostedContextHealthJobs(healthWorker, 1)).claims[0];
    await withTenant(database.migratorSql, tenantId, async transaction => {
      await transaction`
        UPDATE remote_memory.projects SET status = 'archived'
        WHERE tenant_id = ${tenantId} AND share_id = ${shareId} AND name = ${project}
      `;
    });
    await expect(
      recordHostedContextHealthRun(healthWorker, archivedClaim, runInput(archivedClaim, aggregate()), evaluationKey),
    ).rejects.toThrow(/target or immutable evidence is unavailable/i);
    await failHostedContextHealthClaim(healthWorker, archivedClaim);
    await withTenant(database.migratorSql, tenantId, async transaction => {
      await transaction`
        UPDATE remote_memory.projects SET status = 'active'
        WHERE tenant_id = ${tenantId} AND share_id = ${shareId} AND name = ${project}
      `;
    });

    await forceScheduleDue(database, schedule.scheduleId);
    const skewedClaim = (await claimHostedContextHealthJobs(healthWorker, 1)).claims[0];
    await expect(
      recordHostedContextHealthRun(
        healthWorker,
        skewedClaim,
        resign(
          {
            ...runInput(skewedClaim, aggregate()),
            observedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          },
          skewedClaim,
        ),
        evaluationKey,
      ),
    ).rejects.toThrow(/database clock skew window/i);
    await failHostedContextHealthClaim(healthWorker, skewedClaim);
  });

  it('backs off unavailable evidence and continues the bounded scan to healthy work', async () => {
    const poisonedTenant = 'aaa-poisoned-health-tenant';
    const poisonedShare = 'aaa-poisoned-health-share';
    const policy = buildHostedContextHealthPolicyV1({
      backlogAlertCount: 10,
      persistentStaleRuns: 2,
      policyVersion: 'pilot-health-v1',
      schedulerLagMinutes: 15,
      supportOwner: 'pilot-support-primary',
      workerHeartbeatMinutes: 5,
    });
    const healthySchedule = buildHostedContextHealthScheduleV1({
      cadenceMinutes: 60,
      policy,
      project,
      shareId,
      tenantId,
    });
    const poisonedPolicy = buildHostedContextHealthPolicyV1({
      backlogAlertCount: 10,
      persistentStaleRuns: 2,
      policyVersion: 'poison-health-v1',
      schedulerLagMinutes: 15,
      supportOwner: 'pilot-support-primary',
      workerHeartbeatMinutes: 5,
    });
    const poisonedSchedule = buildHostedContextHealthScheduleV1({
      cadenceMinutes: 60,
      policy: poisonedPolicy,
      project,
      shareId: poisonedShare,
      tenantId: poisonedTenant,
    });
    await new PostgresRemoteControlPlane(database.migratorSql).provision({
      capabilities: ['memory:read'],
      clientId: 'poisoned-health-worker-client',
      cursorAttestationRequired: false,
      displayName: 'Poisoned hosted health acceptance',
      issuer: 'https://identity.example.test/oauth2/pilot',
      policyVersion: 'reader-v1',
      principalId: 'poisoned-health-worker',
      projects: [project],
      region: 'test',
      repositoryBindings: {[project]: ['https://github.com/example/poisoned.git']},
      shareId: poisonedShare,
      sharePolicyVersion: 'share-v1',
      subject: 'poisoned-health-worker-subject',
      tenantId: poisonedTenant,
    });
    await withTenant(database.migratorSql, poisonedTenant, async transaction => {
      await transaction`
        UPDATE remote_memory.shares SET git_ingest_snapshot_commit = ${repositoryCommit}
        WHERE tenant_id = ${poisonedTenant} AND id = ${poisonedShare}
      `;
    });
    const oldestDue = new Date(Date.now() - 2 * 60_000).toISOString();
    await registerHostedContextHealthSchedule(database.migratorSql, poisonedSchedule, oldestDue);
    await forceScheduleDue(database, healthySchedule.scheduleId);
    await withTenant(database.migratorSql, poisonedTenant, async transaction => {
      await transaction`
        UPDATE remote_memory.context_health_policies SET policy_document = '{}'::jsonb
        WHERE tenant_id = ${poisonedTenant} AND share_id = ${poisonedShare}
          AND version = ${poisonedPolicy.policyVersion}
      `;
    });

    const batch = await claimHostedContextHealthJobs(healthWorker, 1);
    expect(batch).toMatchObject({unavailableCount: 1});
    expect(batch.claims.map(claim => claim.schedule.scheduleId)).toEqual([healthySchedule.scheduleId]);
    let poisonedState: {consecutive_failures: number; next_due_at: Date} | undefined;
    await withTenant(database.migratorSql, poisonedTenant, async transaction => {
      [poisonedState] = await transaction<{consecutive_failures: number; next_due_at: Date}[]>`
        SELECT consecutive_failures::integer, next_due_at
        FROM remote_memory.context_health_schedules
        WHERE tenant_id = ${poisonedTenant} AND schedule_id = ${poisonedSchedule.scheduleId}
      `;
    });
    expect(poisonedState).toBeDefined();
    if (!poisonedState) throw new Error('Poisoned schedule state was not visible.');
    expect(poisonedState.consecutive_failures).toBe(1);
    expect(poisonedState.next_due_at.getTime()).toBeGreaterThan(Date.now());
    await failHostedContextHealthClaim(healthWorker, batch.claims[0]);
  });
});

function runInput(
  claim: HostedContextHealthClaimV1,
  healthAggregate: ReturnType<typeof aggregate>,
): HostedContextHealthRunInputV1 {
  return signHostedContextHealthEvaluationV1(
    {
      aggregate: healthAggregate,
      backlogDepth: claim.backlogDepth,
      dueAt: claim.dueAt,
      memorySnapshotRevision: claim.memorySnapshotRevision,
      observedAt: claim.claimedAt,
      priorConsecutiveStaleRuns: claim.priorConsecutiveStaleRuns,
      repositoryCommit: claim.repositoryCommit,
      schedule: claim.schedule,
      signals: {
        citationChanged: 0,
        citationCurrent: 2,
        citationMissing: 0,
        citationUnknown: 0,
        failedChecks: 0,
        policyDrift: 0,
        staleHandoffs: 0,
        unindexedScope: 0,
      },
      version: 1,
      workerHeartbeatAt: claim.claimedAt,
    },
    claim,
    evaluationKey,
  );
}

function resign(
  input: HostedContextHealthRunInputV1,
  claim: HostedContextHealthClaimV1,
): HostedContextHealthRunInputV1 {
  const {evaluationAttestation: _evaluationAttestation, ...unsigned} = input;
  return signHostedContextHealthEvaluationV1(unsigned, claim, evaluationKey);
}

async function databaseTimestamp(sql: Sql): Promise<string> {
  const [row] = await sql<{value: Date}[]>`SELECT clock_timestamp() - interval '1 minute' AS value`;
  return row.value.toISOString();
}

async function receiptCount(sql: Sql, scheduleId: string): Promise<number> {
  return sql.begin(async transaction => {
    await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
    const [row] = await transaction<{count: number}[]>`
      SELECT count(*)::integer AS count FROM remote_memory.context_health_receipts
      WHERE tenant_id = ${tenantId} AND schedule_id = ${scheduleId}
    `;
    return row.count;
  });
}

async function forceScheduleDue(database: RemoteMemoryPostgresFixture, scheduleId: string): Promise<void> {
  const forcedDue = await databaseTimestamp(database.migratorSql);
  await withTenant(database.migratorSql, tenantId, async transaction => {
    await transaction`
      UPDATE remote_memory.context_health_schedules SET next_due_at = ${forcedDue}
      WHERE schedule_id = ${scheduleId}
    `;
    await transaction`
      UPDATE remote_memory.context_health_due_directory SET next_due_at = ${forcedDue}
      WHERE schedule_id = ${scheduleId}
    `;
  });
}

async function withTenant(
  sql: Sql,
  tenant: string,
  operation: (transaction: TransactionSql) => Promise<void>,
): Promise<void> {
  await sql.begin(async transaction => {
    await transaction`SELECT set_config('threadnote.tenant_id', ${tenant}, true)`;
    await operation(transaction);
  });
}

function aggregate(unknown = false) {
  return aggregateContextHealthReportsV1({
    project,
    teams: [
      unknown
        ? {reason: 'evidence-incomplete', scope: 'team', state: 'unknown', team: 'canonical'}
        : {
            evidenceRevision: '3'.repeat(64),
            report: report(),
            scope: 'team',
            state: 'complete',
            team: 'canonical',
          },
    ],
  });
}

function report(): ContextHealthReportV1 {
  return {
    findings: [],
    limit: 100,
    omittedFindings: 0,
    project,
    recordsScanned: 2,
    semanticCompleteness: {
      analyzedRecords: 2,
      claimsAnalyzed: 2,
      supportedClaims: 2,
      unsupportedClaims: 0,
      coverage: 'bounded-English-extraction',
      contradictionCount: 0,
      eligibleRecords: 2,
      omittedContradictions: 0,
      pairsCompared: 1,
      state: 'complete',
      unknownReasons: [],
      unknownRecords: 0,
      version: 2,
    },
    status: 'clean',
    version: 1,
  };
}
