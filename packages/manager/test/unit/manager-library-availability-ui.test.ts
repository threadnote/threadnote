import {Array as EffectArray} from 'effect';
// @vitest-environment happy-dom

import {act} from 'react';
import fc from 'fast-check';
import {afterEach, expect, it, vi} from 'vitest';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps navigation available while the library is pending or failed and recovers on refresh', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true, writable: true});
  vi.spyOn(window, 'setInterval').mockImplementation(() => setTimeout(() => undefined, 0));
  let rejectTree: ((cause: Error) => void) | undefined;
  let treeReady = false;
  let libraryReady = true;
  let runtimeReady = true;
  let sharesReady = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    // Exercise the explicit REST compatibility path in this library fixture.
    if (path === '/api/live-session')
      return new Response(JSON.stringify({error: 'Live unavailable in this REST fixture'}), {status: 404});
    if (path === '/api/state') {
      if (!runtimeReady) throw new Error('runtime unavailable');
      return json({
        agents: [],
        autoUpdate: {effectivePolicy: 'notify'},
        config: {account: 'local', agentContextHome: '/fixture/home', user: 'test'},
        updateAvailable: false,
        version: 'fixture',
      });
    }
    if (path === '/api/tree') {
      if (!treeReady) return new Promise<Response>((_resolve, reject) => (rejectTree = reject));
      if (!libraryReady) throw new Error('library unavailable');
      const tree = {
        name: 'memories',
        uri: 'threadnote://user/test/memories',
        relativePath: '',
        isDir: true,
        isSystem: false,
        isShared: false,
        children: [],
      };
      return json({tree, resourcesTree: tree});
    }
    if (path === '/api/graphs')
      return json({repositories: [], builds: [], diagnostics: [], views: [], waiterCount: 0, waiters: []});
    if (path === '/api/worksets')
      return json({
        definitions: [],
        definitionSource: 'seed-manifest',
        editability: {state: 'editable'},
        projectEditability: {state: 'editable'},
        projects: [],
        projectsReadOnly: false,
        readOnly: false,
        revision: 'fixture',
        type: 'manager-workset-catalog',
        version: 1,
      });
    if (path === '/api/shares/conflicts') return json({conflicts: []});
    if (path === '/api/processes') return json({processes: [], schemaVersion: 1, truncated: false});
    if (path === '/api/home') return json({version: 1, project: '', lanes: [], handoffs: []});
    if (path === '/api/shares') {
      if (!sharesReady) throw new Error('shares unavailable');
      return json({shares: []});
    }
    return json({});
  });
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  await act(async () => {
    (await import('@threadnote/manager/ui')).mountManager({integrations: []});
  });

  const navigation = () => [
    ...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Manager sections"] button'),
  ];
  expect(navigation().length).toBeGreaterThan(0);
  expect(EffectArray.every(navigation(), button => !button.disabled)).toBe(true);
  expect(container.textContent).not.toContain('Connecting to Manager');

  await act(async () => rejectTree?.(new Error('tree request timed out')));

  expect(EffectArray.every(navigation(), button => !button.disabled)).toBe(true);
  expect(container.textContent).not.toContain('Manager disconnected');
  expect(container.textContent).toContain('Memory library unavailable');
  const context = EffectOption.getOrUndefined(
    EffectArray.findFirst(navigation(), button => button.querySelector('strong')?.textContent === 'Context'),
  );
  await act(async () => context?.click());
  expect(context?.getAttribute('aria-current')).toBe('page');

  treeReady = true;
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh manager"]')?.click());

  expect(container.textContent).not.toContain('Memory library unavailable');
  expect(EffectArray.every(navigation(), button => !button.disabled)).toBe(true);

  libraryReady = false;
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh manager"]')?.click());
  expect(container.textContent).toContain('Memory library unavailable');
  libraryReady = true;
  const library = EffectOption.getOrUndefined(
    EffectArray.findFirst(navigation(), button => button.querySelector('strong')?.textContent === 'Library'),
  );
  expect(library).toBeDefined();
  await act(async () => library?.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh manager"]')?.click());
  expect(container.textContent).not.toContain('Memory library unavailable');

  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()), {minLength: 1, maxLength: 8}),
      async outcomes => {
        for (const [runtimeAvailable, libraryAvailable, sharesAvailable] of outcomes) {
          runtimeReady = runtimeAvailable;
          libraryReady = libraryAvailable;
          sharesReady = sharesAvailable;
          await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh manager"]')?.click());
          expect(EffectArray.every(navigation(), button => !button.disabled)).toBe(runtimeAvailable);
          expect(
            Effect.pipe(container.textContent, effectOptionalString =>
              effectOptionalString == null
                ? undefined
                : Effect.pipe(effectOptionalString, EffectString.includes('Manager disconnected')),
            ),
          ).toBe(!runtimeAvailable);
          expect(
            Effect.pipe(container.textContent, effectOptionalString =>
              effectOptionalString == null
                ? undefined
                : Effect.pipe(effectOptionalString, EffectString.includes('Memory library unavailable')),
            ),
          ).toBe(!libraryAvailable);
        }
      },
    ),
    {numRuns: 16},
  );
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
}
