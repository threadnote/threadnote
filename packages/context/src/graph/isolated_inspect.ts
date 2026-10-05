import {Effect} from 'effect';
import {
  CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS,
  inspectCodeGraphIsolated,
} from '@threadnote/graph/isolated/impact_query';
import {CodeGraphQueryService, type CodeGraphInspectOptions} from '@threadnote/graph/query';
import {
  codeGraphProjectCoverage,
  discloseCodeGraphProjectCoverage,
  outsideCodeGraphProjectPaths,
  type CodeGraphQueryScope,
} from '@threadnote/graph/query/scope';
import {codeGraphScopeAdmitsPath} from '@threadnote/graph/scope/applicability';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {CodeGraphQueryResult, RepositoryIdentity} from '@threadnote/graph/types';

export const CONTEXT_BRIEF_GRAPH_ISOLATED_READ_TIMEOUT_MILLISECONDS = CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS;

type ContextBriefGraphQueryService = Parameters<typeof CodeGraphQueryService.of>[0];

const canServeIsolated = (options: CodeGraphInspectOptions): boolean =>
  options.refresh === false &&
  options.strictFreshness === false &&
  options.requestMaintenance === false &&
  options.interlock === undefined &&
  options.onProgress === undefined;

export const inspectContextBriefGraphIsolated = Effect.fn('contextBrief.inspectGraphIsolated')(function* (
  base: ContextBriefGraphQueryService,
  options: CodeGraphInspectOptions,
) {
  if (!canServeIsolated(options)) return yield* base.inspect(options);
  const observation = options.statusObservation;
  const result = yield* inspectCodeGraphIsolated(
    {
      project: options.project,
      manifestPath: options.manifestPath,
      ...(options.baseCommit === undefined ? {} : {baseCommit: options.baseCommit}),
      ...(observation?.borrowedSnapshotId === undefined ? {} : {borrowedSnapshotId: observation.borrowedSnapshotId}),
      ...(observation?.readySnapshotId === undefined ? {} : {readySnapshotId: observation.readySnapshotId}),
      cwd: options.cwd,
      depth: options.depth,
      direction: options.direction,
      edgeLimit: options.edgeLimit ?? 40,
      from: options.from,
      includeHeuristic: options.includeHeuristic,
      includeModelAssociations: options.includeModelAssociations,
      nodeId: options.nodeId,
      nodeLimit: options.nodeLimit ?? 20,
      operation: options.operation,
      ...(observation?.overlay === undefined ? {} : {overlay: observation.overlay}),
      packageName: options.packageName,
      projectScope: observation?.projectScope,
      query: options.query,
      seedQueries: options.seedQueries,
      seedQueryCount: options.seedQueryCount,
      ...(options.strictFreshness === undefined ? {} : {strictFreshness: options.strictFreshness}),
      symbol: options.symbol,
      threadnoteHome: options.threadnoteHome,
      to: options.to,
    },
    {timeoutMilliseconds: CONTEXT_BRIEF_GRAPH_ISOLATED_READ_TIMEOUT_MILLISECONDS},
  );
  if (observation === undefined) return result;
  return presentIsolatedBriefGraphRead(result, options, observation.identity, observation.projectScope);
});

// The worker defers scope presentation by contract, so re-apply the same
// disclosure the in-process read performs once the child returns. The
// out-of-scope branch mirrors its bare empty selection, not the worker shell.
function presentIsolatedBriefGraphRead(
  result: CodeGraphQueryResult,
  options: CodeGraphInspectOptions,
  identity: RepositoryIdentity,
  scope: CodeGraphQueryScope | undefined,
): CodeGraphQueryResult {
  if (scope === undefined) return result;
  const outsidePaths = outsideCodeGraphProjectPaths(options, scope.scope);
  const scopedSeedQueries = options.seedQueries?.filter(candidate => codeGraphScopeAdmitsPath(scope.scope, candidate));
  const seedDrift =
    options.seedQueries === undefined ? undefined : options.seedQueries.length - (scopedSeedQueries?.length ?? 0);
  const coverage = codeGraphProjectCoverage(scope, identity, result.snapshot, result.freshness === 'current');
  if (outsidePaths.length > 0 || (scopedSeedQueries !== undefined && scopedSeedQueries.length === 0)) {
    return discloseCodeGraphProjectCoverage(
      {
        edges: [],
        freshness: result.freshness,
        nodes: [],
        operation: result.operation,
        repository: result.repository,
        snapshot: result.snapshot,
        trust: result.trust,
        version: result.version,
        warnings: [],
      },
      coverage,
      outsidePaths,
      seedDrift,
    );
  }
  return discloseCodeGraphProjectCoverage(result, coverage, outsidePaths, seedDrift);
}

export const withIsolatedContextBriefGraphReads = Effect.fn('contextBrief.withIsolatedReads')(function* (
  base: ContextBriefGraphQueryService,
) {
  const command = yield* CommandExecutor;
  const system = yield* SystemInfo;
  return CodeGraphQueryService.of({
    ...base,
    inspect: options =>
      inspectContextBriefGraphIsolated(base, options).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, system),
      ),
  });
});
