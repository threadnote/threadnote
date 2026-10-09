import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo, runtimePlatform} from '@threadnote/platform/system';
import {
  ExternalSourcePolicy,
  externalDocumentManifestUri,
  externalResourceUri,
  externalSourceReceiptUri,
  renderExternalResource,
  serializeExternalDocumentManifest,
  serializeExternalSourceReceipt,
} from '@threadnote/store/external-resource';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {parseResourceId} from '@threadnote/store/resource-id';
import {
  captureSourceEvidence,
  inspectSourceEvidence,
  readSourceEvidence,
  serializeSourceEvidenceCitation,
  validSourceEvidenceCitation,
  type SourceEvidenceInspection,
} from '@threadnote/store/source-evidence';

const config = 'a'.repeat(64);
const credential = 'b'.repeat(64);
const epoch = 'c'.repeat(64);
const credentialState = {value: credential};
const policyState: {
  enabled: boolean;
  maxStaleMilliseconds?: number;
  currentCalls: number;
  onCurrent?: (call: number) => Effect.Effect<void>;
} = {enabled: true, currentCalls: 0};
const services = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'source-evidence.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: environment => ({...environment}),
          sanitizeExternal: environment => ({...environment}),
        }),
      ),
    ),
  ),
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
  Layer.succeed(ExternalSourcePolicy, {
    current: () =>
      Effect.gen(function* () {
        const call = ++policyState.currentCalls;
        if (policyState.onCurrent) yield* policyState.onCurrent(call);
        return {
          enabled: policyState.enabled,
          configFingerprint: config,
          project: 'test',
          ...(policyState.maxStaleMilliseconds === undefined
            ? {}
            : {maxStaleMilliseconds: policyState.maxStaleMilliseconds}),
        };
      }),
    evidenceFingerprint: () => Effect.succeed(credentialState.value),
  }),
);
const layer = Layer.merge(services, ResourceStore.layer.pipe(Layer.provide(services)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));

const setup = Effect.fn('test.sourceEvidenceSetup')(function* (provider: 'pocket' | 'github', body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  policyState.maxStaleMilliseconds = undefined;
  policyState.onCurrent = undefined;
  policyState.currentCalls = 0;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'source-evidence-'});
  const location = {home, account: 'local', user: 'tester'};
  const store = yield* ResourceStore;
  const now = yield* Clock.currentTimeMillis;
  const documentId = provider === 'github' ? 'r-123-issue-1' : 'item1';
  const metadata = {
    version: 1 as const,
    provider,
    sourceId: 'fixture',
    documentId,
    pageId: 'page1',
    chunkId: 'chunk1',
    project: 'test',
    title: 'Synthetic',
    rendererVersion: 'renderer-v1',
    scrubberVersion: 'scrubber-v1',
    coverage: provider === 'github' ? ('github-conversation' as const) : ('pocket-api-text' as const),
    ...(provider === 'github' ? {browserLink: 'https://github.com/acme/repo/issues/1'} : {}),
  };
  const uri = externalResourceUri(metadata);
  const envelope = renderExternalResource(metadata, body);
  const receiptUri = externalSourceReceiptUri('fixture', provider);
  const manifestUri = externalDocumentManifestUri('fixture', documentId, provider);
  yield* store.write(
    location,
    receiptUri,
    serializeExternalSourceReceipt({
      version: 1,
      provider,
      sourceId: 'fixture',
      accessEpoch: epoch,
      status: 'active',
      ...(provider === 'github' ? {repositoryDenialGenerations: {'123': '1'.repeat(64)}} : {}),
    }),
    {mode: 'upsert'},
  );
  const manifest = {
    version: 1 as const,
    provider,
    sourceId: 'fixture',
    documentId,
    configFingerprint: config,
    status: 'active' as const,
    fetchedAt: now,
    maxStaleMilliseconds: 1_000_000,
    accessEpoch: epoch,
    chunks: {[uri]: yield* store.fingerprint(envelope)},
  };
  yield* store.mutateChecked(
    location,
    [
      {type: 'write', uri, content: envelope, options: {mode: 'upsert'}},
      {
        type: 'write',
        uri: manifestUri,
        content: serializeExternalDocumentManifest(manifest),
        options: {mode: 'upsert'},
      },
    ],
    Effect.void,
  );
  const inspected = yield* inspectSourceEvidence(location, uri);
  const pinDirectory = path.join(
    yield* fs.realPath(home),
    'threadnote',
    'source-evidence',
    'local',
    provider,
    'fixture',
  );
  return {fs, path, location, store, now, uri, receiptUri, manifestUri, manifest, inspected, pinDirectory};
});

