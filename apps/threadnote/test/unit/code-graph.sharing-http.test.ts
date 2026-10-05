import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {codeGraphCheckpointFileFactCacheIdentity} from '@threadnote/graph/checkpoint/file_fact_identity';
import {encodeCodeGraphCheckpointPackV1} from '@threadnote/graph/checkpoint/pack';
import type {
  CodeGraphCheckpointFileFactRecordV1,
  CodeGraphCheckpointFileRecordV1,
  CodeGraphCheckpointMetadataV1,
  CodeGraphCheckpointRecordV1,
} from '@threadnote/graph/checkpoint/schema';
import {
  GRAPH_SHARE_RECORDS_MEDIA_TYPE,
  generateGraphSharePublisherKey,
  signGraphShareFrontier,
  type GraphShareFrontierManifestV1,
} from '@threadnote/graph/sharing/artifacts';
import {decodeJsonBytes, readJsonFile, writePrivateJsonFile} from '@threadnote/graph/sharing/atomic';
import {casBlobPath, putCasBytes, putCasFile} from '@threadnote/graph/sharing/cas';
import {
  assembleGraphShareCheckpointLayers,
  ensureGraphShareCheckpointArtifact,
  parseGraphShareCheckpointMetadata,
  putGraphShareCheckpointLayers,
} from '@threadnote/graph/sharing/checkpoint_cas';
import {
  graphShareControlAnnounceResult,
  graphShareControlGetCas,
  graphShareControlGetFrontier,
  graphShareControlGetJson,
  graphShareControlGetStatus,
  graphShareControlGetTag,
  graphShareControlPostJson,
  graphShareControlPutCas,
} from '@threadnote/graph/sharing/control/client';
import {recordPublishedFrontier, runGraphShareControlServer} from '@threadnote/graph/sharing/control/server';
import {
  graphShareFrontierPointerFromOciDescriptor,
  graphShareOciLayerMediaTypes,
  graphShareProductionLayerMediaTypesUseRecords,
  parseGraphShareOciDescriptor,
  putSignedGraphShareFrontierDocuments,
} from '@threadnote/graph/sharing/descriptor';
import {sha256Digest, sha256HexFromDigest} from '@threadnote/graph/sharing/digest';
import {GraphSharingError} from '@threadnote/graph/sharing/errors';
import {graphSharingFrontierPointerPath, graphSharingLayout} from '@threadnote/graph/sharing/layout';
import {graphShareFrontierDiscoveryTag} from '@threadnote/graph/sharing/namespace';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES, graphSharePayloadLooksLikeGitObject} from '@threadnote/graph/sharing/oci';

const sharingLayer = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer);

