import {Data, Redacted} from 'effect';
import {applyScrubber} from '@threadnote/platform/scrubber';
import {
  MAX_SUPERHUMAN_MANAGER_LINKS,
  mergeResolvedSuperhumanSelections,
  retainedSuperhumanSelection,
} from './selection.js';
import type {ResolvedSuperhumanSelection} from './selection-contracts.js';
import {validateSuperhumanDocumentId, validateSuperhumanPageId, type SuperhumanDocumentConfig} from './config.js';
import {createSuperhumanRestSession, SUPERHUMAN_API_ORIGIN, type SuperhumanClientOptions} from './client.js';
import {normalizeSuperhumanTitle} from './render.js';
import {validSuperhumanApiToken} from './credentials.js';

const API_ROOT = `${SUPERHUMAN_API_ORIGIN}/apis/v1`;
const DOC_HREF = /^\/apis\/v1\/docs\/([A-Za-z0-9_-]{1,128})$/;
const PAGE_HREF = /^\/apis\/v1\/docs\/([A-Za-z0-9_-]{1,128})\/pages\/([A-Za-z0-9_-]{1,128})$/;

export class ManagerSuperhumanError extends Data.TaggedError('ManagerSuperhumanError')<{
  readonly status: number;
  readonly message: string;
}> {}

function invalid(message: string): never {
  throw new ManagerSuperhumanError({status: 400, message});
}
function conflict(message: string): never {
  throw new ManagerSuperhumanError({status: 409, message});
}
function browserLink(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048)
    invalid('Choose a valid Superhuman Docs link.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('Choose a valid Superhuman Docs link.');
  }
  if (
    url.origin !== SUPERHUMAN_API_ORIGIN ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !/^\/d\/[^/]+/.test(url.pathname) ||
    url.search
  )
    invalid('Choose a Superhuman Docs document link.');
  return url.href;
}

function safeName(value: unknown, secret: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > 2048) invalid('Superhuman returned an invalid link.');
  if (value.includes(secret) || normalizeSuperhumanTitle(value).includes(secret))
    conflict('Superhuman returned sensitive link metadata.');
  const cleaned = normalizeSuperhumanTitle(applyScrubber(value, {redact: true}).cleaned);
  if (cleaned.includes(secret)) conflict('Superhuman returned sensitive link metadata.');
  return cleaned.slice(0, 256) || fallback;
}

/** Optional artwork uses the provider's public asset origins, never the API credential. */
function iconUrl(value: unknown, secret: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const icon = value as Record<string, unknown>;
  if (
    typeof icon.type !== 'string' ||
    !/^image\/[a-z0-9.+-]{1,64}$/i.test(icon.type) ||
    typeof icon.browserLink !== 'string' ||
    icon.browserLink.length > 2048
  )
    return undefined;
  let url: URL;
  let decoded: string;
  try {
    url = new URL(icon.browserLink);
    decoded = decodeURIComponent(url.href);
  } catch {
    return undefined;
  }
  if (icon.browserLink.includes(secret) || decoded.includes(secret))
    conflict('Superhuman returned sensitive link metadata.');
  if (
    !['https://cdn.coda.io', 'https://codahosted.io'].includes(url.origin) ||
    url.username ||
    url.password ||
    url.hash
  )
    return undefined;
  return url.href;
}

function resolvedResource(response: unknown, token: Redacted.Redacted<string>) {
  if (!response || typeof response !== 'object' || Array.isArray(response))
    invalid('Superhuman returned an invalid link.');
  const wrapper = response as Record<string, unknown>;
  if (
    wrapper.type !== 'apiLink' ||
    !wrapper.resource ||
    typeof wrapper.resource !== 'object' ||
    Array.isArray(wrapper.resource)
  )
    invalid('Superhuman returned an unsupported link.');
  const resource = wrapper.resource as Record<string, unknown>;
  if (resource.type !== 'doc' && resource.type !== 'page') invalid('Superhuman returned an unsupported link.');
  if (typeof resource.href !== 'string' || resource.href.length > 2048) invalid('Superhuman returned an invalid link.');
  let href: URL;
  try {
    href = new URL(resource.href);
  } catch {
    return invalid('Superhuman returned an invalid link.');
  }
  if (
    href.origin !== SUPERHUMAN_API_ORIGIN ||
    href.protocol !== 'https:' ||
    href.username ||
    href.password ||
    href.search ||
    href.hash ||
    href.href !== `${href.origin}${href.pathname}`
  )
    invalid('Superhuman returned an out-of-scope link.');
  const match = resource.type === 'doc' ? DOC_HREF.exec(href.pathname) : PAGE_HREF.exec(href.pathname);
  if (!match || resource.id !== match[match.length - 1]) invalid('Superhuman returned an invalid link.');
  const secret = Redacted.value(token);
  if (match.some(part => part.includes(secret)) || String(resource.id).includes(secret))
    conflict('Superhuman returned sensitive link metadata.');
  return {
    documentId: match[1],
    ...(resource.type === 'page' ? {pageId: match[2]} : {}),
    name: safeName(resource.name, secret, resource.type === 'doc' ? 'Document' : 'Selected page'),
  };
}

