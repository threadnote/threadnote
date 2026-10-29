import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Option} from 'effect';
import {describe, expect} from 'vitest';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import {createWorkspaceAttributor} from '@threadnote/graph/workspace';

import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code graph workspace attribution', () => {
  effectIt.effect('attributes extracted Bazel facts to merged Node and Bazel components', () =>
    Effect.gen(function* () {
      const files = [
        workspaceFile('package.json', JSON.stringify({name: '@acme/app'}), 'npm-manifest'),
        workspaceFile('BUILD', 'ts_project(name = "app", deps = ["//packages/core:core"])'),
        workspaceFile('packages/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
        workspaceFile('packages/core/BUILD', 'ts_project(name = "core")'),
      ];
      const workspace = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files);
      const extracted = yield* Effect.forEach(
        EffectArray.filter(files, file => file.language === 'bazel-build'),
        file =>
          BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file, workspace.projects).pipe(
            provideTestLayer(TreeSitterRuntime.layer),
            provideTestLayer(TestSystemInfoLayer),
            provideTestLayer(BunServices.layer),
          ),
        {concurrency: 'unbounded'},
      );
      const attributed = createWorkspaceAttributor(workspace)(extracted);
      const app = Option.getOrUndefined(EffectArray.findFirst(workspace.projects, project => project.root === ''))!;
      const core = Option.getOrUndefined(
        EffectArray.findFirst(workspace.projects, project => project.root === 'packages/core'),
      )!;
      const appFacts = Option.getOrUndefined(EffectArray.findFirst(attributed, file => file.path === 'BUILD'))!;
      const coreFacts = Option.getOrUndefined(
        EffectArray.findFirst(attributed, file => file.path === 'packages/core/BUILD'),
      )!;

      expect(app).toMatchObject({buildSystem: 'node', resolutionDomain: 'typescript'});
      expect(core).toMatchObject({buildSystem: 'node', resolutionDomain: 'typescript'});
      expect(
        Option.getOrUndefined(EffectArray.findFirst(appFacts.symbols, symbol => symbol.qualifiedName === '//:app')),
      ).toMatchObject({
        packageName: '@acme/app',
        resolutionScopeId: app.id,
      });
      expect(
        Option.getOrUndefined(
          EffectArray.findFirst(coreFacts.symbols, symbol => symbol.qualifiedName === '//packages/core:core'),
        ),
      ).toMatchObject({
        packageName: '@acme/core',
        resolutionScopeId: core.id,
      });
      const references = appFacts.references;
      const lookupTiers = references
        ? EffectArray.flatMap(references, (reference, referenceIndex) => {
            if (!(referenceIndex in references)) return [];
            const tiers = reference.lookupTiers;
            return EffectArray.flatMap(tiers, (tier, tierIndex) => {
              if (!(tierIndex in tiers)) return [];
              return EffectArray.filter(tier, (_value, valueIndex) => valueIndex in tier);
            });
          })
        : undefined;
      expect(lookupTiers).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`bazel:${app.id}:`),
          expect.stringContaining(`bazel:${core.id}:`),
        ]),
      );
    }),
  );
});

function workspaceFile(path: string, content: string, language?: string): CodeGraphInventoryFile {
  const matched = BUILTIN_LANGUAGE_PACK_REGISTRY.match(path);
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}:${content.length}`,
    language: language ?? Option.getOrThrow(matched).language,
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}
