import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Clock, Crypto, Deferred, Effect, Exit, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {runCodeGraphRepair} from '@threadnote/threadnote/code_graph/commands';
import {
  codeGraphTemporaryMaterializationSpoolSnapshotId,
  codeGraphDoctorCheck,
  diagnoseCodeGraphDatabaseReadOnly,
  repairCodeGraphIndexes,
} from '@threadnote/graph/maintenance';
import {
  codeGraphDatabaseWriteLockPath,
  codeGraphRepositoryLockPath,
  codeGraphWorktreeLockPath,
} from '@threadnote/graph/layout';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import {CodeGraphStore} from '@threadnote/graph/store';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {legacyCodeGraphAuthorityStatements} from '@threadnote/graph/test/helpers/code-graph-legacy-authority';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {inspectCodeGraphViewDatabaseTarget} from '@threadnote/graph/view_removal';

const LIVE_LEASE_EXPIRY_MILLISECONDS = Number.MAX_SAFE_INTEGER;

describe('bounded code graph maintenance', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('lets update-time quick repair defer an actively built large store without waiting or opening it', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-');
    homes.push(home);
    const checkoutId = 'a'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(databasePath, 'this file must never be opened while its build lock is active');
    const progress: string[] = [];

    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lockPath = codeGraphWorktreeLockPath(path, home, checkoutId, 'b'.repeat(64));
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            lockPath,
            {
              heartbeatIntervalMilliseconds: 20,
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 100,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const startedAt = yield* Clock.currentTimeMillis;
        const summary = yield* repairCodeGraphIndexes(
          home,
          false,
          state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`)),
          undefined,
          {mode: 'quick'},
        );
        const elapsedMilliseconds = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        return {elapsedMilliseconds, summary};
      }),
    );

    expect(result.elapsedMilliseconds).toBeLessThan(1_000);
    expect(result.summary).toMatchObject({
      databases: 1,
      deferredDatabases: 1,
      discarded: 0,
      removedIncompleteSnapshots: 0,
      removedTemporaryFiles: 0,
    });
    expect(progress).toEqual(['checking:none', 'deferred:active-build']);
    expect(await Bun.file(databasePath).text()).toContain('must never be opened');
  });

  effectIt.effect('deep repair removes orphaned spools while preserving live leased build state', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-spool-'});
      const checkoutId = 'a'.repeat(64);
      const repositoryId = 'b'.repeat(64);
      const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const identity: RepositoryIdentity = {
        caseMode: 'sensitive',
        checkoutId,
        displayName: 'repair-spool-fixture',
        gitCommonDirectory: home,
        headCommit: 'c'.repeat(40),
        objectFormat: 'sha1',
        repoRoot: home,
        repositoryId,
        worktreeId: 'd'.repeat(64),
      };
      const unleasedSnapshot = repairBuildingSnapshot(identity, '1');
      const leasedIdentity = {...identity, worktreeId: 'e'.repeat(64)};
      const leasedSnapshot = repairBuildingSnapshot(leasedIdentity, '2');
      const orphanSnapshotId = `cgsn_${'3'.repeat(40)}-direct`;
      const spoolPath = (snapshotId: string) =>
        path.join(repositoryRoot, `materialization-spool-v2-${snapshotId}.sqlite`);
      const ignoredPath = path.join(repositoryRoot, `materialization-spool-v3-${orphanSnapshotId}.sqlite`);
      const vectorTemporaryPath = path.join(repositoryRoot, 'vectors', 'model', 'scratch.tmp');
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* store.claimPersistentBuild(databasePath, identity, unleasedSnapshot, {
        logicalSnapshotId: `cgsn_${'1'.repeat(40)}`,
        owner: {buildId: '11111111-1111-1111', processId: process.pid},
      });
      yield* store.claimPersistentBuild(databasePath, leasedIdentity, leasedSnapshot, {
        logicalSnapshotId: `cgsn_${'2'.repeat(40)}`,
        owner: {buildId: '22222222-2222-2222', processId: process.pid},
      });
      yield* Effect.sync(() => {
        const database = new Database(databasePath, {strict: true});
        try {
          database
            .query('INSERT INTO snapshot_leases (token, snapshot_id, expires_at) VALUES (?, ?, ?)')
            .run('repair-spool-live-lease', leasedSnapshot.id, LIVE_LEASE_EXPIRY_MILLISECONDS);
        } finally {
          database.close(false);
        }
      });
      for (const file of [
        spoolPath(unleasedSnapshot.id),
        spoolPath(leasedSnapshot.id),
        spoolPath(orphanSnapshotId),
        ignoredPath,
      ]) {
        yield* fs.writeFile(file, new Uint8Array([1]));
      }
      yield* fs.makeDirectory(path.dirname(vectorTemporaryPath), {recursive: true});
      yield* fs.writeFile(vectorTemporaryPath, new Uint8Array([1]));

      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {mode: 'deep'});
      expect(preview).toMatchObject({removedIncompleteSnapshots: 1, removedTemporaryFiles: 3});
      for (const file of [
        spoolPath(unleasedSnapshot.id),
        spoolPath(leasedSnapshot.id),
        spoolPath(orphanSnapshotId),
        ignoredPath,
      ]) {
        expect(yield* fs.exists(file)).toBe(true);
      }
      expect(yield* fs.exists(vectorTemporaryPath)).toBe(true);

      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {mode: 'deep'});
      expect(applied).toMatchObject({removedIncompleteSnapshots: 1, removedTemporaryFiles: 3});
      expect(yield* fs.exists(spoolPath(unleasedSnapshot.id))).toBe(false);
      expect(yield* fs.exists(spoolPath(orphanSnapshotId))).toBe(false);
      expect(yield* fs.exists(spoolPath(leasedSnapshot.id))).toBe(true);
      expect(yield* fs.exists(ignoredPath)).toBe(true);
      expect(yield* fs.exists(vectorTemporaryPath)).toBe(false);
      expect(yield* store.diagnose(databasePath)).toMatchObject({buildingSnapshots: 1});

      yield* Effect.sync(() => {
        const database = new Database(databasePath, {strict: true});
        try {
          database.query('DELETE FROM snapshot_leases WHERE token = ?').run('repair-spool-live-lease');
        } finally {
          database.close(false);
        }
      });
      const released = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {mode: 'deep'});
      expect(released).toMatchObject({removedIncompleteSnapshots: 1, removedTemporaryFiles: 1});
      expect(yield* fs.exists(spoolPath(leasedSnapshot.id))).toBe(false);
      expect(yield* fs.exists(ignoredPath)).toBe(true);
      expect(yield* store.diagnose(databasePath)).toMatchObject({buildingSnapshots: 0, integrity: 'ok'});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('defers a targeted repair when a builder enters after the initial drain', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-late-builder-'});
        const identity = legacyRepositoryIdentity(home, 'a');
        const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId);
        const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
        const building = repairBuildingSnapshot(identity, '1');
        const spoolPath = path.join(repositoryRoot, `materialization-spool-v1-${building.id}.sqlite`);
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const drained = yield* Deferred.make<void>();
        const continueRepair = yield* Deferred.make<void>();
        const builderClaimed = yield* Deferred.make<void>();
        const releaseBuilder = yield* Deferred.make<void>();
        const repair = yield* Effect.forkScoped(
          repairCodeGraphIndexes(home, false, undefined, undefined, {
            interlock: {
              afterWorktreeDrain: () =>
                Deferred.succeed(drained, undefined).pipe(Effect.andThen(Deferred.await(continueRepair))),
            },
            mode: 'deep',
            targetCheckoutId: identity.checkoutId,
          }),
        );
        yield* Deferred.await(drained);
        const builder = yield* Effect.forkScoped(
          withExclusiveFileLock(
            fs,
            codeGraphWorktreeLockPath(path, home, identity.checkoutId, identity.worktreeId),
            {
              heartbeatIntervalMilliseconds: 20,
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 100,
              waitTimeoutMilliseconds: 5_000,
            },
            Effect.gen(function* () {
              yield* store.claimPersistentBuild(databasePath, identity, building, {
                logicalSnapshotId: `cgsn_${'1'.repeat(40)}`,
                owner: {buildId: '11111111-1111-1111', processId: process.pid},
              });
              yield* fs.writeFile(spoolPath, new Uint8Array([1]));
              yield* Deferred.succeed(builderClaimed, undefined);
              yield* Deferred.await(releaseBuilder);
            }),
          ),
        );
        yield* Deferred.await(builderClaimed);
        yield* Deferred.succeed(continueRepair, undefined);

        const summary = yield* Fiber.join(repair);
        expect(summary).toMatchObject({
          databases: 1,
          deferredDatabases: 1,
          removedIncompleteSnapshots: 0,
          removedTemporaryFiles: 0,
        });
        expect(yield* fs.exists(spoolPath)).toBe(true);
        expect(yield* store.diagnose(databasePath)).toMatchObject({buildingSnapshots: 1});

        yield* Deferred.succeed(releaseBuilder, undefined);
        yield* Fiber.join(builder);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reports orphan spool cleanup during a schema-migration dry-run', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-migration-preview-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const leasedIdentity = {...identity, worktreeId: 'b'.repeat(64)};
      const unleasedSnapshot = repairBuildingSnapshot(identity, '1');
      const leasedSnapshot = repairBuildingSnapshot(leasedIdentity, '2');
      const orphanSnapshotId = `cgsn_${'3'.repeat(40)}-direct`;
      const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId);
      const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const spoolPath = (snapshotId: string) =>
        path.join(repositoryRoot, `materialization-spool-v1-${snapshotId}.sqlite`);
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* store.claimPersistentBuild(databasePath, identity, unleasedSnapshot, {
        logicalSnapshotId: `cgsn_${'1'.repeat(40)}`,
        owner: {buildId: '11111111-1111-1111', processId: process.pid},
      });
      yield* store.claimPersistentBuild(databasePath, leasedIdentity, leasedSnapshot, {
        logicalSnapshotId: `cgsn_${'2'.repeat(40)}`,
        owner: {buildId: '22222222-2222-2222', processId: process.pid},
      });
      yield* Effect.sync(() => {
        const database = new Database(databasePath, {strict: true});
        try {
          database
            .query('INSERT INTO snapshot_leases (token, snapshot_id, expires_at) VALUES (?, ?, ?)')
            .run('migration-preview-live-lease', leasedSnapshot.id, LIVE_LEASE_EXPIRY_MILLISECONDS);
        } finally {
          database.close(false);
        }
      });
      yield* Effect.sync(() => makeRecoverableInterruptedExtension(databasePath));
      for (const snapshotId of [unleasedSnapshot.id, leasedSnapshot.id, orphanSnapshotId]) {
        yield* fs.writeFile(spoolPath(snapshotId), new Uint8Array([1]));
      }

      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(preview).toMatchObject({
        migratedDatabases: 1,
        removedIncompleteSnapshots: 0,
        removedTemporaryFiles: 3,
      });
      for (const snapshotId of [unleasedSnapshot.id, leasedSnapshot.id, orphanSnapshotId]) {
        expect(yield* fs.exists(spoolPath(snapshotId))).toBe(true);
      }

      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });
      expect(applied).toMatchObject({
        migratedDatabases: 1,
        removedIncompleteSnapshots: 0,
        removedTemporaryFiles: 3,
      });
      expect(yield* fs.exists(spoolPath(unleasedSnapshot.id))).toBe(false);
      expect(yield* fs.exists(spoolPath(orphanSnapshotId))).toBe(false);
      expect(yield* fs.exists(spoolPath(leasedSnapshot.id))).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes a database-less orphan spool', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-database-less-'});
      const checkoutId = 'a'.repeat(64);
      const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const spoolPath = path.join(repositoryRoot, `materialization-spool-v1-cgsn_${'1'.repeat(40)}-direct.sqlite`);
      yield* fs.makeDirectory(repositoryRoot, {recursive: true});
      yield* fs.writeFile(spoolPath, new Uint8Array([1]));

      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        mode: 'deep',
        targetCheckoutId: checkoutId,
      });
      expect(preview).toMatchObject({databases: 0, removedTemporaryFiles: 1});
      expect(yield* fs.exists(spoolPath)).toBe(true);

      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        mode: 'deep',
        targetCheckoutId: checkoutId,
      });
      expect(applied).toMatchObject({databases: 0, removedTemporaryFiles: 1});
      expect(yield* fs.exists(spoolPath)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('defers database-less cleanup when a builder publishes durable state after inventory', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-database-appeared-'});
      const identity = legacyRepositoryIdentity(home, 'a');
      const building = repairBuildingSnapshot(identity, '1');
      const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId);
      const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const spoolPath = path.join(repositoryRoot, `materialization-spool-v1-${building.id}.sqlite`);
      const store = yield* CodeGraphStore;
      yield* fs.makeDirectory(repositoryRoot, {recursive: true});
      let built = false;

      const summary = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        interlock: {
          afterWorktreeDrain: () =>
            Effect.gen(function* () {
              if (built) return;
              built = true;
              yield* withExclusiveFileLock(
                fs,
                codeGraphWorktreeLockPath(path, home, identity.checkoutId, identity.worktreeId),
                {
                  // Keep touching the live build lease while the durable state
                  // is created, so cleanup must release its lock despite a
                  // trailing heartbeat racing the release read.
                  heartbeatIntervalMilliseconds: 1,
                  retryIntervalMilliseconds: 5,
                  staleAfterMilliseconds: 100,
                  waitTimeoutMilliseconds: 5_000,
                },
                Effect.gen(function* () {
                  yield* store.initialize(databasePath);
                  yield* store.claimPersistentBuild(databasePath, identity, building, {
                    logicalSnapshotId: `cgsn_${'1'.repeat(40)}`,
                    owner: {buildId: '11111111-1111-1111', processId: process.pid},
                  });
                  yield* Effect.sync(() => {
                    const database = new Database(databasePath, {strict: true});
                    try {
                      database
                        .query('INSERT INTO snapshot_leases (token, snapshot_id, expires_at) VALUES (?, ?, ?)')
                        .run('database-appeared-live-lease', building.id, LIVE_LEASE_EXPIRY_MILLISECONDS);
                    } finally {
                      database.close(false);
                    }
                  });
                  yield* fs.writeFile(spoolPath, new Uint8Array([1]));
                }),
              ).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, system),
              );
            }),
        },
        mode: 'deep',
        targetCheckoutId: identity.checkoutId,
      });

      expect(summary).toMatchObject({
        databases: 1,
        deferredDatabases: 1,
        removedIncompleteSnapshots: 0,
        removedTemporaryFiles: 0,
      });
      expect(yield* fs.exists(spoolPath)).toBe(true);
      expect(yield* store.diagnose(databasePath)).toMatchObject({buildingSnapshots: 1});
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('never follows a spool-shaped child symbolic link', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-child-link-'});
      const external = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-external-'});
      const checkoutId = 'a'.repeat(64);
      const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const externalVictim = path.join(external, 'victim.sqlite');
      const linkedSpool = path.join(repositoryRoot, `materialization-spool-v1-cgsn_${'1'.repeat(40)}-direct.sqlite`);
      yield* fs.makeDirectory(repositoryRoot, {recursive: true});
      yield* fs.writeFile(externalVictim, new Uint8Array([1]));
      yield* fs.symlink(externalVictim, linkedSpool);

      const applied = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        mode: 'deep',
        targetCheckoutId: checkoutId,
      });
      expect(applied).toMatchObject({databases: 0, removedTemporaryFiles: 0});
      expect(yield* fs.exists(linkedSpool)).toBe(true);
      expect(yield* fs.exists(externalVictim)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses spool cleanup after the repositories ancestor is swapped', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-ancestor-swap-'});
      const externalRepositories = yield* fs.makeTempDirectoryScoped({
        prefix: 'threadnote-graph-repair-external-repositories-',
      });
      const checkoutId = 'a'.repeat(64);
      const repositories = path.join(home, 'indexes', 'code-graph', 'repositories');
      const repositoryRoot = path.join(repositories, checkoutId);
      const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const movedRepositories = `${repositories}.original`;
      const externalCheckout = path.join(externalRepositories, checkoutId);
      const spoolName = `materialization-spool-v1-cgsn_${'1'.repeat(40)}-direct.sqlite`;
      const originalSpool = path.join(repositoryRoot, spoolName);
      const externalVictim = path.join(externalCheckout, 'victim.sqlite');
      const externalReplacementSpool = path.join(externalCheckout, spoolName);
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* fs.writeFile(originalSpool, new Uint8Array([1]));
      yield* fs.makeDirectory(externalCheckout, {recursive: true});
      yield* fs.writeFile(externalVictim, new Uint8Array([1]));
      yield* fs.symlink(externalVictim, externalReplacementSpool);

      const result = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        interlock: {
          beforeSpoolQuarantine: () =>
            fs
              .rename(repositories, movedRepositories)
              .pipe(Effect.andThen(fs.symlink(externalRepositories, repositories))),
        },
        mode: 'deep',
        targetCheckoutId: checkoutId,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* fs.exists(externalReplacementSpool)).toBe(true);
      expect(yield* fs.readLink(externalReplacementSpool)).toBe(externalVictim);
      expect(yield* fs.exists(externalVictim)).toBe(true);
      expect(yield* fs.exists(path.join(movedRepositories, checkoutId, spoolName))).toBe(true);
      expect((yield* fs.readDirectory(externalCheckout)).some(name => name.endsWith('.repair'))).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses spool cleanup after the checkout root is swapped', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-repair-root-swap-'});
      const externalCheckout = yield* fs.makeTempDirectoryScoped({
        prefix: 'threadnote-graph-repair-external-checkout-',
      });
      const checkoutId = 'a'.repeat(64);
      const repositoryRoot = path.join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const databasePath = path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const movedRepositoryRoot = `${repositoryRoot}.original`;
      const spoolName = `materialization-spool-v1-cgsn_${'1'.repeat(40)}-direct.sqlite`;
      const originalSpool = path.join(repositoryRoot, spoolName);
      const externalVictim = path.join(externalCheckout, spoolName);
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* fs.writeFile(originalSpool, new Uint8Array([1]));
      yield* fs.writeFile(externalVictim, new Uint8Array([1]));

      const result = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        interlock: {
          beforeSpoolQuarantine: () =>
            fs
              .rename(repositoryRoot, movedRepositoryRoot)
              .pipe(Effect.andThen(fs.symlink(externalCheckout, repositoryRoot))),
        },
        mode: 'deep',
        targetCheckoutId: checkoutId,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* fs.exists(externalVictim)).toBe(true);
      expect(yield* fs.exists(path.join(movedRepositoryRoot, spoolName))).toBe(true);
      expect((yield* fs.readDirectory(externalCheckout)).some(name => name.endsWith('.repair'))).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('recognizes exactly the canonical persistent spool filename family', () => {
    const hexadecimal = (length: number) =>
      fc
        .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: length, minLength: length})
        .map(value => value.join(''));
    fc.assert(
      fc.property(
        fc.constantFrom(1, 2),
        hexadecimal(40),
        fc.oneof(
          fc.constant(''),
          fc.constant('-direct'),
          hexadecimal(16).map(value => `-full-${value}`),
        ),
        fc.constantFrom('', '-journal', '-shm', '-wal'),
        (version, digest, mode, companion) => {
          const snapshotId = `cgsn_${digest}${mode}`;
          const fileName = `materialization-spool-v${version}-${snapshotId}.sqlite${companion}`;
          expect(codeGraphTemporaryMaterializationSpoolSnapshotId(fileName)).toBe(snapshotId);
          expect(codeGraphTemporaryMaterializationSpoolSnapshotId(`prefix-${fileName}`)).toBeUndefined();
          expect(codeGraphTemporaryMaterializationSpoolSnapshotId(`${fileName}.extra`)).toBeUndefined();
          expect(
            codeGraphTemporaryMaterializationSpoolSnapshotId(fileName.replace(`-v${version}-`, '-v3-')),
          ).toBeUndefined();
        },
      ),
      {numRuns: 100},
    );
  });

  it('recovers an orphaned checkout lock instead of deferring doctor forever', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-stale-checkout-');
    homes.push(home);
    const checkoutId = 'c'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await mkdir(repositoryRoot, {recursive: true});
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const lockPath = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return codeGraphRepositoryLockPath(path, home, checkoutId);
      }),
    );
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(
      lockPath,
      `${JSON.stringify({
        processId: 2_147_483_647,
        processStartIdentity: 'orphaned-process-instance',
        token: 'orphaned-checkout-lock',
        version: 1,
      })}\n`,
    );
    const progress: string[] = [];

    const doctor = await runEffect(
      codeGraphDoctorCheck(home, state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`))),
    );

    expect(doctor).toMatchObject({status: 'ok'});
    expect(progress).toEqual(['checking:none']);
    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
  });

  effectIt.effect('reports a ready snapshot while maintenance is deferred by a live worktree build', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-doctor-live-builder-'});
        const identity = legacyRepositoryIdentity(home, 'd');
        const databasePath = path.join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          identity.checkoutId,
          `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
        );
        const snapshot = legacyReadySnapshot(identity, 'd');
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        const before = yield* fs.readFile(databasePath);
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const builder = yield* Effect.forkScoped(
          withExclusiveFileLock(
            fs,
            codeGraphWorktreeLockPath(path, home, identity.checkoutId, identity.worktreeId),
            {
              heartbeatIntervalMilliseconds: 20,
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 100,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const progress: string[] = [];

        const doctor = yield* codeGraphDoctorCheck(home, state =>
          Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`)),
        );

        expect(doctor).toMatchObject({status: 'warn'});
        expect(doctor.detail).toContain('1 ready snapshot(s)');
        expect(doctor.detail).toContain('1 database maintenance check(s) deferred');
        expect(progress).toEqual(['checking:none', 'deferred:active-build']);
        expect(yield* fs.readFile(databasePath)).toEqual(before);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(builder);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reports revision-8 cleanup authority drift as incompatible without mutating it', () =>
    Effect.gen(function* () {
      const cases = [
        {
          mutate: (database: Database) => database.run('DROP TABLE removed_view_cleanup'),
          name: 'missing-table',
        },
        {
          mutate: (database: Database) => {
            database.run('DROP INDEX removed_view_cleanup_due');
            database.run('CREATE INDEX removed_view_cleanup_due ON removed_view_cleanup(phase)');
          },
          name: 'wrong-index',
        },
        {
          mutate: (database: Database) =>
            database.run(
              "UPDATE schema_metadata SET key = 'PERSISTENT_EXTENSION_SCHEMA_REVISION' WHERE key = 'persistent_extension_schema_revision'",
            ),
          name: 'uppercase-revision',
        },
        {
          mutate: (database: Database) =>
            database.run(
              "INSERT INTO schema_metadata (key, value) VALUES ('removed_view_cleanup_admission_cursor', 'invalid')",
            ),
          name: 'malformed-cursor',
        },
      ] as const;
      const store = yield* CodeGraphStore;
      for (const testCase of cases) {
        const home = yield* Effect.promise(() => mkdtemp(`threadnote-graph-health-${testCase.name}-`));
        homes.push(home);
        const databasePath = join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          'f'.repeat(64),
          `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
        );
        yield* store.initialize(databasePath);
        const before = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            testCase.mutate(database);
            return readCleanupHealthSurface(database);
          } finally {
            database.close(false);
          }
        });

        expect((yield* diagnoseCodeGraphDatabaseReadOnly(databasePath, false)).integrity).toBe('incompatible');
        expect(
          yield* Effect.sync(() => {
            const database = new Database(databasePath, {readonly: true, strict: true});
            try {
              return readCleanupHealthSurface(database);
            } finally {
              database.close(false);
            }
          }),
        ).toEqual(before);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('defers deep repair when database diagnosis is unreadable instead of discarding it', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-unreadable-');
    homes.push(home);
    const checkoutId = 'b'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const unreadable = new Database(databasePath, {strict: true});
    try {
      unreadable.exec('ALTER TABLE schema_metadata RENAME TO unreadable_schema_metadata_fixture');
    } finally {
      unreadable.close(false);
    }
    const progress: string[] = [];

    const repair = await runEffect(
      repairCodeGraphIndexes(
        home,
        false,
        state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`)),
        undefined,
        {mode: 'deep'},
      ),
    );

    expect(repair).toMatchObject({databases: 1, deferredDatabases: 1, discarded: 0});
    expect(progress).toEqual(['checking:none', 'deferred:unreadable-database']);
    await expect(Bun.file(databasePath).exists()).resolves.toBe(true);
    const preserved = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(
        preserved
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'unreadable_schema_metadata_fixture'")
          .get(),
      ).toEqual({name: 'unreadable_schema_metadata_fixture'});
    } finally {
      preserved.close(false);
    }
  });

  effectIt.effect('reports an interrupted extension revision and never discards the recoverable database', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-maintenance-extension-revision-'));
      homes.push(home);
      const checkoutId = 'd'.repeat(64);
      const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => makeRecoverableInterruptedExtension(databasePath));

      const progress: string[] = [];
      const doctorBefore = yield* codeGraphDoctorCheck(home);
      const repair = yield* repairCodeGraphIndexes(
        home,
        false,
        state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`)),
        undefined,
        {mode: 'deep'},
      );

      expect(doctorBefore).toMatchObject({status: 'fail'});
      expect(repair).toMatchObject({databases: 1, deferredDatabases: 1, discarded: 0});
      expect(progress).toEqual(['checking:none', 'deferred:schema-upgrade-on-use']);
      expect(yield* Effect.promise(() => Bun.file(databasePath).exists())).toBe(true);

      yield* store.initialize(databasePath);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('reports exact extension contract drift with a current receipt and preserves the database for self-healing', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-extension-contract-');
    homes.push(home);
    const checkoutId = 'e'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const drifted = new Database(databasePath, {strict: true});
    try {
      drifted.exec('PRAGMA foreign_keys = OFF');
      drifted.exec(`
        DROP TABLE snapshot_build_owners;
        CREATE TABLE snapshot_build_owners (
          snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id),
          owner_token TEXT NOT NULL,
          claimed_at TEXT NOT NULL
        );
      `);
    } finally {
      drifted.close(false);
    }

    const doctorBefore = await runEffect(codeGraphDoctorCheck(home));
    const repair = await runEffect(repairCodeGraphIndexes(home, false, undefined, undefined, {mode: 'deep'}));

    expect(doctorBefore).toMatchObject({status: 'fail'});
    expect(repair).toMatchObject({databases: 1, deferredDatabases: 1, discarded: 0});
    await expect(Bun.file(databasePath).exists()).resolves.toBe(true);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    await expect(runEffect(codeGraphDoctorCheck(home))).resolves.toMatchObject({status: 'ok'});
  });

  effectIt.effect('explicitly migrates recoverable schemas without waiting for a graph query', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-maintenance-explicit-migration-'));
      homes.push(home);
      const checkoutId = 'f'.repeat(64);
      const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => makeRecoverableInterruptedExtension(databasePath));

      const previewProgress: string[] = [];
      const preview = yield* repairCodeGraphIndexes(
        home,
        true,
        state => Effect.sync(() => previewProgress.push(state.phase)),
        undefined,
        {migrateSchema: true, mode: 'quick'},
      );
      expect(preview).toMatchObject({deferredDatabases: 0, migratedDatabases: 1});
      expect(previewProgress).toEqual(['checking', 'migrating-schema']);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'fail'});

      const repairProgress: string[] = [];
      const repair = yield* repairCodeGraphIndexes(
        home,
        false,
        state => Effect.sync(() => repairProgress.push(state.phase)),
        undefined,
        {migrateSchema: true, mode: 'quick'},
      );
      expect(repair).toMatchObject({deferredDatabases: 0, migratedDatabases: 1});
      expect(repairProgress).toEqual(['checking', 'migrating-schema']);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('prepares legacy reconciliation indexes before an explicit extension repair', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-repair-pre-index-revision-7-'));
      homes.push(home);
      const checkoutId = '7'.repeat(64);
      const databasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => makePreReconciliationIndexRevision7(databasePath));

      yield* Effect.acquireUseRelease(
        Effect.sync(() => new Database(databasePath, {strict: true})),
        keeper =>
          Effect.gen(function* () {
            // Keep committed WAL content present while preview connections close; a final writer close may
            // otherwise remove an empty sidecar without changing the database or committing the preview.
            yield* Effect.sync(() => {
              keeper.run('PRAGMA wal_autocheckpoint = 0');
              keeper
                .query('INSERT INTO schema_metadata (key, value) VALUES (?, ?)')
                .run('reconciliation_preview_fixture', 'committed-before-preview');
              expect(keeper.inTransaction).toBe(false);
            });
            const schemaBeforePreview = yield* Effect.sync(() => readReconciliationPreparationState(databasePath));
            const filesBeforePreview = yield* Effect.promise(() => readDatabaseDurabilityEvidence(databasePath));
            expect('bytes' in filesBeforePreview.wal && filesBeforePreview.wal.bytes > 32).toBe(true);
            const repeated = yield* Effect.forEach(
              [1, 2, 3, 4, 5],
              () => store.prepareWorktreeReconciliationIndexes(databasePath, {preview: true}),
              {concurrency: 1},
            );
            expect(repeated).toEqual(repeated.map(() => ({state: 'migration-ready'})));
            const typedFailure = yield* store
              .prepareWorktreeReconciliationIndexes(databasePath, {
                afterPreviewTransactionStarted: () => Effect.fail(TestError.make({message: 'stop preview'})),
                preview: true,
              })
              .pipe(Effect.exit);
            expect(Exit.isFailure(typedFailure)).toBe(true);
            const previewStarted = yield* Deferred.make<void>();
            const interruptedPreview = yield* Effect.forkChild(
              store.prepareWorktreeReconciliationIndexes(databasePath, {
                afterPreviewTransactionStarted: () =>
                  Deferred.succeed(previewStarted, undefined).pipe(Effect.andThen(Effect.never)),
                preview: true,
              }),
            );
            yield* Deferred.await(previewStarted);
            yield* Fiber.interrupt(interruptedPreview);
            const filesAfterPreview = yield* Effect.promise(() => readDatabaseDurabilityEvidence(databasePath));
            expect(filesAfterPreview).toEqual(filesBeforePreview);
            expect(yield* Effect.sync(() => readReconciliationPreparationState(databasePath))).toEqual(
              schemaBeforePreview,
            );
          }),
        keeper => Effect.sync(() => keeper.close(true)),
      );

      const preview = yield* repairCodeGraphIndexes(home, true, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
      });
      expect(preview).toMatchObject({deferredDatabases: 0, migratedDatabases: 1});
      expect(
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return {
              indexes: database
                .query(
                  `SELECT name FROM sqlite_master
                   WHERE type = 'index' AND name IN (
                     'active_snapshots_snapshot_worktree',
                     'snapshots_base_state_id',
                     'snapshot_leases_snapshot_expiry'
                   )`,
                )
                .all(),
              revision: database
                .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
                .get(),
            };
          } finally {
            database.close(false);
          }
        }),
      ).toEqual({indexes: [], revision: {value: '7'}});

      const progress: string[] = [];
      const repair = yield* repairCodeGraphIndexes(
        home,
        false,
        state => Effect.sync(() => progress.push(state.phase)),
        undefined,
        {migrateSchema: true, mode: 'quick'},
      );

      expect(repair).toEqual(preview);
      expect(progress).toEqual(['checking', 'migrating-schema']);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
      expect(
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return {
              indexes: database
                .query(
                  `SELECT name FROM sqlite_master
                   WHERE type = 'index' AND name IN (
                     'active_snapshots_snapshot_worktree',
                     'snapshots_base_state_id',
                     'snapshot_leases_snapshot_expiry'
                   )
                   ORDER BY name`,
                )
                .all(),
              revision: database
                .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
                .get(),
            };
          } finally {
            database.close(false);
          }
        }),
      ).toEqual({
        indexes: [
          {name: 'active_snapshots_snapshot_worktree'},
          {name: 'snapshot_leases_snapshot_expiry'},
          {name: 'snapshots_base_state_id'},
        ],
        revision: {value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)},
      });
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps revision-6 ready snapshots readable while background maintenance migrates them', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-background-revision-6-'));
      homes.push(home);
      const identity = legacyRepositoryIdentity(home, '6');
      const databasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const snapshot = legacyReadySnapshot(identity, '6');
      const store = yield* CodeGraphStore;
      yield* store.activate(databasePath, identity, snapshot, [], [], []);
      yield* store.promote(databasePath, identity, snapshot.id);
      yield* Effect.sync(() => downgradeToReleasedRevision6(databasePath));
      const legacyStore = yield* CodeGraphStore.pipe(provideTestLayer(CodeGraphStore.layer));

      const before = yield* diagnoseCodeGraphDatabaseReadOnly(databasePath, false);
      expect(before).toMatchObject({integrity: 'migration-pending', readySnapshots: 1});
      const doctor = yield* codeGraphDoctorCheck(home);
      expect(doctor.status).toBe('warn');
      expect(doctor.detail).toContain('remain usable while background schema migration is pending');
      expect(doctor.detail).not.toContain('disposable rebuild');
      expect(yield* legacyStore.loadGraph(databasePath, snapshot.id)).toMatchObject({edges: [], symbols: []});

      const lease = yield* legacyStore.acquireSnapshotLease(databasePath, snapshot.id, 60_000);
      expect((yield* legacyStore.readySnapshot(databasePath, identity.worktreeId))?.id).toBe(snapshot.id);
      yield* legacyStore.releaseSnapshotLease(databasePath, lease, {waitTimeoutMilliseconds: 0});
      const retained = yield* legacyStore.retainViewSnapshotLease(
        databasePath,
        identity.worktreeId,
        snapshot.id,
        60_000,
      );
      expect(retained.state).toBe('retained');
      if (retained.state === 'retained') {
        yield* legacyStore.releaseSnapshotLease(databasePath, retained.token, {waitTimeoutMilliseconds: 0});
      }
      expect(readPersistentExtensionRevision(databasePath)).toBe(6);
      const inspectedTarget = yield* inspectCodeGraphViewDatabaseTarget(home, identity.checkoutId);
      if (inspectedTarget.state !== 'ready') throw TestError.make({message: 'legacy graph target disappeared'});
      yield* Effect.sleep(100);

      const path = yield* Path.Path;
      const coordinator = yield* CodeGraphMaintenanceCoordinator;
      yield* Effect.forEach(
        Array.from({length: 12}),
        () =>
          coordinator
            .request({
              allowIndexPreparation: true,
              anchorIdentity: identity,
              checkoutId: identity.checkoutId,
              databasePath: inspectedTarget.databasePath,
              threadnoteHome: inspectedTarget.canonicalHome,
              writerLockPath: codeGraphDatabaseWriteLockPath(path, inspectedTarget.canonicalHome, identity.checkoutId),
            })
            .pipe(Effect.andThen(Effect.sleep(100))),
        {concurrency: 1},
      );

      expect({
        health: yield* diagnoseCodeGraphDatabaseReadOnly(databasePath, false),
        indexes: readReconciliationIndexes(databasePath),
        revision: readPersistentExtensionRevision(databasePath),
      }).toMatchObject({
        health: {integrity: 'ok', readySnapshots: 1},
        indexes: ['active_snapshots_snapshot_worktree', 'snapshot_leases_snapshot_expiry', 'snapshots_base_state_id'],
        revision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
      });
      expect((yield* legacyStore.readySnapshot(databasePath, identity.worktreeId))?.id).toBe(snapshot.id);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('repair migrates a released revision-6 store without dropping its ready graph', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-repair-revision-6-'));
      homes.push(home);
      const identity = legacyRepositoryIdentity(home, '8');
      const databasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const snapshot = legacyReadySnapshot(identity, '8');
      const store = yield* CodeGraphStore;
      yield* store.activate(databasePath, identity, snapshot, [], [], []);
      yield* store.promote(databasePath, identity, snapshot.id);
      yield* Effect.sync(() => downgradeToReleasedRevision6(databasePath));

      const repair = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
      });

      expect(repair).toMatchObject({deferredDatabases: 0, discarded: 0, migratedDatabases: 1});
      expect(readPersistentExtensionRevision(databasePath)).toBe(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION);
      expect((yield* store.readySnapshot(databasePath, identity.worktreeId))?.id).toBe(snapshot.id);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs one checkout while an unrelated checkout build remains active', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-targeted-repair-'));
      homes.push(home);
      const identity = legacyRepositoryIdentity(home, 'a');
      const databasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        identity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => downgradeToReleasedRevision6(databasePath));

      const otherCheckoutId = 'b'.repeat(64);
      const otherDatabasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        otherCheckoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      yield* store.initialize(otherDatabasePath);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const owner = yield* Effect.forkChild(
        withExclusiveFileLock(
          fs,
          codeGraphWorktreeLockPath(path, home, otherCheckoutId, 'c'.repeat(64)),
          {
            heartbeatIntervalMilliseconds: 20,
            onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
            retryIntervalMilliseconds: 5,
            staleAfterMilliseconds: 100,
            waitTimeoutMilliseconds: 5_000,
          },
          Deferred.await(release),
        ),
      );
      yield* Deferred.await(acquired);

      const repair = yield* repairCodeGraphIndexes(home, false, undefined, undefined, {
        migrateSchema: true,
        mode: 'quick',
        targetCheckoutId: identity.checkoutId,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);

      expect(repair).toMatchObject({databases: 1, deferredDatabases: 0, migratedDatabases: 1});
      expect(readPersistentExtensionRevision(databasePath)).toBe(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION);
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('exposes foreground schema migration through graph repair --all', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-repair-command-'));
      homes.push(home);
      const checkoutId = '1'.repeat(64);
      const databasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => makeRecoverableInterruptedExtension(databasePath));
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: join(home, 'manifest.yaml'),
        user: 'tester',
      };

      const output = yield* captureConsole(runCodeGraphRepair(config, {all: true, json: true}));

      expect(JSON.parse(output.output)).toMatchObject({
        doctor: {status: 'ok'},
        dryRun: false,
        mode: 'quick',
        summary: {deferredDatabases: 0, migratedDatabases: 1},
        type: 'code-graph-repair',
        version: 1,
      });
      expect(yield* codeGraphDoctorCheck(home)).toMatchObject({status: 'ok'});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function readCleanupHealthSurface(database: Database): {
  readonly metadata: readonly unknown[];
  readonly objects: readonly unknown[];
} {
  return {
    metadata: database
      .query(
        `SELECT key, value
         FROM schema_metadata
         WHERE key COLLATE NOCASE IN (
           'persistent_extension_schema_revision',
           'removed_view_cleanup_admission_cursor',
           'removed_view_cleanup_epoch_sequence'
         )
         ORDER BY key`,
      )
      .all(),
    objects: database
      .query(
        `SELECT name, type, sql
         FROM sqlite_master
         WHERE name LIKE 'removed_view_cleanup%'
            OR name LIKE 'removed_views_cleanup_revoke_%'
         ORDER BY name`,
      )
      .all(),
  };
}

function readReconciliationPreparationState(databasePath: string): {
  readonly metadata: readonly unknown[];
  readonly schema: readonly unknown[];
  readonly schemaVersion: unknown;
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      metadata: database.query('SELECT key, value FROM schema_metadata ORDER BY key').all(),
      schema: database
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE type IN ('index', 'table', 'trigger')
           ORDER BY type, name`,
        )
        .all(),
      schemaVersion: database.query('PRAGMA schema_version').get(),
    };
  } finally {
    database.close(false);
  }
}

