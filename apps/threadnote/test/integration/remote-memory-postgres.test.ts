import {Array as EffectArray, Option as EffectOption} from 'effect';
import type {Sql, TransactionSql} from 'postgres';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {randomUuidV4} from '@threadnote/threadnote/crypto/uuid';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {formatRemoteMemoryUri} from '@threadnote/memory/remote/address';
import type {RemoteRememberInputV1} from '@threadnote/memory/remote/contracts';
import {formatRemoteMemoryLogicalKey, REMOTE_MEMORY_REVISION_VERSION} from '@threadnote/memory/remote/revisions';
import {
  requireRemoteScope,
  type AuthorizedRemotePrincipal,
  type RemoteMemoryScope,
} from '@threadnote/remote-memory/authorization';
import {RemoteHandoffRetentionWorker} from '@threadnote/remote-memory/handoff_retention';
import {RemoteMemoryIndexer} from '@threadnote/remote-memory/indexer';
import {migrateRemoteMemoryDatabase, remoteMemoryMigrationVersions} from '@threadnote/remote-memory/migrations';
import type {OAuthPrincipalClaims} from '@threadnote/remote-memory/oauth';
import {PostgresRemoteMemoryOperatorAdapter} from '@threadnote/remote-memory/operator/postgres';
import {
  applyRemoteMemoryProvisioningOperator,
  planRemoteMemoryProvisioningOperator,
} from '@threadnote/remote-memory/operator';
import type {RemoteMemoryProvisioningRequestV1} from '@threadnote/remote-memory/provisioning';
import {remoteContextBriefAnchorSelectors} from '@threadnote/remote-memory/context/brief';
import type {RemoteMemoryPortableRecordV1} from '@threadnote/remote-memory/portability';
import {
  PostgresRemoteControlPlane,
  type RemoteMemoryProvisioningInput,
} from '@threadnote/remote-memory/postgres/control_plane';
import {PostgresRemoteMemoryRepository} from '@threadnote/remote-memory/postgres/repository';
import {
  createRemoteMemoryPostgresFixture,
  type RemoteMemoryPostgresFixture,
} from '../helpers/remote-memory-postgres.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const TEST_DATABASE_URL = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = TEST_DATABASE_URL ? describe : describe.skip;
const ISSUER = 'https://identity.integration.test';
const PROJECT = 'threadnote';
const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const SHARE_A = 'share-alpha';
const SHARE_A_SECONDARY = 'share-alpha-secondary';
const SHARE_A_MULTI_MEMBER = 'share-alpha-multi-member';
const SHARE_B = 'share-beta';
const PRINCIPAL_A = 'principal-alpha';
const PRINCIPAL_A_SECONDARY = 'principal-alpha-secondary';
const PRINCIPAL_A_MEMBER_TWO = 'principal-alpha-member-two';
const PRINCIPAL_B = 'principal-beta';
const ALL_SCOPES = [
  'memory:read',
  'memory:write:durable',
  'memory:write:handoff',
] as const satisfies readonly RemoteMemoryScope[];

