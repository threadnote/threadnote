import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {Effect, Option, Path} from 'effect';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {compareCodeUnits} from '@threadnote/graph/ordering';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {CodeGraphStore, type CodeGraphVisualizationCatalog, type StoredCodeGraph} from '@threadnote/graph/store';
import type {CodeGraphMaterializationMetrics, CodeGraphQueryResult} from '@threadnote/graph/types';
import {runEffect} from '../helpers/effect-runtime.js';

interface DifferentialScenario {
  readonly baseTargets: readonly number[];
  readonly dirty: ReadonlySet<number>;
  readonly dirtyTargets: readonly number[];
  readonly fileCount: number;
  readonly salt: number;
}

interface CleanSurfaceChangeScenario {
  readonly fileCount: number;
  readonly mutation: 'arity' | 'callback-argument' | 'export' | 'file-local-function' | 'private-method' | 'rename';
  readonly sourceSeed: number;
}

const scenarioArbitrary = FC.record({
  baseTargets: FC.array(FC.integer({max: 31, min: 0}), {maxLength: 7, minLength: 7}),
  dirtyMask: FC.array(FC.boolean(), {maxLength: 7, minLength: 7}),
  dirtyTargets: FC.array(FC.integer({max: 31, min: 0}), {maxLength: 7, minLength: 7}),
  fileCount: FC.integer({max: 7, min: 3}),
  salt: FC.integer({max: 10_000, min: 0}),
}).map(({baseTargets, dirtyMask, dirtyTargets, fileCount, salt}) => {
  const dirty = new Set(
    EffectArray.flatMap(dirtyMask.slice(3, fileCount), (enabled, index) => (enabled ? [index + 3] : [])),
  );
  dirty.add(0);
  dirty.add(2);
  const anchoredBaseTargets = baseTargets.slice(0, fileCount);
  const anchoredDirtyTargets = dirtyTargets.slice(0, fileCount);
  anchoredBaseTargets[0] = 1;
  anchoredDirtyTargets[0] = 2;
  anchoredBaseTargets[1] = 0;
  anchoredDirtyTargets[1] = 0;
  anchoredBaseTargets[2] = 1;
  anchoredDirtyTargets[2] = 1;
  return {
    baseTargets: anchoredBaseTargets,
    dirty,
    dirtyTargets: anchoredDirtyTargets,
    fileCount,
    salt,
  } satisfies DifferentialScenario;
});

const surfaceChangeScenarioArbitrary = FC.record({
  fileCount: FC.integer({max: 7, min: 3}),
  mutation: FC.constantFrom(
    'arity' as const,
    'callback-argument' as const,
    'export' as const,
    'file-local-function' as const,
    'private-method' as const,
    'rename' as const,
  ),
  sourceSeed: FC.integer({max: 31, min: 0}),
});

const cleanSurfaceChangeScenarioArbitrary = surfaceChangeScenarioArbitrary.filter(scenario =>
  ['arity', 'export', 'rename'].includes(scenario.mutation),
);

const unpublishedSurfaceChangeScenarioArbitrary = surfaceChangeScenarioArbitrary.filter(scenario =>
  ['callback-argument', 'file-local-function', 'private-method'].includes(scenario.mutation),
);

