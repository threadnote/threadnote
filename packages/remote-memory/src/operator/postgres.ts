import {Array as EffectArray} from 'effect';
import {controlHostedContextCi} from '../hosted/context_ci_control.js';
import type {Sql, ISql} from 'postgres';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {randomUuidV4} from '@threadnote/platform/uuid';
import {parseRemoteShareAddress} from '@threadnote/memory/remote/address';
import {parseRemoteCanonicalMemoryDocument} from '@threadnote/memory/remote/content';
import {parseResourceId} from '@threadnote/store/resource-id';
import {migrateRemoteMemoryDatabase, remoteMemoryMigrationVersions} from '../migrations.js';
import {replaceRemoteCodeLinkBacklinks} from '../code_link_backlinks.js';
import {RemoteMemoryError} from '../errors.js';
import {
  claimHostedContextHealthJobs,
  completeHostedContextHealthCycle,
  failHostedContextHealthClaim,
  recordHostedContextHealthRun,
  registerHostedContextHealthSchedule,
  setHostedContextHealthScheduleStatus,
} from '../hosted/context_health_postgres.js';
import type {HostedContextHealthClaimV1} from '../hosted/context_health_postgres.js';
import type {HostedContextHealthRunInputV1, HostedContextHealthScheduleV1} from '../hosted/context_health.js';
import {assertHostedContextHealthWorkerPrivileges} from '../runtime_privileges.js';
import {PostgresRemoteControlPlane, type RemoteMemoryProvisioningInput} from '../postgres/control_plane.js';
import type {
  RemoteMemoryProvisioningPlanV1,
  RemoteMemoryProvisioningReceiptV1,
  RemoteMemoryProvisioningRequestV1,
} from '../provisioning.js';
import {
  REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION,
  remoteMemoryOperatorCapabilities,
  RemoteMemoryOperatorError,
  type RemoteMemoryOperatorAdapter,
} from '../operator.js';
import {
  REMOTE_MEMORY_PORTABILITY_VERSION,
  type RemoteMemoryExistingRecordV1,
  type GitBetaImportApplyOutcomeV1,
  type RemoteMemoryPortableRecordV1,
} from '../portability.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface PortableRecordRow {
  readonly aliases: string[] | null;
  readonly canonical_uri: string;
  readonly content_hash: string;
  readonly kind: string;
  readonly markdown_body: string;
  readonly project: string;
  readonly topic: string;
}

const MAX_GIT_BETA_IMPORT_RECORDS = 10_000;
const MAX_GIT_BETA_IMPORT_RECORD_BYTES = 1024 * 1024;
const MAX_GIT_BETA_IMPORT_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_GIT_BETA_IMPORT_ALIASES_PER_RECORD = 16;
const MAX_GIT_BETA_IMPORT_TOTAL_ALIASES = 10_000;
const MAX_GIT_BETA_IMPORT_TOTAL_ALIAS_BYTES = 8 * 1024 * 1024;
const MAX_GIT_BETA_IMPORT_ALIAS_CHARACTERS = 4096;
const utf8 = new TextEncoder();

function requiredContextHealthEvaluationKey(options: {readonly contextHealthEvaluationKey?: string}): string {
  const key = options.contextHealthEvaluationKey;
  if (!key || utf8.encode(key).length < 32) {
    throw new Error('Hosted context health evaluation key is unavailable or too short.');
  }
  return key;
}

/** Built-in operator adapter with one atomic revision/alias/import-receipt transaction. */
export class PostgresRemoteMemoryOperatorAdapter implements RemoteMemoryOperatorAdapter {
  readonly capabilities = remoteMemoryOperatorCapabilities([
    'apply_git_beta_import',
    'export_records',
    'inspect_records',
    'manage_context_ci',
    'manage_context_health',
    'migrate_schema',
    'provision_control_plane',
  ]);

  private readonly controlPlane: PostgresRemoteControlPlane;

  constructor(
    readonly sql: Sql,
    readonly options: {readonly contextHealthEvaluationKey?: string; readonly executablePath?: string} = {},
  ) {
    this.controlPlane = new PostgresRemoteControlPlane(sql);
  }

