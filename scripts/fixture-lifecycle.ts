import {Effect, Option} from 'effect';
import {ScriptError} from './effect/errors.js';

/** Preserve both the body cause and the teardown cause, including defects and interruption. */
export function fixtureLifecycle<A, E, R, E2, R2>(body: Effect.Effect<A, E, R>, cleanup: Effect.Effect<void, E2, R2>) {
  return body.pipe(Effect.onExit(() => cleanup));
}

/** The only fixture cleanup path used by the smoke; no deletion without both proofs. */
export function fixtureCleanup<E1, R1, E2, R2, E3, R3>(options: {
  readonly producers: Effect.Effect<'exited' | 'unknown', E1, R1>;
  readonly drain: Effect.Effect<{readonly state: 'drained' | 'unknown'}, E2, R2>;
  readonly remove: Effect.Effect<void, E3, R3>;
  /** Minimum of the original epoch and monotonic deadline budgets. */
  readonly remaining: Effect.Effect<number>;
}): Effect.Effect<void, E1 | E2 | ScriptError, R1 | R2 | R3> {
  return Effect.gen(function* () {
    if ((yield* options.producers) !== 'exited')
      return yield* ScriptError.make({message: 'Fixture producer exit unknown; fixture retained.'});
    const drainBudget = yield* options.remaining;
    if (drainBudget <= 0)
      return yield* ScriptError.make({message: 'Fixture cleanup deadline expired; fixture retained.'});
    const drained = yield* options.drain.pipe(Effect.timeoutOption(drainBudget));
    if (Option.isNone(drained))
      return yield* ScriptError.make({message: 'Fixture worker drain timed out; fixture retained.'});
    if (drained.value.state !== 'drained')
      return yield* ScriptError.make({message: 'Fixture worker drain unknown; fixture retained.'});
    const removalBudget = yield* options.remaining;
    if (removalBudget <= 0)
      return yield* ScriptError.make({message: 'Fixture cleanup deadline expired; fixture retained.'});
    const removed = yield* options.remove.pipe(
      Effect.mapError(cause => ScriptError.make({message: 'Fixture removal failed; cleanup may be partial.', cause})),
      Effect.timeoutOption(removalBudget),
    );
    if (Option.isNone(removed))
      return yield* ScriptError.make({message: 'Fixture removal timed out; cleanup may be partial.'});
    yield* fixtureRemovalDeadline(options.remaining);
  });
}

/** Removal has started or finished, so a late result must never claim intact retention. */
export const fixtureRemovalDeadline = (remaining: Effect.Effect<number>) =>
  Effect.gen(function* () {
    if ((yield* remaining) <= 0)
      return yield* ScriptError.make({message: 'Fixture removal completed late; cleanup may be partial or complete.'});
  });
