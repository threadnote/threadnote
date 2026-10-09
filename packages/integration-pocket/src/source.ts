import {
  SourceCoordinator,
  SourceCoordinatorError,
  sourceAccountKey,
  withSourceCredentialEnvironment,
  type SourceWorkOptions,
} from '@threadnote/integration-core/source-coordinator';
import {Option} from 'effect';
import {isPocketSource} from './config.js';
import {Clock, Console, DateTime, Effect, FileSystem, Path, Random, Redacted, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceStore} from '@threadnote/store/resource-store';
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
  requirePocketSource,
  sourceConfigurationFingerprint,
  upsertPocketSource,
  validateSourceIdentifier,
  validatePocketSourceConfig,
  type PocketSourceConfig,
  type SourceConfig,
} from './config.js';
import {withSourceLock} from '@threadnote/integration-core/lock';
import {makePocketClientBudget, type PocketClientOptions} from './client.js';
import {syncPocketSource} from './sync.js';
import {listPocketIdMarkers} from './state.js';
import {
  removePocketCredential,
  resolvePocketCredential,
  storePocketCredential,
  validPocketApiToken,
} from './credentials.js';

export interface PocketSourceAddOptions {
  readonly id: string;
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
export interface PocketSourceCommandOptions {
  readonly id: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly clientOptions?: PocketClientOptions;
}
export interface PocketInventoryEntry {
  readonly documentId: string;
  readonly status: 'missing' | 'active' | 'quarantined' | 'pending' | 'stale';
  readonly chunks: number;
  readonly nextAttemptAt?: number;
}
export interface PocketInventory {
  readonly source: PocketSourceConfig;
  readonly entries: readonly PocketInventoryEntry[];
  readonly progress?: {readonly page: number; readonly offset: number};
  readonly nextAttemptAt?: number;
}
export interface PocketSyncResult {
  readonly sourceId: string;
  readonly syncedDocuments: readonly string[];
  readonly warnings: readonly string[];
  readonly progress?: {readonly page: number; readonly offset: number};
}
class PocketSourceError extends Schema.TaggedError<PocketSourceError>()('PocketSourceError', {
  message: Schema.String,
}) {}
export class PocketSourceConflictError extends Schema.TaggedError<PocketSourceConflictError>()(
  'PocketSourceConflictError',
  {},
) {}
const error = (message: string) => PocketSourceError.make({message});
const loc = (config: RuntimeConfig) => ({account: config.account, home: config.agentContextHome, user: config.user});
const root = (id: string) => `threadnote://resources/external/pocket/${id}`;
const receiptUri = (id: string) => externalSourceReceiptUri(id, 'pocket');
const manifest = (config: RuntimeConfig, id: string, doc: string) =>
  readExternalDocumentManifest(loc(config), id, doc, 'pocket');
const receipt = (config: RuntimeConfig, id: string) => readExternalSourceReceipt(loc(config), id, 'pocket');

const configFence = Effect.fn('pocket.configFence')(function* (
  config: RuntimeConfig,
  id: string,
  fingerprint: string,
  enabled = true,
) {
  const source = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
  if (
    !source ||
    !isPocketSource(source) ||
    (enabled && !source.enabled) ||
    sourceConfigurationFingerprint(source) !== fingerprint
  )
    return yield* error('Pocket source configuration changed during refresh.');
});
function containsCredential(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some(item => containsCredential(item, secret));
  return (
    value !== null && typeof value === 'object' && Object.values(value).some(item => containsCredential(item, secret))
  );
}
const checkCredentialSafety = Effect.fn('pocket.checkCredentialSafety')(function* (
  config: RuntimeConfig,
  source: PocketSourceConfig,
  existing: PocketSourceConfig | undefined,
  options: PocketSourceAddOptions,
) {
  const effective =
    options.apiToken ?? (yield* resolvePocketCredential(config, source).pipe(Effect.orElseSucceed(() => undefined)));
  const previous =
    existing === undefined
      ? undefined
      : yield* resolvePocketCredential(config, existing).pipe(Effect.orElseSucceed(() => undefined));
  if (source.credentialStorage === 'local' && effective === undefined)
    return yield* error('A protected API key is required for this Pocket source.');
  for (const token of [effective, previous]) {
    if (token === undefined) continue;
    const secret = Redacted.value(token);
    if (containsCredential(source, secret) || containsCredential({...options, apiToken: undefined}, secret))
      return yield* error('Pocket source configuration contains credential material.');
  }
});
function sourceFor(options: PocketSourceAddOptions, id: string, existing?: PocketSourceConfig): PocketSourceConfig {
  if (options.projectless === true && options.project) throw error('Choose either --project or --projectless.');
  if (options.projectless !== true && !options.project) throw error('Choose --project or --projectless.');
  return validatePocketSourceConfig({
    type: 'pocket',
    id,
    enabled: options.enabled ?? true,
    credentialEnv: options.credentialEnv ?? existing?.credentialEnv ?? 'POCKET_API_KEY',
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

export const runPocketSourceAdd = Effect.fn('pocket.add')(function* (
  config: RuntimeConfig,
  options: PocketSourceAddOptions,
) {
  const id = validateSourceIdentifier(options.id, 'source id');
  if (options.apiToken !== undefined && !validPocketApiToken(options.apiToken))
    return yield* error('Invalid Pocket API key.');
  const initial = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
  const expected = (item: SourceConfig | undefined) => {
    if (
      options.expectedFingerprint !== undefined &&
      (item === undefined ? null : isPocketSource(item) ? sourceConfigurationFingerprint(item) : '') !==
        options.expectedFingerprint
    )
      throw PocketSourceConflictError.make({});
  };
  expected(initial);
  const preview = sourceFor(options, id, initial !== undefined && isPocketSource(initial) ? initial : undefined);
  yield* checkCredentialSafety(
    config,
    preview,
    initial !== undefined && isPocketSource(initial) ? initial : undefined,
    options,
  );
  if (options.apply !== true) {
    yield* Console.log(`Would configure Pocket source "${id}" for all accessible recordings. Re-run with --apply.`);
    return;
  }
  yield* withSourceLock(
    config,
    id,
    Effect.gen(function* () {
      const existing = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
      expected(existing);
      if (existing && !isPocketSource(existing)) return yield* error(`Source "${id}" already has another type.`);
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
          provider: 'pocket',
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
      if (options.apiToken !== undefined) yield* storePocketCredential(config, id, options.apiToken);
      else if (source.credentialStorage !== 'local') yield* removePocketCredential(config, id);
      yield* mutateSourceConfiguration(config, current => {
        const latest = current.sources.find(item => item.id === id);
        if (
          (latest !== undefined && isPocketSource(latest) ? sourceConfigurationFingerprint(latest) : undefined) !==
          previousFingerprint
        )
          throw error('Pocket source configuration changed before update.');
        return upsertPocketSource(current, source);
      });
      if (cleanup) {
        yield* store.mutateChecked(
          loc(config),
          [{type: 'remove', uri: root(id), options: {recursive: true}, ignoreMissing: true}],
          configFence(config, id, sourceConfigurationFingerprint(source), false),
        );
        const active: ExternalSourceReceipt = {
          version: 1,
          provider: 'pocket',
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
  yield* Console.log(`Configured Pocket source "${id}".`);
});

const listLocalDocs = Effect.fn('pocket.localDocs')(function* (config: RuntimeConfig, source: PocketSourceConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    config.agentContextHome,
    'data',
    config.account,
    'resources',
    'external',
    'pocket',
    source.id,
    'docs',
  );
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as string[]));
  return names.filter(name => /^(?:r-[a-f0-9]{40}|catalog-(?:folders|tags))$/.test(name)).sort();
});

export const runPocketSourceSync = Effect.fn('pocket.sync')(function* (
  config: RuntimeConfig,
  options: PocketSourceCommandOptions,
) {
  const source = requirePocketSource(yield* readSourceConfiguration(config), options.id);
  if (options.apply !== true || options.dryRun === true) {
    const inventory = yield* runPocketSourceInventory(config, options.id);
    yield* Console.log(
      `Dry run: ${inventory.entries.length} cached Pocket recording(s). Re-run with --apply to refresh.`,
    );
    return {sourceId: source.id, syncedDocuments: [], warnings: []} satisfies PocketSyncResult;
  }
  const coordinator = yield* Effect.serviceOption(SourceCoordinator);
  let coordinatedResult: PocketSyncResult | undefined;
  if (Option.isSome(coordinator)) {
    const reply = yield* coordinator.value.sync(config, source.id);
    if (reply.value === undefined)
      return yield* SourceCoordinatorError.make({message: 'Source sync reply expired. Retry the source sync.'});
    coordinatedResult = reply.value as PocketSyncResult;
  }
  const result = coordinatedResult ?? (yield* syncPocketSource(config, source.id, options.clientOptions));
  yield* Console.log(`Pocket source "${source.id}": ${result.syncedDocuments.length} recording(s) refreshed.`);
  return result;
});

export const runPocketSourceInventory = Effect.fn('pocket.inventory')(function* (config: RuntimeConfig, id: string) {
  const source = requirePocketSource(yield* readSourceConfiguration(config), id);
  const access = yield* receipt(config, id);
  const now = yield* Clock.currentTimeMillis;
  const entries: PocketInventoryEntry[] = [];
  for (const doc of yield* listLocalDocs(config, source)) {
    const state = yield* manifest(config, id, doc);
    entries.push({
      documentId: doc,
      status: !state
        ? 'missing'
        : access?.status !== 'active' || state.accessEpoch !== access.accessEpoch
          ? 'quarantined'
          : now - state.fetchedAt > source.maxStaleHours * 3_600_000
            ? 'stale'
            : state.status,
      chunks: Object.keys(state?.chunks ?? {}).length,
      ...(state?.nextAttemptAt ? {nextAttemptAt: state.nextAttemptAt} : {}),
    });
  }
  const markers = yield* listPocketIdMarkers(config, id);
  if (markers)
    for (const marker of markers) {
      if (entries.some(entry => entry.documentId === marker.documentId)) continue;
      entries.push({
        documentId: marker.documentId,
        status: 'pending',
        chunks: 0,
        ...(marker.nextAttemptAt ? {nextAttemptAt: marker.nextAttemptAt} : {}),
      });
    }
  return {
    source,
    entries,
    ...(access?.inventoryPage ? {progress: {page: access.inventoryPage, offset: access.inventoryOffset ?? 0}} : {}),
    ...(access?.nextAttemptAt ? {nextAttemptAt: access.nextAttemptAt} : {}),
  } satisfies PocketInventory;
});
export const runPocketSourceStatus = Effect.fn('pocket.status')(function* (config: RuntimeConfig, id: string) {
  const inventory = yield* runPocketSourceInventory(config, id);
  yield* Console.log(`Pocket source "${id}": ${inventory.entries.length} cached item(s).`);
  for (const entry of inventory.entries)
    yield* Console.log(`${entry.documentId}: ${entry.status}; ${entry.chunks} local chunk(s)`);
  if (inventory.progress)
    yield* Console.log(`Import continues at page ${inventory.progress.page}, item ${inventory.progress.offset + 1}.`);
  if (inventory.nextAttemptAt)
    yield* Console.log(`Provider retry after ${DateTime.formatIso(DateTime.makeUnsafe(inventory.nextAttemptAt))}.`);
  return inventory;
});

export const runPocketSourceRemove = Effect.fn('pocket.remove')(function* (
  config: RuntimeConfig,
  options: PocketSourceCommandOptions,
) {
  const source = requirePocketSource(yield* readSourceConfiguration(config), options.id);
  if (options.apply !== true || options.dryRun === true) {
    yield* Console.log(`Would remove Pocket source "${source.id}". Re-run with --apply.`);
    return;
  }
  yield* withSourceLock(
    config,
    source.id,
    Effect.gen(function* () {
      const current = requirePocketSource(yield* readSourceConfiguration(config), source.id);
      const fingerprint = sourceConfigurationFingerprint(current);
      const prior = yield* receipt(config, source.id);
      const denied: ExternalSourceReceipt = {
        version: 1,
        provider: 'pocket',
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
        upsertPocketSource(configuration, {...current, enabled: false}),
      );
      yield* removePocketCredential(config, source.id);
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
    }),
  );
  yield* Console.log(`Removed Pocket source "${source.id}".`);
});

export const syncPocketSourcesBeforeRecall = Effect.fn('pocket.beforeRecall')(function* (
  config: RuntimeConfig,
  clientOptions: PocketClientOptions = {},
) {
  const syncedSources: string[] = [];
  const warnings: string[] = [];
  const sources = (yield* readSourceConfiguration(config)).sources.filter(
    (source): source is PocketSourceConfig => isPocketSource(source) && source.enabled,
  );
  const budget = makePocketClientBudget(20_000, 16);
  const start = beforeRecallStart++ % Math.max(1, sources.length);
  for (let index = 0; index < sources.length; index++) {
    const source = sources[(start + index) % sources.length];
    if (
      budget.requests >= budget.maxRequests ||
      budget.responseBytes >= budget.maxResponseBytes ||
      (yield* Clock.currentTimeMillis) >= budget.deadlineAt
    )
      break;
    if (!isPocketSource(source) || !source.enabled) continue;
    const perSource = Math.min(4, budget.maxRequests - budget.requests);
    const result = yield* syncPocketSource(
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
    if (Result.isFailure(result)) warnings.push(`Pocket source "${source.id}" refresh unavailable.`);
    else {
      if (result.success.syncedDocuments.length) syncedSources.push(source.id);
      warnings.push(...result.success.warnings);
    }
  }
  return {syncedSources, warnings};
});
let beforeRecallStart = 0;

export const pocketSourceWork = {
  provider: 'pocket',
  admission: {limit: 16, windowMs: 20000},
  list: Effect.fn('pocket.workDescriptors')(function* (config: RuntimeConfig) {
    const sources = (yield* readSourceConfiguration(config)).sources.filter(
      (source): source is PocketSourceConfig => isPocketSource(source) && source.enabled,
    );
    return yield* Effect.forEach(sources, source =>
      Effect.gen(function* () {
        const token = yield* resolvePocketCredential(config, source).pipe(Effect.orElseSucceed(() => undefined));
        return {
          sourceId: source.id,
          provider: 'pocket',
          accountKey:
            token === undefined ? sha256HexSync('pocket:missing:' + source.id) : sourceAccountKey('pocket', token),
          fingerprint: sourceConfigurationFingerprint(source),
          refreshIntervalMs: source.refreshIntervalMinutes * 60_000,
          ...(source.credentialStorage === 'local' ? {} : {credentialEnv: source.credentialEnv}),
        };
      }),
    );
  }),
  run: Effect.fn('pocket.workQuantum')(function* (config: RuntimeConfig, sourceId: string, options: SourceWorkOptions) {
    const source = requirePocketSource(yield* readSourceConfiguration(config), sourceId);
    return yield* withSourceCredentialEnvironment(
      Effect.gen(function* () {
        const result = yield* syncPocketSource(
          config,
          sourceId,
          {
            totalTimeoutMilliseconds: 10000,
            maxRequests: 4,
            budget: makePocketClientBudget(10000, 4),
          },
          options.mode === 'automatic',
        );
        const inventory = yield* runPocketSourceInventory(config, sourceId);
        const now = yield* Clock.currentTimeMillis;
        const retryTimes = inventory.entries.flatMap(entry =>
          entry.nextAttemptAt !== undefined && entry.nextAttemptAt > now ? [entry.nextAttemptAt] : [],
        );
        const nextAttemptAt =
          inventory.nextAttemptAt ??
          (result.syncedDocuments.length === 0 && retryTimes.length > 0 ? Math.min(...retryTimes) : undefined);
        const more = inventory.progress !== undefined;
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
