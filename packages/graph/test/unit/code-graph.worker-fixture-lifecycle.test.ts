import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Cause, Clock, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path} from 'effect';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {TestError} from '@threadnote/testing/test-error';
import {fileURLToPath} from '@threadnote/testing/node-url';
import {BackgroundInferenceAdmission} from '@threadnote/inference/background/admission';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  createBackgroundWorkerFixtureDrain,
  drainBackgroundWorkerFixture,
  makeBackgroundWorkerLifecycle,
  wakeBackgroundWorker,
  type BackgroundWorkerControlOptions,
} from '@threadnote/inference/background/worker-control';
import {CodeGraphStore} from '../../src/store.js';
import {
  codeGraphEmbeddingWorkerLockPath,
  codeGraphEmbeddingWorkerReceiptPath,
  codeGraphLayout,
} from '../../src/layout.js';
import {initializeSchema} from '../../src/store/schema/initialization.js';
import {enqueueCodeGraphEmbeddingDemandSql, readCodeGraphEmbeddingDemandPage} from '../../src/vector/demand.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../../src/index_scope.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '../../src/types.js';
import {CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION} from '../../src/worker_protocol.js';
import {runCodeGraphEmbeddingWorker} from '../../src/vector/worker.js';

const policy = Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: fileURLToPath(import.meta.url)}),
  Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
);
const platform = Layer.mergeAll(BunServices.layer, cryptoLayer, SystemInfo.layer.pipe(Layer.provide(policy)));
const unused = () => Effect.die('Empty lifecycle catalogs must not access inference.');
const inference = Layer.mergeAll(
  Layer.succeed(BackgroundInferenceAdmission, {withForeground: unused, withExecution: unused, runBatch: unused}),
  Layer.succeed(LocalModelCatalog, {get: unused, list: unused, selected: unused}),
  Layer.succeed(LocalModelStore, {
    install: unused,
    remove: unused,
    status: unused,
    verify: unused,
    path: () => {
      throw TestError.make({message: 'Unexpected model path lookup.'});
    },
  }),
  Layer.succeed(LocalModelRuntime, {diagnostics: unused(), embedMany: unused, generate: unused, rerank: unused}),
);
const narrow = Layer.merge(CodeGraphStore.layer.pipe(Layer.provideMerge(platform)), inference);
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(narrow).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context))))).pipe(
    TestClock.withLive,
  );

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const actual = yield* SystemInfo;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'graph-worker-lifecycle-'}));
  const home = path.join(root, 'home');
  for (const name of ['home', 'repository', 'installationRoot']) yield* fs.makeDirectory(path.join(root, name));
  const childPid = 1000001;
  const identities = new Map<number, string | undefined>([
    [actual.processId, 'fixture-parent'],
    [childPid, 'fixture-child'],
  ]);
  const parent = SystemInfo.of({
    ...actual,
    homeDirectory: home,
    environment: () => ({
      HOME: home,
      USERPROFILE: home,
      THREADNOTE_HOME: home,
      THREADNOTE_INSTALL_ROOT: path.join(root, 'installationRoot'),
    }),
    isProcessRunning: pid => identities.has(pid),
    processStartIdentity: pid => Effect.succeed(identities.get(pid)),
    canonicalProcessStartIdentity: pid => Effect.succeed(identities.get(pid)),
  });
  const child = SystemInfo.of({...parent, processId: childPid});
  const nonces: string[] = [];
  const control: BackgroundWorkerControlOptions = {
    home,
    receiptPath: codeGraphEmbeddingWorkerReceiptPath(path, home),
    lockPath: codeGraphEmbeddingWorkerLockPath(path, home),
    protocol: CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION,
    version: 'fixture-graph-lifecycle',
    launch: nonce =>
      Effect.sync(() => {
        nonces.push(nonce);
        return true;
      }),
  };
  const asParent = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(Effect.provideService(SystemInfo, parent));
  const asChild = <A, E, R>(program: Effect.Effect<A, E, R>) => program.pipe(Effect.provideService(SystemInfo, child));
  const capability = yield* asParent(
    createBackgroundWorkerFixtureDrain(control, {fixtureRoot: root, expectedExecutablePath: actual.executablePath}),
  );
  yield* asParent(wakeBackgroundWorker(control));
  const nonce = nonces[0];
  const lifecycle = yield* asChild(makeBackgroundWorkerLifecycle(control, nonce));
  const state = () =>
    fs.readFileString(control.receiptPath + '.launch-v2.json').pipe(Effect.map(text => JSON.parse(text)));
  const closed = yield* Deferred.make<void>();
  const observedFs = FileSystem.FileSystem.of({
    ...fs,
    rename: (from, to) =>
      fs
        .rename(from, to)
        .pipe(
          Effect.tap(() =>
            to === control.receiptPath + '.launch-v2.json'
              ? state().pipe(
                  Effect.flatMap(value =>
                    value.fixture.phase === 'closing' ? Deferred.succeed(closed, undefined) : Effect.void,
                  ),
                )
              : Effect.void,
          ),
        ),
  });
  const drain = Effect.gen(function* () {
    return yield* asParent(drainBackgroundWorkerFixture(capability, (yield* Clock.currentTimeMillis) + 2000)).pipe(
      Effect.provideService(FileSystem.FileSystem, observedFs),
    );
  });
  return {
    fs,
    path,
    root,
    home,
    actual,
    parent,
    child,
    childPid,
    identities,
    control,
    nonce,
    lifecycle,
    capability,
    state,
    closed,
    drain,
    asParent,
    asChild,
  };
});

