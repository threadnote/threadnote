// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {MaintenanceCaseDialog, MaintenanceTaskDialog} from '../../src/attention/maintenance_dialogs.js';
import {HealthDetail} from '../../src/attention_details.js';
import type {ManagerContextMaintenanceCaseV2} from '../../src/attention/contracts.js';
import {buildContextHealthReport} from '@threadnote/context/health';
import type {MemoryRecord} from '@threadnote/memory/document';

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
        source: {path: 'src/current.ts'},
      },
      {
        content: 'historical declaration',
        provenance: 'historical-verified',
        supportsCitation: true,
        excerptHash: 'historical',
        startLine: 1,
        source: {path: 'src/current.ts'},
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
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
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
});
async function render(node: React.ReactElement) {
  await act(async () => root.render(node));
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    value => value.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function serveCase(readPacket: () => Promise<Response>) {
  const fetch = vi.fn(async (input: string, _init?: RequestInit) => {
    if (input.startsWith('/api/memory?'))
      return response({content: 'MEMORY\nkind: durable\n\n# Stored claim\nKeep ownership explicit.'});
    if (input.includes('view=status')) return response({version: 2, cases: [item]});
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
  expect(fetch.mock.calls.every(([, init]) => init === undefined || init.method !== 'POST')).toBe(true);
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
  const semanticCase = {...item, family: 'semantic-contradiction'};
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/preview')) {
      expect(JSON.parse(init!.body as string).choice).toBe('both');
      return response({
        preview: {
          previewId: 'preview',
          revision: 'exact-revision',
          choice: 'both',
          mode: 'keep-both',
          summary: 'Both memories stay current.',
        },
      });
    }
    if (path.endsWith('/apply')) {
      expect(JSON.parse(init!.body as string)).toEqual({
        project: 'threadnote',
        previewId: 'preview',
        revision: 'exact-revision',
        approved: true,
      });
      return response({result: {status: 'applied'}});
    }
    if (path.includes('view=status')) return response({version: 2, cases: [semanticCase]});
    return response({
      ...packet,
      family: semanticCase.family,
      semanticEvidence: evidence,
      evidence: undefined,
      ownerProposal: {selectedEdits: [], publication: {instructions: 'The shared owner must review canonical edits.'}},
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
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
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
  expect(fetch.mock.calls.filter(([path]) => path.endsWith('/apply'))).toHaveLength(1);
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
      if (url.searchParams.get('view') === 'status') return response({version: 2, cases: [next ? second : item]});
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
    String(input).includes('/api/memory?')
      ? response({content: '# Stored advice'})
      : String(input).includes('view=status')
        ? response({version: 2, project: 'threadnote', cases: [item]})
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
