import {dlopen} from 'bun:ffi';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Cause,
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Result,
  Schema,
} from 'effect';
import {expect, vi} from 'vitest';
import {TestClock} from 'effect/testing';
import {windowsSystemLibrary, windowsTokenPrincipal, windowsWide} from '../src/writer-system/windows-native.js';
import {ChildEnvironmentPolicy} from '../src/child-environment-policy.js';
import {cryptoLayer} from '../src/crypto.js';
import {
  FileLockTimeout,
  fileLockBusyMessage,
  withExclusiveFileLock,
  withExclusiveFileLockLease,
  withNativeFileLockWaitBudget,
} from '../src/file/lock.js';
import {RuntimeEntrypoint} from '../src/runtime-entrypoint.js';
import {
  runtimeReadWriterLockToken,
  SystemInfo,
  runtimeOpenPrivateWriterDirectory,
  runtimeOpenPrivateWriterChild,
  runtimeClosePrivateWriterDirectory,
  runtimeAssertPrivateWriterDirectoryCurrent,
  runtimePublishPrivateWriterFile,
} from '../src/system.js';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: value => value, sanitizeExternal: value => value}),
    ),
  ),
);
const dependencies = Layer.mergeAll(BunServices.layer, cryptoLayer, system);

effectIt.effect('stabilizes a timestamp-only heartbeat interleaved with a synchronous current lease assertion', () =>
  provide(
    Effect.gen(function* () {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'writer-heartbeat-overlap-'});
      const lock = `${root}/writer.lock`;
      yield* withExclusiveFileLockLease(fs, lock, policy, lease =>
        Effect.sync(() => {
          const native = process.getBuiltinModule('fs');
          // ACL before/after and byte-read before/after boundaries all retain full coherence checks.
          for (const interleave of [1, 2, 3, 4]) {
            const baseline = runtimeReadWriterLockToken(lock);
            lease.assertCurrentSync();
            const original = native.fstatSync.bind(native);
            let samples = 0;
            let injected = false;
            const probe = vi.spyOn(native, 'fstatSync').mockImplementation((fd, options) => {
              const value = original(fd, options);
              if (BigInt(value.ino) === baseline.identity.ino && ++samples === interleave) {
                injected = true;
                const timestamp = new Date(Number(baseline.identity.mtimeNs / 1_000_000n) + 1000);
                native.futimesSync(fd, timestamp, timestamp);
              }
              return value;
            });
            try {
              lease.assertCurrentSync();
            } finally {
              probe.mockRestore();
            }
            expect(injected).toBe(true);
            const after = runtimeReadWriterLockToken(lock);
            expect(after.token).toBe(baseline.token);
            for (const field of ['dev', 'ino', 'birthtimeNs', 'mode', 'uid', 'gid', 'nlink', 'size'] as const)
              expect(after.identity[field]).toBe(baseline.identity[field]);
            expect(after.identity.mtimeNs).not.toBe(baseline.identity.mtimeNs);
            lease.assertCurrentSync();
          }
        }),
      );
    }),
  ),
);

