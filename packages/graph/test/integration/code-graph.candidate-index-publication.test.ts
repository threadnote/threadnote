import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Cause, Context, Effect, Exit, FileSystem, Layer, Path, pipe} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {describe, expect} from 'vitest';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {makeResolutionCandidateEvidenceBuilder} from '@threadnote/graph/indexer/candidate_evidence';
import {emptyMaterializationReplayMetrics} from '@threadnote/graph/indexer/materialization';
import {CodeGraphStoreError} from '@threadnote/graph/types';
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
import {IndexPhaseTimeline, indexPhaseMeasurements} from '../../../../scripts/benchmark-code-graph.js';

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
          `SELECT COUNT(*) AS count FROM snapshot_candidate_receipts AS receipt
             JOIN snapshot_candidate_page_snapshots AS candidate ON candidate.snapshot_id = receipt.snapshot_id AND candidate.format_version = 3
             JOIN snapshot_candidate_page_receipts AS proof ON proof.snapshot_key = candidate.snapshot_key AND proof.format_version = 3
               AND proof.protocol_sha = candidate.protocol_sha AND proof.authority_token = candidate.authority_token
             JOIN snapshot_candidate_authority AS authority ON authority.singleton = 1 AND authority.state = 'ready'
               AND authority.token = candidate.authority_token WHERE receipt.snapshot_id = ?`,
        )
        .get(snapshotId)?.count;
    } finally {
      db.close();
    }
  });

