import {Cause, Clock, Crypto, Effect, Fiber, FileSystem, Path, Predicate, Scope, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq} from 'yaml';
import * as ContextBrief from '../context_brief/index.js';
import {
  findCodeGraphWorksetPath,
  inspectCodeGraphWorksetTopology,
  traceCodeGraphWorksetImpact,
} from '@threadnote/graph/cross_repository/runtime';
import {codeGraphWorksetCatalogLayout} from '@threadnote/graph/workset_catalog/layout';
import {prepareManagerCodeGraphWorksetIsolated} from '@threadnote/graph/workset_catalog/isolated_prepare';
import {CodeGraphWorksetCatalogError} from '@threadnote/graph/workset_catalog/types';
import {
  inspectCodeGraphWorksetStatus,
  type PrepareCodeGraphWorksetOptionsV1,
  type CodeGraphWorksetPrepareResultV1,
} from '@threadnote/graph/workset_catalog/workset';
import {
  readPublishedCodeGraphWorksetCatalogGeneration,
  retireCodeGraphWorksetPublication,
} from '@threadnote/graph/workset_catalog/store';
import {continueCodeGraphWorksetQueryV2, queryCodeGraphWorksetV2} from '@threadnote/graph/workset/query_v2';
import {CODE_GRAPH_WORKSET_ROUTER_LIMITS} from '@threadnote/graph/workset/router';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import {queueCodeGraphScopeRetirements, reconcileCodeGraphScopeRetirements} from '@threadnote/graph/scope/retirement';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {ApplicationServices} from '../effect/runtime.js';
import {parseSeedManifest, readSeedManifest} from '@threadnote/workspace/manifest';
import {
  observeManagerManifestProjects,
  validateManagerProjectRoots,
  type ManagerProjectRootValidation,
} from './project/roots.js';
import {updateManagerWorksetPrepareProgress} from '@threadnote/manager/workset/progress';
import {managerWorksetCatalogHttp} from '@threadnote/manager/workset/catalog_http';
import {validateManagerConfiguredProjectPath, validateManagerConfiguredProjectUri} from './project/manifest_values.js';
import {validateProjectSeedPatterns} from '../seed_pattern.js';
import {
  copyManagerProjectGraph,
  managerProjectGraphsEqual,
  managerProjectGraphIdentityEqual,
  managerProjectsEqual,
  managerProjectSeedsEqual,
  managerProjectYamlDocumentSupported,
  previewConfiguredManagerProjectGraphScope,
  reconcileManagerProjectGraph,
  validateManagerProjectGraphInput,
} from './project/graph_scope.js';
import type {ProjectManifest, RuntimeConfig, SeedManifest, WorksetManifest} from '@threadnote/workspace/config';

const UTF8 = new TextEncoder();
const MANAGER_WORKSET_DEFINITION_MAXIMUM = 4_096;
const MANAGER_WORKSET_MEMBER_MAXIMUM = 4_096;
const MANAGER_WORKSET_NAME_BYTES_MAXIMUM = 256;
const MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM = 4_096;
const MANAGER_PROJECT_VALUE_BYTES_MAXIMUM = 4_096;
const MANAGER_WORKSET_QUERY_BYTES_MAXIMUM = CODE_GRAPH_WORKSET_ROUTER_LIMITS.queryBytesMaximum;
const MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM = 4_096;
const MANAGER_WORKSET_JOB_MAXIMUM = 32;
const MANAGER_WORKSET_BRANCH_OBSERVATION_MAXIMUM = 128;
const MANAGER_WORKSET_PREPARE_CONCURRENCY_MAXIMUM = 8;
const MANAGER_WORKSET_RESPONSE_TOKENS_MAXIMUM = 1_500;
const PROJECT_NOT_FOUND_MESSAGE =
  'Threadnote project not found. Create it in Manager or with `threadnote project create <name>`.';
const MANAGER_WORKSET_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 10_000,
} as const;
const SHA256 = /^[0-9a-f]{64}$/u;

import type {
  ManagerWorksetProjectSummary,
  ManagerManifestProject,
  ManagerWorksetDefinition,
  ManagerWorksetDefinitionSummary,
  ManagerWorksetCatalog,
  ManagerWorksetDefinitionMutation,
  ManagerWorksetDefinitionMutationResult,
  ManagerManifestProjectMutation,
  ManagerManifestProjectMutationResult,
  ManagerWorksetPrepareJob,
  ManagerWorksetPrepareJobSummary,
  ManagerWorksetApiResponse,
} from '@threadnote/manager/workset/contracts';
export type {
  ManagerWorksetDefinitionMember,
  ManagerWorksetProjectSummary,
  ManagerManifestProject,
  ManagerWorksetDefinition,
  ManagerWorksetDefinitionSummary,
  ManagerWorksetCatalog,
  ManagerWorksetDefinitionMutation,
  ManagerWorksetDefinitionMutationResult,
  ManagerManifestProjectMutation,
  ManagerManifestProjectMutationResult,
  ManagerWorksetJobStatus,
  ManagerWorksetPrepareJob,
  ManagerWorksetPrepareJobSummary,
  ManagerWorksetApiResponse,
} from '@threadnote/manager/workset/contracts';

export interface ManagerWorksetApiRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly contextKey: object;
  readonly jobScope: Scope.Scope;
  readonly method: string;
  readonly prepareWorkset?: (
    config: RuntimeConfig,
    worksetName: string,
    options: PrepareCodeGraphWorksetOptionsV1,
  ) => Effect.Effect<CodeGraphWorksetPrepareResultV1, unknown, ApplicationServices>;
  readonly url: URL;
}

interface InternalManagerWorksetPrepareJob {
  fiber?: Fiber.Fiber<void>;
  job: ManagerWorksetPrepareJob;
}

interface ManagerWorksetJobRegistry {
  readonly jobs: Map<string, InternalManagerWorksetPrepareJob>;
  lifecycleScope?: Scope.Scope;
  mutating: boolean;
  starting: boolean;
}

class ManagerWorksetApiError extends Schema.TaggedError<ManagerWorksetApiError>()('ManagerWorksetApiError', {
  code: Schema.String,
  message: Schema.String,
  retryAfterMilliseconds: Schema.optionalKey(Schema.Finite),
  status: Schema.Finite,
}) {
  static of(code: string, message: string, status: number, retryAfterMilliseconds?: number): ManagerWorksetApiError {
    return ManagerWorksetApiError.make({
      code,
      message,
      status,
      ...(retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds}),
    });
  }
}

const JOB_REGISTRIES = new WeakMap<object, ManagerWorksetJobRegistry>();

export function managerWorksetRequestAllowedDuringMaintenance(method: string, pathname: string): boolean {
  return (
    pathname === '/api/worksets' ||
    (method === 'GET' &&
      (pathname === '/api/worksets/definition' ||
        pathname === '/api/worksets/project' ||
        pathname === '/api/worksets/project-graph-preview')) ||
    (method === 'GET' && (pathname === '/api/worksets/jobs' || pathname.startsWith('/api/worksets/jobs/'))) ||
    pathname === '/api/worksets/definitions' ||
    pathname === '/api/worksets/projects' ||
    pathname === '/api/worksets/jobs/cancel'
  );
}

export function isManagerWorksetApiPath(pathname: string): boolean {
  return pathname === '/api/worksets' || pathname.startsWith('/api/worksets/');
}

export function managerWorksetCatalogFromManifest(
  manifest: SeedManifest,
  revision: string,
  editability: ManagerWorksetCatalog['editability'] = {state: 'editable'},
  projects: readonly Omit<ManagerWorksetProjectSummary, 'worksetCount' | 'worksets'>[] = manifest.projects.map(
    project => ({
      branchState: 'not-observed',
      folder: trimTrailingCharacters(project.path, '/\\').split(/[\\/]/u).at(-1) || safeLabel(project.name),
      name: safeLabel(project.name),
      path: safeLocalPath(project.path),
    }),
  ),
  projectEditability: ManagerWorksetCatalog['projectEditability'] = {state: 'editable'},
): ManagerWorksetCatalog {
  if (!SHA256.test(revision)) throw new Error('Manager workset catalog revision is invalid.');
  assertUniqueManagerManifestIdentity(manifest);
  if ((manifest.worksets?.length ?? 0) > MANAGER_WORKSET_DEFINITION_MAXIMUM) {
    throw new Error(`The seed manifest exceeds ${MANAGER_WORKSET_DEFINITION_MAXIMUM} worksets.`);
  }
  if (manifest.projects.length > MANAGER_WORKSET_MEMBER_MAXIMUM) {
    throw new Error(`The seed manifest exceeds ${MANAGER_WORKSET_MEMBER_MAXIMUM} projects.`);
  }
  const projectWorksets = new Map<string, string[]>();
  for (const workset of manifest.worksets ?? []) {
    for (const project of new Set(workset.projects.map(name => name.toLowerCase()))) {
      const names = projectWorksets.get(project) ?? [];
      names.push(safeLabel(workset.name));
      projectWorksets.set(project, names);
    }
  }
  const definitions = (manifest.worksets ?? []).map(workset => {
    if (workset.projects.length > MANAGER_WORKSET_MEMBER_MAXIMUM) {
      throw new Error(`Workset ${safeLabel(workset.name)} exceeds the member limit.`);
    }
    return {
      ...(workset.description === undefined ? {} : {description: safeDescription(workset.description)}),
      memberCount: workset.projects.length,
      name: safeLabel(workset.name),
    } satisfies ManagerWorksetDefinitionSummary;
  });
  return {
    definitions,
    definitionSource: 'seed-manifest',
    editability,
    projectEditability,
    projects: projects.map(project => {
      const worksets = projectWorksets.get(project.name.toLowerCase()) ?? [];
      return {...project, worksets, worksetCount: worksets.length};
    }),
    projectsReadOnly: projectEditability.state === 'read-only',
    readOnly: editability.state === 'read-only',
    revision,
    type: 'manager-workset-catalog',
    version: 1,
  };
}

