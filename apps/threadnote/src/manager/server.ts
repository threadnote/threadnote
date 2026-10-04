import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import {
  Cause,
  Console,
  Crypto,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Schema,
  Scope,
} from 'effect';
import * as Base64Url from 'effect/encoding/Base64Url';
import * as HttpServer from 'effect/http/HttpServer';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import {createManagerHttpServer, type ManagerHttpRequest} from '@threadnote/manager/server';
import {managerLoopbackUrl, managerRequestIsAuthorized} from '@threadnote/manager/authorization';
import {
  ensureEffectAiReady,
  resolveEffectAiConfiguration,
  runEffectAiConsolidation,
  runNativeAiConsolidation,
} from '../effect/ai/consolidator.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {captureConsoleWithoutProgress} from '../effect/console.js';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {ApplicationServices} from '../effect/runtime.js';
import {withSharedRepositoryLock} from '../effect/share/lock.js';
import {SystemInfo} from '@threadnote/platform/system';
import {
  runShareInit,
  runSharePublish,
  runShareRemove,
  runShareRename,
  runShareSetUrl,
  runShareSync,
  runShareUnpublish,
} from '../effect/share.js';
import {uriSegment} from '@threadnote/workspace/manifest';
import {
  parseResourceId,
  resourceIdIsManagedMemoryNamespace,
  resourceIdWithoutAnchor,
} from '@threadnote/store/resource-id';
import {
  runArchive,
  runCompact,
  runCompactDiagnostics,
  runExportPack,
  runForget,
  runImportPack,
  runRead,
  runRecall,
  runRemember,
} from '../memory/index.js';
import {
  moveManagerSharedMemoryWithinTeam,
  publishStagedManagerPersonalMemoryMove,
  removeManagerPersonalMemorySource,
  removeManagerSharedMemorySource,
  storeManagerPersonalMemoryMove,
} from './memory/move.js';
import {assertManagerRawPersonalMemorySave, assertManagerRawSharedMemorySave} from './memory/save.js';
import {ManagerMemoryRelationsError, updateManagerMemoryRelations} from './memory/relations.js';
import {managerGraphViewRemovalApprovalDigest} from '@threadnote/manager/graph/removal_digest';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {discardDeferredCodeAnchorIntent} from '../memory/deferred/code_anchor.js';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/hygiene';
import {verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';
import {resolveManagerMemoryIdentity} from './memory/identity.js';
import {
  ensureSharedDirectoryChain,
  assertSharedWorktreeFileReady,
  isInSharedNamespace,
  parentUri,
  publishShareGitChange,
  readTeamsFile,
  resolveTeam,
  sharedTeamNameForUri,
  resourceUriToWorktreeRelative,
  writeMemoryFile,
  writeSharedWorktreeFile,
} from '../share/index.js';
import {collectDoctorChecks, runRepair, runStart} from '../lifecycle.js';
import {runSeed, runSeedSkills} from '../seeding.js';
import {readManagerRuntimeState} from './state.js';
import {handleManagerWorkflowRequest} from './workflow.js';
import {handleManagerProcessRequest} from './processes.js';
import {handleManagerWorkspaceRequest} from './value.js';
import {emptyManagerTree, readManagerTreeRoot} from '@threadnote/manager/tree';
import {
  handleManagerWorksetRequest,
  isManagerWorksetApiPath,
  managerWorksetRequestAllowedDuringMaintenance,
} from './worksets.js';
import * as graphProjects from './graph/projects.js';
import * as graphActions from './graph/actions.js';
import {
  cleanupMode,
  consolidationAgent,
  memoryKind,
  memoryStatus,
  optionalGraphScopeIdentity,
  optionalNonEmptyQuery,
  optionalNonNegativeIntegerQuery,
  optionalPositiveIntegerQuery,
  optionalString,
  requireConfirm,
  requiredQuery,
  requireString,
  requireStringArray,
} from '@threadnote/manager/request_inputs';
import {runCodeGraphPurge, runCodeGraphRepair} from '../code_graph/commands.js';
import {runIsolatedCodeGraphIndexSnapshot} from '@threadnote/graph/isolated/index';
import {
  compactCodeGraphStorageIsolated,
  runCodeGraphAutomaticCompactionScheduler,
  type CodeGraphAutomaticCompactionStatus,
} from '@threadnote/graph/automatic/compaction';
import {inspectAllCodeGraphsLocal} from '@threadnote/graph/diagnostics';
import {readAllCodeGraphBuildStatuses} from '@threadnote/graph/build_status';
import {
  readCodeGraphLocalAssociation,
  resolveAndRecordCodeGraphLocalAssociation,
} from '@threadnote/graph/local_provenance';
import {repositoryIdentityMatchesExpectation} from '@threadnote/graph/repository';
import {CodeGraphStoreBusyError, type RepositoryIdentityExpectation} from '@threadnote/graph/types';
import {codeGraphMaintenanceIntentActive} from '@threadnote/graph/maintenance/gate';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {
  observeCodeGraphLifecycleOpportunityTargets,
  runCodeGraphLifecycleOpportunity,
} from '@threadnote/graph/lifecycle/opportunity';
import {removeCodeGraphView} from '@threadnote/graph/view_removal';
import {renderCodeGraphViewRemovalResult} from '../code_graph/view_removal_output.js';
import {
  managerGraphAnalysis,
  managerGraphBuildCatalog,
  managerGraphCatalogPage,
  managerGraphNodeDetail,
  managerGraphQuery,
  ManagerGraphBusyError,
  ManagerGraphViewUnavailableError,
  releaseManagerGraphSnapshotLeases,
  withManagerGraphSnapshotLeaseInvalidated,
  managerGraphVisualization,
  managerGraphViewsPage,
} from '@threadnote/graph/visualization';
import type {AgentClient, ConsolidationAgent, DoctorCheck, ManageOptions} from '../types.js';
import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {assertResourceUri, findExecutable, runCommand, safeTimestamp, sha256, shellQuote} from '../utils.js';
import {errorMessage} from '@threadnote/platform/errors';
import {toolRoot} from '@threadnote/workspace/installation';
import {isRawMemoryDocument} from '../memory/parse.js';

interface ManagerDirectoryEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
}
class ManagerOperationError extends Schema.TaggedError<ManagerOperationError>()('ManagerOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

function managerOperationError(cause: unknown): ManagerOperationError {
  return Schema.is(ManagerOperationError)(cause)
    ? cause
    : ManagerOperationError.make({cause, message: errorMessage(cause)});
}
const pathJoin = Effect.fn('manager.pathJoin')(function* (...parts: readonly string[]) {
  const path = yield* Path.Path;
  return path.join(...parts);
});

const pathRelative = Effect.fn('manager.pathRelative')(function* (from: string, to: string) {
  const path = yield* Path.Path;
  return path.relative(from, to);
});

const pathSeparator = Effect.map(Path.Path, path => path.sep);

const lstat = Effect.fn('manager.lstat')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const link = yield* fs.readLink(target).pipe(Effect.option);
  const info = yield* fs.stat(target);
  return {
    isDirectory: () => link._tag === 'None' && info.type === 'Directory',
    isFile: () => link._tag === 'None' && info.type === 'File',
    mtime: info.mtime._tag === 'Some' ? info.mtime.value : DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    name: path.basename(target),
    size: Number(info.size),
  };
});

function readFile(target: string): Effect.Effect<Uint8Array, unknown, FileSystem.FileSystem>;
function readFile(target: string, encoding: 'utf8'): Effect.Effect<string, unknown, FileSystem.FileSystem>;
function readFile(
  target: string,
  encoding?: 'utf8',
): Effect.Effect<string | Uint8Array, unknown, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return encoding ? yield* fs.readFileString(target, encoding) : yield* fs.readFile(target);
  });
}

function readdir(
  target: string,
  _options: {readonly withFileTypes: true},
): Effect.Effect<ManagerDirectoryEntry[], unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(target);
    return yield* Effect.forEach(names, name =>
      lstat(path.join(target, name)).pipe(
        Effect.map(info => ({name, isDirectory: info.isDirectory, isFile: info.isFile})),
      ),
    );
  });
}

const rm = Effect.fn('manager.rm')(function* (
  target: string,
  options?: {readonly force?: boolean; readonly recursive?: boolean},
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(target, options);
});

interface ManagerTreeNode {
  readonly children?: readonly ManagerTreeNode[];
  readonly isDir: boolean;
  readonly isShared: boolean;
  readonly isSystem: boolean;
  readonly metadata?: MemoryRecord['metadata'];
  readonly modTime?: string;
  readonly name: string;
  readonly relativePath: string;
  readonly sharedTeam?: string;
  readonly size?: number;
  readonly uri: string;
}

