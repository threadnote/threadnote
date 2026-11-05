import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, PlatformError, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import * as Demand from '../../src/background/lexical-demand.js';
import * as Mutation from '@threadnote/store/resource/mutation_generation';
import {makeReadyRecallMaintenance, withReadyRecallMaintenanceScope} from '../../src/index/maintenance.js';
import {readRecallExactMatches, readRecallIndexDataBatch, requestMissingRecallReadyDirectory} from '../../src/index.js';

const platform = Layer.mergeAll(
  BunServices.layer,
  cryptoLayer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
        Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
      ),
    ),
  ),
);
// oxlint-disable-next-line effecttsgo/strict-effect-provide -- One scoped test entry with the narrow filesystem/platform layer.
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(platform));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'ready-maintenance-'});
  const scope = {account: 'local', user: 'test', agentContextHome: home, includeInactive: false};
  const database = path.join(home, 'indexes', 'lexical', 'active-v13.sqlite');
  const controls = {
    generation: '',
    fail: false,
    unknownPending: false,
    invalidGeneration: false,
    beforeEnqueue: Effect.void,
    beforePending: Effect.void,
    pending: undefined as Demand.RecallLexicalDemand | undefined,
  };
  const requests: boolean[] = [];
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      vi.spyOn(Demand, 'requestRecallLexicalRefresh').mockImplementation((selected, options) =>
        Effect.gen(function* () {
          requests.push(options?.reconcile === true);
          yield* controls.beforeEnqueue;
          if (controls.fail) return yield* Demand.RecallLexicalDemandUnavailable.make({message: 'Synthetic failure'});
          const revision = `00000000-0000-4000-8000-${EffectString.padStart(12, '0')(String(requests.length))}`;
          controls.pending = {
            version: 2,
            account: selected.account,
            user: selected.user,
            includeInactive: selected.includeInactive,
            manifestPath: selected.manifestPath,
            failures: 0,
            revision,
            reconcile: options?.reconcile === true,
            sourceGeneration: controls.generation,
          };
          return revision;
        }),
      ),
    ),
    spy => Effect.sync(() => spy.mockRestore()),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      vi
        .spyOn(Demand, 'readRecallLexicalDemand')
        .mockImplementation(() =>
          controls.beforePending.pipe(
            Effect.andThen(() =>
              controls.unknownPending
                ? Effect.fail(Demand.RecallLexicalDemandUnavailable.make({message: 'Synthetic unknown receipt'}))
                : Effect.succeed(controls.pending),
            ),
          ),
        ),
    ),
    spy => Effect.sync(() => spy.mockRestore()),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      vi
        .spyOn(Mutation, 'readCanonicalMutationGeneration')
        .mockImplementation(() =>
          controls.invalidGeneration
            ? Effect.fail(Mutation.CanonicalMutationGenerationInvalid.make({message: 'Synthetic invalid generation'}))
            : Effect.succeed(controls.generation),
        ),
    ),
    spy => Effect.sync(() => spy.mockRestore()),
  );
  const missing = () => makeReadyRecallMaintenance(scope).missing(database, 13);
  const reconcile = () => makeReadyRecallMaintenance(scope).request(true);
  return {scope, database, controls, requests, missing, reconcile};
});

effectIt.effect('only positive whole-directory absence requests cold maintenance', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(yield* fs.realPath(f.scope.agentContextHome), 'indexes', 'lexical');
    for (const reason of ['PermissionDenied', 'Unknown', 'Busy'] as const) {
      const observed = FileSystem.FileSystem.of({
        ...fs,
        stat: filename =>
          filename === directory
            ? Effect.fail(PlatformError.systemError({_tag: reason, module: 'FileSystem', method: 'stat'}))
            : fs.stat(filename),
      });
      expect(
        yield* requestMissingRecallReadyDirectory(f.scope, false).pipe(
          Effect.provideService(FileSystem.FileSystem, observed),
        ),
      ).toBe(false);
    }
    expect(yield* requestMissingRecallReadyDirectory({...f.scope, account: '../other'}, false)).toBe(false);
    expect(yield* requestMissingRecallReadyDirectory({...f.scope, manifestPath: 'relative.yaml'}, false)).toBe(false);
    for (const reason of ['PermissionDenied', 'Unknown', 'Busy'] as const) {
      const observed = FileSystem.FileSystem.of({
        ...fs,
        lstat: filename =>
          filename === directory
            ? Effect.fail(PlatformError.systemError({_tag: reason, module: 'FileSystem', method: 'lstat'}))
            : fs.lstat(filename),
      });
      expect(
        yield* requestMissingRecallReadyDirectory(f.scope, false).pipe(
          Effect.provideService(FileSystem.FileSystem, observed),
        ),
      ).toBe(false);
    }
    expect(f.requests).toEqual([]);
    expect(yield* requestMissingRecallReadyDirectory(f.scope, false)).toBe(true);
    expect(f.requests).toEqual([false]);
    expect(yield* fs.exists(directory)).toBe(false);
    yield* fs.makeDirectory(directory, {recursive: true});
    expect(yield* requestMissingRecallReadyDirectory(f.scope, false)).toBe(false);
    yield* fs.remove(directory, {recursive: true});
    yield* fs.writeFileString(directory, 'not a directory');
    expect(yield* requestMissingRecallReadyDirectory(f.scope, false)).toBe(false);
    expect(f.requests).toEqual([false]);
  }).pipe(provide),
);