effectIt.effect('keeps unsafe or persistently incoherent token observations sticky after stabilization', () =>
  provide(
    Effect.gen(function* () {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'writer-heartbeat-refusal-'});
      for (const change of ['mode', 'bytes', 'acl-on-retry', 'continuous-timestamps'] as const) {
        const lock = `${root}/${change}.lock`;
        yield* withExclusiveFileLockLease(fs, lock, policy, lease =>
          Effect.sync(() => {
            const native = process.getBuiltinModule('fs');
            const baseline = runtimeReadWriterLockToken(lock);
            const originalBytes = native.readFileSync(lock);
            const original = native.fstatSync.bind(native);
            let samples = 0;
            let aclAdded = false;
            const probe = vi.spyOn(native, 'fstatSync').mockImplementation((fd, options) => {
              const value = original(fd, options);
              if (BigInt(value.ino) !== baseline.identity.ino) return value;
              samples++;
              if (change === 'continuous-timestamps' || (change === 'acl-on-retry' && samples === 1)) {
                const timestamp = new Date(Number(baseline.identity.mtimeNs / 1_000_000n) + samples * 1000);
                native.futimesSync(fd, timestamp, timestamp);
              }
              if (change === 'mode' && samples === 1) native.fchmodSync(fd, 0o644);
              if (change === 'bytes' && samples === 1) {
                const changed = Uint8Array.from(originalBytes);
                changed[0] ^= 1;
                native.writeFileSync(lock, changed);
              }
              if (change === 'acl-on-retry' && samples === 3) {
                const result = Bun.spawnSync(['/bin/chmod', '+a', 'everyone allow read', lock], {
                  stdout: 'pipe',
                  stderr: 'pipe',
                  timeout: 5000,
                });
                expect(result.exitCode).toBe(0);
                aclAdded = true;
              }
              return value;
            });
            try {
              expect(() => lease.assertCurrentSync()).toThrow();
            } finally {
              probe.mockRestore();
              if (aclAdded) expect(Bun.spawnSync(['/bin/chmod', '-N', lock], {timeout: 5000}).exitCode).toBe(0);
              native.chmodSync(lock, 0o600);
              native.writeFileSync(lock, originalBytes);
            }
            if (change === 'continuous-timestamps') expect(samples).toBe(4);
            if (change === 'acl-on-retry') expect(aclAdded).toBe(true);
            expect(runtimeReadWriterLockToken(lock).token).toBe(baseline.token);
            expect(() => lease.assertCurrentSync()).toThrow();
          }),
        );
      }
    }),
  ),
);

effectIt.effect('makes current writer lease assertions sticky after replacement and inactive after scope exit', () =>
  provide(
    Effect.gen(function* () {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'current-writer-lease-'});
      const lock = `${root}/writer.lock`;
      let outside: (() => void) | undefined;
      yield* withExclusiveFileLockLease(
        fs,
        lock,
        {...policy, allowUnverifiedStaleRecovery: false, useCanonicalProcessStartIdentity: true},
        lease =>
          Effect.gen(function* () {
            yield* lease.assertCurrent;
            outside = lease.assertCurrentSync;
            const token = yield* fs.readFileString(lock);
            yield* fs.writeFileString(lock, 'replaced');
            expect(yield* lease.assertCurrent.pipe(Effect.flip)).toMatchObject({_tag: 'FileLockLost', reason: 'lost'});
            yield* fs.writeFileString(lock, token);
            expect(yield* lease.assertCurrent.pipe(Effect.flip)).toMatchObject({_tag: 'FileLockLost', reason: 'lost'});
          }),
      );
      expect(outside).toBeDefined();
      expect(() => outside?.()).toThrow();
    }),
  ),
);

