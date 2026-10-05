import {Effect, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {ProjectGraphManifest, ProjectManifest} from '@threadnote/workspace/config';
import type {CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import type {CodeGraphLanguagePackError, CodeGraphWorkspace, CodeGraphWorkspaceProject} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphInventoryFile} from './types.js';
import {
  codeGraphWorkspaceDiagnosticBlocksCompleteness,
  collapseCodeGraphWorkspaceDiagnosticClasses,
  codeGraphWorkspaceProjectsForDiagnostic,
  createCodeGraphWorkspaceDiagnosticIndex,
} from './workspace/diagnostics.js';

export interface CodeGraphWorkspaceCatalog {
  readonly fingerprint: string;
  readonly resolutionContextPaths: readonly string[];
  readonly workspace: CodeGraphWorkspace;
}

const WORKSPACE_CATALOG_CACHE_MAXIMUM = 8;
const WORKSPACE_CATALOG_CACHE_BYTES = 4 * 1_024 * 1_024;
const workspaceCatalogs = new WeakMap<
  CodeGraphLanguagePackRegistryShape,
  Map<string, {readonly serialized: string; readonly bytes: number}>
>();

export interface ResolvedCodeGraphIndexScope {
  readonly admittedPrefixes: readonly string[];
  readonly closureDigest: string;
  readonly completeness: 'complete' | 'partial';
  readonly controlPaths: readonly string[];
  readonly definitionDigest: string;
  readonly diagnostics: readonly string[];
  readonly includedProjectIds: readonly string[];
  readonly rootProjectIds: readonly string[];
  readonly scopeKey: string;
}

export type CodeGraphIndexScopeMembership = Pick<
  ResolvedCodeGraphIndexScope,
  'completeness' | 'includedProjectIds' | 'rootProjectIds'
>;

export const CODE_GRAPH_SCOPE_RECEIPT_IDS_MAXIMUM = 100_000;
export const CODE_GRAPH_SCOPE_RECEIPT_IDS_JSON_BYTES_MAXIMUM = 4 * 1024 * 1024;

export function canonicalCodeGraphScopeReceiptIds(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > CODE_GRAPH_SCOPE_RECEIPT_IDS_MAXIMUM ||
    value.some(id => typeof id !== 'string' || id.length === 0 || id.length > 4096 || id.includes('\0'))
  ) {
    return undefined;
  }
  const canonical = [...new Set<string>(value)].sort();
  return canonical.length === value.length ? canonical : undefined;
}

export function encodeCodeGraphScopeReceiptIds(value: readonly string[]): string | undefined {
  const canonical = canonicalCodeGraphScopeReceiptIds(value);
  if (canonical === undefined) return undefined;
  const encoded = JSON.stringify(canonical);
  return new TextEncoder().encode(encoded).byteLength <= CODE_GRAPH_SCOPE_RECEIPT_IDS_JSON_BYTES_MAXIMUM
    ? encoded
    : undefined;
}

/** Stable set identity for stale-read scope admission; excludes closure details that only require refresh. */
export function codeGraphIndexScopeMembershipDigest(scope: CodeGraphIndexScopeMembership): string {
  const canonicalIds = (values: readonly string[]) => [...new Set(values)].sort();
  return sha256HexSync(
    JSON.stringify({
      completeness: scope.completeness,
      includedProjectIds: canonicalIds(scope.includedProjectIds),
      rootProjectIds: canonicalIds(scope.rootProjectIds),
    }),
  );
}

export const CODE_GRAPH_INDEX_SCOPE_PREVIEW_VERSION = 1 as const;
export const CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY = 'full-repository' as const;

export interface CodeGraphIndexScopePreview {
  readonly scope: ResolvedCodeGraphIndexScope;
  readonly type: 'code-graph-index-scope-preview';
  readonly version: typeof CODE_GRAPH_INDEX_SCOPE_PREVIEW_VERSION;
}

export class CodeGraphIndexScopeResolutionError extends Schema.TaggedError<CodeGraphIndexScopeResolutionError>()(
  'CodeGraphIndexScopeResolutionError',
  {message: Schema.String},
) {}

