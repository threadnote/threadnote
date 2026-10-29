import {describe, expect, it} from 'vitest';
import {readFile, rm} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {createGitShareWorktreeFixture, git} from '@threadnote/testing/git-share-worktree';
import {testGitWorktreeLock} from '../helpers/git-worktree-lock.js';
import {GitCanonicalMemoryStore} from '@threadnote/remote-memory/git/canonical_store';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const path = 'durable/projects/fixture/crash-recovery.md';

describe('Git worktree lock process boundary', () => {
  it('recovers a freshly killed owner and confirms the next commit upstream', async () => {
    const fixture = await createGitShareWorktreeFixture();
    const lockPath = join(fixture.worktree, '.git', 'threadnote-composer.lock');
    const moduleUrl = new URL('../../src/effect/git_worktree_lock.ts', import.meta.url).href;
    const systemLayerUrl = new URL('../helpers/system-layer.ts', import.meta.url).href;
    const script = `
      import {Effect, Layer} from 'effect';
      import * as BunServices from '@effect/platform-bun/BunServices';
      import * as BunRuntime from '@effect/platform-bun/BunRuntime';
      import {makeGitWorktreeLock} from ${JSON.stringify(moduleUrl)};
      import {TestSystemInfoLayer} from ${JSON.stringify(systemLayerUrl)};
      BunRuntime.runMain(Effect.scoped(Effect.gen(function* () {
        const lock = yield* makeGitWorktreeLock();
        yield* Effect.promise(() => lock(${JSON.stringify(lockPath)}, () => {
          process.stdout.write('locked');
          return new Promise(() => {});
        }));
      })).pipe(Effect.provide(Layer.merge(TestSystemInfoLayer, BunServices.layer))));
    `;
    const child = Bun.spawn({cmd: [process.execPath, '--eval', script], stdout: 'pipe', stderr: 'pipe'});
    const stderr = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe('locked');
      const ownerProcessId = readLockOwnerProcessId(await readFile(lockPath, 'utf8'));
      expect(ownerProcessId).toBe(child.pid);
      child.kill('SIGKILL');
      await child.exited;
      const store = new GitCanonicalMemoryStore({worktree: fixture.worktree, worktreeLock: testGitWorktreeLock});
      const receipt = await store.commit({path, content: 'Recovered after a killed owner.', message: 'crash recovery'});
      expect(Effect.pipe(await git(['rev-parse', 'HEAD'], fixture.remote), EffectString.trim)).toBe(receipt.gitCommit);
      expect(await Bun.file(lockPath).exists()).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      reader.releaseLock();
      await stderr;
      await rm(fixture.root, {recursive: true, force: true});
    }
  });

  it('serializes independent service scopes without stealing a live owner', async () => {
    const fixture = await createGitShareWorktreeFixture();
    const lockPath = join(fixture.worktree, '.git', 'threadnote-composer.lock');
    let active = 0;
    try {
      const results = await Promise.all(
        Array.from({length: 6}, (_, index) =>
          testGitWorktreeLock(lockPath, async () => {
            expect(active++).toBe(0);
            const before = await readFile(lockPath, 'utf8');
            await git(['status', '--porcelain'], fixture.worktree);
            expect(await readFile(lockPath, 'utf8')).toBe(before);
            active--;
            return index;
          }),
        ),
      );
      expect(results).toEqual([0, 1, 2, 3, 4, 5]);
      expect(active).toBe(0);
      expect(await Bun.file(lockPath).exists()).toBe(false);
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });

  it('fails closed for mutating paths when no service lock was supplied', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const store = new GitCanonicalMemoryStore({worktree: fixture.worktree});
      await store.assertReady();
      for (const operation of [
        () => store.refresh(),
        () => store.listCanonicalPaths(),
        () => store.commit({path, content: 'Missing lock must fail.', message: 'fixture'}),
        () => store.read({path, commit: Effect.pipe('f', EffectString.repeat(40))}),
      ])
        await expect(operation()).rejects.toMatchObject({code: 'service_unavailable'});
      expect(await git(['status', '--porcelain'], fixture.worktree)).toBe('');
    } finally {
      await rm(fixture.root, {recursive: true, force: true});
    }
  });
});

function readLockOwnerProcessId(text: string): number {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || !('processId' in value) || typeof value.processId !== 'number') {
    throw new Error('The Git worktree lock did not contain a numeric owner process ID.');
  }
  return value.processId;
}
