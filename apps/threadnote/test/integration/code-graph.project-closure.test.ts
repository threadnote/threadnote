import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {Effect, Path} from 'effect';
import {CodeGraphIndexer, graphContentIdentity} from '@threadnote/graph/indexer';
import {serializeBoundedCodeGraphFact} from '@threadnote/graph/fact/budget';
import {decodeStoredCodeGraphFact, encodeStoredCodeGraphFact} from '@threadnote/graph/fact/storage';
import {inventoryRepository} from '@threadnote/graph/inventory';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {
  CodeGraphStore,
  materializedShardDerivationIdentity,
  type CodeGraphVisualizationCatalog,
  type StoredCodeGraph,
} from '@threadnote/graph/store';
import type {CodeGraphQueryResult} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('project-closure incremental indexing', () => {
  it.effect('publishes current workspace dependencies when a manifest and source change together', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const incrementalHome = join(root, '.threadnote-incremental');
          const fullHome = join(root, '.threadnote-full');
          const base = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          yield* Effect.sync(() => {
            write(root, 'packages/barrel/package.json', {
              dependencies: {
                '@fixture/core': 'workspace:*',
                '@fixture/other': 'workspace:*',
                '@fixture/unrelated': 'workspace:*',
              },
              name: '@fixture/barrel',
            });
            redirectBarrel(root);
          });
          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
          const incrementalPath = codeGraphLayout(
            path,
            incrementalHome,
            base.identity.checkoutId,
            base.identity.worktreeId,
          ).databasePath;
          const fullPath = codeGraphLayout(
            path,
            fullHome,
            full.identity.checkoutId,
            full.identity.worktreeId,
          ).databasePath;
          expect(incremental.materialization?.mode).toBe('incremental-overlay');
          expect(workspaceCatalogRows(incrementalPath, incremental.snapshot.id)).toEqual(
            workspaceCatalogRows(fullPath, full.snapshot.id),
          );
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('reattributes the exact reverse-dependent project closure when a barrel redirects', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const path = yield* Path.Path;
          const incrementalHome = join(root, '.threadnote-incremental');
          const fullHome = join(root, '.threadnote-full');
          const base = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          expect(base.materialization?.mode).toBe('full');

          yield* Effect.sync(() => redirectBarrel(root));
          const incrementalLayout = codeGraphLayout(
            path,
            incrementalHome,
            base.identity.checkoutId,
            base.identity.worktreeId,
          );
          const currentIdentity = yield* resolveRepositoryIdentity(root);
          const currentInventory = yield* inventoryRepository(currentIdentity, {includeOverlay: true});
          const currentBarrel = EffectOption.getOrUndefined(
            EffectArray.findFirst(currentInventory.files, file => file.path === 'packages/barrel/index.ts'),
          )!;
          const receipt = yield* store.reusableBaseReceipt(incrementalLayout.databasePath, base.snapshot.id);
          expect(receipt).toBeDefined();
          const poisonDerivation = materializedShardDerivationIdentity(
            base.snapshot.extractorSet,
            receipt!.workspaceFingerprint,
            base.snapshot.graphContentId ?? base.snapshot.id,
          );
          const currentDerivation = materializedShardDerivationIdentity(
            base.snapshot.extractorSet,
            receipt!.workspaceFingerprint,
            graphContentIdentity(base.snapshot.extractorSet, currentInventory.files),
          );
          expect(currentDerivation).not.toBe(poisonDerivation);
          yield* store.cacheMaterializedFileShards(
            incrementalLayout.databasePath,
            [currentBarrel],
            [
              {
                diagnostics: ['poisoned final shard'],
                edges: [],
                path: currentBarrel.path,
                references: [],
                symbols: [],
              },
            ],
            base.snapshot.extractorSet,
            poisonDerivation,
            (_boundary, transaction) => transaction,
          );
          expect(
            (yield* store.loadMaterializedFileShards(
              incrementalLayout.databasePath,
              [currentBarrel],
              base.snapshot.extractorSet,
              poisonDerivation,
            )).facts.get(currentBarrel.path)?.diagnostics,
          ).toEqual(['poisoned final shard']);
          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({
            cwd: root,
            incrementalOverlay: false,
            threadnoteHome: fullHome,
          });
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
          const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
          const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);
          const incrementalHealth = yield* store.diagnose(incrementalLayout.databasePath);
          const fullHealth = yield* store.diagnose(fullLayout.databasePath);
          const incrementalCatalog = yield* store.loadVisualizationCatalog(incrementalLayout.databasePath);
          const fullCatalog = yield* store.loadVisualizationCatalog(fullLayout.databasePath);

          expect(incremental.materialization).toEqual({
            closureProjects: 2,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
            stagedFiles: 4,
            totalFiles: 11,
          });
          expect(incremental.incrementalWork).toMatchObject({
            baseFactsLoaded: 4,
            changedFiles: 4,
            inventoryFilesInspected: 4,
            totalFiles: 11,
          });
          expect(incremental.diagnostics).toContain(
            'Reused persisted clean inventory admission for 1 changed path(s) without hydrating the complete base.',
          );
          expect(incremental.diagnostics).not.toContain('poisoned final shard');
          expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
          expect(normalizeCatalog(incrementalCatalog)).toEqual(normalizeCatalog(fullCatalog));
          expect(incrementalHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
          expect(fullHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
          const other = EffectOption.getOrUndefined(
            EffectArray.findFirst(incrementalGraph.symbols, symbol => symbol.name === 'other'),
          );
          expect(other).toBeDefined();
          expect(
            EffectArray.some(
              incrementalGraph.edges,
              edge => edge.sourceName === 'consume' && edge.relation === 'calls' && edge.targetId === other?.id,
            ),
          ).toBe(true);
          expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual([
            'packages/app/index.ts',
            'packages/app/package.json',
            'packages/barrel/index.ts',
            'packages/barrel/package.json',
          ]);
          // The old full-graph shard is neither consumed nor eligible for the
          // current graph-content identity. It remains protected by the fresh
          // pre-claim grace until later routine reclamation.
          expect(
            (yield* store.loadMaterializedFileShards(
              incrementalLayout.databasePath,
              [currentBarrel],
              base.snapshot.extractorSet,
              poisonDerivation,
            )).facts.get(currentBarrel.path)?.diagnostics,
          ).toEqual(['poisoned final shard']);
          expect(
            (yield* store.loadMaterializedFileShards(
              incrementalLayout.databasePath,
              [currentBarrel],
              base.snapshot.extractorSet,
              currentDerivation,
            )).facts.get(currentBarrel.path),
          ).toBeUndefined();
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('uses the same project closure from a nearby persisted clean base', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const path = yield* Path.Path;
          const incrementalHome = join(root, '.threadnote-clean-incremental');
          const fullHome = join(root, '.threadnote-clean-full');
          yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          yield* Effect.sync(() => {
            redirectBarrel(root);
            git(root, ['add', 'packages/barrel/index.ts']);
            git(root, ['commit', '-qm', 'redirect barrel']);
          });

          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({
            cwd: root,
            incrementalOverlay: false,
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

          expect(incremental.materialization).toEqual({
            closureProjects: 2,
            mode: 'incremental-clean',
            resolutionClosure: 'project',
            stagedFiles: 4,
            totalFiles: 11,
          });
          expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
          expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual([
            'packages/app/index.ts',
            'packages/app/package.json',
            'packages/barrel/index.ts',
            'packages/barrel/package.json',
          ]);
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('ignores overlapping TypeScript config ownership outside the package resolver closure', () =>
    Effect.acquireUseRelease(
      Effect.sync(() => createProjectClosureRepository({overlappingTypeScriptConfigs: true})),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const incrementalHome = join(root, '.threadnote-overlap-incremental');
          const fullHome = join(root, '.threadnote-overlap-full');
          yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          yield* Effect.sync(() => redirectBarrel(root));

          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
          const incrementalLayout = codeGraphLayout(
            path,
            incrementalHome,
            incremental.identity.checkoutId,
            incremental.identity.worktreeId,
          );
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);

          expect(incremental.materialization).toMatchObject({
            closureProjects: 2,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
            stagedFiles: 4,
          });
          expect(incremental.materialization?.fallbackReason).toBeUndefined();
          expect(
            normalizeGraph(yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id)),
          ).toEqual(normalizeGraph(yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id)));
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('keeps unchanged static re-export resolution local despite an unrelated incomplete project model', () =>
    Effect.forEach(
      ['dirty', 'clean'] as const,
      mode =>
        Effect.acquireUseRelease(
          Effect.sync(() => createProjectClosureRepository({orphanProjectBoundary: true})),
          root =>
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const store = yield* CodeGraphStore;
              const incrementalHome = join(root, `.threadnote-span-${mode}-incremental`);
              const fullHome = join(root, `.threadnote-span-${mode}-full`);
              yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              yield* Effect.sync(() => {
                writeFile(
                  root,
                  'packages/barrel/index.ts',
                  EffectArray.join(
                    [
                      '// presentation-only edit',
                      '// shifts the evidence span without changing resolver input',
                      'export {real as foo} from "../core/index.js";',
                      '',
                    ],
                    '\n',
                  ),
                );
                if (mode === 'clean') {
                  git(root, ['add', 'packages/barrel/index.ts']);
                  git(root, ['commit', '-qm', 'move reexport span']);
                }
              });

              const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              const full = yield* indexer.index({
                cwd: root,
                incrementalOverlay: false,
                threadnoteHome: fullHome,
              });
              const incrementalLayout = codeGraphLayout(
                path,
                incrementalHome,
                incremental.identity.checkoutId,
                incremental.identity.worktreeId,
              );
              const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);

              expect(incremental.materialization).toMatchObject({
                mode: mode === 'dirty' ? 'incremental-overlay' : 'incremental-clean',
                stagedFiles: 1,
              });
              expect(incremental.materialization?.fallbackReason).toBeUndefined();
              expect(incremental.materialization?.totalFiles).toBeGreaterThan(1);
              expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual([
                'packages/barrel/index.ts',
              ]);
              expect(
                normalizeGraph(yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id)),
              ).toEqual(normalizeGraph(yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id)));
            }),
          root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
        ),
      {concurrency: 1},
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('uses bounded project closure when a declared TypeScript project adds an export', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const incrementalHome = join(root, '.threadnote-added-export-incremental');
          const fullHome = join(root, '.threadnote-added-export-full');
          const base = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          expect(base.snapshot).toMatchObject({dirty: false, state: 'ready'});

          yield* Effect.sync(() => {
            writeFile(
              root,
              'packages/core/index.ts',
              'export function real() { return "real"; }\nexport function newlyPublished() { return "new"; }\n',
            );
          });
          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({
            cwd: root,
            incrementalOverlay: false,
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

          expect(incremental.materialization).toEqual({
            closureProjects: 3,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
            resolutionLookupKeyForm: 'typescript-path-scoped',
            resolutionPublicationGate: 'exported',
            stagedFiles: 6,
            totalFiles: 11,
          });
          expect(incremental.incrementalWork).toMatchObject({
            baseFactsLoaded: 6,
            changedFiles: 6,
            inventoryFilesInspected: 6,
            totalFiles: 11,
          });
          expect(incremental.diagnostics).toContain(
            'Reused persisted clean inventory admission for 1 changed path(s) without hydrating the complete base.',
          );
          expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
          expect(EffectArray.some(incrementalGraph.symbols, symbol => symbol.name === 'newlyPublished')).toBe(true);
          expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual([
            'packages/app/index.ts',
            'packages/app/package.json',
            'packages/barrel/index.ts',
            'packages/barrel/package.json',
            'packages/core/index.ts',
            'packages/core/package.json',
          ]);
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('reparses and replaces a valid cache tuple whose payload names another path', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const home = join(root, '.threadnote-cache-path-healing');
          const base = yield* indexer.index({cwd: root, threadnoteHome: home});
          const layout = codeGraphLayout(path, home, base.identity.checkoutId, base.identity.worktreeId);
          const baseBarrelHash = snapshotFileContentHash(
            layout.databasePath,
            base.snapshot.id,
            'packages/barrel/index.ts',
          );
          yield* Effect.sync(() => {
            corruptCachedFactPath(layout.databasePath, baseBarrelHash);
            redirectBarrel(root);
          });
          const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});

          expect(indexed.materialization).toMatchObject({
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
          });
          expect(cachedFactPayloadPaths(layout.databasePath, baseBarrelHash)).toEqual(['packages/barrel/index.ts']);
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('materializes an exact project closure beyond the former aggregate fact ceiling', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const path = yield* Path.Path;
          const incrementalHome = join(root, '.threadnote-expanded-facts-incremental');
          const fullHome = join(root, '.threadnote-expanded-facts-full');
          const base = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const incrementalLayout = codeGraphLayout(
            path,
            incrementalHome,
            base.identity.checkoutId,
            base.identity.worktreeId,
          );
          const inflatedHashes = EffectArray.map(
            ['packages/app/index.ts', 'packages/app/package.json', 'packages/barrel/package.json'],
            value => snapshotFileContentHash(incrementalLayout.databasePath, base.snapshot.id, value),
          );
          yield* Effect.sync(() => {
            inflateCachedFacts(incrementalLayout.databasePath, inflatedHashes, 7 * 1_048_576);
            redirectBarrel(root);
          });

          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);

          expect(incremental.materialization).toMatchObject({
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
          });
          expect(incremental.incrementalWork?.factBytes).toBeGreaterThan(16 * 1_048_576);
          expect(incremental.incrementalWork?.factBytes).toBeLessThanOrEqual(32 * 1_048_576);
          expect(
            normalizeGraph(yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id)),
          ).toEqual(normalizeGraph(yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id)));
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('falls back through bounded full materialization for cache and receipt loss or oversized facts', () =>
    Effect.forEach(
      [
        {reason: 'cache-incomplete' as const, scenario: 'missing' as const},
        {reason: 'project-closure-unbounded' as const, scenario: 'oversized' as const},
        {reason: 'staging-unavailable' as const, scenario: 'receipt' as const},
      ],
      ({reason, scenario}) =>
        Effect.acquireUseRelease(
          Effect.sync(createProjectClosureRepository),
          root =>
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const home = join(root, `.threadnote-${scenario}-cache`);
              const base = yield* indexer.index({cwd: root, threadnoteHome: home});
              const layout = codeGraphLayout(path, home, base.identity.checkoutId, base.identity.worktreeId);
              const baseBarrelHash = snapshotFileContentHash(
                layout.databasePath,
                base.snapshot.id,
                'packages/barrel/index.ts',
              );
              let removedAfterPersistence = false;
              yield* Effect.sync(() => {
                mutateBarrelCache(layout.databasePath, scenario);
                redirectBarrel(root);
              });
              const indexed = yield* indexer.index({
                cwd: root,
                onProgress: progress =>
                  scenario === 'missing' &&
                  !removedAfterPersistence &&
                  progress.phase === 'scanning' &&
                  progress.activity?.stage === 'persisting' &&
                  progress.activity.batchCompleted === progress.activity.batchTotal
                    ? Effect.sync(() => {
                        deleteCachedContentHash(layout.databasePath, baseBarrelHash);
                        removedAfterPersistence = true;
                      })
                    : Effect.void,
                threadnoteHome: home,
              });

              expect(indexed.materialization).toMatchObject({fallbackReason: reason, mode: 'full'});
              expect(indexed.materialization?.stagedFiles).toBe(indexed.materialization?.totalFiles);
              if (scenario === 'missing') expect(removedAfterPersistence).toBe(true);
              if (scenario === 'oversized') {
                expect(indexed.materialization?.fallbackBoundary).toMatchObject({
                  changedFiles: 1,
                  limit: 8 * 1_048_576,
                  metric: 'cached-fact-bytes',
                  stage: 'project-closure-selection',
                });
                expect(indexed.materialization?.fallbackBoundary?.observedAtDecision).toBeGreaterThan(8 * 1_048_576);
              }
            }),
          root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
        ),
      {concurrency: 1},
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('incrementally materializes bounded project closures for add, delete, and rename file-set changes', () =>
    Effect.forEach(
      [
        {
          deltaPaths: [
            'packages/app/index.ts',
            'packages/app/package.json',
            'packages/barrel/extra.ts',
            'packages/barrel/index.ts',
            'packages/barrel/package.json',
          ],
          mutate: (root: string) => writeFile(root, 'packages/barrel/extra.ts', 'export const extra = true;\n'),
          stagedFiles: 5,
          totalFiles: 12,
        },
        {
          deltaPaths: ['packages/app/index.ts', 'packages/app/package.json', 'packages/barrel/package.json'],
          mutate: (root: string) => rmSync(join(root, 'packages/barrel/index.ts')),
          stagedFiles: 3,
          totalFiles: 10,
        },
        {
          deltaPaths: [
            'packages/app/index.ts',
            'packages/app/package.json',
            'packages/barrel/package.json',
            'packages/barrel/renamed.ts',
          ],
          mutate: (root: string) =>
            renameSync(join(root, 'packages/barrel/index.ts'), join(root, 'packages/barrel/renamed.ts')),
          stagedFiles: 4,
          totalFiles: 11,
        },
      ],
      scenario =>
        Effect.acquireUseRelease(
          Effect.sync(createProjectClosureRepository),
          root =>
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const store = yield* CodeGraphStore;
              const incrementalHome = join(root, '.threadnote-file-set-incremental');
              const fullHome = join(root, '.threadnote-file-set-full');
              yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              yield* Effect.sync(() => scenario.mutate(root));
              const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              const full = yield* indexer.index({
                cwd: root,
                incrementalOverlay: false,
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

              expect(incremental.materialization).toEqual({
                closureProjects: 2,
                mode: 'incremental-overlay',
                resolutionClosure: 'project',
                stagedFiles: scenario.stagedFiles,
                totalFiles: scenario.totalFiles,
              });
              expect(incremental.snapshot.graphContentId).toBe(full.snapshot.graphContentId);
              expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
              expect(normalizeCatalog(yield* store.loadVisualizationCatalog(incrementalLayout.databasePath))).toEqual(
                normalizeCatalog(yield* store.loadVisualizationCatalog(fullLayout.databasePath)),
              );
              expect(yield* store.diagnose(incrementalLayout.databasePath)).toMatchObject({
                foreignKeyViolations: 0,
                integrity: 'ok',
              });
              expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual(scenario.deltaPaths);
            }),
          root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
        ),
      {concurrency: 1},
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('uses bounded project closures after committed add, delete, and rename file-set changes', () =>
    Effect.forEach(
      [
        {
          label: 'add',
          mutate: (root: string) => writeFile(root, 'packages/barrel/extra.ts', 'export const extra = true;\n'),
          stagedFiles: 5,
          totalFiles: 12,
        },
        {
          label: 'delete',
          mutate: (root: string) => rmSync(join(root, 'packages/barrel/index.ts')),
          stagedFiles: 3,
          totalFiles: 10,
        },
        {
          label: 'rename',
          mutate: (root: string) =>
            renameSync(join(root, 'packages/barrel/index.ts'), join(root, 'packages/barrel/renamed.ts')),
          stagedFiles: 4,
          totalFiles: 11,
        },
      ],
      scenario =>
        Effect.acquireUseRelease(
          Effect.sync(createProjectClosureRepository),
          root =>
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const store = yield* CodeGraphStore;
              const incrementalHome = join(root, '.threadnote-clean-file-set-incremental');
              const fullHome = join(root, '.threadnote-clean-file-set-full');
              yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              yield* Effect.sync(() => {
                scenario.mutate(root);
                git(root, ['add', '-A']);
                git(root, ['commit', '-qm', `${scenario.label} barrel source`]);
              });
              const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
              const incrementalLayout = codeGraphLayout(
                path,
                incrementalHome,
                incremental.identity.checkoutId,
                incremental.identity.worktreeId,
              );
              const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);

              expect(incremental.materialization).toEqual({
                closureProjects: 2,
                mode: 'incremental-clean',
                resolutionClosure: 'project',
                stagedFiles: scenario.stagedFiles,
                totalFiles: scenario.totalFiles,
              });
              expect(
                normalizeGraph(yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id)),
              ).toEqual(normalizeGraph(yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id)));
            }),
          root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
        ),
      {concurrency: 1},
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('fails closed for unreconciled workspace changes', () =>
    Effect.forEach(
      [
        {
          create: () => createProjectClosureRepository({orphanProjectBoundary: true}),
          mutate: redirectBarrel,
          reason: 'project-closure-incomplete' as const,
        },
      ],
      scenario =>
        Effect.acquireUseRelease(
          Effect.sync(scenario.create),
          root =>
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const home = join(root, `.threadnote-${scenario.reason}`);
              yield* indexer.index({cwd: root, threadnoteHome: home});
              yield* Effect.sync(() => scenario.mutate(root));
              const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});

              expect(indexed.materialization).toMatchObject({fallbackReason: scenario.reason, mode: 'full'});
              expect(indexed.materialization?.stagedFiles).toBe(indexed.materialization?.totalFiles);
            }),
          root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
        ),
      {concurrency: 1},
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect(
    'candidate-scans existing Markdown heading additions, removals, renames, and ambiguity transitions',
    () =>
      Effect.acquireUseRelease(
        Effect.sync(createLargeRootProjectRepository),
        root =>
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            const path = yield* Path.Path;
            const store = yield* CodeGraphStore;
            const incrementalHome = join(root, '.threadnote-document-candidate-incremental');
            const fullHome = join(root, '.threadnote-document-candidate-full');
            yield* Effect.sync(() => {
              writeFile(root, 'docs/surface.md', '# Retiring\n\n# Renaming\n');
              writeFile(root, 'docs/existing.md', '# Collision\n');
              writeFile(root, 'docs/consumer-retiring.md', '`Retiring`\n');
              writeFile(root, 'docs/consumer-added.md', '`Added`\n');
              writeFile(root, 'docs/consumer-renaming-old.md', '`Renaming`\n');
              writeFile(root, 'docs/consumer-renaming-new.md', '`Renamed`\n');
              writeFile(root, 'docs/consumer-collision.md', '`Collision`\n');
              git(root, ['add', 'docs']);
              git(root, ['commit', '-qm', 'add documentation resolution fixture']);
            });
            const base = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            const incrementalLayout = codeGraphLayout(
              path,
              incrementalHome,
              base.identity.checkoutId,
              base.identity.worktreeId,
            );
            const baseGraph = yield* store.loadGraph(incrementalLayout.databasePath, base.snapshot.id);
            expect(documentEdge(baseGraph, 'docs/consumer-retiring.md', 'Retiring')?.targetId).toBeDefined();
            expect(documentEdge(baseGraph, 'docs/consumer-added.md', 'Added')?.targetId).toBeUndefined();
            expect(documentEdge(baseGraph, 'docs/consumer-renaming-old.md', 'Renaming')?.targetId).toBeDefined();
            expect(documentEdge(baseGraph, 'docs/consumer-renaming-new.md', 'Renamed')?.targetId).toBeUndefined();
            expect(documentEdge(baseGraph, 'docs/consumer-collision.md', 'Collision')?.targetId).toBeDefined();

            yield* Effect.sync(() => {
              writeFile(root, 'docs/surface.md', '# Added\n\n# Renamed\n\n# Collision\n');
              git(root, ['add', 'docs/surface.md']);
              git(root, ['commit', '-qm', 'change documentation publication surface']);
            });
            const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
            const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
            const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
            const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);

            expect(base.materialization?.totalFiles).toBeGreaterThan(128);
            expect(incremental.materialization).toMatchObject({
              closureProjects: 0,
              mode: 'incremental-clean',
              resolutionClosure: 'project',
              resolutionLookupKeyForm: 'non-typescript',
              resolutionPublicationGate: 'exported',
              stagedFiles: 6,
            });
            expect(incremental.materialization?.stagedFiles).toBeLessThan(incremental.materialization?.totalFiles ?? 0);
            expect(incremental.incrementalWork).toMatchObject({baseFactsLoaded: 6, changedFiles: 6});
            expect(incremental.incrementalWork?.attributionContextFiles).toBe(base.materialization?.totalFiles ?? 0);
            expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
            expect(documentEdge(incrementalGraph, 'docs/consumer-retiring.md', 'Retiring')?.targetId).toBeUndefined();
            expect(documentEdge(incrementalGraph, 'docs/consumer-added.md', 'Added')?.targetId).toBeDefined();
            expect(
              documentEdge(incrementalGraph, 'docs/consumer-renaming-old.md', 'Renaming')?.targetId,
            ).toBeUndefined();
            expect(documentEdge(incrementalGraph, 'docs/consumer-renaming-new.md', 'Renamed')?.targetId).toBeDefined();
            expect(documentEdge(incrementalGraph, 'docs/consumer-collision.md', 'Collision')?.targetId).toBeUndefined();
            expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual([
              'docs/consumer-added.md',
              'docs/consumer-collision.md',
              'docs/consumer-renaming-new.md',
              'docs/consumer-renaming-old.md',
              'docs/consumer-retiring.md',
              'docs/surface.md',
            ]);
            expect(yield* store.diagnose(incrementalLayout.databasePath)).toMatchObject({
              foreignKeyViolations: 0,
              integrity: 'ok',
            });
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 120_000},
  );

  it.effect('keeps a stable unowned-domain modification local during an owned file-set closure', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const home = join(root, '.threadnote-file-set-hybrid');
          const fullHome = join(root, '.threadnote-file-set-hybrid-full');
          yield* Effect.sync(() => {
            writeFile(root, 'README.md', '# Fixture\n');
            git(root, ['add', 'README.md']);
            git(root, ['commit', '-qm', 'add documentation']);
          });
          yield* indexer.index({cwd: root, threadnoteHome: home});

          yield* Effect.sync(() => {
            writeFile(root, 'README.md', '# Fixture\n\nUpdated local documentation body.\n');
            writeFile(root, 'packages/core/added.ts', 'export function added() { return "added"; }\n');
          });
          yield* Effect.sync(() => {
            git(root, ['add', 'README.md', 'packages/core/added.ts']);
            git(root, ['commit', '-qm', 'mixed file-set transition']);
          });
          const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
          const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
          const incrementalLayout = codeGraphLayout(
            path,
            home,
            indexed.identity.checkoutId,
            indexed.identity.worktreeId,
          );
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);

          expect(indexed.materialization).toEqual({
            closureProjects: 3,
            mode: 'incremental-clean',
            resolutionClosure: 'project',
            stagedFiles: 8,
            totalFiles: 13,
          });
          expect(indexed.reusedFiles).toBe(11);
          expect(normalizeGraph(yield* store.loadGraph(incrementalLayout.databasePath, indexed.snapshot.id))).toEqual(
            normalizeGraph(yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id)),
          );
          expect(normalizeCatalog(yield* store.loadVisualizationCatalog(incrementalLayout.databasePath))).toEqual(
            normalizeCatalog(yield* store.loadVisualizationCatalog(fullLayout.databasePath)),
          );
          expect(yield* store.diagnose(incrementalLayout.databasePath)).toMatchObject({
            foreignKeyViolations: 0,
            integrity: 'ok',
          });
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('keeps the owned closure while scanning an existing unowned-domain publication change', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const path = yield* Path.Path;
          const home = join(root, '.threadnote-file-set-changed-publication');
          const fullHome = join(root, '.threadnote-file-set-changed-publication-full');
          yield* Effect.sync(() => {
            writeFile(root, 'README.md', '# Fixture\n');
            git(root, ['add', 'README.md']);
            git(root, ['commit', '-qm', 'add documentation']);
          });
          yield* indexer.index({cwd: root, threadnoteHome: home});

          yield* Effect.sync(() => {
            writeFile(root, 'README.md', '# Renamed fixture\n');
            writeFile(root, 'packages/core/added.ts', 'export function added() { return "added"; }\n');
          });
          const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
          const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});

          expect(indexed.materialization).toMatchObject({
            closureProjects: 3,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
          });
          expect(indexed.materialization?.stagedFiles).toBeLessThan(indexed.materialization?.totalFiles ?? 0);
          const incrementalLayout = codeGraphLayout(
            path,
            home,
            indexed.identity.checkoutId,
            indexed.identity.worktreeId,
          );
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
          expect(normalizeGraph(yield* store.loadGraph(incrementalLayout.databasePath, indexed.snapshot.id))).toEqual(
            normalizeGraph(yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id)),
          );
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect(
    'uses a bounded candidate scan for an owned addition beside stable documentation in a large project',
    () =>
      Effect.acquireUseRelease(
        Effect.sync(createLargeRootProjectRepository),
        root =>
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            const path = yield* Path.Path;
            const store = yield* CodeGraphStore;
            const incrementalHome = join(root, '.threadnote-file-set-candidate');
            const fullHome = join(root, '.threadnote-file-set-candidate-full');
            yield* Effect.sync(() => {
              writeFile(root, 'README.md', '# Fixture\n');
              writeFile(
                root,
                'src/pending.ts',
                'import {added} from "./added.js";\nexport function pending() { return added(); }\n',
              );
              git(root, ['add', 'README.md', 'src/pending.ts']);
              git(root, ['commit', '-qm', 'add unresolved consumer']);
            });
            const base = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});

            yield* Effect.sync(() => {
              writeFile(root, 'README.md', '# Fixture\n\nUpdated local documentation body.\n');
              writeFile(root, 'src/added.ts', 'export function added() { return 1; }\n');
              git(root, ['add', 'README.md', 'src/added.ts']);
              git(root, ['commit', '-qm', 'add resolved source']);
            });
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

            expect(base.materialization?.totalFiles).toBeGreaterThan(128);
            expect(incremental.materialization).toMatchObject({
              closureProjects: 1,
              mode: 'incremental-clean',
              resolutionClosure: 'project',
            });
            expect(incremental.materialization?.stagedFiles).toBeLessThan(incremental.materialization?.totalFiles ?? 0);
            expect(incremental.incrementalWork?.baseFactsLoaded).toBe(incremental.materialization?.stagedFiles);
            expect(incremental.incrementalWork?.changedFiles).toBe(incremental.materialization?.stagedFiles);
            expect(incremental.incrementalWork?.attributionContextFiles).toBe(base.materialization?.totalFiles ?? 0);
            expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
            const added = EffectOption.getOrUndefined(
              EffectArray.findFirst(incrementalGraph.symbols, symbol => symbol.name === 'added'),
            );
            expect(added).toBeDefined();
            expect(
              EffectArray.some(
                incrementalGraph.edges,
                edge => edge.sourceName === 'pending' && edge.relation === 'calls' && edge.targetId === added?.id,
              ),
            ).toBe(true);
            expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual(
              expect.arrayContaining(['README.md', 'src/added.ts', 'src/pending.ts']),
            );
            expect(yield* store.diagnose(incrementalLayout.databasePath)).toMatchObject({
              foreignKeyViolations: 0,
              integrity: 'ok',
            });
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 120_000},
  );

  it.effect('uses a bounded candidate closure for an unowned-domain document rename', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const path = yield* Path.Path;
          const home = join(root, '.threadnote-file-set-fallback-detail');
          const fullHome = join(root, '.threadnote-file-set-full');
          yield* Effect.sync(() => {
            writeFile(root, 'README.md', '# Existing documentation\n');
            git(root, ['add', 'README.md']);
            git(root, ['commit', '-qm', 'add existing documentation']);
          });
          yield* indexer.index({cwd: root, threadnoteHome: home});
          yield* Effect.sync(() => {
            rmSync(join(root, 'README.md'));
            writeFile(root, 'NEW.md', '# Added documentation\n');
          });
          const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
          const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});

          expect(indexed.materialization).toMatchObject({
            closureProjects: 0,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
          });
          expect(indexed.materialization?.stagedFiles).toBeLessThan(indexed.materialization?.totalFiles ?? 0);
          const incrementalLayout = codeGraphLayout(
            path,
            home,
            indexed.identity.checkoutId,
            indexed.identity.worktreeId,
          );
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
          expect(normalizeGraph(yield* store.loadGraph(incrementalLayout.databasePath, indexed.snapshot.id))).toEqual(
            normalizeGraph(yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id)),
          );
          expect(deltaPaths(incrementalLayout.databasePath, indexed.snapshot.id)).toEqual(['NEW.md']);
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect(
    'keeps zero-publication Swift and Bash file-set changes incremental',
    () =>
      Effect.forEach(
        [
          {extension: 'swift', language: 'Swift', operation: 'add'},
          {extension: 'swift', language: 'Swift', operation: 'delete'},
          {extension: 'swift', language: 'Swift', operation: 'rename'},
          {extension: 'sh', language: 'Bash', operation: 'add'},
          {extension: 'sh', language: 'Bash', operation: 'delete'},
          {extension: 'sh', language: 'Bash', operation: 'rename'},
        ] as const,
        scenario =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const root = createProjectClosureRepository();
              writeFile(root, `scripts/existing.${scenario.extension}`, '// no published symbols\n');
              if (scenario.operation !== 'add') {
                writeFile(root, `scripts/retiring.${scenario.extension}`, '// no published symbols\n');
              }
              git(root, ['add', 'scripts']);
              git(root, ['commit', '-qm', `add ${scenario.language} fixture`]);
              return root;
            }),
            root =>
              Effect.gen(function* () {
                const indexer = yield* CodeGraphIndexer;
                const path = yield* Path.Path;
                const store = yield* CodeGraphStore;
                const home = join(
                  root,
                  `.threadnote-${Effect2.pipe(scenario.language, EffectString.toLowerCase)}-${scenario.operation}`,
                );
                const fullHome = `${home}-full`;
                yield* indexer.index({cwd: root, threadnoteHome: home});
                yield* Effect.sync(() => {
                  if (scenario.operation !== 'delete') {
                    writeFile(root, `scripts/current.${scenario.extension}`, '// no published symbols\n');
                  }
                  if (scenario.operation !== 'add') rmSync(join(root, `scripts/retiring.${scenario.extension}`));
                });
                const incremental = yield* indexer.index({cwd: root, threadnoteHome: home});
                const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
                const incrementalLayout = codeGraphLayout(
                  path,
                  home,
                  incremental.identity.checkoutId,
                  incremental.identity.worktreeId,
                );
                const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);

                expect(incremental.materialization?.fallbackReason).toBeUndefined();
                expect(incremental.materialization).toMatchObject({
                  closureProjects: 0,
                  mode: 'incremental-overlay',
                  resolutionClosure: 'project',
                });
                expect(
                  normalizeGraph(yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id)),
                ).toEqual(normalizeGraph(yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id)));
              }),
            root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
          ),
        {concurrency: 1},
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 120_000},
  );

  it.effect(
    'reports an exact typed fallback when outside-closure base provenance exceeds 10,000 rows',
    () =>
      Effect.acquireUseRelease(
        Effect.sync(createProjectClosureRepository),
        root =>
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            const path = yield* Path.Path;
            const home = join(root, '.threadnote-reexport-overflow');
            const base = yield* indexer.index({cwd: root, threadnoteHome: home});
            const layout = codeGraphLayout(path, home, base.identity.checkoutId, base.identity.worktreeId);
            yield* Effect.sync(() => {
              insertOutsideReexportOverflow(layout.databasePath, base.snapshot.id);
              redirectBarrelWithOutsideCall(root);
            });
            const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});

            expect(indexed.materialization).toMatchObject({
              fallbackReason: 'reexport-closure-unbounded',
              mode: 'full',
            });
            expect(indexed.materialization?.stagedFiles).toBe(indexed.materialization?.totalFiles);
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 120_000},
  );

  it.effect(
    'selects resolved and unresolved consumers through transitive aliases when an export is renamed',
    () =>
      Effect.acquireUseRelease(
        Effect.sync(createLargeRootProjectRepository),
        root =>
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            const store = yield* CodeGraphStore;
            const path = yield* Path.Path;
            const incrementalHome = join(root, '.threadnote-incremental');
            const fullHome = join(root, '.threadnote-full');
            yield* Effect.sync(() => {
              writeFile(
                root,
                'src/core.ts',
                'export const stable = 1;\nexport function retiring() { return stable; }\n',
              );
              writeFile(root, 'src/barrel-a.ts', 'export {discovered, retiring} from "./core.js";\n');
              writeFile(root, 'src/barrel-b.ts', 'export {discovered, retiring} from "./barrel-a.js";\n');
              writeFile(
                root,
                'src/consumer.ts',
                'import {discovered, retiring} from "./barrel-b.js";\nexport function consume() { return discovered() + retiring(); }\n',
              );
              git(root, ['add', 'src/core.ts', 'src/barrel-a.ts', 'src/barrel-b.ts', 'src/consumer.ts']);
              git(root, ['commit', '-qm', 'add retiring export']);
            });
            const base = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});

            yield* Effect.sync(() => {
              writeFile(
                root,
                'src/core.ts',
                'export const stable = 1;\nexport function discovered() { return stable; }\n',
              );
            });
            const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            const full = yield* indexer.index({
              cwd: root,
              incrementalOverlay: false,
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

            expect(base.materialization?.totalFiles).toBeGreaterThan(128);
            expect(incremental.materialization).toMatchObject({
              mode: 'incremental-overlay',
              resolutionClosure: 'project',
              stagedFiles: 4,
            });
            expect(incremental.incrementalWork).toMatchObject({
              baseFactsLoaded: 4,
              changedFiles: 4,
            });
            expect(incremental.incrementalWork?.attributionContextFiles).toBe(base.materialization?.totalFiles ?? 0);
            expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
            const discovered = EffectOption.getOrUndefined(
              EffectArray.findFirst(incrementalGraph.symbols, symbol => symbol.name === 'discovered'),
            );
            expect(discovered).toBeDefined();
            expect(
              EffectArray.some(
                incrementalGraph.edges,
                edge => edge.sourceName === 'consume' && edge.relation === 'calls' && edge.targetId === discovered?.id,
              ),
            ).toBe(true);
            expect(EffectArray.some(incrementalGraph.symbols, symbol => symbol.name === 'retiring')).toBe(false);
            expect(
              EffectArray.some(
                incrementalGraph.edges,
                edge =>
                  edge.sourceName === 'consume' &&
                  edge.targetName === 'retiring' &&
                  edge.provenance === 'resolved' &&
                  edge.targetId !== undefined,
              ),
            ).toBe(false);
            expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual([
              'src/barrel-a.ts',
              'src/barrel-b.ts',
              'src/consumer.ts',
              'src/core.ts',
            ]);
            expect(yield* store.diagnose(incrementalLayout.databasePath)).toMatchObject({
              foreignKeyViolations: 0,
              integrity: 'ok',
            });
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 120_000},
  );

  fcEffectProp(
    it,
    'matches forced-full graph, query, catalog, health, counts, and delta paths across randomized project chains',
    {
      projectCount: FC.integer({max: 8, min: 5}),
      salt: FC.integer({max: 10_000, min: 0}),
    },
    ({projectCount, salt}) =>
      Effect.acquireUseRelease(
        Effect.sync(() => createRandomProjectClosureRepository(projectCount, salt)),
        root =>
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            const path = yield* Path.Path;
            const query = yield* CodeGraphQueryService;
            const store = yield* CodeGraphStore;
            const incrementalHome = join(root, '.threadnote-random-incremental');
            const fullHome = join(root, '.threadnote-random-full');
            yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            yield* Effect.sync(() => redirectRandomBarrel(root, salt));
            const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            const full = yield* indexer.index({
              cwd: root,
              incrementalOverlay: false,
              threadnoteHome: fullHome,
            });
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
                  query: 'use3',
                  refresh: false,
                  threadnoteHome: incrementalHome,
                }),
                query.inspect({
                  cwd: root,
                  operation: 'query',
                  query: 'use3',
                  refresh: false,
                  threadnoteHome: fullHome,
                }),
              ],
              {concurrency: 1},
            );
            const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
            const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);

            expect(incremental.materialization).toEqual({
              closureProjects: projectCount - 3,
              mode: 'incremental-overlay',
              resolutionClosure: 'project',
              stagedFiles: 2 * (projectCount - 3),
              totalFiles: 2 * projectCount - 1,
            });
            expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
            expect(normalizeQuery(incrementalQuery)).toEqual(normalizeQuery(fullQuery));
            expect(normalizeCatalog(yield* store.loadVisualizationCatalog(incrementalLayout.databasePath))).toEqual(
              normalizeCatalog(yield* store.loadVisualizationCatalog(fullLayout.databasePath)),
            );
            expect(yield* store.diagnose(incrementalLayout.databasePath)).toMatchObject({
              foreignKeyViolations: 0,
              integrity: 'ok',
            });
            expect(yield* store.diagnose(fullLayout.databasePath)).toMatchObject({
              foreignKeyViolations: 0,
              integrity: 'ok',
            });
            expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual(
              EffectArray.flatMap(
                Array.from({length: projectCount - 3}, (_, offset) => offset + 2),
                index => [`packages/p${index}/index.ts`, `packages/p${index}/package.json`],
              ).sort(),
            );
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {fastCheck: {interruptAfterTimeLimit: 120_000, markInterruptAsFailure: true, numRuns: 4}, timeout: 130_000},
  );
});

