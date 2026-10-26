import fc from 'fast-check';
import {expect, it} from 'vitest';
import {collectSourceClosure, sourceImports} from '../source-closure.mjs';

const collect = (files: Record<string, string>, entries = ['src/0.ts'], workspaces = new Map()) =>
  collectSourceClosure(entries, {
    read: (path: string) => files[path],
    exists: (path: string) => path in files,
    workspaces,
  });

it('retains namespace dependencies after interpolated templates', () => {
  const files = {
    'src/0.ts': 'const label = `${1}`; export * as ns from "./1.js";',
    'src/1.ts': 'import "runtime-npm"; export const value = 1;',
  };
  expect(collect(files)).toEqual({files: ['src/0.ts', 'src/1.ts'], npm: ['runtime-npm']});
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          '`${1}`;',
          '`outer ${`inner ${1}`}`;',
          '`outer ${{value: `inner ${2}`}.value}`;',
          'String.raw`tagged ${1}`;',
          '/[`}]/.test("}");',
          '"export * as fake from \'fake\'";',
          '/* export * as fake from "fake" */',
        ),
        {maxLength: 8},
      ),
      prefixes => {
        expect(sourceImports('file.ts', `${prefixes.join('\n')}\nexport * as ns from './value.js';`)).toEqual([
          './value.js',
        ]);
      },
    ),
    {numRuns: 50},
  );
});

it('recognizes namespace exports across arbitrary bounded trivia', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(' ', '\t', '\n', '/**/', '/* *//* */', '// comment\n'), {
        minLength: 1,
        maxLength: 8,
      }),
      trivia => {
        expect(sourceImports('file.ts', `export${trivia.join('')}* as domain from './value.js';`)).toEqual([
          './value.js',
        ]);
      },
    ),
    {numRuns: 50},
  );
  expect(sourceImports('file.ts', `export ${'/* *//* */'.repeat(2_000)}const value = 1;`)).toEqual([]);
});

it('follows source additions, removals, and changed import edges', () => {
  const files = {'src/0.ts': 'export const first = 1;', 'src/1.ts': 'export const second = 2;'};
  expect(collect(files).files).toEqual(['src/0.ts']);
  files['src/0.ts'] = 'export {second} from "./1.js";';
  expect(collect(files).files).toEqual(['src/0.ts', 'src/1.ts']);
  expect(() => collect({'src/0.ts': files['src/0.ts']})).toThrow('Unresolved source input');
  expect(sourceImports('file.ts', 'const text = "import fake from \'bad\'"; import good from "good";')).toEqual([
    'good',
  ]);
});

it('resolves explicit private exports and rejects missing exports', () => {
  const workspace = {path: 'packages/domain', manifest: {exports: {'./value': './src/value.ts'}}};
  const files = {
    'src/0.ts': 'import {value} from "@threadnote/domain/value";',
    'packages/domain/src/value.ts': 'export const value = 1;',
    'packages/domain/package.json': '{}',
  };
  expect(collect(files, ['src/0.ts'], new Map([['@threadnote/domain', workspace]])).files).toEqual([
    'packages/domain/package.json',
    'packages/domain/src/value.ts',
    'src/0.ts',
  ]);
  expect(() =>
    collect(
      {...files, 'src/0.ts': 'import "@threadnote/domain/missing";'},
      ['src/0.ts'],
      new Map([['@threadnote/domain', workspace]]),
    ),
  ).toThrow('workspace export');
});

it('matches a bounded graph model and ignores input enumeration order', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({min: 0, max: 7}), fc.integer({min: 0, max: 7})), {maxLength: 24}),
      edges => {
        const files = Object.fromEntries(
          Array.from({length: 8}, (_, node) => [
            `src/${node}.ts`,
            edges
              .filter(([from]) => from === node)
              .map(([, to]) => `import "./${to}.js";`)
              .join('\n'),
          ]),
        );
        const reachable = new Set([0]);
        for (let count = 0; count < 8; count++)
          for (const [from, to] of edges) if (reachable.has(from)) reachable.add(to);
        const expected = [...reachable].map(node => `src/${node}.ts`).sort();
        expect(collect(files).files).toEqual(expected);
        expect(collect(Object.fromEntries(Object.entries(files).reverse())).files).toEqual(expected);
      },
    ),
    {numRuns: 50},
  );
});

