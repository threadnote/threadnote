import {Clock, Effect, Schema} from 'effect';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {sha256Digest, SHA256_DIGEST, SHA256_HEX} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {verifyGraphWorkerSignature, type makeGraphWorkerSigner} from './signing.js';
import {
  verifyGraphWorkerResultIntegrity,
  type createGraphWorkerResultArtifact,
  type GraphWorkerResultAuthority,
  type GraphWorkerResultVerificationAuthority,
} from './result.js';

const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const Hex = Schema.String.check(Schema.isPattern(SHA256_HEX));
const Body = Schema.Struct({
  actionKey: Hex,
  attestationDigest: Digest,
  batchId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  idempotencyKey: Digest,
  principalId: Digest,
  profileDigest: Digest,
  repositoryId: Hex,
  resultManifestDigest: Digest,
  semanticDigest: Digest,
  workerId: Schema.String.check(Schema.isPattern(/^gw_[0-9a-f]{32}$/u)),
});
const Announcement = Schema.Struct({
  algorithm: Schema.Literal('ed25519'),
  body: Body,
  publicKey: Hex,
  schemaVersion: Schema.Literal(1),
  signature: Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/u)),
});
const STRICT = {onExcessProperty: 'error'} as const;
const failure = () => graphSharingFailure('Graph worker result announcement is invalid or outside its authority.');
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
export type GraphWorkerResultAnnouncement = typeof Announcement.Type;
export type GraphWorkerResultAnnouncementBody = typeof Body.Type;

export const decodeGraphWorkerResultAnnouncement = (value: unknown) =>
  Schema.decodeUnknownEffect(Announcement, STRICT)(value).pipe(Effect.mapError(failure));

export const signGraphWorkerResultAnnouncement = Effect.fn('codeGraph.sharing.signWorkerResultAnnouncement')(
  function* (input: {
    readonly artifact: Effect.Success<ReturnType<typeof createGraphWorkerResultArtifact>>;
    readonly expected: GraphWorkerResultAuthority;
    readonly signer: Effect.Success<ReturnType<typeof makeGraphWorkerSigner>>;
  }) {
    const expected = {...input.expected};
    if (input.signer.publicKey !== expected.signingPublicKey) return yield* failure();
    const verified = yield* verifyGraphWorkerResultIntegrity({...input.artifact, expected});
    const {claims} = verified.attestation;
    const fields = {
      actionKey: claims.actionKey,
      attestationDigest: verified.attestationDigest,
      batchId: claims.batchId,
      principalId: claims.principalId,
      profileDigest: claims.profileDigest,
      repositoryId: claims.repositoryId,
      resultManifestDigest: verified.manifestDigest,
      semanticDigest: claims.semanticDigest,
      workerId: claims.workerId,
    };
    const body = {...fields, idempotencyKey: operationId(fields)};
    const signature = yield* input.signer.sign('announcement', encode(body));
    if (expected.expiresAt <= (yield* Clock.currentTimeMillis) / 1000) return yield* failure();
    return {
      algorithm: 'ed25519' as const,
      body,
      publicKey: expected.signingPublicKey,
      schemaVersion: 1 as const,
      signature,
    };
  },
);

export const verifyGraphWorkerResultAnnouncement = Effect.fn('codeGraph.sharing.verifyWorkerResultAnnouncement')(
  function* (value: unknown, authority: GraphWorkerResultVerificationAuthority) {
    const expected = {...authority};
    const signed = yield* Schema.decodeUnknownEffect(Announcement, STRICT)(value).pipe(Effect.mapError(failure));
    const {idempotencyKey, ...fields} = signed.body;
    if (
      !Number.isFinite(expected.expiresAt) ||
      expected.expiresAt <= (yield* Clock.currentTimeMillis) / 1000 ||
      signed.publicKey !== expected.signingPublicKey ||
      fields.workerId !== expected.workerId ||
      fields.principalId !== expected.principalId ||
      fields.repositoryId !== expected.repositoryId ||
      fields.profileDigest !== expected.profileDigest ||
      idempotencyKey !== operationId(fields)
    )
      return yield* failure();
    yield* verifyGraphWorkerSignature(expected.signingPublicKey, 'announcement', encode(signed.body), signed.signature);
    if (expected.expiresAt <= (yield* Clock.currentTimeMillis) / 1000) return yield* failure();
    return signed.body;
  },
);

function operationId(body: Omit<GraphWorkerResultAnnouncementBody, 'idempotencyKey'>): string {
  return sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(body));
}
