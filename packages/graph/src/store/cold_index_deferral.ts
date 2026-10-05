import {Clock, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {saturatingCapacityAdd, saturatingCapacityMultiply} from '../disk/capacity.js';
import {assertPersistentBuildOwner, type CodeGraphWriterGate} from './build/core.js';
import {
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphSecondaryIndexRestorationProgressCallback,
} from './models.js';
import {CODE_GRAPH_QUERY_INDEX_DEFINITIONS, inspectCodeGraphQueryIndexes} from './query/indexes.js';
import {recordCodeGraphSchemaInitializationReceipt} from './schema/receipt.js';
import {CodeGraphStoreError, type CodeGraphInventoryFile} from '../types.js';

const DEFERRED_QUERY_INDEX_STATE_KEY = 'query_indexes_deferred';
const DEFERRED_QUERY_INDEX_STATE_VALUE = '1';
const COLD_INDEX_DEFERRAL_MINIMUM_FILES = 512;
const COLD_INDEX_DEFERRAL_MINIMUM_SOURCE_BYTES = 16 * 1_048_576;

export interface CodeGraphColdIndexDeferralObservation {
  readonly activeSnapshotPresent: boolean;
  readonly edgePresent: boolean;
  readonly otherIncompleteSnapshotPresent: boolean;
  readonly readySnapshotPresent: boolean;
  readonly symbolPresent: boolean;
}

/** @internal Exact pure admission used by the cold-deferral property. */
export function codeGraphColdIndexDeferralEligible(observation: CodeGraphColdIndexDeferralObservation): boolean {
  return (
    !observation.activeSnapshotPresent &&
    !observation.edgePresent &&
    !observation.otherIncompleteSnapshotPresent &&
    !observation.readySnapshotPresent &&
    !observation.symbolPresent
  );
}

/**
 * Rebuilding every query index has a fixed SQLite cost that exceeds incremental
 * index maintenance for small cold graphs. Defer only when either admitted
 * source dimension reaches the production-sized materialization envelope.
 */
export function codeGraphColdIndexDeferralWorthwhile(files: readonly Pick<CodeGraphInventoryFile, 'size'>[]): boolean {
  if (files.length >= COLD_INDEX_DEFERRAL_MINIMUM_FILES) return true;
  let sourceBytes = 0;
  for (const file of files) {
    sourceBytes += file.size;
    if (sourceBytes >= COLD_INDEX_DEFERRAL_MINIMUM_SOURCE_BYTES) return true;
  }
  return false;
}

export const deferCodeGraphQueryIndexesForColdBuild = Effect.fn('codeGraph.deferQueryIndexesForColdBuild')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  writerGate?: CodeGraphWriterGate,
) {
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  return yield* runWrite(
    sql.withTransaction(
      Effect.gen(function* () {
        yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
        const rows = yield* sql.unsafe<{
          readonly active_snapshot_present: unknown;
          readonly edge_present: unknown;
          readonly other_incomplete_snapshot_present: unknown;
          readonly ready_snapshot_present: unknown;
          readonly symbol_present: unknown;
        }>(
          `SELECT
               EXISTS(SELECT 1 FROM active_snapshots LIMIT 1) AS active_snapshot_present,
               EXISTS(SELECT 1 FROM snapshots WHERE state = 'ready' LIMIT 1) AS ready_snapshot_present,
               EXISTS(
                 SELECT 1 FROM snapshots
                 WHERE id <> ? AND state IN ('building', 'failed')
                 LIMIT 1
               ) AS other_incomplete_snapshot_present,
               EXISTS(SELECT 1 FROM symbols LIMIT 1) AS symbol_present,
               EXISTS(SELECT 1 FROM edges LIMIT 1) AS edge_present`,
          [snapshotId],
        );
        const row = rows[0];
        const activeSnapshotPresent = sqliteBoolean(row?.active_snapshot_present);
        const edgePresent = sqliteBoolean(row?.edge_present);
        const otherIncompleteSnapshotPresent = sqliteBoolean(row?.other_incomplete_snapshot_present);
        const readySnapshotPresent = sqliteBoolean(row?.ready_snapshot_present);
        const symbolPresent = sqliteBoolean(row?.symbol_present);
        if (
          activeSnapshotPresent === undefined ||
          edgePresent === undefined ||
          otherIncompleteSnapshotPresent === undefined ||
          readySnapshotPresent === undefined ||
          symbolPresent === undefined ||
          !codeGraphColdIndexDeferralEligible({
            activeSnapshotPresent,
            edgePresent,
            otherIncompleteSnapshotPresent,
            readySnapshotPresent,
            symbolPresent,
          })
        ) {
          return false;
        }
        const inspection = yield* inspectCodeGraphQueryIndexes(sql);
        if (inspection.missing.length > 0) {
          return yield* CodeGraphStoreError.of('Code graph query index schema is unavailable.');
        }
        for (const definition of CODE_GRAPH_QUERY_INDEX_DEFINITIONS) {
          yield* sql.unsafe(`DROP INDEX "${definition.name}"`);
        }
        yield* sql`
            INSERT INTO activation_state (key, value)
            VALUES (${DEFERRED_QUERY_INDEX_STATE_KEY}, ${DEFERRED_QUERY_INDEX_STATE_VALUE})
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `;
        return true;
      }),
    ),
  );
});

