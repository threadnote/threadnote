import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {succeedUndefined} from '@threadnote/platform/optional';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Deferred, Effect, Exit, Fiber, FileSystem, Layer, PlatformError, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {FileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {join, mkdir, mkdtemp, rm, utimes, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect as run} from '../helpers/effect-runtime.js';

const stableFileReadFailure = vi.hoisted(() => ({
  failuresObserved: 0,
  failuresRemaining: 0,
}));

vi.mock('@threadnote/platform/system', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/platform/system')>();
  return {
    ...actual,
    runtimeReadBoundedStableRegularFile: (
      ...arguments_: Parameters<typeof actual.runtimeReadBoundedStableRegularFile>
    ) => {
      if (stableFileReadFailure.failuresRemaining > 0) {
        stableFileReadFailure.failuresRemaining -= 1;
        stableFileReadFailure.failuresObserved += 1;
        return Promise.reject(new Error('Target changed during bounded read.'));
      }
      return actual.runtimeReadBoundedStableRegularFile(...arguments_);
    },
  };
});

const TEST_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 5,
  retryIntervalMilliseconds: 2,
  staleAfterMilliseconds: 20,
  waitTimeoutMilliseconds: 500,
} as const;
const FILE_LOCK_TEST_LAYER = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));

describe('Effect file lock', () => {
  let directory: string;
  let lockPath: string;

  beforeEach(async () => {
    directory = await mkdtemp('threadnote-file-lock-');
    lockPath = join(directory, 'locks', 'test.lock');
  });

  afterEach(async () => {
    stableFileReadFailure.failuresObserved = 0;
    stableFileReadFailure.failuresRemaining = 0;
    await rm(directory, {force: true, recursive: true});
  });

  effectIt.effect('refreshes a live lease and keeps concurrent critical sections serialized', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const acquired = yield* Deferred.make<void>();
        const trace: string[] = [];
        const first = withExclusiveFileLock(
          fs,
          lockPath,
          TEST_LOCK_OPTIONS,
          Effect.gen(function* () {
            yield* Effect.sync(() => trace.push('first:start'));
            yield* Deferred.succeed(acquired, undefined);
            yield* Effect.sleep(75);
            yield* Effect.sync(() => trace.push('first:end'));
          }),
        );
        const firstFiber = yield* first.pipe(Effect.forkChild({startImmediately: true}));
        yield* Deferred.await(acquired);
        const secondFiber = yield* withExclusiveFileLock(
          fs,
          lockPath,
          TEST_LOCK_OPTIONS,
          Effect.sync(() => trace.push('second:start', 'second:end')),
        ).pipe(Effect.forkChild({startImmediately: true}));
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);

        expect(trace).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
      }).pipe(provideTestLayer(FILE_LOCK_TEST_LAYER)),
    ),
  );

  effectIt.effect('releases an atomically written token when acquisition is interrupted', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tokenWritten = yield* Deferred.make<void>();
        const blockAfterWrite = yield* Deferred.make<void>();
        const blockedFs = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (path, content, options) =>
            fs.writeFileString(path, content, options).pipe(
              Effect.tap(() => (path === lockPath ? Deferred.succeed(tokenWritten, undefined) : Effect.void)),
              Effect.andThen(path === lockPath ? Deferred.await(blockAfterWrite) : Effect.void),
            ),
        });
        const interruptedFiber = yield* withExclusiveFileLock(
          blockedFs,
          lockPath,
          TEST_LOCK_OPTIONS,
          Effect.never,
        ).pipe(Effect.forkChild({startImmediately: true}));

        yield* Deferred.await(tokenWritten);
        const interruptCompleted = yield* Fiber.interrupt(interruptedFiber).pipe(Effect.as(true));
        expect(interruptCompleted).toBe(true);
        expect(yield* fs.exists(lockPath)).toBe(false);

        const reacquired = yield* withExclusiveFileLock(fs, lockPath, TEST_LOCK_OPTIONS, Effect.succeed('reacquired'));
        expect(reacquired).toBe('reacquired');
        expect(yield* fs.exists(lockPath)).toBe(false);
      }).pipe(provideTestLayer(FILE_LOCK_TEST_LAYER)),
    ),
  );

  effectIt.effect('retries one transient stable-token read failure while releasing its own lock', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const released = yield* withExclusiveFileLock(
          fs,
          lockPath,
          {...TEST_LOCK_OPTIONS, heartbeatIntervalMilliseconds: 60_000},
          Effect.sync(() => {
            stableFileReadFailure.failuresRemaining = 1;
            return 'released';
          }),
        );

        expect(released).toBe('released');
        expect(stableFileReadFailure).toEqual({failuresObserved: 1, failuresRemaining: 0});
        expect(yield* fs.exists(lockPath)).toBe(false);

        const reacquired = yield* withExclusiveFileLock(
          fs,
          lockPath,
          {...TEST_LOCK_OPTIONS, heartbeatIntervalMilliseconds: 60_000},
          Effect.succeed('reacquired'),
        );
        expect(reacquired).toBe('reacquired');
        expect(yield* fs.exists(lockPath)).toBe(false);
      }).pipe(provideTestLayer(FILE_LOCK_TEST_LAYER)),
    ),
  );

  effectIt.effect('keeps Windows sharing-shaped failures fail-fast unless the caller opts into bounded retries', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const system = yield* SystemInfo;
      let attempts = 0;
      const failedFs = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (path, content, options) =>
          path === lockPath
            ? Effect.sync(() => {
                attempts += 1;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: 'PermissionDenied',
                      cause: {code: 'EACCES'},
                      method: 'writeFileString',
                      module: 'FileSystem',
                      pathOrDescriptor: path,
                    }),
                  ),
                ),
              )
            : fs.writeFileString(path, content, options),
      });
      const failed = yield* Effect.exit(
        withExclusiveFileLock(failedFs, lockPath, TEST_LOCK_OPTIONS, Effect.void).pipe(
          Effect.provideService(SystemInfo, SystemInfo.of({...system, platform: 'win32'})),
        ),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      expect(attempts).toBe(1);
    }).pipe(provideTestLayer(FILE_LOCK_TEST_LAYER)),
  );

  it('reports lock contention with a typed timeout', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, `${process.pid}:live-owner\n`, {mode: 0o600});

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* withExclusiveFileLock(
            fs,
            lockPath,
            {...TEST_LOCK_OPTIONS, waitTimeoutMilliseconds: 10},
            Effect.void,
          );
        }),
      ),
    ).rejects.toBeInstanceOf(FileLockTimeout);
  });

  it('recovers a stale lock only when its recorded owner is not alive', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* withExclusiveFileLock(fs, lockPath, TEST_LOCK_OPTIONS, Effect.succeed('acquired'));
        }),
      ),
    ).resolves.toBe('acquired');
  });

  it('recovers a fresh lock immediately when its recorded owner is no longer alive', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* withExclusiveFileLock(fs, lockPath, TEST_LOCK_OPTIONS, Effect.succeed('acquired'));
        }),
      ),
    ).resolves.toBe('acquired');
  });

  it('recovers a lock when the owner PID was reused by a different process instance', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(
      lockPath,
      `${JSON.stringify({
        processId: process.pid,
        processStartIdentity: 'original-process',
        token: 'orphaned-lock',
        version: 1,
      })}\n`,
      {mode: 0o600},
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const system = yield* SystemInfo;
          return yield* withExclusiveFileLock(fs, lockPath, TEST_LOCK_OPTIONS, Effect.succeed('acquired')).pipe(
            Effect.provideService(
              SystemInfo,
              SystemInfo.of({
                ...system,
                isProcessRunning: () => true,
                processStartIdentity: () => Effect.succeed('replacement-process'),
              }),
            ),
          );
        }),
      ),
    ).resolves.toBe('acquired');
  });

  it('can recover a fresh PID-reused lock immediately only for an opted-in reconciler', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(
      lockPath,
      `${JSON.stringify({
        processId: process.pid,
        processStartIdentity: 'original-process',
        token: 'orphaned-lock',
        version: 1,
      })}\n`,
      {mode: 0o600},
    );

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const system = yield* SystemInfo;
          return yield* withExclusiveFileLock(
            fs,
            lockPath,
            {...TEST_LOCK_OPTIONS, recoverReusedProcessIdImmediately: true},
            Effect.succeed('acquired'),
          ).pipe(
            Effect.provideService(
              SystemInfo,
              SystemInfo.of({
                ...system,
                isProcessRunning: () => true,
                processStartIdentity: () => Effect.succeed('replacement-process'),
              }),
            ),
          );
        }),
      ),
    ).resolves.toBe('acquired');
  });

  effectIt.effect('preserves a fresh canonical lock when the immediate owner identity still matches', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(join(lockPath, '..'), {recursive: true});
        yield* fs.writeFileString(
          lockPath,
          `${JSON.stringify({
            processId: process.pid,
            processStartIdentity: 'darwin-v2:canonical-owner',
            token: 'live-canonical-lock',
            version: 1,
          })}\n`,
          {mode: 0o600},
        );
        const system = yield* SystemInfo;
        let canonicalLookups = 0;
        let legacyLookups = 0;
        const outcome = yield* withExclusiveFileLock(
          fs,
          lockPath,
          {
            ...TEST_LOCK_OPTIONS,
            recoverReusedProcessIdImmediately: true,
            useCanonicalProcessStartIdentity: true,
            waitTimeoutMilliseconds: 10,
          },
          Effect.succeed('acquired'),
        ).pipe(
          Effect.provideService(
            SystemInfo,
            SystemInfo.of({
              ...system,
              canonicalProcessStartIdentity: () =>
                Effect.sync(() => {
                  canonicalLookups += 1;
                  return 'darwin-v2:canonical-owner';
                }),
              isProcessRunning: () => true,
              processStartIdentity: () =>
                Effect.sync(() => {
                  legacyLookups += 1;
                  return 'darwin:different-owner';
                }),
            }),
          ),
          Effect.as('acquired' as const),
          Effect.catchIf(Schema.is(FileLockTimeout), () => Effect.succeed('timed-out' as const)),
        );

        expect(outcome).toBe('timed-out');
        expect(canonicalLookups).toBeGreaterThanOrEqual(2);
        expect(legacyLookups).toBe(0);
      }).pipe(provideTestLayer(FILE_LOCK_TEST_LAYER)),
    ),
  );

  effectIt.effect('recovers an aged canonical lock after a v2 mismatch and writes the canonical token', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(join(lockPath, '..'), {recursive: true});
        yield* fs.writeFileString(
          lockPath,
          `${JSON.stringify({
            processId: process.pid,
            processStartIdentity: 'darwin:Sat Aug  8 23:04:27 2026',
            token: 'orphaned-canonical-lock',
            version: 1,
          })}\n`,
          {mode: 0o600},
        );
        const old = DateTime.toDateUtc(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 60_000));
        yield* fs.utimes(lockPath, old, old);
        const system = yield* SystemInfo;
        let canonicalLookups = 0;
        let legacyLookups = 0;
        const acquiredIdentity = yield* withExclusiveFileLock(
          fs,
          lockPath,
          {...TEST_LOCK_OPTIONS, useCanonicalProcessStartIdentity: true},
          fs
            .readFileString(lockPath)
            .pipe(
              Effect.map(content =>
                String(
                  Schema.decodeUnknownSync(
                    Schema.StructWithRest(Schema.Struct({processStartIdentity: Schema.optional(Schema.Unknown)}), [
                      Schema.Record(Schema.String, Schema.Unknown),
                    ]),
                  )(JSON.parse(content)).processStartIdentity,
                ),
              ),
            ),
        ).pipe(
          Effect.provideService(
            SystemInfo,
            SystemInfo.of({
              ...system,
              canonicalProcessStartIdentity: () =>
                Effect.sync(() => {
                  canonicalLookups += 1;
                  return 'darwin-v2:Sat Aug  8 23:04:27 2026';
                }),
              isProcessRunning: () => true,
              processStartIdentity: () =>
                Effect.sync(() => {
                  legacyLookups += 1;
                  return 'darwin:Sat Aug  8 23:04:27 2026';
                }),
            }),
          ),
        );

        expect(acquiredIdentity).toBe('darwin-v2:Sat Aug  8 23:04:27 2026');
        expect(canonicalLookups).toBeGreaterThanOrEqual(3);
        expect(legacyLookups).toBe(0);
      }).pipe(provideTestLayer(FILE_LOCK_TEST_LAYER)),
    ),
  );

  it('refuses immediate PID-reuse recovery when the current process start is unknown', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(
      lockPath,
      `${JSON.stringify({
        processId: process.pid,
        processStartIdentity: 'original-process',
        token: 'live-or-unknown-lock',
        version: 1,
      })}\n`,
      {mode: 0o600},
    );

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const system = yield* SystemInfo;
          return yield* withExclusiveFileLock(
            fs,
            lockPath,
            {
              ...TEST_LOCK_OPTIONS,
              recoverReusedProcessIdImmediately: true,
              waitTimeoutMilliseconds: 10,
            },
            Effect.void,
          ).pipe(
            Effect.provideService(
              SystemInfo,
              SystemInfo.of({
                ...system,
                isProcessRunning: () => true,
                processStartIdentity: () => succeedUndefined,
              }),
            ),
          );
        }),
      ),
    ).rejects.toBeInstanceOf(FileLockTimeout);
  });

  it('does not inspect process identity while a live lock lease is fresh', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(
      lockPath,
      `${JSON.stringify({
        processId: process.pid,
        processStartIdentity: 'same-process',
        token: 'live-lock',
        version: 1,
      })}\n`,
      {mode: 0o600},
    );
    let identityLookups = 0;

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const system = yield* SystemInfo;
          return yield* withExclusiveFileLock(
            fs,
            lockPath,
            {...TEST_LOCK_OPTIONS, staleAfterMilliseconds: 60_000, waitTimeoutMilliseconds: 10},
            Effect.void,
          ).pipe(
            Effect.provideService(
              SystemInfo,
              SystemInfo.of({
                ...system,
                isProcessRunning: () => true,
                processStartIdentity: () =>
                  Effect.sync(() => {
                    identityLookups += 1;
                    return 'same-process';
                  }),
              }),
            ),
          );
        }),
      ),
    ).rejects.toBeInstanceOf(FileLockTimeout);
    expect(identityLookups).toBe(1);
  });

  it('recovers a stale lock even when an old recovery guard was orphaned', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});
    await writeFile(`${lockPath}.recovery`, '2147483647:orphaned-recovery\n', {mode: 0o600});
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await utimes(`${lockPath}.recovery`, old, old);

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* withExclusiveFileLock(fs, lockPath, TEST_LOCK_OPTIONS, Effect.succeed('acquired'));
        }),
      ),
    ).resolves.toBe('acquired');
  });

  it('waits behind a live recovery lease before taking over a stale lock', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});
    await writeFile(`${lockPath}.recovery`, `${process.pid}:live-recovery\n`, {mode: 0o600});
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await utimes(`${lockPath}.recovery`, old, old);
    let recoveryLeaseReleased = false;
    const release = setTimeout(() => {
      recoveryLeaseReleased = true;
      void rm(`${lockPath}.recovery`, {force: true});
    }, 40);

    try {
      await expect(
        run(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* withExclusiveFileLock(
              fs,
              lockPath,
              TEST_LOCK_OPTIONS,
              Effect.sync(() => recoveryLeaseReleased),
            );
          }),
        ),
      ).resolves.toBe(true);
    } finally {
      clearTimeout(release);
    }
  });

  it('serializes simultaneous contenders during stale-lock takeover', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    let active = 0;
    let maximumActive = 0;
    const contender = (name: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* withExclusiveFileLock(
          fs,
          lockPath,
          TEST_LOCK_OPTIONS,
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              active += 1;
              maximumActive = Math.max(maximumActive, active);
            });
            yield* Effect.sleep(30);
            yield* Effect.sync(() => {
              active -= 1;
            });
            return name;
          }),
        );
      });

    await expect(run(Effect.all([contender('first'), contender('second')], {concurrency: 2}))).resolves.toEqual([
      'first',
      'second',
    ]);
    expect(maximumActive).toBe(1);
  });
});
