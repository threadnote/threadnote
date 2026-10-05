import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';
import {codeGraphScopeAuthorityInstalled} from './scope/schema.js';
import {Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {compareCodeUnits} from '../ordering.js';
import {
  type CodeGraphVisualizationCatalog,
  type CodeGraphVisualizationCatalogOptions,
  type CodeGraphVisualizationProject,
  type CodeGraphVisualizationScope,
  type CodeGraphVisualizationScopeEdge,
} from './models.js';
import {configureConnection, tableExists} from './session.js';
import {type CodeGraphEdge, type CodeGraphProvenance} from '../types.js';
import {
  type CodeGraphWorkspaceBuildSystem,
  type CodeGraphWorkspaceComponentKind,
  type CodeGraphWorkspaceProvenance,
} from '../languages/types.js';
import {
  boundedVisualizationCatalogLimit,
  boundedVisualizationCatalogOffset,
  boundedVisualizationCatalogQuery,
  chunk,
  parseStringArray,
  sqlTextOption,
} from './utilities.js';
import {
  type DeferredVisualizationComponentRow,
  type EdgeRow,
  type SnapshotRow,
  type SymbolRow,
} from './internal_models.js';
import {
  type CodeGraphSqlQueryStatement,
  codeGraphVisualizationCatalogComponentStatement,
  codeGraphVisualizationScopeEndpointStatement,
  codeGraphVisualizationSymbolsQueryStatement,
  compareVisualizationScopeEdges,
  isDefinedString,
  MANAGER_SCOPE_SAMPLE_BATCH_SIZE,
  MANAGER_SCOPE_SAMPLE_MAX_SCOPES,
  MANAGER_SCOPE_SAMPLE_PROVENANCES,
  MANAGER_SCOPE_SAMPLE_SYMBOLS_PER_SCOPE,
  visualizationCatalogComponentQueryPredicate,
  type VisualizationScopeEndpointRow,
  visualizationScopeFromProjectId,
  visualizationScopeIdForSymbol,
} from './visualization_sql.js';
import {edgeFromRow, snapshotFromRow, symbolFromRow} from './rows.js';
import {selectPersistedSnapshotComponentEdges} from './component_aggregates.js';
import {
  codeGraphAdjacencyQueryStatement,
  effectiveGraphCtes,
  effectiveGraphParameters,
  effectiveSnapshotParameters,
  effectiveSymbolsCte,
  selectBaseSnapshotId,
} from './query/core.js';

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

const selectVisualizationCatalog = Effect.fn('codeGraph.selectVisualizationCatalog')(function* (
  viewWorktreeId?: string,
  metrics: 'complete' | 'deferred' = 'complete',
  options: CodeGraphVisualizationCatalogOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const projectLimit = boundedVisualizationCatalogLimit(options.projectLimit, 160, 500);
  const projectOffset = boundedVisualizationCatalogOffset(options.projectOffset);
  const projectQuery = boundedVisualizationCatalogQuery(options.projectQuery);
  const workspaceLimit = boundedVisualizationCatalogLimit(options.workspaceLimit, 64, 128);
  const workspaceOffset = boundedVisualizationCatalogOffset(options.workspaceOffset);
  const workspaceQuery = boundedVisualizationCatalogQuery(options.workspaceQuery);
  const requestedProjectId = Option.getOrUndefined(options.projectId ?? Option.none());
  const requestedSnapshotId = Option.getOrUndefined(options.snapshotId ?? Option.none());
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const scoped = yield* codeGraphScopeAuthorityInstalled(sql);
  const rows = yield* sql.unsafe<
    SnapshotRow & {readonly activated_at: unknown; readonly display_name: string; readonly view_worktree_id: string}
  >(
    `SELECT snapshots.*, repositories.display_name, active_snapshots.activated_at,
       active_snapshots.worktree_id AS view_worktree_id
     FROM active_snapshots
     JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
     JOIN repositories ON repositories.id = snapshots.repository_id
     WHERE snapshots.state = 'ready'
       AND (? IS NULL OR snapshots.id = ?)
       AND (? IS NULL OR active_snapshots.worktree_id = ?)
       ${scoped && options.scopeId !== undefined ? 'AND active_snapshots.scope_id = ?' : ''}
       ${
         removedViewsAvailable
           ? `AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active_snapshots.worktree_id
                  ${scoped ? 'AND removed.scope_id = active_snapshots.scope_id' : ''}
                  AND removed.expected_snapshot_id = active_snapshots.snapshot_id
              )`
           : ''
       }
     ORDER BY active_snapshots.activated_at DESC, snapshots.completed_at DESC, snapshots.id
     LIMIT 1`,
    [
      requestedSnapshotId ?? null,
      requestedSnapshotId ?? null,
      viewWorktreeId ?? null,
      viewWorktreeId ?? null,
      ...(scoped && options.scopeId !== undefined ? [options.scopeId] : []),
    ],
  );
  const row = rows[0];
  if (!row) return undefined;
  const baseSnapshotId = Option.getOrUndefined(sqlTextOption(row.base_snapshot_id));
  const activatedAt = Option.getOrUndefined(sqlTextOption(row.activated_at));
  const hasWorkspaceCatalog =
    (yield* tableExists(sql, 'workspace_components')) &&
    Number(
      (yield* sql<{readonly count: number}>`
          SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ${row.id}
        `)[0]?.count ?? 0,
    ) > 0;
  if (metrics === 'deferred') {
    if (hasWorkspaceCatalog) {
      const requestedComponentId = requestedProjectId?.startsWith('cgp_') ? requestedProjectId : undefined;
      const unscopedMatchesQuery =
        projectQuery.length === 0 || 'unscoped code and documentation'.includes(projectQuery.toLocaleLowerCase());
      const componentQuery = visualizationCatalogComponentQueryPredicate(projectQuery);
      const includeUnscoped =
        (requestedProjectId === undefined && projectOffset === 0 && unscopedMatchesQuery) ||
        requestedProjectId === 'facet:unscoped';
      const componentLimit =
        requestedProjectId === 'facet:unscoped'
          ? 0
          : requestedProjectId === undefined
            ? Math.max(0, projectLimit - (includeUnscoped ? 1 : 0))
            : projectLimit;
      const componentsEffect =
        componentLimit === 0
          ? Effect.succeed<readonly DeferredVisualizationComponentRow[]>([])
          : requestedComponentId
            ? sql<DeferredVisualizationComponentRow>`
                SELECT id, workspace_id, build_system, kind, name, provenance
                FROM workspace_components
                WHERE snapshot_id = ${row.id} AND id = ${requestedComponentId}
                LIMIT ${componentLimit}
              `
            : Effect.gen(function* () {
                const statement = codeGraphVisualizationCatalogComponentStatement(
                  row.id,
                  projectQuery,
                  componentLimit,
                  projectOffset,
                );
                return yield* sql.unsafe<DeferredVisualizationComponentRow>(statement.text, statement.parameters);
              });
      const [workspaceCountRows, workspaces, componentCountRows, components] = yield* Effect.all(
        [
          sql.unsafe<{readonly count: number}>(
            `SELECT COUNT(*) AS count FROM workspace_scopes
             WHERE snapshot_id = ?
               ${workspaceQuery.length === 0 ? '' : "AND instr(lower(name || ' ' || root || ' ' || id), lower(?)) > 0"}`,
            [row.id, ...(workspaceQuery.length === 0 ? [] : [workspaceQuery])],
          ),
          sql.unsafe<{
            readonly build_system: CodeGraphWorkspaceBuildSystem;
            readonly id: string;
            readonly name: string;
            readonly provenance: CodeGraphWorkspaceProvenance;
            readonly root: string;
          }>(
            `SELECT id, build_system, name, root, provenance
             FROM workspace_scopes
             WHERE snapshot_id = ?
               ${workspaceQuery.length === 0 ? '' : "AND instr(lower(name || ' ' || root || ' ' || id), lower(?)) > 0"}
             ORDER BY root, id
             LIMIT ? OFFSET ?`,
            [row.id, ...(workspaceQuery.length === 0 ? [] : [workspaceQuery]), workspaceLimit, workspaceOffset],
          ),
          sql.unsafe<{readonly count: number}>(
            `SELECT COUNT(*) AS count FROM workspace_components AS component
             WHERE component.snapshot_id = ?
               ${componentQuery.text}`,
            [row.id, ...componentQuery.parameters],
          ),
          componentsEffect,
        ],
        {concurrency: 1},
      );
      const componentIds = components.map(component => component.id);
      const dependencies =
        options.includeDependencies === true && componentIds.length > 0
          ? yield* sql.unsafe<{
              readonly provenance: CodeGraphWorkspaceProvenance;
              readonly source_component_id: string;
              readonly target_component_id: string;
            }>(
              `SELECT source_component_id, target_component_id, provenance
               FROM workspace_component_dependencies
               WHERE snapshot_id = ?
                 AND source_component_id IN (${componentIds.map(() => '?').join(', ')})
                 AND target_component_id IN (${componentIds.map(() => '?').join(', ')})
               ORDER BY source_component_id, target_component_id, provenance`,
              [row.id, ...componentIds, ...componentIds],
            )
          : [];
      const dependenciesBySource = new Map<string, Array<(typeof dependencies)[number]>>();
      for (const dependency of dependencies) {
        const current = dependenciesBySource.get(dependency.source_component_id);
        if (current) current.push(dependency);
        else dependenciesBySource.set(dependency.source_component_id, [dependency]);
      }
      const projects: CodeGraphVisualizationProject[] = components.map(component => ({
        buildSystem: component.build_system,
        dependencies: (dependenciesBySource.get(component.id) ?? []).map(dependency => ({
          provenance: dependency.provenance,
          targetId: dependency.target_component_id,
        })),
        diagnostics: [],
        fileCount: 0,
        id: component.id,
        kind: component.kind,
        label: component.name,
        languages: [],
        model: 'component',
        provenance: component.provenance,
        sourceRoots: [],
        symbolCount: 0,
        workspaceId: component.workspace_id,
        workspaceRoots: [],
      }));
      if (includeUnscoped && projects.length < projectLimit) {
        projects.push({
          dependencies: [],
          diagnostics: [],
          fileCount: 0,
          id: 'facet:unscoped',
          kind: 'legacy-group',
          label: 'Unscoped code and documentation',
          languages: [],
          model: 'facet',
          provenance: 'inferred',
          sourceRoots: [],
          symbolCount: 0,
          workspaceRoots: [],
        });
      }
      const componentCount = Number(componentCountRows[0]?.count ?? 0);
      const workspaceCount = Number(workspaceCountRows[0]?.count ?? 0);
      const totalProjectCount = componentCount + (unscopedMatchesQuery ? 1 : 0);
      return {
        accounting: {
          attributedSymbols: 0,
          componentSymbols: 0,
          fallbackSymbols: 0,
          omittedSymbols: Number(row.symbol_count),
          totalSymbols: Number(row.symbol_count),
        },
        ...(activatedAt ? {activatedAt} : {}),
        metrics: 'deferred',
        model: 'workspace',
        projectCount: totalProjectCount,
        projects,
        projectsTruncated: projectOffset + components.length < componentCount,
        repository: {displayName: row.display_name, repositoryId: row.repository_id},
        snapshot: snapshotFromRow(row),
        viewWorktreeId: row.view_worktree_id,
        ...(row.scope_id !== undefined && row.scope_id !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY
          ? {viewScopeId: row.scope_id}
          : {}),
        workspaceCount,
        workspaces: workspaces.map(workspace => ({
          buildSystem: workspace.build_system,
          diagnostics: [],
          id: workspace.id,
          name: workspace.name,
          provenance: workspace.provenance,
          root: workspace.root,
        })),
        workspacesTruncated: workspaceOffset + workspaces.length < workspaceCount,
      } satisfies CodeGraphVisualizationCatalog;
    }
    return {
      accounting: {
        attributedSymbols: Number(row.symbol_count),
        componentSymbols: 0,
        fallbackSymbols: Number(row.symbol_count),
        omittedSymbols: 0,
        totalSymbols: Number(row.symbol_count),
      },
      ...(activatedAt ? {activatedAt} : {}),
      metrics: 'deferred',
      model: 'legacy-fallback',
      projectCount: 1,
      projects: [
        {
          dependencies: [],
          diagnostics: [],
          fileCount: Number(row.file_count),
          id: 'facet:repository',
          kind: 'legacy-group',
          label: 'Repository symbols',
          languages: [],
          model: 'legacy-fallback',
          provenance: 'legacy',
          sourceRoots: [],
          symbolCount: Number(row.symbol_count),
          workspaceRoots: [],
        },
      ],
      projectsTruncated: false,
      repository: {displayName: row.display_name, repositoryId: row.repository_id},
      snapshot: snapshotFromRow(row),
      viewWorktreeId: row.view_worktree_id,
      ...(row.scope_id !== undefined && row.scope_id !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY
        ? {viewScopeId: row.scope_id}
        : {}),
      workspaceCount: 0,
      workspaces: [],
      workspacesTruncated: false,
    } satisfies CodeGraphVisualizationCatalog;
  }
  if (hasWorkspaceCatalog) {
    const [workspaces, components, unscopedGroups, dependencies] = yield* Effect.all(
      [
        sql<{
          readonly build_system: CodeGraphWorkspaceBuildSystem;
          readonly diagnostics_json: string;
          readonly id: string;
          readonly name: string;
          readonly provenance: CodeGraphWorkspaceProvenance;
          readonly root: string;
        }>`
          SELECT id, build_system, name, root, provenance, diagnostics_json
          FROM workspace_scopes
          WHERE snapshot_id = ${row.id}
          ORDER BY root, id
        `,
        sql.unsafe<{
          readonly build_system: CodeGraphWorkspaceBuildSystem;
          readonly diagnostics_json: string;
          readonly file_count: number;
          readonly id: string;
          readonly kind: CodeGraphWorkspaceComponentKind;
          readonly languages_json: string;
          readonly name: string;
          readonly provenance: CodeGraphWorkspaceProvenance;
          readonly resolution_domain: string;
          readonly root: string;
          readonly source_roots_json: string;
          readonly symbol_count: number;
          readonly workspace_id: string;
          readonly workspace_roots_json: string;
        }>(
          `${effectiveSymbolsCte()}
           SELECT component.id, component.workspace_id, component.build_system, component.kind,
             component.name, component.root, component.resolution_domain, component.languages_json,
             component.source_roots_json, component.workspace_roots_json, component.provenance,
             component.diagnostics_json,
             COUNT(symbol.id) AS symbol_count, COUNT(DISTINCT symbol.path) AS file_count
           FROM workspace_components AS component
           LEFT JOIN effective_symbols AS symbol ON symbol.resolution_scope_id = component.id
           WHERE component.snapshot_id = ?
           GROUP BY component.id, component.workspace_id, component.build_system, component.kind,
             component.name, component.root, component.resolution_domain, component.languages_json,
             component.source_roots_json, component.workspace_roots_json, component.provenance,
             component.diagnostics_json
           ORDER BY component.name, component.root, component.id`,
          [...effectiveSnapshotParameters(row.id, baseSnapshotId), row.id],
        ),
        sql.unsafe<{
          readonly file_count: number;
          readonly languages: string;
          readonly scope_type: 'documentation' | 'package' | 'path';
          readonly scope_value: string;
          readonly symbol_count: number;
        }>(
          `${effectiveSymbolsCte()}
           SELECT
             CASE
               WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'documentation'
               WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package'
               ELSE 'path'
             END AS scope_type,
             CASE
               WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'unscoped-documentation'
               WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN package_name
               WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1)
               ELSE '(root)'
             END AS scope_value,
             GROUP_CONCAT(DISTINCT language) AS languages,
             COUNT(*) AS symbol_count,
             COUNT(DISTINCT path) AS file_count
           FROM effective_symbols
           WHERE resolution_scope_id IS NULL
           GROUP BY 1, 2
           ORDER BY symbol_count DESC, scope_type, scope_value`,
          effectiveSnapshotParameters(row.id, baseSnapshotId),
        ),
        sql<{
          readonly evidence: unknown;
          readonly provenance: CodeGraphWorkspaceProvenance;
          readonly source_component_id: string;
          readonly target_component_id: string;
        }>`
          SELECT source_component_id, target_component_id, provenance, evidence
          FROM workspace_component_dependencies
          WHERE snapshot_id = ${row.id}
          ORDER BY source_component_id, target_component_id, provenance
        `,
      ],
      {concurrency: 1},
    );
    const dependenciesBySource = new Map<string, Array<(typeof dependencies)[number]>>();
    for (const dependency of dependencies) {
      const current = dependenciesBySource.get(dependency.source_component_id);
      if (current) current.push(dependency);
      else dependenciesBySource.set(dependency.source_component_id, [dependency]);
    }
    const projects: CodeGraphVisualizationProject[] = components.map(component => ({
      buildSystem: component.build_system,
      dependencies: (dependenciesBySource.get(component.id) ?? []).map(dependency => ({
        ...(typeof dependency.evidence === 'string' ? {evidence: dependency.evidence} : {}),
        provenance: dependency.provenance,
        targetId: dependency.target_component_id,
      })),
      diagnostics: parseStringArray(component.diagnostics_json),
      fileCount: Number(component.file_count),
      id: component.id,
      kind: component.kind,
      label: component.name,
      languages: parseStringArray(component.languages_json),
      model: 'component',
      provenance: component.provenance,
      resolutionDomain: component.resolution_domain,
      root: component.root,
      sourceRoots: parseStringArray(component.source_roots_json),
      symbolCount: Number(component.symbol_count),
      workspaceId: component.workspace_id,
      workspaceRoots: parseStringArray(component.workspace_roots_json),
    }));
    projects.push(
      ...unscopedGroups.map(group => ({
        dependencies: [],
        diagnostics: [],
        fileCount: Number(group.file_count),
        id:
          group.scope_type === 'documentation'
            ? 'facet:unscoped-documentation'
            : `${group.scope_type}:${group.scope_value}`,
        kind: group.scope_type === 'documentation' ? ('documentation' as const) : ('legacy-group' as const),
        label: group.scope_type === 'documentation' ? 'Unscoped documentation' : group.scope_value,
        languages: group.languages ? group.languages.split(',').sort(compareCodeUnits) : [],
        model: 'facet' as const,
        provenance: 'inferred' as const,
        sourceRoots: [],
        symbolCount: Number(group.symbol_count),
        workspaceRoots: [],
      })),
    );
    const componentSymbols = components.reduce((total, component) => total + Number(component.symbol_count), 0);
    const fallbackSymbols = unscopedGroups.reduce((total, group) => total + Number(group.symbol_count), 0);
    const totalSymbols = Number(row.symbol_count);
    const attributedSymbols = componentSymbols + fallbackSymbols;
    return {
      accounting: {
        attributedSymbols,
        componentSymbols,
        fallbackSymbols,
        omittedSymbols: Math.max(0, totalSymbols - attributedSymbols),
        totalSymbols,
      },
      ...(activatedAt ? {activatedAt} : {}),
      metrics: 'complete',
      model: 'workspace',
      projectCount: projects.length,
      projects,
      projectsTruncated: false,
      repository: {displayName: row.display_name, repositoryId: row.repository_id},
      snapshot: snapshotFromRow(row),
      viewWorktreeId: row.view_worktree_id,
      ...(row.scope_id !== undefined && row.scope_id !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY
        ? {viewScopeId: row.scope_id}
        : {}),
      workspaceCount: workspaces.length,
      workspaces: workspaces.map(workspace => ({
        buildSystem: workspace.build_system,
        diagnostics: parseStringArray(workspace.diagnostics_json),
        id: workspace.id,
        name: workspace.name,
        provenance: workspace.provenance,
        root: workspace.root,
      })),
      workspacesTruncated: false,
    } satisfies CodeGraphVisualizationCatalog;
  }
  const projects = yield* sql.unsafe<{
    readonly file_count: number;
    readonly scope_type: 'package' | 'path';
    readonly scope_value: string;
    readonly symbol_count: number;
  }>(
    `${effectiveSymbolsCte()}
     SELECT
       CASE
         WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package'
         ELSE 'path'
       END AS scope_type,
       CASE
         WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN package_name
         WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1)
         ELSE '(root)'
       END AS scope_value,
       COUNT(*) AS symbol_count,
       COUNT(DISTINCT path) AS file_count
     FROM effective_symbols
     GROUP BY 1, 2
     ORDER BY symbol_count DESC, scope_value`,
    effectiveSnapshotParameters(row.id, baseSnapshotId),
  );
  return {
    accounting: {
      attributedSymbols: Number(row.symbol_count),
      componentSymbols: 0,
      fallbackSymbols: Number(row.symbol_count),
      omittedSymbols: 0,
      totalSymbols: Number(row.symbol_count),
    },
    projectCount: projects.length,
    projects: projects.map(project => ({
      dependencies: [],
      diagnostics: [],
      fileCount: Number(project.file_count),
      id: `${project.scope_type}:${project.scope_value}`,
      kind: 'legacy-group',
      label: project.scope_value,
      languages: [],
      model: 'legacy-fallback',
      provenance: 'legacy',
      sourceRoots: [],
      symbolCount: Number(project.symbol_count),
      workspaceRoots: [],
    })),
    projectsTruncated: false,
    ...(activatedAt ? {activatedAt} : {}),
    metrics: 'complete',
    model: 'legacy-fallback',
    repository: {
      displayName: row.display_name,
      repositoryId: row.repository_id,
    },
    snapshot: snapshotFromRow(row),
    viewWorktreeId: row.view_worktree_id,
    ...(row.scope_id !== undefined && row.scope_id !== CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY
      ? {viewScopeId: row.scope_id}
      : {}),
    workspaceCount: 0,
    workspaces: [],
    workspacesTruncated: false,
  } satisfies CodeGraphVisualizationCatalog;
});

