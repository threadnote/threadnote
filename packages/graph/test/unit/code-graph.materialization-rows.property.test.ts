import {Array as EffectArray, Schema} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {codeGraphPackageMoniker} from '@threadnote/graph/cross_repository/monikers';
import {
  codeGraphMaterializationMonikerRows,
  codeGraphMaterializationReferenceRows,
  codeGraphMaterializationReexportRows,
  codeGraphLookupDomain,
  codeGraphMaterializationEdgeRows,
  codeGraphMaterializationSymbolLookupRows,
  codeGraphMaterializationSymbolRows,
  codeGraphMaterializationSymbolTermRows,
} from '@threadnote/graph/materialization/rows';
import type {CodeGraphEdge, CodeGraphReference, CodeGraphSymbol} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const edgeArbitrary = FC.record({
  confidence: FC.integer({max: 100, min: 0}).map(value => value / 100),
  id: FC.stringMatching(/^edge-[a-z0-9]{1,8}$/u),
  relation: FC.constantFrom('calls' as const, 'contains' as const, 'references' as const),
  sourceId: FC.option(FC.stringMatching(/^symbol-[a-z0-9]{1,8}$/u), {nil: undefined}),
  targetId: FC.option(FC.stringMatching(/^symbol-[a-z0-9]{1,8}$/u), {nil: undefined}),
});

const symbolArbitrary = FC.record({
  exported: FC.boolean(),
  id: FC.stringMatching(/^[a-z][a-z0-9]{0,8}$/u),
  lookupKeys: FC.uniqueArray(FC.stringMatching(/^[a-z][a-z0-9]{0,5}(?::[a-z]{1,6})?$/u), {maxLength: 6}),
  path: FC.stringMatching(/^src\/[a-z]{1,8}\.ts$/u),
  resolutionDomain: FC.option(FC.stringMatching(/^[a-z]{1,6}$/u), {nil: undefined}),
});

const referenceArbitrary = FC.record({
  edgeId: FC.stringMatching(/^edge-[a-z0-9]{1,8}$/u),
  exportedOnly: FC.boolean(),
  lookupTiers: FC.array(FC.array(FC.stringMatching(/^[a-z][a-z0-9]{0,5}$/u), {maxLength: 6}), {
    maxLength: 4,
  }),
  resolutionDomain: FC.stringMatching(/^[a-z]{1,8}$/u),
});

fcProp(
  it,
  'materializes lookup rows deterministically independent of unique symbol order',
  {symbols: FC.uniqueArray(symbolArbitrary, {maxLength: 24, selector: symbol => symbol.id})},
  ({symbols}) => {
    const materialized = EffectArray.map(symbols, codeGraphSymbol);
    const reversed = [...materialized].reverse();
    const forward = codeGraphMaterializationSymbolLookupRows(materialized);
    const reverse = codeGraphMaterializationSymbolLookupRows(reversed);
    expect(reverse).toEqual(forward);
    expect(new Set(EffectArray.map(forward, row => `${row.lookupKey}\0${row.symbolId}`)).size).toBe(forward.length);
    expect(
      EffectArray.every(
        forward,
        (row, index) =>
          index === 0 ||
          forward[index - 1].lookupKey < row.lookupKey ||
          (forward[index - 1].lookupKey === row.lookupKey && forward[index - 1].symbolId < row.symbolId),
      ),
    ).toBe(true);
    expect(codeGraphMaterializationSymbolRows(reversed)).toEqual(codeGraphMaterializationSymbolRows(materialized));
    expect(EffectArray.map(codeGraphMaterializationSymbolRows(materialized), row => row.id)).toEqual(
      EffectArray.map(materialized, symbol => symbol.id).sort(),
    );
  },
  {fastCheck: {numRuns: 100}},
);

