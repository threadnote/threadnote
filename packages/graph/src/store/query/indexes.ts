import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {normalizeSchemaDefinition} from '../schema/normalization.js';
import {CodeGraphStoreError} from '../../types.js';

export interface CodeGraphQueryIndexDefinition {
  readonly createSql: string;
  readonly name: string;
  readonly table: 'edges' | 'symbols' | 'snapshots';
}

export const CODE_GRAPH_SCOPE_QUERY_INDEX_DEFINITIONS = [
  {
    name: 'snapshots_scope_recent_ready',
    table: 'snapshots',
    createSql: `CREATE INDEX IF NOT EXISTS snapshots_scope_recent_ready
      ON snapshots(repository_id, scope_id, completed_at DESC, id) WHERE state = 'ready' AND dirty = 0`,
  },
  {
    name: 'snapshots_scope_commit_ready',
    table: 'snapshots',
    createSql: `CREATE INDEX IF NOT EXISTS snapshots_scope_commit_ready
      ON snapshots(repository_id, scope_id, commit_id, completed_at DESC, id) WHERE state = 'ready' AND dirty = 0`,
  },
  {
    name: 'snapshots_scope_reusable',
    table: 'snapshots',
    createSql: `CREATE INDEX IF NOT EXISTS snapshots_scope_reusable
      ON snapshots(repository_id, scope_id, extractor_set, completed_at DESC, id)
      WHERE state = 'ready' AND dirty = 0 AND base_snapshot_id IS NULL`,
  },
  {
    name: 'snapshots_scope_reusable_content',
    table: 'snapshots',
    createSql: `CREATE INDEX IF NOT EXISTS snapshots_scope_reusable_content
      ON snapshots(repository_id, scope_id, graph_content_id, extractor_set, completed_at DESC, id)
      WHERE state = 'ready' AND dirty = 0 AND base_snapshot_id IS NULL`,
  },
  {
    name: 'snapshots_scope_reusable_commit',
    table: 'snapshots',
    createSql: `CREATE INDEX IF NOT EXISTS snapshots_scope_reusable_commit
      ON snapshots(repository_id, scope_id, commit_id, completed_at DESC, id)
      WHERE state = 'ready' AND dirty = 0 AND base_snapshot_id IS NULL`,
  },
] as const satisfies readonly CodeGraphQueryIndexDefinition[];

export const ensureCodeGraphScopeQueryIndexes = Effect.fn('codeGraph.ensureScopeQueryIndexes')(function* (
  sql: SqlClient.SqlClient,
) {
  const inspection = yield* inspectCodeGraphQueryIndexes(sql, CODE_GRAPH_SCOPE_QUERY_INDEX_DEFINITIONS);
  yield* ensureCodeGraphQueryIndexes(sql, inspection.missing);
});

const visualizationKindOrder = `CASE kind
  WHEN 'package' THEN 0 WHEN 'module' THEN 1 WHEN 'class' THEN 2 WHEN 'interface' THEN 3
  WHEN 'function' THEN 4 WHEN 'method' THEN 5 ELSE 6 END`;

/**
 * Secondary indexes maintained only for graph query and publication surfaces.
 * Persistent full-build materialization writes neither index-owned authority
 * nor a queryable snapshot, so a proven empty store may bulk-build this exact
 * set after its resumable fact receipts are complete.
 */
