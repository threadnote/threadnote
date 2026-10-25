import {Cause, Clock, Crypto, Effect, Exit, FileSystem, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {readModelSelection} from '@threadnote/inference/models/selection';
import type {CodeGraphEmbeddingIndexShape, CodeGraphVectorPublication} from '../embedding.js';
import {codeGraphVectorWriteLockPath, type CodeGraphLayout} from '../layout.js';
import {withCodeGraphVectorPublicationWorktreeLock, withCodeGraphDatabaseWriteLock} from '../maintenance/gate.js';
import {selectActiveViewFence} from '../store/active_views.js';
import type {CodeGraphStoreShape} from '../store.js';
import {CODE_GRAPH_DEFERRED_VECTORS, type CodeGraphIndexSummary, type CodeGraphSnapshot} from '../types.js';
export {CODE_GRAPH_DEFERRED_VECTORS};

class CodeGraphVectorPublicationSuperseded extends Schema.TaggedError<CodeGraphVectorPublicationSuperseded>()(
  'CodeGraphVectorPublicationSuperseded',
  {message: Schema.String},
) {}

/** Capture only while the structural publisher still owns its target gates. */
export const captureCodeGraphVectorPublication = Effect.fn('codeGraph.captureVectorPublication')(function* (input: {
  readonly store: CodeGraphStoreShape;
  readonly layout: CodeGraphLayout;
  readonly threadnoteHome: string;
  readonly snapshot: CodeGraphSnapshot;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  const {layout, store, snapshot, threadnoteHome} = input;
  const fence = yield* store.withSession(layout.databasePath, selectActiveViewFence(layout.worktreeId, layout.scopeId));
  if (!fence || fence.snapshotId !== snapshot.id) {
    return yield* CodeGraphVectorPublicationSuperseded.make({
      message: 'Code graph vector publication target is no longer active.',
    });
  }
  const selectedModelId = (yield* readModelSelection(threadnoteHome)).roles.embedding;
  const validateInSession = Effect.gen(function* () {
    const current = yield* selectActiveViewFence(layout.worktreeId, layout.scopeId);
    const ready = yield* store.readySnapshot(layout.databasePath, layout.worktreeId, layout.scopeId);
    const modelId = (yield* readModelSelection(threadnoteHome)).roles.embedding;
    if (
      !current ||
      current.snapshotId !== fence.snapshotId ||
      current.activatedAt !== fence.activatedAt ||
      ready?.id !== snapshot.id ||
      modelId !== selectedModelId
    ) {
      return yield* CodeGraphVectorPublicationSuperseded.make({
        message: 'Code graph vector publication was superseded.',
      });
    }
  });
  const provide = <A, E, R>(
    effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path | Crypto.Crypto | SystemInfo>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(SystemInfo, system),
    );
  return {
    validate: provide(store.withSession(layout.databasePath, validateInSession, {readOnly: true})),
    attach: commit =>
      provide(
        withCodeGraphVectorPublicationWorktreeLock(
          threadnoteHome,
          layout.checkoutId,
          layout.worktreeId,
          withExclusiveFileLock(
            fs,
            codeGraphVectorWriteLockPath(path, threadnoteHome, layout.checkoutId, sha256HexSync(selectedModelId ?? '')),
            {
              retryIntervalMilliseconds: 100,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: Number.POSITIVE_INFINITY,
            },
            withCodeGraphDatabaseWriteLock(
              threadnoteHome,
              layout.checkoutId,
              store.withSession(
                layout.databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.withTransaction(
                    validateInSession.pipe(Effect.andThen(commit), Effect.andThen(validateInSession)),
                  );
                }),
                {existingOnly: true, writerLockPath: layout.databaseWriteLockPath, writerGateHeld: true},
              ),
            ),
          ),
          layout.scopeId,
        ),
      ),
  } satisfies CodeGraphVectorPublication;
});

/** The plan is private to this in-process structural result and never appears in JSON receipts. */
export const deferCodeGraphVectorCompletion = Effect.fn('codeGraph.deferVectorCompletion')(function* (input: {
  readonly summary: CodeGraphIndexSummary;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly layout: CodeGraphLayout;
  readonly store: CodeGraphStoreShape;
  readonly threadnoteHome: string;
  readonly force?: boolean;
  readonly onProgress?: (progress: import('../types.js').CodeGraphProgress) => Effect.Effect<void, unknown>;
}) {
  const publication = yield* captureCodeGraphVectorPublication({...input, snapshot: input.summary.snapshot});
  // Each page owns a fresh ready-only lease. Expired leases are never renewed or resurrected.
  const read = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      input.store.acquireSnapshotLease(input.layout.databasePath, input.summary.snapshot.id, 120_000),
      () => publication.validate.pipe(Effect.andThen(effect)),
      token => input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.ignore),
    );
  const started = yield* Clock.currentTimeMillis;
  const complete = input.embedding
    .ensure(
      input.threadnoteHome,
      input.layout,
      input.summary.snapshot,
      {
        count: read(input.store.countEmbeddingSymbols(input.layout.databasePath, input.summary.snapshot.id)),
        loadPage: (cursor, limit) =>
          read(
            input.store.loadEmbeddingSymbolPage(input.layout.databasePath, input.summary.snapshot.id, cursor, limit),
          ),
      },
      {force: input.force, onProgress: input.onProgress, publication},
    )
    .pipe(
      Effect.catch(cause =>
        Effect.succeed({ready: false, reason: cause instanceof Error ? cause.message : String(cause)}),
      ),
      Effect.flatMap(result =>
        Clock.currentTimeMillis.pipe(
          Effect.map(now => {
            const {[CODE_GRAPH_DEFERRED_VECTORS]: _plan, ...summary} = input.summary;
            return {
              ...summary,
              durationMs: summary.durationMs + now - started,
              diagnostics: result.ready
                ? summary.diagnostics
                : [...summary.diagnostics, `Vector graph retrieval unavailable: ${result.reason ?? 'unknown reason'}`],
            };
          }),
        ),
      ),
    );
  return {...input.summary, [CODE_GRAPH_DEFERRED_VECTORS]: {complete}};
});

export function completeCodeGraphDeferredVectors(summary: CodeGraphIndexSummary) {
  return summary[CODE_GRAPH_DEFERRED_VECTORS]?.complete ?? Effect.succeed(summary);
}

export function withCodeGraphDeferredCompletionReporter(
  summary: CodeGraphIndexSummary,
  report: (completed: CodeGraphIndexSummary) => Effect.Effect<void, unknown>,
  heartbeat: Effect.Effect<void, never>,
  fail: (cause: Cause.Cause<unknown>) => Effect.Effect<void, never>,
): CodeGraphIndexSummary {
  return {
    ...summary,
    [CODE_GRAPH_DEFERRED_VECTORS]: {
      complete: Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(heartbeat);
          return yield* completeCodeGraphDeferredVectors(summary).pipe(Effect.tap(report));
        }),
      ).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? fail(exit.cause) : Effect.void))),
    },
  };
}
