import {
  SourceCoordinator,
  SourceCoordinatorError,
  sourceAccountKey,
  withSourceCredentialEnvironment,
  type SourceWorkOptions,
} from '@threadnote/integration-core/source-coordinator';
import {Option} from 'effect';
import {isGitHubSource} from './config.js';
import {Clock, Console, DateTime, Effect, FileSystem, Path, Random, Redacted, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceStore} from '@threadnote/store/resource-store';
import {removeSourceEvidencePins} from '@threadnote/store/source-evidence';
import {
  externalSourceReceiptUri,
  readExternalDocumentManifest,
  readExternalSourceReceipt,
  serializeExternalSourceReceipt,
  type ExternalSourceReceipt,
} from '@threadnote/store/external-resource';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  mutateSourceConfiguration,
  readSourceConfiguration,
  requireGitHubSource,
  sourceConfigurationFingerprint,
  upsertGitHubSource,
  validateSourceIdentifier,
  validateGitHubSourceConfig,
  type GitHubSourceConfig,
  type SourceConfig,
} from './config.js';
import {withSourceLock} from '@threadnote/integration-core/lock';
import {makeGitHubClientBudget, type GitHubClientOptions} from './client.js';
import {syncGitHubSource} from './sync.js';
import {listGitHubIdMarkers, readGitHubSyncState, readGitHubRepositoryStates} from './state.js';
import {
  removeGitHubCredential,
  resolveGitHubCredential,
  storeGitHubCredential,
  validGitHubApiToken,
} from './credentials.js';

export interface GitHubSourceAddOptions {
  readonly id: string;
  readonly repositories: readonly string[];
  readonly apply?: boolean;
  readonly enabled?: boolean;
  readonly expectedFingerprint?: string | null;
  readonly apiToken?: Redacted.Redacted<string>;
  readonly credentialStorage?: 'local';
  readonly credentialEnv?: string;
  readonly project?: string;
  readonly projectless?: boolean;
  readonly refreshIntervalMinutes?: number;
  readonly maxStaleHours?: number;
}
export interface GitHubSourceCommandOptions {
  readonly id: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly clientOptions?: GitHubClientOptions;
}
export interface GitHubInventoryEntry {
  readonly documentId: string;
  readonly repository?: string;
  readonly status: 'missing' | 'active' | 'quarantined' | 'pending' | 'stale';
  readonly chunks: number;
  readonly nextAttemptAt?: number;
}
export interface GitHubInventory {
  readonly source: GitHubSourceConfig;
  readonly entries: readonly GitHubInventoryEntry[];
  readonly progress?: {readonly repository: string; readonly page: number; readonly offset: number};
  readonly lastReconciledAt?: number;
  readonly repositories?: readonly {
    readonly repository: string;
    readonly backfillComplete: boolean;
    readonly lastReconciledAt?: number;
    readonly status: 'active' | 'pending';
  }[];
  readonly nextAttemptAt?: number;
}
export interface GitHubSyncResult {
  readonly sourceId: string;
  readonly syncedDocuments: readonly string[];
  readonly warnings: readonly string[];
  readonly progress?: {readonly repository: string; readonly page: number; readonly offset: number};
  readonly lastReconciledAt?: number;
  readonly repositories?: readonly {
    readonly repository: string;
    readonly backfillComplete: boolean;
    readonly lastReconciledAt?: number;
    readonly status: 'active' | 'pending';
  }[];
}
class GitHubSourceError extends Schema.TaggedError<GitHubSourceError>()('GitHubSourceError', {
  message: Schema.String,
}) {}
export class GitHubSourceConflictError extends Schema.TaggedError<GitHubSourceConflictError>()(
  'GitHubSourceConflictError',
  {},
) {}
const error = (message: string) => GitHubSourceError.make({message});
const syncResult = (value: GitHubSyncResult): GitHubSyncResult => value;
const loc = (config: RuntimeConfig) => ({account: config.account, home: config.agentContextHome, user: config.user});
const root = (id: string) => `threadnote://resources/external/github/${id}`;
const receiptUri = (id: string) => externalSourceReceiptUri(id, 'github');
const manifest = (config: RuntimeConfig, id: string, doc: string) =>
  readExternalDocumentManifest(loc(config), id, doc, 'github');
const receipt = (config: RuntimeConfig, id: string) => readExternalSourceReceipt(loc(config), id, 'github');