effectIt.effect('retains heartbeat loss even when the original token is restored before the first assertion', () =>
  provide(
    Effect.gen(function* () {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'writer-heartbeat-loss-'});
      const lock = `${root}/writer.lock`;
      yield* withExclusiveFileLockLease(fs, lock, {...policy, heartbeatIntervalMilliseconds: 10}, lease =>
        Effect.gen(function* () {
          const token = yield* fs.readFileString(lock);
          const closed = yield* Deferred.make<void>();
          const native = process.getBuiltinModule('fs').promises;
          const original = native.open.bind(native);
          yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              vi.spyOn(native, 'open').mockImplementation(async (...args) => {
                const handle = await original(...args);
                if (args[0] === lock && typeof args[1] === 'number' && (args[1] & 3) === 2) {
                  const close = handle.close.bind(handle);
                  handle.close = async () => {
                    await close();
                    Deferred.doneUnsafe(closed, Effect.void);
                  };
                }
                return handle;
              }),
            ),
            () =>
              Effect.gen(function* () {
                yield* fs.writeFileString(lock, 'not the lease token');
                yield* TestClock.adjust(20);
                yield* Deferred.await(closed);
                yield* Effect.yieldNow;
                yield* fs.writeFileString(lock, token);
                expect(yield* lease.assertCurrent.pipe(Effect.flip)).toMatchObject({
                  _tag: 'FileLockLost',
                  reason: 'lost',
                });
              }),
            spy => Effect.sync(() => spy.mockRestore()),
          );
        }),
      );
    }),
  ),
);
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(dependencies).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const policy = {
  category: 'memory',
  heartbeatIntervalMilliseconds: 1_000_000,
  retryIntervalMilliseconds: 250,
  staleAfterMilliseconds: 1_000_000,
  waitTimeoutMilliseconds: 30_000,
} as const;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'file-lock-budget-'});
  const clock = yield* Clock.Clock;
  const system = yield* SystemInfo;
  const modelSystem = {
    ...system,
    isProcessRunning: (processId: number) => (processId === 987_654_321 ? false : system.isProcessRunning(processId)),
    processStartIdentity: () => Effect.succeed('fixture-start'),
    canonicalProcessStartIdentity: () => Effect.succeed('fixture-start'),
  };
  let now = 0n;
  let auto = true;
  const sleeping = yield* Deferred.make<void>();
  const twoSleeping = yield* Deferred.make<void>();
  const paused = yield* Deferred.make<void>();
  let sleepers = 0;
  const modelClock: Clock.Clock = {
    ...clock,
    currentTimeMillisUnsafe: () => Number(now / 1_000_000n),
    currentTimeMillis: Effect.sync(() => Number(now / 1_000_000n)),
    monotonicTimeNanosUnsafe: () => now,
    monotonicTimeNanos: Effect.sync(() => now),
    sleep: duration =>
      Effect.suspend(() => {
        if (Duration.toMillis(duration) >= policy.heartbeatIntervalMilliseconds) return Effect.never;
        if (auto)
          return Effect.sync(() => {
            now += BigInt(Math.floor(Duration.toMillis(duration) * 1_000_000));
          });
        return Effect.sync(() => {
          sleepers++;
        }).pipe(
          Effect.andThen(Deferred.succeed(sleeping, undefined)),
          Effect.andThen(
            Effect.suspend(() => (sleepers === 2 ? Deferred.succeed(twoSleeping, undefined) : Effect.void)),
          ),
          Effect.andThen(Deferred.await(paused)),
        );
      }),
  };
  const file = (name: string) => path.join(root, name + '.lock');
  const unavailable = (name: string, failures = Number.POSITIVE_INFINITY) => {
    let attempted = 0;
    return FileSystem.FileSystem.of({
      ...fs,
      writeFileString: (target, content, options) => {
        if (target === file(name) && options?.flag === 'wx' && attempted++ < failures)
          return Effect.fail(
            PlatformError.systemError({
              _tag: 'AlreadyExists',
              method: 'writeFileString',
              module: 'FileSystem',
              pathOrDescriptor: target,
            }),
          );
        return fs.writeFileString(target, content, options);
      },
    });
  };
  const model = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(Clock.Clock, modelClock), Effect.provideService(SystemInfo, modelSystem));
  return {
    fs,
    file,
    unavailable,
    modelClock,
    modelSystem,
    model,
    sleeping,
    twoSleeping,
    pause: () => {
      auto = false;
    },
    resume: () => {
      auto = true;
    },
    advance: (millis: number) => {
      now += BigInt(millis) * 1_000_000n;
    },
    sleepers: () => sleepers,
  };
});

