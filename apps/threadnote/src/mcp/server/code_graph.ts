import {
  codeGraphAnalysisReadMetadata,
  codeGraphAnalysisReadStateResponse,
  codeGraphAnalysisTimeoutResult,
  type CodeGraphAnalysisReadMetadata,
} from './code_graph/analysis_read.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Clock, Effect, Option, Path, Schema} from 'effect';
import {EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {
  CodeGraphQueryService,
  renderCodeGraphResult,
  type CodeGraphQueryTelemetryObserver,
} from '@threadnote/graph/query';
import {
  codeGraphAnalyzeAnonymousTelemetryRequestKind,
  codeGraphInspectAnonymousTelemetryRequestKind,
  codeGraphQueryAnonymousTelemetrySnapshotSurface,
  makeCodeGraphQueryAnonymousTelemetryReporter,
} from '../../code_graph/query/anonymous_telemetry.js';
import {repositoryChangesSince} from '@threadnote/graph/repository';
import {
  inspectCodeGraphReadIsolated,
  IsolatedCodeGraphImpactQueryTimedOut,
} from '@threadnote/graph/isolated/impact_query';
import type {CodeGraphQueryTelemetryObservation} from '@threadnote/graph/query/contract';
import type {CodeGraphProgress, CodeGraphQueryResult} from '@threadnote/graph/types';
import type {CodeGraphWorksetQueryResult} from '@threadnote/graph/workset/query';
import {
  continueCodeGraphWorksetQueryV2,
  queryCodeGraphWorksetV2,
  resolveCodeGraphQualifiedRefTarget,
} from '@threadnote/graph/workset/query_v2';
import {
  findCodeGraphWorksetPath,
  inspectCodeGraphWorksetTopology,
  traceCodeGraphWorksetImpact,
  type CodeGraphWorksetTopologyResultV1,
} from '@threadnote/graph/cross_repository/runtime';
import type {CodeGraphCrossRepositoryTraversalResultV1} from '@threadnote/graph/cross_repository/traversal';
import {
  compileContextBrief,
  CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
  CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
} from '../../context_brief/index.js';
import {withIsolatedContextBriefGraphReads} from '@threadnote/context/graph/isolated_inspect';
import {
  CodeGraphWatcher,
  type CodeGraphProgressTiming,
  type CodeGraphRefreshFailure,
  type CodeGraphRefreshStatus,
  type CodeGraphRefreshContinuity,
  type CodeGraphWatcherShape,
} from '@threadnote/graph/watcher';
import {
  type CodeGraphAnalysisBudget,
  type CodeGraphAnalysisLimits,
  type CodeGraphAnalysisResult,
} from '@threadnote/graph/analysis';
import {
  codeGraphAnalysisLimitsForView,
  renderCodeGraphAnalysis,
  type CodeGraphAnalysisView,
} from '@threadnote/graph/analysis/render';
import {sanitizeCodeGraphPresentationText} from '@threadnote/graph/presentation_text';
import {
  codeGraphMcpResponse,
  compactCodeGraphMcpResult,
  formatCodeGraphMcpResponse,
  MCP_CODE_GRAPH_MINIMUM_ESTIMATED_TOKENS,
} from '../code_graph_projection.js';
import {
  analyzeCodeGraphReadIsolated,
  CodeGraphAnalysisReadTimedOut,
  type CodeGraphAnalysisReadResult,
} from '@threadnote/graph/isolated/analysis';
import {resolveCodeGraphScopeRoute} from '@threadnote/graph/scope/routing';
import {
  codeGraphInspectionAllowsStaleReady,
  codeGraphInspectionRequestsBackgroundRefresh,
  codeGraphInspectionStartsRefresh,
  codeGraphNoReadySnapshotResult,
  codeGraphQueryExecutionBudget,
  codeGraphRefreshBlocksCompletedInspection,
  completeCodeGraphReadyReadRefresh,
} from './code_graph/ready_read.js';
import {compactPersonalMemoryReferences} from './common.js';
import {argumentError, mcpErrorResult, requiredText, type RuntimeConfig} from './common.js';
import {
  anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure,
  attachAnonymousTelemetryDiagnostic,
  attachAnonymousTelemetryReportedOutcome,
} from '../../telemetry/diagnostic.js';
import {codeGraphMcpRequestDefaults} from './code_graph/request_defaults.js';
export {codeGraphMcpResponse, compactCodeGraphMcpResult};
export {codeGraphMcpRequestDefaults} from './code_graph/request_defaults.js';
export {
  codeGraphInspectionAllowsStaleReady,
  codeGraphInspectionObservation,
  codeGraphInspectionObservesWorktree,
  codeGraphInspectionRequestsBackgroundRefresh,
  codeGraphInspectionStartsRefresh,
  codeGraphRefreshBlocksReadyInspection,
  selectCodeGraphReadySnapshotForInspection,
} from './code_graph/ready_read.js';

const MCP_CODE_GRAPH_INITIAL_WAIT_MILLISECONDS = 5_000;
const MCP_CODE_GRAPH_POLL_MILLISECONDS = 100;
const MCP_CODE_GRAPH_RETRY_FALLBACK_MILLISECONDS = 5_000;
const MCP_CODE_GRAPH_RETRY_MINIMUM_MILLISECONDS = 3_000;
const MCP_CODE_GRAPH_RETRY_MAXIMUM_MILLISECONDS = 30_000;
const MCP_CODE_GRAPH_TOOL_TIMEOUT_MILLISECONDS = 25_000;
const MCP_CODE_GRAPH_QUERY_TIMEOUT_MILLISECONDS = 55_000;
const MCP_CODE_GRAPH_RESPONSE_RESERVE_MILLISECONDS = 1_000;
const MCP_CODE_GRAPH_TIMEOUT_STATUS_MILLISECONDS = 1_000;
const MCP_CODE_GRAPH_DEFAULT_NODE_LIMIT = 20;
const MCP_CODE_GRAPH_DEFAULT_EDGE_LIMIT = 40;
const MCP_CODE_GRAPH_MAXIMUM_NODE_LIMIT = 200;
const MCP_CODE_GRAPH_MAXIMUM_EDGE_LIMIT = 500;
const MCP_CODE_GRAPH_STRUCTURED_CONTENT_BYTES = 24 * 1_024;
const MCP_CODE_GRAPH_STRUCTURED_CONTENT_RESERVE_BYTES = 768;
const MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES = 24 * 1_024;
const MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_NODE_VISITS = 100_000;
const MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_EDGE_VISITS = 1_000_000;
const MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_DISTINCT_EDGES = 500_000;
const MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_COMMUNITY_MEMBERS = 5_000;
const MCP_CODE_GRAPH_PROJECT_SELECTOR_DESCRIPTION =
  'Configured graph project name/root (not a memory project tag); omit to infer from callerCwd; max 256 UTF-8 bytes';
export function registerContextBriefTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'context_brief',
    {
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
      description:
        'Graph+memory brief with semantic truncation. Accepts 8 graph paths/local cgs_; not cgr_; cold indexing is never started.',
      inputSchema: {
        budgetTokens: McpInput.integer('800-1500; default 1250', {
          minimum: CONTEXT_BRIEF_MINIMUM_ESTIMATED_TOKENS,
          maximum: CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS,
        }),
        callerCwd: McpInput.string('Absolute workspace when workset is omitted; max 4096 UTF-8 bytes'),
        codeRefs: McpInput.stringOrStrings('Canonical graph path/cgs_<32 hex>; no ./, ../, absolute, cgr_; max 8', {
          maximumItems: CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
        }),
        detail: McpInput.literals(['compact', 'source'], 'Default compact; source adds exact-current excerpts.'),
        mode: McpInput.literals(['brief', 'locate', 'explain', 'trace', 'impact', 'resume'], 'Default brief'),
        project: McpInput.string(MCP_CODE_GRAPH_PROJECT_SELECTOR_DESCRIPTION),
        responseFormat: McpInput.literals(['dual', 'agent'], 'Default agent; dual adds structured content.'),
        surface: McpInput.string('Agent catalog surface selector for compatible verified procedures'),
        task: McpInput.string('Task/question; 1-4096 UTF-8 bytes; no controls'),
        workset: McpInput.string('Prepared workset; max 256 UTF-8 bytes; else callerCwd'),
      },
    },
    ({budgetTokens, callerCwd, codeRefs, detail, mode, project, responseFormat, surface, task, workset}) => {
      const selectedResponseFormat = responseFormat ?? 'agent';
      const worksetName = workset?.trim();
      const checkedCwd = worksetName
        ? undefined
        : requiredText(callerCwd, 'context_brief', 'callerCwd', {
            callerCwd: '/workspace/project',
            task: 'trace the checkout contract and current blockers',
          });
      if (checkedCwd !== undefined && !checkedCwd.ok) return checkedCwd.error;
      const checkedTask = requiredText(task, 'context_brief', 'task', {
        ...(checkedCwd?.ok === true ? {callerCwd: checkedCwd.value} : {workset: worksetName!}),
        task: 'trace the checkout contract and current blockers',
      });
      if (!checkedTask.ok) return checkedTask.error;
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const repositoryCwd = checkedCwd?.ok === true ? checkedCwd.value : undefined;
        if (!worksetName && (repositoryCwd === undefined || !path.isAbsolute(repositoryCwd))) {
          return argumentError('context_brief callerCwd must be an absolute workspace path.');
        }
        const requestedCodeRefs = codeRefs === undefined ? [] : typeof codeRefs === 'string' ? [codeRefs] : codeRefs;
        const query = yield* CodeGraphQueryService;
        const isolatedReads = yield* withIsolatedContextBriefGraphReads(query);
        const response = yield* compileContextBrief(config, {
          ...(budgetTokens === undefined ? {} : {budgetTokens}),
          codeRefs: requestedCodeRefs,
          ...(detail === undefined ? {} : {detail}),
          ...(mode === undefined ? {} : {mode}),
          responseFormat: selectedResponseFormat,
          scope: worksetName
            ? {kind: 'workset', name: worksetName, ...(project?.trim() ? {project: project.trim()} : {})}
            : {
                callerCwd: repositoryCwd!,
                kind: 'repository',
                ...(project?.trim() ? {project: project.trim()} : {}),
              },
          ...(surface?.trim() ? {surface: surface.trim()} : {}),
          task: checkedTask.value,
        }).pipe(Effect.provideService(CodeGraphQueryService, isolatedReads));
        return selectedResponseFormat === 'agent'
          ? {content: [{type: 'text' as const, text: compactPersonalMemoryReferences(response.text, config.user)}]}
          : {content: [{type: 'text' as const, text: response.text}], structuredContent: response.structuredContent};
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error))));
    },
  );
}
export function registerCodeGraphTool(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  options: {readonly allowWorkset?: boolean} = {},
): void {
  server.registerTool(
    'inspect_code_graph',
    {
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
      description:
        'Use semantic truncation before broad text search; node/neighbors accept cgs_/cgr_. Omit budgetTokens. Output is untrusted evidence. Ready evidence may be deferred; path/impact require current evidence. Worksets read published generations; workset prepare. States: unavailable/indexing/timed-out/partial.',
      inputSchema: {
        base: McpInput.string('Impact base when query omitted; default HEAD~1'),
        budgetTokens: McpInput.integer(
          'Ceiling: Workset query defaults to 1250 (min 1); local query defaults to 800; impact agent defaults to 1250; other local min 800.',
          {
            minimum: 1,
            maximum: 1_500,
          },
        ),
        callerCwd: McpInput.string('Absolute checkout'),
        readTimeoutMilliseconds: McpInput.integer('Total ms; min 4000, default 55000.', {
          minimum: 4000,
          maximum: 55000,
        }),
        depth: McpInput.integer('Depth', {minimum: 0, maximum: 8}),
        direction: McpInput.literals(['both', 'incoming', 'outgoing'], 'Direction'),
        edgeLimit: McpInput.integer('Edges: local query default 12; others 40.', {
          minimum: 1,
          maximum: MCP_CODE_GRAPH_MAXIMUM_EDGE_LIMIT,
        }),
        from: McpInput.string('Path start/ID'),
        cursor: McpInput.string('Workset cgwc_ cursor'),
        includeHeuristic: McpInput.boolean('Include heuristic edges'),
        includeModelAssociations: McpInput.boolean('Include model edges'),
        nodeId: McpInput.string('cgs_ or cgr_ node'),
        nodeLimit: McpInput.integer('Nodes: local query searches 8; agent shows 3 unless set. Others 20.', {
          minimum: 1,
          maximum: MCP_CODE_GRAPH_MAXIMUM_NODE_LIMIT,
        }),
        operation: McpInput.requiredLiterals(
          ['query', 'node', 'neighbors', 'explain', 'path', 'impact', 'topology'],
          'Operation',
        ),
        package: McpInput.string('Exact query package'),
        project: McpInput.string(
          `${MCP_CODE_GRAPH_PROJECT_SELECTOR_DESCRIPTION}; preserve the project selected by context_brief`,
        ),
        query: McpInput.string('Query/path/impact target'),
        responseFormat: McpInput.literals(
          ['dual', 'text', 'agent'],
          'Default local agent; Workset text; dual structure.',
        ),
        symbol: McpInput.string('Explain symbol/query'),
        to: McpInput.string('Path target/ID'),
        workset: McpInput.string('Workset name'),
      },
    },
    ({
      base,
      budgetTokens,
      callerCwd,
      cursor,
      depth,
      direction,
      edgeLimit,
      from,
      includeHeuristic,
      includeModelAssociations,
      nodeId,
      nodeLimit,
      operation,
      package: packageName,
      project,
      query,
      responseFormat,
      readTimeoutMilliseconds,
      symbol,
      to,
      workset,
    }) => {
      const requestBudget = readTimeoutMilliseconds ?? MCP_CODE_GRAPH_QUERY_TIMEOUT_MILLISECONDS;
      const requestExecutionBudget = codeGraphQueryExecutionBudget(requestBudget);
      const selectedResponseFormat = responseFormat ?? (workset?.trim() ? 'text' : 'agent');
      let timeoutContext = Option.none<{
        readonly key: string;
        readonly target: {
          readonly cwd: string;
          readonly threadnoteHome: string;
          readonly project?: import('@threadnote/graph/watcher').CodeGraphWatchOptions['project'];
        };
        readonly watcher: CodeGraphWatcherShape;
      }>();
      let readyReadStarted = false;
      const checkedCwd = requiredText(callerCwd, 'inspect_code_graph', 'callerCwd', {
        callerCwd: '/workspace/project',
        operation: 'query',
        query: 'exclusive file lock',
      });
      if (!checkedCwd.ok) return checkedCwd.error;
      if (!operation) {
        return argumentError(
          'inspect_code_graph requires operation. Example: {"operation":"query","callerCwd":"/workspace/project","query":"exclusive file lock"}',
        );
      }
      const effectiveRequest = codeGraphMcpRequestDefaults(operation, {budgetTokens, edgeLimit, nodeLimit, workset});
      const queryTelemetry = makeCodeGraphQueryAnonymousTelemetryReporter({
        requestKind: codeGraphInspectAnonymousTelemetryRequestKind(operation),
        requestScope: workset?.trim() ? 'workset' : 'local',
      });
      const queryStageTelemetry = {
        skip: queryTelemetry.skip,
        stage: queryTelemetry.stage,
      } satisfies CodeGraphQueryTelemetryObserver;
      const timeoutResult = () =>
        Effect.gen(function* () {
          const status =
            !readyReadStarted && Option.isSome(timeoutContext)
              ? yield* queryTelemetry.status(codeGraphQueryTimeoutStatusFor(timeoutContext))
              : undefined;
          return yield* queryTelemetry.stage(
            'graph.query.execute',
            'query-serialization',
            Effect.sync(() => codeGraphQueryTimeoutResult(operation, status, readyReadStarted, requestBudget)),
          );
        });
      return Effect.gen(function* () {
        const requestDeadline = (yield* Clock.currentTimeMillis) + requestExecutionBudget;
        const path = yield* Path.Path;
        if (!path.isAbsolute(checkedCwd.value)) {
          return argumentError('inspect_code_graph callerCwd must be an absolute workspace path.');
        }
        if (base?.trim() && operation !== 'impact') {
          return argumentError('inspect_code_graph base is valid only for operation=impact.');
        }
        if (packageName?.trim() && operation !== 'query') {
          return argumentError('inspect_code_graph package is valid only for operation=query.');
        }
        if (options.allowWorkset === false && (workset?.trim() || cursor?.trim() || operation === 'topology')) {
          return argumentError(
            'inspect_code_graph workset operations are unavailable in the Cursor Cloud profile; inspect the local checkout with callerCwd.',
          );
        }
        if (workset?.trim() && !['query', 'path', 'impact', 'topology'].includes(operation)) {
          return argumentError('inspect_code_graph workset is valid for query, path, impact, and topology.');
        }
        if (workset?.trim() && responseFormat === 'agent') {
          return argumentError(
            'inspect_code_graph responseFormat=agent is currently available only for local repository inspections; use dual or text for a named Workset.',
          );
        }
        if (!workset?.trim() && budgetTokens !== undefined && budgetTokens < MCP_CODE_GRAPH_MINIMUM_ESTIMATED_TOKENS) {
          return argumentError(
            `Local inspect_code_graph budgetTokens must be an integer from ${MCP_CODE_GRAPH_MINIMUM_ESTIMATED_TOKENS} to 1500.`,
          );
        }
        yield* queryTelemetry.annotate;
        const requestedQuery = query?.trim();
        if (workset?.trim()) {
          const worksetName = workset.trim();
          const requestedCursor = cursor?.trim();
          if (operation === 'path') {
            if (requestedCursor || budgetTokens !== undefined) {
              return argumentError('cursor and budgetTokens are valid only for a named workset query.');
            }
            if (!from?.trim() || !to?.trim()) {
              return argumentError('A workset path requires from and to qualified endpoints.');
            }
            const response = yield* queryTelemetry.execute(
              findCodeGraphWorksetPath(config, {
                from: from.trim(),
                maxDepth: depth,
                maxEdges: edgeLimit ?? MCP_CODE_GRAPH_DEFAULT_EDGE_LIMIT,
                to: to.trim(),
                worksetName,
              }),
            );
            return yield* queryTelemetry.stage(
              'graph.query.execute',
              'query-serialization',
              Effect.sync(() =>
                formatCodeGraphMcpResponse(
                  {text: codeGraphWorksetTraversalText(response), structuredContent: response},
                  selectedResponseFormat,
                ),
              ),
            );
          }
          if (operation === 'impact') {
            if (requestedCursor || budgetTokens !== undefined || !requestedQuery) {
              return argumentError('A workset impact requires query with one qualified endpoint.');
            }
            const response = yield* queryTelemetry.execute(
              traceCodeGraphWorksetImpact(config, {
                maxDepth: depth,
                maxEdges: edgeLimit ?? MCP_CODE_GRAPH_DEFAULT_EDGE_LIMIT,
                query: requestedQuery,
                worksetName,
              }),
            );
            return yield* queryTelemetry.stage(
              'graph.query.execute',
              'query-serialization',
              Effect.sync(() =>
                formatCodeGraphMcpResponse(
                  {text: codeGraphWorksetTraversalText(response), structuredContent: response},
                  selectedResponseFormat,
                ),
              ),
            );
          }
          if (operation === 'topology') {
            if (requestedCursor || budgetTokens !== undefined) {
              return argumentError('cursor and budgetTokens are valid only for a named workset query.');
            }
            const response = yield* queryTelemetry.execute(
              inspectCodeGraphWorksetTopology(config, {
                maxEdges: edgeLimit ?? MCP_CODE_GRAPH_DEFAULT_EDGE_LIMIT,
                maxNodes: nodeLimit ?? MCP_CODE_GRAPH_DEFAULT_NODE_LIMIT,
                worksetName,
              }),
            );
            return yield* queryTelemetry.stage(
              'graph.query.execute',
              'query-serialization',
              Effect.sync(() =>
                formatCodeGraphMcpResponse(
                  {text: codeGraphWorksetTopologyText(response), structuredContent: response},
                  selectedResponseFormat,
                ),
              ),
            );
          }
          if (!requestedCursor && !requestedQuery) {
            return argumentError('A workset graph query requires query or cursor.');
          }
          const response = yield* queryTelemetry.execute(
            requestedCursor
              ? continueCodeGraphWorksetQueryV2(config, {
                  cursor: requestedCursor,
                  maximumEstimatedTokens: budgetTokens,
                  telemetry: queryStageTelemetry,
                })
              : queryCodeGraphWorksetV2(config, {
                  depth,
                  edgeLimit: edgeLimit ?? MCP_CODE_GRAPH_DEFAULT_EDGE_LIMIT,
                  includeHeuristic,
                  includeModelAssociations,
                  maximumEstimatedTokens: budgetTokens,
                  nodeLimit: nodeLimit ?? MCP_CODE_GRAPH_DEFAULT_NODE_LIMIT,
                  packageName: packageName?.trim() || undefined,
                  query: requestedQuery!,
                  telemetry: queryStageTelemetry,
                  worksetName,
                }),
          );
          return formatCodeGraphMcpResponse(response, selectedResponseFormat);
        }
        if (operation === 'topology') {
          const topologyScopeRoute = yield* queryTelemetry.stage(
            'graph.query.status',
            'query-repository-identity',
            resolveCodeGraphScopeRoute(config.manifestPath, checkedCwd.value, project),
          );
          if (topologyScopeRoute.state === 'selected') {
            const selectedProject = topologyScopeRoute.project.name;
            return argumentError(
              `inspect_code_graph topology for configured project "${selectedProject}" requires either analyze_code_graph with the same callerCwd/project or a prepared named workset. Run analyze_code_graph with callerCwd="${checkedCwd.value}" and project="${selectedProject}", or run threadnote workset prepare <name> before inspect_code_graph topology.`,
            );
          }
          return argumentError(
            'inspect_code_graph topology requires a named workset. Run threadnote workset prepare <name> first.',
          );
        }
        if (cursor?.trim()) {
          return argumentError('inspect_code_graph cursor requires a named workset query.');
        }
        const qualifiedTarget = nodeId?.startsWith('cgr_')
          ? yield* queryTelemetry.stage(
              'graph.query.status',
              'query-repository-identity',
              resolveCodeGraphQualifiedRefTarget(config, nodeId, checkedCwd.value, project),
            )
          : undefined;
        const inspectionCwd = qualifiedTarget?.cwd ?? checkedCwd.value;
        const scopeRoute =
          qualifiedTarget === undefined
            ? yield* queryTelemetry.stage(
                'graph.query.status',
                'query-repository-identity',
                resolveCodeGraphScopeRoute(config.manifestPath, inspectionCwd, project),
              )
            : undefined;
        const inspectionProject =
          qualifiedTarget?.project ?? (scopeRoute?.state === 'selected' ? scopeRoute.project.name : project);
        const inspectionNodeId = qualifiedTarget?.nodeId ?? nodeId;
        const allowStaleReadySnapshot = codeGraphInspectionAllowsStaleReady(operation);
        const changes =
          operation === 'impact' && !requestedQuery
            ? yield* queryTelemetry.stage(
                'graph.query.status',
                'query-worktree-observation',
                repositoryChangesSince(inspectionCwd, base?.trim() || 'HEAD~1'),
              )
            : undefined;
        const watcher = yield* CodeGraphWatcher;
        let refreshTarget: {
          cwd: string;
          threadnoteHome: string;
          project?: import('@threadnote/graph/watcher').CodeGraphWatchOptions['project'];
        };
        const readInput = {
          project: inspectionProject,
          manifestPath: config.manifestPath,
          cwd: inspectionCwd,
          depth,
          direction,
          edgeLimit: effectiveRequest.edgeLimit,
          from,
          includeHeuristic,
          includeModelAssociations,
          nodeId: inspectionNodeId,
          nodeLimit: effectiveRequest.nodeLimit,
          operation,
          packageName: packageName?.trim() || undefined,
          query: requestedQuery,
          symbol,
          to,
          ...(changes?.baseCommit === undefined ? {} : {baseCommit: changes.baseCommit}),
          ...(changes?.paths === undefined ? {} : {seedQueries: changes.paths, seedQueryCount: changes.paths.length}),
          discover: true as const,
          threadnoteHome: config.agentContextHome,
        };
        const readTimeout = {
          onTelemetryObservation: queryTelemetry.observedStage,
          timeoutMilliseconds: Math.max(1, requestDeadline - (yield* Clock.currentTimeMillis)),
        };
        const runRead = (readTimeout: {
          readonly onTelemetryObservation: (observation: CodeGraphQueryTelemetryObservation) => Effect.Effect<void>;
          readonly timeoutMilliseconds: number;
        }) =>
          queryTelemetry.execute(inspectCodeGraphReadIsolated(readInput, readTimeout), read =>
            'unavailable' in read ? {selection: 'none' as const} : read.status.surface,
          );
        let read = yield* runRead(readTimeout);
        const remainingReadTimeout = Effect.fn('mcpServer.codeGraphRemainingReadTimeout')(function* () {
          return {
            onTelemetryObservation: queryTelemetry.observedStage,
            timeoutMilliseconds: Math.max(1, requestDeadline - (yield* Clock.currentTimeMillis)),
          };
        });
        if ('unavailable' in read && allowStaleReadySnapshot) return codeGraphNoReadySnapshotResult(operation);
        if ('unavailable' in read) {
          refreshTarget = {
            cwd: read.identity.repoRoot,
            threadnoteHome: config.agentContextHome,
            ...(scopeRoute?.state === 'selected' ? {project: scopeRoute.project} : {}),
          };
          timeoutContext = Option.some({key: read.identity.worktreeId, target: refreshTarget, watcher});
          yield* watcher.ensure({...refreshTarget, key: read.identity.worktreeId});
          const refreshStarted = yield* watcher.refresh({...refreshTarget, key: read.identity.worktreeId});
          if (refreshStarted) {
            yield* waitForCodeGraphRefresh(watcher, read.identity.worktreeId, refreshTarget);
          }
          read = yield* queryTelemetry.execute(
            inspectCodeGraphReadIsolated(readInput, yield* remainingReadTimeout()),
            read => ('unavailable' in read ? {selection: 'none' as const} : read.status.surface),
          );
          if ('unavailable' in read) {
            const refreshStatus = Option.getOrUndefined(yield* watcher.status(read.identity.worktreeId, refreshTarget));
            return yield* queryTelemetry.stage(
              'graph.query.execute',
              'query-serialization',
              Effect.sync(() => codeGraphRefreshResult(operation, refreshStatus)),
            );
          }
        }
        readyReadStarted = true;
        const worktreeKey = read.status.worktreeId;
        refreshTarget = {
          cwd: read.status.repoRoot,
          threadnoteHome: config.agentContextHome,
          ...(scopeRoute?.state === 'selected' ? {project: scopeRoute.project} : {}),
        };
        timeoutContext = Option.some({key: worktreeKey, target: refreshTarget, watcher});
        const firstSummary = {
          readySnapshot: read.status.readySnapshotId === undefined ? undefined : {id: read.status.readySnapshotId},
          stale: read.status.stale,
        };
        // The worker proved the snapshot readable; only consult watcher state already cached by this runtime.
        const refreshStatus = Option.getOrUndefined(yield* watcher.cachedStatus(worktreeKey, refreshTarget));
        if (codeGraphRefreshBlocksCompletedInspection(firstSummary, refreshStatus, allowStaleReadySnapshot)) {
          return yield* queryTelemetry.stage(
            'graph.query.execute',
            'query-serialization',
            Effect.sync(() => codeGraphRefreshResult(operation, refreshStatus)),
          );
        }
        let refreshContinuity = read.status.refresh ?? refreshStatus?.refresh;
        const backgroundRefreshRequested = codeGraphInspectionRequestsBackgroundRefresh(firstSummary, operation);
        let presentedResult = read.result;
        if (!backgroundRefreshRequested && codeGraphInspectionStartsRefresh(firstSummary, operation)) {
          const refreshStarted = yield* watcher.refresh({...refreshTarget, key: worktreeKey});
          if (refreshStarted) {
            yield* waitForCodeGraphRefresh(watcher, worktreeKey, refreshTarget);
          }
          const secondRead = yield* queryTelemetry.execute(
            inspectCodeGraphReadIsolated(readInput, yield* remainingReadTimeout()),
            read => ('unavailable' in read ? {selection: 'none' as const} : read.status.surface),
          );
          const secondSummary =
            'unavailable' in secondRead
              ? {readySnapshot: undefined, stale: true}
              : {
                  readySnapshot:
                    secondRead.status.readySnapshotId === undefined
                      ? undefined
                      : {id: secondRead.status.readySnapshotId},
                  stale: secondRead.status.stale,
                };
          if ('unavailable' in secondRead || (secondSummary.stale && !allowStaleReadySnapshot)) {
            const retryStatus = Option.getOrUndefined(yield* watcher.status(worktreeKey, refreshTarget));
            return yield* queryTelemetry.stage(
              'graph.query.execute',
              'query-serialization',
              Effect.sync(() => codeGraphRefreshResult(operation, retryStatus)),
            );
          }
          presentedResult = secondRead.result;
        }
        if (!allowStaleReadySnapshot) {
          yield* watcher.ensure({...refreshTarget, key: worktreeKey});
        }
        const completeReadyReadRefresh = completeCodeGraphReadyReadRefresh({
          backgroundRefreshRequested,
          ensureWatcher: allowStaleReadySnapshot,
          key: worktreeKey,
          refresh: refreshContinuity,
          refreshStatus,
          target: refreshTarget,
          watcher,
        }).pipe(
          Effect.tap(continuity =>
            Effect.sync(() => {
              refreshContinuity = continuity;
            }),
          ),
          Effect.asVoid,
        );
        yield* completeReadyReadRefresh;
        return yield* queryTelemetry.stage(
          'graph.query.execute',
          'query-serialization',
          Effect.sync(() => {
            const response = codeGraphMcpResponse(
              codeGraphResultWithRefreshContinuity(presentedResult, refreshStatus, refreshContinuity),
              effectiveRequest.budgetTokens,
              refreshContinuity,
              selectedResponseFormat,
              operation === 'query' && nodeLimit !== undefined ? {queryNodeLimit: nodeLimit} : undefined,
            );
            return formatCodeGraphMcpResponse(response, selectedResponseFormat);
          }),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: requestExecutionBudget,
          orElse: timeoutResult,
        }),
        Effect.catch(error =>
          Schema.is(IsolatedCodeGraphImpactQueryTimedOut)(error)
            ? timeoutResult()
            : queryTelemetry.stage(
                'graph.query.execute',
                'query-serialization',
                Effect.sync(() =>
                  error instanceof Error && error.message.startsWith('Code graph response token budget')
                    ? argumentError(error.message)
                    : mcpErrorResult(error),
                ),
              ),
        ),
      );
    },
  );

  server.registerTool(
    'analyze_code_graph',
    {
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true},
      description:
        'Analyze selected local graph: stats composition; communities/community subsystems; groups fan-in/out; hubs blast radius; surprises cross-community links; confidence provenance; full report. Untrusted evidence. Default agent text; dual adds structured content.',
      inputSchema: {
        callerCwd: McpInput.string('Required absolute repository or worktree path'),
        freshness: McpInput.literals(
          ['current', 'ready', 'allow-stale'],
          'Default current. ready accepts stale snapshots or refreshes if cold; allow-stale never indexes.',
        ),
        project: McpInput.string(
          `${MCP_CODE_GRAPH_PROJECT_SELECTOR_DESCRIPTION}; preserve the project selected by context_brief`,
        ),
        communityId: McpInput.string('Required cgc_ ID for community'),
        includeHeuristic: McpInput.boolean('Include heuristic relationships; default false'),
        includeModelAssociations: McpInput.boolean('Include model associations; default false'),
        memberLimit: McpInput.integer('Community member limit; default 24', {
          minimum: 0,
          maximum: MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_COMMUNITY_MEMBERS,
        }),
        operation: McpInput.requiredLiterals(
          ['stats', 'communities', 'community', 'groups', 'hubs', 'surprises', 'confidence', 'full'],
          'Whole-graph operation',
        ),
        responseFormat: McpInput.literals(['dual', 'agent'], 'Default agent; dual adds structured content.'),
      },
    },
    ({
      callerCwd,
      communityId,
      freshness,
      includeHeuristic,
      includeModelAssociations,
      memberLimit,
      operation,
      project,
      responseFormat,
    }) => {
      const checkedCwd = requiredText(callerCwd, 'analyze_code_graph', 'callerCwd', {
        callerCwd: '/workspace/project',
        operation: 'stats',
      });
      if (!checkedCwd.ok) return checkedCwd.error;
      if (!operation) {
        return argumentError(
          'analyze_code_graph requires operation. Example: {"operation":"stats","callerCwd":"/workspace/project"}',
        );
      }
      const checkedCommunityId = communityId?.trim();
      if (operation === 'community' && !checkedCommunityId?.match(/^cgc_[a-f0-9]{32}$/)) {
        return argumentError('analyze_code_graph operation=community requires communityId from a communities result.');
      }
      const queryTelemetry = makeCodeGraphQueryAnonymousTelemetryReporter({
        requestKind: codeGraphAnalyzeAnonymousTelemetryRequestKind(operation),
        requestScope: 'local',
      });
      const freshnessPolicy = freshness ?? 'current';
      let lastRead: CodeGraphAnalysisReadResult | undefined;
      const metadata = () =>
        codeGraphAnalysisReadMetadata(
          freshnessPolicy,
          lastRead?.status,
          lastRead?.state !== 'failed' ? (lastRead?.project?.name ?? project) : project,
        );
      const format = (response: CallToolResult) =>
        codeGraphAnalysisReadStateResponse(response, metadata(), responseFormat);
      return Effect.gen(function* () {
        const deadline =
          (yield* Clock.currentTimeMillis) +
          MCP_CODE_GRAPH_TOOL_TIMEOUT_MILLISECONDS -
          MCP_CODE_GRAPH_RESPONSE_RESERVE_MILLISECONDS;
        const path = yield* Path.Path;
        if (!path.isAbsolute(checkedCwd.value))
          return argumentError('analyze_code_graph callerCwd must be an absolute workspace path.');
        yield* queryTelemetry.annotate;
        const read = () =>
          queryTelemetry
            .execute(
              analyzeCodeGraphReadIsolated(
                {
                  cwd: checkedCwd.value,
                  threadnoteHome: config.agentContextHome,
                  manifestPath: config.manifestPath,
                  project,
                  operation,
                  freshness: freshnessPolicy,
                  deadlineMilliseconds: deadline,
                  communityId: checkedCommunityId,
                  includeHeuristic,
                  includeModelAssociations,
                  memberLimit,
                  budget: codeGraphMcpAnalysisBudget(),
                  limits: codeGraphMcpAnalysisLimits(operation, memberLimit),
                },
                {onTelemetryObservation: queryTelemetry.observedStage},
              ),
              result =>
                result.state === 'failed'
                  ? {selection: 'none'}
                  : codeGraphQueryAnonymousTelemetrySnapshotSurface(result.status, 'active'),
            )
            .pipe(
              Effect.tap(result =>
                Effect.sync(() => {
                  lastRead = result;
                }),
              ),
            );
        let selected = yield* read();
        if (selected.state === 'failed') return format(codeGraphAnalysisFailureResult(operation, selected.failure));
        if (selected.state === 'unavailable' && freshnessPolicy === 'allow-stale') {
          const watcher = yield* CodeGraphWatcher;
          const known = Option.getOrUndefined(
            yield* watcher.status(selected.status.identity.worktreeId, {
              cwd: selected.status.identity.repoRoot,
              threadnoteHome: config.agentContextHome,
              ...(selected.project === undefined ? {} : {project: selected.project}),
            }),
          );
          if (known?.state === 'deferred')
            return format({
              ...codeGraphAnalysisFailureResult(operation, known.failure),
              structuredContent: {
                operation,
                state: 'unavailable',
                reason: selected.reason,
                failure: known.failure,
                type: 'code-graph-analysis-state',
                version: 1,
              },
            });
        }
        if (selected.state === 'unavailable' && freshnessPolicy !== 'allow-stale') {
          const watcher = yield* CodeGraphWatcher;
          const target = {
            cwd: selected.status.identity.repoRoot,
            key: selected.status.identity.worktreeId,
            threadnoteHome: config.agentContextHome,
            ...(selected.project === undefined ? {} : {project: selected.project}),
          };
          yield* watcher.ensure(target);
          const knownFailure = Option.getOrUndefined(yield* watcher.status(target.key, target));
          if (knownFailure?.state === 'deferred' && !knownFailure.failure.retryable) {
            return format(codeGraphAnalysisRefreshResult(operation, knownFailure));
          }
          const started = yield* watcher.refresh(target);
          if (started) yield* waitForCodeGraphRefresh(watcher, target.key, target);
          const refreshStatus = Option.getOrUndefined(yield* watcher.status(target.key, target));
          if (refreshStatus?.state === 'deferred')
            return format(codeGraphAnalysisRefreshResult(operation, refreshStatus));
          selected = yield* read();
          if (selected.state === 'failed') return format(codeGraphAnalysisFailureResult(operation, selected.failure));
          if (selected.state === 'unavailable') return format(codeGraphAnalysisRefreshResult(operation, refreshStatus));
        }
        if (selected.state !== 'ready') {
          return format({
            content: [
              {
                type: 'text',
                text:
                  selected.state === 'deferred'
                    ? 'Analysis is deferred because the snapshot lease writer gate is busy. Retry shortly.'
                    : 'No ready snapshot exists for the selected project. No analysis ran; allow-stale starts no indexing. Run graph index or retry with freshness ready/current.',
              },
            ],
            structuredContent: {
              operation,
              state: selected.state,
              reason: selected.reason,
              retryAfterMilliseconds: 1000,
              type: 'code-graph-analysis-state',
              version: 1,
            },
          });
        }
        const accepted = selected;
        return yield* queryTelemetry.stage(
          'graph.query.execute',
          'query-serialization',
          Effect.sync(() => {
            const response = codeGraphAnalysisMcpResponse(
              accepted.result,
              operation,
              {
                displayName: accepted.status.identity.displayName,
                repositoryId: accepted.status.identity.repositoryId,
              },
              metadata(),
            );
            return format({
              content: [{type: 'text' as const, text: response.text}],
              structuredContent: response.structuredContent,
            });
          }),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: MCP_CODE_GRAPH_TOOL_TIMEOUT_MILLISECONDS - MCP_CODE_GRAPH_RESPONSE_RESERVE_MILLISECONDS,
          orElse: () =>
            Effect.sync(() =>
              format(codeGraphAnalysisTimeoutResult(operation, MCP_CODE_GRAPH_TOOL_TIMEOUT_MILLISECONDS)),
            ),
        }),
        Effect.catch(error =>
          Effect.sync(() =>
            format(
              Schema.is(CodeGraphAnalysisReadTimedOut)(error)
                ? codeGraphAnalysisTimeoutResult(operation, MCP_CODE_GRAPH_TOOL_TIMEOUT_MILLISECONDS)
                : mcpErrorResult(error),
            ),
          ),
        ),
      );
    },
  );
}

