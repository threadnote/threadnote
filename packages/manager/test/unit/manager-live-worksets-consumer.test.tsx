// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerLiveProvider} from '../../src/live/provider.js';
import {ManagerDialogProvider} from '../../src/dialog.js';
import {WorksetsPanel} from '../../src/worksets_view.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';
let root: Root | undefined;
let reads: string[];
const catalog = {
  definitions: [{name: 'demo', memberCount: 0}],
  projects: [{name: 'one', path: '/tmp/one', folder: '/tmp', branchState: 'current', worksets: [], worksetCount: 0}],
  readOnly: false,
  projectsReadOnly: false,
  revision: 'rev-one',
  type: 'manager-workset-catalog',
  version: 1,
  definitionSource: 'seed-manifest',
  editability: {state: 'editable'},
  projectEditability: {state: 'editable'},
};
const job = {
  id: 'job-one',
  workset: 'demo',
  createdAt: '2026-10-23T00:00:00Z',
  status: 'running',
  progress: {phase: 'building', message: 'Preparing', total: 1},
};
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  reads = [];
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/live-session') return new Response(JSON.stringify({ticket: 'fixture'}));
      reads.push(url);
      if (url === '/api/worksets') return new Response(JSON.stringify(catalog));
      if (url === '/api/worksets/jobs') return new Response(JSON.stringify({jobs: [job]}));
      if (url === '/api/worksets/jobs/job-one') return new Response(JSON.stringify({job}));
      if (url.startsWith('/api/worksets/definition'))
        return new Response(JSON.stringify({name: 'demo', members: [], configuredMembers: 0, unresolvedMembers: 0}));
      if (url.startsWith('/api/worksets/status'))
        return new Response(
          JSON.stringify({
            type: 'code-graph-workset-status',
            version: 1,
            workset: 'demo',
            catalog: {state: 'missing'},
            coverage: {current: 0, requested: 0, states: {}},
            manifestDigest: 'x',
            members: [],
            warnings: [],
          }),
        );
      throw new Error(`Unexpected ${url}`);
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
it('keeps mounted workset queries quiet between broad live events while the progress display clock runs', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <ManagerDialogProvider>
          <WorksetsPanel />
        </ManagerDialogProvider>
      </ManagerLiveProvider>,
    ),
  );
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['worksets']);
    socket.ack();
  });
  await flush();
  socket.ack();
  await flush();
  const initial = reads.length;
  expect(initial).toBeGreaterThanOrEqual(3);
  const create = document.querySelector('[aria-label="Create workset"]') as HTMLButtonElement;
  await act(async () => create.click());
  const description = document.querySelector('.worksets-editor textarea') as HTMLTextAreaElement;
  expect(description).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      description,
      'Keep this draft while jobs change',
    );
    description.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(reads).toHaveLength(initial);
  await act(async () => {
    for (let sequence = 1; sequence <= 100; sequence++)
      socket.invalidate(sequence, {topic: 'worksets', scope: 'account'});
  });
  await flush();
  expect(reads.length - initial).toBeLessThanOrEqual(10);
  expect((document.querySelector('.worksets-editor textarea') as HTMLTextAreaElement)?.value).toBe(
    'Keep this draft while jobs change',
  );
  expect(FakeManagerSocket.instances).toHaveLength(1);
});

it('surfaces an initial supported catalog failure and retries without losing the selected view', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <ManagerDialogProvider>
          <WorksetsPanel />
        </ManagerDialogProvider>
      </ManagerLiveProvider>,
    ),
  );
  await flush();
  const socket = FakeManagerSocket.instances[0];
  vi.mocked(fetch).mockImplementationOnce(async () => {
    throw new Error('temporary catalog failure');
  });
  await act(async () => {
    socket.open(['worksets']);
    socket.ack();
  });
  await flush();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('temporary catalog failure');
  const retry = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Retry catalog'))!;
  await act(async () => retry.click());
  await flush();
  expect(document.querySelector('[role=alert]')).toBeNull();
  expect(document.body.textContent).toContain('demo');
});

it('translates a supported readiness error and recovers with the existing refresh control', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <ManagerDialogProvider>
          <WorksetsPanel />
        </ManagerDialogProvider>
      </ManagerLiveProvider>,
    ),
  );
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['worksets']);
    socket.ack();
  });
  await flush();
  await act(async () =>
    [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Open workset'))?.click(),
  );
  const original = vi.mocked(fetch).getMockImplementation();
  let fail = true;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (fail && String(url).startsWith('/api/worksets/status'))
      return new Response(JSON.stringify({code: 'maintenance-busy', error: 'Busy'}), {status: 503});
    return original?.(url, init) ?? new Response(null, {status: 500});
  });
  await act(async () => socket.invalidate(1, {topic: 'worksets', scope: 'account'}));
  await flush();
  expect(document.querySelector('[aria-label="Workset readiness"]')?.textContent).toContain(
    'Readiness is temporarily unavailable while graph maintenance is active',
  );
  fail = false;
  const refresh = [...document.querySelectorAll('[aria-label="Workset readiness"] button')].find(button =>
    button.textContent?.includes('Refresh'),
  ) as HTMLButtonElement;
  await act(async () => refresh.click());
  await flush();
  expect(document.querySelector('[aria-label="Workset readiness"]')?.textContent).not.toContain(
    'Readiness is temporarily unavailable',
  );
});

it.each(['/api/worksets/jobs', '/api/worksets/definition', '/api/worksets/jobs/job-one'])(
  'clears only the recovered live read error for %s',
  async endpoint => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root?.render(
        <ManagerLiveProvider account="one">
          <ManagerDialogProvider>
            <WorksetsPanel />
          </ManagerDialogProvider>
        </ManagerLiveProvider>,
      ),
    );
    await flush();
    const socket = FakeManagerSocket.instances[0];
    await act(async () => {
      socket.open(['worksets']);
      socket.ack();
    });
    await flush();
    await act(async () => socket.ack());
    await flush();
    await act(async () =>
      [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Open workset'))?.click(),
    );
    const original = vi.mocked(fetch).getMockImplementation();
    let fail = true;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (fail && String(url).split('?')[0] === endpoint) throw new Error('temporary scoped read failure');
      return original?.(url, init) ?? new Response(null, {status: 500});
    });
    await act(async () => socket.invalidate(1, {topic: 'worksets', scope: 'account'}));
    await flush();
    expect(document.body.textContent).toContain('temporary scoped read failure');
    fail = false;
    await act(async () => socket.invalidate(2, {topic: 'worksets', scope: 'account'}));
    await flush();
    expect(document.body.textContent).not.toContain('temporary scoped read failure');
    expect(document.body.textContent).toContain('demo');
  },
);
