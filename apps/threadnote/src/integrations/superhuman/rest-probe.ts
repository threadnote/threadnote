import {Data, Redacted} from 'effect';
import {createSuperhumanRestSession, SuperhumanClientError} from './client.js';

export const SUPERHUMAN_REST_URL = 'https://docs.superhuman.com/apis/v1';

const ORIGIN = 'https://docs.superhuman.com';
const MAX_REQUESTS = 16;

export type RestProbeErrorCode =
  | 'missing-input'
  | 'invalid-selected-url'
  | 'authentication-rejected'
  | 'access-rejected'
  | 'not-found'
  | 'quota-rejected'
  | 'transport-rejected'
  | 'response-too-large'
  | 'contract-invalid'
  | 'contract-incomplete'
  | 'contract-unsupported'
  | 'scope-mismatch'
  | 'deadline-exceeded';

export class RestProbeError extends Data.TaggedError('RestProbeError')<{readonly code: RestProbeErrorCode}> {}

export interface RestProbeOptions {
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly expectedDocumentId?: string;
  readonly requestTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export interface RestProbeSummary {
  readonly endpoint: typeof SUPERHUMAN_REST_URL;
  readonly requests: number;
  readonly responseBytes: number;
  readonly resolution: {readonly pageResource: true; readonly stableIdMatch: true};
  readonly page: {
    readonly canvas: true;
    readonly hidden: boolean;
    readonly effectivelyHidden: boolean;
    readonly hasUpdatedAt: boolean;
    readonly hasParent: boolean;
  };
  readonly inventory: {
    readonly complete: true;
    readonly pages: number;
    readonly batches: number;
    readonly selectedIncluded: true;
    readonly hiddenPages: number;
    readonly metadataMatches: boolean;
  };
  readonly content: {
    readonly complete: true;
    readonly items: number;
    readonly fullBatches: number;
    readonly smallBatches: number;
    readonly orderedEqual: boolean;
    readonly itemsWithoutText: number;
  };
}

interface Page {
  readonly id: string;
  readonly hidden: boolean;
  readonly effectivelyHidden: boolean;
  readonly contentType: string;
  readonly hasUpdatedAt: boolean;
  readonly hasParent: boolean;
}

interface ContentItem {
  readonly id: string;
  readonly style?: string;
  readonly content?: string;
  readonly level?: number;
}

function fail(code: RestProbeErrorCode): never {
  throw new RestProbeError({code});
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function opaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function selectedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('invalid-selected-url');
  }
  if (
    url.origin !== ORIGIN ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/d\/[^/]+\/[^/]+\/?$/.test(url.pathname) ||
    url.search ||
    (url.hash !== '' && !url.hash.startsWith('#_'))
  )
    return fail('invalid-selected-url');
  url.hash = '';
  return url;
}

function responseUrl(path: string): URL {
  let url: URL;
  try {
    url = new URL(path, SUPERHUMAN_REST_URL);
  } catch {
    return fail('transport-rejected');
  }
  if (
    url.origin !== ORIGIN ||
    url.username ||
    url.password ||
    url.port ||
    !url.pathname.startsWith('/apis/v1/') ||
    url.hash
  )
    return fail('transport-rejected');
  return url;
}

function pageFrom(value: unknown): Page {
  if (!record(value) || !opaqueId(value.id) || value.type !== 'page') return fail('contract-invalid');
  if (typeof value.isHidden !== 'boolean' || typeof value.isEffectivelyHidden !== 'boolean')
    return fail('contract-invalid');
  if (!['canvas', 'embed', 'syncPage'].includes(String(value.contentType))) return fail('contract-invalid');
  if (value.updatedAt !== undefined && typeof value.updatedAt !== 'string') return fail('contract-invalid');
  if (value.parent !== undefined && (!record(value.parent) || !opaqueId(value.parent.id)))
    return fail('contract-invalid');
  return {
    id: value.id,
    hidden: value.isHidden,
    effectivelyHidden: value.isEffectivelyHidden,
    contentType: value.contentType as string,
    hasUpdatedAt: value.updatedAt !== undefined,
    hasParent: value.parent !== undefined,
  };
}

