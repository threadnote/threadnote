// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerLiveProvider} from '../../src/live/provider.js';
import {ContextHealthPanel} from '../../src/attention_view.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';
let root: Root | undefined;
let healthReads: number;
let jobReads: number;
let jobStatus: 'running' | 'completed';
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  healthReads = jobReads = 0;
  jobStatus = 'running';
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/live-session') return new Response(JSON.stringify({ticket: 'fixture'}));
      if (url.startsWith('/api/context-health/citations/jobs')) {
        jobReads++;
        return new Response(
          JSON.stringify({
            job: {
              id: 'job-one',
              status: jobStatus,
              project: 'one',
              createdAt: '2026-10-23T00:00:00Z',
              progress: {
                phase: jobStatus === 'running' ? 'scanning' : 'completed',
                message: 'Checking citations',
                batch: 1,
                failedCount: 0,
                initialCitationCount: 0,
                pagesScanned: 0,
                repairableCount: 0,
                repairedCount: 0,
                unresolvedCount: 0,
              },
            },
          }),
        );
      }
      if (url.startsWith('/api/context-health')) {
        healthReads++;
        return new Response(
          JSON.stringify({
            findings: [],
            limit: 100,
            omittedFindings: 0,
            project: 'one',
            recordPreviews: [],
            recordsScanned: 0,
            repositoryEvidence: {state: 'available'},
            semanticCompleteness: {reason: 'complete', state: 'complete'},
            status: 'healthy',
            version: 1,
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
it('does not poll a supported citation job and refreshes health once at terminal status', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <ContextHealthPanel
          project="one"
          projects={['one']}
          refreshGeneration={0}
          onOpenLibrary={() => undefined}
          onProjectChange={() => undefined}
        />
      </ManagerLiveProvider>,
    ),
  );
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['context-health', 'citation-repair-jobs']);
    socket.ack();
  });
  await flush();
  await act(async () => socket.ack());
  await flush();
  expect(jobReads).toBeGreaterThanOrEqual(1);
  const initialJobs = jobReads;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(jobReads).toBe(initialJobs);
  await act(async () => {
    for (let sequence = 1; sequence <= 100; sequence++)
      socket.invalidate(sequence, {topic: 'citation-repair-jobs', project: 'one'});
  });
  await flush();
  expect(jobReads - initialJobs).toBeLessThanOrEqual(2);
  const beforeTerminal = healthReads;
  jobStatus = 'completed';
  await act(async () => socket.invalidate(101, {topic: 'citation-repair-jobs', project: 'one'}));
  await flush();
  expect(healthReads - beforeTerminal).toBe(1);
  await act(async () => socket.invalidate(102, {topic: 'citation-repair-jobs', project: 'one'}));
  await flush();
  expect(healthReads - beforeTerminal).toBe(1);
});
