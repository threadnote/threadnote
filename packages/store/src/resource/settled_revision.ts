import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {resourceAccountMutationLockPath, resourceAccountMutationLockPolicy} from './lock.js';
import {readCanonicalMutationGeneration} from './mutation_generation.js';

/**
 * Read a canonical generation only after earlier account mutations have left
 * their critical section. Lock acquisition uses the ordinary writer policy,
 * including its timeout and stale-owner recovery. The lock is released before
 * this Effect returns, and callers perform all scans or fan-out afterward.
 */
export const readSettledCanonicalMutationGeneration = Effect.fn('resourceMutationGeneration.readSettled')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  account: string,
) {
  const lockPath = resourceAccountMutationLockPath(path, home, account);
  return yield* withExclusiveFileLock(
    fs,
    lockPath,
    resourceAccountMutationLockPolicy,
    readCanonicalMutationGeneration(fs, path, home, account),
  );
});
