// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerLiveProvider} from '../../src/live/provider.js';
import {ModelSetupProvider, useModelSetup} from '../../src/model_setup_live.js';
import {ModelSetupPanel} from '../../src/model_setup.js';
import {ManagerProcessesProvider, useManagerProcesses} from '../../src/process/live.js';
import {useNavigationAttention} from '../../src/navigation_attention.js';
import {RuntimeUpdatesPanel} from '../../src/runtime_updates_view.js';
import {useManagerRuntimeConnection} from '../../src/ui/live.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';

let root: Root | undefined;
let reads: Map<string, number>;
let tickets: number;
let runtimeJob: 'running' | 'completed' | undefined;
let changed: number;
const setup = {
  version: 1,
  intentEpoch: 7,
  modelId: 'fixture',
  totalBytes: 100,
  policy: 'automatic',
  phase: 'not-requested',
  bytes: 0,
  attempts: 0,
  artifactReady: false,
  effectiveDefault: false,
  environmentOff: false,
};
const updates = {
  installedVersion: '1.0',
  runningVersion: '1.0',
  channel: 'latest',
  developmentBuild: false,
  restartRequired: false,
  policy: 'notify',
  policyManaged: false,
  automaticRunning: false,
  updateAvailable: false,
  installedNotes: [],
  availableNotes: [],
};
function Probe() {
  useManagerRuntimeConnection({
    runtime: 'connected',
    onLost: () => undefined,
    onReady: () => undefined,
    onRecovery: () => undefined,
  });
  const processes = useManagerProcesses();
  const navigation = useNavigationAttention('one', 0, 'home', true);
  const model = useModelSetup();
  return (
    <>
      <output data-testid="process">{processes.diagnostics ? 'loaded' : 'missing'}</output>
      <output data-testid="shares">{navigation.shares}</output>
      <output data-testid="model">{model.status?.phase}</output>
      <RuntimeUpdatesPanel
        onChanged={() => {
          changed++;
        }}
      />
    </>
  );
}
function ProcessSibling() {
  const inventory = useManagerProcesses();
  return <output data-testid="second-process">{inventory.diagnostics ? 'loaded' : 'missing'}</output>;
}
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  reads = new Map();
  tickets = 0;
  runtimeJob = undefined;
  changed = 0;
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/live-session') {
        tickets++;
        return new Response(JSON.stringify({ticket: 'fixture'}));
      }
      reads.set(url, (reads.get(url) ?? 0) + 1);
      if (url === '/api/processes') return new Response(JSON.stringify({processes: []}));
      if (url === '/api/shares/conflicts') return new Response(JSON.stringify({conflicts: [{id: 'one'}]}));
      if (url.startsWith('/api/attention/context-maintenance'))
        return new Response(JSON.stringify({counts: {decisionMemories: 2}}));
      if (url === '/api/models/setup') return new Response(JSON.stringify(setup));
      if (url.startsWith('/api/runtime/updates'))
        return new Response(
          JSON.stringify({
            ...updates,
            ...(runtimeJob ? {job: {status: runtimeJob, message: 'Installing fixture'}} : {}),
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
it('shares a socket and suppresses process, shares, maintenance, model and update polling while coalescing events', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <ModelSetupProvider>
          <ManagerProcessesProvider>
            <Probe />
            <ProcessSibling />
          </ManagerProcessesProvider>
        </ModelSetupProvider>
      </ManagerLiveProvider>,
    ),
  );
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['processes', 'share-conflicts', 'context-maintenance', 'model-setup', 'runtime-updates']);
    socket.ack();
  });
  await flush();
  expect(document.querySelector('[data-testid=process]')?.textContent).toBe('loaded');
  expect(document.querySelector('[data-testid=second-process]')?.textContent).toBe('loaded');
  expect(reads.get('/api/processes')).toBe(1);
  expect(document.querySelector('[data-testid=shares]')?.textContent).toBe('1');
  expect(document.querySelector('[data-testid=model]')?.textContent).toBe('not-requested');
  const before = new Map(reads);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(reads).toEqual(before);
  expect(reads.get('/api/health')).toBeUndefined();
  let sequence = 0;
  for (const resource of [
    {topic: 'processes', scope: 'account'},
    {topic: 'share-conflicts', scope: 'account'},
    {topic: 'context-maintenance', project: 'one'},
    {topic: 'model-setup', scope: 'account'},
    {topic: 'runtime-updates', scope: 'account'},
  ]) {
    const beforeCount = [...reads.values()].reduce((sum, count) => sum + count, 0);
    await act(async () => {
      for (let index = 0; index < 100; index++) socket.invalidate(++sequence, resource);
    });
    await flush();
    const afterCount = [...reads.values()].reduce((sum, count) => sum + count, 0);
    expect(afterCount - beforeCount).toBeLessThanOrEqual(2);
  }
  expect(tickets).toBe(1);
  expect(FakeManagerSocket.instances).toHaveLength(1);
});

