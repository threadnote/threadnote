import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {execFileSync, spawn} from '@threadnote/testing/node-child-process';
import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Context, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {afterEach, describe, expect, it} from 'vitest';
import {runCodeGraphExport} from '@threadnote/threadnote/code_graph/commands';
import {readAllCodeGraphBuildStatuses, selectCodeGraphBuildStatuses} from '@threadnote/graph/build_status';
import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM, CodeGraphIndexer} from '@threadnote/graph/indexer';
import {
  CodeGraphDiskCapacityObservationError,
  CodeGraphDiskCapacityPressureError,
} from '@threadnote/graph/disk/capacity';
import {ensureBoundedCodeGraphFact} from '@threadnote/graph/fact/budget';
import {
  decodeStoredCodeGraphFact,
  encodeStoredCodeGraphFact,
  storedCodeGraphFactRawBytesSql,
} from '@threadnote/graph/fact/storage';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES,
} from '@threadnote/graph/incremental/work';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {readPersistedCodeGraphLocalAssociation} from '@threadnote/graph/local_provenance';
import {
  inventoryRepository,
  readContainedStableRegularFile,
  worktreeBuildRequestObservation,
  worktreeBuildRequestState,
  worktreeOverlayState,
} from '@threadnote/graph/inventory';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {codeGraphDoctorCheck, purgeAllCodeGraphIndexes, repairCodeGraphIndexes} from '@threadnote/graph/maintenance';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {compactCodeGraphStorage} from '@threadnote/graph/storage';
import {
  CodeGraphStore,
  materializedFileShardIdentity,
  materializedShardDerivationIdentity,
  type StoredCodeGraph,
} from '@threadnote/graph/store';
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeGraphStoreError,
  CodeGraphStoreNoSpaceError,
  isCodeGraphStoreNoSpaceError,
  type CodeGraphMaterializationMetrics,
  type CodeGraphProgress,
} from '@threadnote/graph/types';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {CommandExecutor} from '@threadnote/platform/command';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runDoctor, runRepair} from '@threadnote/threadnote/lifecycle';
import type {DoctorCheck} from '@threadnote/threadnote/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runEffect} from '../helpers/effect-runtime.js';

