import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {describe, expect, it} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import {Effect, Path} from 'effect';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphStore, type StoredCodeGraph} from '@threadnote/graph/store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('mixed Node and Bazel incremental indexing', () => {
  it.effect('keeps a comment-only nested MODULE.bazel edit local and equivalent to a full rebuild', () =>
    Effect.acquireUseRelease(
      Effect.sync(createMixedWorkspaceRepository),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const {fullHome, incrementalHome, root} = fixture;
          yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});

          yield* Effect.sync(() =>
            writeFile(
              root,
              'apps/bazel-app/MODULE.bazel',
              '# Developer-only note; declarations are unchanged.\nmodule(name = "bazel_app")\n',
            ),
          );

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
            mode: 'incremental-overlay',
            stagedFiles: 1,
            totalFiles: 14,
          });
          expect(EffectArray.map(incrementalGraph.symbols, symbol => symbol.name)).toEqual(
            expect.arrayContaining(['bazelApp', 'shared', 'web']),
          );
          expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
        }),
      fixture => Effect.sync(() => rmSync(fixture.temporaryRoot, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it.effect('rematerializes only a changed nested Bazel dependency closure', () =>
    Effect.acquireUseRelease(
      Effect.sync(createMixedWorkspaceRepository),
      fixture =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const {fullHome, incrementalHome, root} = fixture;
          yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});

          yield* Effect.sync(() =>
            writeFile(
              root,
              'apps/bazel-app/BUILD.bazel',
              'ts_library(name = "app", srcs = ["app.ts"], deps = ["//alternate:alternate"])\n',
            ),
          );

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

          expect(incremental.materialization).toMatchObject({
            closureProjects: 1,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
          });
          expect(incremental.materialization?.stagedFiles).toBeLessThan(incremental.materialization!.totalFiles);
          expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
        }),
      fixture => Effect.sync(() => rmSync(fixture.temporaryRoot, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});

interface MixedWorkspaceFixture {
  readonly fullHome: string;
  readonly incrementalHome: string;
  readonly root: string;
  readonly temporaryRoot: string;
}

function createMixedWorkspaceRepository(): MixedWorkspaceFixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'threadnote-mixed-bazel-incremental-'));
  const root = join(temporaryRoot, 'repository');
  mkdirSync(root, {recursive: true});
  write(root, 'package.json', {name: '@fixture/root', private: true, workspaces: ['libs/*']});
  write(root, 'nx.json', {namedInputs: {default: ['{projectRoot}/**/*']}});
  write(root, 'libs/shared/package.json', {name: '@fixture/shared'});
  writeFile(root, 'libs/shared/index.ts', 'export const shared = "shared";\n');
  write(root, 'apps/web/package.json', {
    dependencies: {'@fixture/shared': 'workspace:*'},
    name: '@fixture/web',
  });
  writeFile(
    root,
    'apps/web/index.ts',
    'import {shared} from "../../libs/shared/index.js";\nexport const web = shared;\n',
  );
  write(root, 'apps/bazel-app/package.json', {name: '@fixture/bazel-app'});
  writeFile(root, 'apps/bazel-app/MODULE.bazel', 'module(name = "bazel_app")\n');
  writeFile(
    root,
    'apps/bazel-app/BUILD.bazel',
    'ts_library(name = "app", srcs = ["app.ts"], deps = ["//core:core"])\n',
  );
  writeFile(root, 'apps/bazel-app/app.ts', 'export const bazelApp = "ready";\n');
  writeFile(root, 'apps/bazel-app/core/BUILD.bazel', 'ts_library(name = "core", srcs = ["core.ts"])\n');
  writeFile(root, 'apps/bazel-app/core/core.ts', 'export const core = "core";\n');
  writeFile(root, 'apps/bazel-app/alternate/BUILD.bazel', 'ts_library(name = "alternate", srcs = ["alternate.ts"])\n');
  writeFile(root, 'apps/bazel-app/alternate/alternate.ts', 'export const alternate = "alternate";\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Threadnote Test']);
  git(root, ['config', 'user.email', 'test@threadnote.local']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return {
    fullHome: join(temporaryRoot, 'threadnote-full'),
    incrementalHome: join(temporaryRoot, 'threadnote-incremental'),
    root,
    temporaryRoot,
  };
}

function write(root: string, path: string, value: unknown): void {
  writeFile(root, path, `${JSON.stringify(value)}\n`);
}

function writeFile(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(join(target, '..'), {recursive: true});
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
