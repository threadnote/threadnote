import {Predicate} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {mkdtemp, mkdir, writeFile, readFile, rm} from '@threadnote/testing/node-fs-promises';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {tmpdir} from '@threadnote/testing/node-os';
import {join, dirname} from '@threadnote/testing/node-path';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {startManagerTestServer, type ManagerTestServer} from '../helpers/manager-test-server.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {SharingConflict} from '@threadnote/manager/sharing-contracts';
import type {ObsidianIntegration} from '@threadnote/integration-obsidian/manager-contracts';
import type {IntegrationResult} from '@threadnote/integration-core/manager-contracts';
import {parseSourceConfiguration} from '@threadnote/threadnote/integrations/config';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

type TestResponse = Record<PropertyKey, unknown>;
function isArrayOf<T>(value: unknown, item: (candidate: unknown) => candidate is T): value is readonly T[] {
  return EffectArray.isArray(value) && EffectArray.every(value, item);
}
function isStringArray(value: unknown): value is readonly string[] {
  return isArrayOf(value, (item): item is string => typeof item === 'string');
}
function isMemoryKind(value: unknown): value is ObsidianIntegration['projections'][number]['kinds'][number] {
  return EffectArray.some(['durable', 'handoff', 'incident', 'preference', 'smoke'] as const, kind => kind === value);
}
function isMemoryStatus(value: unknown): value is ObsidianIntegration['projections'][number]['statuses'][number] {
  return EffectArray.some(['active', 'archived', 'expired', 'superseded'] as const, status => status === value);
}
function isObsidianSource(value: unknown): value is ObsidianIntegration['sources'][number] {
  return (
    Predicate.isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.vault === 'string' &&
    typeof value.enabled === 'boolean' &&
    isStringArray(value.include) &&
    isStringArray(value.exclude) &&
    typeof value.watch === 'boolean' &&
    (value.inbox === undefined || typeof value.inbox === 'string')
  );
}
function isObsidianProjection(value: unknown): value is ObsidianIntegration['projections'][number] {
  return (
    Predicate.isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.vault === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.folder === 'string' &&
    isArrayOf(value.kinds, isMemoryKind) &&
    isArrayOf(value.statuses, isMemoryStatus) &&
    typeof value.includeShared === 'boolean' &&
    (value.selectedUris === undefined || isStringArray(value.selectedUris))
  );
}
function isIntegrationEntry(value: unknown): value is IntegrationResult['entries'][number] {
  return (
    Predicate.isObject(value) &&
    typeof value.action === 'string' &&
    typeof value.relativePath === 'string' &&
    (value.detail === undefined || typeof value.detail === 'string')
  );
}
function isSharingConflict(value: unknown): value is SharingConflict {
  return (
    Predicate.isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.team === 'string' &&
    typeof value.uri === 'string' &&
    typeof value.relativePath === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.status === 'string' &&
    typeof value.hasLocalContent === 'boolean' &&
    typeof value.hasSharedContent === 'boolean' &&
    (value.identityConflict === undefined ||
      value.identityConflict === 'missing' ||
      value.identityConflict === 'changed')
  );
}
function responseField<T>(body: TestResponse, key: string, isValue: (value: unknown) => value is T): T {
  const value = body[key];
  if (!isValue(value)) throw new Error(`Manager HTTP response field ${key} is invalid.`);
  return value;
}
function responseArray<T>(body: TestResponse, key: string, isItem: (value: unknown) => value is T): readonly T[] {
  return responseField(body, key, value => isArrayOf(value, isItem));
}
function sourceList(body: TestResponse): ObsidianIntegration['sources'] {
  return responseArray(body, 'sources', isObsidianSource);
}
function projectionList(body: TestResponse): ObsidianIntegration['projections'] {
  return responseArray(body, 'projections', isObsidianProjection);
}
function integrationEntries(body: TestResponse): IntegrationResult['entries'] {
  return responseArray(body, 'entries', isIntegrationEntry);
}
function sharingConflicts(body: TestResponse): readonly SharingConflict[] {
  return responseArray(body, 'conflicts', isSharingConflict);
}
function stringField(body: TestResponse, key: string): string {
  return responseField(body, key, (value): value is string => typeof value === 'string');
}
function numberField(body: TestResponse, key: string): number {
  return responseField(body, key, (value): value is number => typeof value === 'number');
}
function optionalStringField(body: TestResponse, key: string): string | undefined {
  const value = body[key];
  if (value !== undefined && typeof value !== 'string')
    throw new Error(`Manager HTTP response field ${key} is invalid.`);
  return value;
}
function decodeTestResponse(input: unknown): TestResponse {
  if (!Predicate.isObject(input)) throw new Error('Manager HTTP response body is not an object.');
  return input;
}
// These tests exercise the real fetch/HTTP boundary and Git child processes.
let home: string;
let server: ManagerTestServer;
const token = 'manager-feature-test-token';
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'manager-integrations-'));
  const config: RuntimeConfig = {
    agentContextHome: home,
    account: 'local',
    agentId: 'threadnote',
    user: 'tester',
    manifestPath: join(home, 'seed-manifest.yaml'),
  };
  server = await startManagerTestServer(config, token);
});
afterEach(async () => {
  await server?.close();
  if (home) await rm(home, {recursive: true, force: true});
});
async function request(path: string, body?: Record<string, unknown>) {
  const response = await testHttpFetch(server.url + path, {
    method: body ? 'POST' : 'GET',
    headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const responseBody: unknown = await response.json();
  return {status: response.status, body: decodeTestResponse(responseBody)};
}
async function write(path: string, content: string) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, content);
}
function git(cwd: string, ...args: string[]) {
  return Effect.pipe(
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Manager test',
        GIT_AUTHOR_EMAIL: 'manager@example.test',
        GIT_COMMITTER_NAME: 'Manager test',
        GIT_COMMITTER_EMAIL: 'manager@example.test',
      },
    }),
    EffectString.trim,
  );
}

