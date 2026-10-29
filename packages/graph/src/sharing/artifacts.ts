import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {graphSharingFailure} from './errors.js';
import {parseSha256Digest, sha256Digest, SHA256_HEX, type Sha256Digest} from './digest.js';
import {validateGraphShareFrontierDeltaChain} from './delta.js';
import {isGraphShareGitObjectId} from './git.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export const GRAPH_SHARE_FRONTIER_SCHEMA_VERSION = 1 as const;
export const GRAPH_SHARE_SIGNATURE_ALGORITHM = 'ed25519' as const;

export const GRAPH_SHARE_PROFILE_MEDIA_TYPE = 'application/vnd.threadnote.graph.profile.v1+json';
export const GRAPH_SHARE_FRONTIER_MEDIA_TYPE = 'application/vnd.threadnote.graph.frontier.v1+json';
export const GRAPH_SHARE_ATTESTATION_MEDIA_TYPE = 'application/vnd.threadnote.graph.attestation.v1+json';
export const GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE = 'application/vnd.threadnote.graph.checkpoint.v1+json';
export const GRAPH_SHARE_TCG1_MEDIA_TYPE = 'application/vnd.threadnote.code-graph-checkpoint.v1';
export const GRAPH_SHARE_DELTA_MEDIA_TYPE = 'application/vnd.threadnote.graph.delta.v1+json';
export const GRAPH_SHARE_RECORDS_MEDIA_TYPE = 'application/vnd.threadnote.graph.records.v1+gzip';
export const GRAPH_SHARE_PARSE_RESULT_MEDIA_TYPE = 'application/vnd.threadnote.graph.parse-result.v1+json';
export const GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
export const GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json';

export interface GraphShareFrontierCheckpointV1 {
  readonly manifestDigest: Sha256Digest;
  readonly metadataDigest?: Sha256Digest;
  readonly snapshotId: string;
  readonly sourceCommit: string;
}

export interface GraphShareFrontierDeltaV1 {
  readonly baseSnapshotId: string;
  readonly manifestDigest: Sha256Digest;
  readonly metadataDigest?: Sha256Digest;
  readonly targetCommit: string;
  readonly targetSnapshotId: string;
}

export interface GraphShareFrontierManifestV1 {
  readonly branch: string;
  readonly checkpoint: GraphShareFrontierCheckpointV1;
  readonly deltas: readonly GraphShareFrontierDeltaV1[];
  readonly generation: number;
  readonly graphAbi: string;
  readonly graphContentId: string;
  readonly logicalGraphDigest: Sha256Digest;
  readonly previousManifestDigest: Sha256Digest | null;
  readonly profileDigest: Sha256Digest;
  readonly publisherFence: number;
  readonly repositoryId: string;
  readonly schemaVersion: typeof GRAPH_SHARE_FRONTIER_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly sourceCommit: string;
}

export interface GraphShareSignatureEnvelopeV1 {
  readonly algorithm: typeof GRAPH_SHARE_SIGNATURE_ALGORITHM;
  readonly payloadDigest: Sha256Digest;
  readonly publicKey: string;
  readonly publicKeyFingerprint: Sha256Digest;
  readonly schemaVersion: 1;
  readonly signature: string;
}

export interface GraphSharePublisherKeyV1 {
  readonly fingerprint: Sha256Digest;
  readonly privateKey: string;
  readonly publicKey: string;
  readonly schemaVersion: 1;
}

export interface GraphShareFrontierPointerV1 {
  readonly envelopeDigest: Sha256Digest;
  readonly manifestDigest: Sha256Digest;
  readonly schemaVersion: 1;
}

const ED25519 = {name: 'Ed25519'} as const;

export function graphShareFrontierCanonicalBytes(manifest: GraphShareFrontierManifestV1): Uint8Array {
  return new TextEncoder().encode(canonicalJson(manifest));
}

export function graphShareFrontierDigest(manifest: GraphShareFrontierManifestV1): Sha256Digest {
  return sha256Digest(graphShareFrontierCanonicalBytes(manifest));
}

