import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import * as FC from 'fast-check';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {codeGraphCheckpointFileFactCacheIdentity} from '@threadnote/graph/checkpoint/file_fact_identity';
import {decodeCodeGraphCheckpointPackV1, encodeCodeGraphCheckpointPackV1} from '@threadnote/graph/checkpoint/pack';
import type {
  CodeGraphCheckpointFileFactRecordV1,
  CodeGraphCheckpointFileRecordV1,
  CodeGraphCheckpointMetadataV1,
  CodeGraphCheckpointRecordV1,
} from '@threadnote/graph/checkpoint/schema';
import {GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE, parseGraphShareFrontierManifest} from '@threadnote/graph/sharing/artifacts';
import {casBlobPath, putCasBytes, putCasFile} from '@threadnote/graph/sharing/cas';
import {
  assembleGraphShareCheckpointLayers,
  ensureGraphShareCheckpointArtifact,
  parseGraphShareCheckpointMetadata,
  putGraphShareCheckpointLayers,
} from '@threadnote/graph/sharing/checkpoint_cas';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {GraphSharingError} from '@threadnote/graph/sharing/errors';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from '@threadnote/graph/sharing/oci';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const sharingLayer = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, TestSystemInfoLayer);

const SHA256_ZERO = Effect2.pipe('0', EffectString.repeat(64));
const SHA1_ZERO = Effect2.pipe('0', EffectString.repeat(40));
const UTF8 = new TextEncoder();

const pathArbitrary = FC.uniqueArray(
  FC.array(FC.constantFrom('a', 'b', 'Z', '0', '-', '_'), {maxLength: 8, minLength: 1}).map(
    characters => `src/${EffectArray.join(characters, '')}.ts`,
  ),
  {maxLength: 10, minLength: 3},
);

describe('graph share checkpoint CAS layers', () => {
  fcEffectProp(
    effectIt,
    'prefix plus ordered TCG1 frames concatenate to the artifact digest and stay under the HTTP CAS cap',
    {paths: pathArbitrary},
    ({paths}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-layers-'});
        const casRoot = path.join(home, 'cas');
        const pack = encodeCodeGraphCheckpointPackV1(metadataFor(paths.length), recordsFor(paths), {
          limits: {targetUncompressedChunkBytes: 500},
        });
        const artifactPath = path.join(home, 'artifact.cgcp');
        yield* fs.writeFile(artifactPath, pack.bytes);
        const artifactDigest = yield* putCasFile(casRoot, artifactPath);
        expect(artifactDigest).toBe(parseSha256FromDescriptor(pack.descriptor.digest));
        const published = yield* putGraphShareCheckpointLayers(casRoot, artifactDigest);
        expect(published.metadata.artifactDigest).toBe(artifactDigest);
        expect(published.metadata.mediaType).toBe(GRAPH_SHARE_CHECKPOINT_MEDIA_TYPE);
        expect(published.metadata.chunks.length).toBe(pack.header.chunks.length);
        const prefix = new Uint8Array(yield* fs.readFile(yield* casBlobPath(casRoot, published.metadata.prefixDigest)));
        expect(prefix.byteLength).toBeLessThanOrEqual(GRAPH_SHARE_HTTP_CAS_MAX_BYTES);
        const frames: Uint8Array[] = [];
        for (const chunk of published.metadata.chunks) {
          const frame = new Uint8Array(yield* fs.readFile(yield* casBlobPath(casRoot, chunk.digest)));
          expect(frame.byteLength).toBeLessThanOrEqual(GRAPH_SHARE_HTTP_CAS_MAX_BYTES);
          frames.push(frame);
        }
        const assembled = joinBytes([prefix, ...frames]);
        expect(assembled).toEqual(pack.bytes);
        expect(sha256Digest(assembled)).toBe(artifactDigest);
        expect(sha256Digest(assembled)).toBe(pack.descriptor.digest);
        const parsed = parseGraphShareCheckpointMetadata(JSON.parse(canonicalJson(published.metadata)) as unknown);
        expect(parsed).toEqual(published.metadata);
        const decoded = decodeCodeGraphCheckpointPackV1(assembled, {expectedDigest: artifactDigest});
        expect(decoded.verification).toBe('full');
      }).pipe(provideTestLayer(sharingLayer)),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect(
    'assembles layers on disk then round-trips a multi-chunk pack without buffering the artifact over HTTP',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-assemble-'});
        const publisherCas = path.join(home, 'publisher-cas');
        const clientCas = path.join(home, 'client-cas');
        const pack = encodeCodeGraphCheckpointPackV1(
          metadataFor(4),
          recordsFor(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']),
          {limits: {targetUncompressedChunkBytes: 400}},
        );
        expect(pack.header.chunks.length).toBeGreaterThan(1);
        const artifactPath = path.join(home, 'artifact.cgcp');
        yield* fs.writeFile(artifactPath, pack.bytes);
        const artifactDigest = yield* putCasFile(publisherCas, artifactPath);
        const published = yield* putGraphShareCheckpointLayers(publisherCas, artifactDigest);
        yield* putCasBytes(clientCas, yield* fs.readFile(yield* casBlobPath(publisherCas, published.metadataDigest)));
        yield* putCasBytes(
          clientCas,
          yield* fs.readFile(yield* casBlobPath(publisherCas, published.metadata.prefixDigest)),
        );
        for (const chunk of published.metadata.chunks) {
          yield* putCasBytes(clientCas, yield* fs.readFile(yield* casBlobPath(publisherCas, chunk.digest)));
        }
        const spool = path.join(home, 'assembled.cgcp');
        const assembledDigest = yield* assembleGraphShareCheckpointLayers(clientCas, published.metadata, spool);
        expect(assembledDigest).toBe(artifactDigest);
        expect(new Uint8Array(yield* fs.readFile(spool))).toEqual(pack.bytes);
        expect(
          decodeCodeGraphCheckpointPackV1(new Uint8Array(yield* fs.readFile(spool)), {expectedDigest: artifactDigest})
            .verification,
        ).toBe('full');
        const ensured = yield* ensureGraphShareCheckpointArtifact({
          artifactDigest,
          casRoot: clientCas,
          metadataDigest: published.metadataDigest,
        });
        expect(new Uint8Array(yield* fs.readFile(ensured))).toEqual(pack.bytes);
      }).pipe(provideTestLayer(sharingLayer)),
  );

  effectIt.effect('fail-closes when the assembled blob and checkpoint metadata are both missing', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-share-missing-meta-'});
      const casRoot = path.join(home, 'cas');
      const missing = yield* ensureGraphShareCheckpointArtifact({
        artifactDigest: sha256Digest('missing-assembled-checkpoint'),
        casRoot,
      }).pipe(
        Effect.as(false),
        Effect.catchIf(
          error => Schema.is(GraphSharingError)(error) && error.kind === 'unavailable',
          () => Effect.succeed(true),
        ),
      );
      expect(missing).toBe(true);
    }).pipe(provideTestLayer(sharingLayer)),
  );
});