effectIt.effect(
  'the real graph consumer registers before activation and releases its lock before lifecycle finalization',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const events: string[] = [];
      let registered: unknown;
      const lifecycle = {
        ...f.lifecycle,
        register: (owner: Parameters<typeof f.lifecycle.register>[0]) =>
          f.lifecycle.register(owner).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                expect(yield* f.fs.exists(f.control.lockPath)).toBe(false);
                registered = owner;
                events.push('registered');
              }),
            ),
          ),
        activate: (owner: Parameters<typeof f.lifecycle.activate>[0]) =>
          Effect.gen(function* () {
            expect(owner).toBe(registered);
            expect(yield* f.fs.exists(f.control.lockPath)).toBe(true);
            events.push('activated');
            return yield* f.lifecycle.activate(owner);
          }),
        afterRelease: (normal: boolean) =>
          Effect.gen(function* () {
            expect(yield* f.fs.exists(f.control.lockPath)).toBe(false);
            events.push('released');
            yield* f.lifecycle.afterRelease(normal);
          }),
      };
      yield* f.asChild(
        runCodeGraphEmbeddingWorker(f.home, {
          version: f.control.version,
          lifecycle,
          idleGraceMilliseconds: 0,
          catalogPage: () =>
            Effect.sync(() => {
              events.push('scan');
              return {checkoutIds: []};
            }),
        }),
      );
      expect(events).toEqual(['registered', 'activated', 'scan', 'released']);
      expect((yield* f.state()).fixture.launches[0].owner).toEqual(registered);
      expect((yield* f.state()).active).toBeUndefined();
      expect(yield* f.fs.exists(f.control.receiptPath)).toBe(false);
      const barrier = yield* Effect.forkScoped(f.drain);
      yield* Deferred.await(f.closed);
      expect(barrier.pollUnsafe()).toBeUndefined();
      f.identities.delete(f.childPid);
      expect(yield* Fiber.join(barrier)).toMatchObject({state: 'drained', generationCount: 1});
    }).pipe(provide),
);

effectIt.effect('a lock-losing real consumer still registers its process without clearing the other owner lock', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    let scans = 0;
    yield* f.asParent(
      withExclusiveFileLock(
        f.fs,
        f.control.lockPath,
        {
          createParentDirectory: false,
          retryIntervalMilliseconds: 1,
          staleAfterMilliseconds: 120000,
          waitTimeoutMilliseconds: 0,
        },
        Effect.gen(function* () {
          const before = yield* f.fs.readFileString(f.control.lockPath);
          yield* f.asChild(
            runCodeGraphEmbeddingWorker(f.home, {
              version: f.control.version,
              lifecycle: f.lifecycle,
              catalogPage: () =>
                Effect.sync(() => {
                  scans++;
                  return {checkoutIds: []};
                }),
            }),
          );
          expect((yield* f.state()).fixture.launches[0].owner.processId).toBe(f.childPid);
          expect(yield* f.fs.readFileString(f.control.lockPath)).toBe(before);
          expect(scans).toBe(0);
        }),
      ),
    );
    f.identities.delete(f.childPid);
    expect(yield* f.drain).toMatchObject({state: 'drained', generationCount: 1});
  }).pipe(provide),
);

