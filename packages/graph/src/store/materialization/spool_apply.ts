import {DateTime, Effect} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {codeGraphMaterializationApplyPages} from '../../materialization/spool.js';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES} from '../../materialization/spool/apply_surfaces.js';
import {assertPersistentBuildOwner, assertPersistentMaterializationComplete} from '../build/core.js';
import {CodeGraphStoreError, type CodeGraphStoreFailure} from '../../types.js';

export interface CodeGraphMaterializationSpoolSurfacePlan {
  readonly name: string;
  readonly rowCount: number;
}

export interface CodeGraphMaterializationSpoolApplyPageResult {
  readonly afterRowid?: number;
  readonly rowCount: number;
  readonly state: 'applied' | 'complete';
  readonly surfaceIndex: number;
  readonly surfaceName: string;
}

interface MaterializationSpoolSurfaceRow {
  readonly applied_row_count: number;
  readonly complete: number;
  readonly next_page_index: number;
  readonly row_count: number;
  readonly spool_identity: string;
  readonly surface_index: number;
  readonly surface_name: string;
}

export const registerCodeGraphMaterializationSpoolApply = Effect.fn('codeGraph.registerMaterializationSpoolApply')(
  function* (
    sql: SqlClient.SqlClient,
    snapshotId: string,
    ownerToken: string,
    spoolIdentity: string,
    surfaces: readonly CodeGraphMaterializationSpoolSurfacePlan[],
    observeTransaction?: () => Effect.Effect<void>,
  ) {
    yield* validateApplyIdentity(spoolIdentity);
    yield* validateSurfacePlan(surfaces);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
        const existing = yield* readSurfaceRows(sql, snapshotId);
        if (existing.length > 0) {
          if (!surfaceRowsMatch(existing, spoolIdentity, surfaces)) {
            return yield* CodeGraphStoreError.of(
              'Persistent materialization spool apply plan changed; discard and rebuild it.',
            );
          }
          return 'resumed' as const;
        }
        yield* sql.unsafe(
          `INSERT INTO building_materialization_spool_surfaces (
           snapshot_id, surface_index, spool_identity, surface_name, row_count,
           next_page_index, applied_row_count, complete
         ) VALUES ${surfaces.map(() => '(?, ?, ?, ?, ?, 0, 0, ?)').join(', ')}`,
          surfaces.flatMap((surface, index) => [
            snapshotId,
            index,
            spoolIdentity,
            surface.name,
            surface.rowCount,
            surface.rowCount === 0 ? 1 : 0,
          ]),
        );
        yield* observeTransaction?.() ?? Effect.void;
        return 'registered' as const;
      }),
    );
  },
);

