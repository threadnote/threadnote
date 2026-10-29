import {Array as EffectArray} from 'effect';
// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {MaintenanceCaseDialog, MaintenanceTaskDialog} from '../../src/attention/maintenance_dialogs.js';
import {HealthDetail} from '../../src/attention_details.js';
import type {
  ManagerContextMaintenanceCaseV2,
  ManagerContextMaintenancePacketV2,
  ManagerContextMaintenanceStatusV2,
} from '../../src/attention/contracts.js';
import type {ManagerTopicReviewV1} from '../../src/attention/topic_contracts.js';
import {ManagerApiError} from '../../src/ui/support.js';
import {evidenceReadError, maintenanceEvidenceBusy} from '../../src/attention/evidence_refresh.js';
import {buildContextHealthReport} from '@threadnote/context/health';
import type {MemoryRecord} from '@threadnote/memory/document';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

let root: Root;
const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/runtime-boundaries.md';
const item: ManagerContextMaintenanceCaseV2 = {
  caseId: 'case-one',
  project: 'threadnote',
  memoryId: 'memory-one',
  family: 'citation',
  slot: 'anchor:one',
  disposition: 'needs-decision',
  reason: 'source-changed',
  evidenceRevision: 'revision',
  subjectContentHashes: [{uri: memoryUri, hash: 'hash'}],
  firstSeen: 'now',
  lastSeen: 'now',
  lastChecked: 'now',
  attemptCount: 1,
  events: [],
};
function maintenanceStatus(cases: readonly ManagerContextMaintenanceCaseV2[]): ManagerContextMaintenanceStatusV2 {
  return {
    version: 2,
    paused: false,
    state: 'needs-decision',
    generation: 'fixture-generation',
    projects: [],
    cases,
    receipts: [],
  };
}
const packet = {
  version: 2,
  project: 'threadnote',
  caseId: item.caseId,
  memoryUri,
  expectedContentHash: 'hash',
  evidenceRevision: 'revision',
  reason: 'source-changed',
  choices: ['Update the supported claim'],
  allowedOperations: ['read_context'],
  instructions: 'Review the actual claim.',
  evidence: {
    coverage: 'available',
    generation: 'one',
    attemptedSteps: [],
    excerpts: [
      {
        content: 'current declaration',
        provenance: 'current-verified',
        supportsCitation: false,
        excerptHash: 'current',
        startLine: 1,
        endLine: 1,
        fileBytesHash: 'current-file',
        source: {path: 'src/current.ts', sourceCommit: 'current-commit', sourceSnapshotId: 'current-snapshot'},
      },
      {
        content: 'historical declaration',
        provenance: 'historical-verified',
        supportsCitation: true,
        excerptHash: 'historical',
        startLine: 1,
        endLine: 1,
        fileBytesHash: 'historical-file',
        source: {path: 'src/current.ts', sourceCommit: 'historical-commit', sourceSnapshotId: 'historical-snapshot'},
      },
    ],
  },
};
const base = {
  project: 'threadnote',
  caseId: item.caseId,
  initialCase: item,
  onClose: vi.fn(),
  onTask: vi.fn(),
  onOpenLibrary: vi.fn(),
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render(node: React.ReactElement) {
  await act(async () => root.render(node));
}
async function click(label: string) {
  const button = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('dialog button')],
      value =>
        Effect.pipe(value.textContent, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
        ) === label,
    ),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function serveCase(readPacket: () => Promise<Response>) {
  const fetch = vi.fn(async (input: string, _init?: RequestInit) => {
    if (Effect.pipe(input, EffectString.startsWith('/api/memory?')))
      return response({content: 'MEMORY\nkind: durable\n\n# Stored claim\nKeep ownership explicit.'});
    if (Effect.pipe(input, EffectString.includes('view=status'))) return response(maintenanceStatus([item]));
    const result = await readPacket();
    return _init?.method === 'POST' && result.ok
      ? response({outcome: 'ready', item, packet: await result.json()})
      : result;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('opens the result as a modal, copies the exact task and reports clipboard failures', async () => {
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const close = vi.fn();
  await render(<MaintenanceTaskDialog task="Review only case-one; preserve shared authority." onClose={close} />);
  expect(document.querySelector('dialog')?.open).toBe(true);
  expect(document.querySelector<HTMLTextAreaElement>('dialog textarea')?.getAttribute('readonly')).not.toBeNull();
  await click('Copy task');
  expect(copy).toHaveBeenCalledWith('Review only case-one; preserve shared authority.');
  expect(document.querySelector('dialog [role="status"]')?.textContent).toContain('Task copied');
  copy.mockRejectedValueOnce(new Error('clipboard blocked'));
  await click('Copy task');
  expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('keyboard');
  await click('Close');
  expect(close).toHaveBeenCalledOnce();
});

it('opens immediately while loading, then compares the memory and current/historical source without mutations', async () => {
  const pending = Promise.withResolvers<Response>();
  const fetch = serveCase(() => pending.promise);
  const open = vi.fn();
  await render(<MaintenanceCaseDialog {...base} onOpenLibrary={open} />);
  expect(document.querySelector('dialog')?.open).toBe(true);
  expect(document.querySelector('dialog')?.textContent).toContain('Loading this case');
  expect(document.querySelector('dialog')?.textContent).toContain('Keep ownership explicit.');
  expect(document.querySelector('[aria-label="Memory being reviewed"]')?.textContent).not.toContain('kind: durable');
  await act(async () => pending.resolve(response(packet)));
  expect(document.querySelector('dialog')?.textContent).toContain('current declaration');
  expect(document.querySelector('dialog')?.textContent).toContain('historical declaration');
  expect(document.querySelector('dialog')?.textContent).toContain('does not verify today');
  expect(EffectArray.every(fetch.mock.calls, ([, init]) => init === undefined || init.method !== 'POST')).toBe(true);
  await click('Edit or archive in Library');
  expect(open).toHaveBeenCalledWith(memoryUri);
});

it('keeps case errors inside the open review and recovers after refreshing evidence', async () => {
  let failed = true;
  serveCase(async () =>
    failed ? response({error: 'The selected maintenance case is stale.'}, 409) : response(packet),
  );
  await render(<MaintenanceCaseDialog {...base} />);
  expect(document.querySelector('dialog')?.open).toBe(true);
  expect(document.querySelector('dialog [role="alert"]')?.textContent).toContain('case is stale');
  expect(document.querySelector('dialog')?.textContent).toContain('check current evidence');
  failed = false;
  await click('Refresh evidence');
  expect(document.querySelector('dialog [role="alert"]')).toBeNull();
  expect(document.querySelector('dialog')?.textContent).toContain('current declaration');
});

it('keeps preview and confirmation with the agent action in one conflict-resolution footer', async () => {
  const memory = (name: string, body: string): MemoryRecord => ({
    uri: `threadnote://memory/${name}`,
    body,
    content: body,
    headerTitle: 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      status: 'active',
      sourceAgentClient: 'test',
      timestamp: '2026-01-01',
    },
  });
  const evidence = buildContextHealthReport({
    project: 'threadnote',
    records: [memory('a', 'Timeout is 60 seconds.'), memory('b', 'Timeout must be 30 seconds.')],
    now: new Date('2026-06-01'),
  }).findings[0].semanticEvidence!;
  function requestBodyText(init: RequestInit | undefined): string {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body.');
    return init.body;
  }

  const semanticCase = {...item, family: 'semantic-contradiction'};
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (Effect.pipe(path, EffectString.endsWith('/preview'))) {
      expect(JSON.parse(requestBodyText(init)).choice).toBe('both');
      return response({
        preview: {
          previewId: 'preview',
          revision: 'exact-revision',
          choice: 'both',
          mode: 'keep-both',
          summary: 'Both memories stay current.',
          constraints: [],
        },
      });
    }
    if (Effect.pipe(path, EffectString.endsWith('/apply'))) {
      expect(JSON.parse(requestBodyText(init))).toEqual({
        project: 'threadnote',
        previewId: 'preview',
        revision: 'exact-revision',
        approved: true,
      });
      return response({result: {status: 'applied', choice: 'both'}});
    }
    if (Effect.pipe(path, EffectString.includes('view=status'))) return response(maintenanceStatus([semanticCase]));
    return response({
      ...packet,
      family: semanticCase.family,
      semanticEvidence: evidence,
      evidence: undefined,
      ownerProposal: {
        proposalRevision: 'proposal-revision',
        expectedContentHash: 'hash',
        selectedEdits: [],
        omittedEdits: 0,
        publication: {instructions: 'The shared owner must review canonical edits.'},
      },
    });
  });
  vi.stubGlobal('fetch', fetch);
  const changed = vi.fn();
  const close = vi.fn();
  const task = vi.fn();
  await render(
    <MaintenanceCaseDialog {...base} initialCase={semanticCase} onChanged={changed} onClose={close} onTask={task} />,
  );
  const footer = document.querySelector('dialog footer');
  expect(document.querySelectorAll('dialog footer')).toHaveLength(1);
  expect(footer?.getAttribute('aria-label')).toBe('Conflict resolution actions');
  expect(footer?.querySelector<HTMLButtonElement>('button.primary')?.textContent).toBe('Preview my choice');
  expect(footer?.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(true);
  await act(async () => document.querySelector<HTMLInputElement>('input[value="both"]')!.click());
  expect(EffectArray.filter(fetch.mock.calls, ([, init]) => init?.method === 'POST')).toHaveLength(0);
  expect(footer?.querySelector('[role="status"]')?.textContent).toBe('Both memories selected');
  await click('Preview my choice');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Review your choice');
  expect(document.querySelector('dialog')?.textContent).not.toContain('The shared owner must review canonical edits.');
  expect(footer?.querySelector<HTMLButtonElement>('button.primary')?.textContent).toBe('Confirm both apply');
  await click('Review with agent…');
  expect(task).toHaveBeenCalledWith(expect.stringContaining('Compare both memories'));
  expect(changed).not.toHaveBeenCalled();
  await click('Confirm both apply');
  expect(changed).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(
    EffectArray.filter(
      fetch.mock.calls,
      ([path], index) => index in fetch.mock.calls && Effect.pipe(path, EffectString.endsWith('/apply')),
    ),
  ).toHaveLength(1);
});

it('uses the existing conflict-action footer for a health finding during stale review', async () => {
  const memory = (name: string, body: string): MemoryRecord => ({
    uri: `threadnote://memory/${name}`,
    body,
    content: body,
    headerTitle: 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      status: 'active',
      sourceAgentClient: 'test',
      timestamp: '2026-01-01',
    },
  });
  const finding = buildContextHealthReport({
    project: 'threadnote',
    records: [memory('a', 'Timeout is 60 seconds.'), memory('b', 'Timeout must be 30 seconds.')],
    now: new Date('2026-06-01'),
  }).findings[0];
  const pending = Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => pending.promise),
  );
  await render(
    <HealthDetail
      project="threadnote"
      finding={finding}
      repairsAvailable={false}
      stale
      onClose={() => undefined}
      onChanged={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  expect(document.querySelectorAll('dialog footer')).toHaveLength(1);
  expect(document.querySelector('dialog footer')?.getAttribute('aria-label')).toBe('Conflict resolution actions');
  expect(document.querySelector('dialog footer')?.textContent).toContain('Checking current statements');
  await act(async () =>
    pending.resolve(response({outcome: 'unavailable', reason: 'Current evidence is unavailable.'})),
  );
});

