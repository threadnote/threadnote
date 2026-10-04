// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ContextHealthPanel} from '@threadnote/manager/attention-view';
import {ContextMaintenanceView} from '@threadnote/manager/attention/maintenance-view';
import type {
  ManagerContextHealthResponseV1,
  ManagerContextMaintenanceStatusV2,
} from '@threadnote/manager/attention/contracts';

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const report = (project = 'threadnote'): ManagerContextHealthResponseV1 => ({
  project,
  version: 1,
  findings: [],
  recordPreviews: [],
  limit: 100,
  omittedFindings: 0,
  recordsScanned: 1_712,
  repositoryEvidence: {state: 'unavailable', reason: 'repository-unavailable'},
  status: 'unknown',
  semanticCompleteness: {
    version: 1,
    state: 'partial',
    eligibleRecords: 384,
    analyzedRecords: 11,
    unknownRecords: 373,
    claimsAnalyzed: 11,
    contradictionCount: 0,
    pairsCompared: 0,
    omittedContradictions: 0,
    unknownReasons: [{reason: 'record-limit', count: 373}],
  },
  maintenance: {
    version: 2,
    actionableFindings: 0,
    affectedMemories: 0,
    automaticallyManagedFindings: 4,
    historicalFindings: 2,
    citationCoverage: {
      eligible: 2_013,
      checked: 96,
      deferred: 1_917,
      currentVerified: 94,
      historicalVerified: 2,
      unverified: 1_917,
      state: 'partial',
      reasons: [{reason: 'citation-limit', count: 1_917}],
    },
    semanticCoverage: {
      version: 1,
      state: 'partial',
      eligibleRecords: 384,
      analyzedRecords: 11,
      unknownRecords: 373,
      claimsAnalyzed: 11,
      contradictionCount: 0,
      pairsCompared: 0,
      omittedContradictions: 0,
      unknownReasons: [{reason: 'record-limit', count: 373}],
    },
  },
});
const status = (): ManagerContextMaintenanceStatusV2 => ({
  version: 2,
  state: 'waiting-evidence',
  generation: 'generation-one',
  paused: false,
  projects: [
    {
      project: 'threadnote',
      generation: 'corpus-one',
      cursor: 96,
      checked: 96,
      eligible: 1_712,
      eligibleCitations: 2_013,
      checkedCitations: 96,
    },
  ],
  cases: [],
  receipts: [],
  lastProgressAt: '2026-10-03T10:00:00Z',
});
async function render(element: React.ReactElement) {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
}
const props = {
  onProjectChange: () => undefined,
  onOpenLibrary: () => undefined,
  onChanged: () => undefined,
  projects: ['threadnote'],
  loadingMore: false,
  onLoadMore: () => undefined,
};

