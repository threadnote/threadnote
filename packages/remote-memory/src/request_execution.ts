import {remoteMemoryError} from './errors.js';
import type {ISql} from 'postgres';

/**
 * Cooperative execution budget shared by one HTTP request and every storage
 * operation it starts. Implementations must settle an in-flight mutation
 * before the HTTP layer returns a cancellation or deadline response.
 */
export interface RemoteMemoryRequestExecution {
  readonly deadlineEpochMilliseconds: number;
  readonly signal: AbortSignal;
}

export function remainingRemoteMemoryRequestMilliseconds(
  execution: RemoteMemoryRequestExecution,
  nowEpochMilliseconds = Date.now(),
): number {
  return Math.max(0, Math.floor(execution.deadlineEpochMilliseconds - nowEpochMilliseconds));
}

export function requireActiveRemoteMemoryRequest(execution: RemoteMemoryRequestExecution | undefined): void {
  if (!execution) return;
  if (execution.signal.aborted) {
    throw remoteMemoryError('service_unavailable', 'The remote request was cancelled.');
  }
  if (remainingRemoteMemoryRequestMilliseconds(execution) <= 0) {
    throw remoteMemoryError('service_unavailable', 'The remote request deadline expired.');
  }
}

export function remoteMemoryDatabaseTimeoutMilliseconds(
  configuredMaximumMilliseconds: number,
  execution?: RemoteMemoryRequestExecution,
  nowEpochMilliseconds = Date.now(),
): number {
  if (!execution) return configuredMaximumMilliseconds;
  return Math.max(
    1,
    Math.min(configuredMaximumMilliseconds, remainingRemoteMemoryRequestMilliseconds(execution, nowEpochMilliseconds)),
  );
}

/**
 * Tracks postgres.js PendingQuery values created through a transaction and
 * sends the driver's protocol-level CancelRequest when the HTTP signal aborts.
 * PostgreSQL statement/transaction timeouts remain the authoritative fallback.
 */
export async function withRemoteMemoryRequestCancellation<A>(
  transaction: ISql,
  execution: RemoteMemoryRequestExecution | undefined,
  use: (transaction: ISql) => Promise<A>,
): Promise<A> {
  requireActiveRemoteMemoryRequest(execution);
  if (!execution) return use(transaction);

  const active = new Set<CancellablePendingQuery>();
  const cancelActive = () => {
    for (const query of active) {
      try {
        query.cancel();
      } catch {
        // PostgreSQL timeouts still bound a driver cancellation race/failure.
      }
    }
  };
  const proxied = new Proxy(transaction, {
    apply(target, thisArgument, argumentsList) {
      const result: unknown = Reflect.apply(target, thisArgument, argumentsList);
      if (isCancellablePendingQuery(result)) {
        active.add(result);
        void Promise.resolve(result).then(
          () => active.delete(result),
          () => active.delete(result),
        );
        if (execution.signal.aborted) result.cancel();
      }
      return result;
    },
  });

  execution.signal.addEventListener('abort', cancelActive);
  try {
    requireActiveRemoteMemoryRequest(execution);
    const result = await use(proxied);
    requireActiveRemoteMemoryRequest(execution);
    return result;
  } finally {
    execution.signal.removeEventListener('abort', cancelActive);
    active.clear();
  }
}

interface CancellablePendingQuery extends PromiseLike<unknown> {
  readonly cancel: () => void;
}

function isCancellablePendingQuery(value: unknown): value is CancellablePendingQuery {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function' &&
    'cancel' in value &&
    typeof value.cancel === 'function'
  );
}
