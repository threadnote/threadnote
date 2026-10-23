import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {writeFileSync} from '@threadnote/testing/node-fs';
import {join} from '@threadnote/testing/node-path';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {extractorSetIdentityFromPackProvenance} from '@threadnote/graph/indexer';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {parseRepositoryIdentityMetadata, resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphStoreError, type CodeGraphSnapshot, type RepositoryIdentity} from '@threadnote/graph/types';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {makeCodeGraphBuildReporter} from '@threadnote/graph/build_status';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '@threadnote/graph/admission_freshness';
import type {ProjectManifest} from '@threadnote/workspace/config';

const fixturePackProvenance = BUILTIN_LANGUAGE_PACK_REGISTRY.activePackProvenance(['main.ts']);
const incompatiblePackProvenance = fixturePackProvenance.map((pack, index) =>
  index === 0 ? {...pack, cacheIdentity: 'f'.repeat(64)} : pack,
);

describe('shared ready view attachment locking', () => {
  effectIt.effect('borrows ready evidence without observing the worktree while its builder holds the target lock', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const threadnoteHome = join(root, 'threadnote-home');
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const command = yield* CommandExecutor;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const identity = yield* resolveRepositoryIdentity(repositoryRoot);
      const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
      const snapshot = readySnapshot(identity);
      yield* store.activate(layout.databasePath, identity, snapshot, [], [], [], fixturePackProvenance);
      const before = yield* graph.statusForIdentity(threadnoteHome, identity, {
        observeWorktree: false,
        requestMaintenance: false,
      });
      expect(before.readySnapshot).toBeUndefined();

      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const builder = yield* makeCodeGraphBuildReporter(identity, layout);
      const owner = yield* Effect.forkChild(
        withExclusiveFileLock(
          fs,
          layout.lockPath,
          {
            onAcquired: () =>
              builder.markWorktreeLockHeld(true).pipe(Effect.andThen(Deferred.succeed(acquired, undefined))),
            onCompleted: () => builder.markWorktreeLockHeld(false),
            retryIntervalMilliseconds: 5,
            staleAfterMilliseconds: 120_000,
            waitTimeoutMilliseconds: 5_000,
          },
          Deferred.await(release),
        ),
      );
      yield* Deferred.await(acquired);
      const mutableCommand = command as {
        execute: typeof command.execute;
        executeBytes?: NonNullable<typeof command.executeBytes>;
      };
      const execute = command.execute;
      const executeBytes = command.executeBytes;
      let worktreeStatusCalls = 0;
      const countStatus = (executable: string, args: readonly string[]) => {
        if (executable === 'git' && args.includes('status')) worktreeStatusCalls += 1;
      };
      const borrowed = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          mutableCommand.execute = (executable, args, options) => {
            countStatus(executable, args);
            return execute(executable, args, options);
          };
          if (executeBytes) {
            mutableCommand.executeBytes = (executable, args, options) => {
              countStatus(executable, args);
              return executeBytes(executable, args, options);
            };
          }
        }),
        () =>
          graph.attachSharedReadySnapshot(threadnoteHome, identity, before, {
            allowBorrowedStale: true,
            requestMaintenance: false,
          }),
        () =>
          Effect.sync(() => {
            mutableCommand.execute = execute;
            mutableCommand.executeBytes = executeBytes;
          }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);

      expect(borrowed.readySnapshot?.id).toBe(snapshot.id);
      expect(borrowed.stale).toBe(true);
      expect(worktreeStatusCalls).toBe(0);
      expect(yield* store.readySnapshot(layout.databasePath, identity.worktreeId)).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('recovers an orphaned target lock and attaches an exact ready view', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const threadnoteHome = join(root, 'threadnote-home');
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const identity = yield* resolveRepositoryIdentity(repositoryRoot);
      const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
      const snapshot = readySnapshot(identity);
      yield* store.activate(layout.databasePath, identity, snapshot, [], [], [], fixturePackProvenance);
      yield* recordCodeGraphSnapshotAdmission(
        layout,
        snapshot,
        yield* observeCodeGraphAdmissionEnvironment(identity),
        BUILTIN_LANGUAGE_PACK_REGISTRY,
        false,
      );
      yield* store.acquireSnapshotLease(layout.databasePath, snapshot.id, 60_000);
      const before = yield* graph.statusForIdentity(threadnoteHome, identity, {
        observeWorktree: false,
        requestMaintenance: false,
      });
      expect(before.readySnapshot).toBeUndefined();
      yield* fs.makeDirectory(path.dirname(layout.lockPath), {recursive: true});
      yield* fs.writeFileString(
        layout.lockPath,
        JSON.stringify({processId: 999_999_999, token: 'orphaned-builder', version: 1}),
      );

      const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, before, {
        allowBorrowedStale: true,
        requestMaintenance: false,
      });
      const pointer = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
      expect(attached.readySnapshot?.id).toBe(snapshot.id);
      expect(attached.stale).toBe(false);
      expect(pointer?.id).toBe(snapshot.id);
      expect(yield* fs.exists(layout.lockPath)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('borrows compatible shared-ready evidence when pre-write capacity protection pauses promotion', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const threadnoteHome = join(root, 'threadnote-home');
      const path = yield* Path.Path;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const identity = yield* resolveRepositoryIdentity(repositoryRoot);
      const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
      const snapshot = readySnapshot(identity);
      yield* store.activate(layout.databasePath, identity, snapshot, [], [], [], fixturePackProvenance);
      yield* recordCodeGraphSnapshotAdmission(
        layout,
        snapshot,
        yield* observeCodeGraphAdmissionEnvironment(identity),
        BUILTIN_LANGUAGE_PACK_REGISTRY,
        false,
      );
      yield* store.acquireSnapshotLease(layout.databasePath, snapshot.id, 60_000);
      const before = yield* graph.statusForIdentity(threadnoteHome, identity);
      let promotionProbes = 0;

      const strict = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, before, {
        diskCapacityAvailableBytes: (_target, boundary) =>
          Effect.sync(() => {
            if (boundary.operation === 'promote ready code graph snapshot') promotionProbes += 1;
            return 0;
          }),
      });
      const pointerWhilePaused = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
      const borrowed = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, before, {
        allowBorrowedStale: true,
        diskCapacityAvailableBytes: (_target, boundary) =>
          Effect.sync(() => {
            if (boundary.operation === 'promote ready code graph snapshot') promotionProbes += 1;
            return 0;
          }),
      });

      expect(strict.readySnapshot).toBeUndefined();
      expect(strict.stale).toBe(true);
      expect(borrowed).toMatchObject({
        freshness: 'stale',
        readySnapshot: {id: snapshot.id, worktreeId: identity.worktreeId},
        stale: true,
      });
      expect(promotionProbes).toBeGreaterThan(0);
      expect(pointerWhilePaused).toBeUndefined();

      const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, before, {
        diskCapacityAvailableBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
      });
      const pointer = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
      expect(attached.readySnapshot?.id).toBe(snapshot.id);
      expect(pointer?.id).toBe(snapshot.id);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('surfaces an unclassified shared-ready promotion failure', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const peerRoot = join(root, 'unknown-failure-peer');
      const threadnoteHome = join(root, 'threadnote-home');
      const path = yield* Path.Path;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const sourceIdentity = yield* resolveRepositoryIdentity(repositoryRoot);
      yield* Effect.sync(() => git(repositoryRoot, ['worktree', 'add', '-b', 'unknown-failure-peer', peerRoot]));
      const peerIdentity = yield* resolveRepositoryIdentity(peerRoot);
      const layout = codeGraphLayout(path, threadnoteHome, sourceIdentity.checkoutId, sourceIdentity.worktreeId);
      const snapshot = readySnapshot(sourceIdentity);
      yield* store.activate(layout.databasePath, sourceIdentity, snapshot, [], [], [], fixturePackProvenance);
      yield* recordCodeGraphSnapshotAdmission(
        layout,
        snapshot,
        yield* observeCodeGraphAdmissionEnvironment(sourceIdentity),
        BUILTIN_LANGUAGE_PACK_REGISTRY,
        false,
      );
      yield* store.acquireSnapshotLease(layout.databasePath, snapshot.id, 60_000);
      const before = yield* graph.statusForIdentity(threadnoteHome, peerIdentity);
      const injected = CodeGraphStoreError.of('unclassified promotion failure');
      const mutableStore = store as {-readonly [Key in keyof typeof store]: (typeof store)[Key]};
      const promote = store.promote;
      const failure = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          mutableStore.promote = () => Effect.fail(injected);
        }),
        () =>
          graph
            .attachSharedReadySnapshot(threadnoteHome, peerIdentity, before, {allowBorrowedStale: true})
            .pipe(Effect.flip),
        () =>
          Effect.sync(() => {
            mutableStore.promote = promote;
          }),
      );
      expect(failure).toMatchObject({code: 'unknown', operation: 'code graph storage', recovery: 'diagnose'});
      expect(yield* store.readySnapshot(layout.databasePath, peerIdentity.worktreeId)).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('never borrows a repository-ready snapshot with an incompatible runtime contract', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const peerRoot = join(root, 'peer');
      const threadnoteHome = join(root, 'threadnote-home');
      const path = yield* Path.Path;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const sourceIdentity = yield* resolveRepositoryIdentity(repositoryRoot);
      yield* Effect.sync(() => git(repositoryRoot, ['worktree', 'add', '-b', 'incompatible-runtime-peer', peerRoot]));
      const peerIdentity = yield* resolveRepositoryIdentity(peerRoot);
      const layout = codeGraphLayout(path, threadnoteHome, sourceIdentity.checkoutId, sourceIdentity.worktreeId);
      const snapshot = {
        ...readySnapshot(peerIdentity),
        id: 'incompatible-active-pointer',
      };
      yield* store.activate(layout.databasePath, peerIdentity, snapshot, [], [], [], fixturePackProvenance);
      yield* store.promote(layout.databasePath, peerIdentity, snapshot.id);
      const mutableStore = store as {-readonly [Key in keyof typeof store]: (typeof store)[Key]};
      const snapshotPackProvenance = store.snapshotPackProvenance;
      const {attached, before} = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          mutableStore.snapshotPackProvenance = (databasePath, snapshotId) =>
            snapshotId === snapshot.id
              ? Effect.succeed(incompatiblePackProvenance)
              : snapshotPackProvenance(databasePath, snapshotId);
        }),
        () =>
          Effect.gen(function* () {
            const before = yield* graph.statusForIdentity(threadnoteHome, peerIdentity, {requestMaintenance: false});
            const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, peerIdentity, before, {
              allowBorrowedStale: true,
              requestMaintenance: false,
            });
            return {attached, before};
          }),
        () =>
          Effect.sync(() => {
            mutableStore.snapshotPackProvenance = snapshotPackProvenance;
          }),
      );

      expect(before.readySnapshot?.id).toBe(snapshot.id);
      expect(attached.readySnapshot).toBeUndefined();
      expect(observationFromCodeGraphStatus(attached)?.borrowedSnapshotId).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('skips an incompatible active pointer and borrows an older compatible repository snapshot', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const peerRoot = join(root, 'peer');
      const threadnoteHome = join(root, 'threadnote-home');
      const path = yield* Path.Path;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const sourceIdentity = yield* resolveRepositoryIdentity(repositoryRoot);
      yield* Effect.sync(() => git(repositoryRoot, ['worktree', 'add', '-b', 'compatible-runtime-peer', peerRoot]));
      const peerIdentity = yield* resolveRepositoryIdentity(peerRoot);
      const layout = codeGraphLayout(path, threadnoteHome, sourceIdentity.checkoutId, sourceIdentity.worktreeId);
      const compatible = {...readySnapshot(sourceIdentity), id: 'older-compatible-runtime'};
      const incompatible = {
        ...readySnapshot(peerIdentity),
        completedAt: '2026-08-09T00:00:00.000Z',
        id: 'newer-incompatible-runtime',
      };
      yield* store.activate(layout.databasePath, sourceIdentity, compatible, [], [], [], fixturePackProvenance);
      yield* store.activate(layout.databasePath, peerIdentity, incompatible, [], [], [], fixturePackProvenance);
      yield* store.promote(layout.databasePath, peerIdentity, incompatible.id);
      const mutableStore = store as {-readonly [Key in keyof typeof store]: (typeof store)[Key]};
      const snapshotPackProvenance = store.snapshotPackProvenance;
      const {attached, before} = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          mutableStore.snapshotPackProvenance = (databasePath, snapshotId) =>
            snapshotId === incompatible.id
              ? Effect.succeed(incompatiblePackProvenance)
              : snapshotPackProvenance(databasePath, snapshotId);
        }),
        () =>
          Effect.gen(function* () {
            const before = yield* graph.statusForIdentity(threadnoteHome, peerIdentity, {requestMaintenance: false});
            const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, peerIdentity, before, {
              allowBorrowedStale: true,
              requestMaintenance: false,
            });
            return {attached, before};
          }),
        () =>
          Effect.sync(() => {
            mutableStore.snapshotPackProvenance = snapshotPackProvenance;
          }),
      );

      expect(before.readySnapshot?.id).toBe(incompatible.id);
      expect(attached.readySnapshot?.id).toBe(compatible.id);
      expect(observationFromCodeGraphStatus(attached)?.borrowedSnapshotId).toBe(compatible.id);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('defers without mutation when the target builder is active, then attaches after release', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const threadnoteHome = join(root, 'threadnote-home');

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const command = yield* CommandExecutor;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const identity = yield* resolveRepositoryIdentity(repositoryRoot);
      const branch = (yield* runCommandEffect('git', [
        '-C',
        repositoryRoot,
        'symbolic-ref',
        '--quiet',
        '--short',
        'HEAD',
      ])).stdout.trim();
      const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
      const snapshot = readySnapshot(identity);
      yield* store.activate(layout.databasePath, identity, snapshot, [], [], [], fixturePackProvenance);
      yield* recordCodeGraphSnapshotAdmission(
        layout,
        snapshot,
        yield* observeCodeGraphAdmissionEnvironment(identity),
        BUILTIN_LANGUAGE_PACK_REGISTRY,
        false,
      );
      yield* store.acquireSnapshotLease(layout.databasePath, snapshot.id, 60_000);
      const before = yield* graph.statusForIdentity(threadnoteHome, identity);

      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const owner = yield* Effect.forkChild(
        withExclusiveFileLock(
          fs,
          layout.lockPath,
          {
            onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
            retryIntervalMilliseconds: 5,
            staleAfterMilliseconds: 120_000,
            waitTimeoutMilliseconds: 5_000,
          },
          Deferred.await(release),
        ),
      );
      yield* Deferred.await(acquired);
      const startedAt = performance.now();
      const deferred = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, before);
      const elapsedMilliseconds = performance.now() - startedAt;
      const pointerWhileBusy = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);

      const counts = {branchObservation: 0, fullIdentity: 0, git: 0, publicationProof: 0, status: 0};
      const mutableCommand = command as {
        execute: typeof command.execute;
        executeBytes?: NonNullable<typeof command.executeBytes>;
      };
      const execute = command.execute;
      const executeBytes = command.executeBytes;
      const observeInvocation = (executable: string, args: readonly string[]) => {
        if (executable !== 'git') return;
        counts.git += 1;
        if (args[2] === 'rev-parse' && args.includes('--show-toplevel')) counts.fullIdentity += 1;
        if (args[2] === 'status') {
          counts.status += 1;
          if (args.includes('--porcelain=v2')) counts.publicationProof += 1;
        }
      };
      const attached = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          mutableCommand.execute = (executable, args, options) => {
            observeInvocation(executable, args);
            return execute(executable, args, options);
          };
          if (executeBytes) {
            mutableCommand.executeBytes = (executable, args, options) => {
              observeInvocation(executable, args);
              return executeBytes(executable, args, options).pipe(
                Effect.tap(result =>
                  Effect.sync(() => {
                    if (executable !== 'git' || !args.includes('--abbrev-ref=loose')) return;
                    expect(args).toEqual([
                      '-C',
                      args[1],
                      'rev-parse',
                      '--path-format=absolute',
                      '--show-toplevel',
                      '--git-common-dir',
                      '--git-dir',
                      '--show-object-format',
                      'HEAD',
                      '--abbrev-ref=loose',
                      'HEAD',
                    ]);
                    expect(result.exitCode).toBe(0);
                    const metadata = parseRepositoryIdentityMetadata(result.stdout);
                    expect(metadata?.repoRoot).toBe(identity.repoRoot);
                    expect(metadata?.branch).toEqual({state: 'current', branch});
                    counts.branchObservation += 1;
                  }),
                ),
              );
            };
          }
        }),
        () => graph.attachSharedReadySnapshot(threadnoteHome, identity, before),
        () =>
          Effect.sync(() => {
            mutableCommand.execute = execute;
            mutableCommand.executeBytes = executeBytes;
          }),
      );
      const observed = {attached, before, counts, deferred, elapsedMilliseconds, pointerWhileBusy, snapshot};

      expect(observed.before.readySnapshot).toBeUndefined();
      expect(observed.deferred.readySnapshot).toBeUndefined();
      expect(observed.pointerWhileBusy).toBeUndefined();
      expect(observed.elapsedMilliseconds).toBeLessThan(500);
      expect(observed.attached.readySnapshot?.id).toBe(observed.snapshot.id);
      expect(observed.attached.stale).toBe(false);
      expect(observed.attached.identity.branch).toBe(branch);
      expect(observed.counts).toEqual({branchObservation: 1, fullIdentity: 1, git: 11, publicationProof: 1, status: 2});
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not promote an optimistic candidate after HEAD moves before target-lock acquisition', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const threadnoteHome = join(root, 'threadnote-home');
      const nextCommit = createNextCommit(repositoryRoot);
      git(repositoryRoot, ['reset', '--hard', 'HEAD~1']);

      const path = yield* Path.Path;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const identity = yield* resolveRepositoryIdentity(repositoryRoot);
      const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
      const snapshot = readySnapshot(identity);
      yield* store.activate(layout.databasePath, identity, snapshot, [], [], [], fixturePackProvenance);
      yield* recordCodeGraphSnapshotAdmission(
        layout,
        snapshot,
        yield* observeCodeGraphAdmissionEnvironment(identity),
        BUILTIN_LANGUAGE_PACK_REGISTRY,
        false,
      );
      yield* store.acquireSnapshotLease(layout.databasePath, snapshot.id, 60_000);
      const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, undefined, {
        afterOptimisticCandidate: () => Effect.sync(() => git(repositoryRoot, ['reset', '--hard', nextCommit])),
      });
      const pointer = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
      const observed = {attached, identity, pointer};

      expect(observed.attached.identity.headCommit).toBe(nextCommit);
      expect(observed.attached.identity.headCommit).not.toBe(observed.identity.headCommit);
      expect(observed.attached.readySnapshot).toBeUndefined();
      expect(observed.attached.stale).toBe(true);
      expect(observed.pointer).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reports the new identity as stale when HEAD moves immediately after promotion', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const threadnoteHome = join(root, 'threadnote-home');
      let nextCommit: string | undefined;

      const path = yield* Path.Path;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const identity = yield* resolveRepositoryIdentity(repositoryRoot);
      const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
      const snapshot = readySnapshot(identity);
      yield* store.activate(layout.databasePath, identity, snapshot, [], [], [], fixturePackProvenance);
      yield* recordCodeGraphSnapshotAdmission(
        layout,
        snapshot,
        yield* observeCodeGraphAdmissionEnvironment(identity),
        BUILTIN_LANGUAGE_PACK_REGISTRY,
        false,
      );
      yield* store.acquireSnapshotLease(layout.databasePath, snapshot.id, 60_000);
      const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, undefined, {
        afterPromotion: () =>
          Effect.sync(() => {
            nextCommit = createNextCommit(repositoryRoot);
          }),
      });
      const pointer = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
      const observed = {attached, pointer, snapshot};

      expect(nextCommit).toBeDefined();
      expect(observed.attached.identity.headCommit).toBe(nextCommit);
      expect(observed.attached.readySnapshot?.id).toBe(observed.snapshot.id);
      expect(observed.attached.stale).toBe(true);
      expect(observed.pointer?.id).toBe(observed.snapshot.id);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reports stale when a tracked file changes immediately after promotion without moving HEAD', () =>
    Effect.gen(function* () {
      const root = yield* temporaryRepository();
      const repositoryRoot = join(root, 'repository');
      const threadnoteHome = join(root, 'threadnote-home');

      const path = yield* Path.Path;
      const graph = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const identity = yield* resolveRepositoryIdentity(repositoryRoot);
      const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
      const snapshot = readySnapshot(identity);
      yield* store.activate(layout.databasePath, identity, snapshot, [], [], [], fixturePackProvenance);
      yield* recordCodeGraphSnapshotAdmission(
        layout,
        snapshot,
        yield* observeCodeGraphAdmissionEnvironment(identity),
        BUILTIN_LANGUAGE_PACK_REGISTRY,
        false,
      );
      yield* store.acquireSnapshotLease(layout.databasePath, snapshot.id, 60_000);
      const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, undefined, {
        afterPromotion: () =>
          Effect.sync(() => writeFileSync(join(repositoryRoot, 'main.ts'), 'export const attached = "dirty";\n')),
      });
      const pointer = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
      const observed = {attached, identity, pointer, snapshot};

      expect(observed.attached.identity.headCommit).toBe(observed.identity.headCommit);
      expect(observed.attached.readySnapshot?.id).toBe(observed.snapshot.id);
      expect(observed.attached.stale).toBe(true);
      expect(observed.pointer?.id).toBe(observed.snapshot.id);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect(
    'borrows the same scoped project graph in a fresh divergent worktree without publishing a pointer',
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryRepository();
        const repositoryRoot = join(root, 'repository');
        const sourceWorktree = join(root, 'scope-source');
        const freshWorktree = join(root, 'scope-fresh');
        const threadnoteHome = join(root, 'threadnote-home');
        const manifestPath = join(root, 'seed-manifest.yaml');
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(join(repositoryRoot, 'apps', 'docs'), {recursive: true});
        yield* fs.writeFileString(
          join(repositoryRoot, 'apps', 'docs', 'index.ts'),
          'export const scopedDocs = true;\n',
        );
        yield* fs.writeFileString(
          join(repositoryRoot, 'package.json'),
          JSON.stringify({private: true, workspaces: ['apps/*']}),
        );
        yield* fs.writeFileString(
          join(repositoryRoot, 'apps', 'docs', 'package.json'),
          JSON.stringify({name: '@fixture/docs'}),
        );
        yield* fs.makeDirectory(join(repositoryRoot, 'apps', 'other'), {recursive: true});
        yield* fs.writeFileString(join(repositoryRoot, 'apps', 'other', 'index.ts'), 'export const other = true;\n');
        yield* fs.writeFileString(
          join(repositoryRoot, 'apps', 'other', 'package.json'),
          JSON.stringify({name: '@fixture/other'}),
        );
        yield* Effect.sync(() => {
          git(repositoryRoot, ['add', 'package.json', 'apps']);
          git(repositoryRoot, ['commit', '-m', 'add scoped docs']);
          git(repositoryRoot, ['branch', 'scope-source']);
          git(repositoryRoot, ['branch', 'scope-fresh']);
          git(repositoryRoot, ['worktree', 'add', sourceWorktree, 'scope-source']);
          git(repositoryRoot, ['worktree', 'add', freshWorktree, 'scope-fresh']);
          writeFileSync(join(freshWorktree, 'fresh.ts'), 'export const freshOnly = true;\n');
          git(freshWorktree, ['add', 'fresh.ts']);
          git(freshWorktree, ['commit', '-m', 'diverge fresh worktree']);
        });
        const project = {
          graph: {closure: 'dependencies' as const, roots: ['apps/docs']},
          name: 'docs',
          path: sourceWorktree,
          seed: [],
          uri: 'threadnote://resources/repos/docs',
        } satisfies ProjectManifest;
        yield* fs.writeFileString(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: docs',
            `    path: ${sourceWorktree}`,
            '    seed: []',
            '    uri: threadnote://resources/repos/docs',
            '    graph:',
            '      closure: dependencies',
            '      roots: [apps/docs]',
            '',
          ].join('\n'),
        );

        const indexer = yield* CodeGraphIndexer;
        const graph = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: sourceWorktree, project, threadnoteHome});
        const freshIdentity = yield* resolveRepositoryIdentity(freshWorktree);
        const before = yield* graph.status(threadnoteHome, freshWorktree, {
          manifestPath,
          project: 'docs',
          requestMaintenance: false,
        });
        const borrowed = yield* graph.attachSharedReadySnapshot(threadnoteHome, freshIdentity, before, {
          allowBorrowedStale: true,
          requestMaintenance: false,
        });
        const scopeKey = observationFromCodeGraphStatus(borrowed)?.projectScope?.scope?.scopeKey;
        if (!scopeKey) throw new Error('Expected the borrowed status to preserve its project scope.');
        const layout = codeGraphLayout(
          path,
          threadnoteHome,
          freshIdentity.checkoutId,
          freshIdentity.worktreeId,
          scopeKey,
        );
        const active = yield* store.readySnapshot(layout.databasePath, freshIdentity.worktreeId, scopeKey);
        const found = yield* graph.inspect({
          cwd: freshWorktree,
          manifestPath,
          operation: 'query',
          project: 'docs',
          query: 'scopedDocs',
          refresh: false,
          requestMaintenance: false,
          statusObservation: observationFromCodeGraphStatus(borrowed),
          strictFreshness: false,
          threadnoteHome,
        });

        expect(before).toMatchObject({
          projectCoverage: {kind: 'project', project: 'docs'},
          readySnapshot: undefined,
          stale: true,
        });
        expect(borrowed).toMatchObject({
          freshness: 'stale',
          projectCoverage: {kind: 'project', project: 'docs'},
          readySnapshot: {id: indexed.snapshot.id, scopeId: indexed.snapshot.scopeId},
          stale: true,
        });
        expect(active).toBeUndefined();
        expect(found).toMatchObject({
          freshness: 'stale',
          projectCoverage: {kind: 'project', project: 'docs'},
          snapshot: {id: indexed.snapshot.id},
        });
        expect(found.nodes.some(node => node.name === 'scopedDocs')).toBe(true);
        expect(found.nodes.some(node => node.name === 'freshOnly')).toBe(false);

        yield* fs.writeFileString(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: docs',
            `    path: ${sourceWorktree}`,
            '    seed: []',
            '    uri: threadnote://resources/repos/docs',
            '    graph:',
            '      closure: dependencies',
            '      roots: [apps/other]',
            '',
          ].join('\n'),
        );
        const changedDefinition = yield* graph.status(threadnoteHome, freshWorktree, {
          manifestPath,
          project: 'docs',
          requestMaintenance: false,
        });
        const refused = yield* graph.attachSharedReadySnapshot(threadnoteHome, freshIdentity, changedDefinition, {
          allowBorrowedStale: true,
          requestMaintenance: false,
        });
        expect(refused.readySnapshot).toBeUndefined();
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('cleans up idempotently when the fixture root disappears before finalization', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* temporaryRepository();

      yield* fs.remove(root, {force: true, recursive: true});

      expect(yield* fs.exists(root)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});

