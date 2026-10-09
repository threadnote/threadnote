import {admittedSourceFetch} from '@threadnote/integration-core/source-coordinator';
import {isPocketSource} from './config.js';
import {Clock, Effect, Random, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
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
  readSourceConfiguration,
  requirePocketSource,
  sourceConfigurationFingerprint,
  type PocketSourceConfig,
} from './config.js';
import {withSourceLock} from '@threadnote/integration-core/lock';
import {createPocketClient, PocketClientError, type PocketClientOptions} from './client.js';
import {
  renderPocketCatalog,
  renderPocketRecord,
  POCKET_RENDERER_VERSION,
  POCKET_SCRUBBER_VERSION,
  type PocketChunk,
} from './render.js';
import {resolvePocketCredential} from './credentials.js';
import {
  readPocketSyncState,
  writePocketSyncState,
  clearPocketSyncState,
  readPocketIdMarker,
  writePocketIdMarker,
  removePocketIdMarker,
  listPocketIdMarkers,
  type PocketSyncState,
  type PocketIdMarker,
} from './state.js';
import type {PocketSyncResult} from './source.js';

const loc = (config: RuntimeConfig) => ({account: config.account, home: config.agentContextHome, user: config.user});
const documentId = (id: string) => `r-${sha256HexSync(id).slice(0, 40)}`;
const receiptUri = (id: string) => externalSourceReceiptUri(id, 'pocket');
const manifestUri = (id: string, doc: string) => externalDocumentManifestUri(id, doc, 'pocket');
const manifest = (config: RuntimeConfig, id: string, doc: string) =>
  readExternalDocumentManifest(loc(config), id, doc, 'pocket');
