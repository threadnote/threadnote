import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Schema} from 'effect';
import {
  GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE,
  GRAPH_SHARE_DELTA_MEDIA_TYPE,
  parseGraphShareFrontierManifest,
  type GraphShareFrontierPointerV1,
} from '../artifacts.js';
import {decodeJsonBytes, readBoundedPrivateBytes} from '../atomic.js';
import {casBlobPath} from '../cas.js';
import {parseGraphShareCheckpointMetadata} from '../checkpoint_cas.js';
import {
  graphShareOciDescriptorCanonicalBytes,
  graphShareOciDescriptorFromLayers,
  GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES,
  GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST,
} from '../descriptor.js';
import {SHA256_DIGEST, sha256Digest} from '../digest.js';
import {GraphSharingError, graphSharingFailure, graphSharingUnavailable} from '../errors.js';
import {
  assertGraphSharePredecessor,
  readAuthenticatedGraphShareFrontier,
  type GraphShareFrontierScope,
} from '../frontier_acceptance.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES, GRAPH_SHARE_REGISTRY_MANIFEST_MAX_BYTES} from '../oci.js';
import {
  GRAPH_SHARE_REGISTRY_CLOSURE_MAX_BLOBS,
  GRAPH_SHARE_REGISTRY_CLOSURE_MAX_BYTES,
  graphShareRegistryRetentionRoot,
} from './retention.js';

export const readGraphShareRegistryPublicationBlob = Effect.fn('codeGraph.sharing.readRegistryPublicationBlob')(
  function* (casRoot: string, digest: string, maximum = GRAPH_SHARE_HTTP_CAS_MAX_BYTES) {
    if (!SHA256_DIGEST.test(digest)) return yield* graphSharingFailure('Registry publication digest is invalid.');
    const target = yield* casBlobPath(casRoot, digest);
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(target))) return yield* graphSharingUnavailable('Registry publication artifact is missing.');
    const bytes = yield* readBoundedPrivateBytes(target, maximum).pipe(
      Effect.mapError(error =>
        Schema.is(GraphSharingError)(error)
          ? error
          : graphSharingUnavailable('Registry publication artifact is unavailable.'),
      ),
    );
    if (sha256Digest(bytes) !== digest)
      return yield* graphSharingFailure('Registry publication artifact digest is invalid.');
    return bytes;
  },
);

