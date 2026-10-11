import {Clock, Crypto, Effect, FileSystem, Option, Path, Predicate, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runtimeTextDirectoryNamePage, SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT, CODE_GRAPH_PREPARED_SPOOL_COUNT_LIMIT} from './build/resources.js';
import {codeGraphPreparedSpoolBudgetLockPath, codeGraphPreparedSpoolBudgetRoot} from './layout.js';

const ENTRY_NAME = /^v([12])-([0-9a-f]{64})\.json$/;
const ENTRY_BYTES_MAXIMUM = 1_024;
const ENTRY_COUNT_MAXIMUM = 256;
const RETRY_MILLISECONDS = 25;
const LOCK_WAIT_MILLISECONDS = 5_000;

interface PreparedSpoolBudgetEntry {
  readonly bytes: number;
  readonly checkoutId: string;
  readonly createdAt?: number;
  readonly processId: number;
  readonly processStartIdentity?: string;
  readonly snapshotId: string;
  readonly state?: 'active' | 'waiting';
  readonly token: string;
  readonly version: 1 | 2;
}

interface OwnedEntry extends PreparedSpoolBudgetEntry {
  readonly path: string;
  serialized: string;
  state?: 'active' | 'waiting';
}

class CodeGraphPreparedSpoolBudgetError extends Schema.TaggedError<CodeGraphPreparedSpoolBudgetError>()(
  'CodeGraphPreparedSpoolBudgetError',
  {message: Schema.String},
) {}

export function preparedSpoolBudgetCanAdmit(activeBytes: readonly number[], requestedBytes: number): boolean {
  if (!validBytes(requestedBytes) || activeBytes.some(value => !validBytes(value))) return false;
  if (activeBytes.length >= CODE_GRAPH_PREPARED_SPOOL_COUNT_LIMIT) return false;
  if (activeBytes.length === 0) return true;
  if (requestedBytes > CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT) return false;
  return (
    activeBytes.reduce((total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value), requestedBytes) <=
    CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT
  );
}

export interface CodeGraphPreparedSpoolBudgetCandidate {
  readonly bytes: number;
  readonly createdAt: number;
  readonly token: string;
}

/** Strict FIFO deliberately drains active receipts for an older large or oversized spool. */
export function selectCodeGraphPreparedSpoolBudgetTicket<T extends CodeGraphPreparedSpoolBudgetCandidate>(
  activeBytes: readonly number[],
  waiting: readonly T[],
): T | undefined {
  const oldest = [...waiting].sort(
    (left, right) =>
      left.createdAt - right.createdAt || (left.token < right.token ? -1 : left.token > right.token ? 1 : 0),
  )[0];
  return oldest && preparedSpoolBudgetCanAdmit(activeBytes, oldest.bytes) ? oldest : undefined;
}

export function withCodeGraphPreparedSpoolBudget<A, E, R>(
  options: {
    readonly bytes: number;
    readonly checkoutId: string;
    readonly onWaiting?: Effect.Effect<void, never>;
    readonly snapshotId: string;
    readonly threadnoteHome: string;
  },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R | Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    let waitingReported = false;
    return yield* Effect.acquireUseRelease(
      createTicket(fs, path, system, options),
      ticket =>
        Effect.gen(function* () {
          for (;;) {
            const receipt = yield* activateTicket(fs, path, system, options.threadnoteHome, ticket);
            if (receipt) return yield* effect;
            if (!waitingReported) {
              yield* options.onWaiting ?? Effect.void;
              waitingReported = true;
            }
            yield* Effect.sleep(RETRY_MILLISECONDS);
          }
        }),
      ticket => removeEntry(fs, path, options.threadnoteHome, ticket).pipe(Effect.ignore),
    );
  });
}

