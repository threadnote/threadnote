import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Crypto, Deferred, Effect, FileSystem, Fiber, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {makeBackgroundInferenceAdmission} from '../src/background/admission.js';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  makeBackgroundWorkerLifecycle,
  inspectBackgroundWorkerControl,
  BACKGROUND_WORKER_LOCK_STALE_MILLISECONDS,
  wakeBackgroundWorker,
  type BackgroundWorkerControlOptions,
} from '../src/background/worker-control.js';

const policy = Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
  Layer.succeed(ChildEnvironmentPolicy, {
    preserveIntendedChild: environment => environment,
    sanitizeExternal: environment => environment,
  }),
);
const platform = Layer.mergeAll(BunServices.layer, SystemInfo.layer.pipe(Layer.provide(policy)));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const actual = yield* SystemInfo;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'background-worker-control-'});
  const identities = new Map<number, string | undefined>([[actual.processId, 'fixture-self']]);
  const system = SystemInfo.of({
    ...actual,
    isProcessRunning: pid => identities.has(pid),
    processStartIdentity: pid => Effect.succeed(identities.get(pid)),
    canonicalProcessStartIdentity: pid => Effect.succeed(identities.get(pid)),
  });
  const launches: string[] = [];
  const options: BackgroundWorkerControlOptions = {
    home,
    lockPath: path.join(home, 'worker.lock'),
    receiptPath: path.join(home, 'worker.json'),
    protocol: 2,
    version: 'fixture-v2',
    launch: nonce =>
      Effect.sync(() => {
        launches.push(nonce);
        return true;
      }),
  };
  const owner = {
    token: yield* (yield* Crypto.Crypto).randomUUIDv4(),
    processId: actual.processId,
    processStartIdentity: 'fixture-self',
  };
  const withHomeLock = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    withExclusiveFileLock(
      fs,
      options.lockPath,
      {
        createParentDirectory: false,
        retryIntervalMilliseconds: 1,
        staleAfterMilliseconds: 120_000,
        waitTimeoutMilliseconds: 0,
        useCanonicalProcessStartIdentity: true,
      },
      program,
    );
  const receipt = fs.writeFileString(
    options.receiptPath,
    JSON.stringify({...owner, protocol: 2, version: options.version}),
  );
  const run = <A, E, R>(program: Effect.Effect<A, E, R>) => program.pipe(Effect.provideService(SystemInfo, system));
  return {fs, home, system, identities, options, owner, launches, withHomeLock, receipt, run};
});

