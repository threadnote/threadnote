import {Array as EffectArray} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {expect} from 'vitest';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {initializeSchema} from '../../src/store/schema/initialization.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '../../src/types.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../../src/index_scope.js';
import {
  acknowledgeCodeGraphEmbeddingDemand,
  claimCodeGraphEmbeddingDemand,
  enqueueCodeGraphEmbeddingDemandSql,
  readCodeGraphEmbeddingDemandPage,
  validateCodeGraphEmbeddingDemandClaim,
} from '../../src/vector/demand.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const worktreeId = Effect2.pipe('b', EffectString.repeat(64));
const scopeId = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY;
const model = {id: 'test', sha256: Effect2.pipe('a', EffectString.repeat(64)), dimensions: 2, templateVersion: 1};
const owner = (token: string) => ({token, processId: 123, processStartIdentity: 'process'});
const snapshot = (n: number) => `cgsn_${Effect2.pipe(n.toString(16), EffectString.padStart(40, '0'))}`;
const epoch = (n: number) => new Date(n).toISOString();
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-demand-tests-'});
  const filename = path.join(root, 'graph.sqlite');
  const context = yield* Layer.build(SqliteClient.layer({filename}));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* initializeSchema(sql);
  yield* sql.unsafe(
    "INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at) VALUES (?, 'test', 'sha1', ?, ?)",
    [Effect2.pipe('a', EffectString.repeat(64)), epoch(0), epoch(0)],
  );
  for (const n of [1, 2]) {
    yield* sql.unsafe(
      "INSERT INTO snapshots (id, repository_id, worktree_id, commit_id, graph_content_id, extractor_set, dirty, state, file_count, symbol_count, edge_count, started_at, completed_at) VALUES (?, ?, ?, ?, ?, 'test', 0, 'ready', 0, 0, 0, ?, ?)",
      [
        snapshot(n),
        Effect2.pipe('a', EffectString.repeat(64)),
        worktreeId,
        Effect2.pipe('c', EffectString.repeat(40)),
        snapshot(n),
        epoch(0),
        epoch(0),
      ],
    );
    yield* sql.unsafe('INSERT INTO snapshot_extractor_generations VALUES (?, ?)', [
      snapshot(n),
      CODE_GRAPH_EXTRACTOR_GENERATION,
    ]);
  }
  yield* sql.unsafe(
    'INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at) VALUES (?, ?, ?, ?)',
    [worktreeId, scopeId, snapshot(1), epoch(0)],
  );
  const enqueue = (n: number, activation: number) =>
    enqueueCodeGraphEmbeddingDemandSql(sql, {
      worktreeId,
      scopeId,
      snapshotId: snapshot(n),
      activatedAt: epoch(activation),
    });
  const promote = (n: number, activation: number) =>
    sql.unsafe('UPDATE active_snapshots SET snapshot_id = ?, activated_at = ? WHERE worktree_id = ? AND scope_id = ?', [
      snapshot(n),
      epoch(activation),
      worktreeId,
      scopeId,
    ]);
  return {sql, filename, enqueue, promote};
});
effectIt.layer(citationPlatformLayer)(it => {
  it.effect(
    'coalesces ABA into one desired row, rejects obsolete completion, and persists retry timing across reopened sessions',
    () =>
      Effect.gen(function* () {
        const {sql, filename, enqueue, promote} = yield* fixture;
        yield* enqueue(1, 0);
        const first = yield* claimCodeGraphEmbeddingDemand(sql, {worktreeId, owner: owner('first'), model, now: 0});
        expect(first).toBeDefined();
        yield* promote(2, 1);
        yield* enqueue(2, 1);
        yield* promote(1, 2);
        yield* enqueue(1, 2);
        const rows = yield* readCodeGraphEmbeddingDemandPage(sql);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          snapshotId: snapshot(1),
          activatedAt: epoch(2),
          active: {owner: {token: 'first'}, activatedAt: epoch(0)},
        });
        expect(yield* validateCodeGraphEmbeddingDemandClaim(sql, first!, 1)).toBe(false);
        expect(yield* acknowledgeCodeGraphEmbeddingDemand(sql, first!, {kind: 'finish', now: 1})).toBeUndefined();
        yield* acknowledgeCodeGraphEmbeddingDemand(sql, first!, {kind: 'superseded', now: 1});
        const current = yield* claimCodeGraphEmbeddingDemand(sql, {worktreeId, owner: owner('current'), model, now: 1});
        expect(current?.activatedAt).toBe(epoch(2));
        yield* acknowledgeCodeGraphEmbeddingDemand(sql, current!, {kind: 'failure', now: 2, jitter: 0});
        const reopened = Context.get(yield* Layer.build(SqliteClient.layer({filename})), SqlClient.SqlClient);
        expect((yield* readCodeGraphEmbeddingDemandPage(reopened))[0]).toMatchObject({
          attempt: 1,
          notBefore: 1002,
          state: 'deferred',
        });
        expect(
          yield* claimCodeGraphEmbeddingDemand(reopened, {worktreeId, owner: owner('too-early'), model, now: 1001}),
        ).toBeUndefined();
        expect(
          yield* claimCodeGraphEmbeddingDemand(reopened, {worktreeId, owner: owner('due'), model, now: 1002}),
        ).toBeDefined();
      }),
  );
  it.effect(
    'retains one publication claim through contention without charging a model failure or renewing ABA work',
    () =>
      Effect.gen(function* () {
        const {sql, enqueue, promote} = yield* fixture;
        yield* enqueue(1, 0);
        const claim = yield* claimCodeGraphEmbeddingDemand(sql, {
          worktreeId,
          owner: owner('continuation'),
          model,
          now: 0,
        });
        expect(claim).toBeDefined();
        const deferred = yield* acknowledgeCodeGraphEmbeddingDemand(sql, claim!, {
          kind: 'defer',
          retainClaim: true,
          reason: 'contention',
          now: 1,
          retryAfterMilliseconds: 1_000,
        });
        expect(deferred).toMatchObject({
          state: 'deferred',
          attempt: 0,
          notBefore: 1001,
          active: {owner: {token: 'continuation'}},
        });
        expect(yield* validateCodeGraphEmbeddingDemandClaim(sql, deferred!.active!, 2)).toBe(true);
        expect(
          yield* claimCodeGraphEmbeddingDemand(sql, {worktreeId, owner: owner('duplicate'), model, now: 1001}),
        ).toBeUndefined();
        yield* promote(2, 1);
        yield* enqueue(2, 1);
        yield* promote(1, 2);
        yield* enqueue(1, 2);
        expect(
          yield* acknowledgeCodeGraphEmbeddingDemand(sql, deferred!.active!, {
            kind: 'defer',
            retainClaim: true,
            now: 3,
          }),
        ).toBeUndefined();
        expect((yield* readCodeGraphEmbeddingDemandPage(sql))[0]).toMatchObject({
          state: 'queued',
          activatedAt: epoch(2),
        });
      }),
  );
  it.effect('persists bounded failures and never resets backoff for duplicate enqueue or an early restart', () =>
    Effect.gen(function* () {
      const {sql, enqueue} = yield* fixture;
      yield* enqueue(1, 0);
      let now = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const claim = yield* claimCodeGraphEmbeddingDemand(sql, {
          worktreeId,
          owner: owner(`attempt-${attempt}`),
          model,
          now,
        });
        expect(claim).toBeDefined();
        const failed = yield* acknowledgeCodeGraphEmbeddingDemand(sql, claim!, {kind: 'failure', now, jitter: 0});
        expect(failed?.attempt).toBe(attempt);
        yield* enqueue(1, 0);
        expect((yield* readCodeGraphEmbeddingDemandPage(sql))[0]).toMatchObject({
          attempt,
          notBefore: failed!.notBefore,
        });
        expect(
          yield* claimCodeGraphEmbeddingDemand(sql, {worktreeId, owner: owner('early'), model, now}),
        ).toBeUndefined();
        now = failed!.notBefore;
      }
      expect((yield* readCodeGraphEmbeddingDemandPage(sql))[0]?.state).toBe('blocked');
      expect(
        yield* claimCodeGraphEmbeddingDemand(sql, {worktreeId, owner: owner('later'), model, now: now + 1_000_000}),
      ).toBeUndefined();
      const changed = {...model, sha256: Effect2.pipe('c', EffectString.repeat(64))};
      expect(
        yield* claimCodeGraphEmbeddingDemand(sql, {
          worktreeId,
          owner: owner('new-config'),
          model: changed,
          now: now + 1,
        }),
      ).toBeDefined();
      expect((yield* readCodeGraphEmbeddingDemandPage(sql))[0]?.attempt).toBe(0);
    }),
  );
  it.effect('rebinds unchanged recorded intent after model invalidation and rejects the old completion', () =>
    Effect.gen(function* () {
      const {sql, enqueue} = yield* fixture;
      yield* enqueue(1, 0);
      const oldClaim = yield* claimCodeGraphEmbeddingDemand(sql, {
        worktreeId,
        owner: owner('model-a'),
        model,
        now: 0,
      });
      expect(oldClaim).toBeDefined();
      const rebound = yield* acknowledgeCodeGraphEmbeddingDemand(sql, oldClaim!, {
        kind: 'rebind',
        reason: 'model-changed',
        now: 1,
      });
      expect(rebound).toMatchObject({state: 'queued', snapshotId: snapshot(1), activatedAt: epoch(0)});
      expect(rebound?.active).toBeUndefined();
      expect(yield* acknowledgeCodeGraphEmbeddingDemand(sql, oldClaim!, {kind: 'finish', now: 2})).toBeUndefined();
      const modelB = {...model, id: 'test-b', sha256: Effect2.pipe('b', EffectString.repeat(64))};
      const newClaim = yield* claimCodeGraphEmbeddingDemand(sql, {
        worktreeId,
        owner: owner('model-b'),
        model: modelB,
        now: 3,
      });
      expect(newClaim).toMatchObject({model: modelB, snapshotId: snapshot(1), activatedAt: epoch(0)});
    }),
  );
  it.effect('pages an entire demand catalog in bounded pages without truncating later lanes', () =>
    Effect.gen(function* () {
      const {sql} = yield* fixture;
      for (let n = 0; n < 130; n++) {
        const id = Effect2.pipe(n.toString(16), EffectString.padStart(64, '0'));
        yield* sql.unsafe(
          'INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at) VALUES (?, ?, ?, ?)',
          [id, scopeId, snapshot(1), epoch(0)],
        );
        yield* enqueueCodeGraphEmbeddingDemandSql(sql, {
          worktreeId: id,
          scopeId,
          snapshotId: snapshot(1),
          activatedAt: epoch(0),
        });
      }
      const first = yield* readCodeGraphEmbeddingDemandPage(sql, {limit: 1000});
      const second = yield* readCodeGraphEmbeddingDemandPage(sql, {after: first.at(-1), limit: 1000});
      const final = yield* readCodeGraphEmbeddingDemandPage(sql, {after: second.at(-1), limit: 1000});
      expect([first.length, second.length, final.length]).toEqual([64, 64, 2]);
      expect(new Set(EffectArray.map([...first, ...second, ...final], lane => lane.worktreeId)).size).toBe(130);
    }),
  );
  it.effect('does not synthesize demand on a ready graph read and fails closed on a future schema', () =>
    Effect.gen(function* () {
      const {sql, enqueue} = yield* fixture;
      expect(yield* readCodeGraphEmbeddingDemandPage(sql)).toEqual([]);
      yield* enqueue(1, 0);
      yield* sql.unsafe("UPDATE schema_metadata SET value = '999' WHERE key = 'persistent_extension_schema_revision'");
      expect((yield* readCodeGraphEmbeddingDemandPage(sql).pipe(Effect.result))._tag).toBe('Failure');
      expect(
        (yield* claimCodeGraphEmbeddingDemand(sql, {worktreeId, owner: owner('future'), model, now: 0}).pipe(
          Effect.result,
        ))._tag,
      ).toBe('Failure');
      expect(yield* sql.unsafe('SELECT state, attempt, active_json FROM embedding_demand')).toEqual([
        {state: 'queued', attempt: 0, active_json: null},
      ]);
    }),
  );
});