/** Uses the fixed official GET client; URL IDs come only from validated API resources. */
export async function resolveSuperhumanBrowserLinks(
  links: readonly string[],
  token: Redacted.Redacted<string>,
  options: SuperhumanClientOptions = {},
): Promise<ResolvedSuperhumanSelection> {
  if (links.length < 1 || links.length > MAX_SUPERHUMAN_MANAGER_LINKS)
    invalid(`Choose 1 to ${MAX_SUPERHUMAN_MANAGER_LINKS} Superhuman Docs links.`);
  if (!validSuperhumanApiToken(token)) invalid('Provide a valid Superhuman Docs API token.');
  const urls = links.map(browserLink);
  const secret = Redacted.value(token);
  if (urls.some(url => url.includes(secret) || decodeURIComponent(url).includes(secret)))
    conflict('Superhuman returned sensitive link metadata.');
  const deadlineAt = Date.now() + Math.min(options.totalTimeoutMilliseconds ?? 30_000, 30_000);
  const session = createSuperhumanRestSession(token, {
    ...options,
    maxRequests: MAX_SUPERHUMAN_MANAGER_LINKS,
    totalTimeoutMilliseconds: Math.max(1, deadlineAt - Date.now()),
  });
  try {
    const selections: ResolvedSuperhumanSelection['selections'][number][] = [];
    for (const url of urls) {
      const resolve = new URL(`${API_ROOT}/resolveBrowserLink`);
      resolve.searchParams.set('url', url);
      selections.push({...resolvedResource(await session.get(resolve.href), token), browserLink: url});
    }
    const resolved = mergeResolvedSuperhumanSelections(selections);
    // resolveBrowserLink returns an API reference without its icon. Read the
    // selected metadata only, after deduplication, under the same deadline.
    const described = await readSelectionMetadata(resolved.selections, token, {
      ...options,
      totalTimeoutMilliseconds: Math.max(1, deadlineAt - Date.now()),
    });
    return {...resolved, selections: described};
  } finally {
    session.close();
  }
}

async function readSelectionMetadata(
  retained: ResolvedSuperhumanSelection['selections'],
  token: Redacted.Redacted<string>,
  options: SuperhumanClientOptions = {},
): Promise<ResolvedSuperhumanSelection['selections']> {
  const selections = [...retained];
  const session = createSuperhumanRestSession(token, {
    ...options,
    maxRequests: MAX_SUPERHUMAN_MANAGER_LINKS,
    totalTimeoutMilliseconds: Math.min(options.totalTimeoutMilliseconds ?? 10_000, 10_000),
  });
  try {
    for (let index = 0; index < Math.min(selections.length, MAX_SUPERHUMAN_MANAGER_LINKS); index++) {
      const item = selections[index];
      const documentId = validateSuperhumanDocumentId(item.documentId);
      const pageId = item.pageId === undefined ? undefined : validateSuperhumanPageId(item.pageId);
      const response = await session.get(`${API_ROOT}/docs/${documentId}${pageId ? `/pages/${pageId}` : ''}`);
      if (!response || typeof response !== 'object' || Array.isArray(response))
        invalid('Superhuman returned invalid selection metadata.');
      const resource = response as Record<string, unknown>;
      if (resource.type !== (pageId === undefined ? 'doc' : 'page') || resource.id !== (pageId ?? documentId))
        invalid('Superhuman returned invalid selection metadata.');
      const secret = Redacted.value(token);
      let link: string | undefined;
      if (resource.browserLink !== undefined) {
        if (typeof resource.browserLink !== 'string') invalid('Superhuman returned an invalid link.');
        let url: URL;
        try {
          url = new URL(resource.browserLink);
        } catch {
          return invalid('Superhuman returned an invalid link.');
        }
        // The official schema still includes legacy coda.io browser links.
        if (url.origin === 'https://coda.io') url.hostname = 'docs.superhuman.com';
        link = browserLink(url.href);
        if (link.includes(secret) || decodeURIComponent(link).includes(secret))
          conflict('Superhuman returned sensitive link metadata.');
      }
      const artwork = iconUrl(resource.icon, secret);
      selections[index] = {
        ...item,
        name: safeName(resource.name, secret, item.name),
        ...(link === undefined ? {} : {browserLink: link}),
        ...(artwork === undefined ? {} : {iconUrl: artwork}),
      };
    }
    return selections;
  } finally {
    session.close();
  }
}

/** Metadata-only reads for the saved allowlist, with a bounded request budget. */
export async function describeSuperhumanSelection(
  documents: readonly SuperhumanDocumentConfig[],
  token: Redacted.Redacted<string>,
  options: SuperhumanClientOptions = {},
): Promise<ResolvedSuperhumanSelection> {
  const retained = retainedSuperhumanSelection(documents);
  return {...retained, selections: await readSelectionMetadata(retained.selections, token, options)};
}
