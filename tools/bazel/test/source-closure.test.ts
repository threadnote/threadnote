import {createTypeScriptSyntaxSession, type TypeScriptSyntaxSession} from '../../workspace/typescript-syntax.js';
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {expect, it, afterAll} from 'vitest';
import {collectSourceClosure, sourceImports} from '../source-closure.mjs';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
const collect = async (files: Record<string, string>, entries = ['src/0.ts'], workspaces = new Map()) =>
  await collectSourceClosure(await getSyntaxSession(), entries, {
    read: (path: string) => files[path],
    exists: (path: string) => path in files,
    workspaces,
  });
it('scopes editor-supplied modules to the declared fixture host', async () => {
  const files: Record<string, string> = {'fixture/probe.cjs': "require('vscode');", 'src/app.ts': "import 'vscode';"};
  const options = {
    read: (path: string) => files[path],
    exists: (path: string) => path in files,
    workspaces: new Map(),
    hostModules: {'fixture/probe.cjs': ['vscode']},
  };
  expect(await collectSourceClosure(await getSyntaxSession(), ['fixture/probe.cjs'], options)).toEqual({
    files: ['fixture/probe.cjs'],
    npm: [],
  });
  expect((await collectSourceClosure(await getSyntaxSession(), EffectRecord.keys(files), options)).npm).toEqual([
    'vscode',
  ]);
});
it('retains namespace dependencies after interpolated templates', async () => {
  const files = {
    'src/0.ts': 'const label = `${1}`; export * as ns from "./1.js";',
    'src/1.ts': 'import "runtime-npm"; export const value = 1;',
  };
  expect(await collect(files)).toEqual({files: ['src/0.ts', 'src/1.ts'], npm: ['runtime-npm']});
  await fc.assert(
    fc.asyncProperty(
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
      async prefixes => {
        expect(
          await sourceImports(
            await getSyntaxSession(),
            'file.ts',
            `${EffectArray.join(prefixes, '\n')}\nexport * as ns from './value.js';`,
          ),
        ).toEqual(['./value.js']);
      },
    ),
    {numRuns: 50},
  );
});
it('recognizes namespace exports across arbitrary bounded trivia', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(' ', '\t', '\n', '/**/', '/* *//* */', '// comment\n'), {
        minLength: 1,
        maxLength: 8,
      }),
      async trivia => {
        expect(
          await sourceImports(
            await getSyntaxSession(),
            'file.ts',
            `export${EffectArray.join(trivia, '')}* as domain from './value.js';`,
          ),
        ).toEqual(['./value.js']);
      },
    ),
    {numRuns: 50},
  );
  expect(
    await sourceImports(
      await getSyntaxSession(),
      'file.ts',
      `export ${Effect.pipe('/* *//* */', EffectString.repeat(2000))}const value = 1;`,
    ),
  ).toEqual([]);
});
it('follows source additions, removals, and changed import edges', async () => {
  const files = {'src/0.ts': 'export const first = 1;', 'src/1.ts': 'export const second = 2;'};
  expect((await collect(files)).files).toEqual(['src/0.ts']);
  files['src/0.ts'] = 'export {second} from "./1.js";';
  expect((await collect(files)).files).toEqual(['src/0.ts', 'src/1.ts']);
  await expect(collect({'src/0.ts': files['src/0.ts']})).rejects.toThrow('Unresolved source input');
  expect(
    await sourceImports(
      await getSyntaxSession(),
      'file.ts',
      'const text = "import fake from \'bad\'"; import good from "good";',
    ),
  ).toEqual(['good']);
});
it('resolves explicit private exports and rejects missing exports', async () => {
  const workspace = {path: 'packages/domain', manifest: {exports: {'./value': './src/value.ts'}}};
  const files = {
    'src/0.ts': 'import {value} from "@threadnote/domain/value";',
    'packages/domain/src/value.ts': 'export const value = 1;',
    'packages/domain/package.json': '{}',
  };
  expect((await collect(files, ['src/0.ts'], new Map([['@threadnote/domain', workspace]]))).files).toEqual([
    'packages/domain/package.json',
    'packages/domain/src/value.ts',
    'src/0.ts',
  ]);
  await expect(
    collect(
      {...files, 'src/0.ts': 'import "@threadnote/domain/missing";'},
      ['src/0.ts'],
      new Map([['@threadnote/domain', workspace]]),
    ),
  ).rejects.toThrow('workspace export');
});
it('matches a bounded graph model and ignores input enumeration order', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.tuple(fc.integer({min: 0, max: 7}), fc.integer({min: 0, max: 7})), {maxLength: 24}),
      async edges => {
        const files = EffectRecord.fromEntries(
          Array.from({length: 8}, (_, node) => [
            `src/${node}.ts`,
            EffectArray.join(
              EffectArray.map(
                EffectArray.filter(edges, ([from]) => from === node),
                ([, to]) => `import "./${to}.js";`,
              ),
              '\n',
            ),
          ]),
        );
        const reachable = new Set([0]);
        for (let count = 0; count < 8; count++)
          for (const [from, to] of edges) if (reachable.has(from)) reachable.add(to);
        const expected = EffectArray.map([...reachable], node => `src/${node}.ts`).sort();
        expect((await collect(files)).files).toEqual(expected);
        expect((await collect(EffectRecord.fromEntries(EffectRecord.toEntries(files).reverse()))).files).toEqual(
          expected,
        );
      },
    ),
    {numRuns: 50},
  );
});
it('exposes resolved direct edges from the closure resolver without changing its result shape', async () => {
  const files: Record<string, string> = {
    'src/root.ts':
      'export * as domain from "@threadnote/domain/value"; import "virtual:test"; import "node:fs"; import "left-pad";',
    'packages/domain/src/value.ts': 'export {value} from "./other.js";',
    'packages/domain/src/other.ts': 'export const value = 1;',
    'packages/domain/package.json': '{}',
  };
  const graph = new Map();
  const result = await collectSourceClosure(await getSyntaxSession(), ['src/root.ts'], {
    read: (path: string) => files[path],
    exists: (path: string) => path in files,
    workspaces: new Map([
      ['@threadnote/domain', {path: 'packages/domain', manifest: {exports: {'./value': './src/value.ts'}}}],
    ]),
    virtualModules: ['virtual:test'],
    graph,
  });
  expect(EffectRecord.keys(result).sort()).toEqual(['files', 'npm']);
  expect(result.npm).toEqual(['left-pad']);
  expect(graph.get('src/root.ts')).toEqual({
    files: ['packages/domain/package.json', 'packages/domain/src/value.ts'],
    npm: ['left-pad'],
  });
  expect(graph.get('packages/domain/src/value.ts')).toEqual({files: ['packages/domain/src/other.ts'], npm: []});
  expect(graph.get('packages/domain/package.json')).toEqual({files: [], npm: []});
});
it('reuses direct edges only within a fixed model across shared entry closures', async () => {
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
    imports: async (path: string, content: string) => {
      imports.set(path, (imports.get(path) ?? 0) + 1);
      return await sourceImports(await getSyntaxSession(), path, content);
    },
    workspaces,
    virtualModules: ['virtual:test'],
    graph,
  };
  const first = await collectSourceClosure(await getSyntaxSession(), ['src/first.ts'], options);
  const snapshot = {reads: new Map(reads), resolutions: new Map(resolutions), imports: new Map(imports)};
  const second = await collectSourceClosure(await getSyntaxSession(), ['src/second.ts'], options);
  const fresh = async (entry: string) =>
    await collectSourceClosure(await getSyntaxSession(), [entry], {
      read: (path: string) => files[path],
      exists: (path: string) => path in files,
      workspaces,
      virtualModules: ['virtual:test'],
    });
  expect(first).toEqual(await fresh('src/first.ts'));
  expect(second).toEqual(await fresh('src/second.ts'));
  expect(EffectRecord.keys(second).sort()).toEqual(['files', 'npm']);
  expect(second.npm).toEqual(['runtime-npm']);
  for (const path of ['packages/domain/src/value.ts', 'packages/domain/src/leaf.ts', 'packages/domain/package.json']) {
    expect(reads.get(path)).toBe(snapshot.reads.get(path));
    expect(resolutions.get(path)).toBe(snapshot.resolutions.get(path));
    expect(imports.get(path)).toBe(snapshot.imports.get(path));
    expect(resolutions.get(path)).toBe(1);
  }
  expect(resolutions.get('packages/domain/src/leaf.js')).toBe(1);
});

// One npm TypeScript syntax child serves this whole file and is closed once.
let syntaxSession: TypeScriptSyntaxSession | undefined;
afterAll(async () => {
  await syntaxSession?.close();
});
function getSyntaxSession(): Promise<TypeScriptSyntaxSession> {
  return Promise.resolve((syntaxSession ??= createTypeScriptSyntaxSession({cwd: process.cwd()})));
}
