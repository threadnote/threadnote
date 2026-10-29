import {Array as EffectArray} from 'effect';
import {Effect, Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphReference, CodeGraphSymbol} from './types.js';
import type {
  CodeGraphBuildWorkspace,
  CodeGraphWorkspace,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceDependency,
  CodeGraphWorkspaceDetector,
  CodeGraphWorkspaceProject,
} from './languages/types.js';
import {compareCodeUnits} from './ordering.js';
import {canonicalCodeGraphMonikers, codeGraphPackageMoniker} from './cross_repository/monikers.js';
import type {CodeGraphExternalDependencyV1, CodeGraphMonikerV1} from './cross_repository/types.js';
import {discoverNodeWorkspaceCandidates} from './workspace/node.js';
import {boundedCodeGraphWorkspaceDiagnostics, resolveCodeGraphWorkspaceDiagnostics} from './workspace/diagnostics.js';
import {xcodeNativeTargetNames} from './workspace/xcode.js';
import {
  basename,
  dirname,
  joinPath,
  materializeBuildWorkspaces,
  normalizeContainedPath,
  type ProjectCandidate,
  type WorkspaceFileIndex,
  unique,
  uniqueStrings,
  workspaceIdentity,
} from './workspace/primitives.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export {discoverBazelWorkspace} from './workspace/bazel.js';

export function workspaceHasUninventoriedMonikerEvidence(
  workspace: CodeGraphWorkspace,
  filePaths: ReadonlySet<string>,
): boolean {
  return EffectArray.some(workspace.projects, project =>
    EffectArray.some(project.monikers ?? [], moniker => !filePaths.has(moniker.evidence.path)),
  );
}

interface WorkspaceProjectPathIndex {
  readonly projectsByRoot: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
  readonly projectsBySourceRoot: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>;
}

const workspaceProjectPathIndexes = new WeakMap<readonly CodeGraphWorkspaceProject[], WorkspaceProjectPathIndex>();

export const CODE_GRAPH_WORKSPACE_MODEL_VERSION = 'code-graph-workspace-set-v3' as const;

export const manifestWorkspaceDetector: CodeGraphWorkspaceDetector = {
  contextFiles: [],
  detect: files => Effect.succeed(discoverManifestWorkspace(files)),
};

export function discoverManifestWorkspace(files: readonly CodeGraphInventoryFile[]): CodeGraphWorkspace {
  const diagnostics: string[] = [];
  const fileIndex = createWorkspaceFileIndex(files);
  const candidates = [
    ...discoverNodeWorkspaceCandidates(files, diagnostics),
    ...discoverMavenProjects(files, diagnostics, fileIndex),
    ...discoverGradleProjects(files, diagnostics, fileIndex),
    ...discoverSwiftPackageProjects(files, diagnostics),
    ...discoverXcodeProjects(files, diagnostics),
  ];
  addFallbackProjects(files, candidates);
  const diagnosticResolution = resolveCodeGraphWorkspaceDiagnostics(
    materializeProjects(mergeProjectCandidates(candidates), diagnostics),
    diagnostics,
  );
  const projects = diagnosticResolution.projects;
  const orderedDiagnostics = boundedCodeGraphWorkspaceDiagnostics(diagnosticResolution);
  const fingerprint = sha256HexSync(
    EffectArray.join(
      [
        'code-graph-workspace-v1',
        ...EffectArray.map(projects, project =>
          EffectArray.join(
            [
              project.id,
              project.workspaceId,
              project.buildSystem,
              project.kind,
              project.provenance,
              project.name,
              project.root,
              project.resolutionDomain,
              EffectArray.join(project.dependencies, ','),
              JSON.stringify(project.externalDependencies ?? []),
              JSON.stringify(project.monikers ?? []),
              EffectArray.join(project.sourceRoots, ','),
              EffectArray.join(project.workspaceRoots, ','),
              EffectArray.join(project.diagnostics, ','),
            ],
            '\0',
          ),
        ),
        ...orderedDiagnostics,
      ],
      '\n',
    ),
  );
  return {
    diagnostics: orderedDiagnostics,
    fingerprint,
    projects,
    workspaces: materializeBuildWorkspaces(projects, orderedDiagnostics),
  };
}

export function mergeCodeGraphWorkspaces(workspaces: readonly CodeGraphWorkspace[]): CodeGraphWorkspace {
  const projects = new Map<string, CodeGraphWorkspaceProject>();
  const diagnostics: string[] = [];
  for (const workspace of workspaces) {
    for (const inputProject of workspace.projects) {
      const project = normalizeWorkspaceProject(inputProject);
      const existing = projects.get(project.id);
      if (!existing) {
        projects.set(project.id, project);
        continue;
      }
      const preferred = preferredWorkspaceProject(existing, project);
      projects.set(project.id, {
        buildSystem: preferred.buildSystem,
        dependencies: uniqueStrings([...existing.dependencies, ...project.dependencies]),
        dependencyDetails: normalizeWorkspaceDependencies([
          ...existing.dependencyDetails,
          ...project.dependencyDetails,
        ]),
        externalDependencies: normalizeExternalDependencies([
          ...(existing.externalDependencies ?? []),
          ...(project.externalDependencies ?? []),
        ]),
        diagnostics: uniqueStrings([...existing.diagnostics, ...project.diagnostics]),
        id: project.id,
        kind: preferred.kind,
        languages: uniqueStrings([...existing.languages, ...project.languages]),
        monikers: canonicalCodeGraphMonikers([...(existing.monikers ?? []), ...(project.monikers ?? [])]),
        name: preferred.name,
        provenance: existing.provenance === 'declared' || project.provenance === 'declared' ? 'declared' : 'inferred',
        resolutionDomain: preferred.resolutionDomain,
        root: preferred.root,
        sourceRoots: uniqueStrings([...existing.sourceRoots, ...project.sourceRoots]),
        workspaceId: preferred.workspaceId,
        workspaceRoots: uniqueStrings([...existing.workspaceRoots, ...project.workspaceRoots]),
      });
    }
    diagnostics.push(...workspace.diagnostics);
  }
  const diagnosticResolution = resolveCodeGraphWorkspaceDiagnostics(
    [...projects.values()].sort(
      (left, right) =>
        compareCodeUnits(left.root, right.root) ||
        compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
        compareCodeUnits(left.id, right.id),
    ),
    diagnostics,
  );
  const orderedProjects = diagnosticResolution.projects;
  const orderedDiagnostics = boundedCodeGraphWorkspaceDiagnostics(diagnosticResolution);
  const buildWorkspaces = materializeBuildWorkspaces(orderedProjects, orderedDiagnostics);
  return {
    diagnostics: orderedDiagnostics,
    fingerprint: mergedWorkspaceFingerprint(orderedProjects, orderedDiagnostics, buildWorkspaces),
    projects: orderedProjects,
    workspaces: buildWorkspaces,
  };
}

