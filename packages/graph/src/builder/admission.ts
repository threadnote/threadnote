import {Array as EffectArray} from 'effect';
import {Clock, Crypto, DateTime, Effect, FileSystem, Option, Path, Predicate, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isFileLockTimeout, readExclusiveFileLockOwner, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runtimeTextDirectoryNamePage, SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {
  codeGraphBuilderAdmissionLockPath,
  codeGraphBuilderAdmissionRoot,
  codeGraphBuilderAdmissionSlotPath,
} from '../layout.js';
import {
  orderCodeGraphBuilderAdmissionQueue,
  selectCodeGraphBuilderAdmissionTickets,
  type CodeGraphBuilderAdmissionClass,
  type CodeGraphBuilderAdmissionIdentity,
  type CodeGraphBuilderAdmissionQueue,
} from './admission_scheduler.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export {CODE_GRAPH_BUILDER_HOME_CAPACITY, orderCodeGraphBuilderAdmissionTickets} from './admission_scheduler.js';
export type {CodeGraphBuilderAdmissionClass} from './admission_scheduler.js';
export const CODE_GRAPH_BUILDER_ADMISSION_CLASS_ENV = 'THREADNOTE_CODE_GRAPH_BUILDER_ADMISSION_CLASS';

interface BuilderAdmissionTicket extends Partial<CodeGraphBuilderAdmissionIdentity> {
  readonly admissionClass: CodeGraphBuilderAdmissionClass;
  readonly createdAt: number;
  readonly processId: number;
  readonly processStartIdentity?: string;
  readonly token: string;
  readonly version: 1 | 2;
}

interface OwnedTicket extends BuilderAdmissionTicket {
  readonly path: string;
  readonly serialized: string;
}

const TICKET_NAME = /^v([12])-([0-9a-f]{64})\.json$/;
const TICKET_BYTES_MAXIMUM = 1_024;
const TICKET_COUNT_MAXIMUM = 256;
const ADMISSION_RETRY_MILLISECONDS = 25;
const LEDGER_LOCK_WAIT_MILLISECONDS = 5_000;
const SLOT_STALE_MILLISECONDS = 15_000;

class CodeGraphBuilderAdmissionError extends Schema.TaggedError<
  CodeGraphBuilderAdmissionError,
  {readonly brand: unique symbol}
>()('CodeGraphBuilderAdmissionError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/**
 * Home-global admission. Selection and slot ownership publication share the
 * ledger lock; the actual build runs outside that lock under its slot lease.
 */
export function withCodeGraphBuilderAdmission<A, E, R>(
  options: {
    readonly admissionClass: CodeGraphBuilderAdmissionClass;
    readonly identity?: CodeGraphBuilderAdmissionIdentity;
    readonly onQueue?: (queue: CodeGraphBuilderAdmissionQueue) => Effect.Effect<void, never>;
    readonly onAdmitted?: Effect.Effect<void, never>;
    readonly onResumed?: Effect.Effect<void, never>;
    readonly onWaiting?: Effect.Effect<void, never>;
    readonly threadnoteHome: string;
  },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R | Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    let waitingReported = false;
    let previousQueue: string | undefined;
    return yield* Effect.acquireUseRelease(
      createTicket(fs, path, system, options.threadnoteHome, options.admissionClass, options.identity),
      ticket =>
        Effect.gen(function* () {
          for (;;) {
            const selection = yield* ticketSelection(fs, path, system, options.threadnoteHome, ticket);
            const queueSignature = JSON.stringify(selection.queue);
            if (queueSignature !== previousQueue) {
              yield* options.onQueue?.(selection.queue) ?? Effect.void;
              previousQueue = queueSignature;
            }
            if (selection.selected) {
              for (const slot of [0, 1] as const) {
                const result = yield* withExclusiveFileLock(
                  fs,
                  codeGraphBuilderAdmissionSlotPath(path, options.threadnoteHome, slot),
                  {
                    heartbeatIntervalMilliseconds: 5_000,
                    recoverReusedProcessIdImmediately: true,
                    retryIntervalMilliseconds: 1,
                    staleAfterMilliseconds: SLOT_STALE_MILLISECONDS,
                    useCanonicalProcessStartIdentity: true,
                    waitTimeoutMilliseconds: 0,
                  },
                  Effect.gen(function* () {
                    const ownership = yield* claimSlot(fs, path, system, options.threadnoteHome, ticket, slot);
                    if (!ownership) return {state: 'contended' as const};
                    return yield* (options.onAdmitted ?? Effect.void).pipe(
                      Effect.andThen(waitingReported ? (options.onResumed ?? Effect.void) : Effect.void),
                      Effect.andThen(effect),
                      Effect.map(value => ({state: 'completed' as const, value})),
                    );
                  }).pipe(
                    Effect.ensuring(
                      removeSlotOwnership(fs, path, options.threadnoteHome, slot, ticket.token).pipe(Effect.ignore),
                    ),
                  ),
                ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed({state: 'contended' as const})));
                if (result.state === 'completed') return result.value;
              }
            }
            if (!waitingReported) {
              yield* options.onWaiting ?? Effect.void;
              waitingReported = true;
            }
            yield* Effect.sleep(ADMISSION_RETRY_MILLISECONDS);
          }
        }),
      ticket => removeOwnedTicket(fs, path, options.threadnoteHome, ticket).pipe(Effect.ignore),
    );
  });
}