it('reviews the chosen memory in a case spanning several subjects and preserves that choice in its task', async () => {
  const selectedUri = 'threadnote://user/tester/memories/durable/projects/threadnote/second-memory.md';
  const scopedCase = {
    ...item,
    family: 'repository-recovery',
    subjectContentHashes: [...item.subjectContentHashes!, {uri: selectedUri, hash: 'second-hash'}],
  };
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, 'http://manager.test');
    if (url.pathname === '/api/memory') {
      expect(url.searchParams.get('uri')).toBe(selectedUri);
      return response({content: '# The selected second memory'});
    }
    if (url.searchParams.get('view') === 'status') return response({version: 2, cases: [scopedCase]});
    expect(url.searchParams.get('memoryUri')).toBe(selectedUri);
    return response(packet);
  });
  vi.stubGlobal('fetch', fetch);
  const open = vi.fn();
  const task = vi.fn();
  await render(
    <MaintenanceCaseDialog
      {...base}
      initialCase={scopedCase}
      memoryUri={selectedUri}
      onOpenLibrary={open}
      onTask={task}
    />,
  );
  expect(document.querySelector('dialog')?.textContent).toContain('The selected second memory');
  await click('Edit or archive in Library');
  expect(open).toHaveBeenCalledWith(selectedUri);
  await click('Review with agent…');
  expect(task).toHaveBeenCalledWith(expect.stringContaining(`Selected memory: "${selectedUri}"`));
});