interface ReadTreeOptions {
  readonly parseMemoryDocuments?: boolean;
  readonly rootName?: string;
}

interface ApiContext {
  readonly automaticCompactionStatus?: Ref.Ref<CodeGraphAutomaticCompactionStatus>;
  readonly config: RuntimeConfig;
  readonly jobs: Map<string, ConsolidationJob>;
  readonly worksetScope: Scope.Scope;
  readonly runEffect?: ManagerEffectPromise;
  readonly token: string;
}

class ManagerGraphViewActionBusyError extends Schema.TaggedError<ManagerGraphViewActionBusyError>()(
  'ManagerGraphViewActionBusyError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

class ManagerGraphViewActionError extends Schema.TaggedError<ManagerGraphViewActionError>()(
  'ManagerGraphViewActionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

type ManagerRequest = ManagerHttpRequest;

interface ManagerResponseSink {
  response?: HttpServerResponse.HttpServerResponse;
}

type ManagerOperation<A> = Effect.Effect<A, unknown, ApplicationServices>;
type ManagerEffectPromise = undefined;
const NATIVE_RESOURCE_BACKEND = 'threadnote-native';
const GRAPH_MAINTENANCE_BUSY_MESSAGE =
  'Native code graph repair or maintenance is in progress. Wait for it to finish before starting or using Threadnote Manager.';

type ConsolidationStatus = 'completed' | 'failed' | 'running';

interface ConsolidationJob {
  readonly agent: ConsolidationAgent;
  readonly createdAt: string;
  readonly id: string;
  readonly sourceUris: readonly string[];
  readonly target: TargetMemoryInput;
  draft?: string;
  error?: string;
  status: ConsolidationStatus;
}

interface TargetMemoryInput {
  readonly kind?: MemoryKind;
  readonly project?: string;
  readonly sourceAgentClient?: string;
  readonly status?: MemoryStatus;
  readonly team?: string;
  readonly topic?: string;
}

interface BulkItemResult {
  readonly ok: boolean;
  readonly output?: string;
  readonly uri: string;
  readonly error?: string;
}

const STATIC_FILES: Readonly<
  Record<
    string,
    {
      readonly contentType: string;
      readonly directory?: 'assets/brand' | 'manager';
      readonly path: string;
      readonly sourceDirectory?: 'dist/manager' | 'packages/manager/static';
    }
  >
> = {
  '/': {contentType: 'text/html; charset=utf-8', path: 'index.html', sourceDirectory: 'packages/manager/static'},
  '/index.html': {
    contentType: 'text/html; charset=utf-8',
    path: 'index.html',
    sourceDirectory: 'packages/manager/static',
  },
  '/app.css': {
    contentType: 'text/css; charset=utf-8',
    path: 'app.css',
    sourceDirectory: 'packages/manager/static',
  },
  '/app.js': {contentType: 'text/javascript; charset=utf-8', path: 'app.js', sourceDirectory: 'dist/manager'},
  '/threadnote-logo.svg': {
    contentType: 'image/svg+xml; charset=utf-8',
    directory: 'assets/brand',
    path: 'threadnote-logo.svg',
  },
};

export function runManage(config: RuntimeConfig, options: ManageOptions) {
  return Effect.scoped(
    Layer.build(BunHttpServer.layer({hostname: '127.0.0.1', port: options.uiPort ?? 0})).pipe(
      Effect.flatMap(context =>
        Effect.gen(function* () {
          if (yield* codeGraphMaintenanceIntentActive(config.agentContextHome)) {
            return yield* ManagerOperationError.make({message: GRAPH_MAINTENANCE_BUSY_MESSAGE});
          }
          const crypto = yield* Crypto.Crypto;
          const lifecycleMaintenance = yield* CodeGraphMaintenanceCoordinator;
          const lifecycleTargets = yield* observeCodeGraphLifecycleOpportunityTargets(config.agentContextHome);
          yield* runCodeGraphLifecycleOpportunity({
            maintenance: lifecycleMaintenance,
            opportunity: 'startup',
            targets: lifecycleTargets,
            threadnoteHome: config.agentContextHome,
          }).pipe(Effect.catch(() => Effect.void));
          const token = Base64Url.encode(yield* crypto.randomBytes(24));
          const automaticCompactionStatus = yield* Ref.make<CodeGraphAutomaticCompactionStatus>({state: 'idle'});
          const worksetScope = yield* Scope.Scope;
          const server = yield* HttpServer.HttpServer;
          yield* Effect.addFinalizer(() => releaseManagerGraphSnapshotLeases());
          yield* server.serve(
            createManagerServer({automaticCompactionStatus, config, jobs: new Map(), token, worksetScope}),
          );
          yield* Effect.forkScoped(
            runCodeGraphAutomaticCompactionScheduler(config.agentContextHome, status =>
              Ref.set(automaticCompactionStatus, status),
            ),
          );
          const actualPort =
            server.address._tag === 'InetAddressV4' || server.address._tag === 'InetAddressV6'
              ? server.address.port
              : (options.uiPort ?? 0);
          const url = managerLoopbackUrl(actualPort, token);
          yield* Console.log(`Threadnote manager: ${url}`);
          yield* Console.log('Press Ctrl-C to stop the manager.');
          if (options.open !== false) {
            yield* runCommandEffect('open', [url], {allowFailure: true});
          }
          return yield* Effect.never;
        }).pipe(Effect.provide(context)),
      ),
    ),
  );
}

export function createManagerServer(context: ApiContext) {
  return createManagerHttpServer(request =>
    Effect.gen(function* () {
      const response: ManagerResponseSink = {};
      yield* handleRequestEffect(context, request, response);
      return response.response;
    }),
  );
}

export const memoryTree = Effect.fn('manager.memoryTree')(function* (config: RuntimeConfig) {
  const root = yield* localMemoriesRoot(config);
  const uri = `threadnote://user/${uriSegment(config.user)}/memories`;
  return yield* readManagerTreeRoot(lstat(root), readTree(config, root, uri, ''), emptyManagerTree('memories', uri));
});

export const resourcesTree = Effect.fn('manager.resourcesTree')(function* (config: RuntimeConfig) {
  const root = yield* localResourcesRoot(config);
  const uri = 'threadnote://resources';
  return yield* readManagerTreeRoot(
    lstat(root),
    readTree(config, root, uri, '', {parseMemoryDocuments: false, rootName: 'resources'}),
    emptyManagerTree('resources', uri),
  );
});

export const readManagedMemory = Effect.fn('manager.readManagedMemory')(function* (config: RuntimeConfig, uri: string) {
  const resolved = yield* resolveManagerMemoryIdentity(config, uri);
  const canonicalUri = resolved.canonicalUri;
  const path = yield* localPathForMemoryUri(config, canonicalUri);
  if (!path) return yield* ManagerOperationError.make({message: `Memory is outside this Library: ${canonicalUri}`});
  const pathStat = yield* lstat(path);
  if (!pathStat.isFile())
    return yield* ManagerOperationError.make({message: `Manager requires regular memory files: ${canonicalUri}`});
  const content = yield* readFile(path, 'utf8');
  yield* verifyResolvedMemoryIdentity(resolved, canonicalUri, content);
  const relativePath = (yield* pathRelative(yield* localMemoriesRoot(config), path))
    .split(yield* pathSeparator)
    .join('/');
  const record = parseMemoryDocument(canonicalUri, content);
  return {
    content,
    node: {
      isDir: false,
      isShared: isInSharedNamespace(config, canonicalUri),
      isSystem: SYSTEM_MEMORY_NAMES.has(path.split(yield* pathSeparator).at(-1) ?? ''),
      metadata: record?.metadata,
      modTime: pathStat.mtime.toISOString(),
      name: path.split(yield* pathSeparator).at(-1) ?? canonicalUri,
      relativePath,
      sharedTeam: sharedTeamNameForUri(config, canonicalUri),
      size: pathStat.size,
      uri: canonicalUri,
    },
    record,
  };
});

export const readContextUri = Effect.fn('manager.readContextUri')(function* (
  config: RuntimeConfig,
  uri: string,
  runEffect?: ManagerEffectPromise,
) {
  assertResourceUri(uri);
  const localMemory = yield* Effect.result(readManagedMemory(config, uri));
  if (Result.isSuccess(localMemory)) {
    return {
      content: localMemory.success.content,
      localMemory: localMemory.success,
      output: localMemory.success.content,
    };
  }
  const result = yield* runCaptured(() => runRead(config, uri, {}), runEffect);
  return {content: result.output, output: result.output};
});

export {detectConsolidationAgents} from './state.js';
function handleRequestEffect(context: ApiContext, request: ManagerRequest, response: ManagerResponseSink) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  let requestEffect;
  if (request.method === 'GET' && url.pathname === '/api/health') {
    requestEffect = Effect.sync(() => {
      const authorized = isAuthorized(context, request);
      writeJson(response, authorized ? 200 : 401, authorized ? {status: 'ok'} : {error: 'Unauthorized'});
    });
  } else if (request.method === 'GET' && url.pathname === '/api/state') {
    requestEffect = Effect.gen(function* () {
      if (!isAuthorized(context, request)) {
        writeJson(response, 401, {error: 'Unauthorized'});
        return;
      }
      const state = yield* readManagerRuntimeState(context.config);
      writeJson(response, 200, {
        ...state,
        config: publicConfig(context.config),
      });
    });
  } else if (request.method === 'POST' && url.pathname === '/api/consolidations') {
    requestEffect = Effect.gen(function* () {
      if (!isAuthorized(context, request)) {
        writeJson(response, 401, {error: 'Unauthorized'});
        return;
      }
      const body = yield* readJsonBody(request);
      const job = yield* createConsolidation(context, body);
      writeJson(response, 200, {job});
    });
  } else {
    requestEffect = handleRequestLegacy(context, request, response);
  }

  return requestEffect.pipe(
    Effect.catch(error =>
      Effect.sync(() => {
        if (Schema.is(ManagerGraphBusyError)(error)) {
          writeJson(response, 409, {error: error.message, retryAfterMilliseconds: 1_000});
          return;
        }
        if (Schema.is(ManagerGraphViewActionBusyError)(error)) {
          writeJson(response, 409, {
            code: 'graph-view-busy',
            error: error.message,
            retryAfterMilliseconds: 1_000,
          });
          return;
        }
        if (Schema.is(ManagerGraphViewUnavailableError)(error)) {
          writeJson(response, 409, {code: 'graph-view-stale', error: error.message, retryAfterMilliseconds: 0});
          return;
        }
        if (error instanceof ManagerMemoryRelationsError)
          return writeJson(response, error.status, {code: error.code, error: error.message, retryAfterMilliseconds: 0});
        if (Schema.is(graphProjects.ManagerGraphProjectActionError)(error))
          return writeJson(response, 409, {code: error.code, error: error.message, retryAfterMilliseconds: 0});
        writeJson(response, 500, {error: errorMessage(error)});
      }),
    ),
  );
}

const handleRequestLegacy = Effect.fn('manager.handleRequestLegacy')(function* (
  context: ApiContext,
  request: ManagerRequest,
  response: ManagerResponseSink,
) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && STATIC_FILES[url.pathname]) {
    yield* serveStatic(context, url, response);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.response = HttpServerResponse.empty({status: 204, headers: {'cache-control': 'no-store'}});
    return;
  }
  if (!isAuthorized(context, request)) {
    writeJson(response, 401, {error: 'Unauthorized'});
    return;
  }
  const workflowResponse = yield* handleManagerWorkflowRequest({
    body: request.body,
    config: context.config,
    jobContext: {key: context, scope: context.worksetScope},
    method: request.method,
    url,
  });
  if (workflowResponse) {
    writeJson(response, workflowResponse.status, workflowResponse.body);
    return;
  }
  const processResponse = yield* handleManagerProcessRequest({
    body: request.body,
    config: context.config,
    method: request.method,
    url,
  });
  if (processResponse) {
    writeJson(response, processResponse.status, processResponse.body);
    return;
  }
  const workspaceResponse = yield* handleManagerWorkspaceRequest({
    body: request.body,
    config: context.config,
    method: request.method,
    url,
  });
  if (workspaceResponse) return writeJson(response, workspaceResponse.status, workspaceResponse.body);
  if (
    ((isGraphApiPath(url.pathname) && url.pathname !== '/api/graphs/status') ||
      (isManagerWorksetApiPath(url.pathname) &&
        !managerWorksetRequestAllowedDuringMaintenance(request.method, url.pathname))) &&
    (yield* codeGraphMaintenanceIntentActive(context.config.agentContextHome))
  ) {
    writeJson(response, 409, {
      code: 'maintenance-busy',
      error: GRAPH_MAINTENANCE_BUSY_MESSAGE,
      retryAfterMilliseconds: 1_000,
    });
    return;
  }
  const worksetResponse = yield* handleManagerWorksetRequest({
    body: request.body,
    config: context.config,
    contextKey: context,
    jobScope: context.worksetScope,
    method: request.method,
    url,
  });
  if (worksetResponse) {
    writeJson(response, worksetResponse.status, worksetResponse.body);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/tree') {
    const [tree, resourceTree] = yield* Effect.all([memoryTree(context.config), resourcesTree(context.config)]);
    writeJson(response, 200, {resourcesTree: resourceTree, tree});
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/graphs')
    return writeJson(response, 200, yield* graphProjects.managerGraphProjectCatalog(context.config));
  if (request.method === 'GET' && url.pathname === '/api/graphs/status') {
    const automaticCompaction = context.automaticCompactionStatus
      ? yield* Ref.get(context.automaticCompactionStatus)
      : undefined;
    writeJson(response, 200, yield* managerGraphBuildCatalog(context.config.agentContextHome, automaticCompaction));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/graphs/diagnostics') {
    writeJson(
      response,
      200,
      yield* inspectAllCodeGraphsLocal(context.config.agentContextHome, {
        analyze: url.searchParams.get('analyze') === 'true',
        deep: url.searchParams.get('deep') === 'true',
      }),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/graphs/page') {
    writeJson(
      response,
      200,
      yield* managerGraphCatalogPage(
        context.config.agentContextHome,
        requiredQuery(url, 'repository'),
        Option.some(requiredQuery(url, 'snapshot')),
        {
          offset: Option.getOrUndefined(optionalNonNegativeIntegerQuery(url, 'offset')),
          query: Option.getOrUndefined(optionalNonEmptyQuery(url, 'query')),
          workspaceOffset: Option.getOrUndefined(optionalNonNegativeIntegerQuery(url, 'workspaceOffset')),
        },
      ),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/graphs/views') {
    writeJson(
      response,
      200,
      yield* managerGraphViewsPage(context.config.agentContextHome, requiredQuery(url, 'repository'), {
        offset: Option.getOrUndefined(optionalNonNegativeIntegerQuery(url, 'offset')),
        query: Option.getOrUndefined(optionalNonEmptyQuery(url, 'query')),
        scopeIds: url.searchParams.getAll('scope'),
      }),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/graph') {
    writeJson(
      response,
      200,
      yield* managerGraphVisualization(
        context.config.agentContextHome,
        requiredQuery(url, 'repository'),
        Option.getOrElse(Option.fromNullishOr(url.searchParams.get('project')), () => 'all'),
        {
          ...Option.match(optionalPositiveIntegerQuery(url, 'edgeLimit'), {
            onNone: () => ({}),
            onSome: edgeLimit => ({edgeLimit}),
          }),
          ...Option.match(optionalPositiveIntegerQuery(url, 'nodeLimit'), {
            onNone: () => ({}),
            onSome: nodeLimit => ({nodeLimit}),
          }),
        },
        optionalNonEmptyQuery(url, 'snapshot'),
      ),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/graph/analysis') {
    writeJson(
      response,
      200,
      yield* managerGraphAnalysis(
        context.config.agentContextHome,
        requiredQuery(url, 'repository'),
        optionalNonEmptyQuery(url, 'snapshot'),
      ),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/graph/query') {
    writeJson(
      response,
      200,
      yield* managerGraphQuery(
        context.config.agentContextHome,
        requiredQuery(url, 'repository'),
        requiredQuery(url, 'query'),
        {
          ...Option.match(optionalPositiveIntegerQuery(url, 'edgeLimit'), {
            onNone: () => ({}),
            onSome: edgeLimit => ({edgeLimit}),
          }),
          ...Option.match(optionalPositiveIntegerQuery(url, 'nodeLimit'), {
            onNone: () => ({}),
            onSome: nodeLimit => ({nodeLimit}),
          }),
        },
        Option.some(requiredQuery(url, 'snapshot')),
      ),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/graph/node') {
    writeJson(
      response,
      200,
      yield* managerGraphNodeDetail(
        context.config.agentContextHome,
        requiredQuery(url, 'repository'),
        requiredQuery(url, 'node'),
        optionalNonEmptyQuery(url, 'snapshot'),
      ),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/memory') {
    writeJson(response, 200, yield* readManagedMemory(context.config, requiredQuery(url, 'uri')));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/read') {
    writeJson(response, 200, yield* readContextUri(context.config, requiredQuery(url, 'uri'), context.runEffect));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/shares') {
    writeJson(response, 200, {shares: yield* shareSummaries(context.config)});
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/doctor') {
    writeJson(response, 200, {
      checks: yield* collectManagerDoctorChecks(context.config),
      shares: yield* shareSummaries(context.config),
    });
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/consolidations/')) {
    const id = url.pathname.split('/').at(-1) ?? '';
    const job = context.jobs.get(id);
    writeJson(response, job ? 200 : 404, job ? {job} : {error: 'Consolidation job not found'});
    return;
  }
  if (request.method !== 'POST') {
    writeJson(response, 404, {error: 'Not found'});
    return;
  }

  const body = yield* readJsonBody(request);
  switch (url.pathname) {
    case '/api/graphs/action':
      writeJson(response, 200, yield* runManagerGraphAction(context.config, body, context.runEffect));
      return;
    case '/api/memory/archive':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(() => runArchive(context.config, requireString(body.uri, 'uri'), body), context.runEffect),
      );
      return;
    case '/api/memory/forget':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(() => runForget(context.config, requireString(body.uri, 'uri'), {}), context.runEffect),
      );
      return;
    case '/api/memory/save':
      writeJson(response, 200, yield* saveMemory(context.config, body, context.runEffect));
      return;
    case '/api/memory/relations':
      writeJson(response, 200, yield* updateManagerMemoryRelations(context.config, body));
      return;
    case '/api/memory/move':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* moveMemory(context.config, requireString(body.uri, 'uri'), targetFromBody(body), context.runEffect),
      );
      return;
    case '/api/memory/publish':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(
          () =>
            runSharePublish(context.config, requireString(body.uri, 'uri'), {
              redact: body.redact === true,
              team: optionalString(body.team),
            }),
          context.runEffect,
        ),
      );
      return;
    case '/api/memory/unpublish':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(
          () => runShareUnpublish(context.config, requireString(body.uri, 'uri'), {team: optionalString(body.team)}),
          context.runEffect,
        ),
      );
      return;
    case '/api/folder/remove':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(
          () => removeManagedFolder(context.config, requireString(body.uri, 'uri')),
          context.runEffect,
        ),
      );
      return;
    case '/api/bulk':
      requireConfirm(body);
      writeJson(response, 200, yield* runBulk(context.config, body, context.runEffect));
      return;
    case '/api/compact':
      if (body.apply === true) {
        requireConfirm(body);
      }
      writeJson(
        response,
        200,
        yield* runCaptured(
          () =>
            Effect.gen(function* () {
              yield* runCompactDiagnostics(context.config, body);
              yield* runCompact(context.config, body);
            }),
          context.runEffect,
        ),
      );
      return;
    case '/api/recall':
      writeJson(
        response,
        200,
        yield* runCaptured(
          () =>
            runRecall(context.config, {
              query: requireString(body.query, 'query'),
              nodeLimit: optionalString(body.nodeLimit),
              project: optionalString(body.project),
            }),
          context.runEffect,
        ),
      );
      return;
    case '/api/read':
      writeJson(
        response,
        200,
        yield* readContextUri(context.config, requireString(body.uri, 'uri'), context.runEffect),
      );
      return;
    case '/api/shares/init':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(
          () =>
            runShareInit(context.config, requireString(body.remoteUrl, 'remoteUrl'), {
              team: optionalString(body.team),
            }),
          context.runEffect,
        ),
      );
      return;
    case '/api/shares/rename':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(
          () =>
            runShareRename(context.config, {
              team: requireString(body.team, 'team'),
              to: requireString(body.to, 'to'),
            }),
          context.runEffect,
        ),
      );
      return;
    case '/api/shares/set-url':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(
          () =>
            runShareSetUrl(context.config, requireString(body.remoteUrl, 'remoteUrl'), {
              team: optionalString(body.team),
            }),
          context.runEffect,
        ),
      );
      return;
    case '/api/shares/remove':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(
          () =>
            runShareRemove(context.config, {
              keepFiles: body.keepFiles === true,
              preserveLocal: body.preserveLocal === true,
              team: optionalString(body.team),
            }),
          context.runEffect,
        ),
      );
      return;
    case '/api/shares/sync':
      writeJson(
        response,
        200,
        yield* runCaptured(() => runShareSync(context.config, {team: optionalString(body.team)}), context.runEffect),
      );
      return;
    case '/api/doctor/start':
      writeJson(response, 200, yield* runCaptured(() => runStart(context.config, {}), context.runEffect));
      return;
    case '/api/doctor/repair-dry-run':
      writeJson(response, 200, yield* runCaptured(() => runRepair(context.config, {dryRun: true}), context.runEffect));
      return;
    case '/api/doctor/repair':
      requireConfirm(body);
      writeJson(response, 200, yield* runCaptured(() => runRepair(context.config, {dryRun: false}), context.runEffect));
      return;
    case '/api/import-pack':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(
          () => runImportPack(context.config, {path: requireString(body.path, 'path')}),
          context.runEffect,
        ),
      );
      return;
    case '/api/export-pack':
      writeJson(
        response,
        200,
        yield* runCaptured(
          () => runExportPack(context.config, {path: optionalString(body.path), uri: optionalString(body.uri)}),
          context.runEffect,
        ),
      );
      return;
    case '/api/seed':
      requireConfirm(body);
      writeJson(
        response,
        200,
        yield* runCaptured(
          () =>
            body.skills === true
              ? runSeedSkills(context.config, {dryRun: body.dryRun === true})
              : runSeed(context.config, {dryRun: body.dryRun === true}),
          context.runEffect,
        ),
      );
      return;
    default:
      if (url.pathname.startsWith('/api/consolidations/') && url.pathname.endsWith('/apply')) {
        requireConfirm(body);
        const id = url.pathname.split('/').at(-2) ?? '';
        writeJson(response, 200, yield* applyConsolidation(context.config, context.jobs, id, body, context.runEffect));
        return;
      }
      writeJson(response, 404, {error: 'Not found'});
  }
});

