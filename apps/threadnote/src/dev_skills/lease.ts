import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withSetupMutationLock} from '../setup/lock.js';
import {assertSafePath, fail} from './files.js';
import {enrollmentContext, physicalDirectory} from './registry.js';

const identity: unique symbol = Symbol('DevSkillsMutationLease');
export interface DevSkillsMutationLease {
  readonly [identity]: true;
}
const live = new WeakMap<DevSkillsMutationLease, {home: string; root: string}>();
const options = {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 60_000, waitTimeoutMilliseconds: 30_000};
export function withDevSkillsMutationLease<A, E, R>(
  config: RuntimeConfig,
  body: (lease: DevSkillsMutationLease) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = yield* enrollmentContext(config);
    const lock = path.join(context.root, '.dev-skills-enrollment.lock');
    yield* assertSafePath(lock);
    yield* assertSafePath(`${context.home}.setup-mutation.lock`);
    return yield* withExclusiveFileLock(
      fs,
      lock,
      options,
      withSetupMutationLock(
        context.home,
        Effect.gen(function* () {
          const current = yield* enrollmentContext(config);
          if (current.root !== context.root)
            return yield* fail(
              'enrollment-conflict',
              'Runtime enrollment changed while acquiring its coordinator. Retry.',
            );
          const lease: DevSkillsMutationLease = {[identity]: true};
          live.set(lease, {home: context.home, root: context.root});
          return yield* Effect.suspend(() => body(lease)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                live.delete(lease);
              }),
            ),
          );
        }),
      ),
    );
  });
}
export const validateLease = Effect.fn('devSkills.validateLease')(function* (
  config: RuntimeConfig,
  lease: DevSkillsMutationLease,
) {
  const held = live.get(lease);
  const path = yield* Path.Path;
  if (!held || held.home !== path.resolve(config.agentContextHome))
    return yield* fail('invalid-lease', 'A current internal development skills mutation lease is required.');
  return held;
});
export function withPhysicalLock<A, E, R>(root: string, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = path.join(physicalDirectory(path, root), '.mutation.lock');
    yield* assertSafePath(lock);
    return yield* withExclusiveFileLock(fs, lock, options, body);
  });
}