export function codeGraphWorksetMcpResponse(result: CodeGraphWorksetQueryResult) {
  const totalNodes = result.repositories.reduce(
    (total, member) => total + (member.state === 'ready' ? member.graph.nodes.length : 0),
    0,
  );
  const totalEdges = result.repositories.reduce(
    (total, member) => total + (member.state === 'ready' ? member.graph.edges.length : 0),
    0,
  );
  const readyMembers = result.repositories.filter(
    (member): member is Extract<(typeof result.repositories)[number], {state: 'ready'}> => member.state === 'ready',
  );
  let nodeBudget = totalNodes;
  let edgeBudget = totalEdges;
  let structuredContent = projectCodeGraphWorksetMcpResult(result, nodeBudget, edgeBudget);
  const budget = MCP_CODE_GRAPH_STRUCTURED_CONTENT_BYTES - MCP_CODE_GRAPH_STRUCTURED_CONTENT_RESERVE_BYTES;
  while (encodedMcpBytes(structuredContent) > budget && (nodeBudget > 0 || edgeBudget > 0)) {
    if (edgeBudget > nodeBudget && edgeBudget > 0) edgeBudget -= 1;
    else if (nodeBudget > 0) nodeBudget -= 1;
    else edgeBudget -= 1;
    structuredContent = projectCodeGraphWorksetMcpResult(result, nodeBudget, edgeBudget);
  }
  const nodeCounts = fairPrefixCounts(
    readyMembers.map(member => member.graph.nodes.length),
    nodeBudget,
  );
  const edgeCounts = fairPrefixCounts(
    readyMembers.map(member => member.graph.edges.length),
    edgeBudget,
  );
  let readyIndex = 0;
  const rendered = [
    `Code graph workset: ${result.workset.name} (${result.coverage.readyRepositories}/${result.coverage.queriedRepositories} ready)`,
  ];
  for (const member of result.repositories) {
    rendered.push('', `Repository member: ${member.project}`);
    if (member.state === 'unavailable') {
      rendered.push(`Unavailable: ${member.reason}`);
      continue;
    }
    rendered.push(
      renderCodeGraphResult(
        {
          ...member.graph,
          edges: member.graph.edges.slice(0, edgeCounts[readyIndex]),
          nodes: member.graph.nodes.slice(0, nodeCounts[readyIndex]),
        },
        'mcp',
      ).trimEnd(),
    );
    readyIndex += 1;
  }
  if (result.warnings.length > 0) rendered.push('', ...result.warnings.map(warning => `Warning: ${warning}`));
  const text = compactMcpUtf8Text(`${rendered.join('\n')}\n`, MCP_CODE_GRAPH_STRUCTURED_CONTENT_BYTES);
  return {structuredContent, text};
}

