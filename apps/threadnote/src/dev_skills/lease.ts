import {Effect, FileSystem, Option, Path} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withSetupMutationLock} from '../setup/lock.js';
import {assertSafePath, fail, readOptional} from './files.js';
import {enablementJournalPath, recoverEnablement} from './enablement.js';
import {enrollmentContext, hasDevSkillsHomeState, physicalDirectory} from './registry.js';

const identity: unique symbol = Symbol('DevSkillsMutationLease');
const coordinatorIdentity: unique symbol = Symbol('DevSkillsRuntimeCoordinator');
export interface DevSkillsMutationLease {
  readonly [identity]: true;
}
export interface DevSkillsRuntimeCoordinator {
  readonly [coordinatorIdentity]: true;
}
const coordinators = new WeakMap<DevSkillsRuntimeCoordinator, string>();
const live = new WeakMap<
  DevSkillsMutationLease,
  {home: string; root: string; coordinator: DevSkillsRuntimeCoordinator}
>();
const options = {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 60_000, waitTimeoutMilliseconds: 30_000};
export function withRuntimeCoordinator<A, E, R>(
  root: string,
  body: (coordinator: DevSkillsRuntimeCoordinator) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = path.join(root, '.dev-skills-enrollment.lock');
    yield* assertSafePath(lock);
    return yield* withExclusiveFileLock(
      fs,
      lock,
      options,
      Effect.gen(function* () {
        const coordinator: DevSkillsRuntimeCoordinator = {[coordinatorIdentity]: true};
        coordinators.set(coordinator, root);
        return yield* Effect.suspend(() => body(coordinator)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              coordinators.delete(coordinator);
            }),
          ),
        );
      }),
    );
  });
}
export function withHomeLease<A, E, R>(
  config: RuntimeConfig,
  coordinator: DevSkillsRuntimeCoordinator,
  body: (lease: DevSkillsMutationLease) => Effect.Effect<A, E, R>,
  policy: {readonly replayEnablement?: boolean} = {},
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = coordinators.get(coordinator);
    if (!root) return yield* fail('invalid-lease', 'A live runtime enrollment coordinator is required.');
    const home = path.resolve(config.agentContextHome);
    yield* assertSafePath(`${home}.setup-mutation.lock`);
    return yield* withSetupMutationLock(
      home,
      Effect.gen(function* () {
        const context = yield* enrollmentContext(config);
        if (context.root !== root)
          return yield* fail('enrollment-conflict', 'The home belongs to another runtime enrollment coordinator.');
        if (policy.replayEnablement === false) {
          if ((yield* readOptional(enablementJournalPath(path, home))) !== null)
            return yield* fail('recovery-needed', 'A pending enablement transaction must be recovered separately.');
        } else yield* recoverEnablement(home, root);
        const lease: DevSkillsMutationLease = {[identity]: true};
        live.set(lease, {home, root, coordinator});
        return yield* Effect.suspend(() => body(lease)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              live.delete(lease);
            }),
          ),
        );
      }),
    );
  });
}
export function withDevSkillsMutationLease<A, E, R>(
  config: RuntimeConfig,
  body: (lease: DevSkillsMutationLease) => Effect.Effect<A, E, R>,
  policy: {readonly replayEnablement?: boolean} = {},
) {
  return Effect.gen(function* () {
    const context = yield* enrollmentContext(config);
    return yield* withRuntimeCoordinator(context.root, coordinator => withHomeLease(config, coordinator, body, policy));
  });
}
export function withDevSkillsRemovalLease<A, E, R>(
  config: RuntimeConfig,
  body: (lease?: DevSkillsMutationLease) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    if (!(yield* hasDevSkillsHomeState(config))) {
      const legacy = yield* withSetupMutationLock(
        config.agentContextHome,
        Effect.gen(function* () {
          if (yield* hasDevSkillsHomeState(config)) return Option.none<A>();
          return Option.some(yield* body());
        }),
      );
      if (Option.isSome(legacy)) return legacy.value;
      // State appeared while waiting. Release the home lock before acquiring
      // the normal coordinator -> home lease; never invert that order.
    }
    return yield* withDevSkillsMutationLease(config, body);
  });
}
export const validateLease = Effect.fn('devSkills.validateLease')(function* (
  config: RuntimeConfig,
  lease: DevSkillsMutationLease,
) {
  const held = live.get(lease);
  const path = yield* Path.Path;
  if (!held || held.home !== path.resolve(config.agentContextHome) || coordinators.get(held.coordinator) !== held.root)
    return yield* fail('invalid-lease', 'A current internal development skills mutation lease is required.');
  return {home: held.home, root: held.root};
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
