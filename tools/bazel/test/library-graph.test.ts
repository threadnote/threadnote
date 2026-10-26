import fc from 'fast-check';
import {expect, it} from 'vitest';
import {buildLibraryGraph} from '../library-graph.mjs';

type Node = {files: string[]; npm: string[]};
type Declaration = {srcs: string[]; deps: string[]; npm: string[]};
const expand = (declaration: Declaration, libraries: Map<string, Declaration>, active = new Set<string>()) => {
  const files = new Set(declaration.srcs);
  const npm = new Set(declaration.npm);
  for (const label of declaration.deps) {
    expect(active.has(label)).toBe(false);
    const child = expand(libraries.get(label)!, libraries, new Set([...active, label]));
    for (const file of child.files) files.add(file);
    for (const name of child.npm) npm.add(name);
  }
  return {files: [...files].sort(), npm: [...npm].sort()};
};
const reachable = (graph: Map<string, Node>, entries: string[]) => {
  const files = new Set<string>();
  const npm = new Set<string>();
  const pending = [...entries];
  while (pending.length) {
    const path = pending.pop()!;
    if (files.has(path)) continue;
    files.add(path);
    const node = graph.get(path)!;
    pending.push(...node.files);
    for (const name of node.npm) npm.add(name);
  }
  return {files: [...files].sort(), npm: [...npm].sort()};
};
const owner = (path: string) => path.split('/')[0];
const build = (graph: Map<string, Node>) =>
  buildLibraryGraph(graph, {owner, generatedOwner: (path: string) => path !== 'manual'});

it('keeps mixed-owner cycles and manual slices explicit while preserving outgoing libraries', () => {
  const graph = new Map<string, Node>([
    ['app/a.ts', {files: ['domain/b.ts'], npm: ['first']}],
    ['domain/b.ts', {files: ['app/a.ts', 'manual/c.ts'], npm: []}],
    ['manual/c.ts', {files: ['domain/d.ts'], npm: ['second']}],
    ['domain/d.ts', {files: [], npm: []}],
    ['app/root.ts', {files: ['app/a.ts'], npm: []}],
  ]);
  const {libraries, factor} = build(graph);
  expect(libraries.size).toBe(2);
  const expected = reachable(graph, ['app/root.ts']);
  expect(expand(factor(expected.files, expected.npm), libraries)).toEqual(expected);
  const root = [...libraries.values()].find(value => value.srcs.includes('app/root.ts'))!;
  expect(root.srcs).toEqual(['app/a.ts', 'app/root.ts', 'domain/b.ts', 'manual/c.ts']);
  expect(root.deps).toHaveLength(1);
});

it('preserves independent reachability through cycles, mutations, permutations, and excluded slices', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({min: 0, max: 7}), fc.integer({min: 0, max: 7})), {maxLength: 28}),
      fc.integer({min: 0, max: 7}),
      fc.integer({min: 0, max: 7}),
      (edges, entry, excluded) => {
        const paths = Array.from(
          {length: 8},
          (_, node) => `${node % 3 === 0 ? 'manual' : node % 2 === 0 ? 'app' : 'domain'}/${node}.ts`,
        );
        for (const mutation of [edges, [...edges, [entry, excluded]]]) {
          const graph = new Map<string, Node>(
            paths.map((path, node) => [
              path,
              {
                files: [...new Set(mutation.filter(([from]) => from === node).map(([, to]) => paths[to]))].sort(),
                npm: node % 2 === 0 ? [`npm-${node}`] : [],
              },
            ]),
          );
          const expected = reachable(graph, [paths[entry]]);
          const {libraries, factor} = build(graph);
          expect(expand(factor(expected.files, expected.npm), libraries)).toEqual(expected);
          const excludedFiles = expected.files.filter(path => path !== paths[excluded]);
          expect(expand(factor(excludedFiles, expected.npm), libraries)).toEqual({
            files: excludedFiles,
            npm: expected.npm,
          });
          expect(expand(factor(expected.files, expected.npm, [paths[excluded]]), libraries)).toEqual(expected);
          const reversed = build(
            new Map([...graph].reverse().map(([path, node]) => [path, {...node, files: [...node.files].reverse()}])),
          );
          expect([...reversed.libraries]).toEqual([...libraries]);
          expect(reversed.factor(expected.files, expected.npm)).toEqual(factor(expected.files, expected.npm));
        }
      },
    ),
    {numRuns: 75},
  );
});

it('uses stable membership identities and retains explicit boundary files and npm extras', () => {
  const graph = new Map<string, Node>([
    ['app/a.ts', {files: ['app/b.ts', 'app/package.json'], npm: ['runtime']}],
    ['app/b.ts', {files: ['app/a.ts'], npm: []}],
    ['app/package.json', {files: [], npm: []}],
  ]);
  const {libraries, factor} = build(graph);
  const expected = {files: ['app/a.ts', 'app/b.ts', 'app/package.json', 'data.json'], npm: ['extra', 'runtime']};
  const declaration = factor(expected.files, expected.npm, ['data.json']);
  expect(declaration.srcs).toEqual(['data.json']);
  expect(declaration.npm).toEqual(['extra']);
  expect(expand(declaration, libraries)).toEqual(expected);
  expect([...libraries.keys()]).toEqual([...build(new Map([...graph].reverse())).libraries.keys()]);
});

it('deduplicates shared manual diamond boundaries before expanding their parents', () => {
  const graph = new Map<string, Node>();
  for (let node = 0; node < 30; node++) {
    graph.set(`manual/${node}.ts`, {
      files: [node + 1, node + 2].filter(child => child < 30).map(child => `manual/${child}.ts`),
      npm: ['shared-npm'],
    });
  }
  graph.set('app/root.ts', {files: ['manual/0.ts'], npm: []});
  const expected = reachable(graph, ['app/root.ts']);
  expect(expected.files).toHaveLength(31);
  const {libraries, factor} = build(graph);
  expect(libraries.size).toBe(1);
  expect([...libraries.values()][0].srcs).toHaveLength(31);
  expect([...libraries.values()][0].npm).toEqual(['shared-npm']);
  expect(expand(factor(expected.files, expected.npm), libraries)).toEqual(expected);
});