describe('code graph incremental-overlay differential properties', () => {
  fcEffectProp(
    it,
    'matches a full rebuild after randomized body-only edits change multi-file references',
    {scenario: scenarioArbitrary},
    ({scenario}) =>
      Effect.promise(async () => {
        const root = createRepository(scenario);
        const homesRoot = `${root}-homes`;
        const incrementalHome = join(homesRoot, 'incremental');
        const fullHome = join(homesRoot, 'full');
        const incrementalStorageObservations: NonNullable<CodeGraphMaterializationMetrics['storage']>[] = [];
        const fullStorageObservations: NonNullable<CodeGraphMaterializationMetrics['storage']>[] = [];
        try {
          await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            }),
          );
          applyDirtyScenario(root, scenario);
          const result = await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const query = yield* CodeGraphQueryService;
              const store = yield* CodeGraphStore;
              const incremental = yield* indexer.index({
                cwd: root,
                onProgress: progress =>
                  Effect.sync(() => {
                    if (progress.phase === 'materializing' && progress.metrics?.storage !== undefined) {
                      incrementalStorageObservations.push(progress.metrics.storage);
                    }
                  }),
                threadnoteHome: incrementalHome,
              });
              const full = yield* indexer.index({
                cwd: root,
                incrementalOverlay: false,
                onProgress: progress =>
                  Effect.sync(() => {
                    if (progress.phase === 'materializing' && progress.metrics?.storage !== undefined) {
                      fullStorageObservations.push(progress.metrics.storage);
                    }
                  }),
                threadnoteHome: fullHome,
              });
              const incrementalLayout = codeGraphLayout(
                path,
                incrementalHome,
                incremental.identity.checkoutId,
                incremental.identity.worktreeId,
              );
              const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
              const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
              const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);
              const [incrementalQuery, fullQuery] = yield* Effect.all(
                [
                  query.inspect({
                    cwd: root,
                    operation: 'query',
                    query: 'symbol0',
                    refresh: false,
                    threadnoteHome: incrementalHome,
                  }),
                  query.inspect({
                    cwd: root,
                    operation: 'query',
                    query: 'symbol0',
                    refresh: false,
                    threadnoteHome: fullHome,
                  }),
                ],
                {concurrency: 1},
              );
              return {
                full,
                fullCatalog: yield* store.loadVisualizationCatalog(fullLayout.databasePath),
                fullDatabasePath: fullLayout.databasePath,
                fullGraph,
                fullHealth: yield* store.diagnose(fullLayout.databasePath),
                fullQuery,
                incremental,
                incrementalCatalog: yield* store.loadVisualizationCatalog(incrementalLayout.databasePath),
                incrementalGraph,
                incrementalHealth: yield* store.diagnose(incrementalLayout.databasePath),
                incrementalQuery,
              };
            }),
          );

          expect(result.incremental.materialization).toEqual({
            mode: 'incremental-overlay',
            stagedFiles: scenario.dirty.size,
            totalFiles: scenario.fileCount,
          });
          expect(result.full.materialization).toEqual({
            fallbackReason: 'disabled',
            mode: 'full',
            stagedFiles: scenario.fileCount,
            totalFiles: scenario.fileCount,
          });
          expect(normalizeGraph(result.incrementalGraph)).toEqual(normalizeGraph(result.fullGraph));
          expect(normalizeCatalog(result.incrementalCatalog)).toEqual(normalizeCatalog(result.fullCatalog));
          expect(normalizeQuery(result.incrementalQuery)).toEqual(normalizeQuery(result.fullQuery));
          expect(result.incrementalHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
          expect(result.fullHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
          expect(result.full.snapshot).toMatchObject({baseSnapshotId: undefined, dirty: true, state: 'ready'});
          expect(persistedSnapshots(result.fullDatabasePath)).toEqual([
            {
              baseSnapshotId: Option.none(),
              dirty: 1,
              id: result.full.snapshot.id,
              state: 'ready',
            },
          ]);
          const incrementalStorage = incrementalStorageObservations.at(-1);
          expect(incrementalStorage).toMatchObject({
            materializationMode: 'direct-persistent',
            temporaryDatabaseBytes: 0,
            temporaryDatabaseHighWaterBytes: 0,
          });
          expect(incrementalStorage?.durableDatabaseGrowthHighWaterBytes).toBeGreaterThanOrEqual(0);
          expect(incrementalStorage?.durableFilesystemHighWaterBytes).toBeGreaterThan(0);
          expect(
            Math.max(
              incrementalStorage?.durableJournalHighWaterBytes ?? 0,
              incrementalStorage?.durableWalHighWaterBytes ?? 0,
            ),
          ).toBeGreaterThan(0);
          expect(fullStorageObservations.at(-1)).toMatchObject({
            materializationMode: 'direct-persistent',
            temporaryDatabaseBytes: 0,
            temporaryDatabaseHighWaterBytes: 0,
          });

          const expectedCalls = new Set(
            Array.from({length: scenario.fileCount}, (_, source) => {
              const rawTarget = scenario.dirty.has(source)
                ? scenario.dirtyTargets[source]
                : scenario.baseTargets[source];
              return `symbol${source}->symbol${differentFile(rawTarget, source, scenario.fileCount)}`;
            }),
          );
          const resolvedCalls = new Set(
            EffectArray.map(
              EffectArray.filter(
                result.incrementalGraph.edges,
                edge => edge.relation === 'calls' && edge.sourceId !== undefined && edge.targetId !== undefined,
              ),
              edge => `${edge.sourceName}->${edge.targetName}`,
            ),
          );
          expect(resolvedCalls).toEqual(expectedCalls);
        } finally {
          rmSync(homesRoot, {force: true, recursive: true});
          rmSync(root, {force: true, recursive: true});
        }
      }),
    {
      fastCheck: {interruptAfterTimeLimit: 180_000, markInterruptAsFailure: true, numRuns: 10},
      timeout: 190_000,
    },
  );

  fcEffectProp(
    it,
    'keeps randomized unpublished TypeScript declarations equivalent to a forced dirty rebuild',
    {scenario: unpublishedSurfaceChangeScenarioArbitrary},
    ({scenario}) =>
      Effect.acquireUseRelease(
        Effect.sync(() => createRepository(simpleScenario(scenario.fileCount))),
        root =>
          Effect.gen(function* () {
            const source = scenario.sourceSeed % scenario.fileCount;
            const incrementalHome = `${root}-unpublished-incremental-home`;
            const fullHome = `${root}-unpublished-full-home`;
            const indexer = yield* CodeGraphIndexer;
            const path = yield* Path.Path;
            const store = yield* CodeGraphStore;
            const base = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            yield* Effect.sync(() =>
              writeSurfaceChangedSource(root, simpleScenario(scenario.fileCount), source, scenario.mutation),
            );
            const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
            const incrementalLayout = codeGraphLayout(
              path,
              incrementalHome,
              incremental.identity.checkoutId,
              incremental.identity.worktreeId,
            );
            const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
            const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
            const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);

            expect(incremental.materialization).toMatchObject({
              mode: 'incremental-overlay',
              resolutionPublicationGate: 'own-path-local',
              stagedFiles: 1,
              totalFiles: scenario.fileCount,
            });
            expect(incremental.snapshot).toMatchObject({baseSnapshotId: base.snapshot.id, dirty: true});
            expect(full.materialization).toMatchObject({fallbackReason: 'disabled', mode: 'full'});
            expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
          }),
        root =>
          Effect.sync(() => {
            rmSync(root, {force: true, recursive: true});
            rmSync(`${root}-unpublished-incremental-home`, {force: true, recursive: true});
            rmSync(`${root}-unpublished-full-home`, {force: true, recursive: true});
          }),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {
      fastCheck: {interruptAfterTimeLimit: 120_000, markInterruptAsFailure: true, numRuns: 6},
      timeout: 130_000,
    },
  );

  fcEffectProp(
    it,
    'matches a full rebuild after randomized compatible changes are committed cleanly',
    {scenario: scenarioArbitrary},
    ({scenario}) =>
      Effect.promise(async () => {
        const root = createRepository(scenario);
        const homesRoot = `${root}-homes`;
        const incrementalHome = join(homesRoot, 'incremental');
        const fullHome = join(homesRoot, 'full');
        try {
          const base = await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              return yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            }),
          );
          applyDirtyScenario(root, scenario);
          commitScenarioFiles(root, scenario, 'compatible clean property change');
          const result = await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const query = yield* CodeGraphQueryService;
              const store = yield* CodeGraphStore;
              const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              const full = yield* indexer.index({cwd: root, threadnoteHome: fullHome});
              const incrementalLayout = codeGraphLayout(
                path,
                incrementalHome,
                incremental.identity.checkoutId,
                incremental.identity.worktreeId,
              );
              const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
              const [incrementalQuery, fullQuery] = yield* Effect.all(
                [
                  query.inspect({
                    cwd: root,
                    operation: 'query',
                    query: 'symbol0',
                    refresh: false,
                    threadnoteHome: incrementalHome,
                  }),
                  query.inspect({
                    cwd: root,
                    operation: 'query',
                    query: 'symbol0',
                    refresh: false,
                    threadnoteHome: fullHome,
                  }),
                ],
                {concurrency: 1},
              );
              return {
                full,
                fullCatalog: yield* store.loadVisualizationCatalog(fullLayout.databasePath),
                fullGraph: yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id),
                fullQuery,
                incremental,
                incrementalCatalog: yield* store.loadVisualizationCatalog(incrementalLayout.databasePath),
                incrementalGraph: yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id),
                incrementalHealth: yield* store.diagnose(incrementalLayout.databasePath),
                incrementalQuery,
              };
            }),
          );

          expect(result.incremental.materialization).toEqual({
            mode: 'incremental-clean',
            stagedFiles: scenario.dirty.size,
            totalFiles: scenario.fileCount,
          });
          expect(result.incremental.snapshot).toMatchObject({baseSnapshotId: base.snapshot.id, dirty: false});
          expect(result.full.materialization).toEqual({
            mode: 'full',
            stagedFiles: scenario.fileCount,
            totalFiles: scenario.fileCount,
          });
          expect(normalizeGraph(result.incrementalGraph)).toEqual(normalizeGraph(result.fullGraph));
          expect(normalizeCatalog(result.incrementalCatalog)).toEqual(normalizeCatalog(result.fullCatalog));
          expect(normalizeQuery(result.incrementalQuery)).toEqual(normalizeQuery(result.fullQuery));
          expect(result.incrementalHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
        } finally {
          rmSync(homesRoot, {force: true, recursive: true});
          rmSync(root, {force: true, recursive: true});
        }
      }),
    {
      fastCheck: {interruptAfterTimeLimit: 150_000, markInterruptAsFailure: true, numRuns: 8},
      timeout: 160_000,
    },
  );

  fcEffectProp(
    it,
    'fails closed to full materialization for randomized clean resolution-surface changes',
    {scenario: cleanSurfaceChangeScenarioArbitrary},
    ({scenario}) =>
      Effect.acquireUseRelease(
        Effect.sync(() => createRepository(simpleScenario(scenario.fileCount))),
        root =>
          Effect.gen(function* () {
            const source = scenario.sourceSeed % scenario.fileCount;
            const baseScenario = simpleScenario(scenario.fileCount);
            const home = join(root, '.threadnote-clean-surface-home');
            const indexer = yield* CodeGraphIndexer;
            const base = yield* indexer.index({cwd: root, threadnoteHome: home});
            yield* Effect.sync(() => {
              writeSurfaceChangedSource(root, baseScenario, source, scenario.mutation);
              commitPaths(root, [`src/file-${source}.ts`], `clean ${scenario.mutation} surface change`);
            });
            const result = yield* indexer.index({cwd: root, threadnoteHome: home});

            expect(result.materialization).toEqual({
              fallbackReason:
                scenario.mutation === 'arity' ? 'project-closure-incomplete' : 'resolution-surface-changed',
              mode: 'full',
              resolutionLookupKeyForm: 'typescript-path-unscoped',
              resolutionPublicationGate: scenario.mutation === 'export' ? 'own-path-local' : 'exported',
              stagedFiles: scenario.fileCount,
              totalFiles: scenario.fileCount,
            });
            expect(result.snapshot).toMatchObject({baseSnapshotId: undefined, dirty: false, state: 'ready'});
            expect(result.snapshot.id).not.toBe(base.snapshot.id);
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {
      fastCheck: {interruptAfterTimeLimit: 120_000, markInterruptAsFailure: true, numRuns: 6},
      timeout: 130_000,
    },
  );

  it('resumes an interrupted forced dirty direct build without creating a second snapshot', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 41,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-forced-full-home');
    const storageObservations: NonNullable<CodeGraphMaterializationMetrics['storage']>[] = [];
    try {
      applyDirtyScenario(root, scenario);
      const interrupted = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const identity = yield* resolveRepositoryIdentity(root);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const exit = yield* indexer
            .index({
              cwd: root,
              force: true,
              onProgress: progress =>
                progress.phase === 'materializing' && (progress.metrics?.batchesCompleted ?? 0) > 0
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
          return {databasePath: layout.databasePath, exit};
        }),
      );
      expect(interrupted.exit._tag).toBe('Failure');
      const checkpoint = persistedForcedBuildCheckpoint(interrupted.databasePath);
      expect(checkpoint).toMatchObject({batchCount: 1, dirty: 1, state: 'building'});

      const result = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const summary = yield* indexer.index({
            cwd: root,
            force: true,
            onProgress: progress =>
              Effect.sync(() => {
                if (progress.phase === 'materializing' && progress.metrics?.storage !== undefined) {
                  storageObservations.push(progress.metrics.storage);
                }
              }),
            threadnoteHome: home,
          });
          const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
          return {
            databasePath: layout.databasePath,
            health: yield* store.diagnose(layout.databasePath),
            summary,
          };
        }),
      );

      expect(result.summary.materialization).toEqual({
        fallbackReason: 'forced-full-rebuild',
        mode: 'full',
        stagedFiles: scenario.fileCount,
        totalFiles: scenario.fileCount,
      });
      expect(result.summary.snapshot).toMatchObject({baseSnapshotId: undefined, dirty: true, state: 'ready'});
      expect(result.summary.snapshot.id).toBe(checkpoint.id);
      expect(persistedSnapshotStartedAt(result.databasePath, result.summary.snapshot.id)).toBe(checkpoint.startedAt);
      expect(persistedSnapshots(result.databasePath)).toEqual([
        {
          baseSnapshotId: Option.none(),
          dirty: 1,
          id: result.summary.snapshot.id,
          state: 'ready',
        },
      ]);
      expect(storageObservations.at(-1)).toMatchObject({
        materializationMode: 'direct-persistent',
        temporaryDatabaseBytes: 0,
        temporaryDatabaseHighWaterBytes: 0,
      });
      expect(result.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('does not reuse a completed incremental request for an explicit direct rebuild', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 61,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-completed-mode-switch-home');
    try {
      await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: root, threadnoteHome: home});
        }),
      );
      applyDirtyScenario(root, scenario);
      const result = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const incremental = yield* indexer.index({cwd: root, threadnoteHome: home});
          const direct = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: home});
          return {direct, incremental};
        }),
      );

      expect(result.incremental.materialization?.mode).toBe('incremental-overlay');
      expect(result.incremental.snapshot.baseSnapshotId).toBeDefined();
      expect(result.direct.materialization).toMatchObject({fallbackReason: 'disabled', mode: 'full'});
      expect(result.direct.snapshot.id).toMatch(/-direct$/);
      expect(result.direct.snapshot.id).not.toBe(result.incremental.snapshot.id);
      expect(result.direct.snapshot.baseSnapshotId).toBeUndefined();
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it.effect('reuses the ready logical snapshot while bounded cleanup discards an interrupted direct sibling', () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 62,
    } satisfies DifferentialScenario;
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const root = createRepository(scenario);
        return {home: join(root, '.threadnote-ready-logical-interrupted-direct-home'), root};
      }),
      ({home, root}) =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: root, threadnoteHome: home});
          yield* Effect.sync(() => applyDirtyScenario(root, scenario));
          const path = yield* Path.Path;
          const logical = yield* indexer.index({cwd: root, threadnoteHome: home});
          const layout = codeGraphLayout(path, home, logical.identity.checkoutId, logical.identity.worktreeId);
          const exit = yield* indexer
            .index({
              cwd: root,
              incrementalOverlay: false,
              onProgress: progress =>
                progress.phase === 'materializing' && (progress.metrics?.batchesCompleted ?? 0) > 0
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
          const interrupted = {databasePath: layout.databasePath, exit, logical};

          expect(interrupted.logical.materialization?.mode).toBe('incremental-overlay');
          expect(interrupted.logical.snapshot.baseSnapshotId).toBeDefined();
          expect(interrupted.exit._tag).toBe('Failure');
          const direct = persistedBuildingSnapshot(interrupted.databasePath);
          expect(direct.id).toMatch(/-direct$/);
          expect(Option.isNone(direct.baseSnapshotId)).toBe(true);
          expect(persistedSnapshotRowCount(interrupted.databasePath, direct.id, 'symbols')).toBe(0);
          expect(persistedMaterializationSpoolBatchCount(interrupted.databasePath, direct.id)).toBe(1);

          const reused = yield* indexer.index({cwd: root, threadnoteHome: home});

          expect(reused.snapshot.id).toBe(interrupted.logical.snapshot.id);
          expect(reused.materialization?.mode).toBe('reused-snapshot');
          expect(persistedSnapshotState(interrupted.databasePath, direct.id)).toBeUndefined();
          expect(persistedSnapshotRowCount(interrupted.databasePath, direct.id, 'symbols')).toBe(0);
          expect(
            persistedSnapshotRowCount(interrupted.databasePath, direct.id, 'building_materialization_batches'),
          ).toBe(0);
          expect(existsSync(materializationSpoolPath(interrupted.databasePath, direct.id))).toBe(false);
        }),
      ({root}) => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);
  });

  it('keeps the explicit overlay option inert for a clean canonical snapshot', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0]),
      dirtyTargets: [1, 0, 1],
      fileCount: 3,
      salt: 63,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-clean-mode-home');
    try {
      const result = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const explicit = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: home});
          const normal = yield* indexer.index({cwd: root, threadnoteHome: home});
          return {
            databasePath: codeGraphLayout(path, home, explicit.identity.checkoutId, explicit.identity.worktreeId)
              .databasePath,
            explicit,
            normal,
          };
        }),
      );

      expect(result.explicit.snapshot.dirty).toBe(false);
      expect(result.explicit.snapshot.id).not.toMatch(/-direct$/);
      expect(result.normal.snapshot.id).toBe(result.explicit.snapshot.id);
      expect(persistedSnapshots(result.databasePath)).toEqual([
        {
          baseSnapshotId: Option.none(),
          dirty: 0,
          id: result.explicit.snapshot.id,
          state: 'ready',
        },
      ]);
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('keeps explicit direct semantics when default and direct dirty requests overlap', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 67,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-concurrent-mode-switch-home');
    try {
      await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: root, threadnoteHome: home});
        }),
      );
      applyDirtyScenario(root, scenario);
      const result = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const [defaultRequest, directRequest] = yield* Effect.all(
            [
              indexer.index({cwd: root, threadnoteHome: home}),
              indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: home}),
            ],
            {concurrency: 2},
          );
          return {defaultRequest, directRequest};
        }),
      );

      expect(result.directRequest.snapshot.id).toMatch(/-direct$/);
      expect(result.directRequest.snapshot.baseSnapshotId).toBeUndefined();
      if (result.defaultRequest.snapshot.baseSnapshotId !== undefined) {
        expect(result.defaultRequest.snapshot.id).not.toBe(result.directRequest.snapshot.id);
      }
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it.effect('indexes the restored clean worktree while bounded cleanup discards an interrupted dirty build', () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 71,
    } satisfies DifferentialScenario;
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const root = createRepository(scenario);
        return {home: join(root, '.threadnote-dirty-to-clean-home'), root};
      }),
      ({home, root}) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => applyDirtyScenario(root, scenario));
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const identity = yield* resolveRepositoryIdentity(root);
          const exit = yield* indexer
            .index({
              cwd: root,
              incrementalOverlay: false,
              onProgress: progress =>
                progress.phase === 'materializing' && (progress.metrics?.batchesCompleted ?? 0) > 0
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
          expect(exit._tag).toBe('Failure');
          const databasePath = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId).databasePath;
          const interrupted = persistedBuildingSnapshot(databasePath);
          expect(interrupted.id).toMatch(/-direct$/);
          expect(persistedMaterializationSpoolBatchCount(databasePath, interrupted.id)).toBeGreaterThan(0);
          yield* Effect.sync(() => restoreCleanScenario(root, scenario));

          const clean = yield* indexer.index({cwd: root, threadnoteHome: home});

          expect(clean.snapshot.dirty).toBe(false);
          expect(clean.snapshot.id).not.toMatch(/-direct$/);
          expect(persistedSnapshotState(databasePath, interrupted.id)).toBeUndefined();
          expect(persistedSnapshotRowCount(databasePath, interrupted.id, 'symbols')).toBe(0);
          expect(existsSync(materializationSpoolPath(databasePath, interrupted.id))).toBe(false);
          expect(persistedSnapshots(databasePath)).toEqual([
            {
              baseSnapshotId: Option.none(),
              dirty: 0,
              id: clean.snapshot.id,
              state: 'ready',
            },
          ]);
        }),
      ({root}) => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);
  });

  it('switches an interrupted incremental overlay to the disjoint explicit direct snapshot', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 73,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-incremental-to-direct-home');
    const storageObservations: NonNullable<CodeGraphMaterializationMetrics['storage']>[] = [];
    try {
      const databasePath = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const clean = yield* indexer.index({cwd: root, threadnoteHome: home});
          return codeGraphLayout(path, home, clean.identity.checkoutId, clean.identity.worktreeId).databasePath;
        }),
      );
      applyDirtyScenario(root, scenario);
      const interrupted = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer
            .index({
              cwd: root,
              onProgress: progress =>
                progress.phase === 'materializing' &&
                progress.total === scenario.dirty.size &&
                progress.completed === progress.total
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
        }),
      );
      expect(interrupted._tag).toBe('Failure');
      const incremental = persistedBuildingSnapshot(databasePath);
      expect(Option.isSome(incremental.baseSnapshotId)).toBe(true);

      const direct = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({
            cwd: root,
            incrementalOverlay: false,
            onProgress: progress =>
              Effect.sync(() => {
                if (progress.phase === 'materializing' && progress.metrics?.storage !== undefined) {
                  storageObservations.push(progress.metrics.storage);
                }
              }),
            threadnoteHome: home,
          });
        }),
      );

      expect(direct.snapshot.id).not.toBe(incremental.id);
      expect(direct.snapshot.id).toMatch(/-direct$/);
      expect(direct.snapshot.baseSnapshotId).toBeUndefined();
      expect(persistedSnapshotState(databasePath, incremental.id)).toBeUndefined();
      expect(storageObservations.at(-1)).toMatchObject({
        materializationMode: 'direct-persistent',
        temporaryDatabaseBytes: 0,
        temporaryDatabaseHighWaterBytes: 0,
      });
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('resumes an interrupted deterministic direct snapshot when normal indexing follows', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 97,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-direct-to-default-home');
    try {
      applyDirtyScenario(root, scenario);
      const databasePath = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const identity = yield* resolveRepositoryIdentity(root);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const exit = yield* indexer
            .index({
              cwd: root,
              incrementalOverlay: false,
              onProgress: progress =>
                progress.phase === 'materializing' && (progress.metrics?.batchesCompleted ?? 0) > 0
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
          expect(exit._tag).toBe('Failure');
          return layout.databasePath;
        }),
      );
      const checkpoint = persistedBuildingSnapshot(databasePath);
      expect(checkpoint.id).toMatch(/-direct$/);
      const startedAt = persistedSnapshotStartedAt(databasePath, checkpoint.id);

      const resumed = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({cwd: root, threadnoteHome: home});
        }),
      );

      expect(resumed.materialization).toEqual({
        fallbackReason: 'staging-unavailable',
        mode: 'full',
        stagedFiles: scenario.fileCount,
        totalFiles: scenario.fileCount,
      });
      expect(resumed.snapshot.id).toBe(checkpoint.id);
      expect(persistedSnapshotStartedAt(databasePath, resumed.snapshot.id)).toBe(startedAt);
      expect(persistedSnapshots(databasePath)).toEqual([
        {
          baseSnapshotId: Option.none(),
          dirty: 1,
          id: resumed.snapshot.id,
          state: 'ready',
        },
      ]);
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });
});

