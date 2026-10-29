import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as FC from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {TransactionSql} from 'postgres';
import {ingestGitShare} from '@threadnote/remote-memory/git/ingest';
import {mkdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
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
import {formatMemoryDocument} from '@threadnote/memory/document';
import {formatRemoteMemoryUri} from '@threadnote/memory/remote/address';
import {provisionGitTeamShare} from '@threadnote/threadnote/remote_memory/composer_serve';
import {GitCanonicalMemoryStore, gitCanonicalSharePath} from '@threadnote/remote-memory/git/canonical_store';
import {PostgresRemoteControlPlane} from '@threadnote/remote-memory/postgres/control_plane';
import {PostgresRemoteMemoryRepository} from '@threadnote/remote-memory/postgres/repository';
import {RemoteMemoryIndexer} from '@threadnote/remote-memory/indexer';
import type {AuthorizedRemotePrincipal} from '@threadnote/remote-memory/authorization';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const databaseUrl = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const tenantId = 'lifecycle-tenant';
const shareId = 'lifecycle-share';
const project = 'threadnote';
const topic = 'lifecycle';
const path = gitCanonicalSharePath('durable', project, topic);
const uri = formatRemoteMemoryUri({kind: 'durable', project, shareId, topic});

postgresDescribe('external Git lifecycle convergence', () => {
  let fixture: RemoteMemoryPostgresFixture;
  let gitFixture: GitShareWorktreeFixture;
  let laptop: string;
  let store: GitCanonicalMemoryStore;
  let repository: PostgresRemoteMemoryRepository;
  let principal: AuthorizedRemotePrincipal;

  beforeEach(async () => {
    fixture = await createRemoteMemoryPostgresFixture(databaseUrl!);
    gitFixture = await createGitShareWorktreeFixture('threadnote-git-lifecycle-');
    laptop = await cloneGitShareWorktree(gitFixture.remote, join(gitFixture.root, 'laptop'));
    const issuer = 'https://lifecycle.test/';
    await provisionGitTeamShare(new PostgresRemoteControlPlane(fixture.migratorSql), {
      issuer,
      subject: 'lifecycle-user',
      shareId,
      tenantId,
    });
    const authorized = await new PostgresRemoteControlPlane(fixture.sql).authorize(
      {
        issuer,
        subject: 'lifecycle-user',
        scopes: new Set(['memory:read', 'memory:write:durable', 'memory:write:handoff']),
      },
      shareId,
    );
    if (!authorized) throw new Error('Lifecycle fixture authorization failed.');
    principal = authorized;
    store = new GitCanonicalMemoryStore({
      binding: {tenantId, shareId},
      worktree: gitFixture.worktree,
      worktreeLock: testGitWorktreeLock,
    });
    repository = new PostgresRemoteMemoryRepository(fixture.sql, {gitStore: store});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture?.dispose();
    if (gitFixture) await rm(gitFixture.root, {recursive: true, force: true});
  });

  async function publish(content: string | null, relativePath = path): Promise<string> {
    const target = join(laptop, relativePath);
    if (content === null) await rm(target);
    else {
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, content, 'utf8');
    }
    await git(['add', '--', relativePath], laptop);
    await git(['commit', '-m', 'lifecycle fixture publication'], laptop);
    await git(['push', 'origin', 'main'], laptop);
    return Effect.pipe(await git(['rev-parse', 'HEAD'], laptop), EffectString.trim);
  }

  const ingest = () => repository.ingestGitShare(principal, 'lifecycle-ingest');
  const read = () => repository.read(principal, {uri, version: 1}, 'lifecycle-read');

  it('cannot erase a rejection committed by another scan of the same snapshot', async () => {
    await publish(document('active'));
    await ingest();
    await publish(Effect.pipe(document('active'), EffectString.replace('status: active', 'status: invalid')));
    const beforeHeads = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let transactions = 0;
    const delayed = ingestGitShare({
      gitStore: store,
      principal,
      requestId: 'stale-rejection-state',
      now: new Date(),
      withTenant: async <A>(use: (transaction: TransactionSql) => Promise<A>) => {
        transactions += 1;
        if (transactions === 3) {
          beforeHeads.resolve();
          await resume.promise;
        }
        return fixture.sql.begin<Promise<A>>(async transaction => {
          await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
          return use(transaction);
        });
      },
    }).then(
      () => 'accepted',
      error => error.details?.reason,
    );
    try {
      await beforeHeads.promise;
      await expect(ingest()).rejects.toMatchObject({details: {reason: 'git_ingest_metadata'}});
    } finally {
      resume.resolve();
    }
    expect(await delayed).toBe('git_ingest_snapshot_superseded');
    await expect(ingest()).rejects.toMatchObject({details: {reason: 'git_ingest_metadata'}});
  });

  it('bounds initialized no-op work and commits cursor progress once per batch', async () => {
    for (let index = 0; index < 257; index += 1) {
      const target = join(laptop, gitCanonicalSharePath('durable', project, `ready-${index}`));
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, `Initialized safe body ${index}.`, 'utf8');
    }
    await git(['add', 'durable'], laptop);
    await git(['commit', '-m', 'initialized bounded snapshot'], laptop);
    await git(['push', 'origin', 'main'], laptop);
    await ingest();
    await ingest();
    const reads = vi.spyOn(store, 'read');
    let transactions = 0;
    const result = await ingestGitShare({
      gitStore: store,
      principal,
      requestId: 'bounded-noop',
      now: new Date(),
      withTenant: async <A>(use: (transaction: TransactionSql) => Promise<A>) => {
        transactions += 1;
        return fixture.sql.begin<Promise<A>>(async transaction => {
          await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
          return use(transaction);
        });
      },
    });
    expect(result).toEqual({ingested: 0, skipped: 256});
    expect(reads).not.toHaveBeenCalled();
    expect(transactions).toBeLessThanOrEqual(5);
  });

  it("cannot replace another concurrent scan's rejected path or partially archive its own candidate", async () => {
    const alphaPath = gitCanonicalSharePath('durable', 'alpha', topic);
    const betaPath = gitCanonicalSharePath('durable', 'beta', topic);
    const alpha = Effect.pipe(document('active'), EffectString.replace('project: threadnote', 'project: alpha'));
    const beta = Effect.pipe(document('active'), EffectString.replace('project: threadnote', 'project: beta'));
    await publish(alpha, alphaPath);
    await publish(beta, betaPath);
    await ingest();
    const controlPlane = new PostgresRemoteControlPlane(fixture.migratorSql);
    const limited: AuthorizedRemotePrincipal[] = [];
    for (const name of ['alpha', 'beta']) {
      await controlPlane.provision({
        tenantId,
        shareId,
        principalId: `limited-${name}`,
        issuer: principal.OAuth.issuer,
        subject: name,
        displayName: `Git team share ${shareId}`,
        region: 'local',
        policyVersion: 'local-v1',
        allowedProjects: [name],
        cursorAttestationRequired: false,
        capabilities: ['memory:read', 'memory:write:durable', 'memory:write:handoff'],
        featureFlags: [
          'remote_memory_read',
          'remote_memory_durable_write',
          'remote_memory_handoff_write',
          'remote_memory_ga',
        ],
      });
      const authorized = await new PostgresRemoteControlPlane(fixture.sql).authorize(
        {issuer: principal.OAuth.issuer, subject: name, scopes: principal.OAuth.scopes},
        shareId,
      );
      if (!authorized) throw new Error('Scoped fixture authorization failed.');
      limited.push(authorized);
    }
    await publish(Effect.pipe(alpha, EffectString.replace('status: active', 'status: invalid')), alphaPath);
    await publish(Effect.pipe(beta, EffectString.replace('status: active', 'status: invalid')), betaPath);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readBlob = store.read.bind(store);
    vi.spyOn(store, 'read').mockImplementation(async pointer => {
      if (pointer.path === alphaPath) {
        entered.resolve();
        await release.promise;
      }
      return readBlob(pointer);
    });
    const delayed = repository.ingestGitShare(limited[0], 'reject-alpha').then(
      () => 'accepted',
      error => error.details?.reason,
    );
    try {
      await entered.promise;
      await expect(repository.ingestGitShare(limited[1], 'reject-beta')).rejects.toMatchObject({
        details: {reason: 'git_ingest_metadata'},
      });
    } finally {
      release.resolve();
    }
    expect(await delayed).toBe('git_ingest_snapshot_superseded');
    const alphaUri = formatRemoteMemoryUri({kind: 'durable', project: 'alpha', shareId, topic});
    expect((await repository.read(limited[0], {uri: alphaUri, version: 1}, 'alpha-read')).status).toBe('active');
    await fixture.sql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
      const [progress] = await transaction<{git_ingest_rejected_path: string}[]>`
        SELECT git_ingest_rejected_path FROM remote_memory.shares WHERE tenant_id = ${tenantId} AND id = ${shareId}
      `;
      expect(progress.git_ingest_rejected_path).toBe(betaPath);
    });
  });

  it('does not manufacture a rejection revision for an unrelated descendant commit', async () => {
    await publish(document('active'));
    await ingest();
    await publish(Effect.pipe(document('active'), EffectString.replace('status: active', 'status: invalid')));
    await expect(ingest()).rejects.toMatchObject({code: 'service_unavailable'});
    const rejected = await read();
    await publish('Unrelated documentation.', 'README.md');
    await expect(ingest()).rejects.toMatchObject({code: 'service_unavailable'});
    expect((await read()).receipt.revision).toBe(rejected.receipt.revision);
  });

  it('rejects an unsupported Git mode even when its blob is identical to the previously accepted file', async () => {
    const safe = document('active');
    await publish(safe);
    await ingest();
    const blob = Effect.pipe(await git(['rev-parse', `HEAD:${path}`], laptop), EffectString.trim);
    await git(['update-index', '--cacheinfo', '120000', blob, path], laptop);
    await git(['commit', '-m', 'replace file with unsupported mode'], laptop);
    await git(['push', 'origin', 'main'], laptop);
    await expect(ingest()).rejects.toMatchObject({details: {reason: 'git_ingest_unsupported_entry'}});
    expect(await read()).toMatchObject({status: 'archived', content: safe});
  });

  it('does not activate a newly rejected path and clears its failure after removal', async () => {
    await publish(Effect.pipe(document('active'), EffectString.replace('status: active', 'status: invalid')));
    await expect(ingest()).rejects.toMatchObject({code: 'service_unavailable'});
    expect((await repository.list(principal, {limit: 10}, 'rejected-new-list')).entries).toHaveLength(0);
    await publish(null);
    await expect(ingest()).resolves.toMatchObject({ingested: 0});
    await publish(document('active'));
    expect((await ingest()).ingested).toBe(1);
  });

  it('does not renew an elapsed remote handoff expiry through Git republication', async () => {
    await publish(document('active'));
    await ingest();
    const expiresAt = '2026-09-07T01:00:00.000Z';
    const handoff = await repository.remember(
      principal,
      {
        kind: 'handoff',
        project,
        topic: 'expiring',
        text: 'Expiring handoff.',
        lifecycle: {expiresAt, retentionClass: 'short'},
        operationId: 'expiring-create',
        version: 1,
      },
      'expiring-create',
      undefined,
      new Date('2026-09-07T00:00:00.000Z'),
    );
    await git(['pull', '--ff-only'], laptop);
    const handoffPath = gitCanonicalSharePath('handoff', project, 'expiring');
    await publish(
      formatMemoryDocument(
        'HANDOFF',
        {
          kind: 'handoff',
          status: 'active',
          project,
          topic: 'expiring',
          sourceAgentClient: 'test',
          timestamp: '2026-09-07T02:00:00.000Z',
        },
        'Explicit publication after expiry.',
      ),
      handoffPath,
    );
    await repository.ingestGitShare(principal, 'expired-ingest', new Date('2026-09-07T02:00:00.000Z'));
    expect((await repository.read(principal, {uri: handoff.uri!, version: 1}, 'expired-read')).status).toBe('expired');
    await fixture.sql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
      const [head] = await transaction<{expires_at: Date; retention_class: string}[]>`
        SELECT expires_at, retention_class FROM remote_memory.memory_heads WHERE canonical_uri = ${handoff.uri!}
      `;
      expect(head.expires_at.toISOString()).toBe(expiresAt);
      expect(head.retention_class).toBe('short');
    });
  });

  it('checks the expected head revision when HTTP commits after ingestion planning', async () => {
    await publish(Effect.pipe(document('active'), EffectString.replace('keywords: lifecycleproof\n', '')));
    await ingest();
    const original = await read();
    const gitWritten = Promise.withResolvers<void>();
    const finishHttp = Promise.withResolvers<void>();
    const bodyRead = Promise.withResolvers<void>();
    const finishIngest = Promise.withResolvers<void>();
    const commit = store.commit.bind(store);
    const readBlob = store.read.bind(store);
    let writtenCommit: string | undefined;
    vi.spyOn(store, 'commit').mockImplementation(async input => {
      const result = await commit(input);
      writtenCommit = result.gitCommit;
      gitWritten.resolve();
      await finishHttp.promise;
      return result;
    });
    vi.spyOn(store, 'read').mockImplementation(async pointer => {
      if (pointer.commit === writtenCommit) {
        bodyRead.resolve();
        await finishIngest.promise;
      }
      return readBlob(pointer);
    });
    const http = repository.remember(
      principal,
      {
        kind: 'durable',
        project,
        topic,
        text: 'HTTP winner body.',
        baseRevision: original.receipt.revision,
        operationId: 'http-head-race',
        version: 1,
      },
      'http-race',
    );
    let delayed: Promise<string> | undefined;
    try {
      await gitWritten.promise;
      delayed = ingest().then(
        () => 'accepted',
        error => error.details?.reason,
      );
      await bodyRead.promise;
      finishHttp.resolve();
      const winner = await http;
      finishIngest.resolve();
      expect(await delayed).toBe('git_ingest_snapshot_superseded');
      expect((await read()).receipt.revision).toBe(winner.revision);
    } finally {
      finishHttp.resolve();
      finishIngest.resolve();
      await http;
      await delayed;
    }
  });

  it('validates legacy same-commit heads past the hydration bound without manufacturing no-op revisions', async () => {
    const records: {name: string; gitPath: string; content: string; index: number}[] = [];
    for (let index = 0; index < 257; index += 1) {
      const name = `legacy-${Effect.pipe(String(index), EffectString.padStart(3, '0'))}`;
      const gitPath = gitCanonicalSharePath('durable', project, name);
      const content = Effect.pipe(
        document(index === 256 ? 'archived' : 'active'),
        EffectString.replace('topic: lifecycle', `topic: ${name}`),
      );
      const target = join(laptop, gitPath);
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, content, 'utf8');
      records.push({name, gitPath, content, index});
    }
    await git(['add', 'durable'], laptop);
    await git(['commit', '-m', 'legacy snapshot'], laptop);
    await git(['push', 'origin', 'main'], laptop);
    const commit = Effect.pipe(await git(['rev-parse', 'HEAD'], laptop), EffectString.trim);
    await fixture.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
      await transaction`INSERT INTO remote_memory.projects(tenant_id, share_id, name, status) VALUES (${tenantId}, ${shareId}, ${project}, 'active')`;
      for (const record of records) {
        const address = formatRemoteMemoryUri({kind: 'durable', project, shareId, topic: record.name});
        await transaction`
          INSERT INTO remote_memory.memory_heads(tenant_id, share_id, id, kind, project, topic, canonical_uri, status, current_revision_id)
          VALUES (${tenantId}, ${shareId}, ${`head-${record.index}`}, 'durable', ${project}, ${record.name}, ${address}, 'active', ${`revision-${record.index}`})
        `;
        await transaction`
          INSERT INTO remote_memory.memory_revisions(tenant_id, share_id, id, head_id, generation, status, markdown_body, content_hash, git_commit, git_path, oauth_principal_id, operation_id)
          VALUES (${tenantId}, ${shareId}, ${`revision-${record.index}`}, ${`head-${record.index}`}, ${record.index + 1}, 'active', '', ${sha256HexSync(record.content)}, ${commit}, ${record.gitPath}, ${principal.principalId}, ${`legacy-${record.index}`})
        `;
      }
      await transaction`UPDATE remote_memory.shares SET share_generation = 257 WHERE tenant_id = ${tenantId} AND id = ${shareId}`;
    });
    const readSpy = vi.spyOn(store, 'read');
    expect((await ingest()).ingested).toBe(0);
    expect(readSpy).toHaveBeenCalledTimes(256);
    readSpy.mockClear();
    expect((await ingest()).ingested).toBe(1);
    expect(readSpy).toHaveBeenCalledTimes(256);
    const last = formatRemoteMemoryUri({kind: 'durable', project, shareId, topic: 'legacy-256'});
    expect((await repository.read(principal, {uri: last, version: 1}, 'legacy-last')).status).toBe('archived');
    const first = formatRemoteMemoryUri({kind: 'durable', project, shareId, topic: 'legacy-000'});
    expect((await repository.read(principal, {uri: first, version: 1}, 'legacy-first')).receipt.revision).toBe(
      'revision-0',
    );
  });

  it('keeps a known rejection unhealthy even when a newer snapshot inserts more than one batch before it', async () => {
    await publish(document('active'));
    await ingest();
    await publish(Effect.pipe(document('active'), EffectString.replace('status: active', 'status: invalid')));
    await expect(ingest()).rejects.toMatchObject({code: 'service_unavailable'});
    for (let index = 0; index < 257; index += 1) {
      const name = `ahead-${Effect.pipe(String(index), EffectString.padStart(3, '0'))}`;
      await writeFile(
        join(laptop, gitCanonicalSharePath('durable', project, name)),
        `Safe earlier file ${index}.`,
        'utf8',
      );
    }
    await git(['add', 'durable'], laptop);
    await git(['commit', '-m', 'insert earlier batch'], laptop);
    await git(['push', 'origin', 'main'], laptop);
    const readSpy = vi.spyOn(store, 'read');
    await expect(ingest()).rejects.toMatchObject({code: 'service_unavailable'});
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect((await read()).status).toBe('archived');
  });

  it('keeps current state and revision stable under permutations of older linear snapshots', async () => {
    let run = 0;
    await FC.assert(
      FC.asyncProperty(
        FC.array(FC.constantFrom('active', 'archived', 'removed', 'restored', 'unrelated'), {
          minLength: 4,
          maxLength: 4,
        }),
        FC.shuffledSubarray([0, 1, 2, 3], {minLength: 4, maxLength: 4}),
        async (changes, order) => {
          run += 1;
          await publish(`${document('active')}\nInitial run ${run}`);
          await ingest();
          let present = true;
          let expected: 'active' | 'archived' = 'active';
          const snapshots = [];
          for (const [index, change] of changes.entries()) {
            if (change === 'removed') {
              if (present) await publish(null);
              present = false;
              expected = 'archived';
            } else if (change === 'unrelated') {
              await publish(`Unrelated ${index} run ${run}`, 'README.md');
            } else {
              expected = change === 'archived' ? 'archived' : 'active';
              await publish(`${document(expected)}\nPublication ${index}.`);
              present = true;
            }
            snapshots.push(await store.snapshot());
          }
          await ingest();
          const accepted = await read();
          expect(accepted.status).toBe(expected);
          for (const index of order) {
            vi.spyOn(store, 'snapshot').mockResolvedValueOnce(snapshots[index]);
            try {
              await ingest();
            } catch (error) {
              expect(error).toMatchObject({details: {reason: 'git_ingest_snapshot_superseded'}});
            }
            expect((await read()).receipt.revision).toBe(accepted.receipt.revision);
          }
        },
      ),
      {numRuns: 4},
    );
  });

  it('fences a delayed removal when a newer identical restoration is a no-op against the current head', async () => {
    const initialCommit = await publish(document('active'));
    await ingest();
    const original = await read();
    await publish(null);
    const removedSnapshot = await store.snapshot();
    await publish(document('active'));
    await store.refresh();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const listBlobs = store.listBlobIds.bind(store);
    let pause = true;
    vi.spyOn(store, 'snapshot').mockResolvedValueOnce(removedSnapshot);
    vi.spyOn(store, 'listBlobIds').mockImplementation(async commit => {
      if (pause && commit === initialCommit) {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      return listBlobs(commit);
    });
    const delayed = ingest().then(
      () => 'accepted',
      error => error.details?.reason,
    );
    try {
      await entered.promise;
      expect((await ingest()).ingested).toBe(0);
    } finally {
      release.resolve();
    }
    expect(await delayed).toBe('git_ingest_snapshot_superseded');
    expect(await read()).toMatchObject({status: 'active', receipt: {revision: original.receipt.revision}});
  });

  it('fences an older new-key publication after a newer empty canonical snapshot is admitted', async () => {
    const oldCommit = await publish(document('active'));
    const oldSnapshot = await store.snapshot();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readBlob = store.read.bind(store);
    vi.spyOn(store, 'snapshot').mockResolvedValueOnce(oldSnapshot);
    vi.spyOn(store, 'read').mockImplementation(async pointer => {
      if (pointer.commit === oldCommit) {
        entered.resolve();
        await release.promise;
      }
      return readBlob(pointer);
    });
    const delayed = ingest().then(
      () => 'accepted',
      error => error.details?.reason,
    );
    try {
      await entered.promise;
      await publish(null);
      expect((await ingest()).ingested).toBe(0);
    } finally {
      release.resolve();
    }
    expect(await delayed).toBe('git_ingest_snapshot_superseded');
    expect((await repository.list(principal, {limit: 10}, 'empty-newer-list')).entries).toHaveLength(0);
  });

  it.each(['archived', 'expired', 'superseded'] as const)(
    'imports an external %s status and preserves raw bytes',
    async status => {
      await publish(document('active'));
      await ingest();
      const raw = `${document(status)}\n`;
      await publish(raw);
      await ingest();
      expect(await read()).toMatchObject({status, content: raw});
      expect((await repository.list(principal, {status: 'active', limit: 10}, 'list-active')).entries).toHaveLength(0);
      expect((await repository.list(principal, {limit: 10}, 'list-all')).entries).toHaveLength(1);
      expect(
        (await repository.recall(principal, {project, query: 'lifecycleproof', version: 1}, 'recall-overlay')).results,
      ).toHaveLength(0);
      await new RemoteMemoryIndexer(fixture.sql, store).runPass({ingest: false});
      expect(
        (await repository.recall(principal, {project, query: 'lifecycleproof', version: 1}, 'recall-indexed')).results,
      ).toHaveLength(0);
    },
  );

  it('archives removal of the last canonical file, keeps history, and restores an identical publication', async () => {
    const raw = document('active');
    await publish(raw);
    await ingest();
    const original = await read();
    await publish(null);
    expect((await ingest()).ingested).toBe(1);
    const removed = await read();
    expect(removed).toMatchObject({status: 'archived', content: raw});
    expect(removed.receipt.revision).not.toBe(original.receipt.revision);
    expect((await ingest()).ingested).toBe(0);
    const historical = await repository.read(
      principal,
      {uri, revision: original.receipt.revision, version: 1},
      'history',
    );
    expect(historical).toMatchObject({status: 'active', content: raw});
    await publish(raw);
    expect((await ingest()).ingested).toBe(1);
    expect(await read()).toMatchObject({status: 'active', content: raw});
    expect((await ingest()).ingested).toBe(0);
  });

  it.each([
    ['invalid status', 'status: broken'],
    ['empty status', 'status:'],
    ['duplicate status', 'status: active\nstatus: archived'],
    ['future schema', 'status: active\nschema_version: 999'],
    ['wrong kind', 'status: active\nkind: handoff'],
    ['wrong project', 'status: active\nproject: elsewhere'],
  ])('rejects %s visibly and suppresses the previous active head', async (_label, header) => {
    const safe = document('active');
    await publish(safe);
    await ingest();
    await publish(Effect.pipe(safe, EffectString.replace('status: active', header)));
    await expect(ingest()).rejects.toMatchObject({code: 'service_unavailable'});
    expect(await read()).toMatchObject({status: 'archived', content: safe});
    await expect(ingest()).rejects.toMatchObject({code: 'service_unavailable'});
    await publish(`${safe}\nRecovered publication.`);
    await ingest();
    expect((await read()).status).toBe('active');
  });
});

function document(status: 'active' | 'archived' | 'expired' | 'superseded'): string {
  return formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      status,
      project,
      topic,
      sourceAgentClient: 'test',
      timestamp: '2026-09-07T00:00:00.000Z',
      keywords: ['lifecycleproof'],
      visibility: 'shared',
    },
    'External lifecycleproof body.',
  );
}