it('keeps the old project response out of a newly selected case', async () => {
  const pending = Promise.withResolvers<Response>();
  serveCase(() => pending.promise);
  await render(<MaintenanceCaseDialog {...base} />);
  await render(<MaintenanceTaskDialog task="Other project task" onClose={() => undefined} />);
  await act(async () => pending.resolve(response(packet)));
  expect(document.querySelector('dialog')?.textContent).not.toContain('current declaration');
  expect(document.querySelector<HTMLTextAreaElement>('dialog textarea')?.value).toBe('Other project task');
});

it('switches checks inside the same review and ignores the previous check’s late evidence', async () => {
  const pending = Promise.withResolvers<Response>();
  const second = {...item, caseId: 'case-two'};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://manager.test');
      if (url.pathname === '/api/memory') return response({content: '# Stored claim'});
      const next = url.searchParams.get('caseId') === second.caseId;
      if (url.searchParams.get('view') === 'status') return response(maintenanceStatus([next ? second : item]));
      return next
        ? response({...packet, caseId: second.caseId, choices: ['Second check choice'], evidence: undefined})
        : await pending.promise;
    }),
  );
  await render(<MaintenanceCaseDialog {...base} relatedCases={[item, second]} />);
  const select = document.querySelector<HTMLSelectElement>('dialog select');
  expect(select).not.toBeNull();
  await act(async () => {
    select!.value = second.caseId;
    select!.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(document.querySelector('dialog')?.textContent).toContain('Second check choice');
  await act(async () => pending.resolve(response(packet)));
  expect(document.querySelector('dialog')?.textContent).toContain('Second check choice');
  expect(document.querySelector('dialog')?.textContent).not.toContain('current declaration');
});

