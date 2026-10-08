import {Redacted} from 'effect';
import {fail, record, SlackPilotError, type SlackErrorCode} from './contract.js';

type Method = 'auth.test' | 'assistant.search.info' | 'assistant.search.context' | 'conversations.replies';
export interface SlackPilotOptions {
  readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly totalTimeoutMs?: number;
}

const PER_RESPONSE_BYTES = 256 * 1024;
const TOTAL_BYTES = 512 * 1024;
const MAX_REQUESTS: Record<Method, number> = {
  'auth.test': 1,
  'assistant.search.info': 1,
  'assistant.search.context': 3,
  'conversations.replies': 2,
};

function providerError(value: unknown): SlackErrorCode {
  if (['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].includes(String(value)))
    return 'authentication-rejected';
  if (['ratelimited', 'rate_limited'].includes(String(value))) return 'quota-rejected';
  if (['channel_not_found', 'thread_not_found', 'message_not_found'].includes(String(value))) return 'not-found';
  if (
    ['access_denied', 'missing_scope', 'not_allowed_token_type', 'no_permission', 'team_access_not_granted'].includes(
      String(value),
    )
  )
    return 'access-rejected';
  return 'transport-rejected';
}

function abortable<A>(work: Promise<A>, signal: AbortSignal): Promise<A> {
  const cancellation = Promise.withResolvers<never>();
  const aborted = () => cancellation.reject(new SlackPilotError({code: 'deadline-exceeded'}));
  if (signal.aborted) aborted();
  else signal.addEventListener('abort', aborted, {once: true});
  return Promise.race([cancellation.promise, work]).finally(() => signal.removeEventListener('abort', aborted));
}

/** Immediate, bounded processing only. No caches, indexes, retries or background calls. */
export function createSlackPilotSession(token: Redacted.Redacted<string>, options: SlackPilotOptions = {}) {
  const secret = Redacted.value(token);
  if (!/^(xoxp-|xoxe\.xoxp-)[A-Za-z0-9-]+$/.test(secret) || secret.length > 4_096) fail('missing-credential');
  const totalMs = options.totalTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(totalMs) || totalMs < 1 || totalMs > 10_000) fail('invalid-input');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, {once: true});
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(onAbort, totalMs);
  const counts: Record<Method, number> = {
    'auth.test': 0,
    'assistant.search.info': 0,
    'assistant.search.context': 0,
    'conversations.replies': 0,
  };
  let responseBytes = 0;
  let closed = false;
  const request = async (method: Method, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (closed || controller.signal.aborted) return fail('deadline-exceeded');
    if (!Object.hasOwn(MAX_REQUESTS, method)) return fail('invalid-input');
    if (counts[method] >= MAX_REQUESTS[method]) return fail('budget-exhausted');
    counts[method]++;
    const current = new AbortController();
    const abort = () => current.abort();
    controller.signal.addEventListener('abort', abort, {once: true});
    const requestTimer = setTimeout(abort, 5_000);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = new URL(`https://slack.com/api/${method}`);
      response = await abortable(
        (options.fetch ?? fetch)(url, {
          method: 'POST',
          redirect: 'manual',
          signal: current.signal,
          headers: {Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json; charset=utf-8'},
          body: JSON.stringify(args),
        }),
        current.signal,
      );
      if (response.url && response.url !== url.href) return fail('transport-rejected');
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds = retry !== null && /^\d{1,8}$/.test(retry) ? Number(retry) : undefined;
        throw new SlackPilotError({code: 'quota-rejected', retryAfterSeconds: seconds});
      }
      if (response.status === 401) return fail('authentication-rejected');
      if (response.status === 403) return fail('access-rejected');
      if (!response.ok || !response.body) return fail('transport-rejected');
      const declared = Number(response.headers.get('content-length'));
      if (declared > PER_RESPONSE_BYTES || declared + responseBytes > TOTAL_BYTES) return fail('response-too-large');
      reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await abortable(reader.read(), current.signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        responseBytes += part.value.byteLength;
        if (bytes > PER_RESPONSE_BYTES || responseBytes > TOTAL_BYTES) return fail('response-too-large');
        parts.push(part.value);
      }
      const body = Buffer.concat(parts).toString('utf8');
      if (body.includes(secret)) return fail('contract-invalid');
      const value: unknown = JSON.parse(body);
      if (!record(value) || typeof value.ok !== 'boolean') return fail('contract-invalid');
      if (!value.ok) {
        const code = providerError(value.error);
        if (code === 'authentication-rejected' || code === 'access-rejected') closed = true;
        return fail(code);
      }
      return value;
    } catch (error) {
      if (error instanceof SlackPilotError) {
        if (['authentication-rejected', 'access-rejected', 'contract-invalid'].includes(error.code)) closed = true;
        throw error;
      }
      return fail(current.signal.aborted ? 'deadline-exceeded' : 'transport-rejected');
    } finally {
      clearTimeout(requestTimer);
      controller.signal.removeEventListener('abort', abort);
      if (reader) void reader.cancel().catch(() => undefined);
      else if (response?.body) void response.body.cancel().catch(() => undefined);
    }
  };
  return {
    request,
    get counts() {
      return {...counts};
    },
    get responseBytes() {
      return responseBytes;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      controller.abort();
    },
  };
}