export const generateGraphSharePublisherKey = Effect.fn('codeGraph.sharing.generatePublisherKey')(function* () {
  const pair = yield* fromPromiseInterruptible(
    () => crypto.subtle.generateKey(ED25519, true, ['sign', 'verify']),
    cause => graphSharingFailure('Failed to generate a graph publisher key.', cause),
  );
  const publicKey = yield* exportKeyBytes(pair.publicKey, 'raw');
  const privateKey = yield* exportKeyBytes(pair.privateKey, 'pkcs8');
  const publicHex = bytesToHex(publicKey);
  return {
    fingerprint: sha256Digest(publicKey),
    privateKey: bytesToHex(privateKey),
    publicKey: publicHex,
    schemaVersion: 1 as const,
  } satisfies GraphSharePublisherKeyV1;
});

export const signGraphShareFrontier = Effect.fn('codeGraph.sharing.signFrontier')(function* (
  key: GraphSharePublisherKeyV1,
  manifest: GraphShareFrontierManifestV1,
) {
  const payload = graphShareFrontierCanonicalBytes(manifest);
  const payloadDigest = sha256Digest(payload);
  const privateKey = yield* importPrivateKey(key.privateKey);
  const signature = yield* fromPromiseInterruptible(
    () => crypto.subtle.sign(ED25519, privateKey, asBufferSource(payload)),
    cause => graphSharingFailure('Failed to sign the graph frontier.', cause),
  );
  const envelope: GraphShareSignatureEnvelopeV1 = {
    algorithm: GRAPH_SHARE_SIGNATURE_ALGORITHM,
    payloadDigest,
    publicKey: key.publicKey,
    publicKeyFingerprint: key.fingerprint,
    schemaVersion: 1,
    signature: bytesToHex(new Uint8Array(signature)),
  };
  return {envelope, manifest, payloadDigest};
});

export const verifyGraphShareFrontier = Effect.fn('codeGraph.sharing.verifyFrontier')(function* (
  expectedFingerprint: Sha256Digest,
  manifest: GraphShareFrontierManifestV1,
  envelope: GraphShareSignatureEnvelopeV1,
) {
  if (envelope.algorithm !== GRAPH_SHARE_SIGNATURE_ALGORITHM || envelope.schemaVersion !== 1) {
    return yield* graphSharingFailure('Frontier signature algorithm is not supported.');
  }
  if (!SHA256_HEX.test(envelope.publicKey) || !/^[0-9a-f]{128}$/u.test(envelope.signature)) {
    return yield* graphSharingFailure('Frontier signature encoding is invalid.');
  }
  const publicKeyBytes = hexToBytes(envelope.publicKey);
  const fingerprint = sha256Digest(publicKeyBytes);
  if (fingerprint !== envelope.publicKeyFingerprint || fingerprint !== expectedFingerprint) {
    return yield* graphSharingFailure('Frontier publisher key fingerprint does not match enrollment.');
  }
  const payload = graphShareFrontierCanonicalBytes(manifest);
  const payloadDigest = sha256Digest(payload);
  if (payloadDigest !== envelope.payloadDigest) {
    return yield* graphSharingFailure('Frontier signature does not cover the canonical manifest.');
  }
  const publicKey = yield* fromPromiseInterruptible(
    () => crypto.subtle.importKey('raw', asBufferSource(publicKeyBytes), ED25519, true, ['verify']),
    cause => graphSharingFailure('Frontier publisher public key is invalid.', cause),
  );
  const accepted = yield* fromPromiseInterruptible(
    () =>
      crypto.subtle.verify(ED25519, publicKey, asBufferSource(hexToBytes(envelope.signature)), asBufferSource(payload)),
    cause => graphSharingFailure('Frontier signature verification failed.', cause),
  );
  if (!accepted) return yield* graphSharingFailure('Frontier publisher signature is invalid.');
  return payloadDigest;
});

