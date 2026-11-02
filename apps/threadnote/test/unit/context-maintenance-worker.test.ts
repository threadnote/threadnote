import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {FileLockTimeout} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {
  CONTEXT_MAINTENANCE_WORKER_BUDGET_MS,
  decodeContextMaintenanceWorkerRequest,
  runContextMaintenanceWorker,
} from '../../src/memory/context/maintenance_worker.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

const layer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-maintenance-worker-'});
  return {home, fs, lock: path.join(home, 'context-maintenance', 'worker-v1.lock')};
});
const unexpectedWork = Effect.die('Contending worker must not construct the application.');
const owner = {processId: 2_000_000_000, startIdentity: 'fixture-instance-1'};

describe('automatic maintenance whole-worker ownership', () => {
  effectIt.effect('holds one lease across slow startup, assessment, generation and scoped cleanup', () =>
    Effect.gen(function* () {
      const {home, fs, lock} = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const stage = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const cleanupDone = yield* Deferred.make<void>();
      const worker = yield* runContextMaintenanceWorker(
        home,
        undefined,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupDone))),
          );
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(stage);
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const token = yield* fs.readFileString(lock);
      // Each interval could be pre-command startup or post-assessment work;
      // the whole-worker lease, unlike the assessment lock, spans both.
      for (let wake = 0; wake < 5; wake++) {
        yield* TestClock.adjust('30 seconds');
        expect(yield* runContextMaintenanceWorker(home, undefined, unexpectedWork)).toBe('busy');
        expect(JSON.parse(yield* fs.readFileString(lock)).token).toBe(JSON.parse(token).token);
      }
      yield* Deferred.succeed(stage, undefined);
      yield* Deferred.await(cleanupStarted);
      expect(yield* runContextMaintenanceWorker(home, undefined, unexpectedWork)).toBe('busy');
      yield* Deferred.succeed(cleanupDone, undefined);
      expect(yield* Fiber.join(worker)).toBe('completed');
      expect(yield* fs.exists(lock)).toBe(false);
      expect(yield* runContextMaintenanceWorker(home, undefined, Effect.void)).toBe('completed');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('cancellation keeps an interrupted application import leased until its Promise settles', () =>
    Effect.gen(function* () {
      const {home, fs, lock} = yield* fixture;
      const loading = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      let finishImport = () => {};
      let applicationCalls = 0;
      const loaded = new Promise<void>(resolve => {
        finishImport = resolve;
      });
      const work = Deferred.succeed(loading, undefined).pipe(
        Effect.andThen(
          fromPromiseInterruptibleAwaiting(
            () => loaded,
            cause => cause,
          ),
        ),
        Effect.andThen(Effect.sync(() => applicationCalls++)),
      );
      const worker = yield* runContextMaintenanceWorker(home, undefined, work).pipe(Effect.forkScoped);
      yield* Deferred.await(loading);
      yield* Fiber.interrupt(worker).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)), Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(stopped)).toBe(false);
      expect(yield* runContextMaintenanceWorker(home, undefined, unexpectedWork)).toBe('busy');
      yield* Effect.sync(finishImport);
      yield* Deferred.await(stopped);
      expect(applicationCalls).toBe(0);
      expect(yield* fs.exists(lock)).toBe(false);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('five minutes requests cancellation and waits for finalizers before admitting another tick', () =>
    Effect.gen(function* () {
      const {home} = yield* fixture;
      const started = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const worker = yield* runContextMaintenanceWorker(
        home,
        undefined,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleaned))),
          );
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(CONTEXT_MAINTENANCE_WORKER_BUDGET_MS - 1);
      expect(yield* Deferred.isDone(cleaning)).toBe(false);
      yield* TestClock.adjust(1);
      yield* Deferred.await(cleaning);
      expect(yield* runContextMaintenanceWorker(home, undefined, unexpectedWork)).toBe('busy');
      yield* Deferred.succeed(cleaned, undefined);
      expect(yield* Fiber.join(worker)).toBe('deadline');
      expect(yield* runContextMaintenanceWorker(home, undefined, Effect.void)).toBe('completed');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect.each(['dead', 'reused', 'unknown'] as const)(
    'stops only its work when the MCP owner becomes %s',
    mode =>
      Effect.gen(function* () {
        const {home, fs, lock} = yield* fixture;
        const system = yield* SystemInfo;
        let current = true;
        let finished = false;
        const started = yield* Deferred.make<void>();
        const injected = {
          ...system,
          isProcessRunning: (pid: number) =>
            pid === owner.processId ? mode !== 'dead' || current : system.isProcessRunning(pid),
          canonicalProcessStartIdentity: (pid: number) =>
            pid === owner.processId
              ? Effect.succeed(current ? owner.startIdentity : mode === 'reused' ? 'fixture-instance-2' : undefined)
              : system.canonicalProcessStartIdentity!(pid),
          signalProcess: () => {
            throw new Error('The worker must never signal a PID.');
          },
        };
        const worker = yield* runContextMaintenanceWorker(
          home,
          owner,
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finished = true;
              }),
            ),
          ),
        ).pipe(Effect.provideService(SystemInfo, injected), Effect.forkScoped);
        yield* Deferred.await(started);
        current = false;
        yield* TestClock.adjust('1 second');
        expect(yield* Fiber.join(worker)).toBe('owner-gone');
        expect(finished).toBe(true);
        expect(yield* fs.exists(lock)).toBe(false);
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('rejects an already missing owner before any application construction', () =>
    Effect.gen(function* () {
      const {home} = yield* fixture;
      const system = yield* SystemInfo;
      expect(
        yield* runContextMaintenanceWorker(home, owner, unexpectedWork).pipe(
          Effect.provideService(SystemInfo, {...system, canonicalProcessStartIdentity: undefined}),
        ),
      ).toBe('owner-gone');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('preserves nested failures and releases only its own lease for the next tick', () =>
    Effect.gen(function* () {
      const {home, fs, lock} = yield* fixture;
      const nested = FileLockTimeout.of('/different/lock');
      const result = yield* runContextMaintenanceWorker(home, undefined, Effect.fail(nested)).pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure).toBe(nested);
      expect(yield* fs.exists(lock)).toBe(false);
      expect(yield* runContextMaintenanceWorker(home, undefined, Effect.void)).toBe('completed');
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect.prop(
    'arbitrary wake/finish sequences never admit two workers for one home',
    {
      operations: Schema.Array(
        Schema.Struct({home: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 2})), finish: Schema.Boolean}),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
    },
    ({operations}) =>
      Effect.gen(function* () {
        const homes = yield* Effect.all([fixture, fixture, fixture]);
        const held = new Map<number, {done: Deferred.Deferred<void>; fiber: Fiber.Fiber<unknown, unknown>}>();
        const active = [0, 0, 0];
        for (const operation of operations) {
          const holding = held.get(operation.home);
          if (operation.finish && holding) {
            yield* Deferred.succeed(holding.done, undefined);
            yield* Fiber.join(holding.fiber);
            held.delete(operation.home);
          } else if (holding) {
            expect(yield* runContextMaintenanceWorker(homes[operation.home].home, undefined, unexpectedWork)).toBe(
              'busy',
            );
          } else {
            const started = yield* Deferred.make<void>();
            const done = yield* Deferred.make<void>();
            const fiber = yield* runContextMaintenanceWorker(
              homes[operation.home].home,
              undefined,
              Effect.gen(function* () {
                active[operation.home]++;
                expect(active[operation.home]).toBe(1);
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(done);
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active[operation.home]--;
                  }),
                ),
              ),
            ).pipe(Effect.forkScoped);
            yield* Deferred.await(started);
            held.set(operation.home, {done, fiber});
          }
          expect(active).toEqual(EffectArray.map(homes, (_, i) => (held.has(i) ? 1 : 0)));
        }
        for (const {done, fiber} of held.values()) {
          yield* Deferred.succeed(done, undefined);
          yield* Fiber.join(fiber);
        }
        expect(active).toEqual([0, 0, 0]);
      }).pipe(provideTestLayer(layer)),
    {arbitrary: {runs: 12}},
  );

  effectIt.effect('validates private requests before accessing a home', () =>
    Effect.gen(function* () {
      const request = {
        config: {
          account: 'local',
          agentContextHome: '/fixture',
          agentId: 'test',
          manifestPath: '/fixture/manifest.yaml',
          user: 'tester',
        },
        owner,
      };
      expect(yield* decodeContextMaintenanceWorkerRequest([JSON.stringify(request)])).toEqual(request);
      for (const args of [
        [],
        ['{'],
        [JSON.stringify({...request, owner: {...owner, startIdentity: ''}})],
        [JSON.stringify({...request, config: {...request.config, agentContextHome: 'relative'}})],
        [EffectString.repeat(16_385)('x')],
      ]) {
        expect(Result.isFailure(yield* decodeContextMaintenanceWorkerRequest(args).pipe(Effect.result))).toBe(true);
      }
    }).pipe(provideTestLayer(layer)),
  );
});
