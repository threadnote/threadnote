import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Deferred, Effect, Fiber} from 'effect';
import {describe, expect} from 'vitest';
import {
  makeCodeGraphRemovedViewCleanupWorker,
  type CodeGraphRemovedViewCleanupVectorPreparation,
  type CodeGraphRemovedViewCleanupWorkerDependencies,
  type CodeGraphRemovedViewCleanupWorkerInput,
} from '@threadnote/graph/removed_view/cleanup';
import type {
  CodeGraphRemovedViewCleanupAuthorizationResult,
  CodeGraphRemovedViewCleanupEntry,
  CodeGraphRemovedViewCleanupUpdate,
  CodeGraphRemovedViewCleanupUpdateResult,
} from '@threadnote/graph/store';
import {CodeGraphStoreBusyError} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const INPUT: CodeGraphRemovedViewCleanupWorkerInput = {
  checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
  databasePath: '/private/graph-v3.sqlite',
  threadnoteHome: '/private/threadnote',
};
const SNAPSHOT_ID = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
const WORKTREE_ID = Effect2.pipe('b', EffectString.repeat(64));
const REPOSITORY_ID = Effect2.pipe('c', EffectString.repeat(64));
const RECORD_DIGEST = Effect2.pipe('d', EffectString.repeat(64));
const RECORD_IDENTITY = Effect2.pipe('e', EffectString.repeat(64));

