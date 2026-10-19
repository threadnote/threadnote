import {renderMermaid} from './mermaid_renderer.js';

const host = document.getElementById('diagram');
let rendering = Promise.resolve();
let accepted = false;

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (
    accepted ||
    window.parent === window ||
    window.origin !== 'null' ||
    event.origin !== window.location.origin ||
    event.source !== window.parent ||
    !host ||
    typeof event.data !== 'object' ||
    event.data === null
  )
    return;
  const data = event.data as Record<string, unknown>;
  if (
    data.type !== 'render-mermaid' ||
    typeof data.id !== 'string' ||
    data.id.length > 128 ||
    !/^mermaid-[a-zA-Z0-9-]+$/u.test(data.id) ||
    typeof data.source !== 'string' ||
    (data.theme !== 'light' && data.theme !== 'dark')
  )
    return;
  const {id, source, theme} = data;
  accepted = true;
  rendering = rendering.then(async () => {
    try {
      document.documentElement.dataset.theme = theme;
      await renderMermaid(source, id, theme, host);
      const reportSize = () =>
        window.parent.postMessage({type: 'mermaid-result', id, ok: true, height: host.scrollHeight}, '*');
      reportSize();
      new ResizeObserver(reportSize).observe(host);
    } catch {
      window.parent.postMessage({type: 'mermaid-result', id, ok: false}, '*');
    }
  });
});
