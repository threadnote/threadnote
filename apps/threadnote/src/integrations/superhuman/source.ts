import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {Clock, Console, DateTime, Effect, Random, Redacted, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceStore, type ResourceStoreMutation} from '@threadnote/store/resource-store';
import {
  externalDocumentManifestUri,
  externalResourceUri,
  externalSourceReceiptUri,
  readExternalDocumentManifest,
  readExternalSourceReceipt,
  renderExternalResource,
  serializeExternalDocumentManifest,
  serializeExternalSourceReceipt,
  type ExternalDocumentManifest,
  type ExternalSourceReceipt,
} from '@threadnote/store/external-resource';
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
  validateSuperhumanSourceConfig,
  type SuperhumanDocumentConfig,
  type SourceConfig,
  type SuperhumanSourceConfig,
} from '../config.js';
import {withSourceLock} from '../lock.js';
import {
  makeSuperhumanClientBudget,
  readSuperhumanDocument,
  SuperhumanClientError,
  type SuperhumanClientBudget,
  type SuperhumanClientOptions,
} from './client.js';
import {
  renderSuperhumanDocument,
  SuperhumanSecretBlocked,
  SUPERHUMAN_RENDERER_VERSION,
  SUPERHUMAN_SCRUBBER_VERSION,
} from './render.js';
import {
  removeSuperhumanCredential,
  resolveSuperhumanCredential,
  storeSuperhumanCredential,
  validSuperhumanApiToken,
} from './credentials.js';

export interface SuperhumanSourceAddOptions {
  readonly id: string;
  readonly apply?: boolean;
  readonly documents: readonly string[];
  readonly documentSelection?: readonly SuperhumanDocumentConfig[];
  readonly apiToken?: Redacted.Redacted<string>;
  readonly credentialStorage?: 'local';
  readonly enabled?: boolean;
  readonly expectedFingerprint?: string | null;
  readonly pages?: readonly string[];
  readonly credentialEnv?: string;
  readonly project?: string;
  readonly projectless?: boolean;
  readonly includeHidden?: boolean;
  readonly refreshIntervalMinutes?: number;
  readonly maxStaleHours?: number;
}

export interface SuperhumanSourceCommandOptions {
  readonly id: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly clientOptions?: SuperhumanClientOptions;
}

export interface SuperhumanInventoryEntry {
  readonly documentId: string;
  readonly status: 'missing' | 'active' | 'quarantined' | 'pending' | 'stale';
  readonly chunks: number;
  readonly nextAttemptAt?: number;
}

export interface SuperhumanInventory {
  readonly source: SuperhumanSourceConfig;
  readonly entries: readonly SuperhumanInventoryEntry[];
}

export interface SuperhumanSyncResult {
  readonly sourceId: string;
  readonly syncedDocuments: readonly string[];
  readonly warnings: readonly string[];
}

class SuperhumanSourceError extends Schema.TaggedError<SuperhumanSourceError>()('SuperhumanSourceError', {
  message: Schema.String,
}) {}

export class SuperhumanSourceConflictError extends Schema.TaggedError<SuperhumanSourceConflictError>()(
  'SuperhumanSourceConflictError',
  {},
) {}

function location(config: RuntimeConfig) {
  return {account: config.account, home: config.agentContextHome, user: config.user};
}

function rootUri(sourceId: string): string {
  return `threadnote://resources/external/superhuman/${sourceId}`;
}

function safeError(message: string) {
  return SuperhumanSourceError.make({message});
}

const configFence = Effect.fn('superhuman.configFence')(function* (
  config: RuntimeConfig,
  sourceId: string,
  fingerprint: string,
  requireEnabled = true,
) {
  const source = (yield* readSourceConfiguration(config)).sources.find(item => item.id === sourceId);
  if (
    !source ||
    source.type !== 'superhuman' ||
    (requireEnabled && !source.enabled) ||
    sourceConfigurationFingerprint(source) !== fingerprint
  ) {
    return yield* safeError('Superhuman source configuration changed during refresh.');
  }
});

