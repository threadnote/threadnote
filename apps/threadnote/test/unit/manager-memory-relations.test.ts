import {captureReviewedSupportLegacyOrigin, createReviewedSupportSnapshot} from '@threadnote/memory/reviewed-support';
import {captureConsolidationSource, consolidationRevision, reviewConsolidation} from '@threadnote/memory/consolidation';
import {topicMaintenanceReplacementError} from '@threadnote/memory/topic-maintenance';
import {automaticMaintenanceEvidenceId} from '@threadnote/memory/automatic-maintenance';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {ManagerAutomaticReview} from '@threadnote/manager/attention/topic-contracts';
import * as maintenanceRecords from '../../src/memory/maintenance/records.js';
import * as maintenanceInventory from '../../src/memory/context/maintenance_inventory.js';
import * as preparationState from '../../src/memory/context/maintenance_preparation_state.js';
import * as draftQueue from '../../src/memory/context/maintenance_draft_queue.js';
import * as draftController from '../../src/memory/context/maintenance_draft.js';
import * as candidateStore from '@threadnote/memory/candidate';
import * as memoryWriter from '../../src/mcp/server/memory.js';
import {prepareAutomaticMemory} from '../../src/memory/context/maintenance_preparation.js';
import {handleManagerAutomaticMemory} from '../../src/manager/automatic_memory.js';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Option, Path, Ref, Result, Schema} from 'effect';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import * as selectedDraft from '../../src/manager/selected_draft.js';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {readMemoryRecordsByUri} from '@threadnote/threadnote/memory/index';
import {updateManagerMemoryRelations} from '@threadnote/threadnote/manager/memory/relations';
import {
  assertManagerRawPersonalMemorySave,
  assertManagerRawSharedMemorySave,
} from '@threadnote/threadnote/manager/memory/save';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {startManagerTestServer} from '../helpers/manager-test-server.js';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {join} from '@threadnote/testing/node-path';

const personalUri = 'threadnote://user/test/memories/durable/projects/threadnote/source.md';
const sharedUri = 'threadnote://user/test/memories/shared/default/durable/projects/threadnote/source.md';
const base = [
  'MEMORY',
  'kind: durable',
  'status: active',
  'project: threadnote',
  'topic: source',
  'memory_id: tn_manager_source',
  'relation: depends_on threadnote://memory/tn_manager_target',
  '',
  'Original body.',
].join('\n');

