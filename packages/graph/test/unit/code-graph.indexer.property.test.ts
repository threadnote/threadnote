import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import fc from 'fast-check';
import {
  addMaterializationReplayMetrics,
  addMaterializationRows,
  CODE_GRAPH_MATERIALIZATION_STORAGE_HEURISTIC_MODEL_VERSION,
  compactCachedFileRelationships,
  codeGraphActiveParserCacheKey,
  codeGraphInventoryNeedsSynchronousReclamation,
  codeGraphParserCacheLookupGenerations,
  deduplicateMaterializationRelationships,
  emptyMaterializationReplayMetrics,
  estimatedMaterializationStorageBytes,
  factMaterializationBatches,
  graphContentIdentity,
  extractorSetIdentity,
  materializationRowsWithStoreProgress,
  materializationStoragePlan,
  materializationStorageShortfalls,
  persistentMaterializationTransactionBatches,
  snapshotIdentity,
  sparseOverlayGraphContentIdentity,
  sparseOverlaySnapshotIdentity,
} from '@threadnote/graph/indexer';
import {codeGraphDirectPersistentCapacityDemand, evaluateCodeGraphDiskCapacity} from '@threadnote/graph/disk/capacity';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
  materializedBatchShardDerivationIdentity,
  materializedFileShardIdentity,
  materializedShardRepositorySemanticEnvelope,
  materializedShardDerivationIdentity,
  persistentFullShardPublicationPlan,
} from '@threadnote/graph/store';
import type {CodeGraphEdge, CodeGraphMaterializationRows, CodeGraphReference} from '@threadnote/graph/types';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const byteCount = FC.integer({max: Number.MAX_SAFE_INTEGER, min: 0});
const materializationRowCount = FC.integer({max: 1_000_000, min: 0});
const materializationRows = FC.record({
  deduplicatedEdges: materializationRowCount,
  deduplicatedReferences: materializationRowCount,
  edges: materializationRowCount,
  lookupKeys: materializationRowCount,
  referenceCandidates: materializationRowCount,
  references: materializationRowCount,
  reexports: materializationRowCount,
  symbols: materializationRowCount,
  terms: materializationRowCount,
});