export const applyCodeGraphMaterializationSpoolSurfacePage = Effect.fn(
  'codeGraph.applyMaterializationSpoolSurfacePage',
)(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  spoolIdentity: string,
  surfaceIndex: number,
  writePage: (page: {readonly afterRowid: number; readonly rowCount: number}) => Effect.Effect<void, unknown>,
  observeTransaction?: () => Effect.Effect<void>,
) {
  yield* validateApplyIdentity(spoolIdentity);
  if (
    !Number.isSafeInteger(surfaceIndex) ||
    surfaceIndex < 0 ||
    surfaceIndex >= CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.length
  ) {
    return yield* CodeGraphStoreError.of('Persistent materialization spool surface index is invalid.');
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      const rows = yield* readSurfaceRows(sql, snapshotId);
      const expected = CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES[surfaceIndex];
      const current = rows[surfaceIndex];
      if (
        rows.length !== CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.length ||
        current === undefined ||
        current.surface_index !== surfaceIndex ||
        current.surface_name !== expected.name ||
        current.spool_identity !== spoolIdentity ||
        rows.some(row => row.spool_identity !== spoolIdentity) ||
        rows.slice(0, surfaceIndex).some(row => row.complete !== 1)
      ) {
        return yield* CodeGraphStoreError.of('Persistent materialization spool apply state is invalid.');
      }
      if (current.complete === 1) {
        return {
          rowCount: current.row_count,
          state: 'complete',
          surfaceIndex,
          surfaceName: current.surface_name,
        } satisfies CodeGraphMaterializationSpoolApplyPageResult;
      }
      const scheduledPages = codeGraphMaterializationApplyPages(current.row_count);
      const pages =
        'pageOrder' in expected && expected.pageOrder === 'ascending'
          ? [...scheduledPages].sort((left, right) => left.afterRowid - right.afterRowid)
          : scheduledPages;
      const page = pages[current.next_page_index];
      if (page === undefined) {
        return yield* CodeGraphStoreError.of('Persistent materialization spool apply cursor is invalid.');
      }
      yield* writePage(page).pipe(
        Effect.mapError(() => CodeGraphStoreError.of('Persistent materialization spool page could not be applied.')),
      );
      const changes = yield* sql.unsafe<{readonly count: number | bigint}>('SELECT changes() AS count');
      const inserted = Number(changes[0]?.count ?? -1);
      if (inserted !== page.rowCount) {
        return yield* CodeGraphStoreError.of(
          `Persistent materialization spool page lost ${Math.max(0, page.rowCount - inserted)} row(s).`,
        );
      }
      const appliedRowCount = current.applied_row_count + inserted;
      const complete = appliedRowCount === current.row_count ? 1 : 0;
      yield* sql.unsafe(
        `UPDATE building_materialization_spool_surfaces
         SET next_page_index = next_page_index + 1,
             applied_row_count = ?,
             complete = ?
         WHERE snapshot_id = ? AND surface_index = ? AND spool_identity = ?
           AND next_page_index = ? AND applied_row_count = ? AND complete = 0`,
        [
          appliedRowCount,
          complete,
          snapshotId,
          surfaceIndex,
          spoolIdentity,
          current.next_page_index,
          current.applied_row_count,
        ],
      );
      const updates = yield* sql.unsafe<{readonly count: number | bigint}>('SELECT changes() AS count');
      if (Number(updates[0]?.count ?? 0) !== 1) {
        return yield* CodeGraphStoreError.of('Persistent materialization spool apply cursor changed.');
      }
      yield* observeTransaction?.() ?? Effect.void;
      return {
        afterRowid: page.afterRowid,
        rowCount: page.rowCount,
        state: 'applied',
        surfaceIndex,
        surfaceName: current.surface_name,
      } satisfies CodeGraphMaterializationSpoolApplyPageResult;
    }),
  );
});

