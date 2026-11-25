import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Clock, Context, DateTime, Effect, Layer} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  claimCodeGraphGeneration,
  commitCodeGraphGenerationStep,
  completeCodeGraphGeneration,
  initializeCodeGraphGenerationSchema,
  readCodeGraphGenerationProgress,
  releaseCodeGraphGenerationClaim,
  renewCodeGraphGenerationClaim,
  requireCodeGraphGenerationClaim,
  selectCodeGraphPredecessorGeneration,
  CODE_GRAPH_GENERATION_LEASE_MILLISECONDS,
} from '../../src/vector/generation.js';
import {
  admitOneCodeGraphVectorRetirement,
  deleteCodeGraphVectorPointerWithRetirementSql,
  initializeCodeGraphVectorRetirementSchema,
  CODE_GRAPH_VECTOR_BUILDING_GRACE_MILLISECONDS,
  CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL,
  CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_REUSE_INDEX_SQL,
  CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
  CODE_GRAPH_VECTORS_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
} from '../../src/vector/retirement.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const fixture = Effect.gen(function* () {
  const context = yield* Layer.build(SqliteClient.layer({filename: ':memory:'}));
  const sql = Context.get(context, SqlClient.SqlClient);
  for (const definition of [
    CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
    CODE_GRAPH_VECTORS_TABLE_SQL,
    CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
    CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
  ])
    yield* sql.unsafe(definition);
  yield* initializeCodeGraphGenerationSchema(sql);
  yield* sql.unsafe(
    "INSERT INTO vector_generations VALUES ('target', 'snapshot', 'model', ?, 1, 1, 0, 'building', 'now')",
    [Effect2.pipe('a', EffectString.repeat(64))],
  );
  return sql;
});
// Use every production table, index, trigger and state CHECK, rather than the
// deliberately minimal checkpoint fixture above.
const retirementFixture = Effect.gen(function* () {
  const context = yield* Layer.build(SqliteClient.layer({filename: ':memory:'}));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  for (const definition of [
    CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
    CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL,
    CODE_GRAPH_VECTORS_TABLE_SQL,
    CODE_GRAPH_VECTOR_REUSE_INDEX_SQL,
    CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL,
  ])
    yield* sql.unsafe(definition);
  yield* sql.unsafe('PRAGMA user_version = 2');
  yield* initializeCodeGraphVectorRetirementSchema(sql);
  yield* initializeCodeGraphGenerationSchema(sql);
  yield* sql.unsafe('PRAGMA user_version = 3');
  const insert = (generation: string, state: 'building' | 'ready', createdAt = '2026-01-01T00:00:00.000Z') =>
    sql.unsafe('INSERT INTO vector_generations VALUES (?, ?, ?, ?, 1, 1, 0, ?, ?)', [
      generation,
      `snapshot-${generation}`,
      'model',
      Effect2.pipe('a', EffectString.repeat(64)),
      state,
      createdAt,
    ]);
  yield* insert('g0', 'ready');
  yield* sql.unsafe('INSERT INTO vectors VALUES (?, ?, ?, ?)', [
    'g0',
    'old-symbol',
    'old-fingerprint',
    new Uint8Array([7]),
  ]);
  yield* sql.unsafe("UPDATE vector_generations SET count = 1 WHERE generation = 'g0'");
  yield* sql.unsafe('INSERT INTO vector_pointers VALUES (?, ?)', [Effect2.pipe('b', EffectString.repeat(64)), 'g0']);
  yield* insert('g1', 'building');
  yield* claimCodeGraphGeneration(sql, {
    generation: 'g1',
    ownerToken: 'stalled',
    requestEpoch: 'epoch-g1',
    reusableGeneration: 'g0',
  });
  return {sql, insert};
});

const retired = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql.unsafe<{readonly generation: string}>(
      'SELECT generation FROM vector_generation_retirements ORDER BY generation',
    ),
    rows => EffectArray.map(rows, row => row.generation),
  );
