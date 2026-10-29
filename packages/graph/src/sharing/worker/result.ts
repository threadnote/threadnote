import {Clock, Effect, Schema} from 'effect';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {graphShareParseActionKey} from '../action.js';
import {
  GRAPH_SHARE_ATTESTATION_MEDIA_TYPE,
  GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE,
  GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  GRAPH_SHARE_PARSE_RESULT_MEDIA_TYPE,
} from '../artifacts.js';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST} from '../descriptor.js';
import {sha256Digest, SHA256_DIGEST, SHA256_HEX} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from '../oci.js';
import {parseGraphShareParseResult} from '../parse/result.js';
import {verifyGraphWorkerSignature, type makeGraphWorkerSigner} from './signing.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const Hex = Schema.String.check(Schema.isPattern(SHA256_HEX));
const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const Claims = Schema.Struct({
  actionKey: Hex,
  batchId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  graphAbi: Hex,
  identityClass: Schema.Literal('oauth-principal'),
  issuedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  partialCoverage: Schema.Boolean,
  platform: Schema.Struct({
    os: Schema.Literals(['darwin', 'linux', 'win32']),
    architecture: Schema.Literals(['arm64', 'x64']),
  }),
  principalId: Digest,
  profileDigest: Digest,
  releaseIdentity: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u)),
  repositoryId: Hex,
  resourceLimits: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u))).check(
    Schema.isMaxLength(8),
  ),
  resultDigest: Digest,
  resultSize: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(GRAPH_SHARE_HTTP_CAS_MAX_BYTES)),
  semanticDigest: Digest,
  sourceCommit: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)),
  workerId: Schema.String.check(Schema.isPattern(/^gw_[0-9a-f]{32}$/u)),
});
const Attestation = Schema.Struct({
  algorithm: Schema.Literal('ed25519'),
  claims: Claims,
  publicKey: Hex,
  schemaVersion: Schema.Literal(1),
  signature: Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/u)),
});
const Entry = Schema.Struct({
  digest: Digest,
  mediaType: Schema.Literals([GRAPH_SHARE_PARSE_RESULT_MEDIA_TYPE, GRAPH_SHARE_ATTESTATION_MEDIA_TYPE]),
  size: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(GRAPH_SHARE_HTTP_CAS_MAX_BYTES)),
});
const Manifest = Schema.Struct({
  artifactType: Schema.Literal(GRAPH_SHARE_PARSE_RESULT_MEDIA_TYPE),
  config: Schema.Struct({
    digest: Schema.Literal(GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST),
    mediaType: Schema.Literal(GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE),
    size: Schema.Literal(2),
  }),
  layers: Schema.Array(Entry).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  mediaType: Schema.Literal(GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE),
  schemaVersion: Schema.Literal(2),
});
const STRICT = {onExcessProperty: 'error'} as const;
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
const failure = () => graphSharingFailure('Graph worker result integrity or authority is invalid.');

export type GraphWorkerResultMetadata = Omit<
  typeof Claims.Type,
  'actionKey' | 'resultDigest' | 'resultSize' | 'semanticDigest'
>;
export interface GraphWorkerResultAuthority {
  readonly expiresAt: number;
  readonly graphAbi: string;
  readonly principalId: string;
  readonly profileDigest: string;
  readonly repositoryId: string;
  readonly signingPublicKey: string;
  readonly workerId: string;
}

export type GraphWorkerResultVerificationAuthority = Omit<GraphWorkerResultAuthority, 'graphAbi'> & {
  readonly graphAbi?: string;
};