const FIXTURE_REPOSITORY = join(import.meta.dirname, '../evaluation/fixtures/code-graph-v1/repository');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('native code graph lifecycle', () => {
  it('atomically indexes, queries, traverses paths, traces impact, and preserves no-answer', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    expect(indexed.snapshot.state).toBe('ready');
    expect(indexed.snapshot.fileCount).toBeGreaterThanOrEqual(10);
    expect(indexed.snapshot.symbolCount).toBeGreaterThanOrEqual(7);
    expect(await runEffect(readPersistedCodeGraphLocalAssociation(home, indexed.identity))).toMatchObject({
      available: true,
      path: indexed.identity.repoRoot,
      state: 'verified',
    });
    const sidecar = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      indexed.identity.checkoutId,
      'local-context',
      'worktrees',
      `${indexed.identity.worktreeId}.json`,
    );
    rmSync(sidecar);

    const [definition, path, impact, missing] = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* Effect.all(
          [
            graph.inspect({
              cwd: root,
              operation: 'query',
              query: 'exclusive file lock',
              refresh: false,
              threadnoteHome: home,
            }),
            graph.inspect({
              cwd: root,
              from: 'runApplication',
              operation: 'path',
              refresh: false,
              threadnoteHome: home,
              to: 'withExclusiveFileLock',
            }),
            graph.inspect({
              cwd: root,
              operation: 'impact',
              query: 'withExclusiveFileLock',
              refresh: false,
              threadnoteHome: home,
            }),
            graph.inspect({
              cwd: root,
              operation: 'query',
              query: 'payment settlement gateway',
              refresh: false,
              threadnoteHome: home,
            }),
          ],
          {concurrency: 1},
        );
      }),
    );
    expect(definition.nodes.map(node => node.name)).toEqual(
      expect.arrayContaining(['withExclusiveFileLock', 'FileLock']),
    );
    expect(path.edges.map(edge => `${edge.sourceName}:${edge.targetName}`)).toEqual([
      'runApplication:ensureVectorIndex',
      'ensureVectorIndex:withExclusiveFileLock',
    ]);
    expect(impact.nodes.map(node => node.name)).toEqual(
      expect.arrayContaining(['ensureVectorIndex', 'refreshRecallIndex', 'runApplication']),
    );
    expect(missing.nodes).toEqual([]);
    expect(await runEffect(readPersistedCodeGraphLocalAssociation(home, indexed.identity))).toMatchObject({
      available: true,
      path: indexed.identity.repoRoot,
      state: 'verified',
    });
  });

  effectIt.effect(
    'serves parallel ready-snapshot queries without contending on SQLite connection bootstrap',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.sync(createFixtureRepository);
        const home = join(root, '.threadnote-test-home');
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const graph = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const databasePath = codeGraphDatabasePath(home, indexed);

        const queryOnly = yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql.unsafe<{readonly query_only: number}>('PRAGMA query_only');
            return Number(rows[0]?.query_only ?? 0);
          }),
          {readOnly: true},
        );
        expect(queryOnly).toBe(1);

        const selectedBehindWriterGate = yield* Deferred.make<void>();
        const writerGateLayout = codeGraphLayout(
          yield* Path.Path,
          home,
          indexed.identity.checkoutId,
          indexed.identity.worktreeId,
        );
        const fs = yield* FileSystem.FileSystem;
        const queryBehindWriterGate = yield* withExclusiveFileLock(
          fs,
          writerGateLayout.databaseWriteLockPath,
          {retryIntervalMilliseconds: 1, staleAfterMilliseconds: 5_000, waitTimeoutMilliseconds: 5_000},
          Effect.gen(function* () {
            const reader = yield* graph
              .inspect({
                cwd: root,
                interlock: {
                  afterSnapshotSelected: () => Deferred.succeed(selectedBehindWriterGate, undefined),
                },
                operation: 'query',
                query: 'withExclusiveFileLock',
                refresh: false,
                threadnoteHome: home,
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(selectedBehindWriterGate);
            return yield* Fiber.join(reader).pipe(
              Effect.timeoutOrElse({
                duration: 1_000,
                orElse: () =>
                  Effect.fail(
                    TestError.make({message: 'Ready-snapshot query waited behind the checkout database writer gate.'}),
                  ),
              }),
            );
          }),
        );
        expect(queryBehindWriterGate.nodes.some(node => node.name === 'withExclusiveFileLock')).toBe(true);

        const queryAfterPreferredRetirement = yield* graph.inspect({
          cwd: root,
          operation: 'query',
          query: 'withExclusiveFileLock',
          refresh: false,
          statusObservation: {
            borrowedSnapshotId: `cgsn_${'f'.repeat(40)}`,
            identity: indexed.identity,
          },
          threadnoteHome: home,
        });
        expect(queryAfterPreferredRetirement.snapshot.id).toBe(indexed.snapshot.id);
        expect(queryAfterPreferredRetirement.nodes.some(node => node.name === 'withExclusiveFileLock')).toBe(true);

        const selected = yield* Ref.make(0);
        const allSelected = yield* Deferred.make<void>();
        const afterSnapshotSelected = () =>
          Ref.updateAndGet(selected, count => count + 1).pipe(
            Effect.flatMap(count => (count === 8 ? Deferred.succeed(allSelected, undefined) : Effect.void)),
            Effect.andThen(
              Deferred.await(allSelected).pipe(
                Effect.timeoutOrElse({
                  duration: 5_000,
                  orElse: () =>
                    Ref.get(selected).pipe(
                      Effect.flatMap(count =>
                        Effect.die(
                          TestError.make({
                            message: `Only ${count} of 8 parallel queries selected the ready snapshot.`,
                          }),
                        ),
                      ),
                    ),
                }),
              ),
            ),
          );
        const results = yield* Effect.all(
          Array.from({length: 8}, () =>
            graph.inspect({
              cwd: root,
              interlock: {afterSnapshotSelected},
              operation: 'query',
              query: 'withExclusiveFileLock',
              refresh: false,
              threadnoteHome: home,
            }),
          ),
          {concurrency: 'unbounded'},
        );
        expect(results).toHaveLength(8);
        expect(results.every(result => result.nodes.some(node => node.name === 'withExclusiveFileLock'))).toBe(true);

        const readCompleted = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const retiredSnapshots = yield* Ref.make(0);
        const query = yield* graph
          .inspect({
            cwd: root,
            interlock: {
              afterSnapshotSelected: () =>
                Effect.sync(() => {
                  const database = new Database(databasePath);
                  try {
                    database.exec('PRAGMA foreign_keys = ON');
                    return database.query('DELETE FROM snapshots WHERE id = ?').run(indexed.snapshot.id).changes;
                  } finally {
                    database.close();
                  }
                }).pipe(Effect.flatMap(changes => Ref.set(retiredSnapshots, changes))),
              beforeReadCompletion: () =>
                Deferred.succeed(readCompleted, undefined).pipe(Effect.andThen(Deferred.await(finish))),
            },
            operation: 'query',
            query: 'withExclusiveFileLock',
            refresh: false,
            threadnoteHome: home,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(readCompleted);
        const active = yield* Effect.sync(() => snapshotLeaseCount(databasePath));
        yield* Deferred.succeed(finish, undefined);
        const queryAfterRetirement = yield* Fiber.join(query);
        const released = yield* Effect.sync(() => snapshotLeaseCount(databasePath));
        expect({active, released}).toEqual({active: 0, released: 0});
        expect(yield* Ref.get(retiredSnapshots)).toBeGreaterThan(0);
        expect(queryAfterRetirement.nodes.some(node => node.name === 'withExclusiveFileLock')).toBe(true);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    // Suite-wide graph fixtures can delay setup; the in-test 5s barrier still
    // enforces that all eight selected readers bootstrap without contention.
    60_000,
  );

  it('visibly and idempotently backfills analysis summaries when reusing a legacy ready snapshot', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      first.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const database = new Database(databasePath);
    try {
      database.exec(`
        DELETE FROM snapshot_analysis_summary_receipts;
        DELETE FROM snapshot_analysis_edge_counts;
        DELETE FROM snapshot_analysis_edge_histogram;
        DELETE FROM snapshot_analysis_symbol_counts;
      `);
    } finally {
      database.close();
    }

    const backfillProgress: Array<{readonly phase: string; readonly subphase?: string}> = [];
    const second = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({
          cwd: root,
          onProgress: progress => Effect.sync(() => backfillProgress.push(progress)),
          threadnoteHome: home,
        });
      }),
    );
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(backfillProgress).toContainEqual({
      phase: 'activating',
      snapshotId: first.snapshot.id,
      subphase: 'summarizing-analysis',
    });
    expect(backfillProgress).toContainEqual({
      phase: 'activating',
      snapshotId: first.snapshot.id,
      subphase: 'structural-ready',
    });
    expect(backfillProgress.findIndex(progress => progress.subphase === 'structural-ready')).toBeLessThan(
      backfillProgress.findIndex(progress => progress.subphase === 'summarizing-analysis'),
    );
    expect(second.diagnostics).toContain('Built the persisted whole-graph analysis summary for this reused snapshot.');

    const idempotentProgress: Array<{readonly phase: string; readonly subphase?: string}> = [];
    const third = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({
          cwd: root,
          onProgress: progress => Effect.sync(() => idempotentProgress.push(progress)),
          threadnoteHome: home,
        });
      }),
    );
    expect(third.snapshot.id).toBe(first.snapshot.id);
    expect(idempotentProgress).toContainEqual({
      phase: 'activating',
      snapshotId: first.snapshot.id,
      subphase: 'summarizing-analysis',
    });
    expect(third.diagnostics).not.toContain(
      'Built the persisted whole-graph analysis summary for this reused snapshot.',
    );
    const check = new Database(databasePath, {readonly: true});
    try {
      const receipt = check
        .query('SELECT COUNT(*) AS count FROM snapshot_analysis_summary_receipts WHERE snapshot_id = ?')
        .get(first.snapshot.id) as {readonly count: number};
      expect(receipt.count).toBe(1);
    } finally {
      check.close();
    }
  });

  it('collapses repeated logical relationships before strict full-build staging', async () => {
    const root = createFixtureRepository();
    const sourcePath = join(root, 'packages/app/src/repeated-call.ts');
    writeFileSync(
      sourcePath,
      [
        'export function repeatedTarget(): number { return 1; }',
        'export function repeatedCaller(): number { return repeatedTarget() + repeatedTarget(); }',
        '',
      ].join('\n'),
    );
    git(root, ['add', 'packages/app/src/repeated-call.ts']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'repeated logical relationship',
    ]);
    const home = join(root, '.threadnote-test-home');

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const graph = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const query = yield* graph.inspect({
          cwd: root,
          operation: 'query',
          query: 'repeatedCaller',
          refresh: false,
          threadnoteHome: home,
        });
        return {indexed, query};
      }),
    );

    expect(result.indexed.snapshot.state).toBe('ready');
    expect(
      result.query.edges.filter(
        edge =>
          edge.relation === 'calls' && edge.sourceName === 'repeatedCaller' && edge.targetName === 'repeatedTarget',
      ),
    ).toHaveLength(1);
  });

  it('synchronously refreshes stale lightweight reads when the caller requires freshness', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    let observations = 0;
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    replaceFunction(root, 'ensureVectorIndex', 'ensureFreshVectorIndex');

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* graph.inspect({
          cwd: root,
          interlock: {
            afterObservation: () => Effect.sync(() => (observations += 1)),
          },
          operation: 'query',
          query: 'ensureFreshVectorIndex',
          refresh: true,
          threadnoteHome: home,
        });
      }),
    );

    expect(result.freshness).toBe('current');
    expect(result.nodes.some(node => node.name === 'ensureFreshVectorIndex')).toBe(true);
    expect(observations).toBe(3);
  });

  it('retries a strict read when the worktree changes after its pre-read observation', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    let observations = 0;

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        return yield* query.inspect({
          cwd: root,
          interlock: {
            afterObservation: () =>
              Effect.sync(() => {
                observations += 1;
                if (observations === 1) {
                  replaceFunction(root, 'ensureVectorIndex', 'ensureObservedVectorIndex');
                }
              }),
          },
          operation: 'query',
          query: 'ensureObservedVectorIndex',
          refresh: true,
          threadnoteHome: home,
        });
      }),
    );

    expect(result.freshness).toBe('current');
    expect(result.nodes.some(node => node.name === 'ensureObservedVectorIndex')).toBe(true);
    expect(observations).toBe(4);
  });

  it('keeps dirty overlays isolated and preserves sibling views until authoritative reconciliation', async () => {
    const root = createFixtureRepository();
    git(root, ['branch', 'graph-a']);
    git(root, ['branch', 'graph-b']);
    const worktreeRoot = temporaryDirectory('threadnote-code-graph-worktrees-');
    const worktreeA = join(worktreeRoot, 'worktree-a');
    const worktreeB = join(worktreeRoot, 'worktree-b');
    git(root, ['worktree', 'add', worktreeA, 'graph-a']);
    git(root, ['worktree', 'add', worktreeB, 'graph-b']);
    replaceFunction(worktreeA, 'ensureVectorIndex', 'ensureBranchAVectorIndex');
    replaceFunction(worktreeB, 'ensureVectorIndex', 'ensureBranchBVectorIndex');
    const home = join(root, '.threadnote-test-home');

    const [resultA, resultB] = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* Effect.all(
          [
            graph.inspect({
              cwd: worktreeA,
              operation: 'query',
              query: 'ensureBranchAVectorIndex',
              threadnoteHome: home,
            }),
            graph.inspect({
              cwd: worktreeB,
              operation: 'query',
              query: 'ensureBranchBVectorIndex',
              threadnoteHome: home,
            }),
          ],
          {concurrency: 1},
        );
      }),
    );
    expect(resultA.nodes.some(node => node.name === 'ensureBranchAVectorIndex')).toBe(true);
    expect(resultA.nodes.some(node => node.name === 'ensureBranchBVectorIndex')).toBe(false);
    expect(resultB.nodes.some(node => node.name === 'ensureBranchBVectorIndex')).toBe(true);
    expect(resultB.nodes.some(node => node.name === 'ensureBranchAVectorIndex')).toBe(false);
    expect(resultA.snapshot.worktreeId).not.toBe(resultB.snapshot.worktreeId);
    expect(resultA.snapshot.id).not.toBe(resultB.snapshot.id);
    expect(resultA.snapshot.id).toMatch(/^cgsn_[0-9a-f]{40}$/u);
    expect(resultB.snapshot.id).toMatch(/^cgsn_[0-9a-f]{40}$/u);
    expect(resultA.snapshot).toMatchObject({dirty: true});
    expect(resultB.snapshot).toMatchObject({dirty: true});

    const offlineWorktreeB = `${worktreeB}-offline`;
    const identityA = await runEffect(resolveRepositoryIdentity(worktreeA));
    const databasePath = codeGraphDatabasePath(home, {identity: identityA});
    renameSync(worktreeB, offlineWorktreeB);
    try {
      expect(await graphHealthAfterIndex(worktreeA, home)).toMatchObject({activeSnapshots: 2, readySnapshots: 3});
      expect(activeSnapshotId(databasePath, resultB.snapshot.worktreeId)).toBe(resultB.snapshot.id);
    } finally {
      renameSync(offlineWorktreeB, worktreeB);
    }

    git(root, ['worktree', 'remove', '--force', worktreeB]);
    expect(await graphHealthAfterIndex(worktreeA, home)).toMatchObject({activeSnapshots: 2, readySnapshots: 3});
    expect(activeSnapshotId(databasePath, resultB.snapshot.worktreeId)).toBe(resultB.snapshot.id);
  });

  effectIt.effect('shares immutable clean snapshots without coupling worktree activation', () =>
    Effect.gen(function* () {
      const {home, worktreeA, worktreeB} = yield* Effect.sync(() => {
        const root = createFixtureRepository();
        git(root, ['branch', 'graph-clean-a']);
        git(root, ['branch', 'graph-clean-b']);
        const worktreeRoot = temporaryDirectory('threadnote-code-graph-clean-worktrees-');
        const worktreeA = join(worktreeRoot, 'worktree-a');
        const worktreeB = join(worktreeRoot, 'worktree-b');
        git(root, ['worktree', 'add', worktreeA, 'graph-clean-a']);
        git(root, ['worktree', 'add', worktreeB, 'graph-clean-b']);
        return {home: join(root, '.threadnote-test-home'), worktreeA, worktreeB};
      });
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const graph = yield* CodeGraphQueryService;
      const first = yield* indexer.index({cwd: worktreeA, threadnoteHome: home});
      const second = yield* indexer.index({cwd: worktreeB, threadnoteHome: home});
      const forced = yield* indexer.index({cwd: worktreeA, force: true, threadnoteHome: home});
      const databasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        first.identity.checkoutId,
        'graph-v3.sqlite',
      );
      const health = yield* store.diagnose(databasePath);

      expect(first.snapshot.id).toBe(second.snapshot.id);
      expect(forced.reusedFiles).toBe(0);
      expect(forced.snapshot.id).not.toBe(first.snapshot.id);
      expect(health).toMatchObject({
        activeSnapshots: 2,
        buildingSnapshots: 0,
        failedSnapshots: 0,
        integrity: 'ok',
        readySnapshots: 2,
      });

      yield* Effect.sync(() => {
        const audit = new Database(databasePath);
        try {
          audit.exec(`
            CREATE TABLE cache_write_audit (operation TEXT NOT NULL);
            CREATE TRIGGER cache_insert_audit AFTER INSERT ON file_blobs
            BEGIN INSERT INTO cache_write_audit VALUES ('insert'); END;
            CREATE TRIGGER cache_update_audit AFTER UPDATE ON file_blobs
            BEGIN INSERT INTO cache_write_audit VALUES ('update'); END;
          `);
        } finally {
          audit.close();
        }
        replaceFunction(worktreeA, 'ensureVectorIndex', 'ensureDirtyVectorIndex');
      });

      const indexed = yield* indexer.index({cwd: worktreeA, threadnoteHome: home});
      const dirty = yield* graph.inspect({
        cwd: worktreeA,
        operation: 'query',
        query: 'ensureDirtyVectorIndex',
        threadnoteHome: home,
      });
      const clean = yield* graph.inspect({
        cwd: worktreeB,
        operation: 'query',
        query: 'ensureVectorIndex',
        refresh: false,
        threadnoteHome: home,
      });
      const effectiveDirtyGraph = yield* store.loadGraph(databasePath, indexed.snapshot.id);
      const afterDirtyHealth = yield* store.diagnose(databasePath);
      const materialization = indexed.materialization;
      expect(materialization).toEqual({
        closureProjects: 2,
        mode: 'incremental-overlay',
        resolutionClosure: 'project',
        resolutionLookupKeyForm: 'typescript-path-scoped',
        resolutionPublicationGate: 'exported',
        stagedFiles: 6,
        totalFiles: 13,
      });
      expect(indexed.snapshot).toMatchObject({baseSnapshotId: forced.snapshot.id, dirty: true});
      expect(effectiveDirtyGraph.symbols).toHaveLength(indexed.snapshot.symbolCount);
      expect(effectiveDirtyGraph.edges).toHaveLength(indexed.snapshot.edgeCount);
      expect(dirty.nodes.some(node => node.name === 'ensureDirtyVectorIndex')).toBe(true);
      expect(clean.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(true);
      expect(afterDirtyHealth).toMatchObject({
        activeSnapshots: 2,
        integrity: 'ok',
        readySnapshots: 3,
      });
      yield* Effect.sync(() => {
        const database = new Database(databasePath, {readonly: true});
        try {
          const stored = database
            .query<{readonly count: number}, [string]>('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
            .get(dirty.snapshot.id);
          const changedFiles = database
            .query<{readonly count: number}, [string]>(
              'SELECT COUNT(*) AS count FROM snapshot_files WHERE snapshot_id = ?',
            )
            .get(dirty.snapshot.id);
          const cacheWrites = database
            .query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM cache_write_audit')
            .get();
          expect(stored?.count).toBeLessThan(indexed.snapshot.symbolCount);
          expect(changedFiles?.count).toBe(materialization?.stagedFiles);
          expect(cacheWrites?.count).toBe(1);
        } finally {
          database.close();
        }
      });
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('opens existing-only writable sessions without creating a missing graph database', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const fs = yield* FileSystem.FileSystem;
      const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
      const databasePath = codeGraphDatabasePath(home, indexed);
      const selected = yield* store.withSession(
        databasePath,
        Effect.scoped(
          Effect.acquireUseRelease(
            store.acquireSnapshotLease(databasePath, indexed.snapshot.id, 60_000),
            () => store.readySnapshot(databasePath, indexed.identity.worktreeId),
            token => store.releaseSnapshotLease(databasePath, token),
          ),
        ),
        {existingOnly: true},
      );
      expect(selected?.id).toBe(indexed.snapshot.id);

      const missing = join(home, 'indexes', 'code-graph', 'missing.sqlite');
      expect(yield* fs.exists(missing)).toBe(false);
      const failure = yield* store.withSession(missing, Effect.void, {existingOnly: true}).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(CodeGraphStoreError);
      expect(failure.message).toBe('Existing code graph database could not be opened.');
      expect(yield* fs.exists(missing)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('attaches a shared clean ready snapshot to a new worktree without rematerializing', async () => {
    const root = createFixtureRepository();
    git(root, ['branch', 'graph-attach-a']);
    git(root, ['branch', 'graph-attach-b']);
    const worktreeRoot = temporaryDirectory('threadnote-code-graph-attach-worktrees-');
    const worktreeA = join(worktreeRoot, 'worktree-a');
    const worktreeB = join(worktreeRoot, 'worktree-b');
    git(root, ['worktree', 'add', worktreeA, 'graph-attach-a']);
    git(root, ['worktree', 'add', worktreeB, 'graph-attach-b']);
    const home = join(root, '.threadnote-test-home');

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        const indexer = yield* CodeGraphIndexer;
        const first = yield* indexer.index({cwd: worktreeA, threadnoteHome: home});
        const identityB = yield* resolveRepositoryIdentity(worktreeB);
        const before = yield* graph.statusForIdentity(home, identityB);
        let identityResolutionCount = 0;
        let identityResolutionCountAtPromotion: number | undefined;
        const attached = yield* graph.attachSharedReadySnapshot(home, identityB, before, {
          afterPromotion: () =>
            Effect.sync(() => {
              identityResolutionCountAtPromotion = identityResolutionCount;
            }),
          beforeIdentityResolution: () =>
            Effect.sync(() => {
              identityResolutionCount += 1;
            }),
        });
        const direct = yield* graph.attachSharedReadySnapshot(home, identityB);
        const after = yield* graph.statusForIdentity(home, identityB);
        const found = yield* graph.inspect({
          cwd: worktreeB,
          operation: 'query',
          query: 'ensureVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        return {
          after,
          attached,
          before,
          direct,
          first,
          found,
          identityB,
          identityResolutionCountAtPromotion,
        };
      }),
    );

    expect(result.before.readySnapshot).toBeUndefined();
    expect(result.before.stale).toBe(true);
    expect(result.attached.stale).toBe(false);
    expect(result.attached.readySnapshot?.id).toBe(result.first.snapshot.id);
    expect(result.attached.readySnapshot?.worktreeId).toBe(result.identityB.worktreeId);
    expect(result.direct.readySnapshot?.id).toBe(result.first.snapshot.id);
    // Shared attach spends exactly one full identity resolution immediately
    // before promotion. Measure at the promotion interlock so the asynchronous
    // maintenance kick cannot be mistaken for work performed by this path.
    expect(result.identityResolutionCountAtPromotion).toBe(1);
    expect(result.after.readySnapshot?.id).toBe(result.first.snapshot.id);
    expect(result.after.stale).toBe(false);
    expect(result.found.snapshot.id).toBe(result.first.snapshot.id);
    expect(result.found.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(true);
  });

  effectIt.effect('borrows a divergent-HEAD clean snapshot as stale evidence without promotion', () =>
    Effect.gen(function* () {
      const {home, worktreeA, worktreeB} = yield* Effect.sync(() => {
        const root = createFixtureRepository();
        git(root, ['branch', 'graph-borrow-a']);
        git(root, ['branch', 'graph-borrow-b']);
        const worktreeRoot = temporaryDirectory('threadnote-code-graph-borrow-worktrees-');
        const worktreeA = join(worktreeRoot, 'worktree-a');
        const worktreeB = join(worktreeRoot, 'worktree-b');
        git(root, ['worktree', 'add', worktreeA, 'graph-borrow-a']);
        git(root, ['worktree', 'add', worktreeB, 'graph-borrow-b']);
        writeFileSync(
          join(worktreeB, 'divergent-head.ts'),
          'export function divergentHeadOnly(): string { return "divergent"; }\n',
        );
        git(worktreeB, ['add', 'divergent-head.ts']);
        git(worktreeB, [
          '-c',
          'user.name=Threadnote Test',
          '-c',
          'user.email=test@threadnote.local',
          'commit',
          '-m',
          'diverge graph worktree',
        ]);
        return {home: join(root, '.threadnote-test-home'), worktreeA, worktreeB};
      });
      const graph = yield* CodeGraphQueryService;
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const indexed = yield* indexer.index({cwd: worktreeA, threadnoteHome: home});
      const identityB = yield* resolveRepositoryIdentity(worktreeB);
      const before = yield* graph.statusForIdentity(home, identityB, {requestMaintenance: false});
      const exactOnly = yield* graph.attachSharedReadySnapshot(home, identityB, before, {
        requestMaintenance: false,
      });
      const borrowed = yield* graph.attachSharedReadySnapshot(home, identityB, exactOnly, {
        allowBorrowedStale: true,
        requestMaintenance: false,
      });
      const activeAfterBorrow = yield* store.readySnapshot(borrowed.databasePath, identityB.worktreeId);
      const found = yield* graph.inspect({
        cwd: worktreeB,
        operation: 'query',
        query: 'ensureVectorIndex',
        refresh: false,
        requestMaintenance: false,
        statusObservation: observationFromCodeGraphStatus(borrowed),
        strictFreshness: false,
        threadnoteHome: home,
      });

      expect(before.readySnapshot).toBeUndefined();
      expect(exactOnly.readySnapshot).toBeUndefined();
      expect(borrowed).toMatchObject({
        freshness: 'stale',
        readySnapshot: {
          commit: indexed.snapshot.commit,
          id: indexed.snapshot.id,
          worktreeId: identityB.worktreeId,
        },
        stale: true,
      });
      expect(activeAfterBorrow).toBeUndefined();
      expect(found).toMatchObject({
        freshness: 'stale',
        snapshot: {
          commit: indexed.snapshot.commit,
          id: indexed.snapshot.id,
          worktreeId: identityB.worktreeId,
        },
      });
      expect(found.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(true);
      expect(found.nodes.some(node => node.name === 'divergentHeadOnly')).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('attaches a shared clean base while a sibling worktree keeps a dirty overlay', async () => {
    const root = createFixtureRepository();
    git(root, ['branch', 'graph-sibling-a']);
    git(root, ['branch', 'graph-sibling-b']);
    const worktreeRoot = temporaryDirectory('threadnote-code-graph-sibling-dirty-');
    const worktreeA = join(worktreeRoot, 'worktree-a');
    const worktreeB = join(worktreeRoot, 'worktree-b');
    git(root, ['worktree', 'add', worktreeA, 'graph-sibling-a']);
    git(root, ['worktree', 'add', worktreeB, 'graph-sibling-b']);
    const home = join(root, '.threadnote-test-home');

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        const indexer = yield* CodeGraphIndexer;
        const clean = yield* indexer.index({cwd: worktreeA, threadnoteHome: home});
        replaceFunction(worktreeA, 'ensureVectorIndex', 'ensureSiblingDirtyVectorIndex');
        const dirty = yield* indexer.index({cwd: worktreeA, threadnoteHome: home});
        const identityB = yield* resolveRepositoryIdentity(worktreeB);
        const attached = yield* graph.attachSharedReadySnapshot(home, identityB);
        const found = yield* graph.inspect({
          cwd: worktreeB,
          operation: 'query',
          query: 'ensureVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        const dirtyOnly = yield* graph.inspect({
          cwd: worktreeA,
          operation: 'query',
          query: 'ensureSiblingDirtyVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        return {attached, clean, dirty, dirtyOnly, found, identityB};
      }),
    );

    expect(result.dirty.snapshot.dirty).toBe(true);
    expect(result.dirty.snapshot.id).not.toBe(result.clean.snapshot.id);
    expect(result.attached.stale).toBe(false);
    expect(result.attached.readySnapshot?.dirty).toBe(false);
    expect(result.attached.readySnapshot?.id).toBe(result.clean.snapshot.id);
    expect(result.attached.readySnapshot?.worktreeId).toBe(result.identityB.worktreeId);
    expect(result.found.snapshot.id).toBe(result.clean.snapshot.id);
    expect(result.found.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(true);
    expect(result.found.nodes.some(node => node.name === 'ensureSiblingDirtyVectorIndex')).toBe(false);
    expect(result.dirtyOnly.snapshot.id).toBe(result.dirty.snapshot.id);
    expect(result.dirtyOnly.nodes.some(node => node.name === 'ensureSiblingDirtyVectorIndex')).toBe(true);
  });

  it('aliases a graph-equivalent clean commit without reparsing or rematerializing files', async () => {
    const root = createManySourceRepository(12);
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '-qm',
      'metadata-only commit',
    ]);

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const second = yield* indexer.index({cwd: root, threadnoteHome: home});
        const firstGraph = yield* store.loadGraph(codeGraphDatabasePath(home, first), first.snapshot.id);
        const secondGraph = yield* store.loadGraph(codeGraphDatabasePath(home, second), second.snapshot.id);
        const found = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'original0',
          refresh: false,
          threadnoteHome: home,
        });
        return {firstGraph, found, second, secondGraph};
      }),
    );

    expect(result.second.snapshot.id).not.toBe(first.snapshot.id);
    expect(result.second.snapshot).toMatchObject({baseSnapshotId: first.snapshot.id, dirty: false});
    expect(result.second.snapshot.graphContentId).toBe(first.snapshot.graphContentId);
    expect(result.second.snapshot.graphContentId).toMatch(/^cgc_[0-9a-f]{40}$/);
    expect(result.second.materialization).toEqual({
      mode: 'reused-snapshot',
      stagedFiles: 0,
      totalFiles: 12,
    });
    expect(result.second.reusedFiles).toBe(12);
    expect(normalizeStoredGraph(result.secondGraph)).toEqual(normalizeStoredGraph(result.firstGraph));
    expect(result.found.nodes.some(node => node.name === 'original0')).toBe(true);

    const database = new Database(codeGraphDatabasePath(home, result.second), {readonly: true});
    try {
      const owned = database
        .query<{readonly files: number; readonly symbols: number}, [string, string]>(
          `SELECT
             (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = ?) AS files,
             (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ?) AS symbols`,
        )
        .get(result.second.snapshot.id, result.second.snapshot.id);
      expect(owned).toEqual({files: 0, symbols: 0});
    } finally {
      database.close();
    }
  });

  effectIt.effect('aliases an exactly committed dirty root and reuses it for the next overlay', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(() => createManySourceRepository(12));
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      yield* indexer.index({cwd: root, threadnoteHome: home});
      const committedPath = join(root, 'src/file-000.ts');
      yield* Effect.sync(() => {
        writeFileSync(committedPath, readFileSync(committedPath, 'utf8').replace('return 0;', 'return 1000;'));
      });
      const dirtyRoot = yield* indexer.index({
        cwd: root,
        incrementalOverlay: false,
        threadnoteHome: home,
      });
      const databasePath = codeGraphDatabasePath(home, dirtyRoot);
      const dirtyReceipt = yield* store.reusableBaseReceipt(databasePath, dirtyRoot.snapshot.id, {
        allowDirtyRoot: true,
      });
      if (!dirtyReceipt) return yield* TestError.make({message: 'Expected the dirty root to have a reuse receipt.'});
      const overlayFingerprint = dirtyRoot.snapshot.overlayFingerprint;
      if (!overlayFingerprint) {
        return yield* TestError.make({message: 'Expected the dirty root to have an overlay fingerprint.'});
      }
      const dirtyCandidate = yield* store.reusableOverlayBase!(
        databasePath,
        dirtyRoot.identity.repositoryId,
        dirtyRoot.snapshot.extractorSet,
        overlayFingerprint,
      );
      if (!dirtyCandidate) {
        return yield* TestError.make({message: 'Expected the dirty root to remain reusable.'});
      }
      const aliasCandidate = {
        baseSnapshotId: dirtyRoot.snapshot.id,
        commit: dirtyRoot.identity.headCommit,
        dirty: false,
        edgeCount: dirtyRoot.snapshot.edgeCount,
        extractorSet: dirtyRoot.snapshot.extractorSet,
        fileCount: dirtyRoot.snapshot.fileCount,
        graphContentId: dirtyRoot.snapshot.graphContentId ?? dirtyRoot.snapshot.id,
        id: `cgsn_${'f'.repeat(40)}`,
        repositoryId: dirtyRoot.identity.repositoryId,
        state: 'ready' as const,
        symbolCount: dirtyRoot.snapshot.symbolCount,
        worktreeId: dirtyRoot.identity.worktreeId,
      };
      const rejectedWithoutExactEvidence = yield* store.activateCleanSnapshotAlias!(
        databasePath,
        dirtyRoot.identity,
        aliasCandidate,
        dirtyRoot.snapshot.id,
        dirtyReceipt,
      ).pipe(Effect.flip);
      expect(rejectedWithoutExactEvidence.message).toContain('does not exactly match');
      const rejectedMismatchedGraph = yield* store.activateCleanSnapshotAlias!(
        databasePath,
        dirtyRoot.identity,
        {...aliasCandidate, graphContentId: `cgc_${'e'.repeat(40)}`, id: `cgsn_${'e'.repeat(40)}`},
        dirtyRoot.snapshot.id,
        dirtyReceipt,
        {
          exactBaseFiles: dirtyCandidate.files,
          expectedBaseGraphContentId: dirtyRoot.snapshot.graphContentId ?? dirtyRoot.snapshot.id,
        },
      ).pipe(Effect.flip);
      expect(rejectedMismatchedGraph.message).toContain('does not exactly match');
      yield* Effect.sync(() => {
        git(root, ['add', 'src/file-000.ts']);
        git(root, [
          '-c',
          'user.name=Threadnote Test',
          '-c',
          'user.email=test@threadnote.local',
          'commit',
          '-qm',
          'commit indexed worktree',
        ]);
      });

      const committed = yield* indexer.index({cwd: root, threadnoteHome: home});
      const dirtyGraph = yield* store.loadGraph(databasePath, dirtyRoot.snapshot.id);
      const committedGraph = yield* store.loadGraph(databasePath, committed.snapshot.id);

      expect(dirtyRoot.snapshot).toMatchObject({baseSnapshotId: undefined, dirty: true});
      expect(dirtyRoot.materialization).toMatchObject({fallbackReason: 'disabled', mode: 'full'});
      expect(committed.snapshot).toMatchObject({baseSnapshotId: dirtyRoot.snapshot.id, dirty: false});
      expect(committed.materialization).toEqual({mode: 'reused-snapshot', stagedFiles: 0, totalFiles: 12});
      expect(committed.reusedFiles).toBe(12);
      expect(normalizeStoredGraph(committedGraph)).toEqual(normalizeStoredGraph(dirtyGraph));

      const nextPath = join(root, 'src/file-001.ts');
      yield* Effect.sync(() => {
        writeFileSync(nextPath, readFileSync(nextPath, 'utf8').replace('return 1;', 'return 1001;'));
      });
      const next = yield* indexer.index({cwd: root, threadnoteHome: home});
      const nextGraph = yield* store.loadGraph(databasePath, next.snapshot.id);
      const forced = yield* indexer.index({cwd: root, force: true, threadnoteHome: home});
      const forcedGraph = yield* store.loadGraph(databasePath, forced.snapshot.id);

      expect(next.snapshot).toMatchObject({baseSnapshotId: dirtyRoot.snapshot.id, dirty: true});
      expect(next.materialization).toEqual({mode: 'incremental-overlay', stagedFiles: 1, totalFiles: 12});
      expect(normalizeStoredGraph(nextGraph)).toEqual(normalizeStoredGraph(forcedGraph));
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('materializes only body-changed files for a compatible clean commit', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(24);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const first = yield* indexer.index({cwd: root, threadnoteHome: home});
      const changedPath = join(root, 'src/file-000.ts');
      writeFileSync(changedPath, readFileSync(changedPath, 'utf8').replace('return 0;', 'return 1000;'));
      git(root, ['add', 'src/file-000.ts']);
      git(root, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'body-only change',
      ]);

      const probes = new Map<string, number>();
      const incremental = yield* indexer.index({
        cwd: root,
        diskCapacityAvailableBytes: (_target, boundary) =>
          Effect.sync(() => {
            probes.set(boundary.operation, (probes.get(boundary.operation) ?? 0) + 1);
            return Number.MAX_SAFE_INTEGER;
          }),
        threadnoteHome: home,
      });
      const incrementalGraph = yield* store.loadGraph(
        codeGraphDatabasePath(home, incremental),
        incremental.snapshot.id,
      );
      const full = yield* indexer.index({cwd: root, force: true, threadnoteHome: home});
      const fullGraph = yield* store.loadGraph(codeGraphDatabasePath(home, full), full.snapshot.id);

      expect(incremental.snapshot).toMatchObject({baseSnapshotId: first.snapshot.id, dirty: false});
      expect(incremental.materialization).toEqual({
        mode: 'incremental-clean',
        stagedFiles: 1,
        totalFiles: 24,
      });
      expect(incremental.diagnostics).toContain('Clean snapshot reused persisted base for 1 modified file(s).');
      expect(normalizeStoredGraph(incrementalGraph)).toEqual(normalizeStoredGraph(fullGraph));
      const probesPerObservation = statSync(root).dev === statSync(tmpdir()).dev ? 1 : 2;
      expect(Object.fromEntries(probes)).toEqual({
        'cache code graph file facts': probesPerObservation,
        'prepare temporary incremental code graph activation': probesPerObservation,
        'promote ready code graph snapshot': probesPerObservation,
        'publish temporary code graph snapshot': probesPerObservation,
      });
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('selects the nearest compatible ancestor instead of a newer sibling commit', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(12);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const first = yield* indexer.index({cwd: root, threadnoteHome: home});
      const baseCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
      const siblingRoot = `${root}-sibling`;
      temporaryRoots.push(siblingRoot);

      git(root, ['worktree', 'add', '-qb', 'sibling', siblingRoot, baseCommit]);
      writeFileSync(
        join(siblingRoot, 'src/file-001.ts'),
        readFileSync(join(siblingRoot, 'src/file-001.ts'), 'utf8').replace('return 1;', 'return 101;'),
      );
      git(siblingRoot, ['add', 'src/file-001.ts']);
      git(siblingRoot, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'newer sibling',
      ]);
      const sibling = yield* indexer.index({cwd: siblingRoot, force: true, threadnoteHome: home});

      git(root, ['checkout', '-qb', 'target']);
      writeFileSync(
        join(root, 'src/file-000.ts'),
        readFileSync(join(root, 'src/file-000.ts'), 'utf8').replace('return 0;', 'return 100;'),
      );
      git(root, ['add', 'src/file-000.ts']);
      git(root, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'target child',
      ]);
      const target = yield* indexer.index({cwd: root, threadnoteHome: home});

      expect(sibling.snapshot.baseSnapshotId).toBeUndefined();
      expect(target.snapshot.baseSnapshotId).toBe(first.snapshot.id);
      expect(target.snapshot.baseSnapshotId).not.toBe(sibling.snapshot.id);
      expect(target.materialization).toEqual({mode: 'incremental-clean', stagedFiles: 1, totalFiles: 12});
      expect(target.incrementalWork).toMatchObject({changedFiles: 1, deletedFiles: 0, totalFiles: 12});
      expect(target.incrementalWork?.factBytes).toBeGreaterThan(0);
      expect(target.incrementalWork?.plannedRows).toBeGreaterThan(0);
      expect(target.incrementalWork?.sourceBytes).toBeLessThan(1_024);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reuses a compatible root when equally near merge parents are both ready', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(4);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const base = yield* indexer.index({cwd: root, threadnoteHome: home});
      const baseCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
      const rightRoot = `${root}-right`;
      temporaryRoots.push(rightRoot);

      git(root, ['checkout', '-qb', 'left']);
      writeFileSync(
        join(root, 'src/file-000.ts'),
        readFileSync(join(root, 'src/file-000.ts'), 'utf8').replace('return 0;', 'return 10;'),
      );
      git(root, ['add', 'src/file-000.ts']);
      git(root, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'left change',
      ]);
      const left = yield* indexer.index({cwd: root, force: true, threadnoteHome: home});

      git(root, ['worktree', 'add', '-qb', 'right', rightRoot, baseCommit]);
      writeFileSync(
        join(rightRoot, 'src/file-001.ts'),
        readFileSync(join(rightRoot, 'src/file-001.ts'), 'utf8').replace('return 1;', 'return 11;'),
      );
      git(rightRoot, ['add', 'src/file-001.ts']);
      git(rightRoot, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'right change',
      ]);
      const right = yield* indexer.index({cwd: rightRoot, force: true, threadnoteHome: home});

      git(root, [
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'merge',
        '--no-edit',
        'right',
      ]);
      const merged = yield* indexer.index({cwd: root, threadnoteHome: home});
      const mergedGraph = yield* store.loadGraph(codeGraphDatabasePath(home, merged), merged.snapshot.id);
      const full = yield* indexer.index({cwd: root, force: true, threadnoteHome: home});
      const fullGraph = yield* store.loadGraph(codeGraphDatabasePath(home, full), full.snapshot.id);

      expect([base.snapshot.id, left.snapshot.id, right.snapshot.id]).toContain(merged.snapshot.baseSnapshotId);
      expect(merged.materialization?.mode).toBe('incremental-clean');
      expect(normalizeStoredGraph(mergedGraph)).toEqual(normalizeStoredGraph(fullGraph));
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('counts raw cached facts actually replayed by a first full materialization', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(12);
      const home = join(root, '.threadnote-test-home');
      const progress: CodeGraphProgress[] = [];
      const indexer = yield* CodeGraphIndexer;
      yield* indexer.index({
        cwd: root,
        onProgress: current => Effect.sync(() => progress.push(current)),
        threadnoteHome: home,
      });

      const metrics = finalFullMaterializationMetrics(progress);
      expect(metrics.cachedFactReplayBytesCompleted).toBe(metrics.cachedFactBytesTotal);
      expect(metrics.cachedFactReplayBytesCompleted).toBeGreaterThan(0);
      expect(metrics.rawFactReplayBytesCompleted).toBe(metrics.cachedFactBytesTotal);
      expect(metrics.materializedShardReplayBytesCompleted).toBe(0);
      expect(metrics.materializedShardCacheDeferredFilesCompleted).toBe(0);
      expect(metrics.materializedShardCacheDeferredRawFactBytesCompleted).toBe(0);
      expect(metrics.attributedFilesCompleted).toBe(12);
      expect(metrics.exactGenerationShardFilesCompleted).toBe(0);
      expect(metrics.crossGenerationShardFilesCompleted).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reuses content-addressed materialized file shards during a forced clean rebuild', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(12);
      const home = join(root, '.threadnote-test-home');
      const progress: CodeGraphProgress[] = [];
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const first = yield* indexer.index({cwd: root, threadnoteHome: home});
      const firstGraph = yield* store.loadGraph(codeGraphDatabasePath(home, first), first.snapshot.id);
      yield* repairCodeGraphIndexes(home, false);
      const rebuilt = yield* indexer.index({
        cwd: root,
        force: true,
        onProgress: current => Effect.sync(() => progress.push(current)),
        threadnoteHome: home,
      });
      const databasePath = codeGraphDatabasePath(home, rebuilt);
      const rebuiltGraph = yield* store.loadGraph(databasePath, rebuilt.snapshot.id);
      const shardState = yield* Effect.sync(() => {
        const database = new Database(databasePath, {readonly: true});
        try {
          const shards = database
            .query<{readonly bytes: number; readonly count: number}, []>(
              `SELECT COUNT(*) AS count,
                      SUM(${storedCodeGraphFactRawBytesSql('facts_json')}) AS bytes
               FROM materialized_file_shards`,
            )
            .get();
          const references = database
            .query<{readonly count: number}, [string]>(
              `SELECT COUNT(*) AS count
               FROM snapshot_file_shards
               WHERE snapshot_id = ?`,
            )
            .get(rebuilt.snapshot.id);
          return {bytes: shards?.bytes ?? 0, references: references?.count ?? 0, shards: shards?.count ?? 0};
        } finally {
          database.close();
        }
      });

      expect(rebuilt.materialization).toEqual({mode: 'full', stagedFiles: 12, totalFiles: 12});
      expect(rebuilt.diagnostics).toContain('Reused content-addressed materialized shards for 12 file(s).');
      expect(shardState.shards).toBe(12);
      expect(shardState.references).toBe(12);
      const metrics = finalFullMaterializationMetrics(progress);
      expect(metrics.cachedFactReplayBytesCompleted).toBe(shardState.bytes);
      expect(metrics.rawFactReplayBytesCompleted).toBe(0);
      expect(metrics.materializedShardReplayBytesCompleted).toBe(shardState.bytes);
      expect(metrics.materializedShardCacheDeferredFilesCompleted).toBe(0);
      expect(metrics.materializedShardCacheDeferredRawFactBytesCompleted).toBe(0);
      expect(metrics.attributedFilesCompleted).toBe(0);
      expect(metrics.exactGenerationShardFilesCompleted).toBe(12);
      expect(metrics.crossGenerationShardFilesCompleted).toBe(0);
      expect(normalizeStoredGraph(rebuiltGraph)).toEqual(normalizeStoredGraph(firstGraph));
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reattributes an incomplete deterministic batch while reusing a complete peer batch', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(130);
      const home = join(root, '.threadnote-test-home');
      const progress: CodeGraphProgress[] = [];
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const first = yield* indexer.index({cwd: root, threadnoteHome: home});
      const databasePath = codeGraphDatabasePath(home, first);
      const firstGraph = yield* store.loadGraph(databasePath, first.snapshot.id);
      const partialShardState = yield* Effect.sync(() => {
        const database = new Database(databasePath);
        try {
          const missing = database
            .query<{readonly id: string; readonly path: string}, [string]>(
              `SELECT id, path_hint AS path FROM materialized_file_shards WHERE path_hint = ?`,
            )
            .get('src/file-129.ts');
          if (!missing) throw new Error('Expected a materialized shard to remove.');
          const rawFactBytes =
            database
              .query<{readonly bytes: number}, [string, string]>(
                `SELECT COALESCE(SUM(${storedCodeGraphFactRawBytesSql('facts_json')}), 0) AS bytes
                 FROM file_blobs WHERE path_hint IN (?, ?)`,
              )
              .get('src/file-128.ts', 'src/file-129.ts')?.bytes ?? 0;
          database.query('DELETE FROM materialized_file_shards WHERE id = ?').run(missing.id);
          database.exec(`
            CREATE TABLE materialized_shard_write_audit (
              operation TEXT NOT NULL,
              path_hint TEXT NOT NULL
            );
            CREATE TRIGGER materialized_shard_insert_audit
            AFTER INSERT ON materialized_file_shards
            BEGIN
              INSERT INTO materialized_shard_write_audit VALUES ('insert', NEW.path_hint);
            END;
            CREATE TRIGGER materialized_shard_update_audit
            AFTER UPDATE ON materialized_file_shards
            BEGIN
              INSERT INTO materialized_shard_write_audit VALUES ('update', NEW.path_hint);
            END;
            CREATE TRIGGER materialized_shard_delete_audit
            AFTER DELETE ON materialized_file_shards
            BEGIN
              INSERT INTO materialized_shard_write_audit VALUES ('delete', OLD.path_hint);
            END;
          `);
          const completeShardBytes =
            database
              .query<{readonly bytes: number}, [string, string]>(
                `SELECT COALESCE(SUM(${storedCodeGraphFactRawBytesSql('facts_json')}), 0) AS bytes
                 FROM materialized_file_shards WHERE path_hint NOT IN (?, ?)`,
              )
              .get('src/file-128.ts', 'src/file-129.ts')?.bytes ?? 0;
          return {completeShardBytes, missingPath: missing.path, rawFactBytes};
        } finally {
          database.close();
        }
      });

      const rebuilt = yield* indexer.index({
        cwd: root,
        force: true,
        onProgress: current => Effect.sync(() => progress.push(current)),
        threadnoteHome: home,
      });
      const rebuiltGraph = yield* store.loadGraph(databasePath, rebuilt.snapshot.id);
      const metrics = finalFullMaterializationMetrics(progress);
      const persistedReuse = yield* Effect.sync(() => {
        const database = new Database(databasePath, {readonly: true});
        try {
          const associations =
            database
              .query<{readonly count: number}, [string]>(
                'SELECT COUNT(*) AS count FROM snapshot_file_shards WHERE snapshot_id = ?',
              )
              .get(rebuilt.snapshot.id)?.count ?? 0;
          const writes = database
            .query<{readonly operation: string; readonly path: string}, []>(
              `SELECT operation, path_hint AS path
               FROM materialized_shard_write_audit ORDER BY rowid`,
            )
            .all();
          return {associations, writes};
        } finally {
          database.close();
        }
      });

      expect(rebuilt.diagnostics).toContain('Reused content-addressed materialized shards for 128 file(s).');
      expect(partialShardState.rawFactBytes).toBeGreaterThan(0);
      expect(partialShardState.completeShardBytes).toBeGreaterThan(0);
      expect(metrics.cachedFactReplayBytesCompleted).toBe(
        partialShardState.rawFactBytes + partialShardState.completeShardBytes,
      );
      expect(metrics.rawFactReplayBytesCompleted).toBe(partialShardState.rawFactBytes);
      expect(metrics.materializedShardReplayBytesCompleted).toBe(partialShardState.completeShardBytes);
      expect(metrics.materializedShardCacheDeferredFilesCompleted).toBe(0);
      expect(metrics.materializedShardCacheDeferredRawFactBytesCompleted).toBe(0);
      expect(metrics.attributedFilesCompleted).toBe(2);
      expect(metrics.exactGenerationShardFilesCompleted).toBe(128);
      expect(metrics.crossGenerationShardFilesCompleted).toBe(0);
      expect(persistedReuse.associations).toBe(130);
      expect(persistedReuse.writes).toHaveLength(2);
      expect(persistedReuse.writes.filter(write => write.operation === 'insert')).toEqual([
        {operation: 'insert', path: partialShardState.missingPath},
      ]);
      expect(persistedReuse.writes.filter(write => write.operation === 'update')).toEqual([
        {operation: 'update', path: 'src/file-128.ts'},
      ]);
      expect(normalizeStoredGraph(rebuiltGraph)).toEqual(normalizeStoredGraph(firstGraph));
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('counts one logical changed-fact representation when an incomplete batch replays twice', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(2);
      const home = temporaryDirectory('threadnote-code-graph-changed-fact-overlap-');
      const changedPath = join(root, 'src/file-000.ts');
      writeFileSync(changedPath, readFileSync(changedPath, 'utf8').replace('return 0;', 'return 100;'));
      const indexer = yield* CodeGraphIndexer;
      const first = yield* indexer.index({cwd: root, ensureVectors: false, force: true, threadnoteHome: home});
      const databasePath = codeGraphDatabasePath(home, first);
      const replayState = yield* Effect.sync(() => {
        const database = new Database(databasePath);
        try {
          const bytes = database
            .query<
              {readonly changedRaw: number; readonly raw: number; readonly retainedShard: number},
              [string, string]
            >(
              `SELECT
                 COALESCE(SUM(${storedCodeGraphFactRawBytesSql('blob.facts_json')}), 0) AS raw,
                 COALESCE(SUM(CASE WHEN shard.path_hint = ?
                   THEN ${storedCodeGraphFactRawBytesSql('blob.facts_json')} ELSE 0 END), 0) AS changedRaw,
                 COALESCE(SUM(CASE WHEN shard.path_hint <> ?
                   THEN ${storedCodeGraphFactRawBytesSql('shard.facts_json')} ELSE 0 END), 0) AS retainedShard
               FROM materialized_file_shards AS shard
               JOIN file_blobs AS blob
                 ON blob.content_hash = shard.content_hash
                AND blob.path_hint = shard.path_hint`,
            )
            .get('src/file-000.ts', 'src/file-001.ts');
          const missing = database
            .query<{readonly id: string}, [string]>('SELECT id FROM materialized_file_shards WHERE path_hint = ?')
            .get('src/file-001.ts');
          if (!bytes || !missing)
            throw TestError.make({message: 'Expected complete materialized and raw fact cache rows.'});
          database.query('DELETE FROM materialized_file_shards WHERE id = ?').run(missing.id);
          return bytes;
        } finally {
          database.close();
        }
      });
      const progress: CodeGraphProgress[] = [];
      yield* indexer.index({
        cwd: root,
        ensureVectors: false,
        force: true,
        onProgress: current => Effect.sync(() => progress.push(current)),
        threadnoteHome: home,
      });
      const metrics = finalFullMaterializationMetrics(progress);

      expect(replayState.changedRaw).toBeGreaterThan(0);
      expect(replayState.retainedShard).toBeGreaterThan(0);
      expect(metrics.cachedFactReplayBytesCompleted).toBe(replayState.raw);
      expect(metrics.rawFactReplayBytesCompleted).toBe(replayState.raw);
      expect(metrics.materializedShardReplayBytesCompleted).toBe(0);
      expect(metrics.attributedFilesCompleted).toBe(2);
      expect(metrics.exactGenerationShardFilesCompleted).toBe(0);
      expect(metrics.crossGenerationShardFilesCompleted).toBe(0);
      expect(metrics.changedFactBytesCompleted).toBe(replayState.changedRaw);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('keeps a regenerated barrel caller shard and graph equal to a clean full build', () =>
    Effect.gen(function* () {
      const root = createAmbientOverloadBarrelRepository();
      const mixedHome = temporaryDirectory('threadnote-code-graph-ambient-overload-mixed-');
      const freshHome = temporaryDirectory('threadnote-code-graph-ambient-overload-fresh-');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const first = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: mixedHome});
      const mixedDatabasePath = codeGraphDatabasePath(mixedHome, first);
      yield* Effect.sync(() => {
        const database = new Database(mixedDatabasePath);
        try {
          const caller = database
            .query<{readonly id: string}, [string]>('SELECT id FROM materialized_file_shards WHERE path_hint = ?')
            .get('src/caller.ts');
          if (!caller) throw TestError.make({message: 'Expected the caller materialized shard to remove.'});
          database.query('DELETE FROM materialized_file_shards WHERE id = ?').run(caller.id);
        } finally {
          database.close();
        }
      });

      const rebuilt = yield* indexer.index({
        cwd: root,
        ensureVectors: false,
        force: true,
        threadnoteHome: mixedHome,
      });
      const fresh = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: freshHome});
      const freshDatabasePath = codeGraphDatabasePath(freshHome, fresh);
      const rebuiltGraph = yield* store.loadGraph(mixedDatabasePath, rebuilt.snapshot.id);
      const freshGraph = yield* store.loadGraph(freshDatabasePath, fresh.snapshot.id);
      const [rebuiltCaller, freshCaller] = yield* Effect.sync(
        () =>
          [
            materializedShardFacts(mixedDatabasePath, 'src/caller.ts'),
            materializedShardFacts(freshDatabasePath, 'src/caller.ts'),
          ] as const,
      );
      const expectedTarget = freshGraph.symbols.find(
        symbol => symbol.path === 'src/leaf.ts' && symbol.name === 'target' && symbol.arity === 2,
      );
      const call = freshGraph.edges.find(edge => edge.evidencePath === 'src/caller.ts' && edge.relation === 'calls');

      expect(expectedTarget).toBeDefined();
      expect(call).toMatchObject({confidence: 1, provenance: 'resolved', targetId: expectedTarget!.id});
      expect(rebuiltCaller).toEqual(freshCaller);
      expect(normalizeStoredGraph(rebuiltGraph)).toEqual(normalizeStoredGraph(freshGraph));
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reuses an unchanged ambient-overload batch across a body-only generation', () =>
    Effect.gen(function* () {
      const root = createAmbientOverloadBarrelRepository(126);
      const reusedHome = temporaryDirectory('threadnote-code-graph-cross-generation-overload-');
      const freshHome = temporaryDirectory('threadnote-code-graph-cross-generation-overload-fresh-');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const first = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: reusedHome});
      const changedPath = join(root, 'src/filler-125.ts');
      yield* Effect.sync(() => {
        writeFileSync(changedPath, readFileSync(changedPath, 'utf8').replace('return 125;', 'return 1125;'));
      });
      const progress: CodeGraphProgress[] = [];
      const rebuilt = yield* indexer.index({
        cwd: root,
        ensureVectors: false,
        force: true,
        onProgress: current => Effect.sync(() => progress.push(current)),
        threadnoteHome: reusedHome,
      });
      const fresh = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: freshHome});
      const reusedDatabasePath = codeGraphDatabasePath(reusedHome, rebuilt);
      const freshDatabasePath = codeGraphDatabasePath(freshHome, fresh);
      const rebuiltGraph = yield* store.loadGraph(reusedDatabasePath, rebuilt.snapshot.id);
      const freshGraph = yield* store.loadGraph(freshDatabasePath, fresh.snapshot.id);
      const metrics = finalFullMaterializationMetrics(progress);
      const freshTarget = freshGraph.symbols.find(
        symbol => symbol.path === 'src/leaf.ts' && symbol.name === 'target' && symbol.arity === 2,
      );
      const rebuiltCall = rebuiltGraph.edges.find(
        edge => edge.evidencePath === 'src/caller.ts' && edge.relation === 'calls',
      );

      expect(first.snapshot.graphContentId).not.toBe(rebuilt.snapshot.graphContentId);
      expect(rebuilt.diagnostics).toContain('Reused content-addressed materialized shards for 128 file(s).');
      expect(metrics.exactGenerationShardFilesCompleted).toBe(0);
      expect(metrics.crossGenerationShardFilesCompleted).toBe(128);
      expect(metrics.attributedFilesCompleted).toBe(2);
      expect(metrics.rawFactReplayBytesCompleted).toBeGreaterThan(0);
      expect(metrics.materializedShardReplayBytesCompleted).toBeGreaterThan(0);
      expect(freshTarget).toBeDefined();
      expect(rebuiltCall).toMatchObject({confidence: 1, provenance: 'resolved', targetId: freshTarget!.id});
      expect(materializedShardFacts(reusedDatabasePath, 'src/caller.ts')).toEqual(
        materializedShardFacts(freshDatabasePath, 'src/caller.ts'),
      );
      expect(normalizeStoredGraph(rebuiltGraph)).toEqual(normalizeStoredGraph(freshGraph));
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('invalidates every v4 batch when retained context or path membership changes', () =>
    Effect.forEach(
      [
        {
          label: 'package context',
          mutate: (root: string) =>
            writeFileSync(join(root, 'package.json'), `${JSON.stringify({name: 'ambient-overload-renamed'})}\n`),
        },
        {
          label: 'tsconfig context',
          mutate: (root: string) =>
            writeFileSync(
              join(root, 'tsconfig.json'),
              `${JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}})}\n`,
            ),
        },
        {
          label: 'path membership',
          mutate: (root: string) => renameSync(join(root, 'src/leaf.ts'), join(root, 'src/renamed-leaf.ts')),
        },
      ] as const,
      ({label, mutate}) =>
        Effect.gen(function* () {
          const root = createAmbientOverloadBarrelRepository();
          const home = temporaryDirectory(`threadnote-code-graph-v4-invalidation-${label.replaceAll(' ', '-')}-`);
          yield* Effect.sync(() => {
            writeFileSync(join(root, 'tsconfig.json'), `${JSON.stringify({compilerOptions: {baseUrl: '.'}})}\n`);
            git(root, ['add', 'tsconfig.json']);
            git(root, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '-qm',
              'add retained attribution context',
            ]);
          });
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: home});
          yield* Effect.sync(() => {
            mutate(root);
            git(root, ['add', '-A']);
            git(root, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '-qm',
              `change ${label}`,
            ]);
          });
          const progress: CodeGraphProgress[] = [];
          yield* indexer.index({
            cwd: root,
            ensureVectors: false,
            force: true,
            onProgress: current => Effect.sync(() => progress.push(current)),
            threadnoteHome: home,
          });
          const metrics = finalFullMaterializationMetrics(progress);

          expect(metrics.exactGenerationShardFilesCompleted, label).toBe(0);
          expect(metrics.crossGenerationShardFilesCompleted, label).toBe(0);
          expect(metrics.attributedFilesCompleted, label).toBe(5);
          expect(metrics.materializedShardReplayBytesCompleted, label).toBe(0);
          expect(metrics.rawFactReplayBytesCompleted, label).toBeGreaterThan(0);
        }),
      {concurrency: 1},
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('fails closed on partial association provenance or malformed v4 payloads', () =>
    Effect.forEach(
      [
        {
          label: 'partial association',
          mutate: (database: Database, snapshotId: string) => {
            expect(
              database
                .query('DELETE FROM snapshot_file_shards WHERE snapshot_id = ? AND path = ?')
                .run(snapshotId, 'src/file-001.ts').changes,
            ).toBe(1);
          },
        },
        {
          label: 'malformed payload',
          mutate: (database: Database) => {
            expect(
              database
                .query("UPDATE materialized_file_shards SET facts_json = '{' WHERE path_hint = ?")
                .run('src/file-001.ts').changes,
            ).toBe(1);
          },
        },
      ] as const,
      ({label, mutate}) =>
        Effect.gen(function* () {
          const root = createManySourceRepository(2);
          const home = temporaryDirectory(`threadnote-code-graph-v4-fail-closed-${label.replaceAll(' ', '-')}-`);
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const first = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: home});
          const databasePath = codeGraphDatabasePath(home, first);
          const firstGraph = yield* store.loadGraph(databasePath, first.snapshot.id);
          yield* Effect.sync(() => {
            const database = new Database(databasePath);
            try {
              mutate(database, first.snapshot.id);
            } finally {
              database.close();
            }
          });
          const progress: CodeGraphProgress[] = [];
          const rebuilt = yield* indexer.index({
            cwd: root,
            ensureVectors: false,
            force: true,
            onProgress: current => Effect.sync(() => progress.push(current)),
            threadnoteHome: home,
          });
          const rebuiltGraph = yield* store.loadGraph(databasePath, rebuilt.snapshot.id);
          const metrics = finalFullMaterializationMetrics(progress);

          expect(metrics.exactGenerationShardFilesCompleted, label).toBe(0);
          expect(metrics.crossGenerationShardFilesCompleted, label).toBe(0);
          expect(metrics.attributedFilesCompleted, label).toBe(2);
          expect(metrics.rawFactReplayBytesCompleted, label).toBeGreaterThan(0);
          expect(
            rebuilt.diagnostics.some(value => value.startsWith('Reused content-addressed materialized shards')),
          ).toBe(false);
          expect(normalizeStoredGraph(rebuiltGraph), label).toEqual(normalizeStoredGraph(firstGraph));
        }),
      {concurrency: 1},
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not synthesize one complete batch from complementary partial donors', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(2);
      const home = temporaryDirectory('threadnote-code-graph-complementary-shard-donors-');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const first = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: home});
      const databasePath = codeGraphDatabasePath(home, first);
      const donor = yield* Effect.sync(() => {
        const database = new Database(databasePath);
        try {
          const rows = database
            .query<
              {
                readonly contentHash: string;
                readonly derivationIdentity: string;
                readonly extractorSet: string;
                readonly id: string;
                readonly path: string;
              },
              []
            >(
              `SELECT id, content_hash AS contentHash, extractor_set AS extractorSet,
                      derivation_identity AS derivationIdentity, path_hint AS path
               FROM materialized_file_shards ORDER BY path_hint`,
            )
            .all();
          expect(rows).toHaveLength(2);
          expect(new Set(rows.map(row => row.derivationIdentity)).size).toBe(1);
          const secondSnapshotId = 'cgsn_complementary_partial_donor';
          database
            .query(
              `INSERT INTO snapshots (
                 id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
                 extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
                 edge_count, started_at, completed_at, failure_summary
               )
               SELECT ?, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
                      extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
                      edge_count, started_at, completed_at, failure_summary
               FROM snapshots WHERE id = ?`,
            )
            .run(secondSnapshotId, first.snapshot.id);
          database
            .query('INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id) VALUES (?, ?, ?)')
            .run(secondSnapshotId, rows[1].path, rows[1].id);
          expect(
            database
              .query('DELETE FROM snapshot_file_shards WHERE snapshot_id = ? AND path = ?')
              .run(first.snapshot.id, rows[1].path).changes,
          ).toBe(1);
          return {
            derivationIdentity: rows[0].derivationIdentity,
            extractorSet: rows[0].extractorSet,
            files: rows.map(row => ({contentHash: row.contentHash, path: row.path})),
            secondSnapshotId,
          };
        } finally {
          database.close();
        }
      });
      const loaded = yield* store.loadMaterializedFileShards(
        databasePath,
        donor.files,
        donor.extractorSet,
        donor.derivationIdentity,
        {
          currentGraphContentId: first.snapshot.graphContentId ?? first.snapshot.id,
          snapshotIds: [first.snapshot.id, donor.secondSnapshotId],
        },
      );

      expect(loaded.facts.size).toBe(0);
      expect(loaded.materializedShardIdsByPath?.size).toBe(0);
      expect(loaded.exactGenerationFiles).toBe(0);
      expect(loaded.bytes).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not admit associated v3 shard rows into a v4 materialization batch', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(2);
      const home = temporaryDirectory('threadnote-code-graph-v3-shard-ineligible-');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const first = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: home});
      const databasePath = codeGraphDatabasePath(home, first);
      const receipt = yield* store.reusableBaseReceipt(databasePath, first.snapshot.id);
      if (!receipt) return yield* TestError.make({message: 'Expected a reusable base receipt.'});
      const v3Derivation = materializedShardDerivationIdentity(
        first.snapshot.extractorSet,
        receipt.workspaceFingerprint,
        first.snapshot.graphContentId ?? first.snapshot.id,
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.sync(() => {
        const database = new Database(databasePath);
        try {
          const rows = database
            .query<
              {
                readonly contentHash: string;
                readonly extractorSet: string;
                readonly factsJson: string;
                readonly path: string;
              },
              []
            >(
              `SELECT content_hash AS contentHash, extractor_set AS extractorSet,
                      facts_json AS factsJson, path_hint AS path
               FROM materialized_file_shards ORDER BY path_hint`,
            )
            .all();
          expect(rows).toHaveLength(2);
          database.query('DELETE FROM snapshot_file_shards WHERE snapshot_id = ?').run(first.snapshot.id);
          database.exec('DELETE FROM materialized_file_shards');
          const insertShard = database.prepare(
            `INSERT INTO materialized_file_shards (
               id, content_hash, extractor_set, derivation_identity, path_hint,
               facts_json, created_at, last_used_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const associate = database.prepare(
            'INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id) VALUES (?, ?, ?)',
          );
          for (const row of rows) {
            const id = materializedFileShardIdentity(row.contentHash, row.extractorSet, v3Derivation, row.path);
            insertShard.run(id, row.contentHash, row.extractorSet, v3Derivation, row.path, row.factsJson, now, now);
            associate.run(first.snapshot.id, row.path, id);
          }
        } finally {
          database.close();
        }
      });
      const progress: CodeGraphProgress[] = [];
      const rebuilt = yield* indexer.index({
        cwd: root,
        ensureVectors: false,
        force: true,
        onProgress: current => Effect.sync(() => progress.push(current)),
        threadnoteHome: home,
      });
      const metrics = finalFullMaterializationMetrics(progress);
      const selectedDerivations = yield* Effect.sync(() => {
        const database = new Database(databasePath, {readonly: true});
        try {
          return database
            .query<{readonly derivation: string}, [string]>(
              `SELECT DISTINCT shard.derivation_identity AS derivation
               FROM snapshot_file_shards AS association
               JOIN materialized_file_shards AS shard ON shard.id = association.shard_id
               WHERE association.snapshot_id = ?`,
            )
            .all(rebuilt.snapshot.id)
            .map(row => row.derivation);
        } finally {
          database.close();
        }
      });

      expect(metrics.exactGenerationShardFilesCompleted).toBe(0);
      expect(metrics.crossGenerationShardFilesCompleted).toBe(0);
      expect(metrics.attributedFilesCompleted).toBe(2);
      expect(metrics.materializedShardReplayBytesCompleted).toBe(0);
      expect(metrics.rawFactReplayBytesCompleted).toBeGreaterThan(0);
      expect(selectedDerivations).toHaveLength(1);
      expect(selectedDerivations).not.toContain(v3Derivation);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('reextracts one invalid parser-cache item without discarding valid peers', async () => {
    const root = createManySourceRepository(12);
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = codeGraphDatabasePath(home, first);
    const database = new Database(databasePath);
    try {
      expect(
        database.query("UPDATE file_blobs SET facts_json = '{' WHERE path_hint = ?").run('src/file-000.ts').changes,
      ).toBeGreaterThan(0);
    } finally {
      database.close();
    }
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '-qm',
      'cache recovery target',
    ]);

    const extractionCompletions: string[] = [];
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const recovered = yield* indexer.index({
          cwd: root,
          onProgress: progress =>
            Effect.sync(() => {
              if (
                progress.phase === 'scanning' &&
                progress.activity?.stage === 'extracting' &&
                progress.activity.parseMilliseconds !== undefined
              ) {
                extractionCompletions.push(progress.activity.path);
              }
            }),
          threadnoteHome: home,
        });
        return {
          firstGraph: yield* store.loadGraph(databasePath, first.snapshot.id),
          recovered,
          recoveredGraph: yield* store.loadGraph(databasePath, recovered.snapshot.id),
        };
      }),
    );

    expect(result.recovered.materialization).toEqual({mode: 'reused-snapshot', stagedFiles: 0, totalFiles: 12});
    expect(extractionCompletions).toEqual(['src/file-000.ts']);
    expect(normalizeStoredGraph(result.recoveredGraph)).toEqual(normalizeStoredGraph(result.firstGraph));
    const repaired = new Database(databasePath, {readonly: true});
    try {
      expect(
        repaired
          .query<{readonly path: string}, [string]>(
            "SELECT json_extract(facts_json, '$.path') AS path FROM file_blobs WHERE path_hint = ?",
          )
          .get('src/file-000.ts'),
      ).toEqual({path: 'src/file-000.ts'});
    } finally {
      repaired.close();
    }
  });

  effectIt.effect('retries full inventory materialization without a parser cache after a cached fact disappears', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = createManySourceRepository(12);
        const home = join(root, '.threadnote-test-home');
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const first = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: home});
        const databasePath = codeGraphDatabasePath(home, first);
        yield* Effect.sync(() => {
          invalidateCachedFactFallback(databasePath, first.snapshot.id, 'src/file-000.ts');
          writeFileSync(join(root, 'src/file-012.ts'), 'export const file012 = 12;\n');
          git(root, ['add', 'src/file-012.ts']);
          git(root, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'full cache recovery target',
          ]);
        });
        const extractionCompletions: string[] = [];

        const recovered = yield* indexer.index({
          cwd: root,
          ensureVectors: false,
          onProgress: progress =>
            Effect.sync(() => {
              if (
                progress.phase === 'scanning' &&
                progress.activity?.stage === 'extracting' &&
                progress.activity.parseMilliseconds !== undefined
              ) {
                extractionCompletions.push(progress.activity.path);
              }
            }),
          threadnoteHome: home,
        });
        const recoveredGraph = yield* store.loadGraph(databasePath, recovered.snapshot.id);
        const oracleHome = join(root, '.threadnote-oracle-home');
        const oracle = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: oracleHome});
        const oracleGraph = yield* store.loadGraph(codeGraphDatabasePath(oracleHome, oracle), oracle.snapshot.id);

        expect(recovered.materialization).toMatchObject({mode: 'full', stagedFiles: 13, totalFiles: 13});
        expect(extractionCompletions).toHaveLength(14);
        for (let index = 0; index < 13; index += 1) {
          const path = `src/file-${String(index).padStart(3, '0')}.ts`;
          expect(extractionCompletions.filter(candidate => candidate === path)).toHaveLength(index === 12 ? 2 : 1);
        }
        expect(normalizeStoredGraph(recoveredGraph)).toEqual(normalizeStoredGraph(oracleGraph));
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retries committed-base materialization without a parser cache after a cached fact disappears', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = createManySourceRepository(4);
        const home = join(root, '.threadnote-test-home');
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const first = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: home});
        const databasePath = codeGraphDatabasePath(home, first);
        const commit = yield* Effect.sync(() => {
          invalidateCachedFactFallback(databasePath, first.snapshot.id, 'src/file-000.ts');
          writeFileSync(join(root, 'src/file-003.ts'), 'export const file003 = 4;\n');
          git(root, ['add', 'src/file-003.ts']);
          git(root, [
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '-qm',
            'committed cache recovery target',
          ]);
          return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
        });

        const ensured = yield* Effect.acquireUseRelease(
          indexer.ensureCommit({commit, cwd: root, ensureVectors: false, threadnoteHome: home}),
          lease =>
            store
              .loadGraph(databasePath, lease.snapshot.id)
              .pipe(Effect.map(graph => ({graph, snapshot: lease.snapshot}))),
          lease => store.releaseSnapshotLease(databasePath, lease.leaseToken),
        );
        const oracleHome = join(root, '.threadnote-oracle-home');
        const oracle = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: oracleHome});
        const oracleGraph = yield* store.loadGraph(codeGraphDatabasePath(oracleHome, oracle), oracle.snapshot.id);

        expect(ensured.snapshot.commit).toBe(commit);
        expect(ensured.snapshot.fileCount).toBe(4);
        expect(normalizeStoredGraph(ensured.graph)).toEqual(normalizeStoredGraph(oracleGraph));
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rebuilds a valid materialized shard payload stored under the wrong path', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = createManySourceRepository(2);
        const home = join(root, '.threadnote-test-home');
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const first = yield* indexer.index({cwd: root, ensureVectors: false, threadnoteHome: home});
        const databasePath = codeGraphDatabasePath(home, first);
        const firstGraph = yield* store.loadGraph(databasePath, first.snapshot.id);
        const database = new Database(databasePath);
        try {
          database.exec(`UPDATE materialized_file_shards
                         SET facts_json = (
                           SELECT facts_json FROM materialized_file_shards WHERE path_hint = 'src/file-001.ts'
                         )
                         WHERE path_hint = 'src/file-000.ts'`);
        } finally {
          database.close();
        }

        const rebuilt = yield* indexer.index({
          cwd: root,
          ensureVectors: false,
          force: true,
          threadnoteHome: home,
        });
        const rebuiltGraph = yield* store.loadGraph(databasePath, rebuilt.snapshot.id);
        const repairedDatabase = new Database(databasePath, {readonly: true});
        try {
          const repaired = repairedDatabase
            .query<{readonly payloadPath: string}, [string]>(
              `SELECT json_extract(facts_json, '$.path') AS payloadPath
               FROM materialized_file_shards
               WHERE path_hint = ?`,
            )
            .get('src/file-000.ts');
          expect(repaired).toEqual({payloadPath: 'src/file-000.ts'});
        } finally {
          repairedDatabase.close();
        }

        expect(rebuilt.materialization).toEqual({mode: 'full', stagedFiles: 2, totalFiles: 2});
        expect(
          rebuilt.diagnostics.some(value => value.startsWith('Reused content-addressed materialized shards')),
        ).toBe(false);
        expect(normalizeStoredGraph(rebuiltGraph)).toEqual(normalizeStoredGraph(firstGraph));
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('falls back to bounded full materialization when a clean commit changes global resolution', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(4);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const query = yield* CodeGraphQueryService;
      const first = yield* indexer.index({cwd: root, threadnoteHome: home});
      yield* Effect.sync(() => {
        const changedPath = join(root, 'src/file-000.ts');
        writeFileSync(changedPath, readFileSync(changedPath, 'utf8').replace('original0', 'renamed0'));
        git(root, ['add', 'src/file-000.ts']);
        git(root, [
          '-c',
          'user.name=Threadnote Test',
          '-c',
          'user.email=test@threadnote.local',
          'commit',
          '-qm',
          'rename declaration',
        ]);
      });
      const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
      const found = yield* query.inspect({
        cwd: root,
        operation: 'query',
        query: 'renamed0',
        refresh: false,
        threadnoteHome: home,
      });

      expect(indexed.materialization).toEqual({
        fallbackReason: 'resolution-surface-changed',
        mode: 'full',
        resolutionLookupKeyForm: 'typescript-path-unscoped',
        resolutionPublicationGate: 'exported',
        stagedFiles: 4,
        totalFiles: 4,
      });
      expect(indexed.snapshot.baseSnapshotId).toBeUndefined();
      expect(indexed.snapshot.id).not.toBe(first.snapshot.id);
      expect(found.nodes.some(node => node.name === 'renamed0')).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('falls back to bounded full materialization when a clean commit adds or deletes a file', () =>
    Effect.forEach(
      [
        {
          fileCount: 5,
          label: 'adds',
          mutate: (root: string) =>
            writeFileSync(join(root, 'src/added.ts'), 'export function added(): number { return 5; }\n'),
        },
        {fileCount: 3, label: 'deletes', mutate: (root: string) => rmSync(join(root, 'src/file-000.ts'))},
      ] as const,
      ({fileCount, label, mutate}) =>
        Effect.gen(function* () {
          const root = createManySourceRepository(4);
          const home = join(root, `.threadnote-test-home-${label}`);
          const indexer = yield* CodeGraphIndexer;
          const first = yield* indexer.index({cwd: root, threadnoteHome: home});
          yield* Effect.sync(() => {
            mutate(root);
            git(root, label === 'adds' ? ['add', 'src/added.ts'] : ['add', '-u', 'src/file-000.ts']);
            git(root, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '-qm',
              `${label} eligible file`,
            ]);
          });
          const fallback = yield* indexer.index({cwd: root, threadnoteHome: home});

          expect(fallback.materialization).toEqual({
            fallbackReason: 'file-set-changed',
            mode: 'full',
            stagedFiles: fileCount,
            totalFiles: fileCount,
          });
          expect(fallback.snapshot.baseSnapshotId).toBeUndefined();
          expect(fallback.snapshot.id).not.toBe(first.snapshot.id);
        }),
      {concurrency: 1},
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('builds an immediately dirty worktree directly from the prior compatible anchor', async () => {
    const root = createManySourceRepository(6);
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const committedPath = join(root, 'src/file-000.ts');
    writeFileSync(committedPath, readFileSync(committedPath, 'utf8').replace('return 0;', 'return 1000;'));
    git(root, ['add', 'src/file-000.ts']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'new clean commit',
    ]);
    const dirtyPath = join(root, 'src/file-001.ts');
    writeFileSync(dirtyPath, readFileSync(dirtyPath, 'utf8').replace('return 1;', 'return 1001;'));

    const result = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const cleanCommit = yield* store.readySnapshotForCommit(
          codeGraphDatabasePath(home, indexed),
          identity.repositoryId,
          identity.headCommit,
        );
        return {cleanCommit, indexed};
      }),
    );

    expect(result.indexed.materialization).toEqual({
      mode: 'incremental-overlay',
      stagedFiles: 2,
      totalFiles: 6,
    });
    expect(result.indexed.snapshot).toMatchObject({baseSnapshotId: first.snapshot.id, dirty: true});
    expect(result.cleanCommit).toBeUndefined();
    expect(result.indexed.diagnostics.some(message => message.includes('without first building commit'))).toBe(true);
  });

  it('reuses parsed file facts when repository resolution context changes', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const packagePath = join(root, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packagePath, `${JSON.stringify({...packageJson, description: 'changed context'}, null, 2)}\n`);

    const second = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect(second.reusedFiles).toBe(first.snapshot.fileCount - 1);
  });

  it('refreshes package attribution when only a containing manifest changes', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const packagePath = join(root, 'packages/search/package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packagePath, `${JSON.stringify({...packageJson, name: '@fixture/search-renamed'}, null, 2)}\n`);

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const inspected = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'ensureVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        return {indexed, inspected};
      }),
    );

    expect(result.indexed.reusedFiles).toBe(first.snapshot.fileCount - 1);
    expect(result.inspected.nodes.find(node => node.name === 'ensureVectorIndex')?.packageName).toBe(
      '@fixture/search-renamed',
    );
  });

  it('rehydrates cached manifest context across a committed rebuild without reparsing manifests', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    mkdirSync(join(root, 'cmd', 'fixture'), {recursive: true});
    writeFileSync(
      join(root, 'go.mod'),
      ['module example.com/threadnote-fixture', '', 'require example.com/cache-dependency v1.2.3', ''].join('\n'),
    );
    writeFileSync(join(root, 'cmd', 'fixture', 'main.go'), 'package main\n\nfunc main() {}\n');
    git(root, ['add', 'go.mod', 'cmd/fixture/main.go']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'add go fixture',
    ]);
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      first.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const contextPaths = ['go.mod', 'package.json', 'packages/app/package.json', 'tsconfig.json'] as const;
    const firstContextHashes = Object.fromEntries(
      contextPaths.map(path => [path, effectiveSnapshotFileHash(databasePath, first.snapshot.id, path)]),
    );
    const appPath = join(root, 'packages/app/src/main.ts');
    writeFileSync(appPath, `${readFileSync(appPath, 'utf8')}\n// ordinary source revision\n`);
    git(root, ['add', 'packages/app/src/main.ts']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'ordinary source revision',
    ]);

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const graph = yield* store.loadGraph(
          join(home, 'indexes', 'code-graph', 'repositories', indexed.identity.checkoutId, 'graph-v3.sqlite'),
          indexed.snapshot.id,
        );
        return {graph, indexed};
      }),
    );

    expect(result.indexed.reusedFiles).toBe(first.snapshot.fileCount - 1);
    expect(result.indexed.snapshot.commit).not.toBe(first.snapshot.commit);
    expect(result.indexed.snapshot.dirty).toBe(false);
    expect(result.indexed.materialization).toEqual({
      mode: 'incremental-clean',
      stagedFiles: 1,
      totalFiles: first.snapshot.fileCount,
    });
    expect(result.graph.symbols.find(symbol => symbol.name === 'runApplication')?.packageName).toBe('@fixture/app');
    expect(
      result.graph.edges.some(
        edge =>
          edge.sourceName === '@fixture/app' && edge.relation === 'depends_on' && edge.targetName === '@fixture/search',
      ),
    ).toBe(true);
    expect(
      result.graph.edges.some(
        edge =>
          edge.sourceName === 'runApplication' &&
          edge.relation === 'calls' &&
          edge.targetName === 'ensureVectorIndex' &&
          edge.provenance === 'resolved',
      ),
    ).toBe(true);
    expect(result.graph.symbols.some(symbol => symbol.name === 'example.com/threadnote-fixture')).toBe(true);
    expect(
      result.graph.edges.some(
        edge =>
          edge.sourceName === 'example.com/threadnote-fixture' &&
          edge.relation === 'depends_on' &&
          edge.targetName === 'example.com/cache-dependency',
      ),
    ).toBe(true);
    expect(
      Object.fromEntries(
        contextPaths.map(path => [path, effectiveSnapshotFileHash(databasePath, result.indexed.snapshot.id, path)]),
      ),
    ).toEqual(firstContextHashes);
  });

  it('prunes parser-cache revisions no longer referenced by an active snapshot', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      first.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const sourcePath = 'packages/search/src/vector-index.ts';
    const committedHash = snapshotFileHash(databasePath, first.snapshot.id, sourcePath);
    replaceFunction(root, 'ensureVectorIndex', 'ensureFirstRevision');
    const intermediate = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const intermediateHash = snapshotFileHash(databasePath, intermediate.snapshot.id, sourcePath);
    replaceFunction(root, 'ensureFirstRevision', 'ensureSecondRevision');
    const latest = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const latestHash = snapshotFileHash(databasePath, latest.snapshot.id, sourcePath);
    await runEffect(repairCodeGraphIndexes(home, false));
    const database = new Database(databasePath, {readonly: true});
    let cachedHashes: string[];
    try {
      cachedHashes = database
        .query<{readonly content_hash: string}, [string]>(
          'SELECT content_hash FROM file_blobs WHERE path_hint = ? ORDER BY content_hash',
        )
        .all(sourcePath)
        .map(row => row.content_hash);
    } finally {
      database.close();
    }
    const unchanged = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    expect(cachedHashes).toEqual([committedHash, latestHash].sort());
    expect(cachedHashes).not.toContain(intermediateHash);
    expect(unchanged.reusedFiles).toBe(unchanged.snapshot.fileCount);
  });

  it('performs a true full rebuild without parser-cache reuse', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      first.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const database = new Database(databasePath);
    try {
      const row = database
        .query<{readonly facts_json: string}, [string]>('SELECT facts_json FROM file_blobs WHERE path_hint = ? LIMIT 1')
        .get('packages/search/src/vector-index.ts');
      const facts = decodeStoredCodeGraphFact(row!.facts_json, 'packages/search/src/vector-index.ts').facts;
      database.query('UPDATE file_blobs SET facts_json = ? WHERE path_hint = ?').run(
        encodeStoredCodeGraphFact(
          ensureBoundedCodeGraphFact({
            ...facts,
            symbols: facts.symbols.map(symbol => ({
              ...symbol,
              name: 'corruptedVectorIndex',
              qualifiedName: 'corruptedVectorIndex',
            })),
          }),
        ).json,
        'packages/search/src/vector-index.ts',
      );
    } finally {
      database.close();
    }
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const rebuilt = yield* indexer.index({cwd: root, force: true, threadnoteHome: home});
        const inspected = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'ensureVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        return {inspected, rebuilt};
      }),
    );

    expect(result.rebuilt.snapshot.id).not.toBe(first.snapshot.id);
    expect(result.rebuilt.reusedFiles).toBe(0);
    expect(result.inspected.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(true);
    expect(result.inspected.nodes.some(node => node.name === 'corruptedVectorIndex')).toBe(false);
    const repairedDatabase = new Database(databasePath, {readonly: true});
    try {
      const repaired = repairedDatabase
        .query<{readonly facts_json: string}, [string]>('SELECT facts_json FROM file_blobs WHERE path_hint = ? LIMIT 1')
        .get('packages/search/src/vector-index.ts');
      const names = decodeStoredCodeGraphFact(
        repaired!.facts_json,
        'packages/search/src/vector-index.ts',
      ).facts.symbols.flatMap(symbol => [symbol.name, symbol.qualifiedName]);
      expect(names).toContain('ensureVectorIndex');
      expect(names).not.toContain('corruptedVectorIndex');
    } finally {
      repairedDatabase.close();
    }
  });

  effectIt.effect('releases ordinary source content across the 512-entry batch boundary', () =>
    Effect.acquireUseRelease(
      Effect.sync(() => createManySourceRepository(513)),
      root =>
        Effect.gen(function* () {
          const observedBatches: string[][] = [];
          const identity = yield* resolveRepositoryIdentity(root);
          const inventory = yield* inventoryRepository(identity, {
            onContentBatch: files =>
              Effect.sync(() => {
                observedBatches.push(files.map(file => file.path));
              }),
          });

          expect(observedBatches.map(batch => batch.length)).toEqual([512, 1]);
          expect(observedBatches[0]?.at(0)).toBe('src/file-000.ts');
          expect(observedBatches[1]).toEqual(['src/file-512.ts']);
          expect(inventory.parsedFiles).toBe(513);
          expect(inventory.files.every(file => file.content === undefined)).toBe(true);
        }),
      root =>
        FileSystem.FileSystem.pipe(
          Effect.flatMap(fs => fs.remove(root, {recursive: true})),
          Effect.orDie,
        ),
    ).pipe(
      provideTestLayer(
        TestCommandExecutorLayer.pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
      ),
      TestClock.withLive,
    ),
  );

  it('indexes committed source above the former 128 MiB aggregate limit in bounded batches', async () => {
    const root = createLargeInventoryRepository(129);
    const observedBatches: Array<{readonly bytes: number; readonly files: number}> = [];

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity, {
          onContentBatch: files =>
            Effect.sync(() => {
              observedBatches.push({
                bytes: files.reduce((total, file) => total + file.size, 0),
                files: files.length,
              });
            }),
        });
      }),
    );

    expect(observedBatches.map(batch => batch.files)).toEqual([16, 16, 16, 16, 16, 16, 16, 16, 1]);
    expect(observedBatches.every(batch => batch.bytes <= 16 * 1_048_576 && batch.files <= 128)).toBe(true);
    expect(observedBatches.reduce((total, batch) => total + batch.bytes, 0)).toBeGreaterThan(128 * 1_048_576);
    expect(inventory.parsedFiles).toBe(129);
    expect(inventory.files.every(file => file.content === undefined)).toBe(true);
  }, 30_000);

  it('indexes an eligible tracked file above the former per-file byte cap', async () => {
    const root = createLargeInventoryRepository(1, 2 * 1_048_576);

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity);
      }),
    );

    expect(inventory.files).toHaveLength(1);
    expect(inventory.files[0]?.size).toBe(2 * 1_048_576);
    expect(inventory.parsedFiles).toBe(1);
  });

  it('counts a forced dirty path once when the commit and worktree versions are both parsed', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    replaceFunction(root, 'ensureVectorIndex', 'ensureDirtyVectorIndex');

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, force: true, threadnoteHome: home});
      }),
    );

    expect(result.reusedFiles).toBe(0);
    expect(result.snapshot.fileCount).toBeGreaterThan(0);
  });

  it('reuses the persisted clean base for a modification-only dirty overlay without changing graph results', async () => {
    const incrementalRoot = createBodyModifiedRepository(24);
    const fullRoot = createBodyModifiedRepository(24);
    const incrementalHome = join(incrementalRoot, '.threadnote-test-home');
    const fullHome = join(fullRoot, '.threadnote-test-home');
    const materializingTotals: number[] = [];

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const incremental = yield* indexer.index({
          cwd: incrementalRoot,
          onProgress: progress =>
            Effect.sync(() => {
              if (progress.phase === 'materializing' && progress.completed === progress.total) {
                materializingTotals.push(progress.total);
              }
            }),
          threadnoteHome: incrementalHome,
        });
        const full = yield* indexer.index({
          cwd: fullRoot,
          incrementalOverlay: false,
          threadnoteHome: fullHome,
        });
        const incrementalGraph = yield* store.loadGraph(
          codeGraphDatabasePath(incrementalHome, incremental),
          incremental.snapshot.id,
        );
        const fullGraph = yield* store.loadGraph(codeGraphDatabasePath(fullHome, full), full.snapshot.id);
        return {full, fullGraph, incremental, incrementalGraph};
      }),
    );

    expect(result.incremental.materialization).toEqual({
      mode: 'incremental-overlay',
      stagedFiles: 1,
      totalFiles: 24,
    });
    expect(result.incremental.diagnostics).toContain(
      'Dirty overlay reused persisted clean base for 1 modified file(s).',
    );
    expect(materializingTotals.at(-1)).toBe(1);
    expect(result.full.materialization).toEqual({
      fallbackReason: 'disabled',
      mode: 'full',
      stagedFiles: 24,
      totalFiles: 24,
    });
    expect(
      result.incrementalGraph.edges.some(
        edge =>
          edge.evidencePath === 'src/file-001.ts' &&
          edge.relation === 'calls' &&
          edge.targetId !== undefined &&
          edge.targetName === 'original0',
      ),
    ).toBe(true);
    expect(normalizeStoredGraph(result.incrementalGraph)).toEqual(normalizeStoredGraph(result.fullGraph));
  });

  effectIt.effect('keeps added file-local TypeScript declarations incremental while a new export fails closed', () =>
    Effect.gen(function* () {
      const localRoot = yield* Effect.sync(createPublishedSurfaceRepository);
      const exportedRoot = yield* Effect.sync(createPublishedSurfaceRepository);
      const localHome = join(localRoot, '.threadnote-test-home');
      const exportedHome = join(exportedRoot, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const localClean = yield* indexer.index({cwd: localRoot, threadnoteHome: localHome});
      const exportedClean = yield* indexer.index({cwd: exportedRoot, threadnoteHome: exportedHome});

      expect(localClean.snapshot).toMatchObject({dirty: false, state: 'ready'});
      expect(exportedClean.snapshot).toMatchObject({dirty: false, state: 'ready'});

      yield* Effect.sync(() => {
        writeFileSync(
          join(localRoot, 'src/service.ts'),
          [
            'export class PublishedService {',
            '  value(): number {',
            '    return this.privateValue();',
            '  }',
            '',
            '  private privateValue(): number {',
            '    return 1;',
            '  }',
            '}',
            '',
          ].join('\n'),
        );
        writeFileSync(
          join(localRoot, 'test/service.test.ts'),
          `${readFileSync(join(localRoot, 'test/service.test.ts'), 'utf8')}\nit('reads through a new callback', () => {\n  return new PublishedService().value();\n});\n`,
        );
        writeFileSync(
          join(exportedRoot, 'src/service.ts'),
          `${readFileSync(join(exportedRoot, 'src/service.ts'), 'utf8')}\nexport function newPublishedHelper(): number { return 2; }\n`,
        );
      });

      const local = yield* indexer.index({cwd: localRoot, threadnoteHome: localHome});
      const exported = yield* indexer.index({cwd: exportedRoot, threadnoteHome: exportedHome});

      expect(local.materialization).toEqual({
        mode: 'incremental-overlay',
        resolutionLookupKeyForm: 'typescript-path-unscoped',
        resolutionPublicationGate: 'own-path-local',
        stagedFiles: 2,
        totalFiles: 2,
      });
      expect(local.snapshot).toMatchObject({baseSnapshotId: localClean.snapshot.id, dirty: true});
      expect(exported.materialization).toEqual({
        fallbackReason: 'resolution-surface-changed',
        mode: 'full',
        resolutionLookupKeyForm: 'typescript-path-unscoped',
        resolutionPublicationGate: 'exported',
        stagedFiles: 2,
        totalFiles: 2,
      });
      expect(exported.snapshot.baseSnapshotId).toBeUndefined();
      expect(exported.snapshot.id).not.toBe(exportedClean.snapshot.id);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('preserves scoped TypeScript barrel resolution in a persisted dirty overlay', async () => {
    const incrementalRoot = createFixtureRepository();
    const fullRoot = createFixtureRepository();
    for (const root of [incrementalRoot, fullRoot]) {
      const sourcePath = join(root, 'packages/search/src/vector-index.ts');
      writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n// body-only dirty overlay\n`);
    }
    const incrementalHome = join(incrementalRoot, '.threadnote-test-home');
    const fullHome = join(fullRoot, '.threadnote-test-home');

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const incremental = yield* indexer.index({cwd: incrementalRoot, threadnoteHome: incrementalHome});
        const full = yield* indexer.index({
          cwd: fullRoot,
          incrementalOverlay: false,
          threadnoteHome: fullHome,
        });
        const incrementalGraph = yield* store.loadGraph(
          codeGraphDatabasePath(incrementalHome, incremental),
          incremental.snapshot.id,
        );
        const fullGraph = yield* store.loadGraph(codeGraphDatabasePath(fullHome, full), full.snapshot.id);
        return {fullGraph, incremental, incrementalGraph};
      }),
    );

    expect(result.incremental.materialization).toMatchObject({mode: 'incremental-overlay', stagedFiles: 1});
    expect(
      result.incrementalGraph.edges
        .filter(
          edge =>
            edge.evidencePath === 'packages/search/src/vector-index.ts' &&
            ((edge.relation === 'extends' && edge.targetName === 'FileLock') ||
              (edge.relation === 'calls' && edge.targetName === 'withExclusiveFileLock')),
        )
        .map(edge => ({confidence: edge.confidence, provenance: edge.provenance, relation: edge.relation}))
        .sort((left, right) => left.relation.localeCompare(right.relation)),
    ).toEqual([
      {confidence: 1, provenance: 'resolved', relation: 'calls'},
      {confidence: 1, provenance: 'resolved', relation: 'extends'},
    ]);
    expect(normalizeStoredGraph(result.incrementalGraph)).toEqual(normalizeStoredGraph(result.fullGraph));
  });

  it('preserves diagnostics from unchanged files when reusing clean staging', async () => {
    const root = createBodyModifiedRepositoryWithCommittedDiagnostic();
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: join(root, '.threadnote-test-home')});
      }),
    );

    expect(result.materialization?.mode).toBe('incremental-overlay');
    expect(result.diagnostics.some(diagnostic => diagnostic.includes('src/broken.ts'))).toBe(true);
  });

  it('treats changes to graph-ineligible tracked content as freshness-clean', async () => {
    const root = createNoMaterializedChangesRepository();
    const home = join(root, '.threadnote-test-home');
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const status = yield* query.status(home, root);
        return {indexed, status};
      }),
    );

    expect(result.indexed.snapshot.dirty).toBe(false);
    expect(result.indexed.materialization).toMatchObject({mode: 'full'});
    expect(result.indexed.materialization?.fallbackReason).toBeUndefined();
    expect(
      result.indexed.diagnostics.some(message => message.startsWith('Dirty overlay used full materialization:')),
    ).toBe(false);
    expect(result.status).toMatchObject({freshness: 'current', stale: false});
    expect(result.status.readySnapshot?.id).toBe(result.indexed.snapshot.id);
  });

  effectIt.effect('keeps graph-semantic-neutral resolution config edits incremental', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createChangedResolutionContextRepository);
      const indexer = yield* CodeGraphIndexer;
      const result = yield* indexer.index({cwd: root, threadnoteHome: join(root, '.threadnote-test-home')});

      expect(result.materialization).toMatchObject({mode: 'incremental-overlay', stagedFiles: 1});
      expect(result.materialization?.fallbackReason).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps a span-only static re-export edit in the changed-file overlay', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createSpanOnlyReexportRepository);
      const indexer = yield* CodeGraphIndexer;
      const result = yield* indexer.index({cwd: root, threadnoteHome: join(root, '.threadnote-test-home')});

      expect(result.materialization).toEqual({mode: 'incremental-overlay', stagedFiles: 1, totalFiles: 2});
      expect(result.diagnostics.some(message => message.startsWith('Dirty overlay used full materialization:'))).toBe(
        false,
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  describe.each([
    ['a renamed declaration', createRenamedDeclarationRepository, 'resolution-surface-changed'],
    ['a changed lookup signature', createChangedSignatureRepository, 'project-closure-incomplete'],
    ['a changed export surface', createChangedExportRepository, 'resolution-surface-changed'],
    ['an added eligible file', createAddedFileRepository, 'file-set-changed'],
    ['a deleted eligible file', createDeletedFileRepository, 'file-set-changed'],
    ['an expanded changed-fact batch', createFactBudgetExpandedRepository, 'project-closure-unbounded'],
  ] as const)('full materialization fallback for %s', (label, createRepository, fallbackReason) => {
    effectIt.effect('fails closed with the exact bounded reason', () =>
      Effect.gen(function* () {
        const root = yield* Effect.sync(createRepository);
        const planObservations: Pick<CodeGraphMaterializationMetrics, 'fallbackReason' | 'mode'>[] = [];
        let scanningFactsBytesCompleted = 0;
        let scanningSourceBytesTotal = 0;
        const storageObservations: NonNullable<CodeGraphMaterializationMetrics['storage']>[] = [];
        const indexer = yield* CodeGraphIndexer;
        const result = yield* indexer.index({
          cwd: root,
          onProgress: progress =>
            Effect.sync(() => {
              if (progress.phase === 'scanning' && progress.metrics !== undefined) {
                scanningFactsBytesCompleted = Math.max(
                  scanningFactsBytesCompleted,
                  progress.metrics.factsBytesCompleted ?? 0,
                );
                scanningSourceBytesTotal = Math.max(scanningSourceBytesTotal, progress.metrics.sourceBytesTotal ?? 0);
              }
              if (progress.phase === 'materializing' && progress.metrics?.storage !== undefined) {
                storageObservations.push(progress.metrics.storage);
                planObservations.push({
                  fallbackReason: progress.metrics.fallbackReason,
                  mode: progress.metrics.mode,
                });
              }
            }),
          threadnoteHome: join(root, '.threadnote-test-home'),
        });
        expect(result.materialization).toMatchObject({fallbackReason, mode: 'full'});
        expect(result.materialization?.stagedFiles).toBe(result.materialization?.totalFiles);
        expect(planObservations.at(-1)).toEqual({fallbackReason, mode: 'full'});
        if (label === 'an expanded changed-fact batch') {
          expect(scanningFactsBytesCompleted).toBeGreaterThan(CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES);
          expect(scanningSourceBytesTotal).toBeLessThan(CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES);
        }
        expect(result.diagnostics.some(message => message.startsWith('Dirty overlay used full materialization:'))).toBe(
          true,
        );
        expect(storageObservations.at(-1)).toMatchObject({
          materializationMode: 'direct-persistent',
          temporaryDatabaseBytes: 0,
          temporaryDatabaseHighWaterBytes: 0,
        });
        yield* Effect.sync(() => {
          const database = new Database(codeGraphDatabasePath(join(root, '.threadnote-test-home'), result), {
            readonly: true,
          });
          try {
            const snapshots = database
              .query<
                {
                  readonly base_snapshot_id: unknown;
                  readonly dirty: number;
                  readonly id: string;
                  readonly state: string;
                },
                []
              >('SELECT id, base_snapshot_id, dirty, state FROM snapshots ORDER BY id')
              .all();
            expect(snapshots).toHaveLength(1);
            expect(snapshots[0]).toMatchObject({dirty: 1, id: result.snapshot.id, state: 'ready'});
            expect(snapshots[0]?.base_snapshot_id).toBeNull();
          } finally {
            database.close();
          }
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  });

  it('indexes aggregate symbols across parser batches without a repository-scale cap', async () => {
    const root = createManySourceRepository(129);
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    expect(first.snapshot.symbolCount).toBeGreaterThan(256);
    const database = new Database(
      join(home, 'indexes', 'code-graph', 'repositories', first.identity.checkoutId, 'graph-v3.sqlite'),
      {readonly: true},
    );
    try {
      const cached = database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM file_blobs').get();
      expect(Number(cached?.count)).toBe(first.snapshot.fileCount);
    } finally {
      database.close();
    }
  });

  it('batches and indexes more than 128 dirty overlay files', async () => {
    const root = createManySourceRepository(129);
    const home = join(root, '.threadnote-test-home');
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    for (let index = 0; index < 129; index += 1) {
      writeFileSync(
        join(root, `src/file-${String(index).padStart(3, '0')}.ts`),
        `export function changed${index}(): number { return ${index}; }\n`,
      );
    }

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const inspected = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'changed128',
          refresh: false,
          threadnoteHome: home,
        });
        return {indexed, inspected};
      }),
    );

    expect(result.indexed.reusedFiles).toBe(0);
    expect(result.indexed.snapshot.fileCount).toBe(129);
    expect(result.inspected.nodes.some(node => node.name === 'changed128')).toBe(true);
  }, 30_000);

  effectIt.effect('retries when the worktree changes after activation but before pointer promotion', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const home = join(root, '.threadnote-test-home');
      const initialCommit = yield* Effect.sync(() =>
        execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
      );
      let changed = false;
      let staleSnapshotId: string | undefined;
      const indexer = yield* CodeGraphIndexer;
      const query = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const current = yield* indexer.index({
        cwd: root,
        onProgress: progress =>
          Effect.sync(() => {
            if (!changed && progress.phase === 'activating' && progress.subphase === 'promoting') {
              staleSnapshotId = progress.snapshotId;
              changed = true;
              const sourcePath = join(root, 'packages/search/src/vector-index.ts');
              writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace('vectors-ready', 'vectors-raced'));
            }
          }),
        threadnoteHome: home,
      });
      const inspected = yield* query.inspect({
        cwd: root,
        operation: 'query',
        query: 'ensureVectorIndex',
        refresh: false,
        threadnoteHome: home,
      });
      const databasePath = codeGraphDatabasePath(home, current);
      const stale = staleSnapshotId
        ? yield* store.currentLexicalReadySnapshotById(databasePath, staleSnapshotId)
        : undefined;
      const staleGraph = stale ? yield* store.loadGraph(databasePath, stale.id) : undefined;
      const active = yield* store.readySnapshot(databasePath, current.identity.worktreeId);
      expect(inspected.freshness).toBe('deferred');
      expect(inspected.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(true);
      expect(stale).toMatchObject({commit: initialCommit, id: staleSnapshotId, state: 'ready'});
      expect(stale?.id).not.toBe(current.snapshot.id);
      expect(staleGraph?.symbols.some(symbol => symbol.name === 'ensureVectorIndex')).toBe(true);
      expect(active?.id).toBe(current.snapshot.id);
      expect(current.materialization).toMatchObject({mode: 'incremental-overlay', stagedFiles: 1});
      expect(snapshotFileHash(databasePath, staleSnapshotId!, 'packages/search/src/vector-index.ts')).not.toBe(
        snapshotFileHash(databasePath, current.snapshot.id, 'packages/search/src/vector-index.ts'),
      );
      const database = new Database(databasePath, {readonly: true});
      try {
        const retainedLease = database
          .query<{readonly expires_at: number; readonly token: string}, [string]>(
            "SELECT token, expires_at FROM snapshot_leases WHERE snapshot_id = ? AND token GLOB 'retained-base:*'",
          )
          .get(staleSnapshotId!);
        expect(retainedLease?.token).toMatch(/^retained-base:/u);
        expect(Number(retainedLease?.expires_at) - (yield* Clock.currentTimeMillis)).toBeGreaterThan(32 * 60_000);
        expect(Number(retainedLease?.expires_at) - (yield* Clock.currentTimeMillis)).toBeLessThanOrEqual(45 * 60_000);
      } finally {
        database.close();
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reuses a retained dirty full root for the post-target bounded overlay', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createPublishedSurfaceRepository);
      const home = join(root, '.threadnote-test-home');
      const sourcePath = join(root, 'src/service.ts');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      yield* indexer.index({cwd: root, threadnoteHome: home});
      yield* Effect.sync(() => {
        writeFileSync(
          sourcePath,
          `${readFileSync(sourcePath, 'utf8')}\nexport function retainedPublishedValue(): number { return 2; }\n`,
        );
      });

      let retainedSnapshotId: string | undefined;
      const current = yield* indexer.index({
        cwd: root,
        onProgress: progress =>
          Effect.sync(() => {
            if (
              retainedSnapshotId === undefined &&
              progress.phase === 'activating' &&
              progress.subphase === 'promoting'
            ) {
              retainedSnapshotId = progress.snapshotId;
              writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace('return 2;', 'return 3;'));
            }
          }),
        threadnoteHome: home,
      });

      expect(retainedSnapshotId).toBeDefined();
      expect(current.materialization).toMatchObject({mode: 'incremental-overlay', stagedFiles: 1});
      expect(current.snapshot.baseSnapshotId).toBe(retainedSnapshotId);
      const databasePath = codeGraphDatabasePath(home, current);
      const retained = yield* store.currentLexicalReadySnapshotById(databasePath, retainedSnapshotId!);
      expect(retained).toMatchObject({baseSnapshotId: undefined, dirty: true, state: 'ready'});
      const currentGraph = yield* store.loadGraph(databasePath, current.snapshot.id);

      const forced = yield* indexer.index({
        cwd: root,
        force: true,
        incrementalOverlay: false,
        threadnoteHome: home,
      });
      const forcedGraph = yield* store.loadGraph(databasePath, forced.snapshot.id);
      expect(forced.materialization).toMatchObject({fallbackReason: 'forced-full-rebuild', mode: 'full'});
      expect(normalizeStoredGraph(currentGraph)).toEqual(normalizeStoredGraph(forcedGraph));
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('retains both completed dirty targets when a post-promotion retry also drifts', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const baseline = yield* indexer.index({cwd: root, threadnoteHome: home});
      const sourcePath = join(root, 'packages/search/src/vector-index.ts');
      yield* Effect.sync(() => {
        writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace('vectors-ready', 'vectors-before-race'));
      });
      let promotingEvents = 0;
      let postPromotedSnapshotId: string | undefined;
      let retrySnapshotId: string | undefined;
      let postPromoteMutation = false;
      let retryMutation = false;
      const exit = yield* Effect.exit(
        indexer.index({
          cwd: root,
          onProgress: progress =>
            Effect.sync(() => {
              if (progress.phase === 'activating' && progress.subphase === 'promoting') {
                promotingEvents += 1;
                if (promotingEvents === 2) {
                  postPromotedSnapshotId = progress.snapshotId;
                  postPromoteMutation = true;
                  writeFileSync(
                    sourcePath,
                    readFileSync(sourcePath, 'utf8').replace('vectors-before-race', 'vectors-raced-once'),
                  );
                }
              } else if (
                postPromoteMutation &&
                !retryMutation &&
                progress.phase === 'activating' &&
                progress.subphase === 'validating-input'
              ) {
                retryMutation = true;
                retrySnapshotId = progress.snapshotId;
                writeFileSync(
                  sourcePath,
                  readFileSync(sourcePath, 'utf8').replace('vectors-raced-once', 'vectors-raced-twice'),
                );
              }
            }),
          threadnoteHome: home,
        }),
      );

      expect(exit._tag).toBe('Failure');
      expect(postPromotedSnapshotId).toBeDefined();
      expect(retryMutation).toBe(true);
      expect(retrySnapshotId).toBeDefined();
      const databasePath = codeGraphDatabasePath(home, baseline);
      const active = yield* store.readySnapshot(databasePath, baseline.identity.worktreeId);
      const postPromoted = yield* store.currentLexicalReadySnapshotById(databasePath, postPromotedSnapshotId!);
      expect(active?.id).toBe(retrySnapshotId);
      expect(active).toMatchObject({dirty: true, id: retrySnapshotId, state: 'ready'});
      expect(postPromoted).toMatchObject({dirty: true, id: postPromotedSnapshotId, state: 'ready'});
      const database = new Database(databasePath, {readonly: true});
      try {
        expect(
          database
            .query<{readonly token: string}, [string]>(
              "SELECT token FROM snapshot_leases WHERE snapshot_id = ? AND token GLOB 'retained-base:*'",
            )
            .get(postPromotedSnapshotId!)?.token,
        ).toMatch(/^retained-base:/u);
      } finally {
        database.close();
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('retains a clean alias and its source when input drifts before alias promotion', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const baseline = yield* indexer.index({cwd: root, threadnoteHome: home});
      yield* Effect.sync(() => {
        execFileSync('git', [
          '-C',
          root,
          '-c',
          'user.name=Threadnote Test',
          '-c',
          'user.email=test@threadnote.local',
          'commit',
          '--allow-empty',
          '-m',
          'alias target',
        ]);
      });
      let changed = false;
      let aliasId: string | undefined;
      const current = yield* indexer.index({
        cwd: root,
        onProgress: progress =>
          Effect.sync(() => {
            if (!changed && progress.phase === 'activating' && progress.subphase === 'promoting') {
              changed = true;
              aliasId = progress.snapshotId;
              const sourcePath = join(root, 'packages/search/src/vector-index.ts');
              writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n// alias promotion race\n`);
            }
          }),
        threadnoteHome: home,
      });

      expect(changed).toBe(true);
      expect(aliasId).toBeDefined();
      const databasePath = codeGraphDatabasePath(home, baseline);
      const alias = yield* store.currentLexicalReadySnapshotById(databasePath, aliasId!);
      const source = yield* store.currentLexicalReadySnapshotById(databasePath, baseline.snapshot.id);
      expect(alias).toMatchObject({baseSnapshotId: baseline.snapshot.id, dirty: false, id: aliasId, state: 'ready'});
      expect(source).toMatchObject({id: baseline.snapshot.id, state: 'ready'});
      expect(current.snapshot.id).not.toBe(aliasId);
      const database = new Database(databasePath, {readonly: true});
      try {
        expect(
          database
            .query<{readonly token: string}, [string]>(
              "SELECT token FROM snapshot_leases WHERE snapshot_id = ? AND token GLOB 'retained-base:*'",
            )
            .get(aliasId!)?.token,
        ).toMatch(/^retained-base:/u);
      } finally {
        database.close();
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reclaims a failed persistent snapshot before the automatic worktree-change retry', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const home = join(root, '.threadnote-test-home');
      let changed = false;
      const indexer = yield* CodeGraphIndexer;
      const current = yield* indexer.index({
        cwd: root,
        onProgress: progress =>
          Effect.sync(() => {
            if (!changed && progress.phase === 'activating' && progress.subphase === 'validating-input') {
              changed = true;
              replaceFunction(root, 'ensureVectorIndex', 'ensureStorageBoundedVectorIndex');
            }
          }),
        threadnoteHome: home,
      });

      expect(changed).toBe(true);
      expect(current.snapshot.dirty).toBe(true);
      const database = new Database(codeGraphDatabasePath(home, current), {readonly: true, strict: true});
      try {
        const retired = database
          .query<{readonly count: number}, []>("SELECT COUNT(*) AS count FROM snapshots WHERE state = 'retired'")
          .get();
        expect(retired?.count).toBe(0);
        const ready = database
          .query<{readonly dirty: number; readonly id: string}, []>(
            "SELECT dirty, id FROM snapshots WHERE state = 'ready' ORDER BY dirty, id",
          )
          .all();
        expect(ready).toHaveLength(2);
        expect(ready.filter(snapshot => snapshot.dirty === 0)).toHaveLength(1);
        expect(ready.filter(snapshot => snapshot.dirty === 1)).toEqual([{dirty: 1, id: current.snapshot.id}]);
        expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        database.close(false);
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('retains a completed dirty target when the worktree changes before activation', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const baseline = yield* indexer.index({cwd: root, threadnoteHome: home});
      yield* Effect.sync(() => replaceFunction(root, 'ensureVectorIndex', 'ensureVectorIndexFirst'));
      let firstTargetId: string | undefined;
      const current = yield* indexer.index({
        cwd: root,
        onProgress: progress =>
          Effect.sync(() => {
            if (!firstTargetId && progress.phase === 'activating' && progress.subphase === 'validating-input') {
              firstTargetId = progress.snapshotId;
              replaceFunction(root, 'ensureVectorIndexFirst', 'ensureVectorIndexSecond');
            }
          }),
        threadnoteHome: home,
      });

      expect(firstTargetId).toBeDefined();
      expect(current.snapshot.id).not.toBe(firstTargetId);
      const databasePath = codeGraphDatabasePath(home, baseline);
      expect(yield* store.currentLexicalReadySnapshotById(databasePath, firstTargetId!)).toMatchObject({
        dirty: true,
        id: firstTargetId,
        state: 'ready',
      });
      expect(yield* store.readySnapshot(databasePath, baseline.identity.worktreeId)).toMatchObject({
        id: current.snapshot.id,
      });
      const firstGraph = yield* store.loadGraph(databasePath, firstTargetId!);
      const currentGraph = yield* store.loadGraph(databasePath, current.snapshot.id);
      expect(firstGraph.symbols.some(symbol => symbol.name === 'ensureVectorIndexFirst')).toBe(true);
      expect(currentGraph.symbols.some(symbol => symbol.name === 'ensureVectorIndexSecond')).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('joins an identical dirty request behind its active builder', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.sync(createFixtureRepository);
        const home = join(root, '.threadnote-test-home');
        yield* Effect.sync(() => replaceFunction(root, 'ensureVectorIndex', 'ensureVectorIndexDirty'));
        const indexer = yield* CodeGraphIndexer;
        const ownerScanning = yield* Deferred.make<void>();
        const releaseOwner = yield* Deferred.make<void>();
        const waiterQueued = yield* Deferred.make<void>();
        let held = false;
        const owner = yield* Effect.forkScoped(
          indexer.index({
            cwd: root,
            onProgress: progress => {
              if (held || progress.phase !== 'scanning') {
                return Effect.void;
              }
              held = true;
              return Deferred.succeed(ownerScanning, undefined).pipe(Effect.andThen(Deferred.await(releaseOwner)));
            },
            threadnoteHome: home,
          }),
        );
        yield* Deferred.await(ownerScanning);
        const waiter = yield* Effect.forkScoped(
          indexer.index({
            cwd: root,
            onProgress: progress =>
              progress.phase === 'waiting' && progress.reason === 'request-lock'
                ? Deferred.succeed(waiterQueued, undefined).pipe(Effect.asVoid)
                : Effect.void,
            threadnoteHome: home,
          }),
        );
        yield* Deferred.await(waiterQueued);
        yield* Deferred.succeed(releaseOwner, undefined);
        const ownerSummary = yield* Fiber.join(owner);
        const waiterSummary = yield* Fiber.join(waiter);
        expect(waiterSummary.snapshot.id).toBe(ownerSummary.snapshot.id);
        expect(waiterSummary.materialization?.mode).toBe('reused-snapshot');
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    ),
  );

  it('removes stale committed facts when a changed source becomes ineligible', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    writeFileSync(join(root, 'packages/search/src/vector-index.ts'), new Uint8Array([0, 1, 2, 3]));

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const inspected = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'ensureVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        return {indexed, inspected};
      }),
    );

    expect(result.indexed.snapshot).toMatchObject({dirty: true, fileCount: first.snapshot.fileCount - 1});
    expect(result.inspected.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(false);
  });

  it('does not follow a repository-controlled ignore-file symlink', async () => {
    const root = createFixtureRepository();
    const outside = temporaryDirectory('threadnote-code-graph-ignore-outside-');
    const outsideIgnore = join(outside, 'outside-ignore');
    writeFileSync(outsideIgnore, 'packages/**\n');
    symlinkSync(outsideIgnore, join(root, '.threadnoteignore'));

    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: join(root, '.threadnote-test-home')});
      }),
    );

    expect(indexed.snapshot.fileCount).toBeGreaterThanOrEqual(10);
  });

  it('does not follow a dirty-overlay symlink outside the repository', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const outside = temporaryDirectory('threadnote-code-graph-overlay-outside-');
    const outsideSource = join(outside, 'outside.ts');
    writeFileSync(outsideSource, 'export function outsideSecretSymbol(): string { return "private"; }\n');
    const tracked = join(root, 'packages', 'search', 'src', 'vector-index.ts');
    rmSync(tracked);
    symlinkSync(outsideSource, tracked);

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* graph.inspect({
          cwd: root,
          operation: 'query',
          query: 'outsideSecretSymbol',
          threadnoteHome: home,
        });
      }),
    );

    expect(result.nodes.some(node => node.name === 'outsideSecretSymbol')).toBe(false);
  });

  it('does not follow a dirty-overlay ancestor symlink outside the repository', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const outside = temporaryDirectory('threadnote-code-graph-overlay-ancestor-outside-');
    writeFileSync(
      join(outside, 'vector-index.ts'),
      'export function outsideAncestorSecret(): string { return "x"; }\n',
    );
    writeFileSync(join(outside, 'recall-index.ts'), 'export function outsideRecallSecret(): string { return "x"; }\n');
    const sourceRoot = join(root, 'packages', 'search', 'src');
    renameSync(sourceRoot, join(root, '.original-search-source'));
    symlinkSync(outside, sourceRoot, 'dir');

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* graph.inspect({
          cwd: root,
          operation: 'query',
          query: 'outsideAncestorSecret',
          threadnoteHome: home,
        });
      }),
    );

    expect(result.nodes.some(node => node.name === 'outsideAncestorSecret')).toBe(false);
  });

  it('rejects an external file opened through an ancestor swapped between validation and open', async () => {
    const root = createFixtureRepository();
    const outside = temporaryDirectory('threadnote-code-graph-overlay-coordinated-outside-');
    const relative = 'packages/search/src/vector-index.ts';
    const sourceRoot = join(root, 'packages', 'search', 'src');
    const originalSourceRoot = join(root, 'packages', 'search', 'original-src');
    writeFileSync(
      join(outside, 'vector-index.ts'),
      'export function coordinatedOutsideSecret(): string { return "outside"; }\n',
    );

    const result = runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repositoryRoot = yield* fs.realPath(root);
        return yield* readContainedStableRegularFile(fs, path, repositoryRoot, relative, {
          afterOpen: Effect.sync(() => {
            rmSync(sourceRoot);
            renameSync(originalSourceRoot, sourceRoot);
          }),
          beforeOpen: Effect.sync(() => {
            renameSync(sourceRoot, originalSourceRoot);
            symlinkSync(outside, sourceRoot, 'dir');
          }),
        });
      }),
    );

    await expect(result).rejects.toThrow(/Could not safely read repository path/);
    expect(readFileSync(join(sourceRoot, 'vector-index.ts'), 'utf8')).not.toContain('coordinatedOutsideSecret');
  });

  it('keeps hot queries incremental and returns stale query evidence without a blocking rebuild', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    let progressEvents = 0;
    let hotObservations = 0;
    let strictObservations = 0;
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        const hot = yield* query.inspect({
          cwd: root,
          interlock: {
            afterObservation: () => Effect.sync(() => (hotObservations += 1)),
          },
          onProgress: () => Effect.sync(() => (progressEvents += 1)),
          operation: 'query',
          query: 'exclusive file lock',
          refresh: false,
          threadnoteHome: home,
        });
        const strict = yield* query.inspect({
          cwd: root,
          from: 'runApplication',
          interlock: {
            afterObservation: () => Effect.sync(() => (strictObservations += 1)),
          },
          operation: 'path',
          refresh: false,
          threadnoteHome: home,
          to: 'withExclusiveFileLock',
        });
        replaceFunction(root, 'ensureVectorIndex', 'ensureStaleVectorIndex');
        const stale = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'ensureVectorIndex',
          threadnoteHome: home,
        });
        return {hot, stale, strict};
      }),
    );

    expect(progressEvents).toBe(0);
    expect(hotObservations).toBe(0);
    expect(strictObservations).toBe(2);
    expect(result.hot.freshness).toBe('deferred');
    expect(result.strict.freshness).toBe('current');
    expect(result.stale.freshness).toBe('stale');
  });

  it('reuses an exact status observation without exposing it in serialized status output', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    let repeatedObservations = 0;
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        const status = yield* query.status(home, root);
        const statusObservation = observationFromCodeGraphStatus(status);
        const inspected = yield* query.inspect({
          cwd: root,
          interlock: {
            afterObservation: () => Effect.sync(() => (repeatedObservations += 1)),
          },
          operation: 'query',
          query: 'exclusive file lock',
          refresh: false,
          statusObservation,
          threadnoteHome: home,
        });
        return {inspected, serializedStatus: JSON.stringify(status), statusObservation};
      }),
    );

    expect(result.statusObservation).toBeDefined();
    expect(result.serializedStatus).not.toContain('statusObservation');
    expect(result.inspected.freshness).toBe('current');
    expect(repeatedObservations).toBe(0);
  });

  effectIt.effect('changes the overlay fingerprint for successive edits to an already-modified file', () =>
    Effect.gen(function* () {
      const root = createFixtureRepository();
      const identity = yield* resolveRepositoryIdentity(root);
      replaceFunction(root, 'ensureVectorIndex', 'ensureFirstVectorIndex');
      const first = yield* Effect.all({
        buildRequest: worktreeBuildRequestState(identity),
        overlay: worktreeOverlayState(identity),
      });
      replaceFunction(root, 'ensureFirstVectorIndex', 'ensureSecondVectorIndex');
      const second = yield* Effect.all({
        buildRequest: worktreeBuildRequestState(identity),
        overlay: worktreeOverlayState(identity),
      });
      const states = [first, second] as const;

      expect(states[0].overlay.dirty).toBe(true);
      expect(states[1].overlay.dirty).toBe(true);
      expect(states[0].overlay.fingerprint).not.toBe(states[1].overlay.fingerprint);
      expect(states[0].buildRequest.dirty).toBe(true);
      expect(states[1].buildRequest.dirty).toBe(true);
      expect(states[0].buildRequest.fingerprint).not.toBe(states[1].buildRequest.fingerprint);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('excludes an in-repository Threadnote home from build admission', () =>
    Effect.gen(function* () {
      const root = createFixtureRepository();
      const home = join(root, '.threadnote-test-home');
      mkdirSync(home, {recursive: true});
      writeFileSync(join(home, 'runtime.json'), '{}\n');
      const identity = yield* resolveRepositoryIdentity(root);
      expect(yield* worktreeBuildRequestState(identity, home)).toEqual({dirty: false, fingerprint: undefined});

      replaceFunction(root, 'ensureVectorIndex', 'ensureChangedVectorIndex');
      expect((yield* worktreeBuildRequestState(identity, home)).dirty).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reuses the post-lock overlay observation without repeating Git overlay scans', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      yield* Effect.sync(() => {
        replaceFunction(root, 'ensureVectorIndex', 'ensureObservedVectorIndex');
        rmSync(join(root, 'docs/architecture.md'));
        writeFileSync(join(root, 'packages/app/src/untracked.ts'), 'export const untracked = true;\n');
      });
      const identity = yield* resolveRepositoryIdentity(root);
      const command = yield* CommandExecutor;
      const observationCommands: string[] = [];
      const observationCommand = CommandExecutor.of({
        ...command,
        execute: (executable, args, options) => {
          if (
            executable === 'git' &&
            (args.includes('status') ||
              args.includes('diff') ||
              (args.includes('ls-files') && args.includes('--others')))
          ) {
            observationCommands.push(args.join(' '));
          }
          return command.execute(executable, args, options);
        },
      });
      const observation = yield* worktreeBuildRequestObservation(identity).pipe(
        Effect.provideService(CommandExecutor, observationCommand),
      );
      const independentlyScanned = yield* inventoryRepository(identity);
      const repeatedOverlayCommands: string[] = [];
      const observedCommand = CommandExecutor.of({
        ...command,
        execute: (executable, args, options) => {
          if (
            executable === 'git' &&
            (args.includes('diff') || (args.includes('ls-files') && args.includes('--others')))
          ) {
            repeatedOverlayCommands.push(args.join(' '));
          }
          return command.execute(executable, args, options);
        },
      });
      const reused = yield* inventoryRepository(identity, {overlayObservation: observation.overlay}).pipe(
        Effect.provideService(CommandExecutor, observedCommand),
      );

      expect(observation.overlay.changedPaths).toEqual([
        'packages/app/src/untracked.ts',
        'packages/search/src/vector-index.ts',
      ]);
      expect(observation.overlay.deletedPaths).toEqual(['docs/architecture.md']);
      expect(observation.overlay.untrackedPaths).toEqual(['packages/app/src/untracked.ts']);
      expect(observationCommands).toHaveLength(1);
      expect(observationCommands[0]).toContain('status --porcelain=v1 -z --untracked-files=all --renames');
      expect(repeatedOverlayCommands).toEqual([]);
      expect(reused).toEqual(independentlyScanned);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('marks scanning before committed-tree inventory discovery', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const identity = yield* resolveRepositoryIdentity(root);
      const progress: CodeGraphProgress[] = [];

      yield* inventoryRepository(identity, {
        onProgress: current => Effect.sync(() => progress.push(current)),
      });

      expect(progress[0]).toEqual({
        accepted: 0,
        completed: 0,
        excluded: 0,
        phase: 'scanning',
        skipped: 0,
        total: 0,
        unit: 'files',
      });
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('reuses manifest-only workspace discovery until a resolution context changes', () =>
    Effect.gen(function* () {
      const root = createFixtureRepository();
      const identity = yield* resolveRepositoryIdentity(root);
      const clean = yield* inventoryRepository(identity);
      const cleanDirect = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(clean.files);
      expect(clean.workspace?.fingerprint).toBe(cleanDirect.fingerprint);

      replaceFunction(root, 'ensureVectorIndex', 'ensureChangedVectorIndex');
      const sourceOnly = yield* inventoryRepository(identity);
      const sourceOnlyDirect = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(sourceOnly.files);
      expect(sourceOnly.workspace?.fingerprint).toBe(sourceOnlyDirect.fingerprint);

      const tsconfig = join(root, 'tsconfig.json');
      writeFileSync(tsconfig, `${readFileSync(tsconfig, 'utf8')}\n`);
      const resolutionChanged = yield* inventoryRepository(identity);
      expect(resolutionChanged.workspace).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('indexes a manifest-declared Android module named pods while pruning generated CocoaPods output', async () => {
    const root = temporaryDirectory('threadnote-code-graph-declared-pods-');
    git(root, ['init', '-q']);
    mkdirSync(join(root, 'modules', 'pods', 'src', 'main', 'kotlin', 'io', 'coda', 'pods'), {recursive: true});
    mkdirSync(join(root, 'ios', 'Pods', 'Headers'), {recursive: true});
    writeFileSync(
      join(root, 'settings.gradle.kts'),
      [
        'rootProject.name = "mobile"',
        'include(":pods")',
        'project(":pods").projectDir = file("modules/pods")',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, 'modules', 'pods', 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
    writeFileSync(
      join(root, 'modules', 'pods', 'src', 'main', 'kotlin', 'io', 'coda', 'pods', 'PodsService.kt'),
      'package io.coda.pods\nclass PodsService\n',
    );
    writeFileSync(join(root, 'ios', 'Pods', 'Headers', 'Generated.h'), 'void generated(void);\n');
    git(root, ['add', '.']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'fixture',
    ]);

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity);
      }),
    );
    const paths = inventory.files.map(file => file.path);

    expect(paths).toContain('modules/pods/src/main/kotlin/io/coda/pods/PodsService.kt');
    expect(paths).not.toContain('ios/Pods/Headers/Generated.h');

    writeFileSync(
      join(root, 'settings.gradle.kts'),
      [
        'rootProject.name = "mobile"',
        'include(":pods", ":out")',
        'project(":pods").projectDir = file("modules/pods")',
        'project(":out").projectDir = file("modules/out")',
        '',
      ].join('\n'),
    );
    mkdirSync(join(root, 'modules', 'out', 'src', 'main', 'kotlin'), {recursive: true});
    writeFileSync(join(root, 'modules', 'out', 'src', 'main', 'kotlin', 'NewModule.kt'), 'class NewModule\n');
    const dirtyInventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity);
      }),
    );
    expect(dirtyInventory.files.map(file => file.path)).toContain('modules/out/src/main/kotlin/NewModule.kt');
  });

  it('keeps oversized dirty corpus artifacts metadata-only while preserving an exact fingerprint', async () => {
    const root = temporaryDirectory('threadnote-code-graph-dirty-corpus-');
    git(root, ['init', '-q']);
    writeFileSync(join(root, 'README.md'), '# fixture\n');
    git(root, ['add', '.']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'fixture',
    ]);
    mkdirSync(join(root, 'media'), {recursive: true});
    const artifact = join(root, 'media', 'architecture.pdf');
    writeFileSync(artifact, '%PDF-1.7\n');
    truncateSync(artifact, 64 * 1_048_576 + 1);
    const cachedBatches: Array<
      readonly {
        readonly bytes?: Uint8Array;
        readonly content?: string;
        readonly contentOmittedReason?: 'metadata-only' | 'size-budget';
        readonly path: string;
      }[]
    > = [];

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity, {
          onContentBatch: files => Effect.sync(() => cachedBatches.push(files)),
        });
      }),
    );
    const file = inventory.files.find(candidate => candidate.path === 'media/architecture.pdf');
    const cached = cachedBatches.flat().find(candidate => candidate.path === file?.path);

    expect(file).toMatchObject({size: 64 * 1_048_576 + 1});
    expect(file?.bytes).toBeUndefined();
    expect(file?.content).toBeUndefined();
    expect(file?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cached).toMatchObject({contentOmittedReason: 'size-budget'});
    expect(cached?.bytes).toBeUndefined();
    expect(cached?.content).toBeUndefined();
  });

  it('keeps the overlay stable when untracked files become intent-to-add entries', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    mkdirSync(join(root, '.codex'), {recursive: true});
    writeFileSync(join(root, '.codex', 'local.json'), '{"ignored":true}\n');
    writeFileSync(join(root, 'intent-source.ts'), 'export function intentSource(): string { return "ready"; }\n');

    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    git(root, ['add', '--intent-to-add', '--all']);
    const second = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(second.snapshot.overlayFingerprint).toBe(first.snapshot.overlayFingerprint);
    expect(second.reusedFiles).toBe(second.snapshot.fileCount);
  });

  it('uses all supplied changed-path seeds for impact traversal', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const impact = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        return yield* query.inspect({
          cwd: root,
          operation: 'impact',
          query: 'changed paths',
          refresh: false,
          seedQueries: ['packages/search/src/vector-index.ts', 'packages/search/src/recall-index.ts'],
          threadnoteHome: home,
        });
      }),
    );

    expect(impact.nodes.map(node => node.name)).toEqual(
      expect.arrayContaining(['ensureVectorIndex', 'refreshRecallIndex', 'runApplication']),
    );
  });

  it('recovers impact from symbols deleted since the base snapshot', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const clean = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    rmSync(join(root, 'packages/core/src/lock.ts'));

    const impact = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        return yield* query.inspect({
          baseCommit: clean.snapshot.commit,
          cwd: root,
          depth: 1,
          operation: 'impact',
          query: 'changed paths',
          refresh: true,
          seedQueries: ['packages/core/src/lock.ts'],
          threadnoteHome: home,
        });
      }),
    );

    expect(impact.nodes.map(node => node.name)).toEqual(
      expect.arrayContaining(['ensureVectorIndex', 'refreshRecallIndex']),
    );
    expect(impact.nodes.map(node => node.name)).not.toContain('runApplication');
    expect(impact.warnings.join('\n')).toContain('deleted path(s) from base snapshot');
    expect(impact.warnings.join('\n')).toContain('base-only relationships are omitted');
  });

  it('does not discover nodes through relationships omitted by the edge budget', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const [shallow, deep] = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        const first = yield* query.inspect({
          cwd: root,
          depth: 1,
          edgeLimit: 1,
          nodeLimit: 200,
          operation: 'explain',
          symbol: 'runApplication',
          threadnoteHome: home,
        });
        const second = yield* query.inspect({
          cwd: root,
          depth: 8,
          edgeLimit: 1,
          nodeLimit: 200,
          operation: 'explain',
          refresh: false,
          symbol: 'runApplication',
          threadnoteHome: home,
        });
        return [first, second] as const;
      }),
    );

    expect(deep.edges).toHaveLength(1);
    expect(deep.edges).toEqual(shallow.edges);
    expect(deep.nodes.map(node => node.id)).toEqual(shallow.nodes.map(node => node.id));
  });

  it('keeps heuristic and model relationship opt-ins independent', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      indexed.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const database = new Database(databasePath);
    try {
      const source = database
        .query<{readonly id: string}, [string, string]>(
          'SELECT id FROM symbols WHERE snapshot_id = ? AND name = ? LIMIT 1',
        )
        .get(indexed.snapshot.id, 'runApplication');
      const target = database
        .query<{readonly id: string}, [string, string]>(
          'SELECT id FROM symbols WHERE snapshot_id = ? AND name = ? LIMIT 1',
        )
        .get(indexed.snapshot.id, 'withExclusiveFileLock');
      expect(source?.id).toBeDefined();
      expect(target?.id).toBeDefined();
      if (!source || !target) throw TestError.make({message: 'Fixture graph symbols were not indexed.'});
      const insert = database.query(
        `INSERT INTO edges (
          snapshot_id, id, source_id, source_name, relation, target_id, target_name,
          provenance, confidence, evidence_path, evidence_span_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        indexed.snapshot.id,
        'test-heuristic-edge',
        source.id,
        'runApplication',
        'references',
        target.id,
        'withExclusiveFileLock',
        'heuristic',
        0.5,
        'packages/app/src/main.ts',
        '{"line":1,"column":1,"endLine":1,"endColumn":2}',
      );
      insert.run(
        indexed.snapshot.id,
        'test-model-edge',
        source.id,
        'runApplication',
        'semantic_association',
        target.id,
        'withExclusiveFileLock',
        'model',
        0.5,
        'packages/app/src/main.ts',
        '{"line":1,"column":1,"endLine":1,"endColumn":2}',
      );
    } finally {
      database.close();
    }

    const [plain, heuristic, model, both] = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        const inspect = (includeHeuristic: boolean, includeModelAssociations: boolean) =>
          query.inspect({
            cwd: root,
            depth: 1,
            edgeLimit: 200,
            includeHeuristic,
            includeModelAssociations,
            nodeLimit: 200,
            operation: 'explain',
            refresh: false,
            symbol: 'runApplication',
            threadnoteHome: home,
          });
        return yield* Effect.all(
          [inspect(false, false), inspect(true, false), inspect(false, true), inspect(true, true)],
          {concurrency: 1},
        );
      }),
    );
    const optionalEdgeIds = (result: typeof plain) =>
      result.edges.map(edge => edge.id).filter(id => id.startsWith('test-'));

    expect(optionalEdgeIds(plain)).toEqual([]);
    expect(optionalEdgeIds(heuristic)).toEqual(['test-heuristic-edge']);
    expect(optionalEdgeIds(model)).toEqual(['test-model-edge']);
    expect(new Set(optionalEdgeIds(both))).toEqual(new Set(['test-heuristic-edge', 'test-model-edge']));
  });

  it('reserves an impact seed for every changed path at the 200-path boundary', async () => {
    const root = temporaryDirectory('threadnote-code-graph-impact-boundary-');
    const home = join(root, '.threadnote-test-home');
    mkdirSync(join(root, 'src'), {recursive: true});
    const seedQueries = Array.from({length: 201}, (_, index) => {
      const relative = `src/changed-${String(index).padStart(3, '0')}.ts`;
      writeFileSync(
        join(root, relative),
        `export function changedSymbol${String(index).padStart(3, '0')}(): number { return ${index}; }\n`,
      );
      return relative;
    });
    writeFileSync(
      join(root, 'src/boundary-consumer.ts'),
      "import {changedSymbol199} from './changed-199.js';\n" +
        'export function boundaryConsumer(): number { return changedSymbol199(); }\n',
    );
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'impact boundary',
    ]);

    const [impact, defaultLimit, partial] = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        return yield* Effect.all(
          [
            query.inspect({
              cwd: root,
              depth: 0,
              edgeLimit: 1,
              nodeLimit: 200,
              operation: 'impact',
              query: 'changed paths',
              seedQueries: seedQueries.slice(0, 200),
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              depth: 1,
              edgeLimit: 500,
              operation: 'impact',
              query: 'changed paths',
              refresh: false,
              seedQueries: seedQueries.slice(0, 200),
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              depth: 0,
              edgeLimit: 1,
              nodeLimit: 200,
              operation: 'impact',
              query: 'changed paths',
              seedQueries,
              threadnoteHome: home,
            }),
          ],
          {concurrency: 1},
        );
      }),
    );

    expect(impact.nodes).toHaveLength(200);
    expect(new Set(impact.nodes.map(node => node.path))).toEqual(new Set(seedQueries.slice(0, 200)));
    expect(impact.warnings.some(warning => warning.includes('changed paths; results are partial'))).toBe(false);
    expect(defaultLimit.nodes.some(node => node.name === 'boundaryConsumer')).toBe(true);
    expect(partial.warnings).toContain('Impact analysis evaluated 200 of 201 changed paths; results are partial.');
  });

  it('sanitizes repository-controlled fields and bounds query output', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    writeFileSync(
      join(root, 'docs/danger.md'),
      `# danger\u001b]8;;https://example.invalid\u0007${'x'.repeat(5_000)}\n`,
    );

    const result = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        return yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'danger',
          threadnoteHome: home,
        });
      }),
    );

    expect(JSON.stringify(result)).not.toContain('\u001b');
    expect(result.nodes.find(node => node.name.includes('danger'))?.name.length).toBeLessThanOrEqual(256);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(270_000);
  });

  it('purges every repository-scoped derived graph artifact', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const repositoryRoot = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const derivedRoot = join(home, 'indexes', 'code-graph', 'repositories', indexed.identity.checkoutId);
        mkdirSync(join(derivedRoot, 'vectors', 'test'), {recursive: true});
        writeFileSync(join(derivedRoot, 'vectors', 'test', 'orphan.bin'), 'derived');
        return yield* query.purge(home, root);
      }),
    );

    expect(existsSync(repositoryRoot)).toBe(false);
  });

  it('waits for in-flight repository registration before purging every graph', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const registered = yield* Deferred.make<void>();
        const continueRegistration = yield* Deferred.make<void>();
        const indexing = yield* Effect.forkChild(
          indexer.index({
            cwd: root,
            onProgress: progress =>
              progress.phase === 'registering'
                ? Deferred.succeed(registered, undefined).pipe(
                    Effect.andThen(Deferred.await(continueRegistration)),
                    Effect.asVoid,
                  )
                : Effect.void,
            threadnoteHome: home,
          }),
        );
        yield* Deferred.await(registered);
        const purge = yield* Effect.forkChild(purgeAllCodeGraphIndexes(home));
        yield* Effect.yieldNow;
        expect(existsSync(join(home, 'indexes', 'code-graph', 'repositories'))).toBe(true);
        yield* Deferred.succeed(continueRegistration, undefined);
        yield* Effect.exit(Fiber.join(indexing));
        yield* Fiber.join(purge);
      }),
    );

    expect(existsSync(join(home, 'indexes', 'code-graph'))).toBe(false);
  });

  it('reports repository lock contention and resumes after the active graph build releases it', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const identity = await runEffect(resolveRepositoryIdentity(root));
    const lock = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId).lockPath;
      }),
    );
    mkdirSync(join(lock, '..'), {recursive: true});
    writeFileSync(lock, `${process.pid}:active-code-graph-build\n`, {mode: 0o600});

    const summary = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const waiting = yield* Deferred.make<void>();
        const indexing = yield* Effect.forkChild(
          indexer.index({
            cwd: root,
            onProgress: progress =>
              progress.phase === 'waiting' ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid) : Effect.void,
            threadnoteHome: home,
          }),
        );
        yield* Deferred.await(waiting);
        rmSync(lock, {force: true});
        return yield* Fiber.join(indexing);
      }),
    );

    expect(summary.snapshot.state).toBe('ready');
  });

  it('rejects an origin change while an expected graph target waits for the repository lock', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const identity = await runEffect(resolveRepositoryIdentity(root));
    const lock = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId).lockPath;
      }),
    );
    mkdirSync(join(lock, '..'), {recursive: true});
    writeFileSync(lock, `${process.pid}:active-code-graph-build\n`, {mode: 0o600});

    await expect(
      runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const waiting = yield* Deferred.make<void>();
          const indexing = yield* Effect.forkChild(
            indexer.index({
              cwd: root,
              expectedIdentity: identity,
              onProgress: progress =>
                progress.phase === 'waiting' ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid) : Effect.void,
              threadnoteHome: home,
            }),
          );
          yield* Deferred.await(waiting);
          git(root, ['remote', 'add', 'origin', 'https://example.com/changed.git']);
          rmSync(lock, {force: true});
          return yield* Fiber.join(indexing);
        }),
      ),
    ).rejects.toThrow('Repository identity changed while waiting for the graph lock.');
  });

  it('rejects each mismatched expected graph target component before indexing', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const identity = await runEffect(resolveRepositoryIdentity(root));
    for (const component of ['checkoutId', 'repositoryId', 'worktreeId'] as const) {
      const expectedIdentity = {
        ...identity,
        [component]: `${identity[component].startsWith('f') ? 'e' : 'f'}${identity[component].slice(1)}`,
      };
      await expect(
        runEffect(
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            return yield* indexer.index({cwd: root, expectedIdentity, threadnoteHome: home});
          }),
        ),
        component,
      ).rejects.toThrow('Repository identity does not match the requested graph target.');
    }
  });

  it('coalesces ten independent runtimes after lock contention without sequential inventory passes', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    let releaseOwner!: () => void;
    let reportOwnerScanning!: () => void;
    const ownerRelease = new Promise<void>(resolve => (releaseOwner = resolve));
    const ownerScanning = new Promise<void>(resolve => (reportOwnerScanning = resolve));
    let inventoryPasses = 0;

    const owner = runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({
          cwd: root,
          onProgress: progress => {
            if (
              progress.phase !== 'scanning' ||
              progress.completed !== 0 ||
              progress.total !== 0 ||
              progress.activity !== undefined
            )
              return Effect.void;
            inventoryPasses += 1;
            reportOwnerScanning();
            return Effect.promise(() => ownerRelease);
          },
          threadnoteHome: home,
        });
      }),
    );
    await ownerScanning;

    const waiterSignals = Array.from({length: 9}, () => {
      let queued!: () => void;
      return {promise: new Promise<void>(resolve => (queued = resolve)), queued};
    });
    const waiters = waiterSignals.map(signal =>
      runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({
            cwd: root,
            onProgress: progress => {
              if (progress.phase === 'waiting') signal.queued();
              if (
                progress.phase === 'scanning' &&
                progress.completed === 0 &&
                progress.total === 0 &&
                progress.activity === undefined
              )
                inventoryPasses += 1;
              return Effect.void;
            },
            threadnoteHome: home,
          });
        }),
      ),
    );
    await Promise.all(waiterSignals.map(signal => signal.promise));
    releaseOwner();
    const [ownerSummary, ...waiterSummaries] = await Promise.all([owner, ...waiters]);

    expect(inventoryPasses).toBe(1);
    expect(new Set(waiterSummaries.map(summary => summary.snapshot.id))).toEqual(new Set([ownerSummary.snapshot.id]));
    expect(
      waiterSummaries.every(
        summary =>
          summary.materialization?.mode === 'reused-snapshot' &&
          summary.materialization.stagedFiles === 0 &&
          summary.materialization.totalFiles === ownerSummary.snapshot.fileCount,
      ),
    ).toBe(true);
  });

  it('coalesces independent operating-system processes into one inventory pass', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const controlRoot = temporaryDirectory('threadnote-code-graph-process-control-');
    const gate = join(controlRoot, 'release-code-graph-owner');
    const firstMarker = join(controlRoot, 'first-code-graph-process');
    const secondMarker = join(controlRoot, 'second-code-graph-process');
    const first = startCodeGraphIndexProcess(root, home, gate, firstMarker);
    let second: ReturnType<typeof startCodeGraphIndexProcess> | undefined;
    try {
      await waitForPath(`${firstMarker}.scanning`);
      second = startCodeGraphIndexProcess(root, home, gate, secondMarker);
      await waitForPath(`${secondMarker}.waiting`);
      writeFileSync(gate, 'release\n');
      const [firstOutput, secondOutput] = await Promise.all([first.done, second.done]);
      const firstSummary = codeGraphProcessSummary(firstOutput);
      const secondSummary = codeGraphProcessSummary(secondOutput);
      const inventoryPasses = [
        ...codeGraphProcessProgress(firstOutput),
        ...codeGraphProcessProgress(secondOutput),
      ].filter(
        progress =>
          progress.phase === 'scanning' &&
          progress.completed === 0 &&
          progress.total === 0 &&
          !('activity' in progress),
      );

      expect(inventoryPasses).toHaveLength(1);
      expect(existsSync(`${secondMarker}.scanning`)).toBe(false);
      expect(secondSummary.snapshot.id).toBe(firstSummary.snapshot.id);
      expect(secondSummary.materialization).toMatchObject({mode: 'reused-snapshot', stagedFiles: 0});
    } finally {
      if (first.running()) first.kill();
      if (second?.running()) second.kill();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'resumes exact postprocess-expanded batches without activating a killed partial build',
    async () => {
      const root = createRationaleAmplifiedRepository();
      const home = join(root, '.threadnote-test-home');
      const marker = join(root, '.forced-build-committed');
      const helper = join(import.meta.dirname, '../helpers/code-graph-force-resume-child.ts');
      const child = spawn(process.execPath, [helper, root, home, marker], {
        cwd: process.cwd(),
        env: {...process.env, NODE_ENV: 'test'},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => (stderr += String(chunk)));
      try {
        await waitForPath(marker, 30_000);
        child.kill('SIGKILL');
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => resolve());
        });
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        throw TestError.make({message: `Forced-build child did not reach a committed batch: ${stderr}`, cause: error});
      }

      const markerProgress = JSON.parse(readFileSync(marker, 'utf8')) as {
        readonly batchesCompleted: number;
        readonly batchTotal: number;
        readonly completed: number;
        readonly factsBytesCompleted: number;
        readonly factsBytesTotal?: number;
      };
      expect(markerProgress.batchesCompleted).toBe(1);
      expect(markerProgress.batchTotal).toBe(2);
      expect(markerProgress.completed).toBeGreaterThan(0);
      expect(markerProgress.factsBytesCompleted).toBeLessThanOrEqual(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
      expect(markerProgress.factsBytesTotal).toBeUndefined();

      const identity = await runEffect(resolveRepositoryIdentity(root));
      const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
      const interruptedDatabase = new Database(databasePath, {readonly: true, strict: true});
      const interrupted = interruptedDatabase
        .query("SELECT id FROM snapshots WHERE state = 'building' AND id GLOB 'cgsn_*-full-*' LIMIT 1")
        .get() as {readonly id: string};
      const receiptsBefore = interruptedDatabase
        .query('SELECT batch_index FROM building_materialization_batches WHERE snapshot_id = ? ORDER BY batch_index')
        .all(interrupted.id) as Array<{readonly batch_index: number}>;
      const rawCache = interruptedDatabase
        .query('SELECT COUNT(*) AS files, COALESCE(SUM(length(CAST(facts_json AS BLOB))), 0) AS bytes FROM file_blobs')
        .get() as {readonly bytes: number; readonly files: number};
      const partialSymbols = interruptedDatabase
        .query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
        .get(interrupted.id) as {readonly count: number};
      const partiallyActive = interruptedDatabase
        .query('SELECT COUNT(*) AS count FROM active_snapshots WHERE snapshot_id = ?')
        .get(interrupted.id) as {readonly count: number};
      interruptedDatabase.close(false);
      expect(rawCache.files).toBe(3);
      expect(rawCache.bytes).toBeLessThanOrEqual(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
      expect(receiptsBefore).toEqual([]);
      const interruptedSpool = new Database(codeGraphMaterializationSpoolPath(home, {identity}, interrupted.id), {
        readonly: true,
        strict: true,
      });
      let spoolReceiptsBefore: Array<{readonly batch_index: number}>;
      try {
        spoolReceiptsBefore = interruptedSpool
          .query('SELECT batch_index FROM materialization_spool_batches ORDER BY batch_index')
          .all() as Array<{readonly batch_index: number}>;
      } finally {
        interruptedSpool.close(false);
      }
      expect(spoolReceiptsBefore.map(receipt => receipt.batch_index)).toEqual([0]);
      expect(spoolReceiptsBefore).toHaveLength(markerProgress.batchesCompleted);
      expect(spoolReceiptsBefore.length).toBeLessThan(markerProgress.batchTotal);
      expect(partialSymbols.count).toBe(0);
      expect(partiallyActive.count).toBe(0);

      let completedMetrics:
        | {readonly batchesCompleted: number; readonly batchesTotal: number; readonly factsBytesTotal?: number}
        | undefined;
      const resumedTransactionBytes: number[] = [];
      let receiptsAtFinalCommit: number | undefined;
      const resumed = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({
            cwd: root,
            force: true,
            onProgress: progress =>
              Effect.sync(() => {
                if (progress.phase !== 'materializing' || progress.metrics === undefined) return;
                if (
                  progress.activity?.stage === 'committing' &&
                  progress.metrics.batchesCompleted === progress.activity.batchCompleted + 1
                ) {
                  resumedTransactionBytes.push(progress.activity.factsBytes!);
                }
                if (
                  progress.metrics.factsBytesTotal === undefined ||
                  progress.metrics.batchesCompleted !== progress.metrics.batchesTotal
                ) {
                  return;
                }
                completedMetrics = progress.metrics;
                const committed = new Database(databasePath, {readonly: true, strict: true});
                receiptsAtFinalCommit = Number(
                  (
                    committed
                      .query('SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?')
                      .get(interrupted.id) as {readonly count: number}
                  ).count,
                );
                committed.close(false);
              }),
            threadnoteHome: home,
          });
        }),
      );
      expect(resumed.snapshot.id).toBe(interrupted.id);
      expect(resumed.snapshot.state).toBe('ready');
      expect(completedMetrics).toMatchObject({
        batchesCompleted: markerProgress.batchTotal,
        batchesTotal: markerProgress.batchTotal,
        factsBytesTotal: expect.any(Number),
      });
      expect(resumedTransactionBytes).toHaveLength(markerProgress.batchTotal);
      expect(resumedTransactionBytes.every(bytes => bytes <= CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM)).toBe(true);
      expect(resumedTransactionBytes.reduce((total, bytes) => total + bytes, 0)).toBe(
        completedMetrics?.factsBytesTotal,
      );
      expect(completedMetrics?.factsBytesTotal).toBeGreaterThan(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
      expect(receiptsAtFinalCommit).toBe(markerProgress.batchTotal);

      const readyDatabase = new Database(databasePath, {readonly: true, strict: true});
      const receiptsAfter = readyDatabase
        .query('SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?')
        .get(interrupted.id) as {readonly count: number};
      const activeAfter = readyDatabase
        .query('SELECT COUNT(*) AS count FROM active_snapshots WHERE snapshot_id = ?')
        .get(interrupted.id) as {readonly count: number};
      readyDatabase.close(false);
      expect(receiptsAfter.count).toBe(0);
      expect(activeAfter.count).toBe(1);
    },
    90_000,
  );

  it.skipIf(process.platform === 'win32')(
    'atomically rolls back a killed grouped transaction and resumes the exact clean build',
    async () => {
      const root = createManySourceRepository(140);
      const home = join(root, '.threadnote-test-home');
      const marker = join(root, '.clean-persistent-build');
      const helper = join(import.meta.dirname, '../helpers/code-graph-direct-interrupt-child.ts');
      const child = spawn(process.execPath, [helper, root, home, marker], {
        cwd: process.cwd(),
        env: {...process.env, NODE_ENV: 'test'},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => (stderr += String(chunk)));
      try {
        await waitForPath(marker, 45_000);
        child.kill('SIGKILL');
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => resolve());
        });

        const markerProgress = JSON.parse(readFileSync(marker, 'utf8')) as {
          readonly batchCompleted: number;
          readonly batchesCompleted: number;
          readonly batchesTotal: number;
          readonly snapshotMode?: string;
        };
        expect(markerProgress).toMatchObject({
          batchCompleted: expect.any(Number),
          batchesCompleted: 0,
          snapshotMode: 'direct-persistent',
        });
        expect(markerProgress.batchCompleted).toBeGreaterThanOrEqual(1);
        expect(markerProgress.batchesTotal).toBeGreaterThan(1);

        const identity = await runEffect(resolveRepositoryIdentity(root));
        const databasePath = join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          identity.checkoutId,
          'graph-v3.sqlite',
        );
        const interruptedDatabase = new Database(databasePath, {readonly: true});
        const interrupted = interruptedDatabase
          .query<{readonly id: string; readonly started_at: string}, [string]>(
            "SELECT id, started_at FROM snapshots WHERE worktree_id = ? AND dirty = 0 AND state = 'building' LIMIT 1",
          )
          .get(identity.worktreeId);
        expect(interrupted).toBeDefined();
        const interruptedId = interrupted!.id;
        const startedAt = interrupted!.started_at;
        const rolledBackReceipts =
          interruptedDatabase
            .query<{readonly count: number}, [string]>(
              'SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?',
            )
            .get(interruptedId)?.count ?? -1;
        const rolledBackSymbols =
          interruptedDatabase
            .query<{readonly count: number}, [string]>('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
            .get(interruptedId)?.count ?? -1;
        expect(rolledBackReceipts).toBe(0);
        expect(rolledBackSymbols).toBe(0);
        interruptedDatabase.close();

        const resumed = await runEffect(
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            return yield* indexer.index({cwd: root, threadnoteHome: home});
          }),
        );

        expect(resumed.snapshot).toMatchObject({dirty: false, id: interruptedId, state: 'ready'});
        const readyDatabase = new Database(databasePath, {readonly: true});
        try {
          expect(
            readyDatabase
              .query<{readonly started_at: string; readonly state: string}, [string]>(
                'SELECT started_at, state FROM snapshots WHERE id = ?',
              )
              .get(interruptedId),
          ).toEqual({started_at: startedAt, state: 'ready'});
          expect(
            readyDatabase
              .query<{readonly count: number}, [string]>(
                'SELECT COUNT(*) AS count FROM snapshot_build_owners WHERE snapshot_id = ?',
              )
              .get(interruptedId)?.count,
          ).toBe(0);
          expect(
            readyDatabase
              .query<{readonly count: number}, [string]>(
                'SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?',
              )
              .get(interruptedId)?.count,
          ).toBe(0);
        } finally {
          readyDatabase.close();
        }
      } catch (error) {
        throw TestError.make({message: `Clean-build resume fixture failed: ${stderr}`, cause: error});
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
    90_000,
  );

  effectIt.effect('drains an under-capacity persistent transaction instead of leaving a resumable build behind', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(130);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const baseline = yield* indexer.index({cwd: root, threadnoteHome: home});
      updateManySourceRepository(root, 130, 'updated');

      const probes = new Map<string, number>();
      const probesPerObservation = statSync(root).dev === statSync(tmpdir()).dev ? 1 : 2;
      const failure = yield* indexer
        .index({
          cwd: root,
          diskCapacityAvailableBytes: (_target, boundary) =>
            Effect.sync(() => {
              const count = (probes.get(boundary.operation) ?? 0) + 1;
              probes.set(boundary.operation, count);
              return boundary.operation !== 'stage persistent code graph facts' || count <= probesPerObservation
                ? Number.MAX_SAFE_INTEGER
                : 0;
            }),
          incrementalOverlay: false,
          persistentMaterializationTransactionBatchLimit: 1,
          threadnoteHome: home,
        })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(CodeGraphDiskCapacityPressureError);
      expect(isCodeGraphStoreNoSpaceError(failure)).toBe(true);
      expect(failure).toMatchObject({code: 'no-space', recovery: 'free-space'});
      // The parser cache coalesces the 128-row/2-row inventory callbacks into
      // one protected 130-row write before staging.
      // Inventory and workspace each observe once. The two deterministic source
      // batches each protect both their v4 shard write and owner-verified
      // association write. Facts allow one transaction, then observe pressure
      // and the one bounded cleanup retry. Shared storage never spawns duplicate
      // df or PowerShell probes at a boundary.
      expect(Object.fromEntries(probes)).toEqual({
        'cache code graph file facts': probesPerObservation,
        'cache materialized code graph file shards': probesPerObservation * 4,
        'stage persistent code graph facts': probesPerObservation * 3,
        'stage persistent code graph inventory': probesPerObservation,
        'stage persistent code graph workspace': probesPerObservation,
      });

      const databasePath = codeGraphDatabasePath(home, baseline);
      const pausedDatabase = new Database(databasePath, {readonly: true});
      try {
        expect(
          pausedDatabase
            .query<{readonly count: number}, [string]>(
              "SELECT COUNT(*) AS count FROM snapshots WHERE worktree_id = ? AND state IN ('building', 'failed', 'retired')",
            )
            .get(baseline.identity.worktreeId)?.count,
        ).toBe(0);
        expect(
          pausedDatabase
            .query<{readonly snapshot_id: string}, [string]>(
              'SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?',
            )
            .get(baseline.identity.worktreeId),
        ).toEqual({snapshot_id: baseline.snapshot.id});
        expect(
          pausedDatabase
            .query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_build_owners')
            .get()?.count,
        ).toBe(0);
        expect(pausedDatabase.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        pausedDatabase.close();
      }
      expect(
        readdirSync(join(home, 'indexes', 'code-graph', 'repositories', baseline.identity.checkoutId)).filter(
          candidate => candidate.startsWith('materialization-spool-v2-'),
        ),
      ).toEqual([]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('continues past an advisory whole-build heuristic and fails a measured reservation shortfall', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(130);
      const home = join(root, '.threadnote-test-home');
      const system = yield* SystemInfo;
      const progress: CodeGraphProgress[] = [];
      const measuredOperations: string[] = [];
      const indexerLayer = Layer.fresh(CodeGraphIndexer.layer).pipe(
        Layer.provide(
          Layer.succeed(SystemInfo, SystemInfo.of({...system, availableDiskBytes: () => Effect.succeed(0)})),
        ),
      );

      const {failure, indexed} = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(indexerLayer);
          const indexer = Context.get(context, CodeGraphIndexer);
          const indexed = yield* indexer.index({
            cwd: root,
            diskCapacityAvailableBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
            incrementalOverlay: false,
            onProgress: update =>
              Effect.sync(() => {
                progress.push(update);
              }),
            threadnoteHome: home,
          });

          updateManySourceRepository(root, 130, 'measuredCapacityPressure');
          const failure = yield* indexer
            .index({
              cwd: root,
              diskCapacityAvailableBytes: (_target, boundary) =>
                Effect.sync(() => {
                  measuredOperations.push(boundary.operation);
                  return boundary.operation === 'stage persistent code graph facts' ? 0 : Number.MAX_SAFE_INTEGER;
                }),
              incrementalOverlay: false,
              threadnoteHome: home,
            })
            .pipe(Effect.flip);
          return {failure, indexed};
        }),
      );

      expect(indexed.snapshot.state).toBe('ready');
      expect(
        indexed.diagnostics.some(
          diagnostic =>
            diagnostic.includes('below the advisory whole-build materialization estimate') &&
            diagnostic.includes('continue under measured bounded-write reservations'),
        ),
      ).toBe(true);
      expect(progress.some(update => update.phase === 'materializing')).toBe(true);
      expect(failure).toBeInstanceOf(CodeGraphDiskCapacityPressureError);
      expect(failure).toMatchObject({
        evidence: {
          decisionLayer: 'bounded-write-reservation',
          estimateBasis: 'final-fact-bytes-and-row-count',
          filesystems: [{availableBytes: 0, requiredBytes: expect.any(Number)}],
          recovery: 'free-space',
          retryable: false,
        },
        operation: 'stage persistent code graph facts',
      });
      expect(measuredOperations).toContain('stage persistent code graph facts');

      const identity = yield* resolveRepositoryIdentity(root);
      const database = new Database(codeGraphDatabasePath(home, {identity}), {readonly: true});
      try {
        expect(
          database
            .query<{readonly count: number}, [string]>(
              "SELECT COUNT(*) AS count FROM snapshots WHERE worktree_id = ? AND state IN ('building', 'failed', 'retired')",
            )
            .get(identity.worktreeId)?.count,
        ).toBe(0);
        expect(
          database
            .query<{readonly snapshot_id: string}, [string]>(
              'SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?',
            )
            .get(identity.worktreeId),
        ).toEqual({snapshot_id: indexed.snapshot.id});
        expect(
          database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_build_owners').get()
            ?.count,
        ).toBe(0);
        expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        database.close();
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reprotects the exact ready snapshot when a paused promotion resumes', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(8);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const baseline = yield* indexer.index({cwd: root, threadnoteHome: home});
      updateManySourceRepository(root, 8, 'promotionPaused');
      const probesPerObservation = statSync(root).dev === statSync(tmpdir()).dev ? 1 : 2;
      const firstProbes = new Map<string, number>();

      const failure = yield* indexer
        .index({
          cwd: root,
          diskCapacityAvailableBytes: (_target, boundary) =>
            Effect.sync(() => {
              firstProbes.set(boundary.operation, (firstProbes.get(boundary.operation) ?? 0) + 1);
              return boundary.operation === 'promote ready code graph snapshot' ? 0 : Number.MAX_SAFE_INTEGER;
            }),
          incrementalOverlay: false,
          threadnoteHome: home,
        })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(CodeGraphDiskCapacityPressureError);
      expect(firstProbes.get('promote ready code graph snapshot')).toBe(probesPerObservation * 2);

      const databasePath = codeGraphDatabasePath(home, baseline);
      const pausedDatabase = new Database(databasePath, {readonly: true});
      const pausedRows = pausedDatabase
        .query<{readonly id: string}, [string, string]>(
          "SELECT id FROM snapshots WHERE worktree_id = ? AND state = 'ready' AND id <> ? ORDER BY id",
        )
        .all(baseline.identity.worktreeId, baseline.snapshot.id);
      expect(pausedRows).toHaveLength(1);
      const pausedId = pausedRows[0].id;
      expect(
        pausedDatabase
          .query<{readonly snapshot_id: string}, [string]>(
            'SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?',
          )
          .get(baseline.identity.worktreeId),
      ).toEqual({snapshot_id: baseline.snapshot.id});
      pausedDatabase.close();

      const resumedProbes = new Map<string, number>();
      const resumed = yield* indexer.index({
        cwd: root,
        diskCapacityAvailableBytes: (_target, boundary) =>
          Effect.sync(() => {
            resumedProbes.set(boundary.operation, (resumedProbes.get(boundary.operation) ?? 0) + 1);
            return Number.MAX_SAFE_INTEGER;
          }),
        incrementalOverlay: false,
        threadnoteHome: home,
      });

      expect(resumed.snapshot).toMatchObject({id: pausedId, state: 'ready'});
      expect(Object.fromEntries(resumedProbes)).toEqual({
        'promote ready code graph snapshot': probesPerObservation,
      });
      const resumedDatabase = new Database(databasePath, {readonly: true});
      try {
        expect(
          resumedDatabase
            .query<{readonly snapshot_id: string}, [string]>(
              'SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?',
            )
            .get(baseline.identity.worktreeId),
        ).toEqual({snapshot_id: pausedId});
      } finally {
        resumedDatabase.close();
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains a resumable receipt prefix when fresh capacity observation is unavailable', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(130);
      const home = join(root, '.threadnote-test-home');
      const indexer = yield* CodeGraphIndexer;
      const baseline = yield* indexer.index({cwd: root, threadnoteHome: home});
      updateManySourceRepository(root, 130, 'unknownCapacity');

      const probes = new Map<string, number>();
      const probesPerObservation = statSync(root).dev === statSync(tmpdir()).dev ? 1 : 2;
      const failure = yield* indexer
        .index({
          cwd: root,
          diskCapacityAvailableBytes: (_target, boundary) =>
            Effect.sync(() => {
              const count = (probes.get(boundary.operation) ?? 0) + 1;
              probes.set(boundary.operation, count);
              return boundary.operation !== 'stage persistent code graph facts' || count <= probesPerObservation
                ? Number.MAX_SAFE_INTEGER
                : undefined;
            }),
          incrementalOverlay: false,
          persistentMaterializationTransactionBatchLimit: 1,
          threadnoteHome: home,
        })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(CodeGraphDiskCapacityObservationError);
      expect(failure).toMatchObject({
        code: 'transient-io',
        operation: 'observe code graph storage capacity',
        recovery: 'retry-read-only',
        retryable: true,
      });
      // The parser cache coalesces the 128-row/2-row inventory callbacks into
      // one protected 130-row write before staging.
      // The two deterministic source batches each protect both their v4 shard
      // write and owner-verified association write. The second fact boundary
      // fails closed after one observation; unlike positive pressure it does
      // not perform cleanup or a fresh re-observation.
      expect(Object.fromEntries(probes)).toEqual({
        'cache code graph file facts': probesPerObservation,
        'cache materialized code graph file shards': probesPerObservation * 4,
        'stage persistent code graph facts': probesPerObservation * 2,
        'stage persistent code graph inventory': probesPerObservation,
        'stage persistent code graph workspace': probesPerObservation,
      });

      const databasePath = codeGraphDatabasePath(home, baseline);
      const pausedDatabase = new Database(databasePath, {readonly: true});
      try {
        const paused = pausedDatabase
          .query<{readonly failure_summary: string | null; readonly id: string}, [string]>(
            "SELECT id, failure_summary FROM snapshots WHERE worktree_id = ? AND state = 'building' LIMIT 1",
          )
          .get(baseline.identity.worktreeId);
        expect(paused).toBeDefined();
        expect(paused!.failure_summary).toBeNull();
        expect(
          pausedDatabase
            .query<{readonly snapshot_id: string}, [string]>(
              'SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?',
            )
            .get(baseline.identity.worktreeId),
        ).toEqual({snapshot_id: baseline.snapshot.id});
        expect(
          pausedDatabase
            .query<{readonly batch_index: number}, [string]>(
              'SELECT batch_index FROM building_materialization_batches WHERE snapshot_id = ? ORDER BY batch_index',
            )
            .all(paused!.id),
        ).toEqual([]);
        const pausedSpoolDatabase = new Database(codeGraphMaterializationSpoolPath(home, baseline, paused!.id), {
          readonly: true,
        });
        try {
          expect(
            pausedSpoolDatabase
              .query<{readonly batch_index: number}, []>(
                'SELECT batch_index FROM materialization_spool_batches ORDER BY batch_index',
              )
              .all(),
          ).toEqual([{batch_index: 0}]);
        } finally {
          pausedSpoolDatabase.close();
        }
        expect(
          pausedDatabase
            .query<{readonly count: number}, [string]>(
              'SELECT COUNT(*) AS count FROM snapshot_build_owners WHERE snapshot_id = ?',
            )
            .get(paused!.id)?.count,
        ).toBe(1);
      } finally {
        pausedDatabase.close();
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('marks a generic write-time no-space failure instead of preserving it as a preflight pause', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(3);
      const home = join(root, '.threadnote-test-home');
      const identity = yield* resolveRepositoryIdentity(root);
      const markedFailed: Array<{
        readonly ownerToken: string | undefined;
        readonly snapshotId: string;
        readonly summary: string;
      }> = [];
      const store = yield* CodeGraphStore;
      const failingStore = CodeGraphStore.of({
        ...store,
        cacheMaterializedFileShardBatches: () =>
          Effect.fail(
            CodeGraphStoreNoSpaceError.of('Classified SQLite full during materialized-shard write.', {
              operation: 'cache code graph materialized shards',
            }),
          ),
        markFailed: (databasePath, snapshotId, summary, ownerToken) =>
          Effect.sync(() => {
            markedFailed.push({ownerToken, snapshotId, summary});
          }).pipe(Effect.andThen(store.markFailed(databasePath, snapshotId, summary, ownerToken))),
      });
      const indexerLayer = Layer.fresh(CodeGraphIndexer.layer).pipe(
        Layer.provide(Layer.succeed(CodeGraphStore, failingStore)),
      );
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(indexerLayer);
          const indexer = Context.get(context, CodeGraphIndexer);
          return yield* indexer
            .index({
              cwd: root,
              diskCapacityAvailableBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
              incrementalOverlay: false,
              threadnoteHome: home,
            })
            .pipe(Effect.flip);
        }),
      );

      expect(failure).toBeInstanceOf(CodeGraphStoreNoSpaceError);
      expect(failure).not.toBeInstanceOf(CodeGraphDiskCapacityPressureError);
      expect(markedFailed).toHaveLength(1);
      expect(markedFailed[0]).toMatchObject({
        ownerToken: expect.any(String),
        summary: 'Classified SQLite full during materialized-shard write.',
      });

      const database = new Database(codeGraphDatabasePath(home, {identity}), {readonly: true});
      try {
        expect(
          database
            .query<{readonly count: number}, [string]>(
              "SELECT COUNT(*) AS count FROM snapshots WHERE worktree_id = ? AND state = 'building'",
            )
            .get(identity.worktreeId)?.count,
        ).toBe(0);
        expect(
          database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_build_owners').get()
            ?.count,
        ).toBe(0);
      } finally {
        database.close();
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('releases an interrupted persistent owner while preserving its resumable snapshot', () =>
    Effect.gen(function* () {
      const root = createManySourceRepository(3);
      const home = join(root, '.threadnote-test-home');
      const identity = yield* resolveRepositoryIdentity(root);
      const buildStarted = yield* Deferred.make<void>();
      const releaseBuild = yield* Deferred.make<void>();
      const releasedBuilds: Array<{
        readonly ownerToken: string | undefined;
        readonly snapshotId: string;
        readonly summary: string;
      }> = [];
      const store = yield* CodeGraphStore;
      const interruptedStore = CodeGraphStore.of({
        ...store,
        cacheMaterializedFileShardBatches: (...args) =>
          Deferred.succeed(buildStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseBuild)),
            Effect.andThen(store.cacheMaterializedFileShardBatches(...args)),
          ),
        releasePersistentBuild: (databasePath, snapshotId, summary, ownerToken) =>
          Effect.sync(() => {
            releasedBuilds.push({ownerToken, snapshotId, summary});
          }).pipe(Effect.andThen(store.releasePersistentBuild(databasePath, snapshotId, summary, ownerToken))),
      });
      const indexerLayer = Layer.fresh(CodeGraphIndexer.layer).pipe(
        Layer.provide(Layer.succeed(CodeGraphStore, interruptedStore)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(indexerLayer);
          const indexer = Context.get(context, CodeGraphIndexer);
          const building = yield* indexer
            .index({
              cwd: root,
              diskCapacityAvailableBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
              incrementalOverlay: false,
              threadnoteHome: home,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(buildStarted);

          const databasePath = codeGraphDatabasePath(home, {identity});
          const beforeInterruption = new Database(databasePath, {readonly: true});
          try {
            expect(
              beforeInterruption
                .query<{readonly count: number}, []>("SELECT COUNT(*) AS count FROM snapshots WHERE state = 'building'")
                .get()?.count,
            ).toBe(1);
            expect(
              beforeInterruption
                .query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_build_owners')
                .get()?.count,
            ).toBe(1);
          } finally {
            beforeInterruption.close();
          }

          yield* Fiber.interrupt(building);
        }),
      );

      expect(releasedBuilds).toEqual([
        {
          ownerToken: expect.any(String),
          snapshotId: expect.any(String),
          summary: 'Code graph build was interrupted before completion.',
        },
      ]);
      expect(
        (yield* readAllCodeGraphBuildStatuses(home)).find(status => status.identity.worktreeId === identity.worktreeId),
      ).toMatchObject({
        error: {summary: 'Code graph build was interrupted before completion.'},
        state: 'failed',
      });
      const database = new Database(codeGraphDatabasePath(home, {identity}), {readonly: true});
      try {
        expect(
          database
            .query<{readonly count: number}, []>("SELECT COUNT(*) AS count FROM snapshots WHERE state = 'building'")
            .get()?.count,
        ).toBe(1);
        expect(
          database
            .query<{readonly state: string; readonly failure_summary: string}, []>(
              'SELECT state, failure_summary FROM snapshots ORDER BY started_at DESC LIMIT 1',
            )
            .get(),
        ).toEqual({
          failure_summary: 'Code graph build was interrupted before completion.',
          state: 'building',
        });
        expect(
          database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_build_owners').get()
            ?.count,
        ).toBe(0);
      } finally {
        database.close();
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('indexes linked worktrees concurrently across processes without mixing dirty overlays or waiters', async () => {
    const root = createConcurrentProjectRepository();
    const home = join(root, '.threadnote-test-home');
    const baseline = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    git(root, ['branch', 'graph-process-a']);
    git(root, ['branch', 'graph-process-b']);
    const worktreeRoot = temporaryDirectory('threadnote-code-graph-process-worktrees-');
    const worktreeA = join(worktreeRoot, 'worktree-a');
    const worktreeB = join(worktreeRoot, 'worktree-b');
    git(root, ['worktree', 'add', worktreeA, 'graph-process-a']);
    git(root, ['worktree', 'add', worktreeB, 'graph-process-b']);
    writeFileSync(
      join(worktreeA, 'packages/shared/branch-a.ts'),
      'export function ensureConcurrentBranchA(): string { return "a"; }\n',
    );
    writeFileSync(
      join(worktreeB, 'packages/shared/branch-b.ts'),
      'export function ensureConcurrentBranchB(): string { return "b"; }\n',
    );
    const gateA = join(root, '.release-worktree-a');
    const gateB = join(root, '.release-worktree-b');
    const markerA = join(root, '.worktree-process-a');
    const markerB = join(root, '.worktree-process-b');
    let writerLock: string | undefined;
    const first = startCodeGraphIndexProcess(worktreeA, home, gateA, markerA);
    let second: ReturnType<typeof startCodeGraphIndexProcess> | undefined;
    try {
      await waitForPath(`${markerA}.scanning`);
      second = startCodeGraphIndexProcess(worktreeB, home, gateB, markerB);
      await waitForPath(`${markerB}.scanning`);
      const observed = await runEffect(Effect.map(readAllCodeGraphBuildStatuses(home), selectCodeGraphBuildStatuses));
      const owners = observed.builds.filter(build => build.coordination?.role === 'owner');
      expect(observed.waiters).toEqual([]);
      expect(owners).toHaveLength(2);
      expect(new Set(owners.map(build => build.identity.worktreeId)).size).toBe(2);
      const checkoutId = owners[0]?.identity.checkoutId;
      if (!checkoutId) throw TestError.make({message: 'Linked-worktree builders did not publish a checkout identity.'});
      expect(await runEffect(compactCodeGraphStorage(home, checkoutId, {dryRun: false, force: true}))).toMatchObject({
        action: 'deferred',
        reason: 'active-build',
      });

      writerLock = join(home, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`);
      mkdirSync(join(writerLock, '..'), {recursive: true});
      writeFileSync(writerLock, `${process.pid}:held-beyond-sqlite-busy-timeout\n`, {mode: 0o600});
      writeFileSync(gateA, 'release\n');
      writeFileSync(gateB, 'release\n');
      await Promise.all([waitForPath(`${markerA}.waiting`), waitForPath(`${markerB}.waiting`)]);
      await new Promise(resolve => setTimeout(resolve, 5_250));
      rmSync(writerLock, {force: true});
      const [firstOutput, secondOutput] = await Promise.all([first.done, second.done]);
      const summaryA = codeGraphProcessSummary(firstOutput);
      const summaryB = codeGraphProcessSummary(secondOutput);
      expect(summaryA.identity.checkoutId).toBe(summaryB.identity.checkoutId);
      expect(summaryA.identity.worktreeId).not.toBe(summaryB.identity.worktreeId);
      expect(summaryA.snapshot.id).not.toBe(summaryB.snapshot.id);
      expect(summaryA.materialization).toMatchObject({mode: 'incremental-overlay'});
      expect(summaryB.materialization).toMatchObject({mode: 'incremental-overlay'});
      expect(summaryA.snapshot.baseSnapshotId).toBe(baseline.snapshot.id);
      expect(summaryB.snapshot.baseSnapshotId).toBe(baseline.snapshot.id);

      const [queryA, queryB] = await runEffect(
        Effect.gen(function* () {
          const query = yield* CodeGraphQueryService;
          return yield* Effect.all(
            [
              query.inspect({
                cwd: worktreeA,
                operation: 'query',
                query: 'ensureConcurrentBranchA',
                refresh: false,
                threadnoteHome: home,
              }),
              query.inspect({
                cwd: worktreeB,
                operation: 'query',
                query: 'ensureConcurrentBranchB',
                refresh: false,
                threadnoteHome: home,
              }),
            ],
            {concurrency: 2},
          );
        }),
      );
      expect(queryA.nodes.some(node => node.name === 'ensureConcurrentBranchA')).toBe(true);
      expect(queryA.nodes.some(node => node.name === 'ensureConcurrentBranchB')).toBe(false);
      expect(queryB.nodes.some(node => node.name === 'ensureConcurrentBranchB')).toBe(true);
      expect(queryB.nodes.some(node => node.name === 'ensureConcurrentBranchA')).toBe(false);

      const database = new Database(codeGraphDatabasePath(home, summaryA), {readonly: true});
      try {
        const overlays = database
          .query<{readonly base_snapshot_id: unknown; readonly worktree_id: string}, []>(
            "SELECT base_snapshot_id, worktree_id FROM snapshots WHERE dirty = 1 AND state = 'ready' ORDER BY worktree_id",
          )
          .all();
        expect(overlays).toHaveLength(2);
        expect(new Set(overlays.map(row => row.worktree_id)).size).toBe(2);
        expect(overlays.every(row => row.base_snapshot_id === baseline.snapshot.id)).toBe(true);
      } finally {
        database.close();
      }
    } finally {
      if (writerLock) rmSync(writerLock, {force: true});
      if (first.running()) first.kill();
      if (second?.running()) second.kill();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'resumes an interrupted persistent build after its linked worktree is removed',
    async () => {
      const root = createManySourceRepository(140);
      git(root, ['branch', 'graph-orphan']);
      const worktreeRoot = temporaryDirectory('threadnote-code-graph-orphan-worktree-');
      const orphanWorktree = join(worktreeRoot, 'orphan');
      git(root, ['worktree', 'add', orphanWorktree, 'graph-orphan']);
      const home = join(root, '.threadnote-test-home');
      const marker = join(root, '.orphan-persistent-build');
      const helper = join(import.meta.dirname, '../helpers/code-graph-direct-interrupt-child.ts');
      const orphanIdentity = await runEffect(resolveRepositoryIdentity(orphanWorktree));
      const child = spawn(process.execPath, [helper, orphanWorktree, home, marker, 'single'], {
        cwd: process.cwd(),
        env: {...process.env, NODE_ENV: 'test'},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => (stderr += String(chunk)));
      try {
        await waitForPath(marker, 45_000);
        const markerProgress = JSON.parse(readFileSync(marker, 'utf8')) as {
          readonly batchesCompleted: number;
          readonly batchesTotal: number;
          readonly snapshotMode?: string;
        };
        expect(markerProgress).toMatchObject({batchesCompleted: 1, snapshotMode: 'direct-persistent'});
        expect(markerProgress.batchesTotal).toBeGreaterThan(1);
        child.kill('SIGKILL');
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => resolve());
        });

        const databasePath = join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          orphanIdentity.checkoutId,
          'graph-v3.sqlite',
        );
        const interruptedDatabase = new Database(databasePath, {readonly: true});
        const interrupted = interruptedDatabase
          .query<{readonly id: string}, [string]>(
            "SELECT id FROM snapshots WHERE worktree_id = ? AND dirty = 0 AND state = 'building' LIMIT 1",
          )
          .get(orphanIdentity.worktreeId);
        expect(interrupted).toBeDefined();
        const interruptedId = interrupted!.id;
        const interruptedSpoolPath = codeGraphMaterializationSpoolPath(home, {identity: orphanIdentity}, interruptedId);
        expect(
          interruptedDatabase
            .query<{readonly count: number}, [string]>(
              'SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?',
            )
            .get(interruptedId)?.count,
        ).toBe(0);
        interruptedDatabase.close();
        const interruptedSpool = new Database(interruptedSpoolPath, {readonly: true});
        try {
          expect(
            interruptedSpool
              .query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM materialization_spool_batches')
              .get()?.count,
          ).toBeGreaterThan(0);
        } finally {
          interruptedSpool.close();
        }

        git(root, ['worktree', 'remove', '--force', orphanWorktree]);
        const survivor = await runEffect(
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            return yield* indexer.index({
              cwd: root,
              threadnoteHome: home,
            });
          }),
        );

        const reclaimedDatabase = new Database(databasePath, {readonly: true});
        try {
          expect(
            reclaimedDatabase
              .query<{readonly state: string}, [string]>('SELECT state FROM snapshots WHERE id = ?')
              .get(interruptedId),
          ).toEqual({state: 'ready'});
          expect(
            reclaimedDatabase
              .query<{readonly snapshot_id: string}, [string]>(
                'SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?',
              )
              .get(survivor.identity.worktreeId),
          ).toEqual({snapshot_id: interruptedId});
          expect(survivor.snapshot.id).toBe(interruptedId);
          expect(existsSync(interruptedSpoolPath)).toBe(false);
          for (const table of ['snapshot_build_owners', 'building_materialization_batches'] as const) {
            expect(
              reclaimedDatabase
                .query<{readonly count: number}, [string]>(
                  `SELECT COUNT(*) AS count FROM ${table} WHERE snapshot_id = ?`,
                )
                .get(interruptedId)?.count,
            ).toBe(0);
          }
          expect(
            reclaimedDatabase
              .query<{readonly count: number}, [string]>('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
              .get(interruptedId)?.count,
          ).toBe(survivor.snapshot.symbolCount);
          expect(reclaimedDatabase.query('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally {
          reclaimedDatabase.close();
        }
      } catch (error) {
        throw TestError.make({message: `Removed-worktree cleanup fixture failed: ${stderr}`, cause: error});
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (existsSync(orphanWorktree)) {
          try {
            git(root, ['worktree', 'remove', '--force', orphanWorktree]);
          } catch {
            // Temporary-root cleanup remains the final fallback for a partially registered worktree.
          }
        }
      }
    },
    90_000,
  );

  it('rejects a derived repository symlink before opening SQLite', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const outside = temporaryDirectory('threadnote-code-graph-database-outside-');
    const identity = await runEffect(resolveRepositoryIdentity(root));
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId);

    const exit = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const registered = yield* Deferred.make<void>();
        const continueRegistration = yield* Deferred.make<void>();
        const indexing = yield* Effect.forkChild(
          indexer.index({
            cwd: root,
            onProgress: progress =>
              progress.phase === 'registering'
                ? Deferred.succeed(registered, undefined).pipe(
                    Effect.andThen(Deferred.await(continueRegistration)),
                    Effect.asVoid,
                  )
                : Effect.void,
            threadnoteHome: home,
          }),
        );
        yield* Deferred.await(registered);
        rmSync(repositoryRoot, {force: true, recursive: true});
        symlinkSync(outside, repositoryRoot, 'dir');
        yield* Deferred.succeed(continueRegistration, undefined);
        return yield* Effect.exit(Fiber.join(indexing));
      }),
    );

    expect(exit._tag).toBe('Failure');
    expect(existsSync(join(outside, 'graph-v3.sqlite'))).toBe(false);
  });

  it('recovers a maintenance intent left by a crashed process', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const intent = join(home, 'locks', 'indexes', 'code-graph', 'maintenance.intent');
    mkdirSync(join(home, 'locks', 'indexes', 'code-graph'), {recursive: true});
    writeFileSync(intent, '999999999:crashed-maintenance\n');

    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        yield* purgeAllCodeGraphIndexes(home);
      }),
    );

    expect(existsSync(intent)).toBe(false);
    expect(existsSync(join(home, 'indexes', 'code-graph'))).toBe(false);
  });

  it('recovers a maintenance intent whose process id was reused', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const intent = join(home, 'locks', 'indexes', 'code-graph', 'maintenance.intent');
    mkdirSync(join(home, 'locks', 'indexes', 'code-graph'), {recursive: true});

    await runEffect(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        writeFileSync(
          intent,
          `${JSON.stringify({
            processId: system.processId,
            processStartIdentity: 'different-process-instance',
            token: 'reused-process-id',
          })}\n`,
        );
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    expect(existsSync(intent)).toBe(false);
  });

  it('refuses ambiguous path endpoints and accepts explicit path#symbol selectors', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(
        join(root, `packages/app/src/duplicate-${String(index).padStart(2, '0')}.ts`),
        `export function runApplication(): string { return 'duplicate-${index}'; }\n`,
      );
    }

    const [ambiguous, explicit] = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        const first = yield* graph.inspect({
          cwd: root,
          from: 'runApplication',
          operation: 'path',
          threadnoteHome: home,
          to: 'withExclusiveFileLock',
        });
        const second = yield* graph.inspect({
          cwd: root,
          from: 'packages/app/src/main.ts#runApplication',
          operation: 'path',
          refresh: false,
          threadnoteHome: home,
          to: 'packages/core/src/lock.ts#withExclusiveFileLock',
        });
        return [first, second] as const;
      }),
    );

    expect(ambiguous.edges).toEqual([]);
    expect(ambiguous.warnings.join('\n')).toContain('is ambiguous; use path#symbol');
    expect(explicit.edges.map(edge => `${edge.sourceName}:${edge.targetName}`)).toEqual([
      'runApplication:ensureVectorIndex',
      'ensureVectorIndex:withExclusiveFileLock',
    ]);
  });

  it('does not remove an export path created by another process before exclusive open', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const output = join(root, 'graph-export.json');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    await expect(
      runEffect(
        runCodeGraphExport(config, {
          cwd: root,
          format: 'json',
          interlock: {
            afterOutputCheck: () => Effect.sync(() => writeFileSync(output, 'other-process\n')),
          },
          output,
        }),
      ),
    ).rejects.toThrow();

    expect(readFileSync(output, 'utf8')).toBe('other-process\n');
    expect(
      readdirSync(root).filter(entry => entry.startsWith('.graph-export.json.') && entry.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('publishes exports atomically as private files without leaving a temporary sibling', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const output = join(root, 'graph-export.json');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        yield* runCodeGraphExport(config, {cwd: root, format: 'json', output});
      }),
    );

    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({type: 'threadnote-code-graph-export'});
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(
      readdirSync(root).filter(entry => entry.startsWith('.graph-export.json.') && entry.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('does not publish or unlink a temporary path replaced before atomic publication', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const output = join(root, 'graph-export.json');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    let replacement = '';
    let replacementContent = '';
    let synchronizedSize = 0;

    await expect(
      runEffect(
        runCodeGraphExport(config, {
          cwd: root,
          format: 'json',
          interlock: {
            beforePublish: temporary =>
              Effect.sync(() => {
                replacement = temporary;
                synchronizedSize = statSync(temporary).size;
                // A distinct size keeps this regression deterministic even on a filesystem that immediately reuses an inode.
                replacementContent = 'x'.repeat(synchronizedSize + 1);
                rmSync(temporary);
                writeFileSync(temporary, replacementContent, {mode: 0o600});
              }),
          },
          output,
        }),
      ),
    ).rejects.toThrow('no longer identifies');

    expect(existsSync(output)).toBe(false);
    expect(statSync(replacement).size).toBe(synchronizedSize + 1);
    expect(readFileSync(replacement, 'utf8')).toBe(replacementContent);
  });

  it('rejects a temporary path replaced between final verification and atomic publication', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const output = join(root, 'graph-link-race.json');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    let replacement = '';
    let replacementContent = '';

    await expect(
      runEffect(
        runCodeGraphExport(config, {
          cwd: root,
          format: 'json',
          interlock: {
            beforeLink: temporary =>
              Effect.sync(() => {
                replacement = temporary;
                replacementContent = 'x'.repeat(statSync(temporary).size);
                rmSync(temporary);
                writeFileSync(temporary, replacementContent, {mode: 0o600});
              }),
          },
          output,
        }),
      ),
    ).rejects.toThrow('did not link the private output file');

    expect(existsSync(output)).toBe(false);
    expect(readFileSync(replacement, 'utf8')).toBe(replacementContent);
  });

  it('removes a published symlink without touching its target when the temporary path is replaced', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const output = join(root, 'graph-link-symlink.json');
    const target = join(root, 'attacker-owned.txt');
    const targetContent = 'attacker-owned content must remain\n';
    writeFileSync(target, targetContent);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    let replacement = '';

    await expect(
      runEffect(
        runCodeGraphExport(config, {
          cwd: root,
          format: 'json',
          interlock: {
            beforeLink: temporary =>
              Effect.sync(() => {
                replacement = temporary;
                rmSync(temporary);
                symlinkSync(target, temporary);
              }),
          },
          output,
        }),
      ),
    ).rejects.toThrow('did not link the private output file');

    expect(existsSync(output)).toBe(false);
    expect(readlinkSync(replacement)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(targetContent);
  });

  it('keeps status read-only and converges disposable incomplete graph state', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const progress: string[] = [];
    const before = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        return yield* query.status(home, root);
      }),
    );
    expect(before.readySnapshot).toBeUndefined();
    expect(existsSync(before.databasePath)).toBe(false);
    expect(before.languagePacks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'typescript',
          languages: expect.arrayContaining(['javascript', 'typescript']),
          workspaceDetection: false,
        }),
        expect.objectContaining({id: 'manifests', workspaceDetection: true}),
        expect.objectContaining({assetCount: 1, id: 'java', languages: ['java']}),
        expect.objectContaining({assetCount: 1, id: 'kotlin', languages: ['kotlin']}),
        expect.objectContaining({assetCount: 1, id: 'swift', languages: ['swift']}),
      ]),
    );

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        replaceFunction(root, 'ensureVectorIndex', 'ensureDirtyVectorIndex');
        const stale = yield* query.status(home, root, {requestMaintenance: false});
        yield* store.markBuilding(before.databasePath, indexed.identity, {
          ...indexed.snapshot,
          id: `${indexed.snapshot.id}-interrupted`,
          state: 'building',
        });
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* Effect.sync(() => {
          const database = new Database(before.databasePath);
          try {
            const active = database
              .query<{readonly content_hash: string; readonly path: string}, []>(
                'SELECT content_hash, path FROM snapshot_files ORDER BY path LIMIT 1',
              )
              .get();
            if (!active)
              throw TestError.make({message: 'Ready graph did not retain a file for cache maintenance coverage.'});
            database
              .query(
                'INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                'orphaned-content',
                'orphaned-extractor',
                'orphaned.ts',
                '{"diagnostics":[],"edges":[],"path":"orphaned.ts","symbols":[]}',
                createdAt,
              );
            database
              .query(
                'INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                active.content_hash,
                'obsolete-extractor-generation',
                active.path,
                JSON.stringify({diagnostics: [], edges: [], path: active.path, symbols: []}),
                createdAt,
              );
          } finally {
            database.close();
          }
        });
        const repair = yield* repairCodeGraphIndexes(home, false, state =>
          Effect.sync(() =>
            progress.push(
              `${state.phase}:${state.current}/${state.total}${state.snapshots ? `:${state.snapshots}` : ''}`,
            ),
          ),
        );
        return {
          health: yield* store.diagnose(before.databasePath),
          indexed,
          repair,
          stale,
        };
      }),
    );

    expect(result.repair).toMatchObject({databases: 1, discarded: 0});
    // The detached collector may retire the same disposable snapshot after
    // diagnosis but before synchronous repair counts its candidates. Final
    // database health below is authoritative; either cleanup owner is valid.
    expect(result.repair.removedIncompleteSnapshots).toBeGreaterThanOrEqual(0);
    expect(result.repair.removedIncompleteSnapshots).toBeLessThanOrEqual(1);
    expect(progress).toEqual(['checking:1/1', 'cleaning-snapshots:1/1:1', 'cleaning-vectors:1/1']);
    expect(result.stale.stale).toBe(true);
    expect(result.health).toMatchObject({
      buildingSnapshots: 0,
      cachedFileBlobs: result.indexed.snapshot.fileCount,
      integrity: 'ok',
      readySnapshots: 1,
    });
  });

  it('streams progress while doctor and repair inspect graph databases', async () => {
    const root = createFixtureRepository();
    const secondRoot = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const doctorProgress: string[] = [];
    const repairProgress: string[] = [];
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        yield* indexer.index({cwd: secondRoot, threadnoteHome: home});
        const doctor = yield* codeGraphDoctorCheck(home, progress =>
          Effect.sync(() => doctorProgress.push(`${progress.phase}:${progress.current}/${progress.total}`)),
        );
        const repair = yield* repairCodeGraphIndexes(home, false, progress =>
          Effect.sync(() => repairProgress.push(`${progress.phase}:${progress.current}/${progress.total}`)),
        );
        return {doctor, repair};
      }),
    );

    expect(result.doctor).toMatchObject({status: 'ok'});
    const deferredProgress = repairProgress.filter(state => state.startsWith('deferred:'));
    expect(result.repair).toMatchObject({
      databases: 2,
      deferredDatabases: deferredProgress.length,
      discarded: 0,
    });
    expect(doctorProgress).toEqual(['checking:1/2', 'checking:2/2']);
    expect(repairProgress).toHaveLength(4);
    expect(repairProgress[0]).toBe('checking:1/2');
    expect(['cleaning-vectors:1/2', 'deferred:1/2']).toContain(repairProgress[1]);
    expect(repairProgress[2]).toBe('checking:2/2');
    expect(['cleaning-vectors:2/2', 'deferred:2/2']).toContain(repairProgress[3]);
  });

  effectIt.effect('streams progress before discarding an incompatible derived database', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const home = join(root, '.threadnote-test-home');
      const databasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        'a'.repeat(64),
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const progress: string[] = [];
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
      yield* Effect.sync(() => setGraphSchemaVersion(databasePath, '999'));
      const repair = yield* repairCodeGraphIndexes(home, false, state =>
        Effect.sync(() => progress.push(`${state.phase}:${state.current}/${state.total}`)),
      );

      expect(repair).toMatchObject({
        databases: 1,
        deferredDatabases: 0,
        discarded: 1,
      });
      expect(progress).toEqual(['checking:1/1', 'discarding:1/1']);
      expect(existsSync(databasePath)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps default lifecycle repair bounded and points deep maintenance to an explicit command', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const home = join(root, '.threadnote-test-home');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: join(home, 'seed-manifest.yaml'),
        user: 'tester',
      };
      const indexer = yield* CodeGraphIndexer;
      const query = yield* CodeGraphQueryService;
      const store = yield* CodeGraphStore;
      const first = yield* indexer.index({cwd: root, threadnoteHome: home});
      const secondDatabasePath = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        'a'.repeat(64),
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      yield* store.initialize(secondDatabasePath);
      const firstStatus = yield* query.status(home, root);
      yield* store.markBuilding(firstStatus.databasePath, first.identity, {
        ...first.snapshot,
        id: `${first.snapshot.id}-interrupted`,
        state: 'building',
      });
      yield* Effect.sync(() => setGraphSchemaVersion(secondDatabasePath, '999'));
      const doctor = yield* captureConsole(runDoctor(config, {dryRun: true}));
      const repair = yield* captureConsole(runRepair(config, {dryRun: true, mcp: 'none', postUpdate: false}));
      const output = {doctor: doctor.output, repair: repair.output};
      expect(output.doctor).toMatch(/Checking · checking \d+\/\d+ databases/);
      expect(output.doctor).not.toMatch(/Repairing · checking \d+\/\d+ databases/);
      expect(output.doctor).not.toMatch(/Checking native code graph database \d+\/2\./);
      expect(output.doctor).toContain(
        'FAIL native code graph: 2 database(s); 1 ready snapshot(s); 1 incomplete snapshot(s); ' +
          '1 database(s) need a disposable rebuild',
      );
      expect(output.repair).toMatch(/Would repair · /);
      expect(output.repair).not.toMatch(/Checking native code graph database \d+\/2\./);
      expect(output.repair).toMatch(/Would repair · deferred \d+\/2 databases/);
      expect(output.repair).toContain(
        'Would repair 2 native code graph database(s): 2 deferred, 0 disposable rebuild(s), 0 incomplete snapshot(s), ' +
          '0 temporary graph file(s).',
      );
      expect(output.repair).toContain(
        'WARN native code graph: 2 database(s); 1 ready snapshot(s); 0 incomplete snapshot(s); ' +
          '2 database maintenance check(s) deferred',
      );
      expect(output.repair.indexOf('Running Threadnote doctor checks.')).toBeGreaterThan(
        output.repair.search(/Would repair \d+ native code graph database/),
      );
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('holds the maintenance gate while the repair diagnosis is consumed', () =>
    Effect.gen(function* () {
      const root = yield* Effect.sync(createFixtureRepository);
      const home = join(root, '.threadnote-test-home');
      // Close setup maintenance children before the gate-specific repair/index race begins.
      yield* Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }).pipe(provideTestLayer(ApplicationLayer));
      const indexer = yield* CodeGraphIndexer;
      const diagnosed = yield* Deferred.make<DoctorCheck>();
      const releaseDiagnosis = yield* Deferred.make<void>();
      const registered = yield* Deferred.make<void>();
      const repairing = yield* Effect.forkChild(
        repairCodeGraphIndexes(home, false, undefined, completion =>
          Deferred.succeed(diagnosed, completion.doctorCheck).pipe(
            Effect.andThen(Deferred.await(releaseDiagnosis)),
            Effect.asVoid,
          ),
        ),
      );
      const check = yield* Deferred.await(diagnosed);
      replaceFunction(root, 'ensureVectorIndex', 'ensureAfterRepairVectorIndex');
      const indexing = yield* Effect.forkChild(
        indexer.index({
          cwd: root,
          onProgress: progress =>
            progress.phase === 'registering'
              ? Deferred.succeed(registered, undefined).pipe(Effect.asVoid)
              : Effect.void,
          threadnoteHome: home,
        }),
      );
      yield* Effect.yieldNow;
      const registeredBeforeRelease = yield* Deferred.isDone(registered);
      yield* Deferred.succeed(releaseDiagnosis, undefined);
      const repair = yield* Fiber.join(repairing);
      yield* Fiber.join(indexing);
      expect(check.status).toBe('ok');
      expect(registeredBeforeRelease).toBe(false);
      expect(yield* Deferred.isDone(registered)).toBe(true);
      expect(repair).toMatchObject({databases: 1, discarded: 0});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('does not follow vector cleanup symlinks outside the derived index root', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const outside = temporaryDirectory('threadnote-code-graph-vector-outside-');
    const victim = join(outside, 'victim.tmp');
    writeFileSync(victim, 'must survive');
    const repositoryRoot = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        return join(home, 'indexes', 'code-graph', 'repositories', indexed.identity.checkoutId);
      }),
    );
    mkdirSync(join(repositoryRoot, 'vectors'), {recursive: true});
    symlinkSync(outside, join(repositoryRoot, 'vectors', 'outside-link'), 'dir');

    await runEffect(repairCodeGraphIndexes(home, false));

    expect(readFileSync(victim, 'utf8')).toBe('must survive');
  });

  it('indexes eligible files in a repository before its first commit', async () => {
    const root = temporaryDirectory('threadnote-code-graph-unborn-');
    git(root, ['init', '-q']);
    writeFileSync(join(root, 'unborn.ts'), 'export function unbornSymbol(): string { return "ready"; }\n');
    git(root, ['add', 'unborn.ts']);

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* graph.inspect({
          cwd: root,
          operation: 'query',
          query: 'unbornSymbol',
          threadnoteHome: join(root, '.threadnote-test-home'),
        });
      }),
    );

    expect(result.snapshot.commit).toMatch(/^0{40}$/);
    expect(result.nodes.some(node => node.name === 'unbornSymbol')).toBe(true);
  });
});

function createFixtureRepository(): string {
  const root = temporaryDirectory('threadnote-code-graph-');
  cpSync(FIXTURE_REPOSITORY, root, {recursive: true});
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  return root;
}

function createConcurrentProjectRepository(): string {
  const root = temporaryDirectory('threadnote-code-graph-concurrent-project-');
  mkdirSync(join(root, 'packages/shared'), {recursive: true});
  writeFileSync(join(root, '.gitignore'), '/.threadnote-*/\n');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({name: '@concurrent/root', private: true, workspaces: ['packages/*']}, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'packages/shared/package.json'),
    `${JSON.stringify({name: '@concurrent/shared'}, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'packages/shared/index.ts'),
    'export function ensureConcurrentBase(): string { return "base"; }\n',
  );
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  return root;
}

function createManySourceRepository(count: number): string {
  const root = temporaryDirectory('threadnote-code-graph-many-');
  mkdirSync(join(root, 'src'), {recursive: true});
  git(root, ['init', '-q']);
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(root, `src/file-${String(index).padStart(3, '0')}.ts`),
      `export function original${index}(): number { return ${index}; }\n`,
    );
  }
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  return root;
}

function createAmbientOverloadBarrelRepository(fillerCount = 0): string {
  const root = temporaryDirectory('threadnote-code-graph-ambient-overload-barrel-');
  mkdirSync(join(root, 'src'), {recursive: true});
  git(root, ['init', '-q']);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({name: 'ambient-overload-barrel', type: 'module'})}\n`);
  writeFileSync(
    join(root, 'src/leaf.ts'),
    'export declare function target(value: string): string;\n' +
      'export declare function target(value: string, suffix: string): string;\n',
  );
  writeFileSync(join(root, 'src/barrel.ts'), 'export {target} from "./leaf";\n');
  writeFileSync(
    join(root, 'src/caller.ts'),
    'import {target} from "./barrel";\nexport const result = target("x", "y");\n',
  );
  for (let index = 0; index < fillerCount; index += 1) {
    writeFileSync(
      join(root, `src/filler-${String(index).padStart(3, '0')}.ts`),
      `export function filler${index}(): number { return ${index}; }\n`,
    );
  }
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  return root;
}

function updateManySourceRepository(root: string, count: number, prefix: string): void {
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(root, `src/file-${String(index).padStart(3, '0')}.ts`),
      `export function ${prefix}${index}(): number { return ${index + 1}; }\n`,
    );
  }
}

function createRationaleAmplifiedRepository(): string {
  const root = temporaryDirectory('threadnote-code-graph-rationale-amplified-');
  mkdirSync(join(root, 'src'), {recursive: true});
  git(root, ['init', '-q']);
  writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'rationale-amplification', type: 'module'}));
  for (let fileIndex = 0; fileIndex < 2; fileIndex += 1) {
    const rationale = Array.from(
      {length: 3_000},
      (_, index) => `  // WHY: rationale-${fileIndex}-${index}-${'漢'.repeat(160)}`,
    ).join('\n');
    writeFileSync(
      join(root, `src/rationale-${fileIndex}.ts`),
      `export function owner${fileIndex}(): number {\n${rationale}\n  return ${fileIndex};\n}\n`,
    );
  }
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'rationale amplification fixture',
  ]);
  return root;
}

function createBodyModifiedRepository(count = 4): string {
  const root = createManySourceRepository(count);
  if (count > 1) {
    writeFileSync(
      join(root, 'src/file-001.ts'),
      'import {original0} from "./file-000.js";\nexport function original1(): number { return original0(); }\n',
    );
    git(root, ['add', 'src/file-001.ts']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'cross-file relation',
    ]);
  }
  const file = join(root, 'src/file-000.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('return 0;', 'return 1000;'));
  return root;
}

function createPublishedSurfaceRepository(): string {
  const root = temporaryDirectory('threadnote-code-graph-published-surface-');
  mkdirSync(join(root, 'src'), {recursive: true});
  mkdirSync(join(root, 'test'), {recursive: true});
  writeFileSync(
    join(root, 'src/service.ts'),
    ['export class PublishedService {', '  value(): number {', '    return 1;', '  }', '}', ''].join('\n'),
  );
  writeFileSync(
    join(root, 'test/service.test.ts'),
    [
      'import {PublishedService} from "../src/service.js";',
      '',
      "it('reads the published service', () => {",
      '  return new PublishedService().value();',
      '});',
      '',
    ].join('\n'),
  );
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  return root;
}

function createBodyModifiedRepositoryWithCommittedDiagnostic(): string {
  const root = createManySourceRepository(4);
  writeFileSync(join(root, 'src/broken.ts'), 'export function broken(): number {\n');
  git(root, ['add', 'src/broken.ts']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'broken committed source',
  ]);
  const modified = join(root, 'src/file-000.ts');
  writeFileSync(modified, readFileSync(modified, 'utf8').replace('return 0;', 'return 1000;'));
  return root;
}

function createRenamedDeclarationRepository(): string {
  const root = createManySourceRepository(4);
  const file = join(root, 'src/file-000.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('original0', 'renamed0'));
  return root;
}

function createChangedSignatureRepository(): string {
  const root = createManySourceRepository(4);
  writeFileSync(join(root, 'src/file-000.ts'), 'export function original0(value: number): number { return value; }\n');
  return root;
}

function createChangedExportRepository(): string {
  const root = createManySourceRepository(4);
  const file = join(root, 'src/file-000.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('export function', 'function'));
  return root;
}

function createChangedResolutionContextRepository(): string {
  const root = createManySourceRepository(4);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {strict: false}}));
  git(root, ['add', 'tsconfig.json']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'resolution context',
  ]);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {strict: true}}));
  return root;
}

