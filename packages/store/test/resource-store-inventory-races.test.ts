import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, PlatformError} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';

const systemLayer = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'resource-store-existing-read.test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => ({...environment}),
        sanitizeExternal: environment => ({...environment}),
      }),
    ),
  ),
);
const dependencies = Layer.mergeAll(
  BunServices.layer,
  systemLayer,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const testLayer = Layer.merge(dependencies, ResourceStore.layer.pipe(Layer.provide(dependencies)));
const provide = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(testLayer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
const ROOT = 'threadnote://user/tester/memories/handoffs/active/fixture';
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryHome = yield* fs.makeTempDirectoryScoped({prefix: 'inventory-races-'});
  const home = yield* fs.realPath(temporaryHome);
  const location = {home, account: 'local', user: 'tester'};
  const store = yield* ResourceStore;
  yield* store.write(location, `${ROOT}/seed.md`, 'seed', {mode: 'create'});
  const directory = path.join(home, 'data/local/user/tester/memories/handoffs/active/fixture');
  const withFs = (overrides: Partial<FileSystem.FileSystem>) =>
    Layer.build(ResourceStore.layerWith()).pipe(
      Effect.provideService(FileSystem.FileSystem, {...fs, ...overrides}),
      Effect.map(context => Context.get(context, ResourceStore)),
    );
  return {fs, path, home, location, store, directory, withFs};
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provide);

for (const mode of ['create', 'replace'] as const) {
  effectIt.effect(`omits an atomic ${mode} temporary file removed after enumeration`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const ready = yield* Deferred.make<void>();
      const listed = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      let temporary = '';
      const uri = `${ROOT}/${mode}.md`;
      if (mode === 'replace') yield* f.store.write(f.location, uri, 'old', {mode: 'create'});
      const store = yield* f.withFs({
        link: (source, target) =>
          source.endsWith('.tmp') && f.path.dirname(source) === f.directory
            ? Effect.gen(function* () {
                temporary = source;
                yield* Deferred.succeed(ready, undefined);
                yield* Deferred.await(listed).pipe(Effect.timeout('5 seconds'), Effect.orDie);
                return yield* f.fs.link(source, target);
              })
            : f.fs.link(source, target),
        rename: (source, target) =>
          source.endsWith('.tmp') && f.path.dirname(source) === f.directory
            ? Effect.gen(function* () {
                temporary = source;
                yield* Deferred.succeed(ready, undefined);
                yield* Deferred.await(listed).pipe(Effect.timeout('5 seconds'), Effect.orDie);
                yield* f.fs.rename(source, target);
                yield* Deferred.succeed(committed, undefined);
              })
            : f.fs.rename(source, target),
        remove: (target, options) =>
          f.fs
            .remove(target, options)
            .pipe(Effect.tap(() => (target === temporary ? Deferred.succeed(committed, undefined) : Effect.void))),
        readDirectory: (directory, options) =>
          f.fs.readDirectory(directory, options).pipe(
            Effect.tap(names =>
              directory === f.directory && names.includes(f.path.basename(temporary))
                ? Effect.gen(function* () {
                    yield* Deferred.succeed(listed, undefined);
                    yield* Deferred.await(committed).pipe(Effect.timeout('5 seconds'), Effect.orDie);
                    return;
                  })
                : Effect.void,
            ),
          ),
      });
      const writer = yield* Effect.forkChild(store.write(f.location, uri, 'new', {mode}));
      yield* Deferred.await(ready).pipe(Effect.timeout('5 seconds'), Effect.orDie);
      expect(f.path.dirname(temporary)).toBe(f.directory);
      const entries = yield* store.list(f.location, ROOT);
      yield* Fiber.join(writer);
      expect(entries.some(entry => entry.uri.includes('.tmp'))).toBe(false);
      expect(yield* store.read(f.location, uri)).toBe('new');
      expect(entries.some(entry => entry.uri === `${ROOT}/seed.md`)).toBe(true);
    }).pipe(run),
  );
}

for (const kind of ['file', 'directory'] as const) {
  effectIt.effect(`omits a vanished enumerated ${kind} without a partial branch`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const child = f.path.join(f.directory, 'gone');
      if (kind === 'directory') {
        yield* f.fs.makeDirectory(child);
        yield* f.fs.writeFileString(f.path.join(child, 'nested.md'), 'nested');
      } else yield* f.fs.writeFileString(child, 'gone');
      let removed = false;
      const store = yield* f.withFs({
        readDirectory: (directory, options) => {
          if (kind === 'directory' && directory === child && !removed) {
            removed = true;
            return f.fs.remove(child, {recursive: true}).pipe(Effect.andThen(f.fs.readDirectory(directory, options)));
          }
          return f.fs.readDirectory(directory, options).pipe(
            Effect.tap(() =>
              kind === 'file' && directory === f.directory && !removed
                ? Effect.gen(function* () {
                    removed = true;
                    yield* f.fs.remove(child);
                  })
                : Effect.void,
            ),
          );
        },
      });
      expect((yield* store.list(f.location, ROOT, {recursive: true})).map(entry => entry.uri)).toEqual([
        `${ROOT}/seed.md`,
      ]);
    }).pipe(run),
  );
}