describe('Manager raw memory relation boundary', () => {
  it('allows body edits while preserving exact relation headers', () => {
    const updated = base.replace('Original body.', 'Updated body.');

    expect(() => assertManagerRawPersonalMemorySave(personalUri, base, base, updated)).not.toThrow();
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, base, base, updated)).not.toThrow();
  });

  it('allows a browser-normalized LF body edit of an existing CRLF memory', () => {
    const existing = base.replaceAll('\n', '\r\n');
    const updated = base.replace('Original body.', 'Updated body.');

    expect(() => assertManagerRawPersonalMemorySave(personalUri, existing, existing, updated)).not.toThrow();
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, existing, existing, updated)).not.toThrow();
  });

  it.each([
    ['add', base.replace('\n\nOriginal', '\nrelation: related_to threadnote://memory/tn_other\n\nOriginal')],
    ['change', base.replace('depends_on', 'related_to')],
    ['remove', base.replace('relation: depends_on threadnote://memory/tn_manager_target\n', '')],
  ])('rejects a raw %s relation edit until structured Manager authoring exists', (_operation, updated) => {
    expect(() => assertManagerRawPersonalMemorySave(personalUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change typed memory relations',
    );
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change typed memory relations',
    );
  });

  it('rejects changing the source identity into a preserved self relation', () => {
    const updated = base.replace('memory_id: tn_manager_source', 'memory_id: tn_manager_target');

    expect(() => assertManagerRawPersonalMemorySave(personalUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change stable memory_id',
    );
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, base, base, updated)).toThrow(
      'Raw Manager saves cannot change stable memory_id',
    );
  });

  effectIt.effect('adds, replaces, and removes relations through identity-safe CAS while preserving the memory', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const targetContent = memoryContent('tn_manager_target', 'target', 'Target body.');
      const supersededContent = memoryContent('tn_manager_older', 'older', 'Older body.');
      const sourceContent = memoryContent('tn_manager_source', 'source', 'Original source body.', {
        keywords: ['preserve-me'],
        supersedes: memoryIdentityAlias('tn_manager_older'),
      });
      yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.olderUri, supersededContent, {mode: 'create'});

      const added = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'depends_on', uri: fixture.targetUri}],
        uri: fixture.sourceUri,
      });
      expect(added.relations).toEqual([{type: 'depends_on', uri: memoryIdentityAlias('tn_manager_target')}]);
      const [stored] = yield* readMemoryRecordsByUri(fixture.config, [fixture.sourceUri]);
      expect(stored?.body).toBe('Original source body.');
      expect(stored?.metadata.keywords).toEqual(['preserve-me']);
      expect(stored?.metadata.supersedes).toBe(memoryIdentityAlias('tn_manager_older'));

      const changed = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: added.content,
        relations: [{type: 'evidence_for', uri: memoryIdentityAlias('tn_manager_target')}],
        uri: fixture.sourceUri,
      });
      expect(changed.relations).toEqual([{type: 'evidence_for', uri: memoryIdentityAlias('tn_manager_target')}]);
      const removed = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: changed.content,
        relations: [],
        uri: fixture.sourceUri,
      });
      expect(removed.relations).toEqual([]);
      expect(parseMemoryDocument(fixture.sourceUri, removed.content)?.metadata.relations).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects stale, self, duplicate, and out-of-scope structured relation writes', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const sourceContent = memoryContent('tn_manager_source', 'source', 'Source.');
      const targetContent = memoryContent('tn_manager_target', 'target', 'Target.');
      yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});

      const stale = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: `${sourceContent}\nchanged`,
        relations: [],
        uri: fixture.sourceUri,
      }).pipe(Effect.flip);
      const self = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'related_to', uri: fixture.sourceUri}],
        uri: fixture.sourceUri,
      }).pipe(Effect.exit);
      const duplicate = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [
          {type: 'related_to', uri: fixture.targetUri},
          {type: 'related_to', uri: fixture.targetUri},
        ],
        uri: fixture.sourceUri,
      }).pipe(Effect.exit);
      const foreign = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [],
        uri: 'threadnote://user/other/memories/durable/projects/threadnote/source.md',
      }).pipe(Effect.flip);
      expect(stale).toMatchObject({code: 'memory-relations-conflict', status: 409});
      expect(String(stale)).toContain('changed after it was opened');
      expect(String(self)).toContain('cannot relate to itself');
      expect(String(duplicate)).toContain('Duplicate memory relations');
      expect(foreign).toMatchObject({code: 'memory-relations-forbidden', status: 403});
      expect(String(foreign)).toContain('current user memory corpus');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('returns structured HTTP statuses for stale and invalid relation editor requests', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-relations-http-'));
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'test',
    } as const;
    const sourceContent = memoryContent('tn_manager_source', 'source', 'Source.');
    const sourcePath = join(home, 'data', 'local', 'user', 'test', 'memories', 'durable', 'projects', 'threadnote');
    await mkdir(sourcePath, {recursive: true});
    await writeFile(join(sourcePath, 'source.md'), sourceContent);
    const server = await startManagerTestServer(config, 'relations-secret');
    try {
      const response = await fetch(`${server.url}/api/memory/relations`, {
        body: JSON.stringify({expectedContent: `${sourceContent}\nstale`, relations: [], uri: personalUri}),
        headers: {authorization: 'Bearer relations-secret', 'content-type': 'application/json'},
        method: 'POST',
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: 'memory-relations-conflict',
        error: 'The memory changed after it was opened. Reload and retry.',
        retryAfterMilliseconds: 0,
      });

      const malformedSource = await fetch(`${server.url}/api/memory/relations`, {
        body: JSON.stringify({expectedContent: sourceContent, relations: [], uri: 'not-a-threadnote-uri'}),
        headers: {authorization: 'Bearer relations-secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(malformedSource.status).toBe(400);
      expect(await malformedSource.json()).toMatchObject({code: 'memory-relations-invalid'});

      const invalidRelation = await fetch(`${server.url}/api/memory/relations`, {
        body: JSON.stringify({
          expectedContent: sourceContent,
          relations: [{type: 'invented_relation', uri: personalUri}],
          uri: personalUri,
        }),
        headers: {authorization: 'Bearer relations-secret', 'content-type': 'application/json'},
        method: 'POST',
      });
      expect(invalidRelation.status).toBe(400);
      expect(await invalidRelation.json()).toMatchObject({code: 'memory-relations-invalid'});
    } finally {
      await server.close();
      await rm(home, {force: true, recursive: true});
    }
  });

  effectIt.effect('keeps operational relation failures private and distinct from conflicts', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const sourceContent = memoryContent('tn_manager_source', 'source', 'Source.');
      const targetContent = memoryContent('tn_manager_target', 'target', 'Target.');
      yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});
      const failingStore = ResourceStore.of({
        ...fixture.store,
        writeChecked: (_location, uri) =>
          Effect.fail(
            ResourceIoFailed.make({
              cause: new Error('/private/storage/detail'),
              message: '/private/storage/detail',
              operation: 'write',
              uri,
            }),
          ),
      });

      const failure = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'related_to', uri: fixture.targetUri}],
        uri: fixture.sourceUri,
      }).pipe(Effect.provideService(ResourceStore, failingStore), Effect.flip);

      expect(failure).toMatchObject({code: 'memory-relations-operation-failed', status: 500});
      expect(failure.message).toBe('Threadnote could not update the memory relations. Reload and retry.');
      expect(failure.message).not.toContain('/private/storage/detail');

      const readFailingStore = ResourceStore.of({
        ...fixture.store,
        read: (location, uri) =>
          uri === fixture.targetUri
            ? Effect.fail(
                ResourceIoFailed.make({
                  cause: new Error('/private/target/detail'),
                  message: '/private/target/detail',
                  operation: 'read',
                  uri,
                }),
              )
            : fixture.store.read(location, uri),
      });
      const resolutionFailure = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'related_to', uri: fixture.targetUri}],
        uri: fixture.sourceUri,
      }).pipe(Effect.provideService(ResourceStore, readFailingStore), Effect.flip);
      expect(resolutionFailure).toMatchObject({code: 'memory-relations-operation-failed', status: 500});
      expect(resolutionFailure.message).not.toContain('/private/target/detail');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps shared relation targets inside the source team for URIs and stable aliases', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const sharedRoot = 'threadnote://user/test/memories/shared';
      const sourceUri = `${sharedRoot}/alpha/durable/projects/threadnote/source.md`;
      const personalTargetUri = 'threadnote://user/test/memories/durable/projects/threadnote/personal-target.md';
      const otherTeamTargetUri = `${sharedRoot}/beta/durable/projects/threadnote/shared-target.md`;
      const sourceContent = memoryContent('tn_manager_shared_source', 'source', 'Shared source.', {
        visibility: 'shared',
      });
      const personalTargetContent = memoryContent('tn_manager_personal_target', 'personal-target', 'Personal target.');
      const otherTeamTargetContent = memoryContent(
        'tn_manager_other_team_target',
        'shared-target',
        'Other team target.',
        {visibility: 'shared'},
      );
      yield* fixture.store.write(fixture.location, sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, personalTargetUri, personalTargetContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, otherTeamTargetUri, otherTeamTargetContent, {mode: 'create'});

      const rejectedTargets = [
        {message: 'authorized memory scope', uri: personalTargetUri},
        {message: 'authorized memory scope', uri: otherTeamTargetUri},
        {message: 'authorized active corpus', uri: memoryIdentityAlias('tn_manager_personal_target')},
        {message: 'authorized active corpus', uri: memoryIdentityAlias('tn_manager_other_team_target')},
      ];
      for (const target of rejectedTargets) {
        const result = yield* updateManagerMemoryRelations(fixture.config, {
          expectedContent: sourceContent,
          relations: [{type: 'related_to', uri: target.uri}],
          uri: sourceUri,
        }).pipe(Effect.exit);
        expect(String(result)).toContain(target.message);
      }
      const [stored] = yield* readMemoryRecordsByUri(fixture.config, [sourceUri]);
      expect(stored?.content).toBe(sourceContent);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('returns a conflict when a relation target changes immediately before the locked write', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const sourceContent = memoryContent('tn_manager_source', 'source', 'Source.');
      const targetContent = memoryContent('tn_manager_target', 'target', 'Target.');
      const changedTargetContent = memoryContent('tn_manager_target', 'target', 'Changed target.');
      yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
      yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});
      const racingStore = ResourceStore.of({
        ...fixture.store,
        writeChecked: (location, uri, content, options, check) =>
          fixture.store
            .write(fixture.location, fixture.targetUri, changedTargetContent, {mode: 'replace'})
            .pipe(Effect.andThen(fixture.store.writeChecked(location, uri, content, options, check))),
      });

      const conflict = yield* updateManagerMemoryRelations(fixture.config, {
        expectedContent: sourceContent,
        relations: [{type: 'related_to', uri: fixture.targetUri}],
        uri: fixture.sourceUri,
      }).pipe(Effect.provideService(ResourceStore, racingStore), Effect.flip);

      expect(conflict).toMatchObject({code: 'memory-relations-conflict', status: 409});
      expect(conflict.message).toContain('target changed during the write');
      const [storedSource, storedTarget] = yield* readMemoryRecordsByUri(fixture.config, [
        fixture.sourceUri,
        fixture.targetUri,
      ]);
      expect(storedSource?.content).toBe(sourceContent);
      expect(storedTarget?.content).toBe(changedTargetContent);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'rejects an update when the source changes after Manager validation but before writer preparation',
    () =>
      Effect.gen(function* () {
        const fixture = yield* relationFixture();
        const sourceContent = memoryContent('tn_manager_source', 'source', 'Original source body.');
        const targetContent = memoryContent('tn_manager_target', 'target', 'Target body.');
        const concurrentContent = memoryContent('tn_manager_source', 'source', 'Concurrent source body.', {
          keywords: ['concurrent-edit'],
        });
        yield* fixture.store.write(fixture.location, fixture.sourceUri, sourceContent, {mode: 'create'});
        yield* fixture.store.write(fixture.location, fixture.targetUri, targetContent, {mode: 'create'});

        const targetRead = yield* Deferred.make<void>();
        const resumeResolution = yield* Deferred.make<void>();
        const targetReadCount = yield* Ref.make(0);
        const interceptedStore = ResourceStore.of({
          ...fixture.store,
          read: (location, uri) =>
            fixture.store
              .read(location, uri)
              .pipe(
                Effect.tap(() =>
                  uri === fixture.targetUri
                    ? Ref.getAndUpdate(targetReadCount, count => count + 1).pipe(
                        Effect.flatMap(count =>
                          count === 0
                            ? Deferred.succeed(targetRead, undefined).pipe(
                                Effect.andThen(Deferred.await(resumeResolution)),
                              )
                            : Effect.void,
                        ),
                      )
                    : Effect.void,
                ),
              ),
        });
        const update = yield* updateManagerMemoryRelations(fixture.config, {
          expectedContent: sourceContent,
          relations: [{type: 'depends_on', uri: fixture.targetUri}],
          uri: fixture.sourceUri,
        }).pipe(Effect.provideService(ResourceStore, interceptedStore), Effect.forkScoped);

        yield* Deferred.await(targetRead);
        yield* fixture.store.write(fixture.location, fixture.sourceUri, concurrentContent, {mode: 'replace'});
        yield* Deferred.succeed(resumeResolution, undefined);
        const result = yield* Fiber.join(update).pipe(Effect.exit);

        expect(String(result)).toContain('changed while its replacement was being prepared');
        const [stored] = yield* readMemoryRecordsByUri(fixture.config, [fixture.sourceUri]);
        expect(stored?.content).toBe(concurrentContent);
        expect(stored?.metadata.relations).toBeUndefined();
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function config() {
  return {
    account: 'local',
    agentContextHome: '/tmp/threadnote-manager-memory-relations',
    agentId: 'threadnote',
    manifestPath: '/tmp/threadnote-manager-memory-relations/manifest.json',
    user: 'test',
  } as const;
}

const relationFixture = Effect.fn('test.managerRelationFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-relations-'});
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'manifest.yaml'),
    user: 'test',
  } as const;
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const store = yield* ResourceStore;
  const root = 'threadnote://user/test/memories/durable/projects/threadnote';
  return {
    config,
    location: {account: config.account, home, user: config.user},
    olderUri: `${root}/older.md`,
    sourceUri: `${root}/source.md`,
    store,
    targetUri: `${root}/target.md`,
  } as const;
});

