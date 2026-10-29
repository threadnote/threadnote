import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {HttpService} from '@threadnote/platform/http';

import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {
  BUNDLED_CORE_EMBEDDING_MANIFEST,
  bundledCoreEmbeddingSource,
} from '@threadnote/threadnote/models/core-embedding-asset';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelStore, type LocalModelStoreLayerOptions} from '@threadnote/inference/models/store';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const modelStoreTestLayer = (options: LocalModelStoreLayerOptions = {}) =>
  LocalModelStore.layerWith(options).pipe(
    Layer.provideMerge(HttpService.layer),
    Layer.provideMerge(TestSystemInfoLayer),
    Layer.provideMerge(BunServices.layer),
  );

describe('bundled model installation', () => {
  it('routes only the exact pinned core embedding manifest to the executable asset', () => {
    expect(bundledCoreEmbeddingSource(BUNDLED_CORE_EMBEDDING_MANIFEST)).toMatchObject({
      sourceUrl: `embedded://threadnote/${BUNDLED_CORE_EMBEDDING_MANIFEST.id}/${BUNDLED_CORE_EMBEDDING_MANIFEST.sha256}.gguf`,
    });
    for (const manifest of EffectArray.filter(
      BUILTIN_MODEL_MANIFESTS,
      candidate => candidate.id !== BUNDLED_CORE_EMBEDDING_MANIFEST.id,
    )) {
      expect(bundledCoreEmbeddingSource(manifest)).toBeUndefined();
    }
    expect(
      bundledCoreEmbeddingSource({
        ...BUNDLED_CORE_EMBEDDING_MANIFEST,
        sha256: Effect2.pipe('0', EffectString.repeat(64)),
      }),
    ).toBeUndefined();
  });

  effectIt.layer(modelStoreTestLayer())(layerIt => {
    fcEffectProp(
      layerIt,
      'atomically promotes exactly the verified bundled bytes and rejects same-size mutations',
      {bytes: fc.uint8Array({maxLength: 128, minLength: 1})},
      ({bytes}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const store = yield* LocalModelStore;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-bundled-model-property-'});
            const source = path.join(root, 'source.gguf');
            const validHome = path.join(root, 'valid-home');
            const invalidHome = path.join(root, 'invalid-home');
            const truncatedHome = path.join(root, 'truncated-home');
            const manifest = fixtureManifest(bytes);

            yield* fs.writeFile(source, bytes);
            const installed = yield* store.install(validHome, manifest, {
              sourcePath: source,
              sourceUrl: 'embedded://threadnote/fixture.gguf',
            });
            expect(installed).toMatchObject({
              bytes: bytes.length,
              installed: true,
              resumed: false,
              sourceUrl: 'embedded://threadnote/fixture.gguf',
              verified: true,
            });
            expect(Uint8Array.from(yield* fs.readFile(installed.path))).toEqual(bytes);
            expect(yield* fs.exists(`${installed.path}.partial`)).toBe(false);

            const mutated = Uint8Array.from(bytes);
            mutated[0] = mutated[0] ^ 0xff;
            yield* fs.writeFile(source, mutated);
            const rejected = yield* store
              .install(invalidHome, manifest, {sourcePath: source, sourceUrl: 'embedded://threadnote/fixture.gguf'})
              .pipe(Effect.result);
            expect(Result.isFailure(rejected)).toBe(true);
            if (Result.isFailure(rejected)) expect(rejected.failure._tag).toBe('ModelChecksumMismatch');
            const invalidPath = store.path(invalidHome, manifest);
            expect(yield* fs.exists(invalidPath)).toBe(false);
            expect(yield* fs.exists(`${invalidPath}.partial`)).toBe(false);

            yield* fs.writeFile(source, bytes.subarray(1));
            const truncated = yield* store
              .install(truncatedHome, manifest, {sourcePath: source, sourceUrl: 'embedded://threadnote/fixture.gguf'})
              .pipe(Effect.result);
            expect(Result.isFailure(truncated)).toBe(true);
            if (Result.isFailure(truncated)) expect(truncated.failure._tag).toBe('ModelDownloadFailed');
            const truncatedPath = store.path(truncatedHome, manifest);
            expect(yield* fs.exists(truncatedPath)).toBe(false);
            expect(yield* fs.exists(`${truncatedPath}.partial`)).toBe(false);
          }),
        ),
      {fastCheck: {numRuns: 50}},
    );
  });

  effectIt.effect('holds the model lock until interrupted bundled extraction settles', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-bundled-model-interruption-'});
        const home = path.join(root, 'home');
        const bytes = Uint8Array.from([1, 2, 3, 4]);
        const manifest = fixtureManifest(bytes);
        const extractionStarted = yield* Deferred.make<void>();
        const releaseExtraction = yield* Deferred.make<void>();
        const removeContended = yield* Deferred.make<void>();
        const completionOrder: string[] = [];
        const layer = modelStoreTestLayer({
          extractBundledSource: (_sourcePath, destinationPath) =>
            Deferred.succeed(extractionStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseExtraction)),
              Effect.andThen(fs.writeFile(destinationPath, bytes)),
              Effect.as(bytes.length),
            ),
          onModelLockCompleted: event => Effect.sync(() => completionOrder.push(event.operation)).pipe(Effect.asVoid),
          onModelLockContention: event =>
            event.operation === 'remove'
              ? Deferred.succeed(removeContended, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });

        yield* Effect.gen(function* () {
          const store = yield* LocalModelStore;
          const install = yield* store
            .install(home, manifest, {sourcePath: 'embedded://fixture', sourceUrl: 'embedded://fixture'})
            .pipe(Effect.forkChild({startImmediately: true}));
          yield* Deferred.await(extractionStarted);
          const interruption = yield* Fiber.interrupt(install).pipe(Effect.forkChild({startImmediately: true}));
          const remove = yield* store.remove(home, manifest).pipe(Effect.forkChild({startImmediately: true}));

          yield* Deferred.await(removeContended);
          expect(completionOrder).toEqual([]);
          yield* Deferred.succeed(releaseExtraction, undefined);
          yield* Fiber.join(interruption);
          expect(yield* Fiber.join(remove)).toBe(true);
          expect(completionOrder).toEqual(['install', 'remove']);
          expect(yield* fs.exists(store.path(home, manifest))).toBe(false);
          expect(yield* fs.exists(`${store.path(home, manifest)}.partial`)).toBe(false);
        }).pipe(provideTestLayer(layer));
      }).pipe(provideTestLayer(BunServices.layer), Effect.scoped),
    ),
  );

  effectIt.effect('cleans a bundled partial when extraction fails', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-bundled-model-failure-'});
      const home = path.join(root, 'home');
      const bytes = Uint8Array.from([1, 2, 3, 4]);
      const manifest = fixtureManifest(bytes);
      const layer = modelStoreTestLayer({
        extractBundledSource: (_sourcePath, destinationPath) =>
          fs
            .writeFile(destinationPath, bytes)
            .pipe(Effect.andThen(Effect.fail(TestError.make({message: 'fixture extraction failed'})))),
      });

      yield* Effect.gen(function* () {
        const store = yield* LocalModelStore;
        const result = yield* store
          .install(home, manifest, {sourcePath: 'embedded://fixture', sourceUrl: 'embedded://fixture'})
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe('ModelStoreIoFailed');
        expect(yield* fs.exists(`${store.path(home, manifest)}.partial`)).toBe(false);
      }).pipe(provideTestLayer(layer));
    }).pipe(provideTestLayer(BunServices.layer), Effect.scoped),
  );
});

function fixtureManifest(bytes: Uint8Array): LocalModelManifest {
  return {
    architecture: 'bert',
    contextLimit: 512,
    dimensions: 384,
    file: 'fixture.gguf',
    id: 'fixture-embedding',
    license: 'test-only',
    minimumRamBytes: 1,
    normalization: 'l2',
    promptPrefixes: {document: '', query: ''},
    quantization: 'F32',
    repository: 'threadnote/fixtures',
    revision: Effect2.pipe('a', EffectString.repeat(40)),
    role: 'embedding',
    runtime: {nodeLlamaCpp: '3.19.1'},
    sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    task: 'retrieval',
    version: 1,
  };
}