export function resolveCodeGraphWorkspaceCatalog(
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
  cached?: CodeGraphWorkspaceCatalog,
): Effect.Effect<CodeGraphWorkspaceCatalog, CodeGraphLanguagePackError> {
  const contexts = files
    .filter(file => languagePacks.isResolutionContext(file.path))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const fingerprint = workspaceCatalogFingerprint(contexts);
  if (cached?.fingerprint === fingerprint) return Effect.succeed(cached);
  const retained = workspaceCatalogs.get(languagePacks);
  const previous = retained?.get(fingerprint);
  if (previous !== undefined) {
    retained!.delete(fingerprint);
    retained!.set(fingerprint, previous);
    return Effect.sync(() => JSON.parse(previous.serialized) as CodeGraphWorkspaceCatalog);
  }
  return languagePacks.discoverWorkspace(contexts).pipe(
    Effect.map(workspace => {
      const catalog = {fingerprint, resolutionContextPaths: contexts.map(file => file.path), workspace};
      const serialized = JSON.stringify(catalog);
      const bytes = serialized.length * 2;
      if (bytes <= WORKSPACE_CATALOG_CACHE_BYTES) {
        const entries =
          workspaceCatalogs.get(languagePacks) ??
          new Map<string, {readonly serialized: string; readonly bytes: number}>();
        entries.delete(fingerprint);
        entries.set(fingerprint, {serialized, bytes});
        let retainedBytes = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0);
        while (entries.size > WORKSPACE_CATALOG_CACHE_MAXIMUM || retainedBytes > WORKSPACE_CATALOG_CACHE_BYTES) {
          const oldest = entries.keys().next().value!;
          retainedBytes -= entries.get(oldest)!.bytes;
          entries.delete(oldest);
        }
        workspaceCatalogs.set(languagePacks, entries);
      }
      return catalog;
    }),
  );
}

export function resolveCodeGraphIndexScope(
  project: Pick<ProjectManifest, 'graph' | 'uri'>,
  catalog: CodeGraphWorkspaceCatalog,
): ResolvedCodeGraphIndexScope {
  const graph = project.graph;
  const allProjects = [...catalog.workspace.projects].sort(compareProjects);
  const definitionDigest = digestDefinition(graph);
  const scopeKey =
    graph === undefined ? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY : `code-graph-scope:${sha256HexSync(project.uri)}`;
  if (graph === undefined) {
    return resolvedScope({
      admittedPrefixes: [''],
      catalog,
      definitionDigest,
      diagnostics: scopeDiagnostics(catalog.workspace, allProjects),
      includedProjects: allProjects,
      rootProjectIds: [],
      scopeKey,
    });
  }

  const roots = canonicalPaths(graph.roots);
  const rootsByProjectId = new Map<string, CodeGraphWorkspaceProject>();
  for (const root of roots) {
    const matches = allProjects.filter(candidate => componentMatchesRoot(candidate, root));
    if (matches.length === 0) throw unresolvedRoot(root, allProjects);
    for (const match of matches) rootsByProjectId.set(match.id, match);
  }
  const rootProjects = [...rootsByProjectId.values()].sort(compareProjects);
  const includedProjects = forwardDependencyClosure(rootProjects, allProjects);
  const admittedPrefixes = canonicalPaths([
    ...(graph.include ?? []),
    ...includedProjects.flatMap(candidate => [candidate.root, ...candidate.sourceRoots]),
  ]);
  const selectedRoots = includedProjects.flatMap(candidate => [candidate.root, ...candidate.sourceRoots]);
  const workspaceRoots = new Set(includedProjects.flatMap(candidate => candidate.workspaceRoots));
  const controlPaths = uniqueStrings([
    ...includedProjects.flatMap(candidate =>
      candidate.dependencyDetails.flatMap(detail => (detail.evidence ? [detail.evidence] : [])),
    ),
    ...catalog.resolutionContextPaths.filter(path => {
      const directory = path.split('/').slice(0, -1).join('/');
      return selectedRoots.some(root => contextSupportsRoot(path, root)) || workspaceRoots.has(directory);
    }),
  ]);
  return resolvedScope({
    admittedPrefixes,
    catalog,
    definitionDigest,
    diagnostics: scopeDiagnostics(catalog.workspace, includedProjects, {admittedPrefixes, controlPaths}),
    includedProjects,
    rootProjectIds: rootProjects.map(candidate => candidate.id),
    scopeKey,
    controlPaths,
  });
}

