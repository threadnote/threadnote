import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {Gunzip, gzipSync} from 'fflate';
import {canonicalJson, parseCanonicalJson} from './canonical_json.js';
import {
  CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
  CODE_GRAPH_CHECKPOINT_MEDIA_TYPE,
  CODE_GRAPH_CHECKPOINT_RECORD_KINDS,
  CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
  CODE_GRAPH_CHECKPOINT_SCHEMA,
  CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE,
  codeGraphCheckpointRecordOrderKey,
  compareCodeGraphCheckpointRecordOrderKeys,
  emptyCodeGraphCheckpointCounts,
  parseCodeGraphCheckpointHeaderV1,
  parseCodeGraphCheckpointMetadataV1,
  parseCodeGraphCheckpointRecordV1,
  type CodeGraphCheckpointChunkDescriptorV1,
  type CodeGraphCheckpointAttributionFileV1,
  type CodeGraphCheckpointCountsV1,
  type CodeGraphCheckpointDeltaBaseV1,
  type CodeGraphCheckpointDescriptorV1,
  type CodeGraphCheckpointDigestV1,
  type CodeGraphCheckpointHeaderV1,
  type CodeGraphCheckpointMetadataV1,
  type CodeGraphCheckpointPackKindV1,
  type CodeGraphCheckpointRecordOrderKeyV1,
  type CodeGraphCheckpointRecordV1,
  type CodeGraphCheckpointSha256,
} from './schema.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder('utf-8', {fatal: true});
const CHECKPOINT_MAGIC = UTF8.encode('THREADNOTE-CGCP\n');
const CHUNK_MAGIC = UTF8.encode('TCG1');
const PRELUDE_BYTES = 24;
const CHUNK_FRAME_HEADER_BYTES = 52;
const UINT32_MAXIMUM = 0xffff_ffff;
const STREAM_FEED_BYTES = 64 * 1_024;

const ABI_DOMAIN = UTF8.encode('threadnote-code-graph-checkpoint-abi-v1\0');
const LOGICAL_DOMAIN = UTF8.encode('threadnote-code-graph-checkpoint-logical-v1\0');
const CHUNK_DOMAIN = UTF8.encode('threadnote-code-graph-checkpoint-chunk-v1\0');
const PATH_SET_DOMAIN = UTF8.encode('threadnote-code-graph-checkpoint-file-paths-v1\0');
const SPOOL_DOMAIN = UTF8.encode('threadnote-code-graph-checkpoint-spool-v1\0');

export const DEFAULT_CODE_GRAPH_CHECKPOINT_PACK_LIMITS: CodeGraphCheckpointPackLimits = {
  maximumArtifactBytes: 1_073_741_824,
  maximumChunks: 16_384,
  maximumCompressedChunkBytes: 20 * 1_048_576,
  maximumHeaderBytes: 1_048_576,
  maximumRecordBytes: 8 * 1_048_576,
  maximumRecords: 5_000_000,
  maximumUncompressedChunkBytes: 16 * 1_048_576,
  targetUncompressedChunkBytes: 4 * 1_048_576,
};

export const CODE_GRAPH_CHECKPOINT_PRELUDE_BYTES = PRELUDE_BYTES;
export const CODE_GRAPH_CHECKPOINT_CHUNK_FRAME_HEADER_BYTES = CHUNK_FRAME_HEADER_BYTES;

export interface CodeGraphCheckpointPackLimits {
  readonly maximumArtifactBytes: number;
  readonly maximumChunks: number;
  readonly maximumCompressedChunkBytes: number;
  readonly maximumHeaderBytes: number;
  readonly maximumRecordBytes: number;
  readonly maximumRecords: number;
  readonly maximumUncompressedChunkBytes: number;
  readonly targetUncompressedChunkBytes: number;
}

export interface CodeGraphCheckpointExpectedArtifactV1 {
  readonly expectedDescriptor?: CodeGraphCheckpointDescriptorV1;
  readonly expectedDigest?: CodeGraphCheckpointSha256;
}

export interface CodeGraphCheckpointDecodeOptionsV1 extends CodeGraphCheckpointExpectedArtifactV1 {
  readonly limits?: Partial<CodeGraphCheckpointPackLimits>;
  readonly onRecord?: (record: CodeGraphCheckpointRecordV1) => void;
  /** Called only after this compressed member and every logical record in it have been verified. */
  readonly onVerifiedChunk?: (chunk: CodeGraphCheckpointVerifiedChunkV1) => void;
}

export interface CodeGraphCheckpointDeltaEncodeV1 {
  readonly base: CodeGraphCheckpointDeltaBaseV1;
  readonly deletions: readonly CodeGraphCheckpointRecordOrderKeyV1[];
  readonly targetLogical: CodeGraphCheckpointDigestV1;
}

export interface CodeGraphCheckpointEncodeOptionsV1 {
  readonly delta?: CodeGraphCheckpointDeltaEncodeV1;
  readonly limits?: Partial<CodeGraphCheckpointPackLimits>;
  readonly packKind?: CodeGraphCheckpointPackKindV1;
}

export interface CodeGraphCheckpointEncodedChunkV1 {
  readonly bytes: Uint8Array;
  readonly ordinal: number;
}

export interface CodeGraphCheckpointVerifiedChunkV1 {
  readonly descriptor: CodeGraphCheckpointChunkDescriptorV1;
  readonly records: readonly CodeGraphCheckpointRecordV1[];
}

export interface CodeGraphCheckpointPreparedPackV1 {
  readonly header: CodeGraphCheckpointHeaderV1;
  readonly prefix: Uint8Array;
  readonly spoolDigest: CodeGraphCheckpointDigestV1;
}

export interface CodeGraphCheckpointEncodedPackV1 {
  readonly bytes: Uint8Array;
  readonly descriptor: CodeGraphCheckpointDescriptorV1;
  readonly header: CodeGraphCheckpointHeaderV1;
}

export interface CodeGraphCheckpointReadPlanV1 {
  readonly chunks: readonly {readonly frameBytes: number; readonly ordinal: number}[];
  readonly prefixBytes: number;
}

export interface CodeGraphCheckpointInspectionV1 {
  readonly descriptor: CodeGraphCheckpointDescriptorV1;
  readonly header: CodeGraphCheckpointHeaderV1;
  /** Inspect validates exact artifact bytes and framing, but deliberately does not inflate logical chunks. */
  readonly verification: 'artifact-and-framing';
}

export interface CodeGraphCheckpointDecodedPackV1 {
  readonly descriptor: CodeGraphCheckpointDescriptorV1;
  readonly header: CodeGraphCheckpointHeaderV1;
  readonly records: readonly CodeGraphCheckpointRecordV1[];
  readonly verification: 'full';
}

