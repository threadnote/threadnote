import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  bazelAttribute,
  bazelLabelPackage,
  canonicalBazelLabel,
  parseBazelSyntax,
  type BazelCall,
} from '../languages/bazel/syntax.js';
import type {CodeGraphWorkspace, CodeGraphWorkspaceDependency, CodeGraphWorkspaceProject} from '../languages/types.js';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphInventoryFile} from '../types.js';
import {boundedCodeGraphWorkspaceDiagnostics, resolveCodeGraphWorkspaceDiagnostics} from './diagnostics.js';
import {basename, dirname, materializeBuildWorkspaces, relativeContainedPath, workspaceIdentity} from './primitives.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface BazelPackageCandidate {
  readonly dependencyLabels: readonly {readonly evidence: string; readonly label: string}[];
  readonly evidence: string;
  readonly name: string;
  readonly packagePath: string;
  readonly root: string;
  readonly workspaceRoot: string;
}

const BAZEL_WORKSPACE_MARKERS = new Set(['module.bazel', 'workspace', 'workspace.bazel']);
const BAZEL_BUILD_FILES = new Set(['build', 'build.bazel']);
const BAZEL_DEPENDENCY_ATTRIBUTES = new Set([
  'actual',
  'deps',
  'exports',
  'implementation_deps',
  'plugins',
  'runtime_deps',
  'toolchains',
  'tools',
]);

/**
 * Discovers Bazel statically from checked-in Starlark. It deliberately does not invoke Bazel or evaluate macros.
 * Packages from a nested MODULE/WORKSPACE use the nearest marker, while BUILD files without a marker remain
 * integrated into the repository-root Bazel workspace. The resulting Bazel resolution domain can overlap Node,
 * JVM, Swift, and other workspace projects at the same path.
 */
