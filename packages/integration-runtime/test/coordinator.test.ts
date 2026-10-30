import {Array as EffectArray, Option as EffectOption} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {layer as effectLayer} from '@effect/vitest';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Database} from 'bun:sqlite';
import {Deferred, Effect, Exit, Fiber, FileSystem, Layer, PlatformError, Ref, Schema, Scope} from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import * as Reactivity from 'effect/reactivity/Reactivity';
import * as fc from 'fast-check';
import {expect, it} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  SourceCoordinatorError,
  SourceHttpAdmission,
  type SourceWorkDescriptor,
  type SourceWorkRegistration,
} from '@threadnote/integration-core/source-coordinator';
import {coordinatorWorkerFailureMessage} from '../src/coordinator-transport.js';
import {
  assertCoordinatorFile,
  coordinatorPaths,
  makeCoordinatorEngine,
  makeSourceAdmission,
  openCoordinatorStore,
  sourceWorkKey,
} from '../src/coordinator.js';

const base = Layer.merge(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'coordinator.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: value => ({...value}),
          sanitizeExternal: value => ({...value}),
        }),
      ),
    ),
  ),
);
const config = Effect.gen(function* () {
  return {
    account: 'local',
    agentContextHome: yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
    agentId: 'test',
    manifestPath: '/unused.yaml',
    user: 'test',
  } satisfies RuntimeConfig;
});
const descriptor = (sourceId: string, accountKey = sourceId, provider = 'synthetic'): SourceWorkDescriptor => ({
  sourceId,
  accountKey,
  provider,
  fingerprint: 'fingerprint-one',
  refreshIntervalMs: 60_000,
});
const observedOpen = (current: RuntimeConfig, ready: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* openCoordinatorStore(current).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        // This is the final asynchronous filesystem call before SQLite opens.
        exists: path => fs.exists(path).pipe(Effect.tap(() => Deferred.succeed(ready, undefined))),
      }),
    );
  });
const registration = (
  descriptors: readonly SourceWorkDescriptor[],
  run: SourceWorkRegistration<SystemInfo>['run'] = (_config, sourceId) =>
    Effect.succeed({sourceId, syncedDocuments: [sourceId], warnings: [], value: {sourceId}}),
): SourceWorkRegistration<SystemInfo> => ({provider: 'synthetic', list: () => Effect.succeed(descriptors), run});

it('never prints arbitrary startup errors through the worker console projection', () => {
  fc.assert(
    fc.property(fc.string(), detail => {
      const privateMessage = `synthetic-private-${detail}`;
      for (const error of [new Error(privateMessage), SourceCoordinatorError.make({message: privateMessage})]) {
        expect(coordinatorWorkerFailureMessage(error)).toBe(
          'Integration sync coordinator stopped during runtime bootstrap. Retry source sync to restart it.',
        );
      }
    }),
    {numRuns: 30},
  );
});

