import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseSeedManifest} from '@threadnote/workspace/manifest';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {runBinaryCommandEffect} from '@threadnote/platform/command';
import {resolveRepositoryIdentity} from '../repository.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_GRAPH_SCOPE_ROUTING_EXIT_CODE = 78;
export const CODE_GRAPH_ISOLATED_BUILDER_ENV = 'THREADNOTE_CODE_GRAPH_ISOLATED_BUILDER';
export const CODE_GRAPH_EXPECTED_SCOPE_ID_ENV = 'THREADNOTE_CODE_GRAPH_EXPECTED_SCOPE_ID';

export const CODE_GRAPH_REFRESH_SCOPE_ROUTE_ENV = 'THREADNOTE_CODE_GRAPH_REFRESH_SCOPE_ROUTE';
export const CODE_GRAPH_ABSENT_MANIFEST_REVISION = 'absent';

export const CODE_GRAPH_EXPECTED_MANIFEST_REVISION_ENV = 'THREADNOTE_CODE_GRAPH_EXPECTED_MANIFEST_REVISION';

const WORKTREE_LIST_OUTPUT_BYTES_MAXIMUM = 1_048_576;
const WORKTREE_LIST_TIMEOUT_MS = 10_000;
const WORKTREE_ROOT_OUTPUT_BYTES_MAXIMUM = 4_096;

export class CodeGraphScopeRoutingError extends Schema.TaggedError<
  CodeGraphScopeRoutingError,
  {readonly brand: unique symbol}
>()('CodeGraphScopeRoutingError', {
  message: Schema.String,
  projects: Schema.optionalKey(Schema.Array(Schema.Struct({name: Schema.String, roots: Schema.Array(Schema.String)}))),
}) {}

export type CodeGraphScopeRoute =
  | {readonly project: Pick<ProjectManifest, 'graph' | 'name' | 'uri'>; readonly state: 'selected'}
  | {readonly state: 'full'};

/**
 * Route only a caller that lies in exactly one configured graph project. A
 * root-level caller of a multi-project repository therefore remains explicit
 * rather than silently selecting an arbitrary partial view.
 */
