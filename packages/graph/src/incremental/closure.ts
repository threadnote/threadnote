import {Array as EffectArray} from 'effect';
import type {CodeGraphWorkspaceProject} from '../languages/types.js';
import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from '../fact/budget.js';
import {CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES} from './work.js';
import {compareCodeUnits} from '../ordering.js';
import {
  hasSameCodeGraphReexportResolutionSurface,
  hasSameCodeGraphResolutionSurface,
  isPublishedCodeGraphResolutionSymbol,
} from '../resolution/surface.js';
import type {
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphOverlayFallbackBoundary,
  CodeGraphProjectFileSetFallbackDetail,
  CodeGraphReference,
  CodeGraphSymbol,
} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const PROJECT_INCREMENTAL_CLOSURE_MAX_FILES = 128;
export const PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES = 16 * 1_048_576;
export const PROJECT_INCREMENTAL_CLOSURE_MAX_CACHED_FACT_BYTES = CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES;

export type ProjectIncrementalClosureFallbackReason =
  'cache-incomplete' | 'project-closure-incomplete' | 'project-closure-unbounded';

export type ProjectIncrementalClosurePlan =
  | {
      readonly affectedPaths: readonly string[];
      readonly cachedFactBytes: number;
      readonly mode: 'eligible';
      readonly planningOperations: {
        readonly dependencyEdges: number;
        readonly pathOwnershipChecks: number;
      };
      readonly projectIds: readonly string[];
      readonly sourceBytes: number;
    }
  | {
      readonly fallbackBoundary?: CodeGraphOverlayFallbackBoundary;
      readonly mode: 'fallback';
      readonly reason: ProjectIncrementalClosureFallbackReason;
    };

export interface ProjectIncrementalClosureInput {
  readonly cachedFactBytesByPath: ReadonlyMap<string, number>;
  readonly files: readonly Pick<CodeGraphInventoryFile, 'path' | 'size'>[];
  readonly maxCachedFactBytes?: number;
  readonly maxFiles?: number;
  readonly maxSourceBytes?: number;
  readonly modifiedPaths: readonly string[];
  readonly projects: readonly CodeGraphWorkspaceProject[];
  readonly seedProjectIds: readonly string[];
  readonly workspaceDiagnostics: readonly string[];
}

export type ProjectIncrementalClosureSelectionInput = Omit<
  ProjectIncrementalClosureInput,
  'cachedFactBytesByPath' | 'maxCachedFactBytes'
>;

export type ProjectIncrementalClosureSelection =
  | Omit<Extract<ProjectIncrementalClosurePlan, {readonly mode: 'eligible'}>, 'cachedFactBytes'>
  | Extract<ProjectIncrementalClosurePlan, {readonly mode: 'fallback'}>;

export type ProjectClosureSeedAssessment =
  | {
      readonly candidateLookupKeys?: readonly ProjectResolutionLookupKey[];
      readonly candidateReexports?: readonly ProjectResolutionReexportCandidate[];
      /** The changed surface has no declared project owner and must use the bounded repository candidate scan. */
      readonly candidateScanRequired?: true;
      readonly mode: 'eligible';
      readonly planningOperations: {
        readonly ownershipChecks: number;
        readonly pathIndexProjects: number;
      };
      readonly seedProjectIds: readonly string[];
      /** Resolver domains with no workspace detector; their cross-file surface uses a bounded candidate scan. */
      readonly unownedResolutionDomains?: readonly string[];
    }
  | {
      readonly fallbackDetail?: CodeGraphProjectFileSetFallbackDetail;
      readonly mode: 'fallback';
      readonly reason: 'dynamic-aliases' | 'project-closure-incomplete' | 'resolution-surface-changed';
    };

export interface ProjectResolutionLookupKey {
  readonly key: string;
  readonly resolutionDomain: string;
}

export interface ProjectResolutionReexportCandidate {
  readonly aliases: readonly ProjectResolutionLookupKey[];
  readonly candidates: readonly ProjectResolutionLookupKey[];
  readonly sourcePath: string;
}

export interface ProjectResolutionSurfacePartition {
  readonly changedCommittedFacts: readonly CodeGraphFileFacts[];
  readonly changedEffectiveFacts: readonly CodeGraphFileFacts[];
  readonly stablePaths: readonly string[];
}

/**
 * Separates existing file modifications that can be rewritten locally from
 * modifications that may change resolution in other files. Outgoing edges are
 * local to the changed file; published symbols and static re-export aliases are
 * the cross-file surface that must seed a resolver closure.
 */
