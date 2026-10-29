import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Clock, Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, beforeEach, describe, expect} from 'vitest';
import {withCodeGraphBuilderAdmission} from '@threadnote/graph/builder/admission';
import {codeGraphBuilderAdmissionRoot, codeGraphBuilderAdmissionSlotPath} from '@threadnote/graph/layout';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const BUILDER_ADMISSION_TEST_LAYER = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));

describe('code graph home builder admission', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp('threadnote-builder-admission-');
  });

  afterEach(async () => {
    await rm(home, {force: true, recursive: true});
  });

  effectIt.effect('admits two builders and gives the next slot to queued current-required work', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const trace = yield* Ref.make<string[]>([]);
        const occupied = yield* Ref.make(0);
        const twoOccupied = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();
        const releaseCurrent = yield* Deferred.make<void>();
        const releaseBackground = yield* Deferred.make<void>();
        const backgroundWaiting = yield* Deferred.make<void>();
        const currentWaiting = yield* Deferred.make<void>();
        const currentStarted = yield* Deferred.make<void>();
        const backgroundStarted = yield* Deferred.make<void>();

        const occupant = (name: string, release: Deferred.Deferred<void>) =>
          withCodeGraphBuilderAdmission(
            {admissionClass: 'background', threadnoteHome: home},
            Effect.gen(function* () {
              yield* Ref.update(trace, values => [...values, name]);
              if ((yield* Ref.updateAndGet(occupied, value => value + 1)) === 2) {
                yield* Deferred.succeed(twoOccupied, undefined);
              }
              yield* Deferred.await(release);
            }),
          );

        const firstFiber = yield* occupant('background-1', releaseFirst).pipe(Effect.forkChild);
        const secondFiber = yield* occupant('background-2', releaseSecond).pipe(Effect.forkChild);
        yield* Deferred.await(twoOccupied);

        const backgroundFiber = yield* withCodeGraphBuilderAdmission(
          {
            admissionClass: 'background',
            onWaiting: Deferred.succeed(backgroundWaiting, undefined).pipe(Effect.asVoid),
            threadnoteHome: home,
          },
          Ref.update(trace, values => [...values, 'background-queued']).pipe(
            Effect.andThen(Deferred.succeed(backgroundStarted, undefined)),
            Effect.andThen(Deferred.await(releaseBackground)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(backgroundWaiting);

        const currentFiber = yield* withCodeGraphBuilderAdmission(
          {
            admissionClass: 'current-required',
            onWaiting: Deferred.succeed(currentWaiting, undefined).pipe(Effect.asVoid),
            threadnoteHome: home,
          },
          Ref.update(trace, values => [...values, 'current']).pipe(
            Effect.andThen(Deferred.succeed(currentStarted, undefined)),
            Effect.andThen(Deferred.await(releaseCurrent)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(currentWaiting);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(currentStarted);
        expect(yield* Deferred.isDone(backgroundStarted)).toBe(false);
        expect(yield* Ref.get(trace)).toEqual(expect.arrayContaining(['background-1', 'background-2', 'current']));

        yield* Deferred.succeed(releaseCurrent, undefined);
        yield* Deferred.await(backgroundStarted);
        yield* Deferred.succeed(releaseBackground, undefined);
        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Effect.forEach([firstFiber, secondFiber, currentFiber, backgroundFiber], Fiber.join, {
          concurrency: 'unbounded',
          discard: true,
        });
        expect((yield* Ref.get(trace)).at(-1)).toBe('background-queued');
      }).pipe(provideTestLayer(BUILDER_ADMISSION_TEST_LAYER)),
    ),
  );

  effectIt.effect('reads v1 tickets and recovers a dead ticket while interruption cleans up its exact v2 ticket', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = codeGraphBuilderAdmissionRoot(path, home);
        yield* fs.makeDirectory(root, {recursive: true});
        const now = yield* Clock.currentTimeMillis;
        const legacy = (token: string, processId: number) =>
          fs.writeFileString(
            path.join(root, `v1-${token}.json`),
            JSON.stringify({admissionClass: 'current-required', createdAt: now - 1_000, processId, token, version: 1}),
          );
        yield* legacy(Effect2.pipe('a', EffectString.repeat(64)), system.processId);
        yield* legacy(Effect2.pipe('b', EffectString.repeat(64)), system.processId);
        yield* legacy(Effect2.pipe('c', EffectString.repeat(64)), 2_147_483_647);
        const waiting = yield* Deferred.make<void>();
        const fiber = yield* withCodeGraphBuilderAdmission(
          {
            admissionClass: 'background',
            identity: {
              checkoutId: Effect2.pipe('d', EffectString.repeat(64)),
              worktreeId: Effect2.pipe('e', EffectString.repeat(64)),
            },
            onWaiting: Deferred.succeed(waiting, undefined).pipe(Effect.asVoid),
            threadnoteHome: home,
          },
          Effect.die('legacy tickets must remain ahead'),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        expect(yield* fs.exists(path.join(root, `v1-${Effect2.pipe('c', EffectString.repeat(64))}.json`))).toBe(false);
        const queued = yield* fs.readDirectory(root);
        expect(
          EffectArray.filter(
            queued,
            (name, index) => index in queued && Effect2.pipe(name, EffectString.startsWith('v2-')),
          ),
        ).toHaveLength(1);
        yield* Fiber.interrupt(fiber);
        expect((yield* fs.readDirectory(root)).sort()).toEqual([
          `v1-${Effect2.pipe('a', EffectString.repeat(64))}.json`,
          `v1-${Effect2.pipe('b', EffectString.repeat(64))}.json`,
        ]);
      }).pipe(provideTestLayer(BUILDER_ADMISSION_TEST_LAYER)),
    ),
  );

  effectIt.effect('counts live legacy slot locks and retains rich queue progress while waiting', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const legacyStarted = [yield* Deferred.make<void>(), yield* Deferred.make<void>()] as const;
        const releaseLegacy = [yield* Deferred.make<void>(), yield* Deferred.make<void>()] as const;
        const holdLegacySlot = (slot: 0 | 1) => {
          const slotPath = codeGraphBuilderAdmissionSlotPath(path, home, slot);
          return withExclusiveFileLock(
            fs,
            slotPath,
            {
              heartbeatIntervalMilliseconds: 5_000,
              recoverReusedProcessIdImmediately: true,
              retryIntervalMilliseconds: 1,
              staleAfterMilliseconds: 15_000,
              useCanonicalProcessStartIdentity: true,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.succeed(legacyStarted[slot], undefined).pipe(Effect.andThen(Deferred.await(releaseLegacy[slot]))),
          );
        };
        const legacyFibers = [
          yield* holdLegacySlot(0).pipe(Effect.forkChild),
          yield* holdLegacySlot(1).pipe(Effect.forkChild),
        ] as const;
        yield* Effect.forEach(legacyStarted, Deferred.await, {discard: true});
        for (const slot of [0, 1] as const) {
          expect(yield* fs.exists(`${codeGraphBuilderAdmissionSlotPath(path, home, slot)}.owner.json`)).toBe(false);
        }

        const queued = [yield* Deferred.make<void>(), yield* Deferred.make<void>()] as const;
        const firstAdmitted = yield* Deferred.make<void>();
        const releaseContenders = yield* Deferred.make<void>();
        const admitted = yield* Ref.make(0);
        const resumed = yield* Ref.make(0);
        const latestProgress = yield* Ref.make<unknown>(undefined);
        const contender = (index: 0 | 1) =>
          withCodeGraphBuilderAdmission(
            {
              admissionClass: 'current-required',
              identity: {
                checkoutId: Effect2.pipe(index === 0 ? 'c' : 'd', EffectString.repeat(64)),
                worktreeId: Effect2.pipe(index === 0 ? 'e' : 'f', EffectString.repeat(64)),
              },
              onQueue: queue =>
                Ref.set(latestProgress, {admission: queue, phase: 'waiting', reason: 'home-builder-cap'}).pipe(
                  Effect.andThen(Deferred.succeed(queued[index], undefined)),
                  Effect.asVoid,
                ),
              onResumed: Ref.update(resumed, count => count + 1),
              onWaiting: Effect.void,
              threadnoteHome: home,
            },
            Ref.updateAndGet(admitted, value => value + 1).pipe(
              Effect.tap(count => (count === 1 ? Deferred.succeed(firstAdmitted, undefined) : Effect.void)),
              Effect.andThen(Deferred.await(releaseContenders)),
            ),
          );
        const contenders = [
          yield* contender(0).pipe(Effect.forkChild),
          yield* contender(1).pipe(Effect.forkChild),
        ] as const;
        yield* Effect.forEach(queued, Deferred.await, {discard: true});
        yield* Effect.sleep(75);
        expect(yield* Ref.get(latestProgress)).toMatchObject({
          admission: {admissionClass: 'current-required'},
          phase: 'waiting',
          reason: 'home-builder-cap',
        });
        expect(yield* Ref.get(admitted)).toBe(0);

        yield* Deferred.succeed(releaseLegacy[0], undefined);
        yield* Deferred.await(firstAdmitted);
        yield* Effect.sleep(75);
        expect(yield* Ref.get(admitted)).toBe(1);

        yield* Deferred.succeed(releaseContenders, undefined);
        yield* Effect.forEach(contenders, Fiber.join, {concurrency: 'unbounded', discard: true});
        expect(yield* Ref.get(resumed)).toBe(2);
        yield* Deferred.succeed(releaseLegacy[1], undefined);
        yield* Effect.forEach(legacyFibers, Fiber.join, {concurrency: 'unbounded', discard: true});
      }).pipe(provideTestLayer(BUILDER_ADMISSION_TEST_LAYER)),
    ),
  );

  effectIt.effect('does not report waiting when an observed queue is admitted immediately', () =>
    Effect.gen(function* () {
      const queued = yield* Ref.make(0);
      const resumed = yield* Ref.make(0);
      const waited = yield* Ref.make(0);
      const result = yield* withCodeGraphBuilderAdmission(
        {
          admissionClass: 'current-required',
          identity: {
            checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
            worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
          },
          onResumed: Ref.update(resumed, count => count + 1),
          onQueue: () => Ref.update(queued, count => count + 1),
          onWaiting: Ref.update(waited, count => count + 1),
          threadnoteHome: home,
        },
        Effect.succeed('admitted'),
      );

      expect(result).toBe('admitted');
      expect(yield* Ref.get(queued)).toBe(1);
      expect(yield* Ref.get(resumed)).toBe(0);
      expect(yield* Ref.get(waited)).toBe(0);
    }).pipe(provideTestLayer(BUILDER_ADMISSION_TEST_LAYER)),
  );

  effectIt.effect('removes an interrupted active slot owner and admits subsequent work', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const started = yield* Deferred.make<void>();
        const options = {
          admissionClass: 'background' as const,
          identity: {
            checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
            worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
          },
          threadnoteHome: home,
        };
        const fiber = yield* withCodeGraphBuilderAdmission(
          options,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const slot = codeGraphBuilderAdmissionSlotPath(path, home, 0);
        const ownership = JSON.parse(yield* fs.readFileString(`${slot}.owner.json`));
        const lock = JSON.parse(yield* fs.readFileString(slot));
        expect(ownership).toMatchObject({...options.identity, lockToken: lock.token, version: 2});
        expect(ownership).not.toHaveProperty('path');
        yield* Fiber.interrupt(fiber);
        expect(yield* fs.exists(slot)).toBe(false);
        expect(yield* fs.exists(`${slot}.owner.json`)).toBe(false);
        expect(yield* withCodeGraphBuilderAdmission(options, Effect.succeed('recovered'))).toBe('recovered');
        expect(yield* fs.readDirectory(codeGraphBuilderAdmissionRoot(path, home))).toEqual([]);
      }).pipe(provideTestLayer(BUILDER_ADMISSION_TEST_LAYER)),
    ),
  );
});