effectIt.effect('distinguishes unmeasured legacy waiting from measured zero-wait refusal', () =>
  Effect.sync(() => {
    const legacy = fileLockBusyMessage(FileLockTimeout.of('/private/not-for-output'));
    expect(legacy).toContain('unavailable');
    expect(legacy).not.toContain('0ms');
    expect(legacy).not.toContain('/private/not-for-output');
    expect(
      fileLockBusyMessage(
        FileLockTimeout.make({
          lockPath: '/private/not-for-output',
          message: 'hidden',
          category: 'recall-index',
          waitedMilliseconds: 0,
          cumulativeWaitMilliseconds: 0,
        }),
      ),
    ).toContain('0ms here, 0ms in this attempt');
  }),
);

effectIt.effect('retains ordinary per-lock waiting beyond the native allowance', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const error = yield* withExclusiveFileLock(
        f.unavailable('ordinary'),
        f.file('ordinary'),
        {...policy, waitTimeoutMilliseconds: 5000},
        Effect.void,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({_tag: 'FileLockTimeout', category: 'memory'});
      expect(yield* Clock.currentTimeMillis).toBe(5000);
      expect(Schema.is(FileLockTimeout)(error) && error.cumulativeWaitMilliseconds).toBeUndefined();
    }).pipe(f.model);
  }).pipe(provide),
);

effectIt.effect('preserves unverified lock owners across expired or interrupted waits', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const primary = f.file('drain-primary');
      const recovery = primary + '.recovery';
      const primaryBytes = 'unverified-primary-owner';
      const recoveryBytes = 'unverified-recovery-owner';
      const agedAt = DateTime.toDateUtc(DateTime.makeUnsafe('1970-01-01T00:00:00.000Z'));
      const failClosed = {
        ...policy,
        staleAfterMilliseconds: 0,
        waitTimeoutMilliseconds: 0,
        allowUnverifiedStaleRecovery: false,
      } as const;

      yield* f.fs.writeFileString(primary, primaryBytes);
      yield* f.fs.utimes(primary, agedAt, agedAt);
      f.advance(1);
      const primaryTimeout = yield* withExclusiveFileLock(f.fs, primary, failClosed, Effect.void).pipe(Effect.flip);
      expect(primaryTimeout).toMatchObject({_tag: 'FileLockTimeout'});
      expect(yield* f.fs.readFileString(primary)).toBe(primaryBytes);

      yield* f.fs.remove(primary);
      yield* f.fs.writeFileString(recovery, recoveryBytes);
      yield* f.fs.utimes(recovery, agedAt, agedAt);
      f.advance(1);
      const recoveryTimeout = yield* withExclusiveFileLock(f.fs, primary, failClosed, Effect.void).pipe(Effect.flip);
      expect(recoveryTimeout).toMatchObject({_tag: 'FileLockTimeout'});
      expect(yield* f.fs.exists(primary)).toBe(false);
      expect(yield* f.fs.readFileString(recovery)).toBe(recoveryBytes);

      f.pause();
      const interruptedWait = yield* withExclusiveFileLock(
        f.fs,
        primary,
        {...failClosed, waitTimeoutMilliseconds: 5000},
        Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(f.sleeping);
      yield* Fiber.interrupt(interruptedWait);
      const interruptedExit = yield* Fiber.await(interruptedWait);
      expect(Exit.isFailure(interruptedExit) && Cause.hasInterrupts(interruptedExit.cause)).toBe(true);
      expect(yield* f.fs.exists(primary)).toBe(false);
      expect(yield* f.fs.readFileString(recovery)).toBe(recoveryBytes);

      const defaulted = f.file('default-recovery');
      yield* f.fs.writeFileString(defaulted, 'aged-malformed-owner');
      yield* f.fs.utimes(defaulted, agedAt, agedAt);
      f.advance(1);
      expect(
        yield* withExclusiveFileLock(
          f.fs,
          defaulted,
          {...policy, staleAfterMilliseconds: 0, waitTimeoutMilliseconds: 0},
          Effect.succeed('acquired'),
        ),
      ).toBe('acquired');
      expect(yield* f.fs.exists(defaulted)).toBe(false);

      const knownDead = f.file('known-dead');
      yield* f.fs.writeFileString(
        knownDead,
        JSON.stringify({processId: 987_654_321, token: 'known-dead-token', version: 1}),
      );
      yield* f.fs.utimes(knownDead, agedAt, agedAt);
      expect(
        yield* withExclusiveFileLock(
          f.fs,
          knownDead,
          {...failClosed, waitTimeoutMilliseconds: 0},
          Effect.succeed('recovered'),
        ),
      ).toBe('recovered');
      expect(yield* f.fs.exists(knownDead)).toBe(false);
    }).pipe(f.model);
  }).pipe(provide),
);

