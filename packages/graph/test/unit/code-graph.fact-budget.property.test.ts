import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {describe, expect, it} from '@effect/vitest';
import {Option} from 'effect';
import * as FC from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  budgetCachedCodeGraphFacts,
  cachedCodeGraphFactBytes,
  cachedCodeGraphFactByteUpperBound,
  CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
  CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM,
  CODE_GRAPH_REFERENCE_CANDIDATE_BUDGET_DIAGNOSTIC,
  createCachedCodeGraphFactsAttributor,
  factMaterializationBatches,
  finalCodeGraphFactBatches,
} from '@threadnote/graph/indexer';
import {CODE_GRAPH_PARSER_FACTS_VERSION, packCacheIdentity} from '@threadnote/graph/languages/registry';
import type {CodeGraphCapability, CodeGraphLanguagePack} from '@threadnote/graph/languages/types';
import {augmentRationaleFacts, CODE_GRAPH_RATIONALE_INPUT_VERSION} from '@threadnote/graph/rationale';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphReference,
  CodeGraphRelation,
  CodeGraphSymbol,
} from '@threadnote/graph/types';
import {discoverManifestWorkspace} from '@threadnote/graph/workspace';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const unicodeText = FC.array(FC.constantFrom('a', '"', '\\', '\0', '\n', 'é', '漢', '🙂'), {
  maxLength: 48,
}).map(characters => EffectArray.join(characters, ''));

const factCase = {
  diagnostics: FC.array(unicodeText, {maxLength: 8}),
  edgeSpecs: FC.array(
    FC.record({
      hasReference: FC.boolean(),
      payload: unicodeText,
      relation: FC.constantFrom<CodeGraphRelation>(
        'calls',
        'contains',
        'documents',
        'exports',
        'imports',
        'references',
      ),
      source: FC.integer({max: 48, min: 0}),
      target: FC.integer({max: 48, min: 0}),
    }),
    {maxLength: 70},
  ),
  maximumBytes: FC.integer({max: 12_000, min: 512}),
  symbolDocuments: FC.array(unicodeText, {maxLength: 40}),
} as const;

