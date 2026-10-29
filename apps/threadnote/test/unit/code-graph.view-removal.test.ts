import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {legacyCodeGraphAuthorityStatements} from '@threadnote/graph/test/helpers/code-graph-legacy-authority';
import {mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {createHash} from '@threadnote/testing/node-crypto';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Option, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect} from 'vitest';
import {withCodeGraphTargetWorktreeLock} from '@threadnote/graph/maintenance/gate';
import {CodeGraphStore} from '@threadnote/graph/store';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CodeGraphStoreBusyError, CodeGraphStoreError} from '@threadnote/graph/types';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const temporaryRoots: string[] = [];

function snapshotId(label: string): string {
  return `cgsn_${createHash('sha1').update(label).digest('hex')}`;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('code graph view removal core', () => {
  effectIt.effect('returns not-found without recreating a missing checkout database', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-view-missing-'));
        temporaryRoots.push(root);
        const databasePath = join(
          root,
          'indexes',
          'code-graph',
          'repositories',
          Effect2.pipe('a', EffectString.repeat(64)),
          'graph-v3.sqlite',
        );
        const store = yield* CodeGraphStore;
        const result = yield* store.removeView(
          databasePath,
          Effect2.pipe('1', EffectString.repeat(64)),
          snapshotId('missing'),
        );
        expect(result).toEqual({expectedSnapshotId: snapshotId('missing'), state: 'not-found'});
        expect(yield* Effect.promise(() => Bun.file(databasePath).exists())).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('adds durable non-cascading removal evidence without replacing v3 data', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* viewFixture('threadnote-view-schema-');
        yield* Effect.sync(() => {
          const before = new Database(fixture.databasePath);
          before.transaction(() => {
            for (const statement of legacyCodeGraphAuthorityStatements) before.exec(statement);
          })();
          before.exec(`
            DROP TRIGGER removed_views_cleanup_revoke_delete;
            DROP TRIGGER removed_views_cleanup_revoke_insert;
            DROP TRIGGER removed_views_cleanup_revoke_update;
            DROP TABLE removed_view_cleanup;
            DROP TABLE removed_views;
          `);
          before.run("DELETE FROM schema_metadata WHERE key = 'removed_view_cleanup_epoch_sequence'");
          before.run("UPDATE schema_metadata SET value = '7' WHERE key = 'persistent_extension_schema_revision'");
          before.run("INSERT INTO schema_metadata (key, value) VALUES ('view_fixture_marker', 'preserve-me')");
          before.close(false);
        });
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
        yield* Effect.sync(() => {
          const after = new Database(fixture.databasePath, {readonly: true, strict: true});
          try {
            expect(after.query("SELECT value FROM schema_metadata WHERE key = 'view_fixture_marker'").get()).toEqual({
              value: 'preserve-me',
            });
            expect(
              after.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'removed_views'").get(),
            ).toEqual({name: 'removed_views'});
            expect(after.query("SELECT COUNT(*) AS count FROM pragma_foreign_key_list('removed_views')").get()).toEqual(
              {
                count: 0,
              },
            );
          } finally {
            after.close(false);
          }
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('performs an exact idempotent CAS and preserves stale or missing targets without mutation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* viewFixture('threadnote-view-cas-');
        seedGraph(
          fixture,
          [{id: snapshotId('current'), worktreeId: fixture.worktrees[0]}],
          [{snapshotId: snapshotId('current'), worktreeId: fixture.worktrees[0]}],
        );
        const store = yield* CodeGraphStore;
        const retryOptions = {waitTimeoutMilliseconds: 5_000} as const;
        const staleActive = yield* store.removeView(
          fixture.databasePath,
          fixture.worktrees[0],
          snapshotId('other'),
          retryOptions,
        );
        const removed = yield* store.removeView(
          fixture.databasePath,
          fixture.worktrees[0],
          snapshotId('current'),
          retryOptions,
        );
        const retry = yield* store.removeView(
          fixture.databasePath,
          fixture.worktrees[0],
          snapshotId('current'),
          retryOptions,
        );
        const staleRemoved = yield* store.removeView(
          fixture.databasePath,
          fixture.worktrees[0],
          snapshotId('other'),
          retryOptions,
        );
        const missing = yield* store.removeView(
          fixture.databasePath,
          fixture.worktrees[1],
          snapshotId('current'),
          retryOptions,
        );
        const observed = {missing, removed, retry, staleActive, staleRemoved};

        expect(observed.staleActive).toEqual({
          expectedSnapshotId: snapshotId('other'),
          observedSnapshotId: snapshotId('current'),
          observedState: 'active',
          state: 'stale-target',
        });
        expect(observed.removed).toEqual({
          expectedSnapshotId: snapshotId('current'),
          retiredSnapshots: 1,
          state: 'removed',
        });
        expect(observed.retry).toEqual({
          expectedSnapshotId: snapshotId('current'),
          retiredSnapshots: 0,
          state: 'already-removed',
        });
        expect(observed.staleRemoved).toEqual({
          expectedSnapshotId: snapshotId('other'),
          observedSnapshotId: snapshotId('current'),
          observedState: 'removed',
          state: 'stale-target',
        });
        expect(observed.missing).toEqual({expectedSnapshotId: snapshotId('current'), state: 'not-found'});

        yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath, {readonly: true, strict: true});
          try {
            expect(database.query('SELECT * FROM active_snapshots').all()).toEqual([]);
            expect(database.query('SELECT worktree_id, expected_snapshot_id FROM removed_views').all()).toEqual([
              {expected_snapshot_id: snapshotId('current'), worktree_id: fixture.worktrees[0]},
            ]);
          } finally {
            database.close(false);
          }
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves shared views, readers, recursively required bases, and unrelated dirty history', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* viewFixture('threadnote-view-protection-');
        const [sharedA, dependent, sharedB, target] = fixture.worktrees;
        seedGraph(
          fixture,
          [
            {id: snapshotId('base-root'), worktreeId: target},
            {baseSnapshotId: snapshotId('base-root'), dirty: true, id: snapshotId('base-middle'), worktreeId: target},
            {baseSnapshotId: snapshotId('base-middle'), dirty: true, id: snapshotId('target'), worktreeId: target},
            {baseSnapshotId: snapshotId('target'), dirty: true, id: snapshotId('dependent'), worktreeId: dependent},
            {id: snapshotId('shared'), worktreeId: sharedA},
            {dirty: true, id: snapshotId('unrelated-dirty'), worktreeId: Effect2.pipe('e', EffectString.repeat(64))},
          ],
          [
            {snapshotId: snapshotId('shared'), worktreeId: sharedA},
            {snapshotId: snapshotId('dependent'), worktreeId: dependent},
            {snapshotId: snapshotId('shared'), worktreeId: sharedB},
            {snapshotId: snapshotId('target'), worktreeId: target},
          ],
        );
        const store = yield* CodeGraphStore;
        const targetLease = yield* store.acquireSnapshotLease(fixture.databasePath, snapshotId('target'), 60_000);
        const sharedRemoval = yield* store.removeView(fixture.databasePath, sharedA, snapshotId('shared'));
        const targetRemoval = yield* store.removeView(fixture.databasePath, target, snapshotId('target'));
        const leaseFlag = yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath, {readonly: true, strict: true});
          try {
            return database
              .query<{readonly retire_when_inactive: number}, [string]>(
                'SELECT retire_when_inactive FROM snapshot_leases WHERE token = ?',
              )
              .get(targetLease)?.retire_when_inactive;
          } finally {
            database.close(false);
          }
        });
        yield* store.releaseSnapshotLease(fixture.databasePath, targetLease);
        const protectedSnapshots = yield* Effect.forEach(
          [
            snapshotId('shared'),
            snapshotId('dependent'),
            snapshotId('target'),
            snapshotId('base-middle'),
            snapshotId('base-root'),
            snapshotId('unrelated-dirty'),
          ],
          snapshotId => store.readySnapshotById(fixture.databasePath, snapshotId),
          {concurrency: 1},
        );
        expect(sharedRemoval).toEqual({
          expectedSnapshotId: snapshotId('shared'),
          retiredSnapshots: 0,
          state: 'removed',
        });
        expect(targetRemoval).toEqual({
          expectedSnapshotId: snapshotId('target'),
          retiredSnapshots: 0,
          state: 'removed',
        });
        expect(leaseFlag).toBe(1);
        expect(EffectArray.map(protectedSnapshots, snapshot => snapshot?.id)).toEqual([
          snapshotId('shared'),
          snapshotId('dependent'),
          snapshotId('target'),
          snapshotId('base-middle'),
          snapshotId('base-root'),
          snapshotId('unrelated-dirty'),
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('never resurrects builder history and suppresses only the same tombstoned pointer', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* viewFixture('threadnote-view-catalog-');
        const worktreeId = fixture.worktrees[0];
        seedGraph(
          fixture,
          [
            {id: snapshotId('original'), worktreeId},
            {id: snapshotId('new'), worktreeId: fixture.worktrees[1]},
            {id: snapshotId('builder-cache'), worktreeId: fixture.worktrees[2]},
          ],
          [{snapshotId: snapshotId('original'), worktreeId}],
        );
        const store = yield* CodeGraphStore;
        const lease = yield* store.acquireSnapshotLease(fixture.databasePath, snapshotId('original'), 60_000);
        const newLease = yield* store.acquireSnapshotLease(fixture.databasePath, snapshotId('new'), 60_000);
        yield* store.removeView(fixture.databasePath, worktreeId, snapshotId('original'));
        legacyPromote(fixture.databasePath, worktreeId, snapshotId('original'));
        const sameReady = yield* store.readySnapshot(fixture.databasePath, worktreeId);
        const sameCatalogs = yield* store.loadVisualizationCatalogs(fixture.databasePath, 'deferred');
        const sameCatalog = yield* store.loadVisualizationCatalog(fixture.databasePath, 'deferred');
        const builderCatalog = yield* store.loadVisualizationCatalog(fixture.databasePath, 'deferred', {
          snapshotId: Option.some(snapshotId('builder-cache')),
        });
        const reconciledRetry = yield* store.removeView(fixture.databasePath, worktreeId, snapshotId('original'));

        legacyPromote(fixture.databasePath, worktreeId, snapshotId('new'));
        const differentReady = yield* store.readySnapshot(fixture.databasePath, worktreeId);
        const differentCatalogs = yield* store.loadVisualizationCatalogs(fixture.databasePath, 'deferred');
        const tombstoneBeforeCurrentPromotion = removedView(fixture.databasePath, worktreeId);
        yield* store.promote(fixture.databasePath, identityFor(fixture, worktreeId), snapshotId('new'));
        const tombstoneAfterCurrentPromotion = removedView(fixture.databasePath, worktreeId);
        yield* store.releaseSnapshotLease(fixture.databasePath, lease);
        yield* store.releaseSnapshotLease(fixture.databasePath, newLease);
        expect(sameReady).toBeUndefined();
        expect(sameCatalogs).toEqual([]);
        expect(sameCatalog).toBeUndefined();
        expect(builderCatalog).toBeUndefined();
        expect(reconciledRetry).toEqual({
          expectedSnapshotId: snapshotId('original'),
          retiredSnapshots: 0,
          state: 'already-removed',
        });
        expect(differentReady?.id).toBe(snapshotId('new'));
        expect(EffectArray.map(differentCatalogs, catalog => [catalog.viewWorktreeId, catalog.snapshot.id])).toEqual([
          [worktreeId, snapshotId('new')],
        ]);
        expect(tombstoneBeforeCurrentPromotion).toBe(snapshotId('original'));
        expect(tombstoneAfterCurrentPromotion).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('serializes bounded concurrent retries without losing removal evidence', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* viewFixture('threadnote-view-load-');
        const worktreeId = fixture.worktrees[0];
        seedGraph(fixture, [{id: snapshotId('load'), worktreeId}], [{snapshotId: snapshotId('load'), worktreeId}]);
        const store = yield* CodeGraphStore;
        yield* store.acquireSnapshotLease(fixture.databasePath, snapshotId('load'), 60_000);
        const results = yield* Effect.all(
          Array.from({length: 16}, () =>
            store.removeView(fixture.databasePath, worktreeId, snapshotId('load'), {waitTimeoutMilliseconds: 5_000}),
          ),
          {concurrency: 'unbounded'},
        );
        expect(EffectArray.filter(results, result => result.state === 'removed')).toHaveLength(1);
        expect(EffectArray.filter(results, result => result.state === 'already-removed')).toHaveLength(15);
        expect(removedView(fixture.databasePath, worktreeId)).toBe(snapshotId('load'));
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails fast and path-free on held writer or target-worktree locks without running the mutation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* viewFixture('threadnote-view-busy-');
        const worktreeId = fixture.worktrees[0];
        seedGraph(fixture, [{id: snapshotId('busy'), worktreeId}], [{snapshotId: snapshotId('busy'), worktreeId}]);
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writerOwner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            fixture.writerLockPath,
            lockOptions(() => Deferred.succeed(writerAcquired, undefined).pipe(Effect.asVoid)),
            Deferred.await(releaseWriter),
          ),
        );
        yield* Deferred.await(writerAcquired);
        const writerStartedAt = performance.now();
        const writerResult = yield* store.removeView(fixture.databasePath, worktreeId, snapshotId('busy')).pipe(
          Effect.match({
            onFailure: error => ({error, success: false as const}),
            onSuccess: result => ({result, success: true as const}),
          }),
        );
        const writerElapsedMilliseconds = performance.now() - writerStartedAt;
        yield* Deferred.succeed(releaseWriter, undefined);
        yield* Fiber.join(writerOwner);

        const targetAcquired = yield* Deferred.make<void>();
        const releaseTarget = yield* Deferred.make<void>();
        const targetOwner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            fixture.worktreeLockPath,
            lockOptions(() => Deferred.succeed(targetAcquired, undefined).pipe(Effect.asVoid)),
            Deferred.await(releaseTarget),
          ),
        );
        yield* Deferred.await(targetAcquired);
        const calls = yield* Ref.make(0);
        const targetStartedAt = performance.now();
        const targetResult = yield* withCodeGraphTargetWorktreeLock(
          fixture.root,
          fixture.checkoutId,
          worktreeId,
          Ref.update(calls, count => count + 1),
        ).pipe(
          Effect.match({
            onFailure: error => ({error, success: false as const}),
            onSuccess: result => ({result, success: true as const}),
          }),
        );
        const targetElapsedMilliseconds = performance.now() - targetStartedAt;
        yield* Deferred.succeed(releaseTarget, undefined);
        yield* Fiber.join(targetOwner);
        const observed = {
          calls: yield* Ref.get(calls),
          targetElapsedMilliseconds,
          targetResult,
          writerElapsedMilliseconds,
          writerResult,
        };

        expect(observed.writerResult.success).toBe(false);
        expect(observed.targetResult.success).toBe(false);
        if (!observed.writerResult.success) {
          expect(observed.writerResult.error).toBeInstanceOf(CodeGraphStoreBusyError);
          expect(observed.writerResult.error.message).not.toContain(fixture.root);
        }
        if (!observed.targetResult.success) {
          expect(observed.targetResult.error).toBeInstanceOf(CodeGraphStoreBusyError);
          expect(String(observed.targetResult.error)).not.toContain(fixture.root);
        }
        expect(observed.writerElapsedMilliseconds).toBeLessThan(500);
        expect(observed.targetElapsedMilliseconds).toBeLessThan(500);
        expect(observed.calls).toBe(0);
        expect(activeView(fixture.databasePath, worktreeId)).toBe(snapshotId('busy'));
        expect(removedView(fixture.databasePath, worktreeId)).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('classifies target-lock filesystem failures without exposing the lock root', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-view-lock-error-'));
        temporaryRoots.push(root);
        writeFileSync(join(root, 'locks'), 'not-a-directory\n');
        const observed = yield* withCodeGraphTargetWorktreeLock(
          root,
          Effect2.pipe('a', EffectString.repeat(64)),
          Effect2.pipe('1', EffectString.repeat(64)),
          Effect.void,
        ).pipe(
          Effect.match({
            onFailure: error => ({error, success: false as const}),
            onSuccess: () => ({success: true as const}),
          }),
        );
        expect(observed.success).toBe(false);
        if (!observed.success) {
          expect(observed.error).toBeInstanceOf(CodeGraphStoreError);
          expect(observed.error).not.toBeInstanceOf(CodeGraphStoreBusyError);
          expect(observed.error.operation).toBe('mutate graph view');
          expect(observed.error.message).not.toContain(root);
          expect(String(observed.error)).not.toContain(root);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

interface SeedSnapshot {
  readonly baseSnapshotId?: string;
  readonly dirty?: boolean;
  readonly id: string;
  readonly worktreeId: string;
}

interface SeedView {
  readonly snapshotId: string;
  readonly worktreeId: string;
}

interface ViewFixture {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly repositoryId: string;
  readonly root: string;
  readonly worktreeLockPath: string;
  readonly worktrees: readonly string[];
  readonly writerLockPath: string;
}

function viewFixture(prefix: string) {
  return Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), prefix));
    temporaryRoots.push(root);
    const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
    const worktrees = EffectArray.map(['1', '2', '3', '4'], digit => Effect2.pipe(digit, EffectString.repeat(64)));
    const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
    const store = yield* CodeGraphStore;
    yield* store.initialize(databasePath);
    return {
      checkoutId,
      databasePath,
      repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
      root,
      worktreeLockPath: join(root, 'locks', 'indexes', 'code-graph', 'worktrees', checkoutId, `${worktrees[0]}.lock`),
      worktrees,
      writerLockPath: join(root, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`),
    } satisfies ViewFixture;
  });
}

function seedGraph(fixture: ViewFixture, snapshots: readonly SeedSnapshot[], views: readonly SeedView[]): void {
  const database = new Database(fixture.databasePath, {strict: true});
  try {
    database.run(
      `INSERT OR IGNORE INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES (?, ?, 'sha1', ?, ?)`,
      [fixture.repositoryId, 'threadnote/view-removal-fixture', new Date(0).toISOString(), new Date(0).toISOString()],
    );
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, ?, 'view-removal-test', ?, ?, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    const insertView = database.prepare(
      'INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)',
    );
    database.transaction(() => {
      for (const [index, snapshot] of snapshots.entries()) {
        insertSnapshot.run(
          snapshot.id,
          fixture.repositoryId,
          snapshot.worktreeId,
          Effect2.pipe(`${index}`, EffectString.padStart(40, '0')),
          `content-${snapshot.id}`,
          snapshot.baseSnapshotId ?? null,
          snapshot.dirty ? 1 : 0,
          snapshot.dirty ? `overlay-${snapshot.id}` : null,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        insertGeneration.run(snapshot.id, CODE_GRAPH_EXTRACTOR_GENERATION);
      }
      for (const [index, view] of views.entries()) {
        insertView.run(view.worktreeId, view.snapshotId, new Date(index + 10).toISOString());
      }
    })();
  } finally {
    database.close(false);
  }
}

function legacyPromote(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(worktree_id, scope_id) DO UPDATE SET
           snapshot_id = excluded.snapshot_id,
           activated_at = excluded.activated_at`,
      )
      .run(worktreeId, snapshotId, new Date().toISOString());
  } finally {
    database.close(false);
  }
}

function activeView(databasePath: string, worktreeId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly snapshot_id: string}, [string]>('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?')
      .get(worktreeId)?.snapshot_id;
  } finally {
    database.close(false);
  }
}

function removedView(databasePath: string, worktreeId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly expected_snapshot_id: string}, [string]>(
        'SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ?',
      )
      .get(worktreeId)?.expected_snapshot_id;
  } finally {
    database.close(false);
  }
}

function identityFor(fixture: ViewFixture, worktreeId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: fixture.checkoutId,
    displayName: 'threadnote/view-removal-fixture',
    gitCommonDirectory: fixture.root,
    headCommit: Effect2.pipe('f', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repositoryId: fixture.repositoryId,
    repoRoot: fixture.root,
    worktreeId,
  };
}

function lockOptions(onAcquired: () => Effect.Effect<void, never>) {
  return {
    onAcquired,
    retryIntervalMilliseconds: 5,
    staleAfterMilliseconds: 120_000,
    waitTimeoutMilliseconds: 5_000,
  } as const;
}