const receipt = (config: RuntimeConfig, id: string) => readExternalSourceReceipt(loc(config), id, 'pocket');
const configFence = Effect.fn('pocket.syncConfigFence')(function* (
  config: RuntimeConfig,
  id: string,
  fingerprint: string,
) {
  const source = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
  if (!source || !isPocketSource(source) || !source.enabled || sourceConfigurationFingerprint(source) !== fingerprint)
    return yield* syncError('Pocket source configuration changed during refresh.');
});
class PocketSyncError extends Schema.TaggedError<PocketSyncError>()('PocketSyncError', {message: Schema.String}) {}
const syncError = (message: string) => PocketSyncError.make({message});
const error = (message: string) => Effect.fail(syncError(message));
const saveReceipt = Effect.fn('pocket.saveReceipt')(function* (
  config: RuntimeConfig,
  source: PocketSourceConfig,
  value: ExternalSourceReceipt,
) {
  yield* (yield* ResourceStore).mutateChecked(
    loc(config),
    [
      {
        type: 'write',
        uri: receiptUri(source.id),
        content: serializeExternalSourceReceipt(value),
        options: {mode: 'upsert'},
      },
    ],
    configFence(config, source.id, sourceConfigurationFingerprint(source)),
  );
});
const writeDocument = Effect.fn('pocket.writeDocument')(function* (
  config: RuntimeConfig,
  source: PocketSourceConfig,
  doc: string,
  chunks: readonly PocketChunk[],
  access: ExternalSourceReceipt,
  generation: string,
) {
  if (chunks.length > 2048) return yield* error('Pocket record exceeds the chunk inventory limit.');
  const fingerprint = sourceConfigurationFingerprint(source);
  const previous = yield* manifest(config, source.id, doc);
  const files = Object.fromEntries(
    chunks.map(chunk => {
      const uri = externalResourceUri({
        provider: 'pocket',
        sourceId: source.id,
        documentId: doc,
        pageId: chunk.pageId,
        chunkId: chunk.chunkId,
      });
      const content = renderExternalResource(
        {
          version: 1,
          provider: 'pocket',
          sourceId: source.id,
          documentId: doc,
          pageId: chunk.pageId,
          chunkId: chunk.chunkId,
          project: source.project,
          title: chunk.title,
          rendererVersion: POCKET_RENDERER_VERSION,
          scrubberVersion: POCKET_SCRUBBER_VERSION,
          coverage: 'pocket-api-text',
          ...(chunk.remoteRevision ? {remoteRevision: chunk.remoteRevision} : {}),
        },
        chunk.body,
      );
      return [uri, {content, hash: sha256HexSync(content)}];
    }),
  );
  const base: ExternalDocumentManifest = {
    version: 1,
    provider: 'pocket',
    sourceId: source.id,
    documentId: doc,
    configFingerprint: fingerprint,
    status: 'active',
    fetchedAt: yield* Clock.currentTimeMillis,
    maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
    chunks: Object.fromEntries(Object.entries(files).map(([uri, file]) => [uri, file.hash])),
    accessEpoch: access.accessEpoch,
    inventoryGeneration: generation,
  };
  const store = yield* ResourceStore;
  const fence = configFence(config, source.id, fingerprint);
  const obsolete = Object.keys(previous?.chunks ?? {}).filter(uri => !(uri in files));
  const changed: ResourceStoreMutation[] = [];
  for (const [uri, file] of Object.entries(files)) {
    if (previous?.chunks[uri] === file.hash) {
      const check = yield* Effect.result(store.read(loc(config), uri));
      if (Result.isSuccess(check) && sha256HexSync(check.success) === file.hash) continue;
    }
    changed.push({type: 'write', uri, content: file.content, options: {mode: 'upsert'}});
  }
  yield* store.mutateChecked(
    loc(config),
    [
      {
        type: 'write',
        uri: manifestUri(source.id, doc),
        content: serializeExternalDocumentManifest({...base, status: 'pending', chunks: previous?.chunks ?? {}}),
        options: {mode: 'upsert'},
      },
    ],
    fence,
  );
  if (obsolete.length)
    yield* store.mutateChecked(
      loc(config),
      obsolete.map(uri => ({type: 'remove' as const, uri, ignoreMissing: true})),
      fence,
    );
  yield* store.mutateChecked(
    loc(config),
    [
      ...changed,
      {
        type: 'write',
        uri: manifestUri(source.id, doc),
        content: serializeExternalDocumentManifest(base),
        options: {mode: 'upsert'},
      },
    ],
    fence,
  );
});

const quarantine = Effect.fn('pocket.quarantine')(function* (
  config: RuntimeConfig,
  source: PocketSourceConfig,
  doc: string,
) {
  const prior = yield* manifest(config, source.id, doc);
  const access = yield* receipt(config, source.id);
  const state: ExternalDocumentManifest = {
    version: 1,
    provider: 'pocket',
    sourceId: source.id,
    documentId: doc,
    configFingerprint: sourceConfigurationFingerprint(source),
    status: 'quarantined',
    fetchedAt: yield* Clock.currentTimeMillis,
    maxStaleMilliseconds: source.maxStaleHours * 3_600_000,
    chunks: prior?.chunks ?? {},
    ...(access?.accessEpoch ? {accessEpoch: access.accessEpoch} : {}),
  };
  yield* (yield* ResourceStore).mutateChecked(
    loc(config),
    [
      {
        type: 'write',
        uri: manifestUri(source.id, doc),
        content: serializeExternalDocumentManifest(state),
        options: {mode: 'upsert'},
      },
    ],
    configFence(config, source.id, sourceConfigurationFingerprint(source)),
  );
});

const deleteDocument = Effect.fn('pocket.deleteDocument')(function* (
  config: RuntimeConfig,
  source: PocketSourceConfig,
  doc: string,
) {
  const fence = configFence(config, source.id, sourceConfigurationFingerprint(source));
  yield* (yield* ResourceStore).mutateChecked(
    loc(config),
    [
      {
        type: 'remove',
        uri: `threadnote://resources/external/pocket/${source.id}/docs/${doc}`,
        options: {recursive: true},
        ignoreMissing: true,
      },
    ],
    fence,
  );
  yield* removePocketIdMarker(config, source.id, doc, fence);
});

