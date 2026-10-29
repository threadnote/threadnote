import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Option} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {CommandExecutor} from '@threadnote/platform/command';

import {
  inventoryRepository,
  inventoryRepositoryFromReusableCleanBase,
  observeCodeGraphIndexScope,
  worktreeBuildRequestObservation,
} from '@threadnote/graph/inventory';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphStore} from '@threadnote/graph/store';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Path} from 'effect';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = Layer.mergeAll(
  BunServices.layer,
  TestSystemInfoLayer,
  TestCommandExecutorLayer.pipe(Layer.provide(Layer.merge(BunServices.layer, TestSystemInfoLayer))),
);
const project = {uri: 'threadnote://resources/repos/a', graph: {closure: 'dependencies' as const, roots: ['apps/a']}};
const write = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), {recursive: true});
  writeFileSync(join(root, path), content);
};
const git = (root: string, ...args: string[]) =>
  Effect2.pipe(execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}), EffectString.trim);
const fixture = Effect.acquireRelease(
  Effect.sync(() => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-scoped-inventory-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.test');
    write(root, 'package.json', JSON.stringify({private: true, workspaces: ['apps/*', 'shared/*']}));
    for (const [path, dependencies] of [
      ['apps/a', {'@fixture/core': 'workspace:*', '@fixture/a-only': 'workspace:*'}],
      ['apps/b', {'@fixture/core': 'workspace:*', '@fixture/b-only': 'workspace:*'}],
      ['shared/core', {}],
      ['shared/a-only', {}],
      ['shared/b-only', {}],
    ] as const) {
      write(
        root,
        `${path}/package.json`,
        JSON.stringify({name: `@fixture/${Effect2.pipe(path, EffectString.split('/'))[1]}`, dependencies}),
      );
      write(root, `${path}/index.ts`, `export const value = '${path}';\n`);
    }
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    return root;
  }),
  root => Effect.sync(() => rmSync(root, {recursive: true, force: true})),
);

