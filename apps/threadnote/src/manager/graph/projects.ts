import {Console, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {resolveCodeGraphScopeRoute} from '@threadnote/graph/scope/routing';
import {runIsolatedCodeGraphIndexSnapshot} from '@threadnote/graph/isolated/index';
import {resolveAndRecordCodeGraphLocalAssociation} from '@threadnote/graph/local_provenance';
import type {RepositoryIdentityExpectation} from '@threadnote/graph/types';
import {managerGraphCatalog} from '@threadnote/graph/visualization';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {captureConsole} from '../../effect/console.js';
import {parseSeedManifest} from '@threadnote/workspace/manifest';
import type {GraphCatalog, GraphConfiguredProject} from '@threadnote/manager/graph/model';
import {managerProjectPathIsForeign, observeManagerManifestProjects} from '../project/roots.js';
import {requireString} from '@threadnote/manager/request_inputs';
import {SystemInfo} from '@threadnote/platform/system';
import type {ProjectManifest, RuntimeConfig, SeedManifest} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';

const UTF8 = new TextEncoder();
const MANAGER_GRAPH_PROJECT_MAXIMUM = 4_096;
const MANAGER_GRAPH_PROJECT_NAME_BYTES_MAXIMUM = 256;
const MANAGER_GRAPH_PROJECT_PATH_BYTES_MAXIMUM = 4_096;

interface ManagerGraphManifestProject {
  readonly display: {
    readonly folder: string;
    readonly name: string;
    readonly path: string;
  };
  readonly manifest: ProjectManifest;
}

interface ManagerGraphManifestCatalog {
  readonly projects: readonly ManagerGraphManifestProject[];
  readonly revision: string;
}

class ManagerGraphProjectCatalogError extends Schema.TaggedError<ManagerGraphProjectCatalogError>()(
  'ManagerGraphProjectCatalogError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export class ManagerGraphProjectActionError extends Schema.TaggedError<ManagerGraphProjectActionError>()(
  'ManagerGraphProjectActionError',
  {
    code: Schema.Literals(['graph-project-stale', 'graph-project-unavailable']),
    message: Schema.String,
  },
) {
  static of(
    code: 'graph-project-stale' | 'graph-project-unavailable',
    message: string,
  ): ManagerGraphProjectActionError {
    return ManagerGraphProjectActionError.make({code, message});
  }
}

/** Add a bounded manifest inventory without making Graph Manager spawn branch probes. */
export const managerGraphProjectCatalog = Effect.fn('managerGraphProjects.catalogWithConfiguredProjects')(function* (
  config: RuntimeConfig,
) {
  const [catalog, manifestCatalog] = yield* Effect.all(
    [
      managerGraphCatalog(config.agentContextHome),
      readManagerGraphManifestCatalog(config).pipe(Effect.option),
    ] as const,
    {concurrency: 2},
  );
  if (Option.isNone(manifestCatalog)) return catalog;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const graphCatalog: GraphCatalog = catalog;
  const readyWorktreePaths = graphCatalog.repositories.flatMap(repository =>
    repository.views.flatMap(view =>
      view.localAssociation.state === 'verified' && view.localAssociation.path ? [view.localAssociation.path] : [],
    ),
  );
  const readinessMayBeTruncated = graphCatalog.repositories.some(repository => repository.viewsTruncated);
  const configuredProjects = yield* Effect.forEach(
    manifestCatalog.value.projects,
    project =>
      configuredProjectGraphState(
        fs,
        path,
        system.platform,
        project.manifest.path,
        readyWorktreePaths,
        readinessMayBeTruncated,
      ).pipe(
        Effect.map(
          graphState =>
            ({
              ...project.display,
              graphState,
              ...(project.manifest.graph === undefined
                ? {}
                : {scopeId: `code-graph-scope:${sha256HexSync(project.manifest.uri)}`}),
            }) satisfies GraphConfiguredProject,
        ),
      ),
    {concurrency: 16},
  );
  return {
    ...catalog,
    configuredProjects,
    manifestRevision: manifestCatalog.value.revision,
  } satisfies GraphCatalog;
});

export const runManagerManifestProjectGraphIndex = Effect.fn('managerGraphProjects.runManifestProjectGraphIndex')(
  function* (config: RuntimeConfig, body: Record<string, unknown>) {
    const projectName = yield* Effect.try({
      try: () => requireString(body.project, 'project'),
      catch: cause => ManagerGraphProjectActionError.of('graph-project-unavailable', String(cause)),
    });
    const expectedRevision = yield* Effect.try({
      try: () => requireManifestRevision(body.expectedRevision),
      catch: cause => ManagerGraphProjectActionError.of('graph-project-unavailable', String(cause)),
    });
    const catalog = yield* readManagerGraphManifestCatalog(config).pipe(
      Effect.mapError(() =>
        ManagerGraphProjectActionError.of(
          'graph-project-unavailable',
          'Configured projects could not be read. Refresh Manager and retry.',
        ),
      ),
    );
    if (catalog.revision !== expectedRevision) {
      return yield* ManagerGraphProjectActionError.of(
        'graph-project-stale',
        'Configured projects changed. Refresh Manager before choosing a project to index.',
      );
    }
    const project = catalog.projects.find(
      candidate => candidate.manifest.name.toLowerCase() === projectName.toLowerCase(),
    );
    if (!project) {
      return yield* ManagerGraphProjectActionError.of(
        'graph-project-stale',
        'The selected configured project is no longer available. Refresh Manager and choose again.',
      );
    }
    const {identity} = yield* Effect.gen(function* () {
      const system = yield* SystemInfo;
      if (managerProjectPathIsForeign(project.manifest.path, system.platform)) {
        return yield* ManagerGraphProjectCatalogError.make({message: 'Configured project path is for another host.'});
      }
      const exactPath = yield* expandPath(project.manifest.path);
      return yield* resolveAndRecordCodeGraphLocalAssociation(config.agentContextHome, exactPath);
    }).pipe(
      Effect.mapError(() =>
        ManagerGraphProjectActionError.of(
          'graph-project-unavailable',
          'The selected configured project is not an available local Git repository. Check its manifest path and retry.',
        ),
      ),
    );
    const expectedIdentity = {
      checkoutId: identity.checkoutId,
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
    } satisfies RepositoryIdentityExpectation;
    const captured = yield* captureConsole(
      runIsolatedCodeGraphIndexSnapshot({
        cwd: identity.repoRoot,
        expectedIdentity,
        force: body.full === true,
        manifestPath: config.manifestPath,
        manifestRevision: catalog.revision,
        project: {name: project.manifest.name, uri: project.manifest.uri, graph: project.manifest.graph},
        threadnoteHome: config.agentContextHome,
      }).pipe(
        Effect.flatMap(summary =>
          Console.log(
            `Ready in an isolated process · ${summary.snapshot.fileCount.toLocaleString()} files · ` +
              `${summary.snapshot.symbolCount.toLocaleString()} symbols · ` +
              `${summary.snapshot.edgeCount.toLocaleString()} edges`,
          ),
        ),
      ),
    );
    return {output: captured.output};
  },
);

/** Resolve scope before a child starts; ambiguity is an explicit selection response. */
export const prepareManagerGraphIndexScope = Effect.fn('managerGraphProjects.prepareIndexScope')(function* (
  config: RuntimeConfig,
  cwd: string,
  body: Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(config.manifestPath))) {
    if (body.project !== undefined) {
      return yield* ManagerGraphProjectActionError.of(
        'graph-project-stale',
        'Configured projects changed. Refresh Manager and choose again.',
      );
    }
    return {state: 'resolved', project: undefined, manifestRevision: undefined} as const;
  }
  const catalog = yield* readManagerGraphManifestCatalog(config);
  const projectName = yield* Effect.try({
    try: () => (body.project === undefined ? undefined : requireString(body.project, 'project')),
    catch: () => ManagerGraphProjectActionError.of('graph-project-unavailable', 'Choose a configured graph project.'),
  });
  if (projectName !== undefined && body.expectedRevision !== catalog.revision) {
    return yield* ManagerGraphProjectActionError.of(
      'graph-project-stale',
      'Configured projects changed. Refresh Manager before choosing a scope to index.',
    );
  }
  return yield* resolveCodeGraphScopeRoute(config.manifestPath, cwd, projectName, catalog.revision).pipe(
    Effect.map(
      route =>
        ({
          state: 'resolved',
          manifestRevision: catalog.revision,
          project:
            route.state === 'selected'
              ? {name: route.project.name, uri: route.project.uri, graph: route.project.graph}
              : undefined,
        }) as const,
    ),
    Effect.catchTag('CodeGraphScopeRoutingError', error => {
      if (!error.projects?.length) return Effect.fail(error);
      return Effect.succeed({
        state: 'selection-required',
        scopeSelection: {expectedRevision: catalog.revision, projects: error.projects},
      } as const);
    }),
  );
});

