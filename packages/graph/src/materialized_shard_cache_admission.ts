import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from './fact/budget.js';

/**
 * Derived materialized shards are a non-authoritative restart optimization.
 * Keep them for bounded builds, but do not duplicate more than 32 maximum-size
 * parser facts while a repository-wide direct build is already persisting the
 * authoritative graph. A later rebuild still falls back to raw parser facts or
 * ordinary extraction if cache maintenance has reclaimed them.
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
): CodeGraphMaterializedShardCacheWriteAdmission {
  if (!Number.isSafeInteger(rawFactBytes) || rawFactBytes < 0) return 'persist';
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
