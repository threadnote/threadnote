import React, {useEffect, useState} from 'react';
import type {CodeGraphAutomaticCompactionStatus} from '@threadnote/graph/automatic/compaction';
import type {CodeGraphLocalDiagnosticsReport} from '@threadnote/graph/diagnostics';
import type {CodeGraphMaintenanceStatus} from '@threadnote/graph/maintenance/gate';
import {
  CODE_GRAPH_SLOW_FILE_THRESHOLD_MILLISECONDS,
  CODE_GRAPH_TOP_SLOW_FILE_LIMIT,
} from '@threadnote/graph/progress/telemetry';
import {
  compactNumber,
  graphAdministrationInventorySummary,
  graphAdministrationJobSelection,
  graphAdministrationJobView,
  graphAdministrationTarget,
  graphAnalysisCoverageLabel,
  graphAnalysisTopologyAvailable,
  graphBuildConcurrencyState,
  graphBuildTarget,
  graphLocalAssociationText,
  graphMaintenanceRemainingMilliseconds,
  graphMaintenanceStatusLabel,
  graphRelationshipCountLabel,
  graphRelationshipSampleLabel,
  graphRepositoryScopeLabel,
  graphViewRemovalTarget,
  graphWaiterCountForBuild,
  GRAPH_PALETTE,
  relationLabel,
  SELECTED_NODE_COLOR,
  shortGraphIdentity,
  sizeMetricLabel,
  sourceBreadcrumb,
  type GraphAdministrationAction,
  type GraphAnalysis,
  type GraphBuildStatus,
  type GraphConfiguredProject,
  type GraphEdge,
  type GraphMaterializationRows,
  type GraphMaterializationStage,
  type GraphMaterializationStorage,
  type GraphNode,
  type GraphNodeDetail,
  type GraphRepositoryGroup,
  type GraphSizeMetric,
  type GraphStorageSummary,
  type GraphVisualization,
  type GraphWorktreeAdministrationAction,
} from './model.js';
import {type ManagerDialogOptions, useOptionalManagerDialogs} from '@threadnote/manager/dialog';
import {GraphReconciliationProgress} from './reconciliation.js';
import type {ManagerGraphReconciliationStatus} from '@threadnote/graph/manager/status';
export {GraphReconciliationProgress};

