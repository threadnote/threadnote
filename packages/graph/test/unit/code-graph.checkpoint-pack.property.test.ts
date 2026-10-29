import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {canonicalJson, CanonicalJsonError} from '@threadnote/graph/checkpoint/canonical_json';
import {codeGraphCheckpointFileFactCacheIdentity} from '@threadnote/graph/checkpoint/file_fact_identity';
import {
  assembleCodeGraphCheckpointPackV1,
  CodeGraphCheckpointArtifactWriterV1,
  CodeGraphCheckpointPackError,
  codeGraphCheckpointReadPlanV1,
  CodeGraphCheckpointStreamDecoderV1,
  CodeGraphCheckpointStreamEncoderV1,
  CodeGraphCheckpointStreamInspectorV1,
  decodeCodeGraphCheckpointPackV1,
  encodeCodeGraphCheckpointPackV1,
  inspectCodeGraphCheckpointPackV1,
  type CodeGraphCheckpointEncodedPackV1,
} from '@threadnote/graph/checkpoint/pack';
import {
  compareCodeGraphCheckpointRecords,
  parseCodeGraphCheckpointRecordV1,
  type CodeGraphCheckpointFileFactRecordV1,
  type CodeGraphCheckpointFileRecordV1,
  type CodeGraphCheckpointHeaderV1,
  type CodeGraphCheckpointMetadataV1,
  type CodeGraphCheckpointRecordV1,
} from '@threadnote/graph/checkpoint/schema';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const SHA256_ZERO = Effect.pipe('0', EffectString.repeat(64));
const SHA1_ZERO = Effect.pipe('0', EffectString.repeat(40));
const UTF8 = new TextEncoder();

const pathArbitrary = FC.uniqueArray(
  FC.array(FC.constantFrom('a', 'b', 'Z', '0', '-', '_', '~', '"', 'é', '🙂'), {maxLength: 10, minLength: 1}).map(
    characters => `src/${EffectArray.join(characters, '')}.ts`,
  ),
  {maxLength: 18, minLength: 1},
);

describe('code graph checkpoint canonical JSON', () => {
  it('uses RFC 8785 primitive spelling and UTF-16 object-key ordering', () => {
    expect(canonicalJson({z: -0, '\r': 1, '€': 2, '😀': 3})).toBe('{"\\r":1,"z":0,"€":2,"😀":3}');
  });

  it('pins the portable v1 file-fact identity contract', () => {
    expect(
      codeGraphCheckpointFileFactCacheIdentity({
        diagnostics: [],
        edges: [],
        path: 'src/value.ts',
        symbols: [],
      }),
    ).toBe('cgfd_5da64f881d3d24c06474d75175a038e01773ea5e');
  });

  fcProp(
    it,
    'rejects exactly the arbitrary UTF-16 sequences containing unpaired surrogates',
    {codeUnits: FC.array(FC.integer({min: 0, max: 0xffff}), {maxLength: 64})},
    ({codeUnits}) => {
      let expectedWellFormed = true;
      for (let index = 0; index < codeUnits.length; index += 1) {
        const code = codeUnits[index];
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = codeUnits[index + 1];
          if (next === undefined || next < 0xdc00 || next > 0xdfff) {
            expectedWellFormed = false;
            break;
          }
          index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          expectedWellFormed = false;
          break;
        }
      }
      const value = String.fromCharCode(...codeUnits);
      if (expectedWellFormed) {
        expect(canonicalJson(value)).toBe(JSON.stringify(value));
      } else {
        expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
      }
    },
    {fastCheck: {numRuns: 400}},
  );

  it('rejects lone surrogates, sparse arrays, accessors, symbols, and extra array properties', () => {
    expect(() => canonicalJson('\ud800')).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Array(1))).toThrow(CanonicalJsonError);

    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', {enumerable: true, get: () => 'secret'});
    Object.defineProperty(accessor, 'length', {value: 1});
    expect(() => canonicalJson(accessor)).toThrow(CanonicalJsonError);

    const extra = ['value'];
    Object.defineProperty(extra, 'extra', {enumerable: true, value: true});
    expect(() => canonicalJson(extra)).toThrow(CanonicalJsonError);

    const symbolic = ['value'];
    Object.defineProperty(symbolic, Symbol('extra'), {enumerable: true, value: true});
    expect(() => canonicalJson(symbolic)).toThrow(CanonicalJsonError);
  });

  fcProp(
    it,
    'gives recursively reordered file facts one identity and separates semantic changes',
    {
      diagnostics: FC.array(FC.string({maxLength: 20}), {maxLength: 4}),
      path: pathArbitrary.map(paths => paths[0]),
    },
    ({diagnostics, path}) => {
      const facts = {derivationInputs: {rationale: []}, diagnostics, edges: [], path, symbols: []};
      const reordered = {
        symbols: [],
        path,
        edges: [],
        diagnostics,
        derivationInputs: {rationale: []},
      };
      expect(codeGraphCheckpointFileFactCacheIdentity(reordered)).toBe(codeGraphCheckpointFileFactCacheIdentity(facts));
      expect(codeGraphCheckpointFileFactCacheIdentity({...facts, diagnostics: [...diagnostics, 'changed']})).not.toBe(
        codeGraphCheckpointFileFactCacheIdentity(facts),
      );
    },
    {fastCheck: {numRuns: 40}},
  );
});

