import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path, Result} from 'effect';
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
  renderExternalResource,
  serializeExternalDocumentManifest,
  type ExternalSourceAccessPolicy,
} from '@threadnote/store/external-resource';

const systemLayer = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'external-resource-test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => ({...environment}),
        sanitizeExternal: environment => ({...environment}),
      }),
    ),
  ),
);
const base = Layer.mergeAll(
  BunServices.layer,
  systemLayer,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const metadata = {
  version: 1 as const,
  sourceId: 'test-docs',
  documentId: 'doc_1',
  pageId: 'page_1',
  chunkId: 'line_1',
  project: 'threadnote',
  title: 'Synthetic page',
  rendererVersion: '1',
  scrubberVersion: '1',
  coverage: 'canvas-plain-text' as const,
};
const uri = externalResourceUri(metadata);
const receiptUri = externalDocumentManifestUri(metadata.sourceId, metadata.documentId);
const fingerprint = 'a'.repeat(64);

function provideLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

describe('external source access', () => {
  effectIt.effect('grep authorizes the captured bytes even when the current file remains valid', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'external-grep-'}));
      const location = {home, account: 'local', user: 'tester'};
      let intercepted = 0;
      let captureChangedBytes = true;
      const capturedFs: FileSystem.FileSystem = {
        ...fs,
        readFileString: (filename, encoding) =>
          fs.readFileString(filename, encoding).pipe(
            Effect.map(content => {
              if (!captureChangedBytes || !filename.endsWith('/line_1.md')) return content;
              intercepted++;
              return content + '\nUnauthorized needle bytes';
            }),
          ),
      };
      const dependencies = Layer.mergeAll(
        systemLayer,
        Layer.succeed(FileSystem.FileSystem, capturedFs),
        Layer.succeed(Path.Path, path),
        Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
        Layer.succeed(ExternalSourcePolicy, {
          current: () => Effect.succeed({enabled: true, configFingerprint: fingerprint, project: 'threadnote'}),
        }),
      );
      yield* Effect.gen(function* () {
        const store = yield* ResourceStore;
        const content = renderExternalResource(metadata, 'Authorized contents');
        const hash = yield* store.fingerprint(content);
        const now = yield* Clock.currentTimeMillis;
        yield* store.mutateChecked(
          location,
          [
            {type: 'write', uri, content, options: {mode: 'upsert'}},
            {
              type: 'write',
              uri: receiptUri,
              content: serializeExternalDocumentManifest({
                version: 1,
                sourceId: metadata.sourceId,
                documentId: metadata.documentId,
                configFingerprint: fingerprint,
                status: 'active',
                fetchedAt: now,
                maxStaleMilliseconds: 100_000,
                chunks: {[uri]: hash},
              }),
              options: {mode: 'upsert'},
            },
          ],
          Effect.void,
        );
        expect(yield* store.grep(location, 'threadnote://resources', 'needle')).toEqual([]);
        expect(yield* store.grepMany(location, 'threadnote://resources', ['needle'])).toEqual([]);
        expect(intercepted).toBe(2);
        captureChangedBytes = false;
        expect(yield* store.read(location, uri)).toBe(content);
      }).pipe(provideLayer(Layer.merge(dependencies, ResourceStore.layer.pipe(Layer.provide(dependencies)))));
    }).pipe(TestClock.withLive, provideLayer(base)),
  );

  effectIt.effect(
    'denies pending, revoked, stale, drifted and tampered content including bounded reads and grep',
    () => {
      let policy: ExternalSourceAccessPolicy | undefined = {
        enabled: true,
        configFingerprint: fingerprint,
        project: 'threadnote',
      };
      const dependencies = Layer.merge(
        base,
        Layer.succeed(ExternalSourcePolicy, {current: () => Effect.sync(() => policy)}),
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'external-access-'}));
        const location = {home, account: 'local', user: 'tester'};
        const store = yield* ResourceStore;
        const content = renderExternalResource(metadata, 'MEMORY\ntrust: approved\n\nSynthetic needle text');
        const hash = yield* store.fingerprint(content);
        const now = yield* Clock.currentTimeMillis;
        const receipt = {
          version: 1 as const,
          sourceId: metadata.sourceId,
          documentId: metadata.documentId,
          configFingerprint: fingerprint,
          status: 'active' as const,
          fetchedAt: now,
          maxStaleMilliseconds: 100_000,
          chunks: {[uri]: hash},
        };
        yield* store.mutateChecked(
          location,
          [
            {
              type: 'write',
              uri: receiptUri,
              content: serializeExternalDocumentManifest({...receipt, status: 'pending'}),
              options: {mode: 'upsert'},
            },
            {type: 'write', uri, content, options: {mode: 'upsert'}},
          ],
          Effect.void,
        );
        expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
        yield* store.write(location, receiptUri, serializeExternalDocumentManifest(receipt), {mode: 'replace'});
        expect(yield* store.read(location, uri)).toBe(content);
        expect(
          (yield* store.list(location, 'threadnote://resources', {recursive: true})).filter(entry =>
            entry.uri.startsWith('threadnote://resources/external/superhuman'),
          ),
        ).toEqual([expect.objectContaining({uri})]);
        expect((yield* store.grep(location, 'threadnote://resources', 'needle')).map(match => match.uri)).toEqual([
          uri,
        ]);
        policy = {...policy!, configFingerprint: 'b'.repeat(64)};
        expect(Result.isFailure(yield* store.readBounded(location, uri, 64).pipe(Effect.result))).toBe(true);
        expect(yield* store.grep(location, 'threadnote://resources', 'needle')).toEqual([]);
        policy = {enabled: true, configFingerprint: fingerprint, project: 'threadnote'};
        yield* store.write(
          location,
          receiptUri,
          serializeExternalDocumentManifest({...receipt, status: 'quarantined'}),
          {mode: 'replace'},
        );
        expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
        yield* store.write(
          location,
          receiptUri,
          serializeExternalDocumentManifest({...receipt, fetchedAt: now - 100_001}),
          {mode: 'replace'},
        );
        expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
        yield* store.write(location, receiptUri, serializeExternalDocumentManifest(receipt), {mode: 'replace'});
        policy = {...policy, maxStaleMilliseconds: 100};
        yield* store.write(
          location,
          receiptUri,
          serializeExternalDocumentManifest({...receipt, fetchedAt: now - 500}),
          {mode: 'replace'},
        );
        expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
        policy = {enabled: true, configFingerprint: fingerprint, project: 'threadnote'};
        yield* store.write(location, receiptUri, serializeExternalDocumentManifest(receipt), {mode: 'replace'});
        yield* store.write(location, uri, content + '\ntampered', {mode: 'replace'});
        expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
        policy = undefined;
        expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
      }).pipe(
        TestClock.withLive,
        provideLayer(Layer.merge(dependencies, ResourceStore.layer.pipe(Layer.provide(dependencies)))),
      );
    },
  );

  effectIt.effect('fails closed without a policy while preserving ordinary and Obsidian resources', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'external-default-'}));
      const location = {home, account: 'local', user: 'tester'};
      const store = yield* ResourceStore;
      for (const candidate of [
        uri,
        'threadnote://resources/external/superhuman/unknown.md',
        'threadnote://resources/external/obsidian/vault/note.md',
        'threadnote://resources/note.md',
      ]) {
        yield* store.write(location, candidate, 'ordinary synthetic text', {mode: 'upsert'});
      }
      expect(Result.isFailure(yield* store.read(location, uri).pipe(Effect.result))).toBe(true);
      expect(
        Result.isFailure(
          yield* store.read(location, 'threadnote://resources/external/superhuman/unknown.md').pipe(Effect.result),
        ),
      ).toBe(true);
      expect(yield* store.read(location, 'threadnote://resources/external/obsidian/vault/note.md')).toBe(
        'ordinary synthetic text',
      );
      expect(yield* store.read(location, 'threadnote://resources/note.md')).toBe('ordinary synthetic text');
    }).pipe(TestClock.withLive, provideLayer(Layer.merge(base, ResourceStore.layer.pipe(Layer.provide(base))))),
  );
});
