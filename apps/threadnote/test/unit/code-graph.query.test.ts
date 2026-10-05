import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Fiber, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe} from 'vitest';
import type {CodeGraphEmbeddingIndexShape} from '@threadnote/graph/embedding';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CommandExecutor} from '@threadnote/platform/command';

import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {makeCodeGraphBuildReporter} from '@threadnote/graph/build_status';
import {CodeGraphIndexer, extractorSetIdentityFromPackProvenance} from '@threadnote/graph/indexer';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout, type CodeGraphLayout} from '@threadnote/graph/layout';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {
  CodeGraphQueryService,
  exactNodeQuery,
  neighborQuery,
  observationFromCodeGraphStatus,
  traversalQuery,
  type CodeGraphQueryTelemetryObserver,
} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore, type CodeGraphStoreShape} from '@threadnote/graph/store';
import {
  CodeGraphStoreTransientIoError,
  type CodeGraphEdge,
  type CodeGraphQueryNode,
  type CodeGraphSnapshot,
} from '@threadnote/graph/types';

const seed: CodeGraphQueryNode = {
  contentHash: 'seed-hash',
  exported: true,
  id: 'seed',
  kind: 'function',
  language: 'typescript',
  name: 'seed',
  path: 'src/seed.ts',
  qualifiedName: 'seed',
  score: 1,
  span: {column: 1, endColumn: 2, endLine: 1, line: 1},
};

const dependent: CodeGraphQueryNode = {
  ...seed,
  contentHash: 'dependent-hash',
  id: 'dependent',
  name: 'dependent',
  path: 'src/dependent.ts',
  qualifiedName: 'dependent',
};

const semanticMatch: CodeGraphQueryNode = {
  ...seed,
  contentHash: 'semantic-hash',
  id: 'semantic',
  kind: 'document',
  name: 'architecture.md',
  path: 'docs/architecture.md',
  qualifiedName: 'docs/architecture.md',
};

const edge: CodeGraphEdge = {
  confidence: 1,
  evidencePath: dependent.path,
  evidenceSpan: dependent.span,
  id: 'dependent-calls-seed',
  provenance: 'resolved',
  relation: 'calls',
  sourceId: dependent.id,
  sourceName: dependent.name,
  targetId: seed.id,
  targetName: seed.name,
};

const stableSeed: CodeGraphQueryNode = {
  ...seed,
  id: `cgs_${'a'.repeat(32)}`,
};

const stableDependent: CodeGraphQueryNode = {
  ...dependent,
  id: `cgs_${'b'.repeat(32)}`,
};

const stableEdge: CodeGraphEdge = {
  ...edge,
  id: 'stable-dependent-calls-seed',
  sourceId: stableDependent.id,
  targetId: stableSeed.id,
};

const layout: CodeGraphLayout = {
  checkoutId: 'fixture-checkout',
  databaseWriteLockPath: '/fixture/database-write.lock',
  databasePath: '/fixture/graph.sqlite',
  lockPath: '/fixture/graph.lock',
  repositoryRoot: '/fixture',
  staleMarkerPath: '/fixture/stale',
  vectorRoot: '/fixture/vectors',
  worktreeLockRoot: '/fixture/worktree-locks',
  worktreeId: 'fixture-worktree',
};

const embedding = {
  search: () => Effect.succeed(new Map<string, number>()),
} as unknown as CodeGraphEmbeddingIndexShape;