function createSpanOnlyReexportRepository(): string {
  const root = temporaryDirectory('threadnote-code-graph-span-only-reexport-');
  mkdirSync(join(root, 'src'), {recursive: true});
  git(root, ['init', '-q']);
  writeFileSync(join(root, 'src/source.ts'), 'export function value(): number { return 1; }\n');
  writeFileSync(join(root, 'src/index.ts'), '// committed\nexport {value} from "./source.js";\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  writeFileSync(
    join(root, 'src/index.ts'),
    '// dirty comment moves the re-export evidence span\n// without changing its resolver surface\nexport {value} from "./source.js";\n',
  );
  return root;
}

function createAddedFileRepository(): string {
  const root = createManySourceRepository(4);
  writeFileSync(join(root, 'src/added.ts'), 'export function added(): number { return 5; }\n');
  return root;
}

function createDeletedFileRepository(): string {
  const root = createManySourceRepository(4);
  rmSync(join(root, 'src/file-000.ts'));
  return root;
}

function createNoMaterializedChangesRepository(): string {
  const root = createManySourceRepository(4);
  const excluded = join(root, 'tracked.unsupported-fixture');
  writeFileSync(excluded, 'committed\n');
  git(root, ['add', 'tracked.unsupported-fixture']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'tracked unsupported fixture',
  ]);
  writeFileSync(excluded, 'dirty\n');
  return root;
}

