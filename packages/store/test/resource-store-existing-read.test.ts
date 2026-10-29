import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, FileSystem, Layer, Option, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {externalResourceUri, renderExternalResource} from '@threadnote/store/external-resource';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';

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
const URI = 'threadnote://user/tester/memories/durable/example.md';
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'store-existing-read-'});
  const home = path.join(root, 'home');
  const location = {home, account: 'local', user: 'tester'};
  const snapshot = Effect.gen(function* () {
    const names = (yield* fs.readDirectory(root, {recursive: true})).sort();
    return yield* Effect.forEach(names, name =>
      Effect.gen(function* () {
        const file = path.join(root, name);
        const link = yield* fs.readLink(file).pipe(Effect.option);
        const value = Option.isSome(link)
          ? {link: link.value}
          : (yield* fs.stat(file)).type === 'File'
            ? {sha256: sha256HexSync(yield* fs.readFile(file))}
            : 'directory';
        return {name, value};
      }),
    );
  });
  return {fs, path, root, home, location, snapshot, store: yield* ResourceStore};
});

effectIt.effect.each(['home', 'data', 'account'] as const)(
  'existing-only reads do not create an absent %s root',
  missing =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (missing !== 'home') yield* f.fs.makeDirectory(f.home);
      if (missing === 'account') yield* f.fs.makeDirectory(f.path.join(f.home, 'data'));
      const before = yield* f.snapshot;
      const failed = yield* f.store.read(f.location, URI, {existingOnly: true}).pipe(Effect.result);
      expect(Result.isFailure(failed) && failed.failure._tag).toBe('ResourceNotFound');
      expect(yield* f.snapshot).toEqual(before);
    }).pipe(provide),
);

effectIt.effect('ordinary reads retain first-use root creation and report the missing resource', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const failed = yield* f.store.read(f.location, URI).pipe(Effect.result);
    expect(Result.isFailure(failed) && failed.failure._tag).toBe('ResourceNotFound');
    expect((yield* f.fs.readDirectory(f.root, {recursive: true})).sort()).toEqual([
      'home',
      f.path.join('home', 'data'),
      f.path.join('home', 'data', 'local'),
    ]);
  }).pipe(provide),
);

effectIt.effect('reads existing personal bytes identically in both modes without changing storage', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const content = '\nMEMORY\r\nkind: durable\r\n\r\nExact Unicode bytes: λ.\n';
    yield* f.store.write(f.location, URI, content, {mode: 'create'});
    const before = yield* f.snapshot;
    expect(yield* f.store.read(f.location, URI, {existingOnly: true})).toBe(content);
    expect(yield* f.store.read(f.location, URI)).toBe(content);
    expect(yield* f.snapshot).toEqual(before);
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect.each(['data', 'account', 'directory', 'file'] as const)(
  'existing-only reads reject a symbolic link at the %s component',
  component =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const account = f.path.join(f.home, 'data', f.location.account);
      const document = f.path.join(account, 'user', 'tester', 'memories', 'durable', 'example.md');
      const link =
        component === 'data'
          ? f.path.join(f.home, 'data')
          : component === 'account'
            ? account
            : component === 'directory'
              ? f.path.dirname(document)
              : document;
      yield* f.fs.makeDirectory(f.path.dirname(link), {recursive: true});
      const outside = f.path.join(f.root, 'outside');
      if (component === 'file') yield* f.fs.writeFileString(outside, 'must not read this');
      else {
        yield* f.fs.makeDirectory(outside);
        if (component === 'directory')
          yield* f.fs.writeFileString(f.path.join(outside, 'example.md'), 'must not read this');
      }
      // Even a dangling owned-root link must be refused.
      yield* f.fs.symlink(component === 'data' ? f.path.join(outside, 'absent') : outside, link);
      const before = yield* f.snapshot;
      const failed = yield* f.store.read(f.location, URI, {existingOnly: true}).pipe(Effect.result);
      expect(Result.isFailure(failed) && failed.failure._tag).toBe('ResourcePathUnsafe');
      expect(yield* f.snapshot).toEqual(before);
    }).pipe(provide),
);

effectIt.effect.each(['data', 'account'] as const)(
  'existing-only reads refuse a nondirectory %s root without changing it',
  component =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const target = f.path.join(f.home, 'data', ...(component === 'account' ? [f.location.account] : []));
      yield* f.fs.makeDirectory(f.path.dirname(target), {recursive: true});
      yield* f.fs.writeFileString(target, 'preserve this file');
      const before = yield* f.snapshot;
      const failed = yield* f.store.read(f.location, URI, {existingOnly: true}).pipe(Effect.result);
      expect(Result.isFailure(failed) && failed.failure._tag).toBe('ResourcePathUnsafe');
      expect(yield* f.snapshot).toEqual(before);
    }).pipe(provide),
);

