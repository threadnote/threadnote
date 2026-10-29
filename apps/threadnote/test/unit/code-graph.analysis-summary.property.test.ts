import {TestError} from '@threadnote/testing/test-error';
import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import * as FC from 'fast-check';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {claimPersistentBuildForTest} from '@threadnote/graph/test/helpers/code-graph-build';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const edgeSpec = FC.record({
  confidence: FC.integer({max: 100, min: 35}),
  id: FC.integer({max: 24, min: 0}),
  provenance: FC.constantFrom('declared' as const, 'resolved' as const, 'syntactic' as const),
  relation: FC.constantFrom('calls' as const, 'contains' as const, 'references' as const),
  source: FC.integer({max: 12, min: 0}),
  target: FC.integer({max: 12, min: 0}),
});

describe('persisted code graph analysis summaries', () => {
  fcEffectProp(
    it,
    'matches a clean rebuild after randomized overlay replacement/deletion independent of input order',
    {
      baseEdges: FC.array(edgeSpec, {maxLength: 35}),
      deletedEdges: FC.array(FC.integer({max: 24, min: 0}), {maxLength: 16}),
      nodeCount: FC.integer({max: 10, min: 1}),
      overlayEdges: FC.array(edgeSpec, {maxLength: 24}),
    },
    ({baseEdges, deletedEdges, nodeCount, overlayEdges}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-analysis-summary-property-'});
          const databasePath = path.join(root, 'graph-v3.sqlite');
          const identity = repositoryIdentity(root);
          const baseSymbols = Array.from({length: nodeCount}, (_, index) => graphSymbol(index));
          // Persisted delta activation is deliberately selected only when the
          // resolution surface is stable. Content, documentation and spans may
          // change while symbol identities remain reusable.
          const effectiveSymbols = EffectArray.map(baseSymbols, (symbol, index) => ({
            ...symbol,
            contentHash: `effective-${index}`,
            documentation: `effective documentation ${index}`,
          }));
          const baseEdgeMap = lastEdges(baseEdges, baseSymbols);
          const deleted = new Set(EffectArray.map(deletedEdges, edgeId));
          const effectiveEdgeMap = new Map(
            EffectArray.filter([...lastEdges(overlayEdges, effectiveSymbols)], ([id]) => !deleted.has(id)),
          );
          const baseSnapshot = snapshot(identity, 'base', baseSymbols.length, baseEdgeMap.size);
          const overlaySnapshot = {
            ...snapshot(identity, 'overlay', effectiveSymbols.length, effectiveEdgeMap.size),
            baseSnapshotId: baseSnapshot.id,
            dirty: true,
            overlayFingerprint: 'overlay-fingerprint',
          } satisfies CodeGraphSnapshot;
          const rebuiltSnapshot = snapshot(identity, 'rebuilt', effectiveSymbols.length, effectiveEdgeMap.size);

          yield* store.withSession(
            databasePath,
            Effect.gen(function* () {
              yield* store.prepareActivation(databasePath, [inventoryFile('base')]);
              yield* store.stageActivationFacts(databasePath, baseSymbols, [...baseEdgeMap.values()]);
              yield* store.activateStaged(databasePath, identity, baseSnapshot, {
                fileSetFingerprint: 'base-files',
                packProvenance: [],
                workspaceFingerprint: 'base-workspace',
              });
              const effectiveFile = inventoryFile('effective');
              const facts = {
                diagnostics: [],
                edges: [...effectiveEdgeMap.values()].reverse(),
                path: effectiveFile.path,
                symbols: [...effectiveSymbols].reverse(),
              } satisfies CodeGraphFileFacts;
              expect(
                yield* store.preparePersistedIncrementalActivation(
                  databasePath,
                  baseSnapshot.id,
                  [effectiveFile],
                  [facts],
                ),
              ).toBe(true);
              expect(yield* store.stagedFactCounts(databasePath)).toEqual({
                edges: effectiveEdgeMap.size,
                symbols: effectiveSymbols.length,
              });
              yield* store.activateStaged(databasePath, identity, overlaySnapshot);
            }),
          );
          yield* store.activate(
            databasePath,
            identity,
            rebuiltSnapshot,
            [inventoryFile('effective')],
            effectiveSymbols,
            [...effectiveEdgeMap.values()],
          );

          yield* store.ensureAnalysisSummary?.(databasePath, overlaySnapshot.id);
          yield* store.ensureAnalysisSummary?.(databasePath, rebuiltSnapshot.id);
          const overlay = Option.getOrThrow(yield* store.loadAnalysisSummary(databasePath, overlaySnapshot.id));
          const rebuilt = Option.getOrThrow(yield* store.loadAnalysisSummary(databasePath, rebuiltSnapshot.id));
          expect(overlay).toEqual(rebuilt);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 40}},
  );

  it.effect('subtracts deleted edges and replaces colliding edge IDs on the persisted delta path', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-analysis-summary-collision-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const symbols = [graphSymbol(0), graphSymbol(1), graphSymbol(2)];
        const baseEdges = [
          graphEdge(0, symbols, {
            confidence: 100,
            id: 0,
            provenance: 'resolved',
            relation: 'calls',
            source: 0,
            target: 1,
          }),
          graphEdge(1, symbols, {
            confidence: 55,
            id: 1,
            provenance: 'syntactic',
            relation: 'references',
            source: 1,
            target: 2,
          }),
        ];
        const effectiveSymbols = EffectArray.map(symbols, (symbol, index) => ({
          ...symbol,
          contentHash: `changed-${index}`,
        }));
        const effectiveEdges = [
          // edge-000 collides with the base ID but changes every aggregate
          // dimension and becomes a self-loop.
          graphEdge(0, effectiveSymbols, {
            confidence: 40,
            id: 0,
            provenance: 'declared',
            relation: 'contains',
            source: 2,
            target: 2,
          }),
          graphEdge(1, effectiveSymbols, {
            confidence: 90,
            id: 2,
            provenance: 'resolved',
            relation: 'calls',
            source: 1,
            target: 0,
          }),
          // edge-001 is intentionally absent and therefore deleted.
        ];
        const base = snapshot(identity, 'collision-base', symbols.length, baseEdges.length);
        const overlay = {
          ...snapshot(identity, 'collision-overlay', effectiveSymbols.length, effectiveEdges.length),
          baseSnapshotId: base.id,
          dirty: true,
          overlayFingerprint: 'collision-overlay',
        } satisfies CodeGraphSnapshot;
        const rebuilt = snapshot(identity, 'collision-rebuilt', effectiveSymbols.length, effectiveEdges.length);

        yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(databasePath, [inventoryFile('collision-base')]);
            yield* store.stageActivationFacts(databasePath, symbols, baseEdges);
            yield* store.activateStaged(databasePath, identity, base, {
              fileSetFingerprint: 'collision-base-files',
              packProvenance: [],
              workspaceFingerprint: 'collision-base-workspace',
            });
            const file = inventoryFile('collision-effective');
            expect(
              yield* store.preparePersistedIncrementalActivation(
                databasePath,
                base.id,
                [file],
                [{diagnostics: [], edges: effectiveEdges, path: file.path, symbols: effectiveSymbols}],
              ),
            ).toBe(true);
            yield* store.activateStaged(databasePath, identity, overlay);
          }),
        );
        yield* store.activate(
          databasePath,
          identity,
          rebuilt,
          [inventoryFile('collision-effective')],
          effectiveSymbols,
          effectiveEdges,
        );

        yield* store.ensureAnalysisSummary?.(databasePath, overlay.id);
        yield* store.ensureAnalysisSummary?.(databasePath, rebuilt.id);
        const actual = Option.getOrThrow(yield* store.loadAnalysisSummary(databasePath, overlay.id));
        const expected = Option.getOrThrow(yield* store.loadAnalysisSummary(databasePath, rebuilt.id));
        expect(actual).toEqual(expected);
        expect(actual).toMatchObject({edgeCount: 2, symbolCount: 3});
        expect(actual.edges).toEqual([
          expect.objectContaining({count: 1, provenance: 'declared', relation: 'contains', selfLoopCount: 1}),
          expect.objectContaining({count: 1, provenance: 'resolved', relation: 'calls', selfLoopCount: 0}),
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('does not double-count a replayed direct materialization batch', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-analysis-summary-replay-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const symbols = [graphSymbol(0), graphSymbol(1)];
        const edges = [
          graphEdge(0, symbols, {
            confidence: 100,
            id: 0,
            provenance: 'resolved',
            relation: 'calls',
            source: 0,
            target: 1,
          }),
        ];
        const ready = snapshot(identity, 'direct-replay', symbols.length, edges.length);

        yield* store.initialize(databasePath);
        yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            const owner = yield* claimPersistentBuildForTest(store, databasePath, identity, ready);
            yield* store.prepareActivation(databasePath, [inventoryFile('direct')], ready.id, 1, owner);
            yield* store.stageActivationFacts(databasePath, symbols, edges, [], undefined, 0);
            yield* store.stageActivationFacts(databasePath, symbols, edges, [], undefined, 0);
            yield* store.resolveStagedReferences(databasePath);
            yield* store.activateStaged(databasePath, identity, ready);
            yield* store.ensureAnalysisSummary?.(databasePath, ready.id);
          }),
        );

        const summary = Option.getOrThrow(yield* store.loadAnalysisSummary(databasePath, ready.id));
        expect(summary).toMatchObject({edgeCount: 1, symbolCount: 2});
        expect(summary.edges).toEqual([expect.objectContaining({count: 1, provenance: 'resolved', relation: 'calls'})]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('updates compact edge aggregates in the same transaction as reference resolution', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-analysis-summary-resolution-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const source = {...graphSymbol(0), resolutionDomain: 'typescript'};
        const target = {
          ...graphSymbol(1),
          lookupKeys: ['typescript:name:Target'],
          name: 'Target',
          qualifiedName: 'Target',
          resolutionDomain: 'typescript',
        };
        const unresolved: CodeGraphEdge = {
          confidence: 0.7,
          evidencePath: source.path,
          evidenceSpan: source.span,
          id: 'unresolved-edge',
          provenance: 'syntactic',
          relation: 'calls',
          sourceId: source.id,
          sourceName: source.name,
          targetName: target.name,
        };
        const ready = snapshot(identity, 'direct-resolution', 2, 1);
        yield* store.initialize(databasePath);
        yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            const owner = yield* claimPersistentBuildForTest(store, databasePath, identity, ready);
            yield* store.prepareActivation(databasePath, [inventoryFile('direct-resolution')], ready.id, 1, owner);
            yield* store.stageActivationFacts(
              databasePath,
              [source, target],
              [unresolved],
              [
                {
                  edgeId: unresolved.id,
                  evidencePath: unresolved.evidencePath,
                  evidenceSpan: unresolved.evidenceSpan,
                  lookupTiers: [['typescript:name:Target']],
                  provenance: unresolved.provenance,
                  relation: unresolved.relation,
                  resolutionDomain: 'typescript',
                  sourceId: source.id,
                  sourceName: source.name,
                  targetName: target.name,
                },
              ],
              undefined,
              0,
            );
            const resolution = yield* store.resolveStagedReferences(databasePath);
            expect(resolution.resolved).toBe(1);
            yield* store.activateStaged(databasePath, identity, ready);
            yield* store.ensureAnalysisSummary?.(databasePath, ready.id);
          }),
        );

        const summary = Option.getOrThrow(yield* store.loadAnalysisSummary(databasePath, ready.id));
        expect(summary.edges).toEqual([
          expect.objectContaining({
            confidenceHigh: 1,
            confidenceTotal: 1,
            count: 1,
            provenance: 'resolved',
            relation: 'calls',
            unresolvedEndpointCount: 0,
          }),
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('backfills a legacy ready snapshot once and repairs a corrupt receipt on the writer path', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-analysis-summary-backfill-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const symbols = [graphSymbol(0), graphSymbol(1), graphSymbol(2)];
        const edges = [
          graphEdge(0, symbols, {
            confidence: 100,
            id: 0,
            provenance: 'resolved',
            relation: 'calls',
            source: 0,
            target: 1,
          }),
        ];
        const ready = snapshot(identity, 'legacy-backfill', symbols.length, edges.length);
        yield* store.activate(databasePath, identity, ready, [inventoryFile('legacy')], symbols, edges);

        yield* Effect.sync(() => {
          const database = new Database(databasePath);
          try {
            database.exec(`
              DELETE FROM snapshot_analysis_summary_receipts;
              DELETE FROM snapshot_analysis_edge_counts;
              DELETE FROM snapshot_analysis_edge_histogram;
              DELETE FROM snapshot_analysis_symbol_counts;
            `);
          } finally {
            database.close();
          }
        });
        expect(Option.isNone(yield* store.loadAnalysisSummary(databasePath, ready.id))).toBe(true);
        expect(
          yield* store.withSession(databasePath, store.ensureAnalysisSummary(databasePath, ready.id), {
            writerLockPath: path.join(root, 'summary-backfill.lock'),
          }),
        ).toBe(true);
        expect(yield* store.ensureAnalysisSummary(databasePath, ready.id)).toBe(false);
        expect(Option.getOrThrow(yield* store.loadAnalysisSummary(databasePath, ready.id))).toMatchObject({
          edgeCount: edges.length,
          symbolCount: symbols.length,
        });

        yield* Effect.sync(() => {
          const database = new Database(databasePath);
          try {
            database
              .query('UPDATE snapshot_analysis_summary_receipts SET digest = ? WHERE snapshot_id = ?')
              .run('corrupt', ready.id);
          } finally {
            database.close();
          }
        });
        expect(Option.isNone(yield* store.loadAnalysisSummary(databasePath, ready.id))).toBe(true);
        expect(yield* store.ensureAnalysisSummary(databasePath, ready.id)).toBe(true);
        expect(Option.getOrThrow(yield* store.loadAnalysisSummary(databasePath, ready.id)).digest).not.toBe('corrupt');

        yield* Effect.sync(() => {
          const database = new Database(databasePath);
          try {
            database.exec(`
              DELETE FROM snapshot_analysis_summary_receipts;
              DELETE FROM snapshot_analysis_edge_counts;
              DELETE FROM snapshot_analysis_edge_histogram;
              DELETE FROM snapshot_analysis_symbol_counts;
              CREATE TRIGGER fail_analysis_summary_receipt
              BEFORE INSERT ON snapshot_analysis_summary_receipts
              BEGIN
                SELECT RAISE(ABORT, 'simulated interrupted analysis backfill');
              END;
            `);
          } finally {
            database.close();
          }
        });
        const interrupted = yield* Effect.exit(store.ensureAnalysisSummary(databasePath, ready.id));
        expect(interrupted._tag).toBe('Failure');
        const partialCounts = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true});
          try {
            return requiredRow(
              database
                .query<
                  {
                    readonly edges: number;
                    readonly histogram: number;
                    readonly receipts: number;
                    readonly symbols: number;
                  },
                  SQLQueryBindings[]
                >(
                  `SELECT
                   (SELECT COUNT(*) FROM snapshot_analysis_symbol_counts) AS symbols,
                   (SELECT COUNT(*) FROM snapshot_analysis_edge_histogram) AS histogram,
                   (SELECT COUNT(*) FROM snapshot_analysis_edge_counts) AS edges,
                   (SELECT COUNT(*) FROM snapshot_analysis_summary_receipts) AS receipts`,
                )
                .get(),
            );
          } finally {
            database.close();
          }
        });
        expect(partialCounts).toEqual({edges: 0, histogram: 0, receipts: 0, symbols: 0});
        yield* Effect.sync(() => {
          const database = new Database(databasePath);
          try {
            database.exec('DROP TRIGGER fail_analysis_summary_receipt');
          } finally {
            database.close();
          }
        });
        expect(yield* store.ensureAnalysisSummary(databasePath, ready.id)).toBe(true);

        const cascadedCounts = yield* Effect.sync(() => {
          const database = new Database(databasePath);
          try {
            database.exec("PRAGMA foreign_keys = ON; DELETE FROM snapshots WHERE id = 'legacy-backfill';");
            return requiredRow(
              database
                .query<
                  {
                    readonly batches: number;
                    readonly edges: number;
                    readonly histogram: number;
                    readonly receipts: number;
                    readonly symbols: number;
                  },
                  SQLQueryBindings[]
                >(
                  `SELECT
                   (SELECT COUNT(*) FROM snapshot_analysis_symbol_counts) AS symbols,
                   (SELECT COUNT(*) FROM snapshot_analysis_edge_histogram) AS histogram,
                   (SELECT COUNT(*) FROM snapshot_analysis_edge_counts) AS edges,
                   (SELECT COUNT(*) FROM snapshot_analysis_summary_receipts) AS receipts,
                   (SELECT COUNT(*) FROM building_analysis_batches) AS batches`,
                )
                .get(),
            );
          } finally {
            database.close();
          }
        });
        expect(cascadedCounts).toEqual({batches: 0, edges: 0, histogram: 0, receipts: 0, symbols: 0});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('backfills a legacy dirty snapshot together with its clean base', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-analysis-summary-dirty-backfill-'});
        const databasePath = path.join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const symbols = [graphSymbol(0), graphSymbol(1)];
        const baseEdges = [
          graphEdge(0, symbols, {
            confidence: 100,
            id: 0,
            provenance: 'resolved',
            relation: 'calls',
            source: 0,
            target: 1,
          }),
        ];
        const effectiveEdges = [
          graphEdge(0, symbols, {
            confidence: 60,
            id: 0,
            provenance: 'syntactic',
            relation: 'references',
            source: 1,
            target: 0,
          }),
        ];
        const base = snapshot(identity, 'legacy-dirty-base', symbols.length, baseEdges.length);
        const overlay = {
          ...snapshot(identity, 'legacy-dirty-overlay', symbols.length, effectiveEdges.length),
          baseSnapshotId: base.id,
          dirty: true,
          overlayFingerprint: 'legacy-dirty-overlay',
        } satisfies CodeGraphSnapshot;
        const rebuilt = snapshot(identity, 'legacy-dirty-rebuilt', symbols.length, effectiveEdges.length);
        yield* store.activate(databasePath, identity, base, [inventoryFile('dirty-base')], symbols, baseEdges);
        yield* store.activate(
          databasePath,
          identity,
          overlay,
          [inventoryFile('dirty-overlay')],
          symbols,
          effectiveEdges,
        );
        yield* store.activate(
          databasePath,
          identity,
          rebuilt,
          [inventoryFile('dirty-overlay')],
          symbols,
          effectiveEdges,
        );

        yield* Effect.sync(() => {
          const database = new Database(databasePath);
          try {
            database.exec(`
              DELETE FROM snapshot_analysis_summary_receipts;
              DELETE FROM snapshot_analysis_edge_counts;
              DELETE FROM snapshot_analysis_edge_histogram;
              DELETE FROM snapshot_analysis_symbol_counts;
            `);
          } finally {
            database.close();
          }
        });
        expect(yield* store.ensureAnalysisSummary(databasePath, overlay.id)).toBe(true);
        const backfilledBase = yield* store.loadAnalysisSummary(databasePath, base.id);
        const backfilledOverlay = Option.getOrThrow(yield* store.loadAnalysisSummary(databasePath, overlay.id));
        const expected = Option.getOrThrow(
          yield* store
            .ensureAnalysisSummary(databasePath, rebuilt.id)
            .pipe(Effect.andThen(store.loadAnalysisSummary(databasePath, rebuilt.id))),
        );
        expect(Option.isSome(backfilledBase)).toBe(true);
        expect(backfilledOverlay).toEqual(expected);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('serializes concurrent legacy backfills across independent runtimes', async () => {
    const root = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({prefix: 'threadnote-analysis-summary-concurrent-'});
      }),
    );
    const databasePath = `${root}/graph-v3.sqlite`;
    const identity = repositoryIdentity(root);
    const symbols = [graphSymbol(0), graphSymbol(1)];
    const edges = [
      graphEdge(0, symbols, {
        confidence: 100,
        id: 0,
        provenance: 'resolved',
        relation: 'calls',
        source: 0,
        target: 1,
      }),
    ];
    const ready = snapshot(identity, 'concurrent-backfill', symbols.length, edges.length);
    try {
      await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.activate(databasePath, identity, ready, [inventoryFile('concurrent')], symbols, edges);
        }),
      );
      const database = new Database(databasePath);
      try {
        database.exec(`
          DELETE FROM snapshot_analysis_summary_receipts;
          DELETE FROM snapshot_analysis_edge_counts;
          DELETE FROM snapshot_analysis_edge_histogram;
          DELETE FROM snapshot_analysis_symbol_counts;
        `);
      } finally {
        database.close();
      }
      const writerLockPath = `${root}/summary-backfill.lock`;
      const backfill = () =>
        runEffect(
          Effect.gen(function* () {
            const store = yield* CodeGraphStore;
            return yield* store.withSession(databasePath, store.ensureAnalysisSummary(databasePath, ready.id), {
              writerLockPath,
            });
          }),
        );
      expect((await Promise.all([backfill(), backfill()])).sort()).toEqual([false, true]);
      expect(
        await runEffect(
          Effect.gen(function* () {
            const store = yield* CodeGraphStore;
            return Option.isSome(yield* store.loadAnalysisSummary(databasePath, ready.id));
          }),
        ),
      ).toBe(true);
    } finally {
      await runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(root, {recursive: true});
        }),
      );
    }
  });
});

