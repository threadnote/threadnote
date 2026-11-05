import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Scope,
} from 'effect';
import {SecureRandom} from 'effect/crypto';
import {TestClock} from 'effect/testing';
import type * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect, vi} from 'vitest';
import {
  EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE,
  makeCodeGraphBuildResourceCoordinator,
  type CodeGraphBuildResource,
  type CodeGraphBuildResourceState,
} from '../../src/build/resources.js';
import {writerSessionOptions} from '../../src/indexer/build_session.js';
import type {CodeGraphLayout} from '../../src/layout.js';
import type {CodeGraphIndexOptions} from '../../src/indexer/types.js';
import {makeCodeGraphStoreRuntime} from '../../src/store/runtime.js';
import {CodeGraphDatabaseSession} from '../../src/store/session.js';
import {
  codeGraphWriterGateFactory,
  registerCodeGraphWriterCallbacks,
  type CodeGraphScopedWriterFactory,
} from '../../src/store/writer_gate_scope.js';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import type {ExclusiveFileLockOptions} from '@threadnote/platform/file/lock';

const boundary = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    failPhysical: false,
    reportContention: false,
    unexpected: (name: string): never => {
      throw new Error(`Unexpected I/O boundary: ${name}`);
    },
  };
});

// Exercise the real runtime gate and coordinator; every physical/SQL boundary is closed.
vi.mock('@threadnote/platform/file/lock', async () => {
  const {Effect: effect} = await import('effect');
  return {
    isFileLockTimeout: () => false,
    withExclusiveFileLock: <A, E, R>(
      _fs: FileSystem.FileSystem,
      lockPath: string,
      options: ExclusiveFileLockOptions,
      program: Effect.Effect<A, E, R>,
    ) =>
      effect.suspend((): Effect.Effect<A, E | string, R> => {
        if (boundary.failPhysical) return effect.fail('synthetic physical acquisition failure');
        return (boundary.reportContention ? (options.onContention?.(lockPath) ?? effect.void) : effect.void).pipe(
          effect.andThen(
            effect.acquireUseRelease(
              effect.sync(() => boundary.events.push('physical:acquired')),
              () =>
                effect.gen(function* () {
                  // Match the real physical-lock contract: onAcquired precedes the guarded body.
                  yield* options.onAcquired?.(lockPath) ?? effect.void;
                  return yield* program.pipe(effect.ensuring(options.onCompleted?.(lockPath) ?? effect.void));
                }),
              () => effect.sync(() => boundary.events.push('physical:released')),
            ),
          ),
        );
      }),
  };
});
vi.mock('../../src/store/schema/initialization.js', () => ({
  initializeSchema: () => boundary.unexpected('initializeSchema'),
}));
vi.mock('../../src/store/routine_cleanup.js', () => ({
  pruneRoutinePhysicalRowsPage: () => boundary.unexpected('pruneRoutinePhysicalRowsPage'),
}));
vi.mock('../../src/store/activation/persistent.js', () => ({
  drainCompletedPersistentBuildRows: () => boundary.unexpected('drainCompletedPersistentBuildRows'),
}));
vi.mock('../../src/store/leases.js', () => ({
  initializeRoutineMaintenanceSchema: () => boundary.unexpected('initializeRoutineMaintenanceSchema'),
}));
vi.mock('../../src/store/reconciliation.js', () => ({
  codeGraphWorktreeReconciliationSchemaCompatible: () => boundary.unexpected('reconciliationSchemaCompatible'),
}));

vi.mock('../../src/indexer/materialization.js', () => ({
  CODE_GRAPH_LOCK_OPTIONS: new Proxy(Object.create(null), {
    ownKeys: () => boundary.unexpected('unused CODE_GRAPH_LOCK_OPTIONS'),
    get: () => boundary.unexpected('unused CODE_GRAPH_LOCK_OPTIONS'),
  }),
}));

// Runtime construction only captures these services. Any use is a test failure, never real I/O.
function unusedService<A extends object>(name: string): A {
  return new Proxy<A>(Object.create(null), {
    get: (_target, property) => boundary.unexpected(`${name}.${String(property)}`),
  });
}