const createTicket = Effect.fn('codeGraph.preparedSpoolBudget.createTicket')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  options: {
    readonly bytes: number;
    readonly checkoutId: string;
    readonly snapshotId: string;
    readonly threadnoteHome: string;
  },
) {
  if (!validIdentity(options)) {
    return yield* CodeGraphPreparedSpoolBudgetError.make({message: 'Prepared spool budget identity is invalid.'});
  }
  const crypto = yield* Crypto.Crypto;
  const root = codeGraphPreparedSpoolBudgetRoot(path, options.threadnoteHome);
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  if (system.platform !== 'win32') yield* fs.chmod(root, 0o700);
  const token = sha256HexSync(`${system.processId}\0${yield* crypto.randomUUIDv4()}`);
  const processStartIdentity = yield* system.canonicalProcessStartIdentity?.(system.processId) ??
    system.processStartIdentity(system.processId);
  const ticket: PreparedSpoolBudgetEntry = {
    bytes: options.bytes,
    checkoutId: options.checkoutId,
    createdAt: yield* Clock.currentTimeMillis,
    processId: system.processId,
    ...(processStartIdentity === undefined ? {} : {processStartIdentity}),
    snapshotId: options.snapshotId,
    state: 'waiting',
    token,
    version: 2,
  };
  const serialized = serializeEntry(ticket);
  if (new TextEncoder().encode(serialized).length > ENTRY_BYTES_MAXIMUM || !parseEntry(serialized, token, 2)) {
    return yield* CodeGraphPreparedSpoolBudgetError.make({message: 'Prepared spool budget ticket is invalid.'});
  }
  const owned: OwnedEntry = {...ticket, path: path.join(root, `v2-${token}.json`), serialized};
  yield* withLedgerLock(
    fs,
    codeGraphPreparedSpoolBudgetLockPath(path, options.threadnoteHome),
    Effect.gen(function* () {
      const entries = yield* scanEntries(fs, path, system, options.threadnoteHome);
      if (entries.length >= ENTRY_COUNT_MAXIMUM) {
        return yield* CodeGraphPreparedSpoolBudgetError.make({message: 'Prepared spool budget ledger overflowed.'});
      }
      yield* writeEntryAtomically(fs, root, owned);
    }),
  );
  return owned;
});

const activateTicket = Effect.fn('codeGraph.preparedSpoolBudget.activate')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
  owned: OwnedEntry,
) {
  return yield* withLedgerLock(
    fs,
    codeGraphPreparedSpoolBudgetLockPath(path, threadnoteHome),
    Effect.gen(function* () {
      const entries = yield* scanEntries(fs, path, system, threadnoteHome);
      const current = entries.find(entry => entry.token === owned.token);
      if (!current || current.serialized !== owned.serialized || current.state !== 'waiting') {
        return yield* CodeGraphPreparedSpoolBudgetError.make({message: 'Prepared spool budget ticket changed.'});
      }
      const active = entries.filter(entry => entry.state === 'active');
      const waiting = entries.flatMap(entry =>
        entry.state === 'waiting' && entry.createdAt !== undefined
          ? [{bytes: entry.bytes, createdAt: entry.createdAt, token: entry.token}]
          : [],
      );
      const selected = selectCodeGraphPreparedSpoolBudgetTicket(
        active.map(entry => entry.bytes),
        waiting,
      );
      if (selected?.token !== owned.token) return undefined;
      const activated: PreparedSpoolBudgetEntry = {...owned, state: 'active'};
      const serialized = serializeEntry(activated);
      const receipt: OwnedEntry = {...activated, path: owned.path, serialized};
      yield* writeEntryAtomically(fs, codeGraphPreparedSpoolBudgetRoot(path, threadnoteHome), receipt);
      owned.serialized = serialized;
      owned.state = 'active';
      return receipt;
    }),
  );
});