export const resolveCodeGraphScopeRoute = Effect.fn('codeGraph.resolveScopeRoute')(function* (
  manifestPath: string,
  cwd: string,
  explicitProject?: string,
  expectedManifestRevision?: string,
  selection?: 'full',
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(manifestPath))) {
    if (expectedManifestRevision !== undefined && expectedManifestRevision !== CODE_GRAPH_ABSENT_MANIFEST_REVISION)
      return yield* manifestRevisionChanged();
    return {state: 'full'} as const satisfies CodeGraphScopeRoute;
  }
  const raw = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.mapError(() => CodeGraphScopeRoutingError.make({message: 'Configured graph manifest could not be read.'})),
    );
  if (expectedManifestRevision !== undefined && sha256HexSync(raw) !== expectedManifestRevision) {
    return yield* manifestRevisionChanged();
  }
  const manifest = yield* Effect.try({
    try: () => parseSeedManifest(raw, manifestPath),
    catch: () => CodeGraphScopeRoutingError.make({message: 'Configured graph manifest could not be read.'}),
  });
  if (selection === 'full') return {state: 'full'} as const satisfies CodeGraphScopeRoute;
  const path = yield* Path.Path;
  const caller = path.resolve(cwd);
  if (explicitProject !== undefined) {
    const requested = Effect2.pipe(explicitProject, EffectString.trim, EffectString.toLowerCase);
    const exactProject = Option.getOrUndefined(
      EffectArray.findFirst(
        manifest.projects,
        candidate => Effect2.pipe(candidate.name, EffectString.toLowerCase) === requested,
      ),
    );
    const aliasProjects = exactProject === undefined ? graphRootAliasProjects(manifest.projects, requested) : [];
    const localAliasProjects =
      aliasProjects.length === 0 ? [] : yield* projectsInCallerRepository(aliasProjects, caller);
    if (localAliasProjects.length > 1) {
      return yield* CodeGraphScopeRoutingError.make({
        message: `Graph root alias "${explicitProject}" belongs to multiple configured projects. Select one of: ${EffectArray.join(
          EffectArray.map(localAliasProjects, project => project.name).sort(),
          ', ',
        )}.`,
      });
    }
    const project = exactProject ?? localAliasProjects[0];
    if (project === undefined) {
      if (aliasProjects.length > 0) {
        return yield* CodeGraphScopeRoutingError.make({
          message: `Graph root alias "${explicitProject}" is outside this cwd. Choose a project in this repository.`,
        });
      }
      return yield* CodeGraphScopeRoutingError.make({
        message:
          `No configured graph project named "${explicitProject}" exists. ` +
          'Run `threadnote project list` to see configured names, ' +
          'run `threadnote project create <name> --path <repository>` to add one, ' +
          'or omit project/--project to infer scope from callerCwd/--cwd. ' +
          'The selector also accepts an unambiguous configured graph root.',
      });
    }
    const root = yield* expandPath(project.path);
    const [callerIdentity, projectIdentity] = yield* Effect.all([
      resolveRepositoryIdentity(caller),
      resolveRepositoryIdentity(root).pipe(Effect.option),
    ]);
    if (!sameCheckoutRepository(callerIdentity, projectIdentity)) {
      return yield* CodeGraphScopeRoutingError.make({
        message: `Configured project "${project.name}" is outside this cwd. Choose a project in this repository.`,
      });
    }
    return selectedRoute(project);
  }
  const configured = EffectArray.filter(manifest.projects, project => project.graph !== undefined);
  const expanded = yield* Effect.forEach(configured, project =>
    expandPath(project.path).pipe(Effect.map(root => ({project, root}))),
  );
  const localMatches = EffectArray.filter(
    expanded,
    (candidate, __effectArrayIndex2) => __effectArrayIndex2 in expanded && pathContains(path, candidate.root, caller),
  );
  const localGraphRootMatches = EffectArray.filter(localMatches, candidate => {
    const roots = candidate.project.graph?.roots;
    return (
      roots !== undefined &&
      EffectArray.some(roots, root => pathContains(path, path.resolve(candidate.root, root), caller))
    );
  });
  let matches = EffectArray.map(
    localGraphRootMatches.length > 0 ? localGraphRootMatches : localMatches,
    candidate => candidate.project,
  );
  if (matches.length === 0) {
    const canonicalCaller = yield* fs.realPath(caller).pipe(Effect.orElseSucceed(() => caller));
    const [worktreeRoots, callerWorktreeRoot] = yield* Effect.all([
      resolveCheckoutWorktreeRoots(caller).pipe(Effect.option),
      resolveGitWorktreeRoot(caller).pipe(Effect.option),
    ]);
    if (Option.isSome(worktreeRoots)) {
      const matchedRoots = new Set(
        EffectArray.map(
          EffectArray.filter(
            expanded,
            (candidate, __effectArrayIndex2) =>
              __effectArrayIndex2 in expanded &&
              EffectArray.some(worktreeRoots.value, root => pathContains(path, root, candidate.root)),
          ),
          candidate => candidate.root,
        ),
      );
      const unresolvedRoots = [
        ...new Set(
          EffectArray.filter(
            EffectArray.map(expanded, candidate => candidate.root),
            root => !matchedRoots.has(root),
          ),
        ),
      ];
      const resolvedRoots = yield* Effect.forEach(
        unresolvedRoots,
        root =>
          resolveGitWorktreeRoot(root).pipe(
            Effect.map(worktreeRoot => [root, worktreeRoot] as const),
            Effect.option,
          ),
        {concurrency: 4},
      );
      for (const resolved of resolvedRoots) {
        if (Option.isNone(resolved)) continue;
        const [root, worktreeRoot] = resolved.value;
        if (EffectArray.some(worktreeRoots.value, candidate => pathContains(path, candidate, worktreeRoot))) {
          matchedRoots.add(root);
        }
      }
      const localProjects = yield* rootedProjectsInCallerRepository(
        EffectArray.filter(
          expanded,
          (candidate, __effectArrayIndex) => __effectArrayIndex in expanded && matchedRoots.has(candidate.root),
        ),
        caller,
      );
      matches = preferCallerGraphRootMatches(path, localProjects, canonicalCaller, callerWorktreeRoot);
    } else {
      matches = preferCallerGraphRootMatches(
        path,
        yield* rootedProjectsInCallerRepository(expanded, caller),
        canonicalCaller,
        callerWorktreeRoot,
      );
    }
  }
  if (matches.length === 0) return {state: 'full'} as const satisfies CodeGraphScopeRoute;
  const [project] = matches;
  if (matches.length === 1 && project !== undefined) return selectedRoute(project);
  const projects = [...matches].sort((left, right) => Effect2.pipe(left.name, EffectString.localeCompare(right.name)));
  const scopeChoices = EffectArray.join(
    EffectArray.map(projects, project => {
      const roots = project.graph?.roots.length ? EffectArray.join(project.graph.roots, ', ') : '.';
      return `- ${project.name}: ${roots}`;
    }),
    '\n',
  );
  return yield* CodeGraphScopeRoutingError.make({
    projects: EffectArray.map(projects, project => ({name: project.name, roots: project.graph?.roots ?? []})),
    message: `Graph scope is ambiguous for this cwd: ${matches.length} configured scopes match. Set project (or CLI --project) to one of:\n${scopeChoices}`,
  });
});