const createTicket = Effect.fn('codeGraph.builderAdmission.createTicket')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
  admissionClass: CodeGraphBuilderAdmissionClass,
  identity?: CodeGraphBuilderAdmissionIdentity,
) {
  const crypto = yield* Crypto.Crypto;
  const root = codeGraphBuilderAdmissionRoot(path, threadnoteHome);
  yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  if (system.platform !== 'win32') yield* fs.chmod(root, 0o700);
  const token = sha256HexSync(`${system.processId}\0${yield* crypto.randomUUIDv4()}`);
  const processStartIdentity = yield* system.canonicalProcessStartIdentity?.(system.processId) ??
    system.processStartIdentity(system.processId);
  const ticket: OwnedTicket = {
    checkoutId: identity?.checkoutId ?? token,
    worktreeId: identity?.worktreeId ?? token,
    ...(identity?.requestKey === undefined ? {} : {requestKey: identity.requestKey}),
    ...(identity?.desiredOverlayDigest === undefined ? {} : {desiredOverlayDigest: identity.desiredOverlayDigest}),
    admissionClass,
    createdAt: yield* Clock.currentTimeMillis,
    path: path.join(root, `v2-${token}.json`),
    processId: system.processId,
    ...(processStartIdentity === undefined ? {} : {processStartIdentity}),
    serialized: '',
    token,
    version: 2,
  };
  const serialized = JSON.stringify({...ticket, path: undefined, serialized: undefined});
  if (new TextEncoder().encode(serialized).length > TICKET_BYTES_MAXIMUM || !parseTicket(serialized, token)) {
    return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder admission identity is invalid.'});
  }
  const owned = {...ticket, serialized};
  const temporaryPath = `${owned.path}.${Effect2.pipe(token, EffectString.slice(0, 16))}.tmp`;
  yield* withLedgerLock(
    fs,
    codeGraphBuilderAdmissionLockPath(path, threadnoteHome),
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporaryPath, {flag: 'wx', mode: 0o600});
        yield* file.writeAll(new TextEncoder().encode(serialized));
        yield* file.sync;
      }),
    ).pipe(
      Effect.andThen(fs.rename(temporaryPath, owned.path)),
      Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)),
    ),
  );
  if (system.platform !== 'win32') yield* fs.chmod(owned.path, 0o600);
  return owned;
});

const ticketSelection = Effect.fn('codeGraph.builderAdmission.select')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
  owned: OwnedTicket,
) {
  return yield* withLedgerLock(
    fs,
    codeGraphBuilderAdmissionLockPath(path, threadnoteHome),
    Effect.gen(function* () {
      const tickets = yield* scanTickets(fs, path, system, threadnoteHome);
      const active = yield* activeCheckouts(fs, path, system, threadnoteHome);
      const now = yield* Clock.currentTimeMillis;
      const selected = selectCodeGraphBuilderAdmissionTickets(tickets, active, now);
      const ordered = orderCodeGraphBuilderAdmissionQueue(tickets, active, now);
      return {
        selected: EffectArray.some(selected, ticket => ticket.token === owned.token),
        queue: {
          admissionClass: owned.admissionClass,
          enqueuedAt: DateTime.formatIso(DateTime.makeUnsafe(owned.createdAt)),
          position:
            Option.getOrElse(
              EffectArray.findFirstIndex(ordered, ticket => ticket.token === owned.token),
              () => -1,
            ) + 1,
          size: tickets.length,
        },
      };
    }),
  );
});

