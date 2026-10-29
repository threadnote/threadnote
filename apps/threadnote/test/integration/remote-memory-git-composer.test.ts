import {Array as EffectArray, Option as EffectOption} from 'effect';
import {richRemoteMemoryMetadata} from '@threadnote/memory/test/helpers/remote-memory-document';
import {testGitWorktreeLock} from '../helpers/git-worktree-lock.js';
import {mkdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {dirname, join} from '@threadnote/testing/node-path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import postgres, {type Sql, type TransactionSql} from 'postgres';
import {formatRemoteMemoryUri} from '@threadnote/memory/remote/address';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import type {RemoteRememberInputV1} from '@threadnote/memory/remote/contracts';
import {formatRemoteMemoryLogicalKey, REMOTE_MEMORY_REVISION_VERSION} from '@threadnote/memory/remote/revisions';
import type {AuthorizedRemotePrincipal, RemoteMemoryScope} from '@threadnote/remote-memory/authorization';
import {provisionGitTeamShare} from '@threadnote/threadnote/remote_memory/composer_serve';
import {GitCanonicalMemoryStore, gitCanonicalSharePath} from '@threadnote/remote-memory/git/canonical_store';
import type {OAuthPrincipalClaims} from '@threadnote/remote-memory/oauth';
import {PostgresRemoteControlPlane} from '@threadnote/remote-memory/postgres/control_plane';
import {PostgresRemoteMemoryRepository} from '@threadnote/remote-memory/postgres/repository';
import {RemoteMemoryIndexer} from '@threadnote/remote-memory/indexer';
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
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const TEST_DATABASE_URL = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = TEST_DATABASE_URL ? describe : describe.skip;
const ISSUER = 'https://identity.git-composer.test';
const PROJECT = 'threadnote';
const TENANT = 'tenant-git';
const SHARE = 'share-git';
const PRINCIPAL = 'principal-git';
const ALL_SCOPES = [
  'memory:read',
  'memory:write:durable',
  'memory:write:handoff',
] as const satisfies readonly RemoteMemoryScope[];

postgresDescribe('git-backed remote memory composer', () => {
  let fixture: RemoteMemoryPostgresFixture;
  let gitFixture: GitShareWorktreeFixture;
  let gitStore: GitCanonicalMemoryStore;
  let repository: PostgresRemoteMemoryRepository;
  let indexer: RemoteMemoryIndexer;
  let principal: AuthorizedRemotePrincipal;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) throw new Error('THREADNOTE_TEST_POSTGRES_URL is required.');
    fixture = await createRemoteMemoryPostgresFixture(TEST_DATABASE_URL);
    gitFixture = await createGitShareWorktreeFixture('threadnote-git-composer-');
    const operator = new PostgresRemoteControlPlane(fixture.migratorSql);
    await operator.provision({
      allowedProjects: [PROJECT],
      capabilities: ALL_SCOPES,
      cursorAttestationRequired: false,
      cursorSubjects: ['user:9001'],
      displayName: 'Git composer share',
      featureFlags: [
        'remote_memory_read',
        'remote_memory_durable_write',
        'remote_memory_handoff_write',
        'remote_memory_ga',
      ],
      issuer: ISSUER,
      policyVersion: 'policy-v1',
      principalId: PRINCIPAL,
      projects: [PROJECT],
      region: 'test-region',
      repositoryBindings: {[PROJECT]: ['https://github.com/example/threadnote-git.git']},
      shareId: SHARE,
      subject: 'subject-git',
      tenantId: TENANT,
    });
    gitStore = new GitCanonicalMemoryStore({
      worktreeLock: testGitWorktreeLock,
      binding: {tenantId: TENANT, shareId: SHARE},
      worktree: gitFixture.worktree,
    });
    repository = new PostgresRemoteMemoryRepository(fixture.sql, {gitStore});
    indexer = new RemoteMemoryIndexer(fixture.sql, gitStore);
    const authorized = await new PostgresRemoteControlPlane(fixture.sql).authorize(claims(), SHARE);
    if (!authorized) throw new Error('Git composer fixture authorization failed.');
    principal = authorized;
  });

  afterAll(async () => {
    await fixture?.dispose();
    if (gitFixture) await rm(gitFixture.root, {force: true, recursive: true});
  });

  it('rereads exact Git revisions for graph-linked remote Context Brief matches', async () => {
    const metadata = {...richRemoteMemoryMetadata(), project: PROJECT, topic: 'context-brief-git'};
    const citation = metadata.codeCitations![0];
    await gitStore.commit({
      content: formatMemoryDocument('MEMORY', metadata, 'Canonical Git Context Brief evidence.'),
      message: 'seed git context brief',
      path: gitCanonicalSharePath('durable', PROJECT, metadata.topic),
    });
    await repository.ingestGitShare(principal, 'context-brief-git-ingest');

    const input = {
      anchors: [{path: citation.path, repositoryId: citation.repositoryId}],
      budgetTokens: 1_250,
      project: PROJECT,
      task: 'Canonical Git Context Brief evidence.',
      version: 1 as const,
    };
    const result = await repository.contextBrief(principal, input, 'context-brief-git-read');
    expect(result).toMatchObject({directSearchTruncated: false, matchedAnchorOrdinals: [0]});
    expect(result.results).toEqual([
      expect.objectContaining({anchorOrdinals: [0], evidence: 'anchor', topic: metadata.topic}),
    ]);
    const bodies = await withTenant(
      fixture.migratorSql,
      TENANT,
      transaction => transaction<{markdown_body: string}[]>`
        SELECT r.markdown_body FROM remote_memory.memory_heads h
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        WHERE h.tenant_id = ${TENANT} AND h.share_id = ${SHARE} AND h.topic = ${metadata.topic}
      `,
    );
    expect(bodies).toEqual([{markdown_body: ''}]);

    class FailingReadStore extends GitCanonicalMemoryStore {
      override read(_input: Parameters<GitCanonicalMemoryStore['read']>[0]): Promise<string> {
        return Promise.reject(new Error('injected exact Git revision read failure'));
      }
    }
    const failingRepository = new PostgresRemoteMemoryRepository(fixture.sql, {
      gitStore: new FailingReadStore({
        binding: {tenantId: TENANT, shareId: SHARE},
        worktree: gitFixture.worktree,
        worktreeLock: testGitWorktreeLock,
      }),
    });
    await expect(failingRepository.contextBrief(principal, input, 'context-brief-git-read-failed')).rejects.toThrow(
      'injected exact Git revision read failure',
    );
  });

  it('does not let stale Git hydration restore an obsolete backlink projection', async () => {
    expect(await indexer.runPass({batchSize: 1_000, ingest: false})).toMatchObject({failed: 0});
    const metadata = {...richRemoteMemoryMetadata(), project: PROJECT, topic: 'context-brief-stale-hydration'};
    const citation = metadata.codeCitations![0];
    await gitStore.commit({
      content: formatMemoryDocument('MEMORY', metadata, 'Old cited revision.'),
      message: 'seed stale hydration revision',
      path: gitCanonicalSharePath('durable', PROJECT, metadata.topic),
    });
    await repository.ingestGitShare(principal, 'context-brief-stale-hydration-ingest');
    const uri = formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE, topic: metadata.topic});
    const first = await repository.read(principal, {uri, version: 1}, 'context-brief-stale-hydration-read');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class DelayedReadStore extends GitCanonicalMemoryStore {
      override async read(input: Parameters<GitCanonicalMemoryStore['read']>[0]): Promise<string> {
        entered.resolve();
        await release.promise;
        return super.read(input);
      }
    }
    const staleIndexer = new RemoteMemoryIndexer(
      fixture.sql,
      new DelayedReadStore({
        binding: {tenantId: TENANT, shareId: SHARE},
        worktree: gitFixture.worktree,
        worktreeLock: testGitWorktreeLock,
      }),
    );
    const stalePass = staleIndexer.runPass({batchSize: 1, ingest: false});
    await entered.promise;
    try {
      await repository.remember(
        principal,
        {
          ...rememberInput({
            baseRevision: first.receipt.revision!,
            operationId: 'context-brief-clear-stale-hydration',
            text: 'Current revision has no code citation.',
            topic: metadata.topic,
          }),
          citationSources: [],
        },
        'context-brief-clear-stale-hydration',
      );
      expect(await new RemoteMemoryIndexer(fixture.sql, gitStore).runPass({batchSize: 1, ingest: false})).toEqual({
        failed: 0,
        processed: 1,
      });
    } finally {
      release.resolve();
    }
    await expect(stalePass).resolves.toEqual({failed: 0, processed: 1});

    const result = await repository.contextBrief(
      principal,
      {
        anchors: [{path: citation.path, repositoryId: citation.repositoryId}],
        budgetTokens: 1_250,
        project: PROJECT,
        task: 'obsolete selector should not return',
        version: 1,
      },
      'context-brief-stale-hydration-verify',
    );
    expect(EffectArray.some(result.results, candidate => candidate.uri === uri)).toBe(false);
    const backlinks = await withTenant(
      fixture.migratorSql,
      TENANT,
      transaction => transaction<{count: string | number}[]>`
        SELECT count(*) AS count FROM remote_memory.code_link_backlinks b
        JOIN remote_memory.memory_heads h
          ON h.tenant_id = b.tenant_id AND h.share_id = b.share_id AND h.id = b.head_id
        WHERE b.tenant_id = ${TENANT} AND b.share_id = ${SHARE} AND h.canonical_uri = ${uri}
      `,
    );
    expect(Number(backlinks[0]?.count)).toBe(0);
  });

  it('copies canonical citations with preserve/clear semantics, exact replay, and one database connection', async () => {
    const metadata = {...richRemoteMemoryMetadata(), project: PROJECT, topic: 'citation-donor'};
    const citation = metadata.codeCitations![0];
    await gitStore.commit({
      content: formatMemoryDocument('MEMORY', metadata, 'Canonical evidence.'),
      message: 'seed citation donor',
      path: gitCanonicalSharePath('durable', PROJECT, metadata.topic),
    });
    await repository.ingestGitShare(principal, 'citation-ingest');
    const donorUri = formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE, topic: metadata.topic});
    const citationSources = [{uri: donorUri, citationId: citation.id}];
    const singleSql = postgres(fixture.runtimeDatabaseUrl, {max: 1, prepare: false});
    try {
      const single = new PostgresRemoteMemoryRepository(singleSql, {gitStore});
      const input = {
        ...rememberInput({
          operationId: 'citation-create',
          text: 'Chosen canonical evidence.',
          topic: 'citation-target',
        }),
        citationSources,
      };
      const created = await single.remember(principal, input, 'citation-create');
      expect(
        await single.remember(
          principal,
          {...input, citationSources: [...citationSources, ...citationSources]},
          'citation-replay',
        ),
      ).toEqual({...created, requestId: 'citation-replay'});
      const read = await single.read(principal, {uri: created.uri!, version: 1}, 'citation-read');
      expect(parseMemoryDocument(created.uri!, read.content)?.metadata.codeCitations).toEqual([citation]);
      const preserved = await single.remember(
        principal,
        {
          ...input,
          citationSources: undefined,
          baseRevision: created.revision,
          operationId: 'citation-preserve',
          text: 'Preserved.',
        },
        'citation-preserve',
      );
      expect(
        parseMemoryDocument(
          created.uri!,
          (await single.read(principal, {uri: created.uri!, version: 1}, 'citation-preserved-read')).content,
        )?.metadata.codeCitations,
      ).toEqual([citation]);
      await single.remember(
        principal,
        {
          ...input,
          citationSources: [],
          baseRevision: preserved.revision,
          operationId: 'citation-clear',
          text: 'Cleared.',
        },
        'citation-clear',
      );
      expect(
        parseMemoryDocument(
          created.uri!,
          (await single.read(principal, {uri: created.uri!, version: 1}, 'citation-cleared-read')).content,
        )?.metadata.codeCitations,
      ).toBeUndefined();
    } finally {
      await singleSql.end({timeout: 1});
    }
  });

  it('recovers a landed cited write after database rollback even when its donor changes', async () => {
    const metadata = {...richRemoteMemoryMetadata(), project: PROJECT, topic: 'citation-recovery-donor'};
    const citation = metadata.codeCitations![0];
    await gitStore.commit({
      content: formatMemoryDocument('MEMORY', metadata, 'Recovery evidence.'),
      message: 'seed citation recovery donor',
      path: gitCanonicalSharePath('durable', PROJECT, metadata.topic),
    });
    await repository.ingestGitShare(principal, 'citation-recovery-ingest');
    const donorUri = formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE, topic: metadata.topic});
    const input = {
      ...rememberInput({
        operationId: 'citation-recovery-create',
        text: 'Recover this exact cited publication.',
        topic: 'citation-recovery-target',
      }),
      citationSources: [{uri: donorUri, citationId: citation.id}],
    };
    const beforeCount = Number(await git(['rev-list', '--count', 'HEAD'], gitFixture.worktree));
    await fixture.migratorSql.unsafe(`
      CREATE FUNCTION remote_memory.fail_cited_remember_finalize() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected cited remember finalization failure'; END;
      $$;
      CREATE TRIGGER fail_cited_remember_finalize
        BEFORE INSERT ON remote_memory.memory_revisions
        FOR EACH ROW WHEN (NEW.operation_id = 'citation-recovery-create')
        EXECUTE FUNCTION remote_memory.fail_cited_remember_finalize();
    `);
    try {
      await expect(repository.remember(principal, input, 'citation-recovery-failed')).rejects.toThrow(
        'injected cited remember finalization failure',
      );
    } finally {
      await fixture.migratorSql.unsafe(`
        DROP TRIGGER IF EXISTS fail_cited_remember_finalize ON remote_memory.memory_revisions;
        DROP FUNCTION IF EXISTS remote_memory.fail_cited_remember_finalize();
      `);
    }
    expect(Number(await git(['rev-list', '--count', 'HEAD'], gitFixture.worktree))).toBe(beforeCount + 1);
    const donor = await repository.read(principal, {uri: donorUri, version: 1}, 'citation-recovery-donor-read');
    await repository.remember(
      principal,
      {
        ...rememberInput({
          operationId: 'citation-recovery-donor-clear',
          text: 'Recovery donor changed.',
          topic: metadata.topic,
        }),
        baseRevision: donor.receipt.revision,
        citationSources: [],
      },
      'citation-recovery-donor-clear',
    );
    const recovered = await repository.remember(principal, input, 'citation-recovery-retry');
    expect(Number(await git(['rev-list', '--count', 'HEAD'], gitFixture.worktree))).toBe(beforeCount + 2);
    const content = (await repository.read(principal, {uri: recovered.uri!, version: 1}, 'citation-recovery-read'))
      .content;
    expect(parseMemoryDocument(recovered.uri!, content)?.metadata.codeCitations).toEqual([citation]);
  });

  it('blocks unauthorized or missing citation donors before canonical publication', async () => {
    const citationId = richRemoteMemoryMetadata().codeCitations![0].id;
    for (const [suffix, uri, code] of [
      [
        'share',
        formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: 'other', topic: 'donor'}),
        'forbidden',
      ],
      [
        'project',
        formatRemoteMemoryUri({kind: 'durable', project: 'other', shareId: SHARE, topic: 'donor'}),
        'forbidden',
      ],
      [
        'missing',
        formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE, topic: 'missing-citation-donor'}),
        'invalid_request',
      ],
    ]) {
      const topic = `citation-rejected-${suffix}`;
      await expect(
        repository.remember(
          principal,
          {
            ...rememberInput({operationId: topic, topic, text: 'Must not publish.'}),
            citationSources: [{uri, citationId}],
          },
          topic,
        ),
      ).rejects.toMatchObject({code});
      expect(await Bun.file(join(gitFixture.worktree, gitCanonicalSharePath('durable', PROJECT, topic))).exists()).toBe(
        false,
      );
    }
  });

  it('rejects canonical Git donor drift after ingestion without publishing the target', async () => {
    const metadata = {...richRemoteMemoryMetadata(), project: PROJECT, topic: 'citation-drift-donor'};
    const path = gitCanonicalSharePath('durable', PROJECT, metadata.topic);
    const seeded = await gitStore.commit({
      content: formatMemoryDocument('MEMORY', metadata, 'Before drift.'),
      message: 'seed drift donor',
      path,
    });
    await repository.ingestGitShare(principal, 'citation-drift-ingest');
    await gitStore.commit({
      content: formatMemoryDocument('MEMORY', metadata, 'After drift.'),
      expectedContentHash: seeded.contentHash,
      message: 'drift donor',
      path,
    });
    const topic = 'citation-drift-target';
    await expect(
      repository.remember(
        principal,
        {
          ...rememberInput({operationId: topic, topic, text: 'Must not publish.'}),
          citationSources: [
            {
              uri: formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE, topic: metadata.topic}),
              citationId: metadata.codeCitations![0].id,
            },
          ],
        },
        topic,
      ),
    ).rejects.toMatchObject({code: 'conflict'});
    expect(await Bun.file(join(gitFixture.worktree, gitCanonicalSharePath('durable', PROJECT, topic))).exists()).toBe(
      false,
    );
  });

  it('writes a cloud remember to git without storing a postgres canonical body', async () => {
    const created = await repository.remember(
      principal,
      rememberInput({operationId: 'git-create', text: 'Composer wrote this for the laptop.', topic: 'git-roundtrip'}),
      'request-git-create',
    );
    const read = await repository.read(principal, {uri: created.uri!, version: 1}, 'request-git-read');
    expect(read.content).toContain('Composer wrote this for the laptop.');
    const stored = await withTenant(
      fixture.sql,
      TENANT,
      transaction =>
        transaction<{git_commit: string | null; git_path: string | null; markdown_body: string}[]>`
        SELECT markdown_body, git_commit, git_path
        FROM remote_memory.memory_revisions
        WHERE id = ${created.revision!}
      `,
    );
    expect(stored).toEqual([
      {
        git_commit: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
        git_path: gitCanonicalSharePath('durable', PROJECT, 'git-roundtrip'),
        markdown_body: '',
      },
    ]);
    const pointer = stored[0];
    expect(pointer).toBeDefined();
    const laptop = join(gitFixture.root, 'laptop');
    await cloneGitShareWorktree(gitFixture.remote, laptop);
    expect(await git(['show', `HEAD:${pointer.git_path}`], laptop)).toBe(read.content);
  });

  it('persists canonical relations in Git, preserves omission, clears explicit empty input, and reserves only valid writes', async () => {
    const firstTarget = await repository.remember(
      principal,
      rememberInput({operationId: 'relation-target-a', text: 'First relation target.', topic: 'relation-target-a'}),
      'request-relation-target-a',
    );
    const secondTarget = await repository.remember(
      principal,
      rememberInput({operationId: 'relation-target-b', text: 'Second relation target.', topic: 'relation-target-b'}),
      'request-relation-target-b',
    );
    const handoffTarget = await repository.remember(
      principal,
      rememberInput({
        kind: 'handoff',
        operationId: 'relation-handoff-target',
        text: 'Active handoff relation target.',
        topic: 'relation-handoff-target',
      }),
      'request-relation-handoff-target',
    );
    const relations = [
      {type: 'references' as const, uri: secondTarget.uri!},
      {type: 'depends_on' as const, uri: firstTarget.uri!},
      {type: 'related_to' as const, uri: handoffTarget.uri!},
    ];
    const created = await repository.remember(
      principal,
      rememberInput({
        operationId: 'relation-source-create',
        relations,
        text: 'Source with canonical relations.',
        topic: 'relation-source',
      }),
      'request-relation-source-create',
    );
    const replayed = await repository.remember(
      principal,
      rememberInput({
        operationId: 'relation-source-create',
        relations: [...relations].reverse(),
        text: 'Source with canonical relations.',
        topic: 'relation-source',
      }),
      'request-relation-source-replay',
    );
    expect(replayed.revision).toBe(created.revision);
    const createdRead = await repository.read(principal, {uri: created.uri!, version: 1}, 'request-relation-read');
    expect(createdRead.content).toContain(`relation: depends_on ${firstTarget.uri}`);
    expect(createdRead.content).toContain(`relation: references ${secondTarget.uri}`);
    expect(createdRead.content).toContain(`relation: related_to ${handoffTarget.uri}`);

    const preserved = await repository.remember(
      principal,
      rememberInput({
        baseRevision: created.revision,
        operationId: 'relation-source-preserve',
        text: 'Source body changed while preserving relations.',
        topic: 'relation-source',
      }),
      'request-relation-source-preserve',
    );
    const preservedRead = await repository.read(
      principal,
      {uri: created.uri!, version: 1},
      'request-relation-preserved-read',
    );
    expect(preservedRead.content).toContain(`relation: depends_on ${firstTarget.uri}`);
    expect(preservedRead.content).toContain(`relation: references ${secondTarget.uri}`);
    expect(preservedRead.content).toContain(`relation: related_to ${handoffTarget.uri}`);

    const cleared = await repository.remember(
      principal,
      rememberInput({
        baseRevision: preserved.revision,
        operationId: 'relation-source-clear',
        relations: [],
        text: 'Source body changed while clearing relations.',
        topic: 'relation-source',
      }),
      'request-relation-source-clear',
    );
    const clearedRead = await repository.read(
      principal,
      {uri: created.uri!, version: 1},
      'request-relation-clear-read',
    );
    expect(clearedRead.receipt.revision).toBe(cleared.revision);
    expect(clearedRead.content).not.toContain('relation:');

    const missingUri = formatRemoteMemoryUri({
      kind: 'durable',
      project: PROJECT,
      shareId: SHARE,
      topic: 'missing-relation-target',
    });
    await expect(
      repository.remember(
        principal,
        rememberInput({
          operationId: 'relation-source-missing',
          relations: [{type: 'references', uri: missingUri}],
          text: 'This source must not be written.',
          topic: 'relation-source-missing',
        }),
        'request-relation-source-missing',
      ),
    ).rejects.toMatchObject({code: 'invalid_request'});
    await repository.transitionHandoff(
      principal,
      {
        baseRevision: handoffTarget.revision!,
        operation: 'archive',
        operationId: 'relation-inactive-target-archive',
        uri: handoffTarget.uri!,
      },
      'request-relation-inactive-target-archive',
    );
    const replayedAfterTargetArchive = await repository.remember(
      principal,
      rememberInput({
        operationId: 'relation-source-create',
        relations: [...relations].reverse(),
        text: 'Source with canonical relations.',
        topic: 'relation-source',
      }),
      'request-relation-source-replay-after-archive',
    );
    expect(replayedAfterTargetArchive.revision).toBe(created.revision);
    await expect(
      repository.remember(
        principal,
        rememberInput({
          operationId: 'relation-source-inactive',
          relations: [{type: 'references', uri: handoffTarget.uri!}],
          text: 'This source must not relate to an archived handoff.',
          topic: 'relation-source-inactive',
        }),
        'request-relation-source-inactive',
      ),
    ).rejects.toMatchObject({code: 'invalid_request'});
    const reservations = await withTenant(
      fixture.migratorSql,
      TENANT,
      transaction => transaction<{count: string}[]>`
        SELECT count(*) AS count FROM remote_memory.idempotency_records
        WHERE operation_id = ANY(${transaction.array(['relation-source-missing', 'relation-source-inactive'])})
      `,
    );
    expect(Number(reservations[0]?.count)).toBe(0);
    expect(await indexer.runPass({batchSize: 32})).toMatchObject({failed: 0});
  });

  it('rejects a relation source when its target is archived after initial admission', async () => {
    const target = await repository.remember(
      principal,
      rememberInput({
        kind: 'handoff',
        operationId: 'relation-race-target',
        text: 'Target active during initial relation admission.',
        topic: 'relation-race-target',
      }),
      'request-relation-race-target',
    );
    const source = rememberInput({
      operationId: 'relation-race-source',
      relations: [{type: 'references', uri: target.uri!}],
      text: 'This source must not survive a target archival race.',
      topic: 'relation-race-source',
    });
    const logicalKey = formatRemoteMemoryLogicalKey({
      kind: source.kind,
      project: source.project,
      shareId: principal.shareId,
      tenantId: principal.tenantId,
      topic: source.topic,
      version: REMOTE_MEMORY_REVISION_VERSION,
    });
    let pending: ReturnType<typeof repository.remember> | undefined;

    await fixture.migratorSql.begin(async lockTransaction => {
      await lockTransaction`SELECT pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`;
      pending = repository.remember(principal, source, 'request-relation-race-source');
      await waitUntil(async () => {
        const rows = await withTenant(
          fixture.migratorSql,
          TENANT,
          transaction => transaction<{blocked: boolean; reserved: boolean}[]>`
            SELECT
              EXISTS(
                SELECT 1 FROM remote_memory.idempotency_records
                WHERE principal_id = ${PRINCIPAL} AND operation_id = ${source.operationId}
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
      await repository.transitionHandoff(
        principal,
        {
          baseRevision: target.revision!,
          operation: 'archive',
          operationId: 'relation-race-target-archive',
          uri: target.uri!,
        },
        'request-relation-race-target-archive',
      );
    });

    if (!pending) throw new Error('Relation race source did not start.');
    await expect(pending).rejects.toMatchObject({code: 'invalid_request'});
    const sourceHeads = await withTenant(
      fixture.migratorSql,
      TENANT,
      transaction => transaction<{count: string}[]>`
        SELECT count(*) AS count FROM remote_memory.memory_heads
        WHERE canonical_uri = ${formatRemoteMemoryUri({
          kind: source.kind,
          project: source.project,
          shareId: principal.shareId,
          topic: source.topic,
        })}
      `,
    );
    expect(Number(sourceHeads[0]?.count)).toBe(0);
    expect(
      await Bun.file(
        join(gitFixture.worktree, gitCanonicalSharePath(source.kind, source.project, source.topic)),
      ).exists(),
    ).toBe(false);
  });

  it('rejects a citation source when its donor is archived before final admission', async () => {
    const metadata = {
      ...richRemoteMemoryMetadata(),
      kind: 'handoff' as const,
      project: PROJECT,
      topic: 'citation-race-target',
    };
    await gitStore.commit({
      content: formatMemoryDocument('HANDOFF', metadata, 'Active donor.'),
      message: 'seed lifecycle donor',
      path: gitCanonicalSharePath('handoff', PROJECT, metadata.topic),
    });
    await repository.ingestGitShare(principal, 'citation-race-ingest');
    const uri = formatRemoteMemoryUri({kind: 'handoff', project: PROJECT, shareId: SHARE, topic: metadata.topic});
    const target = (await repository.read(principal, {uri, version: 1}, 'citation-race-read')).receipt;
    const source = {
      ...rememberInput({
        operationId: 'citation-race-source',
        topic: 'citation-race-source',
        text: 'Must not survive donor archival.',
      }),
      citationSources: [{uri, citationId: metadata.codeCitations![0].id}],
    };
    const logicalKey = formatRemoteMemoryLogicalKey({
      kind: source.kind,
      project: source.project,
      shareId: principal.shareId,
      tenantId: principal.tenantId,
      topic: source.topic,
      version: REMOTE_MEMORY_REVISION_VERSION,
    });
    let pending: ReturnType<typeof repository.remember> | undefined;

    await fixture.migratorSql.begin(async lockTransaction => {
      await lockTransaction`SELECT pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`;
      pending = repository.remember(principal, source, 'request-citation-race-source');
      await waitUntil(async () => {
        const rows = await withTenant(
          fixture.migratorSql,
          TENANT,
          transaction => transaction<{blocked: boolean; reserved: boolean}[]>`
            SELECT
              EXISTS(
                SELECT 1 FROM remote_memory.idempotency_records
                WHERE principal_id = ${PRINCIPAL} AND operation_id = ${source.operationId}
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
      await repository.transitionHandoff(
        principal,
        {
          baseRevision: target.revision!,
          operation: 'archive',
          operationId: 'citation-race-target-archive',
          uri,
        },
        'request-citation-race-target-archive',
      );
    });

    if (!pending) throw new Error('Relation race source did not start.');
    await expect(pending).rejects.toMatchObject({code: 'invalid_request'});
    const sourceHeads = await withTenant(
      fixture.migratorSql,
      TENANT,
      transaction => transaction<{count: string}[]>`
        SELECT count(*) AS count FROM remote_memory.memory_heads
        WHERE canonical_uri = ${formatRemoteMemoryUri({
          kind: source.kind,
          project: source.project,
          shareId: principal.shareId,
          topic: source.topic,
        })}
      `,
    );
    expect(Number(sourceHeads[0]?.count)).toBe(0);
    expect(
      await Bun.file(
        join(gitFixture.worktree, gitCanonicalSharePath(source.kind, source.project, source.topic)),
      ).exists(),
    ).toBe(false);
  });

  it('publishes relations without leasing a second PostgreSQL connection behind the admission fence', async () => {
    const target = await repository.remember(
      principal,
      rememberInput({
        operationId: 'relation-single-connection-target',
        text: 'Target for a one-connection relation writer.',
        topic: 'relation-single-connection-target',
      }),
      'request-relation-single-connection-target',
    );
    const singleConnectionSql = postgres(fixture.runtimeDatabaseUrl, {
      connect_timeout: 10,
      idle_timeout: 20,
      max: 1,
      onnotice: () => undefined,
      prepare: true,
    });
    try {
      const singleConnectionRepository = new PostgresRemoteMemoryRepository(singleConnectionSql, {gitStore});
      const created = await singleConnectionRepository.remember(
        principal,
        rememberInput({
          operationId: 'relation-single-connection-source',
          relations: [{type: 'references', uri: target.uri!}],
          text: 'A fenced relation write completes with one database lease.',
          topic: 'relation-single-connection-source',
        }),
        'request-relation-single-connection-source',
      );
      const read = await singleConnectionRepository.read(
        principal,
        {uri: created.uri!, version: 1},
        'request-relation-single-connection-read',
      );
      expect(read.content).toContain(`relation: references ${target.uri}`);
    } finally {
      await singleConnectionSql.end({timeout: 1});
    }
  }, 10_000);

  it('rejects one of two concurrent composer writes and keeps a single winner', async () => {
    const created = await repository.remember(
      principal,
      rememberInput({
        operationId: 'git-concurrent-base',
        text: 'Concurrent base body.',
        topic: 'git-concurrent',
      }),
      'request-git-concurrent-base',
    );
    const contenders = await Promise.allSettled([
      repository.remember(
        principal,
        rememberInput({
          baseRevision: created.revision,
          operationId: 'git-contender-a',
          text: 'Alpha overlayneedle from composer.',
          topic: 'git-concurrent',
        }),
        'request-git-contender-a',
      ),
      repository.remember(
        principal,
        rememberInput({
          baseRevision: created.revision,
          operationId: 'git-contender-b',
          text: 'Beta overlayneedle from composer.',
          topic: 'git-concurrent',
        }),
        'request-git-contender-b',
      ),
    ]);
    const winner = EffectOption.getOrUndefined(
      EffectArray.findFirst(contenders, result => result.status === 'fulfilled'),
    );
    const loser = EffectOption.getOrUndefined(
      EffectArray.findFirst(contenders, result => result.status === 'rejected'),
    );
    expect(winner?.status).toBe('fulfilled');
    expect(loser?.status).toBe('rejected');
    if (loser?.status !== 'rejected') throw new Error('expected a rejected concurrent remember');
    expect(loser.reason).toMatchObject({code: 'conflict'});
    const read = await repository.read(principal, {uri: created.uri!, version: 1}, 'request-git-concurrent-read');
    expect(
      Effect.pipe(read.content, EffectString.includes('Alpha overlayneedle from composer.')) ||
        Effect.pipe(read.content, EffectString.includes('Beta overlayneedle from composer.')),
    ).toBe(true);
    expect(await indexer.runPass({batchSize: 8})).toMatchObject({failed: 0});
    const recalled = await repository.recall(
      principal,
      {project: PROJECT, query: 'overlayneedle', version: 1},
      'request-git-recall',
    );
    expect(EffectArray.some(recalled.results, result => result.topic === 'git-concurrent')).toBe(true);
  });

  it('indexes a laptop git publish without copying the body into postgres', async () => {
    const topic = 'laptop-publish';
    const path = gitCanonicalSharePath('durable', PROJECT, topic);
    const laptop = join(gitFixture.root, 'laptop-writer');
    await cloneGitShareWorktree(gitFixture.remote, laptop);
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        project: PROJECT,
        sourceAgentClient: 'share',
        status: 'active',
        timestamp: '2026-09-04T12:00:00.000Z',
        topic,
        visibility: 'shared',
      },
      'Laptop share publish reached the composer.',
    );
    const target = join(laptop, ...Effect.pipe(path, EffectString.split('/')));
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, content, 'utf8');
    await git(['add', '--', path], laptop);
    await git(['commit', '-m', 'laptop publish'], laptop);
    await git(['push', 'origin', 'main'], laptop);

    const otherPath = gitCanonicalSharePath('durable', 'other-project', 'ignored');
    const otherTarget = join(laptop, ...Effect.pipe(otherPath, EffectString.split('/')));
    await mkdir(dirname(otherTarget), {recursive: true});
    await writeFile(
      otherTarget,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          project: 'other-project',
          sourceAgentClient: 'share',
          status: 'active',
          timestamp: '2026-09-04T12:00:00.000Z',
          topic: 'ignored',
          visibility: 'shared',
        },
        'Canonical project is indexed independently of this member permission.',
      ),
      'utf8',
    );
    await git(['add', '--', otherPath], laptop);
    await git(['commit', '-m', 'another canonical project'], laptop);
    await git(['push', 'origin', 'main'], laptop);

    expect(await indexer.runPass({batchSize: 8})).toMatchObject({failed: 0});
    const uri = formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE, topic});
    const read = await repository.read(principal, {uri, version: 1}, 'request-git-ingest-read');
    expect(read.content).toContain('Laptop share publish reached the composer.');
    const stored = await withTenant(
      fixture.sql,
      TENANT,
      transaction =>
        transaction<{markdown_body: string; topic: string}[]>`
        SELECT r.markdown_body, h.topic FROM remote_memory.memory_revisions r
        JOIN remote_memory.memory_heads h
          ON h.tenant_id = r.tenant_id AND h.share_id = r.share_id AND h.current_revision_id = r.id
        WHERE h.topic = ${topic} OR h.topic = 'ignored'
        ORDER BY h.topic
      `,
    );
    expect(stored).toEqual([
      {markdown_body: '', topic: 'ignored'},
      {markdown_body: '', topic},
    ]);
    await expect(
      repository.read(
        principal,
        {
          uri: formatRemoteMemoryUri({kind: 'durable', project: 'other-project', shareId: SHARE, topic: 'ignored'}),
          version: 1,
        },
        'restricted-member-read',
      ),
    ).rejects.toMatchObject({code: 'forbidden'});
  });

  it('keeps an archived handoff inactive until a later explicit Git publication', async () => {
    const created = await repository.remember(
      principal,
      {
        kind: 'handoff',
        operationId: 'git-expired-handoff',
        project: PROJECT,
        text: 'Active handoff body.',
        topic: 'git-expired',
        version: 1,
      },
      'request-git-expired-create',
    );
    const archived = await repository.transitionHandoff(
      principal,
      {
        baseRevision: created.revision!,
        operation: 'archive',
        operationId: 'git-expired-archive',
        uri: created.uri!,
      },
      'request-git-expired-archive',
    );
    expect(archived.revision).toBeTruthy();
    expect(await indexer.runPass({batchSize: 8})).toMatchObject({failed: 0});
    expect(
      (await repository.read(principal, {uri: created.uri!, version: 1}, 'archived-before-republish')).status,
    ).toBe('archived');
    const path = gitCanonicalSharePath('handoff', PROJECT, 'git-expired');
    const laptop = join(gitFixture.root, 'laptop-expired');
    await cloneGitShareWorktree(gitFixture.remote, laptop);
    const target = join(laptop, ...Effect.pipe(path, EffectString.split('/')));
    await mkdir(dirname(target), {recursive: true});
    await writeFile(
      target,
      formatMemoryDocument(
        'HANDOFF',
        {
          kind: 'handoff',
          project: PROJECT,
          sourceAgentClient: 'share',
          status: 'active',
          timestamp: '2026-09-04T12:00:00.000Z',
          topic: 'git-expired',
          visibility: 'shared',
        },
        'Explicit later publication reactivates the handoff.',
      ),
      'utf8',
    );
    await git(['add', '--', path], laptop);
    await git(['commit', '-m', 'resurrect expired'], laptop);
    await git(['push', 'origin', 'main'], laptop);
    expect(await indexer.runPass({batchSize: 8})).toMatchObject({failed: 0});
    const read = await repository.read(principal, {uri: created.uri!, version: 1}, 'request-git-expired-read');
    expect(read.status).toBe('active');
    expect(read.content).toContain('Explicit later publication reactivates the handoff.');
  });
});

