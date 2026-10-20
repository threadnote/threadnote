import {Clock, Crypto, DateTime, Effect, FileSystem, Option, Path, PlatformError, Predicate, Schema} from 'effect';
import {succeedUndefined} from '../optional.js';
import {sha256Hex} from '../digest.js';
import {fromPromise} from '../errors.js';
import {
  runtimeReadBoundedStableRegularFile,
  runtimeTouchBoundedStableRegularFile,
  SystemInfo,
  type SystemInfoShape,
} from '../system.js';

export interface ExclusiveFileLockOptions {
  /** Existing-home workers must never recreate a directory removed by uninstall. Defaults to true. */
  readonly createParentDirectory?: boolean;
  readonly heartbeatIntervalMilliseconds?: number;
  readonly onAcquired?: (lockPath: string) => Effect.Effect<void, never>;
  readonly onCompleted?: (lockPath: string) => Effect.Effect<void, never>;
  readonly onContention?: (lockPath: string) => Effect.Effect<void, never>;
  readonly retryIntervalMilliseconds: number;
  /** @internal Maximum short retries for Windows sharing-shaped exclusive-create failures. */
  readonly windowsSharingViolationRetryLimit?: number;
  /** @internal Select the versioned, cross-observer process identity channel. */
  readonly useCanonicalProcessStartIdentity?: boolean;
  /**
   * Recover a JSON lock immediately when its PID is running as a different
   * process instance. This is intentionally opt-in for reconciliation paths
   * that already proved the durable owner dead; ordinary locks retain their
   * age gate.
   */
  readonly recoverReusedProcessIdImmediately?: boolean;
  readonly staleAfterMilliseconds: number;
  readonly waitTimeoutMilliseconds: number;
}

export class FileLockTimeout extends Schema.TaggedError<FileLockTimeout>()('FileLockTimeout', {
  lockPath: Schema.String,
  message: Schema.String,
}) {
  static of(lockPath: string): FileLockTimeout {
    return FileLockTimeout.make({
      lockPath,
      message: `Timed out waiting for local lock ${lockPath}.`,
    });
  }
}

export interface FileLockOwner {
  readonly processId: number;
  readonly processStartIdentity?: string;
  readonly token: string;
  readonly version: 1;
}

/**
 * Reads the privacy-safe owner identity of an existing lock without attempting
 * recovery or changing the lock. Callers use this to report which process owns
 * a long-running operation; absence includes malformed, missing, oversized, and
 * symbolic-link lock files.
 */
export const readExclusiveFileLockOwner = Effect.fn('fileLock.readOwner')(function* (
  fs: FileSystem.FileSystem,
  lockPath: string,
) {
  return yield* Effect.gen(function* () {
    if (!(yield* fs.exists(lockPath))) return Option.none<FileLockOwner>();
    if (Option.isSome(yield* fs.readLink(lockPath).pipe(Effect.option))) return Option.none<FileLockOwner>();
    const info = yield* fs.stat(lockPath);
    if (info.type !== 'File' || Number(info.size) > 4_096) return Option.none<FileLockOwner>();
    return Option.fromUndefinedOr(fileLockOwner((yield* fs.readFileString(lockPath)).trim()));
  }).pipe(Effect.orElseSucceed(() => Option.none<FileLockOwner>()));
});

export function isFileLockTimeout(cause: unknown): cause is FileLockTimeout {
  return Schema.is(FileLockTimeout)(cause);
}

/**
 * Serializes a small file-backed critical section across local processes.
 * Lock creation is atomic, stale locks are recoverable, and cleanup only
 * removes the caller's own token.
 */
