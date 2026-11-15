import {Array as EffectArray} from 'effect';
import {describe, expect, it} from '@effect/vitest';
import {codeGraphAdjacencyQueryStatement} from '@threadnote/graph/store/query/core';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphProvenance} from '@threadnote/graph/types';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import * as FC from 'fast-check';
import {codeGraphEdgesByIdsQueryStatement, codeGraphTraversalQueryStatement} from '../../src/store/query/traversal.js';
import {codeGraphVisualizationSymbolsQueryStatement} from '../../src/store/visualization_sql.js';
import {CODE_GRAPH_QUERY_INDEX_DEFINITIONS} from '../../src/store/query/indexes.js';
import type {CodeGraphVisualizationScope} from '../../src/store/models.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const baseSnapshot = 'base';
const currentSnapshot = 'current';
const provenances = ['declared', 'resolved', 'syntactic', 'heuristic', 'model'] as const;
const directions = ['outgoing', 'incoming', 'both'] as const;
const relations = ['calls', 'contains', 'exports', 'imports', 'reexports', 'tests'] as const;
type Direction = (typeof directions)[number];

interface EdgeRow {
  readonly snapshot_id: string;
  readonly id: string;
  readonly source_id: string | null;
  readonly source_name: string;
  readonly relation: string;
  readonly target_id: string | null;
  readonly target_name: string;
  readonly provenance: CodeGraphProvenance;
  readonly confidence: number;
  readonly evidence_path: string;
  readonly evidence_span_json: string;
}

type TraversalRow = Pick<EdgeRow, 'id' | 'source_id' | 'target_id' | 'relation' | 'provenance' | 'confidence'>;
type Statement = {readonly text: string; readonly parameters: readonly (number | string)[]};

const edgeArbitrary = FC.record({
  id: FC.integer({min: 0, max: 23}).map(value => `edge-${value}`),
  source_id: FC.option(
    FC.integer({min: 0, max: 5}).map(value => `node-${value}`),
    {nil: null},
  ),
  target_id: FC.option(
    FC.integer({min: 0, max: 5}).map(value => `node-${value}`),
    {nil: null},
  ),
  source_name: FC.constantFrom('Alpha', 'alpha', 'beta', 'tie'),
  target_name: FC.constantFrom('Alpha', 'alpha', 'beta', 'tie'),
  relation: FC.constantFrom(...relations),
  provenance: FC.constantFrom(...provenances),
  confidence: FC.integer({min: 0, max: 4}).map(value => value / 4),
  evidence_path: FC.constantFrom('src/first.ts', 'src/second.ts', 'src/third.ts'),
  evidence_span_json: FC.integer({min: 1, max: 5}).map(line => JSON.stringify({line, column: 1, endLine: line})),
});

