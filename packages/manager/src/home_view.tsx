import {FileText, HeartPulse, ListChecks, ScanText, Pencil, Blocks} from 'lucide-react';
import React, {useEffect, useState} from 'react';
import type {ManagerHomeLane} from './home.js';
import {MemoryDetailModal} from './detail_modal.js';
import {api} from './ui/support.js';

interface HomeResponse {
  readonly stats?: {
    readonly memories?: number;
    readonly coverage?: string;
    readonly scanned?: number;
    readonly pending?: number;
    readonly outcomes?: number;
    readonly decisionMemories?: number;
    readonly healthCoverage?: string;
  };
  readonly handoffs: readonly {readonly timestamp: string; readonly topic?: string; readonly uri: string}[];
  readonly lanes: readonly ManagerHomeLane[];
  readonly project: string;
  readonly version: 1;
}

export function ManagerHomePanel({
  onOpen,
  onProjectChange,
  onOpenMemory,
  onNewMemory,
  showProjectSelector = true,
  project,
  projects,
}: {
  readonly onOpen: (target: 'context' | 'context-health' | 'memory' | 'reviews' | 'worksets') => void;
  readonly onOpenMemory?: (uri: string) => void;
  readonly showProjectSelector?: boolean;
  readonly onNewMemory?: () => void;
  readonly onProjectChange: (project: string) => void;
  readonly project: string;
  readonly projects: readonly string[];
}): React.ReactElement {
  const [handoff, setHandoff] = useState<{uri: string; topic?: string}>();
  useEffect(() => setHandoff(undefined), [project]);
  const [home, setHome] = useState<HomeResponse | undefined>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setGeneration(value => value + 1);
    }, 30_000);
    return () => clearInterval(timer);
  }, []);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const healthFindingCount = home?.lanes.find(lane => lane.id === 'health')?.count;

  useEffect(() => {
    if (!project) {
      setHome(undefined);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<HomeResponse>(`/api/home?project=${encodeURIComponent(project)}`, undefined, {
      signal: controller.signal,
      timeoutMilliseconds: 8_000,
    })
      .then(result => {
        if (!cancelled && result.project === project) setHome(result);
      })
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [project, generation]);

  return (
    <section aria-busy={loading} className="panel home-panel is-active">
      {showProjectSelector ? (
        <div className="home-head">
          <div>
            <p className="eyebrow">Project home</p>
            <h2>Your workspace, in context.</h2>
            <p className="muted">Your project’s living context, recent outcomes, and next decisions.</p>
          </div>
          <label>
            Project
            <select aria-label="Home project" onChange={event => onProjectChange(event.target.value)} value={project}>
              <option value="">Select project</option>
              {projects.map(item => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {projects.length === 0 ? (
        <div className="home-empty">
          <h3>No project records yet</h3>
          <p>Open Context to create a scoped brief, or Library to save the first project memory.</p>
          <div className="action-row">
            <button onClick={() => onOpen('context')}>Open Context</button>
            <button onClick={() => onOpen('memory')}>Open Library</button>
          </div>
        </div>
      ) : error ? (
        <div className="home-empty" role="alert">
          <h3>Project home is unavailable</h3>
          <p>{error}</p>
        </div>
      ) : home ? (
        <>
          <div className="home-overview" aria-label="Project overview">
            <button onClick={() => onOpen('memory')}>
              <span>Memories</span>
              <strong>{home.stats?.memories ?? '—'}</strong>
              <small>Your project’s saved context</small>
            </button>
            <button onClick={() => onOpen('reviews')}>
              <span>Awaiting review</span>
              <strong>{home.stats?.pending ?? '—'}</strong>
              <small>Proposed knowledge to consider</small>
            </button>
            <button onClick={() => onOpen('context-health')}>
              <span>Health findings</span>
              <strong>{healthFindingCount ?? '—'}</strong>
              <small>Context that needs attention</small>
            </button>
          </div>
          <section className="workspace-card home-next-actions">
            <header>
              <h3>Next up</h3>
            </header>
            {home.lanes
              .filter(lane => lane.id === 'reviews' || lane.id === 'health')
              .map(lane => (
                <div className="workspace-row" key={lane.id}>
                  {lane.id === 'reviews' ? <ListChecks aria-hidden="true" /> : <HeartPulse aria-hidden="true" />}
                  <div className="row-copy">
                    <strong>
                      {lane.id === 'reviews' ? 'Review proposed knowledge' : 'Check context that needs a decision'}
                    </strong>
                    <p>{lane.detail}</p>
                  </div>
                  {lane.count !== undefined ? (
                    <span className={`workspace-status ${lane.status === 'attention' ? 'warn' : 'neutral'}`}>
                      {lane.count} {lane.id === 'reviews' ? 'reviews' : 'decisions'}
                    </span>
                  ) : null}
                  <button onClick={() => onOpen(lane.action)}>{lane.id === 'reviews' ? 'Review' : 'Inspect'}</button>
                </div>
              ))}
            <div className="workspace-row">
              <Pencil aria-hidden="true" />
              <div className="row-copy">
                <strong>Capture knowledge in your own words</strong>
                <p>Save a decision, preference, or handoff for your next session.</p>
              </div>
              <button onClick={() => (onNewMemory ? onNewMemory() : onOpen('memory'))}>New memory</button>
            </div>
          </section>
          <section className="workspace-card home-handoffs">
            <header>
              <h3>Resume work</h3>
              <button onClick={() => onOpen('memory')}>Open Library</button>
            </header>
            {home.stats?.memories === undefined && home.handoffs.length === 0 ? (
              <p className="workspace-empty">Handoffs are unavailable. Refresh to retry.</p>
            ) : home.handoffs.length === 0 ? (
              <p className="workspace-empty">No active handoffs for {home.project}.</p>
            ) : (
              <ul>
                {home.handoffs.map(handoff => (
                  <li className="workspace-row" key={handoff.uri}>
                    <FileText aria-hidden="true" />
                    <button className="home-handoff-button" onClick={() => setHandoff(handoff)} type="button">
                      <strong>{handoff.topic ?? 'Untitled handoff'}</strong>
                      <span>{new Date(handoff.timestamp).toLocaleString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="workspace-row">
              <ScanText aria-hidden="true" />
              <div className="row-copy">
                <strong>Start with a scoped brief</strong>
                <p>Bring relevant graph and memory evidence into your next task.</p>
              </div>
              <button onClick={() => onOpen('context')}>Open Context</button>
            </div>
          </section>
          <div className="workspace-row home-project-setup">
            <Blocks />
            <div className="row-copy">
              <strong>Project setup</strong>
              <p>Connect repositories, prepare worksets, and configure source material.</p>
            </div>
            <button onClick={() => onOpen('worksets')}>Manage projects</button>
          </div>
        </>
      ) : (
        <div className="home-empty">Loading project home…</div>
      )}
      {handoff ? (
        <MemoryDetailModal
          key={handoff.uri}
          uri={handoff.uri}
          title={handoff.topic ?? 'Handoff'}
          onClose={() => setHandoff(undefined)}
          onOpenLibrary={uri => {
            setHandoff(undefined);
            if (onOpenMemory) onOpenMemory(uri);
            else onOpen('memory');
          }}
        />
      ) : null}
    </section>
  );
}