describe('cached code graph fact persistence budget', () => {
  it('fast-paths ordinary facts through a conservative bound without rebuilding them', () => {
    const facts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path: 'src/ordinary.ts',
      symbols: [graphSymbol('ordinary-module', 'module', 'src/ordinary.ts', 1, true)],
    };

    expect(cachedCodeGraphFactByteUpperBound(facts)).toBeLessThan(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
    expect(budgetCachedCodeGraphFacts(facts)).toBe(facts);
  });

  it('keeps TypeScript architecture and exported declarations ahead of calls and documentation', () => {
    const path = 'src/pathological.ts';
    const module = graphSymbol('ts-module', 'module', path, 1, true);
    const packageSymbol = graphSymbol('ts-package', 'package', path, 1, true);
    const exportedDeclaration = graphSymbol('ts-exported-tail', 'interface', path, 10_000, true, 'private-doc');
    const declarations = Array.from({length: 60}, (_, index) =>
      graphSymbol(
        `ts-local-${Effect.pipe(index.toString(), EffectString.padStart(3, '0'))}`,
        'function',
        path,
        index + 2,
        false,
        `private documentation ${Effect.pipe('漢', EffectString.repeat(80))}`,
      ),
    );
    const architectureEdges = [
      graphEdge('ts-import', 'imports', path, 1, module.id, undefined, 'external-package'),
      graphEdge('ts-export', 'exports', path, 2, module.id, exportedDeclaration.id, exportedDeclaration.name),
      graphEdge('ts-reexport', 'reexports', path, 3, module.id, undefined, 'external-symbol'),
      graphEdge('ts-declares', 'declares', path, 4, packageSymbol.id, module.id, module.name),
    ];
    const callEdges = EffectArray.map(declarations, (declaration, index) =>
      graphEdge(
        `ts-call-${Effect.pipe(index.toString(), EffectString.padStart(3, '0'))}`,
        'calls',
        path,
        index + 10,
        module.id,
        declaration.id,
      ),
    );
    const facts: CodeGraphFileFacts = {
      derivationInputs: {
        rationale: [
          {
            documentation: `secret rationale ${Effect.pipe('漢', EffectString.repeat(2_000))}`,
            line: 1,
            marker: 'why',
            name: 'private',
          },
        ],
      },
      diagnostics: ['src/pathological.ts: private parser detail'],
      edges: [...callEdges, ...architectureEdges],
      path,
      references: EffectArray.map([...callEdges, ...architectureEdges], edge =>
        graphReference(edge, `lookup:${edge.id}`),
      ),
      symbols: [...declarations, exportedDeclaration, module, packageSymbol],
    };
    const maximumBytes = 14_000;

    expect(utf8Bytes(facts)).toBeGreaterThan(maximumBytes);
    const bounded = budgetCachedCodeGraphFacts(facts, maximumBytes);

    expect(utf8Bytes(bounded)).toBeLessThanOrEqual(maximumBytes);
    expect(EffectArray.map(bounded.symbols, symbol => symbol.id)).toEqual(
      expect.arrayContaining([module.id, packageSymbol.id, exportedDeclaration.id]),
    );
    expect(
      EffectArrayPipe(bounded.edges, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (edge, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues && ['exports', 'imports', 'reexports'].includes(edge.relation),
        ),
      ),
    ).toHaveLength(3);
    expect(EffectArray.filter(bounded.edges, edge => edge.relation === 'calls').length).toBeLessThan(callEdges.length);
    expect(EffectArray.every(bounded.symbols, symbol => symbol.documentation === undefined)).toBe(true);
    expect(bounded.derivationInputs).toBeUndefined();
    expect(bounded.diagnostics[0]).toMatch(/^Cached code graph facts exceeded the per-file persistence budget/);
    expectGraphClosure(facts, bounded);
  });

  it('retains a deterministic, source-ordered and closed prefix of pathological JSON topology', () => {
    const path = 'config/pathological.json';
    const root = graphSymbol('json-root', 'object', path, 1, false);
    const properties = Array.from({length: 220}, (_, index) =>
      graphSymbol(
        `json-property-${Effect.pipe(index.toString(), EffectString.padStart(3, '0'))}`,
        'property',
        path,
        index + 2,
        false,
        `schema detail ${Effect.pipe('界', EffectString.repeat(40))}`,
      ),
    );
    const edges = EffectArray.map(properties, (property, index) =>
      graphEdge(
        `json-contains-${Effect.pipe(index.toString(), EffectString.padStart(3, '0'))}`,
        'contains',
        path,
        index + 2,
        root.id,
        property.id,
      ),
    );
    const facts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [...edges].reverse(),
      path,
      symbols: [...properties].reverse().concat(root),
    };
    const maximumBytes = 18_000;

    const first = budgetCachedCodeGraphFacts(facts, maximumBytes);
    const second = budgetCachedCodeGraphFacts(facts, maximumBytes);

    expect(utf8Bytes(facts)).toBeGreaterThan(maximumBytes);
    expect(utf8Bytes(first)).toBeLessThanOrEqual(maximumBytes);
    expect(first).toEqual(second);
    expect(budgetCachedCodeGraphFacts(first, maximumBytes)).toEqual(first);
    expect(EffectArray.some(first.symbols, symbol => symbol.id === root.id)).toBe(true);
    const retainedContains = EffectArray.filter(first.edges, edge => edge.relation === 'contains');
    expect(retainedContains.length).toBeGreaterThan(0);
    expect(retainedContains.length).toBeLessThan(edges.length);
    expect(EffectArray.map(retainedContains, edge => edge.id)).toEqual(
      EffectArray.map(edges.slice(0, retainedContains.length), edge => edge.id),
    );
    expectGraphClosure(facts, first);
  });

  it('drops pathological corpus documentation before topology at the production 8 MiB limit', () => {
    const path = 'docs/pathological.rst';
    const privateCorpus = `private-corpus-sentinel ${Effect.pipe('漢', EffectString.repeat(2_850_000))}`;
    const document = graphSymbol('corpus-document', 'document', path, 1, true, privateCorpus);
    const heading = graphSymbol('corpus-heading', 'heading', path, 2, true, 'short heading documentation');
    const documents = graphEdge('corpus-documents', 'documents', path, 2, document.id, heading.id);
    const facts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [documents],
      path,
      symbols: [document, heading],
    };

    expect(utf8Bytes(facts)).toBeGreaterThan(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
    const bounded = budgetCachedCodeGraphFacts(facts);

    expect(utf8Bytes(bounded)).toBeLessThanOrEqual(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
    expect(EffectArray.map(bounded.symbols, symbol => symbol.id)).toEqual([document.id, heading.id]);
    expect(EffectArray.every(bounded.symbols, symbol => symbol.documentation === undefined)).toBe(true);
    expect(bounded.edges).toEqual([documents]);
    expect(JSON.stringify(bounded)).not.toContain('private-corpus-sentinel');
    expectGraphClosure(facts, bounded);
  });

  it('omits even the budget report when a tiny test ceiling cannot contain it', () => {
    const facts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path: 'x',
      symbols: [graphSymbol('oversized', 'module', 'x', 1, true, Effect.pipe('漢', EffectString.repeat(100)))],
    };
    const maximumBytes = 64;
    const bounded = budgetCachedCodeGraphFacts(facts, maximumBytes);

    expect(utf8Bytes(bounded)).toBeLessThanOrEqual(maximumBytes);
    expect(bounded.diagnostics).toEqual([]);
    expect(bounded.symbols).toEqual([]);
  });

  it('strictly limits exact serialized cached-fact bytes in every materialization batch', () => {
    const sharedDocumentation = Effect.pipe('漢', EffectString.repeat(1_100_000));
    const files = Array.from({length: 5}, (_, index) => ({path: `docs/dense-${index}.md`, size: 32}));
    const facts = EffectArray.map(files, (file, index) =>
      budgetCachedCodeGraphFacts({
        diagnostics: [],
        edges: [],
        path: file.path,
        symbols: [graphSymbol(`document-${index}`, 'document', file.path, 1, true, sharedDocumentation)],
      }),
    );
    const factBytes = new Map(EffectArray.map(facts, fact => [fact.path, utf8Bytes(fact)]));
    const batches = factMaterializationBatches(files, factBytes);

    expect(batches.flat()).toEqual(files);
    expect(EffectArray.every(batches, batch => batch.length > 0)).toBe(true);
    expect(
      EffectArray.every(
        batches,
        batch => EffectArray.reduce(batch, 0, (total, file) => total + factBytes.get(file.path)!) <= 8 * 1_048_576,
      ),
    ).toBe(true);
    expect(EffectArray.every(facts, fact => utf8Bytes(fact) <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM)).toBe(true);
  });

  it('makes the bounded parser-facts policy part of cache identity', () => {
    const pack = identityTestPack();
    const current = packCacheIdentity(pack);

    expect(CODE_GRAPH_PARSER_FACTS_VERSION).toBe('parser-facts-v7-worker-resource-budgets');
    expect(current).toBe(testPackCacheIdentity(pack, CODE_GRAPH_PARSER_FACTS_VERSION));
    expect(current).not.toBe(testPackCacheIdentity(pack, 'parser-facts-v1'));
  });

  it('preserves an oversized reference edge as unresolved with a privacy-safe diagnostic', () => {
    const path = 'src/reference-candidate-budget.ts';
    const owner = graphSymbol('candidate-budget-owner', 'function', path, 1, true);
    const unresolved = graphEdge('candidate-budget-edge', 'calls', path, 2, owner.id, undefined, 'target');
    const oversized = graphReference(unresolved, 'ignored');
    const facts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [unresolved],
      path,
      references: [
        {
          ...oversized,
          lookupTiers: [
            Array.from(
              {length: CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM + 1},
              (_, index) => `lookup:${index}`,
            ),
          ],
        },
      ],
      symbols: [owner],
    };

    const bounded = budgetCachedCodeGraphFacts(facts);

    expect(cachedCodeGraphFactBytes(facts)).toBeLessThan(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
    expect(bounded.edges).toEqual([unresolved]);
    expect(bounded.references).toEqual([]);
    expect(bounded.diagnostics).toContain(CODE_GRAPH_REFERENCE_CANDIDATE_BUDGET_DIAGNOSTIC);
    expect(CODE_GRAPH_REFERENCE_CANDIDATE_BUDGET_DIAGNOSTIC).not.toContain(path);
    expect(CODE_GRAPH_REFERENCE_CANDIDATE_BUDGET_DIAGNOSTIC).not.toContain(unresolved.targetName);
  });

  it('re-budgets rationale and resolution amplification before final staging', () => {
    const path = 'src/rationale-amplification.ts';
    const file = inventoryFile(path);
    const owner = {
      ...graphSymbol('amplification-module', 'module', path, 1, true),
      span: {column: 1, endColumn: 1, endLine: 7_000, line: 1},
    } satisfies CodeGraphSymbol;
    const rationale = Array.from({length: 6_000}, (_, index) => ({
      documentation: `rationale-${index}-${Effect.pipe('漢', EffectString.repeat(160))}`,
      line: index + 2,
      marker: 'WHY',
      name: `WHY-${index}`,
    }));
    const raw: CodeGraphFileFacts = {
      derivationInputs: {rationale},
      diagnostics: [],
      edges: [],
      path,
      symbols: [owner],
    };
    const postprocessed = augmentRationaleFacts(file, raw);
    const attributed = createCachedCodeGraphFactsAttributor(
      [file],
      discoverManifestWorkspace([file]),
    )([postprocessed])[0];

    expect(utf8Bytes(raw)).toBeLessThan(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
    expect(utf8Bytes(postprocessed)).toBeGreaterThan(utf8Bytes(raw));
    expect(utf8Bytes(attributed)).toBeGreaterThan(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
    const batches = finalCodeGraphFactBatches([attributed]);
    const bounded = batches[0][0];

    expect(batches).toHaveLength(1);
    expect(bounded.bytes).toBe(utf8Bytes(bounded.facts));
    expect(bounded.bytes).toBeLessThanOrEqual(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
    expect(EffectArray.some(bounded.facts.symbols, symbol => symbol.id === owner.id)).toBe(true);
    expect(EffectArray.every(bounded.facts.symbols, symbol => symbol.documentation === undefined)).toBe(true);
    expect(bounded.facts.derivationInputs).toBeUndefined();
    expectGraphClosure(attributed, bounded.facts);
  });

  it('deduplicates cross-file primary keys before splitting final fact transactions', () => {
    const firstPath = 'src/dedup-first.ts';
    const secondPath = 'src/dedup-second.ts';
    const firstShared = graphSymbol('dedup-shared', 'module', firstPath, 1, true, 'first symbol wins');
    const secondShared = graphSymbol('dedup-shared', 'module', secondPath, 1, false, 'second symbol loses');
    const target = graphSymbol('dedup-target', 'function', firstPath, 2, true);
    const secondOnly = graphSymbol('dedup-second-only', 'function', secondPath, 2, false);
    const firstEdge = graphEdge('dedup-edge', 'calls', firstPath, 3, firstShared.id, target.id);
    const secondEdge = graphEdge('dedup-edge', 'calls', secondPath, 4, secondShared.id, target.id);
    const firstReference = graphReference(firstEdge, 'first-reference-loses');
    const lastReference = graphReference(secondEdge, 'last-reference-wins');
    const firstFacts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [firstEdge],
      path: firstPath,
      references: [firstReference],
      symbols: [firstShared, target],
    };
    const secondFacts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [secondEdge],
      path: secondPath,
      references: [lastReference],
      symbols: [secondShared, secondOnly],
    };
    const canonicalFirst = {...firstFacts, references: [lastReference]};
    const canonicalSecond = {...secondFacts, edges: [], references: [], symbols: [secondOnly]};
    const maximumBytes = Math.max(utf8Bytes(canonicalFirst), utf8Bytes(canonicalSecond));

    expect(utf8Bytes(canonicalFirst) + utf8Bytes(canonicalSecond)).toBeGreaterThan(maximumBytes);
    const batches = finalCodeGraphFactBatches([firstFacts, secondFacts], maximumBytes);
    const flattened = batches.flat();

    expect(batches).toHaveLength(2);
    expect(
      EffectArray.every(
        batches,
        batch => EffectArray.reduce(batch, 0, (total, value) => total + value.bytes) <= maximumBytes,
      ),
    ).toBe(true);
    expect(EffectArray.every(flattened, value => value.bytes === utf8Bytes(value.facts))).toBe(true);
    expect(EffectArray.map(flattened, value => value.facts.path)).toEqual([firstPath, secondPath]);
    expect(
      EffectArray.filter(
        EffectArray.flatMap(flattened, value => value.facts.symbols),
        symbol => symbol.id === firstShared.id,
      ),
    ).toEqual([firstShared]);
    expect(
      EffectArray.filter(
        EffectArray.flatMap(flattened, value => value.facts.edges),
        edge => edge.id === firstEdge.id,
      ),
    ).toEqual([firstEdge]);

    const survivingEdgeFacts = Option.getOrUndefined(
      EffectArray.findFirst(
        flattened,
        __effectArrayValue =>
          !!(value => EffectArray.some(value.facts.edges, edge => edge.id === firstEdge.id))(__effectArrayValue),
      ),
    )!.facts;
    expect(survivingEdgeFacts.path).toBe(firstPath);
    expect(survivingEdgeFacts.references).toEqual([lastReference]);
    expect(
      Option.getOrUndefined(EffectArray.findFirst(flattened, value => value.facts.path === secondPath))!.facts
        .references,
    ).toEqual([]);

    const retainedSymbols = new Set(
      EffectArray.flatMap(flattened, value => EffectArray.map(value.facts.symbols, symbol => symbol.id)),
    );
    const retainedEdges = new Set(
      EffectArray.flatMap(flattened, value => EffectArray.map(value.facts.edges, edge => edge.id)),
    );
    for (const value of flattened) {
      for (const edge of value.facts.edges) {
        if (edge.sourceId !== undefined) expect(retainedSymbols.has(edge.sourceId)).toBe(true);
        if (edge.targetId !== undefined) expect(retainedSymbols.has(edge.targetId)).toBe(true);
      }
      for (const reference of value.facts.references ?? []) expect(retainedEdges.has(reference.edgeId)).toBe(true);
    }
  });

  fcProp(
    it,
    'keeps arbitrary Unicode-heavy facts deterministic, atomic, closed, and within their UTF-8 byte ceiling',
    factCase,
    ({diagnostics, edgeSpecs, maximumBytes, symbolDocuments}) => {
      const path = 'src/property.ts';
      const symbols = [
        graphSymbol('property-module', 'module', path, 1, true),
        ...EffectArray.map(symbolDocuments, (documentation, index) =>
          graphSymbol(
            `property-symbol-${index}`,
            index % 5 === 0 ? 'document' : 'function',
            path,
            index + 2,
            index % 3 === 0,
            documentation,
          ),
        ),
      ];
      const edges = EffectArray.map(edgeSpecs, (spec, index) =>
        graphEdge(
          `property-edge-${index}`,
          spec.relation,
          path,
          index + 1,
          symbols[spec.source % symbols.length].id,
          symbols[spec.target % symbols.length].id,
          spec.payload,
        ),
      );
      const references = EffectArray.flatMap(edgeSpecs, (spec, index) =>
        spec.hasReference ? [graphReference(edges[index], spec.payload)] : [],
      );
      const facts: CodeGraphFileFacts = {
        derivationInputs: {
          rationale: EffectArray.map(symbolDocuments.slice(0, 4), (documentation, index) => ({
            documentation,
            line: index + 1,
            marker: 'why',
            name: `rationale-${index}`,
          })),
        },
        diagnostics,
        edges,
        path,
        references,
        symbols,
      };
      const upperBound = cachedCodeGraphFactByteUpperBound(facts);
      const bounded = budgetCachedCodeGraphFacts(facts, maximumBytes);

      expect(utf8Bytes(facts)).toBeLessThanOrEqual(upperBound);
      expect(cachedCodeGraphFactBytes(bounded)).toBe(utf8Bytes(bounded));
      expect(utf8Bytes(bounded)).toBeLessThanOrEqual(maximumBytes);
      expect(budgetCachedCodeGraphFacts(facts, maximumBytes)).toEqual(bounded);
      expect(budgetCachedCodeGraphFacts(bounded, maximumBytes)).toEqual(bounded);
      if (upperBound <= maximumBytes) expect(bounded).toBe(facts);
      expectGraphClosure(facts, bounded);
      expectAtomicFacts(facts, bounded);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'packs final attributed facts into deterministic non-empty transactions under the exact byte cap',
    {
      maximumBytes: FC.integer({max: 8_000, min: 512}),
      payloads: FC.array(unicodeText, {maxLength: 24, minLength: 1}),
    },
    ({maximumBytes, payloads}) => {
      const files = EffectArray.map(payloads, (_, index) => inventoryFile(`src/final-${index}.ts`));
      const raw = EffectArray.map(files, (file, index) => ({
        diagnostics: [],
        edges: [],
        path: file.path,
        symbols: [graphSymbol(`final-module-${index}`, 'module', file.path, 1, true, payloads[index])],
      }));
      const attributed = createCachedCodeGraphFactsAttributor(files, discoverManifestWorkspace(files))(raw);
      const first = finalCodeGraphFactBatches(attributed, maximumBytes);
      const second = finalCodeGraphFactBatches(attributed, maximumBytes);
      const flattened = first.flat();

      expect(first).toEqual(second);
      expect(EffectArray.every(first, batch => batch.length > 0)).toBe(true);
      expect(
        EffectArray.every(
          first,
          batch => EffectArray.reduce(batch, 0, (total, value) => total + value.bytes) <= maximumBytes,
        ),
      ).toBe(true);
      expect(EffectArray.map(flattened, value => value.facts.path)).toEqual(
        EffectArray.map(attributed, fact => fact.path),
      );
      for (const value of flattened) {
        expect(value.bytes).toBe(utf8Bytes(value.facts));
        expect(value.bytes).toBeLessThanOrEqual(maximumBytes);
        expectGraphClosure(
          Option.getOrUndefined(EffectArray.findFirst(attributed, fact => fact.path === value.facts.path))!,
          value.facts,
        );
      }
    },
    {fastCheck: {numRuns: 200}},
  );
});

function graphSymbol(
  id: string,
  kind: string,
  path: string,
  line: number,
  exported: boolean,
  documentation?: string,
): CodeGraphSymbol {
  return {
    contentHash: `hash-${id}`,
    ...(documentation === undefined ? {} : {documentation}),
    exported,
    id,
    kind,
    language: Effect.pipe(path, EffectString.endsWith('.json'))
      ? 'json'
      : Effect.pipe(path, EffectString.endsWith('.rst'))
        ? 'rst'
        : 'typescript',
    lookupKeys: [`lookup:${id}`],
    name: id,
    path,
    qualifiedName: id,
    signature: `signature:${id}`,
    span: {column: 1, endColumn: 2, endLine: line, line},
  };
}

function inventoryFile(path: string): CodeGraphInventoryFile {
  return {
    blobId: `blob-${path}`,
    contentHash: `hash-${path}`,
    language: 'typescript',
    mode: '100644',
    path,
    size: 1,
    source: 'commit',
  };
}

function graphEdge(
  id: string,
  relation: CodeGraphRelation,
  path: string,
  line: number,
  sourceId: string | undefined,
  targetId: string | undefined,
  targetName = targetId ?? 'external',
): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: path,
    evidenceSpan: {column: 1, endColumn: 2, endLine: line, line},
    id,
    provenance: 'syntactic',
    relation,
    ...(sourceId === undefined ? {} : {sourceId}),
    sourceName: sourceId ?? 'source',
    ...(targetId === undefined ? {} : {targetId}),
    targetName,
  };
}

