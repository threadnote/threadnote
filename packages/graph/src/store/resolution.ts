import {Clock, Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import type {CodeGraphDirectPersistentCapacityBoundary} from '../disk/capacity.js';
import {
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphResolutionProgressCallback,
  type CodeGraphResolutionSummary,
} from './models.js';
import {configureConnection} from './session.js';
import {type CodeGraphProvenance, type RepositoryIdentity, CodeGraphStoreError} from '../types.js';
import {
  activationMode,
  type ActivationResolutionRow,
  assertPersistentBuildOwner,
  assertPersistentMaterializationComplete,
  type CodeGraphWriterGate,
  type PersistedFullReferencePageRow,
  type PersistedFullReferenceTotalsRow,
  PERSISTENT_FULL_RESOLUTION_PAGE_ROWS,
  RESOLUTION_PAGE_ROWS,
  type ResolvableActivationReferenceRow,
  type SnapshotPromotionCapacityPlan,
} from './build/core.js';
import {
  adjustPersistedAnalysisResolutionEdges,
  aggregatePersistentReferenceResolutionCapacityBoundaries,
  capturePersistedAnalysisResolutionEdges,
  codeGraphPersistedDeltaResolutionPageStatement,
  codeGraphPersistentReferencePageStatement,
  nextPersistentReferenceResolutionTransactionPages,
  PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES,
  PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES,
  planPersistentReferenceResolutionPages,
  persistentFullReferencePageTotal,
  persistentReferenceResolutionCapacityBoundary,
  persistentUnresolvedReferenceCapacityBoundary,
} from './resolution/core.js';
import {resolvePersistedFullReferencePage} from './resolution/matching.js';
import {expandTransitiveReexportAliases} from './persistent_build.js';
import {activationEdgeId, chunk, lookupDomain, parseLookupKeys, sqlTextOption} from './utilities.js';
import {type CodeGraphPersistentReferencePageLimits, snapshotPromotionLeaseCapacity} from './staging_core.js';
import {codeGraphWorktreeReconciliationSchemaCompatible, markSnapshotLeaseRetirementBaton} from './reconciliation.js';
import {CODE_GRAPH_SNAPSHOT_ID, validCanonicalTimestamp} from './reconciliation/core.js';
import {nextCodeGraphActiveViewActivationTimestamp} from './active_views.js';
import {CodeGraphPromotionCapacityPlanChanged, type EdgeRow} from './internal_models.js';
import {lastStatementChangeCount, nextPersistentActivationBatchRows} from './activation/core.js';

export const CODE_GRAPH_RESOLUTION_PASS_MAXIMUM = 32;

// Unresolved publication hydrates complete edge payloads for the capacity
// reservation, unlike the insert-select activation copier. Retain the proven
// 1,500-row first transaction and 10k ceiling for ordinary graphs. Above the
// measured 150k-reference crossover, permit 2x growth to 20k; the larger JVM
// sample benefited while the reduced production fixture did not. The adaptive
// controller still shrinks after transactions exceed five seconds.
const PERSISTENT_UNRESOLVED_REFERENCE_INITIAL_BATCH_ROWS = 1_500;

const PERSISTENT_UNRESOLVED_REFERENCE_LARGE_GRAPH_ROWS = 150_000;

const PERSISTENT_UNRESOLVED_REFERENCE_STANDARD_MAXIMUM_BATCH_ROWS = 10_000;

const PERSISTENT_UNRESOLVED_REFERENCE_LARGE_MAXIMUM_BATCH_ROWS = 20_000;

/** @internal Deterministic workload boundary retained for state-machine properties. */
export function persistentUnresolvedReferenceMaximumBatchRows(referenceRows: number): number {
  return Number.isSafeInteger(referenceRows) && referenceRows >= PERSISTENT_UNRESOLVED_REFERENCE_LARGE_GRAPH_ROWS
    ? PERSISTENT_UNRESOLVED_REFERENCE_LARGE_MAXIMUM_BATCH_ROWS
    : PERSISTENT_UNRESOLVED_REFERENCE_STANDARD_MAXIMUM_BATCH_ROWS;
}

/** @internal Pure adaptive boundary retained for state-machine properties. */
export function nextPersistentUnresolvedReferenceBatchRows(
  currentRows: number,
  milliseconds: number,
  referenceRows: number,
): number {
  return nextPersistentActivationBatchRows(
    currentRows,
    milliseconds,
    persistentUnresolvedReferenceMaximumBatchRows(referenceRows),
  );
}

interface ResolutionTransactionPage {
  readonly aliases: readonly (readonly [string, string, string, number, 'alias', string, string])[];
  readonly capacity: CodeGraphDirectPersistentCapacityBoundary;
  readonly resolutions: readonly ActivationResolutionRow[];
}

/** @internal Total-pass convergence fence; every admitted pass is independently page-bounded. */
export function codeGraphResolutionPassAdmitted(passesCompleted: number): boolean {
  return (
    Number.isSafeInteger(passesCompleted) &&
    passesCompleted >= 0 &&
    passesCompleted < CODE_GRAPH_RESOLUTION_PASS_MAXIMUM
  );
}

/** Exact read-only admission shared by cleanup writers and both health paths. */

/** Fresh facts are written before the durable building snapshot owns its inventory. */

/**
 * Read-only linearization point for Manager's writer-busy fallback. A cached
 * process token is reusable only while the exact active view and the exact
 * unexpired lease coexist in one SQLite snapshot and no exact tombstone does.
 */

/**
 * Adapt copy pages toward a three-second transaction while retaining a wide
 * margin below the 15-second build heartbeat threshold. Growth is limited to
 * 2x per observation so a fast region cannot immediately create an oversized
 * synchronous SQLite statement in the next, denser B-tree region.
 */

/**
 * Copies one final-table partition in bounded keyset transactions. The target
 * snapshot remains `building`, so committed chunks are invisible to normal
 * readers while SQLite can checkpoint and the heartbeat can run between them.
 */

/** @internal Exposed so regression tests can verify the SQLite access plan. */

/**
 * Validate staged edge endpoints in bounded primary-key pages. A single
 * anti-join over a multi-million-row graph can keep SQLite in `step()` long
 * enough for an otherwise healthy owner to approach the stale-build window.
 * Page aggregates preserve the same invariant while giving the status writer
 * a regular heartbeat without hydrating every edge in JavaScript.
 */

/** Reclaim exactly one bounded build-only table page, if one is available. */

/**
 * Durable build-only rows are unreachable as soon as a snapshot is ready,
 * failed, or retired. Reclaim them after publication in independently gated
 * pages: readiness never depends on cleanup, and linked worktrees can write
 * between pages even when a large build left millions of candidate rows.
 */

/** @internal Exposed for deterministic SQLite snapshot-contract tests. */

/**
 * Superseded persistent builds can own repository-sized durable tables. Reclaim
 * their exact identities before the replacement build starts, one transaction
 * at a time. The writer gate is released between pages so linked worktrees can
 * make progress; unlike best-effort detached cleanup, this required path waits
 * through contention until every still-eligible target is gone.
 */

// Stay comfortably below SQLite's cross-platform parameter ceiling while
// avoiding thousands of statement preparations on production-sized graphs.

/**
 * Explicit deep-maintenance audit. Normal publication trusts the cumulative
 * counters committed with each resumable batch and never scans every posting.
 * This statement intentionally performs exact counts for tests and operator-
 * initiated evidence collection.
 */

// A sampled 232k-file graph resolved a 5,000-reference page with roughly 80k
// candidate matches in less than four seconds once persistent writes bypassed
// row triggers. Keep connection-private/delta pages conservative, while clean
// full-build pages are independently bounded by reference count, candidate
// count, and encoded payload bytes before their lookup tiers are decoded.

/** @internal Exposed so property tests can verify all three page bounds. */

/** @internal Exposed so regression tests can verify the SQLite access plan. */

/**
 * Resolves TypeScript barrel topology once from durable provenance, then seeds
 * exact scoped aliases before the general reference scan. Deep chains therefore
 * do not require one repository-wide unresolved pass per barrel. Seed pages,
 * a bounded closure result, and the ordinary writer fence keep this optional
 * acceleration from becoming a repository-size rejection or an unbounded write.
 * Pages whose branching closure exceeds the budget safely fall back to the
 * existing reference resolver.
 */

const resolveActivationReferences = Effect.fn('codeGraph.resolveActivationReferences')(function* (
  onProgress?: CodeGraphResolutionProgressCallback,
  writerGate?: CodeGraphWriterGate,
  persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  persistentPageLimits?: CodeGraphPersistentReferencePageLimits,
) {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = yield* Clock.currentTimeMillis;
  const mode = yield* activationMode(sql);
  if (mode?.mode === 'persisted-full') {
    yield* assertPersistentBuildOwner(sql, mode.snapshotId, mode.ownerToken);
    yield* assertPersistentMaterializationComplete(sql, mode.snapshotId, mode.ownerToken);
  }
  const persistentFull = mode?.mode === 'persisted-full' ? mode : undefined;
  const pageRows = persistentFull ? PERSISTENT_FULL_RESOLUTION_PAGE_ROWS : RESOLUTION_PAGE_ROWS;
  const persistedBaseSnapshotId = mode?.mode === 'persisted-delta' ? mode.baseSnapshotId : undefined;
  let aliasesDiscovered = 0;
  let longestTransactionMilliseconds = 0;
  let matchingMilliseconds = 0;
  let pagesCompleted = 0;
  let passesCompleted = 0;
  let referencesExamined = 0;
  let resolved = 0;
  let transactionPreparingBatchMilliseconds = 0;
  let transactionRetiringReferencesMilliseconds = 0;
  let transactionUpdatingAnalysisMilliseconds = 0;
  let transactionMilliseconds = 0;
  let transactionWritingAliasesMilliseconds = 0;
  let transactionWritingEdgesMilliseconds = 0;
  let persistentTransactionPageLimit = PERSISTENT_FULL_RESOLUTION_TRANSACTION_PAGES;
  const transactionStageMilliseconds = () => ({
    preparingBatch: transactionPreparingBatchMilliseconds,
    retiringReferences: transactionRetiringReferencesMilliseconds,
    updatingAnalysis: transactionUpdatingAnalysisMilliseconds,
    writingAliases: transactionWritingAliasesMilliseconds,
    writingEdges: transactionWritingEdgesMilliseconds,
  });
  const observeResolutionTransaction = <A, E, R>(
    transaction: Effect.Effect<A, E, R>,
    onDuration?: (milliseconds: number) => void,
  ) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* transaction;
      const milliseconds = (yield* Clock.currentTimeMillis) - startedAt;
      longestTransactionMilliseconds = Math.max(longestTransactionMilliseconds, milliseconds);
      onDuration?.(milliseconds);
      return result;
    });
  const preparationCountStartedAt = yield* Clock.currentTimeMillis;
  const preparationCountRows = persistentFull
    ? yield* sql<PersistedFullReferenceTotalsRow>`
        SELECT COUNT(*) AS count,
          COALESCE(SUM(candidate_count), 0) AS candidate_count,
          COALESCE(SUM(candidate_payload_bytes), 0) AS payload_bytes
        FROM building_references
        WHERE snapshot_id = ${persistentFull.snapshotId}
      `
    : yield* sql<PersistedFullReferenceTotalsRow>`
        SELECT COUNT(*) AS count, 0 AS candidate_count, 0 AS payload_bytes
        FROM activation_references
      `;
  const preparationReferencesTotal = Number(preparationCountRows[0]?.count ?? 0);
  const preparationPageTotal = persistentFull
    ? persistentFullReferencePageTotal(
        preparationCountRows[0] ?? {candidate_count: 0, count: 0, payload_bytes: 0},
        persistentPageLimits,
      )
    : Math.ceil(preparationReferencesTotal / pageRows);
  matchingMilliseconds += (yield* Clock.currentTimeMillis) - preparationCountStartedAt;
  const reportPreparation = (aliases: number) =>
    Effect.gen(function* () {
      if (onProgress === undefined) return;
      const elapsedMilliseconds = (yield* Clock.currentTimeMillis) - startedAt;
      yield* onProgress({
        aliasesDiscovered: aliases,
        elapsedMilliseconds,
        longestTransactionMilliseconds,
        matchingMilliseconds,
        pageCompleted: 0,
        pageTotal: preparationPageTotal,
        pagesCompleted: 0,
        pass: 1,
        referencesCompleted: 0,
        referencesExamined: 0,
        referencesTotal: preparationReferencesTotal,
        resolved: 0,
        transactionMilliseconds: 0,
        transactionStageMilliseconds: transactionStageMilliseconds(),
      });
    });
  // Report before any closure work, then once per bounded alias seed page. A
  // large re-export surface must not leave the build heartbeat and CLI silent
  // while resolution is actively preparing lookup aliases.
  yield* reportPreparation(0);
  yield* Effect.yieldNow;
  const aliasExpansionStartedAt = yield* Clock.currentTimeMillis;
  aliasesDiscovered += yield* expandTransitiveReexportAliases(
    sql,
    mode,
    writerGate,
    persistentCapacityProtector,
    onProgress === undefined ? undefined : aliases => reportPreparation(aliases),
  );
  matchingMilliseconds += (yield* Clock.currentTimeMillis) - aliasExpansionStartedAt;
  for (;;) {
    const countStartedAt = yield* Clock.currentTimeMillis;
    const countRows = persistentFull
      ? yield* sql<PersistedFullReferenceTotalsRow>`
          SELECT COUNT(*) AS count,
            COALESCE(SUM(candidate_count), 0) AS candidate_count,
            COALESCE(SUM(candidate_payload_bytes), 0) AS payload_bytes
          FROM building_references
          WHERE snapshot_id = ${persistentFull.snapshotId}
        `
      : yield* sql<PersistedFullReferenceTotalsRow>`
          SELECT COUNT(*) AS count, 0 AS candidate_count, 0 AS payload_bytes
          FROM activation_references
        `;
    const referencesTotal = Number(countRows[0]?.count ?? 0);
    matchingMilliseconds += (yield* Clock.currentTimeMillis) - countStartedAt;
    if (referencesTotal === 0) break;
    if (!codeGraphResolutionPassAdmitted(passesCompleted)) {
      return yield* CodeGraphStoreError.of(
        `Code graph reference resolution did not converge within ${CODE_GRAPH_RESOLUTION_PASS_MAXIMUM} bounded passes.`,
      );
    }
    const pass = passesCompleted + 1;
    let pageTotal = persistentFull
      ? persistentFullReferencePageTotal(
          countRows[0] ?? {candidate_count: 0, count: 0, payload_bytes: 0},
          persistentPageLimits,
        )
      : Math.ceil(referencesTotal / pageRows);
    let cursor = '';
    let pageCompleted = 0;
    let referencesCompleted = 0;
    let resolvedInPass = 0;
    let aliasesInPass = 0;
    const reservationPageLimit =
      persistentFull && persistentCapacityProtector ? PERSISTENT_FULL_RESOLUTION_RESERVATION_PAGES : 1;
    const reservationPages: ResolutionTransactionPage[] = [];
    const reportResolutionProgress = (reportedMatchingMilliseconds = matchingMilliseconds) =>
      Effect.gen(function* () {
        if (onProgress === undefined) return;
        yield* onProgress({
          aliasesDiscovered,
          elapsedMilliseconds: (yield* Clock.currentTimeMillis) - startedAt,
          longestTransactionMilliseconds,
          matchingMilliseconds: reportedMatchingMilliseconds,
          pageCompleted,
          pageTotal,
          pagesCompleted,
          pass,
          referencesCompleted,
          referencesExamined,
          referencesTotal,
          resolved,
          transactionMilliseconds,
          transactionStageMilliseconds: transactionStageMilliseconds(),
        });
      });
    const commitTransactionPages = Effect.fn('codeGraph.commitResolutionTransactionPages')(function* (
      transactionPages: readonly ResolutionTransactionPage[],
    ) {
      const resolutions: ActivationResolutionRow[] = [];
      const aliases: Array<readonly [string, string, string, number, 'alias', string, string]> = [];
      let observedTransactionMilliseconds: number | undefined;
      for (const page of transactionPages) {
        for (const resolution of page.resolutions) resolutions.push(resolution);
        for (const alias of page.aliases) aliases.push(alias);
      }
      if (resolutions.length > 0) {
        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            let transactionStageStartedAt = yield* Clock.currentTimeMillis;
            if (mode?.mode === 'persisted-full') {
              yield* assertPersistentBuildOwner(sql, mode.snapshotId, mode.ownerToken);
            }
            yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
            for (const batch of chunk(resolutions, 400)) {
              yield* sql.unsafe(
                `INSERT INTO activation_resolved_reference_batch (
                old_edge_id, new_edge_id, relation, target_id, target_name, provenance, confidence
              ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
                batch.flatMap(row => [
                  row.oldEdgeId,
                  row.newEdgeId,
                  row.relation,
                  row.targetId,
                  row.targetName,
                  row.provenance,
                  row.confidence,
                ]),
              );
            }
            if (mode?.mode === 'persisted-full') {
              yield* capturePersistedAnalysisResolutionEdges(sql, mode.snapshotId);
            }
            transactionPreparingBatchMilliseconds += (yield* Clock.currentTimeMillis) - transactionStageStartedAt;
            transactionStageStartedAt = yield* Clock.currentTimeMillis;
            for (const batch of chunk(aliases, 500)) {
              if (persistentFull) {
                yield* sql.unsafe(
                  `INSERT OR IGNORE INTO snapshot_symbol_lookup (
                     snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
                     provenance, evidence_edge_id, evidence_path
                   ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
                  batch.flatMap(row => [persistentFull.snapshotId, ...row]),
                );
              } else {
                yield* sql.unsafe(
                  `INSERT OR IGNORE INTO activation_symbol_lookup (
                     lookup_key, symbol_id, resolution_domain, exported,
                     provenance, evidence_edge_id, evidence_path
                   ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
                  batch.flat(),
                );
              }
            }
            transactionWritingAliasesMilliseconds += (yield* Clock.currentTimeMillis) - transactionStageStartedAt;
            transactionStageStartedAt = yield* Clock.currentTimeMillis;
            if (persistentFull) {
              yield* sql.unsafe(
                `WITH edge_payloads AS MATERIALIZED (
                   SELECT resolution.old_edge_id, resolution.new_edge_id,
                     edge.source_id, edge.source_name, edge.evidence_path, edge.evidence_span_json
                   FROM activation_resolved_reference_batch AS resolution
                   CROSS JOIN edges AS edge
                     ON edge.snapshot_id = ? AND edge.id = resolution.old_edge_id
                   UNION ALL
                   SELECT resolution.old_edge_id, resolution.new_edge_id,
                     reference.source_id, reference.source_name,
                     reference.evidence_path, reference.evidence_span_json
                   FROM activation_resolved_reference_batch AS resolution
                   CROSS JOIN building_references AS reference
                     ON reference.snapshot_id = ? AND reference.edge_id = resolution.old_edge_id
                   WHERE NOT EXISTS (
                     SELECT 1 FROM edges AS current
                     WHERE current.snapshot_id = ? AND current.id = resolution.old_edge_id
                   )
                 )
                 INSERT OR REPLACE INTO edges (
                   snapshot_id, id, source_id, source_name, relation, target_id, target_name,
                   provenance, confidence, evidence_path, evidence_span_json
                 )
                 SELECT
                   ?, resolution.new_edge_id, payload.source_id, payload.source_name,
                   resolution.relation, resolution.target_id, resolution.target_name,
                   resolution.provenance, resolution.confidence,
                   payload.evidence_path, payload.evidence_span_json
                 FROM activation_resolved_reference_batch AS resolution
                 CROSS JOIN edge_payloads AS payload
                   ON payload.old_edge_id = resolution.old_edge_id
                      AND payload.new_edge_id = resolution.new_edge_id
                 ORDER BY resolution.new_edge_id, resolution.old_edge_id`,
                [
                  persistentFull.snapshotId,
                  persistentFull.snapshotId,
                  persistentFull.snapshotId,
                  persistentFull.snapshotId,
                ],
              );
              yield* sql.unsafe(
                `DELETE FROM edges
                 WHERE snapshot_id = ?
                   AND id IN (
                     SELECT old_edge_id
                     FROM activation_resolved_reference_batch
                     WHERE old_edge_id <> new_edge_id
                   )
                   AND id NOT IN (SELECT new_edge_id FROM activation_resolved_reference_batch)`,
                [persistentFull.snapshotId],
              );
              transactionWritingEdgesMilliseconds += (yield* Clock.currentTimeMillis) - transactionStageStartedAt;
              transactionStageStartedAt = yield* Clock.currentTimeMillis;
              yield* adjustPersistedAnalysisResolutionEdges(sql, persistentFull.snapshotId);
              transactionUpdatingAnalysisMilliseconds += (yield* Clock.currentTimeMillis) - transactionStageStartedAt;
              transactionStageStartedAt = yield* Clock.currentTimeMillis;
              // The compact candidate payload is owned by this reference row,
              // so one bounded delete retires the grouped pages after commit.
              yield* sql.unsafe(
                `DELETE FROM building_references
                 WHERE snapshot_id = ?
                   AND edge_id IN (SELECT old_edge_id FROM activation_resolved_reference_batch)`,
                [persistentFull.snapshotId],
              );
              transactionRetiringReferencesMilliseconds += (yield* Clock.currentTimeMillis) - transactionStageStartedAt;
            } else {
              yield* sql.unsafe(`
                INSERT OR REPLACE INTO activation_edges (
                  id, source_id, source_name, relation, target_id, target_name, provenance,
                  confidence, evidence_path, evidence_span_json
                )
                SELECT
                  resolution.new_edge_id,
                  edge.source_id,
                  edge.source_name,
                  resolution.relation,
                  resolution.target_id,
                  resolution.target_name,
                  resolution.provenance,
                  resolution.confidence,
                  edge.evidence_path,
                  edge.evidence_span_json
                FROM activation_resolved_reference_batch AS resolution
                JOIN activation_edges AS edge ON edge.id = resolution.old_edge_id
              `);
              yield* sql.unsafe(`
                DELETE FROM activation_edges
                WHERE id IN (
                  SELECT old_edge_id
                  FROM activation_resolved_reference_batch
                  WHERE old_edge_id <> new_edge_id
                )
                  AND id NOT IN (SELECT new_edge_id FROM activation_resolved_reference_batch)
              `);
              transactionWritingEdgesMilliseconds += (yield* Clock.currentTimeMillis) - transactionStageStartedAt;
              transactionStageStartedAt = yield* Clock.currentTimeMillis;
              yield* sql.unsafe(`
                DELETE FROM activation_reference_candidates
                WHERE edge_id IN (SELECT old_edge_id FROM activation_resolved_reference_batch)
              `);
              yield* sql.unsafe(`
                DELETE FROM activation_references
                WHERE edge_id IN (SELECT old_edge_id FROM activation_resolved_reference_batch)
              `);
              transactionRetiringReferencesMilliseconds += (yield* Clock.currentTimeMillis) - transactionStageStartedAt;
            }
          }),
        );
        const observedTransaction = observeResolutionTransaction(transaction, milliseconds => {
          observedTransactionMilliseconds = milliseconds;
        });
        const gatedTransaction =
          mode?.mode === 'persisted-full' && writerGate ? writerGate(observedTransaction) : observedTransaction;
        yield* gatedTransaction;
      }
      // A later transaction in the same reservation can fail after this group
      // commits. Advance counters per committed group so a resumed pass never
      // pretends the durable prefix was rolled back.
      aliasesInPass += aliases.length;
      aliasesDiscovered += aliases.length;
      resolvedInPass += resolutions.length;
      resolved += resolutions.length;
      return observedTransactionMilliseconds;
    });
    const flushReservationPages = Effect.fn('codeGraph.flushResolutionReservationPages')(function* () {
      if (reservationPages.length === 0) return;
      const reservations = planPersistentReferenceResolutionPages(reservationPages, persistentTransactionPageLimit);
      for (const reservation of reservations) {
        const transactions = Effect.gen(function* () {
          for (let index = 0; index < reservation.transactions.length; index += 1) {
            const observedTransactionMilliseconds = yield* commitTransactionPages(reservation.transactions[index]);
            if (persistentFull && observedTransactionMilliseconds !== undefined) {
              persistentTransactionPageLimit = nextPersistentReferenceResolutionTransactionPages(
                persistentTransactionPageLimit,
                observedTransactionMilliseconds,
              );
            }
            if (index + 1 < reservation.transactions.length) {
              // The writer lock is released at this boundary. Preserve the
              // bounded transaction progress cadence without reacquiring the
              // wider disk-capacity reservation for the next transaction.
              yield* reportResolutionProgress();
              yield* Effect.yieldNow;
            }
          }
        });
        const hasResolutions = reservation.pages.some(page => page.resolutions.length > 0);
        if (hasResolutions) {
          const transactionStartedAt = yield* Clock.currentTimeMillis;
          yield* persistentCapacityProtector
            ? persistentCapacityProtector(
                aggregatePersistentReferenceResolutionCapacityBoundaries(reservation.pages.map(page => page.capacity)),
                transactions,
              )
            : transactions;
          transactionMilliseconds += (yield* Clock.currentTimeMillis) - transactionStartedAt;
        } else {
          yield* transactions;
        }
      }
      reservationPages.length = 0;
    });
    const flushUnresolvedReferenceEdges = Effect.fn('codeGraph.flushUnresolvedReferenceEdges')(function* () {
      if (!persistentFull) return;
      let unresolvedCursor = '';
      let unresolvedBatchRows = PERSISTENT_UNRESOLVED_REFERENCE_INITIAL_BATCH_ROWS;
      for (;;) {
        const unresolved = yield* sql.unsafe<EdgeRow>(
          `SELECT edge_id AS id, source_id, source_name, relation, NULL AS target_id,
             target_name, provenance, confidence, evidence_path, evidence_span_json
           FROM building_references
           WHERE snapshot_id = ? AND edge_id > ?
           ORDER BY edge_id
           LIMIT ${unresolvedBatchRows}`,
          [persistentFull.snapshotId, unresolvedCursor],
        );
        if (unresolved.length === 0) break;
        const batchEnd = unresolved.at(-1)!.id;
        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            yield* assertPersistentBuildOwner(sql, persistentFull.snapshotId, persistentFull.ownerToken);
            let transactionStageStartedAt = yield* Clock.currentTimeMillis;
            // A resolved edge can intentionally collide with the original ID
            // of a still-unresolved reference. INSERT OR IGNORE preserves the
            // already-established winner exactly as the former eager raw-edge
            // insert followed by resolution replacement did.
            yield* sql.unsafe(
              `INSERT OR IGNORE INTO edges (
                 snapshot_id, id, source_id, source_name, relation, target_id, target_name,
                 provenance, confidence, evidence_path, evidence_span_json
               )
               SELECT snapshot_id, edge_id, source_id, source_name, relation, NULL, target_name,
                 provenance, confidence, evidence_path, evidence_span_json
               FROM building_references
               WHERE snapshot_id = ? AND edge_id > ? AND edge_id <= ?
               ORDER BY edge_id`,
              [persistentFull.snapshotId, unresolvedCursor, batchEnd],
            );
            transactionWritingEdgesMilliseconds += (yield* Clock.currentTimeMillis) - transactionStageStartedAt;
            transactionStageStartedAt = yield* Clock.currentTimeMillis;
            yield* sql.unsafe(
              `DELETE FROM building_references
               WHERE snapshot_id = ? AND edge_id > ? AND edge_id <= ?`,
              [persistentFull.snapshotId, unresolvedCursor, batchEnd],
            );
            transactionRetiringReferencesMilliseconds += (yield* Clock.currentTimeMillis) - transactionStageStartedAt;
          }),
        );
        let observedTransactionMilliseconds = 0;
        const observedTransaction = observeResolutionTransaction(transaction, milliseconds => {
          observedTransactionMilliseconds = milliseconds;
        });
        const gated = writerGate ? writerGate(observedTransaction) : observedTransaction;
        const protectedTransaction = persistentCapacityProtector
          ? persistentCapacityProtector(
              persistentUnresolvedReferenceCapacityBoundary(persistentFull.snapshotId, unresolved),
              gated,
            )
          : gated;
        const transactionStartedAt = yield* Clock.currentTimeMillis;
        yield* protectedTransaction;
        transactionMilliseconds += (yield* Clock.currentTimeMillis) - transactionStartedAt;
        unresolvedCursor = batchEnd;
        unresolvedBatchRows = nextPersistentUnresolvedReferenceBatchRows(
          unresolvedBatchRows,
          observedTransactionMilliseconds,
          preparationReferencesTotal,
        );
        yield* reportResolutionProgress();
        yield* Effect.yieldNow;
      }
    });
    yield* reportResolutionProgress();
    yield* Effect.yieldNow;
    for (;;) {
      const pageStartedAt = yield* Clock.currentTimeMillis;
      let persistentPage = Option.none<readonly PersistedFullReferencePageRow[]>();
      if (persistentFull) {
        const statement = codeGraphPersistentReferencePageStatement(
          persistentFull.snapshotId,
          cursor,
          persistentPageLimits,
        );
        persistentPage = Option.some(
          yield* sql.unsafe<PersistedFullReferencePageRow>(statement.text, statement.parameters),
        );
      }
      const pending = Option.isSome(persistentPage)
        ? persistentPage.value
        : yield* sql.unsafe<{readonly edge_id: string}>(
            `SELECT edge_id
             FROM activation_references
             WHERE edge_id > ?
             ORDER BY edge_id
             LIMIT ${pageRows}`,
            [cursor],
          );
      if (pending.length === 0) break;
      const batchEnd = pending.at(-1)!.edge_id;
      const rows =
        persistentFull && Option.isSome(persistentPage)
          ? yield* resolvePersistedFullReferencePage(
              sql,
              persistentFull.snapshotId,
              persistentPage.value,
              cursor,
              batchEnd,
              () =>
                Effect.gen(function* () {
                  yield* reportResolutionProgress(
                    matchingMilliseconds + (yield* Clock.currentTimeMillis) - pageStartedAt,
                  );
                }),
            )
          : persistedBaseSnapshotId
            ? yield* (() => {
                const statement = codeGraphPersistedDeltaResolutionPageStatement(
                  persistedBaseSnapshotId,
                  cursor,
                  batchEnd,
                );
                return sql.unsafe<ResolvableActivationReferenceRow>(statement.text, statement.parameters);
              })()
            : yield* sql.unsafe<ResolvableActivationReferenceRow>(
                `
        WITH
        candidate_matches AS (
          SELECT DISTINCT
            candidate.edge_id,
            candidate.tier,
            lookup.symbol_id,
            0 AS ambiguous
          FROM activation_reference_candidates AS candidate
          CROSS JOIN activation_references AS reference
            ON reference.edge_id = candidate.edge_id
          CROSS JOIN activation_edges AS edge
            ON edge.id = candidate.edge_id AND edge.target_id IS NULL
          CROSS JOIN activation_symbol_lookup AS lookup
            ON lookup.lookup_key = candidate.lookup_key
           AND lookup.resolution_domain = reference.resolution_domain
           AND (reference.exported_only = 0 OR lookup.exported = 1)
           AND (edge.relation <> 'overrides' OR lookup.symbol_id IS NOT edge.source_id)
          WHERE candidate.edge_id > ? AND candidate.edge_id <= ?
        ),
        first_tiers AS (
          SELECT edge_id, MIN(tier) AS tier
          FROM candidate_matches
          GROUP BY edge_id
        ),
        unique_candidates AS (
          SELECT match.edge_id, MIN(match.symbol_id) AS symbol_id
          FROM candidate_matches AS match
          JOIN first_tiers AS first
            ON first.edge_id = match.edge_id AND first.tier = match.tier
          GROUP BY match.edge_id
          HAVING MAX(match.ambiguous) = 0 AND COUNT(DISTINCT match.symbol_id) = 1
        )
        SELECT
          edge.*,
          reference.alias_lookup_keys_json,
          symbol.id AS target_symbol_id,
          symbol.name AS target_symbol_name,
          symbol.exported AS symbol_exported,
          symbol.kind AS symbol_kind,
          symbol.resolution_domain AS symbol_resolution_domain
        FROM unique_candidates AS candidate
        CROSS JOIN activation_edges AS edge ON edge.id = candidate.edge_id
        CROSS JOIN activation_references AS reference ON reference.edge_id = candidate.edge_id
        CROSS JOIN activation_symbols AS symbol ON symbol.id = candidate.symbol_id
        ORDER BY candidate.edge_id
        LIMIT ${pageRows}
        `,
                [cursor, batchEnd],
              );
      matchingMilliseconds += (yield* Clock.currentTimeMillis) - pageStartedAt;
      cursor = batchEnd;
      const resolutions: ActivationResolutionRow[] = [];
      const aliases: Array<readonly [string, string, string, number, 'alias', string, string]> = [];
      for (const row of rows) {
        const provenance: CodeGraphProvenance =
          row.provenance === 'declared' ? 'declared' : row.relation === 'documents' ? 'syntactic' : 'resolved';
        const relation =
          row.relation === 'extends' && ['interface', 'protocol'].includes(row.symbol_kind)
            ? 'implements'
            : row.relation;
        resolutions.push({
          confidence: provenance === 'declared' || provenance === 'resolved' ? 1 : row.confidence,
          newEdgeId: activationEdgeId(
            Option.getOrUndefined(sqlTextOption(row.source_id)),
            row.source_name,
            relation,
            row.target_symbol_id,
            row.target_symbol_name,
            provenance,
            row.evidence_path,
          ),
          oldEdgeId: row.id,
          provenance,
          relation,
          targetId: row.target_symbol_id,
          targetName: row.target_symbol_name,
        });
        for (const alias of parseLookupKeys(row.alias_lookup_keys_json)) {
          aliases.push([
            alias,
            row.target_symbol_id,
            lookupDomain(alias, Option.getOrUndefined(sqlTextOption(row.symbol_resolution_domain))),
            row.symbol_exported,
            'alias',
            row.id,
            row.evidence_path,
          ]);
        }
      }
      reservationPages.push({
        aliases,
        capacity: persistentReferenceResolutionCapacityBoundary(
          mode?.mode === 'persisted-full' ? mode.snapshotId : (persistedBaseSnapshotId ?? 'temporary'),
          rows,
          resolutions,
          aliases,
          mode?.mode !== 'persisted-full',
        ),
        resolutions,
      });
      pageCompleted += 1;
      // Aggregate candidate/byte ceilings normally predict the exact page
      // count. Pathological alternating payload shapes can require more pages;
      // grow the denominator before emitting so persisted status remains valid
      // without a repository-wide boundary pre-scan.
      pageTotal = Math.max(pageTotal, pageCompleted);
      pagesCompleted += 1;
      referencesCompleted += pending.length;
      referencesExamined += pending.length;
      if (reservationPages.length >= reservationPageLimit) yield* flushReservationPages();
      yield* reportResolutionProgress();
      // Reference resolution is synchronous SQLite work. Yield after every
      // bounded page so the independent build heartbeat and observers cannot
      // be starved for the duration of an entire repository-sized pass.
      yield* Effect.yieldNow;
    }
    const hadReservationRemainder = reservationPages.length > 0;
    yield* flushReservationPages();
    if (hadReservationRemainder) {
      yield* reportResolutionProgress();
      yield* Effect.yieldNow;
    }
    passesCompleted += 1;
    if (resolvedInPass === 0 || aliasesInPass === 0) {
      yield* flushUnresolvedReferenceEdges();
      break;
    }
  }
  return {
    aliasesDiscovered,
    elapsedMilliseconds: (yield* Clock.currentTimeMillis) - startedAt,
    longestTransactionMilliseconds,
    matchingMilliseconds,
    pagesCompleted,
    passesCompleted,
    referencesExamined,
    resolved,
    transactionMilliseconds,
  } satisfies CodeGraphResolutionSummary;
});

const promoteSnapshot = Effect.fn('codeGraph.promoteSnapshot')(function* (
  identity: RepositoryIdentity,
  snapshotId: string,
  capacity: SnapshotPromotionCapacityPlan,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* CodeGraphStoreError.of('Code graph promotion authority schema is unavailable.');
      }
      const candidate = yield* sql<{
        readonly generation: number | null;
        readonly id: string;
        readonly scope_id: string;
        readonly minimum_generation: number;
      }>`
        SELECT snapshot.id, snapshot.scope_id, generation.generation,
          CAST(minimum.value AS INTEGER) AS minimum_generation
        FROM snapshots AS snapshot
        JOIN schema_metadata AS minimum ON minimum.key = 'minimum_extractor_generation'
        LEFT JOIN snapshot_extractor_generations AS generation ON generation.snapshot_id = snapshot.id
        WHERE snapshot.id = ${snapshotId} AND snapshot.state = 'ready'
        LIMIT 1
      `;
      if (!candidate[0]) {
        return yield* CodeGraphStoreError.of(`Ready snapshot ${snapshotId} cannot be promoted.`);
      }
      const scopeId = candidate[0].scope_id;
      if (
        candidate[0].generation === null ||
        Number(candidate[0].generation) < Number(candidate[0].minimum_generation)
      ) {
        return yield* CodeGraphStoreError.of(
          `Ready snapshot ${snapshotId} was built by an incompatible extractor generation.`,
        );
      }
      const active = yield* sql.unsafe<{readonly activated_at: unknown; readonly snapshot_id: unknown}>(
        `SELECT CASE
           WHEN typeof(snapshot_id) = 'text' AND length(CAST(snapshot_id AS BLOB)) BETWEEN 45 AND 67
           THEN snapshot_id ELSE NULL END AS snapshot_id,
           CASE WHEN typeof(activated_at) = 'text' AND length(CAST(activated_at AS BLOB)) = 24
             THEN activated_at ELSE NULL END AS activated_at
         FROM active_snapshots WHERE worktree_id = ? AND scope_id = ? LIMIT 2`,
        [identity.worktreeId, scopeId],
      );
      const displacedSnapshotId = active[0]?.snapshot_id;
      const displacedActivatedAt = active[0]?.activated_at;
      if (
        active.length > 1 ||
        (displacedSnapshotId !== undefined &&
          (typeof displacedSnapshotId !== 'string' ||
            !CODE_GRAPH_SNAPSHOT_ID.test(displacedSnapshotId) ||
            typeof displacedActivatedAt !== 'string' ||
            !validCanonicalTimestamp(displacedActivatedAt)))
      ) {
        return yield* CodeGraphStoreError.of('Code graph active view authority is invalid.');
      }
      const removed = yield* sql.unsafe<{
        readonly expected_snapshot_id: unknown;
        readonly removed_at: unknown;
      }>(
        `SELECT
           CASE WHEN typeof(expected_snapshot_id) = 'text'
                      AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
             THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id,
           CASE WHEN typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
             THEN removed_at ELSE NULL END AS removed_at
         FROM removed_views WHERE worktree_id = ? AND scope_id = ? LIMIT 2`,
        [identity.worktreeId, scopeId],
      );
      const removedSnapshotId = removed[0]?.expected_snapshot_id;
      const removedAt = removed[0]?.removed_at;
      if (
        removed.length > 1 ||
        (removedSnapshotId !== undefined &&
          (typeof removedSnapshotId !== 'string' ||
            !CODE_GRAPH_SNAPSHOT_ID.test(removedSnapshotId) ||
            typeof removedAt !== 'string' ||
            !validCanonicalTimestamp(removedAt)))
      ) {
        return yield* CodeGraphStoreError.of('Code graph removed view authority is invalid.');
      }
      const observedLeaseCapacity = yield* snapshotPromotionLeaseCapacity(
        sql,
        typeof removedSnapshotId === 'string' ? [snapshotId, removedSnapshotId] : [snapshotId],
        yield* Clock.currentTimeMillis,
      );
      if (
        observedLeaseCapacity.rows > capacity.maximumLeaseRows ||
        observedLeaseCapacity.factBytes > capacity.maximumLeaseFactBytes
      ) {
        return yield* CodeGraphPromotionCapacityPlanChanged.make({});
      }
      const activatedAt = nextCodeGraphActiveViewActivationTimestamp(capacity.activatedAt, [
        typeof displacedActivatedAt === 'string' ? displacedActivatedAt : undefined,
        typeof removedAt === 'string' ? removedAt : undefined,
      ]);
      if (activatedAt === undefined) {
        return yield* CodeGraphStoreError.of('Code graph active view generation is invalid.');
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
        VALUES (${identity.worktreeId}, ${scopeId}, ${snapshotId}, ${activatedAt})
        ON CONFLICT(worktree_id, scope_id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          activated_at = excluded.activated_at
      `;
      yield* sql`DELETE FROM scope_applicability WHERE worktree_id = ${identity.worktreeId} AND scope_id = ${scopeId}
        AND active_snapshot_id <> ${snapshotId}`;
      // Only a current promotion contract may make this worktree visible
      // again. Mixed-version writers can still publish active_snapshots, but
      // the durable tombstone keeps those pointers hidden until this delete.
      if (typeof removedSnapshotId === 'string' && typeof removedAt === 'string') {
        if (removedSnapshotId !== snapshotId) {
          yield* markSnapshotLeaseRetirementBaton(sql, removedSnapshotId, now);
        }
        yield* sql`
          DELETE FROM removed_view_cleanup
          WHERE worktree_id = ${identity.worktreeId}
            AND scope_id = ${scopeId}
            AND expected_snapshot_id = ${removedSnapshotId}
            AND removed_at = ${removedAt}
        `;
        yield* sql`
          DELETE FROM removed_views
          WHERE worktree_id = ${identity.worktreeId}
            AND scope_id = ${scopeId}
            AND expected_snapshot_id = ${removedSnapshotId}
            AND removed_at = ${removedAt}
        `;
        if ((yield* lastStatementChangeCount(sql)) !== 1) {
          return yield* CodeGraphStoreError.of('Code graph removed view authority changed.');
        }
      }
      // A lease acquired by ID may precede promotion. Once a dirty snapshot
      // owns an active pointer, carry retirement to its final release after
      // displacement. Clean snapshots remain bounded warm-cache candidates.
      yield* markSnapshotLeaseRetirementBaton(sql, snapshotId, now, true);
      if (displacedSnapshotId === undefined || displacedSnapshotId === snapshotId) return 0;
      // Dirty overlays cannot be exact future aliases. Recent clean snapshots
      // remain ready and are bounded by routine per-repository LRU retention,
      // allowing a dirty edit reverted to HEAD to reuse the exact clean graph.
      yield* sql`
        UPDATE snapshots AS candidate
        SET state = 'retired'
        WHERE candidate.id = ${displacedSnapshotId}
          AND candidate.state = 'ready'
          AND candidate.dirty = 1
          AND NOT EXISTS (
            SELECT 1 FROM active_snapshots AS active
            WHERE active.snapshot_id = candidate.id
              AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active.worktree_id
                  AND removed.expected_snapshot_id = active.snapshot_id
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_leases AS lease
            WHERE lease.snapshot_id = candidate.id AND lease.expires_at > ${now}
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshots AS child WHERE child.base_snapshot_id = candidate.id
          )
      `;
      return yield* lastStatementChangeCount(sql);
    }),
  );
});

export {resolveActivationReferences, promoteSnapshot};