effectIt.effect('caps an unbounded local policy only within native attempts', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      for (const retryIntervalMilliseconds of [250, Number.POSITIVE_INFINITY]) {
        const error = yield* withNativeFileLockWaitBudget(
          withExclusiveFileLock(
            f.unavailable('native-infinite'),
            f.file('native-infinite'),
            {...policy, retryIntervalMilliseconds, waitTimeoutMilliseconds: Number.POSITIVE_INFINITY},
            Effect.void,
          ),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: 'FileLockTimeout',
          waitedMilliseconds: 2000,
          cumulativeWaitMilliseconds: 2000,
        });
      }
      const started = yield* Clock.currentTimeMillis;
      yield* withExclusiveFileLock(
        f.unavailable('ordinary-infinite', 12),
        f.file('ordinary-infinite'),
        {...policy, waitTimeoutMilliseconds: Number.POSITIVE_INFINITY},
        Effect.void,
      );
      expect((yield* Clock.currentTimeMillis) - started).toBe(3000);
    }).pipe(f.model);
  }).pipe(provide),
);

effectIt.effect.prop(
  'charges generated wait histories once while excluding preparation and protected work',
  {
    waits: Schema.Array(Schema.Number.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 4}))).check(
      Schema.isMaxLength(6),
    ),
  },
  ({waits}) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const categories = [
        'recall-index',
        'native-run',
        'native-journal',
        'native-job',
        'memory',
        'canonical-account',
      ] as const;
      const result = yield* withNativeFileLockWaitBudget(
        Effect.gen(function* () {
          for (const [index, failures] of waits.entries()) {
            yield* Effect.sleep(100_000);
            yield* withExclusiveFileLock(
              f.unavailable(String(index), failures),
              f.file(String(index)),
              {...policy, category: categories[index]},
              Effect.sleep(100_000),
            );
          }
        }),
      ).pipe(f.model, Effect.result);
      const requested = EffectArray.reduce(waits, 0, (total, failures) => total + failures * 250);
      expect(Result.isSuccess(result)).toBe(requested <= 2000);
      if (Result.isFailure(result)) expect(result.failure).toMatchObject({cumulativeWaitMilliseconds: 2000});
    }).pipe(provide),
  {arbitrary: {runs: 20}},
);

effectIt.effect('clamps local retry intervals and never resets an exhausted nested attempt', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* withNativeFileLockWaitBudget(
      Effect.gen(function* () {
        expect(
          yield* withExclusiveFileLock(
            f.unavailable('first'),
            f.file('first'),
            {...policy, category: 'recall-index', waitTimeoutMilliseconds: 600},
            Effect.void,
          ).pipe(Effect.flip),
        ).toMatchObject({waitedMilliseconds: 600, cumulativeWaitMilliseconds: 600});
        expect(
          yield* withExclusiveFileLock(
            f.unavailable('second'),
            f.file('second'),
            {...policy, category: 'native-journal'},
            Effect.void,
          ).pipe(Effect.flip),
        ).toMatchObject({waitedMilliseconds: 1400, cumulativeWaitMilliseconds: 2000});
        yield* Effect.sleep(500_000);
        expect(
          yield* withNativeFileLockWaitBudget(
            withExclusiveFileLock(f.unavailable('third'), f.file('third'), policy, Effect.void),
          ).pipe(Effect.flip),
        ).toMatchObject({waitedMilliseconds: 0, cumulativeWaitMilliseconds: 2000});
        expect(yield* withExclusiveFileLock(f.fs, f.file('free'), policy, Effect.succeed('free'))).toBe('free');
      }),
    ).pipe(f.model);
  }).pipe(provide),
);