describe('background launch and exit control', () => {
  for (const futureFields of [false, true])
    effectIt.effect(
      `preserves incompatible control bytes before wake (${futureFields ? 'future fields' : 'known schema'})`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const filename = f.options.receiptPath + '.launch-v2.json';
          const original = JSON.stringify(
            {
              version: 1,
              protocol: futureFields ? 999 : 2,
              runtimeVersion: 'another-runtime',
              wakeSequence: 7,
              active: {nonce: f.owner.token, owner: f.owner},
              ...(futureFields ? {requiredFutureMetadata: {keep: true}} : {}),
            },
            null,
            2,
          );
          yield* f.fs.writeFileString(filename, original);
          yield* f.run(
            Effect.gen(function* () {
              expect(yield* wakeBackgroundWorker(f.options)).toEqual({
                state: 'deferred',
                reason: futureFields ? 'control-unavailable' : 'legacy-owner',
              });
              expect(yield* f.fs.readFileString(filename)).toBe(original);
              expect(f.launches).toHaveLength(0);
            }),
          );
        }).pipe(provideFixtureLayer(platform)),
    );
  effectIt.effect('adopts a retired same-protocol worker version without changing durable domain demand', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run(
        Effect.gen(function* () {
          yield* f.fs.writeFileString(f.home + '/demand.json', 'durable-checkpoint');
          yield* wakeBackgroundWorker(f.options);
          const old = yield* makeBackgroundWorkerLifecycle(f.options, f.launches[0]);
          yield* f.withHomeLock(
            Effect.gen(function* () {
              expect(yield* old.activate(f.owner)).toBe(true);
              yield* f.receipt;
              yield* old.beforeScan;
            }),
          );
          yield* old.afterRelease(true);
          const filename = f.options.receiptPath + '.launch-v2.json';
          const retired = yield* f.fs.readFileString(filename);
          const next = {...f.options, version: 'fixture-v3'};
          expect(yield* inspectBackgroundWorkerControl(next)).toEqual({state: 'queued'});
          expect(yield* f.fs.readFileString(filename)).toBe(retired);
          expect(yield* wakeBackgroundWorker(next)).toEqual({state: 'started'});
          expect(JSON.parse(yield* f.fs.readFileString(filename))).toMatchObject({
            runtimeVersion: next.version,
            wakeSequence: 2,
          });
          expect(yield* old.activate(f.owner)).toBe(false);
          expect(yield* f.fs.readFileString(f.home + '/demand.json')).toBe('durable-checkpoint');
        }),
      );
    }).pipe(provideFixtureLayer(platform)),
  );

  for (const ownerState of ['live', 'unknown', 'dead', 'reused'] as const)
    effectIt.effect(`same-protocol version transition preserves ${ownerState} owner evidence`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const owner = {...f.owner, processId: 1234567, processStartIdentity: 'old-instance'};
        f.identities.set(owner.processId, owner.processStartIdentity);
        yield* f.run(
          Effect.gen(function* () {
            yield* wakeBackgroundWorker(f.options);
            const old = yield* makeBackgroundWorkerLifecycle(f.options, f.launches[0]);
            yield* f.withHomeLock(
              Effect.gen(function* () {
                expect(yield* old.activate(owner)).toBe(true);
                yield* f.fs.writeFileString(
                  f.options.receiptPath,
                  JSON.stringify({...owner, protocol: f.options.protocol, version: f.options.version}),
                );
              }),
            );
            if (ownerState === 'dead') f.identities.delete(owner.processId);
            if (ownerState === 'reused') f.identities.set(owner.processId, 'different-instance');
            if (ownerState === 'unknown') f.identities.set(owner.processId, undefined);
            const next = {...f.options, version: 'fixture-v3'};
            const filename = f.options.receiptPath + '.launch-v2.json';
            const before = yield* f.fs.readFileString(filename);
            const receipt = yield* f.fs.readFileString(f.options.receiptPath);
            const eligible = ownerState === 'dead' || ownerState === 'reused';
            expect(yield* inspectBackgroundWorkerControl(next)).toEqual({state: eligible ? 'queued' : 'legacy-owner'});
            expect(yield* f.fs.readFileString(filename)).toBe(before);
            expect(yield* wakeBackgroundWorker(next)).toEqual(
              eligible ? {state: 'started'} : {state: 'deferred', reason: 'legacy-owner'},
            );
            expect(f.launches).toHaveLength(eligible ? 2 : 1);
            expect(yield* f.fs.readFileString(f.options.receiptPath)).toBe(receipt);
            if (!eligible) expect(yield* f.fs.readFileString(filename)).toBe(before);
          }),
        );
      }).pipe(provideFixtureLayer(platform)),
    );

  effectIt.effect('retains incompatible starting authorization until expiry and never adopts an unknown protocol', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run(
        Effect.gen(function* () {
          yield* wakeBackgroundWorker(f.options);
          const filename = f.options.receiptPath + '.launch-v2.json';
          const original = yield* f.fs.readFileString(filename);
          const next = {...f.options, version: 'fixture-v3'};
          expect(yield* wakeBackgroundWorker(next)).toEqual({state: 'deferred', reason: 'legacy-owner'});
          expect(yield* f.fs.readFileString(filename)).toBe(original);
          yield* TestClock.adjust(15_001);
          const unknown = {...next, protocol: f.options.protocol + 1};
          expect(yield* inspectBackgroundWorkerControl(unknown)).toEqual({state: 'legacy-owner'});
          expect(yield* wakeBackgroundWorker(unknown)).toEqual({state: 'deferred', reason: 'legacy-owner'});
          expect(yield* f.fs.readFileString(filename)).toBe(original);
          expect(yield* wakeBackgroundWorker(next)).toEqual({state: 'started'});
          expect(f.launches).toHaveLength(2);
        }),
      );
    }).pipe(provideFixtureLayer(platform)),
  );

  fcEffectProp(
    effectIt,
    'version changes retain the original stale receipt proof through unconfirmed spawns',
    {
      versions: fc.array(fc.integer({min: 0, max: 1000}), {minLength: 2, maxLength: 4}),
    },
    ({versions}) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const owner = {...f.owner, processId: 1234567, processStartIdentity: 'old-instance'};
        f.identities.set(owner.processId, owner.processStartIdentity);
        yield* f.run(
          Effect.gen(function* () {
            yield* wakeBackgroundWorker(f.options);
            const old = yield* makeBackgroundWorkerLifecycle(f.options, f.launches[0]);
            yield* f.withHomeLock(
              Effect.gen(function* () {
                expect(yield* old.activate(owner)).toBe(true);
                yield* f.fs.writeFileString(
                  f.options.receiptPath,
                  JSON.stringify({...owner, protocol: f.options.protocol, version: f.options.version}),
                );
              }),
            );
            const receipt = yield* f.fs.readFileString(f.options.receiptPath);
            f.identities.set(owner.processId, 'different-instance');
            for (const version of versions) {
              yield* TestClock.adjust(15_001);
              const next = {
                ...f.options,
                version: 'new-' + version,
                launch: (nonce: string) => f.options.launch(nonce).pipe(Effect.as(false)),
              };
              expect(yield* wakeBackgroundWorker(next)).toEqual({state: 'deferred', reason: 'spawn-unconfirmed'});
              const state = JSON.parse(yield* f.fs.readFileString(f.options.receiptPath + '.launch-v2.json'));
              expect(state.runtimeVersion).toBe(next.version);
              expect(state.staleReceipt.runtimeVersion).toBe(f.options.version);
              expect(yield* f.fs.readFileString(f.options.receiptPath)).toBe(receipt);
            }
            expect(f.launches).toHaveLength(versions.length + 1);
          }),
        );
      }).pipe(provideFixtureLayer(platform)),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect('coalesces starting wakes without waiting for a worker readiness receipt', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run(
        Effect.gen(function* () {
          expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'started'});
          expect(yield* f.fs.exists(f.options.receiptPath)).toBe(false);
          expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'starting'});
          expect(f.launches).toHaveLength(1);
        }),
      );
    }).pipe(provideFixtureLayer(platform)),
  );

  effectIt.effect('bounds a missing spawn acknowledgement and leaves the nonce pending', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const options = {
        ...f.options,
        launch: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      };
      yield* f.run(
        Effect.gen(function* () {
          const wake = yield* wakeBackgroundWorker(options).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(250);
          expect(yield* Fiber.join(wake)).toEqual({state: 'deferred', reason: 'spawn-unconfirmed'});
          expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'starting'});
          expect(f.launches).toHaveLength(0);
        }),
      );
    }).pipe(provideFixtureLayer(platform)),
  );

  effectIt.effect('rejects a delayed expired nonce before activation and admits its replacement', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run(
        Effect.gen(function* () {
          yield* wakeBackgroundWorker(f.options);
          const old = yield* makeBackgroundWorkerLifecycle(f.options, f.launches[0]);
          yield* TestClock.adjust(15_001);
          yield* wakeBackgroundWorker(f.options);
          expect(f.launches).toHaveLength(2);
          yield* f.withHomeLock(
            Effect.gen(function* () {
              expect(yield* old.activate(f.owner)).toBe(false);
              expect(yield* f.fs.exists(f.options.receiptPath)).toBe(false);
            }),
          );
          const current = yield* makeBackgroundWorkerLifecycle(f.options, f.launches[1]);
          yield* f.withHomeLock(
            Effect.gen(function* () {
              expect(yield* current.activate(f.owner)).toBe(true);
              yield* f.receipt;
              yield* current.beforeScan;
            }),
          );
          yield* current.afterRelease(true);
          expect(f.launches).toHaveLength(2);
        }),
      );
    }).pipe(provideFixtureLayer(platform)),
  );

  effectIt.effect('retains unknown live legacy owners instead of spawning repeatedly around them', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.identities.set(1234567, undefined);
      yield* f.fs.writeFileString(
        f.options.receiptPath,
        JSON.stringify({processId: 1234567, processStartIdentity: 'legacy', protocol: 1}),
      );
      yield* f.run(
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 3; attempt++)
            expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'deferred', reason: 'legacy-owner'});
          expect(f.launches).toHaveLength(0);
          expect(JSON.parse(yield* f.fs.readFileString(f.options.receiptPath)).processStartIdentity).toBe('legacy');
        }),
      );
    }).pipe(provideFixtureLayer(platform)),
  );

  effectIt.effect('leaves malformed control and a removed home untouched', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const filename = f.options.receiptPath + '.launch-v2.json';
      yield* f.fs.writeFileString(filename, '{"version":999}');
      yield* f.run(
        Effect.gen(function* () {
          expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'deferred', reason: 'control-unavailable'});
          expect(yield* f.fs.readFileString(filename)).toBe('{"version":999}');
          yield* f.fs.remove(f.home, {recursive: true});
          expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'deferred', reason: 'control-unavailable'});
          expect(yield* f.fs.exists(f.home)).toBe(false);
          expect(f.launches).toHaveLength(0);
        }),
      );
    }).pipe(provideFixtureLayer(platform)),
  );

  for (const condition of ['reused', 'unknown', 'different-receipt', 'incompatible'] as const)
    effectIt.effect(`preserves owner evidence while recovering a ${condition} process identity`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.run(
          Effect.gen(function* () {
            yield* wakeBackgroundWorker(f.options);
            const lifecycle = yield* makeBackgroundWorkerLifecycle(f.options, f.launches[0]);
            yield* f.withHomeLock(
              Effect.gen(function* () {
                expect(yield* lifecycle.activate(f.owner)).toBe(true);
                yield* f.receipt;
              }),
            );
            f.identities.set(f.owner.processId, condition === 'unknown' ? undefined : 'replacement-process');
            if (condition === 'different-receipt')
              yield* f.fs.writeFileString(
                f.options.receiptPath,
                JSON.stringify({...f.owner, token: 'another-owner', protocol: 2, version: f.options.version}),
              );
            const receipt = yield* f.fs.readFileString(f.options.receiptPath);
            const options = condition === 'incompatible' ? {...f.options, version: 'another-runtime'} : f.options;
            expect(yield* wakeBackgroundWorker(options)).toEqual(
              condition === 'reused' || condition === 'incompatible'
                ? {state: 'started'}
                : condition === 'unknown'
                  ? {state: 'active'}
                  : {state: 'deferred', reason: 'legacy-owner'},
            );
            expect(f.launches).toHaveLength(condition === 'reused' || condition === 'incompatible' ? 2 : 1);
            expect(yield* f.fs.readFileString(f.options.receiptPath)).toBe(receipt);
          }),
        );
      }).pipe(provideFixtureLayer(platform)),
    );

  for (const crossVersion of [false, true])
    effectIt.effect(
      `waits for matching stale lock age before replacement (${crossVersion ? 'new runtime' : 'same runtime'})`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.run(
            Effect.gen(function* () {
              yield* wakeBackgroundWorker(f.options);
              const lifecycle = yield* makeBackgroundWorkerLifecycle(f.options, f.launches[0]);
              yield* f.withHomeLock(
                Effect.gen(function* () {
                  expect(yield* lifecycle.activate(f.owner)).toBe(true);
                  yield* f.receipt;
                }),
              );
              const lock = JSON.stringify({...f.owner, version: 1});
              yield* f.fs.writeFileString(f.options.lockPath, lock);
              yield* f.fs.utimes(f.options.lockPath, 0, 0);
              f.identities.set(f.owner.processId, 'replacement-process');
              const options = {...f.options, version: crossVersion ? 'fixture-v3' : f.options.version};
              const control = yield* f.fs.readFileString(f.options.receiptPath + '.launch-v2.json');
              for (let attempt = 0; attempt < 3; attempt++) {
                expect(yield* wakeBackgroundWorker(options)).toEqual({
                  state: 'deferred',
                  reason: 'owner-lock-fresh',
                });
                yield* TestClock.adjust(15_001);
              }
              expect(f.launches).toHaveLength(1);
              if (crossVersion)
                expect(yield* f.fs.readFileString(f.options.receiptPath + '.launch-v2.json')).toBe(control);
              expect(yield* f.fs.readFileString(f.options.lockPath)).toBe(lock);
              yield* TestClock.adjust(BACKGROUND_WORKER_LOCK_STALE_MILLISECONDS);
              expect(yield* wakeBackgroundWorker(options)).toEqual({state: 'started'});
              expect(yield* wakeBackgroundWorker(options)).toEqual({state: 'starting'});
              expect(f.launches).toHaveLength(2);
              expect(yield* f.fs.readFileString(f.options.lockPath)).toBe(lock);
              // Recovery and removal remain the actual child's ordinary lock operation.
              yield* f.withHomeLock(Effect.void);
              expect(yield* f.fs.exists(f.options.lockPath)).toBe(false);
            }),
          );
        }).pipe(provideFixtureLayer(platform)),
    );

  for (const crossVersion of [false, true])
    for (const gap of ['spawn-unconfirmed', 'activation-crash', 'replaced-lock'] as const)
      effectIt.effect(
        `retains exact stale-file recovery proof across ${gap} (${crossVersion ? 'new runtime' : 'same runtime'})`,
        () =>
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.run(
              Effect.gen(function* () {
                yield* wakeBackgroundWorker(f.options);
                const initial = yield* makeBackgroundWorkerLifecycle(f.options, f.launches[0]);
                yield* f.withHomeLock(initial.activate(f.owner).pipe(Effect.andThen(f.receipt)));
                const receipt = yield* f.fs.readFileString(f.options.receiptPath);
                f.identities.set(f.owner.processId, 'second-process');
                let lock: string | undefined;
                const claimedOptions = {...f.options, version: crossVersion ? 'fixture-v3' : f.options.version};
                const recoveryOptions = {...f.options, version: crossVersion ? 'fixture-v4' : f.options.version};
                if (gap !== 'spawn-unconfirmed') {
                  expect(yield* wakeBackgroundWorker(claimedOptions)).toEqual({state: 'started'});
                  const next = yield* makeBackgroundWorkerLifecycle(claimedOptions, f.launches.at(-1)!);
                  const replacement = {
                    ...f.owner,
                    token: yield* (yield* Crypto.Crypto).randomUUIDv4(),
                    processStartIdentity: 'second-process',
                  };
                  yield* f.withHomeLock(next.activate(replacement));
                  if (crossVersion) {
                    const state = JSON.parse(yield* f.fs.readFileString(f.options.receiptPath + '.launch-v2.json'));
                    expect(state.runtimeVersion).toBe(claimedOptions.version);
                    expect(state.staleReceipt.runtimeVersion).toBe(f.options.version);
                  }
                  // The child died after active ownership but before replacing the older receipt.
                  lock = JSON.stringify({...replacement, version: 1});
                  yield* f.fs.writeFileString(f.options.lockPath, lock);
                  yield* f.fs.utimes(f.options.lockPath, 0, 0);
                  f.identities.set(f.owner.processId, 'third-process');
                  yield* TestClock.adjust(BACKGROUND_WORKER_LOCK_STALE_MILLISECONDS + 1);
                }
                const unconfirmed = {
                  ...recoveryOptions,
                  launch: (nonce: string) => f.options.launch(nonce).pipe(Effect.as(false)),
                };
                expect(yield* wakeBackgroundWorker(unconfirmed)).toEqual({
                  state: 'deferred',
                  reason: 'spawn-unconfirmed',
                });
                expect(
                  JSON.parse(yield* f.fs.readFileString(f.options.receiptPath + '.launch-v2.json')).staleReceipt
                    .runtimeVersion,
                ).toBe(f.options.version);
                if (gap === 'replaced-lock') {
                  lock = JSON.stringify({...JSON.parse(lock!), token: yield* (yield* Crypto.Crypto).randomUUIDv4()});
                  yield* f.fs.writeFileString(f.options.lockPath, lock);
                  yield* f.fs.utimes(f.options.lockPath, 0, 0);
                }
                yield* TestClock.adjust(15_001);
                if (gap === 'replaced-lock') {
                  expect(yield* wakeBackgroundWorker(recoveryOptions)).toEqual({
                    state: 'deferred',
                    reason: 'legacy-owner',
                  });
                  expect(f.launches).toHaveLength(3);
                  expect(yield* f.fs.readFileString(f.options.lockPath)).toBe(lock);
                  return;
                }
                expect(yield* wakeBackgroundWorker(recoveryOptions)).toEqual({state: 'started'});
                expect(yield* wakeBackgroundWorker(recoveryOptions)).toEqual({state: 'starting'});
                expect(f.launches).toHaveLength(gap === 'spawn-unconfirmed' ? 3 : 4);
                expect(yield* f.fs.readFileString(f.options.receiptPath)).toBe(receipt);
                if (lock !== undefined) expect(yield* f.fs.readFileString(f.options.lockPath)).toBe(lock);
              }),
            );
          }).pipe(provideFixtureLayer(platform)),
      );

  fcEffectProp(
    effectIt,
    'every wake racing the last scan or actual lock release has one successor',
    {
      beforeRelease: fc.integer({min: 0, max: 4}),
      afterRelease: fc.integer({min: 0, max: 4}),
    },
    ({beforeRelease, afterRelease}) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.run(
          Effect.gen(function* () {
            yield* wakeBackgroundWorker(f.options);
            const lifecycle = yield* makeBackgroundWorkerLifecycle(f.options, f.launches[0]);
            yield* f.withHomeLock(
              Effect.gen(function* () {
                expect(yield* lifecycle.activate(f.owner)).toBe(true);
                yield* f.receipt;
                yield* lifecycle.beforeScan;
                for (let index = 0; index < beforeRelease; index++)
                  expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'active'});
                expect((yield* lifecycle.afterRelease(true).pipe(Effect.result))._tag).toBe('Failure');
                expect(yield* f.fs.exists(f.options.receiptPath)).toBe(true);
              }),
            );
            for (let index = 0; index < afterRelease; index++)
              expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'active'});
            expect(f.launches).toHaveLength(1);
            yield* lifecycle.afterRelease(true);
            expect(f.launches).toHaveLength(beforeRelease + afterRelease > 0 ? 2 : 1);
            expect(yield* f.fs.exists(f.options.receiptPath)).toBe(false);
            if (beforeRelease + afterRelease > 0)
              expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'starting'});
            else expect(yield* wakeBackgroundWorker(f.options)).toEqual({state: 'started'});
            expect(f.launches).toHaveLength(2);
            // A late old activation cannot consume the successor nonce.
            expect(yield* lifecycle.activate(f.owner)).toBe(false);
          }),
        );
      }).pipe(provideFixtureLayer(platform)),
    {fastCheck: {numRuns: 24}},
  );
  fcEffectProp(
    effectIt,
    'short idle units use fresh rolling CPU samples and yield to busy CPU and foreground',
    {
      count: fc.integer({min: 30, max: 60}),
      step: fc.integer({min: 10, max: 30}),
    },
    ({count, step}) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let previousTime = yield* Clock.currentTimeMillis;
        let idle = 0;
        let busy = false;
        const system = SystemInfo.of({
          ...f.system,
          cpuTimes: Clock.currentTimeMillis.pipe(
            Effect.map(now => {
              idle += busy ? 0 : (now - previousTime) * 4;
              previousTime = now;
              return {logicalCpus: 4, totalMilliseconds: now * 4, idleMilliseconds: idle};
            }),
          ),
        });
        const admission = yield* makeBackgroundInferenceAdmission.pipe(Effect.provideService(SystemInfo, system));
        expect(yield* admission.runBatch(f.home, 'graph', Effect.succeed('unit'))).toMatchObject({
          state: 'deferred',
          reason: 'cpu-unknown',
        });
        yield* TestClock.adjust(500);
        for (let unit = 0; unit < count; unit++) {
          expect(yield* admission.runBatch(f.home, 'graph', Effect.succeed('unit'))).toEqual({
            state: 'completed',
            value: 'unit',
          });
          yield* TestClock.adjust(step);
        }
        expect(yield* admission.withForeground(f.home, admission.runBatch(f.home, 'graph', Effect.void))).toMatchObject(
          {state: 'deferred', reason: 'foreground'},
        );
        busy = true;
        yield* TestClock.adjust(1000);
        expect(yield* admission.runBatch(f.home, 'graph', Effect.void)).toMatchObject({
          state: 'deferred',
          reason: 'cpu-busy',
        });
      }).pipe(provideFixtureLayer(platform)),
    {fastCheck: {numRuns: 16}},
  );
});

function provideFixtureLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(program: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
}
