// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import {Array as EffectArray, Predicate} from 'effect';
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {Window as HappyWindow} from 'happy-dom';
import {MemoryBody} from '../../src/detail_modal.js';
import {MemoryExcerpt} from '../../src/review_presentation.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  document.documentElement.dataset.theme = 'light';
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function show(content: string) {
  await act(async () => root.render(<MemoryBody content={content} />));
}

it('dispatches Mermaid fences to isolated diagrams while leaving ordinary code and literal evidence alone', async () => {
  const source = 'flowchart LR\n  A[Read] --> B[Remember]\n';
  await show(
    'Before\n\n```mermaid\n' +
      source +
      '```\n\n```MERMAID\nsequenceDiagram\n A->>B: Hello\n```\n\n```ts\nconst n = 1;\n```\n\n`mermaid`',
  );
  const frames = host.querySelectorAll('iframe');
  expect(frames).toHaveLength(2);
  expect(frames[0].getAttribute('sandbox')).toBe('allow-scripts');
  expect(frames[0].getAttribute('src')).toBe('/mermaid.html');
  expect(frames[0].title).toBe('Mermaid diagram');
  expect(host.querySelector('pre iframe')).toBeNull();
  expect(host.querySelector('code.language-typescript, code.language-ts')?.textContent).toBe('const n = 1;\n');
  expect(host.querySelector('details pre')?.textContent).toBe(source);
  await act(async () => root.render(<MemoryExcerpt>{'```mermaid\n' + source + '```'}</MemoryExcerpt>));
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.querySelector('blockquote')?.textContent).toBe('```mermaid\n' + source + '```');
});

it('preserves arbitrary ordinary code text and never mounts a renderer for it', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc
        .string()
        .filter(
          value =>
            !Effect.pipe(value, EffectString.includes('~~~')) &&
            !Effect.pipe(value, EffectString.includes('\r')) &&
            !Effect.pipe(value, EffectString.includes('\u0000')),
        ),
      async value => {
        await show('~~~text\nprefix:' + value + '\n~~~');
        expect(host.querySelector('code')?.textContent).toBe('prefix:' + value + '\n');
        expect(host.querySelector('iframe')).toBeNull();
      },
    ),
    {numRuns: 40},
  );
});

it('retains readable source when a diagram frame cannot load', async () => {
  vi.useFakeTimers();
  await show('```mermaid\nflowchart LR\n A-->B\n```');
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(host.querySelector('[role=status]')?.textContent).toContain('Unable to render');
  expect(host.querySelector('details')?.open).toBe(true);
  expect(host.querySelector('code')?.textContent).toContain('A-->B');
});

async function loadFrame() {
  const frame = host.querySelector('iframe');
  if (!frame) throw new Error('Mermaid frame was not rendered.');
  const frameWindow = new HappyWindow();
  Object.defineProperty(frame, 'contentWindow', {value: frameWindow, configurable: true});
  const post = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
  await act(async () => frame.dispatchEvent(new Event('load')));
  const request = post.mock.calls[0]?.[0];
  if (!Predicate.isObject(request) || typeof request.id !== 'string')
    throw new Error('Mermaid iframe did not receive a request with an ID.');
  return {frame, post, id: request.id};
}

async function result(source: MessageEventSource | null, id: string, height: unknown = 200) {
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        data: {type: 'mermaid-result', id, ok: true, height},
      }),
    ),
  );
}

it('accepts only the current frame response and bounds its displayed height', async () => {
  await show('```mermaid\nflowchart LR\n A-->B\n```');
  const {frame, id} = await loadFrame();
  await result(window, id);
  await result(frame.contentWindow, 'wrong-id');
  await result(frame.contentWindow, id, Infinity);
  expect(host.textContent).toContain('Rendering diagram');
  await result(frame.contentWindow, id, 5000);
  expect(frame.style.height).toBe('1200px');
  expect(host.querySelector('details')?.open).toBe(false);
  expect(host.querySelector('[role=status]')).toBeNull();
});

it('enforces renderer and sanitizer policies and cleans up failed renders', async () => {
  vi.resetModules();
  const initialize = vi.fn();
  const render = vi.fn().mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><a href="https://example.invalid"><text>Link</text></a><image href="https://example.invalid/img"/><foreignObject>bad</foreignObject><text onclick="alert(1)">Safe</text></svg>',
  });
  vi.doMock('mermaid', () => ({
    default: {
      initialize,
      render,
      mermaidAPI: {
        defaultConfig: {securityLevel: 'strict', themeCSS: ''},
        getDiagramFromText: vi.fn().mockResolvedValue({db: {getData: () => ({edges: []})}}),
      },
    },
  }));
  // Happy DOM does not preserve SVG namespaces through DOMPurify; real sanitation is checked in the browser.
  const sanitize = vi.fn().mockReturnValue('<svg><text>Safe</text></svg>');
  vi.doMock('dompurify', () => ({default: {sanitize}}));
  const {renderMermaid} = await import('../../src/mermaid_renderer.js');
  await renderMermaid('flowchart LR\n A-->B', 'mermaid-safe', 'dark', host);
  expect(host.querySelector('svg')).not.toBeNull();
  expect(sanitize).toHaveBeenCalledWith(expect.stringContaining('<script>'), {
    USE_PROFILES: {svg: true, svgFilters: true},
    FORBID_TAGS: ['foreignObject', 'image', 'a'],
  });
  expect(host.textContent).toContain('Safe');
  expect(initialize).toHaveBeenCalledWith(
    expect.objectContaining({
      securityLevel: 'strict',
      htmlLabels: false,
      startOnLoad: false,
      maxEdges: 500,
      secure: expect.arrayContaining(['themeCSS', 'securityLevel']),
    }),
  );
  await expect(renderMermaid('', 'mermaid-empty', 'light', host)).rejects.toThrow();
  await expect(
    renderMermaid(Effect.pipe('x', EffectString.repeat(50_001)), 'mermaid-large', 'light', host),
  ).rejects.toThrow();
  render.mockImplementationOnce(async () => {
    host.innerHTML = '<svg><text>Temporary</text></svg>';
    throw new Error('parse failed');
  });
  await expect(renderMermaid('bad', 'mermaid-bad', 'light', host)).rejects.toThrow('parse failed');
  expect(host.children).toHaveLength(0);
  await renderMermaid('flowchart LR\n A-->B', 'mermaid-next', 'light', host);
  expect(host.querySelector('svg')).not.toBeNull();
  vi.doUnmock('mermaid');
  vi.doUnmock('dompurify');
});

