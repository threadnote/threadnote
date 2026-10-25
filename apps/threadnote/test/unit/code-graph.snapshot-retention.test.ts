import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database} from 'bun:sqlite';
import {createHash} from '@threadnote/testing/node-crypto';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeGraphStore, type CodeGraphStoreShape} from '@threadnote/graph/store';
import {CodeGraphStoreBusyError, type CodeGraphSnapshot, type RepositoryIdentity} from '@threadnote/graph/types';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
});

describe('code graph ready snapshot retention', () => {
  effectIt.effect('keeps every sibling view and its graph rows during concurrent promotion load', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp('threadnote-ready-retention-many-worktrees-'));
        temporaryRoots.push(root);
        const baseIdentity = repositoryIdentity(root);
        const databasePath = join(
          root,
          'indexes',
          'code-graph',
          'repositories',
          baseIdentity.checkoutId,
          'graph-v3.sqlite',
        );
        const fixtures = Array.from({length: 64}, (_, index) => {
          const identity = {...baseIdentity, worktreeId: index.toString(16).padStart(64, '0')};
          return {identity, snapshot: snapshot(identity, `registered-${index}`)};
        });
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.forEach(
          fixtures,
          fixture =>
            registerReadySnapshots(store, databasePath, fixture.identity, [fixture.snapshot]).pipe(
              Effect.andThen(store.promote(databasePath, fixture.identity, fixture.snapshot.id)),
            ),
          {concurrency: 1, discard: true},
        );
        yield* Effect.sync(() => seedSymbol(databasePath, fixtures[0].snapshot.id));
        yield* Effect.forEach(
          Array.from({length: 128}, (_, index) => fixtures[index % fixtures.length]),
          fixture => store.promote(databasePath, fixture.identity, fixture.snapshot.id),
          {concurrency: 8, discard: true},
        );
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            expect(database.query('SELECT COUNT(*) AS count FROM active_snapshots').get()).toEqual({
              count: fixtures.length,
            });
            expect(database.query("SELECT COUNT(*) AS count FROM snapshots WHERE state = 'ready'").get()).toEqual({
              count: fixtures.length,
            });
            expect(
              database
                .query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
                .get(fixtures[0].snapshot.id),
            ).toEqual({count: 1});
            expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
          } finally {
            database.close(false);
          }
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  it('preserves a ready snapshot that was leased by ID without becoming an active worktree view', async () => {
    const root = await mkdtemp('threadnote-ready-retention-non-active-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const exported = snapshot(identity, 'exported-by-id');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [exported]);
        const lease = yield* store.acquireSnapshotLease(databasePath, exported.id, 60_000);
        yield* store.releaseSnapshotLease(databasePath, lease);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(exported.id)).toEqual({state: 'ready'});
      expect(database.query('SELECT COUNT(*) AS count FROM active_snapshots').get()).toEqual({count: 0});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
    } finally {
      database.close(false);
    }
  });

  fcEffectProp(
    effectIt,
    'retains a displaced clean snapshot across lease acquisition order',
    {acquireBeforePromotion: fc.boolean()},
    ({acquireBeforePromotion}) =>
      TestClock.withLive(
        Effect.gen(function* () {
          const root = yield* Effect.promise(() => mkdtemp('threadnote-ready-retention-clean-view-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'graph-v3.sqlite');
          const identity = repositoryIdentity(root);
          const clean = snapshot(identity, 'clean-view', {dirty: false});
          const current = snapshot(identity, 'clean-view-successor');
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          yield* registerReadySnapshots(store, databasePath, identity, [clean, current]);

          const lease = acquireBeforePromotion
            ? yield* store.acquireSnapshotLease(databasePath, clean.id, 60_000)
            : undefined;
          yield* store.promote(databasePath, identity, clean.id);
          const activeLease = lease ?? (yield* store.acquireSnapshotLease(databasePath, clean.id, 60_000));
          yield* store.promote(databasePath, identity, current.id);
          yield* store.releaseSnapshotLease(databasePath, activeLease);

          expect(readSnapshotState(databasePath, clean.id)).toBe('ready');
          expect(readSnapshotState(databasePath, current.id)).toBe('ready');
          expect(readSnapshotLeaseTokens(databasePath)).toEqual([]);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    {fastCheck: {numRuns: 4}},
  );

  effectIt.effect('retires an explicitly removed leased clean view after its final reader releases it', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp('threadnote-ready-retention-removed-clean-view-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'graph-v3.sqlite');
        const identity = {
          ...repositoryIdentity(root),
          repositoryId: 'b'.repeat(64),
          worktreeId: 'a'.repeat(64),
        };
        const clean = snapshot(identity, 'removed-clean-view', {dirty: false});
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [clean]);
        yield* store.promote(databasePath, identity, clean.id);
        const lease = yield* store.acquireSnapshotLease(databasePath, clean.id, 60_000);

        expect(yield* store.removeView(databasePath, identity.worktreeId, clean.id)).toMatchObject({state: 'removed'});
        expect(readSnapshotState(databasePath, clean.id)).toBe('ready');
        yield* store.releaseSnapshotLease(databasePath, lease);
        yield* waitForSnapshotRemoval(databasePath, clean.id);

        expect(readSnapshotState(databasePath, clean.id)).toBeUndefined();
        expect(readSnapshotLeaseTokens(databasePath)).toEqual([]);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  it('reclaims a non-active snapshot after an explicitly transient lease is released', async () => {
    const root = await mkdtemp('threadnote-ready-retention-transient-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const transient = snapshot(identity, 'transient-by-id');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [transient]);
        const lease = yield* store.acquireSnapshotLease(databasePath, transient.id, 60_000, {
          retireWhenInactive: true,
        });
        yield* store.releaseSnapshotLease(databasePath, lease);
        yield* waitForSnapshotRemoval(databasePath, transient.id);
      }),
    );

    expect(readSnapshotState(databasePath, transient.id)).toBeUndefined();
  });

  it('reclaims a superseded snapshot when its last lease is released and preserves the active view and base', async () => {
    const root = await mkdtemp('threadnote-ready-retention-release-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const base = snapshot(identity, 'base', {dirty: false});
    const superseded = snapshot(identity, 'superseded', {baseSnapshotId: base.id});
    const current = snapshot(identity, 'current', {baseSnapshotId: base.id});

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [base, superseded]);
        yield* store.promote(databasePath, identity, superseded.id);
        const lease = yield* store.acquireSnapshotLease(databasePath, superseded.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);
        yield* Effect.sync(() => seedSymbol(databasePath, superseded.id));

        expect(readSnapshotState(databasePath, superseded.id)).toBe('ready');
        yield* store.releaseSnapshotLease(databasePath, lease);
        expect(readSnapshotState(databasePath, superseded.id)).not.toBe('ready');
        yield* waitForSnapshotRemoval(databasePath, superseded.id);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(superseded.id)).toBeNull();
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(base.id)).toEqual({state: 'ready'});
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(current.id)).toEqual({state: 'ready'});
      expect(
        database.query('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?').get(identity.worktreeId),
      ).toEqual({snapshot_id: current.id});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  effectIt.effect('reclaims a superseded leased overlay while retaining its detached base as a warm leaf', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp('threadnote-ready-retention-base-closure-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const base = snapshot(identity, 'detached-base', {dirty: false});
        const superseded = snapshot(identity, 'leased-overlay', {baseSnapshotId: base.id});
        const current = snapshot(identity, 'unrelated-current');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [base, superseded]);
        yield* store.promote(databasePath, identity, superseded.id);
        const lease = yield* store.acquireSnapshotLease(databasePath, superseded.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);

        yield* store.releaseSnapshotLease(databasePath, lease);
        yield* waitForSnapshotRemoval(databasePath, superseded.id);
        expect(readSnapshotState(databasePath, superseded.id)).toBeUndefined();
        expect(readSnapshotState(databasePath, base.id)).toBe('ready');
        expect(readSnapshotState(databasePath, current.id)).toBe('ready');
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('keeps a displaced view until every overlapping lease is released', () =>
    TestClock.withLive(
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp('threadnote-ready-retention-overlapping-leases-')),
        root =>
          Effect.gen(function* () {
            const databasePath = join(root, 'graph-v3.sqlite');
            const identity = repositoryIdentity(root);
            const displaced = snapshot(identity, 'overlap-displaced');
            const current = snapshot(identity, 'overlap-current');
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* registerReadySnapshots(store, databasePath, identity, [displaced]);
            yield* store.promote(databasePath, identity, displaced.id);
            const first = yield* store.acquireSnapshotLease(databasePath, displaced.id, 60_000);
            const second = yield* store.acquireSnapshotLease(databasePath, displaced.id, 60_000);
            yield* registerReadySnapshots(store, databasePath, identity, [current]);
            yield* store.promote(databasePath, identity, current.id);

            yield* store.releaseSnapshotLease(databasePath, first);
            expect(readSnapshotState(databasePath, displaced.id)).toBe('ready');
            yield* store.releaseSnapshotLease(databasePath, second);
            // Lease release deliberately performs one bounded foreground page and
            // leaves physical reclamation resumable. Drive that independent state
            // machine explicitly so this overlap test proves lease authority
            // without racing the opportunistic detached collector's wall clock.
            yield* store.pruneRetiredSnapshots(databasePath);

            expect(readSnapshotState(databasePath, displaced.id)).toBeUndefined();
            expect(readSnapshotState(databasePath, current.id)).toBe('ready');
          }),
        root => Effect.promise(() => rm(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('carries retirement provenance from an expired lease to a renewed overlapping lease', () =>
    TestClock.withLive(
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp('threadnote-ready-retention-renewed-overlap-')),
        root =>
          Effect.gen(function* () {
            const databasePath = join(root, 'graph-v3.sqlite');
            const identity = repositoryIdentity(root);
            const displaced = snapshot(identity, 'renew-displaced');
            const current = snapshot(identity, 'renew-current');
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* registerReadySnapshots(store, databasePath, identity, [displaced]);
            yield* Effect.sync(() => seedSymbol(databasePath, displaced.id));
            yield* store.promote(databasePath, identity, displaced.id);
            const expired = yield* store.acquireSnapshotLease(databasePath, displaced.id, 60_000);
            const renewed = yield* store.acquireSnapshotLease(databasePath, displaced.id, 60_000);
            yield* registerReadySnapshots(store, databasePath, identity, [current]);
            yield* Effect.sync(() => seedSymbol(databasePath, current.id));
            yield* store.promote(databasePath, identity, current.id);
            yield* Effect.sync(() => expireLease(databasePath, expired));

            yield* store.renewSnapshotLease(databasePath, renewed, 60_000);
            expect(readLeaseExpiration(databasePath, expired)).toBeUndefined();
            expect(readLeaseRetirementFlag(databasePath, renewed)).toBe(1);
            yield* store.pruneRetiredSnapshots(databasePath);
            expect(readSnapshotState(databasePath, displaced.id)).toBe('ready');
            expect(readSnapshotSymbolCount(databasePath, displaced.id)).toBe(1);

            yield* store.releaseSnapshotLease(databasePath, renewed);
            expect(['retired', undefined]).toContain(readSnapshotState(databasePath, displaced.id));
            // Physical cleanup is resumable; drive it without a detached-fiber deadline.
            yield* store.pruneRetiredSnapshots(databasePath);
            expect(readSnapshotState(databasePath, displaced.id)).toBeUndefined();
            expect(readSnapshotSymbolCount(databasePath, displaced.id)).toBe(0);
            expect(readSnapshotState(databasePath, current.id)).toBe('ready');
            expect(readSnapshotSymbolCount(databasePath, current.id)).toBe(1);
            expect(readSnapshotLeaseTokens(databasePath)).toEqual([]);
          }),
        root => Effect.promise(() => rm(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  it('retires a lease acquired by ID when that snapshot is later promoted and displaced', async () => {
    const root = await mkdtemp('threadnote-ready-retention-acquire-promote-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const acquired = snapshot(identity, 'acquired-before-promotion');
    const current = snapshot(identity, 'after-acquired-promotion');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [acquired]);
        const lease = yield* store.acquireSnapshotLease(databasePath, acquired.id, 60_000);
        yield* store.promote(databasePath, identity, acquired.id);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);

        yield* store.releaseSnapshotLease(databasePath, lease);
        yield* waitForSnapshotRemoval(databasePath, acquired.id);
      }),
    );

    expect(readSnapshotState(databasePath, acquired.id)).toBeUndefined();
    expect(readSnapshotState(databasePath, current.id)).toBe('ready');
  });

  it('reaps an expired reader lease on the next ordinary acquire', async () => {
    const root = await mkdtemp('threadnote-ready-retention-expired-');
    temporaryRoots.push(root);
    const identity = repositoryIdentity(root);
    const databasePath = join(root, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
    const superseded = snapshot(identity, 'expired-reader');
    const current = snapshot(identity, 'current');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [superseded]);
        yield* store.promote(databasePath, identity, superseded.id);
        const expiredLease = yield* store.acquireSnapshotLease(databasePath, superseded.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);
        yield* Effect.sync(() => expireLease(databasePath, expiredLease));

        const currentLease = yield* store.acquireSnapshotLease(databasePath, current.id, 60_000);
        yield* waitForSnapshotRemoval(databasePath, superseded.id);
        yield* store.releaseSnapshotLease(databasePath, currentLease);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(superseded.id)).toBeNull();
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(current.id)).toEqual({state: 'ready'});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
    } finally {
      database.close(false);
    }
  });

  it('migrates an expired displaced active-view lease from the pre-retention schema', async () => {
    const root = await mkdtemp('threadnote-ready-retention-migration-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const superseded = snapshot(identity, 'legacy-expired-reader');
    const current = snapshot(identity, 'current');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [superseded]);
        yield* store.promote(databasePath, identity, superseded.id);
        const expiredLease = yield* store.acquireSnapshotLease(databasePath, superseded.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);
        yield* Effect.sync(() => {
          expireLease(databasePath, expiredLease);
          dropLeaseRetirementColumn(databasePath);
        });
      }),
    );

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        // A pre-scoped database must restore scoped authority before lease
        // maintenance can safely inspect its active view. Initialization does
        // not retire the displaced snapshot; the following ordinary acquire
        // performs that bounded maintenance once authority is current.
        yield* store.initialize(databasePath);
        expect(readSnapshotState(databasePath, superseded.id)).toBe('ready');
        const currentLease = yield* store.acquireSnapshotLease(databasePath, current.id, 60_000);
        yield* waitForSnapshotRemoval(databasePath, superseded.id);
        yield* store.releaseSnapshotLease(databasePath, currentLease);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      const columns = database.query("PRAGMA table_info('snapshot_leases')").all() as readonly {
        readonly name: string;
      }[];
      expect(columns.map(column => column.name)).toContain('retire_when_inactive');
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(superseded.id)).toBeNull();
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(current.id)).toEqual({state: 'ready'});
    } finally {
      database.close(false);
    }
  });

  it('migrates the lease schema before releasing a lease', async () => {
    const root = await mkdtemp('threadnote-ready-retention-release-migration-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const ready = snapshot(identity, 'release-migration');
    const token = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [ready]);
        return yield* store.acquireSnapshotLease(databasePath, ready.id, 60_000);
      }),
    );
    dropLeaseRetirementColumn(databasePath);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* store.releaseSnapshotLease(databasePath, token);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(leaseColumns(database)).toContain('retire_when_inactive');
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
    } finally {
      database.close(false);
    }
  });

  it('migrates the lease schema before renewing a lease', async () => {
    const root = await mkdtemp('threadnote-ready-retention-renew-migration-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const ready = snapshot(identity, 'renew-migration');
    const token = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [ready]);
        return yield* store.acquireSnapshotLease(databasePath, ready.id, 60_000);
      }),
    );
    const before = readLeaseExpiration(databasePath, token);
    dropLeaseRetirementColumn(databasePath);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* store.renewSnapshotLease(databasePath, token, 10 * 60_000);
      }),
    );
    const after = readLeaseExpiration(databasePath, token);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.releaseSnapshotLease(databasePath, token);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(leaseColumns(database)).toContain('retire_when_inactive');
      expect(readLeaseExpiration(databasePath, token)).toBeUndefined();
      expect(before).toBeDefined();
      expect(after).toBeGreaterThan(before ?? 0);
    } finally {
      database.close(false);
    }
  });

  it('returns a typed privacy-safe error when a bounded lease writer wait expires', async () => {
    const home = await mkdtemp('threadnote-ready-retention-writer-busy-');
    temporaryRoots.push(home);
    const checkoutId = 'c'.repeat(64);
    const databasePath = join(home, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
    const writerLockPath = join(home, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`);
    const identity = {
      ...repositoryIdentity(home),
      checkoutId,
      worktreeId: 'd'.repeat(64),
    };
    const ready = snapshot(identity, 'bounded-writer-wait');

    const error = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [ready]);
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            onWriterAcquired: () =>
              Deferred.succeed(writerAcquired, undefined).pipe(Effect.andThen(Deferred.await(releaseWriter))),
            writerLockPath,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerAcquired);
        const busy = yield* store
          .acquireSnapshotLease(databasePath, ready.id, 60_000, {waitTimeoutMilliseconds: 0})
          .pipe(Effect.flip, Effect.ensuring(Deferred.succeed(releaseWriter, undefined).pipe(Effect.asVoid)));
        yield* Fiber.join(writer);
        return busy;
      }),
    );

    expect(error).toBeInstanceOf(CodeGraphStoreBusyError);
    expect(error.message).toContain('another code graph writer owns this checkout');
    expect(error.message).not.toContain(home);
  });

  it('serializes arbitrary-path lease writers through the fallback sidecar lock', async () => {
    const root = await mkdtemp('threadnote-ready-retention-fallback-writer-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const writerLockPath = `${databasePath}.writer.lock`;
    const identity = repositoryIdentity(root);
    const ready = snapshot(identity, 'fallback-writer');

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [ready]);
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            onWriterAcquired: () =>
              Deferred.succeed(writerAcquired, undefined).pipe(Effect.andThen(Deferred.await(releaseWriter))),
            writerLockPath,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerAcquired);
        const busy = yield* store
          .acquireSnapshotLease(databasePath, ready.id, 60_000, {waitTimeoutMilliseconds: 0})
          .pipe(Effect.flip, Effect.ensuring(Deferred.succeed(releaseWriter, undefined).pipe(Effect.asVoid)));
        yield* Fiber.join(writer);
        const token = yield* store.acquireSnapshotLease(databasePath, ready.id, 60_000);
        yield* store.releaseSnapshotLease(databasePath, token);
        return busy;
      }),
    );

    expect(result).toBeInstanceOf(CodeGraphStoreBusyError);
    expect(result.message).not.toContain(root);
  });

  effectIt.effect('does not advance unrelated retired rows when an active snapshot lease is released', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp('threadnote-ready-retention-active-release-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const active = snapshot(identity, 'active-release-current');
        const retired = snapshot(identity, 'active-release-retired');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [active, retired]);
        yield* Effect.sync(() => activateSnapshot(databasePath, identity.worktreeId, active.id));
        yield* Effect.sync(() => seedSymbol(databasePath, active.id));
        const lease = yield* store.acquireSnapshotLease(databasePath, active.id, 60_000);
        yield* Effect.sync(() => retireSnapshotWithSymbol(databasePath, retired.id));

        const activeBefore = readActiveSnapshotEvidence(databasePath, identity.worktreeId, active.id);
        const backlogBefore = readSnapshotSymbolCount(databasePath, retired.id);
        expect(backlogBefore).toBe(1);

        yield* store.releaseSnapshotLease(databasePath, lease);

        expect(readActiveSnapshotEvidence(databasePath, identity.worktreeId, active.id)).toEqual(activeBefore);
        expect(readSnapshotSymbolCount(databasePath, retired.id)).toBe(backlogBefore);
        expect(readSnapshotLeaseTokens(databasePath)).toEqual([]);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('advances cleanup when a release reaps an expired transient target', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp('threadnote-ready-retention-expired-release-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const active = snapshot(identity, 'expired-release-current');
        const expired = snapshot(identity, 'expired-release-transient');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [active, expired]);
        yield* Effect.sync(() => activateSnapshot(databasePath, identity.worktreeId, active.id));
        yield* Effect.sync(() => seedSymbol(databasePath, active.id));
        const activeLease = yield* store.acquireSnapshotLease(databasePath, active.id, 60_000);
        const expiredLease = yield* store.acquireSnapshotLease(databasePath, expired.id, 60_000, {
          retireWhenInactive: true,
        });
        yield* Effect.sync(() => {
          seedSymbol(databasePath, expired.id);
          expireLease(databasePath, expiredLease);
        });

        const activeBefore = readActiveSnapshotEvidence(databasePath, identity.worktreeId, active.id);
        yield* store.releaseSnapshotLease(databasePath, activeLease);
        yield* waitForSnapshotRemoval(databasePath, expired.id);

        expect(readActiveSnapshotEvidence(databasePath, identity.worktreeId, active.id)).toEqual(activeBefore);
        expect(readSnapshotLeaseTokens(databasePath)).toEqual([]);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'matches active lease overlap and release order without spending unrelated retired backlog',
    {
      leaseCount: fc.integer({max: 4, min: 1}),
      releasePriorities: fc.array(fc.integer(), {maxLength: 4, minLength: 4}),
    },
    ({leaseCount, releasePriorities}) =>
      TestClock.withLive(
        Effect.gen(function* () {
          const root = yield* Effect.promise(() => mkdtemp('threadnote-ready-retention-release-order-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'graph-v3.sqlite');
          const identity = repositoryIdentity(root);
          const active = snapshot(identity, 'release-order-current');
          const retired = snapshot(identity, 'release-order-retired');
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          yield* registerReadySnapshots(store, databasePath, identity, [active, retired]);
          yield* Effect.sync(() => activateSnapshot(databasePath, identity.worktreeId, active.id));
          yield* Effect.sync(() => seedSymbol(databasePath, active.id));
          const tokens = yield* Effect.forEach(Array.from({length: leaseCount}), () =>
            store.acquireSnapshotLease(databasePath, active.id, 60_000),
          );
          yield* Effect.sync(() => retireSnapshotWithSymbol(databasePath, retired.id));

          const activeBefore = readActiveSnapshotEvidence(databasePath, identity.worktreeId, active.id);
          const backlogBefore = readSnapshotSymbolCount(databasePath, retired.id);
          const liveTokens = new Set(tokens);
          const releaseOrder = Array.from({length: leaseCount}, (_, index) => index).sort(
            (left, right) => releasePriorities[left] - releasePriorities[right] || left - right,
          );

          for (const index of releaseOrder) {
            const token = tokens[index];
            liveTokens.delete(token);
            yield* store.releaseSnapshotLease(databasePath, token);
            expect(readSnapshotLeaseTokens(databasePath)).toEqual([...liveTokens].sort());
            expect(readActiveSnapshotEvidence(databasePath, identity.worktreeId, active.id)).toEqual(activeBefore);
            expect(readSnapshotSymbolCount(databasePath, retired.id)).toBe(backlogBefore);
          }
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    {fastCheck: {numRuns: 12}},
  );
});

function registerReadySnapshots(
  store: CodeGraphStoreShape,
  databasePath: string,
  identity: RepositoryIdentity,
  snapshots: readonly CodeGraphSnapshot[],
) {
  return Effect.gen(function* () {
    for (const candidate of snapshots) yield* store.markBuilding(databasePath, identity, candidate);
    yield* Effect.sync(() => {
      const database = new Database(databasePath, {strict: true});
      try {
        const ready = database.prepare("UPDATE snapshots SET state = 'ready', completed_at = ? WHERE id = ?");
        const generation = database.prepare(
          "INSERT INTO snapshot_extractor_generations (snapshot_id, generation) SELECT ?, CAST(value AS INTEGER) FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
        );
        database.transaction(() => {
          for (const candidate of snapshots) {
            ready.run(new Date().toISOString(), candidate.id);
            generation.run(candidate.id);
          }
        })();
      } finally {
        database.close(false);
      }
    });
  });
}

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'snapshot-retention-fixture',
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'r'.repeat(64),
    worktreeId: 'w'.repeat(64),
  };
}

function snapshot(
  identity: RepositoryIdentity,
  suffix: string,
  options: {readonly baseSnapshotId?: string; readonly dirty?: boolean} = {},
): CodeGraphSnapshot {
  const dirty = options.dirty ?? true;
  return {
    ...(options.baseSnapshotId ? {baseSnapshotId: options.baseSnapshotId} : {}),
    commit: identity.headCommit,
    dirty,
    edgeCount: 0,
    extractorSet: 'extractor-set',
    fileCount: 0,
    id: `cgsn_${createHash('sha1').update(suffix).digest('hex')}`,
    ...(dirty ? {overlayFingerprint: `overlay-${suffix}`} : {}),
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}

function seedSymbol(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO symbols (
           snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
           arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
           exported, signature, documentation, span_json
         ) VALUES (?, 'superseded-symbol', 'content', 'function', 'stale', 'stale',
           'src/stale.ts', 'typescript', NULL, '[]', 'typescript', NULL, NULL, 0,
           NULL, NULL, '{"startLine":1,"endLine":1}')`,
      )
      .run(snapshotId);
  } finally {
    database.close(false);
  }
}

function retireSnapshotWithSymbol(databasePath: string, snapshotId: string): void {
  seedSymbol(databasePath, snapshotId);
  const database = new Database(databasePath, {strict: true});
  try {
    database.query("UPDATE snapshots SET state = 'retired' WHERE id = ? AND state = 'ready'").run(snapshotId);
  } finally {
    database.close(false);
  }
}

function activateSnapshot(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run(worktreeId, snapshotId, new Date().toISOString());
  } finally {
    database.close(false);
  }
}

