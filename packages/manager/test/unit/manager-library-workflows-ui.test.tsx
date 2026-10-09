// @vitest-environment happy-dom
import React, {act} from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import type {TreeNode} from '../../src/ui/contracts.js';

vi.mock('../../src/memory_editor.js', () => ({
  MemoryEditor: (props: {content: string; disabled: boolean; onChange: (value: string) => void}) => (
    <textarea
      aria-label="Test Markdown editor"
      disabled={props.disabled}
      value={props.content}
      onChange={event => props.onChange(event.target.value)}
    />
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('wires hidden folder descendants to bulk results, keeps failures selected, and saves a Home draft as the user', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  vi.spyOn(window, 'setInterval').mockImplementation(() => setTimeout(() => undefined, 0));
  const rootUri = 'threadnote://user/test/memories';
  const leaf = (name: string): TreeNode => ({
    name,
    uri: `${rootUri}/durable/projects/project/${name}`,
    relativePath: `durable/projects/project/${name}`,
    isDir: false,
    isSystem: false,
    isShared: false,
    metadata: {
      kind: 'durable',
      status: 'active',
      project: 'project',
      sourceAgentClient: 'user',
      timestamp: '2026-10-07T00:00:00Z',
      topic: name,
    },
  });
  let leaves = [leaf('one.md'), leaf('two.md')];
  const posts: {path: string; body: Record<string, unknown>}[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.body) posts.push({path: url.pathname, body});
    if (url.pathname === '/api/state')
      return json({
        agents: [],
        config: {user: 'test', account: 'local'},
        autoUpdate: {effectivePolicy: 'notify'},
        version: 'fixture',
      });
    if (url.pathname === '/api/tree')
      return json({
        tree: {
          ...leaf('memories'),
          uri: rootUri,
          relativePath: '',
          isDir: true,
          children: [{...leaf('project'), relativePath: 'durable/projects/project', isDir: true, children: leaves}],
        },
      });
    if (url.pathname === '/api/graphs') return json({repositories: [], builds: [], diagnostics: [], views: []});
    if (url.pathname === '/api/shares') return json({shares: []});
    if (url.pathname === '/api/home')
      return json({
        version: 1,
        project: url.searchParams.get('project') ?? '',
        lanes: [],
        handoffs: [],
        stats: {memories: leaves.length},
      });
    if (url.pathname === '/api/bulk') {
      const before = leaves;
      leaves = leaves.slice(1);
      return json({
        results: before.map((node, index) => ({
          uri: node.uri,
          ok: index === 0,
          ...(index ? {error: 'synthetic failure'} : {}),
        })),
      });
    }
    if (url.pathname === '/api/memory/save') {
      leaves = [...leaves, leaf('new-memory.md')];
      return json({output: `Stored ${leaves.at(-1)!.uri}`});
    }
    if (url.pathname === '/api/memory') {
      const node = leaves.find(item => item.uri === url.searchParams.get('uri'));
      return json({node, content: 'MEMORY\nkind: durable\n\nSaved body', record: {metadata: node?.metadata}});
    }
    return json({});
  });
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  await act(async () => {
    (await import('../../src/ui.js')).mountManager({integrations: []});
  });
  const projectSelector = container.querySelector<HTMLSelectElement>('[aria-label="Workspace project"]')!;
  expect(projectSelector.value).toBe('');
  expect(projectSelector.selectedOptions[0]?.textContent).toBe('All');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh manager"]')!.click());
  expect(projectSelector.value).toBe('');
  await act(async () => {
    projectSelector.value = 'project';
    projectSelector.dispatchEvent(new Event('change', {bubbles: true}));
  });
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      item => item.textContent?.trim() === label || item.querySelector('strong')?.textContent === label,
    )!;
  await act(async () => button('Library').click());
  expect(container.textContent).toContain('Your private memory library');
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('[aria-label="Select folder project and all descendant memories"]')!
      .click(),
  );
  const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await fill(search, 'one.md');
  expect(container.textContent).toContain('2 memories selected');
  await act(async () => button('Forget…').click());
  expect(document.querySelector('dialog')?.textContent).toContain('two.md');
  await act(async () => document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.click());
  expect(posts.find(post => post.path === '/api/bulk')?.body.uris).toEqual([
    `${rootUri}/durable/projects/project/one.md`,
    `${rootUri}/durable/projects/project/two.md`,
  ]);
  expect(container.textContent).toContain('1 memory selected');
  expect(container.textContent).toContain('synthetic failure');
  await act(async () => button('Home').click());
  await act(async () => button('New memory').click());
  expect(container.querySelector<HTMLInputElement>('input[placeholder="project"]')?.value).toBe('project');
  await fill(container.querySelector<HTMLInputElement>('[aria-label="Memory title"]')!, 'New memory');
  await fill(container.querySelector<HTMLTextAreaElement>('[aria-label="Test Markdown editor"]')!, '# Saved body');
  await act(async () => button('Save memory').click());
  expect(posts.find(post => post.path === '/api/memory/save')?.body).toMatchObject({
    text: '# Saved body',
    topic: 'New memory',
    project: 'project',
    sourceAgentClient: 'user',
  });
  expect(container.textContent).toContain('new-memory.md');
  expect(container.textContent).toContain('Saved local memory');
  await act(async () => button('Resources').click());
  expect(container.textContent).toContain('Browse your source material');
  expect(container.textContent).not.toContain('Saved body');
});

async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