interface EdgeSpec {
  readonly confidence: number;
  readonly id: number;
  readonly provenance: CodeGraphEdge['provenance'];
  readonly relation: CodeGraphEdge['relation'];
  readonly source: number;
  readonly target: number;
}

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
    displayName: 'analysis-summary-property',
    gitCommonDirectory: root,
    headCommit: Effect2.pipe('1', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: Effect2.pipe('r', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('w', EffectString.repeat(64)),
  };
}

function inventoryFile(hash: string): CodeGraphInventoryFile {
  return {
    blobId: Effect2.pipe('b', EffectString.repeat(40)),
    contentHash: Effect2.pipe(hash, EffectString.padEnd(64, '0')),
    language: 'typescript',
    mode: '100644',
    path: 'apps/threadnote/src/graph.ts',
    size: 100,
    source: 'commit',
  };
}

function graphSymbol(index: number): CodeGraphSymbol {
  return {
    contentHash: `base-${index}`,
    exported: true,
    id: nodeId(index),
    kind: 'function',
    language: 'typescript',
    name: `node${index}`,
    path: 'apps/threadnote/src/graph.ts',
    qualifiedName: `node${index}`,
    span: {column: 1, endColumn: 2, endLine: index + 1, line: index + 1},
  };
}

function graphEdge(index: number, symbols: readonly CodeGraphSymbol[], spec: EdgeSpec): CodeGraphEdge {
  const source = symbols[spec.source % symbols.length];
  const target = symbols[spec.target % symbols.length];
  return {
    confidence: spec.confidence / 100,
    evidencePath: 'apps/threadnote/src/graph.ts',
    evidenceSpan: source.span,
    id: edgeId(spec.id ?? index),
    provenance: spec.provenance,
    relation: spec.relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  };
}

function lastEdges(
  specs: readonly EdgeSpec[],
  symbols: readonly CodeGraphSymbol[],
): ReadonlyMap<string, CodeGraphEdge> {
  const result = new Map<string, CodeGraphEdge>();
  for (const [index, spec] of specs.entries()) result.set(edgeId(spec.id), graphEdge(index, symbols, spec));
  return result;
}

function snapshot(identity: RepositoryIdentity, id: string, symbolCount: number, edgeCount: number): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount,
    extractorSet: 'analysis-summary-property',
    fileCount: 1,
    id,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount,
    worktreeId: identity.worktreeId,
  };
}

function edgeId(value: number): string {
  return `edge-${Effect2.pipe(value.toString(), EffectString.padStart(3, '0'))}`;
}

function nodeId(value: number): string {
  return `node-${Effect2.pipe(value.toString(), EffectString.padStart(3, '0'))}`;
}
