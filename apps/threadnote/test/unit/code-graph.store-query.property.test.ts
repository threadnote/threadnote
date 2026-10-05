import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {
  codeGraphAdjacencyQueryStatement,
  codeGraphDirectEdgeQueryStatement,
  codeGraphCachedCommittedFileKeysStatement,
  codeGraphCompactLexicalCleanupPageStatement,
  codeGraphEffectiveSymbolTermsQueryStatement,
  codeGraphExactSymbolQueryStatement,
  codeGraphSymbolPathClass,
  codeGraphSymbolPathScoreMultiplier,
  codeGraphSymbolSearchScoreMultiplier,
  codeGraphSymbolsByIdsQueryStatement,
  codeGraphTermCandidateQueryStatement,
  CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE,
  CodeGraphStore,
  isCanonicalAbsoluteBazelLabel,
} from '@threadnote/graph/store';
import {
  CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE_SQL,
  CODE_GRAPH_FILE_BLOB_AUTHORITY_TRIGGER_SQL,
} from '@threadnote/graph/store/cache/authority';
import {neighborQuery, pathQuery} from '@threadnote/graph/query';
import {codeGraphIdentitySelectors} from '@threadnote/graph/store/utilities';
import type {CodeGraphEdge, CodeGraphProvenance} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const baseSnapshotId = 'snapshot-base';
const currentSnapshotId = 'snapshot-current';
const repositoryId = 'repository-query-property';
const worktreeId = 'worktree-query-property';
const allProvenances = ['declared', 'heuristic', 'model', 'resolved', 'syntactic'] as const;
const relations = ['calls', 'contains', 'extends', 'imports', 'references'] as const;

interface EdgeSpec {
  readonly confidence: number;
  readonly id: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: (typeof relations)[number];
  readonly source: number | undefined;
  readonly target: number | undefined;
}

interface LexicalPostingSpec {
  readonly symbol: number;
  readonly term: string;
  readonly weight: number;
}

type LexicalFixtureFormat = 'compact' | 'legacy';

const edgeSpec = FC.record({
  confidence: FC.integer({max: 100, min: 0}),
  id: FC.integer({max: 15, min: 0}),
  provenance: FC.constantFrom(...allProvenances),
  relation: FC.constantFrom(...relations),
  source: FC.option(FC.integer({max: 5, min: 0}), {nil: undefined}),
  target: FC.option(FC.integer({max: 5, min: 0}), {nil: undefined}),
});
const lexicalPostingSpec = FC.record({
  symbol: FC.integer({max: 7, min: 0}),
  term: FC.constantFrom('alpha', 'beta', 'delta', 'gamma', 'omega'),
  weight: FC.integer({max: 5, min: 1}),
});
const bazelLabelSegment = FC.array(
  FC.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-'),
  {maxLength: 16, minLength: 1},
).map(characters => characters.join(''));

const symbolPathDirectory = FC.constantFrom(
  '__tests__',
  'app',
  'docs',
  'fixtures',
  'integration',
  'lib',
  'spec',
  'src',
  'test',
  'tests',
);
const symbolFileName = FC.constantFrom(
  'AGENTS.md',
  'guide.mdx',
  'helpers.ts',
  'mcp.native-tools.test.ts',
  'mcp_server.ts',
  'notes.rst',
  'widget.spec.tsx',
);
const symbolQueryTerm = FC.constantFrom('docs', 'md', 'mcp', 'recall_context', 'spec', 'test');
const cacheAuthorityKind = FC.constantFrom('invalid-json', 'match', 'mismatch', 'missing-path');

