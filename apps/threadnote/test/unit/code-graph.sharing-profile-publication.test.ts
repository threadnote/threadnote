import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphShareProfileOciArtifact} from '@threadnote/graph/sharing/profile/oci_artifact';
import {publishGraphShareProfileArtifact} from '@threadnote/graph/sharing/profile/publication';
import {defaultGraphShareProfile} from '@threadnote/graph/sharing/profile';
import {makeGraphShareRegistryReader} from '@threadnote/graph/sharing/registry/reader';
import {makeGraphShareRegistryWriter} from '@threadnote/graph/sharing/registry/writer';

import {graphRegistryFixture} from '@threadnote/graph/test/helpers/graph-registry';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, FetchHttpClient.layer)),
);
const registryReference = 'oci://registry.example.test/acme/canonical';
const profile = {
  ...defaultGraphShareProfile({
    branch: 'refs/heads/main',
    canonicalRemote: 'github.com/acme/example',
    organization: 'acme',
    publisherKeyFingerprint: sha256Digest('publisher'),
    repositoryId: 'a'.repeat(64),
  }),
  registry: {canonical: registryReference, worker: 'oci://registry.example.test/acme/worker'},
};

effectIt.effect('publishes and verifies the immutable profile artifact before returning a pointer candidate', () =>
  Effect.gen(function* () {
    const fixture = yield* graphRegistryFixture();
    const writer = yield* fixture.provide(makeGraphShareRegistryWriter(registryReference));
    const reader = yield* fixture.provide(makeGraphShareRegistryReader(registryReference));
    const publish = () => fixture.provide(publishGraphShareProfileArtifact(profile, writer, reader));
    const expected = graphShareProfileOciArtifact(profile);
    expect(yield* publish()).toEqual(expected);
    const tag = `tn-profile-${expected.manifestDigest.slice('sha256:'.length)}`;
    expect(fixture.manifests.get(tag)).toEqual(expected.manifestBytes);
    expect(fixture.manifests.get(expected.manifestDigest)).toEqual(expected.manifestBytes);
    expect(fixture.blobs.get(expected.profileDigest)).toEqual(expected.profileBytes);
    const puts = fixture.requests.filter(request => request.method === 'PUT');
    expect(puts.map(request => request.pathname)).toEqual([
      `/v2/acme/canonical/blobs/uploads/fixture`,
      `/v2/acme/canonical/blobs/uploads/fixture`,
      `/v2/acme/canonical/manifests/${expected.manifestDigest}`,
      `/v2/acme/canonical/manifests/${tag}`,
    ]);
    expect(yield* publish()).toEqual(expected);
    expect(
      fixture.requests.filter(request => request.method === 'PUT' && request.pathname.endsWith(`/${tag}`)),
    ).toHaveLength(1);
  }).pipe(provideTestLayer(layer)),
);

effectIt.effect('fails closed on a conflicting profile tag or unverifiable remote body', () =>
  Effect.gen(function* () {
    const fixture = yield* graphRegistryFixture();
    const writer = yield* fixture.provide(makeGraphShareRegistryWriter(registryReference));
    const reader = yield* fixture.provide(makeGraphShareRegistryReader(registryReference));
    const artifact = graphShareProfileOciArtifact(profile);
    const tag = `tn-profile-${artifact.manifestDigest.slice('sha256:'.length)}`;
    fixture.manifests.set(tag, new TextEncoder().encode('{}'));
    expect(
      (yield* Effect.result(fixture.provide(publishGraphShareProfileArtifact(profile, writer, reader))))._tag,
    ).toBe('Failure');
    expect(fixture.requests.some(request => request.method === 'PUT')).toBe(false);
    fixture.manifests.delete(tag);
    const tamperedReader = {...reader, readBlob: () => Effect.succeed(Buffer.from('{}'))};
    expect(
      (yield* Effect.result(fixture.provide(publishGraphShareProfileArtifact(profile, writer, tamperedReader))))._tag,
    ).toBe('Failure');

    const second = yield* graphRegistryFixture();
    const originalWriter = yield* second.provide(makeGraphShareRegistryWriter(registryReference));
    const secondReader = yield* second.provide(makeGraphShareRegistryReader(registryReference));
    let heads = 0;
    const changedTagWriter = {
      ...originalWriter,
      headManifest: (reference: string) =>
        ++heads === 1 ? originalWriter.headManifest(reference) : Effect.succeed(sha256Digest('changed tag')),
    };
    expect(
      (yield* Effect.result(second.provide(publishGraphShareProfileArtifact(profile, changedTagWriter, secondReader))))
        ._tag,
    ).toBe('Failure');
    expect(heads).toBe(2);
  }).pipe(provideTestLayer(layer)),
);