postgresDescribe('remote memory PostgreSQL service', () => {
  let fixture: RemoteMemoryPostgresFixture;
  let control: PostgresRemoteControlPlane;
  let repository: PostgresRemoteMemoryRepository;
  let indexer: RemoteMemoryIndexer;
  let principalA: AuthorizedRemotePrincipal;
  let principalASecondary: AuthorizedRemotePrincipal;
  let principalAMultiPrimary: AuthorizedRemotePrincipal;
  let principalAMemberTwo: AuthorizedRemotePrincipal;
  let principalB: AuthorizedRemotePrincipal;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL)
      throw new Error('THREADNOTE_TEST_POSTGRES_URL is required for PostgreSQL integration tests.');
    fixture = await createRemoteMemoryPostgresFixture(TEST_DATABASE_URL);
    const operatorControl = new PostgresRemoteControlPlane(fixture.migratorSql);

    await operatorControl.provision(provisioningFixture('alpha'));
    await operatorControl.provision(provisioningFixture('alpha-secondary'));
    await operatorControl.provision(provisioningFixture('alpha-multi-primary'));
    await operatorControl.provision(provisioningFixture('alpha-multi-member'));
    await operatorControl.provision(provisioningFixture('beta'));
    control = new PostgresRemoteControlPlane(fixture.sql);
    repository = new PostgresRemoteMemoryRepository(fixture.sql);
    indexer = new RemoteMemoryIndexer(fixture.sql);
    const authorizedA = await control.authorize(claimsFixture('subject-alpha'), SHARE_A);
    const authorizedASecondary = await control.authorize(claimsFixture('subject-alpha-secondary'), SHARE_A_SECONDARY);
    const authorizedAMultiPrimary = await control.authorize(
      claimsFixture('subject-alpha-multi-primary'),
      SHARE_A_MULTI_MEMBER,
    );
    const authorizedAMemberTwo = await control.authorize(
      claimsFixture('subject-alpha-member-two'),
      SHARE_A_MULTI_MEMBER,
    );
    const authorizedB = await control.authorize(claimsFixture('subject-beta'), SHARE_B);
    if (!authorizedA || !authorizedASecondary || !authorizedAMultiPrimary || !authorizedAMemberTwo || !authorizedB) {
      throw new Error('Remote PostgreSQL fixture authorization failed.');
    }
    principalA = authorizedA;
    principalASecondary = authorizedASecondary;
    principalAMultiPrimary = authorizedAMultiPrimary;
    principalAMemberTwo = authorizedAMemberTwo;
    principalB = authorizedB;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  it('separates the non-superuser migrator owner from the least-privileged non-owner runtime', async () => {
    const runtimeRoles = await fixture.sql<
      {current_user: string; rolbypassrls: boolean; rolsuper: boolean; table_owner: string}[]
    >`
      SELECT current_user, r.rolbypassrls, r.rolsuper, pg_get_userbyid(c.relowner) AS table_owner
      FROM pg_roles r
      JOIN pg_class c ON c.oid = 'remote_memory.memory_heads'::regclass
      WHERE r.rolname = current_user
    `;
    expect(runtimeRoles).toEqual([
      {
        current_user: fixture.runtimeRoleName,
        rolbypassrls: false,
        rolsuper: false,
        table_owner: fixture.migratorRoleName,
      },
    ]);
    const runtimePrivileges = await fixture.sql<
      {
        audit_select: boolean;
        migration_update: boolean;
        policy_update: boolean;
        schema_create: boolean;
        share_generation_update: boolean;
        share_policy_update: boolean;
        tenant_region_select: boolean;
      }[]
    >`
      SELECT
        has_schema_privilege(current_user, 'remote_memory', 'CREATE') AS schema_create,
        has_table_privilege(current_user, 'remote_memory.schema_migrations', 'UPDATE') AS migration_update,
        has_table_privilege(current_user, 'remote_memory.audit_events', 'SELECT') AS audit_select,
        has_table_privilege(current_user, 'remote_memory.grant_policy_versions', 'UPDATE') AS policy_update,
        has_column_privilege(current_user, 'remote_memory.shares', 'policy_version', 'UPDATE') AS share_policy_update,
        has_column_privilege(current_user, 'remote_memory.shares', 'share_generation', 'UPDATE')
          AS share_generation_update,
        has_column_privilege(current_user, 'remote_memory.tenants', 'region', 'SELECT') AS tenant_region_select
    `;
    expect(runtimePrivileges).toEqual([
      {
        audit_select: false,
        migration_update: false,
        policy_update: false,
        schema_create: false,
        share_generation_update: true,
        share_policy_update: false,
        tenant_region_select: false,
      },
    ]);

    const migratorRoles = await fixture.migratorSql<{current_user: string; rolbypassrls: boolean; rolsuper: boolean}[]>`
      SELECT current_user, rolbypassrls, rolsuper
      FROM pg_roles
      WHERE rolname = current_user
    `;
    expect(migratorRoles).toEqual([{current_user: fixture.migratorRoleName, rolbypassrls: false, rolsuper: false}]);

    const before = await fixture.migratorSql<{checksum: string; version: number}[]>`
      SELECT version, checksum FROM remote_memory.schema_migrations ORDER BY version
    `;
    expect(EffectArray.map(before, migration => migration.version)).toEqual(remoteMemoryMigrationVersions());
    expect(before[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);

    await migrateRemoteMemoryDatabase(fixture.migratorSql);
    expect(
      await fixture.migratorSql<{checksum: string; version: number}[]>`
        SELECT version, checksum FROM remote_memory.schema_migrations ORDER BY version
      `,
    ).toEqual(before);

    await fixture.migratorSql`
      UPDATE remote_memory.schema_migrations SET checksum = 'changed-after-apply' WHERE version = 1
    `;
    await expect(migrateRemoteMemoryDatabase(fixture.migratorSql)).rejects.toMatchObject({
      code: 'service_unavailable',
      name: 'RemoteMemoryError',
    });
    await fixture.migratorSql`
      UPDATE remote_memory.schema_migrations SET checksum = ${before[0].checksum} WHERE version = 1
    `;
    await migrateRemoteMemoryDatabase(fixture.migratorSql);

    const policies = await fixture.migratorSql<
      {relforcerowsecurity: boolean; relname: string; relrowsecurity: boolean}[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'remote_memory'
        AND c.relname = ANY(${fixture.sql.array([...tenantScopedTableNames])})
      ORDER BY c.relname
    `;
    expect(EffectArray.map(policies, row => row.relname)).toEqual([...tenantScopedTableNames].sort());
    expect(EffectArray.every(policies, row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('denies runtime DDL, migration, control-plane, import, and immutable-record mutation privileges', async () => {
    await expect(migrateRemoteMemoryDatabase(fixture.sql)).rejects.toMatchObject({code: '42501'});
    await expect(fixture.sql`CREATE TABLE remote_memory.runtime_must_not_create(id integer)`).rejects.toMatchObject({
      code: '42501',
    });
    await expect(fixture.sql`ALTER TABLE remote_memory.memory_heads DISABLE ROW LEVEL SECURITY`).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      fixture.sql`UPDATE remote_memory.schema_migrations SET checksum = 'runtime-must-not-change' WHERE version = 1`,
    ).rejects.toMatchObject({code: '42501'});
    await expect(
      fixture.sql`INSERT INTO remote_memory.tenants(id, region, status) VALUES ('runtime-tenant', 'test', 'active')`,
    ).rejects.toMatchObject({code: '42501'});
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          UPDATE remote_memory.share_grants SET status = 'revoked'
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND principal_id = ${PRINCIPAL_A}
        `,
      ),
    ).rejects.toMatchObject({code: '42501'});
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          UPDATE remote_memory.shares
          SET policy_version = 'runtime-policy', feature_flags = ARRAY['remote_memory_read']
          WHERE tenant_id = ${TENANT_A} AND id = ${SHARE_A}
        `,
      ),
    ).rejects.toMatchObject({code: '42501'});
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          INSERT INTO remote_memory.git_beta_import_receipts(
            tenant_id, share_id, plan_id, plan_digest, alias_compatibility_ends_at, outcome
          ) VALUES (${TENANT_A}, ${SHARE_A}, 'runtime-plan', 'runtime-digest', now() + interval '1 day', '{}'::jsonb)
        `,
      ),
    ).rejects.toMatchObject({code: '42501'});

    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          UPDATE remote_memory.memory_revisions SET markdown_body = 'mutated'
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND id = 'runtime-probe'
        `,
      ),
    ).rejects.toSatisfy(isPrivilegeOrImmutableRejection);
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          DELETE FROM remote_memory.audit_events
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND id = 'runtime-probe'
        `,
      ),
    ).rejects.toSatisfy(isPrivilegeOrImmutableRejection);
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          UPDATE remote_memory.grant_policy_versions SET policy_digest = 'mutated'
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A}
            AND principal_id = ${PRINCIPAL_A} AND version = 'policy-v1'
        `,
      ),
    ).rejects.toSatisfy(isPrivilegeOrImmutableRejection);
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          DELETE FROM remote_memory.share_policy_versions
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A}
            AND version = 'policy-v1'
        `,
      ),
    ).rejects.toSatisfy(isPrivilegeOrImmutableRejection);
  });

  it('rejects runtime rewrites and premature minimization of active workload attribution', async () => {
    const attestationId = randomUuidV4();
    await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction => transaction`
        INSERT INTO remote_memory.workload_attestations(
          tenant_id, share_id, id, principal_id, issuer, subject, jwt_id, cloud_agent_id,
          turn_id, team_id, owner_id, repository_urls, expires_at
        ) VALUES (
          ${TENANT_A}, ${SHARE_A}, ${attestationId}, ${PRINCIPAL_A}, 'https://cursor.example',
          'active-subject', ${randomUuidV4()}, 'active-agent', 'active-turn',
          'active-team', 'active-owner', ARRAY['https://github.com/example/threadnote.git'],
          ${new Date('2099-01-01T00:00:00.000Z').toISOString()}
        )
      `,
    );

    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          UPDATE remote_memory.workload_attestations SET subject = 'rewritten-subject'
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND id = ${attestationId}
        `,
      ),
    ).rejects.toSatisfy(isAttestationMinimizationRejection);
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          UPDATE remote_memory.workload_attestations SET
            issuer = 'expired', subject = 'expired',
            jwt_id = tenant_id || ':' || share_id || ':' || id, cloud_agent_id = 'expired',
            turn_id = NULL, team_id = NULL, owner_id = NULL, repository_urls = NULL
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND id = ${attestationId}
        `,
      ),
    ).rejects.toSatisfy(isAttestationMinimizationRejection);

    const unchanged = await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction => transaction<{cloud_agent_id: string; subject: string}[]>`
        SELECT subject, cloud_agent_id FROM remote_memory.workload_attestations WHERE id = ${attestationId}
      `,
    );
    expect(unchanged).toEqual([{cloud_agent_id: 'active-agent', subject: 'active-subject'}]);
  });

  it('provisions and authorizes only the matching identity, grant, project, and share', async () => {
    expect(principalA).toMatchObject({
      policyVersion: 'policy-v1',
      principalId: PRINCIPAL_A,
      shareId: SHARE_A,
      tenantId: TENANT_A,
    });
    expect(principalA.allowedProjects).toEqual(new Set([PROJECT]));
    expect(principalA.capabilities).toEqual(new Set(ALL_SCOPES));
    expect(principalA.repositoryBindings).toEqual(new Set(['https://github.com/example/threadnote-alpha.git']));
    expect(principalA.featureFlags).toEqual(
      new Set(['remote_memory_read', 'remote_memory_durable_write', 'remote_memory_handoff_write', 'remote_memory_ga']),
    );

    await expect(control.authorize(claimsFixture('subject-alpha'), SHARE_B)).resolves.toBeUndefined();
    await expect(control.authorize(claimsFixture('subject-beta'), SHARE_A)).resolves.toBeUndefined();
    await expect(control.authorize(claimsFixture('missing-subject'), SHARE_A)).resolves.toBeUndefined();
    await expect(control.authorize(claimsFixture('subject-alpha'), 'missing-share')).resolves.toBeUndefined();
    await expect(control.provision(provisioningFixture('alpha'))).rejects.toMatchObject({code: '42501'});

    expect(await fixture.sql`SELECT id, status FROM remote_memory.tenants`).toEqual([]);
    expect(await fixture.sql`SELECT tenant_id, id, status FROM remote_memory.principals`).toEqual([]);
    expect(await fixture.sql`SELECT tenant_id, issuer, subject FROM remote_memory.external_identities`).toEqual([]);
    const tenantAMetadata = await withTenant(fixture.sql, TENANT_A, async transaction => ({
      identities: await transaction<{subject: string; tenant_id: string}[]>`
        SELECT tenant_id, subject FROM remote_memory.external_identities ORDER BY subject
      `,
      principals: await transaction<{id: string; tenant_id: string}[]>`
        SELECT tenant_id, id FROM remote_memory.principals ORDER BY id
      `,
      tenants: await transaction<{id: string}[]>`SELECT id FROM remote_memory.tenants`,
    }));
    expect(tenantAMetadata.tenants).toEqual([{id: TENANT_A}]);
    expect(tenantAMetadata.identities.length).toBeGreaterThan(0);
    expect(EffectArray.every(tenantAMetadata.identities, row => row.tenant_id === TENANT_A)).toBe(true);
    expect(tenantAMetadata.principals.length).toBeGreaterThan(0);
    expect(EffectArray.every(tenantAMetadata.principals, row => row.tenant_id === TENANT_A)).toBe(true);
    await expect(
      control.tenantForIdentity({issuer: ISSUER, requestedShareId: SHARE_A, subject: 'subject-alpha'}),
    ).resolves.toBe(TENANT_A);
    await expect(
      control.tenantForIdentity({issuer: ISSUER, requestedShareId: SHARE_B, subject: 'subject-alpha'}),
    ).resolves.toBeUndefined();
  });

  it('binds an external identity to the exact OAuth client and rejects an expired grant', async () => {
    const operatorControl = new PostgresRemoteControlPlane(fixture.migratorSql);
    const tenantId = 'tenant-client-bound';
    const shareId = 'share-client-bound';
    const principalId = 'principal-client-bound';
    const subject = 'subject-client-bound';
    const clientId = 'okta-native-client';
    const input: RemoteMemoryProvisioningInput = {
      ...provisioningFixture('alpha'),
      clientId,
      grantExpiresAt: '2099-01-01T00:00:00.000Z',
      policyVersion: 'client-policy-v1',
      principalId,
      shareId,
      subject,
      tenantId,
    };

    expect(await operatorControl.inspectProvisioningState(input)).toEqual({version: 1});
    await operatorControl.provision(input);
    await expect(control.authorize(claimsFixture(subject), shareId)).resolves.toBeUndefined();
    await expect(control.authorize(claimsFixture(subject, 'another-client'), shareId)).resolves.toBeUndefined();
    await expect(control.authorize(claimsFixture(subject, clientId), shareId)).resolves.toMatchObject({
      policyVersion: 'client-policy-v1',
      principalId,
      shareId,
      tenantId,
    });
    await expect(
      control.tenantForIdentity({clientId, issuer: ISSUER, requestedShareId: shareId, subject}),
    ).resolves.toBe(tenantId);
    await expect(
      control.tenantForIdentity({clientId: 'another-client', issuer: ISSUER, requestedShareId: shareId, subject}),
    ).resolves.toBeUndefined();
    await expect(operatorControl.inspectProvisioningState(input)).resolves.toMatchObject({
      grant: {expiresAt: '2099-01-01T00:00:00.000Z', policyVersion: 'client-policy-v1', status: 'active'},
      identityPrincipalId: principalId,
      principalStatus: 'active',
      share: {status: 'active'},
      tenant: {region: 'test-region', status: 'active'},
      version: 1,
    });

    await withTenant(
      fixture.migratorSql,
      tenantId,
      transaction => transaction`
        UPDATE remote_memory.share_grants SET expires_at = '2000-01-01T00:00:00.000Z'
        WHERE tenant_id = ${tenantId} AND share_id = ${shareId} AND principal_id = ${principalId}
      `,
    );
    await expect(control.authorize(claimsFixture(subject, clientId), shareId)).resolves.toBeUndefined();
  });

  it('uses a bounded legacy bridge only until an exact client binding exists', async () => {
    const clientId = 'okta-cutover-client';
    const compatibilityControl = new PostgresRemoteControlPlane(fixture.sql, {
      legacyClientIdCompatibilityUntil: '2099-01-01T00:00:00.000Z',
    });
    await expect(
      compatibilityControl.authorize(claimsFixture('subject-alpha', clientId), SHARE_A),
    ).resolves.toMatchObject({principalId: PRINCIPAL_A});
    await new PostgresRemoteControlPlane(fixture.migratorSql).provision({
      ...provisioningFixture('alpha'),
      clientId,
      policyVersion: 'client-cutover-v1',
      principalId: 'principal-alpha-client-bound',
    });
    await expect(
      compatibilityControl.authorize(claimsFixture('subject-alpha', clientId), SHARE_A),
    ).resolves.toMatchObject({principalId: 'principal-alpha-client-bound'});
    await expect(control.authorize(claimsFixture('subject-alpha', clientId), SHARE_A)).resolves.toMatchObject({
      principalId: 'principal-alpha-client-bound',
    });
  });

  it('atomically applies and replays a read-only pilot plan without undoing revocation', async () => {
    const adapter = new PostgresRemoteMemoryOperatorAdapter(fixture.migratorSql);
    const tenantId = 'tenant-plan-apply';
    const shareId = 'share-plan-apply';
    const principalId = 'principal-plan-apply';
    const clientId = 'okta-plan-client';
    const subject = 'subject-plan-apply';
    const request: RemoteMemoryProvisioningRequestV1 = {
      clientId,
      displayName: 'Plan apply pilot',
      issuer: ISSUER,
      policyVersion: 'reader-v1',
      principalId,
      projects: [PROJECT],
      region: 'test-region',
      repositoryBindings: {[PROJECT]: ['https://github.com/example/threadnote.git']},
      shareId,
      sharePolicyVersion: 'share-v1',
      subject,
      tenantId,
    };
    const plannedAt = new Date().toISOString();
    const plan = await planRemoteMemoryProvisioningOperator(adapter, {apply: true, plannedAt, request});
    expect(plan).toMatchObject({
      action: 'create_share_and_grant',
      input: {
        capabilities: ['memory:read'],
        featureFlags: ['remote_memory_ga', 'remote_memory_read'],
      },
    });

    const receipt = await applyRemoteMemoryProvisioningOperator(adapter, plan);
    await expect(applyRemoteMemoryProvisioningOperator(adapter, plan)).resolves.toEqual(receipt);
    const receipts = await withTenant(
      fixture.migratorSql,
      tenantId,
      transaction => transaction<{plan_digest: string; plan_id: string}[]>`
        SELECT plan_id, plan_digest FROM remote_memory.provisioning_receipts WHERE tenant_id = ${tenantId}
      `,
    );
    expect(receipts).toEqual([{plan_digest: plan.planDigest, plan_id: plan.planId}]);
    const authorized = await control.authorize(claimsFixture(subject, clientId), shareId);
    if (!authorized) throw new Error('Applied pilot reader did not authorize.');
    expect(() => requireRemoteScope(authorized, 'memory:read')).not.toThrow();

    const replacement = await planRemoteMemoryProvisioningOperator(adapter, {
      apply: true,
      plannedAt,
      request: {...request, policyVersion: 'reader-v2', sharePolicyVersion: undefined},
    });
    await withTenant(
      fixture.migratorSql,
      tenantId,
      transaction => transaction`
        UPDATE remote_memory.tenant_memberships SET status = 'revoked'
        WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
      `,
    );
    await expect(applyRemoteMemoryProvisioningOperator(adapter, replacement)).rejects.toMatchObject({
      code: 'blocked_plan',
    });
    const revoked = await withTenant(
      fixture.migratorSql,
      tenantId,
      transaction => transaction<{policy_version: string; status: string}[]>`
        SELECT g.policy_version, m.status
        FROM remote_memory.share_grants g
        JOIN remote_memory.tenant_memberships m
          ON m.tenant_id = g.tenant_id AND m.principal_id = g.principal_id
        WHERE g.tenant_id = ${tenantId} AND g.share_id = ${shareId} AND g.principal_id = ${principalId}
      `,
    );
    expect(revoked).toEqual([{policy_version: 'reader-v1', status: 'revoked'}]);
  });

  it('keeps the share project catalog independent from each member grant and requires share-policy CAS', async () => {
    expect(principalAMemberTwo.allowedProjects).toEqual(new Set(['api']));
    expect(principalAMemberTwo.repositoriesByProject).toEqual(
      new Map([['api', new Set(['https://github.com/example/api.git'])]]),
    );
    await expect(repository.status(principalAMemberTwo, 'request-distinct-policy-versions')).resolves.toMatchObject({
      receipt: {policyVersion: 'grant-member-v1', sharePolicyVersion: 'share-v1'},
    });

    const catalog = await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction => transaction<{name: string; status: string}[]>`
        SELECT name, status FROM remote_memory.projects
        WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A_MULTI_MEMBER}
        ORDER BY name
      `,
    );
    expect(catalog).toEqual([
      {name: 'api', status: 'active'},
      {name: PROJECT, status: 'active'},
    ]);

    const operatorControl = new PostgresRemoteControlPlane(fixture.migratorSql);
    const unchangedShare = provisioningFixture('alpha-multi-primary');
    await operatorControl.provision({
      ...unchangedShare,
      expectedCurrentPolicyVersion: 'grant-primary-v1',
    });
    await expect(
      operatorControl.provision({
        ...unchangedShare,
        expectedCurrentPolicyVersion: 'grant-primary-v1',
        sharePolicyVersion: 'share-v2',
      }),
    ).rejects.toMatchObject({code: 'conflict', name: 'RemoteMemoryError'});
    await expect(
      operatorControl.provision({
        ...unchangedShare,
        expectedCurrentPolicyVersion: 'grant-primary-v1',
        expectedCurrentSharePolicyVersion: 'stale-share',
        sharePolicyVersion: 'share-v2',
      }),
    ).rejects.toMatchObject({code: 'conflict', name: 'RemoteMemoryError'});
    await operatorControl.provision({
      ...unchangedShare,
      expectedCurrentPolicyVersion: 'grant-primary-v1',
      expectedCurrentSharePolicyVersion: 'share-v1',
      sharePolicyVersion: 'share-v2',
    });
    const shareVersions = await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction => transaction<{policy_digest: string; version: string}[]>`
        SELECT version, policy_digest FROM remote_memory.share_policy_versions
        WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A_MULTI_MEMBER}
        ORDER BY version
      `,
    );
    expect(shareVersions).toHaveLength(2);
    expect(shareVersions[0]?.policy_digest).toBe(shareVersions[1]?.policy_digest);
    await expect(repository.status(principalAMemberTwo, 'request-stale-share-policy')).rejects.toMatchObject({
      code: 'forbidden',
      name: 'RemoteMemoryError',
    });
    const refreshedPrimary = await control.authorize(
      claimsFixture('subject-alpha-multi-primary'),
      SHARE_A_MULTI_MEMBER,
    );
    const refreshedMember = await control.authorize(claimsFixture('subject-alpha-member-two'), SHARE_A_MULTI_MEMBER);
    if (!refreshedPrimary || !refreshedMember) throw new Error('Updated share policy authorization failed.');
    principalAMultiPrimary = refreshedPrimary;
    principalAMemberTwo = refreshedMember;
  });

  it.each([
    ['Cursor subject', {cursorSubjects: ['cursor-workload-generic']}],
    ['Cursor owner', {cursorOwnerIds: ['owner-123']}],
    ['Cursor team', {cursorTeamId: 'team-123'}],
    ['managed share id', {shareId: 'share:unaddressable'}],
    ['portable project', {allowedProjects: ['bad/project']}],
    ['canonical repository', {repositoryBindings: {[PROJECT]: ['https://github.com:8443/example/threadnote']}}],
  ] as const)('rejects a provisioning %s that the Cursor verifier cannot issue', async (_label, invalid) => {
    const operatorControl = new PostgresRemoteControlPlane(fixture.migratorSql);
    await expect(operatorControl.provision({...provisioningFixture('alpha'), ...invalid})).rejects.toMatchObject({
      code: 'invalid_request',
      name: 'RemoteMemoryError',
    });
  });

  it('replays one exact receipt when the same Git beta import plan is applied concurrently', async () => {
    const operator = new PostgresRemoteMemoryOperatorAdapter(fixture.migratorSql);
    const topic = `concurrent-import-${randomUuidV4()}`;
    const uri = formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE_A_MULTI_MEMBER, topic});
    const canonicalContent = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        project: PROJECT,
        sourceAgentClient: 'cursor',
        status: 'active',
        timestamp: '2026-08-13T00:00:00.000Z',
        topic,
      },
      'Concurrent import receipt replay.',
    );
    const planDigest = sha256HexSync(`concurrent-import:${topic}`);
    const input = {
      aliasCompatibilityEndsAt: '2099-01-01T00:00:00.000Z',
      planDigest,
      planId: `tnmi_${Effect.pipe(planDigest, EffectString.slice(0, 32))}`,
      records: [
        {
          aliases: [`threadnote://user/import/memories/shared/team/durable/projects/${PROJECT}/${topic}.md`],
          canonicalContent,
          contentHash: sha256HexSync(canonicalContent),
          kind: 'durable' as const,
          project: PROJECT,
          topic,
          uri,
          version: 1 as const,
        },
      ],
      shareId: SHARE_A_MULTI_MEMBER,
    };

    const outcomes = await Promise.all([operator.applyGitBetaImport(input), operator.applyGitBetaImport(input)]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toEqual([
      {sourceUri: input.records[0].aliases[0], status: 'imported', targetUri: uri, version: 1},
    ]);
    const persisted = await withTenant(fixture.migratorSql, TENANT_A, async transaction => ({
      audits: await transaction<{policy_version: string; share_policy_version: string}[]>`
          SELECT policy_version, share_policy_version FROM remote_memory.audit_events
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A_MULTI_MEMBER} AND request_id = ${input.planId}
        `,
      receipts: await transaction<{count: string | number}[]>`
          SELECT count(*) AS count FROM remote_memory.git_beta_import_receipts
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A_MULTI_MEMBER} AND plan_id = ${input.planId}
        `,
    }));
    expect(Number(persisted.receipts[0]?.count)).toBe(1);
    expect(persisted.audits).toEqual([{policy_version: 'system:migration-v1', share_policy_version: 'share-v2'}]);
    expect(await indexer.runPass({batchSize: 1})).toEqual({failed: 0, processed: 1});
  });

  it('enforces citation sharing policy at direct adapter ingress while preserving clean v4 on export', async () => {
    const operator = new PostgresRemoteMemoryOperatorAdapter(fixture.migratorSql);
    const suffix = randomUuidV4();
    const clean = operatorPortableRecord(
      SHARE_A_MULTI_MEMBER,
      `direct-citation-clean-${suffix}`,
      operatorCitationContent(`direct-citation-clean-${suffix}`, operatorCitation()),
    );

    await expect(operator.applyGitBetaImport(operatorImportInput(clean, SHARE_A_MULTI_MEMBER))).resolves.toEqual([
      {sourceUri: clean.aliases[0], status: 'imported', targetUri: clean.uri, version: 1},
    ]);
    const exported = await operator.exportRecords(SHARE_A_MULTI_MEMBER);
    const exportedClean = EffectOption.getOrUndefined(
      EffectArray.findFirst(exported, record => record.uri === clean.uri),
    );
    expect(exportedClean).toEqual(clean);
    expect(parseMemoryDocument(clean.uri, exportedClean!.canonicalContent)?.metadata).toMatchObject({
      codeCitations: [operatorCitation()],
      schemaVersion: MEMORY_SCHEMA_VERSION,
    });

    const blocked = [
      operatorPortableRecord(
        SHARE_A_MULTI_MEMBER,
        `direct-citation-dirty-${suffix}`,
        operatorCitationContent(`direct-citation-dirty-${suffix}`, operatorCitation({sourceDirty: true})),
      ),
      operatorPortableRecord(
        SHARE_A_MULTI_MEMBER,
        `direct-citation-local-${suffix}`,
        operatorCitationContent(`direct-citation-local-${suffix}`, operatorCitation({repositoryIdentityKind: 'local'})),
      ),
      operatorPortableRecord(
        SHARE_A_MULTI_MEMBER,
        `direct-citation-malformed-${suffix}`,
        operatorMalformedCitationContent(`direct-citation-malformed-${suffix}`),
      ),
    ];
    for (const record of blocked) {
      await expect(operator.applyGitBetaImport(operatorImportInput(record, SHARE_A_MULTI_MEMBER))).rejects.toThrow(
        'code-citation sharing policy',
      );
    }
    const blockedHeads = await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction => transaction<{topic: string}[]>`
        SELECT topic FROM remote_memory.memory_heads
        WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A_MULTI_MEMBER}
          AND topic LIKE ${`direct-citation-%-${suffix}`}
        ORDER BY topic
      `,
    );
    expect(blockedHeads).toEqual([{topic: clean.topic}]);
    expect(await indexer.runPass({batchSize: 1})).toEqual({failed: 0, processed: 1});
  });

  it('builds canonical PostgreSQL graph-linked briefs and repairs their bounded backlink projection', async () => {
    const operator = new PostgresRemoteMemoryOperatorAdapter(fixture.migratorSql);
    const suffix = randomUuidV4();
    const repositoryId = Effect.pipe('e', EffectString.repeat(64));
    const firstPath = `src/remote_memory/brief-${suffix}.ts`;
    const secondPath = `src/remote_memory/brief-helper-${suffix}.ts`;
    const citations = [
      operatorCitation({path: firstPath, repositoryId}),
      operatorCitation({path: secondPath, repositoryId}),
    ];
    const topic = `context-brief-${suffix}`;
    const content = formatMemoryDocument(
      'MEMORY',
      {
        codeCitations: citations,
        kind: 'durable',
        project: PROJECT,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceAgentClient: 'codex',
        status: 'active',
        timestamp: '2026-09-17T00:00:00.000Z',
        topic,
      },
      'Canonical PostgreSQL Context Brief evidence.',
    );
    const record = operatorPortableRecord(SHARE_A_MULTI_MEMBER, topic, content);
    await operator.applyGitBetaImport(operatorImportInput(record, SHARE_A_MULTI_MEMBER));
    const input = {
      anchors: [
        {path: firstPath, repositoryId},
        {path: secondPath, repositoryId},
      ],
      budgetTokens: 1_250,
      project: PROJECT,
      task: 'Canonical PostgreSQL Context Brief evidence.',
      version: 1 as const,
    };
    const immediate = await repository.contextBrief(
      principalAMultiPrimary,
      {...input, task: `pre-index-${suffix}`},
      `request-brief-pre-index-${suffix}`,
    );
    expect(immediate).toMatchObject({directSearchComplete: true, matchedAnchorOrdinals: [0, 1]});
    expect(EffectArray.filter(immediate.results, result => result.uri === record.uri)).toHaveLength(1);
    expect(await indexer.runPass({batchSize: 1_000})).toMatchObject({failed: 0});

    const initial = await repository.contextBrief(principalAMultiPrimary, input, `request-brief-${suffix}`);
    expect(initial).toMatchObject({directSearchTruncated: false, matchedAnchorOrdinals: [0, 1]});
    expect(EffectArray.filter(initial.results, result => result.uri === record.uri)).toEqual([
      expect.objectContaining({anchorOrdinals: [0, 1], evidence: 'anchor'}),
    ]);
    const otherProject = await repository.contextBrief(
      principalAMemberTwo,
      {...input, project: 'api'},
      `request-brief-other-project-${suffix}`,
    );
    expect(otherProject.results).toEqual([]);
    expect(otherProject.matchedAnchorOrdinals).toEqual([]);
    const isolated = await repository.contextBrief(principalB, input, `request-brief-isolated-${suffix}`);
    expect(isolated.results).toEqual([]);
    expect(isolated.matchedAnchorOrdinals).toEqual([]);

    const raceTopic = `context-brief-race-${suffix}`;
    class RaceOnceRepository extends PostgresRemoteMemoryRepository {
      raced = false;

      override async recall(...args: Parameters<PostgresRemoteMemoryRepository['recall']>) {
        const result = await super.recall(...args);
        if (!this.raced) {
          this.raced = true;
          await this.remember(
            args[0],
            rememberFixture({
              operationId: `context-brief-race-${suffix}`,
              text: 'Unrelated write used to exercise the final generation fence.',
              topic: raceTopic,
            }),
            `${args[2]}-race`,
          );
        }
        return result;
      }
    }
    const racingRepository = new RaceOnceRepository(fixture.sql);
    const fenced = await racingRepository.contextBrief(principalAMultiPrimary, input, `request-brief-fenced-${suffix}`);
    expect(racingRepository.raced).toBe(true);
    expect(EffectArray.filter(fenced.results, result => result.uri === record.uri)).toEqual([
      expect.objectContaining({anchorOrdinals: [0, 1], evidence: 'anchor'}),
    ]);
    expect(fenced.receipt.shareGeneration).toBeGreaterThan(initial.receipt.shareGeneration);

    const selector = remoteContextBriefAnchorSelectors([{path: firstPath, repositoryId}])[0];
    const forgedUri = formatRemoteMemoryUri({
      kind: 'durable',
      project: PROJECT,
      shareId: SHARE_A_MULTI_MEMBER,
      topic: raceTopic,
    });
    await withTenant(fixture.migratorSql, TENANT_A, async transaction => {
      const rows = await transaction<{head_id: string; revision_id: string}[]>`
        SELECT h.id AS head_id, h.current_revision_id AS revision_id
        FROM remote_memory.memory_heads h
        WHERE h.tenant_id = ${TENANT_A} AND h.share_id = ${SHARE_A_MULTI_MEMBER}
          AND h.canonical_uri = ${forgedUri}
      `;
      const forged = rows[0];
      if (!forged) throw new Error('Context Brief forged backlink fixture head was not found.');
      await transaction`
        INSERT INTO remote_memory.code_link_backlinks(
          tenant_id, share_id, head_id, revision_id, citation_ordinal, selector_kind, selector_digest
        ) VALUES (
          ${TENANT_A}, ${SHARE_A_MULTI_MEMBER}, ${forged.head_id}, ${forged.revision_id}, 0,
          'file-path', ${selector.selectorDigest}
        )
      `;
    });
    const verified = await repository.contextBrief(principalAMultiPrimary, input, `request-brief-verified-${suffix}`);
    expect(EffectArray.some(verified.results, result => result.uri === forgedUri)).toBe(false);
    expect(EffectArray.filter(verified.results, result => result.uri === record.uri)).toHaveLength(1);

    const projectionState = await withTenant(fixture.migratorSql, TENANT_A, async transaction => {
      const rows = await transaction<
        {generation: string | number; head_id: string; revision_id: string; selector_count: string | number}[]
      >`
        SELECT h.id AS head_id, h.current_revision_id AS revision_id, r.generation,
          count(b.selector_digest) AS selector_count
        FROM remote_memory.memory_heads h
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        LEFT JOIN remote_memory.code_link_backlinks b
          ON b.tenant_id = h.tenant_id AND b.share_id = h.share_id AND b.head_id = h.id
        WHERE h.tenant_id = ${TENANT_A} AND h.share_id = ${SHARE_A_MULTI_MEMBER} AND h.canonical_uri = ${record.uri}
        GROUP BY h.id, h.current_revision_id, r.generation
      `;
      const state = rows[0];
      if (!state) throw new Error('Context Brief fixture head was not projected.');
      await transaction`
        DELETE FROM remote_memory.code_link_backlinks
        WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A_MULTI_MEMBER} AND head_id = ${state.head_id}
      `;
      await transaction`
        INSERT INTO remote_memory.outbox_events(tenant_id, share_id, id, generation, event_type, aggregate_id)
        VALUES (
          ${TENANT_A}, ${SHARE_A_MULTI_MEMBER}, ${`code-link-backfill-test:${state.head_id}`}, ${state.generation},
          'code_link_backfill', ${state.head_id}
        )
      `;
      return state;
    });
    expect(Number(projectionState.selector_count)).toBeGreaterThanOrEqual(2);
    const pendingRepair = await repository.contextBrief(
      principalAMultiPrimary,
      input,
      `request-brief-pending-repair-${suffix}`,
    );
    expect(pendingRepair).toMatchObject({
      directSearchComplete: false,
      directSearchTruncated: false,
      matchedAnchorOrdinals: [],
    });
    expect(await indexer.runPass({batchSize: 1_000})).toMatchObject({failed: 0});
    const repaired = await repository.contextBrief(principalAMultiPrimary, input, `request-brief-repaired-${suffix}`);
    expect(repaired.directSearchComplete).toBe(true);
    expect(EffectArray.filter(repaired.results, result => result.uri === record.uri)).toHaveLength(1);
    expect(repaired.matchedAnchorOrdinals).toEqual([0, 1]);
  });

  it('commits one immutable CAS winner, replays exact outcomes, and recalls through the recent-write overlay', async () => {
    const createInput = rememberFixture({
      operationId: 'cas-create',
      text: 'Initial PostgreSQL memory with the overlayneedle marker.',
      topic: 'postgres-cas',
    });
    const created = await repository.remember(principalA, createInput, 'request-create');
    expect(created).toMatchObject({
      consistency: 'recent-write-overlay',
      indexedGeneration: 0,
      shareGeneration: 1,
    });

    const replayed = await repository.remember(principalA, createInput, 'request-replay');
    expect(replayed).toEqual({...created, requestId: 'request-replay'});
    expect({...replayed, requestId: created.requestId}).toEqual(created);
    await expect(
      repository.remember(
        principalA,
        {...createInput, text: 'Changed request under the same operation.'},
        'request-mismatch',
      ),
    ).rejects.toMatchObject({code: 'idempotency_mismatch', name: 'RemoteMemoryError'});
    const failedCasInput = {...createInput, operationId: 'cas-create-again'};
    await expect(repository.remember(principalA, failedCasInput, 'request-create-conflict')).rejects.toMatchObject({
      code: 'conflict',
      details: {reason: 'already_exists'},
      name: 'RemoteMemoryError',
    });
    await expect(
      repository.remember(principalA, failedCasInput, 'request-create-conflict-replay'),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: {reason: 'already_exists'},
      name: 'RemoteMemoryError',
    });
    await expect(
      repository.remember(
        principalA,
        {...failedCasInput, text: 'Changed payload after the failed CAS.'},
        'request-failed-cas-mismatch',
      ),
    ).rejects.toMatchObject({code: 'idempotency_mismatch', name: 'RemoteMemoryError'});
    await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction => transaction`
      UPDATE remote_memory.idempotency_records
      SET outcome = NULL, outcome_expires_at = ${new Date(0).toISOString()}
      WHERE tenant_id = ${TENANT_A} AND principal_id = ${PRINCIPAL_A} AND operation_id = 'cas-create'
    `,
    );
    await expect(repository.remember(principalA, createInput, 'request-expired-replay')).rejects.toMatchObject({
      code: 'idempotency_mismatch',
      details: {reason: 'outcome_expired'},
      name: 'RemoteMemoryError',
    });
    await expect(
      repository.remember(
        principalA,
        {...createInput, text: 'Changed payload after replay retention expired.'},
        'request-expired-mismatch',
      ),
    ).rejects.toMatchObject({code: 'idempotency_mismatch', name: 'RemoteMemoryError'});

    const contenders = await Promise.allSettled([
      repository.remember(
        principalA,
        rememberFixture({
          baseRevision: created.revision,
          operationId: 'cas-contender-alpha',
          text: 'Alpha won or lost, but overlayneedle remains immediately searchable.',
          topic: 'postgres-cas',
        }),
        'request-contender-alpha',
      ),
      repository.remember(
        principalA,
        rememberFixture({
          baseRevision: created.revision,
          operationId: 'cas-contender-beta',
          text: 'Beta won or lost, but overlayneedle remains immediately searchable.',
          topic: 'postgres-cas',
        }),
        'request-contender-beta',
      ),
    ]);
    const winners = EffectArray.filter(contenders, result => result.status === 'fulfilled');
    const conflicts = EffectArray.filter(contenders, result => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({reason: {code: 'conflict', name: 'RemoteMemoryError'}});
    const winningReceipt = winners[0].value;
    expect(winningReceipt).toMatchObject({indexedGeneration: 0, shareGeneration: 2});

    const laggingRecall = await repository.recall(
      principalA,
      {project: PROJECT, query: 'overlayneedle', version: 1},
      'request-lagging-recall',
    );
    expect(laggingRecall.results).toHaveLength(1);
    expect(laggingRecall.results[0]).toMatchObject({revision: winningReceipt.revision, topic: 'postgres-cas'});
    expect(laggingRecall.receipt).toMatchObject({
      consistency: 'recent-write-overlay',
      indexedGeneration: 0,
      shareGeneration: 2,
    });

    const mutationState = await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction =>
        transaction<
          {audits: string | number; idempotency: string | number; outbox: string | number; revisions: string | number}[]
        >`
        SELECT
          (SELECT count(*) FROM remote_memory.memory_revisions WHERE share_id = ${SHARE_A}) AS revisions,
          (SELECT count(*) FROM remote_memory.idempotency_records WHERE share_id = ${SHARE_A}) AS idempotency,
          (SELECT count(*) FROM remote_memory.outbox_events WHERE share_id = ${SHARE_A}) AS outbox,
          (SELECT count(*) FROM remote_memory.audit_events WHERE share_id = ${SHARE_A}) AS audits
      `,
    );
    expect(numericCounts(mutationState[0])).toEqual({audits: 2, idempotency: 4, outbox: 2, revisions: 2});

    expect(await indexer.runPass({batchSize: 16})).toEqual({failed: 0, processed: 2});
    const indexedRecall = await repository.recall(
      principalA,
      {project: PROJECT, query: 'overlayneedle', version: 1},
      'request-indexed-recall',
    );
    expect(indexedRecall.results[0]).toMatchObject({revision: winningReceipt.revision, topic: 'postgres-cas'});
    expect(indexedRecall.receipt).toMatchObject({
      consistency: 'current',
      indexedGeneration: 2,
      shareGeneration: 2,
    });
    const indexedState = await withTenant(
      fixture.sql,
      TENANT_A,
      transaction =>
        transaction<
          {
            indexed_generation: string | number;
            pending_outbox: string | number;
            projected_generation: string | number;
            projected_revision: string;
            share_generation: string | number;
          }[]
        >`
        SELECT s.share_generation, s.indexed_generation,
          (SELECT count(*) FROM remote_memory.outbox_events WHERE processed_at IS NULL) AS pending_outbox,
          d.generation AS projected_generation,
          d.revision_id AS projected_revision
        FROM remote_memory.shares s
        JOIN remote_memory.memory_heads h
          ON h.tenant_id = s.tenant_id AND h.share_id = s.id AND h.topic = 'postgres-cas'
        JOIN remote_memory.search_documents d
          ON d.tenant_id = h.tenant_id AND d.share_id = h.share_id AND d.head_id = h.id
      `,
    );
    expect(indexedState).toHaveLength(1);
    expect({
      ...indexedState[0],
      indexed_generation: Number(indexedState[0]?.indexed_generation),
      pending_outbox: Number(indexedState[0]?.pending_outbox),
      projected_generation: Number(indexedState[0]?.projected_generation),
      share_generation: Number(indexedState[0]?.share_generation),
    }).toMatchObject({
      indexed_generation: 2,
      pending_outbox: 0,
      projected_generation: 2,
      projected_revision: winningReceipt.revision,
      share_generation: 2,
    });
  });

  it('commits a same-identity explicit replacement URI and rejects other targets before reservation', async () => {
    const created = await repository.remember(
      principalA,
      rememberFixture({operationId: 'replace-uri-create', text: 'Initial.', topic: 'replace-uri'}),
      'request-replace-uri-create',
    );
    const historicalHash = await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction => transaction<{request_hash: string}[]>`
        SELECT request_hash FROM remote_memory.idempotency_records
        WHERE tenant_id = ${TENANT_A} AND principal_id = ${PRINCIPAL_A}
          AND operation_id = 'replace-uri-create'
      `,
    );
    expect(historicalHash).toEqual([
      {request_hash: '7af5efc1439a49d31529168287d154231ca066b210fe0b218e9414baa189d404'},
    ]);
    const updatedInput = {
      ...rememberFixture({
        baseRevision: created.revision!,
        operationId: 'replace-uri-update',
        text: 'Updated.',
        topic: 'replace-uri',
      }),
      replaceUri: created.uri!,
    };
    const updated = await repository.remember(principalA, updatedInput, 'request-replace-uri-update');
    expect(updated).toMatchObject({uri: created.uri});
    expect(updated.revision).not.toBe(created.revision);
    await expect(
      repository.remember(
        principalA,
        {
          ...updatedInput,
          operationId: 'replace-uri-other-share',
          replaceUri: formatRemoteMemoryUri({
            kind: 'durable',
            project: PROJECT,
            shareId: SHARE_B,
            topic: 'replace-uri',
          }),
        },
        'request-replace-uri-other-share',
      ),
    ).rejects.toMatchObject({code: 'forbidden', name: 'RemoteMemoryError'});
    await expect(
      repository.remember(
        principalA,
        {
          ...updatedInput,
          operationId: 'replace-uri-other-topic',
          replaceUri: formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE_A, topic: 'other'}),
        },
        'request-replace-uri-other-topic',
      ),
    ).rejects.toMatchObject({code: 'invalid_request', name: 'RemoteMemoryError'});
    await expect(
      repository.remember(
        principalA,
        {...updatedInput, operationId: 'replace-uri-no-base', baseRevision: undefined},
        'request-replace-uri-no-base',
      ),
    ).rejects.toMatchObject({code: 'invalid_request', name: 'RemoteMemoryError'});
    const read = await repository.read(principalA, {uri: created.uri!, version: 1}, 'request-replace-uri-read');
    expect(read.receipt.revision).toBe(updated.revision);
    expect(read.content).toContain('Updated.');
  });

  it('cancels a blocked write without a late commit and permanently binds its operation id', async () => {
    const input = rememberFixture({
      operationId: 'cancelled-blocked-write',
      text: 'This blocked write must never commit.',
      topic: 'cancelled-blocked-write',
    });
    const logicalKey = formatRemoteMemoryLogicalKey({
      kind: input.kind,
      project: input.project,
      shareId: principalA.shareId,
      tenantId: principalA.tenantId,
      topic: input.topic,
      version: REMOTE_MEMORY_REVISION_VERSION,
    });
    const controller = new AbortController();

    await fixture.migratorSql.begin(async lockTransaction => {
      await lockTransaction`SELECT pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`;
      const pending = repository.remember(principalA, input, 'request-cancelled-blocked-write', undefined, undefined, {
        deadlineEpochMilliseconds: Date.now() + 5_000,
        signal: controller.signal,
      });
      const settled = pending.then(
        value => ({kind: 'fulfilled' as const, value}),
        cause => ({cause, kind: 'rejected' as const}),
      );
      await waitUntil(async () => {
        const rows = await withTenant(
          fixture.migratorSql,
          TENANT_A,
          transaction => transaction<{blocked: boolean; reserved: boolean}[]>`
            SELECT
              EXISTS(
                SELECT 1 FROM remote_memory.idempotency_records
                WHERE principal_id = ${PRINCIPAL_A} AND operation_id = ${input.operationId}
              ) AS reserved,
              EXISTS(
                SELECT 1 FROM pg_locks waiting
                WHERE waiting.locktype = 'advisory' AND waiting.granted = false
                  AND waiting.database = (SELECT oid FROM pg_database WHERE datname = current_database())
              ) AS blocked
          `,
        );
        return rows[0]?.reserved === true && rows[0]?.blocked === true;
      });
      controller.abort();
      expect(await settled).toMatchObject({kind: 'rejected'});
    });

    const canonicalUri = formatRemoteMemoryUri({
      kind: input.kind,
      project: input.project,
      shareId: principalA.shareId,
      topic: input.topic,
    });
    const readHead = () =>
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction<{count: string | number}[]>`
          SELECT count(*) AS count FROM remote_memory.memory_heads
          WHERE share_id = ${SHARE_A} AND canonical_uri = ${canonicalUri}
        `,
      );
    expect(Number((await readHead())[0]?.count)).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(Number((await readHead())[0]?.count)).toBe(0);
    await expect(repository.remember(principalA, input, 'request-cancelled-replay')).rejects.toMatchObject({
      code: 'service_unavailable',
      details: {reason: 'outcome_ambiguous'},
      name: 'RemoteMemoryError',
    });
    await expect(
      repository.remember(
        principalA,
        {...input, text: 'A changed payload must not reuse the cancelled operation.'},
        'request-cancelled-mismatch',
      ),
    ).rejects.toMatchObject({code: 'idempotency_mismatch', name: 'RemoteMemoryError'});
  });

  it('fails closed when a member grant is revoked while a write is blocked on its head', async () => {
    const created = await repository.remember(
      principalA,
      rememberFixture({
        operationId: 'grant-race-create',
        text: 'Original content before the grant race.',
        topic: 'grant-race',
      }),
      'request-grant-race-create',
    );
    const update = rememberFixture({
      baseRevision: created.revision,
      operationId: 'grant-race-update',
      text: 'This update must not commit after revocation.',
      topic: 'grant-race',
    });
    let releaseHeadLock: () => void = () => {};
    const headLockReleased = new Promise<void>(resolve => {
      releaseHeadLock = resolve;
    });
    let reportHeadLocked: () => void = () => {};
    const headLocked = new Promise<void>(resolve => {
      reportHeadLocked = resolve;
    });
    const blocker = withTenant(fixture.migratorSql, TENANT_A, async transaction => {
      const rows = await transaction<{id: string}[]>`
        SELECT id FROM remote_memory.memory_heads
        WHERE share_id = ${SHARE_A} AND canonical_uri = ${created.uri!}
        FOR UPDATE
      `;
      if (!rows[0]) throw new Error('Grant-race head was not available to lock.');
      reportHeadLocked();
      await headLockReleased;
    });
    await headLocked;

    const pending = repository.remember(principalA, update, 'request-grant-race-update');
    const settled = pending.then(
      value => ({kind: 'fulfilled' as const, value}),
      cause => ({cause, kind: 'rejected' as const}),
    );
    await waitUntil(async () => {
      const rows = await withTenant(
        fixture.migratorSql,
        TENANT_A,
        transaction => transaction<{reserved: boolean}[]>`
          SELECT EXISTS(
            SELECT 1 FROM remote_memory.idempotency_records
            WHERE principal_id = ${PRINCIPAL_A} AND operation_id = ${update.operationId}
          ) AS reserved
        `,
      );
      return rows[0]?.reserved === true;
    });

    await withTenant(fixture.migratorSql, TENANT_A, async transaction => {
      await transaction`
        SELECT id FROM remote_memory.shares
        WHERE tenant_id = ${TENANT_A} AND id = ${SHARE_A}
        FOR UPDATE
      `;
      await transaction`
        UPDATE remote_memory.share_grants SET status = 'revoked'
        WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND principal_id = ${PRINCIPAL_A}
      `;
    });
    releaseHeadLock();
    await blocker;
    const outcome = await settled;

    await withTenant(fixture.migratorSql, TENANT_A, async transaction => {
      await transaction`
        SELECT id FROM remote_memory.shares
        WHERE tenant_id = ${TENANT_A} AND id = ${SHARE_A}
        FOR UPDATE
      `;
      await transaction`
        UPDATE remote_memory.share_grants SET status = 'active'
        WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND principal_id = ${PRINCIPAL_A}
      `;
    });

    expect(outcome).toMatchObject({cause: {code: 'forbidden', name: 'RemoteMemoryError'}, kind: 'rejected'});
    const unchanged = await repository.read(principalA, {uri: created.uri!, version: 1}, 'request-grant-race-read');
    expect(unchanged.receipt.revision).toBe(created.revision);
    expect(unchanged.content).toContain('Original content before the grant race.');
    await expect(repository.remember(principalA, update, 'request-grant-race-replay')).rejects.toMatchObject({
      code: 'forbidden',
      name: 'RemoteMemoryError',
    });
  });

  it('records explicit handoff expiry and archive revisions without permitting terminal reactivation', async () => {
    const created = await repository.remember(
      principalA,
      rememberFixture({
        kind: 'handoff',
        operationId: 'handoff-create',
        text: 'PostgreSQL handoff lifecycle.',
        topic: 'postgres-handoff',
      }),
      'request-handoff-create',
    );
    const expired = await repository.transitionHandoff(
      principalA,
      {
        baseRevision: created.revision!,
        operation: 'expire',
        operationId: 'handoff-expire',
        uri: created.uri!,
      },
      'request-handoff-expire',
    );
    expect(
      await repository.transitionHandoff(
        principalA,
        {
          baseRevision: created.revision!,
          operation: 'expire',
          operationId: 'handoff-expire',
          uri: created.uri!,
        },
        'request-handoff-expire-replay',
      ),
    ).toEqual({...expired, requestId: 'request-handoff-expire-replay'});
    const archived = await repository.transitionHandoff(
      principalA,
      {
        baseRevision: expired.revision!,
        operation: 'archive',
        operationId: 'handoff-archive',
        uri: created.uri!,
      },
      'request-handoff-archive',
    );
    await expect(
      repository.transitionHandoff(
        principalA,
        {
          baseRevision: archived.revision!,
          operation: 'revise',
          operationId: 'handoff-reactivate',
          uri: created.uri!,
        },
        'request-handoff-reactivate',
      ),
    ).rejects.toMatchObject({code: 'conflict', details: {reason: 'terminal_state'}, name: 'RemoteMemoryError'});

    await expect(
      repository.read(principalA, {uri: created.uri!, version: 1}, 'request-handoff-read'),
    ).resolves.toMatchObject({
      receipt: {revision: archived.revision},
      status: 'archived',
    });
    await expect(
      repository.read(
        principalA,
        {revision: expired.revision, uri: created.uri!, version: 1},
        'request-handoff-expired-read',
      ),
    ).resolves.toMatchObject({status: 'expired'});

    const rows = await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction =>
        transaction<{operation: string; status: string}[]>`
        SELECT r.status, a.operation
        FROM remote_memory.memory_revisions r
        JOIN remote_memory.audit_events a
          ON a.tenant_id = r.tenant_id AND a.share_id = r.share_id AND a.generation = r.generation
        WHERE r.head_id = (
          SELECT id FROM remote_memory.memory_heads WHERE canonical_uri = ${created.uri!}
        )
        ORDER BY r.generation
      `,
    );
    expect(rows).toEqual([
      {operation: 'remember_context', status: 'active'},
      {operation: 'handoff_expire', status: 'expired'},
      {operation: 'handoff_archive', status: 'archived'},
    ]);
    const projection = await indexer.runPass({batchSize: 16});
    expect(projection.failed).toBe(0);
    expect(projection.processed).toBeGreaterThanOrEqual(3);
  });

  it('uses FORCE RLS to isolate omitted predicates, aliases, and derived index rows across tenants', async () => {
    const memoryA = await repository.remember(
      principalA,
      rememberFixture({operationId: 'rls-alpha', text: 'Tenant alpha isolation marker.', topic: 'rls-alpha'}),
      'request-rls-alpha',
    );
    const memoryB = await repository.remember(
      principalB,
      rememberFixture({operationId: 'rls-beta', text: 'Tenant beta isolation marker.', topic: 'rls-beta'}),
      'request-rls-beta',
    );
    const aliasA = 'threadnote://user/legacy-alpha/memories/durable/projects/threadnote/rls-alpha.md';
    const aliasB = 'threadnote://user/legacy-beta/memories/durable/projects/threadnote/rls-beta.md';
    await insertAlias(fixture.migratorSql, TENANT_A, SHARE_A, aliasA, memoryA.uri!);
    await insertAlias(fixture.migratorSql, TENANT_B, SHARE_B, aliasB, memoryB.uri!);
    const projection = await indexer.runPass({batchSize: 32});
    expect(projection.failed).toBe(0);
    expect(projection.processed).toBeGreaterThanOrEqual(2);

    const tenantAView = await withTenant(fixture.sql, TENANT_A, async transaction => {
      const heads = await transaction<{tenant_id: string}[]>`
        SELECT tenant_id FROM remote_memory.memory_heads ORDER BY canonical_uri
      `;
      const aliases = await transaction<{alias_uri: string; tenant_id: string}[]>`
        SELECT tenant_id, alias_uri FROM remote_memory.uri_aliases ORDER BY alias_uri
      `;
      const documents = await transaction<{tenant_id: string}[]>`
        SELECT tenant_id FROM remote_memory.search_documents ORDER BY head_id
      `;
      const directCrossTenant = await transaction<{canonical_uri: string}[]>`
        SELECT canonical_uri FROM remote_memory.memory_heads WHERE canonical_uri = ${memoryB.uri!}
      `;
      return {aliases, directCrossTenant, documents, heads};
    });
    expect(tenantAView.heads.length).toBeGreaterThan(0);
    expect(EffectArray.every(tenantAView.heads, row => row.tenant_id === TENANT_A)).toBe(true);
    expect(tenantAView.aliases).toContainEqual({alias_uri: aliasA, tenant_id: TENANT_A});
    expect(EffectArray.every(tenantAView.aliases, row => row.tenant_id === TENANT_A)).toBe(true);
    expect(tenantAView.documents.length).toBeGreaterThan(0);
    expect(EffectArray.every(tenantAView.documents, row => row.tenant_id === TENANT_A)).toBe(true);
    expect(tenantAView.directCrossTenant).toEqual([]);

    await expect(repository.read(principalA, {uri: aliasA, version: 1}, 'request-alias-alpha')).resolves.toMatchObject({
      uri: memoryA.uri,
    });
    await expect(repository.read(principalA, {uri: aliasB, version: 1}, 'request-alias-beta')).rejects.toMatchObject({
      code: 'not_found',
      name: 'RemoteMemoryError',
    });
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
        INSERT INTO remote_memory.uri_aliases(tenant_id, share_id, alias_uri, canonical_uri, source)
        VALUES (${TENANT_B}, ${SHARE_B}, 'threadnote://user/cross/memories/durable/projects/threadnote/blocked.md', ${memoryB.uri!}, 'test')
      `,
      ),
    ).rejects.toMatchObject({code: '42501'});

    expect(await fixture.sql`SELECT tenant_id FROM remote_memory.memory_heads`).toEqual([]);
    expect(await fixture.sql`SELECT tenant_id FROM remote_memory.uri_aliases`).toEqual([]);
    expect(await fixture.sql`SELECT tenant_id FROM remote_memory.search_documents`).toEqual([]);
  });

  it('isolates two shares in one tenant even when SQL omits the share predicate', async () => {
    const first = await repository.remember(
      principalA,
      rememberFixture({operationId: 'same-tenant-first', text: 'First alpha share.', topic: 'same-tenant-first'}),
      'request-same-tenant-first',
    );
    const second = await repository.remember(
      principalASecondary,
      rememberFixture({operationId: 'same-tenant-second', text: 'Second alpha share.', topic: 'same-tenant-second'}),
      'request-same-tenant-second',
    );

    const sameTenantHeads = await withTenant(
      fixture.sql,
      TENANT_A,
      transaction => transaction<{canonical_uri: string; share_id: string}[]>`
        SELECT share_id, canonical_uri FROM remote_memory.memory_heads
        WHERE canonical_uri IN (${first.uri!}, ${second.uri!})
        ORDER BY share_id
      `,
    );
    expect(sameTenantHeads).toEqual([
      {canonical_uri: first.uri, share_id: SHARE_A},
      {canonical_uri: second.uri, share_id: SHARE_A_SECONDARY},
    ]);

    await expect(
      repository.read(principalA, {uri: second.uri!, version: 1}, 'request-cross-share-read'),
    ).rejects.toMatchObject({code: 'forbidden', name: 'RemoteMemoryError'});
    await expect(
      repository.read(principalASecondary, {uri: first.uri!, version: 1}, 'request-cross-share-read-reverse'),
    ).rejects.toMatchObject({code: 'forbidden', name: 'RemoteMemoryError'});
  });

  it('atomically claims a contended outbox event without counting a SKIP LOCKED miss as progress', async () => {
    expect(await indexer.runPass({batchSize: 1_000})).toMatchObject({failed: 0});
    await repository.remember(
      principalA,
      rememberFixture({
        operationId: 'indexer-contention',
        text: 'Exactly one indexer should project this outbox event.',
        topic: 'indexer-contention',
      }),
      'request-indexer-contention',
    );

    const contender = new RemoteMemoryIndexer(fixture.sql);
    const results = await Promise.all([indexer.runPass({batchSize: 1}), contender.runPass({batchSize: 1})]);
    expect(EffectArray.map(results, result => result.failed)).toEqual([0, 0]);
    expect(EffectArray.map(results, result => result.processed).sort()).toEqual([0, 1]);

    const projected = await withTenant(
      fixture.sql,
      TENANT_A,
      transaction => transaction<{count: string | number}[]>`
        SELECT count(*) AS count FROM remote_memory.search_documents
        WHERE share_id = ${SHARE_A} AND topic = 'indexer-contention'
      `,
    );
    expect(Number(projected[0]?.count)).toBe(1);
  });

  it('bounds cleanup while retaining idempotency tombstones for disabled and deleted tenant state', async () => {
    const now = new Date('2027-01-01T00:00:00.000Z');
    const remembered = await repository.remember(
      principalB,
      rememberFixture({
        operationId: 'cleanup-disabled-tenant',
        text: 'Cleanup state for a disabled tenant.',
        topic: 'cleanup-disabled-tenant',
      }),
      'request-cleanup-disabled-tenant',
    );
    const alias = 'threadnote://user/legacy-beta/memories/durable/projects/threadnote/cleanup-disabled-tenant.md';
    const attestationId = randomUuidV4();
    await withTenant(fixture.migratorSql, TENANT_B, async transaction => {
      await transaction`
        UPDATE remote_memory.idempotency_records SET outcome_expires_at = ${new Date(0).toISOString()}
        WHERE tenant_id = ${TENANT_B} AND principal_id = ${PRINCIPAL_B}
          AND operation_id = 'cleanup-disabled-tenant'
      `;
      await transaction`
        INSERT INTO remote_memory.uri_aliases(
          tenant_id, share_id, alias_uri, canonical_uri, source, expires_at
        ) VALUES (
          ${TENANT_B}, ${SHARE_B}, ${alias}, ${remembered.uri!}, 'git_beta_import', ${new Date(0).toISOString()}
        )
      `;
      await transaction`
        INSERT INTO remote_memory.workload_attestations(
          tenant_id, share_id, id, principal_id, issuer, subject, jwt_id, cloud_agent_id,
          turn_id, team_id, owner_id, repository_urls, expires_at
        ) VALUES (
          ${TENANT_B}, ${SHARE_B}, ${attestationId}, ${PRINCIPAL_B}, 'https://cursor.example',
          'sensitive-subject', ${randomUuidV4()}, 'sensitive-agent', 'sensitive-turn',
          'sensitive-team', 'sensitive-owner', ARRAY['https://github.com/private/repository.git'],
          ${new Date(0).toISOString()}
        )
      `;
      await transaction`UPDATE remote_memory.tenants SET status = 'disabled' WHERE id = ${TENANT_B}`;
      await transaction`UPDATE remote_memory.shares SET status = 'deleted' WHERE id = ${SHARE_B}`;
    });
    await fixture.migratorSql`
      UPDATE remote_memory.share_directory SET status = 'deleted' WHERE share_id = ${SHARE_B}
    `;

    const retention = new RemoteHandoffRetentionWorker(fixture.sql);
    await expect(retention.runPass(1, now)).resolves.toMatchObject({conflicted: 0});

    const cleaned = await withTenant(fixture.migratorSql, TENANT_B, async transaction => {
      const tombstone = await transaction<{outcome: unknown; request_hash: string}[]>`
        SELECT request_hash, outcome FROM remote_memory.idempotency_records
        WHERE principal_id = ${PRINCIPAL_B} AND operation_id = 'cleanup-disabled-tenant'
      `;
      const aliases = await transaction<{alias_uri: string}[]>`
        SELECT alias_uri FROM remote_memory.uri_aliases WHERE alias_uri = ${alias}
      `;
      const attestations = await transaction<
        {
          cloud_agent_id: string;
          issuer: string;
          jwt_id: string;
          owner_id: string | null;
          repository_urls: string[] | null;
          subject: string;
          team_id: string | null;
          turn_id: string | null;
        }[]
      >`
        SELECT issuer, subject, jwt_id, cloud_agent_id, turn_id, team_id, owner_id, repository_urls
        FROM remote_memory.workload_attestations WHERE id = ${attestationId}
      `;
      return {aliases, attestations, tombstone};
    });
    expect(cleaned.tombstone).toHaveLength(1);
    expect(cleaned.tombstone[0]).toMatchObject({outcome: null});
    expect(cleaned.tombstone[0]?.request_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(cleaned.aliases).toEqual([]);
    expect(cleaned.attestations).toEqual([
      {
        cloud_agent_id: 'expired',
        issuer: 'expired',
        jwt_id: `${TENANT_B}:${SHARE_B}:${attestationId}`,
        owner_id: null,
        repository_urls: null,
        subject: 'expired',
        team_id: null,
        turn_id: null,
      },
    ]);

    await expect(retention.runPass(1, now)).resolves.toMatchObject({conflicted: 0});
    const repeated = await withTenant(
      fixture.migratorSql,
      TENANT_B,
      transaction => transaction<{outcome: unknown; request_hash: string}[]>`
        SELECT request_hash, outcome FROM remote_memory.idempotency_records
        WHERE principal_id = ${PRINCIPAL_B} AND operation_id = 'cleanup-disabled-tenant'
      `,
    );
    expect(repeated).toEqual(cleaned.tombstone);
  });

  it('enforces same-head revision references without polluting count-sensitive scenarios', async () => {
    const firstHead = await repository.remember(
      principalA,
      rememberFixture({operationId: 'same-head-first', text: 'First head invariant.', topic: 'same-head-first'}),
      'request-same-head-first',
    );
    const secondHead = await repository.remember(
      principalA,
      rememberFixture({operationId: 'same-head-second', text: 'Second head invariant.', topic: 'same-head-second'}),
      'request-same-head-second',
    );
    const heads = await withTenant(
      fixture.migratorSql,
      TENANT_A,
      transaction => transaction<{head_id: string; revision_id: string; uri: string}[]>`
        SELECT h.id AS head_id, h.current_revision_id AS revision_id, h.canonical_uri AS uri
        FROM remote_memory.memory_heads h
        WHERE h.tenant_id = ${TENANT_A} AND h.share_id = ${SHARE_A}
          AND h.canonical_uri IN (${firstHead.uri!}, ${secondHead.uri!})
        ORDER BY h.canonical_uri
      `,
    );
    expect(heads).toHaveLength(2);
    const advanced = await repository.remember(
      principalA,
      rememberFixture({
        baseRevision: firstHead.revision!,
        operationId: 'same-head-first-advance',
        text: 'First head advanced revision.',
        topic: 'same-head-first',
      }),
      'request-same-head-first-advance',
    );
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          UPDATE remote_memory.memory_heads SET current_revision_id = NULL
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND id = ${heads[0].head_id}
        `,
      ),
    ).rejects.toSatisfy(isRevisionHeadGuardRejection);
    await expect(
      withTenant(
        fixture.sql,
        TENANT_A,
        transaction => transaction`
          UPDATE remote_memory.memory_heads SET current_revision_id = ${firstHead.revision!}
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND id = ${heads[0].head_id}
            AND current_revision_id = ${advanced.revision!}
        `,
      ),
    ).rejects.toSatisfy(isRevisionHeadGuardRejection);
    await expect(
      withTenant(
        fixture.migratorSql,
        TENANT_A,
        transaction => transaction`
          UPDATE remote_memory.memory_heads SET current_revision_id = ${heads[1].revision_id}
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND id = ${heads[0].head_id}
        `,
      ),
    ).rejects.toSatisfy(isRevisionHeadGuardRejection);
    await expect(
      withTenant(
        fixture.migratorSql,
        TENANT_A,
        transaction => transaction`
          INSERT INTO remote_memory.memory_revisions(
            tenant_id, share_id, id, head_id, base_revision_id, generation, status,
            markdown_body, content_hash, oauth_principal_id, operation_id
          ) VALUES (
            ${TENANT_A}, ${SHARE_A}, ${randomUuidV4()}, ${heads[0].head_id}, ${heads[1].revision_id},
            999999, 'active', 'invalid base head', 'invalid', ${PRINCIPAL_A}, 'invalid-base-head'
          )
        `,
      ),
    ).rejects.toMatchObject({code: '23503'});
  });

  it('fails closed when direct adapter export encounters dirty, local-identity, or malformed citations', async () => {
    const operator = new PostgresRemoteMemoryOperatorAdapter(fixture.migratorSql);
    const suffix = randomUuidV4();
    const scenarios = [
      {
        content: operatorCitationContent(`000-forged-export-dirty-${suffix}`, operatorCitation({sourceDirty: true})),
        shareId: SHARE_A,
        tenantId: TENANT_A,
        topic: `000-forged-export-dirty-${suffix}`,
      },
      {
        content: operatorCitationContent(
          `000-forged-export-local-${suffix}`,
          operatorCitation({repositoryIdentityKind: 'local'}),
        ),
        shareId: SHARE_A_SECONDARY,
        tenantId: TENANT_A,
        topic: `000-forged-export-local-${suffix}`,
      },
      {
        content: operatorMalformedCitationContent(`000-forged-export-malformed-${suffix}`),
        shareId: SHARE_A_MULTI_MEMBER,
        tenantId: TENANT_A,
        topic: `000-forged-export-malformed-${suffix}`,
      },
    ] as const;

    for (const scenario of scenarios) {
      await insertForgedPortableRow(
        fixture.migratorSql,
        scenario.tenantId,
        scenario.shareId,
        scenario.topic,
        scenario.content,
      );
      await expect(operator.exportRecords(scenario.shareId)).rejects.toThrow('code-citation sharing policy');
    }
  });
});

