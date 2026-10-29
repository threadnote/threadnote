import {Effect, Schema} from 'effect';

export class ApplicationError extends Schema.TaggedError<ApplicationError, {readonly brand: unique symbol}>()(
  'ApplicationError',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export function applicationError(operation: string, cause: unknown): ApplicationError {
  return ApplicationError.make({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });
}

export const fromPromise = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({try: evaluate, catch: cause => applicationError(operation, cause)});

export const fromPromiseInterruptible = <A, E>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
  onError: (cause: unknown) => E,
) => Effect.tryPromise({try: evaluate, catch: onError});

/**
 * Lift a Promise resource operation whose owner must not release state until an
 * interrupted operation has observed cancellation and settled.
 */
export const fromPromiseInterruptibleAwaiting = <A, E>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
  onError: (cause: unknown) => E,
) =>
  Effect.callback<A, E>((resume, signal) => {
    let operation: Promise<A>;
    try {
      operation = Promise.resolve(evaluate(signal));
    } catch (cause) {
      operation = Promise.reject(cause);
    }
    operation.then(
      value => resume(Effect.succeed(value)),
      cause => resume(Effect.failSync(() => onError(cause))),
    );
    return Effect.promise(() =>
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
  });

export const fromSync = <A>(operation: string, evaluate: () => A) =>
  Effect.try({try: evaluate, catch: cause => applicationError(operation, cause)});

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class UtilityOperationError extends Schema.TaggedError<UtilityOperationError, {readonly brand: unique symbol}>()(
  'UtilityOperationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}