const temporaryRepository = Effect.fn('test.temporaryViewAttachRepository')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* Effect.acquireRelease(fs.makeTempDirectory({prefix: 'threadnote-view-attach-lock-'}), directory =>
    fs.remove(directory, {force: true, recursive: true}).pipe(Effect.orDie),
  );
  const repositoryRoot = join(root, 'repository');
  execFileSync('git', ['init', repositoryRoot], {stdio: 'ignore'});
  execFileSync('git', ['-C', repositoryRoot, 'config', 'user.email', 'threadnote-test@example.invalid']);
  execFileSync('git', ['-C', repositoryRoot, 'config', 'user.name', 'Threadnote Test']);
  writeFileSync(join(repositoryRoot, 'main.ts'), 'export const attached = true;\n');
  git(repositoryRoot, ['add', 'main.ts']);
  git(repositoryRoot, ['commit', '-m', 'fixture']);
  return root;
});

function createNextCommit(repositoryRoot: string): string {
  writeFileSync(join(repositoryRoot, 'main.ts'), 'export const attached = "new-head";\n');
  git(repositoryRoot, ['add', 'main.ts']);
  git(repositoryRoot, ['commit', '-m', 'next']);
  return git(repositoryRoot, ['rev-parse', 'HEAD']);
}

function git(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function readySnapshot(identity: RepositoryIdentity): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: '2026-08-08T00:00:00.000Z',
    dirty: false,
    edgeCount: 0,
    extractorSet: extractorSetIdentityFromPackProvenance(fixturePackProvenance),
    fileCount: 0,
    id: 'snapshot-view-attach-lock',
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}
