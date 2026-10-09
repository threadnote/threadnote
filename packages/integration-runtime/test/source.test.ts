import {it as effectIt} from '@effect/vitest';
import {Effect, Ref, Result, Schema} from 'effect';
import {describe, expect} from 'vitest';
import {syncRegisteredSources} from '../src/source.js';

describe('registered source sync', () => {
  effectIt.effect.prop(
    'preserves provider registration order and result order',
    [
      Schema.Array(Schema.Array(Schema.String.check(Schema.isMaxLength(12))).check(Schema.isMaxLength(5))).check(
        Schema.isMaxLength(8),
      ),
    ],
    ([groups]) =>
      Effect.gen(function* () {
        const visited = yield* Ref.make<readonly number[]>([]);
        const result = yield* syncRegisteredSources(
          groups.map((values, index) =>
            Ref.update(visited, previous => [...previous, index]).pipe(
              Effect.as({syncedSources: values, warnings: values}),
            ),
          ),
        );
        expect(yield* Ref.get(visited)).toEqual(groups.map((_, index) => index));
        expect(result.syncedSources).toEqual(groups.flat());
        expect(result.warnings).toEqual(groups.flat());
      }),
    {arbitrary: {runs: 30}},
  );

  effectIt.effect('stops at the first provider failure', () =>
    Effect.gen(function* () {
      const later = yield* Ref.make(false);
      const result = yield* syncRegisteredSources([
        Effect.fail('unavailable'),
        Ref.set(later, true).pipe(Effect.as({syncedSources: [], warnings: []})),
      ]).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(yield* Ref.get(later)).toBe(false);
    }),
  );
});