export const readManagerWorksetCatalog = Effect.fn('managerWorksets.readCatalog')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(config.manifestPath);
  const manifest = yield* parseManifestForMutation(raw, config.manifestPath);
  yield* managerWorksetValidation(() => assertUniqueManagerManifestIdentity(manifest));
  const document = parseDocument(raw, {keepSourceTokens: true});
  const symbolicTarget = yield* fs.readLink(config.manifestPath).pipe(Effect.option);
  const projects = yield* observeManagerManifestProjects(manifest.projects, MANAGER_WORKSET_BRANCH_OBSERVATION_MAXIMUM);
  const manifestIsSymbolic = symbolicTarget._tag === 'Some';
  return yield* managerWorksetValidation(() =>
    managerWorksetCatalogFromManifest(
      manifest,
      sha256HexSync(raw),
      manifestIsSymbolic
        ? {reason: 'manifest-symlink', state: 'read-only'}
        : managerWorksetYamlSupported(document)
          ? {state: 'editable'}
          : {reason: 'unsupported-workset-yaml', state: 'read-only'},
      projects,
      manifestIsSymbolic
        ? {reason: 'manifest-symlink', state: 'read-only'}
        : managerProjectYamlSupported(document)
          ? {state: 'editable'}
          : {reason: 'unsupported-project-yaml', state: 'read-only'},
    ),
  );
});

export const readManagerManifestProject = Effect.fn('managerWorksets.readProject')(function* (
  config: RuntimeConfig,
  projectName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(config.manifestPath);
  const manifest = yield* parseManifestForMutation(raw, config.manifestPath);
  yield* managerWorksetValidation(() => assertUniqueManagerManifestIdentity(manifest));
  const project = manifest.projects.find(item => item.name.toLowerCase() === projectName.toLowerCase());
  if (!project) return yield* ManagerWorksetApiError.of('project-not-found', PROJECT_NOT_FOUND_MESSAGE, 404);
  const document = parseDocument(raw, {keepSourceTokens: true});
  const projects = document.get('projects', true);
  const rawUri = isSeq(projects)
    ? projects.items.flatMap(item => {
        if (!isMap(item) || String(item.get('name')).toLowerCase() !== project.name.toLowerCase()) return [];
        const value = item.get('uri');
        return typeof value === 'string' ? [value] : [];
      })[0]
    : undefined;
  return {
    ...(project.graph === undefined ? {} : {graph: project.graph}),
    name: project.name,
    path: project.path,
    seed: project.seed,
    uri: rawUri ?? project.uri,
  } satisfies ManagerManifestProject;
});

/** Read-only preview for a configured project's optional graph definition. */
export const previewManagerManifestProjectGraphScope = Effect.fn('managerWorksets.previewProjectGraphScope')(function* (
  config: RuntimeConfig,
  projectName: string,
) {
  return yield* previewConfiguredManagerProjectGraphScope(config, projectName).pipe(
    Effect.mapError(cause => ManagerWorksetApiError.of(cause.code, cause.message, cause.status)),
  );
});

export const readManagerWorksetDefinition = Effect.fn('managerWorksets.readDefinition')(function* (
  config: RuntimeConfig,
  worksetName: string,
) {
  const manifest = yield* readSeedManifest(config.manifestPath);
  yield* managerWorksetValidation(() => assertUniqueManagerManifestIdentity(manifest));
  const workset = manifest.worksets?.find(item => item.name.toLowerCase() === worksetName.toLowerCase());
  if (!workset) return yield* ManagerWorksetApiError.of('workset-not-found', 'Workset definition not found.', 404);
  const projects = new Map(manifest.projects.map(project => [project.name.toLowerCase(), project]));
  const observed = yield* observeManagerManifestProjects(
    workset.projects.flatMap(project => {
      const configured = projects.get(project.toLowerCase());
      return configured === undefined ? [] : [configured];
    }),
    MANAGER_WORKSET_BRANCH_OBSERVATION_MAXIMUM,
  );
  const observedByName = new Map(observed.map(project => [project.name.toLowerCase(), project]));
  const members = workset.projects.map(project => {
    const configured = observedByName.get(project.toLowerCase());
    const manifestProject = projects.get(project.toLowerCase());
    return {
      ...(configured !== undefined && 'branch' in configured && configured.branch !== undefined
        ? {branch: configured.branch}
        : {}),
      branchState: configured?.branchState ?? 'missing',
      configured: configured !== undefined,
      ...(configured === undefined
        ? {}
        : {
            folder: configured.folder,
            path: configured.path,
            ...(manifestProject === undefined ? {} : {uri: manifestProject.uri}),
          }),
      project: configured?.name ?? safeLabel(project),
    };
  });
  return {
    configuredMembers: members.filter(member => member.configured).length,
    ...(workset.description === undefined ? {} : {description: safeDescription(workset.description)}),
    members,
    name: safeLabel(workset.name),
    unresolvedMembers: members.filter(member => !member.configured).length,
  } satisfies ManagerWorksetDefinition;
});

export const mutateManagerWorksetDefinition = Effect.fn('managerWorksets.mutateDefinition')(function* (
  config: RuntimeConfig,
  mutation: ManagerWorksetDefinitionMutation,
) {
  const result = yield* mutateManagerManifest(
    config,
    mutation.expectedRevision,
    mutation.operation,
    assertSupportedManagerWorksetYaml,
    (document, manifest) => applyDefinitionMutation(document, manifest, mutation),
  );
  return result satisfies ManagerWorksetDefinitionMutationResult;
});

export const mutateManagerManifestProject = Effect.fn('managerWorksets.mutateProject')(function* (
  config: RuntimeConfig,
  mutation: ManagerManifestProjectMutation,
) {
  const result = yield* mutateManagerManifest(
    config,
    mutation.expectedRevision,
    mutation.operation,
    assertSupportedManagerProjectYaml,
    (document, manifest) => applyProjectMutation(document, manifest, mutation),
  );
  return result satisfies ManagerManifestProjectMutationResult;
});

interface ManagerManifestMutationChange {
  readonly changed: boolean;
  readonly normalizeProjectPath?: boolean;
  readonly projectCandidate?: ProjectManifest;
  readonly projectCurrentName?: string;
  readonly retireWorksets: readonly string[];
  readonly warnings: readonly string[];
}

