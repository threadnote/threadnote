import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {ResourceStore, assertResourceAccountCheck} from '@threadnote/store/resource-store';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {
  loadRecallMemoryIdentities,
  recallIndexDatabaseFilename,
  withRecallIdentityProjectionLease,
} from '@threadnote/recall/index';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'identity-projection-locks-test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: env => ({...env}),
        sanitizeExternal: env => ({...env}),
      }),
    ),
  ),
);
const base = Layer.mergeAll(BunServices.layer, system, recallResourceInvalidationLayer);
const layer = Layer.merge(base, ResourceStore.layer.pipe(Layer.provide(base)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const root = 'threadnote://user/me/memories/durable';
const source = `${root}/source.md`;
const target = `${root}/target.md`;
const body = (text: string) => `MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_target\n\n${text}`;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'identity-locks-'});
  const config = {account: 'local', agentContextHome: home, user: 'me'};
  const location = {home, account: 'local', user: 'me'};
  const store = yield* ResourceStore;
  const filename = recallIndexDatabaseFilename(false);
  const database = path.join(home, 'indexes', 'lexical', filename);
  const indexLock = path.join(home, 'locks', 'indexes', 'lexical', `${filename}.lock`);
  const targetLock = path.join(home, 'locks', 'test-target.lock');
  const query = loadRecallMemoryIdentities(config, {
    allowedUriScopes: [root],
    memoryIds: ['tn_target'],
    engine: 'identity-projection',
  });
  const targets = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withExclusiveFileLock(
      fs,
      targetLock,
      {
        heartbeatIntervalMilliseconds: 10000,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 30000,
        waitTimeoutMilliseconds: 30000,
      },
      effect,
    );
  yield* store.write(location, target, body('before'), {mode: 'create'});
  return {fs, path, home, config, location, store, database, indexLock, targetLock, query, targets};
});

it.effect(
  'reconciles a stale checked write under actual target -> index/client -> account ownership and revokes grants',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.query;
      yield* f.store.write(f.location, target, body('changed'), {mode: 'replace'});
      let expiredProof: Effect.Effect<void, unknown> = Effect.void;
      let expiredLease: Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path> = Effect.void;
      const checked = Effect.gen(function* () {
        expect(yield* f.fs.exists(f.targetLock)).toBe(true);
        expect(yield* f.fs.exists(f.indexLock)).toBe(true);
        expect(yield* f.fs.exists(resourceAccountMutationLockPath(f.path, f.home, 'local'))).toBe(true);
        const before = yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
        expect((yield* f.query)[0]?.text).toContain('changed');
        expect(yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local')).toBe(before);
        expect((yield* Effect.result(assertResourceAccountCheck(f.home, 'foreign')))._tag).toBe('Failure');
        const child = yield* f.query.pipe(Effect.result, Effect.forkChild({startImmediately: true}));
        expect((yield* Fiber.join(child))._tag).toBe('Failure');
        const context = yield* Effect.context<Effect.Services<typeof f.query>>();
        expiredProof = assertResourceAccountCheck(f.home, 'local').pipe(Effect.provide(context));
        expiredLease = f.query.pipe(Effect.provide(context));
      });
      yield* f.targets(
        withRecallIdentityProjectionLease(
          f.config,
          f.store.writeChecked(f.location, source, 'new source', {mode: 'create'}, checked),
        ),
      );
      expect((yield* Effect.result(expiredProof))._tag).toBe('Failure');
      expect((yield* Effect.result(expiredLease))._tag).toBe('Failure');
      expect(yield* f.fs.exists(f.indexLock)).toBe(false);
      expect(yield* f.fs.exists(f.targetLock)).toBe(false);
      expect(yield* f.store.read(f.location, source)).toBe('new source');
      // CHECK never advances the identity cursor past the canonical write that follows it.
      expect((yield* f.query)[0]?.text).toContain('changed');
    }).pipe(TestClock.withLive, provide),
);