const databasePath = 'synthetic-writer-resource.sqlite';
const layout: CodeGraphLayout = {
  checkoutId: 'synthetic-checkout',
  databaseWriteLockPath: 'synthetic-writer-resource.lock',
  databasePath,
  lockPath: 'unused-process.lock',
  repositoryRoot: 'unused-repository',
  staleMarkerPath: 'unused-stale-marker',
  vectorRoot: 'unused-vectors',
  worktreeLockRoot: 'unused-worktree-locks',
  worktreeId: 'synthetic-worktree',
};
const fixture = Effect.fn('test.writerResourceLifetime.fixture')(function* (
  observe: (resource: CodeGraphBuildResource | undefined) => Effect.Effect<void> = () => Effect.void,
  resumeProgress: () => Effect.Effect<void, unknown> = () => Effect.void,
  options: {
    readonly onProgress?: CodeGraphIndexOptions['onProgress'];
    readonly withoutResources?: boolean;
  } = {},
) {
  boundary.events.length = 0;
  boundary.failPhysical = false;
  boundary.reportContention = false;
  let releaseReports = 0;
  const resources = yield* makeCodeGraphBuildResourceCoordinator(resource => {
    boundary.events.push(`resource:${resource ?? 'none'}`);
    if (resource === undefined) releaseReports++;
    // Deliberately invoke the supplied factory directly: the production boundary must defer/catch it.
    return observe(resource);
  });
  const callbacks = writerSessionOptions(
    layout,
    {onProgress: options.onProgress},
    resumeProgress,
    options.withoutResources ? undefined : resources,
  );
  const session = CodeGraphDatabaseSession.of({
    databasePath,
    sql: unusedService<SqlClient.SqlClient>('sql'),
    schemaInitialized: true,
    reconstructibleDurabilityConfigured: false,
    detachedCleanupRequest: {completedBuild: false, completedSnapshotId: undefined, routinePhysical: false},
    ...callbacks,
  });
  const purePath = new Proxy<Path.Path>(Object.create(null), {
    get: (_target, property) => {
      if (property === 'basename')
        return (value: string) => {
          if (value !== databasePath) return boundary.unexpected('unexpected basename input');
          return value;
        };
      return boundary.unexpected(`path.${String(property)}`);
    },
  });
  const runtime = yield* makeCodeGraphStoreRuntime.pipe(
    Effect.provideService(FileSystem.FileSystem, unusedService<FileSystem.FileSystem>('filesystem')),
    Effect.provideService(Path.Path, purePath),
    Effect.provideService(SecureRandom.SecureRandom, unusedService<SecureRandom.SecureRandom['Service']>('crypto')),
    Effect.provideService(SystemInfo, unusedService<SystemInfoShape>('system')),
  );
  const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    runtime.withWriterGate(databasePath, program).pipe(Effect.provideService(CodeGraphDatabaseSession, session));
  return {resources, runtime, session, callbacks, run, releaseReports: () => releaseReports};
});

const requireInterruptedClosure = Effect.fn('test.writerResourceLifetime.requireInterruptedClosure')(function* (
  worker: Fiber.Fiber<unknown, unknown>,
) {
  const interruptor = yield* Fiber.interrupt(worker).pipe(Effect.forkChild({startImmediately: true}));
  const closure = yield* Fiber.await(worker).pipe(
    Effect.timeoutOption(Duration.millis(1)),
    Effect.forkChild({startImmediately: true}),
  );
  yield* TestClock.adjust(Duration.millis(1));
  const exit = yield* Fiber.join(closure);
  expect(Option.isSome(exit), 'owned closure must not wait for blocked observation').toBe(true);
  if (Option.isSome(exit)) expect(Exit.isFailure(exit.value)).toBe(true);
  yield* Fiber.join(interruptor);
});

