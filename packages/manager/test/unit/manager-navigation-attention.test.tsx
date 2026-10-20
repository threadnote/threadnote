// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {ManagerNavigation, sidebarWidthForKey} from '../../src/navigation.js';

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(
  project = 'demo',
  refreshGeneration = 0,
  options: Partial<
    Pick<React.ComponentProps<typeof ManagerNavigation>, 'panel' | 'connected' | 'contextHealthDecisionCount'>
  > = {},
) {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root!.render(
      <ManagerNavigation
        panel="shares"
        project={project}
        refreshGeneration={refreshGeneration}
        connected
        disabled={false}
        onSelect={() => undefined}
        width={200}
        onResizeKeyDown={() => undefined}
        onResizePointerDown={() => undefined}
        {...options}
      />,
    ),
  );
}
it('shows conflict and distinct-memory totals, including memories beyond the first page, and hides zero counts', async () => {
  let cleared = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/shares/')
              ? {conflicts: cleared ? [] : [{id: 'one'}, {id: 'two'}, {id: 'one'}]}
              : {
                  version: 2,
                  counts: {decisionMemories: cleared ? 0 : 42},
                  cases: [{memoryId: 'one'}, {memoryId: 'one'}],
                  omittedCases: 50,
                },
          ),
        ),
    ),
  );
  await render();
  expect(document.querySelector('[aria-label="2 unresolved sharing conflicts"]')?.textContent).toBe('2');
  expect(document.querySelector('[aria-label="42 memories need attention in demo"]')?.textContent).toBe('42');
  cleared = true;
  await render('demo', 1);
  expect(document.querySelectorAll('.nav-attention-badge')).toHaveLength(0);
});
it('does not retain a previous project count when the new project is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('other')) return new Response(JSON.stringify({error: 'Unavailable'}), {status: 503});
      return new Response(
        JSON.stringify(
          url.includes('/shares/') ? {conflicts: [{id: 'one'}]} : {version: 2, counts: {decisionMemories: 3}},
        ),
      );
    }),
  );
  await render();
  expect(document.querySelector('[aria-label="3 memories need attention in demo"]')).not.toBeNull();
  await render('other');
  expect(document.querySelectorAll('.nav-attention-badge')).toHaveLength(1);
  expect(document.querySelector('[aria-label="1 unresolved sharing conflict"]')).not.toBeNull();
});

it('uses the complete reconciled Health count only for its mounted project and keeps other queue totals', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/shares/')
              ? {conflicts: [{id: 'one'}]}
              : {version: 2, counts: {decisionMemories: 42}, cases: [], omittedCases: 42},
          ),
        ),
    ),
  );
  let generation = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.integer({min: 0, max: 1000}),
      async (matchingProject, healthPanel, connected, count) => {
        await render('demo', ++generation, {
          panel: healthPanel ? 'context-health' : 'shares',
          connected,
          contextHealthDecisionCount: {project: matchingProject ? 'demo' : 'other', count},
        });
        const expected = connected ? (matchingProject && healthPanel ? count : 42) : 0;
        // Query through the section label, independent of its current count.
        const health = [...document.querySelectorAll('.primary-nav button')].find(
          button => button.querySelector('strong')?.textContent === 'Context Health',
        );
        expect(health?.querySelector('.nav-attention-badge')?.textContent ?? '0').toBe(expected.toLocaleString());
        expect(document.querySelector('[aria-label="1 unresolved sharing conflict"]') !== null).toBe(connected);
      },
    ),
    {numRuns: 24},
  );
  await render('demo', ++generation);
  expect(document.querySelector('[aria-label="42 memories need attention in demo"]')).not.toBeNull();
});

it.each([
  ['ArrowLeft', false, 284],
  ['ArrowLeft', true, 252],
  ['ArrowRight', false, 316],
  ['ArrowRight', true, 348],
  ['Home', false, 155],
  ['End', false, 440],
  ['Enter', false, 180],
  ['Escape', false, undefined],
] as const)('preserves sidebar keyboard behavior for %s (shift: %s)', (key, shift, expected) => {
  expect(sidebarWidthForKey(key, 300, shift)).toBe(expected);
});
