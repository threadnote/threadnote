import {Data, Redacted} from 'effect';
import {applyScrubber} from '@threadnote/platform/scrubber';
import {normalizeSuperhumanDisplayText, normalizeSuperhumanTitle} from './render.js';

export const SUPERHUMAN_API_ORIGIN = 'https://docs.superhuman.com';
const API_ROOT = `${SUPERHUMAN_API_ORIGIN}/apis/v1`;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESPONSE_LIMIT = 256 * 1024;
const TOTAL_LIMIT = 2 * 1024 * 1024;
const CURSOR_LIMIT = 512;

export type SuperhumanClientErrorCode =
  | 'authentication-rejected'
  | 'access-rejected'
  | 'not-found'
  | 'quota-rejected'
  | 'transport-rejected'
  | 'response-too-large'
  | 'contract-invalid'
  | 'contract-incomplete'
  | 'contract-unsupported'
  | 'credential-reflected'
  | 'deadline-exceeded';

export class SuperhumanClientError extends Data.TaggedError('SuperhumanClientError')<{
  readonly code: SuperhumanClientErrorCode;
  readonly retryAfterMilliseconds?: number;
}> {}

export interface SuperhumanPage {
  readonly id: string;
  readonly name: string;
  readonly isHidden: boolean;
  readonly isEffectivelyHidden: boolean;
  readonly contentType: 'canvas' | 'embed' | 'syncPage';
  readonly updatedAt?: string;
}

export interface SuperhumanLine {
  readonly id: string;
  readonly style?: string;
  readonly content?: string;
  readonly lineLevel?: number;
}

export interface SuperhumanPageContent {
  readonly page: SuperhumanPage;
  readonly lines: readonly SuperhumanLine[];
}

export interface SuperhumanDocumentSnapshot {
  readonly documentId: string;
  readonly pages: readonly SuperhumanPageContent[];
  readonly excluded: readonly {readonly pageId: string; readonly reason: 'hidden' | 'unsupported' | 'not-selected'}[];
  readonly missingSelectedPageIds: readonly string[];
  readonly requests: number;
  readonly responseBytes: number;
}

export interface SuperhumanClientOptions {
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMilliseconds?: number;
  readonly totalTimeoutMilliseconds?: number;
  readonly maxRequests?: number;
  readonly budget?: SuperhumanClientBudget;
}

export interface SuperhumanClientBudget {
  requests: number;
  responseBytes: number;
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly deadlineAt: number;
}

export function makeSuperhumanClientBudget(
  totalTimeoutMilliseconds: number,
  maxRequests: number,
): SuperhumanClientBudget {
  return {
    requests: 0,
    responseBytes: 0,
    maxRequests: bounded(maxRequests, 64),
    maxResponseBytes: TOTAL_LIMIT,
    deadlineAt: Date.now() + bounded(totalTimeoutMilliseconds, 30_000),
  };
}

function fail(code: SuperhumanClientErrorCode, retryAfterMilliseconds?: number): never {
  throw new SuperhumanClientError({code, ...(retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds})});
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function validateIdentifier(value: string): string {
  if (!identifier(value)) fail('contract-invalid');
  return value;
}

function pageFrom(value: unknown): SuperhumanPage {
  if (!object(value) || !identifier(value.id) || value.type !== 'page') fail('contract-invalid');
  if (typeof value.isHidden !== 'boolean' || typeof value.isEffectivelyHidden !== 'boolean') fail('contract-invalid');
  if (value.contentType !== 'canvas' && value.contentType !== 'embed' && value.contentType !== 'syncPage')
    fail('contract-unsupported');
  if (value.name !== undefined && typeof value.name !== 'string') fail('contract-invalid');
  if (
    value.updatedAt !== undefined &&
    (typeof value.updatedAt !== 'string' ||
      value.updatedAt.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value.updatedAt) ||
      !Number.isFinite(Date.parse(value.updatedAt)))
  )
    fail('contract-invalid');
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : value.id,
    isHidden: value.isHidden,
    isEffectivelyHidden: value.isEffectivelyHidden,
    contentType: value.contentType,
    ...(typeof value.updatedAt === 'string' ? {updatedAt: value.updatedAt} : {}),
  };
}

