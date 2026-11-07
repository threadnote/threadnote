import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {
  Array as EffectArray,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Result,
  Schema,
} from 'effect';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {
  advanceCanonicalMutationGeneration,
  canonicalMutationInvalidationIsCurrent,
  withCanonicalMutationLock,
} from '@threadnote/store/resource/mutation_generation';
import {resourceAccountMutationLockPath, resourceAccountMutationLockPolicy} from '@threadnote/store/resource/lock';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  expireRecallIndexValidation,
  recallIndexDatabaseFilename,
  withRecallIdentityAdmission,
} from '@threadnote/recall/index';
import {resolveMemoryIdentityAliases} from '@threadnote/recall/memory/identity';
import {readRecallIdentityAdmissionCut} from '../../src/index/admission.js';
import {recallLogicalScope} from '../../src/index/freshness.js';
import {withRecallPublicationLock} from '../../src/index/stale_marker.js';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => environment,
        sanitizeExternal: environment => environment,
      }),
    ),
  ),
);
const platform = Layer.mergeAll(
  BunServices.layer,
  cryptoLayer,
  system,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const dependencies = Layer.merge(platform, ResourceStore.layer.pipe(Layer.provide(platform)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(dependencies).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const memory = (body: string) =>
  EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'memory_id: tn_fixture',
      'source_agent_client: test',
      'timestamp: 2026-11-03T00:00:00.000Z',
      '',
      body,
    ],
    '\n',
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-admission-'});
  const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories', 'durable');
  yield* fs.makeDirectory(root, {recursive: true});
  yield* fs.writeFileString(path.join(root, 'fixture.md'), memory('Pinned evidence.'));
  const config = {account: 'local', agentContextHome: home, user: 'tester'};
  const resolve = resolveMemoryIdentityAliases(
    config,
    ['threadnote://memory/tn_fixture'],
    ['threadnote://user/tester/memories'],
  );
  const database = path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false));
  const mutate = advanceCanonicalMutationGeneration(fs, path, home, config.account).pipe(Effect.asVoid);
  const fence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withExclusiveFileLock(
      fs,
      resourceAccountMutationLockPath(path, home, config.account),
      resourceAccountMutationLockPolicy,
      effect,
    );
  return {fs, path, home, root, config, resolve, database, mutate, fence};
});

effectIt.effect('warms a cold corpus before admission and never scans or refreshes inside the commit fence', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let scans = 0;
    const observed = FileSystem.FileSystem.of({
      ...f.fs,
      readDirectory: (name, options) =>
        f.fs.readDirectory(name, options).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              scans++;
            }),
          ),
        ),
    });
    yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check =>
      Effect.gen(function* () {
        expect(scans).toBeGreaterThan(0);
        const preparedScans = scans;
        yield* f.fence(check);
        expect(scans).toBe(preparedScans);
        expect(yield* check.pipe(Effect.flip)).toMatchObject({_tag: 'RecallIdentityAdmissionBusy'});
      }),
    ).pipe(Effect.provideService(FileSystem.FileSystem, observed));
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect('revokes escaped checks and rejects use from a different fiber', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let escaped: Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> | undefined;
    yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check =>
      Effect.gen(function* () {
        escaped = check;
        const child = yield* check.pipe(Effect.result, Effect.forkChild);
        const result = yield* Fiber.join(child);
        expect(Result.isFailure(result)).toBe(true);
        yield* f.fence(check);
      }),
    );
    expect(yield* escaped!.pipe(Effect.flip)).toMatchObject({_tag: 'RecallIdentityAdmissionBusy'});
  }).pipe(provide, TestClock.withLive),
);