function graphReference(edge: CodeGraphEdge, payload: string): CodeGraphReference {
  return {
    edgeId: edge.id,
    evidencePath: edge.evidencePath,
    evidenceSpan: edge.evidenceSpan,
    lookupTiers: [[payload, `lookup:${edge.targetName}`]],
    provenance: edge.provenance,
    relation: edge.relation,
    resolutionDomain: 'typescript',
    ...(edge.sourceId === undefined ? {} : {sourceId: edge.sourceId}),
    sourceName: edge.sourceName,
    targetName: edge.targetName,
  };
}

function expectGraphClosure(original: CodeGraphFileFacts, bounded: CodeGraphFileFacts): void {
  const localIds = new Set(EffectArray.map(original.symbols, symbol => symbol.id));
  const retainedIds = new Set(EffectArray.map(bounded.symbols, symbol => symbol.id));
  const retainedEdgeIds = new Set(EffectArray.map(bounded.edges, edge => edge.id));
  for (const edge of bounded.edges) {
    if (edge.sourceId !== undefined && localIds.has(edge.sourceId)) expect(retainedIds.has(edge.sourceId)).toBe(true);
    if (edge.targetId !== undefined && localIds.has(edge.targetId)) expect(retainedIds.has(edge.targetId)).toBe(true);
  }
  for (const reference of bounded.references ?? []) {
    expect(retainedEdgeIds.has(reference.edgeId)).toBe(true);
    if (reference.sourceId !== undefined && localIds.has(reference.sourceId)) {
      expect(retainedIds.has(reference.sourceId)).toBe(true);
    }
  }
}

