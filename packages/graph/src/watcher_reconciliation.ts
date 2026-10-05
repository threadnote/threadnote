import {Effect, Fiber, Ref} from 'effect';

const WATCH_SETTLE_RECONCILIATION_DELAY_MILLISECONDS = 45_000;

/**
 * Build periodic and post-change reconciliation for a live watch. Native
 * watchers can lose an adjacent write after delivering the first one, so the
 * delayed probe re-observes each delivered batch without steady-state polling.
 */
export const makeCodeGraphWatchReconciliation = Effect.fn('codeGraph.makeWatchReconciliation')(function* (input: {
  readonly probe: Effect.Effect<boolean, unknown>;
  readonly reload: Effect.Effect<void, unknown>;
  readonly requestRefresh: () => Effect.Effect<void>;
}) {
  const pending = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined);
  const reconcile = input.reload.pipe(
    Effect.ignore,
    Effect.andThen(input.probe),
    Effect.match({
      onFailure: () => false,
      onSuccess: refreshRequired => refreshRequired,
    }),
    Effect.flatMap(refreshRequired => (refreshRequired ? input.requestRefresh() : Effect.void)),
  );
  return {
    reconcile,
    scheduleSettled: Effect.uninterruptible(
      Effect.gen(function* () {
        const previous = yield* Ref.get(pending);
        if (previous !== undefined) yield* Fiber.interrupt(previous);
        const next = yield* Effect.sleep(WATCH_SETTLE_RECONCILIATION_DELAY_MILLISECONDS).pipe(
          Effect.andThen(reconcile),
          Effect.forkChild({startImmediately: true}),
        );
        yield* Ref.set(pending, next);
      }),
    ),
  };
});
