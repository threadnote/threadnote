// @vitest-environment jsdom
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {PostMarkdown} from '../src/components/PostMarkdown.js';
import {renderMermaidSvg, sanitizeMermaidSvg} from '../src/lib/mermaid.js';
import * as EffectString from 'effect/String';

const renderer = vi.hoisted(() => ({initialize: vi.fn(), parse: vi.fn(), render: vi.fn()}));
vi.mock('mermaid', () => ({
  default: {
    initialize: renderer.initialize,
    mermaidAPI: {defaultConfig: {securityLevel: 'strict'}, getDiagramFromText: renderer.parse},
    render: renderer.render,
  },
}));

describe('website Mermaid posts', () => {
  let root: Root | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    renderer.parse.mockResolvedValue({db: {getData: () => ({edges: []})}});
    renderer.render.mockResolvedValue({svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>'});
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('recognizes block diagrams and preserves ordinary code and readable server-rendered source', () => {
    const html = renderToStaticMarkup(
      createElement(PostMarkdown, {
        children: '```mermaid\nflowchart LR\nA --> B\n```\n\n```sh\nthreadnote update\n```\n\n`mermaid`',
      }),
    );
    expect(html).toContain('<figure class="post-diagram" aria-label="Mermaid diagram">');
    expect(html).toContain('<summary>Diagram source</summary>');
    expect(html).toContain('A --&gt; B');
    expect(html).toContain('<pre><code class="language-sh">threadnote update\n</code></pre>');
    expect(html).toContain('<code>mermaid</code>');
    expect(html).not.toContain('<pre><figure');
  });

  it('renders accessible SVG with strict policy and serializes concurrent diagrams', async () => {
    let release: ((value: {svg: string}) => void) | undefined;
    renderer.render.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const first = renderMermaidSvg('flowchart LR\nA --> B', 'first');
    const second = renderMermaidSvg('flowchart LR\nC --> D', 'second');
    await vi.waitFor(() => expect(renderer.render).toHaveBeenCalledTimes(1));
    expect(renderer.initialize).toHaveBeenCalledWith(
      expect.objectContaining({securityLevel: 'strict', htmlLabels: false, maxEdges: 500}),
    );
    release?.({svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>First</text></svg>'});
    expect(await first).toContain('role="img"');
    expect(await second).toContain('aria-label="Mermaid diagram"');
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(document.body.children).toHaveLength(0);
  });

  it('keeps later diagrams usable after invalid or oversized definitions', async () => {
    await expect(renderMermaidSvg('', 'empty')).rejects.toThrow('Invalid diagram size');
    await expect(renderMermaidSvg(EffectString.repeat(50_001)('x'), 'large')).rejects.toThrow('Invalid diagram size');
    renderer.parse.mockResolvedValueOnce({db: {getData: () => ({edges: EffectArray.makeBy(501, () => ({}))})}});
    await expect(renderMermaidSvg('flowchart LR\nA --> B', 'edges')).rejects.toThrow('Too many diagram connections');
    await expect(renderMermaidSvg('flowchart LR\nA --> B', 'recovered')).resolves.toContain('<svg');
  });

  it('exposes escaped source when a renderer fails', async () => {
    renderer.render.mockRejectedValueOnce(new Error('Invalid diagram'));
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root?.render(createElement(PostMarkdown, {children: '```mermaid\n<script>bad()</script>\n```'})),
    );
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(host.querySelector('details')?.open).toBe(true);
    expect(host.querySelector('code')?.textContent).toContain('<script>bad()</script>');
    expect(host.querySelector('script')).toBeNull();
  });

  it('removes active SVG elements and event handlers for bounded generated combinations', () => {
    const unsafe = [
      '<script>alert(1)</script>',
      '<foreignObject><div>foreign HTML</div></foreignObject>',
      '<image href="https://example.invalid/image.svg"/>',
      '<a href="javascript:alert(1)"><text>Link</text></a>',
    ];
    fc.assert(
      fc.property(
        fc.shuffledSubarray(unsafe, {minLength: 1}),
        fc.constantFrom('onload', 'onclick', 'onerror'),
        (parts, event) => {
          const svg = sanitizeMermaidSvg(
            `<svg xmlns="http://www.w3.org/2000/svg">${EffectArray.join(parts, '')}<text ${event}="alert(1)">Label</text></svg>`,
          );
          const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
          expect(parsed.querySelector('script, foreignObject, image, a')).toBeNull();
          for (const element of parsed.querySelectorAll('*'))
            for (const attribute of element.attributes) expect(attribute.name).not.toMatch(/^on/iu);
          expect(parsed.documentElement.getAttribute('role')).toBe('img');
          expect(parsed.documentElement.textContent).toContain('Label');
        },
      ),
      {numRuns: 40},
    );
  });
});
