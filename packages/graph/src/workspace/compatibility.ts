import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import {discoverPackages} from '../extractor.js';
import {isRepositoryFactAttributionContextPath} from '../extractor_context.js';
import {codeGraphLanguagePack as typescriptPack} from '../languages/typescript/pack.js';
import {codeGraphLanguagePack as manifestsPack} from '../languages/manifests/pack.js';
import {codeGraphLanguagePack as documentationPack} from '../languages/documentation/pack.js';
import {codeGraphLanguagePack as schemasPack} from '../languages/schemas/pack.js';
import {isXcodeAssetContentsPath} from '../languages/schemas/policy.js';
import {packCacheIdentity, type CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../types.js';
import type {WorkspaceTransitionFile} from './transition.js';
import type {CodeGraphWorkspace, CodeGraphWorkspaceProject} from '../languages/types.js';
import {compareCodeUnits} from '../ordering.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export type CodeGraphWorkspaceCompatibility =
  | {readonly mode: 'unchanged'}
  | {readonly mode: 'project-closure'; readonly seedProjectIds: readonly string[]}
  | {readonly mode: 'fallback'; readonly reason: 'workspace-changed'};

/**
 * Narrows a semantic workspace transition to stable project identities. Added
 * or removed project boundaries still fail closed because their old and new
 * ownership sets cannot yet share one bounded closure plan.
 */
export function assessCodeGraphWorkspaceCompatibility(
  base: CodeGraphWorkspace,
  current: CodeGraphWorkspace,
): CodeGraphWorkspaceCompatibility {
  if (base.fingerprint === current.fingerprint) return {mode: 'unchanged'};
  const baseProjects = uniqueProjectsById(base.projects);
  const currentProjects = uniqueProjectsById(current.projects);
  if (
    baseProjects === undefined ||
    currentProjects === undefined ||
    baseProjects.size !== currentProjects.size ||
    EffectArray.some([...baseProjects.keys()], id => !currentProjects.has(id))
  ) {
    return {mode: 'fallback', reason: 'workspace-changed'};
  }
  const seedProjectIds = EffectArray.map(
    EffectArray.filter(
      [...currentProjects],
      ([id, project]) => projectCompatibilitySurface(baseProjects.get(id)!) !== projectCompatibilitySurface(project),
    ),
    ([id]) => id,
  ).sort(compareCodeUnits);
  if (seedProjectIds.length > 0) return {mode: 'project-closure', seedProjectIds};
  return JSON.stringify(base.workspaces) === JSON.stringify(current.workspaces) &&
    JSON.stringify(base.diagnostics) === JSON.stringify(current.diagnostics)
    ? {mode: 'unchanged'}
    : {mode: 'fallback', reason: 'workspace-changed'};
}

function uniqueProjectsById(
  projects: readonly CodeGraphWorkspaceProject[],
): ReadonlyMap<string, CodeGraphWorkspaceProject> | undefined {
  const output = new Map<string, CodeGraphWorkspaceProject>();
  for (const project of projects) {
    if (output.has(project.id)) return undefined;
    output.set(project.id, project);
  }
  return output;
}

function projectCompatibilitySurface(project: CodeGraphWorkspaceProject): string {
  return JSON.stringify([
    project.id,
    project.workspaceId,
    project.buildSystem,
    project.kind,
    project.provenance,
    project.name,
    project.root,
    project.resolutionDomain,
    project.dependencies,
    project.externalDependencies ?? [],
    project.monikers ?? [],
    EffectArray.map(project.dependencyDetails, dependency => [
      dependency.targetId,
      dependency.provenance,
      dependency.evidence ?? '',
    ]),
    project.languages,
    project.sourceRoots,
    project.workspaceRoots,
    project.diagnostics,
  ]);
}

export interface WorkspaceMembershipEvidence {
  readonly basePackageNames: ReadonlyMap<string, string | null>;
  readonly currentPackageNames: ReadonlyMap<string, string | null>;
  readonly omittedPaths: ReadonlySet<string>;
}

/** Exact builtin envelope; resolver configuration outside the roster delta remains immutable. */
export function workspaceMembershipEvidence(input: {
  readonly baseFiles: readonly CodeGraphInventoryFile[];
  readonly currentFiles: readonly CodeGraphInventoryFile[];
  readonly baseWorkspace: CodeGraphWorkspace;
  readonly currentWorkspace: CodeGraphWorkspace;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
}): WorkspaceMembershipEvidence | undefined {
  const projects = [...input.baseWorkspace.projects, ...input.currentWorkspace.projects];
  if (
    EffectArray.some(
      projects,
      project => !['node', 'pnpm'].includes(project.buildSystem) || project.resolutionDomain !== 'typescript',
    )
  )
    return undefined;
  const baseByPath = new Map(EffectArray.map(input.baseFiles, file => [file.path, file]));
  const currentByPath = new Map(EffectArray.map(input.currentFiles, file => [file.path, file]));
  if (baseByPath.size !== input.baseFiles.length || currentByPath.size !== input.currentFiles.length) return undefined;
  const oldIds = new Set(EffectArray.map(input.baseWorkspace.projects, project => project.id));
  const newIds = new Set(EffectArray.map(input.currentWorkspace.projects, project => project.id));
  const added = EffectArray.filter(input.currentWorkspace.projects, project => !oldIds.has(project.id));
  const removed = EffectArray.filter(input.baseWorkspace.projects, project => !newIds.has(project.id));
  if (!added.length && !removed.length) return undefined;
  const deltaNames = new Set(EffectArray.map([...added, ...removed], project => project.name));
  for (const [workspace, files] of [
    [input.baseWorkspace, baseByPath],
    [input.currentWorkspace, currentByPath],
  ] as const) {
    for (const project of workspace.projects) {
      const manifest = files.get(project.root ? `${project.root}/package.json` : 'package.json');
      if (!manifest || parsedManifest(manifest)?.name !== project.name) return undefined;
    }
  }
  const allowedPacks = [typescriptPack, manifestsPack, documentationPack, schemasPack];
  for (const file of [...input.baseFiles, ...input.currentFiles]) {
    const match = Option.getOrUndefined(input.languagePacks.match(file.path));
    if (
      !match ||
      !allowedPacks.includes(match.pack) ||
      match.cacheIdentity !== packCacheIdentity(match.pack) ||
      Option.getOrUndefined(input.languagePacks.cacheIdentityForPath(file.path)) !== match.cacheIdentity ||
      match.language !== file.language
    )
      return undefined;
    if (
      match.pack === schemasPack &&
      (!['json', 'jsonc', 'yaml'].includes(match.language) || isXcodeAssetContentsPath(file.path))
    )
      return undefined;
    if (
      match.pack === manifestsPack &&
      !['npm-manifest', 'pnpm-workspace', 'typescript-config'].includes(match.language)
    )
      return undefined;
    if (
      isRepositoryFactAttributionContextPath(file.path) &&
      (file.content === undefined || parsedManifest(file) === undefined)
    )
      return undefined;
  }
  for (const path of new Set([...baseByPath.keys(), ...currentByPath.keys()])) {
    const before = baseByPath.get(path);
    const after = currentByPath.get(path);
    const file = after ?? before!;
    if (!input.languagePacks.isResolutionContext(path) && !isRepositoryFactAttributionContextPath(path)) continue;
    if (before && after && sameWorkspaceInventoryFile(before, after)) {
      if (
        isRepositoryFactAttributionContextPath(path) &&
        canonicalManifest(parsedManifest(before)) !== canonicalManifest(parsedManifest(after))
      )
        return undefined;
      continue;
    }
    if (file.language !== 'npm-manifest' || !/(?:^|\/)package\.json$/.test(path)) return undefined;
    const root = Effect.pipe(path, EffectString.replace(/(?:^|\/)package\.json$/, ''));
    if (!before && !EffectArray.some(added, project => project.root === root)) return undefined;
    if (!after && !EffectArray.some(removed, project => project.root === root)) return undefined;
    if (before && after) {
      const oldManifest = parsedManifest(before);
      const newManifest = parsedManifest(after);
      if (!oldManifest || !newManifest) return undefined;
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const oldDependencies = oldManifest[section];
        const newDependencies = newManifest[section];
        if (oldDependencies !== undefined && !record(oldDependencies)) return undefined;
        if (newDependencies !== undefined && !record(newDependencies)) return undefined;
        const oldValues = record(oldDependencies) ? oldDependencies : {};
        const newValues = record(newDependencies) ? newDependencies : {};
        for (const name of new Set([...EffectRecord.keys(oldValues), ...EffectRecord.keys(newValues)])) {
          if (oldValues[name] !== newValues[name] && !deltaNames.has(name)) return undefined;
        }
        delete oldManifest[section];
        delete newManifest[section];
      }
      if (canonicalManifest(oldManifest) !== canonicalManifest(newManifest)) return undefined;
    }
  }
  const namesFor = (files: readonly CodeGraphInventoryFile[]) => {
    const packages = discoverPackages(files);
    return new Map(
      EffectArray.map(files, file => {
        let directory = Effect.pipe(file.path, EffectString.includes('/'))
          ? Effect.pipe(
              file.path,
              EffectString.slice(
                0,
                Effect.pipe(
                  file.path,
                  EffectString.lastIndexOf('/'),
                  Effect.Option.getOrElse(() => -1),
                ),
              ),
            )
          : '';
        for (;;) {
          const name = packages.nameByRoot.get(directory);
          if (name !== undefined) return [file.path, name] as const;
          if (!directory) return [file.path, null] as const;
          directory = Effect.pipe(directory, EffectString.includes('/'))
            ? Effect.pipe(
                directory,
                EffectString.slice(
                  0,
                  Effect.pipe(
                    directory,
                    EffectString.lastIndexOf('/'),
                    Effect.Option.getOrElse(() => -1),
                  ),
                ),
              )
            : '';
        }
      }),
    );
  };
  const basePackageNames = namesFor(input.baseFiles);
  const currentPackageNames = namesFor(input.currentFiles);
  // Builtin object configs emit local contains/documents edges and generic
  // symbol keys, never TypeScript aliases. Resource-value paths were excluded
  // above; stable repository attribution therefore makes these pages inert.
  const omittedPaths = new Set<string>();
  for (const before of input.baseFiles) {
    const after = currentByPath.get(before.path);
    const match = Option.getOrUndefined(input.languagePacks.match(before.path));
    if (
      after &&
      sameWorkspaceInventoryFile(before, after) &&
      match?.pack === schemasPack &&
      basePackageNames.get(before.path) === currentPackageNames.get(before.path)
    )
      omittedPaths.add(before.path);
  }
  return {basePackageNames, currentPackageNames, omittedPaths};
}

