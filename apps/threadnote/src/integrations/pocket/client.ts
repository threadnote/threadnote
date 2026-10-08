import {Data, Redacted} from 'effect';

export const POCKET_API_ORIGIN = 'https://public.heypocketai.com';
const ROOT = `${POCKET_API_ORIGIN}/api/v1`;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESPONSE_LIMIT = 512 * 1024;

export type PocketClientErrorCode =
  | 'authentication-rejected'
  | 'access-rejected'
  | 'not-found'
  | 'quota-rejected'
  | 'transport-rejected'
  | 'response-too-large'
  | 'contract-invalid'
  | 'contract-incomplete'
  | 'credential-reflected'
  | 'deadline-exceeded';
export class PocketClientError extends Data.TaggedError('PocketClientError')<{
  readonly code: PocketClientErrorCode;
  readonly retryAfterMilliseconds?: number;
}> {}
export interface PocketRecording {
  readonly id: string;
  readonly [key: string]: unknown;
}
export interface PocketClientOptions {
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMilliseconds?: number;
  readonly totalTimeoutMilliseconds?: number;
  readonly maxRequests?: number;
  readonly budget?: PocketClientBudget;
}
export interface PocketClientBudget {
  requests: number;
  responseBytes: number;
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly deadlineAt: number;
}
export function makePocketClientBudget(timeoutMilliseconds: number, maxRequests: number): PocketClientBudget {
  return {
    requests: 0,
    responseBytes: 0,
    maxRequests,
    maxResponseBytes: 4 * 1024 * 1024,
    deadlineAt: Date.now() + timeoutMilliseconds,
  };
}
function fail(code: PocketClientErrorCode, retryAfterMilliseconds?: number): never {
  throw new PocketClientError({code, ...(retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds})});
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const now = Date.now();
  const maximumDelay = Math.max(0, 8_640_000_000_000_000 - now - 1);
  if (/^\d+$/.test(value.trim())) return Math.min(Number(value) * 1000, maximumDelay);
  const delay = Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, maximumDelay) : undefined;
}

