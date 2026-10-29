import {Array as EffectArray} from 'effect';
import {assertHostedContextCiWorkerPrivileges} from '@threadnote/remote-memory/runtime_privileges';
import {controlHostedContextCi} from '@threadnote/remote-memory/hosted/context_ci_control';
import postgres, {type Sql} from 'postgres';
import fc from 'fast-check';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {randomUuidV4} from '@threadnote/threadnote/crypto/uuid';
import {buildHostedContextCiPolicyV1, type HostedContextCiPolicyV1} from '@threadnote/remote-memory/hosted/context_ci';
import {
  archiveHostedContextCiJobs,
  initializeHostedContextCiStorage,
  enqueueHostedContextCiWebhook,
  registerHostedContextCiTarget,
  runHostedContextCiOperator,
  setHostedContextCiEnabled,
  setHostedContextCiOptIn,
} from '@threadnote/remote-memory/hosted/context_ci_postgres';
import type {
  HostedContextCiReadIdentityV1,
  HostedContextCiPublicationIdentityV1,
} from '@threadnote/remote-memory/hosted/context_ci_operator';
import {PostgresRemoteControlPlane} from '@threadnote/remote-memory/postgres/control_plane';
import {
  createRemoteMemoryPostgresFixture,
  type RemoteMemoryPostgresFixture,
} from '../helpers/remote-memory-postgres.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const databaseUrl = process.env.THREADNOTE_TEST_POSTGRES_URL;
const webhookKey = 'test-only-webhook-key-at-least-thirty-two-bytes';
const event = {
  version: 1,
  kind: 'pull_request',
  trusted: true,
  installationId: 'installation',
  repositoryId: 'repository',
  headRepositoryId: 'repository',
  ref: 'refs/heads/feature',
  baseRef: 'refs/heads/main',
  headCommit: Effect.pipe('a', EffectString.repeat(40)),
  baseCommit: Effect.pipe('b', EffectString.repeat(40)),
};
const rawReport = JSON.stringify({
  version: 1,
  project: 'project',
  evidenceStatus: 'complete',
  exitClassification: 'clean',
  exitCode: 0,
  findings: [],
  limit: 100,
  omittedFindings: 0,
});