const scanTickets = Effect.fn('codeGraph.builderAdmission.scan')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
) {
  const root = codeGraphBuilderAdmissionRoot(path, threadnoteHome);
  if (!(yield* fs.exists(root))) return [] as OwnedTicket[];
  const page = yield* runtimeTextDirectoryNamePage(root, TICKET_COUNT_MAXIMUM);
  if (page.overflow) return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket bound exceeded.'});
  const tickets: OwnedTicket[] = [];
  for (const name of [...page.names].sort()) {
    const match = TICKET_NAME.exec(name);
    const token = match?.[2];
    if (!token) return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket name is invalid.'});
    const ticketPath = path.join(root, name);
    if ((yield* fs.readLink(ticketPath).pipe(Effect.option))._tag === 'Some') {
      return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket is symbolic.'});
    }
    const info = yield* fs.stat(ticketPath);
    if (info.type !== 'File' || Number(info.size) > TICKET_BYTES_MAXIMUM) {
      return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket is invalid.'});
    }
    const serialized = yield* fs.readFileString(ticketPath);
    const parsed = parseTicket(serialized, token);
    if (!parsed || String(parsed.version) !== match?.[1])
      return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder ticket content is invalid.'});
    if (yield* ticketOwnerIsDead(system, parsed)) {
      yield* fs.remove(ticketPath, {force: true});
      continue;
    }
    tickets.push({...parsed, path: ticketPath, serialized});
  }
  return tickets;
});

function parseTicket(serialized: string, token: string): BuilderAdmissionTicket | undefined {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Predicate.isObject(parsed)) return undefined;
    const value = parsed;
    if (
      (value.version !== 1 && value.version !== 2) ||
      value.token !== token ||
      (value.admissionClass !== 'background' && value.admissionClass !== 'current-required') ||
      typeof value.createdAt !== 'number' ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt < 0 ||
      value.createdAt > 8_640_000_000_000_000 ||
      typeof value.processId !== 'number' ||
      !Number.isSafeInteger(value.processId) ||
      value.processId <= 0 ||
      ((value.processStartIdentity !== undefined || EffectRecord.has(value, 'processStartIdentity')) &&
        (typeof value.processStartIdentity !== 'string' || value.processStartIdentity.length > 256)) ||
      (value.version === 2 && (!isDigest(value.checkoutId) || !isDigest(value.worktreeId))) ||
      (value.requestKey !== undefined && !isDigest(value.requestKey)) ||
      (value.desiredOverlayDigest !== undefined && !isDigest(value.desiredOverlayDigest))
    ) {
      return undefined;
    }
    return {
      ...(value.version === 2 ? {checkoutId: String(value.checkoutId), worktreeId: String(value.worktreeId)} : {}),
      ...(typeof value.requestKey === 'string' ? {requestKey: value.requestKey} : {}),
      ...(typeof value.desiredOverlayDigest === 'string' ? {desiredOverlayDigest: value.desiredOverlayDigest} : {}),
      admissionClass: value.admissionClass,
      createdAt: value.createdAt,
      processId: value.processId,
      ...(value.processStartIdentity === undefined ? {} : {processStartIdentity: value.processStartIdentity}),
      token: value.token,
      version: value.version,
    };
  } catch {
    return undefined;
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

const readSlotOwnership = Effect.fn('codeGraph.builderAdmission.readSlot')(function* (
  fs: FileSystem.FileSystem,
  slotPath: string,
) {
  const file = `${slotPath}.owner.json`;
  if (!(yield* fs.exists(file))) return undefined;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return undefined;
  const info = yield* fs.stat(file);
  if (info.type !== 'File' || Number(info.size) > 2_048) return undefined;
  const content = yield* Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* fs.open(file, {flag: 'r'});
      const openedBefore = yield* opened.stat;
      const pathOpened = yield* fs.stat(file);
      if (!sameAdmissionFileInfo(info, openedBefore) || !sameAdmissionFileInfo(info, pathOpened)) return undefined;

      const bytes = new Uint8Array(2_049);
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
        !sameAdmissionFileInfo(info, openedAfter) ||
        !sameAdmissionFileInfo(info, pathAfter) ||
        offset > 2_048 ||
        BigInt(offset) !== info.size
      )
        return undefined;
      return yield* Effect.try(() =>
        new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.slice(0, offset)),
      );
    }),
  );
  if (content === undefined) return undefined;
  const value: unknown = yield* Effect.try(() => JSON.parse(content));
  if (
    !Predicate.isObject(value) ||
    typeof value.lockToken !== 'string' ||
    value.lockToken.length > 256 ||
    !isDigest(value.token)
  )
    return undefined;
  const ticket = parseTicket(JSON.stringify(value), value.token);
  return ticket ? {lockToken: value.lockToken, ticket} : undefined;
});

