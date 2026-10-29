import {Array as EffectArray, Option as EffectOption} from 'effect';
import {lazy, Suspense, useMemo, useState} from 'react';

import {
  managerDemoChecks,
  managerDemoEdges,
  managerDemoMemories,
  managerDemoNodes,
  managerDemoShares,
  managerDemoTabs,
  managerDemoTools,
  type ManagerDemoGraphEdge,
  type ManagerDemoGraphNode,
  type ManagerDemoTabId,
} from '../content/managerDemo';
import {docsArticleHref, siteHref} from '../lib/site';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const ManagerGraphScene = lazy(() => import('../visuals/ManagerGraphScene'));
const DEMO_ONLY = 'Available in the real Threadnote Manager';

const RELATION_LABELS = {
  calls: 'calls',
  conforms_to: 'conforms to',
  implements: 'implements',
  imports: 'imports',
  uses: 'uses',
} as const;

function tabId(tab: ManagerDemoTabId): string {
  return `manager-demo-tab-${tab}`;
}

function panelId(tab: ManagerDemoTabId): string {
  return `manager-demo-panel-${tab}`;
}

function NodeInspector({node}: {readonly node: ManagerDemoGraphNode}): React.ReactElement {
  const relationships = EffectArray.map(
    EffectArray.filter(managerDemoEdges, edge => edge.source === node.id || edge.target === node.id),
    edge => {
      const outgoing = edge.source === node.id;
      const relatedId = outgoing ? edge.target : edge.source;
      return {
        ...edge,
        direction: outgoing ? 'outgoing' : 'incoming',
        related: EffectOption.getOrUndefined(
          EffectArray.findFirst(managerDemoNodes, candidate => candidate.id === relatedId),
        ),
      } as const;
    },
  );

  return (
    <aside aria-label={`Details for ${node.label}`} className="manager-demo-inspector">
      <div className="manager-demo-inspector-heading">
        <span className="manager-demo-node-kind">{node.kind}</span>
        <span className={`manager-demo-language manager-demo-language-${node.tone}`}>{node.language}</span>
      </div>
      <h4>{node.label}</h4>
      <code>{node.signature}</code>
      <dl className="manager-demo-detail-list">
        <div>
          <dt>Project</dt>
          <dd>{node.project}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{node.path}</dd>
        </div>
        <div>
          <dt>Visibility</dt>
          <dd>{node.exported ? 'Exported' : 'Internal'}</dd>
        </div>
        <div>
          <dt>Connections</dt>
          <dd>{node.connections}</dd>
        </div>
      </dl>
      <div className="manager-demo-relationships">
        <div className="manager-demo-section-heading">
          <span>Relationships</span>
          <span>{relationships.length}</span>
        </div>
        <ul>
          {EffectArray.map(relationships, relationship => (
            <li key={`${relationship.source}:${relationship.relation}:${relationship.target}`}>
              <span
                aria-label={`${relationship.provenance} relationship`}
                className={`manager-demo-provenance manager-demo-provenance-${relationship.provenance}`}
              />
              <div>
                <span>
                  {relationship.direction === 'outgoing' ? '→' : '←'} {RELATION_LABELS[relationship.relation]}
                </span>
                <strong>{relationship.related?.label ?? 'External symbol'}</strong>
              </div>
              <small>{Math.round(relationship.confidence * 100)}%</small>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function GraphPanel(): React.ReactElement {
  const [selectedNodeId, setSelectedNodeId] = useState('auth-contract');
  const [project, setProject] = useState('all');
  const [relation, setRelation] = useState<ManagerDemoGraphEdge['relation'] | 'all'>('all');
  const [nodeQuery, setNodeQuery] = useState('');
  const selectedNode =
    EffectOption.getOrUndefined(EffectArray.findFirst(managerDemoNodes, node => node.id === selectedNodeId)) ??
    managerDemoNodes[0];
  const visibleNodes = useMemo(() => {
    const normalizedQuery = Effect.pipe(nodeQuery, EffectString.trim, EffectString.toLocaleLowerCase());
    return EffectArray.filter(managerDemoNodes, node => {
      if (project !== 'all' && node.project !== project) return false;
      if (!normalizedQuery) return true;
      return Effect.pipe(
        EffectArray.join([node.label, node.path, node.kind, node.language, node.project, node.signature], ' '),
        EffectString.toLocaleLowerCase(),
        EffectString.includes(normalizedQuery),
      );
    });
  }, [nodeQuery, project]);
  const projects = [...new Set(EffectArray.map(managerDemoNodes, node => node.project))];
  const chooseProject = (nextProject: string): void => {
    setProject(nextProject);
    if (nextProject === 'all') return;
    const firstNode = EffectOption.getOrUndefined(
      EffectArray.findFirst(managerDemoNodes, node => node.project === nextProject),
    );
    if (firstNode) setSelectedNodeId(firstNode.id);
  };

  return (
    <div className="manager-demo-graph-workspace">
      <div className="manager-demo-workspace-heading">
        <div>
          <p className="manager-demo-eyebrow">Native code intelligence</p>
          <h3>Knowledge graph</h3>
          <p>Explore the current repository snapshot from workspace boundaries down to source symbols.</p>
        </div>
        <button disabled title={DEMO_ONLY} type="button">
          Refresh indexes
        </button>
      </div>

      <div className="manager-demo-toolbar">
        <label>
          <span>Repository</span>
          <select defaultValue="commerce-platform" disabled title={DEMO_ONLY}>
            <option value="commerce-platform">acme/commerce-platform</option>
          </select>
        </label>
        <label>
          <span>Project</span>
          <select onChange={event => chooseProject(event.target.value)} value={project}>
            <option value="all">All projects</option>
            {EffectArray.map(projects, item => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="manager-demo-search">
          <span>Find a node</span>
          <input
            aria-controls="manager-demo-node-results"
            onChange={event => setNodeQuery(event.target.value)}
            placeholder="Name, path, or symbol"
            type="search"
            value={nodeQuery}
          />
        </label>
        <div aria-label="Graph rendering status" className="manager-demo-graph-stats">
          <span>18,248 nodes</span>
          <span>42,906 links</span>
          <span className="manager-demo-gpu-badge">WebGL</span>
        </div>
      </div>

      <div className="manager-demo-filterbar">
        <span>Relationship</span>
        {EffectArray.map(['all', 'calls', 'conforms_to', 'implements', 'imports', 'uses'] as const, item => (
          <button aria-pressed={relation === item} key={item} onClick={() => setRelation(item)} type="button">
            {item === 'all' ? 'All' : RELATION_LABELS[item]}
          </button>
        ))}
        <span className="manager-demo-filter-note">
          <i className="manager-demo-authoritative-key" /> authoritative
          <i className="manager-demo-heuristic-key" /> heuristic
        </span>
      </div>

      <div className="manager-demo-graph-body">
        <section aria-label="Interactive polyglot graph preview" className="manager-demo-graph-stage">
          <Suspense
            fallback={
              <div aria-live="polite" className="manager-demo-scene-status" role="status">
                Loading the WebGL preview…
              </div>
            }
          >
            <ManagerGraphScene project={project} relation={relation} selectedNodeId={selectedNode.id} />
          </Suspense>
          <div
            aria-label={`${visibleNodes.length} matching graph nodes`}
            className="manager-demo-node-strip"
            id="manager-demo-node-results"
          >
            {visibleNodes.length ? (
              EffectArray.map(visibleNodes, node => (
                <button
                  aria-pressed={node.id === selectedNode.id}
                  className={`manager-demo-node-button manager-demo-node-${node.tone}`}
                  key={node.id}
                  onClick={() => setSelectedNodeId(node.id)}
                  type="button"
                >
                  <span className="manager-demo-node-dot" />
                  <span>
                    <strong>{node.label}</strong>
                    <small>
                      {node.language} · {node.kind}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <p className="manager-demo-node-empty" role="status">
                No matching nodes
              </p>
            )}
          </div>
        </section>
        <NodeInspector node={selectedNode} />
      </div>

      <footer className="manager-demo-graph-footer">
        <span>Snapshot cgsn_72bd43 · commit 4f72c9e + worktree</span>
        <span>12 projects · TypeScript · Kotlin · Swift · Java</span>
      </footer>
    </div>
  );
}

function MemoryPanel(): React.ReactElement {
  return (
    <div className="manager-demo-list-panel">
      <div className="manager-demo-workspace-heading">
        <div>
          <p className="manager-demo-eyebrow">Local-first context</p>
          <h3>Memory</h3>
          <p>Inspect the durable knowledge and handoffs available to your coding agents.</p>
        </div>
        <button disabled title={DEMO_ONLY} type="button">
          New memory
        </button>
      </div>
      <div className="manager-demo-metric-row">
        <article>
          <span>Canonical</span>
          <strong>1,284</strong>
          <small>memories</small>
        </article>
        <article>
          <span>Active</span>
          <strong>92%</strong>
          <small>of durable context</small>
        </article>
        <article>
          <span>Indexed</span>
          <strong>6,412</strong>
          <small>vector chunks</small>
        </article>
      </div>
      <div className="manager-demo-table">
        <div className="manager-demo-table-head">
          <span>Memory</span>
          <span>Project</span>
          <span>Status</span>
          <span>Updated</span>
        </div>
        {EffectArray.map(managerDemoMemories, memory => (
          <article key={memory.uri}>
            <div>
              <strong>{memory.topic}</strong>
              <p>{memory.summary}</p>
              <code>{memory.uri}</code>
            </div>
            <span>{memory.project}</span>
            <span className={`manager-demo-status manager-demo-status-${memory.status}`}>{memory.status}</span>
            <span>{memory.updated}</span>
          </article>
        ))}
      </div>
    </div>
  );
}

function SharesPanel(): React.ReactElement {
  return (
    <div className="manager-demo-list-panel">
      <div className="manager-demo-workspace-heading">
        <div>
          <p className="manager-demo-eyebrow">Explicit collaboration</p>
          <h3>Shares</h3>
          <p>Publish selected knowledge to teams while personal context stays private by default.</p>
        </div>
        <button disabled title={DEMO_ONLY} type="button">
          Configure share
        </button>
      </div>
      <div className="manager-demo-share-grid">
        {EffectArray.map(managerDemoShares, share => (
          <article key={share.label}>
            <header>
              <span className="manager-demo-share-mark" />
              <div>
                <strong>{share.label}</strong>
                <small>{share.direction}</small>
              </div>
              <span className="manager-demo-status manager-demo-status-synced">{share.status}</span>
            </header>
            <strong>{share.memories}</strong>
            <span>shared memories</span>
            <footer>
              <span>Last sync {share.updated}</span>
              <button disabled title={DEMO_ONLY} type="button">
                Sync now
              </button>
            </footer>
          </article>
        ))}
      </div>
      <div className="manager-demo-callout">
        <span>Privacy boundary</span>
        <p>Only configured memories cross this boundary. Handoffs and preferences never publish automatically.</p>
      </div>
    </div>
  );
}

function DoctorPanel(): React.ReactElement {
  return (
    <div className="manager-demo-list-panel">
      <div className="manager-demo-workspace-heading">
        <div>
          <p className="manager-demo-eyebrow">Runtime health</p>
          <h3>Doctor</h3>
          <p>One view for storage, indexes, local models, MCP clients, and agent instructions.</p>
        </div>
        <button disabled title={DEMO_ONLY} type="button">
          Run checks
        </button>
      </div>
      <div className="manager-demo-doctor-summary">
        <span className="manager-demo-health-orbit">5</span>
        <div>
          <strong>All systems healthy</strong>
          <span>Self-contained runtime · no daemon · no Python</span>
        </div>
      </div>
      <ul className="manager-demo-check-list">
        {EffectArray.map(managerDemoChecks, check => (
          <li key={check.label}>
            <span className="manager-demo-check-icon">✓</span>
            <div>
              <strong>{check.label}</strong>
              <span>{check.detail}</span>
            </div>
            <span className="manager-demo-status manager-demo-status-healthy">{check.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolsPanel(): React.ReactElement {
  return (
    <div className="manager-demo-list-panel">
      <div className="manager-demo-workspace-heading">
        <div>
          <p className="manager-demo-eyebrow">Agent surfaces</p>
          <h3>Tools</h3>
          <p>Discover the MCP and CLI operations available in the self-contained runtime.</p>
        </div>
        <button disabled title={DEMO_ONLY} type="button">
          Copy setup
        </button>
      </div>
      <div className="manager-demo-tools-grid">
        {EffectArray.map(managerDemoTools, tool => (
          <article key={tool.name}>
            <span>{tool.surface}</span>
            <code>{tool.name}</code>
            <p>{tool.description}</p>
            <a href={docsArticleHref(tool.surface === 'MCP' ? 'mcp-reference' : 'cli-reference')}>View docs →</a>
          </article>
        ))}
      </div>
    </div>
  );
}

function ActivePanel({tab}: {readonly tab: ManagerDemoTabId}): React.ReactElement {
  switch (tab) {
    case 'graph':
      return <GraphPanel />;
    case 'memory':
      return <MemoryPanel />;
    case 'shares':
      return <SharesPanel />;
    case 'doctor':
      return <DoctorPanel />;
    case 'tools':
      return <ToolsPanel />;
  }
}

export function ManagerMock(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ManagerDemoTabId>('graph');

  const moveTab = (direction: -1 | 1): void => {
    const current = EffectOption.getOrElse(
      EffectArray.findFirstIndex(managerDemoTabs, tab => tab.id === activeTab),
      () => -1,
    );
    const next = (current + direction + managerDemoTabs.length) % managerDemoTabs.length;
    const nextTab = managerDemoTabs[next];
    setActiveTab(nextTab.id);
    document.getElementById(tabId(nextTab.id))?.focus();
  };

  return (
    <section aria-label="Threadnote Manager interactive mock" className="manager-demo-frame" data-mock="true">
      <div className="manager-demo-notice" role="note">
        <span>Interactive demo</span>
        <strong>Mock data — no local files read</strong>
      </div>
      <div className="manager-demo-app">
        <aside className="manager-demo-sidebar">
          <div className="manager-demo-brand">
            <img alt="" className="manager-demo-brand-mark" src={siteHref('threadnote-logo.svg')} />
            <div>
              <strong>Threadnote</strong>
              <span>Manager</span>
            </div>
          </div>
          <p className="manager-demo-sidebar-label">Workspace</p>
          <div aria-label="Manager sections" className="manager-demo-tabs" role="tablist">
            {EffectArray.map(managerDemoTabs, tab => (
              <button
                aria-controls={panelId(tab.id)}
                aria-label={`${tab.label}, ${tab.count}`}
                aria-selected={activeTab === tab.id}
                id={tabId(tab.id)}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    moveTab(1);
                  }
                  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    moveTab(-1);
                  }
                }}
                role="tab"
                tabIndex={activeTab === tab.id ? 0 : -1}
                type="button"
              >
                <span aria-hidden="true" className={`manager-demo-tab-icon manager-demo-tab-icon-${tab.id}`} />
                <span>{tab.label}</span>
                <small>{tab.count}</small>
              </button>
            ))}
          </div>
          <div className="manager-demo-runtime">
            <span className="manager-demo-runtime-light" />
            <div>
              <strong>Local runtime</strong>
              <span>ready · 4.1.0</span>
            </div>
          </div>
        </aside>

        <div
          aria-labelledby={tabId(activeTab)}
          className="manager-demo-main"
          id={panelId(activeTab)}
          role="tabpanel"
          tabIndex={0}
        >
          <header className="manager-demo-topbar">
            <div>
              <span className="manager-demo-breadcrumb">~/.threadnote</span>
              <span>/</span>
              <strong>
                {
                  EffectOption.getOrUndefined(EffectArray.findFirst(managerDemoTabs, tab => tab.id === activeTab))
                    ?.label
                }
              </strong>
            </div>
            <div>
              <span className="manager-demo-index-state">Indexes current</span>
              <button aria-label="Manager settings" disabled title={DEMO_ONLY} type="button">
                ···
              </button>
            </div>
          </header>
          <ActivePanel tab={activeTab} />
        </div>
      </div>
    </section>
  );
}