export function previewCodeGraphIndexScope(
  project: Pick<ProjectManifest, 'graph' | 'uri'>,
  catalog: CodeGraphWorkspaceCatalog,
): CodeGraphIndexScopePreview {
  return {
    scope: resolveCodeGraphIndexScope(project, catalog),
    type: 'code-graph-index-scope-preview',
    version: CODE_GRAPH_INDEX_SCOPE_PREVIEW_VERSION,
  };
}

export function forwardDependencyClosure(
  roots: readonly CodeGraphWorkspaceProject[],
  projects: readonly CodeGraphWorkspaceProject[],
): readonly CodeGraphWorkspaceProject[] {
  const byId = new Map(projects.map(project => [project.id, project]));
  const visited = new Set<string>();
  const queue = [...roots].sort(compareProjects);
  while (queue.length > 0) {
    const project = queue.shift()!;
    if (visited.has(project.id)) continue;
    visited.add(project.id);
    const dependencyIds = uniqueStrings([
      ...project.dependencies,
      ...project.dependencyDetails.map(dependency => dependency.targetId),
    ]);
    for (const id of dependencyIds) {
      const target = byId.get(id);
      if (target && !visited.has(target.id)) queue.push(target);
    }
    queue.sort(compareProjects);
  }
  return [...visited].map(id => byId.get(id)!).sort(compareProjects);
}

function resolvedScope(input: {
  readonly admittedPrefixes: readonly string[];
  readonly catalog: CodeGraphWorkspaceCatalog;
  readonly controlPaths?: readonly string[];
  readonly definitionDigest: string;
  readonly diagnostics: readonly string[];
  readonly includedProjects: readonly CodeGraphWorkspaceProject[];
  readonly rootProjectIds: readonly string[];
  readonly scopeKey: string;
}): ResolvedCodeGraphIndexScope {
  const diagnostics = uniqueStrings(input.diagnostics);
  const completeness =
    diagnostics.every(diagnostic => !codeGraphWorkspaceDiagnosticBlocksCompleteness(diagnostic)) &&
    input.includedProjects.every(project => project.provenance === 'declared')
      ? 'complete'
      : 'partial';
  const controlPaths = uniqueStrings(input.controlPaths ?? input.catalog.resolutionContextPaths);
  const scope = {
    admittedPrefixes: input.admittedPrefixes,
    closureDigest: sha256HexSync(
      JSON.stringify({
        completeness,
        controlPaths,
        diagnostics,
        projects: input.includedProjects.map(project => ({
          buildSystem: project.buildSystem,
          dependencies: uniqueStrings([
            ...project.dependencies,
            ...project.dependencyDetails.map(detail => detail.targetId),
          ]),
          dependencyDetails: project.dependencyDetails.map(detail => [
            detail.targetId,
            detail.provenance,
            detail.evidence ?? '',
          ]),
          id: project.id,
          provenance: project.provenance,
          root: project.root,
          sourceRoots: canonicalPaths(project.sourceRoots),
          workspaceRoots: canonicalPaths(project.workspaceRoots),
        })),
        roots: input.rootProjectIds,
      }),
    ),
    completeness,
    controlPaths,
    definitionDigest: input.definitionDigest,
    diagnostics,
    includedProjectIds: input.includedProjects.map(project => project.id),
    rootProjectIds: input.rootProjectIds,
    scopeKey: input.scopeKey,
  } satisfies ResolvedCodeGraphIndexScope;
  if (
    encodeCodeGraphScopeReceiptIds(scope.rootProjectIds) === undefined ||
    encodeCodeGraphScopeReceiptIds(scope.includedProjectIds) === undefined
  ) {
    throw CodeGraphIndexScopeResolutionError.make({
      message: 'Selected project graph membership exceeds the supported receipt budget.',
    });
  }
  return scope;
}