describe('Manager Obsidian HTTP workflow', () => {
  it('keeps Superhuman sources outside Obsidian connections and preserves them during edits', async () => {
    const vault = join(home, 'vault');
    await mkdir(vault, {recursive: true});
    const configPath = join(home, 'threadnote', 'sources.yaml');
    await write(
      configPath,
      JSON.stringify({
        version: 2,
        sources: [
          {type: 'obsidian', id: 'notes', vault, include: ['**/*.md'], exclude: [], enabled: false, watch: true},
          {
            type: 'superhuman',
            id: 'remote-notes',
            credential_env: 'SUPERHUMAN_DOCS_API_TOKEN',
            project: 'demo',
            documents: [{id: 'doc_test', pages: ['page_test']}],
          },
        ],
        projections: [],
      }),
    );
    const before = parseSourceConfiguration(await readFile(configPath, 'utf8'));
    expect(
      EffectArray.map(sourceList((await request('/api/integrations/obsidian')).body), source => source.id),
    ).toEqual(['notes']);
    expect(
      (
        await request('/api/integrations/obsidian', {
          action: 'save-source',
          id: 'notes',
          editing: true,
          include: ['**/*.md'],
          exclude: [],
          apply: true,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    const edited = parseSourceConfiguration(await readFile(configPath, 'utf8'));
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(edited.sources, source => source.id === 'notes')),
    ).toMatchObject({enabled: false, watch: true});
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(edited.sources, source => source.id === 'remote-notes')),
    ).toEqual(before.sources[1]);
    expect(
      (
        await request('/api/integrations/obsidian', {
          action: 'set-enabled',
          id: 'notes',
          kind: 'source',
          enabled: true,
          apply: true,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    expect(parseSourceConfiguration(await readFile(configPath, 'utf8')).sources[1]).toEqual(before.sources[1]);
  });

  it('requires authorization and explicit apply confirmation', async () => {
    const response = await testHttpFetch(server.url + '/api/integrations/obsidian');
    expect(response.status).toBe(401);
    expect(
      (await request('/api/integrations/obsidian', {action: 'save-source', id: 'notes', apply: true})).status,
    ).toBe(400);
    expect(sourceList((await request('/api/integrations/obsidian')).body)).toEqual([]);
  });
  it('previews imports without writing, applies them, and disconnects without deleting vault notes', async () => {
    const vault = join(home, 'vault');
    await write(join(vault, 'Engineering', 'Boundaries.md'), '# Boundaries\n\nKeep services focused.');
    const base = {id: 'notes', vault, include: ['Engineering/**/*.md'], exclude: [], inbox: 'Inbox'};
    expect(
      (await request('/api/integrations/obsidian', {action: 'save-source', ...base, apply: true, confirm: true}))
        .status,
    ).toBe(200);
    const preview = await request('/api/integrations/obsidian', {action: 'sync-source', id: 'notes'});
    expect(preview.status).toBe(200);
    expect(integrationEntries(preview.body)).toEqual([
      expect.objectContaining({action: 'add', relativePath: 'Engineering/Boundaries.md'}),
    ]);
    const imported = join(home, 'data/local/resources/external/obsidian/notes/Engineering/Boundaries.md');
    await expect(readFile(imported, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    expect(
      (await request('/api/integrations/obsidian', {action: 'sync-source', id: 'notes', apply: true, confirm: true}))
        .status,
    ).toBe(200);
    await expect
      .poll(
        () =>
          readFile(imported, 'utf8').catch(cause => {
            if ((Predicate.hasProperty(cause, 'code') ? cause.code : undefined) === 'ENOENT') return '';
            throw cause;
          }),
        {interval: 25, timeout: 10_000},
      )
      .toContain('Keep services focused.');
    await request('/api/integrations/obsidian', {
      action: 'set-enabled',
      id: 'notes',
      kind: 'source',
      enabled: false,
      apply: true,
      confirm: true,
    });
    await request('/api/integrations/obsidian', {
      action: 'save-source',
      ...base,
      editing: true,
      apply: true,
      confirm: true,
    });
    expect(sourceList((await request('/api/integrations/obsidian')).body)[0].enabled).toBe(false);
    expect(
      (await request('/api/integrations/obsidian', {action: 'remove-source', id: 'notes', apply: true, confirm: true}))
        .status,
    ).toBe(200);
    expect(await readFile(join(vault, 'Engineering', 'Boundaries.md'), 'utf8')).toContain('Keep services focused.');
    expect(sourceList((await request('/api/integrations/obsidian')).body)).toEqual([]);
  });
  it('previews Inbox proposals without creating reviews and applies each unchanged note only once', async () => {
    const vault = join(home, 'vault');
    const note =
      '---\nthreadnote_candidate: true\nkind: durable\nproject: demo\ntopic: retry-policy\n---\n# Retry policy\n\nRetry only transient failures and cap the time budget.\n';
    await write(join(vault, 'Inbox', 'Retry policy.md'), note);
    await write(join(vault, 'Inbox', 'Private draft.md'), '# Ordinary unmarked note');
    expect(
      (
        await request('/api/integrations/obsidian', {
          action: 'save-source',
          id: 'notes',
          vault,
          include: ['**/*.md'],
          exclude: [],
          inbox: 'Inbox',
          apply: true,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    const preview = await request('/api/integrations/obsidian', {action: 'scan-inbox', id: 'notes'});
    expect(numberField(preview.body, 'reviewCount')).toBe(1);
    const reviews = async () => {
      const response = await testHttpFetch(server.url + '/api/reviews?project=demo', {
        headers: {authorization: 'Bearer ' + token},
      });
      const value: unknown = await response.json();
      if (!Predicate.isObject(value) || typeof value.pendingCount !== 'number')
        throw new Error('Manager reviews response has an invalid pending count.');
      return {pendingCount: value.pendingCount};
    };
    expect((await reviews()).pendingCount).toBe(0);
    const apply = {action: 'scan-inbox', id: 'notes', apply: true, confirm: true};
    expect(numberField((await request('/api/integrations/obsidian', apply)).body, 'reviewCount')).toBe(1);
    expect((await reviews()).pendingCount).toBe(1);
    expect(numberField((await request('/api/integrations/obsidian', apply)).body, 'reviewCount')).toBe(0);
    expect((await reviews()).pendingCount).toBe(1);
    expect(await readFile(join(vault, 'Inbox', 'Retry policy.md'), 'utf8')).toBe(note);
  });
  it('validates selected memory URIs before saving and preserves edited exports', async () => {
    const vault = join(home, 'vault');
    await mkdir(vault, {recursive: true});
    const base = {
      action: 'save-projection',
      id: 'library',
      vault,
      folder: 'Threadnote',
      kinds: ['durable'],
      statuses: ['active'],
      includeShared: false,
      apply: true,
      confirm: true,
    };
    expect(
      (
        await request('/api/integrations/obsidian', {
          ...base,
          selection: 'selected',
          selectedUris: ['threadnote://user/other/memories/durable/projects/demo/note.md'],
        })
      ).status,
    ).toBe(409);
    expect(projectionList((await request('/api/integrations/obsidian')).body)).toEqual([]);
    expect((await request('/api/integrations/obsidian', {...base, selection: 'all'})).status).toBe(200);
    const memory = 'MEMORY\nkind: durable\nstatus: active\nproject: demo\ntopic: note\n\n# A memory\n\nOriginal body.';
    await write(join(home, 'data/local/user/tester/memories/durable/projects/demo/note.md'), memory);
    const preview = await request('/api/integrations/obsidian', {action: 'sync-projection', id: 'library'});
    expect(integrationEntries(preview.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({action: 'add', relativePath: expect.stringContaining('Memories/demo/')}),
      ]),
    );
    expect(
      (
        await request('/api/integrations/obsidian', {
          action: 'sync-projection',
          id: 'library',
          apply: true,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    const exported = join(vault, 'Threadnote', integrationEntries(preview.body)[0].relativePath);
    await writeFile(exported, '# Edited in Obsidian');
    const again = await request('/api/integrations/obsidian', {
      action: 'sync-projection',
      id: 'library',
      apply: true,
      confirm: true,
    });
    expect(integrationEntries(again.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({action: 'drift'})]),
    );
    expect(await readFile(exported, 'utf8')).toBe('# Edited in Obsidian');
    expect(
      (
        await request('/api/integrations/obsidian', {
          action: 'remove-projection',
          id: 'library',
          apply: true,
          confirm: true,
        })
      ).status,
    ).toBe(409);
    expect(projectionList((await request('/api/integrations/obsidian')).body)).toHaveLength(1);
  });
});

describe('Manager shared conflict HTTP workflow', () => {
  async function conflictFixture() {
    const remote = join(home, 'remote.git');
    const seed = join(home, 'seed');
    await mkdir(seed, {recursive: true});
    git(home, 'init', '--bare', remote);
    git(seed, 'init', '-b', 'main');
    const relativePath = 'durable/projects/demo/boundaries.md';
    const shared = 'MEMORY\nkind: durable\nstatus: active\nproject: demo\ntopic: boundaries\n\nShared body.';
    await write(join(seed, relativePath), shared);
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'shared memory');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-u', 'origin', 'main');
    git(home, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    expect((await request('/api/shares/init', {remoteUrl: remote, team: 'engineering', confirm: true})).status).toBe(
      200,
    );
    const worktree = join(home, 'share/worktrees/engineering');
    git(worktree, 'config', 'user.name', 'Manager test');
    git(worktree, 'config', 'user.email', 'manager@example.test');
    const localPath = join(home, 'data/local/user/tester/memories/shared/engineering', relativePath);
    await write(localPath, Effect.pipe(shared, EffectString.replace('Shared body.', 'Local body.')));
    await write(
      join(home, 'share/auto-sync-pending-reindexes.json'),
      JSON.stringify({
        version: 1,
        teams: {engineering: [{path: join(worktree, relativePath), relativePath, status: 'modified'}]},
      }),
    );
    return {id: 'engineering:' + relativePath, relativePath, localPath, worktree};
  }
  it.each(['local', 'shared', 'manual'])('resolves a reviewed conflict with the %s choice', async resolution => {
    const fixture = await conflictFixture();
    const listed = await request('/api/shares/conflicts');
    expect(sharingConflicts(listed.body)).toHaveLength(1);
    const detail = await request('/api/shares/conflicts/detail?id=' + encodeURIComponent(fixture.id));
    expect(detail.body).toMatchObject({canKeepLocal: true, canUseShared: true, canMerge: true});
    const resolved = await request('/api/shares/conflicts/resolve', {
      id: fixture.id,
      revision: stringField(detail.body, 'revision'),
      resolution,
      content: Effect.pipe(
        optionalStringField(detail.body, 'localContent') ?? '',
        EffectString.replace('Local body.', 'Merged body.'),
      ),
      confirm: true,
    });
    expect(resolved.status).toBe(200);
    expect(await readFile(fixture.localPath, 'utf8')).toContain(
      resolution === 'manual' ? 'Merged body.' : resolution === 'local' ? 'Local body.' : 'Shared body.',
    );
    expect(sharingConflicts((await request('/api/shares/conflicts')).body)).toEqual([]);
  });
  it('rejects stale reviewed content without replacing it or clearing the conflict', async () => {
    const fixture = await conflictFixture();
    const detail = await request('/api/shares/conflicts/detail?id=' + encodeURIComponent(fixture.id));
    const newer = Effect.pipe(
      optionalStringField(detail.body, 'localContent') ?? '',
      EffectString.replace('Local body.', 'Newer local edit.'),
    );
    await writeFile(fixture.localPath, newer);
    const result = await request('/api/shares/conflicts/resolve', {
      id: fixture.id,
      revision: stringField(detail.body, 'revision'),
      resolution: 'shared',
      confirm: true,
    });
    expect(result.status).toBe(409);
    expect(stringField(result.body, 'error')).toContain('changed after you opened it');
    expect(await readFile(fixture.localPath, 'utf8')).toBe(newer);
    expect(sharingConflicts((await request('/api/shares/conflicts')).body)).toHaveLength(1);
  });
});