it('explains source-changed ownership and offers a direct supported review step', async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
    Effect.pipe(String(input), EffectString.includes('/api/memory?'))
      ? response({content: '# Stored advice'})
      : Effect.pipe(String(input), EffectString.includes('view=status'))
        ? response(maintenanceStatus([item]))
        : response(packet),
  );
  await render(<MaintenanceCaseDialog {...base} />);
  expect(document.body.textContent).toContain('Background checks can refresh source evidence');
  expect(document.body.textContent).toContain('Your review is needed');
  expect(document.body.textContent).toContain('Refresh evidence only rechecks the source');
  const next = document.querySelector('.health-source-next-step');
  expect(next?.querySelector('button')?.textContent).toContain('Review with agent');
  expect(document.querySelector('.health-code-preview .source-excerpt code')?.textContent).toBe('current declaration');
});

it('retries an initial busy evidence read without a manual click or displaying the lock path', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const fetch = serveCase(async () =>
    ++attempts < 3 ? response({error: 'Timed out waiting for local lock /private/state.lock.'}, 503) : response(packet),
  );
  await render(<MaintenanceCaseDialog {...base} />);
  expect(document.querySelector('dialog')?.textContent).not.toContain('/private/state.lock');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(attempts).toBe(3);
  expect(document.querySelector('dialog')?.textContent).toContain('current declaration');
  expect(EffectArray.every(fetch.mock.calls, ([, init]) => init?.method !== 'POST')).toBe(true);
});

it('retains stored memory and evidence nodes and scroll during a busy background refresh', async () => {
  vi.useFakeTimers();
  let busy = false;
  let attempts = 0;
  serveCase(async () => (busy && ++attempts < 3 ? response({error: 'Busy'}, 503) : response(packet)));
  await render(<MaintenanceCaseDialog {...base} />);
  const memory = document.querySelector('[aria-label="Memory being reviewed"] .memory-excerpt');
  const evidenceNode = document.querySelector('.health-code-preview');
  expect(memory).not.toBeNull();
  expect(evidenceNode).not.toBeNull();
  const body = document.querySelector('.detail-modal-body')!;
  body.scrollTop = 100;
  busy = true;
  await render(<MaintenanceCaseDialog {...base} stale />);
  expect(document.querySelector('[aria-label="Memory being reviewed"] .memory-excerpt')).toBe(memory);
  expect(document.querySelector('.health-code-preview')).toBe(evidenceNode);
  expect(body.scrollTop).toBe(100);
  expect(document.querySelector('dialog')?.textContent).not.toContain('Loading memory…');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(document.querySelector('.health-code-preview')).toBe(evidenceNode);
  expect(body.scrollTop).toBe(100);
});