export const writeCodeGraphMaterializationSpoolSurfacePage = Effect.fn(
  'codeGraph.writeMaterializationSpoolSurfacePage',
)(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  surfaceIndex: number,
  page: {readonly afterRowid: number; readonly rowCount: number},
) {
  const surface = CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES[surfaceIndex];
  if (surface === undefined || !Number.isSafeInteger(page.afterRowid) || page.afterRowid < 0 || page.rowCount <= 0) {
    return yield* CodeGraphStoreError.of('Persistent materialization spool page is invalid.');
  }
  const upperRowid = page.afterRowid + page.rowCount;
  switch (surface.name) {
    case 'symbols':
      return yield* sql.unsafe(
        `INSERT INTO symbols (
           snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
           arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
           exported, signature, documentation, span_json
         ) SELECT ?, id, content_hash, kind, name, qualified_name, path, language,
           arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
           exported, signature, documentation, span_json
         FROM materialization_spool.materialization_ordered_symbols
         WHERE rowid > ? AND rowid <= ? ORDER BY rowid`,
        [snapshotId, page.afterRowid, upperRowid],
      );
    case 'lookup':
      return yield* sql.unsafe(
        `INSERT INTO snapshot_symbol_lookup (
           snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
           provenance, evidence_edge_id, evidence_path
         ) SELECT ?, lookup_key, symbol_id, resolution_domain, exported,
           provenance, evidence_edge_id, evidence_path
         FROM materialization_spool.materialization_ordered_lookup
         WHERE rowid > ? AND rowid <= ? ORDER BY rowid`,
        [snapshotId, page.afterRowid, upperRowid],
      );
    case 'edges':
      return yield* sql.unsafe(
        `INSERT INTO edges (
           snapshot_id, id, source_id, source_name, relation, target_id, target_name,
           provenance, confidence, evidence_path, evidence_span_json
         ) SELECT ?, id, source_id, source_name, relation, target_id, target_name,
           provenance, confidence, evidence_path, evidence_span_json
         FROM materialization_spool.materialization_ordered_edges
         WHERE rowid > ? AND rowid <= ? ORDER BY rowid`,
        [snapshotId, page.afterRowid, upperRowid],
      );
    case 'references':
      return yield* sql.unsafe(
        `INSERT INTO building_references (
           snapshot_id, edge_id, resolution_domain, exported_only, alias_lookup_keys_json,
           lookup_tiers_json, candidate_count, candidate_payload_bytes, source_id, source_name,
           relation, target_name, provenance, confidence, evidence_path, evidence_span_json
         ) SELECT ?, edge_id, resolution_domain, exported_only, alias_lookup_keys_json,
           lookup_tiers_json, candidate_count, candidate_payload_bytes, source_id, source_name,
           relation, target_name, provenance, confidence, evidence_path, evidence_span_json
         FROM materialization_spool.materialization_ordered_references
         WHERE rowid > ? AND rowid <= ? ORDER BY rowid`,
        [snapshotId, page.afterRowid, upperRowid],
      );
    case 'reexports':
      return yield* sql.unsafe(
        `INSERT INTO snapshot_reexport_provenance (
           snapshot_id, source_path, local_name, target_path, imported_name
         ) SELECT ?, source_path, local_name, target_path, imported_name
         FROM materialization_spool.materialization_ordered_reexports
         WHERE rowid > ? AND rowid <= ? ORDER BY rowid`,
        [snapshotId, page.afterRowid, upperRowid],
      );
    case 'monikers':
      return yield* sql.unsafe(
        `INSERT INTO code_graph_monikers (
           snapshot_id, id, version, scheme, role, kind, resolution_domain, identity,
           package_name, package_version, import_path, qualified_name, component_id,
           symbol_id, dependency_kind, evidence_path, evidence_span_json
         ) SELECT ?, id, version, scheme, role, kind, resolution_domain, identity,
           package_name, package_version, import_path, qualified_name, component_id,
           symbol_id, dependency_kind, evidence_path, evidence_span_json
         FROM materialization_spool.materialization_ordered_monikers
         WHERE rowid > ? AND rowid <= ? ORDER BY rowid`,
        [snapshotId, page.afterRowid, upperRowid],
      );
    case 'lexical_snapshot':
      return yield* sql`INSERT INTO lexical_compact_snapshots (snapshot_id) VALUES (${snapshotId})`;
    case 'lexical_symbols':
      return yield* sql.unsafe(
        `INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id)
         SELECT compact.snapshot_key, source.id
         FROM materialization_spool.materialization_ordered_symbols AS source
         CROSS JOIN lexical_compact_snapshots AS compact ON compact.snapshot_id = ?
         WHERE source.rowid > ? AND source.rowid <= ? ORDER BY source.rowid`,
        [snapshotId, page.afterRowid, upperRowid],
      );
    case 'lexical_terms':
      return yield* sql.unsafe(
        `INSERT INTO lexical_compact_terms (snapshot_key, term)
         SELECT compact.snapshot_key, source.term
         FROM materialization_spool.materialization_ordered_terms AS source
         CROSS JOIN lexical_compact_snapshots AS compact ON compact.snapshot_id = ?
         WHERE source.rowid > ? AND source.rowid <= ? ORDER BY source.rowid`,
        [snapshotId, page.afterRowid, upperRowid],
      );
    case 'symbol_terms':
      return yield* sql.unsafe(
        `INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
         SELECT compact.snapshot_key, terms.term_key, symbols.symbol_key, source.weight
         FROM materialization_spool.materialization_ordered_symbol_terms AS source
         CROSS JOIN lexical_compact_snapshots AS compact ON compact.snapshot_id = ?
         CROSS JOIN lexical_compact_terms AS terms
           ON terms.snapshot_key = compact.snapshot_key AND terms.term = source.term
         CROSS JOIN lexical_compact_symbols AS symbols
           ON symbols.snapshot_key = compact.snapshot_key AND symbols.symbol_id = source.symbol_id
         WHERE source.rowid > ? AND source.rowid <= ?
         ORDER BY terms.term_key, symbols.symbol_key`,
        [snapshotId, page.afterRowid, upperRowid],
      );
  }
});