function expectAtomicFacts(original: CodeGraphFileFacts, bounded: CodeGraphFileFacts): void {
  const symbols = new Map(EffectArray.map(original.symbols, symbol => [symbol.id, symbol]));
  const edges = new Map(EffectArray.map(original.edges, edge => [edge.id, edge]));
  const references = new Map(EffectArray.map(original.references ?? [], reference => [reference.edgeId, reference]));
  for (const symbol of bounded.symbols) {
    const originalSymbol = symbols.get(symbol.id)!;
    const {documentation: _documentation, ...withoutDocumentation} = originalSymbol;
    expect([originalSymbol, withoutDocumentation]).toContainEqual(symbol);
  }
  for (const edge of bounded.edges) expect(edges.get(edge.id)).toEqual(edge);
  for (const reference of bounded.references ?? []) expect(references.get(reference.edgeId)).toEqual(reference);
}

function identityTestPack(): CodeGraphLanguagePack {
  return {
    assets: [],
    capabilities: new Set<CodeGraphCapability>(['declarations']),
    extractor: {
      extract: () => {
        throw TestError.make({message: 'identity-only test extractor'});
      },
      version: 'identity-extractor-v1',
    },
    files: [{kind: 'extension', language: 'identity', role: 'source', value: '.identity'}],
    id: 'fact-budget-identity',
    resolutionStrategy: {domain: 'identity', version: 'identity-resolution-v1'},
    version: 'identity-pack-v1',
    workspaceDetector: Option.none(),
  };
}

function testPackCacheIdentity(pack: CodeGraphLanguagePack, parserFactsVersion: string): string {
  const matchers = EffectArray.join(
    EffectArray.map(
      pack.files,
      matcher => `${matcher.kind}:${Effect.pipe(matcher.value, EffectString.toLowerCase)}:${matcher.language}`,
    ).sort(),
    '\n',
  );
  return sha256HexSync(
    EffectArray.join(
      [
        'code-graph-language-pack-v3',
        parserFactsVersion,
        `derivation-inputs:${CODE_GRAPH_RATIONALE_INPUT_VERSION}`,
        `id:${pack.id}`,
        `extractor:${pack.extractor.version}`,
        'parser-runtime:pack-owned',
        `files:\n${matchers}`,
        'assets:\n',
      ],
      '\n',
    ),
  );
}
