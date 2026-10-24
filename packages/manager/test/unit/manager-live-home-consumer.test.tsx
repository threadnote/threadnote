// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerLiveProvider} from '../../src/live/provider.js';
import {ManagerHomePanel} from '../../src/home_view.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';

let root: Root | undefined;
let homeReads: string[];
let tickets: number;
async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}
async function render(project: string) {
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="test-account">
        <ManagerHomePanel
          project={project}
          projects={['one', 'two']}
          onProjectChange={() => undefined}
          onOpen={() => undefined}
        />
      </ManagerLiveProvider>,
    ),
  );
}
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  homeReads = [];
  tickets = 0;
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/live-session') {
        tickets++;
        return new Response(JSON.stringify({ticket: 'fixture'}));
      }
      if (url.startsWith('/api/home?')) {
        const project = new URL(url, 'http://localhost').searchParams.get('project') ?? '';
        homeReads.push(project);
        return new Response(
          JSON.stringify({version: 1, project, handoffs: [], lanes: [], stats: {memories: 1, pending: 0}}),
        );
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('uses one socket, no idle business polling, coalesces bursts, and fences a project switch', async () => {
  await render('one');
  await flush();
  const socket = FakeManagerSocket.instances[0];
  expect(FakeManagerSocket.instances).toHaveLength(1);
  await act(async () => {
    socket.open(['home']);
    socket.ack();
  });
  await flush();
  expect(homeReads).toEqual(['one']);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(homeReads).toEqual(['one']);
  await act(async () => {
    for (let sequence = 1; sequence <= 100; sequence++) socket.invalidate(sequence, {topic: 'home', project: 'one'});
  });
  await flush();
  expect(homeReads.length).toBeLessThanOrEqual(3);
  await render('two');
  await flush();
  expect(document.body.textContent).not.toContain('one ·');
  socket.ack();
  await flush();
  expect(homeReads.at(-1)).toBe('two');
  expect(tickets).toBe(1);
  expect(FakeManagerSocket.instances).toHaveLength(1);
});
