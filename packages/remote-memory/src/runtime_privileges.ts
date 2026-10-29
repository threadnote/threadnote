import {Array as EffectArray} from 'effect';
import type {Sql, ISql} from 'postgres';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {remoteMemoryError} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface RuntimeGrant {
  readonly privilege: string;
  readonly tables: readonly string[];
  readonly columns?: readonly string[];
}

// Keep this boundary aligned with deploy/remote-memory/grants/001-runtime.sql.
const RUNTIME_GRANTS: readonly RuntimeGrant[] = [
  {
    privilege: 'SELECT',
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
      'durable_memory_proposals',
      'code_link_backlinks',
    ],
  },
  {
    privilege: 'SELECT',
    tables: ['tenants'],
    columns: ['id', 'status'],
  },
  {
    privilege: 'SELECT',
    tables: ['principals'],
    columns: ['tenant_id', 'id', 'status'],
  },
  {
    privilege: 'SELECT',
    tables: ['external_identities'],
    columns: ['tenant_id', 'issuer', 'subject', 'client_id', 'principal_id'],
  },
  {
    privilege: 'INSERT',
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
      'projects',
      'durable_memory_proposals',
      'code_link_backlinks',
    ],
  },
  {
    privilege: 'UPDATE',
    tables: ['shares'],
    columns: [
      'share_generation',
      'indexed_generation',
      'git_ingest_snapshot_commit',
      'git_ingest_cursor',
      'git_ingest_rejected_path',
    ],
  },
  {
    privilege: 'UPDATE',
    tables: ['memory_heads'],
    columns: ['current_revision_id', 'status', 'retention_class', 'expires_at', 'updated_at'],
  },
  {
    privilege: 'UPDATE',
    tables: ['workload_attestations'],
    columns: ['issuer', 'subject', 'jwt_id', 'cloud_agent_id', 'turn_id', 'team_id', 'owner_id', 'repository_urls'],
  },
  {
    privilege: 'UPDATE',
    tables: ['attestation_challenges'],
    columns: ['attempts', 'consumed_at'],
  },
  {
    privilege: 'UPDATE',
    tables: ['idempotency_records'],
    columns: ['outcome'],
  },
  {
    privilege: 'UPDATE',
    tables: ['worker_health'],
    columns: [
      'heartbeat_at',
      'last_success_at',
      'last_failure_at',
      'failure_class',
      'pending_work',
      'oldest_pending_at',
      'updated_at',
    ],
  },
  {
    privilege: 'UPDATE',
    tables: ['outbox_events'],
    columns: ['attempts', 'available_at', 'processed_at', 'dead_lettered_at', 'last_error_class'],
  },
  {
    privilege: 'UPDATE',
    tables: ['rate_limit_windows'],
    columns: ['window_started_at', 'request_count'],
  },
  {
    privilege: 'UPDATE',
    tables: ['search_documents'],
    columns: ['revision_id', 'generation', 'project', 'topic', 'kind', 'searchable', 'updated_at'],
  },
  {
    privilege: 'UPDATE',
    tables: ['durable_memory_proposals'],
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
  },
  {
    privilege: 'DELETE',
    tables: ['challenge_directory', 'attestation_challenges', 'uri_aliases', 'code_link_backlinks'],
  },
];