postgresDescribe('composer serve ingest of git files without a provisioned catalog', () => {
  let fixture: RemoteMemoryPostgresFixture;
  let gitFixture: GitShareWorktreeFixture;
  let repository: PostgresRemoteMemoryRepository;
  let principal: AuthorizedRemotePrincipal;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) throw new Error('THREADNOTE_TEST_POSTGRES_URL is required.');
    fixture = await createRemoteMemoryPostgresFixture(TEST_DATABASE_URL);
    gitFixture = await createGitShareWorktreeFixture('threadnote-git-composer-uncataloged-');
    await provisionGitTeamShare(new PostgresRemoteControlPlane(fixture.migratorSql), {
      issuer: ISSUER,
      shareId: SHARE,
      subject: 'subject-git',
      tenantId: TENANT,
    });
    await withTenant(
      fixture.migratorSql,
      TENANT,
      transaction =>
        transaction`
        INSERT INTO remote_memory.projects(tenant_id, share_id, name, status)
        VALUES (${TENANT}, ${SHARE}, 'retired-project', 'archived')
      `,
    );
    const gitStore = new GitCanonicalMemoryStore({
      worktreeLock: testGitWorktreeLock,
      binding: {tenantId: TENANT, shareId: SHARE},
      worktree: gitFixture.worktree,
    });
    repository = new PostgresRemoteMemoryRepository(fixture.sql, {gitStore});
    const authorized = await new PostgresRemoteControlPlane(fixture.sql).authorize(claims(), SHARE);
    if (!authorized) throw new Error('Uncataloged composer fixture authorization failed.');
    principal = authorized;
  });

  afterAll(async () => {
    await fixture?.dispose();
    if (gitFixture) await rm(gitFixture.root, {force: true, recursive: true});
  });

  it('creates project rows from the git layout and indexes existing markdown without postgres bodies', async () => {
    const topic = 'preexisting-share';
    const project = 'existing-share';
    const laptop = join(gitFixture.root, 'existing-share-writer');
    await cloneGitShareWorktree(gitFixture.remote, laptop);
    await writeCanonicalMemory(laptop, 'durable', project, topic, 'Existing team markdown reached composer.');
    await writeCanonicalMemory(
      laptop,
      'durable',
      'retired-project',
      'ignored-retired',
      'Archived catalog entries must stay skipped.',
    );

    const ingested = await repository.ingestActiveGitShares('request-uncataloged-ingest');
    expect(ingested.ingested).toBe(1);
    const listed = await repository.list(principal, {limit: 10}, 'request-uncataloged-list');
    expect(listed.entries).toEqual([expect.objectContaining({kind: 'durable', project, status: 'active', topic})]);
    const uri = formatRemoteMemoryUri({kind: 'durable', project, shareId: SHARE, topic});
    const read = await repository.read(principal, {uri, version: 1}, 'request-uncataloged-read');
    expect(read.content).toContain('Existing team markdown reached composer.');
    const stored = await withTenant(
      fixture.sql,
      TENANT,
      transaction =>
        transaction<{markdown_body: string; name: string; status: string}[]>`
        SELECT p.name, p.status, COALESCE(r.markdown_body, '') AS markdown_body
        FROM remote_memory.projects p
        LEFT JOIN remote_memory.memory_heads h
          ON h.tenant_id = p.tenant_id AND h.share_id = p.share_id AND h.project = p.name
        LEFT JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        WHERE p.share_id = ${SHARE}
        ORDER BY p.name
      `,
    );
    expect(stored).toEqual([
      {markdown_body: '', name: project, status: 'active'},
      {markdown_body: '', name: 'retired-project', status: 'archived'},
    ]);
  });
});

