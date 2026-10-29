import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CODE_GRAPH_CACHE_TRANSACTION_LIMITS} from '@threadnote/graph/cache_capacity';
import {
  codeGraphCacheWritePages,
  prepareMaterializedShardCacheBatchChunks,
  sameMaterializedShardWriteIds,
} from '@threadnote/graph/store/cache';
import type {CodeGraphMaterializedShardCacheBatch} from '@threadnote/graph/store/models';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const shardId = fc.stringMatching(/^cgfs_[a-f0-9]{1,40}$/u);

describe('materialized shard batched write properties', () => {
  it('partitions without loss, mutation, or oversized SQLite statements', () => {
    fc.assert(
      fc.property(fc.uniqueArray(shardId, {maxLength: 1_200}), ids => {
        const before = [...ids];
        const pages = codeGraphCacheWritePages(ids);

        expect(pages.flat()).toEqual(ids);
        expect(pages).toHaveLength(Math.ceil(ids.length / CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows));
        expect(
          EffectArray.every(pages, page => page.length > 0 && page.length <= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows),
        ).toBe(true);
        expect(ids).toEqual(before);
      }),
      {numRuns: 150},
    );
  });

  it('accepts every exact RETURNING permutation and rejects partial or ambiguous identity sets', () => {
    fc.assert(
      fc.property(fc.uniqueArray(shardId, {maxLength: CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows, minLength: 1}), ids => {
        expect(sameMaterializedShardWriteIds(ids, [...ids].reverse())).toBe(true);
        expect(sameMaterializedShardWriteIds(ids, ids.slice(1))).toBe(false);
        if (ids.length > 1) {
          expect(sameMaterializedShardWriteIds(ids, [...ids.slice(0, -1), ids[0]])).toBe(false);
          expect(sameMaterializedShardWriteIds([...ids.slice(0, -1), ids[0]], ids)).toBe(false);
        }
      }),
      {numRuns: 150},
    );
  });

  it('replans logical attribution batches losslessly into deterministic bounded transactions', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({max: 128, min: 1}), {maxLength: 8, minLength: 1}), batchSizes => {
        let nextFile = 0;
        const batches: CodeGraphMaterializedShardCacheBatch[] = EffectArray.map(batchSizes, (batchSize, batchIndex) => {
          const files = Array.from({length: batchSize}, () => {
            const index = nextFile;
            nextFile += 1;
            const path = `src/file-${Effect.pipe(index.toString(), EffectString.padStart(4, '0'))}.ts`;
            return {
              blobId: Effect.pipe(index.toString(16), EffectString.padStart(40, '0')),
              contentHash: Effect.pipe(index.toString(16), EffectString.padStart(64, '0')),
              language: 'typescript',
              mode: '100644',
              path,
              size: index,
              source: 'commit' as const,
            };
          });
          return {
            derivationIdentity: `derivation-${batchIndex}`,
            extractorSet: 'property-extractors',
            facts: EffectArray.map(files, file => ({diagnostics: [], edges: [], path: file.path, symbols: []})),
            files,
          };
        });
        const inputPaths = EffectArray.flatMap(batches, batch => EffectArray.map(batch.files, file => file.path));

        const chunks = prepareMaterializedShardCacheBatchChunks(batches, '2026-08-23T00:00:00.000Z');

        expect(EffectArray.flatMap(chunks, chunk => EffectArray.map(chunk.rows, row => row.key))).toEqual(inputPaths);
        expect(
          EffectArray.every(
            chunks,
            chunk =>
              chunk.rows.length > 0 &&
              chunk.rows.length <= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows &&
              chunk.boundary.rowCount === chunk.rows.length &&
              chunk.boundary.finalFactBytes ===
                EffectArray.reduce(chunk.rows, 0, (total, row) => total + row.payloadBytes) &&
              chunk.boundary.finalFactBytes <= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes,
          ),
        ).toBe(true);
        expect(EffectArray.flatMap(batches, batch => EffectArray.map(batch.files, file => file.path))).toEqual(
          inputPaths,
        );
        expect(prepareMaterializedShardCacheBatchChunks(batches, '2026-08-23T00:00:00.000Z')).toEqual(chunks);
      }),
      {numRuns: 75},
    );
  });
});