export const createGraphWorkerResultArtifact = Effect.fn('codeGraph.sharing.createWorkerResult')(function* (input: {
  readonly metadata: GraphWorkerResultMetadata;
  readonly resultBytes: Uint8Array;
  readonly signer: Effect.Success<ReturnType<typeof makeGraphWorkerSigner>>;
}) {
  if (input.resultBytes.byteLength > GRAPH_SHARE_HTTP_CAS_MAX_BYTES) return yield* failure();
  const resultBytes = new Uint8Array(input.resultBytes);
  const parsed = yield* parseResult(resultBytes);
  const claims = yield* Schema.decodeEffect(
    Claims,
    STRICT,
  )({
    ...input.metadata,
    actionKey: parsed.actionKey,
    resultDigest: sha256Digest(resultBytes),
    resultSize: resultBytes.byteLength,
    semanticDigest: parsed.semanticDigest,
  }).pipe(Effect.mapError(failure));
  if (
    claims.repositoryId !== parsed.repositoryId ||
    claims.batchId !== Effect2.pipe(claims.sourceCommit, EffectString.slice(0, 40))
  )
    return yield* failure();
  const attestationBytes = encode({
    algorithm: 'ed25519',
    claims,
    publicKey: input.signer.publicKey,
    schemaVersion: 1,
    signature: yield* input.signer.sign('attestation', encode(claims)),
  });
  const manifestBytes = encode({
    artifactType: GRAPH_SHARE_PARSE_RESULT_MEDIA_TYPE,
    config: {digest: GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST, mediaType: GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE, size: 2},
    layers: [
      {digest: claims.resultDigest, mediaType: GRAPH_SHARE_PARSE_RESULT_MEDIA_TYPE, size: resultBytes.byteLength},
      {
        digest: sha256Digest(attestationBytes),
        mediaType: GRAPH_SHARE_ATTESTATION_MEDIA_TYPE,
        size: attestationBytes.byteLength,
      },
    ],
    mediaType: GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    schemaVersion: 2,
  });
  return {attestationBytes, manifestBytes, manifestDigest: sha256Digest(manifestBytes), resultBytes};
});

export const verifyGraphWorkerResultIntegrity = Effect.fn('codeGraph.sharing.verifyWorkerResultIntegrity')(
  function* (input: {
    readonly attestationBytes: Uint8Array;
    readonly expected: GraphWorkerResultVerificationAuthority;
    readonly manifestBytes: Uint8Array;
    readonly manifestDigest: string;
    readonly resultBytes: Uint8Array;
  }) {
    if (
      input.manifestBytes.byteLength > 8192 ||
      input.attestationBytes.byteLength > 65_536 ||
      input.resultBytes.byteLength > GRAPH_SHARE_HTTP_CAS_MAX_BYTES
    )
      return yield* failure();
    const manifestBytes = new Uint8Array(input.manifestBytes);
    const resultBytes = new Uint8Array(input.resultBytes);
    const attestationBytes = new Uint8Array(input.attestationBytes);
    const expected = {...input.expected};
    const manifestDigest = input.manifestDigest;
    const manifest = yield* parseGraphWorkerResultManifest(manifestBytes, manifestDigest);
    const [result, attested] = manifest.layers;
    if (
      result.mediaType !== GRAPH_SHARE_PARSE_RESULT_MEDIA_TYPE ||
      attested.mediaType !== GRAPH_SHARE_ATTESTATION_MEDIA_TYPE ||
      result.size !== resultBytes.byteLength ||
      attested.size !== attestationBytes.byteLength ||
      result.digest !== sha256Digest(resultBytes) ||
      attested.digest !== sha256Digest(attestationBytes)
    )
      return yield* failure();
    const attestation = yield* Schema.decodeUnknownEffect(
      Attestation,
      STRICT,
    )(yield* json(attestationBytes, 65_536)).pipe(Effect.mapError(failure));
    if (sha256Digest(encode(attestation)) !== attested.digest) return yield* failure();
    const {claims} = attestation;
    const now = (yield* Clock.currentTimeMillis) / 1000;
    if (
      !Number.isFinite(expected.expiresAt) ||
      expected.expiresAt <= now ||
      claims.issuedAt >= expected.expiresAt ||
      claims.issuedAt > now + 120 ||
      claims.principalId !== expected.principalId ||
      claims.profileDigest !== expected.profileDigest ||
      claims.repositoryId !== expected.repositoryId ||
      claims.workerId !== expected.workerId ||
      (expected.graphAbi !== undefined && claims.graphAbi !== expected.graphAbi) ||
      attestation.publicKey !== expected.signingPublicKey ||
      claims.resultDigest !== result.digest ||
      claims.resultSize !== result.size ||
      claims.batchId !== Effect2.pipe(claims.sourceCommit, EffectString.slice(0, 40))
    )
      return yield* failure();
    yield* verifyGraphWorkerSignature(expected.signingPublicKey, 'attestation', encode(claims), attestation.signature);
    const parsed = yield* parseResult(resultBytes);
    if (
      parsed.repositoryId !== expected.repositoryId ||
      parsed.actionKey !== claims.actionKey ||
      parsed.semanticDigest !== claims.semanticDigest
    )
      return yield* failure();
    if (expected.expiresAt <= (yield* Clock.currentTimeMillis) / 1000) return yield* failure();
    return {parsed, attestation, manifestDigest, attestationDigest: attested.digest};
  },
);

