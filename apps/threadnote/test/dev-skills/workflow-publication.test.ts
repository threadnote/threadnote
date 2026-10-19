import {it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  prepareCursorCloudSharedMemory,
  resourceStoreLocation,
  writeCursorCloudSharedMemory,
  type WriteDurableMemoryParams,
} from '../../src/mcp/server/memory.js';
import {
  publishShareGitChangeVerified,
  writeSharedWorktreeFile,
  type ShareGitCommitReceipt,
} from '../../src/share/git.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {ShareOperationError} from '../../src/share/core.js';

const fixture = Effect.fn('test.workflowPublicationFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-workflow-publish-'});
  const remote = path.join(home, 'remote.git');
  const worktree = path.join(home, 'shared');
  const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
  yield* git(home, ['init', '--bare', '--initial-branch=main', remote]);
  yield* git(home, ['clone', remote, worktree]);
  yield* git(worktree, ['config', 'user.email', 'test@example.invalid']);
  yield* git(worktree, ['config', 'user.name', 'Workflow Test']);
  yield* fs.writeFileString(path.join(worktree, 'README.md'), 'Fixture\n');
  yield* git(worktree, ['add', 'README.md']);
  yield* git(worktree, ['commit', '-m', 'seed']);
  yield* git(worktree, ['push', 'origin', 'main']);
  yield* fs.makeDirectory(path.join(home, 'share'));
  yield* fs.writeFileString(
    path.join(home, 'share', 'teams.json'),
    JSON.stringify({
      version: 1,
      defaultTeam: 'default',
      teams: {default: {name: 'default', access: 'read-write', remote, worktree, gitdir: path.join(worktree, '.git')}},
    }),
  );
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  const scope = {team: 'default', root: 'threadnote://user/tester/memories/shared/default'};
  const params: WriteDurableMemoryParams = {
    operation: 'create',
    bodyText: 'Approved architecture — 仕様.',
    metadata: {
      kind: 'durable',
      status: 'active',
      project: 'fixture',
      topic: 'architecture',
      memoryId: 'tn_workflow_owned',
      sourceAgentClient: 'test',
      timestamp: '2026-10-20T00:00:00.000Z',
    },
  };
  return {fs, path, home, remote, worktree, git, config, scope, params};
});