export function partitionProjectResolutionSurfaceChanges(
  committedFacts: readonly CodeGraphFileFacts[],
  effectiveFacts: readonly CodeGraphFileFacts[],
): ProjectResolutionSurfacePartition | undefined {
  const committedByPath = uniqueFactsByPath(committedFacts);
  const effectiveByPath = uniqueFactsByPath(effectiveFacts);
  if (
    committedByPath === undefined ||
    effectiveByPath === undefined ||
    committedByPath.size !== effectiveByPath.size ||
    EffectArray.some([...committedByPath.keys()], path => !effectiveByPath.has(path))
  ) {
    return undefined;
  }

  const changedCommittedFacts: CodeGraphFileFacts[] = [];
  const changedEffectiveFacts: CodeGraphFileFacts[] = [];
  const stablePaths: string[] = [];
  for (const path of [...committedByPath.keys()].sort(compareCodeUnits)) {
    const committed = committedByPath.get(path)!;
    const effective = effectiveByPath.get(path)!;
    if (
      hasSameCodeGraphResolutionSurface(committed.symbols, effective.symbols) &&
      hasSameCodeGraphReexportResolutionSurface(committed.references ?? [], effective.references ?? [])
    ) {
      stablePaths.push(path);
      continue;
    }
    changedCommittedFacts.push(committed);
    changedEffectiveFacts.push(effective);
  }
  return {changedCommittedFacts, changedEffectiveFacts, stablePaths};
}

/**
 * File additions and deletions have no before/after fact pair to compare. They
 * may still use project-closure materialization when every changed path has a
 * unique owner in a complete declared dependency model. Deletions are resolved
 * against the base workspace; current additions and modifications use the
 * current workspace.
 */
export function assessProjectFileSetClosureSeeds(input: {
  readonly baseProjects: readonly CodeGraphWorkspaceProject[];
  readonly currentChangedPaths: readonly string[];
  readonly currentProjects: readonly CodeGraphWorkspaceProject[];
  readonly currentResolutionDomainByPath?: ReadonlyMap<string, string>;
  readonly deletedPaths: readonly string[];
  readonly deletedResolutionDomainByPath?: ReadonlyMap<string, string>;
}): ProjectClosureSeedAssessment {
  const baseProjectsById = uniqueProjectsById(input.baseProjects);
  const currentProjectsById = uniqueProjectsById(input.currentProjects);
  if (baseProjectsById === undefined || currentProjectsById === undefined) {
    return incompleteSeeds('duplicate-project-identity');
  }
  const seeds = new Set<string>();
  const unownedResolutionDomains = new Set<string>();
  let ownershipChecks = 0;
  const collect = (
    paths: readonly string[],
    projects: readonly CodeGraphWorkspaceProject[],
    projectsById: ReadonlyMap<string, CodeGraphWorkspaceProject>,
    resolutionDomainByPath: ReadonlyMap<string, string> | undefined,
  ): CodeGraphProjectFileSetFallbackDetail | undefined => {
    const indexesByDomain = projectPathIndexesByDomain(projects);
    for (const path of uniqueSorted(paths)) {
      let owned = false;
      // Workspace detectors can intentionally overlap the same source path in
      // metadata-only domains (for example a test tsconfig that also compiles
      // src). File-set admission must use the extractor's resolver domain;
      // ambiguity in another domain cannot affect these facts.
      const resolutionDomain = resolutionDomainByPath?.get(path);
      const domainIndexes = resolutionDomain === undefined ? undefined : indexesByDomain.get(resolutionDomain);
      if (resolutionDomain !== undefined && domainIndexes === undefined) {
        unownedResolutionDomains.add(resolutionDomain);
        continue;
      }
      const indexesForPath =
        resolutionDomain === undefined
          ? indexesByDomain
          : domainIndexes === undefined
            ? new Map<string, ProjectPathIndexes>()
            : new Map([[resolutionDomain, domainIndexes]]);
      for (const [domain, indexes] of indexesForPath) {
        ownershipChecks += 1;
        const owner = nearestProject(indexes, path);
        if (owner.mode !== 'unique') return 'path-owner-ambiguous';
        if (owner.projectId === undefined) continue;
        const project = projectsById.get(owner.projectId);
        const currentProject = currentProjectsById.get(owner.projectId);
        if (!project || !currentProject) return 'project-not-stable';
        if (
          project.resolutionDomain !== domain ||
          currentProject.resolutionDomain !== domain ||
          project.provenance !== 'declared' ||
          currentProject.provenance !== 'declared' ||
          project.buildSystem === 'inferred' ||
          currentProject.buildSystem === 'inferred' ||
          project.diagnostics.length > 0 ||
          currentProject.diagnostics.length > 0
        ) {
          return 'project-model-incomplete';
        }
        seeds.add(owner.projectId);
        owned = true;
      }
      if (!owned) return 'path-unowned';
    }
    return undefined;
  };
  const currentFailure = collect(
    input.currentChangedPaths,
    input.currentProjects,
    currentProjectsById,
    input.currentResolutionDomainByPath,
  );
  if (currentFailure !== undefined) return incompleteSeeds(currentFailure);
  const deletedFailure = collect(
    input.deletedPaths,
    input.baseProjects,
    baseProjectsById,
    input.deletedResolutionDomainByPath,
  );
  if (deletedFailure !== undefined) return incompleteSeeds(deletedFailure);
  if (seeds.size === 0 && unownedResolutionDomains.size === 0) return incompleteSeeds('no-project-seeds');
  if (EffectArray.some([...seeds], id => !baseProjectsById.has(id) || !currentProjectsById.has(id))) {
    return incompleteSeeds('project-not-stable');
  }
  const baseResolutionDomains = new Set(EffectArray.map([...seeds], id => baseProjectsById.get(id)!.resolutionDomain));
  const currentResolutionDomains = new Set(
    EffectArray.map([...seeds], id => currentProjectsById.get(id)!.resolutionDomain),
  );
  if (
    !hasCompleteDeclaredDependencyModel(input.baseProjects, baseProjectsById, baseResolutionDomains) ||
    !hasCompleteDeclaredDependencyModel(input.currentProjects, currentProjectsById, currentResolutionDomains)
  ) {
    return incompleteSeeds('dependency-model-incomplete');
  }
  return {
    mode: 'eligible',
    planningOperations: {
      ownershipChecks,
      pathIndexProjects: input.baseProjects.length + input.currentProjects.length,
    },
    seedProjectIds: [...seeds].sort(compareCodeUnits),
    ...(unownedResolutionDomains.size === 0
      ? {}
      : {unownedResolutionDomains: [...unownedResolutionDomains].sort(compareCodeUnits)}),
  };
}

