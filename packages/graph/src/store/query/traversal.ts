import {type CodeGraphProvenance} from '../../types.js';
import {type CodeGraphSqlQueryStatement} from '../visualization_sql.js';
import {edgePriorityOrder, effectiveAdjacentEdgesCte} from './core.js';

export function codeGraphTraversalQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
): CodeGraphSqlQueryStatement {
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  const adjacent = effectiveAdjacentEdgesCte(
    snapshotId,
    baseSnapshotId,
    nodeIds,
    direction,
    allowedProvenances,
    safeLimit,
    'traversal',
  );
  return {
    parameters: [...adjacent.parameters, safeLimit],
    text: `${adjacent.text}
      SELECT id, source_id, target_id, relation, provenance, confidence FROM adjacent_edges
      ORDER BY ${edgePriorityOrder('adjacent_edges')}
      LIMIT ?`,
  };
}

export const CODE_GRAPH_EDGE_HYDRATION_BATCH_SIZE = 400;

export function codeGraphEdgesByIdsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  edgeIds: readonly string[],
): CodeGraphSqlQueryStatement {
  const ids = [...new Set(edgeIds)].slice(0, CODE_GRAPH_EDGE_HYDRATION_BATCH_SIZE);
  const placeholders = ids.map(() => '?').join(', ');
  return {
    parameters: [snapshotId, ...ids, baseSnapshotId ?? '', ...ids, snapshotId, snapshotId],
    text: `SELECT current_edges.*
      FROM edges AS current_edges INDEXED BY sqlite_autoindex_edges_1
      WHERE current_edges.snapshot_id = ? AND current_edges.id IN (${placeholders})
      UNION ALL
      SELECT base_edges.*
      FROM edges AS base_edges INDEXED BY sqlite_autoindex_edges_1
      WHERE base_edges.snapshot_id = ? AND base_edges.id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM edges AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_edge_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
        )`,
  };
}