it.effect(
  'rejects a checked query without a lease and unwinds on corruption/pointer drift without canonical mutation',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.query;
      for (const fault of ['absent-lease', 'corrupt', 'pointer', 'malformed-pointer']) {
        const generation = yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
        const check = Effect.gen(function* () {
          if (fault === 'corrupt')
            yield* Effect.sync(() => {
              const db = new Database(f.database);
              try {
                db.exec("UPDATE identity_documents SET candidate_json = '{}'");
              } finally {
                db.close();
              }
            });
          if (fault === 'malformed-pointer')
            yield* f.fs.writeFileString(f.database.replace(/\.sqlite$/, '.pointer.json'), '{broken');
          if (fault === 'pointer') {
            const replacement = f.path.join(f.home, 'indexes', 'lexical', 'generations', 'drift.sqlite');
            yield* f.fs.makeDirectory(f.path.dirname(replacement), {recursive: true});
            yield* f.fs.writeFileString(replacement, 'not a database');
            yield* f.fs.writeFileString(
              f.database.replace(/\.sqlite$/, '.pointer.json'),
              JSON.stringify({version: 1, database: 'generations/drift.sqlite'}),
            );
          }
          yield* f.query;
        });
        const write = f.store.writeChecked(f.location, source, fault, {mode: 'create'}, check);
        const result = yield* Effect.result(
          fault === 'absent-lease' ? write : f.targets(withRecallIdentityProjectionLease(f.config, write)),
        );
        expect(result._tag, fault).toBe('Failure');
        expect(yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local')).toBe(generation);
        expect(yield* f.fs.exists(f.indexLock)).toBe(false);
        expect((yield* Effect.result(f.store.read(f.location, source)))._tag).toBe('Failure');
        if (fault === 'pointer' || fault === 'malformed-pointer')
          yield* f.fs.remove(f.database.replace(/\.sqlite$/, '.pointer.json'));
        // Ordinary admission can repair logical corruption once every CHECK lease has unwound.
        yield* f.query;
      }
    }).pipe(TestClock.withLive, provide),
);

it.effect(
  'refuses denied database/auxiliary/directory probes inside CHECK without fallback or canonical mutation',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.query;
      for (const denied of [f.database, `${f.database}-wal`, `${f.database}-shm`, 'directory']) {
        const generation = yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
        let refusals = 0;
        const restricted = FileSystem.make({
          ...f.fs,
          access: (value, options) => {
            if (denied === 'directory') {
              refusals++;
              return f.fs.access(`${f.database}.missing`, options);
            }
            return f.fs.access(value, options);
          },
          open: (value, options) => {
            if (value === denied) {
              refusals++;
              return f.fs.open(`${f.database}.missing`, {flag: 'r'});
            }
            return f.fs.open(value, options);
          },
        });
        const check = f.query.pipe(Effect.provideService(FileSystem.FileSystem, restricted), Effect.asVoid);
        const result = yield* Effect.result(
          f.targets(
            withRecallIdentityProjectionLease(
              f.config,
              f.store.writeChecked(f.location, source, 'denied probe', {mode: 'create'}, check),
            ),
          ),
        );
        expect(result._tag, denied).toBe('Failure');
        expect(refusals).toBeGreaterThan(0);
        expect(yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local')).toBe(generation);
        expect(yield* f.fs.exists(f.indexLock)).toBe(false);
        expect((yield* Effect.result(f.store.read(f.location, source)))._tag).toBe('Failure');
      }
    }).pipe(TestClock.withLive, provide),
);

it.effect('waits for a generation-before-bytes writer and observes its settled postimage', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.query;
    const previous = yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
    const paused = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const targetPath = yield* f.fs.realPath(
      f.path.join(f.home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'target.md'),
    );
    const wrapped = new Proxy(f.fs, {
      get(actual, key, receiver) {
        if (key !== 'rename') return Reflect.get(actual, key, receiver);
        return (from: string, to: string) =>
          to === targetPath
            ? Deferred.succeed(paused, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(actual.rename(from, to)),
              )
            : actual.rename(from, to);
      },
    });
    const storeContext = yield* Layer.build(
      ResourceStore.layerWith().pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, wrapped)), Layer.provide(base)),
    );
    const store = yield* ResourceStore.pipe(Effect.provide(storeContext));
    const writer = yield* store
      .write(f.location, target, body('settled'), {mode: 'replace'})
      .pipe(Effect.forkChild({startImmediately: true}));
    yield* Effect.raceFirst(
      Deferred.await(paused),
      Fiber.await(writer).pipe(
        Effect.andThen(Effect.die('Writer completed before the generation-before-bytes pause.')),
      ),
    );
    expect(yield* readCanonicalMutationGeneration(f.fs, f.path, f.home, 'local')).not.toBe(previous);
    expect(yield* f.store.read(f.location, target)).toBe(body('before'));
    let completed = false;
    const reader = yield* f.query.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          completed = true;
        }),
      ),
      Effect.forkChild({startImmediately: true}),
    );
    yield* f.fs.exists(f.indexLock).pipe(Effect.repeat({until: Boolean}), Effect.timeout('5 seconds'));
    expect(completed).toBe(false);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(writer);
    expect((yield* Fiber.join(reader))[0]?.text).toContain('settled');
  }).pipe(TestClock.withLive, provide),
);
