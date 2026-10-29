import {Array as EffectArray} from 'effect';
import * as BunPath from '@effect/platform-bun/BunPath';
import {TestError} from '@threadnote/testing/test-error';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, Fiber, FileSystem, Layer, Schema, Semaphore} from 'effect';
import {TestClock} from 'effect/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {
  inspectCodeGraphWorksetStatus,
  prepareCodeGraphWorkset,
  type CodeGraphWorksetPrepareProgressV1,
} from '@threadnote/graph/workset_catalog/workset';
import {
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationReceiptInputV1,
  type CodeGraphWorksetCatalogGenerationReceiptV1,
} from '@threadnote/graph/workset_catalog/types';
import {
  CodeGraphStoreBusyError,
  CodeGraphStoreNoSpaceError,
  type CodeGraphIndexSummary,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import type {ResolvedWorkset, RuntimeConfig} from '@threadnote/workspace/config';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const mocks = vi.hoisted(() => ({
  maintainPage: vi.fn(),
  retirePreparation: vi.fn(),
  expandPath: vi.fn(),
  leaseGuard: vi.fn(),
  isolatedIndex: vi.fn(),
  publishGeneration: vi.fn(),
  readBridgeSummary: vi.fn(),
  readSnapshotMonikers: vi.fn(),
  readPublishedGeneration: vi.fn(),
  registerQualifiedRef: vi.fn(),
  replaceBridgeSet: vi.fn(),
  requireWorkset: vi.fn(),
  stageGeneration: vi.fn(),
  stageProjection: vi.fn(),
  worksetLock: vi.fn(),
}));

vi.mock('@threadnote/platform/file/lock', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/platform/file/lock')>()),
  withExclusiveFileLock: mocks.worksetLock,
}));

vi.mock('@threadnote/workspace/manifest', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/workspace/manifest')>()),
  requireWorkset: mocks.requireWorkset,
}));

vi.mock('@threadnote/platform/paths', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/platform/paths')>()),
  expandPath: mocks.expandPath,
}));

vi.mock('@threadnote/graph/workset_catalog/projection/builder', () => ({
  stageCodeGraphWorksetRoutingProjectionScoped: mocks.stageProjection,
}));

vi.mock('@threadnote/graph/cross_repository/snapshot_monikers', () => ({
  readCodeGraphReadySnapshotMonikers: mocks.readSnapshotMonikers,
}));

vi.mock('@threadnote/graph/cross_repository/store', () => ({
  readPublishedCodeGraphWorksetCatalogBridgeSetSummary: mocks.readBridgeSummary,
  replaceCodeGraphWorksetCatalogBridgeSet: mocks.replaceBridgeSet,
}));

vi.mock('@threadnote/graph/isolated/index', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/graph/isolated/index')>()),
  runIsolatedCodeGraphIndexSnapshot: mocks.isolatedIndex,
}));

vi.mock('@threadnote/graph/workset_catalog/store', () => ({
  maintainCodeGraphWorksetCatalogPreparationPage: mocks.maintainPage,
  publishCodeGraphWorksetCatalogGeneration: mocks.publishGeneration,
  readPublishedCodeGraphWorksetCatalogGeneration: mocks.readPublishedGeneration,
  registerCodeGraphQualifiedRef: mocks.registerQualifiedRef,
  retireCodeGraphWorksetCatalogPreparation: mocks.retirePreparation,
  stageCodeGraphWorksetCatalogGenerationFromReceipts: mocks.stageGeneration,
}));

