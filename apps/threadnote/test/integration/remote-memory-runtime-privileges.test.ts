import postgres from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {
  createRemoteMemoryPostgresFixture,
  type RemoteMemoryPostgresFixture,
} from '../helpers/remote-memory-postgres.js';
import {randomUuidV4} from '@threadnote/threadnote/crypto/uuid';
import {
  assertHostedContextHealthWorkerPrivileges,
  assertRemoteMemoryRuntimePrivileges,
} from '@threadnote/remote-memory/runtime_privileges';
import {PostgresRemoteMemoryOperatorAdapter} from '@threadnote/remote-memory/operator/postgres';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const databaseUrl = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const excessGrants = [
  'UPDATE (status) ON remote_memory.shares',
  'SELECT ON remote_memory.audit_events',
  'UPDATE ON remote_memory.share_grants',
  'DELETE ON remote_memory.memory_revisions',
  'TRUNCATE ON remote_memory.memory_heads',
  'INSERT ON remote_memory.external_identities',
  'INSERT ON remote_memory.context_health_policies',
  'INSERT ON remote_memory.context_health_schedules',
  'UPDATE (status) ON remote_memory.context_health_schedules',
  'UPDATE (cadence_minutes) ON remote_memory.context_health_schedules',
] as const;

postgresDescribe('remote runtime database privilege preflight', () => {
  let fixture: RemoteMemoryPostgresFixture;
  let admin: ReturnType<typeof postgres>;
  let healthWorker: ReturnType<typeof postgres>;
  let healthWorkerRoleName: string;
  beforeAll(async () => {
    fixture = await createRemoteMemoryPostgresFixture(databaseUrl!);
    admin = postgres(databaseUrl!, {max: 1, onnotice: () => undefined});
    const grants = Effect.pipe(
      await Bun.file('deploy/remote-memory/grants/001-runtime.sql').text(),
      __effectPipeInput => {
        const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.replace(/^\\set .*$/gm, ''));
        const __effectPipeStage1 = Effect.pipe(
          __effectPipeStage0,
          EffectString.replaceAll('threadnote_remote_runtime', fixture.runtimeRoleName),
        );
        return __effectPipeStage1;
      },
    );
    await fixture.migratorSql.unsafe(grants);
    healthWorkerRoleName = Effect.pipe(
      fixture.runtimeRoleName,
      EffectString.replace('runtime', 'context_health_worker'),
    );
    const password = Effect.pipe(randomUuidV4(), EffectString.replaceAll('-', ''));
    await admin.unsafe(
      `CREATE ROLE ${healthWorkerRoleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${fixture.databaseName} TO ${healthWorkerRoleName}`);
    const healthGrants = Effect.pipe(
      await Bun.file('deploy/remote-memory/grants/002-context-health-worker.sql').text(),
      EffectString.replace(/^\\set .*$/gm, ''),
      EffectString.replaceAll('threadnote_context_health_worker', healthWorkerRoleName),
    );
    await fixture.migratorSql.unsafe(healthGrants);
    const healthUrl = new URL(databaseUrl!);
    healthUrl.pathname = `/${fixture.databaseName}`;
    healthUrl.username = healthWorkerRoleName;
    healthUrl.password = password;
    healthWorker = postgres(healthUrl.toString(), {max: 1, onnotice: () => undefined});
  });
  afterAll(async () => {
    await healthWorker?.end({timeout: 5});
    await fixture?.dispose();
    if (healthWorkerRoleName) await admin?.unsafe(`DROP ROLE IF EXISTS ${healthWorkerRoleName}`);
    await admin?.end({timeout: 5});
  });

  it('accepts the deployed table/column allowlist and reports every applied migration', async () => {
    await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).resolves.toBeUndefined();
    await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).resolves.toBeUndefined();
    await expect(
      new PostgresRemoteMemoryOperatorAdapter(healthWorker).assertContextHealthWorkerPrivileges(),
    ).resolves.toBeUndefined();
    await expect(
      new PostgresRemoteMemoryOperatorAdapter(fixture.sql).assertContextHealthWorkerPrivileges(),
    ).rejects.toMatchObject({details: {reason: 'unsafe_context_health_worker_database_role'}});
    const receipt = await new PostgresRemoteMemoryOperatorAdapter(fixture.migratorSql).migrateSchema();
    expect(receipt.readyVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('rejects the schema owner and the bootstrap superuser', async () => {
    await expect(assertRemoteMemoryRuntimePrivileges(fixture.migratorSql)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await expect(assertRemoteMemoryRuntimePrivileges(admin)).rejects.toMatchObject({code: 'service_unavailable'});
    await expect(
      new PostgresRemoteMemoryOperatorAdapter(fixture.migratorSql).assertContextHealthWorkerPrivileges(),
    ).rejects.toMatchObject({
      code: 'service_unavailable',
      details: {reason: 'unsafe_context_health_worker_database_role'},
    });
  });

  it('rejects routine ACL delegation, PUBLIC access, and security-definition drift', async () => {
    const routine = 'remote_memory.lock_context_health_target(text, text, text, text)';
    try {
      await fixture.migratorSql.unsafe(`REVOKE EXECUTE ON FUNCTION ${routine} FROM ${healthWorkerRoleName}`);
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(`GRANT EXECUTE ON FUNCTION ${routine} TO ${healthWorkerRoleName}`);
    }
    try {
      await fixture.migratorSql.unsafe(`GRANT EXECUTE ON FUNCTION ${routine} TO PUBLIC`);
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(`REVOKE ALL PRIVILEGES ON FUNCTION ${routine} FROM PUBLIC`);
    }
    try {
      await fixture.migratorSql.unsafe(
        `GRANT EXECUTE ON FUNCTION ${routine} TO ${healthWorkerRoleName} WITH GRANT OPTION`,
      );
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(
        `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${routine} FROM ${healthWorkerRoleName}`,
      );
    }
    try {
      await fixture.migratorSql.unsafe(`ALTER FUNCTION ${routine} SECURITY INVOKER`);
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(`ALTER FUNCTION ${routine} SECURITY DEFINER`);
    }
    try {
      await fixture.migratorSql.unsafe(`ALTER FUNCTION ${routine} SET search_path = public`);
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(`ALTER FUNCTION ${routine} SET search_path = pg_catalog`);
    }
    try {
      await fixture.migratorSql.unsafe(`ALTER FUNCTION ${routine} STABLE PARALLEL SAFE`);
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(`ALTER FUNCTION ${routine} VOLATILE PARALLEL UNSAFE`);
    }
    const adminUrl = new URL(databaseUrl!);
    adminUrl.pathname = `/${fixture.databaseName}`;
    const fixtureAdmin = postgres(adminUrl.toString(), {max: 1, onnotice: () => undefined});
    try {
      await fixtureAdmin.unsafe(`ALTER FUNCTION ${routine} OWNER TO ${healthWorkerRoleName}`);
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixtureAdmin.unsafe(`ALTER FUNCTION ${routine} OWNER TO ${fixture.migratorRoleName}`);
      await fixtureAdmin.unsafe(`REVOKE ALL PRIVILEGES ON FUNCTION ${routine} FROM PUBLIC`);
      await fixtureAdmin.unsafe(`REVOKE ALL PRIVILEGES ON FUNCTION ${routine} FROM ${healthWorkerRoleName}`);
      await fixtureAdmin.unsafe(`GRANT EXECUTE ON FUNCTION ${routine} TO ${healthWorkerRoleName}`);
      await fixtureAdmin.end({timeout: 5});
    }
    await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).resolves.toBeUndefined();
  });

  it('rejects lifecycle-lock body drift when its signature and catalog flags are unchanged', async () => {
    const migration = await Bun.file('packages/remote-memory/src/migrations/008_hosted_context_health.sql').text();
    const original = /CREATE FUNCTION remote_memory\.lock_context_health_target\([\s\S]*?\n\$\$;/u.exec(migration)?.[0];
    if (!original) throw new Error('Lifecycle-lock definition is missing from migration 8.');
    const replacement = Effect.pipe(original, EffectString.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
    const drifted = replacement.replace(/AS \$\$[\s\S]*?\n\$\$;/u, () => 'AS $$\nBEGIN\n  RETURN false;\nEND;\n$$;');
    const before = await lifecycleLockCatalogIdentity(fixture.migratorSql);
    try {
      await fixture.migratorSql.unsafe(drifted);
      expect(await lifecycleLockCatalogIdentity(fixture.migratorSql)).toEqual(before);
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(replacement);
    }
    await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).resolves.toBeUndefined();
  });

  it.each(['role', 'session_authorization', 'overridden-user'])(
    'rejects privileged authentication hidden by %s',
    async disguise => {
      const url = new URL(databaseUrl!);
      url.pathname = `/${fixture.databaseName}`;
      if (disguise === 'overridden-user') {
        url.searchParams.set('user', decodeURIComponent(url.username));
        url.username = fixture.runtimeRoleName;
      }
      url.searchParams.set('role', fixture.runtimeRoleName);
      const disguised = postgres(url.toString(), {max: 1, onnotice: () => undefined});
      try {
        if (disguise !== 'role') await disguised.unsafe(`SET SESSION AUTHORIZATION ${fixture.runtimeRoleName}`);
        const [identity] = await disguised`SELECT current_user AS name, session_user AS session_name`;
        expect(identity.name).toBe(fixture.runtimeRoleName);
        if (disguise !== 'role') expect(identity.session_name).toBe(fixture.runtimeRoleName);
        await expect(assertRemoteMemoryRuntimePrivileges(disguised)).rejects.toMatchObject({
          code: 'service_unavailable',
        });
      } finally {
        await disguised.end({timeout: 5});
      }
    },
  );

  it.each(['SET', 'ALTER SYSTEM'])('rejects %s parameter authority', async privilege => {
    try {
      await admin.unsafe(`GRANT ${privilege} ON PARAMETER session_replication_role TO ${fixture.runtimeRoleName}`);
      await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await admin.unsafe(`REVOKE ${privilege} ON PARAMETER session_replication_role FROM ${fixture.runtimeRoleName}`);
    }
    await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).resolves.toBeUndefined();
  });

  it('rejects a trigger-disabling role default even without a parameter grant', async () => {
    let unsafe: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe(`ALTER ROLE ${fixture.runtimeRoleName} SET session_replication_role = replica`);
      unsafe = postgres(fixture.runtimeDatabaseUrl, {max: 1, onnotice: () => undefined});
      const [setting] = await unsafe`SELECT current_setting('session_replication_role') AS value`;
      expect(setting.value).toBe('replica');
      await expect(assertRemoteMemoryRuntimePrivileges(unsafe)).rejects.toMatchObject({code: 'service_unavailable'});
    } finally {
      await unsafe?.end({timeout: 5});
      await admin.unsafe(`ALTER ROLE ${fixture.runtimeRoleName} RESET session_replication_role`);
    }
  });

  it('rejects missing write permissions before accepting traffic', async () => {
    try {
      await fixture.migratorSql.unsafe(
        `REVOKE INSERT ON remote_memory.memory_revisions FROM ${fixture.runtimeRoleName}`,
      );
      await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(`GRANT INSERT ON remote_memory.memory_revisions TO ${fixture.runtimeRoleName}`);
    }
  });

  it('keeps hosted-health control-plane mutations off the general runtime role', async () => {
    const [privileges] = await fixture.sql<
      {
        can_claim: boolean;
        can_insert_policy: boolean;
        can_insert_receipt: boolean;
        can_insert_schedule: boolean;
        can_pause_schedule: boolean;
      }[]
    >`
      SELECT
        has_column_privilege(current_user, 'remote_memory.context_health_due_directory', 'claim_token', 'UPDATE') AS can_claim,
        has_table_privilege(current_user, 'remote_memory.context_health_policies', 'INSERT') AS can_insert_policy,
        has_column_privilege(current_user, 'remote_memory.context_health_receipts', 'receipt_id', 'INSERT') AS can_insert_receipt,
        has_table_privilege(current_user, 'remote_memory.context_health_schedules', 'INSERT') AS can_insert_schedule,
        has_column_privilege(current_user, 'remote_memory.context_health_schedules', 'status', 'UPDATE') AS can_pause_schedule
    `;
    expect(privileges).toEqual({
      can_claim: false,
      can_insert_policy: false,
      can_insert_receipt: false,
      can_insert_schedule: false,
      can_pause_schedule: false,
    });
  });

  it('gives the dedicated health worker queue authority without memory or lifecycle mutation', async () => {
    const [privileges] = await healthWorker<
      {
        can_claim: boolean;
        can_insert_memory: boolean;
        can_insert_receipt: boolean;
        can_insert_schedule: boolean;
        can_pause_schedule: boolean;
        can_read_memory_body: boolean;
        can_read_memory_digest: boolean;
        can_update_memory: boolean;
        can_update_share_generation: boolean;
      }[]
    >`
      SELECT
        has_column_privilege(current_user, 'remote_memory.context_health_due_directory', 'claim_token', 'UPDATE') AS can_claim,
        has_column_privilege(current_user, 'remote_memory.context_health_receipts', 'receipt_id', 'INSERT') AS can_insert_receipt,
        has_table_privilege(current_user, 'remote_memory.context_health_schedules', 'INSERT') AS can_insert_schedule,
        has_column_privilege(current_user, 'remote_memory.context_health_schedules', 'status', 'UPDATE') AS can_pause_schedule,
        has_table_privilege(current_user, 'remote_memory.memory_revisions', 'INSERT') AS can_insert_memory,
        has_column_privilege(current_user, 'remote_memory.memory_revisions', 'markdown_body', 'SELECT') AS can_read_memory_body,
        has_column_privilege(current_user, 'remote_memory.memory_revisions', 'content_hash', 'SELECT') AS can_read_memory_digest,
        has_column_privilege(current_user, 'remote_memory.memory_heads', 'current_revision_id', 'UPDATE') AS can_update_memory,
        has_column_privilege(current_user, 'remote_memory.shares', 'share_generation', 'UPDATE') AS can_update_share_generation
    `;
    expect(privileges).toEqual({
      can_claim: true,
      can_insert_memory: false,
      can_insert_receipt: true,
      can_insert_schedule: false,
      can_pause_schedule: false,
      can_read_memory_body: false,
      can_read_memory_digest: true,
      can_update_memory: false,
      can_update_share_generation: false,
    });
    try {
      await fixture.migratorSql.unsafe(`GRANT INSERT ON remote_memory.memory_revisions TO ${healthWorkerRoleName}`);
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        details: {reason: 'unsafe_context_health_worker_database_role'},
      });
    } finally {
      await fixture.migratorSql.unsafe(`REVOKE INSERT ON remote_memory.memory_revisions FROM ${healthWorkerRoleName}`);
    }
    try {
      await fixture.migratorSql.unsafe(
        `GRANT USAGE ON SCHEMA remote_memory TO ${healthWorkerRoleName} WITH GRANT OPTION`,
      );
      await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).rejects.toMatchObject({
        details: {reason: 'unsafe_context_health_worker_database_role'},
      });
    } finally {
      await fixture.migratorSql.unsafe(
        `REVOKE GRANT OPTION FOR USAGE ON SCHEMA remote_memory FROM ${healthWorkerRoleName}`,
      );
    }
    await expect(assertHostedContextHealthWorkerPrivileges(healthWorker)).resolves.toBeUndefined();
  });

  it('rejects every bounded combination of excess runtime grants', async () => {
    await FC.assert(
      FC.asyncProperty(FC.uniqueArray(FC.constantFrom(...excessGrants), {minLength: 1, maxLength: 3}), async grants => {
        try {
          for (const grant of grants) await fixture.migratorSql.unsafe(`GRANT ${grant} TO ${fixture.runtimeRoleName}`);
          await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
            code: 'service_unavailable',
          });
        } finally {
          for (const grant of grants)
            await fixture.migratorSql.unsafe(`REVOKE ${grant} FROM ${fixture.runtimeRoleName}`);
        }
        await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).resolves.toBeUndefined();
      }),
      {numRuns: 10},
    );
  });

  it.each(['CREATEROLE', 'CREATEDB', 'BYPASSRLS', 'REPLICATION'])('rejects runtime %s authority', async attribute => {
    try {
      await admin.unsafe(`ALTER ROLE ${fixture.runtimeRoleName} ${attribute}`);
      await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await admin.unsafe(`ALTER ROLE ${fixture.runtimeRoleName} NO${attribute}`);
    }
  });

  it.each(['pg_write_all_data', 'pg_read_all_data', 'pg_read_server_files'])(
    'rejects a role it can assume: %s',
    async role => {
      try {
        await admin.unsafe(`GRANT ${role} TO ${fixture.runtimeRoleName} WITH INHERIT FALSE, SET TRUE`);
        await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
          code: 'service_unavailable',
        });
      } finally {
        await admin.unsafe(`REVOKE ${role} FROM ${fixture.runtimeRoleName}`);
      }
    },
  );

  it('rejects delegation of an otherwise allowed column privilege', async () => {
    try {
      await fixture.migratorSql.unsafe(
        `GRANT UPDATE (share_generation) ON remote_memory.shares TO ${fixture.runtimeRoleName} WITH GRANT OPTION`,
      );
      await expect(assertRemoteMemoryRuntimePrivileges(fixture.sql)).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await fixture.migratorSql.unsafe(
        `REVOKE GRANT OPTION FOR UPDATE (share_generation) ON remote_memory.shares FROM ${fixture.runtimeRoleName}`,
      );
    }
  });
});

async function lifecycleLockCatalogIdentity(sql: RemoteMemoryPostgresFixture['migratorSql']) {
  const [identity] = await sql`
    SELECT p.proowner, p.prosecdef, p.proconfig, p.provolatile, p.proparallel, p.proleakproof, p.proacl, p.prolang,
      pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_function_result(p.oid) AS result
    FROM pg_proc p
    WHERE p.oid = to_regprocedure('remote_memory.lock_context_health_target(text,text,text,text)')
  `;
  return identity;
}
