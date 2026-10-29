import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '@threadnote/graph/types';
import {createWorkspaceAttributor, discoverManifestWorkspace} from '@threadnote/graph/workspace';

describe('code graph hot-path scaling', () => {
  effectIt.effect(
    'keeps declaration and reference ownership near-linear through 10k Java declarations',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const durations: number[] = [];
          for (const count of [1_000, 5_000, 10_000]) {
            const methods = EffectArray.join(
              Array.from({length: count}, (_, index) => `public int method${index}() { return helper(${index}); }`),
              '\n',
            );
            const content = `package bench; public class Scale { public int helper(int value) { return value; }\n${methods} }`;
            const startedAt = performance.now();
            const facts = yield* runExtraction(inventoryFile('src/main/java/bench/Scale.java', content, 'java'));
            durations.push(performance.now() - startedAt);

            expect(EffectArray.filter(facts.symbols, symbol => symbol.kind === 'method')).toHaveLength(count + 1);
            expect(
              EffectArray.filter(facts.edges, edge => edge.relation === 'calls' && edge.targetName === 'helper'),
            ).toHaveLength(count);
            expect(
              EffectOption.getOrUndefined(
                EffectArray.findFirst(
                  facts.edges,
                  edge => edge.targetName === `method${count - 1}` && edge.relation === 'contains',
                ),
              ),
            ).toMatchObject({sourceName: 'Scale'});
          }

          const fiveThousand = durations[1];
          const tenThousand = durations[2];
          expect(tenThousand).toBeLessThan(5_000);
          expect(tenThousand).toBeLessThan(fiveThousand * 3 + 1_000);
        }),
      ),
    20_000,
  );

  it('discovers and attributes 5k Gradle modules without files-by-project scans', () => {
    const moduleCount = 5_000;
    const modulePaths = Array.from({length: moduleCount}, (_, index) => `:modules:m${index}`);
    const files: CodeGraphInventoryFile[] = [
      inventoryFile(
        'settings.gradle.kts',
        `rootProject.name = "scale"\ninclude(${EffectArray.join(
          EffectArray.map(modulePaths, value => `"${value}"`),
          ',',
        )})`,
        'gradle',
      ),
    ];
    for (let index = 0; index < moduleCount; index += 1) {
      files.push(
        inventoryFile(`modules/m${index}/build.gradle.kts`, '', 'gradle'),
        inventoryFile(`modules/m${index}/src/main/java/Module${index}.java`, `class Module${index} {}`, 'java'),
      );
    }

    const discoveryStartedAt = performance.now();
    const workspace = discoverManifestWorkspace(files);
    const discoveryDuration = performance.now() - discoveryStartedAt;
    const facts = Array.from({length: moduleCount}, (_, index) => workspaceFact(index));
    const attributionStartedAt = performance.now();
    const attributed = createWorkspaceAttributor(workspace)(facts);
    const attributionDuration = performance.now() - attributionStartedAt;

    expect(workspace.projects).toHaveLength(moduleCount + 1);
    expect(attributed[0].symbols[0].packageName).toBe('m0');
    expect(attributed.at(-1)!.symbols[0].packageName).toBe(`m${moduleCount - 1}`);
    expect(discoveryDuration).toBeLessThan(5_000);
    expect(attributionDuration).toBeLessThan(5_000);
  }, 20_000);
});

function runExtraction(file: CodeGraphInventoryFile) {
  return BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file).pipe(
    provideTestLayer(TreeSitterRuntime.layer),
    provideTestLayer(TestSystemInfoLayer),
    provideTestLayer(BunServices.layer),
  );
}

function inventoryFile(path: string, content: string, language: string): CodeGraphInventoryFile {
  return {
    blobId: `blob-${path}`,
    content,
    contentHash: Bun.hash(content).toString(16),
    language,
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}

function workspaceFact(index: number): CodeGraphFileFacts {
  const path = `modules/m${index}/src/main/java/Module${index}.java`;
  const symbol: CodeGraphSymbol = {
    contentHash: `hash-${index}`,
    exported: true,
    id: `symbol-${index}`,
    kind: 'class',
    language: 'java',
    lookupKeys: [`jvm:name:Module${index}`],
    name: `Module${index}`,
    path,
    qualifiedName: `Module${index}`,
    resolutionDomain: 'jvm',
    span: {column: 1, endColumn: 1, endLine: 1, line: 1},
  };
  return {diagnostics: [], edges: [], path, symbols: [symbol]};
}