function captureInput(inspected: SourceEvidenceInspection, fragment: string, retentionDays?: number) {
  return {
    resourceUri: inspected.resourceUri,
    fragment,
    expectedSourceInstanceId: inspected.sourceInstanceId,
    expectedAccessHash: inspected.accessHash,
    expectedRevisionHash: inspected.revisionHash,
    expectedContentHash: inspected.contentHash,
    expectedRendererVersion: inspected.rendererVersion,
    expectedSanitizerVersion: inspected.sanitizerVersion,
    ...(retentionDays === undefined ? {} : {retentionDays}),
  };
}

describe('source evidence', () => {
  effectIt.effect('revokes retained text when access changes during current-revision inspection', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          for (const change of ['disabled', 'credential', 'epoch', 'quarantine'] as const) {
            policyState.enabled = true;
            credentialState.value = credential;
            const {fs, path, location, inspected, receiptUri, manifestUri, manifest} = yield* setup(
              'pocket',
              'retained body',
            );
            const citation = yield* captureSourceEvidence(location, captureInput(inspected, 'retained'));
            const realHome = yield* fs.realPath(location.home);
            const resourceFile = (uri: string) =>
              path.join(realHome, 'data', 'local', 'resources', ...parseResourceId(uri).segments);
            policyState.currentCalls = 0;
            let triggered = false;
            policyState.onCurrent = call =>
              call === 3
                ? Effect.gen(function* () {
                    triggered = true;
                    if (change === 'disabled') policyState.enabled = false;
                    else if (change === 'credential') credentialState.value = 'd'.repeat(64);
                    else if (change === 'epoch')
                      yield* fs.writeFileString(
                        resourceFile(receiptUri),
                        serializeExternalSourceReceipt({
                          version: 1,
                          provider: 'pocket',
                          sourceId: 'fixture',
                          accessEpoch: 'd'.repeat(64),
                          status: 'active',
                        }),
                        {mode: 0o600},
                      );
                    else
                      yield* fs.writeFileString(
                        resourceFile(manifestUri),
                        serializeExternalDocumentManifest({...manifest, status: 'quarantined'}),
                        {mode: 0o600},
                      );
                  }).pipe(Effect.orDie)
                : Effect.void;
            expect(yield* readSourceEvidence(location, citation)).toMatchObject({
              historical: 'revoked',
              currentRevision: 'unknown',
            });
            expect(triggered).toBe(true);
            policyState.onCurrent = undefined;
          }
        }),
      ),
    ),
  );

  effectIt.effect('withholds freshness when final manifest hash differs from the inspected envelope', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          policyState.enabled = true;
          credentialState.value = credential;
          const {fs, path, location, uri, manifestUri, manifest, inspected} = yield* setup('pocket', 'retained body');
          const citation = yield* captureSourceEvidence(location, captureInput(inspected, 'retained'));
          const manifestPath = path.join(
            yield* fs.realPath(location.home),
            'data',
            'local',
            'resources',
            ...parseResourceId(manifestUri).segments,
          );
          policyState.currentCalls = 0;
          let changed = false;
          policyState.onCurrent = call =>
            call === 7
              ? fs
                  .writeFileString(
                    manifestPath,
                    serializeExternalDocumentManifest({...manifest, chunks: {[uri]: 'd'.repeat(64)}}),
                    {mode: 0o600},
                  )
                  .pipe(
                    Effect.orDie,
                    Effect.tap(() =>
                      Effect.sync(() => {
                        changed = true;
                      }),
                    ),
                  )
              : Effect.void;
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'unknown',
            fragment: 'retained',
          });
          expect(changed).toBe(true);
          policyState.onCurrent = undefined;
        }),
      ),
    ),
  );

  effectIt.effect('treats dangling manifest and redirected ancestor entries as revoked', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          credentialState.value = credential;
          policyState.enabled = true;
          const {fs, path, location, inspected, manifestUri} = yield* setup('pocket', 'retained body');
          const citation = yield* captureSourceEvidence(location, captureInput(inspected, 'retained'));
          const manifestPath = path.join(
            yield* fs.realPath(location.home),
            'data',
            'local',
            'resources',
            ...parseResourceId(manifestUri).segments,
          );
          yield* fs.remove(manifestPath);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'unknown',
            fragment: 'retained',
          });
          if (runtimePlatform === 'win32') return;
          yield* fs.symlink(path.join(yield* fs.realPath(location.home), 'absent-target'), manifestPath);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'revoked'});
          yield* fs.remove(manifestPath);
          const documentDirectory = path.dirname(manifestPath);
          const relocatedDirectory = `${documentDirectory}-relocated`;
          yield* fs.rename(documentDirectory, relocatedDirectory);
          yield* fs.symlink(relocatedDirectory, documentDirectory);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'revoked'});
        }),
      ),
    ),
  );

  effectIt.effect('reports removal only from a fresh eligible empty manifest', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          credentialState.value = credential;
          policyState.enabled = true;
          const {location, store, manifestUri, manifest, inspected, now} = yield* setup('pocket', 'retained body');
          const citation = yield* captureSourceEvidence(location, captureInput(inspected, 'retained'));
          const empty = (fetchedAt: number) =>
            store.write(
              location,
              manifestUri,
              serializeExternalDocumentManifest({...manifest, chunks: {}, fetchedAt}),
              {mode: 'upsert'},
            );
          yield* empty(now);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'removed',
            fragment: 'retained',
          });
          yield* empty(now - manifest.maxStaleMilliseconds - 1);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'unknown',
            fragment: 'retained',
          });
          yield* empty(now + 60_000);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'unknown',
            fragment: 'retained',
          });
          policyState.maxStaleMilliseconds = 500;
          yield* empty(now - 1000);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'unknown',
            fragment: 'retained',
          });
          policyState.maxStaleMilliseconds = undefined;
        }),
      ),
    ),
  );

  effectIt.effect('stores heavily escaped sanitized content within the bounded pin format and private modes', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          credentialState.value = credential;
          policyState.enabled = true;
          const body = '"\n'.repeat(190_000);
          const fixture = yield* setup('pocket', body);
          const {fs, path, location, inspected, pinDirectory} = fixture;
          const parent = path.join(yield* fs.realPath(location.home), 'threadnote');
          yield* fs.makeDirectory(parent, {mode: 0o755});
          yield* fs.chmod(parent, 0o755);
          const citation = yield* captureSourceEvidence(location, captureInput(inspected, '"\n"'));
          const pinPath = path.join(pinDirectory, `${citation.pinId}.json`);
          if (runtimePlatform !== 'win32') {
            expect((yield* fs.stat(parent)).mode & 0o777).toBe(0o755);
            for (const directory of [
              path.join(parent, 'source-evidence'),
              path.join(parent, 'source-evidence', 'local'),
              path.join(parent, 'source-evidence', 'local', 'pocket'),
              pinDirectory,
            ])
              expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700);
            expect((yield* fs.stat(pinPath)).mode & 0o777).toBe(0o600);
          }
          expect(Number((yield* fs.stat(pinPath)).size)).toBeLessThan(512 * 1024);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            fragment: '"\n"',
          });
          if (runtimePlatform !== 'win32') {
            yield* fs.chmod(path.join(parent, 'source-evidence'), 0o755);
            expect(Result.isFailure(yield* readSourceEvidence(location, citation).pipe(Effect.result))).toBe(true);
            yield* fs.chmod(path.join(parent, 'source-evidence'), 0o700);
            expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'available'});
          }
        }),
      ),
    ),
  );

  effectIt.effect('enforces retention bounds and expires citations immediately', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          credentialState.value = credential;
          policyState.enabled = true;
          const {location, inspected, now} = yield* setup('pocket', 'first\nsecond');
          for (const invalidDays of [0, 366, 1.5, Number.NaN])
            expect(
              Result.isFailure(
                yield* captureSourceEvidence(location, captureInput(inspected, 'first', invalidDays)).pipe(
                  Effect.result,
                ),
              ),
            ).toBe(true);
          for (const fragment of ['', 'x'.repeat(8193), 'absent'])
            expect(
              Result.isFailure(
                yield* captureSourceEvidence(location, captureInput(inspected, fragment)).pipe(Effect.result),
              ),
            ).toBe(true);
          const standard = yield* captureSourceEvidence(location, captureInput(inspected, 'first'));
          const oneDay = yield* captureSourceEvidence(location, captureInput(inspected, 'second', 1));
          const year = yield* captureSourceEvidence(location, captureInput(inspected, 'first', 365));
          expect(Date.parse(standard.expiresAt) - now).toBeGreaterThanOrEqual(90 * 86_400_000);
          expect(Date.parse(standard.expiresAt) - now).toBeLessThan(90 * 86_400_000 + 10_000);
          expect(Date.parse(oneDay.expiresAt) - now).toBeGreaterThanOrEqual(86_400_000);
          expect(Date.parse(year.expiresAt) - now).toBeGreaterThanOrEqual(365 * 86_400_000);
          const expired = {...standard, expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1))};
          expect(yield* readSourceEvidence(location, expired)).toMatchObject({historical: 'expired'});
        }),
      ),
    ),
  );

  effectIt.effect('rejects capacity without evicting unexpired pins and prunes only valid expired pins', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          credentialState.value = credential;
          policyState.enabled = true;
          const {fs, path, location, inspected, now, pinDirectory} = yield* setup('pocket', 'tiny body');
          const first = yield* captureSourceEvidence(location, captureInput(inspected, 'tiny'));
          const prefix = 'THREADNOTE SOURCE EVIDENCE/1\n';
          const cloned = (index: number, expiresAt = first.expiresAt) => {
            const pinId = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
            const citation = {...first, pinId, expiresAt};
            return {pinId, content: `${prefix}${serializeSourceEvidenceCitation(citation)}\ntiny body`};
          };
          for (let index = 1; index <= 255; index++) {
            const item = cloned(index);
            yield* fs.writeFileString(path.join(pinDirectory, `${item.pinId}.json`), item.content, {mode: 0o600});
          }
          expect(
            Result.isFailure(
              yield* captureSourceEvidence(location, captureInput(inspected, 'tiny')).pipe(Effect.result),
            ),
          ).toBe(true);
          expect(yield* readSourceEvidence(location, first)).toMatchObject({historical: 'available'});
          const expired = cloned(255, DateTime.formatIso(DateTime.makeUnsafe(now - 1)));
          const expiredPath = path.join(pinDirectory, `${expired.pinId}.json`);
          yield* fs.writeFileString(expiredPath, expired.content, {mode: 0o600});
          const replacement = yield* captureSourceEvidence(location, captureInput(inspected, 'tiny'));
          expect(yield* fs.exists(expiredPath)).toBe(false);
          expect(yield* readSourceEvidence(location, replacement)).toMatchObject({historical: 'available'});
          expect(yield* readSourceEvidence(location, first)).toMatchObject({historical: 'available'});
          const corrupt = cloned(254, DateTime.formatIso(DateTime.makeUnsafe(now - 1)));
          const corruptPath = path.join(pinDirectory, `${corrupt.pinId}.json`);
          yield* fs.writeFileString(corruptPath, `${corrupt.content}tampered`, {mode: 0o600});
          expect(
            Result.isFailure(
              yield* captureSourceEvidence(location, captureInput(inspected, 'tiny')).pipe(Effect.result),
            ),
          ).toBe(true);
          expect(yield* fs.exists(corruptPath)).toBe(true);
        }),
      ),
    ),
  );

  effectIt.effect('denies retained text on quarantine, inactive receipt and GitHub repository denial changes', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          credentialState.value = credential;
          policyState.enabled = true;
          const {location, store, uri, receiptUri, manifestUri, manifest, inspected} = yield* setup(
            'github',
            'reviewed GitHub conversation',
          );
          const citation = yield* captureSourceEvidence(location, captureInput(inspected, 'reviewed'));
          const writeManifest = (status: 'active' | 'quarantined') =>
            store.write(location, manifestUri, serializeExternalDocumentManifest({...manifest, status}), {
              mode: 'upsert',
            });
          const writeReceipt = (status: 'active' | 'authentication-rejected', generation: string, denied = false) =>
            store.write(
              location,
              receiptUri,
              serializeExternalSourceReceipt({
                version: 1,
                provider: 'github',
                sourceId: 'fixture',
                accessEpoch: epoch,
                status,
                repositoryDenialGenerations: {'123': generation},
                ...(denied ? {deniedRepositoryIds: ['123']} : {}),
              }),
              {mode: 'upsert'},
            );
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'available'});
          yield* writeManifest('quarantined');
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'revoked'});
          yield* writeManifest('active');
          yield* writeReceipt('authentication-rejected', '1'.repeat(64));
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'revoked'});
          yield* writeReceipt('active', '2'.repeat(64));
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'revoked'});
          yield* writeReceipt('active', '2'.repeat(64), true);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'revoked'});
          expect(Result.isFailure(yield* inspectSourceEvidence(location, uri).pipe(Effect.result))).toBe(true);
          policyState.enabled = false;
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'revoked'});
          policyState.enabled = true;
        }),
      ),
    ),
  );

  effectIt.effect('rejects symlinked, nonregular, oversized and openly readable pin files', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          credentialState.value = credential;
          policyState.enabled = true;
          const {fs, path, location, inspected, pinDirectory} = yield* setup('pocket', 'private body');
          const citation = yield* captureSourceEvidence(location, captureInput(inspected, 'private'));
          const pin = path.join(pinDirectory, `${citation.pinId}.json`);
          const original = yield* fs.readFileString(pin);
          const outside = path.join(yield* fs.realPath(location.home), 'outside.txt');
          yield* fs.writeFileString(outside, original, {mode: 0o600});
          yield* fs.remove(pin);
          if (runtimePlatform !== 'win32') {
            yield* fs.symlink(outside, pin);
            expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'corrupt'});
            yield* fs.remove(pin);
          }
          yield* fs.makeDirectory(pin);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'corrupt'});
          yield* fs.remove(pin, {recursive: true});
          yield* fs.writeFileString(pin, 'x'.repeat(512 * 1024 + 4096 + 128), {mode: 0o600});
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'corrupt'});
          yield* fs.writeFileString(pin, original, {mode: 0o644});
          if (runtimePlatform !== 'win32') {
            yield* fs.chmod(pin, 0o644);
            expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'corrupt'});
          }
          yield* fs.chmod(pin, 0o600);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'available'});
        }),
      ),
    ),
  );

  effectIt.effect('retains exact cited text while current imported revision changes or removes the chunk', () =>
    TestClock.withLive(
      provide(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'source-evidence-'});
          const location = {home, account: 'local', user: 'tester'};
          const store = yield* ResourceStore;
          credentialState.value = credential;
          const now = yield* Clock.currentTimeMillis;
          const metadata = {
            version: 1 as const,
            provider: 'pocket' as const,
            sourceId: 'fixture',
            documentId: 'item1',
            pageId: 'page1',
            chunkId: 'chunk1',
            project: 'test',
            title: 'Synthetic',
            rendererVersion: 'renderer-v1',
            scrubberVersion: 'scrubber-v1',
            coverage: 'pocket-api-text' as const,
          };
          const uri = externalResourceUri(metadata);
          const body = 'One\n💡 exact fragment\nThree';
          const envelope = renderExternalResource(metadata, body);
          yield* store.write(
            location,
            externalSourceReceiptUri('fixture', 'pocket'),
            serializeExternalSourceReceipt({
              version: 1,
              provider: 'pocket',
              sourceId: 'fixture',
              accessEpoch: epoch,
              status: 'active',
            }),
            {mode: 'upsert'},
          );
          const writeSnapshot = (content: string, chunks: Record<string, string>) =>
            store.mutateChecked(
              location,
              [
                {type: 'write', uri, content, options: {mode: 'upsert'}},
                {
                  type: 'write',
                  uri: externalDocumentManifestUri('fixture', 'item1', 'pocket'),
                  content: serializeExternalDocumentManifest({
                    version: 1,
                    provider: 'pocket',
                    sourceId: 'fixture',
                    documentId: 'item1',
                    configFingerprint: config,
                    status: 'active',
                    fetchedAt: now,
                    maxStaleMilliseconds: 1_000_000,
                    accessEpoch: epoch,
                    chunks,
                  }),
                  options: {mode: 'upsert'},
                },
              ],
              Effect.void,
            );
          yield* writeSnapshot(envelope, {[uri]: yield* store.fingerprint(envelope)});
          const inspected = yield* inspectSourceEvidence(location, uri);
          expect(inspected.sanitizedContent).toBe(body);
          const citation = yield* captureSourceEvidence(location, {
            resourceUri: uri,
            fragment: '💡 exact fragment',
            expectedSourceInstanceId: inspected.sourceInstanceId,
            expectedAccessHash: inspected.accessHash,
            expectedRevisionHash: inspected.revisionHash,
            expectedContentHash: inspected.contentHash,
            expectedRendererVersion: inspected.rendererVersion,
            expectedSanitizerVersion: inspected.sanitizerVersion,
          });
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'same',
            fragment: '💡 exact fragment',
          });
          credentialState.value = 'e'.repeat(64);
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'revoked'});
          credentialState.value = credential;
          yield* store.remove(location, externalDocumentManifestUri('fixture', 'item1', 'pocket'));
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'unknown',
            fragment: '💡 exact fragment',
          });
          yield* store.write(location, externalDocumentManifestUri('fixture', 'item1', 'pocket'), '{bad json', {
            mode: 'upsert',
          });
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({historical: 'revoked'});
          const changed = renderExternalResource(metadata, 'New body');
          yield* writeSnapshot(changed, {[uri]: yield* store.fingerprint(changed)});
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'changed',
            fragment: '💡 exact fragment',
          });
          yield* writeSnapshot(changed, {});
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'available',
            currentRevision: 'removed',
            fragment: '💡 exact fragment',
          });
          yield* store.write(
            location,
            externalSourceReceiptUri('fixture', 'pocket'),
            serializeExternalSourceReceipt({
              version: 1,
              provider: 'pocket',
              sourceId: 'fixture',
              accessEpoch: 'd'.repeat(64),
              status: 'active',
            }),
            {mode: 'upsert'},
          );
          expect(yield* readSourceEvidence(location, citation)).toMatchObject({
            historical: 'revoked',
            currentRevision: 'unknown',
          });
          expect(
            Result.isFailure(
              yield* captureSourceEvidence(location, {
                resourceUri: uri,
                fragment: 'New body',
                expectedSourceInstanceId: inspected.sourceInstanceId,
                expectedAccessHash: inspected.accessHash,
                expectedRevisionHash: inspected.revisionHash,
                expectedContentHash: inspected.contentHash,
                expectedRendererVersion: inspected.rendererVersion,
                expectedSanitizerVersion: inspected.sanitizerVersion,
              }).pipe(Effect.result),
            ),
          ).toBe(true);
        }),
      ),
    ),
  );

  it('canonical citation round trips and rejects structural additions', () => {
    const base = {
      version: 1 as const,
      provider: 'linear' as const,
      sourceId: 'source',
      sourceInstanceId: epoch,
      resourceUri: externalResourceUri({
        provider: 'linear',
        sourceId: 'source',
        documentId: 'doc',
        pageId: 'page',
        chunkId: 'chunk',
      }),
      accessHash: config,
      revisionHash: config,
      contentHash: config,
      rendererVersion: 'renderer-v1',
      sanitizerVersion: 'scrubber-v1',
      fragmentHash: config,
      fragmentStart: 0,
      fragmentEnd: 1,
      pinId: '12345678-1234-4123-8123-123456789abc',
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    fc.assert(
      fc.property(fc.integer({min: 0, max: 500_000}), fc.integer({min: 1, max: 1000}), (start, length) => {
        const citation = {...base, fragmentStart: start, fragmentEnd: start + length};
        const serialized = serializeSourceEvidenceCitation(citation);
        expect(validSourceEvidenceCitation(JSON.parse(serialized))).toBe(true);
        expect(serializeSourceEvidenceCitation(JSON.parse(serialized))).toBe(serialized);
        expect(validSourceEvidenceCitation({...citation, unexpected: true})).toBe(false);
      }),
      {numRuns: 40},
    );
  });
});
