import {Cause, Effect, Option, Schema} from 'effect';
import {requestRecallLexicalRefresh, type RecallLexicalScope} from '../background/lexical-demand.js';
import {RecallReadyReadIncomplete} from './read_policy.js';

/** One bounded metadata attempt per read, including errors after query completion. */
export function makeReadyRecallMaintenance(scope: RecallLexicalScope) {
  let attempted = false;
  let outcome: 'queued' | 'unavailable' = 'unavailable';
  const request = (reconcile = false) =>
    Effect.suspend(() => {
      if (attempted) return Effect.succeed(outcome);
      attempted = true;
      return requestRecallLexicalRefresh(scope, {reconcile}).pipe(
        Effect.interruptible,
        Effect.timeout('100 millis'),
        Effect.as('queued' as const),
        Effect.orElseSucceed(() => 'unavailable' as const),
        Effect.tap(value =>
          Effect.sync(() => {
            outcome = value;
          }),
        ),
      );
    });
  return {
    request,
    onError: (cause: Cause.Cause<unknown>) => {
      if (attempted || Cause.hasInterrupts(cause)) return Effect.void;
      const error = Option.getOrUndefined(Cause.findErrorOption(cause));
      if (Schema.is(RecallReadyReadIncomplete)(error) && error.maintenance === undefined) return Effect.void;
      return request(Schema.is(RecallReadyReadIncomplete)(error) && error.maintenance === 'reconcile').pipe(
        Effect.asVoid,
      );
    },
  };
}

export function retainReadyRecallMaintenance(error: RecallReadyReadIncomplete, stale: boolean) {
  return RecallReadyReadIncomplete.make({
    message: error.message,
    ...(error.maintenance === 'reconcile'
      ? {maintenance: 'reconcile' as const}
      : stale
        ? {maintenance: 'refresh' as const}
        : {}),
  });
}