it('exposes resolved direct edges from the closure resolver without changing its result shape', () => {
  const files: Record<string, string> = {
    'src/root.ts':
      'export * as domain from "@threadnote/domain/value"; import "virtual:test"; import "node:fs"; import "left-pad";',
    'packages/domain/src/value.ts': 'export {value} from "./other.js";',
    'packages/domain/src/other.ts': 'export const value = 1;',
    'packages/domain/package.json': '{}',
  };
  const graph = new Map();
  const result = collectSourceClosure(['src/root.ts'], {
    read: (path: string) => files[path],
    exists: (path: string) => path in files,
    workspaces: new Map([
      ['@threadnote/domain', {path: 'packages/domain', manifest: {exports: {'./value': './src/value.ts'}}}],
    ]),
    virtualModules: ['virtual:test'],
    graph,
  });
  expect(Object.keys(result).sort()).toEqual(['files', 'npm']);
  expect(result.npm).toEqual(['left-pad']);
  expect(graph.get('src/root.ts')).toEqual({
    files: ['packages/domain/package.json', 'packages/domain/src/value.ts'],
    npm: ['left-pad'],
  });
  expect(graph.get('packages/domain/src/value.ts')).toEqual({files: ['packages/domain/src/other.ts'], npm: []});
  expect(graph.get('packages/domain/package.json')).toEqual({files: [], npm: []});
});

it('reuses direct edges only within a fixed model across shared entry closures', () => {
  const files: Record<string, string> = {
    'src/first.ts': 'import "@threadnote/domain/value";',
    'src/second.ts': 'import "@threadnote/domain/value";',
    'packages/domain/src/value.ts': 'import "./leaf.js"; import "virtual:test"; import "runtime-npm";',
    'packages/domain/src/leaf.ts': 'export const leaf = 1;',
    'packages/domain/package.json': '{}',
  };
  const workspaces = new Map([
    [
      '@threadnote/domain',
      {
        path: 'packages/domain',
        manifest: {exports: {'./value': './src/value.ts'}},
      },
    ],
  ]);
  const reads = new Map<string, number>();
  const resolutions = new Map<string, number>();
  const imports = new Map<string, number>();
  const graph = new Map();
  const options = {
    read: (path: string) => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return files[path];
    },
    exists: (path: string) => {
      resolutions.set(path, (resolutions.get(path) ?? 0) + 1);
      return path in files;
    },
    imports: (path: string, content: string) => {
      imports.set(path, (imports.get(path) ?? 0) + 1);
      return sourceImports(path, content);
    },
    workspaces,
    virtualModules: ['virtual:test'],
    graph,
  };
  const first = collectSourceClosure(['src/first.ts'], options);
  const snapshot = {reads: new Map(reads), resolutions: new Map(resolutions), imports: new Map(imports)};
  const second = collectSourceClosure(['src/second.ts'], options);
  const fresh = (entry: string) =>
    collectSourceClosure([entry], {
      read: (path: string) => files[path],
      exists: (path: string) => path in files,
      workspaces,
      virtualModules: ['virtual:test'],
    });
  expect(first).toEqual(fresh('src/first.ts'));
  expect(second).toEqual(fresh('src/second.ts'));
  expect(Object.keys(second).sort()).toEqual(['files', 'npm']);
  expect(second.npm).toEqual(['runtime-npm']);
  for (const path of ['packages/domain/src/value.ts', 'packages/domain/src/leaf.ts', 'packages/domain/package.json']) {
    expect(reads.get(path)).toBe(snapshot.reads.get(path));
    expect(resolutions.get(path)).toBe(snapshot.resolutions.get(path));
    expect(imports.get(path)).toBe(snapshot.imports.get(path));
    expect(resolutions.get(path)).toBe(1);
  }
  expect(resolutions.get('packages/domain/src/leaf.js')).toBe(1);
});
