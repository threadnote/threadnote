import {Effect, FileSystem, Path, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  parseGraphShareFrontierManifest,
  parseGraphShareSignatureEnvelope,
  verifyGraphShareFrontier,
  type GraphShareFrontierManifestV1,
  type GraphShareFrontierPointerV1,
} from './artifacts.js';
import {decodeJsonBytes, readBoundedPrivateBytes, writePrivateJsonFile} from './atomic.js';
import {casBlobPath} from './cas.js';
import {parseSha256Digest, sha256Digest, sha256HexFromDigest, SHA256_DIGEST, type Sha256Digest} from './digest.js';
import {graphSharingFailure, graphSharingUnavailable} from './errors.js';
import {graphSharingLayout} from './layout.js';
import {lookupGraphShareTrustReceipt} from './trust.js';

const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const Generation = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000));
const AcceptedFrontier = Schema.Struct({
  authority: Digest,
  envelopeDigest: Digest,
  generation: Generation,
  manifestDigest: Digest,
  publisherFence: Generation,
  schemaVersion: Schema.Literal(1),
});
export type GraphShareAcceptedFrontier = Omit<typeof AcceptedFrontier.Type, 'envelopeDigest' | 'manifestDigest'> &
  GraphShareFrontierPointerV1;

export interface GraphShareFrontierScope {
  readonly branch: string;
  readonly profileDigest: Sha256Digest;
  readonly publisherKeyFingerprint: Sha256Digest;
  readonly repositoryId: string;
}

function authorityDigest(scope: GraphShareFrontierScope): Sha256Digest {
  return sha256Digest(
    JSON.stringify([scope.repositoryId, scope.profileDigest, scope.branch, scope.publisherKeyFingerprint]),
  );
}

export const graphShareAcceptedFrontierPath = Effect.fn('codeGraph.sharing.acceptedFrontierPath')(function* (
  home: string,
  scope: GraphShareFrontierScope,
) {
  const path = yield* Path.Path;
  return path.join(
    graphSharingLayout(path, home).root,
    'accepted-frontiers',
    `${sha256HexFromDigest(authorityDigest(scope))}.json`,
  );
});

export const readAcceptedGraphShareFrontier = Effect.fn('codeGraph.sharing.readAcceptedFrontier')(function* (
  home: string,
  scope: GraphShareFrontierScope,
) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* graphShareAcceptedFrontierPath(home, scope);
  if (!(yield* fs.exists(target))) return undefined;
  const bytes = yield* readBoundedPrivateBytes(target, 4096);
  const text = yield* Effect.try({
    try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes),
    catch: () => graphSharingFailure('Accepted frontier state is invalid.'),
  });
  const state = yield* Schema.decodeEffect(Schema.fromJsonString(AcceptedFrontier), {onExcessProperty: 'error'})(
    text,
  ).pipe(Effect.mapError(() => graphSharingFailure('Accepted frontier state is invalid.')));
  if (state.authority !== authorityDigest(scope))
    return yield* graphSharingFailure('Accepted frontier authority is invalid.');
  const frontier: GraphShareAcceptedFrontier = {
    authority: state.authority,
    envelopeDigest: parseSha256Digest(state.envelopeDigest),
    generation: state.generation,
    manifestDigest: parseSha256Digest(state.manifestDigest),
    publisherFence: state.publisherFence,
    schemaVersion: state.schemaVersion,
  };
  return frontier;
});

export const readAuthenticatedGraphShareFrontier = Effect.fn('codeGraph.sharing.readAuthenticatedFrontier')(function* (
  casRoot: string,
  scope: GraphShareFrontierScope,
  pointer: GraphShareFrontierPointerV1,
) {
  const body = yield* readFrontierJson(casRoot, pointer.manifestDigest);
  const envelopeBody = yield* readFrontierJson(casRoot, pointer.envelopeDigest);
  const manifest = yield* Effect.try({
    try: () => parseGraphShareFrontierManifest(body),
    catch: () => graphSharingFailure('Frontier manifest is invalid.'),
  });
  const envelope = yield* Effect.try({
    try: () => parseGraphShareSignatureEnvelope(envelopeBody),
    catch: () => graphSharingFailure('Frontier signature envelope is invalid.'),
  });
  const signedDigest = yield* verifyGraphShareFrontier(scope.publisherKeyFingerprint, manifest, envelope);
  if (
    signedDigest !== pointer.manifestDigest ||
    manifest.repositoryId !== scope.repositoryId ||
    manifest.profileDigest !== scope.profileDigest ||
    manifest.branch !== scope.branch
  )
    return yield* graphSharingFailure('Frontier does not match the enrolled repository, profile and branch.');
  return manifest;
});