export interface CodeGraphResolvedRefreshRoute {
  readonly manifestPath: string;
  readonly manifestRevision: string;
  readonly route: CodeGraphScopeRoute;
}

/** Bind one manifest observation before demand identity, local deduplication or child launch. */
export const resolveCodeGraphRefreshRoute = Effect.fn('codeGraph.resolveRefreshRoute')(function* (
  manifestPath: string,
  cwd: string,
  project?: Pick<ProjectManifest, 'graph' | 'uri'> & {readonly name?: string},
  expectedManifestRevision?: string,
  projectFreshness: 'verify' | 'resolve' = 'verify',
) {
  if (
    project !== undefined &&
    !Effect2.pipe(project.name, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  ) {
    return yield* CodeGraphScopeRoutingError.make({
      message: 'Graph refresh requires a configured project name. Select a project before refreshing.',
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const manifestRevision = (yield* fs.exists(manifestPath))
    ? sha256HexSync(yield* fs.readFileString(manifestPath))
    : CODE_GRAPH_ABSENT_MANIFEST_REVISION;
  if (expectedManifestRevision !== undefined && expectedManifestRevision !== manifestRevision)
    return yield* manifestRevisionChanged();
  const route = yield* resolveCodeGraphScopeRoute(manifestPath, cwd, project?.name, manifestRevision);
  if (
    project !== undefined &&
    (route.state !== 'selected' ||
      route.project.uri !== project.uri ||
      (projectFreshness === 'verify' && graphDefinition(route.project.graph) !== graphDefinition(project.graph)))
  ) {
    return yield* CodeGraphScopeRoutingError.make({
      message: 'Configured graph refresh target changed. Resolve the project again before refreshing.',
    });
  }
  return {manifestPath, manifestRevision, route} satisfies CodeGraphResolvedRefreshRoute;
});

function manifestRevisionChanged(): CodeGraphScopeRoutingError {
  return CodeGraphScopeRoutingError.make({
    message: 'Configured graph manifest changed. Refresh Manager before indexing.',
  });
}

function projectsInCallerRepository(projects: readonly ProjectManifest[], caller: string) {
  return Effect.gen(function* () {
    const rooted = yield* Effect.forEach(
      projects,
      project => expandPath(project.path).pipe(Effect.map(root => ({project, root}))),
      {concurrency: 4},
    );
    return yield* rootedProjectsInCallerRepository(rooted, caller);
  });
}

function rootedProjectsInCallerRepository(
  candidates: readonly {readonly project: ProjectManifest; readonly root: string}[],
  caller: string,
) {
  return Effect.gen(function* () {
    const callerIdentity = yield* resolveRepositoryIdentity(caller);
    const roots = [...new Set(EffectArray.map(candidates, candidate => candidate.root))];
    const identities = yield* Effect.forEach(
      roots,
      root =>
        resolveRepositoryIdentity(root).pipe(
          Effect.option,
          Effect.map(identity => [root, identity] as const),
        ),
      {concurrency: 4},
    );
    const byRoot = new Map(identities);
    return EffectArray.map(
      EffectArray.filter(
        candidates,
        (candidate, __effectArrayIndex2) =>
          __effectArrayIndex2 in candidates &&
          sameCheckoutRepository(callerIdentity, byRoot.get(candidate.root) ?? Option.none()),
      ),
      candidate => candidate.project,
    );
  });
}

function sameCheckoutRepository(
  caller: {readonly checkoutId: string; readonly repositoryId: string},
  project: Option.Option<{readonly checkoutId: string; readonly repositoryId: string}>,
): boolean {
  return (
    Option.isSome(project) &&
    project.value.checkoutId === caller.checkoutId &&
    project.value.repositoryId === caller.repositoryId
  );
}

const resolveCheckoutWorktreeRoots = Effect.fn('codeGraph.resolveCheckoutWorktreeRoots')(function* (cwd: string) {
  const path = yield* Path.Path;
  const result = yield* runBinaryCommandEffect('git', ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'], {
    maxOutputBytes: WORKTREE_LIST_OUTPUT_BYTES_MAXIMUM,
    timeoutMs: WORKTREE_LIST_TIMEOUT_MS,
  });
  const roots = parseCheckoutWorktreeRoots(result.stdout);
  if (roots === undefined || EffectArray.some(roots, root => !path.isAbsolute(root))) {
    return yield* CodeGraphScopeRoutingError.make({message: 'Git worktree registry could not be read.'});
  }
  return roots;
});

const resolveGitWorktreeRoot = Effect.fn('codeGraph.resolveGitWorktreeRoot')(function* (cwd: string) {
  const path = yield* Path.Path;
  const result = yield* runBinaryCommandEffect(
    'git',
    ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel'],
    {
      maxOutputBytes: WORKTREE_ROOT_OUTPUT_BYTES_MAXIMUM,
      timeoutMs: WORKTREE_LIST_TIMEOUT_MS,
    },
  );
  const root = parseGitWorktreeRoot(result.stdout);
  if (root === undefined || !path.isAbsolute(root)) {
    return yield* CodeGraphScopeRoutingError.make({message: 'Git worktree root could not be read.'});
  }
  return root;
});

function parseCheckoutWorktreeRoots(output: Uint8Array): readonly string[] | undefined {
  if (output.byteLength === 0 || output.byteLength > WORKTREE_LIST_OUTPUT_BYTES_MAXIMUM) return undefined;
  try {
    const records = Effect2.pipe(
      new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output),
      EffectString.split('\0'),
    );
    if (records.pop() !== '') return undefined;
    const roots: string[] = [];
    let expectsWorktree = true;
    for (const record of records) {
      if (record === '') {
        expectsWorktree = true;
      } else if (expectsWorktree) {
        if (!Effect2.pipe(record, EffectString.startsWith('worktree ')) || record.length === 'worktree '.length)
          return undefined;
        roots.push(Effect2.pipe(record, EffectString.slice('worktree '.length)));
        expectsWorktree = false;
      }
    }
    return roots.length > 0 ? [...new Set(roots)] : undefined;
  } catch {
    return undefined;
  }
}

function parseGitWorktreeRoot(output: Uint8Array): string | undefined {
  if (output.byteLength === 0 || output.byteLength > WORKTREE_ROOT_OUTPUT_BYTES_MAXIMUM) return undefined;
  try {
    const root = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output);
    return Effect2.pipe(root, EffectString.endsWith('\n')) &&
      !Effect2.pipe(root, __effectPipeInput => {
        const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.slice(0, -1));
        const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.includes('\n'));
        return __effectPipeStage1;
      })
      ? Effect2.pipe(root, EffectString.slice(0, -1))
      : undefined;
  } catch {
    return undefined;
  }
}