export function parseGraphShareFrontierManifest(value: unknown): GraphShareFrontierManifestV1 {
  if (!isRecord(value)) throw graphSharingFailure('Frontier manifest is invalid.');
  if (value.schemaVersion !== GRAPH_SHARE_FRONTIER_SCHEMA_VERSION) {
    throw graphSharingFailure('Frontier manifest schemaVersion is not supported.');
  }
  const generation = requiredGeneration(value.generation);
  const previousManifestDigest = parsePreviousManifestDigest(value.previousManifestDigest, generation);
  if (!EffectArray.isArray(value.deltas) || value.deltas.length > 64) {
    throw graphSharingFailure('Frontier delta list is invalid.');
  }
  const checkpoint = parseCheckpoint(value.checkpoint);
  const manifest: GraphShareFrontierManifestV1 = {
    branch: requiredText(value.branch, 'branch'),
    checkpoint,
    deltas: EffectArray.map(value.deltas, parseDelta),
    generation,
    graphAbi: requiredText(value.graphAbi, 'graphAbi'),
    graphContentId: requiredText(value.graphContentId, 'graphContentId'),
    logicalGraphDigest: parseSha256Digest(requiredText(value.logicalGraphDigest, 'logicalGraphDigest')),
    previousManifestDigest,
    profileDigest: parseSha256Digest(requiredText(value.profileDigest, 'profileDigest')),
    publisherFence: requiredFence(value.publisherFence),
    repositoryId: requiredHex(value.repositoryId, 'repositoryId'),
    schemaVersion: GRAPH_SHARE_FRONTIER_SCHEMA_VERSION,
    snapshotId: requiredText(value.snapshotId, 'snapshotId'),
    sourceCommit: requiredGitObjectId(value.sourceCommit, 'sourceCommit'),
  };
  validateGraphShareFrontierDeltaChain(manifest);
  if (JSON.stringify(EffectRecord.keys(value).sort()) !== JSON.stringify(EffectRecord.keys(manifest).sort())) {
    throw graphSharingFailure('Frontier manifest contains unsupported fields.');
  }
  return manifest;
}

export function parseGraphShareSignatureEnvelope(value: unknown): GraphShareSignatureEnvelopeV1 {
  if (!isRecord(value)) throw graphSharingFailure('Frontier signature envelope is invalid.');
  const envelope: GraphShareSignatureEnvelopeV1 = {
    algorithm: GRAPH_SHARE_SIGNATURE_ALGORITHM,
    payloadDigest: parseSha256Digest(requiredText(value.payloadDigest, 'payloadDigest')),
    publicKey: requiredHex(value.publicKey, 'publicKey'),
    publicKeyFingerprint: parseSha256Digest(requiredText(value.publicKeyFingerprint, 'publicKeyFingerprint')),
    schemaVersion: 1,
    signature: requiredHex(value.signature, 'signature'),
  };
  if (value.algorithm !== GRAPH_SHARE_SIGNATURE_ALGORITHM || value.schemaVersion !== 1) {
    throw graphSharingFailure('Frontier signature envelope schema is invalid.');
  }
  if (JSON.stringify(EffectRecord.keys(value).sort()) !== JSON.stringify(EffectRecord.keys(envelope).sort())) {
    throw graphSharingFailure('Frontier signature envelope contains unsupported fields.');
  }
  return envelope;
}

export function parseGraphSharePublisherKey(value: unknown): GraphSharePublisherKeyV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw graphSharingFailure('Publisher key file is invalid.');
  }
  return {
    fingerprint: parseSha256Digest(requiredText(value.fingerprint, 'fingerprint')),
    privateKey: requiredHex(value.privateKey, 'privateKey'),
    publicKey: requiredHex(value.publicKey, 'publicKey'),
    schemaVersion: 1,
  };
}

export function parseGraphShareFrontierPointer(value: unknown): GraphShareFrontierPointerV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw graphSharingFailure('Frontier pointer is invalid.');
  }
  return {
    envelopeDigest: parseSha256Digest(requiredText(value.envelopeDigest, 'envelopeDigest')),
    manifestDigest: parseSha256Digest(requiredText(value.manifestDigest, 'manifestDigest')),
    schemaVersion: 1,
  };
}

