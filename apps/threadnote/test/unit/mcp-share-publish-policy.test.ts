import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {createHash} from '@threadnote/testing/node-crypto';
import {runCommandEffect} from '@threadnote/platform/command';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {runSharePublishTool} from '@threadnote/threadnote/mcp/server/share';
import {runForget} from '@threadnote/threadnote/memory/commands';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('MCP share-publish citation policy', () => {
  it.effect('rechecks the exact source inside the publish lock after an initially clean read', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-share-policy-'});
        const worktree = path.join(home, 'share', 'worktrees', 'default');
        const gitdir = path.join(home, 'share', 'teams', 'default.gitdir');
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/policy.md';
        const sourcePath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'policy.md',
        );
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
        yield* fs.makeDirectory(worktree, {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: '2026-08-26T20:00:00.000Z',
                  gitdir,
                  name: 'default',
                  remote: 'git@example.com:team/memories.git',
                  worktree,
                },
              },
              version: 1,
            },
            undefined,
            2,
          )}\n`,
        );
        const clean = citedMemory(false);
        const swapped = citedMemory(true);
        yield* fs.writeFileString(sourcePath, swapped);

        const realStore = yield* ResourceStore;
        let sourceReads = 0;
        const initialReadStore = ResourceStore.of({
          ...realStore,
          read: (location, uri) =>
            uri === sourceUri
              ? Effect.sync(() => (++sourceReads === 1 ? clean : swapped))
              : realStore.read(location, uri),
        });
        const result = yield* runSharePublishTool(config, sourceUri, {push: false}).pipe(
          Effect.provideService(ResourceStore, initialReadStore),
        );
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBe(true);
        expect(sourceReads).toBe(2);
        expect(text).toContain('dirty worktree cannot be shared');
        expect(yield* fs.readFileString(sourcePath)).toBe(swapped);
        expect(yield* fs.exists(path.join(worktree, 'durable', 'projects', 'threadnote', 'policy.md'))).toBe(false);

        const changedKind = clean.replace('kind: durable', 'kind: handoff');
        yield* fs.writeFileString(sourcePath, changedKind);
        let kindReads = 0;
        const kindSwapStore = ResourceStore.of({
          ...realStore,
          read: (location, uri) =>
            uri === sourceUri
              ? Effect.sync(() => (++kindReads === 1 ? clean : changedKind))
              : realStore.read(location, uri),
        });
        const kindResult = yield* runSharePublishTool(config, sourceUri, {push: false}).pipe(
          Effect.provideService(ResourceStore, kindSwapStore),
        );
        const kindText = kindResult.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');
        expect(kindResult.isError).toBe(true);
        expect(kindReads).toBe(2);
        expect(kindText).toContain('only active personal durable memories');
        expect(yield* fs.exists(path.join(worktree, 'durable', 'projects', 'threadnote', 'policy.md'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('refuses pending code citations unless allowUncitedPendingCodeRefs is set', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-share-pending-'});
        const worktree = path.join(home, 'share', 'worktrees', 'default');
        const gitdir = path.join(home, 'share', 'teams', 'default.gitdir');
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/pending.md';
        const sourcePath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'pending.md',
        );
        const pendingPath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'private',
          'deferred-code-anchors',
          'v1',
          `${createHash('sha256').update(sourceUri).digest('hex')}.json`,
        );
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
        yield* fs.makeDirectory(path.dirname(pendingPath), {recursive: true, mode: 0o700});
        yield* fs.chmod(path.dirname(pendingPath), 0o700);
        yield* fs.makeDirectory(worktree, {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: '2026-08-26T20:00:00.000Z',
                  gitdir,
                  name: 'default',
                  remote: 'git@example.com:team/memories.git',
                  worktree,
                },
              },
              version: 1,
            },
            undefined,
            2,
          )}\n`,
        );
        yield* fs.writeFileString(
          sourcePath,
          ['MEMORY', 'kind: durable', 'status: active', 'project: threadnote', 'topic: pending', '', 'Body'].join('\n'),
        );
        yield* fs.writeFileString(pendingPath, '{}\n');

        const refused = yield* runSharePublishTool(config, sourceUri, {preview: true});
        const refusedText = refused.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');
        expect(refused.isError).toBe(true);
        expect(refusedText).toContain('code citations are still pending');
        expect(refusedText).toContain('finalize_code_refs');
        expect(refusedText).toContain('allowUncitedPendingCodeRefs');

        const preview = yield* runSharePublishTool(config, sourceUri, {
          allowUncitedPendingCodeRefs: true,
          preview: true,
        });
        const previewText = preview.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');
        expect(preview.isError).toBeUndefined();
        expect(previewText).toContain('PREVIEW source:');
        expect(yield* fs.exists(pendingPath)).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('discards pending code citations after an allow-uncited publish', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-share-uncited-'});
        const worktree = path.join(home, 'share', 'worktrees', 'default');
        const gitdir = path.join(home, 'share', 'teams', 'default.gitdir');
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/pending.md';
        const sourcePath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'pending.md',
        );
        const pendingPath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'private',
          'deferred-code-anchors',
          'v1',
          `${createHash('sha256').update(sourceUri).digest('hex')}.json`,
        );
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
        yield* fs.makeDirectory(path.dirname(pendingPath), {recursive: true, mode: 0o700});
        yield* fs.chmod(path.dirname(pendingPath), 0o700);
        yield* fs.makeDirectory(worktree, {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: '2026-08-26T20:00:00.000Z',
                  gitdir,
                  name: 'default',
                  remote: 'git@example.com:team/memories.git',
                  worktree,
                },
              },
              version: 1,
            },
            undefined,
            2,
          )}\n`,
        );
        yield* fs.writeFileString(
          sourcePath,
          ['MEMORY', 'kind: durable', 'status: active', 'project: threadnote', 'topic: pending', '', 'Body'].join('\n'),
        );
        yield* fs.writeFileString(pendingPath, '{}\n', {mode: 0o600});
        yield* fs.chmod(pendingPath, 0o600);
        yield* runCommandEffect('git', ['init', '--quiet'], {cwd: worktree});
        yield* runCommandEffect('git', ['-C', worktree, 'config', 'user.email', 'threadnote@example.test']);
        yield* runCommandEffect('git', ['-C', worktree, 'config', 'user.name', 'Threadnote Test']);
        yield* runCommandEffect('git', ['-C', worktree, 'commit', '--allow-empty', '--quiet', '--message', 'init']);

        const published = yield* runSharePublishTool(config, sourceUri, {
          allowUncitedPendingCodeRefs: true,
          push: false,
        });
        const publishedText = published.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');
        expect(published.isError, publishedText).not.toBe(true);
        expect(publishedText).toContain(`Published ${sourceUri}`);
        expect(yield* fs.exists(sourcePath)).toBe(false);
        expect(yield* fs.exists(pendingPath)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('republishes over a forgotten canonical target when its tracked worktree file is clean', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-share-republish-'});
        const worktree = path.join(home, 'share', 'worktrees', 'default');
        const gitdir = path.join(home, 'share', 'teams', 'default.gitdir');
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/replacement-cycle.md';
        const targetUri =
          'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/replacement-cycle.md';
        const relativePath = 'durable/projects/threadnote/replacement-cycle.md';
        const sourcePath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'replacement-cycle.md',
        );
        const targetPath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
          relativePath,
        );
        const worktreePath = path.join(worktree, relativePath);
        const previous = [
          'MEMORY',
          'kind: durable',
          'status: active',
          'visibility: shared',
          'project: threadnote',
          'topic: replacement-cycle',
          'memory_id: tn_replacement_cycle',
          '',
          'Previous reviewed body.',
        ].join('\n');
        const replacement = previous
          .replace('visibility: shared', 'visibility: personal')
          .replace('Previous reviewed body.', 'Replacement reviewed body.');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
        yield* fs.makeDirectory(path.dirname(targetPath), {recursive: true});
        yield* fs.makeDirectory(path.dirname(worktreePath), {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
        yield* fs.writeFileString(sourcePath, replacement);
        yield* fs.writeFileString(targetPath, previous);
        yield* fs.writeFileString(worktreePath, previous);
        yield* fs.writeFileString(
          path.join(home, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: '2026-08-26T20:00:00.000Z',
                  gitdir,
                  name: 'default',
                  remote: 'git@example.com:team/memories.git',
                  worktree,
                },
              },
              version: 1,
            },
            undefined,
            2,
          )}\n`,
        );
        yield* runCommandEffect('git', ['init', '--quiet'], {cwd: worktree});
        yield* runCommandEffect('git', ['-C', worktree, 'config', 'user.email', 'threadnote@example.test']);
        yield* runCommandEffect('git', ['-C', worktree, 'config', 'user.name', 'Threadnote Test']);
        yield* runCommandEffect('git', ['-C', worktree, 'add', '--', relativePath]);
        yield* runCommandEffect('git', ['-C', worktree, 'commit', '--quiet', '--message', 'previous shared memory']);

        const refused = yield* runSharePublishTool(config, sourceUri, {push: false});
        expect(refused.isError).toBe(true);
        expect(refused.content.map(item => (item.type === 'text' ? item.text : '')).join('\n')).toContain(
          'already exists in the shared namespace',
        );
        yield* runForget(config, targetUri, {dryRun: true});
        expect(yield* fs.exists(targetPath)).toBe(true);
        yield* runForget(config, targetUri, {});
        expect((yield* runCommandEffect('git', ['-C', worktree, 'status', '--porcelain'])).stdout.trim()).toBe('');
        yield* fs.writeFileString(path.join(worktree, 'unrelated.md'), 'Unrelated staged work.\n');
        yield* runCommandEffect('git', ['-C', worktree, 'add', '--', 'unrelated.md']);

        const published = yield* runSharePublishTool(config, sourceUri, {push: false});
        const publishedText = published.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');
        expect(published.isError, publishedText).not.toBe(true);
        expect(publishedText).toContain(`Published ${sourceUri} -> ${targetUri}`);
        expect(yield* fs.exists(sourcePath)).toBe(false);
        expect(yield* fs.readFileString(targetPath)).toContain('Replacement reviewed body.');
        expect(yield* fs.readFileString(worktreePath)).toContain('Replacement reviewed body.');
        expect(
          (yield* runCommandEffect('git', ['-C', worktree, 'diff', '--cached', '--name-only'])).stdout.trim(),
        ).toBe('unrelated.md');
        expect(
          (yield* runCommandEffect('git', ['-C', worktree, 'ls-tree', '--name-only', 'HEAD', 'unrelated.md'])).stdout,
        ).toBe('');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('preview keeps identity-alias relations and drops local projection URIs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-share-relations-'});
        const worktree = path.join(home, 'share', 'worktrees', 'default');
        const gitdir = path.join(home, 'share', 'teams', 'default.gitdir');
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/relations.md';
        const sourcePath = path.join(
          home,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'relations.md',
        );
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        yield* fs.makeDirectory(path.dirname(sourcePath), {recursive: true});
        yield* fs.makeDirectory(worktree, {recursive: true});
        yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: '2026-08-26T20:00:00.000Z',
                  gitdir,
                  name: 'default',
                  remote: 'git@example.com:team/memories.git',
                  worktree,
                },
              },
              version: 1,
            },
            undefined,
            2,
          )}\n`,
        );
        yield* fs.writeFileString(
          sourcePath,
          [
            'MEMORY',
            'kind: durable',
            'status: active',
            'project: threadnote',
            'topic: relations',
            'memory_id: tn_share_publish_relations',
            'relation: related_to threadnote://memory/tn_1c56a4a00279466aa450ac4db78a1a72',
            'relation: related_to threadnote://user/tester/memories/durable/projects/threadnote/private.md',
            '',
            'Body',
            '',
          ].join('\n'),
        );

        const result = yield* runSharePublishTool(config, sourceUri, {preview: true});
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBeUndefined();
        expect(text).toContain('relation: related_to threadnote://memory/tn_1c56a4a00279466aa450ac4db78a1a72');
        expect(text).toContain(
          'PREVIEW WARNING: relation threadnote://memory/tn_1c56a4a00279466aa450ac4db78a1a72 is not-found in team default.',
        );
        expect(text).not.toContain('private.md');
        expect(yield* fs.exists(sourcePath)).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function citedMemory(sourceDirty: boolean): string {
  const citation = createMemoryCodeCitation({
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
    path: 'src/mcp_server_share.ts',
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: 'c'.repeat(40),
    sourceDirty,
    sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  });
  return formatMemoryDocument(
    'MEMORY',
    {
      codeCitations: [citation],
      kind: 'durable',
      project: 'threadnote',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceAgentClient: 'codex',
      status: 'active',
      timestamp: '2026-08-26T20:00:00.000Z',
      topic: 'policy',
    },
    sourceDirty ? 'The source changed after the initial read.' : 'Initially clean source.',
  );
}
