import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {ContextHealthPanel, ReviewsPanel} from '@threadnote/manager/attention-view';
import {reviewPreviewFixture} from '../helpers/review_preview_fixture.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

let reactRoot: Root | undefined;
let contextHealthRequests: string[];
let bulkRequests: string[];
let bulkPreviewCategories: string[];
let bulkPreviewGate: Promise<void> | undefined;
let bulkApplyGate: Promise<void> | undefined;
let backgroundRepairStarted: boolean;
let backgroundRepairPollFailures: number;
let backgroundRepairScenario:
  'count-drift' | 'delayed-start' | 'failed' | 'immediate-completion' | 'poll-retry' | 'running';
let backgroundRepairStartGate: Promise<void> | undefined;

beforeEach(() => {
  contextHealthRequests = [];
  bulkRequests = [];
  bulkPreviewCategories = [];
  bulkPreviewGate = undefined;
  bulkApplyGate = undefined;
  backgroundRepairStarted = false;
  backgroundRepairPollFailures = 0;
  backgroundRepairScenario = 'running';
  backgroundRepairStartGate = undefined;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://manager.test');
      if (url.pathname === '/api/attention/context-maintenance') return response({paused: true});
      if (url.pathname === '/api/reviews') {
        return response({
          items: [
            {
              candidates: [
                {
                  candidateId: 'candidate-1',
                  categories: ['decision'],
                  comparison: 'new',
                  confidence: 0.9,
                  proposedText: 'Preserve the reviewed contract.',
                  reason: 'The decision is reusable.',
                  recommendation: 'create',
                  state: 'pending',
                },
              ],
              createdAt: '2026-09-28T10:00:00.000Z',
              project: 'threadnote',
              reviewId: 'review-1',
              revision: 1,
              task: 'Ship the reviewed workflow',
              topic: 'workflow',
            },
          ],
          pendingCount: 1,
          project: 'threadnote',
          version: 1,
        });
      }
      if (url.pathname === '/api/context-health/citations/preview') {
        bulkRequests.push(url.pathname);
        const body = Schema.decodeUnknownSync(
          Schema.StructWithRest(Schema.Struct({findingCategory: Schema.optional(Schema.String)}), [
            Schema.Record(Schema.String, Schema.Unknown),
          ]),
        )(JSON.parse(String(init?.body)));
        bulkPreviewCategories.push(body.findingCategory ?? 'all');
        await bulkPreviewGate;
        return response({
          items: [
            {
              category: 'citation-changed',
              citationId: `tncc_${Effect.pipe('1', EffectString.repeat(40))}`,
              findingId: 'finding-1',
              path: 'src/example.ts',
              proposalId: `health-repair-${Effect.pipe('4', EffectString.repeat(40))}`,
              replacementId: `tncc_${Effect.pipe('2', EffectString.repeat(40))}`,
              revision: Effect.pipe('5', EffectString.repeat(64)),
              sourceCommit: Effect.pipe('3', EffectString.repeat(40)),
              subjectUri: 'threadnote://user/tester/memories/example.md',
              targetKind: 'file',
            },
          ],
          project: 'threadnote',
          repairableCount: 1,
          requiresGraphCount: 2,
          truncated: false,
          version: 1,
        });
      }
      if (url.pathname === '/api/context-health/citations/jobs') {
        if (init?.method === 'POST') {
          await backgroundRepairStartGate;
          backgroundRepairStarted = true;
          if (backgroundRepairScenario === 'immediate-completion') {
            return response({job: backgroundRepairJob('completed')});
          }
        } else if (backgroundRepairScenario === 'delayed-start') {
          return response({job: null});
        } else if (
          backgroundRepairStarted &&
          backgroundRepairScenario === 'poll-retry' &&
          backgroundRepairPollFailures === 0
        ) {
          backgroundRepairPollFailures += 1;
          throw new Error('Temporary repair status failure.');
        }
        return response({
          job: backgroundRepairStarted
            ? backgroundRepairJob(
                backgroundRepairScenario === 'running' || backgroundRepairScenario === 'delayed-start'
                  ? 'running'
                  : backgroundRepairScenario === 'failed'
                    ? 'failed'
                    : 'completed',
                backgroundRepairScenario === 'count-drift' ? 150 : undefined,
              )
            : null,
        });
      }
      if (url.pathname === '/api/context-health/citations/rebuild') {
        bulkRequests.push(url.pathname);
        return response({output: 'Ready'});
      }
      if (url.pathname === '/api/context-health/citations/apply') {
        bulkRequests.push(url.pathname);
        await bulkApplyGate;
        return response({appliedCount: 1, failedCount: 0, results: [], version: 1});
      }
      contextHealthRequests.push(url.search);
      const after = url.searchParams.get('after');
      if (url.searchParams.get('project') === 'memory-only') {
        return response({
          findings: [],
          limit: 100,
          omittedFindings: 0,
          project: 'memory-only',
          recordPreviews: [],
          recordsScanned: 3,
          repositoryEvidence: {reason: 'project-not-configured', state: 'unavailable'},
          semanticCompleteness: semanticCompleteness('unavailable'),
          status: 'unknown',
          version: 1,
        });
      }
      if (url.searchParams.get('project') === 'grouped') {
        const findings = EffectArray.map(healthFindings(1, 2), finding => ({
          ...finding,
          repair: {...finding.repair, subjectUri: 'threadnote://memory/grouped'},
          uris: ['threadnote://memory/grouped'],
        }));
        return response({
          findings,
          limit: 100,
          omittedFindings: 0,
          project: 'grouped',
          recordPreviews: [
            {
              code: [
                {
                  citationId: `tncc_${Effect.pipe('0', EffectString.repeat(39))}1`,
                  excerpt: 'export const grouped = true;',
                  findingIds: ['finding-1'],
                  line: 1,
                  path: 'src/grouped.ts',
                },
              ],
              excerpt: 'Both issues belong to this readable memory.',
              kind: 'durable',
              title: 'Grouped memory',
              uri: 'threadnote://memory/grouped',
            },
          ],
          recordsScanned: 1,
          repositoryEvidence: {state: 'available'},
          semanticCompleteness: semanticCompleteness('complete'),
          status: 'findings',
          version: 1,
        });
      }
      const start = after ? 101 : 1;
      const count = after ? 1 : 100;
      return response({
        findings: healthFindings(start, count),
        limit: 100,
        ...(after
          ? {remainingFindings: 0}
          : {nextCursor: `hcx1_2s_${Effect.pipe('a', EffectString.repeat(40))}`, remainingFindings: 1}),
        omittedFindings: after ? 100 : 1,
        project: 'threadnote',
        recordPreviews: healthPreviews(start, count),
        recordsScanned: 12,
        repositoryEvidence: {state: 'available'},
        semanticCompleteness: semanticCompleteness('complete'),
        status: 'findings',
        version: 1,
      });
    }),
  );
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
});

afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot?.unmount());
  reactRoot = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Manager attention views', () => {
  it('keeps loaded health cards, focus and scroll through a pending refresh and transient failure', async () => {
    const pending = Promise.withResolvers<Response>();
    const retry = Promise.withResolvers<Response>();
    const originalFetch = fetch;
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://manager.test');
        if (url.pathname !== '/api/context-health') return originalFetch(input, init);
        reads++;
        return reads === 1
          ? Promise.resolve(response(refreshReport('Retained memory')))
          : reads === 2
            ? pending.promise
            : retry.promise;
      }),
    );
    const panel = (refreshGeneration: number) => (
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={refreshGeneration}
      />
    );
    await render(panel(0));
    const card = document.querySelector<HTMLElement>('.health-record')!;
    const list = document.querySelector<HTMLElement>('.health-record-list')!;
    const openMemory = card.querySelector<HTMLButtonElement>('button')!;
    const status = document.querySelector<HTMLElement>('.attention-refresh-status')!;
    list.scrollTop = 240;
    openMemory.focus();
    await rerender(panel(1));
    expect(document.querySelector('.health-record')).toBe(card);
    expect(document.activeElement).toBe(openMemory);
    expect(list.scrollTop).toBe(240);
    expect(status.textContent).toContain('Checking for context updates');
    expect(document.body.textContent).not.toContain('Checking project context');
    await act(async () => pending.reject(new Error('Temporary health read failure')));
    expect(document.querySelector('.health-record')).toBe(card);
    const alert = status.querySelector('[role=alert]');
    expect(alert?.textContent).toContain('Temporary health read failure');
    await rerender(panel(2));
    expect(status.querySelector('[role=alert]')).toBe(alert);
    expect(document.querySelector('.health-record')).toBe(card);
    await act(async () => retry.resolve(response(refreshReport('Retained memory'))));
    expect(status.querySelector('[role=alert]')).toBeNull();
    expect(document.querySelector('.health-record')).toBe(card);
    expect(document.activeElement).toBe(openMemory);
    expect(list.scrollTop).toBe(240);
    expect(document.querySelector('.attention-refresh-status')).toBe(status);
  });

  it.each([401, 403, 404, 409, 410])('redacts previous health evidence when refresh returns HTTP %s', async code => {
    const originalFetch = fetch;
    let denied = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input), 'http://manager.test').pathname !== '/api/context-health')
          return originalFetch(input, init);
        return Promise.resolve(
          denied
            ? new Response(JSON.stringify({error: 'Evidence access ended'}), {status: code})
            : response(refreshReport('Private old evidence')),
        );
      }),
    );
    const panel = (refreshGeneration: number) => (
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={refreshGeneration}
      />
    );
    await render(panel(0));
    expect(document.body.textContent).toContain('Private old evidence');
    denied = true;
    await rerender(panel(1));
    expect(document.body.textContent).not.toContain('Private old evidence');
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Evidence access ended');
  });

  it('keeps only the latest health refresh authoritative for bounded out-of-order completion schedules', async () => {
    const originalFetch = fetch;
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray([0, 1, 2, 3], {minLength: 4, maxLength: 4}), async order => {
        const pending = Array.from({length: 4}, () => Promise.withResolvers<Response>());
        let reads = -1;
        vi.stubGlobal(
          'fetch',
          vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            if (new URL(String(input), 'http://manager.test').pathname !== '/api/context-health')
              return originalFetch(input, init);
            reads++;
            return reads === 0
              ? Promise.resolve(response(refreshReport('Original evidence')))
              : pending[reads - 1].promise;
          }),
        );
        const panel = (refreshGeneration: number) => (
          <ContextHealthPanel
            onOpenLibrary={() => undefined}
            onProjectChange={() => undefined}
            project="threadnote"
            projects={['threadnote']}
            refreshGeneration={refreshGeneration}
          />
        );
        await render(panel(0));
        const card = document.querySelector('.health-record');
        for (let generation = 1; generation <= 4; generation++) {
          await rerender(panel(generation));
          expect(document.querySelector('.health-record')).toBe(card);
        }
        let latestCompleted = false;
        for (const index of order) {
          await act(async () => pending[index].resolve(response(refreshReport(`Revision ${index}`))));
          if (index === 3) latestCompleted = true;
          expect(document.querySelector('.health-record')).toBe(card);
          expect(card?.textContent).toContain(latestCompleted ? 'Revision 3' : 'Original evidence');
        }
        await act(async () => reactRoot?.unmount());
        reactRoot = undefined;
        document.body.replaceChildren();
      }),
      {numRuns: 12},
    );
  });

  it('redacts old-project health immediately and ignores its delayed response in the new project', async () => {
    const originalFetch = fetch;
    const old = Promise.withResolvers<Response>();
    let hold = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://manager.test');
        if (hold && url.pathname === '/api/context-health' && url.searchParams.get('project') === 'threadnote')
          return old.promise;
        return originalFetch(input, init);
      }),
    );
    const panel = (project: string, refreshGeneration: number) => (
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project={project}
        projects={['threadnote', 'grouped']}
        refreshGeneration={refreshGeneration}
      />
    );
    await render(panel('threadnote', 0));
    expect(document.body.textContent).toContain('Memory 100');
    hold = true;
    await rerender(panel('threadnote', 1));
    await rerender(panel('grouped', 1));
    expect(document.body.textContent).not.toContain('Memory 100');
    expect(document.body.textContent).toContain('Grouped memory');
    await act(async () =>
      old.resolve(new Response(JSON.stringify({error: 'Old project access ended'}), {status: 403})),
    );
    expect(document.body.textContent).toContain('Grouped memory');
    expect(document.body.textContent).not.toContain('Old project access ended');
  });

  it.each([null, {...refreshReport('Wrong project evidence'), project: 'other-project'}])(
    'redacts retained health when a successful read has an invalid project contract (%j)',
    async invalid => {
      const originalFetch = fetch;
      let next: unknown = refreshReport('Original private evidence');
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
          new URL(String(input), 'http://manager.test').pathname === '/api/context-health'
            ? Promise.resolve(response(next))
            : originalFetch(input, init),
        ),
      );
      const panel = (refreshGeneration: number) => (
        <ContextHealthPanel
          onOpenLibrary={() => undefined}
          onProjectChange={() => undefined}
          project="threadnote"
          projects={['threadnote']}
          refreshGeneration={refreshGeneration}
        />
      );
      await render(panel(0));
      expect(document.body.textContent).toContain('Original private evidence');
      next = invalid;
      await rerender(panel(1));
      expect(document.querySelector('.health-record')).toBeNull();
      expect(document.body.textContent).not.toContain('Original private evidence');
      expect(document.body.textContent).not.toContain('Wrong project evidence');
      expect(document.querySelector('[role=alert]')?.textContent).toContain('does not match this project');
    },
  );

  it('retains review cards during same-scope refresh and redacts them when changing review scope', async () => {
    const originalFetch = fetch;
    const pending = Promise.withResolvers<Response>();
    let hold = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        hold && new URL(String(input), 'http://manager.test').pathname === '/api/reviews'
          ? pending.promise
          : originalFetch(input, init),
      ),
    );
    const panel = (refreshGeneration: number) => (
      <ReviewsPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={refreshGeneration}
      />
    );
    await render(panel(0));
    const card = document.querySelector('.attention-card');
    hold = true;
    await rerender(panel(1));
    expect(document.querySelector('.attention-card')).toBe(card);
    expect(document.body.textContent).not.toContain('Loading the review inbox');
    await act(async () =>
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')],
          button => button.textContent === 'Deferred',
        ),
      )!.click(),
    );
    expect(document.querySelector('.attention-card')).toBeNull();
    expect(document.body.textContent).toContain('Loading the review inbox');
  });

  it('keeps an open authorized review and its operation choice when readiness moves its card to grouped waiting', async () => {
    const originalFetch = fetch;
    let waiting = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://manager.test');
        if (url.pathname === '/api/reviews' && waiting)
          return response({
            version: 1,
            project: 'threadnote',
            items: [],
            pendingCount: 0,
            background: {assessments: 0, awaitingSources: 1, obsolete: 0, reasons: {checking: 1}},
          });
        if (url.pathname === '/api/reviews/preview')
          return response(
            reviewPreviewFixture({
              mutationPreview: {operation: 'requires_explicit_operation'},
              candidate: {
                candidateId: 'candidate-1',
                proposedText: 'Retained authorized proposal.',
                reason: 'Choose its exact operation.',
              },
              review: {
                project: 'threadnote',
                reviewId: 'review-1',
                revision: 1,
                task: 'Authorized fixture proposal.',
                topic: 'fixture',
              },
            }),
          );
        return originalFetch(input, init);
      }),
    );
    const panel = (refreshGeneration: number) => (
      <ReviewsPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={refreshGeneration}
      />
    );
    await render(panel(0));
    await clickButton('Review and decide →');
    await waitFor('Authorized fixture proposal.');
    const dialog = document.querySelector('dialog');
    const choice = dialog!.querySelector('select')!;
    await act(async () => {
      choice.value = 'create';
      choice.dispatchEvent(new Event('change', {bubbles: true}));
    });
    choice.focus();
    waiting = true;
    await rerender(panel(1));
    await waitFor('1 updates waiting for source verification');
    expect(document.querySelector('dialog')).toBe(dialog);
    expect(dialog!.textContent).toContain('Retained authorized proposal.');
    expect(choice.value).toBe('create');
    expect(document.activeElement).toBe(choice);
  });

  it('uses only the finite response retry boundary when live updates are unsupported', async () => {
    vi.useFakeTimers();
    const intervals = vi.spyOn(window, 'setInterval');
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        reads++;
        return response({
          version: 1,
          project: 'threadnote',
          pendingCount: 0,
          items: [],
          background: {
            assessments: 100,
            awaitingSources: 5,
            obsolete: 0,
            reasons: {checking: 5},
            ...(reads === 1 ? {nextRetryAt: Date.now() + 100} : {}),
          },
        });
      }),
    );
    await render(
      <ReviewsPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    expect(reads).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(reads).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(reads).toBe(2);
    expect(intervals).not.toHaveBeenCalled();
  });

  it('shows the exact pending review instead of routing the user to the Library', async () => {
    await render(
      <ReviewsPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Preserve the reviewed contract.');
    expect(document.body.textContent).toContain('Ship the reviewed workflow');
    expect(document.body.textContent).toContain('pending');
  });

  it('shows project context findings and repair guidance in their own view', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    expect(document.body.textContent).toContain('A readable memory preview 1.');
    expect(document.body.textContent).toContain('src/example-1.ts');
    expect(document.body.textContent).toContain('Compare the memory with the current source excerpt');
    expect(document.body.textContent).not.toContain('Review the changed citation.');
    expect(document.body.textContent).toContain('12');
    expect(document.body.textContent).toContain('The source code cited by this memory has changed');
  });

  it('loads every context-health page and reruns when Manager refreshes', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 100');
    await clickButton('Load 1 findings');
    await waitFor('Memory 101');
    expect(contextHealthRequests).toContain(
      `?project=threadnote&after=hcx1_2s_${Effect.pipe('a', EffectString.repeat(40))}`,
    );
    expect(metricValue('Issues')).toBe('101');
    expect(buttonWithText('Load')).toBeUndefined();

    await rerender(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={1}
      />,
    );
    await waitForRequestCount(3);
  });

  it('explains when repository evidence and repairs are unavailable', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="memory-only"
        projects={['memory-only']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Repository evidence is unavailable');
    expect(document.body.textContent).toContain('configured local checkout');
    expect(document.body.textContent).not.toContain('No actionable context findings');
  });

  it('groups several issues under a readable memory and code preview', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="grouped"
        projects={['grouped']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Grouped memory');
    expect(document.body.textContent).toContain('2 issues');
    expect(document.body.textContent).toContain('Both issues belong to this readable memory.');
    expect(document.body.textContent).toContain('src/grouped.ts');
    expect(document.body.textContent).toContain('export const grouped = true;');
    expect(document.querySelectorAll('.health-record')).toHaveLength(1);
    expect(document.body.textContent).not.toContain(`tncc_${Effect.pipe('0', EffectString.repeat(39))}1`);
  });

  it('previews current-graph citation repairs, rebuilds evidence, and applies the reviewed batch', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    const previewGate = Promise.withResolvers<void>();
    bulkPreviewGate = previewGate.promise;
    await clickButton('Review citation repairs');
    await waitFor('Matching stored citations against the current project graph');
    expect(document.body.textContent).toContain('one update per affected memory');
    previewGate.resolve();
    await waitFor('src/example.ts');
    expect(document.body.textContent).toContain('Need graph evidence');
    await clickButton('Rebuild project graph and retry');
    await waitForRequest('/api/context-health/citations/rebuild');
    const applyGate = Promise.withResolvers<void>();
    bulkApplyGate = applyGate.promise;
    await clickButton('Apply 1 citation repair');
    await waitFor('Applying citation repairs · 0 of 1');
    applyGate.resolve();
    await waitFor('Repaired 1 citation.');
    expect(bulkRequests).toEqual([
      '/api/context-health/citations/preview',
      '/api/context-health/citations/rebuild',
      '/api/context-health/citations/preview',
      '/api/context-health/citations/apply',
    ]);
    expect(bulkPreviewCategories).toEqual(['all', 'all']);
  });

  it('starts a full background repair and explains that the browser can close', async () => {
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitFor('Repairing citations in background');
    expect(document.body.textContent).toContain('Scanning every citation issue for threadnote.');
    expect(document.body.textContent).toContain('2 pages scanned');
    expect(document.body.textContent).toContain('You can close this browser window');
    expect(buttonWithText('Repair running')?.disabled).toBe(true);
  });

  it('refreshes context health when the start response is already complete', async () => {
    backgroundRepairScenario = 'immediate-completion';
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitForRequestCount(2);
    await waitFor('Automatic citation repair finished');
    expect(document.body.textContent).toContain('41 citation issues at start');
    expect(document.body.textContent).toContain('37 citation updates applied');
    expect(document.body.textContent).toContain('0 citation issues remain');
    expect(document.body.textContent).toContain('Current health total:');
    expect(document.body.textContent).toContain('41 citation issues cleared');
    expect(document.body.textContent).toContain('one write is not necessarily one cleared issue');
  });

  it('retries a transient status failure and refreshes after completion', async () => {
    vi.useFakeTimers();
    backgroundRepairScenario = 'poll-retry';
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitFor('Temporary repair status failure.');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await waitFor('Automatic citation repair finished');
    await waitForRequestCount(2);
    expect(backgroundRepairPollFailures).toBe(1);
    vi.useRealTimers();
  });

  it('labels a failed partial scan without presenting exact issue arithmetic', async () => {
    backgroundRepairScenario = 'failed';
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitFor('Automatic citation repair stopped');
    expect(document.body.textContent).toContain('4 citation issues observed before stop');
    expect(document.body.textContent).toContain('The stopped scan is partial');
    expect(document.body.textContent).not.toContain('citation issues +');
  });

  it('does not force an exact breakdown when completed counts drift beyond current health', async () => {
    backgroundRepairScenario = 'count-drift';
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await waitFor('Automatic citation repair finished');
    expect(document.body.textContent).toContain('150 citation issues remain');
    expect(document.body.textContent).toContain('citation breakdown is no longer exact');
    expect(document.body.textContent).not.toContain('citation issues +');
  });

  it('discards a delayed start response after switching projects', async () => {
    backgroundRepairScenario = 'delayed-start';
    const startGate = Promise.withResolvers<void>();
    backgroundRepairStartGate = startGate.promise;
    await render(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="threadnote"
        projects={['threadnote', 'grouped']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Memory 1');
    await clickButton('Repair all in background');
    await rerender(
      <ContextHealthPanel
        onOpenLibrary={() => undefined}
        onProjectChange={() => undefined}
        project="grouped"
        projects={['threadnote', 'grouped']}
        refreshGeneration={0}
      />,
    );
    await waitFor('Grouped memory');
    startGate.resolve();
    await act(async () => Promise.resolve());
    expect(document.body.textContent).not.toContain('Repairing citations in background');
    expect(buttonWithText('Repair all in background')?.disabled).toBe(false);
  });
});

