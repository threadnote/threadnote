import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {Clock, Deferred, Effect, Fiber, Layer, Option} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {
  groupManagerGraphRepositories,
  ManagerGraphBusyError,
  ManagerGraphQueryLifecycle,
  managerGraphAnalysis,
  managerGraphCatalog,
  managerGraphQuery,
  managerGraphViewsPage,
  releaseManagerGraphSnapshotLeases,
  withManagerGraphSnapshotLeaseInvalidated,
} from '@threadnote/graph/visualization';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {
  CodeGraphStore,
  codeGraphVisualizationCatalogComponentStatement,
  codeGraphVisualizationScopeEdgeSampleStatements,
  codeGraphVisualizationScopeEndpointStatement,
  codeGraphVisualizationScopeSummaryStatementCount,
  codeGraphVisualizationScopeSymbolSampleStatements,
  codeGraphVisualizationSymbolsQueryStatement,
  type CodeGraphVisualizationCatalog,
} from '@threadnote/graph/store';

import type {CodeGraphWorkspace} from '@threadnote/graph/languages/types';
import {CodeGraphStoreError} from '@threadnote/graph/types';
import {
  COMPONENT_SCOPE_TEMP_TABLE,
  componentEdgeAggregateMaterializationStatement,
} from '@threadnote/graph/store/component_aggregates';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const temporaryRoots: string[] = [];
const storeLayer = Layer.merge(CodeGraphStore.layer, TestCommandExecutorLayer).pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);
const embeddingLayer = Layer.succeed(
  CodeGraphEmbeddingIndex,
  CodeGraphEmbeddingIndex.of({
    check: () => Effect.succeed({reason: 'disabled for Manager catalog tests', state: 'unavailable'}),
    ensure: () => Effect.succeed({embedded: 0, ready: false, reason: 'disabled for tests', reused: 0}),
    search: () => Effect.succeed(new Map()),
  }),
);
const managerGraphLayer = Layer.merge(storeLayer, embeddingLayer);

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('Manager logical repository and workspace catalogs', () => {
  effectIt.effect('upgrades an existing v3 store additively without replacing its data', () =>
    Effect.gen(function* () {
      const root = temporaryRoot('threadnote-workspace-migration-');
      const databasePath = join(root, 'graph-v3.sqlite');
      yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }).pipe(provideTestLayer(storeLayer));
      const legacy = new Database(databasePath);
      legacy.run("INSERT INTO schema_metadata (key, value) VALUES ('legacy_marker', 'preserve-me')");
      legacy.run('DROP INDEX IF EXISTS symbols_resolution_scope');
      legacy.run('DROP INDEX symbols_visualization_scope_v2');
      legacy.run('DROP INDEX symbols_visualization_package_v2');
      legacy.run('DROP INDEX symbols_visualization_path_v2');
      legacy.run('DROP TABLE workspace_component_dependencies');
      legacy.run('DROP TABLE workspace_components');
      legacy.run('DROP TABLE workspace_scopes');
      legacy.run('ALTER TABLE symbols DROP COLUMN resolution_scope_id');
      legacy.close();

      yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }).pipe(provideTestLayer(storeLayer));
      const migrated = new Database(databasePath, {readonly: true});
      expect(migrated.query("SELECT value FROM schema_metadata WHERE key = 'legacy_marker'").get()).toEqual({
        value: 'preserve-me',
      });
      expect(
        migrated.query("SELECT name FROM pragma_table_info('symbols') WHERE name = 'resolution_scope_id'").get(),
      ).toEqual({name: 'resolution_scope_id'});
      expect(
        migrated.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_components'").get(),
      ).toEqual({name: 'workspace_components'});
      expect(
        migrated
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('symbols_name', 'symbols_resolution_scope', 'edges_target') ORDER BY name",
          )
          .all(),
      ).toEqual([]);
      expect(
        migrated.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'edges_target_resolved'").get(),
      ).toEqual({name: 'edges_target_resolved'});
      migrated.close();
    }),
  );

  effectIt.effect('preserves the original build start and records completion only after activation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = temporaryRoot('threadnote-activation-timestamps-');
        const databasePath = join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root, Effect2.pipe('1', EffectString.repeat(64)));
        const requested = readySnapshot(identity, 0, 0, 0, '2000-01-01T00:00:00.000Z');

        yield* Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.markBuilding(databasePath, identity, {...requested, completedAt: undefined, state: 'building'});
        }).pipe(provideTestLayer(storeLayer));
        const before = new Database(databasePath, {readonly: true});
        const startedAt = requiredRow(
          before
            .query<{started_at: string}, SQLQueryBindings[]>('SELECT started_at FROM snapshots WHERE id = ?')
            .get(requested.id),
        ).started_at;
        before.close();
        yield* Effect.sleep(10);

        yield* Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(
            databasePath,
            Effect.gen(function* () {
              yield* store.prepareActivation(databasePath, []);
              yield* store.stageActivationFacts(databasePath, [], []);
              yield* store.activateStaged(databasePath, identity, requested);
            }),
          );
        }).pipe(provideTestLayer(storeLayer));

        const after = new Database(databasePath, {readonly: true});
        const activated = requiredRow(
          after
            .query<{completed_at: string; started_at: string; state: string}, SQLQueryBindings[]>(
              'SELECT state, started_at, completed_at FROM snapshots WHERE id = ?',
            )
            .get(requested.id),
        );
        after.close();
        expect(activated).toMatchObject({started_at: startedAt, state: 'ready'});
        expect(activated.completed_at).not.toBe(requested.completedAt);
        expect(Date.parse(activated.completed_at)).toBeGreaterThanOrEqual(Date.parse(startedAt));
      }),
    ),
  );

  effectIt.effect('rejects an incremental staging identity mismatch without mutating staged facts', () =>
    Effect.gen(function* () {
      const root = temporaryRoot('threadnote-incremental-staging-');
      const databasePath = join(root, 'graph-v3.sqlite');
      const identity = repositoryIdentity(root, Effect2.pipe('1', EffectString.repeat(64)));
      const originalSymbol = symbol('symbol-original', 'src/value.ts', 'value', 'typescript');
      const originalFiles = fileFixtures([originalSymbol]);
      const base = readySnapshot(identity, 1, 1, 0, '2026-07-31T10:00:00.000Z');
      const overlay: CodeGraphSnapshot = {
        ...readySnapshot(identity, 1, 1, 0, '2026-07-31T10:01:00.000Z'),
        baseSnapshotId: base.id,
        dirty: true,
        overlayFingerprint: 'dirty-overlay',
      };
      const modifiedFile = {...originalFiles[0], contentHash: 'modified-file-hash'};
      const modifiedSymbol = {...originalSymbol, contentHash: 'modified-symbol-hash', documentation: 'must not stage'};
      const modifiedFacts: CodeGraphFileFacts = {
        diagnostics: [],
        edges: [],
        path: modifiedFile.path,
        symbols: [modifiedSymbol],
      };

      const result = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(databasePath, originalFiles);
            yield* store.stageActivationFacts(databasePath, [originalSymbol], []);
            yield* store.activateStaged(databasePath, identity, base);
            const replaced = yield* store.replaceStagedModifiedFiles(
              databasePath,
              'not-the-active-staging-id',
              [modifiedFile],
              [modifiedFacts],
            );
            yield* store.activateStaged(databasePath, identity, overlay);
            return {graph: yield* store.loadGraph(databasePath, overlay.id), replaced};
          }),
        );
      }).pipe(provideTestLayer(storeLayer));

      expect(result.replaced).toBe(false);
      expect(result.graph.symbols).toEqual([originalSymbol]);
    }),
  );

  effectIt.effect('loads every active worktree view from one checkout without collapsing them', () =>
    Effect.gen(function* () {
      const root = temporaryRoot('threadnote-worktree-views-');
      const databasePath = join(root, 'graph-v3.sqlite');
      const firstIdentity = repositoryIdentity(root, Effect2.pipe('2', EffectString.repeat(64)));
      const secondIdentity: RepositoryIdentity = {
        ...firstIdentity,
        headCommit: '1234567890abcdef1234567890abcdef12345678',
        worktreeId: Effect2.pipe('a', EffectString.repeat(64)),
      };
      const first = readySnapshot(firstIdentity, 0, 0, 0, '2026-07-30T10:00:00.000Z');
      const second = readySnapshot(secondIdentity, 0, 0, 0, '2026-07-31T10:00:00.000Z');

      const catalogs = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, firstIdentity, first, [], [], []);
        yield* store.promote(databasePath, firstIdentity, first.id);
        yield* store.activate(databasePath, secondIdentity, second, [], [], []);
        yield* store.promote(databasePath, secondIdentity, second.id);
        return yield* store.loadVisualizationCatalogs(databasePath);
      }).pipe(provideTestLayer(storeLayer));

      expect(EffectArray.map(catalogs, catalog => catalog.viewWorktreeId)).toEqual([
        secondIdentity.worktreeId,
        firstIdentity.worktreeId,
      ]);
      expect(new Set(EffectArray.map(catalogs, catalog => catalog.snapshot.id))).toEqual(
        new Set([first.id, second.id]),
      );
    }),
  );

  effectIt.effect(
    'persists same-name components, keeps unscoped documentation as a facet, and aggregates edges beyond row 1200',
    () =>
      Effect.gen(function* () {
        const root = temporaryRoot('threadnote-workspace-catalog-');
        const databasePath = join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root, Effect2.pipe('1', EffectString.repeat(64)));
        const workspace = workspaceFixture();
        const symbols = symbolFixtures();
        const edges = edgeFixtures();
        const files = fileFixtures(symbols);
        const snapshot = readySnapshot(
          identity,
          files.length,
          symbols.length,
          edges.length,
          '2026-07-31T10:00:00.000Z',
        );

        const result = yield* Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(
            databasePath,
            Effect.gen(function* () {
              yield* store.prepareActivation(databasePath, files);
              yield* store.stageWorkspaceCatalog(databasePath, workspace);
              yield* store.stageActivationFacts(databasePath, symbols, edges);
              yield* store.activateStaged(databasePath, identity, snapshot);
              yield* store.promote(databasePath, identity, snapshot.id);
            }),
          );
          const aggregatesBuilt = yield* store.ensureAnalysisSummary(databasePath, snapshot.id);
          const aggregatesReused = yield* store.ensureAnalysisSummary(databasePath, snapshot.id);
          const highFanStartedAt = performance.now();
          const highFanSummary = yield* store.relationshipSummaryForNode(
            databasePath,
            snapshot.id,
            'symbol-a-1',
            ['resolved'],
            128,
          );
          const highFanElapsedMilliseconds = performance.now() - highFanStartedAt;
          const representativeStartedAt = performance.now();
          const representativeEdges = yield* store.representativeEdgesForNodes(
            databasePath,
            snapshot.id,
            ['symbol-a-1', 'symbol-a-2', 'symbol-b'],
            'both',
            20,
            ['resolved'],
          );
          const representativeElapsedMilliseconds = performance.now() - representativeStartedAt;
          return {
            boundedScopeEdges: yield* store.loadVisualizationScopeEdgeSummary(
              databasePath,
              snapshot.id,
              ['cgp_component_a', 'cgp_component_b', 'facet:unscoped'],
              20,
            ),
            catalog: yield* store.loadVisualizationCatalog(databasePath),
            aggregatesBuilt,
            aggregatesReused,
            deferredCatalog: yield* store.loadVisualizationCatalog(databasePath, 'deferred'),
            highFanElapsedMilliseconds,
            highFanSummary,
            representativeElapsedMilliseconds,
            representativeEdges,
            scopeEdges: yield* store.loadVisualizationScopeEdges(databasePath, snapshot.id),
            unscoped: yield* store.loadVisualizationSymbols(
              databasePath,
              snapshot.id,
              {type: 'documentation-facet'},
              20,
            ),
            unscopedCatalog: yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
              projectId: Option.some('facet:unscoped'),
              projectLimit: 1,
              snapshotId: Option.some(snapshot.id),
            }),
          };
        }).pipe(provideTestLayer(storeLayer));

        expect(result.catalog?.model).toBe('workspace');
        expect(result.aggregatesBuilt).toBe(true);
        expect(result.aggregatesReused).toBe(false);
        expect(result.catalog?.metrics).toBe('complete');
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(result.catalog), __catalog => {
              const __projects = __catalog.projects;
              return EffectArray.map(
                EffectArray.filter(
                  __projects,
                  (__project, __effectArrayIndex) => __effectArrayIndex in __projects && __project.label === 'core',
                ),
                __project => __project.id,
              );
            }),
          ),
        ).toEqual(['cgp_component_a', 'cgp_component_b']);
        expect(result.catalog?.projects).toContainEqual(
          expect.objectContaining({id: 'facet:unscoped-documentation', kind: 'documentation', model: 'facet'}),
        );
        expect(result.catalog?.projects).toContainEqual(
          expect.objectContaining({id: 'package:threadnote', label: 'threadnote', symbolCount: 1}),
        );
        expect(result.catalog?.projects).toContainEqual(
          expect.objectContaining({id: 'path:scripts', label: 'scripts', symbolCount: 1}),
        );
        expect(result.catalog?.accounting).toEqual({
          attributedSymbols: symbols.length,
          componentSymbols: 3,
          fallbackSymbols: 3,
          omittedSymbols: 0,
          totalSymbols: symbols.length,
        });
        expect(result.deferredCatalog).toMatchObject({
          accounting: {omittedSymbols: symbols.length, totalSymbols: symbols.length},
          metrics: 'deferred',
          model: 'workspace',
        });
        expect(result.deferredCatalog?.projects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({id: 'cgp_component_a', symbolCount: 0}),
            expect.objectContaining({id: 'cgp_component_b', symbolCount: 0}),
            expect.objectContaining({id: 'facet:unscoped', symbolCount: 0}),
          ]),
        );
        expect(EffectArray.map(result.unscoped, symbol => symbol.id)).toEqual(['symbol-doc']);
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(result.unscopedCatalog?.projects), __effectArrayReceiver =>
              EffectArray.map(__effectArrayReceiver, project => project.id),
            ),
          ),
        ).toEqual(['facet:unscoped']);
        expect(result.scopeEdges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceId: 'cgp_component_a',
              targetId: 'cgp_component_b',
              type: 'declared-build-dependency',
            }),
            expect.objectContaining({
              count: 1,
              sourceId: 'cgp_component_a',
              targetId: 'cgp_component_b',
              type: 'source-relationship',
            }),
            expect.objectContaining({
              sourceId: 'package:threadnote',
              targetId: 'cgp_component_a',
              type: 'source-relationship',
            }),
            expect.objectContaining({
              sourceId: 'path:scripts',
              targetId: 'package:threadnote',
              type: 'source-relationship',
            }),
          ]),
        );
        expect(result.boundedScopeEdges.edges).toEqual(
          expect.arrayContaining([expect.objectContaining({sourceId: 'cgp_component_a', targetId: 'cgp_component_b'})]),
        );
        expect(result.highFanSummary).toMatchObject({sampledEdges: 128, truncated: true});
        expect(result.highFanElapsedMilliseconds).toBeLessThan(1_000);
        expect(result.representativeEdges.truncated).toBe(true);
        const representativeEndpoints = new Set(
          EffectArrayPipe(result.representativeEdges.edges, __effectFlatMapValues =>
            EffectArray.flatMap(__effectFlatMapValues, (item, __effectFlatMapIndex) =>
              __effectFlatMapIndex in __effectFlatMapValues ? [item.sourceId, item.targetId] : [],
            ),
          ),
        );
        expect([...representativeEndpoints]).toEqual(expect.arrayContaining(['symbol-a-1', 'symbol-a-2', 'symbol-b']));
        expect(result.representativeElapsedMilliseconds).toBeLessThan(1_000);
        const queryPlanDatabase = new Database(databasePath, {readonly: true});
        const aggregateReceipt = requiredRow(
          queryPlanDatabase
            .query<{readonly edge_count: number; readonly row_count: number}, SQLQueryBindings[]>(
              `SELECT row_count, edge_count
         FROM snapshot_component_edge_aggregate_receipts
         WHERE snapshot_id = ?`,
            )
            .get(snapshot.id),
        );
        const persistedAggregateCount = requiredRow(
          queryPlanDatabase
            .query<{readonly count: number}, SQLQueryBindings[]>(
              'SELECT COUNT(*) AS count FROM snapshot_component_edge_aggregates WHERE snapshot_id = ?',
            )
            .get(snapshot.id),
        );
        expect(aggregateReceipt.row_count).toBe(persistedAggregateCount.count);
        expect(aggregateReceipt.edge_count).toBe(3);
        const componentStatement = codeGraphVisualizationSymbolsQueryStatement(
          snapshot.id,
          undefined,
          {type: 'component', value: 'cgp_component_a'},
          157,
        );
        const queryPlan = queryPlanDatabase
          .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${componentStatement.text}`)
          .all(...componentStatement.parameters);
        expect(
          EffectArray.some(queryPlan, row =>
            Effect2.pipe(row.detail, EffectString.includes('symbols_visualization_scope_v2')),
          ),
        ).toBe(true);
        const unscopedStatement = codeGraphVisualizationSymbolsQueryStatement(
          snapshot.id,
          undefined,
          {type: 'unscoped'},
          20,
        );
        const unscopedPlan = queryPlanDatabase
          .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${unscopedStatement.text}`)
          .all(...unscopedStatement.parameters);
        expect(
          EffectArray.some(unscopedPlan, row =>
            Effect2.pipe(row.detail, EffectString.includes('symbols_visualization_scope_v2')),
          ),
        ).toBe(true);
        const packageStatement = codeGraphVisualizationSymbolsQueryStatement(
          snapshot.id,
          undefined,
          {type: 'package', value: 'threadnote'},
          20,
        );
        const packagePlan = queryPlanDatabase
          .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${packageStatement.text}`)
          .all(...packageStatement.parameters);
        expect(
          EffectArray.some(packagePlan, row =>
            Effect2.pipe(row.detail, EffectString.includes('symbols_visualization_package_v2')),
          ),
        ).toBe(true);
        const pathStatement = codeGraphVisualizationSymbolsQueryStatement(
          snapshot.id,
          undefined,
          {type: 'path', value: 'scripts'},
          20,
        );
        const pathPlan = queryPlanDatabase
          .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${pathStatement.text}`)
          .all(...pathStatement.parameters);
        expect(
          EffectArray.some(pathPlan, row =>
            Effect2.pipe(row.detail, EffectString.includes('symbols_visualization_path_v2')),
          ),
        ).toBe(true);
        const repositoryStatement = codeGraphVisualizationSymbolsQueryStatement(
          snapshot.id,
          undefined,
          {type: 'all'},
          157,
        );
        const repositoryPlan = queryPlanDatabase
          .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${repositoryStatement.text}`)
          .all(...repositoryStatement.parameters);
        queryPlanDatabase.run(
          `CREATE TEMP TABLE ${COMPONENT_SCOPE_TEMP_TABLE} (
        id TEXT PRIMARY KEY NOT NULL,
        scope_id TEXT
      ) WITHOUT ROWID`,
        );
        const aggregateStatement = componentEdgeAggregateMaterializationStatement(snapshot.id, undefined);
        const aggregatePlan = queryPlanDatabase
          .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${aggregateStatement.text}`)
          .all(...aggregateStatement.parameters);
        expect(
          EffectArray.some(aggregatePlan, row =>
            Effect2.pipe(row.detail, EffectString.includes(`SCAN ${COMPONENT_SCOPE_TEMP_TABLE}`)),
          ),
        ).toBe(false);
        expect(
          EffectArray.filter(
            aggregatePlan,
            (row, index) =>
              index in aggregatePlan && /^SEARCH (?:source|target) USING PRIMARY KEY \(id=\?\)$/u.test(row.detail),
          ),
        ).toHaveLength(2);
        queryPlanDatabase.close();
        expect(
          EffectArray.some(repositoryPlan, row =>
            Effect2.pipe(row.detail, EffectString.includes('symbols_export_order (snapshot_id=?)')),
          ),
        ).toBe(true);

        const previousBetaDatabase = new Database(databasePath);
        previousBetaDatabase.run('DROP INDEX symbols_visualization_scope_v2');
        previousBetaDatabase.run('DROP INDEX symbols_visualization_package_v2');
        previousBetaDatabase.run('DROP INDEX symbols_visualization_path_v2');
        previousBetaDatabase.close();
        const previousBetaReads = yield* Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          return yield* Effect.all({
            component: store.loadVisualizationSymbols(
              databasePath,
              snapshot.id,
              {type: 'component', value: 'cgp_component_a'},
              20,
            ),
            package: store.loadVisualizationSymbols(
              databasePath,
              snapshot.id,
              {type: 'package', value: 'threadnote'},
              20,
            ),
            path: store.loadVisualizationSymbols(databasePath, snapshot.id, {type: 'path', value: 'scripts'}, 20),
            unscoped: store.loadVisualizationSymbols(databasePath, snapshot.id, {type: 'unscoped'}, 20),
          });
        }).pipe(provideTestLayer(storeLayer));
        expect(EffectArray.map(previousBetaReads.component, item => item.id)).toEqual(['symbol-a-1', 'symbol-a-2']);
        expect(EffectArray.map(previousBetaReads.package, item => item.id)).toEqual(['symbol-root-ts']);
        expect(EffectArray.map(previousBetaReads.path, item => item.id)).toEqual(['symbol-script']);
        expect(EffectArray.map(previousBetaReads.unscoped, item => item.id)).toEqual(
          expect.arrayContaining(['symbol-doc', 'symbol-root-ts', 'symbol-script']),
        );
      }),
  );

  it('groups checkouts only by logical repository identity and defaults to the newest activation', () => {
    const older = catalogFixture(
      'logical-a',
      'Same display',
      '2026-07-30T10:00:00.000Z',
      90_000,
      Effect2.pipe('1', EffectString.repeat(64)),
    );
    const newer = catalogFixture(
      'logical-a',
      'Same display',
      '2026-07-31T10:00:00.000Z',
      10,
      Effect2.pipe('2', EffectString.repeat(64)),
    );
    const collision = catalogFixture(
      'logical-b',
      'Same display',
      '2026-07-29T10:00:00.000Z',
      100_000,
      Effect2.pipe('3', EffectString.repeat(64)),
    );
    const groups = groupManagerGraphRepositories([
      {catalog: older, checkoutId: Effect2.pipe('a', EffectString.repeat(64))},
      {
        catalog: newer,
        checkoutId: Effect2.pipe('b', EffectString.repeat(64)),
        localAssociation: {
          available: true,
          displayPath: '~/src/current',
          path: '/home/tester/src/current',
          state: 'verified',
        },
      },
      {catalog: collision, checkoutId: Effect2.pipe('c', EffectString.repeat(64))},
    ]);

    expect(groups).toHaveLength(2);
    expect(EffectArray.map(groups, group => group.repositoryId)).toEqual(['logical-a', 'logical-b']);
    expect(groups[0]).toMatchObject({
      defaultViewId: `${Effect2.pipe('b', EffectString.repeat(64))}.${Effect2.pipe('2', EffectString.repeat(64))}`,
      displayName: 'Same display',
    });
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(groups[0]?.views), __effectOptionalArrayReceiver =>
          EffectArray.map(__effectOptionalArrayReceiver, view => view.id),
        ),
      ),
    ).toEqual([
      `${Effect2.pipe('b', EffectString.repeat(64))}.${Effect2.pipe('2', EffectString.repeat(64))}`,
      `${Effect2.pipe('a', EffectString.repeat(64))}.${Effect2.pipe('1', EffectString.repeat(64))}`,
    ]);
    expect(groups[0]?.views[0]?.label).toBe('abcdef01 · clean · indexed 2026-07-31 10:00Z');
    expect(groups[0]?.views[0]?.localAssociation).toMatchObject({
      displayPath: '~/src/current',
      path: '/home/tester/src/current',
      state: 'verified',
    });
  });

  effectIt.effect('bounds a production-shaped Bazel catalog without loading dependency evidence', () =>
    Effect.gen(function* () {
      const root = temporaryRoot('threadnote-bazel-catalog-');
      const databasePath = join(root, 'graph-v3.sqlite');
      const identity = repositoryIdentity(root, Effect2.pipe('9', EffectString.repeat(64)));
      const snapshot = readySnapshot(identity, 5_000, 5_000, 4_999, '2026-08-01T12:00:00.000Z');
      yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(
          databasePath,
          identity,
          {...snapshot, edgeCount: 0, fileCount: 0, symbolCount: 0},
          [],
          [],
          [],
        );
        yield* store.promote(databasePath, identity, snapshot.id);
      }).pipe(provideTestLayer(storeLayer));
      const database = new Database(databasePath);
      database.run(
        `INSERT INTO workspace_scopes
       (snapshot_id, id, build_system, name, root, provenance, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [snapshot.id, 'cgw_bazel', 'bazel', 'public-monorepo', '.', 'declared', '[]'],
      );
      const insertComponent = database.prepare(
        `INSERT INTO workspace_components
       (snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
        languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertWorkspace = database.prepare(
        `INSERT INTO workspace_scopes
       (snapshot_id, id, build_system, name, root, provenance, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertDependency = database.prepare(
        `INSERT INTO workspace_component_dependencies
       (snapshot_id, source_component_id, target_component_id, provenance, evidence)
       VALUES (?, ?, ?, ?, ?)`,
      );
      const insertSymbol = database.prepare(
        `INSERT INTO symbols
       (snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertEdge = database.prepare(
        `INSERT INTO edges
       (snapshot_id, id, source_id, source_name, relation, target_id, target_name, provenance,
        confidence, evidence_path, evidence_span_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      database.transaction(() => {
        for (let index = 1; index < 130; index += 1) {
          const suffix = Effect2.pipe(index.toString(), EffectString.padStart(3, '0'));
          insertWorkspace.run(
            snapshot.id,
            `cgw_bazel_${suffix}`,
            'bazel',
            `nested-workspace-${suffix}`,
            `apps/nested-${suffix}`,
            'declared',
            '[]',
          );
        }
        for (let index = 0; index < 5_000; index += 1) {
          const suffix = Effect2.pipe(index.toString(), EffectString.padStart(5, '0'));
          insertComponent.run(
            snapshot.id,
            `cgp_bazel_${suffix}`,
            index === 129 ? 'cgw_bazel_129' : 'cgw_bazel',
            'bazel',
            'target',
            `//apps/service-${suffix}:library`,
            `apps/service-${suffix}`,
            'jvm',
            '["java","kotlin"]',
            `["apps/service-${suffix}/src"]`,
            '["."]',
            'declared',
            '[]',
          );
          // The catalog endpoint intentionally never reads this potentially large evidence payload.
          if (index > 0) {
            insertDependency.run(
              snapshot.id,
              `cgp_bazel_${suffix}`,
              `cgp_bazel_${Effect2.pipe((index - 1).toString(), EffectString.padStart(5, '0'))}`,
              'declared',
              `discarded-evidence-${Effect2.pipe('x', EffectString.repeat(2_048))}`,
            );
          }
          if (index < 500) {
            const symbolId = `symbol-bazel-${suffix}`;
            insertSymbol.run(
              snapshot.id,
              symbolId,
              `hash-${suffix}`,
              'class',
              `Service${suffix}`,
              `Service${suffix}`,
              `apps/service-${suffix}/src/Service.kt`,
              'kotlin',
              null,
              '[]',
              'jvm',
              `cgp_bazel_${suffix}`,
              null,
              1,
              null,
              null,
              '{"column":1,"endColumn":2,"endLine":1,"line":1}',
            );
            if (index > 0) {
              const previousSuffix = Effect2.pipe((index - 1).toString(), EffectString.padStart(5, '0'));
              insertEdge.run(
                snapshot.id,
                `edge-bazel-${suffix}`,
                symbolId,
                `Service${suffix}`,
                'calls',
                `symbol-bazel-${previousSuffix}`,
                `Service${previousSuffix}`,
                'resolved',
                1,
                `apps/service-${suffix}/src/Service.kt`,
                '{"column":1,"endColumn":2,"endLine":1,"line":1}',
              );
            }
          }
        }
      })();
      database.close();

      const startedAt = performance.now();
      const catalog = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          includeDependencies: false,
          projectLimit: 160,
          workspaceLimit: 64,
        });
      }).pipe(provideTestLayer(storeLayer));
      const elapsedMilliseconds = performance.now() - startedAt;
      const payload = JSON.stringify(catalog);
      const catalogContinuation = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          projectLimit: 160,
          projectOffset: 159,
          snapshotId: Option.some(snapshot.id),
          workspaceLimit: 64,
          workspaceOffset: 64,
        });
      }).pipe(provideTestLayer(storeLayer));
      const catalogSearchStartedAt = performance.now();
      const catalogSearch = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          projectLimit: 160,
          projectQuery: Option.some('service-04999'),
          snapshotId: Option.some(snapshot.id),
          workspaceLimit: 64,
          workspaceQuery: Option.some('nested-workspace-129'),
        });
      }).pipe(provideTestLayer(storeLayer));
      const catalogSearchElapsedMilliseconds = performance.now() - catalogSearchStartedAt;
      const catalogWorkspaceSearchStartedAt = performance.now();
      const catalogWorkspaceSearch = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          projectLimit: 160,
          projectQuery: Option.some('nested-workspace-129'),
          snapshotId: Option.some(snapshot.id),
          workspaceLimit: 64,
          workspaceQuery: Option.some('nested-workspace-129'),
        });
      }).pipe(provideTestLayer(storeLayer));
      const catalogWorkspaceSearchElapsedMilliseconds = performance.now() - catalogWorkspaceSearchStartedAt;
      const detailStartedAt = performance.now();
      const detailCatalog = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          includeDependencies: false,
          projectId: Option.some('cgp_bazel_04999'),
          projectLimit: 1,
          snapshotId: Option.some(snapshot.id),
          workspaceLimit: 64,
        });
      }).pipe(provideTestLayer(storeLayer));
      const detailElapsedMilliseconds = performance.now() - detailStartedAt;
      const sourceSummaryStartedAt = performance.now();
      const sourceSummary = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationScopeEdgeSummary(
          databasePath,
          snapshot.id,
          Array.from(
            {length: 5_000},
            (_, index) => `cgp_bazel_${Effect2.pipe(index.toString(), EffectString.padStart(5, '0'))}`,
          ),
          1_500,
        );
      }).pipe(provideTestLayer(storeLayer));
      const sourceSummaryElapsedMilliseconds = performance.now() - sourceSummaryStartedAt;
      expect(catalog).toMatchObject({projectCount: 5_001, projectsTruncated: true, workspaceCount: 130});
      expect(catalog?.projects).toHaveLength(160);
      expect(catalog?.workspaces).toHaveLength(64);
      expect(catalog?.workspacesTruncated).toBe(true);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(catalog?.projects), __effectArrayReceiver =>
            EffectArray.every(__effectArrayReceiver, project => project.dependencies.length === 0),
          ),
        ),
      ).toBe(true);
      expect(payload).not.toContain('discarded-evidence');
      expect(new TextEncoder().encode(payload).byteLength).toBeLessThan(100_000);
      expect(elapsedMilliseconds).toBeLessThan(1_500);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(detailCatalog?.projects), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, project => project.id),
          ),
        ),
      ).toEqual(['cgp_bazel_04999']);
      expect(detailElapsedMilliseconds).toBeLessThan(500);
      expect(catalogContinuation?.projects).toHaveLength(160);
      expect(catalogContinuation?.projects[0]?.id).not.toBe(catalog?.projects[0]?.id);
      expect(catalogContinuation?.workspaces).toHaveLength(64);
      expect(catalogContinuation?.workspaces[0]?.id).toBe('cgw_bazel_064');
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(catalogSearch?.projects), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, project => project.id),
          ),
        ),
      ).toEqual(['cgp_bazel_04999']);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(catalogSearch?.workspaces), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, workspace => workspace.id),
          ),
        ),
      ).toEqual(['cgw_bazel_129']);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(catalogWorkspaceSearch?.projects), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, project => project.id),
          ),
        ),
      ).toEqual(['cgp_bazel_00129']);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(catalogWorkspaceSearch?.workspaces), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, workspace => workspace.id),
          ),
        ),
      ).toEqual(['cgw_bazel_129']);
      expect(sourceSummary).toMatchObject({sampledScopes: 500, truncated: true});
      expect(sourceSummary.edges.length).toBeGreaterThan(0);
      expect(sourceSummaryElapsedMilliseconds).toBeLessThan(1_500);

      const sampledScopeIds = Array.from(
        {length: 500},
        (_, index) => `cgp_bazel_${Effect2.pipe(index.toString(), EffectString.padStart(5, '0'))}`,
      );
      const symbolStatements = codeGraphVisualizationScopeSymbolSampleStatements(
        snapshot.id,
        undefined,
        sampledScopeIds,
        7,
      );
      const edgeStatements = codeGraphVisualizationScopeEdgeSampleStatements(
        snapshot.id,
        undefined,
        EffectArray.map(sampledScopeIds, (scopeId, index) => ({
          scopeId,
          symbolIds: [`symbol-bazel-${Effect2.pipe(index.toString(), EffectString.padStart(5, '0'))}`],
        })),
        8,
        ['resolved'],
      );
      const endpointStatement = codeGraphVisualizationScopeEndpointStatement(snapshot.id, undefined, [
        'symbol-bazel-00000',
        'symbol-bazel-00499',
      ]);
      const catalogComponentStatement = codeGraphVisualizationCatalogComponentStatement(
        snapshot.id,
        'service-04999',
        160,
        0,
      );
      expect(codeGraphVisualizationScopeSummaryStatementCount(500)).toBe(17);
      expect(symbolStatements).toHaveLength(8);
      expect(edgeStatements).toHaveLength(8);
      const planDatabase = new Database(databasePath, {readonly: true});
      const symbolPlan = planDatabase
        .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${symbolStatements[0].text}`)
        .all(...symbolStatements[0].parameters);
      const edgePlan = planDatabase
        .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${edgeStatements[0].text}`)
        .all(...edgeStatements[0].parameters);
      const endpointPlan = planDatabase
        .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${endpointStatement.text}`)
        .all(...endpointStatement.parameters);
      const catalogComponentPlan = planDatabase
        .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${catalogComponentStatement.text}`)
        .all(...catalogComponentStatement.parameters);
      planDatabase.close();
      expect(
        EffectArray.some(symbolPlan, row =>
          Effect2.pipe(row.detail, EffectString.includes('symbols_visualization_scope_v2')),
        ),
      ).toBe(true);
      expect(EffectArray.some(edgePlan, row => Effect2.pipe(row.detail, EffectString.includes('edges_source')))).toBe(
        true,
      );
      expect(
        EffectArray.some(edgePlan, row => Effect2.pipe(row.detail, EffectString.includes('edges_target_resolved'))),
      ).toBe(true);
      expect(
        EffectArray.some(
          endpointPlan,
          row =>
            Effect2.pipe(row.detail, EffectString.includes('SEARCH current_symbols USING PRIMARY KEY')) &&
            Effect2.pipe(row.detail, EffectString.includes('snapshot_id=? AND id=?')),
        ),
      ).toBe(true);
      expect(catalogComponentStatement.text).toContain('candidate_components AS MATERIALIZED');
      expect(catalogComponentStatement.text).toContain('FROM candidate_components AS candidate');
      expect(catalogComponentStatement.text).toContain(
        'JOIN candidate_components AS candidate ON candidate.id = incoming.target_component_id',
      );
      expect(
        EffectArray.some(catalogComponentPlan, row =>
          Effect2.pipe(row.detail, EffectString.includes('MATERIALIZE candidate_components')),
        ),
      ).toBe(true);
      expect(EffectArray.map(catalogComponentPlan, row => row.detail)).toEqual(
        expect.arrayContaining([expect.stringContaining('outgoing USING PRIMARY KEY')]),
      );
      expect(
        EffectArray.some(catalogComponentPlan, row =>
          Effect2.pipe(row.detail, EffectString.includes('candidate_dependency_endpoints')),
        ),
      ).toBe(true);
      expect(catalogSearchElapsedMilliseconds).toBeLessThan(500);
      expect(catalogWorkspaceSearchElapsedMilliseconds).toBeLessThan(500);

      const viewDatabase = new Database(databasePath);
      const insertSnapshot = viewDatabase.prepare(
        `INSERT INTO snapshots
       (id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set, dirty,
        overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at, failure_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      viewDatabase.transaction(() => {
        for (let index = 0; index < 40; index += 1) {
          const suffix = Effect2.pipe(index.toString(16), EffectString.padStart(64, '0'));
          insertSnapshot.run(
            `cgsn_view_${index}`,
            identity.repositoryId,
            suffix,
            Effect2.pipe(suffix, EffectString.slice(0, 40)),
            null,
            'workspace-test',
            0,
            null,
            'ready',
            0,
            0,
            0,
            '2026-08-01T13:00:00.000Z',
            index === 39 ? '2026-08-02T13:00:01.000Z' : '2026-08-01T13:00:01.000Z',
            null,
          );
        }
        insertSnapshot.run(
          'cgsn_historical_view',
          identity.repositoryId,
          Effect2.pipe('0', EffectString.repeat(62)) + '26',
          Effect2.pipe('deadbeef', EffectString.repeat(5)),
          null,
          'workspace-test',
          0,
          null,
          'ready',
          0,
          0,
          0,
          '2020-08-01T13:00:00.000Z',
          '2020-08-01T13:00:01.000Z',
          null,
        );
        viewDatabase
          .query(
            "INSERT INTO snapshot_extractor_generations (snapshot_id, generation) SELECT ?, CAST(value AS INTEGER) FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
          )
          .run('cgsn_view_39');
        viewDatabase
          .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
          .run(Effect2.pipe('0', EffectString.repeat(62)) + '27', 'cgsn_view_39', '2099-08-02T13:00:02.000Z');
      })();
      viewDatabase.close();
      const [firstViews, continuedViews, searchedViews, historicalViews] = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* Effect.all(
          [
            store.loadVisualizationCatalogs(databasePath, 'deferred', {viewLimit: 33}),
            store.loadVisualizationCatalogs(databasePath, 'deferred', {viewLimit: 33, viewOffset: 33}),
            store.loadVisualizationCatalogs(databasePath, 'deferred', {
              viewLimit: 33,
              viewQuery: Option.some('0000000000000000000000000000000000000027'),
            }),
            store.loadVisualizationCatalogs(databasePath, 'deferred', {
              viewLimit: 33,
              viewQuery: Option.some('deadbeef'),
            }),
          ],
          {concurrency: 1},
        );
      }).pipe(provideTestLayer(storeLayer));
      // Ready snapshot rows are reusable caches, not views. Only the explicit
      // active pointer participates in view pagination or search.
      expect(firstViews).toHaveLength(2);
      expect(firstViews[0]?.viewWorktreeId).toBe(Effect2.pipe('0', EffectString.repeat(62)) + '27');
      expect(continuedViews).toEqual([]);
      expect(new Set(EffectArray.map([...firstViews, ...continuedViews], view => view.viewWorktreeId))).toEqual(
        new Set([Effect2.pipe('0', EffectString.repeat(62)) + '27', identity.worktreeId]),
      );
      expect(EffectArray.map(searchedViews, view => view.viewWorktreeId)).toEqual([
        Effect2.pipe('0', EffectString.repeat(62)) + '27',
      ]);
      expect(historicalViews).toEqual([]);
    }),
  );

  effectIt.effect('surfaces an unreadable database without exposing its local path', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-unreadable-');
      const checkoutId = Effect2.pipe('d', EffectString.repeat(64));
      const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      mkdirSync(repositoryRoot, {recursive: true});
      writeFileSync(join(repositoryRoot, 'graph-v3.sqlite'), 'not a sqlite database');

      const catalog = yield* managerGraphCatalog(home).pipe(provideTestLayer(storeLayer));

      expect(catalog.repositories).toEqual([]);
      expect(catalog.diagnostics).toEqual([expect.objectContaining({checkoutId, code: 'unreadable-database'})]);
      expect(catalog.diagnostics[0]?.message).not.toContain(home);
    }),
  );

  effectIt.effect('retains and identifies a scoped Manager view independently from the full-repository view', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-scoped-view-');
      const identity = repositoryIdentity(home, Effect2.pipe('9', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const full = readySnapshot(identity, 0, 0, 0, '2026-09-21T08:00:00.000Z');
      const scopeId = `code-graph-scope:${Effect2.pipe('a', EffectString.repeat(64))}`;
      const otherScopeId = `code-graph-scope:${Effect2.pipe('b', EffectString.repeat(64))}`;
      const scoped = {
        ...readySnapshot(identity, 0, 0, 0, '2026-09-21T08:01:00.000Z'),
        scopeId,
      };
      const otherScoped = {
        ...readySnapshot(identity, 0, 0, 0, '2026-09-21T08:02:00.000Z'),
        scopeId: otherScopeId,
      };

      const catalog = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, full, [], [], []);
        yield* store.promote(databasePath, identity, full.id);
        yield* store.activate(databasePath, identity, scoped, [], [], []);
        yield* store.promote(databasePath, identity, scoped.id);
        yield* store.activate(databasePath, identity, otherScoped, [], [], []);
        yield* store.promote(databasePath, identity, otherScoped.id);
        return yield* managerGraphCatalog(home);
      }).pipe(provideTestLayer(storeLayer));

      expect(catalog.diagnostics).toEqual([]);
      expect(catalog.repositories).toHaveLength(1);
      expect(catalog.repositories[0]?.views).toHaveLength(3);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(catalog.repositories[0]?.views), __effectOptionalArrayReceiver =>
            EffectArray.map(__effectOptionalArrayReceiver, view => view.scopeId ?? 'full-repository').sort(),
          ),
        ),
      ).toEqual([scopeId, otherScopeId, 'full-repository']);
      expect(
        new Set(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(catalog.repositories[0]?.views), __effectOptionalArrayReceiver =>
              EffectArray.map(__effectOptionalArrayReceiver, view => view.id),
            ),
          ),
        ).size,
      ).toBe(3);
      expect(
        Option.getOrUndefined(
          Option.flatMap(Option.fromNullishOr(catalog.repositories[0]?.views), __effectOptionalArrayReceiver =>
            EffectArray.findFirst(__effectOptionalArrayReceiver, view => view.scopeId === scopeId),
          ),
        )?.id,
      ).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}\.[0-9a-f]{64}$/u);
      const scopedView = Option.getOrUndefined(
        Option.flatMap(Option.fromNullishOr(catalog.repositories[0]?.views), __effectOptionalArrayReceiver =>
          EffectArray.findFirst(__effectOptionalArrayReceiver, view => view.scopeId === scopeId),
        ),
      );
      expect(scopedView).toBeDefined();
      const analysis = yield* managerGraphAnalysis(home, scopedView!.id, Option.some(scoped.id)).pipe(
        provideTestLayer(storeLayer),
      );
      expect(analysis.snapshot.id).toBe(scoped.id);
      const searched = yield* managerGraphViewsPage(home, scopedView!.id, {
        query: 'project-only-mobile',
        scopeIds: [scopeId],
      }).pipe(provideTestLayer(storeLayer));
      expect(searched.query).toBe('project-only-mobile');
      expect(
        EffectArray.map(
          EffectArrayPipe(searched.repositories, __effectArrayValues =>
            EffectArray.flatMap(__effectArrayValues, (repository, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues ? repository.views : [],
            ),
          ),
          view => view.scopeId,
        ),
      ).toEqual([scopeId]);
      const textSearched = yield* managerGraphViewsPage(home, scopedView!.id, {
        query: 'acme/mobile',
        scopeIds: [`code-graph-scope:${Effect2.pipe('c', EffectString.repeat(64))}`],
      }).pipe(provideTestLayer(storeLayer));
      expect(
        EffectArrayPipe(textSearched.repositories, __effectArrayValues =>
          EffectArray.flatMap(__effectArrayValues, (repository, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues ? repository.views : [],
          ),
        ),
      ).toHaveLength(3);
      const invalidScope = yield* managerGraphViewsPage(home, scopedView!.id, {
        scopeIds: ['not-a-scope'],
      }).pipe(provideTestLayer(storeLayer), Effect.flip);
      expect(invalidScope.message).toBe('Graph scope selection is invalid.');
      yield* releaseManagerGraphSnapshotLeases().pipe(provideTestLayer(storeLayer));
    }),
  );

  effectIt.effect('migrates a readable legacy lease table while retaining the Manager catalog', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-legacy-lease-');
      const identity = repositoryIdentity(home, Effect2.pipe('8', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');
      const store = yield* CodeGraphStore;
      yield* store.activate(databasePath, identity, snapshot, [], [], []);
      yield* store.promote(databasePath, identity, snapshot.id);
      yield* Effect.sync(() => {
        const legacy = new Database(databasePath);
        try {
          legacy.run('PRAGMA foreign_keys = OFF');
          legacy.transaction(() => {
            legacy.run('DROP TRIGGER removed_views_cleanup_revoke_delete');
            legacy.run('DROP TRIGGER removed_views_cleanup_revoke_insert');
            legacy.run('DROP TRIGGER removed_views_cleanup_revoke_update');
            legacy.run('DROP TABLE removed_view_cleanup');
            legacy.run('DROP TABLE snapshot_build_owner_instances');
            legacy.run('DROP TABLE snapshot_component_edge_aggregate_receipts');
            legacy.run('DROP TABLE snapshot_component_edge_aggregates');
            legacy.run('DROP TABLE scope_applicability');
            legacy.run('DROP TABLE snapshot_scope_receipts');
            legacy.run('DROP INDEX snapshots_scope_recent_ready');
            legacy.run('DROP INDEX snapshots_scope_commit_ready');
            legacy.run('DROP INDEX snapshots_scope_reusable');
            legacy.run('DROP INDEX snapshots_scope_reusable_content');
            legacy.run('DROP INDEX snapshots_scope_reusable_commit');
            legacy.run(
              `CREATE TEMP TABLE legacy_active_snapshots AS
               SELECT worktree_id, snapshot_id, activated_at FROM active_snapshots
               WHERE scope_id = 'full-repository'`,
            );
            legacy.run('DROP TABLE active_snapshots');
            legacy.run(`CREATE TABLE active_snapshots (
              worktree_id TEXT PRIMARY KEY NOT NULL,
              snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
              activated_at TEXT NOT NULL
            )`);
            legacy.run(
              `INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
               SELECT worktree_id, snapshot_id, activated_at FROM legacy_active_snapshots`,
            );
            legacy.run('DROP TABLE legacy_active_snapshots');
            legacy.run('DROP TABLE removed_views');
            legacy.run('ALTER TABLE snapshots DROP COLUMN scope_id');
            legacy.run(
              'CREATE INDEX IF NOT EXISTS active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id)',
            );
            legacy.run('CREATE INDEX IF NOT EXISTS snapshots_base_state_id ON snapshots(base_snapshot_id, state, id)');
            legacy.run(
              'CREATE INDEX IF NOT EXISTS snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)',
            );
            legacy.run('CREATE INDEX IF NOT EXISTS snapshot_leases_expiry ON snapshot_leases(expires_at)');
            legacy.run('DROP INDEX snapshot_files_raw_content_hash');
            legacy.run('ALTER TABLE snapshot_files DROP COLUMN raw_content_hash');
            legacy.run(
              `DELETE FROM schema_metadata
               WHERE key IN ('removed_view_cleanup_epoch_sequence', 'removed_view_cleanup_admission_cursor')`,
            );
            legacy.run("UPDATE schema_metadata SET value = '6' WHERE key = 'persistent_extension_schema_revision'");
            legacy.run('ALTER TABLE snapshot_leases DROP COLUMN retire_when_inactive');
          })();
        } finally {
          legacy.run('PRAGMA foreign_keys = ON');
          legacy.close();
        }
      });

      const catalog = yield* managerGraphCatalog(home);

      expect(catalog.repositories).toHaveLength(1);
      expect(catalog.diagnostics).toEqual([]);
      yield* Effect.sync(() => {
        const migrated = new Database(databasePath, {readonly: true});
        try {
          expect(
            migrated
              .query("SELECT name FROM pragma_table_info('snapshot_leases') WHERE name = 'retire_when_inactive'")
              .get(),
          ).toEqual({name: 'retire_when_inactive'});
          expect(migrated.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 1});
        } finally {
          migrated.close();
        }
      });
      yield* releaseManagerGraphSnapshotLeases();
    }).pipe(provideTestLayer(storeLayer)),
  );

  effectIt.effect('returns readable catalogs promptly with a lease-deferred diagnostic while a writer is active', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-writer-busy-');
      const identity = repositoryIdentity(home, Effect2.pipe('7', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const writerLockPath = join(
        home,
        'locks',
        'indexes',
        'code-graph',
        'database-writes',
        `${identity.checkoutId}.lock`,
      );
      const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');

      const {catalog, elapsed} = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            onWriterAcquired: () =>
              Deferred.succeed(writerAcquired, undefined).pipe(Effect.andThen(Deferred.await(releaseWriter))),
            writerLockPath,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerAcquired);
        const startedAt = yield* Clock.currentTimeMillis;
        const catalog = yield* managerGraphCatalog(home).pipe(
          Effect.ensuring(Deferred.succeed(releaseWriter, undefined).pipe(Effect.asVoid)),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Fiber.join(writer);
        return {catalog, elapsed};
      }).pipe(provideTestLayer(storeLayer));

      expect(elapsed).toBeLessThan(1_000);
      expect(catalog.repositories).toHaveLength(1);
      expect(catalog.diagnostics).toEqual([
        expect.objectContaining({checkoutId: identity.checkoutId, code: 'lease-deferred'}),
      ]);
      expect(catalog.diagnostics[0]?.message).not.toContain(home);
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('single-flights concurrent catalog retention without leaking snapshot leases', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-catalog-single-flight-');
      const identity = repositoryIdentity(home, Effect2.pipe('3', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');

      const catalogs = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        return yield* Effect.all([managerGraphCatalog(home), managerGraphCatalog(home)], {concurrency: 2});
      }).pipe(provideTestLayer(storeLayer));

      expect(EffectArray.map(catalogs, catalog => catalog.diagnostics)).toEqual([[], []]);
      const database = new Database(databasePath, {readonly: true});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 1});
      database.close();
      yield* releaseManagerGraphSnapshotLeases().pipe(provideTestLayer(storeLayer));
    }),
  );

  effectIt.effect('keeps a readable catalog visible and classifies a non-busy retention failure accurately', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-catalog-lease-failure-');
      const identity = repositoryIdentity(home, Effect2.pipe('2', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');

      const catalog = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        const failingStore = CodeGraphStore.of({
          ...store,
          retainViewSnapshotLease: () => Effect.fail(CodeGraphStoreError.of(`synthetic failure at ${home}`)),
        });
        return yield* managerGraphCatalog(home).pipe(Effect.provideService(CodeGraphStore, failingStore));
      }).pipe(provideTestLayer(storeLayer));

      expect(catalog.repositories).toHaveLength(1);
      expect(catalog.diagnostics).toEqual([
        expect.objectContaining({checkoutId: identity.checkoutId, code: 'lease-failed'}),
      ]);
      expect(catalog.diagnostics[0]?.message).not.toContain(home);
      expect(catalog.diagnostics[0]?.message).toContain('background maintenance will retry');
      expect(catalog.diagnostics[0]?.message).not.toContain('threadnote doctor');
    }),
  );

  effectIt.effect('returns a prompt privacy-safe busy error when a query cannot retain its selected snapshot', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-query-writer-busy-');
      const identity = repositoryIdentity(home, Effect2.pipe('6', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const writerLockPath = join(
        home,
        'locks',
        'indexes',
        'code-graph',
        'database-writes',
        `${identity.checkoutId}.lock`,
      );
      const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');

      const {elapsed, failure} = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            onWriterAcquired: () =>
              Deferred.succeed(writerAcquired, undefined).pipe(Effect.andThen(Deferred.await(releaseWriter))),
            writerLockPath,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerAcquired);
        const startedAt = yield* Clock.currentTimeMillis;
        const failure = yield* managerGraphQuery(
          home,
          `${identity.checkoutId}.${identity.worktreeId}`,
          'missing-symbol',
          {},
          Option.some(snapshot.id),
        ).pipe(Effect.flip, Effect.ensuring(Deferred.succeed(releaseWriter, undefined).pipe(Effect.asVoid)));
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Fiber.join(writer);
        return {elapsed, failure};
      }).pipe(provideTestLayer(managerGraphLayer));

      expect(elapsed).toBeLessThan(1_000);
      expect(failure).toBeInstanceOf(ManagerGraphBusyError);
      expect(String(failure)).toContain('temporarily busy');
      expect(String(failure)).not.toContain(home);
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('reuses a live catalog lease for a query while a new writer is active', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-query-reuse-');
      const identity = repositoryIdentity(home, Effect2.pipe('5', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const writerLockPath = join(
        home,
        'locks',
        'indexes',
        'code-graph',
        'database-writes',
        `${identity.checkoutId}.lock`,
      );
      const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');

      const {elapsed, result} = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        const catalog = yield* managerGraphCatalog(home);
        if (catalog.repositories.length !== 1)
          return yield* Effect.die(TestError.make({message: 'catalog lease fixture failed'}));
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            onWriterAcquired: () =>
              Deferred.succeed(writerAcquired, undefined).pipe(Effect.andThen(Deferred.await(releaseWriter))),
            writerLockPath,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerAcquired);
        const startedAt = yield* Clock.currentTimeMillis;
        const result = yield* managerGraphQuery(
          home,
          `${identity.checkoutId}.${identity.worktreeId}`,
          'missing-symbol',
          {},
          Option.some(snapshot.id),
        ).pipe(Effect.ensuring(Deferred.succeed(releaseWriter, undefined).pipe(Effect.asVoid)));
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Fiber.join(writer);
        yield* releaseManagerGraphSnapshotLeases();
        return {elapsed, result};
      }).pipe(provideTestLayer(managerGraphLayer));

      expect(elapsed).toBeLessThan(1_000);
      expect(result.query).toMatchObject({state: 'ready', text: 'missing-symbol'});
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('reuses a live catalog lease for analysis while a new writer is active', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-analysis-reuse-');
      const identity = repositoryIdentity(home, Effect2.pipe('1', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const writerLockPath = join(
        home,
        'locks',
        'indexes',
        'code-graph',
        'database-writes',
        `${identity.checkoutId}.lock`,
      );
      const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');

      const {elapsed, result} = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        yield* managerGraphCatalog(home);
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            onWriterAcquired: () =>
              Deferred.succeed(writerAcquired, undefined).pipe(Effect.andThen(Deferred.await(releaseWriter))),
            writerLockPath,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerAcquired);
        const startedAt = yield* Clock.currentTimeMillis;
        const result = yield* managerGraphAnalysis(
          home,
          `${identity.checkoutId}.${identity.worktreeId}`,
          Option.some(snapshot.id),
        ).pipe(Effect.ensuring(Deferred.succeed(releaseWriter, undefined).pipe(Effect.asVoid)));
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Fiber.join(writer);
        yield* releaseManagerGraphSnapshotLeases();
        return {elapsed, result};
      }).pipe(provideTestLayer(storeLayer));

      expect(elapsed).toBeLessThan(1_000);
      expect(result.snapshot.id).toBe(snapshot.id);
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('does not block Manager shutdown while a graph writer owns lease cleanup', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-release-writer-busy-');
      const identity = repositoryIdentity(home, Effect2.pipe('4', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const writerLockPath = join(
        home,
        'locks',
        'indexes',
        'code-graph',
        'database-writes',
        `${identity.checkoutId}.lock`,
      );
      const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');

      const elapsed = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        yield* managerGraphCatalog(home);
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            onWriterAcquired: () =>
              Deferred.succeed(writerAcquired, undefined).pipe(Effect.andThen(Deferred.await(releaseWriter))),
            writerLockPath,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerAcquired);
        const startedAt = yield* Clock.currentTimeMillis;
        yield* releaseManagerGraphSnapshotLeases();
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Deferred.succeed(releaseWriter, undefined);
        yield* Fiber.join(writer);
        return elapsed;
      }).pipe(provideTestLayer(managerGraphLayer));

      expect(elapsed).toBeLessThan(1_000);
    }).pipe(TestClock.withLive),
  );

  effectIt.effect('releases catalog snapshot leases when the Manager lifecycle ends', () =>
    Effect.gen(function* () {
      const home = temporaryRoot('threadnote-manager-lease-lifecycle-');
      const identity = repositoryIdentity(home, Effect2.pipe('9', EffectString.repeat(64)));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');

      yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* store.promote(databasePath, identity, snapshot.id);
        yield* managerGraphCatalog(home);
      }).pipe(provideTestLayer(storeLayer));
      const leased = new Database(databasePath, {readonly: true});
      expect(leased.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 1});
      leased.close();

      yield* releaseManagerGraphSnapshotLeases().pipe(provideTestLayer(storeLayer));

      const released = new Database(databasePath, {readonly: true});
      expect(released.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
      released.close();
    }),
  );

  effectIt.layer(managerGraphLayer)(layerIt => {
    layerIt.effect('validates only the exact active view and exact live lease in one read-only snapshot', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const home = temporaryRoot('threadnote-manager-lease-validation-');
            const identity = repositoryIdentity(home, Effect2.pipe('a', EffectString.repeat(64)));
            const databasePath = join(
              home,
              'indexes',
              'code-graph',
              'repositories',
              identity.checkoutId,
              'graph-v3.sqlite',
            );
            const snapshot = {
              ...readySnapshot(identity, 0, 0, 0, '2026-08-08T12:00:00.000Z'),
              id: `cgsn_${Effect2.pipe('a', EffectString.repeat(40))}-direct`,
            };
            const store = yield* CodeGraphStore;
            yield* store.activate(databasePath, identity, snapshot, [], [], []);
            yield* store.promote(databasePath, identity, snapshot.id);
            yield* managerGraphCatalog(home);

            const database = new Database(databasePath, {readonly: true});
            const lease = requiredRow(
              database
                .query<{readonly token: string}, SQLQueryBindings[]>(
                  'SELECT token FROM snapshot_leases WHERE snapshot_id = ? LIMIT 1',
                )
                .get(snapshot.id),
            );
            database.close();

            expect(
              yield* store.validateViewSnapshotLease(databasePath, identity.worktreeId, snapshot.id, lease.token, 0),
            ).toMatchObject({state: 'valid'});
            expect(
              yield* store.validateViewSnapshotLease(
                databasePath,
                identity.worktreeId,
                snapshot.id,
                `${lease.token}-wrong`,
                0,
              ),
            ).toEqual({state: 'invalid'});
            expect(
              yield* store.validateViewSnapshotLease(
                databasePath,
                identity.worktreeId,
                snapshot.id,
                lease.token,
                60 * 60_000,
              ),
            ).toEqual({state: 'invalid'});
            expect(
              yield* store.validateViewSnapshotLease(
                `${databasePath}.missing`,
                identity.worktreeId,
                snapshot.id,
                lease.token,
                0,
              ),
            ).toEqual({state: 'invalid'});
            expect(existsSync(`${databasePath}.missing`)).toBe(false);

            expect((yield* store.removeView(databasePath, identity.worktreeId, snapshot.id)).state).toBe('removed');
            expect(
              yield* store.validateViewSnapshotLease(databasePath, identity.worktreeId, snapshot.id, lease.token, 0),
            ).toEqual({state: 'invalid'});
            yield* releaseManagerGraphSnapshotLeases();
          }),
        ),
      ),
    );

    layerIt.effect('refuses stale cached lease reuse after external removal while the writer gate is busy', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const home = temporaryRoot('threadnote-manager-external-removal-busy-');
            const identity = repositoryIdentity(home, Effect2.pipe('b', EffectString.repeat(64)));
            const databasePath = join(
              home,
              'indexes',
              'code-graph',
              'repositories',
              identity.checkoutId,
              'graph-v3.sqlite',
            );
            const writerLockPath = join(
              home,
              'locks',
              'indexes',
              'code-graph',
              'database-writes',
              `${identity.checkoutId}.lock`,
            );
            const snapshot = {
              ...readySnapshot(identity, 0, 0, 0, '2026-08-08T12:00:00.000Z'),
              id: `cgsn_${Effect2.pipe('b', EffectString.repeat(40))}-direct`,
            };
            const store = yield* CodeGraphStore;
            yield* store.activate(databasePath, identity, snapshot, [], [], []);
            yield* store.promote(databasePath, identity, snapshot.id);
            yield* managerGraphCatalog(home);

            const catalogLoaded = yield* Deferred.make<void>();
            const resumeRetention = yield* Deferred.make<void>();
            let pauseNextCatalog = true;
            let validationCalls = 0;
            let traversals = 0;
            const interlockedStore = CodeGraphStore.of({
              ...store,
              loadVisualizationCatalog: (database, metrics, options) =>
                store.loadVisualizationCatalog(database, metrics, options).pipe(
                  Effect.tap(() => {
                    if (!pauseNextCatalog) return Effect.void;
                    pauseNextCatalog = false;
                    return Deferred.succeed(catalogLoaded, undefined).pipe(
                      Effect.andThen(Deferred.await(resumeRetention)),
                    );
                  }),
                ),
              validateViewSnapshotLease: (...arguments_) => {
                validationCalls += 1;
                return store.validateViewSnapshotLease(...arguments_);
              },
            });
            const queryFiber = yield* managerGraphQuery(
              home,
              `${identity.checkoutId}.${identity.worktreeId}`,
              'missing-symbol',
              {},
              Option.some(snapshot.id),
            ).pipe(
              Effect.provideService(CodeGraphStore, interlockedStore),
              Effect.provideService(ManagerGraphQueryLifecycle, {
                beforeTraversal: Effect.sync(() => {
                  traversals += 1;
                }),
              }),
              Effect.forkChild,
            );
            yield* Deferred.await(catalogLoaded);
            expect((yield* store.removeView(databasePath, identity.worktreeId, snapshot.id)).state).toBe('removed');

            const writerAcquired = yield* Deferred.make<void>();
            const releaseWriter = yield* Deferred.make<void>();
            const writer = yield* store
              .withSession(databasePath, store.initialize(databasePath), {
                onWriterAcquired: () =>
                  Deferred.succeed(writerAcquired, undefined).pipe(Effect.andThen(Deferred.await(releaseWriter))),
                writerLockPath,
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(writerAcquired);
            yield* Deferred.succeed(resumeRetention, undefined);
            const failure = yield* Fiber.join(queryFiber).pipe(
              Effect.flip,
              Effect.ensuring(Deferred.succeed(releaseWriter, undefined).pipe(Effect.asVoid)),
            );
            yield* Fiber.join(writer);

            expect(failure).toBeInstanceOf(ManagerGraphBusyError);
            expect(String(failure)).not.toContain(home);
            expect(validationCalls).toBe(1);
            expect(traversals).toBe(0);
            yield* releaseManagerGraphSnapshotLeases();
          }),
        ),
      ),
    );

    layerIt.effect('keeps an already-retained query coherent while its final view is removed', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const home = temporaryRoot('threadnote-manager-inflight-removal-');
            const identity = repositoryIdentity(home, Effect2.pipe('6', EffectString.repeat(64)));
            const databasePath = join(
              home,
              'indexes',
              'code-graph',
              'repositories',
              identity.checkoutId,
              'graph-v3.sqlite',
            );
            const symbols = [symbol('symbol-reader', 'src/reader.ts', 'Reader', 'typescript')];
            const files = fileFixtures(symbols);
            const snapshot = {
              ...readySnapshot(identity, files.length, symbols.length, 0, '2026-08-08T12:00:00.000Z'),
              id: `cgsn_${Effect2.pipe('6', EffectString.repeat(40))}-direct`,
            };
            const store = yield* CodeGraphStore;
            yield* store.activate(databasePath, identity, snapshot, files, symbols, []);
            yield* store.promote(databasePath, identity, snapshot.id);
            yield* managerGraphCatalog(home);

            const traversalReady = yield* Deferred.make<void>();
            const resumeTraversal = yield* Deferred.make<void>();
            const queryFiber = yield* managerGraphQuery(
              home,
              `${identity.checkoutId}.${identity.worktreeId}`,
              'Reader',
              {},
              Option.some(snapshot.id),
            ).pipe(
              Effect.provideService(ManagerGraphQueryLifecycle, {
                beforeTraversal: Deferred.succeed(traversalReady, undefined).pipe(
                  Effect.andThen(Deferred.await(resumeTraversal)),
                ),
              }),
              Effect.forkChild,
            );
            yield* Deferred.await(traversalReady);

            const removed = yield* withManagerGraphSnapshotLeaseInvalidated(
              home,
              identity.checkoutId,
              identity.worktreeId,
              snapshot.id,
              store.removeView(databasePath, identity.worktreeId, snapshot.id),
            );
            expect(removed.result.state).toBe('removed');
            const protectedDatabase = new Database(databasePath, {readonly: true});
            expect(protectedDatabase.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 1});
            expect(protectedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(snapshot.id)).toEqual({
              state: 'ready',
            });
            protectedDatabase.close();

            yield* Deferred.succeed(resumeTraversal, undefined);
            const result = yield* Fiber.join(queryFiber);
            expect(result.repository.snapshot.id).toBe(snapshot.id);
            expect(EffectArray.map(result.nodes, node => node.id)).toContain('symbol-reader');
            const reclaimed = new Database(databasePath, {readonly: true});
            expect(reclaimed.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
            reclaimed.close();
          }),
        ),
      ),
    );

    layerIt.effect('serializes view observation and lease retention with cross-process removal', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const home = temporaryRoot('threadnote-manager-atomic-retention-');
            const identity = repositoryIdentity(home, Effect2.pipe('5', EffectString.repeat(64)));
            const databasePath = join(
              home,
              'indexes',
              'code-graph',
              'repositories',
              identity.checkoutId,
              'graph-v3.sqlite',
            );
            const snapshot = {
              ...readySnapshot(identity, 0, 0, 0, '2026-08-08T12:00:00.000Z'),
              id: `cgsn_${Effect2.pipe('5', EffectString.repeat(40))}-direct`,
            };
            const store = yield* CodeGraphStore;
            yield* store.activate(databasePath, identity, snapshot, [], [], []);
            yield* store.promote(databasePath, identity, snapshot.id);

            const observed = yield* Deferred.make<void>();
            const resumeRetention = yield* Deferred.make<void>();
            const order: string[] = [];
            const interlockedStore = CodeGraphStore.of({
              ...store,
              retainViewSnapshotLease: (database, worktreeId, snapshotId, duration, options) =>
                store
                  .retainViewSnapshotLease(database, worktreeId, snapshotId, duration, {
                    ...options,
                    afterViewObserved: () =>
                      Effect.sync(() => order.push('observed')).pipe(
                        Effect.andThen(Deferred.succeed(observed, undefined)),
                        Effect.andThen(Deferred.await(resumeRetention)),
                      ),
                  })
                  .pipe(Effect.tap(() => Effect.sync(() => order.push('retained')))),
            });
            const catalogFiber = yield* managerGraphCatalog(home).pipe(
              Effect.provideService(CodeGraphStore, interlockedStore),
              Effect.forkChild,
            );
            yield* Deferred.await(observed);
            const removalFiber = yield* store
              .removeView(databasePath, identity.worktreeId, snapshot.id, {
                beforeDatabaseOpen: () => Effect.sync(() => order.push('remove-open')),
                waitTimeoutMilliseconds: 5_000,
              })
              .pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            expect(order).toEqual(['observed']);

            yield* Deferred.succeed(resumeRetention, undefined);
            const catalog = yield* Fiber.join(catalogFiber);
            const removal = yield* Fiber.join(removalFiber);
            expect(order).toEqual(['observed', 'retained', 'remove-open']);
            expect(
              EffectArrayPipe(catalog.repositories, __effectArrayValues =>
                EffectArray.flatMap(__effectArrayValues, (repository, __effectArrayIndex) =>
                  __effectArrayIndex in __effectArrayValues
                    ? EffectArray.map(repository.views, view => view.worktreeId)
                    : [],
                ),
              ),
            ).toEqual([identity.worktreeId]);
            expect(removal.state).toBe('removed');

            const refreshed = yield* managerGraphCatalog(home);
            expect(refreshed.repositories).toEqual([]);
            expect(refreshed.diagnostics).toEqual([
              expect.objectContaining({
                checkoutId: identity.checkoutId,
                code: 'no-ready-snapshot',
                message:
                  'Stored graph data has no queryable snapshot. Index from its repository folder, or purge it if it is obsolete.',
              }),
            ]);
          }),
        ),
      ),
    );

    layerIt.effect('does not recreate a graph database purged before atomic retention acquires the writer gate', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const home = temporaryRoot('threadnote-manager-retention-purge-race-');
            const identity = repositoryIdentity(home, Effect2.pipe('4', EffectString.repeat(64)));
            const databasePath = join(
              home,
              'indexes',
              'code-graph',
              'repositories',
              identity.checkoutId,
              'graph-v3.sqlite',
            );
            const snapshot = {
              ...readySnapshot(identity, 0, 0, 0, '2026-08-08T12:00:00.000Z'),
              id: `cgsn_${Effect2.pipe('4', EffectString.repeat(40))}-direct`,
            };
            const store = yield* CodeGraphStore;
            yield* store.activate(databasePath, identity, snapshot, [], [], []);
            yield* store.promote(databasePath, identity, snapshot.id);

            const purged = yield* Deferred.make<void>();
            const releasePurge = yield* Deferred.make<void>();
            const purgeFiber = yield* store
              .removeView(databasePath, identity.worktreeId, snapshot.id, {
                beforeDatabaseOpen: () =>
                  Effect.sync(() => rmSync(databasePath, {force: true})).pipe(
                    Effect.andThen(Deferred.succeed(purged, undefined)),
                    Effect.andThen(Deferred.await(releasePurge)),
                  ),
                waitTimeoutMilliseconds: 5_000,
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(purged);
            const retentionFiber = yield* store
              .retainViewSnapshotLease(databasePath, identity.worktreeId, snapshot.id, 60_000, {
                waitTimeoutMilliseconds: 5_000,
              })
              .pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            yield* Deferred.succeed(releasePurge, undefined);

            expect((yield* Fiber.join(purgeFiber)).state).toBe('not-found');
            expect(yield* Fiber.join(retentionFiber)).toEqual({
              observation: {expectedSnapshotId: snapshot.id, state: 'not-found'},
              state: 'view-unavailable',
            });
            expect(existsSync(databasePath)).toBe(false);
          }),
        ),
      ),
    );

    layerIt.effect(
      'serializes removal with stale catalogs and preserves the shared-view lease under concurrent load',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const home = temporaryRoot('threadnote-manager-stale-catalog-');
            const identity = repositoryIdentity(home, Effect2.pipe('7', EffectString.repeat(64)));
            const neighborWorktreeId = Effect2.pipe('8', EffectString.repeat(64));
            const databasePath = join(
              home,
              'indexes',
              'code-graph',
              'repositories',
              identity.checkoutId,
              'graph-v3.sqlite',
            );
            const snapshot = {
              ...readySnapshot(identity, 0, 0, 0, '2026-08-08T12:00:00.000Z'),
              id: `cgsn_${Effect2.pipe('7', EffectString.repeat(40))}-direct`,
            };
            const store = yield* CodeGraphStore;
            yield* store.activate(databasePath, identity, snapshot, [], [], []);
            yield* store.promote(databasePath, identity, snapshot.id);
            const shared = new Database(databasePath);
            shared
              .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
              .run(neighborWorktreeId, snapshot.id, '2026-08-08T12:00:01.000Z');
            shared.close();

            yield* managerGraphCatalog(home);
            const initiallyLeased = new Database(databasePath, {readonly: true});
            expect(initiallyLeased.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 1});
            const initialLease = requiredRow(
              initiallyLeased
                .query<{readonly snapshotId: string; readonly token: string}, SQLQueryBindings[]>(
                  'SELECT token, snapshot_id AS snapshotId FROM snapshot_leases',
                )
                .get(),
            );
            initiallyLeased.close();

            const failedAction = yield* withManagerGraphSnapshotLeaseInvalidated(
              home,
              identity.checkoutId,
              identity.worktreeId,
              snapshot.id,
              Effect.fail(TestError.make({message: 'fixture removal failed before its commit point'})),
            ).pipe(
              Effect.match({
                onFailure: error => error.message,
                onSuccess: () => 'unexpected success',
              }),
            );
            expect(failedAction).toBe('fixture removal failed before its commit point');
            const afterFailure = new Database(databasePath, {readonly: true});
            expect(afterFailure.query('SELECT token, snapshot_id AS snapshotId FROM snapshot_leases').get()).toEqual(
              initialLease,
            );
            afterFailure.close();

            const loaded = yield* Deferred.make<void>();
            const resume = yield* Deferred.make<void>();
            let pauseNextCatalog = true;
            const interlockedStore = CodeGraphStore.of({
              ...store,
              loadVisualizationCatalogs: (database, metrics, options) =>
                store.loadVisualizationCatalogs(database, metrics, options).pipe(
                  Effect.tap(() => {
                    if (!pauseNextCatalog) return Effect.void;
                    pauseNextCatalog = false;
                    return Deferred.succeed(loaded, undefined).pipe(Effect.andThen(Deferred.await(resume)));
                  }),
                ),
            });
            const staleCatalogFiber = yield* managerGraphCatalog(home).pipe(
              Effect.provideService(CodeGraphStore, interlockedStore),
              Effect.forkChild,
            );
            yield* Deferred.await(loaded);

            const removed = yield* withManagerGraphSnapshotLeaseInvalidated(
              home,
              identity.checkoutId,
              identity.worktreeId,
              snapshot.id,
              store.removeView(databasePath, identity.worktreeId, snapshot.id),
            );
            expect(removed.result.state).toBe('removed');
            expect(removed.warnings).toEqual([]);
            yield* Deferred.succeed(resume, undefined);
            const catalog = yield* Fiber.join(staleCatalogFiber);
            expect(
              EffectArrayPipe(catalog.repositories, __effectArrayValues =>
                EffectArray.flatMap(__effectArrayValues, (repository, __effectArrayIndex) =>
                  __effectArrayIndex in __effectArrayValues
                    ? EffectArray.map(repository.views, view => view.worktreeId)
                    : [],
                ),
              ),
            ).toEqual([neighborWorktreeId]);

            const startedAt = yield* TestClock.withLive(Clock.currentTimeMillis);
            const catalogs = yield* Effect.all(
              Array.from({length: 16}, () => managerGraphCatalog(home)),
              {concurrency: 'unbounded'},
            );
            const elapsed = (yield* TestClock.withLive(Clock.currentTimeMillis)) - startedAt;
            expect(elapsed).toBeLessThan(5_000);
            expect(
              EffectArray.every(catalogs, result =>
                EffectArray.every(result.repositories, repository =>
                  EffectArray.every(repository.views, view => view.worktreeId === neighborWorktreeId),
                ),
              ),
            ).toBe(true);
            const finallyLeased = new Database(databasePath, {readonly: true});
            expect(finallyLeased.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 1});
            expect(finallyLeased.query('SELECT token, snapshot_id AS snapshotId FROM snapshot_leases').get()).toEqual(
              initialLease,
            );
            finallyLeased.close();
            yield* releaseManagerGraphSnapshotLeases();
          }),
        ),
    );
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function repositoryIdentity(root: string, repositoryId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('e', EffectString.repeat(64)),
    displayName: 'acme/mobile',
    gitCommonDirectory: join(root, '.git'),
    headCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId,
    worktreeId: Effect2.pipe('f', EffectString.repeat(64)),
  };
}

function workspaceFixture(): CodeGraphWorkspace {
  return {
    diagnostics: [],
    fingerprint: 'workspace-fixture',
    projects: [
      {
        buildSystem: 'gradle',
        dependencies: ['cgp_component_b'],
        dependencyDetails: [{evidence: 'settings.gradle.kts', provenance: 'declared', targetId: 'cgp_component_b'}],
        diagnostics: [],
        id: 'cgp_component_a',
        kind: 'module',
        languages: ['kotlin'],
        name: 'core',
        provenance: 'declared',
        resolutionDomain: 'jvm',
        root: 'apps/a',
        sourceRoots: ['apps/a/src/main/kotlin'],
        workspaceId: 'cgw_workspace',
        workspaceRoots: ['.'],
      },
      {
        buildSystem: 'gradle',
        dependencies: [],
        dependencyDetails: [],
        diagnostics: [],
        id: 'cgp_component_b',
        kind: 'module',
        languages: ['kotlin'],
        name: 'core',
        provenance: 'declared',
        resolutionDomain: 'jvm',
        root: 'apps/b',
        sourceRoots: ['apps/b/src/main/kotlin'],
        workspaceId: 'cgw_workspace',
        workspaceRoots: ['.'],
      },
    ],
    workspaces: [
      {
        buildSystem: 'gradle',
        diagnostics: [],
        id: 'cgw_workspace',
        name: 'mobile',
        provenance: 'declared',
        root: '.',
      },
    ],
  };
}

function symbolFixtures(): readonly CodeGraphSymbol[] {
  return [
    symbol('symbol-a-1', 'apps/a/src/main/kotlin/A.kt', 'A', 'kotlin', 'cgp_component_a'),
    symbol('symbol-a-2', 'apps/a/src/main/kotlin/A2.kt', 'A2', 'kotlin', 'cgp_component_a'),
    symbol('symbol-b', 'apps/b/src/main/kotlin/B.kt', 'B', 'kotlin', 'cgp_component_b'),
    symbol('symbol-doc', 'notes/design.md', 'Design', 'markdown'),
    {
      ...symbol('symbol-root-ts', 'src/index.ts', 'index', 'typescript'),
      packageName: 'threadnote',
      resolutionDomain: 'typescript',
    },
    {...symbol('symbol-script', 'scripts/release.ts', 'release', 'typescript'), resolutionDomain: 'typescript'},
  ];
}

function symbol(id: string, path: string, name: string, language: string, resolutionScopeId?: string): CodeGraphSymbol {
  return {
    contentHash: `${id}-hash`,
    exported: true,
    id,
    kind: language === 'markdown' ? 'document' : 'class',
    language,
    lookupKeys: [`global:name:${name}`],
    name,
    path,
    qualifiedName: name,
    resolutionDomain: language === 'kotlin' ? 'jvm' : 'documentation',
    ...(resolutionScopeId ? {resolutionScopeId} : {}),
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function edgeFixtures(): readonly CodeGraphEdge[] {
  const intra = Array.from({length: 12_001}, (_, index) =>
    edge(`edge-${Effect2.pipe(index.toString(), EffectString.padStart(4, '0'))}`, 'symbol-a-1', 'symbol-a-2'),
  );
  return [
    ...intra,
    edge('edge-zzzz-cross', 'symbol-a-1', 'symbol-b'),
    edge('edge-zzzz-root-component', 'symbol-root-ts', 'symbol-a-1'),
    edge('edge-zzzz-script-root', 'symbol-script', 'symbol-root-ts'),
  ];
}

function edge(id: string, sourceId: string, targetId: string): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: 'apps/a/src/main/kotlin/A.kt',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance: 'resolved',
    relation: 'calls',
    sourceId,
    sourceName: sourceId,
    targetId,
    targetName: targetId,
  };
}

function fileFixtures(symbols: readonly CodeGraphSymbol[]): readonly CodeGraphInventoryFile[] {
  return EffectArray.map([...new Set(EffectArray.map(symbols, symbol => symbol.path))], path => ({
    blobId: `blob-${path}`,
    contentHash: `hash-${path}`,
    language: Effect2.pipe(path, EffectString.endsWith('.md')) ? 'markdown' : 'kotlin',
    mode: '100644',
    path,
    size: 10,
    source: 'commit',
  }));
}

function readySnapshot(
  identity: RepositoryIdentity,
  files: number,
  symbols: number,
  edges: number,
  completedAt: string,
): CodeGraphSnapshot {
  const timestampId = Effect2.pipe(
    completedAt,
    EffectString.replaceAll(/\D/g, ''),
    EffectString.padEnd(40, '0'),
    EffectString.slice(0, 40),
  );
  return {
    commit: identity.headCommit,
    completedAt,
    dirty: false,
    edgeCount: edges,
    extractorSet: 'workspace-test',
    fileCount: files,
    id: `cgsn_${timestampId}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: symbols,
    worktreeId: identity.worktreeId,
  };
}

function catalogFixture(
  repositoryId: string,
  displayName: string,
  activatedAt: string,
  symbolCount: number,
  viewWorktreeId: string,
): CodeGraphVisualizationCatalog {
  return {
    accounting: {
      attributedSymbols: symbolCount,
      componentSymbols: symbolCount,
      fallbackSymbols: 0,
      omittedSymbols: 0,
      totalSymbols: symbolCount,
    },
    activatedAt,
    metrics: 'complete',
    model: 'workspace',
    projectCount: 0,
    projects: [],
    projectsTruncated: false,
    repository: {displayName, repositoryId},
    snapshot: {
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      completedAt: activatedAt,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'fixture',
      fileCount: 0,
      id: `snapshot-${activatedAt}`,
      repositoryId,
      state: 'ready',
      symbolCount,
      worktreeId: 'worktree',
    },
    viewWorktreeId,
    workspaceCount: 0,
    workspaces: [],
    workspacesTruncated: false,
  };
}
