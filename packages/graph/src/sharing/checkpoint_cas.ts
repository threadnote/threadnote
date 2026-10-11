import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256FileHex} from '@threadnote/platform/digest';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {
  CodeGraphCheckpointPackError,
  CodeGraphCheckpointStreamInspectorV1,
  codeGraphCheckpointReadPlanV1,
} from '../checkpoint/pack.js';
import {GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE, GRAPH_SHARE_DELTA_MEDIA_TYPE} from './artifacts.js';
import {decodeJsonBytes} from './atomic.js';
import {putCasBytes, putCasFile, readVerifiedCasBlob, verifyCasBlob} from './cas.js';
import {ensureSharedGraphBlob as ensureSharedLayerBlob, type GraphShareBlobSource} from './shared_blob.js';
import {parseSha256Digest, type Sha256Digest} from './digest.js';
import {graphSharingFailure, graphSharingUnavailable, GraphSharingError} from './errors.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from './oci.js';

const CHECKPOINT_IO_CHUNK_BYTES = 64 * 1_024;
const GRAPH_SHARE_CHECKPOINT_METADATA_SCHEMA_VERSION = 1 as const;

export interface GraphShareCheckpointChunkLayerV1 {
  readonly digest: Sha256Digest;
  readonly ordinal: number;
}

export type GraphShareLayerMediaType = typeof GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE | typeof GRAPH_SHARE_DELTA_MEDIA_TYPE;

export interface GraphShareCheckpointMetadataV1 {
  readonly artifactDigest: Sha256Digest;
  readonly chunks: readonly GraphShareCheckpointChunkLayerV1[];
  readonly mediaType: GraphShareLayerMediaType;
  readonly prefixDigest: Sha256Digest;
  readonly schemaVersion: typeof GRAPH_SHARE_CHECKPOINT_METADATA_SCHEMA_VERSION;
}

export interface GraphShareCheckpointLayerPublicationV1 {
  readonly metadata: GraphShareCheckpointMetadataV1;
  readonly metadataDigest: Sha256Digest;
}

export function parseGraphShareCheckpointMetadata(value: unknown): GraphShareCheckpointMetadataV1 {
  if (!isRecord(value) || value.schemaVersion !== GRAPH_SHARE_CHECKPOINT_METADATA_SCHEMA_VERSION) {
    throw graphSharingFailure('Checkpoint metadata is invalid.');
  }
  if (value.mediaType !== GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE && value.mediaType !== GRAPH_SHARE_DELTA_MEDIA_TYPE) {
    throw graphSharingFailure('Checkpoint metadata media type is not supported.');
  }
  if (!Array.isArray(value.chunks) || value.chunks.length > 16_384) {
    throw graphSharingFailure('Checkpoint metadata chunk list is invalid.');
  }
  const metadata: GraphShareCheckpointMetadataV1 = {
    artifactDigest: parseSha256Digest(requiredText(value.artifactDigest, 'artifactDigest')),
    chunks: value.chunks.map(parseChunkLayer),
    mediaType: value.mediaType,
    prefixDigest: parseSha256Digest(requiredText(value.prefixDigest, 'prefixDigest')),
    schemaVersion: GRAPH_SHARE_CHECKPOINT_METADATA_SCHEMA_VERSION,
  };
  for (const [index, chunk] of metadata.chunks.entries()) {
    if (chunk.ordinal !== index) throw graphSharingFailure('Checkpoint metadata chunk ordinals are not contiguous.');
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(metadata).sort())) {
    throw graphSharingFailure('Checkpoint metadata contains unsupported fields.');
  }
  return metadata;
}

