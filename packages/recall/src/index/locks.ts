import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {FileLockTimeout, fileLockBusyMessage, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import type {RecallIndexConfig} from '../index.js';
import {useRecallDatabaseReadOnly} from './read_policy.js';
import {captureRecallRefreshCut, recallRefreshSuperseded, verifyRecallSourceInputs} from './refresh_cut.js';
import {failFastIdentityPreparation, RecallIdentityAdmissionBusy} from './admission.js';
import {recallPublicationFenceHeld, withRecallPublicationLock} from './stale_marker.js';

export function useRecallDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const failFast = yield* failFastIdentityPreparation;
    return yield* Effect.scoped(
      Layer.build(
        SqliteClient.layer({filename: databasePath, ...(failFast ? {busyTimeout: 0} : {})}).pipe(Layer.orDie),
      ).pipe(
        Effect.withSpan('recall.acquireDatabase'),
        Effect.flatMap(context => effect.pipe(Effect.provide(context), Effect.withSpan('recall.databaseBody'))),
      ),
    );
  });
}

export function withRecallIndexLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  effect: () => Effect.Effect<A, E, R>,
  admissionAccount?: string,
) {
  return Effect.gen(function* () {
    const reentrant = yield* recallPublicationFenceHeld(lockPath);
    const locked = withRecallPublicationLock(
      fs,
      lockPath,
      {
        category: 'recall-index',
        heartbeatIntervalMilliseconds: 10_000,
        retryIntervalMilliseconds: 100,
        staleAfterMilliseconds: 60_000,
        waitTimeoutMilliseconds:
          admissionAccount !== undefined || reentrant || (yield* failFastIdentityPreparation) ? 0 : 120_000,
      },
      Effect.result(Effect.suspend(effect)),
      admissionAccount,
    );
    return yield* (
      admissionAccount !== undefined
        ? locked.pipe(
            Effect.catchIf(Schema.is(FileLockTimeout), error =>
              Effect.fail(
                RecallIdentityAdmissionBusy.make({
                  message: fileLockBusyMessage(error),
                }),
              ),
            ),
          )
        : locked
    ).pipe(Effect.flatMap(Effect.fromResult));
  });
}

export function withCanonicalResourceMutationLock<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  account: string,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    return yield* withExclusiveFileLock(
      fs,
      resourceAccountMutationLockPath(path, home, account),
      {
        category: 'canonical-account',
        heartbeatIntervalMilliseconds: 10_000,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 30_000,
        waitTimeoutMilliseconds: (yield* failFastIdentityPreparation) ? 0 : 30_000,
      },
      effect,
    );
  });
}

export interface RecallIndexActivation {
  readonly expectedActiveDatabasePath: string;
  readonly relativeDatabasePath: string;
  publication?: {
    readonly seal: string;
    readonly sourceInputs: ReadonlyMap<string, string>;
  };
}

/** Activate only after private writers and the final readonly validation scope close. */
export function withVerifiedRecallIndexActivation<A, E, R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallIndexConfig,
  includeInactive: boolean,
  location: {
    readonly lockPath: string;
    readonly databasePath: string;
    readonly activeDatabasePath: string;
    readonly pointerPath: string;
    readonly staleMarkerBasePath: string;
  },
  publication: RecallIndexActivation['publication'],
  publish: Effect.Effect<A, E, R>,
) {
  return withRecallIndexLock(
    fs,
    location.lockPath,
    () =>
      withCanonicalResourceMutationLock(
        fs,
        path,
        config.agentContextHome,
        config.account,
        Effect.gen(function* () {
          if (!publication) return yield* recallRefreshSuperseded();
          yield* verifyRecallSourceInputs(publication.sourceInputs);
          const cut = yield* useRecallDatabaseReadOnly(
            location.databasePath,
            Effect.flatMap(SqlClient.SqlClient, sql =>
              captureRecallRefreshCut(sql, fs, path, config, includeInactive, location),
            ),
          );
          if (cut.seal !== publication.seal) return yield* recallRefreshSuperseded();
          return yield* publish;
        }),
      ),
    config.account,
  );
}
