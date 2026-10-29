import {compareCodeUnits} from '../ordering.js';
import {type CodeGraphVisualizationScope, type CodeGraphVisualizationScopeEdge} from './models.js';
import {type CodeGraphProvenance} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const MANAGER_SCOPE_SAMPLE_SYMBOLS_PER_SCOPE = 6;

const MANAGER_SCOPE_SAMPLE_MAX_SCOPES = 500;

const MANAGER_SCOPE_SAMPLE_PROVENANCES: readonly CodeGraphProvenance[] = ['declared', 'resolved', 'syntactic'];

const MANAGER_SCOPE_SAMPLE_BATCH_SIZE = 64;

interface VisualizationScopeEndpointRow {
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly package_name: unknown;
  readonly path: string;
  readonly resolution_scope_id: unknown;
}

export function codeGraphVisualizationCatalogComponentStatement(
  snapshotId: string,
  projectQuery: string,
  limit: number,
  offset: number,
): CodeGraphSqlQueryStatement {
  const query = Effect.pipe(projectQuery, EffectString.trim);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.min(1_000_000, Math.floor(offset)));
  const componentQuery = visualizationCatalogComponentQueryPredicate(query);
  if (query.length === 0) {
    return {
      parameters: [snapshotId, snapshotId, snapshotId, safeLimit, safeOffset],
      text: `WITH dependency_degree AS (
          SELECT component_id, COUNT(*) AS degree
          FROM (
            SELECT source_component_id AS component_id
            FROM workspace_component_dependencies
            WHERE snapshot_id = ?
            UNION ALL
            SELECT target_component_id AS component_id
            FROM workspace_component_dependencies
            WHERE snapshot_id = ?
          )
          GROUP BY component_id
        )
        SELECT component.id, component.workspace_id, component.build_system, component.kind,
          component.name, component.provenance
        FROM workspace_components AS component
        LEFT JOIN dependency_degree ON dependency_degree.component_id = component.id
        WHERE component.snapshot_id = ?
        ORDER BY COALESCE(dependency_degree.degree, 0) DESC, component.name, component.root, component.id
        LIMIT ? OFFSET ?`,
    };
  }
  return {
    parameters: [snapshotId, ...componentQuery.parameters, snapshotId, snapshotId, safeLimit, safeOffset],
    text: `WITH candidate_components AS MATERIALIZED (
        SELECT component.id, component.workspace_id, component.build_system, component.kind,
          component.name, component.root, component.provenance
        FROM workspace_components AS component
        WHERE component.snapshot_id = ?
          ${componentQuery.text}
      ), candidate_dependency_endpoints AS MATERIALIZED (
        SELECT outgoing.source_component_id AS component_id
        FROM candidate_components AS candidate
        JOIN workspace_component_dependencies AS outgoing
          ON outgoing.snapshot_id = ? AND outgoing.source_component_id = candidate.id
        UNION ALL
        SELECT incoming.target_component_id AS component_id
        FROM workspace_component_dependencies AS incoming
        JOIN candidate_components AS candidate ON candidate.id = incoming.target_component_id
        WHERE incoming.snapshot_id = ?
      ), dependency_degree AS MATERIALIZED (
        SELECT component_id, COUNT(*) AS degree
        FROM candidate_dependency_endpoints
        GROUP BY component_id
      )
      SELECT component.id, component.workspace_id, component.build_system, component.kind,
        component.name, component.provenance
      FROM candidate_components AS component
      LEFT JOIN dependency_degree ON dependency_degree.component_id = component.id
      ORDER BY COALESCE(dependency_degree.degree, 0) DESC, component.name, component.root, component.id
      LIMIT ? OFFSET ?`,
  };
}

function visualizationCatalogComponentQueryPredicate(projectQuery: string): CodeGraphSqlQueryStatement {
  return projectQuery.length === 0
    ? {parameters: [], text: ''}
    : {
        parameters: [projectQuery, projectQuery],
        text: `AND (
          instr(lower(component.name || ' ' || component.root || ' ' || component.id), lower(?)) > 0
          OR EXISTS (
            SELECT 1
            FROM workspace_scopes AS workspace
            WHERE workspace.snapshot_id = component.snapshot_id
              AND workspace.id = component.workspace_id
              AND instr(lower(workspace.name || ' ' || workspace.root || ' ' || workspace.id), lower(?)) > 0
          )
        )`,
      };
}

export function codeGraphVisualizationScopeEndpointStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  requestedEndpointIds: readonly string[],
): CodeGraphSqlQueryStatement {
  const endpointIds = [...new Set(requestedEndpointIds)].slice(0, 16_000).sort(compareCodeUnits);
  return {
    parameters: [JSON.stringify(endpointIds), snapshotId, baseSnapshotId ?? '', snapshotId, snapshotId],
    text: `WITH endpoint_ids AS (
        SELECT CAST(value AS TEXT) AS id FROM json_each(?)
      ), effective_endpoint_symbols AS (
        SELECT current_symbols.id, current_symbols.resolution_scope_id, current_symbols.language,
          current_symbols.kind, current_symbols.package_name, current_symbols.path
        FROM endpoint_ids
        CROSS JOIN symbols AS current_symbols INDEXED BY sqlite_autoindex_symbols_1
        WHERE current_symbols.snapshot_id = ? AND current_symbols.id = endpoint_ids.id
        UNION ALL
        SELECT base_symbols.id, base_symbols.resolution_scope_id, base_symbols.language,
          base_symbols.kind, base_symbols.package_name, base_symbols.path
        FROM endpoint_ids
        CROSS JOIN symbols AS base_symbols INDEXED BY sqlite_autoindex_symbols_1
        WHERE base_symbols.snapshot_id = ? AND base_symbols.id = endpoint_ids.id
          AND NOT EXISTS (
            SELECT 1 FROM symbols AS overrides
            WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_symbol_deletions AS deletions
            WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
          )
      )
      SELECT * FROM effective_endpoint_symbols ORDER BY id`,
  };
}

export function codeGraphVisualizationScopeSummaryStatementCount(scopeCount: number): number {
  const safeScopes = Math.max(0, Math.min(MANAGER_SCOPE_SAMPLE_MAX_SCOPES, Math.floor(scopeCount)));
  if (safeScopes === 0) return 0;
  const batches = Math.ceil(safeScopes / MANAGER_SCOPE_SAMPLE_BATCH_SIZE);
  return batches * 2 + 1;
}

interface VisualizationScopeSymbolFields {
  readonly kind: string;
  readonly language: string;
  readonly packageName?: string;
  readonly path: string;
  readonly resolutionScopeId?: string;
}

function visualizationScopeIdForSymbol(
  symbol: VisualizationScopeSymbolFields,
  visibleScopes: ReadonlySet<string>,
): string | undefined {
  if (symbol.resolutionScopeId) return symbol.resolutionScopeId;
  if (visibleScopes.has('facet:unscoped')) return 'facet:unscoped';
  if (symbol.language === 'markdown' || ['document', 'heading', 'section'].includes(symbol.kind)) {
    return 'facet:unscoped-documentation';
  }
  const packageName = Effect.pipe(symbol.packageName, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  if (packageName) return `package:${packageName}`;
  return `path:${Effect.pipe(symbol.path, EffectString.split('/'))[0] || '(root)'}`;
}

function visualizationScopeFromProjectId(projectId: string): CodeGraphVisualizationScope {
  if (Effect.pipe(projectId, EffectString.startsWith('cgp_'))) return {type: 'component', value: projectId};
  if (projectId === 'facet:unscoped') return {type: 'unscoped'};
  if (projectId === 'facet:unscoped-documentation') return {type: 'documentation-facet'};
  if (Effect.pipe(projectId, EffectString.startsWith('package:')))
    return {type: 'package', value: Effect.pipe(projectId, EffectString.slice('package:'.length))};
  if (Effect.pipe(projectId, EffectString.startsWith('path:')))
    return {type: 'path', value: Effect.pipe(projectId, EffectString.slice('path:'.length))};
  return {type: 'all'};
}

function compareVisualizationScopeEdges(
  left: CodeGraphVisualizationScopeEdge,
  right: CodeGraphVisualizationScopeEdge,
): number {
  return (
    right.count - left.count ||
    right.confidence - left.confidence ||
    compareCodeUnits(left.sourceId, right.sourceId) ||
    compareCodeUnits(left.targetId, right.targetId) ||
    compareCodeUnits(left.relation, right.relation) ||
    compareCodeUnits(left.provenance, right.provenance)
  );
}

function isDefinedString(value: string | undefined): value is string {
  return typeof value === 'string';
}

export interface CodeGraphSqlQueryStatement {
  readonly parameters: readonly (number | string)[];
  readonly text: string;
}

export function codeGraphVisualizationSymbolsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  scope: CodeGraphVisualizationScope,
  limit: number,
): CodeGraphSqlQueryStatement {
  const current = visualizationScopePredicate(scope, 'current_symbols');
  const base = visualizationScopePredicate(scope, 'base_symbols');
  const scopeIndex = visualizationScopeIndex(scope);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const order =
    scope.type === 'all'
      ? 'path, qualified_name, id'
      : `exported DESC,
      CASE kind
        WHEN 'package' THEN 0 WHEN 'module' THEN 1 WHEN 'class' THEN 2 WHEN 'interface' THEN 3
        WHEN 'function' THEN 4 WHEN 'method' THEN 5 ELSE 6
      END,
      id`;
  return {
    parameters: [
      snapshotId,
      ...current.parameters,
      safeLimit,
      baseSnapshotId ?? '',
      ...base.parameters,
      snapshotId,
      snapshotId,
      safeLimit,
      safeLimit,
    ],
    text: `WITH effective_symbols AS (
      SELECT * FROM (
        SELECT current_symbols.*
        FROM symbols AS current_symbols${scopeIndex}
        WHERE current_symbols.snapshot_id = ? AND ${current.text}
        ORDER BY ${order}
        LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
        SELECT base_symbols.*
        FROM symbols AS base_symbols${scopeIndex}
        WHERE base_symbols.snapshot_id = ? AND ${base.text}
          AND NOT EXISTS (
            SELECT 1 FROM symbols AS overrides
            WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_symbol_deletions AS deletions
            WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
          )
        ORDER BY ${order}
        LIMIT ?
      )
    )
    SELECT *
    FROM effective_symbols
    ORDER BY ${order}
    LIMIT ?`,
  };
}

