import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path, pipe} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {describe, expect} from 'vitest';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphParserPool} from '@threadnote/graph/parser_worker';
import {CodeGraphObservability, CodeGraphProcessActivity} from '@threadnote/graph/runtime_ports';
import {CodeGraphStore} from '@threadnote/graph/store';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphIndexSummary, CodeGraphReference, CodeGraphEdge} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {Database} from 'bun:sqlite';
import * as EffectString from 'effect/String';
import {resolutionCandidateFileEvidence} from '@threadnote/graph/materialization/candidate_evidence';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const platform = Layer.effect(
  SystemInfo,
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return SystemInfo.of({
      ...system,
      developmentEntrypoint: yield* path.fromFileUrl(
        new URL('../../../../apps/threadnote/src/standalone.ts', import.meta.url),
      ),
      environment: () => ({...system.environment(), THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '1'}),
    });
  }),
).pipe(Layer.provideMerge(citationPlatformLayer));
const ports = Layer.mergeAll(
  Layer.succeed(CodeGraphProcessActivity, {withActivity: (_role, _operation, program) => program}),
  Layer.succeed(CodeGraphObservability, {
    makeBuildReporter: () =>
      Effect.succeed({
        observeExtractedFactBytes: () => Effect.void,
        observeInventory: () => Effect.void,
        observeOverlay: () => Effect.void,
        progress: () => Effect.void,
        terminal: () => Effect.void,
      }),
    makeWorksetReporter: Effect.succeed({
      failure: () => Effect.void,
      progress: () => Effect.void,
      terminal: () => Effect.void,
    }),
    backgroundFailure: () => Effect.void,
  }),
  Layer.succeed(CodeGraphEmbeddingIndex, {
    check: () => Effect.succeed({state: 'unavailable' as const, reason: 'vectors disabled in fixture'}),
    ensure: () => Effect.die('Structural fixture must not run embedding inference'),
    search: () => Effect.die('Structural fixture must not run query inference'),
  }),
  FetchHttpClient.layer,
);
const base = Layer.mergeAll(platform, ports);
const storeLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(base));
const dependencies = Layer.mergeAll(
  CodeGraphMaintenanceCoordinator.layer.pipe(Layer.provideMerge(storeLayer)),
  CodeGraphParserPool.layer.pipe(Layer.provideMerge(base)),
  TreeSitterRuntime.layer.pipe(Layer.provideMerge(base)),
  CodeGraphLanguagePackRegistry.layer,
);

const completeIndex = (databasePath: string, snapshotId: string) =>
  Effect.sync(() => {
    const db = new Database(databasePath, {readonly: true});
    try {
      return db
        .query<{readonly count: number}, [string]>(
          'SELECT COUNT(*) AS count FROM snapshot_candidate_receipts WHERE snapshot_id = ?',
        )
        .get(snapshotId)?.count;
    } finally {
      db.close();
    }
  });

