import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';
// @vitest-environment happy-dom
import React, {act} from 'react';
import type {Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {MemoryResponse, TreeNode} from '../../src/ui/contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const roots: Root[] = [];
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
  const filename = Effect.pipe(name, EffectString.replaceAll(' ', '-'));
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
const longUri = base + '/durable/' + EffectString.repeat(80)('nested-directory/') + 'long.md';
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
  const metadata = item.metadata;
  if (!metadata) throw new Error('Memory response fixture is missing metadata.');
  return {node: item, content: body, record: {body, content: body, metadata, uri: item.uri}};
}
function parseAction(body: string): Record<string, unknown> {
  const value: unknown = JSON.parse(body);
  if (!Predicate.isObject(value)) throw new Error('Memory review action fixture must be an object.');
  return value;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}
let host: HTMLDivElement;
let requests: string[];
let semanticQueries: string[];
let showReview: boolean;
let manualSupport: boolean;
let reviewActions: Record<string, unknown>[];
let finishSlow: ((response: Response) => void) | undefined;
let treeChildren: readonly TreeNode[];

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
  requests = [];
  semanticQueries = [];
  showReview = false;
  manualSupport = false;
  reviewActions = [];
  finishSlow = undefined;
  treeChildren = [source, latest];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    // Exercise the explicit REST compatibility path in this navigation fixture.
    if (url.pathname === '/api/shares/conflicts') return json({conflicts: []});
    if (url.pathname === '/api/live-session')
      return new Response(JSON.stringify({error: 'Live unavailable in this REST fixture'}), {status: 404});
    if (url.pathname === '/api/state')
      return json({
        agents: [],
        config: {user: 'test', account: 'local', agentContextHome: '/tmp/threadnote-context'},
        autoUpdate: {effectivePolicy: 'notify'},
        updateAvailable: false,
        version: 'fixture',
      });
    if (url.pathname === '/api/tree') {
      const tree = {...source, uri: base, relativePath: '', name: 'memories', isDir: true, children: treeChildren};
      return json({resourcesTree: tree, tree});
    }
    if (url.pathname === '/api/graphs')
      return json({repositories: [], builds: [], diagnostics: [], views: [], waiterCount: 0, waiters: []});
    if (url.pathname === '/api/shares')
      return json({
        shares: [
          {
            name: 'team',
            addedAt: '2026-01-01',
            default: false,
            gitdir: '/tmp/team',
            remote: 'origin',
            version: '1',
            worktree: '/tmp/team-worktree',
          },
        ],
      });
    if (url.pathname === '/api/processes') return json({processes: [], schemaVersion: 1, truncated: false});
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
                targetHash: EffectString.repeat(64)('a'),
                coverage: {
                  outcome: 'unknown',
                  scope: 'none',
                  searchedScopes: [],
                  omittedSources: 0,
                  omittedParagraphs: 0,
                },
                paragraphs: [],
                route: 'personal-review',
                legacyUncited: false,
              },
            ]
          : [],
      });
    if (url.pathname === '/api/attention/automatic-review') {
      const action = init?.body ? parseAction(String(init.body)) : undefined;
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
        targetHash: action?.expectedContentHash ?? EffectString.repeat(64)('a'),
        evidenceRevision: EffectString.repeat(64)('a'),
        acceptedBody: markdown,
        proposal: {
          version: 2,
          kind: 'automatic',
          body: markdown,
          finalBodyHash: EffectString.repeat(64)('a'),
          changedOrdinals: [],
          draft: {
            version: 2,
            kind: 'automatic',
            purpose: 'automatic',
            targetHash: EffectString.repeat(64)('a'),
            observationRevision: EffectString.repeat(64)('a'),
            packetDigest: EffectString.repeat(64)('a'),
            outcome: 'propose-revalidation',
            operations: [],
            reviewedHandles: [],
            rationale: 'Fixture proposal.',
            unresolvedQuestions: [],
            removedClaims: [],
            paragraphDecisions: [],
          },
        },
        sourceEvidence: [],
        coverage: {outcome: 'unknown', scope: 'none', searchedScopes: [], omittedSources: 0, omittedParagraphs: 0},
        canApply: true,
        canFinishVerification: false,
        verified: false,
        approval: {
          stage: 'preview',
          reviewRevision: 2,
          approvalDigest: EffectString.repeat(64)('a'),
          contentHash: EffectString.repeat(64)('a'),
          content: 'Exact document',
          metadataDiff: [],
          reviewedSupport: {
            type: 'reviewed-memory-support',
            version: 1,
            active: {
              bodyHash: EffectString.repeat(64)('a'),
              paragraphs: [],
              sources: [],
              acceptance: {
                reviewId: 'review-links',
                approvedAt: '2026-10-23T00:00:00Z',
                targetBeforeHash: EffectString.repeat(64)('a'),
                preparationDigest: EffectString.repeat(64)('a'),
                sourceVectorDigest: EffectString.repeat(64)('a'),
              },
              digest: EffectString.repeat(64)('a'),
            },
          },
        },
      });
    }
    if (url.pathname === '/api/context-health')
      return json({
        version: 1,
        project: 'demo',
        findings: [],
        recordPreviews: [],
        limit: 100,
        omittedFindings: 0,
        recordsScanned: 1,
        repositoryEvidence: {state: 'unavailable', reason: 'repository-unavailable'},
        status: 'unknown',
        semanticCompleteness: {
          version: 2,
          state: 'partial',
          eligibleRecords: 1,
          analyzedRecords: 0,
          unknownRecords: 1,
          claimsAnalyzed: 0,
          supportedClaims: 0,
          unsupportedClaims: 0,
          coverage: 'bounded-English-extraction',
          contradictionCount: 0,
          pairsCompared: 0,
          omittedContradictions: 0,
          unknownReasons: [{reason: 'record-limit', count: 1}],
        },
        maintenance: {
          version: 2,
          actionableFindings: 0,
          affectedMemories: 0,
          automaticallyManagedFindings: 0,
          historicalFindings: 0,
          citationCoverage: {
            eligible: 0,
            checked: 0,
            deferred: 0,
            currentVerified: 0,
            historicalVerified: 0,
            unverified: 0,
            state: 'complete',
            reasons: [],
          },
          semanticCoverage: {
            version: 2,
            state: 'partial',
            eligibleRecords: 1,
            analyzedRecords: 0,
            unknownRecords: 1,
            claimsAnalyzed: 0,
            supportedClaims: 0,
            unsupportedClaims: 0,
            coverage: 'bounded-English-extraction',
            contradictionCount: 0,
            pairsCompared: 0,
            omittedContradictions: 0,
            unknownReasons: [{reason: 'record-limit', count: 1}],
          },
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
        pendingCount: showReview ? 1 : 0,
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
                candidates: [
                  {
                    candidateId: 'candidate-links',
                    categories: ['decision'],
                    comparison: 'new',
                    confidence: 0.8,
                    proposedText: 'Updated source.',
                    reason: 'Updated source',
                    recommendation: 'create',
                    state: 'pending',
                  },
                ],
              },
            ]
          : [],
      });
    if (url.pathname === '/api/library/search') {
      semanticQueries.push(url.searchParams.get('query')!);
      return json({uris: [], semantic: 'available', warnings: []});
    }
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
      if (uri === longUri) return json(record({...target, uri: longUri}, '# Long URI target body'));
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
  const found = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      item =>
        Effect.pipe(item.textContent, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
        ) === label || item.querySelector('.tree-label')?.textContent === label,
    ),
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
  const element = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...host.querySelectorAll<HTMLAnchorElement>('.markdown-viewer a')],
      item => item.textContent === label,
    ),
  )!;
  expect(element).toBeDefined();
  const event = new MouseEvent('click', {bubbles: true, cancelable: true, button: 0});
  await act(async () => {
    element.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
}

const searchInput = () => host.querySelector<HTMLInputElement>('[aria-label="Search Library"]')!;
async function setSearch(value: string) {
  await act(async () => {
    const input = searchInput();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
async function enterSearch(isComposing = false) {
  const event = new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true, isComposing});
  await act(async () => searchInput().dispatchEvent(event));
  return event;
}

it('opens entered canonical and shared alias URIs only on Enter through existing navigation', async () => {
  await openSource();
  await setSearch(`  ${target.uri}  `);
  expect(requests).toEqual([source.uri]);
  expect(host.textContent).toContain('Press Enter to open this memory.');
  expect(host.textContent).not.toContain('Semantic search is unavailable.');
  await enterSearch(true);
  expect(requests).toEqual([source.uri]);
  expect((await enterSearch()).defaultPrevented).toBe(true);
  expect(requests).toEqual([source.uri, target.uri]);
  expect(host.querySelector('.library-article')?.textContent).toContain('Target body');
  await setSearch(alias);
  await enterSearch();
  expect(requests).toEqual([source.uri, target.uri, alias]);
  expect(host.querySelector('.library-article')?.textContent).toContain('Shared target body');
  expect(button('Team').getAttribute('aria-pressed')).toBe('true');
  await act(async () => historyButton('Back').click());
  expect(host.querySelector('.library-article')?.textContent).toContain('Target body');
  expect(semanticQueries).toEqual([]);
});

it('accepts a memory URI longer than the text-query limit without truncating it', async () => {
  await openSource();
  expect(longUri.length).toBeGreaterThan(1024);
  await setSearch(longUri);
  expect(searchInput().value).toBe(longUri);
  await enterSearch();
  expect(requests).toEqual([source.uri, longUri]);
  expect(host.querySelector('.library-article')?.textContent).toContain('Long URI target body');
  expect(semanticQueries).toEqual([]);
  await setSearch(EffectString.repeat(1025)('q'));
  expect(searchInput().value).toHaveLength(1024);
});

it('preserves unsaved text when URI navigation is cancelled, then opens after discard', async () => {
  await openSource();
  await act(async () => button('Edit').click());
  const editor = host.querySelector<HTMLTextAreaElement>('[aria-label="Test editor"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '# Unsaved source');
    editor.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => button('Preview').click());
  await setSearch(alias);
  await enterSearch();
  await act(async () => button('Cancel').click());
  expect(requests).toEqual([source.uri]);
  expect(searchInput().value).toBe(alias);
  expect(host.querySelector('.library-article')?.textContent).toContain('Unsaved source');
  await enterSearch();
  await act(async () => button('Discard changes').click());
  expect(requests).toEqual([source.uri, alias]);
  expect(host.querySelector('.library-article')?.textContent).toContain('Shared target body');
});

it('clears unavailable URI content and fences a late URI response after a newer selection', async () => {
  await openSource();
  await setSearch(missing);
  await enterSearch();
  expect(host.textContent).toContain('Record unavailable until it loads.');
  expect(host.querySelector('.library-article')).toBeNull();
  await setSearch(slow.uri);
  await enterSearch();
  expect(finishSlow).toBeDefined();
  await setSearch(latest.uri);
  await enterSearch();
  expect(host.querySelector('.library-article')?.textContent).toContain('Latest body');
  await act(async () => finishSlow!(json(record(slow, '# Obsolete slow body'))));
  expect(host.textContent).not.toContain('Obsolete slow body');
  expect(requests).toEqual([source.uri, missing, slow.uri, latest.uri]);
  expect(semanticQueries).toEqual([]);
});

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

it('keeps expanded navigator instances on the first memory open', async () => {
  const folder = (path: string, children: readonly TreeNode[]): TreeNode => ({
    ...source,
    name: Effect.pipe(path, EffectString.split('/')).at(-1)!,
    uri: `${base}/${path}`,
    relativePath: path,
    isDir: true,
    children,
  });
  treeChildren = [
    folder('durable', [folder('durable/projects', [folder('durable/projects/demo', [source]), latest])]),
    latest,
  ];
  await act(async () => (await import('../../src/ui.js')).mountManager({integrations: []}));
  await act(async () => button('Library').click());
  const explorer = host.querySelector('.library-explorer');
  const folders = [...host.querySelectorAll<HTMLDetailsElement>('.library-explorer details')];
  await act(async () =>
    EffectArray.forEach(folders, element => {
      element.open = true;
      element.dispatchEvent(new Event('toggle'));
    }),
  );
  await act(async () => button('Source').click());
  expect(host.querySelector('.library-explorer')).toBe(explorer);
  expect([...host.querySelectorAll('.library-explorer details')]).toEqual(folders);
  expect(EffectArray.every(folders, element => element.open)).toBe(true);
});

function historyButton(direction: 'Back' | 'Forward'): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    `[aria-label="${direction} to ${direction === 'Back' ? 'previous' : 'next'} memory"]`,
  )!;
}

