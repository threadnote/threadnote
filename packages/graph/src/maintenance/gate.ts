import {Clock, Crypto, DateTime, Effect, FileSystem, Option, Path, Predicate, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {
  codeGraphDatabaseWriteLockPath,
  codeGraphMaintenanceIntentPath,
  codeGraphMaintenanceLockPath,
  codeGraphMaintenanceStatusPath,
  codeGraphRepositoryLockPath,
  codeGraphWorktreeLockPath,
  codeGraphWorktreeLockRoot,
} from '../layout.js';
import {classifyCodeGraphStoreFailure} from '../store/failure.js';
import {CodeGraphStoreBusyError, CodeGraphMaintenanceActiveError} from '../types.js';

export {CodeGraphMaintenanceActiveError};

interface MaintenanceIntentOwner {
  readonly processId: number;
  readonly processStartIdentity: string;
  readonly startedAt?: string;
  readonly token: string;
}

class CodeGraphMaintenanceGateError extends Schema.TaggedError<CodeGraphMaintenanceGateError>()(
  'CodeGraphMaintenanceGateError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const CODE_GRAPH_MAINTENANCE_PROGRESS_PHASES = [
  'acquiring-gates',
  'waiting-builders',
  'verifying-vectors',
  'verifying-graph',
  'retiring-and-cleaning',
] as const;

export type CodeGraphMaintenanceProgressPhase = (typeof CODE_GRAPH_MAINTENANCE_PROGRESS_PHASES)[number];

export interface CodeGraphMaintenanceProgress {
  readonly completed: number;
  readonly phase: CodeGraphMaintenanceProgressPhase;
  readonly total: number;
}

export interface CodeGraphMaintenanceStatus {
  readonly checkoutId?: string;
  readonly completed?: number;
  readonly operation: 'graph-maintenance' | 'selected-snapshot-purge';
  readonly phase: CodeGraphMaintenanceProgressPhase | 'status-unavailable' | 'working';
  readonly snapshotId?: string;
  readonly startedAt?: string;
  readonly total?: number;
  readonly updatedAt?: string;
}

export interface CodeGraphMaintenanceProgressReporter {
  readonly progress: (progress: CodeGraphMaintenanceProgress) => Effect.Effect<void>;
}

export type CodeGraphReportedMaintenanceTarget =
  | {
      readonly checkoutId: string;
      readonly operation: 'selected-snapshot-purge';
      readonly snapshotId: string;
    }
  | {
      readonly checkoutId?: string;
      readonly operation: 'graph-maintenance';
    };

interface StoredCodeGraphMaintenanceStatus extends CodeGraphMaintenanceStatus {
  readonly ownerDigest: string;
  readonly schemaVersion: 1;
}

const CODE_GRAPH_MAINTENANCE_STATUS_BYTES = 4_096;

export const withCodeGraphMaintenanceRegistration = Effect.fn('codeGraph.withMaintenanceRegistration')(function* <
  A,
  E,
  R,
>(threadnoteHome: string, effect: Effect.Effect<A, E, R>, waitTimeoutMilliseconds?: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withExclusiveFileLock(
    fs,
    codeGraphMaintenanceLockPath(path, threadnoteHome),
    {
      ...CODE_GRAPH_GATE_LOCK_OPTIONS,
      ...(waitTimeoutMilliseconds === undefined ? {} : {waitTimeoutMilliseconds}),
    },
    effect,
  );
});

export const withCodeGraphMaintenanceIntent = Effect.fn('codeGraph.withMaintenanceIntent')(function* <A, E, R>(
  threadnoteHome: string,
  effect: Effect.Effect<A, E, R>,
) {
  return yield* withCodeGraphMaintenanceIntentOwner(threadnoteHome, () => effect);
});

export const withCodeGraphReportedMaintenanceIntent = Effect.fn('codeGraph.withReportedMaintenanceIntent')(function* <
  A,
  E,
  R,
>(
  threadnoteHome: string,
  target: CodeGraphReportedMaintenanceTarget,
  initialProgress: CodeGraphMaintenanceProgress,
  use: (reporter: CodeGraphMaintenanceProgressReporter) => Effect.Effect<A, E, R>,
) {
  yield* validateReportedMaintenance(target, initialProgress);
  return yield* withCodeGraphMaintenanceIntentOwner(threadnoteHome, (owner, ownerToken) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const statusPath = codeGraphMaintenanceStatusPath(path, threadnoteHome);
      const intentPath = codeGraphMaintenanceIntentPath(path, threadnoteHome);
      let sequence = 0;
      const reporter: CodeGraphMaintenanceProgressReporter = {
        progress: progress =>
          validateReportedMaintenance(target, progress).pipe(
            Effect.andThen(
              writeMaintenanceStatus(fs, path, intentPath, statusPath, owner, ownerToken, target, progress, sequence++),
            ),
            Effect.ignore,
          ),
      };
      yield* reporter.progress(initialProgress);
      return yield* use(reporter).pipe(
        Effect.ensuring(removeOwnedMaintenanceStatus(fs, statusPath, sha256HexSync(ownerToken))),
      );
    }),
  );
});