const fetchDocument = Effect.fn('superhuman.fetchDocument')(function* (
  config: RuntimeConfig,
  source: SuperhumanSourceConfig,
  document: SuperhumanSourceConfig['documents'][number],
  options: SuperhumanClientOptions,
) {
  const token = yield* resolveSuperhumanCredential(config, source);
  return yield* fromPromiseInterruptible(
    signal => readSuperhumanDocument(token, document.id, document.pages, source.includeHidden, {...options, signal}),
    error => (error instanceof SuperhumanClientError ? error : safeError('Superhuman provider refresh failed.')),
  );
});

function containsCredential(value: unknown, token: string): boolean {
  if (typeof value === 'string') return value.includes(token);
  if (Array.isArray(value)) return value.some(item => containsCredential(item, token));
  return (
    typeof value === 'object' && value !== null && Object.values(value).some(item => containsCredential(item, token))
  );
}

const checkCredentialReflection = Effect.fn('superhuman.checkCredentialReflection')(function* (
  value: unknown,
  token: Redacted.Redacted<string>,
) {
  if (containsCredential(value, Redacted.value(token)))
    return yield* safeError('Superhuman source configuration contains credential material.');
});

function isDenied(error: unknown): boolean {
  return (
    error instanceof SuperhumanClientError &&
    (error.code === 'authentication-rejected' || error.code === 'access-rejected' || error.code === 'not-found')
  );
}

function warningCode(error: unknown): string {
  if (error instanceof SuperhumanClientError) return error.code;
  if (error instanceof SuperhumanSecretBlocked) return 'credential-like content';
  return 'refresh unavailable';
}