export function createPocketClient(token: Redacted.Redacted<string>, options: PocketClientOptions = {}) {
  const secret = Redacted.value(token);
  if (!secret.startsWith('pk_') || secret.length > 4096 || /\s|\p{Cc}/u.test(secret)) fail('authentication-rejected');
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, {once: true});
  if (options.signal?.aborted) abort();
  const remaining =
    options.budget === undefined
      ? (options.totalTimeoutMilliseconds ?? 30_000)
      : Math.min(options.totalTimeoutMilliseconds ?? 30_000, options.budget.deadlineAt - Date.now());
  if (remaining <= 0) abort();
  const timeout = Math.min(Math.max(remaining, 1), 60_000);
  const deadlineAt = Date.now() + timeout;
  const totalTimer = setTimeout(abort, timeout);
  let requests = 0;
  let bytes = 0;
  async function get(path: string): Promise<unknown> {
    if (!/^\/public\/(?:recordings(?:\/[A-Za-z0-9_-]{1,128})?|folders|tags)$/.test(path.split('?', 1)[0]))
      fail('transport-rejected');
    const url = new URL(`${ROOT}${path}`);
    if (url.origin !== POCKET_API_ORIGIN || url.username || url.password || url.hash) fail('transport-rejected');
    if (controller.signal.aborted) fail('deadline-exceeded');
    if (
      options.budget &&
      (Date.now() >= options.budget.deadlineAt ||
        options.budget.requests >= options.budget.maxRequests ||
        options.budget.responseBytes >= options.budget.maxResponseBytes)
    )
      fail('deadline-exceeded');
    if (++requests > Math.min(options.maxRequests ?? 64, 128)) fail('contract-incomplete');
    if (options.budget) options.budget.requests++;
    const request = new AbortController();
    const cancel = () => request.abort();
    controller.signal.addEventListener('abort', cancel, {once: true});
    if (controller.signal.aborted) cancel();
    const timer = setTimeout(cancel, Math.min(Math.max(options.requestTimeoutMilliseconds ?? 5_000, 1), 30_000));
    const deadline = Promise.withResolvers<never>();
    request.signal.addEventListener(
      'abort',
      () => deadline.reject(new PocketClientError({code: 'deadline-exceeded'})),
      {once: true},
    );
    if (request.signal.aborted) deadline.reject(new PocketClientError({code: 'deadline-exceeded'}));
    try {
      const pending = fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {Authorization: `Bearer ${secret}`, Accept: 'application/json'},
        signal: request.signal,
      });
      void pending.then(
        response => {
          if (request.signal.aborted) void response.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );
      const response = await Promise.race([pending, deadline.promise]);
      if (response.status === 401) fail('authentication-rejected');
      if (response.status === 403) fail('access-rejected');
      if (response.status === 404) fail('not-found');
      if (response.status === 429) fail('quota-rejected', retryAfter(response.headers.get('retry-after')));
      if (response.status !== 200) fail('transport-rejected');
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
        fail('transport-rejected');
      if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT || !response.body) fail('response-too-large');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let responseBytes = 0;
      try {
        while (true) {
          const part = await Promise.race([reader.read(), deadline.promise]);
          if (part.done) break;
          responseBytes += part.value.byteLength;
          bytes += part.value.byteLength;
          if (options.budget) options.budget.responseBytes += part.value.byteLength;
          if (
            responseBytes > RESPONSE_LIMIT ||
            bytes > 4 * 1024 * 1024 ||
            (options.budget && options.budget.responseBytes > options.budget.maxResponseBytes)
          )
            fail('response-too-large');
          chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
      }
      const joined = new Uint8Array(responseBytes);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(joined));
      if (JSON.stringify(value).includes(secret)) fail('credential-reflected');
      return value;
    } catch (error) {
      if (error instanceof PocketClientError) throw error;
      if (request.signal.aborted || controller.signal.aborted) fail('deadline-exceeded');
      fail('transport-rejected');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
    }
  }
  const unwrap = (value: unknown): unknown => {
    if (!object(value) || value.success !== true || !('data' in value)) fail('contract-invalid');
    return value.data;
  };
  return {
    async list(page: number): Promise<{recordings: PocketRecording[]; hasMore: boolean; total: number}> {
      if (!Number.isSafeInteger(page) || page < 1) fail('contract-invalid');
      const value = await get(`/public/recordings?page=${page}&limit=100`);
      const data = unwrap(value);
      if (
        !Array.isArray(data) ||
        !object(value) ||
        !object(value.pagination) ||
        typeof value.pagination.has_more !== 'boolean' ||
        value.pagination.page !== page ||
        value.pagination.limit !== 100 ||
        !Number.isSafeInteger(value.pagination.total) ||
        (value.pagination.total as number) < 0 ||
        !Number.isSafeInteger(value.pagination.total_pages) ||
        (value.pagination.total_pages as number) < 0 ||
        !data.every(item => object(item) && validId(item.id))
      )
        fail('contract-invalid');
      const total = value.pagination.total as number;
      const totalPages = value.pagination.total_pages as number;
      if (
        data.length > 100 ||
        new Set(data.map(item => (item as PocketRecording).id)).size !== data.length ||
        (totalPages !== Math.ceil(total / 100) && !(total === 0 && totalPages === 1)) ||
        value.pagination.has_more !== page < totalPages ||
        (value.pagination.has_more && data.length !== 100) ||
        (!value.pagination.has_more && (page - 1) * 100 + data.length !== total)
      )
        fail('contract-incomplete');
      return {recordings: data as PocketRecording[], hasMore: value.pagination.has_more, total};
    },
    async detail(id: string): Promise<PocketRecording> {
      if (!validId(id)) fail('contract-invalid');
      const data = unwrap(await get(`/public/recordings/${id}?include_transcript=true&include_summarizations=true`));
      if (!object(data) || data.id !== id) fail('contract-invalid');
      return data as PocketRecording;
    },
    async catalog(kind: 'folders' | 'tags'): Promise<unknown> {
      return unwrap(await get(`/public/${kind}`));
    },
    get requests() {
      return requests;
    },
    get expired() {
      return controller.signal.aborted || Date.now() >= deadlineAt;
    },
    close() {
      clearTimeout(totalTimer);
      options.signal?.removeEventListener('abort', abort);
      abort();
    },
  };
}