const retryAtFor = Effect.fn('pocket.retryAtFor')(function* (failure: PocketClientError) {
  return Math.min(
    8_640_000_000_000_000 - 1,
    (yield* Clock.currentTimeMillis) + Math.max(failure.retryAfterMilliseconds ?? 0, 60_000),
  );
});

export const syncPocketSource = Effect.fn('pocket.syncSource')(function* (
  config: RuntimeConfig,
  id: string,
  options: PocketClientOptions = {},
  onlyDue = false,
) {
  return yield* withSourceLock(
    config,
    id,
    Effect.gen(function* () {
      const source = requirePocketSource(yield* readSourceConfiguration(config), id);
      if (!source.enabled) return yield* syncError('Pocket source is disabled.');
      const access = yield* receipt(config, id);
      if (!access || access.status !== 'active') return yield* syncError('Pocket source access is unavailable.');
      const now = yield* Clock.currentTimeMillis;
      if (access.nextAttemptAt !== undefined && access.nextAttemptAt > now)
        return {
          sourceId: id,
          syncedDocuments: [],
          warnings: ['Pocket provider retry is deferred.'],
        } satisfies PocketSyncResult;
      const loadedState = yield* readPocketSyncState(config, id);
      if (loadedState === null) return yield* syncError('Pocket sync state is invalid.');
      const fingerprint = sourceConfigurationFingerprint(source);
      if (loadedState && (loadedState.fingerprint !== fingerprint || loadedState.accessEpoch !== access.accessEpoch))
        return yield* syncError('Pocket sync state no longer matches source access.');
      if (
        onlyDue &&
        loadedState === undefined &&
        access.inventoryPage === undefined &&
        access.completedAt !== undefined &&
        now - access.completedAt < source.refreshIntervalMinutes * 60_000
      )
        return {sourceId: id, syncedDocuments: [], warnings: []} satisfies PocketSyncResult;
      let state: PocketSyncState = loadedState ?? {
        version: 1,
        fingerprint,
        accessEpoch: access.accessEpoch,
        generation: sha256HexSync(`${now}:${yield* Random.next}`),
        phase: 'list',
        page: 1,
        offset: 0,
        pageIds: [],
        hasMore: false,
        seenCount: 0,
        incomplete: false,
      };
      const fence = configFence(config, id, fingerprint);
      const token = yield* resolvePocketCredential(config, source);
      const fetch = yield* admittedSourceFetch('pocket', token, options.fetch, config);
      const client = createPocketClient(token, {...options, fetch});
      const syncedDocuments: string[] = [];
      const warnings: string[] = [];
      let globalRetryAt: number | undefined;
      const maxRequests = Math.min(options.maxRequests ?? 64, 128);
      const canRequest = () =>
        !client.expired &&
        client.requests < maxRequests &&
        (!options.budget ||
          (options.budget.requests < options.budget.maxRequests &&
            options.budget.responseBytes < options.budget.maxResponseBytes &&
            Date.now() < options.budget.deadlineAt));
      const checkpoint = Effect.fn('pocket.syncCheckpoint')(function* (current: PocketSyncState, completed = false) {
        if (completed) yield* clearPocketSyncState(config, id, fence);
        else yield* writePocketSyncState(config, id, current, fence);
        yield* saveReceipt(config, source, {
          ...access,
          inventoryPage: completed && !current.incomplete ? undefined : current.page,
          inventoryOffset: completed && !current.incomplete ? undefined : current.offset,
          inventoryGeneration: completed && !current.incomplete ? undefined : current.generation,
          completedAt: completed && !current.incomplete ? yield* Clock.currentTimeMillis : access.completedAt,
          nextAttemptAt: globalRetryAt,
        });
        return {
          sourceId: id,
          syncedDocuments,
          warnings,
          ...(!completed || current.incomplete ? {progress: {page: current.page, offset: current.offset}} : {}),
        } satisfies PocketSyncResult;
      });
      const denyGlobal = Effect.fn('pocket.denyGlobal')(function* () {
        yield* saveReceipt(config, source, {...access, status: 'authentication-rejected'});
        warnings.push('Pocket source access was rejected.');
        return {sourceId: id, syncedDocuments, warnings} satisfies PocketSyncResult;
      });
      return yield* Effect.gen(function* () {
        if (state.phase === 'list' && state.page === 1 && state.offset === 0 && state.pageIds.length === 0) {
          for (const kind of ['folders', 'tags'] as const) {
            if (!canRequest()) return yield* checkpoint(state);
            const result = yield* fromPromiseInterruptible(
              () => client.catalog(kind),
              failure =>
                failure instanceof PocketClientError ? failure : new PocketClientError({code: 'transport-rejected'}),
            ).pipe(Effect.result);
            if (Result.isFailure(result)) {
              if (result.failure.code === 'authentication-rejected') return yield* denyGlobal();
              if (client.expired) return yield* checkpoint(state);
              if (result.failure.code === 'quota-rejected') {
                globalRetryAt = yield* retryAtFor(result.failure);
                warnings.push(`Pocket ${kind} refresh is rate limited.`);
                return yield* checkpoint(state);
              }
              if (result.failure.code === 'access-rejected' || result.failure.code === 'credential-reflected')
                yield* quarantine(config, source, `catalog-${kind}`);
              warnings.push(`Pocket ${kind} refresh unavailable.`);
              state = {...state, incomplete: true};
              continue;
            }
            const chunks = yield* Effect.try({
              try: () => renderPocketCatalog(kind, result.success),
              catch: () => syncError('Pocket catalog content rejected.'),
            }).pipe(Effect.result);
            if (Result.isFailure(chunks)) {
              yield* quarantine(config, source, `catalog-${kind}`);
              warnings.push(`Pocket ${kind} content quarantined.`);
              state = {...state, incomplete: true};
              continue;
            }
            const stored = yield* writeDocument(
              config,
              source,
              `catalog-${kind}`,
              chunks.success,
              access,
              state.generation,
            ).pipe(Effect.result);
            if (Result.isFailure(stored)) {
              warnings.push(`Pocket ${kind} content could not be stored.`);
              state = {...state, incomplete: true};
            }
          }
          yield* writePocketSyncState(config, id, state, fence);
        }
        while (state.phase === 'list' && canRequest()) {
          if (state.pageIds.length === 0) {
            const listed = yield* fromPromiseInterruptible(
              () => client.list(state.page),
              failure =>
                failure instanceof PocketClientError ? failure : new PocketClientError({code: 'transport-rejected'}),
            ).pipe(Effect.result);
            if (Result.isFailure(listed)) {
              if (listed.failure.code === 'authentication-rejected' || listed.failure.code === 'access-rejected')
                return yield* denyGlobal();
              if (listed.failure.code === 'quota-rejected') globalRetryAt = yield* retryAtFor(listed.failure);
              if (client.expired) return yield* checkpoint(state);
              warnings.push(`Pocket listing page ${state.page} is unavailable.`);
              if (state.page > 1 && listed.failure.code !== 'quota-rejected') {
                state = {
                  ...state,
                  generation: sha256HexSync(`${yield* Clock.currentTimeMillis}:${yield* Random.next}`),
                  phase: 'list',
                  page: 1,
                  offset: 0,
                  pageIds: [],
                  hasMore: false,
                  total: undefined,
                  seenCount: 0,
                  incomplete: false,
                  confirmAfter: undefined,
                };
              } else state = {...state, incomplete: true};
              return yield* checkpoint(state);
            }
            if (state.total !== undefined && state.total !== listed.success.total) state = {...state, incomplete: true};
            state = {
              ...state,
              pageIds: listed.success.recordings.map(item => item.id),
              hasMore: listed.success.hasMore,
              total: state.total ?? listed.success.total,
              offset: 0,
            };
            yield* writePocketSyncState(config, id, state, fence);
          }
          while (state.offset < state.pageIds.length && canRequest()) {
            const rawId = state.pageIds[state.offset];
            const doc = documentId(rawId);
            const prior = yield* readPocketIdMarker(config, id, doc);
            if (prior === null || (prior && prior.id !== rawId)) {
              state = {...state, incomplete: true, offset: state.offset + 1};
              warnings.push(`Pocket recording ${doc} identity is invalid.`);
              yield* writePocketSyncState(config, id, state, fence);
              continue;
            }
            if (prior?.generation === state.generation && prior.page !== state.page) {
              state = {...state, incomplete: true, offset: state.offset + 1};
              warnings.push('Pocket listing contained a repeated recording across pages.');
              yield* writePocketSyncState(config, id, state, fence);
              continue;
            }
            if (prior?.generation !== state.generation) state = {...state, seenCount: state.seenCount + 1};
            const marker: PocketIdMarker = {
              version: 1,
              id: rawId,
              documentId: doc,
              generation: state.generation,
              page: state.page,
              ...(prior?.nextAttemptAt ? {nextAttemptAt: prior.nextAttemptAt} : {}),
            };
            yield* writePocketIdMarker(config, id, marker, fence);
            if (prior?.nextAttemptAt && prior.nextAttemptAt > (yield* Clock.currentTimeMillis)) {
              state = {...state, incomplete: true, offset: state.offset + 1};
              yield* writePocketSyncState(config, id, state, fence);
              continue;
            }
            const detailed = yield* fromPromiseInterruptible(
              () => client.detail(rawId),
              failure =>
                failure instanceof PocketClientError ? failure : new PocketClientError({code: 'transport-rejected'}),
            ).pipe(Effect.result);
            if (Result.isFailure(detailed)) {
              if (detailed.failure.code === 'authentication-rejected') return yield* denyGlobal();
              if (client.expired) return yield* checkpoint(state);
              if (detailed.failure.code === 'quota-rejected') {
                globalRetryAt = yield* retryAtFor(detailed.failure);
                warnings.push('Pocket provider is rate limited.');
                return yield* checkpoint(state);
              }
              if (['access-rejected', 'not-found', 'credential-reflected'].includes(detailed.failure.code)) {
                yield* quarantine(config, source, doc);
                warnings.push(`Pocket recording ${doc} is inaccessible.`);
              } else {
                const retryAt = (yield* Clock.currentTimeMillis) + 60_000;
                yield* writePocketIdMarker(config, id, {...marker, nextAttemptAt: retryAt}, fence);
                state = {...state, incomplete: true};
                warnings.push(`Pocket recording ${doc} refresh deferred.`);
              }
            } else {
              const chunks = yield* Effect.try({
                try: () => renderPocketRecord(detailed.success),
                catch: () => syncError('Pocket content rejected.'),
              }).pipe(Effect.result);
              if (Result.isFailure(chunks)) {
                yield* quarantine(config, source, doc);
                yield* writePocketIdMarker(
                  config,
                  id,
                  {...marker, nextAttemptAt: (yield* Clock.currentTimeMillis) + 60_000},
                  fence,
                );
                state = {...state, incomplete: true};
                warnings.push(`Pocket recording ${doc} content quarantined.`);
              } else {
                const stored = yield* writeDocument(config, source, doc, chunks.success, access, state.generation).pipe(
                  Effect.result,
                );
                if (Result.isFailure(stored)) {
                  yield* writePocketIdMarker(
                    config,
                    id,
                    {...marker, nextAttemptAt: (yield* Clock.currentTimeMillis) + 60_000},
                    fence,
                  );
                  state = {...state, incomplete: true};
                  warnings.push(`Pocket recording ${doc} could not be stored.`);
                } else {
                  yield* writePocketIdMarker(config, id, {...marker, nextAttemptAt: undefined}, fence);
                  syncedDocuments.push(rawId);
                }
              }
            }
            state = {...state, offset: state.offset + 1};
            yield* writePocketSyncState(config, id, state, fence);
          }
          if (state.offset < state.pageIds.length) break;
          if (state.hasMore) {
            state = {...state, page: state.page + 1, offset: 0, pageIds: [], hasMore: false};
            yield* writePocketSyncState(config, id, state, fence);
            continue;
          }
          const markers = yield* listPocketIdMarkers(config, id);
          if (markers === null) {
            state = {...state, incomplete: true};
            warnings.push('Pocket ID inventory is invalid.');
          } else if (markers.filter(marker => marker.generation === state.generation).length !== state.total) {
            state = {...state, incomplete: true};
            warnings.push('Pocket listing coverage changed during refresh.');
          }
          state = {...state, phase: 'confirm', pageIds: [], offset: 0};
          yield* writePocketSyncState(config, id, state, fence);
        }
        if (state.phase === 'confirm' && !state.incomplete) {
          const markers = yield* listPocketIdMarkers(config, id);
          if (markers === null) {
            state = {...state, incomplete: true};
            warnings.push('Pocket ID inventory is invalid.');
          } else
            for (const marker of markers) {
              if (
                marker.generation === state.generation ||
                (state.confirmAfter && marker.documentId <= state.confirmAfter)
              )
                continue;
              if (!canRequest()) break;
              const detailed = yield* fromPromiseInterruptible(
                () => client.detail(marker.id),
                failure =>
                  failure instanceof PocketClientError ? failure : new PocketClientError({code: 'transport-rejected'}),
              ).pipe(Effect.result);
              if (Result.isFailure(detailed)) {
                if (detailed.failure.code === 'authentication-rejected') return yield* denyGlobal();
                if (client.expired) return yield* checkpoint(state);
                if (detailed.failure.code === 'quota-rejected') {
                  globalRetryAt = yield* retryAtFor(detailed.failure);
                  return yield* checkpoint(state);
                }
                if (detailed.failure.code === 'not-found' || detailed.failure.code === 'access-rejected')
                  yield* deleteDocument(config, source, marker.documentId);
                else {
                  state = {...state, incomplete: true};
                  warnings.push(`Pocket recording ${marker.documentId} absence could not be confirmed.`);
                }
              } else {
                const chunks = yield* Effect.try({
                  try: () => renderPocketRecord(detailed.success),
                  catch: () => syncError('Pocket content rejected.'),
                }).pipe(Effect.result);
                if (Result.isFailure(chunks)) {
                  yield* quarantine(config, source, marker.documentId);
                  state = {...state, incomplete: true};
                } else {
                  const stored = yield* writeDocument(
                    config,
                    source,
                    marker.documentId,
                    chunks.success,
                    access,
                    state.generation,
                  ).pipe(Effect.result);
                  if (Result.isFailure(stored)) {
                    state = {...state, incomplete: true};
                    warnings.push(`Pocket recording ${marker.documentId} could not be stored.`);
                  } else {
                    yield* writePocketIdMarker(
                      config,
                      id,
                      {...marker, generation: state.generation, page: state.page, nextAttemptAt: undefined},
                      fence,
                    );
                    syncedDocuments.push(marker.id);
                  }
                }
              }
              state = {...state, confirmAfter: marker.documentId};
              yield* writePocketSyncState(config, id, state, fence);
            }
          if (
            !state.incomplete &&
            markers &&
            markers.some(
              marker =>
                marker.generation !== state.generation &&
                (!state.confirmAfter || marker.documentId > state.confirmAfter),
            )
          )
            return yield* checkpoint(state);
        }
        if (state.phase === 'confirm') return yield* checkpoint(state, true);
        return yield* checkpoint(state);
      }).pipe(Effect.ensuring(Effect.sync(() => client.close())));
    }),
  );
});