async function readDatabaseDurabilityEvidence(databasePath: string): Promise<{
  readonly database: {readonly bytes: number; readonly sha256: string} | {readonly missing: true};
  readonly wal: {readonly bytes: number; readonly sha256: string} | {readonly missing: true};
}> {
  const inspect = async (filePath: string) => {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return {missing: true} as const;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      bytes: bytes.byteLength,
      sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    } as const;
  };
  return {database: await inspect(databasePath), wal: await inspect(`${databasePath}-wal`)};
}

function makeRecoverableInterruptedExtension(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('PRAGMA foreign_keys = OFF');
    database.run('BEGIN IMMEDIATE');
    try {
      for (const statement of legacyCodeGraphAuthorityStatements) database.exec(statement);
      database.exec(`
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update;
        DROP TABLE IF EXISTS removed_view_cleanup;
        DROP TABLE IF EXISTS snapshot_build_owner_instances;
        DROP TABLE IF EXISTS building_materialization_batches;
        DELETE FROM schema_metadata
        WHERE key IN (
          'persistent_extension_schema_revision',
          'removed_view_cleanup_admission_cursor',
          'removed_view_cleanup_epoch_sequence'
        );
      `);
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    } finally {
      database.run('PRAGMA foreign_keys = ON');
    }
  } finally {
    database.close(false);
  }
}