function visualizationScopeIndex(scope: CodeGraphVisualizationScope): string {
  switch (scope.type) {
    case 'all':
      return ' INDEXED BY symbols_export_order';
    case 'package':
    case 'path':
    case 'component':
    case 'unscoped':
      // These visualization indexes were added additively within graph-v3.
      // Let SQLite select them when present so a Manager-only session can
      // still read an older v3 database before the next writer initializes it.
      return '';
    case 'documentation-facet':
      return ' INDEXED BY symbols_visualization_scope_v2';
  }
}

function visualizationScopePredicate(scope: CodeGraphVisualizationScope, alias: string): CodeGraphSqlQueryStatement {
  const pathScope = `CASE WHEN instr(${alias}.path, '/') > 0 THEN substr(${alias}.path, 1, instr(${alias}.path, '/') - 1) ELSE '(root)' END`;
  switch (scope.type) {
    case 'all':
      return {parameters: [], text: '1 = 1'};
    case 'component':
      return {parameters: [scope.value], text: `${alias}.resolution_scope_id = ?`};
    case 'documentation-facet':
      return {
        parameters: [],
        text: `${alias}.resolution_scope_id IS NULL AND (${alias}.language = 'markdown' OR ${alias}.kind IN ('document', 'heading', 'section'))`,
      };
    case 'package':
      return {
        parameters: [scope.value],
        text: `${alias}.resolution_scope_id IS NULL AND ${alias}.package_name = ?`,
      };
    case 'path':
      return {
        parameters: [scope.value],
        text: `${alias}.resolution_scope_id IS NULL AND (${alias}.package_name IS NULL OR trim(${alias}.package_name) = '') AND ${pathScope} = ?`,
      };
    case 'unscoped':
      return {parameters: [], text: `${alias}.resolution_scope_id IS NULL`};
  }
}

export {
  MANAGER_SCOPE_SAMPLE_MAX_SCOPES,
  MANAGER_SCOPE_SAMPLE_BATCH_SIZE,
  visualizationCatalogComponentQueryPredicate,
  MANAGER_SCOPE_SAMPLE_SYMBOLS_PER_SCOPE,
  MANAGER_SCOPE_SAMPLE_PROVENANCES,
  VisualizationScopeEndpointRow,
  VisualizationScopeSymbolFields,
  visualizationScopeIdForSymbol,
  visualizationScopeFromProjectId,
  compareVisualizationScopeEdges,
  isDefinedString,
  visualizationScopeIndex,
  visualizationScopePredicate,
};
