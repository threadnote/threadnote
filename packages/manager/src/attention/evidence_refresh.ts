import {Schema} from 'effect';
import {errorMessage, ManagerApiError} from '../ui/support.js';

export function retryableEvidenceRead(cause: unknown): boolean {
  return !Schema.is(ManagerApiError)(cause) || cause.status >= 500 || [408, 429].includes(cause.status);
}

export function evidenceReadError(cause: unknown): string {
  return retryableEvidenceRead(cause)
    ? 'Current evidence could not be checked. Check current evidence to try again.'
    : errorMessage(cause);
}

/** Retry only observation requests, retaining their exact scope and cancellation signal. */
export async function retryEvidenceRead<A>(read: () => Promise<A>, signal: AbortSignal): Promise<A> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new DOMException('The evidence check was cancelled.', 'AbortError');
    try {
      return await read();
    } catch (cause) {
      if (signal.aborted || !retryableEvidenceRead(cause) || attempt >= 2) throw cause;
      const wait = Promise.withResolvers<void>();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        wait.resolve();
      };
      const timer = setTimeout(done, 500 * (attempt + 1));
      signal.addEventListener('abort', done, {once: true});
      await wait.promise;
    }
  }
}