function createFactBudgetExpandedRepository(): string {
  const root = temporaryDirectory('threadnote-code-graph-expanded-facts-');
  const sourceRoot = join(root, 'src');
  mkdirSync(sourceRoot, {recursive: true});
  git(root, ['init', '-q']);
  const identifierPadding = 'x'.repeat(192);
  for (let fileIndex = 0; fileIndex < 6; fileIndex += 1) {
    const declarations = Array.from(
      {length: 2_000},
      (_, symbolIndex) =>
        `export function expanded_${fileIndex}_${symbolIndex}_${identifierPadding}(): number { return ${symbolIndex}; }`,
    );
    writeFileSync(join(sourceRoot, `expanded-${fileIndex}.ts`), `// base-state\n${declarations.join('\n')}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  for (let fileIndex = 0; fileIndex < 6; fileIndex += 1) {
    const sourcePath = join(sourceRoot, `expanded-${fileIndex}.ts`);
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace('// base-state', '// work-state'));
  }
  return root;
}

function codeGraphDatabasePath(home: string, indexed: {readonly identity: {readonly checkoutId: string}}): string {
  return join(home, 'indexes', 'code-graph', 'repositories', indexed.identity.checkoutId, 'graph-v3.sqlite');
}

function codeGraphMaterializationSpoolPath(
  home: string,
  indexed: {readonly identity: {readonly checkoutId: string}},
  snapshotId: string,
): string {
  return join(
    home,
    'indexes',
    'code-graph',
    'repositories',
    indexed.identity.checkoutId,
    `materialization-spool-v2-${snapshotId}.sqlite`,
  );
}

function materializedShardFacts(databasePath: string, path: string) {
  const database = new Database(databasePath, {readonly: true});
  try {
    const row = database
      .query<{readonly factsJson: string}, [string]>(
        'SELECT facts_json AS factsJson FROM materialized_file_shards WHERE path_hint = ?',
      )
      .get(path);
    if (!row) throw TestError.make({message: `Expected a materialized shard for ${path}.`});
    return decodeStoredCodeGraphFact(row.factsJson, path).facts;
  } finally {
    database.close();
  }
}

function snapshotLeaseCount(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true});
  try {
    const row = database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_leases').get();
    return Number(row?.count ?? 0);
  } finally {
    database.close();
  }
}

function activeSnapshotId(databasePath: string, worktreeId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true});
  try {
    return database
      .query<{readonly snapshot_id: string}, [string]>('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?')
      .get(worktreeId)?.snapshot_id;
  } finally {
    database.close();
  }
}

function normalizeStoredGraph(graph: StoredCodeGraph): Pick<StoredCodeGraph, 'edges' | 'symbols'> {
  return {
    edges: [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)),
    symbols: [...graph.symbols].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function invalidateCachedFactFallback(databasePath: string, snapshotId: string, path: string): void {
  const database = new Database(databasePath);
  try {
    expect(
      database
        .query('UPDATE file_blobs SET facts_json = ? WHERE path_hint = ?')
        .run(JSON.stringify({diagnostics: [], edges: [null], path, symbols: []}), path).changes,
    ).toBeGreaterThan(0);
    expect(
      database.query('DELETE FROM snapshot_file_shards WHERE snapshot_id = ? AND path = ?').run(snapshotId, path)
        .changes,
    ).toBe(1);
  } finally {
    database.close();
  }
}

function finalFullMaterializationMetrics(progress: readonly CodeGraphProgress[]): CodeGraphMaterializationMetrics {
  const metrics = progress
    .filter(
      (current): current is Extract<CodeGraphProgress, {readonly phase: 'materializing'}> =>
        current.phase === 'materializing',
    )
    .flatMap(current => (current.metrics?.mode === 'full' ? [current.metrics] : []))
    .at(-1);
  if (metrics === undefined) throw TestError.make({message: 'Expected terminal full-materialization metrics.'});
  return metrics;
}

function createLargeInventoryRepository(count: number, bytes = 1_048_576): string {
  const root = temporaryDirectory('threadnote-code-graph-large-inventory-');
  git(root, ['init', '-q']);
  const prefix = '# large inventory fixture\n';
  const content = `${prefix}${' '.repeat(bytes - Buffer.byteLength(prefix))}`;
  const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], {
    encoding: 'utf8',
    input: content,
  }).trim();
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const relative = `docs/file-${String(index).padStart(3, '0')}.md`;
    paths.push(relative);
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${relative}`]);
  }
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  for (const relative of paths) git(root, ['update-index', '--skip-worktree', relative]);
  return root;
}

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