effectIt.effect('a delayed real consumer registers but starts no scan after fixture closing', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const barrier = yield* Effect.forkScoped(f.drain);
    yield* Deferred.await(f.closed);
    let scans = 0;
    yield* f.asChild(
      runCodeGraphEmbeddingWorker(f.home, {
        version: f.control.version,
        lifecycle: f.lifecycle,
        catalogPage: () =>
          Effect.sync(() => {
            scans++;
            return {checkoutIds: []};
          }),
      }),
    );
    expect(scans).toBe(0);
    expect((yield* f.state()).fixture.launches[0].owner.processId).toBe(f.childPid);
    expect(barrier.pollUnsafe()).toBeUndefined();
    f.identities.delete(f.childPid);
    expect(yield* Fiber.join(barrier)).toMatchObject({state: 'drained', generationCount: 1});
  }).pipe(provide),
);

for (const refusal of ['version', 'executable', 'unknown-identity'] as const) {
  effectIt.effect(`the real consumer keeps ${refusal} refusal fail-closed before scanning`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (refusal === 'unknown-identity') f.identities.set(f.childPid, undefined);
      const child =
        refusal === 'executable'
          ? SystemInfo.of({...f.child, executablePath: fileURLToPath(import.meta.url)})
          : f.child;
      const lifecycle = yield* makeBackgroundWorkerLifecycle(
        refusal === 'version' ? {...f.control, version: 'wrong-version'} : f.control,
        f.nonce,
      ).pipe(Effect.provideService(SystemInfo, child));
      let scans = 0;
      const result = yield* runCodeGraphEmbeddingWorker(f.home, {
        version: f.control.version,
        lifecycle,
        catalogPage: () =>
          Effect.sync(() => {
            scans++;
            return {checkoutIds: []};
          }),
      }).pipe(Effect.provideService(SystemInfo, child), Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toMatchObject(
          refusal === 'unknown-identity'
            ? {_tag: 'CodeGraphEmbeddingWorkerSuperseded'}
            : {_tag: 'BackgroundWorkerFixtureDrainUnavailable', reason: 'ownership'},
        );
      expect(scans).toBe(0);
      expect((yield* f.state()).fixture.launches[0].owner).toBeUndefined();
    }).pipe(provide),
  );
}

fcEffectProp(
  effectIt,
  'finite scan/close schedules never start a new catalog page after closing',
  {pages: fc.integer({min: 1, max: 5})},
  ({pages}) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reached = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      let scans = 0;
      const worker = yield* Effect.forkScoped(
        f.asChild(
          runCodeGraphEmbeddingWorker(f.home, {
            version: f.control.version,
            lifecycle: f.lifecycle,
            catalogPage: () =>
              Effect.gen(function* () {
                scans++;
                if (scans === pages) {
                  yield* Deferred.succeed(reached, undefined);
                  yield* Deferred.await(release);
                }
                return {checkoutIds: [], after: String(scans)};
              }),
          }),
        ),
      );
      yield* Deferred.await(reached);
      const barrier = yield* Effect.forkScoped(f.drain);
      yield* Deferred.await(f.closed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(worker);
      expect(scans).toBe(pages);
      expect(barrier.pollUnsafe()).toBeUndefined();
      const state = yield* f.state();
      expect(state.fixture.phase).toBe('closing');
      expect(state.fixture.launches).toHaveLength(1);
      expect(state.fixture.launches[0]).toMatchObject({nonce: f.nonce, owner: {processId: f.childPid}});
      f.identities.delete(f.childPid);
      expect(yield* Fiber.join(barrier)).toMatchObject({state: 'drained', generationCount: 1});
    }).pipe(provide),
  {fastCheck: {numRuns: 8}},
);