export function withExclusiveFileLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  options: ExclusiveFileLockOptions,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    if (options.createParentDirectory !== false)
      yield* fs.makeDirectory(pathService.dirname(lockPath), {recursive: true});
    const token = yield* fileLockToken(options.useCanonicalProcessStartIdentity === true);
    const startedAt = yield* Clock.currentTimeMillis;
    let contentionReported = false;
    const heartbeatIntervalMilliseconds =
      options.heartbeatIntervalMilliseconds ?? Math.max(1, Math.floor(options.staleAfterMilliseconds / 3));
    const protectedEffect = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(refreshFileLockLease(lockPath, token, heartbeatIntervalMilliseconds));
        yield* options.onAcquired?.(lockPath) ?? Effect.void;
        return yield* effect.pipe(Effect.ensuring(options.onCompleted?.(lockPath) ?? Effect.void));
      }),
    );
    for (;;) {
      const attempted = yield* tryAcquireFileLock(fs, lockPath, token, options).pipe(
        Effect.flatMap(acquired => (acquired ? protectedEffect.pipe(Effect.asSome) : Effect.succeedNone)),
        // Register release around the acquisition itself. Interruption or an
        // I/O failure after the atomic token write must not strand a lock owned
        // by this still-live process. A failed contender cannot remove another
        // owner's lock because release verifies the exact random token.
        Effect.ensuring(releaseFileLock(fs, lockPath, token)),
      );
      if (Option.isSome(attempted)) return attempted.value;
      if (!contentionReported) {
        yield* options.onContention?.(lockPath) ?? Effect.void;
        contentionReported = true;
      }
      const now = yield* Clock.currentTimeMillis;
      if (now - startedAt >= options.waitTimeoutMilliseconds) {
        return yield* FileLockTimeout.of(lockPath);
      }
      yield* Effect.sleep(options.retryIntervalMilliseconds);
    }
  });
}

function tryAcquireFileLock(
  fs: FileSystem.FileSystem,
  lockPath: string,
  token: string,
  options: ExclusiveFileLockOptions,
): Effect.Effect<boolean, unknown, Crypto.Crypto | SystemInfo> {
  return Effect.gen(function* () {
    yield* recoverStaleFileLock(fs, lockPath, options);
    if (
      !(yield* tryWriteLockToken(
        fs,
        lockPath,
        token,
        options.windowsSharingViolationRetryLimit,
        options.retryIntervalMilliseconds,
      ))
    ) {
      return false;
    }
    if (yield* fs.exists(recoveryGuardPath(lockPath))) {
      yield* releaseFileLock(fs, lockPath, token);
      return false;
    }
    return true;
  });
}

function recoverStaleFileLock(
  fs: FileSystem.FileSystem,
  lockPath: string,
  options: ExclusiveFileLockOptions,
): Effect.Effect<void, unknown, Crypto.Crypto | SystemInfo> {
  return Effect.gen(function* () {
    const guardPath = recoveryGuardPath(lockPath);
    const lockNeedsRecovery = yield* staleDeadLockToken(fs, lockPath, options);
    if (lockNeedsRecovery === undefined && !(yield* fs.exists(guardPath))) {
      return;
    }
    const guardToken = yield* acquireRecoveryGuard(fs, lockPath, guardPath, options);
    if (guardToken === undefined) {
      return;
    }
    yield* Effect.gen(function* () {
      const observedToken = yield* staleDeadLockToken(fs, lockPath, options);
      if (observedToken !== undefined) {
        yield* releaseFileLock(fs, lockPath, observedToken);
      }
    }).pipe(Effect.ensuring(releaseFileLock(fs, guardPath, guardToken)));
  }).pipe(Effect.ignore);
}