export const runSuperhumanSourceAdd = Effect.fn('superhuman.sourceAdd')(function* (
  config: RuntimeConfig,
  options: SuperhumanSourceAddOptions,
) {
  if (options.apiToken !== undefined) {
    if (!validSuperhumanApiToken(options.apiToken)) return yield* safeError('Invalid Superhuman API token.');
    yield* checkCredentialReflection({...options, apiToken: undefined}, options.apiToken);
  }
  const id = validateObsidianIdentifier(options.id, 'source id');
  const documents = [...new Set(options.documents.map(validateSuperhumanDocumentId))];
  if (documents.length === 0) return yield* safeError('Superhuman sources require at least one document ID.');
  if (documents.length > 64) return yield* safeError('Superhuman sources support at most 64 documents.');
  const pages = options.pages?.map(validateSuperhumanPageId);
  if (pages && pages.length > 256) return yield* safeError('Superhuman sources support at most 256 selected pages.');
  if (pages?.length && documents.length !== 1)
    return yield* safeError('Selected page IDs require exactly one selected document.');
  if (options.documentSelection !== undefined && options.pages !== undefined)
    return yield* safeError('Choose document selections or legacy page IDs.');
  const selection =
    options.documentSelection ??
    documents.map(documentId => ({id: documentId, ...(pages?.length ? {pages: [...new Set(pages)]} : {})}));
  if (
    selection.length !== documents.length ||
    new Set(selection.map(document => document.id)).size !== documents.length ||
    selection.some(document => !documents.includes(document.id))
  )
    return yield* safeError('Document selections must match the selected document IDs.');
  const credentialEnv = options.credentialEnv ?? 'SUPERHUMAN_DOCS_API_TOKEN';
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(credentialEnv))
    return yield* safeError('Invalid credential environment variable name.');
  if (options.projectless === true && options.project)
    return yield* safeError('Choose either --project or --projectless.');
  if (options.projectless !== true && !options.project) return yield* safeError('Choose --project or --projectless.');
  if (
    options.refreshIntervalMinutes !== undefined &&
    (!Number.isSafeInteger(options.refreshIntervalMinutes) ||
      options.refreshIntervalMinutes < 1 ||
      options.refreshIntervalMinutes > 10_080)
  )
    return yield* safeError('Refresh interval must be 1 to 10080 minutes.');
  if (
    options.maxStaleHours !== undefined &&
    (!Number.isSafeInteger(options.maxStaleHours) || options.maxStaleHours < 1 || options.maxStaleHours > 8_760)
  )
    return yield* safeError('Maximum stale age must be 1 to 8760 hours.');
  const project = options.projectless === true ? null : validateObsidianIdentifier(options.project!, 'project');
  const checkExpectedConfiguration = (existing: SourceConfig | undefined) => {
    if (
      options.expectedFingerprint !== undefined &&
      (existing === undefined
        ? null
        : existing.type === 'superhuman'
          ? sourceConfigurationFingerprint(existing)
          : '') !== options.expectedFingerprint
    )
      throw SuperhumanSourceConflictError.make({});
  };
  const sourceFor = (existing?: SuperhumanSourceConfig): SuperhumanSourceConfig =>
    validateSuperhumanSourceConfig({
      type: 'superhuman',
      id,
      enabled: options.enabled ?? true,
      credentialEnv,
      ...(options.apiToken !== undefined ||
      options.credentialStorage === 'local' ||
      (options.credentialEnv === undefined && existing?.credentialStorage === 'local')
        ? {credentialStorage: 'local' as const}
        : {}),
      project,
      documents: selection,
      includeHidden: options.includeHidden === true,
      refreshIntervalMinutes: options.refreshIntervalMinutes ?? 15,
      maxStaleHours: options.maxStaleHours ?? 24,
    });
  const credentialFor = Effect.fn('superhuman.sourceAddCredential')(function* (source: SuperhumanSourceConfig) {
    const token =
      options.apiToken ??
      (yield* resolveSuperhumanCredential(config, source).pipe(Effect.orElseSucceed(() => undefined)));
    if (source.credentialStorage === 'local' && token === undefined)
      return yield* safeError('A protected API token is required for this Superhuman source.');
    if (token !== undefined) yield* checkCredentialReflection(source, token);
  });
  const initial = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
  yield* Effect.try({
    try: () => checkExpectedConfiguration(initial),
    catch: () => SuperhumanSourceConflictError.make({}),
  });
  const previewSource = yield* Effect.try({
    try: () => sourceFor(initial?.type === 'superhuman' ? initial : undefined),
    catch: () => safeError('Invalid Superhuman source configuration.'),
  });
  yield* credentialFor(previewSource);
  if (initial?.type === 'superhuman' && initial.credentialStorage === 'local') {
    const previousToken = yield* resolveSuperhumanCredential(config, initial).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (previousToken !== undefined) yield* checkCredentialReflection(previewSource, previousToken);
  }
  if (options.apply !== true) {
    yield* Console.log(`Would configure Superhuman source "${id}" for ${documents.length} selected document(s).`);
    yield* Console.log('Re-run with --apply to write the configuration.');
    return;
  }
  yield* withSourceLock(
    config,
    id,
    Effect.gen(function* () {
      const existing = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
      yield* Effect.try({
        try: () => checkExpectedConfiguration(existing),
        catch: () => SuperhumanSourceConflictError.make({}),
      });
      if (existing && existing.type !== 'superhuman')
        return yield* safeError(`Source "${id}" already has another type.`);
      const source = yield* Effect.try({
        try: () => sourceFor(existing),
        catch: () => safeError('Invalid Superhuman source configuration.'),
      });
      yield* credentialFor(source);
      if (existing?.credentialStorage === 'local') {
        const previousToken = yield* resolveSuperhumanCredential(config, existing).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (previousToken !== undefined) yield* checkCredentialReflection(source, previousToken);
      }
      const receipt = yield* readExternalSourceReceipt(location(config), id);
      const previousFingerprint = existing ? sourceConfigurationFingerprint(existing) : undefined;
      const cleanup =
        !existing ||
        receipt === null ||
        receipt?.status === 'cleanup' ||
        options.apiToken !== undefined ||
        previousFingerprint !== sourceConfigurationFingerprint(source);
      if (cleanup) yield* denySource(config, source, 'cleanup', previousFingerprint);
      if (options.apiToken !== undefined) yield* storeSuperhumanCredential(config, id, options.apiToken);
      else if (source.credentialStorage !== 'local') yield* removeSuperhumanCredential(config, id);
      yield* mutateSourceConfiguration(config, current => {
        const latest = current.sources.find(item => item.id === id);
        if (
          (latest ? sourceConfigurationFingerprint(requireSuperhumanSource(current, id)) : undefined) !==
          previousFingerprint
        )
          throw safeError('Superhuman source configuration changed before update.');
        return upsertSuperhumanSource(current, source);
      });
      if (cleanup) {
        yield* purgeSource(config, source);
        const activeReceipt: ExternalSourceReceipt = {
          version: 1,
          sourceId: source.id,
          accessEpoch: sha256HexSync(`${yield* Clock.currentTimeMillis}:${yield* Random.next}`),
          status: 'active',
        };
        yield* (yield* ResourceStore).mutateChecked(
          location(config),
          [
            {
              type: 'write',
              uri: externalSourceReceiptUri(source.id),
              content: serializeExternalSourceReceipt(activeReceipt),
              options: {mode: 'upsert'},
            },
          ],
          configFence(config, source.id, sourceConfigurationFingerprint(source), false),
        );
      }
    }),
  );
  yield* Console.log(`Configured Superhuman source "${id}".`);
});

