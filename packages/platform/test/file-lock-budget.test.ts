import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Result,
  Schema,
} from 'effect';
import {expect} from 'vitest';
import {ChildEnvironmentPolicy} from '../src/child-environment-policy.js';
import {cryptoLayer} from '../src/crypto.js';
import {
  FileLockTimeout,
  fileLockBusyMessage,
  withExclusiveFileLock,
  withNativeFileLockWaitBudget,
} from '../src/file/lock.js';
import {RuntimeEntrypoint} from '../src/runtime-entrypoint.js';
import {SystemInfo} from '../src/system.js';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: value => value, sanitizeExternal: value => value}),
    ),
  ),
);
const dependencies = Layer.mergeAll(BunServices.layer, cryptoLayer, system);
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