function createProjectClosureRepository(
  options: {readonly orphanProjectBoundary?: boolean; readonly overlappingTypeScriptConfigs?: boolean} = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-project-closure-'));
  writeFile(root, '.gitignore', '/.threadnote-*/\n');
  write(root, 'package.json', {name: '@fixture/root', private: true, workspaces: ['packages/*']});
  write(root, 'packages/app/package.json', {
    dependencies: {
      '@fixture/barrel': 'workspace:*',
      '@fixture/core': 'workspace:*',
      '@fixture/other': 'workspace:*',
      '@fixture/unrelated': 'workspace:*',
    },
    name: '@fixture/app',
  });
  writeFile(
    root,
    'packages/app/index.ts',
    'import {foo} from "../barrel/index.js";\nexport function consume() { return foo(); }\n',
  );
  write(root, 'packages/barrel/package.json', {
    dependencies: {'@fixture/core': 'workspace:*', '@fixture/other': 'workspace:*'},
    name: '@fixture/barrel',
  });
  writeFile(root, 'packages/barrel/index.ts', 'export {real as foo} from "../core/index.js";\n');
  write(root, 'packages/core/package.json', {name: '@fixture/core'});
  writeFile(root, 'packages/core/index.ts', 'export function real() { return "real"; }\n');
  write(root, 'packages/other/package.json', {name: '@fixture/other'});
  writeFile(root, 'packages/other/index.ts', 'export function other() { return "other"; }\n');
  write(root, 'packages/unrelated/package.json', {name: '@fixture/unrelated'});
  writeFile(root, 'packages/unrelated/index.ts', 'export function unrelated() { return "unrelated"; }\n');
  if (options.overlappingTypeScriptConfigs) {
    write(root, 'tsconfig.json', {compilerOptions: {rootDir: 'packages'}, include: ['packages/**/*.ts']});
    write(root, 'apps/threadnote/test/tsconfig.json', {
      compilerOptions: {rootDir: '..'},
      include: ['../packages/**/*.ts'],
    });
  }
  if (options.orphanProjectBoundary) {
    write(root, 'unmodeled/tsconfig.json', {references: [{path: '../not-indexed'}]});
    writeFile(root, 'unmodeled/index.ts', 'export const unmodeled = true;\n');
  }
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Threadnote Test']);
  git(root, ['config', 'user.email', 'test@threadnote.local']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function createLargeRootProjectRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-large-root-closure-'));
  writeFile(root, '.gitignore', '/.threadnote-*/\n');
  write(root, 'package.json', {name: '@fixture/large-root', private: true, type: 'module'});
  write(root, 'tsconfig.json', {include: ['src/**/*.ts']});
  writeFile(root, 'src/core.ts', 'export const stable = 1;\n');
  writeFile(root, 'src/barrel-a.ts', 'export {discovered} from "./core.js";\n');
  writeFile(root, 'src/barrel-b.ts', 'export {discovered} from "./barrel-a.js";\n');
  writeFile(
    root,
    'src/consumer.ts',
    'import {discovered} from "./barrel-b.js";\nexport function consume() { return discovered(); }\n',
  );
  for (let index = 0; index < 139; index += 1) {
    writeFile(
      root,
      `src/filler-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.ts`,
      `export const filler${index} = ${index};\n`,
    );
  }
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Threadnote Test']);
  git(root, ['config', 'user.email', 'test@threadnote.local']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function redirectBarrel(root: string): void {
  writeFile(root, 'packages/barrel/index.ts', 'export {other as foo} from "../other/index.js";\n');
}

function redirectBarrelWithOutsideCall(root: string): void {
  redirectBarrel(root);
  writeFile(
    root,
    'packages/app/index.ts',
    'import {foo} from "../barrel/index.js";\nimport {unrelated} from "../unrelated/index.js";\nexport function consume() { return foo() + unrelated(); }\n',
  );
}

function createRandomProjectClosureRepository(projectCount: number, salt: number): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-random-project-closure-'));
  writeFile(root, '.gitignore', '/.threadnote-*/\n');
  const packageCount = projectCount - 1;
  write(root, 'package.json', {name: '@random/root', private: true, workspaces: ['packages/*']});
  write(root, 'packages/p0/package.json', {name: '@random/p0'});
  writeFile(root, 'packages/p0/index.ts', `export function old${salt}() { return "old"; }\n`);
  write(root, 'packages/p1/package.json', {name: '@random/p1'});
  writeFile(root, 'packages/p1/index.ts', `export function next${salt}() { return "next"; }\n`);
  write(root, 'packages/p2/package.json', {
    dependencies: {'@random/p0': 'workspace:*', '@random/p1': 'workspace:*'},
    name: '@random/p2',
  });
  writeFile(root, 'packages/p2/index.ts', `export {old${salt} as foo} from "../p0/index.js";\n`);
  for (let index = 3; index < packageCount; index += 1) {
    if (index === 3) {
      write(root, `packages/p${index}/package.json`, {
        dependencies: {
          '@random/p0': 'workspace:*',
          '@random/p1': 'workspace:*',
          '@random/p2': 'workspace:*',
        },
        name: `@random/p${index}`,
      });
      writeFile(
        root,
        `packages/p${index}/index.ts`,
        `import {foo} from "../p2/index.js";\nexport function use${index}() { return foo(); }\n`,
      );
      continue;
    }
    write(root, `packages/p${index}/package.json`, {
      dependencies: {[`@random/p${index - 1}`]: 'workspace:*'},
      name: `@random/p${index}`,
    });
    writeFile(
      root,
      `packages/p${index}/index.ts`,
      `import {use${index - 1}} from "../p${index - 1}/index.js";\nexport function use${index}() { return use${index - 1}(); }\n`,
    );
  }
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Threadnote Test']);
  git(root, ['config', 'user.email', 'test@threadnote.local']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function redirectRandomBarrel(root: string, salt: number): void {
  writeFile(root, 'packages/p2/index.ts', `export {next${salt} as foo} from "../p1/index.js";\n`);
}

function write(root: string, path: string, value: unknown): void {
  writeFile(root, path, `${JSON.stringify(value)}\n`);
}

function workspaceCatalogRows(databasePath: string, snapshotId: string): readonly unknown[] {
  const database = new Database(databasePath, {readonly: true});
  try {
    return EffectArray.map(
      EffectArray.map(
        [
          'workspace_scopes',
          'workspace_components',
          'workspace_component_dependencies',
          'workspace_external_dependencies',
          'code_graph_monikers',
        ],
        table =>
          database
            .query<Record<string, unknown>, SQLQueryBindings[]>(
              `SELECT * FROM ${table} WHERE snapshot_id = ? ORDER BY 2, 3`,
            )
            .all(snapshotId),
      ),
      rows => EffectArray.map(rows, ({snapshot_id: _snapshotId, ...row}) => row),
    );
  } finally {
    database.close();
  }
}

function writeFile(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, content);
}

function git(root: string, arguments_: readonly string[]): void {
  execFileSync('git', arguments_, {cwd: root, stdio: 'ignore'});
}

function normalizeGraph(graph: StoredCodeGraph): unknown {
  return {
    edges: [...graph.edges].sort((left, right) => Effect2.pipe(left.id, EffectString.localeCompare(right.id))),
    symbols: [...graph.symbols].sort((left, right) => Effect2.pipe(left.id, EffectString.localeCompare(right.id))),
  };
}

function documentEdge(graph: StoredCodeGraph, path: string, targetName: string) {
  return EffectOption.getOrUndefined(
    EffectArray.findFirst(
      graph.edges,
      edge => edge.evidencePath === path && edge.relation === 'documents' && edge.targetName === targetName,
    ),
  );
}

function normalizeCatalog(catalog: CodeGraphVisualizationCatalog | undefined): unknown {
  if (!catalog) return catalog;
  const {activatedAt: _activatedAt, snapshot, ...rest} = catalog;
  const {
    baseSnapshotId: _baseSnapshotId,
    completedAt: _completedAt,
    graphContentId: _graphContentId,
    id: _id,
    ...stableSnapshot
  } = snapshot;
  return {...rest, snapshot: stableSnapshot};
}

function normalizeQuery(result: CodeGraphQueryResult): unknown {
  return {
    edges: [...result.edges].sort((left, right) => Effect2.pipe(left.id, EffectString.localeCompare(right.id))),
    nodes: result.nodes,
    operation: result.operation,
    warnings: result.warnings,
  };
}

function deltaPaths(databasePath: string, snapshotId: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true});
  try {
    return EffectArray.map(
      database
        .query<{readonly path: string}, [string]>('SELECT path FROM snapshot_files WHERE snapshot_id = ? ORDER BY path')
        .all(snapshotId),
      row => row.path,
    );
  } finally {
    database.close(false);
  }
}

function mutateBarrelCache(databasePath: string, scenario: 'missing' | 'oversized' | 'receipt'): void {
  const database = new Database(databasePath);
  try {
    if (scenario === 'missing') {
      database.run(`DELETE FROM file_blobs WHERE path_hint = 'packages/barrel/index.ts'`);
    } else if (scenario === 'oversized') {
      database.run(`UPDATE file_blobs SET facts_json = ? WHERE path_hint = 'packages/barrel/index.ts'`, [
        JSON.stringify({
          diagnostics: [Effect2.pipe('x', EffectString.repeat(8 * 1_048_576))],
          edges: [],
          path: 'packages/barrel/index.ts',
          references: [],
          symbols: [],
        }),
      ]);
    } else {
      database.run('DELETE FROM snapshot_reuse_receipts');
    }
  } finally {
    database.close(false);
  }
}

function inflateCachedFacts(databasePath: string, contentHashes: readonly string[], diagnosticBytes: number): void {
  const database = new Database(databasePath);
  try {
    const read = database.query<{readonly factsJson: string}, [string]>(
      'SELECT facts_json AS factsJson FROM file_blobs WHERE content_hash = ? LIMIT 1',
    );
    for (const contentHash of contentHashes) {
      const row = read.get(contentHash);
      if (!row) throw TestError.make({message: `Missing cached facts for ${contentHash}.`});
      const facts = decodeStoredCodeGraphFact(row.factsJson).facts;
      const inflated = serializeBoundedCodeGraphFact({
        ...facts,
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        diagnostics: [...facts.diagnostics, 'x'.repeat(diagnosticBytes)],
      });
      database.run('UPDATE file_blobs SET facts_json = ? WHERE content_hash = ?', [
        encodeStoredCodeGraphFact(inflated).json,
        contentHash,
      ]);
    }
  } finally {
    database.close(false);
  }
}

function snapshotFileContentHash(databasePath: string, snapshotId: string, path: string): string {
  const database = new Database(databasePath, {readonly: true});
  try {
    const row = database
      .query<{readonly contentHash: string}, [string, string]>(
        'SELECT content_hash AS contentHash FROM snapshot_files WHERE snapshot_id = ? AND path = ?',
      )
      .get(snapshotId, path);
    if (!row) throw TestError.make({message: `Missing snapshot file ${path}.`});
    return row.contentHash;
  } finally {
    database.close(false);
  }
}

function deleteCachedContentHash(databasePath: string, contentHash: string): void {
  const database = new Database(databasePath);
  try {
    database.run('DELETE FROM file_blobs WHERE content_hash = ?', [contentHash]);
  } finally {
    database.close(false);
  }
}

function corruptCachedFactPath(databasePath: string, contentHash: string): void {
  const database = new Database(databasePath);
  try {
    database.run('UPDATE file_blobs SET facts_json = ? WHERE content_hash = ?', [
      JSON.stringify({
        diagnostics: [],
        edges: [],
        path: 'packages/other/index.ts',
        references: [],
        symbols: [],
      }),
      contentHash,
    ]);
  } finally {
    database.close(false);
  }
}

function cachedFactPayloadPaths(databasePath: string, contentHash: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true});
  try {
    return EffectArray.map(
      database
        .query<{readonly path: string}, [string]>(
          `SELECT json_extract(facts_json, '$.path') AS path
         FROM file_blobs
         WHERE content_hash = ?
         ORDER BY extractor_set`,
        )
        .all(contentHash),
      row => row.path,
    );
  } finally {
    database.close(false);
  }
}

function insertOutsideReexportOverflow(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    const insert = database.prepare(
      `INSERT INTO snapshot_reexport_provenance (
        snapshot_id, source_path, local_name, target_path, imported_name
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < 10_001; index += 1) {
        insert.run(
          snapshotId,
          'packages/unrelated/index.ts',
          'unrelated',
          `packages/outside-${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}.ts`,
          `outside${index}`,
        );
      }
    })();
  } finally {
    database.close(false);
  }
}
