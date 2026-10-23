// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {defaultUrlTransform} from 'react-markdown';
import {MarkdownViewer} from '../../src/ui/controls.js';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

async function render(markdown: string, onOpenMemory?: (uri: string) => void) {
  await act(async () => root.render(<MarkdownViewer markdown={markdown} onOpenMemory={onOpenMemory} />));
}

it('retains canonical destinations for labeled memory links and intercepts their clicks once', async () => {
  const canonical = 'threadnote://user/test/memories/durable/projects/demo/target.md';
  const alias = 'threadnote://memory/tn_0123456789abcdef0123456789abcdef';
  const open = vi.fn();
  await render(`- [current](<${canonical}>)\n- [stable alias](<${alias}>)`, open);

  const links = [...host.querySelectorAll<HTMLAnchorElement>('a')];
  expect(links.map(link => link.getAttribute('href'))).toEqual([canonical, alias]);
  expect(links.map(link => link.textContent)).toEqual(['current', 'stable alias']);
  const event = new MouseEvent('click', {bubbles: true, cancelable: true});
  await act(async () => links[0].dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(canonical);
});

it('retains the default URL policy for other anchors and without a navigation callback', async () => {
  const links = [
    ['https', 'https://example.test/path?q=one&x=two'],
    ['mailto', 'mailto:person@example.test'],
    ['relative', '../guide.md'],
    ['hash', '#section'],
    ['unsafe', 'javascript:alert(1)'],
    ['threadnote-other', 'threadnote://source/github/repo'],
  ] as const;
  const markdown = links.map(([label, href]) => `[${label}](<${href}>)`).join('\n\n');
  await render(markdown, () => undefined);
  const rendered = [...host.querySelectorAll<HTMLAnchorElement>('a')];
  expect(rendered.map(link => link.getAttribute('href'))).toEqual(links.map(([, href]) => defaultUrlTransform(href)));

  await render(`[memory](<threadnote://user/test/memories/durable/projects/demo/target.md>)`);
  expect(host.querySelector('a')?.getAttribute('href')).toBe(
    defaultUrlTransform('threadnote://user/test/memories/durable/projects/demo/target.md'),
  );
});

it('preserves generated canonical and stable memory targets independently of escaped labels', async () => {
  const segment = fc
    .array(fc.constantFrom('a', 'Z', '0', '_', '-', 'é', '雪', ' ', '/', '?', '%', '#'), {minLength: 1, maxLength: 12})
    .map(parts => encodeURIComponent(parts.join('')));
  const href = fc.oneof(
    fc
      .tuple(segment, segment, segment)
      .map(
        ([project, folder, file]) => `threadnote://user/test/memories/durable/projects/${project}/${folder}/${file}.md`,
      ),
    fc
      .array(fc.constantFrom(...'0123456789abcdef'), {minLength: 32, maxLength: 32})
      .map(id => `threadnote://memory/tn_${id.join('')}`),
  );
  const label = fc.stringMatching(/^[a-zA-Z0-9 &<>]{1,16}$/);

  await fc.assert(
    fc.asyncProperty(href, label, async (target, text) => {
      const open = vi.fn();
      await render(`[${text.replace(/[\\[\]]/g, '\\$&')}](<${target}>)`, open);
      const link = host.querySelector<HTMLAnchorElement>('a');
      expect(link?.getAttribute('href')).toBe(target);
      const event = new MouseEvent('click', {bubbles: true, cancelable: true});
      await act(async () => link!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(open.mock.calls).toEqual([[target]]);
    }),
    {numRuns: 48},
  );
});

it('matches the default URL transform for generated non-memory destinations', async () => {
  const tail = fc.stringMatching(/^[a-zA-Z0-9_/-]{0,12}$/);
  const destination = fc.oneof(
    tail.map(path => `https://example.test/${path}`),
    tail.map(path => `mailto:user-${path}@example.test`),
    tail.map(path => `./${path}`),
    tail.map(fragment => `#${fragment}`),
    tail.map(value => `javascript:${value}`),
    tail.map(value => `data:text/plain,${value}`),
    tail.map(value => `threadnote://source/${value}`),
  );

  await fc.assert(
    fc.asyncProperty(destination, async href => {
      await render(`[destination](<${href}>)`, () => undefined);
      expect(host.querySelector('a')?.getAttribute('href')).toBe(defaultUrlTransform(href));
    }),
    {numRuns: 48},
  );
});

it('does not extend the memory link exception to image sources', async () => {
  await render('![memory image](<threadnote://user/test/memories/durable/projects/demo/image.png>)', () => undefined);
  expect(defaultUrlTransform('threadnote://user/test/memories/durable/projects/demo/image.png')).toBe('');
  expect(host.querySelector('img')?.getAttribute('src')).toBeNull();
});