const serveStatic = Effect.fn('manager.serveStatic')(function* (
  context: ApiContext,
  url: URL,
  response: ManagerResponseSink,
) {
  const file = STATIC_FILES[url.pathname] ?? STATIC_FILES['/'];
  const directory =
    typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE
      ? (file.directory ?? 'manager')
      : (file.sourceDirectory ?? file.directory ?? 'manager');
  const content = yield* readFile(yield* pathJoin(yield* toolRoot(), directory, file.path));
  response.response = HttpServerResponse.uint8Array(content, {
    status: 200,
    headers: {'cache-control': 'no-store', 'content-type': file.contentType},
  });
});

const readTree: (
  config: RuntimeConfig,
  path: string,
  uri: string,
  relativePath: string,
  options?: ReadTreeOptions,
) => Effect.Effect<ManagerTreeNode, unknown, FileSystem.FileSystem | Path.Path> = Effect.fn('manager.readTree')(
  function* (config: RuntimeConfig, path: string, uri: string, relativePath: string, options: ReadTreeOptions = {}) {
    const pathStat = yield* lstat(path);
    const name = relativePath ? (relativePath.split('/').at(-1) ?? relativePath) : (options.rootName ?? 'memories');
    const isDir = pathStat.isDirectory();
    if (!isDir) {
      if (!pathStat.isFile()) {
        throw ManagerOperationError.make({message: `Manager can only read regular files or directories: ${uri}`});
      }
      const record =
        options.parseMemoryDocuments === false
          ? undefined
          : parseMemoryDocument(uri, yield* readFile(path, 'utf8').pipe(Effect.orElseSucceed(() => '')));
      return {
        isDir: false,
        isShared: isInSharedNamespace(config, uri),
        isSystem: SYSTEM_MEMORY_NAMES.has(name),
        metadata: record?.metadata,
        modTime: pathStat.mtime.toISOString(),
        name,
        relativePath,
        sharedTeam: sharedTeamNameForUri(config, uri),
        size: pathStat.size,
        uri,
      };
    }
    const entries = yield* readdir(path, {withFileTypes: true});
    const children = yield* Effect.forEach(
      entries
        .filter(entry => entry.isDirectory() || entry.isFile())
        .sort(
          (left, right) =>
            Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name),
        ),
      Effect.fn('manager.readTreeChild')(function* (entry) {
        const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        return yield* readTree(
          config,
          yield* pathJoin(path, entry.name),
          `${uri}/${entry.name}`,
          childRelative,
          options,
        );
      }),
    );
    return {
      children,
      isDir: true,
      isShared: isInSharedNamespace(config, uri),
      isSystem: SYSTEM_MEMORY_NAMES.has(name),
      modTime: pathStat.mtime.toISOString(),
      name,
      relativePath,
      sharedTeam: sharedTeamNameForUri(config, uri),
      size: pathStat.size,
      uri,
    };
  },
);

