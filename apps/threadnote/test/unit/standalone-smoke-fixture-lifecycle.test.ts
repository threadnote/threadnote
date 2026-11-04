import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, Fiber, Schema} from 'effect';
import {expect} from 'vitest';
import {TestClock} from 'effect/testing';
import {fixtureCleanup, fixtureLifecycle, fixtureRemovalDeadline} from '../../../../scripts/fixture-lifecycle.js';

effectIt.effect('retains both body and cleanup causes including defects', () =>
  Effect.gen(function* () {
    const outcome = yield* Effect.exit(fixtureLifecycle(Effect.die('body-defect'), Effect.fail('cleanup-failed')));
    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isFailure(outcome)) {
      const message = Cause.pretty(outcome.cause);
      expect(message).toContain('body-defect');
      expect(message).toContain('cleanup-failed');
    }
  }),
);

effectIt.effect('only reports success after cleanup succeeds', () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const body = Effect.sync(() => {
      events.push('body');
    });
    const cleanup = Effect.sync(() => {
      events.push('cleanup');
    });
    const success = Effect.sync(() => {
      events.push('success');
    });
    yield* fixtureLifecycle(body, cleanup).pipe(Effect.andThen(success));
    expect(events).toEqual(['body', 'cleanup', 'success']);
    events.length = 0;
    yield* Effect.exit(fixtureLifecycle(body, Effect.fail('cleanup failed')).pipe(Effect.andThen(success)));
    expect(events).toEqual(['body']);
  }),
);

effectIt.effect.prop(
  'removes exactly once only after proven producer exit and successful drain',
  {producerProven: Schema.Boolean, drainProven: Schema.Boolean},
  ({producerProven, drainProven}) =>
    Effect.gen(function* () {
      const steps: string[] = [];
      const cleanup = fixtureCleanup({
        producers: Effect.sync(() => {
          steps.push('producer');
          return producerProven ? ('exited' as const) : ('unknown' as const);
        }),
        drain: Effect.sync(() => {
          steps.push('drain');
          return {state: drainProven ? ('drained' as const) : ('unknown' as const)};
        }),
        remove: Effect.sync(() => {
          steps.push('remove');
        }),
        remaining: Effect.succeed(1000),
      });
      const outcome = yield* Effect.exit(cleanup);
      expect(Exit.isSuccess(outcome)).toBe(producerProven && drainProven);
      expect(steps).toEqual(
        !producerProven ? ['producer'] : drainProven ? ['producer', 'drain', 'remove'] : ['producer', 'drain'],
      );
    }),
  {arbitrary: {runs: 40}},
);

effectIt.effect('does not remove when the deadline expires after draining', () =>
  Effect.gen(function* () {
    let remaining = 100;
    let removed = false;
    const outcome = yield* Effect.exit(
      fixtureCleanup({
        producers: Effect.succeed('exited'),
        drain: Effect.sync(() => {
          remaining = 0;
          return {state: 'drained' as const};
        }),
        remove: Effect.sync(() => {
          removed = true;
        }),
        remaining: Effect.sync(() => remaining),
      }),
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(removed).toBe(false);
  }),
);

effectIt.effect('late completion of removal reports partial and prevents success on either clock', () =>
  Effect.gen(function* () {
    for (const clock of ['epoch', 'monotonic'] as const) {
      let epoch = 100;
      let monotonic = 100;
      let removed = 0;
      let success = false;
      const remaining = Effect.sync(() => Math.min(epoch, monotonic));
      const cleanup = fixtureCleanup({
        producers: Effect.succeed('exited'),
        drain: Effect.succeed({state: 'drained' as const}),
        remaining,
        remove: Effect.sync(() => {
          removed++;
          if (clock === 'epoch') epoch = 0;
          else monotonic = 0;
        }),
      });
      const result = yield* Effect.exit(
        fixtureLifecycle(Effect.void, cleanup).pipe(
          Effect.andThen(
            Effect.sync(() => {
              success = true;
            }),
          ),
        ),
      );
      expect(removed).toBe(1);
      expect(success).toBe(false);
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : '').toContain('partial or complete');
    }
  }),
);

effectIt.effect('checks the original budget again immediately before the success continuation', () =>
  Effect.gen(function* () {
    let remaining = 100;
    let removed = 0;
    const budget = Effect.sync(() => remaining);
    yield* fixtureCleanup({
      producers: Effect.succeed('exited'),
      drain: Effect.succeed({state: 'drained' as const}),
      remove: Effect.sync(() => {
        removed++;
      }),
      remaining: budget,
    });
    remaining = 0;
    const result = yield* Effect.exit(fixtureRemovalDeadline(budget));
    expect(removed).toBe(1);
    expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : '').toContain('partial or complete');
  }),
);

effectIt.effect('removal timeout is partial after deletion starts', () =>
  Effect.gen(function* () {
    let started = false;
    const cleanup = fixtureCleanup({
      producers: Effect.succeed('exited'),
      drain: Effect.succeed({state: 'drained' as const}),
      remove: Effect.sync(() => {
        started = true;
      }).pipe(Effect.andThen(Effect.never)),
      remaining: Effect.succeed(10),
    });
    const fiber = yield* Effect.forkChild(Effect.exit(cleanup));
    yield* TestClock.adjust(11);
    const result = yield* Fiber.join(fiber);
    expect(started).toBe(true);
    expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : '').toContain('partial');
  }),
);

effectIt.effect('drain timeout retains fixture and does not remove it', () =>
  Effect.gen(function* () {
    let removed = false;
    const cleanup = fixtureCleanup({
      producers: Effect.succeed('exited'),
      drain: Effect.never,
      remove: Effect.sync(() => {
        removed = true;
      }),
      remaining: Effect.succeed(10),
    });
    const fiber = yield* Effect.forkChild(Effect.exit(cleanup));
    yield* TestClock.adjust(11);
    const result = yield* Fiber.join(fiber);
    expect(removed).toBe(false);
    expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : '').toContain('fixture retained');
  }),
);

effectIt.effect('reports failed removal as possibly partial while preserving its cause', () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      fixtureCleanup({
        producers: Effect.succeed('exited'),
        drain: Effect.succeed({state: 'drained' as const}),
        remove: Effect.fail('filesystem failure'),
        remaining: Effect.succeed(10),
      }),
    );
    const message = Exit.isFailure(result) ? Cause.pretty(result.cause) : '';
    expect(message).toContain('partial');
    expect(message).toContain('filesystem failure');
  }),
);
