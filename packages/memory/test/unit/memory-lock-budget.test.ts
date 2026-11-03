import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Clock, Duration, Effect, FileSystem, Layer, Path, PlatformError, Schema} from 'effect';
import {expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {withNativeFileLockWaitBudget} from '@threadnote/platform/file/lock';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {withMemoryUriLocks} from '../../src/lock.js';

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
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'memory-lock-budget-'});
  const clock = yield* Clock.Clock;
  const system = yield* SystemInfo;
  let now = 0n;
  const modelClock: Clock.Clock = {
    ...clock,
    currentTimeMillisUnsafe: () => Number(now / 1_000_000n),
    currentTimeMillis: Effect.sync(() => Number(now / 1_000_000n)),
    monotonicTimeNanosUnsafe: () => now,
    monotonicTimeNanos: Effect.sync(() => now),
    sleep: duration =>
      Duration.toMillis(duration) >= 100_000
        ? Effect.never
        : Effect.sync(() => {
            now += BigInt(Math.floor(Duration.toMillis(duration) * 1_000_000));
          }),
  };
  const model = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Clock.Clock, modelClock),
      Effect.provideService(SystemInfo, {
        ...system,
        processStartIdentity: () => Effect.succeed('fixture-start'),
        canonicalProcessStartIdentity: () => Effect.succeed('fixture-start'),
      }),
    );
  const file = (uri: string) => path.join(home, 'threadnote', 'memory-locks', sha256HexSync(uri) + '.lock');
  return {fs, path, home, model, file};
});

effectIt.effect.prop(
  'duplicates and permutations acquire one identical sorted lock set',
  {
    ids: Schema.Array(Schema.Number.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 5}))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
  },
  ({ids}) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const uris = EffectArray.map(ids, id => `threadnote://user/tester/memories/${id}.md`);
      const expected = [...new Set(EffectArray.map(uris, f.file))].sort();
      const orders: string[][] = [];
      for (const inputs of [uris, [...uris].reverse()]) {
        const order: string[] = [];
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          writeFileString: (file, content, options) =>
            f.fs.writeFileString(file, content, options).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (options?.flag === 'wx') order.push(file);
                }),
              ),
            ),
        });
        yield* withNativeFileLockWaitBudget(withMemoryUriLocks(observed, f.home, inputs, Effect.void)).pipe(f.model);
        orders.push(order);
      }
      expect(orders).toEqual([expected, expected]);
      expect(yield* f.fs.readDirectory(f.path.dirname(expected[0]))).toEqual([]);
    }).pipe(provide),
  {arbitrary: {runs: 20}},
);

effectIt.effect('unwinds earlier memory locks when the shared native allowance expires', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const uris = ['threadnote://user/tester/memories/a.md', 'threadnote://user/tester/memories/b.md'];
    const files = EffectArray.map(uris, f.file).sort();
    let entered = false;
    const blocked = FileSystem.FileSystem.of({
      ...f.fs,
      writeFileString: (file, content, options) =>
        file === files[1] && options?.flag === 'wx'
          ? Effect.fail(
              PlatformError.systemError({
                _tag: 'AlreadyExists',
                method: 'writeFileString',
                module: 'FileSystem',
                pathOrDescriptor: file,
              }),
            )
          : f.fs.writeFileString(file, content, options),
    });
    const error = yield* withNativeFileLockWaitBudget(
      withMemoryUriLocks(
        blocked,
        f.home,
        uris,
        Effect.sync(() => {
          entered = true;
        }),
      ),
    ).pipe(f.model, Effect.flip);
    expect(error).toMatchObject({_tag: 'FileLockTimeout', category: 'memory', cumulativeWaitMilliseconds: 2000});
    expect(entered).toBe(false);
    expect(yield* f.fs.readDirectory(f.path.dirname(files[0]))).toEqual([]);
  }).pipe(provide),
);