export function planProjectIncrementalClosure(input: ProjectIncrementalClosureInput): ProjectIncrementalClosurePlan {
  const selection = selectProjectIncrementalClosure(input);
  if (selection.mode === 'fallback') return selection;
  const maxCachedFactBytes = input.maxCachedFactBytes ?? PROJECT_INCREMENTAL_CLOSURE_MAX_CACHED_FACT_BYTES;
  let cachedFactBytes = 0;
  for (const path of selection.affectedPaths) {
    const factBytes = input.cachedFactBytesByPath.get(path);
    if (factBytes === undefined || !Number.isSafeInteger(factBytes) || factBytes < 0) {
      return {mode: 'fallback', reason: 'cache-incomplete'};
    }
    if (factBytes > CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) {
      return unboundedPlan({
        changedFiles: new Set(input.modifiedPaths).size,
        metric: 'cached-fact-bytes',
        limit: CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
        observedAtDecision: factBytes,
        stage: 'project-closure-selection',
      });
    }
    cachedFactBytes = saturatingAdd(cachedFactBytes, factBytes);
    if (cachedFactBytes > maxCachedFactBytes) {
      return unboundedPlan({
        changedFiles: new Set(input.modifiedPaths).size,
        metric: 'cached-fact-bytes',
        limit: maxCachedFactBytes,
        observedAtDecision: cachedFactBytes,
        stage: 'project-closure-selection',
      });
    }
  }
  return {...selection, cachedFactBytes};
}

/**
 * Plans the smallest project-local resolution closure that contains every seed.
 * The planner consumes metadata only: parser facts are decoded after this result
 * has proven the bounded four-batch materialization envelope.
 */
export function selectProjectIncrementalClosure(
  input: ProjectIncrementalClosureSelectionInput,
): ProjectIncrementalClosureSelection {
  if (input.workspaceDiagnostics.length > 0) return incompletePlan();
  const projectClosure = declaredProjectResolutionClosure(input.projects, input.seedProjectIds);
  if (projectClosure === undefined) return incompletePlan();
  const {dependencyEdges, projectIds, projectsById} = projectClosure;
  const closure = new Set(projectIds);
  // Reverse dependencies never cross resolver domains. Checking ownership in
  // an unrelated workspace domain would only let overlapping metadata scopes
  // veto an otherwise complete declared closure.
  const closureResolutionDomains = new Set(EffectArray.map(projectIds, id => projectsById.get(id)!.resolutionDomain));

  const indexesByDomain = projectPathIndexesByDomain(input.projects);
  const affected = new Set(input.modifiedPaths);
  let pathOwnershipChecks = 0;
  for (const file of input.files) {
    for (const [domain, indexes] of indexesByDomain) {
      if (!closureResolutionDomains.has(domain)) continue;
      pathOwnershipChecks += 1;
      const owner = nearestProject(indexes, file.path);
      if (owner.mode === 'ambiguous') return incompletePlan();
      if (owner.projectId !== undefined && closure.has(owner.projectId)) {
        const project = projectsById.get(owner.projectId);
        if (
          !project ||
          project.resolutionDomain !== domain ||
          project.provenance !== 'declared' ||
          project.buildSystem === 'inferred' ||
          project.diagnostics.length > 0
        ) {
          return incompletePlan();
        }
        affected.add(file.path);
      }
    }
  }

  const filesByPath = new Map(EffectArray.map(input.files, file => [file.path, file]));
  const affectedPaths = [...affected].sort(compareCodeUnits);
  if (EffectArray.some(affectedPaths, path => !filesByPath.has(path))) return incompletePlan();
  const maxFiles = input.maxFiles ?? PROJECT_INCREMENTAL_CLOSURE_MAX_FILES;
  const maxSourceBytes = input.maxSourceBytes ?? PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES;
  if (affectedPaths.length > maxFiles) {
    return unboundedPlan({
      changedFiles: new Set(input.modifiedPaths).size,
      metric: 'affected-files',
      limit: maxFiles,
      observedAtDecision: affectedPaths.length,
      stage: 'project-closure-selection',
    });
  }

  let sourceBytes = 0;
  for (const path of affectedPaths) {
    const size = filesByPath.get(path)!.size;
    if (!Number.isSafeInteger(size) || size < 0) return incompletePlan();
    sourceBytes = saturatingAdd(sourceBytes, size);
    if (sourceBytes > maxSourceBytes) {
      return unboundedPlan({
        changedFiles: new Set(input.modifiedPaths).size,
        metric: 'source-bytes',
        limit: maxSourceBytes,
        observedAtDecision: sourceBytes,
        stage: 'project-closure-selection',
      });
    }
  }
  return {
    affectedPaths,
    mode: 'eligible',
    planningOperations: {dependencyEdges, pathOwnershipChecks},
    projectIds,
    sourceBytes,
  };
}

