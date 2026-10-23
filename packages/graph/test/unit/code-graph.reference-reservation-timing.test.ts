import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {SystemInfo} from '@threadnote/platform/system';
import {withCodeGraphDiskReservation, type CodeGraphDiskReservationOptions} from '../../src/disk/reservation.js';
import {withCodeGraphIndexTiming, type CodeGraphIndexTimingObserver} from '../../src/indexer/types.js';

const stages = ['owner-identity', 'claim', 'use', 'release'].map(stage => `reference-reservation-${stage}`);
const completeEvents = ['owner', 'owner', 'claim', 'use', 'release', 'owner'];
const provideFixtureLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-reference-reservation-timing-'});
  const events: string[] = [];
  const options = {
    boundary: {operation: 'resolve persistent code graph references', finalFactBytes: 1, rowCount: 1},
    ledgerLockPath: path.join(root, 'ledger.lock'),
    ledgerRoot: path.join(root, 'ledger'),
    maintenance: Effect.die('unexpected maintenance'),
    observe: Effect.sync(() => {
      events.push('claim');
      return {
        demand: {
          calibrationIdentity: 'fixture-v1',
          mainHighWaterBytes: 10,
          recoveryFloorBytes: 10,
          state: 'measured' as const,
          transientFilesystem: 'durable' as const,
          transientHighWaterBytes: 10,
        },
        durableAvailableBytes: 100,
        durableFilesystemKey: 'a'.repeat(64),
        freelistBytes: 0,
        temporaryAvailableBytes: 100,
        temporaryFilesystemKey: 'a'.repeat(64),
      };
    }),
    beforeReleaseAttempt: Effect.sync(() => {
      events.push('release');
    }),
  } satisfies CodeGraphDiskReservationOptions;
  const unexpected = () => {
    throw TestError.make({message: 'Unexpected system operation outside the synthetic reservation fixture'});
  };
  const system = SystemInfo.of({
    architecture: 'fixture',
    availableDiskBytes: unexpected,
    currentDirectory: () => root,
    environment: () => ({}),
    developmentEntrypoint: 'fixture',
    intendedChildEnvironment: unexpected,
    executablePath: 'fixture',
    homeDirectory: root,
    hardwareInfo: Effect.die('unexpected hardware observation'),
    memoryUsage: unexpected,
    runtimeVersion: 'fixture',
    pathDelimiter: ':',
    processArguments: [],
    readLine: unexpected,
    signalProcess: unexpected,
    setExitCode: unexpected,
    setEnvironmentVariable: unexpected,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    tempDirectory: root,
    userName: 'fixture',
    platform: 'linux',
    processId: 4242,
    isProcessRunning: () => false,
    canonicalProcessStartIdentity: () =>
      Effect.sync(() => {
        events.push('owner');
        return 'linux:123';
      }),
    processStartIdentity: () => Effect.succeed('linux:123'),
  });
  return {fs, options, events, system};
});

effectIt.effect('observes the original reference reservation owner, claim, use and release in order', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const observed: string[] = [];
    const options = {
      ...f.options,
      onTiming: (stage: string) =>
        Effect.sync(() => {
          observed.push(`start:${stage}`);
          return Effect.sync(() => {
            observed.push(`end:${stage}`);
          });
        }),
    };
    const result = yield* withCodeGraphDiskReservation(
      options,
      Effect.sync(() => {
        f.events.push('use');
        return 'value';
      }),
    ).pipe(Effect.provideService(SystemInfo, f.system));
    expect(result).toBe('value');
    expect(f.events).toEqual(completeEvents);
    expect(observed).toEqual(stages.flatMap(stage => [`start:${stage}`, `end:${stage}`]));
    expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
  }).pipe(TestClock.withLive, provideFixtureLayer),
);

effectIt.effect('keeps the original effect when timing is disabled and observes no other operation', () =>
  Effect.gen(function* () {
    const program = Effect.succeed('original');
    expect(withCodeGraphIndexTiming(undefined, 'reference-reservation-use', program)).toBe(program);
    const f = yield* fixture;
    const options = {
      ...f.options,
      boundary: {...f.options.boundary, operation: 'resolve persistent code graph reexport aliases' as const},
      onTiming: () => Effect.die('other operations must not invoke the observer'),
    };
    let observations = 0;
    const result = yield* withCodeGraphDiskReservation(
      {
        ...options,
        onTiming: () => {
          observations++;
          return options.onTiming();
        },
      },
      Effect.sync(() => {
        f.events.push('use');
        return 'original';
      }),
    ).pipe(Effect.provideService(SystemInfo, f.system));
    expect(result).toBe('original');
    expect(observations).toBe(0);
    expect(f.events).toEqual(completeEvents);
  }).pipe(TestClock.withLive, provideFixtureLayer),
);

