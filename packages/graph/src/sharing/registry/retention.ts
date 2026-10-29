import {Array as EffectArray} from 'effect';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {compareCodeUnits} from '../../ordering.js';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE, GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE} from '../artifacts.js';
import {GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES, GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST} from '../descriptor.js';
import {SHA256_DIGEST, sha256Digest, sha256HexFromDigest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES, GRAPH_SHARE_REGISTRY_MANIFEST_MAX_BYTES} from '../oci.js';

export const GRAPH_SHARE_REGISTRY_CLOSURE_MAX_BLOBS = 16_384;
export const GRAPH_SHARE_REGISTRY_CLOSURE_MAX_BYTES = 4 * 1024 * 1_048_576;
export interface GraphShareRegistryRetentionEntry {
  readonly digest: string;
  readonly size: number;
}

export function graphShareRegistryRetentionRoot(input: readonly GraphShareRegistryRetentionEntry[]) {
  const sizes = new Map<string, number>([
    [GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST, GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES.byteLength],
  ]);
  let totalBytes = GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES.byteLength;
  for (const entry of input) {
    if (
      !SHA256_DIGEST.test(entry.digest) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > GRAPH_SHARE_HTTP_CAS_MAX_BYTES
    )
      throw graphSharingFailure('Registry retention entry is invalid.');
    const previous = sizes.get(entry.digest);
    if (previous !== undefined && previous !== entry.size)
      throw graphSharingFailure('Registry retention digest has conflicting sizes.');
    if (previous === undefined) {
      totalBytes += entry.size;
      sizes.set(entry.digest, entry.size);
      if (sizes.size > GRAPH_SHARE_REGISTRY_CLOSURE_MAX_BLOBS || totalBytes > GRAPH_SHARE_REGISTRY_CLOSURE_MAX_BYTES)
        throw graphSharingFailure('Registry publication exceeds its retained artifact limits.');
    }
  }
  const entries = EffectArray.map(
    [...sizes].sort(([a], [b]) => compareCodeUnits(a, b)),
    ([digest, size]) => ({digest, size}),
  );
  const bytes = new TextEncoder().encode(
    canonicalJson({
      artifactType: 'application/vnd.threadnote.graph.retention.v1+json',
      config: {
        digest: GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST,
        mediaType: GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE,
        size: GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES.byteLength,
      },
      layers: EffectArray.map(
        EffectArray.filter(entries, entry => entry.digest !== GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST),
        entry => ({...entry, mediaType: 'application/octet-stream'}),
      ),
      mediaType: GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      schemaVersion: 2,
    }),
  );
  if (bytes.byteLength > GRAPH_SHARE_REGISTRY_MANIFEST_MAX_BYTES)
    throw graphSharingFailure('Registry retention manifest exceeds its size limit.');
  const digest = sha256Digest(bytes);
  return {bytes, digest, entries, tag: `tn-retain-${sha256HexFromDigest(digest)}`, totalBytes};
}