// These tests exercise the pure SQL-builder/Bun SQLite boundary. Runtime store
// tests separately cover Effect execution, leases, and hydration batch ordering.
describe('code graph traversal projection SQL', () => {
  fcProp(
    it,
    'matches an independent effective-edge and priority model for every direction',
    {
      base: FC.array(edgeArbitrary, {maxLength: 30}),
      current: FC.array(edgeArbitrary, {maxLength: 30}),
      deleted: FC.array(
        FC.integer({min: 0, max: 23}).map(value => `edge-${value}`),
        {maxLength: 16},
      ),
      overlay: FC.boolean(),
      // The store returns early for empty node/provenance admissions before
      // invoking a directional query with its forced partial index.
      nodes: FC.array(
        FC.integer({min: 0, max: 5}).map(value => `node-${value}`),
        {minLength: 1, maxLength: 10},
      ),
      allowed: FC.array(FC.constantFrom(...provenances), {minLength: 1, maxLength: 7}),
      limit: FC.integer({min: -2, max: 25}).map(value => value + 0.75),
    },
    ({base, current, deleted, overlay, nodes, allowed, limit}) => {
      const baseRows = EffectArray.map(base, row => ({...row, snapshot_id: baseSnapshot}));
      const currentRows = EffectArray.map(current, row => ({...row, snapshot_id: currentSnapshot}));
      const effective = effectiveRows(overlay ? baseRows : [], currentRows, deleted);
      withDatabase(baseRows, currentRows, deleted, database => {
        for (const direction of directions) {
          const expected = adjacentRows(effective, nodes, direction, limit, allowed);
          const args = [currentSnapshot, overlay ? baseSnapshot : undefined, nodes, direction, limit, allowed] as const;
          const baseline = rows<EdgeRow>(database, codeGraphAdjacencyQueryStatement(...args));
          const traversal = rows<TraversalRow>(database, codeGraphTraversalQueryStatement(...args));

          expect(baseline).toEqual(expected);
          if (!overlay) {
            // An explicit empty base retains the former SQL path; the model
            // above independently checks its selection, priority and dedup.
            const previous = codeGraphAdjacencyQueryStatement(currentSnapshot, '', nodes, direction, limit, allowed);
            expect(baseline).toEqual(rows<EdgeRow>(database, previous));
            expect(codeGraphAdjacencyQueryStatement(...args).text).not.toContain('base_edges');
          }
          expect(traversal).toEqual(EffectArray.map(expected, project));
          expect(new Set(EffectArray.map(traversal, row => row.id)).size).toBe(traversal.length);
          const ids = EffectArray.map(traversal, row => row.id).reverse();
          const hydrated = rows<EdgeRow>(
            database,
            codeGraphEdgesByIdsQueryStatement(currentSnapshot, overlay ? baseSnapshot : undefined, [
              ...ids,
              ...ids,
              'missing-edge',
            ]),
          );
          expect(byIdentity(hydrated)).toEqual(byIdentity(expected));
        }
      });
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'conserves root visualization symbol sampling against the former SQL and an independent scope-order model',
    {
      symbols: FC.array(
        FC.record({
          id: FC.integer({min: 0, max: 23}).map(value => `symbol-${value}`),
          scope: FC.constantFrom(null, 'component-a', 'component-b'),
          package: FC.constantFrom(null, '', 'pkg-a', 'pkg-b'),
          path: FC.constantFrom('src/first.ts', 'apps/second.ts', 'root.ts'),
          qualified: FC.constantFrom('Alpha', 'beta', 'tie'),
          language: FC.constantFrom('typescript', 'markdown'),
          kind: FC.constantFrom('package', 'module', 'class', 'interface', 'function', 'method', 'document', 'other'),
          exported: FC.integer({min: 0, max: 1}),
        }),
        {maxLength: 35},
      ),
      limit: FC.integer({min: -2, max: 25}).map(value => value + 0.75),
    },
    ({symbols, limit}) => {
      withDatabase([], [], [], database => {
        database.exec(`CREATE TABLE symbols (
          snapshot_id TEXT NOT NULL,id TEXT NOT NULL,resolution_scope_id TEXT,package_name TEXT,
          path TEXT NOT NULL,qualified_name TEXT NOT NULL,language TEXT NOT NULL,kind TEXT NOT NULL,
          exported INTEGER NOT NULL,PRIMARY KEY(snapshot_id,id)) WITHOUT ROWID;
          CREATE TABLE snapshot_symbol_deletions (
            snapshot_id TEXT NOT NULL,symbol_id TEXT NOT NULL,PRIMARY KEY(snapshot_id,symbol_id)) WITHOUT ROWID;
          CREATE INDEX symbols_export_order ON symbols(snapshot_id,path,qualified_name,id);`);
        for (const index of CODE_GRAPH_QUERY_INDEX_DEFINITIONS)
          if (index.name === 'symbols_visualization_scope_v2') database.exec(index.createSql);
        const insert = database.query('INSERT OR REPLACE INTO symbols VALUES(?,?,?,?,?,?,?,?,?)');
        for (const symbol of symbols) {
          for (const snapshot of [currentSnapshot, baseSnapshot, 'unrelated']) {
            insert.run(
              snapshot,
              symbol.id,
              symbol.scope,
              symbol.package,
              symbol.path,
              symbol.qualified,
              symbol.language,
              symbol.kind,
              symbol.exported,
            );
          }
        }
        const unique = [...new Map(EffectArray.map(symbols, symbol => [symbol.id, symbol])).values()];
        const scopes: readonly CodeGraphVisualizationScope[] = [
          {type: 'all'},
          {type: 'component', value: 'component-a'},
          {type: 'component', value: 'missing'},
          {type: 'package', value: 'pkg-a'},
          {type: 'path', value: 'src'},
          {type: 'path', value: '(root)'},
          {type: 'unscoped'},
          {type: 'documentation-facet'},
        ];
        for (const scope of scopes) {
          const expected = EffectArray.filter(unique, symbol => {
            switch (scope.type) {
              case 'all':
                return true;
              case 'component':
                return symbol.scope === scope.value;
              case 'package':
                return symbol.scope === null && symbol.package === scope.value;
              case 'path': {
                const parts = EffectString.split('/')(symbol.path);
                return (
                  symbol.scope === null &&
                  (symbol.package === null || EffectString.trim(symbol.package) === '') &&
                  (parts.length > 1 ? parts[0] : '(root)') === scope.value
                );
              }
              case 'unscoped':
                return symbol.scope === null;
              case 'documentation-facet':
                return (
                  symbol.scope === null &&
                  (symbol.language === 'markdown' || ['document', 'heading', 'section'].includes(symbol.kind))
                );
            }
          })
            .sort((left, right) => {
              if (scope.type === 'all')
                return compareTuple([left.path, left.qualified, left.id], [right.path, right.qualified, right.id]);
              const kind = (value: string) =>
                ['package', 'module', 'class', 'interface', 'function', 'method'].indexOf(value);
              return compareTuple(
                [-left.exported, kind(left.kind) < 0 ? 6 : kind(left.kind), left.id],
                [-right.exported, kind(right.kind) < 0 ? 6 : kind(right.kind), right.id],
              );
            })
            .slice(0, Math.max(1, Math.min(500, Math.floor(limit))));
          const current = codeGraphVisualizationSymbolsQueryStatement(currentSnapshot, undefined, scope, limit);
          const previous = codeGraphVisualizationSymbolsQueryStatement(currentSnapshot, '', scope, limit);
          const actual = rows<{id: string; snapshot_id: string}>(database, current);
          expect(actual).toEqual(rows(database, previous));
          expect(EffectArray.map(actual, row => row.id)).toEqual(EffectArray.map(expected, symbol => symbol.id));
          expect(EffectArray.every(actual, row => row.snapshot_id === currentSnapshot)).toBe(true);
          expect(current.text).not.toContain('base_symbols');
        }
      });
    },
    {fastCheck: {numRuns: 40, seed: 424244}},
  );

  it('leaves the existing overlay SQL and parameters unchanged', () => {
    // Captured from the f917 preimage, not calculated from an optimized root query.
    const adjacency = [
      '3987c62b216bb90aa4255b060b0cce3029ab74ff7199e5d6e1cf929df5ca23da',
      '6cc29a325f2ed362511bf3b812a89d963113cff4c35d705232a13a81d0f7c3f4',
      '907f752dec6644cf85f8090bd57725ff2bc5fc835bcd95f6fcc2fdc716249c13',
    ];
    for (const [index, direction] of directions.entries()) {
      expect(
        sha256HexSync(
          JSON.stringify(
            codeGraphAdjacencyQueryStatement(
              currentSnapshot,
              baseSnapshot,
              ['node-0', 'node-1'],
              direction,
              7,
              provenances,
            ),
          ),
        ),
      ).toBe(adjacency[index]);
    }
    expect(
      sha256HexSync(
        JSON.stringify(codeGraphVisualizationSymbolsQueryStatement(currentSnapshot, baseSnapshot, {type: 'all'}, 7)),
      ),
    ).toBe('af2b37a950da3f23862e925a10c8e2ccc9d9457041b51c296172a9e43df51464');
    expect(
      sha256HexSync(
        JSON.stringify(
          codeGraphVisualizationSymbolsQueryStatement(
            currentSnapshot,
            baseSnapshot,
            {type: 'component', value: 'component-a'},
            7,
          ),
        ),
      ),
    ).toBe('8d2805075ba68ced787e94f26177515ebded61b3daef52b03f4b6192328cf82e');
  });

  it('preserves priority ties, all provenance tiers, parallel edges, self-loops, and unresolved endpoints', () => {
    const base = EffectArray.flatMap(provenances, (provenance, provenanceIndex) =>
      EffectArray.flatMap(relations, (relation, relationIndex) =>
        EffectArray.map([0, 1], parallel =>
          edge(baseSnapshot, `${provenanceIndex}-${relationIndex}-${parallel}`, {
            provenance,
            relation,
            confidence: parallel === 0 ? 0.5 : 1,
          }),
        ),
      ),
    );
    const current = [
      edge(currentSnapshot, 'tie-b'),
      edge(currentSnapshot, 'tie-a'),
      edge(currentSnapshot, 'self-loop', {target_id: 'node-0'}),
      edge(currentSnapshot, 'unresolved-source', {source_id: null, target_id: 'node-0'}),
      edge(currentSnapshot, 'unresolved-target', {target_id: null}),
      edge(currentSnapshot, 'unresolved-both', {source_id: null, target_id: null}),
    ];
    const effective = effectiveRows(base, current, []);
    withDatabase([...base].reverse(), [...current].reverse(), [], database => {
      for (const direction of directions) {
        for (const limit of [1, 7, 100]) {
          const args = [currentSnapshot, baseSnapshot, ['node-0'], direction, limit, provenances] as const;
          const expected = adjacentRows(effective, ['node-0'], direction, limit, provenances);
          expect(rows<EdgeRow>(database, codeGraphAdjacencyQueryStatement(...args))).toEqual(expected);
          expect(rows<TraversalRow>(database, codeGraphTraversalQueryStatement(...args))).toEqual(
            EffectArray.map(expected, project),
          );
        }
      }
    });
  });

  it('suppresses base rows even when their replacements no longer match the requested node or provenance', () => {
    const base = EffectArray.map(['moved', 'disallowed', 'deleted', 'recreated', 'retained'], id =>
      edge(baseSnapshot, id),
    );
    const current = [
      edge(currentSnapshot, 'moved', {source_id: 'node-5', target_id: 'node-5'}),
      edge(currentSnapshot, 'disallowed', {provenance: 'model'}),
      edge(currentSnapshot, 'recreated', {evidence_path: 'src/recreated.ts'}),
    ];
    withDatabase(base, current, ['deleted', 'recreated'], database => {
      const actual = rows<TraversalRow>(
        database,
        codeGraphTraversalQueryStatement(currentSnapshot, baseSnapshot, ['node-0'], 'both', 100, ['declared']),
      );
      expect(EffectArray.map(actual, row => row.id)).toEqual(['recreated', 'retained']);
      const hydrated = rows<EdgeRow>(
        database,
        codeGraphEdgesByIdsQueryStatement(currentSnapshot, baseSnapshot, [
          'deleted',
          'moved',
          'disallowed',
          'recreated',
          'retained',
          'recreated',
          'missing',
        ]),
      );
      expect(byIdentity(hydrated)).toEqual(byIdentity([...current, base[4]]));
    });
  });

  it('admits the first 500 unique node IDs before evaluating adjacency', () => {
    const current = Array.from({length: 501}, (_, index) =>
      edge(currentSnapshot, `edge-${index}`, {source_id: `node-${index}`, target_id: `node-${index}`}),
    );
    const nodes = EffectArray.flatMap(current, row => [row.source_id!, row.source_id!]);
    withDatabase([], current, [], database => {
      for (const direction of directions) {
        for (const requested of [nodes, [...nodes].reverse()]) {
          const expected = adjacentRows(current, requested, direction, 5_000, provenances);
          const args = [currentSnapshot, undefined, requested, direction, 5_000, provenances] as const;
          expect(expected).toHaveLength(500);
          expect(rows<EdgeRow>(database, codeGraphAdjacencyQueryStatement(...args))).toEqual(expected);
          expect(rows<TraversalRow>(database, codeGraphTraversalQueryStatement(...args))).toEqual(
            EffectArray.map(expected, project),
          );
        }
      }
    });
  });

  it('caps a mixed base and overlay hub at 5000 globally ordered distinct edges', () => {
    const base = Array.from({length: 5_002}, (_, index) =>
      edge(baseSnapshot, `base-${Effect.pipe(index.toString(), EffectString.padStart(4, '0'))}`),
    );
    const current = Array.from({length: 5_002}, (_, index) =>
      edge(currentSnapshot, `current-${Effect.pipe(index.toString(), EffectString.padStart(4, '0'))}`, {
        confidence: index % 2 === 0 ? 1 : 0.5,
        target_id: 'node-0',
      }),
    );
    current.push(edge(currentSnapshot, base[0].id, {confidence: 0.25, evidence_path: 'src/replacement.ts'}));
    const deleted = [base[1].id];
    const expected = adjacentRows(effectiveRows(base, current, deleted), ['node-0'], 'both', 10_000, provenances);
    withDatabase(base, current, deleted, database => {
      const args = [currentSnapshot, baseSnapshot, ['node-0'], 'both', 10_000, provenances] as const;
      const actual = rows<TraversalRow>(database, codeGraphTraversalQueryStatement(...args));
      expect(actual).toHaveLength(5_000);
      expect(actual).toEqual(EffectArray.map(expected, project));
      expect(rows<EdgeRow>(database, codeGraphAdjacencyQueryStatement(...args))).toEqual(expected);
    });
  });

  it('hydrates only the first 400 unique requested identities without admitting another snapshot', () => {
    const base = Array.from({length: 401}, (_, index) => edge(baseSnapshot, `edge-${index}`));
    const current = [edge(currentSnapshot, 'edge-0', {evidence_path: 'src/replacement.ts'})];
    const requested = EffectArray.flatMap([...base].reverse(), row => [row.id, row.id]);
    const effective = new Map(EffectArray.map(effectiveRows(base, current, ['edge-5']), row => [row.id, row]));
    const expected = EffectArray.flatMap([...new Set(requested)].slice(0, 400), id =>
      effective.has(id) ? [effective.get(id)!] : [],
    );
    withDatabase(base, current, ['edge-5'], database => {
      const hydrated = rows<EdgeRow>(
        database,
        codeGraphEdgesByIdsQueryStatement(currentSnapshot, baseSnapshot, requested),
      );
      expect(byIdentity(hydrated)).toEqual(byIdentity(expected));
      expect(EffectArray.some(hydrated, row => row.id === 'edge-0')).toBe(false);
      expect(rows(database, codeGraphEdgesByIdsQueryStatement(currentSnapshot, baseSnapshot, []))).toEqual([]);
    });
  });

  it('retains directional index seeks and primary-key hydration seeks', () => {
    withDatabase([], [edge(currentSnapshot, 'example')], [], database => {
      const statement = codeGraphTraversalQueryStatement(
        currentSnapshot,
        baseSnapshot,
        ['node-0'],
        'both',
        10,
        provenances,
      );
      const plan = rows<{detail: string}>(database, {...statement, text: `EXPLAIN QUERY PLAN ${statement.text}`});
      expect(
        EffectArray.filter(
          plan,
          (row, __effectArrayIndex) =>
            __effectArrayIndex in plan && Effect.pipe(row.detail, EffectString.includes('edges_source')),
        ),
      ).toHaveLength(2);
      expect(
        EffectArray.filter(
          plan,
          (row, __effectArrayIndex) =>
            __effectArrayIndex in plan && Effect.pipe(row.detail, EffectString.includes('edges_target_resolved')),
        ),
      ).toHaveLength(2);
      expect(
        EffectArray.join(
          EffectArray.map(plan, row => row.detail),
          '\n',
        ),
      ).not.toMatch(/SCAN (?:current_edges|base_edges)/u);
      const hydration = codeGraphEdgesByIdsQueryStatement(currentSnapshot, baseSnapshot, ['example']);
      const hydrationPlan = rows<{detail: string}>(database, {
        ...hydration,
        text: `EXPLAIN QUERY PLAN ${hydration.text}`,
      });
      expect(
        EffectArray.join(
          EffectArray.map(hydrationPlan, row => row.detail),
          '\n',
        ),
      ).not.toMatch(/SCAN (?:current_edges|base_edges)/u);
      expect(
        EffectArray.filter(hydrationPlan, row =>
          /SEARCH (?:current_edges|base_edges).*snapshot_id=\? AND id=\?/u.test(row.detail),
        ),
      ).toHaveLength(2);
    });
  });
});

function edge(snapshot_id: string, id: string, overrides: Partial<EdgeRow> = {}): EdgeRow {
  return {
    snapshot_id,
    id,
    source_id: 'node-0',
    source_name: 'source',
    target_id: 'node-1',
    target_name: 'target',
    relation: 'calls',
    provenance: 'declared',
    confidence: 1,
    evidence_path: `src/${snapshot_id}/${id}.ts`,
    evidence_span_json: JSON.stringify({line: 1, column: 2, endLine: 3, endColumn: 4}),
    ...overrides,
  };
}

function effectiveRows(base: readonly EdgeRow[], current: readonly EdgeRow[], deleted: readonly string[]): EdgeRow[] {
  const effective = new Map(EffectArray.map(base, row => [row.id, row]));
  for (const id of deleted) effective.delete(id);
  for (const row of current) effective.set(row.id, row);
  return [...effective.values()];
}

function adjacentRows(
  effective: readonly EdgeRow[],
  nodes: readonly string[],
  direction: Direction,
  limit: number,
  allowed: readonly CodeGraphProvenance[],
): EdgeRow[] {
  const requested = new Set([...new Set(nodes)].slice(0, 500));
  return EffectArray.filter(effective, row => {
    const outgoing = row.source_id !== null && requested.has(row.source_id);
    const incoming = row.target_id !== null && requested.has(row.target_id);
    return (
      allowed.includes(row.provenance) &&
      (direction === 'both' ? outgoing || incoming : direction === 'outgoing' ? outgoing : incoming)
    );
  })
    .sort((left, right) => compareTuple(priority(left), priority(right)))
    .slice(0, Math.max(1, Math.min(5_000, Math.floor(limit))));
}

function priority(row: EdgeRow): readonly (number | string)[] {
  return [
    Number(row.source_id === null || row.target_id === null),
    Number(row.provenance === 'heuristic' || row.provenance === 'model'),
    Number(!['exports', 'imports', 'reexports', 'tests'].includes(row.relation)),
    ({declared: 0, resolved: 1, syntactic: 2, heuristic: 3, model: 3} as const)[row.provenance],
    -row.confidence,
    row.source_name,
    row.relation,
    row.target_name,
    row.id,
  ];
}

function compareTuple(left: readonly (number | string)[], right: readonly (number | string)[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function project(row: EdgeRow): TraversalRow {
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    relation: row.relation,
    provenance: row.provenance,
    confidence: row.confidence,
  };
}

function byIdentity(input: readonly EdgeRow[]): EdgeRow[] {
  return [...input].sort((left, right) => compareTuple([left.id], [right.id]));
}

function rows<Row>(database: Database, statement: Statement): Row[] {
  return database.query<Row, SQLQueryBindings[]>(statement.text).all(...statement.parameters);
}

function withDatabase(
  base: readonly EdgeRow[],
  current: readonly EdgeRow[],
  deleted: readonly string[],
  run: (database: Database) => void,
): void {
  const database = new Database(':memory:', {strict: true});
  try {
    database.exec(`
      CREATE TABLE edges (
        snapshot_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT, source_name TEXT NOT NULL,
        relation TEXT NOT NULL, target_id TEXT, target_name TEXT NOT NULL, provenance TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        evidence_path TEXT NOT NULL, evidence_span_json TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, id)
      ) WITHOUT ROWID;
      CREATE TABLE snapshot_edge_deletions (
        snapshot_id TEXT NOT NULL, edge_id TEXT NOT NULL, PRIMARY KEY (snapshot_id, edge_id)
      ) WITHOUT ROWID;
      CREATE INDEX edges_source ON edges(snapshot_id, source_id, relation);
      CREATE INDEX edges_target_resolved ON edges(snapshot_id, target_id, relation) WHERE target_id IS NOT NULL;
    `);
    database.transaction(() => {
      const insert = database.query(`INSERT OR REPLACE INTO edges (
        snapshot_id, id, source_id, source_name, relation, target_id, target_name,
        provenance, confidence, evidence_path, evidence_span_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of [...base, ...current, edge('unrelated', 'unrelated-edge')]) {
        insert.run(
          row.snapshot_id,
          row.id,
          row.source_id,
          row.source_name,
          row.relation,
          row.target_id,
          row.target_name,
          row.provenance,
          row.confidence,
          row.evidence_path,
          row.evidence_span_json,
        );
      }
      const tombstone = database.query('INSERT OR REPLACE INTO snapshot_edge_deletions VALUES (?, ?)');
      for (const id of deleted) tombstone.run(currentSnapshot, id);
    })();
    run(database);
  } finally {
    database.close(false);
  }
}