interface CodeGraphIndexProcessResult {
  readonly done: Promise<string>;
  readonly kill: () => void;
  readonly running: () => boolean;
}

function startCodeGraphIndexProcess(
  repository: string,
  home: string,
  releaseGate: string,
  marker: string,
): CodeGraphIndexProcessResult {
  const helper = join(import.meta.dirname, '../helpers/code-graph-index-process.ts');
  const child = spawn(process.execPath, [helper, repository, home, releaseGate, marker], {
    cwd: process.cwd(),
    env: {...process.env, NODE_ENV: 'test'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => (stdout += String(chunk)));
  child.stderr?.on('data', chunk => (stderr += String(chunk)));
  const done = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(TestError.make({message: `Code graph child exited ${code ?? signal}: ${stderr || stdout}`}));
    });
  });
  return {
    done,
    kill: () => child.kill(),
    running: () => child.exitCode === null && child.signalCode === null,
  };
}

async function waitForPath(path: string, timeoutMilliseconds = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw TestError.make({message: `Timed out waiting for child process marker: ${path}`});
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function codeGraphProcessProgress(
  output: string,
): readonly {readonly completed?: number; readonly phase: string; readonly total?: number}[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      line =>
        JSON.parse(line) as {
          readonly progress?: {readonly completed?: number; readonly phase: string; readonly total?: number};
        },
    )
    .flatMap(message => (message.progress ? [message.progress] : []));
}

