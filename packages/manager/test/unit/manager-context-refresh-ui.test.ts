// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import fc from 'fast-check';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ContextPanel} from '@threadnote/manager/context/view';
import type {ManagerWorksetCatalog} from '@threadnote/manager/workset/contracts';

let originalFetch: typeof fetch;
let root: Root | undefined;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true, writable: true});
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('reflects the latest catalog across repeated refreshes without resetting the task', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.uniqueArray(fc.integer({min: 0, max: 5}), {maxLength: 4}), {minLength: 1, maxLength: 4}),
      async revisions => {
        let projects: readonly string[] = [];
        setFetch(async () => json(catalog(projects)));
        const container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        await render(0);
        await enterTask('Keep this investigation');
        for (const [index, revision] of revisions.entries()) {
          projects = revision.map(id => `fixture-${id}`);
          await render(index + 1);
          expect(repositoryPaths()).toEqual(['', ...projects.map(name => `/fixture/${name}`)]);
          expect(taskInput().value).toBe('Keep this investigation');
        }
        await act(async () => root?.unmount());
        root = undefined;
        container.remove();
      },
    ),
    {numRuns: 12},
  );
});

it('does not replace a refreshed catalog with an older aborted response', async () => {
  let resolveFirst: ((response: Response) => void) | undefined;
  let requestCount = 0;
  setFetch(async () => {
    requestCount += 1;
    if (requestCount === 1) return new Promise<Response>(resolve => (resolveFirst = resolve));
    return json(catalog(['current']));
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await render(0);
  await render(1);
  expect(repositoryPaths()).toEqual(['', '/fixture/current']);

  await act(async () => resolveFirst?.(json(catalog(['obsolete']))));

  expect(repositoryPaths()).toEqual(['', '/fixture/current']);
});

it.each(['Repository', 'Workset'])('clears a removed %s selection before compiling another brief', async scope => {
  let projects: readonly string[] = ['original'];
  setFetch(async () => json(catalog(projects)));
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await render(0);
  await enterTask('Preserve the task but require a current scope');
  if (scope === 'Workset') await click('Workset');
  await act(async () => {
    const select = scope === 'Repository' ? repositorySelect() : selectWithLabel('Prepared Workset');
    select.value = scope === 'Repository' ? '/fixture/original' : 'original-workset';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  });
  const compileButton = () =>
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Build brief');
  expect(compileButton()?.disabled).toBe(false);

  projects = ['replacement'];
  await render(1);

  expect(compileButton()?.disabled).toBe(true);
  expect(taskInput().value).toBe('Preserve the task but require a current scope');
});

it('refreshes Context choices through the Manager button while preserving a valid selection', async () => {
  let projects: readonly string[] = [];
  vi.spyOn(window, 'setInterval').mockImplementation(() => setTimeout(() => undefined, 0));
  setFetch(async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/state')
      return json({
        agents: [],
        autoUpdate: {effectivePolicy: 'notify'},
        config: {account: 'local', agentContextHome: '/fixture/home', user: 'test'},
        updateAvailable: false,
        version: 'test',
      });
    if (path === '/api/worksets') return json(catalog(projects));
    if (path === '/api/graphs') return json({repositories: [], builds: [], diagnostics: [], views: []});
    if (path === '/api/tree') return json({tree: undefined, resourcesTree: undefined});
    if (path === '/api/shares') return json({shares: []});
    return json({});
  });
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  await act(async () => {
    (await import('@threadnote/manager/ui')).mountManager({integrations: []});
  });
  await click('Context');
  expect(repositoryPaths()).toEqual(['']);
  await enterTask('Explain the synthetic pricing contract');

  projects = ['pricing'];
  await click('Refresh manager');
  expect(repositoryPaths()).toEqual(['', '/fixture/pricing']);
  await act(async () => {
    const select = repositorySelect();
    select.value = '/fixture/pricing';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await click('Refresh manager');
  expect(repositorySelect().value).toBe('/fixture/pricing');
  expect(taskInput().value).toBe('Explain the synthetic pricing contract');
  await click('Workset');
  expect(
    [...document.querySelectorAll('select')].flatMap(select => [...select.options].map(option => option.text)),
  ).toContain('pricing-workset · 1 projects');
});

async function render(refreshGeneration: number): Promise<void> {
  await act(async () => root?.render(React.createElement(ContextPanel, {refreshGeneration})));
}

async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(
    candidate =>
      candidate.getAttribute('aria-label') === label ||
      candidate.textContent?.trim() === label ||
      candidate.querySelector('strong')?.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

function repositorySelect(): HTMLSelectElement {
  return selectWithLabel('Repository');
}

function selectWithLabel(name: string): HTMLSelectElement {
  const select = [...document.querySelectorAll('label')]
    .find(label => label.textContent?.trim().startsWith(name))
    ?.querySelector('select');
  if (!select) throw new Error('Repository selector missing');
  return select;
}

function repositoryPaths(): readonly string[] {
  return [...repositorySelect().options].map(option => option.value);
}

function taskInput(): HTMLTextAreaElement {
  const input = document.querySelector<HTMLTextAreaElement>('.context-task-field textarea');
  if (!input) throw new Error('Engineering task missing');
  return input;
}

async function enterTask(value: string): Promise<void> {
  await act(async () => {
    const input = taskInput();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

function catalog(projects: readonly string[]): ManagerWorksetCatalog {
  return {
    definitions: projects.map(name => ({memberCount: 1, name: `${name}-workset`})),
    definitionSource: 'seed-manifest',
    editability: {state: 'editable'},
    projectEditability: {state: 'editable'},
    projects: projects.map(name => ({
      branchState: 'not-observed',
      folder: name,
      name,
      path: `/fixture/${name}`,
      worksetCount: 0,
      worksets: [],
    })),
    projectsReadOnly: false,
    readOnly: false,
    revision: 'a'.repeat(64),
    type: 'manager-workset-catalog',
    version: 1,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
}

function setFetch(handler: (input: RequestInfo | URL) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, {preconnect: originalFetch.preconnect});
}
