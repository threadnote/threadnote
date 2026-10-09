import {RefreshCw} from 'lucide-react';
import {PageActions} from '../workspace.js';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import type {CodeGraphLocalDiagnosticsReport} from '@threadnote/graph/diagnostics';
import {compareCodeUnits} from '@threadnote/graph/ordering';
import {type ManagerGraphVisualizationLimits} from '@threadnote/graph/visualization/limits';
import {
  cacheGraphNodeDetail,
  compactNumber,
  createGraphQueryRequestGate,
  DEFAULT_QUERY_WORKING_SET,
  DEFAULT_WORKING_SET,
  GRAPH_QUERY_DEBOUNCE_MILLISECONDS,
  GRAPH_QUERY_MAXIMUM_LENGTH,
  graphAnalysisRequestIsCurrent,
  graphAdministrationJobSelection,
  graphBuildShouldDisplay,
  graphCatalogContinuationHasMore,
  graphCatalogEmptyState,
  graphCatalogPageOffsets,
  graphCatalogSearchOptions,
  graphConfiguredProjectScopeIds,
  graphLocalAssociationText,
  graphNodeDetailRequestIsCurrent,
  graphOverviewSizeLabel,
  graphProjectBadge,
  graphRepositoryGroupScopeId,
  graphRepositoryOptionLabel,
  graphRepositoryScopeLabel,
  graphRequestIsCurrent,
  graphWithNodeNeighborhood,
  isAbortError,
  managerGraphDebouncedQueryCandidate,
  managerGraphQueryCandidate,
  MAX_QUERY_WORKING_SET,
  MAX_WORKING_SET,
  mergeGraphRepositoryGroups,
  orderGraphBuildStatuses,
  relationLabel,
  resolveGraphSelection,
  type GraphAdministrationAction,
  type GraphAnalysis,
  type GraphCatalog,
  type GraphCatalogContinuation,
  type GraphCatalogPage,
  type GraphCatalogSearchOptions,
  type GraphFocusMode,
  type GraphNodeDetail,
  type GraphQueryVisualization,
  type GraphRepositoryGroup,
  type GraphSizeMetric,
  type GraphViewPage,
  type GraphVisualization,
} from './model.js';
import {
  GraphAdministration,
  GraphAutomaticCompactionProgress,
  GraphBuildProgress,
  GraphEmptyState,
  GraphMaintenanceProgress,
  GraphSummary,
  NodeInspector,
} from './panels.js';
import {ThreeGraph} from './scene.js';