function codeGraphProcessSummary(output: string): {
  readonly identity: {readonly checkoutId: string; readonly worktreeId: string};
  readonly materialization?: {readonly mode: string; readonly stagedFiles: number};
  readonly snapshot: {readonly baseSnapshotId?: string; readonly id: string};
} {
  const summary = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as {readonly summary?: unknown; readonly type?: string})
    .find(message => message.type === 'summary')?.summary;
  if (!summary || typeof summary !== 'object')
    throw TestError.make({message: `Child process did not emit a summary: ${output}`});
  return summary as {
    readonly identity: {readonly checkoutId: string; readonly worktreeId: string};
    readonly materialization?: {readonly mode: string; readonly stagedFiles: number};
    readonly snapshot: {readonly baseSnapshotId?: string; readonly id: string};
  };
}

async function graphHealthAfterIndex(cwd: string, threadnoteHome: string) {
  return runEffect(
    Effect.gen(function* () {
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const indexed = yield* indexer.index({cwd, threadnoteHome});
      return yield* store.diagnose(codeGraphDatabasePath(threadnoteHome, indexed));
    }),
  );
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

function replaceFunction(root: string, from: string, to: string): void {
  const path = join(root, 'packages/search/src/vector-index.ts');
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll(from, to));
}

function snapshotFileHash(databasePath: string, snapshotId: string, sourcePath: string): string {
  const database = new Database(databasePath, {readonly: true});
  try {
    const row = database
      .query<{readonly content_hash: string}, [string, string]>(
        'SELECT content_hash FROM snapshot_files WHERE snapshot_id = ? AND path = ?',
      )
      .get(snapshotId, sourcePath);
    if (!row) throw TestError.make({message: `Snapshot ${snapshotId} has no row for ${sourcePath}.`});
    return row.content_hash;
  } finally {
    database.close();
  }
}

