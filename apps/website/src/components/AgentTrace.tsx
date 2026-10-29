import {Array as EffectArray} from 'effect';
import {useEffect, useMemo, useRef, useState} from 'react';

export type TraceStep = {
  kind: 'user' | 'tool' | 'result' | 'assistant' | 'action';
  actor: string;
  text: string;
  meta?: string;
  evidence?: string[];
};

export type TraceScenario = {
  eyebrow: string;
  title: string;
  description: string;
  steps: TraceStep[];
};

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reduced;
}

export function AgentTrace({
  scenario,
  autoPlay = true,
  compact = false,
}: {
  scenario: TraceScenario;
  autoPlay?: boolean;
  compact?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const [visibleCount, setVisibleCount] = useState(reducedMotion ? scenario.steps.length : 1);
  const [playing, setPlaying] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(!document.hidden);

  useEffect(() => {
    if (reducedMotion) {
      setVisibleCount(scenario.steps.length);
      setPlaying(false);
    } else {
      setVisibleCount(1);
      setPlaying(false);
      setHasPlayed(false);
    }
  }, [reducedMotion, scenario]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting === true), {threshold: 0.6});
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (autoPlay && inView && !hasPlayed && !reducedMotion) {
      setPlaying(true);
      setHasPlayed(true);
    }
  }, [autoPlay, hasPlayed, inView, reducedMotion]);

  useEffect(() => {
    if (!playing || !inView || !pageVisible || reducedMotion) return;
    if (visibleCount >= scenario.steps.length) {
      setPlaying(false);
      return;
    }
    const current = scenario.steps[visibleCount];
    const delay = current?.kind === 'result' ? 720 : current?.kind === 'tool' ? 900 : 1050;
    const timer = window.setTimeout(() => {
      setVisibleCount(count => Math.min(count + 1, scenario.steps.length));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [inView, pageVisible, playing, reducedMotion, scenario.steps, visibleCount]);

  const evidence = useMemo(() => {
    const evidenceItems = EffectArray.flatMap(scenario.steps.slice(0, visibleCount), step => step.evidence ?? []);
    return EffectArray.filter(evidenceItems, (item, index) => evidenceItems.indexOf(item) === index);
  }, [scenario.steps, visibleCount]);

  const replay = () => {
    if (reducedMotion) return;
    setVisibleCount(1);
    setPlaying(true);
    setHasPlayed(true);
  };

  const step = () => {
    if (reducedMotion) return;
    setPlaying(false);
    setVisibleCount(count => (count >= scenario.steps.length ? 1 : count + 1));
  };

  return (
    <div
      className={`agent-trace${compact ? ' agent-trace--compact' : ''}`}
      ref={rootRef}
      aria-label={`${scenario.title} agent workflow simulation`}
    >
      <header className="agent-trace__header">
        <div>
          <span className="eyebrow">{scenario.eyebrow}</span>
          <h3>{scenario.title}</h3>
          <p>{scenario.description}</p>
        </div>
        <div className="agent-trace__controls" aria-label="Simulation controls">
          <button type="button" onClick={replay} disabled={reducedMotion}>
            Replay
          </button>
          <button type="button" onClick={step} disabled={reducedMotion}>
            Step
          </button>
        </div>
      </header>
      <div className="agent-trace__body">
        <div className="trace-pane trace-pane--conversation">
          <div className="trace-pane__label">
            <span>Conversation</span>
            <span className={playing ? 'live-indicator live-indicator--active' : 'live-indicator'}>
              {playing ? 'running' : 'ready'}
            </span>
          </div>
          <ol className="trace-list" aria-live="polite">
            {EffectArray.map(scenario.steps, (item, index) => {
              const visible = index < visibleCount;
              if (item.kind === 'tool' || item.kind === 'result') return null;
              return (
                <li
                  key={`${item.actor}-${index}`}
                  className={`trace-message trace-message--${item.kind}${visible ? ' is-visible' : ''}`}
                  aria-hidden={!visible}
                >
                  <span>{item.actor}</span>
                  <p>{item.text}</p>
                  {item.meta && <code>{item.meta}</code>}
                </li>
              );
            })}
          </ol>
        </div>
        <div className="trace-pane trace-pane--tools">
          <div className="trace-pane__label">
            <span>MCP trace</span>
            <span>
              {Math.min(visibleCount, scenario.steps.length)}/{scenario.steps.length}
            </span>
          </div>
          <ol className="tool-trace" aria-label="Tool calls">
            {EffectArray.map(scenario.steps, (item, index) => {
              const visible = index < visibleCount;
              if (item.kind !== 'tool' && item.kind !== 'result') return null;
              return (
                <li
                  key={`${item.actor}-${index}`}
                  className={`tool-call tool-call--${item.kind}${visible ? ' is-visible' : ''}`}
                  aria-hidden={!visible}
                >
                  <div>
                    <span className="tool-call__icon" aria-hidden="true">
                      {item.kind === 'tool' ? '↗' : '↙'}
                    </span>
                    <strong>{item.actor}</strong>
                  </div>
                  <code>{item.text}</code>
                  {item.meta && <small>{item.meta}</small>}
                </li>
              );
            })}
          </ol>
        </div>
        <aside className="trace-pane trace-pane--evidence">
          <div className="trace-pane__label">
            <span>Evidence</span>
            <span>{evidence.length}</span>
          </div>
          {evidence.length ? (
            <ul className="evidence-list">
              {EffectArray.map(evidence, item => (
                <li key={item}>
                  <span aria-hidden="true">◆</span>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">Pointers and code evidence appear here.</p>
          )}
          <div className="privacy-badge">
            <span className="status-dot" />
            Local tools · external actions are explicit
          </div>
        </aside>
      </div>
    </div>
  );
}