const selectVisualizationCatalogs = Effect.fn('codeGraph.selectVisualizationCatalogs')(function* (
  metrics: 'complete' | 'deferred' = 'complete',
  options: CodeGraphVisualizationCatalogOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const viewLimit = boundedVisualizationCatalogLimit(options.viewLimit, 32, 64);
  const viewOffset = boundedVisualizationCatalogOffset(options.viewOffset);
  const viewQuery = boundedVisualizationCatalogQuery(options.viewQuery);
  const scopeIds = [
    ...new Set([...(options.scopeIds ?? []), ...(options.scopeId === undefined ? [] : [options.scopeId])]),
  ].slice(0, 64);
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const scoped = yield* codeGraphScopeAuthorityInstalled(sql);
  if (!scoped && scopeIds.length > 0) return [];
  const scopePredicate =
    scoped && scopeIds.length > 0 ? `active_snapshots.scope_id IN (${scopeIds.map(() => '?').join(', ')})` : '';
  const queryPredicate =
    viewQuery.length === 0
      ? ''
      : "instr(lower(repositories.display_name || ' ' || snapshots.commit_id || ' ' || active_snapshots.worktree_id), lower(?)) > 0";
  const viewPredicate =
    scopePredicate.length > 0 && queryPredicate.length > 0
      ? `AND (${scopePredicate} OR ${queryPredicate})`
      : scopePredicate.length > 0
        ? `AND ${scopePredicate}`
        : queryPredicate.length > 0
          ? `AND ${queryPredicate}`
          : '';
  const worktrees = yield* sql.unsafe<{readonly worktree_id: string; readonly scope_id?: string}>(
    `SELECT active_snapshots.worktree_id ${scoped ? ', active_snapshots.scope_id' : ''}
     FROM active_snapshots
     JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
     JOIN repositories ON repositories.id = snapshots.repository_id
     WHERE snapshots.state = 'ready'
       ${
         removedViewsAvailable
           ? `AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active_snapshots.worktree_id
                  ${scoped ? 'AND removed.scope_id = active_snapshots.scope_id' : ''}
                  AND removed.expected_snapshot_id = active_snapshots.snapshot_id
              )`
           : ''
       }
       ${viewPredicate}
     ORDER BY active_snapshots.activated_at DESC, active_snapshots.worktree_id
     LIMIT ? OFFSET ?`,
    [...(scoped ? scopeIds : []), ...(viewQuery.length === 0 ? [] : [viewQuery]), viewLimit, viewOffset],
  );
  return (yield* Effect.forEach(
    worktrees,
    row => selectVisualizationCatalog(row.worktree_id, metrics, {...options, scopeId: row.scope_id}),
    {
      concurrency: 1,
    },
  )).flatMap(catalog => (catalog ? [catalog] : []));
});

