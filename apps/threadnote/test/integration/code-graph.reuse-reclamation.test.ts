import {Array as EffectArray} from 'effect';
import {describe, expect, it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, PlatformError} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {CommandExecutor} from '@threadnote/platform/command';
import {CodeGraphIndexer, type CodeGraphIndexOptions} from '@threadnote/graph/indexer';
import {CodeGraphStore, type CodeGraphStoreShape} from '@threadnote/graph/store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';
import {provideTestLayer} from '../helpers/effect-layer.js';

type Cleanup = {readonly mode: string; readonly retained: readonly string[]; readonly scopeId?: string};
type Event =
  | {readonly type: 'cleanup'; readonly cleanup: Cleanup}
  | {readonly type: 'claim' | 'alias' | 'incremental'; readonly snapshotId?: string};

describe('application indexer reclamation policy', () => {
  for (const scoped of [false, true]) {
    effectIt.effect(`preserves cleanup policy for an already-ready ${scoped ? 'scoped' : 'full'} snapshot`, () =>
      withFixture(fixture =>
        Effect.gen(function* () {
          const options = scoped
            ? {
                ...fixture.options,
                project: {
                  uri: 'threadnote://resources/repos/fixture',
                  graph: {closure: 'dependencies' as const, roots: ['packages/a']},
                },
              }
            : fixture.options;
          const baseline = yield* fixture.indexer.index(options);
          expect(fixture.events[0]).toMatchObject({
            cleanup: {mode: 'required', scopeId: baseline.snapshot.scopeId},
          });
          fixture.events.length = 0;
          const warm = yield* fixture.indexer.index(options);
          expect(warm.snapshot.id).toBe(baseline.snapshot.id);
          expect(warm.materialization?.mode).toBe('reused-snapshot');
          expect(fixture.events).toEqual(
            scoped ? [] : [{type: 'cleanup', cleanup: {mode: 'deferred', retained: [], scopeId: undefined}}],
          );
          if (scoped) expect(baseline.snapshot.scopeId).toMatch(/^code-graph-scope:/u);
        }),
      ),
    );
  }

  effectIt.effect('drains before clean alias, clean incremental, forced full, and dirty direct publication', () =>
    withFixture(fixture =>
      Effect.gen(function* () {
        yield* fixture.indexer.index(fixture.options);
        fixture.events.length = 0;
        yield* fixture.git(['commit', '--allow-empty', '-qm', 'graph-equivalent commit']);
        const alias = yield* fixture.indexer.index(fixture.options);
        expect(alias.materialization?.mode).toBe('reused-snapshot');
        expect(EffectArray.map(fixture.events, event => event.type)).toEqual(['cleanup', 'alias']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required'}});

        fixture.events.length = 0;
        yield* fixture.changeSource('committedChange');
        yield* fixture.git(['commit', '-am', 'change one source', '-q']);
        const incremental = yield* fixture.indexer.index(fixture.options);
        expect(incremental.materialization?.mode).toBe('incremental-clean');
        expect(EffectArray.map(fixture.events, event => event.type)).toEqual(['cleanup', 'incremental']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required'}});

        fixture.events.length = 0;
        const forced = yield* fixture.indexer.index({...fixture.options, force: true});
        expect(forced.materialization?.mode).toBe('full');
        expect(EffectArray.map(fixture.events, event => event.type)).toEqual(['cleanup', 'claim']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required', retained: [forced.snapshot.id]}});

        fixture.events.length = 0;
        yield* fixture.changeSource('dirtyChange');
        const dirty = yield* fixture.indexer.index({...fixture.options, incrementalOverlay: false});
        expect(dirty.materialization?.mode).toBe('full');
        expect(EffectArray.map(fixture.events, event => event.type)).toEqual(['cleanup', 'claim']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required', retained: [dirty.snapshot.id]}});

        fixture.events.length = 0;
        yield* fixture.git(['commit', '-am', 'commit exact dirty graph', '-q']);
        const committedDirty = yield* fixture.indexer.index(fixture.options);
        expect(committedDirty.materialization?.mode).toBe('reused-snapshot');
        expect(committedDirty.snapshot.baseSnapshotId).toBe(dirty.snapshot.id);
        expect(EffectArray.map(fixture.events, event => event.type)).toEqual(['cleanup', 'alias']);
        expect(fixture.events[0]).toMatchObject({cleanup: {mode: 'required'}});
      }),
    ),
  );

  effectIt.effect('makes bounded cleanup progress when a concurrent builder already completed the target', () =>
    withFixture(fixture =>
      Effect.gen(function* () {
        yield* fixture.changeSource('concurrentDirty');
        const scanning = yield* Deferred.make<void>();
        const releaseOwner = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        let held = false;
        const owner = yield* fixture.indexer
          .index({
            ...fixture.options,
            incrementalOverlay: false,
            onProgress: progress => {
              if (held || progress.phase !== 'scanning') return Effect.void;
              held = true;
              return Deferred.succeed(scanning, undefined).pipe(Effect.andThen(Deferred.await(releaseOwner)));
            },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(scanning);
        const waiter = yield* fixture.indexer
          .index({
            ...fixture.options,
            incrementalOverlay: false,
            onProgress: progress =>
              progress.phase === 'waiting' && progress.reason === 'request-lock'
                ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid)
                : Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* Deferred.succeed(releaseOwner, undefined);
        const built = yield* Fiber.join(owner);
        const reused = yield* Fiber.join(waiter);
        expect(reused.snapshot.id).toBe(built.snapshot.id);
        expect(reused.materialization?.mode).toBe('reused-snapshot');
        expect(EffectArray.map(fixture.events, event => event.type)).toEqual(['cleanup', 'claim', 'cleanup']);
        expect(fixture.events.at(-1)).toEqual({
          type: 'cleanup',
          cleanup: {mode: 'deferred', retained: [], scopeId: undefined},
        });
      }),
    ),
  );
});

describe('reclamation fixture lifecycle', () => {
  effectIt.layer(BunServices.layer)(it => {
    it.effect('disposes an absent root only after the live fixture body has been verified', () =>
      checkFixtureLifecycle('absent-after-body'),
    );

    it.effect('detects missing roots and unintended source changes before body completion', () =>
      Effect.gen(function* () {
        for (const fault of ['missing-root', 'changed-source'] as const) yield* checkFixtureLifecycle(fault);
      }),
    );

    it.effect('propagates non-NotFound disposal failures after a verified body', () =>
      checkFixtureLifecycle('cleanup-error'),
    );

    fcEffectProp(
      it,
      'preserves live fixture integrity and disposal ownership across bounded lifecycle states',
      {
        checks: fc.integer({min: 1, max: 3}),
        changed: fc.boolean(),
        mutatedFile: fc.integer({min: 0, max: 11}),
      },
      ({checks, changed, mutatedFile}) =>
        Effect.gen(function* () {
          for (const fault of [
            'retained',
            'missing-root',
            'changed-source',
            'absent-after-body',
            'cleanup-error',
          ] as const)
            yield* checkFixtureLifecycle(fault, checks, changed ? 'intendedFixtureChange' : undefined, mutatedFile);
        }),
      {fastCheck: {numRuns: 8}},
    );
  });
});

const makeFixtureRoot = (fs: FileSystem.FileSystem) =>
  makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-reuse-policy-');

const assertLiveFixture = Effect.fn('test.reclamation.assertLiveFixture')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  temporary: string,
  changedName?: string,
) {
  expect(yield* fs.exists(temporary), 'owned reclamation fixture root must remain present').toBe(true);
  for (let index = 0; index < 12; index += 1) {
    const expected =
      index === 0 && changedName !== undefined
        ? `export function ${changedName}() { return 42; }\n`
        : `export function original${index}() { return ${index}; }\n`;
    expect(
      yield* fs.readFileString(path.join(temporary, 'repository', 'packages', 'a', `file-${index}.ts`)),
      'reclamation fixture source bytes must match the intended change',
    ).toBe(expected);
  }
});

const checkFixtureLifecycle = Effect.fn('test.reclamation.checkFixtureLifecycle')(function* (
  fault: 'retained' | 'absent-after-body' | 'missing-root' | 'changed-source' | 'cleanup-error',
  checks = 1,
  changedName?: string,
  mutatedFile = 0,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const neighbor = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-reuse-neighbor-'});
  const neighborSource = path.join(neighbor, 'untouched.txt');
  yield* fs.writeFileString(neighborSource, 'outside fixture ownership\n');
  let temporary: string | undefined;
  let bodyVerified = false;
  const cleanupFailure = PlatformError.systemError({
    _tag: 'PermissionDenied',
    cause: {code: 'EACCES'},
    module: 'FileSystem',
    method: 'remove',
    pathOrDescriptor: 'owned reclamation fixture',
  });
  const cleanupFs = FileSystem.FileSystem.of({
    ...fs,
    remove: (target, options) =>
      fault === 'cleanup-error' && target === temporary ? Effect.fail(cleanupFailure) : fs.remove(target, options),
  });
  const {result, rootPresentAfterRelease} = yield* Effect.scoped(
    Effect.gen(function* () {
      temporary = yield* makeFixtureRoot(cleanupFs);
      const sourceDirectory = path.join(temporary, 'repository', 'packages', 'a');
      yield* fs.makeDirectory(sourceDirectory, {recursive: true});
      for (let index = 0; index < 12; index += 1) {
        yield* fs.writeFileString(
          path.join(sourceDirectory, `file-${index}.ts`),
          `export function original${index}() { return ${index}; }\n`,
        );
      }
      if (changedName !== undefined)
        yield* fs.writeFileString(
          path.join(sourceDirectory, 'file-0.ts'),
          `export function ${changedName}() { return 42; }\n`,
        );
      for (let check = 0; check < checks; check += 1) yield* assertLiveFixture(fs, path, temporary, changedName);
      if (fault === 'missing-root') yield* fs.remove(temporary, {recursive: true});
      if (fault === 'changed-source')
        yield* fs.writeFileString(path.join(sourceDirectory, `file-${mutatedFile}.ts`), 'unintended source bytes\n');
      yield* assertLiveFixture(fs, path, temporary, changedName);
      bodyVerified = true;
      // Only this control deletes the root after every live-body check succeeded.
      if (fault === 'absent-after-body') yield* fs.remove(temporary, {recursive: true});
    }),
  ).pipe(
    Effect.exit,
    Effect.flatMap(result =>
      (temporary === undefined ? Effect.succeed(false) : fs.exists(temporary)).pipe(
        Effect.map(rootPresentAfterRelease => ({result, rootPresentAfterRelease})),
      ),
    ),
    Effect.ensuring(
      Effect.suspend(() =>
        temporary === undefined ? Effect.void : fs.remove(temporary, {force: true, recursive: true}).pipe(Effect.orDie),
      ),
    ),
  );
  expect(bodyVerified).toBe(fault !== 'missing-root' && fault !== 'changed-source');
  expect(rootPresentAfterRelease).toBe(fault === 'cleanup-error');
  if (fault === 'absent-after-body' || fault === 'retained') expect(result).toEqual(Exit.succeed(undefined));
  else {
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      if (fault === 'cleanup-error') expect(Cause.squash(result.cause)).toBe(cleanupFailure);
      else
        expect(Cause.pretty(result.cause)).toContain(
          fault === 'missing-root'
            ? 'owned reclamation fixture root must remain present'
            : 'reclamation fixture source bytes must match the intended change',
        );
    }
  }
  expect(yield* fs.readFileString(neighborSource)).toBe('outside fixture ownership\n');
});

const withFixture = Effect.fn(function* <A, E, R>(
  use: (fixture: {
    readonly indexer: CodeGraphIndexer['Service'];
    readonly options: CodeGraphIndexOptions;
    readonly events: Event[];
    readonly changeSource: (name: string) => Effect.Effect<void, unknown>;
    readonly git: (args: readonly string[]) => Effect.Effect<void, unknown>;
  }) => Effect.Effect<A, E, R>,
) {
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const command = yield* CommandExecutor;
    const store = yield* CodeGraphStore;
    const temporary = yield* makeFixtureRoot(fs);
    const root = path.join(temporary, 'repository');
    const sourceDirectory = path.join(root, 'packages', 'a');
    yield* fs.makeDirectory(sourceDirectory, {recursive: true});
    yield* fs.writeFileString(
      path.join(root, 'package.json'),
      JSON.stringify({name: 'fixture', private: true, workspaces: ['packages/*']}),
    );
    yield* fs.writeFileString(
      path.join(sourceDirectory, 'package.json'),
      JSON.stringify({name: '@fixture/a', type: 'module'}),
    );
    for (let index = 0; index < 12; index += 1) {
      yield* fs.writeFileString(
        path.join(sourceDirectory, `file-${index}.ts`),
        `export function original${index}() { return ${index}; }\n`,
      );
    }
    const git = (args: readonly string[]) => command.execute('git', ['-C', root, ...args]).pipe(Effect.asVoid);
    yield* git(['init', '-q']);
    yield* git(['config', 'user.name', 'Fixture']);
    yield* git(['config', 'user.email', 'fixture@example.test']);
    yield* git(['add', '.']);
    yield* git(['commit', '-qm', 'initial']);
    const events: Event[] = [];
    const instrumented: CodeGraphStoreShape = {
      ...store,
      retireIncompleteWorktreeSnapshots: (...args) =>
        Effect.sync(() => {
          events.push({
            type: 'cleanup',
            cleanup: {mode: args[5]?.cleanupMode ?? 'required', retained: [...args[3]], scopeId: args[5]?.scopeId},
          });
        }).pipe(Effect.andThen(store.retireIncompleteWorktreeSnapshots(...args))),
      claimPersistentBuild: (...args) =>
        Effect.sync(() => {
          events.push({type: 'claim', snapshotId: args[2].id});
        }).pipe(Effect.andThen(store.claimPersistentBuild(...args))),
      activateCleanSnapshotAlias: (...args) =>
        Effect.sync(() => {
          events.push({type: 'alias', snapshotId: args[2].id});
        }).pipe(Effect.andThen(store.activateCleanSnapshotAlias!(...args))),
      preparePersistedIncrementalActivation: (...args) =>
        Effect.sync(() => {
          events.push({type: 'incremental'});
        }).pipe(Effect.andThen(store.preparePersistedIncrementalActivation(...args))),
    };
    const context = yield* Layer.build(
      Layer.fresh(CodeGraphIndexer.layer).pipe(Layer.provide(Layer.succeed(CodeGraphStore, instrumented))),
    );
    const indexer = Context.get(context, CodeGraphIndexer);
    let changedName: string | undefined;
    const assertLive = () => assertLiveFixture(fs, path, temporary, changedName);
    const result = yield* use({
      indexer: {
        ...indexer,
        index: options => assertLive().pipe(Effect.andThen(indexer.index(options)), Effect.tap(assertLive)),
      },
      options: {
        cwd: root,
        threadnoteHome: path.join(temporary, 'home'),
        ensureVectors: false,
        diskCapacityAvailableBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
      },
      events,
      git,
      changeSource: name =>
        fs.writeFileString(path.join(sourceDirectory, 'file-0.ts'), `export function ${name}() { return 42; }\n`).pipe(
          Effect.tap(() => {
            changedName = name;
            return assertLive();
          }),
        ),
    });
    yield* assertLive();
    return result;
  }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);
});