export const putGraphShareCheckpointLayers = Effect.fn('codeGraph.sharing.putCheckpointLayers')(function* (
  casRoot: string,
  artifactDigest: string,
  mediaType: GraphShareLayerMediaType = GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE,
) {
  const expected = parseSha256Digest(artifactDigest);
  const artifactPath = yield* verifyCasBlob(casRoot, expected);
  const inspection = yield* inspectCheckpointFile(artifactPath);
  if (inspection.descriptor.digest !== expected) {
    return yield* graphSharingFailure('Checkpoint layer inspection digest does not match the CAS object.');
  }
  const plan = yield* attemptPack(() => codeGraphCheckpointReadPlanV1(inspection.header));
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(artifactPath, {flag: 'r'});
      const prefix = yield* readExact(file, plan.prefixBytes);
      yield* assertHttpCasLayerSize(prefix);
      const prefixDigest = yield* putCasBytes(casRoot, prefix);
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(prefix);
      const chunks: GraphShareCheckpointChunkLayerV1[] = [];
      for (const frame of plan.chunks) {
        const bytes = yield* readExact(file, frame.frameBytes);
        yield* assertHttpCasLayerSize(bytes);
        const digest = yield* putCasBytes(casRoot, bytes);
        hasher.update(bytes);
        chunks.push({digest, ordinal: frame.ordinal});
      }
      const assembled = parseSha256Digest(hasher.digest('hex'));
      if (assembled !== expected) {
        return yield* graphSharingFailure('Checkpoint layers do not reconstitute the assembled artifact digest.');
      }
      const metadata: GraphShareCheckpointMetadataV1 = {
        artifactDigest: expected,
        chunks,
        mediaType,
        prefixDigest,
        schemaVersion: GRAPH_SHARE_CHECKPOINT_METADATA_SCHEMA_VERSION,
      };
      const metadataDigest = yield* putCasBytes(casRoot, new TextEncoder().encode(canonicalJson(metadata)));
      return {metadata, metadataDigest} satisfies GraphShareCheckpointLayerPublicationV1;
    }),
  );
});

export const assembleGraphShareCheckpointLayers = Effect.fn('codeGraph.sharing.assembleCheckpointLayers')(function* (
  casRoot: string,
  metadata: GraphShareCheckpointMetadataV1,
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(destinationPath), {recursive: true, mode: 0o700});
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(destinationPath, {flag: 'wx', mode: 0o600});
      const prefix = yield* readVerifiedCasBlob(casRoot, metadata.prefixDigest);
      yield* assertHttpCasLayerSize(prefix);
      yield* file.writeAll(prefix);
      for (const chunk of metadata.chunks) {
        const frame = yield* readVerifiedCasBlob(casRoot, chunk.digest);
        yield* assertHttpCasLayerSize(frame);
        yield* file.writeAll(frame);
      }
      yield* file.sync;
    }),
  );
  const actual = parseSha256Digest(yield* sha256FileHex(destinationPath));
  if (actual !== metadata.artifactDigest) {
    return yield* graphSharingFailure('Assembled checkpoint digest does not match checkpoint metadata.');
  }
  return actual;
});

export const ensureGraphShareCheckpointArtifact = Effect.fn('codeGraph.sharing.ensureCheckpointArtifact')(
  function* (input: {
    readonly artifactDigest: string;
    readonly casRoot: string;
    readonly coordinatorUrl?: string;
    readonly metadataDigest?: string;
    readonly blobSource?: GraphShareBlobSource;
  }) {
    const artifactDigest = parseSha256Digest(input.artifactDigest);
    return yield* verifyCasBlob(input.casRoot, artifactDigest).pipe(
      Effect.catchIf(isUnavailableSharingFailure, () => materializeSharedCheckpoint(input, artifactDigest)),
    );
  },
);

const materializeSharedCheckpoint = Effect.fn('codeGraph.sharing.materializeCheckpoint')(function* (
  input: {
    readonly casRoot: string;
    readonly coordinatorUrl?: string;
    readonly metadataDigest?: string;
    readonly blobSource?: GraphShareBlobSource;
  },
  artifactDigest: Sha256Digest,
) {
  if (input.metadataDigest !== undefined) {
    const metadataBytes = yield* ensureSharedLayerBlob(
      input.casRoot,
      input.metadataDigest,
      input.coordinatorUrl,
      input.blobSource,
    );
    const metadata = yield* decodeMetadata(metadataBytes);
    if (metadata.artifactDigest !== artifactDigest) {
      return yield* graphSharingFailure('Checkpoint metadata does not cover the assembled artifact digest.');
    }
    yield* ensureSharedLayerBlob(input.casRoot, metadata.prefixDigest, input.coordinatorUrl, input.blobSource);
    for (const chunk of metadata.chunks) {
      yield* ensureSharedLayerBlob(input.casRoot, chunk.digest, input.coordinatorUrl, input.blobSource);
    }
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spool = path.join(input.casRoot, 'spool', `${yield* crypto.randomUUIDv4()}.cgcp`);
    return yield* Effect.acquireUseRelease(
      fs.makeDirectory(path.dirname(spool), {recursive: true, mode: 0o700}).pipe(Effect.as(spool)),
      spoolPath =>
        Effect.gen(function* () {
          yield* assembleGraphShareCheckpointLayers(input.casRoot, metadata, spoolPath);
          const stored = yield* putCasFile(input.casRoot, spoolPath);
          if (stored !== artifactDigest) {
            return yield* graphSharingFailure('Assembled checkpoint CAS digest does not match the frontier artifact.');
          }
          return yield* verifyCasBlob(input.casRoot, stored);
        }),
      spoolPath => fs.remove(spoolPath, {force: true}).pipe(Effect.ignore),
    );
  }
  if (input.coordinatorUrl !== undefined || input.blobSource !== undefined) {
    yield* ensureSharedLayerBlob(input.casRoot, artifactDigest, input.coordinatorUrl, input.blobSource).pipe(
      Effect.catchIf(
        error =>
          Schema.is(GraphSharingError)(error) &&
          error.kind === 'unavailable' &&
          error.message.includes('exceeds the HTTP transfer limit'),
        () =>
          graphSharingUnavailable(
            `Checkpoint exceeds the HTTP CAS limit; metadataDigest is required: ${artifactDigest}`,
          ),
      ),
    );
    return yield* verifyCasBlob(input.casRoot, artifactDigest);
  }
  return yield* graphSharingUnavailable(`CAS object is missing: ${artifactDigest}`);
});

