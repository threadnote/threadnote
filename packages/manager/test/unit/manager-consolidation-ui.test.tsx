// @vitest-environment happy-dom
import React, {act} from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import type {TreeNode} from '../../src/ui/contracts.js';

vi.mock('../../src/memory_editor.js', () => ({MemoryEditor: () => <div>Editor</div>}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('drafts and applies to a separate result topic after opening a selected source', async () => {
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
  const prefix = 'threadnote://user/test/memories';
  const leaf = (name: string): TreeNode => ({
    name,
    uri: `${prefix}/durable/projects/project/${name}.md`,
    relativePath: `durable/projects/project/${name}.md`,
    isDir: false,
    isSystem: false,
    isShared: false,
    metadata: {
      kind: 'durable',
      status: 'active',
      project: 'project',
      topic: name,
      sourceAgentClient: 'test',
      timestamp: '2026-10-08T00:00:00Z',
    },
  });
  const leaves = [leaf('source-a'), leaf('source-b')];
  const posts: {path: string; body: Record<string, unknown>}[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.body) posts.push({path: url.pathname, body});
    if (url.pathname === '/api/state')
      return Promise.resolve(
        json({
          agents: [{id: 'codex', label: 'Codex', available: true}],
          config: {user: 'test', account: 'local'},
          autoUpdate: {effectivePolicy: 'notify'},
          version: 'fixture',
        }),
      );
    if (url.pathname === '/api/tree')
      return Promise.resolve(
        json({
          tree: {
            ...leaf('memories'),
            uri: prefix,
            relativePath: '',
            isDir: true,
            children: [{...leaf('project'), relativePath: 'durable/projects/project', isDir: true, children: leaves}],
          },
        }),
      );
    if (url.pathname === '/api/graphs')
      return Promise.resolve(json({repositories: [], builds: [], diagnostics: [], views: []}));
    if (url.pathname === '/api/shares') return Promise.resolve(json({shares: []}));
    if (url.pathname === '/api/home')
      return Promise.resolve(json({version: 1, project: 'project', lanes: [], handoffs: [], stats: {memories: 2}}));
    if (url.pathname === '/api/memory') {
      const node = leaves.find(l => l.uri === url.searchParams.get('uri'));
      return Promise.resolve(
        json({
          node,
          content: 'MEMORY\nkind: durable\n\nClaim.',
          record: {metadata: node?.metadata, body: 'Claim.', uri: node?.uri},
        }),
      );
    }
    if (url.pathname === '/api/consolidations')
      return Promise.resolve(
        json({
          job: {
            id: 'job',
            status: 'completed',
            draft: 'Final claim.',
            sourceUris: leaves.map(l => l.uri),
            sources: leaves.map(l => ({
              uri: l.uri,
              revision: 'a'.repeat(64),
              fragments: ['Claim.'],
              codeCitations: [],
              relations: [],
            })),
          },
        }),
      );
    if (url.pathname === '/api/consolidations/job/apply')
      return Promise.resolve(
        json({output: 'Applied', resultUri: `${prefix}/durable/projects/project/consolidation-job.md`}),
      );
    return Promise.resolve(json({}));
  });
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  await act(async () => {
    await import('../../src/ui.js');
  });
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      b => b.textContent?.trim() === text || b.querySelector('strong')?.textContent === text,
    )!;
  await act(async () => button('Library').click());
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('[aria-label="Select folder project and all descendant memories"]')!
      .click(),
  );
  await act(async () => container.querySelector<HTMLButtonElement>(`button[title="${leaves[0].uri}"]`)!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Memory details"]')!.click());
  expect(container.querySelector<HTMLInputElement>('[aria-label="Consolidated memory topic"]')?.value).toBe('');
  await act(async () => button('Draft').click());
  expect(posts.find(p => p.path === '/api/consolidations')?.body).toMatchObject({
    topic: '',
    kind: 'durable',
    status: 'active',
  });
  const decision = container.querySelector<HTMLSelectElement>('[aria-label="Support decision for paragraph 1"]')!;
  await act(async () => {
    decision.value = 'unsupported';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await act(async () => button('Apply draft').click());
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('dialog button[type="submit"]')].at(-1)!.click(),
  );
  const applied = posts.find(p => p.path.endsWith('/apply'))?.body;
  expect(applied).toMatchObject({
    topic: '',
    project: 'project',
    reviews: [{section: 'Final claim.', disposition: 'unsupported', supports: []}],
  });
  expect(applied?.topic).not.toBe('source-a');
});