export const collectGraphShareRegistryPublication = Effect.fn('codeGraph.sharing.collectRegistryPublication')(
  function* (input: {
    readonly casRoot: string;
    readonly checkpointCount: number;
    readonly pointer: GraphShareFrontierPointerV1;
    readonly scope: GraphShareFrontierScope;
  }) {
    if (!Number.isSafeInteger(input.checkpointCount) || input.checkpointCount < 1 || input.checkpointCount > 32)
      return yield* graphSharingFailure('Registry checkpoint retention limit is invalid.');
    const frontier = yield* readAuthenticatedGraphShareFrontier(input.casRoot, input.scope, input.pointer);
    const entries = new Map<string, number>();
    let totalBytes = 0;
    const include = (digest: string, bytes: Uint8Array) =>
      Effect.gen(function* () {
        const previous = entries.get(digest);
        if (previous !== undefined && previous !== bytes.byteLength)
          return yield* graphSharingFailure('Registry publication artifact changed during collection.');
        if (previous === undefined) {
          totalBytes += bytes.byteLength;
          entries.set(digest, bytes.byteLength);
          if (
            entries.size > GRAPH_SHARE_REGISTRY_CLOSURE_MAX_BLOBS ||
            totalBytes > GRAPH_SHARE_REGISTRY_CLOSURE_MAX_BYTES
          )
            return yield* graphSharingFailure('Registry publication exceeds its retained artifact limits.');
        }
        return bytes;
      });
    const read = (digest: string, maximum = GRAPH_SHARE_HTTP_CAS_MAX_BYTES) =>
      readGraphShareRegistryPublicationBlob(input.casRoot, digest, maximum);
    const includeRead = (digest: string, maximum = GRAPH_SHARE_HTTP_CAS_MAX_BYTES) =>
      read(digest, maximum).pipe(Effect.flatMap(bytes => include(digest, bytes)));
    yield* include(GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST, GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES);
    const envelopeBytes = yield* includeRead(input.pointer.envelopeDigest, 65_536);
    const frontierBytes = yield* read(input.pointer.manifestDigest, 65_536);
    const checkpoints = new Set<string>();
    const verifiedArtifacts = new Set<string>();
    let current = frontier;
    let currentBytes = frontierBytes;
    let currentDigest = input.pointer.manifestDigest;
    let historyFloor = {generation: frontier.generation, sourceCommit: frontier.sourceCommit};
    for (let step = 0; step < 64; step += 1) {
      if (!checkpoints.has(current.checkpoint.manifestDigest) && checkpoints.size >= input.checkpointCount) break;
      checkpoints.add(current.checkpoint.manifestDigest);
      yield* include(currentDigest, currentBytes);
      for (const [artifact, mediaType] of [
        [current.checkpoint, GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE],
        ...EffectArray.map(current.deltas, delta => [delta, GRAPH_SHARE_DELTA_MEDIA_TYPE] as const),
      ] as const) {
        if (artifact.metadataDigest === undefined)
          return yield* graphSharingFailure('Registry publication requires artifact chunk metadata.');
        const identity = `${artifact.manifestDigest}:${artifact.metadataDigest}`;
        if (verifiedArtifacts.has(identity)) continue;
        const metadataJson = yield* decodeJsonBytes(
          yield* includeRead(artifact.metadataDigest, GRAPH_SHARE_REGISTRY_MANIFEST_MAX_BYTES),
        );
        const metadata = yield* Effect.try({
          try: () => parseGraphShareCheckpointMetadata(metadataJson),
          catch: () => graphSharingFailure('Registry publication chunk metadata is invalid.'),
        });
        if (metadata.artifactDigest !== artifact.manifestDigest || metadata.mediaType !== mediaType)
          return yield* graphSharingFailure('Registry publication metadata does not cover its artifact.');
        const hash = new Bun.CryptoHasher('sha256');
        hash.update(yield* includeRead(metadata.prefixDigest));
        for (const chunk of metadata.chunks) hash.update(yield* includeRead(chunk.digest));
        if (`sha256:${hash.digest('hex')}` !== artifact.manifestDigest)
          return yield* graphSharingFailure('Registry publication chunks do not match their complete artifact.');
        verifiedArtifacts.add(identity);
      }
      historyFloor = {generation: current.generation, sourceCommit: current.sourceCommit};
      if (current.previousManifestDigest === null || step === 63) break;
      currentDigest = current.previousManifestDigest;
      currentBytes = yield* read(currentDigest, 65_536);
      const previousJson = yield* decodeJsonBytes(currentBytes);
      const previous = yield* Effect.try({
        try: () => parseGraphShareFrontierManifest(previousJson),
        catch: () => graphSharingFailure('Registry publication predecessor is invalid.'),
      });
      yield* Effect.try({
        try: () => assertGraphSharePredecessor(current, previous),
        catch: () => graphSharingFailure('Registry publication predecessor authority is invalid.'),
      });
      current = previous;
    }
    const metadataBytes = yield* read(frontier.checkpoint.metadataDigest!, GRAPH_SHARE_REGISTRY_MANIFEST_MAX_BYTES);
    const descriptor = yield* Effect.try({
      try: () =>
        graphShareOciDescriptorFromLayers({frontier: frontierBytes, envelope: envelopeBytes, metadata: metadataBytes}),
      catch: () => graphSharingFailure('Registry publication descriptor is invalid.'),
    });
    const descriptorBytes = graphShareOciDescriptorCanonicalBytes(descriptor);
    const descriptorDigest = sha256Digest(descriptorBytes);
    yield* include(descriptorDigest, descriptorBytes);
    const retention = yield* Effect.try({
      try: () => graphShareRegistryRetentionRoot(EffectArray.map([...entries], ([digest, size]) => ({digest, size}))),
      catch: () => graphSharingFailure('Registry publication retention inventory is invalid or exceeds its limits.'),
    });
    return {descriptorBytes, descriptorDigest, frontier, historyFloor, pointer: input.pointer, retention};
  },
);

export type GraphShareRegistryPublication = Effect.Success<ReturnType<typeof collectGraphShareRegistryPublication>>;
