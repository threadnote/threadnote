// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {RuntimeUpdatesPanel} from '../../src/runtime_updates_view.js';
import type {RuntimeUpdates} from '../../src/update_contracts.js';

let root: Root;
let state: RuntimeUpdates;
let calls: {url: string; body?: Record<string, unknown>}[];
const onChanged = vi.fn();
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  calls = [];
  state = {
    installedVersion: '5.1.0',
    runningVersion: '5.1.0',
    channel: 'latest',
    developmentBuild: false,
    restartRequired: false,
    policy: 'automatic',
    policyManaged: false,
    automaticRunning: false,
    latestVersion: '5.1.2',
    updateAvailable: true,
    installedNotes: [{version: '5.1.0', title: 'Installed changes', body: '- Existing capability'}],
    availableNotes: [{version: '5.1.2', title: 'New changes', body: '- New capability'}],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({url, body});
      if (body?.action === 'policy') state = {...state, policy: body.policy as 'automatic' | 'notify'};
      if (body?.action === 'update') state = {...state, job: {status: 'running', message: 'Installing…'}};
      return new Response(JSON.stringify(state));
    }),
  );
  onChanged.mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<RuntimeUpdatesPanel onChanged={onChanged} />));
}
function button(label: string): HTMLButtonElement {
  const value = [...document.querySelectorAll('button')].find(node => node.textContent?.includes(label));
  if (!value) throw new Error('Missing button ' + label);
  return value;
}
it('shows both release notes and persists an explicit automatic-update choice', async () => {
  await render();
  expect(document.body.textContent).toContain('Existing capability');
  expect(document.body.textContent).toContain('New capability');
  const toggle = document.querySelector('[role=switch]') as HTMLButtonElement;
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(calls[1]?.body).toEqual({action: 'policy', policy: 'notify', confirm: true});
  await act(async () => button('Check for updates').click());
  expect(calls[2]?.body?.action).toBe('check');
});
it('polls local job status until completion, then shows restart guidance and stops polling', async () => {
  await render();
  await act(async () => button('Update Threadnote').click());
  expect(button('Updating…').disabled).toBe(true);
  expect(document.body.textContent).toContain('Updating Threadnote');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(calls.at(-1)?.url).toBe('/api/runtime/updates?view=status');
  state = {
    ...state,
    installedVersion: '5.1.2',
    restartRequired: true,
    updateAvailable: false,
    job: {status: 'completed', message: 'Installed successfully.'},
  };
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(document.body.textContent).toContain('This Manager is still running 5.1.0');
  expect(document.body.textContent).toContain('threadnote manage');
  expect(onChanged).toHaveBeenCalledOnce();
  expect(button('Update Threadnote').disabled).toBe(true);
  const completedCount = calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(calls).toHaveLength(completedCount);
});
it('exposes check failures without a false up-to-date badge and disables managed preferences', async () => {
  state = {
    ...state,
    latestVersion: undefined,
    updateAvailable: false,
    checkError: 'Network unavailable',
    notesError: 'Release notes unavailable',
    policyManaged: true,
  };
  await render();
  expect(document.body.textContent).toContain('Check failed');
  expect(document.body.textContent).not.toContain('Up to date');
  expect(button('Check for updates').disabled).toBe(false);
  expect(button('Update Threadnote').disabled).toBe(true);
  expect((document.querySelector('[role=switch]') as HTMLButtonElement).disabled).toBe(true);
});
it('renders release-note Markdown without executing embedded HTML', async () => {
  state = {
    ...state,
    installedNotes: [
      {version: '5.1.0', title: 'Notes', body: '<script>alert(1)</script>\n\n[bad](javascript:alert(1))'},
    ],
  };
  await render();
  expect(document.querySelector('.runtime-release-notes script')).toBeNull();
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
});