it('redacts the previous stored memory synchronously when selecting another source URI and ignores its late read', async () => {
  const nextUri = EffectString.replace('runtime-boundaries.md', 'another-source.md')(memoryUri);
  const pending = Promise.withResolvers<Response>();
  const lateOld = Promise.withResolvers<Response>();
  let firstReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (EffectString.startsWith('/api/memory?')(path)) {
        const uri = new URL(path, 'http://manager.test').searchParams.get('uri');
        if (uri === nextUri) return pending.promise;
        return ++firstReads === 1
          ? response({content: 'MEMORY\nkind: durable\n\n# Previous private source\nOld retained content.'})
          : lateOld.promise;
      }
      return response(EffectString.includes('view=status')(path) ? maintenanceStatus([item]) : packet);
    }),
  );
  await render(<MaintenanceCaseDialog {...base} memoryUri={memoryUri} />);
  expect(document.querySelector('[aria-label="Memory being reviewed"]')?.textContent).toContain(
    'Old retained content.',
  );
  await render(<MaintenanceCaseDialog {...base} memoryUri={memoryUri} stale />);
  await render(<MaintenanceCaseDialog {...base} memoryUri={nextUri} />);
  const memory = document.querySelector('[aria-label="Memory being reviewed"]')!;
  expect(memory.textContent).not.toContain('Old retained content.');
  expect(memory.textContent).toContain('Loading memory…');
  await act(async () => lateOld.resolve(response({content: '# Superseded source response'})));
  expect(memory.textContent).not.toContain('Superseded source response');
  await act(async () => pending.resolve(response({content: '# Current selected source'})));
  expect(memory.textContent).toContain('Current selected source');
});

async function privateTopicBusyFixture() {
  const hash = EffectString.repeat(64)('a');
  const selected = {...item, family: 'topic-maintenance', slot: 'declared-support'};
  const selectedPacket: ManagerContextMaintenancePacketV2 = {
    ...packet,
    version: 2,
    evidence: undefined,
    family: selected.family,
    slot: selected.slot,
    reviewId: 'private-topic-review',
    topicEvidence: {
      version: 2,
      sourceKind: 'obsidian',
      outcome: 'ready',
      targetUri: memoryUri,
      targetHash: hash,
      observationRevision: hash,
      coverage: 'declared-only',
      canDraft: true,
      body: 'PRIVATE ACCEPTED CLAIM',
      paragraphs: [],
      additionalDependencies: [],
      obsidian: {
        current: {
          sourceId: 'source',
          sourceInstanceId: 'instance',
          noteId: 'note',
          relativePath: 'private.md',
          revisionHash: hash,
          sanitizerVersion: 'v1',
          accessHash: hash,
          vaultHash: hash,
          inspectionDigest: hash,
          content: 'PRIVATE SUPPORT EXCERPT',
          startOffset: 0,
          endOffset: 23,
          truncated: false,
        },
      },
    },
  };
  const review: ManagerTopicReviewV1 = {
    version: 1,
    kind: 'topic-maintenance',
    project: 'threadnote',
    reviewId: selectedPacket.reviewId!,
    revision: 3,
    state: 'pending',
    topic: 'Private topic',
    caseId: selected.caseId,
    sourceKind: 'obsidian',
    caseObservationMatches: true,
    targetUri: memoryUri,
    targetHash: hash,
    acceptedBody: 'PRIVATE ACCEPTED CLAIM',
    observationRevision: hash,
    coverage: 'declared-only',
    generation: {origin: 'manual', agent: 'user', model: 'manual', attempts: 0, usage: {status: 'unavailable'}},
    draft: {
      version: 1,
      targetHash: hash,
      observationRevision: hash,
      packetDigest: hash,
      outcome: 'propose-revalidation',
      operations: [],
      reviewedHandles: ['current:source'],
      rationale: 'Review existing claim.',
      unresolvedQuestions: [],
      removedClaims: [],
    },
    proposal: {body: 'PRIVATE PREPARED COMPARISON', finalBodyHash: hash, changedOrdinals: []},
    paragraphs: [],
    additionalDependencies: [],
    support: [],
    warnings: [],
    canApply: true,
    approval: {
      stage: 'preview',
      reviewRevision: 3,
      approvalDigest: hash,
      content: 'PRIVATE PREPARED COMPARISON',
      contentHash: hash,
      metadataDiff: [],
    },
  };
  let failure: {status: number; code?: string} | undefined;
  let reviewFailure: {status: number; code?: string} | undefined;
  let held: Promise<Response> | undefined;
  let heldSignal: AbortSignal | null | undefined;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const project =
      init?.method === 'POST'
        ? JSON.parse(String(init.body)).project
        : new URL(path, 'http://manager.test').searchParams.get('project');
    if (project && project !== 'threadnote')
      return response({error: 'This scope no longer authorizes the review.'}, 403);
    if (EffectString.startsWith('/api/consolidation-models')(path)) return response({models: []});
    if (EffectString.startsWith('/api/attention/topic-review')(path)) {
      if (init?.method === 'POST') throw new Error('This observation test must not mutate a topic review.');
      return reviewFailure
        ? response({error: 'Later source review refused.', code: reviewFailure.code}, reviewFailure.status)
        : response(review);
    }
    if (EffectString.startsWith('/api/memory?')(path)) return response({content: 'PRIVATE ACCEPTED CLAIM'});
    if (init?.method === 'POST' && held) {
      const pending = held;
      held = undefined;
      heldSignal = init.signal;
      return pending;
    }
    if (init?.method === 'POST')
      return failure
        ? response(
            {error: 'Untrusted backend detail must not appear as busy guidance.', code: failure.code},
            failure.status,
          )
        : response({outcome: 'ready', item: selected, packet: selectedPacket});
    return response(EffectString.includes('view=status')(path) ? maintenanceStatus([selected]) : selectedPacket);
  });
  vi.stubGlobal('fetch', fetch);
  const element = (stale = false, project = 'threadnote') => (
    <MaintenanceCaseDialog {...base} project={project} initialCase={selected} stale={stale} />
  );
  await render(element());
  return {
    fetch,
    element,
    fail: (status: number, code?: string) => {
      failure = {status, code};
    },
    recover: () => {
      failure = undefined;
    },
    failReview: (status: number, code?: string) => {
      reviewFailure = {status, code};
    },
    hold: (promise: Promise<Response>) => {
      held = promise;
    },
    signal: () => heldSignal,
    ready: () => response({outcome: 'ready', item: selected, packet: selectedPacket}),
  };
}

