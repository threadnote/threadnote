import {testGitWorktreeLock} from '../helpers/git-worktree-lock.js';
import {describe, expect, it} from 'vitest';
import {rm} from '@threadnote/testing/node-fs-promises';
import {createGitShareWorktreeFixture} from '@threadnote/testing/git-share-worktree';
import {createRemoteMemoryPostgresFixture} from '../helpers/remote-memory-postgres.js';
import {GitCanonicalMemoryStore} from '@threadnote/remote-memory/git/canonical_store';
import {PostgresRemoteControlPlane} from '@threadnote/remote-memory/postgres/control_plane';
import {PostgresRemoteMemoryRepository} from '@threadnote/remote-memory/postgres/repository';
import {RemoteMemoryIndexer} from '@threadnote/remote-memory/indexer';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {richRemoteMemoryMetadata} from '@threadnote/memory/test/helpers/remote-memory-document';
import {git} from '@threadnote/testing/git-share-worktree';

const DATABASE = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = DATABASE ? describe : describe.skip;

async function fixture() {
  const database = await createRemoteMemoryPostgresFixture(DATABASE!);
  const git = await createGitShareWorktreeFixture();
  const operator = new PostgresRemoteControlPlane(database.migratorSql);
  const input = {
    tenantId: 'authority',
    shareId: 'authority-share',
    principalId: 'member',
    issuer: 'https://authority.test',
    subject: 'member',
    displayName: 'Authority test',
    region: 'test',
    policyVersion: 'v1',
    capabilities: ['memory:read', 'memory:write:durable'] as const,
    allowedProjects: ['restricted'],
    projects: ['restricted'],
    cursorAttestationRequired: false,
    featureFlags: ['remote_memory_read', 'remote_memory_durable_write', 'remote_memory_ga'] as const,
  };
  await operator.provision(input);
  const store = new GitCanonicalMemoryStore({
    worktreeLock: testGitWorktreeLock,
    binding: {tenantId: input.tenantId, shareId: input.shareId},
    worktree: git.worktree,
  });
  const repository = new PostgresRemoteMemoryRepository(database.sql, {gitStore: store});
  return {
    database,
    git,
    input,
    operator,
    repository,
    store,
    dispose: async () => {
      await database.dispose();
      await rm(git.root, {recursive: true, force: true});
    },
  };
}