  readonly controlContextCi = (input: unknown, webhookKey?: string) =>
    controlHostedContextCi(this.sql, input, webhookKey);

  readonly migrateSchema = async () => {
    await migrateRemoteMemoryDatabase(this.sql, {executablePath: this.options.executablePath});
    return {
      readyVersions: remoteMemoryMigrationVersions(),
      status: 'ready' as const,
      version: REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION,
    };
  };

  readonly provisionControlPlane = async (input: RemoteMemoryProvisioningInput): Promise<void> => {
    await this.controlPlane.provision(input);
  };

  readonly applyProvisioningPlan = async (
    plan: RemoteMemoryProvisioningPlanV1,
    receipt: RemoteMemoryProvisioningReceiptV1,
  ) => {
    try {
      return await this.controlPlane.provision(plan.input, {plan, receipt});
    } catch (cause) {
      if (Schema.is(RemoteMemoryError)(cause) && cause.code === 'conflict') {
        throw RemoteMemoryOperatorError.of('blocked_plan', cause.message);
      }
      throw cause;
    }
  };

  readonly inspectProvisioningState = async (input: RemoteMemoryProvisioningRequestV1) =>
    this.controlPlane.inspectProvisioningState(input);

  readonly registerContextHealthSchedule = (schedule: HostedContextHealthScheduleV1, nextDueAt: string) =>
    registerHostedContextHealthSchedule(this.sql, schedule, nextDueAt);

  readonly claimContextHealthJobs = (concurrency: number) => claimHostedContextHealthJobs(this.sql, concurrency);

  readonly assertContextHealthWorkerPrivileges = () => assertHostedContextHealthWorkerPrivileges(this.sql);

  readonly completeContextHealthCycle = (input: {readonly failed: boolean; readonly generation: number}) =>
    completeHostedContextHealthCycle(this.sql, input);

  readonly failContextHealthClaim = (claim: HostedContextHealthClaimV1) =>
    failHostedContextHealthClaim(this.sql, claim);

  readonly recordContextHealthRun = (claim: HostedContextHealthClaimV1, input: HostedContextHealthRunInputV1) =>
    recordHostedContextHealthRun(this.sql, claim, input, requiredContextHealthEvaluationKey(this.options));

  readonly setContextHealthScheduleStatus = (input: {
    readonly project: string;
    readonly shareId: string;
    readonly status: 'active' | 'paused';
    readonly tenantId: string;
  }) => setHostedContextHealthScheduleStatus(this.sql, input);

  readonly applyGitBetaImport = async (input: {
    readonly aliasCompatibilityEndsAt: string;
    readonly planDigest: string;
    readonly planId: string;
    readonly records: readonly RemoteMemoryPortableRecordV1[];
    readonly shareId: string;
  }): Promise<readonly GitBetaImportApplyOutcomeV1[]> => {
    validateApplyInput(input);
    for (const record of input.records) validatePortableRecord(record, input.shareId);
    const tenantId = await this.controlPlane.tenantForShare(input.shareId);
    if (!tenantId) throw new Error('The remote memory share does not exist or is inactive.');
    return this.withTenant(tenantId, async transaction => {
      const flag = await transaction<{enabled: boolean}[]>`
        SELECT 'git_beta_import' = ANY(feature_flags) AS enabled
        FROM remote_memory.shares
        WHERE tenant_id = ${tenantId} AND id = ${input.shareId} AND status = 'active'
        FOR UPDATE
      `;
      if (!flag[0]?.enabled) throw new Error('The remote share has not enabled git_beta_import.');
      const priorReceipts = await transaction<
        {outcome: GitBetaImportApplyOutcomeV1[]; plan_digest: string; plan_id: string}[]
      >`
        SELECT plan_id, plan_digest, outcome FROM remote_memory.git_beta_import_receipts
        WHERE tenant_id = ${tenantId} AND share_id = ${input.shareId}
          AND (plan_id = ${input.planId} OR plan_digest = ${input.planDigest})
      `;
      const priorReceipt = priorReceipts[0];
      if (priorReceipt) {
        if (priorReceipt.plan_id !== input.planId || priorReceipt.plan_digest !== input.planDigest) {
          throw new Error('The Git beta import plan identity conflicts with an existing immutable receipt.');
        }
        return priorReceipt.outcome;
      }
      const outcomes: GitBetaImportApplyOutcomeV1[] = [];
      for (const record of [...input.records].sort((left, right) => compareCodeUnits(left.uri, right.uri))) {
        outcomes.push(await importRecord(transaction, tenantId, input.shareId, input, record));
      }
      await transaction`
        INSERT INTO remote_memory.git_beta_import_receipts(
          tenant_id, share_id, plan_id, plan_digest, alias_compatibility_ends_at, outcome
        ) VALUES (
          ${tenantId}, ${input.shareId}, ${input.planId}, ${input.planDigest},
          ${input.aliasCompatibilityEndsAt}, ${transaction.json(EffectArray.map(outcomes, outcome => ({...outcome})))}
        )
      `;
      return outcomes;
    });
  };

