import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {
  createMcpRecallSemanticRetrievalGate,
  MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS,
  MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS,
} from '../../src/runtime.js';

describe('MCP semantic retrieval cooldown', () => {
  effectIt.effect('skips repeated semantic work after a timeout and retries after the cooldown', () =>
    Effect.gen(function* () {
      const gate = createMcpRecallSemanticRetrievalGate();
      const runtime = {};
      let invocations = 0;
      const retrieval = Effect.sync(() => {
        invocations += 1;
      }).pipe(Effect.andThen(Effect.sleep(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS + 1)));
      const first = yield* gate(runtime, retrieval).pipe(Effect.forkChild);
      yield* TestClock.adjust(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS);
      expect(yield* Fiber.join(first)).toEqual({status: 'timed-out'});
      expect(yield* gate(runtime, retrieval)).toEqual({status: 'cooldown'});
      expect(invocations).toBe(1);

      yield* TestClock.adjust(MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS);
      expect(yield* gate(runtime, Effect.succeed('recovered'))).toEqual({status: 'completed', value: 'recovered'});
      expect(yield* gate(runtime, Effect.succeed('still healthy'))).toEqual({
        status: 'completed',
        value: 'still healthy',
      });
    }),
  );

  effectIt.effect('an overlapping completion cannot erase a later timeout cooldown', () =>
    Effect.gen(function* () {
      const gate = createMcpRecallSemanticRetrievalGate();
      const runtime = {};
      const first = yield* gate(runtime, Effect.never).pipe(Effect.forkChild);
      yield* TestClock.adjust(5_000);
      const second = yield* gate(runtime, Effect.sleep(12_000).pipe(Effect.as('completed'))).pipe(Effect.forkChild);
      yield* TestClock.adjust(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS - 5_000);
      expect(yield* Fiber.join(first)).toEqual({status: 'timed-out'});
      yield* TestClock.adjust(2_000);
      expect(yield* Fiber.join(second)).toEqual({status: 'completed', value: 'completed'});
      let invocations = 0;
      expect(
        yield* gate(
          runtime,
          Effect.sync(() => {
            invocations += 1;
          }),
        ),
      ).toEqual({status: 'cooldown'});
      expect(invocations).toBe(0);
    }),
  );

  fcEffectProp(
    effectIt,
    'a timeout cooldown is bounded to one runtime and one monotonic interval',
    {elapsedMilliseconds: FC.integer({min: 0, max: MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS * 2})},
    ({elapsedMilliseconds}) =>
      Effect.gen(function* () {
        const gate = createMcpRecallSemanticRetrievalGate();
        const timedOutRuntime = {};
        const otherRuntime = {};
        const first = yield* gate(timedOutRuntime, Effect.never).pipe(Effect.forkChild);
        yield* TestClock.adjust(MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS);
        expect(yield* Fiber.join(first)).toEqual({status: 'timed-out'});
        yield* TestClock.adjust(elapsedMilliseconds);
        let invocations = 0;
        const result = yield* gate(
          timedOutRuntime,
          Effect.sync(() => {
            invocations += 1;
            return 'ready';
          }),
        );
        const cooling = elapsedMilliseconds < MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS;
        expect(result).toEqual(cooling ? {status: 'cooldown'} : {status: 'completed', value: 'ready'});
        expect(invocations).toBe(cooling ? 0 : 1);
        expect(yield* gate(otherRuntime, Effect.succeed('available'))).toEqual({
          status: 'completed',
          value: 'available',
        });
      }),
    {fastCheck: {numRuns: 40}},
  );
});