function projectCodeGraphWorksetMcpResult(result: CodeGraphWorksetQueryResult, nodeBudget: number, edgeBudget: number) {
  const readyMembers = result.repositories.filter(
    (member): member is Extract<(typeof result.repositories)[number], {state: 'ready'}> => member.state === 'ready',
  );
  const nodeCounts = fairPrefixCounts(
    readyMembers.map(member => member.graph.nodes.length),
    nodeBudget,
  );
  const edgeCounts = fairPrefixCounts(
    readyMembers.map(member => member.graph.edges.length),
    edgeBudget,
  );
  let readyIndex = 0;
  const repositories = result.repositories.map(member => {
    if (member.state === 'unavailable') return member;
    const graph = compactCodeGraphMcpResult({
      ...member.graph,
      edges: member.graph.edges.slice(0, edgeCounts[readyIndex]),
      nodes: member.graph.nodes.slice(0, nodeCounts[readyIndex]),
    });
    readyIndex += 1;
    return {graph, project: member.project, state: member.state};
  });
  const totalNodes = readyMembers.reduce((total, member) => total + member.graph.nodes.length, 0);
  const totalEdges = readyMembers.reduce((total, member) => total + member.graph.edges.length, 0);
  const returnedNodes = Math.min(totalNodes, nodeBudget);
  const returnedEdges = Math.min(totalEdges, edgeBudget);
  const truncated = returnedNodes < totalNodes || returnedEdges < totalEdges;
  return {
    coverage: result.coverage,
    output: {returnedEdges, returnedNodes, totalEdges, totalNodes, truncated},
    repositories,
    trust: result.trust,
    type: result.type,
    version: result.version,
    warnings: truncated
      ? [
          ...result.warnings.slice(0, 4),
          `MCP output was bounded to ${returnedNodes}/${totalNodes} nodes and ${returnedEdges}/${totalEdges} relationships across the workset.`,
        ]
      : result.warnings.slice(0, 5),
    workset: result.workset,
  };
}