describe('code graph indexer properties', () => {
  fcProp(
    it,
    'requires synchronous reclamation monotonically for retained source bytes but not omitted payload size',
    {
      retainedSizes: FC.array(FC.integer({max: 8 * 1_048_576, min: 0}), {maxLength: 64}),
      extraRetainedSize: FC.integer({max: 8 * 1_048_576, min: 0}),
      omittedSize: FC.integer({max: 64 * 1_048_576, min: 0}),
    },
    ({extraRetainedSize, omittedSize, retainedSizes}) => {
      const retained = EffectArray.map(retainedSizes, size => ({content: '', size}));
      const before = codeGraphInventoryNeedsSynchronousReclamation(retained);
      const after = codeGraphInventoryNeedsSynchronousReclamation([
        ...retained,
        {content: '', size: extraRetainedSize},
      ]);

      expect(before && !after).toBe(false);
      expect(codeGraphInventoryNeedsSynchronousReclamation([{content: undefined, size: omittedSize}])).toBe(false);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('retains exact synchronous reclamation boundaries for file count and resident source bytes', () => {
    expect(
      codeGraphInventoryNeedsSynchronousReclamation(Array.from({length: 511}, () => ({content: '', size: 0}))),
    ).toBe(false);
    expect(
      codeGraphInventoryNeedsSynchronousReclamation(Array.from({length: 512}, () => ({content: '', size: 0}))),
    ).toBe(true);
    expect(codeGraphInventoryNeedsSynchronousReclamation([{content: 'x', size: 16 * 1_048_576}])).toBe(true);
  });

  fcProp(
    it,
    'keeps physical replay components bounded, order-independent, and equal to their combined counter',
    {
      observations: FC.array(
        FC.record({
          attributedFiles: byteCount,
          crossGenerationShardFiles: byteCount,
          exactGenerationShardFiles: byteCount,
          materializedShardCacheDeferredFiles: byteCount,
          materializedShardCacheDeferredRawFactBytes: byteCount,
          materializedShardReplayBytes: byteCount,
          rawFactReplayBytes: byteCount,
        }),
        {maxLength: 24},
      ),
    },
    ({observations}) => {
      const aggregate = EffectArray.reduce(
        observations,
        emptyMaterializationReplayMetrics(),
        addMaterializationReplayMetrics,
      );
      const reversed = EffectArray.reduce(
        [...observations].reverse(),
        emptyMaterializationReplayMetrics(),
        addMaterializationReplayMetrics,
      );
      const bounded = (values: readonly number[]): number => {
        const exact = EffectArray.reduce(values, 0n, (total, value) => total + BigInt(value));
        return Number(exact > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : exact);
      };
      const expectedRaw = bounded(EffectArray.map(observations, observation => observation.rawFactReplayBytes));
      const expectedMaterialized = bounded(
        EffectArray.map(observations, observation => observation.materializedShardReplayBytes),
      );
      const expectedAttributed = bounded(EffectArray.map(observations, observation => observation.attributedFiles));
      const expectedCrossGeneration = bounded(
        EffectArray.map(observations, observation => observation.crossGenerationShardFiles),
      );
      const expectedExactGeneration = bounded(
        EffectArray.map(observations, observation => observation.exactGenerationShardFiles),
      );
      const expectedDeferredFiles = bounded(
        EffectArray.map(observations, observation => observation.materializedShardCacheDeferredFiles),
      );
      const expectedDeferredRawFactBytes = bounded(
        EffectArray.map(observations, observation => observation.materializedShardCacheDeferredRawFactBytes),
      );

      expect(aggregate).toEqual(reversed);
      expect(aggregate.attributedFilesCompleted).toBe(expectedAttributed);
      expect(aggregate.crossGenerationShardFilesCompleted).toBe(expectedCrossGeneration);
      expect(aggregate.exactGenerationShardFilesCompleted).toBe(expectedExactGeneration);
      expect(aggregate.materializedShardCacheDeferredFilesCompleted).toBe(expectedDeferredFiles);
      expect(aggregate.materializedShardCacheDeferredRawFactBytesCompleted).toBe(expectedDeferredRawFactBytes);
      expect(aggregate.rawFactReplayBytesCompleted).toBe(expectedRaw);
      expect(aggregate.materializedShardReplayBytesCompleted).toBe(expectedMaterialized);
      expect(aggregate.cachedFactReplayBytesCompleted).toBe(bounded([expectedRaw, expectedMaterialized]));
      expect(
        EffectArray.every(EffectRecord.values(aggregate), value => Number.isSafeInteger(value) && value >= 0),
      ).toBe(true);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'admits both active and degraded parser cache generations deterministically',
    {
      activeIdentities: FC.uniqueArray(FC.string({maxLength: 80, minLength: 1}), {maxLength: 8}),
    },
    ({activeIdentities}) => {
      const generations = codeGraphParserCacheLookupGenerations(activeIdentities);
      const expected = EffectArray.flatMap([...new Set(activeIdentities)].sort(), activeIdentity => [
        {activeIdentity, storedIdentity: activeIdentity},
        {
          activeIdentity,
          storedIdentity: sha256HexSync(`code-graph-parser-degraded-v1\n${activeIdentity}`),
        },
      ]);

      expect(generations).toEqual(expected);
      expect(codeGraphParserCacheLookupGenerations([...activeIdentities].reverse())).toEqual(generations);
      for (const generation of generations) {
        expect(
          codeGraphActiveParserCacheKey(
            `src/file.ts\0content-hash\0${generation.storedIdentity}`,
            generation.storedIdentity,
            generation.activeIdentity,
          ),
        ).toBe(`src/file.ts\0content-hash\0${generation.activeIdentity}`);
        expect(
          codeGraphActiveParserCacheKey(
            `blob\0blob-id\0content-hash\0${generation.storedIdentity}\0reuse-class`,
            generation.storedIdentity,
            generation.activeIdentity,
          ),
        ).toBe(`blob\0blob-id\0content-hash\0${generation.activeIdentity}\0reuse-class`);
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps extractor selection independent of content while detecting active pack changes', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1}), fc.string({minLength: 1}), (leftHash, rightHash) => {
        const paths = [
          {contentHash: leftHash, path: 'MODULE.bazel'},
          {contentHash: leftHash, path: 'src/index.ts'},
          {contentHash: leftHash, path: 'tsconfig.json'},
        ];
        const changedContent = EffectArray.map(paths, file => ({...file, contentHash: rightHash}));
        const identity = extractorSetIdentity(paths);

        expect(extractorSetIdentity(changedContent)).toBe(identity);
        expect(extractorSetIdentity([...paths].reverse())).toBe(identity);
        expect(extractorSetIdentity([...paths, {contentHash: leftHash, path: 'src/tool.py'}])).not.toBe(identity);
      }),
      {numRuns: 100},
    );
  });

  it('includes the compact lexical format in deterministic snapshot identity', () => {
    const identity = {
      headCommit: Effect.pipe('a', EffectString.repeat(40)),
      repositoryId: Effect.pipe('b', EffectString.repeat(64)),
      worktreeId: Effect.pipe('c', EffectString.repeat(64)),
    };
    const files = [{contentHash: Effect.pipe('d', EffectString.repeat(64)), path: 'src/index.ts', source: 'commit'}];
    const extractorSet = 'extractor-set';
    const inventory = `${files[0].path}\0${files[0].contentHash}\0${files[0].source}`;
    const expected = Effect.pipe(
      sha256HexSync(
        `snapshot-v2\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${identity.repositoryId}\nshared-commit\n${identity.headCommit}\nclean\n${extractorSet}\n${inventory}`,
      ),
      EffectString.slice(0, 40),
    );

    expect(snapshotIdentity(identity, false, extractorSet, files)).toBe(`cgsn_${expected}`);
  });

  it('binds sparse overlay identity to every persisted-base observation without enumerating the base', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (base, extractor, overlay, worktree) => {
        const identity = {headCommit: 'head', repositoryId: 'repository', worktreeId: worktree};
        const snapshot = sparseOverlaySnapshotIdentity(identity, base, extractor, overlay);
        const legacySnapshot = `cgsn_${Effect.pipe(
          sha256HexSync(
            `snapshot-sparse-overlay-v1\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${identity.repositoryId}\n${identity.worktreeId}\n${identity.headCommit}\n${base}\n${extractor}\n${overlay}`,
          ),
          EffectString.slice(0, 40),
        )}`;

        expect(sparseOverlaySnapshotIdentity(identity, base, extractor, overlay)).toBe(snapshot);
        expect(snapshot).not.toBe(legacySnapshot);
        expect(sparseOverlaySnapshotIdentity(identity, `${base}\0changed`, extractor, overlay)).not.toBe(snapshot);
        expect(sparseOverlaySnapshotIdentity(identity, base, `${extractor}\0changed`, overlay)).not.toBe(snapshot);
        expect(sparseOverlaySnapshotIdentity(identity, base, extractor, `${overlay}\0changed`)).not.toBe(snapshot);
        expect(
          sparseOverlaySnapshotIdentity({...identity, worktreeId: `${worktree}\0changed`}, base, extractor, overlay),
        ).not.toBe(snapshot);
      }),
      {numRuns: 250},
    );
  });

  it('binds sparse graph content to base content and overlay without worktree identity', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (base, extractor, overlay) => {
        const content = sparseOverlayGraphContentIdentity(base, extractor, overlay);
        const legacyContent = `cgc_${Effect.pipe(
          sha256HexSync(
            `graph-content-sparse-overlay-v1\nlexical-storage:${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}\n${base}\n${extractor}\n${overlay}`,
          ),
          EffectString.slice(0, 40),
        )}`;
        expect(sparseOverlayGraphContentIdentity(base, extractor, overlay)).toBe(content);
        expect(content).not.toBe(legacyContent);
        expect(content).toMatch(/^cgc_[0-9a-f]{40}$/u);
        expect(sparseOverlayGraphContentIdentity(`${base}\0changed`, extractor, overlay)).not.toBe(content);
        expect(sparseOverlayGraphContentIdentity(base, `${extractor}\0changed`, overlay)).not.toBe(content);
        expect(sparseOverlayGraphContentIdentity(base, extractor, `${overlay}\0changed`)).not.toBe(content);
      }),
      {numRuns: 250},
    );
  });

  it('keeps graph content identity independent of commit order while detecting every eligible content change', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            contentHash: fc.string({maxLength: 64, minLength: 1}),
            language: fc.constantFrom('typescript', 'python', 'markdown'),
            mode: fc.constantFrom('100644', '100755'),
            path: fc.stringMatching(/^[a-z][a-z0-9]{0,8}\.ts$/),
          }),
          {minLength: 1, selector: file => file.path},
        ),
        files => {
          const original = graphContentIdentity('extractor-set', files);
          expect(graphContentIdentity('extractor-set', [...files].reverse())).toBe(original);

          const changed = EffectArray.map(files, (file, index) =>
            index === 0 ? {...file, contentHash: `${file.contentHash}0`} : file,
          );
          expect(graphContentIdentity('extractor-set', changed)).not.toBe(original);
          expect(graphContentIdentity('other-extractor-set', files)).not.toBe(original);
        },
      ),
      {numRuns: 250},
    );
  });

  it('makes materialized shard identity content-addressed and derivation-context sensitive', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (extractor, workspace, graphContent, path) => {
        const derivation = materializedShardDerivationIdentity(extractor, workspace, graphContent);
        const shard = materializedFileShardIdentity('content-hash', extractor, derivation, path);
        expect(materializedFileShardIdentity('content-hash', extractor, derivation, path)).toBe(shard);
        expect(materializedFileShardIdentity('changed-content', extractor, derivation, path)).not.toBe(shard);
        expect(materializedFileShardIdentity('content-hash', extractor, derivation, `${path}/changed`)).not.toBe(shard);
        expect(materializedShardDerivationIdentity(extractor, workspace, `${graphContent}/changed`)).not.toBe(
          derivation,
        );
      }),
      {numRuns: 250},
    );
  });

  it('does not admit materialized shards derived by the partition-dependent v2 algorithm', () => {
    const extractor = 'extractor-set';
    const workspace = 'workspace-fingerprint';
    const graphContent = 'graph-content';
    const legacy = `cgfd_${Effect.pipe(
      sha256HexSync(`materialized-file-derivation-v2\n${extractor}\n${workspace}\n${graphContent}`),
      EffectString.slice(0, 40),
    )}`;

    expect(materializedShardDerivationIdentity(extractor, workspace, graphContent)).not.toBe(legacy);
  });

  it('derives v4 batch identities from an independently canonicalized repository envelope', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            contentHash: fc.stringMatching(/^[a-f0-9]{1,24}$/),
            language: fc.constantFrom('typescript', 'python', 'markdown'),
            mode: fc.constantFrom('100644', '100755'),
            path: fc.stringMatching(/^src\/[a-z][a-z0-9]{0,8}\.ts$/),
            source: fc.constant<'commit'>('commit'),
          }),
          {maxLength: 20, minLength: 3, selector: file => file.path},
        ),
        files => {
          const canonicalEntries = EffectArray.map(
            [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
            file => [file.path, file.language, file.mode, null],
          );
          const expectedEnvelope = `cgfe_${Effect.pipe(
            sha256HexSync(`materialized-repository-semantic-envelope-v1\n${JSON.stringify(canonicalEntries)}`),
            EffectString.slice(0, 40),
          )}`;
          const envelope = materializedShardRepositorySemanticEnvelope(files);
          const batch = files.slice(0, 2);
          const expectedDerivation = `cgfd_${Effect.pipe(
            sha256HexSync(
              `materialized-file-derivation-v4\nextractor\nworkspace\n${expectedEnvelope}\n${JSON.stringify(
                EffectArray.map(batch, file => [file.path, file.contentHash, file.language, file.mode, file.source]),
              )}`,
            ),
            EffectString.slice(0, 40),
          )}`;
          const derivation = materializedBatchShardDerivationIdentity('extractor', 'workspace', envelope, batch);
          const outsideBodyChanged = EffectArray.map(files, (file, index) =>
            index === 2 ? {...file, contentHash: `${file.contentHash}0`, source: 'worktree' as const} : file,
          );

          expect(envelope).toBe(expectedEnvelope);
          expect(materializedShardRepositorySemanticEnvelope([...files].reverse())).toBe(envelope);
          expect(derivation).toBe(expectedDerivation);
          expect(materializedBatchShardDerivationIdentity('extractor-v2', 'workspace', envelope, batch)).not.toBe(
            derivation,
          );
          expect(materializedBatchShardDerivationIdentity('extractor', 'workspace-v2', envelope, batch)).not.toBe(
            derivation,
          );
          expect(
            materializedBatchShardDerivationIdentity('extractor', 'workspace', envelope, [...batch].reverse()),
          ).not.toBe(derivation);
          expect(
            materializedBatchShardDerivationIdentity('extractor', 'workspace', envelope, [
              {...batch[0], contentHash: `${batch[0].contentHash}0`},
              batch[1],
            ]),
          ).not.toBe(derivation);
          expect(
            materializedBatchShardDerivationIdentity(
              'extractor',
              'workspace',
              materializedShardRepositorySemanticEnvelope(outsideBodyChanged),
              batch,
            ),
          ).toBe(derivation);
        },
      ),
      {numRuns: 200},
    );
  });

  it('invalidates v4 repository envelopes on retained context or path membership changes', () => {
    const source = {
      contentHash: 'source-a',
      language: 'typescript',
      mode: '100644',
      path: 'src/index.ts',
      source: 'commit' as const,
    };
    const packageManifest = {
      contentHash: 'package-a',
      language: 'npm-manifest',
      mode: '100644',
      path: 'package.json',
      source: 'commit' as const,
    };
    const tsconfig = {
      contentHash: 'tsconfig-a',
      language: 'typescript-config',
      mode: '100644',
      path: 'tsconfig.json',
      source: 'commit' as const,
    };
    const files = [packageManifest, source, tsconfig];
    const envelope = materializedShardRepositorySemanticEnvelope(files);

    expect(
      materializedShardRepositorySemanticEnvelope([{...source, contentHash: 'source-b'}, packageManifest, tsconfig]),
    ).toBe(envelope);
    expect(
      materializedShardRepositorySemanticEnvelope([{...packageManifest, contentHash: 'package-b'}, source, tsconfig]),
    ).not.toBe(envelope);
    expect(
      materializedShardRepositorySemanticEnvelope([packageManifest, source, {...tsconfig, contentHash: 'tsconfig-b'}]),
    ).not.toBe(envelope);
    expect(materializedShardRepositorySemanticEnvelope([packageManifest, tsconfig])).not.toBe(envelope);
    expect(materializedBatchShardDerivationIdentity('extractor', 'workspace', envelope, [source])).not.toBe(
      materializedShardDerivationIdentity('extractor', 'workspace', 'graph-content'),
    );
  });

  it('skips the legacy repository-wide shard scan and file reserve after v4 batch association', () => {
    expect(persistentFullShardPublicationPlan(2, true, 7)).toEqual({
      associateLegacyMaterializedFileShards: false,
      rowCount: 20,
    });
    expect(persistentFullShardPublicationPlan(2, false, 7)).toEqual({
      associateLegacyMaterializedFileShards: true,
      rowCount: 22,
    });
    expect(Number.isNaN(persistentFullShardPublicationPlan(2, true, -1).rowCount)).toBe(true);
  });

  it('splits high-density low-source-byte facts before one SQLite writer transaction becomes pathological', () => {
    const files = Array.from({length: 7}, (_, index) => ({path: `src/dense-${index}.ts`, size: 32}));
    const factBytes = new Map(EffectArray.map(files, file => [file.path, 4 * 1_048_576]));
    const batches = factMaterializationBatches(files, factBytes);

    expect(EffectArray.map(batches, batch => batch.length)).toEqual([2, 2, 2, 1]);
    expect(
      EffectArray.every(
        batches,
        batch => EffectArray.reduce(batch, 0, (total, file) => total + factBytes.get(file.path)!) <= 8 * 1_048_576,
      ),
    ).toBe(true);
    expect(factMaterializationBatches(files, factBytes)).toEqual(batches);
  });

  it('keeps 128-file logical receipt boundaries stable across interrupted-build upgrades', () => {
    const files = Array.from({length: 129}, (_, index) => ({path: `src/file-${index}.ts`, size: 1}));
    const factBytes = new Map(EffectArray.map(files, file => [file.path, 1]));

    expect(EffectArray.map(factMaterializationBatches(files, factBytes), batch => batch.length)).toEqual([128, 1]);
  });

  it('coalesces logical receipts deterministically, contiguously, and exactly once within physical bounds', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            factBytes: FC.integer({max: 40 * 1_048_576, min: 0}),
            fileCount: FC.integer({max: 700, min: 0}),
            id: FC.nat(),
            sourceBytes: FC.integer({max: 80 * 1_048_576, min: 0}),
          }),
          {maxLength: 40},
        ),
        candidates => {
          const groups = persistentMaterializationTransactionBatches(candidates);

          expect(persistentMaterializationTransactionBatches(candidates)).toEqual(groups);
          expect(groups.flat()).toEqual(candidates);
          expect(EffectArray.every(groups, group => group.length > 0 && group.length <= 4)).toBe(true);
          let cursor = 0;
          for (const group of groups) {
            expect(group).toEqual(candidates.slice(cursor, cursor + group.length));
            cursor += group.length;
            const factBytes = EffectArray.reduce(group, 0, (total, value) => total + value.factBytes);
            const fileCount = EffectArray.reduce(group, 0, (total, value) => total + value.fileCount);
            const sourceBytes = EffectArray.reduce(group, 0, (total, value) => total + value.sourceBytes);
            expect(
              (factBytes <= 32 * 1_048_576 && fileCount <= 512 && sourceBytes <= 64 * 1_048_576) || group.length === 1,
            ).toBe(true);
          }
          for (let index = 0; index < groups.length - 1; index += 1) {
            const combined = [...groups[index], ...groups[index + 1]];
            const factBytes = EffectArray.reduce(combined, 0, (total, value) => total + value.factBytes);
            const fileCount = EffectArray.reduce(combined, 0, (total, value) => total + value.fileCount);
            const sourceBytes = EffectArray.reduce(combined, 0, (total, value) => total + value.sourceBytes);
            expect(
              combined.length <= 4 && factBytes <= 32 * 1_048_576 && fileCount <= 512 && sourceBytes <= 64 * 1_048_576,
            ).toBe(false);
          }
          expect(cursor).toBe(candidates.length);
        },
      ),
      {numRuns: 250},
    );
  });

  it('keeps a non-empty batch estimate at a zero-row SQLite stage boundary', () => {
    const estimated = {lookupKeys: 111_666, symbols: 5_669};

    expect(
      materializationRowsWithStoreProgress(estimated, {
        chunkRows: 0,
        elapsedMilliseconds: 0,
        rowsCompleted: 0,
        stage: 'symbols',
      }),
    ).toEqual(estimated);
    expect(
      materializationRowsWithStoreProgress(estimated, {
        chunkRows: 1_000,
        elapsedMilliseconds: 1,
        rowsCompleted: 1_000,
        stage: 'symbols',
      }),
    ).toEqual({lookupKeys: 111_666, symbols: 1_000});
  });

  fcProp(
    it,
    'combines every materialization row counter associatively without dropping a category',
    {first: materializationRows, second: materializationRows, third: materializationRows},
    ({first, second, third}) => {
      const leftAssociated = addMaterializationRows(addMaterializationRows(first, second), third);
      const rightAssociated = addMaterializationRows(first, addMaterializationRows(second, third));
      const keys = EffectRecord.keys(first) as ReadonlyArray<keyof CodeGraphMaterializationRows>;

      expect(leftAssociated).toEqual(rightAssociated);
      for (const key of keys) {
        expect(leftAssociated[key]).toBe((first[key] ?? 0) + (second[key] ?? 0) + (third[key] ?? 0));
      }
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'keeps every disk-estimate component finite, safe, and internally bounded',
    {cachedFactBytes: FC.option(byteCount, {nil: undefined}), sourceBytes: byteCount},
    ({cachedFactBytes, sourceBytes}) => {
      const estimate = estimatedMaterializationStorageBytes(cachedFactBytes, sourceBytes);
      const values = [
        estimate.estimatedConcurrentBuildBytes,
        estimate.estimatedDurableSnapshotBytes,
        estimate.estimatedJournalBytes,
        estimate.estimatedRequiredBytes,
        estimate.estimatedTemporaryDatabaseBytes,
      ];

      expect(EffectArray.every(values, value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
      expect(estimate.estimatedRequiredBytes).toBeGreaterThanOrEqual(estimate.estimatedConcurrentBuildBytes);
      expect(estimate.estimateBasis).toBe(
        cachedFactBytes === undefined ? 'source-bytes-fallback' : 'cached-fact-bytes',
      );
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'never decreases a component when the selected estimate basis grows',
    {left: byteCount, right: byteCount},
    ({left, right}) => {
      const lower = estimatedMaterializationStorageBytes(Math.min(left, right), 0);
      const upper = estimatedMaterializationStorageBytes(Math.max(left, right), 0);

      expect(upper.estimatedTemporaryDatabaseBytes).toBeGreaterThanOrEqual(lower.estimatedTemporaryDatabaseBytes);
      expect(upper.estimatedDurableSnapshotBytes).toBeGreaterThanOrEqual(lower.estimatedDurableSnapshotBytes);
      expect(upper.estimatedJournalBytes).toBeGreaterThanOrEqual(lower.estimatedJournalBytes);
      expect(upper.estimatedConcurrentBuildBytes).toBeGreaterThanOrEqual(lower.estimatedConcurrentBuildBytes);
      expect(upper.estimatedRequiredBytes).toBeGreaterThanOrEqual(lower.estimatedRequiredBytes);
    },
    {fastCheck: {numRuns: 250}},
  );

  it('labels an explicit final-attribution storage estimate without changing its byte arithmetic', () => {
    const cached = estimatedMaterializationStorageBytes(2_000_000, 1, 'direct-persistent');
    const attributed = estimatedMaterializationStorageBytes(2_000_000, 1, 'direct-persistent', 'final-fact-bytes');

    expect(attributed).toEqual({...cached, estimateBasis: 'final-fact-bytes'});
  });

  it('keeps a synthetic whole-build heuristic shortfall advisory when the measured bounded write is safe', () => {
    const availableBytes = 10 * 1_024 * 1_024 * 1_024;
    const plan = materializationStoragePlan(
      estimatedMaterializationStorageBytes(4 * 1_024 * 1_024 * 1_024, 0, 'direct-persistent'),
      {
        durableAvailableBytes: availableBytes,
        filesystemsShared: true,
        temporaryAvailableBytes: availableBytes,
      },
    );
    expect(materializationStorageShortfalls(plan)).toEqual(['shared']);
    expect(plan).toMatchObject({
      decisionLayer: 'whole-build-heuristic',
      enforcement: 'advisory',
      estimateBasis: 'cached-fact-bytes',
      estimatedRequiredBytes: 68_753_031_168,
      modelVersion: CODE_GRAPH_MATERIALIZATION_STORAGE_HEURISTIC_MODEL_VERSION,
    });

    const boundedDemand = codeGraphDirectPersistentCapacityDemand({
      finalFactBytes: 32 * 1_048_576,
      lexicalFormatVersion: 1,
      pageSize: 4_096,
      rowCount: 512_000,
      walAutoCheckpointPages: 1_000,
    });
    const measured = evaluateCodeGraphDiskCapacity({
      demand: boundedDemand,
      durableAvailableBytes: availableBytes,
      filesystemsShared: true,
      freelistBytes: 0,
      reservedDurableBytes: 0,
      reservedTemporaryBytes: 0,
      temporaryAvailableBytes: availableBytes,
    });
    expect(measured.state).toBe('healthy');
    if (measured.state === 'healthy') {
      expect(measured.filesystems).toEqual([
        {
          activeReservationBytes: 0,
          availableBytes,
          requiredBytes: 429_916_160,
          role: 'shared',
        },
      ]);
    }
  });

  fcProp(
    it,
    'plans direct snapshots without charging their durable WAL to the TEMP filesystem',
    {durableAvailableBytes: byteCount, factBytes: byteCount, temporaryAvailableBytes: byteCount},
    ({durableAvailableBytes, factBytes, temporaryAvailableBytes}) => {
      const direct = estimatedMaterializationStorageBytes(factBytes, 0, 'direct-persistent');
      const staged = estimatedMaterializationStorageBytes(factBytes, 0, 'temporary-staged');
      const plan = materializationStoragePlan(direct, {
        durableAvailableBytes,
        filesystemsShared: false,
        temporaryAvailableBytes,
      });

      expect(direct.estimatedTemporaryDatabaseBytes).toBeLessThanOrEqual(staged.estimatedTemporaryDatabaseBytes);
      expect(plan.estimatedTemporaryFilesystemRequiredBytes).toBe(direct.estimatedTemporaryDatabaseBytes * 2);
      expect(plan.estimatedDurableFilesystemRequiredBytes).toBe(
        Math.min(Number.MAX_SAFE_INTEGER, (direct.estimatedDurableSnapshotBytes + direct.estimatedJournalBytes) * 2),
      );
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'assesses independently mounted TEMP and durable storage against their own headroom',
    {
      durableAvailableBytes: byteCount,
      factBytes: byteCount,
      temporaryAvailableBytes: byteCount,
    },
    ({durableAvailableBytes, factBytes, temporaryAvailableBytes}) => {
      const plan = materializationStoragePlan(estimatedMaterializationStorageBytes(factBytes, 0), {
        durableAvailableBytes,
        filesystemsShared: false,
        temporaryAvailableBytes,
      });
      const shortfalls = materializationStorageShortfalls(plan);

      expect(shortfalls.includes('durable')).toBe(durableAvailableBytes < plan.estimatedDurableFilesystemRequiredBytes);
      expect(shortfalls.includes('temporary')).toBe(
        temporaryAvailableBytes < plan.estimatedTemporaryFilesystemRequiredBytes,
      );
      expect(shortfalls.includes('shared')).toBe(false);
      expect(plan.availableBytes).toBeUndefined();
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'coalesces shared TEMP and durable storage into one conservative filesystem check',
    {durableAvailableBytes: byteCount, factBytes: byteCount, temporaryAvailableBytes: byteCount},
    ({durableAvailableBytes, factBytes, temporaryAvailableBytes}) => {
      const plan = materializationStoragePlan(estimatedMaterializationStorageBytes(factBytes, 0), {
        durableAvailableBytes,
        filesystemsShared: true,
        temporaryAvailableBytes,
      });
      const availableBytes = Math.min(durableAvailableBytes, temporaryAvailableBytes);
      const shortfalls = materializationStorageShortfalls(plan);

      expect(plan.availableBytes).toBe(availableBytes);
      expect(shortfalls).toEqual(availableBytes < plan.estimatedRequiredBytes ? ['shared'] : []);
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'compacts parser-cache relationships idempotently without changing attribution winner semantics',
    {ids: FC.array(FC.integer({max: 30, min: 0}), {maxLength: 300})},
    ({ids}) => {
      const edges = EffectArray.map(ids, (id, index) => relationshipEdge(String(id), index));
      const references = EffectArray.map(ids, (id, index) => relationshipReference(String(id), index));
      const facts = {
        diagnostics: [],
        edges,
        path: 'src/repeated.ts',
        references,
        symbols: [],
      } as const;
      const compacted = compactCachedFileRelationships(facts);
      const repeated = compactCachedFileRelationships(compacted);
      const uniqueIds = new Set(EffectArray.map(ids, String));

      expect(EffectArray.map(compacted.edges, edge => edge.id)).toEqual([...uniqueIds]);
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(compacted.references), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, reference => reference.edgeId),
          ),
        ),
      ).toEqual([...uniqueIds]);
      expect(repeated).toEqual(compacted);
      for (const id of uniqueIds) {
        expect(EffectOption.getOrUndefined(EffectArray.findFirst(compacted.edges, edge => edge.id === id))).toBe(
          EffectOption.getOrUndefined(EffectArray.findFirst(edges, edge => edge.id === id)),
        );
        expect(
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(compacted.references), __effectArrayReceiver =>
              EffectOption.getOrUndefined(
                EffectArray.findFirst(__effectArrayReceiver, reference => reference.edgeId === id),
              ),
            ),
          ),
        ).toBe(EffectArray.filter(references, reference => reference.edgeId === id).at(-1));
      }
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'deduplicates repeated relationship primary keys stably and idempotently before strict staging',
    {ids: FC.array(FC.integer({max: 30, min: 0}), {maxLength: 300})},
    ({ids}) => {
      const edges = EffectArray.map(ids, (id, index) => relationshipEdge(String(id), index));
      const references = EffectArray.map(ids, (id, index) => relationshipReference(String(id), index));
      const deduplicated = deduplicateMaterializationRelationships(edges, references);
      const repeated = deduplicateMaterializationRelationships(deduplicated.edges, deduplicated.references);
      const uniqueIds = new Set(EffectArray.map(ids, String));

      expect(EffectArray.map(deduplicated.edges, edge => edge.id)).toEqual([...uniqueIds]);
      expect(EffectArray.map(deduplicated.references, reference => reference.edgeId)).toEqual([...uniqueIds]);
      expect(deduplicated.duplicateEdges).toBe(ids.length - uniqueIds.size);
      expect(deduplicated.duplicateReferences).toBe(ids.length - uniqueIds.size);
      expect(repeated).toEqual({
        duplicateEdges: 0,
        duplicateReferences: 0,
        edges: deduplicated.edges,
        references: deduplicated.references,
      });
      for (const id of uniqueIds) {
        expect(EffectOption.getOrUndefined(EffectArray.findFirst(deduplicated.edges, edge => edge.id === id))).toBe(
          EffectOption.getOrUndefined(EffectArray.findFirst(edges, edge => edge.id === id)),
        );
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(deduplicated.references, reference => reference.edgeId === id),
          ),
        ).toBe(EffectArray.filter(references, reference => reference.edgeId === id).at(-1));
      }
    },
    {fastCheck: {numRuns: 250}},
  );
});

function relationshipEdge(id: string, line: number): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: 'src/repeated.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: line + 1, line: line + 1},
    id,
    provenance: 'syntactic',
    relation: 'calls',
    sourceName: 'caller',
    targetName: 'target',
  };
}

function relationshipReference(edgeId: string, line: number): CodeGraphReference {
  return {
    edgeId,
    evidencePath: 'src/repeated.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: line + 1, line: line + 1},
    lookupTiers: [[`typescript:name:target-${edgeId}`]],
    provenance: 'syntactic',
    relation: 'calls',
    resolutionDomain: 'typescript',
    sourceName: 'caller',
    targetName: 'target',
  };
}
