import {Array as EffectArray, Schema} from 'effect';
import {Redacted} from 'effect';
import {validLinearApiToken} from './credentials.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
export const LinearErrorCodeSchema = Schema.Literals([
  'authentication-rejected',
  'access-rejected',
  'not-found',
  'quota-rejected',
  'transport-rejected',
  'response-too-large',
  'contract-invalid',
  'contract-incomplete',
  'credential-reflected',
  'deadline-exceeded',
  'scope-rejected',
  'revision-changed',
]);
export type LinearErrorCode = typeof LinearErrorCodeSchema.Type;
export class LinearClientError extends Schema.TaggedError<LinearClientError, {readonly brand: unique symbol}>()(
  'LinearClientError',
  {code: LinearErrorCodeSchema, retryAfterMilliseconds: Schema.optional(Schema.Finite)},
) {}
export function fail(code: LinearErrorCode): never {
  throw LinearClientError.make({code});
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
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
function errorCode(errors: unknown): LinearErrorCode {
  if (!EffectArray.isArray(errors)) return 'contract-invalid';
  const codes = EffectArray.flatMap(
    EffectArray.filter(
      errors,
      (
        __effectFilterValue: (typeof errors)[number],
        __effectFilterIndex: number,
      ): __effectFilterValue is Record<string, unknown> => __effectFilterIndex in errors && record(__effectFilterValue),
    ),
    (error: Record<string, unknown>) =>
      record(error.extensions)
        ? [
            Effect.pipe(String(error.extensions.code ?? ''), EffectString.toUpperCase),
            Effect.pipe(String(error.extensions.type ?? ''), EffectString.toUpperCase),
          ]
        : [],
  );
  if (EffectArray.some(codes, code => /RATE.?LIMIT|RATELIMITED/.test(code))) return 'quota-rejected';
  if (EffectArray.some(codes, code => /AUTHENTICATION|UNAUTHENTICATED/.test(code))) return 'authentication-rejected';
  if (EffectArray.some(codes, code => /FORBIDDEN|PERMISSION|ACCESS_DENIED/.test(code))) return 'access-rejected';
  if (EffectArray.some(codes, code => /NOT_FOUND|ENTITY_NOT_FOUND/.test(code))) return 'not-found';
  if (EffectArray.some(codes, code => /GRAPHQL_VALIDATION|GRAPHQL_PARSE/.test(code))) return 'contract-invalid';
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
    const abort = () => aborted.reject(LinearClientError.make({code: 'deadline-exceeded'}));
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
        throw LinearClientError.make({
          code: 'quota-rejected',
          retryAfterMilliseconds,
        });
      if (
        ![200, 400].includes(response.status) ||
        !Effect.pipe(response.headers.get('content-type'), effectOptionalString =>
          effectOptionalString == null
            ? undefined
            : Effect.pipe(effectOptionalString, EffectString.startsWith('application/json')),
        ) ||
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
      if (Effect.pipe(raw, EffectString.includes(secret))) fail('credential-reflected');
      const value: unknown = JSON.parse(raw);
      if (Effect.pipe(JSON.stringify(value), EffectString.includes(secret))) fail('credential-reflected');
      if (!record(value)) fail('contract-invalid');
      if (value.errors !== undefined && (!EffectArray.isArray(value.errors) || value.errors.length > 0)) {
        const code = errorCode(value.errors);
        throw LinearClientError.make({code, ...(code === 'quota-rejected' ? {retryAfterMilliseconds} : {})});
      }
      if (response.status !== 200 || !record(value.data)) fail('contract-invalid');
      return value.data;
    } catch (error) {
      if (Schema.is(LinearClientError)(error)) throw error;
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