function lineFrom(value: unknown): SuperhumanLine {
  if (!object(value) || !identifier(value.id) || value.type !== 'line') fail('contract-unsupported');
  if (value.itemContent === undefined) return {id: value.id};
  if (
    !object(value.itemContent) ||
    value.itemContent.format !== 'plainText' ||
    typeof value.itemContent.style !== 'string' ||
    typeof value.itemContent.content !== 'string'
  )
    fail('contract-unsupported');
  const level = value.itemContent.lineLevel;
  if (level !== undefined && (!Number.isSafeInteger(level) || (level as number) < 0)) fail('contract-invalid');
  return {
    id: value.id,
    style: value.itemContent.style,
    content: value.itemContent.content,
    ...(level === undefined ? {} : {lineLevel: level as number}),
  };
}

function pageResult(value: unknown): {items: unknown[]; next?: string} {
  if (!object(value) || !Array.isArray(value.items)) fail('contract-invalid');
  const token = value.nextPageToken;
  if (
    token !== undefined &&
    (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token) > CURSOR_LIMIT)
  )
    fail('contract-invalid');
  return {items: value.items, ...(token === undefined ? {} : {next: token})};
}

function allowedUrl(value: string, exactPath?: string, exactSearch?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('transport-rejected');
  }
  if (
    url.origin !== SUPERHUMAN_API_ORIGIN ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !url.pathname.startsWith('/apis/v1/') ||
    (exactPath !== undefined && url.pathname.replace(/\/$/, '') !== exactPath) ||
    (exactSearch !== undefined && url.search !== exactSearch)
  )
    fail('transport-rejected');
  return url;
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const now = Date.now();
  const maximumDelay = Math.max(0, 8_640_000_000_000_000 - now - 1);
  const seconds = Number(value);
  if (/^\d+$/.test(value.trim())) return Math.min(seconds * 1000, maximumDelay);
  const delay = Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, maximumDelay) : undefined;
}

function assertNoCredentialReflection(
  token: Redacted.Redacted<string>,
  documentId: string,
  pages: readonly SuperhumanPageContent[],
): void {
  const secret = Redacted.value(token);
  const cleaned = (value: string): string =>
    normalizeSuperhumanDisplayText(applyScrubber(value, {redact: true}).cleaned);
  const reflects = (value: string): boolean =>
    value.includes(secret) || normalizeSuperhumanDisplayText(value).includes(secret) || cleaned(value).includes(secret);
  if (reflects(documentId)) fail('credential-reflected');
  const content = pages.flatMap(({lines}) => lines.map(line => line.content ?? '')).join('');
  const normalizedContent = pages
    .flatMap(({lines}) => lines.map(line => normalizeSuperhumanDisplayText(line.content ?? '')))
    .join('');
  const cleanedContent = pages.flatMap(({lines}) => lines.map(line => cleaned(line.content ?? ''))).join('');
  if (reflects(content) || normalizedContent.includes(secret) || cleanedContent.includes(secret))
    fail('credential-reflected');
  for (const {page, lines} of pages) {
    if (
      [page.id, page.name, page.updatedAt ?? ''].some(reflects) ||
      normalizeSuperhumanTitle(page.name).includes(secret) ||
      normalizeSuperhumanTitle(cleaned(page.name)).includes(secret)
    )
      fail('credential-reflected');
    for (const line of lines) {
      if ([line.id, line.style ?? '', line.content ?? '', String(line.lineLevel ?? '')].some(reflects))
        fail('credential-reflected');
    }
  }
}

