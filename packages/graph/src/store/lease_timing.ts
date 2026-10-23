import {Effect} from 'effect';

/** @internal Path-free, synchronous diagnostic boundaries; never a lease authority. */
export type CodeGraphLeaseTimingObserver = (
  stage:
    | 'token'
    | 'prepare'
    | 'exists'
    | 'writer-gate'
    | 'session'
    | 'session-body'
    | 'schema'
    | 'lease-sql'
    | 'connection-configure'
    | 'transaction'
    | 'transaction-body'
    | 'prune'
    | 'schedule',
  boundary: 'begin' | 'end',
) => void;

export function withCodeGraphLeaseTiming<A, E, R>(
  observer: CodeGraphLeaseTimingObserver | undefined,
  stage: Parameters<CodeGraphLeaseTimingObserver>[0],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (observer === undefined) return effect;
  const notify = (boundary: 'begin' | 'end') =>
    Effect.sync(() => {
      try {
        observer(stage, boundary);
      } catch {
        // Diagnostic callbacks cannot replace the operation's result or finalizers.
      }
    });
  return notify('begin').pipe(Effect.andThen(effect), Effect.ensuring(notify('end')));
}