function createRepository(scenario: DifferentialScenario): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-overlay-property-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  git(root, ['init', '-q']);
  for (let source = 0; source < scenario.fileCount; source += 1) {
    writeSource(root, source, scenario.baseTargets[source], scenario.fileCount, 0);
  }
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'property fixture',
  ]);
  return root;
}

function applyDirtyScenario(root: string, scenario: DifferentialScenario): void {
  for (const source of scenario.dirty) {
    writeSource(root, source, scenario.dirtyTargets[source], scenario.fileCount, scenario.salt + source + 1);
  }
}

function commitScenarioFiles(root: string, scenario: DifferentialScenario, message: string): void {
  commitPaths(
    root,
    EffectArray.map([...scenario.dirty], source => `src/file-${source}.ts`),
    message,
  );
}

function commitPaths(root: string, paths: readonly string[], message: string): void {
  git(root, ['add', ...paths]);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', message]);
}

function simpleScenario(fileCount: number): DifferentialScenario {
  const targets = Array.from({length: fileCount}, (_, source) => (source + 1) % fileCount);
  return {
    baseTargets: targets,
    dirty: new Set(),
    dirtyTargets: targets,
    fileCount,
    salt: 0,
  };
}

function writeSurfaceChangedSource(
  root: string,
  scenario: DifferentialScenario,
  source: number,
  mutation: CleanSurfaceChangeScenario['mutation'],
): void {
  const target = differentFile(scenario.baseTargets[source], source, scenario.fileCount);
  if (mutation === 'private-method') {
    writeFileSync(
      join(root, 'src', `file-${source}.ts`),
      EffectArray.join(
        [
          `import {symbol${target}} from './file-${target}.js';`,
          `class Local${source} {`,
          `  private privateValue${source}(): number { return symbol${target}(); }`,
          `  value(): number { return this.privateValue${source}(); }`,
          '}',
          `export function symbol${source}(): number { return new Local${source}().value(); }`,
          '',
        ],
        '\n',
      ),
    );
    return;
  }
  if (mutation === 'file-local-function') {
    writeFileSync(
      join(root, 'src', `file-${source}.ts`),
      EffectArray.join(
        [
          `import {symbol${target}} from './file-${target}.js';`,
          `function local${source}(): number { return symbol${target}(); }`,
          `export function symbol${source}(): number { return local${source}(); }`,
          '',
        ],
        '\n',
      ),
    );
    return;
  }
  if (mutation === 'callback-argument') {
    writeFileSync(
      join(root, 'src', `file-${source}.ts`),
      EffectArray.join(
        [
          `import {symbol${target}} from './file-${target}.js';`,
          `const callback${source} = (): number => symbol${target}();`,
          `export function symbol${source}(): number { return callback${source}(); }`,
          '',
        ],
        '\n',
      ),
    );
    return;
  }
  const exported = mutation === 'export' ? '' : 'export ';
  const name = mutation === 'rename' ? `renamed${source}` : `symbol${source}`;
  const parameters = mutation === 'arity' ? 'value: number' : '';
  writeFileSync(
    join(root, 'src', `file-${source}.ts`),
    EffectArray.join(
      [
        `import {symbol${target}} from './file-${target}.js';`,
        `${exported}function ${name}(${parameters}): number {`,
        `  return symbol${target}();`,
        '}',
        '',
      ],
      '\n',
    ),
  );
}

