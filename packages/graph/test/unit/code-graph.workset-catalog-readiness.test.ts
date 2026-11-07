import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, vi} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {codeGraphWorksetCatalogLayout} from '../../src/workset_catalog/layout.js';
import {initializeCodeGraphWorksetCatalogSchema} from '../../src/workset_catalog/schema.js';
import {readPublishedCodeGraphWorksetCatalogGeneration} from '../../src/workset_catalog/store.js';
import {
  useCatalogWriteDatabase,
  withCatalogReader,
  withCatalogWriter,
} from '../../src/workset_catalog/store_support.js';
import {CodeGraphWorksetCatalogError} from '../../src/workset_catalog/types.js';
import * as SqlClient from 'effect/sql/SqlClient';

const policy = Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.filename}),
  Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
);
const platform = Layer.mergeAll(BunServices.layer, cryptoLayer, SystemInfo.layer.pipe(Layer.provide(policy)));
const lockOptions = {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 30_000, waitTimeoutMilliseconds: 30_000};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-catalog-readiness-'});
  const layout = codeGraphWorksetCatalogLayout(path, home);
  yield* fs.makeDirectory(layout.root, {recursive: true});
  return {fs, home, layout};
});
const initialize = Effect.gen(function* () {
  yield* initializeCodeGraphWorksetCatalogSchema(yield* SqlClient.SqlClient);
});

// Observe the existing exclusive-create boundary, without adding a production hook.
function observeContention(fs: FileSystem.FileSystem, lockPath: string, contended: Deferred.Deferred<void>) {
  return FileSystem.FileSystem.of({
    ...fs,
    writeFileString: (candidate, data, options) =>
      fs
        .writeFileString(candidate, data, options)
        .pipe(
          Effect.tapError(() =>
            candidate === lockPath && options?.flag === 'wx' ? Deferred.succeed(contended, undefined) : Effect.void,
          ),
        ),
  });
}

const heldBootstrap = Effect.gen(function* () {
  const setup = yield* fixture;
  const opened = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const initialized = yield* Deferred.make<void>();
  const finish = yield* Deferred.make<void>();
  const writer = yield* withExclusiveFileLock(
    setup.fs,
    setup.layout.lockPath,
    lockOptions,
    useCatalogWriteDatabase(
      setup.layout.databasePath,
      Deferred.succeed(opened, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(initialize),
        Effect.andThen(Deferred.succeed(initialized, undefined)),
        Effect.andThen(Deferred.await(finish)),
      ),
    ),
  ).pipe(Effect.forkChild);
  yield* Deferred.await(opened);
  return {...setup, release, initialized, finish, writer};
});

