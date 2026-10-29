import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, Ref} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_MILLISECONDS,
  CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_UNITS,
  CODE_GRAPH_MAINTENANCE_LANES,
  codeGraphRemovedViewProvenancePageResult,
  CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT,
  makeCodeGraphMaintenanceCoordinator,
  makeCodeGraphMaintenanceLaneRunner,
  makeCodeGraphOrdinaryMaintenanceRunner,
  type CodeGraphMaintenanceLane,
  type CodeGraphRoutineMaintenanceRun,
  type CodeGraphRoutineMaintenanceTick,
} from '@threadnote/graph/maintenance/coordinator';
import type {CodeGraphRoutineMaintenanceResult} from '@threadnote/graph/store';
import {CodeGraphStoreError, type RepositoryIdentity} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type CompletedMaintenanceResult = Extract<CodeGraphRoutineMaintenanceResult, {readonly state: 'completed'}>;

describe('code graph maintenance lanes', () => {
  effectIt.effect('completes only absent or stale provenance and defers malformed legacy authority', () =>
    Effect.sync(() => {
      for (const result of [
        {state: 'not-found'} as const,
        {state: 'removed'} as const,
        {observedState: 'missing', state: 'preserved'} as const,
        {observedState: 'stale', state: 'preserved'} as const,
      ]) {
        expect(codeGraphRemovedViewProvenancePageResult(result)).toEqual({state: 'complete'});
      }
      expect(codeGraphRemovedViewProvenancePageResult({state: 'unavailable'})).toEqual({
        blockedCode: 'io-error',
        retryAfterMilliseconds: 1_000,
        state: 'deferred',
      });
      for (const observedState of ['invalid', 'legacy-unknown', 'verified'] as const) {
        expect(codeGraphRemovedViewProvenancePageResult({observedState, state: 'preserved'})).toEqual({
          blockedCode: 'invalid-sidecar',
          retryAfterMilliseconds: 30_000,
          state: 'deferred',
        });
      }
    }),
  );

  effectIt.effect('self-tails result.remaining A behind the already-pending B and C databases', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([]);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(input =>
        Ref.updateAndGet(calls, current => [...current, input.databasePath]).pipe(
          Effect.flatMap(current =>
            (current.length === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
              : current.length === 4
                ? Deferred.succeed(drained, undefined)
                : Effect.void
            ).pipe(Effect.as(current.length === 1 ? {...completed(), remaining: true as const} : completed())),
          ),
        ),
      );
      const owner = yield* coordinator.tick(tick('/home', '/database/A')).pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);

      expect(yield* coordinator.tick(tick('/home', '/database/B'))).toEqual({
        reason: 'home-tick-active',
        state: 'deferred',
      });
      expect(yield* coordinator.tick(tick('/home', '/database/C'))).toEqual({
        reason: 'home-tick-active',
        state: 'deferred',
      });
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(owner);
      yield* Deferred.await(drained);

      expect(yield* Ref.get(calls)).toEqual(['/database/A', '/database/B', '/database/C', '/database/A']);
    }),
  );

  effectIt.effect('lets a foreground opportunity defer instead of joining an active same-database unit', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(completed())),
      );
      const owner = yield* coordinator.tick(tick('/home', '/database/A')).pipe(Effect.forkChild);
      yield* Deferred.await(started);

      expect(yield* coordinator.tick({...tick('/home', '/database/A'), joinActive: false})).toEqual({
        reason: 'home-tick-active',
        state: 'deferred',
      });

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
    }),
  );

  effectIt.effect('keeps a foreground opportunity to one unit even when that unit reports remaining work', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(() =>
        Ref.update(calls, count => count + 1).pipe(Effect.as({...completed(), remaining: true as const})),
      );

      expect(yield* coordinator.tick({...tick('/home', '/database/A'), automaticTail: false})).toMatchObject({
        remaining: true,
        state: 'completed',
      });
      yield* Effect.forEach(Array.from({length: 32}), () => Effect.yieldNow);
      expect(yield* Ref.get(calls)).toBe(1);
    }),
  );

  effectIt.effect('keeps a newer same-database request when an older active result self-tails', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<CodeGraphRoutineMaintenanceTick[]>([]);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(input =>
        Ref.updateAndGet(calls, current => [...current, input]).pipe(
          Effect.flatMap(current =>
            (current.length === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
              : Deferred.succeed(drained, undefined)
            ).pipe(Effect.as(current.length === 1 ? {...completed(), remaining: true as const} : completed())),
          ),
        ),
      );
      const active = {...tick('/home', '/database/A'), anchorIdentity: identity('active')};
      const newer = {
        ...tick('/home', '/database/A'),
        allowIndexPreparation: true as const,
        anchorIdentity: identity('newer'),
      };
      const owner = yield* coordinator.tick(active).pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);

      yield* coordinator.request(newer);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(owner);
      yield* Deferred.await(drained);

      expect((yield* Ref.get(calls))[1]).toMatchObject({
        allowIndexPreparation: true,
        anchorIdentity: newer.anchorIdentity,
      });
    }),
  );

  effectIt.effect('runs a one-unit residual kick without entering the full lane tail', () =>
    Effect.gen(function* () {
      const laneCalls = yield* Ref.make(0);
      const residualCalls = yield* Ref.make(0);
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(
        () => Ref.update(laneCalls, count => count + 1).pipe(Effect.as(completed())),
        undefined,
        {},
        () => Ref.update(residualCalls, count => count + 1).pipe(Effect.as(completed())),
      );

      expect(yield* coordinator.kickResidual(tick('/home', '/database/A'))).toEqual(completed());
      expect(yield* Ref.get(residualCalls)).toBe(1);
      expect(yield* Ref.get(laneCalls)).toBe(0);
    }),
  );

  effectIt.effect('caps automatic tails and resumes only after a later external request', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const firstBurst = yield* Deferred.make<void>();
      const secondBurst = yield* Deferred.make<void>();
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(
        () =>
          Ref.updateAndGet(calls, count => count + 1).pipe(
            Effect.tap(count =>
              count === CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_UNITS
                ? Deferred.succeed(firstBurst, undefined)
                : count === CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_UNITS * 2
                  ? Deferred.succeed(secondBurst, undefined)
                  : Effect.void,
            ),
            Effect.as({...completed(), remaining: true as const}),
          ),
        undefined,
        {monotonicMilliseconds: () => 0},
      );

      yield* coordinator.request(tick('/home', '/database/A'));
      yield* Deferred.await(firstBurst);
      yield* Effect.forEach(Array.from({length: 32}), () => Effect.yieldNow);
      expect(yield* Ref.get(calls)).toBe(CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_UNITS);

      yield* coordinator.request(tick('/home', '/database/A'));
      yield* Deferred.await(secondBurst);
      yield* Effect.forEach(Array.from({length: 32}), () => Effect.yieldNow);
      expect(yield* Ref.get(calls)).toBe(CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_UNITS * 2);
    }),
  );

  effectIt.effect('drains an explicitly pending database while the active database exhausts its tail budget', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([]);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const budgetExhausted = yield* Deferred.make<void>();
      const pendingRan = yield* Deferred.make<void>();
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(
        input =>
          Ref.updateAndGet(calls, current => [...current, input.databasePath]).pipe(
            Effect.flatMap(current => {
              const databaseCalls = EffectArray.filter(
                current,
                databasePath => databasePath === input.databasePath,
              ).length;
              const barrier =
                input.databasePath === '/database/A' && databaseCalls === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
                  : input.databasePath === '/database/A' &&
                      databaseCalls === CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_UNITS
                    ? Deferred.succeed(budgetExhausted, undefined)
                    : input.databasePath === '/database/B'
                      ? Deferred.succeed(pendingRan, undefined)
                      : Effect.void;
              return barrier.pipe(
                Effect.as(
                  input.databasePath === '/database/A' ? {...completed(), remaining: true as const} : completed(),
                ),
              );
            }),
          ),
        undefined,
        {monotonicMilliseconds: () => 0},
      );
      const active = yield* coordinator.tick(tick('/home', '/database/A')).pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      yield* coordinator.request(tick('/home', '/database/B'));
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(active);
      yield* Deferred.await(pendingRan);
      yield* Deferred.await(budgetExhausted);
      yield* Effect.forEach(Array.from({length: 32}), () => Effect.yieldNow);

      const observed = yield* Ref.get(calls);
      expect(observed[0]).toBe('/database/A');
      expect(observed[1]).toBe('/database/B');
      expect(EffectArray.filter(observed, databasePath => databasePath === '/database/A')).toHaveLength(
        CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_UNITS,
      );
    }),
  );

  effectIt.effect('does not start an automatic tail at the exact 250 millisecond deadline', () =>
    Effect.gen(function* () {
      let now = 0;
      const calls = yield* Ref.make(0);
      const first = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<void>();
      const coordinator = yield* makeCodeGraphMaintenanceCoordinator(
        () =>
          Ref.updateAndGet(calls, count => count + 1).pipe(
            Effect.tap(count =>
              count === 1
                ? Effect.sync(() => {
                    now = CODE_GRAPH_MAINTENANCE_AUTOMATIC_TAIL_MILLISECONDS;
                  }).pipe(Effect.andThen(Deferred.succeed(first, undefined)))
                : Deferred.succeed(resumed, undefined),
            ),
            Effect.map(count => (count === 1 ? {...completed(), remaining: true as const} : completed())),
          ),
        undefined,
        {monotonicMilliseconds: () => now},
      );

      yield* coordinator.request(tick('/home', '/database/A'));
      yield* Deferred.await(first);
      yield* Effect.forEach(Array.from({length: 32}), () => Effect.yieldNow);
      expect(yield* Ref.get(calls)).toBe(1);

      now += 1;
      yield* coordinator.request(tick('/home', '/database/A'));
      yield* Deferred.await(resumed);
      expect(yield* Ref.get(calls)).toBe(2);
    }),
  );

  effectIt.effect('alternates endless vector work with the existing Store routine without starvation', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([]);
      const run = yield* makeCodeGraphOrdinaryMaintenanceRunner({
        routine: () => Ref.update(calls, current => [...current, 'routine']).pipe(Effect.as(completed())),
        vector: () =>
          Ref.update(calls, current => [...current, 'vector']).pipe(
            Effect.as({cursorToken: 'durable-vector-cursor', remaining: true as const, state: 'progress' as const}),
          ),
      });

      const results = yield* Effect.forEach(Array.from({length: 6}), () => run(tick('/home', '/database/A')));

      expect(yield* Ref.get(calls)).toEqual(['vector', 'routine', 'vector', 'routine', 'vector', 'routine']);
      expect(EffectArray.every(results, result => result.state === 'completed' && result.remaining)).toBe(true);
    }),
  );

  effectIt.effect('alternates an endless Store routine with vector admission checks', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([]);
      const run = yield* makeCodeGraphOrdinaryMaintenanceRunner({
        routine: () =>
          Ref.update(calls, current => [...current, 'routine']).pipe(
            Effect.as({...completed(), remaining: true as const}),
          ),
        vector: () =>
          Ref.update(calls, current => [...current, 'vector']).pipe(Effect.as({state: 'complete'} as const)),
      });

      const results = yield* Effect.forEach(Array.from({length: 6}), () => run(tick('/home', '/database/A')));

      expect(yield* Ref.get(calls)).toEqual(['vector', 'routine', 'vector', 'routine', 'vector', 'routine']);
      expect(EffectArray.every(results, result => result.state === 'completed' && result.remaining)).toBe(true);
    }),
  );

  effectIt.effect('gives a deferred vector scan one routine turn without creating a poison hot tail', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([]);
      const run = yield* makeCodeGraphOrdinaryMaintenanceRunner({
        routine: () => Ref.update(calls, current => [...current, 'routine']).pipe(Effect.as(completed())),
        vector: () =>
          Ref.update(calls, current => [...current, 'vector']).pipe(
            Effect.as({blockedCode: 'model-unavailable', retryAfterMilliseconds: 1_000, state: 'deferred'} as const),
          ),
      });

      expect(yield* run(tick('/home', '/database/A'))).toMatchObject({remaining: true, state: 'completed'});
      expect(yield* run(tick('/home', '/database/A'))).toEqual(completed());
      expect(yield* run(tick('/home', '/database/A'))).toMatchObject({remaining: true, state: 'completed'});
      expect(yield* Ref.get(calls)).toEqual(['vector', 'routine', 'vector']);
    }),
  );

  effectIt.effect('keeps ordinary sublane state isolated per database', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([]);
      const run = yield* makeCodeGraphOrdinaryMaintenanceRunner({
        routine: input =>
          Ref.update(calls, current => [...current, `${input.databasePath}:routine`]).pipe(Effect.as(completed())),
        vector: input =>
          Ref.update(calls, current => [...current, `${input.databasePath}:vector`]).pipe(
            Effect.as({state: 'complete'} as const),
          ),
      });

      yield* run(tick('/home', '/database/A'));
      yield* run(tick('/home', '/database/B'));
      yield* run(tick('/home', '/database/A'));
      yield* run(tick('/home', '/database/B'));

      expect(yield* Ref.get(calls)).toEqual([
        '/database/A:vector',
        '/database/B:vector',
        '/database/A:routine',
        '/database/B:routine',
      ]);
    }),
  );

  effectIt.effect('releases ordinary sublane ownership when an active unit is interrupted', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([]);
      const started = yield* Deferred.make<void>();
      const run = yield* makeCodeGraphOrdinaryMaintenanceRunner({
        routine: () => Ref.update(calls, current => [...current, 'routine']).pipe(Effect.as(completed())),
        vector: () =>
          Ref.updateAndGet(calls, current => [...current, 'vector']).pipe(
            Effect.flatMap(current =>
              current.length === 1
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed({state: 'complete'} as const),
            ),
          ),
      });
      const first = yield* run(tick('/home', '/database/A')).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);

      expect(yield* run(tick('/home', '/database/A'))).toEqual(completed());
      expect(yield* Ref.get(calls)).toEqual(['vector', 'routine']);
    }),
  );

  effectIt.effect('rotates past vector and routine failures on the next external call', () =>
    Effect.gen(function* () {
      const vectorFailureCalls = yield* Ref.make<string[]>([]);
      const vectorFailure = yield* makeCodeGraphOrdinaryMaintenanceRunner({
        routine: () => Ref.update(vectorFailureCalls, current => [...current, 'routine']).pipe(Effect.as(completed())),
        vector: () =>
          Ref.update(vectorFailureCalls, current => [...current, 'vector']).pipe(
            Effect.andThen(Effect.fail(CodeGraphStoreError.of('Vector unit failed.'))),
          ),
      });
      expect((yield* vectorFailure(tick('/home', '/database/A')).pipe(Effect.exit))._tag).toBe('Failure');
      expect(yield* vectorFailure(tick('/home', '/database/A'))).toEqual(completed());
      expect(yield* Ref.get(vectorFailureCalls)).toEqual(['vector', 'routine']);

      const routineFailureCalls = yield* Ref.make<string[]>([]);
      const routineFailure = yield* makeCodeGraphOrdinaryMaintenanceRunner({
        routine: () =>
          Ref.update(routineFailureCalls, current => [...current, 'routine']).pipe(
            Effect.andThen(Effect.fail(CodeGraphStoreError.of('Routine unit failed.'))),
          ),
        vector: () =>
          Ref.update(routineFailureCalls, current => [...current, 'vector']).pipe(
            Effect.as({state: 'complete'} as const),
          ),
      });
      expect(yield* routineFailure(tick('/home', '/database/A'))).toMatchObject({remaining: true});
      expect((yield* routineFailure(tick('/home', '/database/A')).pipe(Effect.exit))._tag).toBe('Failure');
      expect(yield* routineFailure(tick('/home', '/database/A'))).toMatchObject({remaining: true});
      expect(yield* Ref.get(routineFailureCalls)).toEqual(['vector', 'routine', 'vector']);

      const synchronousCalls: string[] = [];
      const synchronousFailure = yield* makeCodeGraphOrdinaryMaintenanceRunner({
        routine: () => Effect.sync(() => synchronousCalls.push('routine')).pipe(Effect.as(completed())),
        vector: () => {
          synchronousCalls.push('vector');
          throw TestError.make({message: 'Synchronous vector callback failure.'});
        },
      });
      expect((yield* synchronousFailure(tick('/home', '/database/A')).pipe(Effect.exit))._tag).toBe('Failure');
      expect(yield* synchronousFailure(tick('/home', '/database/A'))).toEqual(completed());
      expect(synchronousCalls).toEqual(['vector', 'routine']);
    }),
  );

  effectIt.effect('persists and rotates the next starting lane across idle cycles', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<CodeGraphMaintenanceLane[]>([]);
      const lane =
        (name: CodeGraphMaintenanceLane): CodeGraphRoutineMaintenanceRun =>
        () =>
          Ref.update(calls, current => [...current, name]).pipe(Effect.as(completed()));
      const run = yield* makeCodeGraphMaintenanceLaneRunner({
        ordinary: lane('ordinary'),
        reconciliation: lane('reconciliation'),
        residual: lane('residual'),
      });

      yield* Effect.forEach(Array.from({length: 6}), () => run(tick('/home', '/database/A')));

      expect(yield* Ref.get(calls)).toEqual([
        'residual',
        'reconciliation',
        'ordinary',
        'reconciliation',
        'ordinary',
        'residual',
      ]);
    }),
  );

  effectIt.effect('starts with physical reclaim when a caller reports storage pressure', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<CodeGraphMaintenanceLane[]>([]);
      const lane =
        (name: CodeGraphMaintenanceLane): CodeGraphRoutineMaintenanceRun =>
        () =>
          Ref.update(calls, current => [...current, name]).pipe(Effect.as(completed()));
      const run = yield* makeCodeGraphMaintenanceLaneRunner({
        ordinary: lane('ordinary'),
        reconciliation: lane('reconciliation'),
        residual: lane('residual'),
      });

      yield* run({...tick('/home', '/database/A'), pressure: 'critical'});

      expect(yield* Ref.get(calls)).toEqual(['ordinary']);
    }),
  );

  effectIt.effect('keeps same-home database rounds isolated while rotating their starting lanes', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([]);
      const lane =
        (name: CodeGraphMaintenanceLane): CodeGraphRoutineMaintenanceRun =>
        input =>
          Ref.update(calls, current => [...current, `${input.databasePath}:${name}`]).pipe(
            Effect.as(
              input.databasePath === '/database/A' && name === 'residual'
                ? {...completed(), remaining: true as const}
                : completed(),
            ),
          );
      const run = yield* makeCodeGraphMaintenanceLaneRunner({
        ordinary: lane('ordinary'),
        reconciliation: lane('reconciliation'),
        residual: lane('residual'),
      });

      yield* run(tick('/home', '/database/A'));
      yield* run(tick('/home', '/database/B'));
      yield* run(tick('/home', '/database/A'));

      expect(yield* Ref.get(calls)).toEqual([
        '/database/A:residual',
        '/database/B:reconciliation',
        '/database/A:reconciliation',
      ]);
    }),
  );

  effectIt.effect(
    'defers a 129th active database round without evicting and admits it after one becomes inactive',
    () =>
      Effect.gen(function* () {
        const activeLimit = CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT;
        const started = yield* Ref.make(0);
        const startedAll = yield* Deferred.make<void>();
        const admittedAfterCapacity = yield* Deferred.make<void>();
        const capacityOpened = yield* Ref.make(false);
        const releases = yield* Effect.forEach(Array.from({length: activeLimit + 1}), () => Deferred.make<void>());
        const lane =
          (_name: CodeGraphMaintenanceLane): CodeGraphRoutineMaintenanceRun =>
          input =>
            Effect.gen(function* () {
              const index = Number(Effect2.pipe(input.databasePath, EffectString.slice('/database/'.length)));
              if (index === activeLimit) {
                if (!(yield* Ref.get(capacityOpened))) return completed();
                yield* Deferred.succeed(admittedAfterCapacity, undefined);
                yield* Deferred.await(releases[index]);
                return completed();
              }
              const count = yield* Ref.updateAndGet(started, current => current + 1);
              if (count === activeLimit) yield* Deferred.succeed(startedAll, undefined);
              yield* Deferred.await(releases[index]);
              return completed();
            });
        const run = yield* makeCodeGraphMaintenanceLaneRunner({
          ordinary: lane('ordinary'),
          reconciliation: lane('reconciliation'),
          residual: lane('residual'),
        });
        const inputs = Array.from({length: activeLimit + 1}, (_, index) => tick('/home', `/database/${index}`));
        const owners = yield* Effect.forEach(inputs.slice(0, activeLimit), input => run(input).pipe(Effect.forkChild));
        yield* Deferred.await(startedAll);

        expect(yield* run(inputs[activeLimit])).toMatchObject({state: 'deferred'});

        yield* Deferred.succeed(releases[0], undefined);
        yield* Fiber.join(owners[0]);
        yield* run(inputs[0]);
        yield* run(inputs[0]);
        yield* Ref.set(capacityOpened, true);
        const admitted = yield* run(inputs[activeLimit]).pipe(Effect.forkChild);
        yield* Deferred.await(admittedAfterCapacity);

        yield* Effect.forEach(releases, release => Deferred.succeed(release, undefined));
        yield* Effect.forEach(owners.slice(1), Fiber.join);
        yield* Fiber.join(admitted);
      }),
  );

  effectIt.effect('rotates after blocked and no-progress lane results', () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<CodeGraphMaintenanceLane[]>([]);
      const observe =
        <A extends CodeGraphRoutineMaintenanceResult>(name: CodeGraphMaintenanceLane, result: A) =>
        () =>
          Ref.update(calls, current => [...current, name]).pipe(Effect.as({...result}));
      const run = yield* makeCodeGraphMaintenanceLaneRunner({
        ordinary: observe('ordinary', completed()),
        reconciliation: observe('reconciliation', {reason: 'schema-unavailable', state: 'skipped'} as const),
        residual: observe('residual', {reason: 'writer-busy', state: 'deferred'} as const),
      });

      yield* Effect.forEach(Array.from({length: 4}), () => run(tick('/home', '/database/A')));

      expect(yield* Ref.get(calls)).toEqual(['residual', 'reconciliation', 'ordinary', 'reconciliation']);
    }),
  );

  effectIt.effect('does not mutate a lane-owned result while adding an internal tail signal', () =>
    Effect.gen(function* () {
      const owned = Object.freeze(completed());
      const run = yield* makeCodeGraphMaintenanceLaneRunner({
        ordinary: () => Effect.succeed(completed()),
        reconciliation: () => Effect.succeed(completed()),
        residual: () => Effect.succeed(owned),
      });

      const result = yield* run(tick('/home', '/database/A'));

      expect(result).not.toBe(owned);
      expect(result).toEqual(owned);
      expect(owned.remaining).toBe(false);
    }),
  );

  fcEffectProp(
    effectIt,
    'matches an independent rotating-cycle model for interleaved homes',
    {homes: fc.array(fc.constantFrom('/home/A', '/home/B', '/home/C'), {maxLength: 60, minLength: 1})},
    ({homes}) =>
      Effect.gen(function* () {
        const observed = yield* Ref.make<string[]>([]);
        const lane =
          (name: CodeGraphMaintenanceLane): CodeGraphRoutineMaintenanceRun =>
          input =>
            Ref.update(observed, current => [...current, `${input.threadnoteHome}:${name}`]).pipe(
              Effect.as(completed()),
            );
        const run = yield* makeCodeGraphMaintenanceLaneRunner({
          ordinary: lane('ordinary'),
          reconciliation: lane('reconciliation'),
          residual: lane('residual'),
        });

        yield* Effect.forEach(homes, (home, index) => run(tick(home, `/database/${index}`)));

        const visits = new Map<string, number>();
        const expected = EffectArray.map(homes, home => {
          const visit = visits.get(home) ?? 0;
          visits.set(home, visit + 1);
          const lane = CODE_GRAPH_MAINTENANCE_LANES[visit % CODE_GRAPH_MAINTENANCE_LANES.length];
          return `${home}:${lane}`;
        });
        expect(yield* Ref.get(observed)).toEqual(expected);
      }),
    {fastCheck: {numRuns: 60}},
  );
});

function completed(): CompletedMaintenanceResult {
  return {
    cleanup: 'none',
    expiredLeases: 0,
    remaining: false,
    retiredSnapshots: 0,
    rowsDeleted: 0,
    state: 'completed',
  };
}

function tick(threadnoteHome: string, databasePath: string): CodeGraphRoutineMaintenanceTick {
  return {
    checkoutId: `checkout:${databasePath}`,
    databasePath,
    threadnoteHome,
    writerLockPath: `${databasePath}.lock`,
  };
}

function identity(name: string): RepositoryIdentity {
  const fill = name === 'active' ? 'a' : 'b';
  return {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe(fill, EffectString.repeat(64)),
    displayName: name,
    gitCommonDirectory: `/${name}/common`,
    headCommit: Effect2.pipe(fill, EffectString.repeat(40)),
    objectFormat: 'sha1',
    repositoryId: Effect2.pipe(fill, EffectString.repeat(64)),
    repoRoot: `/${name}/root`,
    worktreeId: Effect2.pipe(fill, EffectString.repeat(64)),
  };
}