const withCodeGraphMaintenanceIntentOwner = Effect.fn('codeGraph.withMaintenanceIntentOwner')(function* <A, E, R>(
  threadnoteHome: string,
  use: (owner: MaintenanceIntentOwner, ownerToken: string) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  const intent = codeGraphMaintenanceIntentPath(path, threadnoteHome);
  const processStartIdentity = yield* system.processStartIdentity(system.processId);
  if (!processStartIdentity) {
    return yield* CodeGraphMaintenanceGateError.make({message: 'Could not identify the maintenance process instance.'});
  }
  const owner = {
    processId: system.processId,
    processStartIdentity,
    startedAt: DateTime.formatIso(yield* DateTime.now),
    token: yield* crypto.randomUUIDv4(),
  } satisfies MaintenanceIntentOwner;
  const token = JSON.stringify(owner);
  yield* fs.makeDirectory(path.dirname(intent), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(intent, `${token}\n`, {flag: 'w', mode: 0o600});
  return yield* use(owner, token).pipe(Effect.ensuring(removeOwnedIntent(fs, intent, token)));
});

export const codeGraphMaintenanceIntentActive = Effect.fn('codeGraph.maintenanceIntentActive')(function* (
  threadnoteHome: string,
) {
  return (yield* observeMaintenanceIntentOwner(threadnoteHome)) !== undefined;
});

export const observeCodeGraphMaintenanceStatus = Effect.fn('codeGraph.observeMaintenanceStatus')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const observedOwner = yield* observeMaintenanceIntentOwner(threadnoteHome);
  const statusPath = codeGraphMaintenanceStatusPath(path, threadnoteHome);
  if (observedOwner === undefined) {
    yield* fs.remove(statusPath, {force: true}).pipe(Effect.ignore);
    return undefined;
  }
  const generic = genericMaintenanceStatus(observedOwner.owner);
  if (!(yield* fs.exists(statusPath))) return generic;
  if (Option.isSome(yield* fs.readLink(statusPath).pipe(Effect.option))) return generic;
  const info = yield* fs.stat(statusPath).pipe(Effect.option);
  if (
    Option.isNone(info) ||
    info.value.type !== 'File' ||
    Number(info.value.size) > CODE_GRAPH_MAINTENANCE_STATUS_BYTES
  ) {
    return {...generic, phase: 'status-unavailable'} as const;
  }
  const content = yield* fs.readFileString(statusPath).pipe(Effect.option);
  if (
    Option.isNone(content) ||
    new TextEncoder().encode(content.value).byteLength > CODE_GRAPH_MAINTENANCE_STATUS_BYTES
  ) {
    return {...generic, phase: 'status-unavailable'} as const;
  }
  const parsed = parseMaintenanceStatus(content.value.trim(), sha256HexSync(observedOwner.token));
  return parsed ?? ({...generic, phase: 'status-unavailable'} as const);
});

/**
 * Waits until every linked-worktree builder for a checkout has released its
 * collision-safe build lock. Call this only after publishing the maintenance
 * intent so no new builder can enter the shared SQLite store.
 */
export const awaitCodeGraphWorktreeBuilds = Effect.fn('codeGraph.awaitWorktreeBuilds')(function* (
  threadnoteHome: string,
  checkoutId: string,
  waitTimeoutMilliseconds: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = codeGraphWorktreeLockRoot(path, threadnoteHome, checkoutId);
  const startedAt = yield* Clock.currentTimeMillis;
  for (;;) {
    const locks = yield* codeGraphWorktreeLockFiles(fs, path, root);
    if (locks.length === 0) return;
    for (const lock of locks) {
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
      yield* withExclusiveFileLock(
        fs,
        lock,
        {
          retryIntervalMilliseconds: 100,
          staleAfterMilliseconds: 120_000,
          waitTimeoutMilliseconds: Math.max(0, waitTimeoutMilliseconds - elapsed),
        },
        Effect.void,
      );
    }
  }
});

