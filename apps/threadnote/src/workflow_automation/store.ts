import {SecureRandom} from 'effect/crypto';
import {Context, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {FileLockTimeout, fileLockBusyMessage, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {decodeNativeWorkflowState, type NativeWorkflowState} from '@threadnote/workflow-automations/native';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {decodeBoundedWorkflowJson, encodeBoundedWorkflowJson} from '../workflow_memory/journal_codec.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {CurrentWorkflowReadCache, immutableWorkflowImage} from '../workflow_memory/read_cache.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CurrentNativeAuthoringSave = Context.Reference<string | undefined>('threadnote/NativeAuthoringSave', {
  defaultValue: () => undefined,
});
export const CurrentNativeCloseoutSave = Context.Reference<string | undefined>('threadnote/NativeCloseoutSave', {
  defaultValue: () => undefined,
});
/** Internal test/service budget can reduce the ceiling, never increase the protocol limit. */
export const CurrentNativeOperationLimit = Context.Reference<number>('threadnote/NativeOperationLimit', {
  defaultValue: () => 4096,
});

const issue = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const STATE_CODEC = 'threadnote-native-workflow-state-gzip-v1';
function checkRunId(runId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) ||
    Effect2.pipe(runId, EffectString.includes('..')) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(runId) ||
    ['constructor', 'prototype'].includes(runId)
  )
    throw issue('invalid-request', 'Native run IDs must be bounded portable identifiers, never paths.');
}

/** Fixed private namespace. Neither requests nor legacy helper files select this root. */
const stateDirectory = Effect.fn('workflowAutomation.stateDirectory')(function* (
  config: RuntimeConfig,
  create: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = yield* fs.realPath(config.agentContextHome);
  for (const segment of ['workflow-automations', 'native-v1']) {
    directory = path.join(directory, segment);
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
      return yield* issue('unsafe-state', 'Native run state directories cannot be symbolic links.');
    if (!(yield* fs.exists(directory))) {
      if (!create) return undefined;
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    }
    if (
      Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)) ||
      (yield* fs.stat(directory)).type !== 'Directory' ||
      (yield* fs.realPath(directory)) !== directory
    )
      return yield* issue('unsafe-state', 'Native run state must stay in its canonical private directory.');
  }
  return directory;
});

const statePath = Effect.fn('workflowAutomation.statePath')(function* (
  config: RuntimeConfig,
  runId: string,
  create = false,
) {
  yield* Effect.try({
    try: () => checkRunId(runId),
    catch: error =>
      Schema.is(WorkflowAutomationError)(error)
        ? error
        : issue('invalid-state', 'Could not validate native workflow state.'),
  });
  const directory = yield* stateDirectory(config, create);
  return directory === undefined ? undefined : (yield* Path.Path).join(directory, runId + '.json');
});

/** Fixed receipt namespace attached to an existing native run. */
export const nativeCloseoutJournalPath = Effect.fn('workflowAutomation.closeoutJournalPath')(function* (
  config: RuntimeConfig,
  runId: string,
) {
  const file = yield* statePath(config, runId);
  if (file === undefined || !(yield* readNativeWorkflowState(config, runId)))
    return yield* issue('run-not-found', 'This native run does not exist. Start a fresh native run explicitly.');
  return file + '.closeout.json';
});

const stateBytes = Effect.fn('workflowAutomation.stateBytes')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
    return yield* issue('unsafe-state', 'Native run state cannot be a symbolic link.');
  if (!(yield* fs.exists(file))) return undefined;
  const stat = yield* fs.stat(file);
  if (stat.type !== 'File' || Number(stat.size) > 16 * 1024 * 1024)
    return yield* issue('invalid-state', 'Native run state must be a bounded regular file.');
  const bytes = yield* fs.readFileString(file);
  if (new TextEncoder().encode(bytes).byteLength > 16 * 1024 * 1024)
    return yield* issue('invalid-state', 'Native run state exceeds its stored byte limit.');
  return bytes;
});

export const readNativeWorkflowState = Effect.fn('workflowAutomation.readState')(function* (
  config: RuntimeConfig,
  runId: string,
) {
  const file = yield* statePath(config, runId);
  if (file === undefined) return undefined;
  const bytes = yield* stateBytes(file);
  if (bytes === undefined) return undefined;
  const cache = yield* CurrentWorkflowReadCache;
  if (cache?.native?.file === file && cache.native.bytes === bytes)
    return {state: cache.native.state, revision: cache.native.revision};
  const state = yield* fromPromiseInterruptible(
    async signal => {
      const parsed: unknown = JSON.parse(bytes);
      const value =
        parsed !== null && typeof parsed === 'object' && 'format' in parsed && parsed.format === STATE_CODEC
          ? JSON.parse(await decodeBoundedWorkflowJson(bytes, STATE_CODEC, signal))
          : parsed;
      return cache ? cache.decodeNative(value) : decodeNativeWorkflowState(value, sha256HexSync);
    },
    error =>
      Schema.is(WorkflowAutomationError)(error)
        ? error
        : issue(
            'invalid-state',
            'Native run state is corrupt. Restore its exact file; no recovery or rebinding was applied.',
          ),
  );
  if (state.runId !== runId) return yield* issue('invalid-state', 'The native state file belongs to another run.');
  const result = {state, revision: sha256HexSync(bytes)};
  if (cache) cache.native = {file, bytes, ...result, state: immutableWorkflowImage(state)};
  return result;
});

