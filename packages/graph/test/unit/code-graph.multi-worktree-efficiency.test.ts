import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as EffectString from 'effect/String';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphParserPool, type CodeGraphParserPoolShape} from '@threadnote/graph/parser_worker';
import {CodeGraphObservability, CodeGraphProcessActivity} from '@threadnote/graph/runtime_ports';
import {CodeGraphStore} from '@threadnote/graph/store';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphIndexSummary} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
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

const fixture = (worktreeCount: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const parser = yield* CodeGraphParserPool;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'graph-worktree-efficiency-'});
    const repository = path.join(root, 'repository');
    const home = path.join(root, 'shared-home');
    yield* fs.makeDirectory(repository);
    yield* fs.makeDirectory(home);
    const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
    const commit = (message: string) =>
      Effect.gen(function* () {
        yield* git(repository, ['add', '.']);
        yield* git(repository, [
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
    yield* git(repository, ['init', '--quiet']);
    yield* fs.writeFileString(path.join(repository, 'leaf.ts'), 'export const value = 1;\n');
    yield* fs.writeFileString(path.join(repository, 'unrelated.ts'), 'export const unrelated = true;\n');
    yield* fs.writeFileString(
      path.join(repository, 'consumer.ts'),
      "import {value} from './leaf';\nexport function answer() { return value + 1; }\n",
    );
    yield* commit('initial');
    const worktrees: string[] = [];
    for (let index = 0; index < worktreeCount; index++) {
      const worktree = path.join(root, 'worktree-' + index);
      yield* git(repository, ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
      worktrees.push(worktree);
    }
    const counters = {parsedFiles: 0, degraded: 0, rawFactFiles: 0, shardFiles: 0, preparations: 0};
    type ExtractFile = (
      file: Parameters<CodeGraphParserPoolShape['extract']>[0],
    ) => ReturnType<CodeGraphParserPoolShape['extract']>;
    const observeExtract = (extract: ExtractFile) => (file: Parameters<CodeGraphParserPoolShape['extract']>[0]) =>
      extract(file).pipe(
        Effect.tap(result =>
          Effect.sync(() => {
            counters.parsedFiles++;
            if (result.degraded) counters.degraded++;
          }),
        ),
      );
    const observedParser = CodeGraphParserPool.of({
      ...parser,
      extract: (file, threadnoteHome) => observeExtract(value => parser.extract(value, threadnoteHome))(file),
      withParserSlot: (threadnoteHome, files, use) =>
        parser.withParserSlot(threadnoteHome, files, extract => use(observeExtract(extract))),
    });
    const observedStore = CodeGraphStore.of({
      ...store,
      loadCachedFacts: (...args) =>
        store.loadCachedFacts(...args).pipe(
          Effect.tap(result =>
            Effect.sync(() => {
              counters.rawFactFiles += result.facts.size;
            }),
          ),
        ),
      loadMaterializedFileShards: (...args) =>
        store.loadMaterializedFileShards(...args).pipe(
          Effect.tap(result =>
            Effect.sync(() => {
              counters.shardFiles += result.facts.size;
            }),
          ),
        ),
      prepareActivation: (...args) =>
        store.prepareActivation(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              counters.preparations++;
            }),
          ),
        ),
    });
    const independentCaller = Layer.build(CodeGraphIndexer.layer).pipe(
      Effect.provideService(CodeGraphStore, observedStore),
      Effect.provideService(CodeGraphParserPool, observedParser),
      Effect.map(context => Context.get(context, CodeGraphIndexer)),
    );
    const indexer = yield* independentCaller;
    const index = (cwd: string, threadnoteHome = home, incrementalOverlay?: boolean) =>
      indexer.index({
        cwd,
        threadnoteHome,
        sourceOnly: true,
        vectorPolicy: 'off',
        incrementalOverlay,
      });
    const rows = (summary: CodeGraphIndexSummary, threadnoteHome = home) =>
      Effect.gen(function* () {
        const layout = codeGraphLayout(path, threadnoteHome, summary.identity.checkoutId, summary.identity.worktreeId);
        const graph = yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
        const files = yield* store.effectiveSnapshotFilesByPaths(layout.databasePath, summary.snapshot.id, [
          'consumer.ts',
          'leaf.ts',
          'unrelated.ts',
        ]);
        return {files, symbols: graph.symbols, edges: graph.edges};
      });
    const reference = (cwd: string) =>
      Effect.gen(function* () {
        const independentHome = yield* fs.makeTempDirectoryScoped({prefix: 'graph-worktree-oracle-'});
        const summary = yield* indexer.index({
          cwd,
          threadnoteHome: independentHome,
          sourceOnly: true,
          vectorPolicy: 'off',
          incrementalOverlay: false,
        });
        return yield* rows(summary, independentHome);
      });
    const current = (summary: CodeGraphIndexSummary) => {
      const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
      return store.readySnapshot(layout.databasePath, summary.identity.worktreeId);
    };
    return {
      counters,
      current,
      commit,
      fs,
      git,
      home,
      independentCaller,
      index,
      path,
      reference,
      repository,
      root,
      rows,
      worktrees,
    };
  });

