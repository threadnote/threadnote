import {Cause, Clock, Data, Effect, Redacted, Schema} from 'effect';
import {applyScrubber} from '@threadnote/platform/scrubber';
import type {
  IntegrationResult,
  ResolvedSuperhumanSelection,
  SuperhumanSource,
} from '@threadnote/manager/integrations-contracts';
import {readExternalDocumentManifest, readExternalSourceReceipt} from '@threadnote/store/external-resource';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  mutateSourceConfiguration,
  readSourceConfiguration,
  requireSuperhumanSource,
  sourceConfigurationFingerprint,
  upsertSuperhumanSource,
  validateObsidianIdentifier,
  validateSuperhumanDocumentId,
  validateSuperhumanPageId,
  type SuperhumanDocumentConfig,
  type SuperhumanSourceConfig,
} from '../obsidian/config.js';
import {captureConsole} from '../effect/console.js';
import {withSourceLock} from '../sources/lock.js';
import {
  createSuperhumanRestSession,
  SuperhumanClientError,
  SUPERHUMAN_API_ORIGIN,
  type SuperhumanClientOptions,
} from '../superhuman/client.js';
import {normalizeSuperhumanTitle} from '../superhuman/render.js';
import {
  runSuperhumanSourceAdd,
  runSuperhumanSourceRemove,
  runSuperhumanSourceSync,
  SuperhumanSourceConflictError,
} from '../superhuman/source.js';
import {
  resolveSuperhumanCredential,
  superhumanCredentialConfigured,
  validSuperhumanApiToken,
  SuperhumanCredentialError,
} from '../superhuman/credentials.js';
import type {ManagerProcessApiRequest} from './processes.js';

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

function identifier(value: unknown, label: string, validate: (value: string) => string): string {
  if (typeof value !== 'string') invalid(`Choose a valid ${label}.`);
  try {
    return validate(value);
  } catch {
    return invalid(`Choose a valid ${label}.`);
  }
}

function sourceId(value: unknown): string {
  return identifier(value, 'source name', value => validateObsidianIdentifier(value, 'source name'));
}

function credentialEnv(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value))
    invalid('Choose a valid credential environment variable name.');
  return value;
}

function environmentToken(config: RuntimeConfig, name: string) {
  const source: SuperhumanSourceConfig = {
    type: 'superhuman',
    id: 'manager-resolver',
    enabled: true,
    credentialEnv: name,
    project: null,
    documents: [],
    includeHidden: false,
    refreshIntervalMinutes: 15,
    maxStaleHours: 24,
  };
  return resolveSuperhumanCredential(config, source).pipe(
    Effect.mapError(
      () => new ManagerSuperhumanError({status: 400, message: 'The selected environment credential is unavailable.'}),
    ),
  );
}

function selectedDocuments(value: unknown): readonly SuperhumanDocumentConfig[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) invalid('Choose 1 to 64 Superhuman documents.');
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Choose valid Superhuman documents.');
    const document = item as Record<string, unknown>;
    const id = identifier(document.id, 'document ID', validateSuperhumanDocumentId);
    if (seen.has(id)) invalid('Each Superhuman document must be selected once.');
    seen.add(id);
    if (document.pages === undefined) return {id};
    if (!Array.isArray(document.pages) || document.pages.length < 1 || document.pages.length > 256)
      invalid('Choose 1 to 256 pages, or select the whole document.');
    const pages = document.pages.map(page => identifier(page, 'page ID', validateSuperhumanPageId));
    if (new Set(pages).size !== pages.length) invalid('Each Superhuman page must be selected once.');
    return {id, pages};
  });
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
  if (links.length < 1 || links.length > 16) invalid('Choose 1 to 16 Superhuman Docs links.');
  if (!validSuperhumanApiToken(token)) invalid('Provide a valid Superhuman Docs API token.');
  const urls = links.map(browserLink);
  const session = createSuperhumanRestSession(token, {...options, maxRequests: 16});
  try {
    const selections: ResolvedSuperhumanSelection['selections'][number][] = [];
    for (const url of urls) {
      const resolve = new URL(`${API_ROOT}/resolveBrowserLink`);
      resolve.searchParams.set('url', url);
      selections.push(resolvedResource(await session.get(resolve.href), token));
    }
    return mergeResolvedSuperhumanSelections(selections);
  } finally {
    session.close();
  }
}

export function mergeResolvedSuperhumanSelections(
  selections: ResolvedSuperhumanSelection['selections'],
): ResolvedSuperhumanSelection {
  const byDocument = new Map<string, Set<string> | null>();
  for (const selection of selections) {
    const previous = byDocument.get(selection.documentId);
    if (selection.pageId === undefined) byDocument.set(selection.documentId, null);
    else if (previous !== null) byDocument.set(selection.documentId, (previous ?? new Set()).add(selection.pageId));
  }
  const documents = [...byDocument]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, pages]) => (pages === null ? {id} : {id, pages: [...pages].sort()}));
  const bySelection = new Map<string, ResolvedSuperhumanSelection['selections'][number]>();
  for (const selection of selections) {
    if (byDocument.get(selection.documentId) === null && selection.pageId !== undefined) continue;
    const key = `${selection.documentId}\0${selection.pageId ?? ''}`;
    const previous = bySelection.get(key);
    if (!previous || selection.name.localeCompare(previous.name) < 0) bySelection.set(key, selection);
  }
  return {
    documents,
    selections: [...bySelection].sort(([left], [right]) => left.localeCompare(right)).map(([, selection]) => selection),
  };
}