function fairPrefixCounts(lengths: readonly number[], budget: number): readonly number[] {
  const counts = lengths.map(() => 0);
  let remaining = Math.max(0, Math.floor(budget));
  for (;;) {
    let advanced = false;
    for (let index = 0; index < lengths.length && remaining > 0; index += 1) {
      if (counts[index] >= lengths[index]) continue;
      counts[index] = counts[index] + 1;
      remaining -= 1;
      advanced = true;
    }
    if (!advanced || remaining === 0) return counts;
  }
}

interface CodeGraphMcpOutputCoverage {
  readonly budgetBytes: number;
  readonly byteLength: number;
  readonly complete: boolean;
  readonly truncated: boolean;
}
type CodeGraphMcpAnalysisTextCoverage = CodeGraphMcpOutputCoverage;

interface CodeGraphMcpAnalysisStringObservation {
  truncated: number;
}

type MutableArray<Value> = Value extends readonly (infer Item)[] ? Item[] : never;

/**
 * Build the independently bounded MCP projection of a complete or partial
 * analysis result. The source result remains unchanged for CLI and Manager.
 */
function codeGraphAnalysisFailureResult(
  operation: CodeGraphAnalysisView,
  failure: CodeGraphRefreshFailure,
): CallToolResult {
  return codeGraphRefreshFailureResult(
    {
      content: [
        {
          type: 'text',
          text: `Code graph analysis is unavailable (${failure.code}). ${codeGraphRefreshRecoveryWarning(failure)}`,
        },
      ],
      structuredContent: {
        operation,
        state: 'failed',
        reason: 'read-failed',
        failure,
        type: 'code-graph-analysis-state',
        version: 1,
      },
    },
    failure,
  );
}