describe('graph share frontier checkpoint metadataDigest', () => {
  effectIt.effect('accepts three-key checkpoints and optional metadataDigest without unknown keys', () =>
    Effect.sync(() => {
      const digest = sha256Digest('checkpoint');
      const metadataDigest = sha256Digest('metadata');
      const base = {
        branch: 'refs/heads/main',
        deltas: [] as const,
        generation: 1,
        graphAbi: Effect2.pipe('e', EffectString.repeat(64)),
        graphContentId: `cgc_${Effect2.pipe('d', EffectString.repeat(40))}`,
        logicalGraphDigest: digest,
        previousManifestDigest: null,
        profileDigest: digest,
        publisherFence: 1,
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        schemaVersion: 1,
        snapshotId: 'cgsn_imported',
        sourceCommit: Effect2.pipe('a', EffectString.repeat(40)),
      };
      const threeKey = parseGraphShareFrontierManifest({
        ...base,
        checkpoint: {
          manifestDigest: digest,
          snapshotId: 'cgsn_imported',
          sourceCommit: Effect2.pipe('a', EffectString.repeat(40)),
        },
      });
      expect(threeKey.checkpoint.metadataDigest).toBeUndefined();
      const withMetadata = parseGraphShareFrontierManifest({
        ...base,
        checkpoint: {
          manifestDigest: digest,
          metadataDigest,
          snapshotId: 'cgsn_imported',
          sourceCommit: Effect2.pipe('a', EffectString.repeat(40)),
        },
      });
      expect(withMetadata.checkpoint.metadataDigest).toBe(metadataDigest);
      expect(withMetadata.checkpoint.manifestDigest).toBe(digest);
      expect(() =>
        parseGraphShareFrontierManifest({
          ...base,
          checkpoint: {
            extra: true,
            manifestDigest: digest,
            snapshotId: 'cgsn_imported',
            sourceCommit: Effect2.pipe('a', EffectString.repeat(40)),
          },
        }),
      ).toThrow(/unsupported/i);
    }),
  );
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

function parseSha256FromDescriptor(digest: string) {
  return Effect2.pipe(digest, EffectString.startsWith('sha256:')) ? digest : sha256Digest(digest);
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(EffectArray.reduce(parts, 0, (total, part) => total + part.byteLength));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
