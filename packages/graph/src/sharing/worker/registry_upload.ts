import {Effect} from 'effect';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES} from '../descriptor.js';
import {graphSharingFailure, graphSharingUnavailable} from '../errors.js';
import {graphShareProfileDigest, parseGraphShareProfile, type GraphShareProfileV1} from '../profile.js';
import {makeGraphShareRegistryReader} from '../registry/reader.js';
import {parseGraphShareRegistryTarget} from '../registry/reference.js';
import {makeGraphShareRegistryWriter} from '../registry/writer.js';
import {sha256Digest} from '../digest.js';
import {effectiveGraphShareContributionPolicy} from '../contribution.js';
import {
  readGraphWorkerResultArtifact,
  verifyGraphWorkerResultIntegrity,
  type createGraphWorkerResultArtifact,
  type GraphWorkerResultAuthority,
} from './result.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

type Artifact = Effect.Success<ReturnType<typeof createGraphWorkerResultArtifact>>;
type Writer<E, R> = Pick<
  Effect.Success<ReturnType<typeof makeGraphShareRegistryWriter<E, R>>>,
  'putBlob' | 'putManifest'
>;

const safeAuthorization = <E, R>(isAuthorized: Effect.Effect<boolean, E, R>) =>
  isAuthorized.pipe(Effect.mapError(() => graphSharingUnavailable('Graph worker authorization check failed.')));

export const uploadGraphWorkerArtifactClosure = Effect.fn('codeGraph.sharing.uploadWorkerArtifactClosure')(function* <
  E,
  R,
>(input: {
  readonly artifact: Artifact;
  readonly authority: GraphWorkerResultAuthority;
  readonly isAuthorized: Effect.Effect<boolean, E, R>;
  readonly writer: Writer<E, R>;
}) {
  const artifact = {
    attestationBytes: new Uint8Array(input.artifact.attestationBytes),
    manifestBytes: new Uint8Array(input.artifact.manifestBytes),
    manifestDigest: input.artifact.manifestDigest,
    resultBytes: new Uint8Array(input.artifact.resultBytes),
  };
  const authority = {...input.authority};
  yield* verifyGraphWorkerResultIntegrity({...artifact, expected: authority});
  const isAuthorized = safeAuthorization(input.isAuthorized);
  const guard = Effect.gen(function* () {
    if (!(yield* isAuthorized)) return yield* graphSharingFailure('Graph worker delivery is no longer authorized.');
  });
  for (const bytes of [GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES, artifact.resultBytes, artifact.attestationBytes]) {
    yield* guard;
    yield* input.writer.putBlob(sha256Digest(bytes), bytes);
  }
  yield* guard;
  const committed = yield* input.writer.putManifest(artifact.manifestDigest, artifact.manifestBytes);
  if (committed !== artifact.manifestDigest)
    return yield* graphSharingFailure('Graph worker registry manifest acknowledgement is invalid.');
  yield* guard;
  return {manifestDigest: artifact.manifestDigest};
});

export const uploadGraphWorkerArtifactToRegistry = Effect.fn('codeGraph.sharing.uploadWorkerArtifactToRegistry')(
  function* <E, R>(input: {
    readonly artifact: Artifact;
    readonly authority: GraphWorkerResultAuthority;
    readonly isAuthorized: Effect.Effect<boolean, E, R>;
    readonly profile: GraphShareProfileV1;
  }) {
    const authority = {...input.authority};
    const isAuthorized = safeAuthorization(input.isAuthorized);
    if (
      effectiveGraphShareContributionPolicy('join', 'passive', input.profile.contribution.maximumUploadBytesPerSecond)
        .deliveryPausedReason === 'organization-upload-disabled'
    )
      return yield* graphSharingFailure('Organization profile disables graph contribution uploads.');
    const workerRegistry = yield* Effect.try({
      try: () => graphWorkerRegistryForProfile(input.profile, authority),
      catch: cause => graphSharingFailure('Graph worker registry is outside its enrolled scope.', cause),
    });
    const writer = yield* makeGraphShareRegistryWriter(workerRegistry, isAuthorized);
    const sent = yield* uploadGraphWorkerArtifactClosure({...input, authority, isAuthorized, writer});
    const reader = yield* makeGraphShareRegistryReader(workerRegistry, isAuthorized);
    yield* readGraphWorkerResultArtifact(reader, sent.manifestDigest, authority);
    if (!(yield* isAuthorized)) return yield* graphSharingFailure('Graph worker delivery is no longer authorized.');
    return sent;
  },
);

export function graphWorkerRegistryForProfile(
  profileInput: GraphShareProfileV1,
  authority: Pick<GraphWorkerResultAuthority, 'profileDigest' | 'repositoryId'>,
): string {
  const profile = parseGraphShareProfile(profileInput);
  const workerRegistry = profile.registry.worker;
  const canonicalRegistry = profile.registry.canonical;
  if (
    !Effect2.pipe(workerRegistry, EffectString.startsWith('oci://')) ||
    profile.repositoryId !== authority.repositoryId ||
    graphShareProfileDigest(profile) !== authority.profileDigest
  )
    throw graphSharingFailure('Graph worker registry is outside its enrolled scope.');
  const workerTarget = parseGraphShareRegistryTarget(workerRegistry);
  if (Effect2.pipe(canonicalRegistry, EffectString.startsWith('oci://'))) {
    const canonicalTarget = parseGraphShareRegistryTarget(canonicalRegistry);
    if (workerTarget.origin === canonicalTarget.origin && workerTarget.repository === canonicalTarget.repository)
      throw graphSharingFailure('Graph worker registry overlaps the canonical namespace.');
  }
  return workerRegistry;
}
