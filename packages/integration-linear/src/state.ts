import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {runtimeReadBoundedStableRegularFile} from '@threadnote/platform/system';
import {LINEAR_MAX_PROJECTS, LINEAR_MAX_COLLECTION_ITEMS, LINEAR_UUID} from './config.js';
import {LinearClientError, record} from './transport.js';

export const LINEAR_MAX_RETAINED_OBJECTS =
  LINEAR_MAX_COLLECTION_ITEMS + LINEAR_MAX_PROJECTS * (1 + 2 * LINEAR_MAX_COLLECTION_ITEMS);
export const LINEAR_MAX_SYNC_STATE_BYTES = 16 * 1024 * 1024;
const stateError = () => LinearClientError.make({code: 'contract-invalid'});
export interface LinearSyncState {
  readonly version: 1;
  readonly fingerprint: string;
  readonly accessEpoch: string;
  readonly projectIndex: number;
  readonly issueIds: readonly string[];
  readonly enumerated: boolean;
  readonly offset: number;
  readonly retained: readonly string[];
  readonly incomplete: boolean;
}
const filename = Effect.fn('linear.statePath')(function* (config: RuntimeConfig, id: string) {
  const path = yield* Path.Path;
  return path.join(config.agentContextHome, 'threadnote', 'integrations', 'linear', `${id}.json`);
});
function valid(v: unknown): v is LinearSyncState {
  return (
    record(v) &&
    v.version === 1 &&
    typeof v.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(v.fingerprint) &&
    typeof v.accessEpoch === 'string' &&
    /^[a-f0-9]{64}$/.test(v.accessEpoch) &&
    checkedIsSafeInteger(v.projectIndex) &&
    v.projectIndex >= 0 &&
    v.projectIndex <= LINEAR_MAX_PROJECTS &&
    checkedIsSafeInteger(v.offset) &&
    v.offset >= 0 &&
    v.offset <= LINEAR_MAX_COLLECTION_ITEMS + LINEAR_MAX_PROJECTS &&
    typeof v.enumerated === 'boolean' &&
    typeof v.incomplete === 'boolean' &&
    EffectArray.isArray(v.issueIds) &&
    v.issueIds.length <= LINEAR_MAX_COLLECTION_ITEMS &&
    EffectArray.every(v.issueIds, x => typeof x === 'string' && LINEAR_UUID.test(x)) &&
    new Set(v.issueIds).size === v.issueIds.length &&
    EffectArray.isArray(v.retained) &&
    v.retained.length <= LINEAR_MAX_RETAINED_OBJECTS &&
    EffectArray.every(
      v.retained,
      x => typeof x === 'string' && /^(issue|project|document|update)-[a-f0-9]{40}$/.test(x),
    ) &&
    new Set(v.retained).size === v.retained.length
  );
}
export const readLinearSyncState = Effect.fn('linear.readState')(function* (config: RuntimeConfig, id: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* filename(config, id);
  if (!(yield* fs.exists(file))) return undefined;
  return yield* Effect.gen(function* () {
    const info = yield* fs.stat(file);
    if (
      info.type !== 'File' ||
      info.size > BigInt(LINEAR_MAX_SYNC_STATE_BYTES) ||
      (yield* fs.realPath(file)) !== path.resolve(file)
    )
      return null;
    const bytes = yield* fromPromiseInterruptible(
      () => runtimeReadBoundedStableRegularFile(file, LINEAR_MAX_SYNC_STATE_BYTES),
      stateError,
    );
    const raw = yield* Effect.try(() => new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    const v: unknown = yield* Effect.try(() => JSON.parse(raw));
    return valid(v) ? v : null;
  }).pipe(Effect.orElseSucceed(() => null));
});
export const writeLinearSyncState = Effect.fn('linear.writeState')(function* <R>(
  config: RuntimeConfig,
  id: string,
  state: LinearSyncState,
  fence: Effect.Effect<void, unknown, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* filename(config, id);
  const serialized = yield* Effect.try({
    try: () => {
      if (!valid(state)) throw stateError();
      const value = JSON.stringify(state);
      if (new TextEncoder().encode(value).byteLength > LINEAR_MAX_SYNC_STATE_BYTES) throw stateError();
      if (!valid(JSON.parse(value))) throw stateError();
      return value;
    },
    catch: stateError,
  });
  yield* fence;
  yield* fs.makeDirectory(path.dirname(file), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(`${file}.tmp`, serialized, {mode: 0o600});
  yield* fence;
  yield* fs
    .rename(`${file}.tmp`, file)
    .pipe(Effect.ensuring(fs.remove(`${file}.tmp`, {force: true}).pipe(Effect.ignore)));
});
export const clearLinearSyncState = Effect.fn('linear.clearState')(function* (config: RuntimeConfig, id: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* filename(config, id), {force: true});
});
