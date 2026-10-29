import {isJsonObject} from '@threadnote/platform/json';
import {Array as EffectArray} from 'effect';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {mkdir, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {dirname, join} from '@threadnote/testing/node-path';
import {testGitWorktreeLock} from '../helpers/git-worktree-lock.js';
import {
  cloneGitShareWorktree,
  createGitShareWorktreeFixture,
  git,
  type GitShareWorktreeFixture,
} from '@threadnote/testing/git-share-worktree';
import {
  createRemoteMemoryPostgresFixture,
  type RemoteMemoryPostgresFixture,
} from '../helpers/remote-memory-postgres.js';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {formatRemoteMemoryUri} from '@threadnote/memory/remote/address';
import {parseRemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import {buildOrgCloudHybridMcpConfig, type CursorCloudProfileV1} from '@threadnote/threadnote/cursor/cloud';
import {orgCloudRepositorySetDigest} from '@threadnote/remote-memory/cloud_admission';
import {remoteMemoryConfigFromEnvironment} from '@threadnote/remote-memory/config';
import {
  GitCanonicalMemoryStore,
  gitCanonicalSharePath,
  type GitCanonicalCommitInput,
  type GitCanonicalCommitResult,
} from '@threadnote/remote-memory/git/canonical_store';
import {createRemoteMemoryHttpHandler} from '@threadnote/threadnote/remote_memory/http_transport';
import {PostgresRemoteControlPlane} from '@threadnote/remote-memory/postgres/control_plane';
import {PostgresRemoteMemoryRepository} from '@threadnote/remote-memory/postgres/repository';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

type RemoteMemoryRpcBody = {
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
    readonly content?: unknown;
  };
};

function requireCursorAttestationId(value: unknown): string {
  if (!isJsonObject(value) || typeof value.attestationId !== 'string')
    throw new Error('Expected a cursor attestation identifier.');
  return value.attestationId;
}

function assertRemoteMemoryRpcBody(value: unknown): asserts value is RemoteMemoryRpcBody {
  if (!isJsonObject(value)) throw new Error('Expected a remote memory JSON-RPC response.');
  if (value.result === undefined) return;
  if (!isJsonObject(value.result)) throw new Error('Expected a remote memory JSON-RPC result.');
  if (value.result.isError !== undefined && typeof value.result.isError !== 'boolean')
    throw new Error('Expected a boolean JSON-RPC error marker.');
  if (value.result.structuredContent !== undefined && !isJsonObject(value.result.structuredContent))
    throw new Error('Expected structured JSON-RPC content.');
}

const databaseUrl = process.env.THREADNOTE_TEST_POSTGRES_URL;
const shareId = 'org-cloud-acceptance';
const tenantId = 'org-cloud-tenant';
const project = 'threadnote';
const repositoryBinding = 'github.com/example/org-cloud';
const issuer = 'https://identity.example.test/oauth2/pilot';
const profile: CursorCloudProfileV1 = {
  account: 'local',
  agentId: 'cloud',
  graphMode: 'local-checkout',
  homeDurability: 'ephemeral',
  memoryRoot: 'threadnote://user/laptop/memories/shared/pilot',
  profile: 'shared-read-write',
  provider: 'cursor-cloud',
  team: 'pilot',
  user: 'laptop',
  version: 1,
};
const endpoint = 'https://composer.example.test/mcp';
const cloudConfig = (contribute = false) =>
  buildOrgCloudHybridMcpConfig(profile, endpoint, shareId, 'cloud-client', {
    repositories: [repositoryBinding],
    contribute,
  });

(databaseUrl ? describe : describe.skip)('organization Cloud cross-client acceptance', () => {
  let database: RemoteMemoryPostgresFixture;
  let fixture: GitShareWorktreeFixture;
  let repository: PostgresRemoteMemoryRepository;
  let gitStore: ControlledGitCanonicalMemoryStore;
  let control: PostgresRemoteControlPlane;
  let handler: ReturnType<typeof createRemoteMemoryHttpHandler>;
  let enabled = true;
  let pauseAfterAuthorization: (() => Promise<void>) | undefined;
  let provisionInput: Parameters<PostgresRemoteControlPlane['provision']>[0];

  beforeAll(async () => {
    database = await createRemoteMemoryPostgresFixture(databaseUrl!);
    fixture = await createGitShareWorktreeFixture('threadnote-org-cloud-');
    provisionInput = {
      allowedProjects: [project],
      capabilities: ['memory:read', 'memory:write:durable'],
      clientId: 'cloud-client',
      cloudAdmissionRequired: true,
      cursorAttestationRequired: true,
      cursorSubjects: ['user:12345'],
      displayName: 'Synthetic org Cloud acceptance',
      featureFlags: ['remote_memory_ga', 'remote_memory_read', 'remote_memory_durable_write'],
      issuer,
      policyVersion: 'cloud-v1',
      principalId: 'cloud-principal',
      projects: [project],
      region: 'test',
      repositoryBindings: {[project]: [`https://${repositoryBinding}.git`]},
      shareId,
      subject: 'cloud-subject',
      tenantId,
    };
    await new PostgresRemoteControlPlane(database.migratorSql).provision(provisionInput);
    control = new PostgresRemoteControlPlane(database.sql);
    gitStore = new ControlledGitCanonicalMemoryStore({
      binding: {shareId, tenantId},
      worktree: fixture.worktree,
      worktreeLock: testGitWorktreeLock,
    });
    repository = new PostgresRemoteMemoryRepository(database.sql, {gitStore});
    const config = remoteMemoryConfigFromEnvironment({
      THREADNOTE_REMOTE_PUBLIC_URL: 'https://composer.example.test',
      THREADNOTE_REMOTE_DATABASE_URL: database.runtimeDatabaseUrl,
      THREADNOTE_REMOTE_OAUTH_ISSUER: issuer,
      THREADNOTE_REMOTE_CANONICAL_STORE: 'git',
      THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE: fixture.worktree,
      THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID: tenantId,
      THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID: shareId,
    });
    const dependencies = {
      attestations: control,
      authorization: {
        authorize: async (...args: Parameters<PostgresRemoteControlPlane['authorize']>) => {
          const principal = await control.authorize(...args);
          if (principal) await pauseAfterAuthorization?.();
          return principal;
        },
      },
      // Synthetic verifier boundaries; storage, policy, attestation lifecycle, HTTP MCP, and Git are real.
      oauthTokens: {
        verify: async (token: string) => ({
          issuer,
          subject: 'cloud-subject',
          clientId: 'cloud-client',
          scopes: new Set(token === 'reader' ? ['memory:read'] : ['memory:read', 'memory:write:durable']),
        }),
      },
      cursorTokens: {
        verify: async (_token: string, nonce: string) => ({
          cloudAgentId: 'synthetic-cloud',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          issuer: 'https://api.cursor.com',
          jti: 'synthetic-jti',
          nonce,
          repositoryUrls: [repositoryBinding],
          subject: 'user:12345',
        }),
      },
      rateLimits: {consume: async () => undefined},
      readiness: async () => enabled,
      repository,
    };
    handler = request =>
      createRemoteMemoryHttpHandler({config: {...config, globallyEnabled: enabled}, dependencies})(request);
  });

  afterAll(async () => {
    const cleanup = await Promise.allSettled([
      database?.dispose(),
      fixture ? rm(fixture.root, {recursive: true, force: true}) : Promise.resolve(),
    ]);
    const failures = EffectArray.filter(
      cleanup,
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0)
      throw new AggregateError(
        EffectArray.map(failures, result => result.reason),
        'Acceptance cleanup failed.',
      );
  });

  it('round-trips reviewed Git records with fail-closed Cloud admission and independent local evidence', async () => {
    const topic = 'reviewed-laptop-record';
    const path = gitCanonicalSharePath('durable', project, topic);
    const laptop = await cloneGitShareWorktree(fixture.remote, join(fixture.root, 'reviewed-laptop'));
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        visibility: 'shared',
        project,
        topic,
        sourceAgentClient: 'share',
        timestamp: '2026-09-18T00:00:00.000Z',
      },
      'Reviewed synthetic laptop decision.',
    );
    await mkdir(dirname(join(laptop, path)), {recursive: true});
    await writeFile(join(laptop, path), content);
    await git(['add', '--', path], laptop);
    await git(['commit', '-m', 'reviewed synthetic decision'], laptop);
    await git(['push', 'origin', 'main'], laptop);
    await repository.ingestActiveGitShares('org-cloud-ingest');
    const uri = formatRemoteMemoryUri({kind: 'durable', project, shareId, topic});
    const read = await call('read_context', {uri, version: 1});
    expect(JSON.stringify(read.result)).toContain('Reviewed synthetic laptop decision.');
    const receipt = parseRemoteMemoryReceiptV1(read.result!.structuredContent!.receipt);
    expect(receipt.shareId).toBe(shareId);
    expect(typeof receipt.revision).toBe('string');
    expect(read.response.headers.get('threadnote-memory-authority')).toBe('git');
    expect(read.response.headers.get('threadnote-repository-set')).toBe(
      orgCloudRepositorySetDigest(shareId, [repositoryBinding]),
    );

    const write = {
      kind: 'durable',
      project,
      topic,
      text: 'Authorized synthetic Cloud decision.',
      baseRevision: receipt.revision,
      version: 1,
    };
    expect(errorCode(await call('remember_context', {...write, operationId: 'reader-denied'}))).toBe('forbidden');
    expect(
      errorCode(await call('remember_context', {...write, operationId: 'broad-token-denied'}, false, 'writer')),
    ).toBe('forbidden');
    expect(
      (await call('remember_context', {...write, operationId: 'headerless-denied'}, false, 'writer', {}, false))
        .response.status,
    ).toBe(403);
    expect(
      errorCode(await call('remember_context', {...write, operationId: 'reader-contribution-denied'}, true, 'reader')),
    ).toBe('forbidden');
    expect(errorCode(await call('remember_context', {...write, operationId: 'unattested-denied'}, true))).toBe(
      'attestation_required',
    );

    const challenge = (await call('begin_cursor_attestation', {version: 1}, true)).result!.structuredContent!;
    const completion = await handler(
      new Request('https://composer.example.test/attest/cursor/complete', {
        method: 'POST',
        headers: {host: 'composer.example.test', 'content-type': 'application/json'},
        body: JSON.stringify({challengeId: challenge.challengeId, token: 'synthetic-workload-token'}),
      }),
    );
    expect(completion.status).toBe(200);
    const completionPayload: unknown = await completion.json();
    const attestationId = requireCursorAttestationId(completionPayload);
    const written = await call('remember_context', {...write, attestationId, operationId: 'cloud-write'}, true);
    expect(written.result?.isError).not.toBe(true);
    const committed = parseRemoteMemoryReceiptV1(written.result!.structuredContent!);
    expect(committed.shareId).toBe(shareId);
    expect(typeof committed.revision).toBe('string');
    expect(committed.actor?.provider).toBe('cursor');
    expect(committed.revision).not.toBe(receipt.revision);
    const committedRevision = committed.revision;
    if (!committedRevision) throw new Error('Cloud write did not return a revision.');
    const staleText = 'Rejected stale Cloud mutation.';
    expect(
      errorCode(
        await call('remember_context', {...write, text: staleText, attestationId, operationId: 'stale-cas'}, true),
      ),
    ).toBe('conflict');
    await expectCanonicalWinner(uri, path, committedRevision, write.text, [staleText]);

    const cold = await cloneGitShareWorktree(fixture.remote, join(fixture.root, 'cold-laptop'));
    const imported = parseMemoryDocument(uri, await readFile(join(cold, path), 'utf8'));
    expect(imported?.body).toContain('Authorized synthetic Cloud decision.');
    const home = join(fixture.root, 'cold-home');
    await cli(['share', 'init', fixture.remote, '--team', 'pilot', '--read-only', '--home', home]);
    await withLocal(home, false, async client => {
      const localRead = await client.callTool({
        name: 'read_context',
        arguments: {uri: `threadnote://user/laptop/memories/shared/pilot/durable/projects/${project}/${topic}.md`},
      });
      expect(localRead.isError).not.toBe(true);
      expect(JSON.stringify(localRead)).toContain('Authorized synthetic Cloud decision.');
    });
    const bodies = await database.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
      return transaction<{markdown_body: string}[]>`SELECT markdown_body FROM remote_memory.memory_revisions`;
    });
    expect(bodies.length).toBeGreaterThan(0);
    expect(EffectArray.every(bodies, row => row.markdown_body === '')).toBe(true);

    const wrongBindings: Record<string, string>[] = [
      {'threadnote-share-id': 'wrong-share'},
      {'threadnote-repository-set': orgCloudRepositorySetDigest(shareId, ['github.com/example/stale'])},
    ];
    for (const headers of wrongBindings)
      expect((await call('read_context', {uri, version: 1}, false, 'reader', headers)).response.status).toBe(403);

    const nearExpiry = new Date(Date.now() + 32_000).toISOString();
    await new PostgresRemoteControlPlane(database.migratorSql).provision({
      ...provisionInput,
      grantExpiresAt: nearExpiry,
      policyVersion: 'cloud-expiring-v2',
      expectedCurrentPolicyVersion: 'cloud-v1',
    });
    const reachedRefAuthorization = deferred();
    const resumeRefAuthorization = deferred();
    const grantTableLocked = deferred();
    const releaseGrantTable = deferred();
    let grantTableLock: Promise<unknown> | undefined;
    gitStore.beforeAuthorizeRefUpdate = async () => {
      grantTableLock = database.migratorSql.begin(async transaction => {
        await transaction.unsafe('LOCK TABLE remote_memory.share_grants IN ACCESS EXCLUSIVE MODE');
        grantTableLocked.resolve();
        await releaseGrantTable.promise;
      });
      await grantTableLocked.promise;
      reachedRefAuthorization.resolve();
      await resumeRefAuthorization.promise;
    };
    const expiringText = 'Rejected expired in-flight Cloud mutation.';
    const expiringWrite = call(
      'remember_context',
      {...write, text: expiringText, attestationId, operationId: 'expiring-write', baseRevision: committedRevision},
      true,
    );
    await Promise.race([
      reachedRefAuthorization.promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Write did not reach the pre-ref authorization barrier.')), 5_000),
      ),
    ]);
    resumeRefAuthorization.resolve();
    try {
      await expect
        .poll(
          async () => {
            const [row] = await database.migratorSql<{blocked: boolean}[]>`
              SELECT EXISTS (
                SELECT 1 FROM pg_locks
                WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
                  AND relation = 'remote_memory.share_grants'::regclass
                  AND NOT granted
              ) AS blocked
            `;
            return row?.blocked;
          },
          {timeout: 5_000},
        )
        .toBe(true);
      await new Promise(resolve => setTimeout(resolve, 3_000));
    } finally {
      releaseGrantTable.resolve();
      await grantTableLock;
    }
    expect(errorCode(await expiringWrite)).toBe('forbidden');
    gitStore.beforeAuthorizeRefUpdate = undefined;
    await new PostgresRemoteControlPlane(database.migratorSql).provision({
      ...provisionInput,
      policyVersion: 'cloud-writer-v3',
      expectedCurrentPolicyVersion: 'cloud-expiring-v2',
    });
    await expectCanonicalWinner(uri, path, committedRevision, write.text, [staleText, expiringText]);
    const authenticatedBeforeDowngrade = deferred();
    const resumeAfterDowngrade = deferred();
    pauseAfterAuthorization = async () => {
      authenticatedBeforeDowngrade.resolve();
      await resumeAfterDowngrade.promise;
    };
    const revokedText = 'Rejected revoked in-flight Cloud mutation.';
    const revokedWrite = call(
      'remember_context',
      {...write, text: revokedText, attestationId, operationId: 'revoked-write', baseRevision: committedRevision},
      true,
    );
    await authenticatedBeforeDowngrade.promise;
    await new PostgresRemoteControlPlane(database.migratorSql).provision({
      ...provisionInput,
      capabilities: ['memory:read'],
      policyVersion: 'cloud-reader-v4',
      expectedCurrentPolicyVersion: 'cloud-writer-v3',
    });
    resumeAfterDowngrade.resolve();
    expect(errorCode(await revokedWrite)).toBe('forbidden');
    pauseAfterAuthorization = undefined;
    await expectCanonicalWinner(uri, path, committedRevision, write.text, [staleText, expiringText, revokedText]);

    await new PostgresRemoteControlPlane(database.migratorSql).provision({
      ...provisionInput,
      capabilities: ['memory:read'],
      policyVersion: 'cloud-reader-v2',
      sharePolicyVersion: 'cloud-share-v2',
      expectedCurrentPolicyVersion: 'cloud-reader-v4',
      expectedCurrentSharePolicyVersion: 'cloud-v1',
      repositoryBindings: {[project]: ['https://github.com/example/changed.git']},
    });
    expect((await call('read_context', {uri, version: 1})).response.status).toBe(403);

    enabled = false;
    expect((await call('read_context', {uri, version: 1})).response.status).toBe(503);
    await withLocal(home, true, async client => {
      expect(EffectArray.map((await client.listTools()).tools, tool => tool.name)).toContain('inspect_code_graph');
      const status = await client.callTool({name: 'cursor_cloud_status', arguments: {callerCwd: cold}});
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({status: 'ok', shareId, localMemoryFallback: 'disabled'});
      const graph = await client.callTool({
        name: 'inspect_code_graph',
        arguments: {operation: 'query', query: 'readme', callerCwd: cold},
      });
      expect(graph.isError).not.toBe(true);
    });
    // Only these content-free receipts are suitable for retained acceptance evidence.
    const evidence = {
      version: 1,
      shareId,
      provenance: 'git',
      repositorySet: orgCloudRepositorySetDigest(shareId, [repositoryBinding]),
      revision: committed.revision,
      freshness: committed.consistency,
      checks: [
        'laptop-cloud',
        'cloud-cold-laptop',
        'cas',
        'read-only',
        'binding',
        'in-flight-expiry',
        'in-flight-downgrade',
        'outage',
      ],
    };
    expect(JSON.stringify(evidence)).not.toMatch(/Reviewed synthetic|Authorized synthetic|github\.com|token|subject/);
    if (process.env.THREADNOTE_ORG_CLOUD_ACCEPTANCE_RECEIPT) {
      await writeFile(process.env.THREADNOTE_ORG_CLOUD_ACCEPTANCE_RECEIPT, JSON.stringify(evidence, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    }
  }, 60_000);

  async function call(
    name: string,
    args: Record<string, unknown>,
    contribute = false,
    token = contribute ? 'writer' : 'reader',
    headers: Record<string, string> = {},
    includeCloudHeaders = true,
  ) {
    const entry = cloudConfig(contribute).mcpServers['threadnote-org'];
    const response = await handler(
      new Request(entry.url, {
        method: 'POST',
        headers: {
          ...(includeCloudHeaders ? entry.headers : {'threadnote-share-id': shareId}),
          ...headers,
          host: 'composer.example.test',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
      }),
    );
    const body: unknown = await response.json();
    assertRemoteMemoryRpcBody(body);
    return {response, ...body};
  }

  async function expectCanonicalWinner(
    uri: string,
    path: string,
    revision: string,
    winningText: string,
    rejectedTexts: readonly string[],
  ): Promise<void> {
    const read = await call('read_context', {uri, version: 1});
    expect(read.result?.isError).not.toBe(true);
    expect(parseRemoteMemoryReceiptV1(read.result!.structuredContent!.receipt).revision).toBe(revision);
    const cloudBody = JSON.stringify(read.result);
    expect(cloudBody).toContain(winningText);
    const gitBody = await readFile(join(fixture.worktree, path), 'utf8');
    expect(gitBody).toContain(winningText);
    for (const rejectedText of rejectedTexts) {
      expect(cloudBody).not.toContain(rejectedText);
      expect(gitBody).not.toContain(rejectedText);
    }
    const rows = await database.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
      return transaction<
        {current_revision_id: string; git_commit: string | null; git_path: string | null; markdown_body: string}[]
      >`
        SELECT h.current_revision_id, r.git_commit, r.git_path, r.markdown_body
        FROM remote_memory.memory_heads h
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        WHERE h.tenant_id = ${tenantId} AND h.share_id = ${shareId}
          AND h.project = ${project} AND h.topic = ${'reviewed-laptop-record'}
      `;
    });
    expect(rows).toEqual([
      {
        current_revision_id: revision,
        git_commit: Effect.pipe(await git(['rev-parse', 'HEAD'], fixture.worktree), EffectString.trim),
        git_path: path,
        markdown_body: '',
      },
    ]);
  }
});

