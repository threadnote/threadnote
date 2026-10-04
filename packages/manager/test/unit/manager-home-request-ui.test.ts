// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import fc from 'fast-check';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerHomePanel} from '@threadnote/manager/home-view';

let root: Root | undefined;
let requests: (AbortSignal | undefined)[];

beforeEach(() => {
  requests = [];
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          requests.push(signal ?? undefined);
          if (!signal) return;
          signal.addEventListener('abort', () => reject(new DOMException('Synthetic abort', 'AbortError')), {
            once: true,
          });
        }),
    ),
  );
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('aborts pending Home work on unmount', async () => {
  await mount();
  await render('first');
  expect(requests).toHaveLength(1);
  await act(async () => root?.unmount());
  root = undefined;
  expect(requests[0]?.aborted).toBe(true);
});

it('ends a stalled request with visible feedback before the transport idle deadline', async () => {
  await mount();
  await render('first');
  await act(async () => vi.advanceTimersByTimeAsync(8_001));
  expect(requests[0]?.aborted).toBe(true);
  expect(document.body.textContent).toContain('Project home is unavailable');
  expect(document.body.textContent).not.toContain('Loading project home');
});

it('owns at most one active request across project changes and refresh ticks', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.integer({min: 0, max: 5}), {minLength: 1, maxLength: 6}), async projects => {
      requests = [];
      await mount();
      for (const project of projects) {
        await render(`synthetic-${project}`);
        expect(requests.filter(signal => !signal?.aborted)).toHaveLength(1);
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(requests.filter(signal => !signal?.aborted).length).toBeLessThanOrEqual(1);
      }
      await act(async () => root?.unmount());
      root = undefined;
      expect(requests.every(signal => signal?.aborted)).toBe(true);
      document.body.replaceChildren();
    }),
    {numRuns: 12},
  );
});

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
}

async function render(project: string) {
  await act(async () =>
    root?.render(
      React.createElement(ManagerHomePanel, {
        project,
        projects: [project],
        onOpen: () => undefined,
        onProjectChange: () => undefined,
      }),
    ),
  );
}
