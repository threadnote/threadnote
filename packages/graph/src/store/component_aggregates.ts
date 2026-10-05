import {DateTime, Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphVisualizationScopeEdge} from './models.js';
import {configureConnection, tableExists} from './session.js';
import {
  effectiveEdgesCte,
  effectiveSnapshotParameters,
  effectiveSymbolsCte,
  selectBaseSnapshotId,
} from './query/core.js';
import {type CodeGraphEdge, type CodeGraphProvenance, CodeGraphStoreError} from '../types.js';

const COMPONENT_EDGE_AGGREGATE_VERSION = 1;
const COMPONENT_SCOPE_TEMP_TABLE = 'threadnote_component_scopes';

interface PersistedComponentEdgeAggregateRow {
  readonly confidence: number;
  readonly count: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly source_component_id: string;
  readonly target_component_id: string;
}

/**
 * Materializes the exact effective graph once after structural readiness. The
 * workspace catalog and source relationships remain separate tables so a
 * declared build edge can never masquerade as a resolved source reference.
 */
const materializeSnapshotComponentEdgeAggregates = Effect.fn('codeGraph.materializeSnapshotComponentEdgeAggregates')(
  function* (sql: SqlClient.SqlClient, snapshotId: string) {
    const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
    const hasWorkspaceCatalog =
      Number(
        (yield* sql<{readonly count: number}>`
        SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ${snapshotId}
      `)[0]?.count ?? 0,
      ) > 0;
    yield* sql`DELETE FROM snapshot_component_edge_aggregate_receipts WHERE snapshot_id = ${snapshotId}`;
    yield* sql`DELETE FROM snapshot_component_edge_aggregates WHERE snapshot_id = ${snapshotId}`;
    yield* sql.unsafe(`DROP TABLE IF EXISTS temp.${COMPONENT_SCOPE_TEMP_TABLE}`);
    yield* sql.unsafe(
      `CREATE TEMP TABLE ${COMPONENT_SCOPE_TEMP_TABLE} (
         id TEXT PRIMARY KEY NOT NULL,
         scope_id TEXT
       ) WITHOUT ROWID`,
    );
    const scopeStatement = componentScopeMaterializationStatement(snapshotId, baseSnapshotId, hasWorkspaceCatalog);
    yield* sql.unsafe(scopeStatement.text, [...scopeStatement.parameters]);
    const edgeStatement = componentEdgeAggregateMaterializationStatement(snapshotId, baseSnapshotId);
    yield* sql.unsafe(edgeStatement.text, [...edgeStatement.parameters]);
    const rows = yield* selectComponentEdgeAggregateRows(sql, snapshotId);
    const edges = rows.map(componentEdgeFromRow);
    const edgeCount = edges.reduce((total, edge) => total + edge.count, 0);
    if (!Number.isSafeInteger(edgeCount) || edgeCount < 0) {
      return yield* CodeGraphStoreError.of('Component edge aggregation returned an invalid edge count.');
    }
    yield* sql`
    INSERT INTO snapshot_component_edge_aggregate_receipts (
      snapshot_id, version, row_count, edge_count, digest, created_at
    ) VALUES (
      ${snapshotId}, ${COMPONENT_EDGE_AGGREGATE_VERSION}, ${edges.length}, ${edgeCount},
      ${componentEdgeAggregateDigest(edges)}, ${DateTime.formatIso(yield* DateTime.now)}
    )
  `;
    yield* sql.unsafe(`DROP TABLE temp.${COMPONENT_SCOPE_TEMP_TABLE}`);
    return true;
  },
);

function componentScopeMaterializationStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  hasWorkspaceCatalog: boolean,
) {
  return {
    parameters: effectiveSnapshotParameters(snapshotId, baseSnapshotId),
    text: `${effectiveSymbolsCte()}
      INSERT INTO ${COMPONENT_SCOPE_TEMP_TABLE} (id, scope_id)
      SELECT id, ${scopeExpression(hasWorkspaceCatalog)} FROM effective_symbols`,
  };
}

