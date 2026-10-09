import {isLinearSource} from './config.js';
import {Clock, Console, DateTime, Effect, Random, Redacted, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  externalSourceReceiptUri,
  serializeExternalSourceReceipt,
  type ExternalSourceReceipt,
} from '@threadnote/store/external-resource';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  mutateSourceConfiguration,
  readSourceConfiguration,
  requireLinearSource,
  sourceConfigurationFingerprint,
  upsertLinearSource,
  validateSourceIdentifier,
  validateLinearSourceConfig,
  type LinearSourceConfig,
  type SourceConfig,
} from './config.js';
import {withSourceLock} from '@threadnote/integration-core/lock';
import {makeLinearClientBudget, type LinearClientOptions} from './client.js';
import {syncLinearSource} from './sync.js';
import {clearLinearSyncState, readLinearSyncState} from './state.js';
import {listLocalDocuments, manifest, receipt} from './storage.js';
export {LinearSourceError} from './storage.js';
import {
  removeLinearCredential,
  resolveLinearCredential,
  storeLinearCredential,
  validLinearApiToken,
} from './credentials.js';

export interface LinearSourceAddOptions {
  readonly id: string;
  readonly apply?: boolean;
  readonly enabled?: boolean;
  readonly expectedFingerprint?: string | null;
  readonly apiToken?: Redacted.Redacted<string>;
  readonly credentialStorage?: 'local';
  readonly credentialEnv?: string;
  readonly project?: string;
  readonly organizationId?: string;
  readonly principalId?: string;
  readonly teamIds?: readonly string[];
  readonly projectIds?: readonly string[];
  readonly issueIds?: readonly string[];
  readonly refreshIntervalMinutes?: number;
  readonly maxStaleHours?: number;
}
export interface LinearSourceCommandOptions {
  readonly id: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly clientOptions?: LinearClientOptions;
}
export interface LinearInventoryEntry {
  readonly documentId: string;
  readonly status: 'missing' | 'active' | 'quarantined' | 'pending' | 'stale';
  readonly chunks: number;
  readonly nextAttemptAt?: number;
}
export interface LinearInventory {
  readonly source: LinearSourceConfig;
  readonly entries: readonly LinearInventoryEntry[];
  readonly progress?: {readonly completed: number; readonly total: number};
  readonly nextAttemptAt?: number;
}
export interface LinearSyncResult {
  readonly sourceId: string;
  readonly syncedDocuments: readonly string[];
  readonly warnings: readonly string[];
  readonly progress?: {readonly completed: number; readonly total: number};
}
import {LinearSourceError} from './storage.js';
export class LinearSourceConflictError extends Schema.TaggedError<LinearSourceConflictError>()(
  'LinearSourceConflictError',
  {},
) {}
const error = (message: string) => LinearSourceError.make({message});
const loc = (config: RuntimeConfig) => ({account: config.account, home: config.agentContextHome, user: config.user});
const root = (id: string) => `threadnote://resources/external/linear/${id}`;
const receiptUri = (id: string) => externalSourceReceiptUri(id, 'linear');

const configFence = Effect.fn('linear.configFence')(function* (
  config: RuntimeConfig,
  id: string,
  fingerprint: string,
  enabled = true,
) {
  const source = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
  if (
    !source ||
    !isLinearSource(source) ||
    (enabled && !source.enabled) ||
    sourceConfigurationFingerprint(source) !== fingerprint
  )
    return yield* error('Linear source configuration changed during refresh.');
});
function containsCredential(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some(item => containsCredential(item, secret));
  return (
    value !== null && typeof value === 'object' && Object.values(value).some(item => containsCredential(item, secret))
  );
}
const checkCredentialSafety = Effect.fn('linear.checkCredentialSafety')(function* (
  config: RuntimeConfig,
  source: LinearSourceConfig,
  existing: LinearSourceConfig | undefined,
  options: LinearSourceAddOptions,
) {
  const effective =
    options.apiToken ?? (yield* resolveLinearCredential(config, source).pipe(Effect.orElseSucceed(() => undefined)));
  const previous =
    existing === undefined
      ? undefined
      : yield* resolveLinearCredential(config, existing).pipe(Effect.orElseSucceed(() => undefined));
  if (source.credentialStorage === 'local' && effective === undefined)
    return yield* error('A protected API key is required for this Linear source.');
  for (const token of [effective, previous]) {
    if (token === undefined) continue;
    const secret = Redacted.value(token);
    if (containsCredential(source, secret) || containsCredential({...options, apiToken: undefined}, secret))
      return yield* error('Linear source configuration contains credential material.');
  }
});
function sourceFor(options: LinearSourceAddOptions, id: string, existing?: LinearSourceConfig): LinearSourceConfig {
  if (!options.project) throw error('Choose one local --project for Linear.');
  return validateLinearSourceConfig({
    type: 'linear',
    id,
    enabled: options.enabled ?? true,
    credentialEnv: options.credentialEnv ?? existing?.credentialEnv ?? 'THREADNOTE_LINEAR_API_KEY',
    ...(options.apiToken !== undefined ||
    options.credentialStorage === 'local' ||
    (options.credentialEnv === undefined && existing?.credentialStorage === 'local')
      ? {credentialStorage: 'local' as const}
      : {}),
    project: validateSourceIdentifier(options.project, 'project'),
    organizationId: options.organizationId ?? existing?.organizationId ?? '',
    principalId: options.principalId ?? existing?.principalId ?? '',
    teamIds: options.teamIds ?? existing?.teamIds ?? [],
    projectIds: options.projectIds ?? existing?.projectIds ?? [],
    issueIds: options.issueIds ?? existing?.issueIds ?? [],
    refreshIntervalMinutes: options.refreshIntervalMinutes ?? existing?.refreshIntervalMinutes ?? 60,
    maxStaleHours: options.maxStaleHours ?? existing?.maxStaleHours ?? 24,
  });
}