postgresDescribe('remote memory code-link migration upgrade', () => {
  it('enqueues and projects pre-existing heads through forced tenant RLS', async () => {
    if (!TEST_DATABASE_URL)
      throw new Error('THREADNOTE_TEST_POSTGRES_URL is required for PostgreSQL integration tests.');
    const upgradeFixture = await createRemoteMemoryPostgresFixture(TEST_DATABASE_URL);
    try {
      const control = new PostgresRemoteControlPlane(upgradeFixture.migratorSql);
      await control.provision(provisioningFixture('alpha-multi-primary'));
      const operator = new PostgresRemoteMemoryOperatorAdapter(upgradeFixture.migratorSql);
      const topic = `upgrade-code-link-${randomUuidV4()}`;
      const record = operatorPortableRecord(
        SHARE_A_MULTI_MEMBER,
        topic,
        operatorCitationContent(topic, operatorCitation()),
      );
      await operator.applyGitBetaImport(operatorImportInput(record, SHARE_A_MULTI_MEMBER));
      const head = await withTenant(
        upgradeFixture.migratorSql,
        TENANT_A,
        transaction => transaction<{head_id: string}[]>`
          SELECT id AS head_id FROM remote_memory.memory_heads
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A_MULTI_MEMBER} AND canonical_uri = ${record.uri}
        `,
      );
      if (!head[0]) throw new Error('Upgrade fixture head was not imported.');

      await upgradeFixture.migratorSql.unsafe(
        'DROP TABLE remote_memory.code_link_backlinks; DELETE FROM remote_memory.schema_migrations WHERE version = 5',
      );
      await migrateRemoteMemoryDatabase(upgradeFixture.migratorSql);
      const events = await withTenant(
        upgradeFixture.migratorSql,
        TENANT_A,
        transaction => transaction<{aggregate_id: string; event_type: string}[]>`
          SELECT aggregate_id, event_type FROM remote_memory.outbox_events
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A_MULTI_MEMBER}
            AND event_type = 'code_link_backfill' AND aggregate_id = ${head[0].head_id}
        `,
      );
      expect(events).toEqual([{aggregate_id: head[0].head_id, event_type: 'code_link_backfill'}]);

      await upgradeFixture.migratorSql.unsafe(
        `GRANT SELECT, INSERT, DELETE ON remote_memory.code_link_backlinks TO ${upgradeFixture.runtimeRoleName}`,
      );
      expect(await new RemoteMemoryIndexer(upgradeFixture.sql).runPass({batchSize: 16})).toMatchObject({failed: 0});
      const authorized = await new PostgresRemoteControlPlane(upgradeFixture.sql).authorize(
        claimsFixture('subject-alpha-multi-primary'),
        SHARE_A_MULTI_MEMBER,
      );
      if (!authorized) throw new Error('Upgrade fixture authorization failed.');
      const citation = operatorCitation();
      const brief = await new PostgresRemoteMemoryRepository(upgradeFixture.sql).contextBrief(
        authorized,
        {
          anchors: [{path: citation.path, repositoryId: citation.repositoryId}],
          budgetTokens: 1_250,
          project: PROJECT,
          task: 'canonical citation sharing policy',
          version: 1,
        },
        'request-upgrade-code-link',
      );
      expect(brief).toMatchObject({
        directSearchComplete: true,
        matchedAnchorOrdinals: [0],
        results: [expect.objectContaining({evidence: 'anchor', uri: record.uri})],
      });
    } finally {
      await upgradeFixture.dispose();
    }
  });
});

