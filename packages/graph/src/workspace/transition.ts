import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import type {CodeGraphBuildWorkspace, CodeGraphWorkspace, CodeGraphWorkspaceProject} from '../languages/types.js';
import {compareCodeUnits} from '../ordering.js';
import {codeGraphPackageMoniker} from '../cross_repository/monikers.js';
import {
  PROJECT_INCREMENTAL_CLOSURE_MAX_FILES,
  PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES,
} from '../incremental/closure.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export type WorkspaceTransitionFallbackReason =
  | 'workspace-diagnostics'
  | 'unsupported-roster-change'
  | 'unrelated-workspace-change'
  | 'incomplete-project-model'
  | 'duplicate-project-id'
  | 'invalid-path'
  | 'incomplete-domain-evidence'
  | 'ambiguous-owner'
  | 'unowned-path'
  | 'incomplete-inventory'
  | 'closure-over-budget';

export interface WorkspaceTransitionFile {
  readonly path: string;
  readonly size: number;
  /** Every ordinary resolver domain whose file facts can acquire project ownership. */
  readonly resolutionDomains: readonly string[];
  /** This file contains a package symbol in the workspace domain. */
  readonly hasWorkspacePackageSymbol: boolean;
  /** Explicit absence of an ordinary owner, certified by the evidence adapter. */
  readonly provenUnownedResolutionDomains?: readonly string[];
  /** Repository attribution applies even to symbols without a project resolver owner. */
  readonly repositoryPackageName?: string | null;
}

export interface WorkspaceTransitionSide {
  readonly workspace: CodeGraphWorkspace;
  readonly files: readonly WorkspaceTransitionFile[];
  readonly inventoryComplete: boolean;
}

export interface WorkspaceTransitionInput {
  readonly base: WorkspaceTransitionSide;
  readonly current: WorkspaceTransitionSide;
  /** Caller-supplied proof precondition for unchanged resolver/extractor/domain configuration. */
  readonly resolverExtractorContextUnchanged: boolean;
  readonly maxFiles?: number;
  readonly maxSourceBytes?: number;
}

export type WorkspaceTransition =
  | {readonly mode: 'fallback'; readonly reason: WorkspaceTransitionFallbackReason}
  | {readonly mode: 'unchanged'}
  | {
      readonly mode: 'eligible';
      readonly version: 1;
      readonly addedProjectIds: readonly string[];
      readonly removedProjectIds: readonly string[];
      readonly addedWorkspaceIds: readonly string[];
      readonly removedWorkspaceIds: readonly string[];
      readonly semanticChangedProjectIds: readonly string[];
      readonly baseProjectIds: readonly string[];
      readonly currentProjectIds: readonly string[];
      readonly baseAffectedPaths: readonly string[];
      readonly currentAffectedPaths: readonly string[];
      readonly ownerChangedPaths: readonly string[];
      readonly baseProjectClosureIds: readonly string[];
      readonly currentProjectClosureIds: readonly string[];
      readonly sourceBytes: number;
    };

