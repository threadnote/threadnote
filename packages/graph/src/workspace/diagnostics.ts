import {Array as EffectArray} from 'effect';
import type {CodeGraphWorkspaceProject} from '../languages/types.js';
import {uniqueStrings} from './primitives.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_WORKSPACE_DIAGNOSTIC_LIMIT = 100;
export const CODE_GRAPH_WORKSPACE_DIAGNOSTIC_OVERFLOW =
  'Workspace discovery omitted unattributed diagnostics after its deterministic bound.';

export function codeGraphWorkspaceDiagnosticBlocksCompleteness(diagnostic: string): boolean {
  return !Effect.pipe(diagnostic, EffectString.includes('cannot form a package moniker'));
}

export function collapseCodeGraphWorkspaceDiagnosticClasses(
  diagnostics: readonly string[],
  limit = CODE_GRAPH_WORKSPACE_DIAGNOSTIC_LIMIT,
): readonly string[] {
  const groups = new Map<string, string[]>();
  for (const diagnostic of uniqueStrings(diagnostics)) {
    const separator = Effect.pipe(
      diagnostic,
      EffectString.indexOf(': '),
      Effect.Option.getOrElse(() => -1),
    );
    const diagnosticClass = separator < 0 ? diagnostic : Effect.pipe(diagnostic, EffectString.slice(separator + 2));
    const group = groups.get(diagnosticClass);
    if (group === undefined) groups.set(diagnosticClass, [diagnostic]);
    else group.push(diagnostic);
  }
  return EffectArray.map([...groups.values()], group =>
    group.length === 1 ? group[0] : `${group[0]} (${group.length} occurrences)`,
  ).slice(0, limit);
}

export interface CodeGraphWorkspaceDiagnosticIndex {
  readonly projectsByPrefix: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
}

export interface CodeGraphWorkspaceDiagnosticResolution {
  readonly diagnostics: readonly string[];
  readonly projects: readonly CodeGraphWorkspaceProject[];
  readonly projectsByDiagnostic: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
}

export function createCodeGraphWorkspaceDiagnosticIndex(
  projects: readonly CodeGraphWorkspaceProject[],
): CodeGraphWorkspaceDiagnosticIndex {
  const projectsByPrefix = new Map<string, CodeGraphWorkspaceProject[]>();
  for (const project of projects) {
    for (const prefix of uniqueStrings([project.root, ...project.sourceRoots])) {
      const matches = projectsByPrefix.get(prefix);
      if (matches === undefined) projectsByPrefix.set(prefix, [project]);
      else matches.push(project);
    }
  }
  return {projectsByPrefix};
}

export function codeGraphWorkspaceProjectsForDiagnostic(
  index: CodeGraphWorkspaceDiagnosticIndex,
  diagnostic: string,
): readonly CodeGraphWorkspaceProject[] {
  const evidencePath = codeGraphWorkspaceDiagnosticEvidencePath(diagnostic);
  if (evidencePath === undefined) return [];
  for (let prefix = evidencePath; ;) {
    const matches = index.projectsByPrefix.get(prefix);
    if (matches !== undefined) return matches;
    const separator = Effect.pipe(
      prefix,
      EffectString.lastIndexOf('/'),
      Effect.Option.getOrElse(() => -1),
    );
    if (separator < 0) return index.projectsByPrefix.get('') ?? [];
    prefix = Effect.pipe(prefix, EffectString.slice(0, separator));
  }
}

export function resolveCodeGraphWorkspaceDiagnostics(
  projects: readonly CodeGraphWorkspaceProject[],
  diagnostics: readonly string[],
): CodeGraphWorkspaceDiagnosticResolution {
  const orderedDiagnostics = uniqueStrings(diagnostics);
  const index = createCodeGraphWorkspaceDiagnosticIndex(projects);
  const attributed = new Map<string, string[]>();
  const projectsByDiagnostic = new Map<string, readonly CodeGraphWorkspaceProject[]>();
  for (const diagnostic of orderedDiagnostics) {
    const matches = codeGraphWorkspaceProjectsForDiagnostic(index, diagnostic);
    projectsByDiagnostic.set(diagnostic, matches);
    for (const project of matches) {
      const values = attributed.get(project.id) ?? [];
      values.push(diagnostic);
      attributed.set(project.id, values);
    }
  }
  return {
    diagnostics: orderedDiagnostics,
    projects: EffectArray.map(projects, project => ({
      ...project,
      diagnostics: uniqueStrings([...project.diagnostics, ...(attributed.get(project.id) ?? [])]),
    })),
    projectsByDiagnostic,
  };
}

export function boundedCodeGraphWorkspaceDiagnostics(
  resolution: CodeGraphWorkspaceDiagnosticResolution,
): readonly string[] {
  const collapsed = collapseCodeGraphWorkspaceDiagnosticClasses(resolution.diagnostics);
  const retained = collapsed.slice(0, CODE_GRAPH_WORKSPACE_DIAGNOSTIC_LIMIT);
  const omittedUnattributed = EffectArray.some(
    resolution.diagnostics.slice(CODE_GRAPH_WORKSPACE_DIAGNOSTIC_LIMIT),
    diagnostic => resolution.projectsByDiagnostic.get(diagnostic)?.length === 0,
  );
  if (!omittedUnattributed) return retained;
  return uniqueStrings([
    ...retained.slice(0, CODE_GRAPH_WORKSPACE_DIAGNOSTIC_LIMIT - 1),
    CODE_GRAPH_WORKSPACE_DIAGNOSTIC_OVERFLOW,
  ]);
}

function codeGraphWorkspaceDiagnosticEvidencePath(diagnostic: string): string | undefined {
  const separator = Effect.pipe(
    diagnostic,
    EffectString.indexOf(':'),
    Effect.Option.getOrElse(() => -1),
  );
  if (separator <= 0) return undefined;
  const evidencePath = Effect.pipe(diagnostic, EffectString.slice(0, separator));
  if (
    Effect.pipe(evidencePath, EffectString.startsWith('/')) ||
    Effect.pipe(evidencePath, EffectString.includes('\\')) ||
    EffectArray.some(
      Effect.pipe(evidencePath, EffectString.split('/')),
      segment => segment === '' || segment === '.' || segment === '..',
    )
  )
    return undefined;
  return evidencePath;
}
