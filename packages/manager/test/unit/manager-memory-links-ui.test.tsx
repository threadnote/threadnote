// @vitest-environment happy-dom
import React, {act} from 'react';
import type {Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {MemoryResponse, TreeNode} from '../../src/ui/contracts.js';

const {roots} = vi.hoisted(() => ({roots: [] as Root[]}));
vi.mock('react-dom/client', async importOriginal => {
  const original = await importOriginal<typeof import('react-dom/client')>();
  return {
    ...original,
    createRoot: (...args: Parameters<typeof original.createRoot>) => {
      const root = original.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});
vi.mock('../../src/memory_editor.js', () => ({
  MemoryEditor: (props: {content: string; disabled: boolean; onChange: (value: string) => void}) => (
    <textarea
      aria-label="Test editor"
      value={props.content}
      disabled={props.disabled}
      onChange={event => props.onChange(event.target.value)}
    />
  ),
}));

const base = 'threadnote://user/test/memories';
function node(name: string, shared = false): TreeNode {
  const filename = name.replaceAll(' ', '-');
  const relativePath = shared
    ? 'shared/team/durable/projects/elsewhere/' + filename + '.md'
    : 'durable/projects/demo/' + filename + '.md';
  return {
    name: name + '.md',
    uri: base + '/' + relativePath,
    relativePath,
    isDir: false,
    isSystem: false,
    isShared: shared,
    ...(shared ? {sharedTeam: 'team'} : {}),
    metadata: {
      kind: 'durable',
      status: 'active',
      project: shared ? 'elsewhere' : 'demo',
      topic: name,
      sourceAgentClient: 'user',
      timestamp: '2026-10-23T00:00:00.000Z',
    },
  };
}
const source = node('Source');
const target = node('Target');
const shared = node('Shared target', true);
const latest = node('Latest');
const slow = node('Slow');
const alias = 'threadnote://memory/tn_shared';
const missing = 'threadnote://memory/tn_missing';
const markdown =
  'Source body\n\n**Artifacts**\n\n' +
  '- [current](' +
  target.uri +
  ')\n' +
  '- [shared](' +
  alias +
  ')\n' +
  '- [missing](' +
  missing +
  ')\n' +
  '- [slow](' +
  slow.uri +
  ')';
function record(item: TreeNode, body: string): MemoryResponse {
  return {node: item, content: body, record: {metadata: item.metadata!}} as MemoryResponse;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}
let host: HTMLDivElement;
let requests: string[];
let showReview: boolean;
let manualSupport: boolean;
let reviewActions: Record<string, unknown>[];
let finishSlow: ((response: Response) => void) | undefined;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
  requests = [];
  showReview = false;
  manualSupport = false;
  reviewActions = [];
  finishSlow = undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    // Exercise the explicit REST compatibility path in this navigation fixture.
    if (url.pathname === '/api/live-session')
      return new Response(JSON.stringify({error: 'Live unavailable in this REST fixture'}), {status: 404});
    if (url.pathname === '/api/state')
      return json({
        agents: [],
        config: {user: 'test', account: 'local'},
        autoUpdate: {effectivePolicy: 'notify'},
        version: 'fixture',
      });
    if (url.pathname === '/api/tree')
      return json({
        tree: {...source, uri: base, relativePath: '', name: 'memories', isDir: true, children: [source, latest]},
      });
    if (url.pathname === '/api/graphs') return json({repositories: [], builds: [], diagnostics: [], views: []});
    if (url.pathname === '/api/shares') return json({shares: [{name: 'team'}]});
    if (url.pathname === '/api/home')
      return json({version: 1, project: '', lanes: [], handoffs: [], stats: {memories: 2}});
    if (url.pathname === '/api/attention/automatic-memory')
      return json({
        version: 1,
        project: 'demo',
        omitted: 0,
        items: showReview
          ? [
              {
                uri: source.uri,
                title: 'Source',
                state: 'ready',
                reviewId: 'review-links',
                targetHash: 'a'.repeat(64),
                coverage: {outcome: 'unknown', scope: 'none', searchedScopes: [], omittedSources: 0},
                paragraphs: [],
                route: 'personal-review',
                legacyUncited: false,
              },
            ]
          : [],
      });
    if (url.pathname === '/api/attention/automatic-review') {
      const action = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      if (action) reviewActions.push(action);
      return json({
        version: 1,
        kind: 'automatic-memory-review',
        project: 'demo',
        reviewId: 'review-links',
        revision: 2,
        state: 'pending',
        purpose: action?.action === 'manual-preview' ? 'manual-edit' : 'automatic',
        targetUri: source.uri,
        targetHash: action?.expectedContentHash ?? 'a'.repeat(64),
        evidenceRevision: 'a'.repeat(64),
        acceptedBody: markdown,
        proposal: {body: markdown, draft: {paragraphDecisions: []}},
        sourceEvidence: [],
        coverage: {outcome: 'unknown', scope: 'none', searchedScopes: [], omittedSources: 0},
        canApply: true,
        canFinishVerification: false,
        verified: false,
        approval: {
          stage: 'preview',
          reviewRevision: 2,
          approvalDigest: 'a'.repeat(64),
          contentHash: 'a'.repeat(64),
          content: 'Exact document',
          metadataDiff: [],
        },
      });
    }
    if (url.pathname === '/api/context-health')
      return json({
        version: 1,
        project: 'demo',
        findings: [],
        recordPreviews: [],
        omittedFindings: 0,
        recordsScanned: 1,
        repositoryEvidence: {state: 'unavailable', reason: 'repository-unavailable'},
        status: 'unknown',
        semanticCompleteness: {
          version: 2,
          state: 'partial',
          eligibleRecords: 1,
          analyzedRecords: 0,
          unknownReasons: [],
        },
        maintenance: {
          version: 2,
          actionableFindings: 0,
          affectedMemories: 0,
          automaticallyManagedFindings: 0,
          historicalFindings: 0,
        },
      });
    if (url.pathname === '/api/attention/context-maintenance')
      return json({
        version: 2,
        state: 'waiting-evidence',
        generation: 'links',
        paused: false,
        projects: [],
        cases: [],
        receipts: [],
      });
    if (url.pathname === '/api/reviews')
      return json({
        version: 1,
        project: '',
        items: showReview
          ? [
              {
                kind: 'automatic-memory',
                project: 'demo',
                reviewId: 'review-links',
                revision: 2,
                topic: 'Source',
                task: 'Review Source update',
                createdAt: '2026-10-23T00:00:00Z',
                candidates: [{candidateId: 'candidate-links', state: 'pending', reason: 'Updated source'}],
              },
            ]
          : [],
      });
    if (url.pathname === '/api/memory') {
      const uri = url.searchParams.get('uri')!;
      requests.push(uri);
      if (uri === source.uri)
        return json(
          record(
            source,
            manualSupport ? 'MEMORY\nkind: durable\nreviewed_support: synthetic\n\n' + markdown : markdown,
          ),
        );
      if (uri === target.uri) return json(record(target, '# Target body'));
      if (uri === alias) return json(record(shared, '# Shared target body\n\n[self](<' + shared.uri + '>)'));
      if (uri === latest.uri) return json(record(latest, '# Latest body'));
      if (uri === slow.uri) {
        const pending = Promise.withResolvers<Response>();
        finishSlow = pending.resolve;
        return pending.promise;
      }
      return json({error: 'Memory unavailable'}, 404);
    }
    return json({});
  });
  host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    item => item.textContent?.trim() === label || item.querySelector('.tree-label')?.textContent === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
async function openSource() {
  await act(async () => {
    (await import('../../src/ui.js')).mountManager({integrations: []});
  });
  await act(async () => button('Library').click());
  await act(async () => button('Source').click());
  expect(host.querySelector('.library-article')?.textContent).toContain('Source body');
}
async function link(label: string) {
  const element = [...host.querySelectorAll<HTMLAnchorElement>('.markdown-viewer a')].find(
    item => item.textContent === label,
  )!;
  expect(element).toBeDefined();
  const event = new MouseEvent('click', {bubbles: true, cancelable: true, button: 0});
  await act(async () => {
    element.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
}

it('opens canonical and shared alias links using the accepted node even outside the tree', async () => {
  await openSource();
  await link('current');
  expect(host.querySelector('.library-article h2')?.textContent).toBe('Target');
  expect(host.querySelector('.library-article')?.textContent).toContain('Target body');
  expect(host.querySelector('[aria-label="Test editor"]')).toBeNull();
  await act(async () => button('Source').click());
  await link('shared');
  expect(host.querySelector('.library-article h2')?.textContent).toBe('Shared target');
  expect(host.querySelector('.library-article')?.textContent).toContain('Shared target body');
  expect(button('Team').getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Shared team"]')?.value).toBe('team');
  await link('self');
  expect(button('Team').getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Shared team"]')?.value).toBe('team');
  expect(requests).toEqual([source.uri, target.uri, source.uri, alias]);
});

it('keeps a previewed dirty draft on cancel and follows its link only after discard', async () => {
  await openSource();
  await act(async () => button('Edit').click());
  const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Test editor"]')!;
  const draft = markdown + '\n\nUnsaved sentence';
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, draft);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => button('Preview').click());
  await link('current');
  expect(document.querySelector('dialog')?.textContent).toContain('Discard unsaved changes?');
  await act(async () => button('Cancel').click());
  expect(requests).toEqual([source.uri]);
  expect(host.querySelector('.library-article')?.textContent).toContain('Unsaved sentence');
  await link('current');
  await act(async () => button('Discard changes').click());
  expect(requests).toEqual([source.uri, target.uri]);
  expect(host.querySelector('.library-article')?.textContent).toContain('Target body');
  expect(host.textContent).not.toContain('Unsaved sentence');
});

it('clears stale content when the linked memory is unavailable', async () => {
  await openSource();
  await link('missing');
  expect(requests).toEqual([source.uri, missing]);
  expect(host.textContent).toContain('Record unavailable until it loads.');
  expect(host.querySelector('.library-article')).toBeNull();
  expect(host.textContent).not.toContain('Source body');
});

it('does not let a late linked-memory response replace a newer selection', async () => {
  await openSource();
  await link('slow');
  expect(finishSlow).toBeDefined();
  await act(async () => button('Latest').click());
  expect(host.querySelector('.library-article')?.textContent).toContain('Latest body');
  await act(async () => finishSlow!(json(record(slow, '# Obsolete slow body'))));
  expect(host.querySelector('.library-article h2')?.textContent).toBe('Latest');
  expect(host.textContent).not.toContain('Obsolete slow body');
  expect(requests).toEqual([source.uri, slow.uri, latest.uri]);
});

it.each(['accepted', 'proposed'] as const)(
  'opens the %s automatic Library preview link through authorized memory reads',
  async part => {
    showReview = true;
    await openSource();
    await act(async () => button('Review update').click());
    const selector = part === 'accepted' ? '.memory-excerpt' : '.review-proposal-preview';
    const anchor = [...host.querySelectorAll<HTMLAnchorElement>(`.automatic-review-comparison ${selector} a`)].find(
      node => node.textContent === 'shared',
    )!;
    expect(anchor.getAttribute('href')).toBe(alias);
    await act(async () => anchor.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
    expect(requests).toEqual([source.uri, alias]);
    expect(host.querySelector('.library-article h2')?.textContent).toBe('Shared target');
    expect(host.querySelector('.automatic-review-dialog')).toBeNull();
    expect(reviewActions).toEqual([]);
  },
);

it('follows automatic Reviews preview links and clears unavailable destinations', async () => {
  showReview = true;
  await openSource();
  await act(async () => button('Reviews').click());
  const openReview = host.querySelector<HTMLButtonElement>('[data-review-id="review-links"]')!;
  await act(async () => openReview.click());
  expect(host.querySelector('.automatic-review-dialog')).not.toBeNull();
  const anchor = [...host.querySelectorAll<HTMLAnchorElement>('.automatic-review-comparison a')].find(
    node => node.textContent === 'missing',
  )!;
  await act(async () => anchor.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
  expect(requests).toEqual([source.uri, missing]);
  expect(host.querySelector('.automatic-review-dialog')).toBeNull();
  expect(host.querySelector('.library-article')).toBeNull();
  expect(host.textContent).toContain('Record unavailable until it loads.');
  expect(reviewActions).toEqual([]);
});

it('keeps the manual support review and authored draft when link navigation is cancelled', async () => {
  manualSupport = true;
  await openSource();
  await act(async () => button('Edit').click());
  const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Test editor"]')!;
  const draft = input.value + '\n\nAuthored support edit';
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, draft);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => button('Save').click());
  expect(reviewActions.map(action => action.action)).toEqual(['manual-preview']);
  expect(host.querySelector('.automatic-review-dialog')?.textContent).toContain('Review your memory edit');
  const follow = async () => {
    const anchor = [...host.querySelectorAll<HTMLAnchorElement>('.automatic-review-comparison a')].find(
      node => node.textContent === 'current',
    )!;
    expect(anchor.getAttribute('href')).toBe(target.uri);
    await act(async () => anchor.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
  };
  await follow();
  await act(async () => button('Cancel').click());
  expect(requests).toEqual([source.uri]);
  expect(host.querySelector('.automatic-review-dialog')).not.toBeNull();
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Test editor"]')?.value).toBe(draft);
  await follow();
  await act(async () => button('Discard changes').click());
  expect(requests).toEqual([source.uri, target.uri]);
  expect(host.querySelector('.automatic-review-dialog')).toBeNull();
  expect(host.querySelector('.library-article h2')?.textContent).toBe('Target');
  expect(reviewActions.map(action => action.action)).toEqual(['manual-preview']);
});

it('opens automatic Context health preview links using the same authorized Library navigation', async () => {
  showReview = true;
  await openSource();
  await act(async () => button('Context Health').click());
  const project = host.querySelector<HTMLSelectElement>('[aria-label="Workspace project"]')!;
  await act(async () => {
    project.value = 'demo';
    project.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await act(async () => button('Review update').click());
  const anchor = [...host.querySelectorAll<HTMLAnchorElement>('.automatic-review-comparison a')].find(
    node => node.textContent === 'current',
  )!;
  expect(anchor.getAttribute('href')).toBe(target.uri);
  await act(async () => anchor.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
  expect(requests).toEqual([source.uri, target.uri]);
  expect(host.querySelector('.automatic-review-dialog')).toBeNull();
  expect(host.querySelector('.library-article h2')?.textContent).toBe('Target');
  expect(reviewActions).toEqual([]);
});
