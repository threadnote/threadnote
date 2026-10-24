// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerLiveProvider} from '../../src/live/provider.js';
import {ManagerProcessesProvider} from '../../src/process/live.js';
import {ManagerOperationsFooter} from '../../src/operations_footer.js';
import {ProcessesPanel} from '../../src/processes_view.js';
import {ManagerDialogProvider} from '../../src/dialog.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';

let root: Root | undefined;
let reads: number;
const response = () =>
  new Response(
    JSON.stringify({
      schemaVersion: 1,
      truncated: false,
      processes: [
        {
          ageMilliseconds: 1_000,
          currentOperation: 'graph',
          parentProcessId: 0,
          processId: 42,
          role: 'mcp',
          startedAt: '2026-10-23T00:00:00Z',
          terminable: false,
        },
      ],
    }),
  );
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  reads = 0;
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/live-session') return new Response(JSON.stringify({ticket: 'fixture'}));
      if (url === '/api/processes') {
        reads++;
        return response();
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
it('retains scoped rows and footer during a held read/error and advances age without a GET', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <ManagerProcessesProvider>
          <ManagerDialogProvider>
            <ProcessesPanel />
            <ManagerOperationsFooter onOpen={() => undefined} />
          </ManagerDialogProvider>
        </ManagerProcessesProvider>
      </ManagerLiveProvider>,
    ),
  );
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['processes']);
    socket.ack();
  });
  await flush();
  expect(reads).toBe(1);
  expect(document.querySelector('.process-workspace')?.textContent).toContain('Graph');
  expect(document.querySelector('.footer-operations.is-visible')).not.toBeNull();
  const deferred = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockImplementationOnce(async () => deferred.promise);
  await act(async () => socket.invalidate(1, {topic: 'processes', scope: 'account'}));
  await flush();
  expect(document.querySelector('.process-workspace')?.textContent).toContain('Graph');
  expect(document.querySelector('.footer-operations.is-visible')).not.toBeNull();
  await act(async () => deferred.reject(new Error('temporary process read failure')));
  expect(document.querySelector('.process-workspace')?.textContent).toContain('Graph');
  expect(document.querySelector('.process-workspace')?.textContent).toContain('temporary process read failure');
  const before = reads;
  const ageBefore = document.querySelector('.process-row')?.textContent;
  await act(async () => vi.advanceTimersByTimeAsync(65_000));
  expect(reads).toBe(before);
  expect(document.querySelector('.process-row')?.textContent).not.toBe(ageBefore);
});