describe('graph share live coordinator and digest CAS', () => {
  effectIt.effect('serves CAS blobs, rejects Git objects, and never accepts source on the control API', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-http-'});
        const casRoot = path.join(home, 'cas');
        yield* fs.makeDirectory(casRoot, {recursive: true, mode: 0o700});
        const ready = yield* Deferred.make<{readonly port: number; readonly url: string}>();
        yield* Effect.forkScoped(
          runGraphShareControlServer({
            casRoot,
            listen: {hostname: '127.0.0.1', port: 0},
            onListening: info => Deferred.succeed(ready, info).pipe(Effect.asVoid),
            organization: 'acme',
            repositoryId: 'a'.repeat(64),
            threadnoteHome: home,
          }),
        );
        const info = yield* Deferred.await(ready);
        const payload = new TextEncoder().encode('{"kind":"parse-result"}');
        const digest = yield* graphShareControlPutCas(info.url, payload);
        expect(digest).toBe(sha256Digest(payload));
        const fetched = yield* graphShareControlGetCas(info.url, digest);
        expect(new TextDecoder().decode(fetched)).toBe('{"kind":"parse-result"}');
        const gitBlob = new TextEncoder().encode('blob 4\0test');
        expect(graphSharePayloadLooksLikeGitObject(gitBlob)).toBe(true);
        const gitRejected = yield* graphShareControlPutCas(info.url, gitBlob).pipe(
          Effect.as(false),
          Effect.catchIf(
            error => Schema.is(GraphSharingError)(error),
            () => Effect.succeed(true),
          ),
        );
        expect(gitRejected).toBe(true);
        const treeHex = sha256HexFromDigest(sha256Digest(gitBlob));
        const missingTree = yield* graphShareControlGetCas(info.url, `sha256:${treeHex}`).pipe(
          Effect.as(false),
          Effect.catchIf(
            error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
            () => Effect.succeed(true),
          ),
        );
        expect(missingTree).toBe(true);
        const wellKnown = yield* graphShareControlGetJson(info.url, '/.well-known/threadnote-graph');
        expect(wellKnown).toMatchObject({organization: 'acme', protocolVersions: ['v1']});
        const sourceRejected = yield* graphShareControlPostJson(info.url, '/v1/results', {
          source: 'fn main() {}',
        });
        expect(sourceRejected.status).toBe(400);
        const client = yield* HttpClient.HttpClient;
        const malformed = yield* client.execute(
          HttpClientRequest.post(`${info.url}/v1/results`).pipe(
            HttpClientRequest.bodyUint8Array(new TextEncoder().encode('{'), 'application/json'),
          ),
        );
        expect(malformed.status).toBe(400);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'graph-sharing JSON bytes round-trip I-JSON objects independently of JSON.parse',
    {
      generation: FC.integer({max: 10_000, min: 0}),
      organization: FC.array(FC.constantFrom(...'0123456789abcdef'), {maxLength: 16, minLength: 1}).map(characters =>
        characters.join(''),
      ),
    },
    ({generation, organization}) =>
      Effect.gen(function* () {
        const value = {generation, organization, protocolVersions: ['v1'] as const};
        const decoded = yield* decodeJsonBytes(new TextEncoder().encode(JSON.stringify(value)));
        expect(decoded).toEqual({...value, protocolVersions: ['v1']});
      }),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('commits concurrent result announcements without dropping receipts', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-race-'});
        const casRoot = path.join(home, 'cas');
        yield* fs.makeDirectory(casRoot, {recursive: true, mode: 0o700});
        const ready = yield* Deferred.make<{readonly port: number; readonly url: string}>();
        yield* Effect.forkScoped(
          runGraphShareControlServer({
            casRoot,
            listen: {hostname: '127.0.0.1', port: 0},
            onListening: info => Deferred.succeed(ready, info).pipe(Effect.asVoid),
            organization: 'acme',
            repositoryId: 'a'.repeat(64),
            threadnoteHome: home,
          }),
        );
        const info = yield* Deferred.await(ready);
        const announcements = [0, 1, 2, 3, 4, 5, 6, 7].map(index => ({
          actionKey: index.toString(16).repeat(64).slice(0, 64),
          attestationDigest: sha256Digest(`att-${index}`),
          batchId: 'b'.repeat(40),
          resultManifestDigest: sha256Digest(`res-${index}`),
          semanticDigest: sha256Digest(`sem-${index}`),
        }));
        yield* Effect.forEach(
          announcements,
          (announcement, index) => graphShareControlAnnounceResult(info.url, announcement, `k${index}`),
          {concurrency: 'unbounded'},
        );
        const status = yield* graphShareControlGetStatus(info.url);
        expect(status.receipts).toHaveLength(announcements.length);
        const persisted = (yield* readJsonFile(graphSharingLayout(path, home).coordinatorStatePath)) as {
          readonly receipts: {readonly receipts: readonly unknown[]};
        };
        expect(persisted.receipts.receipts).toHaveLength(announcements.length);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('rejects 33 MiB CAS PUT and GET of an oversized local blob with HTTP 413', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-cas-limit-'});
        const casRoot = path.join(home, 'cas');
        yield* fs.makeDirectory(casRoot, {recursive: true, mode: 0o700});
        const ready = yield* Deferred.make<{readonly port: number; readonly url: string}>();
        yield* Effect.forkScoped(
          runGraphShareControlServer({
            casRoot,
            listen: {hostname: '127.0.0.1', port: 0},
            onListening: info => Deferred.succeed(ready, info).pipe(Effect.asVoid),
            organization: 'acme',
            repositoryId: 'a'.repeat(64),
            threadnoteHome: home,
          }),
        );
        const info = yield* Deferred.await(ready);
        const oversized = new Uint8Array(GRAPH_SHARE_HTTP_CAS_MAX_BYTES + 1);
        oversized.fill(7);
        const putRejected = yield* graphShareControlPutCas(info.url, oversized).pipe(
          Effect.as(false),
          Effect.catchIf(
            error => Schema.is(GraphSharingError)(error),
            () => Effect.succeed(true),
          ),
        );
        expect(putRejected).toBe(true);
        const digest = yield* putCasBytes(casRoot, oversized);
        const client = yield* HttpClient.HttpClient;
        const getResponse = yield* client.execute(
          HttpClientRequest.get(`${info.url}/v1/cas/sha256/${sha256HexFromDigest(digest)}`),
        );
        expect(getResponse.status).toBe(413);
        const getRejected = yield* graphShareControlGetCas(info.url, digest).pipe(
          Effect.as(false),
          Effect.catchIf(
            error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
            () => Effect.succeed(true),
          ),
        );
        expect(getRejected).toBe(true);
        const missingMetadata = yield* ensureGraphShareCheckpointArtifact({
          artifactDigest: digest,
          casRoot: path.join(home, 'client-cas'),
          coordinatorUrl: info.url,
        }).pipe(
          Effect.as(false),
          Effect.catchIf(
            error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
            () => Effect.succeed(true),
          ),
        );
        expect(missingMetadata).toBe(true);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('imports a chunked checkpoint from metadata layers without GETting the assembled digest', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-chunked-http-'});
        const publisherCas = path.join(home, 'publisher-cas');
        const clientCas = path.join(home, 'client-cas');
        yield* fs.makeDirectory(publisherCas, {recursive: true, mode: 0o700});
        const pack = encodeCodeGraphCheckpointPackV1(
          httpCheckpointMetadata(4),
          httpCheckpointRecords(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']),
          {limits: {targetUncompressedChunkBytes: 400}},
        );
        expect(pack.header.chunks.length).toBeGreaterThan(1);
        const artifactPath = path.join(home, 'artifact.cgcp');
        yield* fs.writeFile(artifactPath, pack.bytes);
        const artifactDigest = yield* putCasFile(publisherCas, artifactPath);
        const published = yield* putGraphShareCheckpointLayers(publisherCas, artifactDigest);
        yield* fs.remove(yield* casBlobPath(publisherCas, artifactDigest));
        const ready = yield* Deferred.make<{readonly port: number; readonly url: string}>();
        yield* Effect.forkScoped(
          runGraphShareControlServer({
            casRoot: publisherCas,
            listen: {hostname: '127.0.0.1', port: 0},
            onListening: info => Deferred.succeed(ready, info).pipe(Effect.asVoid),
            organization: 'acme',
            repositoryId: 'a'.repeat(64),
            threadnoteHome: home,
          }),
        );
        const info = yield* Deferred.await(ready);
        const missingAssembled = yield* graphShareControlGetCas(info.url, artifactDigest).pipe(
          Effect.as(false),
          Effect.catchIf(
            error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
            () => Effect.succeed(true),
          ),
        );
        expect(missingAssembled).toBe(true);
        const assembledPath = yield* ensureGraphShareCheckpointArtifact({
          artifactDigest,
          casRoot: clientCas,
          coordinatorUrl: info.url,
          metadataDigest: published.metadataDigest,
        });
        expect(new Uint8Array(yield* fs.readFile(assembledPath))).toEqual(pack.bytes);
        const stillMissingOnPublisher = yield* fs.exists(yield* casBlobPath(publisherCas, artifactDigest));
        expect(stillMissingOnPublisher).toBe(false);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('resolves a published generation through tag, OCI descriptor, layer GET, and assemble', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-oci-http-'});
        const publisherCas = path.join(home, 'publisher-cas');
        const clientCas = path.join(home, 'client-cas');
        yield* fs.makeDirectory(publisherCas, {recursive: true, mode: 0o700});
        const pack = encodeCodeGraphCheckpointPackV1(
          httpCheckpointMetadata(4),
          httpCheckpointRecords(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']),
          {limits: {targetUncompressedChunkBytes: 400}},
        );
        const artifactPath = path.join(home, 'artifact.cgcp');
        yield* fs.writeFile(artifactPath, pack.bytes);
        const artifactDigest = yield* putCasFile(publisherCas, artifactPath);
        const layers = yield* putGraphShareCheckpointLayers(publisherCas, artifactDigest);
        const repositoryId = 'a'.repeat(64);
        const sourceCommit = HTTP_SHA1_ZERO;
        const manifest: GraphShareFrontierManifestV1 = {
          branch: 'refs/heads/main',
          checkpoint: {
            manifestDigest: artifactDigest,
            metadataDigest: layers.metadataDigest,
            snapshotId: 'cgsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            sourceCommit,
          },
          deltas: [],
          generation: 1,
          graphAbi: 'c'.repeat(64),
          graphContentId: 'cgc_' + 'd'.repeat(40),
          logicalGraphDigest: sha256Digest('logical'),
          previousManifestDigest: null,
          profileDigest: sha256Digest('profile'),
          publisherFence: 1,
          repositoryId,
          schemaVersion: 1,
          snapshotId: 'cgsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sourceCommit,
        };
        const signed = yield* signGraphShareFrontier(yield* generateGraphSharePublisherKey(), manifest);
        const metadataBytes = yield* fs.readFile(yield* casBlobPath(publisherCas, layers.metadataDigest));
        const published = yield* putSignedGraphShareFrontierDocuments(publisherCas, signed, metadataBytes);
        expect(graphShareProductionLayerMediaTypesUseRecords(graphShareOciLayerMediaTypes(published.descriptor))).toBe(
          false,
        );
        expect(JSON.stringify(published.descriptor)).not.toContain(GRAPH_SHARE_RECORDS_MEDIA_TYPE);
        expect(layers.metadata.mediaType).not.toBe(GRAPH_SHARE_RECORDS_MEDIA_TYPE);
        yield* writePrivateJsonFile(
          graphSharingFrontierPointerPath(
            path,
            graphSharingLayout(path, home, publisherCas).frontiersRoot,
            repositoryId,
          ),
          {
            envelopeDigest: published.envelopeDigest,
            manifestDigest: published.manifestDigest,
            schemaVersion: 1,
          },
        );
        yield* recordPublishedFrontier(
          {casRoot: publisherCas, organization: 'acme', repositoryId, threadnoteHome: home},
          {
            branch: 'refs/heads/main',
            descriptorDigest: published.descriptorDigest,
            envelopeDigest: published.envelopeDigest,
            generation: 1,
            manifestDigest: published.manifestDigest,
            repositoryId,
            sourceCommit,
          },
        );
        const ready = yield* Deferred.make<{readonly port: number; readonly url: string}>();
        yield* Effect.forkScoped(
          runGraphShareControlServer({
            casRoot: publisherCas,
            listen: {hostname: '127.0.0.1', port: 0},
            onListening: info => Deferred.succeed(ready, info).pipe(Effect.asVoid),
            organization: 'acme',
            repositoryId,
            threadnoteHome: home,
          }),
        );
        const info = yield* Deferred.await(ready);
        const tagName = graphShareFrontierDiscoveryTag(repositoryId, 'refs/heads/main');
        const tagged = yield* graphShareControlGetTag(info.url, tagName);
        expect(tagged).toBe(published.descriptorDigest);
        const descriptorBytes = yield* graphShareControlGetCas(info.url, tagged);
        const descriptor = parseGraphShareOciDescriptor(yield* decodeJsonBytes(descriptorBytes));
        const pointer = graphShareFrontierPointerFromOciDescriptor(descriptor);
        expect(pointer.manifestDigest).toBe(published.manifestDigest);
        expect(pointer.envelopeDigest).toBe(published.envelopeDigest);
        const body = yield* graphShareControlGetCas(info.url, pointer.manifestDigest);
        const envelope = yield* graphShareControlGetCas(info.url, pointer.envelopeDigest);
        const metadataLayer = yield* graphShareControlGetCas(info.url, pointer.metadataDigest);
        expect(sha256Digest(body)).toBe(published.manifestDigest);
        expect(sha256Digest(envelope)).toBe(published.envelopeDigest);
        const metadata = parseGraphShareCheckpointMetadata(yield* decodeJsonBytes(metadataLayer));
        yield* putCasBytes(clientCas, metadataLayer);
        yield* putCasBytes(clientCas, yield* graphShareControlGetCas(info.url, metadata.prefixDigest));
        for (const chunk of metadata.chunks) {
          yield* putCasBytes(clientCas, yield* graphShareControlGetCas(info.url, chunk.digest));
        }
        const assembled = path.join(home, 'assembled.cgcp');
        const assembledDigest = yield* assembleGraphShareCheckpointLayers(clientCas, metadata, assembled);
        expect(assembledDigest).toBe(artifactDigest);
        expect(assembledDigest).toBe(manifest.checkpoint.manifestDigest);
        const latest = (yield* readJsonFile(
          graphSharingFrontierPointerPath(
            path,
            graphSharingLayout(path, home, publisherCas).frontiersRoot,
            repositoryId,
          ),
        )) as {readonly envelopeDigest: string; readonly manifestDigest: string};
        expect(latest.manifestDigest).toBe(published.manifestDigest);
        expect(latest.envelopeDigest).toBe(published.envelopeDigest);
        const frontier = yield* graphShareControlGetFrontier(info.url, tagName.slice('tn-frontier-'.length));
        expect(frontier.manifestDigest).toBe(published.manifestDigest);
        expect(frontier.envelopeDigest).toBe(published.envelopeDigest);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );

  effectIt.effect('reports published generation on GET /v1/status after recordPublishedFrontier', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-status-'});
        const casRoot = path.join(home, 'cas');
        yield* fs.makeDirectory(casRoot, {recursive: true, mode: 0o700});
        const repositoryId = 'a'.repeat(64);
        const sourceCommit = 'b'.repeat(40);
        const manifestDigest = sha256Digest('frontier-manifest');
        yield* recordPublishedFrontier(
          {casRoot, organization: 'acme', repositoryId, threadnoteHome: home},
          {
            branch: 'refs/heads/main',
            descriptorDigest: sha256Digest('oci-descriptor'),
            envelopeDigest: sha256Digest('frontier-envelope'),
            generation: 1,
            manifestDigest,
            repositoryId,
            sourceCommit,
          },
        );
        const ready = yield* Deferred.make<{readonly port: number; readonly url: string}>();
        yield* Effect.forkScoped(
          runGraphShareControlServer({
            casRoot,
            listen: {hostname: '127.0.0.1', port: 0},
            onListening: info => Deferred.succeed(ready, info).pipe(Effect.asVoid),
            organization: 'acme',
            repositoryId,
            threadnoteHome: home,
          }),
        );
        const info = yield* Deferred.await(ready);
        const status = yield* graphShareControlGetStatus(info.url);
        expect(status.generation).toBe(1);
        expect(status.phase).toBe('published');
        expect(status.publishedFrontier).toBe(sourceCommit);
      }).pipe(provideTestLayer(sharingLayer)),
    ),
  );
});

const HTTP_SHA256_ZERO = '0'.repeat(64);
const HTTP_SHA1_ZERO = '0'.repeat(40);
const HTTP_UTF8 = new TextEncoder();

function httpCheckpointMetadata(eligibleFiles: number): CodeGraphCheckpointMetadataV1 {
  return {
    abi: {
      checkpointSemanticVersion: 1,
      graphSchemaVersion: 1,
      inventoryPolicyVersion: 1,
      languagePacks: [],
      lexicalLogicalFormatVersion: 1,
      pathPolicy: 'repository-relative-posix-v1',
      referenceResolutionVersion: 'resolution-v1',
      workspaceModelVersion: 'workspace-v1',
    },
    coverage: {eligibleFiles, excludedFiles: 0, reasons: [], state: 'complete'},
    repository: {
      caseMode: 'sensitive',
      displayName: 'checkpoint-fixture',
      objectFormat: 'sha1',
      repositoryId: HTTP_SHA256_ZERO,
    },
    source: {
      commit: HTTP_SHA1_ZERO,
      extractorSet: 'typescript-v1',
      graphContentId: `cgc_${HTTP_SHA1_ZERO}`,
    },
  };
}

function httpCheckpointRecords(paths: readonly string[]): CodeGraphCheckpointRecordV1[] {
  return paths.flatMap(filePath => [httpFileRecord(filePath), httpFactRecord(filePath)]);
}

function httpFileRecord(filePath: string): CodeGraphCheckpointFileRecordV1 {
  return {
    blobId: HTTP_SHA1_ZERO,
    contentHash: HTTP_SHA256_ZERO,
    kind: 'file',
    language: 'typescript',
    mode: '100644',
    path: filePath,
    size: HTTP_UTF8.encode(filePath).byteLength,
    source: 'commit',
  };
}

function httpFactRecord(filePath: string): CodeGraphCheckpointFileFactRecordV1 {
  const facts = {diagnostics: [], edges: [], path: filePath, symbols: []};
  return {
    cacheIdentity: codeGraphCheckpointFileFactCacheIdentity(facts),
    factRole: 'materialized',
    facts,
    kind: 'file-fact',
    path: filePath,
  };
}
