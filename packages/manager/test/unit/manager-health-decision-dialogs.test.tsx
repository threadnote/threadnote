// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {MaintenanceCaseDialog, MaintenanceTaskDialog} from '../../src/attention/maintenance_dialogs.js';
import type {ManagerContextMaintenanceCaseV2} from '../../src/attention/contracts.js';

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
    return await readPacket();
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
  expect(document.querySelector('dialog')?.textContent).toContain('run maintenance');
  failed = false;
  await click('Refresh evidence');
  expect(document.querySelector('dialog [role="alert"]')).toBeNull();
  expect(document.querySelector('dialog')?.textContent).toContain('current declaration');
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