function normalizeWorkspaceProject(project: CodeGraphWorkspaceProject): CodeGraphWorkspaceProject {
  return {
    ...project,
    dependencies: uniqueStrings(project.dependencies),
    dependencyDetails: normalizeWorkspaceDependencies(project.dependencyDetails),
    externalDependencies: normalizeExternalDependencies(project.externalDependencies ?? []),
    diagnostics: uniqueStrings(project.diagnostics),
    languages: uniqueStrings(project.languages),
    monikers: canonicalCodeGraphMonikers(project.monikers ?? []),
    sourceRoots: uniqueStrings(project.sourceRoots),
    workspaceRoots: uniqueStrings(project.workspaceRoots),
  };
}

function normalizeExternalDependencies(
  dependencies: readonly CodeGraphExternalDependencyV1[],
): readonly CodeGraphExternalDependencyV1[] {
  return uniqueBy(
    dependencies,
    dependency =>
      `${dependency.ecosystem}\0${dependency.name}\0${dependency.importAlias}\0${dependency.kind}\0${dependency.versionConstraint}\0${dependency.evidence.path}`,
  ).sort(
    (left, right) =>
      compareCodeUnits(left.ecosystem, right.ecosystem) ||
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.importAlias, right.importAlias) ||
      compareCodeUnits(left.kind, right.kind) ||
      compareCodeUnits(left.versionConstraint, right.versionConstraint) ||
      compareCodeUnits(left.evidence.path, right.evidence.path),
  );
}

function normalizeWorkspaceDependencies(
  dependencies: readonly CodeGraphWorkspaceDependency[],
): readonly CodeGraphWorkspaceDependency[] {
  return uniqueBy(
    dependencies,
    dependency => `${dependency.targetId}\0${dependency.provenance}\0${dependency.evidence ?? ''}`,
  ).sort(
    (left, right) =>
      compareCodeUnits(left.targetId, right.targetId) ||
      compareCodeUnits(left.provenance, right.provenance) ||
      compareCodeUnits(left.evidence ?? '', right.evidence ?? ''),
  );
}

function preferredWorkspaceProject(
  left: CodeGraphWorkspaceProject,
  right: CodeGraphWorkspaceProject,
): CodeGraphWorkspaceProject {
  return compareWorkspaceProjectPrecedence(left, right) <= 0 ? left : right;
}

function compareWorkspaceProjectPrecedence(left: CodeGraphWorkspaceProject, right: CodeGraphWorkspaceProject): number {
  return (
    Number(right.provenance === 'declared') - Number(left.provenance === 'declared') ||
    Number(left.buildSystem === 'inferred') - Number(right.buildSystem === 'inferred') ||
    workspaceProjectBuildSystemRank(left.buildSystem) - workspaceProjectBuildSystemRank(right.buildSystem) ||
    componentKindRank(left.kind) - componentKindRank(right.kind) ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(left.buildSystem, right.buildSystem) ||
    compareCodeUnits(left.workspaceId, right.workspaceId) ||
    compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
    compareCodeUnits(left.root, right.root) ||
    compareCodeUnits(left.name, right.name)
  );
}

function workspaceProjectBuildSystemRank(buildSystem: CodeGraphWorkspaceProject['buildSystem']): number {
  switch (buildSystem) {
    case 'node':
    case 'pnpm':
    case 'nx':
      return 0;
    case 'typescript':
      return 1;
    case 'bazel':
      return 2;
    default:
      return 3;
  }
}

function mergedWorkspaceFingerprint(
  projects: readonly CodeGraphWorkspaceProject[],
  diagnostics: readonly string[],
  workspaces: readonly CodeGraphBuildWorkspace[],
): string {
  return sha256HexSync(
    JSON.stringify({
      diagnostics,
      projects: EffectArray.map(projects, project => [
        project.id,
        project.workspaceId,
        project.buildSystem,
        project.kind,
        project.provenance,
        project.name,
        project.root,
        project.resolutionDomain,
        project.dependencies,
        EffectArray.map(project.dependencyDetails, dependency => [
          dependency.targetId,
          dependency.provenance,
          dependency.evidence ?? '',
        ]),
        project.externalDependencies ?? [],
        project.monikers ?? [],
        project.languages,
        project.sourceRoots,
        project.workspaceRoots,
        project.diagnostics,
      ]),
      version: CODE_GRAPH_WORKSPACE_MODEL_VERSION,
      workspaces: EffectArray.map(workspaces, workspace => [
        workspace.id,
        workspace.buildSystem,
        workspace.provenance,
        workspace.name,
        workspace.root,
        workspace.diagnostics,
      ]),
    }),
  );
}