describe('built-in checkout writer resource lifetime', () => {
  effectIt.effect(
    'releases writer ownership when interrupted before guarded work begins',
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const continueAcquisition = yield* Deferred.make<void>();
        let firstWriter = true;
        let observationCompleted = false;
        const f = yield* fixture(resource =>
          resource === 'checkout-writer' && firstWriter
            ? Effect.gen(function* () {
                firstWriter = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(continueAcquisition);
                observationCompleted = true;
              })
            : Effect.void,
        );
        yield* Effect.acquireUseRelease(
          f.run(Effect.sync(() => boundary.events.push('body'))).pipe(Effect.forkChild({startImmediately: true})),
          worker =>
            Effect.gen(function* () {
              yield* Deferred.await(entered);
              expect((yield* f.resources.current).writer).toBe(true);
              // Effect 4 has no interruptFork; start its safe interrupt-and-await operation in an immediate child.
              const interruptor = yield* Fiber.interrupt(worker).pipe(Effect.forkChild({startImmediately: true}));
              const closure = yield* Fiber.await(worker).pipe(
                Effect.timeoutOption(Duration.millis(1)),
                Effect.forkChild({startImmediately: true}),
              );
              yield* TestClock.adjust(Duration.millis(1));
              const exit = yield* Fiber.join(closure);
              // A whole-callback uninterruptible acquire must fail here while the reporter remains blocked.
              expect(Option.isSome(exit), 'writer closure must not wait for reporter observation').toBe(true);
              if (Option.isSome(exit)) expect(Exit.isFailure(exit.value)).toBe(true);
              expect(observationCompleted).toBe(false);
              expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
              expect(f.releaseReports()).toBe(0);
              expect(boundary.events).toEqual(['physical:acquired', 'resource:checkout-writer', 'physical:released']);
              yield* Fiber.join(interruptor);
            }),
          // Unblock only during guaranteed cleanup, including after a rejected naive masking implementation.
          worker => Deferred.succeed(continueAcquisition, undefined).pipe(Effect.andThen(Fiber.interrupt(worker))),
        );
        yield* f.run(Effect.void);
        expect(f.releaseReports()).toBe(1);
        expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      }),
    5_000,
  );

  effectIt.effect('preserves an outer writer when nested logical acquisition is rejected', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.acquireUseRelease(
        f.resources.acquireWriter,
        () =>
          Effect.gen(function* () {
            // The fake physical boundary permits this fault injection; the actual logical guard must reject it.
            const exit = yield* f.run(Effect.sync(() => boundary.events.push('nested-body'))).pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit))
              expect(Cause.pretty(exit.cause)).toContain('Checkout writer acquisition violated resource order.');
            expect((yield* f.resources.current).writer).toBe(true);
            expect(f.releaseReports()).toBe(0);
            expect(boundary.events).toEqual(['resource:checkout-writer', 'physical:acquired', 'physical:released']);
          }),
        () => f.resources.releaseWriter,
      );
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
    }),
  );

  effectIt.effect(
    'closes physical ownership while release observation remains blocked',
    () =>
      Effect.gen(function* () {
        const releaseEntered = yield* Deferred.make<void>();
        const continueRelease = yield* Deferred.make<void>();
        let firstRelease = true;
        let releaseObservationCompleted = false;
        const f = yield* fixture(resource =>
          resource === undefined && firstRelease
            ? Effect.gen(function* () {
                firstRelease = false;
                yield* Deferred.succeed(releaseEntered, undefined);
                yield* Deferred.await(continueRelease);
                releaseObservationCompleted = true;
              })
            : Effect.void,
        );
        yield* Effect.acquireUseRelease(
          f.run(Effect.sync(() => boundary.events.push('body'))).pipe(Effect.forkChild({startImmediately: true})),
          worker =>
            Effect.gen(function* () {
              yield* Deferred.await(releaseEntered);
              const interruptor = yield* Fiber.interrupt(worker).pipe(Effect.forkChild({startImmediately: true}));
              expect((yield* f.resources.current).writer).toBe(false);
              const closure = yield* Fiber.await(worker).pipe(
                Effect.timeoutOption(Duration.millis(1)),
                Effect.forkChild({startImmediately: true}),
              );
              yield* TestClock.adjust(Duration.millis(1));
              const exit = yield* Fiber.join(closure);
              expect(Option.isSome(exit), 'physical closure must not wait for release observation').toBe(true);
              if (Option.isSome(exit)) expect(Exit.isFailure(exit.value)).toBe(true);
              expect(releaseObservationCompleted).toBe(false);
              expect(f.releaseReports()).toBe(1);
              expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
              expect(boundary.events).toEqual([
                'physical:acquired',
                'resource:checkout-writer',
                'body',
                'resource:none',
                'physical:released',
              ]);
              yield* Fiber.join(interruptor);
            }),
          // A failed implementation may mask release observation; unblock it before waiting for final teardown.
          worker => Deferred.succeed(continueRelease, undefined).pipe(Effect.andThen(Fiber.interrupt(worker))),
        );
      }),
    5_000,
  );

  effectIt.effect('releases writer ownership before physical release after success and failure', () =>
    Effect.gen(function* () {
      for (const failure of [false, true]) {
        const f = yield* fixture();
        const body = Effect.sync(() => boundary.events.push('body')).pipe(
          Effect.andThen(failure ? Effect.fail('synthetic writer body failure') : Effect.succeed('done')),
        );
        const exit = yield* f.run(body).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(failure);
        expect(f.releaseReports()).toBe(1);
        expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
        expect(boundary.events).toEqual([
          'physical:acquired',
          'resource:checkout-writer',
          'body',
          'resource:none',
          'physical:released',
        ]);
      }
    }),
  );

  effectIt.effect('keeps preparation and writer overlap rejected without releasing preparation', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.acquireUseRelease(
        f.resources.acquirePreparation,
        () =>
          Effect.gen(function* () {
            const exit = yield* f.run(Effect.sync(() => boundary.events.push('body'))).pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit))
              expect(Cause.pretty(exit.cause)).toContain('Checkout writer acquisition violated resource order.');
            expect((yield* f.resources.current).preparation).toBe(true);
            expect((yield* f.resources.current).writer).toBe(false);
            expect(f.releaseReports()).toBe(0);
            expect(boundary.events).toEqual([
              'resource:home-preparation-slot',
              'physical:acquired',
              'physical:released',
            ]);
          }),
        () => f.resources.releasePreparation,
      );
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
    }),
  );

  effectIt.effect('preserves writerGateHeld bypass without touching the outer owner or physical gate', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.acquireUseRelease(
        f.resources.acquireWriter,
        () =>
          Effect.gen(function* () {
            yield* f.runtime
              .withWriterGate(
                databasePath,
                Effect.sync(() => boundary.events.push('body')),
              )
              .pipe(Effect.provideService(CodeGraphDatabaseSession, {...f.session, writerGateHeld: true}));
            expect((yield* f.resources.current).writer).toBe(true);
            expect(f.releaseReports()).toBe(0);
            expect(boundary.events).toEqual(['resource:checkout-writer', 'body']);
          }),
        () => f.resources.releaseWriter,
      );
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
    }),
  );

  effectIt.effect('supports sessions without writer callbacks', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.runtime
        .withWriterGate(
          databasePath,
          Effect.sync(() => boundary.events.push('body')),
        )
        .pipe(
          Effect.provideService(CodeGraphDatabaseSession, {
            ...f.session,
            onWriterAcquired: undefined,
            onWriterReleased: undefined,
          }),
        );
      expect(f.releaseReports()).toBe(0);
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      expect(boundary.events).toEqual(['physical:acquired', 'body', 'physical:released']);
    }),
  );

  effectIt.effect('cancels blocked built-in progress after logical acquisition', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let completed = false;
      const f = yield* fixture(undefined, () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          completed = true;
        }),
      );
      yield* Effect.acquireUseRelease(
        f.run(Effect.sync(() => boundary.events.push('body'))).pipe(Effect.forkChild({startImmediately: true})),
        worker =>
          Effect.gen(function* () {
            yield* Deferred.await(entered);
            expect((yield* f.resources.current).writer).toBe(true);
            yield* requireInterruptedClosure(worker);
            expect(completed).toBe(false);
            expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
            expect(boundary.events).toEqual(['physical:acquired', 'resource:checkout-writer', 'physical:released']);
            expect(f.releaseReports()).toBe(0);
          }),
        worker => Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.interrupt(worker))),
      );
    }),
  );

  effectIt.effect(
    'keeps built-in observation cancellable for an already masked caller',
    () =>
      Effect.gen(function* () {
        for (const phase of ['resource', 'progress', 'release'] as const) {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let completed = false;
          const blocked = () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              completed = true;
            });
          const f = yield* fixture(
            resource =>
              (phase === 'resource' && resource === 'checkout-writer') ||
              (phase === 'release' && resource === undefined)
                ? blocked()
                : Effect.void,
            phase === 'progress' ? blocked : undefined,
          );
          yield* Effect.acquireUseRelease(
            f
              .run(Effect.sync(() => boundary.events.push('body')))
              .pipe(Effect.uninterruptible, Effect.forkChild({startImmediately: true})),
            worker =>
              Effect.gen(function* () {
                yield* Deferred.await(entered);
                expect((yield* f.resources.current).writer).toBe(phase !== 'release');
                yield* requireInterruptedClosure(worker);
                expect(completed).toBe(false);
                expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
                expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(1);
                expect(boundary.events.includes('body')).toBe(phase === 'release');
              }),
            worker => Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.interrupt(worker))),
          );
        }
      }),
    5_000,
  );

  effectIt.effect('preserves inherited body masking while observers remain cancellable', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let completed = false;
      const f = yield* fixture();
      const body = Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        completed = true;
      });
      yield* Effect.acquireUseRelease(
        f.run(body).pipe(Effect.uninterruptible, Effect.forkChild({startImmediately: true})),
        worker =>
          Effect.gen(function* () {
            yield* Deferred.await(entered);
            const interruptor = yield* Fiber.interrupt(worker).pipe(Effect.forkChild({startImmediately: true}));
            yield* Effect.yieldNow;
            expect(worker.pollUnsafe()).toBeUndefined();
            expect(completed).toBe(false);
            expect((yield* f.resources.current).writer).toBe(true);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(interruptor);
            expect(completed).toBe(true);
            expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
            expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(1);
          }),
        worker => Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.interrupt(worker))),
      );
    }),
  );

  effectIt.effect('cleans committed ownership after resource and progress factory or effect defects', () =>
    Effect.gen(function* () {
      for (const phase of ['resource', 'progress'] as const) {
        for (const mode of ['factory', 'effect'] as const) {
          const marker = new Error(`synthetic ${phase} ${mode} defect`);
          let first = true;
          const defect = () => {
            if (!first) return Effect.void;
            first = false;
            if (mode === 'factory') throw marker;
            return Effect.die(marker);
          };
          const f = yield* fixture(
            resource => (phase === 'resource' && resource === 'checkout-writer' ? defect() : Effect.void),
            phase === 'progress' ? defect : undefined,
          );
          const exit = yield* f.run(Effect.sync(() => boundary.events.push('body'))).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(marker.message);
          expect(boundary.events.includes('body')).toBe(false);
          expect(
            boundary.events.includes('resource:checkout-writer'),
            'defect must occur after actual writer commitment',
          ).toBe(true);
          expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
          expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(1);
          yield* f.run(Effect.void);
          expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
          expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(2);
        }
      }
    }),
  );

  effectIt.effect('retains body and release-observer payloads under Effect cause election', () =>
    Effect.gen(function* () {
      for (const bodyKind of ['success', 'failure', 'defect'] as const) {
        for (const releaseKind of ['factory', 'effect'] as const) {
          const releaseMarker = new Error(`synthetic release ${releaseKind} defect`);
          const bodyMarker = new Error(`synthetic body ${bodyKind} payload`);
          const f = yield* fixture(resource => {
            if (resource !== undefined) return Effect.void;
            if (releaseKind === 'factory') throw releaseMarker;
            return Effect.die(releaseMarker);
          });
          const body =
            bodyKind === 'success'
              ? Effect.void
              : bodyKind === 'failure'
                ? Effect.fail(bodyMarker)
                : Effect.die(bodyMarker);
          const exit = yield* f.run(body).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const payloads = EffectArray.flatMap(exit.cause.reasons, reason =>
              Cause.isDieReason(reason) ? [reason.defect] : Cause.isFailReason(reason) ? [reason.error] : [],
            );
            expect(payloads).toContain(releaseMarker);
            if (bodyKind !== 'success') expect(payloads).toContain(bodyMarker);
            // Effect may elect a typed Fail into Die when merged with a defect; inspect payloads, not invented tags.
          }
          expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
          expect(f.releaseReports()).toBe(1);
          expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(1);
        }
      }
    }),
  );

  effectIt.effect('preserves current metadata when only the owned writer is released', () =>
    Effect.gen(function* () {
      for (const owner of ['candidate', 'legacy'] as const) {
        const f = yield* fixture();
        const acquire = owner === 'candidate' ? f.resources.acquireCandidateStage : f.resources.acquireLegacyBuilder;
        const release = owner === 'candidate' ? f.resources.releaseCandidateStage : f.resources.releaseLegacyBuilder;
        yield* Effect.acquireUseRelease(
          acquire,
          () =>
            Effect.gen(function* () {
              yield* f.run(f.resources.acquirePreparedSpool(17));
              const current = yield* f.resources.current;
              expect(current).toEqual({
                ...EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE,
                ...(owner === 'candidate' ? {candidateStage: true} : {legacyBuilder: true}),
                preparedBytes: 17,
                preparedSpools: 1,
              });
              expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(1);
              yield* f.resources.releasePreparedSpool(17);
            }),
          () => release,
        );
        expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      }
    }),
  );

  effectIt.effect('preserves callback overrides, database mismatch and physical acquisition failure', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const legacy: string[] = [];
      yield* f.runtime
        .withWriterGate(
          databasePath,
          Effect.sync(() => legacy.push('body')),
        )
        .pipe(
          Effect.provideService(CodeGraphDatabaseSession, {
            ...f.session,
            onWriterAcquired: () => Effect.sync(() => legacy.push('acquire')),
            onWriterReleased: () => Effect.sync(() => legacy.push('release')),
          }),
        );
      expect(legacy).toEqual(['acquire', 'body', 'release']);
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      boundary.events.length = 0;
      yield* f.runtime
        .withWriterGate(
          databasePath,
          Effect.sync(() => boundary.events.push('body')),
        )
        .pipe(
          Effect.provideService(CodeGraphDatabaseSession, {...f.session, databasePath: 'different-session.sqlite'}),
        );
      expect(boundary.events).toEqual(['physical:acquired', 'body', 'physical:released']);
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      boundary.events.length = 0;
      boundary.failPhysical = true;
      const exit = yield* f.run(Effect.sync(() => boundary.events.push('body'))).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('synthetic physical acquisition failure');
      expect(boundary.events).toEqual([]);
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      expect(f.releaseReports()).toBe(0);
    }),
  );

  effectIt.effect('supports built-in callbacks without resources and preserves contention reporting', () =>
    Effect.gen(function* () {
      let resumed = 0;
      const waiting: string[] = [];
      const f = yield* fixture(
        undefined,
        () =>
          Effect.sync(() => {
            resumed++;
          }),
        {
          withoutResources: true,
          onProgress: progress =>
            Effect.sync(() => {
              waiting.push(progress.phase);
            }),
        },
      );
      boundary.reportContention = true;
      yield* f.run(Effect.sync(() => boundary.events.push('body')));
      expect(waiting).toEqual(['waiting']);
      expect(resumed).toBe(1);
      expect(f.releaseReports()).toBe(0);
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      expect(boundary.events).toEqual(['physical:acquired', 'body', 'physical:released']);
    }),
  );
  effectIt.effect('preserves the opaque path when only the built-in release callback is overridden', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let opaqueReleases = 0;
      yield* f.runtime.withWriterGate(databasePath, Effect.void).pipe(
        Effect.provideService(CodeGraphDatabaseSession, {
          ...f.session,
          onWriterReleased: () =>
            Effect.sync(() => {
              opaqueReleases++;
            }),
        }),
        Effect.andThen(
          Effect.gen(function* () {
            expect(opaqueReleases).toBe(1);
            // The replaced opaque destructor owns its own contract; exact-pair routing must not silently substitute one.
            expect((yield* f.resources.current).writer).toBe(true);
            expect(f.releaseReports()).toBe(0);
            expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(1);
          }),
        ),
        Effect.ensuring(
          f.resources.current.pipe(
            Effect.flatMap(current => (current.writer ? f.resources.releaseWriter : Effect.void)),
          ),
        ),
      );
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
    }),
  );

  effectIt.effect('rejects contention during preparation before invoking the progress factory', () =>
    Effect.gen(function* () {
      let waitingFactories = 0;
      const f = yield* fixture(undefined, undefined, {
        onProgress: () => {
          waitingFactories++;
          return Effect.void;
        },
      });
      yield* Effect.acquireUseRelease(
        f.resources.acquirePreparation,
        () =>
          Effect.gen(function* () {
            boundary.reportContention = true;
            const exit = yield* f.run(Effect.void).pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit))
              expect(Cause.pretty(exit.cause)).toContain(
                'A checkout writer cannot be awaited while preparation is held.',
              );
            expect(waitingFactories).toBe(0);
            expect((yield* f.resources.current).preparation).toBe(true);
            expect((yield* f.resources.current).writer).toBe(false);
            expect(f.releaseReports()).toBe(0);
            expect(boundary.events).toEqual(['resource:home-preparation-slot']);
          }),
        () => f.resources.releasePreparation,
      );
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
    }),
  );
  effectIt.effect('keeps recoverable progress failures ignored without skipping owned cleanup', () =>
    Effect.gen(function* () {
      const f = yield* fixture(undefined, () => Effect.fail('synthetic recoverable resume failure'), {
        onProgress: () => Effect.fail('synthetic recoverable contention failure'),
      });
      boundary.reportContention = true;
      const exit = yield* f.run(Effect.sync(() => boundary.events.push('body'))).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      expect(f.releaseReports()).toBe(1);
      expect(boundary.events).toEqual([
        'physical:acquired',
        'resource:checkout-writer',
        'body',
        'resource:none',
        'physical:released',
      ]);
    }),
  );
});

