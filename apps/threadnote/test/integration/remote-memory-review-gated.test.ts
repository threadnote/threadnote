import {Array as EffectArray} from 'effect';
import {richRemoteMemoryMetadata} from '@threadnote/memory/test/helpers/remote-memory-document';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {rm} from '@threadnote/testing/node-fs-promises';
import {testGitWorktreeLock} from '../helpers/git-worktree-lock.js';
import {createGitShareWorktreeFixture, git, type GitShareWorktreeFixture} from '@threadnote/testing/git-share-worktree';
import {
  createRemoteMemoryPostgresFixture,
  type RemoteMemoryPostgresFixture,
} from '../helpers/remote-memory-postgres.js';
import {formatRemoteMemoryUri} from '@threadnote/memory/remote/address';
import type {RemoteRememberInputV1} from '@threadnote/memory/remote/contracts';
import type {AuthorizedRemotePrincipal, RemoteMemoryScope} from '@threadnote/remote-memory/authorization';
import {GitCanonicalMemoryStore, gitCanonicalSharePath} from '@threadnote/remote-memory/git/canonical_store';
import type {CursorWorkloadAttestation} from '@threadnote/remote-memory/cursor_oidc';
import type {OAuthPrincipalClaims} from '@threadnote/remote-memory/oauth';
import {RemoteHandoffRetentionWorker} from '@threadnote/remote-memory/handoff_retention';
import {PostgresRemoteControlPlane} from '@threadnote/remote-memory/postgres/control_plane';
import {PostgresRemoteMemoryRepository} from '@threadnote/remote-memory/postgres/repository';
import {PostgresRemoteRateLimiter} from '@threadnote/remote-memory/rate_limit';
import {acquireRemoteRelationAdmissionTransactionLock} from '@threadnote/remote-memory/relation_admission';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const TEST_DATABASE_URL = process.env.THREADNOTE_TEST_POSTGRES_URL;
const postgresDescribe = TEST_DATABASE_URL ? describe : describe.skip;
const ISSUER = 'https://identity.review-gated.test';
const PROJECT = 'threadnote';
const TENANT = 'tenant-review-gated';
const SHARE = 'share-review-gated';
const OTHER_SHARE = 'share-review-gated-other';
const OTHER_TENANT = 'tenant-review-gated-other';
const OTHER_TENANT_SHARE = 'share-review-gated-tenant';
const PROPOSER = 'principal-proposer';
const REVIEWER = 'principal-reviewer';
const PROPOSER_SCOPES = ['memory:read', 'memory:propose:durable'] as const satisfies readonly RemoteMemoryScope[];
const REVIEWER_SCOPES = [
  'memory:read',
  'memory:review:durable',
  'memory:write:durable',
] as const satisfies readonly RemoteMemoryScope[];