function restoreCleanScenario(root: string, scenario: DifferentialScenario): void {
  for (const source of scenario.dirty) {
    writeSource(root, source, scenario.baseTargets[source], scenario.fileCount, 0);
  }
}

function writeSource(root: string, source: number, rawTarget: number, fileCount: number, revision: number): void {
  const target = differentFile(rawTarget, source, fileCount);
  writeFileSync(
    join(root, 'src', `file-${source}.ts`),
    EffectArray.join(
      [
        `import {symbol${target}} from './file-${target}.js';`,
        `export function symbol${source}(): number {`,
        `  // body revision ${revision}`,
        `  return symbol${target}() + ${revision};`,
        '}',
        '',
      ],
      '\n',
    ),
  );
}

function differentFile(rawTarget: number, source: number, fileCount: number): number {
  const candidate = rawTarget % fileCount;
  return candidate === source ? (candidate + 1) % fileCount : candidate;
}

function normalizeGraph(graph: StoredCodeGraph): Pick<StoredCodeGraph, 'edges' | 'symbols'> {
  return {
    edges: [...graph.edges].sort((left, right) => compareCodeUnits(left.id, right.id)),
    symbols: [...graph.symbols].sort((left, right) => compareCodeUnits(left.id, right.id)),
  };
}

function normalizeCatalog(catalog: CodeGraphVisualizationCatalog | undefined): unknown {
  if (catalog === undefined) return undefined;
  const {activatedAt: _activatedAt, snapshot, ...stable} = catalog;
  const {baseSnapshotId: _baseSnapshotId, completedAt: _completedAt, id: _id, ...stableSnapshot} = snapshot;
  return {...stable, snapshot: stableSnapshot};
}