const selectVisualizationScopeEdges = Effect.fn('codeGraph.selectVisualizationScopeEdges')(function* (
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const hasWorkspaceCatalog =
    (yield* tableExists(sql, 'workspace_components')) &&
    Number(
      (yield* sql<{readonly count: number}>`
          SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ${snapshotId}
        `)[0]?.count ?? 0,
    ) > 0;
  const persisted = yield* selectPersistedSnapshotComponentEdges(snapshotId);
  let sourceRelationships = Option.getOrElse(persisted, () => [] as readonly CodeGraphVisualizationScopeEdge[]);
  if (Option.isNone(persisted)) {
    const snapshotRows = yield* sql<{readonly edge_count: number}>`
      SELECT edge_count FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
    `;
    const edgeCount = Number(snapshotRows[0]?.edge_count ?? Number.MAX_SAFE_INTEGER);
    // Compatibility-only exact fallback for old small snapshots. Production
    // graphs stay bounded and partial until the post-ready aggregate receipt
    // is built rather than running an unbounded GROUP BY in a Manager read.
    if (Number.isSafeInteger(edgeCount) && edgeCount >= 0 && edgeCount <= 25_000) {
      const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
      const graphRows = yield* sql.unsafe<{
        readonly confidence: number;
        readonly count: number;
        readonly provenance: CodeGraphProvenance;
        readonly relation: CodeGraphEdge['relation'];
        readonly source_scope_id: string;
        readonly target_scope_id: string;
      }>(
        `${effectiveGraphCtes()}
         , scoped_symbols AS (
           SELECT id,
             ${hasWorkspaceCatalog ? "CASE WHEN resolution_scope_id IS NOT NULL THEN resolution_scope_id WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'facet:unscoped-documentation' WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package:' || package_name WHEN instr(path, '/') > 0 THEN 'path:' || substr(path, 1, instr(path, '/') - 1) ELSE 'path:(root)' END" : "CASE WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package:' || package_name WHEN instr(path, '/') > 0 THEN 'path:' || substr(path, 1, instr(path, '/') - 1) ELSE 'path:(root)' END"} AS scope_id
           FROM effective_symbols
         )
         SELECT source.scope_id AS source_scope_id, target.scope_id AS target_scope_id,
           edge.provenance, edge.relation, COUNT(*) AS count, MAX(edge.confidence) AS confidence
         FROM effective_edges AS edge
         JOIN scoped_symbols AS source ON source.id = edge.source_id
         JOIN scoped_symbols AS target ON target.id = edge.target_id
         WHERE source.scope_id IS NOT NULL AND target.scope_id IS NOT NULL
           AND source.scope_id <> target.scope_id
         GROUP BY source.scope_id, target.scope_id, edge.provenance, edge.relation
         ORDER BY source.scope_id, target.scope_id, edge.provenance, edge.relation`,
        effectiveGraphParameters(snapshotId, baseSnapshotId),
      );
      sourceRelationships = graphRows.map(row => ({
        confidence: Number(row.confidence),
        count: Number(row.count),
        provenance: row.provenance,
        relation: row.relation,
        sourceId: row.source_scope_id,
        targetId: row.target_scope_id,
        type: 'source-relationship',
      }));
    }
  }
  if (!hasWorkspaceCatalog) return sourceRelationships;
  const dependencies = yield* sql<{
    readonly provenance: CodeGraphWorkspaceProvenance;
    readonly source_component_id: string;
    readonly target_component_id: string;
  }>`
    SELECT source_component_id, target_component_id, provenance
    FROM workspace_component_dependencies
    WHERE snapshot_id = ${snapshotId}
    ORDER BY source_component_id, target_component_id, provenance
  `;
  return [
    ...dependencies.map(
      dependency =>
        ({
          confidence: 1,
          count: 1,
          provenance: 'declared',
          relation: 'depends_on',
          sourceId: dependency.source_component_id,
          targetId: dependency.target_component_id,
          type: 'declared-build-dependency',
        }) satisfies CodeGraphVisualizationScopeEdge,
    ),
    ...sourceRelationships,
  ];
});