describe('code graph workset mixed-coverage preparation', () => {
  const config: RuntimeConfig = {
    account: 'test',
    agentContextHome: '/threadnote-home',
    agentId: 'test-agent',
    manifestPath: '/manifest.json',
    user: 'test-user',
  };
  const identity = repositoryIdentity('ready');
  const summary = indexSummary(identity);
  const generation: CodeGraphWorksetCatalogGenerationReceiptV1 = {
    digest: Effect2.pipe('d', EffectString.repeat(64)),
    id: `cgwg_${Effect2.pipe('e', EffectString.repeat(40))}`,
    manifestDigest: Effect2.pipe('f', EffectString.repeat(64)),
    memberCount: 1,
    state: 'staging',
    worksetName: 'engineering',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkset.mockReturnValue(Effect.succeed(workset()));
    mocks.maintainPage.mockReturnValue(Effect.succeed({pendingCleanup: false}));
    mocks.retirePreparation.mockReturnValue(Effect.void);
    mocks.worksetLock.mockImplementation((_fs, _path, _options, effect) => effect);
    mocks.expandPath.mockImplementation((value: string) => Effect.succeed(value));
    mocks.stageProjection.mockReturnValue(
      Effect.succeed({
        assertLease: Effect.sync(() => mocks.leaseGuard()),
        receipt: {
          checkoutId: identity.checkoutId,
          commitId: summary.snapshot.commit,
          componentCount: 1,
          extractorGeneration: 1,
          projectionDigest: Effect2.pipe('b', EffectString.repeat(64)),
          projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
          repositoryId: identity.repositoryId,
          snapshotDigest: Effect2.pipe('c', EffectString.repeat(64)),
          snapshotId: summary.snapshot.id,
          symbolCount: 1,
          worktreeId: identity.worktreeId,
        },
        stats: {
          componentCount: 1,
          dependencyCount: 0,
          lookupKeysOmitted: 0,
          lookupKeysObserved: 0,
          pagesRead: 1,
          symbolsRead: 1,
          termsOmitted: 0,
          termsObserved: 0,
        },
      }),
    );
    mocks.stageGeneration.mockImplementation((_home: string, input: CodeGraphWorksetCatalogGenerationReceiptInputV1) =>
      Effect.succeed({...generation, manifestDigest: input.manifestDigest}),
    );
    mocks.publishGeneration.mockImplementation(
      (
        _home: string,
        input: {
          readonly beforePointerSwap?: () => Effect.Effect<void, unknown>;
        },
      ) =>
        (input.beforePointerSwap?.() ?? Effect.void).pipe(
          Effect.as({...generation, manifestDigest: codeGraphManifestDigestFromStage()}),
        ),
    );
    mocks.readPublishedGeneration.mockReturnValue(Effect.void);
    mocks.readBridgeSummary.mockReturnValue(Effect.void);
    mocks.readSnapshotMonikers.mockReturnValue(Effect.succeed([]));
    mocks.registerQualifiedRef.mockReturnValue(Effect.void);
    mocks.replaceBridgeSet.mockImplementation(
      (
        _home: string,
        input: {
          readonly bridges: readonly unknown[];
          readonly coverage?: {readonly rejectionCount: number};
          readonly generationId: string;
        },
      ) =>
        Effect.succeed({
          bridgeCount: input.bridges.length,
          coverage: input.coverage,
          digest: Effect2.pipe('9', EffectString.repeat(64)),
          generationId: input.generationId,
          replacedAt: '2026-01-01T00:00:00.000Z',
          resolverVersion: 1,
          state: 'staged',
          worksetName: 'engineering',
        }),
    );
  });

  it('publishes the non-empty ready subset and keeps the missing member receipt', async () => {
    const fs = FileSystem.makeNoop({exists: (path: string) => Effect.succeed(path === '/ready')});
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };

    const result = await runEffect(
      prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
      ),
    );

    expect(result.state).toBe('ready');
    expect(result.bridges).toMatchObject({bridgeCount: 0, rejectionCount: 0, state: 'ready'});
    expect(result.members).toEqual([
      expect.objectContaining({project: 'ready', state: 'ready'}),
      {project: 'missing', reason: 'missing-path', state: 'missing'},
    ]);
    expect(mocks.stageGeneration).toHaveBeenCalledOnce();
    expect(mocks.stageGeneration.mock.calls[0]?.[1]).toMatchObject({
      members: [
        {
          projectionDigest: Effect2.pipe('b', EffectString.repeat(64)),
          repositoryId: identity.repositoryId,
          repositoryKey: 'ready',
          snapshotId: summary.snapshot.id,
        },
      ],
    });
    expect(mocks.publishGeneration).toHaveBeenCalledOnce();
    expect(mocks.leaseGuard).toHaveBeenCalledTimes(4);
    expect(mocks.replaceBridgeSet).toHaveBeenCalledWith(
      config.agentContextHome,
      expect.objectContaining({bridges: [], generationId: generation.id}),
    );

    mocks.readPublishedGeneration.mockReturnValue(
      Effect.succeed({
        digest: generation.digest,
        id: generation.id,
        manifestDigest: result.manifestDigest,
        members: [
          {
            checkoutId: identity.checkoutId,
            commitId: summary.snapshot.commit,
            ordinal: 0,
            projectionDigest: Effect2.pipe('b', EffectString.repeat(64)),
            repositoryId: identity.repositoryId,
            repositoryKey: 'ready',
            snapshotDigest: Effect2.pipe('c', EffectString.repeat(64)),
            snapshotId: summary.snapshot.id,
            symbolCount: 1,
            worktreeId: identity.worktreeId,
          },
        ],
        worksetName: 'engineering',
      }),
    );
    const query = {
      status: () =>
        Effect.succeed({
          databasePath: '/db',
          freshness: 'current' as const,
          identity,
          languagePacks: [],
          readySnapshot: summary.snapshot,
          stale: false,
        }),
    };
    const status = await runEffect(
      inspectCodeGraphWorksetStatus(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(
          CodeGraphQueryService,
          // @ts-expect-error This focused adapter fixture supplies only the status method it exercises.
          query,
        ),
      ),
    );
    expect(status.members).toEqual([
      expect.objectContaining({project: 'ready', state: 'current'}),
      {project: 'missing', reason: 'missing-path', state: 'missing'},
    ]);
    expect(status.catalog.state).toBe('stale');
  });

  it('withholds every bridge when any ready member moniker surface is unreadable', async () => {
    const fs = FileSystem.makeNoop({exists: (path: string) => Effect.succeed(path === '/ready')});
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };
    mocks.readSnapshotMonikers.mockReturnValue(Effect.fail(TestError.make({message: 'malformed moniker row'})));

    const result = await runEffect(
      prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
      ),
    );

    expect(result.state).toBe('ready');
    expect(result.bridges).toMatchObject({
      bridgeCount: 0,
      rejectionCount: 0,
      state: 'unavailable',
      unavailableRepositories: ['ready'],
    });
    expect(mocks.replaceBridgeSet).toHaveBeenCalledWith(config.agentContextHome, {
      bridges: [],
      coverage: {
        diagnostics: ['moniker-read-failed'],
        failedRepositoryCount: 1,
        rejectionCount: 0,
        repositoriesRead: 0,
        state: 'failed',
      },
      generationId: generation.id,
    });
    expect(mocks.publishGeneration).toHaveBeenCalledOnce();
  });

  effectIt.effect('discards its exact staged generation when bridge preparation fails', () => {
    const fs = FileSystem.makeNoop({exists: (path: string) => Effect.succeed(path === '/ready')});
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };
    mocks.replaceBridgeSet.mockReturnValue(
      Effect.fail(CodeGraphWorksetCatalogError.of('capacity', 'bridge capacity fixture')),
    );

    return Effect.gen(function* () {
      const failure = yield* prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
        Effect.flip,
      );

      expect(failure).toMatchObject({reason: 'capacity'});
      expect(mocks.retirePreparation).toHaveBeenCalledOnce();
      expect(mocks.retirePreparation).toHaveBeenCalledWith(config.agentContextHome, {
        generationId: generation.id,
        projectionDigests: [Effect2.pipe('b', EffectString.repeat(64))],
      });
      expect(mocks.publishGeneration).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(Layer.mergeAll(ApplicationLayer, BunPath.layer)));
  });

  effectIt.effect('serializes identical prepares so a failed attempt cannot retire its successor', () =>
    Effect.gen(function* () {
      const fs = FileSystem.makeNoop({exists: (path: string) => Effect.succeed(path === '/ready')});
      const indexer: CodeGraphIndexerShape = {
        ensureCommit: () => Effect.die('not used'),
        index: () => Effect.succeed(summary),
      };
      const semaphore = yield* Semaphore.make(1);
      const events: string[] = [];
      let bridgeAttempt = 0;
      mocks.worksetLock.mockImplementation((_fs, _path, _options, effect) => semaphore.withPermits(1)(effect));
      mocks.replaceBridgeSet.mockImplementation((_home: string, input: {readonly generationId: string}) =>
        Effect.suspend(() => {
          bridgeAttempt += 1;
          if (bridgeAttempt === 1) {
            events.push('bridge-failed');
            return Effect.fail(CodeGraphWorksetCatalogError.of('capacity', 'bridge capacity fixture'));
          }
          events.push('bridge-ready');
          return Effect.succeed({
            bridgeCount: 0,
            coverage: {
              diagnostics: [],
              failedRepositoryCount: 0,
              rejectionCount: 0,
              repositoriesRead: 1,
              repositoryCount: 1,
              state: 'complete' as const,
            },
            digest: Effect2.pipe('9', EffectString.repeat(64)),
            generationId: input.generationId,
            replacedAt: '2026-01-01T00:00:00.000Z',
            resolverVersion: 1 as const,
            state: 'staged' as const,
            worksetName: 'engineering',
          });
        }),
      );
      mocks.retirePreparation.mockImplementation(() =>
        Effect.sync(() => {
          events.push('retired');
        }),
      );
      mocks.publishGeneration.mockImplementation(
        (
          _home: string,
          input: {
            readonly beforePointerSwap?: () => Effect.Effect<void, unknown>;
          },
        ) =>
          (input.beforePointerSwap?.() ?? Effect.void).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                events.push('published');
              }),
            ),
            Effect.as({...generation, manifestDigest: codeGraphManifestDigestFromStage()}),
          ),
      );

      const outcomes = yield* Effect.forEach(
        [prepareCodeGraphWorkset(config, 'engineering'), prepareCodeGraphWorkset(config, 'engineering')],
        effect =>
          effect.pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(CodeGraphIndexer, indexer),
            Effect.exit,
          ),
        {concurrency: 2},
      );

      expect(EffectArray.filter(outcomes, Exit.isFailure)).toHaveLength(1);
      expect(EffectArray.filter(outcomes, Exit.isSuccess)).toHaveLength(1);
      expect(mocks.retirePreparation).toHaveBeenCalledOnce();
      expect(mocks.publishGeneration).toHaveBeenCalledOnce();
      expect(events.indexOf('retired')).toBeGreaterThan(events.indexOf('bridge-failed'));
      expect(events.indexOf('published')).toBeGreaterThan(events.indexOf('retired'));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a definition changed after indexing but before the prepare lock', () => {
    const fs = FileSystem.makeNoop({exists: (path: string) => Effect.succeed(path === '/ready')});
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };
    mocks.requireWorkset
      .mockReturnValueOnce(Effect.succeed(workset()))
      .mockReturnValueOnce(Effect.succeed({...workset(), unresolvedProjects: ['renamed']}));

    return Effect.gen(function* () {
      const failure = yield* prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
        Effect.flip,
      );
      expect(failure).toMatchObject({reason: 'stale'});
      expect(mocks.stageProjection).not.toHaveBeenCalled();
      expect(mocks.publishGeneration).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer));
  });

  effectIt.effect('revalidates the definition in the final pointer fence', () => {
    const fs = FileSystem.makeNoop({exists: (path: string) => Effect.succeed(path === '/ready')});
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };
    mocks.requireWorkset
      .mockReturnValueOnce(Effect.succeed(workset()))
      .mockReturnValueOnce(Effect.succeed(workset()))
      .mockReturnValueOnce(Effect.succeed({...workset(), unresolvedProjects: ['deleted']}));

    return Effect.gen(function* () {
      const failure = yield* prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
        Effect.flip,
      );
      expect(failure).toMatchObject({reason: 'stale'});
      expect(mocks.publishGeneration).toHaveBeenCalledOnce();
      expect(mocks.retirePreparation).toHaveBeenCalledWith(config.agentContextHome, {
        generationId: generation.id,
        projectionDigests: [Effect2.pipe('b', EffectString.repeat(64))],
      });
    }).pipe(provideTestLayer(ApplicationLayer));
  });

  effectIt.effect('streams member progress and retries one typed transient index failure', () => {
    const fs = FileSystem.makeNoop({exists: (path: string) => Effect.succeed(path === '/ready')});
    const progress: CodeGraphWorksetPrepareProgressV1[] = [];
    let attempts = 0;
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: options =>
        Effect.suspend(() => {
          attempts += 1;
          return (options.onProgress?.({phase: 'waiting', reason: 'repository-lock'}) ?? Effect.void).pipe(
            Effect.andThen(
              attempts === 1
                ? Effect.fail(CodeGraphStoreBusyError.of('busy fixture', {operation: 'workset member index'}))
                : Effect.succeed(summary),
            ),
          );
        }),
    };

    return Effect.gen(function* () {
      const fiber = yield* prepareCodeGraphWorkset(config, 'engineering', {
        onProgress: event => Effect.sync(() => progress.push(event)),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
        Effect.forkChild({startImmediately: true}),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust('250 millis');
      const result = yield* Fiber.join(fiber);

      expect(attempts).toBe(2);
      expect(result.coverage).toEqual({complete: false, excluded: 0, failed: 0, missing: 1, ready: 1, requested: 2});
      expect(progress[0]).toMatchObject({completed: 0, phase: 'starting', total: 2});
      expect(progress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({attempt: 1, phase: 'indexing', project: 'ready'}),
          expect.objectContaining({attempt: 2, phase: 'indexing', project: 'ready'}),
          expect.objectContaining({activity: {phase: 'waiting', reason: 'repository-lock'}, project: 'ready'}),
          expect.objectContaining({member: expect.objectContaining({project: 'missing', state: 'missing'})}),
          expect.objectContaining({member: expect.objectContaining({project: 'ready', state: 'ready'})}),
          expect.objectContaining({completed: 2, phase: 'completed', resultState: 'ready'}),
        ]),
      );
      expect(EffectArray.map(progress, event => event.completed)).toEqual(
        [...EffectArray.map(progress, event => event.completed)].sort((left, right) => left - right),
      );
    }).pipe(provideTestLayer(ApplicationLayer));
  });

  effectIt.effect('overlaps isolated member builders up to the requested concurrency', () =>
    Effect.gen(function* () {
      const fs = FileSystem.makeNoop({exists: () => Effect.succeed(true)});
      const bothStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let started = 0;
      let maximumActive = 0;
      let activeProjections = 0;
      let maximumActiveProjections = 0;
      const inProcessIndex = vi.fn(() => Effect.die('Manager orchestrator must not index in process'));
      const indexer: CodeGraphIndexerShape = {
        ensureCommit: () => Effect.die('not used'),
        index: inProcessIndex,
      };
      mocks.requireWorkset.mockReturnValue(
        Effect.succeed({
          name: 'engineering',
          projects: [
            {name: 'api', path: '/api', seed: [], uri: 'threadnote://resources/repos/api'},
            {name: 'worker', path: '/worker', seed: [], uri: 'threadnote://resources/repos/worker'},
            {name: 'web', path: '/web', seed: [], uri: 'threadnote://resources/repos/web'},
          ],
          unresolvedProjects: [],
        }),
      );
      mocks.isolatedIndex.mockImplementation(() =>
        Effect.gen(function* () {
          active += 1;
          started += 1;
          maximumActive = Math.max(maximumActive, active);
          if (started === 2) yield* Deferred.succeed(bothStarted, undefined);
          yield* Deferred.await(release);
          active -= 1;
          return summary;
        }),
      );
      const stageProjection = mocks.stageProjection();
      mocks.stageProjection.mockClear();
      mocks.stageProjection.mockImplementation(() =>
        Effect.sync(() => {
          activeProjections += 1;
          maximumActiveProjections = Math.max(maximumActiveProjections, activeProjections);
        }).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(stageProjection),
          Effect.ensuring(Effect.sync(() => (activeProjections -= 1))),
        ),
      );

      const fiber = yield* prepareCodeGraphWorkset(config, 'engineering', {
        concurrency: 2,
        isolateBuilds: true,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
        Effect.forkChild({startImmediately: true}),
      );
      yield* Deferred.await(bothStarted);
      yield* Effect.yieldNow;

      expect(maximumActive).toBe(2);
      expect(started).toBe(2);
      expect(inProcessIndex).not.toHaveBeenCalled();
      expect(mocks.isolatedIndex).toHaveBeenCalledTimes(2);

      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result.coverage).toMatchObject({complete: true, ready: 3, requested: 3});
      expect(EffectArray.map(mocks.isolatedIndex.mock.calls, ([options]) => options.cwd).sort()).toEqual([
        '/api',
        '/web',
        '/worker',
      ]);
      expect(maximumActiveProjections).toBe(1);
      expect(mocks.stageProjection).toHaveBeenCalledTimes(3);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps actionable typed detail when every member index fails', () => {
    const fs = FileSystem.makeNoop({exists: (path: string) => Effect.succeed(path === '/ready')});
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.fail(CodeGraphStoreNoSpaceError.of('no space fixture', {operation: 'workset index'})),
    };

    return Effect.gen(function* () {
      const result = yield* prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
      );

      expect(result.state).toBe('failed');
      expect(result.coverage).toEqual({complete: false, excluded: 0, failed: 1, missing: 1, ready: 0, requested: 2});
      expect(result.members[0]).toMatchObject({
        detail: {
          code: 'no-space',
          errorType: 'CodeGraphStoreNoSpaceError',
          recovery: 'free-space',
          retryable: false,
        },
        reason: 'index-failed',
        state: 'failed',
      });
      expect(mocks.stageGeneration).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer));
  });

  it('does not publish an empty successful subset', async () => {
    const fs = FileSystem.makeNoop({exists: () => Effect.succeed(false)});
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.die('missing paths must not index'),
    };

    const result = await runEffect(
      prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
      ),
    );

    expect(result.state).toBe('failed');
    expect(mocks.stageGeneration).not.toHaveBeenCalled();
    expect(mocks.publishGeneration).not.toHaveBeenCalled();
  });
});