const saveMemory = Effect.fn('manager.saveMemory')(function (
  config: RuntimeConfig,
  body: Record<string, unknown>,
  runEffect: ManagerEffectPromise | undefined,
) {
  const text = requireString(body.text, 'text');
  const replaceUri = optionalString(body.replaceUri);
  if (replaceUri && isRawMemoryDocument(text)) {
    return runCaptured(() => {
      const write = writeRawMemory(config, replaceUri, text, optionalString(body.expectedContent));
      return isInSharedNamespace(config, replaceUri) ? withSharedRepositoryLock(config, write) : write;
    }, runEffect);
  }
  return runCaptured(
    () =>
      runRemember(config, {
        kind: memoryKind(body.kind) ?? 'durable',
        project: optionalString(body.project),
        replace: replaceUri,
        sourceAgentClient: optionalString(body.sourceAgentClient) ?? 'manager',
        status: memoryStatus(body.status) ?? 'active',
        text,
        topic: optionalString(body.topic),
      }),
    runEffect,
  );
});

const writeRawMemory = Effect.fn('manager.writeRawMemory')(function* (
  config: RuntimeConfig,
  uri: string,
  content: string,
  expectedContent: string | undefined,
) {
  assertResourceUri(uri);
  const canonicalUri = resourceIdWithoutAnchor(parseResourceId(uri)).canonicalUri;
  const write = Effect.gen(function* () {
    const ov = NATIVE_RESOURCE_BACKEND;
    if (isInSharedNamespace(config, canonicalUri)) {
      const teamName = sharedTeamNameForUri(config, canonicalUri);
      if (!teamName) {
        return yield* ManagerOperationError.make({message: `${canonicalUri} is not in a configured shared namespace.`});
      }
      const team = yield* resolveTeam(config, teamName);
      const existing = yield* readManagedMemory(config, canonicalUri);
      yield* Effect.try({
        catch: managerOperationError,
        try: () => assertManagerRawSharedMemorySave(config, canonicalUri, existing.content, expectedContent, content),
      });
      const relativePath = resourceUriToWorktreeRelative(config, canonicalUri, team.name);
      yield* assertSharedWorktreeFileReady(team.config.worktree, relativePath, existing.content);
      yield* ensureSharedDirectoryChain(config, ov, canonicalUri, false);
      yield* writeMemoryFile(config, ov, canonicalUri, content, 'replace', false);
      yield* writeSharedWorktreeFile(team.config.worktree, relativePath, content);
      yield* publishShareGitChange(team.config.worktree, relativePath, `share: update ${relativePath}`);
      return;
    }
    const existing = yield* readManagedMemory(config, canonicalUri);
    yield* Effect.try({
      catch: managerOperationError,
      try: () => assertManagerRawPersonalMemorySave(canonicalUri, existing.content, expectedContent, content),
    });
    yield* ensurePersonalDirectoryChain(config, ov, parentUri(canonicalUri));
    yield* writeMemoryFile(config, ov, canonicalUri, content, 'replace', false);
    yield* discardDeferredCodeAnchorIntent(config, canonicalUri);
  });
  if (!resourceIdIsManagedMemoryNamespace(canonicalUri)) {
    return yield* write;
  }
  const fs = yield* FileSystem.FileSystem;
  return yield* withMemoryUriLocks(fs, config.agentContextHome, [canonicalUri], write);
});