effectIt.effect('reserves shared allowance across concurrent children and refunds interrupted waits', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.pause();
    yield* withNativeFileLockWaitBudget(
      Effect.gen(function* () {
        const first = yield* withExclusiveFileLock(
          f.unavailable('first'),
          f.file('first'),
          {...policy, retryIntervalMilliseconds: 1000},
          Effect.void,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(f.sleeping);
        const second = yield* withExclusiveFileLock(
          f.unavailable('second'),
          f.file('second'),
          {...policy, retryIntervalMilliseconds: 1000},
          Effect.void,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(f.twoSleeping);
        f.advance(100);
        expect(
          yield* withExclusiveFileLock(f.unavailable('third'), f.file('third'), policy, Effect.void).pipe(Effect.flip),
        ).toMatchObject({waitedMilliseconds: 0, cumulativeWaitMilliseconds: 200});
        f.advance(400);
        yield* Fiber.interrupt(first);
        yield* Fiber.interrupt(second);
        f.resume();
        expect(
          yield* withExclusiveFileLock(f.unavailable('remaining'), f.file('remaining'), policy, Effect.void).pipe(
            Effect.flip,
          ),
        ).toMatchObject({waitedMilliseconds: 1000, cumulativeWaitMilliseconds: 2000});
      }),
    ).pipe(f.model);
  }).pipe(provide),
);

effectIt.effect('releases an earlier acquired token on interruption and refunds only unused reservation', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.pause();
    yield* withNativeFileLockWaitBudget(
      Effect.gen(function* () {
        const child = yield* withExclusiveFileLock(
          f.fs,
          f.file('owned'),
          policy,
          withExclusiveFileLock(
            f.unavailable('blocked'),
            f.file('blocked'),
            {...policy, retryIntervalMilliseconds: 1000},
            Effect.void,
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(f.sleeping);
        f.advance(200);
        yield* Fiber.interrupt(child);
        expect(yield* f.fs.exists(f.file('owned'))).toBe(false);
        f.resume();
        expect(
          yield* withExclusiveFileLock(f.unavailable('remaining'), f.file('remaining'), policy, Effect.void).pipe(
            Effect.flip,
          ),
        ).toMatchObject({waitedMilliseconds: 1800, cumulativeWaitMilliseconds: 2000});
      }),
    ).pipe(f.model);
  }).pipe(provide),
);

effectIt.effect('accounts for Windows sharing retries without changing ordinary retry limits', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let attempts = 0;
    const denied = FileSystem.FileSystem.of({
      ...f.fs,
      writeFileString: (target, content, options) => {
        if (target !== f.file('windows')) return f.fs.writeFileString(target, content, options);
        attempts++;
        return Effect.fail(
          PlatformError.systemError({
            _tag: 'PermissionDenied',
            cause: {code: 'EACCES'},
            method: 'writeFileString',
            module: 'FileSystem',
            pathOrDescriptor: target,
          }),
        );
      },
    });
    const acquire = withExclusiveFileLock(
      denied,
      f.file('windows'),
      {...policy, retryIntervalMilliseconds: 300, windowsSharingViolationRetryLimit: 100},
      Effect.void,
    );
    const error = yield* withNativeFileLockWaitBudget(acquire).pipe(
      Effect.provideService(Clock.Clock, f.modelClock),
      Effect.provideService(SystemInfo, {...f.modelSystem, platform: 'win32'}),
      Effect.flip,
    );
    expect(error).toMatchObject({_tag: 'FileLockTimeout', cumulativeWaitMilliseconds: 2000});
    expect(attempts).toBe(8);
    const ordinary = yield* withExclusiveFileLock(
      denied,
      f.file('windows'),
      {...policy, windowsSharingViolationRetryLimit: 2},
      Effect.void,
    ).pipe(
      Effect.provideService(Clock.Clock, f.modelClock),
      Effect.provideService(SystemInfo, {...f.modelSystem, platform: 'win32'}),
      Effect.flip,
    );
    expect(PlatformError.isPlatformError(ordinary)).toBe(true);
    expect(attempts).toBe(11);
  }).pipe(provide),
);