(databaseUrl ? describe : describe.skip)('hosted Context CI PostgreSQL boundary', () => {
  let database: RemoteMemoryPostgresFixture;
  let admin: Sql;
  let worker: Sql;
  let role: string;
  const workerQueries: string[] = [];
  beforeAll(async () => {
    database = await createRemoteMemoryPostgresFixture(databaseUrl!);
    admin = postgres(databaseUrl!, {max: 1, onnotice: () => undefined});
    role = `tn_ci_${Effect.pipe(randomUuidV4(), EffectString.replaceAll('-', ''))}`;
    const password = Effect.pipe(randomUuidV4(), EffectString.replaceAll('-', ''));
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${database.databaseName} TO ${role}`);
    const grants = Effect.pipe(
      await Bun.file('deploy/remote-memory/grants/003-context-ci-worker.sql').text(),
      EffectString.replace(/^\\set .*$/gm, ''),
      EffectString.replaceAll('threadnote_context_ci_worker', role),
    );
    await database.migratorSql.unsafe(grants);
    const url = new URL(databaseUrl!);
    url.pathname = `/${database.databaseName}`;
    url.username = role;
    url.password = password;
    worker = postgres(url.toString(), {
      max: 4,
      onnotice: () => undefined,
      debug: (_connection, query) => {
        workerQueries.push(query);
      },
    });
    await controlHostedContextCi(database.migratorSql, {action: 'enable', enabled: true});
  });
  afterAll(async () => {
    await worker?.end({timeout: 5});
    await database?.dispose();
    if (role) await admin?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin?.end({timeout: 5});
  });

  async function target(tenantId: string, limits: {queueLimit?: number; requestsPerMinute?: number} = {}) {
    await new PostgresRemoteControlPlane(database.migratorSql).provision({
      capabilities: ['memory:read'],
      clientId: 'client',
      cursorAttestationRequired: false,
      displayName: 'Context CI test',
      issuer: 'https://identity.example.test/oidc',
      policyVersion: 'reader-v1',
      principalId: 'reader',
      projects: ['project'],
      region: 'test',
      repositoryBindings: {project: ['https://git.example.test/repository.git']},
      shareId: `${tenantId}-share`,
      sharePolicyVersion: 'share-v1',
      subject: 'subject',
      tenantId,
    });
    const policy = buildHostedContextCiPolicyV1({
      tenantId,
      shareId: `${tenantId}-share`,
      project: 'project',
      source: 'gateway',
      installationId: 'installation',
      repositoryId: 'repository',
      refs: ['refs/heads/feature'],
      baseRefs: ['refs/heads/main'],
      readerIdentity: 'reader',
      publisherIdentity: 'publisher',
      queueLimit: limits.queueLimit ?? 10,
      requestsPerMinute: limits.requestsPerMinute ?? 10,
      maxAttempts: 3,
    });
    await registerHostedContextCiTarget(database.migratorSql, policy);
    await setHostedContextCiOptIn(database.migratorSql, tenantId, 'repository', true);
    return policy;
  }
  function enqueue(policy: HostedContextCiPolicyV1, patch: Record<string, unknown> = {}) {
    const body = JSON.stringify({...event, ...patch});
    const timestamp = String(Date.now());
    const signature = new Bun.CryptoHasher('sha256', webhookKey)
      .update(JSON.stringify(['gateway', 'delivery', timestamp, body]))
      .digest('hex');
    return enqueueHostedContextCiWebhook(worker, {
      tenantId: policy.tenantId,
      repositoryId: policy.repositoryId,
      webhookKey,
      webhook: {source: 'gateway', deliveryId: 'delivery', timestamp, body, signature},
    });
  }
  function identities() {
    const reader: HostedContextCiReadIdentityV1 = {
      identity: 'reader',
      capabilities: ['repository:read', 'context:check'],
      resolve: vi.fn(async () => event),
      evaluate: vi.fn(async () => rawReport),
    };
    const publisher: HostedContextCiPublicationIdentityV1 = {
      identity: 'publisher',
      capabilities: ['checks:publish'],
      publish: vi.fn(async input => ({publicationId: 'provider-secret-looking-id', digest: input.diagnostics.digest})),
    };
    return {reader, publisher};
  }

  it('keeps the admission count covered by the live-tenant partial index', async () => {
    const [index] = await database.migratorSql<{columns: string[]; predicate: string}[]>`
      SELECT array(
        SELECT attribute.attname
        FROM unnest(pg_index.indkey) WITH ORDINALITY AS key(attnum, ordinal)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = pg_index.indrelid AND attribute.attnum = key.attnum
        ORDER BY key.ordinal
      ) AS columns,
      pg_get_expr(pg_index.indpred, pg_index.indrelid) AS predicate
      FROM pg_index
      JOIN pg_class ON pg_class.oid = pg_index.indexrelid
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_namespace.nspname = 'remote_memory'
        AND pg_class.relname = 'context_ci_jobs_live_tenant'
    `;
    expect(index).toEqual({columns: ['tenant_id'], predicate: "(stage <> 'archived'::text)"});
  });

  it('keeps steady-state admission and polling free of catalog preflight scans', async () => {
    const policy = await target('ci-preflight');
    await initializeHostedContextCiStorage(worker);
    workerQueries.length = 0;
    await enqueue(policy);
    await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader: identities().reader});
    await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader: identities().reader});
    expect(workerQueries.length).toBeGreaterThan(0);
    expect(EffectArray.join(workerQueries, '\n')).not.toMatch(/pg_class|pg_proc|pg_roles|has_table_privilege/u);
  });

  it.each([
    ['memory-body SELECT', 'SELECT (markdown_body)', 'memory_revisions'],
    ['target opt-in UPDATE', 'UPDATE (opted_in)', 'context_ci_targets'],
    ['receipt DELETE', 'DELETE', 'context_ci_receipts'],
  ])('rejects precise privilege drift: %s', async (_name, privilege, table) => {
    await initializeHostedContextCiStorage(worker);
    await database.migratorSql.unsafe(`GRANT ${privilege} ON remote_memory.${table} TO ${role}`);
    try {
      await expect(initializeHostedContextCiStorage(worker)).rejects.toMatchObject({
        details: {reason: 'unsafe_context_ci_worker_database_role'},
      });
      await expect(
        runHostedContextCiOperator(worker, {tenantId: 'ci-drift', reader: identities().reader}),
      ).rejects.toMatchObject({details: {reason: 'unsafe_context_ci_worker_database_role'}});
    } finally {
      await database.migratorSql.unsafe(`REVOKE ${privilege} ON remote_memory.${table} FROM ${role}`);
    }
    await expect(initializeHostedContextCiStorage(worker)).resolves.toBeUndefined();
  });

  it('rejects same-signature lifecycle helper body drift and accepts its restoration', async () => {
    const [original] = await database.migratorSql<{definition: string}[]>`
      SELECT pg_get_functiondef('remote_memory.lock_context_ci_target(text,text)'::regprocedure) AS definition
    `;
    await database.migratorSql.unsafe(`CREATE OR REPLACE FUNCTION remote_memory.lock_context_ci_target(
      requested_tenant text, requested_repository text) RETURNS boolean LANGUAGE plpgsql
      SECURITY DEFINER SET search_path = pg_catalog AS $$ BEGIN RETURN true; END; $$`);
    try {
      await expect(initializeHostedContextCiStorage(worker)).rejects.toMatchObject({
        details: {reason: 'unsafe_context_ci_worker_database_role'},
      });
    } finally {
      await database.migratorSql.unsafe(original.definition);
    }
    await expect(initializeHostedContextCiStorage(worker)).resolves.toBeUndefined();
  });

  it('serializes distinct due jobs across replicas while the tenant lease is held', async () => {
    const policy = await target('ci-lease');
    await enqueue(policy);
    await enqueue(policy, {headCommit: Effect.pipe('c', EffectString.repeat(40))});
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const {reader} = identities();
    vi.mocked(reader.resolve).mockImplementation(async job => ({...event, ...job.event}));
    vi.mocked(reader.evaluate).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return rawReport;
    });
    const first = runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader});
    try {
      await entered.promise;
      expect(await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader})).toBeUndefined();
      expect(reader.evaluate).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    const firstReceipt = await first;
    const secondReceipt = await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader});
    expect(firstReceipt?.status).toBe('evaluated');
    expect(secondReceipt?.status).toBe('evaluated');
    expect(firstReceipt?.jobId).not.toBe(secondReceipt?.jobId);
    expect(reader.evaluate).toHaveBeenCalledTimes(2);
  });

  it('archives terminal jobs into immutable replay tombstones and reclaims queue capacity', async () => {
    const policy = await target('ci-archive', {queueLimit: 1});
    const admitted = await enqueue(policy);
    const {reader, publisher} = identities();
    expect(await archiveHostedContextCiJobs(database.migratorSql, policy.tenantId, policy.repositoryId)).toBe(0);
    await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader});
    await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher});
    expect(await enqueue(policy, {headCommit: Effect.pipe('c', EffectString.repeat(40))})).toEqual({
      status: 'queue-full',
    });
    await expect(archiveHostedContextCiJobs(worker, policy.tenantId, policy.repositoryId)).rejects.toThrow();
    expect(
      await controlHostedContextCi(database.migratorSql, {
        action: 'archive',
        tenantId: policy.tenantId,
        repositoryId: policy.repositoryId,
      }),
    ).toEqual({version: 1, status: 'archived', count: 1});
    expect(await archiveHostedContextCiJobs(database.migratorSql, policy.tenantId, policy.repositoryId)).toBe(0);
    expect(await enqueue(policy)).toEqual({status: 'replay', jobId: admitted.jobId});
    expect(await enqueue(policy, {headCommit: Effect.pipe('c', EffectString.repeat(40))})).toMatchObject({
      status: 'accepted',
    });
    await worker.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${policy.tenantId}, true)`;
      const [tombstone] = await transaction`SELECT stage, job, diagnostics, archived_outcome
        FROM remote_memory.context_ci_jobs WHERE tenant_id = ${policy.tenantId} AND job_id = ${admitted.jobId!}`;
      expect(tombstone).toEqual({stage: 'archived', job: null, diagnostics: null, archived_outcome: 'published'});
      expect(
        await transaction`SELECT attempt FROM remote_memory.context_ci_receipts
        WHERE tenant_id = ${policy.tenantId} AND job_id = ${admitted.jobId!}`,
      ).toHaveLength(2);
    });
    await expect(
      worker.begin(async transaction => {
        await transaction`SELECT set_config('threadnote.tenant_id', ${policy.tenantId}, true)`;
        await transaction`UPDATE remote_memory.context_ci_jobs SET stage = 'queued'
        WHERE tenant_id = ${policy.tenantId} AND job_id = ${admitted.jobId!}`;
      }),
    ).rejects.toThrow();
  });

  it('preserves replay and archive idempotence for bounded terminal/live job mixtures', async () => {
    let example = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('queued', 'evaluated', 'published', 'failed'), {minLength: 1, maxLength: 5}),
        async stages => {
          const policy = await target(`ci-archive-property-${example++}`);
          for (const [index, stage] of stages.entries()) {
            const admitted = await enqueue(policy, {
              headCommit: Effect.pipe(index.toString(16), EffectString.padStart(40, '0')),
            });
            await worker.begin(async transaction => {
              await transaction`SELECT set_config('threadnote.tenant_id', ${policy.tenantId}, true)`;
              await transaction`UPDATE remote_memory.context_ci_jobs SET stage = ${stage}
              WHERE tenant_id = ${policy.tenantId} AND job_id = ${admitted.jobId!}`;
            });
          }
          const terminalCount = EffectArray.filter(stages, stage => stage === 'published' || stage === 'failed').length;
          expect(await archiveHostedContextCiJobs(database.migratorSql, policy.tenantId, policy.repositoryId)).toBe(
            terminalCount,
          );
          expect(await archiveHostedContextCiJobs(database.migratorSql, policy.tenantId, policy.repositoryId)).toBe(0);
          for (const index of stages.keys()) {
            expect(
              await enqueue(policy, {headCommit: Effect.pipe(index.toString(16), EffectString.padStart(40, '0'))}),
            ).toMatchObject({
              status: 'replay',
            });
          }
        },
      ),
      {numRuns: 8},
    );
  });

  it('deduplicates concurrent deliveries, persists evaluation before publication, and isolates tenants', async () => {
    await expect(assertHostedContextCiWorkerPrivileges(worker)).resolves.toBeUndefined();
    await expect(assertHostedContextCiWorkerPrivileges(database.migratorSql)).rejects.toMatchObject({
      details: {reason: 'unsafe_context_ci_worker_database_role'},
    });
    const policy = await target('ci-main');
    const other = await target('ci-other');
    const admitted = await Promise.all([enqueue(policy), enqueue(policy)]);
    expect(EffectArray.map(admitted, result => result.status).sort()).toEqual(['accepted', 'replay']);
    expect(await enqueue(other)).toMatchObject({status: 'accepted'});
    expect((await enqueue(other)).jobId).not.toBe(admitted[0].jobId);
    const {reader, publisher} = identities();
    const attempts = await Promise.all([
      runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader}),
      runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader}),
    ]);
    expect(EffectArray.filter(attempts, Boolean)).toHaveLength(1);
    expect(EffectOption.getOrUndefined(EffectArray.findFirst(attempts, Boolean))?.status).toBe('evaluated');
    expect(publisher.publish).not.toHaveBeenCalled();
    const published = await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher});
    expect(published).toMatchObject({status: 'published', attempt: 2});
    expect(JSON.stringify(published)).not.toContain('provider-secret-looking-id');
    expect(await enqueue(policy, {kind: 'rerun'})).toMatchObject({status: 'replay'});
    expect(await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher})).toBeUndefined();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    await worker.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${policy.tenantId}, true)`;
      const invisible =
        await transaction`SELECT job_id FROM remote_memory.context_ci_jobs WHERE tenant_id = ${other.tenantId}`;
      expect(invisible).toHaveLength(0);
    });
    await expect(worker`SELECT markdown_body FROM remote_memory.memory_revisions`).rejects.toThrow();
    await expect(worker`UPDATE remote_memory.context_ci_control SET enabled = false`).rejects.toThrow();
  });

  it('denies forks and opt-out, stops publication on rollback, and resumes the saved evaluation', async () => {
    const policy = await target('ci-stop');
    const {reader, publisher} = identities();
    expect(await enqueue(policy, {headRepositoryId: 'fork'})).toEqual({status: 'denied'});
    expect(await enqueue(policy)).toMatchObject({status: 'accepted'});
    expect(await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader})).toMatchObject({
      status: 'evaluated',
    });
    await setHostedContextCiOptIn(database.migratorSql, policy.tenantId, policy.repositoryId, false);
    expect(await enqueue(policy)).toEqual({status: 'denied'});
    expect(await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher})).toBeUndefined();
    await setHostedContextCiOptIn(database.migratorSql, policy.tenantId, policy.repositoryId, true);
    await setHostedContextCiEnabled(database.migratorSql, false);
    expect(await enqueue(policy)).toEqual({status: 'denied'});
    expect(await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher})).toBeUndefined();
    expect(publisher.publish).not.toHaveBeenCalled();
    await setHostedContextCiEnabled(database.migratorSql, true);
    expect(await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher})).toMatchObject({
      status: 'published',
    });
    expect(reader.evaluate).toHaveBeenCalledTimes(1);
  });

  it('bounds queue storage and admission rate and records publication retry without raw failures', async () => {
    const bounded = await target('ci-bound', {queueLimit: 1});
    expect(await enqueue(bounded)).toMatchObject({status: 'accepted'});
    expect(await enqueue(bounded, {headCommit: Effect.pipe('c', EffectString.repeat(40))})).toEqual({
      status: 'queue-full',
    });
    const limited = await target('ci-rate', {requestsPerMinute: 1});
    expect(await enqueue(limited)).toMatchObject({status: 'accepted'});
    expect(await enqueue(limited, {headCommit: Effect.pipe('c', EffectString.repeat(40))})).toMatchObject({
      status: 'rate-limited',
    });
    const {reader, publisher} = identities();
    await runHostedContextCiOperator(worker, {tenantId: limited.tenantId, reader});
    vi.mocked(publisher.publish).mockRejectedValue(new Error('private-memory token=secret'));
    const failure = await runHostedContextCiOperator(worker, {tenantId: limited.tenantId, reader, publisher});
    expect(failure).toMatchObject({status: 'retry', reason: 'publication-unavailable', attempt: 2});
    expect(Date.parse(failure!.retryAt!)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(await runHostedContextCiOperator(worker, {tenantId: limited.tenantId, reader, publisher})).toBeUndefined();
  });
  it.each([false, true])('executes persisted publication retries (exhaustion=%s)', async exhaust => {
    const policy = await target(exhaust ? 'ci-exhaust' : 'ci-recover');
    const admitted = await enqueue(policy);
    const {reader, publisher} = identities();
    await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader});
    vi.mocked(publisher.publish).mockRejectedValueOnce(new Error('private failure'));
    if (exhaust) vi.mocked(publisher.publish).mockRejectedValue(new Error('private failure'));
    const first = await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher});
    expect(first).toMatchObject({attempt: 2, status: 'retry'});
    async function makeDue() {
      await worker.begin(async transaction => {
        await transaction`SELECT set_config('threadnote.tenant_id', ${policy.tenantId}, true)`;
        await transaction`UPDATE remote_memory.context_ci_jobs SET available_at = now()
          WHERE tenant_id = ${policy.tenantId} AND job_id = ${admitted.jobId!}`;
      });
    }
    await makeDue();
    let final = await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher});
    if (exhaust) {
      expect(final).toMatchObject({attempt: 3, status: 'retry'});
      await makeDue();
      final = await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher});
    }
    expect(final).toMatchObject({attempt: exhaust ? 4 : 3, status: exhaust ? 'failed' : 'published'});
    expect(await runHostedContextCiOperator(worker, {tenantId: policy.tenantId, reader, publisher})).toBeUndefined();
    expect(reader.evaluate).toHaveBeenCalledTimes(1);
    const calls = EffectArray.map(vi.mocked(publisher.publish).mock.calls, ([input]) => input);
    expect(calls).toHaveLength(exhaust ? 3 : 2);
    for (const call of calls) expect(call).toEqual(calls[0]);
    expect(calls[0].idempotencyKey).toBe(admitted.jobId);
    await worker.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${policy.tenantId}, true)`;
      const receipts = await transaction`SELECT receipt FROM remote_memory.context_ci_receipts
        WHERE tenant_id = ${policy.tenantId} AND job_id = ${admitted.jobId!} ORDER BY attempt`;
      expect(receipts).toHaveLength(exhaust ? 4 : 3);
      expect(receipts[1].receipt).toEqual(first);
      expect(receipts.at(-1)?.receipt).toEqual(final);
      expect(receipts[0].receipt.reportDigest).toBe(calls[0].diagnostics.digest);
    });
    await expect(
      database.migratorSql.begin(async transaction => {
        await transaction`SELECT set_config('threadnote.tenant_id', ${policy.tenantId}, true)`;
        await transaction`UPDATE remote_memory.context_ci_receipts SET receipt = '{}'::jsonb
        WHERE tenant_id = ${policy.tenantId} AND job_id = ${admitted.jobId!} AND attempt = 2`;
      }),
    ).rejects.toThrow();
  });
});
