import React, {useEffect, useId, useRef, useState} from 'react';

function resolvedTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function MermaidBlock({source}: {readonly source: string}): React.ReactElement {
  const [theme, setTheme] = useState(resolvedTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(resolvedTheme()));
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
    return () => observer.disconnect();
  }, []);
  return <MermaidFrame key={theme + source} source={source} theme={theme} />;
}

function MermaidFrame({
  source,
  theme,
}: {
  readonly source: string;
  readonly theme: 'light' | 'dark';
}): React.ReactElement {
  const id = 'mermaid-' + useId().replace(/[^a-zA-Z0-9-]/gu, '');
  const frame = useRef<HTMLIFrameElement>(null);
  const sent = useRef(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [height, setHeight] = useState(240);
  useEffect(() => {
    const timer = window.setTimeout(() => setState('error'), 15_000);
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || typeof event.data !== 'object' || event.data === null)
        return;
      const data = event.data as Record<string, unknown>;
      if (data.type !== 'mermaid-result' || data.id !== id || typeof data.ok !== 'boolean') return;
      if (data.ok && (typeof data.height !== 'number' || !Number.isFinite(data.height))) return;
      window.clearTimeout(timer);
      if (data.ok) setHeight(Math.max(80, Math.min(1200, Number(data.height) + 24)));
      setState(data.ok ? 'ready' : 'error');
    };
    window.addEventListener('message', receive);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
  }, [id]);
  return (
    <section className="mermaid-block" aria-label="Mermaid diagram and source">
      {state !== 'error' ? (
        <iframe
          ref={frame}
          title="Mermaid diagram"
          src="/mermaid.html"
          sandbox="allow-scripts"
          className={state === 'ready' ? 'mermaid-frame' : 'mermaid-frame is-loading'}
          style={{height}}
          onLoad={() => {
            if (sent.current) {
              setState('error');
              return;
            }
            sent.current = true;
            frame.current?.contentWindow?.postMessage({type: 'render-mermaid', id, source, theme}, '*');
          }}
        />
      ) : null}
      {state !== 'ready' ? (
        <p role="status">
          {state === 'loading' ? 'Rendering diagram…' : 'Unable to render this diagram. Its source is available below.'}
        </p>
      ) : null}
      <details key={state} open={state !== 'ready'}>
        <summary>Show source</summary>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </details>
    </section>
  );
}