const configFence = Effect.fn('github.configFence')(function* (
  config: RuntimeConfig,
  id: string,
  fingerprint: string,
  enabled = true,
) {
  const source = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
  if (
    !source ||
    !isGitHubSource(source) ||
    (enabled && !source.enabled) ||
    sourceConfigurationFingerprint(source) !== fingerprint
  )
    return yield* error('GitHub source configuration changed during refresh.');
});
function containsCredential(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some(item => containsCredential(item, secret));
  return (
    value !== null && typeof value === 'object' && Object.values(value).some(item => containsCredential(item, secret))
  );
}
const checkCredentialSafety = Effect.fn('github.checkCredentialSafety')(function* (
  config: RuntimeConfig,
  source: GitHubSourceConfig,
  existing: GitHubSourceConfig | undefined,
  options: GitHubSourceAddOptions,
) {
  const effective =
    options.apiToken ?? (yield* resolveGitHubCredential(config, source).pipe(Effect.orElseSucceed(() => undefined)));
  const previous =
    existing === undefined
      ? undefined
      : yield* resolveGitHubCredential(config, existing).pipe(Effect.orElseSucceed(() => undefined));
  if (source.credentialStorage === 'local' && effective === undefined)
    return yield* error('A protected API key is required for this GitHub source.');
  for (const token of [effective, previous]) {
    if (token === undefined) continue;
    const secret = Redacted.value(token);
    if (containsCredential(source, secret) || containsCredential({...options, apiToken: undefined}, secret))
      return yield* error('GitHub source configuration contains credential material.');
  }
});
function sourceFor(options: GitHubSourceAddOptions, id: string, existing?: GitHubSourceConfig): GitHubSourceConfig {
  if (options.projectless === true && options.project) throw error('Choose either --project or --projectless.');
  if (options.projectless !== true && !options.project) throw error('Choose --project or --projectless.');
  return validateGitHubSourceConfig({
    type: 'github',
    id,
    repositories: options.repositories,
    enabled: options.enabled ?? true,
    credentialEnv: options.credentialEnv ?? existing?.credentialEnv ?? 'THREADNOTE_GITHUB_TOKEN',
    ...(options.apiToken !== undefined ||
    options.credentialStorage === 'local' ||
    (options.credentialEnv === undefined && existing?.credentialStorage === 'local')
      ? {credentialStorage: 'local' as const}
      : {}),
    project: options.projectless === true ? null : validateSourceIdentifier(options.project!, 'project'),
    refreshIntervalMinutes: options.refreshIntervalMinutes ?? existing?.refreshIntervalMinutes ?? 15,
    maxStaleHours: options.maxStaleHours ?? existing?.maxStaleHours ?? 24,
  });
}

export const runGitHubSourceAdd = Effect.fn('github.add')(function* (
  config: RuntimeConfig,
  options: GitHubSourceAddOptions,
) {
  const id = validateSourceIdentifier(options.id, 'source id');
  if (options.apiToken !== undefined && !validGitHubApiToken(options.apiToken))
    return yield* error('Invalid GitHub API key.');
  const initial = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
  const expected = (item: SourceConfig | undefined) => {
    if (
      options.expectedFingerprint !== undefined &&
      (item === undefined ? null : isGitHubSource(item) ? sourceConfigurationFingerprint(item) : '') !==
        options.expectedFingerprint
    )
      throw GitHubSourceConflictError.make({});
  };
  expected(initial);
  const preview = sourceFor(options, id, initial !== undefined && isGitHubSource(initial) ? initial : undefined);
  yield* checkCredentialSafety(
    config,
    preview,
    initial !== undefined && isGitHubSource(initial) ? initial : undefined,
    options,
  );
  if (options.apply !== true) {
    yield* Console.log(`Would configure GitHub source "${id}" for selected repositories. Re-run with --apply.`);
    return;
  }
  yield* withSourceLock(
    config,
    id,
    Effect.gen(function* () {
      const existing = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
      expected(existing);
      if (existing && !isGitHubSource(existing)) return yield* error(`Source "${id}" already has another type.`);
      const source = sourceFor(options, id, existing);
      yield* checkCredentialSafety(config, source, existing, options);
      const previousFingerprint = existing ? sourceConfigurationFingerprint(existing) : undefined;
      const prior = yield* receipt(config, id);
      const cleanup =
        !existing ||
        prior === null ||
        prior?.status !== 'active' ||
        previousFingerprint !== sourceConfigurationFingerprint(source) ||
        options.apiToken !== undefined;
      const store = yield* ResourceStore;
      if (cleanup) {
        const denied: ExternalSourceReceipt = {
          version: 1,
          provider: 'github',
          sourceId: id,
          accessEpoch: sha256HexSync(`${yield* Clock.currentTimeMillis}:${yield* Random.next}`),
          status: 'cleanup',
        };
        yield* store.mutateChecked(
          loc(config),
          [
            {
              type: 'write',
              uri: receiptUri(id),
              content: serializeExternalSourceReceipt(denied),
              options: {mode: 'upsert'},
            },
          ],
          previousFingerprint ? configFence(config, id, previousFingerprint, false) : Effect.void,
        );
      }
      if (options.apiToken !== undefined) yield* storeGitHubCredential(config, id, options.apiToken);
      else if (source.credentialStorage !== 'local') yield* removeGitHubCredential(config, id);
      yield* mutateSourceConfiguration(config, current => {
        const latest = current.sources.find(item => item.id === id);
        if (
          (latest !== undefined && isGitHubSource(latest) ? sourceConfigurationFingerprint(latest) : undefined) !==
          previousFingerprint
        )
          throw error('GitHub source configuration changed before update.');
        return upsertGitHubSource(current, source);
      });
      if (cleanup) {
        yield* store.mutateChecked(
          loc(config),
          [{type: 'remove', uri: root(id), options: {recursive: true}, ignoreMissing: true}],
          configFence(config, id, sourceConfigurationFingerprint(source), false),
        );
        const active: ExternalSourceReceipt = {
          version: 1,
          provider: 'github',
          sourceId: id,
          accessEpoch: sha256HexSync(`${yield* Clock.currentTimeMillis}:${yield* Random.next}`),
          status: 'active',
        };
        yield* store.mutateChecked(
          loc(config),
          [
            {
              type: 'write',
              uri: receiptUri(id),
              content: serializeExternalSourceReceipt(active),
              options: {mode: 'upsert'},
            },
          ],
          configFence(config, id, sourceConfigurationFingerprint(source), false),
        );
      }
    }),
  );
  yield* Console.log(`Configured GitHub source "${id}".`);
});

