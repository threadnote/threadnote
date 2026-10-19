import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

export const MERMAID_MAX_TEXT_SIZE = 50_000;
const MERMAID_MAX_EDGES = 500;

export async function renderMermaid(
  source: string,
  id: string,
  theme: 'light' | 'dark',
  host: HTMLElement,
): Promise<void> {
  if (!source.trim() || source.length > MERMAID_MAX_TEXT_SIZE) throw new Error('Diagram source is empty or too large.');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: MERMAID_MAX_TEXT_SIZE,
    maxEdges: MERMAID_MAX_EDGES,
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily: 'Arial, sans-serif',
    layout: 'dagre',
    // Diagram directives cannot change the frame's rendering policy.
    secure: [...Object.keys(mermaid.mermaidAPI.defaultConfig), 'secure', 'htmlLabels', 'layout'],
  });
  host.inert = true;
  try {
    // Mermaid's maxEdges only guards flowcharts; inspect parsed graphs before layout too.
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    const db = diagram.db as {
      getData?: () => {edges?: unknown[]};
      getMessages?: () => unknown[];
    };
    const edges = db.getData?.().edges ?? db.getMessages?.() ?? [];
    if (edges.length > MERMAID_MAX_EDGES) throw new Error('Diagram has too many connections.');
    const {svg} = await mermaid.render(id, source, host);
    host.innerHTML = DOMPurify.sanitize(svg, {
      USE_PROFILES: {svg: true, svgFilters: true},
      FORBID_TAGS: ['foreignObject', 'image', 'a'],
    });
    const image = host.querySelector('svg');
    if (!image) throw new Error('No diagram was produced.');
    image.setAttribute('role', 'img');
    if (!image.hasAttribute('aria-labelledby')) image.setAttribute('aria-label', 'Mermaid diagram');
    host.inert = false;
  } catch (error) {
    host.replaceChildren();
    throw error;
  }
}