export const codeGraphWorktreeBuildActive = Effect.fn('codeGraph.worktreeBuildActive')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* codeGraphWorktreeLockFiles(
    fs,
    path,
    codeGraphWorktreeLockRoot(path, threadnoteHome, checkoutId),
  );
  for (const lock of locks) {
    const active = yield* codeGraphFileLockActive(fs, lock);
    if (active) return true;
  }
  return false;
});

/**
 * Checks the checkout-wide lock through the lock protocol rather than treating
 * a leftover path as a live owner. This recovers an orphaned lock immediately
 * when its recorded process is gone and keeps doctor/storage diagnostics from
 * deferring forever after a killed build.
 */
export const codeGraphRepositoryLockActive = Effect.fn('codeGraph.repositoryLockActive')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* codeGraphFileLockActive(fs, codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId));
});

/**
 * Serializes the short publication/maintenance phase that mutates a checkout's
 * shared SQLite snapshot catalog. Linked worktrees retain independent build
 * locks, so inventory and extraction still proceed concurrently.
 */
export const withCodeGraphDatabaseWriteLock = Effect.fn('codeGraph.withDatabaseWriteLock')(function* <A, E, R>(
  threadnoteHome: string,
  checkoutId: string,
  effect: Effect.Effect<A, E, R>,
  waitTimeoutMilliseconds = CODE_GRAPH_GATE_LOCK_OPTIONS.waitTimeoutMilliseconds,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withExclusiveFileLock(
    fs,
    codeGraphDatabaseWriteLockPath(path, threadnoteHome, checkoutId),
    {...CODE_GRAPH_GATE_LOCK_OPTIONS, waitTimeoutMilliseconds},
    effect,
  );
});

/**
 * Opportunistic view mutations must not wait behind a foreground builder. The
 * caller keeps this target-worktree gate across the graph-pointer CAS and any
 * compare-keyed vector cleanup so an in-flight build cannot immediately
 * republish the removed view between those stores.
 */
export const withCodeGraphTargetWorktreeLock = Effect.fn('codeGraph.withTargetWorktreeLock')(function* <A, E, R>(
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  effect: Effect.Effect<A, E, R>,
  scopeId?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withExclusiveFileLock(
    fs,
    codeGraphWorktreeLockPath(path, threadnoteHome, checkoutId, worktreeId, scopeId),
    {...CODE_GRAPH_GATE_LOCK_OPTIONS, retryIntervalMilliseconds: 1, waitTimeoutMilliseconds: 0},
    effect,
  ).pipe(
    Effect.catchIf(
      isFileLockTimeout,
      () => Effect.fail(CodeGraphStoreBusyError.of('Code graph worktree is busy.', {operation: 'mutate graph view'})),
      cause => Effect.fail(classifyCodeGraphStoreFailure('mutate graph view', cause)),
    ),
  );
});

function codeGraphWorktreeLockFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<readonly string[], unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(root))) return [];
    if (Option.isSome(yield* fs.readLink(root).pipe(Effect.option))) {
      return yield* CodeGraphMaintenanceGateError.make({message: 'Code graph worktree lock root is a symbolic link.'});
    }
    if ((yield* fs.stat(root)).type !== 'Directory') {
      return yield* CodeGraphMaintenanceGateError.make({message: 'Code graph worktree lock root is not a directory.'});
    }
    return (yield* fs.readDirectory(root))
      .filter(name => /^[0-9a-f]{64}(?:\.scope-[0-9a-f]{64})?\.lock$/u.test(name))
      .sort()
      .map(name => path.join(root, name));
  });
}

function codeGraphFileLockActive(
  fs: FileSystem.FileSystem,
  lock: string,
): Effect.Effect<boolean, unknown, Crypto.Crypto | Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(lock))) return false;
    return yield* withExclusiveFileLock(
      fs,
      lock,
      {...CODE_GRAPH_GATE_LOCK_OPTIONS, waitTimeoutMilliseconds: 0},
      Effect.succeed(false),
    ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed(true)));
  });
}