const inspectCheckpointFile = Effect.fn('codeGraph.sharing.inspectCheckpointFile')(function* (artifactPath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(artifactPath).pipe(Effect.option))) {
    return yield* graphSharingFailure('Checkpoint CAS object must not be a symbolic link.');
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(artifactPath, {flag: 'r'});
      const inspector = new CodeGraphCheckpointStreamInspectorV1();
      const size = Number((yield* file.stat).size);
      if (!Number.isSafeInteger(size) || size <= 0) {
        return yield* graphSharingFailure('Checkpoint CAS object size is invalid.');
      }
      let remaining = size;
      while (remaining > 0) {
        const bytes = yield* readExact(file, Math.min(remaining, CHECKPOINT_IO_CHUNK_BYTES));
        remaining -= bytes.byteLength;
        yield* attemptPack(() => inspector.push(bytes));
      }
      return yield* attemptPack(() => inspector.finish());
    }),
  );
});

function decodeMetadata(bytes: Uint8Array) {
  return decodeJsonBytes(bytes).pipe(
    Effect.mapError(cause => graphSharingFailure('Checkpoint metadata is not valid JSON.', cause)),
    Effect.flatMap(value =>
      Effect.try({
        try: () => parseGraphShareCheckpointMetadata(value),
        catch: cause =>
          Schema.is(GraphSharingError)(cause) ? cause : graphSharingFailure('Checkpoint metadata is invalid.', cause),
      }),
    ),
  );
}

function assertHttpCasLayerSize(bytes: Uint8Array) {
  return bytes.byteLength > GRAPH_SHARE_HTTP_CAS_MAX_BYTES
    ? graphSharingFailure('Checkpoint CAS layer exceeds the HTTP transfer limit.')
    : Effect.void;
}

function readExact(file: FileSystem.File, length: number) {
  return Effect.gen(function* () {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = Number(yield* file.read(bytes.subarray(offset)));
      if (!Number.isSafeInteger(read) || read <= 0 || read > bytes.byteLength - offset) {
        return yield* graphSharingFailure('Checkpoint CAS object ended before its declared framing.');
      }
      offset += read;
    }
    return bytes;
  });
}

function attemptPack<A>(attempt: () => A) {
  return Effect.try({
    try: attempt,
    catch: cause =>
      Schema.is(CodeGraphCheckpointPackError)(cause)
        ? graphSharingFailure(cause.message, cause)
        : graphSharingFailure('Checkpoint artifact framing is invalid.', cause),
  });
}

function parseChunkLayer(value: unknown): GraphShareCheckpointChunkLayerV1 {
  if (!isRecord(value)) throw graphSharingFailure('Checkpoint metadata chunk is invalid.');
  const chunk: GraphShareCheckpointChunkLayerV1 = {
    digest: parseSha256Digest(requiredText(value.digest, 'chunks.digest')),
    ordinal: requiredOrdinal(value.ordinal),
  };
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(chunk).sort())) {
    throw graphSharingFailure('Checkpoint metadata chunk contains unsupported fields.');
  }
  return chunk;
}

function requiredOrdinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 16_384) {
    throw graphSharingFailure('Checkpoint metadata chunk ordinal is invalid.');
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw graphSharingFailure(`Checkpoint metadata field ${label} is invalid.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnavailableSharingFailure(error: unknown): error is GraphSharingError {
  return Schema.is(GraphSharingError)(error) && error.kind === 'unavailable';
}