export const CODE_GRAPH_QUERY_INDEX_DEFINITIONS = [
  {
    createSql: 'CREATE INDEX IF NOT EXISTS symbols_path ON symbols(snapshot_id, path)',
    name: 'symbols_path',
    table: 'symbols',
  },
  {
    createSql: `CREATE INDEX IF NOT EXISTS edges_target_resolved
      ON edges(snapshot_id, target_id, relation)
      WHERE target_id IS NOT NULL`,
    name: 'edges_target_resolved',
    table: 'edges',
  },
  // Incremental publication enumerates only the base edges owned by the
  // changed-path closure. Without this index a one-file overlay scans every
  // edge twice while the ready-state transaction is open.
  {
    createSql: 'CREATE INDEX IF NOT EXISTS edges_evidence_path ON edges(snapshot_id, evidence_path)',
    name: 'edges_evidence_path',
    table: 'edges',
  },
  {
    createSql: 'CREATE INDEX IF NOT EXISTS edges_source ON edges(snapshot_id, source_id, relation)',
    name: 'edges_source',
    table: 'edges',
  },
  {
    createSql: 'CREATE INDEX IF NOT EXISTS edges_endpoints ON edges(snapshot_id, source_id, target_id)',
    name: 'edges_endpoints',
    table: 'edges',
  },
  {
    createSql: `CREATE INDEX IF NOT EXISTS symbols_visualization_scope_v2
      ON symbols(snapshot_id, resolution_scope_id, exported DESC, (${visualizationKindOrder}), id)`,
    name: 'symbols_visualization_scope_v2',
    table: 'symbols',
  },
  {
    createSql: `CREATE INDEX IF NOT EXISTS symbols_visualization_package_v2
      ON symbols(
        snapshot_id, resolution_scope_id, package_name, exported DESC,
        (${visualizationKindOrder}), id
      )
      WHERE resolution_scope_id IS NULL`,
    name: 'symbols_visualization_package_v2',
    table: 'symbols',
  },
  {
    createSql: `CREATE INDEX IF NOT EXISTS symbols_visualization_path_v2
      ON symbols(
        snapshot_id,
        resolution_scope_id,
        (CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE '(root)' END),
        exported DESC,
        (${visualizationKindOrder}),
        id
      )
      WHERE resolution_scope_id IS NULL AND (package_name IS NULL OR trim(package_name) = '')`,
    name: 'symbols_visualization_path_v2',
    table: 'symbols',
  },
  {
    createSql: 'CREATE INDEX IF NOT EXISTS symbols_name_nocase ON symbols(snapshot_id, name COLLATE NOCASE)',
    name: 'symbols_name_nocase',
    table: 'symbols',
  },
  {
    createSql:
      'CREATE INDEX IF NOT EXISTS symbols_qualified_nocase ON symbols(snapshot_id, qualified_name COLLATE NOCASE)',
    name: 'symbols_qualified_nocase',
    table: 'symbols',
  },
  {
    createSql: 'CREATE INDEX IF NOT EXISTS symbols_path_nocase ON symbols(snapshot_id, path COLLATE NOCASE)',
    name: 'symbols_path_nocase',
    table: 'symbols',
  },
  {
    createSql: 'CREATE INDEX IF NOT EXISTS symbols_export_order ON symbols(snapshot_id, path, qualified_name, id)',
    name: 'symbols_export_order',
    table: 'symbols',
  },
  {
    createSql:
      'CREATE INDEX IF NOT EXISTS edges_export_order ON edges(snapshot_id, source_name, relation, target_name, id)',
    name: 'edges_export_order',
    table: 'edges',
  },
] as const satisfies readonly CodeGraphQueryIndexDefinition[];

export interface CodeGraphQueryIndexInspection {
  readonly missing: readonly CodeGraphQueryIndexDefinition[];
}

export const inspectCodeGraphQueryIndexes = Effect.fn('codeGraph.inspectQueryIndexes')(function* (
  sql: SqlClient.SqlClient,
  definitions: readonly CodeGraphQueryIndexDefinition[] = CODE_GRAPH_QUERY_INDEX_DEFINITIONS,
) {
  if (definitions.length === 0) return {missing: []} satisfies CodeGraphQueryIndexInspection;
  const rows = yield* sql.unsafe<{
    readonly name: unknown;
    readonly sql: unknown;
    readonly type: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= 128 THEN name ELSE NULL END AS name,
       CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 4096 THEN sql ELSE NULL END AS sql,
       type
     FROM sqlite_master
     WHERE name COLLATE NOCASE IN (${definitions.map(() => '?').join(', ')})
     LIMIT ${definitions.length + 1}`,
    definitions.map(definition => definition.name),
  );
  const expectedByName = new Map(definitions.map(definition => [definition.name, definition]));
  const current = new Set<string>();
  for (const row of rows) {
    if (typeof row.name !== 'string' || typeof row.sql !== 'string' || row.type !== 'index') {
      return yield* CodeGraphStoreError.of('Code graph query index schema is incompatible.');
    }
    const expected = expectedByName.get(row.name);
    if (
      expected === undefined ||
      current.has(row.name) ||
      normalizeSchemaDefinition(row.sql) !== normalizeSchemaDefinition(expected.createSql)
    ) {
      return yield* CodeGraphStoreError.of('Code graph query index schema is incompatible.');
    }
    current.add(row.name);
  }
  return {
    missing: definitions.filter(definition => !current.has(definition.name)),
  } satisfies CodeGraphQueryIndexInspection;
});

export const ensureCodeGraphQueryIndexes = Effect.fn('codeGraph.ensureQueryIndexes')(function* (
  sql: SqlClient.SqlClient,
  definitions: readonly CodeGraphQueryIndexDefinition[] = CODE_GRAPH_QUERY_INDEX_DEFINITIONS,
) {
  for (const definition of definitions) yield* sql.unsafe(definition.createSql);
  const inspection = yield* inspectCodeGraphQueryIndexes(sql, definitions);
  if (inspection.missing.length > 0) {
    return yield* CodeGraphStoreError.of('Code graph query index schema is unavailable.');
  }
});
