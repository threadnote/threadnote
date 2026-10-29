import {Array as EffectArray} from 'effect';
import postgres, {type Sql} from 'postgres';
import {migrateRemoteMemoryDatabase} from '@threadnote/remote-memory/migrations';
import {randomUuidV4} from '@threadnote/threadnote/crypto/uuid';
import {createRemoteMemorySql} from '@threadnote/remote-memory/postgres/control_plane';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface RemoteMemoryPostgresFixture {
  readonly databaseName: string;
  readonly migratorRoleName: string;
  readonly migratorSql: Sql;
  readonly runtimeRoleName: string;
  readonly runtimeDatabaseUrl: string;
  readonly sql: Sql;
  readonly dispose: () => Promise<void>;
}

/**
 * Creates an isolated database owned and migrated by a non-superuser migrator.
 * Service code uses a separate non-owner, non-bypass runtime role with only the
 * table privileges required by the deployed control plane and data plane.
 */
export async function createRemoteMemoryPostgresFixture(databaseUrl: string): Promise<RemoteMemoryPostgresFixture> {
  const suffix = Effect.pipe(randomUuidV4(), EffectString.replaceAll('-', ''), EffectString.slice(0, 24));
  const databaseName = `tn_remote_${suffix}`;
  const migratorRoleName = `tn_remote_migrator_${suffix}`;
  const migratorRolePassword = Effect.pipe(randomUuidV4(), EffectString.replaceAll('-', ''));
  const runtimeRoleName = `tn_remote_runtime_${suffix}`;
  const runtimeRolePassword = Effect.pipe(randomUuidV4(), EffectString.replaceAll('-', ''));
  const maintenanceSql = postgres(databaseUrl, {max: 1, onnotice: () => undefined});
  let migratorSql: Sql | undefined;
  let sql: Sql | undefined;
  let databaseCreated = false;
  let migratorRoleCreated = false;
  let runtimeRoleCreated = false;

  try {
    await maintenanceSql.unsafe(
      `CREATE ROLE ${quoteIdentifier(migratorRoleName)} LOGIN PASSWORD ${quoteLiteral(migratorRolePassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    migratorRoleCreated = true;
    await maintenanceSql.unsafe(
      `CREATE ROLE ${quoteIdentifier(runtimeRoleName)} LOGIN PASSWORD ${quoteLiteral(runtimeRolePassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    runtimeRoleCreated = true;
    await maintenanceSql.unsafe(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(migratorRoleName)}`,
    );
    databaseCreated = true;

    const migratorUrl = roleDatabaseUrl(databaseUrl, databaseName, migratorRoleName, migratorRolePassword);
    migratorSql = createRemoteMemorySql(migratorUrl);
    await migrateRemoteMemoryDatabase(migratorSql);
    await grantRuntimePrivileges(migratorSql, databaseName, runtimeRoleName);

    const runtimeUrl = roleDatabaseUrl(databaseUrl, databaseName, runtimeRoleName, runtimeRolePassword);
    sql = createRemoteMemorySql(runtimeUrl);

    return {
      databaseName,
      migratorRoleName,
      migratorSql,
      runtimeRoleName,
      runtimeDatabaseUrl: runtimeUrl,
      sql,
      dispose: async () => {
        await sql?.end({timeout: 5});
        await migratorSql?.end({timeout: 5});
        await dropDatabaseAndRoles(maintenanceSql, databaseName, {
          databaseCreated,
          migratorRoleCreated,
          migratorRoleName,
          runtimeRoleCreated,
          runtimeRoleName,
        });
        await maintenanceSql.end({timeout: 5});
      },
    };
  } catch (cause) {
    await sql?.end({timeout: 1}).catch(() => undefined);
    await migratorSql?.end({timeout: 1}).catch(() => undefined);
    await dropDatabaseAndRoles(maintenanceSql, databaseName, {
      databaseCreated,
      migratorRoleCreated,
      migratorRoleName,
      runtimeRoleCreated,
      runtimeRoleName,
    }).catch(() => undefined);
    await maintenanceSql.end({timeout: 1}).catch(() => undefined);
    throw cause;
  }
}

async function grantRuntimePrivileges(migratorSql: Sql, databaseName: string, runtimeRoleName: string): Promise<void> {
  const runtimeRole = quoteIdentifier(runtimeRoleName);
  await migratorSql.unsafe(`REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`);
  await migratorSql.unsafe(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${runtimeRole}`);
  await migratorSql.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await migratorSql.unsafe('REVOKE ALL PRIVILEGES ON SCHEMA remote_memory FROM PUBLIC');
  await migratorSql.unsafe('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA remote_memory FROM PUBLIC');
  await migratorSql.unsafe(`REVOKE CREATE ON SCHEMA remote_memory FROM ${runtimeRole}`);
  await migratorSql.unsafe(`GRANT USAGE ON SCHEMA remote_memory TO ${runtimeRole}`);
  await migratorSql.unsafe(
    `GRANT EXECUTE ON FUNCTION remote_memory.lock_context_health_target(text, text, text, text) TO ${runtimeRole}`,
  );

  // Keep this matrix in lockstep with deploy/remote-memory/grants/001-runtime.sql.
  const tablePrivileges = [
    {
      privileges: 'SELECT',
      tables: [
        'share_directory',
        'challenge_directory',
        'worker_health',
        'tenant_memberships',
        'shares',
        'share_grants',
        'projects',
        'grant_policy_versions',
        'share_policy_versions',
        'project_repository_bindings',
        'memory_heads',
        'workload_attestations',
        'attestation_challenges',
        'memory_revisions',
        'idempotency_records',
        'outbox_events',
        'rate_limit_windows',
        'uri_aliases',
        'search_documents',
        'code_link_backlinks',
        'durable_memory_proposals',
        'context_health_policies',
        'context_health_schedules',
        'context_health_receipts',
        'context_health_due_directory',
        'context_health_worker_state',
      ],
    },
    {
      privileges: 'INSERT',
      tables: [
        'challenge_directory',
        'memory_heads',
        'workload_attestations',
        'attestation_challenges',
        'memory_revisions',
        'idempotency_records',
        'outbox_events',
        'audit_events',
        'rate_limit_windows',
        'search_documents',
        'code_link_backlinks',
        'projects',
        'durable_memory_proposals',
        'context_health_receipts',
      ],
    },
    {
      privileges: 'DELETE',
      tables: ['challenge_directory', 'attestation_challenges', 'uri_aliases', 'code_link_backlinks'],
    },
  ] as const;
  for (const grant of tablePrivileges) {
    const tables = EffectArray.join(
      EffectArray.map(grant.tables, table => `remote_memory.${quoteIdentifier(table)}`),
      ', ',
    );
    await migratorSql.unsafe(`GRANT ${grant.privileges} ON TABLE ${tables} TO ${runtimeRole}`);
  }
  const selectGrants = [
    {columns: ['id', 'status'], table: 'tenants'},
    {columns: ['tenant_id', 'id', 'status'], table: 'principals'},
    {columns: ['tenant_id', 'issuer', 'subject', 'client_id', 'principal_id'], table: 'external_identities'},
  ] as const;
  for (const grant of selectGrants) {
    const columns = EffectArray.join(EffectArray.map(grant.columns, quoteIdentifier), ', ');
    await migratorSql.unsafe(
      `GRANT SELECT (${columns}) ON TABLE remote_memory.${quoteIdentifier(grant.table)} TO ${runtimeRole}`,
    );
  }
  const updateGrants = [
    {
      columns: [
        'next_due_at',
        'consecutive_failures',
        'consecutive_stale_runs',
        'last_attempt_at',
        'last_success_at',
        'last_success_receipt_id',
        'last_failure_at',
        'last_failure_receipt_id',
        'updated_at',
      ],
      table: 'context_health_schedules',
    },
    {
      columns: ['next_due_at', 'claim_token', 'claim_expires_at', 'claim_generation', 'updated_at'],
      table: 'context_health_due_directory',
    },
    {
      columns: [
        'heartbeat_at',
        'last_success_at',
        'last_failure_at',
        'failure_class',
        'backlog_depth',
        'scheduler_lag_minutes',
        'tenant_cursor_ordinal',
        'generation',
        'updated_at',
      ],
      table: 'context_health_worker_state',
    },
    {
      columns: [
        'share_generation',
        'indexed_generation',
        'git_ingest_snapshot_commit',
        'git_ingest_cursor',
        'git_ingest_rejected_path',
      ],
      table: 'shares',
    },
    {
      columns: ['current_revision_id', 'status', 'retention_class', 'expires_at', 'updated_at'],
      table: 'memory_heads',
    },
    {
      columns: ['issuer', 'subject', 'jwt_id', 'cloud_agent_id', 'turn_id', 'team_id', 'owner_id', 'repository_urls'],
      table: 'workload_attestations',
    },
    {columns: ['attempts', 'consumed_at'], table: 'attestation_challenges'},
    {columns: ['outcome'], table: 'idempotency_records'},
    {
      columns: [
        'heartbeat_at',
        'last_success_at',
        'last_failure_at',
        'failure_class',
        'pending_work',
        'oldest_pending_at',
        'updated_at',
      ],
      table: 'worker_health',
    },
    {
      columns: ['attempts', 'available_at', 'processed_at', 'dead_lettered_at', 'last_error_class'],
      table: 'outbox_events',
    },
    {columns: ['window_started_at', 'request_count'], table: 'rate_limit_windows'},
    {
      columns: ['revision_id', 'generation', 'project', 'topic', 'kind', 'searchable', 'updated_at'],
      table: 'search_documents',
    },
    {
      columns: [
        'status',
        'payload',
        'payload_purged_at',
        'decision_kind',
        'decision_operation_id',
        'decision_request_hash',
        'reviewer_principal_id',
        'reviewer_workload_attestation_id',
        'decision_claimed_at',
        'approval_revision_id',
        'approval_source_agent_client',
        'decision_reason',
        'result_receipt',
        'reviewed_at',
      ],
      table: 'durable_memory_proposals',
    },
  ] as const;
  for (const grant of updateGrants) {
    const columns = EffectArray.join(EffectArray.map(grant.columns, quoteIdentifier), ', ');
    await migratorSql.unsafe(
      `GRANT UPDATE (${columns}) ON TABLE remote_memory.${quoteIdentifier(grant.table)} TO ${runtimeRole}`,
    );
  }
}

async function dropDatabaseAndRoles(
  maintenanceSql: Sql,
  databaseName: string,
  state: Readonly<{
    databaseCreated: boolean;
    migratorRoleCreated: boolean;
    migratorRoleName: string;
    runtimeRoleCreated: boolean;
    runtimeRoleName: string;
  }>,
): Promise<void> {
  if (state.databaseCreated) {
    await maintenanceSql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  }
  if (state.runtimeRoleCreated) {
    await maintenanceSql.unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(state.runtimeRoleName)}`);
  }
  if (state.migratorRoleCreated) {
    await maintenanceSql.unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(state.migratorRoleName)}`);
  }
}

function roleDatabaseUrl(databaseUrl: string, databaseName: string, roleName: string, rolePassword: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  url.username = roleName;
  url.password = rolePassword;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new TypeError('Unsafe PostgreSQL test identifier.');
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  if (!/^[a-f0-9]{32}$/u.test(value)) throw new TypeError('Unsafe PostgreSQL test literal.');
  return `'${value}'`;
}