function parseCheckpoint(value: unknown): GraphShareFrontierCheckpointV1 {
  if (!isRecord(value)) throw graphSharingFailure('Frontier checkpoint descriptor is invalid.');
  const checkpoint: GraphShareFrontierCheckpointV1 = {
    manifestDigest: parseSha256Digest(requiredText(value.manifestDigest, 'checkpoint.manifestDigest')),
    snapshotId: requiredText(value.snapshotId, 'checkpoint.snapshotId'),
    sourceCommit: requiredGitObjectId(value.sourceCommit, 'checkpoint.sourceCommit'),
    ...(value.metadataDigest === undefined
      ? {}
      : {metadataDigest: parseSha256Digest(requiredText(value.metadataDigest, 'checkpoint.metadataDigest'))}),
  };
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(checkpoint).sort())) {
    throw graphSharingFailure('Frontier checkpoint descriptor contains unsupported fields.');
  }
  return checkpoint;
}

function parseDelta(value: unknown): GraphShareFrontierDeltaV1 {
  if (!isRecord(value)) throw graphSharingFailure('Frontier delta descriptor is invalid.');
  const delta: GraphShareFrontierDeltaV1 = {
    baseSnapshotId: requiredText(value.baseSnapshotId, 'delta.baseSnapshotId'),
    manifestDigest: parseSha256Digest(requiredText(value.manifestDigest, 'delta.manifestDigest')),
    targetCommit: requiredGitObjectId(value.targetCommit, 'delta.targetCommit'),
    targetSnapshotId: requiredText(value.targetSnapshotId, 'delta.targetSnapshotId'),
    ...(value.metadataDigest === undefined
      ? {}
      : {metadataDigest: parseSha256Digest(requiredText(value.metadataDigest, 'delta.metadataDigest'))}),
  };
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(delta).sort())) {
    throw graphSharingFailure('Frontier delta descriptor contains unsupported fields.');
  }
  return delta;
}

function requiredGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw graphSharingFailure('Frontier generation is invalid.');
  }
  return value;
}

function requiredFence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw graphSharingFailure('Frontier publisher fence is invalid.');
  }
  return value;
}

function parsePreviousManifestDigest(value: unknown, generation: number): Sha256Digest | null {
  if (generation === 1) {
    if (value !== null) throw graphSharingFailure('Generation-one frontiers cannot name a predecessor.');
    return null;
  }
  if (typeof value !== 'string') throw graphSharingFailure('Frontier predecessor digest is invalid.');
  return parseSha256Digest(value, 'previousManifestDigest');
}

function exportKeyBytes(key: CryptoKey, format: 'pkcs8' | 'raw') {
  return fromPromiseInterruptible(
    () => crypto.subtle.exportKey(format, key).then(buffer => new Uint8Array(buffer)),
    cause => graphSharingFailure('Failed to export a graph publisher key.', cause),
  );
}

function importPrivateKey(hex: string) {
  return fromPromiseInterruptible(
    () => crypto.subtle.importKey('pkcs8', asBufferSource(hexToBytes(hex)), ED25519, true, ['sign']),
    cause => graphSharingFailure('Publisher private key is invalid.', cause),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return EffectArray.join(
    EffectArray.map([...bytes], byte => Effect2.pipe(byte.toString(16), EffectString.padStart(2, '0'))),
    '',
  );
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(Effect2.pipe(hex, EffectString.slice(index * 2, index * 2 + 2)), 16);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || Effect2.pipe(value, EffectString.trim).length === 0 || value.length > 512) {
    throw graphSharingFailure(`Frontier field ${label} is invalid.`);
  }
  return value;
}

function requiredGitObjectId(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!isGraphShareGitObjectId(text)) {
    throw graphSharingFailure(`Frontier field ${label} must be a Git object id.`);
  }
  return text;
}

function requiredHex(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!SHA256_HEX.test(text) && !/^[0-9a-f]{64,256}$/u.test(text)) {
    throw graphSharingFailure(`Frontier field ${label} must be lowercase hex.`);
  }
  return text;
}