export function codeGraphAnalysisMcpResponse(
  result: CodeGraphAnalysisResult,
  operation: CodeGraphAnalysisView,
  repository: {readonly displayName: string; readonly repositoryId: string},
  metadata?: CodeGraphAnalysisReadMetadata,
) {
  const relevantSource = codeGraphMcpAnalysisSourceForView(result, operation);
  const observation: CodeGraphMcpAnalysisStringObservation = {truncated: 0};
  const compactSource = compactCodeGraphAnalysisStrings(relevantSource, observation) as CodeGraphAnalysisResult;
  const compactRepository = compactCodeGraphAnalysisStrings(repository, observation) as typeof repository;
  const projected = emptyCodeGraphMcpAnalysisProjection(compactSource);
  const placeholderTextCoverage: CodeGraphMcpAnalysisTextCoverage = {
    budgetBytes: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
    byteLength: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
    complete: false,
    truncated: false,
  };
  const fits = () =>
    finalizedCodeGraphMcpAnalysisEnvelope(
      compactSource,
      projected,
      operation,
      compactRepository,
      observation.truncated,
      placeholderTextCoverage,
      metadata,
    ).output.structuredContent.byteLength <= MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES;
  const appendPrefix = <Value>(target: Value[], source: readonly Value[], synchronize?: () => void): void => {
    for (const value of source) {
      target.push(value);
      synchronize?.();
      if (fits()) continue;
      target.pop();
      synchronize?.();
      break;
    }
  };

  // Coverage warnings are retained before repository-derived evidence so a
  // bounded response never hides why an analysis is partial or unavailable.
  appendPrefix(mutableAnalysisArray(projected.warnings), compactSource.warnings);

  const appendStatistics = () => {
    appendPrefix(mutableAnalysisArray(projected.statistics.languages), compactSource.statistics.languages);
    appendPrefix(mutableAnalysisArray(projected.statistics.kinds), compactSource.statistics.kinds);
    appendPrefix(mutableAnalysisArray(projected.statistics.relations), compactSource.statistics.relations);
    appendPrefix(mutableAnalysisArray(projected.statistics.provenances), compactSource.statistics.provenances);
  };
  const appendConfidence = () => {
    appendPrefix(
      mutableAnalysisArray(projected.confidenceAudit.provenances),
      compactSource.confidenceAudit.provenances,
    );
    appendPrefix(mutableAnalysisArray(projected.confidenceAudit.findings), compactSource.confidenceAudit.findings);
  };
  const appendCommunities = () => {
    appendPrefix(mutableAnalysisArray(projected.communities), compactSource.communities);
    appendPrefix(mutableAnalysisArray(projected.components), compactSource.components);
  };
  const appendCommunityMembers = () => {
    const sourceDrillDown = compactSource.communityDrillDown;
    const projectedDrillDown = projected.communityDrillDown;
    if (sourceDrillDown?.state !== 'found' || projectedDrillDown?.state !== 'found') {
      return;
    }
    const members = mutableAnalysisArray(projectedDrillDown.members);
    const synchronize = () => {
      const mutableCoverage = projectedDrillDown.coverage as {complete: boolean; shownMemberCount: number};
      mutableCoverage.shownMemberCount = members.length;
      mutableCoverage.complete = sourceDrillDown.coverage.complete && members.length === sourceDrillDown.members.length;
    };
    appendPrefix(members, sourceDrillDown.members, synchronize);
  };
  const appendGroups = () => {
    const groups = mutableAnalysisArray(projected.relationshipGroups);
    const sourceGroups = compactSource.relationshipGroups.map(group => ({
      ...group,
      members: [] as MutableArray<typeof group.members>,
      memberSampleComplete: group.memberSampleComplete && group.members.length === 0,
    }));
    appendPrefix(groups, sourceGroups);
    for (const group of groups) {
      const source = compactSource.relationshipGroups.find(candidate => candidate.id === group.id);
      if (!source) continue;
      const members = mutableAnalysisArray(group.members);
      const synchronize = () => {
        (group as {memberSampleComplete: boolean}).memberSampleComplete =
          source.memberSampleComplete && members.length === source.members.length;
      };
      appendPrefix(members, source.members, synchronize);
    }
  };

  switch (operation) {
    case 'stats':
      appendStatistics();
      break;
    case 'confidence':
      appendConfidence();
      break;
    case 'communities':
      appendCommunities();
      break;
    case 'community':
      appendCommunityMembers();
      break;
    case 'groups':
      appendGroups();
      break;
    case 'hubs':
      appendPrefix(mutableAnalysisArray(projected.hubs), compactSource.hubs);
      break;
    case 'surprises':
      appendPrefix(mutableAnalysisArray(projected.surprisingLinks), compactSource.surprisingLinks);
      break;
    case 'full':
      appendStatistics();
      appendConfidence();
      appendCommunities();
      appendCommunityMembers();
      appendPrefix(mutableAnalysisArray(projected.hubs), compactSource.hubs);
      appendGroups();
      appendPrefix(mutableAnalysisArray(projected.surprisingLinks), compactSource.surprisingLinks);
      break;
  }
  if (operation === 'communities' || operation === 'full') {
    appendPrefix(mutableAnalysisArray(projected.memberships), compactSource.memberships);
  }
  appendPrefix(mutableAnalysisArray(projected.suggestedQuestions), compactSource.suggestedQuestions);

  const projectionOmissions = codeGraphMcpAnalysisOmissions(compactSource, projected, operation);
  const projectionComplete = observation.truncated === 0 && Object.keys(projectionOmissions).length === 0;
  const rendered = renderCodeGraphAnalysis(projected, operation, 'mcp');
  const boundedText = boundedCodeGraphMcpAnalysisText(rendered, result.coverage.topology.state, projectionComplete);
  const structuredContent = finalizedCodeGraphMcpAnalysisEnvelope(
    compactSource,
    projected,
    operation,
    compactRepository,
    observation.truncated,
    boundedText.coverage,
    metadata,
  );

  return {structuredContent, text: boundedText.text};
}

