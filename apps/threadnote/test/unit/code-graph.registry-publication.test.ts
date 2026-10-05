import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {graphRegistryFixture} from '@threadnote/graph/test/helpers/graph-registry';

import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {
  generateGraphSharePublisherKey,
  signGraphShareFrontier,
  GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE,
  type GraphShareFrontierManifestV1,
} from '@threadnote/graph/sharing/artifacts';
import {writePrivateJsonFile} from '@threadnote/graph/sharing/atomic';
import {putCasBytes} from '@threadnote/graph/sharing/cas';
import {putSignedGraphShareFrontierDocuments} from '@threadnote/graph/sharing/descriptor';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphSharingFrontierPointerPath, graphSharingLayout} from '@threadnote/graph/sharing/layout';
import {graphShareFrontierDiscoveryTag} from '@threadnote/graph/sharing/namespace';
import {casProfilePointer, defaultGraphShareProfile, graphShareProfileDigest} from '@threadnote/graph/sharing/profile';
import {publishGraphShareRegistryFrontier} from '@threadnote/graph/sharing/registry/publication';
import {
  graphSharePublicationAuthority,
  graphSharePublicationReceiptPath,
  readGraphSharePublicationReceipt,
} from '@threadnote/graph/sharing/registry/publication_state';
import {readGraphControlFrontier} from '@threadnote/graph/sharing/control/reader';
import {collectGraphShareRegistryPublication} from '@threadnote/graph/sharing/registry/closure';

const layer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, FetchHttpClient.layer)),
);
const fixture = Effect.fn('test.registryPublication.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-publication-'});
  const casRoot = path.join(home, 'cas');
  const registry = yield* graphRegistryFixture();
  const key = yield* generateGraphSharePublisherKey();
  const profile = {
    ...defaultGraphShareProfile({
      branch: 'refs/heads/main',
      canonicalRemote: 'github.com/acme/example',
      organization: 'acme',
      publisherKeyFingerprint: key.fingerprint,
      repositoryId: 'a'.repeat(64),
    }),
    registry: {canonical: 'oci://registry.example.test/acme/canonical', worker: 'cas://local/worker'},
  };
  const profileDigest = graphShareProfileDigest(profile);
  const enrollment = {
    profile: casProfilePointer(profileDigest),
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: profile.repositoryId,
    schemaVersion: 1 as const,
  };
  const scope = {
    branch: 'refs/heads/main',
    profileDigest,
    publisherKeyFingerprint: key.fingerprint,
    repositoryId: profile.repositoryId,
  };
  const authority = graphSharePublicationAuthority(scope, profile.registry.canonical);
  const pointerPath = graphSharingFrontierPointerPath(
    path,
    graphSharingLayout(path, home, casRoot).frontiersRoot,
    profile.repositoryId,
  );
  const candidate = Effect.fn('test.registryPublication.candidate')(function* (
    generation: number,
    previousManifestDigest: GraphShareFrontierManifestV1['previousManifestDigest'] = null,
    checkpointGeneration = generation,
  ) {
    const bytes = new TextEncoder().encode(`synthetic-checkpoint-${checkpointGeneration}`);
    const checkpointDigest = yield* putCasBytes(casRoot, bytes);
    const metadataBytes = new TextEncoder().encode(
      canonicalJson({
        artifactDigest: checkpointDigest,
        prefixDigest: checkpointDigest,
        mediaType: GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE,
        chunks: [],
        schemaVersion: 1,
      }),
    );
    const metadataDigest = yield* putCasBytes(casRoot, metadataBytes);
    const manifest: GraphShareFrontierManifestV1 = {
      branch: scope.branch,
      profileDigest,
      repositoryId: scope.repositoryId,
      checkpoint: {
        manifestDigest: checkpointDigest,
        metadataDigest,
        snapshotId: 'cgsn_fixture',
        sourceCommit: 'b'.repeat(40),
      },
      deltas: [],
      generation,
      graphAbi: 'c'.repeat(64),
      graphContentId: 'cgc_' + 'd'.repeat(40),
      logicalGraphDigest: sha256Digest('graph'),
      previousManifestDigest,
      publisherFence: 1,
      schemaVersion: 1,
      snapshotId: 'cgsn_fixture',
      sourceCommit: 'b'.repeat(40),
    };
    const signed = yield* signGraphShareFrontier(key, manifest);
    const documents = yield* putSignedGraphShareFrontierDocuments(casRoot, signed, metadataBytes);
    const pointer = {
      schemaVersion: 1 as const,
      manifestDigest: documents.manifestDigest,
      envelopeDigest: documents.envelopeDigest,
    };
    yield* writePrivateJsonFile(pointerPath, pointer);
    return {...documents, pointer};
  });
  const input = {home, casRoot, enrollment, profile};
  return {
    fs,
    home,
    casRoot,
    registry,
    candidate,
    input,
    scope,
    pointerPath,
    tag: graphShareFrontierDiscoveryTag(profile.repositoryId, scope.branch),
    receipt: readGraphSharePublicationReceipt(home, authority),
    receiptPath: yield* graphSharePublicationReceiptPath(home, authority),
    publish: () => registry.provide(publishGraphShareRegistryFrontier(input)),
    control: readGraphControlFrontier({...input, threadnoteHome: home, policyFile: 'unused'}),
  };
});

