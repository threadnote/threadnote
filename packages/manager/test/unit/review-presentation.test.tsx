// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import fc from 'fast-check';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {MemoryExcerpt} from '../../src/review_presentation.js';
import {SourceExcerpt} from '../../src/source_code.js';

vi.mock('../../src/mermaid_block.js', () => ({
  MermaidBlock: ({source}: {source: string}) => <div data-testid="mermaid-diagram">{source}</div>,
}));

let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});
async function render(node: React.ReactElement) {
  await act(async () => root.render(node));
}

it('renders accepted memory headings, GFM tables, and Mermaid diagrams', async () => {
  await render(
    <MemoryExcerpt markdown>
      {'# Accepted\n\n| Item | Result |\n| --- | --- |\n| Safe | Yes |\n\n```mermaid\nflowchart LR\n A-->B\n```'}
    </MemoryExcerpt>,
  );
  expect(document.querySelector('.memory-excerpt h1')?.textContent).toBe('Accepted');
  expect(document.querySelector('.memory-excerpt table td')?.textContent).toBe('Safe');
  expect(document.querySelector('[data-testid="mermaid-diagram"]')?.textContent).toContain('flowchart LR');
});

it('preserves nonstring children unchanged', async () => {
  await render(
    <MemoryExcerpt>
      <strong>Existing node</strong>
    </MemoryExcerpt>,
  );
  expect(document.querySelector('.memory-excerpt blockquote > strong')?.textContent).toBe('Existing node');
});

it('highlights TypeScript tokens while preserving source as escaped text', async () => {
  const source = 'const value: string = "<img src=x onerror=alert(1)>";\n';
  await render(<SourceExcerpt content={source} path="example.ts" />);
  const code = document.querySelector('.source-excerpt code');
  expect(code?.textContent).toBe(source);
  expect(code?.querySelector('.tok-keyword')).not.toBeNull();
  expect(code?.querySelector('.tok-string')).not.toBeNull();
  expect(code?.querySelector('img')).toBeNull();
});

it('falls back to plain escaped code for an unknown source language', async () => {
  await render(<SourceExcerpt content={'<script>alert(1)</script>'} path="example.unknown" />);
  expect(document.querySelector('.source-excerpt code')?.textContent).toBe('<script>alert(1)</script>');
  expect(document.querySelector('.source-excerpt script')).toBeNull();
  expect(document.querySelector('.source-excerpt .tok-keyword')).toBeNull();
});

it('keeps every source character in parser and fallback paths', async () => {
  fc.assert(
    fc.property(fc.string({maxLength: 120}), source => {
      for (const path of ['sample.tsx', 'sample.unknown']) {
        const container = document.createElement('div');
        const propertyRoot = createRoot(container);
        act(() => propertyRoot.render(<SourceExcerpt content={source} path={path} />));
        expect(container.querySelector('code')?.textContent).toBe(source);
        act(() => propertyRoot.unmount());
      }
    }),
    {numRuns: 50},
  );
});
