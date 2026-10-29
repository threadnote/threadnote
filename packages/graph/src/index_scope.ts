import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Effect, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {ProjectGraphManifest, ProjectManifest} from '@threadnote/workspace/config';
import type {CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import {CodeGraphWorkspaceSchema} from './languages/types.js';
import type {CodeGraphLanguagePackError, CodeGraphWorkspace, CodeGraphWorkspaceProject} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphInventoryFile} from './types.js';
import {
  codeGraphWorkspaceDiagnosticBlocksCompleteness,
  collapseCodeGraphWorkspaceDiagnosticClasses,
  codeGraphWorkspaceProjectsForDiagnostic,
  createCodeGraphWorkspaceDiagnosticIndex,
} from './workspace/diagnostics.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface CodeGraphWorkspaceCatalog {
  readonly fingerprint: string;
  readonly resolutionContextPaths: readonly string[];
  readonly workspace: CodeGraphWorkspace;
}

const isCodeGraphWorkspaceCatalog = Schema.is(
  Schema.Struct({
    fingerprint: Schema.String,
    resolutionContextPaths: Schema.Array(Schema.String),
    workspace: CodeGraphWorkspaceSchema,
  }),
);

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

const isCanonicalScopeReceiptIdArray = (value: unknown): value is readonly string[] =>
  EffectArray.isArray(value) &&
  EffectArray.every(
    value,
    (id): id is string =>
      typeof id === 'string' && id.length > 0 && id.length <= 4096 && !Effect2.pipe(id, EffectString.includes('\0')),
  );

