import {Array as EffectArray} from 'effect';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {CodeGraphStore, codeGraphPersistedDeltaResolutionPageStatement} from '@threadnote/graph/store';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphReference,
  CodeGraphResolutionActivity,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('persisted delta reference resolution', () => {
  it('resolves a tiny dirty overlay against a large base with bounded deterministic progress', async () => {
    const root = await mkdtemp('threadnote-persisted-delta-resolution-');
    const databasePath = join(root, 'graph-v3.sqlite');
    try {
      const fixture = persistedDeltaFixture(root, 12_000);
      const observations: CodeGraphResolutionActivity[] = [];
      const result = await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* store.withSession(
            databasePath,
            Effect.gen(function* () {
              yield* store.prepareActivation(databasePath, fixture.baseFiles);
              yield* store.stageActivationFacts(databasePath, fixture.baseSymbols, []);
              yield* store.activateStaged(databasePath, fixture.identity, fixture.baseSnapshot, {
                fileSetFingerprint: 'large-base-files',
                packProvenance: [],
                workspaceFingerprint: 'large-base-workspace',
              });

              const prepared = yield* store.preparePersistedIncrementalActivation(
                databasePath,
                fixture.baseSnapshot.id,
                [fixture.dirtyFile],
                [fixture.dirtyFacts],
              );
              const resolution = yield* store.resolveStagedReferences(databasePath, progress =>
                Effect.sync(() => observations.push(progress)),
              );
              yield* store.activateStaged(databasePath, fixture.identity, fixture.dirtySnapshot);
              return {
                graph: yield* store.loadGraph(databasePath, fixture.dirtySnapshot.id),
                prepared,
                resolution,
              };
            }),
          );
        }),
      );

      expect(result.prepared).toBe(true);
      expect(result.resolution).toMatchObject({
        pagesCompleted: 1,
        passesCompleted: 1,
        referencesExamined: 1,
        resolved: 1,
      });
      expect(
        EffectArray.map(observations, progress => ({
          pageCompleted: progress.pageCompleted,
          pageTotal: progress.pageTotal,
          pass: progress.pass,
          referencesCompleted: progress.referencesCompleted,
          referencesTotal: progress.referencesTotal,
          resolved: progress.resolved,
        })),
      ).toEqual([
        {pageCompleted: 0, pageTotal: 1, pass: 1, referencesCompleted: 0, referencesTotal: 1, resolved: 0},
        {pageCompleted: 0, pageTotal: 1, pass: 1, referencesCompleted: 0, referencesTotal: 1, resolved: 0},
        {pageCompleted: 1, pageTotal: 1, pass: 1, referencesCompleted: 1, referencesTotal: 1, resolved: 1},
      ]);
      expect(result.graph.symbols).toHaveLength(fixture.baseSymbols.length);
      expect(result.graph.edges).toHaveLength(1);
      expect(result.graph.edges[0]).toMatchObject({
        relation: 'calls',
        sourceId: fixture.caller.id,
        targetId: fixture.target.id,
        targetName: fixture.target.name,
      });
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }, 30_000);

  it('uses exact primary-key probes instead of scanning the persisted base', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      createResolutionPlanSchema(database);
      const statement = codeGraphPersistedDeltaResolutionPageStatement('base-snapshot', 'edge-000', 'edge-500');
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
      const output = EffectArray.join(plan, '\n');

      expect(output).toContain('SEARCH candidate USING PRIMARY KEY (edge_id>? AND edge_id<?)');
      expect(output).toContain('SEARCH lookup USING PRIMARY KEY (lookup_key=?)');
      expect(output).toContain('SEARCH lookup USING PRIMARY KEY (snapshot_id=? AND lookup_key=?)');
      expect(output).toContain('SEARCH changed USING PRIMARY KEY (path=?)');
      expect(output).toContain('SEARCH current USING PRIMARY KEY (lookup_key=? AND symbol_id=?)');
      expect(output).toContain('SEARCH symbol USING PRIMARY KEY (id=?)');
      expect(output).toContain('SEARCH symbol USING PRIMARY KEY (snapshot_id=? AND id=?)');
      expect(output).toContain('SEARCH current USING PRIMARY KEY (id=?)');
      expect(output).not.toMatch(/SCAN (?:current|lookup|symbol)\b/u);
      expect(statement.text).not.toContain('effective_activation_lookup');
      expect(statement.text).not.toContain('effective_activation_symbols');
    } finally {
      database.close(false);
    }
  });

  it('shadows aliases produced by changed base files while accepting current replacements', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      createResolutionPlanSchema(database);
      database.exec(`
        INSERT INTO activation_files (path) VALUES ('src/caller.ts');
        INSERT INTO activation_incremental_paths (path) VALUES ('src/caller.ts');
        INSERT INTO activation_edges (
          id, source_id, source_name, relation, target_id, target_name,
          provenance, confidence, evidence_path, evidence_span_json
        ) VALUES (
          'dirty-edge', 'caller', 'caller', 'calls', NULL, 'oldAlias',
          'syntactic', 0.7, 'src/caller.ts', '{}'
        );
        INSERT INTO activation_references (
          edge_id, resolution_domain, exported_only, alias_lookup_keys_json
        ) VALUES ('dirty-edge', 'typescript', 0, '[]');
        INSERT INTO activation_reference_candidates (edge_id, tier, lookup_key)
        VALUES ('dirty-edge', 0, 'typescript:name:oldAlias');
        INSERT INTO symbols (
          snapshot_id, id, name, exported, kind, resolution_domain
        ) VALUES ('base-snapshot', 'target', 'target', 1, 'function', 'typescript');
        INSERT INTO snapshot_symbol_lookup (
          snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
          provenance, evidence_edge_id, evidence_path
        ) VALUES (
          'base-snapshot', 'typescript:name:oldAlias', 'target', 'typescript', 1,
          'alias', 'old-base-edge', 'src/caller.ts'
        );
      `);
      const statement = codeGraphPersistedDeltaResolutionPageStatement('base-snapshot', '', 'dirty-edge');
      const query = database.query(statement.text);

      expect(query.all(...statement.parameters)).toEqual([]);

      database.exec(`
        INSERT INTO activation_symbol_lookup (
          lookup_key, symbol_id, resolution_domain, exported,
          provenance, evidence_edge_id, evidence_path
        ) VALUES (
          'typescript:name:oldAlias', 'target', 'typescript', 1,
          'alias', 'dirty-edge', 'src/caller.ts'
        );
      `);
      expect(query.all(...statement.parameters)).toMatchObject([
        {id: 'dirty-edge', target_symbol_id: 'target', target_symbol_name: 'target'},
      ]);
    } finally {
      database.close(false);
    }
  });
});