describe('candidate evidence publication and repeated structural updates', () => {
  effectIt.layer(CodeGraphIndexer.layer.pipe(Layer.provideMerge(dependencies)))(it => {
    it.effect('counts successful, incomplete and failed finish work in the same cumulative candidate stage', () =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const path = yield* Path.Path;
        const registry = yield* CodeGraphLanguagePackRegistry;
        let outcome: 'complete' | 'incomplete' | 'failure' = 'complete';
        const carried: (string | undefined)[] = [];
        const builder = makeResolutionCandidateEvidenceBuilder(
          {
            store: CodeGraphStore.of({
              ...store,
              stageResolutionCandidateIndex: () => TestClock.adjust(11),
              finishResolutionCandidateIndex: (_database, identity) =>
                Effect.gen(function* () {
                  carried.push(identity.inheritedSnapshotId);
                  yield* TestClock.adjust(37);
                  if (outcome === 'failure') return yield* CodeGraphStoreError.of('controlled finish failure');
                  return outcome === 'complete';
                }),
            }),
            layout: codeGraphLayout(
              path,
              '/unopened-candidate-clock-fixture',
              EffectString.repeat(64)('a'),
              EffectString.repeat(64)('b'),
            ),
            building: {
              id: 'building',
              repositoryId: 'repository',
              worktreeId: 'worktree',
              commit: 'commit',
              state: 'building',
              dirty: false,
              edgeCount: 0,
              fileCount: 0,
              symbolCount: 0,
              extractorSet: 'extractor',
            },
            languagePacks: registry,
          },
          effect => effect,
        );
        yield* builder.stageFull({files: [], facts: [], bounded: [], warm: false, attributeFacts: facts => facts});
        expect(builder.progress.stagingMilliseconds).toBe(11);
        const graph = {...emptyMaterializationReplayMetrics(), attributedFilesCompleted: 7};
        const telemetry = {cpuSystemMicroseconds: 0, cpuUserMicroseconds: 0, peakRssBytes: 0, rssBytes: 0};
        const timeline = new IndexPhaseTimeline(0n, telemetry);
        const observe = () =>
          timeline.observe(
            {
              phase: 'materializing',
              completed: 1,
              total: 1,
              reused: 0,
              unit: 'files',
              metrics: {
                batchesCompleted: 1,
                batchesTotal: 1,
                sourceBytesCompleted: 0,
                sourceBytesTotal: 0,
                ...builder.metrics(graph, {
                  loadingMilliseconds: 3,
                  attributionMilliseconds: 5,
                  stageMilliseconds: {'writing-candidates': 2},
                }),
              },
            },
            0n,
            telemetry,
          );
        observe();
        expect(timeline.materializationStageMilliseconds('writing-candidates')).toBe(13);
        const identity = {
          snapshotId: 'building',
          workspaceFingerprint: 'workspace',
          fileSetFingerprint: 'files',
          inheritedSnapshotId: 'logical-donor',
        };
        expect(yield* builder.finish(identity)).toBe(true);
        expect(builder.progress.stagingMilliseconds).toBe(48);
        outcome = 'incomplete';
        expect(yield* builder.finish(identity)).toBe(false);
        expect(builder.progress.stagingMilliseconds).toBe(85);
        outcome = 'failure';
        expect(yield* builder.finish(identity).pipe(Effect.flip)).toMatchObject({
          _tag: 'CodeGraphStoreError',
          message: 'controlled finish failure',
        });
        expect(builder.progress.stagingMilliseconds).toBe(122);
        expect(carried).toEqual(['logical-donor', 'logical-donor', 'logical-donor']);
        const metrics = builder.metrics(graph, {
          loadingMilliseconds: 3,
          attributionMilliseconds: 5,
          stageMilliseconds: {'writing-candidates': 2},
        });
        expect(metrics.graphMaterialization).toEqual({...graph, loadingMilliseconds: 3, attributionMilliseconds: 5});
        expect(metrics.attributedFilesCompleted).toBe(7);
        expect(metrics.candidateIndex.stagingMilliseconds).toBe(122);
        expect(metrics.stageMilliseconds['writing-candidates']).toBe(124);
        observe();
        observe(); // The real benchmark consumer keeps the cumulative maximum, never sums event snapshots.
        expect(timeline.materializationStageMilliseconds('writing-candidates')).toBe(124);
        const reported = EffectArray.findFirst(
          indexPhaseMeasurements('cold', timeline, false),
          value => value.name === 'cold-materialization-stage-writing-candidates-n1',
        );
        expect(reported).toMatchObject({value: {unit: 'milliseconds', samples: 1, p95: 124, maximum: 124}});
      }),
    );

    for (const callback of ['typed-error', 'sync-throw', 'die'] as const) {
      for (const outcome of ['success', 'store-failure', 'interrupted'] as const) {
        it.effect(`preserves ${outcome} when added final telemetry has ${callback}`, () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const store = yield* CodeGraphStore;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'candidate-final-telemetry-exit-'});
            const repository = path.join(root, 'repository');
            const home = path.join(root, 'home');
            yield* fs.makeDirectory(repository);
            yield* fs.makeDirectory(home);
            yield* fs.writeFileString(path.join(repository, 'file.ts'), 'export const value = 1;\n');
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
              '-c',
              'commit.gpgsign=false',
              'commit',
              '-qm',
              'candidate telemetry fixture',
            ]);
            const originalFailure = CodeGraphStoreError.of('controlled original finish failure');
            const telemetryDefect = new Error('controlled optional final telemetry defect');
            let finishAttempted = false;
            let finalCallbacks = 0;
            let attemptedMilliseconds: number | undefined;
            let reportedCandidateStage: number | undefined;
            const observedStore = CodeGraphStore.of({
              ...store,
              finishResolutionCandidateIndex: (...args) =>
                Effect.gen(function* () {
                  const complete = yield* store.finishResolutionCandidateIndex!(...args);
                  finishAttempted = true;
                  if (outcome === 'store-failure') return yield* originalFailure;
                  if (outcome === 'interrupted') return yield* Effect.failCause(Cause.interrupt(123));
                  return complete;
                }),
            });
            const indexer = Context.get(
              yield* Layer.build(
                Layer.fresh(CodeGraphIndexer.layer).pipe(Layer.provide(Layer.succeed(CodeGraphStore, observedStore))),
              ),
              CodeGraphIndexer,
            );
            const exit = yield* indexer
              .index({
                cwd: repository,
                threadnoteHome: home,
                sourceOnly: true,
                vectorPolicy: 'off',
                onProgress: current => {
                  if (
                    finishAttempted &&
                    finalCallbacks === 0 &&
                    current.phase === 'materializing' &&
                    current.metrics?.candidateIndex
                  ) {
                    finalCallbacks += 1;
                    attemptedMilliseconds = current.metrics.candidateIndex.stagingMilliseconds;
                    reportedCandidateStage = current.metrics.stageMilliseconds?.['writing-candidates'];
                    if (callback === 'sync-throw') throw telemetryDefect;
                    if (callback === 'die') return Effect.die(telemetryDefect);
                    return Effect.fail('controlled typed final telemetry failure');
                  }
                  return Effect.void;
                },
              })
              .pipe(Effect.exit);
            expect(finishAttempted).toBe(true);
            expect(finalCallbacks).toBe(1);
            expect(attemptedMilliseconds).toBeGreaterThanOrEqual(0);
            expect(reportedCandidateStage).toBeGreaterThanOrEqual(attemptedMilliseconds ?? -1);
            if (outcome === 'success') {
              expect(Exit.isSuccess(exit)).toBe(true);
              if (Exit.isSuccess(exit)) expect(exit.value.snapshot.state).toBe('ready');
            } else {
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(exit.cause.reasons).toHaveLength(1);
                const reason = exit.cause.reasons[0];
                if (outcome === 'store-failure') {
                  expect(Cause.isFailReason(reason)).toBe(true);
                  if (Cause.isFailReason(reason)) expect(reason.error).toBe(originalFailure);
                } else {
                  expect(Cause.isInterruptReason(reason)).toBe(true);
                  if (Cause.isInterruptReason(reason)) expect(reason.fiberId).toBe(123);
                }
                expect(Cause.hasDies(exit.cause)).toBe(false);
              }
            }
          }).pipe(TestClock.withLive),
        );
      }
    }

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
          let finishReturned = false;
          let terminalCandidateMetricsAfterFinish = false;
          const observedStore = CodeGraphStore.of({
            ...store,
            finishResolutionCandidateIndex: (...args) =>
              store.finishResolutionCandidateIndex!(...args).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    finishReturned = true;
                  }),
                ),
              ),
          });
          const context = yield* Layer.build(
            Layer.fresh(CodeGraphIndexer.layer).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(CodeGraphLanguagePackRegistry, fixtureRegistry),
                  Layer.succeed(CodeGraphStore, observedStore),
                ),
              ),
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
            onProgress: current =>
              Effect.sync(() => {
                if (finishReturned && current.phase === 'materializing' && current.metrics?.candidateIndex)
                  terminalCandidateMetricsAfterFinish = true;
              }),
          });
          expect(finishReturned).toBe(true);
          expect(terminalCandidateMetricsAfterFinish).toBe(true);
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
        let finishSerial = 0;
        const observedStore = (source: typeof store) =>
          CodeGraphStore.of({
            ...source,
            finishResolutionCandidateIndex: (...args) =>
              source.finishResolutionCandidateIndex!(...args).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    finishSerial += 1;
                  }),
                ),
              ),
          });
        const indexer = Context.get(
          yield* Layer.build(
            Layer.fresh(CodeGraphIndexer.layer).pipe(
              Layer.provide(Layer.succeed(CodeGraphStore, observedStore(store))),
            ),
          ),
          CodeGraphIndexer,
        );
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
          Effect.gen(function* () {
            const before = finishSerial;
            let finalMetricsAfterFinish = false;
            let reportedCandidateStage: number | undefined;
            let candidateMilliseconds: number | undefined;
            const result = yield* indexer.index({
              cwd: repository,
              threadnoteHome: home,
              sourceOnly: true,
              vectorPolicy: 'off',
              ...extra,
              onProgress: current =>
                Effect.sync(() => {
                  if (finishSerial > before && current.phase === 'materializing' && current.metrics?.candidateIndex) {
                    finalMetricsAfterFinish = true;
                    reportedCandidateStage = current.metrics.stageMilliseconds?.['writing-candidates'];
                    candidateMilliseconds = current.metrics.candidateIndex.stagingMilliseconds;
                  }
                }),
            });
            expect(finishSerial).toBeGreaterThan(before);
            expect(finalMetricsAfterFinish).toBe(true);
            expect(candidateMilliseconds).toBeGreaterThanOrEqual(0);
            expect(reportedCandidateStage).toBeGreaterThanOrEqual(candidateMilliseconds ?? -1);
            return result;
          });
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
              Layer.fresh(CodeGraphIndexer.layer).pipe(
                Layer.provide(Layer.succeed(CodeGraphStore, observedStore(reopened))),
              ),
            );
            const before = finishSerial;
            let afterFinish = false;
            const result = yield* Context.get(freshIndexerContext, CodeGraphIndexer).index({
              cwd: repository,
              threadnoteHome: home,
              sourceOnly: true,
              vectorPolicy: 'off',
              force: true,
              onProgress: current =>
                Effect.sync(() => {
                  if (finishSerial > before && current.phase === 'materializing' && current.metrics?.candidateIndex)
                    afterFinish = true;
                }),
            });
            expect(afterFinish).toBe(true);
            return result;
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
        // A lost populated v3 hint index cannot trigger a repository-wide CREATE INDEX during ordinary publication.
        yield* Effect.sync(() => {
          const db = new Database(database(dirty));
          try {
            expect(
              db
                .query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_candidate_page_routes')
                .get()?.count,
            ).toBeGreaterThan(0);
            db.exec('DROP INDEX snapshot_candidate_page_routes_hint');
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
            expect(
              db.query("SELECT 1 FROM sqlite_master WHERE name = 'snapshot_candidate_page_routes_hint'").all(),
            ).toEqual([]);
            expect(db.query('SELECT state FROM snapshot_candidate_authority').all()).toEqual([{state: 'blocked'}]);
          } finally {
            db.close();
          }
        });
      }).pipe(TestClock.withLive),
    );
  });
});
