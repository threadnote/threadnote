import {deriveCachedCodeGraphFacts} from '@threadnote/graph/indexer';
import {discoverManifestWorkspace, createWorkspaceAttributor} from '@threadnote/graph/workspace';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {extractFileFacts, extractRepositoryFacts, extractRepositoryFileFacts} from '@threadnote/graph/extractor';
import {
  serializeBoundedCodeGraphFact,
  budgetCachedCodeGraphFacts,
  finalCodeGraphFactBatches,
} from '@threadnote/graph/fact/budget';
import {encodeStoredCodeGraphFact, decodeStoredCodeGraphFact} from '@threadnote/graph/fact/storage';
import {sha256HexSync} from '@threadnote/platform/sha256';
const alias = fc
  .array(fc.constantFrom('a', 'b', 'c', 'd'), {minLength: 1, maxLength: 12})
  .map(value => 'persist' + EffectArray.join(value, ''));
function extract(local: string, shadow: boolean, declaration = '') {
  const content = `import {writeFile as ${local}} from 'node:fs/promises';\nexport async function save(path: string, persist: boolean${shadow ? `, ${local}: Function` : ''}) {\n if (persist) {await ${local}(path, 'text');}\n}\n${declaration}`;
  return extractFileFacts({
    path: 'source.ts',
    blobId: EffectString.repeat(40)('a'),
    content,
    contentHash: sha256HexSync(content),
    language: 'typescript',
    mode: '100644',
    size: content.length,
    source: 'worktree',
  });
}
describe('navigation proof invariants', () => {
  it('preserves exact proof across codec round trips, without mutation, while shadowing never creates a proof', () => {
    fc.assert(
      fc.property(alias, local => {
        const facts = extract(local, false);
        const before = structuredClone(facts);
        expect(facts.navigationFacts?.proofs).toHaveLength(1);
        const encoded = encodeStoredCodeGraphFact(serializeBoundedCodeGraphFact(facts));
        expect(decodeStoredCodeGraphFact(encoded.json, facts.path).facts.navigationFacts).toEqual(
          facts.navigationFacts,
        );
        expect(extract(local, true).navigationFacts?.proofs).toEqual([]);
        expect(facts).toEqual(before);
      }),
      {numRuns: 80},
    );
  });
  it('never keeps proof after its owner or call anchor is budgeted away', () => {
    fc.assert(
      fc.property(alias, fc.integer({min: 256, max: 6000}), (local, cap) => {
        const facts = extract(local, false);
        const bounded = budgetCachedCodeGraphFacts(facts, cap);
        for (const proof of bounded.navigationFacts?.proofs ?? []) {
          expect(EffectArray.some(bounded.symbols, symbol => symbol.id === proof.ownerId)).toBe(true);
          expect(EffectArray.some(bounded.edges, edge => edge.id === proof.callEdgeId)).toBe(true);
        }
        const closed = EffectArray.flatten(finalCodeGraphFactBatches([{...facts, edges: []}]))[0].facts;
        expect(closed.navigationFacts?.proofs).toEqual([]);
        expect(closed.navigationFacts?.omitted).toBe(true);
      }),
      {numRuns: 80},
    );
  });
});

