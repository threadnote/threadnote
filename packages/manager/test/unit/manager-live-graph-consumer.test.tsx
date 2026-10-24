// @vitest-environment happy-dom
import React, {act, useRef, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerLiveProvider} from '../../src/live/provider.js';
import {useGraphLiveStatus} from '../../src/ui/live.js';
import type {GraphCatalog} from '../../src/graph.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';

let root: Root | undefined;
let statusReads: number;
let catalogReads: number;
let diagnosticReads: number;
let revision: string;
let catalogGate: Promise<void> | undefined;
let catalogSignal: AbortSignal | undefined;
function Probe({enabled = true}: {enabled?: boolean}) {
  const [catalog, setCatalog] = useState<GraphCatalog>();
  const catalogRef = useRef<GraphCatalog | undefined>(undefined);
  const authoritative = useRef(false);
  const diagnosticsRevision = useRef<string | undefined>(undefined);
  const [, setError] = useState('');
  useGraphLiveStatus({
    enabled,
    catalog: catalogRef,
    authoritative,
    diagnosticsRevision,
    setCatalog,
    setError,
    refreshDiagnostics: async value => {
      diagnosticReads++;
      diagnosticsRevision.current = value;
    },
  });
  return <output>{catalog?.catalogRevision}</output>;
}
async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  statusReads = catalogReads = diagnosticReads = 0;
  revision = 'r1';
  catalogGate = undefined;
  catalogSignal = undefined;
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/live-session') return new Response(JSON.stringify({ticket: 'fixture'}));
      if (url === '/api/graphs/status') {
        statusReads++;
        return new Response(
          JSON.stringify({
            builds: [],
            catalogRevision: revision,
            maintenance: undefined,
            lifecyclePending: false,
            waiterCount: 0,
            waiters: [],
          }),
        );
      }
      if (url === '/api/graphs') {
        catalogReads++;
        catalogSignal = init?.signal ?? undefined;
        await catalogGate;
        return new Response(
          JSON.stringify({
            builds: [],
            diagnostics: [],
            repositories: [],
            catalogRevision: revision,
            waiterCount: 0,
            waiters: [],
          }),
        );
      }
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
it('reads status on live invalidation and refreshes catalog and diagnostics only on a changed revision', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <Probe />
      </ManagerLiveProvider>,
    ),
  );
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['graph-status']);
    socket.ack();
  });
  await flush();
  expect([statusReads, catalogReads, diagnosticReads]).toEqual([1, 1, 1]);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect([statusReads, catalogReads, diagnosticReads]).toEqual([1, 1, 1]);
  await act(async () => {
    for (let sequence = 1; sequence <= 100; sequence++)
      socket.invalidate(sequence, {topic: 'graph-status', scope: 'account'});
  });
  await flush();
  expect(statusReads).toBeLessThanOrEqual(3);
  expect(catalogReads).toBe(1);
  expect(diagnosticReads).toBe(1);
  revision = 'r2';
  await act(async () => socket.invalidate(101, {topic: 'graph-status', scope: 'account'}));
  await flush();
  expect(catalogReads).toBe(2);
  expect(diagnosticReads).toBe(2);
});

it('coalesces dependent catalog reads and aborts a pending read when Graph is left', async () => {
  const firstGate = Promise.withResolvers<void>();
  catalogGate = firstGate.promise;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const renderProbe = async (enabled: boolean) => {
    await act(async () =>
      root?.render(
        <ManagerLiveProvider account="one">
          <Probe enabled={enabled} />
        </ManagerLiveProvider>,
      ),
    );
  };
  await renderProbe(true);
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['graph-status']);
    socket.ack();
  });
  await flush();
  expect(catalogReads).toBe(1);
  await act(async () => {
    for (let sequence = 1; sequence <= 100; sequence++)
      socket.invalidate(sequence, {topic: 'graph-status', scope: 'account'});
  });
  await flush();
  expect(catalogReads).toBe(1);
  firstGate.resolve();
  await flush();
  expect(catalogReads).toBe(1);
  revision = 'r2';
  const secondGate = Promise.withResolvers<void>();
  catalogGate = secondGate.promise;
  await act(async () => socket.invalidate(101, {topic: 'graph-status', scope: 'account'}));
  await flush();
  expect(catalogReads).toBe(2);
  const signal = catalogSignal;
  await renderProbe(false);
  expect(signal?.aborted).toBe(true);
  secondGate.resolve();
  await flush();
  expect(document.querySelector('output')?.textContent).toBe('r1');
});
