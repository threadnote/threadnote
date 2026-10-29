import {Effect, FileSystem, Path, Schema} from 'effect';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ManagerLiveChangeHints} from '../../manager/live_sources.js';
import {ContextMaintenanceBusy, MaintenancePauseFenceBusy} from './maintenance_contracts.js';
import {ContextMaintenanceError, readRawState, readState, readJson, atomicJson} from './maintenance.js';
import {publicStatus} from './maintenance_projection.js';

const LOCK = {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 60_000, waitTimeoutMilliseconds: 50};
const fail = (message: string) => ContextMaintenanceError.make({message});
const isMaintenanceControl = Schema.is(Schema.Struct({version: Schema.Literal(1), paused: Schema.Boolean}));

export const setContextMaintenancePaused = Effect.fn('contextMaintenance.pause')(function* (
  config: RuntimeConfig,
  paused: boolean,
) {
  yield* setContextMaintenanceControl(config, paused);
  return publicStatus(yield* readState(config));
});

export const contextMaintenanceControlPath = Effect.fn('contextMaintenance.controlPath')(function* (
  config: RuntimeConfig,
) {
  return (yield* Path.Path).join(config.agentContextHome, 'context-maintenance', 'control-v1.json');
});

export const readMaintenanceControl = Effect.fn('contextMaintenance.readControl')(function* (config: RuntimeConfig) {
  const control = yield* readJson(yield* contextMaintenanceControlPath(config));
  if (control === undefined) return undefined;
  if (!isMaintenanceControl(control)) return yield* fail('Maintenance control is malformed; preserve it for recovery.');
  return control;
});

export const readContextMaintenanceControl = Effect.fn('contextMaintenance.control')(function* (config: RuntimeConfig) {
  const control = yield* readMaintenanceControl(config);
  return {paused: control?.paused ?? (yield* readRawState(config)).paused};
});

function withMaintenanceControlLock<A, E, R, B>(
  config: RuntimeConfig,
  effect: Effect.Effect<A, E, R>,
  busy: B,
  waitTimeoutMilliseconds = LOCK.waitTimeoutMilliseconds,
) {
  return Effect.suspend(() => {
    let entered = false;
    let lockPath: string | undefined;
    return Effect.gen(function* () {
      const file = yield* contextMaintenanceControlPath(config);
      lockPath = `${file}.lock`;
      return yield* withExclusiveFileLock(
        yield* FileSystem.FileSystem,
        lockPath,
        {...LOCK, waitTimeoutMilliseconds},
        Effect.gen(function* () {
          entered = true;
          return yield* effect;
        }),
      );
    }).pipe(
      Effect.catchIf(
        error => !entered && isFileLockTimeout(error) && error.lockPath === lockPath,
        () => Effect.fail(busy),
      ),
    );
  });
}

/** Control intent does not wait for a full maintenance run or rewrite its progress. */
export const setContextMaintenanceControl = Effect.fn('contextMaintenance.setControl')(function* (
  config: RuntimeConfig,
  paused: boolean,
) {
  const file = yield* contextMaintenanceControlPath(config);
  yield* withMaintenanceControlLock(
    config,
    readMaintenanceControl(config).pipe(Effect.andThen(atomicJson(file, {version: 1, paused}))),
    ContextMaintenanceBusy.make({}),
    2_000,
  );
  yield* (yield* ManagerLiveChangeHints).maintenance.pipe(Effect.ignoreCause);
  return {paused};
});

export function withMaintenanceControlPauseFence<A, E, R>(config: RuntimeConfig, publish: Effect.Effect<A, E, R>) {
  return withMaintenanceControlLock(
    config,
    Effect.gen(function* () {
      if ((yield* readContextMaintenanceControl(config)).paused)
        return yield* fail('Automatic generation is paused with all context maintenance.');
      return yield* publish;
    }),
    MaintenancePauseFenceBusy.make({}),
  );
}