const readManagerGraphManifestCatalog = Effect.fn('managerGraphProjects.readManifestCatalog')(function* (
  config: RuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(config.manifestPath);
  const manifest = yield* Effect.try({
    try: () => parseSeedManifest(raw, config.manifestPath),
    catch: () => ManagerGraphProjectCatalogError.make({message: 'Configured projects could not be parsed.'}),
  });
  yield* Effect.try({
    try: () => assertManagerGraphProjectManifest(manifest),
    catch: cause =>
      Schema.is(ManagerGraphProjectCatalogError)(cause)
        ? cause
        : ManagerGraphProjectCatalogError.make({message: 'Configured projects are invalid.'}),
  });
  const observed = yield* observeManagerManifestProjects(manifest.projects, 0);
  return {
    projects: observed.map((display, index) => ({
      display: {folder: display.folder, name: display.name, path: display.path},
      manifest: manifest.projects[index],
    })),
    revision: sha256HexSync(raw),
  } satisfies ManagerGraphManifestCatalog;
});

function configuredProjectGraphState(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  platform: NodeJS.Platform,
  manifestPath: string,
  readyWorktreePaths: readonly string[],
  readinessMayBeTruncated: boolean,
) {
  const foreignState = foreignConfiguredProjectGraphState(manifestPath, platform, readinessMayBeTruncated);
  if (foreignState !== undefined) return Effect.succeed(foreignState);
  if (readyWorktreePaths.length === 0) {
    return Effect.succeed(readinessMayBeTruncated ? ('unknown' as const) : ('not-indexed' as const));
  }
  return Effect.gen(function* () {
    const expandedPath = yield* expandPath(manifestPath);
    const canonicalPath = yield* fs.realPath(expandedPath).pipe(Effect.option);
    if (
      Option.isSome(canonicalPath) &&
      canonicalConfiguredProjectHasReadyGraph(path, canonicalPath.value, readyWorktreePaths)
    ) {
      return 'ready' as const;
    }
    return readinessMayBeTruncated ? ('unknown' as const) : ('not-indexed' as const);
  });
}