function normalizeQuery(result: CodeGraphQueryResult): unknown {
  return {
    edges: [...result.edges].sort((left, right) => compareCodeUnits(left.id, right.id)),
    nodes: result.nodes,
    operation: result.operation,
    warnings: result.warnings,
  };
}

function persistedSnapshots(databasePath: string): readonly {
  readonly baseSnapshotId: Option.Option<string>;
  readonly dirty: number;
  readonly id: string;
  readonly state: string;
}[] {
  const database = new Database(databasePath, {readonly: true});
  try {
    return EffectArray.map(
      database
        .query<
          {readonly baseSnapshotId: unknown; readonly dirty: number; readonly id: string; readonly state: string},
          []
        >('SELECT id, base_snapshot_id AS baseSnapshotId, dirty, state FROM snapshots ORDER BY started_at ASC, id ASC')
        .all(),
      row => ({
        ...row,
        baseSnapshotId: typeof row.baseSnapshotId === 'string' ? Option.some(row.baseSnapshotId) : Option.none(),
      }),
    );
  } finally {
    database.close();
  }
}

function persistedForcedBuildCheckpoint(databasePath: string): {
  readonly batchCount: number;
  readonly dirty: number;
  readonly id: string;
  readonly startedAt: string;
  readonly state: string;
} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const snapshot = database
      .query<{readonly dirty: number; readonly id: string; readonly startedAt: string; readonly state: string}, []>(
        "SELECT id, dirty, started_at AS startedAt, state FROM snapshots WHERE state = 'building' ORDER BY started_at, id",
      )
      .get();
    if (snapshot === null)
      throw TestError.make({message: 'Interrupted forced build did not preserve its building snapshot.'});
    return {...snapshot, batchCount: persistedMaterializationSpoolBatchCount(databasePath, snapshot.id)};
  } finally {
    database.close();
  }
}