describe('code graph indexed query properties', () => {
  it('serves cache admission from the authority table without evaluating stored fact JSON', () => {
    const database = cacheAuthorityDatabase();
    try {
      const statement = codeGraphCachedCommittedFileKeysStatement('extractor-current');
      const plan = database.query(`EXPLAIN QUERY PLAN ${statement.text}`).all(...statement.parameters) as readonly {
        readonly detail: string;
      }[];
      const bytecode = database.query(`EXPLAIN ${statement.text}`).all(...statement.parameters) as readonly {
        readonly opcode: string;
        readonly p4: unknown;
      }[];

      expect(plan.map(row => row.detail).join('\n')).toContain(
        `SEARCH ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} USING PRIMARY KEY (extractor_set=?)`,
      );
      expect(bytecode.filter(row => row.opcode === 'Function').map(row => row.p4)).not.toContainEqual(
        expect.stringMatching(/^json_/u),
      );
    } finally {
      database.close(false);
    }
  });

  it('narrows cache admission to the requested changed path and content hash', () => {
    const database = cacheAuthorityDatabase();
    try {
      const insert = database.query(
        `INSERT INTO file_blobs (
           content_hash, extractor_set, path_hint, blob_id, reuse_class, facts_json, created_at
         ) VALUES (?, 'extractor-current', ?, NULL, NULL, ?, '2026-08-22T00:00:00.000Z')`,
      );
      for (const [path, contentHash] of [
        ['src/changed.ts', 'a'.repeat(40)],
        ['src/unchanged.ts', 'b'.repeat(40)],
      ] as const) {
        insert.run(contentHash, path, JSON.stringify({path}));
      }
      const statement = codeGraphCachedCommittedFileKeysStatement('extractor-current', [
        {contentHash: 'a'.repeat(40), path: 'src/changed.ts'},
      ]);
      const rows = database.query(statement.text).all(...statement.parameters) as readonly {
        readonly content_hash: string;
        readonly path_hint: string;
      }[];

      expect(rows).toEqual([
        {content_hash: 'a'.repeat(40), path_hint: 'src/changed.ts', blob_id: null, reuse_class: null},
      ]);
      expect(database.query(`EXPLAIN ${statement.text}`).all(...statement.parameters)).not.toContainEqual(
        expect.objectContaining({p4: expect.stringMatching(/^json_/u)}),
      );
    } finally {
      database.close(false);
    }
  });

  it('revokes and restores cache authority atomically when a stored fact row changes', () => {
    const database = cacheAuthorityDatabase();
    try {
      const path = 'src/authority.ts';
      const insert = database.query(
        `INSERT INTO file_blobs (
           content_hash, extractor_set, path_hint, blob_id, reuse_class, facts_json, created_at
         ) VALUES (?, 'extractor-current', ?, NULL, NULL, ?, '2026-08-22T00:00:00.000Z')`,
      );
      const statement = codeGraphCachedCommittedFileKeysStatement('extractor-current');
      insert.run('a'.repeat(40), path, JSON.stringify({path}));
      expect(database.query(statement.text).all(...statement.parameters)).toHaveLength(1);

      database.query('UPDATE file_blobs SET facts_json = ?').run('{');
      expect(database.query(statement.text).all(...statement.parameters)).toHaveLength(0);

      database.query('UPDATE file_blobs SET facts_json = ?').run(JSON.stringify({path}));
      expect(database.query(statement.text).all(...statement.parameters)).toHaveLength(1);

      database.query('DELETE FROM file_blobs').run();
      expect(database.query(statement.text).all(...statement.parameters)).toHaveLength(0);
    } finally {
      database.close(false);
    }
  });

  fcProp(
    it,
    'admits exactly current-generation rows whose stored fact path matches their authority path',
    {
      rows: FC.array(
        FC.record({
          authority: cacheAuthorityKind,
          currentGeneration: FC.boolean(),
        }),
        {maxLength: 40},
      ),
    },
    ({rows}) => {
      const database = cacheAuthorityDatabase();
      try {
        const insert = database.query(
          `INSERT INTO file_blobs (
             content_hash, extractor_set, path_hint, blob_id, reuse_class, facts_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, '2026-08-22T00:00:00.000Z')`,
        );
        const expectedPaths: string[] = [];
        for (const [index, row] of rows.entries()) {
          const path = `src/file-${index}.ts`;
          const extractorSet = row.currentGeneration ? 'extractor-current' : 'extractor-old';
          const factsJson =
            row.authority === 'invalid-json'
              ? '{'
              : row.authority === 'match'
                ? JSON.stringify({path})
                : row.authority === 'mismatch'
                  ? JSON.stringify({path: `${path}.other`})
                  : JSON.stringify({diagnostics: []});
          insert.run(
            index.toString(16).padStart(40, '0'),
            extractorSet,
            path,
            (index + 1).toString(16).padStart(40, '0'),
            'structured-object-v1:json:full',
            factsJson,
          );
          if (row.currentGeneration && row.authority === 'match') expectedPaths.push(path);
        }

        const statement = codeGraphCachedCommittedFileKeysStatement('extractor-current');
        const actual = (
          database.query(statement.text).all(...statement.parameters) as readonly {readonly path_hint: string}[]
        )
          .map(row => row.path_hint)
          .sort();
        expect(actual).toEqual(expectedPaths.sort());
      } finally {
        database.close(false);
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'never scores a test or documentation symbol path above an implementation path',
    {
      directories: FC.array(symbolPathDirectory, {maxLength: 3}),
      fileName: symbolFileName,
      queryTerms: FC.array(symbolQueryTerm, {maxLength: 3}),
    },
    ({directories, fileName, queryTerms}) => {
      const symbolPath = [...directories, fileName].join('/');
      const pathClass = codeGraphSymbolPathClass(symbolPath);
      const multiplier = codeGraphSymbolPathScoreMultiplier(symbolPath, queryTerms);

      expect(multiplier).toBeGreaterThan(0);
      expect(multiplier).toBeLessThanOrEqual(codeGraphSymbolPathScoreMultiplier('src/implementation.ts', queryTerms));
      expect(codeGraphSymbolPathClass(symbolPath.replaceAll('/', '\\'))).toBe(pathClass);
      expect(codeGraphSymbolPathClass(symbolPath.toUpperCase())).toBe(pathClass);
      expect(codeGraphSymbolPathScoreMultiplier(symbolPath, [])).toBeLessThanOrEqual(multiplier);
      expect(
        codeGraphSymbolPathScoreMultiplier(symbolPath, [...queryTerms, pathClass === 'test' ? 'test' : 'docs']),
      ).toBe(1);
      if (pathClass === 'implementation') expect(multiplier).toBe(1);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'preserves embedded code identities without treating repository paths as identity selectors',
    {
      identity: FC.constantFrom('Node.search', 'parse_html_dict', 'resolveTaskGraph'),
      prefix: FC.array(FC.constantFrom('find', 'queue', 'regex', 'transition'), {maxLength: 6}),
      suffix: FC.array(FC.constantFrom('child', 'count', 'static', 'target'), {maxLength: 6}),
    },
    ({identity, prefix, suffix}) => {
      const selectors = codeGraphIdentitySelectors(
        [...prefix, 'src/router/node.ts', `${identity}()`, ...suffix].join(' '),
      );
      expect(selectors).toContain(identity);
      expect(selectors).not.toContain('src/router/node.ts');
      expect(selectors.filter(selector => selector === identity)).toHaveLength(1);
    },
    {fastCheck: {numRuns: 64}},
  );

  fcProp(
    it,
    'preserves identity-bearing leaves from dotted qualified selectors',
    {
      leaf: FC.constantFrom('parse_html_dict', 'get_value', 'resolveTaskGraph'),
      namespace: FC.array(FC.stringMatching(/^[a-z][a-z0-9]{1,12}$/), {minLength: 1, maxLength: 4}),
    },
    ({leaf, namespace}) => {
      const qualified = [...namespace, leaf].join('.');
      const selectors = codeGraphIdentitySelectors(`src/fields.py trace ${qualified} callers`);

      expect(selectors).toContain(qualified);
      expect(selectors).toContain(leaf);
      expect(selectors).not.toContain('src/fields.py');
    },
    {fastCheck: {numRuns: 64}},
  );

  fcProp(
    it,
    'boosts side-effect owners only in implementation paths and only for behavior-focused queries',
    {
      action: FC.constantFrom('clearAllTabs', 'dismissDrawer', 'purgeCache', 'resetSession', 'wipeCredentials'),
      artifactTerm: FC.constantFrom('docs', 'test'),
      kind: FC.constantFrom('function', 'method'),
    },
    ({action, artifactTerm, kind}) => {
      const base = codeGraphSymbolPathScoreMultiplier('src/owner.ts', []);
      const owner = codeGraphSymbolSearchScoreMultiplier('src/owner.ts', kind, action, []);

      expect(owner).toBeGreaterThan(base);
      expect(codeGraphSymbolSearchScoreMultiplier('test/owner.test.ts', kind, action, [])).toBeLessThan(base);
      expect(codeGraphSymbolSearchScoreMultiplier('src/owner.ts', kind, action, [artifactTerm])).toBe(base);
      expect(codeGraphSymbolSearchScoreMultiplier('src/owner.ts', 'class', action, [])).toBe(base);
      expect(codeGraphSymbolSearchScoreMultiplier('src/owner.ts', kind, action, [])).toBe(owner);
    },
    {fastCheck: {numRuns: 100}},
  );

  it.effect('treats a database observed during partial schema publication as unavailable', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-schema-race-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* Effect.sync(() => new Database(databasePath).close(false));

        const [active, byId, byCommit] = yield* Effect.all([
          store.readySnapshot(databasePath, worktreeId),
          store.readySnapshotById(databasePath, currentSnapshotId),
          store.readySnapshotForCommit(databasePath, repositoryId, 'commit'),
        ]);

        expect(active).toBeUndefined();
        expect(byId).toBeUndefined();
        expect(byCommit).toBeUndefined();

        yield* Effect.sync(() => {
          const partial = new Database(databasePath);
          partial.exec('CREATE TABLE snapshots (id TEXT PRIMARY KEY)');
          partial.close(false);
        });

        expect(yield* store.readySnapshotForCommit(databasePath, repositoryId, 'commit')).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    it,
    'matches effective-overlay adjacency for incoming, outgoing, and deduplicated both-direction reads',
    {
      allowedProvenances: FC.uniqueArray(FC.constantFrom(...allProvenances), {maxLength: 5, minLength: 1}),
      base: FC.array(edgeSpec, {maxLength: 20}),
      current: FC.array(edgeSpec, {maxLength: 20}),
      deletedIds: FC.array(FC.integer({max: 15, min: 0}), {maxLength: 12}),
      direction: FC.constantFrom('both' as const, 'incoming' as const, 'outgoing' as const),
      limit: FC.integer({max: 20, min: 1}),
      nodeIds: FC.uniqueArray(FC.integer({max: 5, min: 0}), {maxLength: 4, minLength: 1}),
    },
    ({allowedProvenances, base, current, deletedIds, direction, limit, nodeIds}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-query-property-'});
          const databasePath = path.join(root, 'graph-v3.sqlite');
          yield* store.initialize(databasePath);

          const baseById = lastEdgeById(base);
          const currentById = lastEdgeById(current);
          const deletions = new Set(deletedIds.map(edgeId));
          yield* Effect.sync(() =>
            insertOverlayFixture(databasePath, [...baseById.values()], [...currentById.values()], deletions),
          );

          const requestedIds = nodeIds.map(nodeId);
          const actual = yield* store.edgesForNodes(
            databasePath,
            currentSnapshotId,
            requestedIds,
            direction,
            limit,
            allowedProvenances,
          );
          const expected = referenceAdjacency(
            baseById,
            currentById,
            deletions,
            new Set(requestedIds),
            direction,
            limit,
            new Set(allowedProvenances),
          );

          expect(actual.map(edgeIdentity)).toEqual(expected.map(edgeIdentity));
          expect(new Set(actual.map(edge => edge.id)).size).toBe(actual.length);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 35}},
  );

  it.effect('retains a direct source relationship ahead of high-fanout structural metadata', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-source-relation-priority-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const metadata = Array.from({length: 65}, (_, index) =>
          graphEdge({
            confidence: 100,
            id: index,
            provenance: 'declared',
            relation: 'contains',
            source: index + 1,
            target: 0,
          }),
        );
        const sourceImport = graphEdge({
          confidence: 100,
          id: 1_000,
          provenance: 'resolved',
          relation: 'imports',
          source: 1_000,
          target: 0,
        });
        yield* Effect.sync(() => insertOverlayFixture(databasePath, [], [...metadata, sourceImport], new Set()));

        const actual = yield* store.edgesForNodes(databasePath, currentSnapshotId, [nodeId(0)], 'incoming', 64, [
          'declared',
          'resolved',
        ]);

        expect(actual).toHaveLength(64);
        expect(actual[0]).toMatchObject({id: sourceImport.id, relation: 'imports'});
        expect(actual.filter(edge => edge.relation === 'contains')).toHaveLength(63);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('finds a direct path beyond the bounded adjacency prefix and reports bounded misses', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-direct-path-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const start = stableNodeId(0);
        const target = stableNodeId(1);
        const missing = stableNodeId(2);
        const distractors = Array.from({length: 65}, (_, index): CodeGraphEdge => ({
          ...graphEdge({
            confidence: 100,
            id: index,
            provenance: 'resolved',
            relation: 'imports',
            source: 0,
            target: index + 3,
          }),
          sourceId: start,
          targetId: stableNodeId(index + 3),
        }));
        const direct: CodeGraphEdge = {
          ...graphEdge({confidence: 100, id: 1_000, provenance: 'resolved', relation: 'imports', source: 0, target: 1}),
          sourceId: start,
          targetId: target,
        };
        yield* Effect.sync(() => {
          insertOverlayFixture(databasePath, [], [...distractors, direct], new Set());
          insertQuerySymbols(databasePath, [start, target, missing]);
        });

        const found = yield* pathQuery(store, databasePath, currentSnapshotId, start, target, 8, 8, 3, ['resolved']);
        const bounded = yield* pathQuery(store, databasePath, currentSnapshotId, start, missing, 8, 8, 3, ['resolved']);

        expect(found.edges.map(edge => edge.id)).toEqual([direct.id]);
        expect(found.searchCoverage).toMatchObject({status: 'found', directEdgeChecked: true});
        expect(bounded.edges).toEqual([]);
        expect(bounded.searchCoverage).toMatchObject({status: 'bounded', directEdgeChecked: true});
        expect(bounded.searchCoverage.limitsReached).toContain('edge-limit');
        expect(bounded.searchCoverage.visitedNodes).toBeLessThanOrEqual(8);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('excludes overridden and deleted base edges from the exact endpoint lookup', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-direct-overlay-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const direct = graphEdge({
          confidence: 100,
          id: 1,
          provenance: 'resolved',
          relation: 'calls',
          source: 0,
          target: 1,
        });
        const deleted = graphEdge({
          confidence: 90,
          id: 2,
          provenance: 'resolved',
          relation: 'calls',
          source: 0,
          target: 1,
        });
        const moved = {...direct, targetId: nodeId(2), targetName: nodeId(2)};
        yield* Effect.sync(() => insertOverlayFixture(databasePath, [direct, deleted], [moved], new Set([deleted.id])));

        expect(
          yield* store.directEdgeBetweenNodes(databasePath, currentSnapshotId, nodeId(0), nodeId(1), ['resolved']),
        ).toBeUndefined();
        expect(
          yield* store.directEdgeBetweenNodes(databasePath, currentSnapshotId, nodeId(0), nodeId(2), ['resolved']),
        ).toMatchObject({id: moved.id});

        const database = new Database(databasePath, {readonly: true, strict: true});
        try {
          const statement = codeGraphDirectEdgeQueryStatement(currentSnapshotId, baseSnapshotId, nodeId(0), nodeId(2), [
            'resolved',
          ]);
          const plan = queryPlan(database, statement.text, statement.parameters).join('\n');
          expect(plan).toContain('edges_endpoints');
          expect(plan).toContain('snapshot_id=? AND source_id=? AND target_id=?');
        } finally {
          database.close(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('reports a direct lookup that finishes after the path deadline as timed out', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-direct-deadline-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const start = stableNodeId(0);
        const target = stableNodeId(1);
        const direct: CodeGraphEdge = {
          ...graphEdge({confidence: 100, id: 1, provenance: 'resolved', relation: 'imports', source: 0, target: 1}),
          sourceId: start,
          targetId: target,
        };
        yield* Effect.sync(() => {
          insertOverlayFixture(databasePath, [], [direct], new Set());
          insertQuerySymbols(databasePath, [start, target]);
        });
        const delayedStore = {
          ...store,
          directEdgeBetweenNodes: (...args: Parameters<typeof store.directEdgeBetweenNodes>) =>
            store.directEdgeBetweenNodes(...args).pipe(Effect.tap(() => TestClock.adjust(2_001))),
        };

        const result = yield* pathQuery(delayedStore, databasePath, currentSnapshotId, start, target, 8, 8, 3, [
          'resolved',
        ]);
        expect(result.edges).toEqual([]);
        expect(result.searchCoverage).toMatchObject({status: 'timed-out', limitsReached: ['time-budget']});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    it,
    'widening path traversal bounds preserves any established path',
    {edgeLimit: FC.integer({min: 1, max: 12}), nodeLimit: FC.integer({min: 2, max: 12})},
    ({edgeLimit, nodeLimit}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-path-monotone-'});
          const databasePath = path.join(root, 'graph-v3.sqlite');
          yield* store.initialize(databasePath);
          const start = stableNodeId(0);
          const middle = stableNodeId(1);
          const target = stableNodeId(2);
          const edges: CodeGraphEdge[] = [
            {
              ...graphEdge({confidence: 100, id: 1, provenance: 'resolved', relation: 'calls', source: 0, target: 1}),
              sourceId: start,
              targetId: middle,
            },
            {
              ...graphEdge({confidence: 100, id: 2, provenance: 'resolved', relation: 'calls', source: 1, target: 2}),
              sourceId: middle,
              targetId: target,
            },
            ...Array.from({length: 5}, (_, index): CodeGraphEdge => ({
              ...graphEdge({
                confidence: 100,
                id: index + 3,
                provenance: 'resolved',
                relation: 'calls',
                source: 0,
                target: index + 3,
              }),
              sourceId: start,
              targetId: stableNodeId(index + 3),
            })),
          ];
          yield* Effect.sync(() => {
            insertOverlayFixture(databasePath, [], edges, new Set());
            insertQuerySymbols(databasePath, [start, middle, target]);
          });
          const narrow = yield* pathQuery(
            store,
            databasePath,
            currentSnapshotId,
            start,
            target,
            nodeLimit,
            edgeLimit,
            2,
            ['resolved'],
          );
          const wide = yield* pathQuery(
            store,
            databasePath,
            currentSnapshotId,
            start,
            target,
            nodeLimit + 4,
            edgeLimit + 4,
            2,
            ['resolved'],
          );
          const unbounded = yield* pathQuery(store, databasePath, currentSnapshotId, start, target, 20, 20, 2, [
            'resolved',
          ]);
          expect(unbounded.searchCoverage.status).toBe('found');
          if (narrow.searchCoverage.status === 'found') {
            expect(wide.searchCoverage.status).toBe('found');
            expect(wide.edges.at(-1)?.targetId).toBe(target);
          }
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 20}},
  );

  it.effect('retains a traversable edge ahead of unresolved direct source relationships', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-traversable-edge-priority-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const sourceId = nodeId(0);
        const targetId = nodeId(1);
        const unresolvedImports = Array.from({length: 65}, (_, index): CodeGraphEdge => ({
          confidence: 1,
          evidencePath: `src/unresolved-${index}.ts`,
          evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
          id: `unresolved-import-${String(index).padStart(2, '0')}`,
          provenance: 'syntactic',
          relation: 'imports',
          sourceId,
          sourceName: sourceId,
          targetName: `missing-${String(index).padStart(2, '0')}`,
        }));
        const usableCall = graphEdge({
          confidence: 100,
          id: 1_000,
          provenance: 'resolved',
          relation: 'calls',
          source: 0,
          target: 1,
        });
        const heuristicImport = graphEdge({
          confidence: 100,
          id: 1_001,
          provenance: 'heuristic',
          relation: 'imports',
          source: 0,
          target: 2,
        });
        yield* Effect.sync(() => {
          insertOverlayFixture(databasePath, [], [...unresolvedImports, usableCall, heuristicImport], new Set());
          insertQuerySymbols(databasePath, [sourceId, targetId]);
        });

        const adjacency = yield* store.edgesForNodes(databasePath, currentSnapshotId, [sourceId], 'outgoing', 64, [
          'heuristic',
          'resolved',
          'syntactic',
        ]);
        const neighbors = yield* neighborQuery(store, databasePath, currentSnapshotId, sourceId, 'outgoing', 2, 64, 1, [
          'heuristic',
          'resolved',
          'syntactic',
        ]);

        expect(adjacency).toHaveLength(64);
        expect(adjacency[0]).toMatchObject({id: usableCall.id, targetId});
        expect(adjacency[1]).toMatchObject({id: heuristicImport.id});
        expect(adjacency.filter(edge => edge.targetId === undefined)).toHaveLength(62);
        expect(neighbors.nodes.map(node => node.id)).toEqual([sourceId, targetId]);
        expect(neighbors.edges.map(edge => edge.id)).toEqual([usableCall.id]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('suppresses a base edge when its overlay replacement moves away from the requested node', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-overlay-query-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const base = [
          graphEdge({confidence: 90, id: 0, provenance: 'declared', relation: 'calls', source: 0, target: 1}),
          graphEdge({confidence: 80, id: 1, provenance: 'resolved', relation: 'calls', source: 0, target: 0}),
          graphEdge({confidence: 70, id: 2, provenance: 'syntactic', relation: 'imports', source: 2, target: 0}),
        ];
        const current = [
          graphEdge({confidence: 95, id: 0, provenance: 'declared', relation: 'calls', source: 4, target: 5}),
          graphEdge({confidence: 85, id: 3, provenance: 'resolved', relation: 'extends', source: 0, target: 3}),
        ];
        yield* Effect.sync(() => insertOverlayFixture(databasePath, base, current, new Set([edgeId(2)])));

        const [outgoing, both, summary] = yield* Effect.all([
          store.edgesForNodes(databasePath, currentSnapshotId, [nodeId(0)], 'outgoing', 20, allProvenances),
          store.edgesForNodes(databasePath, currentSnapshotId, [nodeId(0)], 'both', 20, allProvenances),
          store.relationshipSummaryForNode(databasePath, currentSnapshotId, nodeId(0), allProvenances),
        ]);

        expect(outgoing.map(edge => edge.id)).toEqual([edgeId(3), edgeId(1)]);
        expect(both.map(edge => edge.id)).toEqual([edgeId(3), edgeId(1)]);
        expect(summary).toMatchObject({incoming: 1, outgoing: 2});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('forces directional and exact-match indexes instead of scanning effective snapshots', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-query-plan-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          const highCardinalityBase = Array.from({length: 4_000}, (_, index) => ({
            symbol: index,
            term: index === 0 ? 'progress' : `base-noise-${index}`,
            weight: 1,
          }));
          const highCardinalityCurrent = Array.from({length: 2_000}, (_, index) => ({
            symbol: index,
            term: index === 1 ? 'manager' : `current-noise-${index}`,
            weight: 1,
          }));
          insertLexicalOverlayFixture(
            databasePath,
            highCardinalityBase,
            highCardinalityCurrent,
            new Set(),
            'compact',
            'compact',
          );
        });
        const database = new Database(databasePath, {strict: true});
        try {
          database.exec('ANALYZE');
          const adjacency = codeGraphAdjacencyQueryStatement(
            currentSnapshotId,
            baseSnapshotId,
            ['node-1', 'node-2'],
            'both',
            40,
            ['declared', 'resolved', 'syntactic'],
          );
          const adjacencyPlan = queryPlan(database, adjacency.text, adjacency.parameters);
          expect(adjacencyPlan.filter(detail => detail.includes('edges_source'))).toHaveLength(2);
          expect(adjacencyPlan.filter(detail => detail.includes('edges_target_resolved'))).toHaveLength(2);
          expect(adjacencyPlan.join('\n')).not.toMatch(/SCAN (?:current_edges|base_edges|effective_edges)/u);
          expect(adjacency.text.match(/LIMIT \?/gu)).toHaveLength(5);

          const exact = codeGraphExactSymbolQueryStatement(currentSnapshotId, baseSnapshotId, 'ProgressManager', 20);
          const exactPlan = queryPlan(database, exact.text, exact.parameters);
          for (const index of ['symbols_name_nocase', 'symbols_qualified_nocase', 'symbols_path_nocase']) {
            expect(exactPlan.filter(detail => detail.includes(index))).toHaveLength(2);
          }
          expect(exactPlan.join('\n')).not.toMatch(/SCAN (?:current_symbols|base_symbols|effective_symbols)/u);

          const byIds = codeGraphSymbolsByIdsQueryStatement(currentSnapshotId, baseSnapshotId, [
            'symbol-a',
            'symbol-b',
          ]);
          const byIdsPlan = queryPlan(database, byIds.text, byIds.parameters);
          expect(byIdsPlan).toContain('SEARCH current_symbols USING PRIMARY KEY (snapshot_id=? AND id=?)');
          expect(byIdsPlan).toContain('SEARCH base_symbols USING PRIMARY KEY (snapshot_id=? AND id=?)');
          expect(byIdsPlan.join('\n')).not.toMatch(/SCAN (?:current_symbols|base_symbols|effective_symbols)/u);

          const terms = codeGraphTermCandidateQueryStatement(
            currentSnapshotId,
            baseSnapshotId,
            ['progress', 'manager'],
            400,
          );
          const termPlan = queryPlan(database, terms.text, terms.parameters);
          expect(termPlan).toContain('SEARCH current_legacy_terms USING PRIMARY KEY (snapshot_id=? AND term=?)');
          expect(termPlan).toContain('SEARCH base_legacy_terms USING PRIMARY KEY (snapshot_id=? AND term=?)');
          expect(termPlan).toContain(
            'SEARCH current_compact_terms USING COVERING INDEX sqlite_autoindex_lexical_compact_terms_1 (snapshot_key=? AND term=?)',
          );
          expect(termPlan).toContain(
            'SEARCH current_compact_postings USING PRIMARY KEY (snapshot_key=? AND term_key=?)',
          );
          expect(termPlan).toContain(
            'SEARCH base_compact_terms USING COVERING INDEX sqlite_autoindex_lexical_compact_terms_1 (snapshot_key=? AND term=?)',
          );
          expect(termPlan).toContain('SEARCH base_compact_postings USING PRIMARY KEY (snapshot_key=? AND term_key=?)');
          expect(termPlan.join('\n')).not.toMatch(
            /SCAN (?:current_legacy_terms|base_legacy_terms|current_compact_postings|base_compact_postings|current_compact_symbols|base_compact_symbols|symbol_terms)/u,
          );
          const compactSnapshot = database
            .query('SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ?')
            .get(currentSnapshotId) as {readonly snapshot_key: number};
          for (const table of [
            'lexical_compact_postings',
            'lexical_compact_symbols',
            'lexical_compact_terms',
          ] as const) {
            const cleanup = codeGraphCompactLexicalCleanupPageStatement(table, compactSnapshot.snapshot_key, 5_000);
            const cleanupPlan = queryPlan(database, cleanup.text, cleanup.parameters).join('\n');
            expect(cleanupPlan).toMatch(/SEARCH candidate USING (?:PRIMARY KEY|COVERING INDEX).*snapshot_key=/u);
            expect(cleanupPlan).not.toMatch(/SCAN candidate|USE TEMP B-TREE/u);
          }
        } finally {
          database.close(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    it,
    'preserves canonical rows and exact ranking across mixed lexical formats, overrides, and deletions',
    {
      base: FC.array(lexicalPostingSpec, {maxLength: 30}),
      baseFormat: FC.constantFrom<LexicalFixtureFormat>('compact', 'legacy'),
      current: FC.array(lexicalPostingSpec, {maxLength: 30}),
      currentFormat: FC.constantFrom<LexicalFixtureFormat>('compact', 'legacy'),
      deletedSymbols: FC.array(FC.integer({max: 7, min: 0}), {maxLength: 8}),
      limit: FC.integer({max: 20, min: 1}),
      terms: FC.uniqueArray(FC.constantFrom('alpha', 'beta', 'delta', 'gamma', 'omega'), {
        maxLength: 5,
        minLength: 1,
      }),
    },
    ({base, baseFormat, current, currentFormat, deletedSymbols, limit, terms}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-lexical-mixed-property-'});
          const databasePath = path.join(root, 'graph-v3.sqlite');
          yield* store.initialize(databasePath);
          const expected = yield* Effect.sync(() =>
            insertLexicalOverlayFixture(
              databasePath,
              base,
              current,
              new Set(deletedSymbols.map(lexicalSymbolId)),
              baseFormat,
              currentFormat,
            ),
          );

          const actual = yield* Effect.sync(() => {
            const database = new Database(databasePath, {readonly: true, strict: true});
            try {
              const candidates = codeGraphTermCandidateQueryStatement(currentSnapshotId, baseSnapshotId, terms, limit);
              const rows = database.query(candidates.text).all(...candidates.parameters) as readonly {
                readonly score: number;
                readonly symbol_id: string;
              }[];
              const canonical = codeGraphEffectiveSymbolTermsQueryStatement(currentSnapshotId, baseSnapshotId);
              const canonicalRows = database.query(canonical.text).all(...canonical.parameters) as readonly {
                readonly symbol_id: string;
                readonly term: string;
                readonly weight: number;
              }[];
              return {canonicalRows, rows};
            } finally {
              database.close(false);
            }
          });
          const expectedScores = lexicalCandidateReference(expected, new Set(terms), limit);
          expect(actual.canonicalRows).toEqual(expected);
          expect(actual.rows.map(row => ({score: Number(row.score), symbol_id: row.symbol_id}))).toEqual(
            expectedScores,
          );
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 80}},
  );

  it.effect('bounds every branch before merging a high-degree adjacency result', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-high-degree-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        const edges = Array.from({length: 50_000}, (_, index): CodeGraphEdge => ({
          confidence: (100 - (index % 100)) / 100,
          evidencePath: `src/high-degree-${index}.ts`,
          evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
          id: `high-degree-${String(index).padStart(6, '0')}`,
          provenance: allProvenances[index % allProvenances.length],
          relation: relations[index % relations.length],
          sourceId: 'hub',
          sourceName: 'hub',
          targetId: `leaf-${index}`,
          targetName: `leaf-${String(index).padStart(6, '0')}`,
        }));
        yield* Effect.sync(() => insertOverlayFixture(databasePath, [], edges, new Set()));

        const startedAt = performance.now();
        const actual = yield* store.edgesForNodes(
          databasePath,
          currentSnapshotId,
          ['hub'],
          'outgoing',
          40,
          allProvenances,
        );
        const elapsedMilliseconds = performance.now() - startedAt;
        const expected = [...edges].sort(compareEdges).slice(0, 40);

        expect(actual.map(edge => edge.id)).toEqual(expected.map(edge => edge.id));
        expect(elapsedMilliseconds).toBeLessThan(2_000);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('ranks an exact-case declaration above case-insensitive local properties', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-ranking-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => insertRankingFixture(databasePath));

        const results = yield* store.searchSymbols(databasePath, currentSnapshotId, 'ProgressManager', 20);

        expect(results.map(result => [result.kind, result.name, result.score])).toEqual([
          ['class', 'ProgressManager', 1],
          ['property', 'progressManager', 0.98],
          ['property', 'progressManager', 0.98],
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('reserves a qualified symbol identity embedded in a natural-language query', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-qualified-query-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => insertRankingFixture(databasePath));

        const results = yield* store.searchSymbols(
          databasePath,
          currentSnapshotId,
          'Which Node.search queue transition advances the regex child?',
          3,
        );

        expect(results[0]).toMatchObject({
          id: 'method-node-search',
          qualifiedName: 'Node.search',
          score: 0.99,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('reserves a snake-case symbol identity embedded in a verbose natural-language query', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-snake-query-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => insertRankingFixture(databasePath));

        const results = yield* store.searchSymbols(
          databasePath,
          currentSnapshotId,
          'rest_framework/fields.py trace html.parse_html_dict callers and absence/empty-dictionary semantics',
          3,
        );

        expect(results[0]).toMatchObject({
          id: 'function-parse-html-dict',
          name: 'parse_html_dict',
          score: 1,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('resolves an exact repository path without broad lexical candidate expansion', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-exact-path-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => insertExactPathFixture(databasePath));

        const results = yield* store.searchSymbols(databasePath, currentSnapshotId, '.\\src\\feature\\button.ts', 20);

        expect(results.map(result => [result.kind, result.name, result.path, result.score])).toEqual([
          ['module', 'src/feature/button.ts', 'src/feature/button.ts', 1],
          ['function', 'createButton', 'src/feature/button.ts', 0.9],
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('preserves canonical Bazel labels for exact qualified-name lookup', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-bazel-label-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => insertBazelLabelFixture(databasePath));

        const [rootTarget, nestedTarget] = yield* Effect.all([
          store.searchSymbols(databasePath, currentSnapshotId, '//:main', 20),
          store.searchSymbols(databasePath, currentSnapshotId, '//platform/build:runner', 20),
        ]);

        expect(rootTarget[0]).toMatchObject({
          kind: 'target',
          language: 'bazel-build',
          path: 'BUILD.bazel',
          qualifiedName: '//:main',
          score: 0.99,
        });
        expect(nestedTarget[0]).toMatchObject({
          kind: 'target',
          language: 'bazel-build',
          path: 'platform/build/BUILD.bazel',
          qualifiedName: '//platform/build:runner',
          score: 0.99,
        });
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    it,
    'distinguishes canonical absolute Bazel labels from repository paths',
    {
      packageSegments: FC.array(bazelLabelSegment, {maxLength: 5}),
      repository: FC.option(bazelLabelSegment, {nil: undefined}),
      target: bazelLabelSegment,
    },
    ({packageSegments, repository, target}) =>
      Effect.sync(() => {
        const repositoryPrefix = repository === undefined ? '' : `@${repository}`;
        const label = `${repositoryPrefix}//${packageSegments.join('/')}:${target}`;
        expect(isCanonicalAbsoluteBazelLabel(label)).toBe(true);
        expect(isCanonicalAbsoluteBazelLabel(label.replace('//', '/'))).toBe(false);
        expect(isCanonicalAbsoluteBazelLabel(`${packageSegments.join('/')}/${target}.ts`)).toBe(false);
      }),
    {fastCheck: {numRuns: 100}},
  );
});

function cacheAuthorityDatabase(): Database {
  const database = new Database(':memory:', {strict: true});
  database.exec(`
    CREATE TABLE file_blobs (
      content_hash TEXT NOT NULL,
      extractor_set TEXT NOT NULL,
      path_hint TEXT NOT NULL,
      blob_id TEXT,
      reuse_class TEXT,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash, extractor_set, path_hint)
    ) WITHOUT ROWID;
    ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE_SQL};
    ${CODE_GRAPH_FILE_BLOB_AUTHORITY_TRIGGER_SQL.join(';\n')};
  `);
  return database;
}

function lastEdgeById(values: readonly EdgeSpec[]): ReadonlyMap<string, CodeGraphEdge> {
  const output = new Map<string, CodeGraphEdge>();
  for (const value of values) output.set(edgeId(value.id), graphEdge(value));
  return output;
}

function graphEdge(value: EdgeSpec): CodeGraphEdge {
  const sourceId = value.source === undefined ? undefined : nodeId(value.source);
  const targetId = value.target === undefined ? undefined : nodeId(value.target);
  return {
    confidence: value.confidence / 100,
    evidencePath: `src/${value.id}.ts`,
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id: edgeId(value.id),
    provenance: value.provenance,
    relation: value.relation,
    sourceId,
    sourceName: sourceId ?? `unresolved-source-${value.id}`,
    targetId,
    targetName: targetId ?? `unresolved-target-${value.id}`,
  };
}

function referenceAdjacency(
  base: ReadonlyMap<string, CodeGraphEdge>,
  current: ReadonlyMap<string, CodeGraphEdge>,
  deletions: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>,
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: ReadonlySet<CodeGraphProvenance>,
): readonly CodeGraphEdge[] {
  const effective = new Map(current);
  for (const [id, edge] of base) {
    if (!current.has(id) && !deletions.has(id)) effective.set(id, edge);
  }
  return [...effective.values()]
    .filter(edge => {
      if (!allowedProvenances.has(edge.provenance)) return false;
      if (direction === 'incoming') return edge.targetId !== undefined && nodeIds.has(edge.targetId);
      if (direction === 'outgoing') return edge.sourceId !== undefined && nodeIds.has(edge.sourceId);
      return (
        (edge.sourceId !== undefined && nodeIds.has(edge.sourceId)) ||
        (edge.targetId !== undefined && nodeIds.has(edge.targetId))
      );
    })
    .sort(compareEdges)
    .slice(0, limit);
}

function compareEdges(left: CodeGraphEdge, right: CodeGraphEdge): number {
  return (
    endpointCompletenessOrder(left) - endpointCompletenessOrder(right) ||
    authorityOrder(left.provenance) - authorityOrder(right.provenance) ||
    sourceRelationshipOrder(left.relation) - sourceRelationshipOrder(right.relation) ||
    provenanceOrder(left.provenance) - provenanceOrder(right.provenance) ||
    right.confidence - left.confidence ||
    compareText(left.sourceName, right.sourceName) ||
    compareText(left.relation, right.relation) ||
    compareText(left.targetName, right.targetName) ||
    compareText(left.id, right.id)
  );
}

function authorityOrder(provenance: CodeGraphProvenance): number {
  return provenance === 'heuristic' || provenance === 'model' ? 1 : 0;
}

function endpointCompletenessOrder(edge: CodeGraphEdge): number {
  return edge.sourceId === undefined || edge.targetId === undefined ? 1 : 0;
}

function sourceRelationshipOrder(relation: CodeGraphEdge['relation']): number {
  return relation === 'exports' || relation === 'imports' || relation === 'reexports' || relation === 'tests' ? 0 : 1;
}

function provenanceOrder(provenance: CodeGraphProvenance): number {
  if (provenance === 'declared') return 0;
  if (provenance === 'resolved') return 1;
  if (provenance === 'syntactic') return 2;
  return 3;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function edgeIdentity(edge: CodeGraphEdge): readonly unknown[] {
  return [
    edge.id,
    edge.sourceId,
    edge.targetId,
    edge.provenance,
    edge.relation,
    edge.confidence,
    edge.sourceName,
    edge.targetName,
  ];
}

interface LexicalCanonicalRow {
  readonly symbol_id: string;
  readonly term: string;
  readonly weight: number;
}

function insertLexicalOverlayFixture(
  databasePath: string,
  baseInput: readonly LexicalPostingSpec[],
  currentInput: readonly LexicalPostingSpec[],
  deletedSymbolIds: ReadonlySet<string>,
  baseFormat: LexicalFixtureFormat,
  currentFormat: LexicalFixtureFormat,
): readonly LexicalCanonicalRow[] {
  const base = normalizedLexicalPostings(baseInput);
  const current = normalizedLexicalPostings(currentInput);
  const currentSymbolIds = new Set(current.map(row => row.symbol_id));
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, baseSnapshotId, undefined, 0);
      insertSnapshot(database, currentSnapshotId, baseSnapshotId, 0);
      insertLexicalSnapshot(database, baseSnapshotId, base, baseFormat);
      insertLexicalSnapshot(database, currentSnapshotId, current, currentFormat);
      const deletion = database.query('INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id) VALUES (?, ?)');
      for (const symbolId of [...deletedSymbolIds].sort()) deletion.run(currentSnapshotId, symbolId);
    })();
  } finally {
    database.close(false);
  }
  return [
    ...current,
    ...base.filter(row => !currentSymbolIds.has(row.symbol_id) && !deletedSymbolIds.has(row.symbol_id)),
  ].sort(
    (left, right) => left.term.localeCompare(right.term, 'en') || left.symbol_id.localeCompare(right.symbol_id, 'en'),
  );
}

function normalizedLexicalPostings(input: readonly LexicalPostingSpec[]): readonly LexicalCanonicalRow[] {
  const rows = new Map<string, LexicalCanonicalRow>();
  for (const posting of input) {
    const symbolId = lexicalSymbolId(posting.symbol);
    const key = `${posting.term}\0${symbolId}`;
    const current = rows.get(key);
    if (current === undefined || posting.weight > current.weight) {
      rows.set(key, {symbol_id: symbolId, term: posting.term, weight: posting.weight});
    }
  }
  return [...rows.values()].sort(
    (left, right) => left.term.localeCompare(right.term, 'en') || left.symbol_id.localeCompare(right.symbol_id, 'en'),
  );
}

function insertLexicalSnapshot(
  database: Database,
  snapshotId: string,
  postings: readonly LexicalCanonicalRow[],
  format: LexicalFixtureFormat,
): void {
  const symbolIds = [...new Set(postings.map(row => row.symbol_id))].sort();
  const insertSymbol = database.query(`INSERT INTO symbols (
    snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
    lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
    signature, documentation, span_json
  ) VALUES (?, ?, ?, 'function', ?, ?, ?, 'typescript', NULL, '[]', 'typescript', NULL, NULL, 1, NULL, NULL, ?)`);
  for (const symbolId of symbolIds) {
    insertSymbol.run(
      snapshotId,
      symbolId,
      `hash-${snapshotId}-${symbolId}`,
      symbolId,
      symbolId,
      `src/${symbolId}.ts`,
      spanJson,
    );
  }
  database.query('UPDATE snapshots SET symbol_count = ? WHERE id = ?').run(symbolIds.length, snapshotId);
  if (format === 'legacy') {
    const insert = database.query(
      'INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight) VALUES (?, ?, ?, ?)',
    );
    for (const posting of postings) insert.run(snapshotId, posting.term, posting.symbol_id, posting.weight);
    return;
  }
  database.query('INSERT INTO lexical_compact_snapshots (snapshot_id) VALUES (?)').run(snapshotId);
  const compact = database
    .query('SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ?')
    .get(snapshotId) as {readonly snapshot_key: number};
  const insertCompactSymbol = database.query(
    'INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id) VALUES (?, ?)',
  );
  for (const symbolId of symbolIds) insertCompactSymbol.run(compact.snapshot_key, symbolId);
  const terms = [...new Set(postings.map(row => row.term))].sort();
  const insertTerm = database.query('INSERT INTO lexical_compact_terms (snapshot_key, term) VALUES (?, ?)');
  for (const term of terms) insertTerm.run(compact.snapshot_key, term);
  const insertPosting = database.query(
    `INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
     SELECT ?, term.term_key, symbol.symbol_key, ?
     FROM lexical_compact_terms AS term, lexical_compact_symbols AS symbol
     WHERE term.snapshot_key = ? AND term.term = ?
       AND symbol.snapshot_key = ? AND symbol.symbol_id = ?`,
  );
  for (const posting of postings) {
    insertPosting.run(
      compact.snapshot_key,
      posting.weight,
      compact.snapshot_key,
      posting.term,
      compact.snapshot_key,
      posting.symbol_id,
    );
  }
  database
    .query(
      `INSERT INTO lexical_storage_formats (
         snapshot_id, format_version, posting_count, symbol_count, term_count, created_at
       ) VALUES (?, 1, ?, ?, ?, ?)`,
    )
    .run(snapshotId, postings.length, symbolIds.length, terms.length, timestamp);
}

function lexicalCandidateReference(
  rows: readonly LexicalCanonicalRow[],
  terms: ReadonlySet<string>,
  limit: number,
): readonly {readonly score: number; readonly symbol_id: string}[] {
  const scores = new Map<string, number>();
  for (const row of rows) {
    if (terms.has(row.term)) scores.set(row.symbol_id, (scores.get(row.symbol_id) ?? 0) + row.weight);
  }
  return [...scores]
    .map(([symbol_id, score]) => ({score, symbol_id}))
    .sort((left, right) => right.score - left.score || left.symbol_id.localeCompare(right.symbol_id, 'en'))
    .slice(0, limit);
}

function lexicalSymbolId(value: number): string {
  return `lexical-symbol-${value}`;
}

function insertOverlayFixture(
  databasePath: string,
  base: readonly CodeGraphEdge[],
  current: readonly CodeGraphEdge[],
  deletions: ReadonlySet<string>,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, baseSnapshotId, undefined, base.length);
      insertSnapshot(database, currentSnapshotId, baseSnapshotId, current.length);
      for (const edge of base) insertEdge(database, baseSnapshotId, edge);
      for (const edge of current) insertEdge(database, currentSnapshotId, edge);
      const deletion = database.query('INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id) VALUES (?, ?)');
      for (const id of deletions) deletion.run(currentSnapshotId, id);
    })();
  } finally {
    database.close(false);
  }
}

function insertRankingFixture(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, currentSnapshotId, undefined, 0);
      const insert = database.query(`INSERT INTO symbols (
        snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, NULL, NULL, 1, NULL, NULL, ?)`);
      insert.run(
        currentSnapshotId,
        'class-progress-manager',
        'hash-class',
        'class',
        'ProgressManager',
        'com.example.ProgressManager',
        'src/ProgressManager.java',
        'java',
        'java',
        spanJson,
      );
      insert.run(
        currentSnapshotId,
        'method-node-search',
        'hash-method-node-search',
        'method',
        'search',
        'Node.search',
        'src/router/node.ts',
        'typescript',
        'typescript',
        spanJson,
      );
      insert.run(
        currentSnapshotId,
        'function-parse-html-dict',
        'hash-function-parse-html-dict',
        'function',
        'parse_html_dict',
        'parse_html_dict',
        'rest_framework/utils/html.py',
        'python',
        'python',
        spanJson,
      );
      for (const [id, path] of [
        ['property-a', 'src/A.kt'],
        ['property-b', 'src/B.kt'],
      ] as const) {
        insert.run(
          currentSnapshotId,
          id,
          `hash-${id}`,
          'property',
          'progressManager',
          `com.example.${id}.progressManager`,
          path,
          'kotlin',
          'kotlin',
          spanJson,
        );
      }
    })();
  } finally {
    database.close(false);
  }
}

function insertQuerySymbols(databasePath: string, ids: readonly string[]): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insert = database.query(`INSERT INTO symbols (
      snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
      lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
      signature, documentation, span_json
    ) VALUES (?, ?, ?, 'function', ?, ?, ?, 'typescript', NULL, '[]', 'typescript', NULL, NULL, 1, NULL, NULL, ?)`);
    database.transaction(() => {
      for (const id of ids) insert.run(currentSnapshotId, id, `hash-${id}`, id, id, `src/${id}.ts`, spanJson);
    })();
  } finally {
    database.close(false);
  }
}

function insertExactPathFixture(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, currentSnapshotId, undefined, 0);
      const insert = database.query(`INSERT INTO symbols (
        snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'typescript', NULL, '[]', 'typescript', NULL, NULL, 1, NULL, NULL, ?)`);
      insert.run(
        currentSnapshotId,
        'module-button',
        'hash-module-button',
        'module',
        'src/feature/button.ts',
        'src/feature/button.ts',
        'src/feature/button.ts',
        spanJson,
      );
      insert.run(
        currentSnapshotId,
        'function-create-button',
        'hash-function-create-button',
        'function',
        'createButton',
        'src/feature/button.ts#createButton',
        'src/feature/button.ts',
        spanJson,
      );
    })();
  } finally {
    database.close(false);
  }
}