export const runSuperhumanSourceInventory = Effect.fn('superhuman.inventory')(function* (
  config: RuntimeConfig,
  id: string,
) {
  const source = requireSuperhumanSource(yield* readSourceConfiguration(config), id);
  const now = yield* Clock.currentTimeMillis;
  const sourceReceipt = yield* readExternalSourceReceipt(location(config), source.id);
  const entries: SuperhumanInventoryEntry[] = [];
  for (const document of source.documents) {
    const manifest = yield* readExternalDocumentManifest(location(config), source.id, document.id);
    const stale = manifest && now - manifest.fetchedAt > source.maxStaleHours * 3_600_000;
    entries.push({
      documentId: document.id,
      status: manifest
        ? sourceReceipt === null ||
          sourceReceipt?.status === 'cleanup' ||
          manifest.accessEpoch !== sourceReceipt?.accessEpoch
          ? 'quarantined'
          : stale
            ? 'stale'
            : manifest.status
        : 'missing',
      chunks: manifest ? Object.keys(manifest.chunks).length : 0,
      ...(manifest?.nextAttemptAt === undefined ? {} : {nextAttemptAt: manifest.nextAttemptAt}),
    });
  }
  yield* Console.log(`Superhuman source "${source.id}": ${entries.length} selected document(s).`);
  for (const entry of entries)
    yield* Console.log(`${entry.documentId}: ${entry.status}; ${entry.chunks} local chunk(s)`);
  return {source, entries} satisfies SuperhumanInventory;
});

export const runSuperhumanSourceStatus = Effect.fn('superhuman.status')(function* (config: RuntimeConfig, id: string) {
  const inventory = yield* runSuperhumanSourceInventory(config, id);
  yield* Console.log(
    `Superhuman source "${inventory.source.id}" · ${inventory.source.enabled ? 'enabled' : 'disabled'}`,
  );
  for (const entry of inventory.entries.filter(entry => entry.nextAttemptAt))
    yield* Console.log(
      `${entry.documentId}: retry after ${DateTime.formatIso(DateTime.makeUnsafe(entry.nextAttemptAt!))}`,
    );
  return inventory;
});

export const runSuperhumanSourceSync = Effect.fn('superhuman.sync')(function* (
  config: RuntimeConfig,
  options: SuperhumanSourceCommandOptions,
) {
  const source = requireSuperhumanSource(yield* readSourceConfiguration(config), options.id);
  if (options.apply !== true || options.dryRun === true) {
    const inventory = yield* runSuperhumanSourceInventory(config, options.id);
    yield* Console.log(
      `Dry run: ${inventory.entries.length} selected Superhuman document(s). Re-run with --apply to refresh.`,
    );
    return {sourceId: source.id, syncedDocuments: [], warnings: []} satisfies SuperhumanSyncResult;
  }
  const result = yield* syncSource(config, source.id, {
    totalTimeoutMilliseconds: 30_000,
    maxRequests: 64,
    budget: makeSuperhumanClientBudget(30_000, 64),
    ...options.clientOptions,
  });
  yield* Console.log(`Superhuman source "${source.id}": ${result.syncedDocuments.length} document(s) refreshed.`);
  for (const warning of result.warnings) yield* Console.log(warning);
  return result;
});