effectIt.effect('a refused original acquisition never executes the transaction or release', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const observed: string[] = [];
    const exit = yield* withCodeGraphDiskReservation(
      {
        ...f.options,
        observe: Effect.fail(TestError.make({message: 'original observation unavailable'})),
        onTiming: stage =>
          Effect.sync(() => {
            observed.push(`start:${stage}`);
            return Effect.sync(() => {
              observed.push(`end:${stage}`);
            });
          }),
      },
      Effect.sync(() => {
        f.events.push('use');
      }),
    ).pipe(Effect.provideService(SystemInfo, f.system), Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(f.events).toEqual(['owner', 'owner']);
    expect(observed).toEqual(stages.slice(0, 2).flatMap(stage => [`start:${stage}`, `end:${stage}`]));
    expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
  }).pipe(TestClock.withLive, provideFixtureLayer),
);

const observerModes = ['normal', 'throw', 'start-failure', 'start-defect', 'end-failure', 'end-defect'] as const;
const observerFor =
  (mode: (typeof observerModes)[number]): CodeGraphIndexTimingObserver =>
  () => {
    const failure = TestError.make({message: 'observer-only failure'});
    if (mode === 'throw') throw failure;
    if (mode === 'start-failure') return Effect.fail(failure);
    if (mode === 'start-defect') return Effect.die(failure);
    if (mode === 'end-failure') return Effect.succeed(Effect.fail(failure));
    if (mode === 'end-defect') return Effect.succeed(Effect.die(failure));
    return Effect.succeed(Effect.void);
  };

effectIt.effect(
  'observer startup and completion failures or defects preserve original success, typed failures and defects',
  () =>
    Effect.gen(function* () {
      const failure = TestError.make({message: 'original program failure'});
      for (const mode of observerModes) {
        for (const outcome of ['success', 'failure', 'defect']) {
          const f = yield* fixture;
          const original =
            outcome === 'success'
              ? Effect.succeed('value')
              : outcome === 'failure'
                ? Effect.fail(failure)
                : Effect.die(failure);
          const program = Effect.sync(() => {
            f.events.push('use');
          }).pipe(Effect.andThen(original));
          const actual = yield* withCodeGraphDiskReservation({...f.options, onTiming: observerFor(mode)}, program).pipe(
            Effect.provideService(SystemInfo, f.system),
            Effect.exit,
          );
          const expected = yield* original.pipe(Effect.exit);
          expect(actual).toEqual(expected);
          expect(f.events).toEqual(completeEvents);
          expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
        }
      }
    }).pipe(TestClock.withLive, provideFixtureLayer),
);

effectIt.effect(
  'interruption preserves original transaction cleanup and reservation release despite observer defects',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      let cleaned = 0;
      const fiber = yield* withCodeGraphDiskReservation(
        {...f.options, onTiming: observerFor('end-defect')},
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              cleaned++;
            }),
          ),
        ),
      ).pipe(Effect.provideService(SystemInfo, f.system), Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(cleaned).toBe(1);
      expect(f.events.filter(event => event === 'release')).toHaveLength(1);
      expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
    }).pipe(TestClock.withLive, provideFixtureLayer),
);

fcEffectProp(
  effectIt,
  'optional reference timing preserves outcomes, exact work and immutable request fields',
  {
    enabled: fc.boolean(),
    otherOperation: fc.boolean(),
    mode: fc.constantFrom(...observerModes),
    outcome: fc.constantFrom('success', 'failure', 'defect'),
    value: fc.integer(),
  },
  input =>
    Effect.gen(function* () {
      const originalInput = {...input};
      const f = yield* fixture;
      const boundary = Object.freeze({
        ...f.options.boundary,
        ...(input.otherOperation ? {operation: 'stage persistent code graph facts' as const} : {}),
      });
      const beforeBoundary = {...boundary};
      let observerCalls = 0;
      const observer = observerFor(input.mode);
      const options = Object.freeze({
        ...f.options,
        boundary,
        ...(input.enabled
          ? {
              onTiming: (stage: Parameters<CodeGraphIndexTimingObserver>[0]) => {
                observerCalls++;
                expect(stages).toContain(stage);
                return observer(stage);
              },
            }
          : {}),
      });
      const failure = TestError.make({message: 'original property outcome'});
      const outcome =
        input.outcome === 'success'
          ? Effect.succeed(input.value)
          : input.outcome === 'failure'
            ? Effect.fail(failure)
            : Effect.die(failure);
      const actual = yield* withCodeGraphDiskReservation(
        options,
        Effect.sync(() => {
          f.events.push('use');
        }).pipe(Effect.andThen(outcome)),
      ).pipe(Effect.provideService(SystemInfo, f.system), Effect.exit);
      expect(actual).toEqual(yield* outcome.pipe(Effect.exit));
      expect(observerCalls).toBe(input.enabled && !input.otherOperation ? 4 : 0);
      expect(f.events).toEqual(completeEvents);
      expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
      expect(boundary).toEqual(beforeBoundary);
      expect(input).toEqual(originalInput);
    }).pipe(TestClock.withLive, provideFixtureLayer),
  {fastCheck: {numRuns: 20}},
);
