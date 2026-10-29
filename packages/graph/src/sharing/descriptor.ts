import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {
  GRAPH_SHARE_ATTESTATION_MEDIA_TYPE,
  GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE,
  GRAPH_SHARE_FRONTIER_MEDIA_TYPE,
  GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE,
  GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  GRAPH_SHARE_RECORDS_MEDIA_TYPE,
  GRAPH_SHARE_TCG1_MEDIA_TYPE,
} from './artifacts.js';
import {putCasBytes} from './cas.js';
import {parseSha256Digest, sha256Digest, type Sha256Digest} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from './oci.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES = new TextEncoder().encode('{}');
export const GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST = sha256Digest(GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES);
export const GRAPH_SHARE_OCTET_STREAM_MEDIA_TYPE = 'application/octet-stream';

const GRAPH_SHARE_OCI_LAYER_MEDIA_TYPES = new Set<string>([
  GRAPH_SHARE_ATTESTATION_MEDIA_TYPE,
  GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE,
  GRAPH_SHARE_FRONTIER_MEDIA_TYPE,
  GRAPH_SHARE_OCTET_STREAM_MEDIA_TYPE,
  GRAPH_SHARE_TCG1_MEDIA_TYPE,
]);

export interface GraphShareOciDescriptorV1 {
  readonly artifactType: typeof GRAPH_SHARE_FRONTIER_MEDIA_TYPE;
  readonly config: GraphShareOciDescriptorEntryV1;
  readonly layers: readonly [
    GraphShareOciDescriptorEntryV1,
    GraphShareOciDescriptorEntryV1,
    GraphShareOciDescriptorEntryV1,
  ];
  readonly mediaType: typeof GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE;
  readonly schemaVersion: 2;
}

export interface GraphShareOciDescriptorEntryV1 {
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly size: number;
}

export interface GraphShareOciDescriptorLayers {
  readonly envelope: Uint8Array;
  readonly frontier: Uint8Array;
  readonly metadata: Uint8Array;
}

export interface GraphShareOciDescriptorPublicationV1 {
  readonly descriptor: GraphShareOciDescriptorV1;
  readonly descriptorDigest: Sha256Digest;
  readonly envelopeDigest: Sha256Digest;
  readonly manifestDigest: Sha256Digest;
}

export function graphShareOciDescriptorCanonicalBytes(descriptor: GraphShareOciDescriptorV1): Uint8Array {
  return new TextEncoder().encode(canonicalJson(descriptor));
}

export function graphShareOciDescriptorDigest(descriptor: GraphShareOciDescriptorV1): Sha256Digest {
  return sha256Digest(graphShareOciDescriptorCanonicalBytes(descriptor));
}

export function graphShareOciDescriptorFromLayers(layers: GraphShareOciDescriptorLayers): GraphShareOciDescriptorV1 {
  const descriptor: GraphShareOciDescriptorV1 = {
    artifactType: GRAPH_SHARE_FRONTIER_MEDIA_TYPE,
    config: {
      digest: GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST,
      mediaType: GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE,
      size: GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES.byteLength,
    },
    layers: [
      layerEntry(GRAPH_SHARE_FRONTIER_MEDIA_TYPE, layers.frontier),
      layerEntry(GRAPH_SHARE_ATTESTATION_MEDIA_TYPE, layers.envelope),
      layerEntry(GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE, layers.metadata),
    ],
    mediaType: GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    schemaVersion: 2,
  };
  return parseGraphShareOciDescriptor(descriptor);
}

export function parseGraphShareOciDescriptor(value: unknown): GraphShareOciDescriptorV1 {
  if (!isRecord(value)) throw graphSharingFailure('OCI descriptor is invalid.');
  rejectForbiddenDescriptorFields(value);
  if (value.schemaVersion !== 2) throw graphSharingFailure('OCI descriptor schemaVersion is not supported.');
  if (value.mediaType !== GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE) {
    throw graphSharingFailure('OCI descriptor media type is not supported.');
  }
  if (value.artifactType !== GRAPH_SHARE_FRONTIER_MEDIA_TYPE) {
    throw graphSharingFailure('OCI descriptor artifactType is not a graph frontier.');
  }
  if (!EffectArray.isArray(value.layers) || value.layers.length !== 3) {
    throw graphSharingFailure('OCI descriptor must list frontier, attestation, and checkpoint metadata layers.');
  }
  const descriptor: GraphShareOciDescriptorV1 = {
    artifactType: GRAPH_SHARE_FRONTIER_MEDIA_TYPE,
    config: parseConfigEntry(value.config),
    layers: [
      parseLayerEntry(value.layers[0], GRAPH_SHARE_FRONTIER_MEDIA_TYPE),
      parseLayerEntry(value.layers[1], GRAPH_SHARE_ATTESTATION_MEDIA_TYPE),
      parseLayerEntry(value.layers[2], GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE),
    ],
    mediaType: GRAPH_SHARE_OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    schemaVersion: 2,
  };
  if (JSON.stringify(EffectRecord.keys(value).sort()) !== JSON.stringify(EffectRecord.keys(descriptor).sort())) {
    throw graphSharingFailure('OCI descriptor contains unsupported fields.');
  }
  return descriptor;
}

export function graphShareOciLayerMediaTypes(descriptor: GraphShareOciDescriptorV1): readonly string[] {
  return [descriptor.config.mediaType, ...EffectArray.map(descriptor.layers, layer => layer.mediaType)];
}