describe('code graph query budgets', () => {
  it.effect('avoids duplicate refresh:false snapshot reads and requests one path-free maintenance opportunity', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixtureRoot = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const root = mkdtempSync(join(tmpdir(), 'threadnote-query-maintenance-'));
            const repository = join(root, 'repository');
            const home = join(root, 'home');
            mkdirSync(repository, {recursive: true});
            mkdirSync(home, {recursive: true});
            execFileSync('git', ['init', '-q', repository]);
            execFileSync('git', ['-C', repository, 'config', 'user.name', 'Threadnote Test']);
            execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@threadnote.local']);
            writeFileSync(join(repository, 'source.ts'), 'export const value = 1;\n');
            execFileSync('git', ['-C', repository, 'add', 'source.ts']);
            execFileSync('git', ['-C', repository, 'commit', '-qm', 'fixture']);
            return {home, repository, root};
          }),
          fixture => Effect.sync(() => rmSync(fixture.root, {force: true, recursive: true})),
        );
        const requests = yield* Ref.make<readonly {allowIndexPreparation?: true; databasePath: string}[]>([]);
        const commandCalls = yield* Ref.make<readonly {args: readonly string[]; executable: string}[]>([]);
        const telemetryEvents: Array<{
          readonly disposition?: 'fallback' | 'skipped';
          readonly phase: string;
          readonly stage: string;
        }> = [];
        const telemetry = {
          skip: (phase, stage) =>
            Effect.sync(() => telemetryEvents.push({disposition: 'skipped', phase, stage})).pipe(Effect.asVoid),
          stage: (phase, stage, effect, disposition) =>
            Effect.sync(() => telemetryEvents.push({...(disposition ? {disposition} : {}), phase, stage})).pipe(
              Effect.andThen(effect),
            ),
        } satisfies CodeGraphQueryTelemetryObserver;
        const systemLayer = TestSystemInfoLayer;
        const liveCommandLayer = TestCommandExecutorLayer.pipe(
          Layer.provideMerge(Layer.merge(BunServices.layer, systemLayer)),
        );
        const commandLayer = Layer.effect(
          CommandExecutor,
          Effect.gen(function* () {
            const command = yield* CommandExecutor;
            const record = (executable: string, args: readonly string[]) =>
              Ref.update(commandCalls, current => [...current, {args: [...args], executable}]);
            return CommandExecutor.of({
              ...command,
              execute: (executable, args, options) =>
                record(executable, args).pipe(Effect.andThen(command.execute(executable, args, options))),
              executeBytes: (executable, args, options) =>
                record(executable, args).pipe(Effect.andThen(command.executeBytes!(executable, args, options))),
            });
          }),
        ).pipe(Layer.provide(liveCommandLayer));
        const maintenanceLayer = Layer.succeed(
          CodeGraphMaintenanceCoordinator,
          CodeGraphMaintenanceCoordinator.of({
            kickOrdinary: () =>
              Effect.die(TestError.make({message: 'query trigger test must not kick ordinary maintenance'})),
            kickReconciliation: () =>
              Effect.die(TestError.make({message: 'query trigger test must not kick reconciliation maintenance'})),
            kickResidual: () =>
              Effect.die(TestError.make({message: 'query trigger test must not kick residual maintenance'})),
            request: input =>
              Ref.update(requests, current => [
                ...current,
                {allowIndexPreparation: input.allowIndexPreparation, databasePath: input.databasePath},
              ]),
            tick: () =>
              Effect.die(TestError.make({message: 'query trigger test must not synchronously tick maintenance'})),
          }),
        );
        const snapshotRef = yield* Ref.make<CodeGraphSnapshot | undefined>(undefined);
        const readySnapshotFailure = yield* Ref.make<'commit' | 'none' | 'recent' | 'worktree'>('none');
        const readyBaseRef = yield* Ref.make<CodeGraphSnapshot | undefined>(undefined);
        const baseLookups = yield* Ref.make<readonly {databasePath: string; repositoryId: string; commit: string}[]>(
          [],
        );
        const leaseEvents = yield* Ref.make<readonly string[]>([]);
        const searchedSnapshotIds = yield* Ref.make<readonly string[]>([]);
        const failPathSearch = yield* Ref.make(false);
        const ensureCommitCalls = yield* Ref.make(0);
        const readyBaseSnapshotId = `cgsn_${'2'.repeat(40)}`;
        const emptyStoreReads = () => ({
          leasesAcquired: 0,
          leasesReleased: 0,
          provenance: 0,
          readyById: 0,
          readyByWorktree: 0,
        });
        const storeReads = yield* Ref.make(emptyStoreReads());
        const sessionCalls = yield* Ref.make(0);
        const readSql = {
          withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        } as unknown as SqlClient.SqlClient;
        const recordStoreRead = (
          field: 'leasesAcquired' | 'leasesReleased' | 'provenance' | 'readyById' | 'readyByWorktree',
        ) => Ref.update(storeReads, current => ({...current, [field]: current[field] + 1}));
        const storeLayer = Layer.succeed(
          CodeGraphStore,
          CodeGraphStore.of({
            acquireSnapshotLease: (_databasePath: string, snapshotId: string) =>
              recordStoreRead('leasesAcquired').pipe(
                Effect.andThen(Ref.update(leaseEvents, current => [...current, `acquire:${snapshotId}`])),
                Effect.as(`lease:${snapshotId}`),
              ),
            edgesForNodes: (_databasePath: string, snapshotId: string, ids: readonly string[]) =>
              Effect.succeed(snapshotId === readyBaseSnapshotId && ids.includes(stableSeed.id) ? [stableEdge] : []),
            readySnapshot: () =>
              recordStoreRead('readyByWorktree').pipe(
                Effect.andThen(Ref.get(readySnapshotFailure)),
                Effect.flatMap(failure =>
                  failure === 'worktree'
                    ? Effect.fail(CodeGraphStoreTransientIoError.of('transient worktree ready snapshot read'))
                    : Ref.get(snapshotRef),
                ),
              ),
            readySnapshotById: () => recordStoreRead('readyById').pipe(Effect.andThen(Ref.get(snapshotRef))),
            readySnapshotForCommit: (databasePath: string, repositoryId: string, commit: string) =>
              Ref.update(baseLookups, current => [...current, {commit, databasePath, repositoryId}]).pipe(
                Effect.andThen(Ref.get(readySnapshotFailure)),
                Effect.flatMap(failure =>
                  failure === 'commit'
                    ? Effect.fail(CodeGraphStoreTransientIoError.of('transient commit ready snapshot read'))
                    : Ref.get(readyBaseRef),
                ),
              ),
            recentReadySnapshotsForRepository: () =>
              Ref.get(readySnapshotFailure).pipe(
                Effect.flatMap(failure =>
                  failure === 'recent'
                    ? Effect.fail(CodeGraphStoreTransientIoError.of('transient recent ready snapshot read'))
                    : Effect.succeed([]),
                ),
              ),
            releaseSnapshotLease: (_databasePath: string, leaseToken: string) =>
              recordStoreRead('leasesReleased').pipe(
                Effect.andThen(Ref.update(leaseEvents, current => [...current, `release:${leaseToken}`])),
              ),
            searchSymbolsByPaths: (_databasePath: string, snapshotId: string, queries: readonly string[]) =>
              Ref.update(searchedSnapshotIds, current => [...current, snapshotId]).pipe(
                Effect.andThen(Ref.get(failPathSearch)),
                Effect.flatMap(fail =>
                  fail
                    ? Effect.fail(TestError.make({message: 'bounded impact read failed'}))
                    : Effect.succeed(queries.map(() => (snapshotId === readyBaseSnapshotId ? [stableSeed] : []))),
                ),
              ),
            snapshotPackProvenance: () => recordStoreRead('provenance').pipe(Effect.as([])),
            symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
              Effect.succeed([stableSeed, stableDependent].filter(node => ids.includes(node.id))),
            withSession: (_databasePath: string, effect: Effect.Effect<unknown, unknown, unknown>) =>
              Ref.update(sessionCalls, value => value + 1).pipe(
                Effect.andThen(effect.pipe(Effect.provideService(SqlClient.SqlClient, readSql))),
              ),
          } as unknown as CodeGraphStoreShape),
        );
        const dependencies = Layer.mergeAll(
          BunServices.layer,
          systemLayer,
          commandLayer,
          maintenanceLayer,
          storeLayer,
          CodeGraphLanguagePackRegistry.layer,
          Layer.succeed(
            CodeGraphIndexer,
            CodeGraphIndexer.of({
              ensureCommit: () =>
                Ref.update(ensureCommitCalls, count => count + 1).pipe(
                  Effect.andThen(Effect.fail(TestError.make({message: 'query trigger test must not ensure a commit'}))),
                ),
              index: () => Effect.die(TestError.make({message: 'query trigger test must not index'})),
            }),
          ),
          Layer.succeed(
            CodeGraphEmbeddingIndex,
            CodeGraphEmbeddingIndex.of({
              check: () => Effect.die(TestError.make({message: 'query trigger test must not check embeddings'})),
              ensure: () => Effect.die(TestError.make({message: 'query trigger test must not ensure embeddings'})),
              search: () => Effect.succeed(new Map()),
            }),
          ),
        );
        const layer = CodeGraphQueryService.layer.pipe(Layer.provideMerge(dependencies));

        yield* Effect.gen(function* () {
          const query = yield* CodeGraphQueryService;
          const identity = yield* resolveRepositoryIdentity(fixtureRoot.repository);
          const snapshot = {
            commit: identity.headCommit,
            completedAt: '2026-08-08T00:00:00.000Z',
            dirty: false,
            edgeCount: 0,
            extractorSet: extractorSetIdentityFromPackProvenance([]),
            fileCount: 1,
            id: `cgsn_${'1'.repeat(40)}`,
            repositoryId: identity.repositoryId,
            state: 'ready',
            symbolCount: 0,
            worktreeId: identity.worktreeId,
          } satisfies CodeGraphSnapshot;
          yield* Ref.set(snapshotRef, snapshot);
          yield* recordCodeGraphSnapshotAdmission(
            codeGraphLayout(yield* Path.Path, fixtureRoot.home, identity.checkoutId, identity.worktreeId),
            snapshot,
            yield* observeCodeGraphAdmissionEnvironment(identity),
            yield* CodeGraphLanguagePackRegistry,
            false,
          );
          const sessionResult = yield* query.withStatusSession!(
            fixtureRoot.home,
            fixtureRoot.repository,
            undefined,
            {observeWorktree: true, requestMaintenance: false},
            before =>
              Effect.gen(function* () {
                const activeStore = yield* CodeGraphStore;
                const token = yield* activeStore.acquireSnapshotLease(before.databasePath, snapshot.id, 60_000);
                const after = yield* query.statusForIdentity(fixtureRoot.home, before.identity, {
                  observeWorktree: true,
                  requestMaintenance: false,
                });
                yield* activeStore.releaseSnapshotLease(before.databasePath, token);
                return {after, before};
              }),
          );
          expect(yield* Ref.get(sessionCalls)).toBe(1);
          expect(sessionResult.before.readySnapshot?.id).toBe(snapshot.id);
          expect(sessionResult.after.readySnapshot?.id).toBe(snapshot.id);
          expect(sessionResult.after.freshness).toBe('current');

          yield* Ref.set(commandCalls, []);
          const publishedExpected = {
            checkoutId: identity.checkoutId,
            repositoryId: identity.repositoryId,
            worktreeId: identity.worktreeId,
          };
          const cleanPublished = yield* query.statusForPublishedIdentity(
            fixtureRoot.home,
            fixtureRoot.repository,
            publishedExpected,
            {observeWorktree: true, requestMaintenance: false},
          );
          expect(cleanPublished.freshness).toBe('current');
          expect(
            (yield* Ref.get(commandCalls)).filter(call => call.executable === 'git' && call.args.includes('status')),
          ).toHaveLength(1);

          yield* Ref.set(snapshotRef, {...snapshot, repositoryId: 'f'.repeat(64)});
          const changedRemoteStatus = yield* query.statusForIdentity(fixtureRoot.home, identity, {
            observeWorktree: true,
            requestMaintenance: false,
          });
          expect(changedRemoteStatus).toMatchObject({freshness: 'stale', readySnapshot: undefined, stale: true});
          yield* Ref.set(snapshotRef, snapshot);

          const racedPublished = yield* query.statusForPublishedIdentity(
            fixtureRoot.home,
            fixtureRoot.repository,
            publishedExpected,
            {
              afterIdentityObserved: () =>
                Effect.sync(() =>
                  writeFileSync(join(fixtureRoot.repository, 'source.ts'), 'export const value = 2;\n'),
                ),
              observeWorktree: true,
              requestMaintenance: false,
            },
          );
          expect(racedPublished).toMatchObject({freshness: 'stale', stale: true});
          yield* Effect.sync(() =>
            writeFileSync(join(fixtureRoot.repository, 'source.ts'), 'export const value = 1;\n'),
          );

          yield* Effect.sync(() =>
            writeFileSync(join(fixtureRoot.repository, 'source.ts'), 'export const value = 2;\n'),
          );
          const dirtyPublished = yield* query.statusForPublishedIdentity(
            fixtureRoot.home,
            fixtureRoot.repository,
            publishedExpected,
            {observeWorktree: true, requestMaintenance: false},
          );
          expect(dirtyPublished).toMatchObject({freshness: 'stale', stale: true});
          yield* Effect.sync(() =>
            writeFileSync(join(fixtureRoot.repository, 'source.ts'), 'export const value = 1;\n'),
          );

          yield* Ref.set(snapshotRef, undefined);
          const deferredColdStatus = yield* query.statusForIdentity(fixtureRoot.home, identity, {
            observeWorktree: false,
            requestMaintenance: false,
          });
          const exactColdAttach = yield* query.attachSharedReadySnapshot(
            fixtureRoot.home,
            identity,
            deferredColdStatus,
            {requestMaintenance: false, telemetry},
          );
          expect(observationFromCodeGraphStatus(deferredColdStatus)?.overlay).toBeUndefined();
          expect(observationFromCodeGraphStatus(exactColdAttach)?.overlay).toEqual({dirty: false});
          expect(observationFromCodeGraphStatus(exactColdAttach)?.readySnapshotId).toBe(
            exactColdAttach.readySnapshot?.id,
          );
          expect(telemetryEvents.splice(0)).toEqual([
            {
              disposition: 'fallback',
              phase: 'graph.query.snapshot',
              stage: 'query-worktree-observation',
            },
          ]);
          const worktreeLayout = codeGraphLayout(
            yield* Path.Path,
            fixtureRoot.home,
            identity.checkoutId,
            identity.worktreeId,
          );
          const fs = yield* FileSystem.FileSystem;
          const activeBuilderLockOptions = {
            retryIntervalMilliseconds: 1,
            staleAfterMilliseconds: 1_000,
            waitTimeoutMilliseconds: 1_000,
          } as const;
          const builder = yield* makeCodeGraphBuildReporter(identity, worktreeLayout);
          yield* withExclusiveFileLock(
            fs,
            worktreeLayout.lockPath,
            activeBuilderLockOptions,
            builder.markWorktreeLockHeld(true).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  yield* Ref.set(readySnapshotFailure, 'worktree');
                  const transientStatus = yield* query.statusForIdentity(fixtureRoot.home, identity, {
                    observeWorktree: false,
                    requestMaintenance: false,
                  });
                  expect(transientStatus).toMatchObject({readySnapshot: undefined, stale: true});

                  yield* Ref.set(readySnapshotFailure, 'commit');
                  const transientAttach = yield* query.attachSharedReadySnapshot(
                    fixtureRoot.home,
                    identity,
                    transientStatus,
                    {requestMaintenance: false},
                  );
                  expect(transientAttach).toMatchObject({readySnapshot: undefined, stale: true});

                  yield* Ref.set(readySnapshotFailure, 'recent');
                  const transientBorrow = yield* query.attachSharedReadySnapshot(
                    fixtureRoot.home,
                    identity,
                    transientStatus,
                    {allowBorrowedStale: true, requestMaintenance: false},
                  );
                  expect(transientBorrow).toMatchObject({readySnapshot: undefined, stale: true});
                }),
              ),
              Effect.ensuring(builder.markWorktreeLockHeld(false)),
            ),
          );
          yield* Ref.set(readySnapshotFailure, 'worktree');
          const nonBuilderReadFailure = yield* withExclusiveFileLock(
            fs,
            worktreeLayout.lockPath,
            activeBuilderLockOptions,
            query
              .statusForIdentity(fixtureRoot.home, identity, {
                observeWorktree: false,
                requestMaintenance: false,
              })
              .pipe(Effect.flip),
          );
          expect(nonBuilderReadFailure).toBeInstanceOf(CodeGraphStoreTransientIoError);
          const unlockedReadFailure = yield* query
            .statusForIdentity(fixtureRoot.home, identity, {observeWorktree: false, requestMaintenance: false})
            .pipe(Effect.flip);
          expect(unlockedReadFailure).toBeInstanceOf(CodeGraphStoreTransientIoError);
          yield* Ref.set(readySnapshotFailure, 'none');
          yield* Ref.set(snapshotRef, snapshot);

          yield* Ref.set(commandCalls, []);
          const deferredHotStatus = yield* query.status(fixtureRoot.home, fixtureRoot.repository, {
            observeWorktree: false,
            requestMaintenance: false,
          });
          const statusCommandCalls = yield* Ref.get(commandCalls);
          expect(statusCommandCalls.length).toBeGreaterThan(0);
          expect(statusCommandCalls.some(call => call.executable === 'git')).toBe(true);
          expect(JSON.stringify(deferredHotStatus)).not.toContain('statusObservation');
          yield* Ref.set(commandCalls, []);
          yield* Ref.set(storeReads, emptyStoreReads());
          const deferredHotInspection = yield* query.inspect({
            cwd: fixtureRoot.repository,
            nodeId: `cgs_${'a'.repeat(32)}`,
            operation: 'node',
            refresh: false,
            requestMaintenance: false,
            statusObservation: observationFromCodeGraphStatus(deferredHotStatus),
            threadnoteHome: fixtureRoot.home,
          });
          expect(deferredHotInspection.freshness).toBe('deferred');
          expect(yield* Ref.get(commandCalls)).toEqual([]);
          expect(yield* Ref.get(storeReads)).toEqual({
            leasesAcquired: 0,
            leasesReleased: 0,
            provenance: 1,
            readyById: 0,
            readyByWorktree: 1,
          });
          expect(yield* Ref.get(ensureCommitCalls)).toBe(0);
          for (const refresh of [undefined, true] as const) {
            yield* Ref.set(storeReads, emptyStoreReads());
            const refreshedInspection = yield* query.inspect({
              cwd: fixtureRoot.repository,
              nodeId: `cgs_${'a'.repeat(32)}`,
              operation: 'node',
              ...(refresh === undefined ? {} : {refresh}),
              requestMaintenance: false,
              statusObservation: observationFromCodeGraphStatus(deferredHotStatus),
              threadnoteHome: fixtureRoot.home,
            });
            expect(refreshedInspection.freshness).toBe('current');
            expect(yield* Ref.get(storeReads)).toEqual({
              leasesAcquired: 0,
              leasesReleased: 0,
              provenance: refresh === true ? 2 : 1,
              readyById: 0,
              readyByWorktree: 2,
            });
          }

          const telemetryStatus = yield* query.status(fixtureRoot.home, fixtureRoot.repository, {
            observeWorktree: false,
            requestMaintenance: false,
            telemetry,
          });
          expect(JSON.stringify(telemetryStatus)).toBe(JSON.stringify(deferredHotStatus));
          expect(telemetryEvents.splice(0)).toEqual([
            {phase: 'graph.query.status', stage: 'query-repository-identity'},
            {disposition: 'skipped', phase: 'graph.query.status', stage: 'query-worktree-observation'},
          ]);

          const exactTelemetryStatus = yield* query.statusForIdentity(fixtureRoot.home, identity, {
            observeWorktree: true,
            requestMaintenance: false,
            telemetry,
          });
          telemetryEvents.splice(0);
          yield* Ref.set(storeReads, emptyStoreReads());
          const strictInspection = yield* query.inspect({
            cwd: fixtureRoot.repository,
            nodeId: `cgs_${'a'.repeat(32)}`,
            operation: 'node',
            refresh: false,
            requestMaintenance: false,
            statusObservation: observationFromCodeGraphStatus(exactTelemetryStatus),
            strictFreshness: true,
            telemetry,
            threadnoteHome: fixtureRoot.home,
          });
          expect(strictInspection.freshness).toBe('current');
          expect(telemetryEvents.splice(0)).toEqual([
            {phase: 'graph.query.execute', stage: 'query-strict-reobservation'},
          ]);
          expect(yield* Ref.get(storeReads)).toEqual({
            leasesAcquired: 0,
            leasesReleased: 0,
            provenance: 1,
            readyById: 0,
            readyByWorktree: 1,
          });

          const boundedImpact = yield* query.inspect({
            baseCommit: 'f'.repeat(40),
            baseCommitPolicy: 'ready-only',
            cwd: fixtureRoot.repository,
            operation: 'impact',
            query: 'changed paths',
            refresh: false,
            requestMaintenance: false,
            seedQueries: ['deleted.ts'],
            strictFreshness: true,
            threadnoteHome: fixtureRoot.home,
          });
          expect(boundedImpact.freshness).toBe('current');
          expect(boundedImpact.warnings).toContain(
            'The requested impact base has no ready current-format snapshot; deleted-path recovery was skipped without starting indexing.',
          );

          const readyBase = {
            ...snapshot,
            commit: 'f'.repeat(40),
            dirty: false,
            id: readyBaseSnapshotId,
            worktreeId: 'base-worktree',
          } satisfies CodeGraphSnapshot;
          yield* Ref.set(readyBaseRef, readyBase);
          yield* Ref.set(baseLookups, []);
          yield* Ref.set(leaseEvents, []);
          yield* Ref.set(searchedSnapshotIds, []);
          yield* Ref.set(storeReads, emptyStoreReads());
          const readyBaseImpact = yield* query.inspect({
            baseCommit: readyBase.commit,
            baseCommitPolicy: 'ready-only',
            cwd: fixtureRoot.repository,
            depth: 1,
            operation: 'impact',
            query: 'changed paths',
            refresh: false,
            requestMaintenance: false,
            seedQueries: ['deleted.ts'],
            strictFreshness: true,
            threadnoteHome: fixtureRoot.home,
          });
          expect(readyBaseImpact.nodes.map(node => node.id)).toContain(stableDependent.id);
          expect(readyBaseImpact.warnings.join('\n')).toContain(`base snapshot ${readyBaseSnapshotId}`);
          expect(readyBaseImpact.warnings.join('\n')).not.toContain('deleted-path recovery was skipped');
          expect(yield* Ref.get(baseLookups)).toEqual([
            {
              commit: readyBase.commit,
              databasePath: join(
                fixtureRoot.home,
                'indexes',
                'code-graph',
                'repositories',
                identity.checkoutId,
                'graph-v3.sqlite',
              ),
              repositoryId: identity.repositoryId,
            },
          ]);
          expect(yield* Ref.get(searchedSnapshotIds)).toEqual([snapshot.id, readyBaseSnapshotId]);
          expect(yield* Ref.get(leaseEvents)).toEqual([
            `acquire:${readyBaseSnapshotId}`,
            `release:lease:${readyBaseSnapshotId}`,
          ]);
          expect(yield* Ref.get(ensureCommitCalls)).toBe(0);
          expect(yield* Ref.get(storeReads)).toEqual({
            leasesAcquired: 1,
            leasesReleased: 1,
            provenance: 2,
            readyById: 0,
            readyByWorktree: 1,
          });

          yield* Ref.set(failPathSearch, true);
          yield* Ref.set(leaseEvents, []);
          const failedReadyBaseImpact = yield* query
            .inspect({
              baseCommit: readyBase.commit,
              baseCommitPolicy: 'ready-only',
              cwd: fixtureRoot.repository,
              operation: 'impact',
              query: 'changed paths',
              refresh: false,
              requestMaintenance: false,
              seedQueries: ['deleted.ts'],
              strictFreshness: true,
              threadnoteHome: fixtureRoot.home,
            })
            .pipe(Effect.flip);
          expect(failedReadyBaseImpact).toEqual(TestError.make({message: 'bounded impact read failed'}));
          expect(yield* Ref.get(leaseEvents)).toEqual([
            `acquire:${readyBaseSnapshotId}`,
            `release:lease:${readyBaseSnapshotId}`,
          ]);
          expect(yield* Ref.get(ensureCommitCalls)).toBe(0);
          yield* Ref.set(failPathSearch, false);
          yield* Ref.set(readyBaseRef, undefined);

          yield* Ref.set(storeReads, emptyStoreReads());
          const fallbackInspection = yield* query.inspect({
            cwd: fixtureRoot.repository,
            nodeId: `cgs_${'a'.repeat(32)}`,
            operation: 'node',
            refresh: false,
            requestMaintenance: false,
            telemetry,
            threadnoteHome: fixtureRoot.home,
          });
          expect(fallbackInspection.freshness).toBe('deferred');
          expect(telemetryEvents.splice(0)).toEqual([
            {
              disposition: 'fallback',
              phase: 'graph.query.execute',
              stage: 'query-repository-identity',
            },
            {disposition: 'skipped', phase: 'graph.query.execute', stage: 'query-worktree-observation'},
            {disposition: 'skipped', phase: 'graph.query.execute', stage: 'query-strict-reobservation'},
          ]);
          expect(yield* Ref.get(storeReads)).toEqual({
            leasesAcquired: 0,
            leasesReleased: 0,
            provenance: 1,
            readyById: 0,
            readyByWorktree: 1,
          });

          const assertOneRequest = Effect.fn(function* (run: Effect.Effect<unknown, unknown>) {
            yield* Ref.set(requests, []);
            yield* run;
            const observed = yield* Ref.get(requests);
            expect(observed).toHaveLength(1);
            expect(observed[0]?.allowIndexPreparation).toBe(true);
          });

          yield* assertOneRequest(query.status(fixtureRoot.home, fixtureRoot.repository, {observeWorktree: false}));
          const status = yield* query.statusForIdentity(fixtureRoot.home, identity, {observeWorktree: false});
          expect(observationFromCodeGraphStatus(status)).toMatchObject({identity});
          expect(observationFromCodeGraphStatus(status)?.overlay).toBeUndefined();
          expect(yield* Ref.get(requests)).toHaveLength(2);
          yield* assertOneRequest(query.attachSharedReadySnapshot(fixtureRoot.home, identity, status));
          yield* assertOneRequest(
            query.inspect({
              cwd: fixtureRoot.repository,
              nodeId: `cgs_${'a'.repeat(32)}`,
              operation: 'node',
              refresh: false,
              threadnoteHome: fixtureRoot.home,
            }),
          );
          yield* Ref.set(requests, []);
          yield* query.inspect({
            cwd: fixtureRoot.repository,
            nodeId: `cgs_${'a'.repeat(32)}`,
            operation: 'node',
            refresh: false,
            requestMaintenance: false,
            threadnoteHome: fixtureRoot.home,
          });
          expect(yield* Ref.get(requests)).toEqual([]);
          yield* query.status(fixtureRoot.home, fixtureRoot.repository, {
            observeWorktree: false,
            requestMaintenance: false,
          });
          expect(yield* Ref.get(requests)).toEqual([]);
          yield* query.attachSharedReadySnapshot(fixtureRoot.home, identity, status, {requestMaintenance: false});
          expect(yield* Ref.get(requests)).toEqual([]);
        }).pipe(provideTestLayer(layer));
      }),
    ),
  );

  it.effect('round-trips an exact stable node ID without fuzzy search', () =>
    Effect.gen(function* () {
      const requestedIds: string[][] = [];
      const store = {
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.sync(() => {
            requestedIds.push([...ids]);
            return ids.includes(stableSeed.id) ? [stableSeed] : [];
          }),
      } as unknown as CodeGraphStoreShape;

      const found = yield* exactNodeQuery(store, layout.databasePath, 'snapshot', stableSeed.id);
      const missing = yield* exactNodeQuery(store, layout.databasePath, 'snapshot', `cgs_${'f'.repeat(32)}`);

      expect(found).toMatchObject({edges: [], nodes: [{id: stableSeed.id, score: 1}], warnings: []});
      expect(missing.nodes).toEqual([]);
      expect(missing.warnings).toEqual([expect.stringContaining('was not found in the selected snapshot')]);
      expect(requestedIds).toEqual([[stableSeed.id], [`cgs_${'f'.repeat(32)}`]]);
    }),
  );

  it.effect('traverses exact-ID neighbors with explicit direction, depth, provenance, and result bounds', () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly direction: string;
        readonly ids: readonly string[];
        readonly limit: number;
        readonly provenances: readonly string[];
      }> = [];
      const store = {
        edgesForNodes: (
          _databasePath: string,
          _snapshotId: string,
          ids: readonly string[],
          direction: string,
          limit: number,
          provenances: readonly string[],
        ) =>
          Effect.sync(() => {
            calls.push({direction, ids: [...ids], limit, provenances: [...provenances]});
            return ids.includes(stableSeed.id) ? [stableEdge] : [];
          }),
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.succeed([stableSeed, stableDependent].filter(symbol => ids.includes(symbol.id))),
      } as unknown as CodeGraphStoreShape;

      const result = yield* neighborQuery(store, layout.databasePath, 'snapshot', stableSeed.id, 'incoming', 2, 10, 1, [
        'declared',
        'resolved',
      ]);

      expect(result.nodes.map(node => node.id)).toEqual([stableSeed.id, stableDependent.id]);
      expect(result.edges).toEqual([expect.objectContaining({id: stableEdge.id, provenance: 'resolved'})]);
      expect(calls).toEqual([
        {
          direction: 'incoming',
          ids: [stableSeed.id],
          limit: 10,
          provenances: ['declared', 'resolved'],
        },
      ]);
    }),
  );

  it.effect('reports bounded exact-ID neighborhoods instead of silently truncating them', () =>
    Effect.gen(function* () {
      const extra = {...stableDependent, id: `cgs_${'c'.repeat(32)}`, name: 'extra'};
      const store = {
        edgesForNodes: () =>
          Effect.succeed([
            stableEdge,
            {...stableEdge, id: 'extra-calls-seed', sourceId: extra.id, sourceName: extra.name},
          ]),
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.succeed([stableSeed, stableDependent, extra].filter(symbol => ids.includes(symbol.id))),
      } as unknown as CodeGraphStoreShape;

      const result = yield* neighborQuery(store, layout.databasePath, 'snapshot', stableSeed.id, 'incoming', 2, 10, 1, [
        'resolved',
      ]);

      expect(result.nodes.map(node => node.id)).toEqual([stableSeed.id, stableDependent.id]);
      expect(result.warnings).toContain('Neighbor traversal reached a configured result limit.');
    }),
  );

  it.effect('returns lexical evidence when semantic search exceeds a surface-specific deadline', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const store = {
        edgesForNodes: () =>
          Effect.sync(() => {
            calls.push('adjacency');
            return [];
          }),
        searchSymbolsMany: () =>
          Effect.sync(() => {
            calls.push('search');
            return [[seed]];
          }),
        symbolsByIds: () =>
          Effect.sync(() => {
            calls.push('hydration');
            return [];
          }),
      } as unknown as CodeGraphStoreShape;
      const delayedEmbedding = {
        search: () =>
          Effect.sync(() => {
            calls.push('semantic');
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as CodeGraphEmbeddingIndexShape;

      const fiber = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        'serialize concurrent tasks via mutual exclusion',
        'both',
        20,
        40,
        2,
        ['resolved'],
        delayedEmbedding,
        '/fixture/home',
        layout,
        false,
        undefined,
        undefined,
        {semanticMilliseconds: 750, traversalMilliseconds: 1_000},
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(751);
      const result = yield* Fiber.join(fiber);

      expect(result.nodes).toEqual([expect.objectContaining({id: seed.id, score: 1})]);
      expect(result.warnings).toContain(
        'Semantic graph search reached its elapsed-time budget; lexical graph results were returned.',
      );
      expect(calls).toEqual(['search', 'semantic', 'adjacency', 'hydration']);
    }),
  );

  it.effect('skips semantic search when lexical search fills the seed budget', () =>
    Effect.gen(function* () {
      const lexicalMatches = Array.from({length: 12}, (_, index) => ({
        ...seed,
        contentHash: `lexical-${index}-hash`,
        id: `lexical-${index}`,
        name: `lexical${index}`,
        qualifiedName: `lexical${index}`,
      }));
      let semanticCalls = 0;
      const store = {
        edgesForNodes: () => Effect.succeed([]),
        searchSymbolsMany: () => Effect.succeed([lexicalMatches]),
        symbolsByIds: () => Effect.succeed([]),
      } as unknown as CodeGraphStoreShape;
      const unnecessaryEmbedding = {
        search: () =>
          Effect.sync(() => {
            semanticCalls += 1;
            return new Map<string, number>();
          }),
      } as unknown as CodeGraphEmbeddingIndexShape;

      const result = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        'director dependency injection',
        'both',
        12,
        1,
        0,
        ['resolved'],
        unnecessaryEmbedding,
        '/fixture/home',
        layout,
        false,
      );

      expect(result.nodes).toHaveLength(12);
      expect(semanticCalls).toBe(0);
      expect(result.warnings).not.toContain(
        'Semantic graph search reached its elapsed-time budget; lexical graph results were returned.',
      );
    }),
  );

  it.effect('starts the ordinary traversal budget after lexical seed acquisition', () =>
    Effect.gen(function* () {
      const lexicalMatches = Array.from({length: 12}, (_, index) => ({
        ...seed,
        contentHash: `lexical-${index}-hash`,
        id: `lexical-${index}`,
        name: `lexical${index}`,
        qualifiedName: `lexical${index}`,
      }));
      const calls: string[] = [];
      const store = {
        edgesForNodes: () =>
          Effect.sync(() => {
            calls.push('adjacency');
            return [];
          }),
        searchSymbolsMany: () =>
          Effect.gen(function* () {
            calls.push('search');
            yield* TestClock.adjust(2_001);
            return [lexicalMatches];
          }),
        symbolsByIds: () =>
          Effect.sync(() => {
            calls.push('hydration');
            return [];
          }),
      } as unknown as CodeGraphStoreShape;

      const result = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        'high-cardinality exact identifier',
        'both',
        20,
        40,
        1,
        ['resolved'],
        embedding,
        '/fixture/home',
        layout,
        false,
      );

      expect(result.nodes).toHaveLength(12);
      expect(result.warnings).not.toContain('Graph traversal reached its elapsed-time budget; results are partial.');
      expect(calls).toEqual(['search', 'adjacency', 'hydration']);
    }),
  );

  it.effect('returns an explicit bounded package-local match or honest absence hint', () =>
    Effect.gen(function* () {
      const mobile = {...seed, id: 'mobile', packageName: 'MobileApp'};
      const web = {...seed, id: 'web', packageName: 'WebApp'};
      const requestedLimits: number[] = [];
      const store = {
        edgesForNodes: () => Effect.succeed([]),
        searchSymbolsMany: (_databasePath: string, _snapshotId: string, _queries: readonly string[], limit: number) =>
          Effect.sync(() => {
            requestedLimits.push(limit);
            return [[web, mobile]];
          }),
        symbolsByIds: () => Effect.succeed([]),
      } as unknown as CodeGraphStoreShape;

      const inspect = (packageName: string) =>
        traversalQuery(
          store,
          layout.databasePath,
          'snapshot',
          'session clear',
          'both',
          12,
          1,
          0,
          ['resolved'],
          embedding,
          '/fixture/home',
          layout,
          false,
          undefined,
          undefined,
          {},
          packageName,
        );
      const found = yield* inspect('MobileApp');
      const absent = yield* inspect('DesktopApp');

      expect(found.nodes.map(node => node.id)).toEqual(['mobile']);
      expect(found.scope).toEqual({
        evidence: 'bounded-lexical-observation',
        lexicalCandidatesExamined: 2,
        lexicalMatches: 1,
        packageName: 'MobileApp',
        type: 'package',
      });
      expect(absent.nodes).toEqual([]);
      expect(absent.scope).toMatchObject({lexicalCandidatesExamined: 2, lexicalMatches: 0});
      expect(absent.warnings.join('\n')).toContain('package-local absence hint, not proof');
      expect(requestedLimits).toEqual([240, 240]);
    }),
  );

  it.effect('accepts semantic evidence that takes longer than the traversal budget', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const store = {
        edgesForNodes: () =>
          Effect.sync(() => {
            calls.push('adjacency');
            return [];
          }),
        searchSymbolsMany: () =>
          Effect.sync(() => {
            calls.push('search');
            return [[]];
          }),
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.sync(() => {
            if (ids.length > 0) calls.push('hydration');
            return ids.includes(semanticMatch.id) ? [semanticMatch] : [];
          }),
      } as unknown as CodeGraphStoreShape;
      const delayedEmbedding = {
        search: () =>
          Effect.sync(() => {
            calls.push('semantic');
          }).pipe(Effect.andThen(Effect.sleep(5_000)), Effect.as(new Map([[semanticMatch.id, 0.9]]))),
      } as unknown as CodeGraphEmbeddingIndexShape;

      const fiber = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        'architecture documentation overview',
        'both',
        20,
        40,
        2,
        ['resolved'],
        delayedEmbedding,
        '/fixture/home',
        layout,
        false,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(5_001);
      const result = yield* Fiber.join(fiber);

      expect(result.nodes).toEqual([expect.objectContaining({id: semanticMatch.id, score: 0.9})]);
      expect(result.warnings).not.toContain(
        'Semantic graph search reached its elapsed-time budget; lexical graph results were returned.',
      );
      expect(calls).toEqual(['search', 'semantic', 'hydration', 'adjacency']);
    }),
  );

  it.effect('narrows an exact impact symbol before reverse traversal', () =>
    Effect.gen(function* () {
      const exact = {
        ...seed,
        id: 'exact-impact-seed',
        name: 'unsafeCompletionClassification',
        qualifiedName: 'unsafeCompletionClassification',
        score: 0.01,
      };
      const fuzzy = {
        ...seed,
        id: 'fuzzy-impact-seed',
        name: 'ResourcePathUnsafe',
        path: 'src/effect/resource-store.ts',
        qualifiedName: 'ResourcePathUnsafe',
        score: 1,
      };
      const exactDependent = {
        ...dependent,
        id: 'exact-impact-dependent',
        name: 'completionClassification',
        qualifiedName: 'completionClassification',
      };
      const fuzzyDependent = {...dependent, id: 'fuzzy-impact-dependent'};
      const inspectedSeeds: string[][] = [];
      let semanticSearches = 0;
      const store = {
        edgesForNodes: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.sync(() => {
            inspectedSeeds.push([...ids]);
            return [
              {...edge, id: 'exact-edge', sourceId: exactDependent.id, targetId: exact.id},
              {...edge, id: 'fuzzy-edge', sourceId: fuzzyDependent.id, targetId: fuzzy.id},
            ].filter(candidate => candidate.targetId !== undefined && ids.includes(candidate.targetId));
          }),
        searchSymbolsMany: () => Effect.succeed([[fuzzy, exact]]),
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.succeed([exactDependent, fuzzyDependent].filter(node => ids.includes(node.id))),
      } as unknown as CodeGraphStoreShape;
      const unusedEmbedding = {
        search: () =>
          Effect.sync(() => {
            semanticSearches += 1;
            return new Map<string, number>();
          }),
      } as unknown as CodeGraphEmbeddingIndexShape;

      const result = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        exact.name,
        'incoming',
        20,
        40,
        1,
        ['resolved'],
        unusedEmbedding,
        '/fixture/home',
        layout,
        true,
      );

      expect(inspectedSeeds).toEqual([[exact.id]]);
      expect(result.nodes.map(node => node.id)).toEqual([exactDependent.id, exact.id]);
      expect(result.edges.map(candidate => candidate.id)).toEqual(['exact-edge']);
      expect(semanticSearches).toBe(0);
    }),
  );

  it.effect('round-trips exact impact node IDs with the same reverse dependencies as an exact name', () =>
    Effect.gen(function* () {
      let lexicalSearches = 0;
      let semanticSearches = 0;
      const store = {
        edgesForNodes: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.succeed(ids.includes(stableSeed.id) ? [stableEdge] : []),
        searchSymbolsMany: () =>
          Effect.sync(() => {
            lexicalSearches += 1;
            return [[stableSeed]];
          }),
        symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.succeed([stableSeed, stableDependent].filter(node => ids.includes(node.id))),
      } as unknown as CodeGraphStoreShape;
      const unusedEmbedding = {
        search: () =>
          Effect.sync(() => {
            semanticSearches += 1;
            return new Map<string, number>();
          }),
      } as unknown as CodeGraphEmbeddingIndexShape;
      const impact = (query: string) =>
        traversalQuery(
          store,
          layout.databasePath,
          'snapshot',
          query,
          'incoming',
          20,
          40,
          1,
          ['resolved'],
          unusedEmbedding,
          '/fixture/home',
          layout,
          true,
        );

      const byName = yield* impact(stableSeed.name);
      const byId = yield* impact(stableSeed.id);
      const missing = yield* impact(`cgs_${'f'.repeat(32)}`);

      expect(byName.nodes.map(node => node.id)).toEqual([stableDependent.id, stableSeed.id]);
      expect(byName.edges.map(candidate => candidate.id)).toEqual([stableEdge.id]);
      expect(byId).toEqual(byName);
      expect(missing.nodes).toEqual([]);
      expect(missing.warnings).toContain('Impact selector did not resolve to indexed code symbols.');
      expect(lexicalSearches).toBe(1);
      expect(semanticSearches).toBe(0);
    }),
  );

  for (const phase of ['search', 'adjacency', 'hydration'] as const) {
    it.effect(`enforces the absolute deadline after ${phase}`, () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const store = {
          edgesForNodes: () =>
            Effect.gen(function* () {
              calls.push('adjacency');
              if (phase === 'adjacency') yield* TestClock.adjust(2_001);
              return [edge];
            }),
          searchSymbolsByPaths: () =>
            Effect.gen(function* () {
              calls.push('search');
              if (phase === 'search') yield* TestClock.adjust(2_001);
              return [[seed]];
            }),
          symbolsByIds: () =>
            Effect.gen(function* () {
              calls.push('hydration');
              if (phase === 'hydration') yield* TestClock.adjust(2_001);
              return [dependent];
            }),
        } as unknown as CodeGraphStoreShape;

        const result = yield* traversalQuery(
          store,
          layout.databasePath,
          'snapshot',
          'seed',
          'incoming',
          20,
          40,
          2,
          ['resolved'],
          embedding,
          '/fixture/home',
          layout,
          true,
          [seed.path],
        );

        expect(result.warnings).toContain('Graph traversal reached its elapsed-time budget; results are partial.');
        expect(calls).toEqual(
          phase === 'search'
            ? ['search']
            : phase === 'adjacency'
              ? ['search', 'adjacency']
              : ['search', 'adjacency', 'hydration'],
        );
      }),
    );
  }

  it.effect('fairly batches deleted-path recovery frontiers above the store node-ID limit', () =>
    Effect.gen(function* () {
      const changedPaths = Array.from({length: 200}, (_, index) => `src/deleted-${String(index).padStart(3, '0')}.ts`);
      const baseGroups = changedPaths.map((path, pathIndex) =>
        Array.from({length: 20}, (_, symbolIndex) => ({
          ...seed,
          contentHash: `base-${pathIndex}-${symbolIndex}-hash`,
          id: `base-${pathIndex}-${symbolIndex}`,
          name: `deleted${pathIndex}_${symbolIndex}`,
          path,
          qualifiedName: `deleted${pathIndex}_${symbolIndex}`,
        })),
      );
      const currentNodes = new Map(
        changedPaths.map((_, index) => {
          const id = `current-${index}`;
          return [
            id,
            {
              ...dependent,
              contentHash: `${id}-hash`,
              id,
              name: `survivor${index}`,
              path: `src/survivor-${String(index).padStart(3, '0')}.ts`,
              qualifiedName: `survivor${index}`,
            },
          ] as const;
        }),
      );
      const baseFrontierSizes: number[] = [];
      const baseFrontiers: string[][] = [];
      const store = {
        edgesForNodes: (_databasePath: string, snapshotId: string, ids: readonly string[]) =>
          Effect.sync(() => {
            if (snapshotId !== 'base') return [];
            baseFrontierSizes.push(ids.length);
            baseFrontiers.push([...ids]);
            return ids.map((id, index) => {
              const pathIndex = Number(id.split('-')[1]);
              const current = currentNodes.get(`current-${pathIndex}`);
              if (!current) throw TestError.make({message: `Missing current recovery fixture for ${id}.`});
              return {
                ...edge,
                evidencePath: current.path,
                id: `base-recovery-${index}`,
                sourceId: current.id,
                sourceName: current.name,
                targetId: id,
                targetName: `deleted${pathIndex}_0`,
              };
            });
          }),
        searchSymbolsByPaths: (_databasePath: string, snapshotId: string) =>
          Effect.succeed(snapshotId === 'base' ? baseGroups : changedPaths.map(() => [])),
        symbolsByIds: (_databasePath: string, snapshotId: string, ids: readonly string[]) =>
          Effect.succeed(
            snapshotId === 'snapshot'
              ? ids.flatMap(id => {
                  const node = currentNodes.get(id);
                  return node ? [node] : [];
                })
              : [],
          ),
      } as unknown as CodeGraphStoreShape;

      const result = yield* traversalQuery(
        store,
        layout.databasePath,
        'snapshot',
        'changed paths',
        'incoming',
        200,
        500,
        1,
        ['resolved'],
        embedding,
        '/fixture/home',
        layout,
        true,
        changedPaths,
        'base',
      );

      expect(baseFrontierSizes).toEqual(Array.from({length: 8}, () => 500));
      expect(new Set(baseFrontiers[0].slice(0, 200).map(id => Number(id.split('-')[1]))).size).toBe(200);
      expect(result.nodes).toHaveLength(200);
      expect(result.nodes.map(node => node.id)).toContain('current-199');
      expect(result.warnings.some(warning => warning.includes('recovered 200 deleted path(s)'))).toBe(true);
    }),
  );
});
