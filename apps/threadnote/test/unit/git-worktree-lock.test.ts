import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {publicRemoteMemoryError} from '@threadnote/remote-memory/errors';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {makeGitWorktreeLock, type GitWorktreeLock} from '@threadnote/threadnote/effect/git_worktree_lock';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {gitLockTestLayer} from '../helpers/git-worktree-lock.js';

const attempt = <A>(operation: () => Promise<A>) => Effect.tryPromise({try: operation, catch: publicRemoteMemoryError});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-git-lock-'});
  return {fs, lockPath: path.join(directory, 'threadnote-composer.lock')};
});

describe('scoped Git worktree lock', () => {
  effectIt.effect('acquires when another owner removes the token during preflight', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const {fs, lockPath} = yield* fixture;
          yield* fs.writeFileString(lockPath, 'previous owner');
          let removed = false;
          const contenderFs: FileSystem.FileSystem = {
            ...fs,
            stat: path =>
              path === lockPath && !removed
                ? Effect.gen(function* () {
                    removed = true;
                    yield* fs.remove(path);
                    return yield* fs.stat(path);
                  })
                : fs.stat(path),
          };
          const lock = yield* makeGitWorktreeLock().pipe(Effect.provideService(FileSystem.FileSystem, contenderFs));
          expect(yield* attempt(() => lock(lockPath, () => Promise.resolve('acquired')))).toBe('acquired');
          expect(removed).toBe(true);
          expect(yield* fs.exists(lockPath)).toBe(false);
        }),
      ),
    ).pipe(provideTestLayer(gitLockTestLayer)),
  );

  fcEffectProp(
    effectIt,
    'serializes successful and failed operations in submission order without leaking the token',
    [FC.array(FC.boolean(), {minLength: 1, maxLength: 12})],
    ([failures]) =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const {fs, lockPath} = yield* fixture;
            const lock = yield* makeGitWorktreeLock();
            const entered: number[] = [];
            let active = 0;
            const jobs = EffectArray.map(failures, (fail, index) =>
              lock(lockPath, async () => {
                expect(active++).toBe(0);
                entered.push(index);
                await Promise.resolve();
                active--;
                if (fail) throw new Error('fixture rejection');
                return index;
              }).then(
                value => ({value}),
                () => ({failed: true}),
              ),
            );
            const results = yield* attempt(() => Promise.all(jobs));
            expect(results).toEqual(
              EffectArray.map(failures, (fail, index) => (fail ? {failed: true} : {value: index})),
            );
            expect(entered).toEqual(EffectArray.map(failures, (_, index) => index));
            expect(active).toBe(0);
            expect(yield* fs.exists(lockPath)).toBe(false);
          }),
        ),
      ).pipe(provideTestLayer(gitLockTestLayer)),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect('preserves a dangling symbolic link instead of creating its target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, lockPath} = yield* fixture;
        const target = `${lockPath}.outside`;
        yield* fs.symlink(target, lockPath);
        const lock = yield* makeGitWorktreeLock();
        let entered = false;
        const exit = yield* Effect.exit(
          attempt(() =>
            lock(lockPath, async () => {
              entered = true;
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(entered).toBe(false);
        expect(yield* fs.readLink(lockPath)).toBe(target);
        expect(yield* fs.exists(target)).toBe(false);
      }),
    ).pipe(provideTestLayer(gitLockTestLayer)),
  );

  effectIt.effect('releases the lock before resolving successful and rejected Promise operations', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const {fs, lockPath} = yield* fixture;
          const lock = yield* makeGitWorktreeLock();
          expect(yield* attempt(() => lock(lockPath, () => Promise.resolve(42)))).toBe(42);
          expect(yield* fs.exists(lockPath)).toBe(false);
          const exit = yield* Effect.exit(
            attempt(() => lock(lockPath, () => Promise.reject(new Error('fixture failure')))),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(yield* fs.exists(lockPath)).toBe(false);
          expect(yield* attempt(() => lock(lockPath, () => Promise.resolve('next')))).toBe('next');
        }),
      ),
    ).pipe(provideTestLayer(gitLockTestLayer)),
  );

  effectIt.effect('preserves an ownerless legacy directory and refuses to enter the critical section', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {fs, lockPath} = yield* fixture;
        yield* fs.makeDirectory(lockPath);
        const lock = yield* makeGitWorktreeLock();
        let entered = false;
        const exit = yield* Effect.exit(
          attempt(() =>
            lock(lockPath, async () => {
              entered = true;
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(entered).toBe(false);
        expect((yield* fs.stat(lockPath)).type).toBe('Directory');
      }),
    ).pipe(provideTestLayer(gitLockTestLayer)),
  );

  effectIt.effect('drains active work before releasing, and rejects queued and future calls during shutdown', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const {fs, lockPath} = yield* fixture;
          const opened = yield* Deferred.make<GitWorktreeLock>();
          const started = Promise.withResolvers<void>();
          const finish = Promise.withResolvers<void>();
          let queuedEntered = false;
          const owner = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                const lock = yield* makeGitWorktreeLock();
                yield* Deferred.succeed(opened, lock);
                return yield* Effect.never;
              }),
            ),
          );
          const lock = yield* Deferred.await(opened);
          const active = lock(lockPath, async () => {
            started.resolve();
            await finish.promise;
          });
          void active.catch(() => undefined);
          yield* attempt(() => started.promise);
          const queued = lock(lockPath, async () => {
            queuedEntered = true;
          });
          void queued.catch(() => undefined);
          const interruption = yield* Effect.forkChild(Fiber.interrupt(owner));
          yield* Effect.yieldNow;
          expect(yield* fs.exists(lockPath)).toBe(true);
          finish.resolve();
          yield* Fiber.join(interruption);
          expect(yield* fs.exists(lockPath)).toBe(false);
          expect(queuedEntered).toBe(false);
          expect(Exit.isFailure(yield* Effect.exit(attempt(() => queued)))).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(attempt(() => lock(lockPath, async () => undefined))))).toBe(true);
          yield* attempt(() => active.catch(() => undefined));
        }),
      ),
    ).pipe(provideTestLayer(gitLockTestLayer)),
  );
});