function bounded(value: number | undefined, maximum: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

export function createSuperhumanRestSession(token: Redacted.Redacted<string>, options: SuperhumanClientOptions = {}) {
  const secret = Redacted.value(token);
  if (!secret || /[\r\n]/.test(secret)) fail('authentication-rejected');
  const fetchImpl = options.fetch ?? fetch;
  const total = new AbortController();
  const abort = () => total.abort();
  options.signal?.addEventListener('abort', abort, {once: true});
  if (options.signal?.aborted) total.abort();
  const shared = options.budget;
  const remaining =
    shared === undefined
      ? bounded(options.totalTimeoutMilliseconds, 30_000)
      : Math.max(0, Math.min(bounded(options.totalTimeoutMilliseconds, 30_000), shared.deadlineAt - Date.now()));
  if (remaining === 0) total.abort();
  const totalTimer = setTimeout(abort, remaining);
  let requests = 0;
  let responseBytes = 0;
  const maxRequests = bounded(options.maxRequests ?? 16, 64);
  const get = async (href: string): Promise<unknown> => {
    let url = allowedUrl(href);
    const path = url.pathname.replace(/\/$/, '');
    const search = url.search;
    const seen = new Set<string>();
    for (let redirects = 0; redirects <= 2; redirects++) {
      if (total.signal.aborted || (shared && Date.now() >= shared.deadlineAt)) fail('deadline-exceeded');
      requests++;
      if (shared) shared.requests++;
      if (requests > maxRequests || (shared && shared.requests > shared.maxRequests)) fail('contract-incomplete');
      if (seen.has(url.href)) fail('transport-rejected');
      seen.add(url.href);
      const controller = new AbortController();
      const cancelRequest = () => controller.abort();
      total.signal.addEventListener('abort', cancelRequest, {once: true});
      if (total.signal.aborted) controller.abort();
      const timer = setTimeout(cancelRequest, bounded(options.requestTimeoutMilliseconds, 5_000));
      const deadline = Promise.withResolvers<never>();
      controller.signal.addEventListener(
        'abort',
        () => deadline.reject(new SuperhumanClientError({code: 'deadline-exceeded'})),
        {once: true},
      );
      if (controller.signal.aborted) deadline.reject(new SuperhumanClientError({code: 'deadline-exceeded'}));
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const pending = fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          headers: {Authorization: `Bearer ${secret}`, Accept: 'application/json'},
          signal: controller.signal,
        });
        void pending.then(
          response => {
            if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
          },
          () => undefined,
        );
        const response = await Promise.race([pending, deadline.promise]);
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          const location = response.headers.get('location');
          if (!location || redirects === 2) fail('transport-rejected');
          url = allowedUrl(new URL(location, url).href, path, search);
          continue;
        }
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined);
          if (response.status === 401) fail('authentication-rejected');
          if (response.status === 403) fail('access-rejected');
          if (response.status === 404) fail('not-found');
          if (response.status === 429) fail('quota-rejected', retryAfter(response.headers.get('retry-after')));
          fail('transport-rejected');
        }
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
          fail('transport-rejected');
        if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) fail('response-too-large');
        if (!response.body) fail('transport-rejected');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const part = await Promise.race([reader.read(), deadline.promise]);
          if (part.done) break;
          bytes += part.value.byteLength;
          responseBytes += part.value.byteLength;
          if (shared) shared.responseBytes += part.value.byteLength;
          if (
            bytes > RESPONSE_LIMIT ||
            responseBytes > TOTAL_LIMIT ||
            (shared && shared.responseBytes > shared.maxResponseBytes)
          )
            fail('response-too-large');
          chunks.push(part.value);
        }
        const joined = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(joined)) as unknown;
        } catch {
          return fail('contract-invalid');
        }
      } catch (error) {
        if (error instanceof SuperhumanClientError) throw error;
        if (controller.signal.aborted || total.signal.aborted) fail('deadline-exceeded');
        fail('transport-rejected');
      } finally {
        clearTimeout(timer);
        total.signal.removeEventListener('abort', cancelRequest);
        if (reader) void reader.cancel().catch(() => undefined);
      }
    }
    return fail('transport-rejected');
  };
  const listDetailed = async <T extends {id: string}>(
    path: string,
    convert: (raw: unknown) => T,
  ): Promise<{items: T[]; batches: number}> => {
    const items: T[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let batches = 0;
    do {
      const url = new URL(path, API_ROOT);
      if (cursor) {
        url.search = '';
        url.searchParams.set('pageToken', cursor);
      }
      const result = pageResult(await get(url.href));
      batches++;
      for (const raw of result.items) {
        const item = convert(raw);
        if (ids.has(item.id)) fail('contract-incomplete');
        ids.add(item.id);
        items.push(item);
      }
      cursor = result.next;
      if (cursor) {
        if (cursors.has(cursor)) fail('contract-incomplete');
        cursors.add(cursor);
      }
    } while (cursor);
    return {items, batches};
  };
  const list = async <T extends {id: string}>(path: string, convert: (raw: unknown) => T): Promise<T[]> =>
    (await listDetailed(path, convert)).items;
  return {
    get,
    list,
    listDetailed,
    get requests() {
      return requests;
    },
    get responseBytes() {
      return responseBytes;
    },
    close() {
      clearTimeout(totalTimer);
      options.signal?.removeEventListener('abort', abort);
      total.abort();
    },
  };
}

