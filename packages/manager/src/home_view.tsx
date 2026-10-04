import React, {useEffect, useState} from 'react';
import type {ManagerHomeLane} from './home.js';
import {MemoryDetailModal} from './detail_modal.js';
import {HomeAttentionFlow} from './home_scene.js';
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
  project,
  projects,
}: {
  readonly onOpen: (target: 'context' | 'context-health' | 'memory' | 'reviews') => void;
  readonly onOpenMemory?: (uri: string) => void;
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
      <div className="home-head">
        <div>
          <p className="eyebrow">Project home</p>
          <h2>Pick up the work that needs attention.</h2>
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
          <HomeAttentionFlow
            input={{...(home.stats ?? {}), findings: healthFindingCount, decisions: home.stats?.decisionMemories}}
            onOpen={onOpen}
          />
          <section className="home-handoffs">
            <div className="home-lane-heading">
              <h3>Resume a handoff</h3>
              <button onClick={() => onOpen('memory')}>Open Library</button>
            </div>
            {home.stats?.memories === undefined ? (
              <p className="muted">Handoffs are unavailable. Refresh to retry.</p>
            ) : home.handoffs.length === 0 ? (
              <p className="muted">No active handoffs for {home.project}.</p>
            ) : (
              <ul>
                {home.handoffs.map(handoff => (
                  <li key={handoff.uri}>
                    <button className="home-handoff-button" onClick={() => setHandoff(handoff)} type="button">
                      <strong>{handoff.topic ?? 'Untitled handoff'}</strong>
                      <span>{new Date(handoff.timestamp).toLocaleString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
