// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {String as EffectString} from 'effect';
import * as liveProvider from '../../src/live/provider.js';
import {ContextHealthPanel} from '../../src/attention_view.js';
import {MaintenanceControls} from '../../src/attention/maintenance_controls.js';

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(element: React.ReactElement) {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
}
const response = (paused: boolean) =>
  new Response(JSON.stringify({paused}), {headers: {'content-type': 'application/json'}});

it.each(['', 'threadnote'])('keeps global controls first while project health is unavailable (%s)', async project => {
  const actions: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!EffectString.includes('view=controls')(url)) throw new Error('Project health is unavailable');
      expect(url).not.toContain('project=');
      if (init?.body) actions.push(JSON.parse(String(init.body)));
      return response(!init?.body);
    }),
  );
  await render(
    <ContextHealthPanel
      project={project}
      projects={['threadnote']}
      refreshGeneration={0}
      onOpenLibrary={() => undefined}
      onProjectChange={() => undefined}
    />,
  );
  const control = document.querySelector('[aria-label="Automatic maintenance controls"]')!;
  expect(document.body.querySelector('section')).toBe(control);
  expect(control.textContent).toContain('Off');
  const button = control.querySelector('button')!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(actions).toEqual([{action: 'resume'}]);
  expect(control.textContent).toContain('On');
});

it('does not let a pre-pause status request overwrite confirmed off', async () => {
  const stale = Promise.withResolvers<Response>();
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) return response(true);
      return ++reads === 1 ? response(false) : stale.promise;
    }),
  );
  await render(<MaintenanceControls project="" />);
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => document.querySelector('button')!.click());
  expect(document.querySelector('.health-status-badge')?.textContent).toBe('Off');
  await act(async () => stale.resolve(response(false)));
  expect(document.querySelector('.health-status-badge')?.textContent).toBe('Off');
});

it('rejects live reads started during a pending toggle when they finish after confirmation', async () => {
  let read: ((signal: AbortSignal) => Promise<unknown>) | undefined;
  const invalidate = vi.fn();
  vi.spyOn(liveProvider, 'useManagerLiveQuery').mockImplementation((_resource, _key, reader) => {
    read = reader;
    return {active: true, snapshot: {status: 'loading'}, invalidate};
  });
  const pendingPost = Promise.withResolvers<Response>();
  const stale = Promise.withResolvers<Response>();
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.body ? pendingPost.promise : ++reads === 1 ? response(false) : stale.promise,
    ),
  );
  await render(<MaintenanceControls project="threadnote" />);
  await act(async () => {
    await read!(new AbortController().signal);
  });
  await act(async () => document.querySelector('button')!.click());
  let late: Promise<unknown> | undefined;
  await act(async () => {
    late = read!(new AbortController().signal);
  });
  await act(async () => pendingPost.resolve(response(true)));
  expect(document.querySelector('.health-status-badge')?.textContent).toBe('Off');
  await act(async () => {
    stale.resolve(response(false));
    await late;
  });
  expect(document.querySelector('.health-status-badge')?.textContent).toBe('Off');
});