/**
 * Determines whether changed facts may expand from the changed-file resolver to
 * project closure. Committed published symbol identity is immutable while
 * present; a newly exported or removed symbol may seed its unique declared
 * resolver project when every current or prior lookup key is owned by that
 * project. A bounded candidate scan can then find consumers of removed keys
 * without rebuilding an oversized project. Unexported symbols whose
 * lookup keys are all local to their own TypeScript path are rewritten with
 * the changed file. Only arity and lookup keys owned by one declared project
 * may differ for existing published symbols. Static reexports seed their
 * owning project, while every other alias form fails closed.
 */
export function assessProjectClosureSeeds(input: {
  readonly committedFacts: readonly CodeGraphFileFacts[];
  readonly effectiveFacts: readonly CodeGraphFileFacts[];
  readonly projects: readonly CodeGraphWorkspaceProject[];
}): ProjectClosureSeedAssessment {
  const projectsById = new Map<string, CodeGraphWorkspaceProject>();
  for (const project of input.projects) {
    if (projectsById.has(project.id)) return incompleteSeeds();
    projectsById.set(project.id, project);
  }
  const indexesByDomain = projectPathIndexesByDomain(input.projects);
  const candidateLookupKeys = new Map<string, ProjectResolutionLookupKey>();
  let candidateScanRequired = false;
  let ownershipChecks = 0;

  const committedByPath = uniqueFactsByPath(input.committedFacts);
  const effectiveByPath = uniqueFactsByPath(input.effectiveFacts);
  if (
    committedByPath === undefined ||
    effectiveByPath === undefined ||
    committedByPath.size !== effectiveByPath.size ||
    EffectArray.some([...committedByPath.keys()], path => !effectiveByPath.has(path))
  ) {
    return {mode: 'fallback', reason: 'resolution-surface-changed'};
  }

  const seeds = new Set<string>();
  for (const facts of [...input.committedFacts, ...input.effectiveFacts]) {
    for (const reference of facts.references ?? []) {
      if ((reference.aliasLookupKeys?.length ?? 0) === 0) continue;
      ownershipChecks += 1;
      const project = declaredProjectForPath(
        projectsById,
        indexesByDomain,
        reference.evidencePath,
        reference.resolutionDomain,
      );
      if (
        reference.relation !== 'reexports' ||
        project.mode !== 'unique' ||
        !EffectArray.every(reference.aliasLookupKeys!, key => isOwnedLookupKey(key, project.project))
      ) {
        return {
          mode: 'fallback',
          reason: reference.relation === 'reexports' ? 'project-closure-incomplete' : 'dynamic-aliases',
        };
      }
      seeds.add(project.project.id);
    }
  }
  const changedReexports = changedReexportReferences(input.committedFacts, input.effectiveFacts);
  const candidateReexports: ProjectResolutionReexportCandidate[] = [];
  for (const reference of changedReexports) {
    const aliases = EffectArray.map(reference.aliasLookupKeys ?? [], key => ({
      key,
      resolutionDomain: lookupKeyDomain(key, reference.resolutionDomain),
    }));
    const candidates = EffectArray.map(reference.lookupTiers.flat(), key => ({
      key,
      resolutionDomain: reference.resolutionDomain,
    }));
    for (const key of reference.aliasLookupKeys ?? []) {
      addResolutionLookupKey(candidateLookupKeys, lookupKeyDomain(key, reference.resolutionDomain), key);
    }
    for (const key of reference.lookupTiers.flat()) {
      addResolutionLookupKey(candidateLookupKeys, reference.resolutionDomain, key);
    }
    candidateReexports.push({aliases, candidates, sourcePath: reference.evidencePath});
  }

  const committedSymbols = uniqueSymbols(EffectArray.flatMap(input.committedFacts, file => file.symbols));
  const effectiveSymbols = uniqueSymbols(EffectArray.flatMap(input.effectiveFacts, file => file.symbols));
  if (committedSymbols === undefined || effectiveSymbols === undefined) {
    return {mode: 'fallback', reason: 'resolution-surface-changed'};
  }
  const committedPublishedSymbols = publishedSymbols(committedSymbols);
  const effectivePublishedSymbols = publishedSymbols(effectiveSymbols);
  for (const [id, left] of committedPublishedSymbols) {
    const right = effectivePublishedSymbols.get(id);
    if (right === undefined) {
      if (isCandidateScannableUnownedSymbol(left)) {
        for (const key of left.lookupKeys ?? []) {
          addResolutionLookupKey(candidateLookupKeys, lookupKeyDomain(key, left.resolutionDomain), key);
        }
        candidateScanRequired = true;
        continue;
      }
      const project = declaredProjectForPath(projectsById, indexesByDomain, left.path, left.resolutionDomain);
      if (project.mode !== 'unique') return {mode: 'fallback', reason: 'resolution-surface-changed'};
      if (left.resolutionScopeId !== project.project.id) {
        return {mode: 'fallback', reason: 'project-closure-incomplete'};
      }
      if (EffectArray.some(left.lookupKeys ?? [], key => !isOwnedLookupKey(key, project.project))) {
        return {mode: 'fallback', reason: 'resolution-surface-changed'};
      }
      for (const key of left.lookupKeys ?? []) {
        addResolutionLookupKey(candidateLookupKeys, lookupKeyDomain(key, left.resolutionDomain), key);
      }
      ownershipChecks += 1;
      seeds.add(project.project.id);
      continue;
    }
    const candidateScannableDocumentationPair =
      isCandidateScannableUnownedSymbol(left) &&
      isCandidateScannableUnownedSymbol(right) &&
      hasSameCandidateScannableDocumentationSurface(left, right);
    if (!hasSameGlobalSymbolSurface(left, right) && !candidateScannableDocumentationPair) {
      return {mode: 'fallback', reason: 'resolution-surface-changed'};
    }
    const arityChanged = left.arity !== right.arity;
    const lookupChanged = !sameStrings(left.lookupKeys ?? [], right.lookupKeys ?? []);
    if (!arityChanged && !lookupChanged) continue;
    if (candidateScannableDocumentationPair) {
      for (const key of left.lookupKeys ?? []) {
        addResolutionLookupKey(candidateLookupKeys, lookupKeyDomain(key, left.resolutionDomain), key);
      }
      for (const key of right.lookupKeys ?? []) {
        addResolutionLookupKey(candidateLookupKeys, lookupKeyDomain(key, right.resolutionDomain), key);
      }
      candidateScanRequired = true;
      continue;
    }
    if (right.resolutionDomain === undefined) return {mode: 'fallback', reason: 'resolution-surface-changed'};
    for (const key of left.lookupKeys ?? []) {
      addResolutionLookupKey(candidateLookupKeys, lookupKeyDomain(key, left.resolutionDomain), key);
    }
    for (const key of right.lookupKeys ?? []) {
      addResolutionLookupKey(candidateLookupKeys, lookupKeyDomain(key, right.resolutionDomain), key);
    }
    ownershipChecks += 1;
    const project = declaredProjectForPath(projectsById, indexesByDomain, right.path, right.resolutionDomain);
    if (
      project.mode !== 'unique' ||
      left.resolutionScopeId !== project.project.id ||
      right.resolutionScopeId !== project.project.id
    ) {
      return {mode: 'fallback', reason: 'project-closure-incomplete'};
    }
    if (lookupChanged) {
      const leftGlobal = EffectArray.filter(left.lookupKeys ?? [], key => !isOwnedLookupKey(key, project.project));
      const rightGlobal = EffectArray.filter(right.lookupKeys ?? [], key => !isOwnedLookupKey(key, project.project));
      if (!sameStrings(leftGlobal, rightGlobal)) {
        return {mode: 'fallback', reason: 'resolution-surface-changed'};
      }
    }
    seeds.add(project.project.id);
  }
  for (const [id, right] of effectivePublishedSymbols) {
    if (committedPublishedSymbols.has(id)) continue;
    if (committedSymbols.has(id) || !right.exported) {
      return {mode: 'fallback', reason: 'resolution-surface-changed'};
    }
    if (isCandidateScannableUnownedSymbol(right)) {
      for (const key of right.lookupKeys ?? []) {
        addResolutionLookupKey(candidateLookupKeys, lookupKeyDomain(key, right.resolutionDomain), key);
      }
      candidateScanRequired = true;
      continue;
    }
    if (right.resolutionDomain === undefined) return {mode: 'fallback', reason: 'resolution-surface-changed'};
    for (const key of right.lookupKeys ?? []) {
      addResolutionLookupKey(candidateLookupKeys, lookupKeyDomain(key, right.resolutionDomain), key);
    }
    ownershipChecks += 1;
    const project = declaredProjectForPath(projectsById, indexesByDomain, right.path, right.resolutionDomain);
    if (project.mode !== 'unique') {
      return {mode: 'fallback', reason: 'resolution-surface-changed'};
    }
    if (right.resolutionScopeId !== project.project.id) {
      return {mode: 'fallback', reason: 'project-closure-incomplete'};
    }
    if (EffectArray.some(right.lookupKeys ?? [], key => !isOwnedLookupKey(key, project.project))) {
      return {mode: 'fallback', reason: 'resolution-surface-changed'};
    }
    seeds.add(project.project.id);
  }
  const seedResolutionDomains = new Set(EffectArray.map([...seeds], id => projectsById.get(id)!.resolutionDomain));
  if (!hasCompleteDeclaredDependencyModel(input.projects, projectsById, seedResolutionDomains)) {
    return incompleteSeeds();
  }
  return {
    candidateLookupKeys: [...candidateLookupKeys.values()].sort(compareResolutionLookupKeys),
    candidateReexports,
    ...(candidateScanRequired ? {candidateScanRequired: true as const} : {}),
    mode: 'eligible',
    planningOperations: {ownershipChecks, pathIndexProjects: input.projects.length},
    seedProjectIds: [...seeds].sort(compareCodeUnits),
  };
}

