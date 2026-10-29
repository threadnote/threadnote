import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {
  codeGraphAnalysisEdgeAggregatePageStatement,
  codeGraphAnalysisSymbolAggregatePageStatement,
} from '@threadnote/graph/store';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const BASE = 'base';
const CURRENT = 'current';

interface AggregateSpec {
  readonly id: number;
  readonly kind: 'class' | 'function' | 'method';
  readonly language: 'java' | 'kotlin' | 'typescript';
  readonly provenance: 'declared' | 'resolved' | 'syntactic';
  readonly relation: 'calls' | 'contains' | 'references';
}

const aggregateSpec = FC.record({
  id: FC.integer({max: 60, min: 0}),
  kind: FC.constantFrom('class' as const, 'function' as const, 'method' as const),
  language: FC.constantFrom('java' as const, 'kotlin' as const, 'typescript' as const),
  provenance: FC.constantFrom('declared' as const, 'resolved' as const, 'syntactic' as const),
  relation: FC.constantFrom('calls' as const, 'contains' as const, 'references' as const),
});

describe('code graph analysis aggregate store', () => {
  fcEffectProp(
    it,
    'matches full effective-overlay counts across randomized keyset page boundaries',
    {
      base: FC.array(aggregateSpec, {maxLength: 60}),
      current: FC.array(aggregateSpec, {maxLength: 30}),
      deleted: FC.array(FC.integer({max: 60, min: 0}), {maxLength: 30}),
      pageSize: FC.integer({max: 13, min: 1}),
    },
    ({base, current, deleted, pageSize}) =>
      Effect.sync(() => {
        const database = aggregateDatabase();
        try {
          const baseById = lastById(base);
          const currentById = lastById(current);
          const deletions = new Set(EffectArray.map(deleted, rowId));
          insertSpecs(database, BASE, [...baseById.values()]);
          insertSpecs(database, CURRENT, [...currentById.values()]);
          insertDeletions(database, deletions);

          const effective = new Map(currentById);
          for (const [id, spec] of baseById) {
            if (!currentById.has(id) && !deletions.has(id)) effective.set(id, spec);
          }

          expect(scanSymbolCounts(database, pageSize)).toEqual(
            groupedCounts([...effective.values()], value => `${value.language}\0${value.kind}`),
          );
          expect(scanEdgeCounts(database, pageSize)).toEqual(
            groupedCounts([...effective.values()], value => `${value.provenance}\0${value.relation}`),
          );
        } finally {
          database.close(false);
        }
      }),
    {fastCheck: {numRuns: 60}},
  );

  it('uses primary-key range seeks in both overlay branches', () => {
    const database = aggregateDatabase();
    try {
      for (const statement of [
        codeGraphAnalysisSymbolAggregatePageStatement(CURRENT, BASE, 'row-000100', 257),
        codeGraphAnalysisEdgeAggregatePageStatement(CURRENT, BASE, 'row-000100', 257),
      ]) {
        const plan = EffectArray.map(
          database
            .query<
              {
                readonly detail: string;
              },
              SQLQueryBindings[]
            >(`EXPLAIN QUERY PLAN ${statement.text}`)
            .all(...statement.parameters),
          row => row.detail,
        );
        expect(
          EffectArray.filter(plan, detail =>
            Effect2.pipe(detail, EffectString.includes('PRIMARY KEY (snapshot_id=? AND id>?)')),
          ),
        ).toHaveLength(2);
        expect(EffectArray.join(plan, '\n')).not.toMatch(/SCAN (?:current|base)_(?:symbols|edges)/u);
      }
    } finally {
      database.close(false);
    }
  });

  it('scans a large overlay in work proportional to rows rather than page count times snapshot size', () => {
    const database = aggregateDatabase();
    try {
      const insertSymbol = database.query('INSERT INTO symbols (snapshot_id, id, language, kind) VALUES (?, ?, ?, ?)');
      const insertEdge = database.query(
        `INSERT INTO edges (
          snapshot_id, id, provenance, relation, confidence, source_id, target_id
        ) VALUES (?, ?, 'resolved', 'calls', 1, ?, ?)`,
      );
      database.transaction(() => {
        for (let index = 0; index < 50_000; index += 1) {
          const id = rowId(index);
          insertSymbol.run(BASE, id, index % 2 === 0 ? 'typescript' : 'java', 'function');
          insertEdge.run(BASE, id, id, rowId((index + 1) % 50_000));
        }
      })();

      const startedAt = performance.now();
      const symbols = scanSymbolCounts(database, 257);
      const edges = scanEdgeCounts(database, 257);
      const elapsedMilliseconds = performance.now() - startedAt;

      expect(totalCounts(symbols)).toBe(50_000);
      expect(totalCounts(edges)).toBe(50_000);
      expect(elapsedMilliseconds).toBeLessThan(3_000);
    } finally {
      database.close(false);
    }
  }, 10_000);
});

