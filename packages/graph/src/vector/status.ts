import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Cause, Clock, Effect, FileSystem, Layer, Option} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import * as SqlClient from 'effect/sql/SqlClient';
import type {CodeGraphEmbeddingIndexShape} from '../embedding.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';
import type {CodeGraphLayout} from '../layout.js';
import type {CodeGraphSemanticStatus, CodeGraphSnapshot} from '../types.js';
import {readCodeGraphEmbeddingDemandLane} from './demand.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_GRAPH_SEMANTIC_STATUS_TIMEOUT_MILLISECONDS = 1000;

function readMetadataDatabase<A, E, R>(databasePath: string, read: Effect.Effect<A, E, R | SqlClient.SqlClient>) {
  return Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        filename: databasePath,
        readonly: true,
        readwrite: false,
        create: false,
        disableWAL: true,
        busyTimeout: 100,
      }),
    ).pipe(Effect.flatMap(context => read.pipe(Effect.provide(context)))),
  );
}

/** Metadata-only observation: no migration, demand creation, worker wake, or inference. */
export const observeCodeGraphSemanticStatus = Effect.fn('codeGraph.observeSemanticStatus')(function* (input: {
  readonly threadnoteHome: string;
  readonly layout: CodeGraphLayout;
  readonly snapshot?: CodeGraphSnapshot;
  readonly embedding?: Pick<CodeGraphEmbeddingIndexShape, 'check'>;
}) {
  const snapshotId = input.snapshot?.id;
  const unavailable = (reason: string): CodeGraphSemanticStatus => ({
    state: 'unavailable',
    ...(snapshotId === undefined ? {} : {snapshotId}),
    reason,
  });
  if (!input.snapshot || input.snapshot.state !== 'ready') return unavailable('no-ready-snapshot');
  const {layout, snapshot} = input;
  if (
    (layout.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) !==
    (snapshot.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY)
  )
    return unavailable('selected-view-mismatch');
  const observe = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(layout.databasePath))) return unavailable('graph-database-missing');
    const activation = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{readonly activated_at: string}>(
        `SELECT active.activated_at FROM active_snapshots AS active
         JOIN snapshots AS snapshot ON snapshot.id=active.snapshot_id
         WHERE active.worktree_id=? AND active.scope_id=? AND active.snapshot_id=?
           AND snapshot.state='ready' AND snapshot.scope_id=active.scope_id
           AND NOT EXISTS (SELECT 1 FROM removed_views AS removed
             WHERE removed.worktree_id=active.worktree_id AND removed.scope_id=active.scope_id
               AND removed.expected_snapshot_id=active.snapshot_id) LIMIT 1`,
        [layout.worktreeId, layout.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, snapshot.id],
      );
      return rows[0]?.activated_at;
    });
    const observed = yield* readMetadataDatabase(
      layout.databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const activatedAt = yield* activation;
            const lane = yield* readCodeGraphEmbeddingDemandLane(sql, layout);
            return {activatedAt, lane};
          }),
        );
      }),
    );
    if (!observed.activatedAt) return unavailable('selected-view-not-active');
    const lane =
      observed.lane?.snapshotId === snapshot.id && observed.lane.activatedAt === observed.activatedAt
        ? observed.lane
        : undefined;
    const check = input.embedding
      ? yield* input.embedding.check(input.threadnoteHome, layout, snapshot.id, {metadataOnly: true})
      : undefined;
    // Fence a replacement (including an ABA activation) that raced the vector read.
    if ((yield* readMetadataDatabase(layout.databasePath, activation)) !== observed.activatedAt)
      return unavailable('selected-view-changed');
    if (check?.state === 'ready')
      return {
        state: 'ready',
        snapshotId: snapshot.id,
        modelId: check.modelId,
        completedSymbols: check.reused,
      } satisfies CodeGraphSemanticStatus;
    if (!lane || lane.state === 'cancelled')
      return {state: 'not-requested', snapshotId: snapshot.id} satisfies CodeGraphSemanticStatus;
    const system = yield* Effect.serviceOption(SystemInfo);
    if (Option.isSome(system)) {
      const available = yield* system.value.availableDiskBytes(layout.repositoryRoot).pipe(
        Effect.timeoutOption(250),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(available) && available.value === 0)
        return {
          state: 'blocked',
          snapshotId: snapshot.id,
          reason: 'disk-capacity-unavailable',
        } satisfies CodeGraphSemanticStatus;
    }
    const now = yield* Clock.currentTimeMillis;
    const timing = {attempt: lane.attempt, ...(lane.notBefore > now ? {retryAt: lane.notBefore} : {})};
    const reason = Effect2.pipe(lane.reason, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.slice(0, 512)),
    );
    if (lane.state === 'blocked')
      return {state: 'blocked', snapshotId: snapshot.id, ...(reason ? {reason} : {})} satisfies CodeGraphSemanticStatus;
    if (check?.state === 'unavailable') return unavailable('selected-model-unavailable');
    if (!check) return unavailable('embedding-observer-unavailable');
    if (lane.state === 'ready')
      return {
        state: 'deferred',
        snapshotId: snapshot.id,
        reason: 'selected-generation-not-ready',
      } satisfies CodeGraphSemanticStatus;
    if (lane.state === 'building')
      return {
        state: lane.active && lane.active.expiresAt > now ? 'embedding' : 'deferred',
        snapshotId: snapshot.id,
        attempt: lane.attempt,
        ...(lane.active && lane.active.expiresAt <= now ? {reason: 'worker-lease-expired'} : {}),
      } satisfies CodeGraphSemanticStatus;
    return {
      state: lane.state,
      snapshotId: snapshot.id,
      ...timing,
      ...(reason ? {reason} : {}),
    } satisfies CodeGraphSemanticStatus;
  });
  return yield* observe.pipe(
    Effect.timeoutOrElse({
      duration: CODE_GRAPH_SEMANTIC_STATUS_TIMEOUT_MILLISECONDS,
      orElse: () => Effect.succeed(unavailable('semantic-observation-timed-out')),
    }),
    Effect.catchCauseIf(
      cause => !Cause.hasInterruptsOnly(cause),
      () => Effect.succeed(unavailable('semantic-metadata-unavailable')),
    ),
  );
});
