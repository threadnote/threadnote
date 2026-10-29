import {Effect} from 'effect';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES, GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST} from '../descriptor.js';
import {graphSharingFailure} from '../errors.js';
import {graphShareProfileOciArtifact, parseGraphShareProfileOciArtifact} from './oci_artifact.js';
import type {GraphShareProfileV1} from '../profile.js';
import type {makeGraphShareRegistryReader} from '../registry/reader.js';
import type {makeGraphShareRegistryWriter} from '../registry/writer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type Writer = Pick<
  Effect.Success<ReturnType<typeof makeGraphShareRegistryWriter<never, never>>>,
  'headManifest' | 'putBlob' | 'putManifest'
>;
type Reader = Pick<
  Effect.Success<ReturnType<typeof makeGraphShareRegistryReader<never, never>>>,
  'readBlob' | 'readProfileManifest'
>;

export const publishGraphShareProfileArtifact = Effect.fn('codeGraph.sharing.publishProfileArtifact')(function* (
  profile: GraphShareProfileV1,
  writer: Writer,
  reader: Reader,
) {
  const artifact = yield* Effect.try({
    try: () => graphShareProfileOciArtifact(profile),
    catch: () => graphSharingFailure('Publisher profile cannot be encoded as an OCI artifact.'),
  });
  const tag = `tn-profile-${Effect2.pipe(artifact.manifestDigest, EffectString.slice('sha256:'.length))}`;
  const existing = yield* writer.headManifest(tag);
  if (existing !== undefined && existing !== artifact.manifestDigest)
    return yield* graphSharingFailure('Registry profile retention tag conflicts with its pinned manifest.');
  yield* writer.putBlob(GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST, GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES);
  yield* writer.putBlob(artifact.profileDigest, artifact.profileBytes);
  yield* writer.putManifest(artifact.manifestDigest, artifact.manifestBytes);
  if (existing === undefined) yield* writer.putManifest(tag, artifact.manifestBytes);
  if ((yield* writer.headManifest(tag)) !== artifact.manifestDigest)
    return yield* graphSharingFailure('Registry profile retention tag does not resolve to its pinned manifest.');
  const remoteManifest = yield* reader.readProfileManifest(artifact.manifestDigest);
  const remoteProfile = yield* reader.readBlob(artifact.profileDigest, artifact.profileBytes.byteLength);
  yield* Effect.try({
    try: () => parseGraphShareProfileOciArtifact(remoteManifest, artifact.manifestDigest, remoteProfile),
    catch: () => graphSharingFailure('Published OCI profile artifact failed remote verification.'),
  });
  return artifact;
});