const listLocalDocs = Effect.fn('github.localDocs')(function* (config: RuntimeConfig, source: GitHubSourceConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    config.agentContextHome,
    'data',
    config.account,
    'resources',
    'external',
    'github',
    source.id,
    'docs',
  );
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as string[]));
  return names.filter(name => /^r-[0-9]+-(?:issue|pull)-[0-9]+$/.test(name)).sort();
});

export const runGitHubSourceSync = Effect.fn('github.sync')(function* (
  config: RuntimeConfig,
  options: GitHubSourceCommandOptions,
) {
  const source = requireGitHubSource(yield* readSourceConfiguration(config), options.id);
  if (options.apply !== true || options.dryRun === true) {
    const inventory = yield* runGitHubSourceInventory(config, options.id);
    yield* Console.log(
      `Dry run: ${inventory.entries.length} cached GitHub conversation(s). Re-run with --apply to refresh.`,
    );
    return syncResult({sourceId: source.id, syncedDocuments: [], warnings: []});
  }
  const coordinator = yield* Effect.serviceOption(SourceCoordinator);
  let coordinatedResult: GitHubSyncResult | undefined;
  if (Option.isSome(coordinator)) {
    const reply = yield* coordinator.value.sync(config, source.id);
    if (reply.value === undefined)
      return yield* SourceCoordinatorError.make({message: 'Source sync reply expired. Retry the source sync.'});
    coordinatedResult = reply.value as GitHubSyncResult;
  }
  const result = coordinatedResult ?? (yield* syncGitHubSource(config, source.id, options.clientOptions));
  yield* Console.log(`GitHub source "${source.id}": ${result.syncedDocuments.length} conversation(s) refreshed.`);
  for (const warning of result.warnings) yield* Console.warn(warning);
  if (result.progress)
    yield* Console.log(
      `Import continues in ${result.progress.repository} at page ${result.progress.page}, item ${result.progress.offset + 1}.`,
    );
  const retryAt = (yield* receipt(config, source.id))?.nextAttemptAt;
  if (retryAt) yield* Console.log(`Provider retry after ${DateTime.formatIso(DateTime.makeUnsafe(retryAt))}.`);
  return result;
});

