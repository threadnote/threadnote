import {admittedSourceFetch, cooldownSourceAccount} from '@threadnote/integration-core/source-coordinator';
import {isGitHubSource} from './config.js';
import {Clock, DateTime, Effect, Random, Result, Schema} from 'effect';
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
  requireGitHubSource,
  sourceConfigurationFingerprint,
  type GitHubSourceConfig,
} from './config.js';
import {withSourceLock} from '@threadnote/integration-core/lock';
import {
  createGitHubClient,
  githubDocumentId,
  GitHubClientError,
  type GitHubClientOptions,
  type GitHubCandidate,
  type GitHubRepository,
} from './client.js';
import {
  renderGitHubConversation,
  GITHUB_RENDERER_VERSION,
  GITHUB_SCRUBBER_VERSION,
  type GitHubChunk,
  GitHubSecretBlocked,
} from './render.js';
import {resolveGitHubCredential} from './credentials.js';
import {
  readGitHubSyncState,
  writeGitHubSyncState,
  clearGitHubSyncState,
  readGitHubRepositoryStates,
  writeGitHubRepositoryStates,
  readGitHubIdMarker,
  writeGitHubIdMarker,
  listGitHubIdMarkers,
  readGitHubRepositoryCheckpoint,
  writeGitHubRepositoryCheckpoint,
  clearGitHubRepositoryCheckpoint,
  type GitHubSyncState,
  type GitHubRepositoryState,
  type GitHubIdMarker,
} from './state.js';
import type {GitHubSyncResult} from './source.js';

const syncResult = (value: GitHubSyncResult): GitHubSyncResult => value;
const loc = (config: RuntimeConfig) => ({account: config.account, home: config.agentContextHome, user: config.user});
const receiptUri = (id: string) => externalSourceReceiptUri(id, 'github');
const manifestUri = (id: string, doc: string) => externalDocumentManifestUri(id, doc, 'github');
const manifest = (config: RuntimeConfig, id: string, doc: string) =>
  readExternalDocumentManifest(loc(config), id, doc, 'github');
