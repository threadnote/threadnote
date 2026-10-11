import {Clock, Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {fromPromise} from '@threadnote/platform/errors';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  fileSystemModeIsPrivate,
  runtimePlatform,
  runtimeReadBoundedStableRegularFile,
  SystemInfo,
  type SystemInfoShape,
} from '@threadnote/platform/system';
import {codeGraphRefreshDemandLockPath, codeGraphRefreshDemandPath} from '../layout.js';
import {
  adoptCodeGraphRefreshDemand,
  beginCodeGraphRefreshDemandPublication,
  completeCodeGraphRefreshDemand,
  deferCodeGraphRefreshDemand as deferDemandState,
  emptyCodeGraphRefreshDemand,
  enqueueCodeGraphRefreshDemand,
  failCodeGraphRefreshDemand as failDemandState,
  recoverCodeGraphRefreshDemand as recoverDemandState,
  registerCodeGraphRefreshDemand,
  resumeCodeGraphRefreshDemand as resumeDemandState,
  validCodeGraphRefreshDemand,
  type CodeGraphRefreshDemandState,
} from './demand_scheduler.js';
import type {CodeGraphRefreshContinuity} from '../watcher.js';

const MAXIMUM_BYTES = 8 * 1024;
const LOCK_STALE_MILLISECONDS = 15_000;
const PRE_STATUS_OWNER_GRACE_MILLISECONDS = 30_000;
/** Private isolated-builder control result; never part of the CLI contract. */
export const CODE_GRAPH_REFRESH_DEMAND_SUPERSEDED_EXIT_CODE = 75;

export class CodeGraphRefreshDemandSuperseded extends Schema.TaggedError<CodeGraphRefreshDemandSuperseded>()(
  'CodeGraphRefreshDemandSuperseded',
  {message: Schema.String},
) {}

export interface CodeGraphRefreshDemandIdentity {
  readonly checkoutId: string;
  /** Opaque selected graph view; absent retains the legacy full-repository sidecar. */
  readonly scopeId?: string;
  readonly threadnoteHome: string;
  readonly worktreeId: string;
}

interface CodeGraphRefreshDemandLivenessObservation {
  readonly liveness: 'active' | 'inactive';
  readonly owner?: {readonly processId: number; readonly processStartIdentity?: string};
  readonly requestKey?: string;
  readonly spawnOwner?: {readonly processId: number; readonly processStartIdentity?: string};
}

type Mutation<A, E = never, R = never> = (
  state: CodeGraphRefreshDemandState,
) => Effect.Effect<{readonly state: CodeGraphRefreshDemandState; readonly value: A}, E, R>;

interface DirectoryAuthority {
  readonly birthtimeMilliseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly path: string;
  readonly realPath: string;
  readonly uid: number | undefined;
}

/**
 * Serializes a small, private scheduling document. Invalid sidecars are
 * reconstructed under the lock and can never grant publication.
 */