const moveMemory = Effect.fn('manager.moveMemory')(function* (
  config: RuntimeConfig,
  sourceUri: string,
  target: TargetMemoryInput,
  runEffect: ManagerEffectPromise | undefined,
) {
  assertResourceUri(sourceUri);
  const source = yield* readManagedMemory(config, sourceUri);
  const sourceRecord = source.record;
  const metadata = {
    kind: target.kind ?? sourceRecord?.metadata.kind ?? 'durable',
    project: target.project ?? sourceRecord?.metadata.project ?? 'general',
    sourceAgentClient: target.sourceAgentClient ?? sourceRecord?.metadata.sourceAgentClient ?? 'manager',
    status: target.status ?? sourceRecord?.metadata.status ?? 'active',
    topic: target.topic ?? sourceRecord?.metadata.topic ?? 'current',
  };
  const personalTargetUri = yield* memoryUriFor(config, metadata);
  if (target.team) {
    const targetTeam = target.team;
    if (isInSharedNamespace(config, sourceUri)) {
      const team = sharedTeamNameForUri(config, sourceUri);
      if (team !== targetTeam) {
        throw ManagerOperationError.make({
          message: 'Cross-team shared moves are not supported in V1. Copy/unpublish, then publish to the target team.',
        });
      }
      const sharedTargetUri = sharedMemoryUriFor(config, targetTeam, metadata);
      const output = yield* runCaptured(
        () =>
          withSharedRepositoryLock(
            config,
            moveManagerSharedMemoryWithinTeam(config, sourceUri, sharedTargetUri, source.content, targetTeam),
          ),
        runEffect,
      );
      return {...output, targetUri: sharedTargetUri};
    }
    const citationBlocker = memoryCodeCitationContentSharingBlocker(sourceUri, source.content);
    if (citationBlocker) {
      return yield* ManagerOperationError.make({
        message: `Refusing to move ${sourceUri} into shared memory: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
      });
    }
    if (personalTargetUri === sourceUri) {
      const published = yield* runCaptured(() => runSharePublish(config, sourceUri, {team: targetTeam}), runEffect);
      return {...published, targetUri: sharedMemoryUriFor(config, targetTeam, metadata)};
    }
    // Stage the reformatted personal destination without deleting the source.
    // Publication owns/removes the stage; only after it succeeds do we CAS-
    // remove the original. This keeps every pre-publication failure lossless.
    const saved = yield* runCaptured(
      () => storeManagerPersonalMemoryMove(config, sourceUri, source.content, metadata, false),
      runEffect,
    );
    const staged = yield* readManagedMemory(config, personalTargetUri);
    const publishExit = yield* Effect.exit(
      runCaptured(
        () =>
          publishStagedManagerPersonalMemoryMove(
            config,
            sourceUri,
            source.content,
            personalTargetUri,
            staged.content,
            targetTeam,
          ),
        runEffect,
      ),
    );
    if (Exit.isFailure(publishExit)) {
      yield* removeManagerPersonalMemorySource(config, personalTargetUri, staged.content).pipe(
        Effect.catch(cleanupError =>
          Console.warn(`WARN could not clean up staged move ${personalTargetUri}: ${errorMessage(cleanupError)}`),
        ),
      );
      if (Cause.hasInterrupts(publishExit.cause)) {
        return yield* Effect.failCause(publishExit.cause);
      }
      return yield* managerOperationError(Cause.squash(publishExit.cause));
    }
    const published = publishExit.value;
    return {
      output: [saved.output, published.output].filter(Boolean).join('\n'),
      targetUri: sharedMemoryUriFor(config, targetTeam, metadata),
    };
  }
  if (isInSharedNamespace(config, sourceUri)) {
    const saved = yield* runCaptured(
      () => storeManagerPersonalMemoryMove(config, sourceUri, source.content, metadata, false),
      runEffect,
    );
    const personalTarget = yield* readManagedMemory(config, personalTargetUri);
    const removed = yield* runCaptured(
      () =>
        withSharedRepositoryLock(
          config,
          removeManagerSharedMemorySource(config, sourceUri, source.content, personalTargetUri, personalTarget.content),
        ),
      runEffect,
    );
    return {output: [saved.output, removed.output].filter(Boolean).join('\n'), targetUri: personalTargetUri};
  }
  const output = yield* runCaptured(
    () => storeManagerPersonalMemoryMove(config, sourceUri, source.content, metadata, true),
    runEffect,
  );
  return {...output, targetUri: personalTargetUri};
});

const removeManagedFolder = Effect.fn('manager.removeManagedFolder')(function* (config: RuntimeConfig, uri: string) {
  assertResourceUri(uri);
  const rootUri = `threadnote://user/${uriSegment(config.user)}/memories`;
  if (uri === rootUri) {
    throw ManagerOperationError.make({message: 'Refusing to remove the root memories folder.'});
  }
  if (isInSharedNamespace(config, uri)) {
    throw ManagerOperationError.make({
      message: 'Shared folders are managed from Sharing. Remove the share or unpublish selected memories.',
    });
  }
  const path = yield* localPathForMemoryUri(config, uri);
  if (!path) {
    throw ManagerOperationError.make({message: `Manager can only remove current-user memory folders: ${uri}`});
  }
  const pathStat = yield* lstat(path);
  if (!pathStat.isDirectory()) {
    throw ManagerOperationError.make({message: `Not a folder: ${uri}`});
  }
  const relativePath = yield* pathRelative(yield* localMemoriesRoot(config), path);
  if (!relativePath || relativePath.startsWith('..') || relativePath.split(yield* pathSeparator).includes('..')) {
    throw ManagerOperationError.make({message: 'Refusing to remove a folder outside the memories tree.'});
  }
  const fileUris = yield* fileUrisUnderFolder(config, path);
  for (const fileUri of fileUris) {
    yield* runForget(config, fileUri, {});
  }
  yield* rm(path, {force: true, recursive: true});
  yield* Console.log(`Removed folder: ${uri}`);
  yield* Console.log(`Forgot ${fileUris.length} file${fileUris.length === 1 ? '' : 's'}.`);
});

const fileUrisUnderFolder: (
  config: RuntimeConfig,
  folderPath: string,
) => Effect.Effect<readonly string[], unknown, FileSystem.FileSystem | Path.Path> = Effect.fn(
  'manager.fileUrisUnderFolder',
)(function* (config: RuntimeConfig, folderPath: string) {
  const entries = yield* readdir(folderPath, {withFileTypes: true});
  const uris: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = yield* pathJoin(folderPath, entry.name);
    if (entry.isDirectory()) {
      uris.push(...(yield* fileUrisUnderFolder(config, path)));
    } else if (entry.isFile()) {
      uris.push(yield* localPathToMemoryUri(config, path));
    }
  }
  return uris;
});

const runBulk = Effect.fn('manager.runBulk')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
  runEffect: ManagerEffectPromise | undefined,
) {
  const action = requireString(body.action, 'action');
  const uris = requireStringArray(body.uris, 'uris');
  const results: BulkItemResult[] = [];
  for (const uri of uris) {
    const outcome = yield* Effect.result(
      Effect.gen(function* () {
        let output: string;
        if (action === 'archive') {
          output = (yield* runCaptured(() => runArchive(config, uri, {}), runEffect)).output;
        } else if (action === 'forget') {
          output = (yield* runCaptured(() => runForget(config, uri, {}), runEffect)).output;
        } else if (action === 'publish') {
          output = (yield* runCaptured(
            () => runSharePublish(config, uri, {team: optionalString(body.team)}),
            runEffect,
          )).output;
        } else {
          return yield* ManagerOperationError.make({message: `Unsupported bulk action: ${action}`});
        }
        return output;
      }),
    );
    if (Result.isSuccess(outcome)) {
      results.push({ok: true, output: outcome.success, uri});
    } else {
      results.push({error: errorMessage(outcome.failure), ok: false, uri});
    }
  }
  return {results};
});

function createConsolidation(context: ApiContext, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const input = yield* Effect.try({
      try: () => ({
        agent: consolidationAgent(requireString(body.agent, 'agent')),
        sourceUris: requireStringArray(body.uris, 'uris'),
        target: targetFromBody(body),
      }),
      catch: managerOperationError,
    });
    const job: ConsolidationJob = {
      agent: input.agent,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      id: yield* crypto.randomUUIDv4,
      sourceUris: input.sourceUris,
      status: 'running',
      target: input.target,
    };
    context.jobs.set(job.id, job);
    yield* Effect.gen(function* () {
      const sources = yield* Effect.forEach(input.sourceUris, uri => readManagedMemory(context.config, uri));
      job.draft = yield* runConsolidationAgent(context.config, input.agent, sources);
      job.status = 'completed';
    }).pipe(
      Effect.catch(error =>
        Effect.sync(() => {
          job.error = errorMessage(error);
          job.status = 'failed';
        }),
      ),
    );
    return job;
  });
}