/** Pure structural classifier and bounded owner/dependency footprint planner. */
export function classifyWorkspaceTransition(input: WorkspaceTransitionInput): WorkspaceTransition {
  if (!input.resolverExtractorContextUnchanged) return fallback('unrelated-workspace-change');
  if (input.base.workspace.diagnostics.length || input.current.workspace.diagnostics.length)
    return fallback('workspace-diagnostics');
  const oldMap = projectsById(input.base.workspace.projects);
  const newMap = projectsById(input.current.workspace.projects);
  if (!oldMap || !newMap) return fallback('duplicate-project-id');
  const workspaceDelta = workspaceRosterDelta(input.base.workspace.workspaces, input.current.workspace.workspaces);
  if (!workspaceDelta) return fallback('unrelated-workspace-change');
  for (const workspace of [...input.base.workspace.workspaces, ...input.current.workspace.workspaces]) {
    if (workspace.diagnostics.length) return fallback('workspace-diagnostics');
  }
  for (const project of [...input.base.workspace.projects, ...input.current.workspace.projects]) {
    if (project.diagnostics.length || project.provenance !== 'declared' || project.buildSystem === 'inferred') {
      return fallback('incomplete-project-model');
    }
    if (
      !validRoot(project.root) ||
      EffectArray.some(project.sourceRoots, root => !validRoot(root)) ||
      EffectArray.some(project.workspaceRoots, root => !validRoot(root))
    ) {
      return fallback('invalid-path');
    }
  }
  const added = EffectArray.filter([...newMap.keys()], id => !oldMap.has(id)).sort(compareCodeUnits);
  const removed = EffectArray.filter([...oldMap.keys()], id => !newMap.has(id)).sort(compareCodeUnits);
  if (
    EffectArray.some(
      workspaceDelta.added,
      id =>
        !EffectArray.some([...newMap.values()], project => project.workspaceId === id && added.includes(project.id)),
    ) ||
    EffectArray.some(
      workspaceDelta.removed,
      id =>
        !EffectArray.some([...oldMap.values()], project => project.workspaceId === id && removed.includes(project.id)),
    ) ||
    EffectArray.some(
      [...input.base.workspace.projects],
      project => !EffectArray.some(input.base.workspace.workspaces, workspace => workspace.id === project.workspaceId),
    ) ||
    EffectArray.some(
      [...input.current.workspace.projects],
      project =>
        !EffectArray.some(input.current.workspace.workspaces, workspace => workspace.id === project.workspaceId),
    )
  ) {
    return fallback('unrelated-workspace-change');
  }
  for (const id of [...added, ...removed]) {
    const project = newMap.get(id) ?? oldMap.get(id)!;
    if (project.provenance !== 'declared' || (project.buildSystem !== 'node' && project.buildSystem !== 'pnpm')) {
      return fallback('unsupported-roster-change');
    }
  }
  const deltaPackageNames = new Set(
    EffectArray.map([...added, ...removed], id => (newMap.get(id) ?? oldMap.get(id)!).name),
  );
  const semanticChanged: string[] = [];
  for (const id of oldMap.keys()) {
    const before = oldMap.get(id)!;
    const after = newMap.get(id);
    if (!after) continue;
    if (sameProject(before, after)) continue;
    if (!sameNonDependencySurface(before, after, deltaPackageNames)) return fallback('unrelated-workspace-change');
    semanticChanged.push(id);
  }
  semanticChanged.sort(compareCodeUnits);
  if (!input.base.inventoryComplete || !input.current.inventoryComplete) return fallback('incomplete-inventory');
  const allBase = validInventory(input.base.files);
  const allCurrent = validInventory(input.current.files);
  if (!allBase || !allCurrent) return fallback('incomplete-inventory');
  const oldOwners = ownersFor(input.base.workspace.projects, allBase);
  const newOwners = ownersFor(input.current.workspace.projects, allCurrent);
  if (!oldOwners || !newOwners) return fallback('ambiguous-owner');
  const allPaths = [...new Set([...allBase.keys(), ...allCurrent.keys()])].sort(compareCodeUnits);
  const changedPaths: string[] = [];
  const packageChangedPaths = new Set<string>();
  const baseSeeds = new Set([...removed, ...semanticChanged]);
  const currentSeeds = new Set([...added, ...semanticChanged]);
  for (const path of allPaths) {
    const oldByDomain = oldOwners.get(path) ?? new Map();
    const newByDomain = newOwners.get(path) ?? new Map();
    const oldFile = allBase.get(path);
    const newFile = allCurrent.get(path);
    if (
      (oldFile &&
        oldByDomain.size + (oldFile.provenUnownedResolutionDomains?.length ?? 0) !== observedDomains(oldFile).length) ||
      (newFile &&
        newByDomain.size + (newFile.provenUnownedResolutionDomains?.length ?? 0) !== observedDomains(newFile).length)
    )
      return fallback('unowned-path');
    if (oldFile && newFile && stableJson(oldFile.resolutionDomains) !== stableJson(newFile.resolutionDomains))
      return fallback('incomplete-domain-evidence');
    if (
      oldFile &&
      newFile &&
      (oldFile.repositoryPackageName !== undefined || newFile.repositoryPackageName !== undefined)
    ) {
      if (oldFile.repositoryPackageName === undefined || newFile.repositoryPackageName === undefined)
        return fallback('incomplete-domain-evidence');
      if (oldFile.repositoryPackageName !== newFile.repositoryPackageName) packageChangedPaths.add(path);
    }
    const domains = new Set([...oldByDomain.keys(), ...newByDomain.keys()]);
    const ownerDiffers = EffectArray.some(
      [...domains],
      domain => oldByDomain.get(domain)?.id !== newByDomain.get(domain)?.id,
    );
    if (ownerDiffers) {
      changedPaths.push(path);
      for (const domain of domains) {
        const oldOwner = oldByDomain.get(domain);
        const newOwner = newByDomain.get(domain);
        if (oldOwner?.id !== newOwner?.id) {
          if (oldOwner) baseSeeds.add(oldOwner.id);
          if (newOwner) currentSeeds.add(newOwner.id);
        }
      }
    }
  }
  const baseClosure = reverseClosure(input.base.workspace.projects, baseSeeds);
  const currentClosure = reverseClosure(input.current.workspace.projects, currentSeeds);
  if (!baseClosure || !currentClosure) return fallback('incomplete-project-model');
  if (
    !added.length &&
    !removed.length &&
    !workspaceDelta.added.length &&
    !workspaceDelta.removed.length &&
    !semanticChanged.length &&
    !changedPaths.length &&
    !packageChangedPaths.size
  )
    return {mode: 'unchanged'};
  const baseAffected = EffectArray.filter(
    allPaths,
    (path, __effectArrayIndex4) =>
      __effectArrayIndex4 in allPaths &&
      (packageChangedPaths.has(path) ||
        EffectArray.some(
          [...(oldOwners.get(path)?.values() ?? [])],
          __effectArrayValue => !!(owner => baseSeedsForPath(owner, baseClosure))(__effectArrayValue),
        )),
  );
  const currentAffected = EffectArray.filter(
    allPaths,
    (path, __effectArrayIndex4) =>
      __effectArrayIndex4 in allPaths &&
      (packageChangedPaths.has(path) ||
        EffectArray.some(
          [...(newOwners.get(path)?.values() ?? [])],
          __effectArrayValue => !!(owner => baseSeedsForPath(owner, currentClosure))(__effectArrayValue),
        )),
  );
  const affected = [...new Set([...baseAffected, ...currentAffected, ...changedPaths])].sort(compareCodeUnits);
  const maxFiles = input.maxFiles ?? PROJECT_INCREMENTAL_CLOSURE_MAX_FILES;
  const maxBytes = input.maxSourceBytes ?? PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES;
  if (
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 0 ||
    maxFiles > PROJECT_INCREMENTAL_CLOSURE_MAX_FILES ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES
  )
    return fallback('closure-over-budget');
  let sourceBytes = 0;
  for (const path of affected) {
    sourceBytes += Math.max(allCurrent.get(path)?.size ?? 0, allBase.get(path)?.size ?? 0);
    if (!Number.isSafeInteger(sourceBytes)) return fallback('closure-over-budget');
  }
  if (affected.length > maxFiles || sourceBytes > maxBytes) return fallback('closure-over-budget');
  return {
    mode: 'eligible',
    version: 1,
    addedProjectIds: added,
    removedProjectIds: removed,
    addedWorkspaceIds: workspaceDelta.added,
    removedWorkspaceIds: workspaceDelta.removed,
    semanticChangedProjectIds: semanticChanged,
    baseProjectIds: [...baseSeeds].sort(compareCodeUnits),
    currentProjectIds: [...currentSeeds].sort(compareCodeUnits),
    baseAffectedPaths: baseAffected,
    currentAffectedPaths: currentAffected,
    ownerChangedPaths: changedPaths,
    baseProjectClosureIds: [...baseClosure].sort(compareCodeUnits),
    currentProjectClosureIds: [...currentClosure].sort(compareCodeUnits),
    sourceBytes,
  };
}

