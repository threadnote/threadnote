import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {LEGACY_BUILDING_REFERENCES_V3_TABLE} from './schema/contracts.js';
import {tableExists} from './session.js';
import {CodeGraphStoreError} from '../types.js';
import {type CodeGraphWriterGate} from './build/core.js';
import {initializeSchema} from './schema/initialization.js';
import {drainCompletedPersistentBuildRows} from './activation/persistent.js';
import {pruneRetiredCompactLexicalRows, RETIRED_SNAPSHOT_CLEANUP_SPECS} from './cleanup_core.js';
import {nextPersistentActivationBatchRows} from './activation/core.js';

/** @internal Bounded keyset page retained for admission query-plan and load regressions. */

/** @internal Indexed due page retained for query-plan and crash-fairness regressions. */

/** @internal Target-rooted exact retirement retained for deterministic query-plan regressions. */

/** @internal Exact indexed cleanup statement retained for query-plan regression tests. */

/**
 * Reclaim at most one bounded table page. Lease acquire/release use this
 * foreground step, while pointer promotion schedules the same state machine as
 * a best-effort detached collector. Query completion therefore never cascades
 * a repository-sized snapshot delete, while repeated ordinary use still makes
 * durable progress if a short-lived CLI interrupts the detached fiber.
 */

/**
 * Deep maintenance reclaims retired snapshots in independently committed,
 * adaptive pages. Pointer promotion only marks snapshots retired, so a prior
 * multi-million-row snapshot can never delay or roll back the new pointer.
 */
const pruneRetiredSnapshotRows = Effect.fn('codeGraph.pruneRetiredSnapshotRows')(function* (
  writerGate?: CodeGraphWriterGate,
  snapshotId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  yield* runWrite(initializeSchema(sql));
  yield* drainCompletedPersistentBuildRows(sql, snapshotId, runWrite);
  yield* pruneRetiredCompactLexicalRows(sql, runWrite, snapshotId);
  for (const spec of RETIRED_SNAPSHOT_CLEANUP_SPECS) {
    if (spec.table === LEGACY_BUILDING_REFERENCES_V3_TABLE && !(yield* tableExists(sql, spec.table))) continue;
    let batchRows: number = spec.batchRows;
    for (;;) {
      const startedAt = performance.now();
      const deleted = yield* runWrite(
        sql.withTransaction(
          Effect.gen(function* () {
            const key = `(${spec.keyColumns.join(', ')})`;
            yield* sql.unsafe(
              `DELETE FROM ${spec.table}
             WHERE ${key} IN (
               SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               FROM ${spec.table} AS candidate
               WHERE candidate.snapshot_id IN (SELECT id FROM snapshots WHERE state = 'retired')
                 AND (? IS NULL OR candidate.snapshot_id = ?)
               ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               LIMIT ?
             )`,
              [snapshotId ?? null, snapshotId ?? null, batchRows],
            );
            const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
            return Number(changes[0]?.count ?? 0);
          }),
        ),
      );
      if (!Number.isSafeInteger(deleted) || deleted < 0) {
        return yield* CodeGraphStoreError.of('Retired snapshot cleanup returned an invalid row count.');
      }
      if (deleted === 0) break;
      batchRows = nextPersistentActivationBatchRows(
        batchRows,
        Math.max(0, performance.now() - startedAt),
        spec.maximumBatchRows,
      );
      yield* Effect.yieldNow;
    }
  }
  for (;;) {
    const removed = yield* runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          // The bounded table collector above should already have exhausted
          // these rows. Keep the postings-first invariant local to the direct
          // snapshot DELETE as a lifecycle backstop.
          yield* sql.unsafe(
            `
          DELETE FROM symbol_terms
          WHERE snapshot_id IN (
            SELECT id FROM snapshots
            WHERE state = 'retired' AND (? IS NULL OR id = ?)
            ORDER BY id LIMIT 100
          )
        `,
            [snapshotId ?? null, snapshotId ?? null],
          );
          yield* sql.unsafe(
            `
          DELETE FROM snapshots
          WHERE id IN (
            SELECT id FROM snapshots
            WHERE state = 'retired' AND (? IS NULL OR id = ?)
            ORDER BY id LIMIT 100
          )
        `,
            [snapshotId ?? null, snapshotId ?? null],
          );
          const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
          return Number(changes[0]?.count ?? 0);
        }),
      ),
    );
    if (!Number.isSafeInteger(removed) || removed < 0) {
      return yield* CodeGraphStoreError.of('Retired snapshot cleanup returned an invalid count.');
    }
    if (removed === 0) break;
    yield* Effect.yieldNow;
  }
});

export {pruneRetiredSnapshotRows};