const receipt = (config: RuntimeConfig, id: string) => readExternalSourceReceipt(loc(config), id, 'github');
const configFence = Effect.fn('github.syncConfigFence')(function* (
  config: RuntimeConfig,
  id: string,
  fingerprint: string,
  epoch?: string,
) {
  const source = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
  if (!source || !isGitHubSource(source) || !source.enabled || sourceConfigurationFingerprint(source) !== fingerprint)
    return yield* syncError('GitHub source configuration changed during refresh.');
  if (epoch !== undefined) {
    const current = yield* receipt(config, id);
    if (current?.status !== 'active' || current.accessEpoch !== epoch)
      return yield* syncError('GitHub source access changed during refresh.');
  }
});
class GitHubSyncError extends Schema.TaggedError<GitHubSyncError>()('GitHubSyncError', {message: Schema.String}) {}
const syncError = (message: string) => GitHubSyncError.make({message});
const error = (message: string) => Effect.fail(syncError(message));
const saveReceipt = Effect.fn('github.saveReceipt')(function* (
  config: RuntimeConfig,
  source: GitHubSourceConfig,
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
const writeDocument = Effect.fn('github.writeDocument')(function* (
  config: RuntimeConfig,
  source: GitHubSourceConfig,
  doc: string,
  chunks: readonly GitHubChunk[],
  access: ExternalSourceReceipt,
  generation: string,
) {
  if (chunks.length > 2048) return yield* error('GitHub record exceeds the chunk inventory limit.');
  const fingerprint = sourceConfigurationFingerprint(source);
  const previous = yield* manifest(config, source.id, doc);
  const files = Object.fromEntries(
    chunks.map(chunk => {
      const uri = externalResourceUri({
        provider: 'github',
        sourceId: source.id,
        documentId: doc,
        pageId: chunk.pageId,
        chunkId: chunk.chunkId,
      });
      const content = renderExternalResource(
        {
          version: 1,
          provider: 'github',
          sourceId: source.id,
          documentId: doc,
          pageId: chunk.pageId,
          chunkId: chunk.chunkId,
          project: source.project,
          title: chunk.title,
          rendererVersion: GITHUB_RENDERER_VERSION,
          scrubberVersion: GITHUB_SCRUBBER_VERSION,
          coverage: 'github-conversation',
          browserLink: chunk.browserLink,
          ...(chunk.remoteRevision ? {remoteRevision: chunk.remoteRevision} : {}),
        },
        chunk.body,
      );
      return [uri, {content, hash: sha256HexSync(content)}];
    }),
  );
  const base: ExternalDocumentManifest = {
    version: 1,
    provider: 'github',
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
  const fence = configFence(config, source.id, fingerprint, access.accessEpoch);
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

const quarantine = Effect.fn('github.quarantine')(function* (
  config: RuntimeConfig,
  source: GitHubSourceConfig,
  doc: string,
) {
  const prior = yield* manifest(config, source.id, doc);
  const access = yield* receipt(config, source.id);
  const state: ExternalDocumentManifest = {
    version: 1,
    provider: 'github',
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

export const syncGitHubSource = Effect.fn('github.syncSource')(function* (
  config: RuntimeConfig,
  id: string,
  options: GitHubClientOptions = {},
  onlyDue = false,
) {
  return yield* withSourceLock(
    config,
    id,
    Effect.gen(function* () {
      const source = requireGitHubSource(yield* readSourceConfiguration(config), id);
      if (!source.enabled) return yield* syncError('GitHub source is disabled.');
      const loadedAccess = yield* receipt(config, id);
      if (!loadedAccess || loadedAccess.status !== 'active')
        return yield* syncError('GitHub source access is unavailable.');
      let access: ExternalSourceReceipt = loadedAccess;
      const now = yield* Clock.currentTimeMillis;
      const syncedDocuments: string[] = [];
      const warnings: string[] = [];
      if (access.nextAttemptAt !== undefined && access.nextAttemptAt > now)
        return syncResult({
          sourceId: id,
          syncedDocuments,
          warnings: ['GitHub provider retry is deferred.'],
        });
      const fingerprint = sourceConfigurationFingerprint(source);
      const fence = configFence(config, id, fingerprint, access.accessEpoch);
      const loadedRepositories = yield* readGitHubRepositoryStates(config, id);
      const loaded = yield* readGitHubSyncState(config, id);
      if (loadedRepositories === null || loaded === null) return yield* syncError('GitHub sync state is invalid.');
      let repositories: GitHubRepositoryState[] = loadedRepositories;
      if (loaded && (loaded.fingerprint !== fingerprint || loaded.accessEpoch !== access.accessEpoch))
        return yield* syncError('GitHub sync state no longer matches source access.');
      for (const repository of repositories.filter(r => r.parked && source.repositories.includes(r.name))) {
        const saved = yield* readGitHubRepositoryCheckpoint(
          config,
          id,
          repository.id,
          source.repositories.indexOf(repository.name),
        );
        if (!saved || saved.fingerprint !== fingerprint || saved.accessEpoch !== access.accessEpoch)
          return yield* syncError('GitHub repository checkpoint no longer matches source access.');
      }
      const pendingMarkers = yield* listGitHubIdMarkers(config, id);
      if (pendingMarkers === null) return yield* syncError('GitHub ID inventory is invalid.');
      const pendingDue =
        pendingMarkers.some(m => m.pending && (m.nextAttemptAt === undefined || m.nextAttemptAt <= now)) ||
        repositories.some(r => r.unresolvedNumbers?.some(item => item.nextAttemptAt <= now));
      if (
        onlyDue &&
        !pendingDue &&
        !repositories.some(r => r.status === 'pending' || !r.backfillComplete) &&
        !loaded &&
        access.completedAt !== undefined &&
        now - access.completedAt < source.refreshIntervalMinutes * 60_000
      )
        return syncResult({sourceId: id, syncedDocuments, warnings});
      const initial = Effect.fn('github.initialCheckpoint')(function* (index: number) {
        const repository = repositories.find(r => r.name === source.repositories[index]);
        if (repository?.parked) {
          const saved = yield* readGitHubRepositoryCheckpoint(config, id, repository.id, index);
          if (!saved || saved.fingerprint !== fingerprint || saved.accessEpoch !== access.accessEpoch)
            return yield* syncError('GitHub repository checkpoint no longer matches source access.');
          return saved;
        }
        return {
          version: 1,
          fingerprint,
          accessEpoch: access.accessEpoch,
          repositoryIndex: index,
          phase: repositories.find(r => r.name === source.repositories[index])?.backfillComplete
            ? 'issues'
            : 'backfill',
          page: 1,
          offset: 0,
          items: [],
          hasMore: false,
          boundary: now,
          incomplete: false,
        } satisfies GitHubSyncState;
      });
      let state: GitHubSyncState = loaded ?? (yield* initial(0));
      let retryAt: number | undefined;
      const saveRepositories = () => writeGitHubRepositoryStates(config, id, repositories, fence);
      const parkRepository = Effect.fn('github.parkRepository')(function* (repository?: GitHubRepositoryState) {
        if (repository) {
          yield* writeGitHubRepositoryCheckpoint(config, id, repository.id, state, fence);
          repositories = repositories.map(r =>
            r.name === repository.name ? {...repository, status: 'pending' as const, parked: true} : r,
          );
          yield* saveRepositories();
        }
        state = yield* initial(state.repositoryIndex + 1);
        yield* writeGitHubSyncState(config, id, state, fence);
      });
      const checkpoint = Effect.fn('github.checkpoint')(function* (completed = false) {
        const parked = repositories.find(r => r.parked && source.repositories.includes(r.name));
        if (completed && parked) {
          state = yield* initial(source.repositories.indexOf(parked.name));
          completed = false;
        }
        if (completed) yield* clearGitHubSyncState(config, id, fence);
        else yield* writeGitHubSyncState(config, id, state, fence);
        yield* saveReceipt(config, source, {
          ...access,
          completedAt: completed ? yield* Clock.currentTimeMillis : access.completedAt,
          nextAttemptAt: retryAt,
        });
        const times = repositories.map(r => r.lastReconciledAt).filter((t): t is number => t !== undefined);
        return syncResult({
          sourceId: id,
          syncedDocuments,
          warnings,
          repositories: repositories.map(r => ({
            repository: r.name,
            backfillComplete: r.backfillComplete,
            status: r.status,
            ...(r.lastReconciledAt === undefined ? {} : {lastReconciledAt: r.lastReconciledAt}),
          })),
          ...(times.length === source.repositories.length ? {lastReconciledAt: Math.min(...times)} : {}),
          ...(!completed
            ? {
                progress: {
                  repository: source.repositories[state.repositoryIndex] ?? '',
                  page: state.page,
                  offset: state.offset,
                },
              }
            : {}),
        });
      });
      const denyGlobal = Effect.fn('github.denyGlobal')(function* () {
        yield* saveReceipt(config, source, {...access, status: 'authentication-rejected'});
        warnings.push('GitHub source authentication was rejected.');
        return syncResult({sourceId: id, syncedDocuments, warnings});
      });
      const tokenResult = yield* resolveGitHubCredential(config, source).pipe(Effect.result);
      if (Result.isFailure(tokenResult)) return yield* denyGlobal();
      const fetch = yield* admittedSourceFetch('github', tokenResult.success, options.fetch, config);
      const client = createGitHubClient(tokenResult.success, {...options, fetch});
      const call = <A>(run: () => Promise<A>) =>
        fromPromiseInterruptible(run, f =>
          f instanceof GitHubClientError ? f : new GitHubClientError({code: 'transport-rejected'}),
        ).pipe(Effect.result);
      const canRequest = () =>
        !client.expired &&
        client.requests < (options.maxRequests ?? 256) &&
        (!options.budget ||
          (options.budget.requests < options.budget.maxRequests &&
            options.budget.responseBytes < options.budget.maxResponseBytes &&
            Date.now() < options.budget.deadlineAt));
      const quota = Effect.fn('github.quota')(function* (failure: GitHubClientError) {
        yield* cooldownSourceAccount(
          config,
          'github',
          tokenResult.success,
          failure.retryAfterMilliseconds ?? 60_000,
          'POST',
        );
        yield* cooldownSourceAccount(
          config,
          'github',
          tokenResult.success,
          failure.retryAfterMilliseconds ?? 60_000,
          'GET',
        );
        retryAt = Math.min(
          8_640_000_000_000_000 - 1,
          (yield* Clock.currentTimeMillis) + Math.max(60_000, failure.retryAfterMilliseconds ?? 0),
        );
        warnings.push('GitHub provider is rate limited.');
      });
      const advanceDenial = Effect.fn('github.advanceDenial')(function* (repositoryIds: readonly string[]) {
        const deniedRepositoryIds = [...new Set([...(access.deniedRepositoryIds ?? []), ...repositoryIds])];
        const generations = Object.fromEntries(
          Object.entries(access.repositoryDenialGenerations ?? {}).filter(([repoId]) =>
            deniedRepositoryIds.includes(repoId),
          ),
        );
        const nonce = `${access.accessEpoch}:${yield* Clock.currentTimeMillis}:${yield* Random.next}`;
        for (const repoId of repositoryIds)
          generations[repoId] = sha256HexSync(`${nonce}:${repoId}:${generations[repoId] ?? ''}`);
        access = {
          ...access,
          deniedRepositoryIds,
          repositoryDenialGenerations: generations,
        };
        yield* saveReceipt(config, source, access);
      });
      const denyRepository = Effect.fn('github.denyRepository')(function* (name: string) {
        yield* advanceDenial([
          ...new Set([
            ...repositories.filter(r => r.name === name).map(r => r.id),
            ...pendingMarkers.filter(m => m.repository === name).map(m => m.repositoryId),
          ]),
        ]);
        state = {...state, revalidatingRepositoryId: undefined, revalidatingRepositoryGeneration: undefined};
        yield* writeGitHubSyncState(config, id, state, fence);
        repositories = repositories.map(r => (r.name === name ? {...r, status: 'pending' as const} : r));
        yield* saveRepositories();
        const markers = yield* listGitHubIdMarkers(config, id);
        if (markers === null) return yield* syncError('GitHub ID inventory is invalid.');
        for (const m of markers.filter(m => m.repository === name)) yield* quarantine(config, source, m.documentId);
        warnings.push(`GitHub repository ${name} access is unresolved.`);
      });
      const refresh = Effect.fn('github.refreshConversation')(function* (
        repository: GitHubRepository,
        item: GitHubCandidate,
        name: string,
      ) {
        const doc = githubDocumentId(repository.id, item);
        const prior = yield* readGitHubIdMarker(config, id, doc);
        if (prior === null) return yield* syncError('GitHub conversation identity is invalid.');
        const marker: GitHubIdMarker = {
          ...item,
          repositoryId: repository.id,
          repository: name,
          documentId: doc,
          pending: true,
          ...(prior?.nextAttemptAt === undefined ? {} : {nextAttemptAt: prior.nextAttemptAt}),
        };
        if (
          prior?.observedBoundary === state.boundary &&
          !prior.pending &&
          (yield* manifest(config, id, doc))?.status === 'active'
        )
          return 'done' as const;
        yield* writeGitHubIdMarker(config, id, marker, fence);
        if (prior?.nextAttemptAt !== undefined && prior.nextAttemptAt > (yield* Clock.currentTimeMillis)) {
          state = {...state, incomplete: true};
          return 'deferred' as const;
        }
        const detailed = yield* call(() => client.stableConversation(repository, item));
        if (Result.isFailure(detailed)) {
          const failure = detailed.failure;
          if (failure.code === 'authentication-rejected') return 'auth' as const;
          if (failure.code === 'quota-rejected') {
            yield* quota(failure);
            return 'stop' as const;
          }
          if (failure.code === 'access-rejected') yield* denyRepository(name);
          else if (failure.code === 'not-found' || failure.code === 'credential-reflected')
            yield* quarantine(config, source, doc);
          yield* writeGitHubIdMarker(
            config,
            id,
            {...marker, nextAttemptAt: (yield* Clock.currentTimeMillis) + 60_000},
            fence,
          );
          state = {...state, incomplete: true};
          warnings.push(`GitHub conversation ${doc} refresh deferred (${failure.code}).`);
          return failure.code === 'access-rejected' ? ('denied' as const) : ('deferred' as const);
        }
        const rendered = yield* Effect.try({
          try: () => renderGitHubConversation(detailed.success),
          catch: failure =>
            failure instanceof GitHubSecretBlocked
              ? failure
              : syncError('GitHub conversation exceeds rendering budget.'),
        }).pipe(Effect.result);
        if (Result.isFailure(rendered)) {
          if (rendered.failure instanceof GitHubSecretBlocked) yield* quarantine(config, source, doc);
          state = {...state, incomplete: true};
          warnings.push(`GitHub conversation ${doc} content deferred.`);
          yield* writeGitHubIdMarker(
            config,
            id,
            {...marker, nextAttemptAt: (yield* Clock.currentTimeMillis) + 60_000},
            fence,
          );
          return 'deferred' as const;
        }
        yield* writeDocument(config, source, doc, rendered.success, access, sha256HexSync(String(state.boundary)));
        yield* writeGitHubIdMarker(
          config,
          id,
          {...marker, pending: false, nextAttemptAt: undefined, observedBoundary: state.boundary},
          fence,
        );
        syncedDocuments.push(doc);
        return 'done' as const;
      });
      return yield* Effect.gen(function* () {
        repositoryLoop: while (state.repositoryIndex < source.repositories.length && canRequest()) {
          const repositoryIndex = state.repositoryIndex;
          const requestStart = client.requests;
          const remainingRequests = Math.min(
            (options.maxRequests ?? 256) - client.requests,
            options.budget ? options.budget.maxRequests - options.budget.requests : Infinity,
          );
          const repositoryRequestLimit = Math.min(
            remainingRequests,
            Math.max(6, Math.floor(remainingRequests / (source.repositories.length - repositoryIndex))),
          );
          const canRequestRepository = () => canRequest() && client.requests - requestStart < repositoryRequestLimit;
          const name = source.repositories[state.repositoryIndex];
          const pinned = repositories.find(r => r.name === name);
          const checked = yield* call(() => client.repository(pinned?.canonical ?? name));
          if (Result.isFailure(checked)) {
            if (checked.failure.code === 'authentication-rejected') return yield* denyGlobal();
            if (checked.failure.code === 'quota-rejected') {
              yield* quota(checked.failure);
              return yield* checkpoint();
            }
            if (checked.failure.code === 'not-found' || checked.failure.code === 'access-rejected')
              yield* denyRepository(name);
            else {
              warnings.push(`GitHub repository ${name} refresh unavailable.`);
              return yield* checkpoint();
            }
            yield* parkRepository(pinned ? {...pinned, status: 'pending'} : undefined);
            continue;
          }
          const repository = checked.success;
          if (pinned && pinned.id !== repository.id) {
            yield* denyRepository(name);
            yield* parkRepository({...pinned, status: 'pending'});
            continue;
          }
          let repoState: GitHubRepositoryState = pinned
            ? {...pinned, canonical: repository.name, private: repository.private}
            : {
                name,
                id: repository.id,
                canonical: repository.name,
                private: repository.private,
                backfillComplete: false,
                status: 'active',
              };
          repositories = [...repositories.filter(r => r.name !== name), repoState];
          yield* saveRepositories();
          if (access.deniedRepositoryIds?.includes(repository.id)) {
            if (!access.repositoryDenialGenerations?.[repository.id]) yield* advanceDenial([repository.id]);
            const denialGeneration = access.repositoryDenialGenerations![repository.id];
            if (
              state.revalidatingRepositoryId !== repository.id ||
              state.revalidatingRepositoryGeneration !== denialGeneration
            ) {
              const markers = yield* listGitHubIdMarkers(config, id);
              if (markers === null) return yield* syncError('GitHub ID inventory is invalid.');
              for (const marker of markers.filter(m => m.repositoryId === repository.id))
                yield* quarantine(config, source, marker.documentId);
              repoState = {...repoState, reconcileAfter: undefined, status: 'pending'};
              repositories = repositories.map(r => (r.name === name ? repoState : r));
              yield* saveRepositories();
              state = {
                ...state,
                ...(state.phase === 'reconcile' ? {items: [], offset: 0, hasMore: false, continuation: undefined} : {}),
                revalidatingRepositoryId: repository.id,
                revalidatingRepositoryGeneration: denialGeneration,
              };
              yield* writeGitHubSyncState(config, id, state, fence);
            }
          }
          const deferNumber = Effect.fn('github.deferNumber')(function* (number: number) {
            const nextAttemptAt = (yield* Clock.currentTimeMillis) + 60_000;
            const unresolved = (repoState.unresolvedNumbers ?? []).filter(item => item.number !== number);
            if (unresolved.length >= 100) return false;
            repoState = {...repoState, unresolvedNumbers: [...unresolved, {number, nextAttemptAt}], status: 'pending'};
            repositories = repositories.map(r => (r.name === name ? repoState : r));
            yield* saveRepositories();
            const markers = yield* listGitHubIdMarkers(config, id);
            if (markers === null) return yield* syncError('GitHub ID inventory is invalid.');
            for (const marker of markers.filter(m => m.repositoryId === repository.id && m.number === number)) {
              yield* quarantine(config, source, marker.documentId);
              yield* writeGitHubIdMarker(config, id, {...marker, pending: true, nextAttemptAt}, fence);
            }
            state = {...state, incomplete: true};
            warnings.push(`GitHub repository ${name} conversation #${number} refresh deferred.`);
            return true;
          });
          let retries = 0;
          const retryLimit = Math.min(8, Math.floor(repositoryRequestLimit / 4));
          for (const unresolved of repoState.unresolvedNumbers ?? []) {
            state = {...state, incomplete: true};
            if (unresolved.nextAttemptAt > (yield* Clock.currentTimeMillis)) continue;
            if (!canRequestRepository() || retries >= retryLimit) break;
            retries++;
            const candidate = yield* call(() => client.candidate(repository.name, unresolved.number));
            if (Result.isFailure(candidate)) {
              if (candidate.failure.code === 'authentication-rejected') return yield* denyGlobal();
              if (candidate.failure.code === 'quota-rejected') {
                yield* quota(candidate.failure);
                return yield* checkpoint();
              }
              if (candidate.failure.code === 'access-rejected') {
                yield* denyRepository(name);
                repoState = {...repoState, status: 'pending'};
                yield* deferNumber(unresolved.number);
                yield* parkRepository(repoState);
                continue repositoryLoop;
              }
              yield* deferNumber(unresolved.number);
              continue;
            }
            yield* writeGitHubIdMarker(
              config,
              id,
              {
                ...candidate.success,
                documentId: githubDocumentId(repository.id, candidate.success),
                repositoryId: repository.id,
                repository: name,
                pending: true,
              },
              fence,
            );
            repoState = {
              ...repoState,
              unresolvedNumbers: repoState.unresolvedNumbers?.filter(item => item.number !== unresolved.number),
            };
            repositories = repositories.map(r => (r.name === name ? repoState : r));
            yield* saveRepositories();
          }
          while (canRequestRepository()) {
            if (state.items.length === 0 && state.numbers === undefined) {
              if (state.phase === 'reconcile') {
                const markers = yield* listGitHubIdMarkers(config, id);
                if (markers === null) return yield* syncError('GitHub ID inventory is invalid.');
                const selected = markers.filter(
                  m =>
                    m.repositoryId === repository.id &&
                    (!repoState.reconcileAfter || m.documentId > repoState.reconcileAfter),
                );
                state = {
                  ...state,
                  items: selected.slice(0, 100).map(m => ({id: m.id, number: m.number, kind: m.kind})),
                  hasMore: selected.length > 100,
                };
              } else {
                const since = DateTime.formatIso(
                  DateTime.makeUnsafe(
                    Math.max(
                      0,
                      ((state.phase === 'comments'
                        ? repoState.commentsWatermark
                        : state.phase === 'review-comments'
                          ? repoState.reviewCommentsWatermark
                          : repoState.issueWatermark) ??
                        repoState.watermark ??
                        0) - 120_000,
                    ),
                  ),
                );
                const listed: Result.Result<
                  | {items: GitHubCandidate[]; hasMore: boolean; continuation?: string}
                  | {numbers: number[]; hasMore: boolean; continuation?: string},
                  GitHubClientError
                > =
                  state.phase === 'backfill' || state.phase === 'issues'
                    ? yield* call(() =>
                        client.listIssues(
                          repository.name,
                          state.page,
                          state.phase === 'backfill' ? undefined : since,
                          state.continuation,
                        ),
                      )
                    : yield* call(() =>
                        client.listChangedNumbers(
                          repository.name,
                          state.phase === 'comments' ? 'comments' : 'review-comments',
                          state.page,
                          since,
                          state.continuation,
                        ),
                      );
                if (Result.isFailure(listed)) {
                  if (listed.failure.code === 'authentication-rejected') return yield* denyGlobal();
                  if (listed.failure.code === 'quota-rejected') yield* quota(listed.failure);
                  else if (['access-rejected', 'not-found'].includes(listed.failure.code)) {
                    yield* denyRepository(name);
                    yield* parkRepository({...repoState, status: 'pending'});
                    warnings.push(`GitHub repository ${name} inventory is incomplete.`);
                    continue repositoryLoop;
                  }
                  warnings.push(`GitHub repository ${name} inventory is incomplete.`);
                  return yield* checkpoint();
                }
                if ('items' in listed.success)
                  state = {
                    ...state,
                    items: listed.success.items,
                    hasMore: listed.success.hasMore,
                    continuation: listed.success.continuation,
                  };
                else {
                  state = {
                    ...state,
                    numbers: listed.success.numbers,
                    hasMore: listed.success.hasMore,
                    continuation: listed.success.continuation,
                  };
                }
              }
              yield* writeGitHubSyncState(config, id, state, fence);
            }
            while (state.numbers && state.numbers.length > 0) {
              if (!canRequestRepository()) {
                yield* parkRepository(repoState);
                continue repositoryLoop;
              }
              const candidate = yield* call(() => client.candidate(repository.name, state.numbers![0]));
              if (Result.isFailure(candidate)) {
                if (candidate.failure.code === 'authentication-rejected') return yield* denyGlobal();
                if (candidate.failure.code === 'quota-rejected') {
                  yield* quota(candidate.failure);
                  return yield* checkpoint();
                }
                if (candidate.failure.code === 'access-rejected') {
                  yield* denyRepository(name);
                  repoState = {...repoState, status: 'pending'};
                  yield* deferNumber(state.numbers[0]);
                  yield* parkRepository(repoState);
                  continue repositoryLoop;
                }
                if (!(yield* deferNumber(state.numbers[0]))) {
                  warnings.push(`GitHub repository ${name} unresolved retry inventory is full.`);
                  yield* parkRepository(repoState);
                  continue repositoryLoop;
                }
                state = {...state, numbers: state.numbers.slice(1)};
                yield* writeGitHubSyncState(config, id, state, fence);
                continue;
              }
              state = {...state, items: [...state.items, candidate.success], numbers: state.numbers.slice(1)};
              yield* writeGitHubSyncState(config, id, state, fence);
            }
            if (state.numbers !== undefined) {
              state = {...state, numbers: undefined};
              yield* writeGitHubSyncState(config, id, state, fence);
            }
            while (state.offset < state.items.length && canRequestRepository()) {
              const item = state.items[state.offset];
              const remaining = Math.min(
                (options.maxRequests ?? 256) - client.requests,
                options.budget ? options.budget.maxRequests - options.budget.requests : Infinity,
              );
              if (remaining < (item.kind === 'issue' ? 4 : 12)) break;
              const outcome = yield* refresh(repository, item, name);
              if (outcome === 'auth') return yield* denyGlobal();
              if (outcome === 'stop') return yield* checkpoint();
              if (outcome === 'denied') {
                yield* parkRepository({...repoState, status: 'pending'});
                continue repositoryLoop;
              }
              if (state.phase === 'reconcile')
                repoState = {...repoState, reconcileAfter: githubDocumentId(repository.id, item)};
              state = {...state, offset: state.offset + 1};
              yield* writeGitHubSyncState(config, id, state, fence);
              repositories = repositories.map(r => (r.name === name ? repoState : r));
              yield* saveRepositories();
            }
            if (state.offset < state.items.length) break;
            if (state.hasMore) {
              state = {...state, page: state.page + 1, offset: 0, items: [], hasMore: false};
              yield* writeGitHubSyncState(config, id, state, fence);
              continue;
            }
            if (state.phase === 'backfill' || state.phase === 'issues')
              repoState = {
                ...repoState,
                issueWatermark: state.boundary,
                ...(state.phase === 'backfill' ? {backfillComplete: true} : {}),
              };
            if (state.phase === 'comments') repoState = {...repoState, commentsWatermark: state.boundary};
            if (state.phase === 'review-comments') repoState = {...repoState, reviewCommentsWatermark: state.boundary};
            if (state.phase === 'reconcile') {
              repoState = {
                ...repoState,
                reconcileAfter: undefined,
                parked: undefined,
                status: state.incomplete || repoState.unresolvedNumbers?.length ? 'pending' : 'active',
                ...(!state.incomplete
                  ? {watermark: state.boundary, lastReconciledAt: yield* Clock.currentTimeMillis}
                  : {}),
              };
              repositories = repositories.map(r => (r.name === name ? repoState : r));
              yield* saveRepositories();
              yield* clearGitHubRepositoryCheckpoint(config, id, repository.id, repositoryIndex, fence);
              if (
                access.deniedRepositoryIds?.includes(repository.id) &&
                state.revalidatingRepositoryId === repository.id &&
                state.revalidatingRepositoryGeneration === access.repositoryDenialGenerations?.[repository.id]
              ) {
                access = {
                  ...access,
                  deniedRepositoryIds: access.deniedRepositoryIds?.filter(repoId => repoId !== repository.id),
                };
                yield* saveReceipt(config, source, access);
              }
              state = yield* initial(state.repositoryIndex + 1);
              yield* writeGitHubSyncState(config, id, state, fence);
              break;
            }
            const next = {
              backfill: 'comments',
              issues: 'comments',
              comments: 'review-comments',
              'review-comments': 'reconcile',
            } as const;
            state = {
              ...state,
              phase: next[state.phase],
              page: 1,
              offset: 0,
              items: [],
              hasMore: false,
              continuation: undefined,
            };
            yield* writeGitHubSyncState(config, id, state, fence);
            repositories = repositories.map(r => (r.name === name ? repoState : r));
            yield* saveRepositories();
          }
          if (state.repositoryIndex === repositoryIndex) yield* parkRepository(repoState);
        }
        return yield* checkpoint(state.repositoryIndex >= source.repositories.length);
      }).pipe(Effect.ensuring(Effect.sync(() => client.close())));
    }),
  );
});