it('loads full runtime details once per terminal job identity and never schedules a supported running poll', async () => {
  runtimeJob = 'running';
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <ModelSetupProvider>
          <RuntimeUpdatesPanel
            onChanged={() => {
              changed++;
            }}
          />
        </ModelSetupProvider>
      </ManagerLiveProvider>,
    ),
  );
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['runtime-updates', 'model-setup']);
    socket.ack();
  });
  await flush();
  const initialFull = reads.get('/api/runtime/updates') ?? 0;
  const initialStatus = reads.get('/api/runtime/updates?view=status') ?? 0;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(reads.get('/api/runtime/updates?view=status')).toBe(initialStatus);
  runtimeJob = 'completed';
  await act(async () => socket.invalidate(1, {topic: 'runtime-updates', scope: 'account'}));
  await flush();
  expect(reads.get('/api/runtime/updates')).toBe(initialFull + 1);
  expect(changed).toBe(1);
  await act(async () => socket.invalidate(2, {topic: 'runtime-updates', scope: 'account'}));
  await flush();
  expect(reads.get('/api/runtime/updates')).toBe(initialFull + 1);
  expect(changed).toBe(1);
});

it('clears model setup state and aborts an old account command before accepting its late response', async () => {
  let activeAccount = 'one';
  const pending = Promise.withResolvers<Response>();
  let oldSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/live-session') return new Response(JSON.stringify({ticket: 'fixture'}));
      if (url === '/api/models/setup') {
        if (init?.method === 'POST') {
          oldSignal = init.signal ?? undefined;
          return pending.promise;
        }
        return new Response(
          JSON.stringify({
            ...setup,
            intentEpoch: activeAccount === 'one' ? 7 : 19,
            phase: activeAccount === 'one' ? 'not-requested' : 'off',
            policy: activeAccount === 'one' ? 'automatic' : 'off',
          }),
        );
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const renderAccount = async (account: string) => {
    await act(async () =>
      root?.render(
        <ManagerLiveProvider account={account} key={account}>
          <ModelSetupProvider>
            <ModelSetupPanel />
          </ModelSetupProvider>
        </ManagerLiveProvider>,
      ),
    );
  };
  await renderAccount('one');
  await flush();
  const first = FakeManagerSocket.instances[0];
  await act(async () => {
    first.open(['model-setup']);
    first.ack();
  });
  await flush();
  const setupButton = [...document.querySelectorAll('button')].find(button =>
    button.textContent?.includes('Set up local model'),
  ) as HTMLButtonElement;
  await act(async () => setupButton.click());
  expect(oldSignal).toBeDefined();
  activeAccount = 'two';
  await renderAccount('two');
  await flush();
  expect(oldSignal?.aborted).toBe(true);
  const second = FakeManagerSocket.instances[1];
  await act(async () => {
    second.open(['model-setup']);
    second.ack();
  });
  await flush();
  pending.resolve(new Response(JSON.stringify({...setup, artifactReady: true, phase: 'ready'})));
  await flush();
  expect(document.body.textContent).toContain('Automatic setup is off');
  expect(document.body.textContent).not.toContain('Model files are verified');
  expect(first.readyState).toBe(3);
});

it.each(['success', 'failure'])('resumes fallback when coverage is lost during command %s', async result => {
  let current = {...setup};
  let gets = 0;
  const command = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (url === '/api/live-session') return new Response(JSON.stringify({ticket: 'fixture'}));
    if (init?.method === 'POST') return command.promise;
    gets++;
    return new Response(JSON.stringify(current));
  });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <ModelSetupProvider>
          <ModelSetupPanel />
        </ModelSetupProvider>
      </ManagerLiveProvider>,
    ),
  );
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['model-setup']);
    socket.ack();
  });
  await flush();
  expect(gets).toBe(1);
  await act(async () =>
    [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Set up local model'))?.click(),
  );
  await act(async () =>
    socket.emit(
      JSON.stringify({
        type: 'availability',
        version: 1,
        epoch: 'epoch-one',
        generation: socket.sent.filter(f => f.type === 'subscribe').at(-1)?.generation,
        sequence: 1,
        resource: {topic: 'model-setup', scope: 'account'},
        available: false,
      }),
    ),
  );
  await flush();
  expect(gets).toBe(1);
  current = {...current, intentEpoch: 8, phase: 'pending'};
  await act(async () =>
    command.resolve(
      new Response(JSON.stringify(result === 'success' ? current : {error: 'Changed elsewhere'}), {
        status: result === 'success' ? 200 : 409,
      }),
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(gets).toBe(2);
  current = {...current, phase: 'ready', artifactReady: true};
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(document.body.textContent).toContain('Model files are verified');
});