for (const change of ['canonical', 'stale-only', 'integrity', 'pointer', 'inode'] as const)
  effectIt.effect(`refuses a changed ${change} readiness cut without inline repair`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check =>
        Effect.gen(function* () {
          if (change === 'canonical') yield* f.fence(f.mutate);
          if (change === 'stale-only') {
            // The gate prevents supported marker writers. A pre-existing on-disk drift still fails closed.
            yield* f.fs.writeFileString(f.database + '.stale', 'external-stale-generation');
          }
          if (change === 'integrity')
            yield* Effect.sync(() => {
              const db = new Database(f.database);
              try {
                db.run("UPDATE metadata SET value = 'not-current' WHERE key = 'integrity_sequence'");
              } finally {
                db.close();
              }
            });
          if (change === 'pointer') {
            const alternative = f.path.join(f.home, 'indexes', 'lexical', 'generations', 'replacement.sqlite');
            yield* f.fs.makeDirectory(f.path.dirname(alternative), {recursive: true});
            yield* f.fs.copyFile(f.database, alternative);
            yield* f.fs.writeFileString(
              EffectString.replace(/\.sqlite$/, '.pointer.json')(f.database),
              JSON.stringify({version: 1, database: 'generations/replacement.sqlite'}),
            );
          }
          if (change === 'inode') {
            yield* f.fs.copyFile(f.database, f.database + '.replacement');
            yield* f.fs.rename(f.database + '.replacement', f.database);
          }
          expect(yield* f.fence(check).pipe(Effect.flip)).toMatchObject({_tag: 'RecallIdentityAdmissionBusy'});
        }),
      );
    }).pipe(provide, TestClock.withLive),
  );

effectIt.effect('rebuilds the proof after an earlier child write and rejects a newly conflicting identity', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check =>
      Effect.gen(function* () {
        yield* f.fence(f.mutate);
        expect(yield* f.fence(check).pipe(Effect.flip)).toMatchObject({_tag: 'RecallIdentityAdmissionBusy'});
      }),
    );
    yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check => f.fence(check));
    yield* f.fence(
      f.fs
        .writeFileString(f.path.join(f.root, 'duplicate.md'), memory('Conflicting evidence.'))
        .pipe(Effect.andThen(f.mutate)),
    );
    const conflict = yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check =>
      f.fence(check),
    ).pipe(Effect.flip);
    expect(conflict).toMatchObject({reason: 'ambiguous'});
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect('uses a no-wait SQLite read for the final check', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const db = new Database(f.database);
          db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
          return db;
        }),
        () =>
          Effect.gen(function* () {
            const started = performance.now();
            expect(yield* check.pipe(Effect.flip)).toMatchObject({_tag: 'RecallIdentityAdmissionBusy'});
            expect(performance.now() - started).toBeLessThan(4000);
          }),
        db =>
          Effect.sync(() => {
            db.exec('ROLLBACK');
            db.close();
          }),
      ),
    );
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect.prop(
  'rejects every managed mutation history after the prepared cut',
  {
    operations: Schema.Array(Schema.Literals(['none', 'canonical', 'stale'])).check(Schema.isMaxLength(5)),
  },
  ({operations}) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check =>
        Effect.gen(function* () {
          for (const operation of operations) {
            if (operation === 'canonical') yield* f.fence(f.mutate);
            if (operation === 'stale') yield* expireRecallIndexValidation(f.home, false);
          }
          yield* f.fence(check);
        }),
      ).pipe(Effect.result);
      expect(Result.isSuccess(result)).toBe(EffectArray.every(operations, operation => operation === 'none'));
    }).pipe(provide, TestClock.withLive),
  {arbitrary: {runs: 20}},
);

for (const boundary of ['lexical', 'canonical'] as const)
  effectIt.effect(`fails fast at ${boundary} readiness admission before any memory critical section`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let prepared = false;
      let entered = false;
      const attempt = withRecallIdentityAdmission(
        f.config,
        Effect.sync(() => {
          prepared = true;
        }),
        check =>
          Effect.sync(() => {
            entered = true;
          }).pipe(Effect.andThen(check)),
      );
      const lockPath =
        boundary === 'canonical'
          ? resourceAccountMutationLockPath(f.path, f.home, f.config.account)
          : f.path.join(f.home, 'locks', 'indexes', 'lexical', recallIndexDatabaseFilename(false) + '.lock');
      const started = performance.now();
      const error = yield* withExclusiveFileLock(f.fs, lockPath, resourceAccountMutationLockPolicy, attempt).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({_tag: 'RecallIdentityAdmissionBusy'});
      expect(performance.now() - started).toBeLessThan(4000);
      expect(prepared).toBe(false);
      expect(entered).toBe(false);
      expect(yield* f.fs.exists(f.path.join(f.home, 'threadnote', 'memory-locks'))).toBe(false);
    }).pipe(provide, TestClock.withLive),
  );