it('revisits canonical shared memories, moves both ways, and clears forward history after a new visit', async () => {
  await openSource();
  expect(historyButton('Back').disabled).toBe(true);
  await link('shared');
  await act(async () => historyButton('Back').click());
  expect(host.querySelector('.library-article')?.textContent).toContain('Source body');
  expect(button('Local').getAttribute('aria-pressed')).toBe('true');
  await act(async () => historyButton('Forward').click());
  expect(requests.at(-1)).toBe(shared.uri);
  // The response for the canonical URI is deliberately unavailable in this fixture.
  // Back remains available after a failed read and returns to the previous body.
  expect(historyButton('Back').disabled).toBe(false);
  await act(async () => historyButton('Back').click());
  await act(async () => button('Latest').click());
  expect(historyButton('Forward').disabled).toBe(true);
  expect(host.querySelector('.library-article')?.textContent).toContain('Latest body');
});

it('keeps history and unsaved text on cancel, then navigates only after draft discard', async () => {
  await openSource();
  await link('current');
  await act(async () => button('Edit').click());
  const editor = host.querySelector<HTMLTextAreaElement>('[aria-label="Test editor"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '# Unsaved target');
    editor.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await act(async () => button('Preview').click());
  await act(async () => historyButton('Back').click());
  await act(async () => button('Cancel').click());
  expect(host.querySelector('.library-article')?.textContent).toContain('Unsaved target');
  expect(historyButton('Forward').disabled).toBe(true);
  expect(requests).toEqual([source.uri, target.uri]);
  await act(async () => historyButton('Back').click());
  await act(async () => button('Discard changes').click());
  expect(host.querySelector('.library-article')?.textContent).toContain('Source body');
  expect(historyButton('Forward').disabled).toBe(false);
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
    const anchor = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...host.querySelectorAll<HTMLAnchorElement>(`.automatic-review-comparison ${selector} a`)],
        node => node.textContent === 'shared',
      ),
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
  const anchor = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...host.querySelectorAll<HTMLAnchorElement>('.automatic-review-comparison a')],
      node => node.textContent === 'missing',
    ),
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
  expect(EffectArray.map(reviewActions, action => action.action)).toEqual(['manual-preview']);
  expect(host.querySelector('.automatic-review-dialog')?.textContent).toContain('Review your memory edit');
  const follow = async () => {
    const anchor = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...host.querySelectorAll<HTMLAnchorElement>('.automatic-review-comparison a')],
        node => node.textContent === 'current',
      ),
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
  expect(EffectArray.map(reviewActions, action => action.action)).toEqual(['manual-preview']);
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
  const anchor = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...host.querySelectorAll<HTMLAnchorElement>('.automatic-review-comparison a')],
      node => node.textContent === 'current',
    ),
  )!;
  expect(anchor.getAttribute('href')).toBe(target.uri);
  await act(async () => anchor.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
  expect(requests).toEqual([source.uri, target.uri]);
  expect(host.querySelector('.automatic-review-dialog')).toBeNull();
  expect(host.querySelector('.library-article h2')?.textContent).toBe('Target');
  expect(reviewActions).toEqual([]);
});
