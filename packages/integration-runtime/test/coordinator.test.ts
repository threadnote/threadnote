import * as BunServices from '@effect/platform-bun/BunServices';
import {layer as effectLayer} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Deferred, Effect, Fiber, FileSystem, Layer, Ref, Schema} from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import * as fc from 'fast-check';
import {expect, it} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  SourceCoordinatorError,
  type SourceWorkDescriptor,
  type SourceWorkRegistration,
} from '@threadnote/integration-core/source-coordinator';
import {coordinatorWorkerFailureMessage} from '../src/coordinator-transport.js';
import {
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
  effectIt.effect('runs startup cleanup repeatedly without removing pending work', () =>
    Effect.gen(function* () {
      const current = yield* config;
      const store = yield* openCoordinatorStore(current);
      const [ticket] = yield* store.enqueue(current, [descriptor('retained')], 'automatic');
      yield* store.cleanup;
      yield* store.cleanup;
      expect((yield* store.pending).map(({key, generation}) => ({key, generation}))).toEqual([ticket]);
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
      expect((yield* store.pending).map(row => row.generation)).toEqual([1]);
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
              sources.find(source => source.sourceId === sourceId)!.accountKey,
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
              const account = sources.find(source => source.sourceId === sourceId)!.accountKey;
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
      expect(queued.map(row => row.key)).toEqual([sourceWorkKey(current, ready)]);
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
