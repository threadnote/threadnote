import {Array as EffectArray} from 'effect';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it} from 'vitest';
import {
  persistedIncrementalBaseSymbolsStatement,
  persistedIncrementalChangedFilesStatement,
  persistedIncrementalEdgeDeletionsStatement,
  persistedIncrementalFactCountsStatement,
  persistedIncrementalFileDeletionsStatement,
  persistedIncrementalReexportMismatchStatement,
  persistedIncrementalSymbolDeletionsStatement,
} from '@threadnote/graph/store/incremental/plan';
import {type CodeGraphSqlQueryStatement} from '@threadnote/graph/store/visualization_sql';

describe('persisted incremental SQLite plans', () => {
  it('point-probes persisted files, symbols, and re-exports for surface admission', () =>
    withPlanDatabase(database => {
      const changedFiles = planDetails(database, persistedIncrementalChangedFilesStatement('snapshot-base'));
      expect(changedFiles).toContain('SCAN changed');
      expect(changedFiles).toContain('SEARCH current USING PRIMARY KEY (path=?)');
      expect(changedFiles).toContain('SEARCH base USING PRIMARY KEY (snapshot_id=? AND path=?)');
      expect(EffectArray.join(changedFiles, '\n')).not.toMatch(
        /SEARCH base USING PRIMARY KEY \(snapshot_id=\?\)(?! AND path)/u,
      );

      const baseSymbols = planDetails(database, persistedIncrementalBaseSymbolsStatement('snapshot-base', 100));
      expect(baseSymbols).toContain('SCAN changed');
      expect(baseSymbols).toContain('SEARCH base USING INDEX symbols_path (snapshot_id=? AND path=?)');
      expect(EffectArray.join(baseSymbols, '\n')).not.toMatch(/SEARCH base USING PRIMARY KEY \(snapshot_id=\?\)/u);

      const reexports = planDetails(database, persistedIncrementalReexportMismatchStatement('snapshot-base'));
      expect(EffectArray.filter(reexports, detail => detail === 'SCAN changed')).toHaveLength(2);
      expect(
        EffectArray.filter(
          reexports,
          detail => detail === 'SEARCH base USING PRIMARY KEY (snapshot_id=? AND source_path=?)',
        ),
      ).toHaveLength(2);
      expect(EffectArray.join(reexports, '\n')).not.toMatch(
        /SEARCH base USING PRIMARY KEY \(snapshot_id=\?\)(?! AND source_path)/u,
      );
    }));

  it('point-probes persisted fact counts for every changed path', () =>
    withPlanDatabase(database => {
      const details = planDetails(database, persistedIncrementalFactCountsStatement('snapshot-base'));
      expect(EffectArray.filter(details, detail => detail === 'SCAN changed')).toHaveLength(3);
      expect(details).toContain('SEARCH file USING PRIMARY KEY (snapshot_id=? AND path=?)');
      expect(details).toContain('SEARCH symbol USING COVERING INDEX symbols_path (snapshot_id=? AND path=?)');
      expect(details).toContain(
        'SEARCH edge USING COVERING INDEX edges_evidence_path (snapshot_id=? AND evidence_path=?)',
      );
      expect(EffectArray.join(details, '\n')).not.toMatch(
        /SEARCH (?:file|symbol|edge) USING PRIMARY KEY \(snapshot_id=\?\)/u,
      );
    }));

  it('point-probes persisted deletion candidates for every changed path', () =>
    withPlanDatabase(database => {
      const files = planDetails(database, persistedIncrementalFileDeletionsStatement('snapshot-next', 'snapshot-base'));
      expect(files).toContain('SCAN changed');
      expect(files).toContain('SEARCH base USING PRIMARY KEY (snapshot_id=? AND path=?)');
      expect(files).toContain('SEARCH current USING PRIMARY KEY (path=?)');

      const symbols = planDetails(
        database,
        persistedIncrementalSymbolDeletionsStatement('snapshot-next', 'snapshot-base'),
      );
      expect(symbols).toContain('SCAN changed');
      expect(symbols).toContain('SEARCH base USING COVERING INDEX symbols_path (snapshot_id=? AND path=?)');
      expect(symbols).toContain('SEARCH current USING PRIMARY KEY (id=?)');

      const edges = planDetails(database, persistedIncrementalEdgeDeletionsStatement('snapshot-next', 'snapshot-base'));
      expect(edges).toContain('SCAN changed');
      expect(edges).toContain(
        'SEARCH base USING COVERING INDEX edges_evidence_path (snapshot_id=? AND evidence_path=?)',
      );
      expect(edges).toContain('SEARCH current USING PRIMARY KEY (id=?)');

      expect(EffectArray.join([...files, ...symbols, ...edges], '\n')).not.toMatch(
        /SEARCH base USING PRIMARY KEY \(snapshot_id=\?\)(?! AND (?:path|evidence_path))/u,
      );
    }));
});