/**
 * Remove evidence that does not belong to the requested view before string
 * compaction and byte accounting. The stable analysis result shape is retained,
 * but unrelated arrays cannot consume an MCP response budget or make that view
 * appear truncated.
 */
function codeGraphMcpAnalysisSourceForView(
  result: CodeGraphAnalysisResult,
  operation: CodeGraphAnalysisView,
): CodeGraphAnalysisResult {
  const includeStatistics = operation === 'stats' || operation === 'full';
  const includeConfidence = operation === 'confidence' || operation === 'full';
  const includeCommunities = operation === 'communities' || operation === 'full';
  const includeCommunity = operation === 'community' || operation === 'full';
  const {communityDrillDown: _communityDrillDown, ...base} = result;
  return {
    ...base,
    communities: includeCommunities ? result.communities : [],
    ...(includeCommunity && result.communityDrillDown !== undefined
      ? {communityDrillDown: result.communityDrillDown}
      : {}),
    components: includeCommunities ? result.components : [],
    confidenceAudit: {
      ...result.confidenceAudit,
      bands: includeStatistics || includeConfidence ? result.confidenceAudit.bands : [],
      findings: includeConfidence ? result.confidenceAudit.findings : [],
      provenances: includeConfidence ? result.confidenceAudit.provenances : [],
      reviewThresholds: includeConfidence ? result.confidenceAudit.reviewThresholds : [],
    },
    hubs: operation === 'hubs' || operation === 'full' ? result.hubs : [],
    memberships: includeCommunities ? result.memberships : [],
    relationshipGroups: operation === 'groups' || operation === 'full' ? result.relationshipGroups : [],
    statistics: {
      ...result.statistics,
      kinds: includeStatistics ? result.statistics.kinds : [],
      languages: includeStatistics ? result.statistics.languages : [],
      provenances: includeStatistics ? result.statistics.provenances : [],
      relations: includeStatistics ? result.statistics.relations : [],
    },
    surprisingLinks: operation === 'surprises' || operation === 'full' ? result.surprisingLinks : [],
  };
}

function emptyCodeGraphMcpAnalysisProjection(result: CodeGraphAnalysisResult): CodeGraphAnalysisResult {
  const communityDrillDown =
    result.communityDrillDown?.state === 'found'
      ? {
          ...result.communityDrillDown,
          coverage: {...result.communityDrillDown.coverage, complete: false, shownMemberCount: 0},
          members: [],
        }
      : result.communityDrillDown;
  return {
    ...result,
    communities: [],
    ...(communityDrillDown === undefined ? {} : {communityDrillDown}),
    components: [],
    confidenceAudit: {...result.confidenceAudit, findings: [], provenances: []},
    hubs: [],
    memberships: [],
    relationshipGroups: [],
    statistics: {...result.statistics, kinds: [], languages: [], provenances: [], relations: []},
    suggestedQuestions: [],
    surprisingLinks: [],
    warnings: [],
  };
}

function mutableAnalysisArray<Value>(value: readonly Value[]): Value[] {
  return value as Value[];
}

function compactCodeGraphAnalysisStrings(value: unknown, observation: CodeGraphMcpAnalysisStringObservation): unknown {
  if (typeof value === 'string') {
    const sanitized = sanitizeCodeGraphPresentationText(value);
    const compact = compactMcpUtf8Text(sanitized, 512);
    if (compact !== sanitized) observation.truncated += 1;
    return compact;
  }
  if (Array.isArray(value)) return value.map(item => compactCodeGraphAnalysisStrings(item, observation));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, compactCodeGraphAnalysisStrings(item, observation)]),
  );
}

function codeGraphMcpAnalysisOmissions(
  source: CodeGraphAnalysisResult,
  projected: CodeGraphAnalysisResult,
  operation: CodeGraphAnalysisView,
) {
  const sourceCommunityMembers =
    source.communityDrillDown?.state === 'found' ? source.communityDrillDown.members.length : 0;
  const projectedCommunityMembers =
    projected.communityDrillDown?.state === 'found' ? projected.communityDrillDown.members.length : 0;
  const sourceGroupMembers = source.relationshipGroups.reduce((total, group) => total + group.members.length, 0);
  const projectedGroupMembers = projected.relationshipGroups.reduce((total, group) => total + group.members.length, 0);
  const includeStatistics = operation === 'stats' || operation === 'full';
  const includeConfidence = operation === 'confidence' || operation === 'full';
  const includeCommunities = operation === 'communities' || operation === 'full';
  const includeCommunity = operation === 'community' || operation === 'full';
  const includeGroups = operation === 'groups' || operation === 'full';
  const counts = {
    communities: includeCommunities ? source.communities.length - projected.communities.length : 0,
    communityMembers: includeCommunity ? sourceCommunityMembers - projectedCommunityMembers : 0,
    components: includeCommunities ? source.components.length - projected.components.length : 0,
    confidenceFindings: includeConfidence
      ? source.confidenceAudit.findings.length - projected.confidenceAudit.findings.length
      : 0,
    confidenceProvenances: includeConfidence
      ? source.confidenceAudit.provenances.length - projected.confidenceAudit.provenances.length
      : 0,
    hubs: operation === 'hubs' || operation === 'full' ? source.hubs.length - projected.hubs.length : 0,
    memberships: includeCommunities ? source.memberships.length - projected.memberships.length : 0,
    relationshipGroupMembers: includeGroups ? sourceGroupMembers - projectedGroupMembers : 0,
    relationshipGroups: includeGroups ? source.relationshipGroups.length - projected.relationshipGroups.length : 0,
    statisticsKinds: includeStatistics ? source.statistics.kinds.length - projected.statistics.kinds.length : 0,
    statisticsLanguages: includeStatistics
      ? source.statistics.languages.length - projected.statistics.languages.length
      : 0,
    statisticsProvenances: includeStatistics
      ? source.statistics.provenances.length - projected.statistics.provenances.length
      : 0,
    statisticsRelations: includeStatistics
      ? source.statistics.relations.length - projected.statistics.relations.length
      : 0,
    suggestedQuestions: source.suggestedQuestions.length - projected.suggestedQuestions.length,
    surprisingLinks:
      operation === 'surprises' || operation === 'full'
        ? source.surprisingLinks.length - projected.surprisingLinks.length
        : 0,
    warnings: source.warnings.length - projected.warnings.length,
  };
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
}

function finalizedCodeGraphMcpAnalysisEnvelope(
  source: CodeGraphAnalysisResult,
  projected: CodeGraphAnalysisResult,
  operation: CodeGraphAnalysisView,
  repository: {readonly displayName: string; readonly repositoryId: string},
  truncatedStrings: number,
  textCoverage: CodeGraphMcpAnalysisTextCoverage,
  metadata?: CodeGraphAnalysisReadMetadata,
) {
  const omitted = codeGraphMcpAnalysisOmissions(source, projected, operation);
  const truncated = truncatedStrings > 0 || Object.keys(omitted).length > 0;
  const build = (byteLength: number) => ({
    ...metadata,
    state: source.coverage.complete ? 'complete' : 'partial',
    operation,
    output: {
      analysisCoverage: {
        complete: source.coverage.complete,
        topology: source.coverage.topology.state,
      },
      structuredContent: {
        budgetBytes: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
        byteLength,
        complete: !truncated,
        omitted,
        truncated,
        truncatedStrings,
      },
      text: textCoverage,
    },
    repository,
    result: projected,
    sourceVersion: source.version,
    type: 'code-graph-analysis' as const,
    version: 1 as const,
  });
  let byteLength = 0;
  let envelope = build(byteLength);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const measured = encodedMcpBytes(envelope);
    if (measured === byteLength) return envelope;
    byteLength = measured;
    envelope = build(byteLength);
  }
  return envelope;
}

function boundedCodeGraphMcpAnalysisText(
  rendered: string,
  topology: CodeGraphAnalysisResult['coverage']['topology']['state'],
  projectionComplete: boolean,
): {readonly coverage: CodeGraphMcpAnalysisTextCoverage; readonly text: string} {
  const completeFooter =
    `\nMCP text output coverage: complete within the ${MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES}-byte UTF-8 budget; ` +
    `structured projection ${projectionComplete ? 'complete' : 'bounded'}; topology ${topology}.\n`;
  const completeText = `${rendered.trimEnd()}${completeFooter}`;
  if (encodedMcpBytes(completeText) <= MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES) {
    return {
      coverage: {
        budgetBytes: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
        byteLength: encodedMcpBytes(completeText),
        complete: true,
        truncated: false,
      },
      text: completeText,
    };
  }
  const truncatedFooter =
    `\n…\nMCP text output coverage: truncated at the ${MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES}-byte UTF-8 budget; ` +
    `structured projection ${projectionComplete ? 'complete' : 'bounded'}; topology ${topology}.\n`;
  const prefixBudget = MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES - encodedMcpBytes(truncatedFooter);
  const text = `${utf8Prefix(rendered, prefixBudget).trimEnd()}${truncatedFooter}`;
  return {
    coverage: {
      budgetBytes: MCP_CODE_GRAPH_ANALYSIS_RESPONSE_BYTES,
      byteLength: encodedMcpBytes(text),
      complete: false,
      truncated: true,
    },
    text,
  };
}

function compactMcpUtf8Text(value: string, maximumBytes: number): string {
  if (utf8Prefix(value, maximumBytes).length === value.length) return value;
  const ellipsis = '…';
  return `${utf8Prefix(value, Math.max(0, maximumBytes - encodedMcpBytes(ellipsis)))}${ellipsis}`;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let prefix = '';
  for (const character of value) {
    const characterBytes = encodedMcpBytes(character);
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    prefix += character;
  }
  return prefix;
}

function encodedMcpBytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
}

