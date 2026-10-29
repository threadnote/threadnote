import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {
  CodeGraphBuildWorkspace,
  CodeGraphWorkspaceBuildSystem,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceProject,
  CodeGraphWorkspaceProvenance,
} from '../languages/types.js';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphInventoryFile} from '../types.js';
import type {CodeGraphExternalDependencyV1} from '../cross_repository/types.js';
import type {CodeGraphSpan} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface ProjectCandidate {
  readonly aliases: readonly string[];
  readonly buildSystem: CodeGraphWorkspaceBuildSystem;
  readonly dependencyAliases: readonly string[];
  readonly dependencyEvidence?: ReadonlyMap<string, string>;
  readonly diagnostics: readonly string[];
  readonly evidence?: string;
  readonly externalDependencies?: readonly CodeGraphExternalDependencyV1[];
  /** Optional identity discriminator for multiple typed components at one root. */
  readonly identityKey?: string;
  readonly kind: CodeGraphWorkspaceComponentKind;
  readonly languages: readonly string[];
  readonly name: string;
  readonly packageNameSpan?: CodeGraphSpan;
  readonly packageNameDeclared?: boolean;
  readonly packageNameRegistryValid?: boolean;
  readonly packageVersion?: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly resolutionDomain: string;
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
}

export interface WorkspaceFileIndex {
  readonly buildFileByRoot: ReadonlyMap<string, CodeGraphInventoryFile>;
  readonly fileByPath: ReadonlyMap<string, CodeGraphInventoryFile>;
  readonly sortedPaths: readonly string[];
}

export function basename(path: string): string {
  return Effect.pipe(path, EffectString.split('/')).at(-1) ?? path;
}

export function dirname(path: string): string {
  return EffectArray.join(Effect.pipe(path, EffectString.split('/')).slice(0, -1), '/');
}

export function joinPath(...components: readonly string[]): string {
  return Effect.pipe(
    EffectArray.join(EffectArray.filter(components, Boolean), '/'),
    EffectString.replace(/\/+/g, '/'),
    EffectString.replace(/^\.\//, ''),
  );
}

export function materializeBuildWorkspaces(
  projects: readonly CodeGraphWorkspaceProject[],
  workspaceDiagnostics: readonly string[],
): readonly CodeGraphBuildWorkspace[] {
  const output = new Map<string, CodeGraphBuildWorkspace>();
  for (const project of projects) {
    const root = project.workspaceRoots[0] ?? project.root;
    const existing = output.get(project.workspaceId);
    output.set(project.workspaceId, {
      buildSystem: project.buildSystem,
      diagnostics: unique([...(existing?.diagnostics ?? []), ...project.diagnostics]).sort(compareCodeUnits),
      id: project.workspaceId,
      name: existing?.name ?? (root === '' ? project.name : basename(root)),
      provenance: existing?.provenance === 'declared' || project.provenance === 'declared' ? 'declared' : 'inferred',
      root,
    });
  }
  const ordered = [...output.values()].sort(
    (left, right) => compareCodeUnits(left.root, right.root) || compareCodeUnits(left.id, right.id),
  );
  if (ordered[0] && workspaceDiagnostics.length > 0) {
    ordered[0] = {
      ...ordered[0],
      diagnostics: unique([...ordered[0].diagnostics, ...workspaceDiagnostics])
        .sort(compareCodeUnits)
        .slice(0, 100),
    };
  }
  return ordered;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function normalizeContainedPath(root: string, relative: string): string | undefined {
  const output: string[] = root ? [...Effect.pipe(root, EffectString.split('/'))] : [];
  for (const segment of Effect.pipe(relative, EffectString.replaceAll('\\', '/'), EffectString.split('/'))) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (output.length === 0) return undefined;
      output.pop();
    } else {
      output.push(segment);
    }
  }
  return EffectArray.join(output, '/');
}

export function relativeContainedPath(parent: string, child: string): string | undefined {
  if (parent === '') return child;
  if (child === parent) return '';
  return Effect.pipe(child, EffectString.startsWith(`${parent}/`))
    ? Effect.pipe(child, EffectString.slice(parent.length + 1))
    : undefined;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function uniqueStrings(values: readonly string[]): string[] {
  return unique(values).sort(compareCodeUnits);
}

export function workspaceIdentity(buildSystem: CodeGraphWorkspaceBuildSystem, root: string): string {
  return `cgw_${Effect.pipe(sha256HexSync(`workspace-v1\n${buildSystem}\n${root}`), EffectString.slice(0, 32))}`;
}
