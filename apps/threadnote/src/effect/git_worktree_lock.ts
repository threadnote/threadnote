import {SecureRandom} from 'effect/crypto';
import {Cause, Effect, Exit, FileSystem, Option, Path, Queue} from 'effect';
import {fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {publicRemoteMemoryError, remoteMemoryError} from '@threadnote/remote-memory/errors';

export type {GitWorktreeLock} from '@threadnote/remote-memory/git/worktree-lock';
import type {GitWorktreeLock} from '@threadnote/remote-memory/git/worktree-lock';

type LockServices = SecureRandom.SecureRandom | Path.Path | SystemInfo;
interface LockRequest {
  readonly run: Effect.Effect<void, never, LockServices>;
  readonly reject: () => void;
}

/** Owns the Promise adapter for the service lifetime without starting a nested Effect runtime. */
export const makeGitWorktreeLock = Effect.fn('gitWorktreeLock.make')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const queue = yield* Queue.bounded<LockRequest>(128);
  const pending = new Set<LockRequest>();
  let closed = false;
  const unavailable = () => remoteMemoryError('service_unavailable', 'The composer Git lock service is unavailable.');
  const stop = Effect.sync(() => {
    closed = true;
    for (const request of pending) request.reject();
    pending.clear();
  }).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid);
  yield* Effect.forkScoped(
    Effect.forever(Queue.take(queue).pipe(Effect.flatMap(request => request.run))).pipe(Effect.ensuring(stop)),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }),
  );

  const lock: GitWorktreeLock = <A>(path: string, operation: () => Promise<A>): Promise<A> => {
    if (closed) return Promise.reject(unavailable());
    const {promise, resolve, reject} = Promise.withResolvers<A>();
    const run = Effect.gen(function* () {
      const info = yield* fs.stat(path).pipe(
        Effect.catchIf(
          error => error.reason._tag === 'NotFound',
          () => Effect.void,
        ),
      );
      if (Option.isSome(yield* fs.readLink(path).pipe(Effect.option)) || (info !== undefined && info.type !== 'File')) {
        return yield* remoteMemoryError(
          'service_unavailable',
          'The composer lock requires operator recovery; preserve legacy lock state until all old writers are stopped.',
        );
      }
      return yield* withExclusiveFileLock(
        fs,
        path,
        {
          heartbeatIntervalMilliseconds: 1_000,
          retryIntervalMilliseconds: 25,
          staleAfterMilliseconds: 30_000,
          useCanonicalProcessStartIdentity: true,
          waitTimeoutMilliseconds: 10_000,
        },
        fromPromiseInterruptibleAwaiting(operation, publicRemoteMemoryError),
      );
    });
    const request: LockRequest = {
      reject: () => reject(unavailable()),
      run: run.pipe(
        Effect.onExit(exit =>
          Effect.sync(() => {
            pending.delete(request);
            if (Exit.isSuccess(exit)) resolve(exit.value);
            else reject(publicRemoteMemoryError(Cause.squash(exit.cause)));
          }),
        ),
        Effect.ignore,
      ),
    };
    pending.add(request);
    if (!Queue.offerUnsafe(queue, request)) {
      pending.delete(request);
      request.reject();
    }
    return promise;
  };
  return lock;
});
