import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Effect, FileSystem, Path, Semaphore, SynchronizedRef} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '@threadnote/graph/index_scope';
import {inventoryRepository} from '@threadnote/graph/inventory';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore, type CodeGraphSqliteWriterSettings} from '@threadnote/graph/store';
import {prewarmLikelyCleanSnapshots, codeGraphWatcherRefreshIndexRequest} from '@threadnote/graph/watcher';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, writeFileSync} from '@threadnote/testing/node-fs';
import {dirname, join} from '@threadnote/testing/node-path';

const project = (name: string, roots = [`apps/${name}`]) => ({
  uri: `threadnote://resources/repos/${name}`,
  graph: {closure: 'dependencies' as const, roots},
});
const write = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), {recursive: true});
  writeFileSync(join(root, path), content);
};
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const parent = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-scoped-stress-');
  const root = join(parent, 'repository');
  yield* fs.makeDirectory(root);
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
    ...Array.from({length: 32}, (_, index) => [`apps/unrelated-${index}`, {}] as const),
  ] as const) {
    write(root, `${path}/package.json`, JSON.stringify({name: `@fixture/${path.split('/')[1]}`, dependencies}));
    write(root, `${path}/index.ts`, `export const value = '${path}';\n`);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'many-package fixture');
  const linked = join(parent, 'linked');
  git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  return {root, linked, home: join(parent, 'home')};
});

function storedCounts(databasePath: string) {
  const db = new Database(databasePath, {readonly: true});
  try {
    const counts = db
      .query(
        `SELECT COUNT(*) AS snapshots, MAX(file_count) AS largest,
        SUM(CASE WHEN scope_id = ? THEN 1 ELSE 0 END) AS full FROM snapshots`,
      )
      .get(CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) as {
      snapshots: number;
      largest: number;
      full: number;
    };
    const files = db
      .query(
        `SELECT COUNT(*) AS fileRows,
      SUM(CASE WHEN path LIKE 'apps/unrelated-%' THEN 1 ELSE 0 END) AS unrelatedRows FROM snapshot_files`,
      )
      .get() as {
      fileRows: number;
      unrelatedRows: number;
    };
    return {...counts, ...files};
  } finally {
    db.close(false);
  }
}