it('keeps 100 background assessments and five unavailable proposals grouped without individual review chores', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        version: 1,
        project: 'threadnote',
        pendingCount: 0,
        items: [],
        background: {assessments: 100, awaitingSources: 5, obsolete: 0, reasons: {'source-unavailable': 5}},
      }),
    ),
  );
  await render(
    <ReviewsPanel
      onOpenLibrary={() => undefined}
      onProjectChange={() => undefined}
      project="threadnote"
      projects={['threadnote']}
      refreshGeneration={0}
    />,
  );
  expect(document.body.textContent).toContain('100 background assessments');
  expect(document.body.textContent).toContain('5 updates waiting for source verification');
  expect(document.body.textContent).toContain('No review or discard is required');
  expect(document.querySelectorAll('button[data-review-id]')).toHaveLength(0);
  expect(document.body.textContent).not.toContain('Reject obsolete');
});

async function render(element: React.ReactElement): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(element));
}

async function rerender(element: React.ReactElement): Promise<void> {
  await act(async () => reactRoot?.render(element));
}

async function waitFor(text: string): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (
      Effect.pipe(document.body.textContent, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.includes(text)),
      )
    )
      return;
    await act(async () => Promise.resolve());
  }
  throw new Error(`Text did not render: ${text}`);
}

