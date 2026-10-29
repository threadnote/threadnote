import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {remoteMemoryConfigFromEnvironment, redactedRemoteMemoryConfig} from '@threadnote/remote-memory/config';
import {GitCanonicalMemoryStore, ensureLiveGitShareWorktree} from '@threadnote/remote-memory/git/canonical_store';
import {testGitWorktreeLock} from '../helpers/git-worktree-lock.js';
import {createGitShareWorktreeFixture, git} from '@threadnote/testing/git-share-worktree';
import {mkdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const environment = {
  THREADNOTE_REMOTE_PUBLIC_URL: 'https://memory.example.test',
  THREADNOTE_REMOTE_OAUTH_ISSUER: 'https://identity.example.test/',
  THREADNOTE_REMOTE_DATABASE_URL: 'postgresql://runtime@db.example.test/org?sslmode=verify-full',
  THREADNOTE_REMOTE_CANONICAL_STORE: 'git',
  THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE: '/data/memory-git',
  THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID: 'org',
  THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID: 'default',
};

describe('production Git bootstrap', () => {
  it('preserves accepted credential-free SSH/HTTPS clone URLs without exposing them in diagnostics', () => {
    FC.assert(
      FC.property(FC.stringMatching(/^[a-z][a-z0-9-]{0,15}$/u), owner => {
        for (const remote of [
          `git@github.com:${owner}/share.git`,
          `ssh://git@github.com/${owner}/share.git`,
          `https://github.com/${owner}/share.git`,
        ]) {
          const config = remoteMemoryConfigFromEnvironment({
            ...environment,
            THREADNOTE_REMOTE_MEMORY_GIT_CLONE_URL: remote,
          });
          expect(config.gitCloneUrl).toBe(remote);
          expect(redactedRemoteMemoryConfig(config)).not.toHaveProperty('gitCloneUrl');
        }
      }),
      {numRuns: 32},
    );
  });

  it.each([
    '/tmp/repo.git',
    'file:///tmp/repo.git',
    'http://github.com/org/repo.git',
    'https://token@github.com/org/repo.git',
    'https://github.com/org/repo.git?token=secret',
    'ssh://git:secret@github.com/org/repo.git',
    'ext::sh -c anything',
    'git@github.com:org/repo.git\nother',
    'ssh://git@github.com/org/repo.git#fragment',
  ])('rejects unsafe public clone URL %s', remote => {
    expect(() =>
      remoteMemoryConfigFromEnvironment({...environment, THREADNOTE_REMOTE_MEMORY_GIT_CLONE_URL: remote}),
    ).toThrow('clone URL');
  });

  it('permits an absolute fixture remote only for a localhost service', () => {
    const config = remoteMemoryConfigFromEnvironment({
      ...environment,
      THREADNOTE_REMOTE_PUBLIC_URL: 'http://localhost:8787',
      THREADNOTE_REMOTE_MEMORY_GIT_CLONE_URL: '/tmp/fixture.git',
    });
    expect(config.gitCloneUrl).toBe('/tmp/fixture.git');
  });

  it('clones using the configured remote name and preserves the exact destination', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const worktree = join(fixture.root, 'bootstrap');
      await ensureLiveGitShareWorktree({
        cloneUrl: fixture.remote,
        worktree,
        remoteName: 'team',
        requireExactRemote: true,
      });
      const store = new GitCanonicalMemoryStore({
        worktree,
        remote: 'team',
        expectedRemoteUrl: fixture.remote,
        worktreeLock: testGitWorktreeLock,
      });
      await store.refresh();
      expect(Effect.pipe(await git(['remote', 'get-url', '--push', 'team'], worktree), EffectString.trim)).toBe(
        fixture.remote,
      );
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });

  it.each(['pushurl', 'extra-pushurl', 'fetchurl', 'rewrite'])(
    'rejects changed %s before fetching or writing',
    async change => {
      const fixture = await createGitShareWorktreeFixture();
      try {
        const store = new GitCanonicalMemoryStore({
          worktree: fixture.worktree,
          expectedRemoteUrl: fixture.remote,
          worktreeLock: testGitWorktreeLock,
        });
        const before = Effect.pipe(await git(['rev-parse', 'HEAD'], fixture.worktree), EffectString.trim);
        if (change === 'extra-pushurl')
          await git(['config', '--add', 'remote.origin.pushurl', fixture.remote], fixture.worktree);
        if (change === 'rewrite')
          await git(['config', `url.${join(fixture.root, 'other.git')}.insteadOf`, fixture.remote], fixture.worktree);
        else
          await git(
            [
              'config',
              '--add',
              change === 'fetchurl' ? 'remote.origin.url' : 'remote.origin.pushurl',
              join(fixture.root, 'other.git'),
            ],
            fixture.worktree,
          );
        await expect(store.refresh()).rejects.toThrow('exact configured');
        await expect(
          store.commit({path: 'durable/projects/test/canary.md', content: 'safe canary', message: 'canary'}),
        ).rejects.toThrow('exact configured');
        expect(Effect.pipe(await git(['rev-parse', 'HEAD'], fixture.worktree), EffectString.trim)).toBe(before);
      } finally {
        await rm(fixture.root, {recursive: true, force: true});
      }
    },
  );

  it('preserves an interrupted nonempty clone for operator recovery', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const worktree = join(fixture.root, 'interrupted');
      await mkdir(worktree);
      await writeFile(join(worktree, 'partial'), 'preserve this state', 'utf8');
      await expect(
        ensureLiveGitShareWorktree({cloneUrl: fixture.remote, worktree, requireExactRemote: true}),
      ).rejects.toThrow('not a git worktree');
      expect(await Bun.file(join(worktree, 'partial')).text()).toBe('preserve this state');
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });

  it('preserves dirty existing worktrees when startup refresh fails', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      await writeFile(join(fixture.worktree, 'unknown.txt'), 'uncommitted state', 'utf8');
      await ensureLiveGitShareWorktree({
        cloneUrl: fixture.remote,
        worktree: fixture.worktree,
        requireExactRemote: true,
      });
      const store = new GitCanonicalMemoryStore({
        worktree: fixture.worktree,
        expectedRemoteUrl: fixture.remote,
        worktreeLock: testGitWorktreeLock,
      });
      await expect(store.refresh()).rejects.toMatchObject({details: {reason: 'git_dirty_worktree'}});
      expect(await Bun.file(join(fixture.worktree, 'unknown.txt')).text()).toBe('uncommitted state');
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });
});