// Future supplementary revision only: retain the separate identical-c504 first-green comparison.
describe('post-green built-in writer resource lifetime supplements', () => {
  effectIt.effect('Q1 cancels ordinary body work without waiting for its barrier or reporting release', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const releaseBody = yield* Deferred.make<void>();
      let completed = false;
      const f = yield* fixture();
      const body = Effect.gen(function* () {
        boundary.events.push('body:entered');
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(releaseBody);
        completed = true;
      });
      yield* Effect.acquireUseRelease(
        f.run(body).pipe(Effect.forkChild({startImmediately: true})),
        worker =>
          Effect.gen(function* () {
            yield* Deferred.await(entered);
            expect((yield* f.resources.current).writer).toBe(true);
            yield* requireInterruptedClosure(worker);
            const completedExit = yield* Fiber.await(worker);
            expect(Exit.isFailure(completedExit)).toBe(true);
            if (Exit.isFailure(completedExit)) expect(Cause.hasInterrupts(completedExit.cause)).toBe(true);
            expect(completed).toBe(false);
            expect(yield* Deferred.isDone(releaseBody)).toBe(false);
            expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
            expect(f.releaseReports()).toBe(0);
            expect(boundary.events).toEqual([
              'physical:acquired',
              'resource:checkout-writer',
              'body:entered',
              'physical:released',
            ]);
          }),
        // This is the only place that opens the ordinary body barrier, including on a failed assertion.
        worker => Deferred.succeed(releaseBody, undefined).pipe(Effect.andThen(Fiber.interrupt(worker))),
      );
      yield* f.run(Effect.void);
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      expect(EffectArray.filter(boundary.events, event => event === 'physical:acquired')).toHaveLength(2);
      expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(2);
      expect(f.releaseReports()).toBe(1);
    }),
  );

  effectIt.effect('Q2 skips an unstarted release factory after cancellation requested during pure scope closure', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const originalFactory = codeGraphWriterGateFactory(f.session);
      if (originalFactory === undefined)
        return yield* Effect.die(new Error('Actual built-in writer factory was not registered.'));
      let bodyEntered = false;
      let probeReached = false;
      let requestIssued = false;
      let bodyWorkerId: number | undefined;
      const wrappedFactory = (scope: Scope.Scope) => {
        const actual = originalFactory(scope);
        const probe = Effect.gen(function* () {
          probeReached = true;
          expect(bodyEntered).toBe(true);
          // Added before the actual writer finalizer: real sequential Scope closes the later writer first.
          expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
          expect(f.releaseReports()).toBe(0);
          expect(boundary.events).toEqual(['physical:acquired', 'resource:checkout-writer', 'body:entered']);
          yield* Effect.withFiberSucceed(fiber => {
            expect(fiber.id).toBe(bodyWorkerId);
            requestIssued = true;
            // Public immediate request hook: never Fiber.interrupt(self), which also awaits itself.
            fiber.interruptUnsafe(fiber.id);
          });
        });
        return {
          ...actual,
          acquire: Scope.addFinalizer(scope, probe).pipe(Effect.andThen(actual.acquire)),
        };
      };
      const register = (makeGate: CodeGraphScopedWriterFactory) =>
        Effect.sync(() => {
          registerCodeGraphWriterCallbacks(f.callbacks.onWriterAcquired, f.callbacks.onWriterReleased, makeGate);
        });
      yield* Effect.acquireUseRelease(
        register(wrappedFactory),
        () =>
          Effect.acquireUseRelease(
            f
              .run(
                Effect.gen(function* () {
                  expect((yield* f.resources.current).writer).toBe(true);
                  bodyWorkerId = yield* Effect.withFiberSucceed(fiber => fiber.id);
                  bodyEntered = true;
                  boundary.events.push('body:entered');
                }),
              )
              .pipe(Effect.forkChild({startImmediately: true})),
            worker =>
              Effect.gen(function* () {
                const exit = yield* Fiber.await(worker);
                expect(Exit.isFailure(exit)).toBe(true);
                if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
                expect(probeReached).toBe(true);
                expect(requestIssued).toBe(true);
                expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
                expect(f.releaseReports()).toBe(0);
                expect(boundary.events).toEqual([
                  'physical:acquired',
                  'resource:checkout-writer',
                  'body:entered',
                  'physical:released',
                ]);
              }),
            worker => Fiber.interrupt(worker),
          ),
        () => register(originalFactory),
      );
      // The exact original registry entry was restored; normal release still reports the empty resource.
      yield* f.run(Effect.void);
      expect(f.releaseReports()).toBe(1);
      expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      expect(EffectArray.filter(boundary.events, event => event === 'physical:acquired')).toHaveLength(2);
      expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(2);
    }),
  );

  effectIt.effect('Q3 preserves outer ownership and current metadata across four relational body rows', () =>
    Effect.gen(function* () {
      for (const owner of ['candidate', 'legacy'] as const) {
        for (const outcome of ['success', 'typed-failure'] as const) {
          const f = yield* fixture();
          const acquireOwner =
            owner === 'candidate' ? f.resources.acquireCandidateStage : f.resources.acquireLegacyBuilder;
          const releaseOwner =
            owner === 'candidate' ? f.resources.releaseCandidateStage : f.resources.releaseLegacyBuilder;
          let spoolHeld = false;
          let lastBodySnapshot: CodeGraphBuildResourceState | undefined;
          const marker = new Error(`Q3 ${owner} ${outcome}`);
          yield* Effect.acquireUseRelease(
            acquireOwner,
            () =>
              Effect.gen(function* () {
                const body = Effect.gen(function* () {
                  const beforeNested = yield* f.resources.current;
                  expect(beforeNested.writer).toBe(true);
                  const rejected = yield* f
                    .run(Effect.sync(() => boundary.unexpected('Q3 nested body')))
                    .pipe(Effect.exit);
                  expect(Exit.isFailure(rejected)).toBe(true);
                  if (Exit.isFailure(rejected))
                    expect(Cause.pretty(rejected.cause)).toContain(
                      'Checkout writer acquisition violated resource order.',
                    );
                  expect(yield* f.resources.current).toEqual(beforeNested);
                  expect((yield* f.resources.current).writer).toBe(true);
                  yield* f.resources.acquirePreparedSpool(17);
                  spoolHeld = true;
                  lastBodySnapshot = yield* f.resources.current;
                  if (outcome === 'typed-failure') return yield* Effect.fail(marker);
                });
                const exit = yield* f.run(body).pipe(Effect.exit);
                expect(Exit.isFailure(exit)).toBe(outcome === 'typed-failure');
                if (Exit.isFailure(exit))
                  expect(
                    EffectArray.some(
                      exit.cause.reasons,
                      reason => Cause.isFailReason(reason) && reason.error === marker,
                    ),
                  ).toBe(true);
                if (lastBodySnapshot === undefined)
                  return yield* Effect.die(new Error('Q3 writer body never captured actual state.'));
                const after = yield* f.resources.current;
                const {writer: bodyWriter, ...lastNonWriter} = lastBodySnapshot;
                const {writer: afterWriter, ...afterNonWriter} = after;
                expect(bodyWriter).toBe(true);
                expect(afterWriter).toBe(false);
                expect(afterNonWriter).toEqual(lastNonWriter);
                expect(EffectArray.filter(boundary.events, event => event === 'physical:acquired')).toHaveLength(2);
                expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(2);
                yield* f.run(Effect.void);
                expect(yield* f.resources.current).toEqual(after);
                expect(EffectArray.filter(boundary.events, event => event === 'physical:acquired')).toHaveLength(3);
                expect(EffectArray.filter(boundary.events, event => event === 'physical:released')).toHaveLength(3);
              }).pipe(
                Effect.ensuring(Effect.suspend(() => (spoolHeld ? f.resources.releasePreparedSpool(17) : Effect.void))),
              ),
            () => releaseOwner,
          );
          expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
        }
      }
    }),
  );
});