export const acceptGraphShareFrontier = Effect.fn('codeGraph.sharing.acceptFrontier')(function* (input: {
  readonly casRoot: string;
  readonly home: string;
  readonly pointer: GraphShareFrontierPointerV1;
  readonly scope: GraphShareFrontierScope;
  /** A legacy local pointer may lag a newer accepted remote discovery. */
  readonly legacy?: boolean;
}) {
  const manifest = yield* readAuthenticatedGraphShareFrontier(input.casRoot, input.scope, input.pointer);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* graphShareAcceptedFrontierPath(input.home, input.scope);
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  return yield* withExclusiveFileLock(
    fs,
    `${target}.lock`,
    {
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 30_000,
      waitTimeoutMilliseconds: 2_000,
    },
    Effect.gen(function* () {
      const previous = yield* readAcceptedGraphShareFrontier(input.home, input.scope);
      const trust = yield* lookupGraphShareTrustReceipt(input.home, input.scope.repositoryId);
      if (
        trust?.profileDigest !== input.scope.profileDigest ||
        trust.publisherKeyFingerprint !== input.scope.publisherKeyFingerprint
      ) {
        return yield* graphSharingFailure('Frontier trust changed before acceptance.');
      }
      if (previous !== undefined && input.legacy === true && manifest.generation < previous.generation) return previous;
      const candidate: GraphShareAcceptedFrontier = {
        authority: authorityDigest(input.scope),
        envelopeDigest: input.pointer.envelopeDigest,
        generation: manifest.generation,
        manifestDigest: input.pointer.manifestDigest,
        publisherFence: manifest.publisherFence,
        schemaVersion: 1,
      };
      if (previous !== undefined) {
        if (candidate.generation < previous.generation || candidate.publisherFence < previous.publisherFence) {
          return yield* graphSharingFailure(
            'Frontier discovery attempted to roll back an authenticated generation or fence.',
          );
        }
        if (candidate.generation === previous.generation) {
          if (
            candidate.manifestDigest !== previous.manifestDigest ||
            candidate.publisherFence !== previous.publisherFence
          ) {
            return yield* graphSharingFailure('Frontier discovery conflicts with an authenticated generation.');
          }
          return previous;
        }
      }
      yield* writePrivateJsonFile(target, candidate);
      return candidate;
    }),
  );
});

export function assertGraphSharePredecessor(
  current: GraphShareFrontierManifestV1,
  predecessor: GraphShareFrontierManifestV1,
): void {
  if (
    predecessor.repositoryId !== current.repositoryId ||
    predecessor.profileDigest !== current.profileDigest ||
    predecessor.branch !== current.branch ||
    predecessor.generation >= current.generation ||
    predecessor.publisherFence > current.publisherFence
  )
    throw graphSharingFailure('Predecessor frontier does not belong to the authenticated lineage.');
}

const readFrontierJson = Effect.fn('codeGraph.sharing.readFrontierJson')(function* (
  casRoot: string,
  digest: Sha256Digest,
) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* casBlobPath(casRoot, digest);
  if (!(yield* fs.exists(target)))
    return yield* graphSharingUnavailable('Authenticated frontier metadata is unavailable.');
  const bytes = yield* readBoundedPrivateBytes(target, 65_536);
  if (sha256Digest(bytes) !== digest) return yield* graphSharingFailure('Frontier metadata digest is invalid.');
  return yield* decodeJsonBytes(bytes);
});