postgresDescribe('remote memory identity binding migration upgrade', () => {
  it('preserves existing identities and adds safe grant defaults', async () => {
    if (!TEST_DATABASE_URL)
      throw new Error('THREADNOTE_TEST_POSTGRES_URL is required for PostgreSQL integration tests.');
    const upgradeFixture = await createRemoteMemoryPostgresFixture(TEST_DATABASE_URL);
    try {
      const control = new PostgresRemoteControlPlane(upgradeFixture.migratorSql);
      await control.provision(provisioningFixture('alpha'));
      await upgradeFixture.migratorSql.unsafe(`
        DROP TABLE remote_memory.provisioning_receipts;
        DROP INDEX remote_memory.share_grants_active_expiry;
        ALTER TABLE remote_memory.share_grants DROP COLUMN expires_at;
        ALTER TABLE remote_memory.share_grants DROP COLUMN cloud_admission_required;
        ALTER TABLE remote_memory.external_identities DROP CONSTRAINT external_identities_pkey;
        ALTER TABLE remote_memory.external_identities DROP COLUMN client_id;
        ALTER TABLE remote_memory.external_identities ADD PRIMARY KEY (tenant_id, issuer, subject);
        DELETE FROM remote_memory.schema_migrations WHERE version IN (6, 7);
      `);

      await migrateRemoteMemoryDatabase(upgradeFixture.migratorSql);
      const identities = await withTenant(
        upgradeFixture.migratorSql,
        TENANT_A,
        transaction => transaction<{client_id: string; subject: string}[]>`
          SELECT client_id, subject FROM remote_memory.external_identities
          WHERE tenant_id = ${TENANT_A} AND issuer = ${ISSUER}
        `,
      );
      const grant = await withTenant(
        upgradeFixture.migratorSql,
        TENANT_A,
        transaction => transaction<{cloud_admission_required: boolean; expires_at: Date | null}[]>`
          SELECT cloud_admission_required, expires_at FROM remote_memory.share_grants
          WHERE tenant_id = ${TENANT_A} AND share_id = ${SHARE_A} AND principal_id = ${PRINCIPAL_A}
        `,
      );
      expect(identities).toEqual([{client_id: '', subject: 'subject-alpha'}]);
      expect(grant).toEqual([{cloud_admission_required: false, expires_at: null}]);
      await expect(control.provision(provisioningFixture('alpha'))).resolves.toBeUndefined();
      await expect(control.authorize(claimsFixture('subject-alpha'), SHARE_A)).resolves.toMatchObject({
        cloudAdmissionRequired: false,
        principalId: PRINCIPAL_A,
      });
    } finally {
      await upgradeFixture.dispose();
    }
  });
});

