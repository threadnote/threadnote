import type {Path} from 'effect';
import type {ExclusiveFileLockOptions} from '@threadnote/platform/file/lock';
import {validatePortableSegment} from '@threadnote/store/resource-id';

/** The ordinary account mutation coordinator policy, shared by writers and settled readers. */
export const resourceAccountMutationLockPolicy = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const satisfies ExclusiveFileLockOptions;

export function resourceAccountMutationLockPath(path: Path.Path, home: string, account: string): string {
  validatePortableSegment(account, account);
  return path.join(home, 'locks', 'resources', account, 'mutations.lock');
}

export function resourceAccountMutationGenerationPath(path: Path.Path, home: string, account: string): string {
  validatePortableSegment(account, account);
  return path.join(home, 'locks', 'resources', account, 'canonical-generation-v1');
}
