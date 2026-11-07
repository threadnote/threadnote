import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import * as EffectString from 'effect/String';
import * as SqlClient from 'effect/sql/SqlClient';
import {expect} from 'vitest';
import {codeGraphLayout} from '../../src/layout.js';
import {CodeGraphStore} from '../../src/store.js';
import type {CodeGraphSnapshot, RepositoryIdentity} from '../../src/types.js';
import {
  acknowledgeCodeGraphEmbeddingDemand,
  claimCodeGraphEmbeddingDemand,
  readCodeGraphEmbeddingDemandPage,
  validateCodeGraphEmbeddingDemandClaim,
} from '../../src/vector/demand.js';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const dependencies = CodeGraphStore.layer.pipe(Layer.provideMerge(citationPlatformLayer));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-promotion-demand-'});
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: EffectString.repeat(64)('d'),
    displayName: 'fixture',
    gitCommonDirectory: path.join(home, '.git'),
    headCommit: EffectString.repeat(40)('b'),
    objectFormat: 'sha1',
    repoRoot: home,
    repositoryId: EffectString.repeat(64)('a'),
    worktreeId: EffectString.repeat(64)('c'),
  };
  const snapshot: CodeGraphSnapshot = {
    id: 'cgsn_' + EffectString.repeat(40)('e'),
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    commit: identity.headCommit,
    extractorSet: 'fixture',
    dirty: false,
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
    state: 'ready',
    completedAt: '2026-11-01T00:00:00.000Z',
  };
  const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
  yield* store.activate(layout.databasePath, identity, snapshot, [], [], [], []);
  yield* store.promote(layout.databasePath, identity, snapshot.id, {backgroundEmbeddingDemand: true});
  const now = yield* Clock.currentTimeMillis;
  const claim = yield* store.withSession(
    layout.databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* claimCodeGraphEmbeddingDemand(sql, {
        worktreeId: identity.worktreeId,
        now,
        owner: {token: 'independent-normal-job', processId: 123, processStartIdentity: 'instance'},
        model: {id: 'test', sha256: EffectString.repeat(64)('f'), dimensions: 2, templateVersion: 1},
      });
    }),
  );
  if (!claim) throw new Error('Expected independent embedding claim');
  const observe = store.withSession(
    layout.databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        active: yield* sql.unsafe<{readonly activated_at: string}>('SELECT * FROM active_snapshots'),
        demand: yield* readCodeGraphEmbeddingDemandPage(sql),
        claimValid: yield* validateCodeGraphEmbeddingDemandClaim(sql, claim, now + 1),
      };
    }),
    {readOnly: true},
  );
  return {store, layout, identity, snapshot, claim, now, observe};
});

effectIt.layer(dependencies)(it => {
  it.effect.prop(
    'repeated structural or background promotion preserves the exact active embedding claim',
    {background: Schema.Array(Schema.Boolean).check(Schema.isMaxLength(6))},
    ({background}) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const before = yield* f.observe;
        // A structural builder may have missed the ready view before this normal publisher won.
        yield* f.store.promote(f.layout.databasePath, f.identity, f.snapshot.id);
        for (const backgroundEmbeddingDemand of background)
          yield* f.store.promote(
            f.layout.databasePath,
            f.identity,
            f.snapshot.id,
            backgroundEmbeddingDemand ? {backgroundEmbeddingDemand: true} : undefined,
          );
        expect(yield* f.observe).toEqual(before);
        expect(before.claimValid).toBe(true);
        const completed = yield* f.store.withSession(
          f.layout.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* acknowledgeCodeGraphEmbeddingDemand(sql, f.claim, {kind: 'finish', now: f.now + 1});
          }),
        );
        expect(completed?.state).toBe('ready');
        expect(completed?.active).toBeUndefined();
      }).pipe(TestClock.withLive),
    {arbitrary: {runs: 8, seed: 90124}},
  );

  it.effect('reattaching a removed view still advances its activation and fences the prior claim', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.store.withSession(
        f.layout.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe('INSERT INTO removed_views VALUES (?, ?, ?, ?)', [
            f.identity.worktreeId,
            f.claim.scopeId,
            f.snapshot.id,
            DateTime.formatIso(
              DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.makeUnsafe(f.claim.activatedAt)) + 1),
            ),
          ]);
        }),
      );
      yield* f.store.promote(f.layout.databasePath, f.identity, f.snapshot.id);
      const after = yield* f.observe;
      expect(after.claimValid).toBe(false);
      expect(Date.parse(String(after.active[0]?.activated_at))).toBeGreaterThan(Date.parse(f.claim.activatedAt));
    }).pipe(TestClock.withLive),
  );
});