effectIt.effect('keeps pending state when saving a successful registry acknowledgement fails', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.candidate(1);
    let failed = false;
    const brokenOnce = {
      ...f.fs,
      rename: (from: string, to: string) => {
        if (!failed && to === f.receiptPath && f.registry.manifests.has(f.tag)) {
          failed = true;
          return f.fs.rename(from + '.missing', to);
        }
        return f.fs.rename(from, to);
      },
    };
    expect((yield* f.publish().pipe(Effect.provideService(FileSystem.FileSystem, brokenOnce))).status).toBe('pending');
    expect(failed).toBe(true);
    expect((yield* f.receipt).acknowledged).toBeUndefined();
    expect((yield* f.receipt).pending?.generation).toBe(1);
    yield* TestClock.adjust(6000);
    expect((yield* f.publish()).status).toBe('acknowledged');
  }).pipe(provideTestLayer(layer)),
);

effectIt.effect('serializes concurrent publishers with one promotion and idempotent confirmed retries', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.candidate(1);
      const results = yield* Effect.forEach([1, 2, 3], () => f.publish(), {concurrency: 'unbounded'});
      expect(results.every(result => result.status === 'acknowledged')).toBe(true);
      expect(
        f.registry.requests.filter(request => request.method === 'PUT' && request.pathname.endsWith(f.tag)),
      ).toHaveLength(1);
    }).pipe(provideTestLayer(layer)),
  ),
);

effectIt.effect('retains complete checkpoint windows and counts the current body in the 64-frontier limit', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const first = yield* f.candidate(1);
    const second = yield* f.candidate(2, first.manifestDigest);
    const third = yield* f.candidate(3, second.manifestDigest);
    const input = {casRoot: f.casRoot, scope: f.scope, pointer: third.pointer, checkpointCount: 2};
    const bounded = yield* collectGraphShareRegistryPublication(input);
    expect(bounded.historyFloor.generation).toBe(2);
    expect(bounded.retention.entries.some(entry => entry.digest === first.manifestDigest)).toBe(false);
    expect(bounded.retention.entries.some(entry => entry.digest === second.manifestDigest)).toBe(true);
    let latest = third;
    for (let generation = 4; generation <= 67; generation += 1)
      latest = yield* f.candidate(generation, latest.manifestDigest, 3);
    const limited = yield* collectGraphShareRegistryPublication({...input, pointer: latest.pointer});
    expect(limited.historyFloor.generation).toBe(4);
    expect(limited.retention.entries.some(entry => entry.digest === third.manifestDigest)).toBe(false);
  }).pipe(provideTestLayer(layer)),
);

effectIt.effect(
  'recovers a lost tag acknowledgement after restart without a new commit and only advertises confirmed uploads',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.candidate(1);
      f.registry.state.loseTagAcknowledgement = true;
      expect((yield* f.publish()).status).toBe('pending');
      expect(yield* f.receipt).toMatchObject({pending: {generation: 1}, nextAttempt: 17_000});
      expect(yield* Effect.result(f.control)).toMatchObject({failure: {kind: 'unavailable'}});
      expect(f.registry.manifests.has(f.tag)).toBe(true);
      const count = f.registry.requests.length;
      f.registry.state.loseTagAcknowledgement = false;
      expect((yield* f.publish()).status).toBe('pending');
      expect(f.registry.requests).toHaveLength(count);
      yield* TestClock.adjust(17_000);
      expect((yield* f.publish()).status).toBe('acknowledged');
      expect(yield* f.receipt).toMatchObject({acknowledged: {generation: 1}, failures: 0});
      expect((yield* f.receipt).pending).toBeUndefined();
      expect((yield* f.control).pointer).toEqual(first.pointer);
      const after = f.registry.requests.length;
      yield* f.publish();
      expect(f.registry.requests).toHaveLength(after);
    }).pipe(provideTestLayer(layer)),
);

effectIt.effect('preserves the confirmed frontier during newer failures and repairs only known older remote tags', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const first = yield* f.candidate(1);
    yield* f.publish();
    const older = f.registry.manifests.get(f.tag)!;
    const second = yield* f.candidate(2, first.manifestDigest);
    f.registry.state.outage = true;
    expect((yield* f.publish()).status).toBe('pending');
    expect((yield* f.control).pointer).toEqual(first.pointer);
    f.registry.state.outage = false;
    yield* TestClock.adjust(17_000);
    yield* f.publish();
    expect((yield* f.control).pointer).toEqual(second.pointer);
    f.registry.manifests.set(f.tag, older);
    yield* TestClock.adjust(60_000);
    expect((yield* f.publish()).status).toBe('acknowledged');
    expect(sha256Digest(f.registry.manifests.get(f.tag)!)).toBe(second.descriptorDigest);
    f.registry.manifests.set(f.tag, new TextEncoder().encode('unknown publication'));
    yield* TestClock.adjust(60_000);
    const before = f.registry.requests.filter(r => r.method === 'PUT').length;
    expect((yield* f.publish()).status).toBe('pending');
    expect(f.registry.requests.filter(r => r.method === 'PUT')).toHaveLength(before);
    yield* writePrivateJsonFile(f.pointerPath, first.pointer);
    yield* TestClock.adjust(17_000);
    expect((yield* f.publish()).status).toBe('pending');
    expect((yield* f.receipt).acknowledged?.generation).toBe(2);
  }).pipe(provideTestLayer(layer)),
);

effectIt.effect('fails closed on corrupt receipt and backs off before rescanning an incomplete closure', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.candidate(1, sha256Digest('missing predecessor'));
    expect((yield* f.publish()).status).toBe('pending');
    expect(f.registry.requests).toHaveLength(0);
    expect((yield* f.receipt).nextAttempt).toBeGreaterThan(yield* Clock.currentTimeMillis);
    yield* f.fs.writeFileString(f.receiptPath, '{"schemaVersion":99}');
    expect((yield* Effect.result(f.publish()))._tag).toBe('Failure');
    expect(f.registry.requests).toHaveLength(0);
  }).pipe(provideTestLayer(layer)),
);
