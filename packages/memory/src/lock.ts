import {Crypto, Effect, FileSystem, Path} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {Array as EffectArray} from 'effect';

const MEMORY_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const MEMORY_LOCK_RETRY_MILLISECONDS = 25;
const MEMORY_LOCK_WAIT_TIMEOUT_MILLISECONDS = 30_000;
const MEMORY_LOCK_OPTIONS = {
  retryIntervalMilliseconds: MEMORY_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: MEMORY_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: MEMORY_LOCK_WAIT_TIMEOUT_MILLISECONDS,
} as const;

/**
 * Serializes writes by their storage URI. Sorting the lock paths keeps
 * cross-URI replacements deadlock-free when two writers touch the same pair.
 */
export function withMemoryUriLocks<A, E, R>(
  fs: FileSystem.FileSystem,
  agentContextHome: string,
  uris: readonly (string | undefined)[],
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const uniqueUris = [...new Set(EffectArray.filter(uris, (uri): uri is string => uri !== undefined))];
    const lockPaths = yield* Effect.forEach(uniqueUris, uri =>
      sha256Hex(uri).pipe(
        Effect.map(digest => pathService.join(agentContextHome, 'threadnote', 'memory-locks', `${digest}.lock`)),
      ),
    );
    const sortedLockPaths = lockPaths.sort();
    const protect = (index: number): Effect.Effect<A, unknown, R | Crypto.Crypto | Path.Path | SystemInfo> =>
      index >= sortedLockPaths.length
        ? effect
        : withExclusiveFileLock(fs, sortedLockPaths[index], MEMORY_LOCK_OPTIONS, protect(index + 1));
    return yield* protect(0);
  });
}
