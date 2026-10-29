import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {readBoundedPrivateBytes, writePrivateJsonFile} from '../atomic.js';
import {sha256Digest, sha256HexFromDigest, SHA256_DIGEST, type Sha256Digest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import type {GraphShareFrontierScope} from '../frontier_acceptance.js';
import {graphSharingLayout} from '../layout.js';
import {parseGraphShareRegistryTarget} from './reference.js';

const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const Generation = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000));
const Timestamp = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Commit = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u));
const Candidate = Schema.Struct({
  descriptorDigest: Digest,
  envelopeDigest: Digest,
  generation: Generation,
  historyFloor: Schema.Struct({generation: Generation, sourceCommit: Commit}),
  manifestDigest: Digest,
  publisherFence: Generation,
  retentionDigest: Digest,
  sourceCommit: Commit,
});
const Receipt = Schema.Struct({
  acknowledged: Schema.optionalKey(Candidate),
  authority: Digest,
  failures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(7)),
  lastFailure: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literals(['unavailable', 'verification-failed']),
      message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
      httpStatus: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(599)),
      ),
    }),
  ),
  nextAttempt: Timestamp,
  pending: Schema.optionalKey(Candidate),
  verifiedAt: Timestamp,
  schemaVersion: Schema.Literal(1),
});
export type GraphSharePublicationCandidate = typeof Candidate.Type;
export type GraphSharePublicationReceipt = typeof Receipt.Type;

export function graphSharePublicationAuthority(scope: GraphShareFrontierScope, canonical: string): Sha256Digest {
  const target = parseGraphShareRegistryTarget(canonical);
  return sha256Digest(
    JSON.stringify([
      scope.repositoryId,
      scope.profileDigest,
      scope.branch,
      scope.publisherKeyFingerprint,
      target.origin,
      target.repository,
    ]),
  );
}

export function assertGraphSharePublicationProgress(
  previous: GraphSharePublicationCandidate,
  next: GraphSharePublicationCandidate,
): void {
  if (next.generation < previous.generation || next.publisherFence < previous.publisherFence)
    throw graphSharingFailure('Registry publication would roll back an acknowledged generation or fence.');
  if (
    next.generation === previous.generation &&
    (next.manifestDigest !== previous.manifestDigest ||
      next.envelopeDigest !== previous.envelopeDigest ||
      next.descriptorDigest !== previous.descriptorDigest ||
      next.publisherFence !== previous.publisherFence ||
      next.retentionDigest !== previous.retentionDigest ||
      next.sourceCommit !== previous.sourceCommit ||
      next.historyFloor.generation !== previous.historyFloor.generation ||
      next.historyFloor.sourceCommit !== previous.historyFloor.sourceCommit)
  )
    throw graphSharingFailure('Registry publication conflicts with a recorded generation.');
}

export const graphSharePublicationReceiptPath = Effect.fn('codeGraph.sharing.publicationReceiptPath')(function* (
  home: string,
  authority: Sha256Digest,
) {
  const path = yield* Path.Path;
  return path.join(graphSharingLayout(path, home).root, 'publications', `${sha256HexFromDigest(authority)}.json`);
});

export const readGraphSharePublicationReceipt = Effect.fn('codeGraph.sharing.readPublicationReceipt')(function* (
  home: string,
  authority: Sha256Digest,
) {
  const target = yield* graphSharePublicationReceiptPath(home, authority);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(target))) {
    const initial: GraphSharePublicationReceipt = {
      authority,
      failures: 0,
      nextAttempt: 0,
      verifiedAt: 0,
      schemaVersion: 1,
    };
    return initial;
  }
  const bytes = yield* readBoundedPrivateBytes(target, 65_536);
  const receipt = yield* Schema.decodeEffect(Schema.fromJsonString(Receipt), {onExcessProperty: 'error'})(
    new TextDecoder().decode(bytes),
  ).pipe(Effect.mapError(() => graphSharingFailure('Registry publication receipt is invalid.')));
  yield* validateReceipt(receipt, authority);
  return receipt;
});

export const writeGraphSharePublicationReceipt = Effect.fn('codeGraph.sharing.writePublicationReceipt')(function* (
  home: string,
  authority: Sha256Digest,
  receipt: GraphSharePublicationReceipt,
) {
  const checked = yield* Schema.decodeEffect(Receipt, {onExcessProperty: 'error'})(receipt).pipe(
    Effect.mapError(() => graphSharingFailure('Registry publication receipt is invalid.')),
  );
  yield* validateReceipt(checked, authority);
  yield* writePrivateJsonFile(yield* graphSharePublicationReceiptPath(home, authority), checked);
});

function validateReceipt(receipt: GraphSharePublicationReceipt, authority: Sha256Digest) {
  return Effect.try({
    try: () => {
      if (
        receipt.authority !== authority ||
        EffectArray.some(
          [receipt.pending, receipt.acknowledged],
          item => item !== undefined && item.historyFloor.generation > item.generation,
        )
      )
        throw graphSharingFailure('Registry publication receipt authority or history floor is invalid.');
      if (receipt.acknowledged !== undefined && receipt.pending !== undefined)
        assertGraphSharePublicationProgress(receipt.acknowledged, receipt.pending);
    },
    catch: () => graphSharingFailure('Registry publication receipt is inconsistent.'),
  });
}
