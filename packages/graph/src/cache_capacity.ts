import {
  codeGraphUtf8ByteLength,
  saturatingCapacityAdd,
  type CodeGraphDirectPersistentCapacityBoundary,
  type CodeGraphDirectPersistentCapacityOperation,
} from './disk/capacity.js';
import {compareCodeUnits} from './ordering.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

export const CODE_GRAPH_CACHE_TRANSACTION_LIMITS = {
  payloadBytes: 32 * 1_048_576,
  rows: 512,
} as const;

export type CodeGraphCacheCapacityOperation = Extract<
  CodeGraphDirectPersistentCapacityOperation,
  'cache code graph file facts' | 'cache materialized code graph file shards'
>;

export interface CodeGraphCacheCapacityRow {
  readonly key: string;
  readonly payloadBytes: number;
}

export interface CodeGraphCacheCapacityChunk<Row extends CodeGraphCacheCapacityRow> {
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  readonly rows: readonly Row[];
}

interface CodeGraphFileBlobCapacityFields {
  readonly blobId?: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly extractorSet: string;
  readonly factsJson: string;
  readonly path: string;
  readonly reuseClass?: string;
}

interface CodeGraphMaterializedShardCapacityFields extends CodeGraphFileBlobCapacityFields {
  readonly derivationIdentity: string;
  readonly id: string;
  readonly lastUsedAt: string;
}

export function codeGraphFileBlobCapacityBytes(fields: CodeGraphFileBlobCapacityFields): number {
  return saturatingCapacityAdd(
    codeGraphTextFieldsCapacityBytes(
      fields.blobId ?? '',
      fields.contentHash,
      fields.extractorSet,
      fields.path,
      fields.factsJson,
      fields.createdAt,
      fields.reuseClass ?? '',
    ),
    // The trigger-maintained admission authority duplicates only bounded hot
    // metadata, never the fact payload. Reserve it in the same transaction so
    // cache acceleration cannot weaken WAL/durable capacity protection.
    codeGraphTextFieldsCapacityBytes(
      fields.extractorSet,
      fields.path,
      fields.contentHash,
      fields.blobId ?? '',
      fields.reuseClass ?? '',
    ),
  );
}

export function codeGraphMaterializedShardCapacityBytes(fields: CodeGraphMaterializedShardCapacityFields): number {
  return codeGraphTextFieldsCapacityBytes(
    fields.id,
    fields.contentHash,
    fields.extractorSet,
    fields.derivationIdentity,
    fields.path,
    fields.factsJson,
    fields.createdAt,
    fields.lastUsedAt,
  );
}

export function codeGraphTextFieldsCapacityBytes(...fields: readonly string[]): number {
  return saturatingCapacityAdd(...EffectArray.map(fields, codeGraphUtf8ByteLength));
}

/**
 * Produces a stable physical-transaction plan. Callers must use a key that is
 * unique for one attempted physical row; duplicate keys are rejected instead
 * of silently changing last-write-wins semantics through canonical sorting.
 */
export function planCodeGraphCacheCapacityChunks<Row extends CodeGraphCacheCapacityRow>(
  operation: CodeGraphCacheCapacityOperation,
  inputRows: readonly Row[],
): readonly CodeGraphCacheCapacityChunk<Row>[] {
  const rows = [...inputRows].sort((left, right) => compareCodeUnits(left.key, right.key));
  const output: CodeGraphCacheCapacityChunk<Row>[] = [];
  let current: Row[] = [];
  let currentBytes = 0;
  let previousKey: string | undefined;

  const flush = () => {
    if (current.length === 0) return;
    output.push({
      boundary: {finalFactBytes: currentBytes, operation, rowCount: current.length},
      rows: current,
    });
    current = [];
    currentBytes = 0;
  };

  for (const row of rows) {
    if (row.key.length === 0 || Effect.pipe(row.key, EffectString.includes('\0'))) {
      throw new Error('Code graph cache capacity row key is invalid.');
    }
    if (row.key === previousKey) {
      throw new Error('Duplicate code graph cache capacity row key.');
    }
    if (!Number.isSafeInteger(row.payloadBytes) || row.payloadBytes < 0) {
      throw new Error('Code graph cache capacity payload is invalid.');
    }
    if (row.payloadBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes) {
      throw new Error('Code graph cache row exceeds the bounded transaction payload ceiling.');
    }
    if (
      current.length >= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows ||
      currentBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes - row.payloadBytes
    ) {
      flush();
    }
    current.push(row);
    currentBytes += row.payloadBytes;
    previousKey = row.key;
  }
  flush();
  return output;
}