export function compactCodeGraphMcpProgress(progress: CodeGraphProgress | undefined) {
  if (progress === undefined) return undefined;
  const envelope = {type: 'code-graph-progress' as const, version: 1 as const};
  switch (progress.phase) {
    case 'registering':
      return {...envelope, phase: progress.phase};
    case 'waiting':
      return {
        ...envelope,
        phase: progress.phase,
        ...(progress.reason === undefined ? {} : {reason: progress.reason}),
        ...(progress.admission === undefined
          ? {}
          : {
              admission: {
                admissionClass: progress.admission.admissionClass,
                enqueuedAt: progress.admission.enqueuedAt,
                position: progress.admission.position,
                size: progress.admission.size,
              },
            }),
      };
    case 'scanning':
      return {
        ...envelope,
        accepted: progress.accepted,
        ...(progress.activity === undefined
          ? {}
          : {
              activity: {
                batchCompleted: progress.activity.batchCompleted,
                batchTotal: progress.activity.batchTotal,
                language: compactMcpText(progress.activity.language, 80),
                stage: progress.activity.stage,
              },
            }),
        completed: progress.completed,
        excluded: progress.excluded,
        phase: progress.phase,
        skipped: progress.skipped,
        total: progress.total,
        unit: progress.unit,
      };
    case 'materializing':
      return {
        ...envelope,
        ...(progress.activity === undefined
          ? {}
          : {
              activity: {
                batchCompleted: progress.activity.batchCompleted,
                batchTotal: progress.activity.batchTotal,
                stage: progress.activity.stage,
              },
            }),
        completed: progress.completed,
        phase: progress.phase,
        reused: progress.reused,
        total: progress.total,
        unit: progress.unit,
      };
    case 'reclaiming':
      return {
        ...envelope,
        completed: progress.completed,
        pagesCompleted: progress.pagesCompleted,
        phase: progress.phase,
        rowsDeleted: progress.rowsDeleted,
        total: progress.total,
        unit: progress.unit,
      };
    case 'resolving':
      return progress.subphase === 'complete'
        ? {
            ...envelope,
            edges: progress.edges,
            phase: progress.phase,
            resolved: progress.resolved,
            subphase: progress.subphase,
            symbols: progress.symbols,
          }
        : {
            ...envelope,
            ...(progress.activity === undefined
              ? {}
              : {
                  activity: {
                    pageCompleted: progress.activity.pageCompleted,
                    pageTotal: progress.activity.pageTotal,
                    pass: progress.activity.pass,
                    referencesCompleted: progress.activity.referencesCompleted,
                    referencesTotal: progress.activity.referencesTotal,
                    resolved: progress.activity.resolved,
                  },
                }),
            phase: progress.phase,
            subphase: progress.subphase,
          };
    case 'activating':
      return {
        ...envelope,
        ...(progress.activity === undefined
          ? {}
          : {
              activity: {
                ...(progress.activity.rows === undefined ? {} : {rows: progress.activity.rows}),
                stage: progress.activity.stage,
                state: progress.activity.state,
              },
            }),
        phase: progress.phase,
        ...(progress.subphase === undefined ? {} : {subphase: progress.subphase}),
      };
    case 'embedding':
      return {
        ...envelope,
        completed: progress.completed,
        embedded: progress.embedded,
        phase: progress.phase,
        reused: progress.reused,
        total: progress.total,
        unit: progress.unit,
      };
    case 'sharing':
      return {
        ...envelope,
        phase: progress.phase,
        subphase: progress.subphase,
      };
  }
}

export function compactCodeGraphMcpTiming(timing: CodeGraphProgressTiming | undefined) {
  if (timing === undefined) return undefined;
  return {
    ...(timing.estimateConfidence === undefined ? {} : {estimateConfidence: timing.estimateConfidence}),
    ...(timing.estimateScope === undefined ? {} : {estimateScope: timing.estimateScope}),
    ...(timing.estimatedPhaseRemainingMilliseconds === undefined
      ? {}
      : {estimatedPhaseRemainingMilliseconds: Math.ceil(timing.estimatedPhaseRemainingMilliseconds)}),
    lastProgressAgeMilliseconds: Math.max(0, Math.ceil(timing.lastProgressAgeMilliseconds)),
    phaseElapsedMilliseconds: Math.max(0, Math.ceil(timing.phaseElapsedMilliseconds)),
    type: 'code-graph-progress-timing' as const,
    version: 1 as const,
  };
}

export function codeGraphMcpAnalysisLimits(
  view: CodeGraphAnalysisView,
  communityMembers: number | undefined,
): CodeGraphAnalysisLimits {
  const limits = codeGraphAnalysisLimitsForView(
    view,
    Math.min(MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_COMMUNITY_MEMBERS, communityMembers ?? 24),
  );
  return {
    ...limits,
    communities: Math.min(limits.communities ?? 0, 12),
    communityMembers: Math.min(limits.communityMembers ?? 0, MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_COMMUNITY_MEMBERS),
    components: Math.min(limits.components ?? 0, 12),
    confidenceFindings: Math.min(limits.confidenceFindings ?? 0, 12),
    hubs: Math.min(limits.hubs ?? 0, 12),
    relationshipGroupMembers: Math.min(limits.relationshipGroupMembers ?? 0, 8),
    relationshipGroups: Math.min(limits.relationshipGroups ?? 0, 12),
    surprisingLinks: Math.min(limits.surprisingLinks ?? 0, 12),
  };
}

/**
 * MCP analysis is admitted for every repository, but topology retention is
 * bounded independently from the complete CLI and Manager analysis surfaces.
 */
export function codeGraphMcpAnalysisBudget(): CodeGraphAnalysisBudget {
  return {
    maxDurationMilliseconds: MCP_CODE_GRAPH_TOOL_TIMEOUT_MILLISECONDS - MCP_CODE_GRAPH_RESPONSE_RESERVE_MILLISECONDS,
    maxEdges: MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_DISTINCT_EDGES,
    maxEdgeVisits: MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_EDGE_VISITS,
    maxNodes: MCP_CODE_GRAPH_ANALYSIS_MAXIMUM_NODE_VISITS,
  };
}