const syncSource = Effect.fn('superhuman.syncSource')(function* (
  config: RuntimeConfig,
  sourceId: string,
  options: SuperhumanClientOptions,
  onlyIfDue = false,
) {
  return yield* withSourceLock(
    config,
    sourceId,
    Effect.gen(function* () {
      const source = requireSuperhumanSource(yield* readSourceConfiguration(config), sourceId);
      if (!source.enabled) return yield* safeError(`Superhuman source "${source.id}" is disabled.`);
      const fingerprint = sourceConfigurationFingerprint(source);
      const sourceReceipt = yield* readExternalSourceReceipt(location(config), source.id);
      if (sourceReceipt === null || sourceReceipt?.status === 'cleanup')
        return yield* safeError('Superhuman source cleanup is incomplete. Retry source add or remove.');
      const store = yield* ResourceStore;
      const syncedDocuments: string[] = [];
      const warnings: string[] = [];
      const now = yield* Clock.currentTimeMillis;
      let attempted = 0;
      for (const document of source.documents) {
        attempted++;
        const previous = yield* readExternalDocumentManifest(location(config), source.id, document.id);
        if (
          previous?.nextAttemptAt !== undefined &&
          previous.nextAttemptAt > now &&
          (onlyIfDue || previous.retryKind !== 'transient')
        ) {
          warnings.push(`Superhuman document ${document.id}: provider retry is deferred.`);
          continue;
        }
        if (
          onlyIfDue &&
          previous?.status === 'active' &&
          previous.configFingerprint === fingerprint &&
          previous.accessEpoch === sourceReceipt?.accessEpoch &&
          now - previous.fetchedAt < source.refreshIntervalMinutes * 60_000
        )
          continue;
        const result = yield* fetchDocument(config, source, document, options).pipe(Effect.result);
        if (Result.isFailure(result)) {
          const error = result.failure;
          if (isDenied(error) || (error instanceof SuperhumanClientError && error.code === 'credential-reflected')) {
            const targets =
              error instanceof SuperhumanClientError && error.code === 'authentication-rejected'
                ? source.documents
                : [document];
            if (error instanceof SuperhumanClientError && error.code === 'authentication-rejected')
              yield* denySource(config, source, 'authentication-rejected', fingerprint);
            for (const target of targets) {
              yield* quarantineDocument(config, source, target.id, fingerprint);
            }
          }
          if (error instanceof SuperhumanClientError && error.code === 'quota-rejected') {
            const jitter = yield* Random.next;
            const delay = Math.max(error.retryAfterMilliseconds ?? 0, 60_000) + Math.floor(jitter * 10_000);
            const retryAt = Math.min(8_640_000_000_000_000 - 1, (yield* Clock.currentTimeMillis) + delay);
            for (const target of source.documents)
              yield* deferRetry(config, source, target.id, fingerprint, retryAt, 'quota');
          } else if (
            !isDenied(error) &&
            !(error instanceof SuperhumanClientError && error.code === 'credential-reflected')
          ) {
            const retryAt = (yield* Clock.currentTimeMillis) + 60_000 + Math.floor((yield* Random.next) * 10_000);
            yield* deferRetry(config, source, document.id, fingerprint, retryAt, 'transient');
          }
          warnings.push(`Superhuman document ${document.id}: ${warningCode(error)}.`);
          if (
            error instanceof SuperhumanClientError &&
            [
              'authentication-rejected',
              'quota-rejected',
              'deadline-exceeded',
              'contract-incomplete',
              'response-too-large',
            ].includes(error.code)
          )
            break;
          continue;
        }
        const rendered = yield* Effect.result(
          Effect.try({
            try: () => renderSuperhumanDocument(result.success),
            catch: error =>
              error instanceof SuperhumanSecretBlocked ? error : safeError('Superhuman rendering failed.'),
          }),
        );
        if (Result.isFailure(rendered)) {
          const error = rendered.failure;
          if (error instanceof SuperhumanSecretBlocked)
            yield* quarantineDocument(config, source, document.id, fingerprint);
          warnings.push(`Superhuman document ${document.id}: ${warningCode(error)}.`);
          continue;
        }
        const chunks = rendered.success;
        const unsupportedPages = result.success.excluded.filter(page => page.reason === 'unsupported').length;
        const hiddenPages = result.success.excluded.filter(page => page.reason === 'hidden').length;
        const withoutText = result.success.pages.reduce(
          (count, page) => count + page.lines.filter(line => line.content === undefined).length,
          0,
        );
        if (unsupportedPages > 0)
          warnings.push(`Superhuman document ${document.id}: ${unsupportedPages} unsupported page(s) excluded.`);
        if (hiddenPages > 0)
          warnings.push(`Superhuman document ${document.id}: ${hiddenPages} hidden page(s) excluded.`);
        if (withoutText > 0)
          warnings.push(`Superhuman document ${document.id}: ${withoutText} non-text line(s) excluded.`);
        if (result.success.missingSelectedPageIds.length > 0)
          warnings.push(
            `Superhuman document ${document.id}: ${result.success.missingSelectedPageIds.length} selected page(s) absent from complete inventory.`,
          );
        if (chunks.length > 2048) {
          warnings.push(`Superhuman document ${document.id}: selected content exceeds the chunk inventory limit.`);
          continue;
        }
        const files = Object.fromEntries(
          chunks.map(chunk => {
            const uri = externalResourceUri({
              sourceId: source.id,
              documentId: document.id,
              pageId: chunk.pageId,
              chunkId: chunk.chunkId,
            });
            const content = renderExternalResource(
              {
                version: 1,
                sourceId: source.id,
                documentId: document.id,
                pageId: chunk.pageId,
                chunkId: chunk.chunkId,
                project: source.project,
                title: chunk.title,
                rendererVersion: SUPERHUMAN_RENDERER_VERSION,
                scrubberVersion: SUPERHUMAN_SCRUBBER_VERSION,
                coverage: 'canvas-plain-text',
                ...(chunk.remoteRevision === undefined ? {} : {remoteRevision: chunk.remoteRevision}),
              },
              chunk.body,
            );
            return [uri, {content, hash: sha256HexSync(content)}];
          }),
        );
        const fetchedAt = yield* Clock.currentTimeMillis;
        const base: ExternalDocumentManifest = {
          version: 1,
          sourceId: source.id,
          documentId: document.id,
          configFingerprint: fingerprint,
          fetchedAt,
          maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
          chunks: Object.fromEntries(Object.entries(files).map(([uri, file]) => [uri, file.hash])),
          status: 'pending',
          ...(sourceReceipt?.accessEpoch === undefined ? {} : {accessEpoch: sourceReceipt.accessEpoch}),
        };
        const receipt = externalDocumentManifestUri(source.id, document.id);
        const fence = configFence(config, source.id, fingerprint);
        const changedFiles: Array<[string, {content: string; hash: string}]> = [];
        for (const [uri, file] of Object.entries(files)) {
          if (
            previous?.status === 'active' &&
            previous.configFingerprint === fingerprint &&
            previous.chunks[uri] === file.hash
          ) {
            const check = yield* Effect.result(store.read(location(config), uri));
            if (Result.isSuccess(check) && sha256HexSync(check.success) === file.hash) continue;
          }
          changedFiles.push([uri, file]);
        }
        const obsoleteUris = Object.keys(previous?.chunks ?? {}).filter(uri => !(uri in files));
        if (changedFiles.length === 0 && obsoleteUris.length === 0 && previous?.status === 'active') {
          yield* store.mutateChecked(
            location(config),
            [
              {
                type: 'write',
                uri: receipt,
                content: serializeExternalDocumentManifest({...base, status: 'active'}),
                options: {mode: 'upsert'},
              },
            ],
            fence,
          );
          syncedDocuments.push(document.id);
          continue;
        }
        yield* store.mutateChecked(
          location(config),
          [
            {
              type: 'write',
              uri: receipt,
              content: serializeExternalDocumentManifest({
                ...base,
                chunks: previous?.chunks ?? {},
              }),
              options: {mode: 'upsert'},
            },
          ],
          fence,
        );
        yield* store.mutateChecked(
          location(config),
          obsoleteUris.map(uri => ({type: 'remove' as const, uri, ignoreMissing: true})),
          fence,
        );
        yield* store.mutateChecked(
          location(config),
          [
            {
              type: 'write',
              uri: receipt,
              content: serializeExternalDocumentManifest(base),
              options: {mode: 'upsert'},
            },
          ],
          fence,
        );
        const mutations: ResourceStoreMutation[] = [
          ...changedFiles.map(([uri, file]) => ({
            type: 'write' as const,
            uri,
            content: file.content,
            options: {mode: 'upsert' as const},
          })),
          {
            type: 'write',
            uri: receipt,
            content: serializeExternalDocumentManifest({...base, status: 'active'}),
            options: {mode: 'upsert'},
          },
        ];
        yield* store.mutateChecked(location(config), mutations, fence);
        syncedDocuments.push(document.id);
      }
      if (attempted < source.documents.length)
        warnings.push(
          `${source.documents.length - attempted} Superhuman document(s) deferred by refresh budget or quota.`,
        );
      return {sourceId: source.id, syncedDocuments, warnings} satisfies SuperhumanSyncResult;
    }),
  );
});

