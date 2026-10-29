import {it as effectIt} from '@effect/vitest';
import {Context, Crypto, Deferred, Effect, FileSystem, Fiber, Layer, Path, Ref} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphStore} from '@threadnote/graph/store';
import {readCodeGraphBuildStatuses} from '@threadnote/graph/build_status';
import {codeGraphScopeViewKey} from '@threadnote/graph/scope/identity';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import type {CodeGraphSnapshot} from '@threadnote/graph/types';
import {buildOwnedCleanSnapshot} from '@threadnote/graph/indexer/build';
import {measureCodeGraphAttribution} from '@threadnote/graph/indexer/build_coordination';
import type {CodeGraphIndexResourceGate} from '@threadnote/graph/indexer/types';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {CodeGraphLanguagePackError} from '@threadnote/graph/languages/types';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

describe('indexer build coordination wiring', () => {
  effectIt.effect('starts attribution timing after preparation admission wait', () =>
    Effect.gen(function* () {
      const preparationGate: CodeGraphIndexResourceGate = effect =>
        Effect.sleep('100 millis').pipe(Effect.andThen(effect));
      const fiber = yield* measureCodeGraphAttribution(
        preparationGate,
        Effect.sleep('25 millis').pipe(Effect.as('attributed')),
      ).pipe(Effect.forkChild({startImmediately: true}));
      yield* TestClock.adjust('125 millis');
      expect(yield* Fiber.join(fiber)).toEqual([25, 'attributed']);
    }),
  );

  effectIt.effect('releases structural gates while explicit vectors wait and rejects a superseded attachment', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-index-vector-publication-'});
      const home = path.join(root, 'home');
      const repository = path.join(root, 'repository');
      yield* fs.makeDirectory(repository, {recursive: true});
      const source = path.join(repository, 'module.ts');
      yield* fs.writeFileString(source, 'export function initialValue() { return 1; }\n');
      const git = (...args: string[]) =>
        Effect.sync(() => execFileSync('git', ['-C', repository, ...args], {stdio: 'pipe'}));
      yield* git('init', '--quiet');
      yield* git('config', 'user.email', 'test@example.invalid');
      yield* git('config', 'user.name', 'Threadnote Test');
      yield* git('add', '.');
      yield* git('commit', '--quiet', '-m', 'fixture');
      const entered = yield* Deferred.make<CodeGraphSnapshot>();
      const release = yield* Deferred.make<void>();
      const attached = yield* Ref.make(false);
      const embedding = CodeGraphEmbeddingIndex.of({
        check: () => Effect.succeed({state: 'unavailable', reason: 'test model barrier'}),
        search: () => Effect.succeed(new Map()),
        ensure: (_home, _layout, snapshot, _symbols, options) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, snapshot);
            yield* Deferred.await(release);
            if (!options?.publication) return yield* Effect.die('Expected a captured publication fence.');
            yield* options.publication.attach(Ref.set(attached, true));
            return {embedded: 1, reused: 0, ready: true};
          }),
      });
      const indexerContext = yield* Layer.build(Layer.fresh(CodeGraphIndexer.layer)).pipe(
        Effect.provideService(CodeGraphEmbeddingIndex, embedding),
      );
      const indexer = Context.get(indexerContext, CodeGraphIndexer);
      const first = yield* indexer.index({cwd: repository, threadnoteHome: home}).pipe(Effect.forkChild);
      const original = yield* Effect.raceFirst(
        Deferred.await(entered),
        Fiber.join(first).pipe(
          Effect.flatMap(summary =>
            Effect.die(`Index completed before embedding barrier: ${EffectArray.join(summary.diagnostics, '; ')}`),
          ),
        ),
      );
      expect(first.pollUnsafe() === undefined).toBe(true);
      // Verify structural readiness remains independent of the blocked vector operation.
      const store = yield* CodeGraphStore;
      const identity = yield* resolveRepositoryIdentity(repository);
      const actualLayout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
      expect((yield* store.readySnapshot(actualLayout.databasePath, identity.worktreeId))?.id).toBe(original.id);
      yield* fs.writeFileString(source, 'export function replacementValue() { return 2; }\n');
      const replacement = yield* indexer.index({cwd: repository, threadnoteHome: home, ensureVectors: false});
      expect(replacement.snapshot.id).not.toBe(original.id);
      expect(first.pollUnsafe() === undefined).toBe(true);
      yield* Deferred.succeed(release, undefined);
      const completed = yield* Fiber.join(first);
      expect(yield* Ref.get(attached)).toBe(false);
      expect(EffectArray.join(completed.diagnostics, '; ')).toContain('superseded');
      expect((yield* store.readySnapshot(actualLayout.databasePath, identity.worktreeId))?.id).toBe(
        replacement.snapshot.id,
      );
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('records terminal failure and removes manager context when deferred vectors are interrupted', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-index-vector-publication-'});
      const home = path.join(root, 'home');
      const repository = path.join(root, 'repository');
      yield* fs.makeDirectory(repository, {recursive: true});
      const source = path.join(repository, 'module.ts');
      yield* fs.writeFileString(source, 'export function initialValue() { return 1; }\n');
      const git = (...args: string[]) =>
        Effect.sync(() => execFileSync('git', ['-C', repository, ...args], {stdio: 'pipe'}));
      yield* git('init', '--quiet');
      yield* git('config', 'user.email', 'test@example.invalid');
      yield* git('config', 'user.name', 'Threadnote Test');
      yield* git('add', '.');
      yield* git('commit', '--quiet', '-m', 'fixture');
      const entered = yield* Deferred.make<CodeGraphSnapshot>();
      const release = yield* Deferred.make<void>();
      const attached = yield* Ref.make(false);
      const embedding = CodeGraphEmbeddingIndex.of({
        check: () => Effect.succeed({state: 'unavailable', reason: 'test model barrier'}),
        search: () => Effect.succeed(new Map()),
        ensure: (_home, _layout, snapshot, _symbols, options) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, snapshot);
            yield* Deferred.await(release);
            if (!options?.publication) return yield* Effect.die('Expected a captured publication fence.');
            yield* options.publication.attach(Ref.set(attached, true));
            return {embedded: 1, reused: 0, ready: true};
          }),
      });
      const indexerContext = yield* Layer.build(Layer.fresh(CodeGraphIndexer.layer)).pipe(
        Effect.provideService(CodeGraphEmbeddingIndex, embedding),
      );
      const indexer = Context.get(indexerContext, CodeGraphIndexer);
      const first = yield* indexer.index({cwd: repository, threadnoteHome: home}).pipe(Effect.forkChild);
      const original = yield* Effect.raceFirst(
        Deferred.await(entered),
        Fiber.join(first).pipe(
          Effect.flatMap(summary =>
            Effect.die(`Index completed before embedding barrier: ${EffectArray.join(summary.diagnostics, '; ')}`),
          ),
        ),
      );
      expect(first.pollUnsafe() === undefined).toBe(true);
      // Verify structural readiness remains independent of the blocked vector operation.
      const store = yield* CodeGraphStore;
      const identity = yield* resolveRepositoryIdentity(repository);
      const actualLayout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
      expect((yield* store.readySnapshot(actualLayout.databasePath, identity.worktreeId))?.id).toBe(original.id);
      const statuses = yield* readCodeGraphBuildStatuses(actualLayout);
      expect(statuses).toHaveLength(1);
      const status = statuses[0];
      expect(status.state).toBe('running');
      const contextFile = path.join(
        actualLayout.repositoryRoot,
        'build-status',
        codeGraphScopeViewKey(identity.worktreeId, actualLayout.scopeId),
        `${status.buildId}.manager-context`,
      );
      expect(yield* fs.exists(contextFile)).toBe(true);
      yield* Fiber.interrupt(first);
      const terminal = yield* readCodeGraphBuildStatuses(actualLayout);
      expect(terminal[0]?.state).toBe('failed');
      expect(terminal[0]?.timestamps.completedAt).toBeDefined();
      expect(terminal[0]?.error?.summary).toContain('interrupted');
      expect(yield* fs.exists(contextFile)).toBe(false);
      expect(yield* Ref.get(attached)).toBe(false);
      expect((yield* store.readySnapshot(actualLayout.databasePath, identity.worktreeId))?.id).toBe(original.id);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('forwards clean direct builds through the prepared budget and scoped preparation gates', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-clean-build-coordination-'});
      const identity: RepositoryIdentity = {
        caseMode: 'sensitive',
        checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
        displayName: 'fixture',
        gitCommonDirectory: path.join(home, '.git'),
        headCommit: Effect2.pipe('b', EffectString.repeat(40)),
        objectFormat: 'sha1',
        repoRoot: home,
        repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
        worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
      };
      const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
      yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true});
      const events = yield* Ref.make<string[]>([]);
      const stopped = new Error('stop after coordination');
      const storeContext = yield* Layer.build(
        Layer.mock(CodeGraphStore, {
          claimPersistentBuild: () => Effect.succeed('owner-token'),
          resumableForcedBuild: () => Effect.as(Effect.void, undefined),
        }),
      );
      const store = Context.get(storeContext, CodeGraphStore);
      const languagePacks = {
        ...BUILTIN_LANGUAGE_PACK_REGISTRY,
        discoverWorkspace: () => Effect.fail(CodeGraphLanguagePackError.make({message: stopped.message})),
      };
      const exit = yield* Effect.exit(
        buildOwnedCleanSnapshot({
          buildOwner: {buildId: 'fixture-build', processId: process.pid},
          capacityProtection: {
            availableDiskBytes: () => Effect.succeed(1_000_000),
            crypto: yield* Crypto.Crypto,
            maintenance: yield* CodeGraphMaintenanceCoordinator,
            path,
            system: yield* SystemInfo,
            temporaryDirectory: home,
            walAutoCheckpointPages: 1_000,
          },
          embedding: CodeGraphEmbeddingIndex.of({
            check: () => Effect.succeed({state: 'unavailable', reason: 'unused in this failure-path fixture'}),
            ensure: () => Effect.succeed({embedded: 0, reused: 0, ready: true}),
            search: () => Effect.succeed(new Map()),
          }),
          ensureVectors: false,
          existing: undefined,
          fallbackSnapshotId: `cgsn_${Effect2.pipe('e', EffectString.repeat(40))}-direct`,
          force: true,
          fs,
          identity,
          inventory: {
            committedFiles: [],
            committedParsedFiles: 0,
            dirty: false,
            files: [],
            parsedFiles: 0,
            skipped: 0,
          },
          languagePacks,
          legacyBuildAdmission: effect =>
            Ref.update(events, values => [...values, 'legacy']).pipe(Effect.andThen(effect)),
          layout,
          logicalSnapshotId: `cgsn_${Effect2.pipe('f', EffectString.repeat(40))}`,
          preparationGate: effect =>
            Ref.update(events, values => [...values, 'preparation']).pipe(Effect.andThen(effect)),
          preparedSpoolBudgetGate: (_bytes, _snapshotId, effect) =>
            Ref.update(events, values => [...values, 'budget']).pipe(Effect.andThen(effect)),
          reclaimSnapshots: () => Effect.void,
          startedAt: 0,
          store,
          threadnoteHome: home,
        }),
      );
      expect(exit._tag).toBe('Failure');
      expect(yield* Ref.get(events)).toEqual(['budget', 'preparation']);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