function effectiveSnapshotFileHash(databasePath: string, snapshotId: string, sourcePath: string): string {
  const database = new Database(databasePath, {readonly: true});
  try {
    let current: string | undefined = snapshotId;
    while (current !== undefined) {
      const deleted = database
        .query<{readonly present: number}, [string, string]>(
          'SELECT 1 AS present FROM snapshot_file_deletions WHERE snapshot_id = ? AND path = ? LIMIT 1',
        )
        .get(current, sourcePath);
      if (deleted) break;
      const row = database
        .query<{readonly content_hash: string}, [string, string]>(
          'SELECT content_hash FROM snapshot_files WHERE snapshot_id = ? AND path = ?',
        )
        .get(current, sourcePath);
      if (row) return row.content_hash;
      const baseSnapshotId: unknown = database
        .query<{readonly base_snapshot_id: unknown}, [string]>(
          'SELECT base_snapshot_id FROM snapshots WHERE id = ? LIMIT 1',
        )
        .get(current)?.base_snapshot_id;
      current = typeof baseSnapshotId === 'string' ? baseSnapshotId : undefined;
    }
    throw TestError.make({message: `Snapshot ${snapshotId} has no effective row for ${sourcePath}.`});
  } finally {
    database.close();
  }
}

function setGraphSchemaVersion(databasePath: string, version: string): void {
  const database = new Database(databasePath);
  try {
    database.query("UPDATE schema_metadata SET value = ? WHERE key = 'schema_version'").run(version);
  } finally {
    database.close();
  }
}