const deferRetry = Effect.fn('superhuman.deferRetry')(function* (
  config: RuntimeConfig,
  source: SuperhumanSourceConfig,
  documentId: string,
  fingerprint: string,
  retryAt: number,
  retryKind: 'quota' | 'transient',
) {
  const previous = yield* readExternalDocumentManifest(location(config), source.id, documentId);
  const now = yield* Clock.currentTimeMillis;
  const receipt: ExternalDocumentManifest = {
    version: 1,
    sourceId: source.id,
    documentId,
    configFingerprint: fingerprint,
    status: previous?.status === 'active' && previous.configFingerprint === fingerprint ? 'active' : 'quarantined',
    fetchedAt: previous?.fetchedAt ?? now,
    maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
    chunks: previous?.chunks ?? {},
    nextAttemptAt: Math.min(8_640_000_000_000_000 - 1, retryAt),
    retryKind,
    ...(previous?.accessEpoch === undefined ? {} : {accessEpoch: previous.accessEpoch}),
  };
  const store = yield* ResourceStore;
  yield* store.mutateChecked(
    location(config),
    [
      {
        type: 'write',
        uri: externalDocumentManifestUri(source.id, documentId),
        content: serializeExternalDocumentManifest(receipt),
        options: {mode: 'upsert'},
      },
    ],
    configFence(config, source.id, fingerprint),
  );
});