export const assertCodeGraphMaterializationSpoolApplyComplete = Effect.fn(
  'codeGraph.assertMaterializationSpoolApplyComplete',
)(function* (sql: SqlClient.SqlClient, snapshotId: string, ownerToken: string, spoolIdentity: string) {
  yield* validateApplyIdentity(spoolIdentity);
  yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
  const rows = yield* readSurfaceRows(sql, snapshotId);
  if (
    rows.length !== CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.length ||
    rows.some(
      (row, index) =>
        row.surface_index !== index ||
        row.surface_name !== CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES[index].name ||
        row.spool_identity !== spoolIdentity ||
        row.complete !== 1 ||
        row.applied_row_count !== row.row_count,
    )
  ) {
    return yield* CodeGraphStoreError.of('Persistent materialization spool apply is incomplete.');
  }
});

export const finalizeCodeGraphMaterializationSpoolReceipts = Effect.fn(
  'codeGraph.finalizeMaterializationSpoolReceipts',
)(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  spoolIdentity: string,
  observeTransaction?: () => Effect.Effect<void>,
) {
  yield* validateApplyIdentity(spoolIdentity);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      yield* assertCodeGraphMaterializationSpoolApplyComplete(sql, snapshotId, ownerToken, spoolIdentity);
      const expectedRows = yield* sql.unsafe<{readonly count: number | bigint}>(
        'SELECT COUNT(*) AS count FROM materialization_spool.materialization_spool_batches',
      );
      const expectedBatchCount = Number(expectedRows[0]?.count ?? -1);
      if (!Number.isSafeInteger(expectedBatchCount) || expectedBatchCount < 0) {
        return yield* CodeGraphStoreError.of('Persistent materialization spool receipt count is invalid.');
      }
      const existing = yield* sql.unsafe<{
        readonly analysis_count: number | bigint;
        readonly materialization_count: number | bigint;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM building_analysis_batches WHERE snapshot_id = ?) AS analysis_count,
           (SELECT COUNT(*) FROM building_materialization_batches WHERE snapshot_id = ?) AS materialization_count`,
        [snapshotId, snapshotId],
      );
      const analysisCount = Number(existing[0]?.analysis_count ?? -1);
      const materializationCount = Number(existing[0]?.materialization_count ?? -1);
      if (analysisCount !== 0 || materializationCount !== 0) {
        if (analysisCount !== expectedBatchCount || materializationCount !== expectedBatchCount) {
          return yield* CodeGraphStoreError.of('Persistent materialization spool receipts are incomplete.');
        }
        const mismatches = yield* sql.unsafe<{readonly count: number | bigint}>(
          `SELECT COUNT(*) AS count
           FROM materialization_spool.materialization_spool_batches AS spool
           LEFT JOIN building_materialization_batches AS materialization
             ON materialization.snapshot_id = ? AND materialization.batch_index = spool.batch_index
           LEFT JOIN building_analysis_batches AS analysis
             ON analysis.snapshot_id = ? AND analysis.batch_index = spool.batch_index
           WHERE materialization.batch_fingerprint IS NOT spool.batch_id
              OR materialization.symbol_count IS NOT spool.symbol_count
              OR materialization.edge_count IS NOT spool.edge_count
              OR materialization.term_count IS NOT spool.term_count
              OR materialization.lookup_count IS NOT spool.lookup_count
              OR materialization.reference_count IS NOT spool.reference_count
              OR materialization.candidate_count IS NOT spool.candidate_count
              OR materialization.reexport_count IS NOT spool.reexport_count
              OR analysis.batch_fingerprint IS NOT spool.batch_id
              OR analysis.symbol_count IS NOT spool.symbol_count
              OR analysis.edge_count IS NOT spool.edge_count`,
          [snapshotId, snapshotId],
        );
        if (Number(mismatches[0]?.count ?? -1) !== 0) {
          return yield* CodeGraphStoreError.of('Persistent materialization spool receipts changed.');
        }
        const lexical = yield* sql.unsafe<{
          readonly completed_batch_count: number | bigint;
          readonly posting_count: number | bigint;
          readonly symbol_count: number | bigint;
          readonly term_count: number | bigint;
        }>(
          `SELECT completed_batch_count, posting_count, symbol_count, term_count
           FROM building_lexical_counters WHERE snapshot_id = ? LIMIT 1`,
          [snapshotId],
        );
        const expectedLexical = yield* sql.unsafe<{
          readonly posting_count: number | bigint;
          readonly symbol_count: number | bigint;
          readonly term_count: number | bigint;
        }>(`SELECT
          (SELECT COUNT(*) FROM materialization_spool.materialization_ordered_symbol_terms) AS posting_count,
          (SELECT COUNT(*) FROM materialization_spool.materialization_ordered_symbols) AS symbol_count,
          (SELECT COUNT(*) FROM materialization_spool.materialization_ordered_terms) AS term_count`);
        if (
          Number(lexical[0]?.completed_batch_count ?? -1) !== expectedBatchCount ||
          Number(lexical[0]?.posting_count ?? -1) !== Number(expectedLexical[0]?.posting_count ?? -2) ||
          Number(lexical[0]?.symbol_count ?? -1) !== Number(expectedLexical[0]?.symbol_count ?? -2) ||
          Number(lexical[0]?.term_count ?? -1) !== Number(expectedLexical[0]?.term_count ?? -2)
        ) {
          return yield* CodeGraphStoreError.of('Persistent materialization spool lexical receipt changed.');
        }
        yield* assertPersistentMaterializationComplete(sql, snapshotId, ownerToken);
        return 'resumed' as const;
      }

      yield* sql.unsafe(
        `INSERT INTO snapshot_analysis_symbol_counts (snapshot_id, language, kind, count)
         SELECT ?, language, kind, COUNT(*)
         FROM symbols WHERE snapshot_id = ?
         GROUP BY language, kind`,
        [snapshotId, snapshotId],
      );
      yield* sql.unsafe(
        `INSERT INTO snapshot_analysis_edge_histogram (
           snapshot_id, provenance, relation, confidence, endpoint_state, count
         )
         SELECT ?, provenance, relation, confidence, endpoint_state, COUNT(*)
         FROM (
           SELECT provenance, relation, confidence,
             CASE WHEN source_id IS NULL OR target_id IS NULL THEN 1 WHEN source_id = target_id THEN 2 ELSE 0 END
               AS endpoint_state
           FROM edges WHERE snapshot_id = ?
           UNION ALL
           SELECT provenance, relation, confidence, 1 AS endpoint_state
           FROM building_references WHERE snapshot_id = ?
         ) AS staged_edges
         GROUP BY provenance, relation, confidence, endpoint_state`,
        [snapshotId, snapshotId, snapshotId],
      );
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql.unsafe(
        `INSERT INTO building_analysis_batches (
           snapshot_id, batch_index, batch_fingerprint, symbol_count, edge_count, completed_at
         )
         SELECT ?, batch_index, batch_id, symbol_count, edge_count, ?
         FROM materialization_spool.materialization_spool_batches
         ORDER BY batch_index`,
        [snapshotId, completedAt],
      );
      yield* sql.unsafe(
        `UPDATE building_lexical_counters
         SET completed_batch_count = ?,
             posting_count = (
               SELECT COUNT(*) FROM materialization_spool.materialization_ordered_symbol_terms
             ),
             symbol_count = (
               SELECT COUNT(*) FROM materialization_spool.materialization_ordered_symbols
             ),
             term_count = (
               SELECT COUNT(*) FROM materialization_spool.materialization_ordered_terms
             )
         WHERE snapshot_id = ?`,
        [expectedBatchCount, snapshotId],
      );
      const lexicalUpdates = yield* sql.unsafe<{readonly count: number | bigint}>('SELECT changes() AS count');
      if (Number(lexicalUpdates[0]?.count ?? 0) !== 1) {
        return yield* CodeGraphStoreError.of('Persistent materialization spool lexical receipt is missing.');
      }
      yield* sql.unsafe(
        `INSERT INTO building_materialization_batches (
           snapshot_id, batch_index, batch_fingerprint, symbol_count, edge_count, term_count,
           lookup_count, reference_count, candidate_count, reexport_count, completed_at
         )
         SELECT ?, batch_index, batch_id, symbol_count, edge_count, term_count,
           lookup_count, reference_count, candidate_count, reexport_count, ?
         FROM materialization_spool.materialization_spool_batches
         ORDER BY batch_index`,
        [snapshotId, completedAt],
      );
      const receiptChanges = yield* sql.unsafe<{readonly count: number | bigint}>('SELECT changes() AS count');
      if (Number(receiptChanges[0]?.count ?? -1) !== expectedBatchCount) {
        return yield* CodeGraphStoreError.of('Persistent materialization spool receipts lost rows.');
      }
      yield* assertPersistentMaterializationComplete(sql, snapshotId, ownerToken);
      yield* observeTransaction?.() ?? Effect.void;
      return 'finalized' as const;
    }),
  );
});

function readSurfaceRows(sql: SqlClient.SqlClient, snapshotId: string) {
  return sql.unsafe<MaterializationSpoolSurfaceRow>(
    `SELECT surface_index, spool_identity, surface_name, row_count,
       next_page_index, applied_row_count, complete
     FROM building_materialization_spool_surfaces
     WHERE snapshot_id = ?
     ORDER BY surface_index`,
    [snapshotId],
  );
}

function validateApplyIdentity(spoolIdentity: string): Effect.Effect<void, CodeGraphStoreFailure> {
  return /^[0-9a-f]{64}$/u.test(spoolIdentity)
    ? Effect.void
    : Effect.fail(CodeGraphStoreError.of('Persistent materialization spool identity is invalid.'));
}

function validateSurfacePlan(
  surfaces: readonly CodeGraphMaterializationSpoolSurfacePlan[],
): Effect.Effect<void, CodeGraphStoreFailure> {
  return surfaces.length !== CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.length ||
    surfaces.some(
      (surface, index) =>
        surface.name !== CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES[index].name ||
        !Number.isSafeInteger(surface.rowCount) ||
        surface.rowCount < 0,
    )
    ? Effect.fail(CodeGraphStoreError.of('Persistent materialization spool surface plan is invalid.'))
    : Effect.void;
}

function surfaceRowsMatch(
  rows: readonly MaterializationSpoolSurfaceRow[],
  spoolIdentity: string,
  surfaces: readonly CodeGraphMaterializationSpoolSurfacePlan[],
): boolean {
  return (
    rows.length === surfaces.length &&
    rows.every(
      (row, index) =>
        row.surface_index === index &&
        row.spool_identity === spoolIdentity &&
        row.surface_name === surfaces[index].name &&
        row.row_count === surfaces[index].rowCount &&
        Number.isSafeInteger(row.next_page_index) &&
        row.next_page_index >= 0 &&
        Number.isSafeInteger(row.applied_row_count) &&
        row.applied_row_count >= 0 &&
        row.applied_row_count <= row.row_count &&
        (row.complete === 0 || (row.complete === 1 && row.applied_row_count === row.row_count)),
    )
  );
}