export function canonicalCodeGraphScopeReceiptIds(value: unknown): readonly string[] | undefined {
  if (!isCanonicalScopeReceiptIdArray(value) || value.length > CODE_GRAPH_SCOPE_RECEIPT_IDS_MAXIMUM) {
    return undefined;
  }
  const canonical = [...new Set(value)].sort();
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

export class CodeGraphIndexScopeResolutionError extends Schema.TaggedError<
  CodeGraphIndexScopeResolutionError,
  {readonly brand: unique symbol}
>()('CodeGraphIndexScopeResolutionError', {message: Schema.String}) {}

export function resolveCodeGraphWorkspaceCatalog(
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
  cached?: CodeGraphWorkspaceCatalog,
): Effect.Effect<CodeGraphWorkspaceCatalog, CodeGraphLanguagePackError> {
  const contexts = EffectArray.filter(
    files,
    (file, __effectArrayIndex) => __effectArrayIndex in files && languagePacks.isResolutionContext(file.path),
  ).sort((left, right) => compareCodeUnits(left.path, right.path));
  const fingerprint = workspaceCatalogFingerprint(contexts);
  if (cached?.fingerprint === fingerprint) return Effect.succeed(cached);
  const retained = workspaceCatalogs.get(languagePacks);
  const previous = retained?.get(fingerprint);
  if (previous !== undefined) {
    retained!.delete(fingerprint);
    retained!.set(fingerprint, previous);
    return Effect.sync(() => {
      const catalog: unknown = JSON.parse(previous.serialized);
      if (!isCodeGraphWorkspaceCatalog(catalog)) {
        throw new Error('Cached code graph workspace catalog is invalid.');
      }
      return catalog;
    });
  }
  return languagePacks.discoverWorkspace(contexts).pipe(
    Effect.map(workspace => {
      const catalog = {fingerprint, resolutionContextPaths: EffectArray.map(contexts, file => file.path), workspace};
      const serialized = JSON.stringify(catalog);
      const bytes = serialized.length * 2;
      if (bytes <= WORKSPACE_CATALOG_CACHE_BYTES) {
        const entries =
          workspaceCatalogs.get(languagePacks) ??
          new Map<string, {readonly serialized: string; readonly bytes: number}>();
        entries.delete(fingerprint);
        entries.set(fingerprint, {serialized, bytes});
        let retainedBytes = EffectArray.reduce([...entries.values()], 0, (total, entry) => total + entry.bytes);
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
    const matches = EffectArray.filter(
      allProjects,
      (candidate, __effectArrayIndex) => __effectArrayIndex in allProjects && componentMatchesRoot(candidate, root),
    );
    if (matches.length === 0) throw unresolvedRoot(root, allProjects);
    for (const match of matches) rootsByProjectId.set(match.id, match);
  }
  const rootProjects = [...rootsByProjectId.values()].sort(compareProjects);
  const includedProjects = forwardDependencyClosure(rootProjects, allProjects);
  const admittedPrefixes = canonicalPaths([
    ...(graph.include ?? []),
    ...EffectArray.flatMap(includedProjects, candidate => [candidate.root, ...candidate.sourceRoots]),
  ]);
  const selectedRoots = EffectArray.flatMap(includedProjects, candidate => [candidate.root, ...candidate.sourceRoots]);
  const workspaceRoots = new Set(EffectArray.flatMap(includedProjects, candidate => candidate.workspaceRoots));
  const controlPaths = uniqueStrings([
    ...EffectArray.flatMap(includedProjects, candidate =>
      EffectArray.flatMap(candidate.dependencyDetails, detail => (detail.evidence ? [detail.evidence] : [])),
    ),
    ...EffectArrayPipe(catalog.resolutionContextPaths, __effectArrayValues =>
      EffectArray.filter(__effectArrayValues, (path, __effectArrayIndex) => {
        if (!(__effectArrayIndex in __effectArrayValues)) return false;
        const directory = EffectArray.join(Effect2.pipe(path, EffectString.split('/')).slice(0, -1), '/');
        return (
          EffectArray.some(selectedRoots, root => contextSupportsRoot(path, root)) || workspaceRoots.has(directory)
        );
      }),
    ),
  ]);
  return resolvedScope({
    admittedPrefixes,
    catalog,
    definitionDigest,
    diagnostics: scopeDiagnostics(catalog.workspace, includedProjects, {admittedPrefixes, controlPaths}),
    includedProjects,
    rootProjectIds: EffectArray.map(rootProjects, candidate => candidate.id),
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
  const byId = new Map(EffectArray.map(projects, project => [project.id, project]));
  const visited = new Set<string>();
  const queue = [...roots].sort(compareProjects);
  while (queue.length > 0) {
    const project = queue.shift()!;
    if (visited.has(project.id)) continue;
    visited.add(project.id);
    const dependencyIds = uniqueStrings([
      ...project.dependencies,
      ...EffectArray.map(project.dependencyDetails, dependency => dependency.targetId),
    ]);
    for (const id of dependencyIds) {
      const target = byId.get(id);
      if (target && !visited.has(target.id)) queue.push(target);
    }
    queue.sort(compareProjects);
  }
  return EffectArray.map([...visited], id => byId.get(id)!).sort(compareProjects);
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
    EffectArray.every(diagnostics, diagnostic => !codeGraphWorkspaceDiagnosticBlocksCompleteness(diagnostic)) &&
    EffectArray.every(input.includedProjects, project => project.provenance === 'declared')
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
        projects: EffectArray.map(input.includedProjects, project => ({
          buildSystem: project.buildSystem,
          dependencies: uniqueStrings([
            ...project.dependencies,
            ...EffectArray.map(project.dependencyDetails, detail => detail.targetId),
          ]),
          dependencyDetails: EffectArray.map(project.dependencyDetails, detail => [
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
    includedProjectIds: EffectArray.map(input.includedProjects, project => project.id),
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
  const knownIds = new Set(EffectArray.map(workspace.projects, project => project.id));
  const selectedIds = new Set(EffectArray.map(projects, project => project.id));
  const diagnosticIndex =
    selected === undefined ? undefined : createCodeGraphWorkspaceDiagnosticIndex(workspace.projects);
  return EffectArray.filter(
    collapseCodeGraphWorkspaceDiagnosticClasses([
      ...EffectArrayPipe(workspace.diagnostics, __effectArrayValues =>
        EffectArray.filter(__effectArrayValues, (diagnostic, __effectArrayIndex) => {
          if (!(__effectArrayIndex in __effectArrayValues)) return false;
          if (selected === undefined) return true;
          const attributed = codeGraphWorkspaceProjectsForDiagnostic(diagnosticIndex!, diagnostic);
          return attributed.length > 0
            ? EffectArray.some(attributed, project => selectedIds.has(project.id))
            : diagnosticAppliesToScope(diagnostic, selected);
        }),
      ),
      ...EffectArray.flatMap(projects, project => [
        ...project.diagnostics,
        ...(project.provenance === 'inferred' ? [`Component ${project.id} is inferred.`] : []),
        ...EffectArray.map(
          EffectArray.filter(
            uniqueStrings([
              ...project.dependencies,
              ...EffectArray.map(project.dependencyDetails, detail => detail.targetId),
            ]),
            dependency => !knownIds.has(dependency),
          ),
          dependency => `Component ${project.id} references missing dependency ${dependency}.`,
        ),
      ]),
    ]),
    diagnostic => diagnostic.length > 0,
  ).slice(0, 100);
}

function diagnosticAppliesToScope(
  diagnostic: string,
  selected: {readonly admittedPrefixes: readonly string[]; readonly controlPaths: readonly string[]},
): boolean {
  const separator = Effect2.pipe(
    diagnostic,
    EffectString.indexOf(':'),
    Effect2.Option.getOrElse(() => -1),
  );
  if (separator <= 0) return true;
  const evidencePath = Effect2.pipe(diagnostic, EffectString.slice(0, separator));
  if (
    Effect2.pipe(evidencePath, EffectString.startsWith('/')) ||
    Effect2.pipe(evidencePath, EffectString.includes('\\')) ||
    EffectArray.some(
      Effect2.pipe(evidencePath, EffectString.split('/')),
      segment => segment === '' || segment === '.' || segment === '..',
    )
  )
    return true;
  return (
    selected.controlPaths.includes(evidencePath) ||
    EffectArray.some(
      selected.admittedPrefixes,
      prefix =>
        prefix === '' || evidencePath === prefix || Effect2.pipe(evidencePath, EffectString.startsWith(`${prefix}/`)),
    )
  );
}

function workspaceCatalogFingerprint(files: readonly CodeGraphInventoryFile[]): string {
  return sha256HexSync(
    EffectArray.join(
      [
        'code-graph-workspace-catalog-v2',
        ...EffectArray.map(files, file =>
          EffectArray.join([file.path, file.mode, file.blobId, file.contentHash], '\0'),
        ),
      ],
      '\n',
    ),
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
  const candidates = EffectArray.filter(
    canonicalPaths(EffectArray.flatMap(projects, project => [project.root, ...project.sourceRoots])),
    candidate => candidate.length > 0,
  ).slice(0, 5);
  const suggestion = candidates.length === 0 ? '' : ` Candidates: ${EffectArray.join(candidates, ', ')}.`;
  return CodeGraphIndexScopeResolutionError.make({
    message: `No workspace component matches graph root "${root}".${suggestion}`,
  });
}

function componentMatchesRoot(project: CodeGraphWorkspaceProject, root: string): boolean {
  return project.root === root || project.sourceRoots.includes(root);
}

function contextSupportsRoot(path: string, root: string): boolean {
  const directory = EffectArray.join(Effect2.pipe(path, EffectString.split('/')).slice(0, -1), '/');
  return isPathPrefix(directory, root) || isPathPrefix(root, path);
}

function isPathPrefix(prefix: string, path: string): boolean {
  return prefix === '' || path === prefix || Effect2.pipe(path, EffectString.startsWith(`${prefix}/`));
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