// Keep this boundary aligned with deploy/remote-memory/grants/002-context-health-worker.sql.
const CONTEXT_HEALTH_WORKER_GRANTS: readonly RuntimeGrant[] = [
  {privilege: 'SELECT', tables: ['tenants'], columns: ['id', 'status']},
  {
    privilege: 'SELECT',
    tables: ['shares'],
    columns: ['tenant_id', 'id', 'status', 'git_ingest_snapshot_commit', 'share_generation'],
  },
  {
    privilege: 'SELECT',
    tables: ['projects'],
    columns: ['tenant_id', 'share_id', 'name', 'status'],
  },
  {
    privilege: 'SELECT',
    tables: ['project_repository_bindings'],
    columns: ['tenant_id', 'share_id', 'project_name'],
  },
  {
    privilege: 'SELECT',
    tables: ['memory_heads'],
    columns: ['tenant_id', 'share_id', 'id', 'kind', 'topic', 'current_revision_id', 'project', 'status'],
  },
  {
    privilege: 'SELECT',
    tables: ['memory_revisions'],
    columns: ['tenant_id', 'share_id', 'head_id', 'id', 'content_hash', 'git_commit', 'git_observed_commit'],
  },
  {
    privilege: 'SELECT',
    tables: ['context_health_policies'],
    columns: ['tenant_id', 'share_id', 'version', 'digest', 'policy_document'],
  },
  {
    privilege: 'SELECT',
    tables: ['context_health_schedules'],
    columns: [
      'tenant_id',
      'share_id',
      'project_name',
      'schedule_id',
      'cadence_minutes',
      'policy_version',
      'policy_digest',
      'status',
      'next_due_at',
      'consecutive_failures',
      'consecutive_stale_runs',
      'last_success_at',
      'last_success_receipt_id',
      'last_failure_at',
      'last_failure_receipt_id',
    ],
  },
  {
    privilege: 'SELECT',
    tables: ['context_health_receipts'],
    columns: ['tenant_id', 'schedule_id', 'input_digest', 'receipt'],
  },
  {
    privilege: 'SELECT',
    tables: ['context_health_due_directory'],
    columns: [
      'schedule_id',
      'tenant_id',
      'share_id',
      'project_name',
      'status',
      'next_due_at',
      'claim_token',
      'claim_expires_at',
      'claim_generation',
    ],
  },
  {
    privilege: 'SELECT',
    tables: ['context_health_worker_state'],
    columns: ['worker_name', 'generation', 'tenant_cursor_ordinal', 'last_success_at', 'last_failure_at'],
  },
  {
    privilege: 'INSERT',
    tables: ['context_health_receipts'],
    columns: [
      'tenant_id',
      'share_id',
      'project_name',
      'receipt_id',
      'schedule_id',
      'input_digest',
      'outcome',
      'receipt',
      'observed_at',
    ],
  },
  {
    privilege: 'UPDATE',
    tables: ['context_health_schedules'],
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
  },
  {
    privilege: 'UPDATE',
    tables: ['context_health_due_directory'],
    columns: ['next_due_at', 'claim_token', 'claim_expires_at', 'claim_generation', 'updated_at'],
  },
  {
    privilege: 'UPDATE',
    tables: ['context_health_worker_state'],
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
  },
];

const CONTEXT_HEALTH_LOCK_SOURCE = `
DECLARE target_present boolean;
BEGIN
  IF current_setting('threadnote.tenant_id', true) IS DISTINCT FROM requested_tenant_id THEN
    RETURN false;
  END IF;
  SELECT true INTO target_present
  FROM remote_memory.tenants t
  JOIN remote_memory.shares s ON s.tenant_id = t.id
  JOIN remote_memory.projects p ON p.tenant_id = s.tenant_id AND p.share_id = s.id
  JOIN remote_memory.context_health_schedules c
    ON c.tenant_id = p.tenant_id AND c.share_id = p.share_id AND c.project_name = p.name
  WHERE t.id = requested_tenant_id AND s.id = requested_share_id
    AND p.name = requested_project_name AND c.schedule_id = requested_schedule_id
    AND t.status = 'active' AND s.status = 'active' AND p.status = 'active' AND c.status = 'active'
  FOR UPDATE OF s
  FOR SHARE OF t, p, c;
  IF NOT coalesce(target_present, false) THEN
    RETURN false;
  END IF;
  PERFORM 1
  FROM remote_memory.memory_heads h
  JOIN remote_memory.memory_revisions r
    ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id
    AND r.head_id = h.id AND r.id = h.current_revision_id
  WHERE h.tenant_id = requested_tenant_id AND h.share_id = requested_share_id
    AND h.project = requested_project_name AND h.status = 'active'
  FOR SHARE OF h, r;
  RETURN true;
END;
`;

