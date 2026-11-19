import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM,
  codeGraphMaterializedShardCacheBatchPlan,
  codeGraphMaterializedShardCacheWriteAdmission,
} from '@threadnote/graph/materialized_shard_cache_admission';

describe('materialized shard cache write admission', () => {
  fcProp(
    it,
    'bounds ordinary builds exactly and persists every shard when all are requested',
    {
      policy: FC.constantFrom('bounded' as const, 'all' as const),
      rawFactBytes: FC.oneof(
        FC.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
        FC.integer({
          max: CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 2,
          min: CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM - 2,
        }),
      ),
    },
    ({policy, rawFactBytes}) => {
      expect(codeGraphMaterializedShardCacheWriteAdmission(rawFactBytes, policy)).toBe(
        policy === 'bounded' && rawFactBytes > CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM
          ? 'defer'
          : 'persist',
      );
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'persists only fallback batches below the boundary and never marks deferred associations complete',
    {
      admission: FC.constantFrom('defer' as const, 'persist' as const),
      materializedBatchComplete: FC.boolean(),
    },
    ({admission, materializedBatchComplete}) => {
      const plan = codeGraphMaterializedShardCacheBatchPlan(admission, materializedBatchComplete);
      expect(plan.cacheFallback).toBe(!materializedBatchComplete && admission === 'persist');
      expect(plan.associate).toBe(materializedBatchComplete || admission === 'persist');
      expect(plan.associationsComplete).toBe(plan.associate);
    },
    {fastCheck: {numRuns: 50}},
  );

  it('persists at the boundary and fails closed for malformed observations', () => {
    expect(
      codeGraphMaterializedShardCacheWriteAdmission(
        CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM,
        'bounded',
      ),
    ).toBe('persist');
    expect(
      codeGraphMaterializedShardCacheWriteAdmission(
        CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 1,
        'bounded',
      ),
    ).toBe('defer');
    for (const malformed of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(codeGraphMaterializedShardCacheWriteAdmission(malformed, 'bounded')).toBe('persist');
    }
  });
});
