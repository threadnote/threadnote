import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, FileSystem, Logger, Path, Ref, Stream, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh,
  CodeGraphRefreshRetryDeferred,
  currentBackgroundRefreshSummary,
  codeGraphWatcherSnapshotStale,
  driveCodeGraphBackgroundDemand,
  handoffCodeGraphPreparedDemand,
  makeCodeGraphWatchReconciliation,
  makeCodeGraphResumeScheduler,
  makeCodeGraphWatcher,
  persistedRefreshStatus,
  prewarmCandidatesFromRefOutput,
  type CodeGraphWatchOptions,
  watchRepository,
} from '@threadnote/graph/watcher';
import type {ObservedCodeGraphBuildStatus} from '@threadnote/graph/build_status';
import {recordCodeGraphSnapshotAdmission} from '@threadnote/graph/admission_freshness';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {extractorSetIdentity} from '@threadnote/graph/indexer/materialization';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {codeGraphScopeAdmissionEvidence} from '@threadnote/graph/scope/applicability';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  completeCodeGraphRefreshDemand,
  deferCodeGraphRefreshDemand,
  emptyCodeGraphRefreshDemand,
  enqueueCodeGraphRefreshDemand,
  failCodeGraphRefreshDemand,
  registerCodeGraphRefreshDemand,
} from '@threadnote/graph/refresh/demand_scheduler';
import {
  CodeGraphDiskCapacityPressureError,
  CodeGraphRuntimeReconnectRequiredError,
  CodeGraphStoreBusyError,
  CodeGraphStoreNoSpaceError,
  CodeGraphStorePermissionError,
  CodeGraphStoreTransientIoError,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import {orderCodeGraphBuilderAdmissionTickets} from '@threadnote/graph/builder/admission';

const options: CodeGraphWatchOptions = {
  cwd: '/fixture/repository',
  key: 'repository:worktree',
  threadnoteHome: '/fixture/home',
};

const demandCheckoutId = 'a'.repeat(64);
const demandWorktreeId = 'b'.repeat(64);
const demandKey = (value: string) => value.repeat(64).slice(0, 64);

function makeDemandDriverHarness(input: {
  readonly initialTarget: string;
  readonly onRefreshed?: (summary: {readonly edges: number; readonly symbols: number}) => Effect.Effect<void, unknown>;
  readonly run: (
    target: {readonly requestKey: string},
    queue: (targetKey: string) => Effect.Effect<void>,
  ) => Effect.Effect<{readonly edges: number; readonly symbols: number}, unknown>;
}) {
  return Effect.gen(function* () {
    const currentTarget = yield* Ref.make(input.initialTarget);
    const state = yield* Ref.make(emptyCodeGraphRefreshDemand(demandCheckoutId, demandWorktreeId));
    let tokenOrdinal = 0;
    const nextToken = () => `cgdq_${(++tokenOrdinal).toString(16).padStart(32, '0')}`;
    const queue = (targetKey: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.update(
          state,
          current => enqueueCodeGraphRefreshDemand(current, {now, targetKey, token: nextToken()}).state,
        );
      });
    const transition = (
      f: (current: ReturnType<typeof emptyCodeGraphRefreshDemand>) => ReturnType<typeof emptyCodeGraphRefreshDemand>,
    ) =>
      Ref.modify(state, current => {
        const next = f(current);
        return [next, next];
      });
    const driver = driveCodeGraphBackgroundDemand({
      complete: (target, token) =>
        transition(current => completeCodeGraphRefreshDemand(current, token, target.requestKey)),
      defer: (target, token) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap(now =>
            transition(current => deferCodeGraphRefreshDemand(current, token, target.requestKey, now)),
          ),
        ),
      fail: (target, token) => transition(current => failCodeGraphRefreshDemand(current, token, target.requestKey)),
      isSuperseded: () => false,
      observe: Ref.get(currentTarget).pipe(Effect.map(requestKey => ({requestKey}))),
      onRefreshed: input.onRefreshed ?? (() => Effect.void),
      recover: () => Effect.void,
      register: target =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          return yield* Ref.modify(state, current => {
            const registration = registerCodeGraphRefreshDemand(current, {
              now,
              targetKey: target.requestKey,
              token: nextToken(),
            });
            return [registration, registration.state];
          });
        }),
      run: (target, _token) =>
        input.run(target, targetKey => queue(targetKey).pipe(Effect.andThen(Ref.set(currentTarget, targetKey)))),
    });
    return {
      driver,
      enqueue: (targetKey: string) => queue(targetKey).pipe(Effect.andThen(Ref.set(currentTarget, targetKey))),
      state,
    };
  });
}