const CONTEXT_HEALTH_LOCK_IDENTITY = routineIdentityDigest({
  identityArguments:
    'requested_tenant_id text, requested_share_id text, requested_project_name text, requested_schedule_id text',
  kind: 'f',
  leakproof: false,
  parallel: 'u',
  result: 'boolean',
  returnsSet: false,
  source: CONTEXT_HEALTH_LOCK_SOURCE,
  strict: false,
  volatility: 'v',
});

interface GrantedPrivilege {
  readonly table_name: string;
  readonly column_name: string | null;
  readonly privilege: string;
  readonly can_delegate: boolean;
  readonly granted: boolean;
}

interface RuntimeRoutineContract {
  readonly can_delegate: boolean;
  readonly can_execute: boolean;
  readonly language: string;
  readonly identity_arguments: string;
  readonly kind: string;
  readonly leakproof: boolean;
  readonly owner_matches_schema: boolean;
  readonly parallel: string;
  readonly public_execute: boolean;
  readonly search_path: string[] | null;
  readonly security_definer: boolean;
  readonly result: string;
  readonly returns_set: boolean;
  readonly source: string;
  readonly strict: boolean;
  readonly unexpected_acl: boolean;
  readonly volatility: string;
}

/** Checks effective privileges, including PUBLIC grants, before accepting runtime traffic. */
export async function assertRemoteMemoryRuntimePrivileges(sql: Sql): Promise<void> {
  await assertPrivilegeContract(sql, RUNTIME_GRANTS, false, 'unsafe_runtime_database_role');
}

/** Checks the dedicated health worker's exact, content-free privilege boundary. */
export async function assertHostedContextHealthWorkerPrivileges(sql: Sql): Promise<void> {
  await assertPrivilegeContract(sql, CONTEXT_HEALTH_WORKER_GRANTS, true, 'unsafe_context_health_worker_database_role');
}

export async function assertHostedContextCiWorkerPrivileges(sql: Sql): Promise<void> {
  const reason = 'unsafe_context_ci_worker_database_role';
  await assertPrivilegeContract(
    sql,
    [
      {
        privilege: 'SELECT',
        tables: ['context_ci_targets', 'context_ci_jobs', 'context_ci_tenant_limits', 'context_ci_receipts'],
      },
      {privilege: 'INSERT', tables: ['context_ci_jobs', 'context_ci_receipts']},
      {privilege: 'UPDATE', tables: ['context_ci_tenant_limits'], columns: ['window_started_at', 'request_count']},
      {privilege: 'UPDATE', tables: ['context_ci_jobs'], columns: ['stage', 'attempts', 'available_at', 'diagnostics']},
    ],
    false,
    reason,
  );
  const routines = await sql.begin(async transaction => {
    await transaction`SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)`;
    return transaction<{name: string; safe: boolean; source: string}[]>`
    SELECT p.proname AS name, p.prosrc AS source,
      (p.prosecdef AND p.proowner = n.nspowner AND l.lanname = 'plpgsql'
        AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
        AND pg_get_function_identity_arguments(p.oid) = 'requested_tenant text, requested_repository text'
        AND pg_get_function_result(p.oid) = 'boolean'
        AND NOT has_function_privilege(current_user, p.oid, 'EXECUTE WITH GRANT OPTION')
        AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')) AS safe
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'remote_memory' AND p.prorettype <> 'trigger'::regtype
      AND has_function_privilege(current_user, p.oid, 'EXECUTE')
  `;
  });
  if (
    routines.length !== 1 ||
    routines[0].name !== 'lock_context_ci_target' ||
    !routines[0].safe ||
    sha256HexSync(Effect.pipe(routines[0].source, EffectString.trim, EffectString.replace(/\s+/gu, ' '))) !==
      CONTEXT_CI_LOCK_DIGEST
  ) {
    throw privilegeError(reason);
  }
}