async function clickButton(label: string): Promise<void> {
  const button = EffectOption.getOrUndefined(
    EffectArray.findFirst([...document.querySelectorAll('button')], item => item.textContent === label),
  );
  if (!button) throw new Error(`Button did not render: ${label}`);
  await act(async () => button.click());
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll('button')],
      __effectArrayValue =>
        !!(item =>
          Effect.pipe(item.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.includes(text)),
          ))(__effectArrayValue),
    ),
  );
}

function metricValue(label: string): string | undefined {
  return EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll('.attention-metrics > div')],
      item => item.querySelector('span')?.textContent === label,
    ),
  )?.querySelector('strong')?.textContent;
}

async function waitForRequestCount(count: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (contextHealthRequests.length >= count) return;
    await act(async () => Promise.resolve());
  }
  throw new Error(`Context health request count did not reach ${count}.`);
}

async function waitForRequest(path: string): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (bulkRequests.includes(path)) return;
    await act(async () => Promise.resolve());
  }
  throw new Error(`Bulk request did not run: ${path}`);
}

function healthFindings(start: number, count: number) {
  return Array.from({length: count}, (_, index) => ({
    category: 'citation-changed' as const,
    confidence: 'high' as const,
    id: `finding-${start + index}`,
    repair: {
      kind: 'repair-citation' as const,
      subjectUri: `threadnote://memory/example-${start + index}`,
      summary: `Review and recapture citation tncc_${Effect.pipe(String(start + index), EffectString.padStart(40, '0'))}.`,
      targetUri: `threadnote://memory/example-${start + index}#tncc_${Effect.pipe(String(start + index), EffectString.padStart(40, '0'))}`,
    },
    repairability: 'reviewable' as const,
    severity: 'high' as const,
    summary: `Finding ${start + index}`,
    uris: [`threadnote://memory/example-${start + index}`],
  }));
}