it('keeps a private prepared comparison through exact maintenance busy and resumes only after a fresh observation', async () => {
  vi.useFakeTimers();
  const fixture = await privateTopicBusyFixture();
  const content = document.querySelector('.topic-review-content');
  const apply = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      button =>
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(button.textContent), text => EffectString.trim(text)),
        ) === 'Confirm unchanged',
    ),
  );
  expect(apply?.disabled).toBe(false);
  expect(content?.textContent).toContain('PRIVATE PREPARED COMPARISON');
  fixture.fail(503, 'context-maintenance-busy');
  await render(fixture.element(true));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(document.querySelector('.topic-review-content')).toBe(content);
  expect(content?.textContent).toContain('PRIVATE PREPARED COMPARISON');
  expect(apply?.disabled).toBe(true);
  expect(document.body.textContent).toContain('Maintenance is busy. Check current evidence to try again.');
  expect(document.body.textContent).not.toContain('Untrusted backend detail');
  const posts = () => EffectArray.filter(fixture.fetch.mock.calls, ([, init]) => init?.method === 'POST');
  expect(posts()).toHaveLength(3);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(posts()).toHaveLength(3);
  fixture.recover();
  await click('Check current evidence');
  expect(document.querySelector('.topic-review-content')).toBe(content);
  expect(apply?.disabled).toBe(false);
  expect(posts()).toHaveLength(4);
  expect(EffectArray.every(posts(), ([, init]) => JSON.parse(String(init?.body)).action === 'refresh-case')).toBe(true);
});

it.each([
  [503, undefined],
  [503, 'different-code'],
  [500, 'context-maintenance-busy'],
  [401, 'context-maintenance-busy'],
  [403, 'context-maintenance-busy'],
  [404, 'context-maintenance-busy'],
] as const)('does not treat status %s and code %s as proven maintenance busy', async (status, code) => {
  vi.useFakeTimers();
  const fixture = await privateTopicBusyFixture();
  expect(document.body.textContent).toContain('PRIVATE PREPARED COMPARISON');
  fixture.fail(status, code);
  await render(fixture.element(true));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(document.body.textContent).not.toContain('PRIVATE PREPARED COMPARISON');
  expect(document.body.textContent).not.toContain('Maintenance is busy.');
  expect(maintenanceEvidenceBusy(ManagerApiError.of('Synthetic refusal.', status, code))).toBe(false);
  const posts = EffectArray.filter(fixture.fetch.mock.calls, ([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength([401, 403, 404].includes(status) ? 1 : 3);
});

it('classifies network failures as generic evidence errors rather than maintenance acquisition busy', () => {
  const network = new TypeError('Network request failed.');
  expect(maintenanceEvidenceBusy(network)).toBe(false);
  expect(evidenceReadError(network)).toBe(
    'Current evidence could not be checked. Check current evidence to try again.',
  );
});

it('keeps a private prepared comparison when the topic review’s own refresh reports exact maintenance busy', async () => {
  vi.useFakeTimers();
  const fixture = await privateTopicBusyFixture();
  expect(document.body.textContent).toContain('PRIVATE PREPARED COMPARISON');
  fixture.fail(503, 'context-maintenance-busy');
  await click('Refresh evidence');
  expect(document.body.textContent).not.toContain('PRIVATE PREPARED COMPARISON');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(document.body.textContent).toContain('PRIVATE PREPARED COMPARISON');
  expect(document.body.textContent).toContain('Maintenance is busy. Check current evidence to try again.');
  expect(
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('button')],
        button =>
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(button.textContent), text => EffectString.trim(text)),
          ) === 'Confirm unchanged',
      ),
    )?.disabled,
  ).toBe(true);
});

