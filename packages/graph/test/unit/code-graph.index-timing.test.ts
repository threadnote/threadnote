import {Array as EffectArray} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect, it} from '@effect/vitest';
import {Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import type {CodeGraphStoreShape} from '@threadnote/graph/store';
import {
  codeGraphIndexTimingStore,
  withCodeGraphIndexTiming,
  type CodeGraphIndexTimingObserver,
} from '../../src/indexer/types.js';
import {pagedAnalysisStore} from '../helpers/code-graph-analysis.js';

class TimingSession extends Context.Service<TimingSession, string>()(
  '@threadnote/graph/test/unit/code-graph.index-timing.test/TimingSession',
) {}

describe('code graph optional index timing', () => {
  it('returns the original effect and store when observation is disabled', () => {
    const effect = Effect.succeed('unchanged');
    const store = pagedAnalysisStore([], []);
    expect(withCodeGraphIndexTiming(undefined, 'admission', effect)).toBe(effect);
    expect(codeGraphIndexTimingStore(store, undefined)).toBe(store);
  });

  it.effect('preserves success and typed failure when observers fail or defect', () =>
    Effect.gen(function* () {
      const observerFailure = TestError.make({message: 'observer failure'});
      const programFailure = TestError.make({message: 'program failure'});
      const observers: CodeGraphIndexTimingObserver[] = [
        () => Effect.fail(observerFailure),
        () => Effect.die(observerFailure),
        () => Effect.succeed(Effect.fail(observerFailure)),
        () => Effect.succeed(Effect.die(observerFailure)),
        () => {
          throw observerFailure;
        },
      ];
      for (const observer of observers) {
        expect(yield* withCodeGraphIndexTiming(observer, 'admission', Effect.succeed('value'))).toBe('value');
        const result = yield* withCodeGraphIndexTiming(observer, 'admission', Effect.fail(programFailure)).pipe(
          Effect.exit,
        );
        expect(result).toEqual(yield* Effect.fail(programFailure).pipe(Effect.exit));
      }
    }),
  );

  it.effect('preserves interruption and operation cleanup when completion observation defects', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let cleaned = false;
      const fiber = yield* withCodeGraphIndexTiming(
        () => Effect.succeed(Effect.die('observer defect')),
        'index-scope',
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              cleaned = true;
            }),
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(cleaned).toBe(true);
    }),
  );

  it.effect('observes both early and scoped lease release without changing session context or ownership', () =>
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(SqliteClient.layer({filename: ':memory:'}));
      const sql = Context.get(databaseContext, SqlClient.SqlClient);
      const events: string[] = [];
      const observed: string[] = [];
      const options = {readOnly: false};
      const base = {
        ...pagedAnalysisStore([], []),
        releaseSnapshotLease: (_database, token) =>
          Effect.gen(function* () {
            const session = yield* Effect.serviceOption(TimingSession);
            events.push(`release:${token}:${Option.getOrElse(session, () => 'outside')}`);
          }),
        withSession: (_database, effect, suppliedOptions) => {
          expect(suppliedOptions).toBe(options);
          return Effect.acquireUseRelease(
            Effect.sync(() => events.push('open')),
            () =>
              effect.pipe(
                Effect.provideService(TimingSession, 'inside'),
                Effect.provideService(SqlClient.SqlClient, sql),
              ),
            () => Effect.sync(() => events.push('close')),
          );
        },
      } satisfies Pick<CodeGraphStoreShape, 'releaseSnapshotLease' | 'withSession'>;
      const store = codeGraphIndexTimingStore(base, stage =>
        Effect.sync(() => {
          observed.push(`start:${stage}`);
          return Effect.sync(() => {
            observed.push(`end:${stage}`);
          });
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const token = yield* Effect.acquireRelease(Effect.succeed('lease'), value =>
            store.releaseSnapshotLease('database', value).pipe(Effect.orDie),
          );
          yield* store.withSession('database', store.releaseSnapshotLease('database', token), options);
        }),
      );
      expect(events).toEqual(['open', 'release:lease:inside', 'close', 'release:lease:outside']);
      expect(EffectArray.filter(observed, event => event === 'start:snapshot-lease-release')).toHaveLength(2);
      expect(EffectArray.filter(observed, event => event === 'end:snapshot-lease-release')).toHaveLength(2);
      expect(observed.indexOf('end:database-session-body')).toBeLessThan(observed.indexOf('end:database-session'));
    }),
  );
});
