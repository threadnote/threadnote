import {Effect, FileSystem, Path, Result} from 'effect';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DOCUMENT = /^r-[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 32 * 1024;

export interface PocketSyncState {
  readonly version: 1;
  readonly fingerprint: string;
  readonly accessEpoch: string;
  readonly generation: string;
  readonly phase: 'list' | 'confirm';
  readonly page: number;
  readonly offset: number;
  readonly pageIds: readonly string[];
  readonly hasMore: boolean;
  readonly total?: number;
  readonly seenCount: number;
  readonly incomplete: boolean;
  readonly confirmAfter?: string;
}
export interface PocketIdMarker {
  readonly version: 1;
  readonly id: string;
  readonly documentId: string;
  readonly generation: string;
  readonly page: number;
  readonly nextAttemptAt?: number;
}

const resourceRoot = (sourceId: string) => `threadnote://resources/external/pocket/${sourceId}`;
const stateUri = (sourceId: string) => `${resourceRoot(sourceId)}/.sync.json`;
const markerUri = (sourceId: string, documentId: string) => `${resourceRoot(sourceId)}/.ids/${documentId}.json`;
const location = (config: RuntimeConfig) => ({
  account: config.account,
  home: config.agentContextHome,
  user: config.user,
});
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validState(value: unknown): value is PocketSyncState {
  return (
    record(value) &&
    value.version === 1 &&
    typeof value.fingerprint === 'string' &&
    HASH.test(value.fingerprint) &&
    typeof value.accessEpoch === 'string' &&
    HASH.test(value.accessEpoch) &&
    typeof value.generation === 'string' &&
    HASH.test(value.generation) &&
    (value.phase === 'list' || value.phase === 'confirm') &&
    Number.isSafeInteger(value.page) &&
    (value.page as number) >= 1 &&
    Number.isSafeInteger(value.offset) &&
    (value.offset as number) >= 0 &&
    (value.offset as number) <= 100 &&
    Array.isArray(value.pageIds) &&
    value.pageIds.length <= 100 &&
    value.pageIds.every((id: unknown) => typeof id === 'string' && ID.test(id)) &&
    new Set(value.pageIds).size === value.pageIds.length &&
    (value.offset as number) <= value.pageIds.length &&
    typeof value.hasMore === 'boolean' &&
    (value.total === undefined || (Number.isSafeInteger(value.total) && (value.total as number) >= 0)) &&
    Number.isSafeInteger(value.seenCount) &&
    (value.seenCount as number) >= 0 &&
    typeof value.incomplete === 'boolean' &&
    (value.confirmAfter === undefined || (typeof value.confirmAfter === 'string' && DOCUMENT.test(value.confirmAfter)))
  );
}
function validMarker(value: unknown): value is PocketIdMarker {
  return (
    record(value) &&
    value.version === 1 &&
    typeof value.id === 'string' &&
    ID.test(value.id) &&
    typeof value.documentId === 'string' &&
    DOCUMENT.test(value.documentId) &&
    typeof value.generation === 'string' &&
    HASH.test(value.generation) &&
    Number.isSafeInteger(value.page) &&
    (value.page as number) >= 1 &&
    (value.nextAttemptAt === undefined ||
      (typeof value.nextAttemptAt === 'number' && Number.isFinite(value.nextAttemptAt) && value.nextAttemptAt >= 0))
  );
}

const readInternal = Effect.fn('pocket.readInternal')(function* (
  config: RuntimeConfig,
  sourceId: string,
  suffix: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(config.agentContextHome).pipe(Effect.orElseSucceed(() => undefined));
  if (home === undefined) return null;
  const filename = path.join(home, 'data', config.account, 'resources', 'external', 'pocket', sourceId, ...suffix);
  const result = yield* fs.stat(filename).pipe(Effect.result);
  if (Result.isFailure(result)) return result.failure.reason._tag === 'NotFound' ? undefined : null;
  if (result.success.type !== 'File' || Number(result.success.size) > MAX_STATE_BYTES) return null;
  const real = yield* fs.realPath(filename).pipe(Effect.orElseSucceed(() => undefined));
  if (real !== path.resolve(filename)) return null;
  const raw = yield* fs.readFileString(filename).pipe(Effect.orElseSucceed(() => undefined));
  if (raw === undefined || Buffer.byteLength(raw) > MAX_STATE_BYTES) return null;
  return yield* Effect.try({try: () => JSON.parse(raw) as unknown, catch: () => null}).pipe(
    Effect.orElseSucceed(() => null),
  );
});

export const readPocketSyncState = Effect.fn('pocket.readSyncState')(function* (
  config: RuntimeConfig,
  sourceId: string,
) {
  const value = yield* readInternal(config, sourceId, ['.sync.json']);
  return value === undefined ? undefined : validState(value) ? value : null;
});
export const writePocketSyncState = Effect.fn('pocket.writeSyncState')(function* (
  config: RuntimeConfig,
  sourceId: string,
  value: PocketSyncState,
  fence: Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>,
) {
  if (!validState(value)) throw new Error('Invalid Pocket sync state.');
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [{type: 'write', uri: stateUri(sourceId), content: JSON.stringify(value), options: {mode: 'upsert'}}],
    fence,
  );
});
export const clearPocketSyncState = Effect.fn('pocket.clearSyncState')(function* (
  config: RuntimeConfig,
  sourceId: string,
  fence: Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>,
) {
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [{type: 'remove', uri: stateUri(sourceId), ignoreMissing: true}],
    fence,
  );
});
export const readPocketIdMarker = Effect.fn('pocket.readIdMarker')(function* (
  config: RuntimeConfig,
  sourceId: string,
  documentId: string,
) {
  const value = yield* readInternal(config, sourceId, ['.ids', `${documentId}.json`]);
  return value === undefined ? undefined : validMarker(value) && value.documentId === documentId ? value : null;
});
export const writePocketIdMarker = Effect.fn('pocket.writeIdMarker')(function* (
  config: RuntimeConfig,
  sourceId: string,
  value: PocketIdMarker,
  fence: Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>,
) {
  if (!validMarker(value)) throw new Error('Invalid Pocket ID marker.');
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [
      {
        type: 'write',
        uri: markerUri(sourceId, value.documentId),
        content: JSON.stringify(value),
        options: {mode: 'upsert'},
      },
    ],
    fence,
  );
});
export const removePocketIdMarker = Effect.fn('pocket.removeIdMarker')(function* (
  config: RuntimeConfig,
  sourceId: string,
  documentId: string,
  fence: Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>,
) {
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [{type: 'remove', uri: markerUri(sourceId, documentId), ignoreMissing: true}],
    fence,
  );
});
export const listPocketIdMarkers = Effect.fn('pocket.listIdMarkers')(function* (
  config: RuntimeConfig,
  sourceId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    config.agentContextHome,
    'data',
    config.account,
    'resources',
    'external',
    'pocket',
    sourceId,
    '.ids',
  );
  const listed = yield* fs.readDirectory(directory).pipe(Effect.result);
  if (Result.isFailure(listed) && listed.failure.reason._tag !== 'NotFound') return null;
  const names = Result.isSuccess(listed) ? listed.success : [];
  const markers: PocketIdMarker[] = [];
  for (const name of names.filter(name => /^r-[a-f0-9]{40}\.json$/.test(name)).sort()) {
    const marker = yield* readPocketIdMarker(config, sourceId, name.slice(0, -5));
    if (marker === null) return null;
    if (marker !== undefined) markers.push(marker);
  }
  return markers;
});