function makePreReconciliationIndexRevision7(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('BEGIN IMMEDIATE');
    try {
      for (const statement of legacyCodeGraphAuthorityStatements) database.exec(statement);
      database.exec(`
        DROP TRIGGER removed_views_cleanup_revoke_delete;
        DROP TRIGGER removed_views_cleanup_revoke_insert;
        DROP TRIGGER removed_views_cleanup_revoke_update;
        DROP TABLE removed_view_cleanup;
        DROP INDEX active_snapshots_snapshot_worktree;
        DROP INDEX snapshots_base_state_id;
        DROP INDEX snapshot_leases_snapshot_expiry;
        DELETE FROM schema_metadata
        WHERE key IN ('removed_view_cleanup_admission_cursor', 'removed_view_cleanup_epoch_sequence');
        UPDATE schema_metadata
        SET value = '7'
        WHERE key = 'persistent_extension_schema_revision';
      `);
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    }
  } finally {
    database.close(false);
  }
}

function downgradeToReleasedRevision6(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('PRAGMA foreign_keys = OFF');
    database.run('BEGIN IMMEDIATE');
    try {
      for (const statement of legacyCodeGraphAuthorityStatements) database.exec(statement);
      database.exec(`
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update;
        DROP TABLE IF EXISTS removed_view_cleanup;
        DROP TABLE IF EXISTS snapshot_build_owner_instances;
        DROP TABLE IF EXISTS snapshot_component_edge_aggregate_receipts;
        DROP TABLE IF EXISTS snapshot_component_edge_aggregates;
        DROP TABLE IF EXISTS removed_views;
        DROP INDEX IF EXISTS active_snapshots_snapshot_worktree;
        DROP INDEX IF EXISTS snapshots_base_state_id;
        DROP INDEX IF EXISTS snapshot_leases_snapshot_expiry;
        DROP INDEX IF EXISTS snapshot_files_raw_content_hash;
        ALTER TABLE snapshot_files DROP COLUMN raw_content_hash;
        DELETE FROM schema_metadata
        WHERE key IN ('removed_view_cleanup_admission_cursor', 'removed_view_cleanup_epoch_sequence');
        UPDATE schema_metadata
        SET value = '6'
        WHERE key = 'persistent_extension_schema_revision';
      `);
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    } finally {
      database.run('PRAGMA foreign_keys = ON');
    }
  } finally {
    database.close(false);
  }
}