effectLayer(base)('durable integration coordinator', effectIt => {
  effectIt.effect('keeps required provider retry when completion outlasts the admission cooldown', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const source = descriptor('completion-cooldown');
      const store = yield* openCoordinatorStore(current);
      const [ticket] = yield* store.enqueue(current, [source], 'automatic');
      const entered = yield* Deferred.make<void>();
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [
          {
            ...registration([source], () =>
              Effect.gen(function* () {
                const service = EffectOption.getOrThrow(yield* Effect.serviceOption(SourceHttpAdmission));
                const request = {
                  config: current,
                  provider: source.provider,
                  accountKey: source.accountKey,
                  method: 'GET',
                };
                yield* service.admit(request);
                expect((yield* service.admit(request).pipe(Effect.result))._tag).toBe('Failure');
                return {sourceId: source.sourceId, syncedDocuments: [], warnings: [], more: false};
              }),
            ),
            admission: {limit: 1, windowMs: 10_000},
            completion: {
              deferredWarning: 'completion deferred',
              run: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.sleep(15_000)), Effect.as([])),
            },
          },
        ],
      });
      yield* engine.dispatch;
      const consuming = yield* Effect.forkScoped(engine.consume);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(15_000);
      yield* Fiber.join(consuming);
      expect((yield* store.receipt(ticket))?.failed).toBe(false);
      const pending = yield* store.pending;
      expect(pending).toHaveLength(1);
      expect(pending[0].not_before).toBe(10_000);
      yield* engine.dispatch;
      expect(engine.activeCount()).toBe(1);
    }),
  );

  effectIt.effect('preserves completed provider success when completion reaches the original deadline', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const source = descriptor('completion-deadline');
      const store = yield* openCoordinatorStore(current);
      const [ticket] = yield* store.enqueue(current, [source], 'explicit');
      const calls = yield* Ref.make(0);
      const started = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const value = {opaque: 'preserved'};
      const engine = yield* makeCoordinatorEngine({
        store,
        quantumTimeoutMs: 100,
        registrations: [
          {
            ...registration([source], () =>
              Ref.update(calls, n => n + 1).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.sleep(90)),
                Effect.as({sourceId: source.sourceId, syncedDocuments: ['saved'], warnings: ['provider'], value}),
              ),
            ),
            completion: {
              deferredWarning: 'completion deferred',
              run: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            },
          },
        ],
      });
      yield* engine.dispatch;
      const consuming = yield* Effect.forkScoped(engine.consume);
      yield* Deferred.await(started);
      yield* TestClock.adjust(90);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(10);
      yield* Fiber.join(consuming);
      expect(engine.result(ticket)).toMatchObject({
        warnings: ['provider', 'completion deferred'],
        syncedDocuments: ['saved'],
      });
      expect(engine.result(ticket)?.value).toBe(value);
      expect((yield* store.receipt(ticket))?.failed).toBe(false);
      expect(yield* store.pending).toEqual([]);
      yield* engine.dispatch;
      expect(engine.activeCount()).toBe(0);
      expect(yield* Ref.get(calls)).toBe(1);
    }),
  );

  effectIt.effect('skips completion after the provider consumes its quantum and retains the failure policy', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const source = descriptor('completion-exhausted');
      const store = yield* openCoordinatorStore(current);
      const [ticket] = yield* store.enqueue(current, [source], 'automatic');
      const completed = yield* Ref.make(false);
      const started = yield* Deferred.make<void>();
      const engine = yield* makeCoordinatorEngine({
        store,
        quantumTimeoutMs: 100,
        registrations: [
          {
            ...registration([source], () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
            completion: {
              deferredWarning: 'completion deferred',
              run: () => Ref.set(completed, true).pipe(Effect.as([])),
            },
          },
        ],
      });
      yield* engine.dispatch;
      const consuming = yield* Effect.forkScoped(engine.consume);
      yield* Deferred.await(started);
      yield* TestClock.adjust(100);
      yield* Fiber.join(consuming);
      expect(yield* Ref.get(completed)).toBe(false);
      expect((yield* store.receipt(ticket))?.failed).toBe(true);
      expect((yield* store.pending).length).toBe(1);
    }),
  );

  for (const failure of ['ordinary', 'defect'] as const) {
    effectIt.effect(`preserves provider values and scheduling after a completion ${failure}`, () =>
      Effect.gen(function* () {
        const current = yield* config;
        const source = descriptor(`completion-${failure}`);
        const store = yield* openCoordinatorStore(current);
        const [ticket] = yield* store.enqueue(current, [source], 'explicit');
        const value = {unchanged: true};
        const engine = yield* makeCoordinatorEngine({
          store,
          registrations: [
            {
              ...registration([source], () =>
                Effect.succeed({
                  sourceId: source.sourceId,
                  syncedDocuments: [],
                  warnings: [],
                  more: true,
                  nextAttemptAt: 50_000,
                  value,
                }),
              ),
              completion: {
                deferredWarning: 'completion deferred',
                run: () => (failure === 'ordinary' ? Effect.fail('private failure') : Effect.die('private defect')),
              },
            },
          ],
        });
        yield* engine.dispatch;
        yield* engine.consume;
        expect(engine.result(ticket)).toEqual({
          sourceId: source.sourceId,
          syncedDocuments: [],
          warnings: ['completion deferred'],
          more: true,
          nextAttemptAt: 50_000,
          value,
        });
        expect(engine.result(ticket)?.value).toBe(value);
        expect((yield* store.receipt(ticket))?.failed).toBe(false);
      }),
    );
  }

  effectIt.effect('runs completion after provider scope release without changing a provider failure', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const source = descriptor('partial-failure');
      const store = yield* openCoordinatorStore(current);
      const [ticket] = yield* store.enqueue(current, [source], 'explicit');
      const locked = yield* Ref.make(false);
      const completed = yield* Ref.make(false);
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [
          {
            ...registration([source], () =>
              Effect.acquireUseRelease(
                Ref.set(locked, true),
                () => Effect.fail('original provider failure'),
                () => Ref.set(locked, false),
              ),
            ),
            completion: {
              deferredWarning: 'completion deferred',
              run: () =>
                Effect.gen(function* () {
                  expect(yield* Ref.get(locked)).toBe(false);
                  yield* Ref.set(completed, true);
                  return [];
                }),
            },
          },
        ],
      });
      yield* engine.dispatch;
      yield* engine.consume;
      expect(yield* Ref.get(completed)).toBe(true);
      expect((yield* store.receipt(ticket))?.failed).toBe(true);
      expect((yield* store.pending).length).toBe(1);
    }),
  );

  effectIt.effect('propagates caller interruption through completion without publishing success', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const source = descriptor('completion-interruption');
      const store = yield* openCoordinatorStore(current);
      const [ticket] = yield* store.enqueue(current, [source], 'automatic');
      const entered = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [
          {
            ...registration([source]),
            completion: {
              deferredWarning: 'completion deferred',
              run: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Ref.set(released, true)),
                ),
            },
          },
        ],
      });
      yield* engine.dispatch;
      const consuming = yield* Effect.forkScoped(engine.consume);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(consuming);
      expect(yield* Ref.get(released)).toBe(true);
      expect(engine.result(ticket)).toBeUndefined();
      expect(yield* store.receipt(ticket)).toBeUndefined();
    }),
  );

  effectIt.effect('runs startup cleanup repeatedly without removing pending work', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const store = yield* openCoordinatorStore(current);
      const [ticket] = yield* store.enqueue(current, [descriptor('retained')], 'automatic');
      yield* store.cleanup;
      yield* store.cleanup;
      expect(EffectArray.map(yield* store.pending, ({key, generation}) => ({key, generation}))).toEqual([ticket]);
    }),
  );

  effectIt.effect('opens an alias store when a sidecar disappears between lstat and stat after peer close', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const suffix of ['-wal', '-shm']) {
        const current = yield* config;
        const alias = `${current.agentContextHome}/alias`;
        yield* fs.symlink(current.agentContextHome, alias);
        const paths = yield* coordinatorPaths(current);
        const firstScope = yield* Effect.acquireRelease(Scope.make(), scope => Scope.close(scope, Exit.void));
        const secondScope = yield* Effect.acquireRelease(Scope.make(), scope => Scope.close(scope, Exit.void));
        const first = yield* openCoordinatorStore(current).pipe(Scope.provide(firstScope));
        const [ticket] = yield* first.enqueue(current, [descriptor('retained')], 'automatic');
        const sibling = `${paths.directory}/sibling.txt`;
        yield* fs.writeFileString(sibling, 'preserve sibling', {mode: 0o600});
        const sidecar = `${paths.database}${suffix}`;
        expect(yield* fs.exists(sidecar)).toBe(true);
        const observed = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const classifications: string[] = [];
        let gated = false;
        const opening = yield* openCoordinatorStore({...current, agentContextHome: alias}).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: path =>
              Effect.gen(function* () {
                if (path === sidecar && !gated) {
                  // runtimeLstat has already observed the live peer's sidecar.
                  gated = true;
                  yield* Deferred.succeed(observed, undefined);
                  yield* Deferred.await(resume);
                }
                return yield* fs.stat(path).pipe(
                  Effect.tapError(error =>
                    Effect.sync(() => {
                      if (path === sidecar && error.reason._tag === 'NotFound')
                        classifications.push('sidecar-stat:NotFound');
                    }),
                  ),
                );
              }),
          }),
          Scope.provide(secondScope),
          Effect.result,
          Effect.forkScoped,
        );
        yield* Deferred.await(observed);
        expect(yield* first.sql`PRAGMA wal_checkpoint(TRUNCATE)`).toMatchObject([{busy: 0}]);
        yield* Scope.close(firstScope, Exit.void);
        // Some SQLite/platform combinations retain closed sidecars. Force the
        // legal absent-file transition only after checkpoint and peer release.
        yield* fs.remove(sidecar, {force: true});
        expect(yield* fs.exists(sidecar)).toBe(false);
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(opening);
        expect(classifications).toEqual(['sidecar-stat:NotFound']);
        expect(result._tag, `sidecar ${suffix}: ${EffectArray.join(classifications, ',')}`).toBe('Success');
        if (result._tag !== 'Success') return;
        expect(result.success.home).toBe(paths.home);
        expect(EffectArray.map(yield* result.success.pending, ({key, generation}) => ({key, generation}))).toEqual([
          ticket,
        ]);
        expect(yield* fs.readFileString(sibling)).toBe('preserve sibling');
      }
    }),
  );

  effectIt.effect('keeps unsafe sidecars rejected with disappearance recovery enabled', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const system = yield* SystemInfo;
      for (const kind of ['symlink', 'hardlink', 'directory', 'mode', 'owner']) {
        if (system.platform === 'win32' && (kind === 'mode' || kind === 'owner')) continue;
        const current = yield* config;
        const sibling = `${current.agentContextHome}/sibling.txt`;
        const sidecar = `${current.agentContextHome}/guard.sqlite-wal`;
        yield* fs.writeFileString(sibling, 'preserve sibling', {mode: 0o600});
        if (kind === 'symlink') yield* fs.symlink(sibling, sidecar);
        else if (kind === 'hardlink') yield* fs.link(sibling, sidecar);
        else if (kind === 'directory') yield* fs.makeDirectory(sidecar);
        else yield* fs.writeFileString(sidecar, 'sidecar', {mode: kind === 'mode' ? 0o644 : 0o600});
        const result = yield* assertCoordinatorFile(sidecar, true).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            userId: kind === 'owner' ? system.userId! + 1 : system.userId,
          }),
          Effect.result,
        );
        expect(result, kind).toMatchObject({
          _tag: 'Failure',
          failure: {
            _tag: 'SourceCoordinatorError',
            message: 'Integration coordinator is unavailable. Retry the operation.',
          },
        });
        expect(yield* fs.readFileString(sibling)).toBe('preserve sibling');
      }
    }),
  );

  effectIt.effect('rejects sidecar replacements and does not swallow other stat failures', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const current = yield* config;
      const sibling = `${current.agentContextHome}/sibling.txt`;
      const sidecar = `${current.agentContextHome}/guard.sqlite-wal`;
      yield* fs.writeFileString(sibling, 'preserve sibling', {mode: 0o600});
      yield* fs.writeFileString(sidecar, 'sidecar', {mode: 0o600});
      const missing = PlatformError.systemError({_tag: 'NotFound', module: 'FileSystem', method: 'stat'});
      const replacement = yield* assertCoordinatorFile(sidecar, true).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: path =>
            path === sidecar
              ? fs
                  .remove(sidecar)
                  .pipe(Effect.andThen(fs.symlink(sibling, sidecar)), Effect.andThen(Effect.fail(missing)))
              : fs.stat(path),
        }),
        Effect.result,
      );
      expect(replacement).toMatchObject({_tag: 'Failure', failure: {_tag: 'SourceCoordinatorError'}});
      yield* fs.remove(sidecar);
      yield* fs.writeFileString(sidecar, 'sidecar', {mode: 0o600});
      const denied = PlatformError.systemError({_tag: 'PermissionDenied', module: 'FileSystem', method: 'stat'});
      const other = yield* assertCoordinatorFile(sidecar, true).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: path => (path === sidecar ? Effect.fail(denied) : fs.stat(path)),
        }),
        Effect.result,
      );
      expect(other._tag).toBe('Failure');
      if (other._tag === 'Failure') expect(other.failure).toBe(denied);
      expect(yield* fs.readFileString(sibling)).toBe('preserve sibling');
    }),
  );

  effectIt.effect.prop(
    'retains pending identities across bounded alias open and close schedules',
    {aliases: Schema.Array(Schema.Boolean).check(Schema.isMinLength(1), Schema.isMaxLength(6))},
    ({aliases}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const current = yield* config;
        const paths = yield* coordinatorPaths(current);
        const alias = `${current.agentContextHome}/alias`;
        yield* fs.symlink(current.agentContextHome, alias);
        let expected: readonly {readonly key: string; readonly generation: number}[] | undefined;
        for (const useAlias of aliases) {
          const tickets = yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* openCoordinatorStore({
                ...current,
                agentContextHome: useAlias ? alias : current.agentContextHome,
              });
              expect(store.home).toBe(paths.home);
              const tickets = yield* store.enqueue(current, [descriptor('retained')], 'automatic');
              expect(EffectArray.map(yield* store.pending, ({key, generation}) => ({key, generation}))).toEqual(
                tickets,
              );
              return tickets;
            }),
          );
          // No worker consumes these requests: pending refreshes keep generation 1.
          expect(tickets).toHaveLength(1);
          expect(tickets[0].generation).toBe(1);
          if (expected) expect(tickets).toEqual(expected);
          expected = tickets;
        }
      }),
    {arbitrary: {runs: 8}},
  );

  effectIt.effect('classifies a held WAL setup lock independently of sidecar disappearance', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const paths = yield* coordinatorPaths(current);
      yield* (yield* FileSystem.FileSystem).writeFile(paths.database, new Uint8Array(), {mode: 0o600});
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const database = new Database(paths.database);
          database.run('BEGIN EXCLUSIVE');
          return database;
        }),
        database => Effect.sync(() => database.close()),
      );
      const sql = yield* SqliteClient.make({filename: paths.database, busyTimeout: 25, disableWAL: true}).pipe(
        Effect.provideService(Reactivity.Reactivity, yield* Reactivity.make),
      );
      // Inspect only the normalized SQL category, before the coordinator's
      // intentional public SourceCoordinatorError projection.
      const result = yield* sql`PRAGMA journal_mode = WAL`.pipe(Effect.result);
      expect(result).toMatchObject({_tag: 'Failure', failure: {reason: {_tag: 'LockTimeoutError'}}});
    }),
  );

  effectIt.effect('yields and retries a locked cold WAL setup, then retains durable demand', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const paths = yield* coordinatorPaths(current);
      yield* (yield* FileSystem.FileSystem).writeFile(paths.database, new Uint8Array(), {mode: 0o600});
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const database = new Database(paths.database);
          database.run('BEGIN EXCLUSIVE');
          return database;
        }),
        database => Effect.sync(() => database.close()),
      );
      const ready = yield* Deferred.make<void>();
      const opening = yield* observedOpen(current, ready).pipe(Effect.forkScoped);
      // The held rollback-journal lock deterministically rejects WAL setup.
      // Advancing this clock requires startup to yield between native waits.
      yield* Deferred.await(ready);
      yield* TestClock.adjust(75);
      expect(opening.pollUnsafe()).toBeUndefined();
      yield* Effect.sync(() => blocker.run('COMMIT'));
      yield* TestClock.adjust(25);
      const store = yield* Fiber.join(opening);
      expect(yield* store.sql`PRAGMA journal_mode`).toEqual([{journal_mode: 'wal'}]);
      const tickets = yield* store.enqueue(current, [descriptor('one')], 'automatic');
      expect(tickets).toHaveLength(1);
      expect(EffectArray.map(yield* store.pending, row => row.generation)).toEqual([1]);
    }),
  );

  effectIt.effect('bounds locked startup retries and permits a clean reopen after failure', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const paths = yield* coordinatorPaths(current);
      yield* (yield* FileSystem.FileSystem).writeFile(paths.database, new Uint8Array(), {mode: 0o600});
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const database = new Database(paths.database);
          database.run('BEGIN EXCLUSIVE');
          return database;
        }),
        database => Effect.sync(() => database.close()),
      );
      const ready = yield* Deferred.make<void>();
      const opening = yield* Effect.scoped(observedOpen(current, ready)).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* TestClock.adjust(500);
      const result = yield* Fiber.join(opening);
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'SourceCoordinatorError',
          message: 'Integration coordinator is unavailable. Retry the operation.',
        },
      });
      yield* Effect.sync(() => blocker.run('COMMIT'));
      const store = yield* openCoordinatorStore(current);
      expect(yield* store.pending).toEqual([]);
    }),
  );

  effectIt.effect('yields until a temporary writer releases, publishing exactly one generation', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const store = yield* openCoordinatorStore(current);
      const paths = yield* coordinatorPaths(current);
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const database = new Database(paths.database);
          database.run('BEGIN IMMEDIATE');
          return database;
        }),
        database => Effect.sync(() => database.close()),
      );
      const publishing = yield* store.enqueue(current, [descriptor('one')], 'explicit').pipe(Effect.forkScoped);
      yield* TestClock.adjust(75);
      expect(publishing.pollUnsafe()).toBeUndefined();
      yield* Effect.sync(() => blocker.run('COMMIT'));
      yield* TestClock.adjust(25);
      const tickets = yield* Fiber.join(publishing);
      expect(tickets).toHaveLength(1);
      expect(EffectArray.map(yield* store.pending, row => ({generation: row.generation, state: row.state}))).toEqual([
        {generation: 1, state: 'pending'},
      ]);
      expect(yield* store.enqueue(current, [descriptor('one')], 'explicit')).toEqual(tickets);
    }),
  );

  effectIt.effect('bounds demand contention and leaves no partial generation before recovery', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const store = yield* openCoordinatorStore(current);
      const paths = yield* coordinatorPaths(current);
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const database = new Database(paths.database);
          database.run('BEGIN IMMEDIATE');
          return database;
        }),
        database => Effect.sync(() => database.close()),
      );
      const publishing = yield* store
        .enqueue(current, [descriptor('one')], 'explicit')
        .pipe(Effect.result, Effect.forkScoped);
      yield* TestClock.adjust(475);
      expect(publishing.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(25);
      expect(yield* Fiber.join(publishing)).toMatchObject({_tag: 'Failure', failure: {_tag: 'SourceCoordinatorError'}});
      yield* Effect.sync(() => blocker.run('COMMIT'));
      expect(yield* store.pending).toEqual([]);
      expect((yield* store.enqueue(current, [descriptor('one')], 'explicit'))[0].generation).toBe(1);
    }),
  );

  effectIt.effect('does not retry invalid demand', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const store = yield* openCoordinatorStore(current);
      expect(
        yield* store.enqueue(current, [descriptor('invalid/source')], 'explicit').pipe(Effect.result),
      ).toMatchObject({_tag: 'Failure', failure: {_tag: 'SourceCoordinatorError'}});
      expect(yield* store.pending).toEqual([]);
    }),
  );
  effectIt.effect.prop(
    'coalesces repeated pending demand into one generation per source',
    {count: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 30}))},
    ({count}) =>
      Effect.gen(function* () {
        const current = yield* config;
        const store = yield* openCoordinatorStore(current);
        for (let index = 0; index < count; index++) yield* store.enqueue(current, [descriptor('one')], 'automatic');
        const rows = yield* store.pending;
        expect(rows).toHaveLength(1);
        expect(rows[0].generation).toBe(1);
        const queue = yield* store.sql<{count: number}>`SELECT COUNT(*) AS count FROM source_queue`;
        expect(queue[0].count).toBe(0);
      }),
    {arbitrary: {runs: 12}},
  );

  effectIt.effect(
    'queue generations survive reopening, acknowledge, and allow explicit refresh before the interval',
    () =>
      Effect.gen(function* () {
        const current = yield* config;
        const source = descriptor('one');
        const ticket = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* openCoordinatorStore(current);
            const tickets = yield* store.enqueue(current, [source], 'automatic');
            const engine = yield* makeCoordinatorEngine({store, registrations: [registration([source])]});
            yield* engine.dispatch;
            return tickets[0];
          }),
        );
        const store = yield* openCoordinatorStore(current);
        const engine = yield* makeCoordinatorEngine({store, registrations: [registration([source])]});
        yield* engine.consume;
        expect((yield* store.receipt(ticket))?.result.syncedDocuments).toEqual(['one']);
        expect(yield* store.enqueue(current, [source], 'automatic')).toHaveLength(0);
        const explicit = yield* store.enqueue(current, [source], 'explicit');
        expect(explicit[0].generation).toBe(2);
        yield* engine.dispatch;
        yield* engine.consume;
        expect((yield* store.receipt(explicit[0]))?.failed).toBe(false);
        const completed = yield* store.sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM source_queue WHERE state='completed'`;
        expect(completed[0].count).toBe(2);
      }),
  );

  effectIt.effect('rotates accounts before a busy account takes its second source', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const sources = [
        descriptor('a-one', 'a'),
        descriptor('a-two', 'a'),
        descriptor('b-one', 'b'),
        descriptor('c-one', 'c'),
      ];
      const visited = yield* Ref.make<readonly string[]>([]);
      const store = yield* openCoordinatorStore(current);
      yield* store.enqueue(current, sources, 'automatic');
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [
          registration(sources, (_config, sourceId) =>
            Ref.update(visited, values => [
              ...values,
              EffectOption.getOrUndefined(EffectArray.findFirst(sources, source => source.sourceId === sourceId))!
                .accountKey,
            ]).pipe(Effect.as({sourceId, syncedDocuments: [], warnings: []})),
          ),
        ],
      });
      yield* engine.dispatch;
      yield* engine.consume;
      yield* engine.dispatch;
      yield* engine.consume;
      yield* engine.dispatch;
      yield* engine.consume;
      expect(new Set((yield* Ref.get(visited)).slice(0, 3)).size).toBe(3);
    }),
  );

  effectIt.effect('bounds concurrent source work to two and does not run two sources of one account', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const sources = [
        descriptor('a-one', 'a'),
        descriptor('a-two', 'a'),
        descriptor('b-one', 'b'),
        descriptor('c-one', 'c'),
      ];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const active = yield* Ref.make<readonly string[]>([]);
      const store = yield* openCoordinatorStore(current);
      yield* store.enqueue(current, sources, 'automatic');
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [
          registration(sources, (_config, sourceId) =>
            Effect.gen(function* () {
              const account = EffectOption.getOrUndefined(
                EffectArray.findFirst(sources, source => source.sourceId === sourceId),
              )!.accountKey;
              const accounts = yield* Ref.updateAndGet(active, values => [...values, account]);
              if (accounts.length === 2) yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return {sourceId, syncedDocuments: [], warnings: []};
            }),
          ),
        ],
      });
      yield* engine.dispatch;
      const first = yield* Effect.forkScoped(engine.consume);
      const second = yield* Effect.forkScoped(engine.consume);
      yield* Deferred.await(started);
      yield* engine.dispatch;
      expect(engine.activeCount()).toBe(2);
      expect(new Set(yield* Ref.get(active)).size).toBe(2);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }),
  );

  effectIt.effect('does not occupy worker slots while a provider is cooling down', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const cooled = descriptor('cooled', 'account', 'cooled');
      const ready = descriptor('ready');
      const store = yield* openCoordinatorStore(current);
      yield* store.enqueue(current, [cooled, ready], 'automatic');
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [registration([ready]), {...registration([cooled]), provider: 'cooled'}],
      });
      yield* engine.admission.cooldown({
        config: current,
        provider: 'cooled',
        accountKey: 'account',
        method: 'GET',
        retryAfterMs: 60_000,
      });
      yield* engine.dispatch;
      expect(engine.activeCount()).toBe(1);
      const queued = yield* store.sql<{key: string}>`SELECT key FROM source_jobs WHERE state='queued'`;
      expect(EffectArray.map(queued, row => row.key)).toEqual([sourceWorkKey(current, ready)]);
      yield* engine.consume;
    }),
  );

  effectIt.effect('durable counters and account cooldowns apply to all source and method callers after reopening', () =>
    Effect.gen(function* () {
      const current = yield* config;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openCoordinatorStore(current);
          const admission = yield* makeSourceAdmission(store);
          for (let index = 0; index < 16; index++)
            yield* admission.admit({config: current, provider: 'synthetic', accountKey: 'a', method: 'GET'});
        }),
      );
      const store = yield* openCoordinatorStore(current);
      const admission = yield* makeSourceAdmission(store);
      const permitted = yield* Ref.make(false);
      const waiter = yield* Effect.forkScoped(
        admission
          .admit({config: current, provider: 'synthetic', accountKey: 'b', method: 'POST'})
          .pipe(Effect.andThen(Ref.set(permitted, true))),
      );
      yield* TestClock.adjust(19_999);
      expect(yield* Ref.get(permitted)).toBe(false);
      yield* TestClock.adjust(1);
      yield* Fiber.join(waiter);
      yield* admission.cooldown({
        config: current,
        provider: 'synthetic',
        accountKey: 'b',
        method: 'POST',
        retryAfterMs: 60_000,
      });
      const delay = yield* Ref.make(false);
      const other = yield* Effect.forkScoped(
        admission
          .admit({config: current, provider: 'synthetic', accountKey: 'c', method: 'GET'})
          .pipe(Effect.andThen(Ref.set(delay, true))),
      );
      yield* TestClock.adjust(59_999);
      expect(yield* Ref.get(delay)).toBe(false);
      yield* TestClock.adjust(1);
      yield* Fiber.join(other);
    }),
  );

  effectIt.effect('never writes credential bytes, provider values, Console output, or raw errors to receipts', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const source = {...descriptor('one'), credentialEnv: 'SYNTHETIC_TOKEN'};
      const secret = 'SYNTHETIC_PRIVATE_CREDENTIAL_SENTINEL';
      const store = yield* openCoordinatorStore(current);
      const [ticket] = yield* store.enqueue(current, [source], 'automatic');
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [
          registration([source], (_config, sourceId) =>
            Effect.succeed({sourceId, syncedDocuments: [], warnings: [secret], output: [secret], value: {secret}}),
          ),
        ],
      });
      engine.acceptCredentials(ticket, {SYNTHETIC_TOKEN: secret});
      yield* engine.dispatch;
      yield* engine.consume;
      const persisted = yield* store.sql<{result_json: string}>`SELECT result_json FROM source_receipts`;
      expect(JSON.stringify(persisted)).not.toContain(secret);
      const jobs = yield* store.sql<{
        descriptor_json: string;
        config_json: string;
      }>`SELECT descriptor_json,config_json FROM source_jobs`;
      expect(JSON.stringify(jobs)).not.toContain(secret);
      const queue = yield* store.sql<{element: string}>`SELECT element FROM source_queue`;
      expect(JSON.stringify(queue)).not.toContain(secret);
      expect(engine.result(ticket)?.value).toEqual({secret});
    }),
  );

  effectIt.effect('rejects revoked descriptors before invoking provider work and prunes removed demand', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const source = descriptor('one');
      const listed = yield* Ref.make<readonly SourceWorkDescriptor[]>([source]);
      const called = yield* Ref.make(false);
      const store = yield* openCoordinatorStore(current);
      const [ticket] = yield* store.enqueue(current, [source], 'automatic');
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [
          {
            provider: 'synthetic',
            list: () => Ref.get(listed),
            run: (_config, sourceId) =>
              Ref.set(called, true).pipe(Effect.as({sourceId, syncedDocuments: [], warnings: []})),
          },
        ],
      });
      yield* engine.dispatch;
      yield* Ref.set(listed, []);
      yield* engine.consume;
      expect(yield* Ref.get(called)).toBe(false);
      expect((yield* store.receipt(ticket))?.failed).toBe(true);
      yield* store.enqueue(current, [], 'automatic');
      expect(yield* store.pending).toEqual([]);
    }),
  );

  effectIt.effect('retains a rotated ephemeral caller binding across continuation generations', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const originalSystem = yield* SystemInfo;
      const source = {...descriptor('one', 'rotated-account'), credentialEnv: 'SYNTHETIC_TOKEN'};
      const seen: (string | undefined)[] = [];
      const calls = yield* Ref.make(0);
      const store = yield* openCoordinatorStore(current);
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [
          registration([source], (_config, sourceId, options) =>
            Effect.gen(function* () {
              seen.push(options.credentialEnvironment.SYNTHETIC_TOKEN);
              const system = yield* SystemInfo;
              expect(system.environment().SYNTHETIC_TOKEN).toBe('rotated');
              const count = yield* Ref.updateAndGet(calls, value => value + 1);
              return {sourceId, syncedDocuments: [], warnings: [], more: count < 2};
            }),
          ),
        ],
      }).pipe(
        Effect.provideService(SystemInfo, {...originalSystem, environment: () => ({SYNTHETIC_TOKEN: 'stale-startup'})}),
      );
      engine.acceptBinding(current, source, {SYNTHETIC_TOKEN: 'rotated'});
      // A late, authenticated handoff for the preceding identity must not
      // overwrite the acknowledged rotated identity.
      engine.acceptBinding(current, {...source, accountKey: 'stale-account'}, {SYNTHETIC_TOKEN: 'stale-startup'});
      yield* store.enqueue(current, [source], 'automatic');
      yield* engine.dispatch;
      yield* engine.consume;
      yield* TestClock.adjust(6 * 60_000);
      yield* engine.dispatch;
      yield* engine.consume;
      expect(seen).toEqual(['rotated', 'rotated']);
    }),
  );

  effectIt.effect('clears an omitted credential instead of reviving the worker startup binding', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const originalSystem = yield* SystemInfo;
      const source = {...descriptor('one', 'missing'), credentialEnv: 'SYNTHETIC_TOKEN'};
      const store = yield* openCoordinatorStore(current);
      const engine = yield* makeCoordinatorEngine({
        store,
        registrations: [
          registration([source], (_config, sourceId, options) =>
            Effect.gen(function* () {
              expect(options.credentialEnvironment.SYNTHETIC_TOKEN).toBeUndefined();
              expect((yield* SystemInfo).environment().SYNTHETIC_TOKEN).toBeUndefined();
              return {sourceId, syncedDocuments: [], warnings: []};
            }),
          ),
        ],
      }).pipe(
        Effect.provideService(SystemInfo, {...originalSystem, environment: () => ({SYNTHETIC_TOKEN: 'stale-startup'})}),
      );
      engine.acceptBinding(current, source, {});
      yield* store.enqueue(current, [source], 'automatic');
      yield* engine.dispatch;
      yield* engine.consume;
    }),
  );
});