const tenantScopedTableNames = [
  'attestation_challenges',
  'audit_events',
  'code_link_backlinks',
  'context_health_policies',
  'context_health_receipts',
  'context_health_schedules',
  'durable_memory_proposals',
  'external_identities',
  'idempotency_records',
  'memory_heads',
  'memory_revisions',
  'outbox_events',
  'principals',
  'provisioning_receipts',
  'grant_policy_versions',
  'share_policy_versions',
  'rate_limit_windows',
  'project_repository_bindings',
  'projects',
  'search_documents',
  'share_grants',
  'shares',
  'tenants',
  'tenant_memberships',
  'git_beta_import_receipts',
  'uri_aliases',
  'workload_attestations',
] as const;

function claimsFixture(subject: string, clientId?: string): OAuthPrincipalClaims {
  return {...(clientId === undefined ? {} : {clientId}), issuer: ISSUER, scopes: new Set(ALL_SCOPES), subject};
}

function provisioningFixture(
  identity: 'alpha' | 'alpha-secondary' | 'alpha-multi-primary' | 'alpha-multi-member' | 'beta',
): RemoteMemoryProvisioningInput {
  const tenantAlpha = identity !== 'beta';
  const primaryAlpha = identity === 'alpha';
  const multiPrimary = identity === 'alpha-multi-primary';
  const multiMember = identity === 'alpha-multi-member';
  if (multiPrimary || multiMember) {
    return {
      allowedProjects: [multiPrimary ? PROJECT : 'api'],
      capabilities: ALL_SCOPES,
      cursorAttestationRequired: false,
      cursorSubjects: [`user:${multiPrimary ? '1001' : '1002'}`],
      displayName: 'PostgreSQL alpha multi-member share',
      ...(multiMember
        ? {}
        : {
            featureFlags: [
              'remote_memory_read',
              'remote_memory_durable_write',
              'remote_memory_handoff_write',
              'remote_memory_ga',
              'git_beta_import',
            ] as const,
            projects: [PROJECT, 'api'],
            repositoryBindings: {
              api: ['https://github.com/example/api.git'],
              [PROJECT]: ['https://github.com/example/threadnote.git'],
            },
            sharePolicyVersion: 'share-v1',
          }),
      issuer: ISSUER,
      policyVersion: multiPrimary ? 'grant-primary-v1' : 'grant-member-v1',
      principalId: multiPrimary ? PRINCIPAL_A : PRINCIPAL_A_MEMBER_TWO,
      region: 'test-region',
      shareId: SHARE_A_MULTI_MEMBER,
      subject: multiMember ? 'subject-alpha-member-two' : `subject-${identity}`,
      tenantId: TENANT_A,
    };
  }
  return {
    allowedProjects: [PROJECT],
    capabilities: ALL_SCOPES,
    cursorAttestationRequired: false,
    cursorSubjects: [`user:${primaryAlpha ? '2001' : identity === 'alpha-secondary' ? '2002' : '3001'}`],
    displayName: `PostgreSQL ${identity}`,
    featureFlags: [
      'remote_memory_read',
      'remote_memory_durable_write',
      'remote_memory_handoff_write',
      'remote_memory_ga',
    ],
    issuer: ISSUER,
    policyVersion: 'policy-v1',
    principalId: primaryAlpha ? PRINCIPAL_A : identity === 'alpha-secondary' ? PRINCIPAL_A_SECONDARY : PRINCIPAL_B,
    projects: [PROJECT],
    region: 'test-region',
    repositoryBindings: {[PROJECT]: [`https://github.com/example/threadnote-${identity}.git`]},
    shareId: primaryAlpha ? SHARE_A : identity === 'alpha-secondary' ? SHARE_A_SECONDARY : SHARE_B,
    subject: `subject-${identity}`,
    tenantId: tenantAlpha ? TENANT_A : TENANT_B,
  };
}