function readActiveSnapshotEvidence(databasePath: string, worktreeId: string, snapshotId: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      active: database.query('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?').get(worktreeId),
      snapshot: database.query('SELECT state FROM snapshots WHERE id = ?').get(snapshotId),
      symbolCount: readSnapshotSymbolCountFromDatabase(database, snapshotId),
    };
  } finally {
    database.close(false);
  }
}

function readSnapshotSymbolCount(databasePath: string, snapshotId: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return readSnapshotSymbolCountFromDatabase(database, snapshotId);
  } finally {
    database.close(false);
  }
}

function readSnapshotSymbolCountFromDatabase(database: Database, snapshotId: string): number {
  return (
    database.query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?').get(snapshotId) as {
      readonly count: number;
    }
  ).count;
}

function readSnapshotLeaseTokens(databasePath: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (
      database.query('SELECT token FROM snapshot_leases ORDER BY token').all() as readonly {readonly token: string}[]
    ).map(row => row.token);
  } finally {
    database.close(false);
  }
}

function expireLease(databasePath: string, token: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('UPDATE snapshot_leases SET expires_at = ? WHERE token = ?').run(Date.now() - 1, token);
  } finally {
    database.close(false);
  }
}

function dropLeaseRetirementColumn(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('BEGIN IMMEDIATE');
    database.run('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete');
    database.run('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert');
    database.run('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update');
    database.run('ALTER TABLE snapshot_leases DROP COLUMN retire_when_inactive');
    database.run('DROP TABLE IF EXISTS removed_view_cleanup');
    database.run('DROP TABLE IF EXISTS snapshot_build_owner_instances');
    database.run('DROP TABLE IF EXISTS scope_applicability');
    database.run('DROP TABLE IF EXISTS snapshot_scope_receipts');
    database.run('DROP INDEX IF EXISTS snapshots_scope_recent_ready');
    database.run('DROP INDEX IF EXISTS snapshots_scope_commit_ready');
    database.run('DROP INDEX IF EXISTS snapshots_scope_reusable');
    database.run('DROP INDEX IF EXISTS snapshots_scope_reusable_content');
    database.run('DROP INDEX IF EXISTS snapshots_scope_reusable_commit');
    database.run(
      `CREATE TEMP TABLE legacy_active_snapshots AS
       SELECT worktree_id, snapshot_id, activated_at FROM active_snapshots
       WHERE scope_id = 'full-repository'`,
    );
    database.run('DROP TABLE active_snapshots');
    database.run(`CREATE TABLE active_snapshots (
      worktree_id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      activated_at TEXT NOT NULL
    )`);
    database.run(`INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
      SELECT worktree_id, snapshot_id, activated_at FROM legacy_active_snapshots`);
    database.run('DROP TABLE legacy_active_snapshots');
    database.run('DROP TABLE IF EXISTS removed_views');
    database.run('ALTER TABLE snapshots DROP COLUMN scope_id');
    database.run(
      'CREATE INDEX IF NOT EXISTS active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id)',
    );
    database.run('CREATE INDEX IF NOT EXISTS snapshots_base_state_id ON snapshots(base_snapshot_id, state, id)');
    database.run(
      'CREATE INDEX IF NOT EXISTS snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)',
    );
    database.run('CREATE INDEX IF NOT EXISTS snapshot_leases_expiry ON snapshot_leases(expires_at)');
    database.run(
      `DELETE FROM schema_metadata
       WHERE key IN ('removed_view_cleanup_epoch_sequence', 'removed_view_cleanup_admission_cursor')`,
    );
    database.run("UPDATE schema_metadata SET value = '6' WHERE key = 'persistent_extension_schema_revision'");
    database.run('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.run('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function leaseColumns(database: Database): readonly string[] {
  return (
    database.query("PRAGMA table_info('snapshot_leases')").all() as readonly {
      readonly name: string;
    }[]
  ).map(column => column.name);
}

function readLeaseRetirementFlag(databasePath: string, token: string): number | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly retire_when_inactive: number}, [string]>(
        'SELECT retire_when_inactive FROM snapshot_leases WHERE token = ?',
      )
      .get(token)?.retire_when_inactive;
  } finally {
    database.close(false);
  }
}

function readLeaseExpiration(databasePath: string, token: string): number | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (
      database.query('SELECT expires_at FROM snapshot_leases WHERE token = ?').get(token) as
        {readonly expires_at: number} | undefined
    )?.expires_at;
  } finally {
    database.close(false);
  }
}

function readSnapshotState(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (
      database.query('SELECT state FROM snapshots WHERE id = ?').get(snapshotId) as {readonly state: string} | undefined
    )?.state;
  } finally {
    database.close(false);
  }
}

function waitForSnapshotRemoval(databasePath: string, snapshotId: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (readSnapshotState(databasePath, snapshotId) === undefined) return;
      yield* Effect.sleep(10);
    }
    return yield* TestError.make({message: `Timed out waiting for retired snapshot ${snapshotId} to be reclaimed.`});
  });
}