export interface CodeGraphCheckpointVerificationV1 {
  readonly descriptor: CodeGraphCheckpointDescriptorV1;
  readonly header: CodeGraphCheckpointHeaderV1;
  readonly verification: 'full';
}

export class CodeGraphCheckpointPackError extends Schema.TaggedError<
  CodeGraphCheckpointPackError,
  {readonly brand: unique symbol}
>()('CodeGraphCheckpointPackError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/** Exact bounded-read lengths for replaying one independently verifiable frame at a time. */
export function codeGraphCheckpointReadPlanV1(header: CodeGraphCheckpointHeaderV1): CodeGraphCheckpointReadPlanV1 {
  const parsed = parseCodeGraphCheckpointHeaderV1(header);
  return {
    chunks: EffectArray.map(parsed.chunks, chunk => ({
      frameBytes: checkedAdd(CHUNK_FRAME_HEADER_BYTES, chunk.compressedBytes, 'Checkpoint chunk frame'),
      ordinal: chunk.ordinal,
    })),
    prefixBytes: checkedAdd(PRELUDE_BYTES, canonicalBytes(parsed).byteLength, 'Checkpoint prefix'),
  };
}

/** Hash an explicit ABI input. Runtime compatibility assembly intentionally lives outside the codec. */
export function codeGraphCheckpointAbiDigestV1(
  input: CodeGraphCheckpointMetadataV1['abi'],
): CodeGraphCheckpointDigestV1 {
  const metadata = parseCodeGraphCheckpointMetadataV1({
    abi: input,
    coverage: {eligibleFiles: 0, excludedFiles: 0, reasons: [], state: 'complete'},
    repository: {
      caseMode: 'sensitive',
      displayName: 'abi-validation',
      objectFormat: 'sha1',
      repositoryId: Effect.pipe('0', EffectString.repeat(64)),
    },
    source: {
      commit: Effect.pipe('0', EffectString.repeat(40)),
      extractorSet: 'abi-validation',
      graphContentId: `cgc_${Effect.pipe('0', EffectString.repeat(40))}`,
    },
  }).abi;
  return digestParts(ABI_DOMAIN, canonicalBytes(metadata));
}

/**
 * Streaming first pass. Records must already be in `compareCodeGraphCheckpointRecords` order.
 * Emitted chunk frames can be spooled to disk and replayed after `finish` produces the header.
 */
export class CodeGraphCheckpointStreamEncoderV1 {
  readonly #attributionFiles: Map<string, CodeGraphCheckpointAttributionFileV1>;
  readonly #counts = emptyCodeGraphCheckpointCounts();
  readonly #delta: CodeGraphCheckpointDeltaEncodeV1 | undefined;
  readonly #filePaths = domainHasher(PATH_SET_DOMAIN);
  readonly #factPaths = domainHasher(PATH_SET_DOMAIN);
  readonly #limits: CodeGraphCheckpointPackLimits;
  readonly #logical: Bun.CryptoHasher;
  readonly #metadata: CodeGraphCheckpointMetadataV1;
  readonly #packKind: CodeGraphCheckpointPackKindV1;
  readonly #spool = domainHasher(SPOOL_DOMAIN);
  readonly #chunkDescriptors: CodeGraphCheckpointChunkDescriptorV1[] = [];
  #chunkBytes = 0;
  #chunkFrames: Uint8Array[] = [];
  #chunkRecords = 0;
  #finished = false;
  #previousFactPath: string | undefined;
  #previousOrderKey: CodeGraphCheckpointRecordOrderKeyV1 | undefined;
  #recordCount = 0;

  constructor(metadata: CodeGraphCheckpointMetadataV1, options: CodeGraphCheckpointEncodeOptionsV1 = {}) {
    this.#limits = resolveLimits(options.limits);
    this.#metadata = parseCodeGraphCheckpointMetadataV1(metadata);
    this.#attributionFiles = checkpointAttributionFiles(this.#metadata);
    this.#packKind = options.packKind ?? (options.delta === undefined ? 'checkpoint' : 'delta');
    this.#delta = options.delta;
    if (this.#packKind === 'delta' && this.#delta === undefined) {
      throw CodeGraphCheckpointPackError.make({message: 'Delta pack encoding requires a base envelope.'});
    }
    if (this.#packKind === 'checkpoint' && this.#delta !== undefined) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint pack encoding cannot include a delta envelope.'});
    }
    const anchor = canonicalBytes(this.#metadata, this.#limits.maximumHeaderBytes, 'Checkpoint logical metadata');
    this.#logical = domainHasher(LOGICAL_DOMAIN);
    this.#logical.update(u32(anchor.byteLength));
    this.#logical.update(anchor);
  }

  write(
    records: Iterable<CodeGraphCheckpointRecordV1>,
    emit: (chunk: CodeGraphCheckpointEncodedChunkV1) => void,
  ): void {
    if (this.#finished) throw CodeGraphCheckpointPackError.make({message: 'Checkpoint encoder is already finished.'});
    for (const candidate of records) {
      const record = parseCodeGraphCheckpointRecordV1(candidate);
      const orderKey = codeGraphCheckpointRecordOrderKey(record);
      if (this.#previousOrderKey) {
        const order = compareCodeGraphCheckpointRecordOrderKeys(this.#previousOrderKey, orderKey);
        if (order === 0)
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint contains a duplicate record identity.'});
        if (order > 0)
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint records are not in canonical order.'});
      }
      const recordBytes = canonicalBytes(record, this.#limits.maximumRecordBytes, 'Checkpoint record');
      const framedBytes = checkedAdd(4, recordBytes.byteLength, 'Checkpoint record frame');
      if (framedBytes > this.#limits.maximumUncompressedChunkBytes) {
        throw CodeGraphCheckpointPackError.make({message: 'Checkpoint record does not fit in a bounded chunk.'});
      }
      if (this.#chunkRecords > 0 && this.#chunkBytes + framedBytes > this.#limits.targetUncompressedChunkBytes) {
        this.#flush(emit);
      }
      if (this.#recordCount >= this.#limits.maximumRecords) {
        throw CodeGraphCheckpointPackError.make({message: 'Checkpoint exceeds the record-count limit.'});
      }
      const frame = joinBytes([u32(recordBytes.byteLength), recordBytes]);
      this.#chunkFrames.push(frame);
      this.#chunkBytes += frame.byteLength;
      this.#chunkRecords += 1;
      this.#recordCount += 1;
      this.#counts[record.kind] += 1;
      this.#logical.update(frame);
      this.#trackSemantics(record);
      this.#previousOrderKey = orderKey;
    }
  }

  finish(emit: (chunk: CodeGraphCheckpointEncodedChunkV1) => void): CodeGraphCheckpointPreparedPackV1 {
    if (this.#finished) throw CodeGraphCheckpointPackError.make({message: 'Checkpoint encoder is already finished.'});
    this.#finished = true;
    if (this.#chunkRecords > 0) this.#flush(emit);
    if (this.#packKind === 'checkpoint') {
      verifyFileFactParity(
        this.#counts,
        this.#metadata.coverage.eligibleFiles,
        digestHex(this.#filePaths),
        digestHex(this.#factPaths),
      );
      verifyAttributionFileCoverage(this.#attributionFiles);
    }
    const abi = codeGraphCheckpointAbiDigestV1(this.#metadata.abi);
    const header = parseCodeGraphCheckpointHeaderV1({
      abi: {...abi, input: this.#metadata.abi},
      chunks: this.#chunkDescriptors,
      compressionProfile: CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE,
      counts: this.#counts,
      coverage: this.#metadata.coverage,
      formatVersion: CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
      logical:
        this.#packKind === 'delta' && this.#delta !== undefined
          ? this.#delta.targetLogical
          : {algorithm: 'sha256', digest: digestHex(this.#logical)},
      mediaType: CODE_GRAPH_CHECKPOINT_MEDIA_TYPE,
      packKind: this.#packKind,
      recordSchemaVersion: CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
      repository: this.#metadata.repository,
      ...(this.#metadata.reuse === undefined ? {} : {reuse: this.#metadata.reuse}),
      schema: CODE_GRAPH_CHECKPOINT_SCHEMA,
      source: this.#metadata.source,
      ...(this.#delta === undefined ? {} : {base: this.#delta.base, deletions: this.#delta.deletions}),
    });
    const prefix = encodePrefix(header, this.#limits);
    return {
      header,
      prefix,
      spoolDigest: {algorithm: 'sha256', digest: digestHex(this.#spool)},
    };
  }

  #flush(emit: (chunk: CodeGraphCheckpointEncodedChunkV1) => void): void {
    if (this.#chunkDescriptors.length >= this.#limits.maximumChunks) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint exceeds the chunk-count limit.'});
    }
    const ordinal = this.#chunkDescriptors.length;
    const uncompressed = joinBytes(this.#chunkFrames, this.#chunkBytes);
    if (uncompressed.byteLength > this.#limits.maximumUncompressedChunkBytes) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint chunk exceeds the uncompressed-byte limit.'});
    }
    const compressed = gzipSync(uncompressed, {level: 6, mtime: 0});
    if (compressed.byteLength > this.#limits.maximumCompressedChunkBytes) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint chunk exceeds the compressed-byte limit.'});
    }
    const descriptor: CodeGraphCheckpointChunkDescriptorV1 = {
      compressedBytes: compressed.byteLength,
      digest: chunkDigest(ordinal, this.#chunkRecords, uncompressed),
      ordinal,
      recordCount: this.#chunkRecords,
      uncompressedBytes: uncompressed.byteLength,
    };
    const bytes = encodeChunkFrame(descriptor, compressed);
    this.#chunkDescriptors.push(descriptor);
    this.#spool.update(bytes);
    emit({bytes, ordinal});
    this.#chunkBytes = 0;
    this.#chunkFrames = [];
    this.#chunkRecords = 0;
  }

  #trackSemantics(record: CodeGraphCheckpointRecordV1): void {
    if (record.kind === 'file') {
      updateFramedText(this.#filePaths, record.path);
      consumeAttributionFile(this.#attributionFiles, record);
    }
    if (record.kind !== 'file-fact') return;
    if (record.path === this.#previousFactPath) {
      throw CodeGraphCheckpointPackError.make({
        message: 'Checkpoint contains more than one materialized fact for a file.',
      });
    }
    this.#previousFactPath = record.path;
    updateFramedText(this.#factPaths, record.path);
  }
}

/** Second pass over a verified local spool. This state object never retains the whole artifact. */
export class CodeGraphCheckpointArtifactWriterV1 {
  readonly #artifact = domainlessHasher();
  readonly #expectedSpoolDigest: string;
  readonly #header: CodeGraphCheckpointHeaderV1;
  readonly #limits: CodeGraphCheckpointPackLimits;
  readonly #prefix: Uint8Array;
  readonly #spool = domainHasher(SPOOL_DOMAIN);
  #artifactBytes = 0;
  #finished = false;
  #nextOrdinal = 0;

  constructor(
    prepared: CodeGraphCheckpointPreparedPackV1,
    options: {limits?: Partial<CodeGraphCheckpointPackLimits>} = {},
  ) {
    this.#limits = resolveLimits(options.limits);
    this.#header = parseCodeGraphCheckpointHeaderV1(prepared.header);
    validateHeaderBounds(this.#header, this.#limits);
    this.#prefix = encodePrefix(this.#header, this.#limits);
    if (!equalBytes(this.#prefix, prepared.prefix)) {
      throw CodeGraphCheckpointPackError.make({message: 'Prepared checkpoint prefix does not match its header.'});
    }
    this.#expectedSpoolDigest = parseBareDigest(prepared.spoolDigest, 'Prepared spool digest');
    this.#appendArtifact(this.#prefix);
  }

  get prefix(): Uint8Array {
    return this.#prefix.slice();
  }

  write(chunk: CodeGraphCheckpointEncodedChunkV1 | Uint8Array): Uint8Array {
    if (this.#finished)
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact writer is already finished.'});
    const bytes = chunk instanceof Uint8Array ? chunk : chunk.bytes;
    if (!(chunk instanceof Uint8Array) && chunk.ordinal !== this.#nextOrdinal) {
      throw CodeGraphCheckpointPackError.make({message: 'Spool chunk ordinal is out of order.'});
    }
    const descriptor = this.#header.chunks[this.#nextOrdinal];
    if (!descriptor) throw CodeGraphCheckpointPackError.make({message: 'Checkpoint spool contains an extra chunk.'});
    validateChunkFrame(bytes, descriptor);
    this.#spool.update(bytes);
    this.#appendArtifact(bytes);
    this.#nextOrdinal += 1;
    return bytes;
  }

  finish(): CodeGraphCheckpointDescriptorV1 {
    if (this.#finished)
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact writer is already finished.'});
    this.#finished = true;
    if (this.#nextOrdinal !== this.#header.chunks.length) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint spool ended before every declared chunk.'});
    }
    if (digestHex(this.#spool) !== this.#expectedSpoolDigest) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint spool digest does not match the prepared pack.'});
    }
    return descriptor(this.#artifactBytes, digestHex(this.#artifact));
  }

  #appendArtifact(bytes: Uint8Array): void {
    this.#artifactBytes = checkedAdd(this.#artifactBytes, bytes.byteLength, 'Checkpoint artifact size');
    if (this.#artifactBytes > this.#limits.maximumArtifactBytes) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact exceeds the byte limit.'});
    }
    this.#artifact.update(bytes);
  }
}

/** Test/small-artifact convenience. Production callers should spool encoder chunks and replay through the writer. */
export function encodeCodeGraphCheckpointPackV1(
  metadata: CodeGraphCheckpointMetadataV1,
  records: readonly CodeGraphCheckpointRecordV1[],
  options: CodeGraphCheckpointEncodeOptionsV1 = {},
): CodeGraphCheckpointEncodedPackV1 {
  const chunks: CodeGraphCheckpointEncodedChunkV1[] = [];
  const encoder = new CodeGraphCheckpointStreamEncoderV1(metadata, options);
  encoder.write(
    EffectArray.map([...records], parseCodeGraphCheckpointRecordV1).sort((left, right) =>
      compareCodeGraphCheckpointRecordOrderKeys(
        codeGraphCheckpointRecordOrderKey(left),
        codeGraphCheckpointRecordOrderKey(right),
      ),
    ),
    chunk => chunks.push(chunk),
  );
  const prepared = encoder.finish(chunk => chunks.push(chunk));
  return assembleCodeGraphCheckpointPackV1(prepared, chunks, options);
}

/** Test/small-artifact convenience for replaying an already prepared spool into one byte array. */
export function assembleCodeGraphCheckpointPackV1(
  prepared: CodeGraphCheckpointPreparedPackV1,
  chunks: Iterable<CodeGraphCheckpointEncodedChunkV1 | Uint8Array>,
  options: {limits?: Partial<CodeGraphCheckpointPackLimits>} = {},
): CodeGraphCheckpointEncodedPackV1 {
  const writer = new CodeGraphCheckpointArtifactWriterV1(prepared, options);
  const pieces: Uint8Array[] = [writer.prefix];
  for (const chunk of chunks) pieces.push(writer.write(chunk));
  const artifactDescriptor = writer.finish();
  return {bytes: joinBytes(pieces, artifactDescriptor.size), descriptor: artifactDescriptor, header: prepared.header};
}

/**
 * Bounded streaming verifier. It retains at most the visible header and one compressed/uncompressed logical chunk.
 * `onVerifiedChunk` means the chunk digest and records are valid; whole-artifact logical verification completes at finish.
 */
export class CodeGraphCheckpointStreamDecoderV1 {
  readonly #artifact = domainlessHasher();
  readonly #counts = emptyCodeGraphCheckpointCounts();
  readonly #expectedDescriptor: CodeGraphCheckpointDescriptorV1 | undefined;
  readonly #expectedDigest: string | undefined;
  readonly #factPaths = domainHasher(PATH_SET_DOMAIN);
  readonly #filePaths = domainHasher(PATH_SET_DOMAIN);
  readonly #limits: CodeGraphCheckpointPackLimits;
  readonly #onRecord: ((record: CodeGraphCheckpointRecordV1) => void) | undefined;
  readonly #onVerifiedChunk: ((chunk: CodeGraphCheckpointVerifiedChunkV1) => void) | undefined;
  readonly #queue = new ByteQueue();
  #artifactBytes = 0;
  #attributionFiles: Map<string, CodeGraphCheckpointAttributionFileV1> | undefined;
  #currentChunk: CodeGraphCheckpointChunkDescriptorV1 | undefined;
  #finished = false;
  #header: CodeGraphCheckpointHeaderV1 | undefined;
  #headerBytes: number | undefined;
  #logical: Bun.CryptoHasher | undefined;
  #nextChunk = 0;
  #previousFactPath: string | undefined;
  #previousOrderKey: CodeGraphCheckpointRecordOrderKeyV1 | undefined;
  #recordCount = 0;
  #state: 'chunk-header' | 'chunk-payload' | 'done' | 'header' | 'prelude' = 'prelude';

  constructor(options: CodeGraphCheckpointDecodeOptionsV1 = {}) {
    this.#limits = resolveLimits(options.limits);
    this.#expectedDescriptor = options.expectedDescriptor;
    if (this.#expectedDescriptor) validateExpectedDescriptor(this.#expectedDescriptor, this.#limits);
    this.#expectedDigest = options.expectedDigest
      ? parsePrefixedDigest(options.expectedDigest, 'Expected digest')
      : undefined;
    if (
      this.#expectedDescriptor &&
      this.#expectedDigest &&
      this.#expectedDescriptor.digest !== `sha256:${this.#expectedDigest}`
    ) {
      throw CodeGraphCheckpointPackError.make({message: 'Expected checkpoint digests disagree.'});
    }
    this.#onRecord = options.onRecord;
    this.#onVerifiedChunk = options.onVerifiedChunk;
  }

  push(bytes: Uint8Array): void {
    if (this.#finished) throw CodeGraphCheckpointPackError.make({message: 'Checkpoint decoder is already finished.'});
    if (!(bytes instanceof Uint8Array))
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint input must be bytes.'});
    this.#artifactBytes = checkedAdd(this.#artifactBytes, bytes.byteLength, 'Checkpoint artifact size');
    if (this.#artifactBytes > this.#limits.maximumArtifactBytes) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact exceeds the byte limit.'});
    }
    if (this.#expectedDescriptor && this.#artifactBytes > this.#expectedDescriptor.size) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact exceeds its expected size.'});
    }
    this.#artifact.update(bytes);
    this.#feed(bytes);
  }

  finish(): CodeGraphCheckpointVerificationV1 {
    if (this.#finished) throw CodeGraphCheckpointPackError.make({message: 'Checkpoint decoder is already finished.'});
    this.#drain();
    this.#finished = true;
    if (this.#state !== 'done' || this.#queue.size !== 0 || !this.#header || !this.#logical) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact ended before its declared framing.'});
    }
    if (this.#header.packKind !== 'delta') {
      verifyFileFactParity(
        this.#counts,
        this.#header.coverage.eligibleFiles,
        digestHex(this.#filePaths),
        digestHex(this.#factPaths),
      );
      verifyAttributionFileCoverage(this.#attributionFiles ?? new Map());
      if (digestHex(this.#logical) !== this.#header.logical.digest) {
        throw CodeGraphCheckpointPackError.make({message: 'Checkpoint logical digest does not match its records.'});
      }
    }
    for (const kind of CODE_GRAPH_CHECKPOINT_RECORD_KINDS) {
      if (this.#counts[kind] !== this.#header.counts[kind]) {
        throw CodeGraphCheckpointPackError.make({message: `Checkpoint ${kind} count does not match its header.`});
      }
    }
    const resultDescriptor = descriptor(this.#artifactBytes, digestHex(this.#artifact));
    verifyExpectedArtifact(resultDescriptor, this.#expectedDescriptor, this.#expectedDigest);
    return {descriptor: resultDescriptor, header: this.#header, verification: 'full'};
  }

  #drain(): void {
    while (true) {
      if (this.#state === 'prelude') {
        const bytes = this.#queue.take(PRELUDE_BYTES);
        if (!bytes) return;
        if (!equalBytes(bytes.subarray(0, CHECKPOINT_MAGIC.byteLength), CHECKPOINT_MAGIC)) {
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint magic is invalid.'});
        }
        const view = dataView(bytes);
        if (view.getUint32(16, false) !== CODE_GRAPH_CHECKPOINT_FORMAT_VERSION) {
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint prelude version is unsupported.'});
        }
        this.#headerBytes = view.getUint32(20, false);
        if (this.#headerBytes === 0 || this.#headerBytes > this.#limits.maximumHeaderBytes) {
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint header exceeds the byte limit.'});
        }
        this.#state = 'header';
        continue;
      }
      if (this.#state === 'header') {
        const bytes = this.#queue.take(this.#headerBytes!);
        if (!bytes) return;
        this.#header = decodeHeader(bytes, this.#limits);
        const metadata = metadataFromHeader(this.#header);
        this.#attributionFiles = checkpointAttributionFiles(metadata);
        const anchor = canonicalBytes(metadata, this.#limits.maximumHeaderBytes, 'Checkpoint logical metadata');
        this.#logical = domainHasher(LOGICAL_DOMAIN);
        this.#logical.update(u32(anchor.byteLength));
        this.#logical.update(anchor);
        this.#state = this.#header.chunks.length === 0 ? 'done' : 'chunk-header';
        continue;
      }
      if (this.#state === 'chunk-header') {
        const bytes = this.#queue.take(CHUNK_FRAME_HEADER_BYTES);
        if (!bytes) return;
        const expected = this.#header!.chunks[this.#nextChunk];
        if (!expected) throw CodeGraphCheckpointPackError.make({message: 'Checkpoint contains an undeclared chunk.'});
        validateChunkFrameHeader(bytes, expected);
        this.#currentChunk = expected;
        this.#state = 'chunk-payload';
        continue;
      }
      if (this.#state === 'chunk-payload') {
        const descriptor = this.#currentChunk!;
        const compressed = this.#queue.take(descriptor.compressedBytes);
        if (!compressed) return;
        const uncompressed = inflateSingleMember(compressed, descriptor.uncompressedBytes);
        if (chunkDigest(descriptor.ordinal, descriptor.recordCount, uncompressed).digest !== descriptor.digest.digest) {
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint chunk digest does not match its payload.'});
        }
        const records = this.#decodeRecords(uncompressed, descriptor);
        this.#onVerifiedChunk?.({descriptor, records});
        for (const record of records) this.#onRecord?.(record);
        this.#nextChunk += 1;
        this.#currentChunk = undefined;
        this.#state = this.#nextChunk === this.#header!.chunks.length ? 'done' : 'chunk-header';
        continue;
      }
      if (this.#queue.size > 0)
        throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact has trailing bytes.'});
      return;
    }
  }

  #feed(bytes: Uint8Array): void {
    for (let offset = 0; offset < bytes.byteLength; offset += STREAM_FEED_BYTES) {
      this.#queue.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + STREAM_FEED_BYTES)));
      this.#drain();
    }
  }

  #decodeRecords(
    bytes: Uint8Array,
    descriptor: CodeGraphCheckpointChunkDescriptorV1,
  ): readonly CodeGraphCheckpointRecordV1[] {
    const records: CodeGraphCheckpointRecordV1[] = [];
    let offset = 0;
    for (let index = 0; index < descriptor.recordCount; index += 1) {
      if (bytes.byteLength - offset < 4)
        throw CodeGraphCheckpointPackError.make({message: 'Checkpoint record frame is truncated.'});
      const length = dataView(bytes, offset, 4).getUint32(0, false);
      offset += 4;
      if (length === 0 || length > this.#limits.maximumRecordBytes || length > bytes.byteLength - offset) {
        throw CodeGraphCheckpointPackError.make({message: 'Checkpoint record length is invalid.'});
      }
      const recordBytes = bytes.subarray(offset, offset + length);
      offset += length;
      const record = parseCodeGraphCheckpointRecordV1(parseCanonicalBytes(recordBytes, 'Checkpoint record'));
      const orderKey = codeGraphCheckpointRecordOrderKey(record);
      if (this.#previousOrderKey) {
        const order = compareCodeGraphCheckpointRecordOrderKeys(this.#previousOrderKey, orderKey);
        if (order === 0)
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint contains a duplicate record identity.'});
        if (order > 0)
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint records are not in canonical order.'});
      }
      if (this.#recordCount >= this.#limits.maximumRecords) {
        throw CodeGraphCheckpointPackError.make({message: 'Checkpoint exceeds the record-count limit.'});
      }
      this.#recordCount += 1;
      this.#counts[record.kind] += 1;
      this.#logical!.update(u32(length));
      this.#logical!.update(recordBytes);
      this.#trackSemantics(record);
      this.#previousOrderKey = orderKey;
      records.push(record);
    }
    if (offset !== bytes.byteLength)
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint chunk has extra record bytes.'});
    return records;
  }

  #trackSemantics(record: CodeGraphCheckpointRecordV1): void {
    if (record.kind === 'file') {
      updateFramedText(this.#filePaths, record.path);
      consumeAttributionFile(this.#attributionFiles!, record);
    }
    if (record.kind !== 'file-fact') return;
    if (record.path === this.#previousFactPath) {
      throw CodeGraphCheckpointPackError.make({
        message: 'Checkpoint contains more than one materialized fact for a file.',
      });
    }
    this.#previousFactPath = record.path;
    updateFramedText(this.#factPaths, record.path);
  }
}

/** Full small-artifact convenience that returns all records after bounded streaming validation. */
export function decodeCodeGraphCheckpointPackV1(
  bytes: Uint8Array,
  options: CodeGraphCheckpointExpectedArtifactV1 & {limits?: Partial<CodeGraphCheckpointPackLimits>} = {},
): CodeGraphCheckpointDecodedPackV1 {
  const records: CodeGraphCheckpointRecordV1[] = [];
  const decoder = new CodeGraphCheckpointStreamDecoderV1({...options, onRecord: record => records.push(record)});
  decoder.push(bytes);
  const inspection = decoder.finish();
  return {...inspection, records, verification: 'full'};
}

/** Bounded, non-inflating inspector for CLI metadata and exact artifact-descriptor verification. */
export class CodeGraphCheckpointStreamInspectorV1 {
  readonly #artifact = domainlessHasher();
  readonly #expectedDescriptor: CodeGraphCheckpointDescriptorV1 | undefined;
  readonly #expectedDigest: string | undefined;
  readonly #limits: CodeGraphCheckpointPackLimits;
  readonly #queue = new ByteQueue();
  #artifactBytes = 0;
  #finished = false;
  #gzipPrefix: number[] = [];
  #header: CodeGraphCheckpointHeaderV1 | undefined;
  #headerBytes: number | undefined;
  #nextChunk = 0;
  #payloadRemaining = 0;
  #state: 'chunk-header' | 'chunk-payload' | 'done' | 'header' | 'prelude' = 'prelude';

  constructor(options: CodeGraphCheckpointExpectedArtifactV1 & {limits?: Partial<CodeGraphCheckpointPackLimits>} = {}) {
    this.#limits = resolveLimits(options.limits);
    this.#expectedDescriptor = options.expectedDescriptor;
    if (this.#expectedDescriptor) validateExpectedDescriptor(this.#expectedDescriptor, this.#limits);
    this.#expectedDigest = options.expectedDigest
      ? parsePrefixedDigest(options.expectedDigest, 'Expected digest')
      : undefined;
    if (
      this.#expectedDescriptor &&
      this.#expectedDigest &&
      this.#expectedDescriptor.digest !== `sha256:${this.#expectedDigest}`
    ) {
      throw CodeGraphCheckpointPackError.make({message: 'Expected checkpoint digests disagree.'});
    }
  }

  push(bytes: Uint8Array): void {
    if (this.#finished) throw CodeGraphCheckpointPackError.make({message: 'Checkpoint inspector is already finished.'});
    if (!(bytes instanceof Uint8Array))
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint input must be bytes.'});
    this.#artifactBytes = checkedAdd(this.#artifactBytes, bytes.byteLength, 'Checkpoint artifact size');
    if (this.#artifactBytes > this.#limits.maximumArtifactBytes) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact exceeds the byte limit.'});
    }
    if (this.#expectedDescriptor && this.#artifactBytes > this.#expectedDescriptor.size) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact exceeds its expected size.'});
    }
    this.#artifact.update(bytes);
    for (let offset = 0; offset < bytes.byteLength; offset += STREAM_FEED_BYTES) {
      this.#queue.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + STREAM_FEED_BYTES)));
      this.#drain();
    }
  }

  finish(): CodeGraphCheckpointInspectionV1 {
    if (this.#finished) throw CodeGraphCheckpointPackError.make({message: 'Checkpoint inspector is already finished.'});
    this.#drain();
    this.#finished = true;
    if (this.#state !== 'done' || this.#queue.size !== 0 || !this.#header) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact ended before its declared framing.'});
    }
    const artifactDescriptor = descriptor(this.#artifactBytes, digestHex(this.#artifact));
    verifyExpectedArtifact(artifactDescriptor, this.#expectedDescriptor, this.#expectedDigest);
    return {descriptor: artifactDescriptor, header: this.#header, verification: 'artifact-and-framing'};
  }

  #drain(): void {
    while (true) {
      if (this.#state === 'prelude') {
        const bytes = this.#queue.take(PRELUDE_BYTES);
        if (!bytes) return;
        if (!equalBytes(bytes.subarray(0, CHECKPOINT_MAGIC.byteLength), CHECKPOINT_MAGIC)) {
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint magic is invalid.'});
        }
        const view = dataView(bytes);
        if (view.getUint32(16, false) !== CODE_GRAPH_CHECKPOINT_FORMAT_VERSION) {
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint prelude version is unsupported.'});
        }
        this.#headerBytes = view.getUint32(20, false);
        if (this.#headerBytes === 0 || this.#headerBytes > this.#limits.maximumHeaderBytes) {
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint header exceeds the byte limit.'});
        }
        this.#state = 'header';
        continue;
      }
      if (this.#state === 'header') {
        const bytes = this.#queue.take(this.#headerBytes!);
        if (!bytes) return;
        this.#header = decodeHeader(bytes, this.#limits);
        this.#state = this.#header.chunks.length === 0 ? 'done' : 'chunk-header';
        continue;
      }
      if (this.#state === 'chunk-header') {
        const bytes = this.#queue.take(CHUNK_FRAME_HEADER_BYTES);
        if (!bytes) return;
        const expected = this.#header!.chunks[this.#nextChunk];
        if (!expected) throw CodeGraphCheckpointPackError.make({message: 'Checkpoint contains an undeclared chunk.'});
        validateChunkFrameHeader(bytes, expected);
        this.#payloadRemaining = expected.compressedBytes;
        this.#gzipPrefix = [];
        this.#state = 'chunk-payload';
        continue;
      }
      if (this.#state === 'chunk-payload') {
        if (this.#queue.size === 0) return;
        const consumed = Math.min(this.#queue.size, this.#payloadRemaining);
        const bytes = this.#queue.take(consumed)!;
        for (let index = 0; index < bytes.byteLength && this.#gzipPrefix.length < 3; index += 1) {
          this.#gzipPrefix.push(bytes[index]);
        }
        this.#payloadRemaining -= consumed;
        if (this.#payloadRemaining > 0) continue;
        if (this.#gzipPrefix[0] !== 0x1f || this.#gzipPrefix[1] !== 0x8b || this.#gzipPrefix[2] !== 8) {
          throw CodeGraphCheckpointPackError.make({message: 'Checkpoint chunk is not a gzip member.'});
        }
        this.#nextChunk += 1;
        this.#state = this.#nextChunk === this.#header!.chunks.length ? 'done' : 'chunk-header';
        continue;
      }
      if (this.#queue.size > 0)
        throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact has trailing bytes.'});
      return;
    }
  }
}

/** Parse and authenticate exact framing without inflating any gzip member. */
export function inspectCodeGraphCheckpointPackV1(
  bytes: Uint8Array,
  options: CodeGraphCheckpointExpectedArtifactV1 & {limits?: Partial<CodeGraphCheckpointPackLimits>} = {},
): CodeGraphCheckpointInspectionV1 {
  const inspector = new CodeGraphCheckpointStreamInspectorV1(options);
  inspector.push(bytes);
  return inspector.finish();
}

function encodePrefix(header: CodeGraphCheckpointHeaderV1, limits: CodeGraphCheckpointPackLimits): Uint8Array {
  const headerBytes = canonicalBytes(header, limits.maximumHeaderBytes, 'Checkpoint header');
  const prelude = new Uint8Array(PRELUDE_BYTES);
  prelude.set(CHECKPOINT_MAGIC);
  const view = dataView(prelude);
  view.setUint32(16, CODE_GRAPH_CHECKPOINT_FORMAT_VERSION, false);
  view.setUint32(20, headerBytes.byteLength, false);
  return joinBytes([prelude, headerBytes]);
}

function encodeChunkFrame(descriptor: CodeGraphCheckpointChunkDescriptorV1, compressed: Uint8Array): Uint8Array {
  const header = new Uint8Array(CHUNK_FRAME_HEADER_BYTES);
  header.set(CHUNK_MAGIC);
  const view = dataView(header);
  view.setUint32(4, descriptor.ordinal, false);
  view.setUint32(8, descriptor.compressedBytes, false);
  view.setUint32(12, descriptor.uncompressedBytes, false);
  view.setUint32(16, descriptor.recordCount, false);
  header.set(hexBytes(descriptor.digest.digest), 20);
  return joinBytes([header, compressed]);
}

function validateChunkFrame(bytes: Uint8Array, descriptor: CodeGraphCheckpointChunkDescriptorV1): void {
  const expectedLength = checkedAdd(CHUNK_FRAME_HEADER_BYTES, descriptor.compressedBytes, 'Checkpoint chunk frame');
  if (bytes.byteLength !== expectedLength)
    throw CodeGraphCheckpointPackError.make({message: 'Spool chunk frame length is invalid.'});
  validateChunkFrameHeader(bytes.subarray(0, CHUNK_FRAME_HEADER_BYTES), descriptor);
}

function validateChunkFrameHeader(bytes: Uint8Array, expected: CodeGraphCheckpointChunkDescriptorV1): void {
  if (bytes.byteLength !== CHUNK_FRAME_HEADER_BYTES || !equalBytes(bytes.subarray(0, 4), CHUNK_MAGIC)) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint chunk magic is invalid.'});
  }
  const view = dataView(bytes);
  if (
    view.getUint32(4, false) !== expected.ordinal ||
    view.getUint32(8, false) !== expected.compressedBytes ||
    view.getUint32(12, false) !== expected.uncompressedBytes ||
    view.getUint32(16, false) !== expected.recordCount ||
    !equalBytes(bytes.subarray(20, 52), hexBytes(expected.digest.digest))
  ) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint chunk frame does not match its descriptor.'});
  }
}

function decodeHeader(bytes: Uint8Array, limits: CodeGraphCheckpointPackLimits): CodeGraphCheckpointHeaderV1 {
  const header = parseCodeGraphCheckpointHeaderV1(parseCanonicalBytes(bytes, 'Checkpoint header'));
  validateHeaderBounds(header, limits);
  const actualAbi = codeGraphCheckpointAbiDigestV1(header.abi.input);
  if (actualAbi.digest !== header.abi.digest) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint ABI digest does not match its input.'});
  }
  return header;
}

function validateHeaderBounds(header: CodeGraphCheckpointHeaderV1, limits: CodeGraphCheckpointPackLimits): void {
  if (header.chunks.length > limits.maximumChunks) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint header exceeds the chunk-count limit.'});
  }
  let totalRecords = 0;
  let lowerBoundBytes = PRELUDE_BYTES;
  for (const chunk of header.chunks) {
    if (chunk.compressedBytes > limits.maximumCompressedChunkBytes) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint declares an oversized compressed chunk.'});
    }
    if (chunk.uncompressedBytes > limits.maximumUncompressedChunkBytes) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint declares an oversized uncompressed chunk.'});
    }
    totalRecords = checkedAdd(totalRecords, chunk.recordCount, 'Checkpoint record count');
    lowerBoundBytes = checkedAdd(
      lowerBoundBytes,
      checkedAdd(CHUNK_FRAME_HEADER_BYTES, chunk.compressedBytes, 'Checkpoint chunk frame'),
      'Checkpoint artifact size',
    );
  }
  if (totalRecords > limits.maximumRecords)
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint exceeds the record limit.'});
  if (lowerBoundBytes > limits.maximumArtifactBytes) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint declarations exceed the artifact byte limit.'});
  }
}

function inflateSingleMember(compressed: Uint8Array, expectedBytes: number): Uint8Array {
  if (compressed.byteLength < 18)
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint gzip member is truncated.'});
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  let final = false;
  const gunzip = new Gunzip((data, isFinal) => {
    if (data.byteLength > output.byteLength - offset) {
      throw CodeGraphCheckpointPackError.make({message: 'Checkpoint gzip member expands beyond its declared size.'});
    }
    output.set(data, offset);
    offset += data.byteLength;
    final = isFinal;
  });
  gunzip.onmember = () => {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint chunk contains concatenated gzip members.'});
  };
  try {
    gunzip.push(compressed, true);
  } catch (cause) {
    if (Schema.is(CodeGraphCheckpointPackError)(cause)) throw cause;
    throw CodeGraphCheckpointPackError.make({
      message:
        cause instanceof Error
          ? `Checkpoint gzip member is invalid: ${cause.message}`
          : 'Checkpoint gzip member is invalid.',
    });
  }
  if (!final || offset !== expectedBytes) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint gzip member size does not match its descriptor.'});
  }
  const trailer = dataView(compressed, compressed.byteLength - 8, 8);
  if (trailer.getUint32(0, true) !== crc32(output) || trailer.getUint32(4, true) !== output.byteLength >>> 0) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint gzip member checksum or size is invalid.'});
  }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1));
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function chunkDigest(ordinal: number, recordCount: number, bytes: Uint8Array): CodeGraphCheckpointDigestV1 {
  return digestParts(CHUNK_DOMAIN, u32(ordinal), u32(recordCount), u32(bytes.byteLength), bytes);
}

function metadataFromHeader(header: CodeGraphCheckpointHeaderV1): CodeGraphCheckpointMetadataV1 {
  return parseCodeGraphCheckpointMetadataV1({
    abi: header.abi.input,
    coverage: header.coverage,
    repository: header.repository,
    ...(header.reuse === undefined ? {} : {reuse: header.reuse}),
    source: header.source,
  });
}

function checkpointAttributionFiles(
  metadata: CodeGraphCheckpointMetadataV1,
): Map<string, CodeGraphCheckpointAttributionFileV1> {
  return new Map(EffectArray.map(metadata.reuse?.inventory?.attributionFiles ?? [], file => [file.path, file]));
}

function consumeAttributionFile(
  remaining: Map<string, CodeGraphCheckpointAttributionFileV1>,
  record: Extract<CodeGraphCheckpointRecordV1, {readonly kind: 'file'}>,
): void {
  const expected = remaining.get(record.path);
  if (expected === undefined) return;
  if (
    record.blobId !== expected.blobId ||
    record.size !== expected.blobSize ||
    record.contentHash !== expected.contentHash ||
    record.language !== expected.language ||
    record.mode !== expected.mode ||
    record.source !== expected.source
  ) {
    throw CodeGraphCheckpointPackError.make({
      message: `Checkpoint attribution context does not match its file record: ${record.path}`,
    });
  }
  remaining.delete(record.path);
}

function verifyAttributionFileCoverage(remaining: ReadonlyMap<string, CodeGraphCheckpointAttributionFileV1>): void {
  if (remaining.size > 0) {
    throw CodeGraphCheckpointPackError.make({
      message: 'Checkpoint attribution context is not covered by exact graph file records.',
    });
  }
}

function verifyFileFactParity(
  counts: CodeGraphCheckpointCountsV1,
  eligibleFiles: number,
  filePathDigest: string,
  factPathDigest: string,
): void {
  if (counts.file !== eligibleFiles || counts['file-fact'] !== eligibleFiles) {
    throw CodeGraphCheckpointPackError.make({
      message: 'Checkpoint must contain one materialized fact for every eligible file.',
    });
  }
  if (filePathDigest !== factPathDigest) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint file and materialized-fact path sets differ.'});
  }
}

function updateFramedText(hasher: Bun.CryptoHasher, value: string): void {
  const bytes = UTF8.encode(value);
  hasher.update(u32(bytes.byteLength));
  hasher.update(bytes);
}

function parseCanonicalBytes(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = UTF8_FATAL.decode(bytes);
  } catch {
    throw CodeGraphCheckpointPackError.make({message: `${label} is not valid UTF-8.`});
  }
  try {
    return parseCanonicalJson(text);
  } catch (cause) {
    throw CodeGraphCheckpointPackError.make({
      message: cause instanceof Error ? `${label} is invalid: ${cause.message}` : `${label} is invalid.`,
    });
  }
}

function canonicalBytes(value: unknown, maximumBytes = UINT32_MAXIMUM, label = 'Canonical JSON'): Uint8Array {
  const bytes = UTF8.encode(canonicalJson(value));
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes || bytes.byteLength > UINT32_MAXIMUM) {
    throw CodeGraphCheckpointPackError.make({message: `${label} exceeds its UTF-8 byte limit.`});
  }
  return bytes;
}

function resolveLimits(overrides: Partial<CodeGraphCheckpointPackLimits> = {}): CodeGraphCheckpointPackLimits {
  const limits = {...DEFAULT_CODE_GRAPH_CHECKPOINT_PACK_LIMITS, ...overrides};
  for (const [name, value] of EffectRecord.toEntries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > UINT32_MAXIMUM) {
      throw CodeGraphCheckpointPackError.make({message: `${name} must be a positive uint32.`});
    }
  }
  if (limits.targetUncompressedChunkBytes > limits.maximumUncompressedChunkBytes) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint target chunk size exceeds the maximum chunk size.'});
  }
  if (limits.maximumRecordBytes + 4 > limits.maximumUncompressedChunkBytes) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint record limit does not fit within the chunk limit.'});
  }
  return limits;
}

function validateExpectedDescriptor(
  value: CodeGraphCheckpointDescriptorV1,
  limits: CodeGraphCheckpointPackLimits,
): void {
  if (value.mediaType !== CODE_GRAPH_CHECKPOINT_MEDIA_TYPE) {
    throw CodeGraphCheckpointPackError.make({message: 'Expected checkpoint media type is invalid.'});
  }
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > limits.maximumArtifactBytes) {
    throw CodeGraphCheckpointPackError.make({message: 'Expected checkpoint size is invalid.'});
  }
  parsePrefixedDigest(value.digest, 'Expected descriptor digest');
}

function verifyExpectedArtifact(
  actual: CodeGraphCheckpointDescriptorV1,
  expectedDescriptor: CodeGraphCheckpointDescriptorV1 | undefined,
  expectedDigest: string | undefined,
): void {
  if (
    expectedDescriptor &&
    (actual.mediaType !== expectedDescriptor.mediaType ||
      actual.size !== expectedDescriptor.size ||
      actual.digest !== expectedDescriptor.digest)
  ) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact does not match its expected descriptor.'});
  }
  if (expectedDigest && actual.digest !== `sha256:${expectedDigest}`) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint artifact does not match its expected digest.'});
  }
}

function parseBareDigest(value: CodeGraphCheckpointDigestV1, label: string): string {
  if (value.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/u.test(value.digest)) {
    throw CodeGraphCheckpointPackError.make({message: `${label} is invalid.`});
  }
  return value.digest;
}

function parsePrefixedDigest(value: string, label: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw CodeGraphCheckpointPackError.make({message: `${label} is invalid.`});
  return Effect.pipe(value, EffectString.slice('sha256:'.length));
}

function descriptor(size: number, digest: string): CodeGraphCheckpointDescriptorV1 {
  return {digest: `sha256:${digest}`, mediaType: CODE_GRAPH_CHECKPOINT_MEDIA_TYPE, size};
}

function digestParts(...parts: readonly Uint8Array[]): CodeGraphCheckpointDigestV1 {
  const hasher = domainlessHasher();
  for (const part of parts) hasher.update(part);
  return {algorithm: 'sha256', digest: digestHex(hasher)};
}

function domainHasher(domain: Uint8Array): Bun.CryptoHasher {
  return domainlessHasher().update(domain);
}

function domainlessHasher(): Bun.CryptoHasher {
  return new Bun.CryptoHasher('sha256');
}

function digestHex(hasher: Bun.CryptoHasher): string {
  return hasher.digest('hex');
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAXIMUM) {
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint uint32 value is out of range.'});
  }
  const bytes = new Uint8Array(4);
  dataView(bytes).setUint32(0, value, false);
  return bytes;
}

function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value))
    throw CodeGraphCheckpointPackError.make({message: 'Checkpoint digest is invalid.'});
  return Uint8Array.from({length: 32}, (_, index) =>
    Number.parseInt(Effect.pipe(value, EffectString.slice(index * 2, index * 2 + 2)), 16),
  );
}

function dataView(bytes: Uint8Array, offset = 0, length = bytes.byteLength - offset): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

function checkedAdd(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right > Number.MAX_SAFE_INTEGER - left) {
    throw CodeGraphCheckpointPackError.make({message: `${label} overflows.`});
  }
  return left + right;
}

function joinBytes(parts: readonly Uint8Array[], expected?: number): Uint8Array {
  const length =
    expected ?? EffectArray.reduce(parts, 0, (total, part) => checkedAdd(total, part.byteLength, 'Byte sequence'));
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    if (part.byteLength > output.byteLength - offset)
      throw CodeGraphCheckpointPackError.make({message: 'Byte sequence length is invalid.'});
    output.set(part, offset);
    offset += part.byteLength;
  }
  if (offset !== output.byteLength)
    throw CodeGraphCheckpointPackError.make({message: 'Byte sequence length is invalid.'});
  return output;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

class ByteQueue {
  readonly #chunks: Uint8Array[] = [];
  #firstOffset = 0;
  #size = 0;

  get size(): number {
    return this.#size;
  }

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#chunks.push(bytes.slice());
    this.#size += bytes.byteLength;
  }

  take(size: number): Uint8Array | undefined {
    if (size > this.#size) return undefined;
    const output = new Uint8Array(size);
    let outputOffset = 0;
    while (outputOffset < size) {
      const first = this.#chunks[0];
      const available = first.byteLength - this.#firstOffset;
      const copied = Math.min(available, size - outputOffset);
      output.set(first.subarray(this.#firstOffset, this.#firstOffset + copied), outputOffset);
      outputOffset += copied;
      this.#firstOffset += copied;
      this.#size -= copied;
      if (this.#firstOffset === first.byteLength) {
        this.#chunks.shift();
        this.#firstOffset = 0;
      }
    }
    return output;
  }
}