fcProp(
  it,
  'materializes prepared symbol terms independent of unique symbol order',
  {symbols: FC.uniqueArray(symbolArbitrary, {maxLength: 24, selector: symbol => symbol.id})},
  ({symbols}) => {
    const materialized = EffectArray.map(symbols, codeGraphSymbol);
    const terms = new Map(
      EffectArray.map(materialized, symbol => [
        symbol,
        [
          [`term-${symbol.id}`, 5],
          ['shared', 1],
        ] as const,
      ]),
    );
    const forward = codeGraphMaterializationSymbolTermRows(materialized, terms);
    expect(codeGraphMaterializationSymbolTermRows([...materialized].reverse(), terms)).toEqual(forward);
    expect(
      EffectArray.every(
        forward,
        (row, index) =>
          index === 0 ||
          forward[index - 1].term < row.term ||
          (forward[index - 1].term === row.term && forward[index - 1].symbolId < row.symbolId),
      ),
    ).toBe(true);
  },
  {fastCheck: {numRuns: 100}},
);

it('derives an explicit lookup prefix before fallback domain', () => {
  expect(codeGraphLookupDomain('npm:react', 'workspace')).toBe('npm');
  expect(codeGraphLookupDomain('react', 'workspace')).toBe('workspace');
  expect(codeGraphLookupDomain('react', undefined)).toBe('generic');
});

it('encodes optional symbol columns and JSON at the SQLite boundary', () => {
  const [row] = codeGraphMaterializationSymbolRows([
    {
      ...codeGraphSymbol({exported: true, id: 'symbol', lookupKeys: ['npm:symbol'], path: 'src/symbol.ts'}),
      arity: 2,
      documentation: 'docs',
      packageName: '@scope/pkg',
      resolutionScopeId: 'scope',
      signature: '(left, right)',
    },
  ]);
  expect(row).toMatchObject({
    arity: 2,
    documentation: 'docs',
    exported: 1,
    lookupKeysJson: '["npm:symbol"]',
    packageName: '@scope/pkg',
    resolutionDomain: null,
    resolutionScopeId: 'scope',
    signature: '(left, right)',
    spanJson: '{"column":1,"endColumn":2,"endLine":1,"line":1}',
  });
});

fcProp(
  it,
  'materializes direct edge rows independent of unique edge order',
  {edges: FC.uniqueArray(edgeArbitrary, {maxLength: 24, selector: edge => edge.id})},
  ({edges}) => {
    const materialized = EffectArray.map(edges, edge => ({
      ...edge,
      evidencePath: 'src/source.ts',
      evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
      provenance: 'resolved' as const,
      sourceName: 'source',
      targetName: 'target',
    }));
    const forward = codeGraphMaterializationEdgeRows(materialized);
    expect(codeGraphMaterializationEdgeRows([...materialized].reverse())).toEqual(forward);
    expect(EffectArray.map(forward, row => row.id)).toEqual(EffectArray.map(materialized, edge => edge.id).sort());
    expect(
      EffectArray.every(forward, row => row.evidenceSpanJson === '{"column":1,"endColumn":2,"endLine":1,"line":1}'),
    ).toBe(true);
  },
  {fastCheck: {numRuns: 100}},
);

fcProp(
  it,
  'materializes unresolved references independent of unique input order',
  {references: FC.uniqueArray(referenceArbitrary, {maxLength: 24, selector: reference => reference.edgeId})},
  ({references}) => {
    const materialized = EffectArray.map(references, reference => codeGraphReference(reference));
    const edges = EffectArray.map(materialized, reference => referenceEdge(reference));
    const forward = codeGraphMaterializationReferenceRows(
      materialized,
      new Map(EffectArray.map(edges, edge => [edge.id, edge])),
    );
    const reverse = codeGraphMaterializationReferenceRows(
      [...materialized].reverse(),
      new Map(EffectArray.map([...edges].reverse(), edge => [edge.id, edge])),
    );
    expect(reverse).toEqual(forward);
    expect(EffectArray.map(forward, row => row.edgeId)).toEqual(
      EffectArray.map(materialized, reference => reference.edgeId).sort(),
    );
    for (const row of forward) {
      const tiers = Schema.decodeUnknownSync(Schema.Array(Schema.Array(Schema.String)))(
        JSON.parse(row.lookupTiersJson),
      );
      expect(row.candidateCount).toBe(EffectArray.reduce(tiers, 0, (total, tier) => total + tier.length));
      expect(row.candidatePayloadBytes).toBe(new TextEncoder().encode(row.lookupTiersJson).byteLength);
      expect(EffectArray.every(tiers, tier => new Set(tier).size === tier.length)).toBe(true);
    }
  },
  {fastCheck: {numRuns: 100}},
);