function mutateManagerManifest<Operation extends string>(
  config: RuntimeConfig,
  expectedRevision: string,
  operation: Operation,
  validateDocument: (document: ReturnType<typeof parseDocument>) => void,
  apply: (document: ReturnType<typeof parseDocument>, manifest: SeedManifest) => ManagerManifestMutationChange,
) {
  return Effect.gen(function* () {
    yield* managerWorksetValidation(() => validateExpectedRevision(expectedRevision));
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = `${config.manifestPath}.worksets.lock`;
    const promoted = yield* withExclusiveFileLock(
      fs,
      codeGraphWorksetCatalogLayout(path, config.agentContextHome).prepareLockPath,
      MANAGER_WORKSET_LOCK_OPTIONS,
      withExclusiveFileLock(
        fs,
        lockPath,
        MANAGER_WORKSET_LOCK_OPTIONS,
        Effect.gen(function* () {
          const symbolicTarget = yield* fs.readLink(config.manifestPath).pipe(Effect.option);
          if (symbolicTarget._tag === 'Some') {
            return yield* ManagerWorksetApiError.of(
              'manifest-symlink',
              'Manager cannot edit projects or worksets through a symbolic-link manifest.',
              409,
            );
          }
          const raw = yield* fs.readFileString(config.manifestPath);
          const revision = sha256HexSync(raw);
          if (revision !== expectedRevision) {
            return yield* ManagerWorksetApiError.of(
              'revision-conflict',
              'The seed manifest changed after it was loaded. Refresh Worksets and retry.',
              409,
            );
          }
          const manifest = yield* parseManifestForMutation(raw, config.manifestPath);
          const document = parseDocument(raw, {keepSourceTokens: true});
          if (document.errors.length > 0) {
            return yield* ManagerWorksetApiError.of(
              'manifest-invalid',
              'The seed manifest contains invalid YAML.',
              409,
            );
          }
          const change = yield* managerWorksetValidation(() => {
            validateDocument(document);
            return apply(document, manifest);
          });
          if (!change.changed) {
            return {
              catalog: yield* managerWorksetValidation(() => managerWorksetCatalogFromManifest(manifest, revision)),
              changed: false,
              operation,
              retirementTargets: [],
              scopeRetirementTargets: [],
              warnings: change.warnings,
            };
          }
          const projectRootValidation = yield* validateManagerProjectRootMutation(manifest, change);
          if (
            projectRootValidation !== undefined &&
            change.projectCandidate !== undefined &&
            change.normalizeProjectPath === true &&
            projectRootValidation.path !== change.projectCandidate.path
          ) {
            setManagerProjectPath(document, change.projectCandidate.name, projectRootValidation.path);
          }
          const candidate = String(document);
          if (candidate === raw) {
            return {
              catalog: yield* managerWorksetValidation(() => managerWorksetCatalogFromManifest(manifest, revision)),
              changed: false,
              operation,
              retirementTargets: [],
              scopeRetirementTargets: [],
              warnings: change.warnings,
            };
          }
          const parsedCandidate = yield* parseManifestForMutation(candidate, config.manifestPath);
          const scopeRetirementTargets = yield* queueCodeGraphScopeRetirements(config, manifest, parsedCandidate);
          const candidateCatalog = yield* managerWorksetValidation(() =>
            managerWorksetCatalogFromManifest(parsedCandidate, sha256HexSync(candidate)),
          );
          const retirementCaptures = yield* Effect.forEach(
            change.retireWorksets,
            worksetName =>
              readPublishedCodeGraphWorksetCatalogGeneration(config.agentContextHome, worksetName).pipe(
                Effect.map(generation =>
                  generation === undefined
                    ? {target: undefined, warning: undefined}
                    : {target: {generationId: generation.id, worksetName}, warning: undefined},
                ),
                Effect.orElseSucceed(() => ({
                  target: undefined,
                  warning: `The manifest can be changed, but published storage for ${safeLabel(worksetName)} needs catalog repair before retirement.`,
                })),
              ),
            {concurrency: 1},
          );
          const crypto = yield* Crypto.Crypto;
          const temporary = path.join(
            path.dirname(config.manifestPath),
            `.${path.basename(config.manifestPath)}.manager-${yield* crypto.randomUUIDv4}.tmp`,
          );
          yield* Effect.gen(function* () {
            yield* fs.writeFileString(temporary, candidate, {flag: 'wx', mode: 0o600});
            yield* fs.chmod(temporary, 0o600);
            if (projectRootValidation !== undefined && change.projectCandidate !== undefined) {
              const normalizedCandidate = parsedCandidate.projects.find(
                project => project.name.toLowerCase() === change.projectCandidate!.name.toLowerCase(),
              );
              if (normalizedCandidate === undefined) {
                return yield* ManagerWorksetApiError.of(
                  'revision-conflict',
                  'The project edit changed while it was prepared.',
                  409,
                );
              }
              const revalidated = yield* validateManagerProjectRoots(
                manifest.projects.filter(
                  project =>
                    change.projectCurrentName === undefined ||
                    project.name.toLowerCase() !== change.projectCurrentName.toLowerCase(),
                ),
                normalizedCandidate,
              ).pipe(Effect.mapError(cause => ManagerWorksetApiError.of('revision-conflict', cause.message, 409)));
              if (revalidated.fingerprint !== projectRootValidation.fingerprint) {
                return yield* ManagerWorksetApiError.of(
                  'revision-conflict',
                  'A configured project root changed while the manifest edit was prepared. Refresh and retry.',
                  409,
                );
              }
            }
            const latestRaw = yield* fs.readFileString(config.manifestPath);
            const latestSymbolicTarget = yield* fs.readLink(config.manifestPath).pipe(Effect.option);
            if (sha256HexSync(latestRaw) !== revision || latestSymbolicTarget._tag === 'Some') {
              return yield* ManagerWorksetApiError.of(
                'revision-conflict',
                'The seed manifest changed while the workset edit was being prepared. Refresh Worksets and retry.',
                409,
              );
            }
            yield* fs.rename(temporary, config.manifestPath);
          }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
          return {
            catalog: candidateCatalog,
            changed: true,
            operation,
            scopeRetirementTargets,
            retirementTargets: retirementCaptures.flatMap(capture =>
              capture.target === undefined ? [] : [capture.target],
            ),
            warnings: [
              ...change.warnings,
              ...retirementCaptures.flatMap(capture => (capture.warning === undefined ? [] : [capture.warning])),
            ],
          };
        }),
      ),
    ).pipe(
      Effect.mapError(cause =>
        isFileLockTimeout(cause)
          ? ManagerWorksetApiError.of(
              'workset-busy',
              'Another workset definition or preparation operation is active. Retry shortly.',
              409,
              1_000,
            )
          : cause,
      ),
    );
    yield* Effect.forEach(
      promoted.scopeRetirementTargets,
      target => reconcileCodeGraphScopeRetirements(target).pipe(Effect.ignore),
      {concurrency: 1},
    );
    const retirementWarnings = yield* Effect.forEach(
      promoted.retirementTargets,
      target =>
        retireCodeGraphWorksetPublication(config.agentContextHome, target).pipe(
          Effect.map(receipt =>
            receipt.cleanupPending
              ? `Published storage for ${safeLabel(target.worksetName)} was retired; bounded cleanup remains pending.`
              : undefined,
          ),
          Effect.orElseSucceed(
            () =>
              `The manifest changed, but published storage for ${safeLabel(target.worksetName)} could not be retired yet.`,
          ),
        ),
      {concurrency: 1},
    );
    const catalog = yield* readManagerWorksetCatalog(config).pipe(Effect.orElseSucceed(() => promoted.catalog));
    return {
      catalog,
      changed: promoted.changed,
      operation: promoted.operation,
      warnings: [...promoted.warnings, ...retirementWarnings.filter(value => value !== undefined)],
    };
  });
}

export const handleManagerWorksetRequest = Effect.fn('managerWorksets.handleRequest')(function* (
  request: ManagerWorksetApiRequest,
) {
  if (!isManagerWorksetApiPath(request.url.pathname)) return yield* succeedUndefined;
  return yield* routeManagerWorksetRequest(request).pipe(
    Effect.catchCause(cause => Effect.succeed(managerWorksetErrorResponse(Cause.squash(cause)))),
  );
});

function routeManagerWorksetRequest(request: ManagerWorksetApiRequest) {
  const {config, method, url} = request;
  return Effect.gen(function* () {
    if (method === 'GET' && url.pathname === '/api/worksets') {
      return response(200, yield* readManagerWorksetCatalog(config));
    }
    if (method === 'GET' && url.pathname === '/api/worksets/status') {
      const workset = yield* requireKnownManagerWorkset(config, requiredManagerWorksetQuery(url));
      return response(200, yield* inspectCodeGraphWorksetStatus(config, workset));
    }
    if (method === 'GET' && url.pathname === '/api/worksets/definition') {
      return response(200, yield* readManagerWorksetDefinition(config, requiredManagerWorksetQuery(url)));
    }
    if (method === 'GET' && url.pathname === '/api/worksets/project') {
      return response(200, yield* readManagerManifestProject(config, requiredQuery(url, 'project')));
    }
    if (method === 'GET' && url.pathname === '/api/worksets/project-graph-preview') {
      return response(200, yield* previewManagerManifestProjectGraphScope(config, requiredQuery(url, 'project')));
    }
    if (method === 'GET' && url.pathname === '/api/worksets/jobs') {
      const jobs = [...registryFor(request.contextKey).jobs.values()]
        .map(entry => managerWorksetJobSummary(entry.job))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return response(200, {jobs});
    }
    if (method === 'GET' && url.pathname.startsWith('/api/worksets/jobs/')) {
      const id = url.pathname.slice('/api/worksets/jobs/'.length);
      const job = registryFor(request.contextKey).jobs.get(id)?.job;
      if (!job) throw ManagerWorksetApiError.of('job-not-found', 'Workset preparation job not found.', 404);
      return response(200, {job});
    }
    if (method !== 'POST') return response(404, {error: 'Not found'});
    const body = yield* request.body.pipe(
      Effect.mapError(() => ManagerWorksetApiError.of('invalid-json', 'Provide a JSON object request body.', 400)),
    );
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw ManagerWorksetApiError.of('invalid-json', 'Provide a JSON object request body.', 400);
    }
    switch (url.pathname) {
      case '/api/worksets/definitions':
        return response(
          200,
          yield* mutateManagerWorksetDefinitionFromRequest(request, definitionMutationFromBody(body)),
        );
      case '/api/worksets/projects':
        return response(200, yield* mutateManagerManifestProjectFromRequest(request, projectMutationFromBody(body)));
      case '/api/worksets/prepare':
        return response(202, {job: yield* startManagerWorksetPrepare(request, body)});
      case '/api/worksets/jobs/cancel':
        return response(202, {job: yield* cancelManagerWorksetPrepare(request.contextKey, request.jobScope, body)});
      case '/api/worksets/query':
        return response(200, yield* runManagerWorksetQuery(config, body));
      case '/api/worksets/continue':
        return response(
          200,
          yield* continueCodeGraphWorksetQueryV2(config, {
            cursor: requiredText(body.cursor, 'cursor', 256),
            ...optionalResponseBudget(body.budgetTokens),
          }),
        );
      case '/api/worksets/path':
        return response(200, yield* runManagerWorksetPath(config, body));
      case '/api/worksets/impact':
        return response(200, yield* runManagerWorksetImpact(config, body));
      case '/api/worksets/topology':
        return response(200, yield* runManagerWorksetTopology(config, body));
      case '/api/worksets/context-brief':
        return response(200, yield* runManagerWorksetContextBrief(config, body));
      default:
        return response(404, {error: 'Not found'});
    }
  });
}

