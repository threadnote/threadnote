import {Array as EffectArray, Option as EffectOption} from 'effect';
import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {createWorkspaceAttributor} from '@threadnote/graph/workspace';
import type {CodeGraphWorkspace, CodeGraphWorkspaceProject} from '@threadnote/graph/languages/types';
import type {CodeGraphFileFacts, CodeGraphReference} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function project(id: string, root: string, dependencies: readonly string[] = []): CodeGraphWorkspaceProject {
  return {
    id,
    root,
    dependencies,
    buildSystem: 'node',
    dependencyDetails: [],
    diagnostics: [],
    kind: 'package',
    languages: ['typescript'],
    name: id,
    provenance: 'declared',
    resolutionDomain: 'typescript',
    sourceRoots: [root],
    workspaceId: 'workspace',
    workspaceRoots: [''],
  };
}

function attribute(
  projects: readonly CodeGraphWorkspaceProject[],
  lookupTiers: readonly (readonly string[])[],
  path = 'app/main.ts',
) {
  const workspace: CodeGraphWorkspace = {projects, diagnostics: [], fingerprint: 'fixture', workspaces: []};
  const reference: CodeGraphReference = {
    edgeId: 'edge',
    evidencePath: path,
    evidenceSpan: {line: 1, column: 1, endLine: 1, endColumn: 1},
    lookupTiers,
    provenance: 'syntactic',
    relation: 'calls',
    resolutionDomain: 'typescript',
    sourceName: 'main',
    targetName: 'value',
  };
  const facts: CodeGraphFileFacts = {path, symbols: [], edges: [], references: [reference], diagnostics: []};
  return createWorkspaceAttributor(workspace)([facts])[0].references![0].lookupTiers;
}

function pathKey(path: string, suffix = 'name:value') {
  return `typescript:path:${encodeURIComponent(path)}:${suffix}`;
}

describe('workspace reference scopes', () => {
  it('keeps exact file lookups bounded as unrelated dependencies grow', () => {
    const dependencies = Array.from({length: 16}, (_, index) => project(`dep${index}`, `packages/dep${index}`));
    const projects = [
      project(
        'app',
        'app',
        EffectArray.map(dependencies, dependency => dependency.id),
      ),
      ...dependencies,
    ];
    const key = pathKey('packages/dep0/index.ts');
    expect(attribute(projects, [[key]]).flat()).toEqual([
      Effect.pipe(key, EffectString.replace('typescript:', 'typescript:dep0:')),
    ]);
    const local = pathKey('app/local.ts', 'qualified:value:arity:2');
    expect(attribute(projects, [[local]]).flat()).toEqual([
      Effect.pipe(local, EffectString.replace('typescript:', 'typescript:app:')),
    ]);
  });

  it('uses symbol ownership for nested source roots, modules, and encoded paths', () => {
    const projects = [
      project('app', 'app', ['parent', 'nested']),
      project('parent', 'packages'),
      {...project('nested', 'elsewhere'), sourceRoots: ['packages/shared']},
    ];
    const module = `typescript:module:${encodeURIComponent('packages/shared/a:b ü.ts')}`;
    const key = pathKey('packages/shared/a:b ü.ts', 'qualified:value:implementation');
    expect(attribute(projects, [[module, key]]).flat()).toEqual([
      Effect.pipe(module, EffectString.replace('typescript:', 'typescript:nested:')),
      Effect.pipe(key, EffectString.replace('typescript:', 'typescript:nested:')),
    ]);
    expect(attribute(projects, [[pathKey('elsewhere/local.ts')]]).flat()).toEqual([
      Effect.pipe(pathKey('elsewhere/local.ts'), EffectString.replace('typescript:', 'typescript:nested:')),
    ]);
  });

  it('preserves fallback keys and does not grant access to undeclared dependencies', () => {
    const projects = [project('app', 'app', ['dependency']), project('dependency', 'dep'), project('hidden', 'hidden')];
    const unknown = [
      'typescript:name:value',
      'typescript:path:%ZZ:name:value',
      pathKey('unknown/index.ts'),
      'global:name:value',
    ];
    expect(attribute(projects, [unknown])).toEqual([
      EffectArray.map(unknown, key => Effect.pipe(key, EffectString.replace(/^typescript:/u, 'typescript:app:'))),
      EffectArray.map(unknown, key =>
        Effect.pipe(key, EffectString.replace(/^typescript:/u, 'typescript:dependency:')),
      ),
    ]);
    expect(attribute(projects, [[pathKey('hidden/index.ts')]])).toEqual([[]]);
  });

  it('preserves ordered resolution outcomes while pruning impossible scopes without mutating inputs', () => {
    FC.assert(
      FC.property(
        FC.integer({min: 1, max: 16}),
        FC.array(
          FC.array(
            FC.record({
              owner: FC.integer({min: 0, max: 18}),
              name: FC.constantFrom('a', 'b'),
              suffix: FC.constantFrom('', ':arity:1', ':implementation', ':merge-canonical'),
            }),
            {maxLength: 5},
          ),
          {maxLength: 5},
        ),
        (count, inputs) => {
          const projects = [
            project(
              'app',
              'app',
              Array.from({length: count}, (_, i) => `dep${i}`),
            ),
            ...Array.from({length: 19}, (_, i) => project(`dep${i}`, `dep${i}`)),
          ];
          const tiers = EffectArray.map(inputs, tier =>
            EffectArray.map(tier, ({owner, name, suffix}) => pathKey(`dep${owner}/index.ts`, `name:${name}${suffix}`)),
          );
          const before = structuredClone(tiers);
          const legacy = EffectArray.flatMap(tiers, tier => [
            EffectArray.map(tier, key => Effect.pipe(key, EffectString.replace('typescript:', 'typescript:app:'))),
            EffectArray.flatMap(projects.slice(1, count + 1), dependency =>
              EffectArray.map(tier, key =>
                Effect.pipe(key, EffectString.replace('typescript:', `typescript:${dependency.id}:`)),
              ),
            ),
          ]);
          const keys = new Set(
            EffectArray.flatMap(inputs, tier =>
              EffectArray.map(
                tier,
                ({owner, name, suffix}) =>
                  `typescript:dep${owner}:path:${encodeURIComponent(`dep${owner}/index.ts`)}:name:${name}${suffix}`,
              ),
            ),
          );
          const resolve = (values: readonly (readonly string[])[]) =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(
                EffectArray.map(values, tier =>
                  [
                    ...new Set(
                      EffectArray.filter(
                        tier,
                        (key, __effectArrayIndex) => __effectArrayIndex in tier && keys.has(key),
                      ),
                    ),
                  ].sort(),
                ),
                tier => tier.length > 0,
              ),
            ) ?? [];
          expect(resolve(attribute(projects, tiers))).toEqual(resolve(legacy));
          expect(tiers).toEqual(before);
          expect(attribute(projects, tiers).flat().length).toBeLessThanOrEqual(tiers.flat().length);
        },
      ),
      {numRuns: 100},
    );
  });
});
