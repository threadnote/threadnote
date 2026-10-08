import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  ExternalSourcePolicy,
  externalDocumentManifestUri,
  externalResourceUri,
  externalSourceReceiptUri,
  loadExternalResourceAccess,
  renderExternalResource,
  serializeExternalDocumentManifest,
  serializeExternalSourceReceipt,
  type ExternalDocumentManifest,
} from '@threadnote/store/external-resource';

const fingerprint = 'a'.repeat(64);
const epoch = 'b'.repeat(64);
const base = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'external-source-epoch.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: environment => ({...environment}),
          sanitizeExternal: environment => ({...environment}),
        }),
      ),
    ),
  ),
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
  Layer.succeed(ExternalSourcePolicy, {
    current: () => Effect.succeed({enabled: true, configFingerprint: fingerprint, project: 'test'}),
  }),
);
const layer = Layer.merge(base, ResourceStore.layer.pipe(Layer.provide(base)));
const provideLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));

describe('external source epoch', () => {
  effectIt.effect.prop(
    'permits only revalidated documents after source-wide denial',
    [
      Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 4})),
      Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 15})),
    ],
    ([count, validatedMask]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'source-epoch-'});
        const location = {home, account: 'local', user: 'tester'};
        const store = yield* ResourceStore;
        const now = yield* Clock.currentTimeMillis;
        const documents: Array<{uri: string; manifest: ExternalDocumentManifest}> = [];
        for (let index = 0; index < count; index++) {
          const metadata = {
            version: 1 as const,
            sourceId: 'test',
            documentId: `doc_${index}`,
            pageId: 'page_one',
            chunkId: 'line_one',
            project: 'test',
            title: 'Synthetic',
            rendererVersion: '1',
            scrubberVersion: '1',
            coverage: 'canvas-plain-text' as const,
          };
          const uri = externalResourceUri(metadata);
          const content = renderExternalResource(metadata, 'synthetic evidence');
          const manifest: ExternalDocumentManifest = {
            version: 1,
            sourceId: 'test',
            documentId: metadata.documentId,
            configFingerprint: fingerprint,
            status: 'active',
            fetchedAt: now,
            maxStaleMilliseconds: 100_000,
            chunks: {[uri]: yield* store.fingerprint(content)},
          };
          documents.push({uri, manifest});
          yield* store.mutateChecked(
            location,
            [
              {type: 'write', uri, content, options: {mode: 'upsert'}},
              {
                type: 'write',
                uri: externalDocumentManifestUri('test', manifest.documentId),
                content: serializeExternalDocumentManifest(manifest),
                options: {mode: 'upsert'},
              },
            ],
            Effect.void,
          );
          expect(Result.isSuccess(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
        }
        const receiptUri = externalSourceReceiptUri('test');
        yield* store.write(
          location,
          receiptUri,
          serializeExternalSourceReceipt({
            version: 1,
            sourceId: 'test',
            accessEpoch: epoch,
            status: 'authentication-rejected',
          }),
          {mode: 'upsert'},
        );
        expect(yield* loadExternalResourceAccess(location)).toEqual({});
        const expected: string[] = [];
        for (let index = 0; index < count; index++) {
          const {uri, manifest} = documents[index];
          expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
          if ((validatedMask & (1 << index)) !== 0) {
            yield* store.write(
              location,
              externalDocumentManifestUri('test', manifest.documentId),
              serializeExternalDocumentManifest({
                ...manifest,
                accessEpoch: epoch,
              }),
              {mode: 'upsert'},
            );
            expected.push(uri);
          }
        }
        expect(Object.keys(yield* loadExternalResourceAccess(location)).sort()).toEqual(expected.sort());
        for (const {uri} of documents)
          expect(Result.isSuccess(yield* store.read(location, uri).pipe(Effect.result))).toBe(expected.includes(uri));
        yield* store.write(
          location,
          receiptUri,
          serializeExternalSourceReceipt({
            version: 1,
            sourceId: 'test',
            accessEpoch: epoch,
            status: 'cleanup',
          }),
          {mode: 'upsert'},
        );
        expect(yield* loadExternalResourceAccess(location)).toEqual({});
        for (const {uri} of documents)
          expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
        yield* store.write(location, receiptUri, '{}', {mode: 'upsert'});
        expect(yield* loadExternalResourceAccess(location)).toEqual({});
      }).pipe(TestClock.withLive, provideLayer),
    {arbitrary: {runs: 12}},
  );
});
