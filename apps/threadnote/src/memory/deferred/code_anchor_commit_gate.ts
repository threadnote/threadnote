import {Clock, Effect, Semaphore} from 'effect';

// Foreground writers poll the account mutation lock every 25 ms within a 2 s
// native budget. A pass leaves the lock free this long between its own commits.
const DEFERRED_CODE_ANCHOR_COMMIT_HANDOFF_MILLISECONDS = 100;

export type DeferredCodeAnchorCommitGate = <A, E, R>(commit: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/**
 * Concurrent captures of one pass must not queue on the account mutation lock
 * and pass it to each other, because a polling foreground writer then loses
 * every handoff. The gate admits one commit at a time and keeps the lock free
 * for the handoff interval after each commit.
 */
export const makeDeferredCodeAnchorCommitGate = Effect.gen(function* () {
  const permit = yield* Semaphore.make(1);
  let releasedAt: number | undefined;
  const markReleased = Effect.flatMap(Clock.currentTimeMillis, now =>
    Effect.sync(() => {
      releasedAt = now;
    }),
  );
  const gate: DeferredCodeAnchorCommitGate = commit =>
    permit.withPermit(
      Effect.gen(function* () {
        if (releasedAt !== undefined) {
          const wait = releasedAt + DEFERRED_CODE_ANCHOR_COMMIT_HANDOFF_MILLISECONDS - (yield* Clock.currentTimeMillis);
          // A wall clock that steps back must not extend the handoff.
          if (wait > 0) yield* Effect.sleep(Math.min(wait, DEFERRED_CODE_ANCHOR_COMMIT_HANDOFF_MILLISECONDS));
        }
        return yield* commit.pipe(Effect.ensuring(markReleased));
      }),
    );
  return gate;
});