export function managerWorksetJobSummary(job: ManagerWorksetPrepareJob): ManagerWorksetPrepareJobSummary {
  const {result: _result, ...summary} = job;
  return summary;
}

function runManagerWorksetQuery(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const worksetName = yield* requireKnownManagerWorkset(config, requiredManagerWorksetName(body.workset));
    return yield* queryCodeGraphWorksetV2(config, {
      ...optionalBoundedInteger(body.deadlineMilliseconds, 'deadlineMilliseconds', 1, 60_000),
      ...optionalBoundedInteger(body.depth, 'depth', 0, 16),
      ...optionalBoundedInteger(body.edgeLimit, 'edgeLimit', 1, 1_000),
      ...optionalBoundedInteger(body.evidenceCards, 'evidenceCards', 1, 512),
      ...optionalBoolean(body.includeHeuristic, 'includeHeuristic'),
      ...optionalBoolean(body.includeModelAssociations, 'includeModelAssociations'),
      ...optionalResponseBudget(body.budgetTokens),
      ...optionalBoundedInteger(body.nodeLimit, 'nodeLimit', 1, 1_000),
      ...(body.packageName === undefined
        ? {}
        : {packageName: requiredText(body.packageName, 'packageName', MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM)}),
      query: requiredText(body.query, 'query', MANAGER_WORKSET_QUERY_BYTES_MAXIMUM),
      worksetName,
    });
  });
}

function runManagerWorksetPath(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const worksetName = yield* knownWorksetFromBody(config, body);
    return yield* findCodeGraphWorksetPath(config, {
      ...traversalBudgets(body),
      from: requiredText(body.from, 'from', MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM),
      to: requiredText(body.to, 'to', MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM),
      worksetName,
    });
  });
}

function runManagerWorksetImpact(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const worksetName = yield* knownWorksetFromBody(config, body);
    return yield* traceCodeGraphWorksetImpact(config, {
      ...traversalBudgets(body),
      query: requiredText(body.query, 'query', MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM),
      worksetName,
    });
  });
}

function runManagerWorksetTopology(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const worksetName = yield* knownWorksetFromBody(config, body);
    return yield* inspectCodeGraphWorksetTopology(config, {
      ...optionalBoundedInteger(body.maxEdges, 'maxEdges', 1, 16_384),
      ...optionalBoundedInteger(body.maxEvidence, 'maxEvidence', 1, 8_192),
      ...optionalBoundedInteger(body.maxEvidencePerEdge, 'maxEvidencePerEdge', 1, 32),
      ...optionalBoundedInteger(body.maximumBridges, 'maximumBridges', 1, 20_000),
      ...optionalBoundedInteger(body.maxNodes, 'maxNodes', 1, 16_384),
      worksetName,
    });
  });
}

function runManagerWorksetContextBrief(config: RuntimeConfig, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const workset = yield* knownWorksetFromBody(config, body);
    return yield* ContextBrief.compileContextBrief(config, {
      budgetTokens:
        optionalIntegerValue(
          body.budgetTokens,
          'budgetTokens',
          ContextBrief.CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
          ContextBrief.CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
        ) ?? ContextBrief.CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS,
      mode: contextBriefMode(body.mode),
      scope: {kind: 'workset', name: workset},
      task: requiredText(body.task, 'task', 4_096),
    });
  });
}

function startManagerWorksetPrepare(request: ManagerWorksetApiRequest, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const workset = yield* requireKnownManagerWorkset(request.config, requiredManagerWorksetName(body.workset));
    const concurrency = optionalIntegerValue(
      body.concurrency,
      'concurrency',
      1,
      MANAGER_WORKSET_PREPARE_CONCURRENCY_MAXIMUM,
    );
    const registry = registryFor(request.contextKey);
    if (
      registry.mutating ||
      registry.starting ||
      [...registry.jobs.values()].some(entry => entry.job.status === 'running' || entry.job.status === 'cancelling')
    ) {
      throw ManagerWorksetApiError.of('prepare-busy', 'A Manager workset preparation is already running.', 409);
    }
    registry.starting = true;
    return yield* Effect.gen(function* () {
      yield* ensureManagerWorksetRegistryLifecycle(registry, request.jobScope);
      trimFinishedJobs(registry);
      const catalog = yield* readManagerWorksetCatalog(request.config);
      const total = catalog.definitions.find(definition => definition.name === workset)?.memberCount ?? 0;
      const crypto = yield* Crypto.Crypto;
      const createdAt = isoTimestamp(yield* Clock.currentTimeMillis);
      const id = `cgwj_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`;
      const entry: InternalManagerWorksetPrepareJob = {
        job: {
          createdAt,
          id,
          progress: {
            completed: 0,
            message: `Preparing ${total} workset member${total === 1 ? '' : 's'}.`,
            phase: 'starting',
            total,
          },
          status: 'running',
          workset,
        },
      };
      registry.jobs.set(id, entry);
      const fiber = yield* (request.prepareWorkset ?? prepareManagerCodeGraphWorksetIsolated)(request.config, workset, {
        ...(concurrency === undefined ? {} : {concurrency}),
        onProgress: progress => updateManagerWorksetPrepareProgress(entry, progress),
      }).pipe(
        Effect.matchCauseEffect({
          onFailure: cause => finishFailedPrepareJob(entry, cause),
          onSuccess: result => finishSuccessfulPrepareJob(entry, result),
        }),
        Effect.forkIn(request.jobScope),
      );
      entry.fiber = fiber;
      return entry.job;
    }).pipe(Effect.ensuring(Effect.sync(() => (registry.starting = false))));
  });
}

function cancelManagerWorksetPrepare(contextKey: object, jobScope: Scope.Scope, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const id = requiredText(body.id, 'id', 256);
    const entry = registryFor(contextKey).jobs.get(id);
    if (!entry) throw ManagerWorksetApiError.of('job-not-found', 'Workset preparation job not found.', 404);
    if (entry.job.status !== 'running' || !entry.fiber) return entry.job;
    entry.job = {
      ...entry.job,
      progress: {
        ...entry.job.progress,
        message: 'Stopping preparation; readiness will confirm whether an atomic publication completed.',
        phase: 'cancelling',
      },
      status: 'cancelling',
    };
    yield* Fiber.interrupt(entry.fiber).pipe(
      Effect.andThen(finishInterruptedPrepareJob(entry)),
      Effect.forkIn(jobScope),
    );
    return entry.job;
  });
}

function finishSuccessfulPrepareJob(entry: InternalManagerWorksetPrepareJob, result: CodeGraphWorksetPrepareResultV1) {
  return Clock.currentTimeMillis.pipe(
    Effect.tap(now =>
      Effect.sync(() => {
        entry.job = {
          ...entry.job,
          error: result.state === 'ready' ? undefined : 'No ready generation was published; review member receipts.',
          errorCode: result.state === 'ready' ? undefined : 'prepare-incomplete',
          finishedAt: isoTimestamp(now),
          progress: {
            completed: result.members.length,
            message:
              result.state !== 'ready'
                ? 'Preparation finished without publishing.'
                : result.coverage.complete
                  ? 'Published the complete ready generation.'
                  : `Published a generation with incomplete coverage: ${result.coverage.ready}/${result.coverage.requested} members ready.`,
            phase: result.state === 'ready' ? 'completed' : 'failed',
            total: entry.job.progress.total,
          },
          result,
          status: result.state === 'ready' ? 'completed' : 'failed',
          warning:
            result.state === 'ready' && !result.coverage.complete
              ? 'The generation is usable, but one or more members need attention. Review the receipts below.'
              : undefined,
        };
      }),
    ),
    Effect.asVoid,
  );
}

function finishFailedPrepareJob(entry: InternalManagerWorksetPrepareJob, cause: Cause.Cause<unknown>) {
  return Clock.currentTimeMillis.pipe(
    Effect.tap(now =>
      Effect.sync(() => {
        const cancelled = Cause.hasInterruptsOnly(cause);
        const failure = managerWorksetCauseError(cause);
        entry.job = {
          ...entry.job,
          error: cancelled ? undefined : failure.error,
          errorCode: cancelled ? undefined : failure.code,
          finishedAt: isoTimestamp(now),
          progress: {
            message: cancelled
              ? 'Preparation stopped; refresh readiness to confirm whether an atomic publication completed.'
              : 'Preparation failed safely.',
            phase: cancelled ? 'cancelled' : 'failed',
            total: entry.job.progress.total,
          },
          status: cancelled ? 'cancelled' : 'failed',
        };
      }),
    ),
    Effect.asVoid,
  );
}