function fallback(reason: WorkspaceTransitionFallbackReason): WorkspaceTransition {
  return {mode: 'fallback', reason};
}
function projectsById(
  projects: readonly CodeGraphWorkspaceProject[],
): Map<string, CodeGraphWorkspaceProject> | undefined {
  const map = new Map<string, CodeGraphWorkspaceProject>();
  for (const project of projects) {
    if (map.has(project.id)) return undefined;
    map.set(project.id, project);
  }
  return map;
}
function validInventory(files: readonly WorkspaceTransitionFile[]): Map<string, WorkspaceTransitionFile> | undefined {
  const map = new Map<string, WorkspaceTransitionFile>();
  for (const file of files) {
    if (
      !validPath(file.path) ||
      EffectArray.some(file.resolutionDomains, domain => !domain || domain === 'workspace') ||
      new Set(file.resolutionDomains).size !== file.resolutionDomains.length ||
      typeof file.hasWorkspacePackageSymbol !== 'boolean' ||
      (file.provenUnownedResolutionDomains !== undefined &&
        (new Set(file.provenUnownedResolutionDomains).size !== file.provenUnownedResolutionDomains.length ||
          EffectArray.some(
            file.provenUnownedResolutionDomains,
            domain =>
              !['generic', 'documentation', 'global'].includes(domain) || !file.resolutionDomains.includes(domain),
          ))) ||
      (file.repositoryPackageName !== undefined &&
        file.repositoryPackageName !== null &&
        typeof file.repositoryPackageName !== 'string') ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      map.has(file.path)
    )
      return undefined;
    map.set(file.path, file);
  }
  return map;
}
function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !Effect.pipe(path, EffectString.startsWith('/')) &&
    !Effect.pipe(path, EffectString.includes('\\')) &&
    EffectArray.every(
      Effect.pipe(path, EffectString.split('/')),
      part => part.length > 0 && part !== '.' && part !== '..',
    )
  );
}
function validRoot(path: string): boolean {
  return path === '' || validPath(path);
}
function observedDomains(file: WorkspaceTransitionFile): readonly string[] {
  return file.hasWorkspacePackageSymbol ? [...file.resolutionDomains, 'workspace'] : file.resolutionDomains;
}
function workspaceRosterDelta(
  base: readonly CodeGraphBuildWorkspace[],
  current: readonly CodeGraphBuildWorkspace[],
): {readonly added: readonly string[]; readonly removed: readonly string[]} | undefined {
  const index = (items: readonly CodeGraphBuildWorkspace[]) => {
    const map = new Map<string, CodeGraphBuildWorkspace>();
    for (const item of items) {
      if (map.has(item.id)) return undefined;
      map.set(item.id, item);
    }
    return map;
  };
  const before = index(base);
  const after = index(current);
  if (!before || !after) return undefined;
  for (const id of before.keys()) {
    const oldItem = before.get(id)!;
    const newItem = after.get(id);
    if (newItem && stableJson(oldItem) !== stableJson(newItem)) return undefined;
    if (
      !newItem &&
      (oldItem.provenance !== 'declared' || (oldItem.buildSystem !== 'node' && oldItem.buildSystem !== 'pnpm'))
    )
      return undefined;
  }
  for (const id of after.keys()) {
    if (before.has(id)) continue;
    const item = after.get(id)!;
    if (item.provenance !== 'declared' || (item.buildSystem !== 'node' && item.buildSystem !== 'pnpm'))
      return undefined;
  }
  return {
    added: EffectArray.filter([...after.keys()], id => !before.has(id)).sort(compareCodeUnits),
    removed: EffectArray.filter([...before.keys()], id => !after.has(id)).sort(compareCodeUnits),
  };
}
function ownersFor(
  projects: readonly CodeGraphWorkspaceProject[],
  files: ReadonlyMap<string, WorkspaceTransitionFile>,
): Map<string, Map<string, CodeGraphWorkspaceProject>> | undefined {
  const result = new Map<string, Map<string, CodeGraphWorkspaceProject>>();
  for (const [path, file] of files) {
    const owners = new Map<string, CodeGraphWorkspaceProject>();
    for (const domain of observedDomains(file)) {
      const packagesOnly = domain === 'workspace';
      const eligible = EffectArray.filter(
        projects,
        (project, __effectArrayIndex3) =>
          __effectArrayIndex3 in projects &&
          (packagesOnly
            ? project.buildSystem === 'node' || project.buildSystem === 'pnpm'
            : project.resolutionDomain === domain ||
              (domain === 'bazel' &&
                EffectArray.some(project.languages, language => language === 'bazel' || language === 'starlark'))),
      );
      const sourceOwner = nearestOwner(eligible, path, 'sourceRoots');
      const owner = sourceOwner === 'ambiguous' ? sourceOwner : (sourceOwner ?? nearestOwner(eligible, path, 'root'));
      if (owner === 'ambiguous') return undefined;
      if (owner && file.provenUnownedResolutionDomains?.includes(domain)) return undefined;
      if (owner) owners.set(domain, owner);
    }
    result.set(path, owners);
  }
  return result;
}
function nearestOwner(
  projects: readonly CodeGraphWorkspaceProject[],
  path: string,
  rootsKind: 'root' | 'sourceRoots',
): CodeGraphWorkspaceProject | 'ambiguous' | undefined {
  const candidates = EffectArray.flatMap(projects, project => {
    const roots = rootsKind === 'root' ? [project.root] : project.sourceRoots;
    const matches = EffectArray.filter(
      roots,
      (root, __effectArrayIndex) =>
        __effectArrayIndex in roots &&
        (root === '' || path === root || Effect.pipe(path, EffectString.startsWith(`${root}/`))),
    );
    return matches.length ? [{project, depth: Math.max(...EffectArray.map(matches, root => root.length))}] : [];
  });
  const depth = Math.max(-1, ...EffectArray.map(candidates, candidate => candidate.depth));
  const nearest = EffectArray.filter(candidates, candidate => candidate.depth === depth);
  if (!nearest.length || depth < 0) return undefined;
  if (nearest.length > 1) return 'ambiguous';
  return nearest[0].project;
}
function sameProject(a: CodeGraphWorkspaceProject, b: CodeGraphWorkspaceProject): boolean {
  return stableJson(a) === stableJson(b);
}
function sameNonDependencySurface(
  a: CodeGraphWorkspaceProject,
  b: CodeGraphWorkspaceProject,
  deltaPackageNames: ReadonlySet<string>,
): boolean {
  const strip = (p: CodeGraphWorkspaceProject) => {
    const explainedDependencies = EffectArrayPipe(p.externalDependencies ?? [], __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (dependency, __effectArrayIndex2) =>
          __effectArrayIndex2 in __effectArrayValues &&
          deltaPackageNames.has(dependency.name) &&
          dependency.importAlias === dependency.name,
      ),
    );
    const explainedMonikers = new Set(
      EffectArray.flatMap(explainedDependencies, dependency => {
        try {
          return [
            stableJson(
              codeGraphPackageMoniker({
                componentId: p.id,
                dependencyKind: dependency.kind,
                evidence: {
                  path: dependency.evidence.path,
                  span: dependency.evidence.span ?? {column: 1, endColumn: 1, endLine: 1, line: 1},
                },
                packageName: dependency.name,
                packageVersion: dependency.versionConstraint,
                role: 'import',
              }),
            ),
          ];
        } catch {
          return [];
        }
      }),
    );
    return {
      ...p,
      dependencies: [],
      dependencyDetails: [],
      monikers: EffectArray.filter(p.monikers ?? [], moniker => !explainedMonikers.has(stableJson(moniker))),
      externalDependencies: EffectArray.filter(
        p.externalDependencies ?? [],
        dependency => !deltaPackageNames.has(dependency.name) || dependency.importAlias !== dependency.name,
      ),
    };
  };
  return stableJson(strip(a)) === stableJson(strip(b));
}
function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
function canonical(value: unknown): unknown {
  if (EffectArray.isArray(value))
    return EffectArray.map(value, canonical).sort((a, b) => compareCodeUnits(JSON.stringify(a), JSON.stringify(b)));
  if (value && typeof value === 'object')
    return EffectRecord.fromEntries(
      EffectArray.map(
        EffectRecord.toEntries(value).sort(([a], [b]) => compareCodeUnits(a, b)),
        ([key, item]) => [key, canonical(item)],
      ),
    );
  return value;
}
function reverseClosure(
  projects: readonly CodeGraphWorkspaceProject[],
  seeds: ReadonlySet<string>,
): Set<string> | undefined {
  const byId = projectsById(projects);
  if (!byId) return undefined;
  for (const p of projects) {
    const deps = new Set(p.dependencies);
    const details = new Set(EffectArray.map(p.dependencyDetails, d => d.targetId));
    if (
      deps.size !== p.dependencies.length ||
      deps.size !== details.size ||
      EffectArray.some([...deps], id => !details.has(id) || !byId.has(id)) ||
      EffectArray.some(p.dependencyDetails, d => d.provenance !== 'declared')
    )
      return undefined;
  }
  const closure = new Set(EffectArray.filter([...seeds], id => byId.has(id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of projects) {
      if (closure.has(p.id)) continue;
      if (
        EffectArray.some(p.dependencies, id => closure.has(id) && byId.get(id)?.resolutionDomain === p.resolutionDomain)
      ) {
        closure.add(p.id);
        changed = true;
      }
    }
  }
  return closure;
}
function baseSeedsForPath(owner: CodeGraphWorkspaceProject | undefined, closure: ReadonlySet<string>): boolean {
  return owner !== undefined && closure.has(owner.id);
}