const denySource = Effect.fn('superhuman.denySource')(function* (
  config: RuntimeConfig,
  source: SuperhumanSourceConfig,
  status: ExternalSourceReceipt['status'],
  fingerprint: string | undefined,
) {
  const previous = yield* readExternalSourceReceipt(location(config), source.id);
  const accessEpoch = sha256HexSync(
    `${previous?.accessEpoch ?? ''}:${yield* Clock.currentTimeMillis}:${yield* Random.next}`,
  );
  const receipt: ExternalSourceReceipt = {version: 1, sourceId: source.id, accessEpoch, status};
  const store = yield* ResourceStore;
  const fence =
    fingerprint === undefined
      ? Effect.gen(function* () {
          if ((yield* readSourceConfiguration(config)).sources.some(item => item.id === source.id))
            return yield* safeError('Superhuman source configuration changed before creation.');
        })
      : configFence(config, source.id, fingerprint, false);
  yield* store.mutateChecked(
    location(config),
    [
      {
        type: 'write',
        uri: externalSourceReceiptUri(source.id),
        content: serializeExternalSourceReceipt(receipt),
        options: {mode: 'upsert'},
      },
    ],
    fence,
  );
  return receipt;
});

const purgeSource = Effect.fn('superhuman.purgeSource')(function* (
  config: RuntimeConfig,
  source: SuperhumanSourceConfig,
) {
  const store = yield* ResourceStore;
  yield* store.mutateChecked(
    location(config),
    [
      {type: 'remove', uri: `${rootUri(source.id)}/docs`, options: {recursive: true}, ignoreMissing: true},
      {type: 'remove', uri: rootUri(source.id), options: {recursive: true}, ignoreMissing: true},
    ],
    configFence(config, source.id, sourceConfigurationFingerprint(source), false),
  );
});

const quarantineDocument = Effect.fn('superhuman.quarantine')(function* (
  config: RuntimeConfig,
  source: SuperhumanSourceConfig,
  documentId: string,
  fingerprint: string,
) {
  const store = yield* ResourceStore;
  const previous = yield* readExternalDocumentManifest(location(config), source.id, documentId);
  const now = yield* Clock.currentTimeMillis;
  const receipt: ExternalDocumentManifest = {
    version: 1,
    sourceId: source.id,
    documentId,
    configFingerprint: fingerprint,
    status: 'quarantined',
    fetchedAt: now,
    maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
    chunks: previous?.chunks ?? {},
  };
  yield* store.mutateChecked(
    location(config),
    [
      {
        type: 'write',
        uri: externalDocumentManifestUri(source.id, documentId),
        content: serializeExternalDocumentManifest(receipt),
        options: {mode: 'upsert'},
      },
    ],
    configFence(config, source.id, fingerprint, false),
  );
  const removals = Object.keys(previous?.chunks ?? {}).map(uri => ({
    type: 'remove' as const,
    uri,
    ignoreMissing: true,
  }));
  if (removals.length > 0)
    yield* store.mutateChecked(location(config), removals, configFence(config, source.id, fingerprint, false));
});

