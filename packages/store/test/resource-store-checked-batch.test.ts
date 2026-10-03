import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';

const systemLayer = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'resource-store-test.ts'}),
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
function provideLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}
const location = (home: string) => ({account: 'local', home, user: 'tester'});
const sourceUri = 'threadnote://resources/source.md';
const archiveUri = 'threadnote://resources/archive.md';
const incomingUri = 'threadnote://resources/incoming.md';

describe('checked ResourceStore batches', () => {
  effectIt.effect('holds the final proof through archive and remove against an account mutation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'store-checked-batch-'});
      const proofFinished = yield* Deferred.make<void>();
      const releaseProof = yield* Deferred.make<void>();
      const writerContended = yield* Deferred.make<void>();
      const completed: string[] = [];
      const store = yield* ResourceStore.pipe(
        provideLayer(
          ResourceStore.layerWith({
            onMutationLockContention: event =>
              event.uri === incomingUri
                ? Deferred.succeed(writerContended, undefined).pipe(Effect.asVoid)
                : Effect.void,
            onMutationLockCompleted: event =>
              Effect.sync(() => {
                completed.push(event.uri);
              }),
          }),
        ),
      );
      const source = yield* store.write(location(home), sourceUri, 'active', {mode: 'create'});
      completed.length = 0;
      const retirement = yield* store
        .mutateChecked(
          location(home),
          [
            {type: 'write', uri: archiveUri, content: 'archived', options: {mode: 'create'}},
            {type: 'remove', uri: sourceUri, options: {expectedFingerprint: source.fingerprint}},
          ],
          Deferred.succeed(proofFinished, undefined).pipe(Effect.andThen(Deferred.await(releaseProof))),
        )
        .pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(proofFinished);
      const competing = yield* store
        .mutate(location(home), [{type: 'write', uri: incomingUri, content: 'incoming', options: {mode: 'create'}}])
        .pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(writerContended);
      expect(yield* store.read(location(home), sourceUri)).toBe('active');
      expect(Option.isNone(yield* Effect.option(store.read(location(home), incomingUri)))).toBe(true);
      yield* Deferred.succeed(releaseProof, undefined);
      yield* Fiber.join(retirement);
      yield* Fiber.join(competing);
      expect(completed).toEqual([archiveUri, incomingUri]);
      expect(yield* store.read(location(home), archiveUri)).toBe('archived');
      expect(Option.isNone(yield* Effect.option(store.read(location(home), sourceUri)))).toBe(true);
    }).pipe(TestClock.withLive, provideLayer(testLayer)),
  );

  effectIt.effect('preflights the subject fingerprint before creating an archive', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'store-checked-fingerprint-'});
      const store = yield* ResourceStore;
      const source = yield* store.write(location(home), sourceUri, 'original', {mode: 'create'});
      yield* store.write(location(home), sourceUri, 'changed', {mode: 'replace'});
      let checked = false;
      const result = yield* store
        .mutateChecked(
          location(home),
          [
            {type: 'write', uri: archiveUri, content: 'archive', options: {mode: 'create'}},
            {type: 'remove', uri: sourceUri, options: {expectedFingerprint: source.fingerprint}},
          ],
          Effect.sync(() => {
            checked = true;
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure._tag).toBe('ResourceConflict');
      expect(checked).toBe(false);
      expect(yield* store.read(location(home), sourceUri)).toBe('changed');
      expect(Option.isNone(yield* Effect.option(store.read(location(home), archiveUri)))).toBe(true);
    }).pipe(TestClock.withLive, provideLayer(testLayer)),
  );

  fcEffectProp(
    effectIt,
    'rejected checks leave every batch resource unchanged',
    {
      source: fc.string({maxLength: 64}),
      archive: fc.string({maxLength: 64}),
    },
    ({source, archive}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'store-checked-rejection-'});
        const store = yield* ResourceStore;
        const original = yield* store.write(location(home), sourceUri, source, {mode: 'create'});
        const path = yield* Path.Path;
        const generation = yield* readCanonicalMutationGeneration(fs, path, home, 'local');
        const rejected = {reason: 'incoming-dependency'} as const;
        const result = yield* Effect.flip(
          store.mutateChecked(
            location(home),
            [
              {type: 'write', uri: archiveUri, content: archive, options: {mode: 'create'}},
              {type: 'remove', uri: sourceUri, options: {expectedFingerprint: original.fingerprint}},
            ],
            Effect.fail(rejected),
          ),
        );
        expect(result).toBe(rejected);
        expect(yield* store.read(location(home), sourceUri)).toBe(source);
        expect(Option.isNone(yield* Effect.option(store.read(location(home), archiveUri)))).toBe(true);
        expect(yield* readCanonicalMutationGeneration(fs, path, home, 'local')).toBe(generation);
      }).pipe(TestClock.withLive, provideLayer(testLayer)),
    {fastCheck: {numRuns: 20}},
  );
});