/** Pure storage representation used by mutation-free transaction admission. */
export const serializeNativeWorkflowState = (state: NativeWorkflowState, stringify = stableJson): string =>
  encodeBoundedWorkflowJson(stringify(state) + '\n', STATE_CODEC);

/** Validate the complete candidate and encode the exact bounded bytes before any external mutation. */
export const prepareNativeWorkflowStateWrite = Effect.fn('workflowAutomation.prepareStateWrite')(function* (
  state: NativeWorkflowState,
) {
  const cache = yield* CurrentWorkflowReadCache;
  const validated = yield* Effect.try({
    try: () => (cache ? cache.decodeNative(state) : decodeNativeWorkflowState(state, sha256HexSync)),
    catch: error =>
      Schema.is(WorkflowAutomationError)(error)
        ? error
        : issue('invalid-state', 'Could not validate native workflow state.'),
  });
  const serialized = yield* Effect.try({
    try: () => serializeNativeWorkflowState(validated, cache?.stringify),
    catch: () =>
      issue('state-capacity', 'Native run state reached its byte limit. Existing receipts remain unchanged.'),
  });
  return Object.freeze({state: immutableWorkflowImage(validated), serialized, revision: sha256HexSync(serialized)});
});
export type PreparedNativeWorkflowStateWrite = Effect.Success<ReturnType<typeof prepareNativeWorkflowStateWrite>>;

/** Call only under the run lock, with the exact image produced by the shared preflight. */
export const writePreparedNativeWorkflowState = Effect.fn('workflowAutomation.writePreparedState')(function* (
  config: RuntimeConfig,
  prepared: PreparedNativeWorkflowStateWrite,
  expectedRevision: string | null,
) {
  const {state: validated, serialized, revision} = prepared;
  const cache = yield* CurrentWorkflowReadCache;
  const file = (yield* statePath(config, validated.runId, true))!;
  const fs = yield* FileSystem.FileSystem;
  const temporary = file + '.' + (yield* (yield* SecureRandom.SecureRandom).uuidV4()) + '.tmp';
  return yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, serialized, {mode: 0o600, flag: 'wx'});
    // Revalidate parent ownership and destination bytes immediately before commit.
    yield* statePath(config, validated.runId);
    const previous = yield* stateBytes(file);
    if ((previous === undefined ? null : sha256HexSync(previous)) !== expectedRevision)
      return yield* issue(
        'state-conflict',
        'Native run state changed after it was read. Retry from its current receipt.',
      );
    yield* fs.rename(temporary, file);
    const result = {state: validated, revision};
    if (cache) cache.native = {file, bytes: serialized, ...result, state: immutableWorkflowImage(validated)};
    return result;
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

/** Call only under the run lock. CAS and rename preserve the old file on every failed preparation. */
export const writeNativeWorkflowState = Effect.fn('workflowAutomation.writeState')(function* (
  config: RuntimeConfig,
  state: NativeWorkflowState,
  expectedRevision: string | null,
) {
  const prepared = yield* prepareNativeWorkflowStateWrite(state);
  return yield* writePreparedNativeWorkflowState(config, prepared, expectedRevision);
});

/** Lock order is native run -> native memory binding -> memory targets. Graph preparation stays outside. */
export function withNativeWorkflowLock<A, E, R>(
  config: RuntimeConfig,
  runId: string,
  initialize: boolean,
  body: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* statePath(config, runId, initialize);
    if (file === undefined)
      return yield* issue('run-not-found', 'This native run does not exist. Start a fresh native run explicitly.');
    return yield* withExclusiveFileLock(
      fs,
      file + '.lock',
      {
        category: 'native-run',
        createParentDirectory: false,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 300_000,
        waitTimeoutMilliseconds: 2_000,
      },
      Effect.result(body),
    ).pipe(
      Effect.catchIf(Schema.is(FileLockTimeout), error =>
        Effect.fail(
          WorkflowAutomationError.make({
            code: 'state-busy',
            message: fileLockBusyMessage(error),
            retryable: true,
          }),
        ),
      ),
      Effect.flatMap(Effect.fromResult),
    );
  });
}

/** Serialize a multi-artifact authoring commit without recursively taking the run lock. */
export function withNativeAuthoringLock<A, E, R>(config: RuntimeConfig, runId: string, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* statePath(config, runId);
    if (file === undefined) return yield* issue('run-not-found', 'Start the native run before authoring.');
    return yield* withExclusiveFileLock(
      fs,
      file + '.authoring.lock',
      {
        category: 'native-authoring',
        createParentDirectory: false,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 300_000,
        waitTimeoutMilliseconds: 2_000,
      },
      Effect.result(body),
    ).pipe(
      Effect.catchIf(Schema.is(FileLockTimeout), error =>
        Effect.fail(
          WorkflowAutomationError.make({code: 'state-busy', message: fileLockBusyMessage(error), retryable: true}),
        ),
      ),
      Effect.flatMap(Effect.fromResult),
    );
  });
}