describe('code graph checkpoint pack', () => {
  fcProp(
    it,
    'is byte-deterministic across arbitrary input permutations and fully round-trips Unicode paths',
    {paths: pathArbitrary},
    ({paths}) => {
      const canonicalRecords = recordsFor(paths);
      const reversedRecords = [...canonicalRecords].reverse();
      const first = encodeCodeGraphCheckpointPackV1(metadataFor(paths.length), canonicalRecords, {
        limits: {targetUncompressedChunkBytes: 700},
      });
      const second = encodeCodeGraphCheckpointPackV1(metadataFor(paths.length), reversedRecords, {
        limits: {targetUncompressedChunkBytes: 700},
      });

      expect(second.bytes).toEqual(first.bytes);
      expect(second.descriptor).toEqual(first.descriptor);
      const decoded = decodeCodeGraphCheckpointPackV1(first.bytes, {expectedDescriptor: first.descriptor});
      expect(decoded.records).toEqual([...canonicalRecords].sort(compareCodeGraphCheckpointRecords));
      expect(decoded.verification).toBe('full');
    },
    {fastCheck: {numRuns: 50}},
  );

  fcProp(
    it,
    'accepts every input segmentation in both full verification and non-inflating inspection',
    {
      paths: pathArbitrary,
      width: FC.integer({max: 97, min: 1}),
    },
    ({paths, width}) => {
      const pack = encodeCodeGraphCheckpointPackV1(metadataFor(paths.length), recordsFor(paths), {
        limits: {targetUncompressedChunkBytes: 600},
      });
      const verifiedChunks: number[] = [];
      const decoder = new CodeGraphCheckpointStreamDecoderV1({
        expectedDescriptor: pack.descriptor,
        onVerifiedChunk: chunk => verifiedChunks.push(chunk.descriptor.ordinal),
      });
      const inspector = new CodeGraphCheckpointStreamInspectorV1({expectedDescriptor: pack.descriptor});
      for (let offset = 0; offset < pack.bytes.byteLength; offset += width) {
        const bytes = pack.bytes.subarray(offset, offset + width);
        decoder.push(bytes);
        inspector.push(bytes);
      }

      expect(decoder.finish().verification).toBe('full');
      expect(inspector.finish().verification).toBe('artifact-and-framing');
      expect(verifiedChunks).toEqual(EffectArray.map(pack.header.chunks, chunk => chunk.ordinal));
    },
    {fastCheck: {numRuns: 35}},
  );

  it('spools and replays independently bounded chunks through the public two-pass API', () => {
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const chunks: {readonly bytes: Uint8Array; readonly ordinal: number}[] = [];
    const encoder = new CodeGraphCheckpointStreamEncoderV1(metadataFor(paths.length), {
      limits: {targetUncompressedChunkBytes: 500},
    });
    const sorted = recordsFor(paths).sort(compareCodeGraphCheckpointRecords);
    encoder.write(sorted.slice(0, 2), chunk => chunks.push(chunk));
    encoder.write(sorted.slice(2), chunk => chunks.push(chunk));
    const prepared = encoder.finish(chunk => chunks.push(chunk));
    const plan = codeGraphCheckpointReadPlanV1(prepared.header);

    expect(plan.prefixBytes).toBe(prepared.prefix.byteLength);
    expect(EffectArray.map(plan.chunks, chunk => chunk.frameBytes)).toEqual(
      EffectArray.map(chunks, chunk => chunk.bytes.byteLength),
    );
    const writer = new CodeGraphCheckpointArtifactWriterV1(prepared);
    const pieces = [writer.prefix, ...EffectArray.map(chunks, chunk => writer.write(chunk))];
    const descriptor = writer.finish();
    const assembled = assembleCodeGraphCheckpointPackV1(prepared, chunks);
    expect(assembled.bytes).toEqual(join(pieces));
    expect(assembled.descriptor).toEqual(descriptor);
    expect(decodeCodeGraphCheckpointPackV1(assembled.bytes).records).toEqual(sorted);
  });

  it('keeps inspection non-inflating while full verification rejects corrupt gzip data', () => {
    const pack = fixturePack();
    const corrupted = pack.bytes.slice();
    corrupted[corrupted.byteLength - 1] ^= 1;

    expect(inspectCodeGraphCheckpointPackV1(corrupted).verification).toBe('artifact-and-framing');
    expect(() => decodeCodeGraphCheckpointPackV1(corrupted)).toThrow(CodeGraphCheckpointPackError);
  });

  it('rejects concatenated gzip members even when framing and logical descriptors are self-consistent', () => {
    const pack = fixturePack();
    const concatenated = concatenateFirstGzipMember(pack);

    expect(inspectCodeGraphCheckpointPackV1(concatenated).verification).toBe('artifact-and-framing');
    expect(() => decodeCodeGraphCheckpointPackV1(concatenated)).toThrow(/concatenated gzip members/u);
  });

  it('rejects truncation, trailing bytes, descriptor mismatch, invalid magic, and hostile declared bounds', () => {
    const pack = fixturePack();
    expect(() => inspectCodeGraphCheckpointPackV1(pack.bytes.subarray(0, pack.bytes.byteLength - 1))).toThrow(
      CodeGraphCheckpointPackError,
    );
    expect(() => inspectCodeGraphCheckpointPackV1(join([pack.bytes, Uint8Array.of(0)]))).toThrow(/trailing/u);
    expect(() =>
      decodeCodeGraphCheckpointPackV1(pack.bytes, {
        expectedDigest: `sha256:${Effect.pipe('f', EffectString.repeat(64))}`,
      }),
    ).toThrow(/expected digest/u);

    const badMagic = pack.bytes.slice();
    badMagic[0] ^= 1;
    expect(() => inspectCodeGraphCheckpointPackV1(badMagic)).toThrow(/magic/u);
    expect(() => inspectCodeGraphCheckpointPackV1(pack.bytes, {limits: {maximumHeaderBytes: 16}})).toThrow(/header/u);
    expect(() => decodeCodeGraphCheckpointPackV1(pack.bytes, {limits: {maximumRecords: 1}})).toThrow(/record/u);
  });

  it('rejects unknown kinds, unsafe paths, duplicate identities, unsorted streams, and incomplete fact coverage', () => {
    expect(() => parseCodeGraphCheckpointRecordV1({kind: 'future-kind'})).toThrow(/Unknown/u);
    expect(() => parseCodeGraphCheckpointRecordV1({...fileRecord('../escape.ts'), path: '../escape.ts'})).toThrow(
      /safe repository/u,
    );
    expect(() =>
      parseCodeGraphCheckpointRecordV1({
        ...factRecord('src/a.ts'),
        facts: {diagnostics: [], edges: [], path: 'src/a.ts', symbols: [{unexpected: true}]},
      }),
    ).toThrow(/File-fact payload is invalid/u);
    expect(() =>
      parseCodeGraphCheckpointRecordV1({
        ...factRecord('src/a.ts'),
        cacheIdentity: `cgfd_${Effect.pipe('f', EffectString.repeat(40))}`,
      }),
    ).toThrow(/cache identity does not match/u);
    expect(() =>
      encodeCodeGraphCheckpointPackV1(metadataFor(2), [
        fileRecord('src/a.ts'),
        fileRecord('src/a.ts'),
        factRecord('src/a.ts'),
        factRecord('src/b.ts'),
      ]),
    ).toThrow(/duplicate/u);

    const unsorted = new CodeGraphCheckpointStreamEncoderV1(metadataFor(1));
    expect(() =>
      unsorted.write([factRecord('src/a.ts'), fileRecord('src/a.ts')], () => {
        throw new Error('No chunk should be emitted.');
      }),
    ).toThrow(/canonical order/u);

    const missingFact = new CodeGraphCheckpointStreamEncoderV1(metadataFor(1));
    missingFact.write([fileRecord('src/a.ts')], () => undefined);
    expect(() => missingFact.finish(() => undefined)).toThrow(/materialized fact/u);
  });

  it('binds portable attribution context to an exact graph file record', () => {
    const path = 'src/a.ts';
    const metadata = metadataWithAttribution(path);
    expect(() => encodeCodeGraphCheckpointPackV1(metadata, recordsFor([path]))).not.toThrow();
    expect(() =>
      encodeCodeGraphCheckpointPackV1(
        {
          ...metadata,
          reuse: {
            ...metadata.reuse!,
            inventory: {
              ...metadata.reuse!.inventory!,
              attributionFiles: [
                {...metadata.reuse!.inventory!.attributionFiles[0], blobSize: UTF8.encode(path).byteLength + 1},
              ],
            },
          },
        },
        recordsFor([path]),
      ),
    ).toThrow(/attribution context does not match its file record/u);
    expect(() =>
      encodeCodeGraphCheckpointPackV1(
        {
          ...metadata,
          reuse: {
            ...metadata.reuse!,
            inventory: {
              ...metadata.reuse!.inventory!,
              attributionFiles: [{...metadata.reuse!.inventory!.attributionFiles[0], path: 'src/missing.ts'}],
            },
          },
        },
        recordsFor([path]),
      ),
    ).toThrow(/not covered by exact graph file records/u);
  });

  it('rejects a mutated prepared spool before publishing an artifact descriptor', () => {
    const chunks: {bytes: Uint8Array; ordinal: number}[] = [];
    const encoder = new CodeGraphCheckpointStreamEncoderV1(metadataFor(1));
    encoder.write(recordsFor(['src/a.ts']).sort(compareCodeGraphCheckpointRecords), chunk => chunks.push(chunk));
    const prepared = encoder.finish(chunk => chunks.push(chunk));
    const writer = new CodeGraphCheckpointArtifactWriterV1(prepared);
    const mutated = chunks[0].bytes.slice();
    mutated[mutated.byteLength - 1] ^= 1;
    writer.write(mutated);
    expect(() => writer.finish()).toThrow(/spool digest/u);
  });
});

