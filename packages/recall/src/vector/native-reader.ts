import {Effect, Semaphore} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {loadNativeVectorReader} from './native-reader-payload.js';
import type {NativeVectorReadRequest, NativeVectorReaderBinding} from './native-reader-contract.js';
import {VectorIndexOperationError} from './scoring.js';

// Each operation owns a connection and its queued task until the original Promise settles.
const admission = Semaphore.makeUnsafe(2);
const operationError = (cause: unknown) =>
  VectorIndexOperationError.make({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const availableNativeVectorReader = Effect.gen(function* () {
  const system = yield* SystemInfo;
  return yield* Effect.tryPromise({try: () => loadNativeVectorReader(system), catch: operationError});
});

export const runNativeVectorRead = (
  binding: NativeVectorReaderBinding,
  request: NativeVectorReadRequest,
  query: readonly number[] | undefined,
) =>
  admission.withPermit(
    Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const token = yield* Effect.try({try: () => new binding.CancellationToken(), catch: operationError});
        // Copy before queueing: a caller cannot mutate any native-owned input in flight.
        const ownedRequest = structuredClone(request);
        const ownedQuery = query === undefined ? undefined : new Float64Array(query);
        const original = yield* Effect.try({
          try: () => ({promise: binding.readSelected(ownedRequest, ownedQuery, token)}),
          catch: operationError,
        });
        const settled = Effect.tryPromise({try: () => original.promise, catch: operationError});
        return yield* restore(settled).pipe(
          Effect.onInterrupt(() =>
            // Never abort an N-API queued task. Its input storage and admission remain
            // owned until SQLite stops and the original Promise drains, even if the
            // cancellation boundary itself unexpectedly throws.
            Effect.sync(() => token.cancel()).pipe(Effect.ensuring(settled.pipe(Effect.ignore))),
          ),
        );
      }),
    ),
  );
