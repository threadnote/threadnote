import {Cause, Effect} from 'effect';

/** Keep recoverable integration and sync errors visible in Manager. */
export function managerFeatureError(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  const invalidInput =
    typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'ManagerRequestInputError';
  return Effect.succeed({
    status: invalidInput ? 400 : 409,
    body: {error: error instanceof Error ? error.message : String(error)},
  });
}