function rememberFixture(
  input: Readonly<{
    baseRevision?: string;
    kind?: 'durable' | 'handoff';
    operationId: string;
    text: string;
    topic: string;
  }>,
): RemoteRememberInputV1 {
  return {
    ...(input.baseRevision ? {baseRevision: input.baseRevision} : {}),
    kind: input.kind ?? 'durable',
    operationId: input.operationId,
    project: PROJECT,
    text: input.text,
    topic: input.topic,
    version: 1,
  };
}

function operatorCitation(
  overrides: {
    readonly path?: string;
    readonly repositoryId?: string;
    readonly repositoryIdentityKind?: 'local' | 'remote';
    readonly sourceDirty?: boolean;
  } = {},
) {
  return createMemoryCodeCitation({
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256', value: Effect.pipe('a', EffectString.repeat(64))},
    path: overrides.path ?? 'src/remote_memory/operator/postgres.ts',
    repositoryId: overrides.repositoryId ?? Effect.pipe('b', EffectString.repeat(64)),
    repositoryIdentityKind: overrides.repositoryIdentityKind ?? 'remote',
    sourceCommit: Effect.pipe('c', EffectString.repeat(40)),
    sourceDirty: overrides.sourceDirty ?? false,
    sourceSnapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}`,
    target: {kind: 'file'},
    version: 1,
  });
}

function operatorCitationContent(topic: string, citation: ReturnType<typeof operatorCitation>): string {
  return formatMemoryDocument(
    'MEMORY',
    {
      codeCitations: [citation],
      kind: 'durable',
      project: PROJECT,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-08-26T20:00:00.000Z',
      topic,
    },
    'Direct operator portability must enforce the canonical citation sharing policy.',
  );
}

function operatorMalformedCitationContent(topic: string): string {
  return Effect.pipe(
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        project: PROJECT,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceAgentClient: 'codex',
        status: 'active',
        timestamp: '2026-08-26T20:00:00.000Z',
        topic,
      },
      'Malformed citation metadata must not cross the direct operator boundary.',
    ),
    EffectString.replace(
      `schema_version: ${MEMORY_SCHEMA_VERSION}`,
      `schema_version: ${MEMORY_SCHEMA_VERSION}\n  code_citation: {not-json}`,
    ),
  );
}

function operatorPortableRecord(
  shareId: string,
  topic: string,
  canonicalContent: string,
): RemoteMemoryPortableRecordV1 {
  return {
    aliases: [`threadnote://user/import/memories/shared/team/durable/projects/${PROJECT}/${topic}.md`],
    canonicalContent,
    contentHash: sha256HexSync(canonicalContent),
    kind: 'durable',
    project: PROJECT,
    topic,
    uri: formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId, topic}),
    version: 1,
  };
}

