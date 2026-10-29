import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {makeCodeGraphMaterializedShardWriteQueue} from '@threadnote/graph/indexer/materialized_shard_writes';
import type {
  CodeGraphDirectPersistentCapacityProtector,
  CodeGraphMaterializedShardAssociationBatch,
  CodeGraphMaterializedShardCacheBatch,
  CodeGraphStoreShape,
} from '@threadnote/graph/store';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('materialized shard physical-write queue', () => {
  effectIt.effect('flushes cache before associations and attributes each physical flush exactly once', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const store = {
        associateMaterializedFileShardBatches: (_databasePath, _snapshotId, _ownerToken, batches) =>
          Effect.sync(() => {
            events.push(`associate:${batches.length}`);
          }),
        cacheMaterializedFileShardBatches: (_databasePath, batches) =>
          Effect.sync(() => {
            events.push(`cache:${batches.length}`);
          }),
      } as Pick<CodeGraphStoreShape, 'associateMaterializedFileShardBatches' | 'cacheMaterializedFileShardBatches'>;
      const protector: CodeGraphDirectPersistentCapacityProtector = (_boundary, transaction) => transaction;
      const queue = makeCodeGraphMaterializedShardWriteQueue({
        databasePath: '/tmp/queue.sqlite',
        onAssociation: () => events.push('association-timed'),
        onCachePersistence: (_elapsed, recordInAttribution) =>
          events.push(`cache-timed:${String(recordInAttribution)}`),
        ownerToken: 'owner',
        persistentCapacityProtector: protector,
        snapshotId: 'snapshot',
        store,
        transactionBatchLimit: 4,
      });

      for (let index = 0; index < 4; index += 1) {
        expect(queue.enqueueCache(cacheBatch(index))).toBe(index === 3);
        expect(queue.enqueueAssociation(associationBatch(index))).toBe(index === 3);
      }
      yield* queue.flushAssociations(false);
      expect(events).toEqual(['cache:4', 'cache-timed:false', 'associate:4', 'association-timed']);

      queue.enqueueCache(cacheBatch(4));
      yield* queue.flushCaches();
      expect(events.slice(-2)).toEqual(['cache:1', 'cache-timed:true']);
      yield* queue.flushAssociations();
      expect(events).toHaveLength(6);
    }),
  );
});

function cacheBatch(index: number): CodeGraphMaterializedShardCacheBatch {
  const path = `src/file-${index}.ts`;
  return {
    derivationIdentity: 'derivation',
    extractorSet: 'extractors',
    facts: [{diagnostics: [], edges: [], path, symbols: []}],
    files: [inventoryFile(index)],
  };
}

function associationBatch(index: number): CodeGraphMaterializedShardAssociationBatch {
  const file = inventoryFile(index);
  return {
    derivationIdentity: 'derivation',
    extractorSet: 'extractors',
    files: [file],
    selectedShardIds: new Map([[file.path, `shard-${index}`]]),
  };
}

function inventoryFile(index: number) {
  return {
    blobId: Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
    contentHash: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
    language: 'typescript',
    mode: '100644',
    path: `src/file-${index}.ts`,
    size: index,
    source: 'commit' as const,
  };
}