function acquireRecoveryGuard(
  fs: FileSystem.FileSystem,
  lockPath: string,
  guardPath: string,
  options: Pick<ExclusiveFileLockOptions, 'staleAfterMilliseconds' | 'useCanonicalProcessStartIdentity'>,
): Effect.Effect<string | undefined, unknown, Crypto.Crypto | SystemInfo> {
  return Effect.gen(function* () {
    const token = yield* fileLockToken(options.useCanonicalProcessStartIdentity === true);
    if (yield* tryWriteLockToken(fs, guardPath, token)) {
      return token;
    }
    const staleGuardToken = yield* staleDeadLockToken(fs, guardPath, options);
    if (staleGuardToken === undefined) {
      return undefined;
    }
    const nestedDigest = yield* sha256Hex(`${guardPath}\n${staleGuardToken}`);
    const nestedGuardPath = `${lockPath}.recovery-${nestedDigest}`;
    const nestedToken = yield* acquireRecoveryGuard(fs, lockPath, nestedGuardPath, options);
    if (nestedToken === undefined) {
      return undefined;
    }
    yield* Effect.gen(function* () {
      const currentStaleToken = yield* staleDeadLockToken(fs, guardPath, options);
      if (currentStaleToken === staleGuardToken) {
        yield* releaseFileLock(fs, guardPath, staleGuardToken);
      }
    }).pipe(Effect.ensuring(releaseFileLock(fs, nestedGuardPath, nestedToken)));
    return (yield* tryWriteLockToken(fs, guardPath, token)) ? token : undefined;
  });
}

function staleDeadLockToken(
  fs: FileSystem.FileSystem,
  path: string,
  options: Pick<
    ExclusiveFileLockOptions,
    'recoverReusedProcessIdImmediately' | 'staleAfterMilliseconds' | 'useCanonicalProcessStartIdentity'
  >,
): Effect.Effect<string | undefined, unknown, SystemInfo> {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const token = yield* readStableFileLockToken(path);
    if (token === undefined) return undefined;
    const info = yield* fs.stat(path);
    if ((yield* readStableFileLockToken(path)) !== token) return undefined;
    const owner = fileLockOwner(token);
    if (owner && !system.isProcessRunning(owner.processId)) {
      return token;
    }
    if (owner?.processStartIdentity && options.recoverReusedProcessIdImmediately) {
      const currentStartIdentity = yield* selectedProcessStartIdentity(
        system,
        owner.processId,
        options.useCanonicalProcessStartIdentity === true,
      );
      if (currentStartIdentity !== undefined && currentStartIdentity !== owner.processStartIdentity) {
        return token;
      }
    }
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    const now = yield* Clock.currentTimeMillis;
    if (modifiedAt === undefined || now - modifiedAt <= options.staleAfterMilliseconds) {
      return undefined;
    }
    if (owner?.processStartIdentity) {
      const currentStartIdentity = yield* selectedProcessStartIdentity(
        system,
        owner.processId,
        options.useCanonicalProcessStartIdentity === true,
      );
      if (currentStartIdentity !== undefined && currentStartIdentity !== owner.processStartIdentity) {
        return token;
      }
    }
    return owner === undefined ? token : undefined;
  });
}

function tryWriteLockToken(
  fs: FileSystem.FileSystem,
  path: string,
  token: string,
  windowsSharingViolationRetryLimit = 0,
  retryIntervalMilliseconds = 0,
): Effect.Effect<boolean, unknown, SystemInfo> {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const retryLimit =
      Number.isSafeInteger(windowsSharingViolationRetryLimit) && windowsSharingViolationRetryLimit > 0
        ? windowsSharingViolationRetryLimit
        : 0;
    for (let retry = 0; ; retry += 1) {
      const attempted = yield* fs.writeFileString(path, `${token}\n`, {flag: 'wx', mode: 0o600}).pipe(
        Effect.as({status: 'acquired'} as const),
        Effect.catch(error => Effect.succeed({error, status: 'failed'} as const)),
      );
      if (attempted.status === 'acquired') return true;
      if (attempted.error instanceof PlatformError.PlatformError && attempted.error.reason._tag === 'AlreadyExists') {
        return false;
      }
      if (retry >= retryLimit || !isWindowsSharingViolation(attempted.error, system.platform)) {
        return yield* attempted.error;
      }
      yield* Effect.sleep(retryIntervalMilliseconds);
    }
  });
}

