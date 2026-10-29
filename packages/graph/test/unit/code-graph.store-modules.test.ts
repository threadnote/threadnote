import {Array as EffectArray} from 'effect';
import {readdirSync, readFileSync} from '@threadnote/testing/node-fs';
import {join, posix, relative, sep} from '@threadnote/testing/node-path';
import {describe, expect, it} from 'vitest';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const GRAPH_SOURCE_DIRECTORY = join(import.meta.dirname, '../../src');
const STORE_DIRECTORY = join(GRAPH_SOURCE_DIRECTORY, 'store');
const STORE_IMPORT_PATTERN = /\b(?:from|import)\s+['"](\.[^'"]+)['"]/gu;

function typeScriptFilesBelow(directory: string): readonly string[] {
  return EffectArray.flatMap(readdirSync(directory, {withFileTypes: true}), entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFilesBelow(path);
    return Effect.pipe(entry.name, EffectString.endsWith('.ts')) ? [path] : [];
  });
}

function storeModules(): ReadonlyMap<string, string> {
  return new Map(
    EffectArray.map(
      EffectArray.map([join(GRAPH_SOURCE_DIRECTORY, 'store.ts'), ...typeScriptFilesBelow(STORE_DIRECTORY)], path =>
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
        EffectArray.join(relative(GRAPH_SOURCE_DIRECTORY, path).split(sep), '/'),
      ).sort(),
      name => [name, readFileSync(join(GRAPH_SOURCE_DIRECTORY, name), 'utf8')],
    ),
  );
}

function storeModuleDependencies(modules: ReadonlyMap<string, string>): ReadonlyMap<string, readonly string[]> {
  return new Map(
    EffectArray.map([...modules], ([name, source]) => [
      name,
      EffectArray.filter(
        EffectArray.map([...Effect.pipe(source, EffectString.matchAll(STORE_IMPORT_PATTERN))], match =>
          posix.normalize(
            posix.join(posix.dirname(name), Effect.pipe(match[1], EffectString.replace(/\.js$/u, '.ts'))),
          ),
        ),
        dependency => modules.has(dependency),
      ),
    ]),
  );
}

describe('code graph Store module boundaries', () => {
  it('keeps the Store module graph acyclic', () => {
    const modules = storeModules();
    const dependencies = storeModuleDependencies(modules);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const cycles: string[][] = [];

    const visit = (module: string): void => {
      if (visiting.has(module)) {
        const cycleStart = path.indexOf(module);
        cycles.push([...path.slice(cycleStart), module]);
        return;
      }
      if (visited.has(module)) return;
      visiting.add(module);
      path.push(module);
      for (const dependency of dependencies.get(module) ?? []) visit(dependency);
      path.pop();
      visiting.delete(module);
      visited.add(module);
    };

    for (const module of modules.keys()) visit(module);
    expect(cycles).toEqual([]);
  });
});