export function discoverBazelWorkspace(files: readonly CodeGraphInventoryFile[]): CodeGraphWorkspace {
  const diagnostics: string[] = [];
  const nodePackageRoots = new Set(
    EffectArray.map(
      EffectArray.filter(files, file => Effect.pipe(basename(file.path), EffectString.toLowerCase) === 'package.json'),
      file => dirname(file.path),
    ),
  );
  const typeScriptConfigsByRoot = new Map<string, string>();
  for (const file of [...files].sort((left, right) => compareCodeUnits(left.path, right.path))) {
    if (!/^tsconfig(?:\.[^/]+)?\.jsonc?$/iu.test(basename(file.path))) continue;
    const root = dirname(file.path);
    const existing = typeScriptConfigsByRoot.get(root);
    if (existing === undefined || Effect.pipe(basename(file.path), EffectString.toLowerCase) === 'tsconfig.json') {
      typeScriptConfigsByRoot.set(root, file.path);
    }
  }
  const workspaceMarkers = EffectArray.filter(
    files,
    (file, __effectArrayIndex) =>
      __effectArrayIndex in files &&
      BAZEL_WORKSPACE_MARKERS.has(Effect.pipe(basename(file.path), EffectString.toLowerCase)),
  ).sort((left, right) => compareCodeUnits(left.path, right.path));
  const declaredRoots = new Set(EffectArray.map(workspaceMarkers, file => dirname(file.path)));
  const bazelRcRoots = new Set(
    EffectArray.map(
      EffectArray.filter(
        files,
        (file, __effectArrayIndex) =>
          __effectArrayIndex in files &&
          Effect.pipe(basename(file.path), EffectString.toLowerCase, EffectString.endsWith('.bazelrc')),
      ),
      file => dirname(file.path),
    ),
  );
  const candidates: BazelPackageCandidate[] = EffectArray.map(
    EffectArray.filter(
      files,
      (file, __effectArrayIndex) =>
        __effectArrayIndex in files &&
        BAZEL_BUILD_FILES.has(Effect.pipe(basename(file.path), EffectString.toLowerCase)) &&
        file.content !== undefined,
    ).sort((left, right) => compareCodeUnits(left.path, right.path)),
    file => {
      const root = dirname(file.path);
      const workspaceRoot = nearestBazelWorkspaceRoot(root, declaredRoots, bazelRcRoots);
      const packagePath = relativeContainedPath(workspaceRoot, root) ?? root;
      const syntax = parseBazelSyntax(file.content!);
      if (syntax.bounded) diagnostics.push(`${file.path}: workspace discovery reached its deterministic syntax bound`);
      return {
        dependencyLabels: bazelDependencyLabels(syntax.calls, packagePath, file.path),
        evidence: file.path,
        name: packagePath ? `//${packagePath}` : '//',
        packagePath,
        root,
        workspaceRoot,
      };
    },
  );

  for (const marker of workspaceMarkers) {
    const root = dirname(marker.path);
    if (EffectArray.some(candidates, candidate => candidate.root === root && candidate.workspaceRoot === root))
      continue;
    candidates.push({
      dependencyLabels: [],
      evidence: marker.path,
      name: bazelDeclaredWorkspaceName(marker) ?? (Effect.pipe(root, EffectString.split('/')).at(-1) || 'root'),
      packagePath: '',
      root,
      workspaceRoot: root,
    });
  }
  candidates.sort(
    (left, right) =>
      compareCodeUnits(left.root, right.root) ||
      compareCodeUnits(left.workspaceRoot, right.workspaceRoot) ||
      compareCodeUnits(left.evidence, right.evidence),
  );

  const projectIdByPackage = new Map<string, string>();
  for (const candidate of candidates) {
    projectIdByPackage.set(
      bazelPackageIdentity(candidate.workspaceRoot, candidate.packagePath),
      bazelProjectIdentity(candidate.root, nodePackageRoots, typeScriptConfigsByRoot),
    );
  }
  const diagnosticResolution = resolveCodeGraphWorkspaceDiagnostics(
    EffectArray.map(candidates, candidate => {
      const id = bazelProjectIdentity(candidate.root, nodePackageRoots, typeScriptConfigsByRoot);
      const overlappingDomain = nodePackageRoots.has(candidate.root)
        ? 'typescript'
        : typeScriptConfigsByRoot.has(candidate.root)
          ? 'typescript-config'
          : 'bazel';
      const dependencies = new Map<string, CodeGraphWorkspaceDependency>();
      for (const dependency of candidate.dependencyLabels) {
        const parsed = bazelLabelPackage(dependency.label);
        if (Option.isNone(parsed) || parsed.value.external) continue;
        const targetId = projectIdByPackage.get(
          bazelPackageIdentity(candidate.workspaceRoot, parsed.value.packagePath),
        );
        if (targetId === undefined) {
          diagnostics.push(`${dependency.evidence}: local Bazel package //${parsed.value.packagePath} was not indexed`);
        } else if (targetId !== id) {
          dependencies.set(targetId, {evidence: dependency.evidence, provenance: 'declared', targetId});
        }
      }
      const dependencyDetails = [...dependencies.values()].sort((left, right) =>
        compareCodeUnits(left.targetId, right.targetId),
      );
      return {
        buildSystem: 'bazel',
        dependencies: EffectArray.map(dependencyDetails, dependency => dependency.targetId),
        dependencyDetails,
        diagnostics: [],
        id,
        kind: BAZEL_BUILD_FILES.has(Effect.pipe(basename(candidate.evidence), EffectString.toLowerCase))
          ? 'package'
          : 'project',
        languages: ['bazel', 'starlark'],
        name: candidate.name,
        provenance: 'declared',
        resolutionDomain: overlappingDomain,
        root: candidate.root,
        sourceRoots: [candidate.root],
        workspaceId: workspaceIdentity('bazel', candidate.workspaceRoot),
        workspaceRoots: [candidate.workspaceRoot],
      } satisfies CodeGraphWorkspaceProject;
    }),
    diagnostics,
  );
  const projects = diagnosticResolution.projects;
  const orderedDiagnostics = boundedCodeGraphWorkspaceDiagnostics(diagnosticResolution);
  const workspaces = materializeBuildWorkspaces(projects, orderedDiagnostics);
  return {
    diagnostics: orderedDiagnostics,
    fingerprint: sha256HexSync(
      JSON.stringify({
        diagnostics: orderedDiagnostics,
        projects: EffectArray.map(projects, project => [
          project.id,
          project.workspaceId,
          project.name,
          project.root,
          project.dependencies,
          project.diagnostics,
          project.workspaceRoots,
        ]),
        version: 'bazel-static-workspace-v1',
      }),
    ),
    projects,
    workspaces,
  };
}