describe('context maintenance view', () => {
  it('loads retained case and receipt pages and opens exact evidence and old undo', async () => {
    const item = {
      caseId: 'old-case',
      project: 'threadnote',
      memoryId: 'old-memory',
      family: 'citation',
      slot: 'anchor:old',
      disposition: 'historical' as const,
      evidenceRevision: 'revision',
      reason: 'historical-verified',
      firstSeen: '2026-10-03',
      lastSeen: '2026-10-03',
      lastChecked: '2026-10-03',
      attemptCount: 2,
      events: [],
    };
    const receipt = {
      receiptId: 'old-receipt',
      project: 'threadnote',
      subjectUri: 'threadnote://memory/old',
      postHash: 'hash',
      timestamp: '2026-10-03',
      state: 'applied' as const,
    };
    const calls: URL[] = [];
    let undone = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://manager.test');
        calls.push(url);
        if (init?.method === 'POST') {
          undone = JSON.parse(String(init.body)).receiptId === 'old-receipt';
          return new Response(JSON.stringify({status: 'undone'}));
        }
        if (url.searchParams.has('caseId'))
          return new Response(
            JSON.stringify({
              version: 2,
              project: 'threadnote',
              caseId: 'old-case',
              evidenceRevision: 'revision',
              expectedContentHash: 'hash',
              reason: 'historical-verified',
              choices: ['Review original claim'],
              allowedOperations: ['read_context'],
              instructions: 'Historical evidence does not verify current source.',
              evidence: {
                coverage: 'available',
                generation: 'source',
                attemptedSteps: [],
                excerpts: [
                  {
                    content: 'retained historical declaration',
                    provenance: 'historical-verified',
                    excerptHash: 'hash',
                    supportsCitation: true,
                    startLine: 1,
                    source: {path: 'old.ts'},
                  },
                ],
              },
            }),
          );
        return new Response(
          JSON.stringify({
            ...status(),
            cases: url.searchParams.has('caseCursor') ? [item] : [],
            receipts: url.searchParams.has('receiptCursor') ? [receipt] : [],
            page: {
              generation: 'history',
              caseNextCursor: url.searchParams.has('caseCursor') ? undefined : 'cases-2',
              receiptNextCursor: url.searchParams.has('receiptCursor') ? undefined : 'receipts-2',
            },
          }),
        );
      }),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    const click = async (label: string) => {
      const button = [...document.querySelectorAll('button')].find(value => value.textContent === label);
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };
    await click('Load more retained cases');
    await click('Load more retained changes and undo');
    await click('Inspect exact case and evidence');
    expect(document.body.textContent).toContain('retained historical declaration');
    expect(calls.filter(url => url.searchParams.has('caseId'))[0].searchParams.get('project')).toBe('threadnote');
    await click('Undo this change');
    expect(undone).toBe(true);
  });

  it('continues polling after a hidden tab becomes visible', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const fetch = vi.fn(async () => new Response(JSON.stringify(status())));
    vi.stubGlobal('fetch', fetch);
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    hidden.mockReturnValue(false);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('refreshes evidence when background proof advances without a corpus change', async () => {
    vi.useFakeTimers();
    const onChanged = vi.fn();
    let advanced = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...status(),
              page: {generation: advanced ? 'evidence-two' : 'evidence-one'},
              projects: [{...status().projects[0], checked: advanced ? 104 : 96}],
            }),
          ),
      ),
    );
    await render(<ContextMaintenanceView {...props} onChanged={onChanged} project="threadnote" report={report()} />);
    expect(onChanged).not.toHaveBeenCalled();
    advanced = true;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(onChanged).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows full aggregate recovery and history when decision details are truncated', async () => {
    const snapshot: ManagerContextMaintenanceStatusV2 = {
      ...status(),
      cases: Array.from({length: 30}, (_, index) => ({
        caseId: `decision-${index}`,
        memoryId: `memory-${index}`,
        project: 'threadnote',
        family: 'citation',
        slot: 'anchor:0',
        evidenceRevision: 'revision',
        disposition: 'needs-decision' as const,
        reason: 'citation-changed',
        firstSeen: '2026-10-03T10:00:00Z',
        lastSeen: '2026-10-03T10:00:00Z',
        lastChecked: '2026-10-03T10:00:00Z',
        attemptCount: 1,
        events: [],
      })),
      counts: {decisionMemories: 55, 'needs-decision': 55, 'waiting-evidence': 18, retired: 7},
      groups: [
        {
          causeKey: 'repository:unavailable',
          project: 'threadnote',
          disposition: 'waiting-evidence',
          reason: 'repository-unavailable',
          repositoryId: 'repository',
          affectedMemories: 18,
        },
      ],
      omittedCases: 50,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(snapshot))),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    expect(document.body.textContent).toContain('55 memories need your decision');
    expect(document.body.textContent).toContain('18 affected memories');
    expect(document.body.textContent).toContain('7 retired');
    expect(document.body.textContent).toContain('18 waiting for evidence');
    expect(document.body.textContent).toContain('50 additional case details');
    expect(document.body.textContent).not.toContain('No blocked recovery groups');
  });

  it('routes V2 health reports through the canonical service without starting the legacy citation worker', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requests.push(url);
        return new Response(JSON.stringify(url.startsWith('/api/context-health?') ? report() : status()), {
          headers: {'content-type': 'application/json'},
        });
      }),
    );
    await render(
      <ContextHealthPanel
        onProjectChange={() => undefined}
        onOpenLibrary={() => undefined}
        project="threadnote"
        projects={['threadnote']}
        refreshGeneration={0}
      />,
    );
    expect(document.body.textContent).toContain('Needs your decision');
    expect(requests.some(url => url.includes('/citations/jobs'))).toBe(false);
    expect(requests.some(url => url.includes('/attention/context-maintenance'))).toBe(true);
  });

  it('combines multiple supported checks into one memory decision with a scoped agent task', async () => {
    const source = report();
    const findings = ['citation-changed', 'semantic-contradiction'].map((category, index) => ({
      category,
      id: `finding-${index}`,
      caseId: `case-${index}`,
      classification: 'actionable',
      confidence: 'medium',
      severity: 'high',
      repairability: 'manual-review',
      summary: 'Current source contradicts the stored claim.',
      uris: ['threadnote://memory/example'],
      repair: {kind: 'review-memory', subjectUri: 'threadnote://memory/example', summary: 'Review claim'},
    })) as ManagerContextHealthResponseV1['findings'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(status()), {headers: {'content-type': 'application/json'}})),
    );
    await render(
      <ContextMaintenanceView
        {...props}
        project="threadnote"
        report={{
          ...source,
          findings,
          maintenance: {...source.maintenance!, affectedMemories: 1, actionableFindings: 2},
          recordPreviews: [
            {
              uri: 'threadnote://memory/example',
              title: 'Supported claim',
              excerpt: 'Stored advice refers to a removed function.',
              kind: 'durable',
              code: [],
            },
          ],
        }}
      />,
    );
    expect(document.querySelectorAll('.health-record')).toHaveLength(1);
    expect(document.body.textContent).toContain('1 memory needs your decision');
    const prepare = Array.from(document.querySelectorAll('button')).find(
      item => item.textContent === 'Prepare claim review task',
    );
    await act(async () => prepare?.click());
    const task = document.querySelector('textarea')?.value;
    expect(task).toContain('$threadnote-health');
    expect(task).toContain('case-0');
    expect(task).toContain('case-1');
  });

  it('shows partial coverage and automatic work without creating thousands of decisions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(status()), {headers: {'content-type': 'application/json'}})),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    expect(document.body.textContent).toContain('No decisions needed; evidence checks are incomplete');
    expect(document.body.textContent).toContain('96 of 1,712 background checks completed');
    expect(document.body.textContent).toContain('Current source checks96');
    expect(document.body.textContent).toContain('Heuristic coverage can remain partial after scanning finishes');
    expect(document.body.textContent).toContain('Run maintenance now');
    expect(document.body.textContent).not.toContain('Repair all');
    expect(document.body.textContent).not.toContain('2,013 issues');
  });
  it('keeps run and pause actions on the canonical maintenance endpoint', async () => {
    const actions: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body) actions.push(JSON.parse(String(init.body)).action);
        return new Response(JSON.stringify(status()), {headers: {'content-type': 'application/json'}});
      }),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    for (const label of ['Run maintenance now', 'Pause automatic maintenance']) {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent === label);
      await act(async () => button?.click());
    }
    expect(actions).toEqual(['run-now', 'pause']);
  });
  it('rejects a late status response after changing projects', async () => {
    const pending = Promise.withResolvers<Response>();
    const release = pending.resolve;
    const first = pending.promise;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('threadnote')
          ? first
          : new Response(JSON.stringify({...status(), paused: true, projects: [], cases: [], receipts: []}), {
              headers: {'content-type': 'application/json'},
            }),
      ),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    await act(async () => root?.render(<ContextMaintenanceView {...props} project="other" report={report('other')} />));
    await act(async () =>
      release?.(
        new Response(JSON.stringify({...status(), error: {reason: 'OLD PROJECT ERROR', at: 'now'}}), {
          headers: {'content-type': 'application/json'},
        }),
      ),
    );
    expect(document.body.textContent).toContain('Automatic maintenance is paused');
    expect(document.body.textContent).not.toContain('OLD PROJECT ERROR');
  });
  it('reports undo conflicts without claiming a reverted mutation', async () => {
    const receipt = {
      receiptId: 'receipt-one',
      project: 'threadnote',
      subjectUri: 'threadnote://memory/example',
      timestamp: '2026-10-03T10:00:00Z',
      postHash: 'a'.repeat(64),
      state: 'applied' as const,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(
            JSON.stringify(
              init?.body
                ? {status: 'conflict', receiptId: receipt.receiptId, reason: 'memory-changed'}
                : {...status(), receipts: [receipt]},
            ),
            {status: init?.body ? 409 : 200, headers: {'content-type': 'application/json'}},
          ),
      ),
    );
    const openMemory = vi.fn();
    await render(
      <ContextMaintenanceView {...props} onOpenLibrary={openMemory} project="threadnote" report={report()} />,
    );
    const undo = Array.from(document.querySelectorAll('button')).find(item => item.textContent === 'Undo this change');
    await act(async () => undo?.click());
    expect(document.body.textContent).toContain('The memory changed after maintenance');
    expect(document.body.textContent).toContain('Inspect its current contents');
    expect(document.body.textContent).not.toContain('HTTP 409');
    expect(
      Array.from(document.querySelectorAll('button')).some(item => item.textContent === 'Inspect current memory'),
    ).toBe(true);
    const inspect = Array.from(document.querySelectorAll('button')).find(
      item => item.textContent === 'Inspect current memory',
    );
    await act(async () => inspect?.click());
    expect(openMemory).toHaveBeenCalledWith(receipt.subjectUri);
    expect(document.body.textContent).not.toContain('Change undone');
  });
});
