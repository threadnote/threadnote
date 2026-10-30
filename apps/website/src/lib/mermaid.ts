import {Array as EffectArray, String as EffectString} from 'effect';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';

const maximumTextSize = 50_000;
const maximumEdges = 500;
let pending: Promise<void> = Promise.resolve();

/** Only sanitized SVG crosses into the post's document. */
export function sanitizeMermaidSvg(svg: string): string {
  const sanitized = DOMPurify.sanitize(svg, {
    USE_PROFILES: {svg: true, svgFilters: true},
    FORBID_TAGS: ['foreignObject', 'image', 'a', 'script'],
    RETURN_TRUSTED_TYPE: false,
  });
  const document = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
  const image = document.documentElement;
  if (image.localName !== 'svg' || document.querySelector('parsererror')) throw new Error('Invalid diagram SVG.');
  image.setAttribute('role', 'img');
  if (!image.hasAttribute('aria-labelledby') && !image.hasAttribute('aria-label'))
    image.setAttribute('aria-label', 'Mermaid diagram');
  return new XMLSerializer().serializeToString(image);
}

/** Mermaid has shared configuration; serialize charts on pages containing several diagrams. */
export function renderMermaidSvg(source: string, id: string): Promise<string> {
  const next = pending.then(async () => {
    if (!EffectString.trim(source) || source.length > maximumTextSize) throw new Error('Invalid diagram size.');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: maximumTextSize,
      maxEdges: maximumEdges,
      theme: 'dark',
      fontFamily: 'Arial, sans-serif',
      layout: 'dagre',
      // Keep authored diagram directives from weakening the website's rendering policy.
      // oxlint-disable-next-line effecttsgo/prefer-effect-record -- Mermaid's config is a heterogeneous upstream object.
      secure: [...Object.keys(mermaid.mermaidAPI.defaultConfig), 'secure', 'htmlLabels', 'layout'],
    });
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    const db = diagram.db;
    const data = 'getData' in db && typeof db.getData === 'function' ? db.getData() : undefined;
    const edges =
      (typeof data === 'object' && data !== null && 'edges' in data ? data.edges : undefined) ??
      ('getMessages' in db && typeof db.getMessages === 'function' ? db.getMessages() : undefined) ??
      [];
    if (!EffectArray.isArray(edges) || edges.length > maximumEdges) throw new Error('Too many diagram connections.');
    const host = document.createElement('div');
    host.inert = true;
    host.setAttribute('aria-hidden', 'true');
    host.style.position = 'absolute';
    host.style.visibility = 'hidden';
    document.body.append(host);
    try {
      const {svg} = await mermaid.render(id, source, host);
      return sanitizeMermaidSvg(svg);
    } finally {
      host.remove();
    }
  });
  pending = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