function memoryContent(memoryId: string, topic: string, body: string, overrides: Partial<MemoryMetadata> = {}): string {
  return formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      memoryId,
      project: 'threadnote',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-08-31T00:00:00.000Z',
      topic,
      visibility: 'personal',
      ...overrides,
    },
    body,
  );
}

describe('Manager raw approved-support boundary', () => {
  it('refuses body edits and header removal with an actionable manual preview route', () => {
    const body = 'Reviewed ordinary body.';
    const active = createReviewedSupportSnapshot({
      bodyHash: consolidationRevision(body),
      paragraphs: [
        {ordinal: 0, hash: consolidationRevision(body), role: 'unknown', support: 'unresolved', evidenceIds: []},
      ],
      sources: [],
      acceptance: {
        reviewId: 'review-manager-support',
        approvedAt: '2026-10-21T00:00:00.000Z',
        targetBeforeHash: '1'.repeat(64),
        preparationDigest: '2'.repeat(64),
        sourceVectorDigest: '3'.repeat(64),
      },
    });
    const content = formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        project: 'threadnote',
        topic: 'source',
        memoryId: 'tn_manager_source',
        schemaVersion: 11,
        sourceAgentClient: 'test',
        timestamp: '2026-10-21T00:00:00.000Z',
        reviewedSupport: {type: 'reviewed-memory-support', version: 1, active},
      },
      body,
    );
    expect(() => assertManagerRawPersonalMemorySave(personalUri, content, content, content)).not.toThrow();
    for (const next of [content.replace(body, 'Edited prose.'), content.replace(/^reviewed_support: .*\n/mu, '')]) {
      expect(() => assertManagerRawPersonalMemorySave(personalUri, content, content, next)).toThrow(
        /context_maintenance_review/u,
      );
      expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, content, content, next)).toThrow(
        /context_maintenance_review/u,
      );
    }
  });
});

function reviewedCodeMemory() {
  const citation = (revision: 'a' | 'b') =>
    createMemoryCodeCitation({
      version: 1,
      repositoryId: 'c'.repeat(64),
      repositoryIdentityKind: 'remote',
      sourceSnapshotId: `cgsn_${revision.repeat(40)}`,
      sourceCommit: revision.repeat(40),
      sourceDirty: false,
      path: 'src/limit.ts',
      target: {kind: 'file'},
      fileContentHash: {algorithm: 'sha256', value: revision.repeat(64)},
      extractorSet: 'test',
    });
  const root = citation('a');
  const current = citation('b');
  const body = 'Current limit is 60.';
  const source = {kind: 'code' as const, citation: current};
  const id = automaticMaintenanceEvidenceId(source);
  const active = createReviewedSupportSnapshot({
    bodyHash: consolidationRevision(body),
    paragraphs: [
      {ordinal: 0, hash: consolidationRevision(body), role: 'descriptive', support: 'direct', evidenceIds: [id]},
    ],
    sources: [{id, source, scope: 'repository'}],
    acceptance: {
      reviewId: 'review-manager-current-code',
      approvedAt: '2026-10-21T00:00:00.000Z',
      targetBeforeHash: '1'.repeat(64),
      preparationDigest: '2'.repeat(64),
      sourceVectorDigest: '3'.repeat(64),
    },
  });
  const content = memoryContent('tn_manager_source', 'source', body, {
    schemaVersion: 11,
    codeCitations: [root],
    reviewedSupport: {type: 'reviewed-memory-support', version: 1, active, initialApproval: active},
  });
  return {content, root, current};
}

async function managerProvenanceFixture(shared = false) {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-provenance-'));
  const runtime = {...config(), agentContextHome: home, manifestPath: join(home, 'manifest.yaml')};
  await writeFile(runtime.manifestPath, 'version: 1\nprojects: []\n');
  const relative = join('durable', 'projects', 'threadnote', 'source.md');
  const memoryRoot = join(home, 'data', 'local', 'user', 'test', 'memories');
  const canonicalPath = join(memoryRoot, ...(shared ? ['shared', 'default'] : []), relative);
  const {content} = reviewedCodeMemory();
  await mkdir(join(canonicalPath, '..'), {recursive: true});
  await writeFile(canonicalPath, content);
  let worktreePath: string | undefined;
  if (shared) {
    const worktree = join(home, 'share', 'worktrees', 'default');
    const remote = join(home, 'share', 'remote.git');
    worktreePath = join(worktree, relative);
    await mkdir(join(worktreePath, '..'), {recursive: true});
    await writeFile(worktreePath, content);
    const git = (args: readonly string[]) => execFileSync('git', [...args], {stdio: 'pipe'});
    git(['init', '--bare', '-q', remote]);
    git(['init', '-q', worktree]);
    git(['-C', worktree, 'config', 'user.name', 'Threadnote Test']);
    git(['-C', worktree, 'config', 'user.email', 'test@threadnote.local']);
    git(['-C', worktree, 'add', '--', relative]);
    git(['-C', worktree, 'commit', '-qm', 'shared provenance fixture']);
    git(['-C', worktree, 'remote', 'add', 'origin', remote]);
    git(['-C', worktree, 'push', '-qu', 'origin', 'HEAD']);
    await writeFile(
      join(home, 'share', 'teams.json'),
      JSON.stringify({
        version: 1,
        defaultTeam: 'default',
        teams: {
          default: {
            name: 'default',
            worktree,
            gitdir: join(worktree, '.git'),
            remote,
            addedAt: '2026-10-21T00:00:00.000Z',
          },
        },
      }),
    );
  }
  return {home, runtime, canonicalPath, worktreePath, content, uri: shared ? sharedUri : personalUri};
}