export const runGitHubSourceInventory = Effect.fn('github.inventory')(function* (config: RuntimeConfig, id: string) {
  const source = requireGitHubSource(yield* readSourceConfiguration(config), id);
  const access = yield* receipt(config, id);
  const now = yield* Clock.currentTimeMillis;
  const entries: GitHubInventoryEntry[] = [];
  for (const doc of yield* listLocalDocs(config, source)) {
    const state = yield* manifest(config, id, doc);
    entries.push({
      documentId: doc,
      status: !state
        ? 'missing'
        : access?.status !== 'active' ||
            state.accessEpoch !== access.accessEpoch ||
            access.deniedRepositoryIds?.some(repositoryId => doc.startsWith(`r-${repositoryId}-`))
          ? 'quarantined'
          : now - state.fetchedAt > source.maxStaleHours * 3_600_000
            ? 'stale'
            : state.status,
      chunks: Object.keys(state?.chunks ?? {}).length,
      ...(state?.nextAttemptAt ? {nextAttemptAt: state.nextAttemptAt} : {}),
    });
  }
  const markers = yield* listGitHubIdMarkers(config, id);
  if (markers)
    for (const marker of markers) {
      const entry = entries.find(entry => entry.documentId === marker.documentId);
      if (entry) {
        Object.assign(entry, {
          repository: marker.repository,
          ...(marker.nextAttemptAt ? {nextAttemptAt: marker.nextAttemptAt} : {}),
        });
        continue;
      }
      entries.push({
        documentId: marker.documentId,
        status: 'pending',
        chunks: 0,
        ...(marker.nextAttemptAt ? {nextAttemptAt: marker.nextAttemptAt} : {}),
      });
    }
  const syncState = yield* readGitHubSyncState(config, id);
  const repositories = yield* readGitHubRepositoryStates(config, id);
  const reconciled =
    repositories?.map(item => item.lastReconciledAt).filter((time): time is number => time !== undefined) ?? [];
  return {
    source,
    entries,
    repositories: (repositories ?? []).map(item => ({
      repository: item.name,
      backfillComplete: item.backfillComplete,
      status: item.status,
      ...(item.lastReconciledAt === undefined ? {} : {lastReconciledAt: item.lastReconciledAt}),
    })),
    ...(reconciled.length === source.repositories.length ? {lastReconciledAt: Math.min(...reconciled)} : {}),
    ...(syncState
      ? {
          progress: {
            repository: source.repositories[syncState.repositoryIndex] ?? '',
            page: syncState.page,
            offset: syncState.offset,
          },
        }
      : {}),
    ...(access?.nextAttemptAt ? {nextAttemptAt: access.nextAttemptAt} : {}),
  } satisfies GitHubInventory;
});
export const runGitHubSourceStatus = Effect.fn('github.status')(function* (config: RuntimeConfig, id: string) {
  const inventory = yield* runGitHubSourceInventory(config, id);
  yield* Console.log(`GitHub source "${id}": ${inventory.entries.length} cached item(s).`);
  for (const entry of inventory.entries)
    yield* Console.log(`${entry.documentId}: ${entry.status}; ${entry.chunks} local chunk(s)`);
  if (inventory.progress)
    yield* Console.log(`Import continues at page ${inventory.progress.page}, item ${inventory.progress.offset + 1}.`);
  if (inventory.nextAttemptAt)
    yield* Console.log(`Provider retry after ${DateTime.formatIso(DateTime.makeUnsafe(inventory.nextAttemptAt))}.`);
  return inventory;
});

export const runGitHubSourceRemove = Effect.fn('github.remove')(function* (
  config: RuntimeConfig,
  options: GitHubSourceCommandOptions,
) {
  const source = requireGitHubSource(yield* readSourceConfiguration(config), options.id);
  if (options.apply !== true || options.dryRun === true) {
    yield* Console.log(`Would remove GitHub source "${source.id}". Re-run with --apply.`);
    return;
  }
  yield* withSourceLock(
    config,
    source.id,
    Effect.gen(function* () {
      const current = requireGitHubSource(yield* readSourceConfiguration(config), source.id);
      const fingerprint = sourceConfigurationFingerprint(current);
      const prior = yield* receipt(config, source.id);
      const denied: ExternalSourceReceipt = {
        version: 1,
        provider: 'github',
        sourceId: source.id,
        accessEpoch: prior?.accessEpoch ?? sha256HexSync(`${yield* Clock.currentTimeMillis}:${yield* Random.next}`),
        status: 'cleanup',
      };
      yield* (yield* ResourceStore).mutateChecked(
        loc(config),
        [
          {
            type: 'write',
            uri: receiptUri(source.id),
            content: serializeExternalSourceReceipt(denied),
            options: {mode: 'upsert'},
          },
        ],
        configFence(config, source.id, fingerprint, false),
      );
      yield* mutateSourceConfiguration(config, configuration =>
        upsertGitHubSource(configuration, {...current, enabled: false}),
      );
      yield* removeGitHubCredential(config, source.id);
      yield* (yield* ResourceStore).mutateChecked(
        loc(config),
        [{type: 'remove', uri: root(source.id), options: {recursive: true}, ignoreMissing: true}],
        configFence(config, source.id, sourceConfigurationFingerprint({...current, enabled: false}), false),
      );
      yield* mutateSourceConfiguration(config, configuration => ({
        version: 2,
        projections: configuration.projections,
        sources: configuration.sources.filter(item => item.id !== source.id),
      }));
      yield* removeSourceEvidencePins(loc(config), 'github', source.id);
    }),
  );
  yield* Console.log(`Removed GitHub source "${source.id}".`);
});