function metadataFor(eligibleFiles: number): CodeGraphCheckpointMetadataV1 {
  return {
    abi: {
      checkpointSemanticVersion: 1,
      graphSchemaVersion: 1,
      inventoryPolicyVersion: 1,
      languagePacks: [],
      lexicalLogicalFormatVersion: 1,
      pathPolicy: 'repository-relative-posix-v1',
      referenceResolutionVersion: 'resolution-v1',
      workspaceModelVersion: 'workspace-v1',
    },
    coverage: {eligibleFiles, excludedFiles: 0, reasons: [], state: 'complete'},
    repository: {
      caseMode: 'sensitive',
      displayName: 'checkpoint-fixture',
      objectFormat: 'sha1',
      repositoryId: SHA256_ZERO,
    },
    source: {
      commit: SHA1_ZERO,
      extractorSet: 'typescript-v1',
      graphContentId: `cgc_${SHA1_ZERO}`,
    },
  };
}

function metadataWithAttribution(path: string): CodeGraphCheckpointMetadataV1 {
  return {
    ...metadataFor(1),
    reuse: {
      fileSetFingerprint: SHA256_ZERO,
      formatVersion: 2,
      inventory: {
        attributionFiles: [
          {
            blobId: SHA1_ZERO,
            blobSize: UTF8.encode(path).byteLength,
            contentHash: SHA256_ZERO,
            language: 'typescript',
            mode: '100644',
            path,
            size: 0,
            source: 'commit',
          },
        ],
        contract: SHA256_ZERO,
        includeOpaqueCorpusAssets: false,
        policyExclusions: {bytes: 0, files: 0, policyVersion: 1, reasons: []},
        skipped: 0,
        version: 2,
        workspace: {diagnostics: [], fingerprint: SHA256_ZERO, projects: [], workspaces: []},
      },
      resolutionSurfaceVersion: 1,
      workspaceFingerprint: SHA256_ZERO,
    },
  };
}