export function GraphWorkspace(props: {
  readonly administration?: CodeGraphLocalDiagnosticsReport;
  readonly administrationBusy?: string;
  readonly administrationOutput?: string;
  readonly catalog?: GraphCatalog;
  readonly catalogError?: string;
  readonly loadAnalysis: (repositoryId: string, snapshotId: string, signal: AbortSignal) => Promise<GraphAnalysis>;
  readonly loadGraph: (
    repositoryId: string,
    snapshotId: string,
    projectId: string,
    limits: ManagerGraphVisualizationLimits,
    signal: AbortSignal,
  ) => Promise<GraphVisualization>;
  readonly loadCatalogPage: (
    repositoryId: string,
    snapshotId: string,
    projectOffset: number,
    workspaceOffset: number,
    query: string,
    signal: AbortSignal,
  ) => Promise<GraphCatalogPage>;
  readonly loadNodeDetail: (
    repositoryId: string,
    snapshotId: string,
    nodeId: string,
    signal: AbortSignal,
  ) => Promise<GraphNodeDetail>;
  readonly loadQuery: (
    repositoryId: string,
    snapshotId: string,
    query: string,
    limits: ManagerGraphVisualizationLimits,
    signal: AbortSignal,
  ) => Promise<GraphQueryVisualization>;
  readonly loadViewsPage: (
    repositoryId: string,
    offset: number,
    query: string,
    scopeIds: readonly string[],
    signal: AbortSignal,
  ) => Promise<GraphViewPage>;
  readonly onAdministrationAction?: (action: GraphAdministrationAction) => void;
  readonly onDiagnostics?: (options: {readonly analyze: boolean; readonly deep: boolean}) => void;
  readonly onRefresh: () => void;
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState<'administration' | 'explore'>('explore');
  const [repositoryId, setRepositoryId] = useState('');
  const [viewId, setViewId] = useState('');
  const [projectId, setProjectId] = useState('all');
  const [baseGraph, setBaseGraph] = useState<GraphVisualization | undefined>();
  const [workingSet, setWorkingSet] = useState<ManagerGraphVisualizationLimits>(DEFAULT_WORKING_SET);
  const [expandedNeighborhood, setExpandedNeighborhood] = useState<GraphNodeDetail | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [focusRequest, setFocusRequest] = useState<{readonly nodeId: string; readonly sequence: number} | undefined>();
  const focusSequence = useRef(0);
  const [search, setSearch] = useState('');
  const [queryInput, setQueryInput] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [queryGraph, setQueryGraph] = useState<GraphQueryVisualization | undefined>();
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [queryAttempt, setQueryAttempt] = useState(0);
  const [queryWorkingSet, setQueryWorkingSet] = useState<ManagerGraphVisualizationLimits>(DEFAULT_QUERY_WORKING_SET);
  const queryRequestGate = useRef(createGraphQueryRequestGate());
  const [relationFilter, setRelationFilter] = useState('all');
  const [focusMode, setFocusMode] = useState<GraphFocusMode>('all');
  const [sizeMetric, setSizeMetric] = useState<GraphSizeMetric>('connections');
  const [nodeDetail, setNodeDetail] = useState<GraphNodeDetail | undefined>();
  const [nodeDetailLoading, setNodeDetailLoading] = useState(false);
  const [nodeDetailError, setNodeDetailError] = useState('');
  const nodeDetailCache = useRef(new Map<string, GraphNodeDetail>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState<GraphAnalysis | undefined>();
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const analysisRequestSequence = useRef(0);
  const analysisAbortController = useRef<AbortController | undefined>(undefined);
  const graphRequestSequence = useRef(0);
  const [catalogAdditions, setCatalogAdditions] = useState<readonly GraphRepositoryGroup[]>([]);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogSearchResult, setCatalogSearchResult] = useState<
    {readonly options: GraphCatalogSearchOptions; readonly query: string} | undefined
  >();
  const [catalogContinuation, setCatalogContinuation] = useState<GraphCatalogContinuation>();
  const catalogAbortController = useRef<AbortController | undefined>(undefined);
  const catalogRequestSequence = useRef(0);
  const baseCatalogIdentity = useMemo(
    () =>
      (props.catalog?.repositories ?? [])
        .flatMap(group => group.views.map(view => `${view.id}:${view.snapshot.id}`))
        .sort(compareCodeUnits)
        .join('|'),
    [props.catalog?.repositories],
  );
  const repositories = useMemo(
    () => mergeGraphRepositoryGroups(props.catalog?.repositories ?? [], catalogAdditions),
    [catalogAdditions, props.catalog?.repositories],
  );
  const repositoryGroup = repositories.find(candidate => candidate.id === repositoryId) ?? repositories[0];
  const repository =
    repositoryGroup?.views.find(candidate => candidate.id === viewId) ??
    repositoryGroup?.views.find(candidate => candidate.id === repositoryGroup.defaultViewId) ??
    repositoryGroup?.views[0];
  const baseRepositoryGroup = (props.catalog?.repositories ?? []).find(
    candidate => candidate.id === repositoryGroup?.id,
  );
  const baseRepository = baseRepositoryGroup?.views.find(candidate => candidate.id === repository?.id);
  const analysisScope = `${repository?.id ?? ''}:${repository?.snapshot.id ?? ''}`;
  const analysisScopeRef = useRef(analysisScope);
  analysisScopeRef.current = analysisScope;
  const graphScope = `${analysisScope}:${projectId}:${workingSet.nodeLimit}:${workingSet.edgeLimit}`;
  const graphScopeRef = useRef(graphScope);
  graphScopeRef.current = graphScope;
  const queryScope = `${analysisScope}:${activeQuery}:${queryAttempt}:${queryWorkingSet.nodeLimit}:${queryWorkingSet.edgeLimit}`;
  const graphSource = activeQuery ? queryGraph : baseGraph;
  const graph = useMemo(
    () =>
      graphSource && expandedNeighborhood ? graphWithNodeNeighborhood(graphSource, expandedNeighborhood) : graphSource,
    [expandedNeighborhood, graphSource],
  );
  const selectedNode = graph?.nodes.find(node => node.id === selectedNodeId);
  const relations = useMemo(
    () => [...new Set(graph?.edges.map(edge => edge.relation) ?? [])].sort(compareCodeUnits),
    [graph],
  );
  const visibleBuilds = useMemo(
    () => orderGraphBuildStatuses((props.catalog?.builds ?? []).filter(graphBuildShouldDisplay), repositories),
    [props.catalog?.builds, repositories],
  );
  const administrationJobs = useMemo(
    () => graphAdministrationJobSelection(visibleBuilds, props.catalog?.waiters ?? []),
    [props.catalog?.waiters, visibleBuilds],
  );
  const statusNoticeCount =
    administrationJobs.total +
    (props.catalog?.automaticCompaction ? 1 : 0) +
    (props.catalog?.maintenance ? 1 : 0) +
    (props.catalog?.diagnostics.length ?? 0);
  const emptyState = graphCatalogEmptyState({
    automaticCompaction: props.catalog?.automaticCompaction,
    builds: visibleBuilds,
    catalogError: props.catalogError,
    lifecyclePending: props.catalog?.lifecyclePending,
    maintenance: props.catalog?.maintenance,
  });
  const selectedRepositoryIsIndexing = visibleBuilds.some(
    build =>
      repository !== undefined &&
      build.identity.checkoutId === repository.checkoutId &&
      build.identity.scopeId === repository.scopeId &&
      build.identity.worktreeId === repository.worktreeId &&
      (build.state === 'queued' || build.state === 'running'),
  );
  const workingSetAtMaximum = activeQuery
    ? queryWorkingSet.nodeLimit >= MAX_QUERY_WORKING_SET.nodeLimit &&
      queryWorkingSet.edgeLimit >= MAX_QUERY_WORKING_SET.edgeLimit
    : workingSet.nodeLimit >= MAX_WORKING_SET.nodeLimit && workingSet.edgeLimit >= MAX_WORKING_SET.edgeLimit;
  const projectCatalogHasMore = graphCatalogContinuationHasMore(
    catalogContinuation,
    repository?.id,
    'projectHasMore',
    repository?.projectsTruncated ?? false,
  );
  const workspaceCatalogHasMore = graphCatalogContinuationHasMore(
    catalogContinuation,
    repository?.id,
    'workspaceHasMore',
    repository?.workspacesTruncated ?? false,
  );
  const viewCatalogHasMore = graphCatalogContinuationHasMore(
    catalogContinuation,
    repository?.id,
    'viewHasMore',
    repositoryGroup?.viewsTruncated ?? false,
  );

  useEffect(() => {
    const selection = resolveGraphSelection(repositories, repositoryId, viewId);
    if (selection.repositoryId !== repositoryId) {
      setRepositoryId(selection.repositoryId);
      setProjectId('all');
      setWorkingSet(DEFAULT_WORKING_SET);
    }
    if (selection.viewId !== viewId) {
      setViewId(selection.viewId);
      setProjectId('all');
      setWorkingSet(DEFAULT_WORKING_SET);
    }
  }, [repositories, repositoryId, viewId]);

  useEffect(() => {
    if (!repository) {
      setBaseGraph(undefined);
      setExpandedNeighborhood(undefined);
      return;
    }
    const requestSequence = graphRequestSequence.current + 1;
    graphRequestSequence.current = requestSequence;
    const requestedScope = graphScope;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSelectedNodeId(undefined);
    setExpandedNeighborhood(undefined);
    setFocusRequest(undefined);
    setFocusMode('all');
    setRelationFilter('all');
    setSizeMetric('connections');
    void props
      .loadGraph(repository.id, repository.snapshot.id, projectId, workingSet, controller.signal)
      .then(next => {
        if (
          graphRequestIsCurrent(graphRequestSequence.current, requestSequence, graphScopeRef.current, requestedScope)
        ) {
          setBaseGraph(next);
        }
      })
      .catch(cause => {
        if (
          !isAbortError(cause) &&
          graphRequestIsCurrent(graphRequestSequence.current, requestSequence, graphScopeRef.current, requestedScope)
        ) {
          setBaseGraph(undefined);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (
          graphRequestIsCurrent(graphRequestSequence.current, requestSequence, graphScopeRef.current, requestedScope)
        ) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      graphRequestSequence.current += 1;
    };
  }, [graphScope, projectId, props.loadGraph, repository?.id, repository?.snapshot.id, workingSet]);

  useEffect(() => {
    const candidate = managerGraphDebouncedQueryCandidate(queryInput);
    if (!candidate || candidate === activeQuery) return;
    const timeout = window.setTimeout(() => {
      setQueryAttempt(0);
      setQueryWorkingSet(DEFAULT_QUERY_WORKING_SET);
      setActiveQuery(candidate);
    }, GRAPH_QUERY_DEBOUNCE_MILLISECONDS);
    return () => window.clearTimeout(timeout);
  }, [activeQuery, queryInput]);

  useEffect(() => {
    if (!repository || !activeQuery) {
      setQueryGraph(undefined);
      setQueryLoading(false);
      setQueryError('');
      return;
    }
    const expectedSnapshotId = repository.snapshot.id;
    const expectedQuery = activeQuery;
    const request = queryRequestGate.current.request({expectedQuery, expectedSnapshotId, scope: queryScope}, signal =>
      props.loadQuery(repository.id, expectedSnapshotId, expectedQuery, queryWorkingSet, signal),
    );
    setQueryGraph(undefined);
    setQueryLoading(true);
    setQueryError('');
    setSelectedNodeId(undefined);
    setExpandedNeighborhood(undefined);
    setFocusRequest(undefined);
    setFocusMode('all');
    setRelationFilter('all');
    setSizeMetric('connections');
    void request.result.then(outcome => {
      if (!request.isCurrent()) return;
      if (outcome.state === 'accepted') {
        setQueryGraph(outcome.graph);
      } else if (outcome.state === 'failed') {
        setQueryGraph(undefined);
        setQueryError(outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause));
      }
      setQueryLoading(false);
    });
    return () => {
      request.cancel();
    };
  }, [activeQuery, props.loadQuery, queryScope, queryWorkingSet, repository?.id, repository?.snapshot.id]);

  useEffect(() => {
    analysisAbortController.current?.abort();
    analysisRequestSequence.current += 1;
    setAnalysis(undefined);
    setAnalysisError('');
    setAnalysisLoading(false);
    return () => {
      analysisAbortController.current?.abort();
      analysisRequestSequence.current += 1;
    };
  }, [repository?.id, repository?.snapshot.id]);

  const loadAnalysis = (): void => {
    if (!repository || analysisLoading) return;
    const requestedScope = analysisScope;
    const requestSequence = analysisRequestSequence.current + 1;
    analysisRequestSequence.current = requestSequence;
    analysisAbortController.current?.abort();
    const controller = new AbortController();
    analysisAbortController.current = controller;
    setAnalysisLoading(true);
    setAnalysisError('');
    void props
      .loadAnalysis(repository.id, repository.snapshot.id, controller.signal)
      .then(next => {
        if (
          graphAnalysisRequestIsCurrent(
            analysisRequestSequence.current,
            requestSequence,
            analysisScopeRef.current,
            requestedScope,
          )
        ) {
          setAnalysis(next);
        }
      })
      .catch(cause => {
        if (
          !isAbortError(cause) &&
          graphAnalysisRequestIsCurrent(
            analysisRequestSequence.current,
            requestSequence,
            analysisScopeRef.current,
            requestedScope,
          )
        ) {
          setAnalysisError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (
          graphAnalysisRequestIsCurrent(
            analysisRequestSequence.current,
            requestSequence,
            analysisScopeRef.current,
            requestedScope,
          )
        ) {
          setAnalysisLoading(false);
        }
      });
  };

  useEffect(() => {
    if (!selectedNode || selectedNode.type !== 'symbol' || !repository) {
      setNodeDetail(undefined);
      setNodeDetailLoading(false);
      setNodeDetailError('');
      return;
    }
    const key = `${repository.id}:${graph?.repository.snapshot.id ?? ''}:${selectedNode.id}`;
    const cached = nodeDetailCache.current.get(key);
    if (cached) {
      cacheGraphNodeDetail(nodeDetailCache.current, key, cached);
      setNodeDetail(cached);
      setExpandedNeighborhood(cached);
      setNodeDetailLoading(false);
      setNodeDetailError('');
      focusSequence.current += 1;
      setFocusRequest({nodeId: cached.node.id, sequence: focusSequence.current});
      return;
    }
    const controller = new AbortController();
    setNodeDetail(undefined);
    setNodeDetailLoading(true);
    setNodeDetailError('');
    void props
      .loadNodeDetail(repository.id, repository.snapshot.id, selectedNode.id, controller.signal)
      .then(detail => {
        if (
          !graphNodeDetailRequestIsCurrent(controller.signal.aborted, detail, repository.snapshot.id, selectedNode.id)
        )
          return;
        cacheGraphNodeDetail(nodeDetailCache.current, key, detail);
        setNodeDetail(detail);
        setExpandedNeighborhood(detail);
        focusSequence.current += 1;
        setFocusRequest({nodeId: detail.node.id, sequence: focusSequence.current});
      })
      .catch(cause => {
        if (!controller.signal.aborted && !isAbortError(cause)) {
          setExpandedNeighborhood(undefined);
          setNodeDetailError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setNodeDetailLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [graph?.repository.snapshot.id, props.loadNodeDetail, repository?.id, selectedNode?.id, selectedNode?.type]);

  const searchResults = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle || !graph) return [];
    return graph.nodes
      .filter(
        node =>
          node.label.toLowerCase().includes(needle) ||
          node.qualifiedName?.toLowerCase().includes(needle) ||
          node.path?.toLowerCase().includes(needle),
      )
      .sort((left, right) => right.degree - left.degree || compareCodeUnits(left.label, right.label))
      .slice(0, 8);
  }, [graph, search]);

  const chooseRepository = (nextRepositoryId: string): void => {
    const next = repositories.find(candidate => candidate.id === nextRepositoryId);
    setRepositoryId(nextRepositoryId);
    setViewId(next?.defaultViewId ?? next?.views[0]?.id ?? '');
    setProjectId('all');
    setWorkingSet(DEFAULT_WORKING_SET);
    clearCatalogSearch();
    clearCodeQuery();
  };

  const chooseView = (nextViewId: string): void => {
    setViewId(nextViewId);
    setProjectId('all');
    setWorkingSet(DEFAULT_WORKING_SET);
    clearCatalogSearch();
    clearCodeQuery();
  };

  const chooseCatalogView = (nextRepositoryId: string, nextViewId: string): void => {
    setRepositoryId(nextRepositoryId);
    setViewId(nextViewId);
    setProjectId('all');
    setWorkingSet(DEFAULT_WORKING_SET);
    clearCatalogSearch();
    clearCodeQuery();
  };

  const chooseProject = (nextProjectId: string): void => {
    setProjectId(nextProjectId);
    setWorkingSet(DEFAULT_WORKING_SET);
    setSearch('');
    setSelectedNodeId(undefined);
    setExpandedNeighborhood(undefined);
    clearCatalogSearch();
    clearCodeQuery();
  };

  function clearCatalogSearch(): void {
    setCatalogQuery('');
    setCatalogSearchResult(undefined);
    setCatalogError('');
  }

  const submitCodeQuery = (): void => {
    const candidate = managerGraphQueryCandidate(queryInput);
    if (!candidate) {
      setQueryError(`Enter between 1 and ${GRAPH_QUERY_MAXIMUM_LENGTH} characters to search the code graph.`);
      return;
    }
    if (candidate === activeQuery) {
      setQueryAttempt(current => current + 1);
      return;
    }
    setQueryAttempt(0);
    setQueryWorkingSet(DEFAULT_QUERY_WORKING_SET);
    setActiveQuery(candidate);
  };

  function clearCodeQuery(): void {
    queryRequestGate.current.cancelCurrent();
    setQueryInput('');
    setActiveQuery('');
    setQueryGraph(undefined);
    setQueryLoading(false);
    setQueryError('');
    setQueryAttempt(0);
    setQueryWorkingSet(DEFAULT_QUERY_WORKING_SET);
    setSelectedNodeId(undefined);
    setExpandedNeighborhood(undefined);
    setFocusRequest(undefined);
  }

  const selectNode = (nodeId: string | undefined, focus = false): void => {
    setSelectedNodeId(nodeId);
    if (!nodeId) {
      setFocusMode('all');
      setExpandedNeighborhood(undefined);
      return;
    }
    if (baseGraph?.nodes.some(node => node.id === nodeId)) setExpandedNeighborhood(undefined);
    if (focus) {
      focusSequence.current += 1;
      setFocusRequest({nodeId, sequence: focusSequence.current});
    }
  };

  const loadCatalogContinuation = (requestedQuery: string): void => {
    if (!repository || !repositoryGroup || catalogLoading) return;
    const query = requestedQuery.trim().slice(0, 256);
    const continuation = catalogContinuation?.viewId === repository.id ? catalogContinuation : undefined;
    const offsets =
      query.length === 0
        ? graphCatalogPageOffsets({
            baseRepository,
            baseRepositoryGroup,
            checkoutId: repository.checkoutId,
            continuation,
            viewId: repository.id,
          })
        : {projectOffset: 0, viewOffset: 0, workspaceOffset: 0};
    const {projectOffset, viewOffset, workspaceOffset} = offsets;
    const configuredScopeIds = graphConfiguredProjectScopeIds(query, props.catalog?.configuredProjects);
    const requestedScope = `${repository.id}:${repository.snapshot.id}:${projectOffset}:${workspaceOffset}:${viewOffset}:${query}`;
    const requestSequence = catalogRequestSequence.current + 1;
    catalogRequestSequence.current = requestSequence;
    catalogAbortController.current?.abort();
    const controller = new AbortController();
    catalogAbortController.current = controller;
    setCatalogLoading(true);
    setCatalogError('');
    void Promise.all([
      props.loadCatalogPage(
        repository.id,
        repository.snapshot.id,
        projectOffset,
        workspaceOffset,
        query,
        controller.signal,
      ),
      props.loadViewsPage(repository.id, viewOffset, query, configuredScopeIds, controller.signal),
    ])
      .then(([catalogPage, viewPage]) => {
        const currentScope = `${repository.id}:${repository.snapshot.id}:${projectOffset}:${workspaceOffset}:${viewOffset}:${query}`;
        if (
          controller.signal.aborted ||
          catalogRequestSequence.current !== requestSequence ||
          currentScope !== requestedScope
        )
          return;
        const selectedViewGroup: GraphRepositoryGroup = {
          ...repositoryGroup,
          defaultViewId: repositoryGroup.defaultViewId,
          views: [catalogPage.repository],
          viewsTruncated: false,
        };
        setCatalogAdditions(current =>
          mergeGraphRepositoryGroups(current, [selectedViewGroup, ...viewPage.repositories]),
        );
        if (query.length > 0) {
          setCatalogSearchResult({
            options: graphCatalogSearchOptions(
              catalogPage.repository,
              viewPage.repositories,
              props.catalog?.configuredProjects,
            ),
            query,
          });
        }
        if (query.length === 0) {
          setCatalogContinuation({
            projectHasMore: catalogPage.repository.projectsTruncated,
            projectOffset:
              projectOffset + catalogPage.repository.projects.filter(project => project.id.startsWith('cgp_')).length,
            viewHasMore: viewPage.hasMore,
            viewId: repository.id,
            viewOffset:
              viewOffset +
              viewPage.repositories
                .flatMap(group => group.views)
                .filter(view => view.checkoutId === repository.checkoutId).length,
            workspaceHasMore: catalogPage.repository.workspacesTruncated,
            workspaceOffset: workspaceOffset + catalogPage.repository.workspaces.length,
          });
        }
      })
      .catch(cause => {
        if (!controller.signal.aborted && catalogRequestSequence.current === requestSequence) {
          setCatalogError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && catalogRequestSequence.current === requestSequence) setCatalogLoading(false);
      });
  };

  useEffect(() => {
    setCatalogAdditions([]);
  }, [baseCatalogIdentity]);

  useEffect(() => {
    catalogAbortController.current?.abort();
    catalogRequestSequence.current += 1;
    setCatalogContinuation(undefined);
    setCatalogError('');
    setCatalogSearchResult(undefined);
    setCatalogLoading(false);
  }, [baseCatalogIdentity, repository?.id, repository?.snapshot.id]);

  return (
    <section className="graph-workspace">
      <PageActions>
        <button onClick={props.onRefresh} type="button">
          <RefreshCw />
          Refresh indexes
        </button>
      </PageActions>

      <div className="graph-page-tabs workspace-tabs" aria-label="Knowledge graph sections" role="tablist">
        <button
          aria-controls="graph-explore-panel"
          aria-selected={activeTab === 'explore'}
          id="graph-explore-tab"
          onClick={() => setActiveTab('explore')}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setActiveTab('administration');
            window.requestAnimationFrame(() => document.getElementById('graph-administration-tab')?.focus());
          }}
          role="tab"
          tabIndex={activeTab === 'explore' ? 0 : -1}
          type="button"
        >
          Explore
        </button>
        <button
          aria-controls="graph-administration-panel"
          aria-selected={activeTab === 'administration'}
          id="graph-administration-tab"
          onClick={() => setActiveTab('administration')}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setActiveTab('explore');
            window.requestAnimationFrame(() => document.getElementById('graph-explore-tab')?.focus());
          }}
          role="tab"
          tabIndex={activeTab === 'administration' ? 0 : -1}
          type="button"
        >
          <span>Indexes &amp; administration</span>
          {statusNoticeCount > 0 ? (
            <small aria-label={`${statusNoticeCount} status notices`}>{statusNoticeCount}</small>
          ) : null}
        </button>
      </div>

      <div
        aria-labelledby="graph-administration-tab"
        className="graph-tab-panel graph-administration-tab"
        hidden={activeTab !== 'administration'}
        id="graph-administration-panel"
        role="tabpanel"
        tabIndex={0}
      >
        <div className="graph-notices">
          <GraphAdministration
            busy={props.administrationBusy}
            configuredProjects={props.catalog?.configuredProjects}
            expectedManifestRevision={props.catalog?.manifestRevision}
            onAction={props.onAdministrationAction ?? (() => undefined)}
            onDiagnostics={props.onDiagnostics ?? (() => undefined)}
            output={props.administrationOutput}
            report={props.administration}
            reconciliation={
              props.catalog?.reconciliation ?? (props.catalog?.lifecyclePending ? {state: 'unavailable'} : undefined)
            }
          />
          {props.catalog?.automaticCompaction ? (
            <GraphAutomaticCompactionProgress repositories={repositories} status={props.catalog.automaticCompaction} />
          ) : null}
          {props.catalog?.maintenance ? (
            <GraphMaintenanceProgress repositories={repositories} status={props.catalog.maintenance} />
          ) : null}
          {administrationJobs.jobs.length > 0 ? (
            <div className="graph-build-status" aria-live="polite">
              {administrationJobs.jobs.map(build => (
                <GraphBuildProgress
                  build={build}
                  configuredProjects={props.catalog?.configuredProjects}
                  key={`${build.identity.checkoutId}:${build.identity.worktreeId}:${build.buildId}`}
                  repositories={repositories}
                  storage={props.catalog?.storage?.[build.identity.checkoutId]}
                  waiters={props.catalog?.waiters ?? []}
                />
              ))}
              {administrationJobs.hiddenCount > 0 ? (
                <p className="graph-build-hidden">
                  {administrationJobs.hiddenCount.toLocaleString()} older build{' '}
                  {administrationJobs.hiddenCount === 1 ? 'notice is' : 'notices are'} summarized.
                </p>
              ) : null}
            </div>
          ) : null}

          {props.catalog?.diagnostics.length ? (
            <div className="graph-catalog-diagnostics" role="status">
              <strong>Some indexed views need attention</strong>
              {props.catalog.diagnostics.map(diagnostic => (
                <span key={`${diagnostic.checkoutId}:${diagnostic.code}`}>{diagnostic.message}</span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div
        aria-labelledby="graph-explore-tab"
        className="graph-tab-panel graph-explorer-tab"
        hidden={activeTab !== 'explore'}
        id="graph-explore-panel"
        role="tabpanel"
        tabIndex={0}
      >
        <div className="graph-toolbar" hidden={repositories.length === 0}>
          <div className="graph-toolbar-scope">
            <label>
              <span>Repository</span>
              <select
                aria-label="Repository"
                disabled={repositories.length === 0}
                onChange={event => chooseRepository(event.target.value)}
                value={repositoryGroup?.id ?? ''}
              >
                {repositories.map(item => (
                  <option key={item.id} value={item.id}>
                    {graphRepositoryScopeLabel(
                      graphRepositoryOptionLabel(item, repositories),
                      graphRepositoryGroupScopeId(item),
                      props.catalog?.configuredProjects,
                    )}
                  </option>
                ))}
              </select>
            </label>
            {repositoryGroup && (repositoryGroup.views.length > 1 || viewCatalogHasMore) ? (
              <label>
                <span>Indexed view</span>
                <select
                  aria-label="Indexed view"
                  onChange={event => chooseView(event.target.value)}
                  value={repository?.id ?? ''}
                >
                  {repositoryGroup.views.map(view => (
                    <option key={view.id} value={view.id}>
                      {graphRepositoryScopeLabel(view.displayName, view.scopeId, props.catalog?.configuredProjects)} ·{' '}
                      {view.label}
                      {view.localAssociation.branch ? ` · observed branch ${view.localAssociation.branch}` : ''} ·
                      folder {graphLocalAssociationText(view.localAssociation)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              <span>Component</span>
              <select
                aria-label="Component"
                disabled={!repository}
                onChange={event => chooseProject(event.target.value)}
                value={projectId}
              >
                <option value="all">All components</option>
                {(repository?.workspaces ?? []).map(workspace => {
                  const projects = repository?.projects.filter(project => project.workspaceId === workspace.id) ?? [];
                  return projects.length > 0 ? (
                    <optgroup
                      key={workspace.id}
                      label={`${workspace.name} · ${workspace.buildSystem} · ${workspace.root || 'repository root'}`}
                    >
                      {projects.map(project => (
                        <option key={project.id} value={project.id}>
                          {project.label} · {graphProjectBadge(project)} ·{' '}
                          {repository?.metrics === 'deferred'
                            ? 'count on demand'
                            : compactNumber(project.symbolCount ?? 0)}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
                {(repository?.projects ?? [])
                  .filter(
                    project =>
                      !project.workspaceId ||
                      !repository?.workspaces.some(workspace => workspace.id === project.workspaceId),
                  )
                  .map(project => (
                    <option key={project.id} value={project.id}>
                      {project.label} · {graphProjectBadge(project)} ·{' '}
                      {repository?.metrics === 'deferred' ? 'count on demand' : compactNumber(project.symbolCount ?? 0)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="graph-control graph-search graph-node-search">
            <label htmlFor="graph-current-view-search">Find in current view</label>
            <input
              id="graph-current-view-search"
              disabled={!graph}
              onChange={event => setSearch(event.target.value)}
              placeholder={graph?.mode === 'overview' ? 'Search components' : 'Name, path, or symbol'}
              type="search"
              value={search}
            />
            {search.trim() ? (
              <div className="graph-search-results">
                {searchResults.length > 0 ? (
                  searchResults.map(node => (
                    <button
                      key={node.id}
                      onClick={() => {
                        selectNode(node.id, true);
                        setSearch('');
                      }}
                      type="button"
                    >
                      <strong>{node.label}</strong>
                      <span>{node.path ?? node.kind}</span>
                    </button>
                  ))
                ) : (
                  <p>No matching nodes</p>
                )}
              </div>
            ) : null}
          </div>
          <div className="graph-stats" aria-label="Graph rendering status">
            <span>{graph ? compactNumber(graph.stats.renderedNodes) : '—'} nodes</span>
            <span>{graph ? compactNumber(graph.stats.renderedEdges) : '—'} links</span>
            {graph?.paging.hasMore ? (
              <button
                disabled={(activeQuery ? queryLoading : loading) || workingSetAtMaximum}
                onClick={() => {
                  if (activeQuery) {
                    setQueryWorkingSet(current => ({
                      edgeLimit: Math.min(MAX_QUERY_WORKING_SET.edgeLimit, current.edgeLimit * 2),
                      nodeLimit: Math.min(MAX_QUERY_WORKING_SET.nodeLimit, current.nodeLimit * 2),
                    }));
                  } else {
                    setWorkingSet(current => ({
                      edgeLimit: Math.min(MAX_WORKING_SET.edgeLimit, current.edgeLimit * 2),
                      nodeLimit: Math.min(MAX_WORKING_SET.nodeLimit, current.nodeLimit * 2),
                    }));
                  }
                }}
                type="button"
              >
                {(activeQuery ? queryLoading : loading)
                  ? 'Expanding…'
                  : workingSetAtMaximum
                    ? activeQuery
                      ? 'Query capped'
                      : 'View capped'
                    : activeQuery
                      ? 'Expand results'
                      : 'Expand view'}
              </button>
            ) : null}
          </div>
        </div>
        <div className="graph-advanced-slot" hidden={repositories.length === 0}>
          <details className="graph-advanced">
            <summary>Search and relationship filters</summary>
            <div className="graph-advanced-content">
              <div className="graph-control graph-catalog-continuation">
                <label htmlFor="graph-catalog-search">Find component or indexed view</label>
                <div className="graph-control-actions">
                  <input
                    aria-describedby="graph-catalog-search-status"
                    disabled={!repository || catalogLoading}
                    id="graph-catalog-search"
                    maxLength={256}
                    onChange={event => {
                      setCatalogQuery(event.target.value);
                      setCatalogSearchResult(undefined);
                      setCatalogError('');
                    }}
                    onKeyDown={event => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      loadCatalogContinuation(catalogQuery);
                    }}
                    placeholder="Component, workspace, commit, or view"
                    type="search"
                    value={catalogQuery}
                  />
                  <button
                    disabled={!repository || catalogLoading || catalogQuery.trim().length === 0}
                    onClick={() => loadCatalogContinuation(catalogQuery)}
                    type="button"
                  >
                    {catalogLoading && catalogQuery.trim().length > 0 ? 'Searching…' : 'Find options'}
                  </button>
                </div>
                {projectCatalogHasMore || workspaceCatalogHasMore || viewCatalogHasMore ? (
                  <button
                    className="quiet-button"
                    disabled={!repository || catalogLoading}
                    onClick={() => loadCatalogContinuation('')}
                    type="button"
                  >
                    {catalogLoading && catalogQuery.trim().length === 0 ? 'Loading…' : 'Load more options'}
                  </button>
                ) : null}
                {catalogError ? <small role="alert">{catalogError}</small> : null}
                {catalogSearchResult ? (
                  <div
                    className="graph-search-results graph-catalog-results"
                    id="graph-catalog-search-status"
                    role="status"
                  >
                    {catalogSearchResult.options.projects.length + catalogSearchResult.options.views.length > 0 ? (
                      <>
                        <p>
                          Found{' '}
                          {(
                            catalogSearchResult.options.projects.length + catalogSearchResult.options.views.length
                          ).toLocaleString()}{' '}
                          options for “{catalogSearchResult.query}”
                        </p>
                        {catalogSearchResult.options.projects.length > 0 ? (
                          <div className="graph-catalog-result-group">
                            <span>Components and workspace matches</span>
                            {catalogSearchResult.options.projects.map(option => (
                              <button
                                key={`${option.viewId}:${option.id}`}
                                onClick={() => chooseProject(option.id)}
                                type="button"
                              >
                                <strong>{option.label}</strong>
                                <span>{option.description}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {catalogSearchResult.options.views.length > 0 ? (
                          <div className="graph-catalog-result-group">
                            <span>Indexed views</span>
                            {catalogSearchResult.options.views.map(option => (
                              <button
                                key={`${option.repositoryId}:${option.id}`}
                                onClick={() => chooseCatalogView(option.repositoryId, option.id)}
                                type="button"
                              >
                                <strong>{option.label}</strong>
                                <span>{option.description}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p>No catalog matches for “{catalogSearchResult.query}”</p>
                    )}
                  </div>
                ) : (
                  <span className="sr-only" id="graph-catalog-search-status">
                    Search results appear here.
                  </span>
                )}
              </div>
              <div className="graph-control graph-search graph-code-query">
                <label htmlFor="graph-code-query">Query the code graph</label>
                <div className="graph-control-actions">
                  <input
                    disabled={!repository}
                    id="graph-code-query"
                    maxLength={GRAPH_QUERY_MAXIMUM_LENGTH}
                    onChange={event => setQueryInput(event.target.value)}
                    onKeyDown={event => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      submitCodeQuery();
                    }}
                    placeholder="Concept, path, module, or symbol"
                    type="search"
                    value={queryInput}
                  />
                  <button
                    disabled={!repository || managerGraphQueryCandidate(queryInput) === undefined || queryLoading}
                    onClick={submitCodeQuery}
                    type="button"
                  >
                    {queryLoading ? 'Searching…' : 'Query graph'}
                  </button>
                </div>
                {activeQuery ? (
                  <button className="quiet-button" onClick={clearCodeQuery} type="button">
                    Back to {projectId === 'all' ? 'overview' : 'component'}
                  </button>
                ) : null}
                {!activeQuery && queryError ? <small role="alert">{queryError}</small> : null}
              </div>
              {graph ? (
                <div className="graph-filterbar">
                  <label>
                    <span>Relationship</span>
                    <select
                      aria-label="Filter relationships"
                      onChange={event => setRelationFilter(event.target.value)}
                      value={relationFilter}
                    >
                      <option value="all">All relationships</option>
                      {relations.map(relation => (
                        <option key={relation} value={relation}>
                          {relationLabel(relation)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {graph.mode === 'detail' ? (
                    <label>
                      <span>Node size</span>
                      <select
                        aria-label="Node size metric"
                        onChange={event => {
                          const metric = event.target.value;
                          if (isGraphSizeMetric(metric)) setSizeMetric(metric);
                        }}
                        value={sizeMetric}
                      >
                        <option value="connections">Connections</option>
                        <option value="incoming">Incoming</option>
                        <option value="outgoing">Outgoing</option>
                      </select>
                    </label>
                  ) : (
                    <div className="graph-size-readout">
                      <span>Node size</span>
                      <strong>{graphOverviewSizeLabel(graph)}</strong>
                    </div>
                  )}
                  <div className="graph-focus-control">
                    <span>Selection focus</span>
                    <div className="segmented-control" aria-label="Selection focus">
                      {(
                        [
                          ['all', 'All'],
                          ['neighbors', 'Neighbors'],
                          ['incoming', 'Incoming'],
                          ['outgoing', 'Outgoing'],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          aria-pressed={focusMode === mode}
                          disabled={!selectedNode}
                          key={mode}
                          onClick={() => setFocusMode(mode)}
                          type="button"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {selectedNode ? (
                    <button className="graph-clear-selection" onClick={() => selectNode(undefined)} type="button">
                      Clear selection
                    </button>
                  ) : (
                    <p>Select a node to isolate its neighborhood and direction.</p>
                  )}
                </div>
              ) : null}
            </div>
          </details>
        </div>
        <div className={`graph-body${repository ? '' : ' is-empty'}`}>
          <section className="graph-stage">
            {!props.catalog && props.catalogError ? (
              <div className="graph-empty" role="status">
                <span className="empty-orbit" aria-hidden="true" />
                <h3>Indexed repositories unavailable</h3>
                <p>{props.catalogError}</p>
                <button onClick={props.onRefresh} type="button">
                  Try again
                </button>
              </div>
            ) : !props.catalog ? (
              <div aria-live="polite" className="graph-loading" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>Loading indexed repositories…</span>
              </div>
            ) : repositories.length === 0 ? (
              <GraphEmptyState
                configuredProjectCount={props.catalog.configuredProjects?.length ?? 0}
                onOpenAdministration={() => setActiveTab('administration')}
                state={emptyState}
              />
            ) : activeQuery && selectedRepositoryIsIndexing && !queryGraph ? (
              <div aria-live="polite" className="graph-loading" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>
                  Code graph indexing is in progress. Search will use the pinned ready snapshot when available.
                </span>
              </div>
            ) : activeQuery && queryError ? (
              <div className="graph-empty" role="status">
                <span className="empty-orbit" aria-hidden="true" />
                <h3>Code search unavailable</h3>
                <p>{queryError}</p>
                <button onClick={submitCodeQuery} type="button">
                  Try query again
                </button>
                <button className="quiet-button" onClick={clearCodeQuery} type="button">
                  Return to graph
                </button>
              </div>
            ) : !activeQuery && error ? (
              <div className="graph-empty">
                <span className="empty-orbit" aria-hidden="true" />
                <h3>Graph unavailable</h3>
                <p>{error}</p>
                <button onClick={props.onRefresh} type="button">
                  Try again
                </button>
              </div>
            ) : (activeQuery ? queryLoading : loading) || !graph ? (
              <div aria-live="polite" className="graph-loading" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>{activeQuery ? `Searching for “${activeQuery}”…` : 'Preparing a bounded graph view…'}</span>
              </div>
            ) : activeQuery && (graph.query?.matchedNodes === 0 || graph.nodes.length === 0) ? (
              <div className="graph-empty" role="status">
                <span className="empty-orbit" aria-hidden="true" />
                <h3>No code graph matches</h3>
                <p>
                  No concept, path, module, or symbol was returned for “{activeQuery}” by this bounded snapshot search.
                  Review any partial-result warning below or refine the query.
                </p>
                <button className="quiet-button" onClick={clearCodeQuery} type="button">
                  Return to graph
                </button>
              </div>
            ) : (
              <ThreeGraph
                graph={graph}
                focusMode={focusMode}
                key={`${graph.repository.id}:${graph.repository.snapshot.id}:${graph.projectId}:${graph.query?.text ?? ''}`}
                onOpenProject={chooseProject}
                onSelectNode={nodeId => selectNode(nodeId, Boolean(nodeId))}
                relationFilter={relationFilter}
                sizeMetric={sizeMetric}
                focusRequest={focusRequest}
                selectedNodeId={selectedNodeId}
              />
            )}
          </section>

          <aside className="graph-inspector" hidden={!repository}>
            {selectedNode ? (
              <NodeInspector
                graph={graph!}
                detail={nodeDetail}
                detailError={nodeDetailError}
                detailLoading={nodeDetailLoading}
                node={selectedNode}
                onOpenProject={() => chooseProject(selectedNode.projectId)}
                onSelectNode={nodeId => selectNode(nodeId, true)}
              />
            ) : graph ? (
              <GraphSummary
                analysis={analysis}
                analysisError={analysisError}
                analysisLoading={analysisLoading}
                graph={graph}
                onAnalyze={loadAnalysis}
                sizeMetric={sizeMetric}
              />
            ) : (
              <div className="inspector-placeholder">
                <span className="inspector-dot" />
                <p>Select a node to inspect its role, source location, and relationships.</p>
              </div>
            )}
          </aside>
        </div>

        {graph && [...new Set([...graph.warnings, ...(graph.query?.warnings ?? [])])].length ? (
          <footer className="graph-notes">
            {[...new Set([...graph.warnings, ...(graph.query?.warnings ?? [])])].map(warning => (
              <span key={warning}>{warning}</span>
            ))}
          </footer>
        ) : null}
      </div>
    </section>
  );
}

function isGraphSizeMetric(value: string): value is GraphSizeMetric {
  return value === 'connections' || value === 'incoming' || value === 'outgoing';
}
