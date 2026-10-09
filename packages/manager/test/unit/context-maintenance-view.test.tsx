// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {buildContextHealthReport} from '@threadnote/context/health';
import type {MemoryRecord} from '@threadnote/memory/document';
import {ContextHealthPanel} from '@threadnote/manager/attention-view';
import {ContextMaintenanceView} from '@threadnote/manager/attention/maintenance-view';
import type {
  ManagerContextHealthResponseV1,
  ManagerContextMaintenanceStatusV2,
} from '@threadnote/manager/attention/contracts';

let root: Root | undefined;
beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
});
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
    version: 2,
    state: 'partial',
    eligibleRecords: 384,
    analyzedRecords: 11,
    unknownRecords: 373,
    claimsAnalyzed: 11,
    supportedClaims: 11,
    unsupportedClaims: 0,
    coverage: 'bounded-English-extraction',
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
      version: 2,
      state: 'partial',
      eligibleRecords: 384,
      analyzedRecords: 11,
      unknownRecords: 373,
      claimsAnalyzed: 11,
      supportedClaims: 11,
      unsupportedClaims: 0,
      coverage: 'bounded-English-extraction',
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
  it('opens a persisted semantic case with both quotes, context, reason, and evidence revisions', async () => {
    const memory = (name: string, body: string): MemoryRecord => ({
      body,
      content: body,
      headerTitle: 'MEMORY',
      uri: `threadnote://memory/${name}`,
      metadata: {
        kind: 'durable',
        project: 'threadnote',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-01-01',
      },
    });
    const records = [
      memory('a', '# Production\nTimeout is 60 seconds.'),
      memory('b', '# Production\nTimeout must be 30 seconds.'),
    ];
    const health = buildContextHealthReport({project: 'threadnote', records, now: new Date('2026-06-01')});
    const finding = health.findings[0];
    const item = {
      ...finding.caseIdentity!,
      caseId: finding.caseId!,
      evidenceRevision: 'revision',
      disposition: 'needs-decision' as const,
      reason: finding.summary,
      firstSeen: '2026-06-01',
      lastSeen: '2026-06-01',
      lastChecked: '2026-06-01',
      attemptCount: 0,
      subjectUri: records[0].uri,
      events: [],
    };
    const retained = {...status(), state: 'needs-decision', cases: [item]};
    const packet = {
      version: 2,
      caseId: item.caseId,
      project: 'threadnote',
      memoryUri: records[0].uri,
      evidenceRevision: 'revision',
      expectedContentHash: 'hash',
      reason: finding.summary,
      choices: ['Review applicability and policy'],
      allowedOperations: ['read_context'],
      instructions: 'No source wins automatically.',
      semanticEvidence: finding.semanticEvidence,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://manager.test');
        const result =
          url.pathname === '/api/memory'
            ? {content: records[0].content}
            : url.searchParams.has('caseId') && url.searchParams.get('view') !== 'status'
              ? packet
              : retained;
        return new Response(JSON.stringify(result), {headers: {'content-type': 'application/json'}});
      }),
    );
    const openMemory = vi.fn();
    await render(
      <ContextMaintenanceView
        {...props}
        onOpenLibrary={openMemory}
        project="threadnote"
        report={{...health, findings: [], recordPreviews: [], repositoryEvidence: {state: 'available'}}}
      />,
    );
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      button => button.textContent === 'Review memory and evidence',
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    const evidence = document.querySelector('dialog [aria-label="Semantic comparison evidence"]');
    expect(evidence?.textContent).toContain('Timeout is 60 seconds.');
    expect(evidence?.textContent).toContain('Timeout must be 30 seconds.');
    expect(evidence?.textContent).toContain('policy conflict');
    expect(evidence?.textContent).toContain('unknown validity');
    expect(evidence?.textContent).toContain('Production');
    expect(evidence?.textContent).toContain(finding.semanticEvidence?.right.recordContentFingerprint);
    expect(document.querySelector('dialog')?.textContent).not.toContain('No source excerpt is available');
    expect(document.querySelector('dialog h2')?.textContent).toBe('Compare conflicting memories');
    expect(document.querySelector('dialog [aria-label="Memory being reviewed"]')).toBeNull();
    expect(document.querySelector('dialog')?.textContent).not.toContain('Edit or archive in Library');
    const openB = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      button => button.textContent?.trim() === 'Open memory B',
    );
    await act(async () => openB?.click());
    expect(openMemory).toHaveBeenCalledWith(records[1].uri);
  });
  it.each(['finding', 'retained'] as const)(
    'refreshes the retained decision queue immediately after confirming a semantic %s review',
    async path => {
      vi.useFakeTimers();
      const memory = (name: string, body: string): MemoryRecord => ({
        uri: `threadnote://memory/${name}`,
        body,
        content: body,
        headerTitle: 'MEMORY',
        metadata: {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'test',
          status: 'active',
          timestamp: '2026-01-01',
        },
      });
      const records = [
        memory('a', '# Production\nTimeout is 60 seconds.'),
        memory('b', '# Production\nTimeout must be 30 seconds.'),
      ];
      const health = buildContextHealthReport({project: 'threadnote', records, now: new Date('2026-06-01')});
      const finding = health.findings[0];
      const evidence = finding.semanticEvidence!;
      const item = {
        ...finding.caseIdentity!,
        caseId: finding.caseId!,
        evidenceRevision: 'revision',
        disposition: 'needs-decision' as const,
        reason: 'Opposing canonical claims',
        firstSeen: '2026-06-01',
        lastSeen: '2026-06-01',
        lastChecked: '2026-06-01',
        attemptCount: 0,
        subjectContentHashes: records.map(record => ({uri: record.uri, hash: 'hash'})),
        events: [],
      };
      let applied = false;
      let statusReads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input), 'http://manager.test');
          let result: unknown;
          if (url.pathname.endsWith('/semantic/preview'))
            result = {
              preview: {
                previewId: 'semantic-preview',
                revision: 'semantic-revision',
                choice: 'left',
                mode: 'archive-other',
                summary: 'Keep memory A current; move memory B to history.',
                keptUri: evidence.left.recordUri,
                archivedUri: evidence.right.recordUri,
                archivedContent: records[1].body,
                constraints: [],
              },
            };
          else if (url.pathname.endsWith('/semantic/apply')) {
            applied = true;
            result = {result: {status: 'applied', choice: 'left'}};
          } else if (url.searchParams.has('caseId') && url.searchParams.get('view') !== 'status') {
            result = {
              version: 2,
              project: 'threadnote',
              caseId: item.caseId,
              memoryUri: evidence.left.recordUri,
              reason: item.reason,
              evidenceRevision: 'revision',
              semanticEvidence: evidence,
              choices: [],
              instructions: 'Review both memories.',
            };
          } else {
            if (!url.searchParams.has('caseId')) statusReads += 1;
            result = {
              ...status(),
              state: applied ? 'idle' : 'needs-decision',
              cases: [{...item, disposition: applied ? 'resolved' : 'needs-decision'}],
              counts: {decisionMemories: applied ? 0 : 2},
            };
          }
          return new Response(JSON.stringify(result), {headers: {'content-type': 'application/json'}});
        }),
      );
      let currentReport = {
        ...report(),
        ...health,
        recordPreviews: [],
        findings: path === 'finding' ? health.findings : [],
        repositoryEvidence: {state: 'available' as const},
      };
      const onChanged = vi.fn(() => {
        currentReport = {
          ...currentReport,
          findings: [],
          maintenance: {...currentReport.maintenance!, affectedMemories: 0, actionableFindings: 0},
        };
        root?.render(
          <ContextMaintenanceView {...props} project="threadnote" report={currentReport} onChanged={onChanged} />,
        );
      });
      await render(
        <ContextMaintenanceView {...props} project="threadnote" report={currentReport} onChanged={onChanged} />,
      );
      expect(document.querySelectorAll('.health-record')).toHaveLength(2);
      const initialReads = statusReads;
      const click = async (label: string) => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          value => value.textContent?.trim() === label,
        );
        expect(button).toBeDefined();
        await act(async () => button!.click());
      };
      await click(path === 'finding' ? 'Compare evidence and preview change' : 'Review memory and evidence');
      await act(async () => document.querySelector<HTMLInputElement>('dialog input[value="left"]')!.click());
      await click('Preview my choice');
      await act(async () => document.querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!.click());
      await click('Confirm and move memory B to history');
      expect(onChanged).toHaveBeenCalledOnce();
      expect(statusReads).toBeGreaterThan(initialReads);
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.querySelectorAll('.health-record')).toHaveLength(0);
      expect(document.querySelector('[aria-label="Needs your decision"]')?.textContent).not.toContain(
        'Opposing canonical claims',
      );
      expect(document.body.textContent).toContain('No decisions are waiting');
      expect(
        [...document.querySelectorAll('[role="status"]')].some(value => value.textContent === 'Change saved.'),
      ).toBe(true);
    },
  );

  it('shows the affected memory, safe cause and concrete recovery when inventory stops', async () => {
    const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/broken.md';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...status(),
              state: 'failed',
              error: {
                reason: 'memory-snapshot-unreadable',
                at: '2026-10-05T07:00:00Z',
                diagnostic: {
                  version: 1,
                  category: 'invalid-header',
                  stage: 'record-read',
                  memoryUri,
                  retryable: false,
                  summary: 'Private memory header is not a valid Threadnote document.',
                  recovery:
                    'Preserve a backup, restore a valid header from a known-good copy, then run maintenance again.',
                },
              },
            }),
          ),
      ),
    );
    await render(<ContextMaintenanceView project="threadnote" report={report()} {...props} />);
    expect(document.body.textContent).toContain('Private memory header is not a valid Threadnote document.');
    expect(document.body.textContent).toContain(memoryUri);
    expect(document.body.textContent).toContain('Preserve a backup');
    expect(document.body.textContent).not.toContain('inspect the diagnostic');
    expect(document.body.textContent).toContain('Stopped');
    expect(
      document.querySelector('[aria-label="Background scan"] .health-status-badge')?.getAttribute('data-tone'),
    ).toBe('danger');
  });

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
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('retained historical declaration');
    await click('Close');
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

  it('keeps the review visible when background maintenance advances its generation', async () => {
    vi.useFakeTimers();
    let advanced = false;
    const memoryUri = 'threadnote://user/tester/memories/example.md';
    const item = {
      caseId: 'case-visible',
      project: 'threadnote',
      memoryId: 'memory-visible',
      family: 'citation',
      slot: 'anchor',
      evidenceRevision: 'revision',
      disposition: 'needs-decision',
      reason: 'source-changed',
      subjectContentHashes: [{uri: memoryUri, hash: 'hash'}],
      firstSeen: 'now',
      lastSeen: 'now',
      lastChecked: 'now',
      attemptCount: 1,
      events: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input, 'http://manager.test');
        if (url.pathname === '/api/memory') return new Response(JSON.stringify({content: '# Visible memory'}));
        if (url.searchParams.has('caseId') && url.searchParams.get('view') !== 'status')
          return new Response(
            JSON.stringify({
              version: 2,
              project: 'threadnote',
              caseId: item.caseId,
              memoryUri,
              evidenceRevision: 'revision',
              expectedContentHash: 'hash',
              reason: 'source-changed',
              choices: ['Review the claim'],
              allowedOperations: [],
              instructions: 'Compare the source.',
            }),
          );
        return new Response(
          JSON.stringify({...status(), cases: [item], page: {generation: advanced ? 'second' : 'first'}}),
        );
      }),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    const review = [...document.querySelectorAll('button')].find(
      button => button.textContent === 'Review memory and evidence',
    );
    await act(async () => review!.click());
    expect(document.querySelector('dialog')?.open).toBe(true);
    advanced = true;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(document.querySelector('dialog')?.open).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('Visible memory');
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

  it('loads remaining decisions directly in the decision queue without requiring History', async () => {
    const cases: ManagerContextMaintenanceStatusV2['cases'] = ['first', 'second'].map(name => ({
      caseId: name,
      project: 'threadnote',
      memoryId: name,
      family: 'citation',
      slot: 'anchor',
      disposition: 'needs-decision',
      reason: 'source-changed',
      evidenceRevision: 'revision',
      subjectContentHashes: [{uri: `threadnote://user/tester/memories/${name}.md`, hash: 'hash'}],
      firstSeen: 'now',
      lastSeen: 'now',
      lastChecked: 'now',
      attemptCount: 1,
      events: [],
    }));
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      expect(init?.method).not.toBe('POST');
      const next = new URL(input, 'http://manager.test').searchParams.get('caseCursor') === 'next-decisions';
      return new Response(
        JSON.stringify({
          ...status(),
          cases: [cases[next ? 1 : 0]],
          counts: {decisionMemories: 2, 'needs-decision': 2},
          page: {generation: 'same-generation', caseNextCursor: next ? undefined : 'next-decisions'},
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    const queue = document.querySelector('[aria-label="Needs your decision"]');
    expect(queue?.querySelectorAll('article')).toHaveLength(1);
    const more = [...queue!.querySelectorAll<HTMLButtonElement>('button')].find(
      button => button.textContent === 'Load more memories to review',
    );
    expect(more).toBeDefined();
    await act(async () => more!.click());
    expect(queue?.querySelectorAll('article')).toHaveLength(2);
    expect(queue?.querySelectorAll('h3')[2].textContent).toBe('second');
    expect(queue?.textContent).not.toContain('Load more memories to review');
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Needs a decision');
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
      item => item.textContent === 'Review with agent…',
    );
    await act(async () => prepare?.click());
    expect(document.querySelector('dialog')?.open).toBe(true);
    const task = document.querySelector<HTMLTextAreaElement>('dialog textarea')?.value;
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
    expect(document.body.textContent).toContain('Extraction coverage can remain partial after scanning finishes');
    expect(document.body.textContent).toContain('Run maintenance now');
    expect(document.body.textContent).not.toContain('Repair all');
    expect(document.body.textContent).not.toContain('2,013 issues');
  });
  it.each(['extraction', 'comparison'] as const)(
    'keeps the scan in progress while semantic %s work remains',
    async phase => {
      const current = {
        ...status(),
        projects: [{...status().projects[0], checked: 1_712}],
        semanticCoverage: [
          {
            project: 'threadnote',
            state: 'partial',
            eligibleRecords: 18,
            checkedBatches: 2,
            totalBatches: 3,
            extractedRecords: phase === 'extraction' ? 16 : 18,
            totalRecords: 18,
            extractionComplete: phase !== 'extraction',
            comparisonComplete: false,
            comparedClaimPairs: 256,
            ...(phase === 'comparison' ? {totalClaimPairs: 1_024} : {}),
            unsupportedRecords: 0,
            unsupportedClaims: 0,
            bodyLimitedRecords: 0,
            outputOmittedFindings: 0,
            churnCount: 0,
          },
        ],
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify(current), {
              headers: {'content-type': 'application/json'},
            }),
        ),
      );
      await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
      expect(document.querySelector('[aria-label="Background scan"]')?.textContent).toContain('Scanning');
      expect(document.querySelector('[aria-label="Semantic scan progress"]')?.textContent).toContain(
        phase === 'extraction' ? '16 of 18 durable memories read' : '256 of 1,024 claim comparisons checked',
      );
      expect(document.querySelector('[aria-label="Claim comparison progress"]') === null).toBe(phase === 'extraction');
    },
  );
  it('uses completed maintenance coverage while preserving unsupported and omitted evidence warnings', async () => {
    const current = {
      ...status(),
      projects: [{...status().projects[0], checked: 1_712}],
      semanticCoverage: [
        {
          project: 'threadnote',
          state: 'partial',
          eligibleRecords: 18,
          checkedBatches: 3,
          totalBatches: 3,
          extractedRecords: 18,
          totalRecords: 18,
          extractionComplete: true,
          comparisonComplete: true,
          comparedClaimPairs: 1_024,
          totalClaimPairs: 1_024,
          unsupportedRecords: 2,
          unsupportedClaims: 3,
          bodyLimitedRecords: 1,
          outputOmittedFindings: 4,
          churnCount: 2,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(current), {
            headers: {'content-type': 'application/json'},
          }),
      ),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={report()} />);
    expect(document.querySelector('[aria-label="Background scan"]')?.textContent).toContain('Caught up');
    const scan = document.querySelector('[aria-label="Semantic scan progress"]')?.textContent;
    expect(scan).toContain('18 of 18 durable memories read');
    expect(scan).toContain('1,024 comparison checks performed across source revisions');
    expect(scan).toContain('Current comparisons finished.');
    expect(scan).toContain('3 claims in 2 memories could not be interpreted');
    expect(scan).toContain('1 memory exceeded the supported text limit');
    expect(scan).toContain('4 findings are outside the retained output limit');
    expect(scan).toContain('2 source changes invalidated affected work');
    expect(scan).toContain('Completed checks do not prove that memories agree');
    expect(document.querySelector('[aria-label="Evidence coverage"] > header')?.textContent).toContain('partial');
  });
  it('reports completed heuristic traversal even when the direct report is limited to a prefix', async () => {
    const current = {
      ...status(),
      projects: [{...status().projects[0], checked: 1_712}],
      semanticCoverage: [
        {
          project: 'threadnote',
          state: 'complete',
          eligibleRecords: 18,
          checkedBatches: 3,
          totalBatches: 3,
          extractedRecords: 18,
          totalRecords: 18,
          extractionComplete: true,
          comparisonComplete: true,
          comparedClaimPairs: 1_024,
          totalClaimPairs: 1_024,
          unsupportedRecords: 0,
          unsupportedClaims: 0,
          bodyLimitedRecords: 0,
          outputOmittedFindings: 0,
          churnCount: 0,
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(current), {
            headers: {'content-type': 'application/json'},
          }),
      ),
    );
    const health = report();
    await render(
      <ContextMaintenanceView
        {...props}
        project="threadnote"
        report={{
          ...health,
          maintenance: {
            ...health.maintenance!,
            citationCoverage: {...health.maintenance!.citationCoverage, state: 'complete'},
          },
        }}
      />,
    );
    expect(document.querySelector('[aria-label="Evidence coverage"] > header')?.textContent).toContain('complete');
    expect(document.querySelector('[aria-label="Semantic scan progress"]')?.textContent).toContain('Checked');
    expect(document.querySelector('[aria-label="Semantic scan progress"]')?.textContent).not.toContain(
      'Checked with gaps',
    );
    expect(document.querySelector('[aria-label="Background scan"]')?.textContent).toContain('Caught up');
  });
  it.each([false, true])('only marks an empty project caught up after inventory completes (%s)', async complete => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({...status(), projects: [], preparation: {complete, admittedRecords: 0}}), {
            headers: {'content-type': 'application/json'},
          }),
      ),
    );
    await render(<ContextMaintenanceView {...props} project="threadnote" report={{...report(), recordsScanned: 0}} />);
    expect(document.querySelector('[aria-label="Background scan"]')?.textContent).toContain(
      complete ? 'Caught up' : 'Scanning',
    );
    expect(document.querySelector('[aria-label="Preparing background maintenance"]') === null).toBe(complete);
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
    expect(
      document.querySelector('[aria-label="Background scan"] .health-status-badge')?.getAttribute('data-tone'),
    ).toBe('warning');
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