effectIt.effect('reports a live owner with safe category, start fingerprint and cumulative waiting', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const system = yield* SystemInfo;
    const rawStart = 'private-start /sensitive/path --secret=value';
    const token = 'private-owner-token';
    yield* f.fs.writeFileString(
      f.file('owner'),
      JSON.stringify({version: 1, processId: system.processId, processStartIdentity: rawStart, token}),
    );
    const error = yield* withNativeFileLockWaitBudget(
      withExclusiveFileLock(f.fs, f.file('owner'), policy, Effect.void),
    ).pipe(f.model, Effect.flip);
    expect(error).toMatchObject({
      _tag: 'FileLockTimeout',
      category: 'memory',
      ownerProcessId: system.processId,
      cumulativeWaitMilliseconds: 2000,
    });
    if (!Schema.is(FileLockTimeout)(error)) throw new Error('Expected timeout');
    expect(error.ownerStartFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(error.message).not.toContain(f.file('owner'));
    expect(error.message).not.toContain(rawStart);
    expect(error.message).not.toContain(token);
    expect(error.message).toContain(`PID ${system.processId}`);
  }).pipe(provide),
);

// Real process/NTFS boundary uses live time; deterministic generic retry properties above retain the test clock.
effectIt.effect.skipIf(process.platform !== 'win32')(
  'retains native O then M leases across process contention, release and process death',
  () =>
    provide(
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path;
          const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'native-writer-lease-'});
          const ownedPath = path.join(temporary, 'owned');
          const directory = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const principal = windowsTokenPrincipal();
              const security = windowsSystemLibrary('advapi32.dll', {
                ConvertStringSecurityDescriptorToSecurityDescriptorW: {
                  args: ['buffer', 'u32', 'buffer', 'ptr'],
                  returns: 'i32',
                },
              });
              const kernel = dlopen('kernel32.dll', {
                CreateDirectoryW: {args: ['buffer', 'buffer'], returns: 'i32'},
                LocalFree: {args: ['u64'], returns: 'u64'},
              });
              const descriptor = new BigUint64Array(1);
              try {
                expect(
                  security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    windowsWide(`O:${principal.sid}D:P(A;;FA;;;${principal.sid})`),
                    1,
                    descriptor,
                    null,
                  ),
                ).toBe(1);
                const attributes = new BigUint64Array(3);
                new DataView(attributes.buffer).setUint32(0, 24, true);
                attributes[1] = descriptor[0];
                expect(kernel.symbols.CreateDirectoryW(windowsWide(ownedPath), attributes)).toBe(1);
              } finally {
                if (descriptor[0] !== 0n) expect(kernel.symbols.LocalFree(descriptor[0])).toBe(0n);
                security.close();
                kernel.close();
              }
              const base = runtimeOpenPrivateWriterDirectory(process.getBuiltinModule('fs').realpathSync(ownedPath));
              try {
                return runtimeOpenPrivateWriterChild(base, 'leases', true);
              } finally {
                runtimeClosePrivateWriterDirectory(base);
              }
            }),
            handle => Effect.sync(() => runtimeClosePrivateWriterDirectory(handle)),
          );
          const operation = path.join(directory.path, 'operation.lock'),
            mutation = path.join(directory.path, 'mutation.lock');
          const selected = {
            ...policy,
            privateDirectory: directory,
            createParentDirectory: false,
            retryIntervalMilliseconds: 25,
            waitTimeoutMilliseconds: 75,
            heartbeatIntervalMilliseconds: 25,
            assertParentCurrent: () => runtimeAssertPrivateWriterDirectoryCurrent(directory),
          };
          const moduleUrl = new URL('../src/writer_system.ts', import.meta.url).href;
          for (const disposition of ['release', 'die'] as const) {
            const ready = path.join(temporary, `ready-${disposition}`);
            const source = `import {runtimeOpenPrivateWriterDirectory,runtimeAcquirePrivateWriterLease,runtimeReadWriterProcessIdentity,runtimeClosePrivateWriterDirectory} from ${JSON.stringify(moduleUrl)};
        const directory=runtimeOpenPrivateWriterDirectory(${JSON.stringify(directory.path)});
        const token=JSON.stringify({version:1,processId:process.pid,processStartIdentity:runtimeReadWriterProcessIdentity(process.pid),token:'isolated-child-token'});
        const operation=runtimeAcquirePrivateWriterLease(directory,${JSON.stringify(operation)},token);
        const mutation=runtimeAcquirePrivateWriterLease(directory,${JSON.stringify(mutation)},token);
        if(!operation||!mutation) throw new Error('child lease not acquired');
        operation.assertCurrentSync(); mutation.heartbeat();
        process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(ready)},'ready');
        const disposition=await Bun.stdin.text();
        if(disposition==='release'){mutation.close();operation.close();runtimeClosePrivateWriterDirectory(directory);}
        process.exit(0);`;
            const child = yield* Effect.acquireRelease(
              Effect.sync(() =>
                Bun.spawn([process.execPath, '--eval', source], {
                  cwd: process.cwd(),
                  stdin: 'pipe',
                  stdout: 'pipe',
                  stderr: 'pipe',
                }),
              ),
              child =>
                Effect.promise(async () => {
                  try {
                    await child.stdin.end();
                  } catch {
                    /* The normal handoff already closed stdin. */
                  }
                  await child.exited;
                }),
            );
            yield* Effect.gen(function* () {
              while (!(yield* fs.exists(ready))) yield* Effect.sleep(20);
            }).pipe(Effect.timeout(10_000));
            for (const lock of [operation, mutation]) {
              const result = yield* withNativeFileLockWaitBudget(
                withExclusiveFileLockLease(fs, lock, selected, () => Effect.void),
              ).pipe(Effect.result);
              expect(Result.isFailure(result)).toBe(true);
              if (Result.isFailure(result)) expect(result.failure).toMatchObject({_tag: 'FileLockTimeout'});
            }
            yield* Effect.promise(async () => {
              await child.stdin.write(disposition);
              await child.stdin.end();
            });
            expect(yield* Effect.promise(() => child.exited)).toBe(0);
            let saved: (() => void) | undefined;
            yield* withExclusiveFileLockLease(fs, operation, selected, outer =>
              withExclusiveFileLockLease(fs, mutation, selected, inner =>
                Effect.gen(function* () {
                  yield* Effect.sync(() => {
                    outer.assertCurrentSync();
                    inner.assertCurrentSync();
                    saved = inner.assertCurrentSync;
                  });
                  yield* Effect.sleep(60); // Real same-HANDLE heartbeat must survive its own share0 exclusion.
                  yield* inner.assertCurrent;
                }),
              ),
            );
            expect(() => saved?.()).toThrow();
            expect(() =>
              runtimePublishPrivateWriterFile(directory, 'lost-lease', new Uint8Array([1]), {
                mode: 'exclusive',
                nonce: 'abcdef0123456789abcdef0123456789',
                assertCurrentSync: saved!,
              }),
            ).toThrow();
            expect(yield* fs.exists(path.join(directory.path, 'lost-lease'))).toBe(false);
            expect(yield* fs.exists(operation)).toBe(false);
            expect(yield* fs.exists(mutation)).toBe(false);
          }
        }),
      ),
    ),
);