it('deduplicates and orders canonical TypeScript re-export rows', () => {
  const reference = codeGraphReference({
    edgeId: 'edge-reexport',
    exportedOnly: true,
    lookupTiers: [['typescript:path:src%2Ftarget.ts:name:zeta', 'typescript:path:src%2Ftarget.ts:name:alpha']],
    resolutionDomain: 'typescript',
  });
  const reexport = {
    ...reference,
    aliasLookupKeys: ['typescript:path:src%2Fsource.ts:name:local'],
    evidencePath: 'src/source.ts',
    relation: 'reexports' as const,
  };
  expect(codeGraphMaterializationReexportRows([reexport, reexport])).toEqual([
    {importedName: 'alpha', localName: 'local', sourcePath: 'src/source.ts', targetPath: 'src/target.ts'},
    {importedName: 'zeta', localName: 'local', sourcePath: 'src/source.ts', targetPath: 'src/target.ts'},
  ]);
});

it('deduplicates and encodes canonical moniker rows independent of input order', () => {
  const first = codeGraphPackageMoniker({
    componentId: `cgp_${Effect.pipe('1', EffectString.repeat(32))}`,
    evidence: {path: 'package.json', span: {column: 1, endColumn: 2, endLine: 1, line: 1}},
    packageName: '@scope/first',
    packageVersion: '1.0.0',
    role: 'export',
  });
  const second = codeGraphPackageMoniker({
    componentId: `cgp_${Effect.pipe('2', EffectString.repeat(32))}`,
    dependencyKind: 'runtime',
    evidence: {path: 'package.json', span: {column: 3, endColumn: 4, endLine: 1, line: 1}},
    packageName: '@scope/second',
    role: 'import',
  });
  const forward = codeGraphMaterializationMonikerRows([first, second]);
  expect(codeGraphMaterializationMonikerRows([second, first, second])).toEqual(forward);
  expect(forward).toHaveLength(2);
  expect(forward[0]).toMatchObject({
    dependencyKind: null,
    evidenceSpanJson: '{"column":1,"endColumn":2,"endLine":1,"line":1}',
    importPath: null,
    packageName: '@scope/first',
    packageVersion: '1.0.0',
    qualifiedName: null,
    symbolId: null,
  });
  expect(forward[1]).toMatchObject({dependencyKind: 'runtime', packageVersion: null});
});

function codeGraphSymbol(input: {
  readonly exported: boolean;
  readonly id: string;
  readonly lookupKeys: readonly string[];
  readonly path: string;
  readonly resolutionDomain?: string;
}): CodeGraphSymbol {
  return {
    ...input,
    contentHash: Effect.pipe('a', EffectString.repeat(64)),
    kind: 'function',
    language: 'typescript',
    name: input.id,
    qualifiedName: input.id,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function codeGraphReference(input: {
  readonly edgeId: string;
  readonly exportedOnly: boolean;
  readonly lookupTiers: readonly (readonly string[])[];
  readonly resolutionDomain: string;
}): CodeGraphReference {
  return {
    ...input,
    evidencePath: 'src/source.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    provenance: 'syntactic',
    relation: 'references',
    sourceName: 'source',
    targetName: 'target',
  };
}

function referenceEdge(reference: CodeGraphReference): CodeGraphEdge {
  return {
    confidence: 0.75,
    evidencePath: reference.evidencePath,
    evidenceSpan: reference.evidenceSpan,
    id: reference.edgeId,
    provenance: reference.provenance,
    relation: reference.relation,
    sourceId: reference.sourceId,
    sourceName: reference.sourceName,
    targetName: reference.targetName,
  };
}
