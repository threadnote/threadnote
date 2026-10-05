import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {compareCodeUnits} from '../ordering.js';
import {configureConnection} from './session.js';
import {type CodeGraphEdge, type CodeGraphProvenance, type CodeGraphQueryNode} from '../types.js';
import {codeGraphAdjacencyQueryStatement, selectBaseSnapshotId} from './query/core.js';
import {chunk} from './utilities.js';
import {type EdgeRow, type SymbolRow} from './internal_models.js';
import {edgeFromRow, symbolFromRow} from './rows.js';
import {representativeEdgeRows} from './queries.js';

/** @internal Indexed cursor-page statement retained for query-plan and high-cardinality regressions. */

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

/**
 * Build one ID-keyset aggregate page. Overlay cursor predicates live inside
 * both current/base branches so every page performs two primary-key seeks
 * instead of rematerializing the whole effective snapshot.
 */

/** Edge counterpart of codeGraphAnalysisSymbolAggregatePageStatement. */

/**
 * Build exact-match candidates with the equality predicate inside every
 * current/base branch. Keeping the predicate outside effectiveSymbolsCte()
 * makes SQLite scan every symbol in a large snapshot before applying LIMIT.
 */

/** Build lexical candidates across independently versioned current/base snapshots. */

/**
 * Product names such as MCP tool identifiers appear verbatim in test fixtures
 * and agent-instruction documents as well as in the code that implements them.
 * Those copies match a bare symbol query just as strongly, so they are demoted
 * unless the query itself asks for a test or a document.
 */

const selectSymbolsByPaths = Effect.fn('codeGraph.selectSymbolsByPaths')(function* (
  snapshotId: string,
  paths: readonly string[],
  limitPerPath: number,
) {
  if (paths.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const normalizedPaths = [...new Set(paths)];
  const grouped = new Map<string, CodeGraphQueryNode[]>();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limitPerPath)));
  for (const pathBatch of chunk(normalizedPaths, 300)) {
    const placeholders = pathBatch.map(() => '?').join(', ');
    const rows = yield* sql.unsafe<SymbolRow & {readonly path_rank: number}>(
      `WITH effective_path_symbols AS (
         SELECT current_symbols.*
         FROM symbols AS current_symbols INDEXED BY symbols_path
         WHERE current_symbols.snapshot_id = ?
           AND current_symbols.path IN (${placeholders})
         UNION ALL
         SELECT base_symbols.*
         FROM symbols AS base_symbols INDEXED BY symbols_path
         WHERE base_symbols.snapshot_id = ?
           AND base_symbols.path IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM symbols AS overrides
             WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM snapshot_symbol_deletions AS deletions
             WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
           )
       ),
       ranked_symbols AS (
         SELECT effective_path_symbols.*,
           ROW_NUMBER() OVER (
             PARTITION BY path
             ORDER BY exported DESC, qualified_name, id
           ) AS path_rank
         FROM effective_path_symbols
       )
       SELECT * FROM ranked_symbols
       WHERE path_rank <= ?
       ORDER BY path, path_rank`,
      [snapshotId, ...pathBatch, baseSnapshotId ?? '', ...pathBatch, snapshotId, snapshotId, safeLimit],
    );
    for (const row of rows) {
      const values = grouped.get(row.path) ?? [];
      values.push({...symbolFromRow(row), score: 1});
      grouped.set(row.path, values);
    }
  }
  return paths.map(sourcePath => grouped.get(sourcePath) ?? []);
});

const selectSymbolsByPathAndName = Effect.fn('codeGraph.selectSymbolsByPathAndName')(function* (
  snapshotId: string,
  sourcePath: string,
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = yield* sql.unsafe<SymbolRow>(
    `WITH matching_symbols AS (
       SELECT current_symbols.*
       FROM symbols AS current_symbols INDEXED BY symbols_path_nocase
       WHERE current_symbols.snapshot_id = ?
         AND current_symbols.path = ? COLLATE NOCASE
         AND (current_symbols.name = ? COLLATE NOCASE OR current_symbols.qualified_name = ? COLLATE NOCASE)
       UNION ALL
       SELECT base_symbols.*
       FROM symbols AS base_symbols INDEXED BY symbols_path_nocase
       WHERE base_symbols.snapshot_id = ?
         AND base_symbols.path = ? COLLATE NOCASE
         AND (base_symbols.name = ? COLLATE NOCASE OR base_symbols.qualified_name = ? COLLATE NOCASE)
         AND NOT EXISTS (
           SELECT 1 FROM symbols AS overrides
           WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_symbol_deletions AS deletions
           WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
         )
     )
     SELECT * FROM matching_symbols
     ORDER BY exported DESC, qualified_name, id
     LIMIT 20`,
    [snapshotId, sourcePath, name, name, baseSnapshotId ?? '', sourcePath, name, name, snapshotId, snapshotId],
  );
  return rows.map(row => ({...symbolFromRow(row), score: 1}));
});