function recordsFor(paths: readonly string[]): CodeGraphCheckpointRecordV1[] {
  return EffectArray.flatMap(paths, path => [fileRecord(path), factRecord(path)]);
}

function fileRecord(path: string): CodeGraphCheckpointFileRecordV1 {
  return {
    blobId: SHA1_ZERO,
    contentHash: SHA256_ZERO,
    kind: 'file',
    language: 'typescript',
    mode: '100644',
    path,
    size: UTF8.encode(path).byteLength,
    source: 'commit',
  };
}

function factRecord(path: string): CodeGraphCheckpointFileFactRecordV1 {
  const facts = {diagnostics: [], edges: [], path, symbols: []};
  return {
    cacheIdentity: codeGraphCheckpointFileFactCacheIdentity(facts),
    factRole: 'materialized',
    facts,
    kind: 'file-fact',
    path,
  };
}

function fixturePack(): CodeGraphCheckpointEncodedPackV1 {
  return encodeCodeGraphCheckpointPackV1(metadataFor(1), recordsFor(['src/a.ts']));
}

function concatenateFirstGzipMember(pack: CodeGraphCheckpointEncodedPackV1): Uint8Array {
  const originalHeaderBytes = UTF8.encode(canonicalJson(pack.header)).byteLength;
  const payloadOffset = 24 + originalHeaderBytes + 52;
  const originalPayload = pack.bytes.subarray(payloadOffset);
  const payload = join([originalPayload, originalPayload]);
  const chunk = pack.header.chunks[0];
  const header: CodeGraphCheckpointHeaderV1 = {
    ...pack.header,
    chunks: [{...chunk, compressedBytes: payload.byteLength}],
  };
  const headerBytes = UTF8.encode(canonicalJson(header));
  const prelude = new Uint8Array(24);
  prelude.set(pack.bytes.subarray(0, 16));
  const preludeView = new DataView(prelude.buffer);
  preludeView.setUint32(16, 1, false);
  preludeView.setUint32(20, headerBytes.byteLength, false);
  const frame = new Uint8Array(52);
  frame.set(pack.bytes.subarray(24 + originalHeaderBytes, payloadOffset));
  new DataView(frame.buffer).setUint32(8, payload.byteLength, false);
  return join([prelude, headerBytes, frame, payload]);
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(EffectArray.reduce(parts, 0, (total, part) => total + part.byteLength));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
