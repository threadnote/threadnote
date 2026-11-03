// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import fc from 'fast-check';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ContextHealthPanel} from '@threadnote/manager/attention-view';
import {HealthDetail} from '../../src/attention_details.js';
import type {ManagerContextHealthResponseV1} from '../../src/attention/contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';
import {Option as EffectOption} from 'effect';

let root: Root | undefined;
let requests: {signal?: AbortSignal; resolve: (response: Response) => void}[];

beforeEach(() => {
  requests = [];
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/attention/context-maintenance?view=controls')
        return Promise.resolve(new Response('{"paused":true}'));
      if (Effect.pipe(String(input), EffectString.includes('/citations/jobs')))
        return Promise.resolve(new Response('{"job":null}'));
      const {promise, resolve, reject} = Promise.withResolvers<Response>();
      const signal = init?.signal ?? undefined;
      requests.push({signal, resolve});
      signal?.addEventListener('abort', () => reject(new DOMException('Synthetic abort', 'AbortError')), {
        once: true,
      });
      return promise;
    }),
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('ends a stalled Health request with visible feedback', async () => {
  await render('first');
  await act(async () => vi.advanceTimersByTimeAsync(59_999));
  expect(requests[0]?.signal?.aborted).toBe(false);
  expect(document.body.textContent).toContain('Checking project context');
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(requests[0]?.signal?.aborted).toBe(true);
  expect(document.body.textContent).toContain('timed out after 60000 ms');
  expect(document.body.textContent).not.toContain('Checking project context');
  const retry = document.querySelector<HTMLButtonElement>('[role="alert"] button');
  expect(retry?.textContent).toBe('Retry checking context');
  await act(async () => retry?.click());
  expect(requests[1]?.signal?.aborted).toBe(false);
  await act(async () => requests[1]?.resolve(healthResponse('first')));
  expect(document.body.textContent).not.toContain('timed out');
  expect(document.querySelector('.attention-metrics')).not.toBeNull();
});

it('accepts a Health response after nine seconds', async () => {
  await render('first');
  await act(async () => vi.advanceTimersByTimeAsync(9_000));
  expect(requests[0]?.signal?.aborted).toBe(false);
  await act(async () => requests[0]?.resolve(healthResponse('first')));
  expect(document.querySelector('.attention-metrics')).not.toBeNull();
  expect(document.body.textContent).not.toContain('timed out');
});

it('accepts valid responses throughout the extended read window', async () => {
  let generation = 0;
  await fc.assert(
    fc.asyncProperty(fc.integer({min: 8_001, max: 59_999}), async delay => {
      const project = `delayed-${generation}`;
      await render(project, generation++);
      const request = requests.at(-1);
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      expect(request?.signal?.aborted).toBe(false);
      await act(async () => request?.resolve(healthResponse(project)));
      expect(document.querySelector('.attention-metrics')).not.toBeNull();
      expect(document.body.textContent).not.toContain('timed out');
    }),
    {numRuns: 12},
  );
});

it('allows detail health revalidation to finish after thirty seconds', async () => {
  const finding: ManagerContextHealthResponseV1['findings'][number] = {
    id: 'review-one',
    category: 'review-overdue',
    severity: 'low',
    confidence: 'high',
    repairability: 'manual-review',
    summary: 'Review this synthetic memory.',
    uris: [],
    repair: {kind: 'review-memory', summary: 'Review the memory.'},
  };
  await act(async () =>
    root?.render(
      <HealthDetail
        project="first"
        finding={finding}
        repairsAvailable={false}
        stale
        onClose={() => undefined}
        onChanged={() => undefined}
        onOpenLibrary={() => undefined}
      />,
    ),
  );
  const request = requests.at(-1);
  await act(async () => vi.advanceTimersByTimeAsync(31_000));
  expect(request?.signal?.aborted).toBe(false);
  await act(async () => request?.resolve(healthResponse('first')));
  expect(document.body.textContent).toContain('This check is no longer present in current evidence.');
  expect(document.body.textContent).not.toContain('timed out');
});

it('aborts pending pagination when a fresh report supersedes it', async () => {
  await render('first');
  await act(async () =>
    requests[0]?.resolve(
      new Response(
        JSON.stringify({
          version: 1,
          project: 'first',
          status: 'findings',
          findings: [],
          recordPreviews: [],
          recordsScanned: 0,
          limit: 100,
          omittedFindings: 1,
          remainingFindings: 1,
          nextCursor: 'next',
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
        }),
      ),
    ),
  );
  const more = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll('button')],
      __effectArrayValue =>
        !!(button =>
          Effect.pipe(button.textContent, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect.pipe(effectOptionalString, EffectString.includes('Load 1 findings')),
          ))(__effectArrayValue),
    ),
  );
  expect(more).toBeDefined();
  await act(async () => more?.click());
  expect(requests).toHaveLength(2);
  await act(async () => vi.advanceTimersByTimeAsync(9_000));
  expect(requests[1]?.signal?.aborted).toBe(false);
  await render('first', 1);
  expect(requests[1]?.signal?.aborted).toBe(true);
  expect(requests[2]?.signal?.aborted).toBe(false);
  await act(async () => root?.unmount());
  root = undefined;
  expect(requests[2]?.signal?.aborted).toBe(true);
});

it('keeps one active report across bounded project and refresh schedules', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.integer({min: 0, max: 5}), {minLength: 1, maxLength: 8}), async changes => {
      for (const [generation, project] of changes.entries()) {
        await render(`synthetic-${project}`, generation);
        expect(EffectArray.filter(requests, request => !request.signal?.aborted)).toHaveLength(1);
      }
    }),
    {numRuns: 12},
  );
});

async function render(project: string, refreshGeneration = 0) {
  await act(async () =>
    root?.render(
      React.createElement(ContextHealthPanel, {
        project,
        projects: [project],
        refreshGeneration,
        onOpenLibrary: () => undefined,
        onProjectChange: () => undefined,
      }),
    ),
  );
}

function healthResponse(project: string): Response {
  return new Response(
    JSON.stringify({
      version: 1,
      project,
      status: 'findings',
      findings: [],
      recordPreviews: [],
      recordsScanned: 0,
      limit: 100,
      omittedFindings: 0,
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
    }),
  );
}
