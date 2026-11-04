import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  pipe,
} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {describe, expect} from 'vitest';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {makeResolutionCandidateEvidenceBuilder} from '@threadnote/graph/indexer/candidate_evidence';
import {emptyMaterializationReplayMetrics} from '@threadnote/graph/indexer/materialization';
import {CodeGraphStoreError} from '@threadnote/graph/types';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {
  codeGraphLayout,
  codeGraphBuilderAdmissionRoot,
  codeGraphBuilderAdmissionSlotPath,
  codeGraphDiskReservationRoot,
} from '@threadnote/graph/layout';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphParserPool} from '@threadnote/graph/parser_worker';
import {CodeGraphObservability, CodeGraphProcessActivity} from '@threadnote/graph/runtime_ports';
import {CodeGraphStore, type CodeGraphDirectPersistentCapacityProtector} from '@threadnote/graph/store';
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
             JOIN snapshot_candidate_synopsis_snapshots AS candidate ON candidate.snapshot_id = receipt.snapshot_id AND candidate.format_version = 4
             JOIN snapshot_candidate_synopsis_receipts AS proof ON proof.snapshot_key = candidate.snapshot_key AND proof.format_version = 4
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

    for (const point of ['preseal', 'postseal', 'prepromotion', 'postpromotion'] as const) {
      it.effect(`preserves actual committed proof and pointer state when interrupted at ${point}`, () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const source = yield* CodeGraphStore;
          const originalIndexer = yield* CodeGraphIndexer;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'candidate-commit-cancellation-'});
          const repository = path.join(root, 'repository'),
            home = path.join(root, 'home');
          yield* fs.makeDirectory(repository);
          yield* fs.makeDirectory(home);
          const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
          const commit = (message: string) =>
            git(['add', '.']).pipe(
              Effect.andThen(
                git([
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
                ]),
              ),
            );
          yield* git(['init', '--quiet']);
          yield* fs.writeFileString(path.join(repository, 'file.ts'), 'export const beforeBarrier = 1;\n');
          yield* commit('before barrier');
          const options = {
            cwd: repository,
            threadnoteHome: home,
            sourceOnly: true,
            vectorPolicy: 'off' as const,
            force: true,
            incrementalOverlay: false,
          };
          const old = yield* originalIndexer.index(options);
          const layout = codeGraphLayout(path, home, old.identity.checkoutId, old.identity.worktreeId);
          const oldGraph = yield* source.loadGraph(layout.databasePath, old.snapshot.id);
          yield* fs.writeFileString(path.join(repository, 'file.ts'), 'export const afterBarrier = 2;\n');
          yield* commit('after barrier');
          const reached = yield* Deferred.make<void>(),
            hold = yield* Deferred.make<void>();
          const barrier = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(hold)));
          const receipts = new Map<string, string>();
          const released: string[] = [];
          const admissionFiles = new Set<string>();
          const diskRoot = codeGraphDiskReservationRoot(path, home);
          const admissionRoot = codeGraphBuilderAdmissionRoot(path, home);
          const observedFs = {
            ...fs,
            rename: (...args: Parameters<typeof fs.rename>) =>
              fs.rename(...args).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (
                      EffectString.startsWith(diskRoot + path.sep)(args[1]) &&
                      EffectString.endsWith('.json')(args[1])
                    )
                      receipts.set(args[1], yield* fs.readFileString(args[1]));
                    if (
                      EffectString.startsWith(admissionRoot + path.sep)(args[1]) &&
                      EffectString.endsWith('.json')(args[1])
                    )
                      admissionFiles.add(args[1]);
                  }),
                ),
              ),
            remove: (...args: Parameters<typeof fs.remove>) =>
              fs.remove(...args).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (receipts.has(args[0])) released.push(args[0]);
                  }),
                ),
              ),
          };
          let targetId: string | undefined,
            finishChildren = 0,
            promoteCalls = 0,
            activationReleases = 0;
          const activationTokens = new Set<string>();
          const stages: {
            covered: CodeGraphDirectPersistentCapacityProtector;
            children: number;
            limit: number;
            closed: boolean;
          }[] = [];
          const wrap = (
            protector: CodeGraphDirectPersistentCapacityProtector,
            finishing: boolean,
          ): CodeGraphDirectPersistentCapacityProtector => {
            const originalWindow = protector.candidateWindow;
            expect(originalWindow).toBeTypeOf('function');
            const window: NonNullable<CodeGraphDirectPersistentCapacityProtector['candidateWindow']> = (
              plan,
              binding,
              gate,
              use,
            ) =>
              originalWindow!(plan, binding, gate, covered => {
                const record = {covered, children: 0, limit: plan.children, closed: false};
                if (!finishing) stages.push(record);
                const watched: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) => {
                  record.children++;
                  if (finishing) finishChildren++;
                  const finalReceipt = finishing && record.children === 1;
                  const before = finalReceipt && point === 'preseal' ? barrier : Effect.void;
                  const after = finalReceipt && point === 'postseal' ? barrier : Effect.void;
                  return covered(
                    boundary,
                    before.pipe(
                      Effect.andThen(transaction),
                      Effect.tap(() => after),
                    ),
                  );
                };
                // Delegate the exact original window, binding, gate and covered capabilities; no test-minted authority.
                return use(Object.assign(watched, covered)).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      record.closed = true;
                    }),
                  ),
                );
              });
            const forwarded: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) =>
              protector(boundary, transaction);
            return Object.assign(forwarded, protector, {candidateWindow: window});
          };
          const observedStore = CodeGraphStore.of({
            ...source,
            stageResolutionCandidateIndex: (database, input, protector) =>
              source.stageResolutionCandidateIndex!(database, input, protector ? wrap(protector, false) : protector),
            finishResolutionCandidateIndex: (database, input, protector) => {
              targetId = input.snapshotId;
              return source.finishResolutionCandidateIndex!(
                database,
                input,
                protector ? wrap(protector, true) : protector,
              );
            },
            activateStaged: (...args) =>
              source.activateStaged(...args).pipe(
                Effect.tap(lease =>
                  Effect.sync(() => {
                    if (Option.isSome(lease)) activationTokens.add(lease.value);
                  }),
                ),
              ),
            releaseSnapshotLease: (database, token) =>
              source.releaseSnapshotLease(database, token).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (activationTokens.has(token)) activationReleases++;
                  }),
                ),
              ),
            promote: (...args) => {
              const selected = args[2] === targetId;
              if (selected) promoteCalls++;
              return (selected && point === 'prepromotion' ? barrier : Effect.void).pipe(
                Effect.andThen(source.promote(...args)),
                Effect.tap(() => (selected && point === 'postpromotion' ? barrier : Effect.void)),
              );
            },
          });
          const indexer = Context.get(
            yield* Layer.build(
              Layer.fresh(CodeGraphIndexer.layer).pipe(
                Layer.provide(Layer.succeed(CodeGraphStore, observedStore)),
                Layer.provide(Layer.succeed(FileSystem.FileSystem, observedFs)),
              ),
            ),
            CodeGraphIndexer,
          );
          const owner = yield* indexer.index(options).pipe(Effect.forkChild);
          yield* Deferred.await(reached);
          if (!targetId) return yield* Effect.die('Barrier did not identify actual target');
          const readState = () =>
            Effect.sync(() => {
              const db = new Database(layout.databasePath, {readonly: true});
              try {
                return {
                  snapshot: db.query<{state: string}, [string]>('SELECT state FROM snapshots WHERE id=?').get(targetId!)
                    ?.state,
                  active: db
                    .query<{snapshot_id: string}, [string]>(
                      'SELECT snapshot_id FROM active_snapshots WHERE worktree_id=?',
                    )
                    .get(old.identity.worktreeId)?.snapshot_id,
                  activePointer: db
                    .query('SELECT * FROM active_snapshots WHERE worktree_id=?')
                    .get(old.identity.worktreeId),
                  legacyProof: db.query('SELECT * FROM snapshot_candidate_receipts WHERE snapshot_id=?').all(targetId!),
                  currentProof: db
                    .query(
                      `SELECT proof.* FROM snapshot_candidate_synopsis_receipts AS proof
                    JOIN snapshot_candidate_synopsis_snapshots AS owner ON owner.snapshot_key=proof.snapshot_key
                    WHERE owner.snapshot_id=?`,
                    )
                    .all(targetId!),
                };
              } finally {
                db.close();
              }
            });
          const atBarrier = yield* readState();
          expect(atBarrier.snapshot).toBe('ready');
          expect(atBarrier.active).toBe(point === 'postpromotion' ? targetId : old.snapshot.id);
          expect(yield* completeIndex(layout.databasePath, targetId)).toBe(point === 'preseal' ? 0 : 1);
          expect(finishChildren).toBe(1); // Existing namespace needs only the receipt child; actual proof state confirms it.
          expect(stages.length).toBeGreaterThan(0);
          expect(admissionFiles.size).toBeGreaterThan(0);
          expect(EffectArray.every(stages, stage => stage.closed)).toBe(true);
          const beforeChildren = finishChildren,
            beforePromotions = promoteCalls;
          const interrupter = yield* Effect.fiberId;
          yield* Fiber.interrupt(owner);
          const stopped = yield* Fiber.await(owner); // interrupts and observes the joined actual indexing owner
          expect(Exit.isFailure(stopped)).toBe(true);
          if (Exit.isFailure(stopped)) {
            expect(stopped.cause.reasons).toHaveLength(1);
            expect(Cause.hasInterruptsOnly(stopped.cause)).toBe(true);
            expect(
              EffectArray.some(
                stopped.cause.reasons,
                reason => Cause.isInterruptReason(reason) && reason.fiberId === interrupter,
              ),
            ).toBe(true);
          }
          expect(yield* readState()).toEqual(atBarrier);
          expect(yield* completeIndex(layout.databasePath, targetId)).toBe(point === 'preseal' ? 0 : 1);
          expect(finishChildren).toBe(beforeChildren);
          expect(promoteCalls).toBe(beforePromotions);
          expect(activationTokens.size).toBe(1);
          expect(activationReleases).toBe(1);
          expect(receipts.size).toBeGreaterThan(0);
          for (const [receipt, canonical] of receipts) {
            expect(canonical.length).toBeGreaterThan(0);
            expect(EffectArray.filter(released, value => value === receipt)).toHaveLength(1);
            expect(yield* fs.exists(receipt)).toBe(false);
          }
          expect(yield* fs.readDirectory(diskRoot)).toEqual([]);
          for (const file of admissionFiles) expect(yield* fs.exists(file)).toBe(false);
          for (const slot of [0, 1] as const) {
            expect(yield* fs.exists(codeGraphBuilderAdmissionSlotPath(path, home, slot))).toBe(false);
            expect(yield* fs.exists(codeGraphBuilderAdmissionSlotPath(path, home, slot) + '.owner.json')).toBe(false);
          }
          expect(yield* fs.exists(layout.databaseWriteLockPath)).toBe(false);
          const spare = EffectArray.findFirst(stages, stage => stage.children < stage.limit);
          expect(Option.isSome(spare)).toBe(true);
          let laterUse = 0;
          if (Option.isSome(spare)) {
            const revoked = yield* spare.value
              .covered(
                {operation: 'stage persistent code graph facts', rowCount: 0, finalFactBytes: 0},
                Effect.sync(() => {
                  laterUse++;
                }),
              )
              .pipe(Effect.exit);
            expect(Exit.isFailure(revoked)).toBe(true);
            if (Exit.isFailure(revoked))
              expect(revoked.cause.reasons).toMatchObject([
                {
                  error: {
                    _tag: 'CodeGraphStoreError',
                    message: 'Candidate capacity witness is stale, foreign, concurrent or exhausted.',
                  },
                },
              ]);
          }
          expect(laterUse).toBe(0);
          const activeGraph = yield* source.loadGraph(layout.databasePath, atBarrier.active!);
          if (point === 'postpromotion')
            expect(EffectArray.some(activeGraph.symbols, symbol => symbol.name === 'afterBarrier')).toBe(true);
          else
            expect({symbols: activeGraph.symbols, edges: activeGraph.edges}).toEqual({
              symbols: oldGraph.symbols,
              edges: oldGraph.edges,
            });
          const privateGraph = yield* source.loadGraph(layout.databasePath, targetId);
          expect(EffectArray.some(privateGraph.symbols, symbol => symbol.name === 'afterBarrier')).toBe(true);
        }).pipe(TestClock.withLive),
      );
    }

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
            stageResolutionCandidateIndex: (databasePath, input, protector) =>
              Effect.gen(function* () {
                expect(input.preparationGate?.candidateStage).toBeTypeOf('function');
                expect(input.preparationGate?.coveredPreparation).toBeTypeOf('function');
                return yield* source.stageResolutionCandidateIndex!(databasePath, input, protector);
              }),
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
        // A lost populated format4 namespace index cannot trigger repository-wide CREATE INDEX during ordinary publication.
        // The fresh format4 producer never populates either retained v3 route tree.
        yield* Effect.sync(() => {
          const db = new Database(database(dirty));
          try {
            expect(
              db
                .query<{readonly count: number}, []>(
                  'SELECT COUNT(*) AS count FROM snapshot_candidate_synopsis_snapshots',
                )
                .get()?.count,
            ).toBeGreaterThan(0);
            expect(db.query('SELECT COUNT(*) AS count FROM snapshot_candidate_page_routes').get()).toEqual({count: 0});
            db.exec('DROP INDEX snapshot_candidate_synopsis_snapshots_path');
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
              db.query("SELECT 1 FROM sqlite_master WHERE name = 'snapshot_candidate_synopsis_snapshots_path'").all(),
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
