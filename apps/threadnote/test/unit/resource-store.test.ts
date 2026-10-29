import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {symlink, writeFile as writeFileBytes} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it, it as effectIt} from '@effect/vitest';
import * as FC from 'fast-check';
import {Deferred, Effect, Fiber, FileSystem, Layer, Option, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  ResourceAlreadyExists,
  ResourceConflict,
  ResourceIoFailed,
  ResourceNotFound,
  ResourcePathUnsafe,
  ResourceStore,
  resourceMutationLockFailureMessage,
} from '@threadnote/store/resource-store';

import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {
  loadRecallExactMatches,
  loadRecallIndex,
  recallIndexDatabaseFilename,
  recallIndexStatus,
} from '@threadnote/recall/index';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {InvalidResourceId, parseResourceId} from '@threadnote/store/resource-id';
import {mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('ResourceId', () => {
  it('keeps threadnote URIs canonical', () => {
    expect(parseResourceId('threadnote://resources/repos/threadnote/guide%20file.md#heading')).toEqual({
      anchor: 'heading',
      canonicalUri: 'threadnote://resources/repos/threadnote/guide%20file.md#heading',
      inputScheme: 'threadnote',
      namespace: 'resources',
      segments: ['repos', 'threadnote', 'guide file.md'],
    });
  });

  it('accepts a legacy scheme only as an input alias and emits a threadnote URI', () => {
    expect(parseResourceId('viking://resources/repos/threadnote/guide.md')).toMatchObject({
      canonicalUri: 'threadnote://resources/repos/threadnote/guide.md',
      inputScheme: 'viking',
    });
  });

  it.each([
    'file:///tmp/memory.md',
    'threadnote://resources/../escape.md',
    'threadnote://resources/%2e%2e/escape.md',
    'threadnote://resources/folder%2Fescape.md',
    'threadnote://resources/folder\\escape.md',
    'threadnote://resources/CON',
    'threadnote://resources/trailing.',
    'threadnote://resources/a//b',
    'threadnote://resources/a?query=unsafe',
  ])('rejects unsafe identifier %s', value => {
    expect(() => parseResourceId(value)).toThrow(InvalidResourceId);
  });

  fcProp(
    it,
    'round-trips portable generated segments',
    {
      segment: FC.string({maxLength: 30, minLength: 1}).filter(
        value =>
          value === Effect2.pipe(value, EffectString.trim) &&
          value === Effect2.pipe(value, EffectString.normalize('NFC')) &&
          !/[<>:"|?*\\/#%]/.test(value) &&
          !/[ .]$/.test(value) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value) &&
          !['.', '..'].includes(Effect2.pipe(value, EffectString.toLowerCase)) &&
          EffectArray.every(
            [...value],
            character =>
              Effect2.pipe(
                character,
                EffectString.codePointAt(0),
                Effect2.Option.getOrElse(() => undefined),
              )! > 0x1f,
          ),
      ),
    },
    ({segment}) => {
      const parsed = parseResourceId(`threadnote://resources/${encodeURIComponent(segment)}`);
      expect(parsed.segments).toEqual([segment]);
      expect(parseResourceId(parsed.canonicalUri)).toEqual(parsed);
    },
    {fastCheck: {numRuns: 50}},
  );
});

describe('native ResourceStore', () => {
  const location = (home: string) => ({account: 'local', home, user: 'test-user'});
  const recallInvalidationTestLayer = recallResourceInvalidationLayer;
  const resourceStoreDependencies = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, recallInvalidationTestLayer);
  const resourceStoreLayerWith = (...args: Parameters<typeof ResourceStore.layerWith>) =>
    ResourceStore.layerWith(...args).pipe(Layer.provide(recallInvalidationTestLayer));

  effectIt.effect('delegates committed mutation invalidation through the required recall port', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-resource-invalidation-port-'});
        const observed = yield* Ref.make<
          readonly {
            readonly generation: {readonly currentGeneration: string; readonly previousGeneration: string};
            readonly home: string;
            readonly includeInactive: boolean;
            readonly invalidatedUris: readonly string[];
          }[]
        >([]);
        const invalidationLayer = Layer.succeed(
          ResourceRecallInvalidation,
          ResourceRecallInvalidation.of({
            expire: (observedHome, includeInactive, invalidatedUris, generation) =>
              Ref.update(observed, events => [
                ...events,
                {generation, home: observedHome, includeInactive, invalidatedUris},
              ]),
          }),
        );
        const store = yield* ResourceStore.pipe(
          provideTestLayer(ResourceStore.layerWith().pipe(Layer.provide(invalidationLayer))),
        );
        const uri = 'threadnote://resources/repos/threadnote/port.md';

        yield* store.write(location(home), uri, 'through port', {mode: 'create'});

        const events = [...(yield* Ref.get(observed))].sort(
          (left, right) => Number(left.includeInactive) - Number(right.includeInactive),
        );
        expect(EffectArray.map(events, ({generation: _generation, ...event}) => event)).toEqual([
          {home, includeInactive: false, invalidatedUris: [uri]},
          {home, includeInactive: true, invalidatedUris: [uri]},
        ]);
        expect(events[0]?.generation).toEqual(events[1]?.generation);
        expect(events[0]?.generation.previousGeneration).toBe('');
        expect(events[0]?.generation.currentGeneration).toMatch(/^v1:/);
      }),
    ).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  it('reports privacy-safe lock ownership and bounded recovery guidance', () => {
    const uri = 'threadnote://resources/repos/threadnote/locked.md';
    const message = resourceMutationLockFailureMessage(uri, 4242);

    expect(message).toContain(uri);
    expect(message).toContain('Local process 4242');
    expect(message).toContain('threadnote processes');
    expect(message).toContain('threadnote doctor --dry-run');
    expect(message).not.toContain('/locks/');
    expect(message).not.toContain('token');
  });

  fcEffectProp(
    it,
    'converges when concurrent first-use callers observe the same missing owned root',
    {callerCount: FC.integer({max: 8, min: 2}), distinctAccounts: FC.boolean()},
    ({callerCount, distinctAccounts}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-resource-first-use-race-'});
          const dataRoot = join(home, 'data');
          const release = yield* Deferred.make<void>();
          const observations = yield* Ref.make(0);
          const racingFileSystem = FileSystem.FileSystem.of({
            ...fs,
            exists: target =>
              String(target) === dataRoot
                ? Effect.gen(function* () {
                    const exists = yield* fs.exists(target);
                    const observed = yield* Ref.updateAndGet(observations, count => count + 1);
                    if (observed === callerCount) yield* Deferred.succeed(release, undefined);
                    yield* Deferred.await(release);
                    return exists;
                  })
                : fs.exists(target),
          });
          const store = yield* ResourceStore.pipe(
            provideTestLayer(resourceStoreLayerWith()),
            Effect.provideService(FileSystem.FileSystem, racingFileSystem),
          );
          const accounts = Array.from({length: callerCount}, (_, index) =>
            distinctAccounts ? `account-${index}` : 'local',
          );

          const failures = yield* Effect.forEach(
            accounts,
            account =>
              Effect.flip(store.stat({...location(home), account}, 'threadnote://resources/first-use-race.md')),
            {concurrency: 'unbounded'},
          );

          expect(failures).toHaveLength(callerCount);
          for (const failure of failures) expect(failure).toBeInstanceOf(ResourceNotFound);
          expect((yield* fs.stat(dataRoot)).type).toBe('Directory');
          for (const account of new Set(accounts))
            expect((yield* fs.stat(join(dataRoot, account))).type).toBe('Directory');
          expect(yield* fs.realPath(dataRoot)).toBe(join(yield* fs.realPath(home), 'data'));
        }),
      ).pipe(provideTestLayer(resourceStoreDependencies)),
    {fastCheck: {numRuns: 20}},
  );

  it('atomically creates, reads, compares, replaces, lists, greps, and removes resources', async () => {
    const home = await mkdtemp('threadnote-resource-store-');
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          const uri = 'threadnote://user/test-user/memories/durable/projects/threadnote/storage.md';
          const content = '# Storage\n\nfirst value';
          const created = yield* store.write(location(home), uri, content, {mode: 'create'});

          expect(created.uri).toBe(uri);
          expect(yield* store.read(location(home), uri)).toBe(content);
          expect(yield* store.readBounded(location(home), uri, Buffer.byteLength(content) - 1)).toEqual({
            truncated: true,
          });
          expect(yield* store.readBounded(location(home), uri, Buffer.byteLength(content))).toEqual({
            content,
            truncated: false,
          });
          const bomUri = 'threadnote://resources/repos/threadnote/bom.txt';
          const bomContent = '\uFEFFpreserved byte-order mark';
          yield* store.write(location(home), bomUri, bomContent, {mode: 'create'});
          expect(yield* store.readBounded(location(home), bomUri, Buffer.byteLength(bomContent))).toEqual({
            content: bomContent,
            truncated: false,
          });
          expect((yield* store.stat(location(home), uri)).type).toBe('file');
          expect(
            EffectArray.map(
              yield* store.list(location(home), 'threadnote://user/test-user/memories', {recursive: true}),
              entry => entry.uri,
            ),
          ).toContain(uri);
          expect(
            EffectArray.map(
              yield* store.glob(location(home), 'threadnote://user/test-user/memories', '**/*.md'),
              entry => entry.uri,
            ),
          ).toContain(uri);
          expect(yield* store.grep(location(home), 'threadnote://user/test-user/memories', 'FIRST')).toEqual([
            {line: 3, text: 'first value', uri},
          ]);
          expect(
            yield* store.grepMany(location(home), 'threadnote://user/test-user/memories', ['storage', 'FIRST']),
          ).toEqual([
            {line: 1, term: 'storage', text: '# Storage', uri},
            {line: 3, term: 'FIRST', text: 'first value', uri},
          ]);

          const replaced = yield* store.write(location(home), uri, '# Storage\n\nsecond value', {
            expectedFingerprint: created.fingerprint,
            mode: 'replace',
          });
          expect(replaced.fingerprint).not.toBe(created.fingerprint);
          expect(yield* store.read(location(home), uri)).toContain('second value');

          const conflict = yield* Effect.flip(
            store.write(location(home), uri, 'third value', {
              expectedFingerprint: created.fingerprint,
              mode: 'replace',
            }),
          );
          expect(conflict).toBeInstanceOf(ResourceConflict);

          yield* store.remove(location(home), uri);
          yield* store.remove(location(home), bomUri);
          expect(
            EffectArray.some(
              yield* store.list(location(home), 'threadnote://user/test-user/memories', {recursive: true}),
              entry => entry.uri === uri,
            ),
          ).toBe(false);
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('rejects invalid UTF-8 instead of returning replacement text from a bounded read', async () => {
    const home = await mkdtemp('threadnote-resource-utf8-');
    const uri = 'threadnote://resources/repos/threadnote/invalid-utf8.txt';
    try {
      const resourceDirectory = join(home, 'data', 'local', 'resources', 'repos', 'threadnote');
      await mkdir(resourceDirectory, {recursive: true});
      await writeFileBytes(join(resourceDirectory, 'invalid-utf8.txt'), Uint8Array.of(0xc3, 0x28));

      const failure = await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          return yield* Effect.flip(store.readBounded(location(home), uri, 100));
        }),
      );

      expect(failure).toBeInstanceOf(ResourceIoFailed);
      expect(failure).toMatchObject({operation: 'read', uri});
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('fails closed when a custom bounded-read filesystem omits file identity or modification clocks', async () => {
    const home = await mkdtemp('threadnote-resource-mtime-');
    const uri = 'threadnote://resources/repos/threadnote/no-mtime.txt';
    try {
      const resourceDirectory = join(home, 'data', 'local', 'resources', 'repos', 'threadnote');
      await mkdir(resourceDirectory, {recursive: true});
      await writeFile(join(resourceDirectory, 'no-mtime.txt'), 'bounded content');

      for (const omitted of ['inode', 'mtime'] as const) {
        const failure = await runEffect(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const withoutIdentity = (info: FileSystem.File.Info): FileSystem.File.Info => ({
              ...info,
              ...(omitted === 'inode' ? {ino: Option.none()} : {mtime: Option.none()}),
            });
            const customFs = FileSystem.FileSystem.of({
              ...fs,
              open: (filePath, options) =>
                fs.open(filePath, options).pipe(
                  Effect.map(opened => {
                    const descriptor = (opened as FileSystem.File & {readonly fd?: unknown}).fd;
                    return {
                      [FileSystem.FileTypeId]: FileSystem.FileTypeId,
                      ...(typeof descriptor === 'number' ? {fd: descriptor} : {}),
                      read: buffer => opened.read(buffer),
                      readAlloc: size => opened.readAlloc(size),
                      seek: (offset, from) => opened.seek(offset, from),
                      stat: opened.stat.pipe(Effect.map(withoutIdentity)),
                      sync: opened.sync,
                      truncate: length => opened.truncate(length),
                      write: buffer => opened.write(buffer),
                      writeAll: buffer => opened.writeAll(buffer),
                    };
                  }),
                ),
              stat: filePath => fs.stat(filePath).pipe(Effect.map(withoutIdentity)),
            });
            const store = yield* ResourceStore.pipe(
              provideTestLayer(resourceStoreLayerWith()),
              Effect.provideService(FileSystem.FileSystem, customFs),
            );
            return yield* Effect.flip(store.readBounded(location(home), uri, 100));
          }),
        );

        expect(failure, omitted).toBeInstanceOf(ResourcePathUnsafe);
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('rejects create conflicts and portable case-fold collisions', async () => {
    const home = await mkdtemp('threadnote-resource-collision-');
    try {
      const program = Effect.gen(function* () {
        const store = yield* ResourceStore;
        const upper = 'threadnote://resources/repos/threadnote/Alpha.md';
        yield* store.write(location(home), upper, 'one', {mode: 'create'});
        expect(yield* Effect.flip(store.write(location(home), upper, 'two', {mode: 'create'}))).toBeInstanceOf(
          ResourceAlreadyExists,
        );
        expect(
          yield* Effect.flip(
            store.write(location(home), 'threadnote://resources/repos/threadnote/alpha.md', 'two', {mode: 'create'}),
          ),
        ).toBeInstanceOf(ResourcePathUnsafe);
      });
      await runEffect(program);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('invalidates a warm recall index after a canonical mutation', async () => {
    const home = await mkdtemp('threadnote-resource-index-invalidation-');
    try {
      const config = {account: 'local', agentContextHome: home, user: 'test-user'};
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          expect(yield* loadRecallIndex(config, {includeInactive: false})).toEqual([]);
          const uri = 'threadnote://resources/repos/threadnote/new-resource.md';
          yield* store.write(location(home), uri, '# New resource\n\nmutation-invalidation-anchor', {
            mode: 'create',
          });

          const refreshed = yield* loadRecallIndex(config, {
            includeInactive: false,
            query: 'mutation-invalidation-anchor',
          });
          expect(EffectArray.map(refreshed, candidate => candidate.uri)).toContain(uri);
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it.effect('finishes derived invalidation when interrupted after a canonical commit', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-resource-invalidation-interrupt-'});
        const invalidationStarted = yield* Deferred.make<void>();
        const releaseInvalidation = yield* Deferred.make<void>();
        const blockingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (target, content, options) =>
            Effect2.pipe(String(target), EffectString.includes('.sqlite.stale.'))
              ? Deferred.succeed(invalidationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseInvalidation)),
                  Effect.andThen(fs.writeFileString(target, content, options)),
                )
              : fs.writeFileString(target, content, options),
        });
        const store = yield* ResourceStore.pipe(
          provideTestLayer(resourceStoreLayerWith()),
          Effect.provideService(FileSystem.FileSystem, blockingFileSystem),
        );
        const uri = 'threadnote://resources/repos/threadnote/interrupted.md';
        const write = yield* store
          .write(location(home), uri, 'committed-before-interruption', {mode: 'create'})
          .pipe(Effect.forkChild({startImmediately: true}));

        yield* Deferred.await(invalidationStarted);
        const interruption = yield* Fiber.interrupt(write).pipe(Effect.forkChild({startImmediately: true}));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInvalidation, undefined);
        yield* Fiber.join(interruption);

        expect(yield* store.read(location(home), uri)).toBe('committed-before-interruption');
        for (const includeInactive of [false, true]) {
          expect(
            yield* fs.exists(join(home, 'indexes', 'lexical', `${recallIndexDatabaseFilename(includeInactive)}.stale`)),
          ).toBe(true);
        }
      }),
    ).pipe(provideTestLayer(resourceStoreDependencies)),
  );

  it.effect('recovers from failed derived markers through the durable canonical generation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-resource-invalidation-fallback-'});
        const config = {account: 'local', agentContextHome: home, user: 'test-user'};
        const uri = 'threadnote://resources/repos/threadnote/replaced-through-fallback.md';
        const resourcePath = join(
          home,
          'data',
          'local',
          'resources',
          'repos',
          'threadnote',
          'replaced-through-fallback.md',
        );
        const initialStore = yield* ResourceStore.pipe(provideTestLayer(resourceStoreLayerWith()));
        yield* initialStore.write(location(home), uri, '# First\n\nalpha-42', {mode: 'create'});
        expect((yield* loadRecallIndex(config, {includeInactive: false}))[0]?.text).toContain('alpha-42');
        const initialInfo = yield* fs.stat(resourcePath);
        const initialModifiedAt = Option.getOrThrow(initialInfo.mtime);

        const failedScopes = yield* Ref.make<boolean[]>([]);
        const failedDerivedMarkerFileSystem = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (target, content, options) =>
            Effect2.pipe(String(target), EffectString.includes('.sqlite.stale.'))
              ? Effect.die(new Error('injected derived recall marker failure'))
              : fs.writeFileString(target, content, options),
        });
        const fallbackStore = yield* ResourceStore.pipe(
          provideTestLayer(
            resourceStoreLayerWith({
              onRecallInvalidationFailed: event =>
                Ref.update(failedScopes, scopes => [...scopes, event.includeInactive]),
            }),
          ),
          Effect.provideService(FileSystem.FileSystem, failedDerivedMarkerFileSystem),
        );
        yield* fallbackStore.write(location(home), uri, '# Other\n\nomega-99', {mode: 'replace'});
        yield* fs.utimes(resourcePath, initialModifiedAt, initialModifiedAt);

        expect((yield* Ref.get(failedScopes)).sort()).toEqual([false, true]);
        expect(yield* recallIndexStatus(config)).toMatchObject({
          ready: false,
          reason: 'canonical documents changed; run `threadnote repair`',
        });
        const refreshed = yield* loadRecallIndex(config, {includeInactive: false, query: 'omega-99'});
        expect(refreshed[0]?.text).toContain('omega-99');
        expect(refreshed[0]?.text).not.toContain('alpha-42');
        expect(yield* recallIndexStatus(config)).toMatchObject({documentCount: 1, ready: true});
      }),
    ).pipe(provideTestLayer(resourceStoreDependencies)),
  );

  it.effect('does not let a later successful marker hide an earlier failed invalidation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-resource-invalidation-continuity-'});
        const config = {account: 'local', agentContextHome: home, user: 'test-user'};
        const firstUri = 'threadnote://resources/repos/threadnote/first.md';
        const laterUri = 'threadnote://resources/repos/threadnote/later.md';
        const firstPath = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'first.md');
        const store = yield* ResourceStore.pipe(provideTestLayer(resourceStoreLayerWith()));
        yield* store.write(location(home), firstUri, '# First\n\nalpha-42', {mode: 'create'});
        expect((yield* loadRecallIndex(config, {includeInactive: false}))[0]?.text).toContain('alpha-42');
        const initialInfo = yield* fs.stat(firstPath);
        const initialModifiedAt = Option.getOrThrow(initialInfo.mtime);

        const failedDerivedMarkerFileSystem = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (target, content, options) =>
            Effect2.pipe(String(target), EffectString.includes('.sqlite.stale.'))
              ? Effect.die(new Error('injected first-mutation marker failure'))
              : fs.writeFileString(target, content, options),
        });
        const markerFailingStore = yield* ResourceStore.pipe(
          provideTestLayer(resourceStoreLayerWith()),
          Effect.provideService(FileSystem.FileSystem, failedDerivedMarkerFileSystem),
        );
        yield* markerFailingStore.write(location(home), firstUri, '# First\n\nomega-99', {mode: 'replace'});
        yield* fs.utimes(firstPath, initialModifiedAt, initialModifiedAt);

        yield* store.write(location(home), laterUri, '# Later\n\nlater-anchor', {mode: 'create'});
        const refreshed = yield* loadRecallIndex(config, {includeInactive: false, query: 'omega-99'});

        expect(refreshed[0]?.text).toContain('omega-99');
        expect(refreshed[0]?.text).not.toContain('alpha-42');
        expect((yield* loadRecallIndex(config, {includeInactive: false, query: 'later-anchor'}))[0]?.uri).toBe(
          laterUri,
        );
        expect(yield* recallIndexStatus(config)).toMatchObject({documentCount: 2, ready: true});
      }),
    ).pipe(provideTestLayer(resourceStoreDependencies)),
  );

  it('does not reuse a warm candidate after a same-size replacement with preserved timestamps', async () => {
    const home = await mkdtemp('threadnote-resource-index-replacement-');
    try {
      const config = {account: 'local', agentContextHome: home, user: 'test-user'};
      const uri = 'threadnote://resources/repos/threadnote/replaced-resource.md';
      const resourcePath = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'replaced-resource.md');
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          yield* store.write(location(home), uri, '# First\n\nalpha-42', {mode: 'create'});
          expect((yield* loadRecallIndex(config, {includeInactive: false}))[0]?.text).toContain('alpha-42');
        }),
      );
      const original = await stat(resourcePath);
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          yield* store.write(location(home), uri, '# Other\n\nomega-99', {mode: 'replace'});
        }),
      );
      await utimes(resourcePath, new Date(original.mtimeMs), new Date(original.mtimeMs));
      const refreshed = await runEffect(
        loadRecallIndex(config, {
          includeInactive: false,
          query: 'omega-99',
        }),
      );
      expect(refreshed[0]?.text).toContain('omega-99');
      expect(refreshed[0]?.text).not.toContain('alpha-42');
      const scope = 'threadnote://resources/repos/threadnote';
      await expect(
        runEffect(
          loadRecallExactMatches(config, {
            includeInactive: false,
            terms: ['alpha-42'],
            uriScopes: [scope],
          }),
        ),
      ).resolves.toEqual([]);
      await expect(
        runEffect(
          loadRecallExactMatches(config, {
            includeInactive: false,
            terms: ['omega-99'],
            uriScopes: [scope],
          }),
        ),
      ).resolves.toEqual([{terms: ['omega-99'], uri}]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('keeps committed mutations successful when derived-index invalidation fails', async () => {
    const home = await mkdtemp('threadnote-resource-index-failure-');
    const failedScopes: boolean[] = [];
    try {
      await writeFile(join(home, 'indexes'), 'blocks the derived index directory');
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          const uri = 'threadnote://resources/repos/threadnote/committed.md';
          yield* store.write(location(home), uri, 'committed despite cache failure', {mode: 'create'});
          expect(yield* store.read(location(home), uri)).toBe('committed despite cache failure');
          yield* store.remove(location(home), uri);
          expect(yield* Effect.exit(store.read(location(home), uri))).toMatchObject({_tag: 'Failure'});
        }).pipe(
          provideTestLayer(
            resourceStoreLayerWith({
              onRecallInvalidationFailed: event =>
                Effect.sync(() => {
                  failedScopes.push(event.includeInactive);
                }),
            }),
          ),
        ),
      );
      expect(failedScopes.sort()).toEqual([false, false, true, true]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('classifies a protected remove failure as a remove error instead of lock contention', async () => {
    const home = await mkdtemp('threadnote-resource-remove-error-');
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          const parentUri = 'threadnote://resources/repos/threadnote/non-empty';
          yield* store.write(location(home), `${parentUri}/child.md`, 'child', {mode: 'create'});

          const failure = yield* Effect.flip(store.remove(location(home), parentUri));

          expect(failure).toBeInstanceOf(ResourceIoFailed);
          expect(failure).toMatchObject({operation: 'remove', uri: parentUri});
          expect(failure.message).toBe(`Resource remove failed for ${parentUri}.`);
          expect(failure.message).not.toContain('lock');
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('applies a bulk mutation set behind one public invalidation boundary', async () => {
    const home = await mkdtemp('threadnote-resource-batch-');
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          yield* store.mutate(location(home), [
            {
              content: 'first batch resource',
              options: {mode: 'upsert'},
              type: 'write',
              uri: 'threadnote://resources/repos/threadnote/first.md',
            },
            {
              content: 'second batch resource',
              options: {mode: 'upsert'},
              type: 'write',
              uri: 'threadnote://resources/repos/threadnote/second.md',
            },
          ]);
          expect(yield* store.read(location(home), 'threadnote://resources/repos/threadnote/first.md')).toContain(
            'first',
          );
          expect(yield* store.read(location(home), 'threadnote://resources/repos/threadnote/second.md')).toContain(
            'second',
          );
        }),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('serializes recursive parent removal with descendant writes across store instances', async () => {
    const home = await mkdtemp('threadnote-resource-parent-lock-');
    const parentUri = 'threadnote://resources/repos/threadnote/locked-parent';
    const childUri = `${parentUri}/child.md`;
    const lockPath = join(home, 'locks', 'resources', 'local', 'mutations.lock');
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          yield* store.write(location(home), childUri, 'before', {mode: 'create'});
        }),
      );
      const completionOrder: string[] = [];
      let signalRemoveContention = () => {};
      let signalWriteContention = () => {};
      const removeContended = new Promise<void>(resolve => {
        signalRemoveContention = resolve;
      });
      const writeContended = new Promise<void>(resolve => {
        signalWriteContention = resolve;
      });
      const layer = resourceStoreLayerWith({
        onMutationLockCompleted: event =>
          Effect.sync(() => {
            if (event.uri === parentUri) completionOrder.push('remove');
            if (event.uri === childUri) completionOrder.push('write');
          }),
        onMutationLockContention: event =>
          Effect.sync(() => {
            if (event.uri === parentUri) signalRemoveContention();
            if (event.uri === childUri) signalWriteContention();
          }),
      });
      const [removeStore, writeStore] = await Promise.all([
        runEffect(ResourceStore.pipe(provideTestLayer(layer))),
        runEffect(ResourceStore.pipe(provideTestLayer(layer))),
      ]);

      await mkdir(join(home, 'locks', 'resources', 'local'), {recursive: true});
      await writeFile(lockPath, `${process.pid}:test-barrier\n`);
      const remove = runEffect(removeStore.remove(location(home), parentUri, {recursive: true}));
      const write = runEffect(writeStore.write(location(home), childUri, 'after', {mode: 'upsert'}));

      await Promise.all([removeContended, writeContended]);
      await runEffect(
        writeStore.write({account: 'other', home, user: 'test-user'}, 'threadnote://resources/independent.md', 'ok', {
          mode: 'create',
        }),
      );
      await rm(lockPath, {force: true});
      await Promise.all([remove, write]);

      const child = await runEffect(
        Effect.gen(function* () {
          const store = yield* ResourceStore;
          return yield* Effect.option(store.read(location(home), childUri));
        }),
      );
      expect(completionOrder).toHaveLength(2);
      if (completionOrder.at(-1) === 'write') {
        expect(child._tag).toBe('Some');
        if (child._tag === 'Some') expect(child.value).toBe('after');
      } else {
        expect(child._tag).toBe('None');
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  effectIt.effect('keeps a checked invariant and its write atomic against every account writer', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-resource-checked-write-'});
          const sourceUri = 'threadnote://resources/repos/threadnote/checked-source.md';
          const competingUri = 'threadnote://resources/repos/threadnote/competing-target.md';
          const checkStarted = yield* Deferred.make<void>();
          const releaseCheck = yield* Deferred.make<void>();
          const competingContended = yield* Deferred.make<void>();
          const completionOrder: string[] = [];
          const store = yield* ResourceStore.pipe(
            provideTestLayer(
              resourceStoreLayerWith({
                onMutationLockCompleted: event =>
                  Effect.sync(() => {
                    completionOrder.push(event.uri);
                  }),
                onMutationLockContention: event =>
                  event.uri === competingUri
                    ? Deferred.succeed(competingContended, undefined).pipe(Effect.asVoid)
                    : Effect.void,
              }),
            ),
          );

          const checked = yield* store
            .writeChecked(
              location(home),
              sourceUri,
              'checked source',
              {mode: 'create'},
              Deferred.succeed(checkStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseCheck))),
            )
            .pipe(Effect.forkChild({startImmediately: true}));
          yield* Deferred.await(checkStarted);
          const competing = yield* store
            .write(location(home), competingUri, 'competing target', {mode: 'create'})
            .pipe(Effect.forkChild({startImmediately: true}));
          yield* Deferred.await(competingContended);

          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checked);
          yield* Fiber.join(competing);

          expect(completionOrder).toEqual([sourceUri, competingUri]);
          expect(yield* store.read(location(home), sourceUri)).toBe('checked source');
          expect(yield* store.read(location(home), competingUri)).toBe('competing target');
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('preserves checked-write rejection identity and leaves the destination absent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-resource-checked-reject-'});
        const uri = 'threadnote://resources/repos/threadnote/rejected.md';
        const rejected = {reason: 'stale-invariant'} as const;
        const store = yield* ResourceStore;

        expect(
          yield* Effect.flip(
            store.writeChecked(location(home), uri, 'must not commit', {mode: 'create'}, Effect.fail(rejected)),
          ),
        ).toBe(rejected);
        expect(Option.isNone(yield* Effect.option(store.read(location(home), uri)))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.runIf(process.platform !== 'win32')('rejects a symlink escape inside the canonical tree', async () => {
    const home = await mkdtemp('threadnote-resource-symlink-');
    const outside = await mkdtemp('threadnote-resource-outside-');
    try {
      const resources = join(home, 'data', 'local', 'resources');
      await mkdir(resources, {recursive: true});
      await writeFile(join(outside, 'secret.md'), 'outside');
      await symlink(outside, join(resources, 'escape'));

      await expect(
        runEffect(
          Effect.gen(function* () {
            const store = yield* ResourceStore;
            return yield* store.read(location(home), 'threadnote://resources/escape/secret.md');
          }),
        ),
      ).rejects.toBeInstanceOf(ResourcePathUnsafe);
    } finally {
      await rm(home, {force: true, recursive: true});
      await rm(outside, {force: true, recursive: true});
    }
  });

  it.runIf(process.platform !== 'win32')(
    'recursively removes a subtree without following descendant symlinks',
    async () => {
      const home = await mkdtemp('threadnote-resource-recursive-symlink-');
      const outside = await mkdtemp('threadnote-resource-recursive-outside-');
      try {
        const subtree = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'retired');
        const outsideFile = join(outside, 'keep.md');
        await mkdir(subtree, {recursive: true});
        await writeFile(join(subtree, 'inside.md'), 'inside');
        await writeFile(outsideFile, 'outside');
        await symlink(outside, join(subtree, 'external'));

        await runEffect(
          Effect.gen(function* () {
            const store = yield* ResourceStore;
            yield* store.remove(location(home), 'threadnote://resources/repos/threadnote/retired', {recursive: true});
          }),
        );

        await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
        await expect(stat(subtree)).rejects.toThrow();
      } finally {
        await rm(home, {force: true, recursive: true});
        await rm(outside, {force: true, recursive: true});
      }
    },
  );

  it.runIf(process.platform !== 'win32')('rejects a symlinked account storage root', async () => {
    const home = await mkdtemp('threadnote-resource-account-symlink-');
    const outside = await mkdtemp('threadnote-resource-account-outside-');
    try {
      await mkdir(join(home, 'data'), {recursive: true});
      await symlink(outside, join(home, 'data', 'local'));
      const destination = join(outside, 'resources', 'repos', 'threadnote', 'redirected.md');

      await expect(
        runEffect(
          Effect.gen(function* () {
            const store = yield* ResourceStore;
            return yield* store.write(
              location(home),
              'threadnote://resources/repos/threadnote/redirected.md',
              'must not escape',
              {mode: 'create'},
            );
          }),
        ),
      ).rejects.toBeInstanceOf(ResourcePathUnsafe);
      await expect(readFile(destination, 'utf8')).rejects.toThrow();
    } finally {
      await rm(home, {force: true, recursive: true});
      await rm(outside, {force: true, recursive: true});
    }
  });
});