describe('removed view cleanup worker', () => {
  effectIt.effect('holds the vector receipt outside target authorization, commit, and the full-entry update', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const preparations: CodeGraphRemovedViewCleanupVectorPreparation[] = [];
      const updates: CodeGraphRemovedViewCleanupUpdate[] = [];
      const entry = cleanupEntry();
      const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
        dependencies({
          authorize: (_input, candidate) =>
            Effect.sync(() => {
              events.push('authorize');
              return {entry: candidate, state: 'authorized'} as const;
            }),
          claim: () =>
            Effect.sync(() => {
              events.push('claim');
              return [entry];
            }),
          withPreparedVectorUnit: (_input, _entry, preparation, use) =>
            Effect.sync(() => {
              preparations.push(preparation);
              events.push('plan');
            }).pipe(
              Effect.andThen(
                Effect.acquireUseRelease(
                  Effect.sync(() => events.push('receipt-enter')),
                  () =>
                    use(
                      Effect.acquireUseRelease(
                        Effect.sync(() => events.push('model-enter')),
                        () =>
                          Effect.sync(() => {
                            events.push('vector');
                            return {
                              cursorToken: `vp1:a:${Effect2.pipe('f', EffectString.repeat(64))}:model-000:1`,
                              state: 'progress',
                            } as const;
                          }),
                        () => Effect.sync(() => events.push('model-exit')),
                      ),
                    ),
                  () => Effect.sync(() => events.push('receipt-exit')),
                ),
              ),
            ),
          update: (_input, candidate, update) =>
            Effect.sync(() => {
              events.push('update');
              updates.push(update);
              return updated(candidate, update);
            }),
          withTargetLock: (_input, _worktreeId, effect) =>
            Effect.sync(() => events.push('lock-enter')).pipe(
              Effect.andThen(effect),
              Effect.ensuring(Effect.sync(() => events.push('lock-exit'))),
            ),
        }),
      );

      const result = yield* worker.tick(INPUT);

      expect(events).toEqual([
        'claim',
        'plan',
        'receipt-enter',
        'lock-enter',
        'authorize',
        'model-enter',
        'vector',
        'model-exit',
        'update',
        'lock-exit',
        'receipt-exit',
      ]);
      expect(preparations).toEqual([{deadlineMonotonicMilliseconds: 750, reservationMode: 'nonblocking-one-attempt'}]);
      expect(updates).toEqual([
        {
          attempts: entry.attempts,
          cursorToken: `vp1:a:${Effect2.pipe('f', EffectString.repeat(64))}:model-000:1`,
          nextAttemptAt: 501,
          phase: 'vector-pointers',
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(500)),
        },
      ]);
      expect(result).toEqual({
        advanced: 0,
        claimed: 1,
        deferred: 0,
        progressed: 1,
        remaining: true,
        stale: 0,
        state: 'worked',
      });
    }),
  );

  effectIt.effect('admits an immediate injected receipt and defers after a delayed plan exhausts the deadline', () =>
    Effect.gen(function* () {
      const immediateEvents: string[] = [];
      const immediatePreparations: CodeGraphRemovedViewCleanupVectorPreparation[] = [];
      let immediateMonotonic = 500;
      const immediateWorker = yield* makeCodeGraphRemovedViewCleanupWorker(
        dependencies({
          claim: () => Effect.succeed([cleanupEntry()]),
          monotonicMilliseconds: Effect.sync(() => immediateMonotonic),
          withPreparedVectorUnit: injectedPreparedVectorUnit({
            advanceMonotonic: milliseconds => {
              immediateMonotonic += milliseconds;
            },
            events: immediateEvents,
            monotonicMilliseconds: () => immediateMonotonic,
            observePreparation: preparation => immediatePreparations.push(preparation),
            planningMilliseconds: 1,
            receiptMilliseconds: 1,
          }),
          withTargetLock: (_input, _worktreeId, effect) =>
            Effect.sync(() => immediateEvents.push('lock-enter')).pipe(Effect.andThen(effect)),
        }),
      );

      const immediate = yield* immediateWorker.tick(INPUT);

      expect(immediatePreparations).toEqual([
        {deadlineMonotonicMilliseconds: 750, reservationMode: 'nonblocking-one-attempt'},
      ]);
      expect(immediateEvents).toEqual(['plan', 'receipt-enter', 'use', 'lock-enter', 'receipt-exit']);
      expect(immediate).toMatchObject({advanced: 1, claimed: 1, deferred: 0, state: 'worked'});

      const delayedEvents: string[] = [];
      const delayedPreparations: CodeGraphRemovedViewCleanupVectorPreparation[] = [];
      let delayedMonotonic = 500;
      const delayedWorker = yield* makeCodeGraphRemovedViewCleanupWorker(
        dependencies({
          claim: () => Effect.succeed([cleanupEntry()]),
          monotonicMilliseconds: Effect.sync(() => delayedMonotonic),
          withPreparedVectorUnit: injectedPreparedVectorUnit({
            advanceMonotonic: milliseconds => {
              delayedMonotonic += milliseconds;
            },
            events: delayedEvents,
            monotonicMilliseconds: () => delayedMonotonic,
            observePreparation: preparation => delayedPreparations.push(preparation),
            planningMilliseconds: 125,
            receiptMilliseconds: 126,
          }),
          update: () =>
            Effect.sync(() => {
              delayedEvents.push('update');
              return {state: 'stale'} as const;
            }),
          withTargetLock: (_input, _worktreeId, effect) =>
            Effect.sync(() => delayedEvents.push('lock-enter')).pipe(Effect.andThen(effect)),
        }),
      );

      const delayed = yield* delayedWorker.tick(INPUT);

      expect(delayedPreparations).toEqual([
        {deadlineMonotonicMilliseconds: 750, reservationMode: 'nonblocking-one-attempt'},
      ]);
      expect(delayedEvents).toEqual(['plan', 'receipt-enter', 'receipt-exit']);
      expect(delayed).toMatchObject({advanced: 0, claimed: 1, deferred: 1, state: 'worked'});
    }),
  );

  effectIt.effect('releases target and receipt finalizers when a vector commit is interrupted', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const commitEntered = yield* Deferred.make<void>();
      let updates = 0;
      const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
        dependencies({
          authorize: (_input, entry) =>
            Effect.sync(() => {
              events.push('authorize');
              return {entry, state: 'authorized'} as const;
            }),
          claim: () => Effect.succeed([cleanupEntry()]),
          withPreparedVectorUnit: (_input, _entry, _deadline, use) =>
            Effect.acquireUseRelease(
              Effect.sync(() => events.push('receipt-enter')),
              () =>
                use(
                  Effect.sync(() => events.push('commit-enter')).pipe(
                    Effect.andThen(Deferred.succeed(commitEntered, undefined)),
                    Effect.andThen(Effect.never),
                  ),
                ),
              () => Effect.sync(() => events.push('receipt-exit')),
            ),
          update: () =>
            Effect.sync(() => {
              updates += 1;
              return {state: 'stale'} as const;
            }),
          withTargetLock: (_input, _worktreeId, effect) =>
            Effect.sync(() => events.push('lock-enter')).pipe(
              Effect.andThen(effect),
              Effect.ensuring(Effect.sync(() => events.push('lock-exit'))),
            ),
        }),
      );

      const running = yield* worker.tick(INPUT).pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(commitEntered);
      yield* Fiber.interrupt(running);

      expect(events).toEqual(['receipt-enter', 'lock-enter', 'authorize', 'commit-enter', 'lock-exit', 'receipt-exit']);
      expect(updates).toBe(0);
    }),
  );

  effectIt.effect(
    'advances build status and bound provenance exactly one phase while preserving unbound evidence',
    () =>
      Effect.gen(function* () {
        const updates: CodeGraphRemovedViewCleanupUpdate[] = [];
        let provenanceCalls = 0;
        const queue = [cleanupEntry({phase: 'build-status'}), cleanupEntry({bound: true, phase: 'provenance'})];
        const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
          dependencies({
            claim: () => Effect.succeed(queue.splice(0, 1)),
            cleanupBuildStatusUnit: () => Effect.succeed({state: 'complete'}),
            cleanupProvenanceUnit: () =>
              Effect.sync(() => {
                provenanceCalls += 1;
                return {state: 'complete'} as const;
              }),
            update: (_input, candidate, update) =>
              Effect.sync(() => {
                updates.push(update);
                return updated(candidate, update);
              }),
          }),
        );

        yield* worker.tick(INPUT);
        yield* worker.tick(INPUT);

        expect(EffectArray.map(updates, update => update.phase)).toEqual(['provenance', 'complete']);
        expect(EffectArray.every(updates, update => update.attempts === 0 && update.cursorToken === undefined)).toBe(
          true,
        );
        expect(provenanceCalls).toBe(1);

        const unboundUpdates: CodeGraphRemovedViewCleanupUpdate[] = [];
        const unboundWorker = yield* makeCodeGraphRemovedViewCleanupWorker(
          dependencies({
            claim: () => Effect.succeed([cleanupEntry({phase: 'provenance'})]),
            cleanupProvenanceUnit: () =>
              Effect.sync(() => {
                provenanceCalls += 1;
                return {state: 'complete'} as const;
              }),
            update: (_input, candidate, update) =>
              Effect.sync(() => {
                unboundUpdates.push(update);
                return updated(candidate, update);
              }),
          }),
        );

        yield* unboundWorker.tick(INPUT);
        expect(provenanceCalls).toBe(1);
        expect(unboundUpdates).toEqual([
          {
            attempts: 0,
            nextAttemptAt: 501,
            phase: 'complete',
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(500)),
          },
        ]);
      }),
  );

  effectIt.effect('rejects malformed stored and returned phase cursors before progress is persisted', () =>
    Effect.gen(function* () {
      const malformed = {
        'build-status': 'bs1:x:not-a-sealed-build-cursor',
        'vector-pointers': `vp1:a:${Effect2.pipe('f', EffectString.repeat(64))}:model-000:01`,
      } as const;

      for (const phase of ['vector-pointers', 'build-status'] as const) {
        for (const source of ['stored', 'returned'] as const) {
          let phaseCalls = 0;
          const updates: CodeGraphRemovedViewCleanupUpdate[] = [];
          const entry = cleanupEntry({
            ...(source === 'stored' ? {cursorToken: malformed[phase]} : {}),
            phase,
          });
          const page =
            source === 'returned'
              ? ({cursorToken: malformed[phase], state: 'progress'} as const)
              : ({state: 'complete'} as const);
          const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
            dependencies({
              claim: () => Effect.succeed([entry]),
              cleanupBuildStatusUnit: () =>
                Effect.sync(() => {
                  phaseCalls += 1;
                  return page;
                }),
              update: (_input, candidate, update) =>
                Effect.sync(() => {
                  updates.push(update);
                  return updated(candidate, update);
                }),
              withPreparedVectorUnit: (_input, _entry, _deadline, use) =>
                use(
                  Effect.sync(() => {
                    phaseCalls += 1;
                    return page;
                  }),
                ),
            }),
          );

          const result = yield* worker.tick(INPUT);

          expect(phaseCalls, `${phase}/${source}`).toBe(source === 'stored' ? 0 : 1);
          expect(result, `${phase}/${source}`).toMatchObject({claimed: 1, deferred: 1, progressed: 0});
          expect(updates, `${phase}/${source}`).toHaveLength(1);
          expect(updates[0], `${phase}/${source}`).toMatchObject({
            attempts: 1,
            blockedCode: 'invalid-sidecar',
            nextAttemptAt: 30_500,
            phase,
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(500)),
          });
          expect(updates[0].cursorToken, `${phase}/${source}`).toBe(source === 'stored' ? malformed[phase] : undefined);
        }
      }
    }),
  );

  effectIt.effect('defers with a monotone lease-safe retry while tolerating wall-clock rollback', () =>
    Effect.gen(function* () {
      const updates: CodeGraphRemovedViewCleanupUpdate[] = [];
      const entry = cleanupEntry({
        attempts: 2,
        cursorToken: `vp1:a:${Effect2.pipe('a', EffectString.repeat(64))}:model-000:7`,
        nextAttemptAt: 30_500,
        updatedAt: DateTime.formatIso(DateTime.makeUnsafe(1_000)),
      });
      const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
        dependencies({
          claim: () => Effect.succeed([entry]),
          withPreparedVectorUnit: (_input, _entry, _deadline, use) =>
            use(Effect.succeed({blockedCode: 'busy', retryAfterMilliseconds: 250, state: 'deferred'})),
          nowMilliseconds: Effect.succeed(500),
          update: (_input, candidate, update) =>
            Effect.sync(() => {
              updates.push(update);
              return updated(candidate, update);
            }),
        }),
      );

      yield* worker.tick(INPUT);

      expect(updates).toEqual([
        {
          attempts: 3,
          blockedCode: 'busy',
          cursorToken: entry.cursorToken,
          nextAttemptAt: 30_501,
          phase: 'vector-pointers',
          updatedAt: entry.updatedAt,
        },
      ]);
    }),
  );

  effectIt.effect('does not call phase adapters or update after stale and active-pointer-changed authorization', () =>
    Effect.gen(function* () {
      let phaseCalls = 0;
      let updates = 0;
      const entries = [cleanupEntry(), cleanupEntry({revision: 2})];
      const authorizations: CodeGraphRemovedViewCleanupAuthorizationResult[] = [
        {state: 'stale'},
        {observedSnapshotId: `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`, state: 'active-pointer-changed'},
      ];
      const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
        dependencies({
          authorize: () => Effect.succeed(authorizations.shift()!),
          claim: () => Effect.succeed(entries.splice(0, 1)),
          withPreparedVectorUnit: (_input, _entry, _deadline, use) =>
            use(
              Effect.sync(() => {
                phaseCalls += 1;
                return {state: 'complete'} as const;
              }),
            ),
          update: () =>
            Effect.sync(() => {
              updates += 1;
              return {state: 'stale'} as const;
            }),
        }),
      );

      const first = yield* worker.tick(INPUT);
      const second = yield* worker.tick(INPUT);

      expect(phaseCalls).toBe(0);
      expect(updates).toBe(0);
      expect(first.stale).toBe(1);
      expect(second.deferred).toBe(1);
    }),
  );

  effectIt.effect('isolates a busy peer and never claims more than the eight-unit burst budget', () =>
    Effect.gen(function* () {
      const entries = Array.from({length: 10}, (_, index) =>
        cleanupEntry({
          revision: index + 1,
          worktreeId: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
        }),
      );
      let claims = 0;
      const processed: string[] = [];
      const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
        dependencies({
          claim: () =>
            Effect.sync(() => {
              claims += 1;
              return entries.splice(0, 1);
            }),
          withPreparedVectorUnit: (_input, entry, _deadline, use) =>
            use(
              Effect.sync(() => {
                processed.push(entry.worktreeId);
                return {
                  cursorToken: `vp1:a:${entry.worktreeId}:model-000:${entry.revision}`,
                  state: 'progress',
                } as const;
              }),
            ),
          withTargetLock: (_input, worktreeId, effect) =>
            Effect2.pipe(worktreeId, EffectString.endsWith('0'))
              ? Effect.fail(CodeGraphStoreBusyError.of('busy'))
              : effect,
        }),
      );

      const result = yield* worker.burst(INPUT);

      expect(claims).toBe(8);
      expect(processed).toHaveLength(7);
      expect(result).toMatchObject({claimed: 8, deferred: 1, progressed: 7, remaining: true, state: 'worked'});
      expect(entries).toHaveLength(2);
    }),
  );

  effectIt.effect('moves a successful early key behind already-due peers between burst units', () =>
    Effect.gen(function* () {
      let monotonic = 0;
      let wall = 100;
      let queue: CodeGraphRemovedViewCleanupEntry[] = EffectArray.map(['0', '1', '2'], prefix =>
        cleanupEntry({worktreeId: Effect2.pipe(prefix, EffectString.repeat(64))}),
      );
      const order: string[] = [];
      const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
        dependencies({
          claim: (_input, now) =>
            Effect.sync(() => {
              const candidate = EffectArray.filter(queue, entry => entry.nextAttemptAt <= now).sort(
                (left, right) =>
                  left.nextAttemptAt - right.nextAttemptAt ||
                  Effect2.pipe(left.worktreeId, EffectString.localeCompare(right.worktreeId)),
              )[0];
              if (candidate === undefined) return [];
              const claimed = {
                ...candidate,
                nextAttemptAt: now + 30_000,
                revision: candidate.revision + 1,
                updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Math.max(now, Date.parse(candidate.updatedAt)))),
              };
              queue = EffectArray.map(queue, entry => (entry.worktreeId === claimed.worktreeId ? claimed : entry));
              return [claimed];
            }),
          withPreparedVectorUnit: (_input, entry, _deadline, use) =>
            use(
              Effect.sync(() => {
                order.push(entry.worktreeId[0]);
                return {
                  cursorToken: `vp1:a:${entry.worktreeId}:model-000:${entry.revision}`,
                  state: 'progress',
                } as const;
              }),
            ),
          monotonicMilliseconds: Effect.sync(() => monotonic),
          nowMilliseconds: Effect.sync(() => wall),
          sleep: milliseconds =>
            Effect.sync(() => {
              monotonic += milliseconds;
              wall += milliseconds;
            }),
          update: (_input, entry, update) =>
            Effect.sync(() => {
              const result = updated(entry, update);
              if (result.state === 'updated') {
                queue = EffectArray.map(queue, candidate =>
                  candidate.worktreeId === result.entry.worktreeId ? result.entry : candidate,
                );
              }
              return result;
            }),
        }),
      );

      const result = yield* worker.burst(INPUT);

      expect(order.slice(0, 6)).toEqual(['0', '1', '2', '0', '1', '2']);
      expect(result).toMatchObject({claimed: 8, progressed: 8, remaining: true, state: 'worked'});
      expect(monotonic).toBe(175);
    }),
  );

  effectIt.effect('bounds a burst by monotonic time while the queue wall clock rolls backward', () =>
    Effect.gen(function* () {
      let claims = 0;
      let monotonic = 0;
      let wall = 1_000;
      const sleeps: number[] = [];
      const worker = yield* makeCodeGraphRemovedViewCleanupWorker(
        dependencies({
          claim: () =>
            Effect.sync(() => [
              cleanupEntry({
                revision: ++claims,
                worktreeId: Effect2.pipe(claims.toString(16), EffectString.padStart(64, '0')),
              }),
            ]),
          withPreparedVectorUnit: (_input, entry, _deadline, use) =>
            use(
              Effect.sync(() => {
                monotonic += 110;
                wall -= 100;
                return {
                  cursorToken: `vp1:a:${entry.worktreeId}:model-000:${entry.revision}`,
                  state: 'progress',
                } as const;
              }),
            ),
          monotonicMilliseconds: Effect.sync(() => monotonic),
          nowMilliseconds: Effect.sync(() => wall),
          sleep: milliseconds =>
            Effect.sync(() => {
              sleeps.push(milliseconds);
              monotonic += milliseconds;
            }),
        }),
      );

      const result = yield* worker.burst(INPUT);

      expect(result).toMatchObject({claimed: 2, progressed: 2, remaining: true, state: 'worked'});
      expect(sleeps).toEqual([25, 5]);
      expect(monotonic).toBe(250);
      expect(wall).toBe(800);
    }),
  );
});