describe('Manager retained reviewed provenance', () => {
  effectIt.effect('pages the global inventory without scanning unrelated canonical memories or review sources', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join(
        fixture.config.agentContextHome,
        'data',
        'local',
        'user',
        'test',
        'memories',
        'durable',
        'projects',
      );
      yield* fs.makeDirectory(path.join(root, 'threadnote'), {recursive: true});
      yield* fs.makeDirectory(path.join(root, 'unrelated'), {recursive: true});
      const uris = Array.from({length: 140}, (_, index) =>
        personalUri.replace('source.md', `page-${String(index).padStart(3, '0')}.md`),
      );
      for (const [index, uri] of uris.entries())
        yield* fs.writeFileString(
          path.join(root, 'threadnote', uri.split('/').at(-1)!),
          memoryContent(`tn_manager_page_${index}`, `page-${index}`, `Memory ${index}.`),
        );
      yield* fs.writeFileString(
        path.join(root, 'unrelated', 'private.md'),
        memoryContent('tn_other_project', 'private', 'Unrelated private prose.').replace(
          'project: threadnote',
          'project: unrelated',
        ),
      );
      // The actual ordinary-use worker may have built only the all-project inventory.
      expect(
        (yield* maintenanceInventory.prepareContextMaintenanceInventory(fixture.config, undefined, 10_000)).complete,
      ).toBe(true);
      const opens: string[] = [];
      const tracked = {
        ...fs,
        open: (file: string, options?: Parameters<typeof fs.open>[1]) =>
          Effect.sync(() => {
            opens.push(file);
          }).pipe(Effect.andThen(fs.open(file, options))),
      };
      const allReviews = vi.spyOn(candidateStore, 'listCandidateReviews');
      const corpus = vi.spyOn(maintenanceRecords, 'readMaintenanceMemoryRecords');
      const sources = vi.spyOn(draftController, 'readTopicMaintenanceDraft');
      yield* Effect.gen(function* () {
        const observed: string[] = [];
        let afterUri: string | undefined;
        do {
          opens.length = 0;
          const response = yield* handleManagerAutomaticMemory({
            config: fixture.config,
            method: 'GET',
            url: new URL(
              `http://localhost/api/attention/automatic-memory?project=threadnote${afterUri ? `&afterUri=${encodeURIComponent(afterUri)}` : ''}`,
            ),
            body: Effect.succeed({}),
          }).pipe(Effect.provideService(FileSystem.FileSystem, tracked));
          expect(response?.status).toBe(200);
          const body = response!.body as {items: {uri: string}[]; nextCursor?: string; incomplete: boolean};
          expect(body.incomplete).toBe(false);
          expect(body.items.length).toBeLessThanOrEqual(32);
          expect(opens.filter(file => file.startsWith(root))).toHaveLength(body.items.length);
          expect(opens.some(file => file.includes('/unrelated/'))).toBe(false);
          observed.push(...body.items.map(item => item.uri));
          afterUri = body.nextCursor;
        } while (afterUri);
        expect(observed).toEqual(uris);
        expect(new Set(observed).size).toBe(140);
        opens.length = 0;
        const detail = yield* handleManagerAutomaticMemory({
          config: fixture.config,
          method: 'GET',
          url: new URL(
            `http://localhost/api/attention/automatic-memory?project=threadnote&uri=${encodeURIComponent(uris.at(-1)!)}`,
          ),
          body: Effect.succeed({}),
        }).pipe(Effect.provideService(FileSystem.FileSystem, tracked));
        expect(detail).toMatchObject({status: 200, body: {items: [{uri: uris.at(-1)}]}});
        expect(opens.filter(file => file.startsWith(root))).toEqual([path.join(root, 'threadnote', 'page-139.md')]);
        expect(opens.some(file => file.includes('/inventory/'))).toBe(false);
        expect(allReviews).not.toHaveBeenCalled();
        expect(corpus).not.toHaveBeenCalled();
        expect(sources).not.toHaveBeenCalled();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            allReviews.mockRestore();
            corpus.mockRestore();
            sources.mockRestore();
          }),
        ),
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps exact canonical handle reads within the caller byte budget', () =>
    Effect.gen(function* () {
      const fixture = yield* relationFixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const content = memoryContent('tn_budget_bound', 'source', 'A bounded memory.');
      const file = path.join(
        fixture.config.agentContextHome,
        'data',
        'local',
        'user',
        'test',
        'memories',
        'durable',
        'projects',
        'threadnote',
        'source.md',
      );
      yield* fs.makeDirectory(path.dirname(file), {recursive: true});
      yield* fs.writeFileString(file, content);
      let readBytes = 0;
      const tracked = {
        ...fs,
        open: (name: string, options?: Parameters<typeof fs.open>[1]) =>
          fs.open(name, options).pipe(
            Effect.map(
              handle =>
                new Proxy(handle, {
                  get(target, key) {
                    return key === 'readAlloc'
                      ? (size: number) =>
                          target.readAlloc(size).pipe(
                            Effect.tap(chunk =>
                              Effect.sync(() => {
                                if (Option.isSome(chunk)) readBytes += chunk.value.length;
                              }),
                            ),
                          )
                      : Reflect.get(target, key, target);
                  },
                }),
            ),
          ),
      };
      const size = new TextEncoder().encode(content).byteLength;
      expect(
        Result.isFailure(
          yield* maintenanceInventory
            .readContextMaintenanceCanonicalRecord(fixture.config, personalUri, {maxBytes: size - 1})
            .pipe(Effect.provideService(FileSystem.FileSystem, tracked), Effect.result),
        ),
      ).toBe(true);
      expect(readBytes).toBe(0);
      const record = yield* maintenanceInventory
        .readContextMaintenanceCanonicalRecord(fixture.config, personalUri, {maxBytes: size})
        .pipe(Effect.provideService(FileSystem.FileSystem, tracked));
      expect(record.bytes).toBe(size);
      expect(readBytes).toBe(size);
      expect(record.record.content).toBe(content);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'partitions inventory hints deterministically across page sizes without dropping or duplicating targets',
    {
      count: Schema.Int.check(Schema.isBetween({minimum: 2, maximum: 45})),
      limit: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 128})),
      reverse: Schema.Boolean,
    },
    ({count, limit, reverse}) =>
      Effect.gen(function* () {
        const fixture = yield* relationFixture();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(
          fixture.config.agentContextHome,
          'data',
          'local',
          'user',
          'test',
          'memories',
          'durable',
          'projects',
          'threadnote',
        );
        yield* fs.makeDirectory(root, {recursive: true});
        const uris = Array.from({length: count}, (_, index) =>
          personalUri.replace('source.md', `property-${String(index).padStart(3, '0')}.md`),
        );
        for (const uri of reverse ? [...uris].reverse() : uris)
          yield* fs.writeFileString(
            path.join(root, uri.split('/').at(-1)!),
            memoryContent('tn_property', 'property', 'Property memory.'),
          );
        yield* maintenanceInventory.prepareContextMaintenanceInventory(fixture.config, undefined, 10_000);
        const cacheFile = path.join(
          fixture.config.agentContextHome,
          'context-maintenance',
          'inventory',
          `${sha256HexSync('*')}.json`,
        );
        const before = yield* fs.readFileString(cacheFile);
        const observed: string[] = [];
        let afterUri: string | undefined;
        do {
          const first = yield* maintenanceInventory.readContextMaintenanceInventoryPage(fixture.config, 'threadnote', {
            afterUri,
            limit,
          });
          expect(
            yield* maintenanceInventory.readContextMaintenanceInventoryPage(fixture.config, 'threadnote', {
              afterUri,
              limit,
            }),
          ).toEqual(first);
          expect(first.uris.length).toBeLessThanOrEqual(limit);
          observed.push(...first.uris);
          afterUri = first.nextCursor;
        } while (afterUri);
        expect(observed).toEqual(uris);
        expect(new Set(observed).size).toBe(count);
        expect(yield* fs.readFileString(cacheFile)).toBe(before);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {timeout: 30_000, arbitrary: {runs: 12, seed: 75605}},
  );
  effectIt.effect(
    'projects existing preparation and finite queue waits for unenrolled memories without dispatching generation',
    () =>
      Effect.gen(function* () {
        const record = parseMemoryDocument(
          personalUri,
          memoryContent('tn_manager_source', 'source', 'Unenrolled body.'),
        )!;
        const prepared = prepareAutomaticMemory(record, {scopeRevision: 'a'.repeat(64)});
        const hash = 'b'.repeat(64);
        const background: Effect.Success<ReturnType<typeof draftController.readAutomaticDraftBackgroundStatus>> = {
          version: 1,
          allMaintenancePaused: false,
          policy: {paused: false, provider: 'local-ai'},
          policyRevision: hash,
          provider: {state: 'ready', backend: 'local-ai', modelId: 'fixture', providerIdentity: hash},
          queued: [],
          background: {limitPerHour: 4, reserved: 0, reservations: []},
          controls: [],
        };
        let cachedPreparation: preparationState.PreparedMemoryV1 | undefined = prepared;
        let checkpoint: draftQueue.DraftQueueTarget | undefined;
        const reads = vi.spyOn(maintenanceInventory, 'readContextMaintenanceCanonicalRecord').mockReturnValue(
          Effect.succeed({
            record,
            hash: sha256HexSync(record.content),
            bytes: new TextEncoder().encode(record.content).byteLength,
          }),
        );
        const corpus = vi.spyOn(maintenanceRecords, 'readMaintenanceMemoryRecords').mockReturnValue(Effect.succeed([]));
        const preparation = vi
          .spyOn(preparationState, 'readPreparedMemory')
          .mockImplementation(() => Effect.sync(() => cachedPreparation));
        const checkpoints = vi
          .spyOn(draftQueue, 'readDraftQueueTarget')
          .mockImplementation(() => Effect.sync(() => checkpoint));
        const provider = vi
          .spyOn(draftController, 'readAutomaticDraftBackgroundStatus')
          .mockReturnValue(Effect.succeed(background));
        const reviews = vi
          .spyOn(candidateStore, 'loadCandidateReviewOptional')
          .mockReturnValue(Effect.succeed(Option.getOrUndefined(Option.none<candidateStore.CandidateReview>())));
        const allReviews = vi.spyOn(candidateStore, 'listCandidateReviews').mockReturnValue(Effect.succeed([]));
        const generate = vi.spyOn(draftController, 'requestAutomaticMemoryDraft');
        yield* Effect.gen(function* () {
          const request = {
            config: config(),
            method: 'GET',
            url: new URL(
              `http://localhost/api/attention/automatic-memory?project=threadnote&uri=${encodeURIComponent(personalUri)}`,
            ),
            body: Effect.succeed({}),
          };
          const cases: readonly [string, Partial<typeof background>, draftQueue.DraftQueueTarget | undefined][] = [
            ['unknown', {}, undefined],
            [
              'queued',
              {
                queued: [
                  {
                    targetUri: personalUri,
                    identity: hash,
                    materialRevision: prepared.relevantRevision,
                    foreground: false,
                  },
                ],
              },
              undefined,
            ],
            [
              'generating',
              {active: {targetUri: personalUri, identity: hash, foreground: false, leaseUntil: 300_000}},
              undefined,
            ],
            [
              'waiting-model',
              {provider: {state: 'waiting', backend: 'local-ai', reason: 'selected-provider-unavailable'}},
              undefined,
            ],
            [
              'waiting-budget',
              {
                queued: [
                  {
                    targetUri: personalUri,
                    identity: hash,
                    materialRevision: prepared.relevantRevision,
                    foreground: false,
                    waitingReason: 'hourly-budget',
                  },
                ],
                nextEligibleAt: 300_000,
              },
              undefined,
            ],
            ['paused', {allMaintenancePaused: true}, undefined],
            ['policy', {waitingReason: 'remote-provider-grant-required'}, undefined],
            [
              'retry',
              {},
              {
                targetKey: hash,
                targetUri: personalUri,
                materialRevision: prepared.relevantRevision,
                state: 'waiting',
                nextEligibleAt: 300_000,
                retryCount: 1,
                reason: 'transient',
              },
            ],
            [
              'failed',
              {},
              {
                targetKey: hash,
                targetUri: personalUri,
                materialRevision: prepared.relevantRevision,
                state: 'failed',
                reason: 'invalid-output',
              },
            ],
          ];
          for (const [state, changes, currentCheckpoint] of cases) {
            provider.mockReturnValue(Effect.succeed({...background, ...changes}));
            checkpoint = currentCheckpoint;
            const response = yield* handleManagerAutomaticMemory(request);
            expect(response).toMatchObject({
              status: 200,
              body: {project: 'threadnote', items: [{uri: personalUri, state}]},
            });
            if (state === 'retry')
              expect(response).toMatchObject({body: {items: [{nextEligibleAt: 300_000, retryCount: 1}]}});
          }
          cachedPreparation = undefined;
          provider.mockReturnValue(Effect.succeed(background));
          checkpoint = undefined;
          expect(yield* handleManagerAutomaticMemory(request)).toMatchObject({
            body: {items: [{state: 'preparing', coverage: {outcome: 'unknown'}, paragraphs: []}]},
          });
          const uris = Array.from({length: 6}, (_, index) => personalUri.replace('source.md', `bounded-${index}.md`));
          const page = vi
            .spyOn(maintenanceInventory, 'readContextMaintenanceInventoryPage')
            .mockReturnValue(Effect.succeed({uris, total: 6, omitted: 0, incomplete: false}));
          yield* Effect.gen(function* () {
            reads.mockClear();
            reads.mockImplementation((_config, uri) =>
              Effect.succeed({record: {...record, uri}, hash: sha256HexSync(record.content), bytes: 8 * 1024 * 1024}),
            );
            const bounded = yield* handleManagerAutomaticMemory({
              ...request,
              url: new URL('http://localhost/api/attention/automatic-memory?project=threadnote'),
            });
            expect(reads).toHaveBeenCalledTimes(4);
            expect(reads.mock.calls.map(call => call[2]?.maxBytes)).toEqual(Array(4).fill(8 * 1024 * 1024));
            expect(bounded).toMatchObject({status: 200, body: {omitted: 2, incomplete: true, nextCursor: uris[3]}});
            expect((bounded!.body as {items: unknown[]}).items).toHaveLength(4);
          }).pipe(Effect.ensuring(Effect.sync(() => page.mockRestore())));
          expect(generate).not.toHaveBeenCalled();
          expect(corpus).not.toHaveBeenCalled();
          expect(allReviews).not.toHaveBeenCalled();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              reads.mockRestore();
              corpus.mockRestore();
              preparation.mockRestore();
              checkpoints.mockRestore();
              provider.mockRestore();
              reviews.mockRestore();
              allReviews.mockRestore();
              generate.mockRestore();
            }),
          ),
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
  it.each(['normal', 'finish-verification', 'retry-prewrite', 'reject-stale-source'])(
    'routes an approved-support body edit through exact manual preview and %s',
    async mode => {
      const home = await mkdtemp(join(tmpdir(), 'threadnote-manager-manual-review-'));
      const runtime = {...config(), agentContextHome: home, manifestPath: join(home, 'manifest.yaml')};
      await writeFile(runtime.manifestPath, 'version: 1\nprojects: []\n');
      const directory = join(home, 'data', 'local', 'user', 'test', 'memories', 'durable', 'projects', 'threadnote');
      await mkdir(directory, {recursive: true});
      const sourceUri = personalUri.replace('source.md', 'support.md');
      const sourceContent = memoryContent('tn_manager_support', 'support', 'Old info.\n\nKeep info.');
      await writeFile(join(directory, 'support.md'), sourceContent);
      const source = {
        kind: 'memory' as const,
        uri: sourceUri,
        memoryId: 'tn_manager_support',
        canonicalHash: sha256HexSync(sourceContent),
        fragment: {
          ordinal: 1,
          hash: sha256HexSync('Keep info.'),
          startOffset: 'Old info.\n\n'.length,
          endOffset: 'Old info.\n\nKeep info.'.length,
        },
      };
      const evidenceId = automaticMaintenanceEvidenceId(source);
      const oldSource = {
        ...source,
        fragment: {ordinal: 0, hash: sha256HexSync('Old info.'), startOffset: 0, endOffset: 'Old info.'.length},
      };
      const oldEvidenceId = automaticMaintenanceEvidenceId(oldSource);
      const body = 'Old info.\n\nKeep info.';
      const active = createReviewedSupportSnapshot({
        bodyHash: sha256HexSync(body),
        paragraphs: [
          {
            ordinal: 0,
            hash: sha256HexSync('Old info.'),
            role: 'descriptive',
            support: 'direct',
            evidenceIds: [oldEvidenceId],
          },
          {
            ordinal: 1,
            hash: sha256HexSync('Keep info.'),
            role: 'descriptive',
            support: 'direct',
            evidenceIds: [evidenceId],
          },
        ],
        sources: [
          {id: oldEvidenceId, source: oldSource, scope: 'personal'},
          {id: evidenceId, source, scope: 'personal'},
        ],
        acceptance: {
          reviewId: 'review-manager-initial',
          approvedAt: '2026-10-21T00:00:00.000Z',
          targetBeforeHash: '1'.repeat(64),
          preparationDigest: '2'.repeat(64),
          sourceVectorDigest: '3'.repeat(64),
        },
      });
      const content = memoryContent('tn_manager_source', 'source', body, {
        schemaVersion: 11,
        reviewedSupport: {type: 'reviewed-memory-support', version: 1, active, initialApproval: active},
      });
      const storedContent = `${content}\n`;
      await writeFile(join(directory, 'source.md'), storedContent);
      const desired = storedContent.replace('Old info.', 'Edited info.');
      const server = await startManagerTestServer(runtime, 'manual-secret');
      const headers = {authorization: 'Bearer manual-secret', 'content-type': 'application/json'};
      const post = (path: string, value: unknown) =>
        fetch(`${server.url}${path}`, {method: 'POST', headers, body: JSON.stringify(value)});
      let saveFault: ReturnType<typeof vi.spyOn> | undefined;
      let writtenGeneration: string | undefined;
      try {
        const bypass = await post('/api/memory/save', {
          replaceUri: personalUri,
          expectedContent: storedContent,
          text: desired,
        });
        expect(bypass.status).toBe(500);
        expect(await readFile(join(directory, 'source.md'), 'utf8')).toBe(storedContent);
        const stale = await post('/api/attention/automatic-review', {
          action: 'manual-preview',
          project: 'threadnote',
          uri: personalUri,
          expectedContentHash: '0'.repeat(64),
          desiredContent: desired,
        });
        expect(stale.status).toBe(409);
        const preview = await post('/api/attention/automatic-review', {
          action: 'manual-preview',
          project: 'threadnote',
          uri: personalUri,
          expectedContentHash: sha256HexSync(content),
          desiredContent: desired,
        });
        expect(preview.status, await preview.clone().text()).toBe(200);
        const prepared = (await preview.json()) as ManagerAutomaticReview;
        expect(prepared).toMatchObject({
          kind: 'automatic-memory-review',
          purpose: 'manual-edit',
          verified: false,
          canApply: true,
        });
        expect(prepared.approval?.content).toContain('Edited info.');
        expect(prepared.approval?.reviewedSupport.active.paragraphs).toMatchObject([
          {ordinal: 0, role: 'unknown', support: 'unresolved', evidenceIds: []},
          {ordinal: 1, role: 'descriptive', support: 'direct', evidenceIds: [evidenceId]},
        ]);
        expect(prepared.approval?.reviewedSupport.initialApproval).toEqual(active);
        expect(prepared.approval?.reviewedSupport.active.sources).toEqual([
          {id: evidenceId, source, scope: 'personal'},
        ]);
        expect(prepared.approval?.metadataDiff.length).toBeGreaterThan(0);
        expect(await readFile(join(directory, 'source.md'), 'utf8')).toBe(storedContent);
        await writeFile(join(directory, 'support.md'), sourceContent.replace('Keep info.', 'Changed private source.'));
        const withheld = await fetch(
          `${server.url}/api/attention/automatic-review?project=threadnote&reviewId=${prepared.reviewId}`,
          {headers},
        );
        expect(withheld.status).toBe(200);
        const recovery = await withheld.json();
        expect(recovery).toEqual({
          version: 1,
          kind: 'topic-maintenance-recovery',
          project: 'threadnote',
          reviewId: prepared.reviewId,
          revision: prepared.revision,
          state: 'pending',
          recovery: {action: 'reject'},
        });
        expect(JSON.stringify(recovery)).not.toMatch(/Edited info\.|Changed private source\.|Old info\.|Keep info\./u);
        const privateInbox = await fetch(`${server.url}/api/reviews?project=threadnote&view=pending`, {headers});
        const inboxText = await privateInbox.text();
        expect(inboxText).not.toMatch(/Edited info\.|Changed private source\./u);
        expect(inboxText).toContain('Source access is unavailable');
        if (mode === 'reject-stale-source') {
          const changedSelection = {
            project: 'threadnote',
            reviewId: prepared.reviewId,
            revision: prepared.revision,
          };
          for (const request of [
            {...changedSelection, action: 'preview'},
            {...changedSelection, action: 'apply', approvalDigest: prepared.approval!.approvalDigest, approved: true},
          ]) {
            const refused = await post('/api/attention/automatic-review', request);
            expect(refused.status).toBe(409);
            expect(await refused.text()).not.toMatch(/Edited info\.|Changed private source\.|Old info\.|Keep info\./u);
          }
          const decision = {
            action: 'reject',
            project: 'threadnote',
            reviewId: prepared.reviewId,
            revision: prepared.revision,
          };
          expect((await post('/api/attention/automatic-review', {...decision, project: 'wrong'})).status).toBe(409);
          expect(
            (await post('/api/attention/automatic-review', {...decision, revision: prepared.revision + 1})).status,
          ).toBe(409);
          const rejected = await post('/api/attention/automatic-review', decision);
          expect(rejected.status, await rejected.clone().text()).toBe(200);
          expect(await rejected.json()).toEqual({
            version: 1,
            kind: 'topic-maintenance-recovery',
            project: 'threadnote',
            reviewId: prepared.reviewId,
            revision: prepared.revision + 1,
            state: 'rejected',
          });
          expect(await readFile(join(directory, 'source.md'), 'utf8')).toBe(storedContent);
          return;
        }
        await writeFile(join(directory, 'support.md'), sourceContent);
        const selection = {
          action: 'apply',
          project: 'threadnote',
          reviewId: prepared.reviewId,
          revision: prepared.revision,
          approvalDigest: prepared.approval!.approvalDigest,
        };
        expect((await post('/api/attention/automatic-review', selection)).status).toBe(400);
        expect(
          (await post('/api/attention/automatic-review', {...selection, project: 'wrong', approved: true})).status,
        ).toBe(409);
        if (mode === 'finish-verification' || mode === 'retry-prewrite') {
          const save = candidateStore.saveCandidateReview;
          const write = memoryWriter.writeApprovedTopicMaintenanceContent;
          let failed = false;
          saveFault =
            mode === 'retry-prewrite'
              ? vi
                  .spyOn(memoryWriter, 'writeApprovedTopicMaintenanceContent')
                  .mockImplementation((runtimeConfig, ...args) => {
                    if (!failed) {
                      failed = true;
                      return write({...runtimeConfig, agentContextHome: runtime.manifestPath}, ...args);
                    }
                    return write(runtimeConfig, ...args);
                  })
              : vi.spyOn(candidateStore, 'saveCandidateReview').mockImplementation((contextHome, review) => {
                  if (!failed && review.maintenanceApproval?.stage === 'written') {
                    failed = true;
                    // The real persistence seam encounters ENOTDIR only after canonical write.
                    return save(runtime.manifestPath, review);
                  }
                  return save(contextHome, review);
                });
          const partial = await post('/api/attention/automatic-review', {...selection, approved: true});
          expect(partial.status).toBe(409);
          expect(failed).toBe(true);
          expect(await readFile(join(directory, 'source.md'), 'utf8')).toBe(
            mode === 'retry-prewrite' ? storedContent : prepared.approval!.content,
          );
          if (mode === 'finish-verification')
            writtenGeneration = await readFile(
              join(home, 'locks', 'resources', 'local', 'canonical-generation-v1'),
              'utf8',
            );
          const resume = await fetch(
            `${server.url}/api/attention/automatic-review?project=threadnote&reviewId=${prepared.reviewId}`,
            {headers},
          );
          const current = (await resume.json()) as ManagerAutomaticReview;
          expect(current).toMatchObject({
            state: 'applying',
            canFinishVerification: mode === 'finish-verification',
            canApply: true,
            approval: {stage: 'prepared', reviewRevision: prepared.revision},
          });
          expect(current.revision).toBeGreaterThan(prepared.revision);
          expect((await post('/api/attention/automatic-review', {...selection, approved: true})).status).toBe(409);
          selection.revision = current.revision;
        }
        const applied = await post('/api/attention/automatic-review', {...selection, approved: true});
        expect(applied.status, await applied.clone().text()).toBe(200);
        expect(await applied.json()).toMatchObject({state: 'applied', verified: true, approval: {stage: 'written'}});
        const written = await readFile(join(directory, 'source.md'), 'utf8');
        expect(written).toBe(prepared.approval!.content);
        expect(sha256HexSync(written)).toBe(prepared.approval!.contentHash);
        if (writtenGeneration !== undefined)
          expect(await readFile(join(home, 'locks', 'resources', 'local', 'canonical-generation-v1'), 'utf8')).toBe(
            writtenGeneration,
          );
        const journal = JSON.parse(
          await readFile(join(home, 'threadnote', 'candidates', 'v1', 'reviews', `${prepared.reviewId}.json`), 'utf8'),
        ) as candidateStore.CandidateReview;
        expect(journal.auditEvents.filter(event => event.action === 'apply')).toHaveLength(1);
        const reloaded = await fetch(
          `${server.url}/api/attention/automatic-review?project=threadnote&reviewId=${prepared.reviewId}`,
          {headers},
        );
        expect(await reloaded.json()).toMatchObject({verified: true, state: 'applied'});
        const list = await fetch(`${server.url}/api/attention/automatic-memory?project=threadnote`, {headers});
        expect(
          ((await list.json()) as {items: {reviewId?: string}[]}).items.every(
            item => item.reviewId !== prepared.reviewId,
          ),
        ).toBe(true);
      } finally {
        saveFault?.mockRestore();
        await server.close();
        await rm(home, {recursive: true, force: true});
      }
    },
  );
  it.each([false, true])('rejects root deletion and substitution through HTTP Save (shared=%s)', async shared => {
    const f = await managerProvenanceFixture(shared);
    const server = await startManagerTestServer(f.runtime, 'provenance-secret');
    const save = (text: string, expectedContent: string) =>
      fetch(`${server.url}/api/memory/save`, {
        method: 'POST',
        headers: {authorization: 'Bearer provenance-secret', 'content-type': 'application/json'},
        body: JSON.stringify({replaceUri: f.uri, expectedContent, text}),
      });
    try {
      const {root, current} = reviewedCodeMemory();
      const rootLine = `code_citation: ${JSON.stringify(root)}`;
      for (const replacement of ['', `code_citation: ${JSON.stringify(current)}\n`, `${rootLine} \n`]) {
        const changed = f.content.replace(`${rootLine}\n`, replacement);
        expect(parseMemoryDocument(f.uri, changed)?.metadata.reviewedSupport).toEqual(
          parseMemoryDocument(f.uri, f.content)?.metadata.reviewedSupport,
        );
        const response = await save(changed, f.content);
        const result = await response.text();
        expect(response.status, result).toBe(500);
        expect(result).toContain('context_maintenance_review');
        expect(await readFile(f.canonicalPath, 'utf8')).toBe(f.content);
        if (f.worktreePath) expect(await readFile(f.worktreePath, 'utf8')).toBe(f.content);
      }
      const edited = f.content.replace('status: active', 'status: active\nkeywords: retained-provenance');
      const response = await save(edited, f.content);
      expect(response.status, await response.text()).toBe(200);
      const stored = await readFile(f.canonicalPath, 'utf8');
      expect(stored).toBe(edited);
      expect(parseMemoryDocument(f.uri, stored)?.metadata.reviewedSupport).toEqual(
        parseMemoryDocument(f.uri, f.content)?.metadata.reviewedSupport,
      );
      if (f.worktreePath) expect(await readFile(f.worktreePath, 'utf8')).toBe(edited);
    } finally {
      await server.close();
      await rm(f.home, {recursive: true, force: true});
    }
  });

  it('protects roots without raw content and retains first approval and typed legacy origin', () => {
    const {content, root, current} = reviewedCodeMemory();
    const legacyBody = 'Historic limit was 30.';
    const legacy = memoryContent('tn_manager_source', 'source', legacyBody, {codeCitations: [root]});
    const captured = captureConsolidationSource({uri: personalUri, content: legacy});
    const reviewed = reviewConsolidation(
      legacyBody,
      [captured],
      [
        {
          section: legacyBody,
          disposition: 'direct',
          supports: [{sourceUri: personalUri, fragment: 0, citationIds: [root.id], relationIndexes: []}],
        },
      ],
      {
        operationId: 'manager-legacy-origin',
        cleanup: 'keep',
        cleanupShared: false,
        target: {kind: 'durable', status: 'active', project: 'threadnote', topic: 'source', sourceAgentClient: 'test'},
      },
    );
    const legacyOrigin = captureReviewedSupportLegacyOrigin(
      parseMemoryDocument(
        personalUri,
        memoryContent('tn_manager_source', 'source', legacyBody, {
          codeCitations: reviewed.codeCitations,
          consolidation: reviewed.provenance,
        }),
      )!,
    );
    expect(legacyOrigin).toBeDefined();
    const original = parseMemoryDocument(personalUri, content)!;
    const preserved = {...original.metadata.reviewedSupport!, legacyOrigin};
    const withLegacy = memoryContent('tn_manager_source', 'source', original.body, {
      schemaVersion: 11,
      codeCitations: [root],
      reviewedSupport: preserved,
    });
    const record = parseMemoryDocument(personalUri, withLegacy)!;
    expect(record.metadata.reviewedSupportError).toBeUndefined();
    const metadataEdit = withLegacy.replace('status: active', 'status: active\nkeywords: keep-history');
    expect(() => assertManagerRawPersonalMemorySave(personalUri, withLegacy, withLegacy, metadataEdit)).not.toThrow();
    expect(topicMaintenanceReplacementError(record, parseMemoryDocument(personalUri, metadataEdit)!)).toBeUndefined();
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, withLegacy, withLegacy, metadataEdit)).toThrow(
      'private source evidence',
    );
    expect(parseMemoryDocument(personalUri, metadataEdit)?.metadata.reviewedSupport).toEqual(preserved);
    expect(
      topicMaintenanceReplacementError(record, {
        body: record.body,
        metadata: {...record.metadata, codeCitations: [current]},
      }),
    ).toContain('root code citations');
    const ordinaryEdit = legacy.replace(
      `code_citation: ${JSON.stringify(root)}`,
      `code_citation: ${JSON.stringify(current)}`,
    );
    expect(() => assertManagerRawPersonalMemorySave(personalUri, legacy, legacy, ordinaryEdit)).not.toThrow();
    expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, legacy, legacy, ordinaryEdit)).not.toThrow();
  });

  it('preserves reviewed root bytes across unrelated metadata edits and browser line endings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{1,12}$/u), {minLength: 1, maxLength: 4}),
        fc.constantFrom('\n', '\r\n', '\r'),
        (keywords, ending) => {
          const {content} = reviewedCodeMemory();
          const previous = content.replaceAll('\n', ending);
          const next = content.replace('status: active', `status: active\nkeywords: ${keywords.join(' ')}`);
          expect(() => assertManagerRawPersonalMemorySave(personalUri, previous, previous, next)).not.toThrow();
          expect(() => assertManagerRawSharedMemorySave(config(), sharedUri, previous, previous, next)).not.toThrow();
        },
      ),
      {numRuns: 30},
    );
  });

  it('refuses reviewed-support consolidation before model dispatch or cleanup', async () => {
    const f = await managerProvenanceFixture();
    const otherPath = join(f.canonicalPath, '..', 'other.md');
    const other = memoryContent('tn_manager_other', 'other', 'Another memory.');
    await writeFile(otherPath, other);
    const generation = vi.spyOn(selectedDraft, 'runSelectedDraft').mockReturnValue(
      Effect.succeed({
        text: 'Bounded test draft.',
        backendIdentity: 'fixture',
        modelIdentity: 'fixture',
        usage: {status: 'unavailable'},
        settings: {maxOutputTokens: 4000},
      }),
    );
    const server = await startManagerTestServer(f.runtime, 'provenance-secret');
    try {
      const response = await fetch(`${server.url}/api/consolidations`, {
        method: 'POST',
        headers: {authorization: 'Bearer provenance-secret', 'content-type': 'application/json'},
        body: JSON.stringify({
          agent: 'cursor',
          kind: 'durable',
          project: 'threadnote',
          topic: 'consolidated',
          uris: [f.uri, personalUri.replace('/source.md', '/other.md')],
        }),
      });
      expect(response.status).toBe(200);
      const {job} = (await response.json()) as {job: {id: string; status: string; error?: string}};
      expect(job).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/reviewed support.*cannot preserve/iu),
      });
      expect(generation).not.toHaveBeenCalled();
      const apply = await fetch(`${server.url}/api/consolidations/${job.id}/apply`, {
        method: 'POST',
        headers: {authorization: 'Bearer provenance-secret', 'content-type': 'application/json'},
        body: JSON.stringify({confirm: true, cleanup: 'forget'}),
      });
      expect(apply.status).toBe(500);
      expect(await apply.text()).toContain('not completed');
      expect(await readFile(f.canonicalPath, 'utf8')).toBe(f.content);
      expect(await readFile(otherPath, 'utf8')).toBe(other);
      const legacy = f.content
        .replace(/^reviewed_support: .*\n/mu, '')
        .replace('schema_version: 11', 'schema_version: 10');
      await writeFile(f.canonicalPath, legacy);
      const control = await fetch(`${server.url}/api/consolidations`, {
        method: 'POST',
        headers: {authorization: 'Bearer provenance-secret', 'content-type': 'application/json'},
        body: JSON.stringify({
          agent: 'cursor',
          kind: 'durable',
          project: 'threadnote',
          topic: 'consolidated',
          uris: [f.uri, personalUri.replace('/source.md', '/other.md')],
        }),
      });
      expect(control.status).toBe(200);
      expect(await control.json()).toMatchObject({
        job: {
          status: 'completed',
          sources: [{uri: f.uri, codeCitations: [reviewedCodeMemory().root]}, {codeCitations: []}],
        },
      });
      expect(generation).toHaveBeenCalledOnce();
      expect(await readFile(f.canonicalPath, 'utf8')).toBe(legacy);
    } finally {
      await server.close();
      generation.mockRestore();
      await rm(f.home, {recursive: true, force: true});
    }
  });
});
