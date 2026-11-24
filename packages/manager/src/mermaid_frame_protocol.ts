export interface MermaidFrameProtocolRuntime {
  readonly self: () => unknown;
  readonly parent: () => unknown;
  readonly origin: () => string;
  readonly pageOrigin: () => string;
  readonly host: () => HTMLElement | null;
  readonly render: (source: string, id: string, theme: 'light' | 'dark', host: HTMLElement) => Promise<void>;
  readonly postToParent: (message: unknown) => void;
  readonly observeResize: (callback: () => void, host: HTMLElement) => void;
}

export interface MermaidFrameMessage {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}

export function createMermaidFrameMessageHandler(runtime: MermaidFrameProtocolRuntime) {
  let rendering = Promise.resolve();
  let accepted = false;
  let view: {readonly id: string; readonly svg: SVGSVGElement; readonly x: number; readonly y: number} | undefined;
  return (event: MermaidFrameMessage): void => {
    const host = runtime.host();
    const parent = runtime.parent();
    if (
      parent === runtime.self() ||
      runtime.origin() !== 'null' ||
      event.origin !== runtime.pageOrigin() ||
      event.source !== parent ||
      !host ||
      typeof event.data !== 'object' ||
      event.data === null
    )
      return;
    const data = event.data;
    if ('type' in data && data.type === 'mermaid-viewport') {
      if (
        !view ||
        !('id' in data) ||
        data.id !== view.id ||
        !('x' in data) ||
        typeof data.x !== 'number' ||
        !Number.isFinite(data.x) ||
        data.x < 0 ||
        !('y' in data) ||
        typeof data.y !== 'number' ||
        !Number.isFinite(data.y) ||
        data.y < 0 ||
        !('width' in data) ||
        typeof data.width !== 'number' ||
        !Number.isFinite(data.width) ||
        data.width <= 0 ||
        !('height' in data) ||
        typeof data.height !== 'number' ||
        !Number.isFinite(data.height) ||
        data.height <= 0
      )
        return;
      view.svg.setAttribute('viewBox', `${view.x + data.x} ${view.y + data.y} ${data.width} ${data.height}`);
      return;
    }
    if (
      accepted ||
      !('type' in data) ||
      data.type !== 'render-mermaid' ||
      !('id' in data) ||
      typeof data.id !== 'string' ||
      data.id.length > 128 ||
      !/^mermaid-[a-zA-Z0-9-]+$/u.test(data.id) ||
      !('source' in data) ||
      typeof data.source !== 'string' ||
      !('theme' in data) ||
      (data.theme !== 'light' && data.theme !== 'dark')
    )
      return;
    const {id, source, theme} = data;
    const viewer = 'viewer' in data && data.viewer === true;
    accepted = true;
    rendering = rendering.then(async () => {
      try {
        document.documentElement.dataset.theme = theme;
        await runtime.render(source, id, theme, host);
        const reportSize = () =>
          runtime.postToParent({type: 'mermaid-result', id, ok: true, height: host.scrollHeight});
        if (viewer) {
          const svg = host.querySelector('svg');
          const box = svg?.viewBox.baseVal;
          if (!svg || !box || box.width <= 0 || box.height <= 0) throw new Error('Diagram dimensions are unavailable.');
          view = {id, svg, x: box.x, y: box.y};
          document.body.style.setProperty('padding', '0');
          svg.style.setProperty('display', 'block');
          svg.style.setProperty('width', '100vw');
          svg.style.setProperty('height', '100vh');
          svg.style.setProperty('max-width', 'none');
          runtime.postToParent({
            type: 'mermaid-result',
            id,
            ok: true,
            height: host.scrollHeight,
            width: box.width,
            diagramHeight: box.height,
          });
          return;
        }
        reportSize();
        runtime.observeResize(reportSize, host);
      } catch {
        runtime.postToParent({type: 'mermaid-result', id, ok: false});
      }
    });
  };
}