postgresDescribe('Git ingest system authority', () => {
  it('keeps readiness failed until a failed Git ingest actually recovers', async () => {
    const f = await fixture();
    try {
      const indexer = new RemoteMemoryIndexer(f.database.sql, f.store);
      const setStatus = async (status: 'active' | 'revoked') =>
        f.database.migratorSql.begin(async tx => {
          await tx`SELECT set_config('threadnote.tenant_id', ${f.input.tenantId}, true)`;
          await tx`UPDATE remote_memory.share_grants SET status = ${status} WHERE principal_id LIKE 'system:git-ingest:%'`;
        });
      const health = async () =>
        (
          await f.database.sql<
            {failure_class: string | null}[]
          >`SELECT failure_class FROM remote_memory.worker_health WHERE worker_name = 'indexer'`
        )[0]?.failure_class;
      await setStatus('revoked');
      expect(await indexer.runPass()).toEqual({failed: 1, processed: 0});
      expect(await health()).toBe('git_ingest_failed');
      await indexer.runPass({ingest: false});
      expect(await health()).toBe('git_ingest_failed');
      await setStatus('active');
      await indexer.runPass({ingest: false});
      expect(await health()).toBe('git_ingest_failed');
      expect(await indexer.runPass()).toEqual({failed: 0, processed: 0});
      expect(await health()).toBeNull();
    } finally {
      await f.dispose();
    }
  });

  it('preserves rich Git metadata through CAS replacement, replay, and stale rejection', async () => {
    const f = await fixture();
    try {
      const path = 'durable/projects/restricted/rich.md';
      const metadata = richRemoteMemoryMetadata();
      const content = formatMemoryDocument('MEMORY', metadata, 'Retain the original body.');
      const committed = await f.store.commit({path, content, message: 'Rich Git memory'});
      await f.repository.ingestActiveGitShares('rich-ingest');
      const principal = await new PostgresRemoteControlPlane(f.database.sql).authorize(
        {issuer: f.input.issuer, subject: f.input.subject, scopes: new Set(f.input.capabilities)},
        f.input.shareId,
      );
      if (!principal) throw new Error('Fixture principal missing');
      const uri = `threadnote://share/${f.input.shareId}/memories/durable/restricted/rich.md`;
      const original = await f.repository.read(principal, {version: 1, uri}, 'read-rich');
      const input = {
        version: 1 as const,
        kind: 'durable' as const,
        project: 'restricted',
        topic: 'rich',
        text: 'Changed body',
        operationId: 'replace-rich',
        baseRevision: original.receipt.revision,
      };
      const replaced = await f.repository.remember(principal, input, 'replace-rich');
      const read = await f.repository.read(principal, {version: 1, uri}, 'read-replaced');
      expect(read.receipt.revision).toBe(replaced.revision);
      const parsed = parseMemoryDocument(uri, read.content);
      expect(parsed?.body).toBe('Changed body');
      expect(parsed?.metadata).toEqual({
        ...metadata,
        sourceAgentClient: 'remote',
        timestamp: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(parsed?.metadata.updatedAt).not.toBe(metadata.updatedAt);
      const editedFields = /^(source_agent_client|timestamp|updated_at):/u;
      const preservedLines = content
        .split('\n\n', 1)[0]
        .split('\n')
        .filter(line => !editedFields.test(line));
      expect(
        read.content
          .split('\n\n', 1)[0]
          .split('\n')
          .filter(line => !editedFields.test(line)),
      ).toEqual(preservedLines);
      expect(await git(['show', `HEAD:${path}`], f.git.remote)).toBe(read.content);
      expect((await f.repository.remember(principal, input, 'replay-rich')).revision).toBe(replaced.revision);
      await expect(
        f.repository.remember(principal, {...input, operationId: 'stale-rich', text: 'Stale body'}, 'stale-rich'),
      ).rejects.toMatchObject({code: 'conflict'});
      expect((await f.repository.read(principal, {version: 1, uri}, 'read-after-stale')).content).toBe(read.content);
      expect(await f.store.read({commit: committed.gitCommit, path})).toBe(content);
    } finally {
      await f.dispose();
    }
  });

  it.each(['x_extension: retained', 'memory_id: tn_one\nmemory_id: tn_two'])(
    'leaves Git and the revision unchanged when metadata cannot be preserved: %s',
    async field => {
      const f = await fixture();
      try {
        const path = 'durable/projects/restricted/unsupported.md';
        const content = `MEMORY\nkind: durable\n${field}\n\nOriginal body`;
        const committed = await f.store.commit({path, content, message: 'Unsupported metadata fixture'});
        await f.repository.ingestActiveGitShares('unsupported-ingest');
        const principal = await new PostgresRemoteControlPlane(f.database.sql).authorize(
          {issuer: f.input.issuer, subject: f.input.subject, scopes: new Set(f.input.capabilities)},
          f.input.shareId,
        );
        if (!principal) throw new Error('Fixture principal missing');
        const uri = `threadnote://share/${f.input.shareId}/memories/durable/restricted/unsupported.md`;
        const original = await f.repository.read(principal, {version: 1, uri}, 'read-unsupported');
        await expect(
          f.repository.remember(
            principal,
            {
              version: 1,
              kind: 'durable',
              project: 'restricted',
              topic: 'unsupported',
              text: 'Changed body',
              operationId: 'replace-unsupported',
              baseRevision: original.receipt.revision,
            },
            'replace-unsupported',
          ),
        ).rejects.toMatchObject({code: 'invalid_request', details: {reason: 'unsupported_remote_metadata'}});
        expect((await f.store.listCanonicalPaths()).find(entry => entry.gitPath === path)?.gitCommit).toBe(
          committed.gitCommit,
        );
        const read = await f.repository.read(principal, {version: 1, uri}, 'read-after-rejection');
        expect(read.content).toBe(original.content);
        expect(read.receipt.revision).toBe(original.receipt.revision);
      } finally {
        await f.dispose();
      }
    },
  );

  it('rejects malformed code citations at ingestion without changing Git or creating revisions', async () => {
    const f = await fixture();
    try {
      const path = 'durable/projects/restricted/invalid-citation.md';
      const content = 'MEMORY\nkind: durable\ncode_citation: invalid\n\nOriginal body';
      const committed = await f.store.commit({path, content, message: 'Invalid citation fixture'});
      await expect(f.repository.ingestActiveGitShares('invalid-citation-ingest')).rejects.toMatchObject({
        code: 'service_unavailable',
        details: {reason: 'git_ingest_metadata'},
      });
      expect((await f.store.listCanonicalPaths()).find(entry => entry.gitPath === path)?.gitCommit).toBe(
        committed.gitCommit,
      );
      expect(await git(['show', `HEAD:${path}`], f.git.remote)).toBe(content);
      const projected = await f.database.migratorSql.begin(async tx => {
        await tx`SELECT set_config('threadnote.tenant_id', ${f.input.tenantId}, true)`;
        return {
          heads: await tx`SELECT id FROM remote_memory.memory_heads`,
          revisions: await tx`SELECT id FROM remote_memory.memory_revisions`,
        };
      });
      expect(projected).toEqual({heads: [], revisions: []});
    } finally {
      await f.dispose();
    }
  });

  it('projects canonical Git independently of member order, scopes, and revocation', async () => {
    const f = await fixture();
    try {
      for (const member of ['aaa-member', 'zzz-member']) {
        await f.operator.provision({...f.input, principalId: member, subject: member});
      }
      for (const phase of ['active', 'revoked']) {
        if (phase === 'revoked')
          await f.database.migratorSql.begin(async tx => {
            await tx`SELECT set_config('threadnote.tenant_id', ${f.input.tenantId}, true)`;
            await tx`UPDATE remote_memory.tenant_memberships SET status = 'revoked' WHERE principal_id NOT LIKE 'system:%'`;
          });
        await f.store.commit({
          path: `durable/projects/canonical/${phase}.md`,
          content: `Canonical ${phase} body.`,
          message: 'Git authority fixture',
        });
        expect((await f.repository.ingestActiveGitShares(`ingest-${phase}`)).ingested).toBe(1);
      }
      const actors = await f.database.migratorSql.begin(async tx => {
        await tx`SELECT set_config('threadnote.tenant_id', ${f.input.tenantId}, true)`;
        return tx<{oauth_principal_id: string}[]>`SELECT oauth_principal_id FROM remote_memory.memory_revisions`;
      });
      expect(actors).toHaveLength(2);
      for (const actor of actors) expect(actor.oauth_principal_id).toMatch(/^system:git-ingest:/u);
    } finally {
      await f.dispose();
    }
  });

  it('fails closed when the provisioned ingest identity is missing or revoked', async () => {
    const f = await fixture();
    try {
      await f.database.migratorSql.begin(async tx => {
        await tx`SELECT set_config('threadnote.tenant_id', ${f.input.tenantId}, true)`;
        await tx`UPDATE remote_memory.share_grants SET status = 'revoked' WHERE principal_id LIKE 'system:git-ingest:%'`;
      });
      await expect(f.repository.ingestActiveGitShares('revoked-system')).rejects.toMatchObject({
        code: 'service_unavailable',
        details: {reason: 'git_ingest_identity_unavailable'},
      });
      await f.operator.provision(f.input);
      await expect(f.repository.ingestActiveGitShares('still-revoked')).rejects.toMatchObject({
        code: 'service_unavailable',
      });
    } finally {
      await f.dispose();
    }
  });
});