effectIt.effect('rechecks absence across calls and never treats a created directory as cold', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    expect(yield* requestMissingRecallReadyDirectory(f.scope, false)).toBe(true);
    const first = f.controls.pending?.revision;
    expect(yield* requestMissingRecallReadyDirectory(f.scope, false)).toBe(true);
    expect(f.controls.pending?.revision).not.toBe(first);
    yield* fs.makeDirectory(path.dirname(f.database), {recursive: true});
    expect(yield* requestMissingRecallReadyDirectory(f.scope, false)).toBe(false);
    expect(f.requests).toEqual([false, false]);
  }).pipe(provide),
);

effectIt.effect('a dangling lexical directory link delegates to the native reader without requesting maintenance', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(yield* fs.realPath(f.scope.agentContextHome), 'indexes', 'lexical');
    yield* fs.makeDirectory(path.dirname(directory), {recursive: true});
    yield* fs.symlink(path.join(f.scope.agentContextHome, 'missing-target'), directory);
    expect(yield* fs.exists(directory)).toBe(false);
    expect((yield* fs.lstat(directory)).type).toBe('SymbolicLink');
    expect(yield* requestMissingRecallReadyDirectory(f.scope, false)).toBe(false);
    expect(f.requests).toEqual([]);
    expect(f.controls.pending).toBeUndefined();
  }).pipe(provide),
);

effectIt.effect('cancellation during an absence observation never enqueues maintenance', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entered = yield* Deferred.make<void>();
    const directory = path.join(yield* fs.realPath(f.scope.agentContextHome), 'indexes', 'lexical');
    const observed = FileSystem.FileSystem.of({
      ...fs,
      stat: filename =>
        filename === directory
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : fs.stat(filename),
    });
    const reader = yield* requestMissingRecallReadyDirectory(f.scope, false).pipe(
      Effect.provideService(FileSystem.FileSystem, observed),
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(reader);
    expect(f.requests).toEqual([]);
    expect(f.controls.pending).toBeUndefined();
  }).pipe(provide),
);

effectIt.effect('reuses a real durable pending revision and persists stronger reconciliation', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'real-ready-demand-'});
    const scope = {account: 'local', user: 'test', agentContextHome: home, includeInactive: false};
    const database = path.join(home, 'indexes', 'lexical', 'active-v13.sqlite');
    const spy = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(Demand, 'requestRecallLexicalRefresh')),
      value => Effect.sync(() => value.mockRestore()),
    );
    yield* withReadyRecallMaintenanceScope(
      Effect.gen(function* () {
        expect(yield* makeReadyRecallMaintenance(scope).missing(database, 13)).toBe('queued');
        const first = yield* Demand.readRecallLexicalDemand(scope);
        expect(first?.revision).toBeDefined();
        expect(yield* makeReadyRecallMaintenance(scope).missing(database, 13)).toBe('queued');
        expect(spy).toHaveBeenCalledTimes(1);
        expect((yield* Demand.readRecallLexicalDemand(scope))?.revision).toBe(first?.revision);
        expect(yield* makeReadyRecallMaintenance(scope).request(true)).toBe('queued');
        expect(spy).toHaveBeenCalledTimes(2);
        const stronger = yield* Demand.readRecallLexicalDemand(scope);
        expect(stronger?.reconcile).toBe(true);
        expect(stronger?.revision).not.toBe(first?.revision);
      }),
    );
  }).pipe(provide),
);

effectIt.effect('coalesces the real cold exact and batch read paths into one pending publication', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const program = Effect.gen(function* () {
      const exact = yield* readRecallExactMatches(f.scope, {
        includeInactive: false,
        terms: ['alpha'],
        uriScopes: ['threadnote://user/test/memories'],
      }).pipe(Effect.result);
      const batch = yield* readRecallIndexDataBatch(f.scope, {
        includeInactive: false,
        selections: [{query: 'alpha'}],
      }).pipe(Effect.result);
      expect(exact).toMatchObject({_tag: 'Failure', failure: {_tag: 'RecallReadyReadUnavailable'}});
      expect(batch).toMatchObject({_tag: 'Failure', failure: {_tag: 'RecallReadyReadUnavailable'}});
    });
    yield* withReadyRecallMaintenanceScope(program);
    expect(f.requests).toEqual([false]);
    yield* program;
    expect(f.requests).toEqual([false, false, false]);
  }).pipe(provide),
);

