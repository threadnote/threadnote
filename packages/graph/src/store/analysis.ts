import {Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {compareCodeUnits} from '../ordering.js';
import {
  type CodeGraphAnalysisEdgeAggregate,
  type CodeGraphAnalysisEdgeAggregatePage,
  type CodeGraphAnalysisSummary,
  type CodeGraphAnalysisSymbolAggregate,
  type CodeGraphAnalysisSymbolAggregatePage,
  type CodeGraphSymbolCursor,
} from './models.js';
import {configureConnection} from './session.js';
import {type CodeGraphEdge, type CodeGraphProvenance} from '../types.js';
import {effectiveSnapshotParameters, effectiveSymbolsCte, selectBaseSnapshotId} from './query/core.js';
import {type SymbolRow} from './internal_models.js';
import {boundedAggregatePageLimit, boundedPageLimit} from './utilities.js';
import {symbolFromRow} from './rows.js';
import {type CodeGraphSqlQueryStatement} from './visualization_sql.js';

const selectSymbolPage = Effect.fn('codeGraph.selectSymbolPage')(function* (
  snapshotId: string,
  cursor: CodeGraphSymbolCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = cursor
    ? yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE (path, qualified_name, id) > (?, ?, ?)
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [
          ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
          cursor.path,
          cursor.qualifiedName,
          cursor.id,
          boundedPageLimit(limit),
        ],
      )
    : yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), boundedPageLimit(limit)],
      );
  return rows.map(symbolFromRow);
});

interface AnalysisSymbolAggregateRow {
  readonly count: number;
  readonly kind: string;
  readonly language: string;
  readonly last_id: string;
}

interface PersistedAnalysisSymbolRow {
  readonly count: number;
  readonly kind: string;
  readonly language: string;
}

interface PersistedAnalysisEdgeRow {
  readonly confidence_high: number;
  readonly confidence_invalid: number;
  readonly confidence_low: number;
  readonly confidence_medium: number;
  readonly confidence_total: number;
  readonly count: number;
  readonly lowest_confidence: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly review_finding_count: number;
  readonly self_loop_count: number;
  readonly unresolved_endpoint_count: number;
}