function compactMcpText(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

export function codeGraphAnalysisRefreshResult(
  operation: CodeGraphAnalysisView,
  status: CodeGraphRefreshStatus | undefined,
): CallToolResult {
  if (status?.state === 'deferred') {
    if (status.failure.recovery === 'reconnect-runtime') {
      return codeGraphRuntimeReconnectResult(operation, status.failure, 'code-graph-analysis-state');
    }
    const warning = codeGraphRefreshRecoveryWarning(status.failure);
    return codeGraphRefreshFailureResult(
      {
        content: [
          {
            type: 'text',
            text:
              `Code graph refresh is deferred (${status.failure.code}). ${warning} ` +
              'Whole-graph analysis requires a current ready snapshot; retry analyze_code_graph after recovery.',
          },
        ],
        structuredContent: {
          failure: status.failure,
          operation,
          ...(status.refresh === undefined ? {} : {refresh: status.refresh}),
          state: 'deferred',
          type: 'code-graph-analysis-state',
          version: 2,
        },
      },
      status.failure,
    );
  }
  const progress = status?.state === 'indexing' ? status.progress : undefined;
  const retryAfterMilliseconds = codeGraphRetryAfterMilliseconds(status);
  const compactProgress = compactCodeGraphMcpProgress(progress);
  return attachAnonymousTelemetryReportedOutcome(
    {
      content: [
        {
          type: 'text',
          text:
            `Code graph indexing is continuing in the background (${codeGraphProgressSummary(progress) ?? 'queued'}). ` +
            `Retry analyze_code_graph in about ${retryAfterMilliseconds / 1_000} seconds.`,
        },
      ],
      structuredContent: {
        operation,
        ...(status?.refresh === undefined ? {} : {refresh: status.refresh}),
        ...(compactProgress ? {progress: compactProgress} : {}),
        retryAfterMilliseconds,
        state: 'indexing',
        type: 'code-graph-analysis-state',
        version: 1,
      },
    },
    'unavailable',
  );
}

const waitForCodeGraphRefresh = Effect.fn('mcpServer.waitForCodeGraphRefresh')(function* (
  watcher: CodeGraphWatcherShape,
  key: string,
  target: {readonly cwd: string; readonly threadnoteHome: string},
) {
  const attempts = Math.ceil(MCP_CODE_GRAPH_INITIAL_WAIT_MILLISECONDS / MCP_CODE_GRAPH_POLL_MILLISECONDS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = yield* watcher.status(key, target);
    if (Option.isSome(status) && status.value.state !== 'indexing') return;
    yield* Effect.sleep(MCP_CODE_GRAPH_POLL_MILLISECONDS);
  }
});

/** Add a finite recovery hint without copying a native error, path, or raw cause into MCP output. */
export function codeGraphResultWithRefreshContinuity(
  result: CodeGraphQueryResult,
  refreshStatus: CodeGraphRefreshStatus | undefined,
  refresh?: CodeGraphRefreshContinuity,
): CodeGraphQueryResult {
  if (result.freshness !== 'stale') return result;
  const warning =
    refreshStatus?.state === 'deferred'
      ? `Serving the existing stale ready snapshot because code graph refresh is deferred ` +
        `(${refreshStatus.failure.code}). ${codeGraphRefreshRecoveryWarning(refreshStatus.failure)}`
      : refresh?.state === 'deferred'
        ? 'Serving the existing stale ready snapshot while refresh is deferred; continue bounded discovery and retry only before a current relationship claim.'
        : refresh?.state === 'queued'
          ? 'Serving the existing stale ready snapshot while refresh is queued; continue bounded discovery while it converges.'
          : refresh?.state === 'active'
            ? 'Serving the existing stale ready snapshot while refresh continues in the background.'
            : refreshStatus?.state === 'indexing'
              ? 'Serving the existing stale ready snapshot while code graph refresh continues in the background.'
              : 'Serving the existing stale ready snapshot while background refresh discovery is pending; continue bounded discovery and use `path` or `impact` when current graph evidence is required.';
  const bounded = compactMcpText(warning, 320);
  return result.warnings.includes(bounded) ? result : {...result, warnings: [...result.warnings, bounded]};
}

function codeGraphRefreshRecoveryWarning(failure: CodeGraphRefreshFailure): string {
  switch (failure.recovery) {
    case 'defer':
      return 'Retry after the current code graph writer finishes.';
    case 'free-space':
      return 'Free storage space, then retry the refresh.';
    case 'fix-permissions':
      return 'Restore storage permissions, then retry the refresh.';
    case 'retry-read-only':
      return 'Retry the read-only refresh; run `threadnote doctor --dry-run` if the failure repeats.';
    case 'migrate-additive':
      return 'Run the preflight-proven additive migration before retrying.';
    case 'reconnect-runtime':
      return 'Reconnect this Threadnote MCP server to load the installed runtime, then retry.';
    case 'manual-migration':
      return 'Run `threadnote doctor --dry-run` and follow the schema migration guidance.';
    case 'manual-rebuild':
      return 'Run `threadnote doctor --dry-run` before any explicit rebuild.';
    case 'diagnose':
      return 'Run `threadnote doctor --dry-run`, then retry after addressing the bounded diagnostic.';
  }
}

function codeGraphWorksetTraversalText(result: CodeGraphCrossRepositoryTraversalResultV1): string {
  return [
    `Workset ${result.direction === 'forward' ? 'path' : 'impact'} ${result.generationId}: ${result.stop.reason}.`,
    `${result.edges.length} returned edge(s): ${result.coverage.acceptedLocalEdges} local, ${result.coverage.acceptedBridgeEdges} cross-repository.`,
    ...result.edges.slice(0, 12).map(edge => {
      const source =
        edge.source.reference.kind === 'component' ? edge.source.reference.componentId : edge.source.reference.ref;
      const target =
        edge.target.reference.kind === 'component' ? edge.target.reference.componentId : edge.target.reference.ref;
      return `${edge.source.repositoryKey}:${source} --${edge.relation}/${edge.provenance.kind}--> ${edge.target.repositoryKey}:${target}`;
    }),
  ].join('\n');
}

function codeGraphWorksetTopologyText(result: CodeGraphWorksetTopologyResultV1): string {
  return [
    `Workset topology ${result.workset}: ${result.state}.`,
    ...(result.bridgeSet === undefined
      ? []
      : [
          `${result.bridgeSet.bridgeCount} bridge(s), coverage ${result.bridgeSet.coverage.state}, generation ${result.bridgeSet.generationId}.`,
        ]),
    ...(result.topology === undefined
      ? []
      : [
          `${result.topology.nodes.length} node(s), ${result.topology.edges.length} aggregate edge(s), ${result.topology.coverage.complete ? 'complete' : 'bounded partial'} output.`,
        ]),
    ...result.warnings,
  ].join('\n');
}

function codeGraphRefreshResult(
  operation: 'explain' | 'impact' | 'neighbors' | 'node' | 'path' | 'query' | 'topology',
  status: CodeGraphRefreshStatus | undefined,
  continuity?: CodeGraphRefreshContinuity,
): CallToolResult {
  const refresh = continuity ?? status?.refresh;
  if (status?.state === 'deferred') {
    if (status.failure.recovery === 'reconnect-runtime') {
      return codeGraphRuntimeReconnectResult(operation, status.failure, 'code-graph-index-state');
    }
    const warning = codeGraphRefreshRecoveryWarning(status.failure);
    return codeGraphRefreshFailureResult(
      {
        content: [
          {
            type: 'text',
            text:
              `Code graph refresh is deferred (${status.failure.code}). ${warning} ` +
              'Non-strict query, node, neighbors, and explain operations may continue from an existing usable ready snapshot.',
          },
        ],
        structuredContent: {
          failure: status.failure,
          operation,
          ...(refresh === undefined ? {} : {refresh}),
          state: 'deferred',
          type: 'code-graph-index-state',
          version: 4,
        },
      },
      status.failure,
    );
  }
  const progress = status?.state === 'indexing' ? status.progress : undefined;
  const timing = status?.state === 'indexing' ? status.timing : undefined;
  const compactProgress = compactCodeGraphMcpProgress(progress);
  const compactTiming = compactCodeGraphMcpTiming(timing);
  const phase = progress?.phase ?? 'queued';
  const waitingOnWriter = progress?.phase === 'waiting' && progress.reason === 'database-writer';
  const retryAfterMilliseconds = codeGraphRetryAfterMilliseconds(status);
  const progressSummary = codeGraphProgressSummary(progress);
  const estimateSummary =
    timing?.estimatedPhaseRemainingMilliseconds === undefined
      ? ''
      : timing.estimateConfidence === 'low'
        ? ' The phase ETA is still stabilizing from completed batch output.'
        : ` Estimated remaining time for this phase: about ${formatCodeGraphDuration(
            timing.estimatedPhaseRemainingMilliseconds,
          )} (${timing.estimateConfidence ?? 'low'} confidence).`;
  return attachAnonymousTelemetryReportedOutcome(
    {
      content: [
        {
          type: 'text',
          text:
            `Code graph indexing is continuing in the background (${progressSummary ?? `phase: ${phase}`}).` +
            estimateSummary +
            (waitingOnWriter
              ? ' A database writer is active and build progress is unavailable; retry after it releases. '
              : ` Retry this inspect_code_graph call in about ${retryAfterMilliseconds / 1_000} seconds for graph evidence. `) +
            'Continue with targeted text/path search or other independent investigation while the graph builds; ' +
            'retry before making relationship-aware graph claims.',
        },
      ],
      structuredContent: {
        operation,
        ...(refresh === undefined ? {} : {refresh}),
        phase,
        ...(compactProgress ? {progress: compactProgress} : {}),
        ...(waitingOnWriter ? {} : {retryAfterMilliseconds}),
        state: 'indexing',
        ...(compactTiming ? {timing: compactTiming} : {}),
        type: 'code-graph-index-state',
        version: 3,
      },
    },
    'unavailable',
  );
}

function codeGraphRuntimeReconnectResult(
  operation: CodeGraphAnalysisView | 'explain' | 'impact' | 'neighbors' | 'node' | 'path' | 'query' | 'topology',
  failure: CodeGraphRefreshFailure,
  type: 'code-graph-analysis-state' | 'code-graph-index-state',
): CallToolResult {
  return codeGraphRefreshFailureResult(
    {
      content: [
        {
          type: 'text',
          text:
            'Code graph storage was upgraded by a newer Threadnote runtime. Reconnect this Threadnote MCP server ' +
            'to load the installed runtime, then retry the same graph request. No background build was started.',
        },
      ],
      structuredContent: {
        failure,
        operation,
        state: 'reconnect-required',
        type,
        version: 1,
      },
    },
    failure,
  );
}

function codeGraphRefreshFailureResult(result: CallToolResult, failure: CodeGraphRefreshFailure): CallToolResult {
  return attachAnonymousTelemetryReportedOutcome(
    attachAnonymousTelemetryDiagnostic(result, anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure(failure)),
    'failure',
  );
}

const codeGraphQueryTimeoutStatusFor = Effect.fn('mcpServer.codeGraphQueryTimeoutStatusFor')(function* (
  context: Option.Option<{
    readonly key: string;
    readonly target: {readonly cwd: string; readonly threadnoteHome: string};
    readonly watcher: CodeGraphWatcherShape;
  }>,
) {
  if (Option.isNone(context)) return undefined;
  const status = yield* context.value.watcher.status(context.value.key, context.value.target).pipe(
    Effect.timeoutOrElse({
      duration: MCP_CODE_GRAPH_TIMEOUT_STATUS_MILLISECONDS,
      orElse: () => Effect.succeed(Option.none<CodeGraphRefreshStatus>()),
    }),
    Effect.orElseSucceed(() => Option.none<CodeGraphRefreshStatus>()),
  );
  return Option.getOrUndefined(status);
});

export function codeGraphQueryTimeoutResult(
  operation: 'explain' | 'impact' | 'neighbors' | 'node' | 'path' | 'query' | 'topology',
  status?: CodeGraphRefreshStatus,
  readyReadStarted = false,
  budgetMilliseconds = MCP_CODE_GRAPH_QUERY_TIMEOUT_MILLISECONDS,
): CallToolResult {
  if (!readyReadStarted && (status?.state === 'deferred' || status?.state === 'indexing')) {
    return codeGraphRefreshResult(operation, status);
  }
  return attachAnonymousTelemetryReportedOutcome(
    {
      content: [
        {
          type: 'text',
          text: readyReadStarted
            ? `Code graph ready-snapshot inspection exceeded Threadnote's ${budgetMilliseconds / 1_000}-second MCP budget. ` +
              'The ready snapshot remains available; use the matching `threadnote graph` command with `--freshness ready --read-timeout-ms 120000` for a longer foreground read.'
            : `Code graph inspection exceeded Threadnote's ${budgetMilliseconds / 1_000}-second ` +
              'server budget. Retry the same request after the suggested delay. If it repeats, run ' +
              '`threadnote graph status`, then ' +
              '`threadnote doctor --dry-run`, and report the bounded diagnostic.',
        },
      ],
      structuredContent: {
        operation,
        ...(readyReadStarted
          ? {readySnapshotAvailable: true}
          : {retryAfterMilliseconds: MCP_CODE_GRAPH_RETRY_FALLBACK_MILLISECONDS}),
        state: 'timed-out',
        type: 'code-graph-query-state',
        version: 2,
      },
    },
    'timed-out',
  );
}

export function codeGraphRetryAfterMilliseconds(status: CodeGraphRefreshStatus | undefined): number {
  const estimate = status?.state === 'indexing' ? status.timing.estimatedPhaseRemainingMilliseconds : undefined;
  if (estimate === undefined || !Number.isFinite(estimate) || estimate <= 0) {
    return MCP_CODE_GRAPH_RETRY_FALLBACK_MILLISECONDS;
  }
  const adaptive = Math.ceil(estimate / 4_000) * 1_000;
  return Math.max(
    MCP_CODE_GRAPH_RETRY_MINIMUM_MILLISECONDS,
    Math.min(MCP_CODE_GRAPH_RETRY_MAXIMUM_MILLISECONDS, adaptive),
  );
}

function codeGraphProgressSummary(progress: CodeGraphProgress | undefined): string | undefined {
  if (!progress) return undefined;
  switch (progress.phase) {
    case 'scanning':
      return (
        `scanning: ${progress.completed}/${progress.total} eligible files processed; ` +
        `${progress.accepted} accepted, ${progress.skipped} content skipped, ${progress.excluded} excluded`
      );
    case 'materializing':
      return (
        `materializing: ${progress.completed}/${progress.total} files; ${progress.reused} reused` +
        (progress.activity
          ? `; ${progress.activity.stage}; batch ${Math.min(
              progress.activity.batchTotal,
              progress.activity.batchCompleted + 1,
            )}/${progress.activity.batchTotal}`
          : '')
      );
    case 'embedding':
      return `embedding: ${progress.completed}/${progress.total} symbols; ${progress.reused} reused`;
    default:
      return `phase: ${progress.phase}`;
  }
}
function formatCodeGraphDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${Math.ceil(minutes / 60)} hours`;
}