function isWindowsSharingViolation(error: unknown, platform: NodeJS.Platform): boolean {
  if (!(error instanceof PlatformError.PlatformError)) return false;
  if (platform !== 'win32') return false;

  // Windows can report an exclusive create against a live lock as a sharing/access failure instead of EEXIST.
  // Treat only the normalized contention-shaped failures as a missed acquisition so the bounded lock loop retries;
  // unrelated errors such as a full disk still fail immediately.
  if (error.reason._tag === 'Busy' || error.reason._tag === 'PermissionDenied' || error.reason._tag === 'WouldBlock') {
    return true;
  }
  if (error.reason._tag !== 'Unknown') return false;
  const cause = error.reason.cause;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? (cause as {readonly code?: unknown}).code
      : undefined;
  return code === 'EACCES' || code === 'EAGAIN' || code === 'EBUSY' || code === 'EPERM';
}

function recoveryGuardPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

function refreshFileLockLease(
  lockPath: string,
  token: string,
  intervalMilliseconds: number,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(intervalMilliseconds);
      const now = yield* DateTime.nowAsDate;
      const refreshed = yield* fromPromise('fileLock.refreshStableLease', () =>
        runtimeTouchBoundedStableRegularFile(lockPath, 4_096, new TextEncoder().encode(`${token}\n`), now),
      ).pipe(Effect.orElseSucceed(() => false));
      if (!refreshed) return;
    }
  }).pipe(Effect.ignore);
}

const fileLockToken = Effect.fn('fileLock.token')(function* (useCanonicalProcessStartIdentity: boolean) {
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  const processStartIdentity = yield* selectedProcessStartIdentity(
    system,
    system.processId,
    useCanonicalProcessStartIdentity,
  );
  return JSON.stringify({
    processId: system.processId,
    ...(processStartIdentity ? {processStartIdentity} : {}),
    token: yield* crypto.randomUUIDv4(),
    version: 1,
  } satisfies FileLockOwner);
});

function selectedProcessStartIdentity(system: SystemInfoShape, processId: number, canonical: boolean) {
  if (!canonical) return system.processStartIdentity(processId);
  return system.canonicalProcessStartIdentity?.(processId) ?? succeedUndefined;
}

function fileLockOwner(token: string): FileLockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(token);
    if (!Predicate.isObject(parsed)) return undefined;
    if (
      parsed.version === 1 &&
      typeof parsed.processId === 'number' &&
      Number.isSafeInteger(parsed.processId) &&
      parsed.processId > 0 &&
      (parsed.processStartIdentity === undefined ||
        (typeof parsed.processStartIdentity === 'string' && parsed.processStartIdentity.length > 0)) &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return {
        ...(parsed.processStartIdentity === undefined ? {} : {processStartIdentity: parsed.processStartIdentity}),
        processId: parsed.processId,
        token: parsed.token,
        version: 1,
      };
    }
  } catch {
    // Threadnote 4 beta lock tokens used the legacy "<pid>:<nonce>" format.
  }
  const legacyProcessId = Number.parseInt(token.split(':', 1)[0] ?? '', 10);
  return Number.isSafeInteger(legacyProcessId) && legacyProcessId > 0
    ? {processId: legacyProcessId, token, version: 1}
    : undefined;
}

function releaseFileLock(fs: FileSystem.FileSystem, lockPath: string, token: string): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if ((yield* readStableFileLockToken(lockPath)) === token) {
      yield* fs.remove(lockPath, {force: true});
    }
  }).pipe(Effect.ignore);
}

function readStableFileLockToken(path: string, remainingAttempts = 2): Effect.Effect<string | undefined, never> {
  return fromPromise('fileLock.readStableToken', () => runtimeReadBoundedStableRegularFile(path, 4_096)).pipe(
    Effect.map(bytes => new TextDecoder().decode(bytes).trim()),
    Effect.catch(() =>
      remainingAttempts <= 0
        ? succeedUndefined
        : Effect.yieldNow.pipe(Effect.andThen(readStableFileLockToken(path, remainingAttempts - 1))),
    ),
  );
}