  readonly inspectRecords = async (shareId: string): Promise<readonly RemoteMemoryExistingRecordV1[]> => {
    const rows = await this.portableRows(shareId);
    return EffectArray.map(rows, row => ({
      aliases: sortedAliases(row.aliases),
      contentHash: row.content_hash,
      uri: row.canonical_uri,
      version: REMOTE_MEMORY_PORTABILITY_VERSION,
    }));
  };

  readonly exportRecords = async (shareId: string): Promise<readonly RemoteMemoryPortableRecordV1[]> => {
    const rows = await this.portableRows(shareId);
    return EffectArray.map(rows, row => portableRecordFromRow(row, shareId));
  };

  async close(): Promise<void> {
    await this.sql.end({timeout: 5});
  }

  private async portableRows(shareId: string): Promise<readonly PortableRecordRow[]> {
    const tenantId = await this.controlPlane.tenantForShare(shareId);
    if (!tenantId) throw new Error('The remote memory share does not exist or is inactive.');
    return await this.sql.begin(async transaction => {
      await setTenant(transaction, tenantId);
      return transaction<PortableRecordRow[]>`
        SELECT h.canonical_uri, h.kind, h.project, h.topic, r.markdown_body, r.content_hash,
          COALESCE(array_agg(DISTINCT a.alias_uri)
            FILTER (WHERE a.alias_uri IS NOT NULL), '{}') AS aliases
        FROM remote_memory.memory_heads h
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        LEFT JOIN remote_memory.uri_aliases a
          ON a.tenant_id = h.tenant_id AND a.share_id = h.share_id AND a.canonical_uri = h.canonical_uri
          AND (a.expires_at IS NULL OR a.expires_at > now())
        WHERE h.tenant_id = ${tenantId} AND h.share_id = ${shareId}
        GROUP BY h.canonical_uri, h.kind, h.project, h.topic, r.markdown_body, r.content_hash
        ORDER BY h.canonical_uri
      `;
    });
  }

  private async withTenant<A>(tenantId: string, use: (transaction: ISql) => Promise<A>): Promise<A> {
    return await this.sql.begin<Promise<A>>(async transaction => {
      await setTenant(transaction, tenantId);
      return use(transaction);
    });
  }
}