interface VisualizationScopeSampledSymbolRow extends SymbolRow {
  readonly sampled_scope_id: string;
}

interface VisualizationScopeSampledEdgeRow extends EdgeRow {
  readonly sampled_scope_id: string;
}

const selectVisualizationScopeEdgeSummary = Effect.fn('codeGraph.selectVisualizationScopeEdgeSummary')(function* (
  snapshotId: string,
  requestedScopeIds: readonly string[],
  limit: number,
) {
  const safeLimit = Math.max(1, Math.min(1_500, Math.floor(limit)));
  const scopeIds = [...new Set(requestedScopeIds)].slice(0, MANAGER_SCOPE_SAMPLE_MAX_SCOPES).sort(compareCodeUnits);
  if (scopeIds.length === 0) return {edges: [], sampledScopes: 0, truncated: false};
  const scopeSet = new Set(scopeIds);
  const perScopeEdgeLimit = Math.max(2, Math.min(16, Math.ceil(safeLimit / scopeIds.length) * 2));
  let truncated = requestedScopeIds.length > scopeIds.length;
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const symbolRows: VisualizationScopeSampledSymbolRow[] = [];
  for (const statement of codeGraphVisualizationScopeSymbolSampleStatements(
    snapshotId,
    baseSnapshotId,
    scopeIds,
    MANAGER_SCOPE_SAMPLE_SYMBOLS_PER_SCOPE + 1,
  )) {
    symbolRows.push(...(yield* sql.unsafe<VisualizationScopeSampledSymbolRow>(statement.text, statement.parameters)));
  }
  const seedsByScope = new Map<string, string[]>();
  for (const row of symbolRows) {
    const seeds = seedsByScope.get(row.sampled_scope_id) ?? [];
    if (seeds.length < MANAGER_SCOPE_SAMPLE_SYMBOLS_PER_SCOPE) seeds.push(row.id);
    else truncated = true;
    seedsByScope.set(row.sampled_scope_id, seeds);
  }
  const sampledScopes = seedsByScope.size;
  const sampledEdges = new Map<string, CodeGraphEdge>();
  const edgeRows: VisualizationScopeSampledEdgeRow[] = [];
  for (const statement of codeGraphVisualizationScopeEdgeSampleStatements(
    snapshotId,
    baseSnapshotId,
    [...seedsByScope].map(([scopeId, symbolIds]) => ({scopeId, symbolIds})),
    perScopeEdgeLimit + 1,
    MANAGER_SCOPE_SAMPLE_PROVENANCES,
  )) {
    edgeRows.push(...(yield* sql.unsafe<VisualizationScopeSampledEdgeRow>(statement.text, statement.parameters)));
  }
  const edgeCountsByScope = new Map<string, number>();
  for (const row of edgeRows) {
    const edgeCount = edgeCountsByScope.get(row.sampled_scope_id) ?? 0;
    if (edgeCount < perScopeEdgeLimit) sampledEdges.set(row.id, edgeFromRow(row));
    else truncated = true;
    edgeCountsByScope.set(row.sampled_scope_id, edgeCount + 1);
  }
  const endpointIds = [...new Set([...sampledEdges.values()].flatMap(edge => [edge.sourceId, edge.targetId]))].filter(
    isDefinedString,
  );
  let endpointRows: readonly VisualizationScopeEndpointRow[] = [];
  if (endpointIds.length > 0) {
    const statement = codeGraphVisualizationScopeEndpointStatement(snapshotId, baseSnapshotId, endpointIds);
    endpointRows = yield* sql.unsafe<VisualizationScopeEndpointRow>(statement.text, statement.parameters);
  }
  const symbolsById = new Map(
    endpointRows.map(row => [
      row.id,
      {
        id: row.id,
        kind: row.kind,
        language: row.language,
        packageName: Option.getOrUndefined(sqlTextOption(row.package_name)),
        path: row.path,
        resolutionScopeId: Option.getOrUndefined(sqlTextOption(row.resolution_scope_id)),
      },
    ]),
  );
  const aggregated = new Map<string, CodeGraphVisualizationScopeEdge>();
  for (const edge of sampledEdges.values()) {
    if (!edge.sourceId || !edge.targetId) continue;
    const source = symbolsById.get(edge.sourceId);
    const target = symbolsById.get(edge.targetId);
    if (!source || !target) continue;
    const sourceId = visualizationScopeIdForSymbol(source, scopeSet);
    const targetId = visualizationScopeIdForSymbol(target, scopeSet);
    if (!sourceId || !targetId || sourceId === targetId || !scopeSet.has(sourceId) || !scopeSet.has(targetId)) continue;
    const key = `${sourceId}\0${targetId}\0${edge.provenance}\0${edge.relation}`;
    const current = aggregated.get(key);
    aggregated.set(key, {
      confidence: Math.max(current?.confidence ?? 0, edge.confidence),
      count: (current?.count ?? 0) + 1,
      provenance: edge.provenance,
      relation: edge.relation,
      sourceId,
      targetId,
      type: 'source-relationship',
    });
  }
  const ordered = [...aggregated.values()].sort(compareVisualizationScopeEdges);
  if (ordered.length > safeLimit) truncated = true;
  return {edges: ordered.slice(0, safeLimit), sampledScopes, truncated};
});