function healthPreviews(start: number, count: number) {
  return Array.from({length: count}, (_, index) => ({
    code: [
      {
        citationId: `tncc_${Effect.pipe(String(start + index), EffectString.padStart(40, '0'))}`,
        excerpt: `export const example${start + index} = true;`,
        findingIds: [`finding-${start + index}`],
        line: 1,
        path: `src/example-${start + index}.ts`,
      },
    ],
    excerpt: `A readable memory preview ${start + index}.`,
    kind: 'durable',
    title: `Memory ${start + index}`,
    topic: 'workflow',
    uri: `threadnote://memory/example-${start + index}`,
  }));
}

function semanticCompleteness(state: 'complete' | 'partial' | 'unavailable') {
  return {
    analyzedRecords: state === 'complete' ? 1 : 0,
    claimsAnalyzed: 0,
    supportedClaims: 0,
    unsupportedClaims: 0,
    coverage: 'bounded-English-extraction' as const,
    contradictionCount: 0,
    eligibleRecords: 1,
    omittedContradictions: 0,
    pairsCompared: 0,
    state,
    unknownReasons: state === 'complete' ? [] : [{reason: 'record-limit' as const, count: 1}],
    unknownRecords: state === 'complete' ? 0 : 1,
    version: 2 as const,
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}, status: 200});
}

