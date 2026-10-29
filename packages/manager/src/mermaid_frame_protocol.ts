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
  return (event: MermaidFrameMessage): void => {
    const host = runtime.host();
    const parent = runtime.parent();
    if (
      accepted ||
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
    if (
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
    accepted = true;
    rendering = rendering.then(async () => {
      try {
        document.documentElement.dataset.theme = theme;
        await runtime.render(source, id, theme, host);
        const reportSize = () =>
          runtime.postToParent({type: 'mermaid-result', id, ok: true, height: host.scrollHeight});
        reportSize();
        runtime.observeResize(reportSize, host);
      } catch {
        runtime.postToParent({type: 'mermaid-result', id, ok: false});
      }
    });
  };
}