describe('scoped inventory', () => {
  effectIt.effect('discovers the committed tree once per scoped observation', () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const identity = yield* resolveRepositoryIdentity(root);
      const executor = yield* CommandExecutor;
      for (const scopeObservationOnly of [false, true]) {
        let trees = 0;
        let catalogs = 0;
        yield* inventoryRepository(identity, {
          project,
          scopeObservationOnly,
          languagePacks: {
            ...BUILTIN_LANGUAGE_PACK_REGISTRY,
            discoverWorkspace: files => {
              catalogs += 1;
              return BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files);
            },
          },
        }).pipe(
          Effect.provideService(CommandExecutor, {
            ...executor,
            execute: (command, args, options) => {
              if (command === 'git' && args.includes('ls-tree')) trees += 1;
              return executor.execute(command, args, options);
            },
          }),
        );
        expect(trees).toBe(1);
        expect(catalogs).toBe(1);
      }
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect(
    'materializes only a one-file scoped body edit and an in-scope commit',
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scoped-reuse-'});
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const path = yield* Path.Path;
        const request = {cwd: root, threadnoteHome: home, project, ensureVectors: false};
        const clean = yield* indexer.index(request);
        write(root, 'apps/a/index.ts', "export const value = 'edited';\n");
        const identity = yield* resolveRepositoryIdentity(root);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId, clean.snapshot.scopeId);
        const base = yield* store.reusableCleanBaseForCommit(
          layout.databasePath,
          identity.repositoryId,
          identity.headCommit,
          clean.snapshot.scopeId,
        );
        expect(base).toBeDefined();
        const scopeObservation = yield* inventoryRepository(identity, {
          project,
          scopeObservationOnly: true,
          includeOpaqueCorpusAssets: false,
        });
        const observation = yield* worktreeBuildRequestObservation(identity, home, scopeObservation.scope);
        const reuseOptions = {
          project,
          scopeObservation,
          overlayObservation: observation.overlay,
          includeOpaqueCorpusAssets: false,
        };
        const reusable = yield* inventoryRepositoryFromReusableCleanBase(identity, base!, reuseOptions);
        expect(Option.isSome(reusable)).toBe(true);
        if (Option.isSome(reusable))
          expect(reusable.value.scopeInventoryFingerprint).toBe(scopeObservation.scopeInventoryFingerprint);
        for (const field of ['scopeKey', 'definitionDigest', 'closureDigest'] as const) {
          expect(
            Option.isNone(
              yield* inventoryRepositoryFromReusableCleanBase(identity, base!, {
                ...reuseOptions,
                scopeObservation: {...scopeObservation, scope: {...scopeObservation.scope!, [field]: 'incompatible'}},
              }),
            ),
          ).toBe(true);
        }
        const dirty = yield* indexer.index(request);
        expect(dirty.snapshot.scopeId).toBe(clean.snapshot.scopeId);
        expect(dirty.materialization).toMatchObject({mode: 'incremental-overlay', stagedFiles: 1, totalFiles: 7});
        expect(
          EffectArray.some(dirty.diagnostics, value =>
            Effect2.pipe(value, EffectString.includes('without hydrating the complete inventory')),
          ),
        ).toBe(true);
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'scoped edit');
        const committed = yield* indexer.index(request);
        expect(committed.snapshot.scopeId).toBe(clean.snapshot.scopeId);
        expect(committed.materialization?.stagedFiles).toBeLessThanOrEqual(1);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );

  effectIt.effect(
    'keeps a scoped dirty preparation fallback out of the full-repository view',
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scoped-fallback-'});
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const request = {cwd: root, threadnoteHome: home, project, ensureVectors: false};
        const full = yield* indexer.index({cwd: root, threadnoteHome: home, ensureVectors: false});
        const clean = yield* indexer.index(request);
        const scopeId = clean.snapshot.scopeId;
        expect(scopeId).toMatch(/^code-graph-scope:/);

        write(root, 'apps/a/index.ts', "export const value = 'fallback';\n");
        let preparationAttempts = 0;
        const fallbackStore = CodeGraphStore.of({
          ...store,
          preparePersistedIncrementalActivation: () =>
            Effect.sync(() => {
              preparationAttempts += 1;
              return false;
            }),
          replaceStagedModifiedFiles: () =>
            Effect.sync(() => {
              preparationAttempts += 1;
              return false;
            }),
        });
        const fallbackIndexerLayer = Layer.fresh(CodeGraphIndexer.layer).pipe(
          Layer.provide(Layer.succeed(CodeGraphStore, fallbackStore)),
        );
        const fallback = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(fallbackIndexerLayer);
            return yield* Context.get(context, CodeGraphIndexer).index(request);
          }),
        );

        expect(preparationAttempts).toBeGreaterThan(0);
        expect(fallback.materialization?.mode).toBe('full');
        expect(fallback.snapshot.scopeId).toBe(scopeId);
        const identity = yield* resolveRepositoryIdentity(root);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        expect((yield* store.readySnapshotById(layout.databasePath, fallback.snapshot.id))?.scopeId).toBe(scopeId);
        expect(yield* store.readySnapshot(layout.databasePath, identity.worktreeId, scopeId)).toMatchObject({
          id: fallback.snapshot.id,
          scopeId,
        });
        const activeFull = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
        expect(activeFull?.id).toBe(full.snapshot.id);
        expect(activeFull?.scopeId).toBeUndefined();
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );

  effectIt.effect(
    'reuses an applicable scoped snapshot across unrelated commits without a build',
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scoped-index-home-'});
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const first = yield* indexer.index({cwd: root, threadnoteHome: home, project, ensureVectors: false});
        expect(first.snapshot.scopeId).toMatch(/^code-graph-scope:/);
        expect(first.snapshot.fileCount).toBe(7);
        write(root, 'apps/b/index.ts', 'export const changedB = true;\n');
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'unrelated B');
        let writers = 0;
        let registering = 0;
        const second = yield* indexer.index({
          cwd: root,
          threadnoteHome: home,
          project,
          ensureVectors: false,
          onSqliteWriterConfigured: () =>
            Effect.sync(() => {
              writers += 1;
            }),
          onProgress: progress =>
            Effect.sync(() => {
              if (progress.phase === 'registering') registering += 1;
            }),
        });
        expect(second.snapshot.id).toBe(first.snapshot.id);
        expect(second.snapshot.commit).toBe(first.snapshot.commit);
        expect(writers).toBe(0);
        expect(registering).toBe(0);
        write(root, 'apps/c/package.json', JSON.stringify({name: '@fixture/c'}));
        write(root, 'apps/c/index.ts', 'export const unrelatedC = true;\n');
        write(root, 'apps/b/package.json', JSON.stringify({name: '@fixture/b', version: '2.0.0'}));
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'unrelated catalog');
        const catalogOnly = yield* indexer.index({
          cwd: root,
          threadnoteHome: home,
          project,
          ensureVectors: false,
          onSqliteWriterConfigured: () =>
            Effect.sync(() => {
              writers += 1;
            }),
        });
        expect(catalogOnly.snapshot.id).toBe(first.snapshot.id);
        expect(writers).toBe(0);
        const identity = yield* resolveRepositoryIdentity(root);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId, first.snapshot.scopeId);
        expect(
          (yield* store.loadScopeApplicability(layout.databasePath, identity.worktreeId, first.snapshot.scopeId))
            ?.observedCommit,
        ).toBe(identity.headCommit);
        write(root, 'shared/core/index.ts', 'export const changedCore = true;\n');
        const third = yield* indexer.index({cwd: root, threadnoteHome: home, project, ensureVectors: false});
        expect(third.snapshot.id).not.toBe(first.snapshot.id);
        expect(third.snapshot.dirty).toBe(true);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );

  effectIt.effect(
    'keeps independent scopes and retains a completed stale snapshot after closure drift',
    () =>
      Effect.gen(function* () {
        const root = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scope-drift-home-'});
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const first = yield* indexer.index({cwd: root, threadnoteHome: home, project, ensureVectors: false});
        const sibling = yield* indexer.index({
          cwd: root,
          threadnoteHome: home,
          project: {uri: 'threadnote://resources/repos/b', graph: {closure: 'dependencies', roots: ['apps/b']}},
          ensureVectors: false,
        });
        expect(sibling.snapshot.scopeId).not.toBe(first.snapshot.scopeId);
        const identity = yield* resolveRepositoryIdentity(root);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        expect((yield* store.readySnapshot(layout.databasePath, identity.worktreeId, first.snapshot.scopeId))?.id).toBe(
          first.snapshot.id,
        );
        expect(
          (yield* store.readySnapshot(layout.databasePath, identity.worktreeId, sibling.snapshot.scopeId))?.id,
        ).toBe(sibling.snapshot.id);
        expect(yield* store.readySnapshot(layout.databasePath, identity.worktreeId)).toBeUndefined();
        write(root, 'shared/a-only/index.ts', 'export const changedA = 2;\n');
        let staleSnapshotId: string | undefined;
        const completed = yield* indexer.index({
          cwd: root,
          threadnoteHome: home,
          project,
          ensureVectors: false,
          onProgress: progress =>
            Effect.sync(() => {
              if (
                progress.phase === 'activating' &&
                progress.subphase === 'validating-input' &&
                staleSnapshotId === undefined
              ) {
                staleSnapshotId = progress.snapshotId;
                write(
                  root,
                  'apps/a/package.json',
                  JSON.stringify({name: '@fixture/a', dependencies: {'@fixture/b-only': 'workspace:*'}}),
                );
              }
            }),
        });
        expect(staleSnapshotId).toBeDefined();
        expect(completed.snapshot.id).not.toBe(staleSnapshotId);
        expect((yield* store.readySnapshotById(layout.databasePath, staleSnapshotId!))?.state).toBe('ready');
        expect((yield* store.readySnapshot(layout.databasePath, identity.worktreeId, first.snapshot.scopeId))?.id).toBe(
          completed.snapshot.id,
        );
        expect(
          (yield* store.readySnapshot(layout.databasePath, identity.worktreeId, sibling.snapshot.scopeId))?.id,
        ).toBe(sibling.snapshot.id);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );

  effectIt.effect('hydrates only A and its forward closure, and ignores unrelated dirty source', () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const identity = yield* resolveRepositoryIdentity(root);
      const hydrated: string[] = [];
      const clean = yield* inventoryRepository(identity, {
        project,
        onContentBatch: files =>
          Effect.sync(() => {
            hydrated.push(...EffectArray.map(files, file => file.path));
          }),
      });
      expect(EffectArray.map(clean.files, file => file.path)).toEqual([
        'apps/a/index.ts',
        'apps/a/package.json',
        'package.json',
        'shared/a-only/index.ts',
        'shared/a-only/package.json',
        'shared/core/index.ts',
        'shared/core/package.json',
      ]);
      expect(hydrated).not.toContain('apps/b/index.ts');
      expect(clean.scopeExclusions?.files).toBe(4);
      write(root, 'apps/b/index.ts', 'export const changed = true;\n');
      const fs = yield* FileSystem.FileSystem;
      const opened: string[] = [];
      const scoped = yield* observeCodeGraphIndexScope(identity, project);
      const request = yield* worktreeBuildRequestObservation(identity, undefined, scoped.scope).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (...args) => {
            opened.push(String(args[0]));
            return fs.open(...args);
          },
        }),
      );
      expect(request.state).toEqual({dirty: false, fingerprint: undefined});
      expect(EffectArray.some(opened, path => Effect2.pipe(path, EffectString.endsWith('/apps/b/index.ts')))).toBe(
        false,
      );
      const dirty = yield* inventoryRepository(identity, {project});
      expect(dirty.dirty).toBe(false);
      expect(dirty.scopeInventoryFingerprint).toBe(clean.scopeInventoryFingerprint);
      const full = yield* inventoryRepository(identity);
      expect(EffectArray.some(full.files, file => file.path === 'apps/b/index.ts')).toBe(true);
      expect(full.dirty).toBe(true);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('re-resolves dirty manifests and expands the scoped inventory', () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const identity = yield* resolveRepositoryIdentity(root);
      const before = yield* inventoryRepository(identity, {project});
      write(
        root,
        'apps/a/package.json',
        JSON.stringify({name: '@fixture/a', dependencies: {'@fixture/b-only': 'workspace:*'}}),
      );
      const after = yield* inventoryRepository(identity, {project});
      expect(after.scope?.closureDigest).not.toBe(before.scope?.closureDigest);
      expect(EffectArray.some(after.files, file => file.path === 'shared/b-only/index.ts')).toBe(true);
      expect(EffectArray.some(after.files, file => file.path === 'apps/b/index.ts')).toBe(false);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );
});
