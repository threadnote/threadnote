// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerLiveProvider} from '../../src/live/provider.js';
import type {ManagerContextHealthResponseV1} from '../../src/attention/contracts.js';
import {ContextHealthPanel} from '../../src/attention_view.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

let root: Root | undefined;
let healthReads: number;
let jobReads: number;
let jobStatus: 'running' | 'completed';
const healthResponse = (): ManagerContextHealthResponseV1 => ({
  findings: [],
  limit: 100,
  omittedFindings: 0,
  project: 'one',
  recordPreviews: [],
  recordsScanned: 0,
  repositoryEvidence: {state: 'available'},
  semanticCompleteness: {
    version: 2,
    state: 'complete',
    eligibleRecords: 0,
    analyzedRecords: 0,
    unknownRecords: 0,
    claimsAnalyzed: 0,
    supportedClaims: 0,
    unsupportedClaims: 0,
    coverage: 'bounded-English-extraction',
    contradictionCount: 0,
    pairsCompared: 0,
    omittedContradictions: 0,
    unknownReasons: [],
  },
  status: 'clean',
  version: 1,
});
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  healthReads = jobReads = 0;
  jobStatus = 'running';
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/attention/context-maintenance?view=controls')
        return new Response(JSON.stringify({paused: true}));
      if (url === '/api/live-session') return new Response(JSON.stringify({ticket: 'fixture'}));
      if (Effect.pipe(url, EffectString.startsWith('/api/context-health/citations/jobs'))) {
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
      if (Effect.pipe(url, EffectString.startsWith('/api/context-health'))) {
        healthReads++;
        return new Response(JSON.stringify(healthResponse()));
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

it('keeps supported health content mounted while revalidating and retains the failure until an actual recovery', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const panel = (refreshGeneration: number) => (
    <ManagerLiveProvider account="one">
      <ContextHealthPanel
        project="one"
        projects={['one']}
        refreshGeneration={refreshGeneration}
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
      />
    </ManagerLiveProvider>
  );
  await act(async () => root?.render(panel(0)));
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['context-health', 'citation-repair-jobs']);
    socket.ack();
  });
  await flush();
  await act(async () => socket.ack());
  await flush();
  const metrics = document.querySelector('.attention-metrics');
  expect(metrics).not.toBeNull();
  const status = document.querySelector('.attention-refresh-status');
  const pending = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockImplementationOnce(() => pending.promise);
  await act(async () => socket.invalidate(1, {topic: 'context-health', project: 'one'}));
  await flush();
  expect(document.querySelector('.attention-metrics')).toBe(metrics);
  expect(status?.textContent).toContain('Checking for context updates');
  await act(async () => pending.reject(new Error('Temporary supported health failure')));
  await flush();
  const alert = status?.querySelector('[role=alert]');
  expect(alert?.textContent).toContain('Temporary supported health failure');
  const retry = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockImplementationOnce(() => retry.promise);
  await act(async () => root?.render(panel(1)));
  await flush();
  expect(status?.querySelector('[role=alert]')).toBe(alert);
  expect(document.querySelector('.attention-metrics')).toBe(metrics);
  await act(async () => retry.resolve(new Response(JSON.stringify(healthResponse()))));
  await flush();
  expect(status?.querySelector('[role=alert]')).toBeNull();
  expect(document.querySelector('.attention-metrics')).toBe(metrics);
  vi.mocked(fetch).mockImplementationOnce(
    async () => new Response(JSON.stringify({error: 'Current health access denied'}), {status: 403}),
  );
  await act(async () => socket.invalidate(2, {topic: 'context-health', project: 'one'}));
  await flush();
  expect(document.querySelector('.attention-metrics')).toBeNull();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Current health access denied');
});
