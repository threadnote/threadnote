// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryEditor} from '../../src/memory_editor.js';

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

it('renders headings, lists and code without normalizing the stored document on open', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  const change = vi.fn();
  const content =
    'MEMORY\nkind: durable\nmemory_id: stable\n\n# A decision\n\n- Keep [context](threadnote://memory/example)\n\n```ts\nconst stable = true;\n```';
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<MemoryEditor content={content} disabled={false} onChange={change} />));
  expect(container.querySelector('h1')?.textContent).toBe('A decision');
  expect(container.querySelector('li')?.textContent).toContain('Keep context');
  expect(container.textContent).not.toContain('memory_id');
  expect(change).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Source mode"]')).not.toBeNull();
});

it('keeps unsupported Markdown available verbatim in the source fallback', async () => {
  const content = 'MEMORY\nkind: durable\n\nimport Example from "./example"\n\n<Example />';
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<MemoryEditor content={content} disabled={false} onChange={() => undefined} />));
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
    'import Example from "./example"\n\n<Example />',
  );
});