function pathContains(path: Path.Path, root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !Effect2.pipe(relative, EffectString.startsWith(`..${path.sep}`)) &&
      !path.isAbsolute(relative))
  );
}

function preferCallerGraphRootMatches(
  path: Path.Path,
  projects: readonly ProjectManifest[],
  caller: string,
  callerWorktreeRoot: Option.Option<string>,
): ProjectManifest[] {
  if (Option.isNone(callerWorktreeRoot)) return [...projects];
  const graphRootMatches = EffectArray.filter(
    projects,
    (project, __effectArrayIndex) =>
      __effectArrayIndex in projects &&
      Boolean(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(project.graph?.roots), __effectArrayReceiver =>
            EffectArray.some(
              __effectArrayReceiver,
              __effectArrayValue =>
                !!(root => pathContains(path, path.resolve(callerWorktreeRoot.value, root), caller))(
                  __effectArrayValue,
                ),
            ),
          ),
        ),
      ),
  );
  return graphRootMatches.length > 0 ? graphRootMatches : [...projects];
}

function graphRootAliasProjects(projects: readonly ProjectManifest[], requested: string): readonly ProjectManifest[] {
  const normalizedRequested = normalizeGraphRootAlias(requested);
  return EffectArray.filter(
    projects,
    (project, __effectArrayIndex) =>
      __effectArrayIndex in projects &&
      Boolean(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(project.graph?.roots), __effectArrayReceiver =>
            EffectArray.some(__effectArrayReceiver, root => {
              const normalizedRoot = normalizeGraphRootAlias(root);
              return (
                normalizedRoot === normalizedRequested ||
                Effect2.pipe(normalizedRoot, EffectString.split('/')).at(-1) === normalizedRequested
              );
            }),
          ),
        ),
      ),
  );
}

function normalizeGraphRootAlias(value: string): string {
  return Effect2.pipe(
    value,
    EffectString.trim,
    EffectString.replaceAll('\\', '/'),
    EffectString.replace(/^\.\//u, ''),
    EffectString.replace(/\/+$/u, ''),
    EffectString.toLowerCase,
  );
}

function selectedRoute(
  project: Pick<ProjectManifest, 'graph' | 'name' | 'uri'>,
): Extract<CodeGraphScopeRoute, {state: 'selected'}> {
  return {project, state: 'selected'};
}

function graphDefinition(graph: ProjectManifest['graph']): string {
  return JSON.stringify(
    graph === undefined
      ? null
      : {
          closure: graph.closure,
          include: [...new Set(graph.include ?? [])].sort(),
          roots: [...new Set(graph.roots)].sort(),
        },
  );
}