const scanEntries = Effect.fn('codeGraph.preparedSpoolBudget.scan')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
) {
  const root = codeGraphPreparedSpoolBudgetRoot(path, threadnoteHome);
  if (!(yield* fs.exists(root))) return [] as OwnedEntry[];
  const page = yield* runtimeTextDirectoryNamePage(root, ENTRY_COUNT_MAXIMUM);
  if (page.overflow)
    return yield* CodeGraphPreparedSpoolBudgetError.make({message: 'Prepared spool budget ledger overflowed.'});
  const entries: OwnedEntry[] = [];
  for (const name of [...page.names].sort()) {
    const match = ENTRY_NAME.exec(name);
    const token = match?.[2];
    const version = Number(match?.[1]);
    if (!token || (version !== 1 && version !== 2)) {
      return yield* CodeGraphPreparedSpoolBudgetError.make({message: 'Prepared spool budget entry name is invalid.'});
    }
    const entryPath = path.join(root, name);
    const serialized = yield* readEntryFile(fs, entryPath);
    if (serialized === undefined)
      return yield* CodeGraphPreparedSpoolBudgetError.make({message: 'Prepared spool budget entry is invalid.'});
    const entry = parseEntry(serialized, token, version);
    if (!entry)
      return yield* CodeGraphPreparedSpoolBudgetError.make({message: 'Prepared spool budget entry is malformed.'});
    if (yield* ownerIsDead(system, entry)) {
      yield* fs.remove(entryPath, {force: true});
      continue;
    }
    entries.push({...entry, path: entryPath, serialized});
  }
  return entries;
});

const writeEntryAtomically = Effect.fn('codeGraph.preparedSpoolBudget.writeEntry')(function* (
  fs: FileSystem.FileSystem,
  root: string,
  entry: OwnedEntry,
) {
  // The ledger lock makes one recoverable sibling sufficient. A killed writer
  // cannot wedge the closed receipt namespace or accumulate unique residue.
  const temporaryPath = `${root}.pending`;
  yield* fs.remove(temporaryPath, {force: true});
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temporaryPath, {flag: 'wx', mode: 0o600});
      yield* file.writeAll(new TextEncoder().encode(entry.serialized));
      yield* file.sync;
    }),
  ).pipe(
    Effect.andThen(fs.rename(temporaryPath, entry.path)),
    Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)),
  );
});

function parseEntry(serialized: string, token: string, version: 1 | 2): PreparedSpoolBudgetEntry | undefined {
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !Predicate.isObject(value) ||
      value.version !== version ||
      value.token !== token ||
      !validBytes(value.bytes) ||
      !isDigest(value.checkoutId) ||
      typeof value.snapshotId !== 'string' ||
      !/^cgsn_[0-9a-f]{40}(?:-[a-z0-9]+)*$/.test(value.snapshotId) ||
      typeof value.processId !== 'number' ||
      !Number.isSafeInteger(value.processId) ||
      value.processId <= 0 ||
      (value.processStartIdentity !== undefined &&
        (typeof value.processStartIdentity !== 'string' || value.processStartIdentity.length > 256)) ||
      (version === 2 &&
        (typeof value.createdAt !== 'number' ||
          !Number.isSafeInteger(value.createdAt) ||
          value.createdAt < 0 ||
          value.createdAt > 8_640_000_000_000_000 ||
          (value.state !== 'active' && value.state !== 'waiting')))
    )
      return undefined;
    const entry: PreparedSpoolBudgetEntry = {
      bytes: value.bytes,
      checkoutId: value.checkoutId,
      ...(version === 2
        ? {createdAt: Number(value.createdAt), state: value.state as 'active' | 'waiting'}
        : {state: 'active' as const}),
      processId: value.processId,
      ...(value.processStartIdentity === undefined ? {} : {processStartIdentity: value.processStartIdentity}),
      snapshotId: value.snapshotId,
      token: value.token,
      version,
    };
    return serializeEntry(entry) === serialized ? entry : undefined;
  } catch {
    return undefined;
  }
}

const removeEntry = Effect.fn('codeGraph.preparedSpoolBudget.remove')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  entry: OwnedEntry,
) {
  yield* withLedgerLock(
    fs,
    codeGraphPreparedSpoolBudgetLockPath(path, threadnoteHome),
    Effect.gen(function* () {
      if (!(yield* fs.exists(entry.path))) return;
      const current = yield* readEntryFile(fs, entry.path);
      if (current === entry.serialized) yield* fs.remove(entry.path, {force: true});
    }),
  );
});