const observeMaintenanceIntentOwner = Effect.fn('codeGraph.observeMaintenanceIntentOwner')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const intent = codeGraphMaintenanceIntentPath(path, threadnoteHome);
  if (!(yield* fs.exists(intent))) return undefined;
  const token = (yield* fs.readFileString(intent)).trim();
  const owner = parseMaintenanceIntentOwner(token);
  if (
    owner &&
    system.isProcessRunning(owner.processId) &&
    (yield* system.processStartIdentity(owner.processId)) === owner.processStartIdentity
  ) {
    return {owner, token};
  }
  yield* removeOwnedIntent(fs, intent, token);
  return undefined;
});

const validateReportedMaintenance = Effect.fn('codeGraph.validateReportedMaintenance')(function* (
  target: CodeGraphReportedMaintenanceTarget,
  progress: CodeGraphMaintenanceProgress,
) {
  if (!reportedMaintenanceTargetValid(target) || !reportedMaintenanceProgressValid(progress)) {
    return yield* CodeGraphMaintenanceGateError.make({message: 'Code graph maintenance progress is invalid.'});
  }
});

const writeMaintenanceStatus = Effect.fn('codeGraph.writeMaintenanceStatus')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  intentPath: string,
  statusPath: string,
  owner: MaintenanceIntentOwner,
  ownerToken: string,
  target: CodeGraphReportedMaintenanceTarget,
  progress: CodeGraphMaintenanceProgress,
  sequence: number,
) {
  const ownerDigest = sha256HexSync(ownerToken);
  const now = DateTime.formatIso(yield* DateTime.now);
  const status = {
    ...(target.checkoutId === undefined ? {} : {checkoutId: target.checkoutId}),
    completed: progress.completed,
    operation: target.operation,
    ownerDigest,
    phase: progress.phase,
    schemaVersion: 1,
    ...(target.operation === 'selected-snapshot-purge' ? {snapshotId: target.snapshotId} : {}),
    startedAt: owner.startedAt ?? now,
    total: progress.total,
    updatedAt: now,
  } satisfies StoredCodeGraphMaintenanceStatus;
  const content = `${JSON.stringify(status)}\n`;
  if (new TextEncoder().encode(content).byteLength > CODE_GRAPH_MAINTENANCE_STATUS_BYTES) {
    return yield* CodeGraphMaintenanceGateError.make({
      message: 'Code graph maintenance progress exceeded its bounded size.',
    });
  }
  if (Option.isSome(yield* fs.readLink(statusPath).pipe(Effect.option))) {
    return yield* CodeGraphMaintenanceGateError.make({message: 'Code graph maintenance status is a symbolic link.'});
  }
  const temporary = path.join(
    path.dirname(statusPath),
    `.maintenance-status-${ownerDigest.slice(0, 16)}-${sequence}.tmp`,
  );
  yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
  yield* Effect.gen(function* () {
    if ((yield* fs.readFileString(intentPath)).trim() !== ownerToken) {
      return yield* CodeGraphMaintenanceGateError.make({
        message: 'Code graph maintenance owner changed before progress publication.',
      });
    }
    if (Option.isSome(yield* fs.readLink(statusPath).pipe(Effect.option))) {
      return yield* CodeGraphMaintenanceGateError.make({
        message: 'Code graph maintenance status changed before publication.',
      });
    }
    yield* fs.rename(temporary, statusPath);
  }).pipe(Effect.onError(() => fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

function genericMaintenanceStatus(owner: MaintenanceIntentOwner): CodeGraphMaintenanceStatus {
  return {
    operation: 'graph-maintenance',
    phase: 'working',
    ...(owner.startedAt === undefined ? {} : {startedAt: owner.startedAt}),
  };
}

function parseMaintenanceStatus(value: string, expectedOwnerDigest: string): CodeGraphMaintenanceStatus | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Predicate.isObject(parsed)) return undefined;
    const checkoutId = parsed.checkoutId;
    const completed = parsed.completed;
    const ownerDigest = parsed.ownerDigest;
    const operation = parsed.operation;
    const phase = parsed.phase;
    const schemaVersion = parsed.schemaVersion;
    const snapshotId = parsed.snapshotId;
    const startedAt = parsed.startedAt;
    const total = parsed.total;
    const updatedAt = parsed.updatedAt;
    if (
      schemaVersion !== 1 ||
      ownerDigest !== expectedOwnerDigest ||
      !isCodeGraphMaintenanceProgressPhase(phase) ||
      !isSafeInteger(completed) ||
      !isSafeInteger(total) ||
      completed < 0 ||
      total <= 0 ||
      completed > total ||
      !validMaintenanceTimestamp(startedAt) ||
      !validMaintenanceTimestamp(updatedAt)
    ) {
      return undefined;
    }
    if (operation === 'selected-snapshot-purge') {
      if (
        typeof checkoutId !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(checkoutId) ||
        typeof snapshotId !== 'string' ||
        !/^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u.test(snapshotId)
      ) {
        return undefined;
      }
      return {
        checkoutId,
        completed,
        operation,
        phase,
        snapshotId,
        startedAt,
        total,
        updatedAt,
      };
    }
    if (operation !== 'graph-maintenance' || snapshotId !== undefined) return undefined;
    if (checkoutId !== undefined && (typeof checkoutId !== 'string' || !/^[0-9a-f]{64}$/u.test(checkoutId))) {
      return undefined;
    }
    return {
      ...(typeof checkoutId === 'string' ? {checkoutId} : {}),
      completed,
      operation,
      phase,
      startedAt,
      total,
      updatedAt,
    };
  } catch {
    return undefined;
  }
}

function validMaintenanceTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseMaintenanceIntentOwner(value: string): MaintenanceIntentOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Predicate.isObject(parsed)) return undefined;
    const processId = parsed.processId;
    const processStartIdentity = parsed.processStartIdentity;
    const startedAt = parsed.startedAt;
    const token = parsed.token;
    if (
      !isSafeInteger(processId) ||
      processId <= 0 ||
      typeof processStartIdentity !== 'string' ||
      processStartIdentity.length === 0 ||
      processStartIdentity.length > 1_024 ||
      (startedAt !== undefined && !validMaintenanceTimestamp(startedAt)) ||
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > 256
    ) {
      return undefined;
    }
    return {processId, processStartIdentity, ...(startedAt === undefined ? {} : {startedAt}), token};
  } catch {
    return undefined;
  }
}

function removeOwnedIntent(fs: FileSystem.FileSystem, intent: string, token: string): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(intent))) return;
    if ((yield* fs.readFileString(intent)).trim() === token) {
      yield* fs.remove(intent, {force: true});
    }
  }).pipe(Effect.ignore);
}

function removeOwnedMaintenanceStatus(
  fs: FileSystem.FileSystem,
  statusPath: string,
  ownerDigest: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(statusPath))) return;
    if (Option.isSome(yield* fs.readLink(statusPath).pipe(Effect.option))) return;
    const info = yield* fs.stat(statusPath);
    if (info.type !== 'File' || Number(info.size) > CODE_GRAPH_MAINTENANCE_STATUS_BYTES) return;
    const content = yield* fs.readFileString(statusPath);
    const parsed: unknown = JSON.parse(content);
    if (Predicate.isObject(parsed) && parsed.ownerDigest === ownerDigest) yield* fs.remove(statusPath, {force: true});
  }).pipe(Effect.ignore);
}

export const CODE_GRAPH_GATE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 100,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 10 * 60_000,
} as const;

function reportedMaintenanceTargetValid(target: CodeGraphReportedMaintenanceTarget): boolean {
  if (target.operation === 'selected-snapshot-purge') {
    return (
      /^[0-9a-f]{64}$/u.test(target.checkoutId) &&
      /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u.test(target.snapshotId)
    );
  }
  return (
    target.operation === 'graph-maintenance' &&
    (target.checkoutId === undefined || /^[0-9a-f]{64}$/u.test(target.checkoutId))
  );
}

function reportedMaintenanceProgressValid(progress: CodeGraphMaintenanceProgress): boolean {
  return (
    CODE_GRAPH_MAINTENANCE_PROGRESS_PHASES.includes(progress.phase) &&
    Number.isSafeInteger(progress.completed) &&
    Number.isSafeInteger(progress.total) &&
    progress.completed >= 0 &&
    progress.total > 0 &&
    progress.completed <= progress.total
  );
}

function isCodeGraphMaintenanceProgressPhase(value: unknown): value is CodeGraphMaintenanceProgressPhase {
  return (
    value === 'acquiring-gates' ||
    value === 'waiting-builders' ||
    value === 'verifying-vectors' ||
    value === 'verifying-graph' ||
    value === 'retiring-and-cleaning'
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
