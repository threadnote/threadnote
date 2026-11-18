import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from './fact/budget.js';

/**
 * Materialized shards are the only attributed per-file facts that checkpoint
 * export reads, so every clean build keeps them. A dirty build cannot be
 * exported, so it skips duplicating more than 32 maximum-size parser facts; a
 * later rebuild falls back to raw parser facts or ordinary extraction.
 */
export const CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM =
  32 * CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM;

export type CodeGraphMaterializedShardCacheWriteAdmission = 'defer' | 'persist';

export interface CodeGraphMaterializedShardCacheBatchPlan {
  readonly associate: boolean;
  readonly cacheFallback: boolean;
  readonly associationsComplete: boolean;
}

/** @internal Exact, fail-closed admission used by the cache-write property. */
export function codeGraphMaterializedShardCacheWriteAdmission(
  rawFactBytes: number,
  build: {readonly dirty: boolean},
): CodeGraphMaterializedShardCacheWriteAdmission {
  if (!build.dirty || !Number.isSafeInteger(rawFactBytes) || rawFactBytes < 0) return 'persist';
  return rawFactBytes > CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM ? 'defer' : 'persist';
}

/** @internal Exact batch action model shared by runtime wiring and properties. */
export function codeGraphMaterializedShardCacheBatchPlan(
  admission: CodeGraphMaterializedShardCacheWriteAdmission,
  materializedBatchComplete: boolean,
): CodeGraphMaterializedShardCacheBatchPlan {
  if (materializedBatchComplete) return {associate: true, associationsComplete: true, cacheFallback: false};
  return admission === 'persist'
    ? {associate: true, associationsComplete: true, cacheFallback: true}
    : {associate: false, associationsComplete: false, cacheFallback: false};
}
