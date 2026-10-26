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
  finishSlow = undefined;
  treeChildren = [source, latest];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
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
        tree: {...source, uri: base, relativePath: '', name: 'memories', isDir: true, children: treeChildren},
      });
    if (url.pathname === '/api/graphs') return json({repositories: [], builds: [], diagnostics: [], views: []});
    if (url.pathname === '/api/shares') return json({shares: [{name: 'team'}]});
    if (url.pathname === '/api/home')
      return json({version: 1, project: '', lanes: [], handoffs: [], stats: {memories: 2}});
    if (url.pathname === '/api/memory') {
      const uri = url.searchParams.get('uri')!;
      requests.push(uri);
      if (uri === source.uri) return json(record(source, markdown));
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

it('keeps expanded navigator instances on the first memory open', async () => {
  const folder = (path: string, children: readonly TreeNode[]): TreeNode => ({
    ...source,
    name: path.split('/').at(-1)!,
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
    folders.forEach(element => {
      element.open = true;
      element.dispatchEvent(new Event('toggle'));
    }),
  );
  await act(async () => button('Source').click());
  expect(host.querySelector('.library-explorer')).toBe(explorer);
  expect([...host.querySelectorAll('.library-explorer details')]).toEqual(folders);
  expect(folders.every(element => element.open)).toBe(true);
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