function refreshReport(title: string) {
  return {
    findings: healthFindings(1, 1),
    limit: 100,
    omittedFindings: 0,
    project: 'threadnote',
    recordPreviews: EffectArray.map(healthPreviews(1, 1), preview => ({...preview, title})),
    recordsScanned: 1,
    repositoryEvidence: {state: 'available'},
    semanticCompleteness: semanticCompleteness('complete'),
    status: 'findings',
    version: 1,
  };
}

function backgroundRepairJob(status: 'completed' | 'failed' | 'running', unresolvedCount?: number) {
  return {
    createdAt: '2026-09-29T10:00:00.000Z',
    ...(status === 'completed' ? {finishedAt: '2026-09-29T10:00:01.000Z'} : {}),
    id: 'mcrj_example',
    progress: {
      batch: 1,
      failedCount: 0,
      initialCitationCount: 41,
      message:
        status === 'completed'
          ? 'Citation repair finished for threadnote.'
          : status === 'failed'
            ? 'Background citation repair stopped before the backlog was complete.'
            : 'Scanning every citation issue for threadnote.',
      pagesScanned: 2,
      phase:
        status === 'completed'
          ? ('completed' as const)
          : status === 'failed'
            ? ('failed' as const)
            : ('scanning' as const),
      repairableCount: 37,
      repairedCount: status === 'completed' ? 37 : 0,
      unresolvedCount: unresolvedCount ?? (status === 'completed' ? 0 : 4),
    },
    project: 'threadnote',
    status,
    ...(status === 'failed' ? {error: 'Unexpected citation scanner defect.'} : {}),
  };
}