effectIt.effect('existing-only reads preserve namespace, user and portable path restrictions on a cold home', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* f.snapshot;
    for (const [uri, tag] of [
      ['threadnote://user/other/memories/durable/example.md', 'ResourceAccessDenied'],
      ['threadnote://team/example.md', 'ResourceAccessDenied'],
    ] as const) {
      const failed = yield* f.store.read(f.location, uri, {existingOnly: true}).pipe(Effect.result);
      expect(Result.isFailure(failed) && failed.failure._tag).toBe(tag);
      expect(yield* f.snapshot).toEqual(before);
    }
    // ResourceStore's existing URI parser rejects malformed identifiers synchronously.
    const malformed = yield* f.store
      .read(f.location, 'threadnote://resources/%2e%2e/example.md', {existingOnly: true})
      .pipe(Effect.exit);
    expect(malformed._tag).toBe('Failure');
    if (malformed._tag === 'Failure') expect(Cause.squash(malformed.cause)).toMatchObject({_tag: 'InvalidResourceId'});
    expect(yield* f.snapshot).toEqual(before);
  }).pipe(provide),
);

effectIt.effect('existing-only reads do not resolve a different case to a resource', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const directory = f.path.join(f.home, 'data', f.location.account, 'resources');
    yield* f.fs.makeDirectory(directory, {recursive: true});
    yield* f.fs.writeFileString(f.path.join(directory, 'Case.md'), 'case-sensitive resource');
    const before = yield* f.snapshot;
    const failed = yield* f.store
      .read(f.location, 'threadnote://resources/case.md', {existingOnly: true})
      .pipe(Effect.result);
    expect(Result.isFailure(failed)).toBe(true);
    if (Result.isFailure(failed)) expect(['ResourceNotFound', 'ResourcePathUnsafe']).toContain(failed.failure._tag);
    expect(yield* f.snapshot).toEqual(before);
  }).pipe(provide),
);

effectIt.effect('existing-only reads retain external source access checks', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const metadata = {
      version: 1 as const,
      provider: 'github' as const,
      sourceId: 'test-docs',
      documentId: 'doc_1',
      pageId: 'page_1',
      chunkId: 'line_1',
      project: 'threadnote',
      title: 'Synthetic page',
      rendererVersion: '1',
      scrubberVersion: '1',
      coverage: 'github-conversation' as const,
      browserLink: 'https://github.com/owner/repo/issues/42#issuecomment-1',
    };
    const uri = externalResourceUri(metadata);
    yield* f.store.write(f.location, uri, renderExternalResource(metadata, 'Protected evidence'), {mode: 'create'});
    const before = yield* f.snapshot;
    const failed = yield* f.store.read(f.location, uri, {existingOnly: true}).pipe(Effect.result);
    expect(Result.isFailure(failed) && failed.failure._tag).toBe('ResourceAccessDenied');
    expect(yield* f.snapshot).toEqual(before);
  }).pipe(provide, TestClock.withLive),
);

fcEffectProp(
  effectIt,
  'existing-only reads preserve every cold-root state and return exact existing content',
  {
    depth: fc.integer({min: 0, max: 4}),
    suffix: fc.integer({min: 0, max: 1_000_000}),
    personal: fc.boolean(),
    content: fc.string({maxLength: 100}),
  },
  ({depth, suffix, personal, content}) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const account = `account-${suffix}`;
      const user = `user-${suffix}`;
      const location = {...f.location, account, user};
      const segments = personal ? ['user', user, 'memories', 'durable', 'entry.md'] : ['resources', 'entry.md'];
      const uri = `threadnote://${EffectArray.join(segments, '/')}`;
      if (depth >= 1) yield* f.fs.makeDirectory(f.home);
      if (depth >= 2) yield* f.fs.makeDirectory(f.path.join(f.home, 'data'));
      if (depth >= 3) yield* f.fs.makeDirectory(f.path.join(f.home, 'data', account));
      if (depth === 4) {
        const document = f.path.join(f.home, 'data', account, ...segments);
        yield* f.fs.makeDirectory(f.path.dirname(document), {recursive: true});
        yield* f.fs.writeFileString(document, content);
      }
      const before = yield* f.snapshot;
      for (let read = 0; read < 2; read++) {
        const observed = yield* f.store.read(location, uri, {existingOnly: true}).pipe(Effect.result);
        if (depth === 4) {
          expect(Result.isSuccess(observed) && observed.success).toBe(content);
          expect(yield* f.store.read(location, uri)).toBe(content);
        } else expect(Result.isFailure(observed) && observed.failure._tag).toBe('ResourceNotFound');
        expect(yield* f.snapshot).toEqual(before);
      }
    }).pipe(provide),
  {fastCheck: {numRuns: 20}},
);
