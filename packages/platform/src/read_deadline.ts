import {Array as EffectArray, Cause, Clock, Context, Effect, Exit, Schema} from 'effect';

export const isReadCleanupUnconfirmed = Schema.is(
  Schema.Union([
    Schema.Struct({reason: Schema.Literal('cleanup-unconfirmed')}),
    Schema.TaggedStruct('CommandCleanupUnconfirmed', {}),
  ]),
);

export const hasReadCleanupUnconfirmed = <E>(cause: Cause.Cause<E>) =>
  EffectArray.some(
    cause.reasons,
    reason =>
      (Cause.isFailReason(reason) && isReadCleanupUnconfirmed(reason.error)) ||
      (Cause.isDieReason(reason) && isReadCleanupUnconfirmed(reason.defect)),
  );

/** Request-local elapsed deadline. Never send a process-local clock origin over IPC. */
export interface ReadDeadline {
  readonly expiresAtNanos: bigint;
}

/** Existing owned read deadline supplied by the application, never a fresh budget. */
export class ReadDeadlineContext extends Context.Service<ReadDeadlineContext, ReadDeadline>()(
  '@threadnote/platform/read_deadline/ReadDeadlineContext',
) {}

export class ReadDeadlineExceeded extends Schema.TaggedError<ReadDeadlineExceeded, {readonly brand: unique symbol}>()(
  'ReadDeadlineExceeded',
  {},
) {}

export const makeReadDeadline = (milliseconds: number): Effect.Effect<ReadDeadline> =>
  Clock.monotonicTimeNanos.pipe(
    Effect.map(now =>
      Object.freeze({expiresAtNanos: now + BigInt(Math.max(0, Math.floor(milliseconds))) * 1_000_000n}),
    ),
  );

/** Reserve transport/finalization inside the caller's deadline, never after it. */
export const readDeadlineRemaining = (deadline: ReadDeadline, reserveMilliseconds = 0) =>
  Clock.monotonicTimeNanos.pipe(
    Effect.map(now =>
      Math.max(0, Math.floor(Number(deadline.expiresAtNanos - now) / 1_000_000) - Math.max(0, reserveMilliseconds)),
    ),
  );

/**
 * Bounds interruptible orchestration and rejects late results. Synchronous native
 * work additionally needs an owned process boundary; this helper cannot preempt it.
 */
export function withinReadDeadline<A, E, R>(deadline: ReadDeadline, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const remaining = yield* readDeadlineRemaining(deadline);
    if (remaining <= 0) return yield* ReadDeadlineExceeded.make({});
    let cleanupFailure: Cause.Cause<E> | undefined;
    const exit = yield* effect.pipe(
      Effect.onExit(exit =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && hasReadCleanupUnconfirmed(exit.cause)) cleanupFailure = exit.cause;
        }),
      ),
      Effect.timeoutOrElse({duration: remaining, orElse: () => Effect.fail(ReadDeadlineExceeded.make({}))}),
      Effect.exit,
    );
    // Timeout fallback must not erase a failed owned-resource finalizer.
    if (cleanupFailure !== undefined) return yield* Effect.failCause(cleanupFailure);
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
    const result = exit.value;
    if ((yield* readDeadlineRemaining(deadline)) <= 0) return yield* ReadDeadlineExceeded.make({});
    return result;
  });
}