describe('CodeGraphWatcher', () => {
  effectIt.effect('schedules and coalesces durable requests without awaiting the active request', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const trailingCompleted = yield* Deferred.make<void>();
        const runs = yield* Ref.make(0);
        const schedule = yield* makeCodeGraphResumeScheduler(() =>
          Ref.updateAndGet(runs, count => count + 1).pipe(
            Effect.flatMap(count =>
              count === 1
                ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
                : Deferred.succeed(trailingCompleted, undefined),
            ),
          ),
        );

        yield* schedule(options);
        yield* schedule(options);
        yield* schedule(options);
        yield* Deferred.await(firstStarted);
        expect(yield* Ref.get(runs)).toBe(1);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(trailingCompleted);
        expect(yield* Ref.get(runs)).toBe(2);
      }),
    ),
  );

  effectIt.effect('single-flights scoped resume discovery with one observable trailing run', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const firstCompleted = yield* Deferred.make<void>();
        const failureObserved = yield* Deferred.make<string>();
        const runs = yield* Ref.make(0);
        const schedule = yield* makeCodeGraphResumeScheduler(
          () =>
            Ref.updateAndGet(runs, count => count + 1).pipe(
              Effect.flatMap(count =>
                count === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirst)),
                      Effect.ensuring(Deferred.succeed(firstCompleted, undefined)),
                    )
                  : Effect.fail(TestError.make({message: 'resume discovery failed'})),
              ),
            ),
          failure => Deferred.succeed(failureObserved, failure.code).pipe(Effect.asVoid),
        );
        const scoped = {
          ...options,
          project: {
            graph: {closure: 'dependencies' as const, roots: ['apps/web']},
            uri: 'threadnote://projects/web',
          },
        };

        yield* schedule(scoped);
        yield* schedule(scoped);
        yield* Deferred.await(firstStarted);
        expect(yield* Ref.get(runs)).toBe(1);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(firstCompleted);
        expect(yield* Deferred.await(failureObserved)).toBe('unknown');
        expect(yield* Ref.get(runs)).toBe(2);
      }),
    ),
  );

  effectIt.effect.prop(
    'coalesces every same-key burst into one trailing run with the latest input',
    {duplicates: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 20}))},
    ({duplicates}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const trailingCompleted = yield* Deferred.make<void>();
          const observed = yield* Ref.make<string[]>([]);
          const schedule = yield* makeCodeGraphResumeScheduler(options =>
            Ref.updateAndGet(observed, values => [...values, options.cwd]).pipe(
              Effect.flatMap(values =>
                values.length === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
                  : Deferred.succeed(trailingCompleted, undefined),
              ),
            ),
          );

          yield* schedule({...options, cwd: '/first'});
          yield* Deferred.await(firstStarted);
          for (let index = 1; index <= duplicates; index += 1) {
            yield* schedule({...options, cwd: `/trailing/${index}`});
          }
          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Deferred.await(trailingCompleted);

          expect(yield* Ref.get(observed)).toEqual(['/first', `/trailing/${duplicates}`]);
        }),
      ),
  );

  effectIt.effect('installs a reserved scheduler fiber before honoring caller interruption', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reservationReached = yield* Deferred.make<void>();
        const releaseReservation = yield* Deferred.make<void>();
        const firstStarted = yield* Deferred.make<void>();
        const firstCompleted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const beforeForkCalls = yield* Ref.make(0);
        const runs = yield* Ref.make(0);
        const beforeFork = Ref.updateAndGet(beforeForkCalls, count => count + 1).pipe(
          Effect.flatMap(count =>
            count === 1
              ? Deferred.succeed(reservationReached, undefined).pipe(Effect.andThen(Deferred.await(releaseReservation)))
              : Effect.void,
          ),
        );
        const schedule = yield* makeCodeGraphResumeScheduler(
          () =>
            Ref.updateAndGet(runs, count => count + 1).pipe(
              Effect.flatMap(count =>
                count === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.ensuring(Deferred.succeed(firstCompleted, undefined)),
                    )
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
          () => Effect.void,
          beforeFork,
        );

        const caller = yield* schedule(options).pipe(Effect.forkChild({startImmediately: true}));
        yield* Deferred.await(reservationReached);
        const interrupted = yield* Fiber.interrupt(caller).pipe(Effect.forkChild({startImmediately: true}));
        yield* Deferred.succeed(releaseReservation, undefined);
        yield* Fiber.join(interrupted);
        yield* Deferred.await(firstStarted);
        yield* Deferred.await(firstCompleted);

        yield* schedule(options);
        yield* Deferred.await(secondStarted);
        expect(yield* Ref.get(runs)).toBe(2);
      }),
    ),
  );

  effectIt.effect('consumes a prepared claim with its exact preflight target before reobserving', () =>
    Effect.gen(function* () {
      const oldTarget = {requestKey: demandKey('a')};
      const changedTarget = {requestKey: demandKey('b')};
      const registration = registerCodeGraphRefreshDemand(
        emptyCodeGraphRefreshDemand(demandCheckoutId, demandWorktreeId),
        {now: 1, targetKey: oldTarget.requestKey, token: `cgdq_${'1'.repeat(32)}`},
      );
      const observed = yield* Ref.make(0);
      const ran = yield* Ref.make<string | undefined>(undefined);
      yield* driveCodeGraphBackgroundDemand({
        complete: () => Effect.succeed(emptyCodeGraphRefreshDemand(demandCheckoutId, demandWorktreeId)),
        defer: () => Effect.succeed(emptyCodeGraphRefreshDemand(demandCheckoutId, demandWorktreeId)),
        fail: () => Effect.succeed(emptyCodeGraphRefreshDemand(demandCheckoutId, demandWorktreeId)),
        isSuperseded: () => false,
        observe: Ref.update(observed, count => count + 1).pipe(Effect.as(changedTarget)),
        onRefreshed: () => Effect.void,
        prepared: {registration, target: oldTarget},
        recover: () => Effect.void,
        register: () => Effect.die('prepared claim must not re-register against a changed observation'),
        run: target => Ref.set(ran, target.requestKey).pipe(Effect.as({edges: 1, symbols: 1})),
      });
      expect(yield* Ref.get(ran)).toBe(oldTarget.requestKey);
      expect(yield* Ref.get(observed)).toBe(0);
    }),
  );

  effectIt.effect('queues a trailing iteration for a newly claimed request while a local loop unwinds', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondRan = yield* Deferred.make<void>();
        const runs = yield* Ref.make(0);
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          () =>
            Ref.updateAndGet(runs, count => count + 1).pipe(
              Effect.flatMap(count =>
                count === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
                  : Deferred.succeed(secondRan, undefined),
              ),
            ),
        );
        yield* watcher.refresh({...options, admissionClass: 'background'});
        yield* Deferred.await(firstStarted);
        yield* watcher.refresh({
          ...options,
          admissionClass: 'background',
          refreshDemandPrepared: {
            registration: {
              state: emptyCodeGraphRefreshDemand(demandCheckoutId, demandWorktreeId),
              target: {
                attachmentCount: 1,
                claimStartedAt: 1,
                phase: 'claimed',
                requestedAt: 1,
                targetKey: demandKey('c'),
                targetToken: `cgdq_${'2'.repeat(32)}`,
                updatedAt: 1,
              },
              type: 'claimed',
            },
            target: {} as never,
          },
        });
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondRan);
        expect(yield* Ref.get(runs)).toBe(2);
      }),
    ),
  );

  effectIt.effect('runs a prepared claim before a later ordinary background refresh without losing either', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const ordinaryCompleted = yield* Deferred.make<void>();
        const runs = yield* Ref.make<string[]>([]);
        const prepared = {
          registration: {
            state: emptyCodeGraphRefreshDemand(demandCheckoutId, demandWorktreeId),
            target: {
              attachmentCount: 1,
              claimStartedAt: 1,
              phase: 'claimed' as const,
              requestedAt: 1,
              targetKey: demandKey('e'),
              targetToken: `cgdq_${'3'.repeat(32)}`,
              updatedAt: 1,
            },
            type: 'claimed' as const,
          },
          target: {} as never,
        };
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          options =>
            Ref.updateAndGet(runs, entries => [
              ...entries,
              options.refreshDemandPrepared === undefined
                ? entries.length === 0
                  ? 'predecessor'
                  : 'ordinary'
                : 'prepared',
            ]).pipe(
              Effect.flatMap(entries =>
                entries.length === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
                  : entries.at(-1) === 'ordinary'
                    ? Deferred.succeed(ordinaryCompleted, undefined)
                    : Effect.void,
              ),
            ),
        );
        yield* watcher.refresh({...options, admissionClass: 'background'});
        yield* Deferred.await(firstStarted);
        yield* watcher.refresh({...options, admissionClass: 'background', refreshDemandPrepared: prepared});
        yield* watcher.refresh({...options, admissionClass: 'background'});
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(ordinaryCompleted);
        expect(yield* Ref.get(runs)).toEqual(['predecessor', 'prepared', 'ordinary']);
      }),
    ),
  );

  effectIt.effect('defers the exact persisted claim if scheduled-driver handoff fails', () =>
    Effect.gen(function* () {
      const deferred = yield* Ref.make<string | undefined>(undefined);
      const receipt = {
        requestState: 'started' as const,
        refresh: {state: 'active' as const, type: 'code-graph-refresh-continuity' as const, version: 1 as const},
      };
      const result = yield* handoffCodeGraphPreparedDemand({
        defer: Ref.set(deferred, `cgdq_${'d'.repeat(32)}`),
        receipt,
        schedule: Effect.fail(TestError.make({message: 'deterministic scheduling failure'})),
      }).pipe(Effect.exit);
      expect(result._tag).toBe('Failure');
      expect(yield* Ref.get(deferred)).toBe(`cgdq_${'d'.repeat(32)}`);
    }),
  );

  effectIt.effect('wakes a deferred background target at its persisted retry deadline', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstAttempt = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const callbacks = yield* Ref.make(0);
        let attempts = 0;
        const harness = yield* makeDemandDriverHarness({
          initialTarget: demandKey('1'),
          onRefreshed: () =>
            Ref.update(callbacks, count => count + 1).pipe(
              Effect.andThen(Deferred.succeed(completed, undefined)),
              Effect.asVoid,
            ),
          run: () => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(CodeGraphStoreBusyError.of('expected retry'))),
                )
              : Effect.succeed({edges: 2, symbols: 1});
          },
        });
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          () => harness.driver,
        );
        yield* watcher.refresh({...options, admissionClass: 'background'});
        yield* Deferred.await(firstAttempt);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(249);
        expect(attempts).toBe(1);
        yield* TestClock.adjust(1);
        yield* Deferred.await(completed);

        expect(attempts).toBe(2);
        expect(yield* Ref.get(callbacks)).toBe(1);
        expect(yield* Ref.get(harness.state)).toMatchObject({active: undefined, desired: undefined});
      }),
    ),
  );

  effectIt.effect('releases an interrupted live-host claim and lets an early caller schedule its retry', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstAttempt = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        let attempts = 0;
        const harness = yield* makeDemandDriverHarness({
          initialTarget: demandKey('2'),
          onRefreshed: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
          run: () => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed({edges: 4, symbols: 3});
          },
        });
        const interrupted = yield* Effect.forkChild(harness.driver);
        yield* Deferred.await(firstAttempt);
        yield* Fiber.interrupt(interrupted);
        const released = yield* Ref.get(harness.state);
        expect(released.active).toBeUndefined();
        expect(released.desired?.retry).toMatchObject({attempt: 1, notBefore: 250});

        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          () => harness.driver,
        );
        yield* watcher.refresh({...options, admissionClass: 'background'});
        yield* Effect.yieldNow;
        yield* TestClock.adjust(250);
        yield* Deferred.await(completed);
        expect(attempts).toBe(2);
        expect(yield* Ref.get(harness.state)).toMatchObject({active: undefined, desired: undefined});
      }),
    ),
  );

  effectIt.effect('completes publication before a failing callback and still drives the queued target', () =>
    Effect.gen(function* () {
      const runs: string[] = [];
      let callbacks = 0;
      const first = demandKey('3');
      const second = demandKey('4');
      const harness = yield* makeDemandDriverHarness({
        initialTarget: first,
        onRefreshed: () => {
          callbacks += 1;
          return callbacks === 1 ? Effect.fail(TestError.make({message: 'expected callback failure'})) : Effect.void;
        },
        run: (target, queue) =>
          Effect.gen(function* () {
            runs.push(target.requestKey);
            if (target.requestKey === first) yield* queue(second);
            return {edges: runs.length * 2, symbols: runs.length};
          }),
      });
      yield* harness.driver;

      expect(runs).toEqual([first, second]);
      expect(callbacks).toBe(2);
      expect(yield* Ref.get(harness.state)).toMatchObject({active: undefined, desired: undefined});
    }),
  );

  effectIt.effect('records direct latest-target intent before same-key execution deduplication', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = demandKey('5');
        const second = demandKey('6');
        const latest = demandKey('7');
        const firstStarted = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const latestCompleted = yield* Deferred.make<void>();
        const requested = yield* Ref.make(first);
        const runs: string[] = [];
        const harness = yield* makeDemandDriverHarness({
          initialTarget: first,
          onRefreshed: () =>
            runs.at(-1) === latest ? Deferred.succeed(latestCompleted, undefined).pipe(Effect.asVoid) : Effect.void,
          run: target =>
            Effect.gen(function* () {
              runs.push(target.requestKey);
              if (target.requestKey === first) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(firstRelease);
              }
              return {edges: runs.length * 2, symbols: runs.length};
            }),
        });
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          () => harness.driver,
          {},
          () => Effect.void,
          refreshOptions => Ref.get(requested).pipe(Effect.flatMap(harness.enqueue), Effect.as(refreshOptions)),
        );

        expect(yield* watcher.refresh({...options, admissionClass: 'background'})).toBe(true);
        yield* Deferred.await(firstStarted);
        yield* Ref.set(requested, second);
        expect(yield* watcher.refresh({...options, admissionClass: 'background'})).toBe(false);
        yield* Ref.set(requested, latest);
        expect(yield* watcher.refresh({...options, admissionClass: 'background'})).toBe(false);
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Deferred.await(latestCompleted);

        expect(runs).toEqual([first, latest]);
        expect(yield* Ref.get(harness.state)).toMatchObject({active: undefined, desired: undefined});
      }),
    ),
  );

  effectIt.effect('drives queued background intent after an active current-required refresh', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = demandKey('8');
        const currentStarted = yield* Deferred.make<void>();
        const releaseCurrent = yield* Deferred.make<void>();
        const backgroundCompleted = yield* Deferred.make<void>();
        const admissions: Array<CodeGraphWatchOptions['admissionClass']> = [];
        const harness = yield* makeDemandDriverHarness({
          initialTarget: target,
          onRefreshed: () => Deferred.succeed(backgroundCompleted, undefined).pipe(Effect.asVoid),
          run: () => Effect.succeed({edges: 2, symbols: 1}),
        });
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          refreshOptions => {
            admissions.push(refreshOptions.admissionClass);
            return refreshOptions.admissionClass === 'background'
              ? harness.driver
              : Deferred.succeed(currentStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseCurrent)));
          },
          {},
          () => Effect.void,
          refreshOptions =>
            refreshOptions.admissionClass === 'background'
              ? harness.enqueue(target).pipe(Effect.as(refreshOptions))
              : Effect.succeed(refreshOptions),
        );

        expect(yield* watcher.refresh(options)).toBe(true);
        yield* Deferred.await(currentStarted);
        expect(yield* watcher.refresh({...options, admissionClass: 'background'})).toBe(false);
        yield* Deferred.succeed(releaseCurrent, undefined);
        yield* Deferred.await(backgroundCompleted);

        expect(admissions).toEqual(['current-required', 'background']);
        expect(yield* Ref.get(harness.state)).toMatchObject({active: undefined, desired: undefined});
      }),
    ),
  );

  effectIt.effect('keeps a parked background coordinator when a current-required caller joins', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstAttempt = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const admissions: Array<CodeGraphWatchOptions['admissionClass']> = [];
        let attempts = 0;
        const harness = yield* makeDemandDriverHarness({
          initialTarget: demandKey('9'),
          onRefreshed: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
          run: () => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(CodeGraphStoreBusyError.of('expected retry'))),
                )
              : Effect.succeed({edges: 2, symbols: 1});
          },
        });
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          refreshOptions => {
            admissions.push(refreshOptions.admissionClass);
            return refreshOptions.admissionClass === 'background' ? harness.driver : Effect.void;
          },
        );

        expect(yield* watcher.refresh({...options, admissionClass: 'background'})).toBe(true);
        yield* Deferred.await(firstAttempt);
        yield* Effect.yieldNow;
        expect(yield* watcher.refresh(options)).toBe(false);
        yield* TestClock.adjust(250);
        yield* Deferred.await(completed);

        expect(admissions).toEqual(['background', 'background']);
        expect(yield* Ref.get(harness.state)).toMatchObject({active: undefined, desired: undefined});
      }),
    ),
  );

  effectIt.effect('parks retry deadlines outside the two global refresh permits', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstAttempt = yield* Deferred.make<void>();
        const secondAttempt = yield* Deferred.make<void>();
        const releaseRetries = yield* Deferred.make<void>();
        const healthyStarted = yield* Deferred.make<void>();
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          refreshOptions => {
            if (refreshOptions.key === 'retry-a') {
              return Deferred.succeed(firstAttempt, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRetries)),
                Effect.andThen(CodeGraphRefreshRetryDeferred.make({notBefore: 10_000})),
              );
            }
            if (refreshOptions.key === 'retry-b') {
              return Deferred.succeed(secondAttempt, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRetries)),
                Effect.andThen(CodeGraphRefreshRetryDeferred.make({notBefore: 10_000})),
              );
            }
            return Deferred.succeed(healthyStarted, undefined).pipe(Effect.asVoid);
          },
        );

        yield* watcher.refresh({...options, admissionClass: 'background', key: 'retry-a'});
        yield* watcher.refresh({...options, admissionClass: 'background', key: 'retry-b'});
        yield* Deferred.await(firstAttempt);
        yield* Deferred.await(secondAttempt);
        yield* Deferred.succeed(releaseRetries, undefined);
        yield* watcher.refresh({...options, admissionClass: 'background', key: 'healthy'});
        yield* Deferred.await(healthyStarted);

        expect(yield* watcher.metrics).toMatchObject({executingRefreshHighWater: 2});
      }),
    ),
  );

  it('orders home builder tickets by current-required priority and FIFO within a class (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('background' as const, 'current-required' as const)), classes => {
        const ordered = orderCodeGraphBuilderAdmissionTickets(
          classes.map((admissionClass, index) => ({
            admissionClass,
            createdAt: index,
            token: `${index}`.padStart(4, '0'),
          })),
        );
        const firstBackground = ordered.findIndex(ticket => ticket.admissionClass === 'background');
        if (firstBackground >= 0) {
          expect(ordered.slice(firstBackground).every(ticket => ticket.admissionClass === 'background')).toBe(true);
        }
        for (const admissionClass of ['current-required', 'background'] as const) {
          const arrivals = ordered
            .filter(ticket => ticket.admissionClass === admissionClass)
            .map(ticket => ticket.createdAt);
          expect(arrivals).toEqual([...arrivals].sort((left, right) => left - right));
        }
      }),
      {numRuns: 100},
    );
  });

  it('admits at most two unique non-current ref tips for prewarming', () => {
    const objectId = fc
      .array(fc.integer({max: 15, min: 0}), {maxLength: 40, minLength: 40})
      .map(values => values.map(value => value.toString(16)).join(''));
    fc.assert(
      fc.property(
        fc.array(objectId, {maxLength: 20}),
        objectId,
        fc.integer({max: 20, min: -5}),
        (ids, current, limit) => {
          const candidates = prewarmCandidatesFromRefOutput(
            [...ids, current, 'not-an-object-id', ...ids].join('\n'),
            current,
            limit,
          );
          expect(candidates.length).toBeLessThanOrEqual(2);
          expect(new Set(candidates).size).toBe(candidates.length);
          expect(candidates).not.toContain(current);
          expect(candidates.every(value => /^[0-9a-f]{40}$/u.test(value))).toBe(true);
        },
      ),
      {numRuns: 250},
    );
  });

  it('admits background refresh only for an overlay-success outcome on the current ready base', () => {
    const status = (
      snapshotId: string,
      outcome: 'overlay-success' | 'resolution-surface-changed',
      completedAt = '2026-08-17T12:00:00.000Z',
    ) => ({
      materialization: undefined,
      result: {
        dirty: true,
        edges: 1,
        files: 1,
        overlayAssessment: {outcome},
        snapshotId,
        symbols: 1,
      },
      state: 'completed' as const,
      timestamps: {
        completedAt,
        heartbeatAt: completedAt,
        lastProgressAt: completedAt,
        phaseStartedAt: completedAt,
        startedAt: completedAt,
        updatedAt: completedAt,
      },
    });

    expect(codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh('current', [])).toBe(false);
    expect(
      codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh('current', [
        status('previous', 'overlay-success'),
        status('current', 'resolution-surface-changed'),
      ]),
    ).toBe(false);
    expect(
      codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh('current', [status('current', 'overlay-success')]),
    ).toBe(true);
    expect(
      codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh('current', [
        status('current', 'overlay-success', '2026-08-17T12:00:00.000Z'),
        status('current', 'resolution-surface-changed', '2026-08-17T12:01:00.000Z'),
      ]),
    ).toBe(false);
  });

  effectIt.effect(
    'deduplicates concurrent session registrations and finalizes the watcher with the session scope',
    () =>
      Effect.gen(function* () {
        const starts = yield* Ref.make(0);
        const stops = yield* Ref.make(0);
        const started = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const watcher = yield* makeCodeGraphWatcher(
              () =>
                Effect.acquireRelease(
                  Ref.update(starts, count => count + 1).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
                  () => Ref.update(stops, count => count + 1),
                ).pipe(Effect.andThen(Effect.never), Effect.scoped),
              () => Effect.void,
            );
            yield* Effect.all(
              Array.from({length: 20}, () => watcher.ensure(options)),
              {concurrency: 'unbounded'},
            );
            yield* Deferred.await(started);
            expect(yield* Ref.get(starts)).toBe(1);
            expect(yield* Ref.get(stops)).toBe(0);
          }),
        );
        const counts = {starts: yield* Ref.get(starts), stops: yield* Ref.get(stops)};

        expect(counts).toEqual({starts: 1, stops: 1});
      }),
  );

  effectIt.effect('keeps explicit watch mode distinct from session registration', () =>
    Effect.gen(function* () {
      const initialRefreshes: boolean[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* makeCodeGraphWatcher(
            (_options, initialRefresh) =>
              Effect.sync(() => {
                initialRefreshes.push(initialRefresh);
              }),
            () => Effect.void,
          );
          yield* watcher.watch(options);
        }),
      );

      expect(initialRefreshes).toEqual([true]);
    }),
  );

  effectIt.effect(
    'keeps caller-supplied background admission on refresh and defaults inspect refresh to current-required',
    () =>
      Effect.gen(function* () {
        const classes = yield* Ref.make<Array<CodeGraphWatchOptions['admissionClass']>>([]);
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.void,
          refreshOptions => Ref.update(classes, current => [...current, refreshOptions.admissionClass]),
        );

        yield* watcher.refresh({...options, admissionClass: 'background', key: 'background'});
        let observed = yield* Ref.get(classes);
        for (let attempt = 0; attempt < 32 && observed.length < 1; attempt += 1) {
          yield* Effect.yieldNow;
          observed = yield* Ref.get(classes);
        }
        expect(observed).toEqual(['background']);

        yield* watcher.refresh({...options, key: 'inspect'});
        for (let attempt = 0; attempt < 32 && observed.length < 2; attempt += 1) {
          yield* Effect.yieldNow;
          observed = yield* Ref.get(classes);
        }

        expect(observed).toEqual(['background', 'current-required']);
      }).pipe(Effect.scoped),
  );

  effectIt.effect('starts a replacement watcher after the previous run terminates', () =>
    Effect.gen(function* () {
      const starts = yield* Effect.scoped(
        Effect.gen(function* () {
          const count = yield* Ref.make(0);
          const firstStarted = yield* Deferred.make<void>();
          const firstRelease = yield* Deferred.make<void>();
          const firstStopped = yield* Deferred.make<void>();
          const secondStarted = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () =>
              Ref.updateAndGet(count, value => value + 1).pipe(
                Effect.tap(value =>
                  value === 1 ? Deferred.succeed(firstStarted, undefined) : Deferred.succeed(secondStarted, undefined),
                ),
                Effect.flatMap(value => (value === 1 ? Deferred.await(firstRelease) : Effect.never)),
                Effect.ensuring(Deferred.succeed(firstStopped, undefined)),
              ),
            () => Effect.void,
          );

          yield* watcher.ensure(options);
          yield* Deferred.await(firstStarted);
          yield* Deferred.succeed(firstRelease, undefined);
          yield* Deferred.await(firstStopped);
          yield* Effect.yieldNow;
          yield* watcher.ensure(options);
          yield* Deferred.await(secondStarted);
          return yield* Ref.get(count);
        }),
      );

      expect(starts).toBe(2);
    }),
  );

  effectIt.effect('starts a replacement watcher after the previous run fails', () =>
    Effect.gen(function* () {
      const starts = yield* Effect.scoped(
        Effect.gen(function* () {
          const count = yield* Ref.make(0);
          const firstStarted = yield* Deferred.make<void>();
          const firstRelease = yield* Deferred.make<void>();
          const firstStopped = yield* Deferred.make<void>();
          const secondStarted = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () =>
              Ref.updateAndGet(count, value => value + 1).pipe(
                Effect.tap(value =>
                  value === 1 ? Deferred.succeed(firstStarted, undefined) : Deferred.succeed(secondStarted, undefined),
                ),
                Effect.flatMap(value =>
                  value === 1
                    ? Deferred.await(firstRelease).pipe(
                        Effect.andThen(Effect.fail(TestError.make({message: 'transient watcher failure'}))),
                      )
                    : Effect.never,
                ),
                Effect.ensuring(Deferred.succeed(firstStopped, undefined)),
              ),
            () => Effect.void,
          );

          yield* watcher.ensure(options);
          yield* Deferred.await(firstStarted);
          yield* Deferred.succeed(firstRelease, undefined);
          yield* Deferred.await(firstStopped);
          yield* Effect.yieldNow;
          yield* watcher.ensure(options);
          yield* Deferred.await(secondStarted);
          return yield* Ref.get(count);
        }),
      );

      expect(starts).toBe(2);
    }),
  );

  effectIt.effect('deduplicates background refreshes and exposes progress until the graph is ready', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const starts = yield* Ref.make(0);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            refreshOptions =>
              Ref.update(starts, count => count + 1).pipe(
                Effect.andThen(
                  refreshOptions.onProgress?.({
                    accepted: 128,
                    completed: 132,
                    excluded: 12,
                    phase: 'scanning',
                    skipped: 4,
                    total: 256,
                    unit: 'files',
                  }) ?? Effect.void,
                ),
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(refreshOptions.onRefreshed?.(200, 400) ?? Effect.void),
                Effect.ensuring(Deferred.succeed(completed, undefined)),
              ),
          );

          yield* Effect.all(
            Array.from({length: 20}, () => watcher.refresh(options)),
            {concurrency: 'unbounded'},
          );
          yield* Deferred.await(started);
          const indexing = yield* watcher.status(options.key);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(completed);
          const ready = yield* watcher.status(options.key);
          return {indexing, ready, starts: yield* Ref.get(starts)};
        }),
      );

      expect(result.starts).toBe(1);
      expect(result.indexing).toMatchObject({
        _tag: 'Some',
        value: {
          progress: {
            accepted: 128,
            completed: 132,
            excluded: 12,
            phase: 'scanning',
            skipped: 4,
            total: 256,
            unit: 'files',
          },
          state: 'indexing',
          timing: {
            buildId: expect.any(String),
            elapsedMilliseconds: expect.any(Number),
            lastProgressAgeMilliseconds: expect.any(Number),
          },
        },
      });
      expect(result.ready).toMatchObject({
        _tag: 'Some',
        value: {edges: 400, state: 'ready', symbols: 200},
      });
    }),
  );

  effectIt.effect('coalesces equivalent explicit and inferred project routes while isolating a sibling scope', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Ref.make<string[]>([]);
        const firstStarted = yield* Deferred.make<void>();
        const siblingStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const project = {
          graph: {closure: 'dependencies' as const, roots: ['apps/a']},
          name: 'a',
          uri: 'threadnote://resources/repos/a',
        };
        const sibling = {
          graph: {closure: 'dependencies' as const, roots: ['apps/b']},
          name: 'b',
          uri: 'threadnote://resources/repos/b',
        };
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          refreshOptions =>
            Effect.gen(function* () {
              const observed = yield* Ref.updateAndGet(starts, current => [...current, refreshOptions.project!.uri]);
              yield* Deferred.succeed(observed.length === 1 ? firstStarted : siblingStarted, undefined);
              yield* Deferred.await(release);
            }),
        );
        const rootExplicit = {...options, cwd: '/fixture/repository', key: 'worktree', project};
        const nestedInferred = {...rootExplicit, cwd: '/fixture/repository/apps/a'};
        const siblingRoute = {...rootExplicit, cwd: '/fixture/repository/apps/b', project: sibling};

        expect(yield* watcher.refresh(rootExplicit)).toBe(true);
        yield* Deferred.await(firstStarted);
        expect(yield* watcher.refresh(nestedInferred)).toBe(false);
        expect(yield* watcher.refresh(siblingRoute)).toBe(true);
        yield* Deferred.await(siblingStarted);
        expect(yield* Ref.get(starts)).toEqual([project.uri, sibling.uri]);
        yield* Deferred.succeed(release, undefined);
      }),
    ),
  );

  effectIt.effect('returns promptly under held-writer load and publishes one typed deferred failure', () =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const logger = Logger.make<unknown, void>(options => {
        logs.push(String(options.message));
      });
      const observedFailures: unknown[] = [];
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const starts = yield* Ref.make(0);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            () =>
              Ref.update(starts, count => count + 1).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  Effect.fail(
                    CodeGraphStoreBusyError.of('private writer detail /Users/private/graph.sqlite', {
                      operation: 'load /Users/private/graph.sqlite',
                    }),
                  ),
                ),
              ),
            {
              onRefreshFailure: failure => {
                observedFailures.push(failure);
                throw TestError.make({message: 'private telemetry defect'});
              },
            },
          );

          yield* watcher.ensure(options);
          const requests = yield* Effect.all(
            Array.from({length: 128}, () => watcher.refresh(options)),
            {concurrency: 'unbounded'},
          );
          yield* Deferred.await(started);
          const whileHeld = yield* watcher.status(options.key);
          yield* Deferred.succeed(release, undefined);
          let settled = yield* watcher.status(options.key);
          for (
            let attempt = 0;
            attempt < 16 && settled._tag === 'Some' && settled.value.state === 'indexing';
            attempt += 1
          ) {
            yield* Effect.yieldNow;
            settled = yield* watcher.status(options.key);
          }
          return {requests, settled, starts: yield* Ref.get(starts), whileHeld};
        }),
      ).pipe(provideTestLayer(Logger.layer([logger])));

      expect(result.starts).toBe(1);
      expect(result.requests.filter(Boolean)).toHaveLength(1);
      expect(result.whileHeld).toMatchObject({_tag: 'Some', value: {state: 'indexing'}});
      expect(result.settled).toMatchObject({
        _tag: 'Some',
        value: {
          failure: {code: 'busy', operation: 'refresh code graph', recovery: 'defer', retryable: true},
          state: 'deferred',
        },
      });
      const serialized = JSON.stringify(result.settled);
      expect(serialized).not.toContain('/Users/private');
      expect(serialized).not.toContain('private writer detail');
      expect(logs).toContain('Code graph background refresh deferred (busy; recovery: defer).');
      expect(logs.join('\n')).not.toContain('/fixture/repository');
      expect(logs.join('\n')).not.toContain('/Users/private');
      expect(logs.join('\n')).not.toContain('private writer detail');
      expect(observedFailures).toEqual([
        {code: 'busy', operation: 'refresh code graph', recovery: 'defer', retryable: true},
      ]);
    }),
  );

  effectIt.effect('normalizes operational refresh failures without retaining native details', () =>
    Effect.gen(function* () {
      const privateMarker = '/Volumes/private/native-graph.sqlite';
      const failures = [
        CodeGraphStoreBusyError.of(`busy ${privateMarker}`),
        CodeGraphStoreNoSpaceError.of(`full ${privateMarker}`),
        CodeGraphStorePermissionError.of(`permission ${privateMarker}`),
        CodeGraphRuntimeReconnectRequiredError.of(),
        CodeGraphStoreTransientIoError.of(`io ${privateMarker}`),
      ];

      for (const failure of failures) {
        const status = yield* Effect.scoped(
          Effect.gen(function* () {
            const watcher = yield* makeCodeGraphWatcher(
              () => Effect.never,
              () => Effect.fail(failure),
            );
            const failureOptions = {...options, key: `${options.key}:${failure.code}`};
            yield* watcher.ensure(failureOptions);
            yield* watcher.refresh(failureOptions);
            let current = yield* watcher.status(failureOptions.key);
            for (let attempt = 0; attempt < 16; attempt += 1) {
              if (current._tag === 'Some' && current.value.state !== 'indexing') break;
              yield* Effect.yieldNow;
              current = yield* watcher.status(failureOptions.key);
            }
            return current;
          }),
        );

        expect(status).toMatchObject({
          _tag: 'Some',
          value: {failure: {code: failure.code, operation: 'refresh code graph'}, state: 'deferred'},
        });
        if (Schema.is(CodeGraphRuntimeReconnectRequiredError)(failure)) {
          expect(status).toMatchObject({
            _tag: 'Some',
            value: {failure: {recovery: 'reconnect-runtime', retryable: false}, state: 'deferred'},
          });
        }
        expect(JSON.stringify(status)).not.toContain(privateMarker);
      }
    }),
  );

  effectIt.effect('keeps a known capacity failure parked without an automatic retry loop', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Ref.make(0);
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          () =>
            Ref.update(starts, count => count + 1).pipe(
              Effect.andThen(Effect.fail(CodeGraphStoreNoSpaceError.of('expected capacity pause'))),
            ),
        );
        const capacityOptions = {...options, admissionClass: 'background' as const, key: 'capacity-pause'};

        yield* watcher.ensure(capacityOptions);
        expect(yield* watcher.refresh(capacityOptions)).toBe(true);
        let status = yield* watcher.status(capacityOptions.key);
        for (let attempt = 0; attempt < 32; attempt += 1) {
          if (status._tag === 'Some' && status.value.state === 'deferred') break;
          yield* Effect.yieldNow;
          status = yield* watcher.status(capacityOptions.key);
        }
        for (let attempt = 0; attempt < 32; attempt += 1) yield* Effect.yieldNow;

        expect(status).toMatchObject({
          _tag: 'Some',
          value: {failure: {code: 'no-space', retryable: false}, state: 'deferred'},
        });
        expect(yield* Ref.get(starts)).toBe(1);
      }),
    ),
  );

  effectIt.effect('preserves bounded capacity evidence and its dynamic retry policy in refresh status', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const evidence = {
          activeReservations: [{bytes: 256, role: 'durable' as const}],
          calibrationIdentity: 'calibration-v1',
          decisionLayer: 'bounded-write-reservation' as const,
          estimateBasis: 'final-fact-bytes-and-row-count' as const,
          filesystems: [{availableBytes: 512, requiredBytes: 1_024, role: 'durable' as const}],
          modelVersion: 1,
          recovery: 'defer' as const,
          retryable: true,
          scope: {checkoutId: 'a'.repeat(64), scopeId: `code-graph-scope:${'b'.repeat(64)}`},
        };
        const watcher = yield* makeCodeGraphWatcher(
          () => Effect.never,
          () => Effect.fail(CodeGraphDiskCapacityPressureError.of('reserve graph storage', evidence)),
        );
        const capacityOptions = {...options, key: 'retryable-capacity-pressure'};

        yield* watcher.ensure(capacityOptions);
        expect(yield* watcher.refresh(capacityOptions)).toBe(true);
        let status = yield* watcher.status(capacityOptions.key);
        for (let attempt = 0; attempt < 32; attempt += 1) {
          if (status._tag === 'Some' && status.value.state === 'deferred') break;
          yield* Effect.yieldNow;
          status = yield* watcher.status(capacityOptions.key);
        }

        expect(status).toMatchObject({
          _tag: 'Some',
          value: {
            failure: {code: 'no-space', evidence, recovery: 'defer', retryable: true},
            state: 'deferred',
          },
        });
      }),
    ),
  );

  it('restores persisted capacity evidence in a new watcher host', () => {
    const evidence = {
      activeReservations: [{bytes: 256, role: 'durable' as const}],
      calibrationIdentity: 'calibration-v1',
      decisionLayer: 'bounded-write-reservation' as const,
      estimateBasis: 'final-fact-bytes-and-row-count' as const,
      filesystems: [{availableBytes: 512, requiredBytes: 1_024, role: 'durable' as const}],
      modelVersion: 2,
      recovery: 'defer' as const,
      retryable: true,
    };
    const timestamp = '2026-09-28T00:00:00.000Z';
    const status: ObservedCodeGraphBuildStatus = {
      buildId: 'a'.repeat(32),
      counters: {},
      identity: {
        checkoutId: 'b'.repeat(64),
        commit: 'c'.repeat(40),
        repositoryId: 'd'.repeat(64),
        worktreeId: 'e'.repeat(64),
      },
      owner: {processId: 42, runtime: 'bun', runtimeVersion: '1.4.2'},
      phase: 'materializing',
      schemaVersion: 1,
      state: 'failed',
      timestamps: {
        heartbeatAt: timestamp,
        lastProgressAt: timestamp,
        phaseStartedAt: timestamp,
        startedAt: timestamp,
        updatedAt: timestamp,
      },
      error: {
        capacity: {
          code: 'no-space' as const,
          evidence,
          operation: 'stage persistent code graph facts' as const,
        },
        summary: 'Capacity is temporarily reserved.',
      },
      observation: {heartbeatAgeMilliseconds: 0, liveness: 'failed'},
    };

    expect(persistedRefreshStatus(status)).toEqual({
      failure: {
        code: 'no-space',
        evidence,
        operation: 'refresh code graph',
        recovery: 'defer',
        retryable: true,
      },
      state: 'deferred',
    });
  });

  effectIt.effect('turns a refresh defect into one bounded unknown status instead of stranding indexing', () =>
    Effect.gen(function* () {
      const privateMarker = '/Users/private/defect.sqlite';
      const logs: string[] = [];
      const logger = Logger.make<unknown, void>(options => {
        logs.push(String(options.message));
      });
      const status = yield* Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            () => Effect.die(TestError.make({message: `native defect ${privateMarker}`})),
          );
          yield* watcher.ensure(options);
          yield* watcher.refresh(options);
          let current = yield* watcher.status(options.key);
          for (let attempt = 0; attempt < 16; attempt += 1) {
            if (current._tag === 'Some' && current.value.state !== 'indexing') break;
            yield* Effect.yieldNow;
            current = yield* watcher.status(options.key);
          }
          return current;
        }),
      ).pipe(provideTestLayer(Logger.layer([logger])));

      expect(status).toMatchObject({
        _tag: 'Some',
        value: {
          failure: {code: 'unknown', operation: 'refresh code graph', recovery: 'diagnose', retryable: false},
          state: 'deferred',
        },
      });
      expect(logs).toContain('Code graph background refresh deferred (unknown; recovery: diagnose).');
      expect(`${JSON.stringify(status)}\n${logs.join('\n')}`).not.toContain(privateMarker);
    }),
  );

  effectIt.effect('propagates refresh scope interruption without converting it into a deferred failure', () =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const logger = Logger.make<unknown, void>(options => {
        logs.push(String(options.message));
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          );
          yield* watcher.ensure(options);
          yield* watcher.refresh(options);
          yield* Deferred.await(started);
          expect(yield* watcher.status(options.key)).toMatchObject({_tag: 'Some', value: {state: 'indexing'}});
        }),
      ).pipe(provideTestLayer(Logger.layer([logger])));

      expect(logs.some(message => message.includes('background refresh deferred'))).toBe(false);
    }),
  );

  effectIt.effect('keeps periodic reconciliation alive after a filesystem watch defect', () => {
    const privateMarker = '/Users/private/watch-root';
    const logs: string[] = [];
    const logger = Logger.make<unknown, void>(options => {
      logs.push(String(options.message));
    });
    return Effect.gen(function* () {
      const refreshes = yield* Ref.make(0);
      const fiber = yield* watchRepository(
        {watch: () => Stream.die(TestError.make({message: `watch defect ${privateMarker}`}))} as never,
        {} as never,
        options,
        false,
        () => Ref.update(refreshes, count => count + 1),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const beforeReconciliation = yield* Ref.get(refreshes);
      yield* TestClock.adjust('5 minutes');
      yield* Effect.yieldNow;

      expect(yield* Ref.get(refreshes)).toBeGreaterThan(beforeReconciliation);
      expect(logs).toContain('Code graph filesystem watch stopped; periodic reconciliation remains active.');
      expect(logs.join('\n')).not.toContain(privateMarker);
      yield* Fiber.interrupt(fiber);
    }).pipe(provideTestLayer(Logger.layer([logger])), Effect.scoped);
  });

  effectIt.effect('requests initial maintenance and orders change maintenance before refresh', () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<string[]>([]);
      const fiber = yield* watchRepository(
        {watch: () => Stream.make({path: 'source.ts'})} as never,
        {
          isAbsolute: (value: string) => value.startsWith('/'),
          join: (...values: string[]) => values.join('/'),
          relative: () => 'source.ts',
          sep: '/',
        } as never,
        options,
        false,
        () => Ref.update(events, current => [...current, 'refresh']),
        {
          periodicRefreshRequired: Effect.succeed(false),
          requestAfterChange: Ref.update(events, current => [...current, 'change-maintenance']).pipe(
            Effect.andThen(Effect.fail(TestError.make({message: 'maintenance scheduling defect'}))),
          ),
          requestInitial: Ref.update(events, current => [...current, 'initial-maintenance']),
        },
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust('751 millis');
      yield* Effect.yieldNow;

      expect(yield* Ref.get(events)).toEqual(['initial-maintenance', 'change-maintenance', 'refresh']);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  effectIt.effect('requests recursive filesystem events so nested source changes trigger refresh', () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<string[]>([]);
      let watchOptions: {readonly recursive?: boolean} | undefined;
      const fiber = yield* watchRepository(
        {
          watch: (_root: string, observedOptions?: {readonly recursive?: boolean}) => {
            watchOptions = observedOptions;
            return Stream.make({path: 'src/nested/value.ts'});
          },
        } as never,
        {
          isAbsolute: (value: string) => value.startsWith('/'),
          join: (...values: string[]) => values.join('/'),
          relative: (from: string, to: string) => (to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to),
          sep: '/',
        } as never,
        options,
        false,
        () => Ref.update(events, current => [...current, 'refresh']),
        {
          periodicRefreshRequired: Effect.succeed(false),
          requestAfterChange: Ref.update(events, current => [...current, 'change-maintenance']),
          requestInitial: Effect.void,
        },
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust('751 millis');
      yield* Effect.yieldNow;

      expect(watchOptions).toEqual({recursive: true});
      expect(yield* Ref.get(events)).toEqual(['change-maintenance', 'refresh']);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  effectIt.effect('reconciles the latest target after an adjacent filesystem event is lost', () =>
    Effect.gen(function* () {
      const latestTarget = yield* Ref.make('f2');
      const requestedTargets = yield* Ref.make<string[]>([]);
      const fiber = yield* watchRepository(
        {watch: () => Stream.make({path: 'source.ts'})} as never,
        {
          isAbsolute: (value: string) => value.startsWith('/'),
          join: (...values: string[]) => values.join('/'),
          relative: () => 'source.ts',
          sep: '/',
        } as never,
        options,
        false,
        () =>
          Ref.get(latestTarget).pipe(
            Effect.flatMap(target => Ref.update(requestedTargets, current => [...current, target])),
          ),
        {
          changeRefreshRequired: Effect.succeed(true),
          periodicRefreshRequired: Effect.succeed(true),
          requestAfterChange: Effect.void,
          requestInitial: Effect.void,
        },
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust('751 millis');
      yield* Effect.yieldNow;
      expect(yield* Ref.get(requestedTargets)).toEqual(['f2']);

      // Model a second write whose native watch event was lost.
      yield* Ref.set(latestTarget, 'f3');
      yield* TestClock.adjust('44 seconds');
      yield* Effect.yieldNow;
      expect(yield* Ref.get(requestedTargets)).toEqual(['f2']);

      yield* TestClock.adjust('1 second');
      yield* Effect.yieldNow;
      expect(yield* Ref.get(requestedTargets)).toEqual(['f2', 'f3']);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  effectIt.effect.prop(
    'keeps one restartable quiet-window reconciliation across delivered changes',
    {changes: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 20}))},
    ({changes}) =>
      Effect.gen(function* () {
        const probes = yield* Ref.make(0);
        const refreshes = yield* Ref.make(0);
        const {scheduleSettled} = yield* makeCodeGraphWatchReconciliation({
          probe: Ref.update(probes, count => count + 1).pipe(Effect.as(true)),
          reload: Effect.void,
          requestRefresh: () => Ref.update(refreshes, count => count + 1),
        });
        yield* Effect.forEach(
          Array.from({length: changes}, (_, index) => index),
          index =>
            scheduleSettled.pipe(Effect.andThen(index === changes - 1 ? Effect.void : TestClock.adjust('1 second'))),
          {discard: true},
        );
        yield* TestClock.adjust('44 seconds');
        expect(yield* Ref.get(probes)).toBe(0);
        expect(yield* Ref.get(refreshes)).toBe(0);
        yield* TestClock.adjust('1 second');
        yield* Effect.yieldNow;
        expect(yield* Ref.get(probes)).toBe(1);
        expect(yield* Ref.get(refreshes)).toBe(1);
      }).pipe(Effect.scoped),
  );

  effectIt.effect('interrupts a pending quiet-window reconciliation with its watcher', () =>
    Effect.gen(function* () {
      const refreshes = yield* Ref.make(0);
      const fiber = yield* watchRepository(
        {watch: () => Stream.make({path: 'source.ts'})} as never,
        {
          isAbsolute: (value: string) => value.startsWith('/'),
          join: (...values: string[]) => values.join('/'),
          relative: () => 'source.ts',
          sep: '/',
        } as never,
        options,
        false,
        () => Ref.update(refreshes, count => count + 1),
        {
          changeRefreshRequired: Effect.succeed(true),
          periodicRefreshRequired: Effect.succeed(true),
          requestAfterChange: Effect.void,
          requestInitial: Effect.void,
        },
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust('751 millis');
      yield* Effect.yieldNow;
      expect(yield* Ref.get(refreshes)).toBe(1);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust('45 seconds');
      yield* Effect.yieldNow;
      expect(yield* Ref.get(refreshes)).toBe(1);
    }).pipe(Effect.scoped),
  );

  effectIt.effect('suppresses change refresh when the cached overlay outcome is not eligible', () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<string[]>([]);
      const fiber = yield* watchRepository(
        {watch: () => Stream.make({path: 'source.ts'})} as never,
        {
          isAbsolute: (value: string) => value.startsWith('/'),
          join: (...values: string[]) => values.join('/'),
          relative: () => 'source.ts',
          sep: '/',
        } as never,
        options,
        false,
        () => Ref.update(events, current => [...current, 'refresh']),
        {
          changeRefreshRequired: Effect.succeed(false),
          periodicRefreshRequired: Effect.succeed(false),
          requestAfterChange: Ref.update(events, current => [...current, 'change-maintenance']),
          requestInitial: Effect.void,
        },
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust('751 millis');
      yield* Effect.yieldNow;

      expect(yield* Ref.get(events)).toEqual(['change-maintenance']);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  effectIt.effect('refreshes on periodic positive staleness and preserves on current or unknown evidence', () =>
    Effect.gen(function* () {
      for (const testCase of [
        {expectedRefreshes: 0, probe: Effect.succeed(false)},
        {expectedRefreshes: 1, probe: Effect.succeed(true)},
        {expectedRefreshes: 0, probe: Effect.fail(TestError.make({message: 'unknown freshness'}))},
      ] as const) {
        const refreshes = yield* Ref.make(0);
        const maintenanceRequests = yield* Ref.make(0);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* watchRepository(
              {watch: () => Stream.never} as never,
              {} as never,
              options,
              false,
              () => Ref.update(refreshes, count => count + 1),
              {
                periodicRefreshRequired: Ref.update(maintenanceRequests, count => count + 1).pipe(
                  Effect.andThen(testCase.probe),
                ),
                requestAfterChange: Effect.void,
                requestInitial: Effect.void,
              },
            ).pipe(Effect.forkScoped);
            yield* TestClock.adjust('5 minutes');
            yield* Effect.yieldNow;

            expect(yield* Ref.get(maintenanceRequests)).toBe(1);
            expect(yield* Ref.get(refreshes)).toBe(testCase.expectedRefreshes);
            yield* Fiber.interrupt(fiber);
          }),
        );
      }
    }),
  );

  effectIt.effect('classifies unchanged and changed watcher evidence without full refresh work', () =>
    Effect.sync(() => {
      const cleanSnapshot = {commit: 'a', dirty: false};
      expect(codeGraphWatcherSnapshotStale(cleanSnapshot, {headCommit: 'a'}, {dirty: false})).toBe(false);
      expect(codeGraphWatcherSnapshotStale(cleanSnapshot, {headCommit: 'b'}, {dirty: false})).toBe(true);
      expect(
        codeGraphWatcherSnapshotStale(
          {commit: 'a', dirty: true, overlayFingerprint: 'old'},
          {headCommit: 'a'},
          {dirty: true, fingerprint: 'new'},
        ),
      ).toBe(true);
    }),
  );

  effectIt.effect('reuses a current scoped ready snapshot before spawning a background refresh worker', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-watcher-refresh-reuse-'});
        const identity: RepositoryIdentity = {
          caseMode: 'sensitive',
          checkoutId: 'a'.repeat(64),
          displayName: 'fixture/repository',
          gitCommonDirectory: '/fixture/repository/.git',
          headCommit: 'b'.repeat(40),
          objectFormat: 'sha1',
          repoRoot: '/fixture/repository',
          repositoryId: 'c'.repeat(64),
          worktreeId: 'd'.repeat(64),
        };
        const scopeEvidence = {
          catalogFingerprint: 'g'.repeat(64),
          closureDigest: 'e'.repeat(64),
          definitionDigest: 'f'.repeat(64),
          extractorSet: extractorSetIdentity([], BUILTIN_LANGUAGE_PACK_REGISTRY),
          inventoryFingerprint: '1'.repeat(64),
          observedCommit: identity.headCommit,
          policyFingerprint: '2'.repeat(64),
          repositoryId: identity.repositoryId,
          scopeKey: `code-graph-scope:${'3'.repeat(64)}`,
          worktreeId: identity.worktreeId,
        } as const;
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId, scopeEvidence.scopeKey);
        const ready = {
          commit: identity.headCommit,
          dirty: false,
          edgeCount: 13,
          extractorSet: scopeEvidence.extractorSet,
          fileCount: 5,
          id: `cgsn_${'4'.repeat(40)}`,
          repositoryId: identity.repositoryId,
          scopeId: scopeEvidence.scopeKey,
          state: 'ready' as const,
          symbolCount: 8,
          worktreeId: identity.worktreeId,
        };
        yield* recordCodeGraphSnapshotAdmission(
          layout,
          ready,
          scopeEvidence.policyFingerprint,
          BUILTIN_LANGUAGE_PACK_REGISTRY,
          false,
          {scope: codeGraphScopeAdmissionEvidence(scopeEvidence)},
        );
        const summary = yield* currentBackgroundRefreshSummary(
          {
            admissionFingerprint: scopeEvidence.policyFingerprint,
            demandIdentity: {
              checkoutId: identity.checkoutId,
              scopeId: scopeEvidence.scopeKey,
              threadnoteHome: home,
              worktreeId: identity.worktreeId,
            },
            identity,
            layout,
            overlay: {dirty: false},
            requestKey: 'request-b',
            scopeEvidence,
            scopeId: scopeEvidence.scopeKey,
          },
          {
            readySnapshot: () => Effect.succeed(ready),
            snapshotPackProvenance: () => Effect.succeed([]),
          } as never,
          BUILTIN_LANGUAGE_PACK_REGISTRY,
        );
        expect(summary).toEqual({edges: ready.edgeCount, symbols: ready.symbolCount});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('serializes explicit and watch-triggered refreshes while coalescing a trailing run', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Ref.make(0);
        const concurrent = yield* Ref.make(0);
        const maximumConcurrent = yield* Ref.make(0);
        const watchStarted = yield* Deferred.make<void>();
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const secondRelease = yield* Deferred.make<void>();
        const secondCompleted = yield* Deferred.make<void>();
        let trigger: (() => Effect.Effect<void>) | undefined;
        const watcher = yield* makeCodeGraphWatcher(
          (_options, _initialRefresh, requestRefresh) =>
            Effect.sync(() => {
              trigger = requestRefresh;
            }).pipe(Effect.andThen(Deferred.succeed(watchStarted, undefined)), Effect.andThen(Effect.never)),
          refreshOptions =>
            Effect.gen(function* () {
              const ordinal = yield* Ref.updateAndGet(starts, count => count + 1);
              const active = yield* Ref.updateAndGet(concurrent, count => count + 1);
              yield* Ref.update(maximumConcurrent, current => Math.max(current, active));
              yield* refreshOptions.onProgress?.({
                accepted: ordinal,
                completed: ordinal,
                excluded: 0,
                phase: 'scanning',
                skipped: 0,
                total: 2,
                unit: 'files',
              }) ?? Effect.void;
              yield* Deferred.succeed(ordinal === 1 ? firstStarted : secondStarted, undefined);
              yield* Deferred.await(ordinal === 1 ? firstRelease : secondRelease);
              yield* refreshOptions.onRefreshed?.(ordinal * 100, ordinal * 200) ?? Effect.void;
              if (ordinal === 2) yield* Deferred.succeed(secondCompleted, undefined);
            }).pipe(Effect.ensuring(Ref.update(concurrent, count => count - 1))),
        );

        yield* watcher.ensure(options);
        yield* Deferred.await(watchStarted);
        yield* watcher.refresh(options);
        yield* Deferred.await(firstStarted);
        yield* Effect.all(
          [...Array.from({length: 50}, () => trigger!()), ...Array.from({length: 50}, () => watcher.refresh(options))],
          {concurrency: 'unbounded'},
        );
        const beforeRelease = {
          maximum: yield* Ref.get(maximumConcurrent),
          starts: yield* Ref.get(starts),
        };
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Deferred.await(secondStarted);
        const duringTrailing = {
          maximum: yield* Ref.get(maximumConcurrent),
          starts: yield* Ref.get(starts),
        };
        yield* Effect.all(
          Array.from({length: 50}, () => watcher.refresh(options)),
          {
            concurrency: 'unbounded',
          },
        );
        yield* Deferred.succeed(secondRelease, undefined);
        yield* Deferred.await(secondCompleted);
        yield* Effect.yieldNow;
        return {
          beforeRelease,
          duringTrailing,
          finalMaximum: yield* Ref.get(maximumConcurrent),
          finalStarts: yield* Ref.get(starts),
          status: yield* watcher.status(options.key),
        };
      }),
    ).pipe(
      Effect.tap(result =>
        Effect.sync(() => {
          expect(result.beforeRelease).toEqual({maximum: 1, starts: 1});
          expect(result.duringTrailing).toEqual({maximum: 1, starts: 2});
          expect(result.finalMaximum).toBe(1);
          expect(result.finalStarts).toBe(2);
          expect(result.status).toMatchObject({
            _tag: 'Some',
            value: {edges: 400, state: 'ready', symbols: 200},
          });
        }),
      ),
    ),
  );

  effectIt.effect('atomically collapses intermediate changes and resolves the latest target in the trailing run', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const targets: string[] = [];
        let currentTarget = 'commit-a';
        let trigger: (() => Effect.Effect<void>) | undefined;
        const firstStarted = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const secondCompleted = yield* Deferred.make<void>();
        const watcher = yield* makeCodeGraphWatcher(
          (_options, _initialRefresh, requestRefresh) =>
            Effect.sync(() => {
              trigger = requestRefresh;
            }).pipe(Effect.andThen(Effect.never)),
          () =>
            Effect.gen(function* () {
              targets.push(currentTarget);
              if (targets.length === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(firstRelease);
              } else {
                yield* Deferred.succeed(secondCompleted, undefined);
              }
            }),
        );

        yield* watcher.ensure(options);
        while (trigger === undefined) yield* Effect.yieldNow;
        yield* watcher.refresh(options);
        yield* Deferred.await(firstStarted);
        currentTarget = 'commit-b';
        yield* trigger();
        currentTarget = 'commit-c';
        yield* Effect.all(
          Array.from({length: 64}, () => trigger!()),
          {
            concurrency: 'unbounded',
            discard: true,
          },
        );
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Deferred.await(secondCompleted);
        return targets;
      }),
    ).pipe(Effect.tap(observed => Effect.sync(() => expect(observed).toEqual(['commit-a', 'commit-c'])))),
  );

  effectIt.effect('admits two refreshes across repository keys while bounding process memory', () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const starts = yield* Ref.make(0);
          const concurrent = yield* Ref.make(0);
          const maximumConcurrent = yield* Ref.make(0);
          const firstStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          const repositoryCount = 8;
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            () =>
              Effect.gen(function* () {
                const ordinal = yield* Ref.updateAndGet(starts, count => count + 1);
                const active = yield* Ref.updateAndGet(concurrent, count => count + 1);
                yield* Ref.update(maximumConcurrent, current => Math.max(current, active));
                if (ordinal === 1) yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(release);
                if (ordinal === repositoryCount) yield* Deferred.succeed(completed, undefined);
              }).pipe(Effect.ensuring(Ref.update(concurrent, count => count - 1))),
          );

          yield* Effect.all(
            Array.from({length: repositoryCount}, (_, index) =>
              watcher.refresh({...options, key: `repository:worktree:${index}`}),
            ),
            {concurrency: 'unbounded'},
          );
          yield* Deferred.await(firstStarted);
          yield* Effect.yieldNow;
          const beforeRelease = {
            maximum: yield* Ref.get(maximumConcurrent),
            starts: yield* Ref.get(starts),
          };
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(completed);
          return {
            beforeRelease,
            finalMaximum: yield* Ref.get(maximumConcurrent),
            finalStarts: yield* Ref.get(starts),
          };
        }),
      );

      expect(result.beforeRelease).toEqual({maximum: 2, starts: 2});
      expect(result.finalMaximum).toBe(2);
      expect(result.finalStarts).toBe(8);
    }),
  );

  effectIt.effect('reports exact path-free queue and execution metrics under coalescing load', () =>
    Effect.gen(function* () {
      const watchTriggers = new Map<string, () => Effect.Effect<void>>();
      const watchesStarted = yield* Ref.make(0);
      const allWatchesStarted = yield* Deferred.make<void>();
      const refreshStarts = yield* Ref.make(0);
      const refreshCompletions = yield* Ref.make(0);
      const firstRefreshStarted = yield* Deferred.make<void>();
      const allRefreshesCompleted = yield* Deferred.make<void>();
      const releaseRefreshes = yield* Deferred.make<void>();
      const firstOptions = {...options, key: 'repository:worktree:first'};
      const secondOptions = {...options, key: 'repository:worktree:second'};
      const watcher = yield* makeCodeGraphWatcher(
        (watchOptions, _initialRefresh, requestRefresh) =>
          Effect.gen(function* () {
            watchTriggers.set(watchOptions.key, requestRefresh);
            const started = yield* Ref.updateAndGet(watchesStarted, count => count + 1);
            if (started === 2) yield* Deferred.succeed(allWatchesStarted, undefined);
            return yield* Effect.never;
          }),
        refreshOptions =>
          Effect.gen(function* () {
            const started = yield* Ref.updateAndGet(refreshStarts, count => count + 1);
            if (started === 1) yield* Deferred.succeed(firstRefreshStarted, undefined);
            yield* Deferred.await(releaseRefreshes);
            yield* refreshOptions.onRefreshed?.(started * 100, started * 200) ?? Effect.void;
            const completed = yield* Ref.updateAndGet(refreshCompletions, count => count + 1);
            if (completed === 4) yield* Deferred.succeed(allRefreshesCompleted, undefined);
          }),
        {maximumWatchers: 4},
      );

      expect(yield* watcher.metrics).toEqual({
        activeRefreshKeys: 0,
        activeWatches: 0,
        executingRefreshes: 0,
        executingRefreshHighWater: 0,
        idleSweepFibers: 0,
        maximumWatchers: 4,
        pendingTrailingRefreshes: 0,
        retainedStatuses: 0,
      });

      yield* watcher.ensure(firstOptions);
      yield* watcher.ensure(secondOptions);
      yield* Deferred.await(allWatchesStarted);
      expect(yield* watcher.metrics).toEqual({
        activeRefreshKeys: 0,
        activeWatches: 2,
        executingRefreshes: 0,
        executingRefreshHighWater: 0,
        idleSweepFibers: 1,
        maximumWatchers: 4,
        pendingTrailingRefreshes: 0,
        retainedStatuses: 0,
      });

      yield* watcher.refresh(firstOptions);
      yield* Deferred.await(firstRefreshStarted);
      yield* watcher.refresh(secondOptions);
      yield* Effect.all(
        Array.from({length: 256}, (_, index) => {
          const selected = index % 2 === 0 ? firstOptions : secondOptions;
          return index % 4 < 2 ? watchTriggers.get(selected.key)!() : watcher.refresh(selected).pipe(Effect.asVoid);
        }),
        {concurrency: 'unbounded', discard: true},
      );

      let whileHeld = yield* watcher.metrics;
      for (let attempt = 0; attempt < 16 && whileHeld.retainedStatuses < 2; attempt += 1) {
        yield* Effect.yieldNow;
        whileHeld = yield* watcher.metrics;
      }
      expect(whileHeld).toEqual({
        activeRefreshKeys: 2,
        activeWatches: 2,
        executingRefreshes: 2,
        executingRefreshHighWater: 2,
        idleSweepFibers: 1,
        maximumWatchers: 4,
        pendingTrailingRefreshes: 2,
        retainedStatuses: 2,
      });
      expect(JSON.stringify(whileHeld)).not.toContain('/fixture');
      expect(JSON.stringify(whileHeld)).not.toContain('repository:worktree');

      yield* Deferred.succeed(releaseRefreshes, undefined);
      yield* Deferred.await(allRefreshesCompleted);
      let drained = yield* watcher.metrics;
      for (let attempt = 0; attempt < 16 && drained.activeRefreshKeys > 0; attempt += 1) {
        yield* Effect.yieldNow;
        drained = yield* watcher.metrics;
      }
      expect(yield* Ref.get(refreshStarts)).toBe(4);
      expect(drained).toEqual({
        activeRefreshKeys: 0,
        activeWatches: 2,
        executingRefreshes: 0,
        executingRefreshHighWater: 2,
        idleSweepFibers: 1,
        maximumWatchers: 4,
        pendingTrailingRefreshes: 0,
        retainedStatuses: 2,
      });
    }).pipe(Effect.scoped),
  );

  effectIt.effect('balances execution metrics across refresh failure and scope interruption', () =>
    Effect.gen(function* () {
      const failedWatcher = yield* makeCodeGraphWatcher(
        () => Effect.never,
        () => Effect.fail(TestError.make({message: 'expected refresh failure'})),
      );
      yield* failedWatcher.refresh({...options, key: 'failure'});
      let afterFailure = yield* failedWatcher.metrics;
      for (let attempt = 0; attempt < 16 && afterFailure.activeRefreshKeys > 0; attempt += 1) {
        yield* Effect.yieldNow;
        afterFailure = yield* failedWatcher.metrics;
      }
      expect(afterFailure.executingRefreshes).toBe(0);
      expect(afterFailure.executingRefreshHighWater).toBe(1);
      expect(afterFailure.executingRefreshes).toBeGreaterThanOrEqual(0);

      const interruptedWatcher = yield* Effect.scoped(
        Effect.gen(function* () {
          const executingStarted = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            refreshOptions =>
              Deferred.succeed(executingStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.andThen(refreshOptions.onRefreshed?.(1, 2) ?? Effect.void),
              ),
          );
          yield* watcher.refresh({...options, key: 'executing'});
          yield* Deferred.await(executingStarted);
          yield* watcher.refresh({...options, key: 'waiting'});
          let whileExecuting = yield* watcher.metrics;
          for (let attempt = 0; attempt < 16 && whileExecuting.activeRefreshKeys < 2; attempt += 1) {
            yield* Effect.yieldNow;
            whileExecuting = yield* watcher.metrics;
          }
          expect(whileExecuting.executingRefreshes).toBe(1);
          expect(whileExecuting.executingRefreshHighWater).toBe(1);
          expect(whileExecuting.executingRefreshes).toBeGreaterThanOrEqual(0);
          return watcher;
        }),
      );
      const afterInterruption = yield* interruptedWatcher.metrics;
      expect(afterInterruption.executingRefreshes).toBe(0);
      expect(afterInterruption.executingRefreshHighWater).toBe(1);
      expect(afterInterruption.executingRefreshes).toBeGreaterThanOrEqual(0);
    }).pipe(Effect.scoped),
  );

  effectIt.effect('estimates measured phase work and identifies newly started refreshes', () =>
    Effect.gen(function* () {
      const captured = yield* Deferred.make<CodeGraphWatchOptions>();
      const release = yield* Deferred.make<void>();
      const watcher = yield* makeCodeGraphWatcher(
        () => Effect.never,
        refreshOptions =>
          Deferred.succeed(captured, refreshOptions).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(refreshOptions.onRefreshed?.(10, 20) ?? Effect.void),
          ),
      );

      const firstStarted = yield* watcher.refresh(options);
      const secondStarted = yield* watcher.refresh(options);
      const progress = yield* Deferred.await(captured);
      const scanning = (completed: number) =>
        progress.onProgress?.({
          accepted: completed,
          completed,
          excluded: 20,
          phase: 'scanning',
          skipped: 0,
          total: 100,
          unit: 'files',
        }) ?? Effect.void;

      yield* scanning(0);
      yield* TestClock.adjust(1_000);
      yield* scanning(10);
      const insufficient = yield* watcher.status(options.key);
      for (let completed = 20; completed <= 80; completed += 10) {
        yield* TestClock.adjust(1_000);
        yield* scanning(completed);
      }
      const estimated = yield* watcher.status(options.key);
      yield* TestClock.adjust(500);
      const aged = yield* watcher.status(options.key);
      yield* TestClock.adjust(2_500);
      const expired = yield* watcher.status(options.key);
      yield* progress.onProgress?.({
        completed: 0,
        phase: 'materializing',
        reused: 80,
        total: 100,
        unit: 'files',
      }) ?? Effect.void;
      const reset = yield* watcher.status(options.key);
      yield* Deferred.succeed(release, undefined);

      expect(firstStarted).toBe(true);
      expect(secondStarted).toBe(false);
      expect(insufficient).toMatchObject({
        _tag: 'Some',
        value: {state: 'indexing'},
      });
      if (insufficient._tag === 'Some' && insufficient.value.state === 'indexing') {
        expect(insufficient.value.timing).not.toHaveProperty('estimatedPhaseRemainingMilliseconds');
      }
      expect(estimated).toMatchObject({
        _tag: 'Some',
        value: {
          state: 'indexing',
          timing: {
            estimateConfidence: 'medium',
            estimatedPhaseRemainingMilliseconds: 2_000,
            estimateScope: 'phase',
          },
        },
      });
      expect(aged).toMatchObject({
        _tag: 'Some',
        value: {
          state: 'indexing',
          timing: {
            elapsedMilliseconds: 8_500,
            lastProgressAgeMilliseconds: 500,
            phaseElapsedMilliseconds: 8_500,
          },
        },
      });
      if (expired._tag === 'Some' && expired.value.state === 'indexing') {
        expect(expired.value.timing).not.toHaveProperty('estimatedPhaseRemainingMilliseconds');
      }
      expect(reset).toMatchObject({
        _tag: 'Some',
        value: {
          progress: {phase: 'materializing'},
          state: 'indexing',
          timing: {
            phaseElapsedMilliseconds: 0,
          },
        },
      });
      if (reset._tag === 'Some' && reset.value.state === 'indexing') {
        expect(reset.value.timing).not.toHaveProperty('estimatedPhaseRemainingMilliseconds');
      }
    }).pipe(Effect.scoped),
  );

  effectIt.effect('caps retained session watchers and evicts the least recently used registrations', () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const stops = yield* Ref.make(0);
      const inside = yield* Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* makeCodeGraphWatcher(
            () =>
              Effect.acquireRelease(
                Ref.update(starts, count => count + 1),
                () => Ref.update(stops, count => count + 1),
              ).pipe(Effect.andThen(Effect.never), Effect.scoped),
            () => Effect.void,
            {maximumWatchers: 4},
          );
          for (let index = 0; index < 20; index += 1) {
            yield* watcher.ensure({...options, key: `repository:worktree:${index}`});
            yield* Effect.yieldNow;
          }
          return {
            running: (yield* Ref.get(starts)) - (yield* Ref.get(stops)),
            starts: yield* Ref.get(starts),
            stops: yield* Ref.get(stops),
          };
        }),
      );
      const counts = {
        inside,
        starts: yield* Ref.get(starts),
        stops: yield* Ref.get(stops),
      };

      expect(counts.inside).toEqual({running: 4, starts: 20, stops: 16});
      expect(counts).toMatchObject({starts: 20, stops: 20});
    }),
  );

  effectIt.effect('does not schedule the idle sweep before a session watcher exists', () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const watcher = yield* makeCodeGraphWatcher(
        () => Ref.update(starts, count => count + 1).pipe(Effect.andThen(Effect.never)),
        () => Effect.void,
      );

      // Runtime consumers can set a deterministic wall-clock timestamp before
      // ever using code graph watch. An eager recurring sweep would force the
      // TestClock to replay every minute since the epoch.
      yield* TestClock.setTime(2_000_000_000_000);
      yield* watcher.ensure(options);
      yield* Effect.yieldNow;

      expect(yield* Ref.get(starts)).toBe(1);
    }).pipe(Effect.scoped),
  );

  effectIt.effect('evicts idle watchers and restarts them on later use', () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const stops = yield* Ref.make(0);
      const watcher = yield* makeCodeGraphWatcher(
        () =>
          Effect.acquireRelease(
            Ref.update(starts, count => count + 1),
            () => Ref.update(stops, count => count + 1),
          ).pipe(Effect.andThen(Effect.never), Effect.scoped),
        () => Effect.void,
        {
          idleTimeoutMilliseconds: 1_000,
          maximumWatchers: 4,
          sweepIntervalMilliseconds: 100,
        },
      );

      yield* watcher.ensure(options);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(900);
      yield* watcher.status(options.key);
      yield* TestClock.adjust(900);
      expect(yield* Ref.get(stops)).toBe(0);
      yield* TestClock.adjust(200);
      expect(yield* Ref.get(stops)).toBe(1);
      yield* watcher.ensure(options);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(starts)).toBe(2);
    }).pipe(Effect.scoped),
  );
});
