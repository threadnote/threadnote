import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from './system-layer.js';
import {provideTestLayer} from './effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Schema} from 'effect';
import {type CodeGraphRemovedViewCleanupEntry, CodeGraphStore, type CodeGraphStoreShape} from '@threadnote/graph/store';
import {CodeGraphStoreBusyError, isCodeGraphStoreError} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const [databasePath, nowText, markerPath, contentionMarkerPath] = process.argv.slice(2);
const validPath = (value: string | undefined) =>
  value !== undefined && value.length > 0 && !Effect2.pipe(value, EffectString.includes('\0'));
if (
  !validPath(databasePath) ||
  !validPath(markerPath) ||
  (contentionMarkerPath !== undefined && !validPath(contentionMarkerPath)) ||
  !/^[0-9]+$/u.test(nowText ?? '')
) {
  process.stderr.write('invalid removed-view-cleanup child arguments\n');
  process.exit(2);
}

const now = Number(nowText);
if (!Number.isSafeInteger(now)) {
  process.stderr.write('invalid removed-view-cleanup child time\n');
  process.exit(2);
}

const childLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(Layer.merge(BunServices.layer, TestSystemInfoLayer)));
const CLAIM_BUDGET_MILLISECONDS = 30_000;
const CLAIM_RETRY_PAUSE_MILLISECONDS = 25;

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const store = yield* CodeGraphStore;
  const claimed = yield* claimWithBoundedBusyDeferral(store, fs, databasePath, now, contentionMarkerPath);
  const marker = JSON.stringify({
    event: 'claim-committed',
    processId: process.pid,
    revisions: EffectArray.map(claimed, entry => entry.revision),
    worktreeIds: EffectArray.map(claimed, entry => entry.worktreeId),
  });
  yield* fs.writeFileString(markerPath, marker, {flag: 'wx', mode: 0o600});
  process.stdout.write(`${marker}\n`);
  // A pending Effect alone does not retain Bun's event loop. Keep a live,
  // bounded timer handle until the parent exercises post-commit SIGKILL.
  for (;;) yield* Effect.sleep(60_000);
}).pipe(provideTestLayer(childLayer));

function claimWithBoundedBusyDeferral(
  store: CodeGraphStoreShape,
  fs: FileSystem.FileSystem,
  databasePath: string,
  now: number,
  contentionMarkerPath: string | undefined,
): Effect.Effect<readonly CodeGraphRemovedViewCleanupEntry[], unknown> {
  const deadline = performance.now() + CLAIM_BUDGET_MILLISECONDS;
  let contentionReported = false;

  const attempt = (): Effect.Effect<readonly CodeGraphRemovedViewCleanupEntry[], unknown> => {
    const remainingMilliseconds = Math.max(0, deadline - performance.now());
    return store
      .claimRemovedViewCleanupCandidates(databasePath, now, 32, {
        waitTimeoutMilliseconds: remainingMilliseconds,
      })
      .pipe(
        Effect.catch(error => {
          if (!Schema.is(CodeGraphStoreBusyError)(error) || !error.retryable || performance.now() >= deadline) {
            return Effect.fail(error);
          }
          const reportContention =
            contentionMarkerPath !== undefined && !contentionReported
              ? Effect.sync(() => {
                  contentionReported = true;
                }).pipe(
                  Effect.andThen(
                    fs.writeFileString(contentionMarkerPath, 'retryable-sqlite-busy\n', {flag: 'wx', mode: 0o600}),
                  ),
                )
              : Effect.void;
          return reportContention.pipe(
            Effect.andThen(
              Effect.sleep(Math.max(0, Math.min(CLAIM_RETRY_PAUSE_MILLISECONDS, deadline - performance.now()))),
            ),
            Effect.andThen(Effect.suspend(attempt)),
          );
        }),
      );
  };

  return Effect.suspend(attempt);
}

Effect.runPromise(program).catch((cause: unknown) => {
  const diagnostic = isCodeGraphStoreError(cause)
    ? {code: cause.code, name: cause.name, operation: cause.operation, retryable: cause.retryable}
    : {name: cause instanceof Error ? cause.name : 'unknown'};
  process.stderr.write(`removed-view-cleanup child failed: ${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 1;
});
