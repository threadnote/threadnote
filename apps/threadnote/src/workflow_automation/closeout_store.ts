import {Crypto, Effect, FileSystem, Option, Schema} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {FileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {decodeBoundedWorkflowJson, encodeBoundedWorkflowJson} from '../workflow_memory/journal_codec.js';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {nativeCloseoutJournalPath} from './store.js';

const CODEC = 'threadnote-native-closeout-state-gzip-v1';
const DISK_LIMIT = 16 * 1024 * 1024;
const issue = (code: string, message: string, retryable = false) =>
  WorkflowAutomationError.make({code, message, ...(retryable ? {retryable: true} : {})});

const storedBytes = Effect.fn('workflowAutomation.readCloseoutBytes')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
    return yield* issue('unsafe-state', 'Native closeout state cannot be a symbolic link.');
  if (!(yield* fs.exists(file))) return undefined;
  const stat = yield* fs.stat(file);
  if (stat.type !== 'File' || Number(stat.size) > DISK_LIMIT)
    return yield* issue('invalid-state', 'Native closeout state must be a bounded regular file.');
  const bytes = yield* fs.readFile(file);
  if (bytes.byteLength > DISK_LIMIT)
    return yield* issue('invalid-state', 'Native closeout state exceeds its stored byte limit.');
  return bytes;
});

const decodeBytes = <A>(bytes: Uint8Array, decode: (value: unknown) => A) =>
  fromPromiseInterruptible(
    async signal => {
      const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      const json =
        parsed !== null && typeof parsed === 'object' && 'format' in parsed && parsed.format === CODEC
          ? await decodeBoundedWorkflowJson(text, CODEC, signal)
          : text;
      return decode(JSON.parse(json) as unknown);
    },
    error =>
      Schema.is(WorkflowAutomationError)(error)
        ? error
        : issue('invalid-state', 'Native closeout state is corrupt; its exact receipt file was preserved.'),
  );

/** Read-only: absence never creates the run directory or journal. */
export const readNativeCloseoutJournal = Effect.fn('workflowAutomation.readCloseoutJournal')(function* <A>(
  config: RuntimeConfig,
  runId: string,
  decode: (value: unknown) => A,
) {
  const file = yield* nativeCloseoutJournalPath(config, runId);
  const bytes = yield* storedBytes(file);
  if (bytes === undefined) return undefined;
  const state = yield* decodeBytes(bytes, decode);
  return {state, revision: sha256HexSync(bytes)};
});

const encodedJournal = Effect.fn('workflowAutomation.encodeCloseoutJournal')(function* <A>(
  state: A,
  decode: (value: unknown) => A,
) {
  const validated = yield* Effect.try({
    try: () => decode(state),
    catch: () => issue('invalid-state', 'Native closeout state failed its domain validation.'),
  });
  const serialized = yield* Effect.try({
    try: () => encodeBoundedWorkflowJson(stableJson(validated) + '\n', CODEC),
    catch: () =>
      issue(
        'closeout-capacity',
        'Native closeout receipt reached its storage limit; existing receipts remain unchanged.',
      ),
  });
  return {validated, serialized};
});

/** Check both admission images before any new reservation is installed. */
export const assertNativeCloseoutJournalCapacity = Effect.fn('workflowAutomation.closeoutJournalCapacity')(function* <
  A,
>(state: A, decode: (value: unknown) => A) {
  yield* encodedJournal(state, decode);
});

/** Call under withNativeCloseoutLock; CAS and atomic replacement preserve failed preparations. */
export const writeNativeCloseoutJournal = Effect.fn('workflowAutomation.writeCloseoutJournal')(function* <A>(
  config: RuntimeConfig,
  runId: string,
  state: A,
  expectedRevision: string | null,
  decode: (value: unknown) => A,
) {
  const {validated, serialized} = yield* encodedJournal(state, decode);
  const file = yield* nativeCloseoutJournalPath(config, runId);
  const fs = yield* FileSystem.FileSystem;
  const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4();
  const temporary = file + '.' + uuid + '.tmp';
  return yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, serialized, {mode: 0o600, flag: 'wx'});
    const currentFile = yield* nativeCloseoutJournalPath(config, runId);
    if (currentFile !== file) return yield* issue('unsafe-state', 'Native closeout state path changed before commit.');
    const previous = yield* storedBytes(file);
    if ((previous === undefined ? null : sha256HexSync(previous)) !== expectedRevision)
      return yield* issue(
        'state-conflict',
        'Native closeout receipt changed after it was read. Retry from its current revision.',
      );
    if (previous !== undefined) yield* decodeBytes(previous, decode);
    const revalidatedFile = yield* nativeCloseoutJournalPath(config, runId);
    if (revalidatedFile !== file)
      return yield* issue('unsafe-state', 'Native closeout state path changed before commit.');
    const immediate = yield* storedBytes(file);
    if ((immediate === undefined ? null : sha256HexSync(immediate)) !== expectedRevision)
      return yield* issue('state-conflict', 'Native closeout receipt changed before commit.');
    yield* fs.rename(temporary, file);
    return {state: validated, revision: sha256HexSync(serialized)};
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

/** Independent closeout receipt lock; callers must not nest or reacquire the native run lock. */
export function withNativeCloseoutLock<A, E, R>(config: RuntimeConfig, runId: string, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* nativeCloseoutJournalPath(config, runId);
    return yield* withExclusiveFileLock(
      fs,
      file + '.lock',
      {
        createParentDirectory: false,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 300_000,
        waitTimeoutMilliseconds: 2_000,
      },
      body,
    ).pipe(
      Effect.catchIf(Schema.is(FileLockTimeout), () =>
        Effect.fail(
          issue('closeout-busy', 'Another closeout transaction owns this run receipt. Retry this closeout.', true),
        ),
      ),
    );
  });
}