function operatorImportInput(record: RemoteMemoryPortableRecordV1, shareId: string) {
  const planDigest = sha256HexSync(`direct-operator:${record.uri}`);
  return {
    aliasCompatibilityEndsAt: '2099-01-01T00:00:00.000Z',
    planDigest,
    planId: `tnmi_${Effect.pipe(planDigest, EffectString.slice(0, 32))}`,
    records: [record],
    shareId,
  };
}

async function insertForgedPortableRow(
  sql: Sql,
  tenantId: string,
  shareId: string,
  topic: string,
  content: string,
): Promise<void> {
  const headId = randomUuidV4();
  const revisionId = randomUuidV4();
  const uri = formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId, topic});
  await withTenant(sql, tenantId, async transaction => {
    await transaction`
      INSERT INTO remote_memory.principals(tenant_id, id, status)
      VALUES (${tenantId}, 'system:forged-export-test', 'active')
      ON CONFLICT (tenant_id, id) DO NOTHING
    `;
    const generations = await transaction<{share_generation: string | number}[]>`
      UPDATE remote_memory.shares SET share_generation = share_generation + 1
      WHERE tenant_id = ${tenantId} AND id = ${shareId} AND status = 'active'
      RETURNING share_generation
    `;
    const generation = generations[0]?.share_generation;
    if (generation === undefined) throw new Error('Forged export test share is not active.');
    await transaction`
      INSERT INTO remote_memory.memory_heads(
        tenant_id, share_id, id, kind, project, topic, canonical_uri, status
      ) VALUES (${tenantId}, ${shareId}, ${headId}, 'durable', ${PROJECT}, ${topic}, ${uri}, 'active')
    `;
    await transaction`
      INSERT INTO remote_memory.memory_revisions(
        tenant_id, share_id, id, head_id, generation, status, markdown_body, content_hash,
        oauth_principal_id, operation_id
      ) VALUES (
        ${tenantId}, ${shareId}, ${revisionId}, ${headId}, ${generation}, 'active', ${content},
        ${sha256HexSync(content)}, 'system:forged-export-test', ${`forged-export:${topic}`}
      )
    `;
    await transaction`
      UPDATE remote_memory.memory_heads SET current_revision_id = ${revisionId}
      WHERE tenant_id = ${tenantId} AND share_id = ${shareId} AND id = ${headId}
    `;
  });
}

