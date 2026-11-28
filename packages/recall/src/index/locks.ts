import {Deferred, Effect, Exit, FileSystem, Layer, Path, Schema, Scope} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {FileLockTimeout, fileLockBusyMessage, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
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