it.each([503, 401, 403, 404])(
  'does not restore a private comparison when a later review read returns %s after busy recovery',
  async status => {
    vi.useFakeTimers();
    const fixture = await privateTopicBusyFixture();
    fixture.fail(503, 'context-maintenance-busy');
    await click('Refresh evidence');
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(document.body.textContent).toContain('PRIVATE PREPARED COMPARISON');
    fixture.recover();
    fixture.failReview(status, 'context-maintenance-busy');
    await click('Refresh evidence');
    expect(document.body.textContent).not.toContain('PRIVATE PREPARED COMPARISON');
    expect(document.body.textContent).not.toContain('PRIVATE SUPPORT EXCERPT');
    expect(document.body.textContent).not.toContain('Maintenance is busy. Check current evidence');
    expect(document.body.textContent).toContain('Later source review refused.');
    expect(
      EffectArray.filter([...document.querySelectorAll<HTMLButtonElement>('.topic-review-content button')], button =>
        ['Apply update', 'Confirm unchanged'].includes(
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(button.textContent), text => EffectString.trim(text)),
          ) ?? '',
        ),
      ),
    ).toHaveLength(0);
  },
);

it('preserves the chosen semantic outcome and prepared preview through busy while confirmation stays blocked', async () => {
  vi.useFakeTimers();
  const memory = (name: string, body: string): MemoryRecord => ({
    uri: `threadnote://memory/${name}`,
    body,
    content: body,
    headerTitle: 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      status: 'active',
      sourceAgentClient: 'test',
      timestamp: '2026-01-01',
    },
  });
  const semantic = buildContextHealthReport({
    project: 'threadnote',
    records: [memory('left', 'Timeout is 60 seconds.'), memory('right', 'Timeout must be 30 seconds.')],
    now: new Date('2026-06-01'),
  }).findings[0].semanticEvidence!;
  const selected = {...item, family: 'semantic-contradiction'};
  const selectedPacket = {...packet, family: selected.family, semanticEvidence: semantic, evidence: undefined};
  let busy = false;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (EffectString.endsWith('/preview')(path))
      return response({
        preview: {
          previewId: 'selected-preview',
          revision: 'exact-revision',
          choice: 'both',
          mode: 'keep-both',
          summary: 'Both memories remain current.',
          constraints: [],
        },
      });
    if (EffectString.endsWith('/apply')(path)) throw new Error('Busy/recovery must not apply a saved choice.');
    if (init?.method === 'POST')
      return busy
        ? response({code: 'context-maintenance-busy', error: 'Do not display a lock path /private/lock.'}, 503)
        : response({outcome: 'ready', item: selected, packet: selectedPacket});
    return response(EffectString.includes('view=status')(path) ? maintenanceStatus([selected]) : selectedPacket);
  });
  vi.stubGlobal('fetch', fetch);
  await render(<MaintenanceCaseDialog {...base} initialCase={selected} />);
  await act(async () => document.querySelector<HTMLInputElement>('input[value="both"]')!.click());
  await click('Preview my choice');
  const comparison = document.querySelector('[aria-label="Review your choice"]');
  const confirm = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      button =>
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(button.textContent), text => EffectString.trim(text)),
        ) === 'Confirm both apply',
    ),
  )!;
  expect(confirm.disabled).toBe(false);
  busy = true;
  await click('Refresh evidence');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(document.querySelector<HTMLInputElement>('input[value="both"]')?.checked).toBe(true);
  expect(document.querySelector('[aria-label="Review your choice"]')).toBe(comparison);
  expect(confirm.disabled).toBe(true);
  expect(document.body.textContent).not.toContain('/private/lock');
  busy = false;
  await click('Check current evidence');
  expect(document.querySelector<HTMLInputElement>('input[value="both"]')?.checked).toBe(true);
  expect(confirm.disabled).toBe(false);
  expect(EffectArray.filter(fetch.mock.calls, ([path]) => EffectString.endsWith('/preview')(path))).toHaveLength(1);
  expect(EffectArray.filter(fetch.mock.calls, ([path]) => EffectString.endsWith('/apply')(path))).toHaveLength(0);
});