function safeErrorResponse(error: unknown) {
  if (Schema.is(SuperhumanSourceConflictError)(error))
    return {status: 409, body: {error: 'This connection changed. Refresh connections before saving.'}};
  if (Schema.is(SuperhumanCredentialError)(error)) return {status: 409, body: {error: error.message}};
  if (error instanceof ManagerSuperhumanError) return {status: error.status, body: {error: error.message}};
  if (error instanceof SuperhumanClientError) {
    const errors: Partial<Record<SuperhumanClientError['code'], string>> = {
      'authentication-rejected': 'Superhuman rejected the credential.',
      'access-rejected': 'Superhuman denied access to the selected document.',
      'not-found': 'The selected Superhuman document was not found.',
      'quota-rejected': 'Superhuman asked Threadnote to retry later.',
      'credential-reflected': 'Superhuman returned sensitive metadata.',
    };
    return {
      status: error.code === 'authentication-rejected' ? 401 : 409,
      body: {error: errors[error.code] ?? 'Superhuman could not complete the request.'},
    };
  }
  return {status: 409, body: {error: 'The Superhuman connection could not complete this action.'}};
}

export const listSuperhumanIntegrations = Effect.fn('manager.superhumanList')(function* (config: RuntimeConfig) {
  const configuration = yield* readSourceConfiguration(config);
  const sources: SuperhumanSource[] = [];
  for (const source of configuration.sources) {
    if (source.type !== 'superhuman') continue;
    const credentialConfigured = yield* superhumanCredentialConfigured(config, source);
    const fingerprint = sourceConfigurationFingerprint(source);
    const location = {account: config.account, home: config.agentContextHome, user: config.user};
    const receipt = yield* readExternalSourceReceipt(location, source.id);
    const now = yield* Clock.currentTimeMillis;
    let chunks = 0;
    let lastSyncedAt: number | undefined;
    let nextAttemptAt: number | undefined;
    let complete =
      source.documents.length > 0 &&
      source.enabled &&
      credentialConfigured &&
      receipt !== null &&
      receipt?.status !== 'cleanup';
    let attention =
      !credentialConfigured ||
      receipt === null ||
      receipt?.status === 'authentication-rejected' ||
      receipt?.status === 'cleanup';
    for (const document of source.documents) {
      const manifest = yield* readExternalDocumentManifest(location, source.id, document.id);
      const currentReceipt =
        manifest?.configFingerprint === fingerprint && manifest.accessEpoch === receipt?.accessEpoch;
      if (currentReceipt && manifest?.nextAttemptAt !== undefined && manifest.nextAttemptAt > now)
        nextAttemptAt = Math.max(nextAttemptAt ?? 0, manifest.nextAttemptAt);
      const eligible =
        manifest?.status === 'active' &&
        currentReceipt &&
        source.enabled &&
        now >= manifest.fetchedAt &&
        now - manifest.fetchedAt <= Math.min(manifest.maxStaleMilliseconds, source.maxStaleHours * 3_600_000);
      if (!eligible) {
        complete = false;
        if (manifest?.status === 'quarantined' || manifest?.status === 'pending') attention = true;
        continue;
      }
      chunks += Object.keys(manifest.chunks).length;
      lastSyncedAt = Math.max(lastSyncedAt ?? 0, manifest.fetchedAt);
    }
    sources.push({
      id: source.id,
      enabled: source.enabled,
      project: source.project,
      documents: source.documents,
      credentialEnv: source.credentialEnv,
      ...(source.credentialStorage === undefined ? {} : {credentialStorage: source.credentialStorage}),
      credentialConfigured,
      includeHidden: source.includeHidden,
      refreshIntervalMinutes: source.refreshIntervalMinutes,
      maxStaleHours: source.maxStaleHours,
      status: complete ? 'active' : attention ? 'needs-attention' : 'needs-sync',
      chunks,
      ...(lastSyncedAt === undefined ? {} : {lastSyncedAt}),
      ...(nextAttemptAt === undefined ? {} : {nextAttemptAt}),
    });
  }
  return {sources};
});