function finishInterruptedPrepareJob(entry: InternalManagerWorksetPrepareJob) {
  return Clock.currentTimeMillis.pipe(
    Effect.tap(now =>
      Effect.sync(() => {
        if (entry.job.status !== 'running' && entry.job.status !== 'cancelling') return;
        entry.job = {
          ...entry.job,
          error: undefined,
          errorCode: undefined,
          finishedAt: isoTimestamp(now),
          progress: {
            message: 'Preparation stopped; refresh readiness to confirm whether an atomic publication completed.',
            phase: 'cancelled',
            total: entry.job.progress.total,
          },
          status: 'cancelled',
        };
      }),
    ),
    Effect.asVoid,
  );
}

function definitionMutationFromBody(body: Record<string, unknown>): ManagerWorksetDefinitionMutation {
  const expectedRevision = requiredText(body.expectedRevision, 'expectedRevision', 64);
  if (body.operation === 'create') {
    return {
      ...optionalDescription(body.description),
      expectedRevision,
      name: requiredManagerWorksetName(body.name, 'name'),
      operation: 'create',
      projects: requiredTextArray(body.projects, 'projects', MANAGER_WORKSET_MEMBER_MAXIMUM),
    };
  }
  if (body.operation === 'update') {
    return {
      ...optionalDescription(body.description),
      expectedRevision,
      name: requiredManagerWorksetName(body.name, 'name'),
      operation: 'update',
      projects: requiredTextArray(body.projects, 'projects', MANAGER_WORKSET_MEMBER_MAXIMUM),
      workset: requiredManagerWorksetName(body.workset),
    };
  }
  if (body.operation === 'delete') {
    if (body.confirm !== true)
      throw ManagerWorksetApiError.of('confirmation-required', 'Confirm workset deletion.', 400);
    return {
      confirm: true,
      expectedRevision,
      operation: 'delete',
      workset: requiredManagerWorksetName(body.workset),
    };
  }
  throw ManagerWorksetApiError.of('invalid-input', 'Workset definition operation is invalid.', 400);
}