function aggregateDatabase(): Database {
  const database = new Database(':memory:', {strict: true});
  database.run(`CREATE TABLE symbols (
    snapshot_id TEXT NOT NULL, id TEXT NOT NULL, language TEXT NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, id)
  ) WITHOUT ROWID`);
  database.run(`CREATE TABLE edges (
    snapshot_id TEXT NOT NULL, id TEXT NOT NULL, provenance TEXT NOT NULL, relation TEXT NOT NULL,
    confidence REAL NOT NULL, source_id TEXT, target_id TEXT,
    PRIMARY KEY (snapshot_id, id)
  ) WITHOUT ROWID`);
  database.run(`CREATE TABLE snapshot_symbol_deletions (
    snapshot_id TEXT NOT NULL, symbol_id TEXT NOT NULL, PRIMARY KEY (snapshot_id, symbol_id)
  ) WITHOUT ROWID`);
  database.run(`CREATE TABLE snapshot_edge_deletions (
    snapshot_id TEXT NOT NULL, edge_id TEXT NOT NULL, PRIMARY KEY (snapshot_id, edge_id)
  ) WITHOUT ROWID`);
  return database;
}

function insertSpecs(database: Database, snapshotId: string, specs: readonly AggregateSpec[]): void {
  const insertSymbol = database.query('INSERT INTO symbols (snapshot_id, id, language, kind) VALUES (?, ?, ?, ?)');
  const insertEdge = database.query(
    `INSERT INTO edges (
      snapshot_id, id, provenance, relation, confidence, source_id, target_id
    ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
  );
  database.transaction(() => {
    for (const spec of specs) {
      const id = rowId(spec.id);
      insertSymbol.run(snapshotId, id, spec.language, spec.kind);
      insertEdge.run(snapshotId, id, spec.provenance, spec.relation, id, id);
    }
  })();
}

function insertDeletions(database: Database, ids: ReadonlySet<string>): void {
  const symbolDeletion = database.query('INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id) VALUES (?, ?)');
  const edgeDeletion = database.query('INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id) VALUES (?, ?)');
  database.transaction(() => {
    for (const id of ids) {
      symbolDeletion.run(CURRENT, id);
      edgeDeletion.run(CURRENT, id);
    }
  })();
}

function scanSymbolCounts(database: Database, pageSize: number): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  while (true) {
    const statement = codeGraphAnalysisSymbolAggregatePageStatement(CURRENT, BASE, cursor, pageSize);
    const rows = database
      .query<
        {
          readonly count: number;
          readonly kind: string;
          readonly language: string;
          readonly last_id: string;
        },
        SQLQueryBindings[]
      >(statement.text)
      .all(...statement.parameters);
    if (rows.length === 0) break;
    for (const row of rows) increment(counts, `${row.language}\0${row.kind}`, Number(row.count));
    cursor = maximumLastId(rows);
  }
  return counts;
}

function scanEdgeCounts(database: Database, pageSize: number): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  while (true) {
    const statement = codeGraphAnalysisEdgeAggregatePageStatement(CURRENT, BASE, cursor, pageSize);
    const rows = database
      .query<
        {
          readonly count: number;
          readonly last_id: string;
          readonly provenance: string;
          readonly relation: string;
        },
        SQLQueryBindings[]
      >(statement.text)
      .all(...statement.parameters);
    if (rows.length === 0) break;
    for (const row of rows) increment(counts, `${row.provenance}\0${row.relation}`, Number(row.count));
    cursor = maximumLastId(rows);
  }
  return counts;
}

function maximumLastId(rows: readonly {readonly last_id: string}[]): string {
  return EffectArray.reduce(rows, '', (maximum, row) => (row.last_id > maximum ? row.last_id : maximum));
}

function groupedCounts<Value>(values: readonly Value[], key: (value: Value) => string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) increment(counts, key(value), 1);
  return counts;
}

function increment(counts: Map<string, number>, key: string, amount: number): void {
  counts.set(key, (counts.get(key) ?? 0) + amount);
}

function totalCounts(counts: ReadonlyMap<string, number>): number {
  return EffectArray.reduce([...counts.values()], 0, (total, count) => total + count);
}

function lastById(values: readonly AggregateSpec[]): ReadonlyMap<string, AggregateSpec> {
  const result = new Map<string, AggregateSpec>();
  for (const value of values) result.set(rowId(value.id), value);
  return result;
}

function rowId(value: number): string {
  return `row-${Effect2.pipe(value.toString(), EffectString.padStart(6, '0'))}`;
}