function claims(): OAuthPrincipalClaims {
  return {issuer: ISSUER, scopes: new Set(ALL_SCOPES), subject: 'subject-git'};
}

function rememberInput(input: {
  readonly baseRevision?: string;
  readonly kind?: 'durable' | 'handoff';
  readonly operationId: string;
  readonly relations?: RemoteRememberInputV1['relations'];
  readonly text: string;
  readonly topic: string;
}): RemoteRememberInputV1 {
  return {
    ...(input.baseRevision ? {baseRevision: input.baseRevision} : {}),
    kind: input.kind ?? 'durable',
    operationId: input.operationId,
    project: PROJECT,
    ...(input.relations === undefined ? {} : {relations: input.relations}),
    text: input.text,
    topic: input.topic,
    version: 1,
  };
}

async function writeCanonicalMemory(
  worktree: string,
  kind: 'durable' | 'handoff',
  project: string,
  topic: string,
  text: string,
): Promise<string> {
  const path = gitCanonicalSharePath(kind, project, topic);
  const target = join(worktree, ...Effect.pipe(path, EffectString.split('/')));
  await mkdir(dirname(target), {recursive: true});
  await writeFile(
    target,
    formatMemoryDocument(
      kind === 'durable' ? 'MEMORY' : 'HANDOFF',
      {
        kind,
        project,
        sourceAgentClient: 'share',
        status: 'active',
        timestamp: '2026-09-04T12:00:00.000Z',
        topic,
        visibility: 'shared',
      },
      text,
    ),
    'utf8',
  );
  await git(['add', '--', path], worktree);
  await git(['commit', '-m', `share ${kind} ${project}/${topic}`], worktree);
  await git(['push', 'origin', 'main'], worktree);
  return path;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for PostgreSQL test state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function withTenant<A>(sql: Sql, tenantId: string, use: (transaction: TransactionSql) => Promise<A>): Promise<A> {
  return sql
    .begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
      return {result: await use(transaction)};
    })
    .then(({result}) => result);
}
