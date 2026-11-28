import {Deferred, Effect, Exit, FileSystem, Path, Schema, Scope} from 'effect';
import type {SecureRandom} from 'effect/crypto';
import * as SqlClient from 'effect/sql/SqlClient';
import {FileLockTimeout, fileLockBusyMessage, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {SystemInfo} from '@threadnote/platform/system';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import type {RecallIndexConfig} from '../index.js';
import {loadRecallMetadata, useRecallDatabaseReadOnly} from './read_policy.js';
import {
  captureRecallRefreshCut,
  recallMetadataCut,
  recallRefreshSuperseded,
  verifyRecallSourceInputs,
} from './refresh_cut.js';
import {failFastIdentityPreparation, RecallIdentityAdmissionBusy} from './admission.js';
import {recallPublicationFenceHeld, withRecallPublicationLock} from './stale_marker.js';

export function withRecallIndexLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  effect: () => Effect.Effect<A, E, R>,
  admissionAccount?: string,
  waitForLock = true,
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
          !waitForLock || admissionAccount !== undefined || reentrant || (yield* failFastIdentityPreparation)
            ? 0
            : 120_000,
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
  return withExclusiveFileLock(
    fs,
    resourceAccountMutationLockPath(path, home, account),
    {
      category: 'canonical-account',
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 30_000,
      waitTimeoutMilliseconds: 0,
    },
    effect,
  );
}

/** The transaction exits before the scoped holder can release the file locks. */
export function withRecallCommitFence<A, E, R, E2, R2>(
  hold: (untilCommit: Effect.Effect<void>) => Effect.Effect<void, E, R>,
  transaction: (enter: Effect.Effect<void, E, R | Scope.Scope>) => Effect.Effect<A, E2, R2>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>();
      const enter = Effect.gen(function* () {
        const entered = yield* Deferred.make<void, E>();
        yield* hold(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(settled)))).pipe(
          Effect.exit,
          Effect.flatMap(exit => (Exit.isFailure(exit) ? Deferred.failCause(entered, exit.cause) : Effect.void)),
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
      });
      return yield* transaction(enter).pipe(Effect.ensuring(Deferred.succeed(settled, undefined)));
    }),
  );
}

export interface RecallIndexActivation {
  readonly expectedActiveDatabasePath: string;
  readonly relativeDatabasePath: string;
  readonly markPublished: () => void;
  publication?: {
    readonly seal: string;
    readonly metadataCut: string;
    readonly sourceInputs: ReadonlyMap<string, string>;
    readonly finish: Effect.Effect<
      void,
      unknown,
      FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom | SystemInfo
    >;
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
  publication: NonNullable<RecallIndexActivation['publication']>,
  publish: Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(failFastIdentityPreparation, strict =>
    withRecallIndexLock(
      fs,
      location.lockPath,
      () =>
        withCanonicalResourceMutationLock(
          fs,
          path,
          config.agentContextHome,
          config.account,
          Effect.gen(function* () {
            yield* verifyRecallSourceInputs(publication.sourceInputs);
            const metadata = yield* useRecallDatabaseReadOnly(
              location.databasePath,
              Effect.flatMap(SqlClient.SqlClient, loadRecallMetadata),
            );
            const cut = yield* captureRecallRefreshCut(fs, path, config, includeInactive, location);
            if (cut.seal !== publication.seal || recallMetadataCut(metadata) !== publication.metadataCut)
              return yield* recallRefreshSuperseded();
            return yield* publish;
          }),
        ),
      strict ? config.account : undefined,
      false,
    ).pipe(
      Effect.catchIf(
        error => !strict && Schema.is(FileLockTimeout)(error),
        () => Effect.fail(recallRefreshSuperseded()),
      ),
    ),
  );
}
