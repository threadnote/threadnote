import React, {useCallback, useEffect, useId, useRef, useState} from 'react';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function resolvedTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function MermaidBlock({
  source,
  expandable = false,
}: {
  readonly source: string;
  readonly expandable?: boolean;
}): React.ReactElement {
  const [theme, setTheme] = useState(resolvedTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(resolvedTheme()));
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
    return () => observer.disconnect();
  }, []);
  return <MermaidPreview key={theme + source} source={source} theme={theme} expandable={expandable} />;
}

type Theme = 'light' | 'dark';

function useMermaidFrame(source: string, theme: Theme, viewer = false) {
  const id = 'mermaid-' + Effect.pipe(useId(), EffectString.replace(/[^a-zA-Z0-9-]/gu, ''));
  const frame = useRef<HTMLIFrameElement>(null);
  const sent = useRef(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [height, setHeight] = useState(240);
  const [size, setSize] = useState<{readonly width: number; readonly height: number}>();
  useEffect(() => {
    const timer = window.setTimeout(() => setState('error'), 15_000);
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || typeof event.data !== 'object' || event.data === null)
        return;
      const data = event.data;
      if (
        !('type' in data) ||
        data.type !== 'mermaid-result' ||
        !('id' in data) ||
        data.id !== id ||
        !('ok' in data) ||
        typeof data.ok !== 'boolean'
      )
        return;
      if (data.ok) {
        if (!('height' in data) || typeof data.height !== 'number' || !Number.isFinite(data.height)) return;
        if (viewer) {
          if (
            !('width' in data) ||
            typeof data.width !== 'number' ||
            !Number.isFinite(data.width) ||
            data.width <= 0 ||
            !('diagramHeight' in data) ||
            typeof data.diagramHeight !== 'number' ||
            !Number.isFinite(data.diagramHeight) ||
            data.diagramHeight <= 0
          )
            return;
          setSize({width: data.width, height: data.diagramHeight});
        } else {
          setHeight(Math.max(80, Math.min(1200, data.height + 24)));
        }
      }
      window.clearTimeout(timer);
      setState(data.ok ? 'ready' : 'error');
    };
    window.addEventListener('message', receive);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
  }, [id, viewer]);

  return {
    state,
    height,
    size,
    id,
    frame,
    frameProps: {
      ref: frame,
      src: '/mermaid.html',
      sandbox: 'allow-scripts',
      className: state === 'ready' ? 'mermaid-frame' : 'mermaid-frame is-loading',
      onLoad: () => {
        if (sent.current) {
          setState('error');
          return;
        }
        sent.current = true;
        frame.current?.contentWindow?.postMessage({type: 'render-mermaid', id, source, theme, viewer}, '*');
      },
    },
  };
}

function MermaidPreview({
  source,
  theme,
  expandable,
}: {
  readonly source: string;
  readonly theme: Theme;
  readonly expandable: boolean;
}): React.ReactElement {
  const {state, height, frameProps} = useMermaidFrame(source, theme);
  const [viewerOpen, setViewerOpen] = useState(false);
  const canOpen = expandable && state === 'ready';
  return (
    <section className="mermaid-block" aria-label="Mermaid diagram and source">
      {state !== 'error' ? (
        <div className="mermaid-preview">
          <iframe {...frameProps} title="Mermaid diagram" tabIndex={canOpen ? -1 : undefined} style={{height}} />
          {canOpen ? (
            <button
              className="mermaid-preview-open"
              type="button"
              aria-haspopup="dialog"
              onClick={() => setViewerOpen(true)}
            >
              <span>Open full-screen diagram</span>
            </button>
          ) : null}
        </div>
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
      {viewerOpen ? <MermaidViewer source={source} theme={theme} onClose={() => setViewerOpen(false)} /> : null}
    </section>
  );
}

function MermaidViewer({
  source,
  theme,
  onClose,
}: {
  readonly source: string;
  readonly theme: Theme;
  readonly onClose: () => void;
}): React.ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [zoom, setZoom] = useState(100);
  const {state, size, id, frame, frameProps} = useMermaidFrame(source, theme, true);
  const viewport = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({width: 0, height: 0});
  useEffect(() => {
    dialog.current?.showModal();
    const element = viewport.current;
    if (!element) return;
    const readSize = () => setViewportSize({width: element.clientWidth, height: element.clientHeight});
    const observer = new ResizeObserver(readSize);
    observer.observe(element);
    readSize();
    return () => observer.disconnect();
  }, []);
  const scale = zoom / 100;
  const showViewport = useCallback(() => {
    const element = viewport.current;
    if (state !== 'ready' || !element || !viewportSize.width || !viewportSize.height) return;
    frame.current?.contentWindow?.postMessage(
      {
        type: 'mermaid-viewport',
        id,
        x: element.scrollLeft / scale,
        y: element.scrollTop / scale,
        width: viewportSize.width / scale,
        height: viewportSize.height / scale,
      },
      '*',
    );
  }, [frame, id, scale, state, viewportSize]);
  useEffect(showViewport, [showViewport]);
  return (
    <dialog ref={dialog} className="mermaid-viewer" aria-labelledby={title} onClose={onClose}>
      <div className="mermaid-viewer-toolbar">
        <button type="button" onClick={() => dialog.current?.close()}>
          Close diagram
        </button>
        <h3 id={title}>Full-screen diagram</h3>
        <div role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={state !== 'ready' || zoom <= 25}
            onClick={() => setZoom(zoom - 25)}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            disabled={state !== 'ready' || zoom === 100}
            onClick={() => setZoom(100)}
          >
            {zoom}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={state !== 'ready' || zoom >= 300}
            onClick={() => setZoom(zoom + 25)}
          >
            +
          </button>
        </div>
      </div>
      <div
        ref={viewport}
        className="mermaid-viewer-viewport"
        aria-label="Scrollable diagram"
        role="region"
        tabIndex={0}
        onScroll={showViewport}
      >
        {state !== 'error' ? (
          <div
            className="mermaid-viewer-canvas"
            style={{
              width: Math.max(viewportSize.width, Math.ceil((size?.width ?? 0) * scale)),
              height: Math.max(viewportSize.height, Math.ceil((size?.height ?? 0) * scale)),
            }}
          >
            <iframe
              {...frameProps}
              title="Full-screen Mermaid diagram"
              tabIndex={-1}
              style={{width: viewportSize.width, height: viewportSize.height}}
            />
          </div>
        ) : null}
        {state !== 'ready' ? (
          <p role="status">{state === 'error' ? 'Unable to render the full-screen diagram.' : 'Rendering diagram…'}</p>
        ) : null}
      </div>
    </dialog>
  );
}
