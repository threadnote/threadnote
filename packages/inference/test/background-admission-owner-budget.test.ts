import {cryptoLayer} from '@threadnote/platform/crypto';
import {SecureRandom} from 'effect/crypto';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  String as EffectString,
} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {makeBackgroundInferenceAdmission} from '../src/background/admission.js';

const policy = Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
  Layer.succeed(ChildEnvironmentPolicy, {
    preserveIntendedChild: environment => environment,
    sanitizeExternal: environment => environment,
  }),
);
const platform = Layer.mergeAll(
  Layer.merge(BunServices.layer, cryptoLayer),
  SystemInfo.layer.pipe(Layer.provide(policy)),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const actual = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'admission-owner-budget-'});
  const system = SystemInfo.of({
    ...actual,
    canonicalProcessStartIdentity: () => Effect.succeed('fixture-self'),
    processStartIdentity: () => Effect.succeed('fixture-self'),
    isProcessRunning: pid => pid === actual.processId,
  });
  const homes = [path.join(root, 'one'), path.join(root, 'two')];
  const filename = (home: string) => path.join(home, 'locks', 'inference-idle-v1', 'state.json');
  const admission = yield* makeBackgroundInferenceAdmission.pipe(Effect.provideService(SystemInfo, system));
  for (const home of homes) yield* admission.withForeground(home, Effect.void);
  return {fs, path, root, system, homes, filename};
});

describe('bounded process-local inference owners', () => {
  effectIt.layer(platform)(it => {
    fcEffectProp(
      it,
      'bounds uncertain acquisitions across homes and flushes each recovered home once',
      {extra: fc.integer({min: 1, max: 8}), afterPublish: fc.boolean(), homeCount: fc.integer({min: 1, max: 2})},
      ({extra, afterPublish, homeCount}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const homes = f.homes.slice(0, homeCount);
            const files = new Set(EffectArray.map(homes, f.filename));
            const cleaned = yield* Deferred.make<void>();
            let failing = true;
            let writes = 0;
            let recoveredWrites = 0;
            const admission = yield* makeBackgroundInferenceAdmission.pipe(
              Effect.provideService(SystemInfo, f.system),
              Effect.provideService(FileSystem.FileSystem, {
                ...f.fs,
                rename: (from, to) => {
                  if (!files.has(to)) return f.fs.rename(from, to);
                  writes++;
                  if (!failing) {
                    recoveredWrites++;
                    return f.fs.rename(from, to);
                  }
                  const failure = Effect.fail(
                    PlatformError.systemError({_tag: 'Busy', module: 'FileSystem', method: 'rename'}),
                  );
                  return afterPublish ? f.fs.rename(from, to).pipe(Effect.andThen(failure)) : failure;
                },
                remove: (filename, options) =>
                  f.fs
                    .remove(filename, options)
                    .pipe(
                      Effect.tap(() =>
                        !failing && recoveredWrites === homeCount && EffectString.endsWith('/guard.lock')(filename)
                          ? Deferred.succeed(cleaned, undefined)
                          : Effect.void,
                      ),
                    ),
              }),
            );
            for (let index = 0; index < 128; index++)
              expect(
                Exit.isFailure(
                  yield* Effect.exit(admission.withForeground(homes[index % homeCount], Effect.die('must not run'))),
                ),
              ).toBe(true);
            const saturatedWrites = writes;
            expect(saturatedWrites).toBeGreaterThan(0);
            for (let index = 0; index < extra; index++)
              expect(
                Exit.isFailure(yield* Effect.exit(admission.withForeground(homes[index % homeCount], Effect.void))),
              ).toBe(true);
            expect(writes).toBe(saturatedWrites);
            failing = false;
            yield* TestClock.adjust(250);
            yield* Deferred.await(cleaned);
            expect(recoveredWrites).toBe(homeCount);
            for (const home of homes) {
              const state = JSON.parse(yield* f.fs.readFileString(f.filename(home)));
              expect(state.foreground).toEqual([]);
            }
            expect(yield* admission.withForeground(homes[0], Effect.succeed('recovered'))).toBe('recovered');
            const idleWrites = writes;
            yield* TestClock.adjust(1000);
            expect(writes).toBe(idleWrites);
          }),
        ),
      {fastCheck: {numRuns: 4}},
    );

    it.effect('reserves capacity before concurrent owner token generation starts', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const crypto = yield* SecureRandom.SecureRandom;
        const atCapacity = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let tokens = 0;
        const admission = yield* makeBackgroundInferenceAdmission.pipe(
          Effect.provideService(SystemInfo, f.system),
          Effect.provideService(SecureRandom.SecureRandom, {
            ...crypto,
            uuidV4: () =>
              Effect.gen(function* () {
                tokens++;
                if (tokens === 128) yield* Deferred.succeed(atCapacity, undefined);
                yield* Deferred.await(release);
                return yield* crypto.uuidV4();
              }),
          }),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            readFileString: (filename, encoding) =>
              filename === f.filename(f.homes[0])
                ? Effect.succeed('{corrupt')
                : f.fs.readFileString(filename, encoding),
          }),
        );
        yield* Effect.gen(function* () {
          const owners = yield* Effect.forEach(Array.from({length: 128}), () =>
            admission.withForeground(f.homes[0], Effect.die('must not execute')).pipe(Effect.exit, Effect.forkScoped),
          );
          yield* Deferred.await(atCapacity);
          expect(Exit.isFailure(yield* Effect.exit(admission.withForeground(f.homes[1], Effect.void)))).toBe(true);
          expect(tokens).toBe(128);
          yield* Deferred.succeed(release, undefined);
          for (const owner of owners) expect(Exit.isFailure(yield* Fiber.join(owner))).toBe(true);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }).pipe(TestClock.withLive),
    );

    it.effect('releases reservations for rejected CPU batches without exhausting foreground capacity', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const admission = yield* makeBackgroundInferenceAdmission.pipe(
          Effect.provideService(SystemInfo, {...f.system, cpuTimes: succeedUndefined}),
        );
        yield* TestClock.adjust(1000);
        for (let index = 0; index < 132; index++)
          expect(yield* admission.runBatch(f.homes[0], 'graph', Effect.die('must not execute'))).toEqual({
            state: 'deferred',
            reason: 'cpu-unknown',
          });
        expect(yield* admission.withForeground(f.homes[0], Effect.succeed('ready'))).toBe('ready');
      }),
    );

    it.effect('releases a reservation when UUID generation fails before publication', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const crypto = yield* SecureRandom.SecureRandom;
        let failing = true;
        const admission = yield* makeBackgroundInferenceAdmission.pipe(
          Effect.provideService(SystemInfo, f.system),
          Effect.provideService(SecureRandom.SecureRandom, {
            ...crypto,
            uuidV4: () => Effect.suspend(() => (failing ? Effect.die('synthetic UUID failure') : crypto.uuidV4())),
          }),
        );
        for (let index = 0; index < 132; index++)
          expect(Exit.isFailure(yield* Effect.exit(admission.withForeground(f.homes[0], Effect.void)))).toBe(true);
        failing = false;
        expect(yield* admission.withForeground(f.homes[0], Effect.succeed('ready'))).toBe('ready');
      }),
    );
  });
});