export async function readSuperhumanDocument(
  token: Redacted.Redacted<string>,
  documentId: string,
  selectedPageIds: readonly string[] | undefined,
  includeHidden: boolean,
  options: SuperhumanClientOptions = {},
): Promise<SuperhumanDocumentSnapshot> {
  validateIdentifier(documentId);
  if (selectedPageIds) for (const id of selectedPageIds) validateIdentifier(id);
  const session = createSuperhumanRestSession(token, options);
  const {get, list} = session;
  try {
    const base = `${API_ROOT}/docs/${documentId}/pages`;
    const inventory = await list(`${base}?limit=500`, pageFrom);
    const selected = selectedPageIds ? new Set(selectedPageIds) : undefined;
    const pages: SuperhumanPageContent[] = [];
    const excluded: Array<{pageId: string; reason: 'hidden' | 'unsupported' | 'not-selected'}> = [];
    for (const page of inventory) {
      if (selected && !selected.has(page.id)) {
        excluded.push({pageId: page.id, reason: 'not-selected'});
        continue;
      }
      if (!includeHidden && (page.isHidden || page.isEffectivelyHidden)) {
        excluded.push({pageId: page.id, reason: 'hidden'});
        continue;
      }
      if (page.contentType !== 'canvas') {
        excluded.push({pageId: page.id, reason: 'unsupported'});
        continue;
      }
      const latest = pageFrom(await get(`${base}/${page.id}`));
      if (JSON.stringify(latest) !== JSON.stringify(page)) fail('contract-incomplete');
      const lines = await list(`${base}/${page.id}/content?contentFormat=plainText&limit=500`, lineFrom);
      const after = pageFrom(await get(`${base}/${page.id}`));
      if (JSON.stringify(after) !== JSON.stringify(page)) fail('contract-incomplete');
      if (page.updatedAt === undefined) {
        const repeated = await list(`${base}/${page.id}/content?contentFormat=plainText&limit=500`, lineFrom);
        if (JSON.stringify(repeated) !== JSON.stringify(lines)) fail('contract-incomplete');
      }
      pages.push({page, lines});
    }
    const fence = await list(`${base}?limit=500`, pageFrom);
    if (JSON.stringify(fence) !== JSON.stringify(inventory)) fail('contract-incomplete');
    assertNoCredentialReflection(token, documentId, pages);
    return {
      documentId,
      pages,
      excluded,
      missingSelectedPageIds: selected ? [...selected].filter(id => !inventory.some(page => page.id === id)) : [],
      requests: session.requests,
      responseBytes: session.responseBytes,
    };
  } finally {
    session.close();
  }
}