function projectMutationFromBody(body: Record<string, unknown>): ManagerManifestProjectMutation {
  const expectedRevision = requiredText(body.expectedRevision, 'expectedRevision', 64);
  if (body.operation === 'create' || body.operation === 'update') {
    if (body.clearGraph === true && body.graph !== undefined) {
      throw ManagerWorksetApiError.of('invalid-input', 'Specify either graph or clearGraph, not both.', 400);
    }
    const common = {
      expectedRevision,
      ...(body.graph === undefined ? {} : {graph: validateManagerProjectGraph(body.graph)}),
      name: requiredText(body.name, 'name', MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
      path: requiredLiteralText(body.path, 'path', MANAGER_PROJECT_VALUE_BYTES_MAXIMUM),
      seed: projectSeedPatterns(body.seed),
      uri: requiredLiteralText(body.uri, 'uri', MANAGER_PROJECT_VALUE_BYTES_MAXIMUM),
    };
    return body.operation === 'create'
      ? {...common, operation: 'create'}
      : {
          ...common,
          ...(body.clearGraph === true ? {clearGraph: true as const} : {}),
          operation: 'update',
          project: requiredText(body.project, 'project', MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
        };
  }
  if (body.operation === 'delete') {
    if (body.confirm !== true)
      throw ManagerWorksetApiError.of('confirmation-required', 'Confirm project deletion.', 400);
    return {
      confirm: true,
      expectedRevision,
      operation: 'delete',
      project: requiredText(body.project, 'project', MANAGER_WORKSET_NAME_BYTES_MAXIMUM),
    };
  }
  throw ManagerWorksetApiError.of('invalid-input', 'Manifest project operation is invalid.', 400);
}

function applyProjectMutation(
  document: ReturnType<typeof parseDocument>,
  manifest: SeedManifest,
  mutation: ManagerManifestProjectMutation,
): ManagerManifestMutationChange {
  const projects = document.get('projects', true);
  if (!isSeq(projects))
    throw ManagerWorksetApiError.of('manifest-invalid', 'Manifest projects must be a YAML sequence.', 409);
  const sequence = projects;
  const targetName = mutation.operation === 'create' ? mutation.name : mutation.project;
  const targetIndexes = findNamedMapIndexes(sequence, targetName);
  if (targetIndexes.length > 1) {
    throw ManagerWorksetApiError.of('name-conflict', 'The target project name is ambiguous in the manifest.', 409);
  }
  const index = targetIndexes[0] ?? -1;
  const current = index < 0 ? undefined : manifest.projects[index];
  if (mutation.operation === 'create') {
    if (index >= 0) throw ManagerWorksetApiError.of('name-conflict', 'A project with that name already exists.', 409);
    const value = validatedProject(manifest, mutation);
    assertProjectReferenceMutationSafe(manifest, undefined, value.name);
    sequence.add(document.createNode(value));
    const affected = affectedWorksets(manifest, value.name);
    return {
      changed: true,
      normalizeProjectPath: true,
      projectCandidate: value,
      retireWorksets: affected,
      warnings: [],
    };
  }
  if (index < 0 || !current) throw ManagerWorksetApiError.of('project-not-found', PROJECT_NOT_FOUND_MESSAGE, 404);
  const affected = affectedWorksets(manifest, current.name);
  if (mutation.operation === 'delete') {
    sequence.delete(index);
    return {
      changed: true,
      retireWorksets: affected,
      warnings:
        affected.length === 0
          ? []
          : [
              `Deleted project ${safeLabel(current.name)} remains as an unresolved member in ${affected.length} affected workset${affected.length === 1 ? '' : 's'}.`,
            ],
    };
  }
  const value = validatedProject(manifest, mutation, current);
  const node = sequence.items[index];
  if (!isMap(node)) throw unsupportedProjectYaml();
  const map = node;
  const configuredUri = map.get('uri');
  if (typeof configuredUri !== 'string') throw unsupportedProjectYaml();
  const configuredUriChanged = mutation.uri !== configuredUri;
  if (managerProjectsEqual(current, value) && !configuredUriChanged) {
    return {changed: false, retireWorksets: [], warnings: []};
  }
  const renamed = current.name !== value.name;
  if (renamed) {
    assertProjectReferenceMutationSafe(manifest, current.name, value.name);
    if (affected.length > 0) {
      assertSupportedManagerWorksetYaml(document);
      reconcileWorksetProjectReferences(document, current.name, value.name);
    }
    setManagerYamlString(map, 'name', value.name);
  }
  if (current.path !== value.path) setManagerYamlString(map, 'path', value.path);
  if (configuredUriChanged) setManagerYamlString(map, 'uri', value.uri);
  if (!managerProjectSeedsEqual(current.seed, value.seed)) reconcileSeedSequence(map, value.seed);
  if (!managerProjectGraphsEqual(current.graph, value.graph)) reconcileManagerProjectGraph(map, value.graph);
  const graphIdentityChanged = !managerProjectGraphIdentityEqual(current, value);
  const retireWorksets = renamed
    ? uniqueCaseInsensitive([...affected, ...affectedWorksets(manifest, value.name)])
    : affected;
  return {
    changed: true,
    normalizeProjectPath: current.path !== value.path,
    projectCandidate: value,
    projectCurrentName: current.name,
    retireWorksets: graphIdentityChanged ? retireWorksets : [],
    warnings: [],
  };
}

function assertProjectReferenceMutationSafe(
  manifest: SeedManifest,
  previousName: string | undefined,
  nextName: string,
): void {
  const nextKey = nextName.toLowerCase();
  const previousKey = previousName?.toLowerCase();
  const collision = (manifest.worksets ?? []).find(workset => {
    const relevant =
      previousKey === undefined
        ? workset.projects.some(project => project.toLowerCase() === nextKey)
        : workset.projects.some(project => {
            const key = project.toLowerCase();
            return key === previousKey || key === nextKey;
          });
    if (!relevant) return false;
    const rewritten = workset.projects.map(project =>
      previousKey !== undefined && project.toLowerCase() === previousKey ? nextKey : project.toLowerCase(),
    );
    return rewritten.filter(project => project === nextKey).length > 1;
  });
  if (collision) {
    throw ManagerWorksetApiError.of(
      'name-conflict',
      `Workset ${safeLabel(collision.name)} contains duplicate references for the target project name.`,
      409,
    );
  }
}

function validatedProject(
  manifest: SeedManifest,
  input: Extract<ManagerManifestProjectMutation, {readonly operation: 'create' | 'update'}>,
  current?: ProjectManifest,
): ProjectManifest {
  const name = normalizedText(input.name, 'name', MANAGER_WORKSET_NAME_BYTES_MAXIMUM);
  const path =
    current !== undefined && input.path === current.path ? current.path : validateManagerProjectPath(input.path);
  const uri = validateManagerProjectUri(input.uri, current?.uri);
  const seed = projectSeedPatterns(input.seed);
  const duplicateName = manifest.projects.some(
    project => project !== current && project.name.toLowerCase() === name.toLowerCase(),
  );
  if (duplicateName) throw ManagerWorksetApiError.of('name-conflict', 'A project with that name already exists.', 409);
  const duplicateUri = manifest.projects.some(project => project !== current && project.uri === uri);
  if (duplicateUri)
    throw ManagerWorksetApiError.of('uri-conflict', 'Another manifest project already owns that resource URI.', 409);
  const graph =
    input.graph !== undefined
      ? copyManagerProjectGraph(input.graph)
      : 'clearGraph' in input && input.clearGraph === true
        ? undefined
        : current?.graph;
  return {...(graph === undefined ? {} : {graph: copyManagerProjectGraph(graph)}), name, path, seed, uri};
}

export function validateManagerProjectGraph(value: unknown): NonNullable<ProjectManifest['graph']> {
  try {
    return validateManagerProjectGraphInput(value, MANAGER_WORKSET_MEMBER_MAXIMUM);
  } catch (cause) {
    throw ManagerWorksetApiError.of(
      'invalid-input',
      cause instanceof Error ? cause.message : 'Project graph configuration is invalid.',
      400,
    );
  }
}

function validateManagerProjectPath(value: string): string {
  try {
    return validateManagerConfiguredProjectPath(value, MANAGER_PROJECT_VALUE_BYTES_MAXIMUM);
  } catch (cause) {
    throw ManagerWorksetApiError.of(
      'invalid-input',
      cause instanceof Error ? cause.message : 'Project path is invalid.',
      400,
    );
  }
}

function validateManagerProjectRootMutation(
  manifest: SeedManifest,
  change: ManagerManifestMutationChange,
): Effect.Effect<ManagerProjectRootValidation | undefined, ManagerWorksetApiError, ApplicationServices> {
  return change.projectCandidate === undefined || change.normalizeProjectPath !== true
    ? succeedUndefined
    : validateManagerProjectRoots(
        manifest.projects.filter(
          project =>
            change.projectCurrentName === undefined ||
            project.name.toLowerCase() !== change.projectCurrentName.toLowerCase(),
        ),
        change.projectCandidate,
      ).pipe(
        Effect.mapError(cause => {
          const invalidInput = cause.message.startsWith('Project path must identify');
          return ManagerWorksetApiError.of(
            invalidInput ? 'invalid-input' : 'project-path-unavailable',
            cause.message,
            invalidInput ? 400 : 409,
          );
        }),
      );
}

function validateManagerProjectUri(value: string, retainedCanonicalUri?: string): string {
  try {
    return validateManagerConfiguredProjectUri(value, retainedCanonicalUri);
  } catch (cause) {
    throw ManagerWorksetApiError.of(
      'invalid-input',
      cause instanceof Error ? cause.message : 'Project URI is invalid.',
      400,
    );
  }
}

function affectedWorksets(manifest: SeedManifest, projectName: string): readonly string[] {
  const key = projectName.toLowerCase();
  return (manifest.worksets ?? [])
    .filter(workset => workset.projects.some(project => project.toLowerCase() === key))
    .map(workset => workset.name);
}

function applyDefinitionMutation(
  document: ReturnType<typeof parseDocument>,
  manifest: SeedManifest,
  mutation: ManagerWorksetDefinitionMutation,
): {readonly changed: boolean; readonly retireWorksets: readonly string[]; readonly warnings: readonly string[]} {
  let worksets = document.get('worksets', true);
  if (worksets === undefined) {
    if (mutation.operation !== 'create') {
      throw ManagerWorksetApiError.of('workset-not-found', 'Workset definition not found.', 404);
    }
    document.set('worksets', document.createNode([]));
    worksets = document.get('worksets', true);
  }
  if (!isSeq(worksets))
    throw ManagerWorksetApiError.of('manifest-invalid', 'Manifest worksets must be a YAML sequence.', 409);
  const sequence = worksets;
  const targetName = mutation.operation === 'create' ? mutation.name : mutation.workset;
  const targetIndexes = findWorksetNodeIndexes(sequence, targetName);
  if (targetIndexes.length > 1) {
    throw ManagerWorksetApiError.of('name-conflict', 'The target workset name is ambiguous in the manifest.', 409);
  }
  const index = targetIndexes[0] ?? -1;
  const current = index < 0 ? undefined : manifest.worksets?.[index];
  if (mutation.operation === 'create') {
    if (index >= 0) throw ManagerWorksetApiError.of('name-conflict', 'A workset with that name already exists.', 409);
    const value = validatedDefinition(manifest, mutation.name, mutation.description, mutation.projects);
    sequence.add(value);
    return {changed: true, retireWorksets: [], warnings: []};
  }
  if (index < 0) throw ManagerWorksetApiError.of('workset-not-found', 'Workset definition not found.', 404);
  if (mutation.operation === 'delete') {
    sequence.delete(index);
    return {
      changed: true,
      retireWorksets: [current?.name ?? mutation.workset],
      warnings: [],
    };
  }
  const nameConflict = findWorksetNodeIndex(sequence, mutation.name);
  if (nameConflict >= 0 && nameConflict !== index) {
    throw ManagerWorksetApiError.of('name-conflict', 'A workset with that name already exists.', 409);
  }
  const value = validatedDefinition(
    manifest,
    mutation.name,
    mutation.description,
    mutation.projects,
    current?.projects,
  );
  if (current && definitionsEqual(current, value)) return {changed: false, retireWorksets: [], warnings: []};
  const node = sequence.items[index];
  if (!isMap(node)) throw ManagerWorksetApiError.of('manifest-invalid', 'Workset entries must be YAML maps.', 409);
  const map = node;
  if (current?.name !== value.name) map.set('name', value.name);
  if (current?.description !== value.description) {
    if (value.description === undefined) map.delete('description');
    else map.set('description', value.description);
  }
  const membersChanged = current === undefined || !textSetsEqual(current.projects, value.projects);
  if (membersChanged) reconcileProjectSequence(map, value.projects);
  const renamed = current !== undefined && current.name !== value.name;
  return {
    changed: true,
    retireWorksets: renamed ? [current.name] : membersChanged ? [value.name] : [],
    warnings: [],
  };
}

function validatedDefinition(
  manifest: SeedManifest,
  nameValue: string,
  descriptionValue: string | undefined,
  projectValues: readonly string[],
  allowedUnknownProjects: readonly string[] = [],
): WorksetManifest {
  const name = normalizeManagerWorksetName(nameValue, 'name');
  const description =
    descriptionValue === undefined
      ? undefined
      : normalizedText(descriptionValue, 'description', MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM);
  if (projectValues.length === 0 || projectValues.length > MANAGER_WORKSET_MEMBER_MAXIMUM) {
    throw ManagerWorksetApiError.of('invalid-input', 'A workset must contain 1 to 4096 projects.', 400);
  }
  const configured = new Map(manifest.projects.map(project => [project.name.toLowerCase(), project.name]));
  const allowedUnknown = new Map(allowedUnknownProjects.map(project => [project.toLowerCase(), project]));
  const seen = new Set<string>();
  const projects = projectValues.map(value => {
    const project = normalizedText(value, 'project', MANAGER_WORKSET_NAME_BYTES_MAXIMUM);
    const key = project.toLowerCase();
    if (seen.has(key)) throw ManagerWorksetApiError.of('invalid-input', 'Workset project members must be unique.', 400);
    seen.add(key);
    const canonical = configured.get(key) ?? allowedUnknown.get(key);
    if (!canonical)
      throw ManagerWorksetApiError.of('invalid-input', `Unknown manifest project: ${safeLabel(project)}.`, 400);
    return canonical;
  });
  return {description, name, projects};
}

function assertUniqueManifestNames(values: readonly string[], kind: 'project' | 'workset'): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      throw ManagerWorksetApiError.of(
        'manifest-invalid',
        `The seed manifest has ambiguous case-insensitive ${kind} names.`,
        409,
      );
    }
    seen.add(key);
  }
}

function assertUniqueManagerManifestIdentity(manifest: SeedManifest): void {
  for (const name of [
    ...manifest.projects.map(project => project.name),
    ...(manifest.worksets ?? []).flatMap(workset => [workset.name, ...workset.projects]),
  ]) {
    if (!managerManifestNameIsCanonical(name)) {
      throw ManagerWorksetApiError.of(
        'manifest-invalid',
        'Manager requires project and workset names to be normalized, bounded text without surrounding whitespace.',
        409,
      );
    }
  }
  const projectUris = new Set<string>();
  for (const project of manifest.projects) {
    if (projectUris.has(project.uri)) {
      throw ManagerWorksetApiError.of('manifest-invalid', 'Manifest project resource URIs must be unique.', 409);
    }
    projectUris.add(project.uri);
  }
  if (manifest.projects.length > MANAGER_WORKSET_MEMBER_MAXIMUM) {
    throw ManagerWorksetApiError.of('manifest-invalid', 'The seed manifest has too many projects for Manager.', 409);
  }
  if ((manifest.worksets?.length ?? 0) > MANAGER_WORKSET_DEFINITION_MAXIMUM) {
    throw ManagerWorksetApiError.of('manifest-invalid', 'The seed manifest has too many worksets for Manager.', 409);
  }
  if (manifest.worksets?.some(workset => workset.projects.length > MANAGER_WORKSET_MEMBER_MAXIMUM)) {
    throw ManagerWorksetApiError.of('manifest-invalid', 'A workset has too many members for Manager.', 409);
  }
  assertUniqueManifestNames(
    manifest.projects.map(project => project.name),
    'project',
  );
  assertUniqueManifestNames(
    (manifest.worksets ?? []).map(workset => workset.name),
    'workset',
  );
}