/**
 * Candidate scans are admitted only for resolution domains whose persisted
 * lookup keys are their complete cross-file contract. Markdown has a canonical
 * global surface; Swift and Bash use their pack-local static lookup domains.
 */
function isCandidateScannableUnownedSymbol(symbol: CodeGraphSymbol): boolean {
  if (symbol.exported !== true || symbol.resolutionScopeId !== undefined) return false;
  if (symbol.language === 'markdown' && ['document', 'heading'].includes(symbol.kind)) {
    const expected = [
      `global:qualified:${encodeURIComponent(symbol.qualifiedName)}`,
      `global:name:${encodeURIComponent(symbol.name)}`,
      ...(symbol.kind === 'document' ? [`global:path:${encodeURIComponent(symbol.path)}`] : []),
    ];
    return symbol.resolutionDomain === 'documentation' && sameStrings(symbol.lookupKeys ?? [], expected);
  }
  return (
    ['swift', 'bash'].includes(symbol.language) &&
    symbol.resolutionDomain === symbol.language &&
    (symbol.lookupKeys?.length ?? 0) > 0
  );
}

function hasSameCandidateScannableDocumentationSurface(left: CodeGraphSymbol, right: CodeGraphSymbol): boolean {
  // Persisted clean inventory deliberately omits manifest bodies, so an old
  // documentation fact can lack the current package presentation label. That
  // label is not consulted by global document resolution; every resolver input
  // remains compared here or in the lookup-key/arity checks above.
  return (
    left.id === right.id &&
    left.exported === right.exported &&
    left.kind === right.kind &&
    left.language === right.language &&
    left.name === right.name &&
    left.path === right.path &&
    left.qualifiedName === right.qualifiedName &&
    left.resolutionDomain === right.resolutionDomain &&
    left.resolutionScopeId === right.resolutionScopeId
  );
}

