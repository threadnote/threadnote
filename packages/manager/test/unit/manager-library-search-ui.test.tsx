// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {LibraryExplorer} from '../../src/library_explorer.js';
import {useLibrarySearch} from '../../src/library_search.js';
import type {LibraryScope} from '../../src/library_model.js';
import type {TreeNode} from '../../src/ui/contracts.js';

const base = 'threadnote://user/test/memories';
const node = (path: string, children?: readonly TreeNode[]): TreeNode => ({
  name: path.split('/').at(-1)!,
  uri: `${base}/${path}`,
  relativePath: path,
  isDir: children !== undefined,
  children,
  isSystem: false,
  isShared: false,
});
const match = node('durable/projects/demo/opaque.md');
const hidden = node('durable/projects/demo/other.md');
const tree = node('durable', [
  node('durable/projects', [node('durable/projects/demo', [match, hidden])]),
  node('sibling.md'),
]);
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reveals a recalled memory through every collapsed ancestor while folder selection includes hidden siblings', async () => {
  const selected = vi.fn();
  const toggle = vi.fn();
  const render = (filter: string, recalledUris: readonly string[] = []) =>
    root.render(
      <LibraryExplorer
        actions={() => []}
        busy={false}
        controlsBlocked={false}
        filter={filter}
        navTreeTab="memories"
        onFilter={() => undefined}
        onRefresh={() => undefined}
        onSelect={selected}
        onShowSystem={() => undefined}
        onTab={() => undefined}
        onToggleSelection={toggle}
        selectedUris={new Set()}
        showSystem={false}
        tree={tree}
        recalledUris={recalledUris}
      />,
    );
  await act(async () => render(''));
  const folders = [...host.querySelectorAll<HTMLDetailsElement>('details')];
  expect(folders.some(folder => !folder.open)).toBe(true);
  await act(async () => render('different meaning', [match.uri]));
  expect([...host.querySelectorAll<HTMLDetailsElement>('details')].every(folder => folder.open)).toBe(true);
  expect(host.querySelectorAll('.tree-file')).toHaveLength(1);
  await act(async () => host.querySelector<HTMLButtonElement>('.tree-file')!.click());
  expect(selected).toHaveBeenCalledWith(match.uri);
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Select folder demo and all descendant memories"]')!.click(),
  );
  expect(toggle.mock.calls[0][0].children).toEqual([match, hidden]);
  const collapsed = host.querySelectorAll<HTMLDetailsElement>('details')[1];
  await act(async () => {
    collapsed.open = false;
    collapsed.dispatchEvent(new Event('toggle'));
  });
  expect(collapsed.open).toBe(false);
  await act(async () => render('another meaning', [hidden.uri]));
  expect([...host.querySelectorAll<HTMLDetailsElement>('details')].every(folder => folder.open)).toBe(true);
  expect(host.querySelector('.tree-file')?.getAttribute('title')).toBe(hidden.uri);
  await act(async () => render(''));
  expect(host.querySelectorAll('.tree-file')).toHaveLength(3);
  expect([...host.querySelectorAll<HTMLDetailsElement>('details')].some(folder => !folder.open)).toBe(true);
});

it('debounces semantic recall, isolates scopes, ignores stale responses and clears old matches immediately', async () => {
  vi.useFakeTimers();
  const pending: {url: URL; signal?: AbortSignal | null; resolve: (response: Response) => void}[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const response = Promise.withResolvers<Response>();
    pending.push({url: new URL(String(input), 'http://localhost'), signal: init?.signal, resolve: response.resolve});
    return response.promise;
  });
  function SearchState(props: {query: string; scope: LibraryScope; tree?: TreeNode}) {
    const search = useLibrarySearch(props.query, props.scope, true, props.tree);
    return <output>{JSON.stringify(search)}</output>;
  }
  const render = async (query: string, scope: LibraryScope = 'local', source?: TreeNode) => {
    await act(async () => root.render(<SearchState query={query} scope={scope} tree={source} />));
  };
  const finish = async (index: number, uri: string) =>
    act(async () =>
      pending[index].resolve(new Response(JSON.stringify({uris: [uri], semantic: 'available', warnings: []}))),
    );
  await render('old');
  await act(async () => vi.advanceTimersByTimeAsync(100));
  await render('meaning');
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(pending).toHaveLength(1);
  expect(pending[0].url.searchParams.get('query')).toBe('meaning');
  await render('new meaning', 'team:alpha');
  expect(pending[0].signal?.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(pending[1].url.searchParams.get('scope')).toBe('team:alpha');
  await finish(1, 'current');
  expect(host.textContent).toContain('current');
  await finish(0, 'stale');
  expect(host.textContent).not.toContain('stale');
  await render('new meaning', 'team:alpha', {...tree});
  expect(host.textContent).not.toContain('current');
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(pending).toHaveLength(3);
  await finish(2, 'refreshed');
  expect(host.textContent).toContain('refreshed');
  await render('');
  expect(host.textContent).not.toContain('refreshed');
  expect(host.textContent).toContain('"pending":false');
});