effectIt.effect('never shares a missing attempt across separate sections operations', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(yield* withReadyRecallMaintenanceScope(f.missing())).toBe('queued');
    expect(yield* withReadyRecallMaintenanceScope(f.missing())).toBe('queued');
    expect(f.requests).toEqual([false, false]);
  }).pipe(provide),
);

effectIt.effect('retains failed equivalent attempts but admits stronger reconciliation with accurate outcomes', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* withReadyRecallMaintenanceScope(
      Effect.gen(function* () {
        f.controls.fail = true;
        expect(yield* f.missing()).toBe('unavailable');
        f.controls.fail = false;
        expect(yield* f.missing()).toBe('unavailable');
        expect(f.requests).toEqual([false]);
        expect(yield* f.reconcile()).toBe('queued');
        expect(f.controls.pending?.reconcile).toBe(true);
        expect(yield* f.missing()).toBe('queued');
        expect(yield* f.missing()).toBe('queued');
        expect(f.requests).toEqual([false, true, true]);
      }),
    );
  }).pipe(provide),
);

effectIt.effect('rechecks the canonical generation after observing a pending revision', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* withReadyRecallMaintenanceScope(
      Effect.gen(function* () {
        yield* f.missing();
        f.controls.beforePending = Effect.sync(() => {
          f.controls.generation = 'changed-during-proof';
        });
        expect(yield* f.missing()).toBe('queued');
        expect(f.requests).toHaveLength(2);
        expect(f.controls.pending?.sourceGeneration).toBe('changed-during-proof');
      }),
    );
  }).pipe(provide),
);

effectIt.effect('binds missing snapshots to physical homes while accepting an alias of the same home', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const alias = path.join(f.scope.agentContextHome, 'alias');
    yield* fs.symlink(f.scope.agentContextHome, alias);
    const other = yield* fs.makeTempDirectoryScoped({prefix: 'other-maintenance-'});
    yield* withReadyRecallMaintenanceScope(
      Effect.gen(function* () {
        yield* f.missing();
        expect(
          yield* makeReadyRecallMaintenance({...f.scope, agentContextHome: alias}).missing(
            path.join(alias, 'indexes', 'lexical', 'active-v13.sqlite'),
            13,
          ),
        ).toBe('queued');
        expect(f.requests).toHaveLength(1);
        expect(yield* makeReadyRecallMaintenance({...f.scope, agentContextHome: other}).missing(f.database, 13)).toBe(
          'queued',
        );
        expect(f.requests).toHaveLength(2);
      }),
    );
  }).pipe(provide),
);

for (const change of ['completed', 'replaced', 'generation', 'unknown', 'terminal'] as const)
  effectIt.effect(`does not reuse queued maintenance after a ${change} pending observation`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* withReadyRecallMaintenanceScope(
        Effect.gen(function* () {
          expect(yield* f.missing()).toBe('queued');
          const pending = f.controls.pending!;
          if (change === 'completed') f.controls.pending = undefined;
          if (change === 'replaced')
            f.controls.pending = {...pending, revision: '00000000-0000-4000-8000-999999999999'};
          if (change === 'generation') f.controls.generation = 'changed';
          if (change === 'unknown') f.controls.unknownPending = true;
          if (change === 'terminal') f.controls.pending = {...pending, failures: 8};
          expect(yield* f.missing()).toBe('queued');
          expect(f.requests).toEqual([false, false]);
        }),
      );
    }).pipe(provide),
  );

for (const identity of ['account', 'user', 'manifest', 'inactive', 'database', 'schema'] as const)
  effectIt.effect(`does not coalesce a different ${identity} identity`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* withReadyRecallMaintenanceScope(
        Effect.gen(function* () {
          yield* f.missing();
          const scope = {
            ...f.scope,
            ...(identity === 'account' ? {account: 'other'} : {}),
            ...(identity === 'user' ? {user: 'other'} : {}),
            ...(identity === 'manifest' ? {manifestPath: '/different/manifest.yaml'} : {}),
            ...(identity === 'inactive' ? {includeInactive: true} : {}),
          };
          const result = yield* makeReadyRecallMaintenance(scope).missing(
            identity === 'database' ? `${f.database}.other` : f.database,
            identity === 'schema' ? 14 : 13,
          );
          expect(result).toBe('queued');
          expect(f.requests).toHaveLength(2);
        }),
      );
    }).pipe(provide),
  );