function workset(): ResolvedWorkset {
  return {
    name: 'engineering',
    projects: [
      {name: 'ready', path: '/ready', seed: [], uri: 'threadnote://resources/repos/ready'},
      {name: 'missing', path: '/missing', seed: [], uri: 'threadnote://resources/repos/missing'},
    ],
    unresolvedProjects: [],
  };
}

function repositoryIdentity(seed: string): RepositoryIdentity {
  const digest = sha256HexSync(seed);
  return {
    caseMode: 'sensitive',
    checkoutId: digest,
    displayName: seed,
    gitCommonDirectory: '.git',
    headCommit: Effect2.pipe('a', EffectString.repeat(40)),
    objectFormat: 'sha1',
    repoRoot: `/${seed}`,
    repositoryId: digest,
    worktreeId: digest,
  };
}

function indexSummary(identity: RepositoryIdentity): CodeGraphIndexSummary {
  return {
    diagnostics: [],
    durationMs: 1,
    identity,
    reusedFiles: 0,
    skippedFiles: 0,
    snapshot: {
      commit: identity.headCommit,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'test',
      fileCount: 1,
      id: 'snapshot-ready',
      repositoryId: identity.repositoryId,
      state: 'ready',
      symbolCount: 1,
      worktreeId: identity.worktreeId,
    },
  };
}

const stagedGenerationDigestSchema = Schema.StructWithRest(Schema.Struct({manifestDigest: Schema.String}), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

function codeGraphManifestDigestFromStage(): string {
  const input = mocks.stageGeneration.mock.calls[0]?.[1];
  if (input === undefined) return generationFallbackDigest();
  return Schema.decodeUnknownSync(stagedGenerationDigestSchema)(input).manifestDigest;
}

function generationFallbackDigest(): string {
  return Effect2.pipe('f', EffectString.repeat(64));
}
