import {isSuperhumanSource} from './config.js';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {describeSuperhumanSelection, resolveSuperhumanBrowserLinks, ManagerSuperhumanError} from './links.js';
export {describeSuperhumanSelection, resolveSuperhumanBrowserLinks} from './links.js';
export {mergeResolvedSuperhumanSelections} from './selection.js';
import {Cause, Clock, Effect, Redacted, Schema} from 'effect';
import type {IntegrationResult} from '@threadnote/integration-core/manager-contracts';
import type {SuperhumanSource} from './manager-contracts.js';
import {readExternalDocumentManifest, readExternalSourceReceipt} from '@threadnote/store/external-resource';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  mutateSourceConfiguration,
  readSourceConfiguration,
  requireSuperhumanSource,
  sourceConfigurationFingerprint,
  upsertSuperhumanSource,
  validateSourceIdentifier,
  validateSuperhumanDocumentId,
  validateSuperhumanPageId,
  type SuperhumanDocumentConfig,
  type SuperhumanSourceConfig,
} from './config.js';
import {captureIntegrationConsole as captureConsole} from '@threadnote/integration-core/manager-http';
import {withSourceLock} from '@threadnote/integration-core/lock';
import {SuperhumanClientError} from './client.js';
import {
  runSuperhumanSourceAdd,
  runSuperhumanSourceRemove,
  runSuperhumanSourceSync,
  SuperhumanSourceConflictError,
} from './source.js';
import {resolveSuperhumanCredential, superhumanCredentialConfigured, SuperhumanCredentialError} from './credentials.js';
import type {ManagerIntegrationApiRequest} from '@threadnote/integration-core/manager-http';

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
  return identifier(value, 'source name', value => validateSourceIdentifier(value, 'source name'));
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
    if (!isSuperhumanSource(source)) continue;
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

const route = Effect.fn('manager.superhumanRoute')(function* (request: ManagerIntegrationApiRequest) {
  if (request.url.pathname !== '/api/integrations/superhuman') return undefined;
  if (request.method === 'GET') return {status: 200, body: yield* listSuperhumanIntegrations(request.config)};
  if (request.method !== 'POST') return {status: 405, body: {error: 'Method not allowed'}};
  const body = yield* request.body;
  if (typeof body.action !== 'string') invalid('Choose a Superhuman action.');
  const action = body.action;
  if (action === 'describe-selection') {
    const source = requireSuperhumanSource(yield* readSourceConfiguration(request.config), sourceId(body.id));
    const token = yield* resolveSuperhumanCredential(request.config, source);
    const selection = yield* fromPromiseInterruptible(
      signal => describeSuperhumanSelection(source.documents, token, {signal}),
      error =>
        error instanceof ManagerSuperhumanError || error instanceof SuperhumanClientError
          ? error
          : new ManagerSuperhumanError({status: 409, message: 'Superhuman could not load the saved selection titles.'}),
    );
    return {status: 200, body: selection};
  }
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
    const resolved = yield* fromPromiseInterruptible(
      signal => resolveSuperhumanBrowserLinks(body.links as string[], token, {signal}),
      error =>
        error instanceof ManagerSuperhumanError || error instanceof SuperhumanClientError
          ? error
          : new ManagerSuperhumanError({status: 409, message: 'Superhuman could not resolve the selected links.'}),
    );
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
          if (existing && !isSuperhumanSource(existing)) conflict('Another connection already uses this name.');
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
            credentialEnv:
              env ?? (existing !== undefined && isSuperhumanSource(existing) ? existing.credentialEnv : undefined),
            credentialStorage:
              token ||
              (env === undefined &&
                existing !== undefined &&
                isSuperhumanSource(existing) &&
                existing.credentialStorage === 'local')
                ? 'local'
                : undefined,
            apiToken: token,
            enabled: existing !== undefined && isSuperhumanSource(existing) ? existing.enabled : true,
            expectedFingerprint:
              existing !== undefined && isSuperhumanSource(existing) ? sourceConfigurationFingerprint(existing) : null,
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

export const handleManagerSuperhumanIntegrationRequest = (request: ManagerIntegrationApiRequest) =>
  route(request).pipe(Effect.catchCause(cause => Effect.succeed(safeErrorResponse(Cause.squash(cause)))));
