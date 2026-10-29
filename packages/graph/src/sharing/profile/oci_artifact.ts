import {Array as EffectArray} from 'effect';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {
  GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE,
  GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  GRAPH_SHARE_PROFILE_MEDIA_TYPE,
} from '../artifacts.js';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES, GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST} from '../descriptor.js';
import {parseSha256Digest, SHA256_DIGEST, sha256Digest, type Sha256Digest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {parseGraphShareProfile, type GraphShareProfileV1} from '../profile.js';
import * as EffectRecord from 'effect/Record';

export const GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES = 8_192;
export const GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES = 65_536;

interface GraphShareProfileOciEntry {
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly size: number;
}

export interface GraphShareProfileOciManifest {
  readonly artifactType: typeof GRAPH_SHARE_PROFILE_MEDIA_TYPE;
  readonly config: GraphShareProfileOciEntry;
  readonly layers: readonly [GraphShareProfileOciEntry];
  readonly mediaType: typeof GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE;
  readonly schemaVersion: 2;
}

/** The enrollment pointer names the manifest digest, never the profile layer digest. */
export function graphShareProfileOciArtifact(profile: GraphShareProfileV1): {
  readonly manifestBytes: Uint8Array;
  readonly manifestDigest: Sha256Digest;
  readonly profileBytes: Uint8Array;
  readonly profileDigest: Sha256Digest;
} {
  const validated = parseGraphShareProfile(profile);
  const profileBytes = new TextEncoder().encode(canonicalJson(validated));
  if (profileBytes.byteLength > GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES) {
    throw graphSharingFailure('OCI graph profile exceeds its size limit.');
  }
  const profileDigest = sha256Digest(profileBytes);
  const manifest: GraphShareProfileOciManifest = {
    artifactType: GRAPH_SHARE_PROFILE_MEDIA_TYPE,
    config: {
      digest: GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST,
      mediaType: GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE,
      size: GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES.byteLength,
    },
    layers: [{digest: profileDigest, mediaType: GRAPH_SHARE_PROFILE_MEDIA_TYPE, size: profileBytes.byteLength}],
    mediaType: GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    schemaVersion: 2,
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  if (manifestBytes.byteLength > GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES) {
    throw graphSharingFailure('OCI graph profile manifest exceeds its size limit.');
  }
  return {manifestBytes, manifestDigest: sha256Digest(manifestBytes), profileBytes, profileDigest};
}

export function parseGraphShareProfileOciArtifact(
  manifestBytes: Uint8Array,
  expectedManifestDigest: Sha256Digest,
  profileBytes: Uint8Array,
): GraphShareProfileV1 {
  if (
    !SHA256_DIGEST.test(expectedManifestDigest) ||
    manifestBytes.byteLength > GRAPH_SHARE_PROFILE_OCI_MANIFEST_MAX_BYTES ||
    profileBytes.byteLength > GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES ||
    sha256Digest(manifestBytes) !== expectedManifestDigest
  ) {
    throw graphSharingFailure('OCI graph profile manifest digest or size is invalid.');
  }
  const manifest = parseManifest(decodeCanonicalJson(manifestBytes, 'manifest'));
  if (manifest.layers[0].size !== profileBytes.byteLength || manifest.layers[0].digest !== sha256Digest(profileBytes)) {
    throw graphSharingFailure('OCI graph profile layer digest or size does not match its bytes.');
  }
  return parseGraphShareProfile(decodeCanonicalJson(profileBytes, 'profile'));
}

function parseManifest(value: unknown): GraphShareProfileOciManifest {
  if (!isRecord(value) || !hasExactKeys(value, ['artifactType', 'config', 'layers', 'mediaType', 'schemaVersion'])) {
    throw graphSharingFailure('OCI graph profile manifest contains unsupported fields.');
  }
  if (
    value.schemaVersion !== 2 ||
    value.mediaType !== GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE ||
    value.artifactType !== GRAPH_SHARE_PROFILE_MEDIA_TYPE ||
    !EffectArray.isArray(value.layers) ||
    value.layers.length !== 1
  ) {
    throw graphSharingFailure('OCI graph profile manifest type or layer count is invalid.');
  }
  const config = parseEntry(value.config, GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE);
  if (
    config.digest !== GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST ||
    config.size !== GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES.byteLength
  ) {
    throw graphSharingFailure('OCI graph profile manifest must use the empty OCI config.');
  }
  const layer = parseEntry(value.layers[0], GRAPH_SHARE_PROFILE_MEDIA_TYPE);
  if (layer.size > GRAPH_SHARE_PROFILE_OCI_BODY_MAX_BYTES) {
    throw graphSharingFailure('OCI graph profile layer exceeds its size limit.');
  }
  return {
    artifactType: GRAPH_SHARE_PROFILE_MEDIA_TYPE,
    config,
    layers: [layer],
    mediaType: GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    schemaVersion: 2,
  };
}

function parseEntry(value: unknown, mediaType: string): GraphShareProfileOciEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['digest', 'mediaType', 'size']) ||
    typeof value.digest !== 'string' ||
    !SHA256_DIGEST.test(value.digest) ||
    value.mediaType !== mediaType ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    throw graphSharingFailure('OCI graph profile descriptor entry is invalid.');
  }
  return {digest: parseSha256Digest(value.digest), mediaType, size: value.size};
}

function decodeCanonicalJson(bytes: Uint8Array, label: string): unknown {
  let parsed: unknown;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    parsed = JSON.parse(decoded) as unknown;
    if (canonicalJson(parsed) !== decoded) throw new Error('non-canonical JSON');
  } catch (cause) {
    throw graphSharingFailure(`OCI graph profile ${label} is not canonical JSON.`, cause);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = EffectRecord.keys(value).sort();
  return actual.length === keys.length && EffectArray.every(actual, (key, index) => key === keys[index]);
}