it('never restores an old private review across bounded observation-completion and scope-change orders', async () => {
  vi.useFakeTimers();
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('busy', 'ready', 'denial'),
      fc.constantFrom('project-change', 'unmount'),
      fc.boolean(),
      async (completion, scope, finishFirst) => {
        const fixture = await privateTopicBusyFixture();
        const pending = Promise.withResolvers<Response>();
        fixture.fail(503, 'context-maintenance-busy');
        fixture.hold(pending.promise);
        let finished = false;
        const finish = async () => {
          if (finished) return;
          finished = true;
          await act(async () =>
            pending.resolve(
              completion === 'ready'
                ? fixture.ready()
                : response(
                    {code: 'context-maintenance-busy', error: 'Selected observation did not complete.'},
                    completion === 'busy' ? 503 : 403,
                  ),
            ),
          );
          await act(async () => vi.advanceTimersByTimeAsync(1500));
        };
        try {
          await click('Refresh evidence');
          expect(fixture.signal()?.aborted).toBe(false);
          if (finishFirst) {
            await finish();
            if (completion === 'denial') expect(document.body.textContent).not.toContain('PRIVATE PREPARED COMPARISON');
            else expect(document.body.textContent).toContain('PRIVATE PREPARED COMPARISON');
          }
          if (scope === 'project-change') await render(fixture.element(false, 'other'));
          else await render(<MaintenanceTaskDialog task="Current unrelated view" onClose={() => {}} />);
          if (!finishFirst) expect(fixture.signal()?.aborted).toBe(true);
          expect(document.body.textContent).not.toContain('PRIVATE PREPARED COMPARISON');
          await finish();
          expect(document.body.textContent).not.toContain('PRIVATE PREPARED COMPARISON');
          expect(document.body.textContent).not.toContain('PRIVATE SUPPORT EXCERPT');
        } finally {
          await finish();
          await render(<></>);
        }
      },
    ),
    {numRuns: 12},
  );
});

it.each(['relation', 'shared-owner-proposal'])(
  'recovers an initially busy %s case into a selected inspection-only packet',
  async family => {
    vi.useFakeTimers();
    const selected = {...item, family, slot: family === 'relation' ? 'threadnote://memory/tn_target' : 'relations'};
    const instructions = 'Selected target evidence is current; absence and repair authority remain unverified.';
    const fresh = {
      ...packet,
      family,
      evidenceRevision: 'current-selected-revision',
      reason: 'selected-relation-evidence-incomplete',
      evidence: undefined,
      instructions,
      allowedOperations: ['read_context', 'context_maintenance_packet'],
      ownerProposal:
        family === 'shared-owner-proposal'
          ? {
              proposalRevision: 'owner-revision',
              expectedContentHash: 'hash',
              selectedEdits: [],
              omittedEdits: 0,
              publication: {
                instructions: 'The shared owner must verify team authority before proposing any canonical change.',
              },
            }
          : undefined,
    };
    let busy = true;
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (EffectString.startsWith('/api/memory?')(path))
        return response({content: 'Selected canonical relation subject.'});
      if (init?.method === 'POST')
        return busy
          ? response({code: 'context-maintenance-busy', error: 'Controlled acquisition busy.'}, 503)
          : response({
              outcome: 'ready',
              item: {...selected, evidenceRevision: 'current-selected-revision'},
              packet: fresh,
            });
      return response(EffectString.includes('view=status')(path) ? maintenanceStatus([selected]) : fresh);
    });
    vi.stubGlobal('fetch', fetch);
    await render(<MaintenanceCaseDialog {...base} initialCase={selected} stale />);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(document.body.textContent).toContain('Maintenance is busy. Check current evidence to try again.');
    expect(document.body.textContent).not.toContain('Your review is kept');
    busy = false;
    await click('Check current evidence');
    expect(document.body.textContent).toContain(instructions);
    if (family === 'shared-owner-proposal')
      expect(document.body.textContent).toContain('The shared owner must verify team authority');
    const posts = EffectArray.filter(fetch.mock.calls, ([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(4);
    expect(EffectArray.every(posts, ([, init]) => JSON.parse(String(init?.body)).action === 'refresh-case')).toBe(true);
    expect(
      EffectArray.some(
        [...document.querySelectorAll<HTMLButtonElement>('button')],
        button =>
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(button.textContent), text => EffectString.trim(text)),
          ) === 'Apply update',
      ),
    ).toBe(false);
  },
);