export function createWorkspaceAttributor(
  workspace: CodeGraphWorkspace,
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const projectsById = new Map(EffectArray.map(workspace.projects, project => [project.id, project]));
  const findProject = createWorkspaceProjectLookup(workspace.projects);
  const findPackageProject = createWorkspaceProjectLookup(
    EffectArray.filter(workspace.projects, project => project.buildSystem === 'node' || project.buildSystem === 'pnpm'),
  );
  return facts =>
    EffectArray.map(facts, file => ({
      ...file,
      references: Option.getOrUndefined(
        Option.map(Option.fromNullishOr(file.references), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, reference =>
            Option.match(findProject(file.path, reference.resolutionDomain), {
              onNone: () => reference,
              onSome: project => attributeReference(reference, project, projectsById, findProject),
            }),
          ),
        ),
      ),
      symbols: EffectArray.map(file.symbols, symbol =>
        Option.match(
          symbol.kind === 'package' && symbol.resolutionDomain === 'workspace'
            ? findPackageProject(file.path)
            : findProject(file.path, symbol.resolutionDomain),
          {
            onNone: () => symbol,
            onSome: project => attributeSymbol(symbol, project),
          },
        ),
      ),
    }));
}

export function projectForPath(
  projects: readonly CodeGraphWorkspaceProject[],
  filePath: string,
  resolutionDomain?: string,
): Option.Option<CodeGraphWorkspaceProject> {
  return createWorkspaceProjectLookup(projects)(filePath, resolutionDomain);
}

export function createWorkspaceProjectLookup(
  projects: readonly CodeGraphWorkspaceProject[],
): (filePath: string, resolutionDomain?: string) => Option.Option<CodeGraphWorkspaceProject> {
  const index = workspaceProjectPathIndexes.get(projects) ?? createWorkspaceProjectPathIndex(projects);
  if (!workspaceProjectPathIndexes.has(projects)) workspaceProjectPathIndexes.set(projects, index);
  return (filePath, resolutionDomain) =>
    Option.fromUndefinedOr(
      nearestPrefixProject(index.projectsBySourceRoot, filePath, resolutionDomain) ??
        nearestPrefixProject(index.projectsByRoot, filePath, resolutionDomain),
    );
}

function discoverMavenProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
  fileIndex: WorkspaceFileIndex,
): readonly ProjectCandidate[] {
  const output: ProjectCandidate[] = [];
  for (const file of EffectArray.filter(files, candidate => basename(candidate.path) === 'pom.xml')) {
    if (file.content === undefined) continue;
    const root = dirname(file.path);
    const projectXml = Effect2.pipe(file.content, EffectString.replace(/<parent\b[\s\S]*?<\/parent>/i, ''));
    const group = xmlTag(projectXml, 'groupId');
    const artifact = xmlTag(projectXml, 'artifactId') ?? (Effect2.pipe(root, EffectString.split('/')).at(-1) || 'root');
    const name = group ? `${group}:${artifact}` : artifact;
    const moduleRoots = EffectArray.flatMap(xmlTags(file.content, 'module'), module => {
      const normalized = normalizeContainedPath(root, module);
      return normalized === undefined ? [] : [normalized];
    });
    const dependencies = EffectArray.flatMap(
      [...Effect2.pipe(file.content, EffectString.matchAll(/<dependency\b[\s\S]*?<\/dependency>/gi))],
      match => {
        const dependencyGroup = xmlTag(match[0], 'groupId');
        const dependencyArtifact = xmlTag(match[0], 'artifactId');
        return dependencyArtifact
          ? [dependencyGroup ? `${dependencyGroup}:${dependencyArtifact}` : dependencyArtifact]
          : [];
      },
    );
    output.push({
      aliases: [name, artifact, root],
      buildSystem: 'maven',
      dependencyAliases: dependencies,
      diagnostics: [],
      evidence: file.path,
      kind: 'module',
      languages: ['java', 'kotlin'],
      name,
      provenance: 'declared',
      resolutionDomain: 'jvm',
      root,
      sourceRoots: conventionalJvmSourceRoots(root),
      workspaceRoots: [root],
    });
    for (const moduleRoot of moduleRoots) {
      if (!fileIndex.fileByPath.has(joinPath(moduleRoot, 'pom.xml'))) {
        diagnostics.push(`${file.path}: declared Maven module ${moduleRoot} has no indexed pom.xml`);
      }
    }
  }
  return output;
}

function discoverGradleProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
  fileIndex: WorkspaceFileIndex,
): readonly ProjectCandidate[] {
  const output: ProjectCandidate[] = [];
  const settingsFiles = EffectArray.filter(
    EffectArray.filter(
      files,
      (candidate, __effectArrayIndex) =>
        __effectArrayIndex in files && /^(?:settings\.gradle(?:\.kts)?)$/i.test(basename(candidate.path)),
    ),
    file => file.content !== undefined,
  );
  const coveredBuildRoots = new Set<string>();
  for (const settings of settingsFiles) {
    const workspaceRoot = dirname(settings.path);
    const rootName =
      /\brootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings.content!)?.[1] ??
      (Effect2.pipe(workspaceRoot, EffectString.split('/')).at(-1) || 'root');
    const projectDirectories = gradleProjectDirectories(settings.content!, workspaceRoot);
    const includedModules = gradleIncludes(settings.content!);
    const modules = ['', ...includedModules];
    for (const modulePath of modules) {
      const gradlePath = modulePath
        ? `:${EffectArray.join(Effect2.pipe(modulePath, EffectString.split('/')), ':')}`
        : ':';
      const root = projectDirectories.get(gradlePath) ?? joinPath(workspaceRoot, modulePath);
      coveredBuildRoots.add(root);
      const buildFile = fileIndex.buildFileByRoot.get(root);
      const dependencyAliases = buildFile?.content ? gradleProjectDependencies(buildFile.content) : [];
      const moduleName = Effect2.pipe(modulePath, EffectString.split('/')).at(-1) || rootName;
      output.push({
        aliases: [gradlePath, moduleName, root],
        buildSystem: 'gradle',
        dependencyAliases,
        diagnostics: [],
        evidence: settings.path,
        kind: modulePath ? 'module' : 'project',
        languages: ['java', 'kotlin'],
        name: moduleName,
        provenance: 'declared',
        resolutionDomain: 'jvm',
        root,
        sourceRoots: conventionalJvmSourceRoots(root),
        workspaceRoots: [workspaceRoot],
      });
    }
    for (const modulePath of includedModules) {
      const root =
        projectDirectories.get(`:${EffectArray.join(Effect2.pipe(modulePath, EffectString.split('/')), ':')}`) ??
        joinPath(workspaceRoot, modulePath);
      if (!hasIndexedPathWithin(fileIndex.sortedPaths, root)) {
        diagnostics.push(`${settings.path}: declared Gradle project ${modulePath} has no indexed files`);
      }
    }
  }
  for (const buildFile of EffectArray.filter(
    files,
    (candidate, __effectArrayIndex) =>
      __effectArrayIndex in files && /^build\.gradle(?:\.kts)?$/i.test(basename(candidate.path)),
  )) {
    const root = dirname(buildFile.path);
    if (coveredBuildRoots.has(root)) continue;
    output.push({
      aliases: [root, Effect2.pipe(root, EffectString.split('/')).at(-1) || 'root'],
      buildSystem: 'gradle',
      dependencyAliases: buildFile.content ? gradleProjectDependencies(buildFile.content) : [],
      diagnostics: [],
      evidence: buildFile.path,
      kind: 'project',
      languages: ['java', 'kotlin'],
      name: Effect2.pipe(root, EffectString.split('/')).at(-1) || 'root',
      provenance: 'declared',
      resolutionDomain: 'jvm',
      root,
      sourceRoots: conventionalJvmSourceRoots(root),
      workspaceRoots: [root],
    });
  }
  return output;
}

function discoverSwiftPackageProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
): readonly ProjectCandidate[] {
  const output: ProjectCandidate[] = [];
  for (const file of EffectArray.filter(
    files,
    candidate => Effect2.pipe(basename(candidate.path), EffectString.toLowerCase) === 'package.swift',
  )) {
    if (file.content === undefined) continue;
    const packageRoot = dirname(file.path);
    const packageName =
      /\bPackage\s*\(\s*name\s*:\s*"([^"]+)"/m.exec(file.content)?.[1] ??
      (Effect2.pipe(packageRoot, EffectString.split('/')).at(-1) || 'Package');
    const targets = swiftTargets(file.content);
    if (targets.length === 0) {
      output.push({
        aliases: [packageName, packageRoot],
        buildSystem: 'swiftpm',
        dependencyAliases: [],
        diagnostics: [`${file.path}: targets could not be proven statically`],
        evidence: file.path,
        kind: 'package',
        languages: ['swift'],
        name: packageName,
        provenance: 'declared',
        resolutionDomain: 'swift',
        root: packageRoot,
        sourceRoots: [joinPath(packageRoot, 'Sources')],
        workspaceRoots: [packageRoot],
      });
      diagnostics.push(`${file.path}: SwiftPM targets could not be proven statically; using the package source root`);
      continue;
    }
    for (const target of targets) {
      const sourceRoot = normalizeContainedPath(
        packageRoot,
        target.path ?? `${target.test ? 'Tests' : 'Sources'}/${target.name}`,
      );
      if (sourceRoot === undefined) {
        diagnostics.push(`${file.path}: Swift target ${target.name} declares a path outside the package`);
        continue;
      }
      output.push({
        aliases: [target.name, sourceRoot],
        buildSystem: 'swiftpm',
        dependencyAliases: target.dependencies,
        diagnostics: [],
        evidence: file.path,
        kind: 'target',
        languages: ['swift'],
        name: target.name,
        provenance: 'declared',
        resolutionDomain: 'swift',
        root: sourceRoot,
        sourceRoots: [sourceRoot],
        workspaceRoots: [packageRoot],
      });
    }
  }
  return output;
}

function discoverXcodeProjects(
  files: readonly CodeGraphInventoryFile[],
  diagnostics: string[],
): readonly ProjectCandidate[] {
  const output: ProjectCandidate[] = [];
  for (const file of EffectArray.filter(
    files,
    (candidate, __effectArrayIndex) =>
      __effectArrayIndex in files && /\.xcodeproj\/project\.pbxproj$/i.test(candidate.path),
  )) {
    const projectBundle = dirname(file.path);
    const root = dirname(projectBundle);
    const projectName = Effect2.pipe(basename(projectBundle), EffectString.replace(/\.xcodeproj$/i, ''));
    const targetNames = file.content ? xcodeNativeTargetNames(file.content) : [];
    output.push({
      aliases: [projectName, root, ...targetNames],
      buildSystem: 'xcode',
      dependencyAliases: [],
      diagnostics: targetNames.length > 1 ? [`${file.path}: multiple targets share a conservative project scope`] : [],
      evidence: file.path,
      kind: 'project',
      languages: ['swift'],
      name: targetNames.length === 1 ? targetNames[0] : projectName,
      provenance: 'declared',
      resolutionDomain: 'swift',
      root,
      sourceRoots: [root],
      workspaceRoots: [root],
    });
    if (targetNames.length > 1) {
      diagnostics.push(
        `${file.path}: multiple Xcode targets share a conservative project scope because source membership was incomplete`,
      );
    }
  }
  return output;
}