export const runLinearSourceAdd = Effect.fn('linear.add')(function* (
  config: RuntimeConfig,
  options: LinearSourceAddOptions,
) {
  const id = validateSourceIdentifier(options.id, 'source id');
  if (options.apiToken !== undefined && !validLinearApiToken(options.apiToken))
    return yield* error('Invalid Linear API key.');
  const initial = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
  const expected = (item: SourceConfig | undefined) => {
    if (
      options.expectedFingerprint !== undefined &&
      (item === undefined ? null : isLinearSource(item) ? sourceConfigurationFingerprint(item) : '') !==
        options.expectedFingerprint
    )
      throw LinearSourceConflictError.make({});
  };
  yield* Effect.try({try: () => expected(initial), catch: () => LinearSourceConflictError.make({})});
  const preview = sourceFor(options, id, initial !== undefined && isLinearSource(initial) ? initial : undefined);
  yield* checkCredentialSafety(
    config,
    preview,
    initial !== undefined && isLinearSource(initial) ? initial : undefined,
    options,
  );
  if (options.apply !== true) {
    yield* Console.log(
      `Would configure Linear source "${id}" for selected teams and projects/issues. Re-run with --apply.`,
    );
    return;
  }
  yield* withSourceLock(
    config,
    id,
    Effect.gen(function* () {
      const existing = (yield* readSourceConfiguration(config)).sources.find(item => item.id === id);
      yield* Effect.try({try: () => expected(existing), catch: () => LinearSourceConflictError.make({})});
      if (existing && !isLinearSource(existing)) return yield* error(`Source "${id}" already has another type.`);
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
      if (cleanup) yield* clearLinearSyncState(config, id);
      if (cleanup) {
        const denied: ExternalSourceReceipt = {
          version: 1,
          provider: 'linear',
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
      if (options.apiToken !== undefined) yield* storeLinearCredential(config, id, options.apiToken);
      else if (source.credentialStorage !== 'local') yield* removeLinearCredential(config, id);
      yield* mutateSourceConfiguration(config, current => {
        const latest = current.sources.find(item => item.id === id);
        if (
          (latest !== undefined && isLinearSource(latest) ? sourceConfigurationFingerprint(latest) : undefined) !==
          previousFingerprint
        )
          throw error('Linear source configuration changed before update.');
        return upsertLinearSource(current, source);
      });
      if (cleanup) {
        yield* store.mutateChecked(
          loc(config),
          [{type: 'remove', uri: root(id), options: {recursive: true}, ignoreMissing: true}],
          configFence(config, id, sourceConfigurationFingerprint(source), false),
        );
        const active: ExternalSourceReceipt = {
          version: 1,
          provider: 'linear',
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
  yield* Console.log(`Configured Linear source "${id}".`);
});

export const runLinearSourceSync = Effect.fn('linear.sync')(function* (
  config: RuntimeConfig,
  options: LinearSourceCommandOptions,
) {
  const source = requireLinearSource(yield* readSourceConfiguration(config), options.id);
  if (options.apply !== true || options.dryRun === true) {
    const inventory = yield* runLinearSourceInventory(config, options.id);
    yield* Console.log(`Dry run: ${inventory.entries.length} cached Linear object(s). Re-run with --apply to refresh.`);
    return {sourceId: source.id, syncedDocuments: [], warnings: []} satisfies LinearSyncResult;
  }
  const result = yield* syncLinearSource(config, source.id, options.clientOptions);
  yield* Console.log(`Linear source "${source.id}": ${result.syncedDocuments.length} object(s) refreshed.`);
  return result;
});

export const runLinearSourceInventory = Effect.fn('linear.inventory')(function* (config: RuntimeConfig, id: string) {
  const source = requireLinearSource(yield* readSourceConfiguration(config), id);
  const access = yield* receipt(config, id);
  const now = yield* Clock.currentTimeMillis;
  const entries: LinearInventoryEntry[] = [];
  for (const doc of yield* listLocalDocuments(config, id)) {
    const state = yield* manifest(config, id, doc);
    entries.push({
      documentId: doc,
      status: !state
        ? 'missing'
        : !source.enabled ||
            access?.status !== 'active' ||
            state.accessEpoch !== access.accessEpoch ||
            state.configFingerprint !== sourceConfigurationFingerprint(source)
          ? 'quarantined'
          : now - state.fetchedAt > source.maxStaleHours * 3_600_000
            ? 'stale'
            : state.status,
      chunks: Object.keys(state?.chunks ?? {}).length,
      ...(state?.nextAttemptAt ? {nextAttemptAt: state.nextAttemptAt} : {}),
    });
  }
  const state = yield* readLinearSyncState(config, id);
  const progress = state
    ? {completed: state.offset, total: state.issueIds.length + source.projectIds.length}
    : undefined;
  return {
    source,
    entries,
    ...(progress ? {progress} : {}),
    ...(access?.nextAttemptAt ? {nextAttemptAt: access.nextAttemptAt} : {}),
  } satisfies LinearInventory;
});
export const runLinearSourceStatus = Effect.fn('linear.status')(function* (config: RuntimeConfig, id: string) {
  const inventory = yield* runLinearSourceInventory(config, id);
  yield* Console.log(`Linear source "${id}": ${inventory.entries.length} cached item(s).`);
  for (const entry of inventory.entries)
    yield* Console.log(`${entry.documentId}: ${entry.status}; ${entry.chunks} local chunk(s)`);
  if (inventory.progress)
    yield* Console.log(`Import progress: ${inventory.progress.completed}/${inventory.progress.total} selected items.`);
  if (inventory.nextAttemptAt)
    yield* Console.log(`Provider retry after ${DateTime.formatIso(DateTime.makeUnsafe(inventory.nextAttemptAt))}.`);
  return inventory;
});

export const runLinearSourceRemove = Effect.fn('linear.remove')(function* (
  config: RuntimeConfig,
  options: LinearSourceCommandOptions,
) {
  const source = requireLinearSource(yield* readSourceConfiguration(config), options.id);
  if (options.apply !== true || options.dryRun === true) {
    yield* Console.log(`Would remove Linear source "${source.id}". Re-run with --apply.`);
    return;
  }
  yield* withSourceLock(
    config,
    source.id,
    Effect.gen(function* () {
      const current = requireLinearSource(yield* readSourceConfiguration(config), source.id);
      const fingerprint = sourceConfigurationFingerprint(current);
      const prior = yield* receipt(config, source.id);
      const denied: ExternalSourceReceipt = {
        version: 1,
        provider: 'linear',
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
        upsertLinearSource(configuration, {...current, enabled: false}),
      );
      yield* removeLinearCredential(config, source.id);
      yield* clearLinearSyncState(config, source.id);
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
  yield* Console.log(`Removed Linear source "${source.id}".`);
});

export const syncLinearSourcesBeforeRecall = Effect.fn('linear.beforeRecall')(function* (
  config: RuntimeConfig,
  clientOptions: LinearClientOptions = {},
) {
  const syncedSources: string[] = [];
  const warnings: string[] = [];
  const sources = (yield* readSourceConfiguration(config)).sources.filter(
    (source): source is LinearSourceConfig => isLinearSource(source) && source.enabled,
  );
  const budget = makeLinearClientBudget(10_000, 8);
  const start = beforeRecallStart++ % Math.max(1, sources.length);
  for (let index = 0; index < sources.length; index++) {
    const source = sources[(start + index) % sources.length];
    if (
      budget.requests >= budget.maxRequests ||
      budget.responseBytes >= budget.maxResponseBytes ||
      (yield* Clock.currentTimeMillis) >= budget.deadlineAt
    )
      break;
    if (!isLinearSource(source) || !source.enabled) continue;
    const perSource = budget.maxRequests - budget.requests;
    const result = yield* syncLinearSource(
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
    if (Result.isFailure(result)) warnings.push(`Linear source "${source.id}" refresh unavailable.`);
    else {
      if (result.success.syncedDocuments.length) syncedSources.push(source.id);
      warnings.push(...result.success.warnings);
    }
  }
  return {syncedSources, warnings};
});
let beforeRecallStart = 0;