function persistedDeltaFixture(root: string, noiseSymbolCount: number) {
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
    displayName: 'persisted-delta-resolution',
    gitCommonDirectory: root,
    headCommit: Effect2.pipe('1', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: Effect2.pipe('r', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('w', EffectString.repeat(64)),
  };
  const callerFile = inventoryFile('src/caller.ts', 'base-caller-hash');
  const catalogFile = inventoryFile('src/catalog.ts', 'catalog-hash');
  const dirtyFile = inventoryFile('src/caller.ts', 'dirty-caller-hash');
  const caller = symbol('caller', 'caller', callerFile.path, dirtyFile.contentHash);
  const target = symbol('target', 'wantedTarget', catalogFile.path, catalogFile.contentHash);
  const noise = Array.from({length: noiseSymbolCount}, (_, index) =>
    symbol(
      `noise-${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}`,
      `noise${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}`,
      catalogFile.path,
      catalogFile.contentHash,
    ),
  );
  const baseCaller = {...caller, contentHash: callerFile.contentHash};
  const edge: CodeGraphEdge = {
    confidence: 0.7,
    evidencePath: dirtyFile.path,
    evidenceSpan: caller.span,
    id: 'dirty-edge',
    provenance: 'syntactic',
    relation: 'calls',
    sourceId: caller.id,
    sourceName: caller.name,
    targetName: target.name,
  };
  const reference: CodeGraphReference = {
    edgeId: edge.id,
    evidencePath: edge.evidencePath,
    evidenceSpan: edge.evidenceSpan,
    lookupTiers: [[target.lookupKeys![0]]],
    provenance: edge.provenance,
    relation: edge.relation,
    resolutionDomain: 'typescript',
    sourceId: caller.id,
    sourceName: caller.name,
    targetName: target.name,
  };
  const baseSymbols = [baseCaller, target, ...noise];
  const baseSnapshot: CodeGraphSnapshot = {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'persisted-delta-resolution-test',
    fileCount: 2,
    id: 'large-base-snapshot',
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: baseSymbols.length,
    worktreeId: identity.worktreeId,
  };
  const dirtyFacts: CodeGraphFileFacts = {
    diagnostics: [],
    edges: [edge],
    path: dirtyFile.path,
    references: [reference],
    symbols: [caller],
  };
  const dirtySnapshot: CodeGraphSnapshot = {
    ...baseSnapshot,
    baseSnapshotId: baseSnapshot.id,
    commit: identity.headCommit,
    dirty: true,
    edgeCount: 1,
    id: 'tiny-dirty-overlay',
    overlayFingerprint: 'dirty-overlay-fingerprint',
  };
  return {
    baseFiles: [callerFile, catalogFile],
    baseSnapshot,
    baseSymbols,
    caller,
    dirtyFacts,
    dirtyFile,
    dirtySnapshot,
    identity,
    target,
  };
}

function inventoryFile(path: string, contentHash: string): CodeGraphInventoryFile {
  return {
    blobId: contentHash,
    contentHash,
    language: 'typescript',
    mode: '100644',
    path,
    size: 128,
    source: 'commit',
  };
}

function symbol(id: string, name: string, path: string, contentHash: string): CodeGraphSymbol {
  return {
    contentHash,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:name:${name}`],
    name,
    path,
    qualifiedName: name,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function createResolutionPlanSchema(database: Database): void {
  database.exec(`
    CREATE TEMP TABLE activation_files (
      path TEXT PRIMARY KEY
    ) WITHOUT ROWID;
    CREATE TEMP TABLE activation_incremental_paths (
      path TEXT PRIMARY KEY
    ) WITHOUT ROWID;
    CREATE TEMP TABLE activation_reference_candidates (
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      lookup_key TEXT NOT NULL,
      PRIMARY KEY (edge_id, tier, lookup_key)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE activation_references (
      edge_id TEXT PRIMARY KEY,
      resolution_domain TEXT NOT NULL,
      exported_only INTEGER NOT NULL,
      alias_lookup_keys_json TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TEMP TABLE activation_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TEMP TABLE activation_symbol_lookup (
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (lookup_key, symbol_id)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE activation_symbols (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exported INTEGER NOT NULL,
      kind TEXT NOT NULL,
      resolution_domain TEXT
    ) WITHOUT ROWID;
    CREATE TABLE snapshot_symbol_lookup (
      snapshot_id TEXT NOT NULL,
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (snapshot_id, lookup_key, symbol_id)
    ) WITHOUT ROWID;
    CREATE TABLE symbols (
      snapshot_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      exported INTEGER NOT NULL,
      kind TEXT NOT NULL,
      resolution_domain TEXT,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID;
  `);
}