export const runSuperhumanSourceRemove = Effect.fn('superhuman.remove')(function* (
  config: RuntimeConfig,
  options: SuperhumanSourceCommandOptions,
) {
  const source = requireSuperhumanSource(yield* readSourceConfiguration(config), options.id);
  if (options.apply !== true || options.dryRun === true) {
    yield* Console.log(
      `Would remove Superhuman source "${source.id}" and its local external resources. Re-run with --apply.`,
    );
    return;
  }
  yield* withSourceLock(
    config,
    source.id,
    Effect.gen(function* () {
      const current = requireSuperhumanSource(yield* readSourceConfiguration(config), source.id);
      const fingerprint = sourceConfigurationFingerprint(current);
      yield* denySource(config, current, 'cleanup', fingerprint);
      const disabled = {...current, enabled: false};
      yield* mutateSourceConfiguration(config, configuration => {
        if (sourceConfigurationFingerprint(requireSuperhumanSource(configuration, source.id)) !== fingerprint)
          throw safeError('Superhuman source configuration changed before removal.');
        return upsertSuperhumanSource(configuration, disabled);
      });
      yield* removeSuperhumanCredential(config, source.id);
      yield* purgeSource(config, disabled);
      yield* mutateSourceConfiguration(config, configuration => {
        if (
          sourceConfigurationFingerprint(requireSuperhumanSource(configuration, source.id)) !==
          sourceConfigurationFingerprint(disabled)
        )
          throw safeError('Superhuman source configuration changed during removal.');
        return {
          version: 2,
          projections: configuration.projections,
          sources: configuration.sources.filter(item => item.id !== source.id),
        };
      });
    }),
  );
  yield* Console.log(`Removed Superhuman source "${source.id}" and local external resources.`);
});

export const syncSuperhumanSourcesBeforeRecall = Effect.fn('superhuman.syncBeforeRecall')(function* (
  config: RuntimeConfig,
  clientOptions: SuperhumanClientOptions = {},
) {
  const configuration = yield* readSourceConfiguration(config);
  const now = yield* Clock.currentTimeMillis;
  const syncedSources: string[] = [];
  const warnings: string[] = [];
  const budget: SuperhumanClientBudget = makeSuperhumanClientBudget(20_000, 16);
  const refreshDeadlineAt = now + 20_000;
  for (const source of configuration.sources) {
    const currentTime = yield* Clock.currentTimeMillis;
    if (
      currentTime >= refreshDeadlineAt ||
      budget.requests >= budget.maxRequests ||
      budget.responseBytes >= budget.maxResponseBytes
    )
      break;
    if (source.type !== 'superhuman' || !source.enabled) continue;
    const sourceReceipt = yield* readExternalSourceReceipt(location(config), source.id);
    if (sourceReceipt === null || sourceReceipt?.status === 'cleanup') {
      warnings.push(`Superhuman source "${source.id}" cleanup is incomplete.`);
      continue;
    }
    let due = false;
    for (const document of source.documents) {
      const manifest = yield* readExternalDocumentManifest(location(config), source.id, document.id);
      if (manifest?.nextAttemptAt !== undefined && manifest.nextAttemptAt > now) continue;
      if (
        !manifest ||
        manifest.status !== 'active' ||
        manifest.configFingerprint !== sourceConfigurationFingerprint(source) ||
        manifest.accessEpoch !== sourceReceipt?.accessEpoch ||
        now - manifest.fetchedAt >= source.refreshIntervalMinutes * 60_000
      )
        due = true;
    }
    if (!due) continue;
    const result = yield* Effect.result(
      syncSource(
        config,
        source.id,
        {...clientOptions, totalTimeoutMilliseconds: 20_000, maxRequests: 16, budget},
        true,
      ),
    );
    if (Result.isFailure(result)) warnings.push(`Superhuman source "${source.id}" refresh unavailable.`);
    else {
      if (result.success.syncedDocuments.length) syncedSources.push(source.id);
      warnings.push(...result.success.warnings);
      if (result.success.warnings.some(warning => warning.includes('quota-rejected'))) break;
    }
  }
  return {syncedSources, warnings};
});