export function sameWorkspaceInventoryFile(before: CodeGraphInventoryFile, after: CodeGraphInventoryFile): boolean {
  return (
    before.contentHash === after.contentHash &&
    before.language === after.language &&
    before.mode === after.mode &&
    before.size === after.size
  );
}

/** Includes every emitted ordinary domain; workspace references are separately proven unscoped. */
export function workspaceTransitionFileEvidence(
  file: CodeGraphInventoryFile,
  facts: CodeGraphFileFacts | undefined,
  packageName: string | null,
): WorkspaceTransitionFile | undefined {
  const domains = new Set<string>();
  let hasWorkspacePackageSymbol = false;
  if (facts === undefined) {
    // Only the builtin unchanged object-config certificate may take this branch.
    domains.add('generic');
    domains.add('documentation');
  } else {
    for (const symbol of facts.symbols) {
      if (symbol.resolutionDomain === 'workspace') {
        if (symbol.kind !== 'package') return undefined;
        hasWorkspacePackageSymbol = true;
      } else domains.add(symbol.resolutionDomain ?? 'generic');
    }
    for (const reference of facts.references ?? []) {
      // The adapter requires every project to have the TypeScript domain, so
      // workspace depends_on references never acquire workspace project scopes.
      if (reference.resolutionDomain !== 'workspace') domains.add(reference.resolutionDomain);
    }
  }
  if (EffectArray.some([...domains], domain => !['typescript', 'generic', 'documentation', 'global'].includes(domain)))
    return undefined;
  return {
    path: file.path,
    size: file.size,
    resolutionDomains: [...domains].sort(compareCodeUnits),
    provenUnownedResolutionDomains: EffectArray.filter([...domains], domain => domain !== 'typescript').sort(
      compareCodeUnits,
    ),
    hasWorkspacePackageSymbol,
    repositoryPackageName: packageName,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
function parsedManifest(file: CodeGraphInventoryFile): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(file.content!);
    return record(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function canonicalManifest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    EffectArray.isArray(item)
      ? EffectArray.map(item, canonical)
      : record(item)
        ? EffectRecord.fromEntries(
            EffectArray.map(
              EffectRecord.toEntries(item).sort(([a], [b]) => compareCodeUnits(a, b)),
              ([key, entry]) => [key, canonical(entry)],
            ),
          )
        : item;
  return JSON.stringify(canonical(value));
}
