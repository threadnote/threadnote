import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {putCasBytes} from '@threadnote/graph/sharing/cas';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {graphShareProfileOciArtifact} from '@threadnote/graph/sharing/profile/oci_artifact';
import {readGraphShareEnrolledProfile} from '@threadnote/graph/sharing/profile/storage';
import {casProfilePointer, defaultGraphShareProfile, ociProfilePointer} from '@threadnote/graph/sharing/profile';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {FileSystem} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const registryReference = 'oci://registry.example.test/acme/canonical';
const profile = {
  ...defaultGraphShareProfile({
    branch: 'refs/heads/main',
    canonicalRemote: 'github.com/acme/example',
    organization: 'acme',
    publisherKeyFingerprint: sha256Digest('publisher'),
    repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
  }),
  registry: {canonical: registryReference, worker: 'oci://registry.example.test/acme/worker'},
};
const artifact = graphShareProfileOciArtifact(profile);

effectIt.effect('reads both legacy CAS and v2 OCI profiles but refuses an unverified manifest pin', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cas = yield* fs.makeTempDirectoryScoped({prefix: 'graph-profile-storage-'});
    const bodyDigest = yield* putCasBytes(cas, new TextEncoder().encode(canonicalJson(profile)));
    const legacy = {
      profile: casProfilePointer(bodyDigest),
      publisherKeyFingerprint: profile.trust.publisherKeys[0],
      repositoryId: profile.repositoryId,
      schemaVersion: 1 as const,
    };
    expect(yield* readGraphShareEnrolledProfile(cas, legacy)).toEqual(profile);
    const enrollment = {
      profile: ociProfilePointer(registryReference, artifact.manifestDigest),
      profileDigest: artifact.profileDigest,
      publisherKeyFingerprint: profile.trust.publisherKeys[0],
      repositoryId: profile.repositoryId,
      schemaVersion: 2 as const,
    };
    expect((yield* Effect.result(readGraphShareEnrolledProfile(cas, enrollment)))._tag).toBe('Failure');
    yield* putCasBytes(cas, artifact.manifestBytes);
    expect(yield* readGraphShareEnrolledProfile(cas, enrollment)).toEqual(profile);
    expect(
      (yield* Effect.result(readGraphShareEnrolledProfile(cas, {...enrollment, profileDigest: sha256Digest('wrong')})))
        ._tag,
    ).toBe('Failure');
    expect(
      (yield* Effect.result(
        readGraphShareEnrolledProfile(cas, {...enrollment, repositoryId: Effect2.pipe('b', EffectString.repeat(64))}),
      ))._tag,
    ).toBe('Failure');
    for (const changed of ['oci://other.example.test/acme/canonical', 'oci://registry.example.test/acme/other']) {
      const wrong = {...enrollment, profile: ociProfilePointer(changed, artifact.manifestDigest)};
      expect((yield* Effect.result(readGraphShareEnrolledProfile(cas, wrong)))._tag).toBe('Failure');
    }
  }).pipe(provideTestLayer(BunServices.layer)),
);