const applyConsolidation = Effect.fn('manager.applyConsolidation')(function* (
  config: RuntimeConfig,
  jobs: Map<string, ConsolidationJob>,
  id: string,
  body: Record<string, unknown>,
  runEffect: ManagerEffectPromise | undefined,
) {
  const job = jobs.get(id);
  if (!job) {
    throw ManagerOperationError.make({message: 'Consolidation job not found.'});
  }
  if (job.status !== 'completed' || !job.draft) {
    throw ManagerOperationError.make({message: 'Consolidation job is not completed.'});
  }
  const draft = optionalString(body.draft) ?? job.draft;
  const target = targetFromBody({...job.target, ...body});
  const saved = yield* runCaptured(
    () =>
      runRemember(config, {
        kind: target.kind ?? 'durable',
        project: target.project,
        sourceAgentClient: target.sourceAgentClient ?? 'manager',
        status: target.status ?? 'active',
        text: draft,
        topic: target.topic,
      }),
    runEffect,
  );
  const cleanup = cleanupMode(body.cleanup);
  const cleanupOutputs: string[] = [];
  if (cleanup !== 'keep') {
    for (const uri of job.sourceUris) {
      if (isInSharedNamespace(config, uri) && body.cleanupShared !== true) {
        cleanupOutputs.push(`Skipped shared source cleanup: ${uri}`);
        continue;
      }
      const action = cleanup === 'forget' ? () => runForget(config, uri, {}) : () => runArchive(config, uri, {});
      cleanupOutputs.push((yield* runCaptured(action, runEffect)).output);
    }
  }
  return {output: [saved.output, ...cleanupOutputs].filter(Boolean).join('\n')};
});

function runConsolidationAgent(
  runtimeConfig: RuntimeConfig,
  agent: ConsolidationAgent,
  sources: readonly {readonly content: string; readonly node: ManagerTreeNode}[],
) {
  const prompt = consolidationPrompt(sources);
  if (agent === 'effect-ai') {
    return Effect.gen(function* () {
      const resolved = yield* resolveEffectAiConfiguration(runtimeConfig, (yield* SystemInfo).environment());
      if (resolved) {
        yield* ensureEffectAiReady(runtimeConfig, resolved);
        return yield* runEffectAiConsolidation(prompt, resolved.configuration);
      }
      const native = yield* runNativeAiConsolidation(runtimeConfig, prompt);
      return (
        native ??
        (yield* ManagerOperationError.make({
          message:
            'No generation model is selected. Install and select one with `threadnote models`, or configure an explicit remote Effect AI provider.',
        }))
      );
    });
  }
  if (agent !== 'codex' && agent !== 'claude') {
    return Effect.fail(
      ManagerOperationError.make({message: `${agent} does not expose a supported non-interactive consolidation mode.`}),
    );
  }
  return Effect.gen(function* () {
    const executable = yield* findExecutable([agent]);
    if (!executable) {
      return yield* ManagerOperationError.make({message: `${agent} executable was not found.`});
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stagingDir = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-consolidate-'});
        const promptPath = yield* pathJoin(stagingDir, 'prompt.txt');
        yield* fs.writeFileString(promptPath, prompt, {mode: 0o600});
        const script = consolidationAgentScript(agent, executable);
        const result = yield* runCommandEffect('sh', ['-lc', script, 'threadnote-consolidate', promptPath], {
          allowFailure: true,
          maxOutputBytes: 1024 * 1024,
          timeoutMs: 10 * 60 * 1000,
        });
        if (result.exitCode !== 0) {
          return yield* ManagerOperationError.make({
            message: result.stderr.trim() || result.stdout.trim() || `${agent} exited with ${result.exitCode}`,
          });
        }
        const draft = result.stdout.trim();
        if (!draft) {
          return yield* ManagerOperationError.make({message: `${agent} returned an empty consolidation draft.`});
        }
        return draft;
      }),
    );
  });
}

export function consolidationAgentScript(agent: AgentClient, executable: string): string {
  if (agent === 'codex') {
    return `${shellQuote(executable)} exec --sandbox read-only --skip-git-repo-check - < "$1"`;
  }
  if (agent === 'claude') {
    return `${shellQuote(executable)} --print --permission-mode default < "$1"`;
  }
  throw ManagerOperationError.make({
    message: `${agent} does not expose a supported non-interactive consolidation mode.`,
  });
}

function consolidationPrompt(sources: readonly {readonly content: string; readonly node: ManagerTreeNode}[]): string {
  return [
    'Consolidate these Threadnote memories into one concise memory.',
    'Return only the replacement memory body in Markdown. Do not include frontmatter.',
    'Preserve important facts, current status, decisions, blockers, and source threadnote:// URIs.',
    '',
    ...sources.flatMap(source => [`--- SOURCE ${source.node.uri} ---`, source.content.trim(), '']),
  ].join('\n');
}