function bazelDependencyLabels(
  calls: readonly BazelCall[],
  packagePath: string,
  evidence: string,
): readonly {readonly evidence: string; readonly label: string}[] {
  const output = new Map<string, {readonly evidence: string; readonly label: string}>();
  for (const call of calls) {
    const callee = Effect.pipe(call.callee, EffectString.replace(/\s+/gu, ''));
    if (callee === 'load') {
      const label = call.strings[0]?.value;
      const canonical = label ? canonicalBazelLabel(label, packagePath) : Option.none();
      if (Option.isSome(canonical)) output.set(canonical.value, {evidence, label: canonical.value});
      continue;
    }
    for (const attribute of call.attributes) {
      if (!BAZEL_DEPENDENCY_ATTRIBUTES.has(attribute.name)) continue;
      for (const literal of attribute.strings) {
        const canonical = canonicalBazelLabel(literal.value, packagePath);
        if (Option.isSome(canonical)) output.set(canonical.value, {evidence, label: canonical.value});
      }
    }
  }
  return [...output.values()].sort((left, right) => compareCodeUnits(left.label, right.label));
}

function bazelDeclaredWorkspaceName(file: CodeGraphInventoryFile): string | undefined {
  if (file.content === undefined) return undefined;
  const expected =
    Effect.pipe(basename(file.path), EffectString.toLowerCase) === 'module.bazel' ? 'module' : 'workspace';
  const declaration = Option.getOrUndefined(
    EffectArray.findFirst(
      parseBazelSyntax(file.content).calls,
      __effectArrayValue =>
        !!(call => call.topLevel && Effect.pipe(call.callee, EffectString.replace(/\s+/gu, '')) === expected)(
          __effectArrayValue,
        ),
    ),
  );
  return Option.getOrUndefined(
    Option.flatMap(Option.fromUndefinedOr(declaration), call =>
      Option.flatMap(bazelAttribute(call, 'name'), attribute => Option.fromUndefinedOr(attribute.strings[0]?.value)),
    ),
  );
}

function nearestBazelWorkspaceRoot(
  root: string,
  declaredRoots: ReadonlySet<string>,
  bazelRcRoots: ReadonlySet<string>,
): string {
  let candidate = root;
  for (;;) {
    if (declaredRoots.has(candidate) || bazelRcRoots.has(candidate)) return candidate;
    if (candidate === '') return '';
    const parent = dirname(candidate);
    if (parent === candidate) return '';
    candidate = parent;
  }
}

function bazelPackageIdentity(workspaceRoot: string, packagePath: string): string {
  return `${workspaceRoot}\0${packagePath}`;
}

function bazelProjectIdentity(
  root: string,
  nodePackageRoots: ReadonlySet<string>,
  typeScriptConfigsByRoot: ReadonlyMap<string, string>,
): string {
  const identity = nodePackageRoots.has(root)
    ? `typescript\n${root}`
    : typeScriptConfigsByRoot.has(root)
      ? `tsconfig:${typeScriptConfigsByRoot.get(root)!}`
      : `bazel\n${root}`;
  return `cgp_${Effect.pipe(sha256HexSync(`project-v1\n${identity}`), EffectString.slice(0, 32))}`;
}