export function foreignConfiguredProjectGraphState(
  manifestPath: string,
  platform: NodeJS.Platform,
  readinessMayBeTruncated: boolean,
): GraphConfiguredProject['graphState'] | undefined {
  if (!managerProjectPathIsForeign(manifestPath, platform)) return undefined;
  return readinessMayBeTruncated ? 'unknown' : 'not-indexed';
}

export function canonicalConfiguredProjectHasReadyGraph(
  path: Path.Path,
  projectPath: string,
  readyWorktreePaths: readonly string[],
): boolean {
  return readyWorktreePaths.some(worktreePath => {
    if (!path.isAbsolute(projectPath) || !path.isAbsolute(worktreePath)) return false;
    const relative = path.relative(worktreePath, projectPath);
    return (
      relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  });
}

function assertManagerGraphProjectManifest(manifest: SeedManifest): void {
  if (manifest.projects.length > MANAGER_GRAPH_PROJECT_MAXIMUM) {
    throw ManagerGraphProjectCatalogError.make({message: 'The seed manifest has too many configured projects.'});
  }
  const names = new Set<string>();
  for (const project of manifest.projects) {
    if (!managerGraphProjectNameIsSafe(project.name) || !managerGraphProjectPathIsSafe(project.path)) {
      throw ManagerGraphProjectCatalogError.make({message: 'A configured project name or path is invalid.'});
    }
    const key = project.name.toLowerCase();
    if (names.has(key))
      throw ManagerGraphProjectCatalogError.make({message: 'Configured project names must be unique.'});
    names.add(key);
  }
}

function managerGraphProjectNameIsSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    UTF8.encode(value).byteLength <= MANAGER_GRAPH_PROJECT_NAME_BYTES_MAXIMUM &&
    !hasControlCharacter(value)
  );
}

function managerGraphProjectPathIsSafe(value: string): boolean {
  return (
    value.length > 0 &&
    UTF8.encode(value).byteLength <= MANAGER_GRAPH_PROJECT_PATH_BYTES_MAXIMUM &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function requireManifestRevision(value: unknown): string {
  const revision = requireString(value, 'expectedRevision');
  if (!/^[0-9a-f]{64}$/.test(revision)) {
    throw ManagerGraphProjectCatalogError.make({message: 'Provide expectedRevision as an exact manifest revision.'});
  }
  return revision;
}
