import {Array as EffectArray, Option as EffectOption} from 'effect';
import {testGitWorktreeLock} from '../helpers/git-worktree-lock.js';
import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {mkdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {dirname, join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  GIT_REF_UPDATE_TIMEOUT_MILLISECONDS,
  GitCanonicalMemoryStore,
  ensureLiveGitShareWorktree,
  gitCanonicalSharePath,
  gitIngestProjectsToEnsure,
  gitRemoteUrlsMatch,
  parseGitCanonicalSharePath,
} from '@threadnote/remote-memory/git/canonical_store';
import {cloneGitShareWorktree, createGitShareWorktreeFixture, git} from '@threadnote/testing/git-share-worktree';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const portableSegment = FC.stringMatching(/^[a-z][a-z0-9-]{0,15}$/u).map(value => `project-${value}`);

describe('git canonical memory store', () => {
  it('checks donor hashes before publication and permits exact recovery when the target is its own donor', async () => {
    const fixture = await createGitShareWorktreeFixture('threadnote-citation-source-cas-');
    try {
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      const path = gitCanonicalSharePath('durable', 'project', 'donor');
      const first = await store.commit({path, content: 'Before.', message: 'seed donor'});
      const input = {
        path,
        content: 'After.',
        message: 'replace self donor',
        expectedContentHash: first.contentHash,
        expectedSourceHashes: [{path, contentHash: first.contentHash}],
      };
      const updated = await store.commit(input);
      expect(await store.commit(input)).toEqual(updated);
      const target = gitCanonicalSharePath('durable', 'project', 'target');
      await expect(
        store.commit({...input, path: target, content: 'Must not publish.', expectedContentHash: undefined}),
      ).rejects.toMatchObject({code: 'conflict', details: {reason: 'citation_source_changed'}});
      expect(await Bun.file(join(fixture.worktree, target)).exists()).toBe(false);
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });

  it('round-trips share path encoding for durable and handoff files', () => {
    FC.assert(
      FC.property(FC.constantFrom('durable', 'handoff'), portableSegment, portableSegment, (kind, project, topic) => {
        const path = gitCanonicalSharePath(kind, project, topic);
        expect(parseGitCanonicalSharePath(path)).toEqual({kind, project, topic});
      }),
    );
  });

  it('rejects malformed git share paths', () => {
    FC.assert(
      FC.property(FC.string({maxLength: 64}), value => {
        expect(
          parseGitCanonicalSharePath(value) === undefined || Effect.pipe(value, EffectString.split('/')).length === 4,
        ).toBe(true);
      }),
    );
    expect(parseGitCanonicalSharePath('')).toBeUndefined();
    expect(parseGitCanonicalSharePath('durable/projects/x')).toBeUndefined();
    expect(parseGitCanonicalSharePath('durable/projects/x/y.txt')).toBeUndefined();
    expect(parseGitCanonicalSharePath('../durable/projects/x/y.md')).toBeUndefined();
  });

  it('catalogs unknown allowed git projects and never un-archives known ones', () => {
    FC.assert(
      FC.property(
        FC.array(portableSegment, {maxLength: 8}),
        FC.array(portableSegment, {maxLength: 8}),
        FC.boolean(),
        (gitProjects, knownProjects, restrict) => {
          const known = new Set(knownProjects);
          const allowed = restrict ? new Set(EffectArray.filter(gitProjects, (_, index) => index % 2 === 0)) : 'all';
          const ensured = gitIngestProjectsToEnsure({
            allowedProjects: allowed,
            gitProjects,
            knownProjects: known,
          });
          expect(ensured).toEqual([...ensured].sort());
          expect(new Set(ensured).size).toBe(ensured.length);
          for (const project of ensured) {
            expect(known.has(project)).toBe(false);
            expect(gitProjects).toContain(project);
            if (allowed !== 'all') expect(allowed.has(project)).toBe(true);
          }
          expect(
            gitIngestProjectsToEnsure({
              allowedProjects: allowed,
              gitProjects,
              knownProjects: new Set([...known, ...ensured]),
            }),
          ).toEqual([]);
        },
      ),
    );
    expect(
      gitIngestProjectsToEnsure({
        allowedProjects: 'all',
        gitProjects: ['beta', 'alpha', 'beta'],
        knownProjects: new Set(),
      }),
    ).toEqual(['alpha', 'beta']);
    expect(
      gitIngestProjectsToEnsure({
        allowedProjects: new Set(['alpha']),
        gitProjects: ['alpha', 'other-project'],
        knownProjects: new Set(),
      }),
    ).toEqual(['alpha']);
    expect(
      gitIngestProjectsToEnsure({
        allowedProjects: 'all',
        gitProjects: ['alpha', 'retired'],
        knownProjects: new Set(['retired']),
      }),
    ).toEqual(['alpha']);
  });

  it('refuses an empty git worktree and clones a live team share instead', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const missing = join(fixture.root, 'missing');
      expect(await ensureLiveGitShareWorktree({cloneUrl: fixture.remote, worktree: missing})).toBe(missing);
      expect(Effect.pipe(await git(['rev-parse', '--verify', 'HEAD'], missing), EffectString.trim)).toMatch(
        /^[0-9a-f]{40}$/u,
      );
      const emptyDir = join(fixture.root, 'empty-dir');
      await mkdir(emptyDir, {recursive: true});
      expect(await ensureLiveGitShareWorktree({cloneUrl: fixture.remote, worktree: emptyDir})).toBe(emptyDir);
      const emptyRepo = join(fixture.root, 'empty-repo');
      await mkdir(emptyRepo, {recursive: true});
      await git(['init'], emptyRepo);
      await expect(ensureLiveGitShareWorktree({cloneUrl: fixture.remote, worktree: emptyRepo})).rejects.toMatchObject({
        message: expect.stringContaining('no commits'),
      });
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      await expect(store.assertLiveShare()).resolves.toBeUndefined();
      await expect(ensureLiveGitShareWorktree({cloneUrl: fixture.remote, worktree: fixture.worktree})).resolves.toBe(
        fixture.worktree,
      );
      const mismatched = join(fixture.root, 'mismatched');
      await cloneGitShareWorktree(fixture.remote, mismatched);
      await git(['remote', 'set-url', 'origin', join(fixture.root, 'other.git')], mismatched);
      await expect(ensureLiveGitShareWorktree({cloneUrl: fixture.remote, worktree: mismatched})).rejects.toMatchObject({
        message: expect.stringContaining('does not match the live team share'),
      });
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('treats ssh, https, and file aliases of the same remote as equal', () => {
    expect(
      gitRemoteUrlsMatch(
        'git@github.com:Kashkovsky/threadnote-share.git',
        'https://github.com/Kashkovsky/threadnote-share.git',
      ),
    ).toBe(true);
    expect(gitRemoteUrlsMatch('file:///tmp/share.git', '/tmp/share.git')).toBe(true);
    expect(gitRemoteUrlsMatch('git@github.com:Kashkovsky/threadnote-share.git', 'git@github.com:other/repo.git')).toBe(
      false,
    );
    FC.assert(
      FC.property(portableSegment, portableSegment, (owner, repo) => {
        const https = `https://github.com/${owner}/${repo}.git`;
        expect(gitRemoteUrlsMatch(`git@github.com:${owner}/${repo}.git`, https)).toBe(true);
        expect(gitRemoteUrlsMatch(`ssh://git@github.com/${owner}/${repo}`, https)).toBe(true);
        expect(gitRemoteUrlsMatch(https, `https://github.com/${owner}/${repo}/`)).toBe(true);
      }),
    );
  });

  it('commits a memory body, hashes it, and reads the same blob back', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      const path = gitCanonicalSharePath('durable', 'threadnote', 'composer-roundtrip');
      const content = '# MEMORY\n\nComposer wrote this body.\n';
      const committed = await store.commit({content, message: 'remember composer-roundtrip', path});
      expect(committed.gitPath).toBe(path);
      expect(committed.contentHash).toBe(sha256HexSync(content));
      expect(committed.gitCommit).toMatch(/^[0-9a-f]{40}$/u);
      expect(await store.read({commit: committed.gitCommit, path})).toBe(content);
      const listed = await store.listCanonicalPaths();
      expect(listed).toEqual([
        expect.objectContaining({
          blobId: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
          gitCommit: committed.gitCommit,
          gitPath: path,
          kind: 'durable',
          project: 'threadnote',
          topic: 'composer-roundtrip',
        }),
      ]);
      const other = gitCanonicalSharePath('durable', 'threadnote', 'composer-sibling');
      await store.commit({content: '# MEMORY\n\nSibling.\n', message: 'remember sibling', path: other});
      const afterSibling = await store.listCanonicalPaths();
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(afterSibling, entry => entry.gitPath === path))?.blobId,
      ).toBe(listed[0]?.blobId);
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(afterSibling, entry => entry.gitPath === path))?.gitCommit,
      ).not.toBe(committed.gitCommit);
      const clone = join(fixture.root, 'laptop');
      await cloneGitShareWorktree(fixture.remote, clone);
      expect(await git(['show', `HEAD:${path}`], clone)).toBe(content);
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('authorizes a local ref update after preflight with the complete merge time budget', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const store = new GitCanonicalMemoryStore({
        worktreeLock: testGitWorktreeLock,
        push: false,
        worktree: fixture.worktree,
      });
      const base = Effect.pipe(await git(['rev-parse', 'HEAD'], fixture.worktree), EffectString.trim);
      let authorizationCalls = 0;
      const committed = await store.commit({
        authorizeRefUpdate: async requiredValidityMilliseconds => {
          authorizationCalls += 1;
          expect(requiredValidityMilliseconds).toBe(GIT_REF_UPDATE_TIMEOUT_MILLISECONDS);
          expect(Effect.pipe(await git(['rev-parse', 'HEAD'], fixture.worktree), EffectString.trim)).toBe(base);
          expect(await git(['status', '--porcelain=v1', '--untracked-files=all'], fixture.worktree)).toBe('');
        },
        content: '# MEMORY\n\nLocally authorized.\n',
        message: 'remember locally authorized',
        path: gitCanonicalSharePath('durable', 'threadnote', 'local-authority'),
      });
      expect(authorizationCalls).toBe(1);
      expect(Effect.pipe(await git(['rev-parse', 'HEAD'], fixture.worktree), EffectString.trim)).toBe(
        committed.gitCommit,
      );
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('rejects a stale expected content hash instead of merging', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const path = gitCanonicalSharePath('durable', 'threadnote', 'cas-conflict');
      const composer = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      const first = await composer.commit({
        content: '# MEMORY\n\nFirst writer.\n',
        message: 'remember first',
        path,
      });
      await expect(
        composer.commit({
          content: '# MEMORY\n\nStale writer.\n',
          expectedContentHash: undefined,
          message: 'remember stale create',
          path,
        }),
      ).rejects.toMatchObject({code: 'conflict', details: {reason: 'git_cas'}});
      await expect(
        composer.commit({
          content: '# MEMORY\n\nStale update.\n',
          expectedContentHash: Effect.pipe('ab', EffectString.repeat(32)),
          message: 'remember stale update',
          path,
        }),
      ).rejects.toMatchObject({code: 'conflict', details: {reason: 'git_cas'}});
      const second = await composer.commit({
        content: '# MEMORY\n\nSecond writer.\n',
        expectedContentHash: first.contentHash,
        message: 'remember second',
        path,
      });
      expect(second.gitCommit).not.toBe(first.gitCommit);
      expect(await composer.read({commit: second.gitCommit, path})).toBe('# MEMORY\n\nSecond writer.\n');
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('reads a known commit without fetching when the remote is unavailable', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const path = gitCanonicalSharePath('durable', 'threadnote', 'offline-read');
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      const committed = await store.commit({
        content: '# MEMORY\n\nReadable without fetch.\n',
        message: 'remember offline-read',
        path,
      });
      await git(['remote', 'remove', 'origin'], fixture.worktree);
      expect(await store.read({commit: committed.gitCommit, path})).toBe('# MEMORY\n\nReadable without fetch.\n');
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('rejects a malformed git commit pointer before invoking git show', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      await expect(
        store.read({
          commit: '--output=/tmp/threadnote-git-show',
          path: gitCanonicalSharePath('durable', 'threadnote', 'unsafe'),
        }),
      ).rejects.toMatchObject({code: 'invalid_request'});
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('commits through a separate-git-dir worktree', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const gitDir = join(fixture.root, 'separated.git');
      const worktree = join(fixture.root, 'separated');
      await git(['clone', '--separate-git-dir', gitDir, '--branch', 'main', '--', fixture.remote, worktree]);
      await git(['config', 'user.email', 'threadnote-test@example.com'], worktree);
      await git(['config', 'user.name', 'Threadnote Test'], worktree);
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree});
      const path = gitCanonicalSharePath('handoff', 'threadnote', 'separated-lock');
      const committed = await store.commit({
        content: '# MEMORY\n\nSeparated git dir.\n',
        message: 'remember separated-lock',
        path,
      });
      expect(await store.read({commit: committed.gitCommit, path})).toBe('# MEMORY\n\nSeparated git dir.\n');
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('surfaces a laptop push as a conflict instead of merging', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const path = gitCanonicalSharePath('durable', 'threadnote', 'interleave');
      const composer = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      const first = await composer.commit({
        content: '# MEMORY\n\nComposer first.\n',
        message: 'remember composer first',
        path,
      });
      const laptop = join(fixture.root, 'laptop');
      await cloneGitShareWorktree(fixture.remote, laptop);
      await git(['checkout', 'main'], laptop);
      const laptopPath = join(laptop, ...Effect.pipe(path, EffectString.split('/')));
      await mkdir(dirname(laptopPath), {recursive: true});
      await writeFile(laptopPath, '# MEMORY\n\nLaptop publish.\n', 'utf8');
      await git(['add', '--', path], laptop);
      await git(['commit', '-m', 'laptop publish'], laptop);
      await git(['push', 'origin', 'main'], laptop);
      await expect(
        composer.commit({
          content: '# MEMORY\n\nComposer second.\n',
          expectedContentHash: first.contentHash,
          message: 'remember composer second',
          path,
        }),
      ).rejects.toMatchObject({code: 'conflict', details: {reason: 'git_cas'}});
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });
});