// Normalized function-body SHA-256 from migration 009; reject replacement helpers with broader authority.
const CONTEXT_CI_LOCK_DIGEST = '6421729251fa3e89c9a54e270c3bef639c232cea79f1cadbaeaa85b25e5cb1f9';

async function assertPrivilegeContract(
  sql: Sql,
  grants: readonly RuntimeGrant[],
  requiresLifecycleLock: boolean,
  reason:
    | 'unsafe_context_health_worker_database_role'
    | 'unsafe_context_ci_worker_database_role'
    | 'unsafe_runtime_database_role',
): Promise<void> {
  await sql.begin(async transaction => {
    await transaction`SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)`;
    await transaction`SELECT set_config('statement_timeout', '5000', true)`;
    await transaction`SELECT set_config('transaction_timeout', '5000', true)`;
    await inspectPrivileges(transaction, grants, requiresLifecycleLock, reason);
  });
}

async function inspectPrivileges(
  sql: ISql,
  grants: readonly RuntimeGrant[],
  requiresLifecycleLock: boolean,
  reason:
    | 'unsafe_context_health_worker_database_role'
    | 'unsafe_context_ci_worker_database_role'
    | 'unsafe_runtime_database_role',
): Promise<void> {
  const [role] = await sql<{unsafe: boolean}[]>`
    SELECT (
      r.oid <> backend.usesysid OR current_user <> session_user
      OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
      OR current_setting('session_replication_role') <> 'origin'
      OR EXISTS (
        SELECT 1 FROM pg_parameter_acl p
        WHERE has_parameter_privilege(current_user, p.parname, 'SET, ALTER SYSTEM')
      )
      OR has_database_privilege(current_user, current_database(), 'CREATE')
      OR has_database_privilege(current_user, current_database(), 'CONNECT WITH GRANT OPTION')
      OR NOT has_schema_privilege(current_user, 'remote_memory', 'USAGE')
      OR has_schema_privilege(current_user, 'remote_memory', 'USAGE WITH GRANT OPTION')
      OR EXISTS (
        SELECT 1 FROM pg_roles other WHERE other.oid <> r.oid
          AND (pg_has_role(current_user, other.oid, 'USAGE')
            OR pg_has_role(current_user, other.oid, 'SET')
            OR pg_has_role(current_user, other.oid, 'MEMBER WITH ADMIN OPTION'))
      )
      OR EXISTS (
        SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public', 'remote_memory')
          AND (n.nspowner = r.oid OR has_schema_privilege(current_user, n.oid, 'CREATE'))
      )
      OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'remote_memory' AND c.relowner = r.oid
      )
    ) AS unsafe FROM pg_roles r
    JOIN pg_stat_activity backend ON backend.pid = pg_backend_pid()
    WHERE r.rolname = current_user
  `;
  if (!role || role.unsafe) throw privilegeError(reason);

  const columns = await sql<GrantedPrivilege[]>`
    SELECT c.relname AS table_name, a.attname AS column_name, p.privilege,
      has_column_privilege(current_user, c.oid, a.attnum, p.privilege) AS granted,
      has_column_privilege(current_user, c.oid, a.attnum, p.privilege || ' WITH GRANT OPTION') AS can_delegate
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
    WHERE n.nspname = 'remote_memory' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  `;
  const tables = await sql<GrantedPrivilege[]>`
    SELECT c.relname AS table_name, NULL::text AS column_name, p.privilege,
      has_table_privilege(current_user, c.oid, p.privilege) AS granted,
      has_table_privilege(current_user, c.oid, p.privilege || ' WITH GRANT OPTION') AS can_delegate
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN unnest(ARRAY['DELETE', 'TRUNCATE', 'TRIGGER', 'MAINTAIN']) AS p(privilege)
    WHERE n.nspname = 'remote_memory' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  `;
  const [sequences] = await sql<{unsafe: boolean}[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'remote_memory' AND c.relkind = 'S'
        AND has_sequence_privilege(current_user, c.oid, 'USAGE, SELECT, UPDATE')
    ) AS unsafe
  `;
  const [routine] = await sql<RuntimeRoutineContract[]>`
    SELECT
      has_function_privilege(current_user, p.oid, 'EXECUTE') AS can_execute,
      has_function_privilege(current_user, p.oid, 'EXECUTE WITH GRANT OPTION') AS can_delegate,
      pg_get_function_identity_arguments(p.oid) AS identity_arguments,
      p.prokind AS kind,
      l.lanname AS language,
      p.proleakproof AS leakproof,
      p.proowner = n.nspowner AS owner_matches_schema,
      p.proparallel AS parallel,
      p.proconfig AS search_path,
      p.prosecdef AS security_definer,
      pg_get_function_result(p.oid) AS result,
      p.proretset AS returns_set,
      p.prosrc AS source,
      p.proisstrict AS strict,
      p.provolatile AS volatility,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      ) AS public_execute,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.privilege_type = 'EXECUTE'
          AND acl.grantee NOT IN (p.proowner, (SELECT oid FROM pg_roles WHERE rolname = current_user))
      ) AS unexpected_acl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid = to_regprocedure('remote_memory.lock_context_health_target(text,text,text,text)')
  `;
  const presentTables = new Set(EffectArray.map(columns, column => column.table_name));
  const routineIdentity =
    routine &&
    routineIdentityDigest({
      identityArguments: routine.identity_arguments,
      kind: routine.kind,
      leakproof: routine.leakproof,
      parallel: routine.parallel,
      result: routine.result,
      returnsSet: routine.returns_set,
      source: routine.source,
      strict: routine.strict,
      volatility: routine.volatility,
    });
  if (
    sequences?.unsafe ||
    (requiresLifecycleLock
      ? !routine ||
        !routine.can_execute ||
        routine.can_delegate ||
        routine.public_execute ||
        routine.unexpected_acl ||
        !routine.owner_matches_schema ||
        !routine.security_definer ||
        routine.language !== 'plpgsql' ||
        routine.search_path?.length !== 1 ||
        routine.search_path?.[0] !== 'search_path=pg_catalog' ||
        routineIdentity !== CONTEXT_HEALTH_LOCK_IDENTITY
      : routine?.can_execute === true || routine?.can_delegate === true) ||
    EffectArray.some(grants, grant =>
      EffectArray.some(
        grant.tables,
        table =>
          !presentTables.has(table) ||
          (grant.columns === undefined
            ? false
            : EffectArray.some(
                grant.columns,
                column =>
                  !EffectArray.some(columns, actual => actual.table_name === table && actual.column_name === column),
              )),
      ),
    ) ||
    EffectArray.some([...columns, ...tables], privilege => privilege.granted !== grantAllows(grants, privilege))
  ) {
    throw privilegeError(reason);
  }
}

function grantAllows(grants: readonly RuntimeGrant[], privilege: GrantedPrivilege): boolean {
  if (privilege.can_delegate) return false;
  return EffectArray.some(
    grants,
    grant =>
      grant.privilege === privilege.privilege &&
      grant.tables.includes(privilege.table_name) &&
      (grant.columns === undefined ||
        (privilege.column_name !== null && grant.columns.includes(privilege.column_name))),
  );
}

function routineIdentityDigest(input: {
  readonly identityArguments: string;
  readonly kind: string;
  readonly leakproof: boolean;
  readonly parallel: string;
  readonly result: string;
  readonly returnsSet: boolean;
  readonly source: string;
  readonly strict: boolean;
  readonly volatility: string;
}): string {
  return sha256HexSync(
    canonicalJson({...input, source: Effect.pipe(input.source, EffectString.trim, EffectString.replace(/\s+/gu, ' '))}),
  );
}

function privilegeError(
  reason:
    | 'unsafe_context_health_worker_database_role'
    | 'unsafe_context_ci_worker_database_role'
    | 'unsafe_runtime_database_role',
) {
  return remoteMemoryError(
    'service_unavailable',
    'The database account does not match the required privilege contract. Use the dedicated role and versioned grants.',
    {reason},
  );
}