export const syncGitHubSourcesBeforeRecall = Effect.fn('github.beforeRecall')(function* (
  config: RuntimeConfig,
  clientOptions: GitHubClientOptions = {},
) {
  const syncedSources: string[] = [];
  const warnings: string[] = [];
  const sources = (yield* readSourceConfiguration(config)).sources.filter(
    (source): source is GitHubSourceConfig => isGitHubSource(source) && source.enabled,
  );
  const budget = makeGitHubClientBudget(20_000, 16);
  const start = beforeRecallStart++ % Math.max(1, sources.length);
  for (let index = 0; index < sources.length; index++) {
    const source = sources[(start + index) % sources.length];
    if (
      budget.requests >= budget.maxRequests ||
      budget.responseBytes >= budget.maxResponseBytes ||
      (yield* Clock.currentTimeMillis) >= budget.deadlineAt
    )
      break;
    if (!isGitHubSource(source) || !source.enabled) continue;
    const perSource = Math.min(16, budget.maxRequests - budget.requests);
    const result = yield* syncGitHubSource(
      config,
      source.id,
      {
        ...clientOptions,
        maxRequests: perSource,
        totalTimeoutMilliseconds: Math.max(1, budget.deadlineAt - (yield* Clock.currentTimeMillis)),
        budget,
      },
      true,
    ).pipe(Effect.result);
    if (Result.isFailure(result)) warnings.push(`GitHub source "${source.id}" refresh unavailable.`);
    else {
      if (result.success.syncedDocuments.length) syncedSources.push(source.id);
      warnings.push(...result.success.warnings);
    }
  }
  return {syncedSources, warnings};
});
let beforeRecallStart = 0;

export const githubSourceWork = {
  provider: 'github',
  admission: {limit: 16, windowMs: 20000},
  list: Effect.fn('github.workDescriptors')(function* (config: RuntimeConfig) {
    const sources = (yield* readSourceConfiguration(config)).sources.filter(
      (source): source is GitHubSourceConfig => isGitHubSource(source) && source.enabled,
    );
    return yield* Effect.forEach(sources, source =>
      Effect.gen(function* () {
        const token = yield* resolveGitHubCredential(config, source).pipe(Effect.orElseSucceed(() => undefined));
        return {
          sourceId: source.id,
          provider: 'github',
          accountKey:
            token === undefined ? sha256HexSync('github:missing:' + source.id) : sourceAccountKey('github', token),
          fingerprint: sourceConfigurationFingerprint(source),
          refreshIntervalMs: source.refreshIntervalMinutes * 60_000,
          ...(source.credentialStorage === 'local' ? {} : {credentialEnv: source.credentialEnv}),
        };
      }),
    );
  }),
  run: Effect.fn('github.workQuantum')(function* (config: RuntimeConfig, sourceId: string, options: SourceWorkOptions) {
    const source = requireGitHubSource(yield* readSourceConfiguration(config), sourceId);
    return yield* withSourceCredentialEnvironment(
      Effect.gen(function* () {
        const result = yield* syncGitHubSource(
          config,
          sourceId,
          {
            totalTimeoutMilliseconds: 10000,
            maxRequests: 16,
            budget: makeGitHubClientBudget(10000, 16),
          },
          options.mode === 'automatic',
        );
        const inventory = yield* runGitHubSourceInventory(config, sourceId);
        const now = yield* Clock.currentTimeMillis;
        const retryTimes = inventory.entries.flatMap(entry =>
          entry.nextAttemptAt !== undefined && entry.nextAttemptAt > now ? [entry.nextAttemptAt] : [],
        );
        const nextAttemptAt =
          inventory.nextAttemptAt ??
          (result.syncedDocuments.length === 0 && retryTimes.length > 0 ? Math.min(...retryTimes) : undefined);
        const more = result.progress !== undefined;
        return {
          sourceId,
          syncedDocuments: result.syncedDocuments,
          warnings: result.warnings,
          value: result,
          ...(nextAttemptAt === undefined ? {} : {nextAttemptAt}),
          more,
        };
      }),
      source.credentialEnv,
      options.credentialEnvironment,
    );
  }),
};
