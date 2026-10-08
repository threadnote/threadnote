import {Data, Redacted} from 'effect';
import {validLinearApiToken} from './credentials.js';

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
export type LinearErrorCode =
  | 'authentication-rejected'
  | 'access-rejected'
  | 'not-found'
  | 'quota-rejected'
  | 'transport-rejected'
  | 'response-too-large'
  | 'contract-invalid'
  | 'contract-incomplete'
  | 'credential-reflected'
  | 'deadline-exceeded'
  | 'scope-rejected'
  | 'revision-changed';
export class LinearClientError extends Data.TaggedError('LinearClientError')<{
  readonly code: LinearErrorCode;
  readonly retryAfterMilliseconds?: number;
}> {}
export function fail(code: LinearErrorCode): never {
  throw new LinearClientError({code});
}
export interface LinearClientBudget {
  requests: number;
  responseBytes: number;
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly deadlineAt: number;
}
export interface LinearClientOptions {
  readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly maxRequests?: number;
  readonly totalTimeoutMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
  readonly budget?: LinearClientBudget;
}
export const makeLinearClientBudget = (milliseconds: number, requests: number): LinearClientBudget => ({
  requests: 0,
  responseBytes: 0,
  maxRequests: requests,
  maxResponseBytes: 8 * 1024 * 1024,
  deadlineAt: Date.now() + milliseconds,
});
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function errorCode(errors: unknown): LinearErrorCode {
  if (!Array.isArray(errors)) return 'contract-invalid';
  const codes = errors
    .filter(record)
    .flatMap(error =>
      record(error.extensions)
        ? [String(error.extensions.code ?? '').toUpperCase(), String(error.extensions.type ?? '').toUpperCase()]
        : [],
    );
  if (codes.some(code => /RATE.?LIMIT|RATELIMITED/.test(code))) return 'quota-rejected';
  if (codes.some(code => /AUTHENTICATION|UNAUTHENTICATED/.test(code))) return 'authentication-rejected';
  if (codes.some(code => /FORBIDDEN|PERMISSION|ACCESS_DENIED/.test(code))) return 'access-rejected';
  if (codes.some(code => /NOT_FOUND|ENTITY_NOT_FOUND/.test(code))) return 'not-found';
  if (codes.some(code => /GRAPHQL_VALIDATION|GRAPHQL_PARSE/.test(code))) return 'contract-invalid';
  return 'contract-incomplete';
}
function quotaRetryDelay(value: string | null): number {
  if (value === null) return 60000;
  const numeric = Number(value);
  const milliseconds = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.min(86400000, Math.max(60000, milliseconds)) : 60000;
}
export function createLinearTransport(token: Redacted.Redacted<string>, options: LinearClientOptions = {}) {
  if (!validLinearApiToken(token)) fail('authentication-rejected');
  const secret = Redacted.value(token);
  const budget =
    options.budget ?? makeLinearClientBudget(options.totalTimeoutMilliseconds ?? 60000, options.maxRequests ?? 128);
  const localDeadline = Math.min(budget.deadlineAt, Date.now() + (options.totalTimeoutMilliseconds ?? 60000));
  let requests = 0;
  const controller = new AbortController();
  async function query(queryText: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (
      Date.now() >= localDeadline ||
      controller.signal.aborted ||
      budget.requests >= budget.maxRequests ||
      requests >= Math.min(options.maxRequests ?? 128, 256)
    )
      fail('deadline-exceeded');
    requests++;
    budget.requests++;
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.min(options.requestTimeoutMilliseconds ?? 10000, localDeadline - Date.now())),
    );
    const signal = AbortSignal.any([controller.signal, timeout, ...(options.signal ? [options.signal] : [])]);
    const aborted = Promise.withResolvers<never>();
    const abort = () => aborted.reject(new LinearClientError({code: 'deadline-exceeded'}));
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const pending = (options.fetch ?? fetch)(new URL(LINEAR_ENDPOINT), {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {Authorization: secret, 'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({query: queryText, variables}),
      });
      void pending.then(
        response => {
          if (signal.aborted) void response.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );
      const response = await Promise.race([pending, aborted.promise]);
      const retryAfterMilliseconds = quotaRetryDelay(response.headers.get('retry-after'));
      if (response.status === 401) fail('authentication-rejected');
      if (response.status === 403) fail('access-rejected');
      if (response.status === 404) fail('not-found');
      if (response.status === 429)
        throw new LinearClientError({
          code: 'quota-rejected',
          retryAfterMilliseconds,
        });
      if (
        ![200, 400].includes(response.status) ||
        !response.headers.get('content-type')?.startsWith('application/json') ||
        !response.body
      )
        fail('transport-rejected');
      if (Number(response.headers.get('content-length')) > 1024 * 1024) fail('response-too-large');
      reader = response.body.getReader();
      const pieces: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), aborted.promise]);
        if (chunk.done) break;
        size += chunk.value.length;
        budget.responseBytes += chunk.value.length;
        if (size > 1024 * 1024 || budget.responseBytes > budget.maxResponseBytes) fail('response-too-large');
        pieces.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const piece of pieces) {
        bytes.set(piece, offset);
        offset += piece.length;
      }
      const raw = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      if (raw.includes(secret)) fail('credential-reflected');
      const value: unknown = JSON.parse(raw);
      if (JSON.stringify(value).includes(secret)) fail('credential-reflected');
      if (!record(value)) fail('contract-invalid');
      if (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 0)) {
        const code = errorCode(value.errors);
        throw new LinearClientError({code, ...(code === 'quota-rejected' ? {retryAfterMilliseconds} : {})});
      }
      if (response.status !== 200 || !record(value.data)) fail('contract-invalid');
      return value.data;
    } catch (error) {
      if (error instanceof LinearClientError) throw error;
      return fail(signal.aborted ? 'deadline-exceeded' : 'transport-rejected');
    } finally {
      signal.removeEventListener('abort', abort);
      void reader?.cancel().catch(() => undefined);
    }
  }
  return {
    query,
    budget,
    get requests() {
      return requests;
    },
    get expired() {
      return Date.now() >= localDeadline || controller.signal.aborted;
    },
    close() {
      controller.abort();
    },
  };
}