function injectedPreparedVectorUnit(options: {
  readonly advanceMonotonic: (milliseconds: number) => void;
  readonly events: string[];
  readonly monotonicMilliseconds: () => number;
  readonly observePreparation: (preparation: CodeGraphRemovedViewCleanupVectorPreparation) => void;
  readonly planningMilliseconds: number;
  readonly receiptMilliseconds: number;
}): CodeGraphRemovedViewCleanupWorkerDependencies['withPreparedVectorUnit'] {
  return <A, E>(
    _input: CodeGraphRemovedViewCleanupWorkerInput,
    _entry: CodeGraphRemovedViewCleanupEntry,
    preparation: CodeGraphRemovedViewCleanupVectorPreparation,
    use: (commit: Effect.Effect<ReturnType<typeof completeVectorPage>, unknown>) => Effect.Effect<A, E>,
  ): Effect.Effect<A, unknown> =>
    Effect.sync(() => {
      options.observePreparation(preparation);
      options.events.push('plan');
      options.advanceMonotonic(options.planningMilliseconds);
    }).pipe(
      Effect.andThen(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            options.events.push('receipt-enter');
            options.advanceMonotonic(options.receiptMilliseconds);
          }),
          () =>
            Effect.suspend((): Effect.Effect<A, unknown> => {
              if (options.monotonicMilliseconds() > preparation.deadlineMonotonicMilliseconds) {
                return Effect.fail(CodeGraphStoreBusyError.of('reservation deadline exhausted'));
              }
              options.events.push('use');
              return use(Effect.succeed(completeVectorPage())).pipe(Effect.mapError(error => error as unknown));
            }),
          () => Effect.sync(() => options.events.push('receipt-exit')),
        ),
      ),
    );
}

