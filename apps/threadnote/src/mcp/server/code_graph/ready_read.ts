import {Array as EffectArray, Effect} from 'effect';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {codeGraphScopeAdmitsPath} from '@threadnote/graph/scope/applicability';
import {
  codeGraphProjectCoverage,
  discloseCodeGraphProjectCoverage,
  outsideCodeGraphProjectPaths,
  type CodeGraphQueryScope,
} from '@threadnote/graph/query/scope';
import type {
  CodeGraphQueryOptions,
  CodeGraphQueryResult,
  CodeGraphSnapshot,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {
  codeGraphInspectionAllowsStaleReady,
  codeGraphInspectionObservation,
  codeGraphInspectionObservesWorktree,
  codeGraphInspectionStartsRefresh,
} from '@threadnote/graph/query/contract';
import type {
  CodeGraphRefreshStatus,
  CodeGraphRefreshContinuity,
  CodeGraphWatcherShape,
  CodeGraphWatchOptions,
} from '@threadnote/graph/watcher';
import {attachAnonymousTelemetryReportedOutcome} from '../../../telemetry/diagnostic.js';

type CodeGraphInspectionOperation = CodeGraphQueryResult['operation'];
const MCP_CODE_GRAPH_QUERY_RESERVE_MILLISECONDS = 3_000;

export function codeGraphRefreshBlocksReadyInspection(
  status: {readonly readySnapshot?: unknown; readonly stale: boolean},
  refreshStatus: CodeGraphRefreshStatus | undefined,
  allowStaleReadySnapshot = false,
): boolean {
  if (refreshStatus?.state === 'deferred' && refreshStatus.failure.recovery === 'reconnect-runtime') return true;
  const refreshBlocks = refreshStatus?.state === 'deferred' || refreshStatus?.state === 'indexing';
  return refreshBlocks && (!status.readySnapshot || (status.stale && !allowStaleReadySnapshot));
}

/** A successful stale-tolerant read is authoritative over refresh-process state. */
export function codeGraphRefreshBlocksCompletedInspection(
  status: {readonly readySnapshot?: unknown; readonly stale: boolean},
  refreshStatus: CodeGraphRefreshStatus | undefined,
  allowStaleReadySnapshot: boolean,
): boolean {
  return (
    !allowStaleReadySnapshot && codeGraphRefreshBlocksReadyInspection(status, refreshStatus, allowStaleReadySnapshot)
  );
}

export {
  codeGraphInspectionAllowsStaleReady,
  codeGraphInspectionObservation,
  codeGraphInspectionObservesWorktree,
  codeGraphInspectionStartsRefresh,
};

export function codeGraphInspectionRequestsBackgroundRefresh(
  status: {readonly readySnapshot?: unknown; readonly stale: boolean},
  operation: CodeGraphInspectionOperation,
): boolean {
  return status.readySnapshot !== undefined && status.stale && codeGraphInspectionAllowsStaleReady(operation);
}

export function codeGraphQueryExecutionBudget(requestBudget: number): number {
  return Math.max(1, requestBudget - MCP_CODE_GRAPH_QUERY_RESERVE_MILLISECONDS);
}

export function codeGraphNoReadySnapshotResult(operation: CodeGraphInspectionOperation): CallToolResult {
  return attachAnonymousTelemetryReportedOutcome(
    {
      content: [
        {
          type: 'text',
          text:
            'No compatible ready code graph snapshot is available for this repository. ' +
            'Threadnote did not start a background build for this read-only inspection. ' +
            'Run `threadnote graph index`, then retry inspect_code_graph.',
        },
      ],
      structuredContent: {
        operation,
        reason: 'no-ready-snapshot',
        state: 'unavailable',
        type: 'code-graph-query-state',
        version: 1,
      },
    },
    'unavailable',
  );
}

export function selectCodeGraphReadySnapshotForInspection<T>(
  status: {readonly readySnapshot?: T; readonly stale: boolean},
  refreshStatus: CodeGraphRefreshStatus | undefined,
  allowStaleReadySnapshot = false,
): T | undefined {
  return codeGraphRefreshBlocksReadyInspection(status, refreshStatus, allowStaleReadySnapshot)
    ? undefined
    : status.readySnapshot;
}

export const completeCodeGraphReadyReadRefresh = Effect.fn('codeGraph.completeReadyReadRefresh')(function* (input: {
  readonly backgroundRefreshRequested: boolean;
  readonly ensureWatcher: boolean;
  readonly key: string;
  readonly refresh?: CodeGraphRefreshContinuity;
  readonly refreshStatus?: CodeGraphRefreshStatus;
  readonly target: Omit<CodeGraphWatchOptions, 'key'>;
  readonly watcher: Pick<CodeGraphWatcherShape, 'scheduleEnsure' | 'scheduleRequest' | 'scheduleResume'>;
}) {
  if (input.ensureWatcher && input.watcher.scheduleEnsure !== undefined) {
    yield* input.watcher.scheduleEnsure({...input.target, key: input.key});
  }
  if (!input.backgroundRefreshRequested) return input.refresh;
  const observedContinuity =
    input.refresh ??
    ({
      type: 'code-graph-refresh-continuity' as const,
      version: 1 as const,
      state: input.refreshStatus?.state === 'indexing' ? ('active' as const) : ('deferred' as const),
    } satisfies CodeGraphRefreshContinuity);
  const failure = input.refreshStatus?.state === 'deferred' ? input.refreshStatus.failure : undefined;
  const continuity =
    failure === undefined ? observedContinuity : {...observedContinuity, failure, state: 'deferred' as const};
  // Durable demand discovery is maintenance, not part of the evidence read.
  // The watcher owns a keyed single-flight in its service scope so repeated
  // stale reads return promptly without accumulating detached filesystem work.
  if (failure?.retryable !== false || failure.reobserveTarget === true) {
    if (input.watcher.scheduleRequest !== undefined) {
      yield* input.watcher.scheduleRequest({...input.target, key: input.key});
    } else if (input.watcher.scheduleResume !== undefined) {
      yield* input.watcher.scheduleResume({...input.target, key: input.key});
    }
  }
  return continuity;
});

export function selectCodeGraphReadyReadChangedPaths(
  projectScope: CodeGraphQueryScope | undefined,
  paths: readonly string[] | undefined,
): readonly string[] | undefined {
  return paths === undefined
    ? undefined
    : EffectArray.filter(paths, path => codeGraphScopeAdmitsPath(projectScope?.scope, path));
}

export function presentCodeGraphScopedReadyRead(input: {
  readonly identity: RepositoryIdentity;
  readonly options: CodeGraphQueryOptions;
  readonly projectScope: CodeGraphQueryScope | undefined;
  readonly result: CodeGraphQueryResult;
  readonly selectedChangedPathCount?: number;
  readonly snapshot: Pick<CodeGraphSnapshot, 'commit'>;
  readonly totalChangedPathCount?: number;
}): CodeGraphQueryResult {
  if (input.projectScope === undefined) return input.result;
  const outsidePaths = outsideCodeGraphProjectPaths(input.options, input.projectScope.scope);
  const result =
    outsidePaths.length === 0
      ? input.result
      : {...input.result, edges: [], nodes: [], scope: undefined, searchCoverage: undefined, warnings: []};
  return discloseCodeGraphProjectCoverage(
    result,
    codeGraphProjectCoverage(input.projectScope, input.identity, input.snapshot, result.freshness === 'current'),
    outsidePaths,
    input.totalChangedPathCount === undefined
      ? undefined
      : input.totalChangedPathCount - (input.selectedChangedPathCount ?? 0),
  );
}