function materializationSpoolPath(databasePath: string, snapshotId: string): string {
  return join(dirname(databasePath), `materialization-spool-v2-${snapshotId}.sqlite`);
}

function persistedMaterializationSpoolBatchCount(databasePath: string, snapshotId: string): number {
  const spool = new Database(materializationSpoolPath(databasePath, snapshotId), {readonly: true});
  try {
    return Number(
      spool.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM materialization_spool_batches').get()
        ?.count ?? 0,
    );
  } finally {
    spool.close();
  }
}

function persistedBuildingSnapshot(databasePath: string): {
  readonly baseSnapshotId: Option.Option<string>;
  readonly id: string;
} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const snapshot = database
      .query<{readonly baseSnapshotId: unknown; readonly id: string}, []>(
        "SELECT id, base_snapshot_id AS baseSnapshotId FROM snapshots WHERE state = 'building' ORDER BY started_at, id LIMIT 1",
      )
      .get();
    if (snapshot === null) throw TestError.make({message: 'Interrupted build did not preserve its building snapshot.'});
    return {
      ...snapshot,
      baseSnapshotId:
        typeof snapshot.baseSnapshotId === 'string' ? Option.some(snapshot.baseSnapshotId) : Option.none(),
    };
  } finally {
    database.close();
  }
}

function persistedSnapshotState(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true});
  try {
    return database
      .query<{readonly state: string}, [string]>('SELECT state FROM snapshots WHERE id = ?')
      .get(snapshotId)?.state;
  } finally {
    database.close();
  }
}

function persistedSnapshotStartedAt(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true});
  try {
    return database
      .query<{readonly startedAt: string}, [string]>('SELECT started_at AS startedAt FROM snapshots WHERE id = ?')
      .get(snapshotId)?.startedAt;
  } finally {
    database.close();
  }
}

function persistedSnapshotRowCount(
  databasePath: string,
  snapshotId: string,
  table: 'building_materialization_batches' | 'symbols',
): number {
  const database = new Database(databasePath, {readonly: true});
  try {
    return Number(
      database
        .query<{readonly count: number}, [string]>(`SELECT COUNT(*) AS count FROM ${table} WHERE snapshot_id = ?`)
        .get(snapshotId)?.count ?? 0,
    );
  } finally {
    database.close();
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