for (const kind of ['dangling', 'internal', 'external'] as const) {
  effectIt.effect(`rejects ${kind} child links, including temporary-looking names`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const target =
        kind === 'dangling'
          ? f.path.join(f.home, 'missing')
          : kind === 'internal'
            ? f.path.join(f.directory, 'seed.md')
            : f.path.join(f.home, 'external.md');
      if (kind === 'external') yield* f.fs.writeFileString(target, 'external');
      yield* f.fs.symlink(target, f.path.join(f.directory, '.seed.md.fixture.tmp'));
      const result = yield* f.store.list(f.location, ROOT).pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') expect(result.failure._tag).toBe('ResourcePathUnsafe');
    }).pipe(run),
  );
}

for (const swap of ['parent', 'root'] as const) {
  effectIt.effect(`rejects ${swap} redirection while confirming child absence`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const parent = swap === 'root' ? f.directory : f.path.join(f.directory, 'parent');
      if (swap === 'parent') yield* f.fs.makeDirectory(parent);
      yield* f.fs.writeFileString(f.path.join(parent, 'gone.md'), 'gone');
      let swapped = false;
      const store = yield* f.withFs({
        readDirectory: (directory, options) =>
          f.fs.readDirectory(directory, options).pipe(
            Effect.tap(() =>
              directory === parent && !swapped
                ? Effect.gen(function* () {
                    swapped = true;
                    yield* f.fs.rename(parent, parent + '-old');
                    yield* f.fs.remove(f.path.join(parent + '-old', 'gone.md'));
                    yield* f.fs.symlink(parent + '-old', parent);
                  })
                : Effect.void,
            ),
          ),
      });
      const result = yield* store.list(f.location, ROOT, {recursive: true}).pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') expect(result.failure._tag).toBe('ResourcePathUnsafe');
    }).pipe(run),
  );
}

for (const tag of ['PermissionDenied', 'Unknown'] as const) {
  effectIt.effect(`propagates ${tag} rather than treating it as child absence`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const error = PlatformError.systemError({_tag: tag, module: 'FileSystem', method: 'realPath'});
      const store = yield* f.withFs({
        realPath: value => (value === f.path.join(f.directory, 'seed.md') ? Effect.fail(error) : f.fs.realPath(value)),
      });
      const result = yield* store.list(f.location, ROOT).pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('ResourceIoFailed');
        if (result.failure._tag === 'ResourceIoFailed') expect(result.failure.cause).toBe(error);
      }
    }).pipe(run),
  );
}

effectIt.effect('does not omit a missing inventory root', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.remove(f.directory, {recursive: true});
    const result = yield* f.store.list(f.location, ROOT).pipe(Effect.result);
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('ResourceNotFound');
  }).pipe(run),
);

for (const tag of ['PermissionDenied', 'Unknown'] as const) {
  effectIt.effect(`propagates ${tag} while confirming a vanished child with readLink`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const child = f.path.join(f.directory, 'gone.md');
      yield* f.fs.writeFileString(child, 'gone');
      const error = PlatformError.systemError({_tag: tag, module: 'FileSystem', method: 'readLink'});
      let removed = false;
      const store = yield* f.withFs({
        readDirectory: (directory, options) =>
          f.fs.readDirectory(directory, options).pipe(
            Effect.tap(() =>
              directory === f.directory && !removed
                ? Effect.gen(function* () {
                    removed = true;
                    yield* f.fs.remove(child);
                  })
                : Effect.void,
            ),
          ),
        readLink: value => (value === child ? Effect.fail(error) : f.fs.readLink(value)),
      });
      const result = yield* store.list(f.location, ROOT).pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure' && result.failure._tag === 'ResourceIoFailed')
        expect(result.failure.cause).toBe(error);
      else throw new Error('Expected the original readLink failure.');
    }).pipe(run),
  );
}

effectIt.effect('propagates a containing directory disappearance instead of omitting an outer recursive branch', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const parent = f.path.join(f.directory, 'parent');
    yield* f.fs.makeDirectory(parent);
    yield* f.fs.writeFileString(f.path.join(parent, 'gone.md'), 'gone');
    let removed = false;
    const store = yield* f.withFs({
      readDirectory: (directory, options) =>
        f.fs.readDirectory(directory, options).pipe(
          Effect.tap(() =>
            directory === parent && !removed
              ? Effect.gen(function* () {
                  removed = true;
                  yield* f.fs.remove(parent, {recursive: true});
                })
              : Effect.void,
          ),
        ),
    });
    const result = yield* store.list(f.location, ROOT, {recursive: true}).pipe(Effect.result);
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('ResourceIoFailed');
  }).pipe(run),
);