function readPersistentExtensionRevision(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
      .get() as {readonly value: string};
    return Number(row.value);
  } finally {
    database.close(false);
  }
}

function readReconciliationIndexes(databasePath: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'active_snapshots_snapshot_worktree',
           'snapshot_leases_snapshot_expiry',
           'snapshots_base_state_id'
         )
         ORDER BY name`,
      )
      .all()
      .map(row => (row as {readonly name: string}).name);
  } finally {
    database.close(false);
  }
}

function legacyRepositoryIdentity(home: string, seed: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: seed.repeat(64),
    displayName: 'acme/legacy-graph',
    gitCommonDirectory: join(home, '.git'),
    headCommit: seed.repeat(40),
    objectFormat: 'sha1',
    repoRoot: home,
    repositoryId: seed.repeat(64),
    worktreeId: seed.repeat(64),
  };
}

function legacyReadySnapshot(identity: RepositoryIdentity, seed: string): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: '2026-08-10T00:00:00.000Z',
    dirty: false,
    edgeCount: 0,
    extractorSet: 'revision-6-regression',
    fileCount: 0,
    id: `cgsn_${seed.repeat(40)}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}

function repairBuildingSnapshot(identity: RepositoryIdentity, seed: string): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'repair-spool-regression',
    fileCount: 0,
    id: `cgsn_${seed.repeat(40)}-direct`,
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}