describe('multi-worktree structural indexing efficiency', () => {
  effectIt.layer(dependencies)(it => {
    for (const count of [1, 2, 4, 8]) {
      it.effect(`reuses warm clean views across ${count} linked worktree(s)`, () =>
        Effect.gen(function* () {
          const f = yield* fixture(count);
          const first = yield* f.index(f.worktrees[0]);
          expect(f.counters.degraded).toBe(0);
          expect(f.counters.parsedFiles).toBe(3);
          const expected = yield* f.rows(first);
          const baseline = {...f.counters};
          for (const cwd of f.worktrees.slice(1)) {
            const next = yield* f.index(cwd);
            expect(yield* f.rows(next)).toEqual(expected);
            expect(next.materialization).toMatchObject({mode: 'reused-snapshot', stagedFiles: 0});
          }
          expect(f.counters.parsedFiles).toBe(baseline.parsedFiles);
          expect(f.counters.degraded).toBe(0);
          expect(f.counters.preparations).toBe(baseline.preparations);
          expect(yield* f.reference(f.worktrees[0])).toEqual(expected);
        }).pipe(TestClock.withLive),
      );
      it.effect(`reuses unchanged files across ${count} nearby-commit linked worktree(s)`, () =>
        Effect.gen(function* () {
          const f = yield* fixture(count);
          yield* f.index(f.worktrees[0]);
          yield* f.fs.writeFileString(f.path.join(f.repository, 'leaf.ts'), 'export const value = 2;\n');
          yield* f.commit('change one leaf');
          const head = EffectString.trim((yield* f.git(f.repository, ['rev-parse', 'HEAD'])).stdout);
          for (const cwd of f.worktrees) yield* f.git(cwd, ['checkout', '--quiet', head]);
          const before = {...f.counters};
          const summaries: CodeGraphIndexSummary[] = [];
          for (const cwd of f.worktrees) summaries.push(yield* f.index(cwd));
          expect(f.counters.parsedFiles - before.parsedFiles).toBe(1);
          expect(f.counters.degraded).toBe(0);
          const expected = yield* f.reference(f.worktrees[0]);
          for (const summary of summaries) expect(yield* f.rows(summary)).toEqual(expected);
          expect(summaries[0].materialization).toMatchObject({mode: 'incremental-clean'});
          expect(summaries[0].materialization?.stagedFiles).toBeLessThan(3);
        }).pipe(TestClock.withLive),
      );
    }

    it.effect('isolates disjoint dirty worktrees and agrees with independent clean rebuilds', () =>
      Effect.gen(function* () {
        const f = yield* fixture(2);
        yield* f.index(f.worktrees[0]);
        yield* f.fs.writeFileString(f.path.join(f.worktrees[0], 'leaf.ts'), 'export const value = 10;\n');
        yield* f.fs.writeFileString(
          f.path.join(f.worktrees[1], 'consumer.ts'),
          "import {value} from './leaf';\nexport function answer() { return value + 20; }\n",
        );
        const first = yield* f.index(f.worktrees[0]);
        const firstRows = yield* f.rows(first);
        const second = yield* f.index(f.worktrees[1]);
        expect(first.snapshot.dirty).toBe(true);
        expect(second.snapshot.dirty).toBe(true);
        expect(first.snapshot.id).not.toBe(second.snapshot.id);
        expect(yield* f.rows(first)).toEqual(firstRows);
        expect(firstRows).toEqual(yield* f.reference(f.worktrees[0]));
        expect(yield* f.rows(second)).toEqual(yield* f.reference(f.worktrees[1]));
        expect((yield* f.current(first))?.id).toBe(first.snapshot.id);
        expect((yield* f.current(second))?.id).toBe(second.snapshot.id);
        expect(f.counters.degraded).toBe(0);
      }).pipe(TestClock.withLive),
    );

    it.effect('reuses raw facts while invalidating the changed materialization batch in a dirty full build', () =>
      Effect.gen(function* () {
        const f = yield* fixture(1);
        yield* f.index(f.worktrees[0]);
        yield* f.fs.writeFileString(f.path.join(f.worktrees[0], 'leaf.ts'), 'export const value = 2;\n');
        const before = {...f.counters};
        const full = yield* f.index(f.worktrees[0], f.home, false);
        expect(full.materialization?.mode).toBe('full');
        expect(f.counters.parsedFiles - before.parsedFiles).toBe(1);
        expect(f.counters.rawFactFiles - before.rawFactFiles).toBeGreaterThanOrEqual(2);
        // All three files share one attribution batch. Its changed derivation
        // must fall back together; partial final-shard reuse would be unsafe.
        expect(f.counters.shardFiles - before.shardFiles).toBe(0);
        expect(full.materialization?.stagedFiles).toBe(3);
        expect(yield* f.rows(full)).toEqual(yield* f.reference(f.worktrees[0]));
      }).pipe(TestClock.withLive),
    );

    it.effect(
      'keeps a cold eight-worktree foreground wave equivalent to serial reference builds',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(8);
          const summaries = yield* Effect.forEach(
            f.worktrees,
            cwd =>
              Effect.gen(function* () {
                const caller = yield* f.independentCaller;
                return yield* caller.index({cwd, threadnoteHome: f.home, sourceOnly: true, vectorPolicy: 'off'});
              }),
            {concurrency: 2},
          );
          const measured = {...f.counters};
          expect(measured.parsedFiles).toBeGreaterThanOrEqual(3);
          expect(measured.parsedFiles).toBeLessThanOrEqual(24);
          expect(measured.degraded).toBe(0);
          for (let index = 0; index < summaries.length; index++) {
            expect(yield* f.rows(summaries[index])).toEqual(yield* f.reference(f.worktrees[index]));
          }
        }).pipe(TestClock.withLive),
      {timeout: 60_000},
    );

    fcEffectProp(
      it,
      'incremental dirty values equal an independent serial build',
      [fc.integer({min: 2, max: 1_000})],
      ([value]) =>
        Effect.gen(function* () {
          const f = yield* fixture(1);
          yield* f.index(f.worktrees[0]);
          const before = f.counters.parsedFiles;
          yield* f.fs.writeFileString(f.path.join(f.worktrees[0], 'leaf.ts'), `export const value = ${value};\n`);
          const incremental = yield* f.index(f.worktrees[0]);
          expect(f.counters.parsedFiles - before).toBe(1);
          expect(yield* f.rows(incremental)).toEqual(yield* f.reference(f.worktrees[0]));
          expect(f.counters.degraded).toBe(0);
        }).pipe(TestClock.withLive),
      {fastCheck: {numRuns: 6}, timeout: 60_000},
    );

    it.effect(
      'serializes linked-worktree writers across processes without holding preparation while waiting',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(2);
          yield* f.index(f.worktrees[0]);
          // Distinct dirty targets avoid the correct shared clean-commit request coalescer.
          yield* f.fs.writeFileString(f.path.join(f.worktrees[0], 'leaf.ts'), 'export const value = 10;\n');
          yield* f.fs.writeFileString(f.path.join(f.worktrees[1], 'leaf.ts'), 'export const value = 20;\n');
          const held = f.path.join(f.root, 'writer-held');
          const waiting = f.path.join(f.root, 'writer-waiting');
          const released = f.path.join(f.root, 'writer-released');
          const firstOutput = f.path.join(f.root, 'first.json');
          const secondOutput = f.path.join(f.root, 'second.json');
          const waitFor = (file: string, child: ReturnType<typeof spawnLinkedIndexer>) =>
            Effect.gen(function* () {
              while (!(yield* f.fs.exists(file))) {
                if (child.exitCode !== null) {
                  const stderr = yield* Effect.promise(() => new Response(child.stderr).text());
                  const stdout = yield* Effect.promise(() => new Response(child.stdout).text());
                  return yield* Effect.die(`Indexer exited before barrier (${child.exitCode}): ${stderr || stdout}`);
                }
                yield* Effect.sleep(10);
              }
            }).pipe(Effect.timeout('30 seconds'));
          const start = (cwd: string, output: string, first: boolean) =>
            Effect.acquireRelease(
              Effect.sync(() => spawnLinkedIndexer({cwd, home: f.home, output, first, held, waiting, released})),
              child =>
                Effect.gen(function* () {
                  if (child.exitCode === null) child.kill('SIGKILL');
                  yield* Effect.promise(() => child.exited);
                }),
            );
          const first = yield* start(f.worktrees[0], firstOutput, true);
          yield* waitFor(held, first);
          const second = yield* start(f.worktrees[1], secondOutput, false);
          yield* Effect.forEach([first, second], child =>
            Effect.gen(function* () {
              const exitCode = yield* Effect.promise(() => child.exited);
              const stderr = yield* Effect.promise(() => new Response(child.stderr).text());
              expect(exitCode, stderr).toBe(0);
            }),
          ).pipe(Effect.timeout('45 seconds'));
          expect(yield* f.fs.exists(waiting)).toBe(true);
          expect(yield* f.fs.exists(released)).toBe(true);
          for (const [index, output] of [firstOutput, secondOutput].entries()) {
            const summary: CodeGraphIndexSummary = JSON.parse(yield* f.fs.readFileString(output));
            expect(summary.snapshot.state).toBe('ready');
            expect(yield* f.rows(summary)).toEqual(yield* f.reference(f.worktrees[index]));
          }
        }).pipe(TestClock.withLive),
      {timeout: 60_000},
    );
  });
});