const route = Effect.fn('manager.superhumanRoute')(function* (request: ManagerProcessApiRequest) {
  if (request.url.pathname !== '/api/integrations/superhuman') return undefined;
  if (request.method === 'GET') return {status: 200, body: yield* listSuperhumanIntegrations(request.config)};
  if (request.method !== 'POST') return {status: 405, body: {error: 'Method not allowed'}};
  const body = yield* request.body;
  if (typeof body.action !== 'string') invalid('Choose a Superhuman action.');
  const action = body.action;
  if (action === 'resolve-links') {
    if (!Array.isArray(body.links) || !body.links.every(link => typeof link === 'string'))
      invalid('Choose Superhuman Docs links.');
    const env = credentialEnv(body.credentialEnv);
    const suppliedToken =
      typeof body.token === 'string' && body.token.length > 0 ? Redacted.make(body.token) : undefined;
    if (suppliedToken && env) invalid('Choose a token or an environment credential.');
    const token =
      suppliedToken ??
      (env
        ? yield* environmentToken(request.config, env)
        : yield* resolveSuperhumanCredential(
            request.config,
            requireSuperhumanSource(yield* readSourceConfiguration(request.config), sourceId(body.id)),
          ));
    const resolved = yield* Effect.tryPromise({
      try: signal => resolveSuperhumanBrowserLinks(body.links as string[], token, {signal}),
      catch: error =>
        error instanceof ManagerSuperhumanError || error instanceof SuperhumanClientError
          ? error
          : new ManagerSuperhumanError({status: 409, message: 'Superhuman could not resolve the selected links.'}),
    });
    return {status: 200, body: resolved};
  }
  const id = sourceId(body.id);
  const apply = body.apply === true;
  if (apply && body.confirm !== true) invalid('Confirm this Superhuman action.');
  const result = yield* captureConsole(
    Effect.gen(function* () {
      switch (action) {
        case 'save-source': {
          const configuration = yield* readSourceConfiguration(request.config);
          const existing = configuration.sources.find(source => source.id === id);
          if (existing?.type === 'obsidian') conflict('Another connection already uses this name.');
          if (!!existing !== (body.editing === true))
            conflict(existing ? 'Open this source to edit it.' : 'This source no longer exists. Refresh connections.');
          const documents = selectedDocuments(body.documents);
          const token = typeof body.token === 'string' && body.token.length > 0 ? Redacted.make(body.token) : undefined;
          const env = credentialEnv(body.credentialEnv);
          if (token && env) invalid('Choose a token or an environment credential.');
          if (!existing && !token && !env) invalid('Provide a Superhuman Docs API token or environment credential.');
          if (env) yield* environmentToken(request.config, env);
          if (body.project !== null && typeof body.project !== 'string')
            invalid('Choose a project or projectless source.');
          if (
            typeof body.includeHidden !== 'boolean' ||
            !Number.isSafeInteger(body.refreshIntervalMinutes) ||
            !Number.isSafeInteger(body.maxStaleHours)
          )
            invalid('Choose valid Superhuman source settings.');
          yield* runSuperhumanSourceAdd(request.config, {
            id,
            apply,
            documents: documents.map(document => document.id),
            documentSelection: documents,
            project: body.project ?? undefined,
            projectless: body.project === null,
            includeHidden: body.includeHidden,
            refreshIntervalMinutes: body.refreshIntervalMinutes as number,
            maxStaleHours: body.maxStaleHours as number,
            credentialEnv: env ?? (existing?.type === 'superhuman' ? existing.credentialEnv : undefined),
            credentialStorage:
              token || (env === undefined && existing?.type === 'superhuman' && existing.credentialStorage === 'local')
                ? 'local'
                : undefined,
            apiToken: token,
            enabled: existing?.type === 'superhuman' ? existing.enabled : true,
            expectedFingerprint: existing?.type === 'superhuman' ? sourceConfigurationFingerprint(existing) : null,
          });
          return {
            output: apply ? 'Superhuman source settings saved.' : 'Superhuman source settings are ready to save.',
          };
        }
        case 'sync-source': {
          const synced = yield* runSuperhumanSourceSync(request.config, {id, apply});
          return {
            output: apply
              ? `${synced.syncedDocuments.length} selected document(s) refreshed.`
              : 'Superhuman source is ready to refresh.',
            warnings: synced.warnings.map(() => 'A selected document could not be refreshed.'),
          };
        }
        case 'set-enabled': {
          if (typeof body.enabled !== 'boolean') invalid('Choose whether this source is enabled.');
          const enabled = body.enabled;
          if (apply) {
            yield* withSourceLock(
              request.config,
              id,
              mutateSourceConfiguration(request.config, current =>
                upsertSuperhumanSource(current, {...requireSuperhumanSource(current, id), enabled}),
              ),
            );
          } else {
            const current = yield* readSourceConfiguration(request.config);
            upsertSuperhumanSource(current, {...requireSuperhumanSource(current, id), enabled});
          }
          return {
            output: apply ? 'Superhuman source setting updated.' : 'Superhuman source setting is ready to update.',
          };
        }
        case 'remove-source':
          yield* runSuperhumanSourceRemove(request.config, {id, apply});
          return {output: apply ? 'Superhuman source removed.' : 'Superhuman source is ready to remove.'};
        default:
          return invalid('Unknown Superhuman action.');
      }
    }),
  );
  const response: IntegrationResult = {applied: apply, entries: [], ...result.value};
  return {status: 200, body: response};
});

export const handleManagerSuperhumanIntegrationRequest = (request: ManagerProcessApiRequest) =>
  route(request).pipe(Effect.catchCause(cause => Effect.succeed(safeErrorResponse(Cause.squash(cause)))));
