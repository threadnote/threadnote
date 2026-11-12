import {parseCodeGraphCheckpointRecordV1} from '@threadnote/graph/checkpoint/schema';
import {codeGraphCheckpointFileFactCacheIdentity} from '@threadnote/graph/checkpoint/file_fact_identity';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Effect, Layer, Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  captureBodyDiscovery,
  validateBodyDiscovery,
  closeBodyDiscovery,
  BODY_DISCOVERY_POLICY,
  BODY_DISCOVERY_PREFIX,
} from '@threadnote/graph/languages/body_discovery';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, packCacheIdentity} from '@threadnote/graph/languages/registry';
import {codeGraphLanguagePack} from '@threadnote/graph/languages/typescript/pack';
import {
  extractStructuredSchemaFacts,
  relocateStructuredSchemaFacts,
} from '@threadnote/graph/languages/schemas/extractor';
import {NAVIGATION_PROOF_CACHE_IDENTITY} from '@threadnote/graph/query/navigation_facts';
import {serializeBoundedCodeGraphFact, budgetCachedCodeGraphFacts} from '@threadnote/graph/fact/budget';
import {encodeStoredCodeGraphFact, decodeStoredCodeGraphFact} from '@threadnote/graph/fact/storage';
import {preparedSymbolTerms, symbolTerms} from '@threadnote/graph/store/utilities';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSpan} from '@threadnote/graph/types';
import {FileSystem, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {CodeGraphStore} from '@threadnote/graph/store';
import {claimPersistentBuildForTest} from '../helpers/code-graph-build.js';

export function bodyFile(content: string, path = 'a.ts'): CodeGraphInventoryFile {
  return {
    blobId: EffectString.repeat(40)('b'),
    content,
    contentHash: sha256HexSync(content),
    path,
    mode: '100644',
    language: 'typescript',
    size: Buffer.byteLength(content),
    source: 'worktree',
  };
}
export function ownerFacts(file: CodeGraphInventoryFile, spans: readonly CodeGraphSpan[]): CodeGraphFileFacts {
  return {
    path: file.path,
    edges: [],
    diagnostics: [],
    symbols: EffectArray.map(spans, (span, i) => ({
      id: `cgs_${EffectString.padStart(32, '0')(i.toString(16))}`,
      path: file.path,
      contentHash: file.contentHash,
      kind: 'function',
      name: `f${i}`,
      qualifiedName: `f${i}`,
      language: file.language,
      exported: true,
      span,
    })),
  };
}
it('keeps ownerless structured facts relocatable without adding private body evidence', () => {
  const file = {...bodyFile('{"message":"pending"}\n', 'a.json'), language: 'json'};
  const extracted = extractStructuredSchemaFacts(file, {packageName: Option.none(), project: Option.none()});
  const facts: CodeGraphFileFacts = {
    ...extracted,
    derivationInputs: {
      rationale: [{documentation: 'Retained rationale', line: 1, marker: 'WHY', name: 'message'}],
    },
  };
  const before = JSON.stringify([file, facts]);
  const captured = captureBodyDiscovery(file, facts);
  const donor = serializeBoundedCodeGraphFact(captured).facts;
  const relocated = relocateStructuredSchemaFacts({...file, path: 'b.json'}, donor)!;
  expect(relocated).toBeDefined();
  expect(serializeBoundedCodeGraphFact(relocated).facts.path).toBe('b.json');
  expect(captureBodyDiscovery(file, extracted).derivationInputs).toBeUndefined();
  expect(captured.derivationInputs?.bodyDiscovery).toBeUndefined();
  expect(captured.derivationInputs).toBe(facts.derivationInputs);
  expect(donor.derivationInputs?.rationale).toEqual(facts.derivationInputs?.rationale);
  expect(relocated.derivationInputs?.rationale).toEqual(facts.derivationInputs?.rationale);
  expect(JSON.stringify([file, facts])).toBe(before);
});
it('charges one monotonic UTF16 locator plus each overlapping UTF8 window and retains no source', () => {
  const file = bodyFile('é\r\nfunction f() { "pending items"; }\n');
  const span = {line: 2, column: 1, endLine: 2, endColumn: 34};
  const facts = ownerFacts(file, [span, span]);
  const captured = captureBodyDiscovery(file, facts);
  const body = captured.derivationInputs!.bodyDiscovery!;
  expect(body.workBytes).toBe(
    Buffer.byteLength('é\r\n') + 4 * Buffer.byteLength(EffectString.slice(3, 36)(file.content!)),
  );
  expect(body.records).toHaveLength(2);
  expect(body.records[0].terms).toContain('pending');
  expect(JSON.stringify(body)).not.toContain('function f()');
  expect(captured.symbols).toBe(facts.symbols);
});
it('omits unreachable long prefixes within the same64KiB and caps overlap before copying', () => {
  const prefix = EffectString.repeat(70_000)(' ') + '\n';
  const file = bodyFile(prefix + 'function f() { "pending"; }');
  const captured = captureBodyDiscovery(file, ownerFacts(file, [{line: 2, column: 1, endLine: 2, endColumn: 27}]));
  expect(captured.derivationInputs!.bodyDiscovery).toMatchObject({records: [], omissions: ['location-budget-or-span']});
  expect(captured.derivationInputs!.bodyDiscovery!.workBytes).toBeLessThanOrEqual(65_536);
  const overlap = bodyFile(EffectString.repeat(5_000)('x'));
  const result = captureBodyDiscovery(
    overlap,
    ownerFacts(
      overlap,
      Array.from({length: 129}, () => ({line: 1, column: 1, endLine: 1, endColumn: 5_001})),
    ),
  );
  expect(result.derivationInputs!.bodyDiscovery!.workBytes).toBeLessThanOrEqual(65_536);
  expect(result.derivationInputs!.bodyDiscovery!.omissions).toContain('owner-limit');
  expect(result.derivationInputs!.bodyDiscovery!.records.length).toBeLessThan(129);
});
it('validates owner, hash, window and policy; retains optional codec fields and closes budgeted owners', () => {
  const file = bodyFile('function f() { "pending items"; }');
  const facts = captureBodyDiscovery(
    file,
    ownerFacts(file, [{line: 1, column: 1, endLine: 1, endColumn: file.content!.length + 1}]),
  );
  const body = facts.derivationInputs!.bodyDiscovery!;
  const stored = encodeStoredCodeGraphFact(serializeBoundedCodeGraphFact(facts));
  expect(decodeStoredCodeGraphFact(stored.json).facts).toEqual(facts);
  const checkpoint = {
    kind: 'file-fact',
    factRole: 'materialized',
    path: file.path,
    cacheIdentity: codeGraphCheckpointFileFactCacheIdentity(facts),
    facts,
  };
  expect(parseCodeGraphCheckpointRecordV1(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint);
  for (const altered of [
    {...body, policy: 'legacy'},
    {...body, contentHash: EffectString.repeat(64)('b')},
    {...body, records: [{...body.records[0], ownerId: 'absent'}]},
    {...body, records: [{...body.records[0], terms: ['~body:v1:pending']}]},
    {...body, extra: true},
  ])
    expect(() => validateBodyDiscovery(altered, file.path, facts.symbols)).toThrow();
  expect(closeBodyDiscovery(body, []).records).toEqual([]);
  const budgeted = budgetCachedCodeGraphFacts(facts, 400);
  expect(Buffer.byteLength(JSON.stringify(budgeted))).toBeLessThanOrEqual(400);
  expect(
    EffectArray.every(budgeted.derivationInputs?.bodyDiscovery?.records ?? [], record =>
      EffectArray.some(budgeted.symbols, s => s.id === record.ownerId),
    ) ?? true,
  ).toBe(true);
});
it('omits ambiguous owner IDs and source spans beyond the retained source', () => {
  const file = bodyFile('function f() { "pending items"; }');
  const facts = ownerFacts(file, [{line: 1, column: 1, endLine: 1, endColumn: file.content!.length + 1}]);
  const duplicate = captureBodyDiscovery(file, {...facts, symbols: [facts.symbols[0], facts.symbols[0]]});
  expect(duplicate.derivationInputs!.bodyDiscovery).toMatchObject({records: [], omissions: ['owner-identity']});
  const invalid = captureBodyDiscovery(file, {
    ...facts,
    symbols: [{...facts.symbols[0], span: {line: 1, column: 1, endLine: 100, endColumn: 1}}],
  });
  expect(invalid.derivationInputs!.bodyDiscovery).toMatchObject({records: [], omissions: ['invalid-window']});
  expect(captureBodyDiscovery({...file, content: undefined}, facts).derivationInputs!.bodyDiscovery).toMatchObject({
    records: [],
    omissions: ['source-unavailable'],
  });
});
it('keeps metadata and body key spaces separate and preserves legacy facts', () => {
  const file = bodyFile('function f() { "pending items"; }');
  const raw = ownerFacts(file, [{line: 1, column: 1, endLine: 1, endColumn: file.content!.length + 1}]);
  const facts = captureBodyDiscovery(file, raw);
  const body = facts.derivationInputs!.bodyDiscovery!;
  const symbol = {...facts.symbols[0], documentation: '~body:v1:pending items'};
  const terms = preparedSymbolTerms([symbol], [body]).get(symbol)!;
  expect(EffectArray.some(symbolTerms(symbol), ([term]) => EffectString.startsWith(BODY_DISCOVERY_PREFIX)(term))).toBe(
    false,
  );
  expect(EffectArray.filter(terms, ([term]) => term === BODY_DISCOVERY_PREFIX + 'pending')).toHaveLength(1);
  expect(serializeBoundedCodeGraphFact(raw).facts.derivationInputs).toBeUndefined();
});
it('binds finite TypeScript proof support to the exact new registry identity independently', () => {
  expect(BODY_DISCOVERY_POLICY).toBe('body-discovery-v3-owner-presence-utf16-cursor-combined-64k');
  expect(packCacheIdentity(codeGraphLanguagePack)).toBe(NAVIGATION_PROOF_CACHE_IDENTITY);
  expect(NAVIGATION_PROOF_CACHE_IDENTITY).toBe('57a35e49fc3aaac3e897faf3ce928b546a3ec4b5404d82b21dfd76a59c96212f');
});
effectIt.layer(TreeSitterRuntime.layer.pipe(Layer.provideMerge(citationPlatformLayer)))(it =>
  it.effect('captures actual TypeScript and Python owners through the registry before source release', () =>
    Effect.gen(function* () {
      for (const [path, content] of [
        ['a.ts', 'export function f() { console.info("pending items"); }'],
        ['a.py', 'def f():\n    print("pending items")\n'],
      ] as const) {
        const facts = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractRawFile(bodyFile(content, path));
        expect(
          EffectArray.some(facts.derivationInputs!.bodyDiscovery!.records, record => record.terms.includes('pending')),
        ).toBe(true);
        expect(validateBodyDiscovery(facts.derivationInputs!.bodyDiscovery, path, facts.symbols)).toEqual(
          facts.derivationInputs!.bodyDiscovery,
        );
      }
    }),
  ),
);

effectIt.layer(citationPlatformLayer)(it => {
  for (const spool of [false, true])
    it.effect(`binds same-cardinality private body terms into ${spool ? 'spool' : 'direct'} replay receipts`, () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'body-replay-'});
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const fixtureServices = yield* Layer.build(
                CodeGraphStore.layer.pipe(Layer.provideMerge(citationPlatformLayer)),
              );
              return yield* Effect.gen(function* () {
                const identity = {
                  caseMode: 'sensitive',
                  checkoutId: EffectString.repeat(64)('a'),
                  displayName: 'fixture',
                  gitCommonDirectory: root,
                  headCommit: EffectString.repeat(40)('b'),
                  objectFormat: 'sha1',
                  repoRoot: root,
                  repositoryId: EffectString.repeat(64)('c'),
                  worktreeId: EffectString.repeat(64)('d'),
                } as const;
                const repositoryRoot = path.join(root, identity.checkoutId);
                yield* fs.makeDirectory(repositoryRoot);
                const databasePath = path.join(repositoryRoot, 'graph-v3.sqlite');
                const snapshot = {
                  commit: identity.headCommit,
                  dirty: false,
                  edgeCount: 0,
                  extractorSet: 'fixture-body-policy',
                  fileCount: 1,
                  graphContentId: `cgc_${EffectString.repeat(40)('e')}`,
                  id: `cgsn_${EffectString.repeat(40)('0')}-direct`,
                  repositoryId: identity.repositoryId,
                  state: 'building',
                  symbolCount: 0,
                  worktreeId: identity.worktreeId,
                } as const;
                const file = bodyFile('function f() { "pending items"; }');
                const captured = captureBodyDiscovery(
                  file,
                  ownerFacts(file, [{line: 1, column: 1, endLine: 1, endColumn: file.content!.length + 1}]),
                );
                const body = captured.derivationInputs!.bodyDiscovery!;
                const store = yield* CodeGraphStore;
                yield* store.withSession(
                  databasePath,
                  Effect.gen(function* () {
                    const token = yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
                    yield* store.prepareActivation(databasePath, [file], snapshot.id, 1, token);
                    const batch = {
                      batchIndex: 0,
                      symbols: captured.symbols,
                      edges: captured.edges,
                      references: [],
                      bodyDiscovery: [body],
                      finalFactBytes: Buffer.byteLength(JSON.stringify(captured)),
                      sourceBytes: file.size,
                    };
                    const context = spool ? {checkoutId: identity.checkoutId, repositoryRoot} : undefined;
                    yield* store.stageActivationFactBatches(databasePath, [batch], undefined, undefined, context);
                    yield* store.stageActivationFactBatches(databasePath, [batch], undefined, undefined, context);
                    const altered = {
                      ...batch,
                      bodyDiscovery: [
                        {
                          ...body,
                          records: EffectArray.map(body.records, record => ({
                            ...record,
                            terms: EffectArray.map(record.terms, term => (term === 'pending' ? 'changed' : term)),
                          })),
                        },
                      ],
                    };
                    expect(
                      Result.isFailure(
                        yield* store
                          .stageActivationFactBatches(databasePath, [altered], undefined, undefined, context)
                          .pipe(Effect.result),
                      ),
                    ).toBe(true);
                    yield* store.stageActivationFactBatches(databasePath, [batch], undefined, undefined, context);
                    if (spool) {
                      const prepared = yield* store.preparePersistentMaterializationSpool(
                        databasePath,
                        1,
                        undefined,
                        context!,
                        program => program,
                      );
                      yield* store.finalizePersistentMaterializationPlan(
                        databasePath,
                        1,
                        undefined,
                        undefined,
                        context,
                        prepared,
                      );
                    }
                    expect(yield* store.stagedFactCounts(databasePath)).toEqual({edges: 0, symbols: 1});
                  }),
                );
              }).pipe(Effect.provideContext(fixtureServices));
            }),
          );
        }),
      ),
    );
});