function addResolutionLookupKey(
  output: Map<string, ProjectResolutionLookupKey>,
  resolutionDomain: string,
  key: string,
): void {
  output.set(`${resolutionDomain}\0${key}`, {key, resolutionDomain});
}

function lookupKeyDomain(key: string, fallback: string | undefined): string {
  const separator = Effect.pipe(
    key,
    EffectString.indexOf(':'),
    Effect.Option.getOrElse(() => -1),
  );
  return separator > 0 ? Effect.pipe(key, EffectString.slice(0, separator)) : (fallback ?? 'generic');
}

function compareResolutionLookupKeys(left: ProjectResolutionLookupKey, right: ProjectResolutionLookupKey): number {
  return compareCodeUnits(left.resolutionDomain, right.resolutionDomain) || compareCodeUnits(left.key, right.key);
}

function changedReexportReferences(
  committedFacts: readonly CodeGraphFileFacts[],
  effectiveFacts: readonly CodeGraphFileFacts[],
): readonly CodeGraphReference[] {
  const committed = reexportReferenceMultiset(committedFacts);
  const effective = reexportReferenceMultiset(effectiveFacts);
  const changed: CodeGraphReference[] = [];
  for (const [signature, values] of committed) {
    changed.push(...values.slice(effective.get(signature)?.length ?? 0));
  }
  for (const [signature, values] of effective) {
    changed.push(...values.slice(committed.get(signature)?.length ?? 0));
  }
  return changed;
}

function reexportReferenceMultiset(
  facts: readonly CodeGraphFileFacts[],
): ReadonlyMap<string, readonly CodeGraphReference[]> {
  const output = new Map<string, CodeGraphReference[]>();
  for (const reference of EffectArray.flatMap(facts, file => file.references ?? [])) {
    if (reference.relation !== 'reexports' || (reference.aliasLookupKeys?.length ?? 0) === 0) continue;
    const signature = JSON.stringify([
      reference.evidencePath,
      reference.resolutionDomain,
      reference.relation,
      reference.exportedOnly ?? false,
      reference.arity ?? null,
      [...(reference.aliasLookupKeys ?? [])].sort(compareCodeUnits),
      EffectArray.map(reference.lookupTiers, tier => [...tier].sort(compareCodeUnits)),
    ]);
    const values = output.get(signature) ?? [];
    values.push(reference);
    output.set(signature, values);
  }
  return output;
}

interface ProjectPathIndexes {
  readonly roots: ReadonlyMap<string, readonly string[]>;
  readonly sourceRoots: ReadonlyMap<string, readonly string[]>;
}