function deferred(): {readonly promise: Promise<void>; readonly resolve: () => void} {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return {promise, resolve};
}

class ControlledGitCanonicalMemoryStore extends GitCanonicalMemoryStore {
  beforeAuthorizeRefUpdate?: () => Promise<void>;

  override commit(input: GitCanonicalCommitInput): Promise<GitCanonicalCommitResult> {
    if (!this.beforeAuthorizeRefUpdate) return super.commit(input);
    const beforeAuthorizeRefUpdate = this.beforeAuthorizeRefUpdate;
    return super.commit({
      ...input,
      authorizeRefUpdate: async requiredValidityMilliseconds => {
        await beforeAuthorizeRefUpdate();
        await input.authorizeRefUpdate?.(requiredValidityMilliseconds);
      },
    });
  }
}

function errorCode(value: {result?: {structuredContent?: Record<string, unknown>}}): unknown {
  return value.result?.structuredContent?.code;
}

async function cli(args: readonly string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'apps/threadnote/src/standalone.ts', ...args],
    env: {
      ...process.env,
      THREADNOTE_USER: 'laptop',
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'laptop',
      NO_COLOR: '1',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exit, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exit !== 0) throw new Error(`Synthetic laptop import failed: ${stderr}`);
}

async function withLocal(home: string, cloud: boolean, use: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({name: 'org-cloud-acceptance', version: '1'});
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'apps/threadnote/src/standalone.ts'), 'mcp-server'],
    env: {
      ...process.env,
      THREADNOTE_HOME: home,
      THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
      THREADNOTE_USER: 'laptop',
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_AGENT_ID: 'laptop',
      ...(cloud
        ? {
            THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local',
            THREADNOTE_CURSOR_CLOUD_MODE: 'org',
            THREADNOTE_CURSOR_MEMORY_ENDPOINT: endpoint,
            THREADNOTE_CURSOR_MEMORY_SHARE_ID: shareId,
          }
        : {}),
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    await use(client);
  } finally {
    await client.close();
  }
}