function componentEdgeAggregateMaterializationStatement(snapshotId: string, baseSnapshotId: string | undefined) {
  return {
    parameters: [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), snapshotId],
    text: `${effectiveEdgesCte()}
      INSERT INTO snapshot_component_edge_aggregates (
        snapshot_id, source_component_id, target_component_id, provenance, relation, count, confidence
      )
      SELECT ?, source.scope_id, target.scope_id, edge.provenance, edge.relation,
        COUNT(*), MAX(edge.confidence)
      FROM effective_edges AS edge
      CROSS JOIN ${COMPONENT_SCOPE_TEMP_TABLE} AS source ON source.id = edge.source_id
      CROSS JOIN ${COMPONENT_SCOPE_TEMP_TABLE} AS target ON target.id = edge.target_id
      WHERE source.scope_id IS NOT NULL AND target.scope_id IS NOT NULL
        AND source.scope_id <> target.scope_id
      GROUP BY source.scope_id, target.scope_id, edge.provenance, edge.relation`,
  };
}

const selectPersistedSnapshotComponentEdges = Effect.fn('codeGraph.selectPersistedSnapshotComponentEdges')(function* (
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (
    !(yield* tableExists(sql, 'snapshot_component_edge_aggregates')) ||
    !(yield* tableExists(sql, 'snapshot_component_edge_aggregate_receipts'))
  ) {
    return Option.none<readonly CodeGraphVisualizationScopeEdge[]>();
  }
  const receipts = yield* sql<{
    readonly digest: string;
    readonly edge_count: number;
    readonly row_count: number;
    readonly version: number;
  }>`
      SELECT receipt.version, receipt.row_count, receipt.edge_count, receipt.digest
      FROM snapshot_component_edge_aggregate_receipts AS receipt
      JOIN snapshots AS snapshot ON snapshot.id = receipt.snapshot_id
      WHERE receipt.snapshot_id = ${snapshotId} AND snapshot.state = 'ready'
      LIMIT 1
    `;
  const receipt = receipts[0];
  if (!receipt || Number(receipt.version) !== COMPONENT_EDGE_AGGREGATE_VERSION) {
    return Option.none<readonly CodeGraphVisualizationScopeEdge[]>();
  }
  const rows = yield* selectComponentEdgeAggregateRows(sql, snapshotId);
  const edges = rows.flatMap(row => {
    const edge = componentEdgeFromRow(row);
    return Number.isSafeInteger(edge.count) && edge.count > 0 && Number.isFinite(edge.confidence) ? [edge] : [];
  });
  const edgeCount = edges.reduce((total, edge) => total + edge.count, 0);
  if (
    edges.length !== rows.length ||
    edges.length !== Number(receipt.row_count) ||
    edgeCount !== Number(receipt.edge_count) ||
    componentEdgeAggregateDigest(edges) !== receipt.digest
  ) {
    return Option.none<readonly CodeGraphVisualizationScopeEdge[]>();
  }
  return Option.some(edges);
});

function selectComponentEdgeAggregateRows(sql: SqlClient.SqlClient, snapshotId: string) {
  return sql<PersistedComponentEdgeAggregateRow>`
    SELECT source_component_id, target_component_id, provenance, relation, count, confidence
    FROM snapshot_component_edge_aggregates
    WHERE snapshot_id = ${snapshotId}
    ORDER BY source_component_id, target_component_id, provenance, relation
  `;
}

function componentEdgeFromRow(row: PersistedComponentEdgeAggregateRow): CodeGraphVisualizationScopeEdge {
  return {
    confidence: Number(row.confidence),
    count: Number(row.count),
    provenance: row.provenance,
    relation: row.relation,
    sourceId: row.source_component_id,
    targetId: row.target_component_id,
    type: 'source-relationship',
  };
}

function componentEdgeAggregateDigest(edges: readonly CodeGraphVisualizationScopeEdge[]): string {
  return sha256HexSync(
    JSON.stringify(
      edges.map(edge => [edge.sourceId, edge.targetId, edge.provenance, edge.relation, edge.count, edge.confidence]),
    ),
  );
}

function scopeExpression(hasWorkspaceCatalog: boolean): string {
  const fallback =
    "CASE WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package:' || package_name " +
    "WHEN instr(path, '/') > 0 THEN 'path:' || substr(path, 1, instr(path, '/') - 1) ELSE 'path:(root)' END";
  return hasWorkspaceCatalog
    ? 'CASE WHEN resolution_scope_id IS NOT NULL THEN resolution_scope_id ' +
        "WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'facet:unscoped-documentation' " +
        "WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package:' || package_name " +
        "WHEN instr(path, '/') > 0 THEN 'path:' || substr(path, 1, instr(path, '/') - 1) ELSE 'path:(root)' END"
    : fallback;
}

export {
  COMPONENT_SCOPE_TEMP_TABLE,
  componentEdgeAggregateMaterializationStatement,
  materializeSnapshotComponentEdgeAggregates,
  selectPersistedSnapshotComponentEdges,
};