postgresDescribe('review-gated durable organization memory', () => {
  let fixture: RemoteMemoryPostgresFixture;
  let gitFixture: GitShareWorktreeFixture;
  let gitStore: GitCanonicalMemoryStore;
  let repository: PostgresRemoteMemoryRepository;
  let proposer: AuthorizedRemotePrincipal;
  let reviewer: AuthorizedRemotePrincipal;
  let otherShareReviewer: AuthorizedRemotePrincipal;
  let otherTenantReviewer: AuthorizedRemotePrincipal;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) throw new Error('THREADNOTE_TEST_POSTGRES_URL is required.');
    fixture = await createRemoteMemoryPostgresFixture(TEST_DATABASE_URL);
    gitFixture = await createGitShareWorktreeFixture('threadnote-review-gated-');
    const operator = new PostgresRemoteControlPlane(fixture.migratorSql);
    await operator.provision({
      allowedProjects: [PROJECT],
      capabilities: PROPOSER_SCOPES,
      cursorAttestationRequired: false,
      cursorSubjects: ['user:7001'],
      displayName: 'Review-gated share',
      featureFlags: ['remote_memory_read', 'remote_memory_durable_write', 'remote_memory_ga'],
      issuer: ISSUER,
      policyVersion: 'proposer-v1',
      principalId: PROPOSER,
      projects: [PROJECT],
      region: 'test-region',
      repositoryBindings: {[PROJECT]: ['https://github.com/example/threadnote-review-gated.git']},
      shareId: SHARE,
      sharePolicyVersion: 'share-v1',
      subject: 'subject-proposer',
      tenantId: TENANT,
    });
    await operator.provision({
      allowedProjects: [PROJECT],
      capabilities: REVIEWER_SCOPES,
      cursorAttestationRequired: false,
      cursorSubjects: ['user:7002'],
      displayName: 'Review-gated share',
      issuer: ISSUER,
      policyVersion: 'reviewer-v1',
      principalId: REVIEWER,
      shareId: SHARE,
      subject: 'subject-reviewer',
      tenantId: TENANT,
      region: 'test-region',
    });
    await operator.provision({
      allowedProjects: [PROJECT],
      capabilities: REVIEWER_SCOPES,
      cursorAttestationRequired: false,
      cursorSubjects: ['user:7003'],
      displayName: 'Other review-gated share',
      featureFlags: ['remote_memory_read', 'remote_memory_durable_write', 'remote_memory_ga'],
      issuer: ISSUER,
      policyVersion: 'other-share-reviewer-v1',
      principalId: 'principal-other-share-reviewer',
      projects: [PROJECT],
      region: 'test-region',
      repositoryBindings: {[PROJECT]: ['https://github.com/example/threadnote-review-gated-other.git']},
      shareId: OTHER_SHARE,
      sharePolicyVersion: 'other-share-v1',
      subject: 'subject-other-share-reviewer',
      tenantId: TENANT,
    });
    await operator.provision({
      allowedProjects: [PROJECT],
      capabilities: REVIEWER_SCOPES,
      cursorAttestationRequired: false,
      cursorSubjects: ['user:7004'],
      displayName: 'Other tenant review-gated share',
      featureFlags: ['remote_memory_read', 'remote_memory_durable_write', 'remote_memory_ga'],
      issuer: ISSUER,
      policyVersion: 'other-tenant-reviewer-v1',
      principalId: 'principal-other-tenant-reviewer',
      projects: [PROJECT],
      region: 'test-region',
      repositoryBindings: {[PROJECT]: ['https://github.com/example/threadnote-review-gated-tenant.git']},
      shareId: OTHER_TENANT_SHARE,
      sharePolicyVersion: 'other-tenant-share-v1',
      subject: 'subject-other-tenant-reviewer',
      tenantId: OTHER_TENANT,
    });
    const control = new PostgresRemoteControlPlane(fixture.sql);
    const authorizedProposer = await control.authorize(claims('subject-proposer', PROPOSER_SCOPES), SHARE);
    const authorizedReviewer = await control.authorize(claims('subject-reviewer', REVIEWER_SCOPES), SHARE);
    const authorizedOtherShare = await control.authorize(
      claims('subject-other-share-reviewer', REVIEWER_SCOPES),
      OTHER_SHARE,
    );
    const authorizedOtherTenant = await control.authorize(
      claims('subject-other-tenant-reviewer', REVIEWER_SCOPES),
      OTHER_TENANT_SHARE,
    );
    if (!authorizedProposer || !authorizedReviewer || !authorizedOtherShare || !authorizedOtherTenant) {
      throw new Error('Review-gated fixture authorization failed.');
    }
    proposer = authorizedProposer;
    reviewer = authorizedReviewer;
    otherShareReviewer = authorizedOtherShare;
    otherTenantReviewer = authorizedOtherTenant;
    gitStore = new GitCanonicalMemoryStore({
      binding: {shareId: SHARE, tenantId: TENANT},
      worktree: gitFixture.worktree,
      worktreeLock: testGitWorktreeLock,
    });
    repository = new PostgresRemoteMemoryRepository(fixture.sql, {gitStore});
  });

  afterAll(async () => {
    await fixture?.dispose();
    if (gitFixture) await rm(gitFixture.root, {force: true, recursive: true});
  });

  it('stores canonical citation selectors and revalidates them at approval', async () => {
    const metadata = {...richRemoteMemoryMetadata(), project: PROJECT, topic: 'proposal-citation-donor'};
    const citation = metadata.codeCitations![0];
    await gitStore.commit({
      content: formatMemoryDocument('MEMORY', metadata, 'Donor evidence.'),
      message: 'seed proposal citation donor',
      path: gitCanonicalSharePath('durable', PROJECT, metadata.topic),
    });
    await repository.ingestGitShare(reviewer, 'proposal-citation-ingest');
    const citationSources = [{uri: durableUri(metadata.topic), citationId: citation.id}];
    const input = {
      operationId: 'proposal-citation',
      project: PROJECT,
      topic: 'proposal-citation-target',
      text: 'Candidate.',
      citationSources,
      version: 1 as const,
    };
    const proposed = await repository.proposeDurable(proposer, input, 'proposal-citation');
    expect(
      await repository.proposeDurable(
        proposer,
        {...input, citationSources: [...citationSources, ...citationSources]},
        'proposal-citation-replay',
      ),
    ).toEqual(proposed);
    const stored = await repository.readProposal(reviewer, proposed.proposalId);
    expect(stored.payload?.citationSources).toEqual(citationSources);
    expect(stored.payload).not.toHaveProperty('codeCitations');
    const review = {
      decision: 'approve' as const,
      operationId: 'approve-citation',
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      version: 1 as const,
    };
    const approved = await repository.reviewProposal(reviewer, review, 'approve-citation');
    expect(approved.status).toBe('approved');
    expect((await repository.reviewProposal(reviewer, review, 'approve-citation-replay')).result).toEqual(
      approved.result,
    );
    expect(
      parseMemoryDocument(
        approved.result!.uri!,
        (await repository.read(reviewer, {uri: approved.result!.uri!, version: 1}, 'read-citation-approved')).content,
      )?.metadata.codeCitations,
    ).toEqual([citation]);
    const stale = await repository.proposeDurable(
      proposer,
      {...input, operationId: 'proposal-citation-stale', topic: 'proposal-citation-stale'},
      'proposal-citation-stale',
    );
    const donor = await repository.read(reviewer, {uri: citationSources[0].uri, version: 1}, 'read-donor');
    await repository.remember(
      reviewer,
      {
        ...rememberInput('clear-proposal-donor', 'Evidence removed.', metadata.topic),
        baseRevision: donor.receipt.revision,
        citationSources: [],
      },
      'clear-proposal-donor',
    );
    await expect(
      repository.reviewProposal(
        reviewer,
        {...review, operationId: 'approve-citation-stale', proposalId: stale.proposalId, revision: stale.revision},
        'approve-citation-stale',
      ),
    ).rejects.toMatchObject({code: 'invalid_request'});
    expect((await repository.readProposal(reviewer, stale.proposalId)).status).toBe('conflict');
    expect(
      await Bun.file(
        `${gitFixture.worktree}/${gitCanonicalSharePath('durable', PROJECT, 'proposal-citation-stale')}`,
      ).exists(),
    ).toBe(false);
  });

  it('keeps proposals outside Git until approval, then writes canonically and replays idempotently', async () => {
    const before = await head();
    const proposed = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-approved-create',
        project: PROJECT,
        text: 'Approved only after independent review.',
        topic: 'proposal-approved',
        version: 1,
      },
      'request-propose-approved',
    );
    expect(proposed.status).toBe('pending');
    expect(await head()).toBe(before);
    expect(
      await repository.proposeDurable(
        proposer,
        {
          operationId: 'proposal-approved-create',
          project: PROJECT,
          text: 'Approved only after independent review.',
          topic: 'proposal-approved',
          version: 1,
        },
        'request-propose-approved-replay',
      ),
    ).toEqual(proposed);

    const queue = await repository.listProposals(reviewer, {limit: 10, status: 'pending', version: 1});
    expect(queue.entries).toContainEqual(expect.objectContaining({proposalId: proposed.proposalId, status: 'pending'}));
    expect((await repository.readProposal(reviewer, proposed.proposalId)).payload?.text).toBe(
      'Approved only after independent review.',
    );
    expect(
      (await repository.list(reviewer, {limit: 10, project: PROJECT}, 'request-list-before-approval')).entries,
    ).not.toContainEqual(expect.objectContaining({topic: 'proposal-approved'}));
    expect(
      (
        await repository.recall(
          reviewer,
          {kinds: ['durable'], limit: 10, project: PROJECT, query: 'independent review', version: 1},
          'request-recall-before-approval',
        )
      ).results,
    ).toEqual([]);

    const review = {
      decision: 'approve' as const,
      operationId: 'review-approved',
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      version: 1 as const,
    };
    const approved = await repository.reviewProposal(reviewer, review, 'request-review-approved');
    expect(approved).toMatchObject({status: 'approved', result: {uri: durableUri('proposal-approved')}});
    expect(await head()).not.toBe(before);
    const read = await repository.read(
      reviewer,
      {uri: durableUri('proposal-approved'), version: 1},
      'request-read-approved',
    );
    expect(read.content).toContain('Approved only after independent review.');
    expect(await repository.reviewProposal(reviewer, review, 'request-review-approved-replay')).toMatchObject({
      proposalId: proposed.proposalId,
      status: 'approved',
    });
  });

  it('rejects without writing Git', async () => {
    const before = await head();
    const proposed = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-rejected-create',
        project: PROJECT,
        text: 'This candidate will be rejected.',
        topic: 'proposal-rejected',
        version: 1,
      },
      'request-propose-rejected',
    );
    const rejected = await repository.reviewProposal(
      reviewer,
      {
        decision: 'reject',
        operationId: 'review-rejected',
        proposalId: proposed.proposalId,
        reason: 'The durable claim is not supported.',
        revision: proposed.revision,
        version: 1,
      },
      'request-review-rejected',
    );
    expect(rejected.status).toBe('rejected');
    await expect(
      repository.reviewProposal(
        reviewer,
        {
          decision: 'reject',
          operationId: 'review-rejected',
          proposalId: proposed.proposalId,
          reason: 'A different audit reason.',
          revision: proposed.revision,
          version: 1,
        },
        'request-review-rejected-mismatch',
      ),
    ).rejects.toMatchObject({code: 'idempotency_mismatch'});
    expect(await head()).toBe(before);
    await expect(
      repository.read(reviewer, {uri: durableUri('proposal-rejected'), version: 1}, 'request-read-rejected'),
    ).rejects.toMatchObject({code: 'not_found'});

    const revoked = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-rejected-revoked-create',
        project: PROJECT,
        text: 'Revoked reviewers cannot finalize a rejection.',
        topic: 'proposal-rejected-revoked',
        version: 1,
      },
      'request-propose-rejected-revoked',
    );
    await setReviewerGrantStatus('revoked');
    try {
      await expect(
        repository.reviewProposal(
          reviewer,
          {
            decision: 'reject',
            operationId: 'review-rejected-revoked',
            proposalId: revoked.proposalId,
            reason: 'This must not commit with a revoked grant.',
            revision: revoked.revision,
            version: 1,
          },
          'request-review-rejected-revoked',
        ),
      ).rejects.toMatchObject({code: 'forbidden'});
    } finally {
      await setReviewerGrantStatus('active');
    }
    expect((await repository.readProposal(reviewer, revoked.proposalId)).status).toBe('pending');
  });

  it('rechecks stale replacement CAS and relation liveness at approval', async () => {
    const source = await repository.remember(
      reviewer,
      rememberInput('proposal-revalidation-source', 'Original.', 'proposal-source'),
      'request-proposal-source',
    );
    const stale = await repository.proposeDurable(
      proposer,
      {
        baseRevision: source.revision,
        operationId: 'proposal-stale-create',
        project: PROJECT,
        replaceUri: source.uri,
        text: 'Stale replacement.',
        topic: 'proposal-source',
        version: 1,
      },
      'request-proposal-stale',
    );
    await repository.remember(
      reviewer,
      {
        ...rememberInput('proposal-source-advance', 'Advanced.', 'proposal-source'),
        baseRevision: source.revision,
      },
      'request-proposal-source-advance',
    );
    await expect(
      repository.reviewProposal(
        reviewer,
        {
          decision: 'approve',
          operationId: 'review-stale',
          proposalId: stale.proposalId,
          revision: stale.revision,
          version: 1,
        },
        'request-review-stale',
      ),
    ).rejects.toMatchObject({code: 'conflict'});
    expect((await repository.readProposal(reviewer, stale.proposalId)).status).toBe('conflict');

    const relation = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-relation-create',
        project: PROJECT,
        relations: [{type: 'references', uri: durableUri('proposal-missing-target')}],
        text: 'Relation target must remain live.',
        topic: 'proposal-relation-source',
        version: 1,
      },
      'request-proposal-relation',
    );
    await expect(
      repository.reviewProposal(
        reviewer,
        {
          decision: 'approve',
          operationId: 'review-relation-dead',
          proposalId: relation.proposalId,
          revision: relation.revision,
          version: 1,
        },
        'request-review-relation-dead',
      ),
    ).rejects.toMatchObject({code: 'invalid_request'});
    expect((await repository.readProposal(reviewer, relation.proposalId)).status).toBe('conflict');
  });

  it('enforces independent review, content policy, and tenant/share isolation before publication', async () => {
    const secretOperation = 'proposal-secret-create';
    await expect(
      repository.proposeDurable(
        proposer,
        {
          operationId: secretOperation,
          project: PROJECT,
          text: 'Do not store sk-abcdefghijklmnop',
          topic: 'proposal-secret',
          version: 1,
        },
        'request-proposal-secret',
      ),
    ).rejects.toMatchObject({code: 'invalid_request'});
    const secretRows = await fixture.sql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${TENANT}, true)`;
      return transaction<{count: string}[]>`
        SELECT count(*) FROM remote_memory.durable_memory_proposals WHERE operation_id = ${secretOperation}
      `;
    });
    expect(secretRows).toEqual([{count: '0'}]);

    const isolated = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-isolation-create',
        project: PROJECT,
        text: 'Only the bound tenant and share may review this.',
        topic: 'proposal-isolation',
        version: 1,
      },
      'request-proposal-isolation',
    );
    for (const outsider of [otherShareReviewer, otherTenantReviewer]) {
      expect((await repository.listProposals(outsider, {limit: 10, version: 1})).entries).toEqual([]);
      await expect(repository.readProposal(outsider, isolated.proposalId)).rejects.toMatchObject({code: 'not_found'});
      await expect(
        repository.reviewProposal(
          outsider,
          {
            decision: 'approve',
            operationId: `review-isolation-${outsider.tenantId}-${outsider.shareId}`,
            proposalId: isolated.proposalId,
            revision: isolated.revision,
            version: 1,
          },
          'request-review-isolation',
        ),
      ).rejects.toMatchObject({code: 'forbidden'});
    }
    const tenantLeak = await fixture.sql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${OTHER_TENANT}, true)`;
      return transaction<{id: string}[]>`
        SELECT id FROM remote_memory.durable_memory_proposals WHERE id = ${isolated.proposalId}
      `;
    });
    expect(tenantLeak).toEqual([]);

    const selfProposed = await repository.proposeDurable(
      reviewer,
      {
        operationId: 'proposal-self-review-create',
        project: PROJECT,
        text: 'A proposer cannot review its own candidate.',
        topic: 'proposal-self-review',
        version: 1,
      },
      'request-proposal-self-review',
    );
    await expect(
      repository.reviewProposal(
        reviewer,
        {
          decision: 'approve',
          operationId: 'review-self-review',
          proposalId: selfProposed.proposalId,
          revision: selfProposed.revision,
          version: 1,
        },
        'request-review-self-review',
      ),
    ).rejects.toMatchObject({code: 'forbidden'});
  });

  it('recovers the same cited approval after Git lands even when the donor changes before retry', async () => {
    const originalAttestation = await insertReviewerAttestation('recovery-original');
    const differentAttestation = await insertReviewerAttestation('recovery-different');
    const donorMetadata = {...richRemoteMemoryMetadata(), project: PROJECT, topic: 'proposal-recovery-donor'};
    const citation = donorMetadata.codeCitations![0];
    await gitStore.commit({
      content: formatMemoryDocument('MEMORY', donorMetadata, 'Recovery donor evidence.'),
      message: 'seed proposal recovery donor',
      path: gitCanonicalSharePath('durable', PROJECT, donorMetadata.topic),
    });
    await repository.ingestGitShare(reviewer, 'proposal-recovery-donor-ingest');
    const proposed = await repository.proposeDurable(
      proposer,
      {
        citationSources: [{citationId: citation.id, uri: durableUri(donorMetadata.topic)}],
        operationId: 'proposal-recovery-create',
        project: PROJECT,
        text: 'Recovery reuses one canonical Git commit.',
        topic: 'proposal-recovery',
        version: 1,
      },
      'request-proposal-recovery',
    );
    const review = {
      decision: 'approve' as const,
      operationId: 'review-recovery',
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      version: 1 as const,
    };
    const beforeCount = Number(await git(['rev-list', '--count', 'HEAD'], gitFixture.worktree));
    await fixture.migratorSql.unsafe(`
      CREATE FUNCTION remote_memory.fail_review_gated_finalize() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected review finalization failure'; END;
      $$;
      CREATE TRIGGER fail_review_gated_finalize
        BEFORE UPDATE ON remote_memory.durable_memory_proposals
        FOR EACH ROW WHEN (NEW.status = 'approved')
        EXECUTE FUNCTION remote_memory.fail_review_gated_finalize();
    `);
    try {
      await expect(
        repository.reviewProposal(reviewer, review, 'request-review-recovery-failed', originalAttestation),
      ).rejects.toThrow('injected review finalization failure');
    } finally {
      await fixture.migratorSql.unsafe(`
        DROP TRIGGER IF EXISTS fail_review_gated_finalize ON remote_memory.durable_memory_proposals;
        DROP FUNCTION IF EXISTS remote_memory.fail_review_gated_finalize();
      `);
    }
    expect(Number(await git(['rev-list', '--count', 'HEAD'], gitFixture.worktree))).toBe(beforeCount + 1);
    expect((await repository.readProposal(reviewer, proposed.proposalId)).status).toBe('pending');
    const donor = await repository.read(reviewer, {uri: durableUri(donorMetadata.topic), version: 1}, 'recovery-donor');
    await repository.remember(
      reviewer,
      {
        ...rememberInput('proposal-recovery-donor-clear', 'Recovery donor changed.', donorMetadata.topic),
        baseRevision: donor.receipt.revision,
        citationSources: [],
      },
      'proposal-recovery-donor-clear',
    );
    await expect(
      repository.reviewProposal(reviewer, review, 'request-review-recovery-wrong-attestation', differentAttestation),
    ).rejects.toMatchObject({code: 'idempotency_mismatch'});
    const recovered = await repository.reviewProposal(
      reviewer,
      review,
      'request-review-recovery-retry',
      originalAttestation,
    );
    expect(recovered.status).toBe('approved');
    expect(Number(await git(['rev-list', '--count', 'HEAD'], gitFixture.worktree))).toBe(beforeCount + 2);
    const recoveredContent = await git(
      ['show', `HEAD:${gitCanonicalSharePath('durable', PROJECT, 'proposal-recovery')}`],
      gitFixture.worktree,
    );
    expect(recoveredContent).toContain('source_agent_client: cursor');
    expect(parseMemoryDocument(recovered.result!.uri!, recoveredContent)?.metadata.codeCitations).toEqual([citation]);
  });

  it('leases failed approval claims for bounded takeover and rechecks current grant policy', async () => {
    const now = new Date('2026-09-16T12:00:00.000Z');
    const proposed = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-lease-create',
        project: PROJECT,
        text: 'A failed claim can be recovered after its lease.',
        topic: 'proposal-lease',
        version: 1,
      },
      'request-proposal-lease',
      undefined,
      now,
    );
    const commit = vi.spyOn(gitStore, 'commit').mockRejectedValueOnce(new Error('injected pre-Git failure'));
    await expect(
      repository.reviewProposal(
        reviewer,
        {
          decision: 'approve',
          operationId: 'review-lease-first',
          proposalId: proposed.proposalId,
          revision: proposed.revision,
          version: 1,
        },
        'request-review-lease-first',
        undefined,
        now,
      ),
    ).rejects.toThrow('injected pre-Git failure');
    commit.mockRestore();
    await expect(
      repository.reviewProposal(
        reviewer,
        {
          decision: 'approve',
          operationId: 'review-lease-second',
          proposalId: proposed.proposalId,
          revision: proposed.revision,
          version: 1,
        },
        'request-review-lease-active',
        undefined,
        new Date(now.getTime() + 60_000),
      ),
    ).rejects.toMatchObject({code: 'conflict'});
    await setReviewerGrantStatus('revoked');
    try {
      await expect(
        repository.reviewProposal(
          reviewer,
          {
            decision: 'approve',
            operationId: 'review-lease-takeover',
            proposalId: proposed.proposalId,
            revision: proposed.revision,
            version: 1,
          },
          'request-review-lease-revoked',
          undefined,
          new Date(now.getTime() + 6 * 60_000),
        ),
      ).rejects.toMatchObject({code: 'forbidden'});
    } finally {
      await setReviewerGrantStatus('active');
    }
    const recovered = await repository.reviewProposal(
      reviewer,
      {
        decision: 'approve',
        operationId: 'review-lease-takeover',
        proposalId: proposed.proposalId,
        revision: proposed.revision,
        version: 1,
      },
      'request-review-lease-recovered',
      undefined,
      new Date(now.getTime() + 6 * 60_000),
    );
    expect(recovered.status).toBe('approved');
  });

  it('fails closed before Git when authorization changes after the approval claim', async () => {
    const scenarios = [
      {
        code: 'forbidden',
        mutate: () => setReviewerGrantStatus('revoked'),
        restore: () => setReviewerGrantStatus('active'),
        topic: 'grant',
      },
      {
        code: 'forbidden',
        mutate: () => setShareStatus('revoked'),
        restore: () => setShareStatus('active'),
        topic: 'share',
      },
      {
        code: 'forbidden',
        mutate: () => setProjectStatus('archived'),
        restore: () => setProjectStatus('active'),
        topic: 'project',
      },
      {
        code: 'attestation_required',
        mutate: () => setReviewerAttestationRequired(true),
        restore: () => setReviewerAttestationRequired(false),
        topic: 'attestation',
      },
    ] as const;
    for (const scenario of scenarios) {
      const topic = `proposal-policy-${scenario.topic}`;
      const proposed = await repository.proposeDurable(
        proposer,
        {
          operationId: `${topic}-create`,
          project: PROJECT,
          text: `Current ${scenario.topic} policy must still authorize publication.`,
          topic,
          version: 1,
        },
        `${topic}-request`,
      );
      const before = await head();
      const enteredRemember = Promise.withResolvers<void>();
      const releaseRemember = Promise.withResolvers<void>();
      const originalRemember = repository.remember.bind(repository);
      const remember = vi.spyOn(repository, 'remember').mockImplementationOnce(async (...arguments_) => {
        enteredRemember.resolve();
        await releaseRemember.promise;
        return originalRemember(...arguments_);
      });
      const review = {
        decision: 'approve' as const,
        operationId: `${topic}-review`,
        proposalId: proposed.proposalId,
        revision: proposed.revision,
        version: 1 as const,
      };
      const approval = repository.reviewProposal(reviewer, review, `${topic}-review-request`);
      await enteredRemember.promise;
      let restored = false;
      try {
        await scenario.mutate();
        releaseRemember.resolve();
        await expect(approval).rejects.toMatchObject({code: scenario.code});
      } finally {
        releaseRemember.resolve();
        if (scenario.topic !== 'attestation') {
          await scenario.restore();
          restored = true;
        }
        remember.mockRestore();
      }
      expect(await head()).toBe(before);
      expect((await repository.readProposal(reviewer, proposed.proposalId)).status).toBe('pending');
      const recoveryAttestation =
        scenario.topic === 'attestation' ? await insertReviewerAttestation('policy-recovery') : undefined;
      try {
        const recovered = await repository.reviewProposal(
          reviewer,
          scenario.topic === 'attestation' ? {...review, operationId: `${topic}-review-takeover`} : review,
          `${topic}-review-recovered`,
          recoveryAttestation,
          scenario.topic === 'attestation' ? new Date(Date.now() + 6 * 60_000) : new Date(),
        );
        expect(recovered.status).toBe('approved');
        if (recoveryAttestation) {
          expect(recovered.result?.actor).toMatchObject({
            cloudAgentId: recoveryAttestation.cloudAgentId,
            provider: 'cursor',
          });
        }
      } finally {
        if (!restored) await scenario.restore();
      }
    }
  });

  it('serializes rejection behind the share policy mutation fence', async () => {
    const proposed = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-rejection-policy-fence-create',
        project: PROJECT,
        text: 'A rejection must observe a concurrent grant revocation.',
        topic: 'proposal-rejection-policy-fence',
        version: 1,
      },
      'request-proposal-rejection-policy-fence',
    );
    const mutationEntered = Promise.withResolvers<void>();
    const releaseMutation = Promise.withResolvers<void>();
    const mutation = fixture.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${TENANT}, true)`;
      await acquireRemoteRelationAdmissionTransactionLock(transaction, TENANT, SHARE);
      await transaction`
        UPDATE remote_memory.share_grants SET status = 'revoked'
        WHERE tenant_id = ${TENANT} AND share_id = ${SHARE} AND principal_id = ${REVIEWER}
      `;
      mutationEntered.resolve();
      await releaseMutation.promise;
    });
    await mutationEntered.promise;
    const rejection = repository.reviewProposal(
      reviewer,
      {
        decision: 'reject',
        operationId: 'review-rejection-policy-fence',
        proposalId: proposed.proposalId,
        reason: 'The reviewer grant is changing.',
        revision: proposed.revision,
        version: 1,
      },
      'request-review-rejection-policy-fence',
    );
    await waitForBlockedAdvisoryLock();
    releaseMutation.resolve();
    await mutation;
    try {
      await expect(rejection).rejects.toMatchObject({code: 'forbidden'});
    } finally {
      await setReviewerGrantStatus('active');
    }
    expect((await repository.readProposal(reviewer, proposed.proposalId)).status).toBe('pending');
  });

  it('expires unclaimed proposals and purges payloads while retaining audit identity', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const proposed = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-expiry-create',
        project: PROJECT,
        text: 'This payload is retained only through the review window.',
        topic: 'proposal-expiry',
        version: 1,
      },
      'request-proposal-expiry',
      undefined,
      now,
    );
    await new RemoteHandoffRetentionWorker(fixture.sql, {gitStore}).runPass(
      64,
      new Date(now.getTime() + 31 * 86_400_000),
    );
    expect(
      (await repository.listProposals(reviewer, {limit: 10, status: 'pending', version: 1})).entries,
    ).not.toContainEqual(expect.objectContaining({proposalId: proposed.proposalId}));
    expect(await repository.readProposal(reviewer, proposed.proposalId)).toMatchObject({
      proposalId: proposed.proposalId,
      requestHash: proposed.requestHash,
      status: 'expired',
    });
    expect(await repository.readProposal(reviewer, proposed.proposalId)).not.toHaveProperty('payload');
  });

  it('accepts the largest public text payload with PostgreSQL JSONB rendering headroom', async () => {
    const text = Effect.pipe('a', EffectString.repeat(1_000_000));
    const proposed = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-jsonb-boundary-create',
        project: PROJECT,
        text,
        topic: 'proposal-jsonb-boundary',
        version: 1,
      },
      'request-proposal-jsonb-boundary',
    );
    const rows = await fixture.sql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${TENANT}, true)`;
      return transaction<{payload_bytes: number}[]>`
        SELECT octet_length(payload::text)::integer AS payload_bytes
        FROM remote_memory.durable_memory_proposals
        WHERE tenant_id = ${TENANT} AND share_id = ${SHARE} AND id = ${proposed.proposalId}
      `;
    });
    expect(rows[0]?.payload_bytes).toBeGreaterThan(1_000_000);
    expect(rows[0]?.payload_bytes).toBeLessThanOrEqual(1_116_384);
  });

  it('classifies proposal reads and writes into asymmetric PostgreSQL rate buckets', async () => {
    const limiter = new PostgresRemoteRateLimiter(fixture.sql, {
      readRequestsPerMinute: 2,
      writeRequestsPerMinute: 1,
    });
    for (const operation of ['propose_durable_memory', 'review_memory_proposal'] as const) {
      await limiter.consume(reviewer, operation);
      await expect(limiter.consume(reviewer, operation)).rejects.toMatchObject({code: 'rate_limited'});
    }
    for (const operation of ['list_memory_proposals', 'read_memory_proposal'] as const) {
      await limiter.consume(reviewer, operation);
      await limiter.consume(reviewer, operation);
      await expect(limiter.consume(reviewer, operation)).rejects.toMatchObject({code: 'rate_limited'});
    }
  });

  it('replays a concurrent exact approval without reversing advisory and proposal row locks', async () => {
    const proposed = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-exact-concurrent-create',
        project: PROJECT,
        text: 'Concurrent exact retries converge without a deadlock.',
        topic: 'proposal-exact-concurrent',
        version: 1,
      },
      'request-proposal-exact-concurrent',
    );
    const review = {
      decision: 'approve' as const,
      operationId: 'review-exact-concurrent',
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      version: 1 as const,
    };
    const commitEntered = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    const originalCommit = gitStore.commit.bind(gitStore);
    const commit = vi.spyOn(gitStore, 'commit').mockImplementationOnce(async input => {
      commitEntered.resolve();
      await releaseCommit.promise;
      return originalCommit(input);
    });
    const first = repository.reviewProposal(reviewer, review, 'request-review-exact-concurrent-first');
    await commitEntered.promise;
    const second = repository.reviewProposal(reviewer, review, 'request-review-exact-concurrent-second');
    await waitForBlockedAdvisoryLock();
    releaseCommit.resolve();
    try {
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toMatchObject({proposalId: proposed.proposalId, status: 'approved'});
      expect(secondResult).toEqual(firstResult);
    } finally {
      commit.mockRestore();
    }
  });

  it('admits one concurrent approval and one canonical Git write', async () => {
    const proposed = await repository.proposeDurable(
      proposer,
      {
        operationId: 'proposal-concurrent-create',
        project: PROJECT,
        text: 'Concurrent reviewers produce one write.',
        topic: 'proposal-concurrent',
        version: 1,
      },
      'request-proposal-concurrent',
    );
    const beforeCount = Number(await git(['rev-list', '--count', 'HEAD'], gitFixture.worktree));
    const attempts = await Promise.allSettled(
      EffectArray.map(['a', 'b'], suffix =>
        repository.reviewProposal(
          reviewer,
          {
            decision: 'approve',
            operationId: `review-concurrent-${suffix}`,
            proposalId: proposed.proposalId,
            revision: proposed.revision,
            version: 1,
          },
          `request-review-concurrent-${suffix}`,
        ),
      ),
    );
    expect(EffectArray.filter(attempts, result => result.status === 'fulfilled')).toHaveLength(1);
    expect(EffectArray.filter(attempts, result => result.status === 'rejected')).toHaveLength(1);
    expect((await repository.readProposal(reviewer, proposed.proposalId)).status).toBe('approved');
    expect(Number(await git(['rev-list', '--count', 'HEAD'], gitFixture.worktree))).toBe(beforeCount + 1);
    expect(
      await git(
        ['show', `HEAD:${gitCanonicalSharePath('durable', PROJECT, 'proposal-concurrent')}`],
        gitFixture.worktree,
      ),
    ).toContain('Concurrent reviewers produce one write.');
  });

  async function head(): Promise<string> {
    return git(['rev-parse', 'HEAD'], gitFixture.worktree);
  }

  async function setReviewerGrantStatus(status: 'active' | 'revoked'): Promise<void> {
    await fixture.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${TENANT}, true)`;
      await transaction`
        UPDATE remote_memory.share_grants SET status = ${status}
        WHERE tenant_id = ${TENANT} AND share_id = ${SHARE} AND principal_id = ${REVIEWER}
      `;
    });
  }

  async function setShareStatus(status: 'active' | 'revoked'): Promise<void> {
    await fixture.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${TENANT}, true)`;
      await transaction`
        UPDATE remote_memory.shares SET status = ${status}
        WHERE tenant_id = ${TENANT} AND id = ${SHARE}
      `;
    });
  }

  async function setProjectStatus(status: 'active' | 'archived'): Promise<void> {
    await fixture.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${TENANT}, true)`;
      await transaction`
        UPDATE remote_memory.projects SET status = ${status}
        WHERE tenant_id = ${TENANT} AND share_id = ${SHARE} AND name = ${PROJECT}
      `;
    });
  }

  async function setReviewerAttestationRequired(required: boolean): Promise<void> {
    await fixture.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${TENANT}, true)`;
      await transaction`
        UPDATE remote_memory.share_grants SET cursor_attestation_required = ${required}
        WHERE tenant_id = ${TENANT} AND share_id = ${SHARE} AND principal_id = ${REVIEWER}
      `;
    });
  }

  async function insertReviewerAttestation(suffix: string): Promise<CursorWorkloadAttestation> {
    const attestation: CursorWorkloadAttestation = {
      attestationId: `attestation-${suffix}`,
      cloudAgentId: `cloud-agent-${suffix}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      issuer: 'https://cursor.review-gated.test',
      jti: `jti-${suffix}`,
      principalId: REVIEWER,
      repositoryUrls: ['github.com/example/threadnote-review-gated'],
      shareId: SHARE,
      subject: 'user:7002',
      tenantId: TENANT,
    };
    await fixture.migratorSql.begin(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${TENANT}, true)`;
      await transaction`
        INSERT INTO remote_memory.workload_attestations(
          tenant_id, share_id, id, principal_id, issuer, subject, jwt_id, cloud_agent_id,
          repository_urls, expires_at
        ) VALUES (
          ${TENANT}, ${SHARE}, ${attestation.attestationId}, ${REVIEWER}, ${attestation.issuer},
          ${attestation.subject}, ${attestation.jti}, ${attestation.cloudAgentId},
          ${transaction.array([...(attestation.repositoryUrls ?? [])])}, ${attestation.expiresAt}
        )
      `;
    });
    return attestation;
  }

  async function waitForBlockedAdvisoryLock(): Promise<void> {
    await waitUntil(async () => {
      const rows = await fixture.migratorSql<{blocked: boolean}[]>`
        SELECT EXISTS(
          SELECT 1 FROM pg_locks waiting
          WHERE waiting.locktype = 'advisory' AND waiting.granted = false
            AND waiting.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        ) AS blocked
      `;
      return rows[0]?.blocked === true;
    });
  }
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for PostgreSQL test state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function claims(subject: string, scopes: readonly RemoteMemoryScope[]): OAuthPrincipalClaims {
  return {issuer: ISSUER, scopes: new Set(scopes), subject};
}

function durableUri(topic: string): string {
  return formatRemoteMemoryUri({kind: 'durable', project: PROJECT, shareId: SHARE, topic});
}

function rememberInput(operationId: string, text: string, topic: string): RemoteRememberInputV1 {
  return {kind: 'durable', operationId, project: PROJECT, text, topic, version: 1};
}