function managerManifestNameIsCanonical(value: string): boolean {
  try {
    return normalizedText(value, 'manifest name', MANAGER_WORKSET_NAME_BYTES_MAXIMUM) === value;
  } catch {
    return false;
  }
}

function managerWorksetYamlSupported(document: ReturnType<typeof parseDocument>): boolean {
  try {
    assertSupportedManagerWorksetYaml(document);
    return true;
  } catch {
    return false;
  }
}

function managerProjectYamlSupported(document: ReturnType<typeof parseDocument>): boolean {
  try {
    assertSupportedManagerProjectYaml(document);
    return true;
  } catch {
    return false;
  }
}

function assertSupportedManagerProjectYaml(document: ReturnType<typeof parseDocument>): void {
  if (!managerProjectYamlDocumentSupported(document)) throw unsupportedProjectYaml();
}

function assertSupportedManagerWorksetYaml(document: ReturnType<typeof parseDocument>): void {
  const worksets = document.get('worksets', true);
  if (worksets === undefined) return;
  if (!isSeq(worksets)) throw unsupportedWorksetYaml();
  for (const item of worksets.items) {
    if (!isMap(item) || hasYamlAnchor(item)) throw unsupportedWorksetYaml();
    const name = item.get('name', true);
    const projects = item.get('projects', true);
    const description = item.get('description', true);
    if (
      !isScalar(name) ||
      typeof name.value !== 'string' ||
      hasYamlAnchor(name) ||
      !isSeq(projects) ||
      hasYamlAnchor(projects)
    ) {
      throw unsupportedWorksetYaml();
    }
    if (
      description !== undefined &&
      (!isScalar(description) || typeof description.value !== 'string' || hasYamlAnchor(description))
    ) {
      throw unsupportedWorksetYaml();
    }
    if (
      projects.items.some(project => !isScalar(project) || typeof project.value !== 'string' || hasYamlAnchor(project))
    ) {
      throw unsupportedWorksetYaml();
    }
  }
}

function hasYamlAnchor(node: {readonly anchor?: string}): boolean {
  return typeof node.anchor === 'string' && node.anchor.length > 0;
}

function unsupportedWorksetYaml(): ManagerWorksetApiError {
  return ManagerWorksetApiError.of(
    'manifest-invalid',
    'Workset definitions use YAML aliases or shapes that Manager cannot edit safely.',
    409,
  );
}

function unsupportedProjectYaml(): ManagerWorksetApiError {
  return ManagerWorksetApiError.of(
    'manifest-invalid',
    'Manifest projects use YAML aliases or shapes that Manager cannot edit safely.',
    409,
  );
}

function managerWorksetValidation<A>(evaluate: () => A): Effect.Effect<A, ManagerWorksetApiError> {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      Schema.is(ManagerWorksetApiError)(cause)
        ? cause
        : ManagerWorksetApiError.of('manifest-invalid', 'The seed manifest cannot be edited safely.', 409),
  });
}

function parseManifestForMutation(raw: string, path: string) {
  return Effect.try({
    try: () => parseSeedManifest(raw, path),
    catch: cause =>
      Schema.is(ManagerWorksetApiError)(cause)
        ? cause
        : ManagerWorksetApiError.of('manifest-invalid', 'The seed manifest could not be validated.', 409),
  });
}

function requireKnownManagerWorkset(config: RuntimeConfig, requested: string) {
  return readSeedManifest(config.manifestPath).pipe(
    Effect.tap(manifest => managerWorksetValidation(() => assertUniqueManagerManifestIdentity(manifest))),
    Effect.map(manifest => manifest.worksets?.find(item => item.name.toLowerCase() === requested.toLowerCase())),
    Effect.flatMap(workset =>
      workset
        ? Effect.succeed(workset.name)
        : Effect.fail(ManagerWorksetApiError.of('workset-not-found', 'Workset definition not found.', 404)),
    ),
    Effect.catchIf(
      error => !Schema.is(ManagerWorksetApiError)(error),
      () => Effect.fail(ManagerWorksetApiError.of('manifest-unavailable', 'The seed manifest could not be read.', 500)),
    ),
  );
}

function knownWorksetFromBody(config: RuntimeConfig, body: Record<string, unknown>) {
  return requireKnownManagerWorkset(config, requiredManagerWorksetName(body.workset));
}

function registryFor(key: object): ManagerWorksetJobRegistry {
  const current = JOB_REGISTRIES.get(key);
  if (current) return current;
  const created = {jobs: new Map<string, InternalManagerWorksetPrepareJob>(), mutating: false, starting: false};
  JOB_REGISTRIES.set(key, created);
  return created;
}

function ensureManagerWorksetRegistryLifecycle(registry: ManagerWorksetJobRegistry, scope: Scope.Scope) {
  if (registry.lifecycleScope === scope) return Effect.void;
  if (registry.lifecycleScope !== undefined) {
    return Effect.fail(ManagerWorksetApiError.of('prepare-busy', 'The Manager workset job scope changed.', 409));
  }
  registry.lifecycleScope = scope;
  return Scope.addFinalizer(
    scope,
    Effect.suspend(() =>
      Effect.forEach(
        [...registry.jobs.values()],
        entry =>
          entry.fiber === undefined
            ? Effect.void
            : Fiber.interrupt(entry.fiber).pipe(Effect.andThen(finishInterruptedPrepareJob(entry))),
        {concurrency: 'unbounded', discard: true},
      ),
    ),
  );
}

function mutateManagerWorksetDefinitionFromRequest(
  request: ManagerWorksetApiRequest,
  mutation: ManagerWorksetDefinitionMutation,
) {
  const registry = registryFor(request.contextKey);
  assertNoActiveManagerPrepare(registry);
  registry.mutating = true;
  return mutateManagerWorksetDefinition(request.config, mutation).pipe(
    Effect.ensuring(Effect.sync(() => (registry.mutating = false))),
  );
}

function mutateManagerManifestProjectFromRequest(
  request: ManagerWorksetApiRequest,
  mutation: ManagerManifestProjectMutation,
) {
  const registry = registryFor(request.contextKey);
  assertNoActiveManagerPrepare(registry);
  registry.mutating = true;
  return mutateManagerManifestProject(request.config, mutation).pipe(
    Effect.ensuring(Effect.sync(() => (registry.mutating = false))),
  );
}

function assertNoActiveManagerPrepare(registry: ManagerWorksetJobRegistry): void {
  if (
    registry.mutating ||
    registry.starting ||
    [...registry.jobs.values()].some(entry => entry.job.status === 'running' || entry.job.status === 'cancelling')
  ) {
    throw ManagerWorksetApiError.of(
      'prepare-busy',
      'Wait for the active Manager workset preparation before editing definitions.',
      409,
    );
  }
}

function trimFinishedJobs(registry: ManagerWorksetJobRegistry): void {
  const finished = [...registry.jobs.values()]
    .filter(entry => entry.job.status !== 'running' && entry.job.status !== 'cancelling')
    .sort((left, right) => left.job.createdAt.localeCompare(right.job.createdAt));
  while (registry.jobs.size >= MANAGER_WORKSET_JOB_MAXIMUM && finished.length > 0) {
    registry.jobs.delete(finished.shift()!.job.id);
  }
}

function traversalBudgets(body: Record<string, unknown>) {
  return {
    ...optionalBoundedInteger(body.deadlineMilliseconds, 'deadlineMilliseconds', 1, 60_000),
    ...optionalBoundedInteger(body.maxDepth, 'maxDepth', 1, 16),
    ...optionalBoundedInteger(body.maxEdges, 'maxEdges', 1, 1_000),
  };
}

function optionalResponseBudget(value: unknown): {readonly maximumEstimatedTokens?: number} {
  const budget = optionalIntegerValue(value, 'budgetTokens', 1, MANAGER_WORKSET_RESPONSE_TOKENS_MAXIMUM);
  return budget === undefined ? {} : {maximumEstimatedTokens: budget};
}

function optionalBoundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): Readonly<Record<string, number>> {
  const parsed = optionalIntegerValue(value, name, minimum, maximum);
  return parsed === undefined ? {} : {[name]: parsed};
}

function optionalIntegerValue(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw ManagerWorksetApiError.of('invalid-input', `${name} must be an integer from ${minimum} to ${maximum}.`, 400);
  return value;
}

function optionalBoolean(value: unknown, name: string): Readonly<Record<string, boolean>> {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw ManagerWorksetApiError.of('invalid-input', `${name} must be a boolean.`, 400);
  return {[name]: value};
}

function optionalDescription(value: unknown): {readonly description?: string} {
  if (value === undefined || value === '') return {};
  return {description: requiredText(value, 'description', MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM)};
}

function requiredText(value: unknown, name: string, maximumBytes: number): string {
  if (typeof value !== 'string') throw ManagerWorksetApiError.of('invalid-input', `Provide ${name}.`, 400);
  return normalizedText(value, name, maximumBytes);
}

/**
 * Canonical Manager validator for every workset-name boundary, including CLI callers.
 * Keep the optional field label only for backwards-compatible HTTP error messages.
 */
