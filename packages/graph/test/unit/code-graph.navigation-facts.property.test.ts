import {deriveCachedCodeGraphFacts} from '@threadnote/graph/indexer';
import {discoverManifestWorkspace, createWorkspaceAttributor} from '@threadnote/graph/workspace';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it, afterAll, beforeAll} from 'vitest';
import type {NativeTypeScriptSession} from '@threadnote/graph/typescript_runtime';
import {
  createNativeTypeScriptTestSession,
  native,
  nativeTypeScriptUnavailable,
  skipWithoutNativeTypeScript,
} from '../helpers/native-typescript-session.js';
import {
  extractNativeFileFacts,
  extractRepositoryFacts as nativeRepositoryFacts,
  extractRepositoryFileFacts as nativeRepositoryFileFacts,
} from '@threadnote/graph/extractor';
import {
  serializeBoundedCodeGraphFact,
  budgetCachedCodeGraphFacts,
  finalCodeGraphFactBatches,
} from '@threadnote/graph/fact/budget';
import {encodeStoredCodeGraphFact, decodeStoredCodeGraphFact} from '@threadnote/graph/fact/storage';
import {sha256HexSync} from '@threadnote/platform/sha256';
// One native session serves this file; each operation has its own budget.
let session: NativeTypeScriptSession;
beforeAll(async () => {
  if (!nativeTypeScriptUnavailable) session = await createNativeTypeScriptTestSession();
});
afterAll(async () => {
  await session?.close();
});
const extractFileFacts = (file: CodeGraphInventoryFile) => extractNativeFileFacts(file, session);
const extractRepositoryFacts = (files: readonly CodeGraphInventoryFile[]) =>
  nativeRepositoryFacts(files, undefined, session);
const extractRepositoryFileFacts = (files: readonly CodeGraphInventoryFile[]) =>
  nativeRepositoryFileFacts(files, undefined, session);
const alias = fc
  .array(fc.constantFrom('a', 'b', 'c', 'd'), {minLength: 1, maxLength: 12})
  .map(value => 'persist' + EffectArray.join(value, ''));
async function extract(local: string, shadow: boolean, declaration = '') {
  const content = `import {writeFile as ${local}} from 'node:fs/promises';\nexport async function save(path: string, persist: boolean${shadow ? `, ${local}: Function` : ''}) {\n if (persist) {await ${local}(path, 'text');}\n}\n${declaration}`;
  return await extractFileFacts({
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
native(describe)('navigation proof invariants', () => {
  it('preserves exact proof across codec round trips, without mutation, while shadowing never creates a proof', async () => {
    await fc.assert(
      fc.asyncProperty(alias, async local => {
        const facts = await extract(local, false);
        const before = structuredClone(facts);
        expect(facts.navigationFacts?.proofs).toHaveLength(1);
        const encoded = encodeStoredCodeGraphFact(serializeBoundedCodeGraphFact(facts));
        expect(decodeStoredCodeGraphFact(encoded.json, facts.path).facts.navigationFacts).toEqual(
          facts.navigationFacts,
        );
        expect((await extract(local, true)).navigationFacts?.proofs).toEqual([]);
        expect(facts).toEqual(before);
      }),
      {numRuns: 80},
    );
  });
  it('never keeps proof after its owner or call anchor is budgeted away', async () => {
    await fc.assert(
      fc.asyncProperty(alias, fc.integer({min: 256, max: 6000}), async (local, cap) => {
        const facts = await extract(local, false);
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

it('incrementally updates parser-cache facts through the production derivation seam with clean source-equivalent proofs and anchors', async context => {
  skipWithoutNativeTypeScript(context);
  await fc.assert(
    fc.asyncProperty(alias, fc.boolean(), fc.boolean(), async (local, shadow, canonical) => {
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
          await extractRepositoryFileFacts(before),
          raw => [raw.path, encodeStoredCodeGraphFact(serializeBoundedCodeGraphFact(raw)).json] as const,
        ),
      );
      const changed = file('operation.ts', operation(local, shadow, canonical));
      const after = [changed, ...before.slice(1)];
      const workspace = discoverManifestWorkspace(after);
      const warmRaw = [
        await extractFileFacts(changed),
        ...EffectArray.map(
          before.slice(1),
          unchanged => decodeStoredCodeGraphFact(cached.get(unchanged.path)!, unchanged.path).facts,
        ),
      ];
      const warm = deriveCachedCodeGraphFacts(after, workspace, warmRaw);
      const clean = createWorkspaceAttributor(workspace)(await extractRepositoryFacts(after));
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

native(it)('unsupported branch control flow and loop assignment forms never strengthen canonical proof', async () => {
  await fc.assert(
    fc.asyncProperty(
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
      async (local, statement, loop, destructured) => {
        const positive = await extract(local, false);
        const text = `import {writeFile as ${local}} from 'node:fs/promises';\nexport async function save(path: string,persist: boolean) {if (persist) {${statement} await ${local}(path,'text');}}`;
        const file = async (content: string) =>
          await extractFileFacts({
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
        expect((await file(text)).navigationFacts?.proofs ?? []).toEqual([]);
        const rebound = `for (${destructured ? '{' + local + '}' : local} ${loop}) {}\nimport {writeFile as ${local}} from 'node:fs/promises';\nexport async function save(path: string,persist: boolean) {if (persist) {await ${local}(path,'text');}}`;
        expect((await file(rebound)).navigationFacts?.proofs ?? []).toEqual([]);
      },
    ),
    {numRuns: 80},
  );
});

native(it)('import-equals binding forms invalidate only conflicting canonical aliases', async () => {
  await fc.assert(
    fc.asyncProperty(
      alias,
      fc.constantFrom('', 'type ', 'export '),
      fc.boolean(),
      async (local, modifier, qualified) => {
        const declaration = (name: string) =>
          `${modifier === 'export ' ? 'export import ' : 'import ' + modifier}${name} = ${qualified ? 'Pure.persistFile' : 'require("pure")'};`;
        const baseline = await extract(local, false);
        expect(baseline.navigationFacts?.proofs).toHaveLength(1);
        expect((await extract(local, false, declaration(local))).navigationFacts).toEqual({
          version: 1,
          omitted: false,
          proofs: [],
        });
        expect((await extract(local, false, declaration('unrelated'))).navigationFacts).toEqual(
          baseline.navigationFacts,
        );
        expect((await extract(local, false, `export {pure as ${local}} from "pure";`)).navigationFacts).toEqual(
          baseline.navigationFacts,
        );
      },
    ),
    {numRuns: 80},
  );
});