const mutate = Effect.fn('codeGraph.refreshDemand.mutate')(function* <A, E, R>(
  identity: CodeGraphRefreshDemandIdentity,
  f: Mutation<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const dataPath = codeGraphRefreshDemandPath(
    path,
    identity.threadnoteHome,
    identity.checkoutId,
    identity.worktreeId,
    identity.scopeId,
  );
  const lockPath = codeGraphRefreshDemandLockPath(
    path,
    identity.threadnoteHome,
    identity.checkoutId,
    identity.worktreeId,
    identity.scopeId,
  );
  // Full-repository demand files retain their historical direct-home names;
  // scoped files live under a private checkout directory to keep atomic
  // temporary names below filesystem component limits.
  const dataAncestors =
    path.dirname(dataPath) === identity.threadnoteHome
      ? [identity.threadnoteHome]
      : [identity.threadnoteHome, path.dirname(path.dirname(dataPath)), path.dirname(dataPath)];
  const lockAncestors = dataAncestors;
  yield* ensurePrivateDirectories(fs, dataAncestors);
  const lockAuthority = yield* inspectPrivateDirectories(fs, lockAncestors);
  if (lockAuthority === undefined)
    return yield* CodeGraphRefreshDemandSuperseded.make({
      message: 'Code graph refresh demand lock directory is unavailable.',
    });
  if (Option.isSome(yield* fs.readLink(lockPath).pipe(Effect.option)))
    return yield* CodeGraphRefreshDemandSuperseded.make({
      message: 'Code graph refresh demand lock path is a symbolic link.',
    });
  return yield* withExclusiveFileLock(
    fs,
    lockPath,
    {
      heartbeatIntervalMilliseconds: 5_000,
      recoverReusedProcessIdImmediately: true,
      retryIntervalMilliseconds: 10,
      staleAfterMilliseconds: LOCK_STALE_MILLISECONDS,
      useCanonicalProcessStartIdentity: true,
      waitTimeoutMilliseconds: 5_000,
    },
    Effect.gen(function* () {
      const lockedAuthority = yield* inspectPrivateDirectories(fs, lockAncestors);
      if (lockedAuthority === undefined || !sameDirectories(lockAuthority, lockedAuthority))
        return yield* CodeGraphRefreshDemandSuperseded.make({
          message: 'Code graph refresh demand lock directory changed.',
        });
      const state = yield* readState(fs, dataPath, dataAncestors, identity);
      const result = yield* f(state);
      if (result.state !== state) yield* writeState(fs, crypto, dataPath, dataAncestors, result.state);
      const completedAuthority = yield* inspectPrivateDirectories(fs, lockAncestors);
      if (completedAuthority === undefined || !sameDirectories(lockAuthority, completedAuthority))
        return yield* CodeGraphRefreshDemandSuperseded.make({
          message: 'Code graph refresh demand lock directory changed.',
        });
      return result.value;
    }),
  );
});

export const registerCodeGraphBackgroundDemand = Effect.fn('codeGraph.refreshDemand.register')(function* (
  identity: CodeGraphRefreshDemandIdentity,
  targetKey: string,
) {
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  const now = yield* Clock.currentTimeMillis;
  const token = `cgdq_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const processStartIdentity = yield* system.canonicalProcessStartIdentity?.(system.processId) ??
    system.processStartIdentity(system.processId);
  return yield* mutate(identity, state =>
    Effect.sync(() => {
      const registration = registerCodeGraphRefreshDemand(state, {
        now,
        owner: {processId: system.processId, ...(processStartIdentity === undefined ? {} : {processStartIdentity})},
        targetKey,
        token,
      });
      return {state: registration.state, value: registration};
    }),
  );
});

/** Atomically resumes an existing lane and converges it to the latest observed target. */
export const resumeCodeGraphBackgroundDemand = Effect.fn('codeGraph.refreshDemand.resume')(function* (
  identity: CodeGraphRefreshDemandIdentity,
  targetKey: string,
  observed?: CodeGraphRefreshDemandLivenessObservation,
) {
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  const now = yield* Clock.currentTimeMillis;
  const token = `cgdq_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const processStartIdentity = yield* system.canonicalProcessStartIdentity?.(system.processId) ??
    system.processStartIdentity(system.processId);
  return yield* mutate(identity, state =>
    Effect.gen(function* () {
      const ownerLive = yield* activeDemandOwnerLive(state, observed, now, system);
      const registration = resumeDemandState(state, {
        now,
        owner: {processId: system.processId, ...(processStartIdentity === undefined ? {} : {processStartIdentity})},
        ownerLive,
        targetKey,
        token,
      });
      return {state: registration?.state ?? state, value: registration};
    }),
  );
});