export function normalizeManagerWorksetName(value: string, field = 'workset'): string {
  return normalizedText(value, field, MANAGER_WORKSET_NAME_BYTES_MAXIMUM);
}

function requiredManagerWorksetName(value: unknown, field = 'workset'): string {
  if (typeof value !== 'string') throw ManagerWorksetApiError.of('invalid-input', `Provide ${field}.`, 400);
  return normalizeManagerWorksetName(value, field);
}

function normalizedText(value: string, name: string, maximumBytes: number): string {
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!text || UTF8.encode(text).byteLength > maximumBytes || hasControlCharacter(text)) {
    throw ManagerWorksetApiError.of('invalid-input', `${name} must be bounded text without control characters.`, 400);
  }
  return text;
}

function requiredTextArray(value: unknown, name: string, maximumItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw ManagerWorksetApiError.of('invalid-input', `Provide ${name} as a bounded non-empty string array.`, 400);
  }
  return value.map(item => requiredText(item, name, MANAGER_WORKSET_NAME_BYTES_MAXIMUM));
}

function requiredLiteralText(value: unknown, name: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    UTF8.encode(value).byteLength > maximumBytes ||
    hasLiteralControlCharacter(value)
  ) {
    throw ManagerWorksetApiError.of('invalid-input', `${name} must be bounded text without control characters.`, 400);
  }
  return value;
}

function projectSeedPatterns(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw ManagerWorksetApiError.of('invalid-input', 'Provide seed as a bounded string array.', 400);
  }
  try {
    return validateProjectSeedPatterns(value);
  } catch (cause) {
    throw ManagerWorksetApiError.of(
      'invalid-input',
      cause instanceof Error ? cause.message : 'Project seed patterns are invalid.',
      400,
    );
  }
}

function contextBriefMode(value: unknown): ContextBrief.ContextBriefMode {
  if (value === undefined || value === 'brief') return 'brief';
  if (value === 'locate' || value === 'explain' || value === 'trace' || value === 'impact' || value === 'resume')
    return value;
  throw ManagerWorksetApiError.of(
    'invalid-input',
    'mode must be brief, locate, explain, trace, impact, or resume.',
    400,
  );
}
function validateExpectedRevision(value: string): void {
  if (!SHA256.test(value)) throw ManagerWorksetApiError.of('invalid-input', 'expectedRevision is invalid.', 400);
}
const findWorksetNodeIndex = (sequence: YAMLSeq, name: string): number =>
  findWorksetNodeIndexes(sequence, name)[0] ?? -1;
function findWorksetNodeIndexes(sequence: YAMLSeq, name: string): readonly number[] {
  return findNamedMapIndexes(sequence, name);
}
function findNamedMapIndexes(sequence: YAMLSeq, name: string): readonly number[] {
  const target = name.toLowerCase();
  return sequence.items.flatMap((item, index) => {
    if (!isMap(item)) return [];
    const value = item.get('name');
    return typeof value === 'string' && value.toLowerCase() === target ? [index] : [];
  });
}

function definitionsEqual(left: WorksetManifest, right: WorksetManifest): boolean {
  return (
    left.name === right.name && left.description === right.description && textSetsEqual(left.projects, right.projects)
  );
}

function textSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === right.length && right.every(value => values.has(value));
}

function reconcileProjectSequence(map: YAMLMap, projects: readonly string[]): void {
  const current = map.get('projects', true);
  if (!isSeq(current)) {
    map.set('projects', [...projects]);
    return;
  }
  const desired = new Map(projects.map(project => [project.toLowerCase(), project]));
  const retained = [] as typeof current.items;
  const retainedKeys = new Set<string>();
  for (const item of current.items) {
    if (!isScalar(item) || typeof item.value !== 'string') continue;
    const key = item.value.toLowerCase();
    if (!desired.has(key) || retainedKeys.has(key)) continue;
    item.value = desired.get(key)!;
    retained.push(item);
    retainedKeys.add(key);
  }
  current.items = retained;
  for (const project of projects) {
    if (retainedKeys.has(project.toLowerCase())) continue;
    current.add(project);
  }
}

function reconcileWorksetProjectReferences(
  document: ReturnType<typeof parseDocument>,
  previousName: string,
  nextName: string,
): void {
  const worksets = document.get('worksets', true);
  if (worksets === undefined) return;
  if (!isSeq(worksets)) throw unsupportedWorksetYaml();
  const key = previousName.toLowerCase();
  for (const item of worksets.items) {
    if (!isMap(item)) throw unsupportedWorksetYaml();
    const projects = item.get('projects', true);
    if (!isSeq(projects)) throw unsupportedWorksetYaml();
    for (const project of projects.items) {
      if (!isScalar(project) || typeof project.value !== 'string') throw unsupportedWorksetYaml();
      if (project.value.toLowerCase() === key) project.value = nextName;
    }
  }
}

function reconcileSeedSequence(map: YAMLMap, patterns: readonly string[]): void {
  const current = map.get('seed', true);
  if (!isSeq(current)) {
    map.set('seed', [...patterns]);
    return;
  }
  const available = new Map<string, typeof current.items>();
  for (const item of current.items) {
    if (!isScalar(item) || typeof item.value !== 'string') continue;
    const matches = available.get(item.value) ?? [];
    matches.push(item);
    available.set(item.value, matches);
  }
  const next = [] as typeof current.items;
  for (const pattern of patterns) {
    const retained = available.get(pattern)?.shift();
    if (retained !== undefined) {
      next.push(retained);
      continue;
    }
    current.add(pattern);
    next.push(current.items.pop());
  }
  current.items = next;
}

function setManagerYamlString(map: YAMLMap, key: string, value: string): void {
  const current = map.get(key, true);
  if (isScalar(current) && typeof current.value === 'string') {
    current.value = value;
    return;
  }
  map.set(key, value);
}

function setManagerProjectPath(document: ReturnType<typeof parseDocument>, projectName: string, value: string): void {
  const projects = document.get('projects', true);
  if (!isSeq(projects)) throw unsupportedProjectYaml();
  const indexes = findNamedMapIndexes(projects, projectName);
  const item = indexes.length === 1 ? projects.items[indexes[0]] : undefined;
  if (!isMap(item)) throw unsupportedProjectYaml();
  setManagerYamlString(item, 'path', value);
}

function managerWorksetErrorResponse(error: unknown): ManagerWorksetApiResponse {
  if (Schema.is(ManagerWorksetApiError)(error)) {
    return response(error.status, {
      code: error.code,
      error: error.message,
      ...(error.retryAfterMilliseconds === undefined ? {} : {retryAfterMilliseconds: error.retryAfterMilliseconds}),
    });
  }
  if (Schema.is(CodeGraphWorksetCatalogError)(error)) {
    const catalog = managerWorksetCatalogHttp(error.reason);
    return response(catalog.status, {code: catalog.code, error: catalog.error});
  }
  return response(500, {code: 'workset-operation-failed', error: publicWorksetError(error)});
}

function managerWorksetCauseError(cause: Cause.Cause<unknown>): {readonly code: string; readonly error: string} {
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  const result = managerWorksetErrorResponse(failure ?? cause);
  if (Predicate.isObject(result.body) && 'error' in result.body) {
    const body = result.body;
    return {
      code: typeof body.code === 'string' ? body.code : 'workset-operation-failed',
      error: typeof body.error === 'string' ? body.error : publicWorksetError(failure ?? cause),
    };
  }
  return {code: 'workset-operation-failed', error: publicWorksetError(failure ?? cause)};
}

function publicWorksetError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const allowed = [
    'Invalid Context Brief request:',
    'Cross-repository ',
    'The published workset ',
    'The published generation ',
    'The qualified reference ',
    'Workset path/impact ',
    'Workset component ',
    'A component selector ',
  ];
  return allowed.some(prefix => message.startsWith(prefix))
    ? message
    : 'The workset operation failed without changing repository graphs.';
}

function response(status: number, body: unknown): ManagerWorksetApiResponse {
  return {body, status};
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw ManagerWorksetApiError.of('invalid-input', `Missing query parameter: ${name}.`, 400);
  return requiredText(value, name, MANAGER_WORKSET_NAME_BYTES_MAXIMUM);
}

function requiredManagerWorksetQuery(url: URL): string {
  const value = url.searchParams.get('workset');
  if (!value) throw ManagerWorksetApiError.of('invalid-input', 'Missing query parameter: workset.', 400);
  return normalizeManagerWorksetName(value);
}

function safeLabel(value: string): string {
  return (
    value
      .replace(/[\r\n\t\0]/gu, ' ')
      .trim()
      .slice(0, MANAGER_WORKSET_NAME_BYTES_MAXIMUM) || 'unknown'
  );
}

function safeDescription(value: string): string {
  return value
    .replace(/[\r\n\t\0]/gu, ' ')
    .trim()
    .slice(0, MANAGER_WORKSET_DESCRIPTION_BYTES_MAXIMUM);
}

function safeLocalPath(value: string): string {
  return value
    .replace(/[\r\n\t\0]/gu, ' ')
    .trim()
    .slice(0, MANAGER_WORKSET_SELECTOR_BYTES_MAXIMUM);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

function hasLiteralControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function uniqueCaseInsensitive(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isoTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