function completeVectorPage() {
  return {state: 'complete'} as const;
}

function cleanupEntry(
  overrides: Partial<CodeGraphRemovedViewCleanupEntry> & {readonly bound?: boolean} = {},
): CodeGraphRemovedViewCleanupEntry {
  const {bound = false, ...entryOverrides} = overrides;
  return {
    attempts: 0,
    epoch: 1,
    expectedSnapshotId: SNAPSHOT_ID,
    nextAttemptAt: 0,
    phase: 'vector-pointers',
    removedAt: new Date(0).toISOString(),
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    worktreeId: WORKTREE_ID,
    ...(bound
      ? {
          provenanceRecordDigest: RECORD_DIGEST,
          provenanceRecordIdentity: RECORD_IDENTITY,
          repositoryId: REPOSITORY_ID,
        }
      : {}),
    ...entryOverrides,
  };
}

function dependencies(
  overrides: Partial<CodeGraphRemovedViewCleanupWorkerDependencies> = {},
): CodeGraphRemovedViewCleanupWorkerDependencies {
  return {
    authorize: (_input, entry) => Effect.succeed({entry, state: 'authorized'}),
    claim: () => Effect.succeed([]),
    cleanupBuildStatusUnit: () => Effect.succeed({state: 'complete'}),
    cleanupProvenanceUnit: () => Effect.succeed({state: 'complete'}),
    withPreparedVectorUnit: (_input, _entry, _deadline, use) => use(Effect.succeed({state: 'complete'})),
    monotonicMilliseconds: Effect.succeed(500),
    nowMilliseconds: Effect.succeed(500),
    sleep: () => Effect.void,
    update: (_input, entry, update) => Effect.succeed(updated(entry, update)),
    withTargetLock: (_input, _worktreeId, effect) => effect,
    ...overrides,
  };
}

function updated(
  entry: CodeGraphRemovedViewCleanupEntry,
  update: CodeGraphRemovedViewCleanupUpdate,
): CodeGraphRemovedViewCleanupUpdateResult {
  return {entry: {...entry, ...update, revision: entry.revision + 1}, state: 'updated'};
}