export const restoreCodeGraphQueryIndexesAfterColdBuild = Effect.fn('codeGraph.restoreQueryIndexesAfterColdBuild')(
  function* (options: {
    readonly onProgress?: CodeGraphSecondaryIndexRestorationProgressCallback;
    readonly observeTransaction?: () => Effect.Effect<void>;
    readonly ownerToken: string;
    readonly persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector;
    readonly snapshotId: string;
    readonly sql: SqlClient.SqlClient;
    readonly writerGate?: CodeGraphWriterGate;
  }) {
    const {sql} = options;
    const runWrite: CodeGraphWriterGate = options.writerGate ?? (effect => effect);
    yield* assertPersistentBuildOwner(sql, options.snapshotId, options.ownerToken);
    const state = yield* sql<{readonly value: string}>`
      SELECT value FROM activation_state WHERE key = ${DEFERRED_QUERY_INDEX_STATE_KEY} LIMIT 1
    `;
    if (state[0]?.value !== DEFERRED_QUERY_INDEX_STATE_VALUE) return false;

    const inspection = yield* inspectCodeGraphQueryIndexes(sql);
    const missing = inspection.missing;
    const counts = yield* sql.unsafe<{
      readonly edges: unknown;
      readonly symbols: unknown;
    }>(
      `SELECT
         COALESCE(SUM(edge_count), 0) AS edges,
         COALESCE(SUM(symbol_count), 0) AS symbols
       FROM building_materialization_batches
       WHERE snapshot_id = ?`,
      [options.snapshotId],
    );
    const edgeCount = nonNegativeSafeInteger(counts[0]?.edges);
    const symbolCount = nonNegativeSafeInteger(counts[0]?.symbols);
    if (edgeCount === undefined || symbolCount === undefined) {
      return yield* CodeGraphStoreError.of('Code graph query index row counts are invalid.');
    }
    // Reserve one receipt row, one sqlite_schema row per missing index, and a
    // conservative entry for every source row each index can contain.
    const boundary = {
      finalFactBytes: 0,
      operation: 'restore persistent code graph query indexes' as const,
      rowCount: saturatingCapacityAdd(
        1,
        missing.length,
        saturatingCapacityMultiply(edgeCount, missing.filter(definition => definition.table === 'edges').length),
        saturatingCapacityMultiply(symbolCount, missing.filter(definition => definition.table === 'symbols').length),
      ),
    };
    const startedAt = yield* Clock.currentTimeMillis;
    let completed = CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length - missing.length;
    const report = () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* options.onProgress?.({
          completed,
          elapsedMilliseconds: Math.max(0, now - startedAt),
          total: CODE_GRAPH_QUERY_INDEX_DEFINITIONS.length,
        }) ?? Effect.void;
      });
    const restoration = Effect.gen(function* () {
      yield* report();
      // Separate commits let SQLite checkpoint between indexes; the marker
      // keeps any partially restored prefix recoverable after interruption.
      for (const definition of missing) {
        yield* runWrite(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* assertPersistentBuildOwner(sql, options.snapshotId, options.ownerToken);
              const marker = yield* sql<{readonly value: string}>`
                SELECT value FROM activation_state WHERE key = ${DEFERRED_QUERY_INDEX_STATE_KEY} LIMIT 1
              `;
              if (marker[0]?.value !== DEFERRED_QUERY_INDEX_STATE_VALUE) {
                return yield* CodeGraphStoreError.of('Code graph query index restoration changed.');
              }
              yield* sql.unsafe(definition.createSql);
              yield* options.observeTransaction?.() ?? Effect.void;
            }),
          ),
        );
        completed += 1;
        yield* report();
        yield* Effect.yieldNow;
      }
      yield* runWrite(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertPersistentBuildOwner(sql, options.snapshotId, options.ownerToken);
            const marker = yield* sql<{readonly value: string}>`
              SELECT value FROM activation_state WHERE key = ${DEFERRED_QUERY_INDEX_STATE_KEY} LIMIT 1
            `;
            if (marker[0]?.value !== DEFERRED_QUERY_INDEX_STATE_VALUE) {
              return yield* CodeGraphStoreError.of('Code graph query index restoration changed.');
            }
            const restored = yield* inspectCodeGraphQueryIndexes(sql);
            if (restored.missing.length > 0) {
              return yield* CodeGraphStoreError.of('Code graph query index restoration is incomplete.');
            }
            yield* recordCodeGraphSchemaInitializationReceipt(sql);
            yield* sql`DELETE FROM activation_state WHERE key = ${DEFERRED_QUERY_INDEX_STATE_KEY}`;
          }),
        ),
      );
    });
    yield* options.persistentCapacityProtector
      ? options.persistentCapacityProtector(boundary, restoration)
      : restoration;
    return true;
  },
);

function sqliteBoolean(value: unknown): boolean | undefined {
  const parsed = Number(value);
  return parsed === 0 ? false : parsed === 1 ? true : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
