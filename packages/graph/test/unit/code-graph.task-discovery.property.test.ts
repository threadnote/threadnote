import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {it, expect} from 'vitest';
import fc from 'fast-check';
import {Database} from 'bun:sqlite';
import {PERSISTENT_EXTENSION_TABLES} from '@threadnote/graph/store/schema/contracts';
import {
  taskBoundedText,
  taskPostingStatement,
  taskHeaderStatement,
  taskNodeStatement,
  taskExpansionStatement,
} from '@threadnote/graph/store/query/core';
import {CODE_GRAPH_QUERY_INDEX_DEFINITIONS} from '@threadnote/graph/store/query/indexes';
import {rankTaskPostings, selectTaskSeeds, type TaskPosting} from '@threadnote/graph/query/task_discovery';

const id = (n: number) => `cgs_${EffectString.padStart(32, '0')(n.toString(16))}`;
it('keeps body admission under bounded metadata decoy injection and finite input permutations', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.integer({min: 1, max: 1_000}), {maxLength: 127}),
      fc.integer({min: 1, max: 12}),
      fc.boolean(),
      (decoys, limit, reverse) => {
        const rows: TaskPosting[] = EffectArray.map(decoys, n => ({
          id: id(n),
          term: 'pending',
          weight: 5,
          path: 'decoy.ts',
          package_name: 'scope',
          content_hash: EffectString.repeat(64)('a'),
          eligible: 1,
        }));
        const body = rankTaskPostings(
          [
            {
              id: id(0),
              term: '~body:v1:pending',
              weight: 1,
              path: 'a.ts',
              package_name: 'scope',
              content_hash: EffectString.repeat(64)('b'),
              eligible: 1,
            },
          ],
          'body',
          {packageName: 'scope'},
        );
        const metadata = rankTaskPostings(reverse ? [...rows].reverse() : rows, 'metadata', {packageName: 'scope'});
        const selected = selectTaskSeeds(metadata, body, limit);
        expect(selected[0].id).toBe(id(0));
        expect(selected.length).toBeLessThanOrEqual(limit);
        expect(new Set(EffectArray.map(selected, candidate => candidate.id)).size).toBe(selected.length);
        expect(EffectArray.map(metadata, candidate => candidate.id)).toEqual(
          EffectArray.map(
            [...decoys].sort((a, b) => a - b),
            id,
          ),
        );
      },
    ),
    {numRuns: 40},
  );
});
it('filters finite foreign/stale batches before candidate cut and never conflates lexical origins', () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), {minLength: 1, maxLength: 126}), flags => {
      const rows: TaskPosting[] = EffectArray.map(flags, (valid, index) => ({
        id: id(index),
        term: '~body:v1:journal',
        weight: 1,
        path: valid ? 'allowed/a.py' : 'foreign/b.py',
        package_name: 'p',
        content_hash: EffectString.repeat(64)('a'),
        eligible: valid ? 1 : 0,
      }));
      const result = rankTaskPostings(rows, 'body', {paths: ['allowed']});
      expect(new Set(EffectArray.map(result, candidate => candidate.id))).toEqual(
        new Set(EffectArray.flatMap(flags, (flag, i) => (flag ? [id(i)] : []))),
      );
      expect(rankTaskPostings(rows, 'metadata', {})).toEqual([]);
      expect(rankTaskPostings(rows, 'body', {packageName: 'foreign'})).toEqual([]);
    }),
    {numRuns: 35},
  );
});