const selectAnalysisSummary = Effect.fn('codeGraph.selectAnalysisSummary')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const tables = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'snapshot_analysis_summary_receipts'
  `;
  if (Number(tables[0]?.count ?? 0) !== 1) return Option.none<CodeGraphAnalysisSummary>();
  const receipts = yield* sql<{
    readonly digest: string;
    readonly edge_count: number;
    readonly expected_edge_count: number;
    readonly expected_symbol_count: number;
    readonly symbol_count: number;
    readonly version: number;
  }>`
    SELECT receipt.digest, receipt.edge_count, receipt.symbol_count, receipt.version,
      snapshot.edge_count AS expected_edge_count, snapshot.symbol_count AS expected_symbol_count
    FROM snapshot_analysis_summary_receipts AS receipt
    JOIN snapshots AS snapshot ON snapshot.id = receipt.snapshot_id
    WHERE receipt.snapshot_id = ${snapshotId} AND snapshot.state = 'ready'
    LIMIT 1
  `;
  const receipt = receipts[0];
  if (!receipt || Number(receipt.version) !== 1) return Option.none<CodeGraphAnalysisSummary>();
  const [symbolRows, edgeRows] = yield* Effect.all(
    [
      sql<PersistedAnalysisSymbolRow>`
        SELECT language, kind, count
        FROM snapshot_analysis_symbol_counts
        WHERE snapshot_id = ${snapshotId}
        ORDER BY language, kind
      `,
      sql<PersistedAnalysisEdgeRow>`
        SELECT provenance, relation, count, confidence_invalid, confidence_total,
          lowest_confidence, confidence_high, confidence_medium, confidence_low,
          unresolved_endpoint_count, self_loop_count, review_finding_count
        FROM snapshot_analysis_edge_counts
        WHERE snapshot_id = ${snapshotId}
        ORDER BY provenance, relation
      `,
    ],
    {concurrency: 1},
  );
  const symbols = symbolRows.map(analysisSymbolAggregateFromRow);
  const edges = edgeRows.map(analysisEdgeAggregateFromRow);
  const symbolCount = symbols.reduce((total, row) => total + row.count, 0);
  const edgeCount = edges.reduce((total, row) => total + row.count, 0);
  const summary = {
    digest: receipt.digest,
    edgeCount,
    edges,
    symbolCount,
    symbols,
    version: 1,
  } satisfies CodeGraphAnalysisSummary;
  if (
    symbolCount !== Number(receipt.symbol_count) ||
    edgeCount !== Number(receipt.edge_count) ||
    symbolCount !== Number(receipt.expected_symbol_count) ||
    edgeCount !== Number(receipt.expected_edge_count) ||
    codeGraphAnalysisSummaryDigest(symbols, edges) !== receipt.digest
  ) {
    return Option.none<CodeGraphAnalysisSummary>();
  }
  return Option.some(summary);
});

function analysisSymbolAggregateFromRow(row: PersistedAnalysisSymbolRow): CodeGraphAnalysisSymbolAggregate {
  return {count: Number(row.count), kind: row.kind, language: row.language};
}

function analysisEdgeAggregateFromRow(row: PersistedAnalysisEdgeRow): CodeGraphAnalysisEdgeAggregate {
  return {
    confidenceHigh: Number(row.confidence_high),
    confidenceInvalid: Number(row.confidence_invalid),
    confidenceLow: Number(row.confidence_low),
    confidenceMedium: Number(row.confidence_medium),
    confidenceTotal: Number(row.confidence_total),
    count: Number(row.count),
    lowestConfidence: Number(row.lowest_confidence),
    provenance: row.provenance,
    relation: row.relation,
    reviewFindingCount: Number(row.review_finding_count),
    selfLoopCount: Number(row.self_loop_count),
    unresolvedEndpointCount: Number(row.unresolved_endpoint_count),
  };
}

export function codeGraphAnalysisSummaryDigest(
  symbols: readonly CodeGraphAnalysisSymbolAggregate[],
  edges: readonly CodeGraphAnalysisEdgeAggregate[],
): string {
  return sha256HexSync(
    JSON.stringify({
      edges: [...edges].sort(
        (left, right) =>
          compareCodeUnits(left.provenance, right.provenance) || compareCodeUnits(left.relation, right.relation),
      ),
      symbols: [...symbols].sort(
        (left, right) => compareCodeUnits(left.language, right.language) || compareCodeUnits(left.kind, right.kind),
      ),
      version: 1,
    }),
  );
}

const selectAnalysisSymbolAggregatePage = Effect.fn('codeGraph.selectAnalysisSymbolAggregatePage')(function* (
  snapshotId: string,
  cursorId: string | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const statement = codeGraphAnalysisSymbolAggregatePageStatement(snapshotId, baseSnapshotId, cursorId, limit);
  const rows = yield* sql.unsafe<AnalysisSymbolAggregateRow>(statement.text, statement.parameters);
  const counts = rows.map(row => ({
    count: Number(row.count),
    kind: row.kind,
    language: row.language,
  }));
  const rowCount = counts.reduce((total, row) => total + row.count, 0);
  const lastId = rows.reduce<string | undefined>(
    (current, row) => (current === undefined || compareCodeUnits(current, row.last_id) < 0 ? row.last_id : current),
    undefined,
  );
  return {
    counts,
    ...(lastId === undefined ? {} : {lastId}),
    rows: rowCount,
  } satisfies CodeGraphAnalysisSymbolAggregatePage;
});

/**
 * Build one ID-keyset aggregate page. Overlay cursor predicates live inside
 * both current/base branches so every page performs two primary-key seeks
 * instead of rematerializing the whole effective snapshot.
 */
export function codeGraphAnalysisSymbolAggregatePageStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  cursorId: string | undefined,
  limit: number,
): CodeGraphSqlQueryStatement {
  const cursor = cursorId ?? '';
  const page =
    baseSnapshotId === undefined
      ? `SELECT id, language, kind
         FROM symbols
         WHERE snapshot_id = ? AND id > ?
         ORDER BY id
         LIMIT ?`
      : `SELECT id, language, kind
         FROM (
           SELECT current_symbols.id, current_symbols.language, current_symbols.kind
           FROM symbols AS current_symbols
           WHERE current_symbols.snapshot_id = ? AND current_symbols.id > ?
           UNION ALL
           SELECT base_symbols.id, base_symbols.language, base_symbols.kind
           FROM symbols AS base_symbols
           WHERE base_symbols.snapshot_id = ? AND base_symbols.id > ?
             AND NOT EXISTS (
               SELECT 1 FROM symbols AS overrides
               WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM snapshot_symbol_deletions AS deletions
               WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
             )
         )
         ORDER BY id
         LIMIT ?`;
  return {
    parameters:
      baseSnapshotId === undefined
        ? [snapshotId, cursor, boundedAggregatePageLimit(limit)]
        : [snapshotId, cursor, baseSnapshotId, cursor, snapshotId, snapshotId, boundedAggregatePageLimit(limit)],
    text: `WITH page AS (${page})
      SELECT language, kind, COUNT(*) AS count, MAX(id) AS last_id
      FROM page
      GROUP BY language, kind
      ORDER BY language, kind`,
  };
}

interface AnalysisEdgeAggregateRow {
  readonly confidence_high: number;
  readonly confidence_invalid: number;
  readonly confidence_low: number;
  readonly confidence_medium: number;
  readonly confidence_total: number;
  readonly count: number;
  readonly last_id: string;
  readonly lowest_confidence: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly review_finding_count: number;
  readonly self_loop_count: number;
  readonly unresolved_endpoint_count: number;
}

const ANALYSIS_EDGE_AGGREGATE_SELECT = `
  SELECT
    provenance,
    relation,
    COUNT(*) AS count,
    SUM(CASE WHEN confidence < 0 OR confidence > 1 THEN 1 ELSE 0 END) AS confidence_invalid,
    SUM(CASE WHEN confidence < 0 THEN 0 WHEN confidence > 1 THEN 1 ELSE confidence END) AS confidence_total,
    MIN(CASE WHEN confidence < 0 THEN 0 WHEN confidence > 1 THEN 1 ELSE confidence END) AS lowest_confidence,
    SUM(CASE WHEN confidence >= 0.9 THEN 1 ELSE 0 END) AS confidence_high,
    SUM(CASE WHEN confidence >= 0.6 AND confidence < 0.9 THEN 1 ELSE 0 END) AS confidence_medium,
    SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END) AS confidence_low,
    SUM(CASE WHEN source_id IS NULL OR target_id IS NULL THEN 1 ELSE 0 END) AS unresolved_endpoint_count,
    SUM(
      CASE WHEN source_id IS NOT NULL AND target_id IS NOT NULL AND source_id = target_id THEN 1 ELSE 0 END
    ) AS self_loop_count,
    SUM(
      CASE
        WHEN confidence < 0 OR confidence > 1 THEN 1
        WHEN confidence < CASE provenance
          WHEN 'declared' THEN 0.9
          WHEN 'resolved' THEN 0.9
          WHEN 'syntactic' THEN 0.7
          WHEN 'heuristic' THEN 0.45
          WHEN 'model' THEN 0.35
        END THEN 1
        ELSE 0
      END
    ) AS review_finding_count,
    MAX(id) AS last_id
  FROM page
  GROUP BY provenance, relation
  ORDER BY provenance, relation`;

const selectAnalysisEdgeAggregatePage = Effect.fn('codeGraph.selectAnalysisEdgeAggregatePage')(function* (
  snapshotId: string,
  cursorId: string | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const statement = codeGraphAnalysisEdgeAggregatePageStatement(snapshotId, baseSnapshotId, cursorId, limit);
  const rows = yield* sql.unsafe<AnalysisEdgeAggregateRow>(statement.text, statement.parameters);
  const counts = rows.map(row => ({
    confidenceHigh: Number(row.confidence_high),
    confidenceInvalid: Number(row.confidence_invalid),
    confidenceLow: Number(row.confidence_low),
    confidenceMedium: Number(row.confidence_medium),
    confidenceTotal: Number(row.confidence_total),
    count: Number(row.count),
    lowestConfidence: Number(row.lowest_confidence),
    provenance: row.provenance,
    relation: row.relation,
    reviewFindingCount: Number(row.review_finding_count),
    selfLoopCount: Number(row.self_loop_count),
    unresolvedEndpointCount: Number(row.unresolved_endpoint_count),
  }));
  const rowCount = counts.reduce((total, row) => total + row.count, 0);
  const lastId = rows.reduce<string | undefined>(
    (current, row) => (current === undefined || compareCodeUnits(current, row.last_id) < 0 ? row.last_id : current),
    undefined,
  );
  return {
    counts,
    ...(lastId === undefined ? {} : {lastId}),
    rows: rowCount,
  } satisfies CodeGraphAnalysisEdgeAggregatePage;
});

/** Edge counterpart of codeGraphAnalysisSymbolAggregatePageStatement. */
export function codeGraphAnalysisEdgeAggregatePageStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  cursorId: string | undefined,
  limit: number,
): CodeGraphSqlQueryStatement {
  const cursor = cursorId ?? '';
  const page =
    baseSnapshotId === undefined
      ? `SELECT id, provenance, relation, confidence, source_id, target_id
         FROM edges
         WHERE snapshot_id = ? AND id > ?
         ORDER BY id
         LIMIT ?`
      : `SELECT id, provenance, relation, confidence, source_id, target_id
         FROM (
           SELECT current_edges.id, current_edges.provenance, current_edges.relation,
             current_edges.confidence, current_edges.source_id, current_edges.target_id
           FROM edges AS current_edges
           WHERE current_edges.snapshot_id = ? AND current_edges.id > ?
           UNION ALL
           SELECT base_edges.id, base_edges.provenance, base_edges.relation,
             base_edges.confidence, base_edges.source_id, base_edges.target_id
           FROM edges AS base_edges
           WHERE base_edges.snapshot_id = ? AND base_edges.id > ?
             AND NOT EXISTS (
               SELECT 1 FROM edges AS overrides
               WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM snapshot_edge_deletions AS deletions
               WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
             )
         )
         ORDER BY id
         LIMIT ?`;
  return {
    parameters:
      baseSnapshotId === undefined
        ? [snapshotId, cursor, boundedAggregatePageLimit(limit)]
        : [snapshotId, cursor, baseSnapshotId, cursor, snapshotId, snapshotId, boundedAggregatePageLimit(limit)],
    text: `WITH page AS (${page}) ${ANALYSIS_EDGE_AGGREGATE_SELECT}`,
  };
}

const EMBEDDING_SYMBOL_KINDS = [
  'class',
  'document',
  'function',
  'heading',
  'interface',
  'method',
  'module',
  'package',
  'type',
] as const;

const selectEmbeddingSymbolCount = Effect.fn('codeGraph.selectEmbeddingSymbolCount')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = yield* sql.unsafe<{readonly count: number}>(
    `${effectiveSymbolsCte()}
     SELECT COUNT(*) AS count
     FROM effective_symbols
     WHERE exported = 1 OR kind IN (${EMBEDDING_SYMBOL_KINDS.map(() => '?').join(', ')})`,
    [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...EMBEDDING_SYMBOL_KINDS],
  );
  return Number(rows[0]?.count ?? 0);
});

const selectEmbeddingSymbolPage = Effect.fn('codeGraph.selectEmbeddingSymbolPage')(function* (
  snapshotId: string,
  cursor: CodeGraphSymbolCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const eligibility = `exported = 1 OR kind IN (${EMBEDDING_SYMBOL_KINDS.map(() => '?').join(', ')})`;
  const parameters = [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...EMBEDDING_SYMBOL_KINDS];
  const rows = cursor
    ? yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE (${eligibility})
           AND (path, qualified_name, id) > (?, ?, ?)
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...parameters, cursor.path, cursor.qualifiedName, cursor.id, boundedPageLimit(limit)],
      )
    : yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE ${eligibility}
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...parameters, boundedPageLimit(limit)],
      );
  return rows.map(symbolFromRow);
});

export {
  PersistedAnalysisSymbolRow,
  PersistedAnalysisEdgeRow,
  analysisSymbolAggregateFromRow,
  analysisEdgeAggregateFromRow,
  EMBEDDING_SYMBOL_KINDS,
  AnalysisSymbolAggregateRow,
  selectAnalysisSummary,
  AnalysisEdgeAggregateRow,
  ANALYSIS_EDGE_AGGREGATE_SELECT,
  selectSymbolPage,
  selectAnalysisSymbolAggregatePage,
  selectAnalysisEdgeAggregatePage,
  selectEmbeddingSymbolCount,
  selectEmbeddingSymbolPage,
};