it('incrementally updates parser-cache facts through the production derivation seam with clean source-equivalent proofs and anchors', () => {
  fc.assert(
    fc.property(alias, fc.boolean(), fc.boolean(), (local, shadow, canonical) => {
      const file = (path: string, content: string): CodeGraphInventoryFile => ({
        path,
        content,
        blobId: EffectString.repeat(40)('a'),
        contentHash: sha256HexSync(content),
        size: new TextEncoder().encode(content).byteLength,
        mode: '100644',
        language: path === 'package.json' ? 'json' : 'typescript',
        source: 'worktree',
      });
      const operation = (name: string, hidden: boolean, recognized: boolean) =>
        `import {writeFile as ${name}} from '${recognized ? 'node:fs/promises' : 'unknown:dependency'}';\nexport async function save(path: string, persist: boolean${hidden ? `, ${name}: Function` : ''}) {if (persist) {await ${name}(path, 'value');}}\n`;
      const before = [
        file('operation.ts', operation('persistOld', false, true)),
        file('unchanged.ts', operation('persistStable', false, true)),
        file(
          'operation.test.ts',
          "import {save} from './operation.js'; export async function testSave() {await save('fixture', true);}\n",
        ),
        file('package.json', '{"name":"fixture","private":true}'),
      ];
      const cached = new Map(
        EffectArray.map(
          extractRepositoryFileFacts(before),
          raw => [raw.path, encodeStoredCodeGraphFact(serializeBoundedCodeGraphFact(raw)).json] as const,
        ),
      );
      const changed = file('operation.ts', operation(local, shadow, canonical));
      const after = [changed, ...before.slice(1)];
      const workspace = discoverManifestWorkspace(after);
      const warmRaw = [
        extractFileFacts(changed),
        ...EffectArray.map(
          before.slice(1),
          unchanged => decodeStoredCodeGraphFact(cached.get(unchanged.path)!, unchanged.path).facts,
        ),
      ];
      const warm = deriveCachedCodeGraphFacts(after, workspace, warmRaw);
      const clean = createWorkspaceAttributor(workspace)(extractRepositoryFacts(after));
      for (const expected of clean) {
        const actual = EffectArray.findFirst(warm, value => value.path === expected.path);
        expect(actual._tag).toBe('Some');
        if (actual._tag === 'None') throw new Error('Incremental derivation dropped a file');
        expect(actual.value.navigationFacts).toEqual(expected.navigationFacts);
        for (const proof of actual.value.navigationFacts?.proofs ?? []) {
          expect(EffectArray.findFirst(actual.value.symbols, symbol => symbol.id === proof.ownerId)).toEqual(
            EffectArray.findFirst(expected.symbols, symbol => symbol.id === proof.ownerId),
          );
          expect(EffectArray.findFirst(actual.value.edges, edge => edge.id === proof.callEdgeId)).toEqual(
            EffectArray.findFirst(expected.edges, edge => edge.id === proof.callEdgeId),
          );
        }
      }
      const updated = EffectArray.findFirst(warm, value => value.path === 'operation.ts');
      if (updated._tag === 'None') throw new Error('Changed source missing');
      expect(updated.value.navigationFacts?.proofs.length ?? 0).toBe(canonical && !shadow ? 1 : 0);
      expect(EffectArray.every(updated.value.symbols, symbol => symbol.contentHash === changed.contentHash)).toBe(true);
    }),
    {numRuns: 80},
  );
});

it('unsupported branch control flow and loop assignment forms never strengthen canonical proof', () => {
  fc.assert(
    fc.property(
      alias,
      fc.constantFrom(
        'return;',
        "throw new Error('blocked');",
        'for (;;) {}',
        'switch (persist) {default: break;}',
        'try {} finally {}',
      ),
      fc.constantFrom('of []', 'in {}'),
      fc.boolean(),
      (local, statement, loop, destructured) => {
        const positive = extract(local, false);
        const text = `import {writeFile as ${local}} from 'node:fs/promises';\nexport async function save(path: string,persist: boolean) {if (persist) {${statement} await ${local}(path,'text');}}`;
        const file = (content: string) =>
          extractFileFacts({
            path: 'source.ts',
            blobId: EffectString.repeat(40)('a'),
            content,
            contentHash: sha256HexSync(content),
            size: content.length,
            language: 'typescript',
            mode: '100644',
            source: 'worktree',
          });
        expect(positive.navigationFacts?.proofs).toHaveLength(1);
        expect(file(text).navigationFacts?.proofs ?? []).toEqual([]);
        const rebound = `for (${destructured ? '{' + local + '}' : local} ${loop}) {}\nimport {writeFile as ${local}} from 'node:fs/promises';\nexport async function save(path: string,persist: boolean) {if (persist) {await ${local}(path,'text');}}`;
        expect(file(rebound).navigationFacts?.proofs ?? []).toEqual([]);
      },
    ),
    {numRuns: 80},
  );
});

it('import-equals binding forms invalidate only conflicting canonical aliases', () => {
  fc.assert(
    fc.property(alias, fc.constantFrom('', 'type ', 'export '), fc.boolean(), (local, modifier, qualified) => {
      const declaration = (name: string) =>
        `${modifier === 'export ' ? 'export import ' : 'import ' + modifier}${name} = ${qualified ? 'Pure.persistFile' : 'require("pure")'};`;
      const baseline = extract(local, false);
      expect(baseline.navigationFacts?.proofs).toHaveLength(1);
      expect(extract(local, false, declaration(local)).navigationFacts).toEqual({
        version: 1,
        omitted: false,
        proofs: [],
      });
      expect(extract(local, false, declaration('unrelated')).navigationFacts).toEqual(baseline.navigationFacts);
      expect(extract(local, false, `export {pure as ${local}} from "pure";`).navigationFacts).toEqual(
        baseline.navigationFacts,
      );
    }),
    {numRuns: 80},
  );
});