function projectPathIndexesByDomain(
  projects: readonly CodeGraphWorkspaceProject[],
): ReadonlyMap<string, ProjectPathIndexes> {
  const indexesByDomain = new Map<
    string,
    {readonly roots: Map<string, string[]>; readonly sourceRoots: Map<string, string[]>}
  >();
  const add = (index: Map<string, string[]>, root: string, id: string) => {
    const values = index.get(root);
    if (values) {
      if (!values.includes(id)) values.push(id);
    } else index.set(root, [id]);
  };
  for (const project of projects) {
    let indexes = indexesByDomain.get(project.resolutionDomain);
    if (!indexes) {
      indexes = {roots: new Map(), sourceRoots: new Map()};
      indexesByDomain.set(project.resolutionDomain, indexes);
    }
    add(indexes.roots, project.root, project.id);
    for (const root of project.sourceRoots) add(indexes.sourceRoots, root, project.id);
  }
  for (const indexes of indexesByDomain.values()) {
    for (const values of [...indexes.roots.values(), ...indexes.sourceRoots.values()]) values.sort(compareCodeUnits);
  }
  return indexesByDomain;
}

function nearestProject(
  indexes: ProjectPathIndexes,
  path: string,
): {readonly mode: 'ambiguous' | 'unique'; readonly projectId?: string} {
  const source = nearestPrefix(indexes.sourceRoots, path);
  if (source !== undefined) return source.length === 1 ? {mode: 'unique', projectId: source[0]} : {mode: 'ambiguous'};
  const root = nearestPrefix(indexes.roots, path);
  if (root !== undefined) return root.length === 1 ? {mode: 'unique', projectId: root[0]} : {mode: 'ambiguous'};
  return {mode: 'unique'};
}

function nearestPrefix(index: ReadonlyMap<string, readonly string[]>, path: string): readonly string[] | undefined {
  let prefix = path;
  for (;;) {
    const values = index.get(prefix);
    if (values !== undefined) return values;
    const separator = Effect.pipe(
      prefix,
      EffectString.lastIndexOf('/'),
      Effect.Option.getOrElse(() => -1),
    );
    if (separator < 0) return index.get('');
    prefix = Effect.pipe(prefix, EffectString.slice(0, separator));
  }
}

function declaredProjectForPath(
  projectsById: ReadonlyMap<string, CodeGraphWorkspaceProject>,
  indexesByDomain: ReadonlyMap<string, ProjectPathIndexes>,
  path: string,
  resolutionDomain: string | undefined,
): {readonly mode: 'incomplete'} | {readonly mode: 'unique'; readonly project: CodeGraphWorkspaceProject} {
  if (resolutionDomain === undefined) return {mode: 'incomplete'};
  const indexes = indexesByDomain.get(resolutionDomain);
  if (!indexes) return {mode: 'incomplete'};
  const owner = nearestProject(indexes, path);
  if (owner.mode !== 'unique' || owner.projectId === undefined) return {mode: 'incomplete'};
  const project = projectsById.get(owner.projectId);
  if (
    !project ||
    project.provenance !== 'declared' ||
    project.buildSystem === 'inferred' ||
    project.diagnostics.length > 0
  ) {
    return {mode: 'incomplete'};
  }
  return {mode: 'unique', project};
}

function hasCompleteDeclaredDependencyModel(
  projects: readonly CodeGraphWorkspaceProject[],
  projectsById: ReadonlyMap<string, CodeGraphWorkspaceProject>,
  resolutionDomains?: ReadonlySet<string>,
): boolean {
  for (const project of projects) {
    if (resolutionDomains !== undefined && !resolutionDomains.has(project.resolutionDomain)) continue;
    const dependencies = new Set(project.dependencies);
    const detailedTargets = new Set(EffectArray.map(project.dependencyDetails, dependency => dependency.targetId));
    if (
      dependencies.size !== project.dependencies.length ||
      !sameStrings([...dependencies], [...detailedTargets]) ||
      EffectArray.some(project.dependencyDetails, dependency => dependency.provenance !== 'declared') ||
      EffectArray.some([...dependencies], id => !projectsById.has(id))
    ) {
      return false;
    }
  }
  return true;
}

interface DeclaredProjectResolutionClosure {
  readonly dependencyEdges: number;
  readonly projectIds: readonly string[];
  readonly projectsById: ReadonlyMap<string, CodeGraphWorkspaceProject>;
}

/**
 * Returns the exact declared reverse-dependency closure without enumerating
 * repository files. Sparse persisted-base admission uses these stable project
 * identities to issue bounded prefix probes before the ordinary closure
 * planner verifies ownership and resource limits.
 */
export function declaredProjectResolutionClosureProjectIds(
  projects: readonly CodeGraphWorkspaceProject[],
  seedProjectIds: readonly string[],
): readonly string[] | undefined {
  return declaredProjectResolutionClosure(projects, seedProjectIds)?.projectIds;
}