effectIt.effect('shares the original 100ms across pending proof and reconciliation without extending it', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* withReadyRecallMaintenanceScope(
      Effect.gen(function* () {
        const enqueueEntered = yield* Deferred.make<void>();
        f.controls.beforeEnqueue = Deferred.succeed(enqueueEntered, undefined).pipe(Effect.andThen(Effect.sleep(80)));
        const first = yield* f.missing().pipe(Effect.forkScoped);
        yield* Deferred.await(enqueueEntered);
        yield* TestClock.adjust(80);
        expect(yield* Fiber.join(first)).toBe('queued');
        const probeEntered = yield* Deferred.make<void>();
        f.controls.beforePending = Deferred.succeed(probeEntered, undefined).pipe(Effect.andThen(Effect.sleep(30)));
        const second = yield* f.missing().pipe(Effect.forkScoped);
        yield* Deferred.await(probeEntered);
        yield* TestClock.adjust(20);
        expect(yield* Fiber.join(second)).toBe('unavailable');
        expect(yield* f.reconcile()).toBe('unavailable');
        expect(f.requests).toEqual([false]);
      }),
    );
  }).pipe(provide),
);

effectIt.effect('fails closed before enqueue when the canonical generation cannot be observed', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.controls.invalidGeneration = true;
    expect(yield* withReadyRecallMaintenanceScope(f.missing())).toBe('unavailable');
    expect(f.requests).toEqual([]);
  }).pipe(provide),
);

effectIt.effect('does not report a weak queued revision as a completed stronger request at the deadline', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* withReadyRecallMaintenanceScope(
      Effect.gen(function* () {
        expect(yield* f.missing()).toBe('queued');
        yield* TestClock.adjust(80);
        const entered = yield* Deferred.make<void>();
        f.controls.beforeEnqueue = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.sleep(30)));
        const stronger = yield* f.reconcile().pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(20);
        expect(yield* Fiber.join(stronger)).toBe('unavailable');
        expect(f.requests).toEqual([false, true]);
        expect(f.controls.pending?.reconcile).toBe(false);
      }),
    );
  }).pipe(provide),
);

effectIt.effect('interrupts an in-flight attempt without leaking it into another sections operation', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const entered = yield* Deferred.make<void>();
    f.controls.beforeEnqueue = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
    const reader = yield* withReadyRecallMaintenanceScope(f.missing()).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(reader);
    expect(f.controls.pending).toBeUndefined();
    f.controls.beforeEnqueue = Effect.void;
    expect(yield* withReadyRecallMaintenanceScope(f.missing())).toBe('queued');
    expect(f.requests).toEqual([false, false]);
  }).pipe(provide),
);

fcEffectProp(
  effectIt,
  'matches an independent pending-revision and strongest-intent state model',
  {
    actions: fc.array(fc.constantFrom('missing', 'complete', 'replace', 'advance', 'strong', 'fail', 'recover'), {
      maxLength: 8,
    }),
  },
  ({actions}) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let generation = 0;
      let failure = false;
      let strong = false;
      let publications = 0;
      let pending: {revision: number; generation: number; strong: boolean} | undefined;
      let previous: {revision?: number; generation: number; strong: boolean; failed: boolean} | undefined;
      yield* withReadyRecallMaintenanceScope(
        Effect.gen(function* () {
          for (const action of ['missing', ...actions, 'missing']) {
            if (action === 'complete') {
              pending = undefined;
              f.controls.pending = undefined;
            } else if (action === 'replace') {
              if (pending && f.controls.pending) {
                pending = {...pending, revision: -1};
                f.controls.pending = {...f.controls.pending, revision: '00000000-0000-4000-8000-999999999999'};
              }
            } else if (action === 'advance') {
              generation++;
              f.controls.generation = String(generation);
            } else if (action === 'fail' || action === 'recover') {
              failure = action === 'fail';
              f.controls.fail = failure;
            } else {
              strong ||= action === 'strong';
              const equivalent =
                action === 'missing' && previous?.generation === generation && previous.strong === strong
                  ? previous
                  : undefined;
              const covered =
                equivalent !== undefined &&
                (equivalent.failed ||
                  (pending?.revision === equivalent.revision &&
                    pending?.generation === generation &&
                    (!strong || pending.strong)));
              const expected = covered
                ? equivalent?.failed
                  ? 'unavailable'
                  : 'queued'
                : failure
                  ? 'unavailable'
                  : 'queued';
              if (!covered) {
                publications++;
                if (!failure) pending = {revision: publications, generation, strong};
                previous =
                  action === 'missing'
                    ? {generation, strong, failed: failure, revision: failure ? undefined : publications}
                    : undefined;
              }
              expect(yield* action === 'strong' ? f.reconcile() : f.missing()).toBe(expected);
              expect(f.requests).toHaveLength(publications);
              if (strong && publications > 0 && action === 'strong') expect(f.requests.at(-1)).toBe(true);
            }
          }
        }),
      );
    }).pipe(provide),
  {fastCheck: {numRuns: 16}},
);