// The relevant core DDL retains the production WITHOUT ROWID, types and constraints.
// Lexical DDL comes directly from its schema owner, including its deliberately absent dictionary FK.
function postingDatabase(useCompact: boolean, whole = false) {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; ${
    whole
      ? `CREATE TABLE repositories(id TEXT PRIMARY KEY); INSERT INTO repositories VALUES('r');
CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      worktree_id TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      graph_content_id TEXT,
      base_snapshot_id TEXT,
      extractor_set TEXT NOT NULL,
      dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
      overlay_fingerprint TEXT,
      state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed', 'retired')),
      file_count INTEGER NOT NULL CHECK (file_count >= 0),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failure_summary TEXT
    );
INSERT INTO snapshots(id,repository_id,worktree_id,commit_id,extractor_set,dirty,state,file_count,symbol_count,edge_count,started_at)
VALUES('snap','r','w','c','e',0,'ready',0,0,0,'now'),('other','r','w','c','e',0,'ready',0,0,0,'now');`
      : `CREATE TABLE snapshots(id TEXT PRIMARY KEY); INSERT INTO snapshots VALUES('snap'),('other');`
  }
CREATE TABLE snapshot_files (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    raw_content_hash TEXT,
    language TEXT NOT NULL,
    mode TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    source TEXT NOT NULL CHECK (source IN ('commit', 'worktree')),
    PRIMARY KEY (snapshot_id, path)
  ) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS symbols (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      arity INTEGER,
      lookup_keys_json TEXT NOT NULL,
      resolution_domain TEXT,
      resolution_scope_id TEXT,
      package_name TEXT,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS symbol_terms (
      snapshot_id TEXT NOT NULL,
      term TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (snapshot_id, term, symbol_id),
      FOREIGN KEY (snapshot_id, symbol_id) REFERENCES symbols(snapshot_id, id) ON DELETE CASCADE
    ) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshot_symbol_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      symbol_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, symbol_id)
    ) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshot_file_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID;`);
  for (const table of PERSISTENT_EXTENSION_TABLES) if (table.group === 'lexical') db.exec(table.createSql);
  if (useCompact)
    db.exec(`INSERT INTO lexical_compact_snapshots VALUES(1,'snap'),(2,'other');
    INSERT INTO lexical_storage_formats VALUES('snap',1,0,0,0,'now');
    INSERT INTO lexical_compact_terms VALUES(1,1,'pending');`);
  if (whole) {
    db.exec(`CREATE TABLE IF NOT EXISTS edges (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshot_edge_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id)
    ) WITHOUT ROWID;`);
    for (const index of CODE_GRAPH_QUERY_INDEX_DEFINITIONS)
      if (index.name === 'edges_source' || index.name === 'edges_target_resolved') db.exec(index.createSql);
  }
  return db;
}
function postingSymbol(db: Database, symbolId: string) {
  db.query(
    `INSERT INTO symbols(snapshot_id,id,content_hash,kind,name,qualified_name,path,language,lookup_keys_json,exported,span_json)
    VALUES('snap',? ,?,'function','f','f',?,'typescript','[]',1,'{}')`,
  ).run(symbolId, EffectString.repeat(64)('a'), symbolId + '.ts');
  db.query(
    `INSERT INTO snapshot_files(snapshot_id,path,content_hash,language,mode,size,source)
    VALUES('snap',?,?,'typescript','100644',1,'commit')`,
  ).run(symbolId + '.ts', EffectString.repeat(64)('a'));
}
interface NativePosting {
  id: string | null;
  weight: number | null;
  path: string | null;
  package_name: string | null;
  eligible: number;
  row_valid: number;
  transfer_valid: number;
}
it('does not prepare an absent base contributor for full-snapshot expansion', () => {
  const full = taskExpansionStatement('snap', undefined, [id(0), id(1)], 128);
  const inherited = taskExpansionStatement('snap', 'other', [id(0), id(1)], 128);
  expect(full.parameters).not.toContain('');
  expect(Buffer.byteLength(full.text)).toBeLessThan(Buffer.byteLength(inherited.text));
  // The production frontier is capped at12; larger SQL bypasses Bun's64KiB query cache.
  const widestFull = taskExpansionStatement('snap', undefined, EffectArray.makeBy(12, id), 128);
  expect(Buffer.byteLength(widestFull.text)).toBeLessThanOrEqual(64 * 1024);
});
it('preserves full and inherited raw expansion order, omissions and the shared edge cap', () => {
  const edgeCase = fc.record({
    snapshot: fc.constantFrom('snap', 'other'),
    frontier: fc.integer({min: 0, max: 1}),
    incoming: fc.boolean(),
    validity: fc.constantFrom(
      'valid',
      'invalid-provenance',
      'oversize-endpoint',
      'unresolved',
      'oversize-id',
      'blob-id',
    ),
    suppression: fc.constantFrom('none', 'replacement', 'deletion'),
  });
  fc.assert(
    fc.property(
      fc.array(edgeCase, {maxLength: 140}),
      fc.boolean(),
      fc.integer({min: 0, max: 160}),
      (cases, hasBase, limit) => {
        const db = postingDatabase(true, true);
        try {
          const expected = EffectArray.map(cases, (edge, index) => {
            const orderKey = EffectString.padStart(3, '0')(String(index));
            const invalidId = edge.validity === 'oversize-id' || edge.validity === 'blob-id';
            const edgeId =
              edge.validity === 'blob-id'
                ? new Uint8Array([index])
                : edge.validity === 'oversize-id'
                  ? EffectString.repeat(129)('x') + orderKey
                  : `edge-${orderKey}`;
            const opposite =
              edge.validity === 'unresolved'
                ? null
                : edge.validity === 'oversize-endpoint'
                  ? EffectString.repeat(129)('x')
                  : id(index + 100);
            const source = edge.incoming ? opposite : id(edge.frontier);
            const target = edge.incoming ? id(edge.frontier) : opposite;
            const provenance = edge.validity === 'invalid-provenance' ? 'unknown' : 'resolved';
            db.query(
              `INSERT INTO edges(snapshot_id,id,source_id,source_name,relation,target_id,target_name,provenance,confidence,evidence_path,evidence_span_json)
            VALUES(?,?,?,'f','calls',?,'g',?,0.5,'a.ts','{}')`,
            ).run(edge.snapshot, edgeId, source, target, provenance);
            if (edge.snapshot === 'other' && edge.suppression === 'replacement')
              db.query(
                `INSERT INTO edges(snapshot_id,id,source_id,source_name,relation,target_id,target_name,provenance,confidence,evidence_path,evidence_span_json)
              VALUES('snap',?,?,'f','calls',?,'g','resolved',0.5,'a.ts','{}')`,
              ).run(edgeId, id(index + 1000), id(index + 2000));
            if (edge.snapshot === 'other' && edge.suppression === 'deletion')
              db.query("INSERT INTO snapshot_edge_deletions VALUES('snap',?)").run(edgeId);
            return {
              snapshot_id: edge.snapshot,
              id: invalidId ? null : edgeId,
              source_id: invalidId || (edge.validity === 'oversize-endpoint' && edge.incoming) ? null : source,
              target_id: invalidId || (edge.validity === 'oversize-endpoint' && !edge.incoming) ? null : target,
              provenance: invalidId || edge.validity === 'invalid-provenance' ? null : provenance,
              row_valid: edge.validity === 'valid' || edge.validity === 'unresolved' ? 1 : 0,
              // An omitted ID cannot participate in replacement/deletion lookup; row_valid still refuses it.
              eligible: invalidId || edge.snapshot === 'snap' || edge.suppression === 'none' ? 1 : 0,
              // Independent priority tuple: incoming first, frontier order, current before inherited, index order.
              priority: [
                edge.incoming ? 0 : 1,
                edge.frontier,
                edge.snapshot === 'snap' ? 0 : 1,
                typeof edgeId === 'string' ? 0 : 1,
              ],
              orderKey: typeof edgeId === 'string' ? edgeId : orderKey,
            };
          });
          const admitted = EffectArray.filter(expected, edge => edge.snapshot_id === 'snap' || hasBase)
            .sort((a, b) => {
              for (let i = 0; i < a.priority.length; i++) {
                const difference = a.priority[i] - b.priority[i];
                if (difference !== 0) return difference;
              }
              return EffectString.localeCompare(b.orderKey)(a.orderKey);
            })
            .slice(0, Math.min(128, limit));
          const statement = taskExpansionStatement('snap', hasBase ? 'other' : undefined, [id(0), id(1)], limit);
          const rows = db
            .query<Record<string, unknown>, (string | number)[]>(statement.text)
            .all(...statement.parameters);
          expect(rows).toHaveLength(admitted.length);
          EffectArray.forEach(admitted, ({priority: _priority, orderKey: _orderKey, ...expectedRow}, index) => {
            expect(rows[index]).toMatchObject({...expectedRow, transfer_valid: 1});
          });
        } finally {
          db.close();
        }
      },
    ),
    {
      numRuns: 25,
      examples: [
        [
          [
            {snapshot: 'snap', frontier: 0, incoming: true, validity: 'oversize-id', suppression: 'none'},
            {snapshot: 'snap', frontier: 0, incoming: true, validity: 'valid', suppression: 'none'},
          ],
          false,
          1,
        ],
        [
          Array.from({length: 140}, () => ({
            snapshot: 'snap',
            frontier: 0,
            incoming: true,
            validity: 'invalid-provenance',
            suppression: 'none',
          })),
          false,
          160,
        ],
        [
          Array.from({length: 140}, () => ({
            snapshot: 'other',
            frontier: 0,
            incoming: true,
            validity: 'unresolved',
            suppression: 'deletion',
          })),
          true,
          128,
        ],
      ],
    },
  );
});
const postingRows = (db: Database, limit: number) => {
  const statement = taskPostingStatement('snap', undefined, ['pending'], limit);
  return db.query<NativePosting, (string | number)[]>(statement.text).all(...statement.parameters);
};
it('counts dictionary misses and snapshot mismatches inside the raw posting cap before mapping', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('missing', 'mismatch', 'valid', 'invalid-id'), {minLength: 1, maxLength: 150}),
      fc.integer({min: 0, max: 160}),
      (states, limit) => {
        const db = postingDatabase(true);
        try {
          EffectArray.forEach(states, (state, index) => {
            const symbolId = state === 'invalid-id' ? EffectString.repeat(129)('x') + index : id(index);
            if (state !== 'missing')
              db.query('INSERT INTO lexical_compact_symbols VALUES(?,?,?)').run(
                index + 1,
                state === 'mismatch' ? 2 : 1,
                symbolId,
              );
            if (state === 'valid' || state === 'invalid-id') postingSymbol(db, symbolId);
            db.query('INSERT INTO lexical_compact_postings VALUES(1,1,?,1)').run(index + 1);
          });
          const rows = postingRows(db, limit);
          const examined = Math.min(states.length, limit, 128);
          expect(rows).toHaveLength(examined);
          expect(
            new Set(
              EffectArray.map(
                EffectArray.filter(rows, row => row.eligible === 1 && row.id !== null),
                row => row.id,
              ),
            ),
          ).toEqual(
            new Set(EffectArray.flatMap(states.slice(0, examined), (state, i) => (state === 'valid' ? [id(i)] : []))),
          );
          expect(EffectArray.filter(rows, row => row.id === null)).toHaveLength(
            EffectArray.filter(states.slice(0, examined), state => state !== 'valid').length,
          );
          expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(Math.max(2, examined * 32768));
        } finally {
          db.close();
        }
      },
    ),
    {numRuns: 30},
  );
});
it('omits unsupported legacy contributions without loading or assigning a weighted score', () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), {minLength: 1, maxLength: 135}), flags => {
      const db = postingDatabase(false);
      try {
        EffectArray.forEach(flags, (valid, index) => {
          const symbolId = valid ? id(index) : EffectString.repeat(129)('x') + index;
          postingSymbol(db, symbolId);
          db.query('INSERT INTO symbol_terms VALUES(?,?,?,?)').run(
            'snap',
            'pending',
            symbolId,
            valid ? 1 : new Uint8Array([1]),
          );
        });
        const rows = postingRows(db, 128);
        expect(rows).toEqual([]);
        const legacyRoot = db
          .query<{rootpage: number}, []>("SELECT rootpage FROM sqlite_schema WHERE name='symbol_terms'")
          .get()!.rootpage;
        const statement = taskPostingStatement('snap', undefined, ['pending'], 128);
        const bytecode = db
          .query<{opcode: string; p2: number}, (string | number)[]>('EXPLAIN ' + statement.text)
          .all(...statement.parameters);
        expect(EffectArray.some(bytecode, op => op.opcode === 'OpenRead' && op.p2 === legacyRoot)).toBe(false);
      } finally {
        db.close();
      }
    }),
    {numRuns: 25},
  );
});
it('returns compact omissions for small BLOB paths/packages instead of aborting native JSON', () => {
  for (const field of ['path', 'package_name']) {
    const db = postingDatabase(true);
    try {
      postingSymbol(db, id(0));
      db.query('INSERT INTO lexical_compact_symbols VALUES(1,1,?)').run(id(0));
      db.query('INSERT INTO lexical_compact_postings VALUES(1,1,1,1)').run();
      db.query(`UPDATE symbols SET ${field}=?`).run(new Uint8Array([112]));
      const rows = postingRows(db, 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({[field]: null, row_valid: 0, transfer_valid: 1});
    } finally {
      db.close();
    }
  }
});
it('uses native column metadata for text type/byte guards before loading an admitted payload', () => {
  const db = postingDatabase(false);
  try {
    postingSymbol(db, id(0));
    const program = db
      .query<{opcode: string; p1: number; p2: number; p3: number; p4: string | null; p5: number}, []>(
        `EXPLAIN SELECT ${taskBoundedText('id', 128)} FROM symbols`,
      )
      .all();
    const functions = EffectArray.filter(program, op => op.opcode === 'Function');
    expect(EffectArray.some(functions, op => op.p4 === 'octet_length(1)')).toBe(true);
    for (const fn of functions) {
      const input = EffectArray.findFirst(program, op => op.opcode === 'Column' && op.p3 === fn.p2);
      expect(EffectOption.isSome(input)).toBe(true);
      // SQLite marks typeof/octet_length arguments as metadata-only Column reads (0x80).
      expect(EffectOption.getOrThrow(input).p5 & 128).toBe(128);
    }
    expect(EffectArray.some(program, op => op.opcode === 'Column' && op.p5 === 0)).toBe(true);
  } finally {
    db.close();
  }
});

it('does not probe past128 dangling compact keys to recover a later valid dictionary entry', () => {
  const db = postingDatabase(true);
  try {
    for (let key = 1; key <= 129; key++) db.query('INSERT INTO lexical_compact_postings VALUES(1,1,?,1)').run(key);
    db.query('INSERT INTO lexical_compact_symbols VALUES(129,1,?)').run(id(129));
    postingSymbol(db, id(129));
    const rows = postingRows(db, 128);
    expect(rows).toHaveLength(128);
    expect(EffectArray.every(rows, row => row.id === null && row.row_valid === 0 && row.eligible === 0)).toBe(true);
  } finally {
    db.close();
  }
});
it('counts invalid compact key types as bounded refusal markers', () => {
  const db = postingDatabase(true);
  try {
    db.query('INSERT INTO lexical_compact_postings VALUES(1,1,?,1)').run(new Uint8Array([1]));
    const rows = postingRows(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({id: null, row_valid: 0, eligible: 0, transfer_valid: 1});
  } finally {
    db.close();
  }
});

interface NativeInstruction {
  addr: number;
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p4: string | number | null;
  p5: number;
}
function wholeTaskPrograms(db: Database) {
  return EffectArray.map(
    [
      ['header', taskHeaderStatement('snap')],
      ['posting', taskPostingStatement('snap', 'other', ['pending'], 128)],
      ['node', taskNodeStatement('snap', 'other', [id(0)])],
      ['expansion', taskExpansionStatement('snap', 'other', [id(0)], 128)],
    ] as const,
    ([name, statement]) => ({
      name,
      statement,
      program: db
        .query<NativeInstruction, (string | number)[]>('EXPLAIN ' + statement.text)
        .all(...statement.parameters),
    }),
  );
}
function persistedColumns(db: Database, program: readonly NativeInstruction[]) {
  const roots = db
    .query<{name: string; tbl_name: string; rootpage: number; type: string; sql: string}, []>(
      "SELECT name,tbl_name,rootpage,type,sql FROM sqlite_schema WHERE type IN ('table','index')",
    )
    .all();
  const cursors = new Map<number, {table: string; columns: readonly {name: string}[]}>();
  for (const op of program) {
    if (op.opcode !== 'OpenRead') continue;
    const root = EffectOption.getOrUndefined(EffectArray.findFirst(roots, row => row.rootpage === op.p2));
    if (!root) continue;
    const indexed = root.type === 'index' || EffectString.includes('WITHOUT ROWID')(root.sql);
    const columns = db
      .query<{name: string}, []>(`PRAGMA ${indexed ? 'index_xinfo' : 'table_info'}('${root.name}')`)
      .all();
    cursors.set(op.p1, {table: root.tbl_name, columns});
  }
  return EffectArray.flatMap(program, (op, index) => {
    const cursor = cursors.get(op.p1);
    return op.opcode === 'Column' && cursor?.columns[op.p2]?.name
      ? [{op, index, table: cursor.table, column: cursor.columns[op.p2].name}]
      : [];
  });
}
it('keeps nullable and arity validation metadata-first in every actual whole statement', () => {
  const db = postingDatabase(true, true);
  try {
    const guarded = new Set([
      'snapshots.base_snapshot_id',
      'symbols.arity',
      'symbols.package_name',
      'symbols.resolution_domain',
      'symbols.resolution_scope_id',
      'edges.source_id',
      'edges.target_id',
    ]);
    const programs = wholeTaskPrograms(db);
    for (const {name, program} of programs) {
      const columns = EffectArray.filter(persistedColumns(db, program), column =>
        guarded.has(column.table + '.' + column.column),
      );
      expect(columns.length, name).toBeGreaterThan(0);
      const unsafeNull = EffectArray.filter(
        columns,
        ({op, index}) =>
          op.p5 === 0 && ['IsNull', 'NotNull'].includes(program[index + 1]?.opcode) && program[index + 1].p1 === op.p3,
      );
      expect(
        EffectArray.map(unsafeNull, ({op, column}) => ({column, addr: op.addr})),
        name,
      ).toEqual([]);
      // Ordinary payload loads are valid after admission; the type arguments themselves must use metadata.
      for (const {op, index} of columns)
        if (program[index + 1]?.opcode === 'Function' && program[index + 1]?.p4 === 'typeof(1)')
          expect(op.p5 & 128, name + ':' + op.addr).toBe(128);
    }
  } finally {
    db.close();
  }
});
it('admits expansion IDs and provenance bytes before whole-statement payload loads', () => {
  const db = postingDatabase(true, true);
  try {
    for (const base of [undefined, 'other']) {
      const statement = taskExpansionStatement('snap', base, [id(0)], 128);
      const program = db
        .query<NativeInstruction, (string | number)[]>('EXPLAIN ' + statement.text)
        .all(...statement.parameters);
      for (const field of ['id', 'provenance']) {
        const columns = EffectArray.filter(
          persistedColumns(db, program),
          column => column.table === 'edges' && column.column === field,
        );
        const widths = EffectArray.filter(
          columns,
          ({op, index}) =>
            (op.p5 & 192) === 192 &&
            program[index + 1]?.p4 === 'octet_length(1)' &&
            program[index + 2]?.opcode === 'Gt',
        );
        const payloads = EffectArray.filter(columns, ({op}) => op.p5 === 0);
        expect(payloads.length, field).toBeGreaterThan(0);
        expect(
          EffectArray.every(payloads, ({op}) =>
            EffectArray.some(
              widths,
              width =>
                width.op.p1 === op.p1 &&
                width.op.p2 === op.p2 &&
                width.op.addr < op.addr &&
                op.addr < program[width.index + 2].p2,
            ),
          ),
          field,
        ).toBe(true);
      }
    }
  } finally {
    db.close();
  }
});
it('does not skip128 malformed edge keys to acquire a later valid relationship', () => {
  const db = postingDatabase(true, true);
  try {
    const insert =
      db.query(`INSERT INTO edges(snapshot_id,id,source_id,source_name,relation,target_id,target_name,provenance,confidence,evidence_path,evidence_span_json)
      VALUES('snap',?,?,'f','calls',?,'g','resolved',0.5,'a.ts','{}')`);
    for (let n = 0; n < 128; n++)
      insert.run(`bad-${EffectString.padStart(3, '0')(String(n))}-${EffectString.repeat(129)('x')}`, id(1), id(0));
    insert.run('valid-later', id(1), id(0));
    const statement = taskExpansionStatement('snap', undefined, [id(0)], 128);
    const rows = db.query<Record<string, unknown>, (string | number)[]>(statement.text).all(...statement.parameters);
    expect(rows).toHaveLength(128);
    expect(
      EffectArray.every(
        rows,
        row =>
          row.id === null &&
          row.source_id === null &&
          row.target_id === null &&
          row.row_valid === 0 &&
          row.transfer_valid === 1,
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});
it('preserves nullable text, integer arity and provenance enum semantics with finite refusals', () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant(null), fc.string({maxLength: 270}), fc.uint8Array({maxLength: 4})),
      fc.constantFrom(null, 0, 42, -1, 1.5, 'invalid', new Uint8Array([1])),
      fc.constantFrom(
        'declared',
        'resolved',
        'syntactic',
        'heuristic',
        'model',
        'unknown',
        EffectString.repeat(33)('x'),
      ),
      (optional, arity, provenance) => {
        const db = postingDatabase(true, true);
        try {
          postingSymbol(db, id(0));
          db.query('UPDATE symbols SET package_name=?,resolution_domain=?,resolution_scope_id=?,arity=?').run(
            optional,
            optional,
            optional,
            arity,
          );
          const node = taskNodeStatement('snap', undefined, [id(0)]);
          const row = db.query<Record<string, unknown>, (string | number)[]>(node.text).get(...node.parameters)!;
          const textValid = (bytes: number) =>
            optional === null || (typeof optional === 'string' && Buffer.byteLength(optional) <= bytes);
          const arityValid = arity === null || (typeof arity === 'number' && Number.isSafeInteger(arity) && arity >= 0);
          expect(row.row_valid).toBe(textValid(128) && arityValid ? 1 : 0);
          for (const [field, bytes] of [
            ['package_name', 256],
            ['resolution_domain', 128],
            ['resolution_scope_id', 256],
          ] as const)
            expect(row[field]).toEqual(textValid(bytes) ? optional : null);
          expect(row.arity).toEqual(arityValid ? arity : null);
          db.query("UPDATE snapshots SET base_snapshot_id=? WHERE id='snap'").run(optional);
          const header = taskHeaderStatement('snap');
          const headerRow = db
            .query<Record<string, unknown>, (string | number)[]>(header.text)
            .get(...header.parameters)!;
          expect(headerRow.row_valid).toBe(textValid(128) ? 1 : 0);
          expect(headerRow.base_snapshot_id).toEqual(textValid(128) ? optional : null);
          for (const endpoint of ['source_id', 'target_id']) {
            db.exec('DELETE FROM edges');
            db.query(
              `INSERT INTO edges(snapshot_id,id,source_id,source_name,relation,target_id,target_name,provenance,confidence,evidence_path,evidence_span_json)
            VALUES('snap','edge',?,'f','calls',?,'g',?,0.5,'a.ts','{}')`,
            ).run(endpoint === 'source_id' ? optional : id(0), endpoint === 'target_id' ? optional : id(0), provenance);
            const edge = taskExpansionStatement('snap', undefined, [id(0)], 1);
            const edgeRow = db.query<Record<string, unknown>, (string | number)[]>(edge.text).get(...edge.parameters)!;
            const enumValid = ['declared', 'resolved', 'syntactic', 'heuristic', 'model'].includes(provenance);
            expect(edgeRow.provenance).toBe(enumValid ? provenance : null);
            expect(edgeRow[endpoint]).toEqual(textValid(128) ? optional : null);
            expect(edgeRow.row_valid).toBe(enumValid && textValid(128) ? 1 : 0);
          }
        } finally {
          db.close();
        }
      },
    ),
    {numRuns: 25},
  );
});