describe('personal workflow publication', () => {
  it.effect('recovers a fixed native and worktree postimage before its first commit', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const prepared = yield* prepareCursorCloudSharedMemory(f.config, f.scope, f.params);
      const relativePath = prepared.memoryUri.split('/shared/default/')[1];
      const store = yield* ResourceStore;
      yield* store.write(resourceStoreLocation(f.config), prepared.memoryUri, prepared.memory, {mode: 'create'});
      yield* writeSharedWorktreeFile(f.worktree, relativePath, prepared.memory);
      const result = yield* writeCursorCloudSharedMemory(f.config, f.scope, {
        ...f.params,
        sharedPublication: {prepared, expectedRemote: f.remote, expectedBranch: 'main', resume: true},
      });
      expect(result.isError).not.toBe(true);
      expect((yield* f.git(f.remote, ['show', `main:${relativePath}`])).stdout).toBe(prepared.memory);
      expect((yield* f.git(f.worktree, ['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('2');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('preserves an account-level concurrent replacement between validation and mutation', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const initial = yield* prepareCursorCloudSharedMemory(f.config, f.scope, f.params);
      expect((yield* writeCursorCloudSharedMemory(f.config, f.scope, f.params)).isError).not.toBe(true);
      const store = yield* ResourceStore;
      const concurrent = initial.memory.replace(f.params.bodyText, 'Concurrent accepted edit');
      const intercepted = ResourceStore.of({
        ...store,
        writeChecked: (location, uri, content, options, check) =>
          store
            .write(location, uri, concurrent, {mode: 'replace'})
            .pipe(Effect.andThen(store.writeChecked(location, uri, content, options, check))),
      });
      const result = yield* writeCursorCloudSharedMemory(f.config, f.scope, {
        ...f.params,
        operation: 'replace',
        replaceUri: initial.memoryUri,
        bodyText: 'Our stale replacement',
        expectedReplaceContent: initial.memory,
      }).pipe(Effect.provideService(ResourceStore, intercepted));
      expect(result.isError).toBe(true);
      expect(yield* store.read(resourceStoreLocation(f.config), initial.memoryUri)).toBe(concurrent);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects staged third content before creating a native document', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const prepared = yield* prepareCursorCloudSharedMemory(f.config, f.scope, f.params);
      const relativePath = prepared.memoryUri.split('/shared/default/')[1];
      yield* writeSharedWorktreeFile(f.worktree, relativePath, 'Concurrent staged edit');
      yield* f.git(f.worktree, ['add', relativePath]);
      yield* writeSharedWorktreeFile(f.worktree, relativePath, prepared.memory);
      const result = yield* writeCursorCloudSharedMemory(f.config, f.scope, {
        ...f.params,
        sharedPublication: {prepared, expectedRemote: f.remote, expectedBranch: 'main', resume: true},
      });
      expect(result.isError).toBe(true);
      const store = yield* ResourceStore;
      const missing = yield* store.read(resourceStoreLocation(f.config), prepared.memoryUri).pipe(Effect.result);
      expect(missing._tag).toBe('Failure');
      expect((yield* f.git(f.worktree, ['show', `:${relativePath}`])).stdout).toBe('Concurrent staged edit');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('recovers the exact committed document after callback and push response loss', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const relativePath = 'durable/projects/fixture/architecture.md';
      const content = 'Exact approved content — 仕様.\n';
      yield* writeSharedWorktreeFile(f.worktree, relativePath, content);
      const options = {content, expectedRemote: f.remote, expectedBranch: 'main'};
      let committed: ShareGitCommitReceipt | undefined;
      const failed = yield* publishShareGitChangeVerified(f.worktree, relativePath, 'publish', {
        ...options,
        onCommitted: receipt => {
          committed = receipt;
          return Effect.fail(ShareOperationError.make({message: 'lost callback response'}));
        },
      }).pipe(Effect.result);
      expect(failed._tag).toBe('Failure');
      expect(committed).toBeDefined();
      const before = (yield* f.git(f.worktree, ['rev-list', '--count', 'HEAD'])).stdout;
      const receipt = yield* publishShareGitChangeVerified(f.worktree, relativePath, 'retry', {...options, committed});
      const replay = yield* publishShareGitChangeVerified(f.worktree, relativePath, 'lost response retry', {
        ...options,
        committed,
      });
      expect(replay).toEqual(receipt);
      expect(receipt.contentHash).toBe(sha256HexSync(content));
      expect((yield* f.git(f.remote, ['show', `main:${relativePath}`])).stdout).toBe(content);
      expect((yield* f.git(f.worktree, ['rev-list', '--count', 'HEAD'])).stdout).toBe(before);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('keeps a rejected push retryable without creating another commit', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const prepared = yield* prepareCursorCloudSharedMemory(f.config, f.scope, f.params);
      const hook = f.path.join(f.remote, 'hooks', 'pre-receive');
      yield* f.fs.writeFileString(hook, '#!/bin/sh\nexit 1\n', {mode: 0o700});
      let committed: ShareGitCommitReceipt | undefined;
      const sharedPublication = {
        prepared,
        expectedRemote: f.remote,
        expectedBranch: 'main',
        onCommitted: (receipt: ShareGitCommitReceipt) =>
          Effect.sync(() => {
            committed = receipt;
          }),
      };
      const failed = yield* writeCursorCloudSharedMemory(f.config, f.scope, {...f.params, sharedPublication});
      expect(failed.isError).toBe(true);
      expect(committed).toBeDefined();
      const store = yield* ResourceStore;
      expect(yield* store.read(resourceStoreLocation(f.config), prepared.memoryUri)).toBe(prepared.memory);
      const before = (yield* f.git(f.worktree, ['rev-list', '--count', 'HEAD'])).stdout;
      yield* f.fs.remove(hook);
      const resumed = yield* writeCursorCloudSharedMemory(f.config, f.scope, {
        ...f.params,
        sharedPublication: {...sharedPublication, committed, resume: true},
      });
      expect(resumed.isError).not.toBe(true);
      expect(resumed.structuredContent).toMatchObject({publication: {commit: committed!.commit, verified: true}});
      expect((yield* f.git(f.worktree, ['rev-list', '--count', 'HEAD'])).stdout).toBe(before);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('enforces native create, replacement hash and identity before mutation', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const prepared = yield* prepareCursorCloudSharedMemory(f.config, f.scope, f.params);
      const created = yield* writeCursorCloudSharedMemory(f.config, f.scope, f.params);
      expect(created.isError).not.toBe(true);
      const duplicate = yield* writeCursorCloudSharedMemory(f.config, f.scope, f.params);
      expect(duplicate.isError).toBe(true);
      const replacement = {
        ...f.params,
        operation: 'replace' as const,
        replaceUri: prepared.memoryUri,
        bodyText: 'Replacement',
      };
      const wrongHash = yield* writeCursorCloudSharedMemory(f.config, f.scope, {
        ...replacement,
        expectedReplaceContentHash: '0'.repeat(64),
      });
      const wrongIdentity = yield* writeCursorCloudSharedMemory(f.config, f.scope, {
        ...replacement,
        expectedReplaceMemoryId: 'tn_other_owner',
      });
      expect(wrongHash.isError).toBe(true);
      expect(wrongIdentity.isError).toBe(true);
      const store = yield* ResourceStore;
      expect(yield* store.read(resourceStoreLocation(f.config), prepared.memoryUri)).toBe(prepared.memory);
      const update = {
        ...replacement,
        expectedReplaceContent: prepared.memory,
        expectedReplaceMemoryId: 'tn_workflow_owned',
        expectedReplaceContentHash: sha256HexSync(canonicalMemoryDocumentContent(prepared.memory)),
      };
      const next = yield* prepareCursorCloudSharedMemory(f.config, f.scope, update);
      const updated = yield* writeCursorCloudSharedMemory(f.config, f.scope, {
        ...update,
        sharedPublication: {prepared: next, expectedRemote: f.remote, expectedBranch: 'main'},
      });
      expect(updated.isError).not.toBe(true);
      expect(yield* store.read(resourceStoreLocation(f.config), next.memoryUri)).toBe(next.memory);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('resumes native-only and worktree postimages but refuses third content or changed binding', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const prepared = yield* prepareCursorCloudSharedMemory(f.config, f.scope, f.params);
      const store = yield* ResourceStore;
      yield* store.write(resourceStoreLocation(f.config), prepared.memoryUri, prepared.memory, {mode: 'create'});
      const sharedPublication = {prepared, expectedRemote: f.remote, expectedBranch: 'main', resume: true};
      // Simulate a crash immediately after the native write.
      const result = yield* writeCursorCloudSharedMemory(f.config, f.scope, {...f.params, sharedPublication});
      expect(result.isError).not.toBe(true);
      const relativePath = (result.structuredContent as {publication: {path: string}}).publication.path;
      yield* f.fs.writeFileString(f.path.join(f.worktree, relativePath), 'Concurrent worktree edit');
      const conflict = yield* writeCursorCloudSharedMemory(f.config, f.scope, {...f.params, sharedPublication});
      expect(conflict.isError).toBe(true);
      expect(yield* f.fs.readFileString(f.path.join(f.worktree, relativePath))).toBe('Concurrent worktree edit');
      yield* f.git(f.worktree, ['remote', 'set-url', 'origin', f.remote + '-changed']);
      const changed = yield* writeCursorCloudSharedMemory(f.config, f.scope, {...f.params, sharedPublication});
      expect(changed.isError).toBe(true);
      expect(yield* store.read(resourceStoreLocation(f.config), prepared.memoryUri)).toBe(prepared.memory);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('does not confuse commit reachability with current remote document readback', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const relativePath = 'durable/projects/fixture/architecture.md';
      const content = 'Approved\n';
      yield* writeSharedWorktreeFile(f.worktree, relativePath, content);
      const options = {content, expectedRemote: f.remote, expectedBranch: 'main'};
      const receipt = yield* publishShareGitChangeVerified(f.worktree, relativePath, 'publish', options);
      yield* f.fs.writeFileString(f.path.join(f.worktree, relativePath), 'New remote content\n');
      yield* f.git(f.worktree, ['add', relativePath]);
      yield* f.git(f.worktree, ['commit', '-m', 'concurrent update']);
      yield* f.git(f.worktree, ['push', 'origin', 'main']);
      yield* f.git(f.worktree, ['reset', '--hard', receipt.commit]);
      const result = yield* publishShareGitChangeVerified(f.worktree, relativePath, 'retry', {
        ...options,
        committed: receipt,
      }).pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      expect((yield* f.git(f.remote, ['show', `main:${relativePath}`])).stdout).toBe('New remote content\n');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('refuses foreign unpublished ancestors without discarding their commits', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const remoteBefore = (yield* f.git(f.remote, ['rev-parse', 'main'])).stdout.trim();
      yield* f.fs.writeFileString(f.path.join(f.worktree, 'README.md'), 'Unapproved pending change\n');
      yield* f.git(f.worktree, ['add', 'README.md']);
      yield* f.git(f.worktree, ['commit', '-m', 'foreign pending change']);
      const foreignCommit = (yield* f.git(f.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      const path = 'durable/projects/fixture/approved.md';
      const content = 'Approved document\n';
      yield* writeSharedWorktreeFile(f.worktree, path, content);
      let committed: ShareGitCommitReceipt | undefined;
      const result = yield* publishShareGitChangeVerified(f.worktree, path, 'approved document', {
        content,
        expectedRemote: f.remote,
        expectedBranch: 'main',
        onCommitted: receipt =>
          Effect.sync(() => {
            committed = receipt;
          }),
      }).pipe(Effect.result);
      expect(result).toMatchObject({_tag: 'Failure'});
      expect(committed).toBeDefined();
      expect((yield* f.git(f.remote, ['rev-parse', 'main'])).stdout.trim()).toBe(remoteBefore);
      expect((yield* f.git(f.worktree, ['show', `${foreignCommit}:README.md`])).stdout).toBe(
        'Unapproved pending change\n',
      );
      expect((yield* f.git(f.worktree, ['show', `${committed!.commit}:${path}`])).stdout).toBe(content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it.effect('refuses an unpublished no-op receipt whose commit also changes unapproved paths', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const remoteBefore = (yield* f.git(f.remote, ['rev-parse', 'main'])).stdout.trim();
      const path = 'durable/projects/fixture/approved.md';
      const content = 'Approved document\n';
      yield* writeSharedWorktreeFile(f.worktree, path, content);
      yield* f.fs.writeFileString(f.path.join(f.worktree, 'README.md'), 'Unapproved companion change\n');
      yield* f.git(f.worktree, ['add', path, 'README.md']);
      yield* f.git(f.worktree, ['commit', '-m', 'mixed pending change']);
      const head = (yield* f.git(f.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      const result = yield* publishShareGitChangeVerified(f.worktree, path, 'adopt existing document', {
        content,
        expectedRemote: f.remote,
        expectedBranch: 'main',
      }).pipe(Effect.result);
      expect(result).toMatchObject({_tag: 'Failure'});
      expect((yield* f.git(f.remote, ['rev-parse', 'main'])).stdout.trim()).toBe(remoteBefore);
      expect((yield* f.git(f.worktree, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
      expect((yield* f.git(f.worktree, ['show', `${head}:README.md`])).stdout).toBe('Unapproved companion change\n');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