describe('workset catalog reader admission', () => {
  effectIt.layer(platform)(it => {
    it.effect('waits for an opened bootstrap database to finish before reading publication metadata', () =>
      Effect.gen(function* () {
        const {fs, home, layout, release, initialized, finish, writer} = yield* heldBootstrap;
        const contended = yield* Deferred.make<void>();
        const reader = yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'unpublished').pipe(
          Effect.provideService(FileSystem.FileSystem, observeContention(fs, layout.lockPath, contended)),
          Effect.forkChild,
        );
        // Baseline fails with catalog-storage instead of reaching the lock barrier.
        yield* Effect.raceFirst(Deferred.await(contended), Fiber.join(reader).pipe(Effect.andThen(Effect.never)));
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(initialized);
        // A reader that already chose bootstrap admission still waits for the
        // first writer callback, even after later readers can see completion.
        expect(reader.pollUnsafe()).toBeUndefined();
        expect(yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'unpublished')).toBeUndefined();
        expect(reader.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(writer);
        expect(yield* Fiber.join(reader)).toBeUndefined();
      }).pipe(TestClock.withLive),
    );

    it.effect('keeps initialized readers concurrent with a normal writer and releases admission before callbacks', () =>
      Effect.gen(function* () {
        const {home} = yield* fixture;
        yield* withCatalogWriter(home, () => Effect.void);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* withCatalogWriter(home, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'unpublished')).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        expect(yield* withCatalogReader(home, () => withCatalogWriter(home, () => Effect.succeed('nested')))).toBe(
          'nested',
        );
      }).pipe(TestClock.withLive),
    );

    it.effect('reads one consistent legacy scope schema while an additive migration commits', () =>
      Effect.gen(function* () {
        const {home, layout} = yield* fixture;
        yield* withCatalogWriter(home, () => Effect.void);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => new Database(layout.databasePath)),
          database =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                for (const column of ['scope_id', 'definition_digest', 'closure_digest', 'completeness']) {
                  database.exec(`ALTER TABLE repository_snapshots DROP COLUMN ${column}`);
                }
                database.exec("DELETE FROM catalog_metadata WHERE key = 'scope_receipt_version'");
              });
              let migrated = false;
              const original = Database.prototype.query;
              const spy = vi.spyOn(Database.prototype, 'query').mockImplementation(function (this: Database, sql) {
                const statement = original.call(this, sql);
                if (sql === "SELECT value FROM catalog_metadata WHERE key = 'scope_receipt_version'" && !migrated) {
                  const all = statement.all.bind(statement);
                  vi.spyOn(statement, 'all').mockImplementationOnce((...parameters) => {
                    const rows = all(...parameters);
                    database.exec(`BEGIN;
                      ALTER TABLE repository_snapshots ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'full-repository';
                      ALTER TABLE repository_snapshots ADD COLUMN definition_digest TEXT;
                      ALTER TABLE repository_snapshots ADD COLUMN closure_digest TEXT;
                      ALTER TABLE repository_snapshots ADD COLUMN completeness TEXT NOT NULL DEFAULT 'legacy-full';
                      INSERT INTO catalog_metadata VALUES ('scope_receipt_version', '1');
                      COMMIT;`);
                    migrated = true;
                    return rows;
                  });
                }
                return statement;
              });
              yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'legacy').pipe(
                Effect.tap(value => Effect.sync(() => expect(value).toBeUndefined())),
                Effect.ensuring(Effect.sync(() => spy.mockRestore())),
              );
              expect(migrated).toBe(true);
              expect(yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'legacy')).toBeUndefined();
            }),
          database => Effect.sync(() => database.close()),
        );
      }).pipe(TestClock.withLive),
    );

    it.effect('leaves missing storage absent and preserves damaged or explicitly rejected catalogs', () =>
      Effect.gen(function* () {
        const {fs, home, layout} = yield* fixture;
        expect(yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'missing')).toBeUndefined();
        expect(yield* fs.exists(layout.lockPath)).toBe(false);
        yield* useCatalogWriteDatabase(layout.databasePath, Effect.void);
        expect(yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'damaged').pipe(Effect.flip)).toMatchObject({
          reason: 'storage',
        });
        const database = new Database(layout.databasePath, {readonly: true});
        try {
          expect(database.query('PRAGMA user_version').get()).toEqual({user_version: 0});
        } finally {
          database.close();
        }
        yield* withCatalogWriter(home, sql =>
          sql.unsafe('ALTER TABLE repository_snapshots DROP COLUMN closure_digest'),
        );
        expect(yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'partial').pipe(Effect.flip)).toMatchObject({
          reason: 'corrupt',
        });
      }).pipe(TestClock.withLive),
    );

    it.effect('preserves explicit incompatibility and storage errors from admitted readers', () =>
      Effect.gen(function* () {
        const {home} = yield* fixture;
        yield* withCatalogWriter(home, () => Effect.void);
        for (const reason of ['incompatible', 'storage'] as const) {
          const error = CodeGraphWorksetCatalogError.of(reason, 'fixture failure');
          expect(yield* withCatalogReader(home, () => Effect.fail(error)).pipe(Effect.flip)).toBe(error);
        }
      }).pipe(TestClock.withLive),
    );

    it.effect('cancels a waiting reader without releasing the initializing writer lock', () =>
      Effect.gen(function* () {
        const {fs, home, layout, release, initialized, finish, writer} = yield* heldBootstrap;
        const before = yield* fs.readFileString(layout.lockPath);
        const contended = yield* Deferred.make<void>();
        const reader = yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'unpublished').pipe(
          Effect.provideService(FileSystem.FileSystem, observeContention(fs, layout.lockPath, contended)),
          Effect.forkChild,
        );
        yield* Effect.raceFirst(Deferred.await(contended), Fiber.join(reader).pipe(Effect.andThen(Effect.never)));
        yield* Fiber.interrupt(reader);
        expect(yield* fs.readFileString(layout.lockPath)).toBe(before);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(initialized);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(writer);
        expect(yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'unpublished')).toBeUndefined();
        expect(yield* fs.exists(layout.lockPath)).toBe(false);
      }).pipe(TestClock.withLive),
    );
  });
});