function insertBazelLabelFixture(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.transaction(() => {
      insertRepository(database);
      insertSnapshot(database, currentSnapshotId, undefined, 0);
      const insert = database.query(`INSERT INTO symbols (
        snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json
      ) VALUES (?, ?, ?, 'target', ?, ?, ?, 'bazel-build', NULL, '[]', 'bazel', NULL, NULL, 1, NULL, NULL, ?)`);
      insert.run(
        currentSnapshotId,
        'bazel-root-main',
        'hash-bazel-root-main',
        'main',
        '//:main',
        'BUILD.bazel',
        spanJson,
      );
      insert.run(
        currentSnapshotId,
        'bazel-platform-runner',
        'hash-bazel-platform-runner',
        'runner',
        '//platform/build:runner',
        'platform/build/BUILD.bazel',
        spanJson,
      );
    })();
  } finally {
    database.close(false);
  }
}

function insertRepository(database: Database): void {
  database
    .query(
      `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES (?, 'query-property', 'sha1', ?, ?)`,
    )
    .run(repositoryId, timestamp, timestamp);
}

function insertSnapshot(database: Database, id: string, base: string | undefined, edgeCount: number): void {
  database
    .query(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set, dirty,
         overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at, failure_summary
       ) VALUES (?, ?, ?, 'commit', ?, 'query-property', 0, NULL, 'ready', 0, 0, ?, ?, ?, NULL)`,
    )
    .run(id, repositoryId, worktreeId, base ?? null, edgeCount, timestamp, timestamp);
}

function insertEdge(database: Database, snapshotId: string, edge: CodeGraphEdge): void {
  database
    .query(
      `INSERT INTO edges (
         snapshot_id, id, source_id, source_name, relation, target_id, target_name,
         provenance, confidence, evidence_path, evidence_span_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      snapshotId,
      edge.id,
      edge.sourceId ?? null,
      edge.sourceName,
      edge.relation,
      edge.targetId ?? null,
      edge.targetName,
      edge.provenance,
      edge.confidence,
      edge.evidencePath,
      JSON.stringify(edge.evidenceSpan),
    );
}

function queryPlan(database: Database, statement: string, parameters: readonly (number | string)[]): readonly string[] {
  return (
    database.query(`EXPLAIN QUERY PLAN ${statement}`).all(...parameters) as readonly {
      readonly detail: string;
    }[]
  ).map(row => row.detail);
}

function edgeId(value: number): string {
  return `edge-${value}`;
}

function nodeId(value: number): string {
  return `node-${value}`;
}

function stableNodeId(value: number): string {
  return `cgs_${value.toString(16).padStart(32, '0')}`;
}

const spanJson = JSON.stringify({column: 1, endColumn: 2, endLine: 1, line: 1});
const timestamp = '2026-08-01T00:00:00.000Z';