function planDetails(database: Database, statement: CodeGraphSqlQueryStatement): readonly string[] {
  const rows = database
    .query<
      {
        readonly detail: string;
      },
      SQLQueryBindings[]
    >(`EXPLAIN QUERY PLAN ${statement.text}`)
    .all(...statement.parameters);
  return EffectArray.map(rows, row => row.detail);
}

function withPlanDatabase(run: (database: Database) => void): void {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TEMP TABLE activation_incremental_paths (
        path TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      CREATE TEMP TABLE activation_files (
        path TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      CREATE TEMP TABLE activation_symbols (
        id TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      CREATE TEMP TABLE activation_edges (
        id TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      CREATE TEMP TABLE activation_reexport_provenance (
        source_path TEXT NOT NULL,
        local_name TEXT NOT NULL,
        target_path TEXT NOT NULL,
        imported_name TEXT NOT NULL,
        PRIMARY KEY (source_path, local_name, target_path, imported_name)
      ) WITHOUT ROWID;
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        base_snapshot_id TEXT,
        file_count INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE snapshot_files (
        snapshot_id TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, path)
      ) WITHOUT ROWID;
      CREATE TABLE snapshot_file_deletions (
        snapshot_id TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, path)
      ) WITHOUT ROWID;
      CREATE TABLE symbols (
        snapshot_id TEXT NOT NULL,
        id TEXT NOT NULL,
        path TEXT NOT NULL,
        arity INTEGER,
        exported INTEGER NOT NULL,
        kind TEXT NOT NULL,
        language TEXT NOT NULL,
        lookup_keys_json TEXT NOT NULL,
        name TEXT NOT NULL,
        package_name TEXT,
        qualified_name TEXT NOT NULL,
        resolution_domain TEXT,
        resolution_scope_id TEXT,
        PRIMARY KEY (snapshot_id, id)
      ) WITHOUT ROWID;
      CREATE INDEX symbols_path ON symbols(snapshot_id, path);
      CREATE TABLE snapshot_symbol_deletions (
        snapshot_id TEXT NOT NULL,
        symbol_id TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, symbol_id)
      ) WITHOUT ROWID;
      CREATE TABLE edges (
        snapshot_id TEXT NOT NULL,
        id TEXT NOT NULL,
        evidence_path TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, id)
      ) WITHOUT ROWID;
      CREATE INDEX edges_evidence_path ON edges(snapshot_id, evidence_path);
      CREATE TABLE snapshot_edge_deletions (
        snapshot_id TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, edge_id)
      ) WITHOUT ROWID;
      CREATE TABLE snapshot_reexport_provenance (
        snapshot_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        local_name TEXT NOT NULL,
        target_path TEXT NOT NULL,
        imported_name TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, source_path, local_name, target_path, imported_name)
      ) WITHOUT ROWID;
    `);
    run(database);
  } finally {
    database.close(false);
  }
}