async function importRecord(
  transaction: ISql,
  tenantId: string,
  shareId: string,
  plan: {readonly aliasCompatibilityEndsAt: string; readonly planId: string},
  record: RemoteMemoryPortableRecordV1,
): Promise<GitBetaImportApplyOutcomeV1> {
  const {address, document} = validatePortableRecord(record, shareId);
  const project = await transaction<{name: string}[]>`
    SELECT name FROM remote_memory.projects
    WHERE tenant_id = ${tenantId} AND share_id = ${shareId}
      AND name = ${address.project} AND status = 'active'
  `;
  if (!project[0]) throw new Error(`Git beta import target project is not active: ${address.project}.`);
  await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${record.uri}, 0))`;
  const current = await transaction<{content_hash: string; head_id: string}[]>`
    SELECT h.id AS head_id, r.content_hash
    FROM remote_memory.memory_heads h
    JOIN remote_memory.memory_revisions r
      ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
    WHERE h.tenant_id = ${tenantId} AND h.share_id = ${shareId} AND h.canonical_uri = ${record.uri}
    FOR UPDATE OF h
  `;
  if (current[0]) {
    if (current[0].content_hash !== record.contentHash) {
      throw new Error(`Git beta import conflicts with an existing memory: ${record.uri}.`);
    }
    await upsertAliases(transaction, tenantId, shareId, record, plan.aliasCompatibilityEndsAt);
    return {
      sourceUri: requireSourceAlias(record),
      status: 'unchanged',
      targetUri: record.uri,
      version: REMOTE_MEMORY_PORTABILITY_VERSION,
    };
  }
  const headId = randomUuidV4();
  const revisionId = randomUuidV4();
  const generations = await transaction<{indexed_generation: string | number; share_generation: string | number}[]>`
    UPDATE remote_memory.shares SET share_generation = share_generation + 1
    WHERE tenant_id = ${tenantId} AND id = ${shareId} AND status = 'active'
    RETURNING share_generation, indexed_generation
  `;
  const generation = generations[0]?.share_generation;
  if (generation === undefined) throw new Error('The remote memory share is no longer active.');
  await transaction`
    INSERT INTO remote_memory.memory_heads(
      tenant_id, share_id, id, kind, project, topic, canonical_uri, status
    ) VALUES (
      ${tenantId}, ${shareId}, ${headId}, ${record.kind}, ${address.project}, ${address.topic}, ${record.uri}, 'active'
    )
  `;
  await transaction`
    INSERT INTO remote_memory.memory_revisions(
      tenant_id, share_id, id, head_id, generation, status, markdown_body, content_hash,
      oauth_principal_id, operation_id
    ) VALUES (
      ${tenantId}, ${shareId}, ${revisionId}, ${headId}, ${generation}, 'active',
      ${record.canonicalContent}, ${record.contentHash}, 'system:migration', ${`import:${plan.planId}:${headId}`}
    )
  `;
  await replaceRemoteCodeLinkBacklinks(transaction, {
    citations: document.record.metadata.codeCitations ?? [],
    headId,
    revisionId,
    shareId,
    tenantId,
  });
  await transaction`
    UPDATE remote_memory.memory_heads SET current_revision_id = ${revisionId}
    WHERE tenant_id = ${tenantId} AND share_id = ${shareId} AND id = ${headId}
  `;
  await upsertAliases(transaction, tenantId, shareId, record, plan.aliasCompatibilityEndsAt);
  await transaction`
        INSERT INTO remote_memory.outbox_events(tenant_id, share_id, id, generation, event_type, aggregate_id)
        VALUES (${tenantId}, ${shareId}, ${randomUuidV4()}, ${generation}, 'memory_head_changed', ${headId})
      `;
  const migrationPrincipalId = 'system:migration';
  const migrationPolicyVersion = 'system:migration-v1';
  const migrationPolicyDocument = {capabilities: ['memory:admin'], internal: 'migration'};
  const migrationPolicyDigest = sha256HexSync(JSON.stringify(migrationPolicyDocument));
  await transaction`
    INSERT INTO remote_memory.principals(tenant_id, id, status)
    VALUES (${tenantId}, ${migrationPrincipalId}, 'active')
    ON CONFLICT (tenant_id, id) DO NOTHING
  `;
  await transaction`
    INSERT INTO remote_memory.grant_policy_versions(
      tenant_id, share_id, version, principal_id, policy_document, policy_digest
    ) VALUES (
      ${tenantId}, ${shareId}, ${migrationPolicyVersion}, ${migrationPrincipalId},
      ${transaction.json(migrationPolicyDocument)}, ${migrationPolicyDigest}
    ) ON CONFLICT (tenant_id, share_id, version, principal_id) DO NOTHING
  `;
  await transaction`
    INSERT INTO remote_memory.audit_events(
      tenant_id, share_id, id, request_id, principal_id, operation, result,
      policy_version, share_policy_version, generation
    )
    SELECT ${tenantId}, ${shareId}, ${randomUuidV4()}, ${plan.planId}, ${migrationPrincipalId},
      'git_beta_import', 'committed', ${migrationPolicyVersion}, policy_version, ${generation}
    FROM remote_memory.shares WHERE tenant_id = ${tenantId} AND id = ${shareId}
  `;
  return {
    sourceUri: requireSourceAlias(record),
    status: 'imported',
    targetUri: record.uri,
    version: REMOTE_MEMORY_PORTABILITY_VERSION,
  };
}

async function upsertAliases(
  transaction: ISql,
  tenantId: string,
  shareId: string,
  record: RemoteMemoryPortableRecordV1,
  expiresAt: string,
): Promise<void> {
  for (const alias of record.aliases) {
    const rows = await transaction<{alias_uri: string}[]>`
      INSERT INTO remote_memory.uri_aliases(
        tenant_id, share_id, alias_uri, canonical_uri, source, expires_at
      ) VALUES (${tenantId}, ${shareId}, ${alias}, ${record.uri}, 'git_beta_import', ${expiresAt})
      ON CONFLICT (tenant_id, share_id, alias_uri) DO UPDATE SET
        canonical_uri = EXCLUDED.canonical_uri, source = EXCLUDED.source, expires_at = EXCLUDED.expires_at
      WHERE remote_memory.uri_aliases.canonical_uri = EXCLUDED.canonical_uri
      RETURNING alias_uri
    `;
    if (!rows[0]) throw new Error(`Git beta import alias conflicts with another memory: ${alias}.`);
  }
}

function validateApplyInput(input: {
  readonly aliasCompatibilityEndsAt: string;
  readonly planDigest: string;
  readonly planId: string;
  readonly records: readonly RemoteMemoryPortableRecordV1[];
  readonly shareId: string;
}): void {
  if (!/^tnmi_[0-9a-f]{32}$/u.test(input.planId) || !/^[0-9a-f]{64}$/u.test(input.planDigest)) {
    throw new Error('Git beta import plan identity is invalid.');
  }
  if (
    !Number.isFinite(Date.parse(input.aliasCompatibilityEndsAt)) ||
    Date.parse(input.aliasCompatibilityEndsAt) <= Date.now()
  ) {
    throw new Error('Git beta import alias compatibility end is invalid.');
  }
  if (!EffectArray.isArray(input.records)) throw new Error('Git beta import records must be an array.');
  if (input.records.length > MAX_GIT_BETA_IMPORT_RECORDS) {
    throw new Error('Git beta import exceeds the record limit.');
  }
  let totalBytes = 0;
  let totalAliases = 0;
  let totalAliasBytes = 0;
  const uris = new Set<string>();
  const aliases = new Set<string>();
  for (const record of input.records) {
    const recordAliases: unknown = record?.aliases;
    if (
      record === null ||
      typeof record !== 'object' ||
      typeof record.uri !== 'string' ||
      typeof record.canonicalContent !== 'string' ||
      !EffectArray.isArray(recordAliases)
    ) {
      throw new Error('Git beta import contains an invalid record shape.');
    }
    if (recordAliases.length > MAX_GIT_BETA_IMPORT_ALIASES_PER_RECORD) {
      throw new Error('A Git beta memory exceeds the alias count limit.');
    }
    totalAliases += recordAliases.length;
    if (totalAliases > MAX_GIT_BETA_IMPORT_TOTAL_ALIASES) {
      throw new Error('Git beta import exceeds the total alias count limit.');
    }
    for (const alias of recordAliases) {
      if (typeof alias !== 'string') throw new Error('Git beta import contains an invalid record shape.');
      if (alias.length > MAX_GIT_BETA_IMPORT_ALIAS_CHARACTERS) {
        throw new Error('Git beta import alias is too long.');
      }
      totalAliasBytes += utf8.encode(alias).byteLength;
      if (totalAliasBytes > MAX_GIT_BETA_IMPORT_TOTAL_ALIAS_BYTES) {
        throw new Error('Git beta import exceeds the total alias size limit.');
      }
      if (aliases.has(alias)) throw new Error('Git beta import contains duplicate aliases.');
      aliases.add(alias);
    }
    if (uris.has(record.uri)) throw new Error('Git beta import contains duplicate target URIs.');
    uris.add(record.uri);
    const bytes = utf8.encode(record.canonicalContent).byteLength;
    if (bytes > MAX_GIT_BETA_IMPORT_RECORD_BYTES) {
      throw new Error('A Git beta memory exceeds the import size limit.');
    }
    totalBytes += bytes;
    if (totalBytes > MAX_GIT_BETA_IMPORT_TOTAL_BYTES) {
      throw new Error('Git beta import exceeds the total size limit.');
    }
  }
}

function validatePortableRecord(record: RemoteMemoryPortableRecordV1, shareId: string) {
  if (record.version !== REMOTE_MEMORY_PORTABILITY_VERSION) throw new Error('Portable record version is unsupported.');
  const address = parseRemoteShareAddress(record.uri);
  if (
    address.shareId !== shareId ||
    address.kind !== record.kind ||
    address.canonicalUri !== record.uri ||
    address.project !== record.project ||
    address.topic !== record.topic ||
    record.kind !== 'durable'
  ) {
    throw new Error('Portable record identity mismatch.');
  }
  const document = parseRemoteCanonicalMemoryDocument({
    content: record.canonicalContent,
    kind: record.kind,
    project: record.project,
    topic: record.topic,
    uri: record.uri,
  });
  if (document.content !== record.canonicalContent) {
    throw new Error('Portable record does not pass canonical content policy.');
  }
  if (sha256HexSync(record.canonicalContent) !== record.contentHash) {
    throw new Error('Portable record content hash mismatch.');
  }
  if (record.aliases.length === 0) throw new Error('Git beta imports require a source alias.');
  for (const alias of record.aliases) validateGitBetaAlias(alias);
  return {address, document};
}

function portableRecordFromRow(row: PortableRecordRow, shareId: string): RemoteMemoryPortableRecordV1 {
  const kind = remoteMemoryKind(row.kind);
  const address = parseRemoteShareAddress(row.canonical_uri);
  if (address.shareId !== shareId) throw new Error('The remote memory export row belongs to another share.');
  const document = parseRemoteCanonicalMemoryDocument({
    content: row.markdown_body,
    kind,
    project: row.project,
    topic: row.topic,
    uri: row.canonical_uri,
  });
  if (document.content !== row.markdown_body) {
    throw new Error('The remote memory export row does not use canonical content bytes.');
  }
  if (sha256HexSync(document.content) !== row.content_hash) {
    throw new Error('The remote memory export row content hash does not match its contents.');
  }
  return {
    aliases: sortedAliases(row.aliases),
    canonicalContent: document.content,
    contentHash: row.content_hash,
    kind,
    project: row.project,
    topic: row.topic,
    uri: address.canonicalUri,
    version: REMOTE_MEMORY_PORTABILITY_VERSION,
  };
}

function validateGitBetaAlias(alias: string): void {
  if (alias.length > MAX_GIT_BETA_IMPORT_ALIAS_CHARACTERS) {
    throw new Error('Git beta import alias is too long.');
  }
  const resource = parseResourceId(alias);
  const [, memories, shared, team, kind, scope, project, file] = resource.segments;
  if (
    resource.inputScheme !== 'threadnote' ||
    resource.anchor ||
    resource.canonicalUri !== alias ||
    resource.namespace !== 'user' ||
    memories !== 'memories' ||
    shared !== 'shared' ||
    !team ||
    kind !== 'durable' ||
    scope !== 'projects' ||
    !project ||
    !Effect.pipe(file, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.endsWith('.md')),
    ) ||
    resource.segments.length !== 8
  ) {
    throw new Error('Git beta import alias is not canonical or has an unsupported layout.');
  }
}

function requireSourceAlias(record: RemoteMemoryPortableRecordV1): string {
  const alias = record.aliases[0];
  if (!alias) throw new Error('Git beta imports require a source alias.');
  return alias;
}

function remoteMemoryKind(value: string): 'durable' | 'handoff' {
  if (value === 'durable' || value === 'handoff') return value;
  throw new Error('The remote memory store contains an unsupported memory kind.');
}

function sortedAliases(values: readonly string[] | null): readonly string[] {
  return [...new Set(values ?? [])].sort(compareCodeUnits);
}

async function setTenant(transaction: ISql, tenantId: string): Promise<void> {
  await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
  await transaction`SELECT set_config('statement_timeout', '120000', true)`;
  await transaction`SELECT set_config('lock_timeout', '5000', true)`;
  await transaction`SELECT set_config('transaction_timeout', '300000', true)`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