async function withTenant<A>(sql: Sql, tenantId: string, use: (transaction: TransactionSql) => Promise<A>): Promise<A> {
  return sql
    .begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
      return {result: await use(transaction)};
    })
    .then(({result}) => result);
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for PostgreSQL test state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function insertAlias(sql: Sql, tenantId: string, shareId: string, aliasUri: string, canonicalUri: string) {
  await withTenant(
    sql,
    tenantId,
    transaction => transaction`
    INSERT INTO remote_memory.uri_aliases(tenant_id, share_id, alias_uri, canonical_uri, source)
    VALUES (${tenantId}, ${shareId}, ${aliasUri}, ${canonicalUri}, 'git_beta_import')
  `,
  );
}

function numericCounts(input: Readonly<Record<'audits' | 'idempotency' | 'outbox' | 'revisions', string | number>>) {
  return {
    audits: Number(input.audits),
    idempotency: Number(input.idempotency),
    outbox: Number(input.outbox),
    revisions: Number(input.revisions),
  };
}

function isPrivilegeOrImmutableRejection(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const record = cause as {code?: unknown; message?: unknown};
  return (
    record.code === '42501' ||
    (typeof record.message === 'string' &&
      Effect.pipe(record.message, EffectString.includes('immutable record cannot be updated or deleted')))
  );
}

function isRevisionHeadGuardRejection(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const record = cause as {code?: unknown; message?: unknown};
  return (
    record.code === '23503' ||
    (record.code === 'P0001' &&
      typeof record.message === 'string' &&
      Effect.pipe(record.message, EffectString.includes('revision')))
  );
}

function isAttestationMinimizationRejection(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const record = cause as {code?: unknown; message?: unknown};
  return (
    record.code === 'P0001' &&
    typeof record.message === 'string' &&
    Effect.pipe(record.message, EffectString.includes('may only minimize expired attribution'))
  );
}