describe('candidate evidence publication and repeated structural updates', () => {
  effectIt.layer(CodeGraphIndexer.layer.pipe(Layer.provideMerge(dependencies)))(it => {
    it.effect(
      'publishes ordinary graph facts when a valid wide reference cannot fit the optional normalized index',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const registry = yield* CodeGraphLanguagePackRegistry;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'graph-candidate-wide-reference-'});
          const home = path.join(root, 'private-home');
          const repository = path.join(root, 'repository');
          yield* fs.makeDirectory(repository);
          yield* fs.makeDirectory(home);
          const tiers = [
            Array.from(
              {length: 80_000},
              (_, n) => `typescript:path:missing:name:${n}:${pipe('k', EffectString.repeat(40))}`,
            ),
          ];
          const span = {line: 1, column: 1, endLine: 1, endColumn: 2};
          const reference: CodeGraphReference = {
            edgeId: 'wide-reference',
            evidencePath: 'wide.ts',
            evidenceSpan: span,
            sourceName: 'wide.ts',
            targetName: 'missing',
            provenance: 'syntactic',
            relation: 'reexports',
            resolutionDomain: 'typescript',
            lookupTiers: tiers,
            aliasLookupKeys: ['typescript:path:wide.ts:name:alias'],
            exportedOnly: true,
          };
          expect(Buffer.byteLength(JSON.stringify(reference))).toBeLessThan(8 * 1_048_576);
          const edge: CodeGraphEdge = {
            id: reference.edgeId,
            evidencePath: 'wide.ts',
            evidenceSpan: span,
            sourceName: 'wide.ts',
            targetName: 'missing',
            provenance: 'syntactic',
            relation: 'reexports',
            confidence: 1,
          };
          const facts = {path: 'wide.ts', symbols: [], edges: [edge], references: [reference], diagnostics: []};
          expect(
            resolutionCandidateFileEvidence(
              [
                {
                  path: 'wide.ts',
                  blobId: 'blob',
                  contentHash: 'hash',
                  language: 'typescript',
                  mode: '100644',
                  size: 1,
                  source: 'commit',
                },
              ],
              [facts],
              [facts],
              'snapshot',
            ).files,
          ).toEqual([]);
          const fixtureRegistry = CodeGraphLanguagePackRegistry.of({
            ...registry,
            postprocessFile: (file, raw) => {
              const original = registry.postprocessFile(file, raw);
              return file.path === 'wide.ts'
                ? {
                    ...original,
                    edges: [...original.edges, edge],
                    references: [...(original.references ?? []), reference],
                  }
                : original;
            },
          });
          const context = yield* Layer.build(
            Layer.fresh(CodeGraphIndexer.layer).pipe(
              Layer.provide(Layer.succeed(CodeGraphLanguagePackRegistry, fixtureRegistry)),
            ),
          );
          const indexer = Context.get(context, CodeGraphIndexer);
          yield* fs.writeFileString(path.join(repository, 'wide.ts'), 'export const value = 1;\n');
          yield* runCommandEffect('git', ['-C', repository, 'init', '--quiet']);
          yield* runCommandEffect('git', ['-C', repository, 'add', '.']);
          yield* runCommandEffect('git', [
            '-C',
            repository,
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            '-c',
            'core.hooksPath=/dev/null',
            'commit',
            '-qm',
            'wide optional reference',
          ]);
          const built = yield* indexer.index({
            cwd: repository,
            threadnoteHome: home,
            sourceOnly: true,
            vectorPolicy: 'off',
          });
          expect(built.snapshot.state).toBe('ready');
          expect(built.candidateIndexBuild).toEqual({rawFilesLoaded: 0, rawFactBytesLoaded: 0, unsupportedFiles: 1});
          const layout = codeGraphLayout(path, home, built.identity.checkoutId, built.identity.worktreeId);
          const graph = yield* store.loadGraph(layout.databasePath, built.snapshot.id);
          expect(graph.symbols.length).toBe(built.snapshot.symbolCount);
          expect(graph.edges.length).toBe(built.snapshot.edgeCount);
          const oracleHome = path.join(root, 'ordinary-graph-oracle');
          yield* fs.makeDirectory(oracleHome);
          const oracleStore = CodeGraphStore.of({
            ...store,
            stageResolutionCandidateIndex: undefined,
            finishResolutionCandidateIndex: undefined,
          });
          const oracleContext = yield* Layer.build(
            Layer.fresh(CodeGraphIndexer.layer).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(CodeGraphLanguagePackRegistry, fixtureRegistry),
                  Layer.succeed(CodeGraphStore, oracleStore),
                ),
              ),
            ),
          );
          const oracle = yield* Context.get(oracleContext, CodeGraphIndexer).index({
            cwd: repository,
            threadnoteHome: oracleHome,
            sourceOnly: true,
            vectorPolicy: 'off',
          });
          const oracleLayout = codeGraphLayout(
            path,
            oracleHome,
            oracle.identity.checkoutId,
            oracle.identity.worktreeId,
          );
          const ordinary = yield* store.loadGraph(oracleLayout.databasePath, oracle.snapshot.id);
          expect({symbols: graph.symbols, edges: graph.edges}).toEqual({
            symbols: ordinary.symbols,
            edges: ordinary.edges,
          });
          expect(yield* completeIndex(layout.databasePath, built.snapshot.id)).toBe(0);
          expect(
            yield* store.resolutionCandidateIndexClosure!(layout.databasePath, {
              snapshotId: built.snapshot.id,
              workspaceFingerprint: 'unknown',
              fileSetFingerprint: 'unknown',
              initialLookupKeys: [],
              additionalReexports: [],
              maximumSelectedFiles: 128,
            }),
          ).toBeUndefined();
        }).pipe(TestClock.withLive),
    );

    it.effect('publishes complete evidence through warm shards and preserves exact clean/dirty graph updates', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const indexer = yield* CodeGraphIndexer;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'graph-candidate-publication-'});
        const repository = path.join(root, 'repository');
        const home = path.join(root, 'home');
        yield* fs.makeDirectory(repository);
        yield* fs.makeDirectory(home);
        const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
        const commit = (message: string) =>
          Effect.gen(function* () {
            yield* git(['add', '.']);
            yield* git([
              '-c',
              'user.name=Fixture',
              '-c',
              'user.email=fixture@example.invalid',
              '-c',
              'core.hooksPath=/dev/null',
              '-c',
              'commit.gpgsign=false',
              'commit',
              '-qm',
              message,
            ]);
          });
        const index = (extra: {readonly force?: boolean; readonly incrementalOverlay?: boolean} = {}) =>
          indexer.index({cwd: repository, threadnoteHome: home, sourceOnly: true, vectorPolicy: 'off', ...extra});
        const database = (summary: CodeGraphIndexSummary) =>
          codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId).databasePath;
        const graph = (summary: CodeGraphIndexSummary, selectedHome = home) =>
          store
            .loadGraph(
              codeGraphLayout(path, selectedHome, summary.identity.checkoutId, summary.identity.worktreeId)
                .databasePath,
              summary.snapshot.id,
            )
            .pipe(Effect.map(({symbols, edges}) => ({symbols, edges})));
        const oracle = () =>
          Effect.gen(function* () {
            const oracleHome = yield* fs.makeTempDirectoryScoped({prefix: 'graph-candidate-full-oracle-'});
            const full = yield* indexer.index({
              cwd: repository,
              threadnoteHome: oracleHome,
              sourceOnly: true,
              vectorPolicy: 'off',
              incrementalOverlay: false,
            });
            return yield* graph(full, oracleHome);
          });
        yield* git(['init', '--quiet']);
        yield* fs.writeFileString(
          path.join(repository, 'package.json'),
          JSON.stringify({name: 'candidate-fixture', private: true, type: 'module'}),
        );
        yield* fs.writeFileString(path.join(repository, 'leaf.ts'), 'export const existing = 1;\n');
        yield* fs.writeFileString(path.join(repository, 'barrel.ts'), "export {first, second} from './leaf';\n");
        yield* fs.writeFileString(
          path.join(repository, 'consumer.ts'),
          "import {first, second} from './barrel';\nexport const result = first + second;\n",
        );
        for (let n = 0; n < 129; n++)
          yield* fs.writeFileString(path.join(repository, `unrelated-${n}.ts`), `export const unrelated${n} = ${n};\n`);
        yield* commit('unresolved imports');
        const first = yield* index();
        expect(yield* completeIndex(database(first), first.snapshot.id)).toBe(1);
        const firstGraph = yield* graph(first);
        // Reopen the real store/indexer in an independent resource scope so its schema admission cannot use the first service's cache.
        const warm = yield* Effect.scoped(
          Effect.gen(function* () {
            const freshStoreContext = yield* Layer.build(Layer.fresh(CodeGraphStore.layer));
            const reopened = Context.get(freshStoreContext, CodeGraphStore);
            const freshIndexerContext = yield* Layer.build(
              Layer.fresh(CodeGraphIndexer.layer).pipe(Layer.provide(Layer.succeed(CodeGraphStore, reopened))),
            );
            return yield* Context.get(freshIndexerContext, CodeGraphIndexer).index({
              cwd: repository,
              threadnoteHome: home,
              sourceOnly: true,
              vectorPolicy: 'off',
              force: true,
            });
          }),
        );
        expect(warm.diagnostics).toContain('Reused content-addressed materialized shards for 133 file(s).');
        expect(warm.candidateIndexBuild).toMatchObject({rawFilesLoaded: 133, unsupportedFiles: 0});
        expect(yield* completeIndex(database(warm), warm.snapshot.id)).toBe(1);
        expect(yield* graph(warm)).toEqual(firstGraph);
        yield* fs.writeFileString(
          path.join(repository, 'leaf.ts'),
          'export const existing = 1;\nexport const first = 2;\n',
        );
        yield* commit('first export');
        const second = yield* index();
        expect(second.materialization, JSON.stringify(second)).toMatchObject({
          mode: 'incremental-clean',
          resolutionClosure: 'project',
        });
        expect(second.incrementalWork?.candidateIndex?.associationsRead).toBeGreaterThan(0);
        expect(second.incrementalWork?.attributionContextFiles).toBe(0);
        expect(second.materialization?.stagedFiles).toBeLessThan(133);
        expect(yield* completeIndex(database(second), second.snapshot.id)).toBe(1);
        expect(yield* graph(second)).toEqual(yield* oracle());
        yield* fs.writeFileString(
          path.join(repository, 'leaf.ts'),
          'export const existing = 1;\nexport const first = 2;\nexport const second = 3;\n',
        );
        yield* commit('second export');
        const third = yield* index();
        expect(third.materialization).toMatchObject({mode: 'incremental-clean', resolutionClosure: 'project'});
        expect(third.incrementalWork?.candidateIndex?.associationsRead).toBeGreaterThan(0);
        expect(yield* completeIndex(database(third), third.snapshot.id)).toBe(1);
        expect(yield* graph(third)).toEqual(yield* oracle());
        yield* fs.writeFileString(
          path.join(repository, 'leaf.ts'),
          'export const existing = 1;\nexport const first = 2;\nexport const second = 3;\nexport const third = 4;\n',
        );
        const dirty = yield* index();
        expect(dirty.materialization).toMatchObject({mode: 'incremental-overlay'});
        expect(yield* graph(dirty)).toEqual(yield* oracle());
        expect(yield* completeIndex(database(dirty), dirty.snapshot.id)).toBe(1);
        // A lost populated path index cannot trigger a repository-wide CREATE INDEX during ordinary publication.
        yield* Effect.sync(() => {
          const db = new Database(database(dirty));
          try {
            expect(
              db.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_candidate_lookup').get()
                ?.count,
            ).toBeGreaterThan(0);
            db.exec('DROP INDEX snapshot_candidate_lookup_path');
          } finally {
            db.close();
          }
        });
        const fallback = yield* Effect.scoped(
          Effect.gen(function* () {
            const reopened = Context.get(yield* Layer.build(Layer.fresh(CodeGraphStore.layer)), CodeGraphStore);
            const freshIndexer = Context.get(
              yield* Layer.build(
                Layer.fresh(CodeGraphIndexer.layer).pipe(Layer.provide(Layer.succeed(CodeGraphStore, reopened))),
              ),
              CodeGraphIndexer,
            );
            return yield* freshIndexer.index({
              cwd: repository,
              threadnoteHome: home,
              sourceOnly: true,
              vectorPolicy: 'off',
              force: true,
              incrementalOverlay: false,
            });
          }),
        );
        expect(yield* graph(fallback)).toEqual(yield* oracle());
        expect(yield* completeIndex(database(fallback), fallback.snapshot.id)).toBe(0);
        yield* Effect.sync(() => {
          const db = new Database(database(fallback), {readonly: true});
          try {
            expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'snapshot_candidate_lookup_path'").all()).toEqual(
              [],
            );
            expect(db.query('SELECT state FROM snapshot_candidate_authority').all()).toEqual([{state: 'blocked'}]);
          } finally {
            db.close();
          }
        });
      }).pipe(TestClock.withLive),
    );
  });
});