export const enqueueCodeGraphBackgroundDemand = Effect.fn('codeGraph.refreshDemand.enqueue')(function* (
  identity: CodeGraphRefreshDemandIdentity,
  targetKey: string,
) {
  const crypto = yield* Crypto.Crypto;
  const now = yield* Clock.currentTimeMillis;
  const token = `cgdq_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  return yield* mutate(identity, state =>
    Effect.sync(() => {
      const registration = enqueueCodeGraphRefreshDemand(state, {now, targetKey, token});
      return {state: registration.state, value: registration};
    }),
  );
});

export const adoptCodeGraphBackgroundDemand = Effect.fn('codeGraph.refreshDemand.adopt')(function* (
  identity: CodeGraphRefreshDemandIdentity,
  token: string,
  targetKey: string,
) {
  const system = yield* SystemInfo;
  const processStartIdentity = yield* system.canonicalProcessStartIdentity?.(system.processId) ??
    system.processStartIdentity(system.processId);
  return yield* mutate(identity, state =>
    Effect.sync(() => {
      const result = adoptCodeGraphRefreshDemand(state, token, targetKey, {
        processId: system.processId,
        ...(processStartIdentity === undefined ? {} : {processStartIdentity}),
      });
      return {state: result.state, value: result.adopted};
    }),
  );
});

export const beginCodeGraphBackgroundPublication = Effect.fn('codeGraph.refreshDemand.beginPublication')(function* (
  identity: CodeGraphRefreshDemandIdentity,
  token: string,
  targetKey: string,
) {
  return yield* mutate(identity, state =>
    Effect.sync(() => {
      const result = beginCodeGraphRefreshDemandPublication(state, token, targetKey);
      return {state: result.state, value: result.type};
    }),
  );
});

export const completeCodeGraphBackgroundDemand = Effect.fn('codeGraph.refreshDemand.complete')(function* (
  identity: CodeGraphRefreshDemandIdentity,
  token: string,
  targetKey: string,
) {
  return yield* mutate(identity, state =>
    Effect.sync(() => {
      const next = completeCodeGraphRefreshDemand(state, token, targetKey);
      return {state: next, value: next};
    }),
  );
});

export const deferCodeGraphBackgroundDemand = Effect.fn('codeGraph.refreshDemand.defer')(function* (
  identity: CodeGraphRefreshDemandIdentity,
  token: string,
  targetKey: string,
) {
  const now = yield* Clock.currentTimeMillis;
  return yield* mutate(identity, state =>
    Effect.sync(() => {
      const next = deferDemandState(state, token, targetKey, now);
      return {state: next, value: next};
    }),
  );
});

export const failCodeGraphBackgroundDemand = Effect.fn('codeGraph.refreshDemand.fail')(function* (
  identity: CodeGraphRefreshDemandIdentity,
  token: string,
  targetKey: string,
) {
  return yield* mutate(identity, state =>
    Effect.sync(() => {
      const next = failDemandState(state, token, targetKey);
      return {state: next, value: next};
    }),
  );
});

/** Build-status and spawn-lock remain liveness authority; this only repairs intent. */
export const recoverCodeGraphBackgroundDemand = Effect.fn('codeGraph.refreshDemand.recover')(function* (
  identity: CodeGraphRefreshDemandIdentity,
  observed?: CodeGraphRefreshDemandLivenessObservation,
) {
  const system = yield* SystemInfo;
  const now = yield* Clock.currentTimeMillis;
  return yield* mutate(identity, state =>
    Effect.gen(function* () {
      const ownerLive = yield* activeDemandOwnerLive(state, observed, now, system);
      const next = recoverDemandState(state, ownerLive);
      return {state: next, value: next};
    }),
  );
});

/**
 * Reads the bounded sidecar under the same lock used for reconciliation and
 * projects only opaque, non-capability continuity.  Scheduling and liveness
 * remain owned by the watcher/build-status paths.
 */
export const observeCodeGraphBackgroundDemand = Effect.fn('codeGraph.refreshDemand.observe')(function* (
  identity: CodeGraphRefreshDemandIdentity,
) {
  const now = yield* Clock.currentTimeMillis;
  return yield* mutate(identity, state =>
    Effect.sync(() => ({state, value: codeGraphRefreshDemandContinuity(state, now)})),
  );
});

export function codeGraphRefreshDemandContinuity(
  state: CodeGraphRefreshDemandState,
  now: number,
): CodeGraphRefreshContinuity {
  const active = state.active;
  const desired = state.desired;
  if (active) {
    return {
      type: 'code-graph-refresh-continuity',
      version: 1,
      state: 'active',
      currentTargetToken: active.targetToken,
      ...(desired === undefined ? {} : {latestDesiredToken: desired.targetToken}),
    };
  }
  if (desired) {
    const retryAfterMilliseconds = desired.retry === undefined ? undefined : Math.max(0, desired.retry.notBefore - now);
    return {
      type: 'code-graph-refresh-continuity',
      version: 1,
      state: retryAfterMilliseconds === undefined || retryAfterMilliseconds === 0 ? 'queued' : 'deferred',
      queueToken: desired.targetToken,
      latestDesiredToken: desired.targetToken,
      ...(retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds}),
    };
  }
  return {type: 'code-graph-refresh-continuity', version: 1, state: 'idle'};
}

export function codeGraphRefreshDemandFromEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  const token = environment.THREADNOTE_CODE_GRAPH_REFRESH_DEMAND_TOKEN;
  return token && /^cgdq_[0-9a-f]{32}$/u.test(token) ? token : undefined;
}

function readState(
  fs: FileSystem.FileSystem,
  dataPath: string,
  ancestors: readonly string[],
  identity: CodeGraphRefreshDemandIdentity,
): Effect.Effect<CodeGraphRefreshDemandState, never, SystemInfo> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(dataPath))) return emptyCodeGraphRefreshDemand(identity.checkoutId, identity.worktreeId);
    const before = yield* inspectPrivateDirectories(fs, ancestors);
    if (before === undefined) return emptyCodeGraphRefreshDemand(identity.checkoutId, identity.worktreeId);
    const bytes = yield* fromPromise('codeGraph.refreshDemand.readStable', () =>
      runtimeReadBoundedStableRegularFile(dataPath, MAXIMUM_BYTES),
    ).pipe(Effect.option);
    const after = yield* inspectPrivateDirectories(fs, ancestors);
    if (Option.isNone(bytes) || after === undefined || !sameDirectories(before, after))
      return emptyCodeGraphRefreshDemand(identity.checkoutId, identity.worktreeId);
    const parsed = parseDemand(new TextDecoder().decode(bytes.value));
    if (
      parsed !== undefined &&
      validCodeGraphRefreshDemand(parsed) &&
      parsed.checkoutId === identity.checkoutId &&
      parsed.worktreeId === identity.worktreeId
    )
      return parsed;
    return emptyCodeGraphRefreshDemand(identity.checkoutId, identity.worktreeId);
  }).pipe(Effect.orDie);
}

function parseDemand(content: string): CodeGraphRefreshDemandState | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CodeGraphRefreshDemandState) : undefined;
  } catch {
    return undefined;
  }
}

function writeState(
  fs: FileSystem.FileSystem,
  crypto: Crypto.Crypto,
  dataPath: string,
  ancestors: readonly string[],
  state: CodeGraphRefreshDemandState,
) {
  return Effect.gen(function* () {
    const before = yield* inspectPrivateDirectories(fs, ancestors);
    if (before === undefined)
      return yield* CodeGraphRefreshDemandSuperseded.make({
        message: 'Code graph refresh demand directory is unavailable.',
      });
    if (Option.isSome(yield* fs.readLink(dataPath).pipe(Effect.option)))
      return yield* CodeGraphRefreshDemandSuperseded.make({
        message: 'Code graph refresh demand path is a symbolic link.',
      });
    const content = `${JSON.stringify(state)}\n`;
    if (new TextEncoder().encode(content).byteLength > MAXIMUM_BYTES)
      return yield* CodeGraphRefreshDemandSuperseded.make({
        message: 'Code graph refresh demand exceeds its bounded sidecar size.',
      });
    const temporary = `${dataPath}.${yield* crypto.randomUUIDv4()}.tmp`;
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
    const temporaryInfo = yield* fs.stat(temporary);
    if (temporaryInfo.type !== 'File' || !fileSystemModeIsPrivate(runtimePlatform, temporaryInfo.mode)) {
      yield* fs.remove(temporary, {force: true}).pipe(Effect.ignore);
      return yield* CodeGraphRefreshDemandSuperseded.make({
        message: 'Code graph refresh demand staging file is invalid.',
      });
    }
    const afterWrite = yield* inspectPrivateDirectories(fs, ancestors);
    if (afterWrite === undefined || !sameDirectories(before, afterWrite)) {
      yield* fs.remove(temporary, {force: true}).pipe(Effect.ignore);
      return yield* CodeGraphRefreshDemandSuperseded.make({message: 'Code graph refresh demand directory changed.'});
    }
    yield* fs
      .rename(temporary, dataPath)
      .pipe(Effect.onError(() => fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
    if (Option.isSome(yield* fs.readLink(dataPath).pipe(Effect.option)))
      return yield* CodeGraphRefreshDemandSuperseded.make({
        message: 'Code graph refresh demand path changed during write.',
      });
    const targetInfo = yield* fs.stat(dataPath);
    if (!sameFile(temporaryInfo, targetInfo))
      return yield* CodeGraphRefreshDemandSuperseded.make({
        message: 'Code graph refresh demand path changed during write.',
      });
    const afterRename = yield* inspectPrivateDirectories(fs, ancestors);
    if (afterRename === undefined || !sameDirectories(before, afterRename))
      return yield* CodeGraphRefreshDemandSuperseded.make({message: 'Code graph refresh demand directory changed.'});
  });
}

function sameFile(left: FileSystem.File.Info, right: FileSystem.File.Info): boolean {
  return (
    left.type === 'File' &&
    right.type === 'File' &&
    left.dev === right.dev &&
    Option.getOrUndefined(left.ino) === Option.getOrUndefined(right.ino) &&
    left.mode === right.mode &&
    left.size === right.size &&
    Option.getOrUndefined(left.birthtime)?.getTime() === Option.getOrUndefined(right.birthtime)?.getTime() &&
    Option.getOrUndefined(left.mtime)?.getTime() === Option.getOrUndefined(right.mtime)?.getTime()
  );
}

function ensurePrivateDirectories(fs: FileSystem.FileSystem, directories: readonly string[]) {
  return Effect.gen(function* () {
    const [root, ...children] = directories;
    if (root === undefined) return;
    if ((yield* inspectPrivateDirectories(fs, [root])) === undefined)
      return yield* CodeGraphRefreshDemandSuperseded.make({
        message: 'Threadnote home is not an owner-controlled directory.',
      });
    const accepted: string[] = [root];
    for (const directory of children) {
      const before = yield* inspectPrivateDirectories(fs, accepted);
      if (before === undefined)
        return yield* CodeGraphRefreshDemandSuperseded.make({
          message: 'Code graph refresh demand parent is unavailable.',
        });
      yield* fs.makeDirectory(directory, {mode: 0o700}).pipe(Effect.ignore);
      const after = yield* inspectPrivateDirectories(fs, accepted);
      if (after === undefined || !sameDirectories(before, after))
        return yield* CodeGraphRefreshDemandSuperseded.make({message: 'Code graph refresh demand parent changed.'});
      accepted.push(directory);
      if ((yield* inspectPrivateDirectories(fs, accepted)) === undefined)
        return yield* CodeGraphRefreshDemandSuperseded.make({
          message: 'Code graph refresh demand directory is not private.',
        });
    }
  });
}

function inspectPrivateDirectories(fs: FileSystem.FileSystem, directories: readonly string[]) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const authorities: DirectoryAuthority[] = [];
    for (const [index, directory] of directories.entries()) {
      if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) return undefined;
      const info = yield* fs.stat(directory).pipe(Effect.option);
      if (
        Option.isNone(info) ||
        info.value.type !== 'Directory' ||
        !refreshDemandDirectoryIsTrusted(system, info.value, index === 0)
      )
        return undefined;
      const birthtime = Option.getOrUndefined(info.value.birthtime);
      const ino = Option.getOrUndefined(info.value.ino);
      if (birthtime === undefined || ino === undefined) return undefined;
      authorities.push({
        birthtimeMilliseconds: birthtime.getTime(),
        dev: info.value.dev,
        ino,
        mode: info.value.mode,
        path: directory,
        realPath: yield* fs.realPath(directory),
        uid: Option.getOrUndefined(info.value.uid),
      });
    }
    return authorities;
  });
}

function refreshDemandDirectoryIsTrusted(
  system: SystemInfoShape,
  info: FileSystem.File.Info,
  threadnoteHome: boolean,
): boolean {
  if (system.platform === 'win32') return true;
  const uid = Option.getOrUndefined(info.uid);
  return (
    system.userId !== undefined &&
    uid === system.userId &&
    (threadnoteHome ? (info.mode & 0o022) === 0 : fileSystemModeIsPrivate(runtimePlatform, info.mode))
  );
}

function sameDirectories(left: readonly DirectoryAuthority[], right: readonly DirectoryAuthority[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        entry.birthtimeMilliseconds === candidate.birthtimeMilliseconds &&
        entry.dev === candidate.dev &&
        entry.ino === candidate.ino &&
        entry.mode === candidate.mode &&
        entry.path === candidate.path &&
        entry.realPath === candidate.realPath &&
        entry.uid === candidate.uid
      );
    })
  );
}

function activeDemandOwnerLive(
  state: CodeGraphRefreshDemandState,
  observed: CodeGraphRefreshDemandLivenessObservation | undefined,
  now: number,
  system: SystemInfoShape,
) {
  return Effect.gen(function* () {
    const active = state.active;
    if (active === undefined) return false;
    const owner = active.claimOwner;
    const withinPreStatusGrace =
      (active.phase === 'claimed' || active.phase === 'preparing') &&
      now - active.claimStartedAt <= PRE_STATUS_OWNER_GRACE_MILLISECONDS;
    const livePreStatusOwner = withinPreStatusGrace && (yield* processOwnerIsLive(system, owner));
    const livePreStatusSpawnOwner = withinPreStatusGrace && sameProcessOwner(observed?.spawnOwner, owner);
    const livePublishingOwner = active.phase === 'publishing' && (yield* processOwnerIsLive(system, owner));
    return (
      (observed?.liveness === 'active' &&
        observed.requestKey === active.targetKey &&
        sameProcessOwner(observed.owner, owner)) ||
      livePreStatusSpawnOwner ||
      livePreStatusOwner ||
      livePublishingOwner
    );
  });
}

function sameProcessOwner(
  left: {readonly processId: number; readonly processStartIdentity?: string} | undefined,
  right: {readonly processId: number; readonly processStartIdentity?: string} | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.processId === right.processId &&
    (right.processStartIdentity === undefined || left.processStartIdentity === right.processStartIdentity)
  );
}

function processOwnerIsLive(
  system: SystemInfoShape,
  owner: {readonly processId: number; readonly processStartIdentity?: string} | undefined,
) {
  return Effect.gen(function* () {
    if (owner === undefined || !system.isProcessRunning(owner.processId)) return false;
    if (owner.processStartIdentity === undefined) return false;
    const current = yield* system.canonicalProcessStartIdentity?.(owner.processId) ??
      system.processStartIdentity(owner.processId);
    return current === owner.processStartIdentity;
  });
}