function addFallbackProjects(files: readonly CodeGraphInventoryFile[], candidates: ProjectCandidate[]): void {
  const coveredSourceRoots = createPathPrefixSet(EffectArray.flatMap(candidates, candidate => candidate.sourceRoots));
  for (const file of EffectArray.filter(
    files,
    (candidate, __effectArrayIndex) => __effectArrayIndex in files && /\.(?:java|kt|kts|swift)$/i.test(candidate.path),
  )) {
    if (coveredSourceRoots.hasPrefix(file.path)) continue;
    const swift = Effect2.pipe(file.path, EffectString.toLowerCase, EffectString.endsWith('.swift'));
    const inferred = swift ? inferSwiftRoot(file.path) : inferJvmRoot(file.path);
    if (!inferred) continue;
    candidates.push({
      aliases: [inferred.name, inferred.root],
      buildSystem: 'inferred',
      dependencyAliases: [],
      diagnostics: [],
      kind: 'project',
      languages: swift ? ['swift'] : ['java', 'kotlin'],
      name: inferred.name,
      provenance: 'inferred',
      resolutionDomain: swift ? 'swift' : 'jvm',
      root: inferred.root,
      sourceRoots: [inferred.sourceRoot],
      workspaceRoots: [inferred.root],
    });
    coveredSourceRoots.add(inferred.sourceRoot);
  }
}

