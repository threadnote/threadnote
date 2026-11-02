import {Effect, FileSystem, Path, Schema} from 'effect';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';

export const CONTEXT_MAINTENANCE_WORKER_ARGUMENT = '--threadnote-context-maintenance-worker';
export const CONTEXT_MAINTENANCE_WORKER_BUDGET_MS = 5 * 60_000;

const boundedString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Owner = Schema.Struct({
  processId: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 2_147_483_647})),
  startIdentity: boundedString,
});
export type ContextMaintenanceWorkerOwner = typeof Owner.Type;

const Request = Schema.Struct({
  config: Schema.Struct({
    account: boundedString,
    agentContextHome: boundedString,
    agentId: boundedString,
    manifestPath: boundedString,
    user: boundedString,
  }),
  owner: Schema.optionalKey(Owner),
});

export const decodeContextMaintenanceWorkerRequest = Effect.fn('contextMaintenance.decodeWorker')(function* (
  args: readonly string[],
) {
  if (args.length !== 1 || args[0].length > 16_384) return yield* Effect.fail('Invalid maintenance worker request.');
  const request = yield* Schema.decodeEffect(Schema.fromJsonString(Request), {onExcessProperty: 'error'})(args[0]);
  const path = yield* Path.Path;
  if (!path.isAbsolute(request.config.agentContextHome) || !path.isAbsolute(request.config.manifestPath))
    return yield* Effect.fail('Maintenance worker paths must be absolute.');
  return request;
});

/** The caller must keep application construction lazy inside `work`. */
export function runContextMaintenanceWorker<A, E, R>(
  home: string,
  owner: ContextMaintenanceWorkerOwner | undefined,
  work: Effect.Effect<A, E, R>,
) {
  return Effect.suspend(() => {
    let entered = false;
    let lockPath: string | undefined;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      lockPath = path.join(home, 'context-maintenance', 'worker-v1.lock');
      return yield* withExclusiveFileLock(
        fs,
        lockPath,
        {
          retryIntervalMilliseconds: 25,
          staleAfterMilliseconds: 60_000,
          waitTimeoutMilliseconds: 0,
          useCanonicalProcessStartIdentity: true,
        },
        Effect.gen(function* () {
          entered = true;
          if (owner && !(yield* ownerCurrent(owner))) return 'owner-gone' as const;
          // Cancellation does not release the lease until the whole scope and
          // its finalizers return. Never admit a replacement during cleanup.
          const run = Effect.scoped(work).pipe(Effect.as('completed' as const));
          return yield* (owner ? Effect.raceFirst(run, awaitOwnerExit(owner)) : run).pipe(
            Effect.timeoutOrElse({
              duration: CONTEXT_MAINTENANCE_WORKER_BUDGET_MS,
              orElse: () => Effect.succeed('deadline' as const),
            }),
          );
        }),
      );
    }).pipe(
      Effect.catchIf(
        error => !entered && isFileLockTimeout(error) && error.lockPath === lockPath,
        () => Effect.succeed('busy' as const),
      ),
    );
  });
}

const ownerCurrent = Effect.fn('contextMaintenance.ownerCurrent')(function* (owner: ContextMaintenanceWorkerOwner) {
  const system = yield* SystemInfo;
  if (!system.isProcessRunning(owner.processId) || !system.canonicalProcessStartIdentity) return false;
  return (yield* system.canonicalProcessStartIdentity(owner.processId)) === owner.startIdentity;
});

const awaitOwnerExit = Effect.fn('contextMaintenance.awaitOwnerExit')(function* (owner: ContextMaintenanceWorkerOwner) {
  while (yield* ownerCurrent(owner)) yield* Effect.sleep('1 second');
  return 'owner-gone' as const;
});
