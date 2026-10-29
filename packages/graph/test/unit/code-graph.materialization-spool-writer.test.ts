import {Array as EffectArray, Schema} from 'effect';
import {Database} from 'bun:sqlite';
import {expect, it} from '@effect/vitest';
import {codeGraphPackageMoniker} from '@threadnote/graph/cross_repository/monikers';
import {
  commitCodeGraphMaterializationSpoolBatch,
  configureCodeGraphMaterializationSpoolDatabase,
  initializeCodeGraphMaterializationSpoolDatabase,
  readCodeGraphMaterializationSpoolReadyPlan,
  sealCodeGraphMaterializationSpool,
  sortCodeGraphMaterializationSpoolSurfaces,
} from '@threadnote/graph/materialization/spool';
import {
  appendCodeGraphMaterializationSpoolFactBatch,
  prepareCodeGraphMaterializationSpoolFactBatch,
} from '@threadnote/graph/materialization/spool/writer';
import type {CodeGraphEdge, CodeGraphReference, CodeGraphSymbol} from '@threadnote/graph/types';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

it('appends every canonical fact surface under the exact durable batch receipt', () => {
  const database = new Database(':memory:', {strict: true});
  const symbol: CodeGraphSymbol = {
    contentHash: Effect.pipe('a', EffectString.repeat(64)),
    exported: true,
    id: 'symbol-source',
    kind: 'function',
    language: 'typescript',
    lookupKeys: ['typescript:name:source', 'generic:source'],
    name: 'source',
    path: 'src/source.ts',
    qualifiedName: 'source',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
  const directEdge = edge('edge-direct', 'calls');
  const referenceEdge = edge('edge-reference', 'reexports');
  const reference: CodeGraphReference = {
    aliasLookupKeys: ['typescript:path:src%2Fsource.ts:name:local'],
    edgeId: referenceEdge.id,
    evidencePath: referenceEdge.evidencePath,
    evidenceSpan: referenceEdge.evidenceSpan,
    exportedOnly: true,
    lookupTiers: [['typescript:path:src%2Ftarget.ts:name:imported']],
    provenance: referenceEdge.provenance,
    relation: referenceEdge.relation,
    resolutionDomain: 'typescript',
    sourceId: referenceEdge.sourceId,
    sourceName: referenceEdge.sourceName,
    targetName: referenceEdge.targetName,
  };
  const prepared = prepareCodeGraphMaterializationSpoolFactBatch({
    directEdges: [directEdge],
    monikers: [
      codeGraphPackageMoniker({
        componentId: `cgp_${Effect.pipe('1', EffectString.repeat(32))}`,
        evidence: {path: 'package.json', span: {column: 1, endColumn: 2, endLine: 1, line: 1}},
        packageName: '@scope/source',
        role: 'export',
      }),
    ],
    referenceEdges: new Map([[referenceEdge.id, referenceEdge]]),
    references: [reference],
    symbols: [symbol],
    termsBySymbol: new Map([
      [
        symbol,
        [
          ['shared', 1],
          ['source', 5],
        ],
      ],
    ]),
  });
  try {
    configureCodeGraphMaterializationSpoolDatabase(database);
    initializeCodeGraphMaterializationSpoolDatabase(database, {
      checkoutId: Effect.pipe('a', EffectString.repeat(64)),
      extractorSet: 'extractor-v1',
      graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
      repositoryId: Effect.pipe('c', EffectString.repeat(64)),
      snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
    });
    expect(
      commitCodeGraphMaterializationSpoolBatch(
        database,
        {
          batchId: Effect.pipe('e', EffectString.repeat(64)),
          batchIndex: 0,
          candidateCount: 1,
          edgeCount: 2,
          factBytes: 100,
          lookupCount: 2,
          referenceCount: 1,
          reexportCount: 1,
          rowCount: prepared.rowCount,
          sourceBytes: 200,
          symbolCount: 1,
          termCount: 2,
        },
        () => appendCodeGraphMaterializationSpoolFactBatch(database, prepared),
      ),
    ).toBe('appended');
    expect(prepared.rowCount).toBe(9);
    expect(rawSurfaceCounts(database)).toEqual({
      edges: 1,
      lookup: 2,
      monikers: 1,
      references: 1,
      reexports: 1,
      symbol_terms: 2,
      symbols: 1,
    });
    sealCodeGraphMaterializationSpool(database, 1);
    sortCodeGraphMaterializationSpoolSurfaces(database);
    const readyPlan = readCodeGraphMaterializationSpoolReadyPlan(database);
    expect(readyPlan.spoolIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(readCodeGraphMaterializationSpoolReadyPlan(database)).toEqual(readyPlan);
    expect(readyPlan.lexicalTermCount).toBe(2);
    expect(readyPlan.batches).toEqual([
      {
        batchId: Effect.pipe('e', EffectString.repeat(64)),
        batchIndex: 0,
        candidateCount: 1,
        edgeCount: 2,
        factBytes: 100,
        lookupCount: 2,
        referenceCount: 1,
        reexportCount: 1,
        rowCount: prepared.rowCount,
        sourceBytes: 200,
        symbolCount: 1,
        termCount: 2,
      },
    ]);
    expect(
      EffectRecord.fromEntries(EffectArray.map(readyPlan.surfaces, surface => [surface.name, surface.rowCount])),
    ).toEqual({
      edges: 1,
      lookup: 2,
      monikers: 1,
      references: 1,
      reexports: 1,
      symbol_terms: 2,
      symbols: 1,
    });
    expect(
      database.prepare('SELECT lookup_key, symbol_id FROM materialization_ordered_lookup ORDER BY rowid').all(),
    ).toEqual([
      {lookup_key: 'generic:source', symbol_id: 'symbol-source'},
      {lookup_key: 'typescript:name:source', symbol_id: 'symbol-source'},
    ]);
    expect(
      database.prepare('SELECT candidate_count, lookup_tiers_json FROM materialization_ordered_references').get(),
    ).toEqual({candidate_count: 1, lookup_tiers_json: '[["typescript:path:src%2Ftarget.ts:name:imported"]]'});
    expect(database.prepare('SELECT term FROM materialization_ordered_terms ORDER BY rowid').all()).toEqual([
      {term: 'shared'},
      {term: 'source'},
    ]);
  } finally {
    database.close();
  }
});

function edge(id: string, relation: CodeGraphEdge['relation']): CodeGraphEdge {
  return {
    confidence: 0.75,
    evidencePath: 'src/source.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance: 'syntactic',
    relation,
    sourceId: 'symbol-source',
    sourceName: 'source',
    targetName: 'target',
  };
}

function rawSurfaceCounts(database: Database): Readonly<Record<string, number>> {
  return EffectRecord.fromEntries(
    EffectArray.map(['edges', 'lookup', 'monikers', 'references', 'reexports', 'symbol_terms', 'symbols'], surface => [
      surface,
      Schema.decodeUnknownSync(Schema.Struct({count: Schema.Finite}))(
        database.prepare(`SELECT COUNT(*) AS count FROM materialization_raw_${surface}`).get(),
      ).count,
    ]),
  );
}