export function GraphSummary(props: {
  readonly analysis?: GraphAnalysis;
  readonly analysisError: string;
  readonly analysisLoading: boolean;
  readonly graph: GraphVisualization;
  readonly onAnalyze: () => void;
  readonly sizeMetric: GraphSizeMetric;
}): React.ReactElement {
  const partialTopology = props.analysis?.coverage.topology.state === 'partial';
  return (
    <div className="graph-summary">
      <p className="eyebrow">{props.graph.mode === 'overview' ? 'Repository overview' : 'Component working set'}</p>
      <h3>{props.graph.scope.label}</h3>
      <p>
        {props.graph.mode === 'overview'
          ? props.graph.repository.metrics === 'complete'
            ? 'Node size reflects indexed symbol volume. Double-click a component to explore its symbol graph.'
            : 'Node size reflects visible relationship degree. Double-click a component to explore its symbol graph.'
          : `Node size reflects ${sizeMetricLabel(props.sizeMetric).toLowerCase()} among the filtered relationships.`}
      </p>
      <dl className="metric-list">
        <div>
          <dt>Indexed symbols</dt>
          <dd>{compactNumber(props.graph.stats.totalNodes)}</dd>
        </div>
        <div>
          <dt>Visible nodes</dt>
          <dd>{compactNumber(props.graph.stats.renderedNodes)}</dd>
        </div>
        <div>
          <dt>Visible links</dt>
          <dd>{compactNumber(props.graph.stats.renderedEdges)}</dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>
            {props.graph.repository.snapshot.commit.slice(0, 8)}
            {props.graph.repository.snapshot.dirty ? ' + dirty' : ''}
          </dd>
        </div>
        {props.graph.mode === 'overview' ? (
          <div>
            <dt>Overview coverage</dt>
            <dd>
              {props.graph.repository.metrics === 'deferred'
                ? 'Computed on demand'
                : `${compactNumber(props.graph.repository.accounting.attributedSymbols)} / ${compactNumber(
                    props.graph.repository.accounting.totalSymbols,
                  )}`}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="graph-legend">
        <span>
          <i style={{background: GRAPH_PALETTE[0]}} /> Component or facet
        </span>
        <span>
          <i style={{background: SELECTED_NODE_COLOR}} /> Selected node
        </span>
        <span>
          <i className="legend-size" /> Size ·{' '}
          {props.graph.mode === 'overview'
            ? props.graph.repository.metrics === 'complete'
              ? 'Component symbols'
              : 'Visible relationships'
            : sizeMetricLabel(props.sizeMetric)}
        </span>
      </div>
      <section className="graph-analysis-summary">
        <header>
          <div>
            <p className="eyebrow">{partialTopology ? 'Bounded graph analysis' : 'Whole-graph analysis'}</p>
            <h4>Architecture signals</h4>
          </div>
          <button className="quiet-button" disabled={props.analysisLoading} onClick={props.onAnalyze} type="button">
            {props.analysisLoading ? 'Analyzing…' : props.analysis ? 'Refresh' : 'Analyze'}
          </button>
        </header>
        {props.analysis ? (
          <>
            <dl className="metric-list graph-analysis-metrics">
              <div>
                <dt>{partialTopology ? 'Observed communities' : 'Communities'}</dt>
                <dd>
                  {graphAnalysisTopologyAvailable(props.analysis)
                    ? compactNumber(props.analysis.statistics.communityCount)
                    : 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>{partialTopology ? 'Observed components' : 'Components'}</dt>
                <dd>
                  {graphAnalysisTopologyAvailable(props.analysis)
                    ? compactNumber(props.analysis.statistics.connectedComponentCount)
                    : 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>{partialTopology ? 'Observed hubs' : 'Hubs'}</dt>
                <dd>
                  {graphAnalysisTopologyAvailable(props.analysis)
                    ? compactNumber(props.analysis.hubs.length)
                    : 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>Coverage</dt>
                <dd>{graphAnalysisCoverageLabel(props.analysis)}</dd>
              </div>
            </dl>
            {props.analysis.hubs.length > 0 ? (
              <div className="graph-analysis-list">
                <h5>{partialTopology ? 'Highest observed-connectivity nodes' : 'Highest-connectivity nodes'}</h5>
                {props.analysis.hubs.slice(0, 4).map(hub => (
                  <div key={`${hub.node.path}:${hub.node.label}`}>
                    <span>
                      <strong>{hub.node.label}</strong>
                      <small>{hub.node.path}</small>
                    </span>
                    <em>
                      {hub.classification === 'god-node' ? 'God node' : 'Hub'} · {hub.degree}
                    </em>
                  </div>
                ))}
              </div>
            ) : graphAnalysisTopologyAvailable(props.analysis) ? null : (
              <p>Topology was not derived, so community, component, and hub absence is not inferred.</p>
            )}
            {props.analysis.surprisingLinks[0] ? (
              <p className="graph-analysis-surprise">
                <strong>Cross-community signal:</strong> {props.analysis.surprisingLinks[0].source.label}{' '}
                {relationLabel(props.analysis.surprisingLinks[0].relation)}{' '}
                {props.analysis.surprisingLinks[0].target.label}
              </p>
            ) : null}
            {props.analysis.warnings.length > 0 ? <p>{props.analysis.warnings[0]}</p> : null}
          </>
        ) : props.analysisError ? (
          <p className="graph-analysis-error">{props.analysisError}</p>
        ) : (
          <p>Run deterministic communities, hub, and cross-boundary analysis on demand.</p>
        )}
      </section>
    </div>
  );
}

export function NodeInspector(props: {
  readonly detail?: GraphNodeDetail;
  readonly detailError: string;
  readonly detailLoading: boolean;
  readonly graph: GraphVisualization;
  readonly node: GraphNode;
  readonly onOpenProject: () => void;
  readonly onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  const [tab, setTab] = useState<'evidence' | 'overview' | 'relationships'>('overview');
  useEffect(() => setTab('overview'), [props.node.id]);
  const connected = props.graph.edges.filter(
    edge => edge.sourceId === props.node.id || edge.targetId === props.node.id,
  );
  const nodesById = new Map(props.graph.nodes.map(node => [node.id, node]));
  const localRelated = connected
    .slice()
    .sort((left, right) => right.count - left.count || right.confidence - left.confidence)
    .slice(0, 7)
    .map(edge => {
      const id = edge.sourceId === props.node.id ? edge.targetId : edge.sourceId;
      return {edge, node: nodesById.get(id)};
    })
    .filter((item): item is {readonly edge: GraphEdge; readonly node: GraphNode} => item.node !== undefined);
  const visibleNodeIds = new Set(props.graph.nodes.map(node => node.id));
  const detail = props.detail?.node.id === props.node.id ? props.detail : undefined;
  const sourceLocation = detail
    ? `${detail.node.path}:${detail.node.span.line}:${detail.node.span.column}`
    : props.node.path;
  const breadcrumb = detail ? sourceBreadcrumb(detail.node.projectId, detail.node.path) : [];
  const relationshipCountsSampled = detail?.stats.summaryTruncated === true;
  const relationshipSampleLabel = detail ? graphRelationshipSampleLabel(detail) : undefined;
  return (
    <div className="node-inspector">
      <header className="node-inspector-header">
        <div className="node-kind-row">
          <span>{props.node.kind}</span>
          {props.node.exported ? <span>exported</span> : null}
          {props.node.projectId !== props.graph.projectId && props.graph.mode === 'detail' ? (
            <span>context</span>
          ) : null}
        </div>
        <h3>{props.node.label}</h3>
        <p className="node-qualified">{props.node.qualifiedName ?? props.node.projectId.replace(/^[^:]+:/, '')}</p>
        {breadcrumb.length > 0 ? (
          <div className="source-breadcrumb" aria-label="Source breadcrumb">
            {breadcrumb.map((part, index) => (
              <React.Fragment key={`${part}-${index}`}>
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                <strong>{part}</strong>
              </React.Fragment>
            ))}
          </div>
        ) : null}
      </header>
      {props.node.type === 'project' ? (
        <button className="primary-button" onClick={props.onOpenProject} type="button">
          Explore component
        </button>
      ) : (
        <div className="inspector-tabs" role="tablist" aria-label="Node details">
          {(
            [
              ['overview', 'Overview'],
              ['relationships', 'Relations'],
              ['evidence', 'Evidence'],
            ] as const
          ).map(([value, label]) => (
            <button aria-selected={tab === value} key={value} onClick={() => setTab(value)} role="tab" type="button">
              {label}
            </button>
          ))}
        </div>
      )}

      {props.detailLoading ? (
        <div className="node-detail-status" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading indexed details…
        </div>
      ) : null}
      {props.detailError ? (
        <div className="node-detail-error" role="alert">
          Detailed evidence unavailable: {props.detailError}
        </div>
      ) : null}

      {props.node.type === 'project' || tab === 'overview' ? (
        <>
          {detail?.node.documentation ? <p className="node-documentation">{detail.node.documentation}</p> : null}
          <dl className="node-details">
            {sourceLocation ? (
              <>
                <dt>Source</dt>
                <dd className="source-location">{sourceLocation}</dd>
              </>
            ) : null}
            {props.node.language ? (
              <>
                <dt>Language</dt>
                <dd>{props.node.language}</dd>
              </>
            ) : null}
            {detail?.node.packageName ? (
              <>
                <dt>Package</dt>
                <dd>{detail.node.packageName}</dd>
              </>
            ) : null}
            <dt>{detail ? 'Fan-in' : 'Visible degree'}</dt>
            <dd>
              {detail
                ? graphRelationshipCountLabel(detail.stats.incoming, relationshipCountsSampled)
                : props.node.degree.toLocaleString()}
            </dd>
            {detail ? (
              <>
                <dt>Fan-out</dt>
                <dd>{graphRelationshipCountLabel(detail.stats.outgoing, relationshipCountsSampled)}</dd>
              </>
            ) : null}
            {props.node.symbolCount !== undefined ? (
              <>
                <dt>Symbols</dt>
                <dd>{props.node.symbolCount.toLocaleString()}</dd>
                <dt>Files</dt>
                <dd>{props.node.fileCount?.toLocaleString()}</dd>
              </>
            ) : null}
          </dl>
          {detail?.stats.provenances.length ? (
            <div className="provenance-strip" aria-label="Relationship provenance">
              {detail.stats.provenances.map(item => (
                <span key={item.provenance}>
                  {item.provenance}{' '}
                  <strong>{graphRelationshipCountLabel(item.count, relationshipCountsSampled)}</strong>
                </span>
              ))}
            </div>
          ) : null}
          {relationshipSampleLabel ? <p className="detail-truncation">{relationshipSampleLabel}</p> : null}
          {(detail?.node.signature ?? props.node.signature) ? (
            <pre className="node-signature">{detail?.node.signature ?? props.node.signature}</pre>
          ) : null}
          {props.node.type === 'project' && localRelated.length ? (
            <div className="related-list">
              <h4>Strongest visible links</h4>
              {localRelated.map(({edge, node}) => (
                <button key={edge.id} onClick={() => props.onSelectNode(node.id)} type="button">
                  <span>{node.label}</span>
                  <small>
                    {relationLabel(edge.relation)} ·{' '}
                    {edge.count > 1 ? `${edge.count} links` : `${Math.round(edge.confidence * 100)}%`}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {props.node.type === 'symbol' && tab === 'relationships' ? (
        detail ? (
          <div className="relationship-view">
            <div className="relationship-totals">
              <span>
                <strong>{graphRelationshipCountLabel(detail.stats.incoming, relationshipCountsSampled)}</strong>{' '}
                incoming
              </span>
              <span>
                <strong>{graphRelationshipCountLabel(detail.stats.outgoing, relationshipCountsSampled)}</strong>{' '}
                outgoing
              </span>
            </div>
            <div className="relation-breakdown">
              {detail.stats.relations.map(item => {
                const maximum = detail.stats.relations[0]?.count ?? 1;
                return (
                  <div key={item.relation}>
                    <span>
                      <strong>{relationLabel(item.relation)}</strong>
                      <small>
                        {graphRelationshipCountLabel(item.incoming, relationshipCountsSampled)} in ·{' '}
                        {graphRelationshipCountLabel(item.outgoing, relationshipCountsSampled)} out
                      </small>
                    </span>
                    <i style={{width: `${Math.max(4, (item.count / maximum) * 100)}%`}} />
                  </div>
                );
              })}
            </div>
            {relationshipSampleLabel ? <p className="detail-truncation">{relationshipSampleLabel}</p> : null}
            <div className="related-list relationship-list">
              <h4>Direct neighborhood</h4>
              {detail.relationships.slice(0, 32).map(relationship => {
                const canSelect = Boolean(relationship.related.id && visibleNodeIds.has(relationship.related.id));
                return (
                  <button
                    disabled={!canSelect}
                    key={relationship.id}
                    onClick={() => {
                      if (relationship.related.id) props.onSelectNode(relationship.related.id);
                    }}
                    type="button"
                  >
                    <span>
                      <i aria-hidden="true">{relationship.direction === 'incoming' ? '←' : '→'}</i>{' '}
                      {relationship.related.label}
                    </span>
                    <small>
                      {relationLabel(relationship.relation)} · {relationship.provenance} ·{' '}
                      {Math.round(relationship.confidence * 100)}%
                      {!canSelect ? (relationship.related.id ? ' · unavailable' : ' · reference only') : ''}
                    </small>
                  </button>
                );
              })}
            </div>
            {detail.stats.truncated ? (
              <p className="detail-truncation">Showing the strongest 160 relationships from this node.</p>
            ) : null}
          </div>
        ) : (
          <p className="node-tab-empty">Relationship details are not available.</p>
        )
      ) : null}

      {props.node.type === 'symbol' && tab === 'evidence' ? (
        detail?.relationships.length ? (
          <div className="evidence-list">
            {detail.relationships.slice(0, 32).map(relationship => (
              <article key={relationship.id}>
                <header>
                  <span>{relationLabel(relationship.relation)}</span>
                  <strong>{Math.round(relationship.confidence * 100)}%</strong>
                </header>
                <p>
                  {relationship.direction === 'incoming' ? 'From' : 'To'}{' '}
                  {relationship.related.qualifiedName ?? relationship.related.label}
                </p>
                <code>
                  {relationship.evidencePath}:{relationship.evidenceSpan.line}:{relationship.evidenceSpan.column}
                </code>
                <footer>
                  <span>{relationship.provenance}</span>
                  <span>
                    lines {relationship.evidenceSpan.line}–{relationship.evidenceSpan.endLine}
                  </span>
                </footer>
              </article>
            ))}
            {detail.stats.truncated ? (
              <p className="detail-truncation">
                Evidence is capped at 160 relationships to keep inspection responsive.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="node-tab-empty">No relationship evidence is indexed for this node.</p>
        )
      ) : null}
    </div>
  );
}

export function GraphAdministration(props: {
  readonly busy?: string;
  readonly configuredProjects?: readonly GraphConfiguredProject[];
  readonly expectedManifestRevision?: string;
  readonly onAction: (action: GraphAdministrationAction) => void;
  readonly onDiagnostics: (options: {readonly analyze: boolean; readonly deep: boolean}) => void;
  readonly output?: string;
  readonly report?: CodeGraphLocalDiagnosticsReport;
  readonly reconciliation?: ManagerGraphReconciliationStatus;
}): React.ReactElement {
  const dialogs = useOptionalManagerDialogs();
  const [analyze, setAnalyze] = useState(false);
  const [deep, setDeep] = useState(false);
  const [forceCompact, setForceCompact] = useState(false);
  const [selectedProjectName, setSelectedProjectName] = useState('');
  const blocked = props.busy !== undefined;
  const selectedProject =
    props.configuredProjects?.find(project => project.name === selectedProjectName) ?? props.configuredProjects?.[0];
  const confirmAction = async (options: ManagerDialogOptions, action: GraphAdministrationAction): Promise<void> => {
    if (await dialogs.confirm(options)) props.onAction(action);
  };
  const targetAction = async (
    managementAvailable: boolean,
    action: GraphWorktreeAdministrationAction,
  ): Promise<GraphWorktreeAdministrationAction | undefined> => {
    if (managementAvailable) return action;
    const values = await dialogs.prompt({
      confirmLabel: 'Use worktree',
      detail: 'The local folder is not currently associated with this indexed view.',
      fields: [
        {
          description: 'Threadnote verifies this path against the indexed checkout and worktree before acting.',
          id: 'cwd',
          label: 'Absolute worktree path',
          placeholder: '/absolute/path/to/worktree',
          required: true,
        },
      ],
      message: 'Threadnote has no current local path for this indexed view.',
      title: 'Locate the indexed worktree',
    });
    return values ? {...action, cwd: values.cwd} : undefined;
  };
  const dispatchTargetAction = async (
    managementAvailable: boolean,
    action: GraphWorktreeAdministrationAction,
    confirmation?: ManagerDialogOptions,
  ): Promise<void> => {
    const targeted = await targetAction(managementAvailable, action);
    if (!targeted) return;
    if (confirmation && !(await dialogs.confirm(confirmation))) return;
    props.onAction(targeted);
  };
  return (
    <details className="graph-administration" open>
      <summary>
        <span className="graph-administration-title">
          <strong>Graph administration</strong>
          <small>
            {props.report
              ? graphAdministrationInventorySummary(props.report.summary)
              : 'Load home-wide status, diagnostics, and maintenance controls'}
          </small>
        </span>
        <span className="graph-administration-summary-state">
          {props.busy ? <em>{props.busy}…</em> : null}
          <svg aria-hidden="true" className="graph-administration-caret" viewBox="0 0 16 16">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </span>
      </summary>
      <div className="graph-administration-body">
        {props.reconciliation ? <GraphReconciliationProgress status={props.reconciliation} /> : null}
        {props.configuredProjects === undefined ? null : (
          <section className="graph-configured-project-index">
            <header>
              <strong>Configured projects</strong>
              <small>Initialize a missing graph, or refresh an existing ready snapshot, from this Manager.</small>
            </header>
            <div className="graph-configured-project-controls">
              <label>
                <span>Project</span>
                <select
                  disabled={blocked || props.configuredProjects.length === 0}
                  onChange={event => setSelectedProjectName(event.target.value)}
                  value={selectedProject?.name ?? ''}
                >
                  {props.configuredProjects.length === 0 ? (
                    <option value="">No configured projects</option>
                  ) : (
                    props.configuredProjects.map(project => (
                      <option key={project.name} value={project.name}>
                        {project.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <span className="graph-configured-project-detail" title={selectedProject?.path}>
                {selectedProject
                  ? `${graphConfiguredProjectStateDetail(selectedProject.graphState)} · ${selectedProject.path}`
                  : 'Add a project to the seed manifest before indexing from Manager.'}
              </span>
              <button
                disabled={blocked || !selectedProject || !props.expectedManifestRevision}
                onClick={() => {
                  if (!selectedProject || !props.expectedManifestRevision) return;
                  props.onAction({
                    action: 'index-project',
                    expectedRevision: props.expectedManifestRevision,
                    project: selectedProject.name,
                  });
                }}
                type="button"
              >
                {selectedProject?.graphState === 'ready'
                  ? 'Refresh graph'
                  : selectedProject?.graphState === 'unknown'
                    ? 'Index / refresh graph'
                    : 'Index graph'}
              </button>
            </div>
          </section>
        )}
        <div className="graph-administration-toolbar">
          <label className="check-row">
            <input
              checked={analyze}
              disabled={blocked}
              onChange={event => setAnalyze(event.target.checked)}
              type="checkbox"
            />
            <span>Structural stats</span>
          </label>
          <label className="check-row">
            <input
              checked={deep}
              disabled={blocked}
              onChange={event => setDeep(event.target.checked)}
              type="checkbox"
            />
            <span>Deep SQLite checks</span>
          </label>
          <button disabled={blocked} onClick={() => props.onDiagnostics({analyze, deep})} type="button">
            Diagnose all
          </button>
          <button
            disabled={blocked}
            onClick={() => props.onAction({action: 'repair', deep, dryRun: true})}
            type="button"
          >
            Preview repair
          </button>
          <button
            disabled={blocked}
            onClick={() =>
              void confirmAction(
                {
                  confirmLabel: deep ? 'Run deep repair' : 'Run repair',
                  message: deep
                    ? 'Deep repair may discard corrupt disposable graph databases after integrity checks.'
                    : 'Run immediate quick repair and pending graph schema migrations.',
                  title: deep ? 'Repair every graph deeply?' : 'Repair every graph?',
                  tone: deep ? 'danger' : 'default',
                },
                {action: 'repair', deep},
              )
            }
            type="button"
          >
            {deep ? 'Deep repair all' : 'Repair all'}
          </button>
          <button disabled={blocked} onClick={() => props.onAction({action: 'purge-all', dryRun: true})} type="button">
            Preview purge all
          </button>
          <button
            className="danger"
            disabled={blocked}
            onClick={() =>
              void confirmAction(
                {
                  confirmLabel: 'Purge every graph',
                  message: 'Every local native code graph index will be removed and rebuilt on demand.',
                  title: 'Purge all disposable graphs?',
                  tone: 'danger',
                },
                {action: 'purge-all'},
              )
            }
            type="button"
          >
            Purge all
          </button>
        </div>
        <label className="check-row graph-force-compact">
          <input
            checked={forceCompact}
            disabled={blocked}
            onChange={event => setForceCompact(event.target.checked)}
            type="checkbox"
          />
          <span>Force compaction below the reviewed reclaimable-space threshold</span>
        </label>
        {props.report ? (
          <div className="graph-database-grid">
            {props.report.databases.map(database => {
              const view = database.views.find(candidate => candidate.managementAvailable) ?? database.views[0];
              const managementAvailable = view?.managementAvailable === true;
              const unassociatedWithoutSnapshot = view === undefined && database.health?.readySnapshots === 0;
              const repository = unassociatedWithoutSnapshot
                ? 'Unassociated graph storage'
                : (view?.repository.displayName ?? 'Indexed repository');
              const jobs = graphAdministrationJobSelection(database.builds, database.waiters);
              const obsolete = props.report?.obsoleteStores.checkouts.find(
                checkout => checkout.checkoutId === database.checkoutId,
              );
              const target = view
                ? graphAdministrationTarget(database.checkoutId, {
                    repository: view.repository,
                    worktreeId: view.viewWorktreeId,
                  })
                : undefined;
              const health = database.health?.integrity ?? database.healthState;
              const snapshotAttribution =
                database.storage.state === 'available' &&
                database.storage.pageStorage?.state === 'available' &&
                database.storage.pageStorage.attribution?.state === 'available'
                  ? database.storage.pageStorage.attribution.semantic.snapshots
                  : undefined;
              return (
                <article className="graph-database-card" key={database.checkoutId}>
                  <header>
                    <span>
                      <strong>{repository}</strong>
                      <small>
                        {view?.localAssociation.branch ? `observed branch ${view.localAssociation.branch} · ` : ''}
                        {unassociatedWithoutSnapshot
                          ? 'No verified local folder or ready snapshot'
                          : (view?.localAssociation.displayPath ??
                            'Local folder unavailable; opaque ID shown in diagnostics')}
                      </small>
                    </span>
                    <em className={`is-${health}`}>{health === 'migration-pending' ? 'migrating' : health}</em>
                  </header>
                  <dl>
                    <div>
                      <dt>Stored ready snapshots</dt>
                      <dd>
                        {database.health
                          ? database.health.readySnapshots.toLocaleString()
                          : database.healthState === 'deferred'
                            ? 'health inspection deferred'
                            : 'unavailable'}
                      </dd>
                    </div>
                    <div>
                      <dt>Active worktree views</dt>
                      <dd>{database.views.length.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Storage</dt>
                      <dd>
                        {database.storage.state === 'available'
                          ? `${formatGraphBytes(database.storage.filesystemBytes)} physical DB + sidecars`
                          : 'missing'}
                      </dd>
                    </div>
                    <div>
                      <dt>Jobs</dt>
                      <dd>{jobs.total === 0 ? 'None' : `${jobs.total} actionable`}</dd>
                    </div>
                  </dl>
                  <p className="graph-database-inventory-note">
                    Snapshot and view counts can differ: views are per-worktree pointers, while ready snapshots are
                    stored graph versions that can be shared, retained for reuse, or protected while in use.
                  </p>
                  {snapshotAttribution?.state === 'available' ? (
                    <p
                      className={
                        snapshotAttribution.baseline.retiredLogicalPayloadBytes >
                        snapshotAttribution.baseline.readyLogicalPayloadBytes
                          ? 'graph-build-attention'
                          : 'graph-database-inventory-note'
                      }
                    >
                      Snapshot payload: {formatGraphBytes(snapshotAttribution.baseline.readyLogicalPayloadBytes)} ready
                      · {formatGraphBytes(snapshotAttribution.baseline.retiredLogicalPayloadBytes)} retired/failed
                      logical
                      {snapshotAttribution.snapshotsTruncated ? ' (first 64 snapshots only)' : ''}
                    </p>
                  ) : null}
                  {database.storage.state === 'available' && 'pageStorage' in database.storage ? (
                    database.storage.pageStorage.state === 'available' ? (
                      <p className="graph-database-inventory-note">
                        SQLite pages:{' '}
                        {formatGraphBytes(
                          database.storage.pageStorage.pageCount * database.storage.pageStorage.pageSize -
                            database.storage.pageStorage.reclaimableBytes,
                        )}{' '}
                        in use · {formatGraphBytes(database.storage.pageStorage.reclaimableBytes)} already reusable
                        inside the file
                        {database.storage.pageStorage.compactionOpportunityBytes === undefined ||
                        database.storage.pageStorage.compactionOpportunityBytes ===
                          database.storage.pageStorage.reclaimableBytes
                          ? ''
                          : ` · ${formatGraphBytes(
                              database.storage.pageStorage.compactionOpportunityBytes,
                            )} total compaction opportunity`}
                        {database.storage.pageStorage.threshold.reason === 'freelist'
                          ? ' · eligible for automatic compaction after retry-cooldown, disk, and maintenance safety checks'
                          : database.storage.pageStorage.threshold.reason === 'freelist-and-fragmentation'
                            ? ' · manual compaction opportunity; automatic compaction is withheld for live-page structural slack'
                            : ''}
                      </p>
                    ) : database.storage.pageStorage.state === 'deferred' ? (
                      <p className="graph-database-inventory-note">
                        SQLite page usage is deferred while an active build owns this repository. Manager will retry
                        after the build releases its lock.
                      </p>
                    ) : (
                      <p className="graph-database-inventory-note">
                        SQLite page usage and automatic-compaction eligibility could not be established. Run graph
                        diagnostics before retrying repair or compaction.
                      </p>
                    )
                  ) : null}
                  <div className="graph-database-views">
                    {database.views.map(candidate => {
                      const removalTarget = graphViewRemovalTarget(database.checkoutId, {
                        scopeId: candidate.viewScopeId,
                        snapshot: candidate.snapshot,
                        worktreeId: candidate.viewWorktreeId,
                      });
                      const partialTopology = candidate.analysis?.coverage.topology.state === 'partial';
                      const boundedNodePrefix = partialTopology && !candidate.analysis?.coverage.nodesComplete;
                      return (
                        <div
                          key={`${database.checkoutId}:${candidate.viewWorktreeId}:${candidate.viewScopeId ?? 'full-repository'}`}
                        >
                          <strong>
                            {graphRepositoryScopeLabel(
                              candidate.repository.displayName,
                              candidate.viewScopeId,
                              props.configuredProjects,
                            )}
                          </strong>
                          <span>
                            {candidate.snapshot.fileCount.toLocaleString()} files ·{' '}
                            {candidate.snapshot.symbolCount.toLocaleString()} symbols ·{' '}
                            {candidate.snapshot.edgeCount.toLocaleString()} edges
                          </span>
                          <small>
                            {candidate.localAssociation.branch
                              ? `Observed branch ${candidate.localAssociation.branch} · `
                              : ''}
                            Folder: {graphLocalAssociationText(candidate.localAssociation)} ·{' '}
                            {candidate.localAssociation.state}
                          </small>
                          {candidate.localAssociation.state === 'missing' ? (
                            <small className="graph-build-attention">
                              Retained snapshot · recorded folder is missing. This does not establish a ready graph for
                              another checkout.
                            </small>
                          ) : null}
                          {candidate.analysis ? (
                            <small>
                              {candidate.analysis.coverage.complete ? 'Complete' : 'Partial'} analysis ·{' '}
                              {candidate.analysis.coverage.topology.state === 'complete' ||
                              candidate.analysis.coverage.topology.state === 'partial' ? (
                                <>
                                  {candidate.analysis.statistics.connectedComponentCount.toLocaleString()}{' '}
                                  {partialTopology ? 'observed components' : 'components'} ·{' '}
                                  {candidate.analysis.statistics.communityCount.toLocaleString()}{' '}
                                  {partialTopology ? 'observed communities' : 'communities'} ·{' '}
                                  {partialTopology ? 'observed average' : 'average'} degree{' '}
                                  {candidate.analysis.statistics.averageDegree.toFixed(2)} ·{' '}
                                  {partialTopology ? 'observed maximum' : 'maximum'}{' '}
                                  {candidate.analysis.statistics.maximumDegree.toLocaleString()} ·{' '}
                                  {candidate.analysis.statistics.isolatedNodeCount.toLocaleString()}{' '}
                                  {partialTopology
                                    ? `${boundedNodePrefix ? 'retained nodes' : 'nodes'} with zero observed degree`
                                    : 'isolated'}
                                </>
                              ) : (
                                <>topology {candidate.analysis.coverage.topology.state}</>
                              )}
                            </small>
                          ) : null}
                          <button
                            aria-label={`Remove active worktree view ${candidate.viewWorktreeId.slice(-8)}`}
                            className="danger graph-view-remove"
                            disabled={blocked}
                            onClick={() => props.onAction({action: 'remove-view', ...removalTarget})}
                            title="Remove active worktree view"
                            type="button"
                          >
                            <svg aria-hidden="true" viewBox="0 0 24 24">
                              <path d="M4 6h16M9 6V4h6v2m3 0-1 14H7L6 6m4 4v6m4-6v6" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {jobs.jobs.map(job => {
                    const jobView = graphAdministrationJobView(database.views, job);
                    return (
                      <p className="graph-database-job" key={`${job.buildId}:${job.coordination?.role ?? 'build'}`}>
                        {graphRepositoryScopeLabel(
                          jobView?.repository.displayName ?? 'Indexed repository',
                          job.identity.scopeId,
                          props.configuredProjects,
                        )}
                        {jobView ? ` · folder ${graphLocalAssociationText(jobView.localAssociation)}` : ''} ·{' '}
                        {job.state === 'running' ? 'active' : job.state} · {job.phase}
                        {job.subphase ? `/${job.subphase}` : ''} · {job.observation.liveness}
                        {job.error ? ` · ${job.error.summary}` : ''}
                      </p>
                    );
                  })}
                  {jobs.hiddenCount > 0 ? (
                    <p className="graph-database-job">+{jobs.hiddenCount} more active or failed jobs</p>
                  ) : null}
                  {database.issues.map(issue => (
                    <p className="graph-database-issue" key={`${database.checkoutId}:${issue.code}`}>
                      {issue.code}: {issue.message}
                    </p>
                  ))}
                  <div className="graph-database-actions">
                    <button
                      disabled={blocked || !target}
                      onClick={() => {
                        if (!target) return;
                        void dispatchTargetAction(managementAvailable, {action: 'index', ...target});
                      }}
                      type="button"
                    >
                      Index
                    </button>
                    <button
                      disabled={blocked || !target}
                      onClick={() => {
                        if (!target) return;
                        void dispatchTargetAction(managementAvailable, {action: 'index', full: true, ...target});
                      }}
                      type="button"
                    >
                      Reindex
                    </button>
                    <button
                      disabled={blocked || !target}
                      onClick={() => {
                        if (!target) return;
                        void dispatchTargetAction(managementAvailable, {
                          action: 'compact',
                          dryRun: true,
                          force: forceCompact,
                          ...target,
                        });
                      }}
                      type="button"
                    >
                      Preview compact
                    </button>
                    <button
                      disabled={blocked || !target}
                      onClick={() => {
                        if (!target) return;
                        void dispatchTargetAction(
                          managementAvailable,
                          {action: 'compact', force: forceCompact, ...target},
                          {
                            confirmLabel: 'Compact graph',
                            detail: repository,
                            message: 'Rewrite this verified graph database to reclaim reviewed free space.',
                            title: 'Compact this graph?',
                          },
                        );
                      }}
                      type="button"
                    >
                      Compact
                    </button>
                    {obsolete ? (
                      <>
                        <button
                          disabled={blocked}
                          onClick={() =>
                            props.onAction({
                              action: 'purge-obsolete',
                              checkoutId: database.checkoutId,
                              dryRun: true,
                            })
                          }
                          type="button"
                        >
                          Preview obsolete
                        </button>
                        <button
                          disabled={blocked}
                          onClick={() =>
                            void confirmAction(
                              {
                                confirmLabel: 'Purge obsolete files',
                                detail: repository,
                                message: `Remove ${obsolete.fileCount} verified obsolete graph file${obsolete.fileCount === 1 ? '' : 's'}.`,
                                title: 'Purge obsolete graph files?',
                                tone: 'danger',
                              },
                              {action: 'purge-obsolete', checkoutId: database.checkoutId},
                            )
                          }
                          type="button"
                        >
                          Purge obsolete
                        </button>
                      </>
                    ) : null}
                    <button
                      disabled={blocked}
                      onClick={() => props.onAction({action: 'purge', checkoutId: database.checkoutId, dryRun: true})}
                      type="button"
                    >
                      Preview purge
                    </button>
                    <button
                      className="danger"
                      disabled={blocked}
                      onClick={() =>
                        void confirmAction(
                          {
                            confirmLabel: 'Purge graph',
                            detail: repository,
                            message: 'Remove this disposable native graph index. It will rebuild on demand.',
                            title: 'Purge this graph?',
                            tone: 'danger',
                          },
                          {action: 'purge', checkoutId: database.checkoutId},
                        )
                      }
                      type="button"
                    >
                      Purge graph
                    </button>
                  </div>
                  {unassociatedWithoutSnapshot ? (
                    <small className="graph-management-unavailable">
                      This disposable graph has no queryable snapshot. Index from the repository folder with{' '}
                      <code>threadnote graph index --cwd &lt;path&gt;</code>, or preview and purge it if it is obsolete.
                    </small>
                  ) : !managementAvailable ? (
                    <small className="graph-management-unavailable">
                      Index, reindex, and compact require a verified local worktree path. Purge actions target this
                      inventoried checkout directly.
                    </small>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <p>Load diagnostics to enumerate every local graph database.</p>
        )}
        {props.output ? <pre className="graph-administration-output">{props.output}</pre> : null}
      </div>
    </details>
  );
}

function graphConfiguredProjectStateDetail(state: GraphConfiguredProject['graphState']): string {
  switch (state) {
    case 'not-indexed':
      return 'No ready snapshot';
    case 'ready':
      return 'Ready snapshot';
    case 'unknown':
      return 'Ready state is outside the bounded catalog';
  }
}

export function GraphMaintenanceProgress(props: {
  readonly repositories: readonly GraphRepositoryGroup[];
  readonly status: CodeGraphMaintenanceStatus;
}): React.ReactElement {
  const {status} = props;
  const repository = props.repositories
    .flatMap(group => group.views)
    .find(view => view.checkoutId === status.checkoutId);
  const elapsed = status.startedAt === undefined ? undefined : Math.max(0, Date.now() - Date.parse(status.startedAt));
  const lastUpdate =
    status.updatedAt === undefined ? undefined : Math.max(0, Date.now() - Date.parse(status.updatedAt));
  const remaining = graphMaintenanceRemainingMilliseconds(status, Date.now());
  const percentage =
    status.completed !== undefined && status.total !== undefined && status.total > 0
      ? Math.max(0, Math.min(100, (status.completed / status.total) * 100))
      : undefined;
  const unit = status.operation === 'selected-snapshot-purge' ? 'safety phases' : 'phases';
  return (
    <div className="graph-build-status graph-maintenance-status" aria-live="polite">
      <article className="graph-build-card is-running is-active">
        <header>
          <div className="graph-build-target">
            <strong>
              {status.operation === 'selected-snapshot-purge' ? 'Selected snapshot purge' : 'Graph maintenance'}
            </strong>
            <span>
              {status.checkoutId
                ? repository
                  ? `${repository.displayName} · folder ${graphLocalAssociationText(repository.localAssociation)}`
                  : 'Indexed repository'
                : 'Home-wide maintenance'}
            </span>
          </div>
          {elapsed === undefined ? null : <span>Elapsed {formatBuildDuration(elapsed)}</span>}
        </header>
        <p className="graph-build-phase">{graphMaintenanceStatusLabel(status)}</p>
        {percentage === undefined ? null : (
          <div className="graph-build-meter" aria-label={`${Math.round(percentage)}% complete`}>
            <i style={{width: `${percentage}%`}} />
          </div>
        )}
        <p>
          {status.completed === undefined || status.total === undefined
            ? 'Waiting for the next maintenance phase update'
            : `${status.completed.toLocaleString()} / ${status.total.toLocaleString()} ${unit}`}
          {remaining === undefined ? '' : ` · ETA ${formatBuildDuration(remaining)}`}
          {lastUpdate === undefined ? '' : ` · last update ${formatBuildDuration(lastUpdate)} ago`}
        </p>
      </article>
    </div>
  );
}

export function GraphAutomaticCompactionProgress(props: {
  readonly repositories: readonly GraphRepositoryGroup[];
  readonly status: CodeGraphAutomaticCompactionStatus;
}): React.ReactElement | null {
  const {status} = props;
  if (status.state === 'idle') return null;
  const checkoutId = 'checkoutId' in status ? status.checkoutId : undefined;
  const repository = props.repositories.flatMap(group => group.views).find(view => view.checkoutId === checkoutId);
  const target = repository
    ? `${repository.displayName} · folder ${graphLocalAssociationText(repository.localAssociation)}`
    : checkoutId
      ? 'Indexed repository'
      : 'Local graph storage';
  const message = (() => {
    switch (status.state) {
      case 'inspecting':
        return 'Checking bounded graph storage receipts for a safe reclaim opportunity.';
      case 'running':
        return `Compacting ${target} in an isolated process without blocking Manager.`;
      case 'deferred':
        return `Compaction for ${target} was deferred because ${
          status.reason === 'active-build' ? 'a graph build is active' : 'another maintenance operation is active'
        }. Manager will retry.`;
      case 'failed':
        return status.reason === 'inspection-failed'
          ? 'The automatic storage check could not inspect any candidate. Review graph diagnostics.'
          : 'The isolated compaction result could not be confirmed. Review diagnostics before retrying.';
      case 'completed':
        return status.action === 'compacted'
          ? `Compacted ${target} and returned ${formatGraphBytes(status.reclaimedBytes)} to the filesystem.`
          : `Automatic storage check completed: no eligible graph required compaction (${status.inspected.toLocaleString()} inspected${
              status.inspectionFailures === 0 ? '' : `, ${status.inspectionFailures.toLocaleString()} unavailable`
            }).`;
    }
  })();
  return (
    <div className="graph-build-status graph-maintenance-status" aria-live="polite">
      <article className={`graph-build-card is-${status.state}`}>
        <header>
          <div className="graph-build-target">
            <strong>Automatic graph storage compaction</strong>
            <span>{target}</span>
          </div>
        </header>
        <p className={status.state === 'failed' ? 'graph-build-error' : undefined}>{message}</p>
      </article>
    </div>
  );
}

export function GraphBuildProgress(props: {
  readonly build: GraphBuildStatus;
  readonly configuredProjects?: readonly GraphConfiguredProject[];
  readonly repositories: readonly GraphRepositoryGroup[];
  readonly storage?: GraphStorageSummary;
  readonly waiters: readonly GraphBuildStatus[];
}): React.ReactElement {
  const {build} = props;
  const completed = build.counters.completed;
  const total = build.counters.total;
  const percentage =
    completed !== undefined && total !== undefined && total > 0
      ? Math.max(0, Math.min(100, (completed / total) * 100))
      : undefined;
  const elapsed = Math.max(0, Date.now() - Date.parse(build.timestamps.startedAt));
  const lastProgress = Math.max(0, Date.now() - Date.parse(build.timestamps.lastProgressAt));
  const progressSilent = build.coordination?.progressSilent === true;
  const eta = progressSilent ? undefined : build.eta;
  const target = graphBuildTarget(build, props.repositories, props.configuredProjects);
  const concurrency = graphBuildConcurrencyState(build, props.waiters, props.repositories);
  const waiterCount = graphWaiterCountForBuild(build, props.waiters);
  const statusLabel =
    build.state === 'failed'
      ? 'Indexing failed'
      : build.state === 'queued'
        ? 'Waiting to index'
        : progressSilent
          ? 'Indexing status is stale'
          : 'Indexing';
  return (
    <article className={`graph-build-card is-${build.state} is-${build.observation.liveness}`}>
      <header>
        <div className="graph-build-target">
          <strong>{target.repositoryLabel}</strong>
          <span title={target.worktreeLabel}>{target.worktreeLabel}</span>
        </div>
        <span>Elapsed {formatBuildDuration(elapsed)}</span>
      </header>
      <p className="graph-build-phase">
        {statusLabel} · {build.phase}/{build.subphase ?? 'working'} · commit {build.identity.commit}
      </p>
      <p className="graph-build-concurrency">
        {build.state === 'running'
          ? `Active target ${graphCommitLabel(build.identity.commit)}`
          : build.state === 'queued'
            ? `Queued target ${graphCommitLabel(build.identity.commit)}`
            : build.state === 'failed'
              ? `Failed target ${graphCommitLabel(build.identity.commit)}`
              : `Completed target ${graphCommitLabel(build.identity.commit)}`}
        {concurrency.latestTargetCommit === build.identity.commit
          ? ''
          : ` · latest target ${graphCommitLabel(concurrency.latestTargetCommit)} queued`}
        {concurrency.queuedRequests === 0
          ? ''
          : ` · ${concurrency.queuedRequests.toLocaleString()} queued request${concurrency.queuedRequests === 1 ? '' : 's'}`}
      </p>
      {concurrency.staleReady && concurrency.readySnapshotCommit !== undefined ? (
        <p className="graph-build-attention">
          Ready snapshot {graphCommitLabel(concurrency.readySnapshotCommit)} remains queryable · stale for latest target{' '}
          {graphCommitLabel(concurrency.latestTargetCommit)}
        </p>
      ) : null}
      {percentage === undefined ? null : (
        <div className="graph-build-meter" aria-label={`${Math.round(percentage)}% complete`}>
          <i style={{width: `${percentage}%`}} />
        </div>
      )}
      <p>
        {build.phase === 'reclaiming'
          ? `${(completed ?? 0).toLocaleString()} / ${(total ?? 0).toLocaleString()} snapshots · ${(
              build.counters.pagesCompleted ?? 0
            ).toLocaleString()} pages · ${(build.counters.rowsDeleted ?? 0).toLocaleString()} rows reclaimed`
          : completed === undefined || total === undefined
            ? 'Preparing phase counters'
            : `${completed.toLocaleString()} / ${total.toLocaleString()} ${build.counters.unit ?? 'items'}`}
        {' · '}last progress change {formatBuildDuration(lastProgress)} ago
      </p>
      {progressSilent ? (
        <p className="graph-build-attention">
          No progress update for {formatBuildDuration(lastProgress)}. Process {build.owner.processId} still owns the
          build lock, but Manager cannot determine whether its current operation is advancing.
        </p>
      ) : null}
      {props.storage?.state === 'available' ? (
        props.storage.pageStorage.state === 'available' ? (
          <p className={props.storage.pageStorage.automaticCompaction === 'eligible' ? 'graph-build-attention' : ''}>
            Storage now: {formatGraphBytes(props.storage.physicalBytes)} physical SQLite file + sidecars ·{' '}
            {formatGraphBytes(props.storage.pageStorage.inUseBytes)} pages in use ·{' '}
            {formatGraphBytes(props.storage.pageStorage.reusableBytes)} reusable inside SQLite
            {props.storage.pageStorage.compactionOpportunityBytes === undefined ||
            props.storage.pageStorage.compactionOpportunityBytes === props.storage.pageStorage.reusableBytes
              ? ''
              : ` · ${formatGraphBytes(props.storage.pageStorage.compactionOpportunityBytes)} total compaction opportunity`}
            {props.storage.pageStorage.automaticCompaction === 'eligible'
              ? ' · eligible for automatic compaction after retry-cooldown and maintenance safety checks'
              : props.storage.pageStorage.automaticCompaction === 'waiting-for-space'
                ? ` · automatic compaction is waiting for ${formatGraphBytes(
                    props.storage.pageStorage.requiredFreeBytes ?? 0,
                  )} free disk space`
                : props.storage.pageStorage.automaticCompaction === 'space-unknown'
                  ? ' · free disk space could not be verified, so automatic compaction is withheld'
                  : ''}
          </p>
        ) : (
          <p>
            Storage now: {formatGraphBytes(props.storage.physicalBytes)} physical SQLite file + sidecars · page usage
            and automatic compaction decision deferred while an active build or database lock owns this checkout
          </p>
        )
      ) : null}
      {build.activity ? (
        <p>
          Current reported step: {build.activity.stage} {build.activity.language} ·{' '}
          {formatGraphBytes(build.activity.bytes)} · batch {build.activity.batchCompleted.toLocaleString()}/
          {build.activity.batchTotal.toLocaleString()}
          {build.activity.sizeBucket === undefined ? '' : ` · ${build.activity.sizeBucket} source bucket`}
          {build.activity.role === undefined ? '' : ` · ${build.activity.role}`}
          {build.activity.classifier === undefined ? '' : `/${build.activity.classifier}`}
          {build.activity.factsBytes === undefined
            ? ''
            : ` · ${formatGraphBytes(build.activity.factsBytes)} emitted facts`}
          {build.activity.symbols === undefined ? '' : ` · ${build.activity.symbols.toLocaleString()} symbols`}
          {build.activity.relations === undefined ? '' : ` · ${build.activity.relations.toLocaleString()} relations`}
          {build.activity.parseMilliseconds === undefined
            ? ''
            : ` · parse ${formatGraphMilliseconds(build.activity.parseMilliseconds)}`}
          {build.activity.persistMilliseconds === undefined
            ? ''
            : ` · persist ${formatGraphMilliseconds(build.activity.persistMilliseconds)}`}
          {build.activity.degraded ? ' · metadata fallback; retry scheduled' : ''}
        </p>
      ) : null}
      {build.extraction ? (
        <p>
          Extraction telemetry: {build.extraction.completedFiles.toLocaleString()} files completed ·{' '}
          {build.extraction.metrics === undefined
            ? ''
            : `${formatGraphBytes(build.extraction.metrics.sourceBytesCompleted)}/${formatGraphBytes(
                build.extraction.metrics.sourceBytesTotal,
              )} source · ${formatGraphBytes(build.extraction.metrics.factsBytesCompleted)} emitted facts · ${formatGraphPercentage(
                build.extraction.metrics.workUnitsCompleted,
                build.extraction.metrics.workUnitsTotal,
              )} class-weighted work · `}
          {build.extraction.slowFiles.toLocaleString()} at or above{' '}
          {formatGraphMilliseconds(CODE_GRAPH_SLOW_FILE_THRESHOLD_MILLISECONDS)} · bounded top-slow evidence{' '}
          {build.extraction.topSlowFiles.length.toLocaleString()}/{CODE_GRAPH_TOP_SLOW_FILE_LIMIT.toLocaleString()}
        </p>
      ) : null}
      {build.materialization?.metrics?.mode === 'full' ? (
        <p className="graph-build-attention">
          Full materialization selected
          {build.materialization.metrics.fallbackReason === undefined
            ? ''
            : ` · incremental fallback: ${build.materialization.metrics.fallbackReason.replaceAll('-', ' ')}`}
        </p>
      ) : null}
      {build.materialization?.activity ? (
        <p>
          Current reported step: {graphMaterializationStageLabel(build.materialization.activity.stage)} · batch{' '}
          {graphActiveBatchNumber(
            build.materialization.activity.batchCompleted,
            build.materialization.activity.batchTotal,
          ).toLocaleString()}
          /{build.materialization.activity.batchTotal.toLocaleString()} ·{' '}
          {formatGraphBytes(build.materialization.activity.sourceBytes)} source
          {build.materialization.activity.cachedFactBytes === undefined
            ? ''
            : ` · ${formatGraphBytes(build.materialization.activity.cachedFactBytes)} cached facts`}
          {build.materialization.activity.factsBytes === undefined
            ? ''
            : ` · ${formatGraphBytes(build.materialization.activity.factsBytes)} final facts`}
          {graphMaterializationRows(build.materialization.activity.rows)}
          {' · '}this step{' '}
          {formatBuildDuration(Math.max(0, Date.now() - Date.parse(build.materialization.activity.startedAt)))}
          {build.materialization.activity.transactionMilliseconds === undefined
            ? ''
            : ` · transaction ${formatGraphMilliseconds(build.materialization.activity.transactionMilliseconds)}`}
        </p>
      ) : null}
      {build.activation?.activity ? (
        <p>
          Current reported step: activating · {build.activation.activity.stage.replaceAll('-', ' ')} ·{' '}
          {build.activation.activity.state}
          {build.activation.activity.rows === undefined
            ? ''
            : ` · ${build.activation.activity.rows.toLocaleString()} rows`}
          {' · '}stage {formatGraphMilliseconds(build.activation.activity.stageElapsedMilliseconds)} · total{' '}
          {formatGraphMilliseconds(build.activation.activity.elapsedMilliseconds)}
          {build.activation.activity.transactionMilliseconds === undefined
            ? ''
            : ` · transaction ${formatGraphMilliseconds(build.activation.activity.transactionMilliseconds)}`}
        </p>
      ) : null}
      {build.resolution?.activity ? (
        <p>
          Reference resolution: pass {build.resolution.activity.pass.toLocaleString()} · page{' '}
          {build.resolution.activity.pageCompleted.toLocaleString()}/
          {build.resolution.activity.pageTotal.toLocaleString()} ·{' '}
          {build.resolution.activity.referencesCompleted.toLocaleString()}/
          {build.resolution.activity.referencesTotal.toLocaleString()} references ·{' '}
          {build.resolution.activity.referencesExamined.toLocaleString()} cumulative examined ·{' '}
          {build.resolution.activity.resolved.toLocaleString()} linked ·{' '}
          {build.resolution.activity.aliasesDiscovered.toLocaleString()} aliases · match{' '}
          {formatGraphMilliseconds(build.resolution.activity.matchingMilliseconds)} · transactions{' '}
          {formatGraphMilliseconds(build.resolution.activity.transactionMilliseconds)} · total{' '}
          {formatGraphMilliseconds(build.resolution.activity.elapsedMilliseconds)}
        </p>
      ) : null}
      {build.materialization?.metrics ? (
        <>
          <p>
            Materialized: {build.materialization.metrics.batchesCompleted.toLocaleString()}/
            {build.materialization.metrics.batchesTotal.toLocaleString()} batches ·{' '}
            {formatGraphBytes(build.materialization.metrics.sourceBytesCompleted)}/
            {formatGraphBytes(build.materialization.metrics.sourceBytesTotal)} source
            {build.materialization.metrics.cachedFactBytesCompleted === undefined
              ? ''
              : ` · ${formatGraphBytes(build.materialization.metrics.cachedFactBytesCompleted)}${
                  build.materialization.metrics.cachedFactBytesTotal === undefined
                    ? ''
                    : `/${formatGraphBytes(build.materialization.metrics.cachedFactBytesTotal)}`
                } cached facts`}
            {build.materialization.metrics.factsBytesCompleted === undefined
              ? ''
              : ` · ${formatGraphBytes(build.materialization.metrics.factsBytesCompleted)}${
                  build.materialization.metrics.factsBytesTotal === undefined
                    ? ''
                    : `/${formatGraphBytes(build.materialization.metrics.factsBytesTotal)}`
                } final facts`}
            {graphMaterializationRows(build.materialization.metrics.rows)}
            {build.materialization.metrics.loadingMilliseconds === undefined
              ? ''
              : ` · load ${formatGraphMilliseconds(build.materialization.metrics.loadingMilliseconds)}`}
            {build.materialization.metrics.attributionMilliseconds === undefined
              ? ''
              : ` · attribute ${formatGraphMilliseconds(build.materialization.metrics.attributionMilliseconds)}`}
            {build.materialization.metrics.transactionMilliseconds === undefined
              ? ''
              : ` · transactions ${formatGraphMilliseconds(build.materialization.metrics.transactionMilliseconds)}`}
          </p>
          {build.materialization.metrics.subphaseMilliseconds ? (
            <p>
              Materialization detail: compute{' '}
              {formatGraphMilliseconds(build.materialization.metrics.subphaseMilliseconds.attributionCompute)} ·
              serialize {formatGraphMilliseconds(build.materialization.metrics.subphaseMilliseconds.shardSerialization)}{' '}
              · persist shards{' '}
              {formatGraphMilliseconds(build.materialization.metrics.subphaseMilliseconds.shardPersistence)} · associate
              shards {formatGraphMilliseconds(build.materialization.metrics.subphaseMilliseconds.shardAssociation)} ·
              prepare batches{' '}
              {formatGraphMilliseconds(build.materialization.metrics.subphaseMilliseconds.factBatchPreparation)}
            </p>
          ) : null}
          {build.materialization.metrics.attributedFilesCompleted === undefined &&
          build.materialization.metrics.crossGenerationShardFilesCompleted === undefined &&
          build.materialization.metrics.exactGenerationShardFilesCompleted === undefined &&
          build.materialization.metrics.materializedShardReplayBytesCompleted === undefined &&
          build.materialization.metrics.rawFactReplayBytesCompleted === undefined ? null : (
            <p>
              Physical cache replay
              {build.materialization.metrics.cachedFactReplayBytesCompleted === undefined
                ? ''
                : `: ${formatGraphBytes(build.materialization.metrics.cachedFactReplayBytesCompleted)} total decoded`}
              {build.materialization.metrics.materializedShardReplayBytesCompleted === undefined
                ? ''
                : ` · ${formatGraphBytes(
                    build.materialization.metrics.materializedShardReplayBytesCompleted,
                  )} materialized-shard payloads decoded`}
              {build.materialization.metrics.rawFactReplayBytesCompleted === undefined
                ? ''
                : ` · ${formatGraphBytes(
                    build.materialization.metrics.rawFactReplayBytesCompleted,
                  )} raw parser-fact payloads decoded`}
              {build.materialization.metrics.attributedFilesCompleted === undefined
                ? ''
                : ` · ${build.materialization.metrics.attributedFilesCompleted.toLocaleString()} raw parser-fact files postprocessed and attributed`}
              {build.materialization.metrics.exactGenerationShardFilesCompleted === undefined
                ? ''
                : ` · ${build.materialization.metrics.exactGenerationShardFilesCompleted.toLocaleString()} files selected from exact-generation materialized shards`}
              {build.materialization.metrics.crossGenerationShardFilesCompleted === undefined
                ? ''
                : ` · ${build.materialization.metrics.crossGenerationShardFilesCompleted.toLocaleString()} files selected from cross-generation materialized shards`}
            </p>
          )}
          {build.materialization.metrics.storage ? (
            <>
              <p>
                Storage:
                {build.materialization.metrics.storage.durableDatabaseBytes === undefined
                  ? ''
                  : ` ${formatGraphBytes(build.materialization.metrics.storage.durableDatabaseBytes)} allocated SQLite pages observed during this build`}
                {build.materialization.metrics.storage.durableDatabaseHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableDatabaseHighWaterBytes)} SQLite allocation high-water`}
                {build.materialization.metrics.storage.durableDatabaseGrowthHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableDatabaseGrowthHighWaterBytes)} main-database growth`}
                {build.materialization.metrics.storage.durableFilesystemHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableFilesystemHighWaterBytes)} DB + sidecars high-water`}
                {build.materialization.metrics.storage.durableWalHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableWalHighWaterBytes)} WAL high-water`}
                {build.materialization.metrics.storage.durableJournalHighWaterBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableJournalHighWaterBytes)} rollback-journal high-water`}
                {build.materialization.metrics.storage.durableDatabaseBytes === undefined ? '' : ' ·'}{' '}
                {formatGraphBytes(build.materialization.metrics.storage.temporaryDatabaseBytes)} current TEMP database ·{' '}
                {formatGraphBytes(build.materialization.metrics.storage.temporaryDatabaseHighWaterBytes)} TEMP database
                high-water
                {build.materialization.metrics.storage.estimatedRequiredBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.estimatedRequiredBytes)} combined estimate`}
                {build.materialization.metrics.storage.estimatedTemporaryFilesystemRequiredBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.estimatedTemporaryFilesystemRequiredBytes)} TEMP-filesystem requirement`}
                {build.materialization.metrics.storage.estimatedDurableFilesystemRequiredBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.estimatedDurableFilesystemRequiredBytes)} graph-filesystem requirement`}
                {build.materialization.metrics.storage.temporaryAvailableBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.temporaryAvailableBytes)} available for TEMP`}
                {build.materialization.metrics.storage.durableAvailableBytes === undefined
                  ? ''
                  : ` · ${formatGraphBytes(build.materialization.metrics.storage.durableAvailableBytes)} available for graph database`}
                {build.materialization.metrics.storage.filesystemsShared === true ? ' · shared filesystem' : ''}
                {build.materialization.metrics.storage.materializationMode === undefined
                  ? ''
                  : ` · ${build.materialization.metrics.storage.materializationMode.replaceAll('-', ' ')}`}
                {build.materialization.metrics.storage.estimateBasis === undefined
                  ? ''
                  : ` · estimate from ${build.materialization.metrics.storage.estimateBasis.replaceAll('-', ' ')}`}
                {' · '}rollback journals excluded from TEMP totals
              </p>
              {graphMaterializationDiskWarning(build.materialization.metrics.storage) ? (
                <p className="graph-build-error">
                  {graphMaterializationDiskWarning(build.materialization.metrics.storage)} Indexing continues with live
                  storage telemetry.
                </p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {build.timings ? (
        <p>
          Phase: read {formatGraphMilliseconds(build.timings.readingMilliseconds)} · parse{' '}
          {formatGraphMilliseconds(build.timings.extractionMilliseconds)}
          {build.timings.serializationMilliseconds === undefined
            ? null
            : ` · serialize ${formatGraphMilliseconds(build.timings.serializationMilliseconds)}`}{' '}
          · persist {formatGraphMilliseconds(build.timings.persistenceMilliseconds)}
        </p>
      ) : null}
      <footer>
        <span title={build.owner.processStartIdentity}>
          Process {build.owner.processId}
          {build.owner.processStartIdentity
            ? ` · owner instance ${shortGraphIdentity(build.owner.processStartIdentity)}`
            : ''}
        </span>
        {eta && eta.confidence !== 'low' ? (
          <span>
            Estimated time remaining in this phase: {formatBuildDuration(eta.remainingMilliseconds)} · {eta.confidence}{' '}
            confidence
            {eta.basis ? ` · ${graphEtaBasisLabel(eta.basis)}` : ''}
          </span>
        ) : null}
        {waiterCount > 0 ? <span>{waiterCount} waiting process(es) for this exact target</span> : null}
        {build.error ? <span className="graph-build-error">{build.error.summary}</span> : null}
      </footer>
    </article>
  );
}

function graphCommitLabel(commit: string): string {
  return commit.slice(0, 12) || 'unknown';
}

function graphActiveBatchNumber(completed: number, total: number): number {
  return total === 0 ? 0 : Math.min(total, completed + 1);
}

function graphMaterializationStageLabel(stage: GraphMaterializationStage): string {
  switch (stage) {
    case 'loading-cache':
      return 'loading cached facts';
    case 'attributing':
      return 'attributing facts';
    case 'preparing-rows':
      return 'preparing rows';
    case 'restoring-indexes':
      return 'restoring query indexes';
    case 'writing-analysis':
      return 'writing analysis summary';
    case 'writing-symbols':
      return 'writing symbols';
    case 'writing-lookups':
      return 'writing lookup keys';
    case 'writing-terms':
      return 'writing lexical terms';
    case 'writing-edges':
      return 'writing relationships';
    case 'writing-references':
      return 'writing references';
    case 'writing-receipt':
      return 'recording resumable batch';
    case 'writing-candidates':
      return 'writing reference candidates';
    case 'writing-facts':
      return 'writing graph facts';
    case 'committing':
      return 'committing batch';
  }
}

function graphMaterializationRows(rows: GraphMaterializationRows | undefined): string {
  if (!rows) return '';
  const values = [
    rows.symbols === undefined ? undefined : `${rows.symbols.toLocaleString()} symbols`,
    rows.lookupKeys === undefined ? undefined : `${rows.lookupKeys.toLocaleString()} lookup keys`,
    rows.terms === undefined ? undefined : `${rows.terms.toLocaleString()} terms`,
    rows.edges === undefined ? undefined : `${rows.edges.toLocaleString()} relationships`,
    rows.references === undefined ? undefined : `${rows.references.toLocaleString()} references`,
    rows.referenceCandidates === undefined ? undefined : `${rows.referenceCandidates.toLocaleString()} candidates`,
    rows.reexports === undefined ? undefined : `${rows.reexports.toLocaleString()} re-exports`,
    rows.deduplicatedEdges === undefined || rows.deduplicatedEdges === 0
      ? undefined
      : `${rows.deduplicatedEdges.toLocaleString()} repeated relationships collapsed`,
    rows.deduplicatedReferences === undefined || rows.deduplicatedReferences === 0
      ? undefined
      : `${rows.deduplicatedReferences.toLocaleString()} repeated resolution records collapsed`,
  ].filter((value): value is string => value !== undefined);
  return values.length > 0 ? ` · ${values.join(', ')}` : '';
}

function graphMaterializationDiskWarning(storage: GraphMaterializationStorage): string | undefined {
  if (
    storage.filesystemsShared === true &&
    storage.availableBytes !== undefined &&
    storage.estimatedRequiredBytes !== undefined &&
    storage.availableBytes < storage.estimatedRequiredBytes
  ) {
    return 'Low disk: shared TEMP and graph storage is below the conservative combined estimate.';
  }
  const scopes: string[] = [];
  if (
    storage.temporaryAvailableBytes !== undefined &&
    storage.estimatedTemporaryFilesystemRequiredBytes !== undefined &&
    storage.temporaryAvailableBytes < storage.estimatedTemporaryFilesystemRequiredBytes
  ) {
    scopes.push('SQLite TEMP');
  }
  if (
    storage.durableAvailableBytes !== undefined &&
    storage.estimatedDurableFilesystemRequiredBytes !== undefined &&
    storage.durableAvailableBytes < storage.estimatedDurableFilesystemRequiredBytes
  ) {
    scopes.push('graph database');
  }
  return scopes.length === 0 ? undefined : `Low disk: ${scopes.join(' and ')} storage is below its estimate.`;
}

function graphEtaBasisLabel(
  basis: 'cached-fact-bytes' | 'extraction-work' | 'files' | 'final-fact-bytes' | 'source-bytes',
): string {
  switch (basis) {
    case 'cached-fact-bytes':
      return 'cached-fact bytes';
    case 'final-fact-bytes':
      return 'final attributed fact bytes';
    case 'source-bytes':
      return 'source bytes';
    case 'extraction-work':
      return 'class-weighted extraction work';
    case 'files':
      return 'files';
  }
}

function formatGraphPercentage(completed: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.min(100, Math.max(0, (completed / total) * 100)).toFixed(1)}%`;
}

export function GraphEmptyState(props: {
  readonly configuredProjectCount?: number;
  readonly onOpenAdministration?: () => void;
  readonly state: 'building' | 'empty' | 'recovering' | 'retrying';
}): React.ReactElement {
  const building = props.state === 'building';
  const recovering = props.state === 'recovering';
  const retrying = props.state === 'retrying';
  const hasConfiguredProjects = (props.configuredProjectCount ?? 0) > 0;
  return (
    <div className="graph-empty">
      <span className="empty-orbit" aria-hidden="true" />
      <h3>
        {recovering
          ? 'Refreshing indexed repositories'
          : retrying
            ? 'Retrying indexed repositories'
            : building
              ? 'Building the first repository graph'
              : 'No indexed repositories yet'}
      </h3>
      <p>
        {recovering
          ? 'Threadnote is finishing graph maintenance. Existing indexes will return here automatically.'
          : retrying
            ? 'Threadnote is retrying the indexed repository catalog. Existing indexes will return here automatically.'
            : building
              ? 'The newest phase and counters appear above. A ready snapshot will open here automatically.'
              : hasConfiguredProjects
                ? `${props.configuredProjectCount?.toLocaleString()} configured project${props.configuredProjectCount === 1 ? ' is' : 's are'} ready to initialize from Manager.`
                : 'Build a native graph from a repository, then refresh this workspace.'}
      </p>
      {building || recovering || retrying ? null : hasConfiguredProjects ? (
        <button onClick={props.onOpenAdministration} type="button">
          Choose a configured project
        </button>
      ) : (
        <code>threadnote graph index</code>
      )}
    </div>
  );
}

function formatBuildDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return 'unknown';
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatGraphMilliseconds(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  if (milliseconds < 1) return '<1ms';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)}s`;
}

function formatGraphBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1_024;
  let unit = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1_024) break;
    value /= 1_024;
    unit = candidate;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}
