import {renderMermaid} from './mermaid_renderer.js';
import {createMermaidFrameMessageHandler} from './mermaid_frame_protocol.js';

const host = document.getElementById('diagram');
const handleMessage = createMermaidFrameMessageHandler({
  self: () => window,
  parent: () => window.parent,
  origin: () => window.origin,
  pageOrigin: () => window.location.origin,
  host: () => host,
  render: renderMermaid,
  postToParent: message => window.parent.postMessage(message, '*'),
  observeResize: (callback, element) => new ResizeObserver(callback).observe(element),
});

window.addEventListener('message', event => handleMessage(event));