for (const boundary of ['lane', 'demand-page'] as const) {
  effectIt.effect(`closing a populated ${boundary} boundary stops the next real consumer unit and session`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const store = yield* CodeGraphStore;
      const checkoutIds =
        boundary === 'lane'
          ? [EffectString.repeat(64)('a')]
          : [EffectString.repeat(64)('a'), EffectString.repeat(64)('b')];
      const databases: string[] = [];
      const sqls: SqlClient.SqlClient[] = [];
      for (const checkoutId of checkoutIds) {
        const database = codeGraphLayout(f.path, f.home, checkoutId, EffectString.repeat(64)('0')).databasePath;
        databases.push(database);
        yield* f.fs.makeDirectory(f.path.dirname(database), {recursive: true});
        const sql = Context.get(yield* Layer.build(SqliteClient.layer({filename: database})), SqlClient.SqlClient);
        sqls.push(sql);
        yield* initializeSchema(sql);
        const epoch = '1970-01-01T00:00:00.000Z';
        yield* sql.unsafe(
          "INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at) VALUES (?, 'fixture', 'sha1', ?, ?)",
          [checkoutId, epoch, epoch],
        );
        for (const n of boundary === 'lane' ? [1, 2] : [1]) {
          const worktreeId = EffectString.repeat(64)(String(n));
          const snapshotId = `cgsn_${EffectString.padStart(40, '0')(String(n))}`;
          yield* sql.unsafe(
            "INSERT INTO snapshots (id, repository_id, worktree_id, commit_id, graph_content_id, extractor_set, dirty, state, file_count, symbol_count, edge_count, started_at, completed_at) VALUES (?, ?, ?, ?, ?, 'fixture', 0, 'ready', 0, 0, 0, ?, ?)",
            [snapshotId, checkoutId, worktreeId, EffectString.repeat(40)('c'), snapshotId, epoch, epoch],
          );
          yield* sql.unsafe('INSERT INTO snapshot_extractor_generations VALUES (?, ?)', [
            snapshotId,
            CODE_GRAPH_EXTRACTOR_GENERATION,
          ]);
          yield* sql.unsafe(
            'INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at) VALUES (?, ?, ?, ?)',
            [worktreeId, CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, snapshotId, epoch],
          );
          yield* enqueueCodeGraphEmbeddingDemandSql(sql, {worktreeId, snapshotId, activatedAt: epoch});
        }
      }
      const before = yield* Effect.forEach(sqls, sql => readCodeGraphEmbeddingDemandPage(sql));
      expect(before.flat()).toHaveLength(2);
      expect(
        EffectArray.every(before.flat(), lane => lane.state === 'queued' && lane.notBefore === 0 && !lane.active),
      ).toBe(true);
      const sessions: string[] = [];
      let admissions = 0,
        claims = 0,
        units = 0;
      const admission = yield* BackgroundInferenceAdmission;
      const firstUnit = yield* Deferred.make<void>();
      const barrier = yield* Effect.forkScoped(Deferred.await(firstUnit).pipe(Effect.andThen(f.drain)));
      yield* f.asChild(
        runCodeGraphEmbeddingWorker(f.home, {
          version: f.control.version,
          lifecycle: f.lifecycle,
          idleGraceMilliseconds: 0,
          catalogPage: () => Effect.succeed({checkoutIds}),
          onClaim: Effect.sync(() => claims++),
          onUnitResult: result =>
            Effect.gen(function* () {
              units++;
              expect(result).toEqual({state: 'deferred', reason: 'foreground'});
              if (units === 1) {
                yield* Deferred.succeed(firstUnit, undefined);
                yield* Deferred.await(f.closed);
              }
            }),
        }).pipe(
          Effect.provideService(CodeGraphStore, {
            ...store,
            withSession: (database, program, options) =>
              Effect.sync(() => sessions.push(database)).pipe(
                Effect.andThen(store.withSession(database, program, options)),
              ),
          }),
          Effect.provideService(BackgroundInferenceAdmission, {
            ...admission,
            runBatch: () =>
              Effect.sync(() => {
                admissions++;
                return {state: 'deferred' as const, reason: 'foreground' as const};
              }),
          }),
        ),
      );
      expect({admissions, claims, units}).toEqual({admissions: 1, claims: 0, units: 1});
      expect(sessions).toEqual([databases[0]]);
      expect(yield* Effect.forEach(sqls, sql => readCodeGraphEmbeddingDemandPage(sql))).toEqual(before);
      expect((yield* f.state()).fixture).toMatchObject({
        phase: 'closing',
        launches: [{nonce: f.nonce, owner: {processId: f.childPid}}],
      });
      expect(yield* f.fs.exists(f.control.lockPath)).toBe(false);
      expect(yield* f.fs.exists(f.control.receiptPath)).toBe(false);
      expect(barrier.pollUnsafe()).toBeUndefined();
      f.identities.delete(f.childPid);
      expect(yield* Fiber.join(barrier)).toMatchObject({state: 'drained', generationCount: 1});
    }).pipe(provide),
  );
}