const shareSummaries = Effect.fn('manager.shareSummaries')(function* (config: RuntimeConfig) {
  const teamsFile = yield* readTeamsFile(config);
  const git = yield* findExecutable(['git']);
  const entries = yield* Effect.forEach(
    Object.values(teamsFile.teams),
    Effect.fn('manager.callback')(function* (team) {
      if (!git) {
        return {...team, default: teamsFile.defaultTeam === team.name, warning: 'git not found'};
      }
      const status = yield* runCommand(git, ['-C', team.worktree, 'status', '--short', '--branch'], {
        allowFailure: true,
      });
      const ahead = yield* gitCount(git, team.worktree, '@{u}..HEAD');
      const behind = yield* gitCount(git, team.worktree, 'HEAD..@{u}');
      return {
        ...team,
        ahead,
        behind,
        default: teamsFile.defaultTeam === team.name,
        dirty: status.stdout.split('\n').some(line => line.trim().length > 0 && !line.startsWith('##')),
        status: status.stdout.trim(),
        warning: status.exitCode === 0 ? undefined : status.stderr.trim() || status.stdout.trim(),
      };
    }),
  );
  return entries.sort((left, right) => left.name.localeCompare(right.name));
});

const collectManagerDoctorChecks = Effect.fn('manager.collectManagerDoctorChecks')(function* (config: RuntimeConfig) {
  const threadnote = yield* findExecutable(['threadnote']);
  if (!threadnote) {
    return yield* collectDoctorChecks(config, {});
  }
  const result = yield* runCommand(
    threadnote,
    ['--home', config.agentContextHome, '--manifest', config.manifestPath, 'doctor'],
    {allowFailure: true, maxOutputBytes: 1024 * 1024},
  );
  const checks = parseDoctorChecksFromOutput([result.stdout, result.stderr].filter(Boolean).join('\n'));
  return checks.length > 0 ? checks : collectDoctorChecks(config, {});
});