function contentFrom(value: unknown): ContentItem {
  if (!record(value) || !opaqueId(value.id) || value.type !== 'line') return fail('contract-invalid');
  if (value.itemContent === undefined) return {id: value.id};
  const detail = value.itemContent;
  if (
    !record(detail) ||
    detail.format !== 'plainText' ||
    typeof detail.content !== 'string' ||
    typeof detail.style !== 'string'
  )
    return fail('contract-invalid');
  if (detail.lineLevel !== undefined && (!Number.isSafeInteger(detail.lineLevel) || (detail.lineLevel as number) < 0))
    return fail('contract-invalid');
  return {
    id: value.id,
    style: detail.style,
    content: detail.content,
    ...(detail.lineLevel === undefined ? {} : {level: detail.lineLevel as number}),
  };
}

export async function probeSuperhumanRestPage(
  token: Redacted.Redacted<string>,
  browserUrl: string,
  options: RestProbeOptions = {},
): Promise<RestProbeSummary> {
  const secret = Redacted.value(token);
  if (!secret || /[\r\n]/.test(secret)) return fail('missing-input');
  const selected = selectedUrl(browserUrl);
  if (options.expectedDocumentId !== undefined && !opaqueId(options.expectedDocumentId))
    return fail('invalid-selected-url');
  const session = createSuperhumanRestSession(token, {
    fetch: options.fetch,
    signal: options.signal,
    requestTimeoutMilliseconds: options.requestTimeoutMs,
    totalTimeoutMilliseconds: options.totalTimeoutMs,
    maxRequests: MAX_REQUESTS,
  });
  const get = session.get;
  const list = session.listDetailed;
  try {
    const resolve = new URL(`${SUPERHUMAN_REST_URL}/resolveBrowserLink`);
    resolve.searchParams.set('url', selected.href);
    const resolved = await get(resolve.href);
    if (
      !record(resolved) ||
      resolved.type !== 'apiLink' ||
      !record(resolved.resource) ||
      resolved.resource.type !== 'page'
    )
      return fail('contract-unsupported');
    const resource = resolved.resource;
    if (!opaqueId(resource.id) || typeof resource.href !== 'string') return fail('contract-invalid');
    const ref = responseUrl(resource.href);
    const match = /^\/apis\/v1\/docs\/([A-Za-z0-9_-]{1,128})\/pages\/([A-Za-z0-9_-]{1,128})$/.exec(ref.pathname);
    if (!match || ref.search || match[2] !== resource.id) return fail('contract-invalid');
    const docId = match[1];
    const pageId = match[2];
    if (options.expectedDocumentId !== undefined && docId !== options.expectedDocumentId) return fail('scope-mismatch');
    const prefix = `${SUPERHUMAN_REST_URL}/docs/${docId}/pages`;
    const page = pageFrom(await get(`${prefix}/${pageId}`));
    if (page.id !== pageId) return fail('contract-invalid');
    if (page.contentType !== 'canvas') return fail('contract-unsupported');
    const inventory = await list(`${prefix}?limit=2`, pageFrom);
    const selectedInventory = inventory.items.find(item => item.id === pageId);
    if (!selectedInventory) return fail('contract-incomplete');
    const contentPath = `${prefix}/${pageId}/content`;
    const full = await list(`${contentPath}?limit=500&contentFormat=plainText`, contentFrom);
    const small = await list(`${contentPath}?limit=1&contentFormat=plainText`, contentFrom);
    const orderedEqual =
      full.items.length === small.items.length &&
      full.items.every((item, index) => {
        const other = small.items[index];
        return (
          other?.id === item.id &&
          other.content === item.content &&
          other.style === item.style &&
          other.level === item.level
        );
      });
    return {
      endpoint: SUPERHUMAN_REST_URL,
      requests: session.requests,
      responseBytes: session.responseBytes,
      resolution: {pageResource: true, stableIdMatch: true},
      page: {
        canvas: true,
        hidden: page.hidden,
        effectivelyHidden: page.effectivelyHidden,
        hasUpdatedAt: page.hasUpdatedAt,
        hasParent: page.hasParent,
      },
      inventory: {
        complete: true,
        pages: inventory.items.length,
        batches: inventory.batches,
        selectedIncluded: true,
        hiddenPages: inventory.items.filter(item => item.hidden).length,
        metadataMatches:
          selectedInventory.hidden === page.hidden && selectedInventory.effectivelyHidden === page.effectivelyHidden,
      },
      content: {
        complete: true,
        items: full.items.length,
        fullBatches: full.batches,
        smallBatches: small.batches,
        orderedEqual,
        itemsWithoutText: full.items.filter(item => item.content === undefined).length,
      },
    };
  } catch (error) {
    if (error instanceof SuperhumanClientError)
      throw new RestProbeError({code: error.code === 'credential-reflected' ? 'contract-invalid' : error.code});
    throw error;
  } finally {
    session.close();
  }
}