describe('scoped reuse under bounded monorepo churn', () => {
  effectIt.effect(
    'coalesces parallel same-scope requests and reuses an equivalent linked worktree',
    () =>
      Effect.gen(function* () {
        const {root, linked, home} = yield* fixture;
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const path = yield* Path.Path;
        let writers = 0;
        const request = {
          cwd: root,
          threadnoteHome: home,
          project: project('a'),
          ensureVectors: false,
          onSqliteWriterConfigured: (settings: CodeGraphSqliteWriterSettings) =>
            Effect.sync(() => {
              if (settings.phase === 'connection') writers += 1;
            }),
        };
        const results = yield* Effect.all(
          Array.from({length: 3}, () => indexer.index(request)),
          {concurrency: 3},
        );
        expect(new Set(results.map(result => result.snapshot.id)).size).toBe(1);
        expect(writers).toBeLessThanOrEqual(3);
        expect(results.map(result => result.materialization?.stagedFiles).sort()).toEqual([0, 0, 7]);
        const linkedResult = yield* indexer.index({...request, cwd: linked});
        expect(linkedResult.snapshot.id).toBe(results[0].snapshot.id);
        expect(linkedResult.materialization).toMatchObject({mode: 'reused-snapshot', stagedFiles: 0});
        const identity = yield* resolveRepositoryIdentity(linked);
        const layout = codeGraphLayout(
          path,
          home,
          identity.checkoutId,
          identity.worktreeId,
          results[0].snapshot.scopeId,
        );
        expect(
          (yield* store.readySnapshot(layout.databasePath, identity.worktreeId, results[0].snapshot.scopeId))?.id,
        ).toBe(results[0].snapshot.id);
        expect(storedCounts(layout.databasePath)).toEqual({
          snapshots: 1,
          largest: 7,
          full: 0,
          fileRows: 7,
          unrelatedRows: 0,
        });
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );

  fcEffectProp(
    effectIt,
    'keeps overlapping views isolated through dirty and committed churn plus maintenance',
    {
      values: FC.uniqueArray(FC.integer({min: 1, max: 1000}), {minLength: 3, maxLength: 3}),
    },
    ({values}) =>
      Effect.gen(function* () {
        const {root, linked, home} = yield* fixture;
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const path = yield* Path.Path;
        const request = {cwd: root, threadnoteHome: home, project: project('a'), ensureVectors: false};
        const [initial, sibling, overlap] = yield* Effect.all(
          [
            indexer.index(request),
            indexer.index({...request, project: project('b')}),
            indexer.index({...request, cwd: linked, project: project('both', ['apps/a', 'apps/b'])}),
          ],
          {concurrency: 3},
        );
        const layout = codeGraphLayout(
          path,
          home,
          initial.identity.checkoutId,
          initial.identity.worktreeId,
          initial.snapshot.scopeId,
        );
        let current = initial;
        for (const value of values) {
          write(root, 'apps/unrelated-0/index.ts', `export const outside = ${value};\n`);
          let writers = 0;
          const outside = yield* indexer.index({
            ...request,
            onSqliteWriterConfigured: () =>
              Effect.sync(() => {
                writers += 1;
              }),
          });
          expect(outside.snapshot.id).toBe(current.snapshot.id);
          expect(outside.materialization?.stagedFiles).toBe(0);
          expect(writers).toBe(0);
          git(root, 'add', 'apps/unrelated-0/index.ts');
          git(root, 'commit', '-qm', `outside ${value}`);
          const outsideCommit = yield* indexer.index({
            ...request,
            onSqliteWriterConfigured: () =>
              Effect.sync(() => {
                writers += 1;
              }),
          });
          expect(outsideCommit.snapshot.id).toBe(current.snapshot.id);
          expect(writers).toBe(0);
          write(root, 'apps/a/index.ts', `export const value = '${value}';\n`);
          const dirty = yield* indexer.index(request);
          expect(dirty.materialization).toMatchObject({mode: 'incremental-overlay', stagedFiles: 1, totalFiles: 7});
          expect(dirty.incrementalWork?.plannedRows).toBeLessThan(100);
          git(root, 'add', 'apps/a/index.ts');
          git(root, 'commit', '-qm', `inside ${value}`);
          current = yield* indexer.index(request);
          expect(current.materialization?.stagedFiles).toBeLessThanOrEqual(1);
          expect(current.snapshot.scopeId).toBe(initial.snapshot.scopeId);
          yield* store.runRoutineMaintenance(layout.databasePath, {writerLockPath: layout.databaseWriteLockPath});
          expect(
            (yield* store.readySnapshot(layout.databasePath, sibling.identity.worktreeId, sibling.snapshot.scopeId))
              ?.id,
          ).toBe(sibling.snapshot.id);
          expect(
            (yield* store.readySnapshot(layout.databasePath, overlap.identity.worktreeId, overlap.snapshot.scopeId))
              ?.id,
          ).toBe(overlap.snapshot.id);
        }
        const graph = yield* store.loadGraph(layout.databasePath, current.snapshot.id);
        expect(
          graph.symbols.every(symbol => !symbol.path.startsWith('apps/b/') && !symbol.path.includes('unrelated-')),
        ).toBe(true);
        const counts = storedCounts(layout.databasePath);
        expect(counts.full).toBe(0);
        expect(counts.largest).toBe(11);
        expect(counts.snapshots).toBeLessThanOrEqual(12);
        expect(counts.fileRows).toBeLessThanOrEqual(100);
        expect(counts.unrelatedRows).toBe(0);
        const fullHome = join(home, 'comparison');
        const rebuilt = yield* indexer.index({...request, threadnoteHome: fullHome, force: true});
        const rebuiltLayout = codeGraphLayout(
          path,
          fullHome,
          rebuilt.identity.checkoutId,
          rebuilt.identity.worktreeId,
          rebuilt.snapshot.scopeId,
        );
        const fullGraph = yield* store.loadGraph(rebuiltLayout.databasePath, rebuilt.snapshot.id);
        expect(graph.symbols).toEqual(fullGraph.symbols);
        expect(graph.edges).toEqual(fullGraph.edges);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {fastCheck: {numRuns: 2}, timeout: 120_000},
  );

  effectIt.effect(
    'falls back only to the complete selected scope when its closure changes',
    () =>
      Effect.gen(function* () {
        const {root, home} = yield* fixture;
        const indexer = yield* CodeGraphIndexer;
        const request = {cwd: root, threadnoteHome: home, project: project('a'), ensureVectors: false};
        yield* indexer.index(request);
        write(
          root,
          'apps/a/package.json',
          JSON.stringify({name: '@fixture/a', dependencies: {'@fixture/b-only': 'workspace:*'}}),
        );
        const changed = yield* indexer.index(request);
        const identity = yield* resolveRepositoryIdentity(root);
        const inventory = yield* inventoryRepository(identity, {project: project('a')});
        expect(changed.materialization).toMatchObject({
          mode: 'full',
          stagedFiles: 5,
          totalFiles: 5,
          fallbackReason: 'workspace-changed',
        });
        expect(inventory.files.map(file => file.path)).toEqual([
          'apps/a/index.ts',
          'apps/a/package.json',
          'package.json',
          'shared/b-only/index.ts',
          'shared/b-only/package.json',
        ]);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );

  effectIt.effect(
    'never prewarms a full snapshot for a scoped watcher',
    () =>
      Effect.gen(function* () {
        const {root, home} = yield* fixture;
        git(root, 'branch', '-M', 'main');
        git(root, 'checkout', '-qb', 'watch-fixture');
        write(root, 'apps/b/index.ts', 'export const next = true;\n');
        git(root, 'add', '.');
        git(root, 'commit', '-qm', 'leave older prewarm candidate');
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const path = yield* Path.Path;
        const commandExecutor = yield* CommandExecutor;
        const options = {cwd: root, threadnoteHome: home, key: 'scoped-watch', project: project('a')};
        const summary = yield* indexer.index(codeGraphWatcherRefreshIndexRequest(options));
        const prewarmedCommits = yield* SynchronizedRef.make(new Set<string>());
        let commits = 0;
        yield* prewarmLikelyCleanSnapshots({
          commandExecutor,
          options,
          path,
          store,
          prewarmedCommits,
          prewarmSemaphore: yield* Semaphore.make(1),
          indexer: {
            ...indexer,
            ensureCommit: request => {
              commits += 1;
              return indexer.ensureCommit(request);
            },
          },
        });
        expect(commits).toBe(0);
        expect((yield* SynchronizedRef.get(prewarmedCommits)).size).toBe(0);
        const layout = codeGraphLayout(
          path,
          home,
          summary.identity.checkoutId,
          summary.identity.worktreeId,
          summary.snapshot.scopeId,
        );
        expect(storedCounts(layout.databasePath)).toEqual({
          snapshots: 1,
          largest: 7,
          full: 0,
          fileRows: 7,
          unrelatedRows: 0,
        });
        expect(yield* store.readySnapshot(layout.databasePath, summary.identity.worktreeId)).toBeUndefined();
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    60_000,
  );
});