const ownerIsDead = Effect.fn('codeGraph.preparedSpoolBudget.ownerDead')(function* (
  system: SystemInfoShape,
  entry: PreparedSpoolBudgetEntry,
) {
  if (!system.isProcessRunning(entry.processId)) return true;
  if (entry.processStartIdentity === undefined) return false;
  const current = yield* system.canonicalProcessStartIdentity?.(entry.processId) ??
    system.processStartIdentity(entry.processId);
  return current !== undefined && current !== entry.processStartIdentity;
});

function withLedgerLock<A, E, R>(fs: FileSystem.FileSystem, lockPath: string, effect: Effect.Effect<A, E, R>) {
  return withExclusiveFileLock(
    fs,
    lockPath,
    {
      heartbeatIntervalMilliseconds: 5_000,
      recoverReusedProcessIdImmediately: true,
      retryIntervalMilliseconds: 10,
      staleAfterMilliseconds: 15_000,
      useCanonicalProcessStartIdentity: true,
      waitTimeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
    },
    effect,
  );
}

function validIdentity(options: {readonly bytes: number; readonly checkoutId: string; readonly snapshotId: string}) {
  return (
    validBytes(options.bytes) &&
    isDigest(options.checkoutId) &&
    /^cgsn_[0-9a-f]{40}(?:-[a-z0-9]+)*$/.test(options.snapshotId)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function serializeEntry(entry: PreparedSpoolBudgetEntry): string {
  return JSON.stringify({
    bytes: entry.bytes,
    checkoutId: entry.checkoutId,
    ...(entry.version === 2 ? {createdAt: entry.createdAt} : {}),
    processId: entry.processId,
    ...(entry.processStartIdentity === undefined ? {} : {processStartIdentity: entry.processStartIdentity}),
    snapshotId: entry.snapshotId,
    ...(entry.version === 2 ? {state: entry.state} : {}),
    token: entry.token,
    version: entry.version,
  });
}

const readEntryFile = Effect.fn('codeGraph.preparedSpoolBudget.readEntry')(function* (
  fs: FileSystem.FileSystem,
  file: string,
) {
  if (!(yield* fs.exists(file))) return undefined;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return undefined;
  const info = yield* fs.stat(file);
  if (info.type !== 'File' || Number(info.size) > ENTRY_BYTES_MAXIMUM) return undefined;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* fs.open(file, {flag: 'r'});
      const openedBefore = yield* opened.stat;
      const pathOpened = yield* fs.stat(file);
      if (!sameEntryFileInfo(info, openedBefore) || !sameEntryFileInfo(info, pathOpened)) return undefined;
      const bytes = new Uint8Array(ENTRY_BYTES_MAXIMUM + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Number(yield* opened.read(bytes.subarray(offset)));
        if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - offset) return undefined;
        if (count === 0) break;
        offset += count;
      }
      const openedAfter = yield* opened.stat;
      const pathAfter = yield* fs.stat(file);
      if (
        !sameEntryFileInfo(info, openedAfter) ||
        !sameEntryFileInfo(info, pathAfter) ||
        offset > ENTRY_BYTES_MAXIMUM ||
        BigInt(offset) !== info.size
      )
        return undefined;
      return yield* Effect.try(() =>
        new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, offset)),
      );
    }),
  );
});

function sameEntryFileInfo(left: FileSystem.File.Info, right: FileSystem.File.Info): boolean {
  return (
    left.type === 'File' &&
    right.type === 'File' &&
    left.dev === right.dev &&
    Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino) &&
    left.size === right.size &&
    left.mode === right.mode &&
    Option.getOrUndefined(left.mtime)?.getTime() === Option.getOrUndefined(right.mtime)?.getTime()
  );
}
