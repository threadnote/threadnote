import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {
  resourceAccountMutationGenerationPath,
  resourceAccountMutationLockPath,
  resourceAccountMutationLockPolicy,
} from '@threadnote/store/resource/lock';
import {advanceCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {readSettledCanonicalMutationGeneration} from '@threadnote/store/resource/settled_revision';

const systemLayer = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'settled-revision.test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => ({...environment}),
        sanitizeExternal: environment => ({...environment}),
      }),
    ),
  ),
);
const testLayer = Layer.merge(BunServices.layer, systemLayer);
function provideLayer<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(Layer.build(testLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

describe('settled canonical mutation generation', () => {
  effectIt.effect('returns the initial generation and a completed marker without changing it', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'settled-revision-'});
      expect(yield* readSettledCanonicalMutationGeneration(fs, path, home, 'local')).toBe('');
      const marker = (yield* advanceCanonicalMutationGeneration(fs, path, home, 'local')).currentGeneration;
      expect(yield* readSettledCanonicalMutationGeneration(fs, path, home, 'local')).toBe(marker);
      expect(yield* readSettledCanonicalMutationGeneration(fs, path, home, 'local')).toBe(marker);
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('waits for a writer after marker advance, including a failed writer', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'settled-writer-'});
      const lockPath = resourceAccountMutationLockPath(path, home, 'local');
      for (const fails of [false, true]) {
        const advanced = yield* Deferred.make<string>();
        const release = yield* Deferred.make<void>();
        const writer = yield* withExclusiveFileLock(
          fs,
          lockPath,
          resourceAccountMutationLockPolicy,
          Effect.gen(function* () {
            const marker = (yield* advanceCanonicalMutationGeneration(fs, path, home, 'local')).currentGeneration;
            yield* Deferred.succeed(advanced, marker);
            yield* Deferred.await(release);
            if (fails) return yield* Effect.fail('writer failed');
          }),
        ).pipe(Effect.result, Effect.forkChild({startImmediately: true}));
        const marker = yield* Deferred.await(advanced);
        let readerCompleted = false;
        const reader = yield* readSettledCanonicalMutationGeneration(fs, path, home, 'local').pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              readerCompleted = true;
            }),
          ),
          Effect.forkChild({startImmediately: true}),
        );
        yield* Effect.sleep(75);
        expect(readerCompleted).toBe(false);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(writer);
        expect(Result.isFailure(result)).toBe(fails);
        expect(yield* Fiber.join(reader)).toBe(marker);
      }
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('fails closed for a malformed marker and leaves the account lock reusable', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'settled-invalid-'});
      const markerPath = resourceAccountMutationGenerationPath(path, home, 'local');
      yield* fs.makeDirectory(path.dirname(markerPath), {recursive: true});
      yield* fs.writeFileString(markerPath, 'malformed');
      const result = yield* readSettledCanonicalMutationGeneration(fs, path, home, 'local').pipe(Effect.result);
      expect(
        Result.isFailure(result) &&
          typeof result.failure === 'object' &&
          result.failure !== null &&
          '_tag' in result.failure &&
          result.failure._tag,
      ).toBe('CanonicalMutationGenerationInvalid');
      yield* fs.remove(markerPath);
      expect(yield* readSettledCanonicalMutationGeneration(fs, path, home, 'local')).toBe('');
    }).pipe(TestClock.withLive, provideLayer),
  );

  effectIt.effect('interrupts a waiting reader without removing the writer lock', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'settled-interrupt-'});
      const lockPath = resourceAccountMutationLockPath(path, home, 'local');
      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* withExclusiveFileLock(
        fs,
        lockPath,
        resourceAccountMutationLockPolicy,
        Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(acquired);
      const reader = yield* readSettledCanonicalMutationGeneration(fs, path, home, 'local').pipe(
        Effect.forkChild({startImmediately: true}),
      );
      yield* Effect.sleep(75);
      yield* Fiber.interrupt(reader);
      expect(yield* fs.exists(lockPath)).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      expect(yield* readSettledCanonicalMutationGeneration(fs, path, home, 'local')).toBe('');
    }).pipe(TestClock.withLive, provideLayer),
  );
});
