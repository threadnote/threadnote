import {Array as EffectArray} from 'effect';
import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withCodeGraphCheckpointAuthorityVerification} from '@threadnote/graph/checkpoint/authority';
import {codeGraphCheckpointFileFactCacheIdentity} from '@threadnote/graph/checkpoint/file_fact_identity';
import {encodeCodeGraphCheckpointPackV1} from '@threadnote/graph/checkpoint/pack';
import {
  CODE_GRAPH_CHECKPOINT_PATH_POLICY,
  CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
  type CodeGraphCheckpointFileFactRecordV1,
  type CodeGraphCheckpointFileRecordV1,
  type CodeGraphCheckpointMetadataV1,
} from '@threadnote/graph/checkpoint/schema';
import {
  codeGraphContentIdentity,
  codeGraphExtractorSetIdentityFromPackProvenance,
} from '@threadnote/graph/graph_identity';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const authorityLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

describe('code graph checkpoint authority', () => {
  effectIt.effect('rejects a scoped graph content identity replayed in a legacy full checkpoint', () =>
    Effect.gen(function* () {
      const records = [fileRecord('src/value.ts')];
      const header = headerFor(records);
      const scoped = {
        ...header,
        source: {
          ...header.source,
          graphContentId: codeGraphContentIdentity(header.source.extractorSet, records, {
            scopeKey: `code-graph-scope:${Effect2.pipe('a', EffectString.repeat(64))}`,
            definitionDigest: Effect2.pipe('b', EffectString.repeat(64)),
            closureDigest: Effect2.pipe('c', EffectString.repeat(64)),
          }),
        },
      };
      const error = yield* withCodeGraphCheckpointAuthorityVerification(scoped, accept => accept(records)).pipe(
        Effect.flip,
      );
      expect(String(error)).toContain('graph content identity does not match');
    }).pipe(provideTestLayer(authorityLayer)),
  );
  effectIt.effect('orders the private SQLite spool canonically across its Unicode keyset boundary', () =>
    Effect.gen(function* () {
      const paths = [
        ...Array.from(
          {length: 999},
          (_, index) => `src/a${Effect2.pipe(index.toString(), EffectString.padStart(4, '0'))}.ts`,
        ),
        'src/\ue000.ts',
        'src/\u{10000}.ts',
      ];
      const files = EffectArray.map(paths, fileRecord);
      const records = EffectArray.flatMap(files, file => [file, factRecord(file.path)]);

      expect(
        yield* withCodeGraphCheckpointAuthorityVerification(headerFor(files), accept =>
          accept([...records].reverse()).pipe(Effect.as(records.length)),
        ),
      ).toBe(2_002);

      expect(
        yield* withCodeGraphCheckpointAuthorityVerification(headerFor([]), accept =>
          accept([]).pipe(Effect.as('empty')),
        ),
      ).toBe('empty');
    }).pipe(provideTestLayer(authorityLayer)),
  );
});

function headerFor(records: readonly CodeGraphCheckpointFileRecordV1[]) {
  const extractorSet = codeGraphExtractorSetIdentityFromPackProvenance([]);
  const metadata: CodeGraphCheckpointMetadataV1 = {
    abi: {
      checkpointSemanticVersion: CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
      graphSchemaVersion: 1,
      inventoryPolicyVersion: 1,
      languagePacks: [],
      lexicalLogicalFormatVersion: 1,
      pathPolicy: CODE_GRAPH_CHECKPOINT_PATH_POLICY,
      referenceResolutionVersion: 'resolution-v1',
      workspaceModelVersion: 'workspace-v1',
    },
    coverage: {eligibleFiles: records.length, excludedFiles: 0, reasons: [], state: 'complete'},
    repository: {
      caseMode: 'sensitive',
      displayName: 'authority-ordering-fixture',
      objectFormat: 'sha1',
      repositoryId: Effect2.pipe('0', EffectString.repeat(64)),
    },
    source: {
      commit: Effect2.pipe('0', EffectString.repeat(40)),
      extractorSet,
      graphContentId: codeGraphContentIdentity(extractorSet, records),
    },
  };
  return encodeCodeGraphCheckpointPackV1(
    metadata,
    EffectArray.flatMap(records, record => [record, factRecord(record.path)]),
  ).header;
}

function fileRecord(path: string): CodeGraphCheckpointFileRecordV1 {
  const contentHash = sha256HexSync(path);
  return {
    blobId: Effect2.pipe(contentHash, EffectString.slice(0, 40)),
    contentHash,
    kind: 'file',
    language: 'typescript',
    mode: '100644',
    path,
    size: 0,
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