function spawnLinkedIndexer(options: {
  readonly cwd: string;
  readonly home: string;
  readonly output: string;
  readonly first: boolean;
  readonly held: string;
  readonly waiting: string;
  readonly released: string;
}) {
  const indexerUrl = new URL('../../src/indexer.ts', import.meta.url).href;
  const runtimeUrl = new URL('../../../../apps/threadnote/src/effect/runtime.ts', import.meta.url).href;
  return Bun.spawn({
    cmd: [
      process.execPath,
      '--eval',
      `
      import {Context, Effect, FileSystem, Layer} from 'effect';
      import * as BunRuntime from '@effect/platform-bun/BunRuntime';
      import {CodeGraphIndexer} from ${JSON.stringify(indexerUrl)};
      import {CodeGraphStore} from ${JSON.stringify(new URL('../../src/store.ts', import.meta.url).href)};
      import {ApplicationLayer} from ${JSON.stringify(runtimeUrl)};
      const options = ${JSON.stringify(options)};
      let held = false;
      BunRuntime.runMain(Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        const observedStore = {...store, withSession: (databasePath, program, session) => store.withSession(databasePath, program, {
          ...session,
          onWriterAcquired: () => Effect.gen(function* () {
            yield* session?.onWriterAcquired?.() ?? Effect.void;
            if (!options.first) {
              if (!(yield* fs.exists(options.released))) return yield* Effect.die('Second writer acquired before the first released its barrier');
              return;
            }
            if (held) return;
            held = true;
            yield* fs.writeFileString(options.held, '');
            while (!(yield* fs.exists(options.waiting))) yield* Effect.sleep(10);
            yield* fs.writeFileString(options.released, '');
          }),
          onWriterContention: () => Effect.gen(function* () {
            yield* session?.onWriterContention?.() ?? Effect.void;
            // Only the indexer's guarded callback establishes preparation release.
            if (!options.first && session?.onWriterContention) yield* fs.writeFileString(options.waiting, '');
          }),
        })};
        const context = yield* Layer.build(Layer.fresh(CodeGraphIndexer.layer)).pipe(Effect.provideService(CodeGraphStore, observedStore));
        const indexer = Context.get(context, CodeGraphIndexer);
        const summary = yield* indexer.index({
          cwd: options.cwd, threadnoteHome: options.home, sourceOnly: true, vectorPolicy: 'off',
        });
        yield* fs.writeFileString(options.output, JSON.stringify(summary));
      }).pipe(Effect.scoped, Effect.provide(ApplicationLayer)));
    `,
    ],
    env: {...process.env, THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '1'},
    stderr: 'pipe',
    stdout: 'pipe',
  });
}
