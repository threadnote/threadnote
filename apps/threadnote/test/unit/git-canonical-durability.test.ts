import {testGitWorktreeLock} from '../helpers/git-worktree-lock.js';
import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {chmod, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {GitCanonicalMemoryStore, gitCanonicalSharePath} from '@threadnote/remote-memory/git/canonical_store';
import {cloneGitShareWorktree, createGitShareWorktreeFixture, git} from '@threadnote/testing/git-share-worktree';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const path = gitCanonicalSharePath('durable', 'fixture', 'durability');
const input = {content: '# MEMORY\n\nMust reach the remote.\n', message: 'fixture durability', path};

async function head(worktree: string): Promise<string> {
  return Effect.pipe(await git(['rev-parse', 'HEAD'], worktree), EffectString.trim);
}

describe('git canonical durability', () => {
  it('keeps rejected commits out of the checkout and ingestion, including same-content retries', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const hook = join(fixture.remote, 'hooks', 'pre-receive');
      await writeFile(hook, '#!/bin/sh\nexit 1\n');
      await chmod(hook, 0o700);
      const before = await head(fixture.worktree);
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(store.commit(input)).rejects.toMatchObject({code: expect.any(String)});
        expect(await head(fixture.worktree)).toBe(before);
        expect(await git(['status', '--porcelain'], fixture.worktree)).toBe('');
        expect(await store.listCanonicalPaths()).toEqual([]);
      }
      await rm(hook);
      const receipt = await store.commit(input);
      expect(await head(fixture.worktree)).toBe(receipt.gitCommit);
      expect(await git(['show', `refs/heads/main:${path}`], fixture.remote)).toBe(input.content);
      expect((await store.commit(input)).gitCommit).toBe(receipt.gitCommit);
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it.each(['staged', 'unstaged', 'untracked', 'local-commit', 'wrong-branch', 'detached'] as const)(
    'preserves an unexpected %s checkout and refuses to write or ingest it',
    async state => {
      const fixture = await createGitShareWorktreeFixture();
      try {
        if (state === 'untracked') await writeFile(join(fixture.worktree, 'untracked.txt'), 'operator work');
        if (['staged', 'unstaged', 'local-commit'].includes(state)) {
          await writeFile(join(fixture.worktree, 'README.md'), 'operator work');
          if (state !== 'unstaged') await git(['add', 'README.md'], fixture.worktree);
          if (state === 'local-commit') await git(['commit', '-m', 'operator work'], fixture.worktree);
        }
        if (state === 'wrong-branch') await git(['checkout', '-b', 'operator'], fixture.worktree);
        if (state === 'detached') await git(['checkout', '--detach'], fixture.worktree);
        const before = {
          head: await head(fixture.worktree),
          status: await git(['status', '--porcelain'], fixture.worktree),
          diff: await git(['diff', 'HEAD'], fixture.worktree),
        };
        const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
        await expect(store.commit(input)).rejects.toMatchObject({code: 'conflict'});
        await expect(store.listCanonicalPaths()).rejects.toMatchObject({code: 'conflict'});
        expect(await head(fixture.worktree)).toBe(before.head);
        expect(await git(['status', '--porcelain'], fixture.worktree)).toBe(before.status);
        expect(await git(['diff', 'HEAD'], fixture.worktree)).toBe(before.diff);
        if (state === 'untracked')
          expect(await readFile(join(fixture.worktree, 'untracked.txt'), 'utf8')).toBe('operator work');
      } finally {
        await rm(fixture.root, {force: true, recursive: true});
      }
    },
  );

  it('refuses a missing upstream branch instead of publishing a new history', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      await git(['update-ref', '-d', 'refs/heads/main'], fixture.remote);
      const before = await head(fixture.worktree);
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      await expect(store.commit(input)).rejects.toMatchObject({code: 'service_unavailable'});
      expect(await head(fixture.worktree)).toBe(before);
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('confirms an accepted push even when the original push command reports failure', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const hook = join(fixture.worktree, '.git', 'hooks', 'pre-push');
      await writeFile(
        hook,
        '#!/bin/sh\nread local_ref local_sha remote_ref remote_sha\ngit -c core.hooksPath=/dev/null push origin "$local_sha:$remote_ref" || exit 2\nexit 1\n',
      );
      await chmod(hook, 0o700);
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      const receipt = await store.commit(input);
      expect(await head(fixture.remote)).toBe(receipt.gitCommit);
      expect(await head(fixture.worktree)).toBe(receipt.gitCommit);
      expect(await store.read({commit: receipt.gitCommit, path})).toBe(input.content);
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('handles a competing push after preparation without resetting local state or losing remote work', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const laptop = await cloneGitShareWorktree(fixture.remote, join(fixture.root, 'laptop'));
      await writeFile(join(laptop, 'README.md'), 'laptop change');
      await git(['add', 'README.md'], laptop);
      await git(['commit', '-m', 'competing laptop commit'], laptop);
      const laptopHead = await head(laptop);
      const hook = join(fixture.worktree, '.git', 'hooks', 'pre-push');
      const quotedLaptop = "'" + Effect.pipe(laptop, EffectString.replaceAll("'", "'\\''")) + "'";
      await writeFile(
        hook,
        `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ngit -C ${quotedLaptop} push origin main\n`,
      );
      await chmod(hook, 0o700);
      const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
      await expect(store.commit(input)).rejects.toMatchObject({
        code: 'conflict',
        details: {reason: 'git_push_rejected'},
      });
      expect(await head(fixture.worktree)).toBe(laptopHead);
      expect(await head(fixture.remote)).toBe(laptopHead);
      expect(await readFile(join(fixture.worktree, 'README.md'), 'utf8')).toBe('laptop change');
      expect(await store.listCanonicalPaths()).toEqual([]);
      await rm(hook);
      await expect(store.commit(input)).resolves.toMatchObject({gitPath: path});
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('keeps explicitly local no-push mode usable for subsequent writes', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const remoteBefore = await head(fixture.remote);
      const store = new GitCanonicalMemoryStore({
        worktreeLock: testGitWorktreeLock,
        push: false,
        worktree: fixture.worktree,
      });
      const first = await store.commit(input);
      const second = await store.commit({
        ...input,
        content: 'local replacement',
        expectedContentHash: first.contentHash,
      });
      expect(await head(fixture.remote)).toBe(remoteBefore);
      expect(await head(fixture.worktree)).toBe(second.gitCommit);
      expect(await store.listCanonicalFiles()).toEqual([expect.objectContaining({content: 'local replacement'})]);
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('preserves arbitrary UTF-8 bodies remotely and makes repeated identical commits idempotent', async () => {
    await FC.assert(
      FC.asyncProperty(FC.string({maxLength: 200}), async content => {
        const fixture = await createGitShareWorktreeFixture();
        try {
          const store = new GitCanonicalMemoryStore({worktreeLock: testGitWorktreeLock, worktree: fixture.worktree});
          const first = await store.commit({...input, content});
          expect(await git(['show', `refs/heads/main:${path}`], fixture.remote)).toBe(content);
          expect(await store.commit({...input, content})).toEqual(first);
          expect(await git(['status', '--porcelain'], fixture.worktree)).toBe('');
        } finally {
          await rm(fixture.root, {force: true, recursive: true});
        }
      }),
      {numRuns: 5},
    );
  }, 30_000);
});