function mergeProjectCandidates(candidates: readonly ProjectCandidate[]): readonly ProjectCandidate[] {
  const merged = new Map<string, ProjectCandidate>();
  for (const candidate of candidates) {
    const key = candidate.identityKey ?? `${candidate.resolutionDomain}\0${candidate.root}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    const preferred = preferredProjectCandidate(existing, candidate);
    merged.set(key, {
      aliases: unique([...existing.aliases, ...candidate.aliases]).sort(),
      buildSystem: preferred.buildSystem,
      dependencyAliases: unique([...existing.dependencyAliases, ...candidate.dependencyAliases]).sort(),
      dependencyEvidence: mergeDependencyEvidence(existing.dependencyEvidence, candidate.dependencyEvidence),
      diagnostics: unique([...existing.diagnostics, ...candidate.diagnostics]).sort(),
      evidence: preferred.evidence ?? existing.evidence ?? candidate.evidence,
      externalDependencies: normalizeExternalDependencies([
        ...(existing.externalDependencies ?? []),
        ...(candidate.externalDependencies ?? []),
      ]),
      ...((preferred.identityKey ?? existing.identityKey ?? candidate.identityKey)
        ? {identityKey: preferred.identityKey ?? existing.identityKey ?? candidate.identityKey}
        : {}),
      kind: preferred.kind,
      languages: unique([...existing.languages, ...candidate.languages]).sort(),
      name: preferred.name,
      ...(preferred.packageNameSpan === undefined ? {} : {packageNameSpan: preferred.packageNameSpan}),
      ...(preferred.packageNameDeclared === undefined ? {} : {packageNameDeclared: preferred.packageNameDeclared}),
      ...(preferred.packageNameRegistryValid === undefined
        ? {}
        : {packageNameRegistryValid: preferred.packageNameRegistryValid}),
      ...(preferred.packageVersion === undefined ? {} : {packageVersion: preferred.packageVersion}),
      provenance: existing.provenance === 'declared' || candidate.provenance === 'declared' ? 'declared' : 'inferred',
      resolutionDomain: preferred.resolutionDomain,
      root: preferred.root,
      sourceRoots: unique([...existing.sourceRoots, ...candidate.sourceRoots]).sort(),
      workspaceRoots: unique([...existing.workspaceRoots, ...candidate.workspaceRoots]).sort(),
    });
  }
  return [...merged.values()].sort(
    (left, right) =>
      compareCodeUnits(left.root, right.root) ||
      compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
      compareCodeUnits(left.name, right.name),
  );
}

function mergeDependencyEvidence(
  left: ReadonlyMap<string, string> | undefined,
  right: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  for (const [alias, evidence] of [...(left ?? []), ...(right ?? [])].sort(([leftAlias], [rightAlias]) =>
    compareCodeUnits(leftAlias, rightAlias),
  )) {
    const existing = merged.get(alias);
    if (existing === undefined || compareCodeUnits(evidence, existing) < 0) merged.set(alias, evidence);
  }
  return merged;
}

function preferredProjectCandidate(left: ProjectCandidate, right: ProjectCandidate): ProjectCandidate {
  return compareProjectCandidatePrecedence(left, right) <= 0 ? left : right;
}

function compareProjectCandidatePrecedence(left: ProjectCandidate, right: ProjectCandidate): number {
  return (
    Number(right.provenance === 'declared') - Number(left.provenance === 'declared') ||
    evidenceDistance(left.root, left.evidence) - evidenceDistance(right.root, right.evidence) ||
    Number(left.buildSystem === 'inferred') - Number(right.buildSystem === 'inferred') ||
    componentKindRank(left.kind) - componentKindRank(right.kind) ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(left.buildSystem, right.buildSystem) ||
    compareCodeUnits(left.evidence ?? '\uffff', right.evidence ?? '\uffff') ||
    compareCodeUnits(left.name, right.name)
  );
}

function evidenceDistance(root: string, evidence: string | undefined): number {
  if (!evidence) return Number.MAX_SAFE_INTEGER;
  const evidenceRoot = dirname(evidence);
  if (root === evidenceRoot) return 0;
  if (evidenceRoot === '') return root === '' ? 0 : Effect2.pipe(root, EffectString.split('/')).length;
  if (!Effect2.pipe(root, EffectString.startsWith(`${evidenceRoot}/`))) return Number.MAX_SAFE_INTEGER;
  return Effect2.pipe(root, EffectString.slice(evidenceRoot.length + 1), EffectString.split('/')).length;
}

function componentKindRank(kind: CodeGraphWorkspaceComponentKind): number {
  switch (kind) {
    case 'project':
    case 'package':
      return 0;
    case 'module':
    case 'target':
      return 1;
  }
}

function materializeProjects(
  candidates: readonly ProjectCandidate[],
  diagnostics: string[],
): readonly CodeGraphWorkspaceProject[] {
  const projectIds = new Map<ProjectCandidate, string>();
  const candidatesById = new Map<string, ProjectCandidate>();
  const aliases = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const identity = candidate.identityKey ?? `${candidate.resolutionDomain}\n${candidate.root}`;
    const id = `cgp_${Effect2.pipe(sha256HexSync(`project-v1\n${identity}`), EffectString.slice(0, 32))}`;
    projectIds.set(candidate, id);
    candidatesById.set(id, candidate);
    for (const alias of candidate.aliases) {
      const values = aliases.get(alias) ?? new Set<string>();
      values.add(id);
      aliases.set(alias, values);
    }
  }
  return EffectArray.map(candidates, candidate => {
    const id = projectIds.get(candidate)!;
    const dependencies = new Map<string, string | undefined>();
    for (const alias of uniqueStrings(candidate.dependencyAliases)) {
      const targets = aliases.get(alias);
      if (targets?.size === 1) {
        const target = [...targets][0];
        if (target !== id) {
          const evidence = candidate.dependencyEvidence?.get(alias) ?? candidate.evidence;
          const existing = dependencies.get(target);
          if (
            !dependencies.has(target) ||
            (evidence !== undefined && (existing === undefined || evidence < existing))
          ) {
            dependencies.set(target, evidence);
          }
        }
      } else if (targets && targets.size > 1) {
        const qualifier = EffectArray.every(
          [...targets],
          target => candidatesById.get(target)?.provenance === 'declared',
        )
          ? 'declared '
          : '';
        diagnostics.push(
          `${candidate.evidence ?? candidate.root}: local dependency alias ${alias} matched multiple ${qualifier}projects`,
        );
      } else if (/^(?:nx-project:|nx-target:|tsconfig:)/u.test(alias)) {
        diagnostics.push(
          `${candidate.evidence ?? candidate.root}: declared component dependency ${alias} was not indexed`,
        );
      }
    }
    const externalDependencyValues = candidate.externalDependencies ?? [];
    const externalDependencies = normalizeExternalDependencies(
      EffectArray.filter(externalDependencyValues, (dependency, __effectArrayIndex) => {
        if (!(__effectArrayIndex in externalDependencyValues)) return false;
        if (dependency.importAlias !== dependency.name) return true;
        const targets = aliases.get(dependency.name);
        if (targets === undefined || targets.size !== 1) return true;
        return targets.has(id);
      }),
    );
    const monikers: CodeGraphMonikerV1[] = [];
    for (const dependency of externalDependencies) {
      try {
        monikers.push(
          codeGraphPackageMoniker({
            componentId: id,
            dependencyKind: dependency.kind,
            evidence: {
              path: dependency.evidence.path,
              span: dependency.evidence.span ?? {column: 1, endColumn: 1, endLine: 1, line: 1},
            },
            packageName: dependency.name,
            packageVersion: dependency.versionConstraint,
            role: 'import',
          }),
        );
      } catch {
        diagnostics.push(`${dependency.evidence.path}: npm dependency cannot form a package moniker`);
      }
    }
    if (
      (candidate.buildSystem === 'node' || candidate.buildSystem === 'pnpm') &&
      candidate.packageNameDeclared &&
      candidate.packageNameRegistryValid
    ) {
      try {
        monikers.push(
          codeGraphPackageMoniker({
            componentId: id,
            evidence: {
              path: candidate.evidence ?? `${candidate.root ? `${candidate.root}/` : ''}package.json`,
              span: candidate.packageNameSpan ?? {column: 1, endColumn: 1, endLine: 1, line: 1},
            },
            packageName: candidate.name,
            packageVersion: candidate.packageVersion,
            role: 'export',
          }),
        );
      } catch {
        diagnostics.push(`${candidate.evidence ?? candidate.root}: npm package name cannot form a package moniker`);
      }
    }
    return {
      buildSystem: candidate.buildSystem,
      dependencies: [...dependencies.keys()].sort(),
      dependencyDetails: EffectArray.map(
        [...dependencies.entries()].sort(([left], [right]) => compareCodeUnits(left, right)),
        ([targetId, evidence]) => ({evidence, provenance: candidate.provenance, targetId}),
      ),
      externalDependencies,
      diagnostics: candidate.diagnostics,
      id,
      kind: candidate.kind,
      languages: [...candidate.languages].sort(),
      monikers: canonicalCodeGraphMonikers(monikers),
      name: candidate.name,
      provenance: candidate.provenance,
      resolutionDomain: candidate.resolutionDomain,
      root: candidate.root,
      sourceRoots: [...candidate.sourceRoots].sort(),
      workspaceId: workspaceIdentity(candidate.buildSystem, candidate.workspaceRoots[0] ?? candidate.root),
      workspaceRoots: [...candidate.workspaceRoots].sort(),
    };
  });
}

function attributeSymbol(symbol: CodeGraphSymbol, project: CodeGraphWorkspaceProject): CodeGraphSymbol {
  if (
    symbol.kind === 'package' &&
    symbol.resolutionDomain === 'workspace' &&
    (project.buildSystem === 'node' || project.buildSystem === 'pnpm')
  ) {
    return {...symbol, packageName: project.name};
  }
  const resolutionDomain = symbol.resolutionDomain;
  if (resolutionDomain === undefined || !projectSupportsResolutionDomain(project, resolutionDomain)) {
    return symbol;
  }
  return {
    ...symbol,
    lookupKeys: EffectArray.map(symbol.lookupKeys ?? [], key => scopedLookupKey(key, project, resolutionDomain)),
    packageName: project.name,
    resolutionScopeId: project.id,
  };
}

function attributeReference(
  reference: CodeGraphReference,
  project: CodeGraphWorkspaceProject,
  projectsById: ReadonlyMap<string, CodeGraphWorkspaceProject>,
  findProject: ReturnType<typeof createWorkspaceProjectLookup>,
): CodeGraphReference {
  if (!projectSupportsResolutionDomain(project, reference.resolutionDomain)) return reference;
  const lookupTiers: Array<readonly string[]> = [];
  for (const tier of reference.lookupTiers) {
    const owners = EffectArray.map(tier, key => {
      const path = reference.resolutionDomain === 'typescript' ? typeScriptLookupPath(key) : undefined;
      return path === undefined ? undefined : Option.getOrUndefined(findProject(path, 'typescript'))?.id;
    });
    const keysForProject = (target: CodeGraphWorkspaceProject) =>
      EffectArray.flatMap(tier, (key, index) =>
        owners[index] === undefined || owners[index] === target.id
          ? [scopedLookupKey(key, target, reference.resolutionDomain)]
          : [],
      );
    lookupTiers.push(keysForProject(project));
    const dependencyKeys = EffectArray.flatMap(project.dependencies, dependencyId => {
      const dependency = projectsById.get(dependencyId);
      return dependency && projectSupportsResolutionDomain(dependency, reference.resolutionDomain)
        ? keysForProject(dependency)
        : [];
    });
    if (dependencyKeys.length > 0) lookupTiers.push(unique(dependencyKeys));
  }
  return {
    ...reference,
    aliasLookupKeys: Option.getOrUndefined(
      Option.map(Option.fromNullishOr(reference.aliasLookupKeys), __effectArrayReceiver =>
        EffectArray.map(__effectArrayReceiver, key => scopedLookupKey(key, project, reference.resolutionDomain)),
      ),
    ),
    lookupTiers,
  };
}

function typeScriptLookupPath(key: string): string | undefined {
  const match =
    /^typescript:(?:module:([^:]+)|path:([^:]+):(?:name|qualified):[^:]+(?::(?:arity:\d+|implementation|merge-canonical))?)$/u.exec(
      key,
    );
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1] ?? match[2]);
  } catch {
    return undefined;
  }
}

function scopedLookupKey(key: string, project: CodeGraphWorkspaceProject, resolutionDomain: string): string {
  const prefix = `${resolutionDomain}:`;
  return Effect2.pipe(key, EffectString.startsWith(prefix))
    ? `${prefix}${project.id}:${Effect2.pipe(key, EffectString.slice(prefix.length))}`
    : key;
}

function projectSupportsResolutionDomain(project: CodeGraphWorkspaceProject, resolutionDomain: string): boolean {
  return (
    project.resolutionDomain === resolutionDomain ||
    (resolutionDomain === 'bazel' &&
      EffectArray.some(project.languages, language => language === 'bazel' || language === 'starlark'))
  );
}

function createWorkspaceFileIndex(files: readonly CodeGraphInventoryFile[]): WorkspaceFileIndex {
  const buildFileByRoot = new Map<string, CodeGraphInventoryFile>();
  const fileByPath = new Map<string, CodeGraphInventoryFile>();
  for (const file of files) {
    fileByPath.set(file.path, file);
    if (/^build\.gradle(?:\.kts)?$/i.test(basename(file.path)) && !buildFileByRoot.has(dirname(file.path))) {
      buildFileByRoot.set(dirname(file.path), file);
    }
  }
  return {
    buildFileByRoot,
    fileByPath,
    sortedPaths: [...fileByPath.keys()].sort(),
  };
}

function createWorkspaceProjectPathIndex(projects: readonly CodeGraphWorkspaceProject[]): WorkspaceProjectPathIndex {
  const projectsByRoot = new Map<string, CodeGraphWorkspaceProject[]>();
  const projectsBySourceRoot = new Map<string, CodeGraphWorkspaceProject[]>();
  const add = (target: Map<string, CodeGraphWorkspaceProject[]>, root: string, project: CodeGraphWorkspaceProject) => {
    const existing = target.get(root);
    if (existing) {
      if (!EffectArray.some(existing, candidate => candidate.id === project.id)) existing.push(project);
    } else {
      target.set(root, [project]);
    }
  };
  for (const project of projects) {
    add(projectsByRoot, project.root, project);
    for (const sourceRoot of project.sourceRoots) add(projectsBySourceRoot, sourceRoot, project);
  }
  for (const candidates of [...projectsByRoot.values(), ...projectsBySourceRoot.values()]) {
    candidates.sort((left, right) => compareCodeUnits(left.id, right.id));
  }
  return {projectsByRoot, projectsBySourceRoot};
}

function nearestPrefixProject(
  projectsByPrefix: ReadonlyMap<string, readonly CodeGraphWorkspaceProject[]>,
  filePath: string,
  resolutionDomain?: string,
): CodeGraphWorkspaceProject | undefined {
  let prefix = filePath;
  for (;;) {
    const candidates = projectsByPrefix.get(prefix) ?? [];
    const project = matchingResolutionProject(candidates, resolutionDomain);
    if (project) return project;
    const separator = Effect2.pipe(
      prefix,
      EffectString.lastIndexOf('/'),
      Effect2.Option.getOrElse(() => -1),
    );
    if (separator < 0) {
      const roots = projectsByPrefix.get('') ?? [];
      return matchingResolutionProject(roots, resolutionDomain);
    }
    prefix = Effect2.pipe(prefix, EffectString.slice(0, separator));
  }
}

function matchingResolutionProject(
  candidates: readonly CodeGraphWorkspaceProject[],
  resolutionDomain: string | undefined,
): CodeGraphWorkspaceProject | undefined {
  if (resolutionDomain === undefined) return candidates[0];
  return (
    Option.getOrUndefined(
      EffectArray.findFirst(candidates, candidate => candidate.resolutionDomain === resolutionDomain),
    ) ??
    Option.getOrUndefined(
      EffectArray.findFirst(
        candidates,
        __effectArrayValue =>
          !!(candidate => projectSupportsResolutionDomain(candidate, resolutionDomain))(__effectArrayValue),
      ),
    )
  );
}

function hasIndexedPathWithin(sortedPaths: readonly string[], root: string): boolean {
  if (root === '') return sortedPaths.length > 0;
  let lower = 0;
  let upper = sortedPaths.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (sortedPaths[middle] < root) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  const candidate = sortedPaths[lower];
  return (
    candidate === root ||
    Effect2.pipe(candidate, effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect2.pipe(effectOptionalString, EffectString.startsWith(`${root}/`)),
    ) === true
  );
}

function createPathPrefixSet(initial: readonly string[]): {
  readonly add: (root: string) => void;
  readonly hasPrefix: (path: string) => boolean;
} {
  const roots = new Set(initial);
  return {
    add: root => {
      roots.add(root);
    },
    hasPrefix: path => {
      let prefix = path;
      for (;;) {
        if (roots.has(prefix)) return true;
        const separator = Effect2.pipe(
          prefix,
          EffectString.lastIndexOf('/'),
          Effect2.Option.getOrElse(() => -1),
        );
        if (separator < 0) return roots.has('');
        prefix = Effect2.pipe(prefix, EffectString.slice(0, separator));
      }
    },
  };
}

function conventionalJvmSourceRoots(root: string): readonly string[] {
  return EffectArray.map(
    [
      'src/main/java',
      'src/main/kotlin',
      'src/test/java',
      'src/test/kotlin',
      'src/androidTest/java',
      'src/androidTest/kotlin',
      'src/commonMain/kotlin',
      'src/commonTest/kotlin',
      'src/jvmMain/kotlin',
      'src/jvmTest/kotlin',
      'src/iosMain/kotlin',
      'src/iosTest/kotlin',
    ],
    source => joinPath(root, source),
  );
}

function gradleIncludes(content: string): readonly string[] {
  const output = new Set<string>();
  for (const line of Effect2.pipe(content, EffectString.split(/\r?\n/))) {
    if (!/^\s*include\b/.test(line)) continue;
    for (const match of Effect2.pipe(line, EffectString.matchAll(/["'](:[^"']+)["']/g))) {
      const path = Effect2.pipe(match[1], EffectString.replace(/^:/, ''), EffectString.replaceAll(':', '/'));
      if (path) output.add(path);
    }
  }
  return [...output].sort();
}

function gradleProjectDirectories(content: string, root: string): ReadonlyMap<string, string> {
  const output = new Map<string, string>();
  for (const match of Effect2.pipe(
    content,
    EffectString.matchAll(/project\s*\(\s*["'](:[^"']+)["']\s*\)\.projectDir\s*=\s*(?:file\s*\(\s*)?["']([^"']+)["']/g),
  )) {
    const normalized = normalizeContainedPath(root, match[2]);
    if (normalized !== undefined) output.set(match[1], normalized);
  }
  return output;
}

function gradleProjectDependencies(content: string): readonly string[] {
  return unique(
    EffectArray.map(
      [...Effect2.pipe(content, EffectString.matchAll(/\bproject\s*\(\s*(?:path\s*:\s*)?["'](:[^"']+)["']\s*\)/g))],
      match => match[1],
    ),
  );
}

function swiftTargets(content: string): readonly {
  readonly dependencies: readonly string[];
  readonly name: string;
  readonly path?: string;
  readonly test: boolean;
}[] {
  const starts = [
    ...Effect2.pipe(
      content,
      EffectString.matchAll(/\.(target|executableTarget|testTarget)\s*\(\s*name\s*:\s*"([^"]+)"/g),
    ),
  ];
  return EffectArray.map(starts, (match, index) => {
    const body = Effect2.pipe(content, EffectString.slice(match.index, starts[index + 1]?.index ?? content.length));
    const path = /\bpath\s*:\s*"([^"]+)"/.exec(body)?.[1];
    const dependencyBlock = /\bdependencies\s*:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? '';
    const dependencies = unique(
      EffectArray.map([...Effect2.pipe(dependencyBlock, EffectString.matchAll(/"([^"]+)"/g))], value => value[1]),
    );
    return {
      dependencies,
      name: match[2],
      path,
      test: match[1] === 'testTarget',
    };
  });
}

function inferJvmRoot(
  path: string,
): {readonly name: string; readonly root: string; readonly sourceRoot: string} | undefined {
  const match = /^(.*?)(?:\/)?src\/(?:[^/]+\/)?(?:java|kotlin)\//.exec(path);
  if (!match) return undefined;
  const root = Effect2.pipe(match[1], EffectString.replace(/\/$/, ''));
  const sourceRoot = Effect2.pipe(path, EffectString.slice(0, match[0].length - 1));
  return {name: Effect2.pipe(root, EffectString.split('/')).at(-1) || 'root', root, sourceRoot};
}

function inferSwiftRoot(
  path: string,
): {readonly name: string; readonly root: string; readonly sourceRoot: string} | undefined {
  const match = /^(.*?)(?:\/)?(?:Sources|Tests)\/([^/]+)\//.exec(path);
  if (!match) return undefined;
  const sourceRoot = Effect2.pipe(path, EffectString.slice(0, match[0].length - 1));
  return {name: match[2], root: sourceRoot, sourceRoot};
}

function xmlTag(content: string, tag: string): string | undefined {
  return Effect2.pipe(
    new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'i').exec(content)?.[1],
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
}

function xmlTags(content: string, tag: string): readonly string[] {
  return EffectArray.map(
    [
      ...Effect2.pipe(
        content,
        EffectString.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'gi')),
      ),
    ],
    match => Effect2.pipe(match[1], EffectString.trim),
  );
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const output = new Map<string, T>();
  for (const value of values) output.set(key(value), value);
  return [...output.values()];
}
