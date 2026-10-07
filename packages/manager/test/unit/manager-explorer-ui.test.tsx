// @vitest-environment happy-dom
import React, {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {LibraryExplorer} from '../../src/library_explorer.js';
import {toggleMemorySelection} from '../../src/library_model.js';
import type {TreeNode} from '../../src/ui/contracts.js';

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

it('connects a filtered folder checkbox to every descendant and renders a partial state', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  const leaf = (name: string): TreeNode => ({
    name,
    uri: `threadnote://user/test/memories/project/${name}`,
    relativePath: `project/${name}`,
    isDir: false,
    isShared: false,
    isSystem: false,
  });
  const a = leaf('visible.md');
  const b = leaf('hidden.md');
  const tree: TreeNode = {...leaf('project'), isDir: true, children: [a, b]};
  const onSelect = vi.fn();
  let selected: ReadonlySet<string> = new Set();
  let setFilter!: (value: string) => void;
  function Fixture() {
    const [selection, setSelection] = useState(selected);
    const [filter, updateFilter] = useState('visible');
    setFilter = updateFilter;
    selected = selection;
    return (
      <LibraryExplorer
        busy={false}
        controlsBlocked={false}
        filter={filter}
        onFilter={updateFilter}
        navTreeTab="memories"
        onTab={() => undefined}
        tree={tree}
        selectedUris={selection}
        showSystem={false}
        onShowSystem={() => undefined}
        onRefresh={() => undefined}
        onSelect={onSelect}
        actions={() => []}
        onToggleSelection={(node, checked) => setSelection(current => toggleMemorySelection(current, node, checked))}
      />
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Fixture />));
  const folder = () =>
    container.querySelector<HTMLInputElement>('[aria-label="Select folder project and all descendant memories"]')!;
  await act(async () => folder().click());
  expect(selected).toEqual(new Set([a.uri, b.uri]));
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => setFilter('hidden'));
  expect(selected.size).toBe(2);
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Select hidden.md"]')?.click());
  expect(selected).toEqual(new Set([a.uri]));
  expect(folder().indeterminate).toBe(true);
});

it('blocks resource actions while the Manager is disconnected or performing a mutation', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  const resource: TreeNode = {
    name: 'reference.md',
    uri: 'threadnote://resources/reference.md',
    relativePath: 'reference.md',
    isDir: false,
    isShared: false,
    isSystem: false,
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <LibraryExplorer
        actions={() => [{label: 'Remove indexed copy', onSelect: vi.fn()}]}
        busy={false}
        controlsBlocked={true}
        filter=""
        navTreeTab="resources"
        onFilter={() => undefined}
        onRefresh={() => undefined}
        onSelect={() => undefined}
        onShowSystem={() => undefined}
        onTab={() => undefined}
        onToggleSelection={() => undefined}
        resourceTree={resource}
        selectedUris={new Set()}
        showSystem={false}
      />,
    ),
  );
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Actions for reference.md"]')?.disabled).toBe(true);
});