export function graphShareFrontierPointerFromOciDescriptor(descriptor: GraphShareOciDescriptorV1): {
  readonly envelopeDigest: Sha256Digest;
  readonly manifestDigest: Sha256Digest;
  readonly metadataDigest: Sha256Digest;
} {
  return {
    envelopeDigest: descriptor.layers[1].digest,
    manifestDigest: descriptor.layers[0].digest,
    metadataDigest: descriptor.layers[2].digest,
  };
}

export function graphShareProductionLayerMediaTypesUseRecords(mediaTypes: readonly string[]): boolean {
  return mediaTypes.includes(GRAPH_SHARE_RECORDS_MEDIA_TYPE);
}

export const putGraphShareOciDescriptor = Effect.fn('codeGraph.sharing.putOciDescriptor')(function* (
  casRoot: string,
  layers: GraphShareOciDescriptorLayers,
) {
  yield* putCasBytes(casRoot, GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES);
  const descriptor = graphShareOciDescriptorFromLayers(layers);
  const descriptorDigest = yield* putCasBytes(casRoot, graphShareOciDescriptorCanonicalBytes(descriptor));
  return {
    descriptor,
    descriptorDigest,
    envelopeDigest: descriptor.layers[1].digest,
    manifestDigest: descriptor.layers[0].digest,
  } satisfies GraphShareOciDescriptorPublicationV1;
});

export const putSignedGraphShareFrontierDocuments = Effect.fn('codeGraph.sharing.putSignedFrontierDocuments')(
  function* (
    casRoot: string,
    signed: {readonly envelope: unknown; readonly manifest: unknown},
    metadataBytes: Uint8Array,
  ) {
    const frontier = new TextEncoder().encode(canonicalJson(signed.manifest));
    const envelope = new TextEncoder().encode(canonicalJson(signed.envelope));
    yield* putCasBytes(casRoot, frontier);
    yield* putCasBytes(casRoot, envelope);
    return yield* putGraphShareOciDescriptor(casRoot, {envelope, frontier, metadata: metadataBytes});
  },
);

function layerEntry(mediaType: string, bytes: Uint8Array): GraphShareOciDescriptorEntryV1 {
  assertLayerMediaType(mediaType);
  assertLayerSize(bytes.byteLength);
  return {digest: sha256Digest(bytes), mediaType, size: bytes.byteLength};
}

function parseConfigEntry(value: unknown): GraphShareOciDescriptorEntryV1 {
  const entry = parseDescriptorEntry(value);
  if (entry.mediaType !== GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE) {
    throw graphSharingFailure('OCI descriptor config must be the empty OCI config.');
  }
  if (
    entry.digest !== GRAPH_SHARE_OCI_EMPTY_CONFIG_DIGEST ||
    entry.size !== GRAPH_SHARE_OCI_EMPTY_CONFIG_BYTES.byteLength
  ) {
    throw graphSharingFailure('OCI descriptor empty config digest is invalid.');
  }
  return entry;
}

function parseLayerEntry(value: unknown, expectedMediaType: string): GraphShareOciDescriptorEntryV1 {
  const entry = parseDescriptorEntry(value);
  if (entry.mediaType !== expectedMediaType) {
    throw graphSharingFailure('OCI descriptor layer media type does not match the published artifact.');
  }
  return entry;
}

function parseDescriptorEntry(value: unknown): GraphShareOciDescriptorEntryV1 {
  if (!isRecord(value)) throw graphSharingFailure('OCI descriptor entry is invalid.');
  rejectForbiddenDescriptorFields(value);
  assertLayerMediaType(requiredText(value.mediaType, 'mediaType'));
  const size = requiredSize(value.size);
  const entry: GraphShareOciDescriptorEntryV1 = {
    digest: parseSha256Digest(requiredText(value.digest, 'digest')),
    mediaType: requiredText(value.mediaType, 'mediaType'),
    size,
  };
  if (JSON.stringify(EffectRecord.keys(value).sort()) !== JSON.stringify(EffectRecord.keys(entry).sort())) {
    throw graphSharingFailure('OCI descriptor entry contains unsupported fields.');
  }
  return entry;
}

function assertLayerMediaType(mediaType: string) {
  if (mediaType === GRAPH_SHARE_RECORDS_MEDIA_TYPE) {
    throw graphSharingFailure('Graph share layers must not use the unused records media type.');
  }
  if (!GRAPH_SHARE_OCI_LAYER_MEDIA_TYPES.has(mediaType) && mediaType !== GRAPH_SHARE_OCI_EMPTY_CONFIG_MEDIA_TYPE) {
    throw graphSharingFailure('OCI descriptor layer media type is not supported.');
  }
}

function assertLayerSize(size: number) {
  if (!Number.isInteger(size) || size < 0 || size > GRAPH_SHARE_HTTP_CAS_MAX_BYTES) {
    throw graphSharingFailure('OCI descriptor layer exceeds the HTTP transfer limit.');
  }
}

function requiredSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw graphSharingFailure('OCI descriptor layer size is invalid.');
  }
  assertLayerSize(value);
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || Effect2.pipe(value, EffectString.trim).length === 0 || value.length > 256) {
    throw graphSharingFailure(`OCI descriptor field ${label} is invalid.`);
  }
  return value;
}

function rejectForbiddenDescriptorFields(value: Record<string, unknown>) {
  for (const key of [
    'blob',
    'files',
    'gitTree',
    'graph',
    'graphRecords',
    'markdownBody',
    'records',
    'registryDestination',
    'source',
    'sourceText',
  ] as const) {
    if (EffectRecord.has(value, key)) throw graphSharingFailure('OCI descriptor must not carry source or Git objects.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