export function codeGraphVisualizationScopeSymbolSampleStatements(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  requestedScopeIds: readonly string[],
  perScopeLimit: number,
): readonly CodeGraphSqlQueryStatement[] {
  const safeScopeIds = [...new Set(requestedScopeIds)].slice(0, MANAGER_SCOPE_SAMPLE_MAX_SCOPES).sort(compareCodeUnits);
  return [...chunk(safeScopeIds, MANAGER_SCOPE_SAMPLE_BATCH_SIZE)].map(scopeBatch => {
    const branches: string[] = [];
    const parameters: Array<number | string> = [];
    for (const scopeId of scopeBatch) {
      const statement = codeGraphVisualizationSymbolsQueryStatement(
        snapshotId,
        baseSnapshotId,
        visualizationScopeFromProjectId(scopeId),
        perScopeLimit,
      );
      branches.push(`SELECT ? AS sampled_scope_id, sampled.* FROM (${statement.text}) AS sampled`);
      parameters.push(scopeId, ...statement.parameters);
    }
    return {parameters, text: branches.join('\nUNION ALL\n')};
  });
}

export function codeGraphVisualizationScopeEdgeSampleStatements(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  requestedScopes: readonly {readonly scopeId: string; readonly symbolIds: readonly string[]}[],
  perScopeLimit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
): readonly CodeGraphSqlQueryStatement[] {
  const safeScopes = requestedScopes
    .filter(scope => scope.symbolIds.length > 0)
    .slice(0, MANAGER_SCOPE_SAMPLE_MAX_SCOPES)
    .sort((left, right) => compareCodeUnits(left.scopeId, right.scopeId));
  return [...chunk(safeScopes, MANAGER_SCOPE_SAMPLE_BATCH_SIZE)].map(scopeBatch => {
    const branches: string[] = [];
    const parameters: Array<number | string> = [];
    for (const scope of scopeBatch) {
      const statement = codeGraphAdjacencyQueryStatement(
        snapshotId,
        baseSnapshotId,
        scope.symbolIds,
        'both',
        perScopeLimit,
        allowedProvenances,
      );
      branches.push(`SELECT ? AS sampled_scope_id, sampled.* FROM (${statement.text}) AS sampled`);
      parameters.push(scope.scopeId, ...statement.parameters);
    }
    return {parameters, text: branches.join('\nUNION ALL\n')};
  });
}

const selectVisualizationSymbols = Effect.fn('codeGraph.selectVisualizationSymbols')(function* (
  snapshotId: string,
  scope: CodeGraphVisualizationScope,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const statement = codeGraphVisualizationSymbolsQueryStatement(snapshotId, baseSnapshotId, scope, limit);
  const rows = yield* sql.unsafe<SymbolRow>(statement.text, statement.parameters);
  return rows.map(symbolFromRow);
});

export {
  selectVisualizationCatalog,
  VisualizationScopeSampledSymbolRow,
  VisualizationScopeSampledEdgeRow,
  selectVisualizationCatalogs,
  selectVisualizationScopeEdges,
  selectVisualizationScopeEdgeSummary,
  selectVisualizationSymbols,
};