effectIt.effect('does not wait on a SQLite writer during normal preparation', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check => f.fence(check));
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const db = new Database(f.database);
        db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
        return db;
      }),
      () =>
        Effect.gen(function* () {
          const started = performance.now();
          const error = yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check =>
            f.fence(check),
          ).pipe(Effect.flip);
          expect(error).toMatchObject({_tag: 'RecallIdentityAdmissionBusy'});
          expect(performance.now() - started).toBeLessThan(4000);
        }),
      db =>
        Effect.sync(() => {
          db.exec('ROLLBACK');
          db.close();
        }),
    );
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect('interrupts slow preparation before admitting a memory critical section', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const preparing = yield* Deferred.make<void>();
    let entered = false;
    let cleaned = false;
    const prepare = Deferred.succeed(preparing, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(
        Effect.sync(() => {
          cleaned = true;
        }),
      ),
    );
    const child = yield* withRecallIdentityAdmission(f.config, prepare, () =>
      Effect.sync(() => {
        entered = true;
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(preparing);
    yield* Fiber.interrupt(child);
    expect(cleaned).toBe(true);
    expect(entered).toBe(false);
    yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check => f.fence(check));
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect('preserves programming defects in read-only readiness checks', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const defect = new Error('unexpected admission defect');
    const exit = yield* readRecallIdentityAdmissionCut({
      account: f.config.account,
      home: f.home,
      databasePath: Effect.die(defect),
      pointerPath: f.database + '.pointer.json',
      fixedDatabasePath: f.database,
      schemaVersion: 13,
      logicalScope: recallLogicalScope(f.config, false),
    }).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect);
  }).pipe(provide),
);

effectIt.effect('revokes inherited publication and canonical capabilities after their real locks release', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const scope = yield* Effect.scope;
    const release = yield* Deferred.make<void>();
    const lockPath = f.path.join(f.home, 'locks', 'indexes', 'lexical', recallIndexDatabaseFilename(false) + '.lock');
    const child = yield* withRecallPublicationLock(
      f.fs,
      lockPath,
      resourceAccountMutationLockPolicy,
      withCanonicalMutationLock(
        f.fs,
        f.path,
        f.home,
        f.config.account,
        resourceAccountMutationLockPolicy,
        Effect.gen(function* () {
          const transition = yield* advanceCanonicalMutationGeneration(f.fs, f.path, f.home, f.config.account);
          expect(yield* canonicalMutationInvalidationIsCurrent(f.home, f.config.account, transition)).toBe(true);
          return yield* Deferred.await(release).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const current = yield* canonicalMutationInvalidationIsCurrent(f.home, f.config.account, transition);
                const publication = yield* expireRecallIndexValidation(f.home, false, [], transition).pipe(
                  Effect.result,
                );
                return {current, publication};
              }),
            ),
            Effect.forkIn(scope),
          );
        }),
      ),
    );
    const result = yield* withExclusiveFileLock(
      f.fs,
      lockPath,
      resourceAccountMutationLockPolicy,
      Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(child))),
    );
    expect(result.current).toBe(false);
    expect(result.publication).toMatchObject({_tag: 'Failure', failure: {_tag: 'FileLockTimeout'}});
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect('releases admission publication locks when an admitted callback is interrupted', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const child = yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(child);
    yield* withRecallIdentityAdmission(f.config, f.resolve.pipe(Effect.asVoid), check => f.fence(check));
  }).pipe(provide, TestClock.withLive),
);