function scopeDiagnostics(
  workspace: CodeGraphWorkspace,
  projects: readonly CodeGraphWorkspaceProject[],
  selected?: {readonly admittedPrefixes: readonly string[]; readonly controlPaths: readonly string[]},
): readonly string[] {
  const knownIds = new Set(workspace.projects.map(project => project.id));
  const selectedIds = new Set(projects.map(project => project.id));
  const diagnosticIndex =
    selected === undefined ? undefined : createCodeGraphWorkspaceDiagnosticIndex(workspace.projects);
  return collapseCodeGraphWorkspaceDiagnosticClasses([
    ...workspace.diagnostics.filter(diagnostic => {
      if (selected === undefined) return true;
      const attributed = codeGraphWorkspaceProjectsForDiagnostic(diagnosticIndex!, diagnostic);
      return attributed.length > 0
        ? attributed.some(project => selectedIds.has(project.id))
        : diagnosticAppliesToScope(diagnostic, selected);
    }),
    ...projects.flatMap(project => [
      ...project.diagnostics,
      ...(project.provenance === 'inferred' ? [`Component ${project.id} is inferred.`] : []),
      ...uniqueStrings([...project.dependencies, ...project.dependencyDetails.map(detail => detail.targetId)])
        .filter(dependency => !knownIds.has(dependency))
        .map(dependency => `Component ${project.id} references missing dependency ${dependency}.`),
    ]),
  ])
    .filter(diagnostic => diagnostic.length > 0)
    .slice(0, 100);
}

function diagnosticAppliesToScope(
  diagnostic: string,
  selected: {readonly admittedPrefixes: readonly string[]; readonly controlPaths: readonly string[]},
): boolean {
  const separator = diagnostic.indexOf(':');
  if (separator <= 0) return true;
  const evidencePath = diagnostic.slice(0, separator);
  if (
    evidencePath.startsWith('/') ||
    evidencePath.includes('\\') ||
    evidencePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  )
    return true;
  return (
    selected.controlPaths.includes(evidencePath) ||
    selected.admittedPrefixes.some(
      prefix => prefix === '' || evidencePath === prefix || evidencePath.startsWith(`${prefix}/`),
    )
  );
}

function workspaceCatalogFingerprint(files: readonly CodeGraphInventoryFile[]): string {
  return sha256HexSync(
    [
      'code-graph-workspace-catalog-v2',
      ...files.map(file => [file.path, file.mode, file.blobId, file.contentHash].join('\0')),
    ].join('\n'),
  );
}

function digestDefinition(graph: ProjectGraphManifest | undefined): string {
  return sha256HexSync(
    JSON.stringify(
      graph === undefined
        ? {mode: 'complete-repository'}
        : {closure: graph.closure, include: canonicalPaths(graph.include ?? []), roots: canonicalPaths(graph.roots)},
    ),
  );
}

function unresolvedRoot(
  root: string,
  projects: readonly CodeGraphWorkspaceProject[],
): CodeGraphIndexScopeResolutionError {
  const candidates = canonicalPaths(projects.flatMap(project => [project.root, ...project.sourceRoots]))
    .filter(candidate => candidate.length > 0)
    .slice(0, 5);
  const suggestion = candidates.length === 0 ? '' : ` Candidates: ${candidates.join(', ')}.`;
  return CodeGraphIndexScopeResolutionError.make({
    message: `No workspace component matches graph root "${root}".${suggestion}`,
  });
}

function componentMatchesRoot(project: CodeGraphWorkspaceProject, root: string): boolean {
  return project.root === root || project.sourceRoots.includes(root);
}

function contextSupportsRoot(path: string, root: string): boolean {
  const directory = path.split('/').slice(0, -1).join('/');
  return isPathPrefix(directory, root) || isPathPrefix(root, path);
}

function isPathPrefix(prefix: string, path: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

function canonicalPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort(compareCodeUnits);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function compareProjects(left: CodeGraphWorkspaceProject, right: CodeGraphWorkspaceProject): number {
  return (
    compareCodeUnits(left.root, right.root) ||
    compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
    compareCodeUnits(left.id, right.id)
  );
}