it('admits endpoint inspection and copied/tokenized bytes together near the shared work limit', () => {
  const prefix = EffectString.repeat(65528)(' ') + '\n';
  const file = bodyFile(prefix + 'pending');
  const facts = ownerFacts(file, [{line: 2, column: 1, endLine: 2, endColumn: 8}]);
  const body = captureBodyDiscovery(file, facts).derivationInputs!.bodyDiscovery!;
  expect(body.records).toEqual([]);
  expect(body.workBytes).toBeLessThanOrEqual(65536);
});
it('prepares many file bodies with one owner-index pass rather than repeated whole-batch maps', () => {
  const files = Array.from({length: 16}, (_, i) => bodyFile('pending', `f${i}.ts`));
  const facts = EffectArray.map(files, (file, i) =>
    captureBodyDiscovery(file, {
      ...ownerFacts(file, [{line: 1, column: 1, endLine: 1, endColumn: 8}]),
      symbols: EffectArray.map(ownerFacts(file, [{line: 1, column: 1, endLine: 1, endColumn: 8}]).symbols, symbol => ({
        ...symbol,
        id: `cgs_${EffectString.padStart(32, '0')(i.toString(16))}`,
      })),
    }),
  );
  let idReads = 0;
  const symbols = EffectArray.map(
    EffectArray.flatMap(facts, fact => fact.symbols),
    symbol => ({
      ...symbol,
      get id() {
        idReads += 1;
        return symbol.id;
      },
    }),
  );
  const bodies = EffectArray.map(facts, fact => fact.derivationInputs!.bodyDiscovery!);
  const prepared = preparedSymbolTerms(symbols, bodies);
  expect(prepared.size).toBe(symbols.length);
  expect(idReads).toBeLessThanOrEqual(7 * symbols.length);
  for (const symbol of symbols) expect(prepared.get(symbol)).toContainEqual([BODY_DISCOVERY_PREFIX + 'pending', 1]);
});