// Admission steps until a pass wraps cleanly; every restarted pass is reported.
const admitUntilClean = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const states: string[] = [];
    for (let count = 0; count < 24; count += 1) {
      const result = yield* admitOneCodeGraphVectorRetirement(sql);
      states.push(result.state);
      if (result.state === 'wrapped') return states;
    }
    return yield* Effect.die(new Error('Vector retirement admission did not wrap cleanly.'));
  });

const step = {
  generation: 'target',
  ownerToken: 'owner',
  expectedCursor: null,
  expectedOffset: 0,
  nextCursor: 'b',
  nextOffset: 2,
  embedded: 2,
  reused: 0,
  rows: [
    ['target', 'a', 'fingerprint-a', new Uint8Array([1])],
    ['target', 'b', 'fingerprint-b', new Uint8Array([2])],
  ] as const,
};

describe('durable vector generation checkpoints', () => {
  effectIt.layer(BunServices.layer)(it => {
    for (const operation of ['replace', 'delete'] as const) {
      it.effect(`allows final pointer ${operation} while another generation pins its old payload`, () =>
        Effect.gen(function* () {
          const {sql, insert} = yield* retirementFixture;
          if (operation === 'replace') {
            yield* insert('g2', 'building');
            yield* claimCodeGraphGeneration(sql, {
              generation: 'g2',
              ownerToken: 'newer',
              requestEpoch: 'epoch-g2',
              reusableGeneration: 'g0',
            });
            yield* commitCodeGraphGenerationStep(sql, {
              generation: 'g2',
              ownerToken: 'newer',
              expectedCursor: null,
              expectedOffset: 0,
              nextCursor: 'new-symbol',
              nextOffset: 1,
              embedded: 1,
              reused: 0,
              rows: [['g2', 'new-symbol', 'new-fingerprint', new Uint8Array([9])]],
            });
            yield* completeCodeGraphGeneration(sql, 'g2', 'newer');
            yield* releaseCodeGraphGenerationClaim(sql, 'g2', 'newer');
            yield* sql.unsafe("UPDATE vector_pointers SET generation = 'g2'");
            expect(yield* sql.unsafe('SELECT generation FROM vector_pointers')).toEqual([{generation: 'g2'}]);
          } else {
            yield* deleteCodeGraphVectorPointerWithRetirementSql(sql, {
              worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
              expectedSnapshotId: 'snapshot-g0',
            });
            expect(yield* sql.unsafe('SELECT generation FROM vector_pointers')).toEqual([]);
            expect(
              yield* sql.unsafe(
                'SELECT pointer_delete_worktree_id, pointer_delete_generation, pointer_delete_snapshot_id FROM vector_retirement_state',
              ),
            ).toEqual([
              {pointer_delete_worktree_id: null, pointer_delete_generation: null, pointer_delete_snapshot_id: null},
            ]);
          }
          expect(yield* sql.unsafe("SELECT hex(vector) AS payload FROM vectors WHERE generation = 'g0'")).toEqual([
            {payload: '07'},
          ]);
          expect(
            yield* sql.unsafe("SELECT generation FROM vector_generation_retirements WHERE generation = 'g0'"),
          ).toEqual([]);
          yield* releaseCodeGraphGenerationClaim(sql, 'g1', 'stalled');
          for (let count = 0; count < 6; count += 1) yield* admitOneCodeGraphVectorRetirement(sql);
          expect(
            yield* sql.unsafe("SELECT generation FROM vector_generation_retirements WHERE generation = 'g0'"),
          ).toEqual([{generation: 'g0'}]);
        }).pipe(TestClock.withLive),
      );
    }
    for (const expiry of ['live', 'expired'] as const) {
      it.effect(
        `reopens a wrapped admission scan with ${expiry} progress without changing its generation revision`,
        () =>
          Effect.gen(function* () {
            const {sql} = yield* retirementFixture;
            // An expired claim keeps an unfinished generation through its grace period; that grace ends here.
            const expires = (yield* Clock.currentTimeMillis) + 500;
            if (expiry === 'expired')
              yield* sql.unsafe("UPDATE vector_generation_progress SET expires_at = ? WHERE generation = 'g1'", [
                expires - CODE_GRAPH_VECTOR_BUILDING_GRACE_MILLISECONDS,
              ]);
            expect(yield* admitOneCodeGraphVectorRetirement(sql)).toMatchObject({state: 'advanced', generation: 'g0'});
            expect(yield* admitOneCodeGraphVectorRetirement(sql)).toMatchObject({state: 'advanced', generation: 'g1'});
            expect(yield* admitOneCodeGraphVectorRetirement(sql)).toEqual({state: 'wrapped'});
            const [wrapped] = yield* sql.unsafe<{generation_revision: number; clean_generation_revision: number}>(
              'SELECT generation_revision, clean_generation_revision FROM vector_retirement_state',
            );
            expect(wrapped.clean_generation_revision).toBe(wrapped.generation_revision);
            if (expiry === 'expired') yield* Effect.sleep(Math.max(0, expires - (yield* Clock.currentTimeMillis)) + 20);
            expect(yield* sql.unsafe('SELECT generation_revision FROM vector_retirement_state')).toEqual([
              {generation_revision: wrapped.generation_revision},
            ]);
            expect(yield* admitOneCodeGraphVectorRetirement(sql)).toMatchObject({state: 'advanced', generation: 'g0'});
            const next = yield* admitOneCodeGraphVectorRetirement(sql);
            expect(next).toMatchObject({state: expiry === 'expired' ? 'admitted' : 'advanced', generation: 'g1'});
            expect(yield* admitOneCodeGraphVectorRetirement(sql)).toEqual({state: 'wrapped'});
          }).pipe(TestClock.withLive),
      );
    }
    it.effect('clears a retired pin so a fresh owner can claim the unfinished generation again', () =>
      Effect.gen(function* () {
        const {sql} = yield* retirementFixture;
        yield* releaseCodeGraphGenerationClaim(sql, 'g1', 'stalled');
        yield* deleteCodeGraphVectorPointerWithRetirementSql(sql, {
          worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
          expectedSnapshotId: 'snapshot-g0',
        });
        expect(yield* retired(sql)).toEqual(['g0']);
        expect(
          yield* claimCodeGraphGeneration(sql, {generation: 'g1', ownerToken: 'fresh', requestEpoch: 'epoch-g1'}),
        ).toMatchObject({owner_token: 'fresh', reusable_generation: null});
        yield* requireCodeGraphGenerationClaim(sql, 'g1', 'fresh');
      }).pipe(TestClock.withLive),
    );
    it.effect('prefers a released unfinished predecessor over a newer one with its own live claim', () =>
      Effect.gen(function* () {
        const {sql, insert} = yield* retirementFixture;
        const select = selectCodeGraphPredecessorGeneration(sql, {
          modelId: 'model',
          modelSha256: Effect2.pipe('a', EffectString.repeat(64)),
          dimensions: 1,
          templateVersion: 1,
        });
        yield* releaseCodeGraphGenerationClaim(sql, 'g1', 'stalled');
        yield* insert('g2', 'building');
        yield* claimCodeGraphGeneration(sql, {generation: 'g2', ownerToken: 'live', requestEpoch: 'epoch-g2'});
        expect(yield* select).toBe('g1');
        yield* releaseCodeGraphGenerationClaim(sql, 'g2', 'live');
        expect(yield* select).toBe('g2');
      }).pipe(TestClock.withLive),
    );
    it.effect('keeps a pinned unfinished predecessor while the successor claim is live', () =>
      Effect.gen(function* () {
        const {sql, insert} = yield* retirementFixture;
        yield* releaseCodeGraphGenerationClaim(sql, 'g1', 'stalled');
        yield* insert('g2', 'building');
        expect(
          yield* claimCodeGraphGeneration(sql, {
            generation: 'g2',
            ownerToken: 'successor',
            requestEpoch: 'epoch-g2',
            reusableGeneration: 'g1',
          }),
        ).toMatchObject({reusable_generation: 'g1'});
        expect(
          yield* claimCodeGraphGeneration(sql, {
            generation: 'g2',
            ownerToken: 'successor',
            requestEpoch: 'epoch-g2',
            reusableGeneration: 'g2',
          }),
        ).toBeUndefined();
        yield* admitUntilClean(sql);
        expect(yield* retired(sql)).toEqual([]);
        yield* releaseCodeGraphGenerationClaim(sql, 'g2', 'successor');
        yield* admitUntilClean(sql);
        expect(yield* retired(sql)).toEqual(['g1', 'g2']);
      }).pipe(TestClock.withLive),
    );
    it.effect('keeps an unfinished generation through its creation and claim-expiry grace periods', () =>
      Effect.gen(function* () {
        const {sql, insert} = yield* retirementFixture;
        yield* releaseCodeGraphGenerationClaim(sql, 'g1', 'stalled');
        yield* insert('g2', 'building', DateTime.formatIso(yield* DateTime.now));
        yield* insert('g3', 'building');
        yield* claimCodeGraphGeneration(sql, {generation: 'g3', ownerToken: 'lapsed', requestEpoch: 'epoch-g3'});
        const now = yield* Clock.currentTimeMillis;
        yield* sql.unsafe("UPDATE vector_generation_progress SET expires_at = ? WHERE generation = 'g3'", [now - 1000]);
        yield* admitUntilClean(sql);
        expect(yield* retired(sql)).toEqual(['g1']);
        yield* sql.unsafe("UPDATE vector_generation_progress SET expires_at = ? WHERE generation = 'g3'", [
          now - CODE_GRAPH_VECTOR_BUILDING_GRACE_MILLISECONDS - 1000,
        ]);
        yield* admitUntilClean(sql);
        expect(yield* retired(sql)).toEqual(['g1', 'g3']);
      }).pipe(TestClock.withLive),
    );
    it.effect(
      'admits an abandoned generation while checkpoints change the revision and claims clean only after a stable pass',
      () =>
        Effect.gen(function* () {
          const {sql, insert} = yield* retirementFixture;
          yield* releaseCodeGraphGenerationClaim(sql, 'g1', 'stalled');
          yield* insert('g2', 'building');
          yield* claimCodeGraphGeneration(sql, {generation: 'g2', ownerToken: 'worker', requestEpoch: 'epoch-g2'});
          const state = () =>
            Effect.map(
              sql.unsafe<{readonly generation_revision: number; readonly clean_generation_revision: number | null}>(
                'SELECT generation_revision, clean_generation_revision FROM vector_retirement_state',
              ),
              rows => rows[0],
            );
          expect(yield* admitOneCodeGraphVectorRetirement(sql)).toMatchObject({state: 'advanced', generation: 'g0'});
          // Each embedding checkpoint renews the claim, and each renewal bumps generation_revision.
          yield* renewCodeGraphGenerationClaim(sql, 'g2', 'worker');
          expect(yield* admitOneCodeGraphVectorRetirement(sql)).toMatchObject({state: 'admitted', generation: 'g1'});
          yield* renewCodeGraphGenerationClaim(sql, 'g2', 'worker');
          expect(yield* admitOneCodeGraphVectorRetirement(sql)).toMatchObject({state: 'advanced', generation: 'g2'});
          expect(yield* admitOneCodeGraphVectorRetirement(sql)).toEqual({state: 'restarted'});
          expect((yield* state()).clean_generation_revision).toBeNull();
          expect(yield* retired(sql)).toEqual(['g1']);
          expect(yield* admitUntilClean(sql)).toEqual(['advanced', 'admitted', 'advanced', 'wrapped']);
          const clean = yield* state();
          expect(clean.clean_generation_revision).toBe(clean.generation_revision);
        }).pipe(TestClock.withLive),
    );
    it.effect('rolls back payload and cursor together, resumes, and treats acknowledged replay as idempotent', () =>
      Effect.gen(function* () {
        const sql = yield* fixture;
        yield* claimCodeGraphGeneration(sql, {generation: 'target', ownerToken: 'owner', requestEpoch: 'epoch'});
        yield* sql.unsafe(
          "CREATE TRIGGER injected_crash BEFORE UPDATE OF cursor ON vector_generation_progress BEGIN SELECT RAISE(ABORT, 'injected crash'); END",
        );
        expect((yield* commitCodeGraphGenerationStep(sql, step).pipe(Effect.result))._tag).toBe('Failure');
        expect(yield* sql.unsafe('SELECT symbol_id FROM vectors')).toEqual([]);
        expect(yield* readCodeGraphGenerationProgress(sql, 'target')).toMatchObject({
          cursor: null,
          array_offset: 0,
          embedded: 0,
        });
        yield* sql.unsafe('DROP TRIGGER injected_crash');
        yield* commitCodeGraphGenerationStep(sql, step);
        yield* commitCodeGraphGenerationStep(sql, step);
        expect(yield* readCodeGraphGenerationProgress(sql, 'target')).toMatchObject({
          cursor: 'b',
          array_offset: 2,
          embedded: 2,
        });
        expect(yield* completeCodeGraphGeneration(sql, 'target', 'owner')).toBe(2);
        expect(yield* sql.unsafe('SELECT state, count FROM vector_generations')).toEqual([{state: 'ready', count: 2}]);
        expect(
          (yield* commitCodeGraphGenerationStep(sql, {
            ...step,
            expectedCursor: 'b',
            expectedOffset: 2,
            nextCursor: 'c',
            nextOffset: 3,
          }).pipe(Effect.result))._tag,
        ).toBe('Failure');
      }),
    );
    it.effect('rejects expired owners and preserves the durable checkpoint when another owner resumes', () =>
      Effect.gen(function* () {
        const sql = yield* fixture;
        yield* claimCodeGraphGeneration(sql, {generation: 'target', ownerToken: 'owner', requestEpoch: 'epoch'});
        yield* commitCodeGraphGenerationStep(sql, step);
        expect(
          yield* claimCodeGraphGeneration(sql, {generation: 'target', ownerToken: 'other', requestEpoch: 'epoch'}),
        ).toBeUndefined();
        yield* TestClock.adjust(CODE_GRAPH_GENERATION_LEASE_MILLISECONDS);
        expect((yield* requireCodeGraphGenerationClaim(sql, 'target', 'owner').pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        expect(
          yield* claimCodeGraphGeneration(sql, {generation: 'target', ownerToken: 'other', requestEpoch: 'epoch'}),
        ).toMatchObject({owner_token: 'other', cursor: 'b', array_offset: 2});
        expect((yield* commitCodeGraphGenerationStep(sql, step).pipe(Effect.result))._tag).toBe('Failure');
        expect(yield* completeCodeGraphGeneration(sql, 'target', 'other')).toBe(2);
      }),
    );
    it.effect('rejects oversized work without changing the checkpoint', () =>
      Effect.gen(function* () {
        const sql = yield* fixture;
        yield* claimCodeGraphGeneration(sql, {generation: 'target', ownerToken: 'owner', requestEpoch: 'epoch'});
        expect((yield* commitCodeGraphGenerationStep(sql, {...step, nextOffset: 401}).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        expect(yield* readCodeGraphGenerationProgress(sql, 'target')).toMatchObject({array_offset: 0});
        expect(yield* sql.unsafe('SELECT symbol_id FROM vectors')).toEqual([]);
      }),
    );
  });
});