/** Build bounded adjacency SQL whose branches seek the directional indexes. */

const selectRepresentativeEdgesForNodes = Effect.fn('codeGraph.selectRepresentativeEdgesForNodes')(function* (
  snapshotId: string,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  const ids = [...new Set(nodeIds)].slice(0, 500).sort(compareCodeUnits);
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  if (ids.length === 0 || allowedProvenances.length === 0) return {edges: [], truncated: false};
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const perNodeLimit = Math.max(2, Math.min(16, Math.ceil(safeLimit / ids.length) * 2));
  const pages: Array<{readonly nodeId: string; readonly rows: readonly EdgeRow[]}> = [];
  let truncated = false;
  for (const nodeId of ids) {
    const statement = codeGraphAdjacencyQueryStatement(
      snapshotId,
      baseSnapshotId,
      [nodeId],
      direction,
      perNodeLimit + 1,
      allowedProvenances,
    );
    const rows = yield* sql.unsafe<EdgeRow>(statement.text, statement.parameters);
    if (rows.length > perNodeLimit) truncated = true;
    pages.push({nodeId, rows: rows.slice(0, perNodeLimit)});
  }
  const selected = representativeEdgeRows(pages, safeLimit);
  const uniqueCandidates = new Set(pages.flatMap(page => page.rows.map(row => row.id))).size;
  if (uniqueCandidates > selected.length) truncated = true;
  return {edges: selected.map(edgeFromRow), truncated};
});

const selectRelationshipSummaryForNode = Effect.fn('codeGraph.selectRelationshipSummaryForNode')(function* (
  snapshotId: string,
  nodeId: string,
  allowedProvenances: readonly CodeGraphProvenance[],
  limit = 2_000,
) {
  if (allowedProvenances.length === 0) {
    return {incoming: 0, outgoing: 0, provenances: [], relations: [], sampledEdges: 0, truncated: false};
  }
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  const statement = codeGraphAdjacencyQueryStatement(
    snapshotId,
    baseSnapshotId,
    [nodeId],
    'both',
    safeLimit + 1,
    allowedProvenances,
  );
  const page = yield* sql.unsafe<EdgeRow>(statement.text, statement.parameters);
  const rows = page.slice(0, safeLimit);
  const relationCounts = new Map<CodeGraphEdge['relation'], {count: number; incoming: number; outgoing: number}>();
  const provenanceCounts = new Map<CodeGraphProvenance, number>();
  let incoming = 0;
  let outgoing = 0;
  for (const row of rows) {
    const rowIncoming = row.target_id === nodeId ? 1 : 0;
    const rowOutgoing = row.source_id === nodeId ? 1 : 0;
    const relation = relationCounts.get(row.relation) ?? {count: 0, incoming: 0, outgoing: 0};
    relation.count += 1;
    relation.incoming += rowIncoming;
    relation.outgoing += rowOutgoing;
    relationCounts.set(row.relation, relation);
    provenanceCounts.set(row.provenance, (provenanceCounts.get(row.provenance) ?? 0) + 1);
    incoming += rowIncoming;
    outgoing += rowOutgoing;
  }
  return {
    incoming,
    outgoing,
    provenances: [...provenanceCounts]
      .map(([provenance, count]) => ({count, provenance}))
      .sort((left, right) => right.count - left.count || compareCodeUnits(left.provenance, right.provenance)),
    relations: [...relationCounts]
      .map(([relation, counts]) => ({...counts, relation}))
      .sort((left, right) => right.count - left.count || compareCodeUnits(left.relation, right.relation)),
    sampledEdges: rows.length,
    truncated: page.length > safeLimit,
  };
});

export {
  selectSymbolsByPaths,
  selectSymbolsByPathAndName,
  selectRepresentativeEdgesForNodes,
  selectRelationshipSummaryForNode,
};