export const parseGraphWorkerResultManifest = Effect.fn('codeGraph.sharing.parseWorkerResultManifest')(function* (
  bytes: Uint8Array,
  digest: string,
) {
  const manifest = yield* Schema.decodeUnknownEffect(
    Manifest,
    STRICT,
  )(yield* json(bytes, 8192)).pipe(Effect.mapError(failure));
  if (
    sha256Digest(bytes) !== digest ||
    sha256Digest(encode(manifest)) !== digest ||
    manifest.layers[0].mediaType !== GRAPH_SHARE_PARSE_RESULT_MEDIA_TYPE ||
    manifest.layers[1].mediaType !== GRAPH_SHARE_ATTESTATION_MEDIA_TYPE ||
    manifest.layers[1].size > 65_536
  )
    return yield* failure();
  return manifest;
});

export const readGraphWorkerResultArtifact = Effect.fn('codeGraph.sharing.readWorkerResultArtifact')(function* <E, R>(
  reader: {
    readonly readWorkerManifest: (digest: string) => Effect.Effect<Uint8Array, E, R>;
    readonly readBlob: (digest: string, size?: number) => Effect.Effect<Uint8Array, E, R>;
  },
  manifestDigest: string,
  expected: GraphWorkerResultVerificationAuthority,
) {
  const authority = {...expected};
  const manifestBytes = yield* reader.readWorkerManifest(manifestDigest);
  const manifest = yield* parseGraphWorkerResultManifest(manifestBytes, manifestDigest);
  const blobs = yield* Effect.forEach(
    [manifest.config, ...manifest.layers],
    entry => reader.readBlob(entry.digest, entry.size),
    {concurrency: 2},
  );
  if (blobs[0].byteLength !== 2 || sha256Digest(blobs[0]) !== GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST)
    return yield* failure();
  return yield* verifyGraphWorkerResultIntegrity({
    manifestBytes,
    manifestDigest,
    resultBytes: blobs[1],
    attestationBytes: blobs[2],
    expected: authority,
  });
});

const parseResult = Effect.fn('codeGraph.sharing.parseWorkerResult')(function* (bytes: Uint8Array) {
  const value = yield* json(bytes, GRAPH_SHARE_HTTP_CAS_MAX_BYTES);
  const parsed = yield* Effect.try({try: () => parseGraphShareParseResult(value), catch: failure});
  if (parsed.actionKey !== graphShareParseActionKey(parsed) || sha256Digest(encode(parsed)) !== sha256Digest(bytes))
    return yield* failure();
  return parsed;
});

const json = Effect.fn('codeGraph.sharing.workerResultJson')(function* (bytes: Uint8Array, maximum: number) {
  if (bytes.byteLength > maximum) return yield* failure();
  return yield* Effect.try({
    try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown,
    catch: failure,
  });
});