function declaredProjectResolutionClosure(
  projects: readonly CodeGraphWorkspaceProject[],
  seedProjectIds: readonly string[],
): DeclaredProjectResolutionClosure | undefined {
  const projectsById = uniqueProjectsById(projects);
  if (projectsById === undefined) return undefined;
  const seeds = uniqueSorted(seedProjectIds);
  if (seeds.length === 0 || EffectArray.some(seeds, id => !projectsById.has(id))) return undefined;
  const resolutionDomains = new Set(EffectArray.map(seeds, id => projectsById.get(id)!.resolutionDomain));
  if (!hasCompleteDeclaredDependencyModel(projects, projectsById, resolutionDomains)) return undefined;

  const reverseDependencies = new Map<string, string[]>();
  let dependencyEdges = 0;
  for (const project of projects) {
    if (!resolutionDomains.has(project.resolutionDomain)) continue;
    for (const dependencyId of project.dependencies) {
      dependencyEdges += 1;
      const dependency = projectsById.get(dependencyId)!;
      if (dependency.resolutionDomain !== project.resolutionDomain) continue;
      const dependents = reverseDependencies.get(dependencyId) ?? [];
      dependents.push(project.id);
      reverseDependencies.set(dependencyId, dependents);
    }
  }
  for (const dependents of reverseDependencies.values()) dependents.sort(compareCodeUnits);

  const closure = new Set(seeds);
  const queue = [...seeds];
  for (let offset = 0; offset < queue.length; offset += 1) {
    for (const dependentId of reverseDependencies.get(queue[offset]) ?? []) {
      if (closure.has(dependentId)) continue;
      closure.add(dependentId);
      queue.push(dependentId);
    }
  }
  const projectIds = [...closure].sort(compareCodeUnits);
  if (
    EffectArray.some(projectIds, id => {
      const project = projectsById.get(id)!;
      return project.provenance !== 'declared' || project.buildSystem === 'inferred' || project.diagnostics.length > 0;
    })
  ) {
    return undefined;
  }
  return {dependencyEdges, projectIds, projectsById};
}

function uniqueProjectsById(
  projects: readonly CodeGraphWorkspaceProject[],
): ReadonlyMap<string, CodeGraphWorkspaceProject> | undefined {
  const projectsById = new Map<string, CodeGraphWorkspaceProject>();
  for (const project of projects) {
    if (projectsById.has(project.id)) return undefined;
    projectsById.set(project.id, project);
  }
  return projectsById;
}

function hasSameGlobalSymbolSurface(left: CodeGraphSymbol, right: CodeGraphSymbol): boolean {
  return (
    left.id === right.id &&
    left.exported === right.exported &&
    left.kind === right.kind &&
    left.language === right.language &&
    left.name === right.name &&
    left.packageName === right.packageName &&
    left.path === right.path &&
    left.qualifiedName === right.qualifiedName &&
    left.resolutionDomain === right.resolutionDomain &&
    left.resolutionScopeId === right.resolutionScopeId
  );
}

function isOwnedLookupKey(key: string, project: CodeGraphWorkspaceProject): boolean {
  return Effect.pipe(key, EffectString.startsWith(`${project.resolutionDomain}:${project.id}:`));
}

function uniqueFactsByPath(facts: readonly CodeGraphFileFacts[]): ReadonlyMap<string, CodeGraphFileFacts> | undefined {
  const output = new Map<string, CodeGraphFileFacts>();
  for (const fact of facts) {
    if (output.has(fact.path)) return undefined;
    output.set(fact.path, fact);
  }
  return output;
}

function uniqueSymbols(symbols: readonly CodeGraphSymbol[]): ReadonlyMap<string, CodeGraphSymbol> | undefined {
  const output = new Map<string, CodeGraphSymbol>();
  for (const symbol of symbols) {
    if (output.has(symbol.id)) return undefined;
    output.set(symbol.id, symbol);
  }
  return output;
}

function publishedSymbols(symbols: ReadonlyMap<string, CodeGraphSymbol>): ReadonlyMap<string, CodeGraphSymbol> {
  return new Map(EffectArray.filter([...symbols], ([, symbol]) => isPublishedCodeGraphResolutionSymbol(symbol)));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = uniqueSorted(left);
  const normalizedRight = uniqueSorted(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    EffectArray.every(normalizedLeft, (value, index) => value === normalizedRight[index])
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function incompletePlan(): Extract<ProjectIncrementalClosurePlan, {readonly mode: 'fallback'}> {
  return {mode: 'fallback', reason: 'project-closure-incomplete'};
}

function unboundedPlan(
  fallbackBoundary?: CodeGraphOverlayFallbackBoundary,
): Extract<ProjectIncrementalClosurePlan, {readonly mode: 'fallback'}> {
  return {
    ...(fallbackBoundary === undefined ? {} : {fallbackBoundary}),
    mode: 'fallback',
    reason: 'project-closure-unbounded',
  };
}

function incompleteSeeds(
  fallbackDetail?: CodeGraphProjectFileSetFallbackDetail,
): Extract<ProjectClosureSeedAssessment, {readonly mode: 'fallback'}> {
  return {
    ...(fallbackDetail === undefined ? {} : {fallbackDetail}),
    mode: 'fallback',
    reason: 'project-closure-incomplete',
  };
}