it('bounds real parsed flowchart, sequence, state and ER graphs before layout', async () => {
  vi.resetModules();
  vi.doUnmock('mermaid');
  vi.doUnmock('dompurify');
  const mermaid = (await import('mermaid')).default;
  const reachedLayout = new Error('layout reached');
  const render = vi.spyOn(mermaid, 'render').mockRejectedValue(reachedLayout);
  const {renderMermaid} = await import('../../src/mermaid_renderer.js');
  const diagrams = [
    (count: number) =>
      'flowchart LR\n' +
      EffectArray.join(
        Array.from({length: count}, (_, i) => `A${i} --> A${i + 1}`),
        '\n',
      ),
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    (count: number) => 'sequenceDiagram\n' + 'A->>B: Hello\n'.repeat(count),
    (count: number) =>
      'stateDiagram-v2\nstate Group {\n' +
      EffectArray.join(
        Array.from({length: count}, (_, i) => `A${i} --> A${i + 1}`),
        '\n',
      ) +
      '\n}',
    (count: number) =>
      'erDiagram\n' +
      EffectArray.join(
        Array.from({length: count}, (_, i) => `A${i} ||--o{ A${i + 1} : contains`),
        '\n',
      ),
  ];
  for (const source of diagrams) {
    render.mockClear();
    await expect(renderMermaid(source(500), 'mermaid-boundary', 'light', host)).rejects.toBe(reachedLayout);
    expect(render).toHaveBeenCalledTimes(1);
    render.mockClear();
    await expect(renderMermaid(source(501), 'mermaid-boundary', 'light', host)).rejects.not.toBe(reachedLayout);
    expect(render).not.toHaveBeenCalled();
    expect(host.children).toHaveLength(0);
  }
});

it('rejects foreign, standalone, unsandboxed and malformed frame requests and accepts one bounded request', async () => {
  vi.resetModules();
  const render = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../../src/mermaid_renderer.js', () => ({renderMermaid: render}));
  host.id = 'diagram';
  const parentDescriptor = Object.getOwnPropertyDescriptor(window, 'parent');
  const originDescriptor = Object.getOwnPropertyDescriptor(window, 'origin');
  const parent = new HappyWindow();
  const post = vi.spyOn(parent, 'postMessage').mockImplementation(() => undefined);
  let resized: (() => void) | undefined;
  const observe = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe = observe;
    },
  );
  const request = {type: 'render-mermaid', id: 'mermaid-test', source: 'flowchart LR\n A-->B', theme: 'dark'};
  const send = async (source: unknown, origin: string, data: unknown = request) => {
    const event = new MessageEvent('message', {origin, data});
    Object.defineProperty(event, 'source', {value: source});
    window.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  };
  try {
    await import('../../src/mermaid_frame.js');
    await send(window, window.location.origin);
    Object.defineProperty(window, 'parent', {value: parent, configurable: true});
    await send(parent, window.location.origin);
    Object.defineProperty(window, 'origin', {value: 'null', configurable: true});
    await send(parent, 'https://example.invalid');
    await send(window, window.location.origin);
    await send(parent, window.location.origin, {...request, id: 'invalid id'});
    expect(render).not.toHaveBeenCalled();
    await send(parent, window.location.origin);
    expect(render).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ok: true, id: request.id}), '*');
    expect(observe).toHaveBeenCalledWith(host);
    Object.defineProperty(host, 'scrollHeight', {value: 325, configurable: true});
    resized?.();
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({height: 325}), '*');
    await send(parent, window.location.origin);
    expect(render).toHaveBeenCalledTimes(1);
  } finally {
    if (parentDescriptor) Object.defineProperty(window, 'parent', parentDescriptor);
    if (originDescriptor) Object.defineProperty(window, 'origin', originDescriptor);
    vi.doUnmock('../../src/mermaid_renderer.js');
    vi.unstubAllGlobals();
  }
});

it('discards stale results after source/theme changes and never resends source on frame navigation', async () => {
  await show('```mermaid\nflowchart LR\n A-->B\n```');
  const old = await loadFrame();
  await show('```mermaid\nflowchart LR\n C-->D\n```');
  const current = await loadFrame();
  await result(old.frame.contentWindow, old.id);
  expect(host.textContent).toContain('Rendering diagram');
  await result(current.frame.contentWindow, current.id);
  await act(async () => current.frame.dispatchEvent(new Event('load')));
  expect(current.post).toHaveBeenCalledTimes(1);
  expect(host.querySelector('iframe')).toBeNull();
  expect(host.textContent).toContain('Unable to render');
  await act(async () => {
    document.documentElement.dataset.theme = 'dark';
  });
  expect(host.querySelector('iframe')).not.toBeNull();
  await act(async () => root.render(<p>Another memory</p>));
  await result(current.frame.contentWindow, current.id);
  expect(host.textContent).toBe('Another memory');
});