export function parseDoctorChecksFromOutput(output: string): readonly DoctorCheck[] {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return output
    .split(/\r?\n/)
    .map(line => line.replace(ansiEscape, '').trim())
    .map(line => /^(OK|WARN|FAIL)\s+([^:]+):\s*(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({
      detail: match[3] ?? '',
      name: match[2] ?? '',
      status: doctorStatus(match[1] ?? ''),
    }));
}

const gitCount = Effect.fn('manager.gitCount')(function* (git: string, worktree: string, range: string) {
  const result = yield* runCommand(git, ['-C', worktree, 'rev-list', '--count', range], {allowFailure: true});
  if (result.exitCode !== 0) {
    return undefined;
  }
  return Number.parseInt(result.stdout.trim(), 10) || 0;
});

function doctorStatus(value: string): DoctorCheck['status'] {
  if (value === 'OK') {
    return 'ok';
  }
  if (value === 'FAIL') {
    return 'fail';
  }
  return 'warn';
}

const runCaptured = Effect.fn('manager.runCaptured')(function* (
  action: () => ManagerOperation<void>,
  _runEffect?: ManagerEffectPromise,
) {
  const captured = yield* captureConsoleWithoutProgress(action());
  return {output: captured.output};
});

const runManagerGraphAction = Effect.fn('manager.runGraphAction')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
  runEffect?: ManagerEffectPromise,
) {
  const action = yield* Effect.try({
    try: () => requireString(body.action, 'action'),
    catch: managerOperationError,
  });
  const dryRun = body.dryRun === true;
  if (!dryRun && ['compact', 'purge', 'purge-all', 'purge-obsolete', 'remove-view', 'repair'].includes(action)) {
    yield* Effect.try({
      try: () => requireConfirm(body),
      catch: managerOperationError,
    });
  }
  if (action === 'repair') {
    return yield* runCaptured(
      () =>
        runCodeGraphRepair(config, {
          all: true,
          deep: body.deep === true,
          dryRun,
        }),
      runEffect,
    );
  }
  if (action === 'purge-all') {
    return yield* runCaptured(() => runCodeGraphPurge(config, {all: true, dryRun}), runEffect);
  }
  if (action === 'index-project') return yield* graphProjects.runManagerManifestProjectGraphIndex(config, body);
  if (action === 'index-cwd') return yield* graphActions.runManagerExplicitCwdGraphIndex(config, body);
  const checkoutId = yield* Effect.try({
    try: () => requireGraphIdentity(body.checkoutId, 'checkoutId'),
    catch: managerOperationError,
  });
  if (action === 'purge') {
    return yield* runCaptured(
      () => runCodeGraphPurge(config, {checkoutId, dryRun, waitTimeoutMilliseconds: 0}),
      runEffect,
    );
  }
  if (action === 'purge-obsolete') {
    return yield* runCaptured(() => runCodeGraphPurge(config, {checkoutId, dryRun, obsolete: true}), runEffect);
  }
  const worktreeId = yield* Effect.try({
    try: () => requireGraphIdentity(body.worktreeId, 'worktreeId'),
    catch: managerOperationError,
  });
  if (action === 'remove-view') {
    const expectedSnapshotId = yield* Effect.try({
      try: () => requireGraphSnapshotIdentity(body.expectedSnapshotId),
      catch: managerOperationError,
    });
    const scopeId = yield* Effect.try({
      try: () => optionalGraphScopeIdentity(body.scopeId),
      catch: managerOperationError,
    });
    const target = {
      checkoutId,
      ...(scopeId === undefined ? {} : {scopeId}),
      snapshotId: expectedSnapshotId,
      worktreeId,
    };
    const approvalDigest = yield* managerGraphViewRemovalApprovalDigest(target);
    if (!dryRun && body.approvalDigest !== approvalDigest) {
      return yield* ManagerOperationError.make({
        message: 'Preview this exact graph view removal and provide its approval digest before applying.',
      });
    }
    const path = yield* Path.Path;
    const maintenance = yield* CodeGraphMaintenanceCoordinator;
    const layout = codeGraphLayout(path, config.agentContextHome, checkoutId, worktreeId);
    const actionEffect = removeCodeGraphView(config.agentContextHome, target, {
      afterRemoval: input =>
        maintenance
          .kickResidual({
            checkoutId: input.checkoutId,
            databasePath: input.databasePath,
            threadnoteHome: input.threadnoteHome,
            writerLockPath: layout.databaseWriteLockPath,
          })
          .pipe(Effect.asVoid),
      apply: !dryRun,
    }).pipe(
      Effect.mapError(error =>
        Schema.is(CodeGraphStoreBusyError)(error)
          ? ManagerGraphViewActionBusyError.make({
              message: 'The selected graph view is busy. Retry after the active graph operation completes.',
            })
          : ManagerGraphViewActionError.make({
              message:
                'The selected graph view could not be inspected or removed safely. Run threadnote doctor --dry-run and retry.',
            }),
      ),
    );
    const applied = dryRun
      ? {result: yield* actionEffect, warnings: [] as const}
      : yield* withManagerGraphSnapshotLeaseInvalidated(
          config.agentContextHome,
          checkoutId,
          worktreeId,
          expectedSnapshotId,
          actionEffect,
        );
    const warningOutput = applied.warnings.map(warning => `Warning [${warning.code}]: ${warning.message}`);
    return {
      approvalDigest,
      output: [renderCodeGraphViewRemovalResult(applied.result), ...warningOutput].filter(Boolean).join('\n'),
      result: applied.result,
      warnings: applied.warnings,
    };
  }
  const repositoryId = yield* Effect.try({
    try: () => requireGraphIdentity(body.repositoryId, 'repositoryId'),
    catch: managerOperationError,
  });
  const expectedIdentity = {checkoutId, repositoryId, worktreeId} satisfies RepositoryIdentityExpectation;
  const cwd = yield* resolveManagerGraphActionCwd(config.agentContextHome, expectedIdentity, optionalString(body.cwd));
  switch (action) {
    case 'compact':
      return yield* runCaptured(
        () =>
          compactCodeGraphStorageIsolated(config.agentContextHome, checkoutId, {
            force: body.force === true,
            operation: dryRun ? 'probe' : 'compact',
          }).pipe(
            Effect.flatMap(summary =>
              summary.action === 'compacted'
                ? Console.log(
                    `Compacted the selected graph in an isolated process and reclaimed ${summary.reclaimedBytes.toLocaleString()} bytes.`,
                  )
                : summary.action === 'would-compact'
                  ? Console.log(
                      `The selected graph is eligible for isolated compaction; estimated opportunity ${summary.reclaimedBytes.toLocaleString()} bytes.`,
                    )
                  : summary.action === 'deferred'
                    ? Console.log(
                        `Graph compaction was deferred because ${
                          summary.reason === 'active-build'
                            ? 'a graph build is active'
                            : 'another maintenance operation is active'
                        }.`,
                      )
                    : Console.log(`Graph compaction completed with result: ${summary.action}.`),
            ),
          ),
        runEffect,
      );
    case 'index':
      return yield* runCaptured(
        () =>
          runIsolatedCodeGraphIndexSnapshot({
            cwd,
            expectedIdentity,
            force: body.full === true,
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
        runEffect,
      );
    default:
      return yield* ManagerOperationError.make({message: `Unsupported graph Manager action: ${action}`});
  }
});

const resolveManagerGraphActionCwd = Effect.fn('manager.resolveGraphActionCwd')(function* (
  threadnoteHome: string,
  expectedIdentity: RepositoryIdentityExpectation,
  suppliedCwd?: string,
) {
  if (suppliedCwd) {
    const path = yield* Path.Path;
    if (!path.isAbsolute(suppliedCwd)) {
      return yield* ManagerOperationError.make({message: 'Supply cwd as an absolute local worktree path.'});
    }
    const {identity} = yield* resolveAndRecordCodeGraphLocalAssociation(threadnoteHome, suppliedCwd, {
      validateIdentity: identity =>
        repositoryIdentityMatchesExpectation(identity, expectedIdentity)
          ? Effect.void
          : Effect.fail(
              ManagerOperationError.make({
                message: 'The supplied worktree path does not match the selected graph identity.',
              }),
            ),
    });
    return identity.repoRoot;
  }
  const persisted = yield* readCodeGraphLocalAssociation(threadnoteHome, expectedIdentity);
  if (persisted.state === 'verified' && persisted.path !== undefined) {
    const observed = yield* resolveAndRecordCodeGraphLocalAssociation(threadnoteHome, persisted.path, {
      validateIdentity: identity =>
        repositoryIdentityMatchesExpectation(identity, expectedIdentity)
          ? Effect.void
          : Effect.fail(
              ManagerOperationError.make({
                message: 'The persisted worktree path no longer matches the selected graph identity.',
              }),
            ),
    }).pipe(Effect.option);
    if (Option.isSome(observed)) return observed.value.identity.repoRoot;
  }
  const statuses = yield* readAllCodeGraphBuildStatuses(threadnoteHome);
  for (const status of statuses) {
    if (
      !repositoryIdentityMatchesExpectation(status.identity, expectedIdentity) ||
      status.managerContext === undefined
    ) {
      continue;
    }
    const observed = yield* resolveAndRecordCodeGraphLocalAssociation(
      threadnoteHome,
      status.managerContext.worktreePath,
      {
        validateIdentity: identity =>
          repositoryIdentityMatchesExpectation(identity, expectedIdentity)
            ? Effect.void
            : Effect.fail(
                ManagerOperationError.make({
                  message: 'Manager graph context no longer matches the selected graph identity.',
                }),
              ),
      },
    ).pipe(Effect.option);
    if (Option.isSome(observed)) return observed.value.identity.repoRoot;
  }
  return yield* ManagerOperationError.make({
    message: 'The selected graph has no current local worktree target. Supply cwd and refresh graph diagnostics.',
  });
});

function requireGraphIdentity(value: unknown, name: string): string {
  const identity = requireString(value, name);
  if (!/^[0-9a-f]{64}$/.test(identity))
    throw ManagerOperationError.make({message: `Provide ${name} as a 64-character graph identity.`});
  return identity;
}

function requireGraphSnapshotIdentity(value: unknown): string {
  const identity = requireString(value, 'expectedSnapshotId');
  if (!/^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/.test(identity)) {
    throw ManagerOperationError.make({message: 'Provide expectedSnapshotId as an exact code graph snapshot identity.'});
  }
  return identity;
}

const memoryUriFor = Effect.fn('manager.memoryUriFor')(function* (
  config: RuntimeConfig,
  metadata: {
    readonly kind: MemoryKind;
    readonly project: string;
    readonly status: MemoryStatus;
    readonly topic: string;
  },
) {
  const project = uriSegment(metadata.project);
  const filename =
    metadata.status === 'active' && metadata.kind !== 'smoke'
      ? `${uriSegment(metadata.topic)}.md`
      : `threadnote-${safeTimestamp()}-${(yield* sha256(JSON.stringify(metadata))).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata.kind, metadata.status, project)}/${filename}`;
});

function sharedMemoryUriFor(
  config: RuntimeConfig,
  team: string,
  metadata: {
    readonly kind: MemoryKind;
    readonly project: string;
    readonly topic: string;
  },
): string {
  if (metadata.kind !== 'durable') {
    throw ManagerOperationError.make({message: 'Only durable memories can be moved into shared team memory.'});
  }
  return `threadnote://user/${uriSegment(config.user)}/memories/shared/${uriSegment(team)}/durable/projects/${uriSegment(metadata.project)}/${uriSegment(metadata.topic)}.md`;
}

function memoryDirectoryUri(
  config: RuntimeConfig,
  kind: MemoryKind,
  status: MemoryStatus,
  projectSegment: string,
): string {
  const base = `threadnote://user/${uriSegment(config.user)}/memories`;
  switch (kind) {
    case 'preference':
      return status === 'active' ? `${base}/preferences` : `${base}/preferences/${uriSegment(status)}`;
    case 'handoff':
      return `${base}/handoffs/${uriSegment(status)}/${projectSegment}`;
    case 'incident':
      return `${base}/incidents/${uriSegment(status)}/${projectSegment}`;
    case 'smoke':
      return `${base}/smoke/${uriSegment(status)}`;
    case 'durable':
      return status === 'active'
        ? `${base}/durable/projects/${projectSegment}`
        : `${base}/durable/${uriSegment(status)}/${projectSegment}`;
  }
}

const localMemoriesRoot = Effect.fn('manager.localMemoriesRoot')(function* (config: RuntimeConfig) {
  return yield* pathJoin(config.agentContextHome, 'data', config.account, 'user', uriSegment(config.user), 'memories');
});

const localResourcesRoot = Effect.fn('manager.localResourcesRoot')(function* (config: RuntimeConfig) {
  return yield* pathJoin(config.agentContextHome, 'data', config.account, 'resources');
});

const localPathForMemoryUri = Effect.fn('manager.localPathForMemoryUri')(function* (
  config: RuntimeConfig,
  uri: string,
) {
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories`;
  if (uri !== prefix && !uri.startsWith(`${prefix}/`)) {
    return undefined;
  }
  const relativePath = uri === prefix ? '' : uri.slice(prefix.length + 1);
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) {
    return undefined;
  }
  return yield* pathJoin(yield* localMemoriesRoot(config), ...segments);
});

const localPathToMemoryUri = Effect.fn('manager.localPathToMemoryUri')(function* (config: RuntimeConfig, path: string) {
  const relativePath = yield* pathRelative(yield* localMemoriesRoot(config), path);
  if (!relativePath || relativePath.startsWith('..') || relativePath.split(yield* pathSeparator).includes('..')) {
    throw ManagerOperationError.make({message: `Path is outside the memories tree: ${path}`});
  }
  return `threadnote://user/${uriSegment(config.user)}/memories/${relativePath.split(yield* pathSeparator).join('/')}`;
});

const ensurePersonalDirectoryChain = Effect.fn('manager.ensurePersonalDirectoryChain')(function* (
  config: RuntimeConfig,
  _ov: string,
  directoryUri: string,
) {
  const store = yield* ResourceStore;
  const prefix = 'threadnote://';
  const parts = directoryUri.startsWith(prefix) ? directoryUri.slice(prefix.length).split('/').filter(Boolean) : [];
  const startIndex = parts[0] === 'user' && parts.length > 2 ? 3 : 1;
  for (let index = startIndex; index <= parts.length; index += 1) {
    const uri = `${prefix}${parts.slice(0, index).join('/')}`;
    yield* store.makeDirectory({account: config.account, home: config.agentContextHome, user: config.user}, uri);
  }
});

function publicConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    account: config.account,
    agentContextHome: config.agentContextHome,
    agentId: config.agentId,
    manifestPath: config.manifestPath,
    user: config.user,
  };
}

function isAuthorized(context: ApiContext, request: ManagerRequest): boolean {
  return managerRequestIsAuthorized(request, context.token);
}

function isGraphApiPath(pathname: string): boolean {
  return pathname === '/api/graph' || pathname.startsWith('/api/graph/') || pathname.startsWith('/api/graphs');
}

const SYSTEM_MEMORY_NAMES = new Set(['.abstract.md', '.overview.md', '.git', '.gitignore']);

const readJsonBody = Effect.fn('manager.readJsonBody')(function* (request: ManagerRequest) {
  return yield* request.body;
});

function writeJson(response: ManagerResponseSink, statusCode: number, body: unknown): void {
  response.response = HttpServerResponse.jsonUnsafe(body, {
    status: statusCode,
    headers: {'cache-control': 'no-store'},
  });
}

function targetFromBody(body: Record<string, unknown>): TargetMemoryInput {
  return {
    kind: memoryKind(body.kind),
    project: optionalString(body.project),
    sourceAgentClient: optionalString(body.sourceAgentClient),
    status: memoryStatus(body.status),
    team: optionalString(body.team),
    topic: optionalString(body.topic),
  };
}
