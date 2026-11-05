import {it as effectIt} from '@effect/vitest';
import {Effect, Fiber, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  makeReadDeadline,
  readDeadlineRemaining,
  ReadDeadlineExceeded,
  withinReadDeadline,
} from '../src/read_deadline.js';

describe('request read deadlines', () => {
  fcEffectProp(
    effectIt,
    'remaining time follows one elapsed deadline without resetting across passes',
    [
      fc.integer({min: 1, max: 5000}),
      fc.array(fc.integer({min: 0, max: 1500}), {minLength: 1, maxLength: 8}),
      fc.integer({min: 0, max: 1100}),
    ],
    ([budget, advances, reserve]) =>
      Effect.gen(function* () {
        const deadline = yield* makeReadDeadline(budget);
        let elapsed = 0;
        let previous = budget;
        for (const advance of advances) {
          yield* TestClock.adjust(advance);
          elapsed += advance;
          const remaining = yield* readDeadlineRemaining(deadline);
          expect(remaining).toBe(Math.max(0, budget - elapsed));
          expect(remaining).toBeLessThanOrEqual(previous);
          expect(yield* readDeadlineRemaining(deadline, reserve)).toBe(Math.max(0, budget - elapsed - reserve));
          previous = remaining;
        }
      }),
    {fastCheck: {numRuns: 24}},
  );

  effectIt.effect('does not admit another pass after expiration', () =>
    Effect.gen(function* () {
      const deadline = yield* makeReadDeadline(2000);
      yield* TestClock.adjust(2000);
      let admitted = false;
      const result = yield* withinReadDeadline(
        deadline,
        Effect.sync(() => {
          admitted = true;
        }),
      ).pipe(Effect.result);
      expect(admitted).toBe(false);
      expect(Result.isFailure(result) && Schema.is(ReadDeadlineExceeded)(result.failure)).toBe(true);
    }),
  );

  effectIt.effect('interrupts concurrent lanes at one deadline instead of summing their durations', () =>
    Effect.gen(function* () {
      const deadline = yield* makeReadDeadline(2000);
      const slow = yield* withinReadDeadline(deadline, Effect.sleep(3000)).pipe(Effect.result, Effect.forkScoped);
      const fast = yield* withinReadDeadline(deadline, Effect.sleep(1500).pipe(Effect.as('complete'))).pipe(
        Effect.forkScoped,
      );
      yield* TestClock.adjust(1500);
      expect(yield* Fiber.join(fast)).toBe('complete');
      expect(yield* readDeadlineRemaining(deadline)).toBe(500);
      yield* TestClock.adjust(500);
      const result = yield* Fiber.join(slow);
      expect(Result.isFailure(result) && Schema.is(ReadDeadlineExceeded)(result.failure)).toBe(true);
    }),
  );
});