function sameAdmissionFileInfo(left: FileSystem.File.Info, right: FileSystem.File.Info): boolean {
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

const activeCheckouts = Effect.fn('codeGraph.builderAdmission.activeCheckouts')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
  exceptSlot?: 0 | 1,
) {
  const active: Array<string | undefined> = [];
  for (const slot of [0, 1] as const) {
    if (slot === exceptSlot) continue;
    const slotPath = codeGraphBuilderAdmissionSlotPath(path, threadnoteHome, slot);
    const owner = yield* readExclusiveFileLockOwner(fs, slotPath);
    if (Option.isNone(owner)) {
      // Permit an acquisition attempt so the lock primitive can recover invalid stale locks.
      continue;
    }
    if (yield* ticketOwnerIsDead(system, {...owner.value, admissionClass: 'background', createdAt: 0})) continue;
    const ownership = yield* readSlotOwnership(fs, slotPath).pipe(Effect.orElseSucceed(() => undefined));
    active.push(ownership?.lockToken === owner.value.token ? ownership.ticket.checkoutId : undefined);
  }
  return active;
});

const claimSlot = Effect.fn('codeGraph.builderAdmission.claimSlot')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  system: SystemInfoShape,
  threadnoteHome: string,
  ticket: OwnedTicket,
  slot: 0 | 1,
) {
  return yield* withLedgerLock(
    fs,
    codeGraphBuilderAdmissionLockPath(path, threadnoteHome),
    Effect.gen(function* () {
      const tickets = yield* scanTickets(fs, path, system, threadnoteHome);
      if (
        !EffectArray.some(
          tickets,
          candidate => candidate.token === ticket.token && candidate.serialized === ticket.serialized,
        )
      ) {
        return yield* CodeGraphBuilderAdmissionError.make({message: 'Builder admission ticket changed.'});
      }
      const active = yield* activeCheckouts(fs, path, system, threadnoteHome, slot);
      const selected = selectCodeGraphBuilderAdmissionTickets(tickets, active, yield* Clock.currentTimeMillis);
      if (!EffectArray.some(selected, candidate => candidate.token === ticket.token)) return false;
      const slotPath = codeGraphBuilderAdmissionSlotPath(path, threadnoteHome, slot);
      const owner = yield* readExclusiveFileLockOwner(fs, slotPath);
      if (Option.isNone(owner)) return false;
      const ownership = JSON.stringify({...JSON.parse(ticket.serialized), lockToken: owner.value.token});
      // Replacing the directory entry also replaces stale or symbolic metadata without following it.
      const temporaryPath = `${slotPath}.owner.tmp`;
      yield* fs.remove(temporaryPath, {force: true});
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporaryPath, {flag: 'wx', mode: 0o600});
          yield* file.writeAll(new TextEncoder().encode(ownership));
          yield* file.sync;
        }),
      ).pipe(
        Effect.andThen(fs.rename(temporaryPath, `${slotPath}.owner.json`)),
        Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)),
      );
      yield* fs.remove(ticket.path, {force: true});
      return true;
    }),
  );
});

const removeSlotOwnership = Effect.fn('codeGraph.builderAdmission.removeSlot')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  slot: 0 | 1,
  token: string,
) {
  yield* withLedgerLock(
    fs,
    codeGraphBuilderAdmissionLockPath(path, threadnoteHome),
    Effect.gen(function* () {
      const slotPath = codeGraphBuilderAdmissionSlotPath(path, threadnoteHome, slot);
      const ownership = yield* readSlotOwnership(fs, slotPath);
      if (ownership?.ticket.token === token) yield* fs.remove(`${slotPath}.owner.json`, {force: true});
    }),
  );
});

const ticketOwnerIsDead = Effect.fn('codeGraph.builderAdmission.ownerDead')(function* (
  system: SystemInfoShape,
  ticket: BuilderAdmissionTicket,
) {
  if (!system.isProcessRunning(ticket.processId)) return true;
  if (ticket.processStartIdentity === undefined) return false;
  const current = yield* system.canonicalProcessStartIdentity?.(ticket.processId) ??
    system.processStartIdentity(ticket.processId);
  return current !== undefined && current !== ticket.processStartIdentity;
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
      waitTimeoutMilliseconds: LEDGER_LOCK_WAIT_MILLISECONDS,
    },
    effect,
  );
}

const removeOwnedTicket = Effect.fn('codeGraph.builderAdmission.removeTicket')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  ticket: OwnedTicket,
) {
  yield* withLedgerLock(
    fs,
    codeGraphBuilderAdmissionLockPath(path, threadnoteHome),
    Effect.gen(function* () {
      if (!(yield* fs.exists(ticket.path))) return;
      if ((yield* fs.readLink(ticket.path).pipe(Effect.option))._tag === 'Some') return;
      const content = yield* fs.readFileString(ticket.path);
      if (content === ticket.serialized) yield* fs.remove(ticket.path, {force: true});
    }),
  );
});
